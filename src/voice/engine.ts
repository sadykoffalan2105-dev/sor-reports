/**
 * Движки распознавания речи.
 *  - vosk: офлайн, прямо в браузере (WebAssembly), работает в любом современном браузере и в exe.
 *    Два распознавателя на одном звуке: «узкий» (словарь: числа и команды — цифры почти без ошибок)
 *    и «свободный» (для фамилий). Модель 46 МБ скачивается один раз и хранится в браузере.
 *  - web: Web Speech API (Chrome / Edge / Яндекс / Safari), онлайн; хорошо понимает фамилии.
 */

export type EngineKind = 'vosk' | 'web';
export interface EngineEvents {
  final(alts: string[]): void;
  partial(text: string): void;
  status(kind: 'loading' | 'ready' | 'listening' | 'error' | 'stopped', message?: string, progress?: number): void;
}
export interface Engine {
  kind: EngineKind;
  start(ev: EngineEvents): Promise<void>;
  stop(): void;
  /** Пауза ввода (пока звучит озвучка) — без перезапуска микрофона. */
  setPaused(on: boolean): void;
  /** Фамилии класса — подсказка распознавателю. */
  setNames(names: string[]): void;
}

export const webSpeechAvailable = (): boolean => {
  const w = window as unknown as Record<string, unknown>;
  return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
};
export const voskAvailable = (): boolean => typeof WebAssembly === 'object' && !!navigator.mediaDevices?.getUserMedia && typeof Worker !== 'undefined';
/** Electron (exe) — браузерного распознавания там нет. */
export const isApp = (): boolean => /Electron/i.test(navigator.userAgent);

const MODEL_URL = () => new URL('models/vosk-ru.tar.gz', document.baseURI).href;
const MODEL_SIZE = 46_236_541;

/* ---------- микрофон ---------- */
async function openMic(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false });
}
const micError = (e: unknown): string => {
  const n = (e as { name?: string })?.name ?? '';
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'нет доступа к микрофону: разрешите его в адресной строке браузера (значок 🔒 или 🎤)';
  if (n === 'NotFoundError' || n === 'DevicesNotFoundError') return 'микрофон не найден — подключите его';
  if (n === 'NotReadableError') return 'микрофон занят другой программой';
  return `микрофон: ${(e as Error)?.message ?? e}`;
};

/* ---------- Vosk ---------- */
type VoskModel = import('vosk-browser').Model;
type VoskRec = import('vosk-browser').KaldiRecognizer;
let modelPromise: Promise<VoskModel> | null = null;

/** Скачать модель с прогрессом (в кэш браузера), затем отдать библиотеке — она распакует в IndexedDB. */
async function loadModel(onProgress: (p: number) => void): Promise<VoskModel> {
  if (!modelPromise) {
    modelPromise = (async () => {
      const url = MODEL_URL();
      const cached = localStorage.getItem('sor.voskModel') === url;
      if (!cached) {
        try {
          const res = await fetch(url, { cache: 'force-cache' });
          if (!res.ok || !res.body) throw new Error(`модель не найдена (${res.status})`);
          const total = Number(res.headers.get('content-length')) || MODEL_SIZE;
          const reader = res.body.getReader();
          let got = 0;
          for (;;) { const { done, value } = await reader.read(); if (done) break; got += value.length; onProgress(Math.min(0.99, got / total)); }
        } catch (e) { modelPromise = null; throw e; }
      }
      const { createModel } = await import('vosk-browser');
      const model = await createModel(url, -1);
      try { localStorage.setItem('sor.voskModel', url); } catch { /* ignore */ }
      onProgress(1);
      return model;
    })();
  }
  return modelPromise;
}

export class VoskEngine implements Engine {
  kind: EngineKind = 'vosk';
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  private rec: VoskRec | null = null;
  private paused = false;
  private ev: EngineEvents | null = null;

