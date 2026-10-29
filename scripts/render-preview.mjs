#!/usr/bin/env node
/**
 * 离屏预览：用与 Electron 完全相同的渲染引擎，把某个预设画成 PNG。
 * 用来在没有窗口 / 没接按键的情况下检查图集帧、按下态、摇杆位置是否正确。
 *
 * 用法：
 *   node scripts/render-preview.mjs --preset=wasd-minimal --out=.preview/wasd.png --pressed
 *   node scripts/render-preview.mjs --preset=mouse-dot --out=.preview/mouse.png --mouse-dx=40
 *   node scripts/render-preview.mjs --preset=gamecube --out=.preview/gc.png --pad
 *
 * 参数：
 *   --preset=<id>     预设 id（见 npm run check 的输出）
 *   --out=<file>      输出 PNG
 *   --scale=<n>       缩放倍率，默认 1
 *   --pressed         把所有键盘 / 鼠标按键都当成按下
 *   --keys=16,30,57   只按下指定 VC 键码
 *   --buttons=1,2     只按下指定鼠标键
 *   --wheel=1|-1      模拟滚轮方向
 *   --pad             模拟手柄：所有按键按下、左右摇杆偏移
 *   --mouse-dx=<n>    模拟鼠标水平位移
 *   --mouse-dy=<n>    模拟鼠标垂直位移
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { createPreset, drawPreset, ELEMENT_TYPE } from '../src/renderer/engine/layout.mjs';

const require = createRequire(import.meta.url);
const { listPresets } = require('../src/main/presets.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!match) continue;
    const key = match[1];
    const value = match[2];
    if (value === undefined) out[key] = true;
    else if (/^-?\d+(\.\d+)?$/.test(value)) out[key] = Number(value);
    else out[key] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 极简软件光栅化                                                      */
/* ------------------------------------------------------------------ */

class Raster {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
    // 棋盘格背景，方便观察透明区域
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const cell = (Math.floor(x / 12) + Math.floor(y / 12)) % 2 === 0;
        const v = cell ? 34 : 42;
        this.set(x, y, v, v + 1, v + 6, 255);
      }
    }
  }

  set(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
    this.data[i + 3] = a;
  }

  blend(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || a <= 0) return;
    const i = (y * this.width + x) * 4;
    const sa = a / 255;
    const da = this.data[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    this.data[i] = (r * sa + this.data[i] * da * (1 - sa)) / oa;
    this.data[i + 1] = (g * sa + this.data[i + 1] * da * (1 - sa)) / oa;
    this.data[i + 2] = (b * sa + this.data[i + 2] * da * (1 - sa)) / oa;
    this.data[i + 3] = oa * 255;
  }

  sample(img, sx, sy) {
    if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) return null;
    const i = (sy * img.width + sx) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
  }
}

