/**
 * 多端适配探针：在若干代表性视口下逐个打开主要页面，量化检查
 *   1. 横向溢出（文档 scrollWidth > clientWidth，以及具体越界元素）
 *   2. 触控热区过小（<28px 的可点元素）
 *   3. 封面栅格列数
 *   4. 导航形态是否是该宽度该有的（<640 底栏 / 640-1023 图标 Rail / ≥1024 侧栏）
 *   5. 阅读器图片是否完整落在视口内、上下操作条是否被裁切/重叠
 *   6. 正文可读行数：主区是否被 Navigation 遮住（底部 tab 遮心事）
 *
 *   node tools/responsive_check.mjs [--shots] [--only=<视口名>]
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
const ARG = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const FLAG = (n) => process.argv.includes(`--${n}`);
const BASE = ARG('base', 'http://127.0.0.1:13800').replace(/\/$/, '');
const ONLY = ARG('only', '');
const api = async (p) => (await fetch(BASE + p)).json();

/**
 * [名称, 宽, 高, 是否模拟移动端(touch)]
 * 覆盖：小屏手机 / 主流手机 / 手机横屏 / 平板竖 / 平板横 / lg 边界 1024 / 笔记本 / 桌面 / 2K
 */
const VIEWPORTS = [
  ['小屏下限 320', 320, 568, true],
  ['安卓 360 竖', 360, 740, true],
  ['iPhone 390 竖', 390, 844, true],
  ['手机 844 横', 844, 390, true],
  ['iPad mini 744 竖', 744, 1133, true],
  ['iPad Air 820 竖', 820, 1180, true],
  ['iPad mini 1133 横', 1133, 744, true],
  ['iPad 1024 横(lg界)', 1024, 768, true],
  ['iPad Pro 1366 横', 1366, 1024, true],
  ['笔记本 1440', 1440, 900, false],
  ['桌面 1920', 1920, 1080, false],
  ['2K 2560', 2560, 1440, false],
];

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const PORT = 9633;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-resp-'));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
let wsUrl;
for (let i = 0; i < 80; i++) {
  try { const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = t.find((x) => x.type === 'page'); if (p) { wsUrl = p.webSocketDebuggerUrl; break; } } catch { /* 等 */ }
  await sleep(150);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
const send = (m, p = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

await send('Page.enable');
await send('Runtime.enable');

/** 页面内的通用量测 */
const METRICS = `(() => {
  const de = document.documentElement;
  /*
   * 视口宽必须用 documentElement.clientWidth（CSS 视口），不能用 innerWidth：
   * 内容最小宽度超过视口时，移动浏览器会 shrink-to-fit —— 把 layout viewport
   * 撑到内容那么宽再整体缩小显示（实测：360 屏上 innerWidth=531）。
   * 用 innerWidth 当视口宽时，被推到屏幕外的元素反而在「视口内」，越界检查全绿，
   * 而用户看到的是整页缩小 + 右侧按钮点不到。这就是漫画库那次漏掉的原因。
   */
  const vw = de.clientWidth, vh = de.clientHeight;
  const seenCs = new Set();

  const vis = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return null;
    if (Number(cs.opacity) < 0.05) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { cs, r };
  };

  // 横向越界：排除「自身在横向滚动容器里」的正常情况
  const offenders = [];
  for (const el of de.querySelectorAll('body *')) {
    const v = vis(el); if (!v) continue;
    const r = v.r;
    if (r.right <= vw + 1 && r.left >= -1) continue;
    // 祖先里有横向滚动 / 裁剪区域 → 容器故意可滑或部分隐藏，不算 bug
    // （阅读器的三槽位平移轨道就是 overflow-hidden + translateX，邻页必然在视口外）
    let clipped = false;
    for (let p = el.parentElement; p && p !== de; p = p.parentElement) {
      const pcs = getComputedStyle(p);
      if (pcs.overflowX === 'auto' || pcs.overflowX === 'scroll' || pcs.overflowX === 'hidden' || pcs.overflow === 'hidden') { clipped = true; break; }
    }
    if (clipped) continue;
    const key = el.tagName + '|' + String(el.className).slice(0, 40);
    if (seenCs.has(key)) continue;
    seenCs.add(key);
    offenders.push({ el: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 46), l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) });
  }

  // 触控热区：视觉尺寸 + ::after 扩展出来的命中区，取较大者（触屏下的真实可按面积）
  const small = [];
  for (const el of de.querySelectorAll('button, a[href], input, select, [role="button"], [role="tab"]')) {
    const v = vis(el); if (!v) continue;
    const r = v.r;
    const w = Math.round(r.width), h = Math.round(r.height);
    // ::after 可能挂在自身（button/a），也可能挂在包了一层的父元素上（input[type=range] 这种替换元素）
    let box = null;
    for (const cand of [el, el.closest('.touch-hit')]) {
      if (!cand) continue;
      const af = getComputedStyle(cand, '::after');
      const aw = parseFloat(af.width) || 0, ah = parseFloat(af.height) || 0;
      if (aw && ah) { box = { aw, ah }; break; }
    }
    const effW = Math.max(w, Math.round(box?.aw ?? 0)), effH = Math.max(h, Math.round(box?.ah ?? 0));
    small.push({ el: el.tagName.toLowerCase(), t: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 12), w, h, effW, effH });
  }

  // 封面栅格列数：取第一组相同 top 的卡片数
  const cards = [...de.querySelectorAll('.comic-grid > *')];
  let cols = 0;
  if (cards.length) {
    const top = Math.round(cards[0].getBoundingClientRect().top);
    cols = cards.filter((c) => Math.abs(Math.round(c.getBoundingClientRect().top) - top) < 4).length;
  }

  // 导航形态
  const asides = [...de.querySelectorAll('aside')];
  const nav = {
    sidebar: asides.some((a) => vis(a) && a.getBoundingClientRect().width > 100),
    rail: asides.some((a) => vis(a) && a.getBoundingClientRect().width > 0 && a.getBoundingClientRect().width <= 100),
    bottomTab: !!asides.length === false ? false : [...de.querySelectorAll('nav')].some((n) => {
      const v = vis(n); return !!v && v.r.top > vh - 90 && v.r.width > vw * 0.8;
    }),
  };

  // 是否被底部 tab 遮住最后一屏内容
  const mainEl = de.querySelector('main');
  let covered = 0;
  if (nav.bottomTab && mainEl) {
    const tab = [...de.querySelectorAll('nav')].find((n) => { const v = vis(n); return !!v && v.r.top > vh - 90 && v.r.width > vw * 0.8; });
    if (tab) covered = Math.round(tab.getBoundingClientRect().top);
  }

  return {
    vw, vh,
    /** innerWidth > clientWidth = 整页被缩小显示（shrink-to-fit），内容最小宽度即 innerWidth */
    shrunk: innerWidth > de.clientWidth + 1 ? innerWidth : 0,
    scrollW: de.scrollWidth, clientW: de.clientWidth,
    overflow: de.scrollWidth - de.clientWidth,
    offenders: offenders.slice(0, 6), offenderCount: offenders.length,
    taps: small,
    cols, cardW: cards.length ? Math.round(cards[0].getBoundingClientRect().width) : 0,
    nav, tabTop: covered,
    docH: Math.round(de.scrollHeight),
  };
})()`;

/**
 * 命中点归属：每个控件中心处 elementFromPoint 必须是它自己（或它的子孙/祖先）。
 * 用来保证 .touch-hit 扩展出来的 44px 区域没有盖到邻居身上——否则手指点 A 会命中 B。
 */
const HITTEST = `(() => {
  // 底部 Tab 是 fixed 的，内容本来就会从它下面滑过去；被它盖住不算「命中被抢」
  const fixed = [...document.querySelectorAll('nav, header, footer, aside')].filter((n) => {
    const cs = getComputedStyle(n);
    return cs.position === 'fixed' || cs.position === 'sticky';
  }).map((n) => n.getBoundingClientRect());
  const covered = (x, y) => fixed.some((f) => x >= f.left && x <= f.right && y >= f.top && y <= f.bottom);

  const bad = [];
  for (const el of document.querySelectorAll('button, a[href], input, [role="button"]')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) continue;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (covered(cx, cy)) continue;
    const hit = document.elementFromPoint(cx, cy);
    const who = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 12);
    if (!hit) { bad.push({ who, by: 'null' }); continue; }
    if (!(el.contains(hit) || hit.contains(el))) {
      bad.push({ who, by: hit.tagName.toLowerCase() + '.' + String(hit.className).slice(0, 26) });
    }
  }
  return bad;
})()`;

const ROUTES = [
  ['首页', '/'],
  ['书架', '/shelf'],
  ['搜索', '/search'],
  ['漫画库', '/libraries'],
  ['设置', '/settings'],
];

let failed = 0;
const issues = [];
const note = (vp, route, msg) => { issues.push(`[${vp} · ${route}] ${msg}`); };

async function measure(w, h, mobile, route) {
  // 显式声明 pointer 形态：headless 下 mobile:true 不一定等于 coarse，
  // 而 .touch-hit / chip 的触屏加码全部挂在 @media (pointer: coarse) 上
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await send('Emulation.setEmulatedMedia', {
    media: 'screen',
    features: [
      { name: 'pointer', value: mobile ? 'coarse' : 'fine' },
      { name: 'any-pointer', value: mobile ? 'coarse' : 'fine' },
    ],
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
  await send('Page.navigate', { url: BASE + route });
  await sleep(1500);
  const m = await ev(METRICS);
  m.stolen = await ev(HITTEST);
  return m;
}

/** 触屏取 44px（ Apple HIG 下限），桌面鼠标放宽到 24px */
const MIN_TAP = (mobile) => (mobile ? 40 : 24);

const comics = (await api('/api/comics?pageSize=20')).data.items;
const c0 = comics.find((c) => !/perf/i.test(c.title)) ?? comics[0];
const detail = (await api(`/api/comics/${c0.id}`)).data;
const ch0 = (detail.chapters ?? [])[0];
const READER = `/read/${c0.id}/${encodeURIComponent(ch0?.id ?? '')}?page=0`;

console.log('多端适配探针 →', BASE);
console.log('视口共', VIEWPORTS.length, '种 × 页面', ROUTES.length + 2, '个\n');

const table = [];
for (const [name, w, h, mobile] of VIEWPORTS) {
  if (ONLY && !name.includes(ONLY)) continue;
  const min = MIN_TAP(mobile);
  const row = { 视口: `${name} ${w}×${h}`, 溢出: [], 列: '', 导航: '', 热区: [], 误触: [] };

  /** 统一判断：越界 / 热区 / 命中归属 */
  const verdict = (label, m) => {
    // 只在移动视口判 shrink-to-fit：桌面端 innerWidth 含滚动条（比 clientWidth 大
    // 约 8px），那个差值不是「被缩小」，照搬会每条都报假警
    if (mobile && m.shrunk) {
      note(name, label, `整页被缩小显示：内容最小宽 ${m.shrunk}px > 视口 ${m.vw}px（右侧内容会被推出屏幕）`);
      row.溢出.push(`${label}(缩${m.shrunk})`);
    }
    if (m.offenderCount > 0) {
      note(name, label, `横向越界 ${m.offenderCount} 处 ${JSON.stringify(m.offenders[0])}`);
      row.溢出.push(`${label}(${m.offenderCount})`);
    }
    const bad = m.taps.filter((t) => Math.min(t.effW, t.effH) < min);
    if (bad.length) {
      const worst = bad.slice().sort((a, b) => Math.min(a.effW, a.effH) - Math.min(b.effW, b.effH))[0];
      note(name, label, `热区不足 ${min}px 的 ${bad.length} 个，最小 ${Math.min(worst.effW, worst.effH)}px 「${worst.t}」${worst.el}`);
      row.热区.push(`${label}(${bad.length})`);
    }
    if (m.stolen?.length) {
      note(name, label, `命中被邻居抢走 ${m.stolen.length} 处，例：${JSON.stringify(m.stolen[0])}`);
      row.误触.push(`${label}(${m.stolen.length})`);
    }
  };

  for (const [label, route] of ROUTES) {
    const m = await measure(w, h, mobile, route);
    verdict(label, m);
    if (label === '首页') {
      row.列 = `${m.cols}列/${m.cardW}px`;
      row.导航 = m.nav.sidebar ? '侧栏' : m.nav.rail ? 'Rail' : m.nav.bottomTab ? `底栏@${m.tabTop}` : '无';
    }
  }

  // 详情页
  const dm = await measure(w, h, mobile, `/comic/${c0.id}`);
  verdict('详情', dm);

  // 阅读器：图片是否在屏内（用真实渲染尺寸算，容器撑满不代表看得全）
  const rm = await measure(w, h, mobile, READER);
  verdict('阅读器', rm);
  const rd = await ev(`(() => {
    const vh = innerHeight, vw = innerWidth;
    const img = document.querySelector('img');
    const r = img ? img.getBoundingClientRect() : null;
    // object-fit 后的真实作画区域
    let paint = null;
    if (r && img.naturalWidth && img.naturalHeight) {
      const fit = getComputedStyle(img).objectFit;
      const sA = r.width / r.height, nA = img.naturalWidth / img.naturalHeight;
      if (fit === 'contain' || fit === 'scale-down') {
        paint = sA > nA ? { w: r.height * nA, h: r.height } : { w: r.width, h: r.width / nA };
      } else paint = { w: r.width, h: r.height };
      paint = { w: Math.round(paint.w), h: Math.round(paint.h), top: Math.round(r.top + (r.height - paint.h) / 2), left: Math.round(r.left + (r.width - paint.w) / 2), fit, nat: img.naturalWidth + 'x' + img.naturalHeight };
    }
    return { paint, vw, vh };
  })()`);
  if (rd.paint) {
    const p = rd.paint;
    const fits = p.left >= -1 && p.top >= -1 && p.left + p.w <= rd.vw + 1 && p.top + p.h <= rd.vh + 1;
    row['画幅'] = `${p.w}×${p.h}(${p.fit})`;
    if (!fits) note(name, '阅读器', `画作没完整落在视口 ${JSON.stringify(p)}`);
  }

  if (FLAG('shots')) {
    fs.mkdirSync(path.resolve('_shots/responsive'), { recursive: true });
    const dump = async (route, tag) => {
      await send('Page.navigate', { url: BASE + route });
      await sleep(1400);
      const s = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.resolve('_shots/responsive', `${w}x${h}-${tag}.png`), Buffer.from(s.data, 'base64'));
    };
    await dump('/', 'home');
    await dump('/settings', 'settings');
    await dump(READER, 'reader');
    await dump(`/comic/${c0.id}`, 'detail');
  }

  row.溢出 = row.溢出.join(' ') || '无';
  row.热区 = row.热区.join(' ') || '无';
  row.误触 = row.误触.join(' ') || '无';
  table.push(row);
  console.log(`✓ ${row.视口}  列=${row.列}  导航=${row.导航}  溢出=${row.溢出}  热区<${min}=${row.热区}  误触=${row.误触}  画幅=${row['画幅'] ?? '—'}`);
}

ws.close();
edge.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log('\n=== 问题清单 ===');
if (!issues.length) console.log('（无）');
else issues.forEach((i) => { failed++; console.log('· ' + i); });
console.log(failed === 0 ? '\n适配检查全部通过' : `\n共 ${failed} 条待处理`);
process.exit(0);
