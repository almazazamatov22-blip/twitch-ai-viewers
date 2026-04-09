import * as tmi from 'tmi.js';
import axios from 'axios';
import { AIService } from './ai';

interface BotConfig { username: string; token: string; }

interface BotInstance {
  client: tmi.Client;
  username: string;
  token: string;
  connected: boolean;
  timers: NodeJS.Timeout[];   // track ALL timers for this bot
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
  private chatActivityCount = 0;

  // Viewer simulation — HLS stream watchers
  private viewerIntervals: NodeJS.Timeout[] = [];
  private hlsUrl: string | null = null;

  constructor(
    configs: BotConfig[],
    channel: string,
    groqKey: string,
    opts: { interval: number; language: string; context: string; settings: Record<string, boolean> },
    emit: EmitFn
  ) {
    this.channel = channel.toLowerCase().replace(/^#/, '');
    this.intervalMs = Math.max(8, opts.interval) * 1000;
    this.context = opts.context;
    this.language = opts.language;
    this.emit = emit;
    this.ai = new AIService(groqKey, opts.settings);

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

      if (!isBotAccount) {
        this.ai.addChatContext((tags['display-name'] || tags.username || 'user') + ': ' + message);
        this.chatActivityCount++;

        // Check if any of our bots were @tagged
        for (const [botKey, bot] of this.bots) {
          if (!bot.connected) continue;
          const mentioned = message.toLowerCase().includes('@' + botKey) ||
            message.toLowerCase().includes('@' + bot.username.toLowerCase());
          if (mentioned) {
            const delay = 1500 + Math.random() * 2000;
            const t = setTimeout(() => {
              if (!this.stopped) this.sendTagReply(bot, message);
            }, delay);
            bot.timers.push(t);
          }
        }

        // Reactive burst every 3 real messages
        if (this.chatActivityCount % 3 === 0) {
          this.triggerReactive();
        }
      }
    });

