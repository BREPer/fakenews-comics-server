/**
 * 跨章翻页探针（B2）
 *
 * 量什么：站在某章最后一页按「下一页」时，到**下一章首页图片已解码并绘制两帧**的耗时。
 * 这条路径以前是整段白屏：换章要先取章节页清单、再等首页图片，两步串行。
 *
 * 打 13800（Go 直出的生产形态），移动端视口，每轮清 HTTP 缓存 + localStorage。
 * `--cold` 连服务端缩略图缓存一起清：第一次读一章时缩略图要现编码（实测单页 33~75ms，
 * NAS 上更慢），这才是「第一次翻进某章」的真实成本。
 *
 * 用法：node tools/perf_boundary.mjs [--runs 3] [--cold] [--base http://127.0.0.1:13800]
 * 依赖：node tools/perf_fixture.mjs 造一部至少两章的漫画（ch01 30 页 + ch02 6 页）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 允许 `--key=value` 与 `--key value` 两种写法（历史上探针混用，写错会被静默忽略）
process.argv = process.argv.flatMap((a) => {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  return m ? [`--${m[1]}`, m[2]] : [a];
});
const ARG = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const BASE = ARG('base', 'http://127.0.0.1:13800').replace(/\/$/, '');
const RUNS = Number(ARG('runs', '3'));
const COLD = process.argv.includes('--cold');
const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = Number(ARG('port', '9413'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 选一部「第一章够长 + 有第二章」的漫画 ---------------- */
const api = async (p) => (await fetch(BASE + p)).json();
const list = await api('/api/comics?pageSize=50');
let target = null;
for (const c of (list?.data?.items ?? []).sort((a, b) => b.pageCount - a.pageCount)) {
  const d = (await api(`/api/comics/${c.id}`)).data;
  const chs = [...d.chapters].sort((a, b) => a.index - b.index);
  if (chs.length >= 2 && chs[0].pageCount >= 10) {
    target = { comic: d, from: chs[0], to: chs[1] };
    break;
  }
}
if (!target) throw new Error('库里没有「首章 ≥10 页且至少两章」的漫画：先跑 node tools/perf_fixture.mjs');
const { comic, from, to } = target;
const LAST = from.pageCount - 1;
const URL_FROM = `${BASE}/read/${comic.id}/${encodeURIComponent(from.id)}?page=${LAST}`;
console.log(`跨章：${from.title}（${from.pageCount} 页）→ ${to.title}（${to.pageCount} 页）`);
console.log(`起点：${URL_FROM}\n`);

/* ---------------- CDP ---------------- */
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-bnd-'));
const edge = spawn(
  EDGE,
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run',
   '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--window-size=390,844', 'about:blank'],
  { stdio: 'ignore' },
);
async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = l.find((t) => t.type === 'page');
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error('Edge 未能提供调试端口');
}
const ws = new WebSocket(await wsUrl());
const pending = new Map();
let seq = 0;
/** 本轮内收到的 /api 请求（含章节页清单） */
let apiCalls = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params.request.url.replace(BASE, '');
    if (u.startsWith('/api/')) apiCalls.push({ url: u, at: m.params.timestamp });
  }
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
});
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

const press = async (key) => {
  const code = key === 'ArrowRight' ? 39 : 37;
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: `Arrow${key === 'ArrowRight' ? 'Right' : 'Left'}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: `Arrow${key === 'ArrowRight' ? 'Right' : 'Left'}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
};

/** 页内助手：等「某章 index 页」解码两帧；返回 performance.now() */
const HELPERS = `
window.__key = ${JSON.stringify(encodeURIComponent(to.id))};
window.__waitChapterPage = (tokenKey, index, timeout = 25000) => new Promise((res, rej) => {
  const deadline = performance.now() + timeout;
  const tick = () => {
    const hit = [...document.images].filter((i) => i.src.includes('/chapters/' + tokenKey + '/pages/' + index));
    const cur = hit[hit.length - 1];
    if (cur && cur.complete && cur.naturalWidth > 0) {
      const done = () => requestAnimationFrame(() => requestAnimationFrame(() =>
        res({ t: performance.now(), w: cur.naturalWidth, h: cur.naturalHeight })));
      (cur.decode ? cur.decode().then(done, done) : done());
      return;
    }
    if (performance.now() > deadline) {
      return rej(new Error('等下一章首页超时；当前页：' +
        [...document.images].map((i) => i.src.split('/pages/').pop()).join(' | ')));
    }
    setTimeout(tick, 16);
  };
  tick();
});
window.__sameChapterPages = () => [...document.images].filter((i) => i.src.includes('/chapters/' + ${JSON.stringify(encodeURIComponent(from.id))} + '/')).length;
true;
`;

const runs = [];
for (let run = 1; run <= RUNS; run++) {
  await send('Storage.clearDataForOrigin', { origin: BASE, storageTypes: 'local_storage' });
  await send('Network.clearBrowserCache');
  // --cold：服务端缩略图缓存也清空，模拟「第一次读这一章」
  if (COLD) await fetch(`${BASE}/api/cache/clear`, { method: 'POST' });
  await send('Page.navigate', { url: URL_FROM });
  await sleep(2600);
  await evaluate(HELPERS);
  // 确认真的停在末页（??page= 已被修好，这里同时是一次回归检查）
  const atLast = await evaluate(`(() => {
    const p = Number(new URLSearchParams(location.search).get('page'));
    const imgs = [...document.images].filter(i => i.src.includes('/pages/${LAST}')).length;
    return JSON.stringify({ page: p, lastPageInDom: imgs });
  })()`);
  apiCalls = [];
  const pressAt = await evaluate('performance.now()');
  await press('ArrowRight');
  const got = await evaluate(`window.__waitChapterPage(window.__key, 0)`);
  const ms = Math.round(got.t - pressAt);
  const landed = await evaluate(`(() => {
    const seg = location.pathname.split('/');
    return JSON.stringify({ chapter: decodeURIComponent(seg[3] ?? ''), page: Number(new URLSearchParams(location.search).get('page')) });
  })()`);
  runs.push({ run, ms, atLast: JSON.parse(atLast), landed: JSON.parse(landed), apiCalls });
  const listCall = apiCalls.filter((c) => c.url.includes('/pages') && !c.url.includes('/pages/'));
  console.log(
    `run#${run}  末页就位 ${JSON.stringify(JSON.parse(atLast))}  ` +
      `跨章耗时 ${ms}ms  落点 ${landed}\n` +
      `       本轮 /api 请求 ${apiCalls.length} 个，其中章节页清单 ${listCall.length} 个` +
      (listCall.length ? `（${listCall.map((c) => c.url.split('/chapters/')[1].split('/')[0]).join(', ')}）` : '（清单已预取）'),
  );
}

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
console.log('\n──────── 汇总 ────────');
console.log(`跨章耗时（中位）  ${med(runs.map((r) => r.ms))}ms   全部：${runs.map((r) => r.ms + 'ms').join(', ')}`);

const out = path.resolve('tools/_perf/boundary.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ summary: { median: med(runs.map((r) => r.ms)) }, runs }, null, 2));
console.log(`明细：${out}`);

ws.close();
edge.kill();
await sleep(200);
process.exit(0);
