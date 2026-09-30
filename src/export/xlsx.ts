import ExcelJS from 'exceljs';
import type { ClassReport, Settings } from '../core/types.ts';
import { taskHeader, columnName } from '../core/structure.ts';
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

/** Раскладка колонок листа (1-based). */
export interface Layout {
  reason?: number; date?: number;
  scoreStart: number; scoreEnd: number;
  total: number; percent: number; grade: number;
  last: number;
}
export function layoutFor(r: ClassReport): Layout {
  let c = 3;
  const l: Partial<Layout> = {};
  if (r.absentColumns) { l.reason = c++; l.date = c++; }
  l.scoreStart = c; c += r.columns.length; l.scoreEnd = c - 1;
  l.total = c++; l.percent = c++; l.grade = c++;
  l.last = l.grade;
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

  // ширины колонок
  ws.getColumn(1).width = 3.5;
  ws.getColumn(2).width = 27.4;
  if (L.reason) { ws.getColumn(L.reason).width = 14; ws.getColumn(L.date!).width = 11; }
  for (let c = L.scoreStart; c <= L.scoreEnd; c++) ws.getColumn(c).width = 7.25;
  ws.getColumn(L.total).width = 7.25;
  ws.getColumn(L.percent).width = 7;
  ws.getColumn(L.grade).width = 10;

  // строки 1–3: шапка
  const titleEnd = Math.max(L.total - 1, 8);
  ws.mergeCells(1, 1, 1, titleEnd);
  const t = ws.getCell(1, 1);
  t.value = r.title;
  t.font = { ...font, size: 18, bold: true };
  t.alignment = center;
  let width = 0;
  for (let c = 1; c <= titleEnd; c++) width += ws.getColumn(c).width ?? 8;
  ws.getRow(1).height = titleHeight(r.title, width);

  const dateStart = 5 + (r.absentColumns ? 2 : 0);
  ws.getCell(2, 1).value = `Участвовали: ${r.participants}`;
  ws.getCell(2, 1).font = { ...font, bold: true };
  ws.mergeCells(2, dateStart, 2, L.total);
  ws.getCell(2, dateStart).value = `дата проведение ${r.kind}     ${r.date ? r.date + 'г' : ''}`;
  ws.getCell(2, dateStart).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
  ws.getRow(2).height = 39;
  ws.getCell(3, 1).value = `Отсутствовали: ${r.absent}`;
  ws.getCell(3, 1).font = { ...font, bold: true };
  ws.mergeCells(3, dateStart, 3, L.total);
  ws.getCell(3, dateStart).value = 'Дата внесения в emaktab.uz:  ';
  ws.getCell(3, dateStart).alignment = { horizontal: 'left', vertical: 'middle' };
  ws.getRow(3).height = 31.5;

  // строки 5–6: заголовки таблицы
  const H1 = 5, H2 = 6;
  const head = (c1: number, c2: number, text: string, r1 = H1, r2 = H2) => {
    if (r1 !== r2 || c1 !== c2) ws.mergeCells(r1, c1, r2, c2);
    const cell = ws.getCell(r1, c1);
    cell.value = text;
    cell.alignment = center;
  };
  head(1, 1, '№');
  head(2, 2, 'Фамилия имя ученика');
  if (L.reason) { head(L.reason, L.reason, 'Причина отсутствия'); head(L.date!, L.date!, `Дата сдачи ${r.kind}а`); }
  let c = L.scoreStart;
  r.tasks.forEach((task, ti) => {
    const cols = r.columns.filter((x) => x.taskIndex === ti);
    if (!task.parts.length) { head(c, c, taskHeader(task, ti)); c++; return; }
    head(c, c + cols.length - 1, taskHeader(task, ti), H1, H1);
    cols.forEach((col, i) => { const cell = ws.getCell(H2, c + i); cell.value = col.header; cell.alignment = center; });
    c += cols.length;
  });
  head(L.total, L.total, 'Общий балл');
  head(L.percent, L.percent, 'В%');
  head(L.grade, L.grade, 'Оценивание');
  // с названиями заданий/критериев шапке нужно больше места
  const hasTitles = r.tasks.some((t) => t.title?.trim());
  const hasLabels = r.tasks.some((t) => t.parts.some((p) => p.label?.trim()));
  ws.getRow(H1).height = hasTitles ? 60 : 43.5;
  ws.getRow(H2).height = hasLabels ? 45 : 28.5;
  for (const rr of [H1, H2]) for (let cc = 1; cc <= L.last; cc++) { const cell = ws.getCell(rr, cc); cell.border = thin; cell.font = font; }

  // ученики
  const first = 7;
  const scoreRange = (col: number, r1: number, r2: number) => `${A(col)}${r1}:${A(col)}${r2}`;
  r.rows.forEach((row, i) => {
    const rn = first + i;
    ws.getCell(rn, 1).value = row.n;
    ws.getCell(rn, 2).value = row.name;
    ws.getCell(rn, 2).alignment = { vertical: 'middle' };
    if (row.absent) {
      if (L.reason) {
        ws.getCell(rn, L.reason).value = r.group === 'девочки' ? 'отсутствовала' : 'отсутствовал';
      } else {
        ws.mergeCells(rn, L.scoreStart, rn, L.grade);
        ws.getCell(rn, L.scoreStart).value = r.group === 'девочки' ? 'отсутствовала' : 'отсутствовал';
        ws.getCell(rn, L.scoreStart).alignment = center;
      }
    } else {
      row.scores.forEach((v, ci) => { ws.getCell(rn, L.scoreStart + ci).value = v; });
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
    }
  });
  const lastRow = first + r.rows.length - 1;
  const N = r.participants || 1;

  // итоги
  const avgRow = lastRow + 1, pctRow = avgRow + 1, c5Row = pctRow + 1, c4Row = c5Row + 1, effRow = c4Row + 1;
  ws.getCell(avgRow, 2).value = 'Сред.балл:';
  for (let cc = L.scoreStart; cc <= L.total; cc++) {
    const ci = cc - L.scoreStart;
    const cell = ws.getCell(avgRow, cc);
    cell.value = { formula: `SUM(${scoreRange(cc, first, lastRow)})/${N}`, result: cc === L.total ? r.avgTotal : r.avg[ci] };
    cell.numFmt = '0.00';
  }
  ws.getCell(avgRow, L.percent).value = { formula: `${A(L.total)}${avgRow}/${r.max}`, result: r.max ? r.avgTotal / r.max : 0 };
  ws.getCell(avgRow, L.percent).numFmt = '0%';
  ws.getCell(avgRow, L.grade).value = { formula: gradeFormula(`${A(L.percent)}${avgRow}`, r.thresholds), result: 0 };

  ws.getCell(pctRow, 2).value = 'Процентный показатель';
  for (let cc = L.scoreStart; cc <= L.total; cc++) {
    const ci = cc - L.scoreStart;
    const max = cc === L.total ? r.max : r.columns[ci].max;
    const cell = ws.getCell(pctRow, cc);
    cell.value = { formula: `${A(cc)}${avgRow}/${max || 1}`, result: max ? (cc === L.total ? r.avgTotal : r.avg[ci]) / max : 0 };
    cell.numFmt = '0%';
  }
  ws.getCell(c5Row, 2).value = 'Количество - “5”';
  ws.getCell(c5Row, L.scoreStart).value = { formula: `COUNTIF(${scoreRange(L.grade, first, lastRow)},5)`, result: r.count5 };
  ws.getCell(c4Row, 2).value = 'Количество - “4”';
  ws.getCell(c4Row, L.scoreStart).value = { formula: `COUNTIF(${scoreRange(L.grade, first, lastRow)},4)`, result: r.count4 };
  ws.getCell(effRow, 2).value = 'Эффективность знаний';
  ws.getCell(effRow, 2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } };
  const eff = ws.getCell(effRow, L.percent);
  eff.value = { formula: `(${A(L.scoreStart)}${c5Row}+${A(L.scoreStart)}${c4Row})/${N}`, result: r.efficiency };
  eff.numFmt = '0%';
  eff.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } };
  for (let rr = avgRow; rr <= effRow; rr++) for (let cc = 1; cc <= L.last; cc++) {
    const cell = ws.getCell(rr, cc);
    cell.border = thin; cell.font = font;
    if (cc !== 2) cell.alignment = center;
  }

  // подпись
  const signRow = effRow + 2;
  ws.getCell(signRow, 1).value = `Фамилия учителя-предметника: ${r.teacherShort}__________________`;
  ws.getCell(signRow, 1).font = font;
  ws.getCell(signRow + 1, 4).value = 'Подпись ';
  ws.getCell(signRow + 1, 4).font = font;

  ws.pageSetup = { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  ws.views = [{ showGridLines: true }];

  // фигуры: фиолетовая цифра варианта справа от заголовка и блок «Примечание» под подписью
  const shapes: DrawingShape[] = [];
  const variant = s.variantLabel.trim() || (r.absentColumns ? '2' : '1');
  shapes.push({ kind: 'variant', text: variant, anchor: { fromCol: titleEnd, fromRow: 0, toCol: L.last + 1, toRow: 1 } });
  const noteLines = s.noteText.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (noteLines.length) {
    shapes.push({ kind: 'note', lines: noteLines, anchor: { fromCol: 0, fromRow: signRow + 1, toCol: L.last + 1, toRow: signRow + 7 } });
  }

  // диаграмма — ниже примечания (или подписи)
  const series: ChartSeries[] = r.columns.map((col, ci) => {
    const cc = L.scoreStart + ci;
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
