import * as tmi from 'tmi.js';
import * as fs from 'fs';
import * as path from 'path';
import * as Groq from 'groq-sdk';
import { spawn } from 'child_process';

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
  private transcriptChain: MarkovChain = {}; // transcription -> responses
  private transcriptStarts: string[] = [];
  private keyLength = 2;
  private messages = 0;
  private words = 0;
  private running = false;
  private emit: (event: string, data: any) => void;
  private groqKey: string = '';
  private channel: string = '';
  private lastTranscript = ''; // Last transcript for linking with chat
  private transcriptTime = 0; // When we heard the transcript
  private recentTranscripts: string[] = []; // Buffer of recent transcripts

  constructor(emit: (event: string, data: any) => void) {
    this.emit = emit;
  }

  // Called when we receive a chat message - LINK with recent transcript
  learnChatMessage(msg: string): void {
    const now = Date.now();
    const words = msg.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    if (words.length < 2) return;
    
    // If recent transcript exists (within last 30 seconds), link them
    if (this.lastTranscript && now - this.transcriptTime < 30000) {
      this.learnWithContext(this.lastTranscript, msg);
    }
    
    this.learn(msg);
    this.messages++;
    this.emit('learn:status', {
      running: this.running,
      messages: this.messages,
      words: this.words,
    });
    if (this.messages % 100 === 0) {
      this.emit('learn:log', `Изучено ${this.messages} сообщений`);
    }
  }

  // Called when we hear a transcript from stream audio
  onTranscript(text: string): void {
    if (!text || text.length < 10) return;
    this.lastTranscript = text;
    this.transcriptTime = Date.now();
    this.recentTranscripts.push(text);
    if (this.recentTranscripts.length > 10) this.recentTranscripts.shift();
    
    // Also learn transcript chain itself for generation
    this.learnTranscript(text);
  }

  // Learn that "when said X, chat responded with Y"
  learnWithContext(transcript: string, response: string): void {
    if (!transcript || transcript.length < 10 || !response || response.length < 2) return;
    const tWords = transcript.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const rWords = response.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    if (tWords.length < 2 || rWords.length < 1) return;
    // Key = first few words of transcript
    const tKey = tWords.slice(0, Math.min(3, tWords.length)).join(' ');
    if (!this.transcriptChain[tKey]) this.transcriptChain[tKey] = [];
    this.transcriptChain[tKey].push(rWords.slice(0, 4).join(' '));
  }

  // Just learn transcript words (for generateFromTranscript)
  learnTranscript(text: string): void {
    if (!text || text.length < 10) return;
    const words = text.trim().split(/\s+/).filter(w => w.length > 0);
    if (words.length < 3) return;
    for (let i = 0; i <= words.length - this.keyLength; i++) {
      const key = words.slice(i, i + this.keyLength).join(' ');
      const next = words[i + this.keyLength];
      if (!next) continue;
      if (i === 0) {
        if (!this.transcriptStarts.includes(key)) this.transcriptStarts.push(key);
      }
      if (!this.transcriptChain[key]) this.transcriptChain[key] = [];
      this.transcriptChain[key].push(next);
    }
  }

  // Generate from transcript context - what would chat say?
  generateFromTranscript(transcript: string): string {
    if (Object.keys(this.transcriptChain).length === 0) return '';
    const words = transcript.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    let matchingKey = '';
    // Find longest matching key
    for (let i = words.length - 1; i >= 0; i--) {
      const key = words.slice(Math.max(0, i - 1), i + 1).join(' ');
      if (this.transcriptChain[key] && this.transcriptChain[key].length > 0) {
        matchingKey = key;
        break;
      }
    }
    if (!matchingKey) return '';
    const result: string[] = matchingKey.split(' ');
    let current = matchingKey;
    for (let i = 0; i < 10; i++) {
      const options = this.transcriptChain[current];
      if (!options || options.length === 0) break;
      const next = options[Math.floor(Math.random() * options.length)];
      result.push(next);
      current = result.slice(-this.keyLength).join(' ');
    }
    return result.join(' ');
  }

  async start(channel: string, tokens: string[], groqKey?: string): Promise<void> {
    if (this.running) return;
    
    this.channel = channel.toLowerCase().replace(/^#/, '');
    this.groqKey = groqKey || '';
    
    // Start transcription if we have groqKey
    if (this.groqKey) {
      this.emit('learn:log', 'Запуск транскрипции для ' + this.channel);
      this.startTranscription();
    } else {
      this.emit('learn:log', 'ВНИМАНИЕ: GROQ_API_KEY не установлен - транскрипция не будет работать');
    }
    
    const chan = this.channel;
    this.emit('learn:log', `Запуск ${tokens.length} ботов на канале ${chan}`);
    
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const username = 'bot' + (i + 1);
      
      try {
        const client = tmi.client({
          channels: [chan],
          identity: {
            username: username,
            password: token,
          },
          options: {
            debug: false,
          },
        });

        client.on('message', (chan, tags, msg, self) => {
          if (self) return;
          this.learnChatMessage(msg); // Links chat with recent transcript
        });

        client.on('connected', () => {
          this.emit('learn:log', `✅ ${username} подключен`);
        });

        client.on('disconnected', () => {
          this.emit('learn:log', `❌ ${username} отключен`);
        });

        client.connect();
        this.clients.push({ client, username });
      } catch (e: any) {
        this.emit('learn:log', `⚠ ${username}: ${e.message}`);
      }
    }

    this.running = true;
    this.emit('learn:log', `Обучение началось`);
    this.emit('learn:status', {
      running: true,
      messages: this.messages,
      words: this.words,
    });
  }

  // Start transcription to learn from stream audio
  private async startTranscription(): Promise<void> {
    if (!this.groqKey || !this.channel) return;
    
    const GroqSDK = require('groq-sdk');
    const groq = new GroqSDK({ apiKey: this.groqKey });
    const tmpDir = '/tmp';
    let stopped = false;
    
    const capture = async () => {
      if (stopped || this.running === false) return;
      
      const outFile = tmpDir + '/learn-audio-' + Date.now() + '.wav';
      try {
        const link = spawn('streamlink', [
          '--quiet', '--twitch-low-latency',
          'https://twitch.tv/' + this.channel,
          'audio_only,worst',
          '--stdout',
        ], { timeout: 65000 });
        
        const ffmpeg = spawn('ffmpeg', [
          '-i', 'pipe:0',
          '-t', '50',
          '-vn', '-ar', '16000',
          '-ac', '1',
          '-c:a', 'pcm_s16le',
          outFile
        ]);
        
        link.stdout.pipe(ffmpeg.stdin);
        
        let done = false;
        ffmpeg.on('close', async () => {
          if (done) return;
          done = true;
          if (stopped) return;
          
          try {
            const stat = fs.statSync(outFile);
            if (stat.size > 5000) {
              const audio = fs.readFileSync(outFile);
              const text = await groq.audio.transcriptions.create({
                file: new File([audio], 'audio.wav', { type: 'audio/wav' }),
                language: 'ru'
              });
              
              const transcript = (text as any)?.text?.trim();
              if (transcript && transcript.length > 10) {
                console.log('[learn] Transcript heard:', transcript.slice(0, 80));
                this.onTranscript(transcript);
                this.emit('learn:transcript', transcript);
              }
            }
          } catch (e: any) {
            // silent fail - stream might be offline
          }
          try { fs.unlinkSync(outFile); } catch {}
          setTimeout(capture, 3000);
        });
      } catch (e: any) {
        setTimeout(capture, 10000);
      }
    };
    
    capture();
    this.emit('learn:log', 'Транскрипция включена');
  }

  stop(): void {
    // Stop transcription
    this.running = false;
    
    for (const bot of this.clients) {
      try {
        bot.client.disconnect();
      } catch (e) {}
    }
    this.clients = [];
    this.running = false;
    this.emit('learn:log', 'Обучение остановлено');
    this.emit('learn:status', {
      running: false,
      messages: this.messages,
      words: this.words,
    });
  }

  private learn(text: string): void {
    const words = text.trim().split(/\s+/).filter(w => w.length > 0 && !w.startsWith('http'));
    if (words.length < 2) return;

    this.words += words.length;

    for (let i = 0; i <= words.length - this.keyLength; i++) {
      const key = words.slice(i, i + this.keyLength).join(' ');
      const next = words[i + this.keyLength];

      if (i === 0) {
        this.starts.push(key);
      }

      if (!this.chain[key]) {
        this.chain[key] = [];
      }
      this.chain[key].push(next);
    }
  }

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

  generateWithContext(context: string, minWords: number = 5): string {
    if (Object.keys(this.chain).length === 0) return '';
    
    const contextWords = context.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const matchingStarts: string[] = [];
    
    for (const word of contextWords) {
      for (const start of this.starts) {
        if (start.toLowerCase().includes(word)) {
          matchingStarts.push(start);
        }
      }
    }
    
    let result = '';
    if (matchingStarts.length > 0) {
      result = this.generate(matchingStarts[Math.floor(Math.random() * matchingStarts.length)]);
    }
    
    if (!result || result.split(' ').length < minWords) {
      result = this.generate();
    }
    
    return result;
  }

  getTopPhrases(count: number = 10): string[] {
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

  hasEnoughData(minMessages: number = 100): boolean {
    return this.messages >= minMessages;
  }

  getData() {
    return {
      chain: this.chain,
      starts: this.starts,
      transcriptChain: this.transcriptChain,
      transcriptStarts: this.transcriptStarts,
      messages: this.messages,
      words: this.words,
      uniqueWords: Object.keys(this.chain).length,
    };
  }

  generatePreview(count: number = 5): string[] {
    const results: string[] = [];
    for (let i = 0; i < count; i++) {
      const gen = this.generate();
      if (gen) results.push(gen);
    }
    return results;
  }

  saveToFile(filepath: string): void {
    const data = {
      chain: this.chain,
      starts: this.starts,
      messages: this.messages,
      words: this.words,
    };
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
    this.emit('learn:log', `Сохранено в ${filepath}`);
  }

  getStats() {
    return {
      messages: this.messages,
      words: this.words,
      uniqueWords: Object.keys(this.chain).length,
      running: this.running,
    };
  }

  loadData(data: { chain: MarkovChain; starts: string[]; messages: number; words: number; transcriptChain?: MarkovChain; transcriptStarts?: string[] }): void {
    this.chain = data.chain || {};
    this.starts = data.starts || [];
    this.transcriptChain = data.transcriptChain || {};
    this.transcriptStarts = data.transcriptStarts || [];
    this.messages = data.messages || 0;
    this.words = data.words || 0;
    console.log('[learn] Loaded data:', this.messages, 'messages,', Object.keys(this.chain).length, 'chains,', Object.keys(this.transcriptChain).length, 'transcript chains');
  }
}