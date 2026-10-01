import './style.css';
import { parseWorkbook, parseManualList, shortTeacherName } from './parse/journal.ts';
import { buildReport, recalcRow, recalcSummary, fullDate } from './core/report.ts';
import {
  parseStructure, structureFromText, structureToText, structureMax, flattenColumns, taskHeader, taskMax,
  cloneStructure, normalizeStructure, newPresetId, builtinPresets, pointsLabel, columnName,
} from './core/structure.ts';
import { generateLadder, ladderErrors, ladderFits, fillLadderGaps, type Ladder } from './core/ladder.ts';
import type { RecognizeResult } from './vision/recognize.ts'; // только тип — модуль грузится лениво
import { exportWorkbook, fileNameFor } from './export/xlsx.ts';
import type { ClassReport, JournalClass, Preset, Settings, Structure } from './core/types.ts';

/* ---------- состояние ---------- */

interface ClassState { cls: JournalClass; presetId: string; report: ClassReport | null }

const NOTE_DEFAULT = 'Примечание\n- Оценки БСБ должны быть внесены в emaktab.uz в течение 5–7 дней.\n- Ученики, получившие оценку «2» (0–29 %), должны быть привлечены учителем предмета к дополнительным занятиям после уроков.';

function defaults(): Settings {
  const presets = builtinPresets();
  return {
    school: 'Государственная специализированная общеобразовательная школа № 300',
    kind: 'СОР', number: 1, teacherShort: '', year: '2025–2026',
    structure: cloneStructure(presets[0].structure),
    presets, presetId: presets[0].id,
    strategy: 'ladder', seed: 7,
    thresholds: { five: 0.86, four: 0.66, three: 0.3 },
    includeAbsent: false, absentColumns: false, showDates: false, chartIncludeTotal: true,
    fontName: 'Aptos Narrow',
    variantLabel: '', noteText: NOTE_DEFAULT,
    ladders: {},
  };
}

const LS = 'sor-reports.settings.v3';
const LS_OLD = 'sor-reports.settings.v2';
const LS_KEY = 'sor-reports.apiKey';

function loadSettings(): Settings {
  const d = defaults();
  try {
    const raw = localStorage.getItem(LS);
    if (raw) {
      const j = JSON.parse(raw) as Partial<Settings>;
      const s: Settings = { ...d, ...j, thresholds: { ...d.thresholds, ...(j.thresholds ?? {}) }, ladders: j.ladders ?? {} };
      if (!Array.isArray(s.presets) || !s.presets.length) { s.presets = d.presets; s.presetId = d.presetId; }
      if (!s.presets.some((p) => p.id === s.presetId)) s.presetId = s.presets[0].id;
      s.structure = cloneStructure(s.presets.find((p) => p.id === s.presetId)!.structure);
      return s;
    }
    const old = localStorage.getItem(LS_OLD);
    if (old) { // перенос из прежней версии: разбаловка → пресет «Моя разбаловка»
      const j = JSON.parse(old) as Partial<Settings>;
      const s: Settings = { ...d, ...j, presets: d.presets, presetId: d.presetId, thresholds: { ...d.thresholds, ...(j.thresholds ?? {}) }, ladders: j.ladders ?? {}, variantLabel: '', noteText: NOTE_DEFAULT };
      if (j.structure?.tasks?.length) {
        const mine: Preset = { id: newPresetId(), name: 'Моя разбаловка', structure: cloneStructure(j.structure) };
        s.presets = [mine, ...d.presets]; s.presetId = mine.id;
      }
      s.structure = cloneStructure(s.presets.find((p) => p.id === s.presetId)!.structure);
      return s;
    }
  } catch { /* хранилище недоступно — умолчания */ }
  return d;
}
function saveSettings(): void {
  try { localStorage.setItem(LS, JSON.stringify(state.settings)); } catch { /* ignore */ }
}

const state = { classes: [] as ClassState[], settings: loadSettings(), active: 0, ladderKey: '' };

