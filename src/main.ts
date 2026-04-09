import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import * as path from 'path';
import axios from 'axios';
import { BotManager } from './bot';

const app = express();
const http = createServer(app);
const io = new Server(http, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;

function extractChannel(raw: string): string {
  return raw.trim()
    .replace(/https?:\/\//g, '')
    .replace(/www\.twitch\.tv\//g, '')
    .replace(/twitch\.tv\//g, '')
    .replace(/^#/, '').replace(/\/$/, '')
    .trim().toLowerCase();
}

function readConfig() {
  const channel = extractChannel(process.env.TWITCH_CHANNEL || '');
  const groqKey = (process.env.GROQ_API_KEY || '').trim();
  const language = (process.env.ORIGINAL_STREAM_LANGUAGE || 'ru').trim();
  const interval = parseInt(process.env.MESSAGE_INTERVAL || '15');
  const context = (process.env.STREAM_CONTEXT || '').trim();
  const viewerSim = process.env.VIEWER_SIM !== 'false'; // default enabled

  const bots: { username: string; token: string }[] = [];
  for (let i = 1; i <= 50; i++) {
    const u = process.env['BOT' + i + '_USERNAME']?.trim();
    const t = (process.env['BOT' + i + '_OAUTH'] || process.env['BOT' + i + '_OAUTH_TOKEN'])?.trim();
    if (u && t) bots.push({ username: u, token: t });
  }
  return { channel, groqKey, language, interval, context, bots, viewerSim };
}

// ── Twitch Helix ──────────────────────────────────────────────────────────────
let appToken: string | null = null;

async function getAppToken(): Promise<string | null> {
  const cid = process.env.TWITCH_CLIENT_ID?.trim();
  const cs  = process.env.TWITCH_CLIENT_SECRET?.trim();
  if (!cid || !cs) return null;
  try {
    const r = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: { client_id: cid, client_secret: cs, grant_type: 'client_credentials' },
    });
    return r.data.access_token as string;
  } catch (e: any) {
    console.error('[helix] token error:', e.response?.data || e.message);
    return null;
  }
}

async function getStreamData(channel: string): Promise<{ live: boolean; viewers?: number; game?: string; userId?: string; title?: string }> {
  const cid = process.env.TWITCH_CLIENT_ID?.trim();
  if (!cid || !channel) return { live: false };
  if (!appToken) appToken = await getAppToken();
  if (!appToken) return { live: false };

  try {
    const [uRes, sRes] = await Promise.all([
      axios.get('https://api.twitch.tv/helix/users', {
        params: { login: channel },
        headers: { 'Client-ID': cid, Authorization: 'Bearer ' + appToken },
      }),
      axios.get('https://api.twitch.tv/helix/streams', {
        params: { user_login: channel },
        headers: { 'Client-ID': cid, Authorization: 'Bearer ' + appToken },
      }),
    ]);
    const userId = uRes.data.data?.[0]?.id as string | undefined;
    const s = sRes.data.data?.[0];
    if (s) return { live: true, viewers: s.viewer_count, game: s.game_name, userId, title: s.title };
    return { live: false, userId };
  } catch (e: any) {
    if (e.response?.status === 401) appToken = null;
    console.error('[helix] error:', e.response?.data || e.message);
    return { live: false };
  }
}

// ── State ──────────────────────────────────────────────────────────────────────
let manager: BotManager | null = null;
let streamPoll: NodeJS.Timeout | null = null;
let startedBots: string[] = [];
let isStarted = false;

// ── API ────────────────────────────────────────────────────────────────────────
app.get('/api/transcript', (_req, res) => {
  const log = manager?.getTranscriptLog() || [];
  res.json(log.slice(-100));
});

app.get('/api/status', (_req, res) => {
  const cfg = readConfig();
  res.json({ channel: cfg.channel, bots: cfg.bots.map(b => b.username), started: isStarted, interval: cfg.interval });
});

// ── Socket.IO ──────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('[server] connected', socket.id);
  const cfg = readConfig();
  socket.emit('config', { channel: cfg.channel, interval: cfg.interval });

  if (isStarted && startedBots.length > 0) {
    socket.emit('bots:started', { bots: startedBots });
    startedBots.forEach(u => socket.emit('bot:status', { username: u, state: 'connected', message: 'Подключён' }));
  }

  socket.on('send:manual', async (data: { targets: string[]; message: string }) => {
    if (manager && data.targets?.length && data.message)
      await manager.sendManual(data.targets, data.message);
  });

  socket.on('disconnect', () => console.log('[server] disconnected', socket.id));
});

// ── Auto-start ─────────────────────────────────────────────────────────────────
async function autoStart(): Promise<void> {
  const cfg = readConfig();
  console.log('[server] channel="' + cfg.channel + '" bots=' + cfg.bots.length +
    ' groq=' + (cfg.groqKey ? 'OK' : 'MISSING') + ' interval=' + cfg.interval + 's');

  if (!cfg.channel) { console.warn('[server] TWITCH_CHANNEL missing'); return; }
  if (!cfg.groqKey)  { console.warn('[server] GROQ_API_KEY missing'); return; }
  if (!cfg.bots.length) { console.warn('[server] No bots configured'); return; }

  // Stop existing if running
  if (manager) {
    console.log('[server] stopping existing manager...');
    await manager.stop();
    manager = null;
    isStarted = false;
    startedBots = [];
    // Wait a moment for clean disconnect
    await new Promise(r => setTimeout(r, 2000));
  }

  manager = new BotManager(
    cfg.bots, cfg.channel, cfg.groqKey,
    { interval: cfg.interval, language: cfg.language, context: cfg.context,
      settings: { useEmoji: true, chatContext: true, uniquePersonas: true } },
    (event, data) => io.emit(event, data)
  );

  manager.start();
  startedBots = manager.getUsernames();
  isStarted = true;
  io.emit('bots:started', { bots: startedBots });
  console.log('[server] Started', startedBots.length, 'bots for #' + cfg.channel);

  // Get stream info
  const info = await getStreamData(cfg.channel);
  console.log('[server] stream live=' + info.live + ' viewers=' + info.viewers);
  io.emit('stream:info', { live: info.live, game: info.game, viewers: info.viewers, title: info.title });
  if (info.viewers != null) io.emit('stream:viewers', { viewers: info.viewers });

  // Start viewer simulation if stream is live
  if (info.live && cfg.viewerSim && appToken) {
    const cid = process.env.TWITCH_CLIENT_ID?.trim() || '';
    console.log('[server] Starting viewer simulation...');
    manager.startViewerSimulation(cfg.channel, cid, appToken).catch(e =>
      console.error('[server] viewer sim error:', e.message)
    );
  }

  if (streamPoll) clearInterval(streamPoll);
  streamPoll = setInterval(async () => {
    if (!manager) return;
    const si = await getStreamData(cfg.channel);
    io.emit('stream:info', { live: si.live, game: si.game, viewers: si.viewers });
    if (si.viewers != null) io.emit('stream:viewers', { viewers: si.viewers });

    // Start viewer sim if just went live
    if (si.live && cfg.viewerSim && appToken && manager) {
      const cid = process.env.TWITCH_CLIENT_ID?.trim() || '';
      manager.startViewerSimulation(cfg.channel, cid, appToken).catch(() => {});
    }
  }, 30000);
}

http.listen(PORT, () => {
  console.log('\nTwitchBoost running at http://localhost:' + PORT + '\n');
  setTimeout(autoStart, 1500);
});

process.on('SIGTERM', async () => {
  if (streamPoll) clearInterval(streamPoll);
  if (manager) await manager.stop();
  process.exit(0);
});
