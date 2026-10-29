import { createPreset, drawPreset, ELEMENT_TYPE } from './engine/layout.mjs';
import { CanvasPainter } from './engine/painter.mjs';

const api = window.keycat;

const CATEGORY_LABEL = { keyboard: '键盘', mouse: '鼠标', gamepad: '手柄', other: '其他' };

const state = {
  config: null,
  presets: [],
  instances: [],
  editMode: false,
  overlayVisible: true,
  hook: null,
};

const filters = { category: 'all', query: '' };
const layoutCache = new Map();
let instanceCounter = 0;
let persistTimer = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

/* ------------------------------------------------------------------ */
/* 通用                                                                */
/* ------------------------------------------------------------------ */

function uuid() {
  instanceCounter += 1;
  return `inst-${Date.now().toString(36)}-${instanceCounter}`;
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function toast(message) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText =
      'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);padding:9px 16px;border-radius:999px;' +
      'background:rgba(24,26,34,.95);border:1px solid rgba(255,255,255,.14);color:#e9eaf0;font-size:12.5px;' +
      'box-shadow:0 12px 30px rgba(0,0,0,.45);opacity:0;transition:opacity .18s,transform .18s;z-index:99;pointer-events:none';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.style.opacity = '1';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.style.opacity = '0';
  }, 1600);
}

async function getLayout(id) {
  if (layoutCache.has(id)) return layoutCache.get(id);
  const data = await api.getLayout(id);
  if (!data) return null;
  const preset = createPreset(data.layout);
  const image = new Image();
  image.src = data.textureUrl;
  const entry = { preset, image, name: data.name, id };
  layoutCache.set(id, entry);
  try {
    await image.decode();
  } catch {
    /* 图集加载失败时仍然保留布局信息 */
  }
  return entry;
}

/* ------------------------------------------------------------------ */
/* Tab                                                                 */
/* ------------------------------------------------------------------ */

const TAB_TEXT = {
  presets: ['预设库', '选择任意 input-overlay 5.x 预设，点击即可放到屏幕上。'],
  layout: ['屏幕布局', '同时摆放多个预设，单独调整位置、大小与透明度。'],
  settings: ['设置', '显示、鼠标与系统行为。'],
  about: ['关于', 'KeyCat 的由来与致谢。'],
};

function switchTab(tab) {
  $$('.nav-item').forEach((item) => item.classList.toggle('is-active', item.dataset.tab === tab));
  $$('.panel').forEach((panel) => panel.classList.toggle('is-active', panel.dataset.panel === tab));
  const [title, desc] = TAB_TEXT[tab] ?? TAB_TEXT.presets;
  $('#page-title').textContent = title;
  $('#page-desc').textContent = desc;
  if (tab === 'layout') renderInstances();
  if (tab === 'presets') renderPresetGrid();
}

/* ------------------------------------------------------------------ */
/* 预设库                                                              */
/* ------------------------------------------------------------------ */

function filteredPresets() {
  const q = filters.query.trim().toLowerCase();
  return state.presets.filter((preset) => {
    if (filters.category !== 'all' && preset.category !== filters.category) return false;
    if (!q) return true;
    const haystack = `${preset.name} ${preset.id}`.toLowerCase();
    return haystack.includes(q);
  });
}

