import Groq from 'groq-sdk';

export interface PersonaConfig {
  role: string;
  sys: string;
}

export interface TranscriptEntry {
  heard: string;
  username: string;
  message: string;
  persona: string;
  timestamp: number;
}

interface Msg { role: 'user' | 'assistant'; content: string; }

const BUILTIN: Record<string, PersonaConfig> = {
  'olegzhoskii': {
    role: 'viewer_ukr',
    sys: `Ты Олег. Обычный чувак. Без восторга.
Отвечай коротко 2-4 слова. Не повторяй вопрос.`,
  },
  'gigantiuz': {
    role: 'viewer_ru',
    sys: `Ты Кирилл. Просто пацан.
Короткий ответ. Без лишних слов. 2-4 слова.`,
  },
  'serega_piratius': {
    role: 'viewer_ru',
    sys: `Ты Сергей. Нормальный чувак.
Без фанатизма. 2-4 слова.`,
  },
  'supercser2': {
    role: 'viewer_ru',
    sys: `Ты Миша. Обычный.
Ответ 2-4 слова. Без фана.`,
  },
  '404notf0und404': {
    role: 'viewer_ru',
    sys: `Ты Никита. Без заморочек.
2-4 слова максимум.`,
  },
  'novostro1ka': {
    role: 'viewer_ru',
    sys: `Ты Азамат. Нормально.
Короткий ответ.`,
  },
};

export class AIService {
  private groq: Groq;
  private histories = new Map<string, Msg[]>();
  private realChatSamples: string[] = [];
  private settings: Record<string, boolean>;
  private customPersonas = new Map<string, PersonaConfig>();
  public transcriptLog: TranscriptEntry[] = [];
  private currentGame = '';
  private channelName = '';

  constructor(
    apiKey: string, 
    settings: Record<string, boolean> = {}, 
    savedPersonas?: Record<string, PersonaConfig>,
    savedHistories?: Record<string, { role: string; content: string; time: number }[]>,
    savedTranscripts?: { heard: string; timestamp: number; responses: { username: string; message: string }[] }[],
    savedRealChat?: { username: string; message: string; time: number }[]
  ) {
    this.groq = new Groq({ apiKey });
    this.settings = settings;
    for (const [k, v] of Object.entries(BUILTIN)) this.customPersonas.set(k, v);
    if (savedPersonas) {
      for (const [k, v] of Object.entries(savedPersonas)) this.customPersonas.set(k.toLowerCase(), v);
    }
    // Load saved history
    if (savedHistories) {
      for (const [k, v] of Object.entries(savedHistories)) {
        this.histories.set(k, v.map((m: any) => ({ role: m.role as 'user' | 'assistant', content: m.content })));
      }
    }
    // Load saved transcript history
    if (savedTranscripts) {
      this.transcriptLog = savedTranscripts.map((t: any) => ({
        heard: t.heard,
        username: '',
        message: t.responses?.[0]?.message || '',
        persona: '',
        timestamp: t.timestamp
      }));
    }
    // Load saved real chat
    if (savedRealChat) {
      this.realChatSamples = savedRealChat.map((c: any) => c.username + ': ' + c.message);
    }
  }

  setPersona(username: string, cfg: PersonaConfig): void {
    this.customPersonas.set(username.toLowerCase(), cfg);
    this.histories.delete(username.toLowerCase());
  }
  getPersonas(): Record<string, PersonaConfig> {
    const out: Record<string, PersonaConfig> = {};
    for (const [k, v] of this.customPersonas) out[k] = v;
    return out;
  }
  getHistoryForSave(): { histories: Record<string, { role: string; content: string; time: number }[]>; transcripts: any[]; realChat: any[] } {
    const histories: Record<string, { role: string; content: string; time: number }[]> = {};
    for (const [k, v] of this.histories) {
      histories[k] = v.map(m => ({ role: m.role, content: m.content, time: Date.now() }));
    }
    const transcripts = this.transcriptLog.slice(-1000).map(t => ({
      heard: t.heard,
      timestamp: t.timestamp,
      responses: [{ username: t.username, message: t.message }]
    }));
    const realChat = this.realChatSamples.slice(-500).map(c => {
      const idx = c.indexOf(': ');
      return { username: c.slice(0, idx), message: c.slice(idx + 2), time: Date.now() };
    });
    return { histories, transcripts, realChat };
  }
  addRealMessage(displayName: string, message: string): void {
    this.realChatSamples.push(displayName + ': ' + message);
    if (this.realChatSamples.length > 500) this.realChatSamples.shift();
  }
  setGame(game: string): void {
    this.currentGame = game;
  }
  setChannel(channel: string): void {
    this.channelName = channel;
  }

