#!/usr/bin/env node
'use strict';

/**
 * 校验 presets/ 下所有 input-overlay 5.x 预设：
 *  - JSON 能否解析、必要字段是否齐全
 *  - 元素类型是否在 0~9 范围内
 *  - 图集 PNG 是否存在、mapping 是否越界
 *  - 记录每个预设的尺寸、元素数量、包含的输入类型
 *
 * 用法：npm run check
 */

const fs = require('fs');
const path = require('path');
const { listPresets, safeInside } = require('../src/main/presets');

const ROOT = path.resolve(__dirname, '..');
const PRESET_ROOT = path.join(ROOT, 'presets');
const META_FILE = path.join(ROOT, 'preset-meta.json');

const TYPE_NAME = {
  0: 'texture',
  1: 'keyboard',
  2: 'gamepad_button',
  3: 'mouse_button',
  4: 'wheel',
  5: 'analog_stick',
  6: 'trigger',
  7: 'gamepad_id',
  8: 'dpad',
  9: 'mouse_movement',
};

function pngSize(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { __error: error.message };
  }
}

function main() {
  const meta = readJsonSafe(META_FILE);
  const presets = listPresets({
    roots: [
      { dir: PRESET_ROOT, metaFile: META_FILE, source: 'builtin' },
    ],
    meta,
  });

  const errors = [];
  const warnings = [];
  const rows = [];

  for (const preset of presets) {
    const layout = readJsonSafe(preset.jsonPath);
    if (layout.__error) {
      errors.push(`${preset.id}: JSON 解析失败 (${layout.__error})`);
      continue;
    }

    if (!preset.texturePath) {
      errors.push(`${preset.id}: 找不到对应的 PNG 图集`);
      continue;
    }
    if (!safeInside(PRESET_ROOT, preset.texturePath)) {
      errors.push(`${preset.id}: 图集路径越界 ${preset.texturePath}`);
      continue;
    }

    const size = pngSize(preset.texturePath);
    if (!size) {
      errors.push(`${preset.id}: 图集不是有效的 PNG`);
      continue;
    }

    const counts = {};
    let outOfBounds = 0;
    let badType = 0;
    for (const element of layout.elements ?? []) {
      const type = Number(element.type);
      if (!(type in TYPE_NAME)) {
        badType += 1;
        errors.push(`${preset.id}: 未知元素类型 ${element.type} (id=${element.id})`);
        continue;
      }
      counts[TYPE_NAME[type]] = (counts[TYPE_NAME[type]] ?? 0) + 1;

      const mapping = element.mapping;
      if (!Array.isArray(mapping) || mapping.length !== 4) {
        errors.push(`${preset.id}: 元素 ${element.id} 缺少 mapping`);
        continue;
      }
      const [u, v, w, h] = mapping.map(Number);
      if (u < 0 || v < 0 || w <= 0 || h <= 0) {
        errors.push(`${preset.id}: 元素 ${element.id} mapping 非法 [${mapping}]`);
        continue;
      }
      // 不同元素类型的附加帧排布不同：
      //  按钮类（键盘 / 鼠标 / 手柄 / 摇杆 / 扳机）在下方 v + h + 3
      //  滚轮 / 手柄编号 / 十字键在右侧同一行依次排列
      const gap = 3;
      const frameBottom = v + h * 2 + gap;
      const frameRight = (count) => u + w * count + gap * (count - 1);
      let bad = u + w > size.width + 1;
      if ([1, 2, 3, 5, 6].includes(type)) bad = bad || frameBottom > size.height + 2;
      if (type === 4) bad = bad || frameRight(4) > size.width + 2;
      if (type === 7) bad = bad || frameRight(5) > size.width + 2;
      if (type === 8) bad = bad || frameRight(9) > size.width + 2;
      if (bad) outOfBounds += 1;
    }

    if (outOfBounds > 0) {
      warnings.push(`${preset.id}: ${outOfBounds} 个元素的帧（含按下态）超出图集 ${size.width}×${size.height}`);
    }
    if (badType > 0) {
      warnings.push(`${preset.id}: ${badType} 个元素类型未知`);
    }
    if (!layout.overlay_width || !layout.overlay_height) {
      warnings.push(`${preset.id}: 缺少 overlay_width / overlay_height`);
    }

    rows.push({
      id: preset.id,
      name: preset.name,
      category: preset.category,
      size: `${preset.width}x${preset.height}`,
      texture: `${size.width}x${size.height}`,
      elements: preset.elementCount,
      types: Object.entries(counts)
        .map(([k, v]) => `${k}:${v}`)
        .join(' '),
    });
  }

  const width = Math.max(...rows.map((r) => r.id.length), 4);
  console.log(`\n共发现 ${presets.length} 个预设\n`);
  for (const row of rows) {
    console.log(
      `${row.id.padEnd(width)}  ${row.name.padEnd(24, ' ')} ${row.category.padEnd(9)} ` +
        `画布 ${row.size.padEnd(9)} 图集 ${row.texture.padEnd(9)} 元素 ${String(row.elements).padStart(3)}  ${row.types}`,
    );
  }

  if (warnings.length) {
    console.log('\n提示：');
    for (const warning of warnings) console.log(`  ! ${warning}`);
  }

  if (errors.length) {
    console.log('\n错误：');
    for (const error of errors) console.log(`  × ${error}`);
    process.exitCode = 1;
  } else {
    console.log('\n全部预设校验通过。');
  }

  const metaIds = new Set((meta.presets ?? []).map((p) => p.id));
  const builtIds = new Set(presets.map((p) => p.id));
  const missing = [...metaIds].filter((id) => !builtIds.has(id));
  if (missing.length) {
    console.log(`\n清单中未加载的预设：${missing.join(', ')}`);
    process.exitCode = 1;
  }
}

main();
