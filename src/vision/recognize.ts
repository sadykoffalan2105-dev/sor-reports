/**
 * Распознавание рукописной «разбаловки» (лестницы баллов) по фото через Claude API.
 * Модуль загружается лениво: import('./vision/recognize.ts') — на верхнем уровне ничего не выполняется.
 * Ключ API вводит пользователь; запросы идут из браузера напрямую (dangerouslyAllowBrowser).
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { prepareImage } from './image.ts';

export const DEFAULT_MODEL = 'claude-opus-5-5';

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface ImageData {
  /** base64 без префикса data: */
  data: string;
  media_type: ImageMediaType;
}

export interface RecognizeOptions {
  apiKey: string;
  model?: string;
  signal?: AbortSignal;
  /** Уровень усилий модели; по умолчанию medium. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface LadderRow {
  /** Фактическая сумма scores. */
  total: number;
  scores: number[];
}

export interface RecognizedClass {
  /** Подпись блока на листе: «5 класс». */
  label: string;
  /** Разбаловка в нотации приложения: «5; 5+5+20+10; 5». */
  structureText: string;
  /** Названия заданий (пусто, если на фото не подписаны). */
  titles: string[];
  ladder: LadderRow[];
  warnings: string[];
}

export interface RecognizeResult {
  classes: RecognizedClass[];
  warnings: string[];
  usage?: { input: number; output: number };
}

/* ---------- схема ответа модели ---------- */

const TaskSchema = z.object({
  title: z.string().nullable().describe('Подпись задания на фото («1зд», «2 задание») или null, если не подписано'),
  parts: z
    .array(z.number())
    .describe('Максимумы критериев задания по колонкам слева направо; одна цифра — задание без подкритериев'),
});

const RowSchema = z.object({
  written_total: z.number().nullable().describe('Число, написанное после «=», или null, если его нет/не читается'),
  scores: z.array(z.number()).describe('Все числа строки до знака «=», слева направо, по одному на колонку'),
});

const ClassSchema = z.object({
  label: z.string().describe('Заголовок блока, например «5 класс»'),
  tasks: z.array(TaskSchema),
  rows: z.array(RowSchema).describe('Все строки блока сверху вниз, включая первую строку максимумов'),
  notes: z.array(z.string()).describe('Замечания: неразборчивые цифры, зачёркивания, сомнения'),
});

export const LadderPhotoSchema = z.object({
  classes: z.array(ClassSchema),
});

export type LadderPhotoResponse = z.infer<typeof LadderPhotoSchema>;

/* ---------- промпт ---------- */

const SYSTEM_PROMPT = `Ты распознаёшь рукописные листы учителя с «разбаловкой» контрольных работ (СОР/СОЧ) казахстанской школы.

На листе: заголовок (например «СОР № 2»), затем блоки по классам («5 класс», «6 класс», «7 класс»), разделённые горизонтальными чертами. В блоке — строки чисел. Каждое число — балл за один критерий (колонку); после знака «=» записана общая сумма строки. Первая строка блока — максимумы критериев (полная сумма, например «5 5 5 20 10 5 = 50»). Следующие строки — варианты распределения для меньших сумм (48, 46, 44, …).

Скобками или подписями сверху («1зд», «2зд», «3зд») колонки объединены в задания. Если подписей нет, используй типовое правило: первая колонка — 1 задание, последняя колонка — 3 задание, все колонки между ними — подкритерии 2 задания.

Правила:
- Читай КАЖДОЕ число каждой строки, слева направо, ровно по одному на колонку; количество чисел в строке должно совпадать с числом колонок в первой строке блока. Ориентируйся на вертикальное выравнивание колонок.
- В scores записывай только числа до знака «=». Число после «=» пиши в written_total как есть, даже если оно не совпадает с суммой — не исправляй и не «подгоняй» цифры под подпись. Учитель мог ошибиться в подписи.
- Двоеточия, точки и запятые между цифрами — разделители, не части чисел.
- Если цифра неразборчива — выбери наиболее вероятный вариант и опиши сомнение в notes.
- Не пропускай строки и блоки. Красные подписи-пометки «1зд/2зд/3зд» и белые скобки — служебная разметка, не числа.`;

const USER_PROMPT =
  'Распознай все блоки классов на этом листе разбаловки и верни данные строго по схеме. Для каждого блока: label, tasks (колонки-максимумы, сгруппированные по заданиям), rows (все строки, включая строку максимумов) и notes.';

/* ---------- API ---------- */

/** Распознавание по фото из браузера: сжимает картинку и отправляет в модель. */
export async function recognizeLadderPhoto(file: File | Blob, opts: RecognizeOptions): Promise<RecognizeResult> {
  const image = await prepareImage(file);
  return recognizeImageData(image, opts);
}