/* ---------- утилиты ---------- */

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const h = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const br = (s: string): string => h(s).replace(/\n/g, '<br>');
const pct = (x: number): string => `${Math.round(x * 100)}%`;
const fix = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(2));
/** «13.02.2026» ↔ «2026-02-13» для <input type=date>. */
const toIso = (d?: string): string => { const m = (d ?? '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
const fromIso = (v: string): string => { const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[3]}.${m[2]}.${m[1]}` : ''; };
const PALETTE = ['#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47', '#264478', '#9e480e', '#636363', '#997300'];

const S = () => state.settings;
const presetById = (id: string): Preset | undefined => S().presets.find((p) => p.id === id);
const currentPreset = (): Preset => presetById(S().presetId) ?? S().presets[0];

/** Структура класса: свой пресет или общая. */
function structureFor(cs: ClassState): Structure {
  return (cs.presetId && presetById(cs.presetId)?.structure) || S().structure;
}
function structureTextFor(cs: ClassState): string { return structureToText(structureFor(cs)); }
function selectedMax(cls: JournalClass): number | undefined {
  return (cls.assessments.find((a) => a.id === cls.selectedAssessment) ?? cls.assessments[0])?.max;
}
/** Лестница для разбаловки: отредактированная из настроек или построенная по правилу. */
function ladderFor(text: string): { rows: Ladder; custom: boolean; maxes: number[] } {
  const st = parseStructure(text) ?? S().structure;
  const maxes = flattenColumns(st).map((c) => c.max);
  const saved = S().ladders[text];
  if (ladderFits(saved, maxes)) return { rows: saved, custom: true, maxes };
  return { rows: generateLadder(maxes), custom: false, maxes };
}

function rebuild(index?: number): void {
  state.classes.forEach((cs, i) => {
    if (index != null && i !== index) return;
    cs.report = cs.cls.assessments.length ? buildReport(cs.cls, S(), structureFor(cs), ladderFor(structureTextFor(cs)).rows) : null;
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
  const s = S();
  if (!s.teacherShort && cls.teacher) { s.teacherShort = shortTeacherName(cls.teacher); ($('s-teacher') as HTMLInputElement).value = s.teacherShort; }
  if (cls.year && s.year !== cls.year) { s.year = cls.year; ($('s-year') as HTMLInputElement).value = s.year; }
  saveSettings();
  // подобрать пресет по номеру класса («5 класс — …»)
  const grade = cls.className.match(/^\d+/)?.[0];
  const auto = grade ? s.presets.find((p) => new RegExp(`^${grade}\\s*класс`, 'i').test(p.name)) : undefined;
  state.classes.push({ cls, presetId: auto && auto.id !== s.presetId ? auto.id : '', report: null });
}

/* ---------- рендер: список классов ---------- */

function presetOptions(selected: string, withDefault: boolean): string {
  const opts = S().presets.map((p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${h(p.name)} · ${h(structureToText(p.structure))}</option>`);
  if (withDefault) opts.unshift(`<option value="" ${selected ? '' : 'selected'}>как общая (${h(currentPreset().name)})</option>`);
  return opts.join('');
}

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
    const warn = am != null && sm !== am ? `<div class="warn">Сумма разбаловки ${sm} ≠ максимуму работы в журнале ${am}. Выберите другую разбаловку для этого класса или поправьте её.</div>` : '';
    return `<div class="cls" data-i="${i}">
      <div><span class="name">${h(c.className)}${c.group ? ' · ' + h(c.group) : ''}</span>
        <div class="meta">${h(c.subject ?? '')}${c.quarter ? ' · ' + c.quarter + ' четверть' : ''} · учеников: ${c.students.length} · ${h(c.source)}</div></div>
      <button class="btn small ghost" data-act="remove" title="Убрать класс">✕</button>
      <div class="ctl">
        <label>Колонка <select data-act="assess">${opts}</select></label>
        <label>Разбаловка <select data-act="preset">${presetOptions(cs.presetId, true)}</select></label>
        <label>Дата проведения <span class="row"><input type="date" data-act="dateHeld" value="${toIso(c.dateHeld)}" /><button class="btn small ghost" type="button" data-act="journal-date" title="взять дату СОР из журнала">из журнала</button></span></label>
        <label>Внесено в emaktab <input type="date" data-act="dateEntered" value="${toIso(c.dateEntered)}" /></label>
      </div>${warn}</div>`;
  }).join('');
}

/* ---------- рендер: пресеты и редактор структуры ---------- */

function renderPresetBar(): void {
  ($('preset-sel') as HTMLSelectElement).innerHTML = presetOptions(S().presetId, false);
  ($('preset-del') as HTMLButtonElement).disabled = S().presets.length <= 1;
  ($('preset-name') as HTMLInputElement).value = currentPreset().name;
}

