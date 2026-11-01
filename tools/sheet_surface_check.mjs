// 弹层材质一致性校验：编辑 / 上传 / 新建漫画库 / 章节 / 阅读设置 五处是否同一套外壳。
//
// 背景（2026-10-25）：五处都 import 同一个 <Sheet>，但「代码里同一个组件」不等于
// 「渲染出来同一个样子」——调用方可以传 side、可以套外层 div（阅读器曾套过 .dark
// 强制深色）、可以覆盖 className。这个脚本直接读 computed style 比对，
// 锁住的是用户真正看到的口径：遮罩黑度/模糊、面板底色/模糊/饱和度、圆角、阴影、
// 最大高度、把手、关闭按钮。
//
// 用法：node tools/sheet_surface_check.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = 'http://127.0.0.1:13800';
const PORT = 9837;
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
if (!EDGE) {
  console.error('未找到 Edge');
  process.exit(1);
}

const api = async (p, i) => (await fetch(BASE + p, i)).json();
const put = (b) => api('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const before = (await api('/api/settings')).data;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-surf-'));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
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
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

let pass = 0;
let fail = 0;
const ok = (c, m, x = '') => {
  if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}  ${x}`); }
};

await send('Page.navigate', { url: `${BASE}/libraries` });
await sleep(1800);
const LAYER_SHEET = Number(await ev(`Number(getComputedStyle(document.documentElement).getPropertyValue('--layer-sheet'))`));
console.log(`--layer-sheet = ${LAYER_SHEET}`);

/** 采集当前打开的 Sheet 的遮罩与面板材质 */
const probe = () => ev(`(() => {
  const root = [...document.querySelectorAll('div.fixed.inset-0')]
    .find((d) => Number(getComputedStyle(d).zIndex) === ${LAYER_SHEET});
  if (!root) return null;
  const scrim = root.querySelector('.scrim') || root.children[0];
  const panel = [...root.children].find((c) => c !== scrim);
  const g = (el) => { if (!el) return null; const s = getComputedStyle(el); return {
    bg: s.backgroundColor, blur: s.backdropFilter,
    radius: s.borderTopLeftRadius + '/' + s.borderTopRightRadius,
    shadow: s.boxShadow, maxH: s.maxHeight,
    width: Math.round(el.getBoundingClientRect().width),
  }; };
  const p = panel || {};
  const rs = getComputedStyle(document.documentElement);
  return {
    // 主题诊断：面板材质随主题翻转，若 rootClass 不是预期值，采到的颜色就没有意义
    rootClass: document.documentElement.className,
    ink900: rs.getPropertyValue('--ink-900').trim(),
    theme: rs.getPropertyValue('color-scheme').trim(),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    // 贴边判断：面板宽必须等于挂载容器宽（滚动锁会给 body 加 padding 补偿）
    rootW: Math.round(root.getBoundingClientRect().width),
    bodyPad: getComputedStyle(document.body).paddingRight,
    z: Number(getComputedStyle(root).zIndex),
    scrim: g(scrim),
    panel: g(panel),
    grabber: !!p.querySelector(':scope > .sheet-grabber'),
    closeBtn: !!p.querySelector('button[aria-label="关闭"]'),
    title: p.getAttribute('aria-label'),
  };
})()`);

const clickText = (t) => ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === '${t}');
  if (!b) return 'no-btn'; b.click(); return 'ok';
})()`);
const clickSel = (s) => ev(`(() => { const b = document.querySelector('${s}'); if (!b) return 'no-btn'; b.click(); return 'ok'; })()`);
const closeSheet = () => ev(`(() => { document.querySelector('button[aria-label="关闭"]')?.click(); return 'ok'; })()`);

