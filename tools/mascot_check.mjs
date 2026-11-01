/**
 * 吉祥物状态页校验。
 *
 * 校验项：
 *   1) 404 页真实存在（不再静默重定向），吉祥物插画与文案就位
 *   2) 亮 / 暗主题切换插画自动换版（status-*.webp ↔ status-*-dark.webp）
 *   3) 搜索空态（放大镜娘）出现在两个空场景（未输入 / 无结果）
 *   4) 错误态（摊手娘）出现在列表加载失败时，且重试可用
 *   5) 列表空态（抱书娘）在空数据下出现
 *   6) 登录页吉祥物就位（门禁开启时页面停留而不是跳走）
 *   7) 待机浮动动画受 prefers-reduced-motion 压制
 *   8) 手机视口 390px 下插画不出血、不把按钮挤出屏幕
 *   9) 等待页：首屏守卫先沿用启动壳（≤600ms），超过才换成带吉祥物的等待页；
 *      列表级仍是 600ms 门槛
 *   10) 阅读器加载卡上的白色系插画（纯黑底专用）
 *
 * 拦截用 CDP Fetch 域而不是页内覆写 window.fetch：auth/status 与 comics
 * 都发生在路由挂载瞬间，页内覆写无法跨硬导航存活。
 *
 * 用法：node tools/mascot_check.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP = 'http://127.0.0.1:5173';
// 前端请求走同源 + Vite 代理，浏览器里看到的 host 是 5173 不是 13800，
// 拦截 pattern 必须写 5173（写 13800 一条都拦不到，这是本探针第一版的坑）
const REQ_HOST = '127.0.0.1:5173';

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const PORT = 9731;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-mascot-'));
const edge = spawn(
  EDGE,
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1280,900', 'about:blank'],
  { stdio: 'ignore' },
);

let wsUrl;
for (let i = 0; i < 80; i++) {
  try {
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = t.find((x) => x.type === 'page');
    if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch { /* 等 CDP */ }
  await sleep(150);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pend = new Map();
/** Fetch.requestPaused 的处理函数。默认放行：RequireAuth 每次导航都会查
 * auth/status，不放行的话整页会卡在登录检查里（pattern 匹配到的请求若
 * 没人应答会永久挂起）。探针各阶段用 mode 覆盖这个默认行为。 */