function setStructure(st: Structure): void {
  normalizeStructure(st);
  const p = currentPreset();
  p.structure = cloneStructure(st);
  S().structure = cloneStructure(st);
  saveSettings();
}

function renderStructureView(): void {
  const s = S().structure;
  const total = structureMax(s);
  ($('s-structure') as HTMLInputElement).value = structureToText(s);
  $('s-structure-view').innerHTML = s.tasks.map((t, i) => `<span class="task">${h(taskHeader(t, i).split('\n')[0])}${t.parts.length ? ' = ' + t.parts.map((p) => `<span class="part">${p.max}</span>`).join('') : ''}</span>`).join('')
    + `<span class="sum ${total === 50 || total === 40 ? '' : 'bad'}">итого ${total} баллов</span>`;
}

function renderStructureEditor(): void {
  const s = S().structure;
  const cards = s.tasks.map((t, ti) => {
    const parts = t.parts.map((p, pi) => `<div class="part-chip" data-t="${ti}" data-p="${pi}">
        <span class="idx">Критерий ${ti + 1}.${pi + 1}</span>
        <input type="text" data-f="plabel" value="${h(p.label ?? '')}" placeholder="название (в шапку)" />
        <input type="number" data-f="pmax" min="0" value="${p.max}" title="Баллы" />
        <input type="number" data-f="ptarget" min="0" max="100" value="${p.target ?? ''}" placeholder="100%" title="Целевой процент выполнения (для раскидки «по целям»)" />
        <button class="x" type="button" data-act="del-part" title="Убрать критерий">✕</button>
      </div>`).join('');
    return `<div class="task-card" data-t="${ti}">
      <div class="task-head">
        <b>Задание ${ti + 1}</b><span class="task-sum" data-k="tsum">${pointsLabel(taskMax(t))}</span>
        <span class="sp"></span>
        <button class="mini" type="button" data-act="up" title="Выше" ${ti === 0 ? 'disabled' : ''}>↑</button>
        <button class="mini" type="button" data-act="down" title="Ниже" ${ti === s.tasks.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="mini danger" type="button" data-act="del-task" ${s.tasks.length <= 1 ? 'disabled' : ''}>Удалить</button>
      </div>
      <div class="task-head">
        <label class="task-title">Название в шапке (необязательно) <input type="text" data-f="title" value="${h(t.title ?? '')}" placeholder="например: Тест / Практическая работа" /></label>
        ${t.parts.length ? '' : `<label class="task-points">Баллы <input type="number" data-f="tmax" min="0" value="${t.max}" /></label><label class="task-points">Цель % <input type="number" data-f="ttarget" min="0" max="100" value="${t.target ?? ''}" placeholder="100" title="Целевой процент выполнения (для раскидки «по целям»)" /></label>`}
      </div>
      <div class="parts">${parts}<button class="mini" type="button" data-act="add-part">＋ критерий</button></div>
    </div>`;
  }).join('');
  const total = structureMax(s);
  $('struct-editor').innerHTML = `${cards}<div class="struct-total"><button class="mini" type="button" data-act="add-task">＋ задание</button><span>Итого: <b data-k="total">${total}</b> баллов</span><span class="${total === 50 || total === 40 ? 'ok' : 'bad'}" data-k="total-note">${total === 50 || total === 40 ? '✓' : 'обычно СОР = 50, СОЧ = 40'}</span></div>`;
}

