import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import { DaemonError, ensureDaemon, resolveRepo, type DaemonHandle } from './daemon.js';

const here = dirname(fileURLToPath(import.meta.url));

let daemon: DaemonHandle | null = null;
let win: BrowserWindow | null = null;

/* ------------------------------------------------------------------ */
/* the avatar, used for the dock (macOS) and the window (win/linux)     */
/* ------------------------------------------------------------------ */

function iconPath(): string | null {
  const candidates = [
    join(here, '..', 'build', 'icon.png'), // generated next to the icns
    join(resolveRepo() ?? '', 'packages', 'web', 'public', 'leon.png'),
    join(process.resourcesPath ?? '', 'leon.png'),
  ];
  return candidates.find((path) => path.length > 0 && existsSync(path)) ?? null;
}

/* ------------------------------------------------------------------ */
/* window bounds, so the app opens where you left it                    */
/* ------------------------------------------------------------------ */

interface Bounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

function boundsFile(): string {
  const dataDir = process.env.LEON_DATA_DIR ?? join(app.getPath('home'), '.leon');
  mkdirSync(dataDir, { recursive: true });
  return join(dataDir, 'desktop-window.json');
}

function loadBounds(): Bounds {
  try {
    const saved = JSON.parse(readFileSync(boundsFile(), 'utf8')) as Bounds;
    if (typeof saved.width === 'number' && typeof saved.height === 'number') return saved;
  } catch {
    /* first run, or a stale file — fall through to the default */
  }
  return { width: 1440, height: 900 };
}

function saveBounds(window: BrowserWindow): void {
  if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
  try {
    writeFileSync(boundsFile(), JSON.stringify(window.getNormalBounds()));
  } catch {
    /* not worth bothering the user about */
  }
}

/* ------------------------------------------------------------------ */
/* boot splash — shown while the daemon comes up                        */
/* ------------------------------------------------------------------ */

const SPLASH = `<!doctype html>
<meta charset="utf-8" />
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; height: 100vh; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 14px;
    background: #242938; color: #eef1f8;
    font: 13px -apple-system, system-ui, sans-serif;
  }
  .wm { font: 700 15px ui-monospace, Menlo, monospace; letter-spacing: 0.3em; color: #f2b95c; }
  .status { font: 11.5px ui-monospace, Menlo, monospace; color: #b6bed2; }
  pre {
    max-width: 76vw; max-height: 34vh; overflow: auto; margin: 0;
    padding: 8px 10px; border: 1px solid #465073; background: #293043;
    font: 10.5px/1.5 ui-monospace, Menlo, monospace; color: #8891ab;
    white-space: pre-wrap; display: none;
  }
</style>
<div class="wm">LEON</div>
<div class="status" id="status">starting the daemon…</div>
<pre id="log"></pre>
<script>
  window.leonStatus = (text) => { document.getElementById('status').textContent = text; };
  window.leonLog = (line) => {
    const log = document.getElementById('log');
    log.style.display = 'block';
    log.textContent = (log.textContent + '\\n' + line).trim().split('\\n').slice(-12).join('\\n');
    log.scrollTop = log.scrollHeight;
  };
</script>`;

function splash(fn: 'leonStatus' | 'leonLog', text: string): void {
  // `pnpm desktop` runs in a terminal — mirror the boot there too
  console.log(`[leon] ${text}`);
  if (!win || win.isDestroyed()) return;
  win.webContents
    .executeJavaScript(`window.${fn}?.(${JSON.stringify(text)})`)
    .catch(() => undefined);
}

/* ------------------------------------------------------------------ */
/* menu — mostly roles; the app's own nav lives in the web UI           */
/* ------------------------------------------------------------------ */

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([{ role: 'appMenu' }] satisfies MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Board in Browser',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => {
            if (daemon) void shell.openExternal(`${daemon.config.baseUrl}/?token=${daemon.config.token}`);
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ */
/* window                                                              */
/* ------------------------------------------------------------------ */

function createWindow(): BrowserWindow {
  const bounds = loadBounds();
  const icon = iconPath();
  const window = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#242938',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // centred in the app's 44px header (≈49 real px once #root's zoom applies)
    trafficLightPosition: process.platform === 'darwin' ? { x: 12, y: 18 } : undefined,
    title: 'Leon',
    ...(icon && process.platform !== 'darwin' ? { icon } : {}),
    webPreferences: {
      // the renderer is the plain web app — it talks to the daemon over
      // HTTP/WS like the browser build does and needs no Node access
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false,
    },
  });

  // PR/Jira links and anything off-origin belong in the real browser
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    const base = daemon ? new URL(daemon.config.baseUrl) : null;
    if (base && target.host === base.host) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  window.on('close', () => saveBounds(window));
  window.on('resized', () => saveBounds(window));
  window.on('moved', () => saveBounds(window));
  window.on('closed', () => {
    win = null;
  });

  return window;
}

/** Boot: splash → daemon (attach or start) → the board. */
async function boot(): Promise<void> {
  win = createWindow();
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SPLASH)}`);

  try {
    daemon = await ensureDaemon((line) => splash('leonLog', line));
  } catch (error) {
    const failure =
      error instanceof DaemonError
        ? { message: error.message, detail: error.detail }
        : { message: 'Leon could not start', detail: String(error) };
    splash('leonStatus', failure.message);
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: 'Leon',
      message: failure.message,
      detail: failure.detail,
      buttons: ['Retry', 'Quit'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      await boot();
      return;
    }
    app.quit();
    return;
  }

  splash('leonStatus', 'opening the board…');
  // the token rides in once; the web app stores it and strips it from the URL
  await win.loadURL(`${daemon.config.baseUrl}/?token=${daemon.config.token}`);
  console.log(`[leon] board loaded — ${win.webContents.getURL()}`);
}

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */

// a dev run would otherwise call itself "Electron" in the menu bar and dock
app.setName('Leon');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    if (process.platform === 'darwin') {
      const icon = iconPath();
      // the dock icon for a dev run; a packaged build uses the bundle's icns
      if (icon) app.dock?.setIcon(nativeImage.createFromPath(icon));
    }
    buildMenu();
    await boot();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void boot();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // only stop what we started — a daemon running in tmux outlives the app
  app.on('before-quit', () => {
    daemon?.child?.kill('SIGTERM');
  });
}
