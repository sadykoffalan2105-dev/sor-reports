/**
 * Голосовой ввод баллов с бумажных работ: «фамилия + баллы по критериям» или по порядку списка.
 * Движки — engine.ts (офлайн Vosk или браузерный), разбор фраз — parse.ts.
 * Правило безопасности: если прозвучала фамилия, а уверенного совпадения нет — ничего не записываем.
 */
import type { ClassReport, JournalClass, Student } from '../core/types.ts';
import { parsePhrase, interpret, findStudent, nameWords, nameKey, normalize, wordsToDigits, sayNumbers, type Parsed, type Aliases } from './parse.ts';
import { VoskEngine, WebSpeechEngine, beep, voskAvailable, webSpeechAvailable, isApp, type Engine, type EngineKind } from './engine.ts';

export interface VoiceHost {
  ctx(): { cls: JournalClass; report: ClassReport | null } | null;
  refresh(): void;
  switchClass(delta: number): string;
  download(): void;
  print(): void;
  columnNames(report: ClassReport): string[];
  paperMode(): boolean;
}

const LS = 'sor-reports.voice2';
interface Prefs { engine: EngineKind; lang: string; mode: 'criteria' | 'total'; speak: boolean; sound: boolean }
const defaultEngine = (): EngineKind => (voskAvailable() && (isApp() || !webSpeechAvailable()) ? 'vosk' : voskAvailable() ? 'vosk' : 'web');
const loadPrefs = (): Prefs => {
  const d: Prefs = { engine: defaultEngine(), lang: 'ru-RU', mode: 'criteria', speak: false, sound: true };
  try { return { ...d, ...(JSON.parse(localStorage.getItem(LS) ?? '{}') as Partial<Prefs>) }; } catch { return d; }
};
/** Выученные произношения имён (на этом устройстве): ключ услышанного → имя ученика. */
const LSA = 'sor-reports.voice-names';
const simKeys = (a: string, b: string): number => {
  if (!a || !b) return 0;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - d[a.length][b.length] / Math.max(a.length, b.length);
};
const loadAliases = (): Aliases => { try { return JSON.parse(localStorage.getItem(LSA) ?? '{}') as Aliases; } catch { return {}; } };
const h = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Snapshot { cls: JournalClass; si: number; manualScores?: (number | null)[]; manualScore?: number | null; forceAbsent?: boolean; cursor: number }
type Plan = { ok: true; run: () => void } | { ok: false; error: string };

