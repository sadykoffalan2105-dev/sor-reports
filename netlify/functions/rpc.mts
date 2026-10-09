// Платформа «Отчёты СОР/СОЧ» на Netlify Functions + Netlify Blobs.
// Тот же интерфейс, что у supabase/schema.sql: POST /rest/v1/rpc/<функция> с JSON-аргументами.
// Данные — один JSON-документ в хранилище Blobs (пользователи, устройства, сессии, события),
// запись с проверкой etag и повтором, чтобы одновременные запросы не затирали друг друга.
import { getStore } from '@netlify/blobs';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Config, Context } from '@netlify/functions';

interface User { id: string; login: string; hash: string; name: string; role: 'owner' | 'user'; blocked: boolean; note: string; created_at: string }
interface Device { device_id: string; user_id: string; user_agent: string; label: string; first_seen: string; last_seen: string; active_seconds: number; reports: number; books: number }
interface Session { token: string; user_id: string; device_id: string; created_at: string; last_seen: string; active_seconds: number; revoked: boolean }
interface Ev { id: number; user_id: string; device_id: string; kind: string; qty: number; info: string; at: string }
interface Db { users: User[]; devices: Device[]; sessions: Session[]; events: Ev[]; seq: number }

const ALLOWED = ['https://sadykoffalan2105-dev.github.io', 'http://localhost:4710', 'http://127.0.0.1:4710', 'http://localhost:5173'];
const SESSION_DAYS = 60;
const MAX_EVENTS = 3000;

class RpcError extends Error { constructor(public code: string) { super(code); } }
const fail = (code: string): never => { throw new RpcError(code); };
const now = () => new Date().toISOString();
const uj = (u: User) => ({ id: u.id, login: u.login, name: u.name, role: u.role, blocked: u.blocked, note: u.note, created_at: u.created_at });
const str = (v: unknown, max = 300): string => String(v ?? '').slice(0, max);
const int = (v: unknown, lo: number, hi: number, d = 0): number => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