function renderPresetGrid() {
  const grid = $('#preset-grid');
  const list = filteredPresets();
  $('#preset-empty').hidden = list.length > 0;
  grid.innerHTML = '';

  for (const preset of list) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.id = preset.id;

    const used = state.instances.filter((inst) => inst.preset === preset.id).length;
    card.innerHTML = `
      <div class="card-thumb">
        <span class="badge">${CATEGORY_LABEL[preset.category] ?? '其他'}</span>
        ${used ? `<span class="badge multi">已在屏幕上 ×${used}</span>` : ''}
        <canvas></canvas>
      </div>
      <div class="card-body">
        <div class="card-info">
          <div class="card-name" title="${escapeHtml(preset.name)}">${escapeHtml(preset.name)}</div>
          <div class="card-meta" title="${escapeHtml(preset.id)}">${preset.width}×${preset.height} · ${preset.elementCount} 个元素</div>
        </div>
        <button class="card-add" title="放到屏幕上">＋</button>
      </div>`;

    card.querySelector('.card-add').addEventListener('click', (event) => {
      event.stopPropagation();
      addPreset(preset.id);
    });
    card.addEventListener('dblclick', () => addPreset(preset.id));

    grid.appendChild(card);
    drawThumbnail(card.querySelector('canvas'), preset);
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function drawThumbnail(canvas, meta) {
  const entry = await getLayout(meta.id);
  if (!entry || !entry.image.complete || !entry.image.naturalWidth) {
    // 图集还没解码完就等下一帧再画
    entry?.image.addEventListener('load', () => drawThumbnail(canvas, meta), { once: true });
  }

  const cssWidth = 214;
  const cssHeight = 118;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssWidth * ratio);
  canvas.height = Math.round(cssHeight * ratio);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  if (!entry) return;

  const preset = entry.preset;
  const scale = Math.min((cssWidth - 20) / (preset.width || 1), (cssHeight - 16) / (preset.height || 1));
  ctx.save();
  ctx.translate((cssWidth - preset.width * scale) / 2, (cssHeight - preset.height * scale) / 2);
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = scale < 1;
  const painter = new CanvasPainter(ctx);
  const input = {
    keys: new Set(),
    mouseButtons: new Set(),
    wheelDir: 0,
    mouseDX: 0,
    mouseDY: 0,
    pad: null,
    mouseSensitivity: 100,
    mouseDeadzone: 0,
  };
  painter.paint(
    drawPreset(
      preset,
      {
        texture: entry.image,
        textureWidth: entry.image.naturalWidth,
        textureHeight: entry.image.naturalHeight,
        input,
      },
      16,
    ),
  );
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* 实例                                                                */
/* ------------------------------------------------------------------ */

async function addPreset(id) {
  const meta = state.presets.find((p) => p.id === id);
  if (!meta) return;

  const area = (await api.workArea()) ?? { x: 0, y: 0, width: 1920, height: 1080 };
  const width = meta.width || 400;
  const height = meta.height || 300;
  const scale = clamp(560 / Math.max(width, 1), 0.18, 1);
  const offset = (state.instances.length % 6) * 26;

  const instance = {
    id: uuid(),
    preset: id,
    x: Math.round(area.x + (area.width - width * scale) / 2 + offset - 120),
    y: Math.round(area.y + (area.height - height * scale) / 2 + offset - 80),
    scale: Math.round(scale * 100) / 100,
    opacity: 1,
    visible: true,
  };

  state.instances = [...state.instances, instance];
  await api.updateInstances(state.instances);
  toast(`已添加「${meta.name}」`);
  renderPresetGrid();
  if ($('.panel[data-panel="layout"]').classList.contains('is-active')) renderInstances();
}

function renderInstances() {
  const list = $('#instance-list');
  const empty = $('#layout-empty');
  list.innerHTML = '';
  empty.hidden = state.instances.length > 0;
  $('#count-status').textContent = `${state.presets.length} 个预设 · ${state.instances.length} 个显示项`;

  state.instances.forEach((inst, index) => {
    const meta = state.presets.find((p) => p.id === inst.preset);
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.id = inst.id;
    row.innerHTML = `
      <canvas class="row-thumb"></canvas>
      <div>
        <div class="row-name">${escapeHtml(meta?.name ?? inst.preset)}</div>
        <div class="row-sub">${inst.preset} · ${Math.round(inst.x)}, ${Math.round(inst.y)}${inst.visible ? '' : ' · 已隐藏'}</div>
      </div>
      <div class="row-controls">
        <label class="slider-line">
          <span>大小</span>
          <input type="range" min="15" max="300" step="1" value="${Math.round(inst.scale * 100)}" data-field="scale" />
          <span data-value="scale">${Math.round(inst.scale * 100)}%</span>
        </label>
        <label class="slider-line">
          <span>透明</span>
          <input type="range" min="10" max="100" step="1" value="${Math.round((inst.opacity ?? 1) * 100)}" data-field="opacity" />
          <span data-value="opacity">${Math.round((inst.opacity ?? 1) * 100)}%</span>
        </label>
      </div>
      <div class="row-actions">
        <button class="icon-btn" data-action="up" title="上移一层" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button class="icon-btn" data-action="down" title="下移一层" ${index === state.instances.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="icon-btn" data-action="visible" title="显示 / 隐藏">${inst.visible ? '◉' : '◌'}</button>
        <button class="icon-btn" data-action="dup" title="复制">⧉</button>
        <button class="icon-btn danger" data-action="del" title="删除">✕</button>
      </div>`;
    list.appendChild(row);
    drawRowThumb(row.querySelector('.row-thumb'), inst);
    bindRow(row, inst);
  });
}

async function drawRowThumb(canvas, inst) {
  const entry = await getLayout(inst.preset);
  if (!entry) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = 54 * ratio;
  canvas.height = 42 * ratio;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, 54, 42);
  if (!entry.image.complete || !entry.image.naturalWidth) return;
  const preset = entry.preset;
  const scale = Math.min(48 / (preset.width || 1), 38 / (preset.height || 1));
  ctx.save();
  ctx.translate((54 - preset.width * scale) / 2, (42 - preset.height * scale) / 2);
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = scale < 1;
  const painter = new CanvasPainter(ctx);
  painter.paint(
    drawPreset(preset, {
      texture: entry.image,
      textureWidth: entry.image.naturalWidth,
      textureHeight: entry.image.naturalHeight,
      input: { keys: new Set(), mouseButtons: new Set(), wheelDir: 0, mouseDX: 0, mouseDY: 0, pad: null },
    }, 16),
  );
  ctx.restore();
}

