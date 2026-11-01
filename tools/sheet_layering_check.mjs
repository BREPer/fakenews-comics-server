// 弹层层叠与底栏透明度校验。
//
// 回归背景（2026-10-24）：
//   1) 底栏曾是 bg-ink-900/92 —— /92 不在 Tailwind 的 opacity 刻度里，规则根本没生成，
//      于是它是「纯 blur」的透明观感；我改成有效的 /90 后变成实色，用户要求回到透明。
//      现在刻意不写背景色，只有 backdrop-blur。这个脚本锁住「背景 alpha ≈ 0」。
//   2) 漫画库「新建/编辑」面板底部被底栏压住：弹层是 fixed inset-0 z-50，但渲染在页面
//      组件树里，祖先的 animation/transform 会形成层叠上下文，z-index 只在上下文内比较，
//      body 层级的底栏（z-40）就盖到了弹层上。改成 createPortal 到 body 后修复。
//      这个脚本用 elementFromPoint 判断底栏区域是否被弹层接管。
//
// 用法：node tools/sheet_layering_check.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = 'http://127.0.0.1:13800';
const PORT = 9834;
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
if (!EDGE) {
  console.error('未找到 Edge');
  process.exit(1);
}

const api = async (p, i) => (await fetch(BASE + p, i)).json();
const put = (b) => api('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const before = (await api('/api/settings')).data;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-layer-'));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });
let wsUrl;
for (let i = 0; i < 100; i++) {
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
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
});
const send = (m, p = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true }))?.result?.value;

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await send('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }] });

let pass = 0;
let fail = 0;
const ok = (c, m, x = '') => {
  if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}  ${x}`); }
};

/*
 * 层级不再写死在类名里（z-50 / z-[60]），统一走 index.css :root 的 --layer-*。
 * 探针从页面读期望值再和计算后的 zIndex 比，避免改一次层级就要改一次脚本。
 */
let LAYER_SHEET = 120;
let LAYER_MODAL = 130;
// 先落一个真实页面，about:blank 上读不到 :root 的自定义属性
await send('Page.navigate', { url: `${BASE}/libraries` });
await sleep(1800);
const layer = await ev(`(() => {
  const s = getComputedStyle(document.documentElement);
  return {
    nav: Number(s.getPropertyValue('--layer-nav')),
    sheet: Number(s.getPropertyValue('--layer-sheet')),
    modal: Number(s.getPropertyValue('--layer-modal')),
  };
})()`);
console.log('层级变量', JSON.stringify(layer));
ok(layer.nav > 0 && layer.sheet > layer.nav && layer.modal > layer.sheet, `层级变量齐全且递增（nav<sheet<modal）`, JSON.stringify(layer));
if (layer.sheet) LAYER_SHEET = layer.sheet;
if (layer.modal) LAYER_MODAL = layer.modal;

const sheetList = () => ev(`[...document.querySelectorAll('div.fixed.inset-0')].map((d) => {
  const cs = getComputedStyle(d);
  const panel = d.querySelector(':scope > div:last-child');
  const pr = panel?.getBoundingClientRect();
  return { z: Number(cs.zIndex), parent: d.parentElement.tagName, panelTop: pr ? Math.round(pr.top) : null };
})`);

/** 底栏所在高度（离底 30px）命中的元素属于谁 */
const hitTabbar = () => ev(`(() => {
  const el = document.elementFromPoint(60, innerHeight - 30);
  return { tag: el?.tagName ?? null, inNav: !!el?.closest('nav'), inSheet: !!el?.closest('.fixed.inset-0') };
})()`);

for (const theme of ['light', 'dark']) {
  await put({ theme });
  await send('Page.navigate', { url: `${BASE}/libraries` });
  await sleep(2100);
  console.log(`\n=== ${theme} ===`);

  // 1) 底栏透明（背景 alpha ≈ 0，只保留 blur）
  const nav = await ev(`(() => { const n = document.querySelector('nav.fixed'); const cs = getComputedStyle(n); return { bg: cs.backgroundColor, blur: cs.backdropFilter }; })()`);
  const alpha = Number((nav.bg.match(/rgba?\([^)]*,\s*([\d.]+)\)/) || [])[1] ?? 1);
  ok(alpha <= 0.05 && nav.blur !== 'none', `底栏透明（${nav.bg}, ${nav.blur}）`, JSON.stringify(nav));

  // 2) 新建库面板：挂在 body，且盖住底栏
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('新建')); b?.click(); })()`);
  await sleep(900);
  const list = await sheetList();
  ok(list.length === 1 && list[0].parent === 'BODY', `新建面板 portal 到 body（${JSON.stringify(list)}）`, JSON.stringify(list));
  const hit = await hitTabbar();
  ok(!hit.inNav && hit.inSheet, `面板盖住底栏（底栏高度命中 ${hit.tag}）`, JSON.stringify(hit));

  // 3) 表单主按钮滚到底后完整可见可点
  const btn = await ev(`(() => {
    const sheet = [...document.querySelectorAll('div.fixed.inset-0')].find((d) => Number(getComputedStyle(d).zIndex) === ${LAYER_SHEET});
    const scroller = sheet?.querySelector('.overflow-y-auto');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    const b = [...(sheet?.querySelectorAll('button') || [])].find((x) => x.textContent.includes('保存并扫描'));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { bottom: Math.round(r.bottom), vh: innerHeight, clickable: at === b || b.contains(at) };
  })()`);
  ok(!!btn && btn.bottom <= btn.vh && btn.clickable, `「保存并扫描」可见且可点（bottom=${btn?.bottom}/${btn?.vh}）`, JSON.stringify(btn));

  // 关闭按钮是图标（无文字），按 aria-label 找。以前按 textContent === '关闭' 定位，
  // 改成 X 图标后那条断言会静默点空 —— 这里跟着改成语义定位。
  await ev(`(() => { const s = [...document.querySelectorAll('div.fixed.inset-0')].find((d) => Number(getComputedStyle(d).zIndex) === ${LAYER_SHEET}); s?.querySelector('button[aria-label="关闭"]')?.click(); })()`);
  await sleep(700);
  ok((await sheetList()).length === 0, '面板关闭后从 DOM 移除');

  // 3.5) 面板打开时背景不该还能滚（滚动锁）
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('新建')); b?.click(); })()`);
  await sleep(900);
  /*
    不测「滚不动」：overflow:hidden 的视口仍然可以被程序滚动（scrollBy / scrollTop），
    拿它当断言会假阴性。锁的直接证据就是根元素的 overflow 被置为 hidden，
    关闭后必须还原 —— 还原不干净的话，关掉面板后整页都滚不动，比不锁更糟。
  */
  const lock = await ev(`(() => ({
    htmlOverflow: getComputedStyle(document.documentElement).overflow,
    bodyPadRight: getComputedStyle(document.body).paddingRight,
  }))()`);
  ok(lock.htmlOverflow === 'hidden', `面板打开时背景锁滚动（${JSON.stringify(lock)}）`, JSON.stringify(lock));
  await ev(`(() => { const s = [...document.querySelectorAll('div.fixed.inset-0')].find((d) => Number(getComputedStyle(d).zIndex) === ${LAYER_SHEET}); s?.querySelector('button[aria-label="关闭"]')?.click(); })()`);
  await sleep(700);
  const unlocked = await ev(`getComputedStyle(document.documentElement).overflow`);
  ok(unlocked !== 'hidden', `关闭后恢复滚动（${unlocked}）`, unlocked);
}

// 4) 上传弹层 + 删除确认弹窗（z 顺序与可点性）
await put({ theme: 'light' });
await send('Page.navigate', { url: `${BASE}/libraries` });
await sleep(2000);
console.log('\n=== 其它弹层 ===');
await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.title || '').includes('上传')); b?.click(); })()`);
await sleep(900);
let list = await sheetList();
ok(list.length === 1 && list[0].z === LAYER_SHEET && list[0].parent === 'BODY', `上传面板 z=${LAYER_SHEET} 且挂在 body（${JSON.stringify(list)}）`, JSON.stringify(list));
// 遮罩的 absolute/inset-0 已收进 .scrim 类里，按字面类名找不到了；
// 用语义类名定位，退回「容器第一个子元素」兜底（结构就是 [遮罩, 面板]）。
await ev(`(() => { const d = [...document.querySelectorAll('div.fixed.inset-0')][0]; (d?.querySelector('.scrim') || d?.firstElementChild)?.click(); })()`);
await sleep(700);

