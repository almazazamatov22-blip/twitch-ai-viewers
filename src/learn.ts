import * as tmi from 'tmi.js';
import * as fs from 'fs';
import * as path from 'path';

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
  private keyLength = 2;
  private messages = 0;
  private words = 0;
  private running = false;
  private emit: (event: string, data: any) => void;

  constructor(emit: (event: string, data: any) => void) {
    this.emit = emit;
  }

  async start(channel: string, tokens: string[]): Promise<void> {
    if (this.running) return;
    
    const chan = channel.toLowerCase().replace(/^#/, '');
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

  stop(): void {
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

  loadData(data: { chain: MarkovChain; starts: string[]; messages: number; words: number }): void {
    this.chain = data.chain || {};
    this.starts = data.starts || [];
    this.messages = data.messages || 0;
    this.words = data.words || 0;
    console.log('[learn] Loaded data:', this.messages, 'messages,', Object.keys(this.chain).length, 'unique chains');
  }
}