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

// ── Strip full URL or # to get bare channel name ────────────────────────────
function extractChannel(raw: string): string {
  return raw
    .trim()
    .replace(/https?:\/\//g, '')
    .replace(/www\.twitch\.tv\//g, '')
    .replace(/twitch\.tv\//g, '')
    .replace(/^#/, '')
    .replace(/\/$/, '')
    .trim()
    .toLowerCase();
}

function readConfig() {
  const raw = process.env.TWITCH_CHANNEL || '';
  const channel = extractChannel(raw);
  const groqKey = (process.env.GROQ_API_KEY || '').trim();
  const language = (process.env.ORIGINAL_STREAM_LANGUAGE || 'ru').trim();
  const interval = parseInt(process.env.MESSAGE_INTERVAL || '30');
  const context = (process.env.STREAM_CONTEXT || '').trim();

  const bots: { username: string; token: string }[] = [];
  for (let i = 1; i <= 50; i++) {
    const u = process.env['BOT' + i + '_USERNAME']?.trim();
    const t = (process.env['BOT' + i + '_OAUTH'] || process.env['BOT' + i + '_OAUTH_TOKEN'])?.trim();
    if (u && t) bots.push({ username: u, token: t });
  }

  return { channel, groqKey, language, interval, context, bots };
}

// ── Twitch Helix API ─────────────────────────────────────────────────────────
let appToken: string | null = null;

async function getAppToken(): Promise<string | null> {
  const cid = process.env.TWITCH_CLIENT_ID?.trim();
  const cs  = process.env.TWITCH_CLIENT_SECRET?.trim();
  if (!cid || !cs) return null;
  try {
    const r = await axios.post(
      'https://id.twitch.tv/oauth2/token',
      null,
      { params: { client_id: cid, client_secret: cs, grant_type: 'client_credentials' } }
    );
    return r.data.access_token as string;
  } catch (e: any) {
    console.error('[helix] token error:', e.response?.data || e.message);
    return null;
  }
}

async function getStreamData(channel: string): Promise<{ live: boolean; viewers?: number; game?: string; userId?: string }> {
  const cid = process.env.TWITCH_CLIENT_ID?.trim();
  if (!cid || !channel) return { live: false };
  if (!appToken) appToken = await getAppToken();
  if (!appToken) return { live: false };

  try {
    // Get user info
    const uRes = await axios.get('https://api.twitch.tv/helix/users', {
      params: { login: channel },
      headers: { 'Client-ID': cid, Authorization: 'Bearer ' + appToken },
    });
    const userId = uRes.data.data?.[0]?.id as string | undefined;

    // Get stream
    const sRes = await axios.get('https://api.twitch.tv/helix/streams', {
      params: { user_login: channel },
      headers: { 'Client-ID': cid, Authorization: 'Bearer ' + appToken },
    });
    const s = sRes.data.data?.[0];

    if (s) return { live: true, viewers: s.viewer_count as number, game: s.game_name as string, userId };
    return { live: false, userId };
  } catch (e: any) {
    if (e.response?.status === 401) appToken = null;
    console.error('[helix] stream error:', e.response?.data || e.message);
    return { live: false };
  }
}

// ── State ────────────────────────────────────────────────────────────────────
let manager: BotManager | null = null;
let streamPoll: NodeJS.Timeout | null = null;
let startedBots: string[] = [];
let isStarted = false;
let channelUserId: string | null = null;

// ── Follow endpoint ───────────────────────────────────────────────────────────
app.post('/api/follow', async (_req, res) => {
  if (!manager) return res.json({ error: 'Боты не запущены' });
  const cid = process.env.TWITCH_CLIENT_ID?.trim();
  if (!cid)          return res.json({ error: 'TWITCH_CLIENT_ID не задан' });
  if (!channelUserId) {
    // Try to fetch it now
    const cfg = readConfig();
    const data = await getStreamData(cfg.channel);
    channelUserId = data.userId || null;
  }
  if (!channelUserId) return res.json({ error: 'Не удалось получить ID канала. Проверь TWITCH_CLIENT_ID и TWITCH_CLIENT_SECRET' });

  const results = await manager.followChannel(channelUserId, cid);
  res.json({ results });
});

app.get('/api/status', (_req, res) => {
  const cfg = readConfig();
  res.json({ channel: cfg.channel, bots: cfg.bots.map(b => b.username), started: isStarted });
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('[server] connected ' + socket.id);
  const cfg = readConfig();
  socket.emit('config', { channel: cfg.channel });

  if (isStarted && startedBots.length > 0) {
    socket.emit('bots:started', { bots: startedBots });
    startedBots.forEach(u =>
      socket.emit('bot:status', { username: u, state: 'connected', message: 'Подключён' })
    );
  }

  socket.on('send:manual', async (data: { targets: string[]; message: string }) => {
    if (manager && data.targets?.length && data.message)
      await manager.sendManual(data.targets, data.message);
  });

  socket.on('disconnect', () => console.log('[server] disconnected ' + socket.id));
});

// ── Auto-start ────────────────────────────────────────────────────────────────
async function autoStart(): Promise<void> {
  const cfg = readConfig();
  console.log('[server] channel="' + cfg.channel + '" bots=' + cfg.bots.length + ' groq=' + (cfg.groqKey ? 'OK' : 'MISSING'));
  cfg.bots.forEach((b, i) => console.log('  bot' + (i + 1) + ': ' + b.username));

  if (!cfg.channel) { console.warn('[server] TWITCH_CHANNEL missing'); return; }
  if (!cfg.groqKey)  { console.warn('[server] GROQ_API_KEY missing'); return; }
  if (!cfg.bots.length) { console.warn('[server] No bots! Set BOT1_USERNAME + BOT1_OAUTH'); return; }

  if (manager) await manager.stop();

  manager = new BotManager(
    cfg.bots, cfg.channel, cfg.groqKey,
    {
      interval: cfg.interval,
      language: cfg.language,
      context: cfg.context,
      settings: { useEmoji: true, chatContext: true, uniquePersonas: true },
    },
    (event, data) => io.emit(event, data)
  );

  manager.start();
  startedBots = cfg.bots.map(b => b.username);
  isStarted = true;
  io.emit('bots:started', { bots: startedBots });
  console.log('[server] Started ' + startedBots.length + ' bots for #' + cfg.channel);

  const info = await getStreamData(cfg.channel);
  channelUserId = info.userId || null;
  console.log('[server] channelUserId=' + channelUserId);

  io.emit('stream:info', { live: info.live, game: info.game, viewers: info.viewers });
  if (info.viewers != null) io.emit('stream:viewers', { viewers: info.viewers });

  if (streamPoll) clearInterval(streamPoll);
  streamPoll = setInterval(async () => {
    const si = await getStreamData(cfg.channel);
    if (si.userId && !channelUserId) channelUserId = si.userId;
    io.emit('stream:info', { live: si.live, game: si.game, viewers: si.viewers });
    if (si.viewers != null) io.emit('stream:viewers', { viewers: si.viewers });
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
