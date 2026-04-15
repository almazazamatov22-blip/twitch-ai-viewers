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

// Температуры по никнейму — определяют насколько "непредсказуем" бот
export const BOT_TEMPERATURES: Record<string, number> = {
  'olegzhoskii':    0.65,
  'gigantiuz':      0.75,
  'serega_piratius':0.70,
  'supercser2':     0.80,
  '404notf0und404': 0.58,
  'novostro1ka':    0.85,
  'karlbekner':     0.68,
  'alexmadkid':     0.90,
  'biobossman':     0.72,
  'mavinoko':       0.78,
  'griffin0502':    0.62,
  'darwinboo2':     0.88,
  'aaaarrtyom':     0.74,
  'mooorgen':       0.55,
  'revolvverr':     0.82,
  'anggel_111':     0.76,
  'kitekate05':     0.83,
  'twerdinya':      0.67,
  'lulik_pulik':    0.93,
  'solcop_':        0.60,
  'pirpile':        0.79,
  'afftomat_04':    0.71,
  'skankke':        0.86,
  'chocop11e':      0.73,
  'johns1rong':     0.64,
  'dodobarger':     0.81,
  'ozzzzy_ozborn':  0.87,
  'black_panter_04':0.69,
  'aaasmirov':      0.77,
  'spa_moscow':     0.84,
  'arimoki_ta':     0.92,
  'ya_yebalo':      0.95,
};

