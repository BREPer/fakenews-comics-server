/**
 * 预加载档位（关/1/3/5/8）行为校验。
 *
 * 演进史：滑块（误触）→ 步进器（意图分离，但 20px 大数字是全页唯一数字控件，
 * 用户反馈「碍眼」）→ 档位 Segmented（2026-10-25，与适应方式/翻页动画同款）。
 * 0-8 的中间值由 devicePrefs 吸附到最近档（平局取更小），吸附后写回存储。
 *
 * 校验项：
 *   1) 设置页 5 个档位段、顺序 关/1/3/5/8，选中段与本机值一致
 *   2) 点档位直接生效（写 fn:preloadCount）
 *   3) 存量中间值吸附写回（存 2 → 显示并存储 1；存 7 → 8）
 *   4) 420px 窄屏 5 段单行不换行
 *   5) 阅读设置弹层同款档位也能改
 *
 * 用法：node tools/preload_check.mjs [--base=http://127.0.0.1:5173]
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
const APP = ARG('base', 'http://127.0.0.1:5173').replace(/\/$/, '');
const API = ARG('api', 'http://127.0.0.1:13800').replace(/\/$/, '');

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const PORT = 9685;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-step-'));
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

const results = [];
const check = (name, ok, info) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info === undefined ? '' : `  ${typeof info === 'string' ? info : JSON.stringify(info)}`}`);
};
/**
 * 读「已持久化的预加载档位」。阅读偏好按设备存（localStorage），键 fn:preloadCount。
 * 吸附会在 load 时写回，所以这里的值应始终等于 UI 显示的档位。
 */
const localPreload = async () => {
  const v = await ev(`localStorage.getItem('fn:preloadCount')`);
  return v === null ? 3 : Number(v); // 未写过 = 默认 3
};
const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};
/** 读设置页预加载行的档位段：标签序列 + 选中段 */
const readRow = (scope = 'document') => ev(`(() => {
  const row = [...${scope}.querySelectorAll('div')].find((d) =>
    d.querySelector('p')?.textContent === '预加载页数' && d.querySelectorAll('button[aria-pressed]').length >= 5);
  if (!row) return null;
  const btns = [...row.querySelectorAll('button[aria-pressed]')];
  const rects = btns.map((b) => b.getBoundingClientRect());
  return {
    labels: btns.map((b) => b.textContent.trim()),
    active: btns.findIndex((b) => b.getAttribute('aria-pressed') === 'true'),
    heights: rects.map((r) => Math.round(r.height)),
    singleLine: new Set(rects.map((r) => Math.round(r.top))).size === 1,
  };
})()`);
/** 点设置页预加载行里指定标签的档位 */
const tapStep = async (label) => {
  const hit = await ev(`(() => {
    const row = [...document.querySelectorAll('div')].find((d) =>
      d.querySelector('p')?.textContent === '预加载页数' && d.querySelectorAll('button[aria-pressed]').length >= 5);
    const b = [...(row?.querySelectorAll('button[aria-pressed]') ?? [])].find((x) => x.textContent.trim() === '${label}');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
  })()`);
  if (hit) await clickAt(hit.cx, hit.cy);
  return !!hit;
};

await send('Page.navigate', { url: `${APP}/settings` });
await sleep(2400);

// ① 结构：5 段、顺序、选中与本机值一致
const row = await readRow();
check('预加载行有 5 个档位段（关/1/3/5/8）',
  !!row && row.labels.join(',') === '关,1,3,5,8', row?.labels);
check('选中段与本机值一致', !!row && row.active >= 0 &&
  Number(row.labels[row.active] === '关' ? 0 : row.labels[row.active]) === (await localPreload()),
  `选中=${row?.labels?.[row.active]} 本机=${await localPreload()}`);

// ② 点档位直接生效
await tapStep('5');
await sleep(600);
check('点「5」写入本机', (await localPreload()) === 5, String(await localPreload()));
await tapStep('关');
await sleep(600);
check('点「关」= 0', (await localPreload()) === 0, String(await localPreload()));
await tapStep('8');
await sleep(600);
check('点「8」写入本机', (await localPreload()) === 8, String(await localPreload()));

// ③ 存量中间值吸附写回
await ev(`localStorage.setItem('fn:preloadCount','2')`);
await send('Page.reload');
await sleep(2200);
const snap2 = await readRow();
check('存量 2 吸附到 1（平局取更小）并写回存储',
  Number(snap2?.labels?.[snap2.active]) === 1 && (await localPreload()) === 1,
  `显示=${snap2?.labels?.[snap2.active]} 存储=${await localPreload()}`);
await ev(`localStorage.setItem('fn:preloadCount','7')`);
await send('Page.reload');
await sleep(2200);
const snap7 = await readRow();
check('存量 7 吸附到 8', Number(snap7?.labels?.[snap7.active]) === 8 && (await localPreload()) === 8,
  `显示=${snap7?.labels?.[snap7.active]} 存储=${await localPreload()}`);

// ④ 窄屏单行
check('420px 下 5 段单行不换行', !!snap7 && snap7.singleLine && new Set(snap7.heights).size === 1,
  `tops 唯一=${snap7?.singleLine} heights=${snap7?.heights}`);

// ⑤ 阅读设置弹层同款
await ev(`localStorage.setItem('fn:preloadCount','3'); localStorage.setItem('fn:readerMode','single')`);
// 选一本真的有章节的：夹具重新生成后 limit 参数无效，items[0] 可能没有章
let comic = null, detail = null;
for (const c of (await (await fetch(`${API}/api/comics?pageSize=8`)).json()).data.items) {
  const d = (await (await fetch(`${API}/api/comics/${c.id}`)).json()).data;
  if (d.chapters && d.chapters.length) { comic = c.id; detail = d; break; }
}
if (!comic) { console.log('没有可用章节，跳过弹层检查'); process.exit(0); }
await send('Page.navigate', { url: `${APP}/read/${encodeURIComponent(comic)}/${encodeURIComponent(detail.chapters[0].id)}` });
await sleep(2600);
await clickAt(210, 500); // 唤出工具栏
await sleep(400);
await ev(`document.querySelector('[aria-label="阅读设置"]')?.click()`);
await sleep(800);
const sheetRow = await ev(`(() => {
  const sheets = [...document.querySelectorAll('div.fixed.inset-0')];
  const sheet = sheets[sheets.length - 1];
  const btns = [...(sheet?.querySelectorAll('button[aria-pressed]') ?? [])].filter((b) => ['关','1','3','5','8'].includes(b.textContent.trim()));
  if (btns.length < 5) return null;
  const five = btns.find((b) => b.textContent.trim() === '5');
  const r = five.getBoundingClientRect();
  return { found: true, cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
})()`);
check('阅读设置弹层有同款 5 档', sheetRow?.found === true, sheetRow);
if (sheetRow?.found) {
  await clickAt(sheetRow.cx, sheetRow.cy);
  await sleep(800);
  check('弹层里点「5」也生效', (await localPreload()) === 5, String(await localPreload()));
}

// 还原默认
await ev(`localStorage.setItem('fn:preloadCount','3')`);

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) console.log('失败项：' + failed.map((f) => f.name).join(' / '));
ws.close();
edge.kill();
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {
  /* Windows 偶发占用 */
}
process.exit(failed.length ? 1 : 0);
