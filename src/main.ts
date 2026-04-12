import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';
import { BotManager } from './bot';
import { PersonaConfig } from './ai';
import { TranscriptionService } from './transcription';
import { LearnBot } from './learn';

const app = express();
const http = createServer(app);
const io = new Server(http, { cors: { origin: '*' } });
app.use(express.json());
const FE_DIST = path.join(__dirname, '../frontend/dist');
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.static(FE_DIST));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/debug', (_req, res) => {
  const gistIdPath = path.join(DATA_DIR, 'gist-id.txt');
  let savedGistId = '';
  try {
    if (fs.existsSync(gistIdPath)) {
      savedGistId = fs.readFileSync(gistIdPath, 'utf-8').trim();
    }
  } catch {}
  
  res.json({
    hasGitHubToken: !!GITHUB_TOKEN,
    tokenLength: GITHUB_TOKEN?.length || 0,
    hasGistId: !!MARKOV_GIST_ID,
    gistId: MARKOV_GIST_ID || 'not set',
    savedGistId: savedGistId || 'no saved',
    learnBotExists: !!learnBot,
  });
});
app.get('/api/learn', (_req, res) => {
  if (learnBot) {
    res.json(learnBot.getData());
  } else {
    res.json({ messages: 0, words: 0, uniqueWords: 0 });
  }
});
app.get('/api/learn/download', (_req, res) => {
  const p = getLearnDataPath();
  if (fs.existsSync(p)) {
    res.download(p, 'markov-chain.json');
  } else {
    res.status(404).json({ error: 'No saved data' });
  }
});
app.get('/api/learn/json', (_req, res) => {
  const p = getLearnDataPath();
  if (fs.existsSync(p)) {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    // Send only stats, not full chain (too big)
    res.json({ messages: data.messages, words: data.words, uniqueWords: Object.keys(data.chain || {}).length });
  } else {
    res.json({ messages: 0, words: 0, uniqueWords: 0 });
  }
});
app.get('/api/learn/view', (_req, res) => {
  const p = getLearnDataPath();
  if (!fs.existsSync(p)) {
    res.send('<html><body><h1>No saved data</h1><p>Start learning first.</p></body></html>');
    return;
  }
  const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  const topPhrases = Object.entries(data.chain || {})
    .filter(([k, v]: any) => v.length > 1)
    .sort((a: any, b: any) => b[1].length - a[1].length)
    .slice(0, 50)
    .map(([k, v]: any) => `<tr><td>${k}</td><td>${v.slice(0,5).join(', ')}</td><td>${v.length}</td></tr>`)
    .join('');
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Markov Chain</title>
<style>body{font-family:monospace;background:#111;color:#eee;padding:20px}
h1{color:#9d5cf6}table{border-collapse:collapse;width:100%;margin-top:20px}
th,td{border:1px solid #333;padding:8px;text-align:left}th{background:#222}
.stats{background:#222;padding:15px;border-radius:8px;margin-bottom:20px}
a{color:#7c3aed}</style></head>
<body>
<h1>📚 Markov Chain — ${data.messages || 0} сообщений, ${data.words || 0} слов</h1>
<div class="stats">
<p>Сообщений: <b>${data.messages || 0}</b> | Слов: <b>${data.words || 0}</b> | Уникальных цепочек: <b>${Object.keys(data.chain || {}).length}</b></p>
<p><a href="/api/learn/download">📥 Скачать JSON</a></p>
</div>
<h2>Top 50 цепочек:</h2>
<table><tr><th>Цепочка</th><th>Следующие слова</th><th>Кол-во</th></tr>
${topPhrases}
</table>
</body></html>`);
});
app.get('*', (_req, res) => {
  res.sendFile(path.join(FE_DIST, 'index.html'));
});
const PORT = process.env.PORT || 3000;

// ── Persistent storage ──────────────────────────────────────────────────────
function getDataDir(): string {
  for (const d of ['/var/lib/twitch-boost', '/app/data', '/tmp/twitch-boost', path.join(__dirname, '../data')]) {
    try { 
      fs.mkdirSync(d, { recursive: true }); 
      // Test write
      fs.writeFileSync(path.join(d, '.test'), 'test');
      fs.unlinkSync(path.join(d, '.test'));
      console.log('[config] Using data dir:', d);
      return d; 
    } catch (e: any) { 
      console.log('[config] Cannot use:', d, e.message);
    }
  }
  return '/tmp';
}
const DATA_DIR = getDataDir();
const CONFIG_FILE = (channel: string) => path.join(DATA_DIR, `config-${channel}.json`);
console.log('[config] data dir:', DATA_DIR);

interface SavedConfig {
  personas: Record<string, PersonaConfig>;
  phraseGroups: Record<string, string[]>;
  botsPerTranscript?: number;
  botHistories?: Record<string, { role: string; content: string; time: number }[]>;
  transcriptHistory?: { heard: string; timestamp: number; responses: { username: string; message: string }[] }[];
  realChatHistory?: { username: string; message: string; time: number }[];
}

function loadSaved(channel: string): SavedConfig {
  const file = CONFIG_FILE(channel);
  try { if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    console.log('[config] Loaded from:', file, 'personas:', Object.keys(data.personas || {}).length);
    return data;
  }}
  catch (e: any) { console.warn('[config] load error:', e.message); }
  return { personas: {}, phraseGroups: {} };
}
function saveToDisk(data: SavedConfig, channel: string): void {
  const file = CONFIG_FILE(channel);
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); console.log('[config] Saved to:', file); }
  catch (e: any) { console.error('[config] save error:', e.message); }
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
  const context = (process.env.STREAM_CONTEXT || '').trim();
  const bots: { username: string; token: string }[] = [];
  for (let i = 1; i <= 50; i++) {
    const u = process.env['BOT' + i + '_USERNAME']?.trim();
    const t = (process.env['BOT' + i + '_OAUTH'] || process.env['BOT' + i + '_OAUTH_TOKEN'])?.trim();
    if (u && t) bots.push({ username: u, token: t });
  }
  return { channel, groqKey, language, context, bots };
}

function readLearnConfig() {
  const learnChan = extractChannel(process.env.LEARN_CHANNEL || '');
  const groqKey = process.env.GROQ_API_KEY?.trim();
  const language = (process.env.ORIGINAL_STREAM_LANGUAGE || 'ru').trim();
  const bots: { username: string; token: string }[] = [];
  for (let i = 1; i <= 50; i++) {
    const u = process.env['BOT' + i + '_USERNAME']?.trim();
    const t = (process.env['BOT' + i + '_OAUTH'] || process.env['BOT' + i + '_OAUTH_TOKEN'])?.trim();
    if (u && t) bots.push({ username: u, token: t });
  }
  // LEARN_TRANSCRIPT_DURATION in seconds (default 15s, min 10s, max 60s)
  // Shorter = more real-time context for learning, more Groq API calls
  // Recommended: 15 for active learning, 30 for quieter channels
  const rawLearnDur = parseInt(process.env.LEARN_TRANSCRIPT_DURATION || '15', 10);
  const learnChunkSecs = Math.max(10, Math.min(60, isNaN(rawLearnDur) ? 15 : rawLearnDur));

  return {
    channel: learnChan,
    tokens: bots.map(b => b.token),
    groqKey,
    language,
    learnChunkSecs,
  };
}

// ── GitHub Repo for Markov data ───────────────────────────────────────────────
const GITHUB_TOKEN = process.env.GITHUB_TOKEN?.trim();
const GITHUB_REPO = process.env.GITHUB_REPO?.trim(); // format: "owner/repo"
const GITHUB_FILE_PATH = process.env.GITHUB_FILE_PATH?.trim() || 'markov-data.json';

console.log('[env] GITHUB_TOKEN set:', !!GITHUB_TOKEN);
console.log('[env] GITHUB_REPO set:', GITHUB_REPO || 'NOT SET');
console.log('[env] GITHUB_FILE_PATH:', GITHUB_FILE_PATH);

async function loadFromGitHubRepo(): Promise<any | null> {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.log('[github] No GITHUB_REPO configured');
    return null;
  }
  
  const [owner, repo] = GITHUB_REPO.split('/');
  if (!owner || !repo) {
    console.log('[github] Invalid GITHUB_REPO format');
    return null;
  }
  
  try {
    // Try to get file (returns 404 if doesn't exist)
    const r = await axios.get(`https://api.github.com/repos/${owner}/${repo}/contents/${GITHUB_FILE_PATH}`, {
      headers: { Authorization: 'Bearer ' + GITHUB_TOKEN },
    });
    
    if (r.data.content) {
      const content = Buffer.from(r.data.content, 'base64').toString('utf-8');
      console.log('[github] Loaded Markov data from repo');
      return JSON.parse(content);
    }
    return null;
  } catch (e: any) {
    if (e.response?.status === 404) {
      console.log('[github] File not found, will create on first save');
      return null;
    }
    console.log('[github] Could not load:', e.message);
    return null;
  }
}

async function saveToGitHubRepo(data: any): Promise<boolean> {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return false;
  
  const [owner, repo] = GITHUB_REPO.split('/');
  if (!owner || !repo) return false;
  
  const json = JSON.stringify(data, null, 2);
  console.log('[github] Saving to repo:', owner, repo, 'size:', json.length);
  
  try {
    // First try to get current file to get SHA
    let sha = '';
    try {
      const r = await axios.get(`https://api.github.com/repos/${owner}/${repo}/contents/${GITHUB_FILE_PATH}`, {
        headers: { Authorization: 'Bearer ' + GITHUB_TOKEN },
      });
      sha = r.data.sha;
      console.log('[github] Got SHA:', sha);
    } catch (e: any) {
      console.log('[github] Get file error:', e.message, e.response?.status);
    }
    
    // Create or update file
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${GITHUB_FILE_PATH}`;
    console.log('[github] PUT to:', url);
    const payload: any = {
      message: 'Update Markov chain data',
      content: Buffer.from(json).toString('base64'),
    };
    if (sha) payload.sha = sha;
    
    const res = await axios.put(url, payload, {
      headers: { Authorization: 'Bearer ' + GITHUB_TOKEN, 'Content-Type': 'application/json' },
    });
    console.log('[github] Saved to repo, status:', res.status);
    return true;
  } catch (e: any) {
    console.log('[github] Save to repo error:', e.message, e.response?.status, e.response?.data);
    return false;
  }
}

// Legacy Gist support (keep for backward compatibility)
const MARKOV_GIST_ID = process.env.MARKOV_GIST_ID?.trim();

async function loadFromGitHub(): Promise<any | null> {
  if (!GITHUB_TOKEN || !MARKOV_GIST_ID) {
    console.log('[github] No GITHUB_TOKEN or MARKOV_GIST_ID configured');
    return null;
  }
  
  let gistId = MARKOV_GIST_ID;
  
  // If 'auto', try to load existing gist ID from file
  if (gistId === 'auto') {
    const gistIdPath = path.join(DATA_DIR, 'gist-id.txt');
    try {
      if (fs.existsSync(gistIdPath)) {
        gistId = fs.readFileSync(gistIdPath, 'utf-8').trim();
        console.log('[github] Using saved gist ID:', gistId);
      }
    } catch {}
    
    if (gistId === 'auto' || !gistId) {
      console.log('[github] No gist ID found, will create on first save');
      return null;
    }
  }
  
  try {
    const r = await axios.get(`https://api.github.com/gists/${gistId}`, {
      headers: { Authorization: 'Bearer ' + GITHUB_TOKEN },
    });
    const files = r.data.files;
    const keys = Object.keys(files);
    if (keys.length === 0) return null;
    const content = files[keys[0]].content;
    console.log('[github] Loaded Markov data from gist');
    return JSON.parse(content);
  } catch (e: any) {
    console.log('[github] Could not load:', e.message, e.response?.status);
    return null;
  }
}

async function saveToGitHub(data: any): Promise<boolean> {
  if (!GITHUB_TOKEN || !MARKOV_GIST_ID) return false;
  
  let gistId = MARKOV_GIST_ID;
  
  // If 'auto', try to load existing gist ID from file
  if (gistId === 'auto') {
    const gistIdPath = path.join(DATA_DIR, 'gist-id.txt');
    try {
      if (fs.existsSync(gistIdPath)) {
        gistId = fs.readFileSync(gistIdPath, 'utf-8').trim();
        console.log('[github] Using saved gist ID:', gistId);
      }
    } catch {}
  }
  
  try {
    const json = JSON.stringify(data, null, 2);
    if (gistId === 'auto' || !gistId) {
      // Create new gist
      const r = await axios.post('https://api.github.com/gists', {
        description: 'TwitchBoost Markov Chain',
        public: false,
        files: { 'markov-chain.json': { content: json } },
      }, { headers: { Authorization: 'Bearer ' + GITHUB_TOKEN } });
      const newId = r.data.id;
      console.log('[github] Created new gist:', newId);
      // Save gist ID to local file
      try {
        fs.writeFileSync(path.join(DATA_DIR, 'gist-id.txt'), newId);
      } catch {}
      return true;
    } else {
      // Update existing gist
      console.log('[github] Patching gist:', gistId, 'data size:', json.length, 'token len:', GITHUB_TOKEN?.length);
      try {
        const r = await axios.patch(`https://api.github.com/gists/${gistId}`, {
          files: { 'markov-chain.json': { content: json } },
        }, { 
          headers: { 
            Authorization: 'Bearer ' + GITHUB_TOKEN,
            'Content-Type': 'application/json',
          } 
        });
        console.log('[github] Updated gist, response:', r.status);
        return true;
      } catch (e: any) {
        console.log('[github] Patch error:', e.message, e.response?.status);
        return false;
      }
    }
  } catch (e: any) {
    console.log('[github] Save error:', e.message);
    return false;
  }
}
let appToken: string | null = null;
async function getAppToken(): Promise<string | null> {
  const cid = process.env.TWITCH_CLIENT_ID?.trim(), cs = process.env.TWITCH_CLIENT_SECRET?.trim();
  if (!cid || !cs) return null;
  try {
    const r = await axios.post('https://id.twitch.tv/oauth2/token?' + 
      new URLSearchParams({ client_id: cid, client_secret: cs, grant_type: 'client_credentials' }).toString());
    console.log('[helix] token response: ok, expires:', r.data.expires_in);
    return r.data.access_token as string;
  } catch (e: any) { 
    console.error('[helix] token error:', e.message);
    return null; 
  }
}
async function getStreamData(channel: string): Promise<{ live: boolean; viewers?: number; game?: string; userId?: string }> {
  const cid = process.env.TWITCH_CLIENT_ID?.trim();
  if (!cid || !channel) return { live: false };
  if (!appToken) {
    console.log('[helix] getting app token...');
    appToken = await getAppToken();
    console.log('[helix] got app token:', appToken ? 'OK' : 'FAILED');
  }
  if (!appToken) return { live: false };
  try {
    const [uRes, sRes] = await Promise.all([
      axios.get('https://api.twitch.tv/helix/users', { params: { login: channel }, headers: { 'Client-ID': cid, Authorization: 'Bearer ' + appToken } }),
      axios.get('https://api.twitch.tv/helix/streams', { params: { user_login: channel }, headers: { 'Client-ID': cid, Authorization: 'Bearer ' + appToken } }),
    ]);
    const userId = uRes.data.data?.[0]?.id as string | undefined;
    const s = sRes.data.data?.[0];
    if (s) {
      console.log('[helix] stream live, viewers:', s.viewer_count, 'game:', s.game_name);
      return { live: true, viewers: s.viewer_count, game: s.game_name, userId };
    }
    console.log('[helix] stream NOT live');
    return { live: false, userId };
  } catch (e: any) {
    if (e.response?.status === 401) appToken = null;
    return { live: false };
  }
}

// ── State ───────────────────────────────────────────────────────────────────
let manager: BotManager | null = null;
let transcriber: TranscriptionService | null = null;
let learnBot: LearnBot | null = null;
let streamPoll: NodeJS.Timeout | null = null;
let historySaveInterval: NodeJS.Timeout | null = null;
let learnSaveInterval: NodeJS.Timeout | null = null;
let startedBots: string[] = [];
let isStarted = false;
let currentChannel = '';
let saved: SavedConfig = { personas: {}, phraseGroups: {} };
let channelId: string | null = null;

function getLearnDataPath(): string {
  return path.join(DATA_DIR, 'markov-chain.json');
}

async function loadLearnData(): Promise<any> {
  // Try GitHub Repo first
  if (GITHUB_TOKEN && GITHUB_REPO) {
    const githubData = await loadFromGitHubRepo();
    if (githubData) {
      console.log('[learn] Loaded from GitHub Repo:', githubData.messages || 0, 'messages');
      // Also save locally as backup
      try {
        fs.writeFileSync(getLearnDataPath(), JSON.stringify(githubData, null, 2));
      } catch {}
      return githubData;
    }
  }
  
  // Try Legacy Gist (backward compatibility)
  if (GITHUB_TOKEN && MARKOV_GIST_ID) {
    const gistData = await loadFromGitHub();
    if (gistData) {
      console.log('[learn] Loaded from Gist:', gistData.messages || 0, 'messages');
      try { fs.writeFileSync(getLearnDataPath(), JSON.stringify(gistData, null, 2)); } catch {}
      return gistData;
    }
  }
  
  // Fallback to local file
  const p = getLearnDataPath();
  try {
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      console.log('[learn] Loaded', data.messages || 0, 'messages from', p);
      return data;
    }
  } catch (e: any) {
    console.log('[learn] Could not load saved data:', e.message);
  }
  return null;
}