let pauseHandler = (p) => send('Fetch.continueRequest', { requestId: p.requestId });
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Fetch.requestPaused') {
    pauseHandler?.(m.params);
    return;
  }
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
});
const send = (m, p = {}) => new Promise((res) => {
  const id = ++seq;
  pend.set(id, res);
  ws.send(JSON.stringify({ id, method: m, params: p }));
});
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) console.error('[evaluate 异常]', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r?.result?.value;
};
await send('Page.enable');
await send('Runtime.enable');
await send('Fetch.enable', {
  patterns: [
    { urlPattern: `*://${REQ_HOST}/api/comics*` },
    { urlPattern: `*://${REQ_HOST}/api/auth/*` },
    // 列表级门槛用 /libraries 造干等：它 75 行是 <Loading>（默认 600ms 那档）
    { urlPattern: `*://${REQ_HOST}/api/libraries*` },
  ],
});

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? `  ${extra}` : ''}`); }
};

const SHOT = (n) => send('Page.captureScreenshot', { format: 'png' }).then((r) => {
  fs.mkdirSync('tools/_shots', { recursive: true });
  fs.writeFileSync(`tools/_shots/_mascot-${n}.png`, Buffer.from(r.data, 'base64'));
});

/** 吉祥物元素状态：类名 → 背景 URL / 尺寸 / 位置 */
const mascot = async (sel) => JSON.parse((await ev(`JSON.stringify((() => {
  const el = document.querySelector('${sel}');
  if (!el) return null;
  const s = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return { bg: s.backgroundColor, mask: s.maskImage || s.webkitMaskImage,
           w: Math.round(r.width), h: Math.round(r.height),
           bottomGap: Math.round(window.innerHeight - r.bottom), animDur: s.animationDuration };
})())`)) || 'null');

const navigate = async (url, ms = 2200) => {
  await send('Page.navigate', { url });
  await sleep(ms);
};
const setVP = (w, h, mobile) =>
  send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });

// ---------- 1) 404 页 ----------
await setVP(1280, 900, false);
await navigate(`${APP}/definitely-missing-xyz`);
ok('404 页不再静默重定向', location_ok(await ev('location.pathname')), `path=${await ev('location.pathname')}`);
ok('404 文案就位', (await ev(`document.body.innerText.includes('这一页走丢了呢')`)) === true);
let m = await mascot('.mascot-404');
ok('404 吉祥物显示', !!m && m.h >= 170, `${m?.h}px`);
ok('插画用 mask 着色（与标题同源 ink-300）',
  !!m && m.mask.includes('status-404.webp') && m.bg === 'rgb(55, 65, 81)',
  `bg=${m?.bg} mask=${m?.mask?.slice(0, 48)}`);
await SHOT('404-light');

// 主题切到暗色：素材不变，着色应自动跟随 ink-300 的暗色值
await ev(`document.documentElement.classList.add('dark')`);
await sleep(150);
m = await mascot('.mascot-404');
ok('暗色下插画色自动跟随文字色', !!m && m.bg === 'rgb(176, 184, 200)', `bg=${m?.bg}`);
ok('暗色插画尺寸不变', !!m && m.h >= 170, `${m?.h}px`);
await SHOT('404-dark');
await ev(`document.documentElement.classList.remove('dark')`);

function location_ok(p) { return p === '/definitely-missing-xyz'; }

// ---------- 2) 搜索空态 ----------
await navigate(`${APP}/search`);
m = await mascot('.mascot-search');
ok('搜索空态（放大镜娘）显示', !!m, `${m?.h}px`);
ok('空态文案就位', (await ev(`document.body.innerText.includes('输入关键词开始搜索')`)) === true);
await SHOT('search-light');

// ---------- 3) 列表加载失败 → 摊手娘 ----------
pauseHandler = (p) => {
  if (p.request.url.includes('/api/comics')) {
    send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Failed' });
    return;
  }
  send('Fetch.continueRequest', { requestId: p.requestId });
};
await navigate(`${APP}/`, 2600);
m = await mascot('.mascot-load-failed');
ok('错误态吉祥物显示', !!m, `${m?.h}px`);
ok('错误态保留 role=alert 与重试', (await ev(`!!document.querySelector('[role="alert"] button')`)) === true);
await SHOT('error-light');

// ---------- 4) 空列表 → 抱书娘（重试路径走 fulfill） ----------
const emptyBody = Buffer.from(
  JSON.stringify({ code: 0, data: { hasMore: false, items: [], total: 0, page: 1, pageSize: 36 } }),
).toString('base64');
pauseHandler = (p) => {
  if (p.request.url.includes('/api/comics')) {
    send('Fetch.fulfillRequest', {
      requestId: p.requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: emptyBody,
    });
    return;
  }
  send('Fetch.continueRequest', { requestId: p.requestId });
};
await ev(`document.querySelector('[role="alert"] button').click()`);
await sleep(1600);
m = await mascot('.mascot-empty');
ok('空列表吉祥物显示（重试后生效）', !!m, `${m?.h}px`);
ok('空态带「去添加」出口', (await ev(`!!document.querySelector('.animate-rise a[href="/libraries"]')`)) === true);
await SHOT('empty-light');

// ---------- 5) 登录页 ----------
const authBody = Buffer.from(
  JSON.stringify({ code: 0, data: { enabled: true, authenticated: false, hasCredential: true } }),
).toString('base64');
pauseHandler = (p) => {
  if (p.request.url.includes('/api/auth/')) {
    send('Fetch.fulfillRequest', {
      requestId: p.requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: authBody,
    });
    return;
  }
  send('Fetch.continueRequest', { requestId: p.requestId });
};
await navigate(`${APP}/login`, 2400);
ok('门禁开启时登录页停留', (await ev('location.pathname')) === '/login');
m = await mascot('.mascot-login');
ok('登录页吉祥物显示', !!m, `${m?.h}px`);
await SHOT('login-light');

// ---------- 6) 减少动态效果：浮动被压制 ----------
// 登录阶段把 auth/status 拦成了「已开启门禁且未登录」，不恢复的话
// RequireAuth 会把后面所有页面踢回 /login，这里必须恢复默认放行
pauseHandler = (p) => send('Fetch.continueRequest', { requestId: p.requestId });
await send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
});
await navigate(`${APP}/search`, 2200);
m = await mascot('.mascot-search');
ok('插画无持续动画（浮动已按需求移除）', !!m && parseFloat(m.animDur) <= 0.01, `animationDuration=${m?.animDur}`);
await send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
});

// ---------- 7) 手机视口 ----------
await setVP(390, 844, true);
await navigate(`${APP}/search`, 2200);
m = await mascot('.mascot-search');
ok('390px 下插画不出血', !!m && m.bottomGap >= 0, `距底 ${m?.bottomGap}px`);
ok('390px 下出口按钮在屏内', (await ev(`(() => { const a = document.querySelector('a[href="/libraries"]'); return a ? a.getBoundingClientRect().top < window.innerHeight : true; })()`)) === true);
await SHOT('search-390');

// 无结果空态（带关键词）也用放大镜娘
await navigate(`${APP}/search?q=%E4%B8%8D%E5%AD%98%E5%9C%A8%E7%9A%84%E4%B9%A6`, 2400);
m = await mascot('.mascot-search');
ok('无结果空态同为放大镜娘', !!m, `${m?.h}px`);

/**
 * 等待页插画的可见性快照。
 * Loading 里的插画是常驻占位 + opacity 淡入（避免中途撑高抖动），
 * 光看「元素在不在」永远为真，必须按 checkVisibility 的可见口径判定。
 */
const seenMascot = (sel) => ev(`JSON.stringify((() => {
  const el = document.querySelector('${sel}');
  if (!el) return null;
  const wrap = el.parentElement;
  return {
    vis: el.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
    op: Number(getComputedStyle(wrap).opacity).toFixed(2),
    h: Math.round(el.getBoundingClientRect().height),
    color: getComputedStyle(el).backgroundColor,
  };
})())`).then((s) => JSON.parse(s || 'null'));

// ---------- 8) 等待页吉祥物：启动壳 → 等待页 ----------
// 2026-10-28 起首屏守卫不再直接显示等待页（限速实测：弱网下这一屏只活 206ms，
// 而吉祥物从挂载到完全可见要 320ms，物理上来不及）。现在的策略：
//   0–600ms  继续显示启动壳（与 index.html 里那份同构，切换无接缝）
//   >600ms   换成等待页，吉祥物**立刻**在场（variant="after-boot"，门槛 0 + 淡入 300）
// 列表级仍是 600ms 门槛（内容区反复出现，防闪仍然必要）。
//
// 量法：页面内 performance.now() 打点。别拿 Page.navigate 当原点（app 要先 boot），
// 也别用 CDP 轮询推算挂载时刻（每次 evaluate 10–60ms 往返，会把门槛量短）。
await setVP(1280, 900, false);
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const t0 = performance.now();
    window.__mascotT = null;
    const iv = setInterval(() => {
      const el = document.querySelector('.mascot-loading');
      if (!el) return;
      const now = performance.now() - t0;
      const st = window.__mascotT || (window.__mascotT = { firstSeen: now, full: null });
      if (Number(getComputedStyle(el.parentElement).opacity) > 0.98 && st.full === null) st.full = now;
    }, 16);
    setTimeout(() => clearInterval(iv), 9000);
  })();`,
});

