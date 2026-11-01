/** 一次性：截其余页（设置 / 书架 / 搜索 / 漫画库 / 登录）留档。 */
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
const ARG = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = (ARG('base', 'http://127.0.0.1:13800')).replace(/\/$/, '');
const THEME = ARG('theme', 'light');
const api = async (p, i) => (await fetch(BASE + p, i)).json();

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const PORT = 9586;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ui3-'));
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
// 主题按设备存在 localStorage（服务端 PUT 已被忽略），导航前注入
const { injectPrefs } = await import('./lib/prefs.mjs');
await injectPrefs(send, { theme: THEME });
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
fs.mkdirSync(path.resolve('_shots'), { recursive: true });
for (const [name, url] of [['settings', '/settings'], ['shelf', '/shelf'], ['search', '/search'], ['libraries', '/libraries']]) {
  await send('Page.navigate', { url: BASE + url });
  await sleep(2200);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.resolve('_shots', `ui3-${name}-${THEME}.png`), Buffer.from(r.data, 'base64'));
  console.log('saved', name);
}
// 偏好只在本机（临时 profile），无需还原服务端
ws.close(); edge.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
