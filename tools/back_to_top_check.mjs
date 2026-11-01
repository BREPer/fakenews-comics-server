/**
 * 「回到顶部」校验。
 *
 * 校验项：
 *   1) 首屏（滚动不足一屏）时不可见：opacity 0、pointer-events none、不可聚焦
 *   2) 滚过一屏后出现，且可聚焦
 *   3) 点击后确实回到顶部，随后按钮自己收起
 *   4) 阅读器路由（独立路由、不走 AppShell）不出现这个按钮
 *   5) 层级落在 nav 层：弹层 / 对话框 / toast 都在它之上
 *   6) 手机视口下位于底部 Tab 之上，不压住 Tab
 *   7) 系统「减少动态效果」下点击是瞬时的（不再平滑滚动）
 *
 * 用法：node tools/back_to_top_check.mjs
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
const PORT = 9697;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-btt-'));
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

const BTN = `button[aria-label="回到顶部"]`;
const state = async () => JSON.parse(
  (await ev(`JSON.stringify((() => {
    const b = document.querySelector('${BTN}');
    if (!b) return null;
    const s = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    return {
      opacity: Number(s.opacity),
      pe: s.pointerEvents,
      z: s.zIndex,
      tab: b.tabIndex,
      hidden: b.getAttribute('aria-hidden'),
      top: Math.round(r.top),
      bottom: Math.round(window.innerHeight - r.bottom),
      right: Math.round(window.innerWidth - r.right),
      w: Math.round(r.width), h: Math.round(r.height),
    };
  })())`)) || 'null',
);

const setVP = (w, h, mobile) =>
  send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });

// ---------- 桌面 ----------
await setVP(1280, 900, false);
await send('Page.navigate', { url: `${APP}/` });
await sleep(2600);

let s = await state();
ok('按钮已挂载', !!s);
ok('首屏不显示（opacity 0）', s && s.opacity === 0, `opacity=${s?.opacity}`);
ok('收起时不拦截点击', s && s.pe === 'none', `pointer-events=${s?.pe}`);
ok('收起时不可聚焦（tabIndex -1）', s && s.tab === -1, `tabIndex=${s?.tab}`);
ok('收起时对读屏隐藏', s && s.hidden === 'true', `aria-hidden=${s?.hidden}`);

// 滚到底（真实用法）。注意桌面首屏只够滚 ~650px，写 innerHeight+600 会被 clamp。
await ev(`window.scrollTo(0, document.documentElement.scrollHeight)`);
await sleep(300);
s = await state();
ok('滚到底后出现', s && s.opacity === 1, `opacity=${s?.opacity}`);
ok('出现后可聚焦', s && s.tab === 0, `tabIndex=${s?.tab}`);
ok('触控目标 ≥44px', s && s.w >= 44 && s.h >= 44, `${s?.w}×${s?.h}`);
ok('层级在 nav 层（弹层/toast 更高）', s && Number(s.z) === 40, `z=${s?.z}`);
// toast 容器在 sm 下是 right-6 + bottom-6（距底 24px），单条约占 24~64px
ok('桌面落点避开单条 toast', s && s.bottom >= 90, `距底 ${s?.bottom}px`);

const beforeY = await ev(`Math.round(window.scrollY)`);
await ev(`document.querySelector('${BTN}').click()`);
await sleep(900);
const afterY = await ev(`Math.round(window.scrollY)`);
// 桌面首屏可滚动量只有 ~650px（多列排布），判据按阈值 480 来定而不是拍一个 1000
ok('点击后回到顶部', beforeY > 480 && afterY <= 4, `${beforeY} → ${afterY}`);

await sleep(400);
s = await state();
ok('回顶后按钮自己收起', s && s.opacity === 0, `opacity=${s?.opacity}`);

// 平滑滚动确实在滚（200ms 时还没到顶）—— 与后面的 reduce 对照
await ev(`window.scrollTo(0, document.documentElement.scrollHeight)`);
await sleep(200);
await ev(`document.querySelector('${BTN}').click()`);
await sleep(200);
const midY = await ev(`Math.round(window.scrollY)`);
ok('默认是平滑滚动（200ms 时仍在途中）', midY > 50, `scrollY=${midY}`);
await sleep(900);

// ---------- 阅读器路由不应出现 ----------
// 只取「有章节且有页」的那本：列表第一条可能是空目录/无章节的条目，
// 直接 chapters[0].id 会 TypeError 崩退——整支探针消失，看着像通过。
const detailOf = async (id) => (await (await fetch(`${API}/api/comics/${encodeURIComponent(id)}`)).json())?.data;
const pickComic = async () => {
  const explicit = ARG('comic', '');
  if (explicit) return { id: explicit, detail: await detailOf(explicit) };
  const items = (await (await fetch(`${API}/api/comics?pageSize=50`)).json())?.data?.items ?? [];
  for (const c of items) {
    const d = await detailOf(c.id);
    if (d?.chapters?.length && (d.chapters[0].pageCount ?? 0) > 0) return { id: c.id, detail: d };
  }
  return null;
};
const picked = await pickComic();
if (!picked?.detail?.chapters?.[0]?.id) {
  // 空档既不该伪装成通过，也不该让整个探针崩掉：用 2 表示 SKIP。
  console.error(`SKIP: 没有「有章节且有页」的漫画（API=${API}）`);
  console.error('  先跑一次扫描，或用 --comic=<id> 指定；夹具库目录里要有真图');
  ws.close();
  edge.kill();
  process.exit(2);
}
await send('Page.navigate', { url: `${APP}/read/${picked.id}/${picked.detail.chapters[0].id}` });
await sleep(3000);
const inReader = await ev(`!!document.querySelector('${BTN}')`);
ok('阅读器（全屏独立路由）不出现该按钮', !inReader);

// ---------- 弹层打开时不能浮在弹层之上 ----------
// 用书架页：它有上百条记录，滚到底远超阈值（详情页那本内容不够滚，按钮根本不会出现，
// 那样测出来的是「按钮没出现」而不是「被盖住」）。删除记录会弹确认框（modal 层 130）。
await send('Page.navigate', { url: `${APP}/shelf` });
await sleep(2600);
await ev(`window.scrollTo(0, document.documentElement.scrollHeight)`);
await sleep(300);
const visBefore = await ev(`(() => { const b = document.querySelector('${BTN}'); return b ? Number(getComputedStyle(b).opacity) : -1; })()`);
await ev(`document.querySelector('button[aria-label^="删除"]')?.click()`);
await sleep(700);
const topEl = await ev(`(() => {
  const b = document.querySelector('${BTN}');
  if (!b) return 'no-btn';
  const r = b.getBoundingClientRect();
  const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return el === b ? 'btn' : String(el?.className || el?.tagName || 'none');
})()`);
ok(
  '弹层打开时按钮被遮罩盖住',
  visBefore === 1 && topEl !== 'btn',
  `按钮可见度=${visBefore} 顶层=${String(topEl).slice(0, 42)}`,
);

// ---------- 手机视口：不被底部 Tab 压住 ----------
await setVP(390, 844, true);
await send('Page.navigate', { url: `${APP}/` });
await sleep(2600);
await ev(`window.scrollTo(0, document.documentElement.scrollHeight)`);
await sleep(300);
s = await state();
const tabTop = await ev(`(() => { const n = document.querySelector('nav.fixed'); return n ? Math.round(window.innerHeight - n.getBoundingClientRect().top) : null; })()`);
ok('手机视口下位于底部 Tab 之上', s && tabTop !== null && s.bottom >= tabTop, `按钮距底 ${s?.bottom}px / Tab 高 ${tabTop}px`);

// ---------- 减少动态效果：瞬时回顶 ----------
await send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
});
await send('Page.navigate', { url: `${APP}/` });
await sleep(2600);
await ev(`window.scrollTo(0, document.documentElement.scrollHeight)`);
await sleep(200);
await ev(`document.querySelector('${BTN}').click()`);
await sleep(200);
const reduceY = await ev(`Math.round(window.scrollY)`);
ok('减少动态效果下是瞬时回顶', reduceY <= 4, `scrollY=${reduceY}`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close();
edge.kill();
process.exit(fail === 0 ? 0 : 1);
