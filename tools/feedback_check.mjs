/**
 * 交互反馈层实测（CDP，390×844）：轻提示 / 撤销 / 弹层键盘 / 阅读记录分页。
 *
 * 这几项都是「用户能立刻感觉到」的东西，而且以前全是缺的：
 *   1. 收藏、保存元数据、清缓存等操作**没有任何回执**（点了没反应）
 *   2. 删除阅读记录**不可撤销**，而它删的是阅读进度
 *   3. 弹层按 Esc 关不掉、焦点不进面板（键盘/读屏用户被挡在外面）
 *   4. 阅读记录只显示最新 100 条，更早的没有入口
 *
 * 用法：node tools/feedback_check.mjs [--base=http://127.0.0.1:13800]
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
const THEME = ARG('theme', 'light');
const PORT = 9795;

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) { console.error('未找到 Edge'); process.exit(2); }
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ux-'));
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
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
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

/** 轮询等待某个表达式为真（比固定 sleep 稳，页面渲染快慢不影响结论） */
async function waitFor(expr, timeout = 8000, step = 120) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await ev(expr)) return true;
    await sleep(step);
  }
  return false;
}

/** 真实按键（Esc 之类必须走 Input 域，Runtime 里 dispatchEvent 不算用户手势） */
async function key(k, code, vk) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
const { injectPrefs } = await import('./lib/prefs.mjs');
await injectPrefs(send, { theme: THEME });

// 取一部有章节的漫画
const list = await (await fetch(`${BASE}/api/comics?pageSize=1`)).json();
const comicId = list.data.items[0].id;

// ---------- 1. 收藏 → 成功提示 → 自动消失 ----------
await send('Page.navigate', { url: `${BASE}/comic/${comicId}` });
await sleep(2200);
const favBefore = await ev(`document.body.innerText.includes('已收藏')`);
await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /^已?收藏$/.test(x.textContent.trim()));
  b?.click();
  return !!b;
})()`);
let toastText = '';
for (let i = 0; i < 20; i++) {
  await sleep(150);
  toastText = (await ev(`document.querySelector('[data-toast]')?.innerText ?? ''`)) || '';
  if (toastText) break;
}
check('收藏后出现提示', /收藏/.test(toastText), toastText.replace(/\n/g, ' / ').slice(0, 40) || '(无)');
// 收起（回到原状态，别把夹具改了）
await sleep(2600);
const gone = !(await ev(`!!document.querySelector('[data-toast]')`));
check('提示会自动消失', gone, '');
if (!favBefore) {
  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^已?收藏$/.test(x.textContent.trim()));
    b?.click();
  })()`);
  await sleep(800);
}

// ---------- 2. 弹层：aria / 焦点 / Esc ----------
await send('Page.navigate', { url: `${BASE}/comic/${comicId}` });
await sleep(1800);
await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('编辑信息'))?.click()`);
await sleep(500);
const dlg = await ev(`(() => {
  const d = document.querySelector('[role="dialog"]');
  if (!d) return null;
  return {
    modal: d.getAttribute('aria-modal'),
    label: d.getAttribute('aria-label'),
    focusInside: d.contains(document.activeElement),
    active: document.activeElement?.textContent?.trim().slice(0, 12) ?? '',
  };
})()`);
check('弹层有 dialog 语义', dlg?.modal === 'true' && !!dlg?.label, JSON.stringify(dlg));
check('打开后焦点进入弹层', dlg?.focusInside === true, dlg?.active ?? '');
await key('Escape', 'Escape', 27);
await sleep(600);
check('Esc 可关闭弹层', !(await ev(`!!document.querySelector('[role="dialog"]')`)), '');

// ---------- 3. 确认框：初始焦点在「取消」、Esc 取消 ----------
// 必须挑一部**有进度**的漫画：重置进度的按钮只在有进度时渲染，否则这一步会「什么都没打开却假通过」
const hist = await (await fetch(`${BASE}/api/history?limit=1`)).json();
const comicWithProgress = hist.data.items[0].id;
await send('Page.navigate', { url: `${BASE}/comic/${comicWithProgress}` });
await sleep(1800);
await ev(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('重置进度'))?.click()`);
await waitFor(`!!document.querySelector('[role="dialog"]')`, 4000);
await sleep(300);
const confirmFocus = await ev(`document.activeElement?.textContent?.trim().slice(0, 8) ?? ''`);
const confirmOpen = await ev(`!!document.querySelector('[role="dialog"]')`);
check('确认框能打开', confirmOpen === true, `焦点=${confirmFocus}`);
check('确认框初始焦点在「取消」', /取消/.test(confirmFocus ?? ''), confirmFocus ?? '');
await key('Escape', 'Escape', 27);
await sleep(500);
check('Esc 可取消确认框', !(await ev(`!!document.querySelector('[role="dialog"]')`)), '');

