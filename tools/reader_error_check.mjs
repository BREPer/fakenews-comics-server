/**
 * 阅读器失败态实测（CDP）：单页图失败 → 说明 + 重新加载；详情接口失败 → 重试。
 *
 * 背景（改之前的行为）：
 *   - PageImage **没有 onError**：压缩包里某张图损坏 / 服务端 415 时，<img> 永远停在
 *     opacity:0，用户看到一整屏纯黑，分不清「这页就是黑的」「还在加载」「应用卡死」。
 *   - 详情请求失败时阅读器会说「漫画不存在，可能已被移动、删除」——断网时等于误报删库。
 *
 * 用 Fetch.failRequest 精确打掉某类请求，再放开，验证提示与重试都真的可用。
 *
 * 用法：node tools/reader_error_check.mjs [--base=http://127.0.0.1:13800]
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
const BASE = ARG('base', 'http://127.0.0.1:13800').replace(/\/$/, '');
const PORT = 9796;

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) { console.error('未找到 Edge'); process.exit(2); }
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-rerr-'));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });

let wsUrl;
for (let i = 0; i < 80; i++) {
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
/** 两个开关：打掉页图 / 打掉详情 */
const flags = { pages: false, detail: false };
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
  if (m.method === 'Fetch.requestPaused') {
    const { requestId, request } = m.params;
    const url = request.url;
    const isPage = /\/chapters\/[^/]+\/pages\/\d+/.test(url);
    const isDetail = /\/api\/comics\/[^/?]+$/.test(url);
    const kill = (isPage && flags.pages) || (isDetail && flags.detail);
    if (kill) {
      ws.send(JSON.stringify({ id: ++seq, method: 'Fetch.failRequest', params: { requestId, errorReason: 'Failed' } }));
    } else {
      ws.send(JSON.stringify({ id: ++seq, method: 'Fetch.continueRequest', params: { requestId } }));
    }
  }
});
const send = (method, params = {}) =>
  new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) =>
  (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
async function waitFor(expr, timeout = 8000, step = 150) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await ev(expr)) return true;
    await sleep(step);
  }
  return false;
}
/** 留档截图（设计走查用，失败不影响断言） */
async function shot(name) {
  try {
    fs.mkdirSync(path.resolve('_shots'), { recursive: true });
    const png = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.resolve('_shots', `${name}.png`), Buffer.from(png.data, 'base64'));
    console.log(`      saved _shots/${name}.png`);
  } catch { /* ignore */ }
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Fetch.enable', {
  patterns: [
    { urlPattern: '*api/comics/*', requestStage: 'Request' },
  ],
});

// 找一部有页的漫画 + 第一章
const list = await (await fetch(`${BASE}/api/comics?pageSize=1`)).json();
const comicId = list.data.items[0].id;
const detail = await (await fetch(`${BASE}/api/comics/${comicId}`)).json();
const chapterId = detail.data.chapters[0].id;
const readPath = `/read/${comicId}/${encodeURIComponent(chapterId)}?page=0`;

// ---------- 1. 页图全部失败 → 说明 + 重新加载 ----------
flags.pages = true;
await send('Page.navigate', { url: BASE + readPath });
const sawNotice = await waitFor(`document.body.innerText.includes('没能显示')`, 12000);
const noticeText = (await ev(`document.body.innerText`)) || '';
check('页图失败时给出说明', sawNotice === true, noticeText.replace(/\n/g, ' / ').slice(0, 60));
check('说明里有页码', /第\s*1\s*页没能显示/.test(noticeText), '');
check('提供「重新加载」', /重新加载/.test(noticeText), '');
await shot('reader_page_fail');

// ---------- 2. 点重新加载 → 图回来，且没有翻页/弹工具栏 ----------
flags.pages = false;
await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '重新加载')?.click()`);
const recovered = await waitFor(
  `!![...document.querySelectorAll('img')].find((im) => /retry=1/.test(im.src) && im.naturalWidth > 0)`,
  12000,
);
check('重新加载后图片恢复', recovered === true, '');
const stillHere = await ev(`location.search`);
check('重试没有触发翻页', /(^|[?&])page=0(&|$)/.test(stillHere ?? ''), stillHere ?? '');

// ---------- 3. 详情接口失败 → 「打开失败」+ 重试 ----------
flags.detail = true;
await send('Page.navigate', { url: BASE + readPath });
const sawOpenFail = await waitFor(`document.body.innerText.includes('打开失败')`, 12000);
const openText = (await ev(`document.body.innerText`)) || '';
check('详情请求失败显示「打开失败」', sawOpenFail === true, openText.replace(/\n/g, ' / ').slice(0, 50));
check('不再误报「漫画不存在」', !/漫画不存在|已被移动/.test(openText), '');
await shot('reader_open_fail');

flags.detail = false;
await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '重试')?.click()`);
const reopened = await waitFor(
  `!!document.querySelector('img')?.src?.includes('/pages/')`,
  12000,
);
check('点重试后能正常打开', reopened === true, '');

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
ws.close();
edge.kill();
await sleep(300);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed.length ? 1 : 0);
