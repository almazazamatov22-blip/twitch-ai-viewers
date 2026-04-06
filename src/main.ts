import { Bot } from './bot';
import { AIService } from './ai';
import { logger } from './logger';
import { startDashboardServer } from './server';
import { PERSONALITIES, BotMemory } from './personalities';
import dotenv from 'dotenv';

dotenv.config();

const requiredEnvVars = ['TWITCH_CHANNEL', 'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'GROQ_API_KEY'];
for (const v of requiredEnvVars) {
  if (!process.env[v]) throw new Error(`Missing: ${v}`);
}

const aiService = new AIService();
const bots: Bot[] = [];
let isShuttingDown = false;

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info('Shutting down...');
  for (const bot of bots) { try { bot.disconnect(); } catch (_) {} }
  await new Promise(r => setTimeout(r, 500));
  process.exit(0);
}

// Get channel name for memory namespacing
function getChannelName(): string {
  const ch = process.env.TWITCH_CHANNEL || '';
  return ch.includes('twitch.tv/') ? ch.split('twitch.tv/')[1].split('/')[0].split('?')[0] : ch;
}

// Rate limiting: track last send time per bot
const lastSendTime: Record<number, number> = {};
function canSend(botIndex: number, minInterval: number): boolean {
  const last = lastSendTime[botIndex] || 0;
  return Date.now() - last >= minInterval;
}
function markSent(botIndex: number) {
  lastSendTime[botIndex] = Date.now();
}

// Shared context
let lastTranscription = '';
let lastTranscriptionTime = 0;
const recentChat: { username: string; message: string; time: number }[] = [];

// Track last few messages from ALL bots for cross-dedup
const allRecentBotMessages: string[] = [];

async function tryGenerate(
  bot: Bot,
  memory: BotMemory,
  trigger: 'timer' | 'chat' | 'transcription',
  replyTo?: string,
): Promise<void> {
  const idx = bot.getBotIndex();
  const personality = PERSONALITIES[idx % PERSONALITIES.length];

  if (!canSend(idx, personality.minInterval)) return;
  if (!bot.isBotConnected()) return;

  const now = Date.now();
  const hasTranscription = lastTranscription.length > 20 && (now - lastTranscriptionTime) < 120000;
  const hasChat = recentChat.length > 0 && (now - recentChat[recentChat.length - 1].time) < 60000;

  if (!hasTranscription && !hasChat && trigger !== 'timer') return;

  try {
    // Include what OTHER bots said to avoid same message
    const otherBotCtx = allRecentBotMessages.length > 0
      ? `Другие зрители уже написали: ${allRecentBotMessages.slice(-4).join(' | ')}. Напиши что-то ДРУГОЕ.`
      : '';

    const contextJson = JSON.stringify({
      lastTranscription: hasTranscription ? lastTranscription.slice(0, 300) : '',
      chatMessage: hasChat ? recentChat.slice(-3).map(m => `${m.username}: ${m.message}`).join(' | ') : '',
      botMemory: memory.getContext() + (otherBotCtx ? '\n' + otherBotCtx : ''),
      replyTo: replyTo || '',
    });

    const msg = await aiService.generateMessage(contextJson, personality.system);
    if (!msg?.trim()) return;

    // Dedup vs own history AND other bots
    if (memory.isDuplicate(msg)) { logger.info(`Bot[${idx}] own-dedup: "${msg}"`); return; }
    const msgLow = msg.toLowerCase().trim();
    if (allRecentBotMessages.some(m => m.toLowerCase().trim() === msgLow)) {
      logger.info(`Bot[${idx}] cross-dedup: "${msg}"`); return;
    }

    markSent(idx);
    memory.addSent(msg);
    allRecentBotMessages.push(msg);
    if (allRecentBotMessages.length > 20) allRecentBotMessages.shift();

    bot.sendAIMessage(msg);
    logger.info(`Bot[${idx}] ${trigger}: "${msg}"`);
  } catch (e) {
    logger.error(`Bot[${idx}] generate error:`, e);
  }
}

// Per-bot independent timer
function scheduleBotTimer(bot: Bot, memory: BotMemory) {
  const idx = bot.getBotIndex();
  const personality = PERSONALITIES[idx % PERSONALITIES.length];
  const delay = personality.minInterval +
    Math.random() * (personality.maxInterval - personality.minInterval);

  setTimeout(async () => {
    if (isShuttingDown) return;
    await tryGenerate(bot, memory, 'timer');
    scheduleBotTimer(bot, memory);
  }, delay);
}

