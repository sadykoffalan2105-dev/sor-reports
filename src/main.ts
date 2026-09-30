import './style.css';
import { parseWorkbook, parseManualList, shortTeacherName } from './parse/journal.ts';
import { buildReport, recalcRow, recalcSummary } from './core/report.ts';
import { parseStructure, structureToText, structureMax, taskHeader, PRESETS } from './core/structure.ts';
import { exportWorkbook, fileNameFor } from './export/xlsx.ts';
import type { ClassReport, JournalClass, Settings, Structure } from './core/types.ts';

/* ---------- состояние ---------- */

interface ClassState { cls: JournalClass; structureText: string; report: ClassReport | null }

const DEFAULTS: Settings = {
  school: 'Государственная специализированная общеобразовательная школа № 300',
  kind: 'СОР', number: 1, teacherShort: '', year: '2025–2026',
  structure: parseStructure('5; 5+5+20+10; 5')!,
  strategy: 'largest', seed: 7,
  thresholds: { five: 0.86, four: 0.66, three: 0.3 },
  includeAbsent: false, absentColumns: false, showDates: false, chartIncludeTotal: true,
  fontName: 'Aptos Narrow',
};

const LS = 'sor-reports.settings.v1';
function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(LS);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw), thresholds: { ...DEFAULTS.thresholds, ...(JSON.parse(raw).thresholds ?? {}) } };
  } catch { /* нет доступа к хранилищу — работаем с умолчаниями */ }
  return { ...DEFAULTS };
}
function saveSettings(): void {
  try { localStorage.setItem(LS, JSON.stringify(state.settings)); } catch { /* ignore */ }
}

const state = { classes: [] as ClassState[], settings: loadSettings(), active: 0 };

/* ---------- утилиты ---------- */

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const h = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pct = (x: number): string => `${Math.round(x * 100)}%`;
const fix = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(2));

function structureFor(cs: ClassState): Structure {
  return parseStructure(cs.structureText) ?? state.settings.structure;
}
function selectedMax(cls: JournalClass): number | undefined {
  return (cls.assessments.find((a) => a.id === cls.selectedAssessment) ?? cls.assessments[0])?.max;
}

function rebuild(index?: number): void {
  state.classes.forEach((cs, i) => {
    if (index != null && i !== index) return;
    cs.report = cls_hasScores(cs.cls) ? buildReport(cs.cls, state.settings, structureFor(cs)) : null;
  });
}
const cls_hasScores = (c: JournalClass) => c.assessments.length > 0;