// 选一本有章节的漫画（阅读器与详情页都要用）
const listRes = await (await fetch(`${BASE}/api/comics?page=1&pageSize=60`)).json();
let comic = null;
for (const it of listRes?.data?.items ?? []) {
  const d = (await (await fetch(`${BASE}/api/comics/${it.id}`)).json())?.data;
  if (d?.chapters?.length) { comic = d; break; }
}
if (!comic) {
  console.log('SKIP  没有可用漫画');
  edge.kill();
  process.exit(0);
}
console.log(`用例漫画：${comic.title}（${comic.chapters.length} 章）`);

/** 打开一个面板并采集；返回 {name, ...probe} */
const openAnd = async (name, act) => {
  const r = await act();
  if (r && r !== 'ok') { console.log(`  ! ${name} 触发失败：${r}`); return null; }
  await sleep(900);
  const s = await probe();
  if (!s) console.log(`  ! ${name} 未采集到面板`);
  return { name, ...(s || {}) };
};

for (const theme of ['light', 'dark']) {
  /*
   * 主题必须两个来源都设：服务端 settings 之外，theme 还持久化在 localStorage，
   * 且启动时会把本地值回写服务端（utils/devicePrefs）。只 put 会被本地值覆盖，
   * 表现为「明明设了 dark，采到的还是浅色」——这个坑会让材质比对全部失真。
   */
  await put({ theme });
  await send('Page.navigate', { url: `${BASE}/libraries` });
  await sleep(1200);
  await ev(`try { localStorage.setItem('fakenews-theme', '${theme}'); } catch (e) {}`);
  await send('Page.navigate', { url: `${BASE}/libraries` });
  await sleep(2000);
  console.log(`\n=== ${theme} ===`);
  const got = [];

  // 0) 先确认主题真的切过去了，否则后面采到的颜色没有意义
  const applied = await ev(`document.documentElement.classList.contains('dark')`);
  ok(applied === (theme === 'dark'), `${theme}：主题已实际应用（html.dark=${applied}）`);

  // 1) 新建漫画库
  got.push(await openAnd('新建漫画库', () => clickText('新建')));
  await closeSheet();
  await sleep(700);

  // 2) 上传（库卡片上的上传按钮，title 以「上传」开头）
  got.push(await openAnd('上传', () => clickSel('button[title^="上传"]')));
  await closeSheet();
  await sleep(700);

  // 3) 编辑信息
  await send('Page.navigate', { url: `${BASE}/comic/${encodeURIComponent(comic.id)}` });
  await sleep(2200);
  got.push(await openAnd('编辑信息', () => clickText('编辑信息')));
  await closeSheet();
  await sleep(700);

  // 4/5) 阅读器：章节 / 阅读设置（先点画面中央唤出 chrome）
  await send('Page.navigate', { url: `${BASE}/read/${encodeURIComponent(comic.id)}/${encodeURIComponent(comic.chapters[0].id)}` });
  await sleep(3200);
  await ev(`(() => { const e = document.elementFromPoint(innerWidth/2, innerHeight/2); (e?.closest('button') || e)?.click?.(); return 1; })()`);
  await sleep(600);
  got.push(await openAnd('章节', () => clickSel('button[aria-label="章节目录"]')));
  await closeSheet();
  await sleep(700);
  await ev(`(() => { const e = document.elementFromPoint(innerWidth/2, innerHeight/2); (e?.closest('button') || e)?.click?.(); return 1; })()`);
  await sleep(600);
  got.push(await openAnd('阅读设置', () => clickSel('button[aria-label="阅读设置"]')));
  await closeSheet();
  await sleep(700);

  const real = got.filter((x) => x && x.panel);
  ok(real.length === 5, `五处面板都打开并采集到（${real.length}/5：${real.map((x) => x.name).join('、')}）`);

  console.log(`    主题诊断 rootClass="${real[0]?.rootClass}" color-scheme=${real[0]?.theme} ink-900=${real[0]?.ink900} body=${real[0]?.bodyBg}`);
  for (const s of real) {
    console.log(`    ${s.name.padEnd(6)} scrim=${s.scrim.bg} ${s.scrim.blur} | panel=${s.panel.bg} ${s.panel.blur} r=${s.panel.radius} maxH=${s.panel.maxH} w=${s.panel.width}`);
  }

  const key = (s) => JSON.stringify([s.scrim.bg, s.scrim.blur, s.panel.bg, s.panel.blur, s.panel.radius, s.panel.maxH]);
  const uniq = [...new Set(real.map(key))];
  ok(uniq.length === 1, `${theme}：五处遮罩+面板材质完全一致`, uniq.join('  ||  '));

  const sh = [...new Set(real.map((s) => s.panel.shadow))];
  ok(sh.length === 1, `${theme}：面板阴影一致`, sh.join(' || '));

  ok(real.every((s) => s.z === LAYER_SHEET), `${theme}：层级都走 --layer-sheet(${LAYER_SHEET})`, real.map((s) => s.z).join(','));
  ok(real.every((s) => s.grabber), `${theme}：都有底部把手`, real.map((s) => `${s.name}:${s.grabber}`).join(','));
  ok(real.every((s) => s.closeBtn), `${theme}：都有 X 关闭按钮`, real.map((s) => `${s.name}:${s.closeBtn}`).join(','));
  // 通栏 = 面板宽度等于挂载容器宽度（不是 innerWidth：滚动锁给 body 补了 padding）
  ok(real.every((s) => s.panel.width === s.rootW), `${theme}：面板贴满容器宽度（无侧边缝隙）`, real.map((s) => `${s.panel.width}/${s.rootW}`).join(','));
  const widths = [...new Set(real.map((s) => s.panel.width))];
  ok(widths.length === 1, `${theme}：五处面板宽度一致（${widths.join(',')}，body padding=${real[0]?.bodyPad}）`);
}

