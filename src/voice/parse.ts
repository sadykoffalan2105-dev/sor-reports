/**
 * Разбор надиктованной фразы: числа (цифрами и словами — русский и узбекский),
 * команды («дальше», «отсутствует», «отмена»…), фамилия ученика.
 * Чистая логика без браузера — проверяется test/voice.ts.
 */

export interface NumTok { value: number; raw: string }

export type Command =
  | 'next' | 'prev' | 'absent' | 'undo' | 'stop' | 'repeat' | 'restart' | 'full'
  | 'download' | 'print' | 'nextClass' | 'prevClass' | 'clear';

export interface Parsed {
  text: string;          // нормализованный текст
  nums: NumTok[];        // числа по порядку
  words: string[];       // слова, не являющиеся числами и служебными
  commands: Command[];
  total: boolean;        // сказали «общий / итог / всего»
}

const UNITS: Record<string, number> = {
  ноль: 0, нуль: 0, один: 1, одна: 1, одно: 1, раз: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5,
  шесть: 6, семь: 7, восемь: 8, девять: 9,
  единица: 1, двойка: 2, тройка: 3, четверка: 4, пятерка: 5,
  // узбекский (латиница и кириллица)
  nol: 0, bir: 1, ikki: 2, uch: 3, "to'rt": 4, tort: 4, besh: 5, olti: 6, yetti: 7, sakkiz: 8, "to'qqiz": 9, toqqiz: 9,
  бир: 1, икки: 2, уч: 3, тўрт: 4, беш: 5, олти: 6, етти: 7, саккиз: 8, тўққиз: 9,
};
const TEENS: Record<string, number> = {
  десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15,
  шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19, сто: 100,
};
/** Десятки, после которых может идти единица: «сорок шесть», «qirq olti», «o'n besh». */
const TENS: Record<string, number> = {
  двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90,
  "o'n": 10, on: 10, yigirma: 20, "o'ttiz": 30, ottiz: 30, qirq: 40, ellik: 50,
  ўн: 10, йигирма: 20, ўттиз: 30, қирқ: 40, эллик: 50,
};
/** Слова-паразиты, которые не мешают разбору. */
const FILLER = new Set(['балл', 'балла', 'баллов', 'баллы', 'по', 'и', 'а', 'это', 'ну', 'так', 'вот', 'ball', 'балл.', 'за', 'получил', 'получила', 'у', 'него', 'неё', 'нее', 'ученик', 'ученица', 'критерий', 'задание']);

/** Слово целиком: границы — пробел или край строки; «*» в шаблоне — любые буквы (кириллица тоже). */
const W = (alts: string): RegExp => new RegExp(`(?:^|\\s)(?:${alts.replace(/\*/g, "[\\p{L}']*")})(?=\\s|$)`, 'u');

const CMD: [Command, RegExp][] = [
  ['nextClass', W('следующ* класс|класс дальше|keyingi sinf')],
  ['prevClass', W('предыдущ* класс|прошл* класс|oldingi sinf')],
  ['download', W('скача*|сохрани*|выгрузи*')],
  ['print', W('печат*|распечата*')],
  ['stop', W("стоп|хватит|законч*|выключ*|остановись|to'xta|toxta")],
  ['undo', W('отмен*|откат*|верни как было|bekor')],
  ['clear', W('очисти*|стереть|сотри')],
  ['absent', W("отсутству*|не было|не пришл*|не пришел|болеет|болел*|kelmagan|yo'q")],
  ['repeat', W('повтори*|прочитай|что там|qaytar')],
  ['restart', W('сначала|заново|с начала')],
  ['full', W("все полные|всё полностью|все полностью|максимум|полный балл|все на максимум|всё на максимум|hammasi to'liq")],
  ['prev', W('назад|предыдущ*|вернись|oldingi|orqaga')],
  ['next', W('дальше|далее|следующ*|пропусти*|некст|next|keyingi')],
];
const TOTAL_RE = W('общий|общая|общего|итог*|всего|сумма|итого|jami|umumiy');

