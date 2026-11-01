/** 一次性：截三种高亮色下的首页/详情页，人眼核对（不影响功能断言）。 */
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
const ARG = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = (ARG('base', 'http://127.0.0.1:13800')).replace(/\/$/, '');
const THEME = ARG('theme', 'light');
const W = Number(ARG('w', 1440));
const H = Number(ARG('h', 900));
const TAG = ARG('tag', '');
const api = async (p, i) => (await fetch(BASE + p, i)).json();
// 主题/高亮色按设备存在 localStorage（服务端 PUT 已被静默忽略），导航前注入

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const PORT = 9597;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-accent2-'));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
let wsUrl;
for (let i = 0; i < 80; i++) {
  try { const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = t.find((x) => x.type === 'page'); if (p) { wsUrl = p.webSocketDebuggerUrl; break; } } catch { /* */ }
  await sleep(150);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
const send = (m, p = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })); });
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 640 });
fs.mkdirSync(path.resolve('_shots'), { recursive: true });

const list = (await api('/api/comics?pageSize=50')).data.items;
const comic = list.find((c) => !/perf/i.test(c.title)) ?? list[0];

for (const accent of ['sora', 'bean']) {
  for (const [name, url] of [['settings', '/settings'], ['home', '/'], ['detail', `/comic/${comic.id}`]]) {
    await injectPrefs(send, { theme: THEME, accent });
    await send('Page.navigate', { url: BASE + url });
    await sleep(2300);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.resolve('_shots', `acc-${name}-${accent}-${THEME}${TAG}.png`), Buffer.from(r.data, 'base64'));
    console.log('saved', name, accent, THEME);
  }
}

// 偏好只在本机（临时 profile），无需还原服务端
ws.close(); edge.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
