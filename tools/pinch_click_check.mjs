/**
 * 阅读器双指缩放 × 单击 交互探针
 *
 * 覆盖两条回归：
 *   1. 开启「双指缩放」后，普通单击仍能呼出/收起工具栏（曾因 gestureEndAt 在每次
 *      手指抬起都刷新，导致紧随的 click 被 350ms 窗口吞掉而完全失效）
 *   2. 真手势（双指缩放 / 放大后拖动）松手不会误翻页；放大态单击只切工具栏不翻页
 *
 *   node tools/pinch_click_check.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { injectPrefs } from './lib/prefs.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = 'http://127.0.0.1:13800';
const W = 390, H = 844;

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const PORT = 9672;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-pinch-'));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });

let wsUrl;
for (let i = 0; i < 80; i++) {
  try { const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = t.find((x) => x.type === 'page'); if (p) { wsUrl = p.webSocketDebuggerUrl; break; } } catch { /* 等 */ }
  await sleep(150);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
const send = (m, p = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.value;

let pass = 0, fail = 0;
const ok = (cond, msg, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ ${msg}  ${extra}`); } };

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: true });
await send('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }] });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

// ---------- 准备：拿一本多页漫画 ----------
const comics = await (await fetch(`${BASE}/api/comics?pageSize=20`)).json();
const c = comics.data.items.find((x) => (x.pageCount || 0) >= 5) ?? comics.data.items[0];
const detail = (await (await fetch(`${BASE}/api/comics/${c.id}`)).json()).data;
const ch = detail.chapters.find((x) => (x.pageCount || 0) >= 5) ?? detail.chapters[0];

// 开启双指缩放：偏好按设备存在 localStorage（服务端 PUT 已被静默忽略），导航前注入

// 章节 id 自带页码后缀（形如 <id>#0），直接编码即可，不要再拼 %230
const URL0 = `${BASE}/read/${c.id}/${encodeURIComponent(ch.id)}`;
await injectPrefs(send, { pinchZoom: true, readerMode: 'single' });
await send('Page.navigate', { url: URL0 });
await sleep(2200);

// ---------- 工具 ----------
const touch = (type, pts) => send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p[0], y: p[1], id: i })) });
const chromeOn = () => ev(`(() => { const h = document.querySelector('header'); if (!h) return null; const s = getComputedStyle(h); return s.opacity !== '0' && s.visibility !== 'hidden'; })()`);
// 页码以底部工具栏的「当前/总数」文本为准：章节 id 里的 #0 是路径的一部分，
// location.hash 恒为空，用它判断翻页会得到恒 0 的假通过
const pageOf = () => ev(`(() => { const f = document.querySelector('footer'); if (!f) return -1; const m = (f.innerText || '').match(/(\\d+)\\s*\\/\\s*(\\d+)/); return m ? Number(m[1]) : -1; })()`);
const scaleOf = () => ev(`(() => { const el = [...document.querySelectorAll('[style*=scale]')].find((e) => /scale\\(/.test(e.style.transform || '')); if (!el) return 1; const m = el.style.transform.match(/scale\\(([\\d.]+)/); return m ? Number(m[1]) : 1; })()`);
// 单击必须用鼠标事件：headless 下 dispatchTouchEvent 不会合成 click，React onClick 收不到
const tap = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(40);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(300);
};

console.log(`\n=== 阅读器 双指缩放 × 单击（${c.title} / ${ch.title}） ===`);
console.log(`  url=${await ev('location.href')}  header=${await ev("!!document.querySelector('header')")}  img=${await ev("!!document.querySelector('img')")}`);

// 开屏默认工具栏可见
ok(await chromeOn(), '打开阅读器时工具栏可见');

// 1) 单击 → 收起
await tap(W / 2, H / 2);
const afterTap1 = await chromeOn();
ok(afterTap1 === false, '单击后工具栏收起（单击生效）', `chromeOn=${afterTap1}`);

// 2) 再单击 → 呼出
await tap(W / 2, H / 2);
const afterTap2 = await chromeOn();
ok(afterTap2 === true, '再次单击工具栏呼出（可反复切换）', `chromeOn=${afterTap2}`);

// 3) 未放大时单击右侧 → 翻页（证明单击不只切工具栏）
const p0 = await pageOf();
await tap(W * 0.9, H / 2);
await sleep(600);
const p1 = await pageOf();
ok(p0 > 0 && p1 === p0 + 1, '未放大时点右侧翻到下一页', `page ${p0} -> ${p1}`);

// 4) 双指张开 → 放大，且不翻页
const cx = W / 2, cy = H / 2;
await touch('touchStart', [[cx - 40, cy], [cx + 40, cy]]);
for (let d = 50; d <= 140; d += 15) {
  await touch('touchMove', [[cx - d, cy], [cx + d, cy]]);
  await sleep(40);
}
await touch('touchEnd', []);
await sleep(400);
const sc = await scaleOf();
const p2 = await pageOf();
ok(sc > 1.2, `双指张开生效，scale=${sc.toFixed(2)}`);
ok(p2 === p1, '缩放手势松手后没有误翻页', `page=${p2} (期望 ${p1})`);

// 5) 放大态单击 → 只切工具栏，不翻页
const before = await chromeOn();
await tap(W / 2, H / 2);
await sleep(400);
const afterTap3 = await chromeOn();
const p3 = await pageOf();
ok(afterTap3 !== before, '放大态单击切换了工具栏', `before=${before} after=${afterTap3}`);
ok(p3 === p2, '放大态单击没有翻页', `page=${p3} (期望 ${p2})`);

// 6) 放大态拖动 → 松手不翻页
await touch('touchStart', [[cx, cy]]);
for (let i = 1; i <= 6; i++) { await touch('touchMove', [[cx - i * 12, cy]]); await sleep(35); }
await touch('touchEnd', []);
await sleep(400);
const p4 = await pageOf();
ok(p4 === p2, '放大态拖动查看后松手没有翻页', `page=${p4} (期望 ${p2})`);

// 7) 关闭缩放开关后单击仍正常（回归）
await ev(`(() => { const s = JSON.parse(localStorage.getItem('fakenews-settings') || '{}'); return true; })()`);
await fetch(`${BASE}/api/settings`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...(await (await fetch(`${BASE}/api/settings`)).json()).data, pinchZoom: false }),
});
await send('Page.navigate', { url: URL0 });
await sleep(2000);
const b1 = await chromeOn();
await tap(W / 2, H / 2);
const b2 = await chromeOn();
ok(b1 === true && b2 === false, '关闭缩放开关后单击切换工具栏仍正常', `before=${b1} after=${b2}`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close();
edge.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(fail ? 1 : 0);