// Track the highest message count we've ever seen — never save below this
let bestMessageCount = 0;

async function saveLearnData(): Promise<void> {
  if (!learnBot) return;
  const data = learnBot.getData();

  // ── Safety guard: never overwrite with less data than we already have ──
  // This protects against: failed GitHub loads, accidental restarts,
  // Railway redeploys during active learning, or API errors on load.
  if (data.messages < bestMessageCount) {
    console.log('[learn] SKIP SAVE — current', data.messages, 'msgs < best known', bestMessageCount, 'msgs. Data loss protection.');
    io.emit('learn:log', '⚠️ Сохранение пропущено — в памяти меньше данных чем сохранено (' + data.messages + ' < ' + bestMessageCount + ')');
    return;
  }
  bestMessageCount = data.messages;

  console.log('[learn] Saving', data.messages, 'messages (best so far:', bestMessageCount, ')');

  // Save locally as backup
  const p = getLearnDataPath();
  try {
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
    console.log('[learn] Saved locally to', p);
  } catch (e: any) {
    console.log('[learn] Local save error:', e.message);
  }

  // Save to GitHub Repo
  if (GITHUB_TOKEN && GITHUB_REPO) {
    const ok = await saveToGitHubRepo(data);
    if (ok) {
      io.emit('learn:log', '✅ Сохранено ' + data.messages + ' сообщений в GitHub');
      return;
    }
    console.log('[github] Repo save failed, trying Gist...');
  }

  // Fallback to Gist (legacy)
  if (GITHUB_TOKEN && MARKOV_GIST_ID) {
    const ok = await saveToGitHub(data);
    if (ok) {
      io.emit('learn:log', '✅ Сохранено в GitHub Gist (' + data.messages + ' сообщений)');
    } else {
      io.emit('learn:log', '❌ Ошибка сохранения в GitHub');
    }
  } else {
    io.emit('learn:log', '⚠️ GitHub не настроен');
  }
}