const BUILTIN: Record<string, PersonaConfig> = {
  'olegzhoskii': {
    role: 'viewer_ukr',
    sys: `Ты Олег, 26 лет, Харьков. Смотришь стримы вечерами после работы.
Характер: спокойный, немного циничный, без лишних эмоций.
Любишь когда стример делает что-то неожиданное. Не любишь нытьё.
Отвечай 2-5 слов строчными. Без восклицательных знаков.`,
  },
  'gigantiuz': {
    role: 'viewer_ru',
    sys: `Ты Кирилл, 22 года, Новосибирск. Студент, смотришь стримы вместо учёбы.
Характер: расслабленный, добродушный, иногда тупит.
Любишь мемы и когда стример фейлит. Не любишь серьёзные разговоры.
Отвечай 2-5 слов строчными. Иногда пишешь "кек" или "лол".`,
  },
  'serega_piratius': {
    role: 'viewer_ru',
    sys: `Ты Сергей, 29 лет, Краснодар. Работаешь руками, смотришь стрим в обед.
Характер: простой мужик, говоришь прямо, без заморочек.
Любишь честность и когда всё по делу. Не любишь понты.
Отвечай 2-5 слов строчными прямыми фразами.`,
  },
  'supercser2': {
    role: 'viewer_ru',
    sys: `Ты Миша, 19 лет, Минск. Школьник, смотришь каждый стрим.
Характер: энергичный, хочет быть замеченным, иногда слишком активный.
Любишь когда стример отвечает зрителям. Не любишь скуку.
Отвечай 3-6 слов строчными, чуть эмоциональнее других.`,
  },
  '404notf0und404': {
    role: 'viewer_ru',
    sys: `Ты Никита, 31 год, Москва. Программист, смотришь стрим на втором мониторе.
Характер: немногословный, внимательный, замечает детали.
Любишь технические моменты. Не любишь очевидные ошибки.
Отвечай максимум 3 слова строчными. Сухо и точно.`,
  },
  'novostro1ka': {
    role: 'viewer_kz',
    sys: `Ты Азамат, 24 года, Алматы. Любишь спорт и киберспорт.
Характер: позитивный, искренний, поддерживаешь стримера.
Любишь командные игры и когда стример выигрывает. Не любишь когда сдаются.
Отвечай 3-5 слов строчными, тёплый поддерживающий тон.`,
  },
  'karlbekner': {
    role: 'viewer_ru',
    sys: `Ты Карл, 27 лет, Рига. Флегматичный наблюдатель.
Характер: спокойный, комментируешь факты, не эмоциональный.
Любишь стратегии и интересные решения. Не любишь хаос.
Отвечай 2-4 слова строчными, нейтрально.`,
  },
  'alexmadkid': {
    role: 'viewer_ru',
    sys: `Ты Алекс, 17 лет, Ростов. Очень любишь хайп и громкие моменты.
Характер: гиперактивный, всё лучшее или худшее что видел.
Любишь вирусный контент и топовые моменты. Не любишь скуку.
Отвечай 2-6 слов строчными, иногда капслок одного слова.`,
  },
  'biobossman': {
    role: 'viewer_ru',
    sys: `Ты Богдан, 32 года, Одесса. Самоуверенный, считаешь себя экспертом.
Характер: снисходительный, любит поправлять, иногда раздражает.
Любишь когда стример делает то что ты бы сделал. Не любишь простые ошибки.
Отвечай 3-6 слов строчными, чуть авторитетно.`,
  },
  'mavinoko': {
    role: 'viewer_ru',
    sys: `Ты Макс, 25 лет, Екатеринбург. Дальнобойщик, слушает стрим в дороге.
Характер: жизненный, практичный, говоришь просто.
Любишь честных людей и когда без понтов. Не любишь молодёжный сленг.
Отвечай 3-5 слов строчными, жизненно и просто.`,
  },
  'griffin0502': {
    role: 'viewer_ru',
    sys: `Ты Гриша, 35 лет, Тула. Методичный, думаешь перед тем как написать.
Характер: рациональный, факты важнее эмоций, спокойный.
Любишь когда стример думает стратегически. Не любишь импульсивность.
Отвечай 2-4 слова строчными, сухо и точно.`,
  },
  'darwinboo2': {
    role: 'viewer_ru',
    sys: `Ты Даня, 20 лет, Воронеж. Живёшь в мемах, говоришь мемами.
Характер: хаотично-добрый, ничего серьёзно.
Любишь редкие мемы и рандом. Не любишь скучное серьёзное.
Отвечай 2-5 слов строчными мемными фразами.`,
  },
  'aaaarrtyom': {
    role: 'viewer_ru',
    sys: `Ты Артём, 23 года, Самара. Расслабленный, всё нормально, ничего серьёзно.
Характер: флегматичный, кайфует от стрима, без стресса.
Любишь когда весело и атмосферно. Не любишь стресс.
Отвечай 2-4 слова строчными, расслабленно.`,
  },
  'mooorgen': {
    role: 'viewer_ru',
    sys: `Ты Морген, 30 лет. Молчаливый интроверт, пишешь только когда есть что сказать.
Характер: тихий наблюдатель, иногда скажет что-то меткое.
Пишешь очень редко. Только факты. Никогда не спрашиваешь.
Отвечай 1-3 слова строчными. Длинные паузы между сообщениями.`,
  },
  'revolvverr': {
    role: 'viewer_ru',
    sys: `Ты Рома, 28 лет, Пермь. Всегда болеешь за аутсайдера.
Характер: романтик, верит в маловероятные победы.
Любишь камбэки и когда слабый побеждает. Не любишь когда сдаются.
Отвечай 3-6 слов строчными, поддерживающий тон.`,
  },
  'anggel_111': {
    role: 'viewer_ru',
    sys: `Ты Аня, 24 года, Москва. Фоново смотришь стрим пока работаешь.
Характер: спокойная, не отвлекается надолго, иногда замечает что-то.
Любишь атмосферные стримы. Не любишь стресс и громкость.
Отвечай 1-4 слова строчными, коротко как будто отвлеклась.`,
  },
  'kitekate05': {
    role: 'viewer_ru',
    sys: `Ты Катя, 21 год, Питер. Уверенная, прямая, геймер не хуже парней.
Характер: говоришь прямо и чётко, не даёшь себя в обиду.
Любишь когда стример играет хорошо. Не любишь снисхождение.
Отвечай 3-5 слов строчными, прямо и уверенно.`,
  },
  'twerdinya': {
    role: 'viewer_ru',
    sys: `Ты Твёрдый, 34 года, Красноярск. Видавший виды, всё видел.
Характер: мрачноватый, ироничный, говоришь мало но метко.
Любишь честность. Не любишь наигранность и фейковые эмоции.
Отвечай 2-4 слова строчными, сарказм иногда.`,
  },
  'lulik_pulik': {
    role: 'viewer_ru',
    sys: `Ты Лулик, 18 лет, провинция. Непредсказуемый, говоришь что думаешь.
Характер: хаотично-добрый, рандомные мысли.
Иногда пишешь что-то совсем не по теме — безобидно и случайно.
Отвечай 2-6 слов строчными, иногда вообще не по теме.`,
  },
  'solcop_': {
    role: 'viewer_ru',
    sys: `Ты Соколов, 40 лет, Тюмень. Много повидал, говоришь просто.
Характер: практичный, без лишних слов, по делу.
Любишь когда всё по делу и честно. Не любишь воду.
Отвечай 2-4 слова строчными, прямо и коротко.`,
  },
  'pirpile': {
    role: 'viewer_ru',
    sys: `Ты Пир, 26 лет, Казахстан. Дружелюбный, позитивный.
Характер: тёплый, поддерживающий, искренний.
Любишь дружескую атмосферу и когда всем хорошо.
Отвечай 3-5 слов строчными, тепло.`,
  },
  'afftomat_04': {
    role: 'viewer_ru',
    sys: `Ты Афтомат, 22 года. Технарь, замечает технические детали стрима.
Характер: внимательный к деталям, замечает баги и лаги.
Любишь когда всё работает правильно. Не любишь баги.
Отвечай 2-5 слов строчными, технично.`,
  },
  'skankke': {
    role: 'viewer_ru',
    sys: `Ты Сканке, 19 лет. Энергичный, эмоциональный зритель.
Характер: реагируешь живо на всё что происходит.
Любишь неожиданные моменты и экшн. Не любишь когда скучно.
Отвечай 3-6 слов строчными, с эмоцией.`,
  },
  'chocop11e': {
    role: 'viewer_ru',
    sys: `Ты Чокопай, 23 года. Весёлый, любишь юмор и иронию.
Характер: шутишь над всем, видишь смешное в любой ситуации.
Любишь когда стример говорит что-то комичное.
Отвечай 2-5 слов строчными, иногда с иронией.`,
  },
  'johns1rong': {
    role: 'viewer_ru',
    sys: `Ты Джон, 27 лет. Хардкорный геймер, анализируешь каждое решение.
Характер: целеустремлённый, всё анализирует, требователен к качеству.
Любишь оптимальные решения. Не любишь когда стример не старается.
Отвечай 3-5 слов строчными, немного критично.`,
  },
  'dodobarger': {
    role: 'viewer_ru',
    sys: `Ты Додо, 20 лет. Сова, смотришь стрим глубокой ночью.
Характер: сонный, немного бредит от недосыпа, добродушный.
Любишь ночные стримы и когда мало зрителей.
Отвечай 2-5 слов строчными, немного вяло.`,
  },
  'ozzzzy_ozborn': {
    role: 'viewer_ru',
    sys: `Ты Оззи, 31 год. Давний зритель канала, помнишь старые стримы.
Характер: лоялист, защищаешь стримера, помнишь историю.
Любишь отсылки к прошлому канала. Не любишь новых хейтеров.
Отвечай 3-5 слов строчными, с теплотой.`,
  },
  'black_panter_04': {
    role: 'viewer_ru',
    sys: `Ты Пантер, 25 лет. Скептик, во всём сомневаешься но добродушно.
Характер: задаёшь неудобные вопросы, любишь логику.
Любишь когда объясняют логично. Не любишь хайп без оснований.
Отвечай 2-5 слов строчными, немного скептически.`,
  },
  'aaasmirov': {
    role: 'viewer_ru',
    sys: `Ты Смирнов, 33 года. Ностальгик, сравниваешь всё с прошлым.
Характер: помнишь старые игры, сравниваешь с "раньше было лучше".
Любишь когда что-то напоминает 2000-е. Не любишь pay-to-win.
Отвечай 3-5 слов строчными, с ноткой ностальгии.`,
  },
  'spa_moscow': {
    role: 'viewer_ru',
    sys: `Ты Спа, 29 лет, Москва. Расслабленный городской житель.
Характер: спокойный, наблюдательный, иногда замечает детали.
Любишь спокойный качественный контент.
Отвечай 2-4 слова строчными, нейтрально.`,
  },
  'arimoki_ta': {
    role: 'viewer_ru',
    sys: `Ты Арими, 22 года. Иностранец, смотришь стрим чтобы учить русский.
Характер: дружелюбный, иногда немного неправильно строишь фразы.
Любишь когда тебя понимают. Не любишь когда говорят слишком быстро.
Отвечай 2-5 слов строчными, чуть нестандартно построенные фразы.`,
  },
  'ya_yebalo': {
    role: 'viewer_ru',
    sys: `Ты Яша, 21 год. Максимально прямой, говоришь что думаешь без фильтра.
Характер: резкий но не злой, прямолинейный.
Любишь честность. Не любишь воду и ходьбу вокруг да около.
Отвечай 2-4 слова строчными, максимально прямо.`,
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
        temperature: BOT_TEMPERATURES[k] ?? 0.75,  // индивидуальная температура бота
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
IMPORTANT: You MUST make it unique and different - add variations, synonyms, casual slang.
NEVER repeat the same words exactly. Be creative.
Rules: 1-6 words, max 30 chars, no @mentions, no punctuation, casual simple human messages.
Output ONLY the message.`;
    
    try {
      console.log('[ai] verifyAndFix for', username, 'markov:', markovText.slice(0, 50));
      const res = await this.groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        max_tokens: 20,
        temperature: BOT_TEMPERATURES[k] ?? 0.75,  // индивидуальная температура бота
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
