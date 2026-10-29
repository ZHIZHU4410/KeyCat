#!/usr/bin/env node
/**
 * 开发用：把正在运行的覆盖层窗口（透明页面）合成到一张桌面截图上，
 * 得到「用户实际看到的效果」预览图。
 *
 * 用法：
 *   node scripts/preview-compose.mjs --desktop=.preview/desktop.png --out=.preview/mockup.png
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);

const port = Number(args.port ?? 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((t) => t.type === 'page' && t.title.includes('Overlay')) ?? targets[0];
if (!target) {
  console.error('没有找到覆盖层页面');
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
});

await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
await send('Page.enable');
await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
await new Promise((r) => setTimeout(r, 400));
const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
ws.close();

const overlay = PNG.sync.read(Buffer.from(shot.data, 'base64'));
const desktopFile = path.resolve(String(args.desktop ?? '.preview/desktop.png'));
const outFile = path.resolve(String(args.out ?? '.preview/mockup.png'));
const desktop = PNG.sync.read(fs.readFileSync(desktopFile));

const scaleX = desktop.width / overlay.width;
const scaleY = desktop.height / overlay.height;

for (let y = 0; y < desktop.height; y += 1) {
  const sy = Math.min(overlay.height - 1, Math.floor(y / scaleY));
  for (let x = 0; x < desktop.width; x += 1) {
    const sx = Math.min(overlay.width - 1, Math.floor(x / scaleX));
    const si = (sy * overlay.width + sx) * 4;
    const a = overlay.data[si + 3] / 255;
    if (a < 0.003) continue;
    const di = (y * desktop.width + x) * 4;
    desktop.data[di] = overlay.data[si] * a + desktop.data[di] * (1 - a);
    desktop.data[di + 1] = overlay.data[si + 1] * a + desktop.data[di + 1] * (1 - a);
    desktop.data[di + 2] = overlay.data[si + 2] * a + desktop.data[di + 2] * (1 - a);
    desktop.data[di + 3] = 255;
  }
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, PNG.sync.write(desktop));
console.log(`合成完成：${path.relative(process.cwd(), outFile)} (${desktop.width}×${desktop.height})`);
