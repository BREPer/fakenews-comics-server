/**
 * 多设备视口 UI 探针（Edge headless + 裸 CDP，无三方依赖）。
 *
 * 用途：适配安卓平板 / 手机 / 桌面后，验证各视口下布局无硬伤——
 *   横向溢出、导航模式与宽度档位匹配、底部内容不被 Tab 栏遮挡、
 *   阅读器铺满视口且工具栏在界内、横竖屏切换后画面保持。
 *
 * 设备档案（CSS 像素，近似真实设备）：
 *   平板竖屏 800×1280（Galaxy Tab 类）｜平板横屏 1280×800
 *   手机 390×844（iPhone 类）｜手机横屏 844×390｜桌面 1440×900
 * 手机/平板走 mobile 模拟（touch 事件 + device-width 视口）。
 *
 * 用法：node tools/viewport_probe.mjs [baseUrl] [--shots]
 *   baseUrl 默认 http://127.0.0.1:14201
 *   --shots 额外输出每设备每页截图到 tools/_shots/vp-*.png（默认也输出，加此参数无副作用，保留兼容）
 *
 * 进入阅读器走真实流程：详情页点第一章按钮（复用应用自身路由，不手拼 URL）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:14201';
const SHOTS = true; // 始终输出截图，便于人工复核
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CDP_PORT = 9351;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-vp-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 设备档案 ---------------- */
const DEVICES = [
  { id: 'tablet-portrait', w: 800, h: 1280, dsf: 2, mobile: true, expectNav: 'rail' },
  { id: 'tablet-landscape', w: 1280, h: 800, dsf: 2, mobile: true, expectNav: 'sidebar' },
  { id: 'phone', w: 390, h: 844, dsf: 3, mobile: true, expectNav: 'bottom' },
  // 手机横屏宽度 844 ≥ 640 断点，按设计走图标 Rail（非底 Tab）——这是预期行为不是缺陷
  { id: 'phone-landscape', w: 844, h: 390, dsf: 3, mobile: true, expectNav: 'rail' },
  { id: 'desktop', w: 1440, h: 900, dsf: 1, mobile: false, expectNav: 'sidebar' },
];

/* ---------------- CDP 客户端（同 about_shot.mjs） ---------------- */
async function waitCdp() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not ready */ }
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

function client(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
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
  return { ready, send, evaluate, close: () => ws.close() };
}