const hashPassword = (p: string): string => { const salt = randomBytes(16).toString('hex'); return `scrypt$${salt}$${scryptSync(p, salt, 32).toString('hex')}`; };
const checkPassword = (p: string, h: string): boolean => {
  const [, salt, hex] = h.split('$');
  if (!salt || !hex) return false;
  const a = scryptSync(p, salt, 32), b = Buffer.from(hex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};

/* ---------- хранилище ---------- */

const empty = (): Db => ({ users: [], devices: [], sessions: [], events: [], seq: 0 });

async function withDb<T>(fn: (db: Db) => T | Promise<T>, write: boolean): Promise<T> {
  const store = getStore({ name: 'platform', consistency: 'strong' });
  for (let attempt = 0; attempt < 4; attempt++) {
    const got = await store.getWithMetadata('db', { type: 'json' }) as { data: Db | null; etag?: string } | null;
    const db: Db = got?.data ?? empty();
    bootstrapOwner(db);
    const out = await fn(db);
    if (!write) return out;
    const opts = got?.etag ? { onlyIfMatch: got.etag } : { onlyIfNew: true };
    const res = await store.setJSON('db', db, opts as never) as { modified?: boolean } | undefined;
    if (!res || res.modified !== false) return out; // старые версии SDK не возвращают modified
    await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
  }
  fail('BUSY');
}

/** Основатель из переменных окружения OWNER_LOGIN / OWNER_PASSWORD — создаётся при первом обращении. */
function bootstrapOwner(db: Db): void {
  if (db.users.some((u) => u.role === 'owner')) return;
  const login = (process.env.OWNER_LOGIN ?? '').trim().toLowerCase();
  const pass = process.env.OWNER_PASSWORD ?? '';
  if (login.length < 3 || pass.length < 6) return;
  db.users.push({ id: randomUUID(), login, hash: hashPassword(pass), name: 'Основатель', role: 'owner', blocked: false, note: '', created_at: now() });
}

/* ---------- логика ---------- */

const auth = (db: Db, token: unknown): User => {
  const s = db.sessions.find((x) => x.token === token);
  if (!s || s.revoked || Date.now() - Date.parse(s.last_seen) > SESSION_DAYS * 86400e3) fail('AUTH');
  const u = db.users.find((x) => x.id === s!.user_id);
  if (!u) fail('AUTH');
  if (u!.blocked) fail('BLOCKED');
  s!.last_seen = now();
  return u!;
};
const owner = (db: Db, token: unknown): User => { const u = auth(db, token); if (u.role !== 'owner') fail('FORBIDDEN'); return u; };
const byLogin = (db: Db, login: unknown) => db.users.find((u) => u.login === str(login, 60).trim().toLowerCase());
const device = (db: Db, id: string, uid: string) => db.devices.find((d) => d.device_id === id && d.user_id === uid);
const addEvent = (db: Db, uid: string, dev: string, kind: string, qty = 1, info = '') => {
  db.events.push({ id: ++db.seq, user_id: uid, device_id: dev, kind, qty, info, at: now() });
  if (db.events.length > MAX_EVENTS) db.events.splice(0, db.events.length - MAX_EVENTS);
};
const stats = (db: Db, uid: string) => {
  const ds = db.devices.filter((d) => d.user_id === uid);
  return { devices: ds.length, books: ds.reduce((a, d) => a + d.books, 0), reports: ds.reduce((a, d) => a + d.reports, 0), seconds: ds.reduce((a, d) => a + d.active_seconds, 0), last_seen: ds.map((d) => d.last_seen).sort().at(-1) ?? null };
};

type Args = Record<string, unknown>;
const fns: Record<string, { write: boolean; run: (db: Db, a: Args) => unknown }> = {
  app_state: { write: false, run: (db) => ({ has_owner: db.users.some((u) => u.role === 'owner') }) },
  app_setup_owner: { write: true, run: (db, a) => {
    if (db.users.some((u) => u.role === 'owner')) fail('OWNER_EXISTS');
    const login = str(a.p_login, 60).trim().toLowerCase(), pass = str(a.p_password, 200);
    if (login.length < 3 || pass.length < 6) fail('WEAK');
    const u: User = { id: randomUUID(), login, hash: hashPassword(pass), name: 'Основатель', role: 'owner', blocked: false, note: '', created_at: now() };
    db.users.push(u); return uj(u);
  } },
  app_login: { write: true, run: (db, a) => {
    const u = byLogin(db, a.p_login);
    if (!u || !checkPassword(str(a.p_password, 200), u.hash)) fail('LOGIN');
    if (u!.blocked) fail('BLOCKED');
    const dev = str(a.p_device_id, 80) || 'unknown';
    let d = device(db, dev, u!.id);
    if (!d) { d = { device_id: dev, user_id: u!.id, user_agent: '', label: '', first_seen: now(), last_seen: now(), active_seconds: 0, reports: 0, books: 0 }; db.devices.push(d); }
    d.user_agent = str(a.p_user_agent, 300); d.last_seen = now();
    const token = randomBytes(32).toString('hex');
    db.sessions.push({ token, user_id: u!.id, device_id: dev, created_at: now(), last_seen: now(), active_seconds: 0, revoked: false });
    db.sessions = db.sessions.filter((s) => !s.revoked || Date.now() - Date.parse(s.last_seen) < 7 * 86400e3).slice(-2000);
    addEvent(db, u!.id, dev, 'login');
    return { token, user: uj(u!) };
  } },
  app_me: { write: true, run: (db, a) => uj(auth(db, a.p_token)) },
  app_me_update: { write: true, run: (db, a) => { // свои логин и пароль
    const u = auth(db, a.p_token);
    const login = str(a.p_login, 60).trim().toLowerCase();
    const oldP = str(a.p_password_old, 200), newP = str(a.p_password_new, 200);
    if (!checkPassword(oldP, u.hash)) fail('LOGIN');
    if (login && login !== u.login) { if (login.length < 3) fail('WEAK'); if (byLogin(db, login)) fail('EXISTS'); u.login = login; }
    if (newP) { if (newP.length < 6) fail('WEAK'); u.hash = hashPassword(newP); for (const s of db.sessions) if (s.user_id === u.id && s.token !== a.p_token) s.revoked = true; }
    return uj(u);
  } },
  app_logout: { write: true, run: (db, a) => { const s = db.sessions.find((x) => x.token === a.p_token); if (s) s.revoked = true; return null; } },
  app_heartbeat: { write: true, run: (db, a) => {
    const u = auth(db, a.p_token); const sec = int(a.p_seconds, 0, 600);
    const s = db.sessions.find((x) => x.token === a.p_token); if (s) s.active_seconds += sec;
    const d = device(db, str(a.p_device_id, 80), u.id); if (d) { d.active_seconds += sec; d.last_seen = now(); }
    return null;
  } },
  app_event: { write: true, run: (db, a) => {
    const u = auth(db, a.p_token); const dev = str(a.p_device_id, 80); const kind = str(a.p_kind, 40); const q = int(a.p_qty, 1, 1000, 1);
    addEvent(db, u.id, dev, kind, q, str(a.p_info, 200));
    const d = device(db, dev, u.id);
    if (d) { if (kind === 'book') d.books += q; if (kind === 'report') d.reports += q; d.last_seen = now(); }
    return null;
  } },
  app_admin_users: { write: true, run: (db, a) => { owner(db, a.p_token); return db.users.map((u) => ({ ...uj(u), ...stats(db, u.id) })).sort((x, y) => (y.last_seen ?? '').localeCompare(x.last_seen ?? '')); } },
  app_admin_create_user: { write: true, run: (db, a) => {
    owner(db, a.p_token);
    const login = str(a.p_login, 60).trim().toLowerCase(), pass = str(a.p_password, 200);
    if (login.length < 3 || pass.length < 6) fail('WEAK');
    if (byLogin(db, login)) fail('EXISTS');
    const u: User = { id: randomUUID(), login, hash: hashPassword(pass), name: str(a.p_name, 120), role: 'user', blocked: false, note: str(a.p_note, 200), created_at: now() };
    db.users.push(u); return uj(u);
  } },
  app_admin_set_blocked: { write: true, run: (db, a) => {
    const me = owner(db, a.p_token); if (a.p_user_id === me.id) fail('SELF');
    const u = db.users.find((x) => x.id === a.p_user_id); if (u) u.blocked = !!a.p_blocked;
    if (a.p_blocked) for (const s of db.sessions) if (s.user_id === a.p_user_id) s.revoked = true;
    return null;
  } },
  app_admin_set_password: { write: true, run: (db, a) => {
    owner(db, a.p_token); const pass = str(a.p_password, 200); if (pass.length < 6) fail('WEAK');
    const u = db.users.find((x) => x.id === a.p_user_id); if (u) u.hash = hashPassword(pass);
    for (const s of db.sessions) if (s.user_id === a.p_user_id) s.revoked = true;
    return null;
  } },
  app_admin_update_user: { write: true, run: (db, a) => {
    owner(db, a.p_token); const u = db.users.find((x) => x.id === a.p_user_id);
    if (u) { if (a.p_name != null) u.name = str(a.p_name, 120); if (a.p_note != null) u.note = str(a.p_note, 200); }
    return null;
  } },
  app_admin_delete_user: { write: true, run: (db, a) => {
    const me = owner(db, a.p_token); if (a.p_user_id === me.id) fail('SELF');
    const id = a.p_user_id as string;
    db.users = db.users.filter((u) => u.id !== id || u.role === 'owner');
    db.devices = db.devices.filter((d) => d.user_id !== id); db.sessions = db.sessions.filter((s) => s.user_id !== id); db.events = db.events.filter((e) => e.user_id !== id);
    return null;
  } },
  app_admin_devices: { write: true, run: (db, a) => { owner(db, a.p_token); return db.devices.filter((d) => d.user_id === a.p_user_id).sort((x, y) => y.last_seen.localeCompare(x.last_seen)); } },
  app_admin_events: { write: true, run: (db, a) => { owner(db, a.p_token); const lim = int(a.p_limit, 1, 500, 50); return db.events.filter((e) => e.user_id === a.p_user_id).slice(-lim).reverse(); } },
  app_admin_summary: { write: true, run: (db, a) => {
    owner(db, a.p_token); const ds = db.devices; const day = Date.now() - 86400e3;
    return { users: db.users.filter((u) => u.role === 'user').length, blocked: db.users.filter((u) => u.blocked).length, devices: ds.length,
      books: ds.reduce((x, d) => x + d.books, 0), reports: ds.reduce((x, d) => x + d.reports, 0), seconds: ds.reduce((x, d) => x + d.active_seconds, 0),
      active_today: new Set(db.sessions.filter((s) => Date.parse(s.last_seen) > day).map((s) => s.user_id)).size };
  } },
};

/* ---------- HTTP ---------- */

const cors = (origin: string | null) => ({
  'Access-Control-Allow-Origin': origin && ALLOWED.includes(origin) ? origin : ALLOWED[0],
  'Access-Control-Allow-Headers': 'content-type, apikey, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
});

export default async (req: Request, context: Context): Promise<Response> => {
  const headers = cors(req.headers.get('origin'));
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  const fn = context.params?.fn ?? '';
  const def = fns[fn];
  if (req.method !== 'POST' || !def) return new Response(JSON.stringify({ message: 'NOT_FOUND' }), { status: 404, headers });
  let args: Args = {};
  try { args = (await req.json()) as Args; } catch { /* без аргументов */ }
  try {
    const out = await withDb((db) => def.run(db, args), def.write);
    return new Response(JSON.stringify(out ?? null), { status: 200, headers });
  } catch (e) {
    const code = e instanceof RpcError ? e.code : 'ERR';
    if (code === 'LOGIN') await new Promise((r) => setTimeout(r, 300));
    return new Response(JSON.stringify({ message: code === 'ERR' ? `ERR ${(e as Error).message}` : code }), { status: code === 'ERR' ? 500 : 400, headers });
  }
};

export const config: Config = { path: '/rest/v1/rpc/:fn' };
