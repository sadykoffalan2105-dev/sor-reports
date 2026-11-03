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
  return [...BUILTIN_PRESETS.map((p) => ({ id: newPresetId(), name: p.name, structure: parseStructure(p.text)! })), technologyPreset(), rusSochPreset()];
}

/** Русский язык — СОЧ из 10 тестов: знание 3 × 2,5; применение 6 × 4,5; размышление 1 × 5,5 (40 баллов). */
export const RUS_SOCH_NAME = 'Русский язык — СОЧ 40 (10 тестов)';
export function rusSochPreset(): Preset {
  const t = (title: string, n: number, step: number): Task => ({ title, max: n * step, step, parts: [] });
  return { id: newPresetId(), name: RUS_SOCH_NAME, structure: { tasks: [t('Знание', 3, 2.5), t('Применение', 6, 4.5), t('Размышление', 1, 5.5)], headerStyle: 'paren' } };
}

/** Технология — форма с уровнями: 1.1 (5, у всех 5), 2 зад (2.1 5, 2.2 10, 2.3 10, 2.4 5), 3 зад (5, у всех 5). */
export const TECH_NAME = 'Технология — форма с уровнями';
export function technologyPreset(): Preset {
  const one = (title: string): Task => ({ title, max: 5, parts: [{ label: '', max: 5, fixed: 5 }] });
  return {
    id: newPresetId(), name: TECH_NAME,
    structure: { tasks: [one('1.1'), { title: '2 зад 40 балл', max: 30, parts: [5, 10, 10, 5].map((m) => ({ label: '', max: m })) }, one('3 зад')], bands: 3, headerStyle: 'short', partNumbering: true },
  };
}

/** Совместимость: старый список шаблонов для выпадающего списка. */
export const PRESETS = BUILTIN_PRESETS;
