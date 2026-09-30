import './style.css';
import { parseWorkbook, parseManualList, shortTeacherName } from './parse/journal.ts';
import { buildReport, recalcRow, recalcSummary } from './core/report.ts';
import { parseStructure, structureToText, structureMax, flattenColumns, taskHeader, PRESETS } from './core/structure.ts';
import { generateLadder, ladderErrors, ladderFits, type Ladder } from './core/ladder.ts';
import { exportWorkbook, fileNameFor } from './export/xlsx.ts';
import type { ClassReport, JournalClass, Settings, Structure } from './core/types.ts';

/* ---------- состояние ---------- */

interface ClassState { cls: JournalClass; structureText: string; report: ClassReport | null }

const DEFAULTS: Settings = {
  school: 'Государственная специализированная общеобразовательная школа № 300',
  kind: 'СОР', number: 1, teacherShort: '', year: '2025–2026',
  structure: parseStructure('5; 5+5+20+10; 5')!,
  strategy: 'ladder', seed: 7,
  thresholds: { five: 0.86, four: 0.66, three: 0.3 },
  includeAbsent: false, absentColumns: false, showDates: false, chartIncludeTotal: true,
  fontName: 'Aptos Narrow',
  ladders: {},
};

const LS = 'sor-reports.settings.v2';
function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(LS);
    if (raw) {
      const j = JSON.parse(raw) as Partial<Settings>;
      return { ...DEFAULTS, ...j, thresholds: { ...DEFAULTS.thresholds, ...(j.thresholds ?? {}) }, ladders: j.ladders ?? {} };
    }
  } catch { /* хранилище недоступно — умолчания */ }
  return { ...DEFAULTS, ladders: {} };
}
function saveSettings(): void {
  try { localStorage.setItem(LS, JSON.stringify(state.settings)); } catch { /* ignore */ }
}

const state = { classes: [] as ClassState[], settings: loadSettings(), active: 0, ladderKey: '' };

/* ---------- утилиты ---------- */

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const h = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pct = (x: number): string => `${Math.round(x * 100)}%`;
const fix = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(2));
const PALETTE = ['#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47', '#264478', '#9e480e', '#636363', '#997300'];

function structureTextFor(cs: ClassState): string {
  return parseStructure(cs.structureText) ? structureToText(parseStructure(cs.structureText)!) : structureToText(state.settings.structure);
}
function structureFor(cs: ClassState): Structure {
  return parseStructure(cs.structureText) ?? state.settings.structure;
}
function selectedMax(cls: JournalClass): number | undefined {
  return (cls.assessments.find((a) => a.id === cls.selectedAssessment) ?? cls.assessments[0])?.max;
}
/** Лестница для разбаловки: отредактированная из настроек или построенная по правилу. */
function ladderFor(text: string): { rows: Ladder; custom: boolean; maxes: number[] } {
  const st = parseStructure(text) ?? state.settings.structure;
  const maxes = flattenColumns(st).map((c) => c.max);
  const saved = state.settings.ladders[text];
  if (ladderFits(saved, maxes)) return { rows: saved, custom: true, maxes };
  return { rows: generateLadder(maxes), custom: false, maxes };
}

function rebuild(index?: number): void {
  state.classes.forEach((cs, i) => {
    if (index != null && i !== index) return;
    cs.report = cs.cls.assessments.length ? buildReport(cs.cls, state.settings, structureFor(cs), ladderFor(structureTextFor(cs)).rows) : null;
  });
}

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

/* ---------- рендер: лестница баллов ---------- */

function ladderKeys(): string[] {
  const keys = new Set<string>([structureToText(state.settings.structure)]);
  for (const cs of state.classes) keys.add(structureTextFor(cs));
  for (const k of Object.keys(state.settings.ladders)) if (parseStructure(k)) keys.add(k);
  return [...keys];
}