/** Ввод в поле редактора: обновить данные без перерисовки карточек. */
function onStructInput(t: HTMLInputElement): void {
  const st = S().structure;
  const card = t.closest('.task-card') as HTMLElement | null;
  if (!card) return;
  const ti = Number(card.dataset.t);
  const task = st.tasks[ti]; if (!task) return;
  const f = t.dataset.f;
  if (f === 'title') task.title = t.value;
  else if (f === 'tmax') task.max = Math.max(0, Math.round(Number(t.value)) || 0);
  else if (f === 'ttarget') task.target = t.value.trim() === '' ? undefined : Math.min(100, Math.max(0, Number(t.value) || 0));
  else if (f === 'plabel' || f === 'pmax' || f === 'ptarget') {
    const pi = Number((t.closest('.part-chip') as HTMLElement).dataset.p);
    const part = task.parts[pi]; if (!part) return;
    if (f === 'plabel') part.label = t.value;
    else if (f === 'ptarget') part.target = t.value.trim() === '' ? undefined : Math.min(100, Math.max(0, Number(t.value) || 0));
    else part.max = Math.max(0, Math.round(Number(t.value)) || 0);
  }
  setStructure(st);
  card.querySelector('[data-k="tsum"]')!.textContent = pointsLabel(taskMax(S().structure.tasks[ti]));
  const total = structureMax(S().structure);
  $('struct-editor').querySelector('[data-k="total"]')!.textContent = String(total);
  const note = $('struct-editor').querySelector('[data-k="total-note"]')!;
  note.className = total === 50 || total === 40 ? 'ok' : 'bad';
  note.textContent = total === 50 || total === 40 ? '✓' : 'обычно СОР = 50, СОЧ = 40';
  renderStructureView();
  rebuild(); renderClasses(); renderLadder(); renderTabs(); renderPreview();
}

function onStructClick(btn: HTMLElement): void {
  const st = cloneStructure(S().structure);
  const act = btn.dataset.act;
  const card = btn.closest('.task-card') as HTMLElement | null;
  const ti = card ? Number(card.dataset.t) : -1;
  if (act === 'add-task') st.tasks.push({ title: '', parts: [], max: 5 });
  else if (act === 'del-task' && st.tasks.length > 1) st.tasks.splice(ti, 1);
  else if (act === 'up' && ti > 0) [st.tasks[ti - 1], st.tasks[ti]] = [st.tasks[ti], st.tasks[ti - 1]];
  else if (act === 'down' && ti < st.tasks.length - 1) [st.tasks[ti + 1], st.tasks[ti]] = [st.tasks[ti], st.tasks[ti + 1]];
  else if (act === 'add-part') {
    const t = st.tasks[ti];
    if (!t.parts.length) t.parts.push({ label: '', max: t.max });
    t.parts.push({ label: '', max: 5 });
  } else if (act === 'del-part') {
    const pi = Number((btn.closest('.part-chip') as HTMLElement).dataset.p);
    const t = st.tasks[ti];
    t.parts.splice(pi, 1);
    if (t.parts.length === 1) { t.max = t.parts[0].max; t.parts = []; }
  } else return;
  setStructure(st);
  rebuild(); render();
}

/* ---------- рендер: лестница баллов ---------- */

function ladderKeys(): { key: string; names: string[] }[] {
  const map = new Map<string, Set<string>>();
  const add = (key: string, name: string) => { if (!map.has(key)) map.set(key, new Set()); map.get(key)!.add(name); };
  add(structureToText(S().structure), `общая: ${currentPreset().name}`);
  for (const cs of state.classes) if (cs.presetId) add(structureTextFor(cs), `${cs.cls.className}: ${presetById(cs.presetId)?.name ?? ''}`);
  for (const p of S().presets) add(structureToText(p.structure), p.name);
  for (const k of Object.keys(S().ladders)) if (parseStructure(k)) add(k, 'сохранённая');
  return [...map.entries()].map(([key, names]) => ({ key, names: [...names] }));
}

