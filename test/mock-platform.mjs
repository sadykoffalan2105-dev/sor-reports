// Имитация Supabase RPC для локальной проверки платформы: node test/mock-platform.mjs (порт 4711).
// Повторяет логику supabase/schema.sql в памяти. Только для разработки.
import http from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';

const users = new Map(); // id → user
const devices = new Map(); // device_id|user_id → device
const sessions = new Map(); // token → session
const events = [];
const fail = (code) => { const e = new Error(code); e.rpc = true; throw e; };
const uj = (u) => ({ id: u.id, login: u.login, name: u.name, role: u.role, blocked: u.blocked, note: u.note, created_at: u.created_at });
const auth = (t) => { const s = sessions.get(t); if (!s || s.revoked) fail('AUTH'); const u = users.get(s.user_id); if (!u) fail('AUTH'); if (u.blocked) fail('BLOCKED'); s.last_seen = new Date().toISOString(); return u; };
const owner = (t) => { const u = auth(t); if (u.role !== 'owner') fail('FORBIDDEN'); return u; };
const byLogin = (l) => [...users.values()].find((u) => u.login === l.trim().toLowerCase());
const devKey = (d, u) => `${d}|${u}`;

const fns = {
  app_state: () => ({ has_owner: [...users.values()].some((u) => u.role === 'owner') }),
  app_setup_owner: ({ p_login, p_password }) => { if (fns.app_state().has_owner) fail('OWNER_EXISTS'); if (p_login.trim().length < 3 || p_password.length < 6) fail('WEAK'); const u = { id: randomUUID(), login: p_login.trim().toLowerCase(), pass: p_password, name: 'Основатель', role: 'owner', blocked: false, note: '', created_at: new Date().toISOString() }; users.set(u.id, u); return uj(u); },
  app_login: ({ p_login, p_password, p_device_id, p_user_agent }) => {
    const u = byLogin(p_login); if (!u || u.pass !== p_password) fail('LOGIN'); if (u.blocked) fail('BLOCKED');
    const k = devKey(p_device_id, u.id); const d = devices.get(k) ?? { device_id: p_device_id, user_id: u.id, user_agent: '', label: '', first_seen: new Date().toISOString(), last_seen: '', active_seconds: 0, reports: 0, books: 0 };
    d.user_agent = (p_user_agent ?? '').slice(0, 300); d.last_seen = new Date().toISOString(); devices.set(k, d);
    const t = randomBytes(32).toString('hex'); sessions.set(t, { token: t, user_id: u.id, device_id: p_device_id, revoked: false, last_seen: d.last_seen, active_seconds: 0 });
    events.push({ id: events.length + 1, user_id: u.id, device_id: p_device_id, kind: 'login', qty: 1, info: '', at: new Date().toISOString() });
    return { token: t, user: uj(u) };
  },
  app_me: ({ p_token }) => uj(auth(p_token)),
  app_logout: ({ p_token }) => { const s = sessions.get(p_token); if (s) s.revoked = true; return null; },
  app_heartbeat: ({ p_token, p_device_id, p_seconds }) => { const u = auth(p_token); const s = Math.min(600, Math.max(0, p_seconds | 0)); const d = devices.get(devKey(p_device_id, u.id)); if (d) { d.active_seconds += s; d.last_seen = new Date().toISOString(); } return null; },
  app_event: ({ p_token, p_device_id, p_kind, p_qty, p_info }) => { const u = auth(p_token); const q = Math.min(1000, Math.max(1, p_qty | 0)); events.push({ id: events.length + 1, user_id: u.id, device_id: p_device_id, kind: p_kind, qty: q, info: p_info ?? '', at: new Date().toISOString() }); const d = devices.get(devKey(p_device_id, u.id)); if (d) { if (p_kind === 'book') d.books += q; if (p_kind === 'report') d.reports += q; } return null; },
  app_admin_users: ({ p_token }) => { owner(p_token); return [...users.values()].map((u) => { const ds = [...devices.values()].filter((d) => d.user_id === u.id); return { ...uj(u), devices: ds.length, books: ds.reduce((a, d) => a + d.books, 0), reports: ds.reduce((a, d) => a + d.reports, 0), seconds: ds.reduce((a, d) => a + d.active_seconds, 0), last_seen: ds.map((d) => d.last_seen).sort().at(-1) ?? null }; }); },
  app_admin_create_user: ({ p_token, p_login, p_password, p_name, p_note }) => { owner(p_token); if (p_login.trim().length < 3 || p_password.length < 6) fail('WEAK'); if (byLogin(p_login)) fail('EXISTS'); const u = { id: randomUUID(), login: p_login.trim().toLowerCase(), pass: p_password, name: p_name ?? '', role: 'user', blocked: false, note: p_note ?? '', created_at: new Date().toISOString() }; users.set(u.id, u); return uj(u); },
  app_admin_set_blocked: ({ p_token, p_user_id, p_blocked }) => { const me = owner(p_token); if (me.id === p_user_id) fail('SELF'); const u = users.get(p_user_id); if (u) u.blocked = !!p_blocked; if (p_blocked) for (const s of sessions.values()) if (s.user_id === p_user_id) s.revoked = true; return null; },
  app_admin_set_password: ({ p_token, p_user_id, p_password }) => { owner(p_token); if (p_password.length < 6) fail('WEAK'); const u = users.get(p_user_id); if (u) u.pass = p_password; for (const s of sessions.values()) if (s.user_id === p_user_id) s.revoked = true; return null; },
  app_admin_update_user: ({ p_token, p_user_id, p_name, p_note }) => { owner(p_token); const u = users.get(p_user_id); if (u) { if (p_name != null) u.name = p_name; if (p_note != null) u.note = p_note; } return null; },
  app_admin_delete_user: ({ p_token, p_user_id }) => { const me = owner(p_token); if (me.id === p_user_id) fail('SELF'); const u = users.get(p_user_id); if (u && u.role !== 'owner') users.delete(p_user_id); return null; },
  app_admin_devices: ({ p_token, p_user_id }) => { owner(p_token); return [...devices.values()].filter((d) => d.user_id === p_user_id); },
  app_admin_events: ({ p_token, p_user_id, p_limit }) => { owner(p_token); return events.filter((e) => e.user_id === p_user_id).slice(-(p_limit || 50)).reverse(); },
  app_admin_summary: ({ p_token }) => { owner(p_token); const ds = [...devices.values()]; return { users: [...users.values()].filter((u) => u.role === 'user').length, blocked: [...users.values()].filter((u) => u.blocked).length, devices: ds.length, books: ds.reduce((a, d) => a + d.books, 0), reports: ds.reduce((a, d) => a + d.reports, 0), seconds: ds.reduce((a, d) => a + d.active_seconds, 0), active_today: new Set([...sessions.values()].map((s) => s.user_id)).size }; },
};

const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, apikey, authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  const m = req.url?.match(/^\/rest\/v1\/rpc\/(\w+)$/);
  if (!m || req.method !== 'POST' || !fns[m[1]]) { res.writeHead(404, cors); res.end('{"message":"not found"}'); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    try {
      const out = fns[m[1]](body ? JSON.parse(body) : {});
      res.writeHead(200, cors); res.end(JSON.stringify(out ?? null));
    } catch (e) {
      res.writeHead(400, cors); res.end(JSON.stringify({ message: e.rpc ? e.message : 'ERR ' + e.message }));
    }
  });
});
server.listen(4711, '127.0.0.1', () => console.log('mock platform on http://127.0.0.1:4711'));
