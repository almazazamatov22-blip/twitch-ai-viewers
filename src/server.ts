import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import { AIService } from './ai';
import { ViewerSimulator } from './viewer';
import { logger } from './logger';

const DATA_DIR = fs.existsSync('/data') ? '/data' : '/tmp';
const PHRASES_FILE = path.join(DATA_DIR, 'phrases.json');
const TOKENS_FILE = path.join(DATA_DIR, 'user_tokens.json');

const DEFAULT_PHRASES: Record<string, string[]> = {
  'Приветствия': ['Привет стрим!', 'О, живой!', 'Хей!', 'Здарова!'],
  'Реакции': ['ЛОООЛ', 'ахахах', 'ну ты дал', 'топ момент', 'КЛАссс'],
  'Вопросы': ['какая игра?', 'что играем?', 'сколько часов уже?'],
};

function loadPhrases(): Record<string, string[]> {
  try {
    if (fs.existsSync(PHRASES_FILE)) return JSON.parse(fs.readFileSync(PHRASES_FILE, 'utf-8'));
  } catch (_) {}
  return JSON.parse(JSON.stringify(DEFAULT_PHRASES));
}
function savePhrases(g: Record<string, string[]>) {
  try { fs.writeFileSync(PHRASES_FILE, JSON.stringify(g, null, 2)); } catch (_) {}
}

// Store user-level tokens (with follow scope) per bot username
function loadTokens(): Record<string, string> {
  try {
    if (fs.existsSync(TOKENS_FILE)) return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
  } catch (_) {}
  return {};
}
function saveTokens(t: Record<string, string>) {
  try { fs.writeFileSync(TOKENS_FILE, JSON.stringify(t)); } catch (_) {}
}

function getChannelName(): string {
  const ch = process.env.TWITCH_CHANNEL || '';
  return ch.includes('twitch.tv/') ? ch.split('twitch.tv/')[1].split('/')[0].split('?')[0] : ch;
}

// GQL anonymous headers
const GQL_HEADERS = {
  'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

async function getChannelId(channelName: string): Promise<string> {
  const resp = await axios.post('https://gql.twitch.tv/gql',
    { query: `{ user(login: "${channelName}") { id } }` },
    { headers: GQL_HEADERS }
  );
  const id = resp.data?.data?.user?.id;
  if (!id) throw new Error('Channel not found via GQL');
  return id;
}

async function followViaGQL(userToken: string, broadcasterId: string): Promise<void> {
  const resp = await axios.post('https://gql.twitch.tv/gql', [{
    operationName: 'FollowButton_FollowUser',
    variables: { input: { targetID: broadcasterId, disableNotifications: false } },
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: '800e7346bdf7e5278a3c1d3f21b2b56e2639928f86815677a7126b715d7e4a23'
      }
    }
  }], {
    headers: {
      ...GQL_HEADERS,
      'Authorization': `OAuth ${userToken}`
    }
  });
  const errors = resp.data?.[0]?.errors;
  if (errors?.length) throw new Error(errors[0].message);
}

