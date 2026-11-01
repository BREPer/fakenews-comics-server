/**
 * 诊断：平移翻页（pageAnimation=pan）逐帧采样。
 *
 * 做法：真实点击右侧翻页，同时在页面里用 rAF 连续记录
 *   - .pan-track 的 transform（换算成槽位值 pos）
 *   - 每个槽位的 data-page 与其中 img 的当前 src 索引
 *   - 有无空槽 / 图片未加载
 * 用来判断「先跳到一半再滑」「翻页过程中露黑」「图与槽位对不上」这类异常。
 *
 * 用法：node tools/pan_anim_check.mjs [--base ...] [--clicks 4] [--drag]
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
const CLICKS = Number(ARG('clicks', '4'));
const api = async (p, init) => (await fetch(BASE + p, init)).json();

let target = null;
for (const c of (await api('/api/comics?pageSize=50')).data.items) {
  const d = (await api(`/api/comics/${c.id}`)).data;
  const chs = d.chapters ?? [];
  if (chs.length >= 1 && chs[0].pageCount >= 8) { target = { ...d, chapters: chs }; break; }
}
if (!target) throw new Error('找不到「首章 ≥8 页」的漫画：先跑 node tools/perf_fixture.mjs');

const before = (await api('/api/settings')).data;
await api('/api/settings', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ readerMode: 'single', pageAnimation: 'pan', readDir: 'ltr', fitMode: 'contain' }),
});

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const PORT = Number(ARG('port', '9536'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-panim-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--window-size=1200,800', 'about:blank',
], { stdio: 'ignore' });

let wsUrl;
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = list.find((t) => t.type === 'page');
    if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch { /* 未就绪 */ }
  await sleep(150);
}
if (!wsUrl) { edge.kill(); throw new Error('Edge 调试端口未就绪'); }

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
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });

const ch = target.chapters[0];
const url = (img) => `${BASE}/read/${target.id}/${encodeURIComponent(ch.id)}?page=${img}`;
let failed = 0;

/** 注入采样器：点一下开始记录 700ms */
const INJECT = `(() => {
  window.__samples = [];
  window.__rec = (ms) => {
    const t0 = performance.now();
    const tick = () => {
      const track = document.querySelector('.pan-track');
      const slots = [...document.querySelectorAll('.pan-slot')];
      if (track) {
        const m = /matrix\\(([^)]+)\\)/.exec(getComputedStyle(track).transform);
        const tx = m ? Number(m[1].split(',')[4]) : NaN;
        window.__samples.push({
          t: Math.round(performance.now() - t0),
          // 轨道平移百分比：-33.3% = 中间槽位居中
          pct: Math.round((tx / track.clientWidth) * 3000) / 10,
          pages: slots.map((s) => {
            const img = s.querySelector('img');
            const mm = img ? /\\/pages\\/(\\d+)/.exec(img.currentSrc || img.src || '') : null;
            return { d: s.dataset.page, img: mm ? +mm[1] : -1, op: img ? getComputedStyle(img).opacity : '' };
          }),
        });
      }
      if (performance.now() - t0 < ms) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  return true;
})()`;

await send('Page.navigate', { url: url(0) });
await sleep(2500);
await ev(INJECT);

const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
};

for (let i = 0; i < CLICKS; i++) {
  const before = await ev(`Number(new URLSearchParams(location.search).get('page'))`);
  await ev(`window.__samples = []; window.__rec(700); true`);
  await click(1100, 400); // 右侧 30% → 下一页
  await sleep(850);
  const after = await ev(`Number(new URLSearchParams(location.search).get('page'))`);
  const samples = await ev(`window.__samples`);
  console.log(`\n=== 第 ${i + 1} 次点击：图 ${before} → ${after} ===`);
  // 打印关键帧：只打印 pct 变化超过 1% 的帧，避免刷屏
  let last = null;
  for (const s of samples) {
    const key = s.pct;
    if (last === null || Math.abs(key - last) >= 1 || s.pages.some((p) => p.img < 0)) {
      console.log(`  t=${String(s.t).padStart(3)}ms pct=${String(s.pct).padStart(7)}%  ` +
        s.pages.map((p) => `[slot${p.d}:  页${p.img} op=${p.op}]`).join(' '));
      last = key;
    }
  }
  console.log(`  末帧：${JSON.stringify(samples[samples.length - 1])}`);
}

// ---- 快速连点：动画未结束就继续翻，检查最终停位与 URL 是否一致 ----
const beforeBurst = await ev(`Number(new URLSearchParams(location.search).get('page'))`);
for (let i = 0; i < 3; i++) {
  await click(1100, 400);
  await sleep(90); // 远小于 260ms 的动画时长
}
await sleep(900);
const st = await ev(`(() => {
  const track = document.querySelector('.pan-track');
  const tx = track ? Number(/matrix\\(([^)]+)\\)/.exec(getComputedStyle(track).transform)[1].split(',')[4]) : NaN;
  const slot1 = document.querySelector('.pan-slot[data-slot="1"]');
  const img = slot1?.querySelector('img');
  const m = img ? /\\/pages\\/(\\d+)/.exec(img.currentSrc || img.src || '') : null;
  return {
    page: Number(new URLSearchParams(location.search).get('page')),
    slotPage: slot1 ? Number(slot1.dataset.page) : null,
    img: m ? +m[1] : -1,
    trackPct: track ? Math.round((tx / track.clientWidth) * 3000) / 10 : NaN,
  };
})()`);
console.log(`\n=== 快速连点 3 次：图 ${beforeBurst} → ${st.page} ===`);
console.log('  末态：', JSON.stringify(st));
if (st.slotPage !== st.page || st.img !== st.page || Math.abs(st.trackPct + 100) > 2) {
  console.log('  ✗ 连点后停位不一致（轨道未回中 / 槽位与 URL 不符）');
  failed++;
} else {
  console.log('  ✓ 连点后轨道回中、槽位与 URL 一致');
}

await api('/api/settings', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    readerMode: before.readerMode,
    pageAnimation: before.pageAnimation,
    readDir: before.readDir,
    fitMode: before.fitMode,
  }),
}).catch(() => {});
ws.close();
edge.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
