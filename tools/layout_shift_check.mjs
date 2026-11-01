/**
 * 布局偏移探针：采四个列表页「打开→数据到齐」全过程的 CLS（layout-shift），
 * 并打印每笔偏移的肇事元素，用来定位「轻微错位」到底是谁在动。
 *
 *   node tools/layout_shift_check.mjs [--pages /,/shelf,/search,/libraries]
 *
 * 只看 CLS 不听描述：transform 动画不产生 layout-shift，所以除非真元素位移，
 * 否则不会被算进来（能区分「动画观感」与「真的跳了一下」）。
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
const PAGES = ARG('pages', '/,/shelf,/search,/libraries').split(',');
const MODE = ARG('mode', 'spa'); // spa=先停在首页再点导航切过去（用户实际路径）｜cold=直接打开
const WAIT = Number(ARG('wait', 3200));

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const PORT = 9598;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-cls-'));
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
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

// 每页导航前重置，只统计这一次导航
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__cls = [];
    window.__clsTotal = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        window.__clsTotal += e.value;
        const src = (e.sources || []).map((s) => {
          const n = s.node;
          const r = s.currentRect || {};
          const pr = s.previousRect || {};
          return {
            tag: n ? n.nodeName : '?',
            cls: n && n.className && typeof n.className === 'string' ? n.className.slice(0, 60) : '',
            text: n && n.textContent ? n.textContent.trim().slice(0, 24) : '',
            dx: Math.round((r.x ?? 0) - (pr.x ?? 0)),
            dy: Math.round((r.y ?? 0) - (pr.y ?? 0)),
            dw: Math.round((r.width ?? 0) - (pr.width ?? 0)),
            dh: Math.round((r.height ?? 0) - (pr.height ?? 0)),
          };
        });
        window.__cls.push({ t: Math.round(e.startTime), v: +e.value.toFixed(4), src });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  `,
});

console.log(`CLS 探针 → ${BASE}   mode=${MODE}`);
let worst = 0;

if (MODE === 'spa') {
  // 先停在首页，之后的切页都走 SPA 内导航（这才是用户说的「打开页面时」）
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(2800);
}

for (const page of PAGES) {
  if (MODE === 'spa' && page !== '/') {
    await ev('window.__clsTotal = 0; window.__cls = []; true');
    await ev(`(() => { const a = document.querySelector('a[href="${page}"]'); if (a) a.click(); return !!a; })()`);
  } else {
    await send('Page.navigate', { url: BASE + page });
  }
  await sleep(WAIT);
  const res = await ev('({ total: window.__clsTotal, list: window.__cls, w: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, hasSb: window.innerWidth - document.documentElement.clientWidth })');
  const total = res?.total ?? 0;
  worst = Math.max(worst, total);
  console.log(`\n=== ${page}   CLS=${total.toFixed(4)}  (${(res?.list ?? []).length} 笔)   clientWidth=${res?.w} 滚动条=${res?.hasSb}px 文档高=${res?.sh} ===`);
  for (const e of res?.list ?? []) {
    const s = e.src?.[0];
    console.log(
      `  t=${e.t}ms  ${e.v.toFixed(4)}  ${s ? `${s.tag}.${s.cls}  dy=${s.dy} dh=${s.dh} dw=${s.dw}  「${s.text}」` : '(无 source)'}`,
    );
  }
}

ws.close(); edge.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
console.log(`\n最大 CLS = ${worst.toFixed(4)}（Google 建议 < 0.1，理想 < 0.05）`);
