// 运行时探针：在真实浏览器里跑遍所有页面与关键交互，抓「静态审查看不到」的问题：
//   - 未捕获异常 / 未处理的 Promise rejection
//   - console.error / console.warn（生产构建下这些通常意味着真错误）
//   - 资源加载失败（img/script/css，capture 阶段才能收到 img 的 error）
//   - 反复进出阅读器的 JS 堆与 DOM 节点增长（内存泄漏）
//
// 用法：node tools/runtime_probe.mjs [--cycles=10] [--shots]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 允许 `--key=value` 与 `--key value` 两种写法（历史上探针混用，写错会被静默忽略）
process.argv = process.argv.flatMap((a) => {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  return m ? [`--${m[1]}`, m[2]] : [a];
});
const ARG = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (hit) return hit.split('=')[1];
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const FLAG = (n) => process.argv.includes(`--${n}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE = 'http://127.0.0.1:13800';
const CYCLES = Number(ARG('cycles', 8));
const PORT = 9801;
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
if (!EDGE) {
  console.error('未找到 Edge');
  process.exit(1);
}

const api = async (p) => (await fetch(BASE + p)).json();
const comics = (await api('/api/comics?pageSize=20')).data.items;
const one = comics[0];
const detail = (await api(`/api/comics/${one.id}`)).data;
const ch = detail.chapters?.[0];

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rt-'));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1280,860', 'about:blank'], { stdio: 'ignore' });
let wsUrl;
for (let i = 0; i < 100; i++) {
  try {
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = t.find((x) => x.type === 'page');
    if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch { /* 等 */ }
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
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;

await send('Page.enable');
await send('Runtime.enable');
await send('Performance.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });

// 每个新文档都注入收集器：错误、未处理 rejection、console.error/warn、资源加载失败
const HOOK = `(() => {
  if (window.__probe) return;
  const errs = [];
  window.__probe = errs;
  const push = (s) => { if (errs.length < 60) errs.push(String(s).slice(0, 240)); };
  window.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t !== window && (t.tagName === 'IMG' || t.tagName === 'SCRIPT' || t.tagName === 'LINK')) {
      push('资源加载失败: <' + t.tagName.toLowerCase() + '> ' + (t.src || t.href || '').replace(location.origin, ''));
    } else {
      push('error: ' + (e.message || e.type) + ' @' + String(e.filename || '').split('/').pop() + ':' + e.lineno);
    }
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    push('unhandledrejection: ' + ((r && (r.message || r.name)) || String(r)));
  });
  const ce = console.error.bind(console);
  console.error = (...a) => { push('console.error: ' + a.map((x) => (x && x.message) || String(x)).join(' ')); ce(...a); };
  const cw = console.warn.bind(console);
  console.warn = (...a) => { push('console.warn: ' + a.map(String).join(' ')); cw(...a); };
})();`;
await send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });

const collected = [];
async function visit(label, url, waitMs = 1800) {
  await send('Page.navigate', { url: BASE + url });
  await sleep(waitMs);
  const errs = await ev('window.__probe || []');
  const stats = await ev(`(() => ({
    nodes: document.getElementsByTagName('*').length,
    imgs: document.images.length,
    brokenImgs: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).length,
    title: document.title,
  }))()`);
  if (errs?.length) collected.push({ label, errs });
  return stats;
}

console.log('=== 1. 页面遍历（收集运行时错误） ===');
const routes = [
  ['首页', '/'],
  ['书架', '/shelf'],
  ['搜索', '/search'],
  ['漫画库', '/libraries'],
  ['设置', '/settings'],
  ['详情', `/comic/${one.id}`],
];
for (const [label, url] of routes) {
  const s = await visit(label, url);
  const bad = s.brokenImgs ? `  ⚠ 破图 ${s.brokenImgs}/${s.imgs}` : '';
  console.log(`  ${label.padEnd(6)} 节点 ${String(s.nodes).padStart(4)}  图片 ${s.imgs}${bad}`);
}

// 搜索交互：输入关键词看是否报错
await visit('搜索', '/search');
await ev(`(() => { const i = document.querySelector('input'); if (i) { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '海贼'); i.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
await sleep(1500);
console.log('  搜索输入已触发');

// 设置页交互：切主题（浅→深→浅）、切高亮色、拖滑块
await visit('设置', '/settings', 2000);
await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='深色'); b?.click(); })()`);
await sleep(900);
await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='浅色'); b?.click(); })()`);
await sleep(900);
console.log('  设置页：深浅主题来回切换已触发');

console.log('\n=== 2. 反复进出阅读器（内存泄漏） ===');
const readUrl = ch ? `/read/${one.id}/${encodeURIComponent(ch.id)}` : null;
let baseMetric = null;
const series = [];
if (readUrl) {
  for (let i = 0; i < CYCLES; i++) {
    await send('Page.navigate', { url: BASE + readUrl });
    await sleep(1600);
    // 翻两页，制造真实的图片与状态变化
    await ev(`(() => { for (let k=0;k<2;k++) window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})); })()`);
    await sleep(700);
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(900);
    const metric = (await send('Performance.getMetrics')).metrics;
    const heap = metric.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0;
    const dom = (await send('Memory.getDOMCounters')).nodes;
    if (i === 0) baseMetric = { heap, dom };
    series.push({ i: i + 1, heap, dom });
    process.stdout.write(`\r  第 ${i + 1}/${CYCLES} 轮：堆 ${(heap / 1048576).toFixed(1)}MB  DOM ${dom} 节点   `);
  }
  console.log('');
  const last = series[series.length - 1];
  const heapGrow = (last.heap - baseMetric.heap) / 1048576;
  const domGrow = last.dom - baseMetric.dom;
  console.log(`  首轮 → 末轮：堆 ${(baseMetric.heap / 1048576).toFixed(1)}MB → ${(last.heap / 1048576).toFixed(1)}MB（${heapGrow >= 0 ? '+' : ''}${heapGrow.toFixed(1)}MB）  DOM ${baseMetric.dom} → ${last.dom}（${domGrow >= 0 ? '+' : ''}${domGrow}）`);
  const perCycleDom = domGrow / Math.max(1, CYCLES - 1);
  const leak = heapGrow > 8 || perCycleDom > 50;
  console.log(`  判定：${leak ? '⚠ 疑似泄漏（每轮 DOM 增长 ' + perCycleDom.toFixed(0) + ' 节点 / 堆增长明显）' : '✓ 无线性增长迹象'}`);
}

console.log('\n=== 3. 运行时错误汇总 ===');
if (!collected.length) {
  console.log('  ✓ 未捕获异常 / 未处理 rejection / console.error 均为 0');
} else {
  for (const c of collected) {
    console.log(`  [${c.label}]`);
    for (const e of [...new Set(c.errs)]) console.log(`    · ${e}`);
  }
}


ws.close();
edge.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(collected.length ? 1 : 0);
