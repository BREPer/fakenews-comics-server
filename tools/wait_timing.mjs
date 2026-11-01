/**
 * 临时探针：量化各处「等待」到底有多长（决定吉祥物该不该出现在等待页）。
 *
 * 之前判断「加载都是 4~10ms 的瞬时态」，但「等待」不是一种东西：
 * 局域网开本地书确实快，NAS 硬盘休眠、手机远离路由都可能是几秒。
 * 这里对**生产 bundle**（dist，真实部署形态）限速跑三档网络，
 * 测每个等待元素的可见时长与整体落定时间。
 *
 * dev 模式不能用来测这个：Vite 未打包模式下几百个模块逐个请求，
 * 400ms RTT 会让首屏失真到几十秒，数字没有意义。
 *
 * 用法：node tools/_wait_timing.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.resolve(process.cwd(), 'app/web');
const DIST = path.join(ROOT, 'dist');
const API_PORT = 13800;
const PORT_PREVIEW = 5180;

// ---------- 静态服务 dist + 反代 /api（生产形态的最小复刻） ----------
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    const p = http.request({ host: '127.0.0.1', port: API_PORT, path: req.url, method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    p.on('error', () => res.writeHead(502).end());
    req.pipe(p);
    return;
  }
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(DIST, rel === '/' ? 'index.html' : rel);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] ?? 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(path.join(DIST, 'index.html')).pipe(res);
  }
});
await new Promise((r) => server.listen(PORT_PREVIEW, '127.0.0.1', r));
const APP = `http://127.0.0.1:${PORT_PREVIEW}`;

// ---------- 无头 Edge ----------
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const PORT = 9741;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-wait-'));
const edge = spawn(
  EDGE,
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1280,900', 'about:blank'],
  { stdio: 'ignore' },
);
let wsUrl;
for (let i = 0; i < 80; i++) {
  try {
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = t.find((x) => x.type === 'page');
    if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch { /* 等 CDP */ }
  await sleep(150);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = async (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((r) => pend.set(id, r));
};
/** 页面导航/销毁期会抛 ContextDestroyed，探测场景必须容忍 */
const ev = async (expr) => {
  try {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.result?.exceptionDetails) return undefined;
    return r.result?.result?.value;
  } catch { return undefined; }
};
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');

// 20ms 采样：记录每个等待元素首次/末次可见
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
window.__wt = (function () {
  const found = {};
  let text = '';
  const probes = {
    'RequireAuth(检查登录)': () => text.includes('正在检查登录状态…'),
    'App根fallback(加载中…)': () => text.includes('加载中…'),
    '骨架屏(.skeleton)': () => !!document.querySelector('.skeleton'),
    '阅读器加载(role=status)': () => !!document.querySelector('[role="status"][aria-live]'),
    'Libraries(加载漫画库…)': () => text.includes('加载漫画库…'),
    // Loading 里的插画常驻占位（避免中途撑高造成抖动），显隐靠 opacity，
    // 所以必须按「肉眼可见」判定，查 DOM 存在会永远命中
    '★等待吉祥物(可见)': () => {
      const el = document.querySelector('.mascot-loading');
      return !!el && el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    },
  };
  setInterval(() => {
    try { text = document.body ? document.body.innerText : ''; } catch { text = ''; }
    const now = performance.now();
    for (const k in probes) {
      let hit = false;
      try { hit = probes[k](); } catch {}
      if (hit) {
        const f = found[k] || (found[k] = { first: now, last: now, n: 0 });
        f.last = now; f.n++;
      }
    }
  }, 20);
  return found;
})();
void 0;`,
});

const allNets = {
  lan: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  slowWifi: { offline: false, latency: 150, downloadThroughput: (2 * 1024 * 1024) / 8, uploadThroughput: (1024 * 1024) / 8 },
  nasWake: { offline: false, latency: 400, downloadThroughput: (500 * 1024) / 8, uploadThroughput: (256 * 1024) / 8 },
};
/** 只跑指定档位：node tools/_wait_timing.mjs nasWake */
const only = process.argv[2];
const NETS = only ? { [only]: allNets[only] } : allNets;

const api = async (p) => (await fetch(`http://127.0.0.1:${API_PORT}${p}`)).json();
const items = ((await api('/api/comics?page=1&pageSize=5')).data?.items) || [];
const pick = items.find((c) => (c.chapterCount || 0) > 0) || items[0];
const comic = (await api(`/api/comics/${pick.id}`)).data;
const ch = (comic.chapters || [])[0];
console.log(`用例书：${comic.title}（${comic.chapters.length} 章，第 1 章 ${ch.pageCount} 页）\n`);

/** 场景：[名字, URL, 判定「内容到位」的表达式] */
const SCENES = [
  ['书柜首屏', `${APP}/`, `document.querySelectorAll('a[href^="/comic/"]').length > 0`],
  ['详情页', `${APP}/comic/${comic.id}`, `/开始阅读|继续阅读|重头开始/.test(document.body.innerText)`],
  ['阅读器', `${APP}/read/${comic.id}/${encodeURIComponent(ch.id)}`, `document.querySelectorAll('img').length > 0`],
  ['漫画库页', `${APP}/libraries`, `/漫画库/.test(document.body.innerText) && !document.body.innerText.includes('加载漫画库…')`],
];

const rows = [];
for (const [netName, cond] of Object.entries(NETS)) {
  await send('Network.emulateNetworkConditions', cond);
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  for (const [name, url, settled] of SCENES) {
    const t0 = Date.now();
    await send('Page.navigate', { url });
    let okFlag = false;
    for (let i = 0; i < 300; i++) {
      await sleep(100);
      if (await ev(`((${settled}) ? 1 : 0)`) === 1) { okFlag = true; break; }
    }
    const settleMs = Date.now() - t0;
    process.stdout.write(`  ${netName} / ${name}: ${settleMs}ms\n`);
    await sleep(150);
    const found = JSON.parse((await ev(`JSON.stringify(window.__wt)`)) || '{}');
    const keys = Object.keys(found);
    if (!keys.length) rows.push([netName, name, '(未捕捉到等待元素)', settleMs, '', '']);
    for (const k of keys) {
      rows.push([netName, name, k, settleMs, Math.round(found[k].last - found[k].first), Math.round(found[k].first)]);
    }
    if (!okFlag) console.log(`  ! ${netName}/${name} 60s 内没落定`);
  }
}

console.log('网络'.padEnd(10), '场景'.padEnd(12), '等待元素'.padEnd(26), '落定ms'.padStart(7), '可见ms'.padStart(8), '出现at'.padStart(8));
console.log('-'.repeat(80));
for (const r of rows) {
  console.log(String(r[0]).padEnd(10), String(r[1]).padEnd(12), String(r[2]).padEnd(24), String(r[3]).padStart(7), String(r[4]).padStart(8), String(r[5]).padStart(8));
}

ws.close();
edge.kill();
server.close();
// Edge 的 Crashpad 文件在 Windows 上常锁着，清不掉不影响结果
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