function bindRow(row, inst) {
  row.querySelectorAll('input[type="range"]').forEach((input) => {
    input.addEventListener('input', () => {
      const field = input.dataset.field;
      const value = Number(input.value);
      if (field === 'scale') {
        inst.scale = clamp(value / 100, 0.15, 3);
        row.querySelector('[data-value="scale"]').textContent = `${value}%`;
      } else {
        inst.opacity = clamp(value / 100, 0.1, 1);
        row.querySelector('[data-value="opacity"]').textContent = `${value}%`;
      }
      scheduleInstancePersist();
    });
  });

  row.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const index = state.instances.findIndex((item) => item.id === inst.id);
      if (index < 0) return;
      switch (button.dataset.action) {
        case 'up':
          if (index > 0) [state.instances[index - 1], state.instances[index]] = [state.instances[index], state.instances[index - 1]];
          break;
        case 'down':
          if (index < state.instances.length - 1)
            [state.instances[index + 1], state.instances[index]] = [state.instances[index], state.instances[index + 1]];
          break;
        case 'visible':
          inst.visible = !inst.visible;
          break;
        case 'dup': {
          const copy = { ...inst, id: uuid(), x: inst.x + 24, y: inst.y + 24 };
          state.instances.splice(index + 1, 0, copy);
          break;
        }
        case 'del':
          state.instances.splice(index, 1);
          break;
        default:
          break;
      }
      persistInstances();
      renderInstances();
    });
  });
}

function scheduleInstancePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => persistInstances(), 90);
}

async function persistInstances() {
  clearTimeout(persistTimer);
  persistTimer = null;
  const snapshot = state.instances.map((inst) => ({ ...inst }));
  await api.updateInstances(snapshot);
  $('#count-status').textContent = `${state.presets.length} 个预设 · ${state.instances.length} 个显示项`;
}