/** Распознавание по готовому base64 (используется из браузера после prepareImage и из Node-теста напрямую). */
export async function recognizeImageData(image: ImageData, opts: RecognizeOptions): Promise<RecognizeResult> {
  const apiKey = opts.apiKey.trim();
  if (!apiKey) throw new Error('Не задан ключ API');

  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const format = zodOutputFormat(LadderPhotoSchema);

  // Намеренно messages.create, а не messages.parse: parse() разбирает JSON до проверки stop_reason,
  // и при обрыве по max_tokens бросал бы английскую ошибку «Failed to parse structured output».
  let response: Anthropic.Message;
  try {
    response = await client.messages.create(
      {
        model: opts.model || DEFAULT_MODEL,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: { effort: opts.effort ?? 'medium', format },
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: image.media_type, data: image.data } },
              { type: 'text', text: USER_PROMPT },
            ],
          },
        ],
      },
      { signal: opts.signal },
    );
  } catch (e) {
    throw toRussianError(e);
  }

  if (response.stop_reason === 'refusal') {
    const why = response.stop_details?.explanation ? ` (${response.stop_details.explanation})` : '';
    throw new Error(`Модель отказалась обрабатывать это фото${why}. Попробуйте другой снимок.`);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Ответ модели оборвался (превышен лимит длины). Попробуйте фото с меньшим числом блоков.');
  }
  if (response.stop_reason && response.stop_reason !== 'end_turn' && response.stop_reason !== 'stop_sequence') {
    throw new Error(`Модель не завершила ответ (${response.stop_reason}). Попробуйте ещё раз.`);
  }

  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
  if (!text.trim()) throw new Error('Не удалось разобрать ответ модели: пустой ответ');

  let parsed: LadderPhotoResponse;
  try {
    parsed = format.parse(text);
  } catch (e) {
    const detail = e instanceof Error && e.message ? ` (${e.message.split('\n')[0]})` : '';
    throw new Error(`Не удалось разобрать ответ модели${detail}`);
  }

  const result = normalizeResponse(parsed);
  result.usage = { input: response.usage.input_tokens, output: response.usage.output_tokens };
  return result;
}

function toRussianError(e: unknown): Error {
  if (e instanceof Anthropic.APIUserAbortError) return new Error('Распознавание отменено');
  if (e instanceof Anthropic.AuthenticationError) return new Error('Неверный ключ API');
  if (e instanceof Anthropic.PermissionDeniedError) return new Error('Ключ API не имеет доступа к этой модели');
  if (e instanceof Anthropic.RateLimitError) return new Error('Превышен лимит запросов, попробуйте позже');
  if (e instanceof Anthropic.APIConnectionError) return new Error('Нет связи с api.anthropic.com');
  if (e instanceof Anthropic.APIError) {
    const status = e.status != null ? ` (код ${e.status})` : '';
    return new Error(`Ошибка Claude API${status}: ${e.message}`);
  }
  if (e instanceof Error && e.name === 'AbortError') return new Error('Распознавание отменено');
  if (e instanceof Anthropic.AnthropicError) return new Error(`Ошибка клиента Claude API: ${e.message}`);
  return e instanceof Error ? e : new Error(String(e));
}

/* ---------- нормализация ---------- */

/**
 * Превращает ответ модели в структуры приложения: считает суммы строк,
 * отбрасывает строки с неверным числом колонок, сверяет подписи «=» с суммами.
 */
export function normalizeResponse(raw: LadderPhotoResponse): RecognizeResult {
  const warnings: string[] = [];
  const classes: RecognizedClass[] = [];

  raw.classes.forEach((cls, ci) => {
    const label = cls.label.trim() || `Блок ${ci + 1}`;
    const w: string[] = [];
    const tasks = cls.tasks
      .map((t) => ({ title: (t.title ?? '').trim(), parts: t.parts.filter((n) => Number.isFinite(n) && n >= 0) }))
      .filter((t) => t.parts.length > 0);

    if (!tasks.length) {
      warnings.push(`${label}: не удалось определить разбаловку заданий — блок пропущен`);
      return;
    }

    const maxes = tasks.flatMap((t) => t.parts);
    const structureText = tasks.map((t) => t.parts.join('+')).join('; ');
    const titles = tasks.map((t) => t.title);
    const ladder: LadderRow[] = [];

    cls.rows.forEach((row, ri) => {
      const scores = row.scores;
      const written = row.written_total;
      const where = `строка ${ri + 1}${written != null ? ` (подписана ${written})` : ''}`;
      if (scores.length !== maxes.length) {
        w.push(`${where}: ${scores.length} чисел вместо ${maxes.length} — строка пропущена`);
        return;
      }
      if (scores.some((n) => !Number.isFinite(n) || n < 0)) {
        w.push(`${where}: нечитаемые значения — строка пропущена`);
        return;
      }
      const over = scores.findIndex((n, i) => n > maxes[i]);
      if (over >= 0) {
        w.push(`${where}: в колонке ${over + 1} балл ${scores[over]} больше максимума ${maxes[over]}`);
      }
      const total = scores.reduce((a, b) => a + b, 0);
      if (written != null && written !== total) {
        w.push(`строка подписана ${written}, сумма ${total} — взята сумма`);
      }
      ladder.push({ total, scores });
    });

    if (!ladder.length) {
      w.push('ни одной пригодной строки');
    } else if (ladder[0].scores.join() !== maxes.join()) {
      w.push(`первая строка (${ladder[0].scores.join(' ')}) не совпадает с максимумами разбаловки (${maxes.join(' ')})`);
    }

    const seen = new Map<number, string>();
    for (const r of ladder) {
      const prev = seen.get(r.total);
      if (prev != null) w.push(`сумма ${r.total} встречается дважды (строки «${prev}» и «${r.scores.join(' ')}»)`);
      else seen.set(r.total, r.scores.join(' '));
    }

    for (const note of cls.notes) if (note.trim()) w.push(`замечание модели: ${note.trim()}`);

    classes.push({ label, structureText, titles, ladder, warnings: w });
  });

  if (!classes.length) warnings.push('На фото не найдено ни одного блока с разбаловкой');
  return { classes, warnings };
}
