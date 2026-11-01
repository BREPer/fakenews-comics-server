/**
 * 双页模式检查：显示（两页完整可见、左右顺序、居中）+ 四种翻页动画。
 *
 * 症状（用户报告）：双页模式两页各自被裁掉近一半。
 * 根因：两页按高度铺满（h-full w-auto）后再并排，总宽远超视口；居中溢出把外侧裁掉。
 * 现在每页放进半屏格再 contain，窄屏上整对缩小、宽屏上自然铺满高度。
 *
 * 用法：node tools/double_check.mjs [baseUrl]
 * 前置：dev 服务已启动（默认 http://127.0.0.1:5173）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { injectPrefs } from './lib/prefs.mjs';

const BASE = (process.argv[2] || 'http://127.0.0.1:5173').replace(/\/$/, '');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CDP_PORT = 9339;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-double-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = async (p) => (await fetch(BASE + p)).json();

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
const uniq = (list) => [...new Set(list)];

try {
  const c = client(await waitCdp());
  await c.ready;
  await c.send('Page.enable');
  await c.send('Runtime.enable');

  const metrics = (w, h, mobile) =>
    c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });

  let prefs = {};
  const setPrefs = (patch) => { prefs = { ...prefs, ...patch }; };
  const load = async (url) => {
    await injectPrefs(c.send, prefs);
    await c.send('Page.navigate', { url: BASE + url });
    for (let i = 0; i < 100; i++) {
      if (await c.evaluate('document.readyState === "complete" && !!document.querySelector("footer")')) break;
      await sleep(150);
    }
    // 等当前跨页两张图都量到自然尺寸
    for (let i = 0; i < 60; i++) {
      const done = await c.evaluate(`(() => {
        const imgs = [...document.querySelectorAll('.pan-track img, [data-double-layer] img')];
        return imgs.length >= 2 && imgs.every((i) => i.complete && i.naturalWidth > 0);
      })()`);
      if (done) break;
      await sleep(100);
    }
    await sleep(300);
  };
  const foot = () => c.evaluate(`(() => {
    const f = document.querySelector('footer');
    const m = /(\\d+)\\/(\\d+)/.exec(f ? f.textContent : '');
    return { page: m ? Number(m[1]) : null, total: m ? Number(m[2]) : null, url: location.search };
  })()`);

  /**
   * 当前跨页的两张图：平移轨道按 URL 里的图索引算出跨页号取对应槽位，
   * 非平移偏好下整页只有当前这一对。
   * 返回每页的「实际画出来的矩形」：<img> 是 object-contain，框比位图大。
   */
  const pairState = () => c.evaluate(`(() => {
    const sp = new URLSearchParams(location.search);
    const img = Number(sp.get('page') || 0);
    const spread = Math.floor(img / 2);
    const surface = document.querySelector('.pan-surface');
    const layer = document.querySelector('[data-double-layer]');
    // 平移看当前跨页槽位；其余偏好整页只有入场层这一对
    const scope = surface ? surface.querySelector('.pan-slot[data-page="' + spread + '"]') : layer;
    const boxEl = surface || (layer && layer.parentElement);
    if (!scope || !boxEl) return null;
    const b = boxEl.getBoundingClientRect();
    const pageNo = (i) => { const m = /\\/pages\\/(\\d+)/.exec(i.currentSrc || i.src); return m ? Number(m[1]) : -1; };
    const drawn = (i) => {
      const r = i.getBoundingClientRect();
      const ar = i.naturalWidth / i.naturalHeight;
      let w = r.width, h = r.height;
      if (w / h > ar) w = h * ar; else h = w / ar;
      // 书脊对齐靠 object-position（right/left），这里按实际定位算未裁切图的位置
      const [opx, opy] = getComputedStyle(i).objectPosition.split(' ');
      const axis = (raw, slack) => raw.endsWith('%') ? slack * (parseFloat(raw) / 100) : parseFloat(raw);
      return {
        x: r.left + axis(opx, r.width - w),
        y: r.top + axis(opy, r.height - h),
        w, h,
        nw: i.naturalWidth, nh: i.naturalHeight,
        page: pageNo(i),
      };
    };
    return {
      vw: innerWidth, vh: innerHeight,
      box: { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 },
      imgs: [...scope.querySelectorAll('img')].filter((i) => i.complete && i.naturalWidth > 0).map(drawn),
    };
  })()`);

  /** 采样一次翻页：平移轨道位移 / 非平移层的动画名、透明度、位移 */
  const flipFrames = (key) =>
    c.evaluate(`(async () => {
      const track = () => document.querySelector('.pan-track');
      const layer = () => document.querySelector('.anim-page-slide, .anim-page-fade');
      const frames = [];
      const t0 = performance.now();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true }));
      await new Promise((resolve) => {
        const tick = () => {
          const t = track();
          const l = layer();
          const ls = l ? getComputedStyle(l) : null;
          frames.push({
            tx: t ? +new DOMMatrixReadOnly(getComputedStyle(t).transform).m41.toFixed(1) : null,
            anim: ls ? ls.animationName : null,
            op: ls ? +ls.opacity : null,
            x: l ? +l.getBoundingClientRect().left.toFixed(1) : null,
          });
          if (performance.now() - t0 < 430) requestAnimationFrame(tick); else resolve();
        };
        requestAnimationFrame(tick);
      });
      return frames;
    })()`);

  const dragBy = async (fromX, toX, y) => {
    const base = await c.evaluate(`(() => { const t = document.querySelector('.pan-track'); return t ? +new DOMMatrixReadOnly(getComputedStyle(t).transform).m41.toFixed(1) : null; })()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y, button: 'left', buttons: 1, clickCount: 1 });
    const xs = [];
    for (let i = 1; i <= 8; i++) {
      const x = fromX + ((toX - fromX) * i) / 8;
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
      await sleep(25);
      xs.push(await c.evaluate(`(() => { const t = document.querySelector('.pan-track'); return t ? +new DOMMatrixReadOnly(getComputedStyle(t).transform).m41.toFixed(1) : null; })()`));
    }
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(700);
    return { base, xs };
  };

  const press = async (key) => {
    await c.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true }))`);
    await sleep(350);
  };

  // 选一本至少 6 页的书
  let target = null;
  for (const cm of (await json('/api/comics?pageSize=60')).data.items) {
    const d = (await json(`/api/comics/${encodeURIComponent(cm.id)}`)).data;
    const ch = (d.chapters || []).find((x) => x.pageCount >= 6);
    if (ch) { target = { comic: d, chapter: ch }; break; }
  }
  if (!target) throw new Error('没有可用章节');
  const readUrl = (page) =>
    `/read/${encodeURIComponent(target.comic.id)}/${encodeURIComponent(target.chapter.id)}?page=${page}`;

  // ---------- 显示：两页完整可见 ----------
  for (const [w, h, mobile, label] of [
    [900, 1200, false, '桌面 900×1200'],
    [1920, 1080, false, '宽屏 1920×1080'],
    [390, 844, true, '手机 390×844'],
  ]) {
    for (const anim of ['pan', 'slide', 'fade', 'none']) {
      console.log(`\n=== 双页显示（${label} / ${anim}）===`);
      await metrics(w, h, mobile);
      setPrefs({ readerMode: 'double', readDir: 'ltr', pageAnimation: anim, quality: 'standard' });
      await load(readUrl(0));
      const s = await pairState();
      const f = await foot();
      console.log('  两页:', s ? JSON.stringify(s.imgs) : 'null');
      if (!s) { t('拿到当前跨页', false); continue; }
      t('第一跨渲染两张图', s.imgs.length === 2, `${s.imgs.length} 张`);
      t('两页都完整落在阅读区内',
        s.imgs.every((r) => r.x >= s.box.x - 1 && r.x + r.w <= s.box.x + s.box.w + 1
          && r.y >= s.box.y - 1 && r.y + r.h <= s.box.y + s.box.h + 1),
        s.imgs.map((r) => `${r.w.toFixed(0)}×${r.h.toFixed(0)}@${r.x.toFixed(0)},${r.y.toFixed(0)}`).join(' | ')
          + ` / 区 ${s.box.w.toFixed(0)}×${s.box.h.toFixed(0)}`);
      t('两页不重叠', s.imgs[1].x >= s.imgs[0].x + s.imgs[0].w - 1.5,
        `右边缘 ${(s.imgs[0].x + s.imgs[0].w).toFixed(1)} / 左边缘 ${s.imgs[1].x.toFixed(1)}`);
      t('两页之间只有书脊缝（不各自居中留大空档）',
        s.imgs[1].x - (s.imgs[0].x + s.imgs[0].w) <= 10,
        `缝 ${(s.imgs[1].x - (s.imgs[0].x + s.imgs[0].w)).toFixed(1)}px`);
      t('每页比例不变形',
        s.imgs.every((r) => Math.abs(r.nw / r.nh - r.w / r.h) / (r.nw / r.nh) < 0.02),
        s.imgs.map((r) => (r.w / r.h).toFixed(3)).join(', '));
      t('两页垂直居中',
        s.imgs.every((r) => near(r.y + r.h / 2, s.box.cy, 2)),
        s.imgs.map((r) => (r.y + r.h / 2).toFixed(1)).join(', ') + ` / 区中心 ${s.box.cy.toFixed(1)}`);
      t('整对水平居中',
        near((s.imgs[0].x + s.imgs[1].x + s.imgs[1].w) / 2, s.box.cx, 2),
        `pair.cx=${((s.imgs[0].x + s.imgs[1].x + s.imgs[1].w) / 2).toFixed(1)} 区中心=${s.box.cx.toFixed(1)}`);
      t('ltr 左页是图 0、右页是图 1', s.imgs[0].page === 0 && s.imgs[1].page === 1,
        `${s.imgs[0].page},${s.imgs[1].page}`);
      t('页码 1/总跨页数', f.page === 1 && f.total === Math.ceil(target.chapter.pageCount / 2),
        `${f.page}/${f.total}`);
    }
  }

  // ---------- 翻页动画 ----------
  console.log('\n=== 双页翻页动画 ===');
  await metrics(900, 1200, false);
  for (const anim of ['pan', 'slide', 'fade', 'none']) {
    setPrefs({ readerMode: 'double', readDir: 'ltr', pageAnimation: anim, quality: 'standard' });
    await load(readUrl(0));
    const rest = await c.evaluate(`(() => {
      const l = document.querySelector('.anim-page-slide, .anim-page-fade');
      const t = document.querySelector('.pan-track');
      return {
        anim: l ? getComputedStyle(l).animationName : null,
        tx: t ? +new DOMMatrixReadOnly(getComputedStyle(t).transform).m41.toFixed(1) : null,
      };
    })()`);
    // 首屏与单页一致：按偏好挂对应入场动画（slide/fade 首次打开会有一次轻微入画，属既有行为）
    const entryOk = anim === 'pan' || anim === 'none' ? rest.anim === null : rest.anim === `page-${anim}`;
    t(`${anim}：首屏挂的是本模式动画`, entryOk, String(rest.anim));
    if (anim === 'pan') {
      const sw = await c.evaluate(`document.querySelector('.pan-surface')?.clientWidth ?? 0`);
      t('pan：轨道就位（位移 = 一槽宽）', sw > 0 && near(rest.tx, -sw, 1), `x=${rest.tx} 槽宽=${sw}`);
    }

    const frames = await flipFrames('ArrowRight');
    const f = await foot();
    if (anim === 'pan') {
      const tx = uniq(frames.map((x) => x.tx)).filter((v) => v !== null);
      t('pan：翻页走平移轨道', tx.length > 3, `${tx.length} 个位置`);
      t('pan：没有额外的入场层动画', frames.every((x) => x.anim === null));
    } else if (anim === 'slide') {
      const anims = uniq(frames.map((x) => x.anim));
      const ops = frames.map((x) => x.op).filter((v) => v !== null);
      t('slide：轻移 + 淡入', anims.includes('page-slide') && Math.min(...ops) < 0.2 && Math.max(...ops) > 0.9,
        `${JSON.stringify(anims)} opacity ${Math.min(...ops)}→${Math.max(...ops)}`);
    } else if (anim === 'fade') {
      const anims = uniq(frames.map((x) => x.anim));
      const ops = frames.map((x) => x.op).filter((v) => v !== null);
      t('fade：只淡入不走位',
        anims.includes('page-fade') && Math.min(...ops) < 0.2 && Math.max(...ops) > 0.9
          && uniq(frames.map((x) => x.x)).length === 1,
        `${JSON.stringify(anims)} opacity ${Math.min(...ops)}→${Math.max(...ops)}`);
    } else {
      const anyAnim = await c.evaluate(`!!document.querySelector('[class*="anim-page-"]')`);
      t('none：换页无动画', !anyAnim && frames.every((x) => x.anim === null));
    }
    t(`${anim}：键盘翻页前进到第 2 跨页`, f.page === 2, `${f.page}/${f.total}`);
    const s = await pairState();
    t(`${anim}：翻页后两页仍完整可见`,
      s && s.imgs.length === 2 && s.imgs.every((r) => r.x >= s.box.x - 1 && r.x + r.w <= s.box.x + s.box.w + 1),
      s ? s.imgs.map((r) => `${r.w.toFixed(0)}×${r.h.toFixed(0)}`).join(' | ') : 'null');
  }

  // ---------- rtl 左右顺序 ----------
  console.log('\n=== 双页 rtl（左右顺序）===');
  setPrefs({ readerMode: 'double', readDir: 'rtl', pageAnimation: 'none', quality: 'standard' });
  await load(readUrl(0));
  const r = await pairState();
  t('rtl 右页是图 0、左页是图 1', r && r.imgs[0].page === 1 && r.imgs[1].page === 0,
    r ? `${r.imgs[0].page},${r.imgs[1].page}` : 'null');
  // rtl 下「下一跨」按阅读方向的左箭头（右箭头在 rtl 是回退，与单页一致）
  await press('ArrowLeft');
  const r2 = await pairState();
  t('rtl 按阅读方向左键 → 下一跨（图 2/3）', r2 && r2.imgs[0].page === 3 && r2.imgs[1].page === 2,
    r2 ? `${r2.imgs[0].page},${r2.imgs[1].page}` : 'null');

  // ---------- 平移拖动 ----------
  console.log('\n=== 双页平移拖动 ===');
  setPrefs({ readerMode: 'double', readDir: 'ltr', pageAnimation: 'pan', quality: 'standard' });
  await load(readUrl(0));
  const d = await dragBy(700, 460, 600);
  const moved = d.xs.at(-1) - d.base;
  const fd = await foot();
  t('拖动轨道 1:1 跟手', near(moved, -240, 25), `手指 -240px，轨道 ${moved.toFixed(1)}px`);
  t('拖过半屏后翻到第 2 跨页', fd.page === 2, `${fd.page}/${fd.total}`);

  c.close();
} finally {
  edge.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n总计 ${ok + fail}  通过 ${ok}  失败 ${fail}`);
process.exit(fail ? 1 : 0);
