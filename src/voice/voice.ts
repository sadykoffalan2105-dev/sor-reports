/**
 * Голосовой ввод баллов: учитель диктует с бумажного листа — по ученику, по критериям или общий балл.
 * Распознавание — Web Speech API браузера (Chrome / Edge / Яндекс; нужен интернет), озвучка — speechSynthesis.
 */
import type { ClassReport, JournalClass, Student } from '../core/types.ts';
import { parsePhrase, interpret, findStudent, wordsToDigits, sayNumbers, type Parsed } from './parse.ts';

export interface VoiceHost {
  /** Активный класс и его отчёт. */
  ctx(): { cls: JournalClass; report: ClassReport | null } | null;
  /** Пересчитать активный класс и перерисовать таблицу. */
  refresh(): void;
  /** Переключить класс: +1 / −1. Возвращает название нового класса или ''. */
  switchClass(delta: number): string;
  download(): void;
  print(): void;
  /** Короткие подписи колонок: «1 зд», «2.3». */
  columnNames(report: ClassReport): string[];
}

type SR = {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: SREvent) => void) | null; onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null; onstart: (() => void) | null;
};
type SREvent = { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }> & { isFinal: boolean }> };

const SRClass = (): (new () => SR) | null => {
  const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};
export const voiceSupported = (): boolean => !!SRClass();

const LS = 'sor-reports.voice';
interface Prefs { lang: string; mode: 'criteria' | 'total'; speak: boolean }
const loadPrefs = (): Prefs => {
  try { return { lang: 'ru-RU', mode: 'criteria', speak: true, ...(JSON.parse(localStorage.getItem(LS) ?? '{}') as Partial<Prefs>) }; } catch { return { lang: 'ru-RU', mode: 'criteria', speak: true }; }
};
const h = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Snapshot { cls: JournalClass; si: number; manualScores?: number[]; manualScore?: number | null; forceAbsent?: boolean; cursor: number }

