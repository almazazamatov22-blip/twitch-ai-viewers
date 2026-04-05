import { Bot } from './bot';
import { AIService } from './ai';
import { logger } from './logger';
import { startDashboardServer } from './server';
import { getPersonality, BotMemory } from './personalities';
import dotenv from 'dotenv';

dotenv.config();

const requiredEnvVars = ['TWITCH_CHANNEL', 'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'GROQ_API_KEY'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    logger.error(`Missing required environment variable: ${envVar}`);
    throw new Error(`Missing: ${envVar}`);
  }
}

const aiService = new AIService();
const bots: Bot[] = [];
let isShuttingDown = false;

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info('Shutting down...');
  for (const bot of bots) {
    try { bot.disconnect(); } catch (_) {}
  }
  await new Promise(r => setTimeout(r, 500));
  process.exit(0);
}

async function main() {
  try {
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

    if (!botCredentials.length)
      throw new Error('No bot credentials. Set BOT1_USERNAME and BOT1_OAUTH_TOKEN');

    logger.info(`Found ${botCredentials.length} bot(s)`);

    const channelUrl = process.env.TWITCH_CHANNEL!;
    const channelName = channelUrl.includes('twitch.tv/')
      ? channelUrl.split('twitch.tv/')[1].split('/')[0].split('?')[0]
      : channelUrl;
    logger.info(`Channel: ${channelName}`);

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
        bot.connect();
      } catch (error) {
        logger.error(`Error creating bot ${botCredentials[idx].username}:`, error);
      }
    }

    // Start dashboard - get io reference to emit bot-sent events
    const { io } = startDashboardServer(aiService, bots);

    // Hook up bot callbacks to emit to dashboard
    bots.forEach(bot => {
      bot.onAISent = (message, botIndex, botName) => {
        io.emit('bot-sent', { message, botIndex, botName, manual: false, time: Date.now() });
        logger.info(`Dashboard notified: bot[${botIndex}] sent "${message}"`);
      };
    });

    // Per-bot memory
    const botMemories: BotMemory[] = bots.map(() => new BotMemory(15));

    // Round-robin AI messages across all connected bots
    let rrIndex = 0;
    aiService.on('message', (message: string) => {
      if (!message?.trim()) return;
      let attempts = 0;
      while (attempts < bots.length) {
        const bot = bots[rrIndex % bots.length];
        const idx = bot.getBotIndex();
        rrIndex++;
        attempts++;
        if (bot.isBotConnected()) {
          botMemories[idx]?.add(message);
          bot.sendAIMessage(message);
          logger.info(`AI → bot[${idx}] ${bot.getUsername()}: "${message}"`);
          return;
        }
      }
      // Fallback: first available bot
      for (const bot of bots) {
        if (bot.isBotConnected()) { bot.sendAIMessage(message); return; }
      }
    });

    // Chat messages → random bot generates reply with its personality
    aiService.on('chatMessage', async (contextJson: string) => {
      const connectedBots = bots.filter(b => b.isBotConnected());
      if (!connectedBots.length) return;

      const candidates = connectedBots.filter(b => {
        const p = getPersonality(b.getBotIndex());
        return Math.random() < p.replyChance;
      });
      if (!candidates.length) return;

      const bot = candidates[Math.floor(Math.random() * candidates.length)];
      const idx = bot.getBotIndex();
      const personality = getPersonality(idx);
      const memory = botMemories[idx];

      try {
        const ctx = JSON.parse(contextJson);
        ctx.botMemory = memory.getContext();
        const msg = await aiService.generateMessage(JSON.stringify(ctx), personality.systemPrompt);
        if (msg?.trim()) {
          memory.add(msg);
          bot.sendAIMessage(msg);
          logger.info(`Chat reply → bot[${idx}] ${bot.getUsername()}: "${msg}"`);
        }
      } catch (e) {
        logger.error('Chat reply error:', e);
      }
    });

    // Suppress disconnect spam
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('uncaughtException', (err) => {
      const msg = String(err);
      if (msg.includes('Socket is not opened') || msg.includes('Cannot disconnect')) return;
      logger.error('Uncaught exception:', err);
      shutdown();
    });
    process.on('unhandledRejection', (err) => {
      const msg = String(err);
      if (msg.includes('Socket is not opened') || msg.includes('Cannot disconnect')) return;
      logger.error('Unhandled rejection:', err);
    });

  } catch (error) {
    logger.error('Error in main:', error);
    await shutdown();
  }
}

main();
