import type { ClassReport, JournalClass, ReportRow, Settings } from './types.ts';
import { flattenColumns, structureMax, cloneStructure } from './structure.ts';
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
export function titleVars(cls: JournalClass, s: Settings, max?: number): Record<string, string> {
  return {
    'макс': String(max ?? structureMax(s.structure)), 'школа': s.school, 'вид': s.kind, 'номер': String(s.number), 'предмет': cls.subject || 'Предмет',
    'группа': cls.group ?? '', 'класс': cls.className, 'год': cls.year || s.year, 'учитель': s.teacherShort,
  };
}
export function buildTitle(cls: JournalClass, s: Settings, max?: number): string {
  return fillTemplate(s.layout.titleTemplate, titleVars(cls, s, max));
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
  const max = r2(maxes.reduce((x, y) => x + y, 0));
  // дробные баллы (2,5; 7,5): раскидка считается в долях балла (½, ¼ …) и делится обратно
  const k = unitOf([...maxes, ...columns.map((c) => c.fixed ?? 0), ...columns.map((c) => c.step ?? 0), ...(a?.scores ?? []).map((v) => v ?? 0), ...cls.students.map((st) => st.manualScore ?? 0)]);
  const mI = maxes.map((m) => Math.round(m * k));
  const rowsOf = s.strategy === 'ladder'
    ? (k === 1 && ladderFits(ladder, maxes) ? ladder : generateLadder(mI))
    : undefined;
  const ladders = new Map<string, Ladder>();
  const ladderOf = (mx: number[]): Ladder => { const k = mx.join(','); if (!ladders.has(k)) ladders.set(k, generateLadder(mx)); return ladders.get(k)!; };
  // критерии из вопросов (step): общий балл → сколько вопросов неверно в каждом критерии
  const byItems = columns.some((c) => c.step) ? itemSplitter(columns.map((c, i) => ({ max: mI[i], step: c.step ? Math.round(c.step * k) : 1 })), k) : null;
  const rows: ReportRow[] = [];
  const absentNames: string[] = [];
  let n = 0;
  cls.students.forEach((st, i) => {
    const raw = st.manualScores && st.manualScores.length === maxes.length && st.manualScores.some((v) => v != null)
      ? st.manualScores.map((v, k) => (v == null ? null : Math.max(0, Math.min(maxes[k], r2(v) || 0)))) : null;
    const own = raw ? raw.map((v) => v ?? 0) : null;
    const kk = k; // доли балла (k — индекс колонки в map ниже)
    const paper = s.workMode === 'paper';
    const fromJournal = a?.scores[i] ?? null; // общий балл из файла журнала (в бумажном режиме — тоже)
    const score = st.forceAbsent ? null : own ? own.reduce((x, y) => x + y, 0) : st.manualScore ?? fromJournal;
    if (score == null && paper && !st.forceAbsent) { // ещё не введено — строка видна и редактируется
      absentNames.push(st.name);
      rows.push({ n: ++n, name: st.name, absent: true, pending: true, scores: columns.map(() => 0), raw: columns.map(() => null), total: 0, percent: 0, grade: 0, reason: st.reason, retake: st.retake, studentIndex: i });
      return;
    }
    if (score == null) {
      absentNames.push(st.name);
      if (!s.includeAbsent) return;
      rows.push({ n: ++n, name: st.name, absent: true, scores: columns.map(() => 0), total: 0, percent: 0, grade: 0, reason: st.reason, retake: st.retake, studentIndex: i });
      return;
    }
    const rng = makeRng((s.seed ^ hash(st.name)) >>> 0);
    const t = Math.max(0, Math.min(Math.round(max * kk), Math.round(score * kk))); // в долях балла
    const fx = columns.map((c) => (c.fixed != null ? Math.round(Math.max(0, Math.min(c.max, c.fixed)) * kk) : null));
    const fixedSum = fx.reduce<number>((a, b) => a + (b ?? 0), 0);
    const split = (tt: number, mx: number[], tg: (number | undefined)[]) => s.strategy === 'ladder' ? (ladderOf(mx)[tt] ?? mx.map(() => 0)).slice()
      : s.strategy === 'targets' ? distributeTargets(tt, mx, tg, rng, s.spread ?? 1) : distribute(tt, mx, s.strategy, rng);
    let scores: number[];
    if (own) scores = own;
    else {
      let si: number[];
      if (byItems) si = byItems(score * kk);
      else if (fixedSum && fx.some((v) => v == null) && t >= fixedSum) { // «у всех одинаково»: остальное — по другим критериям
        const free = columns.map((_, k) => k).filter((k) => fx[k] == null);
        const part = split(Math.min(t - fixedSum, free.reduce((a, k) => a + mI[k], 0)), free.map((k) => mI[k]), free.map((k) => columns[k].target));
        si = columns.map((_, k) => fx[k] ?? part[free.indexOf(k)]);
      } else si = rowsOf?.[t] ? rowsOf[t].slice()
        : s.strategy === 'targets' ? distributeTargets(t, mI, columns.map((c) => c.target), rng, s.spread ?? 1)
        : distribute(t, mI, s.strategy === 'ladder' ? 'largest' : s.strategy, rng);
      scores = si.map((v) => r2(v / kk));
    }
    const row: ReportRow = { n: ++n, name: st.name, absent: false, scores, total: 0, percent: 0, grade: 0, reason: st.reason, retake: st.retake, studentIndex: i, manual: !!own, raw: raw ?? undefined, incomplete: !!raw && raw.some((v) => v == null) };
    if (paper && fromJournal != null) { row.journalTotal = r2(fromJournal); row.fromJournal = !own && st.manualScore == null; }
    else if (byItems && !own) row.journalTotal = r2(score); // раскидка по вопросам: 37,5 при 38 в журнале — округление
    recalcRow(row, max, s.thresholds);
    rows.push(row);
  });

  const subject = cls.subject || 'Предмет';
  const report: ClassReport = {
    classId: cls.id,
    sheetName: sheetNameFor(cls),
    title: buildTitle(cls, s, max),
    chartTitle: fillTemplate(s.layout.chartTitleTemplate, titleVars(cls, s, max)),
    bands: Math.max(1, ...columns.map((c) => c.bands || 1)),
    headerStyle: structure.headerStyle ?? 'full',
    layout: s.layout,
    className: cls.className, group: cls.group, subject,
    kind: s.kind, number: s.number,
    date: cls.dateHeld || (s.showDates ? fullDate(a?.date, cls.year || s.year) : undefined),
    dateEntered: cls.dateEntered,
    max, columns, tasks: structure.tasks, structure: cloneStructure(structure), rows,
    participants: 0, absent: absentNames.length + rows.filter((x) => !x.absent && x.reason).length, absentNames,
    avg: [], avgTotal: 0, count5: 0, count4: 0, count3: 0, count2: 0, efficiency: 0,
    teacherShort: s.teacherShort, thresholds: s.thresholds,
    absentColumns: s.absentColumns, showDates: s.showDates,
  };
  recalcSummary(report);
  return report;
}

