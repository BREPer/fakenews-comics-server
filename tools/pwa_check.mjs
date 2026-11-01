/**
 * PWA 实测：清单解析 / Service Worker 注册 / 静态资源缓存 / 断网仍能进应用。
 *
 * 必须打生产实例（:13800），因为 SW 只在 `import.meta.env.PROD` 下注册；
 * 且必须是 https / localhost / 127.0.0.1 之一，否则浏览器不提供 SW 能力。
 *
 * 用法：node tools/pwa_check.mjs [--base=http://127.0.0.1:13800]
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
const PORT = 9794;

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) { console.error('未找到 Edge'); process.exit(2); }
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-pwa-'));
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

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

// ---------- 1. 清单 ----------
await send('Page.navigate', { url: BASE + '/' });
await sleep(2500);
// 直接读清单原文再校验字段：Page.getAppManifest 的 parsed 只在浏览器自己拉过
// 清单时才填充，headless 下不稳定，字段级断言用原文更可靠
const mf = await ev(`(async () => {
  const r = await fetch('/manifest.webmanifest');
  const j = await r.json();
  return { ct: r.headers.get('content-type'), j };
})()`);
const m = mf?.j ?? {};
check('清单 Content-Type 正确', /application\/manifest\+json/.test(mf?.ct ?? ''), String(mf?.ct));
check('清单 name / short_name', !!(m.name && m.short_name), `${m.name} / ${m.short_name}`);
check('清单带 192 与 512 图标', (m.icons ?? []).length >= 2 &&
  (m.icons ?? []).some((i) => i.sizes === '192x192') && (m.icons ?? []).some((i) => i.sizes === '512x512'),
  (m.icons ?? []).map((i) => i.sizes).join(','));
check('display = standalone', m.display === 'standalone', String(m.display));
check('start_url / scope 指向根', m.start_url === '/' && m.scope === '/', `${m.start_url} / ${m.scope}`);

const installErr = await send('Page.getInstallabilityErrors');
check('Chromium 判定可安装（无安装性错误）', !(installErr?.installabilityErrors ?? []).length,
  (installErr?.installabilityErrors ?? []).map((e) => e.errorId).join('; '));

// ---------- 2. SW 注册 ----------
let reg = null;
for (let i = 0; i < 40; i++) {
  reg = await ev(`(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return r ? { scope: r.scope, state: (r.active || r.installing || r.waiting)?.state ?? '' } : null;
  })()`);
  if (reg && reg.state === 'activated') break;
  await sleep(250);
}
check('Service Worker 已注册并激活', reg?.state === 'activated', JSON.stringify(reg));

// ---------- 3. 缓存内容（必须在「已被接管」之后看：首访时 SW 还没激活，
// 那一轮的 /assets/* 请求根本不经过它，此时 static 缓存必然是空的） ----------
await send('Page.reload');
await sleep(2200);
const caches = await ev(`caches.keys()`);
check('建立了 shell / static 两个缓存', Array.isArray(caches) &&
  caches.some((k) => k.startsWith('fc-shell-')) && caches.some((k) => k.startsWith('fc-static-')), String(caches));
/*
 * 按实际存在的 key 取内容，不要写死版本号：SW 的 VERSION 一改（现在已到 v4），
 * caches.open('fc-shell-v1') 会静默新建一个空缓存，「静态资源已进缓存」这类断言
 * 就会凭空失败 —— 属于探针没跟上版本，不是离线能力的锅。
 */
const pickCache = (prefix) =>
  ev(`(async () => {
       const k = (await caches.keys()).find((x) => x.startsWith('${prefix}'));
       if (!k) return null;
       return (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname);
     })()`);
const shellKeys = await pickCache('fc-shell-');
check('shell 缓存含 / 与图标', (shellKeys ?? []).includes('/') && (shellKeys ?? []).includes('/pwa-192.png'), String(shellKeys));
const staticKeys = await pickCache('fc-static-');
check('静态资源已进缓存', (staticKeys ?? []).length > 0, (staticKeys ?? []).join(','));
check('首屏 JS/CSS 进的是 assets 缓存', (staticKeys ?? []).some((p) => p.startsWith('/assets/')),
  (staticKeys ?? []).filter((p) => p.startsWith('/assets/')).slice(0, 3).join(','));

// ---------- 4. 二访由 SW 接管 ----------
const controlled = await ev(`!!navigator.serviceWorker.controller`);
check('二次访问已被 SW 接管', controlled === true, '');

// ---------- 5. 断网仍能进应用 ----------
await send('Network.emulateNetworkConditions', {
  offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
});
await send('Page.navigate', { url: BASE + '/' }).catch(() => {});
await sleep(2500);
const offlineTitle = await ev(`document.title`);
const offlineText = (await ev(`document.body.innerText`)) || '';
const offlineKids = (await ev(`document.getElementById('root')?.childElementCount ?? 0`)) || 0;
check('断网后仍渲染应用外壳', offlineTitle === '肥牛漫画' && offlineKids > 0,
  `title=${offlineTitle} root子节点=${offlineKids}`);
check('断网时不出现浏览器错误页', !/ERR_INTERNET_DISCONNECTED|无法访问此网站/.test(offlineText), '');

// 恢复网络，别把后续操作卡在离线状态
await send('Network.emulateNetworkConditions', {
  offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
ws.close();
edge.kill();
await sleep(300);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed.length ? 1 : 0);
