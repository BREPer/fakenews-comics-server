/**
 * 收藏/取消收藏真实浏览器探针（Edge headless + CDP）。
 *
 * 为什么需要它：这条链路连续两次出问题（① 详情页 query 未失效导致按钮卡住；
 * ② 浏览器给 DELETE 带 content-type + Content-Length: 0，Fastify 直接 400），
 * 而纯 API 测试都测不出来——它必须经过「页面点击」才能覆盖。
 *
 * 用法：node tools/fav_probe.mjs [baseUrl]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:13801';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CDP_PORT = 9334;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-fav-'));
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
  await c.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1000, deviceScaleFactor: 1, mobile: false });

  const comics = (await json('/api/comics?pageSize=50')).data.items;
  const comic = comics[0];
  const detailUrl = `/comic/${comic.id}`;
  console.log(`测试漫画: ${comic.title}`);

  // 先确保是「未收藏」状态
  await fetch(`${BASE}/api/favorites/${encodeURIComponent(comic.id)}`, { method: 'DELETE' });

  const open = async () => {
    await c.send('Page.navigate', { url: BASE + detailUrl });
    for (let i = 0; i < 80; i++) {
      const ok = await c.evaluate(`!!document.querySelector('button') && document.body.innerText.includes('${comic.title.slice(0, 4)}')`);
      if (ok) break;
      await sleep(150);
    }
    await sleep(500);
  };
  /** 收藏按钮：文本含「收藏」（已收藏 / 收藏） */
  const btnLabel = () => c.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /已?收藏/.test(x.textContent || ''));
    return b ? b.textContent.trim() : null;
  })()`);
  const clickFav = () => c.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /已?收藏/.test(x.textContent || ''));
    if (!b) return false; b.click(); return true;
  })()`);
  const apiState = async () => {
    const d = (await json(`/api/comics/${encodeURIComponent(comic.id)}`)).data;
    const favs = (await json('/api/favorites')).data.items ?? [];
    return { isFavorite: d.isFavorite, inList: favs.some((x) => x.id === comic.id), label: await btnLabel() };
  };

  await open();
  let s = await apiState();
  t('初始为未收藏', s.isFavorite === false && s.inList === false && s.label === '收藏', JSON.stringify(s));

  // ---- 收藏 ----
  t('找到并点击收藏按钮', await clickFav());
  await sleep(1200);
  s = await apiState();
  t('收藏后接口 isFavorite=true 且在收藏列表', s.isFavorite === true && s.inList === true, JSON.stringify(s));
  t('收藏后按钮显示「已收藏」', s.label === '已收藏', `label=${s.label}`);

  // ---- 取消收藏（本轮重点） ----
  t('再次点击按钮（取消收藏）', await clickFav());
  await sleep(1200);
  s = await apiState();
  t('取消后接口 isFavorite=false', s.isFavorite === false, JSON.stringify(s));
  t('取消后从收藏列表移除', s.inList === false, `inList=${s.inList}`);
  t('取消后按钮恢复「收藏」', s.label === '收藏', `label=${s.label}`);

  // ---- 连续两次往返（防「只第一次有效」） ----
  await clickFav(); await sleep(900);
  await clickFav(); await sleep(900);
  s = await apiState();
  t('连续 收藏→取消 后状态自洽', s.isFavorite === false && s.inList === false && s.label === '收藏', JSON.stringify(s));

  // ---- 刷新页面后状态仍一致（服务端真删了，不是本地态骗人） ----
  await open();
  s = await apiState();
  t('刷新后仍是「收藏」态', s.isFavorite === false && s.label === '收藏', JSON.stringify(s));

  // ---- 收藏页/书架列表同步 ----
  await clickFav(); await sleep(1000);
  await open();
  const shelfHas = await c.evaluate(`document.body.innerText.includes('已收藏')`);
  t('刷新后收藏态保持（页面渲染与服务端一致）', shelfHas === true, `rendered=${shelfHas}`);
  await clickFav(); await sleep(1000);

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
