#!/usr/bin/env node
/**
 * 开发用：通过 CDP 连接正在运行的 Electron 窗口，
 * 收集控制台输出 / 异常，并截图。
 *
 * 用法：
 *   node scripts/debug-cdp.mjs [--port=9222] [--out=.preview/cdp.png] [--reload]
 */
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries([]);
const positional = [];
for (const arg of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
  if (m) args[m[1]] = m[2] ?? true;
  else positional.push(arg);
}
args._ = positional;

const port = Number(args.port ?? 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((t) => t.type === 'page' && (!args.title || t.title.includes(args.title))) ?? targets[0];
if (!target) {
  console.error('没有找到可调试的页面');
  process.exit(1);
}

console.log(`连接 ${target.title} (${target.url})`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const logs = [];

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
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args ?? [])
      .map((a) => a.value ?? a.description ?? a.type)
      .join(' ');
    logs.push(`[console.${msg.params.type}] ${text}`);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    logs.push(`[exception] ${d.text} ${d.exception?.description ?? ''}`);
  }
  if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry;
    logs.push(`[log.${e.level}] ${e.text} ${e.url ?? ''}`);
  }
});

await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

if (args.reload) {
  await send('Page.reload', { ignoreCache: true });
}

await new Promise((r) => setTimeout(r, 2500));

if (args.eval || args['eval-file']) {
  const expression = args['eval-file']
    ? fs.readFileSync(path.resolve(String(args['eval-file'])), 'utf8')
    : args.eval === true
      ? positional.join(' ')
      : String(args.eval);
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('eval:', JSON.stringify(result.result?.value ?? result.result));
  await new Promise((r) => setTimeout(r, 800));
}

const info = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    title: document.title,
    canvas: (() => { const c = document.querySelector('canvas'); return c ? { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight } : null; })(),
    imgs: [...document.images].map(i => ({ src: i.src.slice(0, 80), ok: i.complete && i.naturalWidth > 0, w: i.naturalWidth })),
    bodyClass: document.body.className,
    hasApi: typeof window.keycat
  })`,
  returnByValue: true,
});
console.log('DOM:', info.result.value);

if (args.out) {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.resolve(String(args.out));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log('截图:', file);
}

if (logs.length) {
  console.log('--- 控制台 ---');
  for (const line of logs) console.log(line);
} else {
  console.log('--- 控制台无输出 ---');
}

ws.close();
process.exit(0);
