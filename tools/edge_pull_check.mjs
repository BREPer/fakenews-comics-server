/**
 * 平移模式「抵住边界」手感探针。
 *
 * 覆盖两件事（都是用户能感知、也最容易做错的地方）：
 *   1. 拖拽中：到整本首/末页后仍能跟手位移（阻尼），被拉开的那一侧有品牌色柔光，
 *      亮度随拉开比例上升（--pull 由 JS 直接写，不经 React）
 *   2. 松手：页面做一次「顶住-回弹」（anim-edge-bump-*）、轨道用 380ms 带过冲的曲线回位、
 *      光带收光、玻璃提示卡出现且带方向图标；轻碰一下（位移不够）则完全不打扰
 *
 * 用法：node tools/edge_pull_check.mjs [--comic=<id>]
 * 依赖本地服务 http://127.0.0.1:13800（只绑 IPv4）。
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
const COMIC = ARG('comic', '8a47483571299bde');
const api = async (p, i) => (await fetch(BASE + p, i)).json();

const detail = (await api(`/api/comics/${COMIC}`)).data;
const chs = detail.chapters ?? [];
if (chs.length < 2) throw new Error('这本书至少要有 2 章才能测「首章往前 / 末章往后」');
const first = chs[0];
const last = chs[chs.length - 1];

const before = (await api('/api/settings')).data;
await api('/api/settings', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  // 不碰主题：阅读器本身是独立的深色层，测试没必要改全局设置（少一个副作用就少一次忘记还原）
  body: JSON.stringify({ readerMode: 'single', pageAnimation: 'pan', readDir: 'ltr', fitMode: 'contain' }),
});

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const PORT = Number(ARG('port', '9655'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-edge-'));
const edge = spawn(
  EDGE,
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=900,800', 'about:blank'],
  { stdio: 'ignore' },
);
let wsUrl;
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = list.find((t) => t.type === 'page');
    if (p) {
      wsUrl = p.webSocketDebuggerUrl;
      break;
    }
  } catch {
    /* 未就绪 */
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
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++seq;
    pend.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
const W = 900;
const H = 800;
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

const SAMPLER = `(() => {
  window.__samples = [];
  window.__rec = (ms) => {
    const t0 = performance.now();
    const tick = () => {
      const track = document.querySelector('.pan-track');
      const glow = document.querySelector('.pan-edge-glow');
      const notice = document.querySelector('.reader-notice');
      const bumpEls = [...document.querySelectorAll('[class]')].filter((el) => String(el.className).includes('edge-bump'));
      const bump = bumpEls[0] || null;
      const bumpCls = bumpEls.map((el) => String(el.className)).join(' | ');
      let pos = null;
      if (track) {
        const m = /matrix\\(([^)]+)\\)/.exec(getComputedStyle(track).transform);
        const tx = m ? Number(m[1].split(',')[4]) : NaN;
        // 轨道宽 300% 容器，tx = -pos/3 * trackW → pos = -tx * 3 / trackW
        pos = Math.round((-tx * 3 / track.clientWidth) * 1000) / 1000;
      }
      window.__samples.push({
        t: Math.round(performance.now() - t0),
        pos,
        pull: glow ? Number(getComputedStyle(glow).opacity) : null,
        pullVar: glow ? glow.style.getPropertyValue('--pull') : null,
        side: glow ? glow.dataset.side : null,
        notice: notice ? notice.textContent.trim() : null,
        icon: notice ? !!notice.querySelector('svg') : false,
        // 注意：这里在模板字符串里，正则的 \w 会被吃掉一层转义，用 includes 更稳
        bump: bump ? (bumpCls.includes('bump-prev') ? 'prev' : bumpCls.includes('bump-next') ? 'next' : 'unknown') : null,
      });
      if (performance.now() - t0 < ms) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  return true;
})()`;

const drag = async (fromX, fromY, dxTotal, steps = 14, holdMs = 0) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y: fromY, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: fromX + (dxTotal * i) / steps,
      y: fromY,
      button: 'left',
      buttons: 1,
    });
    await sleep(16);
  }
  if (holdMs) await sleep(holdMs);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fromX + dxTotal, y: fromY, button: 'left', buttons: 0, clickCount: 1 });
};

const results = [];
const push = (name, ok, detailText) => {
  results.push({ name, ok, detailText });
  console.log(`${ok ? '✓' : '✗'} ${name}${detailText ? ` — ${detailText}` : ''}`);
};

await send('Page.navigate', { url: `${BASE}/read/${COMIC}/${encodeURIComponent(first.id)}?page=0` });
await sleep(2600);
await ev(SAMPLER);

