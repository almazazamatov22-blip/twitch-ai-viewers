import Groq from 'groq-sdk';

// Default personas by bot index — can be overridden at runtime per username
const DEFAULT_PERSONAS: { role: string; sys: string }[] = [
  { role: 'hype_fan',   sys: 'You are an excited Twitch viewer. Short hyped reactions. PogChamp energy. 2-8 words.' },
  { role: 'chill',      sys: 'You are a chill Twitch viewer. Casual brief comments. lol/lmao. 2-10 words.' },
  { role: 'gamer',      sys: 'You are an experienced gamer watching stream. Short tactical comments. 3-12 words.' },
  { role: 'comedian',   sys: 'You are a funny viewer. Light jokes. Never mean. 2-12 words.' },
  { role: 'newbie',     sys: 'You are a new curious viewer. Amazed reactions and short questions. 2-10 words.' },
  { role: 'analyst',    sys: 'You are a calm analytical viewer. Brief smart observations. 3-12 words.' },
  { role: 'hype_train', sys: 'You are a hype train viewer. Rally chat. Short energetic bursts. CAPS OK. 2-6 words.' },
  { role: 'supporter',  sys: 'You are a loyal supporter. Short encouraging messages. 2-10 words.' },
];

// Built-in custom persona for olegzhoskii
const BUILTIN_CUSTOM: Record<string, { role: string; sys: string }> = {
  'olegzhoskii': {
    role: 'ukrainian_teen',
    sys: `Ти — Олег, 15-річний українець-школяр, фанат стримера. Пишеш ТІЛЬКИ українською (не російською!).
Стиль підлітка: коротко, емоційно, іноді помилки, "бро", "топ", "лол", "кайф", "gg", "пг".
Приклади: "топ момент бро!", "лол він зафейлив", "кайфова гра gg", "оце так поворот лол"
Максимум 8 слів. ТІЛЬКИ українська!`,
  },
};

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
  // Runtime persona overrides: username -> {role, sys}
  private customPersonas = new Map<string, { role: string; sys: string }>();
  public transcriptLog: TranscriptEntry[] = [];

  constructor(apiKey: string, settings: Record<string, boolean> = {}) {
    this.groq = new Groq({ apiKey });
    this.settings = settings;
    // Load built-in customs
    for (const [k, v] of Object.entries(BUILTIN_CUSTOM)) {
      this.customPersonas.set(k, v);
    }
  }

  setPersona(username: string, roleLabel: string, systemPrompt: string): void {
    this.customPersonas.set(username.toLowerCase(), { role: roleLabel, sys: systemPrompt });
    // Reset history so new persona takes effect immediately
    this.histories.delete(username);
    this.histories.delete(username.toLowerCase());
    console.log('[ai] persona updated for', username, ':', roleLabel);
  }

  getPersonas(): Record<string, { role: string; sys: string }> {
    const out: Record<string, { role: string; sys: string }> = {};
    for (const [k, v] of this.customPersonas) out[k] = v;
    return out;
  }

  getPersonaFor(username: string): { role: string; sys: string } {
    const key = username.toLowerCase();
    const custom = this.customPersonas.get(key);
    if (custom) return custom;
    return { role: 'default', sys: '' };
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
    taggedMessage?: string  // only set when bot was @mentioned
  ): Promise<string> {
    const key = username.toLowerCase();
    const custom = this.customPersonas.get(key);
    const defaultP = DEFAULT_PERSONAS[botIndex % DEFAULT_PERSONAS.length];
    const persona = custom || defaultP;
    const isCustomLang = !!custom; // custom personas manage their own language

    const lang = isCustomLang ? '' : (language === 'ru' ? 'Russian' : language === 'kk' ? 'Kazakh' : 'English');
    const emojiLine = this.settings.useEmoji ? 'Occasionally use Twitch emotes (LUL Pog KEKW PogChamp) or emojis.' : '';

    const ctxBlock = [
      context ? 'Stream: ' + context : '',
      this.recentChat.length ? 'Recent chat:\n' + this.recentChat.slice(-5).join('\n') : '',
    ].filter(Boolean).join('\n');

    let trigger: string;
    if (taggedMessage) {
      trigger = 'Someone tagged you in: "' + taggedMessage + '". Reply naturally, 1-2 sentences max.';
    } else {
      // Proactive — random stream-aware trigger
      const proactive = [
        'React to the current moment in the stream.',
        'Comment on what just happened in the game.',
        'Write a natural viewer message about the stream.',
        'Share a quick thought about the gameplay.',
        'React to what the streamer just did.',
        'Write something a real viewer would type watching this.',
        'Comment on the game situation.',
      ];
      trigger = proactive[Math.floor(Math.random() * proactive.length)];
    }

    const system = [
      persona.sys,
      lang ? 'ALWAYS write in ' + lang + ' only.' : '',
      emojiLine,
      ctxBlock,
      'Output ONLY the chat message. No quotes. No username prefix. Max 20 words.',
      'Never repeat previous messages. Sound like a real human viewer.',
    ].filter(Boolean).join('\n');

    const history = this.histories.get(key) || [];

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

      if (!raw || raw.length < 2) return this.fallback(language, isCustomLang);

      const updated: Msg[] = [
        ...history,
        { role: 'user' as const, content: trigger },
        { role: 'assistant' as const, content: raw },
      ].slice(-6);
      this.histories.set(key, updated);

      this.transcriptLog.push({
        username,
        message: raw,
        trigger: taggedMessage ? '@tag: ' + taggedMessage : trigger,
        persona: persona.role,
        timestamp: Date.now(),
      });
      if (this.transcriptLog.length > 200) this.transcriptLog.shift();

      return raw.slice(0, 200);
    } catch (e: any) {
      console.error('[ai] error for', username, ':', e.message);
      return this.fallback(language, isCustomLang);
    }
  }

  private fallback(lang: string, isUkrainian = false): string {
    if (isUkrainian) return ['gg', 'топ', 'лол', 'кайф', 'бро', 'пг'][Math.floor(Math.random() * 6)];
    const f: Record<string, string[]> = {
      ru: ['gg', 'лол', 'давай!', 'ого', 'красавчик', '🔥', 'норм'],
      en: ['gg', 'lol', 'nice', 'Pog', 'GG', 'hype'],
      kk: ['жарайсың', 'gg', 'алға'],
    };
    const arr = f[lang] || f.en;
    return arr[Math.floor(Math.random() * arr.length)];
  }
}
