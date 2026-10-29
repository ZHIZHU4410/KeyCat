'use strict';

const path = require('path');
const fs = require('fs');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  protocol,
  screen,
  shell,
} = require('electron');

const { Store } = require('./store');
const { listPresets, readJson, safeInside } = require('./presets');
const { InputHook } = require('./hook');

const APP_ROOT = app.getAppPath();
const PRESET_ROOT = path.join(APP_ROOT, 'presets');
const META_FILE = path.join(APP_ROOT, 'preset-meta.json');
const ASSETS = path.join(APP_ROOT, 'assets');
const DEV = process.argv.includes('--dev');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'keycat',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

app.setAppUserModelId('com.keycat.overlay');
app.setName('KeyCat');

// 使用独立的用户目录，避免和本机其它 Electron 开发应用共用 %APPDATA%\Electron。
// 支持便携模式：环境变量 KEYCAT_HOME 指向任意可写目录；
// 同时逐级回退，避免个别机器上 %APPDATA% 不可写时整个程序起不来。
function resolveUserData() {
  const candidates = [];
  if (process.env.KEYCAT_HOME) candidates.push(path.resolve(process.env.KEYCAT_HOME));
  try {
    candidates.push(path.join(app.getPath('appData'), 'KeyCat'));
  } catch {
    /* ignore */
  }
  try {
    candidates.push(path.join(app.getPath('localAppData'), 'KeyCat'));
  } catch {
    /* ignore */
  }
  try {
    candidates.push(path.join(app.getPath('temp'), 'KeyCat'));
  } catch {
    /* ignore */
  }
  candidates.push(path.join(process.cwd(), '.keycat-data'));

  for (const dir of candidates) {
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      /* 尝试下一个 */
    }
  }
  return null;
}

const USER_DATA = resolveUserData();
if (USER_DATA) {
  try {
    app.setPath('userData', USER_DATA);
  } catch (error) {
    console.error('[main] 设置用户目录失败:', error.message);
  }
} else {
  console.error('[main] 没有可写的用户目录，配置将无法保存');
}

const store = new Store(path.join(app.getPath('userData'), 'config.json'));
const hook = new InputHook();

let overlayWindow = null;
let settingsWindow = null;
let tray = null;
let quitting = false;
let presets = [];
let editMode = false;
let overlayVisible = true;
let lastMouse = null;
let pendingBatch = null;
let flushTimer = null;
let mousePaused = false;
let defaultsPlaced = false;

const presetRoots = () => [
  { dir: PRESET_ROOT, metaFile: META_FILE, source: 'builtin' },
  { dir: path.join(app.getPath('userData'), 'presets'), source: 'user' },
];

function relPresetPath(file) {
  for (const root of presetRoots()) {
    if (file && safeInside(root.dir, file)) {
      return path.relative(root.dir, file).replace(/\\/g, '/');
    }
  }
  return null;
}

function textureUrl(file) {
  const rel = relPresetPath(file);
  if (!rel) return null;
  const parts = rel.split('/').map((p) => encodeURIComponent(p));
  return `keycat://texture/${parts.join('/')}`;
}

function refreshPresets() {
  presets = listPresets({ roots: presetRoots(), meta: readJson(META_FILE) });
  for (const preset of presets) {
    preset.textureUrl = textureUrl(preset.texturePath);
    preset.jsonRel = relPresetPath(preset.jsonPath);
  }
  return presets;
}

function defaultInstances() {
  const vp = viewport.width > 200 ? viewport : { width: 1280, height: 720 };
  const byId = new Map(presets.map((p) => [p.id, p]));
  const kb = byId.get('wasd-minimal') || presets.find((p) => p.category === 'keyboard') || presets[0];
  const ms = byId.get('mouse-arrow') || presets.find((p) => p.category === 'mouse');

  const kbScale = 0.5;
  const msScale = 0.5;
  const kbWidth = (kb?.width ?? 600) * kbScale;
  const kbHeight = (kb?.height ?? 400) * kbScale;
  const msWidth = (ms?.width ?? 300) * msScale;
  const msHeight = (ms?.height ?? 420) * msScale;
  const totalWidth = kbWidth + msWidth + 28;
  const baseX = Math.round(Math.max(24, (vp.width - totalWidth) / 2));
  const baseY = Math.round(Math.max(24, vp.height - Math.max(kbHeight, msHeight) - 36));

  const instances = [];
  if (ms) {
    instances.push({
      id: `inst-${Date.now()}-1`,
      preset: ms.id,
      x: baseX,
      y: baseY,
      scale: msScale,
      opacity: 1,
      visible: true,
    });
  }
  if (kb) {
    instances.push({
      id: `inst-${Date.now()}-2`,
      preset: kb.id,
      x: Math.round(baseX + msWidth + 28),
      y: Math.round(baseY + Math.max(0, msHeight - kbHeight) / 2),
      scale: kbScale,
      opacity: 1,
      visible: true,
    });
  }
  return instances;
}

