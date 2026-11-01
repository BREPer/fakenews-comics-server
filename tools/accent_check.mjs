/**
 * 高亮色探针：在浅/深两套主题下切三种高亮色（琥珀橙 / 空色 / 豆沙绿），核对
 *   [html data-accent] / localStorage / --brand-* 变量 / 主按钮实际渲染色 / 刷新后保持
 * 另外验证：
 *   - 深色下空色、豆沙绿的提亮覆盖生效（否则会和背景糊在一起）
 *   - 旧键迁移：服务端还留着 blue/gray/prussian 时，前端自动认成空色/豆沙绿
 *
 *   node tools/accent_check.mjs [--shots]
 */
import { spawn } from 'node:child_process';
import { injectPrefs } from './lib/prefs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 允许 `--key=value` 与 `--key value` 两种写法（历史上探针混用，写错会被静默忽略）
process.argv = process.argv.flatMap((a) => {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  return m ? [`--${m[1]}`, m[2]] : [a];
});
const ARG = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const FLAG = (n) => process.argv.includes(`--${n}`);
const BASE = (ARG('base', 'http://127.0.0.1:13800')).replace(/\/$/, '');
const api = async (p, i) => (await fetch(BASE + p, i)).json();

const before = (await api('/api/settings')).data;

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const PORT = 9596;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-accent-'));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
let wsUrl;
for (let i = 0; i < 80; i++) {
  try { const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = t.find((x) => x.type === 'page'); if (p) { wsUrl = p.webSocketDebuggerUrl; break; } } catch { /* 等 edge 起来 */ }
  await sleep(150);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0; const pend = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
const send = (m, p = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
fs.mkdirSync(path.resolve('_shots'), { recursive: true });

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.log(`  ✗ ${name}  → ${detail}`); }
};

const probe = () =>
  ev(`(() => {
    const root = document.documentElement;
    const cs = getComputedStyle(root);
    const btn = document.querySelector('.btn-primary');
    return {
      attr: root.getAttribute('data-accent'),
      dark: root.classList.contains('dark'),
      brand500: cs.getPropertyValue('--brand-500').trim(),
      brand600: cs.getPropertyValue('--brand-600').trim(),
      btnBg: btn ? getComputedStyle(btn).backgroundImage : '(no .btn-primary)',
      stored: localStorage.getItem('fakenews-accent'),
    };
  })()`);

/**
 * 期望值（浅色 / 深色分别算）。
 * 深色下空色、豆沙绿各提亮一档，见 index.css 的 :root.dark[data-accent=...]。
 */
const EXPECT = (accent, theme) => {
  const dark = theme === 'dark';
  if (accent === 'amber') return { attr: null, brand500: '249 115 22', btn: 'rgb(251, 146, 60)' };
  // 空色（そらいろ）：标准色 #A0D8EF 在 200 档，500/600 是同色相压深后的可用档
  if (accent === 'sora') {
    return dark
      ? { attr: 'sora', brand500: '74 166 204', btn: 'rgb(45, 134, 172)' }
      : { attr: 'sora', brand500: '38 126 170', btn: 'rgb(38, 126, 170)' };
  }
  // bean
  return dark
    ? { attr: 'bean', brand500: '120 198 139', btn: 'rgb(79, 169, 106)' }
    : { attr: 'bean', brand500: '79 169 106', btn: 'rgb(79, 169, 106)' };
};

/** 当前注入到浏览器的偏好（累积；每次注入完整快照，后加的脚本后执行） */
const injected = { theme: 'light', accent: 'amber' };

async function setTheme(theme) {
  injected.theme = theme;
  await injectPrefs(send, injected);
  await send('Page.navigate', { url: `${BASE}/settings` });
  await sleep(1800);
}

