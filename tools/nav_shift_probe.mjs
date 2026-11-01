/**
 * 切页瞬间位移采样：模拟「已滚动一段距离 → 点击另一个页面」的真实路径，
 * 每 16ms 记一次 scrollY / 文档高 / 主区 left+top，看是不是滚动位置没重置导致错位。
 *
 *   node tools/nav_shift_probe.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 允许 `--key=value` 与 `--key value` 两种写法（历史上探针混用，写错会被静默忽略）
process.argv = process.argv.flatMap((a) => {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  return m ? [`--${m[1]}`, m[2]] : [a];
});
const ARG = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = (ARG('base', 'http://127.0.0.1:13800')).replace(/\/$/, '');
const W = Number(ARG('w', 1440));
const H = Number(ARG('h', 900));

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const PORT = 9599;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-nav-'));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
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
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 640 });

const SAMPLE = `(() => {
  const m = document.querySelector('main');
  const r = m ? m.getBoundingClientRect() : {};
  return {
    t: Math.round(performance.now()),
    y: Math.round(window.scrollY),
    dh: document.documentElement.scrollHeight,
    cw: document.documentElement.clientWidth,
    left: Math.round(r.left ?? 0),
    top: Math.round(r.top ?? 0),
    w: Math.round(r.width ?? 0),
    path: location.pathname,
    h: Math.round(r.height ?? 0),
  };
})()`;

await send('Page.navigate', { url: BASE + '/' });
await sleep(2600);

const PAGES = ['/shelf', '/search', '/libraries', '/'];
for (const page of PAGES) {
  // 先滚到中部，模拟「浏览列表后切页」
  const scrolled = await ev(`(window.scrollTo(0, 560), Math.round(window.scrollY))`);
  await sleep(120);
  const before = await ev(SAMPLE);
  await ev(`(() => { const a = document.querySelector('a[href="${page}"]'); if (a) a.click(); return true; })()`);
  const frames = [];
  for (let i = 0; i < 14; i++) { frames.push(await ev(SAMPLE)); await sleep(16); }
  console.log(`\n=== 切到 ${page}   （切换前 scrollY=${scrolled}） ===`);
  console.log(`  before: y=${before.y} dh=${before.dh} cw=${before.cw} main.left=${before.left} w=${before.w} top=${before.top}`);
  for (const f of frames) console.log(`  +${String(f.t - before.t).padStart(3)}ms  y=${f.y} dh=${f.dh} cw=${f.cw} left=${f.left} w=${f.w} top=${f.top} h=${f.h}`);
  await sleep(1200);
}

// ---- 后退（POP）要恢复离开时的位置，否则从详情/阅读器退回来会丢掉浏览上下文 ----
await send('Page.navigate', { url: BASE + '/' });
await sleep(2400);
const y0 = await ev(`(window.scrollTo(0, 120), Math.round(window.scrollY))`);
await sleep(150);
const yBefore = await ev('Math.round(window.scrollY)');
const link = await ev(`(() => { const a = document.querySelector('a[href^="/comic/"]'); if (!a) return null; a.click(); return a.getAttribute('href'); })()`);
await sleep(1800);
const yMid = await ev('Math.round(window.scrollY)');
await ev('history.back()');
await sleep(1600);
const yBack = await ev('Math.round(window.scrollY)');
console.log(`\n=== 后退恢复：离开时 y=${yBefore}（请求 120）→ 详情页 y=${yMid} → 后退 y=${yBack} ===`);
console.log(yBack === yBefore ? '  ✓ 后退回到原位置' : `  ✗ 期望 ${yBefore}，实际 ${yBack}`);

// ---- 阅读器：全屏沉浸，不能留滚动条槽 ----
const comics = (await (await fetch(BASE + '/api/comics?pageSize=10')).json()).data.items;
const c0 = comics.find((c) => !/perf/i.test(c.title)) ?? comics[0];
const ch0 = ((await (await fetch(`${BASE}/api/comics/${c0.id}`)).json()).data.chapters ?? [])[0];
if (ch0) {
  await send('Page.navigate', { url: `${BASE}/read/${c0.id}/${encodeURIComponent(ch0.id)}?page=0` });
  await sleep(2200);
  const rd = await ev(`(() => ({ cw: document.documentElement.clientWidth, iw: innerWidth, lock: document.body.classList.contains('reader-lock') }))()`);
  console.log(`\n=== 阅读器：clientWidth=${rd.cw} innerWidth=${rd.iw} reader-lock=${rd.lock} ===`);
  console.log(rd.cw === rd.iw && rd.lock ? '  ✓ 沉浸：无滚动条槽' : '  ✗ 阅读器仍有滚动条槽或被锁');
}

ws.close(); edge.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