function download(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------- загрузка файлов ---------- */

async function addFiles(files: FileList | File[]): Promise<void> {
  const errors: string[] = [];
  for (const f of Array.from(files)) {
    try {
      const found = parseWorkbook(await f.arrayBuffer(), f.name);
      if (!found.length) { errors.push(`${f.name}: не нашёл таблицу с учениками`); continue; }
      for (const cls of found) addClass(cls);
    } catch (e) {
      errors.push(`${f.name}: ${(e as Error).message}`);
    }
  }
  rebuild();
  state.active = Math.max(0, state.classes.length - 1);
  render();
  if (errors.length) alert(errors.join('\n'));
}

function addClass(cls: JournalClass): void {
  const s = state.settings;
  if (!s.teacherShort && cls.teacher) { s.teacherShort = shortTeacherName(cls.teacher); ($('s-teacher') as HTMLInputElement).value = s.teacherShort; }
  if (cls.year && s.year !== cls.year) { s.year = cls.year; ($('s-year') as HTMLInputElement).value = s.year; }
  saveSettings();
  state.classes.push({ cls, structureText: '', report: null });
}

/* ---------- рендер: список классов ---------- */

function renderClasses(): void {
  const box = $('classes');
  if (!state.classes.length) { box.innerHTML = '<div class="empty">Пока ничего не загружено.</div>'; return; }
  box.innerHTML = state.classes.map((cs, i) => {
    const c = cs.cls;
    const sel = c.selectedAssessment;
    const opts = c.assessments.map((a) => {
      const have = a.scores.filter((x) => x != null).length;
      return `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${a.kind} №${a.ordinal}${a.date ? ' · ' + a.date : ''} · макс ${a.max} · баллов ${have}/${a.scores.length}</option>`;
    }).join('');
    const sm = structureMax(structureFor(cs));
    const am = selectedMax(c);
    const warn = am != null && sm !== am ? `<div class="warn">Сумма разбаловки ${sm} ≠ максимуму работы в журнале ${am}. Поправьте разбаловку (общую или для этого класса).</div>` : '';
    return `<div class="cls" data-i="${i}">
      <div><span class="name">${h(c.className)}${c.group ? ' · ' + h(c.group) : ''}</span>
        <div class="meta">${h(c.subject ?? '')}${c.quarter ? ' · ' + c.quarter + ' четверть' : ''} · учеников: ${c.students.length} · ${h(c.source)}</div></div>
      <button class="btn small ghost" data-act="remove" title="Убрать класс">✕</button>
      <div class="ctl">
        <label>Колонка <select data-act="assess">${opts}</select></label>
        <label>Своя разбаловка <input data-act="structure" value="${h(cs.structureText)}" placeholder="как общая" style="width:180px" /></label>
      </div>${warn}</div>`;
  }).join('');
}

/* ---------- рендер: предпросмотр ---------- */

function renderTabs(): void {
  $('tabs').innerHTML = state.classes.map((cs, i) =>
    `<button class="tab ${i === state.active ? 'active' : ''}" data-i="${i}">${h(cs.cls.className)}${cs.cls.group === 'девочки' ? ' Д' : ''}</button>`).join('');
}

function renderPreview(): void {
  const box = $('preview');
  const cs = state.classes[state.active];
  const r = cs?.report;
  const hasAny = state.classes.some((x) => x.report);
  ($('dl-all') as HTMLButtonElement).disabled = !hasAny;
  ($('dl-one') as HTMLButtonElement).disabled = !r;
  ($('reshuffle') as HTMLButtonElement).disabled = !r;
  ($('print') as HTMLButtonElement).disabled = !r;
  if (!r) { box.innerHTML = '<div class="empty">Загрузите журнал — здесь появится отчёт.</div>'; return; }

  const am = selectedMax(cs.cls);
  const mismatch = am != null && r.max !== am ? `<div class="mismatch">Внимание: разбаловка даёт ${r.max} баллов, а работа в журнале — на ${am}. Проценты и оценки будут неверными.</div>` : '';

  const extra = r.absentColumns ? '<th rowspan="2">Причина отсутствия</th><th rowspan="2">Дата сдачи</th>' : '';
  let head1 = '', head2 = '';
  r.tasks.forEach((t, ti) => {
    const cols = r.columns.filter((c) => c.taskIndex === ti);
    if (!t.parts.length) head1 += `<th rowspan="2">${h(t.title || taskHeader(t, ti))}</th>`;
    else { head1 += `<th colspan="${cols.length}">${h(t.title || taskHeader(t, ti))}</th>`; head2 += cols.map((c) => `<th>${h(c.header)}</th>`).join(''); }
  });
  const body = r.rows.map((row, ri) => {
    if (row.absent) {
      const who = r.group === 'девочки' ? 'отсутствовала' : 'отсутствовал';
      return `<tr class="abs"><td>${row.n}</td><td class="name">${h(row.name)}</td>${r.absentColumns ? `<td>${who}</td><td></td><td colspan="${r.columns.length + 3}"></td>` : `<td colspan="${r.columns.length + 3}">${who}</td>`}</tr>`;
    }
    const cells = row.scores.map((v, ci) => `<td><input type="number" min="0" max="${r.columns[ci].max}" value="${v}" data-r="${ri}" data-c="${ci}" /></td>`).join('');
    return `<tr data-r="${ri}"><td>${row.n}</td><td class="name">${h(row.name)}</td>${r.absentColumns ? '<td></td><td></td>' : ''}${cells}<td data-k="total">${row.total}</td><td data-k="pct">${pct(row.percent)}</td><td data-k="grade">${row.grade}</td></tr>`;
  }).join('');
  const footEl = document.createElement('tfoot');
  renderFootInto(footEl, r);
  const foot = footEl.innerHTML;

  box.innerHTML = `${mismatch}<div class="sheet">
    <p class="title">${h(r.title)}</p>
    <div class="hdr"><b>Участвовали: ${r.participants}</b><span>дата проведение ${r.kind}: ${h(r.date ?? '')}</span>
      <b>Отсутствовали: ${r.absent}</b><span>Дата внесения в emaktab.uz:</span>
      ${r.absentNames.length ? `<span class="absent">Без балла: ${h(r.absentNames.join(', '))}</span>` : ''}</div>
    <table class="rep"><thead>
      <tr><th rowspan="2">№</th><th rowspan="2">Фамилия имя ученика</th>${extra}${head1}<th rowspan="2">Общий балл</th><th rowspan="2">В%</th><th rowspan="2">Оценивание</th></tr>
      <tr>${head2}</tr></thead>
      <tbody>${body}</tbody><tfoot>${foot}</tfoot></table>
    <p class="sign">Фамилия учителя-предметника: ${h(r.teacherShort)}__________________ &nbsp;&nbsp;&nbsp; Подпись ________</p>
  </div>`;
}

/** Правка балла в ячейке: пересчитать строку и итоги без перерисовки всей таблицы. */
function onScoreEdit(input: HTMLInputElement): void {
  const cs = state.classes[state.active];
  const r = cs?.report;
  if (!r) return;
  const ri = Number(input.dataset.r), ci = Number(input.dataset.c);
  const row = r.rows[ri];
  let v = Math.round(Number(input.value));
  if (!Number.isFinite(v)) v = 0;
  input.classList.toggle('bad', v < 0 || v > r.columns[ci].max);
  row.scores[ci] = v;
  recalcRow(row, r.max, r.thresholds);
  recalcSummary(r);
  const tr = input.closest('tr')!;
  tr.querySelector('[data-k="total"]')!.textContent = String(row.total);
  tr.querySelector('[data-k="pct"]')!.textContent = pct(row.percent);
  tr.querySelector('[data-k="grade"]')!.textContent = String(row.grade);
  // итоги — перерисовать только tfoot
  renderFootInto($('preview').querySelector('tfoot')!, r);
}
function renderFootInto(el: HTMLElement, r: ClassReport): void {
  const lead = r.absentColumns ? '<td></td><td></td>' : '';
  el.innerHTML = `
    <tr><td></td><td class="lbl">Сред.балл:</td>${lead}${r.avg.map((a) => `<td>${fix(a)}</td>`).join('')}<td>${fix(r.avgTotal)}</td><td>${pct(r.max ? r.avgTotal / r.max : 0)}</td><td></td></tr>
    <tr><td></td><td class="lbl">Процентный показатель</td>${lead}${r.avg.map((a, i) => `<td>${pct(r.columns[i].max ? a / r.columns[i].max : 0)}</td>`).join('')}<td>${pct(r.max ? r.avgTotal / r.max : 0)}</td><td></td><td></td></tr>
    <tr><td></td><td class="lbl">Количество - “5”</td>${lead}<td>${r.count5}</td><td colspan="${r.columns.length + 2}"></td></tr>
    <tr><td></td><td class="lbl">Количество - “4”</td>${lead}<td>${r.count4}</td><td colspan="${r.columns.length + 2}"></td></tr>
    <tr><td></td><td class="lbl eff">Эффективность знаний</td>${lead}<td colspan="${r.columns.length + 1}"></td><td class="eff">${pct(r.efficiency)}</td><td></td></tr>`;
}

/* ---------- настройки ---------- */

function renderStructureView(): void {
  const s = parseStructure(($('s-structure') as HTMLInputElement).value);
  const el = $('s-structure-view');
  if (!s) { el.innerHTML = '<span class="sum bad">Не могу разобрать запись. Пример: 5; 5+5+20+10; 5</span>'; return; }
  const total = structureMax(s);
  el.innerHTML = s.tasks.map((t, i) => `<span class="task">${h(taskHeader(t, i))}${t.parts.length ? ' = ' + t.parts.map((p) => `<span class="part">${p.max}</span>`).join('') : ''}</span>`).join('')
    + `<span class="sum ${total === 50 || total === 40 ? '' : 'bad'}">итого ${total} баллов</span>`;
}

function bindSettings(): void {
  const s = state.settings;
  const set = (id: string, v: string | number | boolean) => {
    const el = $(id) as HTMLInputElement;
    if (typeof v === 'boolean') el.checked = v; else el.value = String(v);
  };
  set('s-school', s.school); set('s-kind', s.kind); set('s-number', s.number); set('s-teacher', s.teacherShort);
  set('s-year', s.year); set('s-structure', structureToText(s.structure)); set('s-strategy', s.strategy); set('s-seed', s.seed);
  set('s-t5', Math.round(s.thresholds.five * 100)); set('s-t4', Math.round(s.thresholds.four * 100)); set('s-t3', Math.round(s.thresholds.three * 100));
  set('s-absent', s.includeAbsent); set('s-absentcols', s.absentColumns); set('s-dates', s.showDates); set('s-charttotal', s.chartIncludeTotal);
  $('s-preset').insertAdjacentHTML('beforeend', PRESETS.map((p) => `<option value="${h(p.text)}">${h(p.name)}</option>`).join(''));
  renderStructureView();

  const apply = () => {
    const v = (id: string) => ($(id) as HTMLInputElement).value;
    const b = (id: string) => ($(id) as HTMLInputElement).checked;
    s.school = v('s-school').trim(); s.kind = v('s-kind') as Settings['kind']; s.number = Math.max(1, Number(v('s-number')) || 1);
    s.teacherShort = v('s-teacher').trim(); s.year = v('s-year').trim();
    const st = parseStructure(v('s-structure')); if (st) s.structure = st;
    s.strategy = v('s-strategy') as Settings['strategy']; s.seed = Number(v('s-seed')) || 0;
    s.thresholds = { five: Number(v('s-t5')) / 100, four: Number(v('s-t4')) / 100, three: Number(v('s-t3')) / 100 };
    s.includeAbsent = b('s-absent'); s.absentColumns = b('s-absentcols'); s.showDates = b('s-dates'); s.chartIncludeTotal = b('s-charttotal');
    saveSettings();
    renderStructureView();
    rebuild();
    render();
  };
  $('sec-settings').addEventListener('change', apply);
  $('s-structure').addEventListener('input', renderStructureView);
  $('s-preset').addEventListener('change', () => {
    const p = ($('s-preset') as HTMLSelectElement).value;
    if (p) { ($('s-structure') as HTMLInputElement).value = p; ($('s-preset') as HTMLSelectElement).value = ''; apply(); }
  });
  $('s-reseed').addEventListener('click', () => { ($('s-seed') as HTMLInputElement).value = String(Math.floor(Math.random() * 1e6)); apply(); });
}

/* ---------- события ---------- */

function bindEvents(): void {
  const drop = $('drop'), file = $('file') as HTMLInputElement;
  file.addEventListener('change', () => { if (file.files?.length) void addFiles(file.files); file.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer?.files.length) void addFiles(e.dataTransfer.files); });

  $('classes').addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    const i = Number(t.closest('.cls')?.getAttribute('data-i'));
    const cs = state.classes[i]; if (!cs) return;
    if (t.dataset.act === 'assess') cs.cls.selectedAssessment = t.value;
    if (t.dataset.act === 'structure') cs.structureText = t.value.trim();
    rebuild(i); state.active = i; render();
  });
  $('classes').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-act="remove"]'); if (!b) return;
    const i = Number(b.closest('.cls')?.getAttribute('data-i'));
    state.classes.splice(i, 1); state.active = Math.min(state.active, Math.max(0, state.classes.length - 1)); render();
  });

  $('m-add').addEventListener('click', () => {
    const cls = parseManualList(($('m-text') as HTMLTextAreaElement).value, ($('m-class') as HTMLInputElement).value, Number(($('m-max') as HTMLInputElement).value) || 50);
    if (!cls) { alert('Не нашёл ни одной строки с учеником.'); return; }
    const g = ($('m-group') as HTMLSelectElement).value; if (g) cls.group = g as JournalClass['group'];
    addClass(cls); rebuild(); state.active = state.classes.length - 1; render();
    ($('m-text') as HTMLTextAreaElement).value = '';
  });

  $('tabs').addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('.tab'); if (!t) return;
    state.active = Number(t.getAttribute('data-i')); renderTabs(); renderPreview();
  });
  $('preview').addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement; if (t.matches('input[data-r]')) onScoreEdit(t);
  });

  $('dl-all').addEventListener('click', async () => {
    const reports = state.classes.map((c) => c.report).filter((r): r is ClassReport => !!r);
    if (!reports.length) return;
    download(await exportWorkbook(reports, state.settings), fileNameFor(reports, state.settings));
  });
  $('dl-one').addEventListener('click', async () => {
    const r = state.classes[state.active]?.report; if (!r) return;
    download(await exportWorkbook([r], state.settings), fileNameFor([r], state.settings).replace('.xlsx', ` ${r.sheetName}.xlsx`));
  });
  $('reshuffle').addEventListener('click', () => {
    const s = state.settings;
    if (s.strategy !== 'random') { ($('s-strategy') as HTMLSelectElement).value = 'random'; s.strategy = 'random'; }
    s.seed = Math.floor(Math.random() * 1e6); ($('s-seed') as HTMLInputElement).value = String(s.seed);
    saveSettings(); rebuild(); render();
  });
  $('print').addEventListener('click', () => window.print());
}

function render(): void { renderClasses(); renderTabs(); renderPreview(); }

bindSettings();
bindEvents();
render();
