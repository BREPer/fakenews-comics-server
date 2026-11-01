/**
 * 平移翻页 · 新页加载空白探针
 *
 * 复现目标：平移模式下往一侧拖动/点击翻页时，新出现的一页有短暂空白。
 * 做法：逐帧记录轨道里每一页 <img> 的 complete / naturalWidth / opacity，
 * 重点看「翻页发生的那一刻，即将成为当前页的那张图是否已经解码完成」。
 *
 *   node tools/pan_load_check.mjs                # 正常网速
 *   node tools/pan_load_check.mjs --slow=fast3g   # 用 CDP 模拟慢网放大问题
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
  const kv = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (kv) return kv.slice(n.length + 3);
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = ARG('base', 'http://127.0.0.1:13800').replace(/\/$/, '');
const SLOW = ARG('slow', '');
const COMIC = ARG('comic', '8a47483571299bde');

const api = async (p, i) => (await fetch(BASE + p, i)).json();
const put = (b) => api('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const before = (await api('/api/settings')).data;

// 统一成「单页 + 平移 + 预加载 3 + 日漫右翻」，避免受本地遗留设置影响。
// rtl 下点屏幕左侧才是「往后翻」，探针据此定向。
await put({ readerMode: 'single', pageAnimation: 'pan', preloadCount: 3, quality: 'standard', readDir: 'rtl' });

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const PORT = 9701;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-panload-'));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });

let wsUrl;
for (let i = 0; i < 80; i++) {
  try { const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = t.find((x) => x.type === 'page'); if (p) { wsUrl = p.webSocketDebuggerUrl; break; } } catch { /* 等 */ }
  await sleep(150);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0; const pend = new Map();
/** 页面图的网络请求（URL -> 次数）：重复请求说明缓存/预加载没命中 */
const pageReqs = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); return; }
  if (m.method === 'Network.responseReceived') {
    const u = m.params?.response?.url || '';
    if (/\/api\/comics\/.+\/pages?\//.test(u) || /\/page\//.test(u)) pageReqs.set(u, (pageReqs.get(u) ?? 0) + 1);
  }
});
const send = (m, p = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;

await send('Page.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

if (SLOW) {
  const profiles = {
    fast3g: { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
    slow3g: { offline: false, latency: 400, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8 },
  };
  await send('Network.emulateNetworkConditions', profiles[SLOW] ?? profiles.fast3g);
  console.log(`网络模拟: ${SLOW}`, JSON.stringify(profiles[SLOW] ?? profiles.fast3g));
}

await send('Page.navigate', { url: `${BASE}/read/${COMIC}/${encodeURIComponent(COMIC + '#0')}` });
// 等阅读器真正就绪（慢网下 2.6s 不够，footer 里的页码还没渲染）
for (let i = 0; i < 60; i++) {
  const ok = await ev(`(() => !!(document.querySelector('footer') && /\\d+\\s*\\/\\s*\\d+/.test(document.querySelector('footer').innerText || '')))()`);
  if (ok) break;
  await sleep(250);
}
await sleep(600);

/** 轨道里所有页的加载状态 */
const snapshot = () => ev(`(() => {
  const slots = [...document.querySelectorAll('.pan-slot')];
  return slots.map((s) => {
    const img = s.querySelector('img');
    return {
      page: Number(s.dataset.page),
      hasImg: !!img,
      complete: img ? img.complete : null,
      w: img ? img.naturalWidth : 0,
      opacity: img ? getComputedStyle(img).opacity : null,
    };
  });
})()`);

const pageNo = () => ev(`(() => { const m = (document.querySelector('footer')?.innerText || '').match(/(\\d+)\\s*\\/\\s*(\\d+)/); return m ? Number(m[1]) : -1; })()`);
// rtl（日漫右翻）下点屏幕左侧才是往后翻
const tapAdvance = async () => {
  const y = 420;
  const x = 40;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(40);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
};

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}  ${x}`); } };

console.log(`\n=== 平移翻页加载状态（${SLOW || '正常网速'}） ===`);
const startPage = await pageNo();
console.log(`起始页 ${startPage}`);

for (let step = 0; step < 4; step++) {
  const curPage = await pageNo();
  const beforeSnap = await snapshot();
  const cur = beforeSnap.find((s) => s.page === curPage - 1);
  // 即将翻到的那页在轨道里是「更靠后的一格」
  const upcoming = beforeSnap.filter((s) => s.page >= 0 && s.page > (cur?.page ?? -1)).sort((a, b) => a.page - b.page)[0];

  await tapAdvance();
  // 翻页刚发生的 120ms 内采样：这时如果新页没解码完，用户看到的就是空白
  await sleep(120);
  const during = await snapshot();
  const nowPage = await pageNo();
  const target = during.find((s) => s.page === nowPage - 1);
  const blankDuring = target && (!target.hasImg || !target.complete || target.w === 0);
  ok(nowPage !== curPage && nowPage > 0, `第 ${curPage} 页 -> 第 ${nowPage} 页（翻页生效）`, `now=${nowPage}`);
  ok(!blankDuring, `第 ${nowPage} 页在翻页瞬间已可显示（预加载命中）`,
    `upcomingBefore={page:${upcoming?.page},complete:${upcoming?.complete},w:${upcoming?.w}} duringTarget=${JSON.stringify(target)}`);
  if (blankDuring) console.log(`      ↳ 翻页后 120ms 该页仍未解码：complete=${target?.complete} naturalWidth=${target?.w}`);

  await sleep(600);
  const after = await snapshot();
  const settled = after.find((s) => s.page === nowPage - 1);
  ok(!!settled && settled.complete && settled.w > 0, `第 ${nowPage} 页最终加载完成`, JSON.stringify(settled));
}

await put({ ...before, readerMode: before.readerMode, pageAnimation: before.pageAnimation, preloadCount: before.preloadCount, quality: before.quality }).catch(() => {});
const dupReqs = [...pageReqs.entries()].filter(([, n]) => n > 1);
console.log(`\n页面图请求：${pageReqs.size} 个 URL，其中重复请求 ${dupReqs.length} 个`);
if (dupReqs.length) dupReqs.slice(0, 5).forEach(([u, n]) => console.log(`    ×${n}  ${u.replace(BASE, '')}`));
ok(dupReqs.length === 0, '每张页图只请求一次（预加载既没被取消，也没在翻页时重复拉取）', JSON.stringify(dupReqs.slice(0, 3)));

// ---- 跨章预取：停在章末时，下一章首页应已进缓存 ----
const detail = (await api(`/api/comics/${COMIC}`)).data;
const chs = detail.chapters ?? [];
const i0 = chs.findIndex((c, i) => i < chs.length - 1 && (c.pageCount || 0) >= 2);
if (i0 >= 0) {
  const ch = chs[i0], nxt = chs[i0 + 1];
  pageReqs.clear();
  // page 参数超界会被 clamp 到末页，正好触发「距章末 2 页内」的跨章预取
  await send('Page.navigate', { url: `${BASE}/read/${COMIC}/${encodeURIComponent(ch.id)}?page=999` });
  await sleep(3600);
  const urls = [...pageReqs.keys()];
  const hitNext = urls.some((u) => u.includes(encodeURIComponent(nxt.id)) || u.includes(nxt.id));
  ok(hitNext, `章末自动预取下一章首页（${nxt.title}）`, `已请求 ${urls.length} 个：${urls.map((u) => u.replace(BASE, '')).slice(0, 6).join(' ')}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close();
edge.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(fail ? 1 : 0);