function loadConfigForChannel(channel: string): SavedConfig {
  currentChannel = channel;
  saved = loadSaved(channel);
  console.log('[config] Loaded for channel:', channel, 'personas:', Object.keys(saved.personas).length, 'phrases:', Object.keys(saved.phraseGroups).length);
  return saved;
}

// ── REST ────────────────────────────────────────────────────────────────────
app.get('/api/transcript', (_req, res) => res.json(manager?.getTranscriptLog()?.slice(-100) || []));
app.get('/api/personas',   (_req, res) => res.json(saved.personas));
app.get('/api/phrases',    (_req, res) => res.json(saved.phraseGroups));
app.get('/api/presence',   (_req, res) => res.json(manager?.getPresenceStatus() || {}));
app.get('/api/points',     (_req, res) => res.json(manager?.getPointsBalances() || {}));
app.post('/api/claim-points', async (_req, res) => {
  if (!manager) return res.json({ error: 'Боты не запущены' });
  await manager.claimAllBonusChests();
  res.json({ ok: true });
});

// ── Socket.IO ───────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('[server] connected', socket.id);
  const cfg = readEnvConfig();
  socket.emit('config', { channel: cfg.channel, botsPerTranscript: saved.botsPerTranscript || 2 });
  socket.emit('personas:update', saved.personas);
  socket.emit('phrases:update', saved.phraseGroups);
  if (isStarted && startedBots.length > 0) {
    socket.emit('bots:started', { bots: startedBots });
    startedBots.forEach(u => socket.emit('bot:status', { username: u, state: 'connected', message: 'Подключён' }));
    if (manager) {
      socket.emit('presence:update', manager.getPresenceStatus());
      socket.emit('points:all', manager.getPointsBalances());
    }
  }

  socket.on('send:manual', async (data: { targets: string[]; message: string }) => {
    if (manager && data.targets?.length && data.message) await manager.sendManual(data.targets, data.message);
  });
  socket.on('set:persona', (data: { username: string; role: string; sys: string }) => {
    const k = data.username.toLowerCase(), cfg2: PersonaConfig = { role: data.role, sys: data.sys };
    saved.personas[k] = cfg2; saveToDisk(saved, currentChannel);
    console.log('[persona] Saved for:', k);
    if (manager) manager.setPersona(data.username, cfg2);
    io.emit('personas:update', saved.personas);
    socket.emit('persona:saved', { username: data.username, ok: true });
  });
  socket.on('del:persona', (data: { username: string }) => {
    delete saved.personas[data.username.toLowerCase()]; saveToDisk(saved, currentChannel);
    io.emit('personas:update', saved.personas);
  });
  socket.on('set:phrases', (data: Record<string, string[]>) => {
    saved.phraseGroups = data; saveToDisk(saved, currentChannel); io.emit('phrases:update', saved.phraseGroups);
  });
  socket.on('set:bots_per_transcript', (data: { n: number }) => {
    const rawN = data.n;
    const n = rawN === 99 ? 99 : Math.max(1, parseInt(String(rawN))) || 2;
    saved.botsPerTranscript = n; saveToDisk(saved, currentChannel);
    if (manager) manager.setBotsPerTranscript(n);
    console.log('[config] Set bots per transcript:', n);
    io.emit('config', { botsPerTranscript: n });
  });
  
  socket.on('get:learn:config', () => {
    const config = readLearnConfig();
    socket.emit('learn:config', { channel: config.channel, tokens: config.tokens.length });
  });
  
  socket.on('learn:setChannel', (data: { channel: string }) => {
    const chan = extractChannel(data.channel || '');
    if (!chan) {
      socket.emit('learn:error', { message: 'Укажите канал' });
      return;
    }
    process.env.LEARN_CHANNEL = chan;
    socket.emit('learn:config', { channel: chan });
    socket.emit('learn:log', 'Канал изменён на ' + chan + ' (перезапустите для применения)');
  });
  
  socket.on('learn:start', async () => {
    const config = readLearnConfig();
    if (!config.channel || !config.tokens.length) {
      socket.emit('learn:error', { message: 'Настройте LEARN_CHANNEL и добавьте ботов BOT1_OAUTH итд' });
      return;
    }

    // ── KEY FIX: never throw away in-memory data ──────────────────────────
    // Stop only the connections (chat + transcription), keep the chain data.
    // If learnBot already exists with data, reuse it — don't create a new one.
    // Only create a new LearnBot if one doesn't exist yet (first ever start).
    if (learnBot) {
      learnBot.stopConnections(); // stops chat/transcription but keeps chain
    } else {
      learnBot = new LearnBot((e, d) => io.emit(e, d));
      // Fresh instance — load from GitHub
      const savedData = await loadLearnData();
      if (savedData) {
        learnBot.loadData(savedData);
        bestMessageCount = Math.max(bestMessageCount, savedData.messages || 0);
        io.emit('learn:log', '✅ Загружено ' + savedData.messages + ' сообщений');
      } else {
        io.emit('learn:log', '⚠️ Сохранённых данных нет — начинаем с нуля');
      }
    }

    // Auto-save every 15 minutes
    if (learnSaveInterval) clearInterval(learnSaveInterval);
    learnSaveInterval = setInterval(() => {
      saveLearnData();
    }, 900000);

    try {
      await learnBot.start(config.channel, config.tokens, config.groqKey, config.language, config.learnChunkSecs);
      socket.emit('learn:started', { ok: true });
      const stats = learnBot.getStats();
      io.emit('learn:log', '▶ Обучение на канале ' + config.channel + ' | уже накоплено: ' + stats.messages + ' сообщений');
    } catch (e: any) {
      socket.emit('learn:error', { message: e.message });
    }
  });

  socket.on('learn:stop', () => {
    if (learnBot) {
      saveLearnData();          // сохранить на GitHub
      learnBot.stopConnections(); // отключить чат/транскрипцию, НЕ удалять данные
      // learnBot остаётся в памяти с накопленными данными!
    }
    if (learnSaveInterval) { clearInterval(learnSaveInterval); learnSaveInterval = null; }
    io.emit('learn:log', '⏸ Обучение остановлено. Данные сохранены и остаются в памяти.');
  });

  socket.on('learn:getData', () => {
    if (learnBot) {
      socket.emit('learn:data', learnBot.getData());
    }
  });

  socket.on('learn:generate', () => {
    if (learnBot) {
      const previews = learnBot.generatePreview(5);
      socket.emit('learn:previews', previews);
    }
  });

  socket.on('learn:save', async () => {
    if (learnBot) {
      // Save locally
      const filepath = path.join(DATA_DIR, 'markov-' + Date.now() + '.json');
      const data = learnBot.getData();
      fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
      io.emit('learn:log', 'Сохранено локально: ' + path.basename(filepath));
      
      // Save to GitHub Repo (not Gist)
      console.log('[github] Manual save to GitHub Repo...');
      if (GITHUB_TOKEN && GITHUB_REPO) {
        const ok = await saveToGitHubRepo(data);
        if (ok) {
          io.emit('learn:log', '✅ Сохранено в GitHub Repo');
        } else {
          io.emit('learn:log', '❌ Ошибка сохранения');
        }
      } else {
        io.emit('learn:log', '⚠️ GitHub Repo не настроен');
      }
    }
  });
  
  socket.on('get:personas', () => socket.emit('personas:update', saved.personas));
  socket.on('get:phrases',  () => socket.emit('phrases:update', saved.phraseGroups));
  socket.on('claim:points', async () => {
    if (manager) await manager.claimAllBonusChests();
    socket.emit('points:claimed_all', { ok: true });
  });
  socket.on('disconnect', () => console.log('[server] disconnected', socket.id));
});