/* ---------------- 页面内诊断（序列化进 Runtime.evaluate） ---------------- */
const DIAG = `(() => {
  const de = document.documentElement;
  const vw = de.clientWidth, vh = de.clientHeight;
  const out = {
    vw, vh,
    docOverflowX: de.scrollWidth - vw,
    offenders: [],
    nav: { sidebar: false, rail: false, bottom: false },
    gridCols: 0,
    reader: null,
  };
  // 越界元素：排除横向滚动容器内的（那些本就该滑出屏幕）
  const inScroller = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true;
    }
    return false;
  };
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (r.right > vw + 1 || r.left < -1) {
      if (!inScroller(el)) {
        const cls = (el.className || '').toString().split(' ').slice(0, 3).join('.');
        out.offenders.push(el.tagName.toLowerCase() + (cls ? '.' + cls : '') + ' [' + Math.round(r.left) + ',' + Math.round(r.right) + ']');
      }
    }
  }
  // 导航模式：aside×2（sidebar/rail）+ 底部固定 nav
  const asides = [...document.querySelectorAll('aside')];
  for (const a of asides) {
    if (getComputedStyle(a).display === 'none') continue;
    const w = a.getBoundingClientRect().width;
    if (w > 150) out.nav.sidebar = true;
    else if (w > 0) out.nav.rail = true;
  }
  // 主区与可见侧栏并排：根容器若不是 flex，sticky+h-dvh 的侧栏会在流里占满一屏高，
  // 把 main 顶到首屏外（平板竖屏 800px 曾踩中：main.top = 1280，打开只看到图标列）
  const mainEl = document.querySelector('main');
  const visAside = asides.find((a) => getComputedStyle(a).display !== 'none');
  if (mainEl && visAside) {
    const mr = mainEl.getBoundingClientRect();
    const ar = visAside.getBoundingClientRect();
    out.sideBySide = mr.top < 50 && Math.abs(mr.left - ar.right) <= 2 && mr.width > vw * 0.5;
  } else {
    out.sideBySide = null; // 无侧栏设备（<640）不适用
  }
  const bn = document.querySelector('nav.fixed');
  if (bn && getComputedStyle(bn).display !== 'none' && bn.getBoundingClientRect().height > 0) out.nav.bottom = true;
  // 封面网格列数
  const grid = document.querySelector('.comic-grid');
  if (grid) {
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean);
    out.gridCols = cols.length;
  }
  // 阅读器
  const reader = [...document.querySelectorAll('div')].find((d) => (d.className || '').toString().includes('anim-reader-in'));
  if (reader) {
    const rr = reader.getBoundingClientRect();
    // 平移动画是「三槽位轨道」（.pan-slot[data-page]），整条轨道 300% 宽并整体左移，
    // 直接取第一个 img 会抓到**前一页**的槽位（rect.left 是负数）。这里只取当前页：
    // 优先取落在视口内的槽位，没有（非 pan 模式）再退回第一个 img。
    const slots = [...reader.querySelectorAll('.pan-slot[data-page]')];
    const curSlot = slots.find((s) => {
      const r = s.getBoundingClientRect();
      return r.left >= -1 && r.right <= vw + 1;
    });
    const img = curSlot ? curSlot.querySelector('img') : reader.querySelector('img');
    const btns = [...reader.querySelectorAll('header button, footer button')];
    out.reader = {
      // 「铺满视口」的判据：贴住左上角、高度撑满、宽度接近视口。
      // 宽度给 16px 容差：无头桌面模拟（setDeviceMetricsOverride 1440）下
      // fixed inset-0 的 rect 实测 1432，而 innerWidth/clientWidth 都报 1440
      // —— 这 8px 是 headless 的滚动条占位 artifact，真机上 inset-0 就是全屏。
      // （用 clientWidth 严格比较只有移动端 overlay 滚动条时碰巧成立。）
      fullscreen: Math.abs(rr.top) <= 1 && Math.abs(rr.left) <= 1
        && rr.height >= vh - 1 && rr.width >= vw - 16,
      imgLoaded: !!img && img.complete && img.naturalWidth > 0,
      panSlots: slots.length,
      imgBox: img ? [Math.round(img.getBoundingClientRect().left), Math.round(img.getBoundingClientRect().top), Math.round(img.getBoundingClientRect().right), Math.round(img.getBoundingClientRect().bottom)] : null,
      chromeOut: btns.filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && (r.right > vw + 1 || r.left < -1 || r.bottom > vh + 1 || r.top < -1); }).length,
      sliderW: (() => { const s = reader.querySelector('input[type=range]'); return s ? Math.round(s.getBoundingClientRect().width) : -1; })(),
    };
  }
  return out;
})()`;

/* 底部 Tab 遮挡检查：滚到页面最底，最后一张卡片应完整位于 Tab 栏上方 */
const BOTTOM_CHECK = `(() => {
  window.scrollTo(0, document.body.scrollHeight);
  return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
    const cards = [...document.querySelectorAll('.comic-grid a')];
    const nav = document.querySelector('nav.fixed');
    if (!cards.length || !nav) return res({ ok: true, skipped: true });
    const last = cards[cards.length - 1].getBoundingClientRect();
    const nt = nav.getBoundingClientRect().top;
    res({ ok: last.bottom <= nt + 1, skipped: false, lastBottom: Math.round(last.bottom), navTop: Math.round(nt) });
  })));
})()`;

async function waitFor(c, expr, timeout = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = await c.evaluate(expr);
    if (v) return v;
    if (Date.now() - t0 > timeout) return null;
    await sleep(200);
  }
}

/* ---------------- 断言记录 ---------------- */
const results = [];
const check = (dev, name, ok, extra = '') => {
  results.push({ dev, name, ok, extra });
  console.log(`  ${ok ? '✓' : '✗ FAIL'} [${dev}] ${name}${extra ? '  ' + extra : ''}`);
};

async function setDevice(c, d) {
  await c.send('Emulation.setDeviceMetricsOverride', { width: d.w, height: d.h, deviceScaleFactor: d.dsf, mobile: d.mobile });
  if (d.mobile) await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  else await c.send('Emulation.setTouchEmulationEnabled', { enabled: false });
}