function renderLadder(): void {
  const keys = ladderKeys();
  if (!keys.some((k) => k.key === state.ladderKey)) state.ladderKey = keys[0].key;
  const sel = $('ladder-key') as HTMLSelectElement;
  sel.innerHTML = keys.map((k) => `<option value="${h(k.key)}" ${k.key === state.ladderKey ? 'selected' : ''}>${h(k.names.slice(0, 2).join(', '))}: ${h(k.key)}${S().ladders[k.key] ? ' (правлена)' : ''}</option>`).join('');

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
  S().ladders[key] = copy;
  saveSettings();
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

const seriesName = (r: ClassReport, ci: number): string => columnName(r.tasks, r.columns[ci]);

/** Столбчатая диаграмма с накоплением, как в книге Excel. */
function renderChart(r: ClassReport): string {
  const rows = r.rows.filter((x) => !x.absent);
  if (!rows.length) return '';
  const W = 960, H = 320, padL = 34, padB = 84, padT = 14, padR = 8;
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
      const hgt = y(acc) - y(acc + v);
      svg += `<rect x="${x}" y="${y(acc + v)}" width="${bw - gap}" height="${hgt}" fill="${PALETTE[ci % PALETTE.length]}"><title>${h(row.name)} — ${h(seriesName(r, ci))}: ${v}</title></rect>`;
      if (hgt >= 11 && bw - gap >= 16) svg += `<text x="${x + (bw - gap) / 2}" y="${y(acc + v) + hgt / 2 + 3}" font-size="8" text-anchor="middle" fill="#fff">${v}</text>`;
      acc += v;
    });
    if (S().chartIncludeTotal) svg += `<text x="${x + (bw - gap) / 2}" y="${y(acc) - 3}" font-size="9" font-weight="600" text-anchor="middle" fill="#1b2430">${acc}</text>`;
    const short = row.name.split(' ')[0] + (row.name.split(' ')[1] ? ` ${row.name.split(' ')[1][0]}.` : '');
    svg += `<text transform="translate(${x + (bw - gap) / 2},${H - padB + 8}) rotate(-55)" font-size="9" text-anchor="end" fill="#5d6b7a">${h(short)}</text>`;
  });
  const legend = r.columns.map((_, ci) => `<span><i style="background:${PALETTE[ci % PALETTE.length]}"></i>${h(seriesName(r, ci))}</span>`).join('');
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
  const own = cs.presetId ? presetById(cs.presetId) : undefined;
  const info = `<div class="info">Разбаловка класса: <b>${h(own ? own.name : currentPreset().name)}</b> · ${h(structureToText(structureFor(cs)))}${own ? ' (своя для этого класса — меняется в списке классов)' : ' (общая)'}</div>`;

  const extra = r.absentColumns ? `<th rowspan="2">Причина отсутствия</th><th rowspan="2">Дата сдачи ${r.kind}а</th>` : '';
  let head1 = '', head2 = '';
  r.tasks.forEach((t, ti) => {
    const cols = r.columns.filter((c) => c.taskIndex === ti);
    if (!t.parts.length) head1 += `<th rowspan="2">${br(taskHeader(t, ti))}</th>`;
    else { head1 += `<th colspan="${cols.length}">${br(taskHeader(t, ti))}</th>`; head2 += cols.map((c) => `<th>${br(c.header)}</th>`).join(''); }
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
  const variant = S().variantLabel.trim() || (r.absentColumns ? '2' : '1');

  box.innerHTML = `${mismatch}${info}${renderStats(r)}<div class="sheet">
    <div class="title-row"><p class="title">${h(r.title)}</p><span class="variant" title="Цифра варианта формы">${h(variant)}</span></div>
    <div class="hdr"><b>Участвовали: ${r.participants}</b><span>дата проведение ${r.kind}: ${h(r.date ?? '')}</span>
      <b>Отсутствовали: ${r.absent}</b><span>Дата внесения в emaktab.uz: ${h(r.dateEntered ?? '')}</span>
      ${r.absentNames.length ? `<span class="absent">Без балла: ${h(r.absentNames.join(', '))}</span>` : ''}</div>
    <table class="rep"><thead>
      <tr><th rowspan="2">№</th><th rowspan="2">Фамилия имя ученика</th>${extra}${head1}<th rowspan="2">Общий балл</th><th rowspan="2">В%</th><th rowspan="2">Оценивание</th></tr>
      <tr>${head2}</tr></thead>
      <tbody>${body}</tbody><tfoot>${footEl.innerHTML}</tfoot></table>
    <p class="sign">Фамилия учителя-предметника: ${h(r.teacherShort)}__________________ &nbsp;&nbsp;&nbsp; Подпись ________</p>
    ${S().noteText.trim() ? `<div class="note">${S().noteText.trim().split('\n').map((l, i) => (i === 0 ? `<b>${h(l)}</b>` : `<div>${h(l)}</div>`)).join('')}</div>` : ''}
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

/* ---------- распознавание по фото ---------- */

let aiResult: RecognizeResult | null = null;
let aiAbort: AbortController | null = null; // текущий запрос к API
let aiPreviewUrl = '';

function cancelRecognition(): void {
  if (aiAbort) { aiAbort.abort(); aiAbort = null; }
}

function bindPhoto(): void {
  const dlg = $('photo-dlg') as HTMLDialogElement;
  const key = $('ai-key') as HTMLInputElement, fileI = $('ai-file') as HTMLInputElement, status = $('ai-status');
  const runBtn = $('ai-run') as HTMLButtonElement;
  try { key.value = localStorage.getItem(LS_KEY) ?? ''; } catch { /* ignore */ }
  $('photo-btn').addEventListener('click', () => { dlg.showModal(); });
  $('ai-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => { // закрытие (кнопка или Esc) снимает запрос
    if (aiAbort) { cancelRecognition(); status.textContent = ''; status.className = 'ai-status'; }
    runBtn.disabled = false;
  });
  key.addEventListener('change', () => { try { localStorage.setItem(LS_KEY, key.value.trim()); } catch { /* ignore */ } });
  fileI.addEventListener('change', () => {
    cancelRecognition(); runBtn.disabled = false;
    const f = fileI.files?.[0];
    if (aiPreviewUrl) { URL.revokeObjectURL(aiPreviewUrl); aiPreviewUrl = ''; }
    if (f) aiPreviewUrl = URL.createObjectURL(f);
    $('ai-preview').innerHTML = f ? `<img src="${aiPreviewUrl}" alt="фото разбаловки" />` : '';
    $('ai-results').innerHTML = ''; aiResult = null; ($('ai-apply') as HTMLButtonElement).disabled = true;
    status.textContent = ''; status.className = 'ai-status';
  });
  runBtn.addEventListener('click', async () => {
    const f = fileI.files?.[0];
    const apiKey = key.value.trim();
    status.className = 'ai-status';
    if (!apiKey) { status.textContent = 'Введите ключ API.'; status.classList.add('err'); return; }
    if (!f) { status.textContent = 'Выберите фотографию.'; status.classList.add('err'); return; }
    cancelRecognition();
    const ctl = new AbortController();
    aiAbort = ctl;
    runBtn.disabled = true; status.textContent = 'Распознаю… обычно 15–40 секунд.';
    try {
      const mod = await import('./vision/recognize.ts');
      const res = await mod.recognizeLadderPhoto(f, { apiKey, model: ($('ai-model') as HTMLSelectElement).value, signal: ctl.signal });
      if (ctl.signal.aborted || aiAbort !== ctl) return; // диалог закрыли или сменили фото — результат устарел
      aiResult = res;
      renderAiResults(res);
      status.textContent = res.classes.length ? `Найдено блоков: ${res.classes.length}. Проверьте и примените.` : 'Модель не нашла на фото разбаловки.';
      if (res.warnings.length) status.textContent += ' ' + res.warnings.join(' ');
    } catch (e) {
      if (ctl.signal.aborted || aiAbort !== ctl) return;
      status.textContent = (e as Error).message || 'Ошибка распознавания';
      status.classList.add('err');
    } finally {
      if (aiAbort === ctl) { aiAbort = null; runBtn.disabled = false; }
    }
  });
  $('ai-apply').addEventListener('click', () => {
    if (!aiResult) return;
    const s = S();
    let firstId = '';
    aiResult.classes.forEach((c, i) => {
      const box = $('ai-results').querySelector(`[data-i="${i}"]`) as HTMLElement | null;
      if (!box || !(box.querySelector('input[type="checkbox"]') as HTMLInputElement).checked) return;
      const st = parseStructure(c.structureText);
      if (!st) return;
      st.tasks.forEach((t, ti) => { t.title = c.titles?.[ti] ?? ''; });
      const name = (box.querySelector('input[type="text"]') as HTMLInputElement).value.trim() || c.label || `С фото ${i + 1}`;
      const preset: Preset = { id: newPresetId(), name, structure: st };
      s.presets.push(preset);
      if (!firstId) firstId = preset.id;
      // лестница: правило + строки с фото поверх; промежуточные баллы достраиваются между строками с фото
      const maxes = flattenColumns(st).map((x) => x.max);
      let rows = generateLadder(maxes);
      const known = new Set<number>();
      for (const row of c.ladder) {
        const okShape = row.scores.length === maxes.length && Number.isInteger(row.total) && row.total >= 0 && row.total < rows.length;
        const okCells = row.scores.every((v, i) => Number.isInteger(v) && v >= 0 && v <= maxes[i]);
        if (okShape && okCells && row.scores.reduce((a, b) => a + b, 0) === row.total) { rows[row.total] = row.scores.slice(); known.add(row.total); }
      }
      if (known.size) { rows = fillLadderGaps(rows, known, maxes); s.ladders[structureToText(st)] = rows; }
    });
    if (firstId) { s.presetId = firstId; s.structure = cloneStructure(presetById(firstId)!.structure); }
    saveSettings();
    dlg.close();
    rebuild(); render();
  });
}

function renderAiResults(res: RecognizeResult): void {
  $('ai-results').innerHTML = res.classes.map((c, i) => {
    const st = parseStructure(c.structureText);
    const rows = c.ladder.slice().sort((a, b) => b.total - a.total).map((r) => `${String(r.total).padStart(2)} = ${r.scores.join(' ')}`).join('\n');
    return `<div class="ai-res" data-i="${i}">
      <label class="t"><input type="checkbox" checked /> <input type="text" value="${h(c.label || `С фото ${i + 1}`)}" placeholder="название разбаловки" /></label>
      <div>Разбаловка: <b>${h(c.structureText)}</b>${st ? ` · итого ${structureMax(st)} баллов` : ' · <span class="w">не разобрана</span>'}</div>
      <div class="ladder-mini">${h(rows) || '(строк лестницы нет)'}</div>
      ${c.warnings?.length ? `<div class="w">${h(c.warnings.join(' '))}</div>` : ''}
    </div>`;
  }).join('');
  ($('ai-apply') as HTMLButtonElement).disabled = !res.classes.length;
}

/* ---------- настройки ---------- */

function bindSettings(): void {
  const s = S();
  const set = (id: string, v: string | number | boolean) => {
    const el = $(id) as HTMLInputElement;
    if (typeof v === 'boolean') el.checked = v; else el.value = String(v);
  };
  set('s-school', s.school); set('s-kind', s.kind); set('s-number', s.number); set('s-teacher', s.teacherShort);
  set('s-year', s.year); set('s-strategy', s.strategy); set('s-seed', s.seed);
  set('s-t5', Math.round(s.thresholds.five * 100)); set('s-t4', Math.round(s.thresholds.four * 100)); set('s-t3', Math.round(s.thresholds.three * 100));
  set('s-absent', s.includeAbsent); set('s-absentcols', s.absentColumns); set('s-dates', s.showDates); set('s-charttotal', s.chartIncludeTotal);
  set('s-variant', s.variantLabel); set('s-note', s.noteText);

  const apply = () => {
    const v = (id: string) => ($(id) as HTMLInputElement).value;
    const b = (id: string) => ($(id) as HTMLInputElement).checked;
    s.school = v('s-school').trim(); s.kind = v('s-kind') as Settings['kind']; s.number = Math.max(1, Number(v('s-number')) || 1);
    s.teacherShort = v('s-teacher').trim(); s.year = v('s-year').trim();
    s.strategy = v('s-strategy') as Settings['strategy']; s.seed = Number(v('s-seed')) || 0;
    s.thresholds = { five: Number(v('s-t5')) / 100, four: Number(v('s-t4')) / 100, three: Number(v('s-t3')) / 100 };
    s.includeAbsent = b('s-absent'); s.absentColumns = b('s-absentcols'); s.showDates = b('s-dates'); s.chartIncludeTotal = b('s-charttotal');
    s.variantLabel = v('s-variant').trim(); s.noteText = v('s-note');
    saveSettings();
    rebuild();
    render();
  };
  $('sec-settings').addEventListener('change', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('#ladder-box') || t.closest('#struct-editor') || t.closest('.preset-bar') || t.id === 's-structure') return;
    apply();
  });

  // быстрый ввод
  $('s-structure').addEventListener('change', () => {
    const st = structureFromText(($('s-structure') as HTMLInputElement).value, S().structure);
    if (!st) { renderStructureView(); return; }
    setStructure(st); rebuild(); render();
  });

  // пресеты
  $('preset-sel').addEventListener('change', () => {
    const id = ($('preset-sel') as HTMLSelectElement).value;
    if (!presetById(id)) return;
    S().presetId = id; S().structure = cloneStructure(presetById(id)!.structure);
    saveSettings(); rebuild(); render();
  });
  $('preset-new').addEventListener('click', () => {
    const p: Preset = { id: newPresetId(), name: `Разбаловка ${S().presets.length + 1}`, structure: parseStructure('5; 5+5+20+10; 5')! };
    S().presets.push(p); S().presetId = p.id; S().structure = cloneStructure(p.structure);
    saveSettings(); rebuild(); render();
  });
  $('preset-dup').addEventListener('click', () => {
    const cur = currentPreset();
    const p: Preset = { id: newPresetId(), name: `${cur.name} (копия)`, structure: cloneStructure(cur.structure) };
    S().presets.push(p); S().presetId = p.id; S().structure = cloneStructure(p.structure);
    saveSettings(); rebuild(); render();
  });
  $('preset-name').addEventListener('change', () => { // переименование прямо в поле
    const name = ($('preset-name') as HTMLInputElement).value.trim();
    if (!name) { ($('preset-name') as HTMLInputElement).value = currentPreset().name; return; }
    currentPreset().name = name; saveSettings(); render();
  });
  $('preset-del').addEventListener('click', () => {
    const s2 = S();
    if (s2.presets.length <= 1) return;
    const cur = currentPreset();
    if (!confirm(`Удалить разбаловку «${cur.name}»?`)) return;
    s2.presets = s2.presets.filter((p) => p.id !== cur.id);
    for (const cs of state.classes) if (cs.presetId === cur.id) cs.presetId = '';
    s2.presetId = s2.presets[0].id; s2.structure = cloneStructure(s2.presets[0].structure);
    saveSettings(); rebuild(); render();
  });

  // редактор структуры
  $('struct-editor').addEventListener('input', (e) => { const t = e.target as HTMLInputElement; if (t.matches('input[data-f]')) onStructInput(t); });
  $('struct-editor').addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest('button[data-act]') as HTMLElement | null; if (b) onStructClick(b); });

  $('s-reseed').addEventListener('click', () => { ($('s-seed') as HTMLInputElement).value = String(Math.floor(Math.random() * 1e6)); apply(); });

  $('ladder-key').addEventListener('change', () => { state.ladderKey = ($('ladder-key') as HTMLSelectElement).value; renderLadder(); });
  $('ladder-reset').addEventListener('click', () => {
    if (S().ladders[state.ladderKey] && !confirm('Убрать правки и построить лестницу заново по правилу?')) return;
    delete S().ladders[state.ladderKey]; saveSettings(); rebuild(); render();
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
    if (t.dataset.act === 'preset') cs.presetId = t.value;
    if (t.dataset.act === 'dateHeld') cs.cls.dateHeld = fromIso(t.value) || undefined;
    if (t.dataset.act === 'dateEntered') cs.cls.dateEntered = fromIso(t.value) || undefined;
    rebuild(i); state.active = i;
    if (t.dataset.act === 'dateHeld' || t.dataset.act === 'dateEntered') { renderTabs(); renderPreview(); return; } // не перерисовывать карточку — не терять фокус
    render();
  });
  $('classes').addEventListener('click', (e) => {
    const jd = (e.target as HTMLElement).closest('[data-act="journal-date"]');
    if (jd) {
      const i = Number(jd.closest('.cls')?.getAttribute('data-i'));
      const cs = state.classes[i]; if (!cs) return;
      const a = cs.cls.assessments.find((x) => x.id === cs.cls.selectedAssessment) ?? cs.cls.assessments[0];
      const d = fullDate(a?.date, cs.cls.year || S().year);
      if (!d) { alert('В журнале нет даты для этой колонки.'); return; }
      cs.cls.dateHeld = d; rebuild(i); state.active = i; render(); return;
    }
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
    download(await exportWorkbook(reports, S()), fileNameFor(reports, S()));
  });
  $('dl-one').addEventListener('click', async () => {
    const r = state.classes[state.active]?.report; if (!r) return;
    download(await exportWorkbook([r], S()), fileNameFor([r], S()).replace('.xlsx', ` ${r.sheetName}.xlsx`));
  });
  $('reshuffle').addEventListener('click', () => {
    const s = S();
    if (s.strategy !== 'random') { ($('s-strategy') as HTMLSelectElement).value = 'random'; s.strategy = 'random'; }
    s.seed = Math.floor(Math.random() * 1e6); ($('s-seed') as HTMLInputElement).value = String(s.seed);
    saveSettings(); rebuild(); render();
  });
  $('print').addEventListener('click', () => window.print());
}

function render(): void {
  renderClasses(); renderPresetBar(); renderStructureView(); renderStructureEditor(); renderLadder(); renderTabs(); renderPreview();
}

bindSettings();
bindPhoto();
bindEvents();
render();