function renderLadder(): void {
  const keys = ladderKeys();
  if (!keys.includes(state.ladderKey)) state.ladderKey = keys[0];
  const sel = $('ladder-key') as HTMLSelectElement;
  sel.innerHTML = keys.map((k) => {
    const who = state.classes.filter((cs) => structureTextFor(cs) === k).map((cs) => cs.cls.className);
    const label = k === structureToText(state.settings.structure) ? `общая: ${k}` : `${who.join(', ') || 'сохранённая'}: ${k}`;
    return `<option value="${h(k)}" ${k === state.ladderKey ? 'selected' : ''}>${h(label)}${state.settings.ladders[k] ? ' (правлена)' : ''}</option>`;
  }).join('');

  const key = state.ladderKey;
  const st = parseStructure(key)!;
  const cols = flattenColumns(st);
  const { rows, custom, maxes } = ladderFor(key);
  const auto = generateLadder(maxes);
  const bad = new Set(ladderErrors(rows, maxes));
  $('ladder-status').textContent = custom ? `${key} — с правками${bad.size ? `, ошибок: ${bad.size}` : ''}` : `${key} — по правилу`;
  const head = cols.map((c) => `<th title="${h(taskHeader(st.tasks[c.taskIndex], c.taskIndex))}">${c.partIndex < 0 ? `${c.taskIndex + 1} зд` : `${c.taskIndex + 1}.${c.partIndex + 1}`}<br><small>${c.max}</small></th>`).join('');
  const max = rows.length - 1;
  let body = '';
  for (let t = max; t >= 0; t--) {
    const r = rows[t];
    const edited = custom && auto[t].some((v, i) => v !== r[i]);
    body += `<tr data-t="${t}" class="${bad.has(t) ? 'bad' : ''} ${edited ? 'edited' : ''}"><th class="tot">${t}</th>${r.map((v, i) => `<td><input type="number" min="0" max="${maxes[i]}" value="${v}" data-c="${i}" /></td>`).join('')}<td class="sum">${r.reduce((a, b) => a + b, 0)}</td></tr>`;
  }
  $('ladder').innerHTML = `<table class="ladder-t"><thead><tr><th class="tot">Балл</th>${head}<th>Σ</th></tr></thead><tbody>${body}</tbody></table>`;
}

function onLadderEdit(input: HTMLInputElement): void {
  const key = state.ladderKey;
  const { rows, maxes } = ladderFor(key);
  const copy = rows.map((r) => r.slice());
  const t = Number(input.closest('tr')!.getAttribute('data-t'));
  const c = Number(input.dataset.c);
  const v = Math.round(Number(input.value));
  copy[t][c] = Number.isFinite(v) ? v : 0;
  state.settings.ladders[key] = copy;
  saveSettings();
  // подсветить строку и сумму без полной перерисовки
  const tr = input.closest('tr')!;
  const sum = copy[t].reduce((a, b) => a + b, 0);
  tr.querySelector('.sum')!.textContent = String(sum);
  tr.classList.toggle('bad', sum !== t || copy[t].some((x, i) => x < 0 || x > maxes[i]));
  tr.classList.add('edited');
  $('ladder-status').textContent = `${key} — с правками`;
  rebuild(); renderTabs(); renderPreview();
}

/* ---------- рендер: предпросмотр ---------- */

