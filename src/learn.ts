import * as tmi from 'tmi.js';
import * as fs from 'fs';
import { TranscriptionService } from './transcription';

interface MarkovChain {
  [key: string]: string[];
}

interface BotClient {
  client: tmi.Client;
  username: string;
}

export class LearnBot {
  private clients: BotClient[] = [];
  private chain: MarkovChain = {};
  private starts: string[] = [];
  // Context chain: "what streamer said" → "what chat replied"
  private contextChain: MarkovChain = {};
  private keyLength = 2;
  private messages = 0;
  private words = 0;
  private running = false;
  private emit: (event: string, data: any) => void;
  private transcriptionService: TranscriptionService | null = null;

  // Rolling window of recent transcripts from LEARN_CHANNEL stream audio
  // Each entry: { text, timestamp }
  private recentTranscripts: { text: string; timestamp: number }[] = [];
  private readonly TRANSCRIPT_WINDOW_MS = 45000; // 45 seconds

  constructor(emit: (event: string, data: any) => void) {
    this.emit = emit;
  }

  // ── Transcript intake ──────────────────────────────────────────────────────

  // Called when we receive a new audio transcript from LEARN_CHANNEL
  private onTranscript(text: string): void {
    if (!text || text.length < 10) return;

    // Add to rolling window
    this.recentTranscripts.push({ text, timestamp: Date.now() });
    // Keep last 20 entries max
    if (this.recentTranscripts.length > 20) this.recentTranscripts.shift();

    // Learn the transcript itself as a Markov chain
    // (so we can later match incoming transcripts to learned context)
    this.learnTranscriptWords(text);

    this.emit('learn:transcript', {
      text,
      timestamp: Date.now(),
      source: 'learn_channel',
    });

    console.log('[learn] Transcript from LEARN_CHANNEL:', text.slice(0, 100));
  }

  // ── Chat message intake ────────────────────────────────────────────────────

  // Called on every incoming chat message from LEARN_CHANNEL
  learnChatMessage(msg: string): void {
    const words = msg.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    if (words.length < 2) return;

    // Find the most recent transcript within the window
    const recentTranscript = this.getRecentTranscript();

    if (recentTranscript) {
      // Link chat response to what the streamer said
      this.learnWithContext(recentTranscript, msg);
    }

    // Always learn the raw chat message too
    this.learn(msg);

    this.messages++;
    this.emit('learn:status', {
      running: this.running,
      messages: this.messages,
      words: this.words,
    });
    if (this.messages % 50 === 0) {
      const ctxSize = Object.keys(this.contextChain).length;
      this.emit('learn:log',
        `📊 ${this.messages} сообщений | ${ctxSize} контекстных связей`
      );
    }
  }

  // Returns the most recent transcript that's still within the time window
  private getRecentTranscript(): string | null {
    const cutoff = Date.now() - this.TRANSCRIPT_WINDOW_MS;
    // Walk from newest to oldest
    for (let i = this.recentTranscripts.length - 1; i >= 0; i--) {
      if (this.recentTranscripts[i].timestamp >= cutoff) {
        return this.recentTranscripts[i].text;
      }
    }
    return null;
  }

  // ── Context learning: streamer said X → chat replied Y ────────────────────

  private learnWithContext(transcript: string, chatMsg: string): void {
    if (!transcript || !chatMsg) return;
    const tWords = transcript.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const cWords = chatMsg.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    if (tWords.length < 2 || cWords.length < 1) return;

    // Use a 2–3 word key from the beginning of the transcript
    const keyLen = Math.min(3, tWords.length);
    const key = tWords.slice(0, keyLen).join(' ');
    if (!this.contextChain[key]) this.contextChain[key] = [];
    // Store the first 5 words of the chat reply
    this.contextChain[key].push(cWords.slice(0, 5).join(' '));
    // Cap each key at 50 entries
    if (this.contextChain[key].length > 50) this.contextChain[key].shift();
  }

  // ── Markov helpers ────────────────────────────────────────────────────────

  private learnTranscriptWords(text: string): void {
    if (!text || text.length < 10) return;
    const words = text.trim().split(/\s+/).filter(w => w.length > 0);
    if (words.length < 3) return;
    for (let i = 0; i <= words.length - this.keyLength; i++) {
      const key = words.slice(i, i + this.keyLength).join(' ').toLowerCase();
      const next = words[i + this.keyLength];
      if (!next) continue;
      if (!this.contextChain[key]) this.contextChain[key] = [];
      this.contextChain[key].push(next.toLowerCase());
    }
  }

