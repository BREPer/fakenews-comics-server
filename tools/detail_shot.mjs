/**
 * 一次性：截若干本漫画的详情页，核对「详情页 UI 是否随封面变化」。
 * 用法：node tools/detail_shot.mjs --tag=before --theme=light --w=1440 --h=900
 * 输出：_shots/detail-<id>-<tag>.png，并打印每本的封面尺寸 / 封面容器尺寸 / 首屏几何。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { injectPrefs } from './lib/prefs.mjs';

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
const THEME = ARG('theme', 'light');
const W = Number(ARG('w', 1440));
const H = Number(ARG('h', 900));
const TAG = ARG('tag', 'x');
const ACCENT = ARG('accent', '');
const GRID = process.argv.includes('--grid');
const ZOOM = Number(ARG('zoom', 2));
const ONLY = ARG('ids', '');
const api = async (p, i) => (await fetch(BASE + p, i)).json();
// 主题/高亮色按设备存在 localStorage（服务端 PUT 已被静默忽略），导航前注入
const PREFS = ACCENT ? { theme: THEME, accent: ACCENT } : { theme: THEME };

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const PORT = 9611;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-detail-'));
const edge = spawn(
  EDGE,
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', `--window-size=${W},${H}`, 'about:blank'],
  { stdio: 'ignore' },
);
let wsUrl;
for (let i = 0; i < 80; i++) {
  try {
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = t.find((x) => x.type === 'page');
    if (p) {
      wsUrl = p.webSocketDebuggerUrl;
      break;
    }
  } catch {
    /* */
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
const send = (m, p = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })); });
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
};
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 640 });
await injectPrefs(send, PREFS);
fs.mkdirSync(path.resolve('_shots'), { recursive: true });

const list = (await api('/api/comics?pageSize=50')).data.items;
const picks = ONLY ? list.filter((c) => ONLY.split(',').includes(c.id)) : list.filter((c) => !/perf/i.test(c.title));

for (const c of picks) {
  await send('Page.navigate', { url: `${BASE}/comic/${c.id}` });
  await sleep(2400);
  const geo = await evaluate(`(() => {
    const img = document.querySelector('[class*="media-frame"] img');
    const box = document.querySelector('[class*="media-frame"]');
    const r = box ? box.getBoundingClientRect() : null;
    const glow = document.querySelector('[aria-hidden="true"]');
    const cs = glow ? getComputedStyle(glow) : null;
    return {
      natural: img ? [img.naturalWidth, img.naturalHeight] : null,
      cover: r ? [Math.round(r.width), Math.round(r.height), Math.round(r.top)] : null,
      titleTop: (() => { const h = document.querySelector('h1'); return h ? Math.round(h.getBoundingClientRect().top) : null; })(),
      sectionTop: (() => { const s = document.querySelector('section'); return s ? Math.round(s.getBoundingClientRect().top) : null; })(),
      docH: document.documentElement.scrollHeight,
      glowOpacity: cs ? cs.opacity : null,
      glowFilter: cs ? cs.filter : null,
    };
  })()`);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const file = path.resolve('_shots', `detail-${c.id}-${TAG}.png`);
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log(c.title.padEnd(22), JSON.stringify(geo));

  // --grid：切到「四格」章节视图并把章节区放大 2x 截一张，用来核对已读/在读的标识细节
  if (GRID) {
    await evaluate(`localStorage.setItem('fn:detailChapterView','grid')`);
    await send('Page.reload');
    await sleep(2200);
    const rect = await evaluate(`(() => {
      const s = document.querySelector('section');
      if (!s) return null;
      s.scrollIntoView({ block: 'center' });
      const r = s.getBoundingClientRect();
      return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top + window.scrollY - 8), w: r.width + 16, h: Math.min(r.height + 16, 320) };
    })()`);
    await sleep(350);
    const full = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.resolve('_shots', `detail-grid-full-${c.id}-${TAG}.png`), Buffer.from(full.data, 'base64'));
    const zoom = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: ZOOM },
    });
    const zfile = path.resolve('_shots', `detail-grid-${c.id}-${TAG}.png`);
    fs.writeFileSync(zfile, Buffer.from(zoom.data, 'base64'));
    console.log('  grid →', path.basename(zfile));
  }
}

// 偏好只在本机（临时 profile），无需还原服务端
ws.close();
edge.kill();
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {
  /* */
}