// 顺带确认 ConfirmDialog 的遮罩与面板同口径（圆角/入场不同是有意的）
await put({ theme: 'light' });
await send('Page.navigate', { url: `${BASE}/libraries` });
await sleep(2000);
const delBtn = await clickSel('button[title="删除漫画库"]');
await sleep(900);
const dlg = await ev(`(() => {
  const root = [...document.querySelectorAll('div.fixed.inset-0')].find((d) => d.querySelector('[role="dialog"][aria-modal="true"]'));
  const scrim = root?.querySelector('.scrim');
  const panel = root?.querySelector('[role="dialog"]');
  const s = scrim && getComputedStyle(scrim); const p = panel && getComputedStyle(panel);
  return s && p ? { scrimBg: s.backgroundColor, scrimBlur: s.backdropFilter, panelBg: p.backgroundColor, panelBlur: p.backdropFilter } : null;
})()`);
console.log(`\n=== ConfirmDialog（删除确认）===  ${delBtn}`);
if (dlg) {
  console.log(`    scrim=${dlg.scrimBg} ${dlg.scrimBlur} | panel=${dlg.panelBg} ${dlg.panelBlur}`);
  ok(dlg.scrimBg === 'rgba(0, 0, 0, 0.55)' && dlg.scrimBlur.includes('blur'), '确认弹窗遮罩与 Sheet 同口径', JSON.stringify(dlg));
  ok(dlg.panelBlur.includes('blur'), '确认弹窗面板同样走 .panel-surface 玻璃材质', JSON.stringify(dlg));
} else {
  console.log('  · 未找到删除按钮，跳过确认弹窗比对');
}

// 还原：服务端 settings 之外，localStorage 里的主题也必须还原（否则会把用户
// 的浏览器留在深色——上面为了测 dark 专门写过它）
await put(before);
const origTheme = before?.theme && ['light', 'dark', 'system'].includes(before.theme) ? before.theme : 'light';
await ev(`try { localStorage.setItem('fakenews-theme', '${origTheme}'); } catch (e) {}`);
console.log(`（已还原主题为 ${origTheme}）`);
console.log(`\n${fail === 0 ? 'ALL PASS' : 'HAS FAIL'}  ${pass} passed, ${fail} failed`);
edge.kill();
process.exit(fail === 0 ? 0 : 1);
