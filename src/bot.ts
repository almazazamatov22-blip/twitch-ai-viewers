import * as tmi from 'tmi.js';
import { AIService } from './ai';

interface BotConfig {
  username: string;
  token: string;
}

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
  }

  private initBot(cfg: BotConfig, idx: number): void {
    const token = cfg.token.startsWith('oauth:') ? cfg.token : 'oauth:' + cfg.token;

    const client = new tmi.Client({
      options: { debug: true, skipMembership: true },
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

    // Catch Twitch IRC notices — ban, slow mode, sub-only, etc.
    client.on('notice', (_ch: string, msgid: string, message: string) => {
      console.warn('[bot] NOTICE ' + cfg.username + ': ' + msgid + ' — ' + message);
      this.emit('bot:error', { username: cfg.username, code: msgid, message });
    });

    // Read chat for AI context (messages from real users, not our bots)
    client.on('message', (_ch: string, tags: tmi.CommonUserstate, message: string, self: boolean) => {
      if (!self) {
        const isBotMsg = this.bots.has(tags.username || '');
        if (!isBotMsg) {
          this.ai.addChatContext((tags.username || 'user') + ': ' + message);
        }
      }
    });

    this.emit('bot:status', { username: cfg.username, state: 'connecting', message: 'Подключение...' });

    // Stagger connections: 2s apart to avoid Twitch rate limit
    setTimeout(() => {
      if (this.stopped) return;
      client.connect().catch((e: Error) => {
        console.error('[bot] connect error ' + cfg.username + ':', e.message);
        this.emit('bot:status', { username: cfg.username, state: 'error', message: e.message });
      });
    }, idx * 2000);
  }

  start(): void {
    this.stopped = false;
    const bots = Array.from(this.bots.values());

    // Space out first messages evenly across the interval
    bots.forEach((bot, idx) => {
      // Offset each bot by interval/count so they never fire at the same time
      const offset = 8000 + Math.floor((this.intervalMs / bots.length) * idx);
      bot.timer = setTimeout(() => this.scheduleBot(bot), offset);
    });
  }

  private scheduleBot(bot: BotInstance): void {
    if (this.stopped) return;
    this.sendMsg(bot).finally(() => {
      if (!this.stopped) {
        // Random jitter ±30% so bots don't synchronize over time
        const jitter = (Math.random() * 0.6 - 0.3) * this.intervalMs;
        const delay = Math.max(12000, this.intervalMs + jitter);
        bot.timer = setTimeout(() => this.scheduleBot(bot), delay);
      }
    });
  }

  private async sendMsg(bot: BotInstance): Promise<void> {
    if (!bot.connected || this.stopped) return;
    try {
      const msg = await this.ai.generateMessage(bot.username, this.context, this.language, bot.index);
      if (!msg || msg.length < 2) return;

      console.log('[bot] ' + bot.username + ' → "' + msg + '"');
      await bot.client.say('#' + this.channel, msg);

      bot.messages++;
      this.emit('bot:message', { username: bot.username, message: msg, count: bot.messages });
    } catch (e: any) {
      const msg = e?.message || String(e);
      console.error('[bot] say error ' + bot.username + ':', msg);
      if (!msg.includes('Not connected') && !msg.includes('No response')) {
        this.emit('bot:error', { username: bot.username, code: 'say_error', message: msg });
      }
    }
  }

  async sendManual(usernames: string[], message: string): Promise<void> {
    for (const u of usernames) {
      const bot = this.bots.get(u);
      if (!bot?.connected) {
        this.emit('bot:error', { username: u, code: 'not_connected', message: 'Бот не подключён' });
        continue;
      }
      try {
        await bot.client.say('#' + this.channel, message);
        bot.messages++;
        this.emit('bot:message', { username: u, message, count: bot.messages });
      } catch (e: any) {
        console.error('[bot] manual say error ' + u + ':', e.message);
        this.emit('bot:error', { username: u, code: 'say_error', message: e.message });
      }
    }
  }

  // Make all bot accounts follow the channel using their user token
  async followChannel(channelId: string, clientId: string): Promise<{ username: string; ok: boolean; error?: string }[]> {
    const results: { username: string; ok: boolean; error?: string }[] = [];
    const axios = (await import('axios')).default;

    for (const [username, bot] of this.bots) {
      const rawToken = (bot.client as any).opts?.identity?.password as string || '';
      const token = rawToken.replace('oauth:', '');
      try {
        // Get bot user id
        const meRes = await axios.get('https://api.twitch.tv/helix/users', {
          headers: { Authorization: 'Bearer ' + token, 'Client-ID': clientId },
        });
        const userId = meRes.data.data?.[0]?.id;
        if (!userId) throw new Error('Cannot get user id');

        // POST follow (Helix endpoint — requires channel:manage:follows on bot side)
        // Newer endpoint: POST /helix/channels/follow — not available for bots without special scope
        // We'll try the legacy endpoint
        await axios.post(
          'https://api.twitch.tv/helix/users/follows',
          { from_id: userId, to_id: channelId },
          { headers: { Authorization: 'Bearer ' + token, 'Client-ID': clientId, 'Content-Type': 'application/json' } }
        );
        results.push({ username, ok: true });
      } catch (e: any) {
        const errMsg = e.response?.data?.message || e.message;
        console.warn('[follow] ' + username + ': ' + errMsg);
        results.push({ username, ok: false, error: errMsg });
      }
    }
    return results;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.bots.forEach(bot => { if (bot.timer) clearTimeout(bot.timer); });
    await Promise.allSettled(Array.from(this.bots.values()).map(b => b.client.disconnect().catch(() => {})));
    this.bots.clear();
  }

  getUsernames(): string[] {
    return Array.from(this.bots.keys());
  }

  getManager(): BotManager { return this; }
}
