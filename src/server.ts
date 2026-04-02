import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { AIService } from './ai';
import { logger } from './logger';

const PHRASES_FILE = path.join('/tmp', 'phrases.json');

const DEFAULT_PHRASES: Record<string, string[]> = {
  'Приветствия': ['Привет стрим!', 'О, живой!', 'Хей!', 'Здарова!'],
  'Реакции': ['ЛОООЛ', 'ахахах', 'ну ты дал', 'топ момент', 'КЛАссс'],
  'Вопросы': ['какая игра?', 'что играем?', 'сколько часов уже?'],
};

function loadPhrases(): Record<string, string[]> {
  try {
    if (fs.existsSync(PHRASES_FILE)) {
      const data = JSON.parse(fs.readFileSync(PHRASES_FILE, 'utf-8'));
      logger.info('Loaded phrases from file');
      return data;
    }
  } catch (e) {
    logger.warn('Could not load phrases file, using defaults');
  }
  return JSON.parse(JSON.stringify(DEFAULT_PHRASES));
}

function savePhrases(groups: Record<string, string[]>): void {
  try {
    fs.writeFileSync(PHRASES_FILE, JSON.stringify(groups, null, 2));
  } catch (e) {
    logger.warn('Could not save phrases file:', e);
  }
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

  // Load phrases from file (persists across deploys if /tmp survives, or defaults)
  const phraseGroups = loadPhrases();

  app.get('/api/status', (_req, res) => {
    res.json({
      channel: process.env.TWITCH_CHANNEL,
      bots: bots.map((bot, i) => ({
        username: bot.getUsername?.() || `Bot${i + 1}`,
        connected: bot.isBotConnected?.() || false,
        enabled: botStates[i] ?? true,
        index: i,
      })),
      channelInfo: aiService.currentChannelInfo,
      phraseGroups,
    });
  });

  // Manual message from dashboard — routes to specific bot by index
  app.post('/api/send', (req, res) => {
    const { message, botIndex = 0 } = req.body;
    if (!message) return res.status(400).json({ error: 'No message' });
    const idx = parseInt(botIndex) || 0;
    logger.info(`Dashboard send: botIndex=${idx} message="${message}"`);
    aiService.emit(`manualMessage_${idx}`, message);
    // Emit to dashboard immediately with correct bot info
    io.emit('bot-sent', {
      message,
      botIndex: idx,
      botName: bots[idx]?.getUsername?.() || `Bot${idx + 1}`,
      manual: true,
      time: Date.now()
    });
    res.json({ ok: true });
  });

  app.post('/api/phrase/random', (req, res) => {
    const { group, botIndex = 0 } = req.body;
    const phrases = phraseGroups[group];
    if (!phrases?.length) return res.status(404).json({ error: 'Group not found' });
    const phrase = phrases[Math.floor(Math.random() * phrases.length)];
    const idx = parseInt(botIndex) || 0;
    aiService.emit(`manualMessage_${idx}`, phrase);
    io.emit('bot-sent', {
      message: phrase, botIndex: idx,
      botName: bots[idx]?.getUsername?.() || `Bot${idx + 1}`,
      manual: true, time: Date.now()
    });
    res.json({ ok: true, phrase });
  });

  app.post('/api/phrase/exact', (req, res) => {
    const { phrase, botIndex = 0 } = req.body;
    if (!phrase) return res.status(400).json({ error: 'No phrase' });
    const idx = parseInt(botIndex) || 0;
    aiService.emit(`manualMessage_${idx}`, phrase);
    io.emit('bot-sent', {
      message: phrase, botIndex: idx,
      botName: bots[idx]?.getUsername?.() || `Bot${idx + 1}`,
      manual: true, time: Date.now()
    });
    res.json({ ok: true });
  });

  app.post('/api/phrases/add', (req, res) => {
    const { group, phrase } = req.body;
    if (!group || !phrase) return res.status(400).json({ error: 'Missing data' });
    if (!phraseGroups[group]) phraseGroups[group] = [];
    phraseGroups[group].push(phrase);
    savePhrases(phraseGroups);
    io.emit('phrases-updated', phraseGroups);
    res.json({ ok: true });
  });

  app.post('/api/phrases/delete', (req, res) => {
    const { group, phrase } = req.body;
    if (!phraseGroups[group]) return res.status(404).json({ error: 'Group not found' });
    phraseGroups[group] = phraseGroups[group].filter(p => p !== phrase);
    if (phraseGroups[group].length === 0) delete phraseGroups[group];
    savePhrases(phraseGroups);
    io.emit('phrases-updated', phraseGroups);
    res.json({ ok: true });
  });

  app.post('/api/phrases/rename-group', (req, res) => {
    const { oldName, newName } = req.body;
    if (!phraseGroups[oldName] || !newName) return res.status(400).json({ error: 'Invalid' });
    phraseGroups[newName] = phraseGroups[oldName];
    delete phraseGroups[oldName];
    savePhrases(phraseGroups);
    io.emit('phrases-updated', phraseGroups);
    res.json({ ok: true });
  });

  app.post('/api/phrases/delete-group', (req, res) => {
    const { group } = req.body;
    if (!phraseGroups[group]) return res.status(404).json({ error: 'Not found' });
    delete phraseGroups[group];
    savePhrases(phraseGroups);
    io.emit('phrases-updated', phraseGroups);
    res.json({ ok: true });
  });

  app.post('/api/toggle-bot', (req, res) => {
    const { botIndex } = req.body;
    const bot = bots[botIndex];
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    botStates[botIndex] = !botStates[botIndex];
    botStates[botIndex] ? bot.connect?.() : bot.disconnect?.();
    io.emit('bot-state', { botIndex, enabled: botStates[botIndex] });
    res.json({ ok: true, enabled: botStates[botIndex] });
  });

  // Follow channel via Twitch API using bot's OAuth token
  app.post('/api/follow', async (req, res) => {
    const { botIndex = 0 } = req.body;
    try {
      const axios = require('axios');
      const channelUrl = process.env.TWITCH_CHANNEL!;
      const channelName = channelUrl.includes('twitch.tv/')
        ? channelUrl.split('twitch.tv/')[1].split('/')[0].split('?')[0]
        : channelUrl;

      // Get bot's user ID
      const botOauth = (process.env[`BOT${parseInt(botIndex)+1}_OAUTH_TOKEN`] ||
                        process.env[`BOT${parseInt(botIndex)+1}_OAUTH`] || '')
        .replace('oauth:', '');

      if (!botOauth) return res.status(400).json({ error: 'No bot OAuth token' });

      // Get channel user ID
      const channelResp = await axios.get(
        `https://api.twitch.tv/helix/users?login=${channelName}`,
        { headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID!, 'Authorization': `Bearer ${botOauth}` } }
      );
      const broadcasterId = channelResp.data.data[0]?.id;

      // Get bot user ID
      const botResp = await axios.get(
        `https://api.twitch.tv/helix/users`,
        { headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID!, 'Authorization': `Bearer ${botOauth}` } }
      );
      const userId = botResp.data.data[0]?.id;

      if (!broadcasterId || !userId) return res.status(400).json({ error: 'Could not get user IDs' });

      // Follow
      await axios.post(
        `https://api.twitch.tv/helix/channels/followed`,
        { broadcaster_id: broadcasterId, user_id: userId },
        { headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID!, 'Authorization': `Bearer ${botOauth}`, 'Content-Type': 'application/json' } }
      );

      const botName = bots[botIndex]?.getUsername?.() || `Bot${parseInt(botIndex)+1}`;
      logger.info(`Bot ${botName} followed ${channelName}`);
      res.json({ ok: true, botName, channel: channelName });
    } catch (e: any) {
      logger.error('Follow error:', e?.response?.data || e?.message);
      res.status(500).json({ error: e?.response?.data?.message || 'Follow failed' });
    }
  });

  // Follow ALL bots
  app.post('/api/follow-all', async (req, res) => {
    const results = [];
    for (let i = 0; i < bots.length; i++) {
      try {
        await fetch(`http://localhost:${process.env.PORT || 3000}/api/follow`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ botIndex: i })
        });
        results.push({ bot: bots[i]?.getUsername(), ok: true });
      } catch (e) {
        results.push({ bot: bots[i]?.getUsername(), ok: false });
      }
    }
    res.json({ results });
  });

  // AI message event - include bot name
  aiService.on('message', (message: string) => {
    const botName = bots[0]?.getUsername?.() || 'Bot';
    io.emit('bot-sent', { message, botIndex: 0, botName, manual: false, time: Date.now() });
  });

  aiService.on('transcription', (text: string) => {
    io.emit('transcription', { text, time: Date.now() });
  });

  aiService.on('incomingChat', (data: any) => {
    io.emit('incoming-chat', data);
  });

  const PORT = parseInt(process.env.PORT || '3000');
  httpServer.listen(PORT, () => logger.info(`Dashboard at port ${PORT}`));
  return { app, io };
}
