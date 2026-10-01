import type { ClassReport, JournalClass, ReportRow, Settings } from './types.ts';
import { flattenColumns } from './structure.ts';
import { distribute, distributeTargets, gradeFor, makeRng } from './distribute.ts';
import { generateLadder, ladderFits, type Ladder } from './ladder.ts';
import { fillTemplate } from './layout.ts';

/** Хеш строки → 32-битное число (для стабильного сида на ученика). */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** «5-С» → «5с», девочки → «5с Д». */
export function sheetNameFor(cls: JournalClass): string {
  const base = cls.className.replace(/[-–\s]/g, '').toLowerCase();
  return cls.group === 'девочки' ? `${base} Д` : base;
}

/** Переменные для шаблонов заголовка. */
export function titleVars(cls: JournalClass, s: Settings): Record<string, string> {
  return {
    'школа': s.school, 'вид': s.kind, 'номер': String(s.number), 'предмет': cls.subject || 'Предмет',
    'группа': cls.group ?? '', 'класс': cls.className, 'год': cls.year || s.year, 'учитель': s.teacherShort,
  };
}
export function buildTitle(cls: JournalClass, s: Settings): string {
  return fillTemplate(s.layout.titleTemplate, titleVars(cls, s));
}

/** «13.02» + учебный год «2025–2026» → «13.02.2026» (сентябрь–декабрь — первый год). */
export function fullDate(d: string | undefined, year: string | undefined): string | undefined {
  if (!d) return undefined;
  const m = d.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?/);
  if (!m) return d;
  if (m[3]) return `${m[1].padStart(2, '0')}.${m[2].padStart(2, '0')}.${m[3].length === 2 ? '20' + m[3] : m[3]}`;
  const ys = (year ?? '').match(/(\d{4})\D+(\d{4})/);
  if (!ys) return `${m[1].padStart(2, '0')}.${m[2].padStart(2, '0')}`;
  const y = Number(m[2]) >= 9 ? ys[1] : ys[2];
  return `${m[1].padStart(2, '0')}.${m[2].padStart(2, '0')}.${y}`;
}

/** Собрать отчёт по классу: раскидать баллы, посчитать итоги. */
export function buildReport(cls: JournalClass, s: Settings, structure = s.structure, ladder?: Ladder): ClassReport {
  const a = cls.assessments.find((x) => x.id === cls.selectedAssessment) ?? cls.assessments[0];
  const columns = flattenColumns(structure);
  const maxes = columns.map((c) => c.max);
  const max = maxes.reduce((x, y) => x + y, 0);
  const rowsOf = s.strategy === 'ladder'
    ? (ladderFits(ladder, maxes) ? ladder : generateLadder(maxes))
    : undefined;
  const rows: ReportRow[] = [];
  const absentNames: string[] = [];
  let n = 0;
  cls.students.forEach((st, i) => {
    const score = a?.scores[i] ?? null;
    if (score == null) {
      absentNames.push(st.name);
      if (!s.includeAbsent) return;
      rows.push({ n: ++n, name: st.name, absent: true, scores: columns.map(() => 0), total: 0, percent: 0, grade: 0 });
      return;
    }
    const rng = makeRng((s.seed ^ hash(st.name)) >>> 0);
    const t = Math.max(0, Math.min(max, Math.round(score)));
    const scores = rowsOf?.[t] ? rowsOf[t].slice()
      : s.strategy === 'targets' ? distributeTargets(score, maxes, columns.map((c) => c.target), rng)
      : distribute(score, maxes, s.strategy === 'ladder' ? 'largest' : s.strategy, rng);
    const row: ReportRow = { n: ++n, name: st.name, absent: false, scores, total: 0, percent: 0, grade: 0 };
    recalcRow(row, max, s.thresholds);
    rows.push(row);
  });

  const subject = cls.subject || 'Предмет';
  const report: ClassReport = {
    classId: cls.id,
    sheetName: sheetNameFor(cls),
    title: buildTitle(cls, s),
    chartTitle: fillTemplate(s.layout.chartTitleTemplate, titleVars(cls, s)),
    layout: s.layout,
    className: cls.className, group: cls.group, subject,
    kind: s.kind, number: s.number,
    date: cls.dateHeld || (s.showDates ? fullDate(a?.date, cls.year || s.year) : undefined),
    dateEntered: cls.dateEntered,
    max, columns, tasks: structure.tasks, rows,
    participants: 0, absent: absentNames.length, absentNames,
    avg: [], avgTotal: 0, count5: 0, count4: 0, efficiency: 0,
    teacherShort: s.teacherShort, thresholds: s.thresholds,
    absentColumns: s.absentColumns, showDates: s.showDates,
  };
  recalcSummary(report);
  return report;
}

export function recalcRow(row: ReportRow, max: number, th: Settings['thresholds']): void {
  row.total = row.scores.reduce((x, y) => x + y, 0);
  row.percent = max ? row.total / max : 0;
  row.grade = gradeFor(row.percent, th);
}

export function recalcSummary(r: ClassReport): void {
  const part = r.rows.filter((x) => !x.absent);
  r.participants = part.length;
  const n = part.length || 1;
  r.avg = r.columns.map((_, ci) => part.reduce((s, row) => s + row.scores[ci], 0) / n);
  r.avgTotal = part.reduce((s, row) => s + row.total, 0) / n;
  r.count5 = part.filter((x) => x.grade === 5).length;
  r.count4 = part.filter((x) => x.grade === 4).length;
  r.efficiency = part.length ? (r.count5 + r.count4) / part.length : 0;
}
