/**
 * 复现并回归：从阅读器返回详情页后，阅读记录是否同步刷新。
 *
 * 症状（用户报告）：详情页点章节进入阅读器，返回后详情页仍显示进入前的状态
 * （按钮不提「继续阅读 xx%」、章节列表不出现「在读／百分比」）。
 *
 * 测法：真实浏览器，走 SPA 路由（阅读器后退 → navigate(-1)），不手动刷新页面。
 * 两种返回时机都要过：
 *   fast —— 翻页后立刻返回（防抖 1s 还没到，只有离场 flush 这一条上报路径）
 *   slow —— 翻页后停了 1.2s 再返回（防抖已上报成功）
 *
 * 用法：node tools/detail_progress_check.mjs
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

// 选一部至少 2 章、首页章节页数够翻的漫画（perf-big：ch01 30 页 / ch02 6 页）
async function pick() {
  const list = await (await fetch(`${BASE}/api/comics?pageSize=50`)).json();
  for (const c of list.data.items) {
    const d = await (await fetch(`${BASE}/api/comics/${c.id}`)).json();
    const chs = d.data.chapters ?? [];
    if (chs.length >= 2 && chs[0].pageCount >= 10) return { id: c.id, title: c.title, chapters: chs };
  }
  throw new Error('找不到「至少 2 章且首章 ≥10 页」的漫画：先跑 node tools/perf_fixture.mjs');
}

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

const PORT = Number(ARG('port', '9512'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-dp-'));
const edge = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--window-size=1280,900',
  'about:blank',
], { stdio: 'ignore' });

let wsUrl;
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch { /* 还没起来 */ }
  await sleep(150);
}
if (!wsUrl) { edge.kill(); throw new Error('Edge 调试端口未就绪'); }

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pend = new Map();
const apiCalls = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params.request.url;
    if (u.includes('/api/')) apiCalls.push(`${m.params.request.method} ${u.replace(BASE, '').split('?')[0]}`);
  }
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
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

const comic = await pick();
const detailUrl = `${BASE}/comic/${comic.id}`;
console.log(`目标：${comic.title}（${comic.id}）${comic.chapters.map((c) => c.pageCount + '页').join(' / ')}\n`);

const readDetail = () =>
  ev(`JSON.stringify({
    btn: (document.querySelector('[data-testid="start-reading"]')||{}).innerText || null,
    sec: (document.querySelector('section')||{}).innerText || null,
    inRead: location.pathname.startsWith('/read/'),
  })`);

