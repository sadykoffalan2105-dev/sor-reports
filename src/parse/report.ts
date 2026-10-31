/**
 * Чтение готового отчёта (книги, сделанной этим сайтом, или школьной формы с той же шапкой):
 * лист = класс; шапка «№ | Фамилия имя | задания/критерии… | Общий балл» превращается в разбаловку,
 * баллы по критериям — в баллы учеников. После загрузки можно добавлять другие классы и скачать общую книгу.
 */
import * as XLSX from 'xlsx';
import type { JournalClass, Part, Structure, Student, Task, HeaderStyle } from '../core/types.ts';
import { partMax } from '../core/structure.ts';

type WS = XLSX.WorkSheet;
let seq = 0;
const uid = (p: string) => `${p}r${++seq}-${Date.now().toString(36)}`;

const cellText = (ws: WS, r: number, c: number): string => {
  const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
  return cell?.v == null ? '' : String(cell.w ?? cell.v).trim();
};
const cellNum = (ws: WS, r: number, c: number): number | null => {
  const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
  if (!cell || cell.v == null || cell.v === '') return null;
  const n = typeof cell.v === 'number' ? cell.v : Number(String(cell.v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/** Объединённая ячейка, в которую входит (r, c), — или одиночная. */
function mergeAt(ws: WS, r: number, c: number): XLSX.Range {
  for (const m of ws['!merges'] ?? []) if (r >= m.s.r && r <= m.e.r && c >= m.s.c && c <= m.e.c) return m;
  return { s: { r, c }, e: { r, c } };
}

const pointsOf = (t: string): number | null => { const m = t.match(/(\d+)\s*балл/i); return m ? Number(m[1]) : null; };
/** «2 задание 40 баллов» → «»; «Знание (5 баллов)» → «Знание»; «2.1\nЧертёж\n5 баллов» → «Чертёж». */
const cleanTitle = (t: string): string => t
  .replace(/\(\s*\d+\s*балл[а-яё]*\s*\)/gi, '').replace(/\d+\s*балл[а-яё]*/gi, '')
  .replace(/^\s*\d+\s*(задание|зад)\.?/i, '').replace(/^\s*\d+(\.\d+)+/, '')
  .replace(/\s+/g, ' ').trim();

interface HNode { text: string; c1: number; c2: number; children: HNode[] }

/** Найти лист-отчёт и разобрать его. null — это не отчёт. */
export function parseReportSheet(ws: WS, sheetName: string, source: string): JournalClass | null {
  const ref = ws['!ref']; if (!ref) return null;
  const range = XLSX.utils.decode_range(ref);
  // строка шапки: «Фамилия …» и «Общий балл» в одной строке
  let H1 = -1, nameCol = -1, totalCol = -1;
  for (let r = range.s.r; r <= Math.min(range.e.r, 30) && H1 < 0; r++) {
    let nc = -1, tc = -1;
    for (let c = range.s.c; c <= range.e.c; c++) {
      const t = cellText(ws, r, c).toLowerCase();
      if (nc < 0 && /фамили/.test(t)) nc = c;
      if (tc < 0 && /общ[а-яё]*\s*балл/.test(t)) tc = c;
    }
    if (nc >= 0 && tc > nc) { H1 = r; nameCol = nc; totalCol = tc; }
  }
  if (H1 < 0) return null;
  // первая строка учеников — номер в первой колонке и имя
  let first = -1;
  for (let r = H1 + 1; r <= Math.min(range.e.r, H1 + 6); r++) {
    if (cellNum(ws, r, nameCol - 1) != null && /\p{L}/u.test(cellText(ws, r, nameCol))) { first = r; break; }
  }
  if (first < 0) return null;
  const HB = first - 1;
  // колонки «Причина отсутствия», «Дата сдачи»
  let reasonCol = -1, dateCol = -1, scoreStart = nameCol + 1;
  for (let c = nameCol + 1; c < totalCol; c++) {
    const t = cellText(ws, H1, c).toLowerCase();
    if (/причин/.test(t)) { reasonCol = c; scoreStart = c + 1; } else if (/дата\s*сдач/.test(t)) { dateCol = c; scoreStart = c + 1; }
  }
  const scoreEnd = totalCol - 1;
  if (scoreEnd < scoreStart) return null;
  // строка уровней («0-1 балл») — последняя строка шапки
  const bandRow = HB > H1 && Array.from({ length: scoreEnd - scoreStart + 1 }, (_, i) => cellText(ws, HB, scoreStart + i)).some((t) => /^\d+\s*-\s*\d+\s*балл/i.test(t)) ? HB : -1;
  const lastRow = bandRow >= 0 ? HB - 1 : HB;

  const build = (r: number, c1: number, c2: number): HNode[] => {
    const out: HNode[] = [];
    for (let c = c1; c <= c2;) {
      const m = mergeAt(ws, r, c);
      const end = Math.min(m.e.c, c2);
      const text = cellText(ws, m.s.r, m.s.c);
      const leaf = m.e.r >= lastRow || r >= lastRow;
      out.push({ text, c1: c, c2: end, children: leaf ? [] : build(m.e.r + 1, c, end) });
      c = end + 1;
    }
    return out;
  };
  const top = build(H1, scoreStart, scoreEnd);
  const leaves: { c1: number; c2: number }[] = [];
  const colMax = (c1: number, c2: number, first: number, last: number): number => {
    let m = 0;
    for (let r = first; r <= last; r++) { let sum = 0; for (let c = c1; c <= c2; c++) sum += cellNum(ws, r, c) ?? 0; m = Math.max(m, sum); }
    return m;
  };
  // строки учеников
  let last = first;
  for (let r = first; r <= range.e.r; r++) {
    const nm = cellText(ws, r, nameCol);
    if (!nm || /сред|процент|количеств|эффектив|фамилия учител/i.test(nm)) break;
    last = r;
  }
  const toPart = (n: HNode): Part => {
    if (n.children.length) return { label: cleanTitle(n.text), max: 0, parts: n.children.map(toPart) };
    leaves.push({ c1: n.c1, c2: n.c2 });
    const max = pointsOf(n.text) ?? colMax(n.c1, n.c2, first, last);
    return { label: cleanTitle(n.text), max, ...(n.c2 > n.c1 ? { bands: n.c2 - n.c1 + 1 } : {}) };
  };
  const tasks: Task[] = top.map((n) => {
    if (!n.children.length) {
      leaves.push({ c1: n.c1, c2: n.c2 });
      const max = pointsOf(n.text) ?? colMax(n.c1, n.c2, first, last);
      return { title: cleanTitle(n.text), parts: [], max, ...(n.c2 > n.c1 ? { bands: n.c2 - n.c1 + 1 } : {}) };
    }
    const parts = n.children.map(toPart);
    return { title: cleanTitle(n.text), parts, max: parts.reduce((a, p) => a + partMax(p), 0) };
  });
  const fix = (p: Part): void => { if (p.parts?.length) { p.parts.forEach(fix); p.max = partMax(p); } };
  tasks.forEach((t) => t.parts.forEach(fix));
  const h0 = cellText(ws, H1, top[0].c1);
  const headerStyle: HeaderStyle = /\(\s*\d+\s*балл/i.test(h0) ? 'paren' : /\bзад\b/i.test(h0) ? 'short' : 'full';
  const partNumbering = top.some((n) => n.children.some((ch) => /^\s*\d+\.\d+/.test(cellText(ws, H1 + 1, ch.c1))));
  const structure: Structure = { tasks, headerStyle, ...(partNumbering ? { partNumbering } : {}) };

  // ученики и баллы
  const students: Student[] = [];
  const totals: (number | null)[] = [];
  for (let r = first; r <= last; r++) {
    const name = cellText(ws, r, nameCol);
    const rowText = Array.from({ length: totalCol - scoreStart + 1 }, (_, i) => cellText(ws, r, scoreStart + i)).join(' ').toLowerCase();
    const st: Student = { n: students.length + 1, name };
    if (reasonCol >= 0) { const v = cellText(ws, r, reasonCol); if (v && !/отсутств/i.test(v)) st.reason = v; }
    if (dateCol >= 0) { const v = cellText(ws, r, dateCol); if (v) st.retake = v; }
    const vals = leaves.map((lf) => {
      let any = false, sum = 0;
      for (let c = lf.c1; c <= lf.c2; c++) { const v = cellNum(ws, r, c); if (v != null) { any = true; sum += v; } }
      return any ? sum : null;
    });
    if (/отсутств/.test(rowText) || (reasonCol >= 0 && /отсутств/i.test(cellText(ws, r, reasonCol)) && vals.every((v) => v == null))) st.forceAbsent = true;
    else if (vals.some((v) => v != null)) st.manualScores = vals;
    students.push(st);
    totals.push(st.manualScores ? vals.reduce<number>((a, b) => a + (b ?? 0), 0) : null);
  }
  if (!students.length) return null;

  // класс, предмет, группа, вид работы — из заголовка
  const title = Array.from({ length: Math.max(1, H1) }, (_, r) => Array.from({ length: range.e.c + 1 }, (_, c) => cellText(ws, r, c)).join(' ')).join(' ');
  const cm = title.match(/(\d{1,2})\s*-?\s*([А-ЯЁA-Z])\s*класс/i) ?? sheetName.match(/^(\d{1,2})\s*-?\s*([А-ЯЁа-яёA-Za-z])/);
  const className = cm ? `${cm[1]}-${cm[2].toUpperCase()}` : sheetName;
  const subject = title.match(/«([^»]+)»/)?.[1] ?? title.match(/по предмету\s+([А-ЯЁа-яё ]+?)\s+(?:“|"|мальч|девоч|\d)/i)?.[1]?.trim();
  const group = /девочк/i.test(title + sheetName) || /\sД$/.test(sheetName) ? 'девочки' as const : /мальчик/i.test(title) ? 'мальчики' as const : undefined;
  const years = title.match(/(\d{4})\s*[–-]\s*(\d{4})/);
  let teacher: string | undefined;
  for (let r = last + 1; r <= Math.min(range.e.r, last + 12) && !teacher; r++) {
    const t = Array.from({ length: range.e.c + 1 }, (_, c) => cellText(ws, r, c)).join(' ');
    const m = t.match(/учител[а-яё]*[^:]*:\s*([А-ЯЁA-Z][^_\n]{2,40})/i);
    if (m) teacher = m[1].replace(/_+/g, '').trim();
  }
  const max = tasks.reduce((a, t) => a + (t.parts.length ? t.parts.reduce((x, p) => x + partMax(p), 0) : t.max), 0);
  const aid = uid('a');
  return {
    id: uid('c'), source, className, group, subject, year: years ? `${years[1]}–${years[2]}` : undefined,
    teacher, students,
    assessments: [{ id: aid, kind: /СОЧ/i.test(title) ? 'СОЧ' : 'СОР', ordinal: Number(title.match(/(?:СОР|СОЧ)\s*-?\s*(\d+)/i)?.[1] ?? 1), max, col: -1, scores: totals }],
    selectedAssessment: aid,
    structure, imported: true, teacherShort: teacher,
  };
}
