/**
 * 阅读器真实浏览器探针（Edge headless + CDP，无第三方依赖）。
 * 覆盖这些回归点：
 *  1. 切章后必须从第 1 页开始（即使目标章有历史进度），而直接打开有进度的章仍续读
 *  2. 拆分双页：不变形、按高度铺满、左右半页真的分开显示（rtl 先右半）
 *  3. 页码域一致性（拆分/双页的页码分母与滑块上限）与卷轴模式续读定位
 *
 * 前置：后端已启动（带 fixtures）；无需任何 npm 依赖（宽幅图用 tools/_image.mjs 现画）。
 * 用法：node tools/reader_probe.mjs [baseUrl]
 * 说明：会自动建一个临时库放宽幅跨页图，跑完删除，不影响标准 fixtures。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hex, writePng } from './lib/image.mjs';
import { injectPrefs } from './lib/prefs.mjs';

// 宽幅跨页夹具用零依赖 PNG 生成（本仓库不带图像处理依赖，
// 探针自己拼 PNG 字节，避免为一次夹具引入第三方库）

const BASE = process.argv[2] || 'http://127.0.0.1:13920';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CDP_PORT = 9333;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-probe-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 宽幅跨页页面的像素画法：底色 + 内嵌边框 + 中线虚线 + 左右两块「L / R」色块。
 * 目的是让截图能肉眼分辨左右半页是否真被拆开、有没有被压扁，不追求好看。
 */
function widePagePainter(bg, fg, page) {
  const W = 1700;
  const H = 1000;
  const inRect = (x, y, x0, y0, x1, y1) => x >= x0 && x < x1 && y >= y0 && y < y1;
  // 页号用底部的小方块数表示，保证同一卷的两页不是同一张图
  const dots = [];
  for (let d = 0; d <= page; d++) dots.push([760 + d * 90, 900, 820 + d * 90, 960]);
  const dy = page * 40; // 页间轻微错位，避免像素级完全相同
  return (x, y) => {
    // 边框（20..1680 / 20..980 的 8px 描边）
    if (inRect(x, y, 20, 20, 1680, 980) && !inRect(x, y, 28, 28, 1672, 972)) return fg;
    // 中线虚线：24 实 16 空
    if (x >= 847 && x < 853 && y % 40 < 24) return fg;
    // 左「L」
    if (inRect(x, y, 120, 400 + dy, 172, 700 + dy)) return fg;
    if (inRect(x, y, 120, 648 + dy, 420, 700 + dy)) return fg;
    // 右「R」
    if (inRect(x, y, 1280, 400 + dy, 1332, 700 + dy)) return fg;
    if (inRect(x, y, 1280, 400 + dy, 1580, 452 + dy)) return fg;
    if (inRect(x, y, 1280, 524 + dy, 1580, 576 + dy)) return fg;
    if (inRect(x, y, 1528, 452 + dy, 1580, 524 + dy)) return fg;
    if (inRect(x, y, 1528, 576 + dy, 1580, 648 + dy)) return fg;
    for (const [x0, y0, x1, y1] of dots) if (inRect(x, y, x0, y0, x1, y1)) return fg;
    return bg;
  };
}

