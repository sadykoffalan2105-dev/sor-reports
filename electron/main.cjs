// Приложение для Windows (exe): то же, что сайт, но работает без браузера и без интернета.
// Страница грузится из собранной папки dist по протоколу app:// (модули, IndexedDB и микрофон работают).
const { app, BrowserWindow, protocol, session, net, shell, Menu } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const DIST = path.join(__dirname, '..', 'dist');

function createWindow() {
  const win = new BrowserWindow({
    width: 1300, height: 900, minWidth: 900, minHeight: 600,
    title: 'Отчёты СОР / СОЧ',
    icon: path.join(DIST, 'icons', 'icon-512.png'),
    autoHideMenuBar: true,
    backgroundColor: '#f4f6f8',
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false },
  });
  win.loadURL('app://local/index.html');
  // внешние ссылки — в обычном браузере
  win.webContents.setWindowOpenHandler(({ url }) => { if (!url.startsWith('app://')) shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    let p = decodeURIComponent(new URL(req.url).pathname);
    if (!p || p === '/') p = '/index.html';
    const file = path.normalize(path.join(DIST, p));
    if (!file.startsWith(DIST)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  // микрофон для голосового ввода — разрешён
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media' || perm === 'clipboard-sanitized-write'));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === 'media');
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
