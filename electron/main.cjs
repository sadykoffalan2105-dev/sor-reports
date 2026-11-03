// Приложение для Windows (exe): то же, что сайт, но работает без браузера и без интернета.
// Страница грузится из собранной папки dist по протоколу app:// (модули, IndexedDB и микрофон работают).
const { app, BrowserWindow, protocol, session, net, shell, Menu, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');

// Голосовая база имён: проговорить фамилии голосом Windows в WAV 16 кГц — их потом слушает распознаватель на странице.
const SYNTH_PS = `Add-Type -AssemblyName System.Speech
$dir = $args[0]
$texts = Get-Content -Encoding UTF8 (Join-Path $dir 'texts.json') | ConvertFrom-Json
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$ru = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'ru*' } | Select-Object -First 1
if ($ru) { $s.SelectVoice($ru.VoiceInfo.Name) }
$i = 0
foreach ($t in $texts) { $s.SetOutputToWaveFile((Join-Path $dir ("$i.wav")), $fmt); $s.Speak([string]$t); $s.SetOutputToNull(); $i++ }
$s.Dispose()`;
ipcMain.handle('synth', async (_e, texts) => {
  if (!Array.isArray(texts) || texts.length > 400) throw new Error('bad request');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sor-voice-'));
  try {
    fs.writeFileSync(path.join(dir, 'texts.json'), JSON.stringify(texts.map(String)), 'utf8');
    fs.writeFileSync(path.join(dir, 'synth.ps1'), '\ufeff' + SYNTH_PS, 'utf8');
    await new Promise((res, rej) => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'synth.ps1'), dir], { windowsHide: true, timeout: 180000 }, (err) => (err ? rej(err) : res())));
    return texts.map((_, i) => { const f = path.join(dir, `${i}.wav`); return fs.existsSync(f) ? fs.readFileSync(f) : new Uint8Array(0); });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
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
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false, preload: path.join(__dirname, 'preload.cjs') },
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
