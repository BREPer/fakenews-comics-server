/**
 * 「读完一章被识别为已读完整本」复现 / 回归探针。
 *
 * 疑点（代码走查）：
 *   Reader.tsx 上报的 percent 是**章内**百分比：
 *     Math.round(((imageIndex + 1) / pages.length) * 1000) / 10
 *   而服务端 comics.go 用 `percent >= 100 → readStatus = "finished"`，
 *   ComicCard 再据 readStatus 画「已读完」角标、Home 用 `percent < 100`
 *   过滤「在读中」。于是读完多章漫画的第 1 章，全书就被标成已读完。
 *   （后端 progress.go 的注释还写着「percent 为全书维度，按章累计计算」——
 *     实现并没有累计，语义与实现对不上。）
 *
 * 校验项（多章漫画，只读第 1 章到末页）：
 *   1) 服务端 percent = 100
 *   2) 服务端 readStatus 不应是 finished（全书还有后续章）
 *   3) 详情页主按钮不应退回「开始阅读」
 *   4) 列表卡片不应出现「已读完」角标
 *
 * 用法：node tools/finish_check.mjs [--comic=id]
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

// 找一部「多章、第一章页数适中」的漫画
let comic = ARG('comic', '');
let detail;
if (comic) {
  detail = (await (await fetch(`${API}/api/comics/${comic}`)).json()).data;
} else {
  const list = (await (await fetch(`${API}/api/comics?limit=20`)).json()).data.items;
  const pick = list.find((c) => c.chapterCount >= 2) ?? list[0];
  comic = pick.id;
  detail = (await (await fetch(`${API}/api/comics/${comic}`)).json()).data;
}
const chapter = detail.chapters[0];
const last = Math.max(0, chapter.pageCount - 1);
console.log(`comic=${comic} 共 ${detail.chapters.length} 章；读第 1 章（${chapter.pageCount} 页）到末页`);

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const PORT = 9674;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-finish-'));
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

// 直接带 ?page=末页 进阅读器（等同上文读完），等防抖上报
await send('Page.navigate', { url: `${APP}/read/${encodeURIComponent(comic)}/${encodeURIComponent(chapter.id)}?page=${last}` });
await sleep(3000);

// 全书期望进度：前序章页数 + 本章页数 / 全书页数（perf-big 这类 fixture：ch1+ch2）
const totalPages = detail.chapters.reduce((s, c) => s + (c.pageCount || 0), 0);
const firstChapterShare = ((chapter.pageCount || 0) / Math.max(1, totalPages)) * 100;
const p = (await (await fetch(`${API}/api/comics/${comic}`)).json()).data.progress;
check(
  `读完第 1 章，服务端 percent ≈ 全书比例 ${firstChapterShare.toFixed(1)}%`,
  !!p && Math.abs(p.percent - firstChapterShare) < 1,
  `percent=${p?.percent}（期望约 ${firstChapterShare.toFixed(1)}）`,
);

// 列表接口的 readStatus
const listRow = (await (await fetch(`${API}/api/comics?limit=50`)).json()).data.items.find((c) => c.id === comic);
check(
  '多章漫画只读完第 1 章，readStatus 不应是 finished',
  listRow && listRow.readStatus !== 'finished',
  `readStatus=${listRow?.readStatus}（全书 ${detail.chapters.length} 章，只读完第 1 章）`,
);

// 详情页按钮
await send('Page.navigate', { url: `${APP}/comic/${comic}` });
await sleep(2200);
const btn = await ev(`(() => { const b = [...document.querySelectorAll('a,button')].find((x) => /开始阅读|继续阅读/.test(x.textContent || '')); return b ? b.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
check('详情页按钮仍引导继续阅读（不应退回「开始阅读」）', !!btn && /继续阅读/.test(btn), `按钮=${btn}`);

// 首页卡片角标
await send('Page.navigate', { url: `${APP}/` });
await sleep(2200);
const card = await ev(`(() => {
  const t = [...document.querySelectorAll('a[href^="/comic/"]')].find((a) => a.getAttribute('href') === '/comic/${comic}');
  if (!t) return null;
  return { hasFinishedBadge: /已读完/.test(t.textContent || ''), text: (t.textContent || '').replace(/\\s+/g, ' ').slice(0, 80) };
})()`);
check('列表卡片不出现「已读完」角标', !!card && card.hasFinishedBadge === false, card);

// 真读完最后一章：percent=100、finished、角标出现
const lastChapter = detail.chapters[detail.chapters.length - 1];
const lastPage = Math.max(0, lastChapter.pageCount - 1);
await send('Page.navigate', { url: `${APP}/read/${encodeURIComponent(comic)}/${encodeURIComponent(lastChapter.id)}?page=${lastPage}` });
await sleep(3000);
const p2 = (await (await fetch(`${API}/api/comics/${comic}`)).json()).data.progress;
check('读完最后一章 percent=100', !!p2 && p2.percent === 100, `percent=${p2?.percent}`);
const listRow2 = (await (await fetch(`${API}/api/comics?limit=50`)).json()).data.items.find((c) => c.id === comic);
check('读完最后一章 readStatus=finished', listRow2 && listRow2.readStatus === 'finished', `readStatus=${listRow2?.readStatus}`);
await send('Page.navigate', { url: `${APP}/` });
await sleep(2200);
const card2 = await ev(`(() => {
  const t = [...document.querySelectorAll('a[href^="/comic/"]')].find((a) => a.getAttribute('href') === '/comic/${comic}');
  if (!t) return null;
  return { hasFinishedBadge: /已读完/.test(t.textContent || ''), text: (t.textContent || '').replace(/\\s+/g, ' ').slice(0, 80) };
})()`);
check('读完最后一章卡片出现「已读完」角标', !!card2 && card2.hasFinishedBadge === true, card2);

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