  setNames() { /* фамилии ищутся по звучанию в тексте — словарь модели не меняем */ }
  setPaused(on: boolean) { this.paused = on; }

  async start(ev: EngineEvents) {
    this.ev = ev;
    ev.status('loading', 'загружаю модель распознавания (46 МБ, один раз)…', 0);
    let model: VoskModel;
    try { model = await loadModel((p) => ev.status('loading', `загружаю модель распознавания — ${Math.round(p * 100)} % (один раз, потом без интернета)`, p)); }
    catch (e) { ev.status('error', `не удалось загрузить модель: ${(e as Error).message}. Проверьте интернет или выберите «браузер»`); return; }
    try { this.stream = await openMic(); } catch (e) { ev.status('error', micError(e)); return; }
    const ctx = new AudioContext();
    this.ctx = ctx;
    // один свободный распознаватель: в проверке на русской речи он точнее «узкого словаря» —
    // тот превращал фамилии в лишние числа («Анваров» → «два»)
    const rec = new model.KaldiRecognizer(16000); // модель обучена на 16 кГц — звук понижаем сами, втрое меньше работы
    this.rec = rec;
    rec.on('result', (m) => { const t = ((m as unknown as { result: { text: string } }).result?.text ?? '').trim(); if (t && !this.paused) ev.final([t]); });
    rec.on('partialresult', (m) => { const t = (m as unknown as { result: { partial: string } }).result?.partial ?? ''; if (t && !this.paused) ev.partial(t); });
    await new Promise((r) => setTimeout(r, 400)); // распознаватель создаётся в фоне — звук до этого отбрасывается
    const src = ctx.createMediaStreamSource(this.stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const ratio = ctx.sampleRate / 16000;
    node.onaudioprocess = (e) => {
      if (this.paused || !this.rec) return;
      const inp = e.inputBuffer.getChannelData(0);
      const out = new Float32Array(Math.floor(inp.length / ratio));
      for (let i = 0; i < out.length; i++) { // среднее по окну — заодно фильтр от наложения частот
        const a = Math.floor(i * ratio), b = Math.min(inp.length, Math.floor((i + 1) * ratio));
        let sum = 0; for (let k = a; k < b; k++) sum += inp[k];
        out[i] = sum / Math.max(1, b - a);
      }
      try { this.rec.acceptWaveformFloat(out, 16000); } catch { /* ещё готовится */ }
    };
    src.connect(node); node.connect(ctx.destination);
    this.node = node;
    if (ctx.state === 'suspended') await ctx.resume();
    ev.status('listening');
  }

  stop() {
    try { this.node?.disconnect(); } catch { /* ignore */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    try { this.rec?.remove(); } catch { /* ignore */ }
    this.node = null; this.stream = null; this.ctx = null; this.rec = null;
    this.ev?.status('stopped');
  }
}

/* ---------- Web Speech ---------- */
type SR = {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null;
};

export class WebSpeechEngine implements Engine {
  kind: EngineKind = 'web';
  private rec: SR | null = null;
  private on = false;
  private paused = false;
  private lastFinal = { text: '', at: 0 };
  private ev: EngineEvents | null = null;
  private lang: string;
  constructor(lang: string) { this.lang = lang; }
  setNames() { /* браузер сам знает фамилии */ }
  setPaused(on: boolean) { this.paused = on; }

  async start(ev: EngineEvents) {
    this.ev = ev;
    const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
    const C = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!C) { ev.status('error', 'в этом браузере нет встроенного распознавания — выберите «офлайн»'); return; }
    // разрешение на микрофон заранее — понятная ошибка вместо молчания
    try { const s = await openMic(); s.getTracks().forEach((t) => t.stop()); } catch (e) { ev.status('error', micError(e)); return; }
    this.on = true;
    const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
    const run = () => {
      if (!this.on) return;
      const r = new C();
      r.lang = this.lang;
      r.continuous = !mobile;          // на телефонах непрерывный режим дублирует фразы
      r.interimResults = true;
      r.maxAlternatives = 4;
      r.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          if (this.paused) continue;
          if (!res.isFinal) { ev.partial(res[0].transcript); continue; }
          const alts = Array.from({ length: res.length }, (_, k) => res[k].transcript.trim()).filter(Boolean);
          if (!alts.length) continue;
          const now = Date.now(); // защита от двойной выдачи одной фразы
          if (alts[0] === this.lastFinal.text && now - this.lastFinal.at < 2500) continue;
          this.lastFinal = { text: alts[0], at: now };
          ev.final(alts);
        }
      };
      r.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { this.on = false; ev.status('error', 'нет доступа к микрофону или к сервису распознавания — выберите «офлайн» распознавание'); }
        else if (e.error === 'network') { ev.status('error', 'нет связи с сервисом распознавания — выберите «офлайн», он работает без интернета'); }
        else if (e.error === 'audio-capture') { this.on = false; ev.status('error', 'микрофон не найден'); }
        else if (e.error === 'language-not-supported') { this.on = false; ev.status('error', 'язык не поддерживается — выберите русский'); }
      };
      r.onend = () => { if (this.on && this.rec === r) setTimeout(run, 120); };
      this.rec = r;
      try { r.start(); } catch { /* уже запущен */ }
    };
    run();
    ev.status('listening');
  }
  stop() { this.on = false; try { this.rec?.abort(); } catch { /* ignore */ } this.rec = null; this.ev?.status('stopped'); }
}