    this.readerClient.connect().catch((e: Error) =>
      console.error('[reader] connect error:', e.message)
    );
  }

  private triggerReactive(): void {
    if (this.stopped) return;
    const now = Date.now();
    const eligible = Array.from(this.bots.values())
      .filter(b => b.connected && now - b.lastMsgTime > 5000);
    if (!eligible.length) return;
    const bot = eligible[Math.floor(Math.random() * eligible.length)];
    const delay = 1000 + Math.random() * 3000;
    const t = setTimeout(() => {
      if (!this.stopped) this.sendAiMsg(bot, true);
    }, delay);
    bot.timers.push(t);
  }

  private async sendTagReply(bot: BotInstance, original: string): Promise<void> {
    if (!bot.connected || this.stopped) return;
    try {
      const msg = await this.ai.generateMessage(
        bot.username, this.context, this.language, bot.index, false, original
      );
      if (!msg || msg.length < 2) return;
      await bot.client.say('#' + this.channel, msg);
      bot.messages++;
      bot.lastMsgTime = Date.now();
      this.emit('bot:message', { username: bot.username, message: msg, count: bot.messages });
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
      connected: false, timers: [], messages: 0, index: idx, lastMsgTime: 0,
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
      if (this.stopped) return;
      this.emit('bot:status', { username: cfg.username, state: 'connecting', message: 'Переподключение...' });
    });
    client.on('notice', (_ch: string, msgid: string, message: string) => {
      console.warn('[notice]', cfg.username, msgid, message);
      this.emit('bot:error', { username: cfg.username, code: msgid, message });
    });

    this.emit('bot:status', { username: cfg.username, state: 'connecting', message: 'Подключение...' });

    const connectTimer = setTimeout(() => {
      if (!this.stopped)
        client.connect().catch((e: Error) => {
          console.error('[bot] connect error', cfg.username, e.message);
          this.emit('bot:status', { username: cfg.username, state: 'error', message: e.message });
        });
    }, idx * 1500);
    bot.timers.push(connectTimer);
  }

  start(): void {
    this.stopped = false;
    const bots = Array.from(this.bots.values());
    bots.forEach((bot, idx) => {
      // Stagger: bot 0 starts at 8s, bot 1 at 8+interval/n, etc.
      const stagger = Math.floor((this.intervalMs / Math.max(bots.length, 1)) * idx);
      const t = setTimeout(() => this.scheduleBot(bot), 8000 + stagger);
      bot.timers.push(t);
    });
  }

  private scheduleBot(bot: BotInstance): void {
    if (this.stopped) return;
    this.sendAiMsg(bot, false).finally(() => {
      if (!this.stopped) {
        const jitter = (Math.random() * 0.4 - 0.2) * this.intervalMs;
        const delay = Math.max(8000, this.intervalMs + jitter);
        const t = setTimeout(() => this.scheduleBot(bot), delay);
        bot.timers.push(t);
      }
    });
  }

  private async sendAiMsg(bot: BotInstance, isReactive: boolean): Promise<void> {
    if (!bot.connected || this.stopped) return;
    const now = Date.now();
    if (now - bot.lastMsgTime < 5000) return;

    try {
      const msg = await this.ai.generateMessage(
        bot.username, this.context, this.language, bot.index, isReactive
      );
      if (!msg || msg.length < 2) return;
      if (this.stopped) return;   // double-check after async

      console.log('[bot]', bot.username, isReactive ? '(reactive)' : '(proactive)', '→', msg);
      await bot.client.say('#' + this.channel, msg);
      bot.messages++;
      bot.lastMsgTime = Date.now();
      this.emit('bot:message', { username: bot.username, message: msg, count: bot.messages });

      // Emit transcript
      const log = this.ai.transcriptLog;
      if (log.length > 0) {
        this.emit('transcript:entry', log[log.length - 1]);
      }
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

  // ── VIEWER SIMULATION ────────────────────────────────────────────────────────
  // Fetches the HLS stream endpoint repeatedly — Twitch counts unique HLS sessions as viewers
  async startViewerSimulation(channel: string, clientId: string, appToken: string): Promise<void> {
    try {
      // Get stream HLS URL via usher
      const streamKey = await this.getStreamToken(channel, clientId, appToken);
      if (!streamKey) { console.warn('[viewers] Could not get stream token'); return; }

      const bots = Array.from(this.bots.values());
      console.log('[viewers] Starting HLS polling for', bots.length, 'bots');

      bots.forEach((bot, i) => {
        // Stagger start times
        const t = setTimeout(async () => {
          await this.pollHlsAsViewer(bot, streamKey, channel);
        }, i * 3000);
        this.viewerIntervals.push(t);
      });
    } catch (e: any) {
      console.error('[viewers] simulation error:', e.message);
    }
  }

  private async getStreamToken(channel: string, clientId: string, appToken: string): Promise<string | null> {
    try {
      // Get stream access token via GQL
      const gqlRes = await axios.post('https://gql.twitch.tv/gql', [{
        operationName: 'PlaybackAccessToken',
        variables: { isLive: true, login: channel, isVod: false, vodID: '', playerType: 'embed' },
        extensions: { persistedQuery: { version: 1, sha256Hash: '0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712' } },
      }], {
        headers: {
          'Client-ID': clientId || 'kimne78kx3ncx6brgo4mv6wki5h1ko',
          Authorization: appToken ? 'Bearer ' + appToken : '',
          'Content-Type': 'application/json',
        },
      });

      const token = gqlRes.data?.[0]?.data?.streamPlaybackAccessToken;
      if (!token) return null;

      const sig = token.signature;
      const tok = encodeURIComponent(token.value);
      return `https://usher.twitchapps.com/api/channel/hls/${channel}.m3u8?sig=${sig}&token=${tok}&allow_source=true&fast_bread=true&p=${Math.floor(Math.random()*999999)}&player_backend=mediaplayer&playlist_include_framerate=true`;
    } catch (e: any) {
      console.error('[viewers] token error:', e.message);
      return null;
    }
  }

  private async pollHlsAsViewer(bot: BotInstance, hlsUrl: string, _channel: string): Promise<void> {
    if (this.stopped) return;

    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Origin': 'https://www.twitch.tv',
      'Referer': 'https://www.twitch.tv/',
    };

    const poll = async () => {
      if (this.stopped) return;
      try {
        // Fetch the master playlist
        const res = await axios.get(hlsUrl, { headers, timeout: 10000 });
        // Extract a quality playlist URL from m3u8
        const lines: string[] = res.data.split('\n');
        const playlistUrl = lines.find((l: string) => l.startsWith('http'));
        if (playlistUrl) {
          // Fetch the actual stream segments playlist — this is what Twitch counts
          await axios.get(playlistUrl.trim(), { headers, timeout: 10000 });
          console.log('[viewers]', bot.username, 'watching stream ✓');
          this.emit('viewer:active', { username: bot.username });
        }
      } catch (e: any) {
        console.warn('[viewers]', bot.username, 'poll error:', e.message?.slice(0, 60));
      }
    };

    // Poll every 20s — Twitch requires periodic segment requests
    await poll();
    if (!this.stopped) {
      const t = setInterval(() => {
        if (this.stopped) { clearInterval(t); return; }
        poll();
      }, 20000);
      this.viewerIntervals.push(t);
    }
  }

  stopViewerSimulation(): void {
    this.viewerIntervals.forEach(t => { clearInterval(t); clearTimeout(t); });
    this.viewerIntervals = [];
  }

  async stop(): Promise<void> {
    console.log('[manager] stopping all bots...');
    this.stopped = true;

    // Clear ALL timers for ALL bots immediately
    for (const bot of this.bots.values()) {
      bot.timers.forEach(t => { clearTimeout(t); clearInterval(t); });
      bot.timers = [];
      bot.connected = false;
    }

    this.stopViewerSimulation();
    if (this.readerClient) { this.readerClient.disconnect().catch(() => {}); this.readerClient = null; }

    await Promise.allSettled(
      Array.from(this.bots.values()).map(b => b.client.disconnect().catch(() => {}))
    );
    this.bots.clear();
    console.log('[manager] all bots stopped');
  }

  getUsernames(): string[] {
    return Array.from(this.bots.values()).map(b => b.username);
  }

  getTranscriptLog() {
    return this.ai.transcriptLog;
  }
}
