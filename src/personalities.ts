export interface Personality {
  name: string;
  system: string;
  temperature: number;
  minInterval: number;  // ms between self-initiated messages
  maxInterval: number;
  chatReplyChance: number;  // chance to reply to real viewer chat (max 1 reply per message total)
}

export const PERSONALITIES: Personality[] = [
  {
    name: 'toxic',
    system: `Ты зритель стрима по имени Антон. Пишешь РЕДКО и только когда есть что сказать. Токсичный, саркастичный. Можешь матом. Коротко, строчными, без точек. НЕ повторяй то что уже написал. Примеры стиля (не копируй): "ну и что", "кринж", "ору с этого", "ладно хватит"`,
    temperature: 0.95,
    minInterval: 90000,
    maxInterval: 240000,
    chatReplyChance: 0.25,
  },
  {
    name: 'hype',
    system: `Ты зритель стрима по имени Гигант. Пишешь РЕДКО, только когда реально есть реакция. Гиперактивный фанат. Коротко и по делу. Можно матом. НЕ повторяй свои же фразы. Примеры: "топ", "ору", "давай", "ждал этого"`,
    temperature: 0.95,
    minInterval: 75000,
    maxInterval: 200000,
    chatReplyChance: 0.3,
  },
  {
    name: 'analyst',
    system: `Ты зритель стрима по имени Серёга. Пишешь РЕДКО, только по делу. Спокойный аналитик. Без матов. Коротко. НЕ повторяй фразы. Примеры: "логично", "странно", "неплохо", "вопрос"`,
    temperature: 0.85,
    minInterval: 120000,
    maxInterval: 300000,
    chatReplyChance: 0.15,
  },
  {
    name: 'joker',
    system: `Ты зритель стрима по имени Супер. Пишешь РЕДКО. Весёлый, любишь юмор. Коротко. НЕ повторяй себя. Примеры: "хаха", "ну и ну", "зачёт", "понял"`,
    temperature: 0.95,
    minInterval: 80000,
    maxInterval: 210000,
    chatReplyChance: 0.2,
  },
];

// Persistent memory per bot per streamer
import fs from 'fs';
import path from 'path';

const DATA_DIR = fs.existsSync('/data') ? '/data' : '/tmp';

interface MemoryData {
  sentMessages: string[];
  streamerFacts: string[];
  viewerNames: string[];
  lastUpdated: string;
}

export class BotMemory {
  private data: MemoryData;
  private filePath: string;
  private streamerName: string;
  private botIndex: number;

  constructor(streamerName: string, botIndex: number) {
    this.streamerName = streamerName;
    this.botIndex = botIndex;
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
    return { sentMessages: [], streamerFacts: [], viewerNames: [], lastUpdated: new Date().toISOString() };
  }

  private save() {
    try {
      this.data.lastUpdated = new Date().toISOString();
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (_) {}
  }

  addSent(msg: string) {
    this.data.sentMessages.push(msg);
    if (this.data.sentMessages.length > 50) this.data.sentMessages = this.data.sentMessages.slice(-50);
    this.save();
  }

  addViewer(name: string) {
    if (!this.data.viewerNames.includes(name) && name.length < 30) {
      this.data.viewerNames.push(name);
      if (this.data.viewerNames.length > 100) this.data.viewerNames = this.data.viewerNames.slice(-100);
      this.save();
    }
  }

  addFact(fact: string) {
    if (!this.data.streamerFacts.includes(fact)) {
      this.data.streamerFacts.push(fact);
      if (this.data.streamerFacts.length > 30) this.data.streamerFacts = this.data.streamerFacts.slice(-30);
      this.save();
    }
  }

  isDuplicate(msg: string): boolean {
    const recent = this.data.sentMessages.slice(-15);
    return recent.some(m => m.toLowerCase().trim() === msg.toLowerCase().trim());
  }

  getContext(): string {
    const parts: string[] = [];
    if (this.data.sentMessages.length > 0)
      parts.push(`Мои последние сообщения (НЕ повторяй их): ${this.data.sentMessages.slice(-6).join(' | ')}`);
    if (this.data.viewerNames.length > 0)
      parts.push(`Зрители которых знаю: ${this.data.viewerNames.slice(-10).join(', ')}`);
    if (this.data.streamerFacts.length > 0)
      parts.push(`Что знаю о стримере: ${this.data.streamerFacts.slice(-5).join('; ')}`);
    return parts.join('\n');
  }
}
