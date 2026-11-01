/**
 * 一次性：打开阅读器章节抽屉的四格视图，核对「已读」格子的样子（与详情页共用 .chapter-done）。
 * 用法：node tools/drawer_shot.mjs --theme=light --comic=<id>
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { injectPrefs } from './lib/prefs.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 允许 `--key=value` 与 `--key value` 两种写法（历史上探针混用，写错会被静默忽略）
process.argv = process.argv.flatMap((a) => {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  return m ? [`--${m[1]}`, m[2]] : [a];
});
const ARG = (n, d) => {
  const kv = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (kv) return kv.slice(n.length + 3);
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = ARG('base', 'http://127.0.0.1:13800').replace(/\/$/, '');
const THEME = ARG('theme', 'light');
const COMIC = ARG('comic', '8a47483571299bde');
const TAG = ARG('tag', 'x');
const api = async (p, i) => (await fetch(BASE + p, i)).json();
// 主题按设备存在 localStorage（服务端 PUT 已被静默忽略），导航前注入

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const PORT = 9633;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-drawer-'));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
let wsUrl;
for (let i = 0; i < 80; i++) {
  try { const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = t.find((x) => x.type === 'page'); if (p) { wsUrl = p.webSocketDebuggerUrl; break; } } catch { /* */ }
  await sleep(150);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
const send = (m, p = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await injectPrefs(send, { theme: THEME });

await send('Page.navigate', { url: `${BASE}/read/${encodeURIComponent(COMIC)}/${encodeURIComponent(COMIC + '#0')}?page=1` });
await sleep(2600);
await ev(`localStorage.setItem('fn:chapterView','grid')`);
await send('Page.reload');
await sleep(2600);
// 抽屉按钮：aria-label=章节目录
await ev(`document.querySelector('[aria-label="章节目录"]')?.click()`);
await sleep(700);
fs.mkdirSync(path.resolve('_shots'), { recursive: true });
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.resolve('_shots', `drawer-${COMIC}-${TAG}.png`), Buffer.from(shot.data, 'base64'));
const rect = await ev(`(() => { const g = document.querySelector('.grid.grid-cols-4'); if (!g) return null; const r = g.getBoundingClientRect(); return { x: r.left - 4, y: r.top - 4, w: r.width + 8, h: r.height + 8 }; })()`);
if (rect) {
  const zoom = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 2 } });
  fs.writeFileSync(path.resolve('_shots', `drawer-zoom-${COMIC}-${TAG}.png`), Buffer.from(zoom.data, 'base64'));
  console.log('saved zoom');
}
// 顺便报告已读格子的实际渲染色（阅读器里是否拿到了深色变量）
console.log(await ev(`(() => { const cells=[...document.querySelectorAll('.grid.grid-cols-4 button')]; return cells.filter(c=>c.className.includes('chapter-done')).map(c=>({ t:c.textContent, color:getComputedStyle(c).color })); })()`));
console.log('isDark', await ev(`document.documentElement.className`));
ws.close(); edge.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
