import ExcelJS from 'exceljs';
import type { ClassReport, Settings } from '../core/types.ts';
import { columnName, bandIndex } from '../core/structure.ts';
import { buildHeader } from '../core/header.ts';
import { injectCharts, type ChartJob, type ChartSeries, type DrawingShape } from './chart.ts';

/** 1 → A, 27 → AA. */
export function colLetter(n: number): string {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const thin: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' },
};
const center: Partial<ExcelJS.Alignment> = { horizontal: 'center', vertical: 'middle', wrapText: true };
const GREEN = 'FF92D050';
const YELLOW = 'FFFFFF00'; // строки сдававших позже (форма 1/2)

/** Раскладка колонок листа (1-based). */
export interface Layout {
  reason?: number; date?: number;
  scoreStart: number; scoreEnd: number;
  total: number; percent: number; grade: number;
  last: number;
  bands: number;        // максимум уровней (1 — нет; >1 — три строки шапки)
  kOf: number[];        // уровней у каждого критерия
  phys: number[];       // первая физическая колонка каждого критерия
  helper: number;       // скрытые колонки с суммой уровней (для диаграммы), 0 — нет
}
export function layoutFor(r: ClassReport): Layout {
  const ks = r.columns.map((col) => Math.max(1, col.bands || 1));
  const k = Math.max(1, ...ks);
  let c = 3;
  const l: Partial<Layout> = {};
  if (r.absentColumns) { l.reason = c++; l.date = c++; }
  l.scoreStart = c; l.phys = []; ks.forEach((kc) => { l.phys!.push(c); c += kc; }); l.scoreEnd = c - 1;
  l.total = c++; l.percent = c++; l.grade = c++;
  l.last = l.grade; l.bands = k; l.kOf = ks; l.helper = k > 1 ? l.last + 1 : 0;
  return l as Layout;
}

/** Формула оценки по доле: =IF(J7>=0.86,5,IF(J7>=0.66,4,IF(J7>=0.3,3,2))). */
function gradeFormula(cell: string, th: ClassReport['thresholds']): string {
  return `IF(${cell}>=${th.five},5,IF(${cell}>=${th.four},4,IF(${cell}>=${th.three},3,2)))`;
}

/**
 * Высота строки заголовка (пт) при заданной ширине объединённой области (в символах 11 пт).
 * Шрифт 18 пт жирный: в строку помещается ≈0,45 ширины в символах (перенос по словам теряет место),
 * строка ≈24 пт. Раньше лимит 140 и коэффициент 0,55 обрезали последнюю строку «учебный год».
 */
function titleHeight(text: string, widthChars: number): number {
  const lines = Math.max(3, Math.ceil(text.length / Math.max(20, widthChars * 0.45)));
  return Math.min(180, Math.max(66, lines * 24 + 16));
}

function uniqueSheetName(name: string, used: Set<string>): string {
  let s = name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 28) || 'Лист';
  let i = 2;
  while (used.has(s.toLowerCase())) s = `${name} (${i++})`;
  used.add(s.toLowerCase());
  return s;
}

