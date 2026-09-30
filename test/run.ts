// Прогон ядра на образце журнала: node test/run.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parseWorkbook, shortTeacherName } from '../src/parse/journal.ts';
import { buildReport } from '../src/core/report.ts';
import { parseStructure } from '../src/core/structure.ts';
import { distribute } from '../src/core/distribute.ts';
import { exportWorkbook, fileNameFor } from '../src/export/xlsx.ts';
import type { Settings } from '../src/core/types.ts';

const file = process.argv[2] ?? 'samples/5 С-Технология-10.03.2026.xls';
const buf = readFileSync(file);
const classes = parseWorkbook(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), file);
console.log('классов:', classes.length);
for (const c of classes) {
  console.log(c.className, c.group, c.year, 'чтв', c.quarter, '|', c.subject, '|', c.teacher, '→', shortTeacherName(c.teacher));
  console.log(' учеников:', c.students.length, ' колонки:', c.assessments.map((a) => `${a.kind}#${a.ordinal} ${a.date ?? '?'} max ${a.max} col ${a.col} scores ${a.scores.filter((s) => s != null).length}/${a.scores.length}`));
}

console.log('distribute 46 largest:', distribute(46, [5, 5, 5, 20, 10, 5], 'largest'));
console.log('distribute 30 largest:', distribute(30, [5, 5, 5, 20, 10, 5], 'largest'));
console.log('distribute 46 prop   :', distribute(46, [5, 5, 5, 20, 10, 5], 'proportional'));
console.log('distribute 0        :', distribute(0, [5, 5, 5, 20, 10, 5], 'largest'));

const settings: Settings = {
  school: 'Государственная специализированная общеобразовательная школа № 300',
  kind: 'СОР', number: 3,
  teacherShort: shortTeacherName(classes[0]?.teacher),
  year: '2025–2026',
  structure: parseStructure('5; 5+5+20+10; 5')!,
  strategy: 'largest', seed: 1,
  thresholds: { five: 0.86, four: 0.66, three: 0.3 },
  includeAbsent: false, absentColumns: false, showDates: false, chartIncludeTotal: true,
  fontName: 'Aptos Narrow',
};
const reports = classes.map((c) => buildReport(c, settings));
for (const r of reports) {
  console.log(r.sheetName, '|', r.title);
  console.log(' участвовали', r.participants, 'отсутствовали', r.absent, r.absentNames, ' 5:', r.count5, ' 4:', r.count4, ' эфф', r.efficiency.toFixed(2));
  for (const row of r.rows.slice(0, 4)) console.log('  ', row.n, row.name, row.scores.join(' '), '=', row.total, (row.percent * 100).toFixed(0) + '%', row.grade);
}
mkdirSync('.out', { recursive: true });
const bytes = await exportWorkbook(reports, settings);
const out = `.out/${fileNameFor(reports, settings)}`;
writeFileSync(out, bytes);
console.log('записано', out, bytes.length, 'байт');

// вариант 2.2 с отсутствующими
const s2 = { ...settings, includeAbsent: true, absentColumns: true, showDates: true };
const bytes2 = await exportWorkbook(classes.map((c) => buildReport(c, s2)), s2);
writeFileSync('.out/variant-2.2.xlsx', bytes2);
console.log('записано .out/variant-2.2.xlsx', bytes2.length);
