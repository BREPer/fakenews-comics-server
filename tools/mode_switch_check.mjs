/**
 * 回归：切换翻页模式（单页 / 双页 / 拆分 / 卷轴）不能影响「在读页」。
 *
 * 症状（用户报告）：切换单双页会影响在读页。
 * 待判定：切模式后当前图索引是否保持不变（允许对开配对的取整，但不能倒退一页/回第 1 页）。
 *
 * 测法：真实 UI 点击设置面板里的模式按钮，切前/切后各读一次
 *   - URL ?page=（图索引语义）
 *   - 工具栏「第 a/b 页」
 *   - 实际渲染的图索引（读 img src 里的 pages/<n>）
 *   - 等 1.5s 后服务端进度（1s 防抖后应已上报正确图索引）
 *
 * 用法：node tools/mode_switch_check.mjs [--base http://127.0.0.1:13800]
 *   会临时把设置改成 single + pan + ltr + contain，跑完恢复原值。
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
const ARG = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = (ARG('base', process.env.API_BASE || 'http://127.0.0.1:13800')).replace(/\/$/, '');
const api = async (p, init) => (await fetch(BASE + p, init)).json();

// 选一部首章页数 ≥ 8 的漫画（要能翻到第 7、8 页）
let target = null;
for (const c of (await api('/api/comics?pageSize=50')).data.items) {
  const d = (await api(`/api/comics/${c.id}`)).data;
  const chs = d.chapters ?? [];
  if (chs.length >= 1 && chs[0].pageCount >= 8) { target = { ...d, chapters: chs }; break; }
}
if (!target) throw new Error('找不到「首章 ≥8 页」的漫画：先跑 node tools/perf_fixture.mjs');

const before = (await api('/api/settings')).data;
const base = { readerMode: 'single', pageAnimation: 'pan', readDir: 'ltr', fitMode: 'contain' };
await api('/api/settings', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(base),
});

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const PORT = Number(ARG('port', '9526'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-mode-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--window-size=1200,800', 'about:blank',
], { stdio: 'ignore' });

let wsUrl;
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = list.find((t) => t.type === 'page');
    if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
  } catch { /* 未就绪 */ }
  await sleep(150);
}
if (!wsUrl) { edge.kill(); throw new Error('Edge 调试端口未就绪'); }

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
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });

