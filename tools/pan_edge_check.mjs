/**
 * 回归：平移模式（pageAnimation=pan）下拖动能否跨章。
 *
 * 症状（用户报告）：平移模式下拖动无法到上一章 / 下一章。
 * 根因：拖动走 pager 的 onCommit（只翻页），槽位为空时直接 snapBack；
 *       换章逻辑只在 ReaderShell.turn() 里，而 turn 只被点击/键盘调用。
 *
 * 测法：真实鼠标拖动（CDP dispatchMouseEvent 会产生 pointerdown/move/up），
 * 在章末往外拖、章首往外拖、全书首尾往外拖，看 URL 的章节号变不变。
 *
 * 用法：node tools/pan_edge_check.mjs [--base ...] [--keep-settings]
 *   会临时把设置改成 single + pan + ltr，跑完恢复原值（--keep-settings 则不改）。
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
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = (ARG('base', process.env.API_BASE || 'http://127.0.0.1:13800')).replace(/\/$/, '');
const KEEP = process.argv.includes('--keep-settings');

const api = async (p, init) => (await fetch(BASE + p, init)).json();

// 选一部至少 2 章、首章页数足够多的漫画
let target = null;
for (const c of (await api('/api/comics?pageSize=50')).data.items) {
  const d = (await api(`/api/comics/${c.id}`)).data;
  const chs = d.chapters ?? [];
  if (chs.length >= 2 && chs[0].pageCount >= 6) { target = { ...d, chapters: chs }; break; }
}
if (!target) throw new Error('找不到「至少 2 章且首章 ≥6 页」的漫画：先跑 node tools/perf_fixture.mjs');

// 固定到「单页 + 平移」并记住原设置，跑完还原（拖动能测的前提就是 pan 真的生效）
const before = (await api('/api/settings')).data;
const patch = { readerMode: 'single', pageAnimation: 'pan', readDir: 'ltr', fitMode: 'contain' };
if (!KEEP) {
  await api('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const PORT = Number(ARG('port', '9516'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-pan-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--window-size=1200,800', 'about:blank',
], { stdio: 'ignore' });

let wsUrl;
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = list.find((t) => t.type === 'page');
    if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch { /* 未就绪 */ }
  await sleep(150);
}
if (!wsUrl) { edge.kill(); throw new Error('Edge 调试端口未就绪'); }

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
});
const send = (method, params = {}) =>
  new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });

const chs = target.chapters;
const chapterUrl = (ci, page = 0) => `${BASE}/read/${target.id}/${encodeURIComponent(chs[ci].id)}?page=${page}`;

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `\n    ${detail}` : ''}`);
  if (!ok) failed++;
};

/** 当前所在章节序号（按 URL 里的 chapterId 反查；找不到返回 -1） */
const chapterOf = async () => {
  const p = decodeURIComponent(await ev('location.pathname'));
  const i = chs.findIndex((c) => p.endsWith('/' + c.id) || p.includes(encodeURIComponent(c.id)) || p.includes(c.id));
  return i;
};
const pageOf = async () => Number(new URLSearchParams(await ev('location.search')).get('page'));

/**
 * 一次真实拖动。
 * @param {number} fromX 起点 x（视口坐标）
 * @param {number} toX 终点 x
 * @param {number} steps 中间移动次数（够多才会被判定成拖动而不是点击）
 * @param {number} stepMs 每步间隔（越小速度越快）
 */
async function drag(fromX, toX, { y = 400, steps = 10, stepMs = 18 } = {}) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const x = fromX + ((toX - fromX) * i) / steps;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    await sleep(stepMs);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(700); // 吸附/滑出动画 PAN_MS 之后再判定
}

try {
  // ---- 场景一：章末向左拖（ltr 下 = 翻到后一页）应进下一章 ----
  console.log(`\n--- 场景一：${chs[0].title} 末页向左拖 → 应进入 ${chs[1].title} ---`);
  await send('Page.navigate', { url: chapterUrl(0, chs[0].pageCount - 1) });
  await sleep(2200);
  const c1 = await chapterOf();
  const p1 = await pageOf();
  await drag(1000, 300);
  const c1after = await chapterOf();
  const p1after = await pageOf();
  check('章末向左拖动进入下一章', c1 === 0 && c1after === 1, `章 ${c1}→${c1after}，页 ${p1}→${p1after}`);

  // ---- 场景二：新章首页向右拖（= 翻回前一页）应回上一章末页 ----
  console.log(`\n--- 场景二：${chs[1].title} 首页向右拖 → 应回到 ${chs[0].title} 末页 ---`);
  await drag(300, 1000);
  const c2 = await chapterOf();
  const p2 = await pageOf();
  check('章首向右拖动回到上一章', c2 === 0, `章 → ${c2}，页 → ${p2}`);
  check('回到上一章落在末页', p2 === chs[0].pageCount - 1, `期望第 ${chs[0].pageCount} 页，实际第 ${p2 + 1} 页`);

  // ---- 场景三：整部漫画第一页再往回拖 → 不换章、弹回、给提示 ----
  console.log('\n--- 场景三：全书第一页向右拖 → 应弹回并提示 ---');
  await send('Page.navigate', { url: chapterUrl(0, 0) });
  await sleep(2000);
  await drag(300, 1000);
  const c3 = await chapterOf();
  const p3 = await pageOf();
  const toast = await ev(`(() => { const t = document.body.innerText.match(/已经是第一页了|已经是最后一页了|回到「[^」]*」|进入「[^」]*」/); return t ? t[0] : ''; })()`);
  check('全书首端不换章', c3 === 0 && p3 === 0, `章 ${c3}，页 ${p3}`);
  check('全书首端有到头提示', /已经是第一页了/.test(toast), `提示：${toast || '（无）'}`);

  // ---- 场景四：章内正常拖动仍翻页（确认没把普通翻页改坏） ----
  console.log('\n--- 场景四：章内向左拖 → 应正常翻到下一页 ---');
  await send('Page.navigate', { url: chapterUrl(0, 2) });
  await sleep(2000);
  await drag(1000, 400);
  const c4 = await chapterOf();
  const p4 = await pageOf();
  check('章内拖动仍正常翻页', c4 === 0 && p4 === 3, `章 ${c4}，页 → 第 ${p4 + 1} 页（期望第 4 页）`);

  // ---- 场景五：双页模式的平移也走同一条路径 ----
  console.log('\n--- 场景五：双页 + 平移，章末向左拖 → 应进入下一章 ---');
  await api('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ readerMode: 'double' }),
  });
  const spreads = Math.ceil(chs[0].pageCount / 2);
  // ?page= 是「图片索引」，双页模式会再折算成跨页号：末尾跨页要传倒数第二张图
  await send('Page.navigate', { url: chapterUrl(0, chs[0].pageCount - 2) });
  await sleep(2400);
  const c5 = await chapterOf();
  const spreadNow = await ev(`(() => { const t = document.body.innerText.match(/第 (\\d+)\\/(\\d+) 页/); return t ? t[0] : ''; })()`);
  await drag(1000, 300);
  const c5after = await chapterOf();
  check('双页平移章末拖入下一章', c5 === 0 && c5after === 1, `章 ${c5}→${c5after}，拖动前 ${spreadNow}（共 ${spreads} 跨页）`);
} finally {
  // 恢复用户原来的设置与阅读模式
  if (!KEEP) {
    await api('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        readerMode: before.readerMode,
        pageAnimation: before.pageAnimation,
        readDir: before.readDir,
        fitMode: before.fitMode,
      }),
    }).catch(() => {});
  }
  ws.close();
  edge.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 句柄未释放时忽略 */ }
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