  private learn(text: string): void {
    const words = text.trim().split(/\s+/).filter(
      w => w.length > 0 && !w.startsWith('http')
    );
    if (words.length < 2) return;
    this.words += words.length;
    for (let i = 0; i <= words.length - this.keyLength; i++) {
      const key = words.slice(i, i + this.keyLength).join(' ');
      const next = words[i + this.keyLength];
      // Fix: skip end-of-sentence positions where next is undefined
      // (avoids storing null values in the chain JSON)
      if (next === undefined) continue;
      if (i === 0) this.starts.push(key);
      if (!this.chain[key]) this.chain[key] = [];
      this.chain[key].push(next);
    }
  }

  // ── Generation ─────────────────────────────────────────────────────────────

  generate(start?: string): string {
    if (Object.keys(this.chain).length === 0) return '';
    let current = start || this.starts[Math.floor(Math.random() * this.starts.length)];
    const result = current.split(' ');
    for (let i = 0; i < 20; i++) {
      const options = this.chain[current];
      if (!options || options.length === 0) break;
      const next = options[Math.floor(Math.random() * options.length)];
      result.push(next);
      current = result.slice(-this.keyLength).join(' ');
    }
    return result.join(' ');
  }

  generateWithContext(context: string, minWords = 5): string {
    if (Object.keys(this.chain).length === 0) return '';
    const contextWords = context.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const matchingStarts: string[] = [];
    for (const word of contextWords) {
      for (const start of this.starts) {
        if (start.toLowerCase().includes(word)) matchingStarts.push(start);
      }
    }
    let result = '';
    if (matchingStarts.length > 0) {
      result = this.generate(matchingStarts[Math.floor(Math.random() * matchingStarts.length)]);
    }
    if (!result || result.split(' ').length < minWords) result = this.generate();
    return result;
  }

