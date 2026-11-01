/**
 * 「设置 → 关于」截图核对（Edge headless + 裸 CDP，无三方依赖）。
 *
 * 用途：改品牌/Logo/版本展示后，确认页面上真的渲染出来了（而不是只看源码）。
 * 断言：Logo 图片加载成功（naturalWidth>0）、尺寸符合预期、无破图。
 *
 * 用法：node tools/about_shot.mjs [baseUrl] [输出png路径] [视口宽度=480]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:13801';
const OUT = process.argv[3] || 'tools/_shots/settings-about-logo.png';
const VW = Number(process.argv[4]) || 480;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const CDP_PORT = 9346;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-about-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitCdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
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
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
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

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', `--user-data-dir=${profile}`,
  `--remote-debugging-port=${CDP_PORT}`, 'about:blank',
], { stdio: 'ignore' });

let fail = 0;
const t = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

try {
  const c = client(await waitCdp());
  await c.ready;
  await c.send('Page.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: VW, height: 900, deviceScaleFactor: 2, mobile: false });
  await c.send('Page.navigate', { url: `${BASE}/settings` });
  await sleep(2200);

  // 滚到「关于」区块
  await c.evaluate(`(() => {
    const h = [...document.querySelectorAll('h2')].find(x => x.textContent.trim() === '关于');
    (h ? h.closest('section') : document.body).scrollIntoView({ block: 'center' });
  })()`);
  await sleep(500);

  const info = await c.evaluate(`(() => {
    const h = [...document.querySelectorAll('h2')].find(x => x.textContent.trim() === '关于');
    const sec = h ? h.closest('section') : null;
    const img = sec ? sec.querySelector('img') : null;
    if (!img) return { found: false };
    return {
      found: true,
      src: img.currentSrc || img.src,
      natural: img.naturalWidth + 'x' + img.naturalHeight,
      box: Math.round(img.getBoundingClientRect().width) + 'x' + Math.round(img.getBoundingClientRect().height),
      alt: img.alt,
      complete: img.complete,
    };
  })()`);

  t('关于区块里有 Logo 图片', info.found === true);
  if (info.found) {
    t('图片真的解码成功（非破图）', info.complete && /^\d+x\d+$/.test(info.natural) && !info.natural.startsWith('0x'), `natural=${info.natural}`);
    t('走的是 webp 源', info.src.endsWith('.webp'), info.src.split('/').pop());
    t('渲染尺寸 44px', info.box === '44x44', info.box);
    t('alt 文案为「肥牛漫画」', info.alt === '肥牛漫画', info.alt);
  }

  // 侧边栏品牌位也换了（平板 rail 在 480px 宽度下可见）
  const rail = await c.evaluate(`(() => {
    const imgs = [...document.querySelectorAll('img[alt="肥牛漫画"]')];
    return imgs.map(i => ({ src: (i.currentSrc||i.src).split('/').pop(), w: Math.round(i.getBoundingClientRect().width), ok: i.complete && i.naturalWidth > 0 }));
  })()`);
  t('页面内品牌 Logo 均已加载', rail.length > 0 && rail.every((r) => r.ok), JSON.stringify(rail));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const shot = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log(`  截图：${OUT}`);
  c.close();
} finally {
  edge.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(fail === 0 ? '\n关于页 Logo：全部通过' : `\n关于页 Logo：${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
