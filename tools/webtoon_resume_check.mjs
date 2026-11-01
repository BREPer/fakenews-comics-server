/**
 * 卷轴模式「有阅读记录时继续阅读黑屏」复现/回归探针。
 *
 * 背景（2026-10-24）：
 *   WebtoonPager 用窗口化（只挂当前页 ±6/+10 张），并且首图加载后才知道页面的
 *   高宽比（aspect），此前未加载的页占位高度为 0。于是「从第 N 页续读」时：
 *     - 进入瞬间容器 scrollHeight 还是塌陷值（只有尾部 h-16）
 *     - itemRefs[N].scrollIntoView() 是 no-op，定位失败 → 停在页面顶部
 *     - 顶部 N-6 页的 img 被窗口化裁掉，只剩空 div（aspect 就位后撑高）→ 一片黑
 *   没有阅读记录时 pageIndex=0，窗口含首页，第一张 eager 加载 → 正常。
 *
 * 校验项：
 *   1) 容器 scrollHeight 与页数匹配（不是塌陷值）
 *   2) 续读页（?page=N）滚动到位：scrollTop ≈ itemRefs[N].offsetTop
 *   3) 视口内（顶部 1/3）至少有一张已加载图片（naturalWidth > 0）
 *   4) 进度没被改写回第 0 页（URL ?page= 仍为 N）
 *   5) 窗口边界处的页有占位高度（不会露出浏览器白底/黑底缝隙）
 *
 * 用法：node tools/webtoon_resume_check.mjs [--comic=id] [--chapter=id#0] [--page=15]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { injectPrefs } from './lib/prefs.mjs';

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
const APP = ARG('base', 'http://127.0.0.1:5173').replace(/\/$/, '');
const API = ARG('api', 'http://127.0.0.1:13800').replace(/\/$/, '');
const PAGE_ARG = Math.trunc(Number(ARG('page', '15')));
const TAG = ARG('tag', 'resume');
const api = async (p, i) => (await fetch(API + p, i)).json();
const put = (b) => api('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

let comic = ARG('comic', '');
let detail = null;
if (comic) {
  detail = (await api(`/api/comics/${comic}`)).data;
} else {
  // 挑第一本真有章节的：夹具重生成后 items[0] 可能还没有章
  for (const c of (await api('/api/comics?pageSize=8')).data.items) {
    const d = (await api(`/api/comics/${c.id}`)).data;
    if (d.chapters && d.chapters.length) { comic = c.id; detail = d; break; }
  }
}
if (!detail || !detail.chapters?.length) { console.log('没有可用章节，跳过'); process.exit(0); }
const chapter = detail.chapters[0];
// 页数自适应：以前写死 15 页，换成页数少的夹具（如 4 页）后会被 clamp 成末页，
// 「进度没被改回第 0 页」那条断言拿 15 去比就假失败。取「中间偏后」且在范围内。
const PAGE = Math.min(Math.max(0, PAGE_ARG), Math.max(0, chapter.pageCount - 1));
const before = (await api('/api/settings')).data;
const beforeProgress = detail.progress;
// 卷轴模式改为注入本机偏好（服务端已不接受 readerMode）
await api('/api/progress', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    comicId: comic,
    chapterId: chapter.id,
    chapterIndex: 0,
    pageIndex: PAGE,
    pageCount: chapter.pageCount,
    percent: Math.round(((PAGE + 1) / chapter.pageCount) * 1000) / 10,
  }),
});

const url = `${APP}/read/${encodeURIComponent(comic)}/${encodeURIComponent(chapter.id)}?page=${PAGE}`;
console.log(`comic=${comic} chapter=${chapter.id} pages=${chapter.pageCount} 续读页=${PAGE}`);

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const PORT = 9652;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-webtoon-'));
const edge = spawn(
  EDGE,
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=420,880', 'about:blank'],
  { stdio: 'ignore' },
);
let wsUrl;
for (let i = 0; i < 80; i++) {
  try {
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = t.find((x) => x.type === 'page');
    if (p) {
      wsUrl = p.webSocketDebuggerUrl;
      break;
    }
  } catch {
    /* 等 CDP */
  }
  await sleep(150);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m.result);
    pend.delete(m.id);
  }
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
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 880, deviceScaleFactor: 2, mobile: true });
// 卷轴模式 + 迁移标记（探针不消费服务端旧偏好）
await injectPrefs(send, { readerMode: 'webtoon' });

