import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';
import { BotManager } from './bot';
import { PersonaConfig } from './ai';

const app = express();
const http = createServer(app);
const io = new Server(http, { cors: { origin: '*' } });
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;

// ── Persistent storage ─────────────────────────────────────────────────────
// Railway mounts a volume; find a writable path
function getDataDir(): string {
  const candidates = [
    '/var/lib/twitch-boost',
    '/app/data',
    '/tmp/twitch-boost',
    path.join(__dirname, '../data'),
  ];
  for (const d of candidates) {
    try { fs.mkdirSync(d, { recursive: true }); return d; } catch { /* try next */ }
  }
  return '/tmp';
}

const DATA_DIR = getDataDir();
const CONFIG_FILE = path.join(DATA_DIR, 'saved-config.json');

interface SavedConfig {
  personas: Record<string, PersonaConfig>;
  phraseGroups: Record<string, string[]>;
  interval?: number;
}

function loadSaved(): SavedConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e: any) {
    console.warn('[config] load error:', e.message);
  }
  return { personas: {}, phraseGroups: {} };
}

function saveToDisk(data: SavedConfig): void {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf-8');
    console.log('[config] saved to', CONFIG_FILE);
  } catch (e: any) {
    console.error('[config] save error:', e.message);
  }
}

// ── Env config ──────────────────────────────────────────────────────────────
function extractChannel(raw: string): string {
  return raw.trim()
    .replace(/https?:\/\//g, '').replace(/www\.twitch\.tv\//g, '')
    .replace(/twitch\.tv\//g, '').replace(/^#/, '').replace(/\/$/, '')
    .trim().toLowerCase();
}

function readEnvConfig() {
  const channel = extractChannel(process.env.TWITCH_CHANNEL || '');
  const groqKey = (process.env.GROQ_API_KEY || '').trim();
  const language = (process.env.ORIGINAL_STREAM_LANGUAGE || 'ru').trim();
  // Raw seconds — NO forced cap, user decides
  const interval = parseInt(process.env.MESSAGE_INTERVAL || '60');
  const context = (process.env.STREAM_CONTEXT || '').trim();

  const bots: { username: string; token: string }[] = [];
  for (let i = 1; i <= 50; i++) {
    const u = process.env['BOT' + i + '_USERNAME']?.trim();
    const t = (process.env['BOT' + i + '_OAUTH'] || process.env['BOT' + i + '_OAUTH_TOKEN'])?.trim();
    if (u && t) bots.push({ username: u, token: t });
  }
  return { channel, groqKey, language, interval, context, bots };
}

// ── Twitch Helix ────────────────────────────────────────────────────────────
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
    const sRes = await axios.get('https://api.twitch.tv/helix/streams', {
      params: { user_login: channel },
      headers: { 'Client-ID': cid, Authorization: 'Bearer ' + appToken },
    });
    const s = sRes.data.data?.[0];
    if (s) return { live: true, viewers: s.viewer_count as number, game: s.game_name as string, title: s.title as string };
    return { live: false };
  } catch (e: any) {
    if (e.response?.status === 401) appToken = null;
    return { live: false };
  }
}

// ── State ───────────────────────────────────────────────────────────────────
let manager: BotManager | null = null;
let streamPoll: NodeJS.Timeout | null = null;
let startedBots: string[] = [];
let isStarted = false;
let currentInterval = 60;
let saved = loadSaved();

console.log('[config] data dir:', DATA_DIR);
console.log('[config] loaded personas:', Object.keys(saved.personas).join(', ') || 'none');
console.log('[config] loaded phrases:', Object.keys(saved.phraseGroups).join(', ') || 'none');

// ── REST ────────────────────────────────────────────────────────────────────
app.get('/api/transcript', (_req, res) => res.json(manager?.getTranscriptLog()?.slice(-100) || []));
app.get('/api/personas',   (_req, res) => res.json(saved.personas));
app.get('/api/phrases',    (_req, res) => res.json(saved.phraseGroups));
app.get('/api/status',     (_req, res) => {
  const cfg = readEnvConfig();
  res.json({ channel: cfg.channel, bots: cfg.bots.map(b => b.username), started: isStarted, interval: currentInterval });
});

