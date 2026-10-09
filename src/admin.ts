import './style.css';
import { loadConfig, rpc, deviceId, genPassword, fmtHours, fmtWhen, PlatformError, type PlatformConfig, type PlatformUser } from './platform/api.ts';

const LS_TOKEN = 'sor.session';
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const h = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface UserRow extends PlatformUser { devices: number; books: number; reports: number; seconds: number; last_seen: string | null }
interface Device { device_id: string; user_agent: string; label: string; first_seen: string; last_seen: string; active_seconds: number; reports: number; books: number }
interface Ev { id: number; device_id: string; kind: string; qty: number; info: string; at: string }
interface Summary { users: number; blocked: number; devices: number; books: number; reports: number; seconds: number; active_today: number }

let cfg: PlatformConfig;
let token = '';
let me: PlatformUser | null = null;
let users: UserRow[] = [];
let open: string | null = null; // раскрытый пользователь

const root = () => $('admin-root');
const KIND: Record<string, string> = { login: 'вход', book: 'книга Excel', report: 'лист класса', journal: 'журнал загружен' };
const ua = (s: string): string => {
  const os = /Windows/.test(s) ? 'Windows' : /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iOS' : /Mac OS/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : '';
  const br = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /YaBrowser/.test(s) ? 'Яндекс' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : /Firefox\//.test(s) ? 'Firefox' : '';
  return [os, br].filter(Boolean).join(' · ') || s.slice(0, 40);
};

async function main(): Promise<void> {
  const c = await loadConfig();
  if (!c) {
    root().innerHTML = `<section class="card"><h2>Платформа не настроена</h2><p>Создайте проект Supabase, выполните <code>supabase/schema.sql</code> и впишите адрес проекта и публичный ключ в <code>platform.json</code>. Пошагово — в файле PLATFORM.md.</p></section>`;
    return;
  }
  cfg = c;
  token = localStorage.getItem(LS_TOKEN) ?? '';
  if (token) {
    try { me = await rpc<PlatformUser>(cfg, 'app_me', { p_token: token }); } catch { token = ''; localStorage.removeItem(LS_TOKEN); }
  }
  if (!me) { await renderLogin(); return; }
  if (me.role !== 'owner') {
    root().innerHTML = `<section class="card"><h2>Доступ только основателю</h2><p>Вы вошли как <b>${h(me.login)}</b>. <a href="./">Перейти к отчётам</a> или <button class="btn small" id="relogin" type="button">выйти и войти как основатель</button></p></section>`;
    $('relogin').addEventListener('click', () => { localStorage.removeItem(LS_TOKEN); location.reload(); });
    return;
  }
  await renderDashboard();
}

async function renderLogin(): Promise<void> {
  let state = { has_owner: true };
  try { state = await rpc<{ has_owner: boolean }>(cfg, 'app_state'); } catch (e) { root().innerHTML = `<section class="card"><h2>Нет связи</h2><p>${h((e as Error).message)}</p></section>`; return; }
  const setup = !state.has_owner;
  root().innerHTML = `<section class="card narrow">
    <h2>${setup ? 'Первый запуск: создайте основателя' : 'Вход основателя'}</h2>
    ${setup ? '<p class="hint">Основателя ещё нет. Задайте логин и пароль — это будет единственный аккаунт с доступом сюда.</p>' : ''}
    <form id="f" class="gate-form">
      <label>Логин <input id="login" autocomplete="username" required autofocus /></label>
      <label>Пароль <input id="pass" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required minlength="6" /></label>
      <div class="gate-msg err" id="msg"></div>
      <button class="btn primary" type="submit">${setup ? 'Создать и войти' : 'Войти'}</button>
    </form></section>`;
  $('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const login = ($('login') as HTMLInputElement).value.trim(), pass = ($('pass') as HTMLInputElement).value;
    try {
      if (setup) await rpc(cfg, 'app_setup_owner', { p_login: login, p_password: pass });
      const r = await rpc<{ token: string; user: PlatformUser }>(cfg, 'app_login', { p_login: login, p_password: pass, p_device_id: deviceId(), p_user_agent: navigator.userAgent });
      token = r.token; me = r.user; localStorage.setItem(LS_TOKEN, token);
      if (me.role !== 'owner') { $('msg').textContent = 'Этот логин не основатель'; return; }
      await renderDashboard();
    } catch (err) { $('msg').textContent = (err as Error).message; }
  });
}

async function load(): Promise<Summary> {
  const [u, s] = await Promise.all([rpc<UserRow[]>(cfg, 'app_admin_users', { p_token: token }), rpc<Summary>(cfg, 'app_admin_summary', { p_token: token })]);
  users = u;
  return s;
}