async function shot(c, dev, page) {
  if (!SHOTS) return;
  const s = await c.send('Page.captureScreenshot', { format: 'png' });
  const out = path.join('tools', '_shots', `vp-${dev}-${page}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(s.data, 'base64'));
}

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', `--user-data-dir=${profile}`,
  `--remote-debugging-port=${CDP_PORT}`, 'about:blank',
], { stdio: 'ignore' });

let fail = 0;
try {
  const c = client(await waitCdp());
  await c.ready;
  await c.send('Page.enable');

  // 取一部真实漫画用于详情/阅读器流程
  const comics = await (await fetch(`${BASE}/api/comics?pageSize=50`)).json();
  const comic = (comics.data?.items ?? []).find((x) => x.chapterCount > 0);
  if (!comic) throw new Error('夹具里没有带章节的漫画，无法跑详情/阅读器');
  console.log(`目标漫画：${comic.title}（${comic.chapterCount} 章）\n`);

  for (const d of DEVICES) {
    console.log(`── ${d.id} ${d.w}×${d.h}${d.mobile ? ' (touch)' : ''} ${'─'.repeat(30)}`);
    await setDevice(c, d);

    /* ---- 首页 ---- */
    await c.send('Page.navigate', { url: `${BASE}/` });
    await waitFor(c, `!!document.querySelector('.comic-grid a')`);
    await sleep(700);
    let diag = await c.evaluate(DIAG);
    check(d.id, '首页无横向文档溢出', diag.docOverflowX <= 1, `overflowX=${diag.docOverflowX}`);
    check(d.id, '首页无越界元素', diag.offenders.length === 0, diag.offenders.slice(0, 3).join(' | '));
    const navOk = d.expectNav === 'sidebar' ? diag.nav.sidebar && !diag.nav.rail && !diag.nav.bottom
      : d.expectNav === 'rail' ? diag.nav.rail && !diag.nav.sidebar && !diag.nav.bottom
      : diag.nav.bottom && !diag.nav.rail && !diag.nav.sidebar;
    check(d.id, `导航模式=${d.expectNav}`, navOk, JSON.stringify(diag.nav));
    if (diag.sideBySide !== null) {
      check(d.id, '主区与侧栏并排（不被顶出首屏）', diag.sideBySide === true, `sideBySide=${diag.sideBySide}`);
    }
    check(d.id, '网格列数≥3', diag.gridCols >= 3, `cols=${diag.gridCols}`);
    if (d.expectNav === 'bottom') {
      const b = await c.evaluate(BOTTOM_CHECK);
      // 底 Tab 不存在（宽度 ≥640 的设备）时无遮挡可言，视为通过
      check(d.id, '底部内容不被 Tab 栏遮挡', b.ok || b.skipped, b.skipped ? 'no-bottom-nav' : `cardBottom=${b.lastBottom} navTop=${b.navTop}`);
    }
    // 截图前回到顶部（BOTTOM_CHECK 会滚到底，短内容下拍出来是空白）
    await c.evaluate(`window.scrollTo(0, 0)`);
    await sleep(150);
    await shot(c, d.id, 'home');

    /* ---- 详情页 ---- */
    await c.send('Page.navigate', { url: `${BASE}/comic/${comic.id}` });
    await waitFor(c, `!!document.querySelector('h1')`);
    await sleep(500);
    diag = await c.evaluate(DIAG);
    check(d.id, '详情页无横向溢出', diag.docOverflowX <= 1 && diag.offenders.length === 0,
      diag.docOverflowX > 1 ? `overflowX=${diag.docOverflowX}` : diag.offenders.slice(0, 2).join(' | '));
    await shot(c, d.id, 'detail');

    /* ---- 阅读器（真实点击第一章进入） ---- */
    const entered = await c.evaluate(`(() => {
      const btn = document.querySelector('.card.divide-y button');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    await waitFor(c, `!![...document.querySelectorAll('div')].some(d => (d.className||'').toString().includes('anim-reader-in'))`);
    await waitFor(c, `(() => { const r = [...document.querySelectorAll('div')].find(d => (d.className||'').toString().includes('anim-reader-in')); const i = r && r.querySelector('img'); return !!(i && i.complete && i.naturalWidth > 0); })()`, 20000);
    await sleep(400);
    diag = await c.evaluate(DIAG);
    check(d.id, '阅读器铺满视口', !!diag.reader?.fullscreen, JSON.stringify(diag.reader));
    check(d.id, '阅读器页面图已加载', !!diag.reader?.imgLoaded, JSON.stringify(diag.reader?.imgBox));
    check(d.id, '阅读器工具栏均在界内', diag.reader?.chromeOut === 0 && diag.reader?.sliderW > 0,
      `chromeOut=${diag.reader?.chromeOut} sliderW=${diag.reader?.sliderW}`);
    check(d.id, '阅读器无越界元素', diag.offenders.length === 0, diag.offenders.slice(0, 2).join(' | '));
    await shot(c, d.id, 'reader');

    /* ---- 阅读器内打开章节抽屉（底部 Sheet） ---- */
    await c.evaluate(`(() => {
      const btns = [...document.querySelectorAll('header button')];
      const listBtn = btns.find(b => b.getAttribute('title') === null && b.querySelector('svg.lucide-list'));
      (listBtn || btns[btns.length - 1]).click();
      return true;
    })()`);
    await sleep(600);
    const sheet = await c.evaluate(`(() => {
      // 不写死 z 值：弹层层级由 CSS 变量管理（--layer-sheet 现在是 120，
      // 早期是 z-50）。这里按「fixed 全屏遮罩 + 末子元素是含章节按钮的面板」识别。
      const overlays = [...document.querySelectorAll('div.fixed.inset-0')];
      const panel = overlays
        .map((o) => o.lastElementChild)
        .find((p) => p && p.querySelector('li button'));
      if (!panel) return null;
      const r = panel.getBoundingClientRect();
      const items = panel.querySelectorAll('li button').length;
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: document.documentElement.clientHeight, items };
    })()`);
    check(d.id, '章节抽屉在界内且有条目', !!sheet && sheet.items > 0 && sheet.bottom <= sheet.vh + 1 && sheet.top >= -1,
      JSON.stringify(sheet));
    await shot(c, d.id, 'reader-chapters');
    // 关抽屉（Esc）
    await c.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(300);

    /* ---- 横竖屏切换（仅平板竖屏档案） ---- */
    if (d.id === 'tablet-portrait') {
      const land = DEVICES.find((x) => x.id === 'tablet-landscape');
      await setDevice(c, land);
      await sleep(700);
      diag = await c.evaluate(DIAG);
      check(d.id, '横屏：阅读器仍铺满', !!diag.reader?.fullscreen && !!diag.reader?.imgLoaded, JSON.stringify(diag.reader));
      check(d.id, '横屏：无越界元素', diag.offenders.length === 0, diag.offenders.slice(0, 2).join(' | '));
      await shot(c, d.id, 'reader-rotated-landscape');
      // 退回首页验证导航模式跟随
      await c.send('Page.navigate', { url: `${BASE}/` });
      await waitFor(c, `!!document.querySelector('.comic-grid a')`);
      await sleep(500);
      diag = await c.evaluate(DIAG);
      check(d.id, '横屏：导航切侧边栏', diag.nav.sidebar && !diag.nav.rail && !diag.nav.bottom, JSON.stringify(diag.nav));
      // 再竖回去验证 rail 回归
      await setDevice(c, d);
      await sleep(500);
      diag = await c.evaluate(DIAG);
      check(d.id, '竖屏：导航回图标 Rail', diag.nav.rail && !diag.nav.sidebar && !diag.nav.bottom, JSON.stringify(diag.nav));
    }

    /* ---- 设置 / 书架 / 漫画库 / 搜索（轻量：只查溢出） ---- */
    for (const [route, marker] of [['/settings', '设置'], ['/shelf', '我的收藏'], ['/libraries', '漫画库'], ['/search', '搜索']]) {
      await c.send('Page.navigate', { url: `${BASE}${route}` });
      await waitFor(c, `document.body.textContent.includes('${marker}')`);
      await sleep(350);
      diag = await c.evaluate(DIAG);
      check(d.id, `${route} 无横向溢出`, diag.docOverflowX <= 1 && diag.offenders.length === 0,
        diag.docOverflowX > 1 ? `overflowX=${diag.docOverflowX}` : diag.offenders.slice(0, 2).join(' | '));
    }
    await shot(c, d.id, 'settings');
    console.log('');
  }

  c.close();
} finally {
  edge.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ---------------- 汇总 ---------------- */
fail = results.filter((r) => !r.ok).length;
const pass = results.length - fail;
console.log('═'.repeat(20), '汇总', '═'.repeat(20));
const byDev = {};
for (const r of results) {
  byDev[r.dev] ??= { pass: 0, fail: 0 };
  byDev[r.dev][r.ok ? 'pass' : 'fail']++;
}
for (const [dev, s] of Object.entries(byDev)) {
  console.log(`${dev.padEnd(18)} ${s.fail === 0 ? '✅' : '❌'} ${s.pass}/${s.pass + s.fail}`);
}
if (fail > 0) {
  console.log('\n失败项：');
  for (const r of results.filter((x) => !x.ok)) console.log(`  ✗ [${r.dev}] ${r.name}  ${r.extra}`);
}
console.log(`\n总计: ${results.length}  通过: ${pass}  失败: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
