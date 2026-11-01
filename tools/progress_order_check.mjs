// 验证阅读进度上报：顺序单调、请求被合并、服务端最终值 = 最后位置。
//
// 背景：useProgressSync 以前每次 flush 都直接 mutate，快速翻页后立刻退出会在同一
// 瞬间发出多个 PUT。同域多连接下收包顺序不定，旧值可能覆盖新值（续读位置回退）。
// 现在改为单飞 + 合并，这个脚本用 CDP 监听 Network 事件核对请求序列。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = 'http://127.0.0.1:13800';
const PORT = 9811;
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));

const api = async (p) => (await fetch(BASE + p)).json();
const comics = (await api('/api/comics?pageSize=20')).data.items;
// 挑一本有多页的
let target = null;
for (const c of comics) {
  const d = (await api(`/api/comics/${c.id}`)).data;
  const ch = (d.chapters ?? []).find((x) => (x.pageCount || 0) >= 6);
  if (ch) { target = { comic: d, ch }; break; }
}
if (!target) {
  console.error('没有 ≥6 页的章节');
  process.exit(1);
}
const { comic, ch } = target;
console.log(`目标：${comic.title} / ${ch.title}（${ch.pageCount} 页）`);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-po-'));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
let wsUrl;
for (let i = 0; i < 100; i++) {
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
/** PUT /api/progress 的发出顺序（按 CDP 时间戳） */
const puts = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const r = m.params.request;
    if (r.method === 'PUT' && r.url.includes('/api/progress')) {
      let page;
      try { page = JSON.parse(r.postData ?? '{}').pageIndex; } catch { page = undefined; }
      puts.push({ ts: m.params.timestamp, page });
    }
  }
});
const send = (m, p = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })); });
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;

await send('Page.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

const pageNo = () => ev(`(() => { const m = (document.querySelector('footer')?.innerText || '').match(/(\\d+)\\s*\\/\\s*(\\d+)/); return m ? Number(m[1]) : -1; })()`);

await send('Page.navigate', { url: `${BASE}/` });
await sleep(1500);
await send('Page.navigate', { url: `${BASE}/read/${comic.id}/${encodeURIComponent(ch.id)}` });
await sleep(2400);
console.log(`进入阅读器，起始页码 ${await pageNo()}`);

// 用底部页码滑块直接定位（与点按/键盘走同一个 onPageChange，确定且不受 readDir 方向影响）
const setPage = async (n) => ev(`(() => {
  const i = document.querySelector('input[aria-label="页码"]');
  if (!i) return false;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(i, String(${n}));
  i.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);

const start = Math.max(0, (await pageNo()) - 1);
// 快速连跳 5 个位置：每次间隔 160ms，远小于 1s 防抖 —— 中间位置应当被合并成一次请求
for (let i = 1; i <= 5; i++) {
  await setPage(Math.min(start + i, ch.pageCount - 1));
  await sleep(160);
}
const lastPage = await pageNo();
console.log(`连续跳页 ${start + 1} → ${lastPage}`);

// 立刻退出（点返回按钮 → SPA 内导航，触发组件卸载 flush）
const exited = await ev(`(() => {
  const b = document.querySelector('[aria-label="退出阅读"]') || document.querySelector('[aria-label="返回"]');
  if (b) { b.click(); return 'button'; }
  history.back();
  return 'history.back';
})()`);
await sleep(2500);
console.log(`退出方式：${exited}  当前路由 ${await ev('location.pathname')}`);

const outSeq = puts.map((p) => ({ page: p.page, chapter: '' }));
const pages = outSeq.map((p) => p.page).filter((x) => typeof x === 'number');
// 单调性只在**同一章节内**成立：跨章时 pageIndex 会归零重来（29 → 下一章第 0 页）
let monotonic = true;
for (let i = 1; i < outSeq.length; i++) {
  const a = outSeq[i - 1], b = outSeq[i];
  if (a.chapter && b.chapter && a.chapter !== b.chapter) continue; // 换章，重新开始计数
  if (b.page < a.page) { monotonic = false; break; }
}
console.log(`\n=== 上报序列（共 ${outSeq.length} 次 PUT） ===`);
console.log('  顺序:', outSeq.map((p) => `${p.page}${p.chapter ? '@' + String(p.chapter).slice(-3) : ''}`).join(' → ') || '（无）');

const server = (await api(`/api/comics/${comic.id}`)).data.progress;
console.log(`  服务端最终进度：pageIndex=${server?.pageIndex} / ${server?.pageCount}（${server?.percent}%）`);
console.log(`  最后停留页码：${lastPage}`);

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}  ${extra}`); } };
console.log('');
ok(pages.length > 0, '确实发出了进度上报');
ok(monotonic, '上报顺序单调不减（没有旧值覆盖新值）', pages.join(','));
ok(puts.length <= 6, `请求被合并（${puts.length} 次，5 次翻页 + 1 次退出）`, `puts=${puts.length}`);
ok(server && Math.abs(server.pageIndex - (lastPage - 1)) <= 0, `服务端记录 = 最后停留位置（${server?.pageIndex} vs ${lastPage - 1}）`, JSON.stringify(server));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close();
edge.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(fail ? 1 : 0);
