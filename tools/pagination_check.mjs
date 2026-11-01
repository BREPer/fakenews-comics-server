/**
 * 首页分页 / 无限滚动 / 错误态 实测（CDP，390×844 手机视口）。
 *
 * 覆盖：
 *   1) 首屏只请求 page=1，卡片数 = 36（LIST_PAGE_SIZE）
 *   2) 滚到底自动续拉 page=2，卡片数增加，且没有重复 id
 *   3) API 响应带 content-encoding: gzip（后端 Compress 中间件生效）
 *   4) 列表接口失败时显示错误态 + 重试按钮，而不是伪装成「还没有漫画」
 *   5) 点重试后恢复正常渲染
 *
 * 用法：node tools/pagination_check.mjs [--base=http://127.0.0.1:5173]
 * 退出码 0 = 全通过。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.argv = process.argv.flatMap((a) => {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  return m ? [`--${m[1]}`, m[2]] : [a];
});
const ARG = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = ARG('base', 'http://127.0.0.1:5173').replace(/\/$/, '');
const PORT = 9791;

// 这个探针要的是**前端 dev server**（5173），后端 13800 顶不上：它靠 /api 走 proxy
// 并按页面请求序列数分页。起不来就 SKIP，别让整批 UX 探针因为一条环境缺失而崩退。
// 本机 npm 不在 PATH —— 直接用 node 跑 vite 的入口文件即可，不需要 npx。
const alive = await fetch(`${BASE}/api/comics?pageSize=1`, { signal: AbortSignal.timeout(4000) })
  .then((r) => r.ok).catch(() => false);
if (!alive) {
  console.error(`SKIP: ${BASE} 不可达（这个探针要前端 dev server，不是后端 13800）`);
  console.error('  起法（无需 npm 在 PATH）：');
  console.error(`  "${process.execPath}" app/web/node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173`);
  console.error('  必须显式 --host 127.0.0.1：Vite5 的 localhost 只绑 IPv6，用 localhost 会连不上');
  process.exit(2);
}

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) {
  console.error('未找到 Edge，无法跑 CDP 探针');
  process.exit(2);
}
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-page-'));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });

let wsUrl;
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((x) => x.type === 'page');
    if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch { /* 等 Edge 起来 */ }
  await sleep(150);
}
if (!wsUrl) {
  console.error('CDP 未就绪');
  edge.kill();
  process.exit(2);
}

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pend = new Map();
const listReqs = []; // 记录所有 /api/comics?... 请求
const apiHeaders = {}; // url → 响应头
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params.request.url;
    if (/\/api\/comics(\?|$)/.test(u)) listReqs.push(u);
  }
  if (m.method === 'Network.responseReceived') {
    const u = m.params.response.url;
    if (/\/api\/comics(\?|$)/.test(u)) apiHeaders[u.split('?')[1] ?? u] = m.params.response.headers;
  }
});
const send = (method, params = {}) =>
  new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) =>
  (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

// ---------- 1. 首屏 ----------
await send('Page.navigate', { url: BASE + '/' });
let cards = 0;
for (let i = 0; i < 100; i++) {
  await sleep(200);
  cards = (await ev(`document.querySelectorAll('a[href^="/comic/"]').length`)) || 0;
  if (cards >= 36) break;
}
check('首屏卡片数 = 36', cards === 36, `实际 ${cards}`);
const firstRound = listReqs.filter((u) => /page=1(&|$)/.test(u));
check('首屏只拉第 1 页', firstRound.length === 1 && !listReqs.some((u) => /page=2(&|$)/.test(u)),
  `请求: ${listReqs.map((u) => new URL(u).search).join(' | ') || '(无)'}`);

// ---------- 2. gzip ----------
const anyKey = Object.keys(apiHeaders)[0];
const enc = anyKey ? String(apiHeaders[anyKey]['content-encoding'] ?? apiHeaders[anyKey]['Content-Encoding'] ?? '') : '';
check('API 响应 gzip 压缩', enc === 'gzip', `content-encoding=${enc || '(空)'}`);

// ---------- 3. 滚动续拉 ----------
for (let round = 0; round < 6; round++) {
  await ev(`window.scrollTo(0, document.documentElement.scrollHeight)`);
  await sleep(1200);
  const now = (await ev(`document.querySelectorAll('a[href^="/comic/"]').length`)) || 0;
  if (now > cards) cards = now;
  if (listReqs.some((u) => /page=2(&|$)/.test(u)) && cards > 36) break;
}
check('滚动后续拉第 2 页', listReqs.some((u) => /page=2(&|$)/.test(u)),
  `请求数 ${listReqs.length}`);
check('续拉后卡片增加', cards > 36, `实际 ${cards}`);
const dup = await ev(`(() => {
  const ids = [...document.querySelectorAll('a[href^="/comic/"]')].map((a) => a.getAttribute('href'));
  return ids.length - new Set(ids).size;
})()`);
check('无重复卡片', dup === 0, `重复 ${dup} 个`);

// ---------- 4. 错误态 ----------
await send('Network.setBlockedURLs', { urls: ['*/api/comics*'] });
await send('Page.reload', { ignoreCache: true });
let alertText = '';
for (let i = 0; i < 60; i++) {
  await sleep(250);
  alertText = (await ev(`document.querySelector('[role="alert"]')?.innerText ?? ''`)) || '';
  if (alertText) break;
}
check('失败时显示错误态', /加载失败/.test(alertText), alertText.replace(/\n/g, ' / ').slice(0, 60));
check('错误态提供重试', /重试/.test(alertText), '');
check('失败时不显示空态文案', !/还没有漫画/.test(
  (await ev(`document.body.innerText`)) || ''), '');

// ---------- 5. 重试恢复 ----------
await send('Network.setBlockedURLs', { urls: [] });
await ev(`[...document.querySelectorAll('button')].find((b) => /重试/.test(b.textContent))?.click()`);
let recovered = 0;
for (let i = 0; i < 60; i++) {
  await sleep(250);
  recovered = (await ev(`document.querySelectorAll('a[href^="/comic/"]').length`)) || 0;
  if (recovered > 0) break;
}
check('点重试后恢复', recovered > 0, `卡片 ${recovered}`);

// ---------- 6. 到底footer：卡片数必须与接口 total 一致 ----------
// 期望值不写死：夹具重建（regression_go 会 rmtree 库目录重造）后数据量会变，
// 写死的 87 会让「分页本身是对的、只有数据变了」被误判成分页 bug。
await send('Network.setBlockedURLs', { urls: [] });
const readingTotal =
  (await (await fetch(`${BASE}/api/comics?pageSize=1&status=reading`)).json())?.data?.total ?? 0;
await send('Page.navigate', { url: BASE + '/?status=reading' });
let readingCards = 0;
for (let i = 0; i < 60; i++) {
  await sleep(200);
  readingCards = (await ev(`document.querySelectorAll('a[href^="/comic/"]').length`)) || 0;
  if (readingCards > 0) break;
}
let footer = '';
for (let round = 0; round < 8; round++) {
  await ev('window.scrollTo(0, document.documentElement.scrollHeight)');
  await sleep(900);
  footer = (await ev(`document.body.innerText.match(/已经到底了[^\\n]*/)?.[0] ?? ''`)) || '';
  if (footer) break;
}
readingCards = (await ev(`document.querySelectorAll('a[href^="/comic/"]').length`)) || 0;
// 页脚只在「首屏装满了、确实翻过页」时渲染（ComicCard.tsx:203：
// hasMore || loaded < firstPageSize → null）。所以 reading 不足一页时，
// 页脚**正确地不出现** —— 拿「必须出现」去判是夹具假设，不是产品缺陷。
// 与下面 finished 那条同一个套路：把阈值写进判据，别写死一句文案。
const FIRST_PAGE = 36;
if (readingTotal > FIRST_PAGE) {
  check('读到末页出现「已经到底了」', new RegExp(`已经到底了 · 共 ${readingTotal} 部`).test(footer), footer || '(未见)');
} else {
  check(`小结果集（reading=${readingTotal} ≤ ${FIRST_PAGE}）不显示已到底`, footer === '', footer || '(无)');
}
check(`末页卡片数等于接口 total（${readingTotal}）`, readingCards === readingTotal, `实际 ${readingCards}`);
const dup2 = await ev(`(() => {
  const ids = [...document.querySelectorAll('a[href^="/comic/"]')].map((a) => a.getAttribute('href'));
  return ids.length - new Set(ids).size;
})()`);
check('多页无重复卡片', dup2 === 0, `重复 ${dup2} 个`);

// 到底之后继续滚不应再请求（hasNextPage 已为 undefined，观察者应失效）
const beforeEnd = listReqs.length;
for (let round = 0; round < 3; round++) {
  await ev('window.scrollTo(0, 0)');
  await sleep(150);
  await ev('window.scrollTo(0, document.documentElement.scrollHeight)');
  await sleep(600);
}
check('到底后不再发列表请求', listReqs.length === beforeEnd, `新增 ${listReqs.length - beforeEnd} 次`);

// ---------- 7. 一页装完的小结果集不显示「已到底」 ----------
// 同样不写死：卡片数应等于接口 total，且总数要小到一页（36）装得下。
// 哪天 finished 超过 36 部，这条会失败并报出实际总数——那时该换筛选条件，而不是改数字。
const finishedTotal =
  (await (await fetch(`${BASE}/api/comics?pageSize=1&status=finished`)).json())?.data?.total ?? 0;
await send('Page.navigate', { url: BASE + '/?status=finished' });
await sleep(1800);
const smallCards = (await ev(`document.querySelectorAll('a[href^="/comic/"]').length`)) || 0;
const smallFooter = (await ev(`document.body.innerText.match(/已经到底了[^\\n]*/)?.[0] ?? ''`)) || '';
check(`小结果集（${finishedTotal} 部）一页装完且不显示已到底`,
  finishedTotal > 0 && finishedTotal <= 36 && smallCards === finishedTotal && !smallFooter,
  `卡片 ${smallCards}/${finishedTotal}, footer ${smallFooter || '(无)'}`);

// ---------- 收尾 ----------
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
ws.close();
edge.kill();
await sleep(300);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed.length ? 1 : 0);
