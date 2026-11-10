const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');

const profileArg = process.argv.find(arg => arg.startsWith('--profile='));
const profile = profileArg?.slice('--profile='.length);
if (profile && !/^[a-zA-Z0-9_-]{1,32}$/.test(profile)) {
  console.error('Profile must be 1–32 letters, numbers, underscores, or hyphens.');
  process.exit(1);
}
if (profile) app.setPath('userData', path.join(app.getPath('userData'), 'profiles', profile));

const origin = process.env.RENDEZ_SERVER_URL || 'http://127.0.0.1:4317';
const parsed = new URL(origin);
if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
  console.error('RENDEZ_SERVER_URL must be a local HTTP address.');
  process.exit(1);
}
let window;
let retryTimer;
function openApp() {
  if (!window || window.isDestroyed()) return;
  window.loadURL(parsed.origin).catch(() => {
    if (!window || window.isDestroyed()) return;
    const page = `<!doctype html><meta charset="utf-8"><title>Rendez — server offline</title><style>body{font:16px Segoe UI,sans-serif;background:#f5f5f5;color:#171717;min-height:80vh;display:grid;place-items:center}.card{max-width:430px;background:white;border:1px solid #ddd;padding:32px;border-radius:10px}h1{font-size:24px}code{background:#eee;padding:3px 5px}</style><div class="card"><h1>Rendez server is offline</h1><p>Start the server with <code>npm run server</code> in the Rendez folder. This window will reconnect automatically.</p><p>Server: ${parsed.origin}</p></div>`;
    window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
    clearTimeout(retryTimer);
    retryTimer = setTimeout(openApp, 2500);
  });
}
function createWindow() {
  window = new BrowserWindow({
    width: 1480, height: 940, minWidth: 760, minHeight: 580,
    backgroundColor: '#f5f5f5', title: `Rendez${profile ? ' — ' + profile : ''}`,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(parsed.origin + '/')) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.on('closed', () => { clearTimeout(retryTimer); window = null; });
  openApp();
}
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
