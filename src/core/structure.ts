import type { Structure, Task, Part, ScoreColumn, Preset, HeaderStyle } from './types.ts';

/* ---------- баллы ---------- */

/** Баллы критерия: у группы — сумма подкритериев. */
/** Сумма дробных баллов без «40.0000001». */
const rnd = (v: number) => Math.round(v * 100) / 100;
export function partMax(p: Part): number {
  return p.parts?.length ? rnd(p.parts.reduce((a, c) => a + partMax(c), 0)) : p.max;
}
export function taskMax(t: Task): number {
  return t.parts.length ? rnd(t.parts.reduce((a, p) => a + partMax(p), 0)) : t.max;
}
/** Сумма максимумов всех заданий. */
export function structureMax(s: Structure): number {
  return rnd(s.tasks.reduce((a, t) => a + taskMax(t), 0));
}

/** Узел по пути [задание, критерий, подкритерий…]. */
export function nodeAt(s: Structure, path: number[]): Task | Part | undefined {
  let node: Task | Part | undefined = s.tasks[path[0]];
  for (let i = 1; i < path.length && node; i++) node = (node as Task | Part).parts?.[path[i]];
  return node;
}

/** Уровней под колонкой: своё значение (0 = нет) или общее для разбаловки. */
export function effBands(own: number | undefined, s: Structure): number {
  const v = own ?? s.bands ?? 0;
  return v > 1 ? v : 1;
}

/** Листья дерева — колонки баллов отчёта (путь: [задание, критерий, подкритерий…]). */
/** Типичные стоимости вопроса в тестовых СОР/СОЧ. */
const AUTO_STEPS = [2.5, 4.5, 5.5, 1.5, 3.5, 6.5, 7.5];
export function flattenColumns(s: Structure): ScoreColumn[] {
  const cols: ScoreColumn[] = [];
  s.tasks.forEach((t, ti) => {
    if (!t.parts.length) {
      cols.push({ key: `t${ti}`, taskIndex: ti, partIndex: -1, path: [ti], header: '', max: t.max, target: t.target, step: t.step, bands: effBands(t.bands, s) });
      return;
    }
    const walk = (parts: Part[], path: number[]) => parts.forEach((p, pi) => {
      const np = [...path, pi];
      if (p.parts?.length) walk(p.parts, np);
      else cols.push({ key: 't' + np.join('_'), taskIndex: ti, partIndex: np[1], path: np, header: partHeader(p, s, np), max: p.max, target: p.target, fixed: p.fixed, step: p.step, bands: effBands(p.bands, s) });
    });
    walk(t.parts, [ti]);
  });
  // дробная разбаловка (7,5; 27; 5,5 — тесты по 2,5 / 4,5 / 5,5): шаг вопроса подбирается сам, если не задан
  if (cols.some((c) => !Number.isInteger(c.max))) for (const c of cols) if (!c.step) c.step = AUTO_STEPS.find((st) => { const n = c.max / st; return Math.abs(n - Math.round(n)) < 1e-9 && n >= 1 && n <= 10; });
  return cols;
}

/* ---------- подписи ---------- */

export function pointsLabel(n: number): string {
  const m = Math.abs(n) % 100, d = m % 10;
  const w = m > 10 && m < 20 ? 'баллов' : d === 1 ? 'балл' : d >= 2 && d <= 4 ? 'балла' : 'баллов';
  return `${String(n).replace('.', ',')} ${Number.isInteger(n) ? w : 'балла'}`;
}

/** Номер узла в шапке: «2.1.3». */
export const pathNum = (path: number[]): string => path.map((x) => x + 1).join('.');

/** Заголовок задания: «2 задание 40 баллов» (или «2 зад\n40 балл»), при наличии названия — ещё строка. */
export function taskHeader(t: Task, i: number, style: HeaderStyle = 'full'): string {
  if (style === 'paren') return hasPts(t.title) ? t.title!.trim() : `${t.title?.trim() || `${i + 1} задание`} (${pointsLabel(taskMax(t))})`;
  if (hasPts(t.title) || /^\d+(\.\d+)*(\s*зад\S*)?$/i.test(t.title?.trim() ?? '')) return t.title!.trim().replace(/^(\d+\s*зад\S*)\s+(\d+)\s+(балл\S*)$/i, '$1\n$2\n$3');
  const base = style === 'short' ? `${i + 1} зад\n${taskMax(t)} балл` : `${i + 1} задание ${pointsLabel(taskMax(t))}`;
  return t.title?.trim() ? `${base}\n${t.title.trim()}` : base;
}