async function testAccent(accent, theme) {
  injected.accent = accent;
  await injectPrefs(send, injected);
  await send('Page.navigate', { url: `${BASE}/settings` });
  await sleep(1600);
  const p = await probe();
  const e = EXPECT(accent, theme);
  console.log(`\n--- accent=${accent} theme=${theme} ---`);
  console.log('   ', JSON.stringify({ attr: p.attr, brand500: p.brand500, btnBg: p.btnBg, stored: p.stored }));
  check('html data-accent 正确', (p.attr ?? null) === e.attr, `attr=${p.attr}`);
  check('--brand-500 已重映射', p.brand500 === e.brand500, `实际=${p.brand500}`);
  check('主按钮实际渲染色跟随', (p.btnBg ?? '').includes(e.btn), `btnBg=${p.btnBg}`);
  check('localStorage 已写入', p.stored === accent, `stored=${p.stored}`);

  await send('Page.reload');
  await sleep(1500);
  const r = await probe();
  check('刷新后保持', (r.attr ?? null) === e.attr && r.brand500 === e.brand500, `attr=${r.attr} brand500=${r.brand500}`);

  // 设置页的选中态：打勾的色板应与当前 accent 一致
  const selected = await ev(`(() => {
    const btns = [...document.querySelectorAll('button[aria-label^="高亮颜色"]')];
    const on = btns.find((b) => b.getAttribute('aria-pressed') === 'true');
    return on ? on.getAttribute('aria-label') : null;
  })()`);
  const wantLabel = { amber: '琥珀橙', sora: '空色', bean: '豆沙绿' }[accent];
  check(`设置页选中「${wantLabel}」`, (selected ?? '').includes(wantLabel), `selected=${selected}`);

  if (FLAG('shots')) {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.resolve('_shots', `accent-${accent}-${theme}.png`), Buffer.from(s.data, 'base64'));
  }
}

try {
  for (const theme of ['light', 'dark']) {
    await setTheme(theme);
    for (const accent of ['amber', 'sora', 'bean']) await testAccent(accent, theme);
  }

  // 深色 + 豆沙绿的提亮，以及环境光/阅读器继承
  await setTheme('dark');
  injected.accent = 'bean';
  await injectPrefs(send, injected);
  await send('Page.navigate', { url: `${BASE}/settings` });
  await sleep(1600);
  const g = await probe();
  console.log('\n--- 深色 + 豆沙绿提亮 ---');
  console.log('   ', JSON.stringify({ dark: g.dark, brand500: g.brand500, brand600: g.brand600, btnBg: g.btnBg }));
  check('深色下豆沙绿被提亮到 120 198 139', g.brand500 === '120 198 139', `brand500=${g.brand500}`);

  await send('Page.navigate', { url: `${BASE}/` });
  await sleep(1800);
  const home = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--brand-500').trim()`);
  check('首页继承同一高亮色', home === '120 198 139', `home=${home}`);

  const ambient = await ev(`getComputedStyle(document.body, '::before').backgroundImage`);
  check('环境光跟随高亮色', (ambient ?? '').includes('120, 198, 139'), `ambient=${ambient}`);

  const comics = (await api('/api/comics?pageSize=20')).data.items;
  const c0 = comics.find((c) => !/perf/i.test(c.title)) ?? comics[0];
  const detail = (await api(`/api/comics/${c0.id}`)).data;
  const ch0 = (detail.chapters ?? [])[0];
  if (ch0) {
    await send('Page.navigate', { url: `${BASE}/read/${c0.id}/${encodeURIComponent(ch0.id)}?page=0` });
    await sleep(2400);
    const rd = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--brand-500').trim()`);
    check('阅读器继承同一高亮色', rd === '120 198 139', `reader=${rd}`);
    const s2 = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.resolve('_shots', 'accent-bean-dark-reader.png'), Buffer.from(s2.data, 'base64'));
  }

  // 旧键迁移：服务端仍是 blue / gray / orange 时，前端要认成新名字
  console.log('\n--- 旧键迁移（gray → 豆沙绿 / blue、prussian → 空色 / orange → 琥珀橙） ---');
  for (const [legacy, want, wantAttr] of [['gray', '豆沙绿', 'bean'], ['blue', '空色', 'sora'], ['prussian', '空色', 'sora'], ['orange', '琥珀橙', null]]) {
    injected.accent = legacy; // 旧值原样写进 localStorage，验证前端归一化
    await injectPrefs(send, injected);
    await send('Page.navigate', { url: `${BASE}/settings` });
    await sleep(1500);
    const a = await ev(`document.documentElement.getAttribute('data-accent')`);
    const sel = await ev(`(() => {
      const b = [...document.querySelectorAll('button[aria-label^="高亮颜色"]')].find((x) => x.getAttribute('aria-pressed') === 'true');
      return b ? b.getAttribute('aria-label') : null;
    })()`);
    check(`旧值 ${legacy} → ${want}`, (a ?? null) === wantAttr && (sel ?? '').includes(want), `attr=${a} selected=${sel}`);
  }
} finally {
  // 偏好只在本机（临时 profile），无需还原服务端
  ws.close();
  edge.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