const ch = target.chapters[0];
const url = (img) => `${BASE}/read/${target.id}/${encodeURIComponent(ch.id)}?page=${img}`;

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `\n    ${detail}` : ''}`);
  if (!ok) failed++;
};

/** 当前状态快照：URL 图索引 / 渲染的图索引 / 工具栏页码 */
const snapshot = () => ev(`(() => {
  const sp = new URLSearchParams(location.search);
  const img = (el) => { const m = /\\/pages\\/(\\d+)/.exec(el.currentSrc || el.src || ''); return m ? +m[1] : -1; };
  const slot1 = document.querySelector('.pan-slot[data-slot="1"]');
  const scope = slot1 || document.querySelector('.reader-canvas') || document.body;
  const visible = [...scope.querySelectorAll('img')].map(img).filter((n) => n >= 0);
  const bar = document.body.innerText.match(/第 (\\d+)\\/(\\d+) 页/);
  return {
    urlPage: sp.get('page'), half: sp.get('half'),
    visible: [...new Set(visible)],
    label: bar ? bar[0] : '',
    // 选中态看 aria-pressed，不看 class：Segmented 加了滑动指示器之后，
    // 选中背景由指示器那一层承载，按钮自身不再带 bg-brand-600（按 class 找会永远落空）
    mode: [...document.querySelectorAll('button')].find((b) => /^(卷轴|单页|双页|拆分双页)$/.test(b.textContent.trim()) && b.getAttribute('aria-pressed') === 'true')?.textContent.trim() || '',
  };
})()`);

/** 打开设置面板并点击模式按钮 */
async function pickMode(label) {
  await ev(`(() => {
    const btn = document.querySelector('button[aria-label="阅读设置"]');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(350);
  const clicked = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(450);
  // 关掉设置面板（Sheet 的关闭按钮：aria-label 含「关闭」或点遮罩）
  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /关闭|close/i.test(x.getAttribute('aria-label') || ''));
    if (b) b.click(); else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  })()`);
  await sleep(300);
  return clicked;
}

const progressOf = async () => {
  const r = await api(`/api/progress?comicIds=${encodeURIComponent(target.id)}`);
  const p = r.data.items.find((x) => x.chapterId === ch.id);
  return p ? p.pageIndex : null;
};

try {
  // ---- 场景一：单页第 7 页 → 双页，应停在含第 7 页（图 6）的对开 ----
  console.log('\n--- 场景一：单页第 7 页（图 6）→ 双页 ---');
  await send('Page.navigate', { url: url(6) });
  await sleep(2400);
  const a = await snapshot();
  console.log('  切换前：', JSON.stringify(a));
  check('单页初始位置正确', a.urlPage === '6' && a.visible.includes(6), `URL=${a.urlPage} 可见图=${a.visible}`);

  const ok1 = await pickMode('双页');
  const b = await snapshot();
  console.log('  切换后：', JSON.stringify(b));
  check('设置面板里找到「双页」按钮', ok1);
  check('切双页后当前图仍在屏幕上', b.visible.includes(6), `可见图=${b.visible}`);
  check('切双页后 URL 仍指向同一张图', b.urlPage === '6', `URL=${b.urlPage}`);
  check('切双页后对开号 = 图 6 / 2 = 3（显示第 4/4 页）', /第 4\/\d+ 页/.test(b.label), `label=${b.label}`);

  await sleep(1500);
  const p1 = await progressOf();
  check('切双页后服务端进度仍是图 6', p1 === 6, `进度=${p1}`);

  // ---- 场景二：双页 → 单页，应回到图 6（左页），不是第 1 页 ----
  console.log('\n--- 场景二：双页（对开含图 6-7）→ 单页 ---');
  const ok2 = await pickMode('单页');
  const c = await snapshot();
  console.log('  切换后：', JSON.stringify(c));
  check('设置面板里找到「单页」按钮', ok2);
  check('切回单页仍是图 6', c.visible.includes(6), `可见图=${c.visible}`);
  check('切回单页 URL 仍指向图 6', c.urlPage === '6', `URL=${c.urlPage}`);
  await sleep(1500);
  const p2 = await progressOf();
  check('切回单页后服务端进度仍是图 6', p2 === 6, `进度=${p2}`);

  // ---- 场景三：单页图 1（奇数，对开 0 的第二张）→ 双页 → 单页，必须回到图 1 ----
  console.log('\n--- 场景三：单页图 1（对开 0 = 图 0-1）→ 双页 → 单页 ---');
  await send('Page.navigate', { url: url(1) });
  await sleep(2000);
  await pickMode('双页');
  const d = await snapshot();
  console.log('  双页：', JSON.stringify(d));
  check('奇图 1 切双页落在对开 0（含图 1）', d.visible.includes(1), `可见图=${d.visible}`);
  check('奇图 1 切双页后 URL 仍指向图 1', d.urlPage === '1', `URL=${d.urlPage}`);
  await pickMode('单页');
  const e = await snapshot();
  console.log('  切回单页：', JSON.stringify(e));
  check('切回单页回到图 1（不倒退到图 0）', e.visible.includes(1) && e.urlPage === '1', `可见图=${e.visible} URL=${e.urlPage}`);

  // ---- 场景三b：单页图 7 → 双页 → 单页，也不能退到图 6 ----
  console.log('\n--- 场景三b：单页图 7 → 双页 → 单页 ---');
  await send('Page.navigate', { url: url(7) });
  await sleep(2000);
  await pickMode('双页');
  const d2 = await snapshot();
  console.log('  双页：', JSON.stringify(d2));
  check('奇图 7 切双页落在对开 3', /第 4\/\d+ 页/.test(d2.label), `label=${d2.label}`);
  check('奇图 7 切双页后 URL 仍指向图 7', d2.urlPage === '7', `URL=${d2.urlPage}`);
  await pickMode('单页');
  const e2 = await snapshot();
  console.log('  切回单页：', JSON.stringify(e2));
  check('切回单页回到图 7', e2.visible.includes(7) && e2.urlPage === '7', `可见图=${e2.visible} URL=${e2.urlPage}`);
  await sleep(1500);
  const p3 = await progressOf();
  check('往返后服务端进度是图 7', p3 === 7, `进度=${p3}`);

  // ---- 场景三c：双页中途刷新页面，仍停在同一对开 ----
  console.log('\n--- 场景三c：双页图 7 刷新页面 → 应停在对开 3 ---');
  await pickMode('双页');
  await sleep(300);
  await send('Page.reload', { ignoreCache: false });
  await sleep(2400);
  const d3 = await snapshot();
  console.log('  刷新后：', JSON.stringify(d3));
  // 设置面板关闭时模式按钮不在 DOM 里，用「当前槽位同时渲染 6、7 两图」判定双页
  check('刷新后仍在双页且含图 6-7', d3.visible.includes(6) && d3.visible.includes(7), `可见图=${d3.visible}`);
  check('刷新后 URL 仍指向图 7', d3.urlPage === '7', `URL=${d3.urlPage}`);
  await pickMode('单页');
  const e3 = await snapshot();
  check('刷新后再切单页仍回到图 7', e3.visible.includes(7), `可见图=${e3.visible}`);

  // ---- 场景四：拆分双页 → 单页，图索引不能翻倍/减半出错 ----
  console.log('\n--- 场景四：单页图 5 → 拆分双页 → 单页 ---');
  await send('Page.navigate', { url: url(5) });
  await sleep(2000);
  await pickMode('拆分双页');
  const f = await snapshot();
  console.log('  拆分：', JSON.stringify(f));
  check('切拆分双页仍渲染图 5', f.visible.includes(5), `可见图=${f.visible}`);
  check('拆分模式 URL 图索引仍是 5', f.urlPage === '5', `URL=${f.urlPage}`);
  await pickMode('单页');
  const g = await snapshot();
  console.log('  切回单页：', JSON.stringify(g));
  check('从拆分切回单页仍是图 5', g.visible.includes(5) && g.urlPage === '5', `可见图=${g.visible} URL=${g.urlPage}`);

  // ---- 场景五：单页 → 卷轴 → 单页 ----
  console.log('\n--- 场景五：单页图 4 → 卷轴 → 单页 ---');
  await send('Page.navigate', { url: url(4) });
  await sleep(2000);
  await pickMode('卷轴');
  const h = await snapshot();
  console.log('  卷轴：', JSON.stringify(h));
  await sleep(600);
  const h2 = await snapshot();
  check('切卷轴后停在同一张图', h2.visible.includes(4), `可见图=${h2.visible}`);
  await pickMode('单页');
  const i = await snapshot();
  console.log('  切回单页：', JSON.stringify(i));
  check('卷轴切回单页仍停在图 4', i.visible.includes(4) && i.urlPage === '4', `可见图=${i.visible} URL=${i.urlPage}`);
} finally {
  await api('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      readerMode: before.readerMode,
      pageAnimation: before.pageAnimation,
      readDir: before.readDir,
      fitMode: before.fitMode,
    }),
  }).catch(() => {});
  ws.close();
  edge.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 句柄未释放时忽略 */ }
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