/** Заголовок критерия/группы: «5 баллов», «2.1\n5 балл», с названием — ещё строка. */
export function partHeader(p: Part, s?: Structure, path: number[] = []): string {
  const max = partMax(p);
  if (s?.headerStyle === 'paren') {
    const name = [s.partNumbering && path.length > 1 ? pathNum(path) : '', p.label?.trim() ?? ''].filter(Boolean).join(' ');
    return hasPts(p.label) ? name : name ? `${name} (${pointsLabel(max)})` : `(${pointsLabel(max)})`;
  }
  const pts = s?.headerStyle === 'short' ? `${max} балл` : pointsLabel(max);
  const alone = s && path.length > 1 && ((nodeAt(s, path.slice(0, -1)) as Task | Part | undefined)?.parts?.length ?? 0) === 1;
  const num = s?.partNumbering && path.length > 1 && !alone ? `${pathNum(path)}\n` : '';
  if (hasPts(p.label)) return `${num}${p.label!.trim()}`;
  return p.label?.trim() ? `${num}${p.label.trim()}\n${pts}` : `${num}${pts}`;
}

/** Учитель уже вписал баллы в название («Знание (5 баллов)») — шапку не дублируем. */
const hasPts = (t?: string) => !!t && /\d+\s*балл/i.test(t);

/** Название колонки для легенды диаграммы: «2.3 Чертёж (20 баллов)» или «1 задание — Тест». */
export function columnName(tasks: Task[], col: ScoreColumn): string {
  const t = tasks[col.taskIndex];
  if (!t) return '';
  if (col.path.length === 1) return t.title?.trim() ? `${t.title.trim()} (${pointsLabel(col.max)})` : taskHeader(t, col.taskIndex);
  const node = nodeAt({ tasks }, col.path) as Part | undefined;
  return `${pathNum(col.path)}${node?.label?.trim() ? ' ' + node.label.trim() : ''} (${pointsLabel(col.max)})`;
}

/* ---------- уровни ---------- */

/** Диапазоны уровней под критерием: 5 баллов, 3 уровня → 0-1, 2-3, 4-5; 15 → 0-5, 6-10, 11-15. */
export function bandRanges(max: number, k: number): { lo: number; hi: number }[] {
  if (k <= 1 || max <= 0) return [{ lo: 0, hi: max }];
  const out: { lo: number; hi: number }[] = [];
  let lo = 0;
  const n = Math.floor(max) + 1;
  for (let i = 0; i < k; i++) { const size = Math.floor(n / k) + (i < n % k ? 1 : 0); const hi = i === k - 1 ? max : Math.min(max, lo + size - 1); out.push({ lo, hi: Math.max(hi, lo) }); lo = hi + 1; }
  return out;
}
export const bandLabel = (b: { lo: number; hi: number }): string => `${b.lo}-${b.hi} балл`;
/** В какой уровень попадает балл. */
export function bandIndex(value: number, max: number, k: number): number {
  const bs = bandRanges(max, k);
  const i = bs.findIndex((b, j) => value >= b.lo && value < (bs[j + 1]?.lo ?? Infinity)); // 3,5 → уровень «0-3»
  return i < 0 ? bs.length - 1 : i;
}

/* ---------- текстовая запись ---------- */

/**
 * Разбор краткой записи: «5; 5+5+20+10; 5». Задания через «;», критерии через «+»,
 * подкритерии — в скобках: «5; 5+(3+2)+20+10; 5».
 */
export function parseStructure(text: string): Structure | null {
  const tasks: Task[] = [];
  for (const chunk of splitTop(text, /[;\n]/)) {
    const s = chunk.trim();
    if (!s) continue;
    const parts = parseItems(s);
    if (!parts) return null;
    if (parts.length === 1 && !parts[0].parts?.length) tasks.push({ title: '', parts: [], max: parts[0].max });
    else if (parts.length === 1 && parts[0].parts?.length) tasks.push({ title: '', parts: parts[0].parts, max: partMax(parts[0]) });
    else tasks.push({ title: '', parts, max: parts.reduce((a, p) => a + partMax(p), 0) });
  }
  return tasks.length ? { tasks } : null;
}

