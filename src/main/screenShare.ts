import {
  app,
  session,
  desktopCapturer,
  BrowserWindow,
  ipcMain,
  nativeImage,
} from 'electron';
import * as fs from 'fs';
import * as path from 'path';

type SourceLite = {
  id: string;
  name: string;
  thumbnailDataURL: string;
  type: 'screen' | 'window';
};

let pickerWin: BrowserWindow | null = null;
let installed = false;
let preloadPath: string;

/** Простой preload-мост для sandbox/CI */
const PRELOAD_CODE = `
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  ready: () => ipcRenderer.send('mm-picker:ready'),
  onSources: (cb) => ipcRenderer.on('mm-picker:sources', (_ev, payload) => cb(payload)),
  choose: (id) => ipcRenderer.send('mm-picker:choose', id),
  cancel: () => ipcRenderer.send('mm-picker:cancel'),
  toggleFullscreen: () => ipcRenderer.send('mm-picker:toggle-fullscreen'),
});
`;

function ensurePreload(): string {
  if (preloadPath && fs.existsSync(preloadPath)) return preloadPath;
  const dir = path.join(app.getPath('userData'), 'picker-preload');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { }
  preloadPath = path.join(dir, 'preload.js');
  try { fs.writeFileSync(preloadPath, PRELOAD_CODE, 'utf8'); } catch { }
  return preloadPath;
}

