import Groq from 'groq-sdk';

export interface TranscriptEntry {
  username: string;
  message: string;
  trigger: string;
  persona: string;
  timestamp: number;
}

interface Msg { role: 'user' | 'assistant'; content: string; }

export interface PersonaConfig {
  role: string;
  sys: string;
}

const BUILTIN: Record<string, PersonaConfig> = {
  'olegzhoskii': {
    role: 'ukrainian_teen',
    sys: `Ти — 15-річний українець-школяр, фанат стримера. ТІЛЬКИ українська мова.
Стиль: "бро", "топ", "лол", "кайф", "gg", "пг", помилки як школяр. Макс 8 слів.`,
  },
};

export class AIService {
  private groq: Groq;
  private histories = new Map<string, Msg[]>();
  private realChatSamples: string[] = [];   // real viewer messages for mimicry
  private settings: Record<string, boolean>;
  private customPersonas = new Map<string, PersonaConfig>();
  public transcriptLog: TranscriptEntry[] = [];

  constructor(apiKey: string, settings: Record<string, boolean> = {}, savedPersonas?: Record<string, PersonaConfig>) {
    this.groq = new Groq({ apiKey });
    this.settings = settings;
    // Load built-ins
    for (const [k, v] of Object.entries(BUILTIN)) this.customPersonas.set(k, v);
    // Load saved
    if (savedPersonas) {
      for (const [k, v] of Object.entries(savedPersonas)) this.customPersonas.set(k.toLowerCase(), v);
    }
  }

  setPersona(username: string, cfg: PersonaConfig): void {
    const k = username.toLowerCase();
    this.customPersonas.set(k, cfg);
    this.histories.delete(k);
  }

  getPersonas(): Record<string, PersonaConfig> {
    const out: Record<string, PersonaConfig> = {};
    for (const [k, v] of this.customPersonas) out[k] = v;
    return out;
  }

  // Called for every real viewer message
  addRealMessage(displayName: string, message: string): void {
    this.realChatSamples.push(displayName + ': ' + message);
    if (this.realChatSamples.length > 30) this.realChatSamples.shift();
  }

  async generateMessage(
    username: string,
    context: string,
    language: string,
    botIndex = 0,
    taggedMessage?: string
  ): Promise<string> {
    const k = username.toLowerCase();
    const custom = this.customPersonas.get(k);

    // --- Build system prompt ---
    let system: string;

    if (taggedMessage) {
      // Tag reply — simple and direct
      const lang = custom ? '' : (language === 'ru' ? 'Russian' : language === 'kk' ? 'Kazakh' : 'English');
      system = [
        custom ? custom.sys : `You are a Twitch viewer. Write in ${lang}. 1-2 sentences max.`,
        `Someone mentioned you: "${taggedMessage}"`,
        'Reply naturally and briefly. Output ONLY the reply text.',
      ].join('\n');
    } else if (this.realChatSamples.length >= 5) {
      // CORE STRATEGY: Learn from real chat and blend in perfectly
      const samples = this.realChatSamples.slice(-15);
      const lang = custom ? '' : (language === 'ru' ? 'Russian' : language === 'kk' ? 'Kazakh' : 'English');

      system = [
        custom
          ? custom.sys
          : `You are "${username}", a real Twitch chat viewer. Write in ${lang} only.`,
        '',
        'Here are messages that REAL viewers just wrote in this stream\'s chat:',
        '---',
        ...samples,
        '---',
        '',
        'Study these messages carefully:',
        '- What game/topic are they discussing?',
        '- What style, slang, and tone are they using?',
        '- How long are typical messages?',
        '',
        'Now write ONE new message that blends in PERFECTLY with the real viewers above.',
        'Your message must be about the SAME topic they are discussing.',
        'Match their language, style, and length exactly.',
        'Do NOT talk about unrelated things.',
        'Output ONLY the chat message. No quotes. No username prefix.',
      ].join('\n');

      if (context) system += '\nExtra context: ' + context;
    } else {
      // Not enough real chat yet — use safe generic
      const lang = custom ? '' : (language === 'ru' ? 'Russian' : language === 'kk' ? 'Kazakh' : 'English');
      system = [
        custom ? custom.sys : `You are a Twitch viewer. Write in ${lang}. 2-10 words.`,
        context ? 'Stream: ' + context : '',
        'Write ONE short natural viewer message. Output ONLY the message.',
      ].filter(Boolean).join('\n');
    }

    const history = this.histories.get(k) || [];
    const trigger = taggedMessage
      ? `Reply to: "${taggedMessage}"`
      : 'Write one chat message now.';

    try {
      const res = await this.groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        max_tokens: 60,
        temperature: 0.85,
        frequency_penalty: 1.2,
        presence_penalty: 0.8,
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
      ].slice(-6);
      this.histories.set(k, updated);

      this.transcriptLog.push({
        username,
        message: raw,
        trigger: taggedMessage ? '@tag' : (this.realChatSamples.length >= 5 ? 'mimics chat' : 'generic'),
        persona: custom ? custom.role : 'default_' + botIndex,
        timestamp: Date.now(),
      });
      if (this.transcriptLog.length > 300) this.transcriptLog.shift();

      return raw.slice(0, 200);
    } catch (e: any) {
      console.error('[ai] error for', username, ':', e.message);
      return this.fallback(language, !!custom);
    }
  }

  private fallback(lang: string, isUkr = false): string {
    if (isUkr) return ['gg', 'топ', 'лол', 'кайф', 'бро'][Math.floor(Math.random() * 5)];
    const f: Record<string, string[]> = {
      ru: ['gg', 'лол', 'давай!', 'ого', '🔥', 'норм', 'красавчик'],
      en: ['gg', 'lol', 'nice', 'Pog', 'GG', 'hype'],
      kk: ['жарайсың', 'gg', 'алға'],
    };
    return (f[lang] || f.en)[Math.floor(Math.random() * 7)];
  }
}