/** Разделить по разделителю только вне скобок. */
function splitTop(text: string, sep: RegExp): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && sep.test(ch)) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** «5+(3+2)+20» → критерии; null при ошибке. Разделители: «+», «,», пробел. */
function parseItems(src: string): Part[] | null {
  let i = 0;
  const parseList = (): Part[] | null => {
    const items: Part[] = [];
    while (i < src.length) {
      const ch = src[i];
      if (/[\s+,/]/.test(ch)) { i++; continue; }
      if (ch === ')') break;
      if (ch === '(') {
        i++;
        const sub = parseList();
        if (!sub || src[i] !== ')') return null;
        i++;
        if (!sub.length) return null;
        items.push(sub.length === 1 && !sub[0].parts?.length ? sub[0] : { label: '', max: sub.reduce((a, p) => a + partMax(p), 0), parts: sub });
        continue;
      }
      const m = src.slice(i).match(/^\d+(?:[.,]\d+)?/);
      if (!m) return null;
      i += m[0].length;
      items.push({ label: '', max: Number(m[0].replace(',', '.')) });
    }
    return items;
  };
  const items = parseList();
  if (!items || i < src.length) return null;
  return items.length ? items : null;
}

/** Краткая запись (только баллы, без названий). Служит ключом раскладки. */
export function structureToText(s: Structure): string {
  const partText = (p: Part): string => (p.parts?.length ? `(${p.parts.map(partText).join('+')})` : String(p.max));
  return s.tasks.map((t) => (t.parts.length ? t.parts.map(partText).join('+') : String(t.max))).join('; ');
}

/** Разобрать текст, сохранив названия, цели и уровни из прежней структуры (по позициям). */
export function structureFromText(text: string, prev?: Structure): Structure | null {
  const s = parseStructure(text);
  if (!s || !prev) return s;
  s.bands = prev.bands; s.headerStyle = prev.headerStyle; s.partNumbering = prev.partNumbering;
  const copyParts = (dst: Part[] | undefined, src: Part[] | undefined) => {
    if (!dst || !src) return;
    dst.forEach((d, j) => { const o = src[j]; if (!o) return; d.label = o.label ?? ''; d.target = o.target; d.bands = o.bands; d.fixed = o.fixed; d.step = o.step; copyParts(d.parts, o.parts); });
  };
  s.tasks.forEach((t, i) => {
    const p = prev.tasks[i];
    if (!p) return;
    t.title = p.title ?? ''; t.bands = p.bands; t.target = p.target; t.step = p.step;
    copyParts(t.parts, p.parts);
  });
  return s;
}

/**
 * Разбаловка на другое число баллов (СОР бывает на 20, 25, 30, 50 …): каждый критерий пропорционально,
 * целыми баллами, сумма — ровно newMax (остаток — критериям с наибольшей дробной частью). Названия, уровни сохраняются.
 */
export function scaleStructure(src: Structure, newMax: number): Structure {
  const st = cloneStructure(src);
  const leaves: { node: Task | Part; max: number }[] = [];
  const walk = (n: Task | Part) => { if (n.parts?.length) n.parts.forEach(walk); else leaves.push({ node: n, max: n.max }); };
  st.tasks.forEach(walk);
  const old = leaves.reduce((a, l) => a + l.max, 0);
  if (!old || newMax <= 0) return st;
  // целые, если делится ровно; иначе ровно половинками (5 → 2,5); иначе целые с остатком
  const exact = (u: number) => leaves.every((l) => Math.abs(((l.max * newMax) / old / u) - Math.round((l.max * newMax) / old / u)) < 1e-9);
  const unit = exact(1) ? 1 : exact(0.5) ? 0.5 : Number.isInteger(newMax) ? 1 : 0.5;
  const raw = leaves.map((l) => (l.max * newMax) / old / unit);
  const out = raw.map((x) => Math.max(raw.length > newMax / unit ? 0 : 1, Math.floor(x)));
  let left = Math.round(newMax / unit) - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => ({ i, f: x - Math.floor(x) })).sort((a, b) => b.f - a.f || leaves[b.i].max - leaves[a.i].max);
  for (let k = 0; left > 0; k++) { out[order[k % order.length].i]++; left--; }
  while (left < 0) { const i = out.indexOf(Math.max(...out)); if (out[i] <= 0) break; out[i]--; left++; } // перебор — с самого крупного
  leaves.forEach((l, i) => {
    const n = l.node as Part; n.max = out[i] * unit;
    if (n.fixed != null) n.fixed = n.max; // «у всех» — полный балл критерия
    n.step = undefined; // стоимость вопроса на новой разбаловке не сохраняется
  });
  for (const t of st.tasks) { if (t.parts.length) t.max = taskMax(t); t.title = t.title?.replace(/\b\d+(\s*балл)/i, (_m, w) => `${taskMax(t)}${w}`) ?? ''; }
  return st;
}

