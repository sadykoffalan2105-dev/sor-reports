import './style.css';
import { parseWorkbook, parseManualList, shortTeacherName } from './parse/journal.ts';
import { buildReport, recalcRow, recalcSummary, fullDate } from './core/report.ts';
import {
  parseStructure, structureFromText, structureToText, structureMax, flattenColumns, taskHeader, taskMax,
  cloneStructure, normalizeStructure, newPresetId, builtinPresets, columnName, bandRanges, bandLabel, bandIndex,
} from './core/structure.ts';
import { generateLadder, ladderErrors, ladderFits, fillLadderGaps, type Ladder } from './core/ladder.ts';
import type { RecognizeResult } from './vision/recognize.ts'; // только тип — модуль грузится лениво
import { DEFAULT_LAYOUT, LAYOUT_PRESETS, mergeLayout } from './core/layout.ts';
import { exportWorkbook, fileNameFor } from './export/xlsx.ts';
import type { ClassReport, JournalClass, Preset, ReportRow, ScoreColumn, Settings, Structure } from './core/types.ts';

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
    strategy: 'ladder', seed: 7, spread: 1,
    thresholds: { five: 0.86, four: 0.66, three: 0.3 },
    includeAbsent: false, absentColumns: false, showDates: false, chartIncludeTotal: true,
    fontName: 'Aptos Narrow',
    variantLabel: '', noteText: NOTE_DEFAULT,
    ladders: {}, ladderRows: {},
    layout: mergeLayout(DEFAULT_LAYOUT, {}),
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
      const s: Settings = { ...d, ...j, thresholds: { ...d.thresholds, ...(j.thresholds ?? {}) }, ladders: j.ladders ?? {}, layout: mergeLayout(DEFAULT_LAYOUT, j.layout) };
      s.ladderRows = j.ladderRows ?? {};
      migrateLadders(s);
      if (!Array.isArray(s.presets) || !s.presets.length) { s.presets = d.presets; s.presetId = d.presetId; }
      if (!s.presets.some((p) => p.id === s.presetId)) s.presetId = s.presets[0].id;
      s.structure = cloneStructure(s.presets.find((p) => p.id === s.presetId)!.structure);
      return s;
    }
    const old = localStorage.getItem(LS_OLD);
    if (old) { // перенос из прежней версии: разбаловка → пресет «Моя разбаловка»
      const j = JSON.parse(old) as Partial<Settings>;
      const s: Settings = { ...d, ...j, presets: d.presets, presetId: d.presetId, thresholds: { ...d.thresholds, ...(j.thresholds ?? {}) }, ladders: j.ladders ?? {}, variantLabel: '', noteText: NOTE_DEFAULT };
      s.ladderRows = {}; migrateLadders(s);
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

const state = { classes: [] as ClassState[], settings: loadSettings(), active: 0, editGrade: '', ladderFull: false };

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
function ladderFor(text: string): { rows: Ladder; custom: boolean; maxes: number[]; known: Set<number> } {
  const st = parseStructure(text) ?? S().structure;
  const maxes = flattenColumns(st).map((c) => c.max);
  const max = maxes.reduce((a, b) => a + b, 0);
  let rows = generateLadder(maxes);
  const known = new Set<number>();
  for (const [k, sc] of Object.entries(S().ladderRows[text] ?? {})) {
    const t = Number(k);
    if (Number.isInteger(t) && t >= 0 && t <= max && Array.isArray(sc) && sc.length === maxes.length) { rows[t] = sc.slice(); known.add(t); }
  }
  if (known.size) rows = fillLadderGaps(rows, known, maxes);
  return { rows, custom: known.size > 0, maxes, known };
}

/** Старые полные лестницы → строки, отличающиеся от правила. */
function migrateLadders(s: Settings): void {
  for (const [key, full] of Object.entries(s.ladders ?? {})) {
    const st = parseStructure(key); if (!st) continue;
    const maxes = flattenColumns(st).map((c) => c.max);
    if (!ladderFits(full, maxes)) continue;
    const auto = generateLadder(maxes);
    const m: Record<string, number[]> = s.ladderRows[key] ?? {};
    full.forEach((r, t) => { if (auto[t].some((v, i) => v !== r[i])) m[String(t)] = r.slice(); });
    if (Object.keys(m).length) s.ladderRows[key] = m;
  }
  s.ladders = {};
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

/** Разбаловка по параллелям: одна настройка на все 5-е, 6-е … классы. */
function renderGrades(): void {
  const box = $('grades');
  const grades = [...new Set(state.classes.map((cs) => cs.cls.className.match(/^\d+/)?.[0]).filter((g): g is string => !!g))].sort((a, b) => Number(a) - Number(b));
  if (grades.length < 1 || state.classes.length < 2) { box.innerHTML = ''; return; }
  box.innerHTML = grades.map((g) => {
    const members = state.classes.filter((cs) => cs.cls.className.startsWith(g + '-') || cs.cls.className === g);
    const ids = new Set(members.map((cs) => cs.presetId));
    const cur = ids.size === 1 ? [...ids][0] : '';
    return `<div class="grade" data-g="${g}"><b>${g}-е классы</b><span class="muted">(${members.map((m) => m.cls.className).join(', ')})</span>
      <select data-act="grade-preset">${ids.size > 1 ? '<option value="" selected>разные…</option>' : ''}${presetOptions(cur, true)}</select>
      <button class="btn small ghost" type="button" data-act="grade-own" title="Создать копию общей разбаловки для этой параллели">＋ своя</button></div>`;
  }).join('');
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

/** Классы параллели («6» → все 6-е). */
function gradeClasses(g: string): ClassState[] { return state.classes.filter((cs) => cs.cls.className.startsWith(g + '-') || cs.cls.className === g); }
function gradesList(): string[] {
  return [...new Set(state.classes.map((cs) => cs.cls.className.match(/^\d+/)?.[0]).filter((g): g is string => !!g))].sort((a, b) => Number(a) - Number(b));
}
/** Пресет параллели, если все её классы используют один свой пресет. */
function gradePreset(g: string): Preset | undefined {
  const ids = new Set(gradeClasses(g).map((cs) => cs.presetId));
  return ids.size === 1 ? presetById([...ids][0]) : undefined;
}
/** Пресет, который сейчас редактируется: своей параллели или общий. */
function editingPreset(): Preset { return (state.editGrade && gradePreset(state.editGrade)) || currentPreset(); }
function editingStructure(): Structure { return editingPreset().structure; }
function assignToGrade(g: string, presetId: string): void { for (const cs of gradeClasses(g)) cs.presetId = presetId; }

/** Вкладки над редактором: «Общая» и параллели. */
function renderEditTabs(): void {
  const grades = gradesList();
  if (!grades.length) { state.editGrade = ''; $('edit-tabs').innerHTML = ''; return; }
  if (state.editGrade && !grades.includes(state.editGrade)) state.editGrade = '';
  const tab = (g: string, label: string, hint: string) => `<button class="tab ${g === state.editGrade ? 'active' : ''}" type="button" data-g="${g}" title="${h(hint)}">${h(label)}</button>`;
  $('edit-tabs').innerHTML = tab('', 'Общая', 'Общая разбаловка для классов без своей')
    + grades.map((g) => { const p = gradePreset(g); return tab(g, `${g}-е${p ? '' : ' · общая'}`, p ? `Своя: ${p.name}` : 'Используют общую разбаловку'); }).join('')
    + (state.editGrade && !gradePreset(state.editGrade) ? `<button class="btn small accent" type="button" data-act="own-for-grade">＋ своя для ${state.editGrade}-х</button>` : '');
}

function renderPresetBar(): void {
  const p = editingPreset();
  ($('preset-sel') as HTMLSelectElement).innerHTML = presetOptions(p.id, false);
  ($('preset-del') as HTMLButtonElement).disabled = S().presets.length <= 1;
  ($('preset-name') as HTMLInputElement).value = p.name;
  ($('s-bands') as HTMLSelectElement).value = String(p.structure.bands || 0);
  const own = state.editGrade ? gradePreset(state.editGrade) : undefined;
  $('edit-hint').textContent = state.editGrade
    ? (own ? `${state.editGrade}-е классы: правится их разбаловка «${own.name}»` : `${state.editGrade}-е классы используют общую разбаловку — правки ниже меняют общую`)
    : 'Общая разбаловка — для всех классов без своей';
}

function setStructure(st: Structure): void {
  normalizeStructure(st);
  const p = editingPreset();
  p.structure = cloneStructure(st);
  if (p.id === S().presetId) S().structure = cloneStructure(st);
  saveSettings();
}

function renderStructureView(): void {
  const s = editingStructure();
  const total = structureMax(s);
  ($('s-structure') as HTMLInputElement).value = structureToText(s);
  $('s-structure-view').innerHTML = s.tasks.map((t, i) => `<span class="task">${h(taskHeader(t, i).split('\n')[0])}${t.parts.length ? ' = ' + t.parts.map((p) => `<span class="part">${p.max}</span>`).join('') : ''}</span>`).join('')
    + `<span class="sum ${total === 50 || total === 40 ? '' : 'bad'}">итого ${total} баллов</span>`
    + ((s.bands ?? 0) > 1 ? `<span class="sum">· уровни под критериями: ${s.bands} (${bandRanges(5, s.bands!).map(bandLabel).join(', ')} для 5 баллов)</span>` : '');
}

/** Таблица заданий: строка — задание, ячейки — критерии (баллы, название, цель %). */
function renderStructureEditor(): void {
  const s = editingStructure();
  const rows = s.tasks.map((t, ti) => {
    const parts = t.parts.map((p, pi) => `<div class="part-cell" data-t="${ti}" data-p="${pi}">
        <input type="number" data-f="pmax" min="0" value="${p.max}" title="Баллы критерия ${ti + 1}.${pi + 1} (Enter — следующий критерий)" />
        <button class="x" type="button" data-act="del-part" title="Убрать критерий">✕</button>
        <input type="text" data-f="plabel" value="${h(p.label ?? '')}" placeholder="название" title="Название критерия в шапке" />
        <input type="number" data-f="ptarget" min="0" max="100" value="${p.target ?? ''}" placeholder="цель %" title="Целевой % для раскидки «по целям»" />
      </div>`).join('');
    return `<tr class="task-row" data-t="${ti}">
      <td class="n">${ti + 1}</td>
      <td class="ttl"><input type="text" data-f="title" value="${h(t.title ?? '')}" placeholder="название в шапке (необязательно)" /></td>
      <td class="parts-cell"><div class="parts">${parts}<button class="mini" type="button" data-act="add-part" title="Добавить критерий">＋ критерий</button></div></td>
      <td class="n">${t.parts.length ? `<b data-k="tsum">${taskMax(t)}</b>` : `<input type="number" data-f="tmax" min="0" value="${t.max}" title="Баллы задания" />`}</td>
      <td class="n">${t.parts.length ? '' : `<input type="number" data-f="ttarget" min="0" max="100" value="${t.target ?? ''}" placeholder="100" title="Целевой %" />`}</td>
      <td class="ops"><button class="mini" type="button" data-act="up" ${ti === 0 ? 'disabled' : ''} title="Выше">↑</button><button class="mini" type="button" data-act="down" ${ti === s.tasks.length - 1 ? 'disabled' : ''} title="Ниже">↓</button><button class="mini danger" type="button" data-act="del-task" ${s.tasks.length <= 1 ? 'disabled' : ''} title="Удалить задание">✕</button></td>
    </tr>`;
  }).join('');
  const total = structureMax(s);
  const ok = total === 50 || total === 40;
  $('struct-editor').innerHTML = `<table class="st"><thead><tr><th>№</th><th>Название в шапке</th><th>Критерии: баллы · название · цель %</th><th>Баллы</th><th>Цель %</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="3"><button class="mini" type="button" data-act="add-task">＋ задание</button></td><td class="n"><b data-k="total">${total}</b></td><td colspan="2" class="${ok ? 'ok' : 'bad'}" data-k="total-note">${ok ? '✓ итого' : 'обычно СОР = 50, СОЧ = 40'}</td></tr></tfoot></table>`;
}

/** Ввод в поле редактора: обновить данные без перерисовки таблицы. */
function onStructInput(t: HTMLInputElement): void {
  const st = cloneStructure(editingStructure());
  const tr = t.closest('tr.task-row') as HTMLElement | null;
  if (!tr) return;
  const ti = Number(tr.dataset.t);
  const task = st.tasks[ti]; if (!task) return;
  const f = t.dataset.f;
  const num = (v: string) => Math.max(0, Math.round(Number(v)) || 0);
  const pctv = (v: string) => (v.trim() === '' ? undefined : Math.min(100, Math.max(0, Number(v) || 0)));
  if (f === 'title') task.title = t.value;
  else if (f === 'tmax') task.max = num(t.value);
  else if (f === 'ttarget') task.target = pctv(t.value);
  else if (f === 'plabel' || f === 'pmax' || f === 'ptarget') {
    const pi = Number((t.closest('.part-cell') as HTMLElement).dataset.p);
    const part = task.parts[pi]; if (!part) return;
    if (f === 'plabel') part.label = t.value; else if (f === 'ptarget') part.target = pctv(t.value); else part.max = num(t.value);
  } else return;
  setStructure(st);
  const cur = editingStructure();
  const sum = tr.querySelector('[data-k="tsum"]'); if (sum) sum.textContent = String(taskMax(cur.tasks[ti]));
  const total = structureMax(cur); const ok = total === 50 || total === 40;
  const ed = $('struct-editor');
  ed.querySelector('[data-k="total"]')!.textContent = String(total);
  const note = ed.querySelector('[data-k="total-note"]')!;
  note.className = ok ? 'ok' : 'bad'; note.textContent = ok ? '✓ итого' : 'обычно СОР = 50, СОЧ = 40';
  renderStructureView();
  rebuild(); renderEditTabs(); renderClasses(); renderLadder(); renderTabs(); renderPreview();
}

function onStructClick(btn: HTMLElement): void {
  const st = cloneStructure(editingStructure());
  const act = btn.dataset.act;
  const tr = btn.closest('tr.task-row') as HTMLElement | null;
  const ti = tr ? Number(tr.dataset.t) : -1;
  if (act === 'add-task') st.tasks.push({ title: '', parts: [], max: 5 });
  else if (act === 'del-task' && st.tasks.length > 1) st.tasks.splice(ti, 1);
  else if (act === 'up' && ti > 0) [st.tasks[ti - 1], st.tasks[ti]] = [st.tasks[ti], st.tasks[ti - 1]];
  else if (act === 'down' && ti < st.tasks.length - 1) [st.tasks[ti + 1], st.tasks[ti]] = [st.tasks[ti], st.tasks[ti + 1]];
  else if (act === 'add-part') {
    const t = st.tasks[ti];
    if (!t.parts.length) t.parts.push({ label: '', max: t.max });
    t.parts.push({ label: '', max: 5 });
  } else if (act === 'del-part') {
    const pi = Number((btn.closest('.part-cell') as HTMLElement).dataset.p);
    const t = st.tasks[ti];
    t.parts.splice(pi, 1);
    if (t.parts.length === 1) { t.max = t.parts[0].max; t.parts = []; }
  } else return;
  setStructure(st);
  rebuild(); render();
}

/* ---------- рендер: раскладка по итоговому баллу ---------- */

/** Ключ раскладки — разбаловка, открытая в редакторе (вкладка параллели или общая). */
function ladderKey(): string { return structureToText(editingStructure()); }

function setKnownRow(key: string, t: number, scores: number[]): void {
  const m = S().ladderRows[key] ?? (S().ladderRows[key] = {});
  m[String(t)] = scores.slice();
  saveSettings();
}

function ladderHead(key: string): string {
  const st = parseStructure(key)!;
  const cols = flattenColumns(st);
  return `<tr><th class="tot">Балл</th>${cols.map((c) => `<th title="${h(taskHeader(st.tasks[c.taskIndex], c.taskIndex))}">${c.partIndex < 0 ? `${c.taskIndex + 1} зд` : `${c.taskIndex + 1}.${c.partIndex + 1}`}<br><small>${c.max}</small></th>`).join('')}<th>Σ</th><th></th></tr>`;
}

/** Строки учителя (компактно) + статус. */
function renderLadderRows(): void {
  const key = ladderKey();
  const { rows, maxes, known } = ladderFor(key);
  const max = rows.length - 1;
  const bad = new Set(ladderErrors(rows, maxes));
  $('ladder-status').textContent = known.size ? `${key} · ваших строк: ${known.size}${bad.size ? `, с ошибкой: ${bad.size}` : ''}` : `${key} · по правилу учителя`;
  const body = [...known].sort((x, y) => y - x).map((t) => {
    const r = rows[t]; const sum = r.reduce((x, y) => x + y, 0);
    return `<tr data-t="${t}" class="${bad.has(t) ? 'bad' : ''}"><th class="tot"><input type="number" min="0" max="${max}" value="${t}" data-tot="${t}" title="Общий балл" /></th>${r.map((v, i) => `<td><input type="number" min="0" max="${maxes[i]}" value="${v}" data-c="${i}" /></td>`).join('')}<td class="sum">${sum}</td><td><button class="x" type="button" data-act="del-row" title="Убрать строку">✕</button></td></tr>`;
  }).join('');
  $('ladder-rows').innerHTML = known.size
    ? `<table class="ladder-t lad"><thead>${ladderHead(key)}</thead><tbody>${body}</tbody></table>`
    : '<div class="empty">Своих строк пока нет: баллы раскладываются по правилу учителя. Нажмите «＋ строка» и впишите, как у вас на бумаге, или «Заполнить чётные».</div>';
  ($('ladder-full') as HTMLButtonElement).textContent = state.ladderFull ? 'Скрыть полную таблицу' : 'Полная таблица';
}

/** Полная таблица всех баллов (по кнопке); ваши строки отмечены точкой. */
function renderFullLadder(): void {
  const box = $('ladder');
  if (!state.ladderFull) { box.hidden = true; box.innerHTML = ''; return; }
  const key = ladderKey();
  const { rows, maxes, known } = ladderFor(key);
  const bad = new Set(ladderErrors(rows, maxes));
  let body = '';
  for (let t = rows.length - 1; t >= 0; t--) {
    const r = rows[t];
    body += `<tr data-t="${t}" class="${bad.has(t) ? 'bad' : ''} ${known.has(t) ? 'edited' : ''}"><th class="tot">${t}</th>${r.map((v, i) => `<td><input type="number" min="0" max="${maxes[i]}" value="${v}" data-c="${i}" /></td>`).join('')}<td class="sum">${r.reduce((x, y) => x + y, 0)}</td><td></td></tr>`;
  }
  box.hidden = false;
  box.innerHTML = `<table class="ladder-t"><thead>${ladderHead(key)}</thead><tbody>${body}</tbody></table>`;
}

function renderLadder(): void { renderLadderRows(); renderFullLadder(); }

/** Правка ячейки в полной таблице: строка становится «вашей». */
function onLadderEdit(input: HTMLInputElement): void {
  const key = ladderKey();
  const { rows, maxes } = ladderFor(key);
  const tr = input.closest('tr')!;
  const t = Number(tr.getAttribute('data-t'));
  const row = rows[t].slice();
  row[Number(input.dataset.c)] = Math.max(0, Math.round(Number(input.value)) || 0);
  setKnownRow(key, t, row);
  const sum = row.reduce((a, b) => a + b, 0);
  tr.querySelector('.sum')!.textContent = String(sum);
  tr.classList.toggle('bad', sum !== t || row.some((x, i) => x < 0 || x > maxes[i]));
  tr.classList.add('edited');
  renderLadderRows();
  rebuild(); renderTabs(); renderPreview();
}

/* ---------- рендер: предпросмотр ---------- */

function renderTabs(): void {
  $('tabs').innerHTML = state.classes.map((cs, i) =>
    `<button class="tab ${i === state.active ? 'active' : ''}" data-i="${i}">${h(cs.cls.className)}${cs.cls.group === 'девочки' ? ' Д' : ''}</button>`).join('');
}

function renderFootInto(el: HTMLElement, r: ClassReport): void {
  const lead = r.absentColumns ? '<td></td><td></td>' : '';
  const Ly = r.layout;
  const k = Math.max(1, r.bands || 1);
  const rows: string[] = [];
  if (Ly.showAvg) rows.push(`<tr><td></td><td class="lbl">Сред.балл:</td>${lead}${r.avg.map((a) => `<td colspan="${k}">${fix(a)}</td>`).join('')}<td>${fix(r.avgTotal)}</td><td>${pct(r.max ? r.avgTotal / r.max : 0)}</td><td></td></tr>`);
  if (Ly.showPct) rows.push(`<tr><td></td><td class="lbl">Процентный показатель</td>${lead}${r.avg.map((a, i) => `<td colspan="${k}">${pct(r.columns[i].max ? a / r.columns[i].max : 0)}</td>`).join('')}<td>${pct(r.max ? r.avgTotal / r.max : 0)}</td><td></td><td></td></tr>`);
  if (Ly.showCounts) rows.push(`<tr><td></td><td class="lbl">Количество - “5”</td>${lead}<td>${r.count5}</td><td colspan="${r.columns.length * k + 2}"></td></tr>
    <tr><td></td><td class="lbl">Количество - “4”</td>${lead}<td>${r.count4}</td><td colspan="${r.columns.length * k + 2}"></td></tr>`);
  if (Ly.showEff) rows.push(`<tr><td></td><td class="lbl eff">Эффективность знаний</td>${lead}<td colspan="${r.columns.length * k + 1}"></td><td class="eff">${pct(r.efficiency)}</td><td></td></tr>`);
  el.innerHTML = rows.join('');
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

  const Ly = r.layout;
  const extra = r.absentColumns ? `<th rowspan="2">Причина отсутствия</th><th rowspan="2">Дата сдачи ${r.kind}а</th>` : '';
  const k = Math.max(1, r.bands || 1);
  const hs = k > 1 ? 3 : 2; // строк в шапке
  let head1 = '', head2 = '', head3 = '';
  const bandHead = (c: ScoreColumn) => (k > 1 ? bandRanges(c.max, k).map((b) => `<th class="vert">${h(bandLabel(b))}</th>`).join('') : '');
  r.tasks.forEach((t, ti) => {
    const cols = r.columns.filter((c) => c.taskIndex === ti);
    if (!t.parts.length) { head1 += `<th rowspan="${k > 1 ? 2 : hs}" colspan="${k}">${br(taskHeader(t, ti))}</th>`; head3 += bandHead(cols[0]); }
    else { head1 += `<th colspan="${cols.length * k}">${br(taskHeader(t, ti))}</th>`; head2 += cols.map((c) => `<th colspan="${k}">${br(c.header)}</th>`).join(''); head3 += cols.map(bandHead).join(''); }
  });
  const REASONS = ['', 'Б', 'П', 'Н', 'У'];
  const reasonCells = (row: ReportRow) => r.absentColumns
    ? `<td><select data-act="reason" data-s="${row.studentIndex}" title="Причина отсутствия: Б — болел, П — пропуск, Н — не был, У — уважительная">${REASONS.map((x) => `<option value="${x}" ${x === (row.reason ?? '') ? 'selected' : ''}>${x || '—'}</option>`).join('')}</select></td><td><input type="date" data-act="retake" data-s="${row.studentIndex}" value="${toIso(row.retake)}" title="Дата сдачи" /></td>`
    : '';
  const del = (row: ReportRow) => `<td class="delc"><button class="del" type="button" data-act="del-student" data-s="${row.studentIndex}" title="Убрать ученика из отчёта">✕</button></td>`;
  const body = r.rows.map((row, ri) => {
    if (row.absent) {
      const who = r.group === 'девочки' ? 'отсутствовала' : 'отсутствовал';
      return `<tr class="abs" data-r="${ri}"><td>${row.n}</td><td class="name">${h(row.name)}</td>${reasonCells(row)}<td colspan="${r.columns.length * k + 3}">${who} · балл вручную: <input type="number" min="0" max="${r.max}" data-act="manual" data-s="${row.studentIndex}" placeholder="—" /></td>${del(row)}</tr>`;
    }
    const cells = row.scores.map((v, ci) => {
      const inp = `<input type="number" min="0" max="${r.columns[ci].max}" value="${v}" data-r="${ri}" data-c="${ci}" />`;
      if (k <= 1) return `<td>${inp}</td>`;
      const bi = bandIndex(v, r.columns[ci].max, k);
      return Array.from({ length: k }, (_, j) => (j === bi ? `<td class="band">${inp}</td>` : '<td class="band"></td>')).join('');
    }).join('');
    return `<tr data-r="${ri}" class="${row.reason ? 'retake' : ''}"><td>${row.n}</td><td class="name">${h(row.name)}</td>${reasonCells(row)}${cells}<td data-k="total">${row.total}</td><td data-k="pct">${pct(row.percent)}</td><td data-k="grade">${row.grade}</td>${del(row)}</tr>`;
  }).join('');
  const footEl = document.createElement('tfoot');
  renderFootInto(footEl, r);
  const variant = S().variantLabel.trim() || (r.absentColumns ? '1/2' : '1');

  box.innerHTML = `${mismatch}${info}${renderStats(r)}<div class="sheet">
    ${Ly.showTitle ? `<div class="title-row"><p class="title">${h(r.title)}</p>${Ly.showVariant ? `<span class="variant" title="Цифра варианта формы">${h(variant)}</span>` : ''}</div>` : ''}
    ${Ly.showInfo ? `<div class="hdr"><b>Участвовали: ${r.participants}</b><span>дата проведение ${r.kind}: ${h(r.date ?? '')}</span>
      <b>Отсутствовали: ${r.absent}</b><span>Дата внесения в emaktab.uz: ${h(r.dateEntered ?? '')}</span>
      ${r.absentNames.length ? `<span class="absent">Без балла: ${h(r.absentNames.join(', '))}</span>` : ''}</div>` : ''}
    <table class="rep"><thead>
      <tr><th rowspan="${hs}">№</th><th rowspan="${hs}">${h(Ly.labels.name)}</th>${extra.replace(/rowspan="2"/g, `rowspan="${hs}"`)}${head1}<th rowspan="${hs}">${h(Ly.labels.total)}</th><th rowspan="${hs}">${h(Ly.labels.percent)}</th><th rowspan="${hs}">${h(Ly.labels.grade)}</th><th rowspan="${hs}" class="delc"></th></tr>
      <tr>${head2}</tr>${k > 1 ? `<tr>${head3}</tr>` : ''}</thead>
      <tbody>${body}</tbody><tfoot>${footEl.innerHTML}</tfoot></table>
    ${Ly.showSignature ? `<p class="sign">${h(Ly.labels.signature)} ${h(r.teacherShort)}__________________ &nbsp;&nbsp;&nbsp; Подпись ________</p>` : ''}
    ${Ly.showNote && S().noteText.trim() ? `<div class="note">${S().noteText.trim().split('\n').map((l, i) => (i === 0 ? `<b>${h(l)}</b>` : `<div>${h(l)}</div>`)).join('')}</div>` : ''}
  </div>${Ly.showChart ? renderChart(r) : ''}`;
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
      const rows = generateLadder(maxes);
      const known = new Set<number>();
      for (const row of c.ladder) {
        const okShape = row.scores.length === maxes.length && Number.isInteger(row.total) && row.total >= 0 && row.total < rows.length;
        const okCells = row.scores.every((v, i) => Number.isInteger(v) && v >= 0 && v <= maxes[i]);
        if (okShape && okCells && row.scores.reduce((a, b) => a + b, 0) === row.total) { rows[row.total] = row.scores.slice(); known.add(row.total); }
      }
      if (known.size) { const m: Record<string, number[]> = {}; for (const t of known) m[String(t)] = rows[t].slice(); s.ladderRows[structureToText(st)] = m; }
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
  set('s-year', s.year); set('s-strategy', s.strategy); set('s-seed', s.seed); set('s-spread', s.spread ?? 1);
  set('s-t5', Math.round(s.thresholds.five * 100)); set('s-t4', Math.round(s.thresholds.four * 100)); set('s-t3', Math.round(s.thresholds.three * 100));
  set('s-absent', s.includeAbsent); set('s-absentcols', s.absentColumns); set('s-dates', s.showDates); set('s-charttotal', s.chartIncludeTotal);
  set('s-variant', s.variantLabel); set('s-note', s.noteText);
  const setLayoutFields = () => {
    const l = s.layout;
    for (const k of ['showTitle', 'showVariant', 'showInfo', 'showAvg', 'showPct', 'showCounts', 'showEff', 'showSignature', 'showNote', 'showChart'] as const) ($('l-' + k) as HTMLInputElement).checked = l[k];
    set('l-title', l.titleTemplate); set('l-chart-title', l.chartTitleTemplate);
    set('l-name', l.labels.name); set('l-total', l.labels.total); set('l-percent', l.labels.percent); set('l-grade', l.labels.grade); set('l-signature', l.labels.signature);
  };
  ($('l-preset') as HTMLSelectElement).innerHTML = '<option value="">выбрать…</option>' + LAYOUT_PRESETS.map((p, i) => `<option value="${i}">${h(p.name)}</option>`).join('');
  setLayoutFields();
  $('l-preset').addEventListener('change', () => {
    const i = Number(($('l-preset') as HTMLSelectElement).value);
    if (!Number.isInteger(i) || !LAYOUT_PRESETS[i]) return;
    s.layout = mergeLayout(DEFAULT_LAYOUT, LAYOUT_PRESETS[i].patch); setLayoutFields(); ($('l-preset') as HTMLSelectElement).value = '';
    saveSettings(); rebuild(); render();
  });
  $('l-reset').addEventListener('click', () => { s.layout = mergeLayout(DEFAULT_LAYOUT, {}); setLayoutFields(); saveSettings(); rebuild(); render(); });

  const apply = () => {
    const v = (id: string) => ($(id) as HTMLInputElement).value;
    const b = (id: string) => ($(id) as HTMLInputElement).checked;
    s.school = v('s-school').trim(); s.kind = v('s-kind') as Settings['kind']; s.number = Math.max(1, Number(v('s-number')) || 1);
    s.teacherShort = v('s-teacher').trim(); s.year = v('s-year').trim();
    s.strategy = v('s-strategy') as Settings['strategy']; s.seed = Number(v('s-seed')) || 0; s.spread = Math.max(0, Math.min(5, Number(v('s-spread')) || 0));
    s.thresholds = { five: Number(v('s-t5')) / 100, four: Number(v('s-t4')) / 100, three: Number(v('s-t3')) / 100 };
    s.includeAbsent = b('s-absent'); s.absentColumns = b('s-absentcols'); s.showDates = b('s-dates'); s.chartIncludeTotal = b('s-charttotal');
    s.variantLabel = v('s-variant').trim(); s.noteText = v('s-note');
    s.layout = {
      ...s.layout,
      showTitle: b('l-showTitle'), showVariant: b('l-showVariant'), showInfo: b('l-showInfo'), showAvg: b('l-showAvg'), showPct: b('l-showPct'),
      showCounts: b('l-showCounts'), showEff: b('l-showEff'), showSignature: b('l-showSignature'), showNote: b('l-showNote'), showChart: b('l-showChart'),
      titleTemplate: v('l-title').trim() || DEFAULT_LAYOUT.titleTemplate, chartTitleTemplate: v('l-chart-title').trim() || DEFAULT_LAYOUT.chartTitleTemplate,
      labels: { name: v('l-name').trim() || DEFAULT_LAYOUT.labels.name, total: v('l-total').trim() || DEFAULT_LAYOUT.labels.total, percent: v('l-percent').trim() || DEFAULT_LAYOUT.labels.percent, grade: v('l-grade').trim() || DEFAULT_LAYOUT.labels.grade, signature: v('l-signature').trim() },
    };
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
    const st = structureFromText(($('s-structure') as HTMLInputElement).value, editingStructure());
    if (!st) { renderStructureView(); return; }
    setStructure(st); rebuild(); render();
  });

  // вкладки параллелей над редактором
  $('edit-tabs').addEventListener('click', (e) => {
    const own = (e.target as HTMLElement).closest('[data-act="own-for-grade"]');
    if (own && state.editGrade) {
      const base = editingPreset();
      const p: Preset = { id: newPresetId(), name: `${state.editGrade} класс — своя`, structure: cloneStructure(base.structure) };
      S().presets.push(p); assignToGrade(state.editGrade, p.id); saveSettings(); rebuild(); render(); return;
    }
    const t = (e.target as HTMLElement).closest('.tab[data-g]') as HTMLElement | null; if (!t) return;
    state.editGrade = t.dataset.g ?? ''; render();
  });

  // пресеты (в режиме параллели — назначаются её классам, иначе — общая)
  const useNewPreset = (p: Preset) => {
    S().presets.push(p);
    if (state.editGrade) assignToGrade(state.editGrade, p.id); else { S().presetId = p.id; S().structure = cloneStructure(p.structure); }
    saveSettings(); rebuild(); render();
  };
  $('preset-sel').addEventListener('change', () => {
    const id = ($('preset-sel') as HTMLSelectElement).value; const p = presetById(id); if (!p) return;
    if (state.editGrade) assignToGrade(state.editGrade, id === S().presetId ? '' : id);
    else { S().presetId = id; S().structure = cloneStructure(p.structure); }
    saveSettings(); rebuild(); render();
  });
  $('preset-new').addEventListener('click', () => useNewPreset({ id: newPresetId(), name: state.editGrade ? `${state.editGrade} класс — новая` : `Разбаловка ${S().presets.length + 1}`, structure: parseStructure('5; 5+5+20+10; 5')! }));
  $('preset-dup').addEventListener('click', () => { const cur = editingPreset(); useNewPreset({ id: newPresetId(), name: `${cur.name} (копия)`, structure: cloneStructure(cur.structure) }); });
  $('preset-name').addEventListener('change', () => { // переименование прямо в поле
    const name = ($('preset-name') as HTMLInputElement).value.trim();
    if (!name) { ($('preset-name') as HTMLInputElement).value = editingPreset().name; return; }
    editingPreset().name = name; saveSettings(); render();
  });
  $('preset-del').addEventListener('click', () => {
    const s2 = S();
    if (s2.presets.length <= 1) return;
    const cur = editingPreset();
    if (!confirm(`Удалить разбаловку «${cur.name}»?`)) return;
    s2.presets = s2.presets.filter((p) => p.id !== cur.id);
    for (const cs of state.classes) if (cs.presetId === cur.id) cs.presetId = '';
    if (!presetById(s2.presetId)) s2.presetId = s2.presets[0].id;
    s2.structure = cloneStructure(presetById(s2.presetId)!.structure);
    saveSettings(); rebuild(); render();
  });

  // редактор структуры
  $('struct-editor').addEventListener('input', (e) => { const t = e.target as HTMLInputElement; if (t.matches('input[data-f]')) onStructInput(t); });
  $('struct-editor').addEventListener('change', (e) => { // быстрый ввод критериев одного задания
    const t = e.target as HTMLInputElement; if (!t.matches('input[data-f="tquick"]')) return;
    const st = cloneStructure(S().structure);
    const ti = Number((t.closest('tr.task-row') as HTMLElement).dataset.t);
    const task = st.tasks[ti]; if (!task) return;
    const nums = t.value.split(/[+\s,;/]+/).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
    if (!nums.length) { renderStructureEditor(); return; }
    if (nums.length === 1) { task.max = nums[0]; task.parts = []; }
    else task.parts = nums.map((n, i) => ({ label: task.parts[i]?.label ?? '', target: task.parts[i]?.target, max: n }));
    setStructure(st); rebuild(); render();
  });
  $('struct-editor').addEventListener('keydown', (e) => { // Enter в баллах критерия — добавить следующий
    const t = e.target as HTMLInputElement;
    if (e.key !== 'Enter' || !t.matches('input[data-f="pmax"]')) return;
    e.preventDefault();
    const card = t.closest('tr.task-row') as HTMLElement;
    const btn = card.querySelector('button[data-act="add-part"]') as HTMLElement | null;
    if (!btn) return;
    onStructClick(btn);
    const inputs = document.querySelectorAll(`tr.task-row[data-t="${card.dataset.t}"] input[data-f="pmax"]`);
    (inputs[inputs.length - 1] as HTMLInputElement | undefined)?.focus();
  });
  $('struct-editor').addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest('button[data-act]') as HTMLElement | null; if (b) onStructClick(b); });

  $('s-bands').addEventListener('change', () => {
    const st = cloneStructure(editingStructure());
    const n = Number(($('s-bands') as HTMLSelectElement).value) || 0;
    st.bands = n > 1 ? n : undefined;
    setStructure(st); rebuild(); render();
  });
  $('s-reseed').addEventListener('click', () => { ($('s-seed') as HTMLInputElement).value = String(Math.floor(Math.random() * 1e6)); apply(); });

  // раскладка по итоговому баллу
  $('ladder-rows').addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement; if (!t.matches('input[data-c]')) return;
    const tr = t.closest('tr') as HTMLElement; const key = ladderKey(); const total = Number(tr.dataset.t);
    const { rows, maxes } = ladderFor(key);
    const row = rows[total].slice(); row[Number(t.dataset.c)] = Math.max(0, Math.round(Number(t.value)) || 0);
    setKnownRow(key, total, row);
    const sum = row.reduce((x, y) => x + y, 0);
    tr.querySelector('.sum')!.textContent = String(sum);
    tr.classList.toggle('bad', sum !== total || row.some((x, i) => x > maxes[i]));
    rebuild(); renderTabs(); renderPreview(); renderFullLadder();
  });
  $('ladder-rows').addEventListener('change', (e) => { // смена общего балла строки
    const t = e.target as HTMLInputElement; if (!t.matches('input[data-tot]')) return;
    const key = ladderKey(); const from = Number(t.dataset.tot); const to = Math.round(Number(t.value));
    const m = S().ladderRows[key] ?? {}; const { rows } = ladderFor(key);
    if (!Number.isInteger(to) || to < 0 || to >= rows.length || (to !== from && m[String(to)])) { renderLadder(); return; }
    const row = m[String(from)] ?? rows[from]; delete m[String(from)]; m[String(to)] = row; S().ladderRows[key] = m;
    saveSettings(); rebuild(); render();
  });
  $('ladder-rows').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button[data-act="del-row"]'); if (!b) return;
    const key = ladderKey(); const t = Number((b.closest('tr') as HTMLElement).dataset.t);
    delete S().ladderRows[key]?.[String(t)]; saveSettings(); rebuild(); render();
  });
  $('ladder-add').addEventListener('click', () => {
    const key = ladderKey(); const { rows, known } = ladderFor(key);
    const max = rows.length - 1;
    let t = known.size ? Math.min(...known) - 2 : max;
    while (t >= 0 && known.has(t)) t--;
    if (t < 0) return;
    setKnownRow(key, t, rows[t]); rebuild(); render();
    (document.querySelector(`#ladder-rows tr[data-t="${t}"] input[data-c="0"]`) as HTMLInputElement | null)?.focus();
  });
  $('ladder-even').addEventListener('click', () => {
    const key = ladderKey(); const { rows, known } = ladderFor(key); const max = rows.length - 1;
    for (let t = max; t >= Math.max(0, max - 20); t -= 2) if (!known.has(t)) setKnownRow(key, t, rows[t]);
    rebuild(); render();
  });
  $('ladder-full').addEventListener('click', () => { state.ladderFull = !state.ladderFull; renderLadder(); });
  $('ladder-reset').addEventListener('click', () => {
    const key = ladderKey();
    if (S().ladderRows[key] && !confirm('Убрать свои строки и вернуть правило учителя?')) return;
    delete S().ladderRows[key]; saveSettings(); rebuild(); render();
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
  $('grades').addEventListener('change', (e) => {
    const t = e.target as HTMLSelectElement; if (t.dataset.act !== 'grade-preset') return;
    const g = (t.closest('.grade') as HTMLElement).dataset.g!;
    for (const cs of state.classes) if (cs.cls.className.startsWith(g + '-') || cs.cls.className === g) cs.presetId = t.value;
    rebuild(); render();
  });
  $('grades').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-act="grade-own"]'); if (!b) return;
    const g = (b.closest('.grade') as HTMLElement).dataset.g!;
    const base = currentPreset();
    const p: Preset = { id: newPresetId(), name: `${g} класс — своя`, structure: cloneStructure(base.structure) };
    S().presets.push(p);
    for (const cs of state.classes) if (cs.cls.className.startsWith(g + '-') || cs.cls.className === g) cs.presetId = p.id;
    S().presetId = p.id; S().structure = cloneStructure(p.structure); // сразу открыть её в редакторе
    saveSettings(); rebuild(); render();
    $('struct-editor').scrollIntoView({ block: 'start', behavior: 'smooth' });
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
  $('preview').addEventListener('change', (e) => { // причина, дата сдачи, ручной балл
    const t = e.target as HTMLInputElement;
    if (t.matches('input[data-r]')) { if ((state.classes[state.active]?.report?.bands ?? 1) > 1) renderPreview(); return; }
    const act = t.dataset.act; if (!act || t.dataset.s == null) return;
    const cs = state.classes[state.active]; if (!cs) return;
    const st = cs.cls.students[Number(t.dataset.s)]; if (!st) return;
    if (act === 'reason') st.reason = t.value || undefined;
    else if (act === 'retake') st.retake = fromIso(t.value) || undefined;
    else if (act === 'manual') { const v = Number(t.value); st.manualScore = t.value.trim() === '' || !Number.isFinite(v) ? null : Math.max(0, Math.min(cs.report?.max ?? 50, v)); }
    else return;
    rebuild(state.active); renderPreview();
  });
  $('preview').addEventListener('click', (e) => { // убрать ученика
    const b = (e.target as HTMLElement).closest('button[data-act="del-student"]') as HTMLElement | null; if (!b) return;
    const cs = state.classes[state.active]; if (!cs) return;
    const si = Number(b.dataset.s); const st = cs.cls.students[si]; if (!st) return;
    if (!confirm(`Убрать ${st.name} из отчёта?`)) return;
    cs.cls.students.splice(si, 1);
    for (const a of cs.cls.assessments) a.scores.splice(si, 1);
    cs.cls.students.forEach((x, i) => { x.n = i + 1; });
    rebuild(state.active); render();
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
  renderGrades(); renderClasses(); renderEditTabs(); renderPresetBar(); renderStructureView(); renderStructureEditor(); renderLadder(); renderTabs(); renderPreview();
}

bindSettings();
bindPhoto();
bindEvents();
render();
