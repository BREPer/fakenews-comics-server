/**
 * UI 视觉留档 + 慢网首屏测量。
 *
 * 用法：node tools/ui_shot.mjs [--base ...]
 * 产出：_shots/ui-*.png（深/浅两套主题），并打印慢网（3G）首屏指标。
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
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = (ARG('base', process.env.API_BASE || 'http://127.0.0.1:13800')).replace(/\/$/, '');
const api = async (p, init) => (await fetch(BASE + p, init)).json();

const list = (await api('/api/comics?pageSize=50')).data.items;
const comic = list.find((c) => !/perf/i.test(c.title)) ?? list[0];
const detail = (await api(`/api/comics/${comic.id}`)).data;
const ch = (detail.chapters ?? [])[0];

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const PORT = Number(ARG('port', '9556'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ui-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

let wsUrl;
for (let i = 0; i < 80; i++) {
  try {
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = t.find((x) => x.type === 'page');
    if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch { /* 未就绪 */ }
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
const send = (m, p = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');

const outDir = path.resolve('_shots');
fs.mkdirSync(outDir, { recursive: true });
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(r.data, 'base64'));
  console.log('  saved', name);
};

/**
 * 主题与阅读偏好只能写浏览器：2026-10-24 起这些项按设备存在 localStorage，
 * `PUT /api/settings` 会被服务端静默忽略。用 injectPrefs 在页面脚本前写好。
 */
let prefs = { theme: 'light' };
async function setTheme(theme) {
  prefs = { ...prefs, theme };
}
async function goto(target) {
  await injectPrefs(send, prefs);
  await send('Page.navigate', { url: target });
  await sleep(2400);
}

// ---- 桌面：深色 ----
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await setTheme('dark');
await goto(`${BASE}/`);
await shot('ui-home-dark');
await goto(`${BASE}/comic/${comic.id}`);
await shot('ui-detail-dark');

// ---- 阅读器 + 设置面板 ----
if (ch) {
  prefs = { ...prefs, readerMode: 'single', pageAnimation: 'pan', readDir: 'ltr', fitMode: 'contain' };
  await goto(`${BASE}/read/${comic.id}/${encodeURIComponent(ch.id)}?page=0`);
  await shot('ui-reader');
  await ev(`document.querySelector('button[aria-label="阅读设置"]')?.click()`);
  await sleep(650);
  await shot('ui-reader-settings');
  await ev(`document.querySelector('button[aria-label="章节目录"]')?.click()`);
  await sleep(650);
  await shot('ui-reader-drawer');
}

// ---- 桌面：浅色 ----
await setTheme('light');
await goto(`${BASE}/`);
await shot('ui-home-light');
await goto(`${BASE}/comic/${comic.id}`);
await shot('ui-detail-light');

// ---- 移动端（深色） ----
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await setTheme('dark');
await goto(`${BASE}/`);
await shot('ui-home-mobile');

// ---- 慢网首屏（3G：400kbps / RTT 300ms，禁用缓存） ----
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/` });
await sleep(800);
await ev(`localStorage.setItem('fakenews-theme','dark'); true`);
await send('Network.clearBrowserCache');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Network.emulateNetworkConditions', {
  offline: false, latency: 300, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8,
});

// 用 PerformanceObserver 记录首个「有内容」的绘制（boot 壳含品牌文字，会被记为 FCP）
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__paint = {};
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__paint[e.name] = Math.round(e.startTime); })
      .observe({ type: 'paint', buffered: true });
    window.__bootVisibleAt = null;
    (function poll() {
      if (document.querySelector('.boot') && window.__bootVisibleAt === null) window.__bootVisibleAt = Math.round(performance.now());
      if (!window.__bootGone && !document.querySelector('.boot') && window.__bootVisibleAt !== null) {
        window.__bootGone = Math.round(performance.now());
      }
      requestAnimationFrame(poll);
    })();`,
});
const t0 = Date.now();
await send('Page.navigate', { url: `${BASE}/` });
// 等到首页真实卡片出现
let cardsAt = null;
for (let i = 0; i < 300; i++) {
  const n = await ev(`document.querySelectorAll('a[href^="/comic/"]').length`).catch(() => 0);
  if (n > 0) { cardsAt = Date.now() - t0; break; }
  await sleep(100);
}
const stats = await ev(`(() => {
  const n = performance.getEntriesByType('navigation')[0] || {};
  const res = performance.getEntriesByType('resource');
  const pick = (ext) => { const r = res.find((x) => x.name.split('?')[0].endsWith(ext)); return r ? Math.round(r.responseEnd) : null; };
  return {
    paint: window.__paint,
    bootVisibleAt: window.__bootVisibleAt,
    bootGone: window.__bootGone ?? null,
    domContentLoaded: Math.round(n.domContentLoadedEventEnd || 0),
    load: Math.round(n.loadEventEnd || 0),
    cssDoneAt: pick('.css'),
    jsDoneAt: pick('.js'),
  };
})()`);
console.log('\n--- 慢网（400kbps / RTT300 / 冷缓存）首页 ---');
console.log('  首次绘制(paint):', JSON.stringify(stats.paint));
console.log('  启动壳可见:', stats.bootVisibleAt, 'ms  被替换:', stats.bootGone, 'ms');
console.log('  CSS 到齐:', stats.cssDoneAt, 'ms  JS 到齐:', stats.jsDoneAt, 'ms');
console.log('  真实卡片出现:', cardsAt, 'ms');
await shot('ui-slow-net');

// 收尾无需还原：偏好全部在本机（探针用临时 profile）
ws.close();
edge.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