export function initVoice(host: VoiceHost) {
  const prefs = loadPrefs();
  const savePrefs = () => { try { localStorage.setItem(LS, JSON.stringify(prefs)); } catch { /* ignore */ } };
  let engine: Engine | null = null;
  let listening = false;
  let si = 0, cursor = 0, clsId = '';
  let lastMsg = '', interim = '';
  const history: Snapshot[] = [];
  const aliases = loadAliases();
  const saveAliases = () => { try { localStorage.setItem(LSA, JSON.stringify(aliases)); } catch { /* ignore */ } };
  let lastMiss: { key: string; heard: string; clsId: string; t: number } | null = null; // фамилия, которую не узнали
  let train: number | null = null; // «Выучить имена»: номер ученика, чьё имя ждём
  /** После «не узнал» учитель выбрал ученика (клик, «номер N», повтор фамилии) — запомнить, как прозвучало. */
  const learn = (cls: JournalClass, idx: number, sameAs?: string): string => {
    const m = lastMiss; lastMiss = null;
    if (!m || m.clsId !== cls.id || Date.now() - m.t > 30000 || !cls.students[idx]) return '';
    if (sameAs != null && simKeys(m.key, sameAs) < 0.5) return ''; // сказали другого ученика
    aliases[m.key] = normalize(cls.students[idx].name); saveAliases();
    return ` · запомнил: «${h(m.heard)}» = ${h(cls.students[idx].name.split(' ')[0])}`;
  };

  /* ---------- панель ---------- */
  const bar = document.createElement('div');
  bar.id = 'voice-bar';
  bar.className = 'voice-bar';
  bar.hidden = true;
  bar.innerHTML = `
    <div class="vb-row">
      <button class="vb-mic" type="button" id="vb-mic" title="Включить / выключить микрофон">🎤</button>
      <div class="vb-main">
        <div class="vb-who" id="vb-who"></div>
        <div class="vb-cells" id="vb-cells"></div>
        <div class="vb-heard" id="vb-heard"></div>
        <div class="vb-progress" id="vb-progress" hidden><i></i></div>
      </div>
      <div class="vb-ctl">
        <div class="vb-nav"><button class="mini" type="button" id="vb-prev" title="Предыдущий ученик («назад»)">◀</button><button class="mini" type="button" id="vb-next" title="Следующий ученик («дальше»)">▶</button><button class="mini" type="button" id="vb-undo" title="Отменить последнее («отмена»)">↶</button></div>
        <select id="vb-engine" title="Распознавание">
          <option value="vosk">офлайн — точно, без интернета</option>
          <option value="web">браузер — онлайн</option>
        </select>
        <button class="mini" type="button" id="vb-train" title="Прочитать список вслух один раз — программа запомнит, как звучит каждое имя">🎓 Выучить имена</button>
        <select id="vb-mode" title="Что вы диктуете"><option value="criteria">баллы по критериям</option><option value="total">только общий балл</option></select>
        <div class="vb-nav"><label class="vb-chk"><input type="checkbox" id="vb-sound" /> сигнал</label><label class="vb-chk"><input type="checkbox" id="vb-speak" /> озвучка</label></div>
        <div class="vb-nav"><button class="mini" type="button" id="vb-help" title="Как диктовать">?</button><button class="mini" type="button" id="vb-close" title="Закрыть">✕</button></div>
      </div>
    </div>
    <div class="vb-helpbox" id="vb-helpbox" hidden>
      <b>Как диктовать.</b> Возьмите работу и скажите <b>фамилию и баллы по критериям</b>: «Алимбаев пять пять пять десять десять пятнадцать». Можно без фамилии — тогда баллы идут текущему ученику (жёлтая строка), после полной строки программа переходит к следующему.
      Можно частями: «пять пять», потом «пять десять…». Одно число больше максимума первого критерия — общий балл («сорок шесть»), он разложится по раскладке; явно: «общий сорок шесть».
      <div class="vb-cmds">
        <span><b>дальше / назад</b> — другой ученик</span><span><b>номер пять</b> — пятый по списку</span>
        <span><b>Цой отсутствует</b> — нет на работе</span><span><b>все на максимум</b> — остальные критерии полные</span>
        <span><b>исправь четыре восемнадцать</b> — 4-й критерий = 18</span><span><b>сначала</b> — с первого критерия</span>
        <span><b>отмена</b> — вернуть как было</span><span><b>повтори</b> — прочитать строку</span>
        <span><b>следующий класс</b>, <b>скачать</b>, <b>печать</b>, <b>стоп</b></span>
      </div>
      <b>Распознавание.</b> «Офлайн» работает в любом браузере и в приложении, без интернета; модель 46 МБ скачивается один раз. «Браузер» — встроенный сервис Chrome/Edge/Яндекса, нужен интернет.
      Если фамилия не узнана, балл <b>не записывается</b> — скажите ещё раз или нажмите на строку ученика в таблице: программа <b>запомнит</b>, как прозвучало имя, и в следующий раз узнает сразу. Говорите числа раздельно; паузу делайте после всей строки.
      <b>Сложные имена.</b> Нажмите «🎓 Выучить имена» и прочитайте список: фамилию (и имя) каждого ученика — так, как вы произносите их на уроке. Хватает одного раза, запоминается на этом устройстве. <button class="mini" type="button" id="vb-forget">забыть выученные имена</button>
    </div>`;
  document.body.appendChild(bar);
  const $ = <T extends HTMLElement>(id: string) => bar.querySelector('#' + id) as T;
  ($('vb-engine') as HTMLSelectElement).value = prefs.engine;
  ($('vb-mode') as HTMLSelectElement).value = prefs.mode;
  ($('vb-speak') as HTMLInputElement).checked = prefs.speak;
  ($('vb-sound') as HTMLInputElement).checked = prefs.sound;
  if (!voskAvailable()) ($('vb-engine') as HTMLSelectElement).querySelector('option[value="vosk"]')!.setAttribute('disabled', '');
  if (!webSpeechAvailable()) ($('vb-engine') as HTMLSelectElement).querySelector('option[value="web"]')!.setAttribute('disabled', '');

  /* ---------- ученик ---------- */
  const syncClass = () => {
    const c = host.ctx();
    if (!c) return null;
    if (c.cls.id !== clsId) { clsId = c.cls.id; si = firstPending(c.cls); cursor = 0; engine?.setNames(c.cls.students.map((s) => s.name)); }
    si = Math.max(0, Math.min(si, c.cls.students.length - 1));
    return c;
  };
  const hasData = (st: Student) => !!st.forceAbsent || !!st.manualScores?.some((v) => v != null) || st.manualScore != null;
  const firstPending = (cls: JournalClass): number => { const i = cls.students.findIndex((st) => !hasData(st)); return i >= 0 ? i : 0; };
  const nextPending = (cls: JournalClass, from: number): number => {
    if (!host.paperMode()) return Math.min(cls.students.length - 1, from + 1);
    for (let k = from + 1; k < cls.students.length; k++) if (!hasData(cls.students[k])) return k;
    for (let k = 0; k < from; k++) if (!hasData(cls.students[k])) return k; // по кругу — пропущенные выше
    return Math.min(cls.students.length - 1, from + 1);
  };
  const rowOf = (report: ClassReport | null, idx: number) => report?.rows.find((r) => r.studentIndex === idx && !r.pending);
  const maxesOf = (report: ClassReport) => report.columns.map((c) => c.max);
  const snapshot = (cls: JournalClass, idx: number) => {
    const st = cls.students[idx];
    history.push({ cls, si: idx, manualScores: st.manualScores?.slice(), manualScore: st.manualScore, forceAbsent: st.forceAbsent, cursor });
    if (history.length > 200) history.shift();
  };
  /**
   * Баллы ученика, к которым дописываем: уже введённые; для «исправь» и «все на максимум» в режиме
   * раскидки — строка из таблицы; иначе — пустая строка (новая работа с бумаги).
   */
  const baseOf = (st: Student, idx: number, report: ClassReport, keepRow: boolean): (number | null)[] => {
    const n = report.columns.length;
    if (st.manualScores?.length === n) return st.manualScores.slice();
    if (keepRow && !host.paperMode()) { const row = rowOf(report, idx); if (row) return row.scores.slice(); }
    return Array.from({ length: n }, () => null);
  };

  /* ---------- отклик ---------- */
  const say = (text: string) => {
    if (!prefs.speak || !text || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ru-RU'; u.rate = 1.2;
    const v = speechSynthesis.getVoices().find((x) => x.lang.startsWith('ru'));
    if (v) u.voice = v;
    engine?.setPaused(true); // не слушать собственную озвучку
    const resume = () => setTimeout(() => engine?.setPaused(false), 150);
    u.onend = resume; u.onerror = resume;
    speechSynthesis.speak(u);
  };
  const signal = (kind: 'ok' | 'err' | 'next') => { if (prefs.sound) beep(kind); };

  /* ---------- отрисовка ---------- */
  const render = () => {
    const c = syncClass();
    document.querySelectorAll('.rep tr.voice-cur').forEach((tr) => tr.classList.remove('voice-cur'));
    $('vb-mic').classList.toggle('on', listening);
    $('vb-heard').innerHTML = interim ? `<span class="vb-interim">${h(interim)}…</span>` : lastMsg;
    if (!c || !c.report) { $('vb-who').innerHTML = 'Загрузите журнал, готовый отчёт или список класса — потом диктуйте баллы.'; $('vb-cells').innerHTML = ''; return; }
    const { cls, report } = c;
    const st = cls.students[si];
    const names = host.columnNames(report);
    const row = rowOf(report, si);
    const vals: (number | null)[] | undefined = st?.manualScores?.length === report.columns.length ? st.manualScores : row?.scores;
    const done = cls.students.filter(hasData).length;
    const tag = st?.forceAbsent ? '<span class="vb-tag">отсутствует</span>' : row && !row.incomplete ? `<span class="vb-tag ok">итого ${row.total}</span>` : row?.incomplete ? '<span class="vb-tag warn">не все критерии</span>' : '<span class="vb-tag">не введено</span>';
    $('vb-who').innerHTML = st
      ? `<b>${si + 1}. ${h(st.name)}</b> ${tag}<span class="vb-cls">${h(cls.className)} · введено ${done} из ${cls.students.length}</span>`
      : 'В классе нет учеников';
    $('vb-cells').innerHTML = names.map((n, k) => {
      const v = vals?.[k];
      return `<span class="vb-cell ${k === cursor && prefs.mode === 'criteria' ? 'cur' : ''} ${v != null && st?.manualScores ? 'set' : ''}"><small>${h(n)} · ${report.columns[k].max}</small><b>${v ?? '·'}</b></span>`;
    }).join('');
    const tr = document.querySelector(`.rep tr[data-s="${si}"]`) as HTMLElement | null;
    if (tr) { tr.classList.add('voice-cur'); if (!bar.hidden) tr.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  };
  let note = ''; // «запомнил …» — дописывается к следующему сообщению
  const show = (msg: string, kind: 'ok' | 'err' | 'info' = 'info') => { interim = ''; lastMsg = `<span class="vb-${kind}">${msg}${note}</span>`; note = ''; render(); };

  /* ---------- разбор фразы в действие (без изменений, пока не вызван run) ---------- */
  const plan = (p: Parsed, heard: string): Plan => {
    if (p.commands.includes('stop')) return { ok: true, run: () => { stopListening(); show('микрофон выключен'); } };
    if (p.commands.includes('download')) return { ok: true, run: () => { host.download(); show('скачиваю книгу Excel', 'ok'); signal('ok'); } };
    if (p.commands.includes('print')) return { ok: true, run: () => host.print() };
    if (p.commands.includes('nextClass') || p.commands.includes('prevClass')) {
      return { ok: true, run: () => { const name = host.switchClass(p.commands.includes('nextClass') ? 1 : -1); clsId = ''; syncClass(); show(name ? `класс ${h(name)}` : 'других классов нет', name ? 'ok' : 'err'); signal(name ? 'next' : 'err'); } };
    }
    const c = syncClass();
    if (!c || !c.report) return { ok: false, error: 'сначала загрузите журнал, отчёт или список класса' };
    const { cls, report } = c;
    const maxes = maxesOf(report);
    const names = host.columnNames(report);

    if (p.commands.includes('undo')) {
      return { ok: true, run: () => {
        const s = history.pop();
        if (!s) { show('нечего отменять', 'err'); signal('err'); return; }
        const st = s.cls.students[s.si];
        if (st) { st.manualScores = s.manualScores; st.manualScore = s.manualScore; st.forceAbsent = s.forceAbsent; }
        if (s.cls.id === cls.id) { si = s.si; cursor = s.cursor; }
        host.refresh(); show(`отменено: ${h(st?.name ?? '')}`, 'ok'); signal('ok'); say('отменено');
      } };
    }

    // кто: «номер N», фамилия или текущий
    let target = si, tcursor = cursor;
    if (p.commands.includes('goto') && p.nums.length) {
      const k = p.nums[0].value - 1;
      if (k < 0 || k >= cls.students.length) return { ok: false, error: `в списке ${cls.students.length} учеников` };
      return { ok: true, run: () => { si = k; cursor = 0; show(`→ ${k + 1}. ${h(cls.students[k].name)}${learn(cls, k)}`); signal('next'); say(cls.students[k].name.split(' ')[0]); } };
    }
    const nw = nameWords(heard);
    let learned = '';
    if (nw.length) {
      const who = findStudent(nw, cls.students.map((s) => s.name), aliases);
      if (who < 0) {
        if (!lastMiss || Date.now() - lastMiss.t > 1500) lastMiss = { key: nameKey(nw.join('')), heard: nw.join(' '), clsId: cls.id, t: Date.now() };
        return { ok: false, error: `не узнал ученика «${h(nw.join(' '))}» — скажите ещё раз или нажмите на его строку (запомню произношение)` };
      }
      if (lastMiss) learned = learn(cls, who, nameKey(nw.join('')));
      if (who !== si) { target = who; tcursor = 0; }
    }
    const nameWordsSaid = nw;
    const st: Student | undefined = cls.students[target];
    if (!st) return { ok: false, error: 'в классе нет учеников' };
    const go = (fn: () => void) => ({ ok: true as const, run: () => { si = target; cursor = tcursor; note = learned; fn(); } });

    if (p.commands.includes('repeat')) return go(() => {
      const row = rowOf(report, si);
      const txt = row ? `${st.name}: ${sayNumbers(row.scores)}. Итого ${row.total}` : `${st.name}: не введено`;
      show(h(txt)); prefs.speak ? say(txt) : signal('ok');
    });
    if (p.commands.includes('restart')) return go(() => { cursor = 0; show(`${h(st.name)}: заново с ${h(names[0])}`); signal('ok'); });
    if (p.commands.includes('absent')) return go(() => {
      snapshot(cls, si); st.forceAbsent = true; st.manualScores = undefined; st.manualScore = undefined;
      const nm = st.name; si = nextPending(cls, si); cursor = 0;
      host.refresh(); show(`${h(nm)} — отсутствует`, 'ok'); signal('next'); say(`${nm.split(' ')[0]}, отсутствует`);
    });
    if (p.commands.includes('fix')) {
      if (p.nums.length !== 2) return { ok: false, error: 'скажите: «исправь <номер критерия> <балл>»' };
      const k = p.nums[0].value - 1, v = p.nums[1].value;
      if (k < 0 || k >= maxes.length) return { ok: false, error: `критериев всего ${maxes.length}` };
      if (v > maxes[k]) return { ok: false, error: `${v} больше максимума ${maxes[k]} для ${names[k]}` };
      // «исправь» без фамилии — последнему продиктованному ученику этого класса
      const fi = nameWordsSaid.length ? target : ([...history].reverse().find((x) => x.cls.id === cls.id)?.si ?? target);
      const fst = cls.students[fi];
      return { ok: true, run: () => {
        snapshot(cls, fi);
        const base = baseOf(fst, fi, report, true); base[k] = v; fst.manualScores = base; fst.forceAbsent = false;
        host.refresh(); show(`${h(fst.name)}: ${h(names[k])} = ${v}`, 'ok'); signal('ok'); say(`${names[k]}, ${v}`);
      } };
    }
    if (p.commands.includes('full')) return go(() => {
      snapshot(cls, si);
      const base = baseOf(st, si, report, true);
      for (let k = cursor; k < maxes.length; k++) base[k] = maxes[k];
      st.manualScores = base; st.forceAbsent = false;
      const total = base.reduce<number>((a, b) => a + (b ?? 0), 0);
      const nm = st.name; si = nextPending(cls, si); cursor = 0;
      host.refresh(); show(`${h(nm)}: ${base.map((x) => x ?? '·').join(' ')} → <b>${total}</b>`, 'ok'); signal('next'); say(`итого ${total}`);
    });
    if (p.nums.length) {
      const it = interpret(p.nums, maxes, tcursor, prefs.mode, p.total, names);
      if (it.kind === 'error') return { ok: false, error: it.message };
      if (it.kind === 'total') return go(() => {
        snapshot(cls, si);
        st.manualScore = it.value; st.manualScores = undefined; st.forceAbsent = false;
        const nm = st.name; si = nextPending(cls, si); cursor = 0;
        host.refresh(); show(`${h(nm)}: общий ${it.value} — разложен по раскладке`, 'ok'); signal('next'); say(String(it.value));
      });
      return go(() => {
        snapshot(cls, si);
        const base = baseOf(st, si, report, false);
        it.values.forEach((v, j) => { base[it.start + j] = v; });
        st.manualScores = base; st.forceAbsent = false;
        cursor = it.start + it.values.length;
        const nm = st.name;
        if (cursor >= maxes.length || base.every((x) => x != null)) {
          const total = base.reduce<number>((a, b) => a + (b ?? 0), 0);
          si = nextPending(cls, si); cursor = 0;
          host.refresh(); show(`${h(nm)}: ${base.map((x) => x ?? '·').join(' ')} → <b>${total}</b>`, 'ok'); signal('next'); say(`${sayNumbers(it.values)}. Итого ${total}`);
        } else {
          host.refresh(); show(`${h(nm)}: ${it.values.join(' ')} · дальше ${h(names[cursor])}`, 'ok'); signal('ok'); say(sayNumbers(it.values));
        }
      });
    }
    if (p.commands.includes('next')) return { ok: true, run: () => { si = nextPending(cls, si); cursor = 0; show(`→ ${h(cls.students[si]?.name ?? '')}`); signal('next'); } };
    if (p.commands.includes('prev')) return { ok: true, run: () => { si = Math.max(0, si - 1); cursor = 0; show(`← ${h(cls.students[si]?.name ?? '')}`); signal('next'); } };
    if (target !== si || nameWordsSaid.length) return go(() => { show(`→ ${h(st.name)} — диктуйте баллы`); signal('next'); say(st.name.split(' ')[0]); });
    return { ok: false, error: `не понял «${h(heard)}»` };
  };

  /** Перебрать варианты распознавания: первый, который даёт понятное действие. */
  const trainShow = () => {
    const c = syncClass();
    if (!c || train == null) return;
    const st = c.cls.students[train];
    if (!st) { train = null; show(`имена выучены — ${Object.keys(aliases).length} произношений. Диктуйте баллы.`, 'ok'); signal('ok'); return; }
    si = train; cursor = 0;
    show(`🎓 Скажите: <b>${train + 1}. ${h(st.name)}</b> <small>(«дальше» — пропустить, «стоп» — закончить)</small>`);
  };
  const handleTrain = (alts: string[]) => {
    const c = syncClass(); if (!c || train == null) return;
    const p = parsePhrase(alts[0] ?? '');
    if (p.commands.includes('stop') || p.commands.includes('undo')) { train = null; show('обучение закончено', 'ok'); return; }
    if (p.commands.includes('next')) { train++; trainShow(); return; }
    const nw = nameWords(alts[0] ?? '');
    if (!nw.length) { show('не расслышал — скажите имя ещё раз', 'err'); signal('err'); return; }
    const names = c.cls.students.map((s) => s.name);
    const was = findStudent(nw, names, aliases);
    if (was !== train) { for (const a of alts.slice(0, 2)) { const w = nameWords(a); if (w.length) aliases[nameKey(w.join(''))] = normalize(names[train]); } saveAliases(); }
    signal('ok');
    lastMsg = `<span class="vb-ok">${h(names[train].split(' ')[0])}: ${was === train ? 'узнаю и так ✓' : `запомнил «${h(nw.join(' '))}»`}</span>`;
    train++; setTimeout(trainShow, 700); render();
  };
  const handle = (alts: string[]) => {
    if (train != null) { handleTrain(alts); return; }
    let firstErr = '';
    for (const alt of alts) {
      const p = parsePhrase(alt);
      if (!p.nums.length && !p.commands.length && !p.words.length) continue;
      const pl = plan(p, alt);
      if (pl.ok) { pl.run(); return; }
      firstErr ||= `«${h(alt)}»: ${pl.error}`;
    }
    if (firstErr) { show(firstErr, 'err'); signal('err'); if (prefs.speak) say('не понял'); }
  };

  /* ---------- микрофон ---------- */
  const startListening = async () => {
    if (listening) return;
    const kind: EngineKind = prefs.engine === 'web' && webSpeechAvailable() ? 'web' : voskAvailable() ? 'vosk' : 'web';
    engine = kind === 'vosk' ? new VoskEngine() : new WebSpeechEngine(prefs.lang);
    const c = syncClass(); if (c) engine.setNames(c.cls.students.map((s) => s.name));
    listening = true; render();
    const prog = $('vb-progress');
    await engine.start({
      final: (alts) => { interim = ''; handle(alts); },
      partial: (t) => { interim = t; $('vb-heard').innerHTML = `<span class="vb-interim">${h(t)}…</span>`; },
      status: (k, msg, p) => {
        if (k === 'loading') { prog.hidden = false; (prog.firstElementChild as HTMLElement).style.width = `${Math.round((p ?? 0) * 100)}%`; show(h(msg ?? '')); }
        else if (k === 'listening') { prog.hidden = true; show('слушаю — диктуйте: фамилия и баллы по критериям', 'ok'); }
        else if (k === 'error') { prog.hidden = true; listening = false; show(h(msg ?? 'ошибка'), 'err'); signal('err'); }
        else if (k === 'stopped') { prog.hidden = true; }
      },
    });
  };
  function stopListening() { listening = false; engine?.stop(); engine = null; render(); }

  /* ---------- кнопки ---------- */
  $('vb-mic').addEventListener('click', () => (listening ? stopListening() : void startListening()));
  $('vb-prev').addEventListener('click', () => handle(['назад']));
  $('vb-next').addEventListener('click', () => handle(['дальше']));
  $('vb-undo').addEventListener('click', () => handle(['отмена']));
  $('vb-engine').addEventListener('change', () => { prefs.engine = ($('vb-engine') as HTMLSelectElement).value as EngineKind; savePrefs(); if (listening) { stopListening(); void startListening(); } });
  $('vb-mode').addEventListener('change', () => { prefs.mode = ($('vb-mode') as HTMLSelectElement).value as Prefs['mode']; cursor = 0; savePrefs(); render(); });
  $('vb-speak').addEventListener('change', () => { prefs.speak = ($('vb-speak') as HTMLInputElement).checked; savePrefs(); });
  $('vb-sound').addEventListener('change', () => { prefs.sound = ($('vb-sound') as HTMLInputElement).checked; savePrefs(); });
  $('vb-train').addEventListener('click', () => {
    const c = syncClass(); if (!c) { show('сначала загрузите класс', 'err'); return; }
    train = 0; if (!listening) void startListening().then(() => trainShow()); else trainShow();
  });
  bar.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('#vb-forget')) return;
    if (!confirm('Забыть все выученные произношения имён на этом устройстве?')) return;
    for (const k of Object.keys(aliases)) delete aliases[k];
    saveAliases(); show('выученные имена забыты', 'ok');
  });
  $('vb-help').addEventListener('click', () => { $('vb-helpbox').hidden = !$('vb-helpbox').hidden; });
  $('vb-close').addEventListener('click', () => { stopListening(); bar.hidden = true; document.body.classList.remove('voice-open'); });
  document.addEventListener('click', (e) => { // клик по строке — диктовать этому ученику
    if (bar.hidden) return;
    const tr = (e.target as HTMLElement).closest('.rep tbody tr[data-s]') as HTMLElement | null;
    if (!tr || (e.target as HTMLElement).closest('input, select, button')) return;
    si = Number(tr.dataset.s); cursor = 0;
    const c = syncClass(); const l = c ? learn(c.cls, si) : '';
    if (l) show(`→ ${h(c!.cls.students[si].name)}${l}`, 'ok'); else render();
  });
  new MutationObserver(() => { if (!bar.hidden) { const tr = document.querySelector(`.rep tr[data-s="${si}"]`); if (tr && !tr.classList.contains('voice-cur')) tr.classList.add('voice-cur'); } })
    .observe(document.getElementById('preview') ?? document.body, { childList: true, subtree: true });

  /* ---------- диктовка списка учеников (браузерный движок или офлайн) ---------- */
  let listEngine: Engine | null = null;
  const dictateInto = (ta: HTMLTextAreaElement, btn: HTMLElement) => {
    const reset = () => { listEngine = null; btn.classList.remove('on'); btn.textContent = '🎤 Диктовать список'; };
    if (listEngine) { listEngine.stop(); reset(); return; }
    const kind: EngineKind = prefs.engine === 'web' && webSpeechAvailable() ? 'web' : voskAvailable() ? 'vosk' : 'web';
    const eng = kind === 'vosk' ? new VoskEngine() : new WebSpeechEngine(prefs.lang);
    listEngine = eng; btn.classList.add('on'); btn.textContent = '⏹ Остановить диктовку';
    void eng.start({
      final: (alts) => {
        const raw = alts[0].trim(); const p = parsePhrase(raw);
        if (p.commands.includes('stop')) { eng.stop(); reset(); return; }
        if (p.commands.includes('undo') || p.commands.includes('clear')) { ta.value = ta.value.replace(/\n?[^\n]*$/, ''); return; }
        const line = wordsToDigits(raw).replace(/\s+/g, ' ').replace(/(^|\s)(\p{L})/gu, (_, sp: string, ch: string) => sp + ch.toUpperCase());
        ta.value = (ta.value.trim() ? ta.value.replace(/\s*$/, '\n') : '') + line;
        ta.scrollTop = ta.scrollHeight; signal('ok');
      },
      partial: () => undefined,
      status: (k, msg) => { if (k === 'error') { alert(msg); reset(); } else if (k === 'loading') btn.textContent = `⏳ ${msg?.match(/\d+ %/)?.[0] ?? 'загрузка…'}`; else if (k === 'listening') btn.textContent = '⏹ Остановить диктовку'; },
    });
  };

  return {
    open() { bar.hidden = false; document.body.classList.add('voice-open'); clsId = ''; render(); void startListening(); },
    dictateInto,
    /** Проверка без микрофона: обработать фразу как распознанную. */
    test(text: string) { bar.hidden = false; document.body.classList.add('voice-open'); handle([text]); return $('vb-heard').textContent ?? ''; },
  };
}