function createPickerWindow(parent?: BrowserWindow): BrowserWindow {
  const preload = ensurePreload();

  const win = new BrowserWindow({
    width: Math.round((parent?.getBounds().width ?? 1200) * 0.6),
    height: Math.round((parent?.getBounds().height ?? 800) * 0.6),
    modal: !!parent,
    parent,
    show: false,
    title: 'Select what to share',
    resizable: true,
    minimizable: false,
    maximizable: true,
    closable: true,
    frame: false,
    backgroundColor: '#20232a',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload,
    },
  });

  const html = `
  <!doctype html><html>
  <head>
    <meta charset="utf-8" />
    <title>Share your screen</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' data:;">
    <style>
      :root { --fg:#e6e6e6; --muted:#9aa0a6; --accent:#4f8cff; --bg:#20232a; --card:#2a2f38; }
      * { box-sizing:border-box; }
      html, body { height:100%; margin:0; }
      body {
        background:var(--bg); color:var(--fg);
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
        display:flex; flex-direction:column; min-height:100vh;
        -webkit-user-select:none;
        -webkit-app-region: no-drag;
      }
      .titlebar {
        height:44px; flex:0 0 auto;
        display:flex; align-items:center; justify-content:space-between;
        padding:0 10px;
        -webkit-app-region: drag;
        background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(0,0,0,.06));
        border-bottom: 1px solid rgba(255,255,255,.08);
      }
      .tb-left, .tb-right { display:flex; gap:8px; align-items:center; }
      .tb-left *, .tb-right * { -webkit-app-region: no-drag; }
      .btn {
        width:36px; height:36px; border-radius:18px; display:flex; align-items:center; justify-content:center;
        background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.10); cursor:pointer;
      }
      .btn:hover { background:rgba(255,255,255,.14); }
      .btn.primary { width:auto; padding:0 14px; border-radius:18px; color:white; background:var(--accent); border-color:rgba(0,0,0,.2); }
      .btn.primary:disabled { opacity:.5; cursor:default; }
      .pill { font-size:11px; color:var(--muted); margin-left:6px; padding:2px 6px; border:1px solid rgba(255,255,255,.12); border-radius:999px; }

      .content {
        flex:1 1 auto; display:flex; gap:14px; padding:14px;
        overflow:hidden;
      }
      .col { flex:1 1 0; display:flex; flex-direction:column; min-width:0; }
      .label { font-size:12px; color:var(--muted); margin:4px 2px; text-transform:uppercase; letter-spacing:.06em; }
      .grid {
        flex:1 1 0; overflow:auto; padding-bottom:6px;
        display:grid; gap:12px;
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      }
      .card {
        background:var(--card); border:1px solid rgba(255,255,255,.08); border-radius:12px; overflow:hidden; cursor:pointer;
        display:flex; flex-direction:column; transition:transform .06s ease, box-shadow .06s ease, border-color .06s ease;
      }
      .card:hover { transform: translateY(-1px); box-shadow: 0 8px 24px rgba(0,0,0,.35); border-color: rgba(79,140,255,.45); }
      .thumb {
        width:100%;
        height:180px; /* фиксируем высоту — все плитки одинаковые */
        background:#111; display:flex; align-items:center; justify-content:center;
      }
      .thumb img {
        max-width:100%; max-height:100%;
        width:auto; height:auto; object-fit:contain; display:block;
      }
      .name { font-size:12px; color:var(--fg); opacity:.9; padding:8px 10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; border-top:1px solid rgba(255,255,255,.06); }

      .footer {
        flex:0 0 auto; display:flex; justify-content:flex-end; gap:8px; padding:10px 14px; border-top: 1px solid rgba(255,255,255,.08);
      }
      .hidden { display:none; }
    </style>
  </head>
  <body>
    <div class="titlebar">
      <div class="tb-left">
        <div style="font-weight:600;">Select what to share</div>
        <div id="hint" class="pill hidden"></div>
      </div>
      <div class="tb-right">
        <button class="btn" id="btn-max" title="Toggle Fullscreen" aria-label="Toggle Fullscreen">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3Zm12 0h-2v3h-3v2h5v-5ZM7 7h3V5H5v5h2V7Zm10 0v3h2V5h-5v2h3Z"/></svg>
        </button>
        <button class="btn" id="btn-close" title="Close" aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="m19 6.41-1.41-1.41L12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
    </div>

    <div class="content">
      <div class="col">
        <div class="label">Screens</div>
        <div class="grid" id="grid-screens"></div>
      </div>
      <div class="col">
        <div class="label">Windows</div>
        <div class="grid" id="grid-windows"></div>
      </div>
    </div>

    <div class="footer">
      <button class="btn" id="btn-cancel">Cancel</button>
      <button class="btn primary" id="btn-share" disabled>Share</button>
    </div>

    <script>
      const api = window.electronAPI;
      let selectedId = null;

      const $ = sel => document.querySelector(sel);
      const gridScreens = $('#grid-screens');
      const gridWindows = $('#grid-windows');
      const btnShare = $('#btn-share');

      function mkCard(src) {
        const node = document.createElement('div');
        node.className = 'card';
        node.dataset.id = src.id;
        node.innerHTML = \`
          <div class="thumb"><img alt=""></div>
          <div class="name">\${src.name}</div>
        \`;
        const img = node.querySelector('img');
        img.src = src.thumbnailDataURL || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

        node.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          select(node.dataset.id);
        }, true);

        node.addEventListener('dblclick', (e) => {
          e.preventDefault(); e.stopPropagation();
          select(node.dataset.id);
          if (selectedId) api.choose(selectedId);
        }, true);

        return node;
      }

      function select(id) {
        selectedId = id;
        btnShare.disabled = !selectedId;
        document.querySelectorAll('.card').forEach(el => {
          if (el.dataset.id === id) {
            el.style.borderColor = 'rgba(79,140,255,.9)';
            el.style.boxShadow = '0 8px 28px rgba(79,140,255,.28)';
          } else {
            el.style.borderColor = 'rgba(255,255,255,.08)';
            el.style.boxShadow = '';
          }
        });
      }

      api.onSources(({screens, windows, hint}) => {
        const h = document.getElementById('hint');
        if (hint) { h.textContent = hint; h.classList.remove('hidden'); } else { h.classList.add('hidden'); }

        gridScreens.innerHTML = '';
        gridWindows.innerHTML = '';
        (screens || []).forEach((src) => gridScreens.appendChild(mkCard(src)));
        (windows || []).forEach((src) => gridWindows.appendChild(mkCard(src)));
      });

      document.getElementById('btn-close').onclick = (e) => { e.preventDefault(); api.cancel(); };
      document.getElementById('btn-cancel').onclick = (e) => { e.preventDefault(); api.cancel(); };
      document.getElementById('btn-share').onclick = (e) => { e.preventDefault(); if (selectedId) api.choose(selectedId); };
      document.getElementById('btn-max').onclick = (e) => { e.preventDefault(); api.toggleFullscreen(); };

      window.addEventListener('DOMContentLoaded', () => { api.ready(); });
    </script>
  </body>
  </html>
  `;

  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.once('ready-to-show', () => win.show());
  return win;
}

