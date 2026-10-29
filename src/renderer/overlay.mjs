import { createPreset, drawPreset } from './engine/layout.mjs';
import { CanvasPainter } from './engine/painter.mjs';
import { GamepadPoller } from './engine/gamepad.mjs';

const api = window.keycat;
const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
const painter = new CanvasPainter(ctx);
const hintEl = document.getElementById('hint');

const MIN_SCALE = 0.15;
const MAX_SCALE = 3;
const HANDLE_SIZE = 15;
const SNAP = 4;

/** 预设缓存：id -> { preset, texture, name } */
const cache = new Map();
let presetMeta = new Map();

let config = null;
let instances = [];
let editMode = false;
let selectedId = null;
let dpr = 1;

const keys = new Set();
const demoKeys = new Set();
const buttons = new Set();
const demoButtons = new Set();

let wheelDir = 0;
let wheelUntil = 0;
let pendingDX = 0;
let pendingDY = 0;
let demoTimer = 600;
let demoHold = 0;
let demoActive = false;
let elapsed = 0;

const gamepad = new GamepadPoller();
let drag = null;
let visible = true;

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/* ------------------------------------------------------------------ */
/* 预设加载                                                            */
/* ------------------------------------------------------------------ */

async function ensurePreset(id) {
  if (cache.has(id)) return cache.get(id);
  const data = await api.getLayout(id);
  if (!data || !data.layout) return null;

  const preset = createPreset(data.layout);
  const texture = new Image();
  texture.decoding = 'sync';
  texture.src = data.textureUrl;

  const entry = { preset, texture, name: data.name, meta: presetMeta.get(id) };
  cache.set(id, entry);
  texture.addEventListener('load', () => scheduleRender());
  return entry;
}

async function ensureAll(list) {
  await Promise.all([...new Set(list)].map((id) => ensurePreset(id).catch(() => null)));
}

/* ------------------------------------------------------------------ */
/* 画布                                                                */
/* ------------------------------------------------------------------ */

function resizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  // 把真实视口告诉主进程，用于首次摆放默认预设
  api.reportViewport({ width, height });
}

/* ------------------------------------------------------------------ */
/* 帧绘制                                                              */
/* ------------------------------------------------------------------ */

function currentInput() {
  const activeKeys = demoKeys.size ? new Set([...keys, ...demoKeys]) : keys;
  const activeButtons = demoButtons.size ? new Set([...buttons, ...demoButtons]) : buttons;

  let dx = pendingDX;
  let dy = pendingDY;
  if (config?.overlay?.demo) {
    dx += Math.sin(elapsed / 260) * 26 + Math.cos(elapsed / 90) * 6;
    dy += Math.cos(elapsed / 320) * 22;
  }

  return {
    keys: activeKeys,
    mouseButtons: activeButtons,
    wheelDir: performance.now() < wheelUntil ? wheelDir : 0,
    mouseDX: dx,
    mouseDY: dy,
    mouseSensitivity: Number(config?.overlay?.mouseSensitivity ?? 100),
    mouseDeadzone: Number(config?.overlay?.mouseDeadzone ?? 0),
    pad: gamepad.pad,
  };
}

function instanceSize(inst) {
  const entry = cache.get(inst.preset);
  const w = entry?.preset?.width ?? 240;
  const h = entry?.preset?.height ?? 160;
  return { w: w * inst.scale, h: h * inst.scale };
}

function instanceBounds(inst) {
  const { w, h } = instanceSize(inst);
  return { x: inst.x, y: inst.y, w, h };
}

let renderScheduled = false;

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render(16);
  });
}

function render(dt) {
  const width = window.innerWidth;
  const height = window.innerHeight;
  ctx.clearRect(0, 0, width, height);

  const input = currentInput();
  pendingDX = 0;
  pendingDY = 0;

  for (const inst of instances) {
    if (!inst.visible) continue;
    const entry = cache.get(inst.preset);
    if (!entry || !entry.texture.complete || entry.texture.naturalWidth === 0) continue;

    ctx.save();
    ctx.globalAlpha = clamp(Number(inst.opacity ?? 1), 0, 1);
    ctx.translate(inst.x, inst.y);
    ctx.scale(inst.scale, inst.scale);
    // 放大时保持像素风的硬边缘，缩小时用平滑避免摩尔纹
    ctx.imageSmoothingEnabled = inst.scale < 1;
    ctx.imageSmoothingQuality = 'high';
    painter.paint(
      drawPreset(
        entry.preset,
        {
          texture: entry.texture,
          textureWidth: entry.texture.naturalWidth,
          textureHeight: entry.texture.naturalHeight,
          input,
        },
        dt,
      ),
    );
    ctx.restore();
  }

  if (editMode) drawEditLayer();
}