let defaultsTimer = null;

/** 首次启动：等窗口铺满屏幕后，把默认预设摆到屏幕下方中间 */
function placeDefaultInstances() {
  if (defaultsPlaced) return;
  defaultsPlaced = true;
  if ((store.get().instances ?? []).length > 0) return;
  const seeded = defaultInstances();
  store.setInstances(seeded);
  broadcast('instances:changed', seeded);
}

function stateSnapshot() {
  return {
    config: store.get(),
    presets: presets.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category,
      width: p.width,
      height: p.height,
      elementCount: p.elementCount,
      flags: p.flags,
      textureUrl: p.textureUrl,
      source: p.source,
    })),
    hook: hook.info(),
    editMode,
    overlayVisible,
    version: app.getVersion(),
    platform: process.platform,
    userPresetDir: path.join(app.getPath('userData'), 'presets'),
    builtinPresetDir: PRESET_ROOT,
  };
}

function broadcast(channel, payload) {
  for (const win of [overlayWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

/* ------------------------------------------------------------------ */
/* 覆盖层窗口                                                          */
/* ------------------------------------------------------------------ */

function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    width: 640,
    height: 400,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.loadFile(path.join(APP_ROOT, 'src', 'renderer', 'overlay.html'));

  overlayWindow.once('ready-to-show', () => {
    // 用原生最大化把窗口铺满工作区，避免 DPI 换算差异导致尺寸对不上
    overlayWindow.maximize();
    overlayWindow.showInactive();
    overlayVisible = true;
    applyOverlayBehaviour();
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

  if (DEV) overlayWindow.webContents.openDevTools({ mode: 'detach' });
}

/** 渲染层上报的视口尺寸（CSS 像素），用于摆放预设 */
let viewport = { width: 1280, height: 720 };

function requestViewport() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return viewport;
  overlayWindow.webContents
    .executeJavaScript('({ width: window.innerWidth, height: window.innerHeight })', true)
    .then((value) => {
      if (value && value.width > 0 && value.height > 0) viewport = value;
    })
    .catch(() => {});
  return viewport;
}

function applyOverlayBehaviour() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const cfg = store.get().overlay;

  overlayWindow.setAlwaysOnTop(cfg.alwaysOnTop, 'screen-saver');
  overlayWindow.setOpacity(Math.min(1, Math.max(0.2, Number(cfg.opacity) || 1)));

  // 编辑模式下必须接收鼠标事件，其余时候按「鼠标穿透」设置
  const passThrough = editMode ? false : cfg.clickThrough !== false;
  if (passThrough) overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  else overlayWindow.setIgnoreMouseEvents(false);

  if (overlayVisible) overlayWindow.showInactive();
  else overlayWindow.hide();
}

/* ------------------------------------------------------------------ */
/* 设置窗口                                                            */
/* ------------------------------------------------------------------ */

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }

  settingsWindow = new BrowserWindow({
    width: Math.max(880, Math.min(1040, Math.floor(screen.getPrimaryDisplay().workArea.width / (screen.getPrimaryDisplay().scaleFactor || 1)) - 56)),
    height: Math.max(600, Math.min(720, Math.floor(screen.getPrimaryDisplay().workArea.height / (screen.getPrimaryDisplay().scaleFactor || 1)) - 56)),
    minWidth: 860,
    minHeight: 560,
    title: 'KeyCat 设置',
    backgroundColor: '#15161b',
    show: false,
    autoHideMenuBar: true,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  settingsWindow.loadFile(path.join(APP_ROOT, 'src', 'renderer', 'settings.html'));
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
  if (DEV) settingsWindow.webContents.openDevTools({ mode: 'detach' });
  return settingsWindow;
}

function iconPath() {
  const file = path.join(ASSETS, 'icon.png');
  return fs.existsSync(file) ? file : undefined;
}

/* ------------------------------------------------------------------ */
/* 托盘                                                                */
/* ------------------------------------------------------------------ */

function buildTray() {
  const file = iconPath();
  const image = file ? nativeImage.createFromPath(file) : nativeImage.createEmpty();
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }));
  tray.setToolTip('KeyCat · 键鼠显示');
  updateTrayMenu();
  tray.on('double-click', () => createSettingsWindow());
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const menu = Menu.buildFromTemplate([
    { label: overlayVisible ? '隐藏显示层' : '显示显示层', click: () => toggleOverlayVisible() },
    {
      label: editMode ? '退出编辑模式' : '编辑模式（可拖动预设）',
      type: 'checkbox',
      checked: editMode,
      click: () => setEditMode(!editMode),
    },
    { type: 'separator' },
    { label: '打开设置…', click: () => createSettingsWindow() },
    { label: '打开预设文件夹', click: () => openPresetFolder() },
    { type: 'separator' },
    { label: 'KeyCat v' + app.getVersion(), enabled: false },
    { label: '退出', click: () => quitApp() },
  ]);
  tray.setContextMenu(menu);
}

