import Groq from 'groq-sdk';

const PERSONAS = [
  { style: 'enthusiastic hype fan',   traits: 'Very excited, short reactions, PogChamp/LUL, hyped every play' },
  { style: 'chill lurker',            traits: 'Relaxed, brief comments, uses "lol" "lmao", casual tone' },
  { style: 'strategic advisor',       traits: 'Gives tactical tips, game knowledge, constructive' },
  { style: 'friendly comedian',       traits: 'Makes jokes, puns, light-hearted, never mean' },
  { style: 'curious newbie',          traits: 'Asks questions, gets amazed easily, learning' },
  { style: 'nostalgic veteran',       traits: 'Compares to old games, experienced, brief insights' },
  { style: 'hype train conductor',    traits: 'CAPS sometimes, rallies chat, LET\'S GO energy' },
  { style: 'calm analyst',            traits: 'Measured observations, concise, precise' },
];

interface HistoryMsg { role: 'user' | 'assistant'; content: string; }

export class AIService {
  private groq: Groq;
  private histories = new Map<string, HistoryMsg[]>();
  private recentChat: string[] = [];
  private settings: Record<string, boolean>;

  constructor(apiKey: string, settings: Record<string, boolean> = {}) {
    this.groq = new Groq({ apiKey });
    this.settings = settings;
  }

  addChatContext(line: string): void {
    this.recentChat.push(line);
    if (this.recentChat.length > 10) this.recentChat.shift();
  }

  async generateMessage(username: string, context: string, language: string, botIndex = 0): Promise<string> {
    const persona = PERSONAS[botIndex % PERSONAS.length];
    const langName = language === 'ru' ? 'Russian' : language === 'kk' ? 'Kazakh' : 'English';
    const emojiLine = this.settings.useEmoji
      ? 'Occasionally use Twitch emotes: LUL Pog KEKW monkaS or simple emojis.'
      : 'Do not use emojis.';
    const ctxLine = this.settings.chatContext && this.recentChat.length
      ? '\nRecent chat:\n' + this.recentChat.slice(-4).join('\n') : '';

    const system = [
      'You are "' + username + '", a Twitch viewer with a specific personality.',
      'Personality: ' + persona.style + '. Traits: ' + persona.traits + '.',
      'ALWAYS write in ' + langName + ' only.',
      'Message MUST be 2-15 words. Be human, varied, never repeat yourself.',
      emojiLine,
      'Stream context: ' + (context || 'gaming stream') + '.' + ctxLine,
      'Output ONLY the chat message text. No quotes, no explanation, no username prefix.',
    ].join('\n');

    const history = this.histories.get(username) || [];

    try {
      const res = await this.groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        max_tokens: 40,
        temperature: 0.95,
        frequency_penalty: 1.2,
        presence_penalty: 0.9,
        messages: [
          { role: 'system', content: system },
          ...history.slice(-6),
          { role: 'user' as const, content: 'Post a chat message.' },
        ],
      });

      const raw = (res.choices[0]?.message?.content || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
      if (!raw) return this.fallback(language);

      const newHistory: HistoryMsg[] = [
        ...history,
        { role: 'user' as const, content: 'Post a chat message.' },
        { role: 'assistant' as const, content: raw },
      ].slice(-8);
      this.histories.set(username, newHistory);

      return raw.slice(0, 200);
    } catch (e: any) {
      console.error('[ai] error for', username, ':', e.message);
      return this.fallback(language);
    }
  }

  private fallback(lang: string): string {
    const f: Record<string, string[]> = {
      ru: ['gg', 'лол', 'давай!', 'ого', 'красавчик', 'нис', 'хорошо', 'пог', 'алё'],
      en: ['gg', 'lol', 'nice!', 'Pog', 'let\'s go', 'GG', 'hype', 'yoo'],
      kk: ['жарайсың', 'gg', 'алға!', 'нис'],
    };
    const arr = f[lang] || f.en;
    return arr[Math.floor(Math.random() * arr.length)];
  }
}
