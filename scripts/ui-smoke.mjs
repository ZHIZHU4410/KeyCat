#!/usr/bin/env node
/**
 * 开发用冒烟测试：通过 CDP 驱动设置窗口，检查标签切换、添加预设、
 * 自动排列、设置开关等交互是否正常，并输出每步截图。
 *
 * 用法：node scripts/ui-smoke.mjs [--port=9222]
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
const outDir = path.resolve('.preview');
fs.mkdirSync(outDir, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((t) => t.title.includes('设置'));
if (!target) {
  console.error('没有找到设置窗口（先启动 app 并打开设置）');
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const errors = [];

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
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description ?? ''));
  }
});

await new Promise((r) => ws.addEventListener('open', r, { once: true }));
await send('Runtime.enable');
await send('Page.enable');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function shot(name) {
  const data = await send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(outDir, `ui-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data.data, 'base64'));
  return file;
}

const checks = [];
function check(label, ok, detail = '') {
  checks.push({ label, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
}

// 1. 预设库
const presetCount = await evaluate(`document.querySelectorAll('#preset-grid .card').length`);
check('预设卡片渲染', presetCount === 33, `${presetCount} 张卡片`);
await shot('presets');

// 2. 搜索过滤
await evaluate(`(() => {
  const input = document.querySelector('#search');
  input.value = '鼠标';
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(350);
const filtered = await evaluate(`document.querySelectorAll('#preset-grid .card').length`);
check('搜索过滤', filtered > 0 && filtered < presetCount, `筛选出 ${filtered} 个`);
await shot('search');
await evaluate(`(() => {
  const input = document.querySelector('#search');
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(300);

// 3. 添加预设
const before = await evaluate(`window.keycat.getState().then(s => s.config.instances.length)`);
await evaluate(`document.querySelector('#preset-grid .card-add').click()`);
await sleep(600);
const after = await evaluate(`window.keycat.getState().then(s => s.config.instances.length)`);
check('点击「+」添加预设', after === before + 1, `${before} → ${after}`);

// 4. 布局页
await evaluate(`document.querySelector('.nav-item[data-tab="layout"]').click()`);
await sleep(400);
const rows = await evaluate(`document.querySelectorAll('#instance-list .row').length`);
check('布局列表渲染', rows === after, `${rows} 行`);
await shot('layout');

// 5. 调整大小滑块
const targetId = await evaluate(`document.querySelector('#instance-list .row').dataset.id`);
await evaluate(`(() => {
  const range = document.querySelector('#instance-list .row input[data-field="scale"]');
  range.value = '80';
  range.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(500);
const scale = await evaluate(
  `window.keycat.getState().then(s => (s.config.instances.find(i => i.id === '${targetId}') || {}).scale)`,
);
check('缩放滑块生效', Math.abs(scale - 0.8) < 0.001, `scale=${scale}`);

// 6. 自动排列
await evaluate(`document.querySelector('#btn-arrange').click()`);
await sleep(700);
await shot('arrange');

// 7. 隐藏 / 显示
await evaluate(`document.querySelector('#instance-list .row [data-action="visible"]').click()`);
await sleep(400);
const hidden = await evaluate(`window.keycat.getState().then(s => s.config.instances[0].visible)`);
check('显示 / 隐藏切换', hidden === false, `visible=${hidden}`);
await evaluate(`document.querySelector('#btn-show-all').click()`);
await sleep(400);

// 8. 设置页
await evaluate(`document.querySelector('.nav-item[data-tab="settings"]').click()`);
await sleep(350);
await shot('settings');

// 9. 演示模式开关
await evaluate(`(() => {
  const toggle = document.querySelector('input[data-setting="demo"]');
  toggle.checked = !toggle.checked;
  toggle.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(500);
const demo = await evaluate(`window.keycat.getState().then(s => s.config.overlay.demo)`);
check('演示模式开关', typeof demo === 'boolean', `demo=${demo}`);

// 10. 关于页
await evaluate(`document.querySelector('.nav-item[data-tab="about"]').click()`);
await sleep(300);
await shot('about');

// 11. 编辑模式
await evaluate(`document.querySelector('#btn-edit').click()`);
await sleep(600);
const edit = await evaluate(`window.keycat.getState().then(s => s.editMode)`);
check('编辑模式切换', edit === true, `editMode=${edit}`);
await evaluate(`document.querySelector('#btn-edit').click()`);
await sleep(400);

if (errors.length) {
  console.log('--- 页面异常 ---');
  for (const e of errors) console.log(e);
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`);
ws.close();
process.exit(failed.length ? 1 : 0);
