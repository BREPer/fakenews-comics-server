/**
 * 漫画「分类/标签」编辑探针（Edge headless + CDP，真点按钮）。
 *
 * 覆盖：详情页编辑面板里删除已有分类 → 新增分类 → 保存 → 详情页与首页筛选 chips 同步。
 * 用法：node tools/edit_probe.mjs [baseUrl]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:13801';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CDP_PORT = 9335;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-edit-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const t = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
};

async function waitCdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((x) => x.type === 'page');
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
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
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

const json = async (p) => (await fetch(BASE + p)).json();
const NEW_TAG = '测试分类X';

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', `--user-data-dir=${profile}`,
  `--remote-debugging-port=${CDP_PORT}`, 'about:blank',
], { stdio: 'ignore' });

try {
  const c = client(await waitCdp());
  await c.ready;
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1100, deviceScaleFactor: 1, mobile: false });

  // 选一部标签里含「库名」的漫画（正是噪音来源），先确保有可删的分类
  const comics = (await json('/api/comics?pageSize=50')).data.items;
  const comic = comics.find((x) => (x.tags ?? []).length >= 2) ?? comics[0];
  const originalTags = [...(comic.tags ?? [])];
  console.log(`测试漫画: ${comic.title}  原分类: ${JSON.stringify(originalTags)}`);
  const apiTags = async () => (await json(`/api/comics/${encodeURIComponent(comic.id)}`)).data.tags ?? [];

  const goto = async (url, readyExpr) => {
    await c.send('Page.navigate', { url: BASE + url });
    for (let i = 0; i < 100; i++) {
      if (await c.evaluate(readyExpr)) break;
      await sleep(150);
    }
    await sleep(600);
  };
  const clickByText = (text) => c.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === ${JSON.stringify(text)});
    if (!b) return false; b.click(); return true;
  })()`);

  await goto(`/comic/${comic.id}`, `document.body.innerText.includes('编辑信息')`);

  // ---- 打开编辑面板 ----
  t('点击「编辑信息」', await clickByText('编辑信息'));
  await sleep(500);
  const chipCount = () => c.evaluate(`document.querySelectorAll('button[title^="删除分类"]').length`);
  t('面板里列出原有分类', (await chipCount()) === originalTags.length, `chips=${await chipCount()} 原有=${originalTags.length}`);

  // ---- 删除第一个分类 ----
  const removed = originalTags[0];
  await c.evaluate(`(() => {
    const b = document.querySelector('button[title^="删除分类"]');
    if (b) b.click();
  })()`);
  await sleep(300);
  t('点 × 删掉一个分类', (await chipCount()) === originalTags.length - 1, `剩 ${await chipCount()}`);

  // ---- 输入并添加新分类（React 受控输入需用原生 setter 触发 onChange） ----
  const typed = await c.evaluate(`(() => {
    const el = [...document.querySelectorAll('input')].find(i => (i.placeholder || '').includes('输入分类'));
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(NEW_TAG)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  t('找到分类输入框并输入', typed);
  await sleep(200);
  t('点「添加」', await clickByText('添加'));
  await sleep(300);
  const hasNew = await c.evaluate(`[...document.querySelectorAll('button[title^="删除分类"]')].some(b => b.title.includes(${JSON.stringify(NEW_TAG)}))`);
  t('新分类出现在面板里', hasNew);
  t('已删除的分类不在面板里', !(await c.evaluate(`[...document.querySelectorAll('button[title^="删除分类"]')].some(b => b.title.includes(${JSON.stringify(removed)}))`)));

  // ---- 保存 ----
  t('点「保存」', await clickByText('保存'));
  await sleep(1200);
  const nowTags = await apiTags();
  const expect = [...originalTags.slice(1), NEW_TAG];
  t('接口标签 = 原有(减一个) + 新增', JSON.stringify(nowTags) === JSON.stringify(expect),
    `got=${JSON.stringify(nowTags)} want=${JSON.stringify(expect)}`);

  // ---- 详情页头部展示同步 ----
  const headShows = await c.evaluate(`(() => {
    const txt = document.body.innerText;
    return txt.includes(${JSON.stringify(NEW_TAG)});
  })()`);
  t('详情页头部显示新分类', headShows === true);
  t('详情页不再显示被删分类', !(await c.evaluate(`document.body.innerText.includes(${JSON.stringify(removed)})`)));

  // ---- 首页筛选 chips 同步 ----
  await goto('/', `document.body.innerText.includes('全部漫画')`);
  const facetChips = await c.evaluate(`[...document.querySelectorAll('button')].map(b => (b.textContent || '').trim())`);
  t('首页筛选栏出现新分类', facetChips.some((x) => x.startsWith(NEW_TAG)), facetChips.filter((x) => x.includes('分类')).join('|'));
  // 库名是扫描自动写进 tags 的。2.0.2（634cc8a「首页标签栏恢复库名标签」）起**有意保留**：
  // 首页没有别的库筛选入口，滤掉就再也点不到。所以断言方向是「必须出现」——
  // 原来那条「不出现库名」从 634cc8a 起就过期了，别照着它改产品。
  const libNames = (await json('/api/libraries')).data.items.map((l) => l.name);
  const libChips = facetChips.filter((x) => libNames.some((n) => x.startsWith(n)));
  t('首页标签栏出现库名（首页唯一的库筛选入口）', libChips.length > 0,
    libChips.join('|') || `chip 里没有，库名=${libNames.join(',') || '（无库）'}`);

  // ---- 还原 ----
  await fetch(`${BASE}/api/comics/${encodeURIComponent(comic.id)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tags: originalTags }),
  });
  const restored = await apiTags();
  t('已还原原始分类', JSON.stringify(restored) === JSON.stringify(originalTags), JSON.stringify(restored));

  c.close();
} catch (err) {
  fail++;
  console.error('\n异常:', err);
} finally {
  edge.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n总计 ${pass + fail}  通过 ${pass}  失败 ${fail}`);
process.exit(fail ? 1 : 0);
