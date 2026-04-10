import * as tmi from 'tmi.js';
import { AIService, PersonaConfig } from './ai';

interface BotConfig { username: string; token: string; }

interface BotInstance {
  client: tmi.Client;
  username: string;
  token: string;
  connected: boolean;
  timer: NodeJS.Timeout | null;
  connectTimer: NodeJS.Timeout | null;
  messages: number;
  index: number;
  lastMsgTime: number;
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
  private readerClient: tmi.Client | null = null;

  constructor(
    configs: BotConfig[],
    channel: string,
    groqKey: string,
    opts: {
      interval: number;
      language: string;
      context: string;
      settings: Record<string, boolean>;
      savedPersonas?: Record<string, PersonaConfig>;
    },
    emit: EmitFn
  ) {
    this.channel = channel.toLowerCase().replace(/^#/, '');
    this.intervalMs = opts.interval * 1000;
    this.context = opts.context;
    this.language = opts.language;
    this.emit = emit;
    this.ai = new AIService(groqKey, opts.settings, opts.savedPersonas);

    console.log('[manager] interval=' + opts.interval + 's  bots=' + configs.length);
    configs.forEach((cfg, idx) => this.initBot(cfg, idx));
    this.initReader();
  }

  // ── Change interval live ──────────────────────────────────────────────────
  setInterval(seconds: number): void {
    this.intervalMs = Math.max(10, seconds) * 1000;
    console.log('[manager] interval changed to', seconds + 's');
    // Reschedule all running bots
    for (const bot of this.bots.values()) {
      if (bot.timer) { clearTimeout(bot.timer); bot.timer = null; }
      if (bot.connected) {
        const jitter = Math.random() * 3000;
        bot.timer = setTimeout(() => this.scheduleBot(bot), jitter);
      }
    }
  }

  private initReader(): void {
    if (this.stopped) return;
    this.readerClient = new tmi.Client({
      options: { debug: false, skipMembership: true },
      channels: ['#' + this.channel],
      connection: { reconnect: true, secure: true },
    });

    this.readerClient.on('message', (
      _ch: string, tags: tmi.CommonUserstate, message: string, _self: boolean
    ) => {
      const senderLower = (tags.username || '').toLowerCase();
      const isBotAccount = this.bots.has(senderLower);

      this.emit('chat:message', {
        username: tags.username || '',
        displayName: tags['display-name'] || tags.username || '',
        message,
        color: tags.color || null,
        isBot: isBotAccount,
        id: tags.id || String(Date.now()),
      });

      // Always feed real messages to AI (for mimicry)
      if (!isBotAccount) {
        this.ai.addRealMessage(tags['display-name'] || tags.username || 'viewer', message);
      }

      // React ONLY if @tagged
      if (!isBotAccount) {
        for (const [botKey, bot] of this.bots) {
          if (!bot.connected) continue;
          const mentioned =
            message.toLowerCase().includes('@' + botKey) ||
            message.toLowerCase().includes('@' + bot.username.toLowerCase());
          if (mentioned) {
            const delay = 1500 + Math.random() * 2500;
            setTimeout(() => {
              if (!this.stopped) this.sendTagReply(bot, message);
            }, delay);
          }
        }
      }
    });

    this.readerClient.connect().catch((e: Error) =>
      console.error('[reader]', e.message)
    );
  }

  private async sendTagReply(bot: BotInstance, original: string): Promise<void> {
    if (!bot.connected || this.stopped) return;
    if (Date.now() - bot.lastMsgTime < 3000) return;
    try {
      const msg = await this.ai.generateMessage(bot.username, this.context, this.language, bot.index, original);
      if (!msg) return;
      await bot.client.say('#' + this.channel, msg);
      bot.messages++;
      bot.lastMsgTime = Date.now();
      this.emit('bot:message', { username: bot.username, message: msg, count: bot.messages });
      const log = this.ai.transcriptLog;
      if (log.length) this.emit('transcript:entry', log[log.length - 1]);
    } catch (e: any) {
      console.error('[bot] tag reply', bot.username, e.message);
    }
  }

  private initBot(cfg: BotConfig, idx: number): void {
    const token = cfg.token.replace(/^oauth:/i, '');
    const client = new tmi.Client({
      options: { debug: false, skipMembership: true },
      identity: { username: cfg.username, password: 'oauth:' + token },
      channels: ['#' + this.channel],
      connection: { reconnect: true, maxReconnectAttempts: 20, reconnectInterval: 3000, secure: true },
    });

    const bot: BotInstance = {
      client, username: cfg.username, token,
      connected: false, timer: null, connectTimer: null,
      messages: 0, index: idx, lastMsgTime: 0,
    };
    this.bots.set(cfg.username.toLowerCase(), bot);

    client.on('connected', () => {
      if (this.stopped) { client.disconnect().catch(() => {}); return; }
      bot.connected = true;
      this.emit('bot:status', { username: cfg.username, state: 'connected', message: 'Подключён' });
    });
    client.on('disconnected', (reason: string) => {
      bot.connected = false;
      if (!this.stopped)
        this.emit('bot:status', { username: cfg.username, state: 'reconnecting', message: reason });
    });
    client.on('reconnect', () => {
      if (!this.stopped)
        this.emit('bot:status', { username: cfg.username, state: 'connecting', message: 'Переподключение...' });
    });
    client.on('notice', (_ch: string, msgid: string, message: string) => {
      console.warn('[notice]', cfg.username, msgid, message);
      this.emit('bot:error', { username: cfg.username, code: msgid, message });
    });

    this.emit('bot:status', { username: cfg.username, state: 'connecting', message: 'Подключение...' });
    bot.connectTimer = setTimeout(() => {
      if (!this.stopped)
        client.connect().catch((e: Error) => {
          this.emit('bot:status', { username: cfg.username, state: 'error', message: e.message });
        });
    }, idx * 1500);
  }

  start(): void {
    this.stopped = false;
    const bots = Array.from(this.bots.values());
    // Stagger first messages: bot0=8s, bot1=8+8-18s, etc.
    let offset = 8000;
    bots.forEach(bot => {
      const t = setTimeout(() => {
        if (!this.stopped) this.scheduleBot(bot);
      }, offset);
      bot.timer = t;
      offset += 8000 + Math.floor(Math.random() * 10000);
    });
    console.log('[manager] bots scheduled, first message in 8s');
  }

  private scheduleBot(bot: BotInstance): void {
    if (this.stopped) return;
    this.sendAiMsg(bot).finally(() => {
      if (!this.stopped) {
        const jitter = (Math.random() * 0.2 - 0.1) * this.intervalMs;
        bot.timer = setTimeout(() => this.scheduleBot(bot), this.intervalMs + jitter);
      }
    });
  }

  private async sendAiMsg(bot: BotInstance): Promise<void> {
    if (!bot.connected || this.stopped) return;
    if (Date.now() - bot.lastMsgTime < 5000) return;
    try {
      const msg = await this.ai.generateMessage(bot.username, this.context, this.language, bot.index);
      if (!msg || msg.length < 2 || this.stopped) return;
      console.log('[bot]', bot.username, '→', '"' + msg + '"');
      await bot.client.say('#' + this.channel, msg);
      bot.messages++;
      bot.lastMsgTime = Date.now();
      this.emit('bot:message', { username: bot.username, message: msg, count: bot.messages });
      const log = this.ai.transcriptLog;
      if (log.length) this.emit('transcript:entry', log[log.length - 1]);
    } catch (e: any) {
      const m = String(e?.message || e);
      if (!m.includes('Not connected') && !m.includes('No response'))
        this.emit('bot:error', { username: bot.username, code: 'say_error', message: m });
    }
  }

  async sendManual(usernames: string[], message: string): Promise<void> {
    for (const u of usernames) {
      if (this.stopped) return;
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

  // ── Persona ────────────────────────────────────────────────────────────────
  setPersona(username: string, cfg: PersonaConfig): void {
    this.ai.setPersona(username, cfg);
  }
  getPersonas(): Record<string, PersonaConfig> { return this.ai.getPersonas(); }

  // ── Viewer sim ─────────────────────────────────────────────────────────────
  async startViewerSim(channel: string): Promise<void> {
    const bots = Array.from(this.bots.values());
    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i];
      setTimeout(() => {
        if (!this.stopped) this.hlsPoll(bot, channel);
      }, i * 5000);
    }
  }

  private async hlsPoll(bot: BotInstance, channel: string): Promise<void> {
    if (this.stopped) return;
    const { default: axios } = await import('axios');
    const poll = async () => {
      if (this.stopped) return;
      try {
        const gql = await axios.post('https://gql.twitch.tv/gql', [{
          operationName: 'PlaybackAccessToken_Template',
          query: `query PlaybackAccessToken_Template($login:String!,$isLive:Boolean!,$vodID:ID!,$isVod:Boolean!,$playerType:String!){streamPlaybackAccessToken(channelName:$login,params:{platform:"web",playerBackend:"mediaplayer",playerType:$playerType})@include(if:$isLive){value signature}}`,
          variables: { login: channel, isLive: true, isVod: false, vodID: '', playerType: 'embed' },
        }], { headers: { 'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' }, timeout: 10000 });
        const token = gql.data?.[0]?.data?.streamPlaybackAccessToken;
        if (!token?.value) return;
        const sig = token.signature, tok = encodeURIComponent(token.value), p = Math.floor(Math.random() * 999999);
        const m3u8 = `https://usher.twitchapps.com/api/channel/hls/${channel}.m3u8?sig=${sig}&token=${tok}&allow_source=true&fast_bread=true&p=${p}`;
        const h = { 'User-Agent': 'Mozilla/5.0 Chrome/122', 'Origin': 'https://www.twitch.tv', 'Referer': 'https://www.twitch.tv/' };
        const r = await axios.get(m3u8, { headers: h, timeout: 10000 });
        const url = r.data.split('\n').find((l: string) => l.startsWith('http'));
        if (url) { await axios.get(url.trim(), { headers: h, timeout: 10000 }); this.emit('viewer:active', { username: bot.username }); }
      } catch { /* offline or error — silent */ }
    };
    await poll();
    if (!this.stopped) {
      const t = setInterval(() => { if (this.stopped) { clearInterval(t); return; } poll(); }, 20000);
    }
  }

  async stop(): Promise<void> {
    console.log('[manager] stopping...');
    this.stopped = true;
    for (const bot of this.bots.values()) {
      if (bot.timer) { clearTimeout(bot.timer); bot.timer = null; }
      if (bot.connectTimer) { clearTimeout(bot.connectTimer); bot.connectTimer = null; }
      bot.connected = false;
    }
    if (this.readerClient) { this.readerClient.disconnect().catch(() => {}); this.readerClient = null; }
    await Promise.allSettled(Array.from(this.bots.values()).map(b => b.client.disconnect().catch(() => {})));
    this.bots.clear();
    console.log('[manager] stopped');
  }

  getUsernames(): string[] { return Array.from(this.bots.values()).map(b => b.username); }
  getTranscriptLog() { return this.ai.transcriptLog; }
}