// ── Auto-start ───────────────────────────────────────────────────────────────
async function autoStart(): Promise<void> {
  const cfg = readEnvConfig();
  console.log('[server] channel="' + cfg.channel + '" bots=' + cfg.bots.length + ' groq=' + (cfg.groqKey ? 'OK' : 'MISSING'));
  if (!cfg.channel || !cfg.groqKey || !cfg.bots.length) { console.warn('[server] missing config'); return; }
  
  // Load config for this specific channel
  loadConfigForChannel(cfg.channel);

  if (manager) { await manager.stop(); manager = null; }
  if (transcriber) { transcriber.stop(); transcriber = null; }
  await new Promise(r => setTimeout(r, 1500));

  const info = await getStreamData(cfg.channel);
  channelId = (info as any).userId || null;
  console.log('[server] channelId=' + channelId + ' live=' + info.live);

  // Initialize learnBot with saved data (without starting it)
  const learnConfig = readLearnConfig();
  if (learnConfig.channel && learnConfig.tokens.length > 0) {
    if (!learnBot) {
      learnBot = new LearnBot((e, d) => io.emit(e, d));
    }
    const savedData = await loadLearnData();
    if (savedData) {
      learnBot.loadData(savedData);
      bestMessageCount = Math.max(bestMessageCount, savedData.messages || 0);
      console.log('[server] Loaded learn data:', savedData.messages, 'messages (bestMessageCount:', bestMessageCount, ')');
    }
    io.emit('learn:config', { channel: learnConfig.channel });
    io.emit('learn:status', learnBot.getStats());
  }

  manager = new BotManager(
    cfg.bots, cfg.channel, cfg.groqKey,
    {
      language: cfg.language, context: cfg.context,
      settings: { useEmoji: true, chatContext: true },
      savedPersonas: saved.personas,
      botsPerTranscript: saved.botsPerTranscript || 2,
      channelId: channelId || undefined,
      clientId: process.env.TWITCH_CLIENT_ID?.trim(),
      savedHistory: saved.botHistories || {},
      savedTranscriptHistory: saved.transcriptHistory || [],
      savedRealChatHistory: saved.realChatHistory || [],
      learnBot: learnBot,
      currentGame: (info as any).game || '',
    },
    (event, data) => {
      io.emit(event, data);
      if (event === 'presence:active' && manager) io.emit('presence:update', manager.getPresenceStatus());
      if (event === 'points:balance') io.emit('points:all', manager?.getPointsBalances() || {});
      
      // Save history periodically
      if (event === 'transcript:entry' || event === 'bot:message') {
        const hist = manager?.getHistoryForSave();
        if (hist) {
          saved.botHistories = hist.histories;
          saved.transcriptHistory = hist.transcripts;
          saved.realChatHistory = hist.realChat;
          // Debounced save will happen automatically when config changes
        }
      }
    }
  );

  startedBots = manager.getUsernames();
  isStarted = true;
  io.emit('bots:started', { bots: startedBots });
  console.log('[server] started', startedBots.length, 'bots');
  
// Send greetings from all bots with delay
  console.log('[server] Scheduling greetings for', startedBots.length, 'bots...');
  for (let i = 0; i < startedBots.length; i++) {
    const botName = startedBots[i];
    const delay = 5000 + i * 30000;
    setTimeout(() => {
      if (manager && botName) {
        const greetings = ['ку', 'привет', 'дарова', 'всем привет'];
        const greeting = greetings[Math.floor(Math.random() * greetings.length)];
        manager.sendManual([botName], greeting);
        console.log('[server] Greeting:', botName, greeting);
      }
    }, delay);
  }

  // Start transcription
  transcriber = new TranscriptionService(cfg.groqKey, cfg.channel);
  transcriber.start((result) => {
    console.log('[transcription] TEXT:', result.text.slice(0, 100));
    io.emit('transcription:new', { text: result.text, timestamp: result.timestamp });
    if (manager) manager.onTranscription(result.text);
  });

  io.emit('stream:info', { live: info.live, game: (info as any).game, viewers: (info as any).viewers });

  if (streamPoll) clearInterval(streamPoll);
  streamPoll = setInterval(async () => {
    const si = await getStreamData(cfg.channel);
    if ((si as any).userId && !channelId) channelId = (si as any).userId;
    io.emit('stream:info', { live: si.live, game: (si as any).game, viewers: (si as any).viewers });
    if ((si as any).viewers != null) io.emit('stream:viewers', { viewers: (si as any).viewers });
    if (manager && (si as any).game) manager.setGame((si as any).game);
  }, 30000);

  // Save history every 10 minutes - save EVERYTHING
  const historySaveInterval = setInterval(() => {
    if (manager) {
      const hist = manager.getHistoryForSave();
      saved.botHistories = hist.histories;
      saved.transcriptHistory = hist.transcripts;
      saved.realChatHistory = hist.realChat;
      console.log('[history] FULL SAVE, bots:', Object.keys(hist.histories).length, 'transcripts:', hist.transcripts.length, 'chat:', hist.realChat.length);
    }
    saveToDisk(saved, currentChannel);
    console.log('[history] Saved to disk');
  }, 600000);
}

http.listen(PORT, () => {
  console.log('\nTwitchBoost at http://localhost:' + PORT + '\n');
  
    const token = process.env.GITHUB_TOKEN?.trim();
    const gistId = process.env.MARKOV_GIST_ID?.trim();
    const repo = process.env.GITHUB_REPO?.trim();
    
    if (token && (gistId || repo)) {
      console.log('[github] ✓ GitHub configured (token len:', token.length, ')');
    } else {
      console.log('[github] ✗ GITHUB_TOKEN or GITHUB_REPO not set');
      console.log('[github] GITHUB_TOKEN:', token ? 'set' : 'not set');
      console.log('[github] GITHUB_REPO:', repo ? 'set' : 'not set');
    }
  
  setTimeout(autoStart, 1500);
});
process.on('SIGTERM', async () => {
  console.log('[server] Saving history before exit...');
  if (manager) {
    const hist = manager.getHistoryForSave();
    saved.botHistories = hist.histories;
    saved.transcriptHistory = hist.transcripts;
    saved.realChatHistory = hist.realChat;
    saveToDisk(saved, currentChannel);
  }
  if (streamPoll) clearInterval(streamPoll);
  if (transcriber) transcriber.stop();
  if (manager) await manager.stop();
  process.exit(0);
});