/** 等页面内打点出现 full，返回 { firstSeen, full, delta }（都是页面内的毫秒） */
async function measureMascot(limitMs = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < limitMs) {
    const t = await ev('JSON.stringify(window.__mascotT)').then((s) => JSON.parse(s || 'null'));
    if (t?.full != null) return { ...t, delta: Math.round(t.full - t.firstSeen) };
    await sleep(60);
  }
  const t = await ev('JSON.stringify(window.__mascotT)').then((s) => JSON.parse(s || 'null'));
  return { ...(t || { firstSeen: null, full: null }), delta: null };
}

const onlySlow = (frag, ms) => (p) => {
  if (p.request.url.includes(frag)) setTimeout(() => send('Fetch.continueRequest', { requestId: p.requestId }), ms);
  else send('Fetch.continueRequest', { requestId: p.requestId });
};

// 8a) 首屏守卫：0–600ms 用启动壳，之后才换等待页
pauseHandler = onlySlow('/api/auth/', 1500);
await send('Page.navigate', { url: `${APP}/` });
await sleep(350); // 壳保持期内
const earlyBoot = await ev(`!!document.querySelector('.boot')`);
const earlyMascot = await seenMascot('.mascot-loading');
ok('首屏等待 ≤600ms 期间仍显示启动壳', earlyBoot === true, `boot=${earlyBoot}`);
ok('首屏等待 ≤600ms 期间不出现等待页插画', earlyMascot === null,
  earlyMascot ? `opacity=${earlyMascot.op}` : '无节点');
