import Groq from 'groq-sdk';

const PERSONAS = [
  { style: 'enthusiastic hype fan',       traits: 'Very excited, short reactions, uses PogChamp/LUL, hyped for every play' },
  { style: 'chill lurker',                traits: 'Relaxed, rare comments, uses "lol" "lmao", brief and casual' },
  { style: 'strategic advisor',           traits: 'Gives tactical tips, references game mechanics, knowledgeable' },
  { style: 'friendly comedian',           traits: 'Makes puns and jokes, light-hearted, never mean, playful' },
  { style: 'curious newbie',              traits: 'Asks questions about the game, easily amazed, learning' },
  { style: 'nostalgic veteran gamer',     traits: 'Compares to old games, experienced perspective, brief insights' },
  { style: 'hype train conductor',        traits: 'CAPS sometimes, rallies chat, "LET\'S GO" energy, very reactive' },
  { style: 'calm thoughtful analyst',     traits: 'Measured observations, no hype, concise and precise' },
];

interface HistoryMsg { role: 'user' | 'assistant'; content: string; }

export class AIService {
  private groq: Groq;
  private histories = new Map<string, HistoryMsg[]>();
  private recentRealChat: string[] = [];
  private settings: Record<string, boolean>;

  constructor(apiKey: string, settings: Record<string, boolean> = {}) {
    this.groq = new Groq({ apiKey });
    this.settings = settings;
  }

  addChatContext(line: string): void {
    this.recentRealChat.push(line);
    if (this.recentRealChat.length > 10) this.recentRealChat.shift();
  }

  async generateMessage(
    username: string,
    context: string,
    language: string,
    botIndex = 0
  ): Promise<string> {
    const persona = PERSONAS[botIndex % PERSONAS.length];
    const langName = language === 'ru' ? 'Russian' : language === 'kk' ? 'Kazakh' : 'English';

    const emojiLine = this.settings.useEmoji
      ? 'Occasionally use Twitch emotes: LUL Pog PogChamp KEKW monkaS GG or simple emojis.'
      : 'Do not use emojis.';

    const chatCtxLines = this.settings.chatContext && this.recentRealChat.length
      ? '\nRecent viewer messages:\n' + this.recentRealChat.slice(-4).join('\n')
      : '';

    const system = [
      'You are "' + username + '", a Twitch viewer.',
      'Personality: ' + persona.style + '.',
      'Character traits: ' + persona.traits + '.',
      'Write ONLY in ' + langName + '.',
      'Message length: 3-18 words MAX. Be very natural and human.',
      emojiLine,
      'Stream/game context: ' + (context || 'gaming stream') + '.',
      chatCtxLines,
      '',
      'Rules:',
      '- Output ONLY the chat message. No quotes, no explanation.',
      '- Never repeat your previous messages.',
      '- Sound like a real Twitch viewer, not a bot.',
      '- Vary your style every message.',
    ].join('\n');

    const history = this.histories.get(username) || [];

    try {
      const response = await this.groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        max_tokens: 50,
        temperature: 0.95,
        top_p: 0.95,
        frequency_penalty: 1.0,
        presence_penalty: 0.8,
        messages: [
          { role: 'system', content: system },
          ...history.slice(-6),
          { role: 'user' as const, content: 'Post one chat message now.' },
        ],
      });

      const raw = response.choices[0]?.message?.content?.trim() || '';
      const msg = raw.replace(/^["'`]|["'`]$/g, '').trim();

      if (!msg) return this.fallback(language);

      // Store in history to avoid repeating
      const newHistory: HistoryMsg[] = [
        ...history,
        { role: 'user' as const, content: 'Post one chat message now.' },
        { role: 'assistant' as const, content: msg },
      ].slice(-8);
      this.histories.set(username, newHistory);

      return msg.slice(0, 200);
    } catch (err: any) {
      console.error('[ai] generateMessage error for ' + username + ':', err.message);
      return this.fallback(language);
    }
  }

  private fallback(language: string): string {
    const f: Record<string, string[]> = {
      ru: ['gg', 'лол', 'давай!', '😮', 'ого', 'красавчик', 'нис', 'хорошо сыграно', 'пог'],
      en: ['gg', 'lol', 'nice!', 'Pog', 'let\'s go', 'GG', 'hype'],
      kk: ['жарайсың', 'gg', 'алға!', 'нис'],
    };
    const arr = f[language] || f.en;
    return arr[Math.floor(Math.random() * arr.length)];
  }
}
