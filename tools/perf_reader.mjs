/**
 * 阅读器运行时探针（B1）
 *
 * 量什么：
 *   1. 首屏可见页：从导航开始到第 0 页图片「已解码并绘制两帧」的耗时；
 *   2. 翻页延迟：按 ArrowRight 到下一页可见的耗时（区分「已预加载命中缓存」与「现取」）；
 *   3. 图片请求明细：每个 /pages/ 请求的 transferSize / 是否命中缓存 / 耗时。
 *
 * 为什么打 13800 而不是 5173：5173 是 Vite dev server（未打包、带 HMR 客户端），
 * 生产形态是 Go 服务直出 dist（含 .gz 预压缩），只有它代表用户真实体验。
 *
 * 用法：node tools/perf_reader.mjs [--runs 3] [--turns 3] [--base http://127.0.0.1:13800]
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
const TURNS = Number(ARG('turns', '3'));
const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = Number(ARG('port', '9411'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 取一部有章节的漫画 ---------------- */
const api = async (p) => {
  const r = await fetch(BASE + p);
  return r.json();
};
const list = await api('/api/comics?pageSize=50');
// 选页数最多的一部：4 页的短章节所有邻页都会被预加载，量不出「现取一页」的真实成本
const pick = (list?.data?.items ?? []).sort((a, b) => b.pageCount - a.pageCount)[0];
const comicId = pick?.id;
if (!comicId) throw new Error(`列表为空：${BASE} 上还没有漫画`);
const detail = await api(`/api/comics/${comicId}`);
const chapterId = (detail?.data?.chapters ?? []).sort((a, b) => b.pageCount - a.pageCount)[0]?.id;
if (!chapterId) throw new Error('该漫画没有章节');
const chapter = detail.data.chapters.find((c) => c.id === chapterId);
const pageCount = chapter.pageCount;
// ?page=0 显式覆盖「续读进度」，否则第二轮会从上次停下的页开始，等第 0 页永远等不到
const READER_URL = `${BASE}/read/${comicId}/${encodeURIComponent(chapterId)}?page=0`;
console.log(`目标：${READER_URL}\n章节：${chapter.title ?? chapterId}（${pageCount} 页）\n`);
if (pageCount < 20) {
  console.log('提示：该章节不足 20 页，邻页会被预加载全部命中，翻页延迟量不出真实成本。');
  console.log('      先跑 `node tools/perf_fixture.mjs` 造一个 30 页长章节再测。\n');
}

/* ---------------- CDP ---------------- */
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-perf-'));
const edge = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--window-size=390,844',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(150);
  }
  throw new Error('Edge 未能在超时内提供调试端口');
}

const ws = new WebSocket(await wsUrl());
const pending = new Map();
let seq = 0;
const events = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  } else if (m.method) {
    events.push(m);
  }
});
await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', rej);
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
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
await send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
});

/** 页内助手：等第 index 页「解码完成 + 两帧」，返回 performance.now() */
const HELPERS = `
window.__waitPage = (index, timeout = 20000) => new Promise((res, rej) => {
  const deadline = performance.now() + timeout;
  const tick = () => {
    const im = [...document.images].filter((i) => i.src.includes('/pages/' + index));
    const cur = im[im.length - 1];
    if (cur && cur.complete && cur.naturalWidth > 0) {
      const done = () => requestAnimationFrame(() => requestAnimationFrame(() =>
        res({ t: performance.now(), w: cur.naturalWidth, h: cur.naturalHeight })));
      (cur.decode ? cur.decode().then(done, done) : done());
      return;
    }
    if (performance.now() > deadline) {
      const dbg = window.__pages().map((s) => s.split('/pages/')[1]).join(' | ');
      return rej(new Error('等第 ' + index + ' 页超时；DOM 里的页：' + dbg));
    }
    setTimeout(tick, 16);
  };
  tick();
});
window.__pages = () => [...document.images].map((i) => i.src).filter((s) => s.includes('/pages/'));
window.__res = () => performance.getEntriesByType('resource')
  .filter((e) => /\\/pages\\/\\d+/.test(e.name))
  .map((e) => ({ idx: Number(e.name.match(/\\/pages\\/(\\d+)/)[1]),
                 bytes: e.transferSize, enc: e.encodedBodySize,
                 cached: e.transferSize === 0, dur: Math.round(e.duration), start: Math.round(e.startTime) }));
window.__allres = () => performance.getEntriesByType('resource').map((e) => ({
  name: e.name.replace(location.origin, '').slice(0, 90),
  start: Math.round(e.startTime), dur: Math.round(e.duration),
  bytes: e.transferSize, init: e.initiatorType,
}));
window.__nav = () => {
  const n = performance.getEntriesByType('navigation')[0] ?? {};
  const fcp = (performance.getEntriesByName('first-contentful-paint')[0] ?? {}).startTime ?? null;
  return { domInteractive: Math.round(n.domInteractive ?? 0), dcl: Math.round(n.domContentLoadedEventEnd ?? 0),
           load: Math.round(n.loadEventEnd ?? 0), fcp: fcp && Math.round(fcp) };
};
true;
`;