// ---------- 4. 阅读记录分页 + 删除撤销 ----------
await send('Page.navigate', { url: `${BASE}/shelf` });
await waitFor(`document.querySelectorAll('ul.card > li').length >= 1`, 12000);
const headText = (await ev(`[...document.querySelectorAll('h1')].map((h) => h.innerText).join(' | ')`)) || '';
const total = Number((/阅读记录\s*\((\d+)/.exec(headText) ?? [])[1] ?? 0);
const firstCount = (await ev(`document.querySelectorAll('ul.card > li').length`)) || 0;
check('记录总数来自服务端 total', total > 0, `total=${total} 标题="${headText.slice(0, 40)}"`);
check('首屏只渲染一页（30 条）', firstCount === 30, `实际 ${firstCount}`);

for (let i = 0; i < 8; i++) {
  await ev(`window.scrollTo(0, document.documentElement.scrollHeight)`);
  await sleep(800);
  const n = (await ev(`document.querySelectorAll('ul.card > li').length`)) || 0;
  if (n >= total) break;
}
const allCount = (await ev(`document.querySelectorAll('ul.card > li').length`)) || 0;
check('滚到底能拿到全部记录（>100 也可达）', allCount === total, `${allCount}/${total}`);

// 删第一条 → 撤销
const firstName = await ev(`document.querySelector('ul.card > li p')?.textContent?.trim() ?? ''`);
await ev(`document.querySelector('ul.card > li button[aria-label^="删除"]')?.click()`);
let undoText = '';
for (let i = 0; i < 20; i++) {
  await sleep(150);
  undoText = (await ev(`document.querySelector('[data-toast]')?.innerText ?? ''`)) || '';
  if (/撤销/.test(undoText)) break;
}
check('删除后给出可撤销提示', /撤销/.test(undoText), undoText.replace(/\n/g, ' / ').slice(0, 50) || '(无)');
try {
  fs.mkdirSync(path.resolve('_shots'), { recursive: true });
  const png = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.resolve('_shots', 'toast_undo.png'), Buffer.from(png.data, 'base64'));
  console.log('      saved _shots/toast_undo.png');
} catch { /* ignore */ }
await ev(`[...document.querySelectorAll('[data-toast] button')].find((b) => b.textContent.includes('撤销'))?.click()`);
await sleep(1800);
// 撤销成功会再弹一条「阅读记录已恢复」，所以这里只看记录本身有没有回来 + 总数
const backAgain = await ev(`document.body.innerText.includes(${JSON.stringify(firstName)})`);
check('撤销后记录回来了', backAgain === true, firstName);
const headAfter = (await ev(`[...document.querySelectorAll('h1')].map((h) => h.innerText).join(' | ')`)) || '';
const totalAfter = Number((/阅读记录\s*\((\d+)/.exec(headAfter) ?? [])[1] ?? 0);
check('撤销后总数回到原值', totalAfter === total, `${totalAfter}/${total}`);

// ---------- 5. 设置页清缓存给回执 ----------
await send('Page.navigate', { url: `${BASE}/settings` });
const hasClear = await waitFor(
  `!![...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '清理')`,
  12000,
);
await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '清理');
  b?.click();
})()`);
let cacheToast = '';
for (let i = 0; i < 40; i++) {
  await sleep(200);
  cacheToast = (await ev(`document.querySelector('[data-toast]')?.innerText ?? ''`)) || '';
  if (cacheToast) break;
}
check('清缓存有「已释放」回执', hasClear && /已清理|失败/.test(cacheToast),
  cacheToast.replace(/\n/g, ' / ').slice(0, 40) || `未找到清理按钮=${!hasClear}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
ws.close();
edge.kill();
await sleep(300);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed.length ? 1 : 0);