/* ------------------------------------------------------------------ */
/* 输入事件                                                            */
/* ------------------------------------------------------------------ */

function queueEvent(payload) {
  if (!pendingBatch) {
    pendingBatch = { keys: [], buttons: [], wheel: 0, dx: 0, dy: 0 };
  }
  const batch = pendingBatch;
  if (payload.key) batch.keys.push(payload.key);
  if (payload.button) batch.buttons.push(payload.button);
  if (payload.wheel) batch.wheel += payload.wheel > 0 ? 1 : -1;
  if (payload.move) {
    batch.dx += payload.move.dx;
    batch.dy += payload.move.dy;
  }
  if (!flushTimer) flushTimer = setTimeout(flushInput, 16);
}

function flushInput() {
  flushTimer = null;
  if (!pendingBatch) return;
  const batch = pendingBatch;
  pendingBatch = null;
  if (!batch.keys.length && !batch.buttons.length && !batch.wheel && !batch.dx && !batch.dy) return;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('input:batch', batch);
  }
}

function startHook() {  const ok = hook.start();
  hook.on('key', (e) => queueEvent({ key: [e.code, e.down] }));
  hook.on('mouseButton', (e) => queueEvent({ button: [e.button, e.down] }));
  hook.on('wheel', (e) => queueEvent({ wheel: e.rotation }));
  hook.on('mouseMove', (e) => {
    if (mousePaused) return;
    const dx = lastMouse ? e.x - lastMouse.x : 0;
    const dy = lastMouse ? e.y - lastMouse.y : 0;
    lastMouse = { x: e.x, y: e.y };
    if (dx || dy) queueEvent({ move: { dx, dy } });
  });
  return ok;
}

/* ------------------------------------------------------------------ */
/* 行为                                                                */
/* ------------------------------------------------------------------ */

function setEditMode(value) {
  editMode = Boolean(value);
  applyOverlayBehaviour();
  updateTrayMenu();
  broadcast('overlay:edit-mode', editMode);
  if (editMode) {
    if (!overlayVisible) {
      overlayVisible = true;
      overlayWindow.showInactive();
    }
  }
}

function toggleOverlayVisible() {
  overlayVisible = !overlayVisible;
  applyOverlayBehaviour();
  updateTrayMenu();
  broadcast('overlay:visible', overlayVisible);
}

function openPresetFolder() {
  const dir = path.join(app.getPath('userData'), 'presets');
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
}