/** 采样卷轴状态 */
const sample = () => ev(`(() => {
  const c = document.querySelector('.overflow-y-auto.overscroll-contain');
  if (!c) return { found: false };
  const items = [...c.children].filter((d) => d.querySelector('img') !== null || d.tagName === 'DIV');
  const rows = items.slice(0, 24).map((d, i) => {
    const img = d.querySelector('img');
    const r = d.getBoundingClientRect();
    return {
      i,
      h: Math.round(r.height),
      ar: getComputedStyle(d).aspectRatio,
      img: !!img,
      loaded: img ? (img.complete && img.naturalWidth > 0) : false,
    };
  });
  const loaded = rows.filter((r) => r.loaded);
  // 视口上 1/3 命中的元素：用来判断用户「看到」的是图还是黑块
  const cx = Math.round(innerWidth / 2);
  const cy = Math.round(c.clientHeight * 0.3);
  const at = document.elementFromPoint(cx, cy);
  const atImg = at && at.tagName === 'IMG' ? (at.complete && at.naturalWidth > 0 ? '图' : '图(未加载完)') : at ? at.tagName.toLowerCase() + '#' + String(at.className || '').slice(0, 20) : null;
    const urlPage = new URLSearchParams(location.search).get('page');
    // 「当前页」按 URL 动态取（切章 / 切模式后它可能已经不是入参 PAGE），
    // 定位是否到位的判据是 scrollTop ≈ 当前页的 offsetTop
    const cur = Number(urlPage || '0');
    const t = items[Math.min(Math.max(cur, 0), Math.max(0, items.length - 1))];
    const targetOffset = t ? Math.round(t.getBoundingClientRect().top + c.scrollTop) : null;
    return {
      found: true,
      scrollH: c.scrollHeight,
      clientH: c.clientHeight,
      scrollTop: Math.round(c.scrollTop),
      itemCount: items.length,
      rows,
      loadedCount: loaded.length,
      firstLoadedIndex: loaded.length ? loaded[0].i : null,
      atTop: atImg,
      urlPage,
      targetOffset,
    };
})()`);

await send('Page.navigate', { url });
await sleep(2600);
const s1 = await sample();
console.log('\n== 进入 2.6s ==');
console.log(JSON.stringify(s1, null, 1));

await sleep(2600);
const s2 = await sample();
console.log('\n== 进入 5.2s ==');
console.log(JSON.stringify({ ...s2, rows: s2.rows.slice(0, 12) }, null, 1));

fs.mkdirSync(path.resolve('_shots'), { recursive: true });
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.resolve('_shots', `webtoon-resume-${TAG}.png`), Buffer.from(shot.data, 'base64'));

