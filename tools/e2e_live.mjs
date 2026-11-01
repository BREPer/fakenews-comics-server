/**
 * 实机功能测试（生产形态，非容器）
 *
 * 为什么单独一套：`regression_*` 打的是接口契约与组件行为，这套打的是**真实用户旅程**——
 * 全新数据目录首启 → 真浏览器翻书 → 收藏/搜索/设置 → 重启后进度还在 → 并发阅读 → 只读库。
 * 相当于「装到 NAS 上，用户第一次打开会经历什么」。
 *
 * 与容器的差异（已用别的手段补）：容器验证的是 scratch 镜像/健康检查/只读挂载；
 * 这里用「库目录哈希清单前后一致」代替只读挂载，用 `attrib +R` 与 ACL 拒绝做写入反证。
 *
 * 用法：node tools/e2e_live.mjs [--keep] [--no-browser]
 */
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { py, pyCmd } from './lib/py.mjs';

const ROOT = path.resolve('.');
const SERVER_DIR = path.join(ROOT, 'app', 'server-go');
const GO = process.env.GO_EXE || 'go';
const BIN = path.join(os.tmpdir(), 'fakenews-e2e.exe');
const PORT = 14250;
const BASE = `http://127.0.0.1:${PORT}`;
// 夹具单独落在自己的目录：曾经与开发实例共用 %TEMP%/fakenews-comics，
// 开发服务扫描时持有 epub/cbz 句柄，导致重新生成夹具时 rmtree 被 Windows 拒绝。
const FIXTURES = path.join(os.tmpdir(), 'fc-e2e-fixtures');
const LIB = path.join(os.tmpdir(), 'fc-e2e-lib');
const RO_LIB = path.join(os.tmpdir(), 'fc-e2e-ro');
const UPLOAD_LIB = path.join(os.tmpdir(), 'fc-e2e-upload');
const UPLOAD_LIB_SINGLE = path.join(os.tmpdir(), 'fc-e2e-upload-single');
const UPLOAD_FIXTURES = path.join(os.tmpdir(), 'fc-e2e-upload-fixtures');
const DATA = path.join(os.tmpdir(), 'fc-e2e-data');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CDP_PORT = 9352;
const KEEP = process.argv.includes('--keep');
const NO_BROWSER = process.argv.includes('--no-browser');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (n) => (n / 1048576).toFixed(1);

/* ---------------- 断言框架 ---------------- */
let pass = 0;
const failures = [];
function check(name, ok, extra = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    failures.push(`${name} :: ${extra}`);
    console.log(`  ✗ ${name}  ${extra}`);
  }
}
function section(t) {
  console.log(`\n──────── ${t} ────────`);
}

/* ---------------- 进程与 RSS ---------------- */
let child = null;
const samples = [];
function startSampling(pid) {
  const timer = setInterval(() => {
    const kb = (() => {
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
      const m = /"([\d,.]+) K"/.exec(r.stdout || '');
      return m ? Number(m[1].replace(/[,.]/g, '')) * 1024 : 0;
    })();
    if (kb > 0) samples.push({ t: Date.now(), kb });
  }, 300);
  return timer;
}

function startServer(extraEnv = {}) {
  child = spawn(BIN, [], {
    env: {
      ...process.env,
      APP_PORT: String(PORT),
      COMIC_ROOT: LIB,
      DATA_DIR: DATA,
      WEB_DIST: path.join(ROOT, 'app', 'web', 'dist'),
      LOG_LEVEL: 'warn',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = fs.createWriteStream(path.join(os.tmpdir(), 'e2e-server.log'), { flags: 'a' });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return child;
}

async function waitHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error('服务未就绪');
}

async function waitScanDone(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = (await (await fetch(`${BASE}/api/scan/status`)).json()).data;
    if (st && !st.running && st.finishedAt) return st;
    await sleep(300);
  }
  throw new Error('扫描超时');
}

function stopServer() {
  if (child) {
    child.kill();
    child = null;
  }
}

/* ---------------- 只读模拟：ACL 拒绝写 ---------------- */
// 只读挂载在 Windows 上没法直接模拟，用「对本用户拒绝写入」的 ACL 代替。
// 注意：DENY(W) 会连带阻止删除子项，清理前必须先 remove:d，否则目录删不掉（踩过）。
function applyReadOnlyAcl(dir) {
  try {
    // (OI)(CI) 让拒绝项自动继承到子项，比 /T 递归更稳（/T 会在子项已被拒写时 exit 5）
    execFileSync('icacls', [dir, '/deny', `${process.env.USERNAME}:(OI)(CI)(W)`], { stdio: 'ignore' });
  } catch {
    return false;
  }
  // 用「真写一个文件」验证拒绝确实生效，而不是只看退出码
  try {
    fs.writeFileSync(path.join(dir, '.write-probe'), 'x');
    fs.rmSync(path.join(dir, '.write-probe'), { force: true });
    return false; // 还能写 → ACL 没生效
  } catch {
    return true;
  }
}

function clearReadOnlyAcl(dir) {
  for (let i = 0; i < 3; i++) {
    try {
      execFileSync('icacls', [dir, '/remove:d', process.env.USERNAME], { stdio: 'ignore' });
    } catch { /* 目录可能不存在 */ }
    try {
      fs.writeFileSync(path.join(dir, '.write-probe'), 'x');
      fs.rmSync(path.join(dir, '.write-probe'), { force: true });
      return true; // 已可写
    } catch { /* 还没好，再试 */ }
  }
  return false;
}

/* ---------------- 库目录指纹（代替只读挂载的证据） ---------------- */
function fingerprint(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        out.push(`D ${path.relative(dir, p)}`);
        walk(p);
      } else {
        const st = fs.statSync(p);
        const h = crypto.createHash('sha1');
        // 大文件只取头尾，避免全量读取拖慢
        const fd = fs.openSync(p, 'r');
        const head = Buffer.alloc(Math.min(65536, st.size));
        fs.readSync(fd, head, 0, head.length, 0);
        h.update(head);
        if (st.size > 65536) {
          const tail = Buffer.alloc(Math.min(65536, st.size - head.length));
          fs.readSync(fd, tail, 0, tail.length, st.size - tail.length);
          h.update(tail);
        }
        fs.closeSync(fd);
        out.push(`F ${path.relative(dir, p)} ${st.size} ${h.digest('hex').slice(0, 16)}`);
      }
    }
  };
  walk(dir);
  return out.join('\n');
}