async function autoArrange() {
  if (!state.instances.length) return;
  const area = (await api.workArea()) ?? { x: 0, y: 0, width: 1920, height: 1080 };
  const gap = 22;
  let totalWidth = 0;
  let maxHeight = 0;
  for (const inst of state.instances) {
    const meta = state.presets.find((p) => p.id === inst.preset);
    const w = (meta?.width ?? 400) * inst.scale;
    const h = (meta?.height ?? 300) * inst.scale;
    totalWidth += w + gap;
    maxHeight = Math.max(maxHeight, h);
  }
  totalWidth -= gap;
  let x = area.x + Math.max(24, (area.width - totalWidth) / 2);
  const baseY = area.y + area.height - maxHeight - 40;
  for (const inst of state.instances) {
    const meta = state.presets.find((p) => p.id === inst.preset);
    const w = (meta?.width ?? 400) * inst.scale;
    const h = (meta?.height ?? 300) * inst.scale;
    inst.x = Math.round(x);
    inst.y = Math.round(baseY + (maxHeight - h));
    inst.visible = true;
    x += w + gap;
  }
  await persistInstances();
  renderInstances();
  toast('已重新排列');
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

const RANGE_SCALE = {
  opacity: { get: (v) => Math.round((v ?? 1) * 100), set: (raw) => clamp(Number(raw) / 100, 0.2, 1), unit: '%' },
  mouseSensitivity: { get: (v) => v ?? 100, set: (raw) => Number(raw), unit: '' },
  mouseDeadzone: { get: (v) => v ?? 0, set: (raw) => Number(raw), unit: 'px' },
};

function fillSettings() {
  const overlay = state.config?.overlay ?? {};
  $$('[data-setting]').forEach((input) => {
    const key = input.dataset.setting;
    const value = overlay[key];
    const range = RANGE_SCALE[key];

    if (input.type === 'checkbox') {
      input.checked = Boolean(value);
      return;
    }
    if (input.tagName === 'SELECT') {
      input.value = String(value ?? 60);
      return;
    }
    if (input.type === 'range') {
      const scaled = range ? range.get(value) : value ?? 0;
      input.value = String(scaled);
      const output = $(`[data-output="${key}"]`);
      if (output) output.textContent = `${scaled}${range?.unit ?? ''}`;
    }
  });

  $('#btn-edit').textContent = state.editMode ? '退出编辑模式' : '进入编辑模式';
  $('#btn-edit').classList.toggle('is-on', state.editMode);
  $('#btn-visible').textContent = state.overlayVisible ? '隐藏显示层' : '显示显示层';

  const hook = state.hook ?? {};
  const hookEl = $('#hook-status');
  if (hook.running) {
    hookEl.textContent = '全局监听：运行中';
    hookEl.className = 'status-line ok';
  } else if (hook.status === 'unavailable' || hook.status === 'error') {
    hookEl.textContent = '全局监听：不可用（见控制台）';
    hookEl.className = 'status-line bad';
    hookEl.title = hook.error ?? '';
  } else {
    hookEl.textContent = '全局监听：未启动';
    hookEl.className = 'status-line';
  }

  $('#count-status').textContent = `${state.presets.length} 个预设 · ${state.instances.length} 个显示项`;
  $('#app-version').textContent = state.version ?? '1.0.0';
  if (state.builtinPresetDir) {
    $('#preset-paths').textContent = `内置：${state.builtinPresetDir} ｜ 用户：${state.userPresetDir}`;
  }
}

function bindSettingsInputs() {
  $$('[data-setting]').forEach((input) => {
    input.addEventListener('input', async () => {
      const key = input.dataset.setting;
      const range = RANGE_SCALE[key];
      let value;
      if (input.type === 'checkbox') value = input.checked;
      else if (input.tagName === 'SELECT') value = Number(input.value);
      else value = range ? range.set(input.value) : Number(input.value);

      if (input.type === 'range' && range) {
        const output = $(`[data-output="${key}"]`);
        if (output) output.textContent = `${input.value}${range.unit}`;
      }
      const next = await api.updateConfig({ overlay: { [key]: value } });
      if (next) state.config = next.config;
    });
  });

  $('#login-toggle').addEventListener('change', async (event) => {
    const enabled = await api.setLoginItem(event.target.checked);
    event.target.checked = Boolean(enabled);
    toast(enabled ? '已设置开机自启' : '已取消开机自启');
  });
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

function bindChrome() {
  $$('.nav-item').forEach((item) => item.addEventListener('click', () => switchTab(item.dataset.tab)));

  $('#search').addEventListener('input', (event) => {
    filters.query = event.target.value;
    renderPresetGrid();
  });

  $('#chips').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    filters.category = chip.dataset.cat;
    $$('.chip').forEach((c) => c.classList.toggle('is-active', c === chip));
    renderPresetGrid();
  });

  $('#btn-edit').addEventListener('click', async () => {
    state.editMode = await api.setEditMode(!state.editMode);
    fillSettings();
    toast(state.editMode ? '编辑模式：拖动预设即可移动' : '已退出编辑模式');
  });

  $('#btn-visible').addEventListener('click', async () => {
    state.overlayVisible = await api.setOverlayVisible(!state.overlayVisible);
    fillSettings();
  });

  $('#btn-rescan').addEventListener('click', async () => {
    const next = await api.rescanPresets();
    layoutCache.clear();
    applyState(next);
    renderPresetGrid();
    toast('已重新扫描预设');
  });

  $('#btn-folder').addEventListener('click', () => api.openPresetFolder());
  $('#btn-user-folder').addEventListener('click', () => api.openPresetFolder());
  $('#btn-builtin-folder').addEventListener('click', () => api.openBuiltinFolder());

  $('#btn-arrange').addEventListener('click', () => autoArrange());

  $('#btn-show-all').addEventListener('click', async () => {
    state.instances.forEach((inst) => {
      inst.visible = true;
    });
    await persistInstances();
    renderInstances();
  });

  $('#btn-clear').addEventListener('click', async () => {
    if (!state.instances.length) return;
    state.instances = [];
    await persistInstances();
    renderInstances();
    renderPresetGrid();
    toast('已清空屏幕上的预设');
  });

  $('#btn-reset').addEventListener('click', async () => {
    const next = await api.updateConfig({
      overlay: {
        clickThrough: true,
        alwaysOnTop: true,
        opacity: 1,
        fps: 60,
        mouseSensitivity: 100,
        mouseDeadzone: 0,
        grid: false,
        demo: false,
      },
    });
    if (next) state.config = next.config;
    fillSettings();
    toast('已恢复默认设置');
  });
}