async function collectSources(): Promise<{ screens: SourceLite[]; windows: SourceLite[]; hint?: string }> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    fetchWindowIcons: true,
    thumbnailSize: { width: 640, height: 400 },
  });

  const screens: SourceLite[] = [];
  const windowsArr: SourceLite[] = [];

  for (const s of sources) {
    const img = s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail : nativeImage.createEmpty();
    const data = img.isEmpty() ? 'data:image/png;base64,' : img.toDataURL();
    const entry: SourceLite = {
      id: s.id,
      name: s.name || (s.id.startsWith('screen:') ? 'Screen' : 'Window'),
      thumbnailDataURL: data,
      type: (s.id.startsWith('screen:') ? 'screen' : 'window'),
    };
    if (entry.type === 'screen') screens.push(entry);
    else windowsArr.push(entry);
  }

  return {
    screens,
    windows: windowsArr,
    hint: process.platform === 'win32'
      ? 'System audio is available'
      : (process.platform === 'darwin'
        ? 'If the list is empty, enable Screen Recording in System Settings → Privacy & Security'
        : undefined),
  };
}

async function showPicker(parent: BrowserWindow | null): Promise<string | null> {
  if (pickerWin) {
    try { pickerWin.focus(); } catch { }
  } else {
    pickerWin = createPickerWindow(parent ?? undefined);
  }

  let finished = false;

  const sendSources = async () => {
    if (!pickerWin) return;
    const payload = await collectSources().catch(() => ({ screens: [], windows: [] }));
    pickerWin.webContents.send('mm-picker:sources', payload);
  };

  return new Promise((resolve) => {
    const finish = (val: string | null) => {
      if (finished) return;
      finished = true;
      ipcMain.removeListener('mm-picker:ready', onReady);
      ipcMain.removeListener('mm-picker:choose', onChoose);
      ipcMain.removeListener('mm-picker:cancel', onCancel);
      ipcMain.removeListener('mm-picker:toggle-fullscreen', onToggleFs);
      if (pickerWin) {
        pickerWin.removeListener('closed', onClosed);
        // Закрываем аккуратно (вторичный 'closed' не запустит finish из-за флага)
        try { pickerWin.close(); } catch { }
        pickerWin = null;
      }
      resolve(val);
    };

    const onReady = () => { sendSources().catch(() => { }); };
    const onChoose = (_: any, id: string) => finish(id || null);
    const onCancel = () => finish(null);
    const onClosed = () => finish(null);
    const onToggleFs = () => { if (pickerWin) pickerWin.setFullScreen(!pickerWin.isFullScreen()); };

    ipcMain.once('mm-picker:ready', onReady);
    ipcMain.once('mm-picker:choose', onChoose);
    ipcMain.once('mm-picker:cancel', onCancel);
    ipcMain.on('mm-picker:toggle-fullscreen', onToggleFs);

    pickerWin!.on('closed', onClosed);
  });
}

export function installScreenShareHandler() {
  if (installed) return;
  installed = true;

  const ses = session.defaultSession;

  ses.setDisplayMediaRequestHandler(async (_request: any, rawCallback) => {
    // Предохранитель: гарантируем один вызов
    let responded = false;
    const callback = (streams: any) => {
      if (responded) return;
      responded = true;
      try { rawCallback(streams); } catch { /* ignore */ }
    };

    try {
      const parent = BrowserWindow.getFocusedWindow() ?? null;
      const chosenId = await showPicker(parent);
      if (!chosenId) return callback({}); // отмена

      const all = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const match = all.find(s => s.id === chosenId);
      if (!match) return callback({});

      // ВАЖНО: только видео, без аудио. Отдаём минимальный объект (id + name),
      // как советует актуальная спецификация Electron 37+.
      callback({ video: { id: match.id, name: match.name } });
    } catch {
      callback({});
    }
  });
}
