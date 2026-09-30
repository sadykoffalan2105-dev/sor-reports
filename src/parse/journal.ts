import * as XLSX from 'xlsx';
import type { AssessmentColumn, JournalClass, Kind, Student } from '../core/types.ts';

type Cell = string | number | null;

let seq = 0;
const uid = (p: string) => `${p}${++seq}-${Date.now().toString(36)}`;

const str = (v: Cell): string => (v == null ? '' : String(v).trim());
const num = (v: Cell): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = str(v).replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
};

/** Прочитать файл журнала (.xls/.xlsx/.csv) — по одному классу на лист. */
export function parseWorkbook(data: ArrayBuffer, fileName: string): JournalClass[] {
  const wb = XLSX.read(data, { type: 'array', cellDates: false, raw: true });
  const out: JournalClass[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json<Cell[]>(ws, { header: 1, raw: true, defval: null, blankrows: false });
    const cls = parseJournalRows(rows, fileName, name) ?? parseSimpleRows(rows, fileName, name);
    if (cls && cls.students.length) out.push(cls);
  }
  return out;
}

/** Выгрузка журнала emaktab: шапка «Класс: … / Предмет: … / ФИО учителя: …», строки «Месяц / Число / Фамилия и имя ученика». */
export function parseJournalRows(rows: Cell[][], source: string, sheetName: string): JournalClass | null {
  const dayRow = rows.findIndex((r) => r.some((c) => /^число$/i.test(str(c))));
  if (dayRow < 1) return null;
  const monthRow = rows[dayRow - 1] ?? [];
  const nameRow = rows[dayRow + 1] ?? [];
  const day = rows[dayRow];

  const cls: JournalClass = {
    id: uid('c'), source, className: sheetName, students: [], assessments: [],
  };

  // метаданные из первых строк
  for (const r of rows.slice(0, dayRow)) {
    for (const c of r) {
      const s = str(c);
      let m: RegExpMatchArray | null;
      if ((m = s.match(/класс\s*:?\s*(\d{1,2})\s*[-–]?\s*([А-ЯЁA-Z])(?![А-Яа-яЁёA-Za-z])(?:\s*\(([^)]*)\))?(?:.*?(\d{4})\s*[/–-]\s*(\d{4}))?/i))) {
        cls.className = `${m[1]}-${m[2].toUpperCase()}`;
        const g = (m[3] ?? '').toLowerCase();
        if (/мальч|o[‘'’]g[‘'’]il|boys/.test(g)) cls.group = 'мальчики';
        else if (/дев|qiz|girls/.test(g)) cls.group = 'девочки';
        if (m[4] && m[5]) cls.year = `${m[4]}–${m[5]}`;
      } else if ((m = s.match(/предмет\s*:?\s*(.+)/i))) {
        cls.subject = m[1].trim();
      } else if ((m = s.match(/(?:ФИО\s+)?учител[ья]\s*:?\s*(.+)/i))) {
        cls.teacher = m[1].trim();
      }
    }
  }
  for (const c of [...monthRow, ...day]) {
    const m = str(c).match(/(\d)\s*(?:чтв|четв|chorak)/i);
    if (m) cls.quarter = Number(m[1]);
  }

  // ученики
  const firstData = dayRow + 2;
  for (let r = firstData; r < rows.length; r++) {
    const row = rows[r];
    const n = num(row[0]);
    const name = str(row[1]);
    if (n == null || !name || !/[A-Za-zА-Яа-яЁёʻ’']/.test(name)) continue;
    cls.students.push({ n, name, id: str(row[2]) || undefined });
  }
  const studentRows = rows.slice(firstData).filter((row) => num(row[0]) != null && /[A-Za-zА-Яа-яЁё]/.test(str(row[1])));

  // колонки СОР / СОЧ
  const counters: Record<Kind, number> = { 'СОР': 0, 'СОЧ': 0 };
  for (let c = 0; c < day.length; c++) {
    const s = str(day[c]);
    if (!/^(СОР|СОЧ|BJB|ChSB|ЧСБ|БЖБ)/i.test(s)) continue;
    const kind: Kind = /СОР|BJB|БЖБ/i.test(s) ? 'СОР' : 'СОЧ';
    const dateS = str(monthRow[c]);
    const max = num(nameRow[c]) ?? (kind === 'СОР' ? 50 : 40);
    counters[kind]++;
    cls.assessments.push({
      id: uid('a'), kind, ordinal: counters[kind],
      date: /^\d{1,2}\.\d{1,2}/.test(dateS) ? dateS : undefined,
      max, col: c,
      scores: studentRows.map((row) => num(row[c])),
    });
  }
  const last = cls.assessments.filter((a) => a.kind === 'СОР').at(-1) ?? cls.assessments.at(-1);
  cls.selectedAssessment = last?.id;
  return cls;
}

/** Простой список: в строке есть «Фамилия Имя» и число — балл. Используется для произвольных таблиц. */
export function parseSimpleRows(rows: Cell[][], source: string, sheetName: string): JournalClass | null {
  const students: Student[] = [];
  const scores: (number | null)[] = [];
  for (const row of rows) {
    const nameIdx = row.findIndex((c) => typeof c === 'string' && /^[A-Za-zА-Яа-яЁёʻ’'\-\s.]{3,}$/.test(c.trim()) && c.trim().includes(' '));
    if (nameIdx < 0) continue;
    // числа слева от имени — номер по порядку; балл — последнее число справа от имени
    const right = row.slice(nameIdx + 1).map(num).filter((v): v is number => v != null);
    students.push({ n: students.length + 1, name: str(row[nameIdx]) });
    scores.push(right.length ? right[right.length - 1] : null);
  }
  if (students.length < 2) return null;
  const maxScore = Math.max(0, ...scores.filter((s): s is number => s != null));
  const max = maxScore > 40 ? 50 : maxScore > 0 ? 40 : 50;
  const className = /^\d{1,2}\s*[-–]?\s*[А-ЯЁA-Zа-яё]$/i.test(sheetName.trim()) ? sheetName.trim().replace(/\s*[-–]?\s*/, '-').toUpperCase() : source.replace(/\.[^.]+$/, '');
  const a: AssessmentColumn = { id: uid('a'), kind: 'СОР', ordinal: 1, max, col: -1, scores };
  return { id: uid('c'), source, className, students, assessments: [a], selectedAssessment: a.id };
}

/**
 * Ручной ввод: строки вида «Фамилия Имя 46», «1. Фамилия Имя — 46», «Фамилия Имя<TAB>46».
 * Ученик без числа считается отсутствующим.
 */
export function parseManualList(text: string, className: string, max: number): JournalClass | null {
  const students: Student[] = [];
  const scores: (number | null)[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    line = line.replace(/^\d+\s*[.)]?\s*/, '');
    const m = line.match(/^(.*?)[\s\t—–:-]*(\d+(?:[.,]\d+)?)\s*$/);
    const name = (m ? m[1] : line).replace(/[\t—–:-]+$/, '').trim();
    if (!name) continue;
    students.push({ n: students.length + 1, name });
    scores.push(m ? Number(m[2].replace(',', '.')) : null);
  }
  if (!students.length) return null;
  const a: AssessmentColumn = { id: uid('a'), kind: 'СОР', ordinal: 1, max, col: -1, scores };
  return { id: uid('c'), source: 'ручной ввод', className: className.trim() || 'Класс', students, assessments: [a], selectedAssessment: a.id };
}

/** «Мутабар Мухаммаджоновна Ахмедова» → «Ахмедова М.М.» (в журнале фамилия стоит последней). */
export function shortTeacherName(full: string | undefined): string {
  if (!full) return '';
  const parts = full.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (parts.length < 2) return full;
  const surname = parts[parts.length - 1];
  const initials = parts.slice(0, -1).map((p) => p[0].toUpperCase() + '.').join('');
  return `${surname} ${initials}`;
}
