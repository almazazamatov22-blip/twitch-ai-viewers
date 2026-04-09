import Groq from 'groq-sdk';

// Each bot persona - deterministic by index so they never collide
const PERSONAS: { role: string; sys: string }[] = [
  {
    role: 'hype_fan',
    sys: `You are an excited Twitch chat viewer. You react to what's happening in the stream with short hyped messages.
Examples: "LET'S GOOO", "ПОГНАЛИ", "ПОГС", "AAAA", "🔥🔥🔥", "ЭТО МОЩЬ"
2-8 words. Very energetic. Use Twitch emotes sometimes.`,
  },
  {
    role: 'chill_viewer',
    sys: `You are a chill Twitch viewer. Casual short comments about the stream.
Examples: "лол", "норм", "gg", "хм интересно", "lmao", "это было нормально"
2-10 words. Relaxed tone. No hype.`,
  },
  {
    role: 'gamer',
    sys: `You are an experienced gamer watching Twitch. Short tactical/game comments.
Examples: "надо было пушить", "классный билд", "gg wp", "это работает кстати"
3-12 words. Show game knowledge.`,
  },
  {
    role: 'comedian',
    sys: `You are a funny Twitch viewer. Light jokes and playful comments.
Examples: "лол это была случайность да", "KEKW он это серьезно", "streamer.exe has stopped"
2-12 words. Funny but kind.`,
  },
  {
    role: 'newbie',
    sys: `You are a new viewer on Twitch. Curious and amazed by what happens.
Examples: "ого как это он сделал??", "а можно так?", "это нормально??", "вау"
2-10 words. Genuine reactions.`,
  },
  {
    role: 'analyst',
    sys: `You are a calm analytical viewer. Short smart observations about the stream.
Examples: "интересное решение", "статистически спорно", "хороший тайминг", "правильная ротация"
3-12 words.`,
  },
  {
    role: 'hype_train',
    sys: `You are a hype train in Twitch chat. Rally everyone, short energetic bursts.
Examples: "ЧАААААТ", "ДАВАЙ ДАВАЙ", "СТРИМ ОГОНЬ", "ВСЕ В ЧАТ", "ПОЕХАЛИ"
2-6 words. CAPS OK.`,
  },
  {
    role: 'supporter',
    sys: `You are a loyal supporter of the streamer. Encouraging short messages.
Examples: "красавчик", "так держать", "лучший стример", "ты справишься", "мы верим"
2-10 words. Warm and supportive.`,
  },
];

// Proactive triggers — bot messages NOT based on chat, based on stream
const PROACTIVE_PROMPTS = [
  'React to a moment that just happened in the stream.',
  'Comment on something you noticed in the game/stream.',
  'Share a quick thought about the stream so far.',
  'React to the gameplay you are watching.',
  'Say something you genuinely think while watching this stream.',
  'Write a message that fits the energy of the stream right now.',
  'Comment on the streamer\'s play or decision.',
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
    if (this.recentChat.length > 12) this.recentChat.shift();
  }

  async generateMessage(
    username: string,
    context: string,
    language: string,
    botIndex = 0,
    isReactive = false   // true = reacting to chat, false = proactive stream comment
  ): Promise<string> {
    const persona = PERSONAS[botIndex % PERSONAS.length];
    const lang = language === 'ru' ? 'Russian' : language === 'kk' ? 'Kazakh' : 'English';
    const emojiLine = this.settings.useEmoji
      ? 'Occasionally use Twitch emotes (LUL Pog KEKW monkaS PogChamp) or fitting emojis.'
      : 'No emojis.';

    // Build context block
    let ctxBlock = '';
    if (context) ctxBlock += '\nStream info: ' + context;
    if (this.recentChat.length > 0 && isReactive) {
      ctxBlock += '\nRecent chat:\n' + this.recentChat.slice(-5).join('\n');
    } else if (this.recentChat.length > 0) {
      // Just the last message for awareness, not for reacting
      ctxBlock += '\n(Latest chat: ' + this.recentChat[this.recentChat.length - 1] + ')';
    }

    // Pick a proactive prompt randomly when not reactive
    const trigger = isReactive
      ? 'React to the recent chat messages above. Write one natural reply.'
      : PROACTIVE_PROMPTS[Math.floor(Math.random() * PROACTIVE_PROMPTS.length)];

    const system = [
      persona.sys,
      'ALWAYS write in ' + lang + ' only. Never switch language.',
      emojiLine,
      ctxBlock,
      'RULES: Output ONLY the chat message. No username prefix. No quotes. Max 20 words.',
      'Make it feel like a real human viewer typed this spontaneously.',
      'Never repeat what you said before.',
    ].join('\n');

    const history = this.histories.get(username) || [];

    try {
      const res = await this.groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        max_tokens: 40,
        temperature: 1.0,
        frequency_penalty: 1.4,
        presence_penalty: 1.1,
        messages: [
          { role: 'system', content: system },
          ...history.slice(-4),
          { role: 'user' as const, content: trigger },
        ],
      });

      const raw = (res.choices[0]?.message?.content || '').trim()
        .replace(/^["'`*_]+|["'`*_]+$/g, '')
        .replace(/^\w+:\s*/, '') // strip "username: " prefix if AI added it
        .trim();

      if (!raw || raw.length < 2) return this.fallback(language);

      // Store for dedup
      const updated: Msg[] = [
        ...history,
        { role: 'user' as const, content: trigger },
        { role: 'assistant' as const, content: raw },
      ].slice(-8);
      this.histories.set(username, updated);

      console.log('[ai]', username, `(${persona.role}${isReactive ? '/reactive' : '/proactive'})`, '→', raw);
      return raw.slice(0, 200);
    } catch (e: any) {
      console.error('[ai] error for', username, ':', e.message);
      return this.fallback(language);
    }
  }

  private fallback(lang: string): string {
    const f: Record<string, string[]> = {
      ru: ['gg', 'лол', 'давай!', 'ого', 'красавчик', 'нис', 'пог', '🔥', 'KEKW', 'норм'],
      en: ['gg', 'lol', 'nice', 'Pog', 'let\'s go', 'GG', 'hype', 'yoo', 'KEKW'],
      kk: ['жарайсың', 'gg', 'алға', 'нис', 'ого'],
    };
    const arr = f[lang] || f.en;
    return arr[Math.floor(Math.random() * arr.length)];
  }
}
