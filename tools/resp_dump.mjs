/**
 * 辅助诊断：列出某个视口某页面上「可点元素」的尺寸明细，用来判断
 * tools/responsive_check.mjs 报的热区偏小到底是哪些控件。
 *
 *   node tools/resp_dump.mjs --w=390 --h=844 --route=/settings [--min=32]
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
const BASE = ARG('base', 'http://127.0.0.1:13800').replace(/\/$/, '');
const W = Number(ARG('w', 390));
const H = Number(ARG('h', 844));
const ROUTE = ARG('route', '/settings');
const MIN = Number(ARG('min', 32));

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const PORT = 9634;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-dump-'));
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
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: true });
await send('Page.navigate', { url: BASE + ROUTE });
await sleep(1600);

const MODE = ARG('mode', 'taps');

if (MODE === 'css') {
  // 桌面（fine）与触屏（coarse）下同一批控件的实际高度对比：确认加码只作用在触屏
  const probeBtn = async () => ev(`(() => {
    const pick = (sel) => { const e = document.querySelector(sel); if (!e) return null;
      const r = e.getBoundingClientRect(); const af = getComputedStyle(e, '::after');
      return Math.round(r.height) + 'px / 命中区 ' + Math.round(Math.max(r.height, parseFloat(af.height) || 0)) + 'px'; };
    return { coarse: matchMedia('(pointer: coarse)').matches, btn: pick('.btn-ghost, .btn-primary'), chip: pick('.chip-on, .chip-off'), input: pick('.input') };
  })()`);
  for (const [label, mobileFlag] of [['fine（鼠标）', false], ['coarse（触屏）', true]]) {
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: mobileFlag });
    await send('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'pointer', value: mobileFlag ? 'coarse' : 'fine' }, { name: 'any-pointer', value: mobileFlag ? 'coarse' : 'fine' }] });
    await send('Page.navigate', { url: BASE + ROUTE });
    await sleep(1200);
    await send('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'pointer', value: mobileFlag ? 'coarse' : 'fine' }, { name: 'any-pointer', value: mobileFlag ? 'coarse' : 'fine' }] });
    await send('Emulation.setTouchEmulationEnabled', { enabled: mobileFlag, maxTouchPoints: mobileFlag ? 5 : 0 });
    await sleep(400);
    const r = await probeBtn();
    console.log(`${label.padEnd(14)} pointer:coarse=${String(r.coarse).padEnd(5)} .btn=${r.btn}   .chip=${r.chip}   .input=${r.input}`);
  }
} else if (MODE === 'shot') {
  // 全页截图（触屏形态 + 超视口捕获），文件名带视口尺寸
  // --clip=y0,y1  只截页面该纵向区间（scale 2x 放大，看细节）
  await send('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }] });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await sleep(700);
  const clipArg = ARG('clip', '');
  let shot;
  let suffix = '';
  if (clipArg) {
    // 滚动到 y0 后截真实视口（fixed 元素位置才正确；captureBeyondViewport 会把
    // fixed 底栏画在页面坐标 y≈vh-60 处形成假遮挡）
    const y0 = Number(clipArg.split(',')[0]);
    await ev(`window.scrollTo(0, ${y0})`);
    await sleep(500);
    const real = await ev(`Math.round(scrollY)`);
    shot = await send('Page.captureScreenshot', { format: 'png' });
    suffix = `-scroll${real}`;
  } else {
    shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  }
  const dir = path.resolve('_shots');
  fs.mkdirSync(dir, { recursive: true });
  const name = ROUTE.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'page';
  const file = path.join(dir, `${name}-${W}x${H}${suffix}.png`);
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  const info = await ev(`(() => {
    const de = document.documentElement;
    return { pageH: de.scrollHeight, vh: innerHeight, coarse: matchMedia('(pointer: coarse)').matches };
  })()`);
  console.log(`saved: ${file}  页高 ${info.pageH}px / 视口 ${info.vh}px  pointer:coarse=${info.coarse}`);
} else if (MODE === 'at') {
  // 给定坐标往上查血缘：看到底是谁在点住手指
  const [px, py] = ARG('at', '0,0').split(',').map(Number);
  const chain = await ev(`(() => {
    const out = [];
    let e = document.elementFromPoint(${px}, ${py});
    while (e && out.length < 6) {
      const r = e.getBoundingClientRect();
      out.push(e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).replace(/\\s+/g, ' ').slice(0, 44) : '') + ' [' + Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width) + 'x' + Math.round(r.height) + ']');
      e = e.parentElement;
    }
    return out;
  })()`);
  console.log(`(${px},${py}) →`);
  chain.forEach((c, i) => console.log(`  ${i === 0 ? '命中' : '父'}${i}  ${c}`));
} else if (MODE === 'rows') {
  // 设置页「标签 + 控件」行：是否被挤到换行/文字被截断
  const rows = await ev(`(() => {
    const out = [];
    for (const card of document.querySelectorAll('.card')) {
      for (const row of card.children) {
        const kids = [...row.children];
        if (kids.length !== 2) continue;
        const [label, ctrl] = kids.map((k) => k.getBoundingClientRect());
        const p = row.querySelector('p');
        out.push({
          t: (row.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 14),
          rowH: Math.round(row.getBoundingClientRect().height),
          labelW: Math.round(label.width), labelH: Math.round(label.height),
          ctrlW: Math.round(ctrl.width), ctrlRight: Math.round(ctrl.right),
          gap: Math.round(ctrl.left - label.right),
          pLines: p ? Math.round(p.getBoundingClientRect().height / parseFloat(getComputedStyle(p).lineHeight || '16')) : 0,
          clipped: p ? p.scrollWidth > p.clientWidth + 1 : false,
        });
      }
    }
    return out;
  })()`);
  console.log(`${W}x${H}  ${ROUTE}   设置行数 ${rows.length}\n`);
  for (const r of rows) {
    // 控件换行到下一行是预期行为（gap 为负），真正的问题是标签被挤换行或被截断
    const wrapped = r.gap < 0 || r.ctrlRight <= r.labelW + 8;
    const bad = r.pLines > 1 || r.clipped;
    console.log(`${bad ? '✗' : '✓'} h=${String(r.rowH).padStart(3)} 标签 ${r.labelW}x${r.labelH} ${r.pLines}行${r.clipped ? '截断' : ''}${wrapped ? ' 控件换行' : ''}  「${r.t}」`);
  }
} else {
  const list = await ev(`(() => {
  const out = [];
  for (const el of document.querySelectorAll('button, a[href], input, select, [role="button"], [role="tab"], label')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    out.push({
      el: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      tag: (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 18),
      cls: String(el.className).replace(/\\s+/g, ' ').slice(0, 58),
      w: Math.round(r.width), h: Math.round(r.height),
      x: Math.round(r.left), y: Math.round(r.top),
      own: (() => {
        const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!t) return 'null';
        if (el.contains(t) || t === el || t.contains(el)) return 'self';
        const tr = t.getBoundingClientRect();
        return t.tagName.toLowerCase() + '(' + Math.round(tr.left) + ',' + Math.round(tr.top) + ',' + Math.round(tr.width) + 'x' + Math.round(tr.height) + ')';
      })(),
    });
  }
  return out;
})()`);

  const small = list.filter((x) => x.h < MIN || x.w < MIN);
  console.log(`${W}x${H}  ${ROUTE}   可点元素 ${list.length} 个，其中高或宽 < ${MIN}px 的 ${small.length} 个：\n`);
  for (const s of small) {
  const tip = s.own === 'self' ? '' : ` 命中→ ${s.own}`;
  console.log(`  ${String(s.h).padStart(3)}x${String(s.w).padStart(4)} @(${String(s.x).padStart(4)},${String(s.y).padStart(4)})  <${s.el}${s.type ? ' type=' + s.type : ''}>  「${s.tag}」${tip}  .${s.cls}`);
}
}

ws.close();
edge.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