const results = [];
const check = (name, ok, info) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info === undefined ? '' : `  ${typeof info === 'string' ? info : JSON.stringify(info)}`}`);
};

console.log('\n== 判定 ==');
const last = s2?.found ? s2 : s1;
check('容器 scrollHeight 正常（未塌陷）', !!last.found && last.scrollH > last.clientH * 2, `scrollH=${last.scrollH} clientH=${last.clientH}`);
// 章末那几页会被「容器底部」截断：scrollIntoView 想把目标页放到顶部，
// 但最多只能滚到 scrollH - clientH。判定时把这段截断考虑进去。
const maxScroll = last.found ? last.scrollH - last.clientH : 0;
const want = last.targetOffset === null ? null : Math.min(last.targetOffset, maxScroll);
check(
  '续读页滚动到位（scrollTop ≈ min(目标页 offsetTop, 最大滚动距离)）',
  want !== null && Math.abs(last.scrollTop - want) <= 60,
  `scrollTop=${last.scrollTop} 目标=${want}（offsetTop=${last.targetOffset} / 最大=${maxScroll}） 视口命中=${last.atTop}`,
);
check('视口内已加载图片 > 0', last.loadedCount > 0, `loaded=${last.loadedCount} first=${last.firstLoadedIndex}`);
check('视口上 1/3 命中的是图（不是空占位 div）', last.atTop === '图', `命中=${last.atTop}`);
check('进度没被改回第 0 页', last.urlPage === String(PAGE), `url?page=${last.urlPage}`);
check('占位高度存在（前几页不会塌成 0）', (last.rows || []).filter((r) => r.h > 0).length >= 4, JSON.stringify((last.rows || []).slice(0, 6).map((r) => r.h)));

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) console.log('失败项：' + failed.map((f) => f.name).join(' / '));

// ---- 交互回归：滚轮翻页跟手 / 进度上报 / 切章定位 ----
console.log('\n== 交互 ==');
await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 210, y: 500, deltaX: 0, deltaY: 1400 });
await sleep(1400);
const s3 = await sample();
check('向下滚动后页码前进', !!s3.found && Number(s3.urlPage) > PAGE, `url?page=${s3?.urlPage}（原 ${PAGE}）`);
const progressAfter = (await api(`/api/comics/${comic}`)).data.progress;
check('滚动后进度上报到服务端', progressAfter && progressAfter.pageIndex > PAGE, `服务端 pageIndex=${progressAfter?.pageIndex}`);

await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 210, y: 500, deltaX: 0, deltaY: -1400 });
await sleep(1400);
const s4 = await sample();
check('向上滚动后页码回退', !!s4.found && Number(s4.urlPage) < Number(s3.urlPage), `url?page=${s4?.urlPage}（滚前 ${s3?.urlPage}）`);

// 切走再切回卷轴：位置应该仍停在当前页，而不是被重置回第一章。
// 放在切章之前跑：切章后当前页就是新章第 0 页，「保持位置」这件事就测不出来了。
console.log('\n== 模式往返 ==');
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 210, y: 500, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 210, y: 500, button: 'left', clickCount: 1 });
await sleep(350);
await ev(`document.querySelector('[aria-label="阅读设置"]')?.click()`);
await sleep(700);
const pickMode = (label) => ev(`(() => {
  const sheet = [...document.querySelectorAll('div.fixed.inset-0')].pop();
  const btn = [...(sheet?.querySelectorAll('button') || [])].find((b) => b.textContent.trim() === '${label}');
  if (!btn) return 'no-button';
  btn.click();
  return 'ok';
})()`);
check('切到单页', (await pickMode('单页')) === 'ok');
await sleep(900);
await ev(`(() => { const s = [...document.querySelectorAll('div.fixed.inset-0')].pop(); s?.querySelector('button[aria-label="关闭"]')?.click(); })()`);
await sleep(600);
await ev(`document.querySelector('[aria-label="阅读设置"]')?.click()`);
await sleep(700);
check('切回卷轴', (await pickMode('卷轴')) === 'ok');
await sleep(900);
await ev(`(() => { const s = [...document.querySelectorAll('div.fixed.inset-0')].pop(); s?.querySelector('button[aria-label="关闭"]')?.click(); })()`);
await sleep(2600);
const s6 = await sample();
const maxScroll6 = s6?.found ? s6.scrollH - s6.clientH : 0;
const want6 = s6?.targetOffset === null ? null : Math.min(s6.targetOffset, maxScroll6);
check(
  '切走再切回卷轴，位置仍停当前页',
  want6 !== null && Math.abs(s6.scrollTop - want6) <= 60 && s6.atTop === '图',
  `scrollTop=${s6?.scrollTop} 目标=${want6} url?page=${s6?.urlPage} 命中=${s6?.atTop}`,
);

// 切章：底部工具栏「下一章」→ 新章应从第 0 页开始（scrollTop 0）
if (detail.chapters.length > 1) {
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('下一章')); b?.click(); })()`);
  await sleep(2200);
  const s5 = await sample();
  check(
    '切章后定位到新章第 0 页',
    !!s5.found && s5.scrollTop <= 2 && s5.atTop === '图',
    `scrollTop=${s5?.scrollTop} 命中=${s5?.atTop}`,
  );
  const loc = await ev('location.pathname + "?page=" + new URLSearchParams(location.search).get("page")');
  check('切章后 URL 指向新章且 page=0', /\/read\/[^/]+\/[^/?]+\?page=0$/.test(loc || ''), loc);
} else {
  console.log('（只有一章，跳过切章）');
}

// 还原
await put({ theme: before.theme, accent: before.accent, readerMode: before.readerMode }).catch(() => {});
await api('/api/progress', {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    comicId: comic,
    chapterId: chapter.id,
    chapterIndex: 0,
    pageIndex: beforeProgress?.pageIndex ?? 0,
    pageCount: chapter.pageCount,
    percent: beforeProgress?.percent ?? 0,
  }),
}).catch(() => {});

ws.close();
edge.kill();
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {
  /* Windows 偶发占用 */
}
process.exit(failed.length ? 1 : 0);
