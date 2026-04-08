import Groq from 'groq-sdk';

// Each bot index gets a fixed personality
const PERSONAS = [
  { name: 'hype_fan',     sys: 'You are an excited Twitch viewer. Short hyped reactions. PogChamp energy. 2-10 words.' },
  { name: 'chill',        sys: 'You are a chill Twitch viewer. Brief casual comments. Use lol/lmao sometimes. 2-12 words.' },
  { name: 'gamer',        sys: 'You are an experienced gamer watching Twitch. Give short game tips or observations. 3-15 words.' },
  { name: 'comedian',     sys: 'You are a funny Twitch viewer. Light jokes and puns. Never mean. 2-12 words.' },
  { name: 'newbie',       sys: 'You are a curious new viewer. Ask short questions or react with amazement. 2-12 words.' },
  { name: 'analyst',      sys: 'You are a thoughtful Twitch viewer. Brief strategic observations. 3-15 words.' },
  { name: 'hype_train',   sys: 'You are a hype train Twitch viewer. Rally the chat. Energetic short messages. 2-10 words.' },
  { name: 'veteran',      sys: 'You are a veteran gamer watching Twitch. Nostalgic short comments. 2-12 words.' },
];

interface Msg { role: 'user' | 'assistant'; content: string; }

export class AIService {
  private groq: Groq;
  private histories = new Map<string, Msg[]>();
  private recentChat: string[] = [];
  private settings: Record<string, boolean>;

  constructor(apiKey: string, settings: Record<string, boolean> = {}) {
    this.groq = new Groq({ apiKey });
    this.settings = settings;
  }

  addChatContext(line: string): void {
    this.recentChat.push(line);
    if (this.recentChat.length > 8) this.recentChat.shift();
  }

  async generateMessage(username: string, context: string, language: string, botIndex = 0): Promise<string> {
    const persona = PERSONAS[botIndex % PERSONAS.length];
    const lang = language === 'ru' ? 'Russian' : language === 'kk' ? 'Kazakh' : 'English';
    const emoji = this.settings.useEmoji
      ? 'Occasionally use Twitch emotes: LUL Pog KEKW monkaS or emojis.' : 'No emojis.';
    const ctx = this.recentChat.length && this.settings.chatContext
      ? '\nChat context: ' + this.recentChat.slice(-3).join(' | ') : '';

    const system = persona.sys
      + '\nALWAYS write in ' + lang + ' only.'
      + '\n' + emoji
      + '\nStream: ' + (context || 'gaming stream') + '.' + ctx
      + '\nNEVER repeat previous messages. Output ONLY the chat text, nothing else.';

    const history = this.histories.get(username) || [];

    try {
      const res = await this.groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        max_tokens: 35,
        temperature: 0.97,
        frequency_penalty: 1.3,
        presence_penalty: 1.0,
        messages: [
          { role: 'system', content: system },
          ...history.slice(-4),
          { role: 'user' as const, content: 'Write one chat message now.' },
        ],
      });

      const raw = (res.choices[0]?.message?.content || '').trim()
        .replace(/^["'`]+|["'`]+$/g, '').trim();

      if (!raw || raw.length < 2) return this.fallback(language);

      const updated: Msg[] = [
        ...history,
        { role: 'user' as const, content: 'Write one chat message now.' },
        { role: 'assistant' as const, content: raw },
      ].slice(-6);
      this.histories.set(username, updated);

      console.log('[ai]', username, '(', persona.name, ') →', raw);
      return raw.slice(0, 200);
    } catch (e: any) {
      console.error('[ai] error for', username, ':', e.message);
      return this.fallback(language);
    }
  }

  private fallback(lang: string): string {
    const f: Record<string, string[]> = {
      ru: ['gg', 'лол', 'давай!', 'ого', 'красавчик', 'нис', 'пог', 'это было круто'],
      en: ['gg', 'lol', 'nice', 'Pog', 'let\'s go', 'GG', 'hype', 'yoo'],
      kk: ['жарайсың', 'gg', 'алға', 'нис'],
    };
    const arr = f[lang] || f.en;
    return arr[Math.floor(Math.random() * arr.length)];
  }
}
