/**
 * 一次性体检：首页在「真实手机网络」下的可感知指标。
 *
 * 为什么打 13800 而不是 5173：5173 是 Vite dev server，按模块逐个请求（几百个），
 * 量出来的是开发环境的数字；生产包是单个 bundle，才是用户看到的。
 *
 * 采集：FCP / LCP / 首张卡片可见时间 / 图片请求数与字节数 / 长任务
 *
 * node tools/perf_audit.mjs [--net=4g|none] [--url=/]
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
const ARG = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = ARG('base', 'http://127.0.0.1:13800').replace(/\/$/, '');
const NET = ARG('net', '4g');
const ROUTE = ARG('url', '/');
const PORT = 9780;

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-perf-'));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });

let wsUrl;
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((x) => x.type === 'page');
    if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch { /* 等待 */ }
  await sleep(150);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
});
const send = (method, params = {}) =>
  new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) =>
  (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

// 手机 4G 的常见档位（Slow 4G：1.6Mbps / 150ms RTT）
if (NET === '4g') {
  await send('Network.enable');
  await send('Network.emulateNetworkConditions', {
    offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8,
  });
}

// 在页面脚本之前埋点：LCP + 首张卡片出现时间
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__audit = { lcp: 0, firstCard: 0, longTasks: 0 };
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__audit.lcp = Math.round(e.startTime);
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((l) => { window.__audit.longTasks += l.getEntries().length; })
        .observe({ type: 'longtask', buffered: true });
    } catch (e) {}
    const tick = () => {
      if (!window.__audit.firstCard) {
        const a = document.querySelector('a[href^="/comic/"]');
        if (a && a.getBoundingClientRect().width > 0) window.__audit.firstCard = Math.round(performance.now());
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  `,
});

const t0 = Date.now();
await send('Page.navigate', { url: BASE + ROUTE });
await sleep(12000);

const data = await ev(`(() => {
  const paint = performance.getEntriesByType('paint').reduce((m, p) => (m[p.name] = Math.round(p.startTime), m), {});
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const res = performance.getEntriesByType('resource');
  const pick = (re) => res.filter((r) => re.test(r.name));
  const bytes = (arr) => Math.round(arr.reduce((s, r) => s + (r.encodedBodySize || 0), 0));
  const imgs = pick(/\\.(png|jpe?g|webp|avif)(\\?|$)/i);
  const js = pick(/\\.js(\\?|$)/i);
  return {
    fcp: paint['first-contentful-paint'] ?? null,
    lcp: window.__audit.lcp || null,
    firstCard: window.__audit.firstCard || null,
    longTasks: window.__audit.longTasks,
    domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0),
    loadEvent: Math.round(nav.loadEventEnd || 0),
    cards: document.querySelectorAll('a[href^="/comic/"]').length,
    imgCount: imgs.length,
    imgKB: Math.round(bytes(imgs) / 1024),
    jsKB: Math.round(bytes(js) / 1024),
    reqCount: res.length,
  };
})()`);

console.log(`网络档位=${NET}  路由=${ROUTE}  墙钟=${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(JSON.stringify(data, null, 1));

ws.close();
edge.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