// ── Socket.IO ───────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('[server] connected', socket.id);
  const cfg = readEnvConfig();

  // Use saved interval if it exists, otherwise env
  const initInterval = saved.interval || cfg.interval;
  currentInterval = initInterval;

  socket.emit('config', {
    channel: cfg.channel,
    interval: initInterval,
  });
  socket.emit('personas:update', saved.personas);
  socket.emit('phrases:update', saved.phraseGroups);

  if (isStarted && startedBots.length > 0) {
    socket.emit('bots:started', { bots: startedBots });
    startedBots.forEach(u => socket.emit('bot:status', { username: u, state: 'connected', message: 'Подключён' }));
  }

  // Manual message
  socket.on('send:manual', async (data: { targets: string[]; message: string }) => {
    if (manager && data.targets?.length && data.message)
      await manager.sendManual(data.targets, data.message);
  });

  // Change interval live
  socket.on('set:interval', (data: { seconds: number }) => {
    const s = Math.max(10, Math.min(3600, parseInt(String(data.seconds)) || 60));
    currentInterval = s;
    saved.interval = s;
    saveToDisk(saved);
    if (manager) manager.setInterval(s);
    io.emit('config', { channel: readEnvConfig().channel, interval: s });
    console.log('[server] interval changed to', s + 's');
  });

  // Save persona
  socket.on('set:persona', (data: { username: string; role: string; sys: string }) => {
    const k = data.username.toLowerCase();
    const cfg: PersonaConfig = { role: data.role, sys: data.sys };
    saved.personas[k] = cfg;
    saveToDisk(saved);
    if (manager) manager.setPersona(data.username, cfg);
    io.emit('personas:update', saved.personas);
    socket.emit('persona:saved', { username: data.username, ok: true });
    console.log('[server] persona saved for', data.username);
  });

  // Delete persona
  socket.on('del:persona', (data: { username: string }) => {
    delete saved.personas[data.username.toLowerCase()];
    saveToDisk(saved);
    if (manager) manager.setPersona(data.username, { role: 'default', sys: '' });
    io.emit('personas:update', saved.personas);
  });

  // Save phrases
  socket.on('set:phrases', (data: Record<string, string[]>) => {
    saved.phraseGroups = data;
    saveToDisk(saved);
    io.emit('phrases:update', saved.phraseGroups);
    console.log('[server] phrases saved:', Object.keys(data).join(', '));
  });

  socket.on('get:personas', () => socket.emit('personas:update', saved.personas));
  socket.on('get:phrases',  () => socket.emit('phrases:update', saved.phraseGroups));

  socket.on('disconnect', () => console.log('[server] disconnected', socket.id));
});

// ── Auto-start ───────────────────────────────────────────────────────────────
async function autoStart(): Promise<void> {
  const cfg = readEnvConfig();
  const interval = saved.interval || cfg.interval;
  currentInterval = interval;

  console.log('[server] channel="' + cfg.channel + '" bots=' + cfg.bots.length + ' interval=' + interval + 's groq=' + (cfg.groqKey ? 'OK' : 'MISSING'));

  if (!cfg.channel || !cfg.groqKey || !cfg.bots.length) {
    console.warn('[server] missing config, bots not started');
    return;
  }

  if (manager) { await manager.stop(); manager = null; await new Promise(r => setTimeout(r, 1500)); }

  manager = new BotManager(
    cfg.bots, cfg.channel, cfg.groqKey,
    {
      interval,
      language: cfg.language,
      context: cfg.context,
      settings: { useEmoji: true, chatContext: true },
      savedPersonas: saved.personas,
    },
    (event, data) => io.emit(event, data)
  );

  manager.start();
  startedBots = manager.getUsernames();
  isStarted = true;
  io.emit('bots:started', { bots: startedBots });
  console.log('[server] started', startedBots.length, 'bots, interval=' + interval + 's');

  const info = await getStreamData(cfg.channel);
  io.emit('stream:info', { live: info.live, game: (info as any).game, viewers: (info as any).viewers });
  if ((info as any).viewers != null) io.emit('stream:viewers', { viewers: (info as any).viewers });

  if (info.live && manager) manager.startViewerSim(cfg.channel).catch(() => {});

  if (streamPoll) clearInterval(streamPoll);
  streamPoll = setInterval(async () => {
    const si = await getStreamData(cfg.channel);
    io.emit('stream:info', { live: si.live, game: (si as any).game, viewers: (si as any).viewers });
    if ((si as any).viewers != null) io.emit('stream:viewers', { viewers: (si as any).viewers });
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