  async generateFromTranscription(
    username: string,
    transcribedText: string,
    language: string,
    botIndex = 0,
    taggedMessage?: string
  ): Promise<string> {
    const k = username.toLowerCase();
    const custom = this.customPersonas.get(k);
    console.log('[ai] Generating for:', username, 'key:', k, 'has custom:', !!custom, 'sys:', custom?.sys?.slice(0, 30));
    const lang = custom ? '' : (language === 'ru' ? 'Russian' : language === 'kk' ? 'Kazakh' : 'English');

// Only respond to transcription, not chat
    // No context from real chat
    
    let system: string;
    let userPrompt: string;

    if (taggedMessage) {
      system = custom ? custom.sys + '\nNatural chat.' :
        `You are a Twitch viewer. Write in ${lang}. 1-2 sentences max, no punctuation.`;
      userPrompt = `Reply to: "${taggedMessage}"`;
    } else {
      system = [
        custom ? custom.sys : `You are a Twitch viewer. Write in ${lang}. Short reactions.`,
        `The streamer said: "${transcribedText}"`,
        '1-6 words, max 30 chars, no punctuation, casual simple.',
      ].filter(Boolean).join('\n');
      userPrompt = 'React to what the streamer just said.';
    }

    const history = this.histories.get(k) || [];
    try {
      const res = await this.groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        max_tokens: 25,
        temperature: 1.0,
        frequency_penalty: 0,
        presence_penalty: 2.0,
        messages: [
          { role: 'system', content: system },
          ...history.slice(-4),
          { role: 'user' as const, content: userPrompt },
        ],
      });
      const raw = (res.choices[0]?.message?.content || '').trim()
        .replace(/^["'`*_]+|["'`*_]+$/g, '').replace(/^\w+:\s*/, '').trim()
        .replace(/!+/g, '').replace(/\.+/g, '').replace(/,+/g, ' ').replace(/:+/g, '').replace(/\?+/g, (m) => m.length > 1 ? '?' : m)
        .replace(/\s+/g, ' ').trim();
      if (!raw || raw.length < 2) return '';
      const updated: Msg[] = [...history,
        { role: 'user' as const, content: userPrompt },
        { role: 'assistant' as const, content: raw },
      ].slice(-6);
      this.histories.set(k, updated);
      this.transcriptLog.push({
        heard: taggedMessage ? '[@tag]' : transcribedText,
        username, message: raw,
        persona: custom ? custom.role : 'default_' + botIndex,
        timestamp: Date.now(),
      });
      if (this.transcriptLog.length > 2000) this.transcriptLog.shift();
      return raw.slice(0, 200);
    } catch (e: any) {
      console.error('[ai] error for', username, ':', e.message);
      return '';
    }
  }

  async verifyAndFix(
    username: string,
    markovText: string,
    transcription: string,
    language: string,
    botIndex = 0
  ): Promise<string> {
    const k = username.toLowerCase();
    const custom = this.customPersonas.get(k);
    const lang = custom ? '' : (language === 'ru' ? 'Russian' : language === 'kk' ? 'Kazakh' : 'English');
    
    const system = custom ? 
      custom.sys :
      `You are a Twitch viewer watching ${this.channelName || 'stream'}${this.currentGame ? ' playing ' + this.currentGame : ''}. Write in ${lang}.`;
    
    const userPrompt = `Current game: ${this.currentGame || 'Just Chatting'}
Streamer said: "${transcription}"
    
Generated (from learned chat): "${markovText}"

Check if this response makes sense given the current stream context.
IMPORTANT: If the generated message mentions names, places, or topics from the learned chat that don't match the current stream - REJECT and say "REJECT".
If ok, rewrite it to be casual and relevant.
Rules: 1-6 words, max 30 chars, no @mentions, no punctuation, casual simple human messages.
Output only the message, or "REJECT" if irrelevant.`;
    
    try {
      console.log('[ai] verifyAndFix for', username, 'markov:', markovText.slice(0, 50));
      const res = await this.groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        max_tokens: 20,
        temperature: 0.3,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt },
        ],
      });
      
      const raw = res.choices[0]?.message?.content?.trim() || '';
      console.log('[ai] verifyAndFix result:', raw.slice(0, 100));
      return raw.slice(0, 200) || markovText; // fallback to markov if empty
    } catch (e: any) {
      console.error('[ai] verifyAndFix error:', e.message);
      return markovText; // fallback to markov on error
    }
  }
}