export function initVoice(host: VoiceHost): { open(): void; dictateInto(textarea: HTMLTextAreaElement, button: HTMLElement): void; test(text: string): string } {
  const prefs = loadPrefs();
  const savePrefs = () => { try { localStorage.setItem(LS, JSON.stringify(prefs)); } catch { /* ignore */ } };

  let rec: SR | null = null;
  let listening = false;   // пользователь включил микрофон
  let speaking = false;    // идёт озвучка — микрофон на паузе, чтобы не услышать себя
  let si = 0;              // текущий ученик (индекс в cls.students)
  let cursor = 0;          // следующий критерий для этого ученика
  let clsId = '';
  let lastMsg = '';
  const history: Snapshot[] = [];

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
      </div>
      <div class="vb-ctl">
        <div class="vb-nav"><button class="mini" type="button" id="vb-prev" title="Предыдущий ученик (или скажите «назад»)">◀</button><button class="mini" type="button" id="vb-next" title="Следующий ученик (или «дальше»)">▶</button><button class="mini" type="button" id="vb-undo" title="Отменить последнее (или «отмена»)">↶</button></div>
        <select id="vb-mode" title="Что вы диктуете"><option value="criteria">баллы по критериям</option><option value="total">только общий балл</option></select>
        <select id="vb-lang" title="Язык распознавания"><option value="ru-RU">русский</option><option value="uz-UZ">o'zbek</option><option value="en-US">English</option></select>
        <label class="vb-chk"><input type="checkbox" id="vb-speak" /> озвучивать</label>
        <button class="mini" type="button" id="vb-help" title="Команды">?</button>
        <button class="mini" type="button" id="vb-close" title="Закрыть">✕</button>
      </div>
    </div>
    <div class="vb-helpbox" id="vb-helpbox" hidden>
      <b>Как диктовать.</b> Программа ведёт по ученикам сверху вниз. Назовите баллы по критериям подряд: «пять пять пять шестнадцать десять пять» — строка заполнится, и программа перейдёт к следующему ученику.
      Можно частями: «пять пять», потом «пять шестнадцать…». Одно число больше максимума первого критерия — это общий балл («сорок шесть»), он разложится по раскладке. Явно: «общий сорок шесть».
      <div class="vb-cmds">
        <span><b>дальше / назад</b> — другой ученик</span><span><b>Цой</b> или <b>Цой сорок два</b> — перейти к ученику (и сразу балл)</span>
        <span><b>отсутствует</b> — нет на СОР</span><span><b>все на максимум</b> — оставшиеся критерии полные</span>
        <span><b>сначала</b> — заново с первого критерия</span><span><b>отмена</b> — вернуть как было</span>
        <span><b>повтори</b> — прочитать строку</span><span><b>следующий класс</b>, <b>скачать</b>, <b>печать</b>, <b>стоп</b></span>
      </div>
      Распознавание работает в Chrome, Edge и Яндекс Браузере, нужен интернет и разрешение на микрофон. Говорите числа раздельно, с короткой паузой между учениками.
    </div>`;
  document.body.appendChild(bar);
  const $ = <T extends HTMLElement>(id: string) => bar.querySelector('#' + id) as T;
  ($('vb-mode') as HTMLSelectElement).value = prefs.mode;
  ($('vb-lang') as HTMLSelectElement).value = prefs.lang;
  ($('vb-speak') as HTMLInputElement).checked = prefs.speak;

  /* ---------- состояние ученика ---------- */
  const ctx = () => host.ctx();
  const syncClass = () => {
    const c = ctx();
    if (!c) return null;
    if (c.cls.id !== clsId) { clsId = c.cls.id; si = firstPending(c.cls); cursor = 0; }
    si = Math.max(0, Math.min(si, c.cls.students.length - 1));
    return c;
  };
  /** Первый ученик без балла — удобно начать с него (для бумажного отчёта это первый в списке). */
  const firstPending = (cls: JournalClass): number => {
    const a = cls.assessments.find((x) => x.id === cls.selectedAssessment) ?? cls.assessments[0];
    const i = cls.students.findIndex((st, k) => !st.forceAbsent && !st.manualScores && st.manualScore == null && (a?.scores[k] ?? null) == null);
    return i >= 0 ? i : 0;
  };
  const rowOf = (report: ClassReport | null, idx: number) => report?.rows.find((r) => r.studentIndex === idx && !r.absent);
  const maxesOf = (report: ClassReport) => report.columns.map((c) => c.max);
  const snapshot = (cls: JournalClass, idx: number) => { const st = cls.students[idx]; history.push({ cls, si: idx, manualScores: st.manualScores?.slice(), manualScore: st.manualScore, forceAbsent: st.forceAbsent, cursor }); if (history.length > 100) history.shift(); };

  /* ---------- озвучка ---------- */
  const say = (text: string) => {
    if (!prefs.speak || !text || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = prefs.lang;
    u.rate = 1.15;
    const voice = speechSynthesis.getVoices().find((v) => v.lang.startsWith(prefs.lang.slice(0, 2)));
    if (voice) u.voice = voice;
    speaking = true;
    try { rec?.abort(); } catch { /* ignore */ }
    const resume = () => { speaking = false; if (listening) startRec(); };
    u.onend = resume; u.onerror = resume;
    speechSynthesis.speak(u);
  };

  /* ---------- отрисовка ---------- */
  const render = () => {
    const c = syncClass();
    document.querySelectorAll('.rep tr.voice-cur').forEach((tr) => tr.classList.remove('voice-cur'));
    if (!c || !c.report) { $('vb-who').innerHTML = 'Загрузите журнал или создайте класс списком — потом диктуйте баллы.'; $('vb-cells').innerHTML = ''; return; }
    const { cls, report } = c;
    const st = cls.students[si];
    const names = host.columnNames(report);
    const row = rowOf(report, si);
    const vals = st?.manualScores ?? row?.scores;
    const absent = st?.forceAbsent || (!row && st?.manualScore == null && !st?.manualScores);
    $('vb-who').innerHTML = st
      ? `<b>${si + 1}. ${h(st.name)}</b> <span class="vb-cls">${h(cls.className)} · ${si + 1} из ${cls.students.length}</span>${absent ? ' <span class="vb-tag">нет балла</span>' : row ? ` <span class="vb-tag ok">итого ${row.total}</span>` : ''}`
      : 'В классе нет учеников';
    $('vb-cells').innerHTML = names.map((n, k) => `<span class="vb-cell ${k === cursor && prefs.mode === 'criteria' ? 'cur' : ''} ${st?.manualScores ? 'set' : ''}"><small>${h(n)} · ${report.columns[k].max}</small><b>${vals ? vals[k] : '—'}</b></span>`).join('');
    $('vb-heard').innerHTML = lastMsg;
    $('vb-mic').classList.toggle('on', listening);
    const tr = document.querySelector(`.rep tr[data-s="${si}"]`) as HTMLElement | null;
    if (tr) { tr.classList.add('voice-cur'); if (!bar.hidden) tr.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  };
  const flash = (msg: string, kind: 'ok' | 'err' | 'info' = 'info') => { lastMsg = `<span class="vb-${kind}">${msg}</span>`; render(); };

  /* ---------- действия ---------- */
  const move = (delta: number) => {
    const c = syncClass(); if (!c) return;
    si = Math.max(0, Math.min(c.cls.students.length - 1, si + delta)); cursor = 0;
  };
  const afterChange = () => { host.refresh(); render(); };

  const applyPhrase = (p: Parsed, heard: string): boolean => {
    const c = syncClass();
    // команды, не требующие класса
    if (p.commands.includes('stop')) { stopListening(); flash(`«${h(heard)}» — микрофон выключен`); return true; }
    if (p.commands.includes('download')) { host.download(); flash('скачиваю книгу Excel', 'ok'); say('скачиваю'); return true; }
    if (p.commands.includes('print')) { host.print(); return true; }
    if (p.commands.includes('nextClass') || p.commands.includes('prevClass')) {
      const name = host.switchClass(p.commands.includes('nextClass') ? 1 : -1);
      clsId = ''; syncClass(); flash(name ? `класс ${h(name)}` : 'других классов нет', name ? 'ok' : 'err'); if (name) say(`класс ${name}`); return true;
    }
    if (!c || !c.report) { flash('сначала загрузите журнал или список класса', 'err'); return true; }
    const { cls, report } = c;
    const maxes = maxesOf(report);
    const names = host.columnNames(report);

    if (p.commands.includes('undo')) {
      const s = history.pop();
      if (!s) { flash('нечего отменять', 'err'); return true; }
      const st = s.cls.students[s.si];
      if (st) { st.manualScores = s.manualScores; st.manualScore = s.manualScore; st.forceAbsent = s.forceAbsent; }
      if (s.cls.id === cls.id) { si = s.si; cursor = s.cursor; }
      flash(`отменено: ${h(st?.name ?? '')}`, 'ok'); say('отменено'); afterChange(); return true;
    }
    // ученик по фамилии
    const nameWords = p.words.filter((w) => { const q = parsePhrase(w); return !q.commands.length && !q.total; }); // «дальше», «общий» — не фамилии
    const who = findStudent(nameWords, cls.students.map((s) => s.name));
    if (who >= 0 && who !== si) { si = who; cursor = 0; }
    const st: Student | undefined = cls.students[si];
    if (!st) return false;

    if (p.commands.includes('repeat')) {
      const row = rowOf(report, si);
      const txt = row ? `${st.name}: ${sayNumbers(row.scores)}. Итого ${row.total}` : `${st.name}: нет балла`;
      flash(h(txt)); say(txt); return true;
    }
    if (p.commands.includes('restart')) { cursor = 0; flash(`${h(st.name)}: заново с ${h(names[0])}`); render(); return true; }
    if (p.commands.includes('absent')) {
      snapshot(cls, si); st.forceAbsent = true; st.manualScores = undefined; st.manualScore = undefined;
      flash(`${h(st.name)} — отсутствует`, 'ok'); say(`${st.name.split(' ')[0]}, отсутствует`); move(1); afterChange(); return true;
    }
    if (p.commands.includes('full')) {
      snapshot(cls, si);
      const base = (st.manualScores ?? rowOf(report, si)?.scores ?? maxes.map(() => 0)).slice();
      for (let k = cursor; k < maxes.length; k++) base[k] = maxes[k];
      st.manualScores = base; st.forceAbsent = false;
      const total = base.reduce((a, b) => a + b, 0);
      flash(`${h(st.name)}: ${base.join(' ')} → ${total}`, 'ok'); say(`итого ${total}`); move(1); afterChange(); return true;
    }
    if (p.nums.length) {
      const it = interpret(p.nums, maxes, cursor, prefs.mode, p.total, names);
      if (it.kind === 'error') { flash(`«${h(heard)}»: ${h(it.message)}`, 'err'); say(it.message); return false; }
      snapshot(cls, si);
      if (it.kind === 'total') {
        st.manualScore = it.value; st.manualScores = undefined; st.forceAbsent = false;
        flash(`${h(st.name)}: общий ${it.value}`, 'ok'); say(String(it.value)); move(1); afterChange(); return true;
      }
      const base = (st.manualScores ?? rowOf(report, si)?.scores ?? maxes.map(() => 0)).slice();
      if (!st.manualScores && it.start === 0) base.fill(0); // новая строка с бумаги — с нуля
      it.values.forEach((v, j) => { base[it.start + j] = v; });
      st.manualScores = base; st.forceAbsent = false;
      cursor = it.start + it.values.length;
      if (cursor >= maxes.length) {
        const total = base.reduce((a, b) => a + b, 0);
        flash(`${h(st.name)}: ${base.join(' ')} → <b>${total}</b>`, 'ok'); say(`${sayNumbers(it.values)}. Итого ${total}`); move(1);
      } else {
        flash(`${h(st.name)}: ${it.values.join(' ')} · дальше ${h(names[cursor])}`, 'ok'); say(sayNumbers(it.values));
      }
      afterChange(); return true;
    }
    if (p.commands.includes('next')) { move(1); flash(`→ ${h(cls.students[si]?.name ?? '')}`); render(); return true; }
    if (p.commands.includes('prev')) { move(-1); flash(`← ${h(cls.students[si]?.name ?? '')}`); render(); return true; }
    if (who >= 0) { flash(`→ ${h(st.name)}`); say(st.name.split(' ')[0]); render(); return true; }
    flash(`не понял: «${h(heard)}»`, 'err');
    return false;
  };

  /** Обработать распознанный вариант; при неудаче — следующий из альтернатив. */
  const handle = (alts: string[]) => {
    for (let i = 0; i < alts.length; i++) {
      const p = parsePhrase(alts[i]);
      const lastTry = i === alts.length - 1;
      if (!p.nums.length && !p.commands.length && !p.words.length) continue;
      // пробуем «без последствий»: числа, которые не подходят, — к следующей альтернативе
      if (!lastTry && p.nums.length && !p.commands.length) {
        const c = syncClass();
        if (c?.report) {
          const it = interpret(p.nums, maxesOf(c.report), cursor, prefs.mode, p.total);
          if (it.kind === 'error') continue;
        }
      }
      if (applyPhrase(p, alts[i]) || lastTry) return;
    }
  };

  /* ---------- микрофон ---------- */
  function startRec() {
    const C = SRClass(); if (!C || speaking) return;
    try { rec?.abort(); } catch { /* ignore */ }
    const r = new C();
    r.lang = prefs.lang; r.continuous = true; r.interimResults = true; r.maxAlternatives = 3;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) {
          const alts = Array.from({ length: res.length }, (_, k) => res[k].transcript).filter(Boolean);
          handle(alts);
        } else {
          $('vb-heard').innerHTML = `<span class="vb-interim">${h(res[0].transcript)}…</span>`;
        }
      }
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { listening = false; flash('нет доступа к микрофону: разрешите его в адресной строке браузера (значок 🎤/🔒)', 'err'); }
      else if (e.error === 'audio-capture') { listening = false; flash('микрофон не найден', 'err'); }
      else if (e.error === 'network') { flash('нет связи с сервисом распознавания — проверьте интернет', 'err'); }
      else if (e.error === 'language-not-supported') { listening = false; flash('этот язык браузер не распознаёт — выберите русский', 'err'); }
    };
    r.onend = () => { if (rec === r && listening && !speaking) setTimeout(() => { if (listening && !speaking) startRec(); }, 200); };
    rec = r;
    try { r.start(); } catch { /* уже запущен */ }
  }
  const startListening = () => {
    if (!SRClass()) { flash('ваш браузер не поддерживает голосовой ввод — откройте сайт в Chrome, Edge или Яндекс Браузере', 'err'); return; }
    listening = true; startRec(); flash('слушаю… диктуйте баллы', 'ok');
  };
  function stopListening() { listening = false; try { rec?.abort(); } catch { /* ignore */ } rec = null; render(); }

  /* ---------- кнопки ---------- */
  $('vb-mic').addEventListener('click', () => (listening ? stopListening() : startListening()));
  $('vb-prev').addEventListener('click', () => { move(-1); render(); });
  $('vb-next').addEventListener('click', () => { move(1); render(); });
  $('vb-undo').addEventListener('click', () => applyPhrase(parsePhrase('отмена'), 'отмена'));
  $('vb-mode').addEventListener('change', () => { prefs.mode = ($('vb-mode') as HTMLSelectElement).value as Prefs['mode']; cursor = 0; savePrefs(); render(); });
  $('vb-lang').addEventListener('change', () => { prefs.lang = ($('vb-lang') as HTMLSelectElement).value; savePrefs(); if (listening) startRec(); });
  $('vb-speak').addEventListener('change', () => { prefs.speak = ($('vb-speak') as HTMLInputElement).checked; savePrefs(); });
  $('vb-help').addEventListener('click', () => { $('vb-helpbox').hidden = !$('vb-helpbox').hidden; });
  $('vb-close').addEventListener('click', () => { stopListening(); bar.hidden = true; document.body.classList.remove('voice-open'); });
  // клик по строке таблицы — диктовать этому ученику
  document.addEventListener('click', (e) => {
    if (bar.hidden) return;
    const tr = (e.target as HTMLElement).closest('.rep tbody tr[data-s]') as HTMLElement | null;
    if (!tr || (e.target as HTMLElement).closest('input, select, button')) return;
    si = Number(tr.dataset.s); cursor = 0; render();
  });
  // после любой перерисовки таблицы — вернуть подсветку
  new MutationObserver(() => { if (!bar.hidden) { const tr = document.querySelector(`.rep tr[data-s="${si}"]`); if (tr && !tr.classList.contains('voice-cur')) tr.classList.add('voice-cur'); } })
    .observe(document.getElementById('preview') ?? document.body, { childList: true, subtree: true });

  /* ---------- диктовка списка учеников ---------- */
  let listRec: SR | null = null;
  const dictateInto = (ta: HTMLTextAreaElement, btn: HTMLElement) => {
    const C = SRClass();
    if (!C) { alert('Голосовой ввод работает в Chrome, Edge и Яндекс Браузере.'); return; }
    if (listRec) { listRec.abort(); listRec = null; btn.classList.remove('on'); btn.textContent = '🎤 Диктовать список'; return; }
    const r = new C();
    r.lang = prefs.lang; r.continuous = true; r.interimResults = false; r.maxAlternatives = 1;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (!e.results[i].isFinal) continue;
        const raw = e.results[i][0].transcript.trim();
        const p = parsePhrase(raw);
        if (p.commands.includes('stop')) { r.abort(); return; }
        if (p.commands.includes('undo') || p.commands.includes('clear')) { ta.value = ta.value.replace(/\n?[^\n]*$/, ''); continue; }
        const line = wordsToDigits(raw).replace(/\s+/g, ' ').replace(/^./, (ch) => ch.toUpperCase());
        ta.value = (ta.value.trim() ? ta.value.replace(/\s*$/, '\n') : '') + line;
        ta.scrollTop = ta.scrollHeight;
      }
    };
    r.onerror = (e) => { if (e.error === 'not-allowed') alert('Разрешите доступ к микрофону в адресной строке браузера.'); };
    listRec = r; btn.classList.add('on'); btn.textContent = '⏹ Остановить диктовку';
    try { r.start(); } catch { /* ignore */ }
    r.onend = () => { if (listRec === r) setTimeout(() => { try { r.start(); } catch { /* ignore */ } }, 200); };
    const stop = () => { if (listRec === r) { listRec = null; r.onend = null; btn.classList.remove('on'); btn.textContent = '🎤 Диктовать список'; } };
    const origAbort = r.abort.bind(r); r.abort = () => { stop(); origAbort(); };
  };

  return {
    open() { bar.hidden = false; document.body.classList.add('voice-open'); clsId = ''; render(); if (!listening) startListening(); },
    dictateInto,
    /** Для проверки без микрофона: обработать фразу как распознанную. */
    test(text: string) { bar.hidden = false; document.body.classList.add('voice-open'); handle([text]); return $('vb-heard').textContent ?? ''; },
  };
}
