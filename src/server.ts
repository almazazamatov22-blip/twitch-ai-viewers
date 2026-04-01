import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { AIService } from './ai';
import { logger } from './logger';

export function startDashboardServer(aiService: AIService, bots: any[]) {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, { cors: { origin: '*' } });

  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));

  // Состояние ботов
  const botStates: Record<string, boolean> = {};
  const phraseGroups: Record<string, string[]> = {
    'Приветствия': ['Привет стрим!', 'О, живой!', 'Хей!', 'Здарова!'],
    'Реакции': ['ЛОООЛ', 'ахахах', 'ну ты дал', 'топ момент', 'КЛАссс'],
    'Вопросы': ['какая игра?', 'что играем?', 'сколько часов уже?'],
  };

  // Инициализируем состояние ботов
  bots.forEach((bot, i) => {
    const name = bot.client?.getUsername?.() || `Bot${i + 1}`;
    botStates[name] = true;
  });

  // REST API
  app.get('/api/status', (req, res) => {
    res.json({
      channel: process.env.TWITCH_CHANNEL,
      bots: bots.map((bot, i) => ({
        username: bot.client?.getUsername?.() || `Bot${i + 1}`,
        connected: bot.isBotConnected?.() || false,
        enabled: botStates[bot.client?.getUsername?.() || `Bot${i + 1}`] ?? true,
      })),
      channelInfo: aiService.currentChannelInfo,
      phraseGroups,
    });
  });

  app.post('/api/send', (req, res) => {
    const { botIndex, message } = req.body;
    if (!message) return res.status(400).json({ error: 'No message' });
    try {
      const bot = bots[botIndex || 0];
      if (!bot) return res.status(404).json({ error: 'Bot not found' });
      aiService.emit('message', message);
      io.emit('chat', { from: 'dashboard', bot: botIndex || 0, message, time: Date.now() });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post('/api/phrase', (req, res) => {
    const { group } = req.body;
    const phrases = phraseGroups[group];
    if (!phrases) return res.status(404).json({ error: 'Group not found' });
    const phrase = phrases[Math.floor(Math.random() * phrases.length)];
    aiService.emit('message', phrase);
    io.emit('chat', { from: 'phrase', group, message: phrase, time: Date.now() });
    res.json({ ok: true, phrase });
  });

  app.post('/api/toggle-bot', (req, res) => {
    const { botIndex } = req.body;
    const bot = bots[botIndex];
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    const name = bot.client?.getUsername?.() || `Bot${botIndex}`;
    botStates[name] = !botStates[name];
    if (botStates[name]) {
      bot.connect?.();
    } else {
      bot.disconnect?.();
    }
    io.emit('bot-state', { botIndex, enabled: botStates[name] });
    res.json({ ok: true, enabled: botStates[name] });
  });

  app.post('/api/phrases/add', (req, res) => {
    const { group, phrase } = req.body;
    if (!phraseGroups[group]) phraseGroups[group] = [];
    phraseGroups[group].push(phrase);
    io.emit('phrases-updated', phraseGroups);
    res.json({ ok: true });
  });

  // Socket.io — трансляция событий AI в дашборд
  aiService.on('transcription', (text: string) => {
    io.emit('transcription', { text, time: Date.now() });
  });

  aiService.on('message', (message: string) => {
    io.emit('bot-message', { message, time: Date.now() });
  });

  const PORT = parseInt(process.env.PORT || '3000');
  httpServer.listen(PORT, () => {
    logger.info(`Dashboard running at http://localhost:${PORT}`);
  });

  return { app, io };
}