/* ------------------------------------------------------------------ */
/* 状态同步                                                            */
/* ------------------------------------------------------------------ */

function applyState(next) {
  if (!next) return;
  state.config = next.config;
  state.presets = next.presets ?? [];
  state.instances = (next.config?.instances ?? []).map((inst) => ({ ...inst }));
  state.editMode = Boolean(next.editMode);
  state.overlayVisible = next.overlayVisible !== false;
  state.hook = next.hook;
  state.version = next.version;
  state.builtinPresetDir = next.builtinPresetDir;
  state.userPresetDir = next.userPresetDir;
  fillSettings();
}

async function boot() {
  const next = await api.getState();
  applyState(next);
  bindChrome();
  bindSettingsInputs();
  renderPresetGrid();
  renderInstances();

  try {
    const login = await api.getLoginItem();
    $('#login-toggle').checked = Boolean(login);
  } catch {
    /* ignore */
  }

  api.onEditModeChanged((value) => {
    state.editMode = Boolean(value);
    fillSettings();
  });

  api.onVisibleChanged((value) => {
    state.overlayVisible = Boolean(value);
    fillSettings();
  });

  api.onInstancesChanged((instances) => {
    const next = (instances ?? []).map((inst) => ({ ...inst }));
    // 自己刚提交过的变更会原样广播回来，此时不要重绘列表，否则滑块会掉焦点
    if (JSON.stringify(next) === JSON.stringify(state.instances)) return;
    state.instances = next;
    if ($('.panel[data-panel="layout"]').classList.contains('is-active')) renderInstances();
    fillSettings();
  });

  api.onConfigChanged((config) => {
    state.config = config;
    state.instances = (config?.instances ?? []).map((inst) => ({ ...inst }));
    fillSettings();
  });
}

boot().catch((error) => {
  console.error('[settings] 初始化失败', error);
  document.body.innerHTML = `<pre style="padding:24px;color:#fca5a5">设置界面初始化失败：${String(error?.message ?? error)}</pre>`;
});

void ELEMENT_TYPE;