async function renderDashboard(): Promise<void> {
  let s: Summary;
  try { s = await load(); } catch (e) { if (e instanceof PlatformError && e.code === 'AUTH') { localStorage.removeItem(LS_TOKEN); me = null; await renderLogin(); return; } root().innerHTML = `<section class="card"><p class="err">${h((e as Error).message)}</p></section>`; return; }
  const tile = (v: string | number, l: string) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`;
  const rows = users.map((u) => `<tr data-id="${u.id}" class="${u.blocked ? 'blocked' : ''} ${open === u.id ? 'open' : ''}">
      <td class="name"><b>${h(u.login)}</b>${u.role === 'owner' ? ' <span class="tag">основатель</span>' : ''}${u.blocked ? ' <span class="tag red">заблокирован</span>' : ''}<br><small>${h(u.name)}${u.note ? ' · ' + h(u.note) : ''}</small></td>
      <td>${u.devices}</td><td>${u.books}</td><td>${u.reports}</td><td>${fmtHours(u.seconds)}</td><td>${fmtWhen(u.last_seen)}</td>
      <td class="ops">${u.role === 'owner' ? '' : `<button class="mini" data-act="toggle" title="Устройства и действия">${open === u.id ? '▲' : '▼'}</button><button class="mini" data-act="block">${u.blocked ? 'Разблокировать' : 'Заблокировать'}</button><button class="mini" data-act="pass" title="Выдать новый пароль">Пароль</button><button class="mini" data-act="edit" title="Имя и заметка">✎</button><button class="mini danger" data-act="del" title="Удалить">✕</button>`}</td>
    </tr>${open === u.id ? `<tr class="detail"><td colspan="7" id="detail"><div class="empty">Загрузка…</div></td></tr>` : ''}`).join('');
  root().innerHTML = `
    <section class="card">
      <div class="actions"><span class="hint">Вы: <b>${h(me!.login)}</b></span><span class="sp"></span><button class="btn ghost small" id="refresh" type="button">Обновить</button><button class="btn ghost small" id="logout" type="button">Выйти</button></div>
      <div class="stats">${tile(s.users, 'пользователей')}${tile(s.active_today, 'активны за сутки')}${tile(s.devices, 'устройств')}${tile(s.books, 'книг Excel')}${tile(s.reports, 'листов-отчётов')}${tile(fmtHours(s.seconds), 'часов работы')}${tile(s.blocked, 'заблокировано')}</div>
    </section>
    <section class="card">
      <h2>Новый пользователь</h2>
      <form id="create" class="grid">
        <label>Логин <input id="c-login" required minlength="3" placeholder="например: ahmedova" /></label>
        <label>Имя / школа <input id="c-name" placeholder="Ахмедова М.М., школа 300" /></label>
        <label>Пароль <div class="row"><input id="c-pass" required minlength="6" /><button class="btn ghost" type="button" id="c-gen" title="Сгенерировать">⚄</button></div></label>
        <label>Заметка <input id="c-note" placeholder="предмет, классы…" /></label>
        <div class="full actions"><button class="btn primary" type="submit">Создать</button><span class="gate-msg" id="c-msg"></span></div>
      </form>
      <div id="issued" class="issued" hidden></div>
    </section>
    <section class="card">
      <h2>Мои настройки</h2>
      <form id="meform" class="grid">
        <label>Мой логин <input id="m-login" value="${h(me!.login)}" minlength="3" /></label>
        <label>Текущий пароль <input id="m-old" type="password" autocomplete="current-password" required /></label>
        <label>Новый пароль <small>пусто — не менять</small><input id="m-new" type="password" autocomplete="new-password" /></label>
        <div class="actions" style="align-items:end"><button class="btn" type="submit">Сохранить</button><span class="gate-msg" id="m-msg"></span></div>
      </form>
    </section>
    <section class="card">
      <h2>Пользователи</h2>
      <div class="preview"><table class="rep adm"><thead><tr><th>Логин</th><th>Устройств</th><th>Книг</th><th>Листов</th><th>Часов</th><th>Был(а)</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`;
  $('refresh').addEventListener('click', () => void renderDashboard());
  $('logout').addEventListener('click', async () => { try { await rpc(cfg, 'app_logout', { p_token: token }); } catch { /* ignore */ } localStorage.removeItem(LS_TOKEN); location.reload(); });
  ($('c-pass') as HTMLInputElement).value = genPassword();
  $('c-gen').addEventListener('click', () => { ($('c-pass') as HTMLInputElement).value = genPassword(); });
  $('create').addEventListener('submit', async (e) => {
    e.preventDefault();
    const login = ($('c-login') as HTMLInputElement).value.trim(), pass = ($('c-pass') as HTMLInputElement).value;
    try {
      const u = await rpc<PlatformUser>(cfg, 'app_admin_create_user', { p_token: token, p_login: login, p_password: pass, p_name: ($('c-name') as HTMLInputElement).value.trim(), p_note: ($('c-note') as HTMLInputElement).value.trim() });
      await renderDashboard();
      showIssued(u.login, pass);
    } catch (err) { $('c-msg').className = 'gate-msg err'; $('c-msg').textContent = (err as Error).message; }
  });
  $('meform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('m-msg'); msg.className = 'gate-msg';
    try {
      const u = await rpc<PlatformUser>(cfg, 'app_me_update', { p_token: token, p_login: ($('m-login') as HTMLInputElement).value.trim(), p_password_old: ($('m-old') as HTMLInputElement).value, p_password_new: ($('m-new') as HTMLInputElement).value });
      me = u; msg.textContent = 'Сохранено'; ($('m-old') as HTMLInputElement).value = ''; ($('m-new') as HTMLInputElement).value = '';
    } catch (err) { msg.className = 'gate-msg err'; msg.textContent = (err as Error).message; }
  });
  root().querySelector('tbody')!.addEventListener('click', onUserAction);
  if (open) void renderDetail(open);
}

function showIssued(login: string, pass: string): void {
  const box = $('issued');
  const link = new URL('./', location.href).toString();
  box.hidden = false;
  box.innerHTML = `<b>Выдайте пользователю:</b><div class="issued-box"><div>Ссылка: <code>${h(link)}</code></div><div>Логин: <code>${h(login)}</code></div><div>Пароль: <code>${h(pass)}</code></div></div><button class="btn small" type="button" id="copy">Скопировать</button><span class="hint"> Пароль показывается один раз — потом его можно только заменить.</span>`;
  $('copy').addEventListener('click', () => { void navigator.clipboard?.writeText(`Отчёты СОР/СОЧ\n${link}\nЛогин: ${login}\nПароль: ${pass}`); });
}

async function onUserAction(e: Event): Promise<void> {
  const b = (e.target as HTMLElement).closest('button[data-act]') as HTMLElement | null; if (!b) return;
  const tr = b.closest('tr') as HTMLElement; const id = tr.dataset.id!; const u = users.find((x) => x.id === id); if (!u) return;
  const act = b.dataset.act;
  try {
    if (act === 'toggle') { open = open === id ? null : id; await renderDashboard(); return; }
    if (act === 'block') { if (!u.blocked && !confirm(`Заблокировать ${u.login}? Все его сессии будут завершены.`)) return; await rpc(cfg, 'app_admin_set_blocked', { p_token: token, p_user_id: id, p_blocked: !u.blocked }); }
    else if (act === 'pass') { const pass = genPassword(); if (!confirm(`Выдать ${u.login} новый пароль? Старый перестанет работать.`)) return; await rpc(cfg, 'app_admin_set_password', { p_token: token, p_user_id: id, p_password: pass }); await renderDashboard(); showIssued(u.login, pass); return; }
    else if (act === 'edit') { const name = prompt('Имя / школа:', u.name); if (name == null) return; const note = prompt('Заметка:', u.note) ?? u.note; await rpc(cfg, 'app_admin_update_user', { p_token: token, p_user_id: id, p_name: name, p_note: note }); }
    else if (act === 'del') { if (!confirm(`Удалить ${u.login} со всей историей?`)) return; await rpc(cfg, 'app_admin_delete_user', { p_token: token, p_user_id: id }); if (open === id) open = null; }
    await renderDashboard();
  } catch (err) { alert((err as Error).message); }
}

async function renderDetail(id: string): Promise<void> {
  const cell = document.getElementById('detail'); if (!cell) return;
  try {
    const [devs, evs] = await Promise.all([rpc<Device[]>(cfg, 'app_admin_devices', { p_token: token, p_user_id: id }), rpc<Ev[]>(cfg, 'app_admin_events', { p_token: token, p_user_id: id, p_limit: 40 })]);
    cell.innerHTML = `<div class="detail-grid">
      <div><b>Устройства (${devs.length})</b><table class="mini-t"><thead><tr><th>Устройство</th><th>Книг</th><th>Листов</th><th>Часов</th><th>Первый вход</th><th>Последний</th></tr></thead><tbody>
        ${devs.map((d) => `<tr><td title="${h(d.device_id)}">${h(ua(d.user_agent))}<br><small>${h(d.device_id.slice(0, 8))}…</small></td><td>${d.books}</td><td>${d.reports}</td><td>${fmtHours(d.active_seconds)}</td><td>${fmtWhen(d.first_seen)}</td><td>${fmtWhen(d.last_seen)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">ещё не входил(а)</td></tr>'}
      </tbody></table></div>
      <div><b>Последние действия</b><table class="mini-t"><tbody>
        ${evs.map((ev) => `<tr><td>${fmtWhen(ev.at)}</td><td>${h(KIND[ev.kind] ?? ev.kind)}${ev.qty > 1 ? ` ×${ev.qty}` : ''}</td><td><small>${h(ev.info)}</small></td></tr>`).join('') || '<tr><td class="empty">пока нет</td></tr>'}
      </tbody></table></div></div>`;
  } catch (err) { cell.innerHTML = `<span class="err">${h((err as Error).message)}</span>`; }
}

void main();
