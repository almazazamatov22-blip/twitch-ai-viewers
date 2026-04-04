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

const DEFAULT_PHRASES: Record<string, string[]> = {
  'Приветствия': ['Привет стрим!', 'О, живой!', 'Хей!', 'Здарова!'],
  'Реакции': ['ЛОООЛ', 'ахахах', 'ну ты дал', 'топ момент', 'КЛАссс'],
  'Вопросы': ['какая игра?', 'что играем?', 'сколько часов уже?'],
};

function loadPhrases(): Record<string, string[]> {
  try { if (fs.existsSync(PHRASES_FILE)) return JSON.parse(fs.readFileSync(PHRASES_FILE, 'utf-8')); }
  catch (_) {}
  return JSON.parse(JSON.stringify(DEFAULT_PHRASES));
}
function savePhrases(g: Record<string, string[]>) {
  try { fs.writeFileSync(PHRASES_FILE, JSON.stringify(g, null, 2)); } catch (_) {}
}

function getChannelName(): string {
  const ch = process.env.TWITCH_CHANNEL || '';
  return ch.includes('twitch.tv/') ? ch.split('twitch.tv/')[1].split('/')[0].split('?')[0] : ch;
}

// Get bot's IRC OAuth token (always available)
function getIRCToken(botIndex: number): string {
  return (process.env[`BOT${botIndex + 1}_OAUTH_TOKEN`] || process.env[`BOT${botIndex + 1}_OAUTH`] || '')
    .replace(/^oauth:/i, '');
}

// GQL anonymous headers
const GQL = {
  'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Origin': 'https://www.twitch.tv',
  'Referer': 'https://www.twitch.tv/',
};

async function getChannelId(channelName: string): Promise<string> {
  const resp = await axios.post('https://gql.twitch.tv/gql',
    { query: `{ user(login: "${channelName}") { id } }` },
    { headers: GQL, timeout: 10000 }
  );
  const id = resp.data?.data?.user?.id;
  if (!id) throw new Error(`Channel "${channelName}" not found`);
  return id;
}