async function main() {
  logger.info('Starting Twitch AI Viewers');

  const botCredentials: { username: string; oauth: string }[] = [];
  let i = 1;
  while (true) {
    const username = process.env[`BOT${i}_USERNAME`];
    const oauth = process.env[`BOT${i}_OAUTH_TOKEN`] || process.env[`BOT${i}_OAUTH`];
    if (!username || !oauth) break;
    botCredentials.push({ username, oauth });
    i++;
  }
  if (!botCredentials.length) throw new Error('No bot credentials');

  logger.info(`Found ${botCredentials.length} bot(s)`);
  const channelName = getChannelName();
  logger.info(`Channel: ${channelName}`);

  const botMemories: BotMemory[] = [];

  for (let idx = 0; idx < botCredentials.length; idx++) {
    try {
      const bot = new Bot({
        username: botCredentials[idx].username,
        oauth: botCredentials[idx].oauth,
        channel: channelName,
        aiService,
        shouldHandleVoiceCapture: idx === 0,
        botIndex: idx,
      });
      bots.push(bot);
      botMemories.push(new BotMemory(channelName, idx));
      bot.connect();
    } catch (e) {
      logger.error(`Error creating bot ${botCredentials[idx].username}:`, e);
      botMemories.push(new BotMemory(channelName, idx));
    }
  }

  const { io } = startDashboardServer(aiService, bots);

  bots.forEach(bot => {
    bot.onAISent = (message, botIndex, botName) => {
      io.emit('bot-sent', { message, botIndex, botName, manual: false, time: Date.now() });
    };
  });

  // Transcription update - store context
  aiService.on('transcription', (text: string) => {
    lastTranscription = text;
    lastTranscriptionTime = Date.now();
  });

  // When AI has a full transcription chunk ready → all eligible bots react
  // But spaced out evenly so chat has continuous activity (not burst)
  aiService.on('message', async (_rawMsg: string) => {
    const connected = bots.filter(b => b.isBotConnected());
    if (!connected.length) return;

    const eligible = connected.filter(b => {
      const p = PERSONALITIES[b.getBotIndex() % PERSONALITIES.length];
      return canSend(b.getBotIndex(), p.minInterval);
    });
    if (!eligible.length) return;

    // Spread bots evenly across 30 seconds so chat has steady flow
    const spreadMs = 30000;
    const slotSize = spreadMs / (eligible.length + 1);

    eligible.forEach((bot, i) => {
      const delay = slotSize * (i + 1) + Math.random() * 5000;
      setTimeout(() => {
        if (!isShuttingDown) tryGenerate(bot, botMemories[bot.getBotIndex()], 'transcription');
      }, delay);
    });
  });

  // Incoming chat → update context, at most ONE bot replies per message
  aiService.on('incomingChat', (data: any) => {
    io.emit('incoming-chat', data);

    recentChat.push({ username: data.username, message: data.message, time: Date.now() });
    if (recentChat.length > 15) recentChat.shift();
    botMemories.forEach(m => m.addViewer(data.username));

    // Pick at most ONE bot to reply (weighted random, only if rate allows)
    const eligible = bots.filter(b => {
      if (!b.isBotConnected()) return false;
      const p = PERSONALITIES[b.getBotIndex() % PERSONALITIES.length];
      return canSend(b.getBotIndex(), p.minInterval) && Math.random() < p.chatReplyChance;
    });

    if (eligible.length > 0) {
      const bot = eligible[Math.floor(Math.random() * eligible.length)];
      const delay = Math.random() * 10000 + 2000; // 2-12s delay
      setTimeout(() => {
        if (!isShuttingDown) tryGenerate(bot, botMemories[bot.getBotIndex()], 'chat');
      }, delay);
    }
  });

  // Start independent timers (staggered)
  bots.forEach((bot, idx) => {
    const stagger = (idx + 1) * 15000 + Math.random() * 10000;
    setTimeout(() => {
      if (!isShuttingDown) scheduleBotTimer(bot, botMemories[idx]);
    }, stagger);
    logger.info(`Bot[${idx}] timer starts in ${Math.round(stagger/1000)}s`);
  });

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (err) => {
    const msg = String(err);
    if (msg.includes('Socket is not opened') || msg.includes('Cannot disconnect')) return;
    logger.error('Uncaught:', err); shutdown();
  });
  process.on('unhandledRejection', (err) => {
    const msg = String(err);
    if (msg.includes('Socket is not opened') || msg.includes('Cannot disconnect')) return;
    logger.error('Rejection:', err);
  });
}

main().catch(e => { logger.error('Fatal:', e); shutdown(); });