export function startDashboardServer(aiService: AIService, bots: any[]) {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, { cors: { origin: '*' } });

  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));

  const botStates: Record<number, boolean> = {};
  bots.forEach((_, i) => { botStates[i] = true; });
  const phraseGroups = loadPhrases();
  const userTokens = loadTokens();
  const viewers: Record<number, ViewerSimulator> = {};

  logger.info(`Phrases: ${PHRASES_FILE}, Tokens: ${TOKENS_FILE}`);

  // ── Status ──────────────────────────────────────
  app.get('/api/status', (_req, res) => {
    res.json({
      channel: process.env.TWITCH_CHANNEL,
      bots: bots.map((bot, i) => ({
        username: bot.getUsername?.() || `Bot${i + 1}`,
        connected: bot.isBotConnected?.() || false,
        enabled: botStates[i] ?? true,
        watching: !!viewers[i],
        hasUserToken: !!userTokens[bot.getUsername?.()?.toLowerCase() || ''],
        index: i,
      })),
      channelInfo: aiService.currentChannelInfo,
      phraseGroups,
      storageOk: DATA_DIR === '/data'
    });
  });

  // ── OAuth callback for bot user tokens ──────────
  // User visits /auth?bot=0 → redirected to Twitch OAuth → callback saves token
  app.get('/auth', (req, res) => {
    const botIdx = parseInt(String(req.query.bot || '0'));
    const clientId = process.env.TWITCH_CLIENT_ID!;
    const port = process.env.PORT || '3000';
    const host = req.headers.host || `localhost:${port}`;
    const redirectUri = `https://${host}/auth/callback`;
    const scope = 'user:edit:follows user:read:email';
    const state = String(botIdx);
    const url = `https://id.twitch.tv/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent(scope)}&state=${state}`;
    res.redirect(url);
  });

  // Token comes back as fragment (#access_token=...) — handle via a small HTML page
  app.get('/auth/callback', (_req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Auth</title></head><body>
<p>Авторизация...</p>
<script>
const hash = window.location.hash.substring(1);
const params = new URLSearchParams(hash);
const token = params.get('access_token');
const state = params.get('state');
if (token) {
  fetch('/auth/save', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ token, botIndex: parseInt(state||'0') }) })
  .then(r=>r.json()).then(d=>{
    document.body.innerHTML = d.ok
      ? '<p style="color:green;font-size:20px">✓ Токен сохранён для ' + d.botName + '. Закрой эту вкладку.</p>'
      : '<p style="color:red">Ошибка: ' + d.error + '</p>';
  });
} else {
  document.body.innerHTML = '<p style="color:red">Не получен токен. Попробуй ещё раз.</p>';
}
</script></body></html>`);
  });

  app.post('/auth/save', async (req, res) => {
    const { token, botIndex } = req.body;
    if (!token) return res.status(400).json({ error: 'No token' });
    const idx = parseInt(String(botIndex)) || 0;

    try {
      // Verify token and get username
      const meResp = await axios.get('https://api.twitch.tv/helix/users', {
        headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID!, 'Authorization': `Bearer ${token}` }
      });
      const username = meResp.data.data[0]?.login;
      if (!username) throw new Error('Could not get username from token');

      userTokens[username] = token;
      saveTokens(userTokens);
      logger.info(`Saved user token for ${username} (bot[${idx}])`);
      io.emit('bot-state', {});
      res.json({ ok: true, botName: username });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'Failed' });
    }
  });

  // ── Follow ───────────────────────────────────────
  app.post('/api/follow', async (req, res) => {
    const { botIndex = 0 } = req.body;
    const idx = parseInt(String(botIndex));
    const botName = bots[idx]?.getUsername?.()?.toLowerCase() || '';
    const token = userTokens[botName];

    if (!token) {
      const host = req.headers.host;
      return res.status(400).json({
        error: 'Нет токена',
        authUrl: `https://${host}/auth?bot=${idx}`
      });
    }

    try {
      const broadcasterId = await getChannelId(getChannelName());
      await followViaGQL(token, broadcasterId);
      logger.info(`Bot ${botName} followed ${getChannelName()}`);
      res.json({ ok: true, botName });
    } catch (e: any) {
      // Token might be expired
      if (e?.response?.status === 401) {
        delete userTokens[botName];
        saveTokens(userTokens);
        const host = req.headers.host;
        return res.status(401).json({
          error: 'Токен устарел, нужно переавторизоваться',
          authUrl: `https://${host}/auth?bot=${idx}`
        });
      }
      res.status(500).json({ error: e?.message || 'Follow failed' });
    }
  });

  app.post('/api/follow-all', async (req, res) => {
    const results: any[] = [];
    let broadcasterId = '';
    try { broadcasterId = await getChannelId(getChannelName()); }
    catch (e) { return res.status(500).json({ error: 'Could not get channel ID' }); }

    for (let i = 0; i < bots.length; i++) {
      const botName = bots[i]?.getUsername?.()?.toLowerCase() || '';
      const token = userTokens[botName];
      if (!token) {
        results.push({ botName, ok: false, error: 'Нет токена — нажми ♥ для авторизации' });
        continue;
      }
      try {
        await followViaGQL(token, broadcasterId);
        results.push({ botName, ok: true });
        await new Promise(r => setTimeout(r, 600));
      } catch (e: any) {
        results.push({ botName, ok: false, error: e?.message });
      }
    }
    res.json({ results });
  });

  // ── Watch (viewer sim) ───────────────────────────
  app.post('/api/watch', async (req, res) => {
    const { botIndex = 0 } = req.body;
    const idx = parseInt(String(botIndex));
    const botName = bots[idx]?.getUsername?.() || `Bot${idx+1}`;

    if (viewers[idx]) {
      viewers[idx].stop();
      delete viewers[idx];
      io.emit('viewer-state', { botIndex: idx, watching: false });
      return res.json({ ok: true, watching: false, botName });
    }

    try {
      const sim = new ViewerSimulator(getChannelName());
      await sim.start();
      viewers[idx] = sim;
      io.emit('viewer-state', { botIndex: idx, watching: true });
      res.json({ ok: true, watching: true, botName });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'Could not start viewer' });
    }
  });

  app.post('/api/watch-all', async (_req, res) => {
    const results: any[] = [];
    for (let i = 0; i < bots.length; i++) {
      if (viewers[i]) { results.push({ botName: bots[i]?.getUsername(), ok: true, already: true }); continue; }
      try {
        const sim = new ViewerSimulator(getChannelName());
        await sim.start();
        viewers[i] = sim;
        results.push({ botName: bots[i]?.getUsername(), ok: true });
        io.emit('viewer-state', { botIndex: i, watching: true });
        await new Promise(r => setTimeout(r, 1000));
      } catch (e: any) {
        results.push({ botName: bots[i]?.getUsername(), ok: false, error: e?.message });
      }
    }
    res.json({ results });
  });

  // ── Phrases ───────────────────────────────────────
  app.post('/api/send', (req, res) => {
    const { message, botIndex = 0 } = req.body;
    if (!message) return res.status(400).json({ error: 'No message' });
    const idx = parseInt(String(botIndex)) || 0;
    aiService.emit(`manualMessage_${idx}`, message);
    io.emit('bot-sent', { message, botIndex: idx, botName: bots[idx]?.getUsername?.() || `Bot${idx+1}`, manual: true, time: Date.now() });
    res.json({ ok: true });
  });

  app.post('/api/phrase/random', (req, res) => {
    const { group, botIndex = 0 } = req.body;
    const phrases = phraseGroups[group];
    if (!phrases?.length) return res.status(404).json({ error: 'Group not found' });
    const phrase = phrases[Math.floor(Math.random() * phrases.length)];
    const idx = parseInt(String(botIndex)) || 0;
    aiService.emit(`manualMessage_${idx}`, phrase);
    io.emit('bot-sent', { message: phrase, botIndex: idx, botName: bots[idx]?.getUsername?.() || `Bot${idx+1}`, manual: true, time: Date.now() });
    res.json({ ok: true, phrase });
  });

  app.post('/api/phrase/exact', (req, res) => {
    const { phrase, botIndex = 0 } = req.body;
    if (!phrase) return res.status(400).json({ error: 'No phrase' });
    const idx = parseInt(String(botIndex)) || 0;
    aiService.emit(`manualMessage_${idx}`, phrase);
    io.emit('bot-sent', { message: phrase, botIndex: idx, botName: bots[idx]?.getUsername?.() || `Bot${idx+1}`, manual: true, time: Date.now() });
    res.json({ ok: true });
  });

  app.post('/api/phrases/add', (req, res) => {
    const { group, phrase } = req.body; if (!group || !phrase) return res.status(400).json({ error: 'Missing' });
    if (!phraseGroups[group]) phraseGroups[group] = [];
    phraseGroups[group].push(phrase); savePhrases(phraseGroups);
    io.emit('phrases-updated', phraseGroups); res.json({ ok: true });
  });
  app.post('/api/phrases/delete', (req, res) => {
    const { group, phrase } = req.body; if (!phraseGroups[group]) return res.status(404).json({ error: 'Not found' });
    phraseGroups[group] = phraseGroups[group].filter(p => p !== phrase);
    if (!phraseGroups[group].length) delete phraseGroups[group];
    savePhrases(phraseGroups); io.emit('phrases-updated', phraseGroups); res.json({ ok: true });
  });
  app.post('/api/phrases/rename-group', (req, res) => {
    const { oldName, newName } = req.body; if (!phraseGroups[oldName] || !newName) return res.status(400).json({ error: 'Invalid' });
    phraseGroups[newName] = phraseGroups[oldName]; delete phraseGroups[oldName];
    savePhrases(phraseGroups); io.emit('phrases-updated', phraseGroups); res.json({ ok: true });
  });
  app.post('/api/phrases/delete-group', (req, res) => {
    const { group } = req.body; if (!phraseGroups[group]) return res.status(404).json({ error: 'Not found' });
    delete phraseGroups[group]; savePhrases(phraseGroups); io.emit('phrases-updated', phraseGroups); res.json({ ok: true });
  });
  app.post('/api/toggle-bot', (req, res) => {
    const { botIndex } = req.body; const bot = bots[botIndex];
    if (!bot) return res.status(404).json({ error: 'Not found' });
    botStates[botIndex] = !botStates[botIndex];
    botStates[botIndex] ? bot.connect?.() : bot.disconnect?.();
    io.emit('bot-state', { botIndex, enabled: botStates[botIndex] });
    res.json({ ok: true, enabled: botStates[botIndex] });
  });

  // ── Events ────────────────────────────────────────
  aiService.on('incomingChat', (data: any) => io.emit('incoming-chat', data));
  aiService.on('message', (message: string) => {
    io.emit('bot-sent', { message, botIndex: 0, botName: bots[0]?.getUsername?.() || 'Бот', manual: false, time: Date.now() });
  });
  aiService.on('transcription', (text: string) => io.emit('transcription', { text, time: Date.now() }));

  const PORT = parseInt(process.env.PORT || '3000');
  httpServer.listen(PORT, () => logger.info(`Dashboard at port ${PORT}`));
  return { app, io };
}
