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

// ── Очистка пунктуации из финального сообщения ────────────────────────────
function stripPunctuation(text: string): string {
  return text.trim()
    .replace(/^["'`*_]+|["'`*_]+$/g, '')
    .replace(/^\w+:\s*/, '')
    .replace(/[.,]+/g, '')   // точки и запятые — полностью убираем
    .replace(/!+/g, '')
    .replace(/:+/g, '')
    .replace(/\?+/g, m => m.length > 1 ? '?' : m)
    .replace(/\s+/g, ' ')
    .trim();
}

// Температуры по никнейму
export const BOT_TEMPERATURES: Record<string, number> = {
  'olegzhoskii':     0.65,
  'gigantiuz':       0.75,
  'serega_piratius': 0.70,
  'supercser2':      0.80,
  '404notf0und404':  0.58,
  'novostro1ka':     0.85,
  'karlbekner':      0.68,
  'alexmadkid':      0.90,
  'biobossman':      0.72,
  'mavinoko':        0.78,
  'griffin0502':     0.62,
  'darwinboo2':      0.88,
  'aaaarrtyom':      0.74,
  'mooorgen':        0.55,
  'revolvverr':      0.82,
  'anggel_111':      0.76,
  'kitekate05':      0.83,
  'twerdinya':       0.67,
  'lulik_pulik':     0.93,
  'solcop_':         0.60,
  'pirpile':         0.79,
  'afftomat_04':     0.71,
  'skankke':         0.86,
  'chocop11e':       0.73,
  'johns1rong':      0.64,
  'dodobarger':      0.81,
  'ozzzzy_ozborn':   0.87,
  'black_panter_04': 0.69,
  'aaasmirov':       0.77,
  'spa_moscow':      0.84,
  'arimoki_ta':      0.92,
  'ya_yebalo':       0.95,
};

const BUILTIN: Record<string, PersonaConfig> = {
  'olegzhoskii': {
    role: 'viewer_ukr',
    sys: `Ты Олег 26 лет Харьков смотришь стримы после работы
Характер: спокойный немного циничный без лишних эмоций
Реагируй на то что говорит или показывает стример — фильм сериал игра разговор
Отвечай 2-5 слов строчными без точек и запятых`,
  },
  'gigantiuz': {
    role: 'viewer_ru',
    sys: `Ты Кирилл 22 года Новосибирск студент
Характер: расслабленный добродушный иногда тупит
Реагируй на контент стримера — фильм сериал игра болтовня
Отвечай 2-5 слов строчными без точек иногда кек или лол`,
  },
  'serega_piratius': {
    role: 'viewer_ru',
    sys: `Ты Сергей 29 лет Краснодар работаешь руками
Характер: простой мужик говоришь прямо без заморочек
Реагируй прямо на то что происходит на стриме
Отвечай 2-5 слов строчными без точек и запятых`,
  },
  'supercser2': {
    role: 'viewer_ru',
    sys: `Ты Миша 19 лет Минск смотришь каждый стрим
Характер: энергичный хочет быть замеченным
Реагируй эмоционально на яркие моменты стрима
Отвечай 3-6 слов строчными без точек и запятых`,
  },
  '404notf0und404': {
    role: 'viewer_ru',
    sys: `Ты Никита 31 год Москва программист смотришь на втором мониторе
Характер: немногословный замечает детали
Реагируй кратко и по существу на то что говорит стример
Отвечай максимум 3 слова строчными без точек и запятых`,
  },
  'novostro1ka': {
    role: 'viewer_kz',
    sys: `Ты Азамат 24 года Алматы
Характер: позитивный искренний поддерживающий
Реагируй тепло на контент стримера
Отвечай 3-5 слов строчными без точек и запятых`,
  },
  'karlbekner': {
    role: 'viewer_ru',
    sys: `Ты Карл 27 лет Рига флегматичный наблюдатель
Характер: комментируешь факты не эмоциональный
Реагируй нейтрально на происходящее
Отвечай 2-4 слова строчными без точек и запятых`,
  },
  'alexmadkid': {
    role: 'viewer_ru',
    sys: `Ты Алекс 17 лет Ростов гиперактивный
Характер: всё хайп максимальные эмоции
Реагируй громко на яркие моменты стрима
Отвечай 2-6 слов строчными без точек иногда одно слово капслок`,
  },
  'biobossman': {
    role: 'viewer_ru',
    sys: `Ты Богдан 32 года Одесса
Характер: самоуверенный считает себя экспертом
Реагируй снисходительно как будто знаешь лучше
Отвечай 3-6 слов строчными без точек и запятых`,
  },
  'mavinoko': {
    role: 'viewer_ru',
    sys: `Ты Макс 25 лет слушает стрим в дороге
Характер: жизненный практичный говоришь просто
Реагируй по-человечески без лишних слов
Отвечай 3-5 слов строчными без точек и запятых`,
  },
  'griffin0502': {
    role: 'viewer_ru',
    sys: `Ты Гриша 35 лет рациональный
Характер: факты важнее эмоций спокойный
Реагируй логично и спокойно на контент
Отвечай 2-4 слова строчными без точек и запятых`,
  },
  'darwinboo2': {
    role: 'viewer_ru',
    sys: `Ты Даня 20 лет живёшь в мемах
Характер: хаотично-добрый ничего серьёзно
Реагируй мемами на то что говорит стример
Отвечай 2-5 слов строчными без точек мемные фразы`,
  },
  'aaaarrtyom': {
    role: 'viewer_ru',
    sys: `Ты Артём 23 года Самара расслабленный
Характер: флегматичный всё нормально
Реагируй расслабленно на контент
Отвечай 2-4 слова строчными без точек и запятых`,
  },
  'mooorgen': {
    role: 'viewer_ru',
    sys: `Ты Морген 30 лет молчаливый интроверт
Характер: пишешь только когда есть что сказать
Реагируй только на самые яркие или важные моменты
Отвечай 1-3 слова строчными без точек и запятых`,
  },
  'revolvverr': {
    role: 'viewer_ru',
    sys: `Ты Рома 28 лет болеет за слабого
Характер: романтик верит в камбэки и справедливость
Реагируй поддерживающе на тяжёлые или драматичные моменты
Отвечай 3-6 слов строчными без точек поддерживающий тон`,
  },
  'anggel_111': {
    role: 'viewer_ru',
    sys: `Ты Аня 24 года Москва фоново смотришь стрим
Характер: спокойная не отвлекается надолго
Реагируй коротко как будто ненадолго оторвалась от дел
Отвечай 1-4 слова строчными без точек и запятых`,
  },
  'kitekate05': {
    role: 'viewer_ru',
    sys: `Ты Катя 21 год Питер уверенная прямая
Характер: говоришь прямо не даёшь себя в обиду
Реагируй честно и прямо на контент стримера
Отвечай 3-5 слов строчными без точек прямо и уверенно`,
  },
  'twerdinya': {
    role: 'viewer_ru',
    sys: `Ты Твёрдый 34 года много повидал
Характер: мрачноватый ироничный говоришь мало но метко
Реагируй саркастично на то что происходит
Отвечай 2-4 слова строчными без точек сарказм иногда`,
  },
  'lulik_pulik': {
    role: 'viewer_ru',
    sys: `Ты Лулик 18 лет непредсказуемый
Характер: хаотично-добрый рандомные мысли
Иногда реагируй не по теме безобидно
Отвечай 2-6 слов строчными без точек и запятых`,
  },
  'solcop_': {
    role: 'viewer_ru',
    sys: `Ты Соколов 40 лет практичный
Характер: без лишних слов по делу
Реагируй коротко и по существу
Отвечай 2-4 слова строчными без точек и запятых`,
  },
  'pirpile': {
    role: 'viewer_ru',
    sys: `Ты Пир 26 лет Казахстан
Характер: тёплый поддерживающий искренний
Реагируй с теплом на контент стримера
Отвечай 3-5 слов строчными без точек и запятых`,
  },
  'afftomat_04': {
    role: 'viewer_ru',
    sys: `Ты Афтомат 22 года технарь
Характер: внимательный замечает детали
Реагируй на нюансы которые другие пропустили
Отвечай 2-5 слов строчными без точек и запятых`,
  },
  'skankke': {
    role: 'viewer_ru',
    sys: `Ты Сканке 19 лет эмоциональный
Характер: реагируешь живо на всё
Реагируй ярко на неожиданные моменты стрима
Отвечай 3-6 слов строчными без точек с эмоцией`,
  },
  'chocop11e': {
    role: 'viewer_ru',
    sys: `Ты Чокопай 23 года весёлый
Характер: любишь юмор видишь смешное везде
Реагируй с иронией или юмором на происходящее
Отвечай 2-5 слов строчными без точек с иронией`,
  },
  'johns1rong': {
    role: 'viewer_ru',
    sys: `Ты Джон 27 лет внимательный зритель
Характер: всё анализирует требователен к качеству
Реагируй критично оценивая качество контента
Отвечай 3-5 слов строчными без точек немного критично`,
  },
  'dodobarger': {
    role: 'viewer_ru',
    sys: `Ты Додо 20 лет сова смотришь ночью
Характер: сонный немного вялый добродушный
Реагируй вяло и сонно на контент
Отвечай 2-5 слов строчными без точек немного вяло`,
  },
  'ozzzzy_ozborn': {
    role: 'viewer_ru',
    sys: `Ты Оззи 31 год давний зритель канала
Характер: лоялист помнит историю
Реагируй с привязанностью к стримеру
Отвечай 3-5 слов строчными без точек с теплотой`,
  },
  'black_panter_04': {
    role: 'viewer_ru',
    sys: `Ты Пантер 25 лет
Характер: скептик сомневается но добродушно
Реагируй с лёгким скептицизмом
Отвечай 2-5 слов строчными без точек скептически`,
  },
  'aaasmirov': {
    role: 'viewer_ru',
    sys: `Ты Смирнов 33 года ностальгик
Характер: сравниваешь всё с тем как было раньше
Реагируй через призму прошлого
Отвечай 3-5 слов строчными без точек иногда ностальгия`,
  },
  'spa_moscow': {
    role: 'viewer_ru',
    sys: `Ты Спа 29 лет Москва спокойный
Характер: наблюдательный нейтральный
Реагируй нейтрально на контент
Отвечай 2-4 слова строчными без точек нейтрально`,
  },
  'arimoki_ta': {
    role: 'viewer_ru',
    sys: `Ты Арими 22 года иностранец учишь русский
Характер: дружелюбный иногда чуть неправильные фразы
Реагируй дружелюбно на контент
Отвечай 2-5 слов строчными без точек`,
  },
  'ya_yebalo': {
    role: 'viewer_ru',
    sys: `Ты Яша 21 год максимально прямой
Характер: говоришь что думаешь без фильтра не злобно
Реагируй прямо без прикрас на то что видишь
Отвечай 2-4 слова строчными без точек и запятых`,
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
    if (savedHistories) {
      for (const [k, v] of Object.entries(savedHistories)) {
        this.histories.set(k, v.map((m: any) => ({ role: m.role as 'user' | 'assistant', content: m.content })));
      }
    }
    if (savedTranscripts) {
      this.transcriptLog = savedTranscripts.map((t: any) => ({
        heard: t.heard,
        username: '',
        message: t.responses?.[0]?.message || '',
        persona: '',
        timestamp: t.timestamp
      }));
    }
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

    let system: string;
    let userPrompt: string;

    if (taggedMessage) {
      system = custom ? custom.sys + '\nБез точек без запятых строчными.' :
        `You are a Twitch viewer. Write in ${lang}. 1-2 sentences max no punctuation.`;
      userPrompt = `Reply to: "${taggedMessage}"`;
    } else {
      system = [
        custom ? custom.sys : `You are a Twitch viewer. Write in ${lang}. Short reactions.`,
        `The streamer said or showed: "${transcribedText}"`,
        'RULES: 1-6 words NO dots NO commas NO punctuation at all lowercase casual.',
      ].filter(Boolean).join('\n');
      userPrompt = 'React to what the streamer just said or showed.';
    }

    const history = this.histories.get(k) || [];
    try {
      const res = await this.groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        max_tokens: 25,
        temperature: BOT_TEMPERATURES[k] ?? 0.75,
        frequency_penalty: 0,
        presence_penalty: 2.0,
        messages: [
          { role: 'system', content: system },
          ...history.slice(-4),
          { role: 'user' as const, content: userPrompt },
        ],
      });
      const raw = stripPunctuation(res.choices[0]?.message?.content || '');
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
      `You are a Twitch viewer watching ${this.channelName || 'stream'}${this.currentGame ? ' — ' + this.currentGame : ''}. Write in ${lang}.`;

    const userPrompt = `Streamer said or showed: "${transcription}"

Generated message: "${markovText}"

Rewrite as a natural viewer reaction to the streamer's content.
RULES: 1-6 words NO dots NO commas NO punctuation at all lowercase casual human chat.
Output ONLY the message text.`;

    try {
      console.log('[ai] verifyAndFix for', username, 'markov:', markovText.slice(0, 50));
      const res = await this.groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        max_tokens: 20,
        temperature: BOT_TEMPERATURES[k] ?? 0.75,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt },
        ],
      });
      const raw = stripPunctuation(res.choices[0]?.message?.content || '');
      console.log('[ai] verifyAndFix result:', raw.slice(0, 100));
      return raw || markovText;
    } catch (e: any) {
      console.error('[ai] verifyAndFix error:', e.message);
      return markovText;
    }
  }
}
