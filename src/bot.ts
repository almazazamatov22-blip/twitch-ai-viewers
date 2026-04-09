import * as tmi from 'tmi.js';
import axios from 'axios';
import { AIService } from './ai';

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

  // Viewer simulation
  private viewerTimers: (NodeJS.Timeout | ReturnType<typeof setInterval>)[] = [];

  constructor(
    configs: BotConfig[],
    channel: string,
    groqKey: string,
    opts: { interval: number; language: string; context: string; settings: Record<string, boolean> },
    emit: EmitFn
  ) {
    this.channel = channel.toLowerCase().replace(/^#/, '');
    // Hard cap: minimum 10s, maximum 300s (5 min)
    this.intervalMs = Math.min(300, Math.max(10, opts.interval)) * 1000;
    this.context = opts.context;
    this.language = opts.language;
    this.emit = emit;
    this.ai = new AIService(groqKey, opts.settings);

    console.log('[manager] interval=' + (this.intervalMs / 1000) + 's for', configs.length, 'bots');

    configs.forEach((cfg, idx) => this.initBot(cfg, idx));
    this.initReader();
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

      // Always add to AI context (bots read chat for awareness)
      this.ai.addChatContext((tags['display-name'] || tags.username || 'user') + ': ' + message);

      // ONLY react if a bot was @tagged — no random reactive triggers
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
      console.error('[reader] connect error:', e.message)
    );
  }

  private async sendTagReply(bot: BotInstance, original: string): Promise<void> {
    if (!bot.connected || this.stopped) return;
    const now = Date.now();
    if (now - bot.lastMsgTime < 3000) return;
    try {
      const msg = await this.ai.generateMessage(
        bot.username, this.context, this.language, bot.index, original
      );
      if (!msg) return;
      await bot.client.say('#' + this.channel, msg);
      bot.messages++;
      bot.lastMsgTime = Date.now();
      this.emit('bot:message', { username: bot.username, message: msg, count: bot.messages });
      const log = this.ai.transcriptLog;
      if (log.length) this.emit('transcript:entry', log[log.length - 1]);
    } catch (e: any) {
      console.error('[bot] tag reply error', bot.username, e.message);
    }
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

    // Stagger connections 1.5s apart
    bot.connectTimer = setTimeout(() => {
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

    // Each bot writes every intervalMs seconds
    // Stagger their first message: bot0 after 8s, bot1 after 8+random(5-15)s, etc.
    // So if interval=60s and 4 bots, each bot writes every 60s but they're offset ~15s apart
    let cumulativeOffset = 8000;
    bots.forEach((bot) => {
      const offset = cumulativeOffset;
      cumulativeOffset += 5000 + Math.floor(Math.random() * 10000); // 5-15s between bots

      const t = setTimeout(() => {
        if (!this.stopped) this.scheduleBot(bot);
      }, offset);
      bot.timer = t;

      console.log('[manager] bot', bot.username, 'first message in', Math.round(offset / 1000) + 's');
    });
  }

  private scheduleBot(bot: BotInstance): void {
    if (this.stopped) return;

    this.sendAiMsg(bot).finally(() => {
      if (!this.stopped) {
        // Next message in exactly intervalMs ± 10% jitter
        const jitter = (Math.random() * 0.2 - 0.1) * this.intervalMs;
        const delay = this.intervalMs + jitter;
        bot.timer = setTimeout(() => this.scheduleBot(bot), delay);
      }
    });
  }

  private async sendAiMsg(bot: BotInstance): Promise<void> {
    if (!bot.connected || this.stopped) return;

    // Enforce minimum 5s between messages from same bot
    const now = Date.now();
    if (now - bot.lastMsgTime < 5000) return;

    try {
      const msg = await this.ai.generateMessage(
        bot.username, this.context, this.language, bot.index
      );
      if (!msg || msg.length < 2) return;
      if (this.stopped) return;

      console.log('[bot]', bot.username, '→', '"' + msg + '"');
      await bot.client.say('#' + this.channel, msg);
      bot.messages++;
      bot.lastMsgTime = Date.now();
      this.emit('bot:message', { username: bot.username, message: msg, count: bot.messages });

      const log = this.ai.transcriptLog;
      if (log.length) this.emit('transcript:entry', log[log.length - 1]);
    } catch (e: any) {
      const m = String(e?.message || e);
      console.error('[bot] say error', bot.username, m);
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

  // Set/update persona for a bot at runtime
  setPersona(username: string, role: string, sys: string): void {
    this.ai.setPersona(username, role, sys);
  }

  getPersonas(): Record<string, { role: string; sys: string }> {
    return this.ai.getPersonas();
  }

  // Viewer simulation via HLS polling
  async startViewerSimulation(channel: string): Promise<void> {
    // Only try if stream is live — avoid spam when offline
    const bots = Array.from(this.bots.values());
    console.log('[viewers] starting HLS simulation for', bots.length, 'bots');

    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i];
      const delay = i * 5000;
      const t = setTimeout(() => {
        if (!this.stopped) this.pollHls(bot, channel);
      }, delay);
      this.viewerTimers.push(t);
    }
  }

  private async pollHls(bot: BotInstance, channel: string): Promise<void> {
    if (this.stopped) return;

    const fetchPlaylist = async () => {
      if (this.stopped) return;
      try {
        // Try public GQL endpoint (no auth needed for public streams)
        const gql = await axios.post('https://gql.twitch.tv/gql', [{
          operationName: 'PlaybackAccessToken_Template',
          query: `query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {
  streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {
    value
    signature
  }
}`,
          variables: { login: channel, isLive: true, isVod: false, vodID: '', playerType: 'embed' },
        }], {
          headers: {
            'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko', // public web client id
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        });

        const token = gql.data?.[0]?.data?.streamPlaybackAccessToken;
        if (!token?.value) return;

        const sig = token.signature;
        const tok = encodeURIComponent(token.value);
        const p = Math.floor(Math.random() * 999999);
        const m3u8 = `https://usher.twitchapps.com/api/channel/hls/${channel}.m3u8?sig=${sig}&token=${tok}&allow_source=true&fast_bread=true&p=${p}&player_backend=mediaplayer&playlist_include_framerate=true`;

        const headers = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36',
          'Origin': 'https://www.twitch.tv',
          'Referer': 'https://www.twitch.tv/',
        };

        const masterRes = await axios.get(m3u8, { headers, timeout: 10000 });
        const lines: string[] = masterRes.data.split('\n');
        const playlistUrl = lines.find((l: string) => l.startsWith('http'));
        if (playlistUrl) {
          await axios.get(playlistUrl.trim(), { headers, timeout: 10000 });
          console.log('[viewers]', bot.username, 'watching ✓');
          this.emit('viewer:active', { username: bot.username });
        }
      } catch {
        // Silent - don't spam logs when stream is offline
      }
    };

    await fetchPlaylist();
    if (!this.stopped) {
      const t = setInterval(() => {
        if (this.stopped) { clearInterval(t); return; }
        fetchPlaylist();
      }, 20000);
      this.viewerTimers.push(t);
    }
  }

  stopViewerSimulation(): void {
    this.viewerTimers.forEach(t => { clearInterval(t as any); clearTimeout(t as any); });
    this.viewerTimers = [];
  }

  async stop(): Promise<void> {
    console.log('[manager] stopping...');
    this.stopped = true;

    // Clear all bot timers
    for (const bot of this.bots.values()) {
      if (bot.timer) { clearTimeout(bot.timer); bot.timer = null; }
      if (bot.connectTimer) { clearTimeout(bot.connectTimer); bot.connectTimer = null; }
      bot.connected = false;
    }

    this.stopViewerSimulation();

    if (this.readerClient) {
      this.readerClient.disconnect().catch(() => {});
      this.readerClient = null;
    }

    await Promise.allSettled(
      Array.from(this.bots.values()).map(b => b.client.disconnect().catch(() => {}))
    );
    this.bots.clear();
    console.log('[manager] stopped');
  }

  getUsernames(): string[] {
    return Array.from(this.bots.values()).map(b => b.username);
  }

  getTranscriptLog() {
    return this.ai.transcriptLog;
  }
}
