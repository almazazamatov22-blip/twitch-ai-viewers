import * as tmi from 'tmi.js';
import axios from 'axios';
import { AIService } from './ai';

interface BotConfig { username: string; token: string; }

interface BotInstance {
  client: tmi.Client;
  username: string;
  token: string;
  connected: boolean;
  timer?: NodeJS.Timeout;
  messages: number;
  index: number;
  lastMsgTime: number;
}

type EmitFn = (event: string, data: unknown) => void;

export class BotManager {
  private bots = new Map<string, BotInstance>();
  private ai: AIService;
  private channel: string;
  private intervalMs: number;   // per-bot interval
  private context: string;
  private language: string;
  private emit: EmitFn;
  private stopped = false;
  private readerClient: tmi.Client | null = null;
  private chatActivityCount = 0; // track chat bursts

  constructor(
    configs: BotConfig[],
    channel: string,
    groqKey: string,
    opts: { interval: number; language: string; context: string; settings: Record<string, boolean> },
    emit: EmitFn
  ) {
    this.channel = channel.toLowerCase().replace(/^#/, '');
    // interval is per-bot — divide total to spread across bots
    // If user sets 10s, each bot writes roughly every 10s
    this.intervalMs = Math.max(8, opts.interval) * 1000;
    this.context = opts.context;
    this.language = opts.language;
    this.emit = emit;
    this.ai = new AIService(groqKey, opts.settings);

    configs.forEach((cfg, idx) => this.initBot(cfg, idx));
    this.initReader();
  }

  private initReader(): void {
    this.readerClient = new tmi.Client({
      options: { debug: false, skipMembership: true },
      channels: ['#' + this.channel],
      connection: { reconnect: true, secure: true },
    });

    this.readerClient.on('message', (
      _ch: string, tags: tmi.CommonUserstate, message: string, _self: boolean
    ) => {
      const username = (tags.username || '').toLowerCase();
      const isBotAccount = this.bots.has(username);

      this.emit('chat:message', {
        username: tags.username || '',
        displayName: tags['display-name'] || tags.username || '',
        message,
        color: tags.color || null,
        isBot: isBotAccount,
        id: tags.id || String(Date.now()),
      });

      // Feed real user messages to AI context
      if (!isBotAccount) {
        this.ai.addChatContext((tags['display-name'] || tags.username || 'user') + ': ' + message);
        this.chatActivityCount++;
        // If real chat is active, optionally trigger a reactive response from a random bot
        if (this.chatActivityCount % 3 === 0) {
          this.triggerReactiveMessage();
        }
      }
    });

    this.readerClient.connect().catch((e: Error) =>
      console.error('[reader] connect error:', e.message)
    );
  }

  // Randomly pick a connected bot to react to recent chat
  private triggerReactiveMessage(): void {
    if (this.stopped) return;
    const connectedBots = Array.from(this.bots.values()).filter(b => b.connected);
    if (!connectedBots.length) return;
    // Don't react too quickly after last message
    const now = Date.now();
    const eligible = connectedBots.filter(b => now - b.lastMsgTime > 5000);
    if (!eligible.length) return;
    const bot = eligible[Math.floor(Math.random() * eligible.length)];
    // Fire a reactive message (not counted against timer)
    setTimeout(() => this.sendAiMsg(bot, true), 1000 + Math.random() * 2000);
  }

  private initBot(cfg: BotConfig, idx: number): void {
    const token = cfg.token.replace(/^oauth:/i, '');
    const oauthToken = 'oauth:' + token;

    const client = new tmi.Client({
      options: { debug: false, skipMembership: true },
      identity: { username: cfg.username, password: oauthToken },
      channels: ['#' + this.channel],
      connection: { reconnect: true, maxReconnectAttempts: 20, reconnectInterval: 3000, secure: true },
    });

    const bot: BotInstance = {
      client, username: cfg.username, token,
      connected: false, messages: 0, index: idx, lastMsgTime: 0,
    };
    this.bots.set(cfg.username.toLowerCase(), bot);

    client.on('connected', () => {
      bot.connected = true;
      this.emit('bot:status', { username: cfg.username, state: 'connected', message: 'Подключён' });
    });
    client.on('disconnected', (reason: string) => {
      bot.connected = false;
      if (!this.stopped)
        this.emit('bot:status', { username: cfg.username, state: 'reconnecting', message: reason || 'disconnected' });
    });
    client.on('reconnect', () =>
      this.emit('bot:status', { username: cfg.username, state: 'connecting', message: 'Переподключение...' })
    );
    client.on('notice', (_ch: string, msgid: string, message: string) => {
      console.warn('[notice]', cfg.username, msgid, message);
      this.emit('bot:error', { username: cfg.username, code: msgid, message });
    });

    this.emit('bot:status', { username: cfg.username, state: 'connecting', message: 'Подключение...' });

    setTimeout(() => {
      if (!this.stopped)
        client.connect().catch((e: Error) => {
          console.error('[bot] connect error', cfg.username, e.message);
          this.emit('bot:status', { username: cfg.username, state: 'error', message: e.message });
        });
    }, idx * 1500);
  }

  start(): void {
    this.stopped = false;
    const bots = Array.from(this.bots.values());
    bots.forEach((bot, idx) => {
      // Stagger starts evenly across the interval so they don't all fire at once
      const offset = 5000 + Math.floor((this.intervalMs / Math.max(bots.length, 1)) * idx);
      bot.timer = setTimeout(() => this.scheduleBot(bot), offset);
    });
  }

  private scheduleBot(bot: BotInstance): void {
    if (this.stopped) return;
    this.sendAiMsg(bot, false).finally(() => {
      if (!this.stopped) {
        // Add ±20% jitter so bots don't sync up
        const jitter = (Math.random() * 0.4 - 0.2) * this.intervalMs;
        const delay = Math.max(8000, this.intervalMs + jitter);
        bot.timer = setTimeout(() => this.scheduleBot(bot), delay);
      }
    });
  }

  private async sendAiMsg(bot: BotInstance, isReactive: boolean): Promise<void> {
    if (!bot.connected || this.stopped) return;

    // Prevent spam: min 5s between any two messages from same bot
    const now = Date.now();
    if (now - bot.lastMsgTime < 5000) return;

    try {
      const msg = await this.ai.generateMessage(
        bot.username, this.context, this.language, bot.index, isReactive
      );
      if (!msg || msg.length < 2) return;

      console.log('[bot]', bot.username, isReactive ? '(reactive)' : '(proactive)', '→', msg);
      await bot.client.say('#' + this.channel, msg);

      bot.messages++;
      bot.lastMsgTime = Date.now();
      this.emit('bot:message', { username: bot.username, message: msg, count: bot.messages });
    } catch (e: any) {
      const m = String(e?.message || e);
      console.error('[bot] say error', bot.username, m);
      if (!m.includes('Not connected') && !m.includes('No response'))
        this.emit('bot:error', { username: bot.username, code: 'say_error', message: m });
    }
  }

  async sendManual(usernames: string[], message: string): Promise<void> {
    for (const u of usernames) {
      const bot = this.bots.get(u.toLowerCase()) || this.bots.get(u);
      if (!bot?.connected) continue;
      try {
        await bot.client.say('#' + this.channel, message);
        bot.messages++;
        bot.lastMsgTime = Date.now();
        this.emit('bot:message', { username: bot.username, message, count: bot.messages });
      } catch (e: any) {
        this.emit('bot:error', { username: bot.username, code: 'say_error', message: e.message });
      }
    }
  }

  // Follow: Twitch removed the API in 2023.
  // The only working method is to open the channel page in a headless browser — not feasible here.
  async followChannel(_channelId: string): Promise<{ username: string; ok: boolean; error?: string }[]> {
    return Array.from(this.bots.values()).map(b => ({
      username: b.username,
      ok: false,
      error: 'Twitch удалил API подписки в 2023. Боты должны подписаться вручную на сайте.',
    }));
  }

  // Get all connected bot tokens for external use (e.g. viewer simulation)
  getBotTokens(): { username: string; token: string }[] {
    return Array.from(this.bots.values()).map(b => ({ username: b.username, token: b.token }));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.bots.forEach(bot => { if (bot.timer) clearTimeout(bot.timer); });
    if (this.readerClient) this.readerClient.disconnect().catch(() => {});
    await Promise.allSettled(Array.from(this.bots.values()).map(b => b.client.disconnect().catch(() => {})));
    this.bots.clear();
  }

  getUsernames(): string[] {
    return Array.from(this.bots.values()).map(b => b.username);
  }
}