  // Generate a chat-style reply given what the streamer just said.
  // Looks up the contextChain first (streamer speech → chat reply),
  // then falls back to regular chat generation.
  generateFromTranscript(transcript: string): string {
    if (!transcript) return '';
    const words = transcript.toLowerCase().split(/\s+/).filter(w => w.length > 2);

    // Try context chain first (collect all options)
    const allOptions: string[] = [];
    for (let len = Math.min(3, words.length); len >= 1; len--) {
      const key = words.slice(0, len).join(' ');
      const options = this.contextChain[key];
      if (options && options.length > 0) {
        allOptions.push(...options);
      }
    }
    if (allOptions.length > 0) {
      const base = allOptions[Math.floor(Math.random() * allOptions.length)];
      console.log('[learn] generateFromTranscript: context random from ' + allOptions.length + ' options');
      return base;
    }

    // Also try mid-transcript keys with randomness
    const midOptions: string[] = [];
    for (let i = 1; i < words.length - 1; i++) {
      for (let len = Math.min(3, words.length - i); len >= 1; len--) {
        const key = words.slice(i, i + len).join(' ');
        const options = this.contextChain[key];
        if (options && options.length > 0) {
          midOptions.push(...options);
        }
      }
    }
    if (midOptions.length > 0) {
      const base = midOptions[Math.floor(Math.random() * midOptions.length)];
      console.log('[learn] generateFromTranscript: random from ' + midOptions.length + ' options');
      return base;
    }

    return '';
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(
    channel: string,
    tokens: string[],
    groqKey?: string,
    language = 'ru',
    learnChunkSecs = 15
  ): Promise<void> {
    if (this.running) return;

    const chan = channel.toLowerCase().replace(/^#/, '');

    // ── Start transcription for LEARN_CHANNEL ──────────────────────────────
    if (groqKey) {
      this.emit('learn:log', `🎙 Запуск транскрипции LEARN_CHANNEL: ${chan}`);
      const safeSecs = Math.max(10, learnChunkSecs);
      this.transcriptionService = new TranscriptionService(groqKey, chan, language, safeSecs);
      this.transcriptionService.start((result) => {
        this.onTranscript(result.text);
      });
      this.emit('learn:log', `✅ Транскрипция запущена (канал: ${chan}, язык: ${language}, чанк: ${safeSecs}с)`);
    } else {
      this.emit('learn:log', '⚠️ GROQ_API_KEY не установлен — транскрипция не работает');
    }

    // ── Connect a SINGLE dedicated reader to chat ─────────────────────────
    // Important: only ONE client listens to messages.
    // Using all tokens would learn each message N times (one per bot).
    const readerToken = tokens[0];
    if (!readerToken) {
      this.emit('learn:log', '⚠️ Нет токена для чтения чата');
    } else {
      this.emit('learn:log', `Подключение читателя чата к ${chan}...`);
      try {
        const reader = tmi.client({
          channels: [chan],
          identity: { username: 'learn_reader', password: readerToken },
          options: { debug: false },
        });

        reader.on('message', (_ch, _tags, msg, self) => {
          if (self) return;
          this.learnChatMessage(msg);
        });

        reader.on('connected', () => {
          this.emit('learn:log', `✅ Читатель подключён к ${chan}`);
        });

        reader.on('disconnected', () => {
          this.emit('learn:log', `❌ Читатель отключён от ${chan}`);
        });

        reader.connect();
        this.clients.push({ client: reader, username: 'learn_reader' });
      } catch (e: any) {
        this.emit('learn:log', `⚠ Читатель: ${e.message}`);
      }
    }

    this.running = true;
    this.emit('learn:log', `📚 Обучение началось на канале ${chan}`);
    this.emit('learn:log', `🎙 Транскрипция: ${groqKey ? 'вкл' : 'выкл'} | Чат: вкл`);
    this.emit('learn:status', {
      running: true,
      messages: this.messages,
      words: this.words,
    });
  }

  // Stops only connections (chat + transcription).
  // Chain data (chain, contextChain, messages) stays in memory.
  // Call this instead of stop() when you want to switch channels or pause.
  stopConnections(): void {
    this.running = false;

    if (this.transcriptionService) {
      this.transcriptionService.stop();
      this.transcriptionService = null;
    }

    for (const bot of this.clients) {
      try { bot.client.disconnect(); } catch { /* ignore */ }
    }
    this.clients = [];

    this.emit('learn:log', '⏸ Подключения закрыты. Накоплено ' + this.messages + ' сообщений — данные в памяти.');
    this.emit('learn:status', {
      running: false,
      messages: this.messages,
      words: this.words,
    });
  }

  // Full stop — disconnects AND clears all data from memory.
  // Only use this if you intentionally want to reset everything.
  stop(): void {
    this.stopConnections();
    this.chain = {};
    this.starts = [];
    this.contextChain = {};
    this.messages = 0;
    this.words = 0;
    this.recentTranscripts = [];
    this.emit('learn:log', '🗑 Данные очищены из памяти.');
  }

  // ── Data API ───────────────────────────────────────────────────────────────

  hasEnoughData(minMessages = 100): boolean {
    return this.messages >= minMessages;
  }

  getData() {
    return {
      chain: this.chain,
      starts: this.starts,
      contextChain: this.contextChain,
      messages: this.messages,
      words: this.words,
      uniqueWords: Object.keys(this.chain).length,
      contextLinks: Object.keys(this.contextChain).length,
    };
  }

  getStats() {
    return {
      messages: this.messages,
      words: this.words,
      uniqueWords: Object.keys(this.chain).length,
      contextLinks: Object.keys(this.contextChain).length,
      running: this.running,
      hasTranscription: this.transcriptionService !== null,
    };
  }

  generatePreview(count = 5): string[] {
    const results: string[] = [];
    for (let i = 0; i < count; i++) {
      const gen = this.generate();
      if (gen) results.push(gen);
    }
    return results;
  }

  getTopPhrases(count = 10): string[] {
    const phraseCounts: Record<string, number> = {};
    for (const key of Object.keys(this.chain)) {
      const phrases = this.chain[key];
      if (phrases.length > 1) {
        const phrase = key + ' ' + phrases[0];
        phraseCounts[phrase] = (phraseCounts[phrase] || 0) + phrases.length;
      }
    }
    return Object.entries(phraseCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, count)
      .map(([phrase]) => phrase);
  }

  saveToFile(filepath: string): void {
    fs.writeFileSync(filepath, JSON.stringify(this.getData(), null, 2));
    this.emit('learn:log', `Сохранено в ${filepath}`);
  }

  loadData(data: {
    chain: MarkovChain;
    starts: string[];
    messages: number;
    words: number;
    // Support both old field names and new
    contextChain?: MarkovChain;
    transcriptChain?: MarkovChain;
    transcriptStarts?: string[];
  }): void {
    this.chain = data.chain || {};
    this.starts = data.starts || [];
    // Load context chain — handle both old name (transcriptChain) and new (contextChain)
    this.contextChain = data.contextChain || data.transcriptChain || {};
    this.messages = data.messages || 0;
    this.words = data.words || 0;
    console.log(
      '[learn] Loaded:',
      this.messages, 'messages,',
      Object.keys(this.chain).length, 'chat chains,',
      Object.keys(this.contextChain).length, 'context links'
    );
  }
}
