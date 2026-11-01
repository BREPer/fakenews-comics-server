/**
 * 首页「扫描进行中」提示与结束后自动刷新 —— 实测（CDP，390×844）。
 *
 * 为什么要 mock 状态接口：本机夹具做增量扫描 512 本只要 <1s，真实扫描窗口太短，
 * 不可能稳定观察到提示条。这里用 Fetch.fulfillRequest 直接伪造 /api/scan/status
 * 的响应，专门验证 UI 与「running → 结束」的刷新逻辑，跟服务端真值无关。
 *
 * 断言：
 *   1) running=true 时出现提示条，且带 done/total 进度
 *   2) 空列表 + 扫描中 → 不显示「还没有漫画」，改显示扫描中
 *   3) running 变 false 后提示条消失，并自动重新拉取列表（不需要用户手动刷新）
 *
 * 用法：node tools/scan_banner_check.mjs [--base=http://127.0.0.1:5173]
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
const BASE = ARG('base', 'http://127.0.0.1:5173').replace(/\/$/, '');
const THEME = ARG('theme', 'light');
const PORT = 9793;

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) { console.error('未找到 Edge'); process.exit(2); }
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-scan-'));
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
let scanRunning = true; // 由用例控制
let listCalls = 0;
ws.addEventListener('message', async (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
  if (m.method === 'Network.requestWillBeSent') {
    if (/\/api\/comics(\?|$)/.test(m.params.request.url)) listCalls += 1;
  }
  if (m.method === 'Fetch.requestPaused') {
    const { requestId, request } = m.params;
    if (request.url.includes('/api/scan/status')) {
      const data = scanRunning
        ? { running: true, total: 512, done: 3, current: '正在解析 /comics/示例书名.cbz', startedAt: Date.now() }
        : { running: false, total: 512, done: 512, current: '', finishedAt: Date.now() };
      const body = Buffer.from(JSON.stringify({ code: 0, data }), 'utf8').toString('base64');
      ws.send(JSON.stringify({
        id: ++seq,
        method: 'Fetch.fulfillRequest',
        params: {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'content-type', value: 'application/json; charset=utf-8' },
            { name: 'cache-control', value: 'no-store' },
          ],
          body,
        },
      }));
      return;
    }
    ws.send(JSON.stringify({ id: ++seq, method: 'Fetch.continueRequest', params: { requestId } }));
  }
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

// 只拦截状态接口，其余请求原样放行
await send('Fetch.enable', { patterns: [{ urlPattern: '*api/scan/status*', requestStage: 'Request' }] });

// 主题按设备存在 localStorage（服务端 PUT 已不参与），导航前注入
const { injectPrefs } = await import('./lib/prefs.mjs');
await injectPrefs(send, { theme: THEME });

await send('Page.navigate', { url: BASE + '/' });
let banner = '';
for (let i = 0; i < 40; i++) {
  await sleep(250);
  banner = (await ev(`document.querySelector('[role="status"]')?.innerText ?? ''`)) || '';
  if (/正在扫描漫画库/.test(banner)) break;
}
check('扫描中显示提示条', /正在扫描漫画库/.test(banner), banner.replace(/\n/g, ' / ').slice(0, 50));
check('提示条带进度', /已完成\s*3\s*\/\s*512/.test(banner), '');

const bodyText = (await ev('document.body.innerText')) || '';
check('扫描中不再显示「还没有漫画」', !/还没有漫画/.test(bodyText), '');

// 留档一张（设计走查用）
try {
  fs.mkdirSync(path.resolve('_shots'), { recursive: true });
  const png = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.resolve('_shots', 'scan_banner.png'), Buffer.from(png.data, 'base64'));
  console.log('      saved _shots/scan_banner.png');
} catch { /* 截图失败不影响断言 */ }

// 有内容时也应显示提示条（不是只在空库时显示）
const cards = (await ev(`document.querySelectorAll('a[href^="/comic/"]').length`)) || 0;
check('扫描中可以同时浏览列表', cards > 0, `卡片 ${cards}`);

// 切到「扫描结束」→ 提示条应消失，且列表被自动刷新
const before = listCalls;
scanRunning = false;
let gone = false;
for (let i = 0; i < 30; i++) {
  await sleep(300);
  const t = (await ev(`document.querySelector('[role="status"]')?.innerText ?? ''`)) || '';
  if (!/正在扫描漫画库/.test(t)) { gone = true; break; }
}
check('扫描结束后提示条消失', gone, '');
await sleep(1500);
check('结束后自动刷新列表', listCalls > before, `新增列表请求 ${listCalls - before} 次`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
ws.close();
edge.kill();
await sleep(300);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed.length ? 1 : 0);
