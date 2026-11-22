/** Вход на сайт отчётов по логину/паролю, выданному основателем; учёт времени и действий. */
import { loadConfig, rpc, deviceId, PlatformError, type PlatformConfig, type PlatformUser } from './api.ts';

const LS_TOKEN = 'sor.session';
const LS_USER = 'sor.user'; // кто входил на этом устройстве — чтобы работа не останавливалась без связи с сервером
const HEARTBEAT_SEC = 60;

interface GateState { cfg: PlatformConfig; token: string; user: PlatformUser; device: string; offline?: boolean }
let gate: GateState | null = null;

const h = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Отметить действие пользователя (книга, отчёт, журнал). Без платформы — ничего. */
export function track(kind: 'book' | 'report' | 'journal', qty = 1, info = ''): void {
  if (!gate || gate.offline) return;
  void rpc(gate.cfg, 'app_event', { p_token: gate.token, p_device_id: gate.device, p_kind: kind, p_qty: qty, p_info: info }).catch(() => undefined);
}

export const currentUser = (): PlatformUser | null => gate?.user ?? null;

/** Показать экран входа, если платформа настроена; иначе сайт работает свободно. */
export async function initGate(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg) return;
  const device = deviceId();
  const saved = localStorage.getItem(LS_TOKEN) ?? '';
  if (saved) {
    try {
      const user = await rpc<PlatformUser>(cfg, 'app_me', { p_token: saved });
      localStorage.setItem(LS_USER, JSON.stringify(user));
      enter({ cfg, token: saved, user, device });
      return;
    } catch (e) {
      if (!(e instanceof PlatformError) || !['AUTH', 'BLOCKED', 'LOGIN'].includes(e.code)) { // сервер недоступен или спит
        const known = knownUser();
        if (known) { enter({ cfg, token: saved, user: known, device, offline: true }); retryLater(cfg, saved, device); return; }
        showOffline(e as Error); return;
      }
      localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_USER);
    }
  }
  showLogin(cfg, device);
}

const knownUser = (): PlatformUser | null => { try { return JSON.parse(localStorage.getItem(LS_USER) ?? 'null') as PlatformUser | null; } catch { return null; } };
/** Сервер был недоступен: тихо проверяем раз в 2 минуты и возвращаемся в обычный режим. */
function retryLater(cfg: PlatformConfig, token: string, device: string): void {
  const t = setInterval(async () => {
    try {
      const user = await rpc<PlatformUser>(cfg, 'app_me', { p_token: token });
      clearInterval(t); localStorage.setItem(LS_USER, JSON.stringify(user)); gate = { cfg, token, user, device }; renderChip();
    } catch (e) {
      if (e instanceof PlatformError && ['AUTH', 'BLOCKED'].includes(e.code)) { clearInterval(t); localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_USER); gate = null; showLogin(cfg, device, e.message); }
    }
  }, 120000);
}

function overlay(inner: string): HTMLElement {
  let el = document.getElementById('gate');
  if (!el) { el = document.createElement('div'); el.id = 'gate'; el.className = 'gate'; document.body.appendChild(el); }
  el.innerHTML = `<div class="gate-card">${inner}</div>`;
  document.body.classList.add('gated');
  return el;
}

function showOffline(e: Error): void {
  overlay(`<h2>Нет связи с платформой</h2><p class="hint">${h(e.message)}</p><button class="btn primary" id="gate-retry" type="button">Повторить</button>`);
  document.getElementById('gate-retry')!.addEventListener('click', () => location.reload());
}

function showLogin(cfg: PlatformConfig, device: string, msg = ''): void {
  overlay(`<h2>Вход в «Отчёты СОР / СОЧ»</h2>
    <p class="hint">Логин и пароль выдаёт основатель платформы.</p>
    <form id="gate-form" class="gate-form">
      <label>Логин <input id="gate-login" autocomplete="username" required autofocus /></label>
      <label>Пароль <input id="gate-pass" type="password" autocomplete="current-password" required /></label>
      <div class="gate-msg ${msg ? 'err' : ''}" id="gate-msg">${h(msg)}</div>
      <button class="btn primary" type="submit" id="gate-submit">Войти</button>
    </form>`);
  const form = document.getElementById('gate-form') as HTMLFormElement;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('gate-submit') as HTMLButtonElement;
    const msgEl = document.getElementById('gate-msg')!;
    btn.disabled = true; msgEl.className = 'gate-msg'; msgEl.textContent = 'Проверяю…';
    try {
      const r = await rpc<{ token: string; user: PlatformUser }>(cfg, 'app_login', {
        p_login: (document.getElementById('gate-login') as HTMLInputElement).value.trim(),
        p_password: (document.getElementById('gate-pass') as HTMLInputElement).value,
        p_device_id: device, p_user_agent: navigator.userAgent,
      });
      localStorage.setItem(LS_TOKEN, r.token); localStorage.setItem(LS_USER, JSON.stringify(r.user));
      enter({ cfg, token: r.token, user: r.user, device });
    } catch (err) {
      msgEl.className = 'gate-msg err'; msgEl.textContent = (err as Error).message; btn.disabled = false;
    }
  });
}

function enter(s: GateState): void {
  gate = s;
  document.getElementById('gate')?.remove();
  document.body.classList.remove('gated');
  renderChip();
  startHeartbeat();
}

/** Плашка «вы вошли как …» в шапке сайта. */
function renderChip(): void {
  if (!gate) return;
  let chip = document.getElementById('user-chip');
  if (!chip) { chip = document.createElement('div'); chip.id = 'user-chip'; chip.className = 'user-chip'; document.querySelector('.top .wrap')?.appendChild(chip); }
  chip.innerHTML = `<span>${h(gate.user.name || gate.user.login)}</span>${gate.offline ? '<span class="off" title="Нет связи с сервером платформы — работа продолжается, учёт времени возобновится сам">без связи</span>' : ''}${gate.user.role === 'owner' ? '<a href="admin.html">Платформа</a>' : ''}<button type="button" id="gate-logout">Выйти</button>`;
  document.getElementById('gate-logout')!.addEventListener('click', async () => {
    const g = gate; if (!g) return;
    try { await rpc(g.cfg, 'app_logout', { p_token: g.token }); } catch { /* всё равно выходим */ }
    localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_USER); location.reload();
  });
}

/** Раз в минуту, пока вкладка видна: +60 секунд работы устройству. */
function startHeartbeat(): void {
  let lastTick = Date.now();
  setInterval(() => {
    if (!gate || gate.offline || document.visibilityState !== 'visible') { lastTick = Date.now(); return; }
    const sec = Math.min(600, Math.round((Date.now() - lastTick) / 1000));
    lastTick = Date.now();
    void rpc(gate.cfg, 'app_heartbeat', { p_token: gate.token, p_device_id: gate.device, p_seconds: sec }).catch((e: unknown) => {
      if (e instanceof PlatformError && (e.code === 'AUTH' || e.code === 'BLOCKED')) { localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_USER); gate = null; showLogin(gateCfg!, deviceId(), e.message); }
    });
  }, HEARTBEAT_SEC * 1000);
  gateCfg = gate?.cfg ?? null;
}
let gateCfg: PlatformConfig | null = null;
