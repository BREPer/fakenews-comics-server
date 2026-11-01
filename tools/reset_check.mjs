/**
 * 重置进度是否被本地镜像「复活」。
 *
 * 疑点（代码走查）：
 *   Reader.tsx 的定位逻辑里，本地镜像的采信条件是
 *     mirror.chapterId === chapter.id && (!comic?.progress || mirror.updatedAt > comic.progress.updatedAt)
 *   —— 服务端没有进度（刚被重置）时镜像无条件采信；而 useResetProgress 只删服务端、
 *   不清 localStorage 的 fakenews-progress-mirror。于是「重置 → 重新进入阅读器 →
 *   按镜像定位到旧页码 → useProgressSync 再把该页码写回服务端」，重置被完全抵消。
 *
 * 校验项：
 *   1) 重置后服务端 progress 为空
 *   2) 重置后本地镜像仍在（问题根源）
 *   3) 重新进入阅读器：URL ?page= 是否被镜像改写（非 0）
 *   4) 服务端 progress 是否被写回（复活）
 *
 * 用法：node tools/reset_check.mjs [--comic=id] [--chapter=id#0]
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
  const kv = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (kv) return kv.slice(n.length + 3);
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const APP = ARG('base', 'http://127.0.0.1:5173').replace(/\/$/, '');
const API = ARG('api', 'http://127.0.0.1:13800').replace(/\/$/, '');
let comic = ARG('comic', '');
if (!comic) comic = (await (await fetch(`${API}/api/comics?limit=1`)).json()).data.items[0].id;
const detail = (await (await fetch(`${API}/api/comics/${comic}`)).json()).data;
const chapter = ARG('chapter', detail.chapters[0].id);
const pageCount = detail.chapters[0].pageCount;
const targetPage = Math.min(pageCount - 1, 9);
console.log(`comic=${comic} chapter=${chapter} pages=${pageCount} 制造进度到第 ${targetPage + 1} 页`);

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const PORT = 9663;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-reset-'));
const edge = spawn(
  EDGE,
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=420,880', 'about:blank'],
  { stdio: 'ignore' },
);
let wsUrl;
for (let i = 0; i < 80; i++) {
  try {
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = t.find((x) => x.type === 'page');
    if (p) {
      wsUrl = p.webSocketDebuggerUrl;
      break;
    }
  } catch {
    /* 等 CDP */
  }
  await sleep(150);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m.result);
    pend.delete(m.id);
  }
});
const send = (m, p = {}) => new Promise((res) => {
  const id = ++seq;
  pend.set(id, res);
  ws.send(JSON.stringify({ id, method: m, params: p }));
});
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) console.error('[evaluate 异常]', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r?.result?.value;
};
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 880, deviceScaleFactor: 2, mobile: true });

const results = [];
const check = (name, ok, info) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info === undefined ? '' : `  ${typeof info === 'string' ? info : JSON.stringify(info)}`}`);
};
const serverProgress = async () => (await (await fetch(`${API}/api/comics/${comic}`)).json()).data.progress ?? null;

// ① 进阅读器并翻到目标页（点右半屏翻页）
await send('Page.navigate', { url: `${APP}/read/${encodeURIComponent(comic)}/${encodeURIComponent(chapter)}` });
await sleep(2600);
for (let i = 0; i < targetPage; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 380, y: 500, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 380, y: 500, button: 'left', clickCount: 1 });
  await sleep(120);
}
await sleep(1600); // 等防抖上报
const p1 = await serverProgress();
check('翻页后服务端有进度', !!p1 && p1.pageIndex >= targetPage - 1, `服务端 pageIndex=${p1?.pageIndex}`);
const mirrorBefore = await ev(`(() => { try { return JSON.parse(localStorage.getItem('fakenews-progress-mirror') || '{}')['${comic}'] ?? null; } catch { return null; } })()`);
check('本地镜像已写入', !!mirrorBefore, mirrorBefore ? `镜像 pageIndex=${mirrorBefore.pageIndex}` : '镜像为空');

// ② 回详情页点「重置进度」
await send('Page.navigate', { url: `${APP}/comic/${comic}` });
await sleep(2000);
await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('重置进度')); b?.click(); })()`);
await sleep(500);
await ev(`(() => { const d = [...document.querySelectorAll('div.fixed.inset-0')].pop(); [...(d?.querySelectorAll('button') || [])].find((x) => x.textContent.trim() === '重置')?.click(); })()`);
await sleep(1800);
const p2 = await serverProgress();
check('重置后服务端进度为空', p2 === null, `服务端 progress=${JSON.stringify(p2)}`);

// ③ 本地镜像是否还在（根源）
const mirrorAfter = await ev(`(() => { try { return JSON.parse(localStorage.getItem('fakenews-progress-mirror') || '{}')['${comic}'] ?? null; } catch { return null; } })()`);
console.log(`    本地镜像：${mirrorAfter ? `仍在（pageIndex=${mirrorAfter.pageIndex}, chapterId=${mirrorAfter.chapterId}）` : '已清除'}`);

// ④ 重新进入阅读器（不带 ?page）→ 是否被镜像改写
await send('Page.navigate', { url: `${APP}/read/${encodeURIComponent(comic)}/${encodeURIComponent(chapter)}` });
await sleep(3000);
const urlPage = await ev('new URLSearchParams(location.search).get("page")');
const p3 = await serverProgress();
console.log(`    重进阅读器：URL ?page=${urlPage}｜服务端 progress=${p3 ? `pageIndex=${p3.pageIndex}` : '空'}`);
check('重新进入后进度没有被镜像复活', p3 === null || p3.pageIndex === 0, `服务端 pageIndex=${p3?.pageIndex ?? '空'}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) console.log('失败项：' + failed.map((f) => f.name).join(' / '));
ws.close();
edge.kill();
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {
  /* Windows 偶发占用 */
}
process.exit(failed.length ? 1 : 0);