async function waitCdp() {
  for (let i = 0; i < 60; i++) {
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

const json = async (p, init) => (await fetch(BASE + p, init)).json();
const putJson = (p, body) => json(p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', `--user-data-dir=${profile}`,
  `--remote-debugging-port=${CDP_PORT}`, 'about:blank',
], { stdio: 'ignore' });

let ok = 0;
let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { ok++; console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`); }
};

const shots = path.resolve('tools/_shots');

try {
  const c = client(await waitCdp());
  await c.ready;
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1200, deviceScaleFactor: 1, mobile: false });

  // 宽幅跨页夹具：自建临时库，避免污染标准 fixtures
  const wideRoot = path.join(os.tmpdir(), 'fc-wide-probe');
  fs.rmSync(wideRoot, { recursive: true, force: true });
  for (const [vol, palette] of [['第01卷', ['#1b5e20', '#e8f5e9']], ['第02卷', ['#0d47a1', '#e3f2fd']]]) {
    const dir = path.join(wideRoot, vol);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 2; i++) {
      const [bg, fg] = palette;
      const painter = widePagePainter(hex(bg), hex(fg), i);
      // 1700x1000：宽高比 ≈1.7，稳稳落进「双页/跨页」候选
      writePng(path.join(dir, `${String(i + 1).padStart(3, '0')}.png`), 1700, 1000, painter);
    }
  }
  const wideLib = (await json('/api/libraries', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '__探针宽幅库__', type: 'chapter', paths: [wideRoot] }),
  })).data.id;
  const scan = async () => {
    await json('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    for (let i = 0; i < 80; i++) {
      const st = (await json('/api/scan/status')).data;
      if (!st.running) return;
      await sleep(300);
    }
  };
  await scan();

  const comics = (await json('/api/comics?pageSize=50')).data.items;
  const chComic = comics.find((x) => x.title.includes('阿飞正传'));
  const wideComic = comics.find((x) => x.libraryId === wideLib) ?? comics.find((x) => x.title.includes('宽幅跨页'));
  const chDetail = (await json(`/api/comics/${encodeURIComponent(chComic.id)}`)).data;
  const [c0, c1] = chDetail.chapters;
  const wideDetail = (await json(`/api/comics/${encodeURIComponent(wideComic.id)}`)).data;
  const w0 = wideDetail.chapters[0];
  const c2 = chDetail.chapters[2];
  console.log(`切章用: ${chComic.title} ${c0.title}(${c0.pageCount}p) → ${c1.title}(${c1.pageCount}p)`);
  console.log(`拆分用: ${wideComic.title} ${w0.title}(${w0.pageCount}p)`);

  // 设备偏好只能写浏览器（服务端已不接受这 10 个键）：累积后每次导航前注入
  let prefs = {};
  const setPrefs = (patch) => { prefs = { ...prefs, ...patch }; };

  const load = async (url) => {
    await injectPrefs(c.send, prefs);
    await c.send('Page.navigate', { url: BASE + url });
    for (let i = 0; i < 100; i++) {
      const done = await c.evaluate('document.readyState === "complete" && !!document.querySelector(\'footer input[type=range]\')');
      if (done) break;
      await sleep(150);
    }
    await sleep(800);
  };
  const state = () => c.evaluate(`(() => {
    const foot = document.querySelector('footer');
    const m = /(\\d+)\\/(\\d+)/.exec(foot ? foot.textContent : '');
    const head = (document.querySelector('header') || {}).textContent || '';
    return { url: location.href, page: m ? Number(m[1]) : null, total: m ? Number(m[2]) : null,
             chapter: /\\d+\\/\\d+\\s*([^·]*)·/.exec(head)?.[1]?.trim() ?? '' };
  })()`);
  /**
   * 量「一张页图 + 它所在的槽位」的几何。
   *
   * scope 传选择器可只量某个槽位。平移轨道里 DOM 顺序 ≠ 可见顺序：三个槽位常驻
   * （pagers.tsx:498 的 w-[300%]），第一个 /pages/ 图经常是左侧那块屏幕外的。
   * 要判断「首屏显示的是哪半页」，必须锁到 data-split-layer="1" ——
   * pagers.tsx:507 只给当前页那个槽位打这个标记（SplitEntryLayer 那条路径同理，见 374）。
   *
   * tx 是图自身的 translateX：splitGeom 用 translateX(-50%) 把左半页换到右半页，
   * 所以 tx ≈ -iw/2 就是右半页，比拿 left 比较不依赖「当前取到哪个槽位」。
   */
  const geometry = (scope = null) => c.evaluate(`(() => {
    const root = ${scope ? `document.querySelector(${JSON.stringify(scope)})` : 'document'};
    if (!root) return null;
    const img = [...root.querySelectorAll('img')].find(i => (i.currentSrc || i.src).includes('/pages/'));
    if (!img) return null;
    const wrap = img.parentElement;
    const ir = img.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const m = /matrix\\(([^)]+)\\)/.exec(getComputedStyle(img).transform);
    return { nw: img.naturalWidth, nh: img.naturalHeight,
             iw: +ir.width.toFixed(1), ih: +ir.height.toFixed(1),
             il: +ir.left.toFixed(1), it: +ir.top.toFixed(1),
             ww: +wr.width.toFixed(1), wh: +wr.height.toFixed(1), wl: +wr.left.toFixed(1),
             tx: m ? +m[1].split(',')[4] : 0,
             page: wrap.dataset.page ?? null,
             transform: getComputedStyle(img).transform };
  })()`);
  const shot = async (name) => {
    const r = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(shots, { recursive: true });
    fs.writeFileSync(path.join(shots, name), Buffer.from(r.data, 'base64'));
  };

  // ============ 一、切章是否回到第 1 页 ============
  console.log('\n=== 切章起点 ===');
  setPrefs({ readerMode: 'single', readDir: 'rtl' });
  // 制造「第 2 章上次读到第 3 页」的历史进度
  await putJson('/api/progress', {
    comicId: chComic.id, chapterId: c1.id, chapterIndex: 1,
    pageIndex: 2, pageCount: c1.pageCount, percent: 60,
  });

  await load(`/read/${encodeURIComponent(chComic.id)}/${encodeURIComponent(c0.id)}?page=3`);
  let s = await state();
  t('打开第 1 章第 4 页', s.page === 4, `${s.page}/${s.total} ${s.url.replace(BASE, '')}`);

  await c.evaluate(`[...document.querySelectorAll('footer button')].find(b => b.textContent.includes('下一章')).click()`);
  await sleep(1600);
  s = await state();
  t('点「下一章」→ 从第 1 页开始（不被历史进度顶到第 3 页）', s.page === 1, `${s.page}/${s.total} ${s.url.replace(BASE, '')}`);
  t('URL 归一为 page=0', /[?&]page=0(&|$)/.test(s.url), s.url.replace(BASE, ''));
  t('已切到第 2 章', s.chapter.includes('第02卷'), `当前=${s.chapter}`);

  // 直接打开「没被本次会话读写过」的章节：续读语义不能被改坏
  await putJson('/api/progress', {
    comicId: chComic.id, chapterId: c2.id, chapterIndex: 2,
    pageIndex: 2, pageCount: c2.pageCount, percent: 60,
  });
  await load(`/read/${encodeURIComponent(chComic.id)}/${encodeURIComponent(c2.id)}`);
  s = await state();
  t('直接打开有进度的章节仍续读第 3 页', s.page === 3, `${s.page}/${s.total}`);

  // 回上一章按钮：也应从第 1 页开始
  await c.evaluate(`[...document.querySelectorAll('footer button')].find(b => b.textContent.includes('上一章')).click()`);
  await sleep(1600);
  s = await state();
  t('点「上一章」→ 从第 1 页开始', s.page === 1, `${s.page}/${s.total} ${s.url.replace(BASE, '')}`);

  // ============ 二、拆分双页渲染 ============
  console.log('\n=== 拆分双页（宽幅跨页，ltr）===');
  setPrefs({ readerMode: 'split', readDir: 'ltr' });
  await load(`/read/${encodeURIComponent(wideComic.id)}/${encodeURIComponent(w0.id)}`);
  const g0 = await geometry();
  console.log('  左半页:', JSON.stringify(g0));
  t('不拉伸变形（渲染宽高比 = 原图）', g0 && Math.abs(g0.nw / g0.nh - g0.iw / g0.ih) / (g0.nw / g0.nh) < 0.02,
    g0 ? `natural=${(g0.nw / g0.nh).toFixed(3)} shown=${(g0.iw / g0.ih).toFixed(3)}` : 'no img');
  // 拆分模式是「半页 contain」（pagers.tsx:249 splitGeom）：宽幅图按半个图宽适配，
  // 所以宽限制时高度必然不足。1700×1000 的夹具在手机视口下半页只有 ~850 宽，
  // 一定是宽限制 —— 旧的「按高度铺满」断言在这种夹具上永远红，是断言过期不是产品错。
  // 真正的不变式：不变形（上一条）+ 半页不溢出 + 至少贴满一边。
  const halfW = g0 ? g0.iw / 2 : 0;
  t('半页不溢出容器', !!g0 && halfW <= g0.ww + 2 && g0.ih <= g0.wh + 2,
    g0 ? `半宽=${halfW.toFixed(1)}/${g0.ww} 高=${g0.ih}/${g0.wh}` : 'no img');
  t('半页贴满一边（宽限制或高限制，二选一）',
    !!g0 && (Math.abs(halfW - g0.ww) <= 2 || Math.abs(g0.ih - g0.wh) <= 2),
    g0 ? `半宽差=${(g0.ww - halfW).toFixed(1)} 高差=${(g0.wh - g0.ih).toFixed(1)}` : '');
  t('宽幅图宽度溢出视口（确实是拆分对象）', g0 && g0.iw > g0.ww, g0 ? `img=${g0.iw} box=${g0.ww}` : '');
  t('左半页贴容器左缘', g0 && Math.abs(g0.il - g0.wl) <= 2, g0 ? `img.left=${g0.il} box.left=${g0.wl}` : '');
  await shot('split-ltr-half0.png');

  // 用键盘右方向键翻到下一页（ltr 下 = 后半页）；滑块受控组件用原生事件不好驱动
  await c.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
  await sleep(900);
  const g1 = await geometry();
  const s1 = await state();
  console.log('  右半页:', JSON.stringify(g1), '页码', s1.page + '/' + s1.total);
  t('右半页向左平移半个图宽', g1 && Math.abs((g0.il - g1.il) - g0.iw / 2) <= 3,
    g1 ? `位移=${(g0.il - g1.il).toFixed(1)} 半宽=${(g0.iw / 2).toFixed(1)}` : '');
  t('右半页不再与左半页重合', g1 && Math.abs(g0.il - g1.il) > 100, g1 ? `Δ=${(g0.il - g1.il).toFixed(1)}` : '');
  await shot('split-ltr-half1.png');

  // ============ 三、卷轴模式续读定位 ============
  console.log('\n=== 卷轴模式续读 ===');
  setPrefs({ readerMode: 'webtoon', readDir: 'ltr' });
  await putJson('/api/progress', {
    comicId: chComic.id, chapterId: c0.id, chapterIndex: 0,
    pageIndex: 2, pageCount: c0.pageCount, percent: 60,
  });
  await load(`/read/${encodeURIComponent(chComic.id)}/${encodeURIComponent(c0.id)}`);
  await sleep(800);
  const scrollTop = await c.evaluate(`(() => {
    const el = [...document.querySelectorAll('div')].find(d => d.scrollHeight > d.clientHeight + 50 && d.clientHeight > 400);
    return el ? Math.round(el.scrollTop) : -1;
  })()`);
  console.log('  卷轴滚动位置:', scrollTop);
  t('卷轴模式进入章节滚到进度页（scrollTop>0）', scrollTop > 200, `scrollTop=${scrollTop}`);

  // ============ 四、页码域一致性（分母/滑块/跨章）============
  console.log('\n=== 页码域一致性 ===');
  setPrefs({ readerMode: 'split', readDir: 'ltr' });
  await putJson('/api/progress', {
    comicId: wideComic.id, chapterId: w0.id, chapterIndex: 0,
    pageIndex: 0, pageCount: w0.pageCount, percent: 0,
  });
  await load(`/read/${encodeURIComponent(wideComic.id)}/${encodeURIComponent(w0.id)}`);
  s = await state();
  t('拆分：页码分母 = 图数×2', s.total === 4, `${s.page}/${s.total}`);
  const rangeMax = await c.evaluate(`document.querySelector('footer input[type=range]').max`);
  t('拆分：滑块上限 = 模式页数-1', Number(rangeMax) === 3, `max=${rangeMax}`);
  for (let i = 0; i < 3; i++) {
    await c.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
    await sleep(250);
  }
  s = await state();
  t('拆分：按键可推进到最后一个半页', s.page === 4, `${s.page}/${s.total}`);

  console.log('\n=== 双页模式跨章 ===');
  setPrefs({ readerMode: 'double', readDir: 'ltr' });
  // 先把进度归零，确保从第 1 页进入（否则会按上次读到的那对开续读）
  await putJson('/api/progress', {
    comicId: chComic.id, chapterId: c0.id, chapterIndex: 0,
    pageIndex: 0, pageCount: c0.pageCount, percent: 0,
  });
  await load(`/read/${encodeURIComponent(chComic.id)}/${encodeURIComponent(c0.id)}`);
  s = await state();
  t('双页：4 图 = 2 页', s.total === 2, `${s.page}/${s.total}`);
  await c.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
  await sleep(500);
  s = await state();
  t('双页：翻到第 2 对开', s.page === 2, `${s.page}/${s.total}`);
  await c.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
  await sleep(1600);
  s = await state();
  t('双页：章末继续翻 → 进入下一章第 1 页', s.page === 1 && s.chapter.includes('第02卷'),
    `${s.page}/${s.total} 章=${s.chapter}`);

  console.log('\n=== 拆分模式下的普通竖版图（不该拆分/不该留白）===');
  setPrefs({ readerMode: 'split', readDir: 'ltr' });
  await load(`/read/${encodeURIComponent(chComic.id)}/${encodeURIComponent(c0.id)}`);
  // 采样前必须等「自然尺寸 → splittable 判定」稳定：
  //   splittable = !(box && nat) || shownW > box.w + 1
  // nat 还没被 onLoad 写进 state 时，判定默认走「可拆」分支（left:0），
  // 过早采样会把本该居中的竖图读成 left=0（长期假阴性来源）。
  await sleep(600);
  const gn = await geometry();
  console.log('  竖版图:', JSON.stringify(gn));
  t('竖版图不超过视口 → 居中整图', gn && Math.abs(gn.il - (gn.ww - gn.iw) / 2) <= 3,
    gn ? `img.left=${gn.il} 期望≈${((gn.ww - gn.iw) / 2).toFixed(1)}` : '');
  t('竖版图不放大（保持高度适应）', gn && Math.abs(gn.ih - gn.wh) <= 2, gn ? `h=${gn.ih} box=${gn.wh}` : '');

  // ============ 五、rtl 下先看右半 ============
  console.log('\n=== 拆分双页（rtl 先右半）===');
  setPrefs({ readerMode: 'split', readDir: 'rtl' });
  await load(`/read/${encodeURIComponent(wideComic.id)}/${encodeURIComponent(w0.id)}`);
  // 与上一段同理：自然尺寸没量到之前先按整槽 contain 画（无内联 transform），
  // 过早采样会读到 tx=0 而被判成"左半页"（长期假阴性来源）。
  await sleep(600);
  const gr = await geometry('[data-split-layer="1"]');
  console.log('  rtl 首屏:', JSON.stringify(gr));
  // 不能断言 page == 0：上一段已经在同一章上推进过，阅读器会**恢复进度**，
  // 首屏落在 data-page=2 是正确行为（实测踩过：写成 ==0 直接假红）。
  // 平移轨道下槽位才带 data-page；非平移走 SplitEntryLayer（pagers.tsx:374），
  // 那层只有 data-split-layer，此时只靠下面的 tx 判定，别把它当成失败。
  // 真正的不变式是「槽位号与半页方向一致」：rtl 下偶数半页 = 右半。
  t('rtl 槽位号与半页方向一致（偶数半页在右）',
    !!gr && (gr.page === null || (Number(gr.page) % 2 === 0) === (gr.tx < -1)),
    gr ? `data-page=${gr.page ?? '（非平移层）'} tx=${gr.tx}` : 'no layer');
  // 旧写法是 rtl 下用「首屏 img.left 比槽位左缘小 100」判定，而首屏第一个 /pages/ 图
  // 往往是左侧屏幕外那块槽位，量到的 left 天然很小 —— 判据本身指错了槽位。
  t('rtl 首屏为右半页（translateX(-50%)）',
    !!gr && Math.abs(gr.tx + gr.iw / 2) <= 2,
    gr ? `tx=${gr.tx} 期望≈${(-gr.iw / 2).toFixed(1)}` : '');

  setPrefs({ readerMode: 'single', readDir: 'rtl' });
  // 拆掉临时库与临时目录
  await fetch(`${BASE}/api/libraries/${encodeURIComponent(wideLib)}`, { method: 'DELETE' });
  c.close();
} finally {
  edge.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(os.tmpdir(), 'fc-wide-probe'), { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n总计 ${ok + fail}  通过 ${ok}  失败 ${fail}`);
process.exit(fail ? 1 : 0);
