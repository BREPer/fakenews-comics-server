/**
 * 搜索页「下方区域闪一下」回归探针。
 *
 * 背景（改前的实测）：搜索页在没有关键词时也会拉一份整库列表，换关键词后
 * keepPreviousData 把这份「找到 509 部 + 36 张卡」当占位渲染，约 30ms 后被空结果
 * 顶掉，页面高度 805 → 1777 → 805，看上去就是下面闪了一下。
 *
 * 覆盖：
 *   1) 无关键词不发列表请求（否则旧数据又会混进来占位）
 *   2) 搜不存在的词：中间不出现网格 / 骨架，文档高度全程不变（零闪动）
 *   3) 慢网下仍会给「在搜了」的信号（骨架屏），不能为了不闪而把反馈吞掉
 *   4) 搜真实存在的词：结果照常出来
 *
 * 依赖：后端在跑。默认打 vite dev(5173)，也可 `--base=<url>` 指向生产形态的实例
 *       （打包产物，`http://127.0.0.1:13800`）—— 之前写死 5173，dev 没起时会
 *       整页加载失败、5 项全部误报 FAIL，看不出是环境还是产品的锅。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP = (process.argv.find((a) => a.startsWith('--base=')) ?? '').slice(7) || 'http://127.0.0.1:5173';
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const PORT = 9736;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-search-'));
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
const send = (method, params = {}) =>
  new Promise((resolve) => { const id = ++seq; pend.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
});
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.value;
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) pass++; else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};

await send('Page.enable');
await send('Runtime.enable');

/** 统计列表请求次数（同源 5173，走 Vite 代理） */
let listHits = 0;
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Network.requestWillBeSent' && m.params?.request?.url?.includes('/api/comics')) listHits++;
});
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });

/** 下方区域每帧快照：类型 + 首行文字 + 文档高度（直接返回对象，returnByValue 会带回来） */
const PROBE = `(() => {
  const root = document.querySelector('input')?.closest('div.flex.flex-col');
  if (!root) return { err: 'no root' };
  const kids = [...root.children].slice(1);
  return {
    kinds: kids.map((el) => (el.querySelector('.skeleton') ? 'SKELETON'
      : el.className.includes('animate-rise') ? 'EMPTY'
      : 'GRID') + '|' + (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 24)),
    docH: document.documentElement.scrollHeight,
  };
})()`;

const type = async (s) => {
  // 必须先聚焦：ccfe58a 起搜索页刻意不再自动聚焦（免得手机上进页面就弹键盘），
  // 而 dispatchKeyEvent 的 char 只会发给当前焦点元素 —— 不先点进输入框，
  // 字符全落到 body 上，页面永远停在提示态，4 项都会误报失败。
  await ev(`(() => { const i = document.querySelector('input'); if (i) { i.focus(); return document.activeElement === i; } return false; })()`);
  for (const ch of s) {
    await send('Input.dispatchKeyEvent', { type: 'char', text: ch });
    await sleep(40);
  }
};
/** 采样 N 帧，返回去重的（时间, 快照）序列 */
const sample = async (frames = 80, gap = 25) => {
  const out = [];
  const t0 = Date.now();
  for (let i = 0; i < frames; i++) {
    out.push({ t: Date.now() - t0, s: await ev(PROBE) });
    await sleep(gap);
  }
  return out.filter((r, i) => i === 0 || JSON.stringify(r.s) !== JSON.stringify(out[i - 1].s));
};

// ---------- 1) 无关键词：不发列表请求、显示提示态 ----------
await send('Page.navigate', { url: `${APP}/search` });
await sleep(1200);
listHits = 0;
await sleep(700);
ok('无关键词时不发列表请求', listHits === 0, `hits=${listHits}`);
let snap = await ev(PROBE);
ok('无关键词显示提示空态', /EMPTY\|输入关键词/.test(snap.kinds?.[0] ?? ''), snap.kinds?.[0]);

// ---------- 2) 搜不存在的词：中间不许出现网格 / 骨架 ----------
const before = (await ev(PROBE)).docH;
await type('zzzznotexist');
const seq1 = await sample();
const kinds = seq1.map((r) => r.s.kinds?.join(' || ') ?? '');
const heights = seq1.map((r) => r.s.docH);
ok('最终落到「没有找到」', /没有找到/.test(kinds[kinds.length - 1] ?? ''), kinds[kinds.length - 1]);
ok('中间没有闪出结果网格', !kinds.some((k) => /GRID/.test(k)), kinds.join(' → '));
ok('中间没有闪出骨架屏', !kinds.some((k) => /SKELETON/.test(k)), kinds.join(' → '));
ok('全程文档高度不变（无撑开再缩回）', heights.every((h) => Math.abs(h - before) <= 2), `${heights.join('/')} vs ${before}`);
ok('状态只跳变一次（提示态 → 空结果）', seq1.length <= 2, `跳变 ${seq1.length} 次`);

// ---------- 3) 慢网：仍要给「在搜了」的信号 ----------
await send('Page.navigate', { url: `${APP}/search` });
await sleep(1000);
await send('Network.emulateNetworkConditions', {
  offline: false, latency: 400, downloadThroughput: (500 * 1024) / 8, uploadThroughput: (256 * 1024) / 8,
});
await type('zzzznotexist');
const seq2 = await sample(90, 25);
ok('慢网下会出现骨架屏', seq2.some((r) => /SKELETON/.test(r.s.kinds?.join('') ?? '')), seq2.map((r) => r.s.kinds?.join('')).join(' → '));
await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

// ---------- 4) 搜真实存在的词：结果照常出来 ----------
const api = await (await fetch('http://127.0.0.1:13800/api/comics?page=1&pageSize=1')).json();
const term = api?.data?.items?.[0]?.title?.slice(0, 2);
if (term) {
  await send('Page.navigate', { url: `${APP}/search` });
  await sleep(1000);
  await type(term);
  const seq3 = await sample(60, 30);
  const last = seq3[seq3.length - 1];
  ok('真实关键词能搜出结果', /GRID/.test(last?.s.kinds?.join('') ?? ''), last?.s.kinds?.join(''));
} else {
  ok('真实关键词能搜出结果', false, '拿不到样例书名');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close();
try { edge.kill(); } catch { /* noop */ }
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
process.exit(fail ? 1 : 0);