/** Короткий звуковой сигнал вместо озвучки — не мешает микрофону. ok: высокий, ошибка: двойной низкий. */
let beepCtx: AudioContext | null = null;
export function beep(kind: 'ok' | 'err' | 'next'): void {
  try {
    beepCtx ??= new AudioContext();
    const c = beepCtx;
    const tones = kind === 'ok' ? [[880, 0.07]] : kind === 'next' ? [[660, 0.06], [990, 0.08]] : [[300, 0.12], [240, 0.14]];
    let t = c.currentTime;
    for (const [f, d] of tones) {
      const o = c.createOscillator(), g = c.createGain();
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + d + 0.02);
      t += d + 0.04;
    }
  } catch { /* без звука */ }
}

/** Проверка без микрофона: прогнать WAV через Vosk и вернуть распознанное (для тестов в браузере). */
export async function voskRecognizeFile(url: string): Promise<{ text: string; ms: number; audioMs: number }> {
  const model = await loadModel(() => undefined);
  const buf = await (await fetch(url)).arrayBuffer();
  const audio = await new OfflineAudioContext(1, 16000, 16000).decodeAudioData(buf);
  const data = audio.getChannelData(0);
  const rec = new model.KaldiRecognizer(audio.sampleRate);
  await new Promise((r) => setTimeout(r, 600));
  let text = '', last = Date.now(), finals = 0;
  rec.on('result', (m) => { last = Date.now(); finals++; const t = (m as unknown as { result: { text: string } }).result?.text ?? ''; if (t) text += ' ' + t; });
  rec.on('partialresult', () => { last = Date.now(); });
  const t0 = performance.now();
  const pad = new Float32Array(16000);
  for (const chunk of [data, pad]) for (let i = 0; i < chunk.length; i += 4096) rec.acceptWaveformFloat(chunk.slice(i, i + 4096), audio.sampleRate);
  rec.retrieveFinalResult();
  const started = Date.now();
  await new Promise<void>((res) => { const t = setInterval(() => { if ((finals >= 1 && Date.now() - last > 700) || Date.now() - started > 30000) { clearInterval(t); res(); } }, 50); });
  rec.remove();
  return { text: text.trim(), ms: Math.round(performance.now() - t0 - 700), audioMs: Math.round((data.length / audio.sampleRate) * 1000) + 1000 };
}
