import type { Structure, Task, Part, ScoreColumn, Preset } from './types.ts';

/** Сумма максимумов всех заданий. */
export function structureMax(s: Structure): number {
  return s.tasks.reduce((a, t) => a + taskMax(t), 0);
}
export function taskMax(t: Task): number {
  return t.parts.length ? t.parts.reduce((a, p) => a + p.max, 0) : t.max;
}

/** Развернуть структуру в колонки отчёта. */
export function flattenColumns(s: Structure): ScoreColumn[] {
  const cols: ScoreColumn[] = [];
  s.tasks.forEach((t, ti) => {
    if (t.parts.length) {
      t.parts.forEach((p, pi) =>
        cols.push({ key: `t${ti}p${pi}`, taskIndex: ti, partIndex: pi, header: partHeader(p), max: p.max, target: p.target }),
      );
    } else {
      cols.push({ key: `t${ti}`, taskIndex: ti, partIndex: -1, header: '', max: t.max, target: t.target });
    }
  });
  return cols;
}

export function pointsLabel(n: number): string {
  const m = Math.abs(n) % 100, d = m % 10;
  const w = m > 10 && m < 20 ? 'баллов' : d === 1 ? 'балл' : d >= 2 && d <= 4 ? 'балла' : 'баллов';
  return `${n} ${w}`;
}

/** Заголовок задания в строке 5: «2 задание 40 баллов», при наличии названия — со второй строкой. */
export function taskHeader(t: Task, i: number): string {
  const base = `${i + 1} задание ${pointsLabel(taskMax(t))}`;
  return t.title?.trim() ? `${base}\n${t.title.trim()}` : base;
}

/** Заголовок подкритерия в строке 6: «5 баллов» или «Название\n5 баллов». */
export function partHeader(p: Part): string {
  return p.label?.trim() ? `${p.label.trim()}\n${pointsLabel(p.max)}` : pointsLabel(p.max);
}

/** Название колонки для легенды диаграммы: «2.3 Чертёж (20 баллов)» или «1 задание — Тест». */
export function columnName(tasks: Task[], col: ScoreColumn): string {
  const t = tasks[col.taskIndex];
  if (!t) return '';
  if (col.partIndex < 0) return t.title?.trim() ? `${col.taskIndex + 1} задание — ${t.title.trim()}` : taskHeader(t, col.taskIndex);
  const p = t.parts[col.partIndex];
  return `${col.taskIndex + 1}.${col.partIndex + 1}${p?.label?.trim() ? ' ' + p.label.trim() : ''} (${pointsLabel(p?.max ?? col.max)})`;
}

/**
 * Разбор краткой записи структуры: «5; 5+5+20+10; 5».
 * Задания разделяются «;» или «,», подзадания — «+» или пробелами.
 */
export function parseStructure(text: string): Structure | null {
  const tasks: Task[] = [];
  for (const chunk of text.split(/[;,\n]/)) {
    const s = chunk.trim();
    if (!s) continue;
    const nums = s.split(/[+\s/]+/).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
    if (!nums.length) return null;
    if (nums.length === 1) tasks.push({ title: '', parts: [], max: nums[0] });
    else tasks.push({ title: '', parts: nums.map((n): Part => ({ label: '', max: n })), max: nums.reduce((a, b) => a + b, 0) });
  }
  return tasks.length ? { tasks } : null;
}

/** Разобрать текст, сохранив названия заданий и критериев из прежней структуры (по позициям). */
export function structureFromText(text: string, prev?: Structure): Structure | null {
  const s = parseStructure(text);
  if (!s || !prev) return s;
  s.bands = prev.bands;
  s.tasks.forEach((t, i) => {
    const p = prev.tasks[i];
    if (!p) return;
    t.title = p.title ?? '';
    t.parts.forEach((part, j) => { part.label = p.parts[j]?.label ?? ''; });
  });
  return s;
}

/** Краткая запись (только баллы, без названий). Служит ключом лестницы. */
export function structureToText(s: Structure): string {
  return s.tasks.map((t) => (t.parts.length ? t.parts.map((p) => p.max).join('+') : String(t.max))).join('; ');
}

export function cloneStructure(s: Structure): Structure {
  return { bands: s.bands, tasks: s.tasks.map((t) => ({ title: t.title ?? '', max: t.max, target: t.target, parts: t.parts.map((p) => ({ label: p.label ?? '', max: p.max, target: p.target })) })) };
}

/** Диапазоны уровней под критерием: 5 баллов, 3 уровня → 0-1, 2-3, 4-5; 15 → 0-5, 6-10, 11-15. */
export function bandRanges(max: number, k: number): { lo: number; hi: number }[] {
  if (k <= 1 || max <= 0) return [{ lo: 0, hi: max }];
  const out: { lo: number; hi: number }[] = [];
  let lo = 0;
  for (let i = 1; i <= k; i++) { const hi = i === k ? max : Math.floor((max * i) / k); out.push({ lo, hi: Math.max(hi, lo) }); lo = hi + 1; }
  return out;
}
export const bandLabel = (b: { lo: number; hi: number }): string => `${b.lo}-${b.hi} балл`;
/** В какой уровень попадает балл. */
export function bandIndex(value: number, max: number, k: number): number {
  const bs = bandRanges(max, k);
  const i = bs.findIndex((b) => value >= b.lo && value <= b.hi);
  return i < 0 ? bs.length - 1 : i;
}

/** Пересчитать max заданий с критериями. */
export function normalizeStructure(s: Structure): Structure {
  for (const t of s.tasks) if (t.parts.length) t.max = t.parts.reduce((a, p) => a + p.max, 0);
  return s;
}

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
  return BUILTIN_PRESETS.map((p) => ({ id: newPresetId(), name: p.name, structure: parseStructure(p.text)! }));
}

/** Совместимость: старый список шаблонов для выпадающего списка. */
export const PRESETS = BUILTIN_PRESETS;
