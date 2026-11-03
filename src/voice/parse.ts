/**
 * Разбор надиктованной фразы: числа (цифрами и словами — русский и узбекский),
 * команды («дальше», «отсутствует», «отмена»…), фамилия ученика.
 * Чистая логика без браузера — проверяется test/voice.ts.
 */

export interface NumTok { value: number; raw: string }

export type Command =
  | 'fix' | 'goto'
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
  нуля: 0, одного: 1, двух: 2, трех: 3, четырех: 4, пяти: 5, пятью: 5, шести: 6, семи: 7, восьми: 8, девяти: 9,
  бир: 1, икки: 2, уч: 3, тўрт: 4, беш: 5, олти: 6, етти: 7, саккиз: 8, тўққиз: 9,
};
const TEENS: Record<string, number> = {
  десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15,
  шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19, сто: 100,
  десяти: 10, одиннадцати: 11, двенадцати: 12, тринадцати: 13, четырнадцати: 14, пятнадцати: 15,
  шестнадцати: 16, семнадцати: 17, восемнадцати: 18, девятнадцати: 19,
};
/** Десятки, после которых может идти единица: «сорок шесть», «qirq olti», «o'n besh». */
const TENS: Record<string, number> = {
  двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80, девяносто: 90,
  двадцати: 20, тридцати: 30, сорока: 40, пятидесяти: 50,
  "o'n": 10, on: 10, yigirma: 20, "o'ttiz": 30, ottiz: 30, qirq: 40, ellik: 50,
  ўн: 10, йигирма: 20, ўттиз: 30, қирқ: 40, эллик: 50,
};
/** Слова-паразиты, которые не мешают разбору. */
const FILLER = new Set(['балл', 'балла', 'баллов', 'баллы', 'по', 'и', 'а', 'это', 'ну', 'так', 'вот', 'ball', 'балл.', 'за', 'получил', 'получила', 'у', 'него', 'неё', 'нее', 'ученик', 'ученица', 'задание', 'тире', 'дефис', 'запятая', 'точка', 'плюс', 'потом', 'еще']);

/** Слово целиком: границы — пробел или край строки; «*» в шаблоне — любые буквы (кириллица тоже). */
const W = (alts: string): RegExp => new RegExp(`(?:^|\\s)(?:${alts.replace(/\*/g, "[\\p{L}']*")})(?=\\s|$)`, 'u');

