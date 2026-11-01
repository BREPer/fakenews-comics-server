/**
 * 动效打磨校验（2026-10-25 那一批「把做了一半的补齐」）。
 *
 * 校验项：
 *   1) Segmented 滑动指示器：存在、几何与选中按钮对齐（±1px）、能跟随切换移动、
 *      pointer-events:none 不挡点击、选中背景确实从按钮自身移到了指示器那一层
 *   2) Toggle 滑块：过渡的是 transform（不是 left / all），开关两个状态的位移不同
 *   3) 主题 / 高亮色切换：<html> 临时挂上 theme-transition，约 220ms 后摘掉
 *   4) 「减少动态效果」下 theme-transition 规则必须失效（整块包在 no-preference 里）
 *
 * 用法：node tools/motion_check.mjs [--base=http://127.0.0.1:5173]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));
const PORT = 9686;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-motion-'));
const edge = spawn(
  EDGE,
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1280,900', 'about:blank'],
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
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

const results = [];
const check = (name, ok, info) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info === undefined ? '' : `  ${typeof info === 'string' ? info : JSON.stringify(info)}`}`);
};

/** 取第一个分段选择器的「选中按钮 / 容器 / 指示器」几何关系 */
const segInfo = () => ev(`(() => {
  const btn = document.querySelector('button[aria-pressed="true"]');
  if (!btn) return null;
  const wrap = btn.parentElement;
  const ind = wrap.querySelector(':scope > span[aria-hidden="true"]');
  const wb = wrap.getBoundingClientRect();
  const bb = btn.getBoundingClientRect();
  const ib = ind ? ind.getBoundingClientRect() : null;
  const cs = ind ? getComputedStyle(ind) : null;
  return {
    label: btn.textContent.trim(),
    pressed: btn.getAttribute('aria-pressed'),
    btnHasBrandBg: /bg-brand-600/.test(btn.className),
    btnLeft: +(bb.left - wb.left).toFixed(1),
    btnWidth: +bb.width.toFixed(1),
    indLeft: ib ? +(ib.left - wb.left).toFixed(1) : null,
    indWidth: ib ? +ib.width.toFixed(1) : null,
    indTransition: cs ? cs.transitionProperty : null,
    indPointer: cs ? cs.pointerEvents : null,
  };
})()`);

/** 按文字点击某个分段选项 */
const clickSeg = (label) => ev(`(() => {
  const b = [...document.querySelectorAll('button[aria-pressed]')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
  if (!b) return false;
  b.click();
  return true;
})()`);

await send('Page.navigate', { url: `${APP}/settings` });
await sleep(1600);

console.log('--- Segmented 滑动指示器 ---');
const s1 = await segInfo();
check('选中按钮能定位到', !!s1, s1 ? s1.label : null);
check('指示器已渲染', !!s1 && s1.indLeft !== null);
check('指示器左边缘与选中按钮对齐（±1px）', !!s1 && Math.abs((s1.indLeft ?? -99) - s1.btnLeft) <= 1, s1 ? { ind: s1.indLeft, btn: s1.btnLeft } : null);
check('指示器宽度与选中按钮一致（±1px）', !!s1 && Math.abs((s1.indWidth ?? -99) - s1.btnWidth) <= 1, s1 ? { ind: s1.indWidth, btn: s1.btnWidth } : null);
// 刻意只过渡 transform：width 逐帧参与布局，会把整条 chip 行拖进逐帧重排。
// 这里连「不许有 width」一起锁住，避免以后有人"补全"回去。
check('指示器只过渡 transform（不含 width，避免逐帧重排）',
  !!s1 && /transform/.test(s1.indTransition || '') && !/width/.test(s1.indTransition || ''), s1?.indTransition);
check('指示器不挡点击（pointer-events:none）', s1?.indPointer === 'none', s1?.indPointer);
check('选中背景已从按钮自身移到指示器', s1?.btnHasBrandBg === false, { btnHasBrandBg: s1?.btnHasBrandBg });

// 切到另一个选项：指示器应滑过去（位置改变），且仍然与新选中按钮对齐
const labels = await ev(`[...document.querySelectorAll('button[aria-pressed]')].map((b) => b.textContent.trim())`);
const other = (labels || []).find((l) => l !== s1?.label);
if (other) {
  await clickSeg(other);
  await sleep(400);
  const s2 = await segInfo();
  check('切换选项后指示器跟着移动', !!s2 && s2.label === other && Math.abs(s2.indLeft - s1.indLeft) > 0.5, { from: s1?.indLeft, to: s2?.indLeft });
  check('切换后仍与新选中按钮对齐（±1px）', !!s2 && Math.abs(s2.indLeft - s2.btnLeft) <= 1 && Math.abs(s2.indWidth - s2.btnWidth) <= 1, { ind: s2?.indLeft, btn: s2?.btnLeft });
}

console.log('\n--- Toggle 滑块 ---');
const readToggle = () => ev(`(() => {
  const t = document.querySelector('button[role="switch"]');
  if (!t) return null;
  const k = t.querySelector('span');
  const cs = getComputedStyle(k);
  const m = /matrix\\(([^)]+)\\)/.exec(cs.transform);
  const tx = m ? +m[1].split(',')[4] : null;
  return { checked: t.getAttribute('aria-checked'), tx, transitionProperty: cs.transitionProperty, duration: cs.transitionDuration };
})()`);
const t1 = await readToggle();
check('找到开关', !!t1, t1 ? `aria-checked=${t1.checked}` : null);
check('只过渡 transform（不再过渡 left / all）', t1?.transitionProperty === 'transform', t1?.transitionProperty);
await ev(`(() => { const t = document.querySelector('button[role="switch"]'); if (t) t.click(); return 1; })()`);
await sleep(350);
const t2 = await readToggle();
check('开关状态翻转', t1 && t2 && t1.checked !== t2.checked, { before: t1?.checked, after: t2?.checked });
check('滑块位移随状态改变（0 ↔ 20px）', t1 && t2 && t1.tx !== t2.tx && [t1.tx, t2.tx].every((v) => v === 0 || Math.abs(v - 20) < 0.6), { before: t1?.tx, after: t2?.tx });

console.log('\n--- 主题切换的全局过渡 ---');
await ev(`(() => { const b=[...document.querySelectorAll('button')].find((x)=>x.textContent.trim()==='深色'); if(b) b.click(); return 1; })()`);
const hasCls = await ev(`document.documentElement.classList.contains('theme-transition')`);
check('切换瞬间挂上 theme-transition', hasCls === true);
await sleep(450);
const stillHas = await ev(`document.documentElement.classList.contains('theme-transition')`);
check('约 220ms 后自动摘掉（不常驻）', stillHas === false);

// 「减少动态效果」下这条规则必须整体失效，否则会盖掉系统级的 reduce
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
const rmDur = await ev(`(() => {
  const r = document.documentElement;
  r.classList.add('theme-transition');
  const b = document.querySelector('.btn-primary') || document.querySelector('button');
  const d = getComputedStyle(b).transitionDuration;
  r.classList.remove('theme-transition');
  return d;
})()`);
check('减少动态效果下 theme-transition 失效（不是 0.2s）', typeof rmDur === 'string' && !/^0\.2s/.test(rmDur), rmDur);
await send('Emulation.setEmulatedMedia', { features: [] });

edge.kill();
const pass = results.filter((r) => r.ok).length;
console.log(`\n结果：${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