function renderTabs(): void {
  $('tabs').innerHTML = state.classes.map((cs, i) =>
    `<button class="tab ${i === state.active ? 'active' : ''}" data-i="${i}">${h(cs.cls.className)}${cs.cls.group === 'девочки' ? ' Д' : ''}</button>`).join('');
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

function renderStats(r: ClassReport): string {
  const part = r.rows.filter((x) => !x.absent);
  const c3 = part.filter((x) => x.grade === 3).length, c2 = part.filter((x) => x.grade === 2).length;
  const tile = (v: string, l: string, cls = '') => `<div class="stat ${cls}"><b>${v}</b><span>${l}</span></div>`;
  return `<div class="stats">${tile(String(r.participants), 'участвовали')}${tile(String(r.absent), 'отсутствовали')}${tile(pct(r.max ? r.avgTotal / r.max : 0), 'средний результат')}${tile(String(r.count5), 'оценка «5»', 'g5')}${tile(String(r.count4), 'оценка «4»', 'g4')}${tile(String(c3), 'оценка «3»', 'g3')}${tile(String(c2), 'оценка «2»', 'g2')}${tile(pct(r.efficiency), 'эффективность знаний')}</div>`;
}

/** Столбчатая диаграмма с накоплением, как в книге Excel. */
function renderChart(r: ClassReport): string {
  const rows = r.rows.filter((x) => !x.absent);
  if (!rows.length) return '';
  const W = 960, H = 300, padL = 34, padB = 78, padT = 10, padR = 8;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const bw = innerW / rows.length, gap = Math.min(6, bw * 0.25);
  const y = (v: number) => padT + innerH - (v / r.max) * innerH;
  let svg = '';
  for (let g = 0; g <= 5; g++) {
    const v = (r.max / 5) * g;
    svg += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="#e3e7ec"/><text x="${padL - 6}" y="${y(v) + 4}" font-size="10" text-anchor="end" fill="#5d6b7a">${Math.round(v)}</text>`;
  }
  rows.forEach((row, i) => {
    const x = padL + i * bw + gap / 2;
    let acc = 0;
    row.scores.forEach((v, ci) => {
      if (!v) return;
      svg += `<rect x="${x}" y="${y(acc + v)}" width="${bw - gap}" height="${y(acc) - y(acc + v)}" fill="${PALETTE[ci % PALETTE.length]}"><title>${h(row.name)} — ${h(r.columns[ci].header || taskHeader(r.tasks[r.columns[ci].taskIndex], r.columns[ci].taskIndex))}: ${v}</title></rect>`;
      acc += v;
    });
    svg += `<text x="${x + (bw - gap) / 2}" y="${y(acc) - 3}" font-size="9" text-anchor="middle" fill="#1b2430">${acc}</text>`;
    const short = row.name.split(' ')[0];
    svg += `<text transform="translate(${x + (bw - gap) / 2},${H - padB + 8}) rotate(-60)" font-size="9" text-anchor="end" fill="#5d6b7a">${h(short)}</text>`;
  });
  const legend = r.columns.map((c, ci) => `<span><i style="background:${PALETTE[ci % PALETTE.length]}"></i>${h(c.partIndex < 0 ? taskHeader(r.tasks[c.taskIndex], c.taskIndex) : `${c.taskIndex + 1}.${c.partIndex + 1} — ${c.header}`)}</span>`).join('');
  return `<div class="chart"><h3>${h(r.chartTitle)}</h3><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Баллы учеников по заданиям">${svg}</svg><div class="legend">${legend}</div></div>`;
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

  box.innerHTML = `${mismatch}${renderStats(r)}<div class="sheet">
    <p class="title">${h(r.title)}</p>
    <div class="hdr"><b>Участвовали: ${r.participants}</b><span>дата проведение ${r.kind}: ${h(r.date ?? '')}</span>
      <b>Отсутствовали: ${r.absent}</b><span>Дата внесения в emaktab.uz:</span>
      ${r.absentNames.length ? `<span class="absent">Без балла: ${h(r.absentNames.join(', '))}</span>` : ''}</div>
    <table class="rep"><thead>
      <tr><th rowspan="2">№</th><th rowspan="2">Фамилия имя ученика</th>${extra}${head1}<th rowspan="2">Общий балл</th><th rowspan="2">В%</th><th rowspan="2">Оценивание</th></tr>
      <tr>${head2}</tr></thead>
      <tbody>${body}</tbody><tfoot>${footEl.innerHTML}</tfoot></table>
    <p class="sign">Фамилия учителя-предметника: ${h(r.teacherShort)}__________________ &nbsp;&nbsp;&nbsp; Подпись ________</p>
  </div>${renderChart(r)}`;
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
  renderFootInto($('preview').querySelector('tfoot')!, r);
  $('preview').querySelector('.stats')!.outerHTML = renderStats(r);
  const chart = $('preview').querySelector('.chart');
  if (chart) chart.outerHTML = renderChart(r);
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
  $('sec-settings').addEventListener('change', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('#ladder-box')) return; // лестница обрабатывается отдельно
    apply();
  });
  $('s-structure').addEventListener('input', renderStructureView);
  $('s-preset').addEventListener('change', () => {
    const p = ($('s-preset') as HTMLSelectElement).value;
    if (p) { ($('s-structure') as HTMLInputElement).value = p; ($('s-preset') as HTMLSelectElement).value = ''; apply(); }
  });
  $('s-reseed').addEventListener('click', () => { ($('s-seed') as HTMLInputElement).value = String(Math.floor(Math.random() * 1e6)); apply(); });

  $('ladder-key').addEventListener('change', () => { state.ladderKey = ($('ladder-key') as HTMLSelectElement).value; renderLadder(); });
  $('ladder-reset').addEventListener('click', () => {
    if (state.settings.ladders[state.ladderKey] && !confirm('Убрать правки и построить лестницу заново по правилу?')) return;
    delete state.settings.ladders[state.ladderKey]; saveSettings(); rebuild(); render();
  });
  $('ladder').addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement; if (t.matches('input[data-c]')) onLadderEdit(t);
  });
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

function render(): void { renderClasses(); renderLadder(); renderTabs(); renderPreview(); }

bindSettings();
bindEvents();
render();