function roundRect(context, x, y, w, h, r) {
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + w, y, x + w, y + h, r);
  context.arcTo(x + w, y + h, x, y + h, r);
  context.arcTo(x, y + h, x, y, r);
  context.arcTo(x, y, x + w, y, r);
  context.closePath();
}

function drawGrid(bounds) {
  const step = 20;
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = bounds.x; x <= bounds.x + bounds.w; x += step) {
    ctx.moveTo(x, bounds.y);
    ctx.lineTo(x, bounds.y + bounds.h);
  }
  for (let y = bounds.y; y <= bounds.y + bounds.h; y += step) {
    ctx.moveTo(bounds.x, y);
    ctx.lineTo(bounds.x + bounds.w, y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawEditLayer() {
  for (const inst of instances) {
    const bounds = instanceBounds(inst);
    const selected = inst.id === selectedId;

    ctx.save();
    ctx.globalAlpha = inst.visible ? 1 : 0.32;

    if (config?.overlay?.grid) drawGrid(bounds);

    ctx.setLineDash(selected ? [] : [5, 4]);
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeStyle = selected ? 'rgba(96, 165, 250, 0.95)' : 'rgba(255, 255, 255, 0.28)';
    ctx.strokeRect(bounds.x - 0.5, bounds.y - 0.5, bounds.w + 1, bounds.h + 1);
    ctx.setLineDash([]);

    if (selected) {
      const label = `${inst.preset}  ${Math.round(inst.scale * 100)}%`;
      ctx.font = '12px "Microsoft YaHei UI", system-ui, sans-serif';
      const textWidth = ctx.measureText(label).width;
      const padding = 8;
      const labelY = bounds.y - 26 < 0 ? bounds.y + 6 : bounds.y - 26;
      ctx.fillStyle = 'rgba(37, 99, 235, 0.92)';
      roundRect(ctx, bounds.x - 1, labelY, textWidth + padding * 2, 20, 6);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bounds.x + padding - 1, labelY + 10.5);

      // 右下角缩放手柄
      const hx = bounds.x + bounds.w - HANDLE_SIZE / 2;
      const hy = bounds.y + bounds.h - HANDLE_SIZE / 2;
      ctx.beginPath();
      ctx.arc(hx, hy, HANDLE_SIZE / 2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(96, 165, 250, 0.95)';
      ctx.fill();
      ctx.strokeStyle = '#0b1220';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(hx - 4, hy + 4);
      ctx.lineTo(hx + 4, hy - 4);
      ctx.strokeStyle = 'rgba(11, 18, 32, 0.75)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ */
/* 编辑模式交互                                                        */
/* ------------------------------------------------------------------ */

function hitTest(x, y) {
  for (let i = instances.length - 1; i >= 0; i -= 1) {
    const inst = instances[i];
    if (!inst.visible) continue;
    const b = instanceBounds(inst);
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return inst;
  }
  return null;
}

function isOnHandle(inst, x, y) {
  const b = instanceBounds(inst);
  return Math.abs(x - (b.x + b.w)) <= HANDLE_SIZE && Math.abs(y - (b.y + b.h)) <= HANDLE_SIZE;
}

function toLocal(event) {
  return { x: event.clientX, y: event.clientY };
}

canvas.addEventListener('pointerdown', (event) => {
  if (!editMode || event.button !== 0) return;
  const { x, y } = toLocal(event);
  const inst = hitTest(x, y);
  if (!inst) {
    selectedId = null;
    scheduleRender();
    return;
  }
  selectedId = inst.id;
  const b = instanceBounds(inst);
  drag = {
    id: inst.id,
    mode: isOnHandle(inst, x, y) ? 'resize' : 'move',
    startX: x,
    startY: y,
    originX: inst.x,
    originY: inst.y,
    originScale: inst.scale,
    originW: b.w,
    originH: b.h,
  };
  canvas.setPointerCapture(event.pointerId);
  scheduleRender();
});

canvas.addEventListener('pointermove', (event) => {
  if (!editMode) return;
  const { x, y } = toLocal(event);

  if (!drag) {
    const hovered = hitTest(x, y);
    canvas.style.cursor = hovered ? (isOnHandle(hovered, x, y) ? 'nwse-resize' : 'move') : 'default';
    return;
  }

  const inst = instances.find((i) => i.id === drag.id);
  if (!inst) return;

  if (drag.mode === 'move') {
    const nextX = drag.originX + (x - drag.startX);
    const nextY = drag.originY + (y - drag.startY);
    inst.x = event.shiftKey ? Math.round(nextX / 20) * 20 : Math.round(nextX / SNAP) * SNAP;
    inst.y = event.shiftKey ? Math.round(nextY / 20) * 20 : Math.round(nextY / SNAP) * SNAP;
  } else {
    const entry = cache.get(inst.preset);
    const baseW = entry?.preset?.width ?? 240;
    const baseH = entry?.preset?.height ?? 160;
    const targetW = Math.max(24, drag.originW + (x - drag.startX));
    const targetH = Math.max(24, drag.originH + (y - drag.startY));
    const scale = clamp(Math.max(targetW / baseW, targetH / baseH), MIN_SCALE, MAX_SCALE);
    inst.scale = Math.round(scale * 100) / 100;
  }
  scheduleRender();
});

function endDrag(event) {
  if (!drag) return;
  drag = null;
  if (event && canvas.hasPointerCapture?.(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
  persistInstances();
}

canvas.addEventListener('pointerup', (event) => endDrag(event));
canvas.addEventListener('pointercancel', (event) => endDrag(event));

canvas.addEventListener(
  'wheel',
  (event) => {
    if (!editMode) return;
    const { x, y } = toLocal(event);
    const inst = hitTest(x, y);
    const target = inst ?? instances.find((i) => i.id === selectedId);
    if (!target) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.06 : 1 / 1.06;
    target.scale = Math.round(clamp(target.scale * factor, MIN_SCALE, MAX_SCALE) * 100) / 100;
    selectedId = target.id;
    persistInstances();
    scheduleRender();
  },
  { passive: false },
);

canvas.addEventListener('dblclick', (event) => {
  if (!editMode) return;
  const { x, y } = toLocal(event);
  if (hitTest(x, y)) api.openSettings();
});

window.addEventListener('keydown', (event) => {
  if (!editMode) return;
  const key = event.key;
  if (key === 'Escape') {
    api.setEditMode(false);
    return;
  }
  const inst = instances.find((i) => i.id === selectedId);
  if (!inst) return;

  if (key === 'Delete' || key === 'Backspace') {
    instances = instances.filter((i) => i.id !== selectedId);
    selectedId = null;
    persistInstances();
    scheduleRender();
    return;
  }

  const step = event.shiftKey ? 10 : 1;
  const moves = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  };
  if (moves[key]) {
    event.preventDefault();
    inst.x += moves[key][0];
    inst.y += moves[key][1];
    persistInstances();
    scheduleRender();
  }
});

let persistTimer = null;
function persistInstances() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    api.updateInstances(instances).catch((error) => console.error('[overlay] 保存布局失败', error));
  }, 60);
}

/* ------------------------------------------------------------------ */
/* 演示模式                                                            */
/* ------------------------------------------------------------------ */

const demoPool = [];

function rebuildDemoPool() {
  demoPool.length = 0;
  for (const entry of cache.values()) {
    for (const el of entry.preset.elements) {
      if (el.type === 1) demoPool.push({ type: 1, code: el.code });
      else if (el.type === 3) demoPool.push({ type: 3, code: el.code });
    }
  }
}

function updateDemo(dt) {
  if (!config?.overlay?.demo) {
    if (demoActive) {
      demoActive = false;
      demoKeys.clear();
      demoButtons.clear();
      demoHold = 0;
    }
    return;
  }

  if (demoActive) {
    demoHold -= dt;
    if (demoHold <= 0) {
      demoActive = false;
      demoKeys.clear();
      demoButtons.clear();
      demoTimer = 200 + Math.random() * 380;
    }
    return;
  }

  demoTimer -= dt;
  if (demoTimer > 0) return;
  if (!demoPool.length) {
    rebuildDemoPool();
    demoTimer = 500;
    return;
  }

  // 一次按下 1~3 个键，看起来更像真人在打字 / 按组合键
  const count = 1 + Math.floor(Math.random() * 3);
  demoActive = true;
  demoHold = 260 + Math.random() * 360;
  for (let i = 0; i < count; i += 1) {
    const pick = demoPool[(Math.random() * demoPool.length) | 0];
    if (pick.type === 1) demoKeys.add(pick.code);
    else demoButtons.add(pick.code);
  }
}

/* ------------------------------------------------------------------ */
/* 主循环                                                              */
/* ------------------------------------------------------------------ */

let lastFrame = performance.now();
let lastDraw = 0;

function loop(now) {
  const dt = Math.min(64, now - lastFrame);
  lastFrame = now;
  elapsed += dt;

  if (!visible) {
    requestAnimationFrame(loop);
    return;
  }

  gamepad.poll();
  updateDemo(dt);

  const fps = Number(config?.overlay?.fps ?? 60);
  const interval = 1000 / Math.max(5, Math.min(240, fps));
  if (now - lastDraw >= interval - 1) {
    lastDraw = now;
    render(dt);
  }
  requestAnimationFrame(loop);
}

/* ------------------------------------------------------------------ */
/* 状态同步                                                            */
/* ------------------------------------------------------------------ */

function applyEditMode(value) {
  editMode = Boolean(value);
  document.body.classList.toggle('editing', editMode);
  if (!editMode) {
    selectedId = null;
    drag = null;
  }
  hintEl.classList.toggle('hidden', !editMode);
  if (editMode) {
    hintEl.innerHTML =
      '<span class="dot"></span>编辑模式 · 拖动移动 · 滚轮缩放 · <kbd>Del</kbd> 删除 · <kbd>Esc</kbd> 退出';
  }
  scheduleRender();
}

async function syncState(state) {
  presetMeta = new Map(state.presets.map((p) => [p.id, p]));
  config = state.config;
  instances = (state.config.instances ?? []).map((inst) => ({ ...inst }));
  applyEditMode(state.editMode);
  await ensureAll(instances.map((i) => i.preset));
  rebuildDemoPool();
  scheduleRender();
}

/** 把预设拉回可视区域（默认位置是按上报前的视口估算的） */
function clampInstances() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let changed = false;
  for (const inst of instances) {
    const { w, h } = instanceSize(inst);
    const maxX = Math.max(0, vw - w);
    const maxY = Math.max(0, vh - h);
    const nextX = Math.min(Math.max(0, Math.round(inst.x)), maxX);
    const nextY = Math.min(Math.max(0, Math.round(inst.y)), maxY);
    if (nextX !== inst.x || nextY !== inst.y) {
      inst.x = nextX;
      inst.y = nextY;
      changed = true;
    }
  }
  if (changed) persistInstances();
  return changed;
}

async function boot() {
  resizeCanvas();
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    resizeCanvas();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      clampInstances();
      scheduleRender();
    }, 260);
  });

  const state = await api.getState();
  await syncState(state);
  // 窗口最大化完成后再兜底校正一次，防止预设落在屏幕外
  setTimeout(() => clampInstances(), 1500);

  document.addEventListener('visibilitychange', () => {
    visible = !document.hidden;
    lastFrame = performance.now();
  });

  requestAnimationFrame(loop);
}

