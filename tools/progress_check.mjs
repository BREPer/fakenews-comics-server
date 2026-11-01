import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 阅读进度三处修正的回归验证：
 *   1. ?page=0 被当作「第 1 页」而不是「没写」
 *   2. 旧本地镜像不得顶掉服务端进度
 *   3. 服务端没有进度时镜像仍作兜底
 *   4. 打开章节不得先把临时页 0 写成进度（镜像/服务端都不许）
 *
 * 用法：node tools/progress_check.mjs [--base http://127.0.0.1:13800]
 * 依赖：本机 Edge/Chrome（与 perf_reader 同一套 CDP 用法）；服务端需可写进度。
 */

const BASE = (() => {
  const i = process.argv.indexOf('--base');
  return i > 0 ? process.argv[i + 1] : 'http://127.0.0.1:13800';
})();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) throw new Error('未找到 Edge/Chrome');

const PORT = 9521;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-pg-'));
const browser = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });

let wsUrl;
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch { /* 还没起来 */ }
  await sleep(150);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));

let seq = 0;
const pending = new Map();
/** 本次场景内被发出的进度上报（含请求体） */
let puts = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Network.requestWillBeSent' && m.params.request.url.endsWith('/api/progress') && m.params.request.method === 'PUT') {
    try { puts.push(JSON.parse(m.params.request.postData ?? '{}')); } catch { puts.push({ raw: m.params.request.postData }); }
  }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return r.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');

const api = async (p, init) => (await fetch(BASE + p, init)).json();
const putProgress = (comicId, chapterId, chapterIndex, pageIndex, pageCount) =>
  fetch(BASE + '/api/progress', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ comicId, chapterId, chapterIndex, pageIndex, pageCount, percent: 0 }),
  });

/** 多章漫画：第一部用于跨章场景，另一部清空进度后用于镜像兜底场景 */
const comics = (await api('/api/comics?pageSize=50')).data.items;
const multis = [];
for (const c of comics) {
  const d = (await api(`/api/comics/${c.id}`)).data;
  if ((d.chapters?.length ?? 0) >= 2) multis.push(d);
}
if (multis.length === 0) throw new Error('夹具不足：需要至少一部多章漫画（先跑 node tools/perf_fixture.mjs）');
const multi = multis[0];
// 「无进度」的书优先用现成的；都被读过就重置一部。
// 以前是直接找 d.progress 为空的书，跑过一轮 E2E / 性能探针之后库里全都「有进度」，脚本就报夹具不足。
let blank = multis.find((d) => !d.progress);
if (!blank) {
  const victim = multis.find((d) => d.id !== multi.id);
  if (!victim) throw new Error('夹具不足：需要两部多章漫画（其中一部用于验证镜像兜底）');
  await fetch(`${BASE}/api/progress/${victim.id}/reset`, { method: 'POST' });
  blank = (await api(`/api/comics/${victim.id}`)).data;
  if (blank.progress) throw new Error(`重置进度失败：${victim.id} 仍有进度`);
}

/**
 * 跑一个场景：写服务端进度与镜像 → 打开阅读器 → 读实际页号。
 * 每次先离场再重置服务端进度，避免上一次的离场 flush 污染。
 *
 * server：{ chapterIndex, page } 指定服务端进度；传 'none' 表示彻底清空（验证镜像兜底）。
 */
async function run({ name, comic, chapterIndex, query = '', mirror, server, expect }) {
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(500);
  const chapter = comic.chapters[chapterIndex];
  if (server === 'none') {
    await fetch(`${BASE}/api/progress/${comic.id}/reset`, { method: 'POST' });
  } else {
    const sc = comic.chapters[server.chapterIndex];
    await putProgress(comic.id, sc.id, server.chapterIndex, Math.min(server.page, sc.pageCount - 1), sc.pageCount);
  }
  await evaluate(`localStorage.removeItem('fakenews-progress-mirror')`);
  if (mirror) await evaluate(`localStorage.setItem('fakenews-progress-mirror', ${JSON.stringify(JSON.stringify({ [comic.id]: mirror }))})`);

  puts = [];
  await send('Page.navigate', { url: `${BASE}/read/${comic.id}/${encodeURIComponent(chapter.id)}${query}` });
  await sleep(1800);
  const got = Number(new URLSearchParams(await evaluate('location.search')).get('page'));
  const mirrorAfter = await evaluate(`(JSON.parse(localStorage.getItem('fakenews-progress-mirror')||'{}')[${JSON.stringify(comic.id)}]||{}).pageIndex ?? null`);
  const bogus = puts.filter((p) => p.pageIndex === 0 && expect !== 0);
  const ok = got === expect && bogus.length === 0;
  console.log(
    `${ok ? '✓' : '✗'} ${name}\n    页号 ${got}（期望 ${expect}）  镜像 ${mirrorAfter}  上报 ${puts.length} 次` +
      (bogus.length ? `  ← 含 ${bogus.length} 次 pageIndex=0 的误报` : ''),
  );
  if (!ok) failed++;
  return ok;
}

let failed = 0;
const chB = multi.chapters[1];
const lastPage = Math.min(3, chB.pageCount - 1);
const mirrorStale = { comicId: multi.id, chapterId: chB.id, chapterIndex: 1, pageIndex: lastPage, pageCount: chB.pageCount, percent: 75 };

// 1. 服务端进度就在本章第 3 页，URL 显式要第 1 页（?page=0 必须生效）
await run({
  name: '① 服务端进度=本章 p3，URL ?page=0 → 应到第 1 页',
  comic: multi, chapterIndex: 1, query: '?page=0', mirror: null,
  server: { chapterIndex: 1, page: lastPage }, expect: 0,
});
// 2. 服务端进度在本章，URL 不写 page → 应续读，且不得先误报 0
await run({
  name: '② 服务端进度=本章 p3，URL 无 page → 应续读 p3 且不误报 0',
  comic: multi, chapterIndex: 1, mirror: null,
  server: { chapterIndex: 1, page: lastPage }, expect: lastPage,
});
// 3. 旧镜像（无 updatedAt）与「服务端记的是别的章」并存 → 镜像应被丢弃
await run({
  name: '③ 旧镜像(无时间戳) + 服务端记的是 ch0 → 应从第 1 页开始',
  comic: multi, chapterIndex: 1, mirror: mirrorStale,
  server: { chapterIndex: 0, page: lastPage }, expect: 0,
});
// 4. 镜像明确比服务端新 → 采信镜像
await run({
  name: '④ 镜像比服务端新 → 采信镜像 p3',
  comic: multi, chapterIndex: 1, mirror: { ...mirrorStale, updatedAt: Date.now() + 60000 },
  server: { chapterIndex: 0, page: lastPage }, expect: lastPage,
});
// 5. 服务端完全没有这本书的进度 → 镜像兜底
await run({
  name: '⑤ 服务端无进度 → 镜像兜底 p2（超页数则钳到末页）',
  comic: blank, chapterIndex: 1,
  mirror: { comicId: blank.id, chapterId: blank.chapters[1].id, chapterIndex: 1, pageIndex: 2, pageCount: blank.chapters[1].pageCount, percent: 0, updatedAt: Date.now() },
  server: 'none', expect: Math.min(2, blank.chapters[1].pageCount - 1),
});

ws.close();
browser.kill();
await sleep(300);
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
