#!/usr/bin/env node
/**
 * 开发用：验证覆盖层在编辑模式下的拖动逻辑。
 * 通过 CDP 直接派发鼠标事件，拖动第一个预设并检查配置里的坐标是否变化。
 *
 * 用法：node scripts/ui-overlay-test.mjs [--port=9222]
 */
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const port = Number(args.port ?? 9222);

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((t) => t.title.includes('Overlay'));
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
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Runtime.enable');
await send('Page.enable');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
  return res.result.value;
};

const checks = [];
const check = (label, ok, detail = '') => {
  checks.push({ label, ok });
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

await evaluate(`window.keycat.setEditMode(true)`);
await sleep(800);

const before = await evaluate(`window.keycat.getState().then(s => s.config.instances[0])`);
check('编辑模式已开启', Boolean(await evaluate(`window.keycat.getState().then(s => s.editMode)`)));

const startX = Math.round(before.x + 30);
const startY = Math.round(before.y + 30);

await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: startY, button: 'left', clickCount: 1, buttons: 1 });
await sleep(80);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX + 70, y: startY + 40, button: 'left', buttons: 1 });
await sleep(80);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX + 120, y: startY + 60, button: 'left', buttons: 1 });
await sleep(80);
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: startX + 120, y: startY + 60, button: 'left', buttons: 0 });
await sleep(700);

const after = await evaluate(`window.keycat.getState().then(s => s.config.instances[0])`);
check(
  '拖动后坐标更新',
  Math.abs(after.x - (before.x + 120)) < 10 && Math.abs(after.y - (before.y + 60)) < 10,
  `(${before.x},${before.y}) → (${after.x},${after.y})`,
);

const screenshot = await send('Page.captureScreenshot', { format: 'png' });
fs.mkdirSync(path.resolve('.preview'), { recursive: true });
fs.writeFileSync(path.resolve('.preview/overlay-edit.png'), Buffer.from(screenshot.data, 'base64'));

await evaluate(`window.keycat.setEditMode(false)`);
await sleep(300);

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`);
ws.close();
process.exit(failed.length ? 1 : 0);