// ---- 1) 首章第 1 页，向右拖（想看上一页 → 整本到头）----
await ev(`window.__rec(1600)`);
await drag(300, 400, 340, 14, 120);
await sleep(900);
const s1 = await ev(`window.__samples`);
const posList = s1.map((x) => x.pos).filter((x) => typeof x === 'number');
const hold = s1.filter((s) => s.side === 'left' && s.pull > 0.05);
const maxPull = Math.max(...s1.map((s) => s.pull ?? 0));
const maxPos = Math.max(...s1.map((s) => s.pos ?? 1));
const noticeAfter = s1.slice(-25).find((s) => s.notice);
const endPos = s1[s1.length - 1]?.pos;
push('拖动中左侧柔光亮起', hold.length > 6, `采样 ${hold.length} 帧带左侧光，最大 opacity=${maxPull.toFixed(2)}`);
push('柔光亮度随拉开量上升', maxPull > 0.55, `--pull 峰值 ${Math.max(...s1.map((s) => Number(s.pullVar) || 0)).toFixed(2)}`);
const minPos = Math.min(...posList);
push('越界位移被阻尼限制在窄缝', minPos < 0.995 && minPos > 0.84, `pos 最小 ${minPos}（1 为居中，被拉开最多 0.165 页宽）`);
push('松手后出现到头提示', !!noticeAfter && s1.some((s) => s.notice === '已经是第一页了'), noticeAfter?.notice ?? '无');
push('提示带方向图标', s1.some((s) => s.icon), '');
push('页面跑了一次回弹动画', s1.some((s) => s.bump === 'prev'), `bump 方向 ${[...new Set(s1.map((s) => s.bump).filter(Boolean))].join('/') || '无'}`);
push('轨道回中', Math.abs(endPos - 1) < 0.01, `末帧 pos=${endPos}`);
push('柔光收光', (s1[s1.length - 1]?.pull ?? 1) < 0.05, `末帧 opacity=${s1[s1.length - 1]?.pull}`);
push('页面没被翻走', (await ev(`Number(new URLSearchParams(location.search).get('page'))`)) === 0, '');

// ---- 2) 轻碰一下（位移不够）：不该弹提示 ----
await sleep(1600); // 先让上一条提示自然消失，否则会误判成"轻碰也弹"
await ev(`window.__samples = []; window.__rec(900)`);
await drag(300, 400, 24, 6, 60);
await sleep(700);
const s2 = await ev(`window.__samples`);
push('轻碰不打扰（无提示）', !s2.some((s) => s.notice), `hasNotice=${s2.some((s) => s.notice)}`);

// ---- 3) 末章最后一页，向左拖（想看下一页 → 整本到头）----
await send('Page.navigate', { url: `${BASE}/read/${COMIC}/${encodeURIComponent(last.id)}?page=${Math.max(0, (last.pageCount || 1) - 1)}` });
await sleep(2200);
await ev(SAMPLER);
await ev(`window.__rec(1600)`);
await drag(600, 400, -340, 14, 120);
await sleep(900);
const s3 = await ev(`window.__samples`);
push('拖动中右侧柔光亮起', s3.filter((s) => s.side === 'right' && s.pull > 0.05).length > 6, '');
push('提示文案为「最后一页」', s3.some((s) => s.notice === '已经是最后一页了'), s3.find((s) => s.notice)?.notice ?? '无');
push('页面回弹方向为 next', s3.some((s) => s.bump === 'next'), '');

// ---- 4) 章末还有下一章时：不应出现「到头」提示，而是换章 ----
await send('Page.navigate', { url: `${BASE}/read/${COMIC}/${encodeURIComponent(first.id)}?page=${Math.max(0, (first.pageCount || 1) - 1)}` });
await sleep(2200);
await ev(SAMPLER);
await ev(`window.__samples = []; window.__rec(2200)`);
await drag(600, 400, -340, 14, 120);
await sleep(1500);
const s4 = await ev(`window.__samples`);
const crossed = await ev(`(() => document.querySelector('header p:last-child')?.textContent?.trim() || '')()`);
push('有下一章时走换章（不误报到头）', !s4.some((s) => s.notice === '已经是最后一页了') && s4.some((s) => s.notice), `提示=${s4.find((s) => s.notice)?.notice ?? '无'} / 头部=${crossed}`);

// ---- 截图：拖到一半时定格 ----
await send('Page.navigate', { url: `${BASE}/read/${COMIC}/${encodeURIComponent(first.id)}?page=0` });
await sleep(2200);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 300, y: 400, button: 'left', buttons: 1, clickCount: 1 });
for (let i = 1; i <= 12; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300 + (330 * i) / 12, y: 400, button: 'left', buttons: 1 });
  await sleep(16);
}
fs.mkdirSync(path.resolve('_shots'), { recursive: true });
const shotPull = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.resolve('_shots', 'edge-pull-held.png'), Buffer.from(shotPull.data, 'base64'));
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 630, y: 400, button: 'left', buttons: 0, clickCount: 1 });
await sleep(180);
const shotBump = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.resolve('_shots', 'edge-pull-release.png'), Buffer.from(shotBump.data, 'base64'));
console.log('\n截图：_shots/edge-pull-held.png（拖动中）/_shots/edge-pull-release.png（松手后）');

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
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {
  /* 忽略 */
}

const bad = results.filter((r) => !r.ok);
console.log(bad.length === 0 ? '\n全部通过' : `\n${bad.length} 项未通过`);
process.exit(bad.length === 0 ? 0 : 1);
