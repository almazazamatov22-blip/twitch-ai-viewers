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
    .replace(/https?:\/\//g, '').replace(/www\.twitch\.tv\//g, '')
    .replace(/twitch\.tv\//g, '').replace(/^#/, '').replace(/\/$/, '')
    .trim().toLowerCase();
}

function readConfig() {
  const channel = extractChannel(process.env.TWITCH_CHANNEL || '');
  const groqKey = (process.env.GROQ_API_KEY || '').trim();
  const language = (process.env.ORIGINAL_STREAM_LANGUAGE || 'ru').trim();

  // Parse interval — cap between 10 and 300 seconds regardless of what's in env
  const rawInterval = parseInt(process.env.MESSAGE_INTERVAL || '60');
  // If someone set 2000 (thinking ms), auto-correct to 60
  const interval = rawInterval > 300 ? 60 : Math.max(10, rawInterval);
  if (rawInterval !== interval) {
    console.warn('[config] MESSAGE_INTERVAL=' + rawInterval + ' capped to ' + interval + 's');
  }

  const context = (process.env.STREAM_CONTEXT || '').trim();
  const viewerSim = process.env.VIEWER_SIM !== 'false';

  const bots: { username: string; token: string }[] = [];
  for (let i = 1; i <= 50; i++) {
    const u = process.env['BOT' + i + '_USERNAME']?.trim();
    const t = (process.env['BOT' + i + '_OAUTH'] || process.env['BOT' + i + '_OAUTH_TOKEN'])?.trim();
    if (u && t) bots.push({ username: u, token: t });
  }
  return { channel, groqKey, language, interval, context, bots, viewerSim };
}

// ── Helix ─────────────────────────────────────────────────────────────────────
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
  } catch { return null; }
}

async function getStreamData(channel: string) {
  const cid = process.env.TWITCH_CLIENT_ID?.trim();
  if (!cid || !channel) return { live: false };
  if (!appToken) appToken = await getAppToken();
  if (!appToken) return { live: false };
  try {
    const [uRes, sRes] = await Promise.all([
      axios.get('https://api.twitch.tv/helix/users', { params: { login: channel }, headers: { 'Client-ID': cid, Authorization: 'Bearer ' + appToken } }),
      axios.get('https://api.twitch.tv/helix/streams', { params: { user_login: channel }, headers: { 'Client-ID': cid, Authorization: 'Bearer ' + appToken } }),
    ]);
    const userId = uRes.data.data?.[0]?.id;
    const s = sRes.data.data?.[0];
    if (s) return { live: true, viewers: s.viewer_count as number, game: s.game_name as string, userId, title: s.title as string };
    return { live: false, userId };
  } catch (e: any) {
    if (e.response?.status === 401) appToken = null;
    return { live: false };
  }
}

// ── State ──────────────────────────────────────────────────────────────────────
let manager: BotManager | null = null;
let streamPoll: NodeJS.Timeout | null = null;
let startedBots: string[] = [];
let isStarted = false;

// ── REST ───────────────────────────────────────────────────────────────────────
app.get('/api/transcript', (_req, res) => {
  res.json(manager?.getTranscriptLog()?.slice(-100) || []);
});
app.get('/api/personas', (_req, res) => {
  res.json(manager?.getPersonas() || {});
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
    // Send current personas
    if (manager) socket.emit('personas:update', manager.getPersonas());
  }

  socket.on('send:manual', async (data: { targets: string[]; message: string }) => {
    if (manager && data.targets?.length && data.message)
      await manager.sendManual(data.targets, data.message);
  });

  socket.on('set:persona', (data: { username: string; role: string; sys: string }) => {
    if (!manager) return;
    manager.setPersona(data.username, data.role, data.sys);
    io.emit('personas:update', manager.getPersonas());
    socket.emit('persona:saved', { username: data.username, ok: true });
  });

  socket.on('get:personas', () => {
    if (manager) socket.emit('personas:update', manager.getPersonas());
  });

  socket.on('disconnect', () => console.log('[server] disconnected', socket.id));
});

// ── Auto-start ─────────────────────────────────────────────────────────────────
async function autoStart(): Promise<void> {
  const cfg = readConfig();
  console.log('[server] channel="' + cfg.channel + '" bots=' + cfg.bots.length + ' interval=' + cfg.interval + 's groq=' + (cfg.groqKey ? 'OK' : 'MISSING'));

  if (!cfg.channel || !cfg.groqKey || !cfg.bots.length) {
    console.warn('[server] missing config — bots not started');
    return;
  }

  if (manager) { await manager.stop(); manager = null; await new Promise(r => setTimeout(r, 1500)); }

  manager = new BotManager(
    cfg.bots, cfg.channel, cfg.groqKey,
    { interval: cfg.interval, language: cfg.language, context: cfg.context,
      settings: { useEmoji: true, chatContext: true } },
    (event, data) => io.emit(event, data)
  );

  manager.start();
  startedBots = manager.getUsernames();
  isStarted = true;
  io.emit('bots:started', { bots: startedBots });
  console.log('[server] started', startedBots.length, 'bots, interval=' + cfg.interval + 's');

  // Emit initial personas
  io.emit('personas:update', manager.getPersonas());

  const info = await getStreamData(cfg.channel);
  console.log('[server] stream live=' + info.live + ' viewers=' + (info as any).viewers);
  io.emit('stream:info', { live: info.live, game: (info as any).game, viewers: (info as any).viewers });
  if ((info as any).viewers != null) io.emit('stream:viewers', { viewers: (info as any).viewers });

  // Start viewer sim only if live
  if (info.live && cfg.viewerSim) {
    manager.startViewerSimulation(cfg.channel).catch(() => {});
  }

  if (streamPoll) clearInterval(streamPoll);
  streamPoll = setInterval(async () => {
    const si = await getStreamData(cfg.channel);
    io.emit('stream:info', { live: si.live, game: (si as any).game, viewers: (si as any).viewers });
    if ((si as any).viewers != null) io.emit('stream:viewers', { viewers: (si as any).viewers });
    if (si.live && cfg.viewerSim && manager) {
      manager.startViewerSimulation(cfg.channel).catch(() => {});
    }
  }, 30000);
}

http.listen(PORT, () => {
  console.log('\nTwitchBoost at http://localhost:' + PORT + '\n');
  setTimeout(autoStart, 1500);
});

process.on('SIGTERM', async () => {
  if (streamPoll) clearInterval(streamPoll);
  if (manager) await manager.stop();
  process.exit(0);
});
