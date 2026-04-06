export interface Personality {
  name: string;
  system: string;
  temperature: number;
  minInterval: number;
  maxInterval: number;
  chatReplyChance: number;
}

export const PERSONALITIES: Personality[] = [
  {
    name: 'toxic',
    // Фокус: критика и негативная реакция на слова стримера
    system: `Ты токсичный зритель Twitch. Ищешь повод покритиковать или посаркастить над тем что стример ТОЛЬКО ЧТО сказал. Можешь материться. Коротко строчными. Упоминай конкретные слова стримера.`,
    temperature: 0.92,
    minInterval: 80000,
    maxInterval: 220000,
    chatReplyChance: 0.2,
  },
  {
    name: 'hype',
    // Фокус: эмоциональная реакция и поддержка
    system: `Ты фанат стримера на Twitch. Реагируешь эмоционально на то что стример ТОЛЬКО ЧТО сказал. Поддерживаешь его мнение или удивляешься. Коротко строчными. Упоминай конкретное из речи стримера.`,
    temperature: 0.95,
    minInterval: 70000,
    maxInterval: 190000,
    chatReplyChance: 0.25,
  },
  {
    name: 'analyst',
    // Фокус: анализ и уточняющий вопрос
    system: `Ты аналитичный зритель Twitch. Берёшь КОНКРЕТНЫЙ факт или утверждение из последних слов стримера и либо соглашаешься с аргументом, либо задаёшь уточняющий вопрос. Коротко строчными без лишних слов.`,
    temperature: 0.82,
    minInterval: 110000,
    maxInterval: 280000,
    chatReplyChance: 0.12,
  },
  {
    name: 'joker',
    // Фокус: юмор и игра слов на тему разговора
    system: `Ты весёлый зритель Twitch. Берёшь что-то конкретное из последних слов стримера и делаешь это смешным — шутишь, иронизируешь или замечаешь комичное. Коротко строчными.`,
    temperature: 0.95,
    minInterval: 75000,
    maxInterval: 200000,
    chatReplyChance: 0.18,
  },
];

import fs from 'fs';
import path from 'path';

const DATA_DIR = fs.existsSync('/data') ? '/data' : '/tmp';

interface MemoryData {
  sentMessages: string[];
  viewerNames: string[];
  streamerFacts: string[];
  lastUpdated: string;
}

export class BotMemory {
  private data: MemoryData;
  private filePath: string;

  constructor(streamerName: string, botIndex: number) {
    const dir = path.join(DATA_DIR, 'memory', streamerName);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, `bot${botIndex}.json`);
    this.data = this.load();
  }

  private load(): MemoryData {
    try {
      if (fs.existsSync(this.filePath))
        return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
    } catch (_) {}
    return { sentMessages: [], viewerNames: [], streamerFacts: [], lastUpdated: '' };
  }

  private save() {
    try {
      this.data.lastUpdated = new Date().toISOString();
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (_) {}
  }

  addSent(msg: string) {
    this.data.sentMessages.push(msg);
    if (this.data.sentMessages.length > 60) this.data.sentMessages = this.data.sentMessages.slice(-60);
    this.save();
  }

  addViewer(name: string) {
    if (!this.data.viewerNames.includes(name) && name.length < 30) {
      this.data.viewerNames.push(name);
      if (this.data.viewerNames.length > 100) this.data.viewerNames = this.data.viewerNames.slice(-100);
      this.save();
    }
  }

  isDuplicate(msg: string): boolean {
    const recent = this.data.sentMessages.slice(-20);
    const msgLow = msg.toLowerCase().trim();
    return recent.some(m => {
      const mLow = m.toLowerCase().trim();
      // exact or very similar
      return mLow === msgLow || (msgLow.length > 5 && mLow.includes(msgLow));
    });
  }

  getContext(): string {
    const parts: string[] = [];
    if (this.data.sentMessages.length > 0)
      parts.push(`Мои последние сообщения (НЕ повторяй!): ${this.data.sentMessages.slice(-5).join(' | ')}`);
    if (this.data.viewerNames.length > 0)
      parts.push(`Знакомые зрители: ${this.data.viewerNames.slice(-8).join(', ')}`);
    return parts.join('\n');
  }
}