export function cloneStructure(s: Structure): Structure {
  const cp = (p: Part): Part => ({ label: p.label ?? '', max: p.max, target: p.target, bands: p.bands, ...(p.fixed != null ? { fixed: p.fixed } : {}), ...(p.step ? { step: p.step } : {}), ...(p.parts?.length ? { parts: p.parts.map(cp) } : {}) });
  return {
    bands: s.bands, headerStyle: s.headerStyle, partNumbering: s.partNumbering,
    tasks: s.tasks.map((t) => ({ title: t.title ?? '', max: t.max, target: t.target, bands: t.bands, ...(t.step ? { step: t.step } : {}), parts: t.parts.map(cp) })),
  };
}

/** Пересчитать баллы групп и заданий с критериями. */
export function normalizeStructure(s: Structure): Structure {
  const norm = (p: Part) => { if (p.parts?.length) { p.parts.forEach(norm); p.max = partMax(p); } else delete p.parts; };
  for (const t of s.tasks) { t.parts.forEach(norm); if (t.parts.length) t.max = taskMax(t); }
  return s;
}

/* ---------- пресеты ---------- */

let presetSeq = 0;
export function newPresetId(): string {
  return `p${Date.now().toString(36)}${(++presetSeq).toString(36)}`;
}

export const BUILTIN_PRESETS: { name: string; text: string }[] = [
  { name: '5 класс — СОР 50', text: '5; 5+5+20+10; 5' },
  { name: '6 класс — СОР 50', text: '5; 2+7+7+7+7+5+5; 5' },
  { name: '7 класс — СОР 50', text: '5; 2+3+7+7+7+9+5; 5' },
  { name: '8 класс — СОР 50', text: '5; 5+10+10+10+5; 5' },
  { name: 'СОР 50 — 5; 5+30+5; 5', text: '5; 5+30+5; 5' },
  { name: 'СОЧ 40 — 5; 5+5+10+5+5; 5', text: '5; 5+5+10+5+5; 5' },
];

export function builtinPresets(): Preset[] {
  return [...BUILTIN_PRESETS.map((p) => ({ id: newPresetId(), name: p.name, structure: parseStructure(p.text)! })), technologyPreset(), techSorPreset(TECH_SOR57, [5, 15, 15, 5]), techSorPreset(TECH_SOR8, [5, 10, 10, 5, 10]), rusSochPreset(), izo7Preset()];
}

/** Русский язык — СОЧ из 10 тестов: знание 3 × 2,5; применение 6 × 4,5; размышление 1 × 5,5 (40 баллов). */
export const RUS_SOCH_NAME = 'Русский язык — СОЧ 40 (10 тестов)';
export function rusSochPreset(): Preset {
  const t = (title: string, n: number, step: number): Task => ({ title, max: n * step, step, parts: [] });
  return { id: newPresetId(), name: RUS_SOCH_NAME, structure: { tasks: [t('Знание', 3, 2.5), t('Применение', 6, 4.5), t('Размышление', 1, 5.5)], headerStyle: 'paren' } };
}

