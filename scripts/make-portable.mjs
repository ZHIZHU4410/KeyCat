#!/usr/bin/env node
/**
 * 生成免安装版目录 + 压缩包（安装脚本内置其中）。
 *
 * 用法：node scripts/make-portable.mjs [--zip]
 *
 * 流程：
 *  1. 把 dist/win-unpacked 复制成 dist/portable/KeyCat-<版本>
 *  2. 写入 install.cmd / uninstall.cmd / 使用说明.txt（cmd 转成 CRLF + ASCII）
 *  3. 可选：用 7za 压成 dist/KeyCat-<版本>-win-x64.zip
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

const SRC = path.join(ROOT, 'dist', 'win-unpacked');
const STAGE = path.join(ROOT, 'dist', 'portable', `KeyCat-${VERSION}`);
const TEMPLATES = path.join(ROOT, 'scripts', 'portable');

if (!fs.existsSync(SRC)) {
  console.error(`找不到 ${path.relative(ROOT, SRC)}，先执行 npm run dist`);
  process.exit(1);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const fromPath = path.join(from, entry.name);
    const toPath = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(fromPath, toPath);
    else if (entry.isFile()) fs.copyFileSync(fromPath, toPath);
  }
}

function writeText(file, text, { crlf = false, ascii = false } = {}) {
  let out = crlf ? text.replace(/\r?\n/g, '\r\n') : text;
  if (ascii) out = out.replace(/[^\x00-\x7F]/g, '?');
  fs.writeFileSync(file, out, 'utf8');
}

console.log(`› 复制 ${path.relative(ROOT, SRC)} → ${path.relative(ROOT, STAGE)}`);
fs.rmSync(STAGE, { recursive: true, force: true });
copyDir(SRC, STAGE);

// 清掉可能残留的日志 / 缓存
for (const junk of ['installer.log', 'startup.log', 'run.log']) {
  fs.rmSync(path.join(STAGE, junk), { force: true });
}

console.log('› 写入安装脚本');
for (const name of ['install.cmd', 'uninstall.cmd']) {
  const text = fs.readFileSync(path.join(TEMPLATES, name), 'utf8');
  writeText(path.join(STAGE, name), text, { crlf: true, ascii: true });
}
writeText(path.join(STAGE, '使用说明.txt'), fs.readFileSync(path.join(TEMPLATES, '使用说明.txt'), 'utf8'));

// 压缩包根目录再放一份「先解压」提示 + 一键安装入口，
// 避免有人直接在压缩包里双击 KeyCat.exe（那样只会解出单个 exe，缺 resources/ 必然打不开）
const ROOT_DIR = path.join(ROOT, 'dist', 'portable');
writeText(path.join(ROOT_DIR, '❗先解压整个文件夹再运行.txt'), fs.readFileSync(path.join(TEMPLATES, '先解压.txt'), 'utf8'));
writeText(
  path.join(ROOT_DIR, '一键安装（创建快捷方式）.cmd'),
  [
    '@echo off',
    'setlocal',
    'cd /d "%~dp0"',
    `if not exist "%~dp0KeyCat-${VERSION}\\KeyCat.exe" (`,
    '  echo [!] KeyCat-%VERSION% 文件夹不完整，请先把压缩包完整解压。',
    '  pause',
    '  exit /b 1',
    ')',
    `cd /d "%~dp0KeyCat-${VERSION}"`,
    'call install.cmd',
    '',
  ].join('\r\n'),
  { crlf: true, ascii: true },
);

if (process.argv.includes('--zip')) {
  const zipFile = path.join(ROOT, 'dist', `KeyCat-${VERSION}-win-x64.zip`);
  fs.rmSync(zipFile, { force: true });

  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', '7zip@1.0.0', '7zip-win-x64-1nrf7', 'bin', '7za.exe'),
    'C:\\Program Files\\7-Zip\\7z.exe',
  ];
  const zipper = candidates.find((p) => p && fs.existsSync(p));

  if (zipper) {
    console.log(`› 压缩（${path.basename(zipper)}）`);
    const result = spawnSync(zipper, ['a', '-tzip', '-mx=5', '-mmt=on', zipFile, `KeyCat-${VERSION}`, '❗先解压整个文件夹再运行.txt', '一键安装（创建快捷方式）.cmd'], {
      cwd: path.join(ROOT, 'dist', 'portable'),
      stdio: 'inherit',
    });
    if (result.status !== 0) process.exit(result.status || 1);
  } else {
    console.log('› 压缩（PowerShell Compress-Archive）');
    const result = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `Compress-Archive -Force -Path '${STAGE}' -DestinationPath '${zipFile}'`],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) process.exit(result.status || 1);
  }

  const size = fs.statSync(zipFile).size;
  console.log(`✓ ${path.relative(ROOT, zipFile)}  ${(size / 1024 / 1024).toFixed(1)} MB`);
} else {
  console.log(`✓ 免安装目录已生成：${path.relative(ROOT, STAGE)}`);
}