function paintCommands(raster, commands, scale) {
  for (const cmd of commands) {
    const img = cmd.texture;
    if (!img) continue;
    const dw = cmd.dw * scale;
    const dh = cmd.dh * scale;
    const dx = cmd.dx * scale;
    const dy = cmd.dy * scale;

    if (cmd.rotation) {
      const px = (cmd.pivotX ?? cmd.dw / 2) * scale;
      const py = (cmd.pivotY ?? cmd.dh / 2) * scale;
      const cx = dx + px;
      const cy = dy + py;
      const cos = Math.cos(-cmd.rotation);
      const sin = Math.sin(-cmd.rotation);
      const radius = Math.hypot(dw, dh) / 2 + 2;
      const x0 = Math.floor(cx - radius);
      const x1 = Math.ceil(cx + radius);
      const y0 = Math.floor(cy - radius);
      const y1 = Math.ceil(cy + radius);
      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          const rx = x - cx;
          const ry = y - cy;
          const lx = rx * cos - ry * sin + px;
          const ly = rx * sin + ry * cos + py;
          if (lx < 0 || ly < 0 || lx >= dw || ly >= dh) continue;
          const sx = Math.floor(cmd.sx + (lx / dw) * cmd.sw);
          const sy = Math.floor(cmd.sy + (ly / dh) * cmd.sh);
          const px0 = raster.sample(img, sx, sy);
          if (px0) raster.blend(x, y, px0[0], px0[1], px0[2], px0[3]);
        }
      }
      continue;
    }

    for (let y = 0; y < Math.round(dh); y += 1) {
      for (let x = 0; x < Math.round(dw); x += 1) {
        const sx = Math.floor(cmd.sx + (x / dw) * cmd.sw);
        const sy = Math.floor(cmd.sy + (y / dh) * cmd.sh);
        const px0 = raster.sample(img, sx, sy);
        if (px0) raster.blend(Math.round(dx) + x, Math.round(dy) + y, px0[0], px0[1], px0[2], px0[3]);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function loadPng(file) {
  const buffer = fs.readFileSync(file);
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: png.data };
}

function main() {
  const args = parseArgs(process.argv);
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'preset-meta.json'), 'utf8'));
  const presets = listPresets({
    roots: [{ dir: path.join(ROOT, 'presets'), metaFile: path.join(ROOT, 'preset-meta.json'), source: 'builtin' }],
    meta,
  });

  if (!args.preset) {
    console.log('可用预设：\n' + presets.map((p) => `  ${p.id.padEnd(22)} ${p.name}`).join('\n'));
    process.exitCode = 1;
    return;
  }

  const presetMeta = presets.find((p) => p.id === args.preset || p.name === args.preset);
  if (!presetMeta) {
    console.error(`找不到预设：${args.preset}`);
    process.exitCode = 1;
    return;
  }

  const layout = JSON.parse(fs.readFileSync(presetMeta.jsonPath, 'utf8'));
  const preset = createPreset(layout);
  const texture = loadPng(presetMeta.texturePath);

  const keys = new Set();
  const mouseButtons = new Set();
  const pressAll = Boolean(args.pressed);

  for (const el of preset.elements) {
    if (pressAll && (el.type === ELEMENT_TYPE.KEYBOARD_KEY || el.type === ELEMENT_TYPE.MOUSE_BUTTON)) {
      if (el.type === ELEMENT_TYPE.KEYBOARD_KEY) keys.add(el.code);
      else mouseButtons.add(el.code);
    }
  }
  if (args.keys) {
    String(args.keys)
      .split(',')
      .filter(Boolean)
      .forEach((code) => keys.add(Number(code)));
  }
  if (args.buttons) {
    String(args.buttons)
      .split(',')
      .filter(Boolean)
      .forEach((button) => mouseButtons.add(Number(button)));
  }

  let pad = null;
  if (args.pad) {
    pad = {
      index: 0,
      id: 'KeyCat simulated pad',
      mapping: 'standard',
      axes: [0.8, -0.6, -0.7, 0.5],
      buttons: Array.from({ length: 17 }, () => ({ pressed: true, value: 1 })),
    };
    pad.buttons[6] = { pressed: true, value: 0.65 };
    pad.buttons[7] = { pressed: true, value: 1 };
  }

  const input = {
    keys,
    mouseButtons,
    wheelDir: args.wheel ? Number(args.wheel) : 0,
    mouseDX: Number(args['mouse-dx'] ?? 0),
    mouseDY: Number(args['mouse-dy'] ?? 0),
    mouseSensitivity: 100,
    mouseDeadzone: 0,
    pad,
  };

  const scale = Number(args.scale ?? 1);
  const width = Math.ceil(preset.width * scale) + 8;
  const height = Math.ceil(preset.height * scale) + 8;

  const view = {
    texture,
    textureWidth: texture.width,
    textureHeight: texture.height,
    input,
  };

  // 鼠标光点 / 箭头需要先跑几帧平滑，才能到稳定位置
  let commands = drawPreset(preset, view, 16);
  for (let i = 0; i < 12; i += 1) commands = drawPreset(preset, view, 16);

  const raster = new Raster(width, height);
  paintCommands(raster, commands, scale);

  const outFile = path.resolve(ROOT, args.out ?? path.join('.preview', `${presetMeta.id}.png`));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  const png = new PNG({ width, height });
  png.data = Buffer.from(raster.data.buffer);
  fs.writeFileSync(outFile, PNG.sync.write(png));

  console.log(
    `${presetMeta.id} · ${presetMeta.name}\n` +
      `  画布 ${preset.width}×${preset.height} · 图集 ${texture.width}×${texture.height} · ${preset.elements.length} 个元素\n` +
      `  绘制指令 ${commands.length} 条 · 输出 ${path.relative(ROOT, outFile)} (${width}×${height})`,
  );
}

main();