export function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/[‘’ʻʼ`]/g, "'").replace(/[.,;:!?«»"()]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Разбор фразы на числа, слова и команды. */
export function parsePhrase(input: string): Parsed {
  const text = normalize(input);
  const tokens = text.replace(/(\d)-(\d)/g, '$1 $2').replace(/-/g, ' ').split(' ').filter(Boolean);
  const nums: NumTok[] = [];
  const words: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^\d+$/.test(t)) { nums.push({ value: Number(t), raw: t }); continue; }
    if (/^\d+[,.]\d+$/.test(t)) { nums.push({ value: Math.round(Number(t.replace(',', '.'))), raw: t }); continue; }
    if (t in TENS) {
      const nx = tokens[i + 1];
      if (nx && nx in UNITS && UNITS[nx] > 0) { nums.push({ value: TENS[t] + UNITS[nx], raw: `${t} ${nx}` }); i++; }
      else nums.push({ value: TENS[t], raw: t });
      continue;
    }
    if (t in TEENS) { nums.push({ value: TEENS[t], raw: t }); continue; }
    if (t in UNITS) { nums.push({ value: UNITS[t], raw: t }); continue; }
    if (!FILLER.has(t)) words.push(t);
  }
  const commands = CMD.filter(([, re]) => re.test(text)).map(([c]) => c);
  if (text === 'нет' || text === 'нету') commands.push('absent');
  // «следующий класс» — не «следующий ученик»
  const cmds = commands.includes('nextClass') || commands.includes('prevClass') ? commands.filter((c) => c !== 'next' && c !== 'prev') : commands;
  return { text, nums, words, commands: cmds, total: TOTAL_RE.test(text) };
}

/** Заменить числа-слова цифрами, остальной текст оставить: «Иванов Пётр сорок шесть» → «Иванов Пётр 46». */
export function wordsToDigits(input: string): string {
  const parts = input.trim().split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const w = normalize(parts[i]);
    if (w in TENS) {
      const nx = parts[i + 1] ? normalize(parts[i + 1]) : '';
      if (nx in UNITS && UNITS[nx] > 0) { out.push(String(TENS[w] + UNITS[nx])); i++; } else out.push(String(TENS[w]));
    } else if (w in TEENS) out.push(String(TEENS[w]));
    else if (w in UNITS && !/^(раз|одна|одно)$/.test(w)) out.push(String(UNITS[w]));
    else out.push(parts[i]);
  }
  return out.join(' ');
}

/**
 * Разрезать слитно распознанное число по колонкам: «555» при максимумах 5,5,5 → 5,5,5;
 * «1610» при 20,10 → 16,10. Каждая часть 1–2 цифры, не больше максимума колонки.
 */
export function splitDigits(raw: string, maxes: number[]): number[] | null {
  if (!/^\d+$/.test(raw)) return null;
  const go = (s: string, k: number): number[] | null => {
    if (!s) return [];
    if (k >= maxes.length) return null;
    for (const len of [2, 1]) {
      if (s.length < len) continue;
      const part = s.slice(0, len);
      if (len === 2 && part[0] === '0') continue;
      const v = Number(part);
      if (v > maxes[k]) continue;
      const rest = go(s.slice(len), k + 1);
      if (rest) return [v, ...rest];
    }
    return null;
  };
  const r = go(raw, 0);
  return r && r.length > 1 ? r : null;
}

export type Interpretation =
  | { kind: 'total'; value: number }
  | { kind: 'cells'; start: number; values: number[] }
  | { kind: 'error'; message: string };

/**
 * Что значат числа фразы для текущего ученика.
 * mode 'criteria' — баллы по критериям с позиции cursor; одно число больше максимума первого критерия
 * (в начале строки) считается общим баллом. mode 'total' — одно число = общий балл.
 */
export function interpret(nums: NumTok[], maxes: number[], cursor: number, mode: 'criteria' | 'total', totalWord: boolean, names: string[] = []): Interpretation {
  const totalMax = maxes.reduce((a, b) => a + b, 0);
  if (!nums.length) return { kind: 'error', message: 'не услышал чисел' };
  if (mode === 'total' || totalWord || maxes.length === 1) {
    if (nums.length !== 1) return { kind: 'error', message: `нужно одно число — общий балл (услышал: ${nums.map((n) => n.value).join(' ')})` };
    const v = nums[0].value;
    if (v > totalMax) return { kind: 'error', message: `${v} больше максимума ${totalMax}` };
    return { kind: 'total', value: v };
  }
  if (nums.length === 1 && cursor === 0 && nums[0].value > maxes[0]) {
    const v = nums[0].value;
    if (v <= totalMax) return { kind: 'total', value: v };
    const split = splitDigits(nums[0].raw, maxes);
    if (split) return { kind: 'cells', start: 0, values: split };
    return { kind: 'error', message: `${v} больше максимума ${totalMax}` };
  }
  const values: number[] = [];
  let p = cursor;
  for (const n of nums) {
    if (p >= maxes.length) return { kind: 'error', message: `лишние числа: критериев всего ${maxes.length}` };
    if (n.value <= maxes[p]) { values.push(n.value); p++; continue; }
    const split = splitDigits(n.raw, maxes.slice(p));
    if (split) { values.push(...split); p += split.length; continue; }
    return { kind: 'error', message: `${n.value} больше максимума ${maxes[p]} для ${names[p] ?? `критерия ${p + 1}`}` };
  }
  return { kind: 'cells', start: cursor, values };
}

/** Похоже ли слово на фамилию: совпадение начала (от 4 букв) или расстояние правки ≤ 2. */
export function findStudent(words: string[], students: string[]): number {
  if (!words.length) return -1;
  const cand = words.slice(0, 2).map(normalize).filter((w) => w.length >= 3);
  let best = -1, bestScore = 0;
  students.forEach((name, i) => {
    const parts = normalize(name).split(' ');
    for (const w of cand) for (const p of parts) {
      let score = 0;
      if (p === w) score = 3;
      else if (w.length >= 4 && (p.startsWith(w) || w.startsWith(p.slice(0, Math.max(4, p.length - 2))))) score = 2;
      else if (w.length >= 5 && lev(w, p) <= 2) score = 1;
      if (parts[0] === p) score += 0.5; // фамилия важнее имени
      if (score > bestScore) { bestScore = score; best = i; }
    }
  });
  return bestScore >= 1 ? best : -1;
}

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

/** Сказать числа так, чтобы синтезатор не путал: «5, 5, 16». */
export const sayNumbers = (vals: number[]): string => vals.join(', ');