function quitApp() {
  quitting = true;
  hook.stop();
  store.flush();
  globalShortcut.unregisterAll();
  app.quit();
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('state:get', () => stateSnapshot());

  // 覆盖层在窗口尺寸确定后上报自己的视口（CSS 像素），
  // 首次启动时用它来摆放默认预设，避免 DPI/窗口尺寸差异导致位置跑偏
  ipcMain.on('viewport:report', (_event, size) => {
    if (!size || !(size.width > 100) || !(size.height > 100)) return;
    viewport = { width: Math.round(size.width), height: Math.round(size.height) };
    clearTimeout(defaultsTimer);
    if (!defaultsPlaced) defaultsTimer = setTimeout(placeDefaultInstances, 700);
  });

  ipcMain.handle('config:update', (_event, patch) => {
    const before = JSON.stringify(store.get().overlay);
    const data = store.patch(patch || {});
    applyOverlayBehaviour();
    broadcast('config:changed', data);
    if (before !== JSON.stringify(data.overlay)) updateTrayMenu();
    return stateSnapshot();
  });

  ipcMain.handle('instances:update', (_event, instances) => {
    const data = store.setInstances(instances);
    broadcast('instances:changed', data.instances);
    return stateSnapshot();
  });

  ipcMain.handle('preset:layout', (_event, id) => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return null;
    const layout = readJson(preset.jsonPath);
    if (!layout) return null;
    return { id, layout, textureUrl: preset.textureUrl, name: preset.name, category: preset.category };
  });

  ipcMain.handle('presets:rescan', () => {
    refreshPresets();
    broadcast('config:changed', store.get());
    return stateSnapshot();
  });

  ipcMain.handle('overlay:edit-mode', (_event, value) => {
    setEditMode(value);
    return editMode;
  });

  ipcMain.handle('overlay:visible', (_event, value) => {
    overlayVisible = Boolean(value);
    applyOverlayBehaviour();
    updateTrayMenu();
    return overlayVisible;
  });

  ipcMain.handle('overlay:mouse-pause', (_event, value) => {
    mousePaused = Boolean(value);
    return mousePaused;
  });

  ipcMain.handle('preset:open-folder', () => {
    openPresetFolder();
    return true;
  });

  ipcMain.handle('preset:builtin-folder', () => shell.openPath(PRESET_ROOT));

  ipcMain.handle('settings:open', () => {
    createSettingsWindow();
    return true;
  });

  ipcMain.handle('settings:close', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
    return true;
  });

  ipcMain.handle('app:quit', () => {
    quitApp();
    return true;
  });

  ipcMain.handle('app:set-login', (_event, value) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(value), args: [] });
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.handle('app:login-status', () => app.getLoginItemSettings().openAtLogin);

  ipcMain.handle('overlay:work-area', () => {
    const vp = requestViewport();
    return { x: 0, y: 0, width: vp.width, height: vp.height };
  });

  ipcMain.handle('theme', () => nativeTheme.shouldUseDarkColors);
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => createSettingsWindow());

  app.whenReady().then(() => {
    protocol.handle('keycat', async (request) => {
      try {
        const url = new URL(request.url);
        const rel = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
        const file = path.join(PRESET_ROOT, rel);
        if (!safeInside(PRESET_ROOT, file)) return new Response('forbidden', { status: 403 });
        const data = await fs.promises.readFile(file);
        const ext = path.extname(file).toLowerCase();
        const type = ext === '.png' ? 'image/png' : ext === '.json' ? 'application/json' : 'application/octet-stream';
        return new Response(data, { headers: { 'content-type': type, 'cache-control': 'no-cache' } });
      } catch (error) {
        return new Response(String(error && error.message), { status: 404 });
      }
    });

    store.load();
    refreshPresets();
    // 清理指向已不存在预设的实例
    const known = new Set(presets.map((p) => p.id));
    const cleaned = (store.get().instances ?? []).filter((inst) => inst && known.has(inst.preset));
    if (cleaned.length !== (store.get().instances ?? []).length) store.setInstances(cleaned);
    defaultsPlaced = cleaned.length > 0;

    registerIpc();
    createOverlayWindow();
    buildTray();
    startHook();

    if (process.argv.includes('--open-settings')) createSettingsWindow();
    if (process.argv.includes('--demo')) store.patch({ overlay: { demo: true } });

    globalShortcut.register('CommandOrControl+Alt+E', () => setEditMode(!editMode));
    globalShortcut.register('CommandOrControl+Alt+H', () => toggleOverlayVisible());
    globalShortcut.register('CommandOrControl+Alt+S', () => createSettingsWindow());

    app.on('activate', () => createSettingsWindow());
  });

  app.on('window-all-closed', () => {
    // 关闭设置窗口后继续留在托盘运行，只有托盘里的「退出」才真正结束进程
  });

  app.on('before-quit', () => {
    quitting = true;
    store.flush();
    hook.stop();
  });
}

process.on('uncaughtException', (error) => {
  console.error('[main] 未捕获异常:', error);
});
