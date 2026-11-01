/**
 * 「意外滚动条」扫描：找出被伪元素撑出来、或被 overflow 计算规则带出来的滚动条。
 *
 * 背景：`overflow-x: auto` 会让 `overflow-y` 的计算值变成 `auto`，此时只要纵向有
 * 1px 溢出（例如 .touch-hit::after 比元素本身高 10px），浏览器就会真的创建一条
 * 竖向滚动条 —— 实机表现是「标签栏右侧多出一条灰色竖条」。这类问题肉眼在小截图里
 * 很容易漏，用本脚本可以一次性扫全站。
 *
 * 判据：滚动条占位 = offset - client - border > 0，且真实溢出量 ≤2px
 *       （真内容溢出不算问题，本来就该有滚动条）。
 *       排除 html/body（offsetHeight 反映内容高，不是滚动条）与 inline 元素
 *       （inline 无可靠 offset/client 语义，长文本必然误报）。
 *
 *   node tools/scroll_leak_check.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = 'http://127.0.0.1:13800';
const COMIC = '8a47483571299bde';

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const PORT = 9721;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-scroll-'));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });

let wsUrl;
for (let i = 0; i < 80; i++) {
  try { const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = t.find((x) => x.type === 'page'); if (p) { wsUrl = p.webSocketDebuggerUrl; break; } } catch { /* 等 */ }
  await sleep(150);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
const send = (m, p = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await send('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }] });

const SCAN = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    if (el === document.documentElement || el === document.body) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'inline' || cs.display === 'contents') continue;
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const bl = parseFloat(cs.borderLeftWidth) || 0, br = parseFloat(cs.borderRightWidth) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0, bb = parseFloat(cs.borderBottomWidth) || 0;
    // offset-client 里含 border，必须扣掉，否则每个带描边的卡片都会被误报
    const vBar = el.offsetWidth - el.clientWidth - bl - br;
    const hBar = el.offsetHeight - el.clientHeight - bt - bb;
    if (vBar > 0 && el.scrollHeight - el.clientHeight <= 2) {
      out.push({ t: 'vbar', px: vBar, tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 56) });
    }
    if (hBar > 0 && el.scrollWidth - el.clientWidth <= 2) {
      out.push({ t: 'hbar', px: hBar, tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 56) });
    }
  }
  return out;
})()`;

let total = 0;
const report = (label, list) => {
  total += list.length;
  console.log(`${label.padEnd(28)} ${list.length === 0 ? '✓ 0 处' : `✗ ${list.length} 处`}`);
  list.slice(0, 5).forEach((x) => console.log(`      ${x.t} ${x.px}px  <${x.tag}> .${x.cls}`));
};

const routes = ['/', '/shelf', '/search', '/libraries', '/settings', `/comic/${COMIC}`];
for (const r of routes) {
  await send('Page.navigate', { url: BASE + r });
  await sleep(1800);
  report(r, await ev(SCAN));
}

await send('Page.navigate', { url: `${BASE}/read/${COMIC}/${encodeURIComponent(COMIC + '#0')}` });
await sleep(2400);
report('reader', await ev(SCAN));
for (const [label, sel] of [['  reader · 章节抽屉', '[aria-label="章节目录"]'], ['  reader · 阅读设置', '[aria-label="阅读设置"]']]) {
  await ev(`document.querySelector('${sel}')?.click()`);
  await sleep(900);
  report(label, await ev(SCAN));
  await ev(`document.querySelector('[aria-label="关闭"]')?.click()`);
  await sleep(600);
}

console.log(`\n合计：${total} 处意外滚动条`);
ws.close();
edge.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(total ? 1 : 0);
