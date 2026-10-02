import type { Structure, Part, ScoreColumn } from './types.ts';
import { taskHeader, partHeader, bandRanges, bandLabel } from './structure.ts';

/** Ячейка шапки: row/col — 0-based в сетке физических колонок баллов (с учётом уровней). */
export interface HeaderCell { row: number; rowSpan: number; col: number; colSpan: number; text: string; vertical?: boolean }
export interface HeaderGrid {
  rows: number;        // строк в шапке баллов
  cells: HeaderCell[];
  kOf: number[];       // уровней у каждой колонки-листа
  phys: number[];      // первая физическая колонка каждого листа
  physTotal: number;   // всего физических колонок
}

/**
 * Шапка таблицы из дерева заданий: задание → критерии → подкритерии… + строка уровней.
 * Лист, у которого глубина меньше максимальной, тянется вниз (rowSpan); уровни — последняя строка.
 * Одну и ту же сетку рисуют предпросмотр и Excel.
 */
export function buildHeader(s: Structure, columns: ScoreColumn[]): HeaderGrid {
  const kOf = columns.map((c) => Math.max(1, c.bands || 1));
  const phys: number[] = [];
  let acc = 0;
  kOf.forEach((k) => { phys.push(acc); acc += k; });
  const physTotal = acc;

  const depthOf = (p: Part): number => (p.parts?.length ? 1 + Math.max(...p.parts.map(depthOf)) : 1);
  const depth = Math.max(1, ...s.tasks.map((t) => (t.parts.length ? 1 + Math.max(...t.parts.map(depthOf)) : 1)));
  const hasBands = kOf.some((k) => k > 1);
  const rows = depth + (hasBands ? 1 : 0);
  const style = s.headerStyle ?? 'full';
  const cells: HeaderCell[] = [];
  let leaf = 0;
  const widthOfLeaves = (a: number, b: number) => phys[b] + kOf[b] - phys[a];

  const leafCell = (row: number, text: string, max: number) => {
    const k = kOf[leaf];
    cells.push({ row, rowSpan: rows - row - (k > 1 ? 1 : 0), col: phys[leaf], colSpan: k, text });
    if (k > 1) bandRanges(max, k).forEach((b, bi) => cells.push({ row: rows - 1, rowSpan: 1, col: phys[leaf] + bi, colSpan: 1, text: bandLabel(b), vertical: true }));
    leaf++;
  };
  const walkPart = (p: Part, path: number[], row: number) => {
    if (p.parts?.length) {
      const start = leaf;
      p.parts.forEach((ch, i) => walkPart(ch, [...path, i], row + 1));
      cells.push({ row, rowSpan: 1, col: phys[start], colSpan: widthOfLeaves(start, leaf - 1), text: partHeader(p, s, path) });
    } else leafCell(row, partHeader(p, s, path), p.max);
  };
  s.tasks.forEach((t, ti) => {
    if (t.parts.length) {
      const start = leaf;
      t.parts.forEach((p, i) => walkPart(p, [ti, i], 1));
      cells.push({ row: 0, rowSpan: 1, col: phys[start], colSpan: widthOfLeaves(start, leaf - 1), text: taskHeader(t, ti, style) });
    } else leafCell(0, taskHeader(t, ti, style), t.max);
  });
  cells.sort((a, b) => a.row - b.row || a.col - b.col);
  return { rows, cells, kOf, phys, physTotal };
}
