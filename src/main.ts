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

async function tryGenerate(
  bot: Bot,
  memory: BotMemory,
  trigger: 'timer' | 'chat' | 'transcription',
  replyTo?: string,
): Promise<void> {
  const idx = bot.getBotIndex();
  const personality = PERSONALITIES[idx % PERSONALITIES.length];

  // Strict rate limit
  if (!canSend(idx, personality.minInterval)) return;

  // Require meaningful context
  const now = Date.now();
  const hasRecentTranscription = lastTranscription.length > 20 && (now - lastTranscriptionTime) < 120000;
  const hasRecentChat = recentChat.length > 0 && (now - recentChat[recentChat.length - 1].time) < 60000;

  if (!hasRecentTranscription && !hasRecentChat && trigger !== 'timer') return;

  if (!bot.isBotConnected()) return;

  try {
    const parts: string[] = [];

    if (hasRecentTranscription)
      parts.push(`Стример говорит: "${lastTranscription.slice(0, 250)}"`);

    if (hasRecentChat) {
      const chatLines = recentChat.slice(-4).map(m => `${m.username}: ${m.message}`).join('\n');
      parts.push(`Чат:\n${chatLines}`);
    }

    if (replyTo)
      parts.push(`Тебе написали: "${replyTo}" — ответь им в тегом @`);

    parts.push(memory.getContext());

    const contextJson = JSON.stringify({
      lastTranscription: hasRecentTranscription ? lastTranscription.slice(0, 250) : '',
      chatMessage: hasRecentChat ? recentChat.slice(-3).map(m => `${m.username}: ${m.message}`).join(' | ') : '',
      botMemory: memory.getContext(),
      replyTo: replyTo || '',
    });

    const msg = await aiService.generateMessage(contextJson, personality.system);

    if (!msg?.trim()) return;

    // Dedup check
    if (memory.isDuplicate(msg)) {
      logger.info(`Bot[${idx}] dedup skip: "${msg}"`);
      return;
    }

    markSent(idx);
    memory.addSent(msg);
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

  // Transcription → update context, ALL eligible bots independently decide to react
  aiService.on('transcription', (text: string) => {
    lastTranscription = text;
    lastTranscriptionTime = Date.now();
  });

  // AI generated message from transcription → each bot independently generates its own response
  aiService.on('message', async (_rawMessage: string) => {
    // _rawMessage is the transcription result — each bot generates its OWN message
    const connected = bots.filter(b => b.isBotConnected());
    if (!connected.length) return;

    // Each bot independently decides to respond based on its rate limit
    for (const bot of connected) {
      const idx = bot.getBotIndex();
      const personality = PERSONALITIES[idx % PERSONALITIES.length];
      if (!canSend(idx, personality.minInterval)) continue;

      // Stagger so they don't all send at exactly the same time
      const delay = Math.random() * 20000; // up to 20s stagger
      setTimeout(() => {
        if (!isShuttingDown) tryGenerate(bot, botMemories[idx], 'transcription');
      }, delay);
    }
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