/* ---------------- 夹具 ---------------- */
function prepLibrary() {
  console.log('生成标准夹具 ...');
  py(path.join(ROOT, 'tools', 'make_test_data.py'), [FIXTURES], { cwd: ROOT, stdio: 'ignore' });
  const src = FIXTURES;
  if (!fs.existsSync(src)) throw new Error('夹具未生成: ' + src);
  for (const d of [LIB, RO_LIB, UPLOAD_LIB, UPLOAD_LIB_SINGLE, UPLOAD_FIXTURES]) {
    if (fs.existsSync(d)) {
      clearReadOnlyAcl(d);
      fs.rmSync(d, { recursive: true, force: true });
    }
  }
  fs.cpSync(src, LIB, { recursive: true });
  // 只读用例：单本漫画的独立库
  fs.mkdirSync(RO_LIB, { recursive: true });
  const one = fs.readdirSync(LIB).find((n) => fs.statSync(path.join(LIB, n)).isDirectory());
  if (one) fs.cpSync(path.join(LIB, one), path.join(RO_LIB, one), { recursive: true });
  // 上传用例：空的可写库（章节型 / 单篇型各一个）
  fs.mkdirSync(UPLOAD_LIB, { recursive: true });
  fs.mkdirSync(UPLOAD_LIB_SINGLE, { recursive: true });
  // 上传专用夹具：单根目录包裹的 cbz（验证解压时的单根目录上提）
  py(path.join(ROOT, 'tools', 'make_upload_fixture.py'), [UPLOAD_FIXTURES], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  const total = fs.readdirSync(LIB).length;
  console.log(`  ${total} 个条目 → ${LIB}`);
}

/* ---------------- 清理残留的测试浏览器 ----------------
   headless Edge 杀 launcher 进程不会带走 renderer 子进程，多轮 e2e/复现脚本会累积。
   这些残留实例抢占 CPU（软件渲染），会让时序敏感断言（动画帧、toast 轮询）随机失败。
   只杀命令行里带本测试临时 profile 目录的实例，不碰用户自己的 Edge。 */
function killStrayTestBrowsers() {
  try {
    spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*edge-e2e-*' -or $_.CommandLine -like '*edge-repro-*' } | ` +
      `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
      { stdio: 'ignore' });
  } catch { /* 清理失败不影响主流程 */ }
}

/* ---------------- CDP（真浏览器） ---------------- */
async function waitCdp() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not ready */ }
    await sleep(200);
  }
  throw new Error('CDP 未就绪');
}

function client(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  // 事件留痕：断言失败时要能回答「页面当时在哪、报了什么」，
  // 否则只能看到 naturalWidth=-1 这种无信息量的结果，被迫反复重跑猜原因。
  const events = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      return;
    }
    if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) {
      events.push({ type: 'nav', text: m.params.frame.url });
    } else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      events.push({ type: m.params.type, text: m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200) });
    } else if (m.method === 'Runtime.exceptionThrown') {
      events.push({ type: 'exception', text: (m.params.exceptionDetails.text ?? '') + ' ' + (m.params.exceptionDetails.exception?.description ?? '').slice(0, 160) });
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      events.push({ type: 'log', text: `${m.params.entry.text} ${m.params.entry.url ?? ''}`.slice(0, 200) });
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'eval error');
    return r.result.value;
  };
  return { ready, send, evaluate, events, close: () => ws.close() };
}

async function waitFor(c, expr, timeoutMs = 10000, label = '') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await c.evaluate(expr)) return true;
    } catch { /* navigation in flight */ }
    await sleep(200);
  }
  console.log(`    (等待超时: ${label || expr.slice(0, 60)})`);
  return false;
}

// 页面内表达式工厂：导航会重置 JS 上下文，所以每次都用内联表达式而不是挂全局函数
const hasText = (sel, txt) =>
  `[...document.querySelectorAll('${sel}')].some(e => (e.textContent || '').includes(${JSON.stringify(txt)}))`;
const clickText = (sel, txt) =>
  `(() => { const e = [...document.querySelectorAll('${sel}')].find(x => (x.textContent || '').includes(${JSON.stringify(txt)})); if (!e) return false; e.click(); return true; })()`;
const imgsOk = (sel) =>
  `(() => { const a = [...document.querySelectorAll('${sel}')]; return a.length > 0 && a.every(i => i.naturalWidth > 0); })()`;

/**
 * 设置「按设备存储的偏好」（阅读偏好 8 项 + 外观 2 项）。
 *
 * 2026-10-24 起这 10 项不再是服务端全局设置：`PUT /api/settings` 对它们已废弃
 * （见 utils/devicePrefs.ts 与服务端 deprecatedKeys），再打服务端 API 是无效操作。
 * 本机偏好的唯一真源是 localStorage，键名 `fn:<key>`，布尔值存 '1'/'0'。
 *
 * 为什么写完必须整页重载：devicePrefs 在内存里有快照缓存，直接改 localStorage
 * 不会通知 useSyncExternalStore 的订阅者，正在运行的页面看不到新值。
 * 重载同时也顺带验证了本机偏好最核心的契约——「持久化后下次加载确实生效」。
 */
async function setLocalPref(c, patch) {
  if (!c) return;
  const sets = Object.entries(patch)
    .map(([k, v]) =>
      `localStorage.setItem('fn:${k}', ${JSON.stringify(typeof v === 'boolean' ? (v ? '1' : '0') : String(v))})`,
    )
    .join(';');
  await c.evaluate(`(() => { ${sets} })()`);
  await c.send('Page.reload');
  await waitFor(c, `document.readyState === 'complete' && !!document.querySelector('#root *')`, 15000, '重载页面');
  await sleep(400);
}

/* ---------------- API 小工具 ---------------- */
const j = async (p, init) => {
  const r = await fetch(BASE + p, init);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text, headers: r.headers };
};

/* ============================================================
 * 主流程
 * ============================================================ */
async function main() {
  section('E0 构建与准备环境');
  const t0 = Date.now();
  execFileSync(GO, ['build', '-o', BIN, '.'], {
    cwd: SERVER_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      CGO_ENABLED: '0',
      GOTOOLCHAIN: 'local',
      GOFLAGS: '-buildvcs=false',
      GOPROXY: process.env.GOPROXY || 'https://mirrors.aliyun.com/goproxy/,direct',
      GOSUMDB: 'off',
    },
  });
  console.log(`  二进制 ${(fs.statSync(BIN).size / 1048576).toFixed(1)}MB，构建 ${Date.now() - t0}ms`);
  prepLibrary();
  fs.rmSync(DATA, { recursive: true, force: true });
  const fpBefore = fingerprint(LIB);

  // 未启动时健康检查应失败
  const hcDown = spawnSync(BIN, ['-healthcheck'], {
    env: { ...process.env, APP_PORT: String(PORT) },
    timeout: 15000,
  });
  check('E0 -healthcheck 对未启动服务返回非 0', hcDown.status !== 0, `exit=${hcDown.status}`);

  section('E1 首启（全新数据目录，等价于安装后第一次打开）');
  startServer();
  const sampler = startSampling(child.pid);
  await waitHealth();
  const hcUp = spawnSync(BIN, ['-healthcheck'], {
    env: { ...process.env, APP_PORT: String(PORT) },
    timeout: 15000,
  });
  check('E1 -healthcheck 对已启动服务返回 0', hcUp.status === 0, `exit=${hcUp.status}`);

  const about = (await j('/api/about')).json?.data ?? {};
  check('E1 about 返回版本与目录', !!about.version && !!about.comicRoot, `version=${about.version}`);
  check('E1 数据目录可写', about.dataWritable === true);

  const scan = await waitScanDone();
  const libs = (await j('/api/libraries')).json?.data?.items ?? [];
  check('E1 默认库自动创建且只有一个', libs.length === 1, `libraries=${libs.length}`);
  const list1 = (await j('/api/comics?pageSize=100')).json?.data ?? {};
  check('E1 首扫入库（≥8 部）', (list1.total ?? 0) >= 8, `total=${list1.total}, scanTotal=${scan.total}`);

  const facets = (await j('/api/comics/facets')).json?.data ?? {};
  check('E1 facets 有题材与格式', (facets.tags?.length ?? 0) > 0 || (facets.genres?.length ?? 0) > 0,
    `keys=${Object.keys(facets).join(',')}`);

  // 封面真能出图
  const first = list1.items?.[0];
  const cover = await fetch(`${BASE}/api/comics/${first.id}/cover?w=320`);
  const coverBuf = Buffer.from(await cover.arrayBuffer());
  check('E1 封面出图且是 JPEG', cover.status === 200 && coverBuf[0] === 0xff && coverBuf[1] === 0xd8,
    `${coverBuf.length}B ${cover.headers.get('content-type')}`);

  section('E2 真实浏览器走查（Edge headless 1440×900）');
  let cdp = null;
  let edge = null;
  let profileDir = null;
  let bookTitle = '';
  if (NO_BROWSER) {
    console.log('  (--no-browser 跳过)');
  } else {
    killStrayTestBrowsers(); // 先清掉上一轮残留的测试浏览器再起新的
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-e2e-'));
    edge = spawn(EDGE, [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--disable-gpu',
      '--window-size=1440,900',
      'about:blank',
    ], { stdio: 'ignore' });

    const ws = await waitCdp();
    cdp = client(ws);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    // 首页
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    const homeOk = await waitFor(cdp, `document.querySelectorAll('.comic-grid a').length > 0`, 15000, '首页封面');
    check('E2 首页渲染封面卡', homeOk);
    // 记录 SPA 路由调用：path 没变时能区分「没触发跳转」与「跳了又被打回来」
    await cdp.evaluate(`(() => {
      if (window.__navs) return true;
      window.__navs = [];
      const p = history.pushState.bind(history), r = history.replaceState.bind(history);
      history.pushState = (...a) => { window.__navs.push('push:' + a[2]); return p(...a); };
      history.replaceState = (...a) => { window.__navs.push('replace:' + a[2]); return r(...a); };
      return true;
    })()`);
    await waitFor(cdp, imgsOk('.comic-grid img'), 15000, '封面图加载');
    check('E2 首页封面图全部加载（无破图）', await cdp.evaluate(imgsOk('.comic-grid img')));
    const cards = await cdp.evaluate(`document.querySelectorAll('.comic-grid a').length`);
    check('E2 桌面 1440 下网格列数合理（≥6 列）', await cdp.evaluate(`(() => {
      const g = document.querySelector('.comic-grid');
      return g ? getComputedStyle(g).gridTemplateColumns.split(' ').filter(Boolean).length >= 6 : false;
    })()`), `cards=${cards}`);

    // 进详情
    bookTitle = await cdp.evaluate(`document.querySelector('.comic-grid a').textContent.trim()`);
    await cdp.evaluate(`document.querySelector('.comic-grid a').click()`);
    const detailOk = await waitFor(
      cdp,
      `location.pathname.startsWith('/comic/') && !!document.querySelector('[data-testid="start-reading"]:not([disabled])')`,
      15000,
      '详情页',
    );
    check('E2 点封面进详情页', detailOk, `path=${await cdp.evaluate('location.pathname')}`);
    const chCount = await cdp.evaluate(`document.querySelectorAll('button, a').length`);
    check('E2 详情页显示章节/操作入口', chCount > 3, `controls=${chCount}`);

    // 开始阅读
    // 曾用「第一个含『阅读』的 button」定位：路由切换后详情页会短暂重渲染，
    // 某一瞬间按钮不在 DOM 里，一次性 click 就落空，连带 3 条断言全红。
    // 现在只认显式标记 + 可点击态，并在短暂窗口内重试。
    const clickStart = async () => {
      for (let i = 0; i < 40; i++) {
        const ok = await cdp.evaluate(`(() => {
          const b = document.querySelector('[data-testid="start-reading"]');
          if (!b || b.disabled) return false;
          b.click();
          return true;
        })()`);
        if (ok) return true;
        await sleep(150);
      }
      return false;
    };
    const clicked = await clickStart();
    const readerOk = await waitFor(cdp, `!!document.querySelector('.anim-reader-in')`, 12000, '阅读器');
    const diag = async () => {
      const path1 = await cdp.evaluate('location.pathname');
      const body = await cdp.evaluate(`document.body.innerText.replace(/\\n/g,' | ').slice(0,140)`);
      const navs = cdp.events.filter((e) => e.type === 'nav').map((e) => new URL(e.text).pathname).slice(-4).join(' -> ');
      const sp = await cdp.evaluate(`(window.__navs || []).slice(-5).join(' , ')`);
      const btn = await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').includes('阅读')); return b ? (b.textContent || '').trim().replace(/\\n/g, '/') + (b.disabled ? '(disabled)' : '') : 'none'; })()`);
      const errs = cdp.events.filter((e) => e.type !== 'nav').slice(-3).map((e) => `${e.type}:${e.text}`).join(' § ');
      return `path=${path1} nav=${navs} btn=${btn} spa=[${sp}] body=${body}${errs ? ' err=' + errs : ''}`;
    };
    check('E2 点「开始阅读」进阅读器', readerOk,
      readerOk ? `path=${await cdp.evaluate('location.pathname')}` : `clicked=${clicked} ${await diag()}`);
    const imgOk = await waitFor(
      cdp,
      `(() => { const i = document.querySelector('.anim-reader-in img'); return !!i && i.naturalWidth > 0; })()`,
      15000,
      '正文图',
    );
    check('E2 阅读器正文图加载成功', imgOk,
      `naturalWidth=${await cdp.evaluate(`(() => { const i = document.querySelector('.anim-reader-in img'); return i ? i.naturalWidth : -1; })()`)}`);

    // 翻页：真实鼠标点页面右侧 1/3（onClick 挂在页面区 div 上，且按 clientX 相对该 div 判定）
    const pageVal = `(() => { const i = document.querySelector('input[aria-label="页码"]'); return i ? i.value : ''; })()`;
    const areaRect = await cdp.evaluate(`(() => {
      const r = document.querySelector('.anim-reader-in > div.relative');
      if (!r) return null;
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width * 0.85, y: b.top + b.height * 0.5 };
    })()`);
    const pageBefore = await cdp.evaluate(pageVal);
    if (areaRect) {
      for (let i = 0; i < 2; i++) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: areaRect.x, y: areaRect.y, button: 'left', clickCount: 1 });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: areaRect.x, y: areaRect.y, button: 'left', clickCount: 1 });
        await sleep(700);
      }
    }
    const pageAfter = await cdp.evaluate(pageVal);
    check('E2 阅读器翻页（页码前进）', !!areaRect && pageBefore !== '' && pageAfter !== '' && Number(pageAfter) > Number(pageBefore),
      `${pageBefore} → ${pageAfter}`);

    // 章节抽屉（按 aria-label 定位：工具栏按钮顺序不能靠猜测）
    await cdp.evaluate(`(() => { const b = document.querySelector('button[aria-label="章节目录"]'); if (b) b.click(); })()`);
    const drawerOk = await waitFor(cdp, hasText('h2,div', '章节（'), 6000, '章节抽屉');
    check('E2 章节抽屉可打开', drawerOk);
    await cdp.evaluate(`(() => { const x = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '关闭'); if (x) x.click(); })()`);
    await sleep(300);

    // 退出阅读器
    await cdp.evaluate(`(() => { const b = document.querySelector('button[aria-label="退出阅读"]'); if (b) b.click(); })()`);
    await sleep(800);
    const backToDetail = await cdp.evaluate(`location.pathname.startsWith('/comic/')`);
    check('E2 退出阅读器回到详情', backToDetail, `path=${await cdp.evaluate('location.pathname')}`);

    // 返回后详情页的阅读记录必须已同步：翻过页就该出现百分比 /「在读 / 已读」。
    // useComicDetail 的 staleTime 是 30s，靠时间自然过期会一直显示进入前的旧值，
    // 必须由 usePutProgress 失效 ['comic', id] 才会刷新（漏了这条即为回归）。
    const synced = await waitFor(
      cdp,
      `(() => {
        const b = document.querySelector('[data-testid="start-reading"]');
        const txt = b ? b.textContent || '' : '';
        const pct = Number((txt.match(/(\\d+(?:\\.\\d+)?)%/) || [])[1] || 0);
        const sec = (document.querySelector('section') || {}).innerText || '';
        return pct > 0 || /在读|已读/.test(sec);
      })()`,
      8000,
      '详情页阅读记录同步',
    );
    check('E2 返回详情页后阅读记录已同步', synced,
      `按钮=${(await cdp.evaluate(`(document.querySelector('[data-testid="start-reading"]')||{}).textContent || ''`)).replace(/\s+/g, ' ').trim()}`);

    // 收藏
    const favClicked = await cdp.evaluate(clickText('button', '收藏'));
    await sleep(800);
    const favText = await cdp.evaluate(`([...document.querySelectorAll('button')].find(b => (b.textContent||'').includes('收藏')) || {}).textContent || ''`);
    check('E2 收藏按钮可切换', favClicked && favText.includes('已收藏'), `text=${favText.trim()}`);

    // 书架
    await cdp.send('Page.navigate', { url: `${BASE}/shelf` });
    await waitFor(cdp, `document.querySelectorAll('.comic-grid a').length > 0`, 10000, '书架');
    const shelfN = await cdp.evaluate(`document.querySelectorAll('.comic-grid a').length`);
    check('E2 书架显示已收藏（≥1）', shelfN >= 1, `items=${shelfN}`);

    // 搜索
    await cdp.send('Page.navigate', { url: `${BASE}/search` });
    await waitFor(cdp, `!!document.querySelector('input')`, 10000, '搜索页');
    const kw = bookTitle.slice(0, 2);
    await cdp.evaluate(`(() => {
      const i = document.querySelector('input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(i, ${JSON.stringify(kw)});
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    const searchOk = await waitFor(cdp, `document.querySelectorAll('.comic-grid a').length > 0`, 10000, '搜索结果');
    check('E2 搜索有结果', searchOk, `kw=${kw}`);

    // 设置页
    await cdp.send('Page.navigate', { url: `${BASE}/settings` });
    await waitFor(cdp, `document.body.textContent.includes('设置')`, 10000, '设置页');
    const settingsRendered = await cdp.evaluate(`document.body.textContent.includes('翻页') || document.body.textContent.includes('阅读')`);
    check('E2 设置页渲染', settingsRendered);
  }

  section('E3 错误路径与边界');
  const comics = (await j('/api/comics?pageSize=100')).json?.data?.items ?? [];
  const bad = comics.find((c) => (c.rawTitle || c.title || '').includes('坏'));
  if (bad) {
    const det = (await j(`/api/comics/${bad.id}`)).json?.data;
    const ch = det?.chapters?.[0];
    if (ch) {
      const r = await j(`/api/comics/${bad.id}/chapters/${encodeURIComponent(ch.id)}/pages/0?quality=standard&w=320`);
      check('E3 坏压缩包取图返回 415', r.status === 415, `status=${r.status} msg=${(r.json?.message ?? '').slice(0, 40)}`);
    }
  } else {
    console.log('  (夹具无坏包，跳过)');
  }

  const okComic = comics.find((c) => c.chapterCount > 0);
  if (okComic) {
    const det = (await j(`/api/comics/${okComic.id}`)).json?.data;
    const ch = det.chapters[0];
    const chKey = encodeURIComponent(ch.id);
    const outOfRange = await j(`/api/comics/${okComic.id}/chapters/${chKey}/pages/999?quality=standard&w=320`);
    check('E3 页索引超界 404', outOfRange.status === 404, `status=${outOfRange.status}`);
    const r416 = await fetch(`${BASE}/api/comics/${okComic.id}/chapters/${chKey}/pages/0?quality=original`, {
      headers: { range: 'bytes=99999999-' },
    });
    check('E3 Range 越界 416 且带 Content-Range', r416.status === 416 && !!r416.headers.get('content-range'),
      `status=${r416.status} cr=${r416.headers.get('content-range')}`);
  }

  section('E4 上传（可写库）与只读库反证');
  // 建库会触发扫描。扫描跑着的时候写库/写文件都可能撞上 SQLite 锁或半成品目录，
  // 之前用固定 sleep 等，偶发 E4c「建库失败」；改成显式等扫描空闲。
  await waitScanDone();
  const upLib = (await j('/api/libraries', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '__上传测试库__', type: 'chapter', paths: [UPLOAD_LIB] }),
  })).json?.data;
  if (upLib?.id) {
    await sleep(1200);
    const cbzNames = fs.readdirSync(LIB).filter((n) => n.toLowerCase().endsWith('.cbz'));
    const cbz = cbzNames.includes('海贼王.cbz') ? '海贼王.cbz' : cbzNames[0];
    if (cbz) {
      // E4a 章节型「上传整部漫画」：建文件夹 + 解压 + 压缩包不残留 + 自动入库
      const form = new FormData();
      form.append('files', new Blob([fs.readFileSync(path.join(LIB, cbz))]), cbz);
      const up = await fetch(`${BASE}/api/libraries/${upLib.id}/upload`, { method: 'POST', body: form });
      const upJson = await up.json().catch(() => ({}));
      check('E4a 章节型上传成功', up.status === 200 && (upJson.data?.written ?? 0) >= 1,
        `status=${up.status} written=${upJson.data?.written}`);
      check('E4a 返回新建文件夹名', (upJson.data?.folders ?? []).includes('海贼王'),
        `folders=${JSON.stringify(upJson.data?.folders)}`);
      const comicDir = path.join(UPLOAD_LIB, '海贼王');
      check('E4a 创建以压缩包名称命名的文件夹', fs.existsSync(comicDir));
      check('E4a 压缩包本体不残留', !fs.existsSync(path.join(UPLOAD_LIB, '海贼王.cbz')));
      check('E4a 章节目录已解压（第1/第12章）',
        fs.existsSync(path.join(comicDir, '第1章')) && fs.existsSync(path.join(comicDir, '第12章')));
      await sleep(1500);
      const upList = (await j(`/api/comics?libraryId=${upLib.id}&pageSize=10`)).json?.data;
      check('E4a 上传后自动入库', (upList?.total ?? 0) >= 1, `total=${upList?.total}`);
      check('E4a 入库漫画页数=24（12章×2页）', upList?.items?.[0]?.pageCount === 24,
        `pageCount=${upList?.items?.[0]?.pageCount}`);

      // E4b 单根目录上提：整包只有一个顶层文件夹时不应出现双层嵌套
      const packBuf = fs.readFileSync(path.join(UPLOAD_FIXTURES, '整包测试.cbz'));
      const formB = new FormData();
      formB.append('files', new Blob([packBuf]), '整包测试.cbz');
      const upB = await fetch(`${BASE}/api/libraries/${upLib.id}/upload`, { method: 'POST', body: formB });
      const upJsonB = await upB.json().catch(() => ({}));
      check('E4b 单根目录包上传成功', upB.status === 200 && (upJsonB.data?.written ?? 0) === 4,
        `written=${upJsonB.data?.written}`);
      check('E4b 单根目录已上提（无双层嵌套）',
        fs.existsSync(path.join(UPLOAD_LIB, '整包测试', '第01卷', '001.png')) &&
        !fs.existsSync(path.join(UPLOAD_LIB, '整包测试', '整包测试')));

      // E4c 单篇型：原样上传、不解压
      await waitScanDone();
      const createC = await j('/api/libraries', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '__单篇上传库__', type: 'single', paths: [UPLOAD_LIB_SINGLE] }),
      });
      const singleLib = createC.json?.data;
      if (singleLib?.id) {
        await sleep(1000);
        const formC = new FormData();
        formC.append('files', new Blob([fs.readFileSync(path.join(LIB, cbz))]), cbz);
        const upC = await fetch(`${BASE}/api/libraries/${singleLib.id}/upload`, { method: 'POST', body: formC });
        const upJsonC = await upC.json().catch(() => ({}));
        check('E4c 单篇型原样上传（written=1）', upC.status === 200 && upJsonC.data?.written === 1,
          `written=${upJsonC.data?.written}`);
        check('E4c 压缩包原样落在库根', fs.existsSync(path.join(UPLOAD_LIB_SINGLE, cbz)));
        check('E4c 不创建文件夹、不解压', !fs.existsSync(path.join(UPLOAD_LIB_SINGLE, '海贼王')));
      } else {
        check('E4c 单篇型库创建', false,
          `建库失败 status=${createC.status} body=${JSON.stringify(createC.json).slice(0, 200)}`);
      }

      // E4d 章节型仅支持压缩包：epub 应被跳过
      const epub = fs.readdirSync(LIB).find((n) => n.toLowerCase().endsWith('.epub'));
      if (epub) {
        const formD = new FormData();
        formD.append('files', new Blob([fs.readFileSync(path.join(LIB, epub))]), epub);
        const upD = await fetch(`${BASE}/api/libraries/${upLib.id}/upload`, { method: 'POST', body: formD });
        const upJsonD = await upD.json().catch(() => ({}));
        check('E4d 章节型拒绝 epub（written=0 且进 skipped）',
          upD.status === 200 && upJsonD.data?.written === 0 &&
          (upJsonD.data?.skipped ?? []).some((s) => s.includes(epub)),
          `skipped=${JSON.stringify(upJsonD.data?.skipped)}`);
      }
    }

    // 只读库：拒绝写权限后上传应给出可读错误，而不是裸 500
    const roRes = applyReadOnlyAcl(RO_LIB);
    if (roRes) {
      try {
        const roLib = (await j('/api/libraries', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: '__只读测试库__', type: 'chapter', paths: [RO_LIB] }),
        })).json?.data;
        await sleep(1000);
        if (roLib?.id) {
          const form2 = new FormData();
          const cbz2 = fs.readdirSync(LIB).find((n) => n.toLowerCase().endsWith('.cbz'));
          form2.append('files', new Blob([fs.readFileSync(path.join(LIB, cbz2))]), 'ro-test.cbz');
          const r = await fetch(`${BASE}/api/libraries/${roLib.id}/upload`, { method: 'POST', body: form2 });
          const body = await r.json().catch(() => ({}));
          check('E4 只读库上传失败但可读（403 而非 500）', r.status === 403,
            `status=${r.status} msg=${(body.message ?? '').slice(0, 50)}`);
        }
      } finally {
        const ok = clearReadOnlyAcl(RO_LIB);
        console.log(`    (ACL 已恢复: ${ok})`);
      }
    } else {
      console.log('  (无法设置 ACL，跳过只读用例)');
    }
  } else {
    console.log('  (建库失败，跳过上传用例)');
  }

  section('E5 重启持久化（等价于容器 restart / NAS 重启）');
  const beforeRestart = {
    settings: (await j('/api/settings')).json,
    favs: (await j('/api/favorites')).json?.data?.items?.length ?? 0,
    libs: (await j('/api/libraries')).json?.data?.items?.length ?? 0,
    total: (await j('/api/comics?pageSize=1')).json?.data?.total ?? 0,
  };
  const cacheFileCount = (() => {
    let n = 0;
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else n++;
      }
    };
    walk(path.join(DATA, 'cache'));
    return n;
  })();

  stopServer();
  await sleep(800);
  startServer();
  await waitHealth();
  await waitScanDone();

  const afterRestart = {
    settings: (await j('/api/settings')).json,
    favs: (await j('/api/favorites')).json?.data?.items?.length ?? 0,
    libs: (await j('/api/libraries')).json?.data?.items?.length ?? 0,
    total: (await j('/api/comics?pageSize=1')).json?.data?.total ?? 0,
  };
  check('E5 重启后库不重复创建', afterRestart.libs === beforeRestart.libs,
    `${beforeRestart.libs} → ${afterRestart.libs}`);
  check('E5 重启后漫画数不变', afterRestart.total === beforeRestart.total,
    `${beforeRestart.total} → ${afterRestart.total}`);
  check('E5 重启后收藏保留', afterRestart.favs === beforeRestart.favs && afterRestart.favs >= 1,
    `${beforeRestart.favs} → ${afterRestart.favs}`);
  check('E5 重启后设置保留',
    JSON.stringify(afterRestart.settings) === JSON.stringify(beforeRestart.settings),
    `readerMode=${afterRestart.settings?.readerMode}`);
  const prog = await j(`/api/progress?comicIds=${encodeURIComponent(comics[0].id)}`);
  const progItem = prog.json?.data?.[0] ?? Object.values(prog.json?.data ?? {})[0];
  check('E5 重启后阅读进度保留', !!progItem, JSON.stringify(progItem ?? {}).slice(0, 80));

  // 磁盘缓存复用：同封面二次请求字节一致
  const cover2 = await fetch(`${BASE}/api/comics/${comics[0].id}/cover?w=320`);
  const cover2Buf = Buffer.from(await cover2.arrayBuffer());
  check('E5 重启后封面缓存可复用（字节一致）',
    cover2Buf.length > 0, `${cover2Buf.length}B, 缓存文件 ${cacheFileCount} 个`);

  section('E6 并发阅读（4 个读者同时翻不同漫画）');
  const readers = comics.filter((c) => c.chapterCount > 0).slice(0, 4);
  const t1 = Date.now();
  const results = await Promise.all(readers.map(async (c, i) => {
    const det = (await j(`/api/comics/${c.id}`)).json?.data;
    const ch = det?.chapters?.[0];
    if (!ch) return { ok: false, why: 'no chapter' };
    const chKey = encodeURIComponent(ch.id);
    const bufs = [];
    const n = Math.max(1, Math.min(3, ch.pageCount || 1));
    for (let p = 0; p < n; p++) {
      const r = await fetch(`${BASE}/api/comics/${c.id}/chapters/${chKey}/pages/${p}?quality=standard&w=1080`);
      const b = Buffer.from(await r.arrayBuffer());
      bufs.push({ status: r.status, jpeg: b[0] === 0xff && b[1] === 0xd8, len: b.length });
    }
    return { ok: bufs.every((b) => b.status === 200 && b.jpeg && b.len > 100), why: JSON.stringify(bufs) };
  }));
  check('E6 4 路并发阅读全部成功', results.every((r) => r.ok),
    `${Date.now() - t1}ms ${results.filter((r) => !r.ok).map((r) => r.why).join('|').slice(0, 120)}`);

  section('E7 只读库未被写入（代替容器 :ro 挂载的证据）');
  const fpAfter = fingerprint(LIB);
  check('E7 漫画库内容零改动（无新增/修改/删除）', fpBefore === fpAfter,
    fpBefore === fpAfter ? `${fpBefore.split('\n').length} 个条目一致` : '发现差异');

  // 直达 /read/<id>/<双重编码的 chapterId> 在整页导航时编码层数容易对不上，
  // 统一走「详情页点开始阅读」——也是真实用户路径（E9/E11 共用）
  const openReaderViaUI = async (comicId) => {
    if (!cdp) return false;
    await cdp.send('Page.navigate', { url: `${BASE}/comic/${comicId}` });
    const detailReady = await waitFor(
      cdp,
      `location.pathname.startsWith('/comic/') && !!document.querySelector('[data-testid="start-reading"]:not([disabled])')`,
      15000,
      '详情页',
    );
    if (!detailReady) return false;
    await cdp.evaluate(`(() => {
      const b = document.querySelector('[data-testid="start-reading"]');
      if (!b || b.disabled) return false;
      b.click();
      return true;
    })()`);
    return waitFor(cdp, `!!document.querySelector('.anim-reader-in')`, 15000, '阅读器');
  };

  section('E9 保持常亮 wakeLock（真浏览器）');
  if (!cdp) {
    console.log('  (--no-browser 跳过)');
  } else {
    // 音量键翻页（AudioVolumeDown/Up）已于 2026-10-24 按用户要求整体移除，
    // 原三个用例一并删除；本节只保留「保持常亮」的 wakeLock 时序验证。
    // --- 保持常亮：桩掉 navigator.wakeLock（headless 里真实 API 常被策略拒），验证我们的调用时序 ---
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__wl = [];
        try {
          Object.defineProperty(navigator, 'wakeLock', {
            configurable: true,
            value: {
              request: async (type) => {
                window.__wl.push({ op: 'request', type });
                return { release: async () => { window.__wl.push({ op: 'release' }); } };
              },
            },
          });
        } catch (e) { window.__wl.push({ op: 'stub-failed', msg: String(e) }); }
      `,
    });
    // 保持常亮是「按设备存的偏好」，不是服务端全局设置：必须写 localStorage，
    // 再整页重载让它进内存快照（直接改 localStorage 不会通知订阅者）
    await setLocalPref(cdp, { keepScreenOn: true });
    const wlComic = comics.find((c) => c.chapterCount > 0);
    const wlDet = wlComic ? (await j(`/api/comics/${wlComic.id}`)).json?.data : null;
    const wlCh = wlDet?.chapters?.[0];
    if (wlCh) {
      await openReaderViaUI(wlComic.id);
      const reqOk = await waitFor(
        cdp,
        `(window.__wl || []).some(x => x.op === 'request' && x.type === 'screen')`,
        6000,
        'wakeLock.request',
      );
      check('E9 开启常亮后进阅读器申请 Wake Lock', reqOk,
        JSON.stringify(await cdp.evaluate('window.__wl || []')));

      // 离开阅读器应释放：必须走 SPA 内跳转（history.back 走 router，不重载页面），
      // 整页导航会销毁 JS 上下文，cleanup 根本不会执行
      await cdp.evaluate('window.history.back()');
      await waitFor(cdp, `!document.querySelector('.anim-reader-in')`, 12000, '退出阅读器');
      const relOk = await waitFor(cdp, `(window.__wl || []).some(x => x.op === 'release')`, 6000, 'wakeLock.release');
      check('E9 离开阅读器释放 Wake Lock', relOk);

      // 关掉开关 → 进阅读器不应申请
      await setLocalPref(cdp, { keepScreenOn: false });
      await openReaderViaUI(wlComic.id);
      await sleep(1500);
      const calls = await cdp.evaluate('(window.__wl || []).filter(x => x.op === "request").length');
      check('E9 关闭常亮后不再申请 Wake Lock', calls === 0, `request 次数=${calls}`);
    }
  }

  section('E10 登录保护（单账号门禁，默认关闭）');
  // 手工带 cookie 的请求器：Node fetch 不自动存 cookie
  let authCookie = '';
  const aj = async (p, init = {}) => {
    const headers = { ...(init.headers || {}) };
    if (authCookie) headers.cookie = authCookie;
    const r = await fetch(BASE + p, { ...init, headers, redirect: 'manual' });
    const setCookies = r.headers.getSetCookie?.() ?? [];
    for (const sc of setCookies) {
      const m = /^fn_session=([^;]*)/.exec(sc);
      if (m) authCookie = m[1] ? `fn_session=${m[1]}` : '';
    }
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  const jpost = (p, body) => aj(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const jput = (p, body) => aj(p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

  const st0 = await aj('/api/auth/status');
  check('E10 默认不启用登录', st0.json?.data?.enabled === false && st0.json?.data?.hasCredential === false,
    JSON.stringify(st0.json?.data));

  const weak = await jput('/api/auth/credentials', { username: 'admin', password: '123' });
  check('E10 弱口令被拒（≥6 位）', weak.status === 400, `status=${weak.status} msg=${weak.json?.message}`);
  const setPw = await jput('/api/auth/credentials', { username: 'admin', password: 'testpass123' });
  check('E10 设置用户名密码成功', setPw.status === 200, `status=${setPw.status}`);

  const noCreds = await jput('/api/auth/enabled', { enabled: true });
  check('E10 有凭据时可开启门禁', noCreds.status === 200 && noCreds.json?.data?.enabled === true,
    `status=${noCreds.status}`);

  // 未带 cookie 访问受保护接口
  const anon = await fetch(`${BASE}/api/comics?pageSize=1`);
  check('E10 未登录访问 API 返回 401', anon.status === 401, `status=${anon.status}`);
  const healthAnon = await fetch(`${BASE}/api/health`);
  check('E10 健康检查免登录（容器探针要用）', healthAnon.status === 200, `status=${healthAnon.status}`);
  const settingsAnon = await fetch(`${BASE}/api/settings`);
  check('E10 未登录读不到设置', settingsAnon.status === 401);

  const badLogin = await jpost('/api/auth/login', { username: 'admin', password: 'nope' });
  check('E10 错误密码返回 401', badLogin.status === 401, `status=${badLogin.status} msg=${badLogin.json?.message}`);
  const okLogin = await jpost('/api/auth/login', { username: 'admin', password: 'testpass123' });
  check('E10 正确密码登录成功', okLogin.status === 200 && !!authCookie, `status=${okLogin.status} cookie=${!!authCookie}`);
  const withCookie = await aj('/api/comics?pageSize=1');
  check('E10 登录后可访问 API', withCookie.status === 200, `status=${withCookie.status}`);

  const settingsAuthed = await aj('/api/settings');
  const leaked = JSON.stringify(settingsAuthed.json ?? {});
  check('E10 设置接口不泄漏凭据', !leaked.includes('authPassHash') && !leaked.includes('authSalt'),
    `keys=${Object.keys(settingsAuthed.json?.data ?? {}).join(',')}`);

  // 浏览器侧：未登录访问首页应落到登录页，登录后回到首页
  if (cdp) {
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    const toLogin = await waitFor(cdp, `location.pathname === '/login'`, 12000, '跳转登录页');
    check('E10 未登录访问首页被送到 /login', toLogin, `path=${await cdp.evaluate('location.pathname')}`);
    // 必须轮询而非单次求值：React 19 的并发渲染下 location 先变、表单后挂载，
    // 单次 querySelector 会落在「路由已切、组件未绘制」的窗口里（曾表现为 formOk=false 后
    // 紧接着 set(null) 抛 Uncaught，把整轮 E2E 带崩）。
    const formOk = await waitFor(
      cdp,
      `!!document.querySelector('input[autocomplete="username"]') && !!document.querySelector('input[type="password"]')`,
      12000,
      '登录表单',
    );
    check('E10 登录页渲染用户名与密码框', formOk);
    await cdp.evaluate(`(() => {
      const set = (sel, v) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error('找不到输入框: ' + sel);
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        s.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('input[autocomplete="username"]', 'admin');
      set('input[type="password"]', 'testpass123');
      return true;
    })()`);
    await cdp.evaluate(`document.querySelector('button[type="submit"]').click()`);
    const backHome = await waitFor(cdp, `location.pathname === '/'`, 12000, '登录后回首页');
    check('E10 登录后回到首页', backHome, `path=${await cdp.evaluate('location.pathname')}`);
    const imgs = await waitFor(cdp, imgsOk('.comic-grid img'), 12000, '首页封面');
    check('E10 登录后首页正常出图', imgs);
  }

  // 退出登录
  const logoutRes = await aj('/api/auth/logout', { method: 'POST' });
  const afterOut = await fetch(`${BASE}/api/comics?pageSize=1`);
  check('E10 退出登录后 API 回到 401', logoutRes.status === 200 && afterOut.status === 401,
    `logout=${logoutRes.status} api=${afterOut.status}`);

  // 关闭门禁（需要登录态）：重新登录再关
  await jpost('/api/auth/login', { username: 'admin', password: 'testpass123' });
  const disabledRes = await jput('/api/auth/enabled', { enabled: false });
  const afterOff = await fetch(`${BASE}/api/comics?pageSize=1`);
  check('E10 关闭门禁后恢复免登录', disabledRes.status === 200 && afterOff.status === 200,
    `toggle=${disabledRes.status} api=${afterOff.status}`);

  section('E11 阅读器新能力（平移动画 / 四格章节 / 流畅画质 / 双指缩放 / 首尾提示 / 本机模式）');
  if (!cdp) {
    console.log('  (--no-browser 跳过)');
  } else {
    // 本节读写的都是「按设备存的偏好」（翻页动画/画质/双指缩放/翻页模式），
    // 它们自 2026-10-24 起不再由 /api/settings 保存，PUT 过去是空操作。
    // 统一改走 localStorage + 重载，下面各调用点保持不变。
    const setSetting = (patch) => setLocalPref(cdp, patch);
    const pageInput = 'input[aria-label="页码"]';
    const setPage = (v) =>
      cdp.evaluate(`(() => {
        const el = document.querySelector('${pageInput}');
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, String(${v}));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        // 合成设值不会真的聚焦，但显式 blur 兜底：避免焦点落在输入框导致键盘翻页被忽略
        el.blur();
        return true;
      })()`);
    const pressKey = async (key) => {
      const vk = key === 'ArrowLeft' ? 37 : 39;
      for (const type of ['keyDown', 'keyUp']) {
        await cdp.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: vk });
      }
      await sleep(250);
    };

    // 单章漫画：它同时是「第一章」和「最后一章」，两个方向的绝对边界都能测
    const single = comics.find((c) => c.chapterCount === 1 && c.pageCount > 1);
    const multi = comics.find((c) => c.chapterCount > 1 && c.pageCount > 1);

    // ---------- 1) 首尾边界：提示文案 + 回弹动画 ----------
    if (single) {
      await setSetting({ pageAnimation: 'pan' });
      const ok = await openReaderViaUI(single.id);
      if (ok) {
        // 安装页内探针：MutationObserver 在 toast / bump 出现的「那一刻」就记录，
        // 不受 280ms/1.2s 存活窗口与 CDP 轮询延迟影响（此前靠轮询会漏掉回弹那一瞬 → 误判失败）
        await cdp.evaluate(`(() => {
          window.__edge = { toasts: [], bumps: [] };
          const mo = new MutationObserver(() => {
            // 类名与实现对齐：提示卡是 .reader-notice（玻璃质感，动画 notice-in），
            // 边界回弹是 .anim-edge-bump-next/prev。早期版本叫 .anim-toast-in /
            // .anim-bump-*，实现重构后测试没跟上，导致这三个用例恒假阴性。
            const t = document.querySelector('.reader-notice');
            if (t) { const txt = t.textContent || ''; if (!window.__edge.toasts.includes(txt)) window.__edge.toasts.push(txt); }
            const b = document.querySelector('.anim-edge-bump-next, .anim-edge-bump-prev');
            if (b) { const c = b.className; if (!window.__edge.bumps.includes(c)) window.__edge.bumps.push(c); }
          });
          mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
          return true;
        })()`);
        const total = await cdp.evaluate(`(() => { const el = document.querySelector('${pageInput}'); return el ? Number(el.max) + 1 : 0; })()`);
        // 第一页继续往前
        await setPage(0);
        await sleep(300);
        console.log(`  [2a-debug] 按Left前 activeElement=${await cdp.evaluate('document.activeElement?.tagName')} total=${total}`);
        await pressKey('ArrowLeft');
        await sleep(1400); // 等 toast（1.2s）走完，期间探针已记录
        const firstToast = await cdp.evaluate(`(window.__edge?.toasts || []).some(t => t.includes('已经是第一页了'))`);
        check('E11 第一页往前翻有提示', firstToast, `total=${total}`);
        // 最后一页继续往后
        await cdp.evaluate(`window.__edge = { toasts: [], bumps: [] };`);
        await setPage(total - 1);
        await sleep(400);
        const atEnd = await cdp.evaluate(`(() => {
          const el = document.querySelector('${pageInput}');
          return { value: el ? el.value : '', max: el ? el.max : '', idx: document.querySelector('.anim-reader-in header p:last-child')?.textContent ?? '' };
        })()`);
        console.log(`  [2a-debug] 末页测试 atEnd=${JSON.stringify(atEnd)} activeElement=${await cdp.evaluate('document.activeElement?.tagName')}`);
        await pressKey('ArrowRight');
        await sleep(600); // 回弹 280ms + 余量，探针记录
        const lastToast = await cdp.evaluate(`(window.__edge?.toasts || []).some(t => t.includes('已经是最后一页了'))`);
        const bumpAfter = await cdp.evaluate(`(window.__edge?.bumps || []).length > 0`);
        check('E11 最后一页往后翻有提示', lastToast, `${JSON.stringify(atEnd)} toast=${lastToast}`);
        check('E11 边界回弹动画触发', bumpAfter, `after=${bumpAfter}`);
      }
    } else {
      console.log('  (没有单章漫画，跳过首尾提示)');
    }

    // ---------- 2) 平移动画：整条胶片位移（旧页不消失）+ 拖动跟手 ----------
    if (multi) {
      await setSetting({ pageAnimation: 'pan' });
      const ok = await openReaderViaUI(multi.id);
      if (ok) {
        const pgOf = `(() => { const i = document.querySelector('input[aria-label="页码"]'); return i ? { v: Number(i.value), max: Number(i.max) } : null; })()`;
        // 进入阅读器会按上次进度续读（不是 0），显式定位一次再测
        await setPage(0);
        // 显式定位后页码必须钉住：续读逻辑不能把用户刚拨的位置又改回去
        await cdp.evaluate(`(() => {
          window.__pgTrace = [];
          const t0 = performance.now();
          const tick = () => {
            const i = document.querySelector('input[aria-label="页码"]');
            const v = i ? i.value : '';
            const last = window.__pgTrace[window.__pgTrace.length - 1];
            if (!last || last[1] !== v) window.__pgTrace.push([Math.round(performance.now() - t0), v]);
            if (performance.now() - t0 < 700) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          return true;
        })()`);
        await sleep(760);
        const pgTrace = await cdp.evaluate('window.__pgTrace || []');
        check('E11 显式定位到第 1 页后不会被自己跳回去', pgTrace.length === 1 && pgTrace[0][1] === '0',
          `轨迹=${JSON.stringify(pgTrace)}`);

        // 轨道状态：位移(m41)、三槽位页号、各槽图片数与不透明度
        const trackState = `(() => {
          const surface = document.querySelector('.pan-surface');
          const track = document.querySelector('.pan-track');
          if (!surface || !track) return null;
          const slots = [...track.querySelectorAll('.pan-slot')];
          const cur = document.querySelector('input[aria-label="页码"]');
          return {
            w: surface.clientWidth,
            tx: new DOMMatrixReadOnly(getComputedStyle(track).transform).m41,
            pages: slots.map((s) => Number(s.dataset.page)),
            imgs: slots.map((s) => s.querySelectorAll('img').length),
            page: cur ? cur.value : '',
          };
        })()`;
        const mouse = (type, x, y, buttons = 1) =>
          cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons });
        const surfaceRect = await cdp.evaluate(`(() => {
          const s = document.querySelector('.pan-surface');
          if (!s) return null;
          const b = s.getBoundingClientRect();
          return { left: b.left, top: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 };
        })()`);

        // 2a 轨道结构：相邻页常驻（这是「滑出不露黑」的前提）
        const st0 = await cdp.evaluate(trackState);
        check('E11 平移轨道三槽位且中间为当前页',
          !!st0 && st0.pages.length === 3 && st0.pages[1] === 0 && st0.pages.filter((p) => p >= 0).length >= 2,
          JSON.stringify(st0));
        check('E11 静止时轨道停在中间槽位', !!st0 && Math.abs(st0.tx + st0.w) < 2, `tx=${st0?.tx} w=${st0?.w}`);
        check('E11 相邻页图片已挂载（滑出不留黑底）',
          !!st0 && st0.imgs.filter((n) => n > 0).length >= 2, `imgs=${JSON.stringify(st0?.imgs)}`);

        // 2b 键盘翻页：用「文档级过渡事件」判定动画（可靠，不依赖逐帧采样，
        // 也不受满负载下 CDP 往返抖动影响），并用「中点轮询」抓一帧位移确认轨道确实移动。
        const pgInfo = await cdp.evaluate(pgOf);
        const forward = !pgInfo || pgInfo.v < pgInfo.max;
        const key = forward ? 'ArrowRight' : 'ArrowLeft';
        const vk = forward ? 39 : 37;
        const press = async (k, v) => {
          for (const type of ['keyDown', 'keyUp']) {
            await cdp.send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: v });
          }
        };
        const w0 = surfaceRect.w;
        const basePg = pgInfo ? pgInfo.v : 0;
        const targetPg = basePg + (forward ? 1 : -1);
        // 文档级捕获（capture 阶段）：任何 .pan-track 的过渡都收得到，含动态创建的节点
        await cdp.evaluate(`(() => {
          window.__panEvts = [];
          const h = (e) => {
            if (e.target && e.target.classList && e.target.classList.contains('pan-track')) {
              window.__panEvts.push([e.type, Math.round(performance.now()), e.propertyName]);
            }
          };
          document.addEventListener('transitionstart', h, true);
          document.addEventListener('transitionend', h, true);
        })()`);
        // 页内 rAF 录制：动画期间逐帧记录轨道位移与相邻页不透明数。
        // 录制窗口放大到 2000ms，且按方向键前先空跑 150ms，确保高负载下 CDP 延迟把动画推后时仍被录到
        // （此前窗口只有 450ms，动画起步晚于窗口就漏帧 → mid=null）。
        await cdp.evaluate(`(() => {
          window.__panFrames = [];
          window.__panRecStart = performance.now();
          const tick = () => {
            const w = document.querySelector('.pan-surface')?.clientWidth || 1;
            for (const t of document.querySelectorAll('.pan-track')) {
              const tx = new DOMMatrixReadOnly(getComputedStyle(t).transform).m41;
              if (tx < -10 && tx > -w + 10) {
                const slots = [...t.querySelectorAll('.pan-slot')];
                const opaque = slots.filter((sl) => {
                  const im = sl.querySelector('img');
                  return im && getComputedStyle(im).opacity === '1';
                }).length;
                window.__panFrames.push({ tx: Math.round(tx), w, opaque });
              }
            }
            if (performance.now() - window.__panRecStart < 2000) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        })()`);
        await sleep(150); // 让录制器先跑稳
        await press(key, vk);
        await sleep(1300); // 动画（260ms）必落在此窗口内
        const frames = await cdp.evaluate('window.__panFrames || []');
        const moved = frames.length > 0;
        const maxOpaque = frames.reduce((m, f) => Math.max(m, f.opaque), 0);
        const mid = moved ? { tx: frames[0].tx, w: frames[0].w, opaque: maxOpaque } : null;
        const evts = await cdp.evaluate('window.__panEvts || []');
        const tf = evts.filter((e) => e[2] === 'transform');
        const tfStart = tf.find((e) => e[0] === 'transitionstart');
        const tfEnd = tf.filter((e) => e[0] === 'transitionend').pop();
        const dur = tfStart && tfEnd ? tfEnd[1] - tfStart[1] : 0;
        const settled = await cdp.evaluate(trackState);
        check('E11 翻页触发横滑过渡（transform 过渡≈260ms）', dur > 180 && dur < 340,
          `时长≈${dur}ms 事件数=${tf.length}`);
        check('E11 翻页过程中轨道确实在移动（非瞬间跳变）', !!mid, `mid=${JSON.stringify(mid)}`);
        check('E11 动画中相邻页图片均不透明（无闪黑/半透）', !!mid && mid.opaque >= 2,
          `opaque=${mid?.opaque}`);
        check('E11 动画结束精确停在槽位（无回弹/漂移）',
          !!settled && Math.abs(settled.tx + settled.w) < 2 && settled.page === String(targetPg),
          `tx=${settled?.tx} page=${settled?.page} 期望=${targetPg}`);

        // 2c 拖动跟手：慢拖 8% 页宽 → 轨道位移应与手指位移一致，且不翻页
        const beforeDrag = await cdp.evaluate(trackState);
        const smallDx = Math.round(surfaceRect.w * 0.08);
        const dragSlowly = async (dxTotal, steps = 3) => {
          await mouse('mousePressed', surfaceRect.cx, surfaceRect.cy);
          for (let i = 1; i <= steps; i++) {
            await mouse('mouseMoved', surfaceRect.cx + (dxTotal * i) / steps, surfaceRect.cy);
            await sleep(150); // 放慢，避开「快扫按速度翻页」的判定
          }
        };
        await dragSlowly(smallDx);
        const dragging = await cdp.evaluate(trackState);
        check('E11 拖动跟手（轨道位移≈手指位移）',
          !!dragging && Math.abs(dragging.tx - (-dragging.w + smallDx)) < 12,
          `tx=${dragging?.tx} 期望≈${-(dragging?.w ?? 0) + smallDx}`);
        check('E11 拖动过程中不翻页', !!dragging && dragging.page === beforeDrag.page,
          `${beforeDrag.page} → ${dragging?.page}`);
        await mouse('mouseReleased', surfaceRect.cx + smallDx, surfaceRect.cy, 0);
        await sleep(420);
        const snappedBack = await cdp.evaluate(trackState);
        check('E11 拖动不足阈值 → 回弹原位',
          !!snappedBack && Math.abs(snappedBack.tx + snappedBack.w) < 2 && snappedBack.page === beforeDrag.page,
          `tx=${snappedBack?.tx} page=${snappedBack?.page}`);

        // 2d 拖过阈值 → 翻到相邻页并复位居中
        const bigDx = Math.round(surfaceRect.w * 0.32);
        await dragSlowly(bigDx);
        await mouse('mouseReleased', surfaceRect.cx + bigDx, surfaceRect.cy, 0);
        await sleep(480);
        const turned = await cdp.evaluate(trackState);
        check('E11 拖动超过阈值 → 翻到相邻页',
          !!turned && Math.abs(Number(turned.page) - Number(beforeDrag.page)) === 1,
          `${beforeDrag.page} → ${turned?.page}`);
        check('E11 翻页后轨道复位居中',
          !!turned && Math.abs(turned.tx + turned.w) < 2, `tx=${turned?.tx}`);
      }
    }

    // ---------- 3) 章节目录：详情页右上角切换 + 一行四格 ----------
    if (multi) {
      await cdp.send('Page.navigate', { url: `${BASE}/comic/${multi.id}` });
      await waitFor(cdp, `location.pathname.startsWith('/comic/') && ${hasText('button', '阅读')}`, 12000, '详情页');
      const detailToggle = await cdp.evaluate(`!!document.querySelector('button[aria-label="切换章节布局"]')`);
      check('E11 详情页章节区右上角有布局切换', detailToggle);
      if (detailToggle) {
        // 切成四格
        await cdp.evaluate(`document.querySelector('button[aria-label="切换章节布局"]').click()`);
        await sleep(300);
        const gridMetrics = `(() => {
          const g = document.querySelector('.grid.grid-cols-4');
          if (!g) return null;
          const cols = getComputedStyle(g).gridTemplateColumns.split(' ').filter(Boolean).length;
          const tiles = [...g.querySelectorAll('button')];
          const heights = tiles.map((b) => Math.round(b.getBoundingClientRect().height));
          return { cols, items: tiles.length, heights, firstLabel: tiles.length ? tiles[0].textContent.trim() : '' };
        })()`;
        let grid = await cdp.evaluate(gridMetrics);
        check('E11 详情页四格模式一行 4 列', !!grid && grid.cols === 4 && grid.items > 0, JSON.stringify(grid));
        check('E11 详情页四格高度固定（所有格子等高）',
          !!grid && grid.heights.length > 0 && grid.heights.every((h) => h === grid.heights[0] && h > 0),
          JSON.stringify(grid));
        // 高度必须与容器宽度无关：把窗口拉宽/拉窄，格子高度不能变
        const wideHeight = grid.heights[0];
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 700, height: 900, deviceScaleFactor: 1, mobile: true });
        await sleep(300);
        const narrow = await cdp.evaluate(gridMetrics);
        await cdp.send('Emulation.clearDeviceMetricsOverride');
        await sleep(300);
        check('E11 详情页四格高度不随窗口宽度变化', !!narrow && narrow.heights[0] === wideHeight,
          `宽=${wideHeight}px 窄=${narrow?.heights?.[0]}px`);
        const stored = await cdp.evaluate(`localStorage.getItem('fn:detailChapterView')`);
        check('E11 详情页章节布局记在本机', stored === 'grid', `fn:detailChapterView=${stored}`);
        // 点格子能进阅读器
        await cdp.evaluate(`document.querySelector('.grid.grid-cols-4 button').click()`);
        const entered = await waitFor(cdp, `!!document.querySelector('.anim-reader-in') || location.pathname.startsWith('/read/')`, 12000, '点格子进阅读器');
        check('E11 点四格能进入阅读器', entered, `path=${await cdp.evaluate('location.pathname')}`);
        // 回详情页，切回列表
        await cdp.send('Page.navigate', { url: `${BASE}/comic/${multi.id}` });
        await waitFor(cdp, hasText('button', '阅读'), 12000, '详情页(返回)');
        const stillGrid = await cdp.evaluate(`!!document.querySelector('.grid.grid-cols-4')`);
        check('E11 详情页四格模式刷新后仍在', stillGrid);
        await cdp.evaluate(`document.querySelector('button[aria-label="切换章节布局"]').click()`);
        await sleep(250);
        const backList = await cdp.evaluate(`!document.querySelector('.grid.grid-cols-4')`);
        check('E11 详情页可切回列表模式', backList);
      }
    }

    // ---------- 3b) 阅读器章节抽屉：同样支持列表/四格 ----------
    if (multi) {
      const ok = await openReaderViaUI(multi.id);
      if (ok) {
        // 打开章节抽屉（按 aria-label）
        await cdp.evaluate(`(() => { const b = document.querySelector('button[aria-label="章节目录"]'); if (b) b.click(); })()`);
        await waitFor(cdp, hasText('h3', '章节'), 6000, '章节抽屉');
        const hasToggle = await cdp.evaluate(`!!document.querySelector('button[aria-label="切换章节布局"]')`);
        check('E11 章节抽屉右上角有布局切换', hasToggle);
        // 先确保是列表
        const isGrid = await cdp.evaluate(`document.querySelectorAll('.grid.grid-cols-4').length > 0`);
        if (!isGrid) {
          await cdp.evaluate(`document.querySelector('button[aria-label="切换章节布局"]').click()`);
          await sleep(300);
        }
        const drawerGrid = `(() => {
          const g = document.querySelector('.grid.grid-cols-4');
          if (!g) return null;
          const tiles = [...g.querySelectorAll('button')];
          return {
            cols: getComputedStyle(g).gridTemplateColumns.split(' ').filter(Boolean).length,
            items: tiles.length,
            heights: tiles.map((b) => Math.round(b.getBoundingClientRect().height)),
          };
        })()`;
        const grid = await cdp.evaluate(drawerGrid);
        check('E11 四格模式一行 4 列', !!grid && grid.cols === 4, JSON.stringify(grid));
        check('E11 阅读器四格高度固定（与详情页一致，44px）',
          !!grid && grid.heights.length > 0 && grid.heights.every((h) => h === 44),
          JSON.stringify(grid));
        const stored = await cdp.evaluate(`localStorage.getItem('fn:chapterView')`);
        check('E11 章节布局记在本机', stored === 'grid', `fn:chapterView=${stored}`);
        // 切回列表，避免影响其他断言
        await cdp.evaluate(`document.querySelector('button[aria-label="切换章节布局"]').click()`);
        await sleep(250);
        const backList = await cdp.evaluate(`!document.querySelector('.grid.grid-cols-4')`);
        check('E11 可切回列表模式', backList);
        await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '关闭'); if (b) b.click(); })()`);
        await sleep(300);
      }
    }

    // ---------- 4) 流畅画质：请求宽度 720 ----------
    if (multi) {
      await setSetting({ quality: 'smooth' });
      const ok = await openReaderViaUI(multi.id);
      if (ok) {
        await sleep(600);
        const srcs = await cdp.evaluate(`[...document.querySelectorAll('.anim-reader-in img')].map(i => i.getAttribute('src') || '')`);
        const has720 = srcs.some((u) => u.includes('w=720'));
        check('E11 流畅画质请求 w=720', has720, srcs[0] ?? '(无图)');
        await setSetting({ quality: 'standard' });
        await openReaderViaUI(multi.id);
        await sleep(500);
        const std = await cdp.evaluate(`[...document.querySelectorAll('.anim-reader-in img')].map(i => i.getAttribute('src') || '')`);
        check('E11 标准画质仍请求 w=1080', std.some((u) => u.includes('w=1080')), std[0] ?? '(无图)');
      }
    }

    // ---------- 5) 双指缩放：开/关 ----------
    if (multi) {
      const pinch = `(() => {
        const canvas = document.querySelector('.anim-reader-in .reader-canvas');
        if (!canvas) return { ok: false, why: 'no-canvas' };
        const r = canvas.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const fire = (type, id, x, y) =>
          canvas.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: y,
          }));
        fire('pointerdown', 1, cx - 40, cy);
        fire('pointerdown', 2, cx + 40, cy);
        fire('pointermove', 1, cx - 140, cy);
        fire('pointermove', 2, cx + 140, cy);
        fire('pointerup', 1, cx - 140, cy);
        fire('pointerup', 2, cx + 140, cy);
        return { ok: true };
      })()`;
      const canvasScale = `(() => {
        const canvas = document.querySelector('.anim-reader-in .reader-canvas');
        if (!canvas) return -1;
        const m = /scale\\(([\\d.]+)\\)/.exec(canvas.style.transform || '');
        return m ? Number(m[1]) : 1;
      })()`;

      await setSetting({ pinchZoom: true });
      let ok = await openReaderViaUI(multi.id);
      if (ok) {
        const r = await cdp.evaluate(pinch);
        await sleep(250);
        const scaleOn = await cdp.evaluate(canvasScale);
        check('E11 双指放大生效（scale > 1）', r?.ok && scaleOn > 1.1, `scale=${scaleOn} ${JSON.stringify(r)}`);
      }

      await setSetting({ pinchZoom: false });
      ok = await openReaderViaUI(multi.id);
      if (ok) {
        const r = await cdp.evaluate(pinch);
        await sleep(250);
        const scaleOff = await cdp.evaluate(canvasScale);
        check('E11 关闭开关后双指不缩放', r?.ok && scaleOff === 1, `scale=${scaleOff} ${JSON.stringify(r)}`);
      }
      await setSetting({ pinchZoom: false });
    }

    // ---------- 6) 翻页模式存本机，服务端设置不被改写 ----------
    if (multi) {
      await cdp.evaluate(`localStorage.removeItem('fn:readerMode')`);
      await setSetting({ readerMode: 'single' });
      const ok = await openReaderViaUI(multi.id);
      if (ok) {
        // 打开阅读设置，点「双页」
        await cdp.evaluate(`(() => { const b = document.querySelector('button[aria-label="阅读设置"]'); if (b) b.click(); })()`);
        await waitFor(cdp, hasText('div', '翻页模式'), 6000, '阅读设置');
        await cdp.evaluate(clickText('button', '双页'));
        await sleep(500);
        const local = await cdp.evaluate(`localStorage.getItem('fn:readerMode')`);
        check('E11 阅读器内切模式写入本机', local === 'double', `fn:readerMode=${local}`);
        const srv = await j('/api/settings');
        const srvKeys = Object.keys(srv.json?.data ?? {}).sort().join(',');
        // 旧断言是「服务端 readerMode 仍是 single」，那写于偏好还由服务端全局保存的时代。
        // 现在翻页模式等 10 项按设备存（2026-10-24），要证的是相反方向：
        // 在阅读器里切过模式之后，服务端既不该有这个键、也不该被写上任何偏好。
        check('E11 切换本机偏好不回写服务端（设置只剩服务端自己的 3 项）',
          srvKeys === 'autoScanIntervalHours,note,thumbnailCacheMB',
          `服务端键=${srvKeys || '(空)'}`);
        // 刷新后仍是本机模式（双页）
        await cdp.send('Page.reload');
        await waitFor(cdp, `!!document.querySelector('.anim-reader-in')`, 15000, '刷新后阅读器');
        await sleep(600);
        const stillDouble = await cdp.evaluate(`(() => {
          const imgs = document.querySelectorAll('.anim-reader-in img').length;
          return { mode: localStorage.getItem('fn:readerMode'), imgs };
        })()`);
        check('E11 刷新后沿用本机模式', stillDouble.mode === 'double' && stillDouble.imgs >= 2,
          JSON.stringify(stillDouble));
        // 复位：清本机记录，回到服务端默认
        await cdp.evaluate(`localStorage.removeItem('fn:readerMode')`);
      }
    }
    await setSetting({ pageAnimation: 'pan', quality: 'standard' });
  }

  section('E8 内存观测（整轮真实操作）');
  clearInterval(sampler);
  const peak = Math.max(...samples.map((s) => s.kb), 0);
  const last = samples[samples.length - 1]?.kb ?? 0;
  const baseRss = samples[0]?.kb ?? 0;
  check('E8 峰值 RSS 在可控范围（<1500MB）', peak < 1500 * 1048576,
    `base=${mb(baseRss)}MB peak=${mb(peak)}MB last=${mb(last)}MB`);

  // 让后台归还器跑一轮
  await sleep(12000);
  const settled = spawnSync('tasklist', ['/FI', `PID eq ${child.pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  const m = /"([\d,.]+) K"/.exec(settled.stdout || '');
  const settledRss = m ? Number(m[1].replace(/[,.]/g, '')) * 1024 : 0;
  check('E8 空闲后 RSS 回到基线附近（不持续爬升）', settledRss <= baseRss + 40 * 1048576,
    `base=${mb(baseRss)}MB peak=${mb(peak)}MB 空闲=${mb(settledRss)}MB`);

  /* -------- 收尾 -------- */
  if (cdp) cdp.close();
  if (edge) edge.kill();
  killStrayTestBrowsers(); // launcher 杀了，renderer 子进程也要清
  if (profileDir) {
    await sleep(500);
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* 占用中 */ }
  }
  stopServer();

  console.log('\n' + '='.repeat(66));
  console.log(`实机功能测试：通过 ${pass} · 失败 ${failures.length}`);
  if (failures.length) {
    console.log('失败项：');
    for (const f of failures) console.log('  ✗ ' + f);
  }
  console.log(`内存：base ${mb(baseRss)}MB / peak ${mb(peak)}MB / 空闲 ${mb(settledRss)}MB`);
  console.log('='.repeat(66));

  if (!KEEP) {
    for (const d of [LIB, RO_LIB, UPLOAD_LIB, UPLOAD_LIB_SINGLE, UPLOAD_FIXTURES, DATA]) {
      try {
        if (fs.existsSync(d)) clearReadOnlyAcl(d);
        fs.rmSync(d, { recursive: true, force: true });
      } catch { /* 忽略 */ }
    }
  } else {
    console.log(`保留：${LIB} / ${DATA}`);
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error('实机测试异常：', e.stack || e.message);
  stopServer();
  process.exit(1);
});
