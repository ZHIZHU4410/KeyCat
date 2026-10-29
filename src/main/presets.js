'use strict';

const fs = require('fs');
const path = require('path');

const CATEGORY_ORDER = ['keyboard', 'mouse', 'gamepad', 'other'];

const CATEGORY_LABEL = {
  keyboard: '键盘',
  mouse: '鼠标',
  gamepad: '手柄',
  other: '其他',
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listFiles(dir, ext) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(ext))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function walkJson(dir, acc = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJson(full, acc);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) acc.push(full);
  }
  return acc;
}

function pickFile(dir, wanted) {
  const files = listFiles(dir, '.png');
  const exact = files.find((f) => f.toLowerCase() === wanted.toLowerCase());
  if (exact) return exact;
  const loose = files.find((f) => f.toLowerCase().replace(/[\s_-]/g, '').includes(wanted.toLowerCase().replace(/[\s_-]/g, '')));
  return loose ?? null;
}

/**
 * 找到 layout JSON 对应的图集 PNG。
 * input-overlay 的预设里 json 与 png 是分开的两个文件，命名并不总是严格一致，
 * 因此按下面的顺序推断：
 *   1. 与 JSON 同名的 PNG
 *   2. 与所在文件夹同名的 PNG
 *   3. 文件夹里唯一的 PNG
 *   4. 文件夹里排序最靠前的 PNG
 */
function resolveTexture(jsonPath) {
  const dir = path.dirname(jsonPath);
  const base = path.basename(jsonPath, path.extname(jsonPath));
  const byBase = pickFile(dir, `${base}.png`);
  if (byBase) return path.join(dir, byBase);

  const byFolder = pickFile(dir, path.basename(dir));
  if (byFolder) return path.join(dir, byFolder);

  const pngs = listFiles(dir, '.png').sort();
  if (pngs.length === 1) return path.join(dir, pngs[0]);
  if (pngs.length > 1) return path.join(dir, pngs[0]);
  return null;
}

function relativeId(root, file) {
  return path.relative(root, file).replace(/\\/g, '/').replace(/\.json$/i, '');
}

function guessCategory(layout) {
  const types = new Set((layout?.elements ?? []).map((e) => e.type));
  if ([2, 5, 6, 7, 8].some((t) => types.has(t))) return 'gamepad';
  if ([3, 4, 9].some((t) => types.has(t)) && !types.has(1)) return 'mouse';
  if (types.has(1)) return 'keyboard';
  return 'other';
}

function prettyName(id) {
  const base = id.split('/').pop();
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function safeInside(root, file) {
  const resolved = path.resolve(file);
  const rootResolved = path.resolve(root);
  return resolved === rootResolved || resolved.startsWith(rootResolved + path.sep);
}

/**
 * 扫描内置预设目录 + 用户预设目录，合并 preset-meta.json 中的元数据。
 * @param {{roots: {dir: string, metaFile?: string}[], meta?: {presets: any[]}}} options
 */
function listPresets(options) {
  const { roots, meta } = options;
  const byId = new Map();
  /** 清单已经占用的 layout 文件（同一份 layout 可以配不同图集，因此只用于自动发现的去重） */
  const claimedPaths = new Set();

  const addPreset = (entry) => {
    const jsonPath = entry.jsonPath;
    if (!jsonPath || !fs.existsSync(jsonPath)) return;
    const layout = readJson(jsonPath);
    if (!layout || !Array.isArray(layout.elements)) return;

    const id = entry.id;
    const texturePath = entry.texturePath && fs.existsSync(entry.texturePath) ? entry.texturePath : resolveTexture(jsonPath);
    byId.set(id, {
      id,
      name: entry.name || prettyName(id),
      category: entry.category || guessCategory(layout),
      jsonPath,
      texturePath,
      width: Number(layout.overlay_width) || 0,
      height: Number(layout.overlay_height) || 0,
      elementCount: layout.elements.length,
      flags: Number(layout.flags) || 0,
      source: entry.source || 'builtin',
    });
  };

  for (const root of roots) {
    const rootDir = root.dir;

    // 1) 清单里的预设（支持一图多用，例如 DualSense 黑/白配色）
    if (root.metaFile && fs.existsSync(root.metaFile)) {
      const metaJson = readJson(root.metaFile);
      for (const item of metaJson?.presets ?? []) {
        if (!item || !item.json) continue;
        const jsonPath = path.resolve(rootDir, item.json);
        if (!safeInside(rootDir, jsonPath)) continue;
        const texturePath = item.texture ? path.resolve(rootDir, item.texture) : null;
        claimedPaths.add(jsonPath.toLowerCase());
        addPreset({
          id: item.id || relativeId(rootDir, jsonPath),
          name: item.name,
          category: item.category,
          jsonPath,
          texturePath: texturePath && safeInside(rootDir, texturePath) ? texturePath : null,
          source: root.source || 'builtin',
        });
      }
    }

    // 2) 目录里未被清单收录的 layout JSON（方便直接丢文件夹进来）
    for (const jsonPath of walkJson(rootDir).sort()) {
      if (claimedPaths.has(jsonPath.toLowerCase())) continue;
      addPreset({ id: relativeId(rootDir, jsonPath), jsonPath, source: root.source || 'builtin' });
    }
  }

  const presets = [...byId.values()];
  presets.sort((a, b) => {
    const ca = CATEGORY_ORDER.indexOf(a.category);
    const cb = CATEGORY_ORDER.indexOf(b.category);
    if (ca !== cb) return ca - cb;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
  return presets;
}

module.exports = {
  CATEGORY_ORDER,
  CATEGORY_LABEL,
  listPresets,
  resolveTexture,
  safeInside,
  readJson,
};
