/**
 * 详情页「重置进度」探针：点击确认后，页面上的阅读记录是否真的消失。
 *
 * 检查点：
 *   1. 重置前：有 .chapter-done 格子 / 「继续阅读」按钮
 *   2. 重置后：/api/comics/{id} 是否真的重新请求了一次（之前只失效了 ['comics'] 列表 key，
 *      详情 key 是 ['comic', id]，两者前缀不同 → 详情页根本不重取，界面停在旧数据）
 *   3. 重置后：格子 / 按钮文本是否更新
 *   4. 服务端：GET /api/progress?comicIds= 应为空
 *
 * 用法：node tools/reset_progress_check.mjs [--comic=<id>] [--theme=light]
 * 依赖本地服务 http://127.0.0.1:13800（只绑 IPv4，别用 localhost）。
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
  const kv = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (kv) return kv.slice(n.length + 3);
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};

const BASE = ARG('base', 'http://127.0.0.1:13800').replace(/\/$/, '');
const COMIC = ARG('comic', '8a47483571299bde');
const THEME = ARG('theme', 'light');
const TAG = ARG('tag', 'reset');

const api = async (p, i) => (await fetch(BASE + p, i)).json();
const put = (b) =>
  api('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b),
  });
const seed = (idx, page, count) =>
  api('/api/progress', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      comicId: COMIC,
      chapterId: `${COMIC}#${idx}`,
      chapterIndex: idx,
      pageIndex: page,
      pageCount: count,
    }),
  });

// ---- 1. 造出「读了两章、在读第三章」的初始状态 ----
// 主题按设备存在 localStorage（服务端 PUT 已被静默忽略），导航前注入
await api(`/api/progress/${COMIC}/reset`, { method: 'POST' });
await seed(0, 1, 2); // 读完
await seed(1, 1, 2); // 读完
await seed(2, 1, 3); // 在读 33%

// ---- 2. 起 headless Edge ----
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const PORT = 9644;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-reset-'));
const edge = spawn(
  EDGE,
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'],
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
    /* 还没起来 */
  }
  await sleep(150);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pend = new Map();
/** 记录详情接口的请求次数，用来判断 invalidate 是否命中详情 key */
const detailHits = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Network.requestWillBeSent' && m.params?.request?.url?.includes(`/api/comics/${COMIC}`)) {
    detailHits.push(m.params.request.url);
  }
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m.result);
    pend.delete(m.id);
  }
});
const send = (m, p = {}) =>
  new Promise((res) => {
    const id = ++seq;
    pend.set(id, res);
    ws.send(JSON.stringify({ id, method: m, params: p }));
  });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const snap = () =>
  ev(`(() => {
    const cells = [...document.querySelectorAll('section .grid button, section .grid > button')];
    const btns = [...document.querySelectorAll('button')];
    return {
      doneCells: cells.filter((c) => c.className.includes('chapter-done')).length,
      totalCells: cells.length,
      startBtn: btns.map((b) => b.textContent.trim()).find((t) => /^(开始阅读|继续阅读)/.test(t)) || null,
      resetBtnVisible: btns.some((b) => b.textContent.includes('重置进度')),
    };
  })()`);

// ---- 3. 打开详情页（切成四格视图，格子有 .chapter-done 便于计数）----
await injectPrefs(send, { theme: THEME });
await send('Page.navigate', { url: `${BASE}/comic/${COMIC}` });
await sleep(1200);
await ev(`localStorage.setItem('fn:detailChapterView','grid')`);
await send('Page.reload');
await sleep(2600);
const beforeClick = await snap();
detailHits.length = 0;

const openConfirm = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('重置进度'));
  if (!b) return false;
  b.click();
  return true;
})()`);
await sleep(500);
const confirmClicked = await ev(`(() => {
  const btn = [...document.querySelectorAll('.fixed button')].find((x) => x.textContent.trim() === '重置');
  if (!btn) return false;
  btn.click();
  return true;
})()`);
await sleep(1800);
const afterClick = await snap();
const serverProgress = await api(`/api/progress?comicIds=${encodeURIComponent(COMIC)}`);

fs.mkdirSync(path.resolve('_shots'), { recursive: true });
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.resolve('_shots', `reset-${COMIC}-${TAG}.png`), Buffer.from(shot.data, 'base64'));

console.log('打开确认框:', openConfirm, '| 点到确认:', confirmClicked);
console.log('重置前:', JSON.stringify(beforeClick));
console.log('重置后:', JSON.stringify(afterClick));
console.log('重置后详情接口请求次数:', detailHits.length, detailHits.map((u) => u.replace(BASE, '')).join(' '));
console.log('服务端 progress:', JSON.stringify(serverProgress.data?.items ?? serverProgress));

// 断言改用「按钮文案 + 重置按钮可见性」：`doneCells`（.chapter-done）随
// 2026-10-24 的分章进度删除早已不存在，拿它判定会一直假失败。
const ok =
  /继续阅读/.test(beforeClick.startBtn || '') &&
  beforeClick.resetBtnVisible === true &&
  afterClick.startBtn === '开始阅读' &&
  afterClick.resetBtnVisible === false &&
  (serverProgress.data?.items?.length ?? 0) === 0;
console.log(ok ? 'PASS' : 'FAIL');

ws.close();
edge.kill();
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {
  /* */
}
process.exit(ok ? 0 : 1);