api.onInput((batch) => {
  if (batch.keys) {
    for (const [code, down] of batch.keys) {
      if (down) keys.add(code);
      else keys.delete(code);
    }
  }
  if (batch.buttons) {
    for (const [button, down] of batch.buttons) {
      if (down) buttons.add(button);
      else buttons.delete(button);
    }
  }
  if (batch.wheel) {
    wheelDir = batch.wheel > 0 ? 1 : -1;
    wheelUntil = performance.now() + 180;
  }
  if (batch.dx) pendingDX += batch.dx;
  if (batch.dy) pendingDY += batch.dy;
});

api.onConfigChanged(async (next) => {
  config = next;
  instances = (next.instances ?? []).map((inst) => ({ ...inst }));
  await ensureAll(instances.map((i) => i.preset));
  rebuildDemoPool();
  scheduleRender();
});

api.onInstancesChanged((next) => {
  // 拖动过程中不回灌主进程的广播，避免位置跳动
  if (drag) return;
  const previous = selectedId;
  instances = (next ?? []).map((inst) => ({ ...inst }));
  selectedId = instances.some((i) => i.id === previous) ? previous : null;
  ensureAll(instances.map((i) => i.preset)).then(() => {
    rebuildDemoPool();
    scheduleRender();
  });
});

api.onEditModeChanged((value) => applyEditMode(value));
api.onVisibleChanged((value) => {
  visible = Boolean(value);
  lastFrame = performance.now();
});

boot().catch((error) => {
  console.error('[overlay] 初始化失败', error);
});