await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.title || '') === '删除漫画库'); b?.click(); })()`);
await sleep(800);
list = await sheetList();
ok(list.length === 1 && list[0].z === LAYER_MODAL, `删除确认弹窗 z=${LAYER_MODAL}（${JSON.stringify(list)}）`, JSON.stringify(list));
const cancel = await ev(`(() => {
  const d = [...document.querySelectorAll('div.fixed.inset-0')].find((x) => Number(getComputedStyle(x).zIndex) === ${LAYER_MODAL});
  const b = [...d.querySelectorAll('button')].find((x) => x.textContent.includes('取消'));
  const r = b.getBoundingClientRect();
  const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { bottom: Math.round(r.bottom), vh: innerHeight, clickable: at === b || b.contains(at) };
})()`);
ok(cancel.bottom <= cancel.vh && cancel.clickable, `「取消」可见且可点（bottom=${cancel.bottom}/${cancel.vh}）`, JSON.stringify(cancel));
await ev(`(() => { const d = [...document.querySelectorAll('div.fixed.inset-0')].find((x) => Number(getComputedStyle(x).zIndex) === ${LAYER_MODAL}); [...d.querySelectorAll('button')].find((x) => x.textContent.includes('取消'))?.click(); })()`);
await sleep(600);

await put({ theme: before.theme, accent: before.accent }).catch(() => { /* 忽略 */ });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close();
edge.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(fail ? 1 : 0);
