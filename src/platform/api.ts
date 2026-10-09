/** Доступ к платформе (Supabase, только RPC-функции из supabase/schema.sql). */

export interface PlatformConfig { url: string; anonKey: string }
export interface PlatformUser { id: string; login: string; name: string; role: 'owner' | 'user'; blocked: boolean; note: string; created_at: string }

const ERRORS: Record<string, string> = {
  AUTH: 'Сессия истекла — войдите снова',
  LOGIN: 'Неверный логин или пароль',
  BLOCKED: 'Доступ заблокирован основателем',
  FORBIDDEN: 'Только для основателя',
  OWNER_EXISTS: 'Основатель уже создан',
  WEAK: 'Логин не короче 3 символов, пароль — 6',
  EXISTS: 'Такой логин уже есть',
  SELF: 'Нельзя применить к себе',
};

export class PlatformError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

let cached: PlatformConfig | null | undefined;

/** platform.json рядом с сайтом; пустые поля — платформа выключена (сайт работает без входа). */
export async function loadConfig(): Promise<PlatformConfig | null> {
  if (cached !== undefined) return cached;
  try {
    const res = await fetch(new URL('platform.json', document.baseURI).toString(), { cache: 'no-store' });
    if (!res.ok) return (cached = null);
    const j = (await res.json()) as Partial<PlatformConfig>;
    cached = j.url && j.anonKey ? { url: j.url.replace(/\/+$/, ''), anonKey: j.anonKey } : null;
  } catch { cached = null; }
  return cached;
}

/** Вызов функции базы: POST /rest/v1/rpc/<fn>. Ошибки базы приходят как «message»; код — первое слово. */
export async function rpc<T = unknown>(cfg: PlatformConfig, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${cfg.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}` },
      body: JSON.stringify(args),
    });
  } catch {
    throw new PlatformError('NETWORK', 'Нет связи с платформой. Проверьте интернет.');
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = (JSON.parse(text) as { message?: string }).message ?? text; } catch { /* как есть */ }
    const code = (msg.match(/^[A-Z_]+/)?.[0] ?? '').trim();
    throw new PlatformError(code || 'ERR', ERRORS[code] ?? `Ошибка платформы: ${msg.slice(0, 160)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

/** Постоянный идентификатор устройства (браузера). */
export function deviceId(): string {
  const KEY = 'sor.device';
  try {
    let id = localStorage.getItem(KEY);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(KEY, id); }
    return id;
  } catch { return 'no-storage'; }
}

/** Пароль для нового пользователя: 10 символов без похожих букв. */
export function genPassword(len = 10): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export const fmtHours = (seconds: number): string => {
  const h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60);
  return h ? `${h} ч ${m} мин` : `${m} мин`;
};
export const fmtWhen = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
};