// Follow using IRC token (twitchapps.com tokens are valid Twitch OAuth tokens)
async function followWithToken(token: string, clientId: string, broadcasterId: string): Promise<void> {
  const cleanToken = token.replace(/^oauth:/i, '').trim();
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
      'Client-ID': clientId,
      'Authorization': `OAuth ${cleanToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Origin': 'https://www.twitch.tv',
      'Referer': 'https://www.twitch.tv/',
    }
  });
  const errors = resp.data?.[0]?.errors;
  if (errors?.length) throw new Error(errors[0].message);
  logger.info('Follow OK:', JSON.stringify(resp.data?.[0]?.data));
}

// Runtime token storage (from /auth OAuth flow, persists until restart)
const runtimeTokens: Record<number, string> = {};

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
  const viewers: Record<number, ViewerSimulator> = {};

  logger.info(`Storage: ${DATA_DIR} | Phrases: ${PHRASES_FILE}`);

  // ── Status ─────────────────────────────────────
  app.get('/api/status', (_req, res) => {
    res.json({
      channel: process.env.TWITCH_CHANNEL,
      bots: bots.map((bot, i) => ({
        username: bot.getUsername?.() || `Bot${i + 1}`,
        connected: bot.isBotConnected?.() || false,
        enabled: botStates[i] ?? true,
        watching: !!viewers[i]?.running,
        hasIRCToken: !!getIRCToken(i),
        hasUserToken: !!runtimeTokens[i],
        index: i,
      })),
      channelInfo: aiService.currentChannelInfo,
      phraseGroups,
    });
  });

  // ── OAuth flow for better follow token ───────────
  app.get('/auth', (req, res) => {
    const botIdx = parseInt(String(req.query.bot || '0'));
    const host = req.headers.host || 'localhost';
    const proto = host.includes('localhost') ? 'http' : 'https';
    const redirectUri = `${proto}://${host}/auth/callback`;
    const scope = 'user:edit:follows user:read:email channel:read:subscriptions';
    const url = `https://id.twitch.tv/oauth2/authorize?client_id=${process.env.TWITCH_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent(scope)}&state=${botIdx}&force_verify=true`;
    res.redirect(url);
  });

  app.get('/auth/callback', (_req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Auth</title>
<style>body{background:#0e0e10;color:#efeff1;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px;margin:0}.ok{color:#00c853;font-size:20px}.err{color:#e53935}</style></head><body>
<div id="msg">Авторизация...</div>
<script>
const p=new URLSearchParams(window.location.hash.substring(1));
const t=p.get('access_token'),s=p.get('state')||'0',m=document.getElementById('msg');
if(t){
  fetch('/auth/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t,botIndex:parseInt(s)})})
  .then(r=>r.json()).then(d=>{
    m.innerHTML=d.ok?'<span class="ok">✓ Авторизован: '+d.botName+'</span><br><small style="opacity:.6">Закрой окно и нажми ♥</small>':'<span class="err">'+d.error+'</span>';
  });
}else{m.innerHTML='<span class="err">'+(p.get('error_description')||'Нет токена')+'</span>';}
</script></body></html>`);
  });

  app.post('/auth/save', async (req, res) => {
    const { token, botIndex = 0 } = req.body;
    if (!token) return res.status(400).json({ error: 'No token' });
    try {
      const meResp = await axios.get('https://api.twitch.tv/helix/users', {
        headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID!, 'Authorization': `Bearer ${token}` }
      });
      const username = meResp.data.data[0]?.login;
      if (!username) throw new Error('Token invalid');
      const idx = parseInt(String(botIndex));
      runtimeTokens[idx] = token;
      logger.info(`Auth token saved for bot[${idx}] = ${username}`);
      io.emit('bot-state', {});
      res.json({ ok: true, botName: username });
    } catch (e: any) {
      res.status(500).json({ error: e?.response?.data?.message || e?.message || 'Failed' });
    }
  });

  // ── Follow (tries user token first, then IRC token) ──
  app.post('/api/follow', async (req, res) => {
    const idx = parseInt(String(req.body.botIndex || 0));
    const botName = bots[idx]?.getUsername?.() || `Bot${idx + 1}`;
    let lastErr = 'No tokens available';

    try {
      const broadcasterId = await getChannelId(getChannelName());
      
      // Try 1: user token from /auth flow (uses our app's client ID)
      if (runtimeTokens[idx]) {
        try {
          await followWithToken(runtimeTokens[idx], process.env.TWITCH_CLIENT_ID!, broadcasterId);
          logger.info(`${botName} followed via user token`);
          return res.json({ ok: true, botName });
        } catch (e: any) { lastErr = e?.message; logger.warn(`User token follow failed: ${lastErr}`); }
      }

      // Try 2: IRC token with twitchapps client ID (q6batx0epp608isickayubi39itsckt)
      const ircToken = getIRCToken(idx);
      if (ircToken) {
        try {
          await followWithToken(ircToken, 'q6batx0epp608isickayubi39itsckt', broadcasterId);
          logger.info(`${botName} followed via IRC token + twitchapps clientId`);
          return res.json({ ok: true, botName });
        } catch (e: any) { lastErr = e?.message; logger.warn(`IRC+twitchapps failed: ${lastErr}`); }

        // Try 3: IRC token with Twitch web client ID
        try {
          await followWithToken(ircToken, 'kimne78kx3ncx6brgo4mv6wki5h1ko', broadcasterId);
          logger.info(`${botName} followed via IRC token + Twitch web clientId`);
          return res.json({ ok: true, botName });
        } catch (e: any) { lastErr = e?.message; logger.warn(`IRC+twitch-web failed: ${lastErr}`); }
      }

      // All failed - suggest /auth
      const host = req.headers.host;
      res.status(401).json({ 
        error: lastErr, 
        hint: `Авторизуй бота: нажми 🔑 у ${botName}`,
        authUrl: `https://${host}/auth?bot=${idx}`
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message });
    }
  });

  app.post('/api/follow-all', async (_req, res) => {
    const results: any[] = [];
    let broadcasterId = '';
    try { broadcasterId = await getChannelId(getChannelName()); }
    catch (e) { return res.status(500).json({ error: 'Could not get channel ID' }); }

    for (let i = 0; i < bots.length; i++) {
      const botName = bots[i]?.getUsername?.() || `Bot${i + 1}`;
      let ok = false;
      let lastErr = 'no tokens';
      
      // Try user token first
      if (runtimeTokens[i]) {
        try { await followWithToken(runtimeTokens[i], process.env.TWITCH_CLIENT_ID!, broadcasterId); ok=true; }
        catch (e: any) { lastErr = e?.message; }
      }
      if (!ok) {
        const irc = getIRCToken(i);
        if (irc) {
          for (const cid of ['q6batx0epp608isickayubi39itsckt', 'kimne78kx3ncx6brgo4mv6wki5h1ko']) {
            try { await followWithToken(irc, cid, broadcasterId); ok=true; break; }
            catch (e: any) { lastErr = e?.message; }
          }
        }
      }
      results.push({ botName, ok, error: ok ? undefined : lastErr });
      if (ok) await new Promise(r => setTimeout(r, 800));
    }
    res.json({ results });
  });

  // ── Watch ───────────────────────────────────────
  app.post('/api/watch', async (req, res) => {
    const idx = parseInt(String(req.body.botIndex || 0));
    const botName = bots[idx]?.getUsername?.() || `Bot${idx + 1}`;
    if (viewers[idx]?.running) {
      viewers[idx].stop(); delete viewers[idx];
      io.emit('viewer-state', { botIndex: idx, watching: false });
      return res.json({ ok: true, watching: false, botName });
    }
    try {
      if (viewers[idx]) { viewers[idx].stop(); delete viewers[idx]; }
      const sim = new ViewerSimulator(getChannelName());
      await sim.start();
      viewers[idx] = sim;
      io.emit('viewer-state', { botIndex: idx, watching: true });
      res.json({ ok: true, watching: true, botName });
    } catch (e: any) {
      res.status(500).json({ error: e?.message });
    }
  });

  app.post('/api/watch-all', async (_req, res) => {
    const results: any[] = [];
    for (let i = 0; i < bots.length; i++) {
      const botName = bots[i]?.getUsername?.() || `Bot${i + 1}`;
      if (viewers[i]?.running) { results.push({ botName, ok: true, already: true }); continue; }
      try {
        if (viewers[i]) { viewers[i].stop(); delete viewers[i]; }
        const sim = new ViewerSimulator(getChannelName());
        await sim.start();
        viewers[i] = sim;
        io.emit('viewer-state', { botIndex: i, watching: true });
        results.push({ botName, ok: true });
        await new Promise(r => setTimeout(r, 1200));
      } catch (e: any) {
        results.push({ botName, ok: false, error: e?.message });
      }
    }
    res.json({ results });
  });

  // ── Messages ────────────────────────────────────
  function emitSend(message: string, idx: number) {
    aiService.emit(`manualMessage_${idx}`, message);
    io.emit('bot-sent', {
      message, botIndex: idx,
      botName: bots[idx]?.getUsername?.() || `Bot${idx + 1}`,
      manual: true, time: Date.now()
    });
  }

  app.post('/api/send', (req, res) => {
    const { message, botIndex = 0 } = req.body;
    if (!message) return res.status(400).json({ error: 'No message' });
    emitSend(message, parseInt(String(botIndex)) || 0);
    res.json({ ok: true });
  });
  app.post('/api/phrase/random', (req, res) => {
    const { group, botIndex = 0 } = req.body;
    const phrases = phraseGroups[group];
    if (!phrases?.length) return res.status(404).json({ error: 'Group not found' });
    const phrase = phrases[Math.floor(Math.random() * phrases.length)];
    emitSend(phrase, parseInt(String(botIndex)) || 0);
    res.json({ ok: true, phrase });
  });
  app.post('/api/phrase/exact', (req, res) => {
    const { phrase, botIndex = 0 } = req.body;
    if (!phrase) return res.status(400).json({ error: 'No phrase' });
    emitSend(phrase, parseInt(String(botIndex)) || 0);
    res.json({ ok: true });
  });

  // ── Phrase CRUD ─────────────────────────────────
  app.post('/api/phrases/add', (req, res) => {
    const { group, phrase } = req.body;
    if (!group || !phrase) return res.status(400).json({ error: 'Missing' });
    if (!phraseGroups[group]) phraseGroups[group] = [];
    phraseGroups[group].push(phrase); savePhrases(phraseGroups);
    io.emit('phrases-updated', phraseGroups); res.json({ ok: true });
  });
  app.post('/api/phrases/delete', (req, res) => {
    const { group, phrase } = req.body;
    if (!phraseGroups[group]) return res.status(404).json({ error: 'Not found' });
    phraseGroups[group] = phraseGroups[group].filter(p => p !== phrase);
    if (!phraseGroups[group].length) delete phraseGroups[group];
    savePhrases(phraseGroups); io.emit('phrases-updated', phraseGroups); res.json({ ok: true });
  });
  app.post('/api/phrases/rename-group', (req, res) => {
    const { oldName, newName } = req.body;
    if (!phraseGroups[oldName] || !newName) return res.status(400).json({ error: 'Invalid' });
    phraseGroups[newName] = phraseGroups[oldName]; delete phraseGroups[oldName];
    savePhrases(phraseGroups); io.emit('phrases-updated', phraseGroups); res.json({ ok: true });
  });
  app.post('/api/phrases/delete-group', (req, res) => {
    const { group } = req.body;
    if (!phraseGroups[group]) return res.status(404).json({ error: 'Not found' });
    delete phraseGroups[group]; savePhrases(phraseGroups);
    io.emit('phrases-updated', phraseGroups); res.json({ ok: true });
  });
  app.post('/api/toggle-bot', (req, res) => {
    const { botIndex } = req.body; const bot = bots[botIndex];
    if (!bot) return res.status(404).json({ error: 'Not found' });
    botStates[botIndex] = !botStates[botIndex];
    botStates[botIndex] ? bot.connect?.() : bot.disconnect?.();
    io.emit('bot-state', { botIndex, enabled: botStates[botIndex] });
    res.json({ ok: true, enabled: botStates[botIndex] });
  });

  // ── Events ──────────────────────────────────────
  aiService.on('incomingChat', (d: any) => io.emit('incoming-chat', d));
  // AI messages handled by round-robin in main.ts - dashboard gets bot-sent when actually sent
  aiService.on('transcription', (text: string) => io.emit('transcription', { text, time: Date.now() }));

  const PORT = parseInt(process.env.PORT || '3000');
  httpServer.listen(PORT, () => logger.info(`Dashboard at port ${PORT}`));
  return { app, io };
}
