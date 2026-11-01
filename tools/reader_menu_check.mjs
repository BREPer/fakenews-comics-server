/**
 * 阅读器右上角两个菜单（章节目录 / 阅读设置）可用性检查。
 *
 * 背景：Sheet 改成 createPortal 挂到 body 后，阅读器根节点是 fixed z-[100]，
 * 而弹层是 z-50 —— 同处根层叠上下文时数字大的压在上面，弹层虽然渲染了却完全被
 * 阅读器盖住，用户感知就是「点了没反应」。
 *
 * 校验项：
 *  1) 点按钮后 body 下确实新增了 portal 节点；
 *  2) 弹层面板可命中（elementFromPoint 命中面板内部）；
 *  3) 面板 z-index 高于阅读器根节点；
 *  4) 面板在视口内可见（面积 > 0 且不被完全遮挡）；
 *  5) 关闭按钮可点，点击后面板消失；
 *  6) 设置面板里的控件可交互（滑块拖动生效）。
 *
 * 用法：node tools/reader_menu_check.mjs [--base=http://127.0.0.1:5173] [--comic=id]
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
let comic = ARG('comic', '');
const tag = ARG('tag', 'menu');
// 探针会点开阅读设置、改预加载等，跑完必须还原，否则测试设置留在开发实例里
const settingsBefore = await (await fetch(`${API}/api/settings`)).json().then((r) => r.data).catch(() => null);
const restoreSettings = async () => {
  if (!settingsBefore) return;
  await fetch(`${API}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      readerMode: settingsBefore.readerMode,
      readDir: settingsBefore.readDir,
      fitMode: settingsBefore.fitMode,
      quality: settingsBefore.quality,
      preloadCount: settingsBefore.preloadCount,
      pageAnimation: settingsBefore.pageAnimation,
      pinchZoom: settingsBefore.pinchZoom,
      keepScreenOn: settingsBefore.keepScreenOn,
      theme: settingsBefore.theme,
      accent: settingsBefore.accent,
    }),
  }).catch(() => {});
};

// /api/comics 只认 pageSize（routes/comics.go:93）；limit 是 /api/favorites 的参数，
// 写成 ?limit=1 会被静默忽略 —— 拿到的是默认 60 条里的第一条，不是"第一部"。
// 而且第一条可能是空目录/无章节的条目，直接 chapters[0] 会崩退（看着像秒过）。
if (!comic) {
  const items = (await (await fetch(`${API}/api/comics?pageSize=50`)).json())?.data?.items ?? [];
  for (const c of items) {
    const d = (await (await fetch(`${API}/api/comics/${encodeURIComponent(c.id)}`)).json())?.data;
    if (d?.chapters?.length && (d.chapters[0].pageCount ?? 0) > 0) { comic = c.id; break; }
  }
}
if (!comic) {
  console.error(`SKIP: 没有「有章节且有页」的漫画（API=${API}）`);
  console.error('  先跑一次扫描，或用 --comic=<id> 指定；夹具库目录里要有真图');
  process.exit(2);
}
const detail = (await (await fetch(`${API}/api/comics/${encodeURIComponent(comic)}`)).json())?.data;
const chapter = detail?.chapters?.[0];
if (!chapter) {
  console.error(`SKIP: 漫画 ${comic} 没有章节`);
  process.exit(2);
}
const url = `${APP}/read/${encodeURIComponent(comic)}/${encodeURIComponent(chapter.id)}?page=1`;
console.log('comic =', comic, '| chapter =', chapter.id, '| pages =', chapter.pageCount);

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) {
  console.error('未找到 Edge');
  process.exit(1);
}
const PORT = 9641;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-menu-'));
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
    /* 等 CDP 起来 */
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
  if (r?.exceptionDetails) {
    console.error('[evaluate 异常]', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
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

await send('Page.navigate', { url });
await sleep(2800);

/** 描述某点命中的元素链（前 4 层），用于定位「弹层被谁盖住」 */
const hitChain = (x, y) => `(() => {
  const el = document.elementFromPoint(${x}, ${y});
  if (!el) return { hit: null };
  const chain = [];
  let n = el;
  for (let i = 0; i < 4 && n; i++) { chain.push(n.tagName.toLowerCase() + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/).slice(0, 3).join('.') : '')); n = n.parentElement; }
  return { hit: chain, text: (el.textContent || '').trim().slice(0, 24) };
})()`;

async function probeMenu({ buttonLabel, panelSelector, panelName, closeVia }) {
  console.log(`\n== ${panelName} ==`);
  const before = await ev(`document.querySelectorAll('body > div.fixed.inset-0').length`);
  const clicked = await ev(`(() => { const b = document.querySelector('[aria-label="${buttonLabel}"]'); if (!b) return 'no-button'; b.click(); return 'ok'; })()`);
  check(`${panelName}：按钮存在且可点`, clicked === 'ok', clicked);
  await sleep(650);

  const info = await ev(`(() => {
    const panels = [...document.querySelectorAll('${panelSelector}')];
    const panel = panels[panels.length - 1];
    if (!panel) return { found: false };
    const overlay = panel.closest('body > div');
    const r = panel.getBoundingClientRect();
    const cs = getComputedStyle(overlay || panel);
    const csPanel = getComputedStyle(panel);
    // 面板背景不透明度（用户要求 90% 左右）：从 rgba() 的 alpha 通道读
    // 注意：这段代码在 ev 的模板字符串里，正则必须写双反斜杠（\\d/\\s）——
    // 单层会被 JS 字符串转义吞掉，\d 变字面 d，匹配永远失败（曾误报 alpha=1）
    const panelAlpha = (() => { const m = csPanel.backgroundColor.match(/rgba\\([^)]*,\\s*([\\d.]+)\\)/); return m ? Number(m[1]) : 1; })();
    // 面板自身的 backdrop-filter（毛玻璃）：不能只靠遮罩的 blur，面板边界处要自己糊
    const panelBlur = csPanel.backdropFilter || csPanel.webkitBackdropFilter || 'none';
    // 阅读器根节点：阅读器里唯一的 fixed z-100 大层
    const reader = [...document.querySelectorAll('div')].find((d) => getComputedStyle(d).position === 'fixed' && Number(getComputedStyle(d).zIndex) >= 100 && d.getBoundingClientRect().height > 400);
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + Math.min(r.height / 2, 120));
    const topEl = document.elementFromPoint(cx, cy);
    return {
      found: true,
      inBody: overlay ? overlay.parentElement === document.body : false,
      overlayZ: cs.zIndex,
      panelZ: csPanel.zIndex,
      panelAlpha,
      panelBlur,
      readerZ: reader ? getComputedStyle(reader).zIndex : null,
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      point: { cx, cy },
      inside: !!(topEl && (panel === topEl || panel.contains(topEl))),
      topTag: topEl ? topEl.tagName.toLowerCase() + '.' + String(topEl.className || '').trim().split(/\\s+/).slice(0, 2).join('.') : null,
      topIsReader: !!(reader && topEl && reader.contains(topEl)),
    };
  })()`);
  if (!info.found) {
    check(`${panelName}：面板已渲染`, false, 'DOM 里没有面板');
    return;
  }
  check(`${panelName}：portal 挂到 body`, info.inBody === true, `overlayZ=${info.overlayZ}`);
  check(`${panelName}：面板在视口内`, info.rect.w > 0 && info.rect.h > 0, info.rect);
  check(`${panelName}：面板背景 ~75% 不透明（白色磨砂）`, info.panelAlpha >= 0.7 && info.panelAlpha <= 0.8, `alpha=${info.panelAlpha}`);
  check(
    `${panelName}：面板磨砂（blur 24px + saturate 150%）`,
    /blur\(24px\)/.test(info.panelBlur || '') && /saturate\(1\.5\)|saturate\(150%\)/.test(info.panelBlur || ''),
    `backdropFilter=${info.panelBlur}`,
  );
  check(
    `${panelName}：面板在阅读器之上（z 比较）`,
    info.readerZ === null || Number(info.overlayZ || info.panelZ) > Number(info.readerZ),
    `overlay=${info.overlayZ} reader=${info.readerZ}`,
  );
  check(
    `${panelName}：中心点命中面板内部`,
    info.inside === true,
    info.inside ? info.point : { point: info.point, hit: info.topTag, 被阅读器盖住: info.topIsReader },
  );

  if (closeVia) {
    // 「关闭」已经改成 X 图标（ui/index.tsx:249 起只有 aria-label/title，没有文字），
    // 原来按 textContent === '关闭' 找，找不到就 btn?.click() 静默空点 —— 面板当然还在，
    // 却报成「关闭后还剩 1」，看着像产品没卸载。两种都认，并**显式断言按钮找到了**。
    const clickedClose = await ev(`(() => {
      const b = [...document.querySelectorAll('${panelSelector}')].pop();
      if (!b) return 'no-panel';
      const btn = [...b.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '关闭' || x.textContent.trim() === '关闭');
      if (!btn) return 'no-close-button';
      btn.click(); return 'ok';
    })()`);
    check(`${panelName}：关闭按钮存在且可点`, clickedClose === 'ok', clickedClose);
    // 退场动画先播完再卸载（ReaderPrompt.tsx:65 同款约定），别只采一次就判死
    let after = -1;
    for (let i = 0; i < 12; i++) {
      after = await ev(`document.querySelectorAll('${panelSelector}').length`);
      if (after === 0) break;
      await sleep(150);
    }
    check(`${panelName}：关闭后消失`, after === 0, `剩余 ${after}`);
  }
}

await probeMenu({ buttonLabel: '章节目录', panelSelector: 'div.rounded-t-3xl', panelName: '章节菜单', closeVia: true });
await probeMenu({ buttonLabel: '阅读设置', panelSelector: 'div.rounded-t-3xl', panelName: '阅读设置', closeVia: true });

// 阅读设置弹层里的预加载档位：可见、可点、点了本机值就变（顺带回归
// 「组件体内定义控件导致子树 remount」那一类问题——段节点前后是同一个）
await ev(`document.querySelector('[aria-label="阅读设置"]')?.click()`);
await sleep(650);
const stepOk = await ev(`(async () => {
  const btns = () => [...([...document.querySelectorAll('div.fixed.inset-0')].pop()?.querySelectorAll('button[aria-pressed]') ?? [])]
    .filter((b) => ['关', '1', '3', '5', '8'].includes(b.textContent.trim()));
  if (btns().length < 5) return { found: false };
  const seg = btns().find((b) => b.textContent.trim() === '5');
  seg.click();
  await new Promise((r) => setTimeout(r, 400));
  const seg2 = btns().find((b) => b.textContent.trim() === '5');
  return {
    found: true,
    afterPressed: seg2?.getAttribute('aria-pressed'),
    stored: localStorage.getItem('fn:preloadCount'),
    sameBtn: seg2 === seg,
  };
})()`);
check(
  '阅读设置：预加载档位可点且不因重挂载丢节点',
  stepOk.found && stepOk.sameBtn === true && stepOk.afterPressed === 'true' && stepOk.stored === '5',
  stepOk,
);

fs.mkdirSync(path.resolve('_shots'), { recursive: true });
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.resolve('_shots', `reader-menu-${tag}.png`), Buffer.from(shot.data, 'base64'));

// 还原被探针动过的设置（阅读设置弹层里改过预加载等）
await restoreSettings();

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) console.log('失败项：' + failed.map((f) => f.name).join(' / '));
ws.close();
edge.kill();
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {
  /* Windows 上偶尔占用 */
}
process.exit(failed.length ? 1 : 0);
