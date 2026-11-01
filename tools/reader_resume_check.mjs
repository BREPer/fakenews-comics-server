/**
 * 阅读器「续读告知」校验。
 *
 * 校验项：
 *   1) 从头进入（无进度、无 page）不弹卡 —— 没有「续」的成分就不该打扰
 *   2) 带页码进入 → 弹续读卡，文案是模式页口径的「第 N / M 页」，带「从头开始」
 *   3) 「从头开始」真的回到第 1 页并收起卡片
 *   4) 服务端进度恢复（不带 page）同样能弹 —— 真实续读路径，不只是 URL 直达
 *   5) 落点在末页时不弹续读卡
 *   6) 卡片落在下半屏、在底部工具栏之上（不压画面中央）
 *   7) 换章后不残留（卡片说的是上一章的落点）
 *   8) 6s 后自动收起
 *   9) 手机视口不被工具栏 / 安全区吞掉、不出血
 *
 * 用法：node tools/reader_resume_check.mjs
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
  const kv = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (kv) return kv.slice(n.length + 3);
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const APP = ARG('base', 'http://127.0.0.1:5173').replace(/\/$/, '');
const API = ARG('api', 'http://127.0.0.1:13800').replace(/\/$/, '');

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const PORT = 9713;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-resume-'));
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
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
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

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? `  ${extra}` : ''}`); }
};

const PROMPT = '[data-testid="reader-prompt"]';
const card = async () => JSON.parse(
  (await ev(`JSON.stringify((() => {
    const el = document.querySelector('${PROMPT}');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      kind: el.dataset.kind || '',
      text: (el.innerText || '').replace(/\\s+/g, ' ').trim(),
      btns: Array.from(el.querySelectorAll('button')).map(function (b) { return (b.innerText || b.getAttribute('aria-label') || '').trim(); }),
      opacity: Number(s.opacity),
      leaving: el.className.indexOf('is-leaving') >= 0,
      top: Math.round(r.top),
      fromBottom: Math.round(window.innerHeight - r.bottom),
      vh: window.innerHeight,
    };
  })())`)) || 'null',
);
const pageParam = async () => Number(await ev(`new URLSearchParams(location.search).get('page')`));
const clickBtn = async (label) =>
  ev(`(() => {
    const el = document.querySelector('${PROMPT}');
    if (!el) return 'no-card';
    const b = Array.from(el.querySelectorAll('button')).find(function (x) { return (x.innerText || '').indexOf('${label}') >= 0; });
    if (!b) return 'no-btn';
    b.click();
    return 'ok';
  })()`);

// ---------- 选书：多章 + 无历史进度（否则「从头进入」会变成续读） ----------
const listRes = await (await fetch(`${API}/api/comics?page=1&pageSize=200`)).json();
let comic = null;
for (const it of listRes?.data?.items ?? []) {
  if ((it.chapterCount ?? 0) < 2 || it.progress) continue;
  const d = (await (await fetch(`${API}/api/comics/${it.id}`)).json())?.data;
  const chs = d?.chapters ?? [];
  if (chs.length >= 2 && chs[0].pageCount >= 4) { comic = d; break; }
}
if (!comic) {
  console.log('SKIP  没有找到「多章 + 无进度」的漫画，无法校验');
  edge.kill();
  process.exit(0);
}
const ch0 = comic.chapters[0];
// 续读落点：必须不是末页（末页不弹续读卡，见用例 5），选书条件保证第 1 章 ≥4 页
const RP = Math.min(2, ch0.pageCount - 2);
console.log(`用例漫画：${comic.title}（${comic.chapters.length} 章，第 1 章 ${ch0.pageCount} 页）`);

const open = async (chapterId, page) => {
  const q = page === undefined ? '' : `?page=${page}`;
  await send('Page.navigate', { url: `${APP}/read/${encodeURIComponent(comic.id)}/${encodeURIComponent(chapterId)}${q}` });
  await sleep(3000);
};
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

// ---------- 1) 从头进入：不该有卡 ----------
await open(ch0.id);
ok('从头进入无提示卡', (await card()) === null);

// ---------- 2) 带页码进入：续读告知 ----------
await open(ch0.id, RP);
let c = await card();
ok('带页码进入弹出续读卡', c && c.kind === 'resume', `kind=${c?.kind}`);
ok('续读卡写明落点（模式页口径）', !!c && c.text.includes(`上次读到第 ${RP + 1} / ${ch0.pageCount} 页`), `text=${c?.text}`);
ok('续读卡给出「从头开始」出口', !!c && c.btns.some((b) => b.includes('从头开始')), `btns=${c?.btns}`);
ok('续读卡落在下半屏（不压画面中央）', !!c && c.top > c.vh * 0.5, `top=${c?.top} / vh=${c?.vh}`);
ok('续读卡在底部工具栏之上', !!c && c.fromBottom >= 56, `距底 ${c?.fromBottom}px`);

// ---------- 3) 「从头开始」 ----------
ok('点击「从头开始」', (await clickBtn('从头开始')) === 'ok');
await sleep(600);
ok('回到第 1 页', (await pageParam()) === 0, `page=${await pageParam()}`);
ok('点完卡片收起', (await card()) === null);

// ---------- 4) 服务端进度恢复（不带 page） ----------
// 必须先离开阅读器再写进度：留在阅读器里直接 PUT，导航时的 pagehide flush 会把
// 「上一幕刚点过从头开始」的第 0 页又写一遍，把这条进度顶掉（真实时序约束）。
await send('Page.navigate', { url: `${APP}/` });
await sleep(1400);
await fetch(`${API}/api/progress`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    comicId: comic.id, chapterId: ch0.id, chapterIndex: 0,
    pageIndex: 2, pageCount: ch0.pageCount, percent: 0,
  }),
});
await open(ch0.id);
c = await card();
ok('服务端进度恢复也弹续读卡', c && c.kind === 'resume', `kind=${c?.kind}`);
ok('服务端恢复的落点正确', !!c && c.text.includes(`上次读到第 3 / ${ch0.pageCount} 页`), `text=${c?.text}`);

// ---------- 5) 末页不弹续读卡 ----------
await open(ch0.id, ch0.pageCount - 1);
ok('落点是末页时不弹续读卡', (await card()) === null);

// ---------- 6) 换章后不残留 ----------
await open(ch0.id, RP);
ok('换章前卡片在屏', (await card()) !== null);
await ev(`(() => {
  const b = Array.from(document.querySelectorAll('button')).find(function (x) { return (x.innerText || '').indexOf('下一章') >= 0; });
  if (!b) return 'no-btn';
  b.click();
  return 'ok';
})()`);
await sleep(2600);
const inCh1 = await ev(`decodeURIComponent(location.pathname).indexOf('${comic.chapters[1].id}') >= 0`);
ok('点了底部「下一章」确实换章', inCh1 === true);
ok('换章后续读卡不残留', (await card()) === null);

// ---------- 7) 自动收起 ----------
await open(ch0.id, RP);
ok('再次进入仍会提示', (await card()) !== null);
await sleep(6600);
c = await card();
ok('约 6s 后自动收起', c === null || c.leaving === true, `card=${c ? c.text : 'null'}`);

// ---------- 8) 手机视口 ----------
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await open(ch0.id, RP);
c = await card();
ok('手机视口卡片可见', !!c, `kind=${c?.kind}`);
ok('手机视口卡片在底部工具栏之上', !!c && c.fromBottom >= 56, `距底 ${c?.fromBottom}px`);
ok('手机视口卡片仍在下半屏', !!c && c.top > c.vh * 0.5, `top=${c?.top} / vh=${c?.vh}`);
const w = await ev(`Math.round(document.querySelector('${PROMPT}').getBoundingClientRect().width)`);
ok('手机视口卡片不出血', w > 0 && w <= 390 - 24, `宽 ${w}px`);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
edge.kill();
process.exit(fail === 0 ? 0 : 1);
