import type { Structure, Task, Part, ScoreColumn } from './types.ts';

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
        cols.push({ key: `t${ti}p${pi}`, taskIndex: ti, partIndex: pi, header: p.label || pointsLabel(p.max), max: p.max }),
      );
    } else {
      cols.push({ key: `t${ti}`, taskIndex: ti, partIndex: -1, header: '', max: t.max });
    }
  });
  return cols;
}

export function pointsLabel(n: number): string {
  const m = Math.abs(n) % 100, d = m % 10;
  const w = m > 10 && m < 20 ? 'баллов' : d === 1 ? 'балл' : d >= 2 && d <= 4 ? 'балла' : 'баллов';
  return `${n} ${w}`;
}

/** Заголовок задания в строке 5: «2 задание 40 баллов». */
export function taskHeader(t: Task, i: number): string {
  return `${i + 1} задание ${pointsLabel(taskMax(t))}`;
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

export function structureToText(s: Structure): string {
  return s.tasks.map((t) => (t.parts.length ? t.parts.map((p) => p.max).join('+') : String(t.max))).join('; ');
}

export const PRESETS: { name: string; text: string }[] = [
  { name: 'СОР 50: 5; 5+5+20+10; 5', text: '5; 5+5+20+10; 5' },
  { name: 'СОР 50: 5; 5+30+5; 5', text: '5; 5+30+5; 5' },
  { name: 'СОР 50: 5; 5+10+20+5; 5', text: '5; 5+10+20+5; 5' },
  { name: 'СОР 50: 5; 5+10+10+10+5; 5', text: '5; 5+10+10+10+5; 5' },
  { name: 'СОР 50: 5; 2+3+7+7+7+9+5; 5', text: '5; 2+3+7+7+7+9+5; 5' },
  { name: 'СОЧ 40: 5; 5+5+10+5+5; 5', text: '5; 5+5+10+5+5; 5' },
];