await SHOT('boot-shell'); // 留档：壳保持期长什么样（应与 index.html 的静态壳一致）
await sleep(800); // 累计 ~1.15s：已过 600ms 壳保持期
const lateMascot = await seenMascot('.mascot-loading');
const lateBoot = await ev(`!!document.querySelector('.boot')`);
ok('超过 600ms 换成等待页且吉祥物已在场', !!lateMascot && Number(lateMascot.op) > 0.9, `opacity=${lateMascot?.op}`);
ok('换页后启动壳已卸载', lateBoot === false, `boot=${lateBoot}`);
ok('等待插画尺寸 96px', lateMascot?.h === 96, `${lateMascot?.h}px`);
await SHOT('loading-wait-gate');

// 8b) 列表级：auth 放行，只压漫画库接口（门槛 600ms + 淡入 300ms）
pauseHandler = onlySlow('/api/libraries', 1500);
await send('Page.navigate', { url: `${APP}/libraries` });
const listM = await measureMascot();
ok('列表门槛内不露脸（≥600ms 才完全可见）', listM.delta !== null && listM.delta >= 600, `挂载→可见 ${listM.delta}ms`);
ok('列表 600ms+淡入 300ms 内出场（≤1200ms）', listM.delta !== null && listM.delta <= 1200, `挂载→可见 ${listM.delta}ms`);
await SHOT('loading-wait-list');

// 真实速度：整段等待只有几十毫秒，插画一次都不该出现（局域网实测 ≤95ms）
pauseHandler = (p) => send('Fetch.continueRequest', { requestId: p.requestId });
await navigate(`${APP}/`, 1600);
const fast = await seenMascot('.mascot-loading');
ok('快加载时等待页完全不出插画', fast === null || fast.vis === false, `vis=${fast?.vis}`);

// ---------- 9) 阅读器加载卡：纯黑底专用白色系 ----------
const list = ((await (await fetch('http://127.0.0.1:13800/api/comics?page=1&pageSize=3')).json()).data?.items) || [];
const pick = list[0];
pauseHandler = (p) => setTimeout(() => send('Fetch.continueRequest', { requestId: p.requestId }), 2000);
await send('Page.navigate', { url: `${APP}/read/${pick.id}/${encodeURIComponent(`${pick.id}#0`)}` });
// 阅读器同样被 RequireAuth 挡在前头，同一份延迟也压住了 auth/status —— 实测要
// 约 2.4s 才轮到加载卡，之后才是插画的 700ms 门槛。故此处的等待必须轮询而不是定值。
let rm = null;
for (let i = 0; i < 40; i++) {
  await sleep(150);
  rm = await seenMascot('.mascot-light');
  if (rm?.vis) break;
}
// 是 300ms 渐显，一见到就断言会抓到刚起步的 0.02，等它淡完
await sleep(420);
rm = await seenMascot('.mascot-light');
ok('阅读器加载卡出现插画', !!rm && rm.vis === true && Number(rm.op) > 0.9, `opacity=${rm?.op} 高度=${rm?.h}px`);
// 这一层刻意不再有骨架/纸页：除了返回按钮和一行字，画面上只有吉祥物
ok('阅读器加载卡没有骨架占位', (await ev(`document.querySelectorAll('.skeleton').length`)) === 0);
ok('加载卡保留返回出口', (await ev(`!!document.querySelector('[role="status"] button')`)) === true);
ok('加载卡写着在读什么', (await ev(`/正在载入页面…|打开漫画…/.test(document.body.innerText)`)) === true);
await SHOT('reader-waiting');
pauseHandler = (p) => send('Fetch.continueRequest', { requestId: p.requestId });

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close();
edge.kill();
process.exit(fail === 0 ? 0 : 1);
