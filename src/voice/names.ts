/**
 * Голосовая база имён: как офлайн-распознаватель слышит фамилии учеников.
 * - public/voice-base.json — готовая база (ключ звучания → хеш имени; самих имён в файле нет);
 * - при загрузке классов имена разбираются сразу: прогревается модель, считается, у кого звучание уже есть;
 * - в приложении для Windows имена дополнительно проговариваются голосом системы и прогоняются через
 *   распознаватель — так база пополняется сама, без участия учителя (хранится на этом компьютере).
 */
import { fnv, normalize, nameKey, nameWords, type Variants } from './parse.ts';
import { voskAvailable, voskCached, warmVosk, voskRecognizeBuffers } from './engine.ts';

const LSL = 'sor-reports.voice-learned';     // выученные на устройстве звучания (как Variants)
const LSD = 'sor-reports.voice-learned-done'; // хеши имён, которые уже прогоняли
const read = <T>(k: string, d: T): T => { try { return (JSON.parse(localStorage.getItem(k) ?? 'null') as T) ?? d; } catch { return d; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

let shipped: Variants = {};
let ready: Promise<void> | null = null;
const learned: Variants = read(LSL, {});
const done = new Set<string>(read<string[]>(LSD, []));

/** Все звучания: готовая база + выученные на этом устройстве. */
export const variants = (): Variants => ({ ...shipped, ...learned });
export const loadBase = (): Promise<void> => (ready ??= fetch(`${import.meta.env.BASE_URL}voice-base.json`)
  .then((r) => (r.ok ? r.json() : {})).then((j: Variants) => { shipped = j; }).catch(() => undefined));

interface Native { synth(texts: string[]): Promise<ArrayBuffer[] | Uint8Array[]> }
const native = (): Native | undefined => (window as unknown as { sorNative?: Native }).sorNative;

/** Латиница журнала → кириллица для голоса Windows («Abdullayeva» → «Абдуллаева»). */
export function cyr(w: string): string {
  if (/[а-яё]/i.test(w)) return w;
  let t = w.toLowerCase();
  for (const [re, r] of [[/sh/g, 'ш'], [/ch/g, 'ч'], [/o['‘’ʻ`]/g, 'у'], [/g['‘’ʻ`]/g, 'г'], [/yo/g, 'ё'], [/yu/g, 'ю'], [/ya/g, 'я'], [/ye/g, 'е'], [/ts/g, 'ц'], [/['‘’ʻ`]/g, '']] as [RegExp, string][]) t = t.replace(re, r);
  const L: Record<string, string> = { a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и', j: 'ж', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п', q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'х', y: 'й', z: 'з' };
  t = t.replace(/[a-z]/g, (c) => L[c] ?? c);
  if (t.startsWith('е')) t = 'э' + t.slice(1);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export interface NamesStatus { total: number; ready: number; learning: boolean; text: string }

/**
 * Разобрать имена загруженных классов: база + прогрев модели; в exe — самообучение по голосу системы.
 * onStatus вызывается по ходу (для строки «Голосовая база»).
 */
export async function prepareNames(all: string[], onStatus: (s: NamesStatus) => void): Promise<void> {
  const names = [...new Set(all.map((n) => n.trim()).filter(Boolean))];
  if (!names.length) return;
  await loadBase();
  const count = () => { const v = new Set(Object.values(variants())); return names.filter((n) => v.has(fnv(normalize(n)))).length; };
  const status = (learning: boolean, extra = '') => {
    const r = count();
    onStatus({ total: names.length, ready: r, learning, text: `🎤 Голосовая база: ${r} из ${names.length} имён${extra}` });
  };
  status(false);
  if (!voskAvailable()) return;
  const nat = native();
  if (voskCached() || nat) void warmVosk(); // микрофон потом включается сразу
  const todo = names.filter((n) => !done.has(fnv(normalize(n))));
  if (!nat || !todo.length) return;
  // приложение для Windows: проговорить фамилии голосом системы и записать, как их слышит распознаватель
  status(true, ' · разбираю произношение…');
  try {
    const texts: string[] = [], who: string[] = [];
    for (const n of todo) { const p = n.split(/\s+/).map(cyr); texts.push(p[0], `${p[0]} ${p[1] ?? ''}`.trim()); who.push(n, n); }
    const wavs = await nat.synth(texts);
    const heard = await voskRecognizeBuffers(wavs.map((w) => (w instanceof ArrayBuffer ? w : (w.buffer.slice(w.byteOffset, w.byteOffset + w.byteLength) as ArrayBuffer))),
      (i) => { if (i % 6 === 5) status(true, ` · разбираю произношение ${Math.round(((i + 1) / texts.length) * 100)} %`); });
    const own = new Map<string, string>(); const clash = new Set<string>();
    heard.forEach((t, i) => {
      const k = nameKey(nameWords(t).join(''));
      if (k.length < 3) return;
      const v = fnv(normalize(who[i]));
      if (own.has(k) && own.get(k) !== v) clash.add(k); else own.set(k, v);
    });
    for (const [k, v] of own) if (!clash.has(k) && (!shipped[k] || shipped[k] === v)) learned[k] = v;
    for (const n of todo) done.add(fnv(normalize(n)));
    write(LSL, learned); write(LSD, [...done]);
    status(false, ' · произношение разобрано');
  } catch (e) {
    status(false, ` · не удалось разобрать произношение: ${(e as Error).message}`);
  }
}