/** 重置服务端进度，回到干净的「未读」状态 */
async function reset() {
  const r = await fetch(`${BASE}/api/progress/${comic.id}/reset`, { method: 'POST' });
  if (!r.ok) throw new Error(`重置进度失败 ${r.status}`);
}

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '\n    ' + detail : ''}`);
  if (!ok) failed++;
}

/**
 * @param {string} name 场景名
 * @param {'fast'|'slow'} timing 返回时机
 * @param {number} turns 翻几页
 * @param {number} chapterIdx 点第几章（0 起）
 */
async function scenario(name, timing, turns, chapterIdx = 0) {
  console.log(`--- ${name} ---`);
  await reset();

  // 1. 进详情页（先导航再清镜像：about:blank 阶段跨域读不到 localStorage）
  await send('Page.navigate', { url: detailUrl });
  await sleep(1800);
  await ev(`localStorage.removeItem('fakenews-progress-mirror')`);
  const before = JSON.parse(await readDetail());
  const beforePct = /继续阅读/.test(before.btn || '') ? Number((before.btn.match(/(\d+)%/) || [])[1] ?? -1) : -1;
  check('① 重置后详情页应为「未开始」', !/继续阅读/.test(before.btn || ''), `按钮：${before.btn}`);

  // 2. 点章节（真实点击，不是直接改 URL）
  //    section 里第一个 button 是「切换章节布局」，要跳过；章节项文本形如「1. ch01」或四格视图里的「1」
  const clicked = await ev(`(() => {
    const btns = [...document.querySelectorAll('section button')].filter(b => !b.hasAttribute('aria-label'));
    const chapters = btns.filter(b => /^\\d+\\./.test(b.innerText.trim()) || /^\\d+$/.test(b.innerText.trim()));
    const target = chapters[${chapterIdx}] || chapters[0];
    if (!target) return 'no-chapter-button';
    target.click();
    return 'ok:' + target.innerText.trim().slice(0, 20);
  })()`);
  if (!clicked.startsWith('ok')) { check('② 进入阅读器', false, String(clicked)); return; }
  await sleep(1600);
  const entered = JSON.parse(await readDetail());
  check('② 已进入阅读器路由', entered.inRead, `path=${await ev('location.pathname')}`);
  if (!entered.inRead) return;

  // 3. 翻页（键盘 →，与真实用户一致）
  for (let i = 0; i < turns; i++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await sleep(220);
  }
  const atPage = await ev(`(document.body.innerText.match(/(\\d+)\\/(\\d+) 页/) || [])[0] || '?'`);
  if (timing === 'slow') await sleep(1300); // 让防抖上报先完成

  // 4. 返回（走 SPA 路由，等价于点阅读器左上角返回：navigate(-1)）
  apiCalls.length = 0;
  await ev('window.history.back()');
  await sleep(1200); // 详情页挂载 → 离场 flush 可能还在飞
  await sleep(900);  // 给 invalidate 后的 refetch 留时间

  const after = JSON.parse(await readDetail());
  const afterPct = Number((after.btn || '').match(/(\d+)%/) ?.[1] ?? -1);
  const secText = (after.sec || '').replace(/\s+/g, ' ');
  const detailRefetched = apiCalls.some((c) => c.startsWith(`GET /api/comics/${comic.id}`));

  // 服务端真相：进度是否真的写进去了
  const server = (await (await fetch(`${BASE}/api/comics/${comic.id}`)).json()).data.progress;

  const ch = comic.chapters[chapterIdx];
  const pageNow = turns + 1; // 从第 1 页起翻 turns 次
  const expectPct = Math.round((pageNow / ch.pageCount) * 1000) / 10;
  /** 读到章末（100%）时详情页应显示「已读」，按钮回到「开始阅读」 */
  /**
   * 「读完」的含义已改为**读完整本书**：停在最后一章且本章到末页。
   * 只读完中间某一章 → 按钮仍应是「继续阅读」（引导去下一章），不是「开始阅读」。
   */
  const isLastChapter = chapterIdx >= comic.chapters.length - 1;
  const finished = pageNow >= ch.pageCount && isLastChapter;
  /** 取某一章在章节区文本里的片段，用来确认「在读/已读/百分比」标在了对的章上 */
  const segOf = (i) => {
    const from = secText.indexOf(`${i + 1}. ${comic.chapters[i].title}`);
    if (from < 0) return '';
    const next = secText.indexOf(`${i + 2}. `, from);
    return secText.slice(from, next > 0 ? next : undefined);
  };
  const seg = segOf(chapterIdx);

  console.log(
    `    阅读器停在第 ${pageNow} 页（应约 ${expectPct}%）；服务端记录 page=${server?.pageIndex} ${server?.percent}%`,
  );
  console.log(`    返回后按钮：${(after.btn || '').replace(/\s+/g, ' ')}`);
  console.log(`    返回后章节区：${secText.slice(0, 140)}`);
  console.log(`    返回期间 /api 请求：${apiCalls.join(', ') || '（无）'}`);

  const label = timing === 'fast' ? '③ 快速返回' : '③ 停留后返回';
  if (finished) {
    // 章末读完：全书进度到 100%，按钮回到「开始阅读」
    check(`${label}：章末读完按钮回到「开始阅读」`, /开始阅读/.test(after.btn || ''), `按钮「${(after.btn || '').replace(/\s+/g, '')}」`);
  } else {
    check(
      `${label}：详情页进度已刷新`,
      /继续阅读/.test(after.btn || '') && afterPct > beforePct,
      `按钮「${(before.btn || '').replace(/\s+/g, '')}」→「${(after.btn || '').replace(/\s+/g, '')}」`,
    );
  }
  // 分章进度（chapter_progress）已整体移除：进度只记录「当前正在阅读的章节」。
  // 因此只有当前章能出现「在读」标记，其它章必须干净——没有任何已读/百分比。
  if (!finished) {
    check(`${label}：第 ${chapterIdx + 1} 章（当前在读）标「在读」`, /在读/.test(seg), `该章片段：${seg || '（未找到章节行）'}`);
  }
  const others = comic.chapters
    .map((_, i) => i)
    .filter((i) => i !== chapterIdx)
    .map(segOf)
    .filter(Boolean);
  const dirty = others.filter((s) => /在读|已读|\d+%/.test(s));
  check(
    `${label}：非当前章无任何进度标记`,
    dirty.length === 0,
    dirty.slice(0, 2).join(' | ') || `共 ${others.length} 章，全部干净`,
  );

  // ④ 只作诊断：数据对就行，不强求「返回时必须再拉一次」。
  //    阅读器自己也用 useComicDetail（取章节），那次 invalidate 在阅读器里就把缓存刷新了，
  //    返回时直接读缓存反而更快。只有「数据旧」才是问题，而它已经由 ③ 兜住。
  console.log(
    `    刷新时机：${detailRefetched ? '返回时重新拉取' : '返回前已在阅读器内刷新（缓存即新值）'}`,
  );
}

try {
  await scenario('场景一：翻 5 页后立刻返回（只有离场 flush 上报）', 'fast', 5);
  await scenario('场景二：翻 8 页后停留 1.2s 再返回（防抖已上报）', 'slow', 8);
  // 换章：点第 2 章（6 页）读到章末，详情页应把「已读」标在第 2 章
  await scenario('场景三：点第 2 章读到末页后返回（换章 + 读完）', 'slow', 5, 1);
} finally {
  ws.close();
  edge.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Windows 句柄未释放时忽略 */ }
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