/** Технология СОР (50) по формам школы: 1.1 · 2 зад (критерии) · 3 зад, уровни под критериями; лестницы — из тетради учителя. */
export const TECH_SOR57 = 'Технология — СОР 50, 5–7 и 9 кл.';
export const TECH_SOR8 = 'Технология — СОР 50, 8 кл.';
export function techSorPreset(name: string, parts: number[]): Preset {
  const one = (title: string): Task => ({ title, max: 5, parts: [{ label: '', max: 5 }] });
  return { id: newPresetId(), name, structure: { tasks: [one('1.1'), { title: '2 зад 40 балл', max: 40, parts: parts.map((m) => ({ label: '', max: m })) }, one('3 зад')], bands: 3, headerStyle: 'short', partNumbering: true } };
}
/** Лестницы учителя: общий балл → баллы по колонкам (1.1, 2.1 …, 3 зад). Ключ — разбаловка текстом. */
export const TECH_LADDERS: Record<string, Record<string, number[]>> = {
  '5; 5+15+15+5; 5': { 50: [5, 5, 15, 15, 5, 5], 48: [5, 5, 13, 15, 5, 5], 46: [5, 5, 13, 13, 5, 5], 44: [5, 5, 11, 13, 5, 5], 42: [5, 5, 11, 11, 5, 5], 40: [5, 5, 10, 10, 5, 5] },
  '5; 5+10+10+5+10; 5': { 50: [5, 5, 10, 10, 5, 10, 5], 48: [5, 5, 8, 10, 5, 10, 5], 46: [5, 5, 8, 8, 5, 10, 5], 44: [5, 5, 8, 8, 5, 8, 5], 42: [5, 5, 6, 8, 5, 8, 5], 40: [5, 5, 6, 8, 5, 6, 5] },
  // ИЗО 7 кл.: по 1 баллу по очереди с критериев на 8 и 7, затем 6, в конце 5 и 3
  '8; 7; 6; 6; 7; 8; 3; 5': { 29: [4, 4, 4, 4, 4, 4, 2, 3], 30: [4, 4, 4, 4, 4, 4, 3, 3], 31: [4, 4, 4, 4, 4, 4, 3, 4], 32: [4, 4, 4, 4, 4, 4, 3, 5], 33: [4, 4, 5, 4, 4, 4, 3, 5], 34: [4, 4, 5, 5, 4, 4, 3, 5], 35: [4, 5, 5, 5, 4, 4, 3, 5], 36: [4, 5, 5, 5, 5, 4, 3, 5], 37: [5, 5, 5, 5, 5, 4, 3, 5], 38: [5, 5, 5, 5, 5, 5, 3, 5], 39: [5, 5, 6, 5, 5, 5, 3, 5], 40: [5, 5, 6, 6, 5, 5, 3, 5], 41: [5, 6, 6, 6, 5, 5, 3, 5], 42: [5, 6, 6, 6, 6, 5, 3, 5], 43: [6, 6, 6, 6, 6, 5, 3, 5], 44: [6, 6, 6, 6, 6, 6, 3, 5], 45: [6, 7, 6, 6, 6, 6, 3, 5], 46: [6, 7, 6, 6, 7, 6, 3, 5], 47: [7, 7, 6, 6, 7, 6, 3, 5], 48: [7, 7, 6, 6, 7, 7, 3, 5], 49: [8, 7, 6, 6, 7, 7, 3, 5], 50: [8, 7, 6, 6, 7, 8, 3, 5] },
  '5; 5+10+10+5; 5': { 40: [5, 5, 10, 10, 5, 5], 38: [5, 5, 8, 10, 5, 5], 36: [5, 5, 8, 8, 5, 5], 34: [5, 5, 7, 7, 5, 5], 32: [5, 5, 6, 6, 5, 5], 30: [5, 5, 5, 5, 5, 5] },
};

/** ИЗО — СОР-1, 7 кл. (логотип класса): 8 критериев по рубрике, названия сокращены для шапки. */
export const IZO7_NAME = 'ИЗО — СОР 50, 7 кл. (логотип)';
export function izo7Preset(): Preset {
  const c: [string, number][] = [['Идея и соответствие теме', 8], ['Единство коллектива', 7], ['Композиция', 6], ['Чёткость символов', 6], ['Подбор цветов', 7], ['Оригинальность', 8], ['Техника и линии', 3], ['Аккуратность и презентация', 5]];
  return { id: newPresetId(), name: IZO7_NAME, structure: { tasks: c.map(([title, max]) => ({ title, max, parts: [] })), headerStyle: 'paren' } };
}

/** Технология — форма с уровнями: 1.1 (5, у всех 5), 2 зад (2.1 5, 2.2 10, 2.3 10, 2.4 5), 3 зад (5, у всех 5). */
export const TECH_NAME = 'Технология — СОЧ 40 (форма с уровнями)';
export const TECH_NAME_OLD = 'Технология — форма с уровнями';
export function technologyPreset(): Preset {
  const one = (title: string): Task => ({ title, max: 5, parts: [{ label: '', max: 5, fixed: 5 }] });
  return {
    id: newPresetId(), name: TECH_NAME,
    structure: { tasks: [one('1.1'), { title: '2 зад 40 балл', max: 30, parts: [5, 10, 10, 5].map((m) => ({ label: '', max: m })) }, one('3 зад')], bands: 3, headerStyle: 'short', partNumbering: true },
  };
}

/** Совместимость: старый список шаблонов для выпадающего списка. */
export const PRESETS = BUILTIN_PRESETS;
