/**
 * 拆分双页几何探针（Edge headless + CDP）。
 *
 * 拆分的两条硬约束：
 *   1) 只拆「宽幅跨页图」（宽 > 高的图）。判定不能拿「图比视口宽」来做：
 *      手机上视口又窄又高（390×844），按高度铺满后连普通竖版页都「比视口宽」，
 *      结果每张竖版页都被当跨页拆开，左右各裁掉一截。
 *   2) 半页必须**完整可见**：按半边铺满视口时，图宽不能超过视口宽的两倍，
 *      否则平移 50% 后两个半页各自还超出屏幕，中间/外侧内容被裁掉。
 *
 * 用法：node tools/split_check.mjs [baseUrl]
 * 前置：dev 服务已启动（默认 http://127.0.0.1:5173）。
 * 说明：自建一个临时宽幅库（1700×1000）跑完即删；竖版页用现成的库。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hex, writePng } from './lib/image.mjs';
import { injectPrefs } from './lib/prefs.mjs';

const BASE = (process.argv[2] || 'http://127.0.0.1:5173').replace(/\/$/, '');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CDP_PORT = 9335;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-split-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = async (p, init) => (await fetch(BASE + p, init)).json();

/** 宽幅跨页夹具：左右两半不同色，中间一条白线，方便肉眼确认拆的是哪半边 */
function widePainter(left, right) {
  return (x, y) => (x >= 846 && x < 854 ? hex('#ffffff') : x < 850 ? left : right);
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
const near = (a, b, tol = 2) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

const wideRoot = path.join(os.tmpdir(), 'fc-split-probe');
let wideLib = '';

try {
  const c = client(await waitCdp());
  await c.ready;
  await c.send('Page.enable');
  await c.send('Runtime.enable');

  const metrics = (w, h, mobile) =>
    c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  await metrics(900, 1200, false);

  let prefs = {};
  const setPrefs = (patch) => { prefs = { ...prefs, ...patch }; };
  const load = async (url) => {
    await injectPrefs(c.send, prefs);
    await c.send('Page.navigate', { url: BASE + url });
    for (let i = 0; i < 100; i++) {
      const done = await c.evaluate(
        'document.readyState === "complete" && !!document.querySelector("footer input[type=range]")',
      );
      if (done) break;
      await sleep(150);
    }
    // 等页图加载完、SplitPager 量到自然尺寸（splittable 判定在这一步之后才稳定）
    for (let i = 0; i < 60; i++) {
      const done = await c.evaluate(`(() => {
        const img = [...document.querySelectorAll('img')].find(i => (i.currentSrc || i.src).includes('/pages/'));
        return !!img && img.complete && img.naturalWidth > 0;
      })()`);
      if (done) break;
      await sleep(100);
    }
    await sleep(300);
  };
  const geom = () => c.evaluate(`(() => {
    const img = document.querySelector('[data-split-layer="1"] img')
      || [...document.querySelectorAll('img')].find(i => (i.currentSrc || i.src).includes('/pages/'));
    if (!img) return null;
    const r = img.getBoundingClientRect();
    let box = img.parentElement;
    while (box && getComputedStyle(box).position !== 'relative' && getComputedStyle(box).position !== 'absolute') {
      box = box.parentElement;
    }
    const b = (box || img.parentElement).getBoundingClientRect();
    return {
      nw: img.naturalWidth, nh: img.naturalHeight,
      w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      cx: +(r.left + r.width / 2).toFixed(1), cy: +(r.top + r.height / 2).toFixed(1),
      bx: +(b.left + b.width / 2).toFixed(1), by: +(b.top + b.height / 2).toFixed(1),
      bw: +b.width.toFixed(1), bh: +b.height.toFixed(1),
      // 左半页中心 / 右半页中心（相对图片自身）
      lcx: +(r.left + r.width / 4).toFixed(1), rcx: +(r.left + (r.width * 3) / 4).toFixed(1),
      src: (img.currentSrc || img.src).replace(location.origin, ''),
    };
  })()`);
  const foot = () => c.evaluate(`(() => {
    const f = document.querySelector('footer');
    const m = /(\\d+)\\/(\\d+)/.exec(f ? f.textContent : '');
    return { page: m ? Number(m[1]) : null, total: m ? Number(m[2]) : null, url: location.search };
  })()`);
  const press = async (key) => {
    await c.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true }))`);
    await sleep(350);
  };

  /** 逐帧采样一次翻页：入场层（data-split-layer=1）、旧版离场层，以及平移轨道的位移 */
  const flipFrames = (key) =>
    c.evaluate(`(async () => {
      const enter = () => document.querySelector('[data-split-layer="1"]');
      const leave = () => document.querySelector('[data-split-layer="leave"]');
      const track = () => document.querySelector('.pan-track');
      const img = () => document.querySelector('[data-split-layer="1"] img');
      const frames = [];
      const t0 = performance.now();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true }));
      await new Promise((resolve) => {
        const tick = () => {
          const e = enter();
          const v = leave();
          const i = img();
          const t = track();
          const er = e ? e.getBoundingClientRect() : null;
          const vr = v ? v.getBoundingClientRect() : null;
          const ir = i ? i.getBoundingClientRect() : null;
          const es = e ? getComputedStyle(e) : null;
          const vs = v ? getComputedStyle(v) : null;
          const tm = t ? new DOMMatrixReadOnly(getComputedStyle(t).transform).m41 : null;
          frames.push({
            ix: ir ? +ir.left.toFixed(1) : null,
            ex: er ? +er.left.toFixed(1) : null,
            ew: er ? +er.width.toFixed(1) : null,
            lx: vr ? +vr.left.toFixed(1) : null,
            lw: vr ? +vr.width.toFixed(1) : null,
            tx: tm === null ? null : +tm.toFixed(1),
            eanim: es ? es.animationName : null,
            lanim: vs ? vs.animationName : null,
            eop: es ? +es.opacity : null,
          });
          if (performance.now() - t0 < 430) requestAnimationFrame(tick); else resolve();
        };
        requestAnimationFrame(tick);
      });
      return frames;
    })()`);

  /** 静置一段时间，返回入场层出现过的 x（用于确认进入阅读器时没有自己滑动） */
  const idleXs = (ms = 380) =>
    c.evaluate(`(async () => {
      const el = () => document.querySelector('[data-split-layer="1"]');
      const xs = [];
      const t0 = performance.now();
      await new Promise((resolve) => {
        const tick = () => {
          const e = el();
          const x = e ? +e.getBoundingClientRect().left.toFixed(1) : null;
          if (x !== null && xs.at(-1) !== x) xs.push(x);
          if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick); else resolve();
        };
        requestAnimationFrame(tick);
      });
      return xs;
    })()`);

  const uniq = (list) => [...new Set(list)];

  /** 轨道当前位移（px）：拆分平移的「跟手」与「回弹」都看它 */
  const trackTx = () =>
    c.evaluate(`(() => {
      const t = document.querySelector('.pan-track');
      if (!t) return null;
      return +new DOMMatrixReadOnly(getComputedStyle(t).transform).m41.toFixed(1);
    })()`);

  /** 真实鼠标拖动（CDP 会产生 pointer 事件），移动途中逐帧记录轨道位移 */
  async function dragBy(fromX, toX, { y = 600, steps = 8, stepMs = 25 } = {}) {
    const base = await trackTx();
    await c.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: fromX, y, button: 'left', buttons: 1, clickCount: 1,
    });
    const xs = [];
    for (let i = 1; i <= steps; i++) {
      const x = fromX + ((toX - fromX) * i) / steps;
      await c.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x, y, button: 'left', buttons: 1,
      });
      await sleep(stepMs);
      xs.push(await trackTx());
    }
    await c.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: toX, y, button: 'left', buttons: 0, clickCount: 1,
    });
    await sleep(700);
    return { base, xs };
  }

  // ---------- 竖版页：不该被拆 ----------
  const comics = (await json('/api/comics?pageSize=60')).data.items;
  let portrait = null;
  for (const cm of comics) {
    const d = (await json(`/api/comics/${encodeURIComponent(cm.id)}`)).data;
    const ch = (d.chapters || []).find((x) => x.pageCount >= 2);
    if (ch) { portrait = { comic: d, chapter: ch }; break; }
  }
  if (!portrait) throw new Error('没有可用章节');

  for (const [w, h, mobile, label] of [[900, 1200, false, '桌面 900×1200'], [390, 844, true, '手机 390×844']]) {
    console.log(`\n=== 竖版普通页（${label}）===`);
    await metrics(w, h, mobile);
    setPrefs({ readerMode: 'split', readDir: 'ltr', pageAnimation: 'none', quality: 'standard' });
    await load(`/read/${encodeURIComponent(portrait.comic.id)}/${encodeURIComponent(portrait.chapter.id)}?page=0`);
    const g = await geom();
    console.log('  几何:', JSON.stringify(g));
    t('拿到的确实是竖版页（宽 < 高）', g && g.nw < g.nh, g ? `${g.nw}×${g.nh}` : 'no img');
    t('整页宽度不超出视口（没被当跨页拆开）', g && g.w <= g.bw + 1, g ? `img=${g.w} box=${g.bw}` : '');
    t('整页水平居中', g && near(g.cx, g.bx), g ? `img.cx=${g.cx} box.cx=${g.bx}` : '');
    t('整页高度不超出视口', g && g.h <= g.bh + 1, g ? `img=${g.h} box=${g.bh}` : '');

    await press('ArrowRight');
    const g2 = await geom();
    const f2 = await foot();
    t('后半页仍是同一张整图（不重新请求、不放大）', g2 && g2.src === g.src, g2 ? g2.src : '');
    t('后半页不位移（竖版页没被当成跨页拆开）', g2 && near(g2.cx, g.cx, 1) && near(g2.w, g.w, 1),
      g2 ? `cx ${g.cx}→${g2.cx} w ${g.w}→${g2.w}` : '');
    t('后半页同样完整可见', g2 && g2.w <= g2.bw + 1 && g2.h <= g2.bh + 1, g2 ? `img=${g2.w}×${g2.h}` : '');
    t('URL 记录到后半页（half=1）', f2.url.includes('half=1'), f2.url);
  }

  // ---------- 模式切换：在读页不能漂移 ----------
  console.log('\n=== 单页 → 拆分双页 → 单页 ===');
  await metrics(900, 1200, false);
  setPrefs({ readerMode: 'single', readDir: 'ltr', pageAnimation: 'none', quality: 'standard' });
  const readUrl = `/read/${encodeURIComponent(portrait.comic.id)}/${encodeURIComponent(portrait.chapter.id)}?page=5`;
  await load(readUrl);
  const imgIdx = (g) => {
    const m = g && /\/pages\/(\d+)/.exec(g.src);
    return m ? Number(m[1]) : -1;
  };
  const s0 = await foot();
  const i0 = imgIdx(await geom());
  t('单页起点：图 5（第 6 页）', i0 === 5 && s0.page === 6, `img=${i0} ${s0.page}/${s0.total}`);

  const pickMode = async (label) => {
    await c.evaluate(`document.querySelector('button[aria-label="阅读设置"]')?.click()`);
    await sleep(350);
    const clicked = await c.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(450);
    await c.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /关闭|close/i.test(x.getAttribute('aria-label') || ''));
      if (b) b.click(); else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    })()`);
    await sleep(400);
    return clicked;
  };

  t('切到拆分双页', await pickMode('拆分双页'));
  const s1 = await foot();
  const i1 = imgIdx(await geom());
  t('拆分后仍渲染图 5', i1 === 5, `img=${i1}`);
  t('拆分后 URL 图索引不变、half=0', s1.url.includes('page=5') && s1.url.includes('half=0'), s1.url);
  t('拆分后页码落到图 5 的前半页', s1.page === 11 && s1.total === portrait.chapter.pageCount * 2,
    `${s1.page}/${s1.total}`);

  t('切回单页', await pickMode('单页'));
  const s2 = await foot();
  const i2 = imgIdx(await geom());
  t('切回单页仍渲染图 5', i2 === 5, `img=${i2}`);
  t('切回单页 URL 去掉 half', s2.url.includes('page=5') && !s2.url.includes('half='), s2.url);
  t('切回单页页码为第 6 页', s2.page === 6 && s2.total === portrait.chapter.pageCount,
    `${s2.page}/${s2.total}`);

  // ---------- 宽幅跨页：两个半页都要完整可见 ----------
  fs.rmSync(wideRoot, { recursive: true, force: true });
  const dir = path.join(wideRoot, '宽幅跨页');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 2; i++) {
    writePng(path.join(dir, `${String(i + 1).padStart(3, '0')}.png`), 1700, 1000,
      widePainter(hex('#14532d'), hex('#1e3a8a')));
  }
  wideLib = (await json('/api/libraries', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '__拆分探针库__', type: 'chapter', paths: [wideRoot] }),
  })).data.id;
  await json('/api/scan', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ libraryId: wideLib }),
  });
  for (let i = 0; i < 80; i++) {
    if (!(await json('/api/scan/status')).data.running) break;
    await sleep(300);
  }
  const wideComic = (await json(`/api/comics?libraryId=${encodeURIComponent(wideLib)}&pageSize=10`)).data.items[0];
  if (!wideComic) throw new Error('宽幅夹具未入库');
  const wideChapter = (await json(`/api/comics/${wideComic.id}`)).data.chapters[0];

  for (const [w, h, mobile, label] of [[900, 1200, false, '桌面 900×1200'], [390, 844, true, '手机 390×844']]) {
    console.log(`\n=== 宽幅跨页（${label}）===`);
    await metrics(w, h, mobile);
    setPrefs({ readerMode: 'split', readDir: 'ltr', pageAnimation: 'none', quality: 'standard' });
    await load(`/read/${encodeURIComponent(wideComic.id)}/${encodeURIComponent(wideChapter.id)}?page=0`);
    const g0 = await geom();
    console.log('  左半页:', JSON.stringify(g0));
    t('不拉伸变形（渲染宽高比 = 原图）', g0 && Math.abs(g0.nw / g0.nh - g0.w / g0.h) / (g0.nw / g0.nh) < 0.02,
      g0 ? `natural=${(g0.nw / g0.nh).toFixed(3)} shown=${(g0.w / g0.h).toFixed(3)}` : '');
    t('单个半页宽度不超过视口（半页完整可见）', g0 && g0.w / 2 <= g0.bw + 1,
      g0 ? `half=${(g0.w / 2).toFixed(1)} box=${g0.bw}` : '');
    t('图高不超过视口（上下不裁）', g0 && g0.h <= g0.bh + 1, g0 ? `img=${g0.h} box=${g0.bh}` : '');
    t('左半页垂直居中', g0 && near(g0.cy, g0.by), g0 ? `cy=${g0.cy} box.cy=${g0.by}` : '');
    t('左半页居中', g0 && near(g0.lcx, g0.bx), g0 ? `half.cx=${g0.lcx} box.cx=${g0.bx}` : '');

    await press('ArrowRight');
    const g1 = await geom();
    const f1 = await foot();
    console.log('  右半页:', JSON.stringify(g1));
    t('右半页左移半个图宽', g0 && g1 && near(g0.cx - g1.cx, g0.w / 2, 3),
      g0 && g1 ? `位移=${(g0.cx - g1.cx).toFixed(1)} 半宽=${(g0.w / 2).toFixed(1)}` : '');
    t('右半页内容居中（平移量 = 半图宽）', g1 && near(g1.rcx, g1.bx), g1 ? `right.cx=${g1.rcx} box.cx=${g1.bx}` : '');
    t('右半页垂直居中', g1 && near(g1.cy, g1.by), g1 ? `cy=${g1.cy} box.cy=${g1.by}` : '');
    t('右半页同样完整可见', g1 && g1.w / 2 <= g1.bw + 1, g1 ? `half=${(g1.w / 2).toFixed(1)} box=${g1.bw}` : '');
    t('页码分母 = 图数×2', f1.total === 4, `${f1.page}/${f1.total}`);
    t('URL 记录 half=1', f1.url.includes('half=1'), f1.url);
  }

  // ---------- 翻页动画 ----------
  console.log('\n=== 翻页动画（拆分）===');
  await metrics(900, 1200, false);
  for (const anim of ['pan', 'slide', 'fade', 'none']) {
    setPrefs({ readerMode: 'split', readDir: 'ltr', pageAnimation: anim, quality: 'standard' });
    await load(`/read/${encodeURIComponent(wideComic.id)}/${encodeURIComponent(wideChapter.id)}?page=0`);

    // 进入阅读器不该播入场动画（更不该自己横滑一下）
    const entryAnim = await c.evaluate(`(() => {
      const e = document.querySelector('[data-split-layer="1"]');
      return e ? getComputedStyle(e).animationName : null;
    })()`);
    const idle = await idleXs();
    t(`${anim}：进入阅读器不播入场动画`, entryAnim === 'none', String(entryAnim));
    t(`${anim}：首屏不自己横滑`, idle.length === 1, `x=${JSON.stringify(idle)}`);

    // 半页位移：同一张图内的平移
    const half = await flipFrames('ArrowRight');
    const halfXs = uniq(half.map((f) => f.ix));
    t(`${anim}：半页位移${anim === 'none' ? '瞬时' : '平滑'}`,
      anim === 'none' ? halfXs.length <= 2 : halfXs.length > 3, `${halfXs.length} 个位置`);
    t(`${anim}：半页翻页没有离场层`, half.every((f) => f.lx === null));

    // 换图：真正的翻页
    const swap = await flipFrames('ArrowRight');
    await sleep(450);
    const eanim = uniq(swap.map((f) => f.eanim));
    const eops = swap.map((f) => f.eop).filter((v) => v !== null);
    if (anim === 'pan') {
      const tx = uniq(swap.map((f) => f.tx)).filter((v) => v !== null);
      const fs = await foot();
      t('pan：换图走同一条平移轨道', tx.length > 3, `${tx.length} 个轨道位置`);
      t('pan：轨道自带相邻页，不需要离场层', swap.every((f) => f.lx === null));
      t('pan：换图后页码推进到第 3 页', fs.page === 3, `${fs.page}/${fs.total}`);
    } else if (anim === 'slide') {
      t('slide：换图轻移 + 淡入', eanim.includes('page-slide') && Math.min(...eops) < 0.2 && Math.max(...eops) > 0.9,
        `${JSON.stringify(eanim)} opacity ${Math.min(...eops)}→${Math.max(...eops)}`);
      t('slide：不需要离场层', swap.every((f) => f.lx === null));
    } else if (anim === 'fade') {
      t('fade：换图只淡入不走位',
        eanim.includes('page-fade') && Math.min(...eops) < 0.2 && Math.max(...eops) > 0.9
          && uniq(swap.map((f) => f.ex)).length === 1,
        `${JSON.stringify(eanim)} opacity ${Math.min(...eops)}→${Math.max(...eops)}`);
      t('fade：不需要离场层', swap.every((f) => f.lx === null));
    } else {
      t('none：换图无动画', eanim.every((a) => a === 'none'), JSON.stringify(eanim));
      t('none：不需要离场层', swap.every((f) => f.lx === null));
    }
  }

  // ---------- 拖动手感：拆分应与单页一致 ----------
  console.log('\n=== 拖动（拆分 = 单页平移轨道）===');
  await metrics(900, 1200, false);
  setPrefs({ readerMode: 'split', readDir: 'ltr', pageAnimation: 'pan', quality: 'standard' });
  await load(`/read/${encodeURIComponent(wideComic.id)}/${encodeURIComponent(wideChapter.id)}?page=0`);
  const boxW = await c.evaluate(`document.querySelector('.pan-surface')?.clientWidth ?? 0`);
  const restTx = await trackTx();
  t('拆分平移模式挂了平移轨道', boxW > 0 && near(restTx, -boxW, 1), `轨道 x=${restTx} 槽宽=${boxW}`);
  const gp0 = await geom();
  t('轨道里的半页同样完整可见并居中',
    gp0 && gp0.w / 2 <= gp0.bw + 1 && near(gp0.lcx, gp0.bx),
    gp0 ? `half=${(gp0.w / 2).toFixed(1)} box=${gp0.bw} half.cx=${gp0.lcx} box.cx=${gp0.bx}` : '');

  const longDrag = await dragBy(700, 460);
  const dragged = longDrag.xs.at(-1) - longDrag.base;
  const fDrag = await foot();
  const gp1 = await geom();
  t('拖动时轨道跟手（多帧位移）', uniq(longDrag.xs).length > 3, `${uniq(longDrag.xs).length} 个位置`);
  t('轨道位移 ≈ 手指位移（1:1）', near(dragged, -240, 25), `手指 -240px，轨道 ${dragged.toFixed(1)}px`);
  t('拖过半屏松手翻到下一半页', fDrag.page === 2, `${fDrag.page}/${fDrag.total}`);
  t('翻到后半页后右半页居中', gp1 && near(gp1.rcx, gp1.bx), gp1 ? `right.cx=${gp1.rcx} box.cx=${gp1.bx}` : '');

  const shortDrag = await dragBy(700, 620);
  const fShort = await foot();
  const backTx = await trackTx();
  t('短拖不翻页（回弹）', fShort.page === 2, `${fShort.page}/${fShort.total}`);
  t('回弹后轨道归位', near(backTx, -boxW, 1), `轨道 x=${backTx}`);

  // 整本首端继续往回拖：应被顶住、弹回并提示，而不是翻页
  await load(`/read/${encodeURIComponent(wideComic.id)}/${encodeURIComponent(wideChapter.id)}?page=0`);
  await dragBy(300, 520);
  const fEdge = await foot();
  const edgeNotice = await c.evaluate(`document.body.innerText.includes('已经是第一页了')`);
  t('全书首端回拖不翻页', fEdge.page === 1, `${fEdge.page}/${fEdge.total}`);
  t('全书首端回拖给到头提示', edgeNotice);

  // 设置里来回切动画偏好：拆分先以「轻移」挂载（不挂轨道），再切到「平移」。
  // 轨道容器是切过去之后才出现的另一个节点，拖动距离必须按新容器宽度换算
  // （widthRef 只在 enabled 变化时重新测量，否则会停在空节点时的 1px）。
  setPrefs({ pageAnimation: 'slide' });
  await load(`/read/${encodeURIComponent(wideComic.id)}/${encodeURIComponent(wideChapter.id)}?page=0`);
  t('设置里切到平移', await pickMode('平移'));
  const switchedTx = await trackTx();
  t('切到平移后轨道就位', near(switchedTx, -boxW, 1), `轨道 x=${switchedTx}`);
  const again = await dragBy(700, 460);
  const againMoved = again.xs.at(-1) - again.base;
  const fAgain = await foot();
  t('切到平移后拖动仍 1:1 跟手', near(againMoved, -240, 25), `轨道 ${againMoved.toFixed(1)}px`);
  t('切到平移后拖动仍能翻页', fAgain.page === 2, `${fAgain.page}/${fAgain.total}`);


  console.log('\n=== 宽幅跨页（rtl 首屏）===');
  await metrics(390, 844, true);
  setPrefs({ readerMode: 'split', readDir: 'rtl', pageAnimation: 'none', quality: 'standard' });
  await load(`/read/${encodeURIComponent(wideComic.id)}/${encodeURIComponent(wideChapter.id)}?page=0`);
  const rtlIdle = await idleXs();
  t('rtl 首屏不自己横滑（首次量到尺寸不带过渡）', rtlIdle.length === 1, `x=${JSON.stringify(rtlIdle)}`);
  const gr = await geom();
  console.log('  首屏:', JSON.stringify(gr));
  t('rtl 首屏显示右半页并居中', gr && near(gr.rcx, gr.bx), gr ? `right.cx=${gr.rcx} box.cx=${gr.bx}` : '');
  t('rtl 首屏右半页完整可见', gr && gr.w / 2 <= gr.bw + 1, gr ? `half=${(gr.w / 2).toFixed(1)} box=${gr.bw}` : '');

  // rtl + 平移：往后翻在物理上是「向右拖」（轨道按阅读方向镜像）
  setPrefs({ pageAnimation: 'pan' });
  await load(`/read/${encodeURIComponent(wideComic.id)}/${encodeURIComponent(wideChapter.id)}?page=0`);
  await dragBy(120, 330, { y: 420 });
  const fRtlDrag = await foot();
  t('rtl 平移：向右拖翻到后半页', fRtlDrag.page === 2, `${fRtlDrag.page}/${fRtlDrag.total}`);

  c.close();
} finally {
  edge.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(wideRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  try {
    if (wideLib) await fetch(`${BASE}/api/libraries/${encodeURIComponent(wideLib)}`, { method: 'DELETE' });
  } catch { /* ignore */ }
}

console.log(`\n总计 ${ok + fail}  通过 ${ok}  失败 ${fail}`);
process.exit(fail ? 1 : 0);