const CMD: [Command, RegExp][] = [
  ['fix', W('исправ*|поправ*|критерий')],
  ['goto', W('номер|под номером')],
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
const TOTAL_RE = W('общий|общая|общие|общее|общего|итог*|всего|сумма|итого|jami|umumiy');

export function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/[‘’ʻʼ`]/g, "'").replace(/[.,;:!?«»"()|/\\]/g, ' ').replace(/\s+/g, ' ').trim();
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

/**
 * Найти ученика по услышанным словам (фамилия, фамилия + имя, начало фамилии) — по звучанию.
 * −1, если уверенного совпадения нет: тогда балл не записывается чужому ученику.
 */
export function findStudent(words: string[], students: string[], aliases: Aliases = {}, variants: Variants = {}): number {
  const cand = words.map(normalize).filter(Boolean).slice(0, 5);
  if (!cand.length) return -1;
  // окна из 1–4 слов от начала фразы: распознаватель режет узбекскую фамилию на куски («об дурак мы ноф»)
  const qs: { q: string; w: number }[] = [];
  for (let a = 0; a < Math.min(3, cand.length); a++) for (let k = 1; k <= 4 && a + k <= cand.length; k++) qs.push({ q: nameKey(cand.slice(a, a + k).join('')), w: a ? 0.97 - 0.02 * a : 1 });
  const norm = students.map(normalize);
  for (const { q } of qs) { const i = aliases[q] ? norm.indexOf(aliases[q]) : -1; if (i >= 0) return i; } // выученное произношение
  // голосовая база: как распознаватель слышит имя (выучено / из базы) → дополнительные «звучания» ученика
  const hashes = norm.map(fnv);
  const extra: string[][] = norm.map(() => []);
  for (const [k, v] of Object.entries(aliases)) { const i = norm.indexOf(v); if (i >= 0) extra[i].push(k); }
  for (const [k, v] of Object.entries(variants)) { const i = hashes.indexOf(v); if (i >= 0) extra[i].push(k); }
  const scores = norm.map((name, si) => {
    const p = name.split(' ');
    const sur = nameKey(p[0]), first = nameKey(p[1] ?? ''), sf = nameKey(p.slice(0, 2).join('')), fs = nameKey([p[1] ?? '', p[0]].join(''));
    let best = 0;
    for (const { q, w } of qs) {
      if (q.length < 3) continue;
      let s = Math.max(sim(q, sur), sim(q, sf), 0.96 * sim(q, fs), 0.9 * sim(q, first));
      s = Math.max(s, 0.97 * sim(stem(q), stem(sur)), 0.95 * sim(stem(q), stem(sf))); // без -ов/-ова/-ев/-ева
      if (w === 1 && skel(q).length >= 4) s = Math.max(s, 0.88 * sim(skel(q), skel(sur)), 0.86 * sim(skel(q), skel(sf))); // согласные
      if (q.length >= Math.max(5, sur.length * 0.6) && sur.startsWith(q)) s = Math.max(s, 0.88);
      if (sur.length >= 4 && q.startsWith(sur)) s = Math.max(s, 0.9);
      best = Math.max(best, s * w);
    }
    for (const k of extra[si]) for (const { q, w } of qs) if (q.length >= 3) best = Math.max(best, (k === q ? 1 : 0.97 * sim(q, k)) * w);
    return best;
  });
  const order = scores.map((v, i) => [v, i] as const).sort((x, y) => y[0] - x[0]);
  const top = order[0], second = order[1] ?? [0, -1];
  if (!top || top[0] < 0.7) return -1;
  if (top[0] < 0.92 && top[0] - second[0] < 0.06) return -1; // два похожих — не угадываем
  return top[1];
}

/** Выученные произношения: звуковой ключ услышанного → имя ученика (как в списке, normalize). */
export type Aliases = Record<string, string>;
/** Голосовая база: звуковой ключ услышанного → хеш имени ученика (сами имена в базе не хранятся). */
export type Variants = Record<string, string>;
/** Короткий хеш (FNV-1a) нормализованного имени. */
export const fnv = (s: string): string => { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return (x >>> 0).toString(36); };
/** Звуковой ключ имени с поправками на узбекские звуки: х/қ ≈ к, дж ≈ ж, ғ ≈ г, ў ≈ у. */
export const nameKey = (s: string): string => phon(normalize(s).replace(/дж/g, 'ж').replace(/[хқ]/g, 'к').replace(/ғ/g, 'г').replace(/ў/g, 'у'));
const stem = (k: string) => k.replace(/(афа|ифа|аф|иф)$/, '');
const skel = (k: string) => k.replace(/[аиу]/g, '');

/**
 * Слова имени из фразы: всё до первого числа или команды, включая короткие куски («а лайнеров» = Аллаёров).
 * Если имя не в начале — прежнее правило: все слова, похожие на имя.
 */
export function nameWords(text: string): string[] {
  const words = normalize(text).split(' ').filter(Boolean);
  while (words.length && /^(ну|так|вот|это|значит|теперь)$/.test(words[0])) words.shift();
  const cmd = parsePhrase(text).commands.length > 0; // слова команды («все на максимум», «следующий класс») — не имя
  const out: string[] = [];
  for (const w of words) {
    const q = parsePhrase(w); if (q.commands.length || q.total || q.nums.length) break;
    if (!(cmd && GRAMMAR_WORDS.includes(w))) out.push(w);
  }
  return out.join('').length >= 3 ? out : nameLike(words).filter((w) => !(cmd && GRAMMAR_WORDS.includes(w)));
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

/** Словарь узкого (офлайн) распознавателя: числа и команды — всё, что нужно для баллов. */
export const GRAMMAR_WORDS: string[] = [
  'ноль', 'один', 'одна', 'два', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять',
  'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать',
  'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'сто',
  'дальше', 'далее', 'следующий', 'назад', 'предыдущий', 'пропусти',
  'отсутствует', 'отсутствовал', 'отсутствовала', 'нет', 'не', 'было', 'болеет',
  'отмена', 'отмени', 'стоп', 'хватит', 'повтори', 'сначала', 'заново',
  'общий', 'итого', 'итог', 'всего', 'все', 'на', 'максимум', 'полный', 'балл', 'баллов', 'балла',
  'класс', 'скачать', 'скачай', 'печать', 'исправь', 'критерий', 'номер',
];

const LAT: [RegExp, string][] = [
  [/sh/g, 'ш'], [/ch/g, 'ч'], [/zh/g, 'ж'], [/kh/g, 'х'], [/ts/g, 'ц'], [/yo/g, 'е'], [/yu/g, 'ю'], [/ya/g, 'я'], [/ye/g, 'е'],
  [/o'/g, 'у'], [/g'/g, 'г'],
];
const LAT1: Record<string, string> = { a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и', j: 'ж', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п', q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'х', y: 'й', z: 'з' };
const PH: Record<string, string> = { а: 'а', о: 'а', е: 'и', э: 'и', и: 'и', ы: 'и', я: 'и', й: 'и', у: 'у', ю: 'у', б: 'п', в: 'ф', г: 'к', д: 'т', ж: 'ш', з: 'с', щ: 'ш', ц: 'с', ь: '', ъ: '', "'": '', ' ': '' };

/** Звуковой ключ фамилии: «Шерматов» и «шерматова», «Farmonov» и «фармонов» дают близкие ключи. */
export function phon(input: string): string {
  let t = normalize(input);
  for (const [re, r] of LAT) t = t.replace(re, r);
  t = t.replace(/[a-z]/g, (ch) => LAT1[ch] ?? ch);
  let out = '';
  for (const ch of t) { const m = PH[ch] ?? ch; for (const c of m) if (c && out[out.length - 1] !== c) out += c; }
  return out;
}
const sim = (a: string, b: string): number => (a && b ? 1 - lev(a, b) / Math.max(a.length, b.length) : 0);

/** Слова, похожие на попытку назвать ученика (не числа, не команды, не «ну/и»). */
export const nameLike = (words: string[]): string[] => words.filter((w) => { if (w.length < 3) return false; const q = parsePhrase(w); return !q.commands.length && !q.total && !q.nums.length; });