/** Заполнить лист по образцу школьного отчёта. Возвращает задание на диаграмму. */
export function fillSheet(ws: ExcelJS.Worksheet, r: ClassReport, s: Settings): ChartJob {
  const font = { name: s.fontName || 'Aptos Narrow', size: 11 };
  const L = layoutFor(r);
  const sheetRef = `'${ws.name.replace(/'/g, "''")}'`;
  const A = colLetter;
  const Ly = r.layout;

  // ширины колонок
  ws.getColumn(1).width = 3.5;
  ws.getColumn(2).width = 27.4;
  if (L.reason) { ws.getColumn(L.reason).width = 14; ws.getColumn(L.date!).width = 11; }
  r.columns.forEach((_, ci) => { for (let j = 0; j < L.kOf[ci]; j++) ws.getColumn(L.phys[ci] + j).width = L.kOf[ci] > 1 ? 4.6 : 7.25; });
  if (L.helper) r.columns.forEach((_, ci) => { ws.getColumn(L.helper + ci).width = 6; ws.getColumn(L.helper + ci).hidden = true; });
  ws.getColumn(L.total).width = 7.25;
  ws.getColumn(L.percent).width = 7;
  ws.getColumn(L.grade).width = 10;

  // строки 1–3: шапка
  const titleEnd = Math.max(L.total - 1, 8);
  if (Ly.showTitle) {
    ws.mergeCells(1, 1, 1, titleEnd);
    const t = ws.getCell(1, 1);
    t.value = r.title;
    t.font = { ...font, size: 18, bold: true };
    t.alignment = center;
    let width = 0;
    for (let c = 1; c <= titleEnd; c++) width += ws.getColumn(c).width ?? 8;
    ws.getRow(1).height = titleHeight(r.title, width);
  } else {
    ws.getRow(1).height = 9;
  }

  const dateStart = 5 + (r.absentColumns ? 2 : 0);
  if (Ly.showInfo) {
    ws.getCell(2, 1).value = `Участвовали: ${r.participants}`;
    ws.getCell(2, 1).font = { ...font, bold: true };
    ws.mergeCells(2, dateStart, 2, L.total);
    ws.getCell(2, dateStart).value = `дата проведение ${r.kind}     ${r.date ? r.date + 'г' : ''}`;
    ws.getCell(2, dateStart).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
    ws.getRow(2).height = 39;
    ws.getCell(3, 1).value = `Отсутствовали: ${r.absent}`;
    ws.getCell(3, 1).font = { ...font, bold: true };
    ws.mergeCells(3, dateStart, 3, L.total);
    ws.getCell(3, dateStart).value = `Дата внесения в emaktab.uz:  ${r.dateEntered ? r.dateEntered + 'г' : ''}`;
    ws.getCell(3, dateStart).alignment = { horizontal: 'left', vertical: 'middle' };
    ws.getRow(3).height = 31.5;
  } else {
    ws.getRow(2).height = 9; ws.getRow(3).height = 9;
  }

  // строки 5–6: заголовки таблицы
  const grid = buildHeader(r.structure, r.columns);
  const H1 = 5, HB = H1 + grid.rows - 1; // HB — нижняя строка шапки
  const head = (c1: number, c2: number, text: string, r1 = H1, r2 = HB) => {
    if (r1 !== r2 || c1 !== c2) ws.mergeCells(r1, c1, r2, c2);
    const cell = ws.getCell(r1, c1);
    cell.value = text;
    cell.alignment = center;
  };
  head(1, 1, '№');
  head(2, 2, Ly.labels.name);
  if (L.reason) { head(L.reason, L.reason, 'Причина отсутствия'); head(L.date!, L.date!, `Дата сдачи ${r.kind}а`); }
  for (const cell of grid.cells) {
    const r1 = H1 + cell.row, r2 = r1 + cell.rowSpan - 1, c1 = L.scoreStart + cell.col, c2 = c1 + cell.colSpan - 1;
    if (r1 !== r2 || c1 !== c2) ws.mergeCells(r1, c1, r2, c2);
    const x = ws.getCell(r1, c1);
    x.value = cell.text;
    x.alignment = cell.vertical ? { ...center, textRotation: 90 } : center;
  }
  head(L.total, L.total, Ly.labels.total);
  head(L.percent, L.percent, Ly.labels.percent);
  head(L.grade, L.grade, Ly.labels.grade);
  const k = L.bands;
  const hasTitles = r.tasks.some((t) => t.title?.trim());
  const hasLabels = r.columns.some((c) => c.header.includes('\n'));
  for (let rr = H1; rr <= HB; rr++) {
    const isBand = k > 1 && rr === HB;
    ws.getRow(rr).height = isBand ? 64 : rr === H1 ? (hasTitles ? 60 : 43.5) : (hasLabels ? 45 : 28.5);
    for (let cc = 1; cc <= L.last; cc++) { const cell = ws.getCell(rr, cc); cell.border = thin; cell.font = font; }
  }

  // ученики
  const first = HB + 1;
  const scoreRange = (col: number, r1: number, r2: number) => `${A(col)}${r1}:${A(col)}${r2}`;
  r.rows.forEach((row, i) => {
    const rn = first + i;
    ws.getCell(rn, 1).value = row.n;
    ws.getCell(rn, 2).value = row.name;
    ws.getCell(rn, 2).alignment = { vertical: 'middle' };
    if (row.absent) {
      if (L.reason) {
        ws.getCell(rn, L.reason).value = row.reason || (r.group === 'девочки' ? 'отсутствовала' : 'отсутствовал');
        if (row.retake) ws.getCell(rn, L.date!).value = row.retake;
      } else {
        ws.mergeCells(rn, L.scoreStart, rn, L.grade);
        ws.getCell(rn, L.scoreStart).value = r.group === 'девочки' ? 'отсутствовала' : 'отсутствовал';
        ws.getCell(rn, L.scoreStart).alignment = center;
      }
    } else {
      if (L.reason) { ws.getCell(rn, L.reason).value = row.reason ?? ''; ws.getCell(rn, L.date!).value = row.retake ?? ''; }
      row.scores.forEach((v, ci) => { const kc = L.kOf[ci]; const pc0 = L.phys[ci] + (kc > 1 ? bandIndex(v, r.columns[ci].max, kc) : 0); ws.getCell(rn, pc0).value = v; });
      if (L.helper) r.columns.forEach((_, ci) => { ws.getCell(rn, L.helper + ci).value = { formula: `SUM(${A(L.phys[ci])}${rn}:${A(L.phys[ci] + L.kOf[ci] - 1)}${rn})`, result: row.scores[ci] }; });
      const tot = ws.getCell(rn, L.total);
      tot.value = { formula: `SUM(${A(L.scoreStart)}${rn}:${A(L.scoreEnd)}${rn})`, result: row.total };
      const pc = ws.getCell(rn, L.percent);
      pc.value = { formula: `${A(L.total)}${rn}/${r.max}`, result: row.percent };
      pc.numFmt = '0%';
      ws.getCell(rn, L.grade).value = { formula: gradeFormula(`${A(L.percent)}${rn}`, r.thresholds), result: row.grade };
    }
    for (let cc = 1; cc <= L.last; cc++) {
      const cell = ws.getCell(rn, cc);
      cell.border = thin; cell.font = font;
      if (cc !== 2) cell.alignment = center;
      if (row.reason && !row.absent) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
    }
  });
  const lastRow = first + r.rows.length - 1;
  const N = r.participants || 1;

  // итоги — только включённые в макете строки
  let next = lastRow + 1;
  const avgRow = Ly.showAvg ? next++ : 0, pctRow = Ly.showPct ? next++ : 0;
  const c5Row = Ly.showCounts ? next++ : 0, c4Row = Ly.showCounts ? next++ : 0, effRow = Ly.showEff ? next++ : 0;
  const gradeRange = scoreRange(L.grade, first, lastRow);
  const colOf = (cc: number) => { if (cc === L.total) return { ci: -1, max: r.max }; const ci = L.phys.findIndex((p, i) => cc >= p && cc < p + L.kOf[i]); return { ci, max: r.columns[ci]?.max ?? 1 }; };
  if (avgRow) {
    ws.getCell(avgRow, 2).value = 'Сред.балл:';
    for (let cc = L.scoreStart; cc <= L.total; cc++) {
      const { ci } = colOf(cc);
      const cell = ws.getCell(avgRow, cc);
      cell.value = { formula: `SUM(${scoreRange(cc, first, lastRow)})/${N}`, result: cc === L.total ? r.avgTotal : (k > 1 ? 0 : r.avg[ci]) };
      cell.numFmt = '0.00';
    }
    ws.getCell(avgRow, L.percent).value = { formula: `${A(L.total)}${avgRow}/${r.max}`, result: r.max ? r.avgTotal / r.max : 0 };
    ws.getCell(avgRow, L.percent).numFmt = '0%';
    ws.getCell(avgRow, L.grade).value = { formula: gradeFormula(`${A(L.percent)}${avgRow}`, r.thresholds), result: 0 };
  }
  if (pctRow) {
    ws.getCell(pctRow, 2).value = 'Процентный показатель';
    for (let cc = L.scoreStart; cc <= L.total; cc++) {
      const { ci, max } = colOf(cc);
      const cell = ws.getCell(pctRow, cc);
      cell.value = { formula: `SUM(${scoreRange(cc, first, lastRow)})/${N}/${max || 1}`, result: max ? (cc === L.total ? r.avgTotal : (k > 1 ? 0 : r.avg[ci])) / max : 0 };
      cell.numFmt = '0%';
    }
  }
  if (c5Row) {
    ws.getCell(c5Row, 2).value = 'Количество - “5”';
    ws.getCell(c5Row, L.scoreStart).value = { formula: `COUNTIF(${gradeRange},5)`, result: r.count5 };
    ws.getCell(c4Row, 2).value = 'Количество - “4”';
    ws.getCell(c4Row, L.scoreStart).value = { formula: `COUNTIF(${gradeRange},4)`, result: r.count4 };
  }
  if (effRow) {
    ws.getCell(effRow, 2).value = 'Эффективность знаний';
    ws.getCell(effRow, 2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } };
    const eff = ws.getCell(effRow, L.percent);
    eff.value = { formula: `(COUNTIF(${gradeRange},5)+COUNTIF(${gradeRange},4))/${N}`, result: r.efficiency };
    eff.numFmt = '0%';
    eff.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } };
  }
  for (let rr = lastRow + 1; rr < next; rr++) for (let cc = 1; cc <= L.last; cc++) {
    const cell = ws.getCell(rr, cc);
    cell.border = thin; cell.font = font;
    if (cc !== 2) cell.alignment = center;
  }

  // подпись
  const signRow = next + 1;
  if (Ly.showSignature) {
    ws.getCell(signRow, 1).value = `${Ly.labels.signature} ${r.teacherShort}__________________`;
    ws.getCell(signRow, 1).font = font;
    ws.getCell(signRow + 1, 4).value = 'Подпись ';
    ws.getCell(signRow + 1, 4).font = font;
  }

  ws.pageSetup = { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  ws.views = [{ showGridLines: true }];

  // фигуры: фиолетовая цифра варианта справа от заголовка и блок «Примечание» под подписью
  const shapes: DrawingShape[] = [];
  const variant = s.variantLabel.trim() || (r.absentColumns ? '1/2' : '1');
  if (Ly.showVariant && Ly.showTitle) shapes.push({ kind: 'variant', text: variant, anchor: { fromCol: titleEnd, fromRow: 0, toCol: L.last + 1, toRow: 1 } });
  const noteLines = Ly.showNote ? s.noteText.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : [];
  if (noteLines.length) {
    shapes.push({ kind: 'note', lines: noteLines, anchor: { fromCol: 0, fromRow: signRow + 1, toCol: L.last + 1, toRow: signRow + 7 } });
  }

  // диаграмма — ниже примечания (или подписи)
  const series: ChartSeries[] = r.columns.map((col, ci) => {
    const cc = L.helper ? L.helper + ci : L.phys[ci];
    const name = columnName(r.tasks, col);
    return { name, valRef: `${sheetRef}!$${A(cc)}$${first}:$${A(cc)}$${lastRow}`, values: r.rows.map((row) => (row.absent ? null : row.scores[ci])) };
  });
  const totalSeries: ChartSeries | undefined = s.chartIncludeTotal
    ? { name: 'Общий балл', nameRef: `${sheetRef}!$${A(L.total)}$${H1}`, valRef: `${sheetRef}!$${A(L.total)}$${first}:$${A(L.total)}$${lastRow}`, values: r.rows.map((row) => (row.absent ? null : row.total)) }
    : undefined;
  const chartTop = noteLines.length ? signRow + 9 : signRow + 3;
  const chartRight = Math.max(L.last, 10) + (r.rows.length > 25 ? 2 : 0);
  return {
    sheetId: ws.id,
    spec: {
      title: r.chartTitle,
      catLabels: r.rows.map((row) => shortName(row.name)),
      series,
      totalSeries,
      max: r.max,
    },
    anchor: { fromCol: 0, fromRow: chartTop - 1, toCol: chartRight, toRow: chartTop - 1 + 26 },
    shapes,
    noChart: !Ly.showChart,
  };
}

