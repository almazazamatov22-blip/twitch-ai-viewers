import * as tmi from 'tmi.js';
import { AIService } from './ai';

interface BotConfig { username: string; token: string; }

interface BotInstance {
  client: tmi.Client;
  username: string;
  connected: boolean;
  timer?: NodeJS.Timeout;
  messages: number;
  index: number;
}

type EmitFn = (event: string, data: unknown) => void;

export class BotManager {
  private bots = new Map<string, BotInstance>();
  private ai: AIService;
  private channel: string;
  private intervalMs: number;
  private context: string;
  private language: string;
  private emit: EmitFn;
  private stopped = false;
  // Shared reader client — reads ALL real chat messages
  private readerClient: tmi.Client | null = null;

  constructor(
    configs: BotConfig[],
    channel: string,
    groqKey: string,
    opts: { interval: number; language: string; context: string; settings: Record<string, boolean> },
    emit: EmitFn
  ) {
    this.channel = channel.toLowerCase().replace(/^#/, '');
    this.intervalMs = Math.max(15, opts.interval) * 1000;
    this.context = opts.context;
    this.language = opts.language;
    this.emit = emit;
    this.ai = new AIService(groqKey, opts.settings);

    configs.forEach((cfg, idx) => this.initBot(cfg, idx));
    this.initReader();
  }

  // Anonymous reader to get ALL real Twitch chat messages
  private initReader(): void {
    this.readerClient = new tmi.Client({
      options: { debug: false, skipMembership: true },
      channels: ['#' + this.channel],
      connection: { reconnect: true, secure: true },
    });

    this.readerClient.on('message', (
      _ch: string,
      tags: tmi.CommonUserstate,
      message: string,
      _self: boolean
    ) => {
      const username = tags.username || tags['display-name'] || 'user';
      const isBotAccount = this.bots.has(username);

      // Send ALL messages (including bot messages) to frontend for real chat display
      this.emit('chat:message', {
        username,
        message,
        color: tags.color || null,
        isBot: isBotAccount,
        id: tags.id || Date.now().toString(),
        displayName: tags['display-name'] || username,
      });

      // Feed only real user messages to AI context (not our bots)
      if (!isBotAccount) {
        this.ai.addChatContext(username + ': ' + message);
      }
    });

    this.readerClient.connect().catch(e => {
      console.error('[reader] connect error:', e.message);
    });
  }

  private initBot(cfg: BotConfig, idx: number): void {
    const token = cfg.token.startsWith('oauth:') ? cfg.token : 'oauth:' + cfg.token;

    const client = new tmi.Client({
      options: { debug: false, skipMembership: true },
      identity: { username: cfg.username, password: token },
      channels: ['#' + this.channel],
      connection: { reconnect: true, maxReconnectAttempts: 20, reconnectInterval: 3000, secure: true },
    });

    const bot: BotInstance = { client, username: cfg.username, connected: false, messages: 0, index: idx };
    this.bots.set(cfg.username, bot);

    client.on('connected', () => {
      bot.connected = true;
      this.emit('bot:status', { username: cfg.username, state: 'connected', message: 'Подключён к #' + this.channel });
    });
    client.on('disconnected', (reason: string) => {
      bot.connected = false;
      if (!this.stopped)
        this.emit('bot:status', { username: cfg.username, state: 'reconnecting', message: reason || 'disconnected' });
    });
    client.on('reconnect', () => {
      this.emit('bot:status', { username: cfg.username, state: 'connecting', message: 'Переподключение...' });
    });
    client.on('notice', (_ch: string, msgid: string, message: string) => {
      console.warn('[notice] ' + cfg.username + ': ' + msgid + ' — ' + message);
      this.emit('bot:error', { username: cfg.username, code: msgid, message });
    });

    this.emit('bot:status', { username: cfg.username, state: 'connecting', message: 'Подключение...' });

    setTimeout(() => {
      if (!this.stopped)
        client.connect().catch((e: Error) => {
          console.error('[bot] connect error', cfg.username, e.message);
          this.emit('bot:status', { username: cfg.username, state: 'error', message: e.message });
        });
    }, idx * 2000);
  }

  start(): void {
    this.stopped = false;
    const bots = Array.from(this.bots.values());
    bots.forEach((bot, idx) => {
      // Space first messages: wait for connections + stagger
      const offset = 10000 + Math.floor((this.intervalMs / bots.length) * idx);
      bot.timer = setTimeout(() => this.scheduleBot(bot), offset);
    });
  }

  private scheduleBot(bot: BotInstance): void {
    if (this.stopped) return;
    this.sendAiMsg(bot).finally(() => {
      if (!this.stopped) {
        const jitter = (Math.random() * 0.6 - 0.3) * this.intervalMs;
        const delay = Math.max(15000, this.intervalMs + jitter);
        bot.timer = setTimeout(() => this.scheduleBot(bot), delay);
      }
    });
  }

  private async sendAiMsg(bot: BotInstance): Promise<void> {
    if (!bot.connected || this.stopped) return;
    try {
      const msg = await this.ai.generateMessage(bot.username, this.context, this.language, bot.index);
      if (!msg || msg.length < 2) return;
      console.log('[bot] ' + bot.username + ' → "' + msg + '"');
      await bot.client.say('#' + this.channel, msg);
      bot.messages++;
      this.emit('bot:message', { username: bot.username, message: msg, count: bot.messages });
    } catch (e: any) {
      const m = e?.message || String(e);
      console.error('[bot] say error', bot.username, m);
      if (!m.includes('Not connected') && !m.includes('No response'))
        this.emit('bot:error', { username: bot.username, code: 'say_error', message: m });
    }
  }

  async sendManual(usernames: string[], message: string): Promise<void> {
    for (const u of usernames) {
      const bot = this.bots.get(u);
      if (!bot?.connected) continue;
      try {
        await bot.client.say('#' + this.channel, message);
        bot.messages++;
        this.emit('bot:message', { username: u, message, count: bot.messages });
      } catch (e: any) {
        console.error('[bot] manual error', u, e.message);
        this.emit('bot:error', { username: u, code: 'say_error', message: e.message });
      }
    }
  }

  async followChannel(channelId: string, clientId: string): Promise<{ username: string; ok: boolean; error?: string }[]> {
    const results: { username: string; ok: boolean; error?: string }[] = [];
    const axios = (await import('axios')).default;

    for (const [username, bot] of this.bots) {
      const rawToken = ((bot.client as any).opts?.identity?.password as string) || '';
      const token = rawToken.replace(/^oauth:/, '');
      try {
        const meRes = await axios.get('https://api.twitch.tv/helix/users', {
          headers: { Authorization: 'Bearer ' + token, 'Client-ID': clientId },
        });
        const userId = meRes.data.data?.[0]?.id;
        if (!userId) throw new Error('Cannot get user id for ' + username);

        await axios.post(
          'https://api.twitch.tv/helix/channels/follow',
          { broadcaster_id: channelId, user_id: userId },
          { headers: { Authorization: 'Bearer ' + token, 'Client-ID': clientId, 'Content-Type': 'application/json' } }
        );
        results.push({ username, ok: true });
      } catch (e: any) {
        const err = e.response?.data?.message || e.message;
        console.warn('[follow]', username, err);
        results.push({ username, ok: false, error: err });
      }
    }
    return results;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.bots.forEach(bot => { if (bot.timer) clearTimeout(bot.timer); });
    if (this.readerClient) this.readerClient.disconnect().catch(() => {});
    await Promise.allSettled(Array.from(this.bots.values()).map(b => b.client.disconnect().catch(() => {})));
    this.bots.clear();
  }

  getUsernames(): string[] { return Array.from(this.bots.keys()); }
}
