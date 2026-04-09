import Groq from 'groq-sdk';

// Custom persona override by username (lowercase)
const CUSTOM_PERSONAS: Record<string, { sys: string }> = {
  'olegzhoskii': {
    sys: `Ти — Олег, 15-річний українець, школяр, фанат стримера. Пишеш ТІЛЬКИ українською мовою (не російською!). 
Стиль: як підліток — коротко, емоційно, іноді помилки в словах, використовуєш "бро", "топ", "лол", "кайф", "gg", "пг".
Приклади: "топ момент бро!", "лол він зафейлив", "кайфова гра", "gg wp", "оце так поворот лол", "бро ти кращий"
Максимум 10 слів. ТІЛЬКИ українська!`,
  },
};

const DEFAULT_PERSONAS = [
  { role: 'hype_fan',   sys: 'Excited Twitch viewer. Short hyped reactions. PogChamp energy. 2-8 words.' },
  { role: 'chill',      sys: 'Chill Twitch viewer. Casual brief comments. Uses lol/lmao. 2-10 words.' },
  { role: 'gamer',      sys: 'Experienced gamer watching stream. Short tactical comments. 3-12 words.' },
  { role: 'comedian',   sys: 'Funny Twitch viewer. Light jokes. Never mean. 2-12 words.' },
  { role: 'newbie',     sys: 'New curious viewer. Amazed reactions and short questions. 2-10 words.' },
  { role: 'analyst',    sys: 'Calm analytical viewer. Brief smart observations. 3-12 words.' },
  { role: 'hype_train', sys: 'Hype train viewer. Rally chat. Short energetic bursts. CAPS OK. 2-6 words.' },
  { role: 'supporter',  sys: 'Loyal supporter. Short encouraging messages. 2-10 words.' },
];

const PROACTIVE = [
  'React to a moment in the stream.',
  'Comment on the gameplay.',
  'Share a quick thought about the stream.',
  'React to what just happened.',
  'Write something you\'d genuinely type watching this.',
  'Comment on the streamer\'s play.',
  'React to the current game situation.',
];

export interface TranscriptEntry {
  username: string;
  message: string;
  trigger: string;
  persona: string;
  timestamp: number;
}

interface Msg { role: 'user' | 'assistant'; content: string; }

export class AIService {
  private groq: Groq;
  private histories = new Map<string, Msg[]>();
  private recentChat: string[] = [];
  private settings: Record<string, boolean>;
  public transcriptLog: TranscriptEntry[] = [];

  constructor(apiKey: string, settings: Record<string, boolean> = {}) {
    this.groq = new Groq({ apiKey });
    this.settings = settings;
  }

  addChatContext(line: string): void {
    this.recentChat.push(line);
    if (this.recentChat.length > 12) this.recentChat.shift();
  }

  async generateMessage(
    username: string,
    context: string,
    language: string,
    botIndex = 0,
    isReactive = false,
    replyToMsg?: string   // when someone @tagged this bot
  ): Promise<string> {
    const key = username.toLowerCase();
    const custom = CUSTOM_PERSONAS[key];
    const persona = custom
      ? { role: key, sys: custom.sys }
      : DEFAULT_PERSONAS[botIndex % DEFAULT_PERSONAS.length];

    // Custom personas always use their own language
    const lang = custom
      ? '' // language forced in sys prompt
      : (language === 'ru' ? 'Russian' : language === 'kk' ? 'Kazakh' : 'English');

    const emojiLine = this.settings.useEmoji
      ? 'Occasionally use Twitch emotes (LUL Pog KEKW PogChamp) or emojis.' : '';

    let ctxBlock = context ? '\nStream context: ' + context : '';
    if (this.recentChat.length > 0) {
      ctxBlock += '\nRecent chat:\n' + this.recentChat.slice(-4).join('\n');
    }

    let trigger: string;
    if (replyToMsg) {
      trigger = 'Someone tagged you in chat: "' + replyToMsg + '". Reply naturally in 1-2 sentences.';
    } else if (isReactive) {
      trigger = 'React to the recent chat messages above. One natural reply.';
    } else {
      trigger = PROACTIVE[Math.floor(Math.random() * PROACTIVE.length)];
    }

    const system = [
      persona.sys,
      lang ? 'ALWAYS write in ' + lang + ' only.' : '',
      emojiLine,
      ctxBlock,
      'Output ONLY the chat message. No quotes. No username prefix. Max 20 words.',
      'Never repeat previous messages. Sound like a real human viewer.',
    ].filter(Boolean).join('\n');

    const history = this.histories.get(username) || [];

    try {
      const res = await this.groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        max_tokens: 50,
        temperature: 0.97,
        frequency_penalty: 1.3,
        presence_penalty: 1.0,
        messages: [
          { role: 'system', content: system },
          ...history.slice(-4),
          { role: 'user' as const, content: trigger },
        ],
      });

      const raw = (res.choices[0]?.message?.content || '').trim()
        .replace(/^["'`*_]+|["'`*_]+$/g, '')
        .replace(/^\w+:\s*/, '')
        .trim();

      if (!raw || raw.length < 2) return this.fallback(language, !!custom);

      const updated: Msg[] = [
        ...history,
        { role: 'user' as const, content: trigger },
        { role: 'assistant' as const, content: raw },
      ].slice(-8);
      this.histories.set(username, updated);

      // Log for transcription view
      this.transcriptLog.push({
        username,
        message: raw,
        trigger: replyToMsg ? '@reply: ' + replyToMsg : (isReactive ? 'reactive' : trigger),
        persona: persona.role,
        timestamp: Date.now(),
      });
      if (this.transcriptLog.length > 200) this.transcriptLog.shift();

      console.log('[ai]', username, '(' + persona.role + ')', '→', raw);
      return raw.slice(0, 200);
    } catch (e: any) {
      console.error('[ai] error for', username, ':', e.message);
      return this.fallback(language, !!custom);
    }
  }

  private fallback(lang: string, isUkrainian = false): string {
    if (isUkrainian) {
      const uk = ['gg', 'топ', 'лол', 'кайф', 'бро', 'пг', 'оце так'];
      return uk[Math.floor(Math.random() * uk.length)];
    }
    const f: Record<string, string[]> = {
      ru: ['gg', 'лол', 'давай!', 'ого', 'красавчик', 'нис', '🔥', 'норм'],
      en: ['gg', 'lol', 'nice', 'Pog', 'let\'s go', 'GG', 'hype'],
      kk: ['жарайсың', 'gg', 'алға', 'нис'],
    };
    const arr = f[lang] || f.en;
    return arr[Math.floor(Math.random() * arr.length)];
  }
}