/** «Ахмедова Малика Рустамовна» → «Ахмедова М.» (фамилия + инициал имени). */
export function shortName(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? '';
  return `${parts[0]} ${parts[1][0]}.`;
}

/** Собрать книгу: лист на класс + диаграммы. */
export async function exportWorkbook(reports: ClassReport[], s: Settings): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.calcProperties.fullCalcOnLoad = true; // формулы (в т.ч. в скрытых колонках уровней) пересчитать при открытии
  wb.creator = s.teacherShort || 'sor-reports';
  wb.created = new Date();
  const used = new Set<string>();
  const jobs: ChartJob[] = [];
  for (const r of reports) {
    const ws = wb.addWorksheet(uniqueSheetName(r.sheetName, used));
    jobs.push(fillSheet(ws, r, s));
  }
  const buf = await wb.xlsx.writeBuffer();
  return injectCharts(buf as ArrayBuffer, jobs);
}

export function fileNameFor(reports: ClassReport[], s: Settings): string {
  const subj = reports[0]?.subject ?? 'предмет';
  const who = s.teacherShort ? ` ${s.teacherShort.replace(/\s+/g, '_')}` : '';
  return `${s.kind}-${s.number} ${subj}${who}.xlsx`.replace(/[\\/:*?"<>|]/g, '_');
}