const press = async (key) => {
  const code = key === 'ArrowRight' ? 39 : 37;
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
};

const runs = [];
/** 进度会被阅读器写入，第二轮进来会续读到上次停下的页 → 每轮开始前先把进度按回第 0 页 */
const resetProgress = async () => {
  await fetch(`${BASE}/api/progress`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ comicId, chapterId, chapterIndex: 0, pageIndex: 0, pageCount, percent: 0 }),
  });
};

for (let run = 1; run <= RUNS; run++) {
  await resetProgress();
  // 阅读器还有一层 localStorage 进度镜像（readLocalMirror），它会压过服务端进度，
  // 只清 HTTP 缓存不清站点数据的话，第二轮仍会续读到上一轮停下的页。
  await send('Storage.clearDataForOrigin', { origin: BASE, storageTypes: 'local_storage' });
  await send('Network.clearBrowserCache');
  await send('Network.setCacheDisabled', { cacheDisabled: false });
  const t0 = Date.now();
  await send('Page.navigate', { url: READER_URL });
  await sleep(300);
  await evaluate(HELPERS);

  const first = await evaluate(`(async () => {
    // 不假设从第 0 页开始（进度/镜像会改变起始页），先等任意一页可见，再从 URL 读实际页号
    const t = await new Promise((res, rej) => {
      const deadline = performance.now() + 20000;
      const tick = () => {
        const im = [...document.images].find((i) => i.src.includes('/pages/') && i.complete && i.naturalWidth > 0);
        if (im) {
          const done = () => requestAnimationFrame(() => requestAnimationFrame(() => res(performance.now())));
          return (im.decode ? im.decode().then(done, done) : done());
        }
        if (performance.now() > deadline) return rej(new Error('首屏无可见页'));
        setTimeout(tick, 16);
      };
      tick();
    });
    const fromUrl = Number(new URLSearchParams(location.search).get('page'));
    const idx = Number.isFinite(fromUrl) && fromUrl >= 0 ? fromUrl : 0;
    return { t, idx };
  })()`);
  const coldMs = Date.now() - t0;

  const turns = [];
  for (let i = 1; i <= TURNS; i++) {
    const target = first.idx + i;
    if (target > pageCount - 1) break;
    await sleep(400); // 让预加载把邻页取完
    const pressAt = await evaluate('performance.now()');
    await press('ArrowRight');
    const got = await evaluate(`window.__waitPage(${target})`);
    turns.push({ to: target, ms: Math.round(got.t - pressAt) });
  }

  const res = await evaluate('window.__res()');
  const allRes = await evaluate('window.__allres()');
  const nav = await evaluate('window.__nav()');
  runs.push({
    run,
    coldMs,
    nav,
    firstVisibleMs: Math.round(first.t),
    startPage: first.idx,
    turns,
    resources: res,
    allRes,
  });
  console.log(
    `run#${run}  首屏可见 ${Math.round(first.t)}ms（起始页 ${first.idx}，含导航 ${coldMs}ms）  ` +
      `翻页 ${turns.map((t) => t.ms + 'ms').join(' / ')}  ` +
      `图片请求 ${res.length} 个（缓存命中 ${res.filter((r) => r.cached).length}）`,
  );
}

/* ---------------- 汇总 ---------------- */
const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const summary = {
  base: BASE,
  readerUrl: READER_URL,
  runs: RUNS,
  firstVisibleMsMedian: med(runs.map((r) => r.firstVisibleMs)),
  turnMsMedianByTurn: Array.from({ length: TURNS }, (_, i) => med(runs.map((r) => r.turns[i]?.ms ?? 0))),
  imageRequests: runs.map((r) => r.resources.length),
  cacheHitRatio:
    runs.map((r) => {
      const c = r.resources.filter((x) => x.cached).length;
      return r.resources.length ? +(c / r.resources.length).toFixed(2) : 0;
    }),
  bytesPerRun: runs.map((r) => r.resources.reduce((a, b) => a + (b.bytes || 0), 0)),
};

console.log('\n──────── 汇总 ────────');
console.log(`首屏可见（中位）      ${summary.firstVisibleMsMedian}ms`);
console.log(`翻页延迟逐次（中位）  ${summary.turnMsMedianByTurn.map((x) => x + 'ms').join(' → ')}`);
console.log(`图片请求数 / 轮       ${summary.imageRequests.join(', ')}`);
console.log(`缓存命中率            ${summary.cacheHitRatio.map((x) => x * 100 + '%').join(', ')}`);
console.log(`图片传输字节 / 轮     ${summary.bytesPerRun.map((x) => (x / 1024).toFixed(0) + 'KB').join(', ')}`);

const out = path.resolve('tools/_perf/reader.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ summary, runs }, null, 2));
console.log(`\n明细：${out}`);

ws.close();
edge.kill();
await sleep(200);
process.exit(0);