/**
 * Раскладка «по вопросам»: в каждом критерии снимаются целые вопросы (знание по 2,5, применение по 4,5 …).
 * Из всех вариантов — ближайший к общему баллу журнала (журнал округляет: 37,5 ↔ 38), при равенстве — меньше ошибок,
 * затем ошибки в более крупных вопросах (одно «применение» вместо двух «знаний»). Всё в долях балла (целые).
 */
export function itemSplitter(cols: { max: number; step: number }[], k: number): (totalUnits: number) => number[] {
  const counts = cols.map((c) => Math.max(0, Math.round(c.max / c.step)));
  const combos: { errs: number[]; sum: number; n: number; big: number }[] = [];
  const total = counts.reduce((a, c) => a * (c + 1), 1);
  if (total > 200000) return (t) => cols.map((c) => Math.min(c.max, t)); // слишком много вариантов — не должно случаться
  const rec = (i: number, errs: number[]) => {
    if (i === cols.length) {
      const sum = cols.reduce((a, c, j) => a + c.max - errs[j] * c.step, 0);
      combos.push({ errs: errs.slice(), sum, n: errs.reduce((a, b) => a + b, 0), big: errs.reduce((a, e, j) => a + e * cols[j].step, 0) });
      return;
    }
    for (let e = 0; e <= counts[i]; e++) { errs.push(e); rec(i + 1, errs); errs.pop(); }
  };
  rec(0, []);
  const cache = new Map<number, number[]>();
  return (t) => {
    const key = Math.round(t);
    if (!cache.has(key)) {
      let best = combos[0], bd = Infinity;
      for (const c of combos) {
        const d = Math.abs(c.sum - key);
        if (d < bd - 1e-9 || (Math.abs(d - bd) < 1e-9 && (c.n < best.n || (c.n === best.n && c.big > best.big)))) { best = c; bd = d; }
      }
      cache.set(key, cols.map((c, j) => c.max - best.errs[j] * c.step));
    }
    void k;
    return cache.get(key)!.slice();
  };
}

/** Округление до сотых (дробные баллы без «7.499999»). */
export const r2 = (v: number): number => Math.round(v * 100) / 100;
/** Наименьшая доля балла, в которой все числа целые: 1, ½, ¼, 0,1 … */
export function unitOf(xs: number[]): number {
  for (const k of [1, 2, 4, 10, 20, 100]) if (xs.every((x) => Math.abs(x * k - Math.round(x * k)) < 1e-6)) return k;
  return 100;
}

export function recalcRow(row: ReportRow, max: number, th: Settings['thresholds']): void {
  const sum = r2(row.scores.reduce((x, y) => x + y, 0));
  // журнал хранит округлённый балл (37,5 → 38 или 37): расхождение меньше 1 — не ошибка, общий балл как в журнале
  const j = row.journalTotal;
  row.rounded = j != null && !row.incomplete && sum !== j && Math.abs(sum - j) < 1 ? sum : undefined;
  row.total = row.rounded != null ? j! : sum;
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
  r.count3 = part.filter((x) => x.grade === 3).length;
  r.count2 = part.filter((x) => x.grade === 2).length;
  r.efficiency = part.length ? (r.count5 + r.count4) / part.length : 0;
}
