/**
 * 肥牛漫画 —— Go 后端内存压测（分阶段采样，父进程侧读 RSS，不改产品代码）
 *
 * 采样由父进程按固定间隔读被测进程的工作集，因此测的是**真实 RSS**
 *   （用户报「占用 2.7GB」时看到的正是这个量）；不在产品代码里埋点。
 *
 * 阶段：
 *   P0 启动 + 自动全量扫描（12 部大图漫画）
 *   P1 空闲基线
 *   P2 首屏封面并发 ×12（冷缓存，最坏情况）
 *   P3 封面并发 ×12（热缓存，全部命中磁盘缓存）
 *   P4 单部翻页 standard 并发 ×6 × 6 页
 *
 * 用法：node tools/mem_probe_go.mjs [--keep]
 *   --keep  保留夹具与服务日志（默认跑完清理）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const ROOT = path.resolve('.');
const SERVER_DIR = path.join(ROOT, 'app', 'server-go');
const GO = process.env.GO_EXE || 'go';
const BIN = path.join(os.tmpdir(), process.platform === 'win32' ? 'fakenews-go-mem.exe' : 'fakenews-go-mem');
const PORT = 14210;
const LIB = path.join(os.tmpdir(), 'fc-mem-lib');
const DATA = path.join(os.tmpdir(), 'fc-mem-data-go');
const BASE = `http://127.0.0.1:${PORT}`;
const KEEP = process.argv.includes('--keep');
// 页面尺寸可调：默认 4000×6000（极端压测），PROBE_PAGE_W/H 可切成真实扫描件尺寸（如 1800×2700）
const PAGE_W = Number(process.env.PROBE_PAGE_W || 4000);
const PAGE_H = Number(process.env.PROBE_PAGE_H || 6000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (n) => (n / 1048576).toFixed(1);

/* ---------------- 夹具：纯色大图 PNG（文件小、解码后巨大，精准压解码峰值） ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function pngFile(w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  // 每行 1 字节 filter + w*3 像素
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function genLib() {
  fs.rmSync(LIB, { recursive: true, force: true });
  for (let i = 0; i < 12; i++) {
    const dir = path.join(LIB, `巨扫${String(i + 1).padStart(2, '0')}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let p = 0; p < 6; p++) {
      // 解码后 RGBA ≈ W*H*4 字节/页，正是封面并发的峰值来源
      fs.writeFileSync(path.join(dir, `${String(p + 1).padStart(3, '0')}.png`), pngFile(PAGE_W, PAGE_H, [40 + i * 8, 120, 200 - i * 5]));
    }
  }
  console.log(`夹具：12 部 × 6 页 ${PAGE_W}×${PAGE_H} PNG（${LIB}）`);
}

/* ---------------- RSS 采样（父进程侧，测真实工作集） ---------------- */

function rssOf(pid) {
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    const m = /"([\d,.]+) K"/.exec(r.stdout || '');
    return m ? Number(m[1].replace(/[,.]/g, '')) * 1024 : 0;
  }
  try {
    const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = /VmRSS:\s+(\d+) kB/.exec(st);
    return m ? Number(m[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

/* ---------------- 分阶段执行 ---------------- */

const samples = [];
const phases = [];
let child = null;
let timer = null;

function startSampling(pid) {
  timer = setInterval(() => {
    const rss = rssOf(pid);
    if (rss > 0) samples.push({ t: Date.now(), rss });
  }, 250);
}

function beginPhase(name) {
  phases.push({ name, t0: Date.now(), t1: 0, base: currentRss(), peak: 0 });
}

function endPhase() {
  const ph = phases[phases.length - 1];
  ph.t1 = Date.now();
  ph.peak = Math.max(...samples.filter((s) => s.t >= ph.t0 && s.t <= ph.t1).map((s) => s.rss), 0);
  ph.end = currentRss();
  console.log(
    `  ${ph.name.padEnd(28)} base=${mb(ph.base).padStart(6)}MB  peak=${mb(ph.peak).padStart(7)}MB  end=${mb(ph.end).padStart(6)}MB`,
  );
}

function currentRss() {
  const last = samples[samples.length - 1];
  return last ? last.rss : 0;
}

async function waitHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('服务启动超时');
}

async function waitScanDone(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const st = await (await fetch(`${BASE}/api/scan/status`)).json();
    last = st.data ?? st;
    if (!last.running && last.finishedAt) return last;
    await sleep(300);
  }
  throw new Error('扫描未结束: ' + JSON.stringify(last));
}

const par = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));

async function main() {
  console.log('构建 Go 服务 ...');
  const t0 = Date.now();
  execFileSync(GO, ['build', '-o', BIN, '.'], {
    cwd: SERVER_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      CGO_ENABLED: '0',
      GOTOOLCHAIN: 'local',
      GOFLAGS: '-buildvcs=false',
      GOPROXY: process.env.GOPROXY || 'https://mirrors.aliyun.com/goproxy/,direct',
      GOSUMDB: 'off',
    },
  });
  console.log(`  构建完成 ${Date.now() - t0}ms → ${BIN}\n`);

  genLib();
  fs.rmSync(DATA, { recursive: true, force: true });

  beginPhase('P0 启动 + 全量扫描');
  child = spawn(BIN, [], {
    env: {
      ...process.env,
      APP_PORT: String(PORT),
      COMIC_ROOT: LIB,
      DATA_DIR: DATA,
      WEB_DIST: path.join(ROOT, 'app', 'web', 'dist'),
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logFile = path.join(os.tmpdir(), 'go-mem-probe-server.log');
  const log = fs.createWriteStream(logFile);
  child.stdout.pipe(log);
  child.stderr.pipe(log);

  startSampling(child.pid);
  await waitHealth();
  const scan = await waitScanDone();
  console.log(`  扫描：${scan.total ?? '?'} 部`);
  endPhase();

  await sleep(5000);
  beginPhase('P1 空闲基线');
  await sleep(3000);
  endPhase();

  // 冷缓存：清掉缓存，保证 P2 真的去解码原图
  await fetch(`${BASE}/api/cache/clear`, { method: 'POST' });
  const list = await (await fetch(`${BASE}/api/comics?pageSize=12`)).json();
  const comics = (list.data?.items ?? []).slice(0, 12);
  if (!comics.length) throw new Error('库内无漫画，扫描可能失败');

  beginPhase('P2 封面 ×12 冷缓存');
  await par(12, (i) => fetch(`${BASE}/api/comics/${comics[i % comics.length].id}/cover?w=320`).then((r) => r.arrayBuffer()));
  endPhase();
  await sleep(2500);
  beginPhase('P2b 峰值回落');
  await sleep(3000);
  endPhase();

  beginPhase('P3 封面 ×12 热缓存');
  await par(12, (i) => fetch(`${BASE}/api/comics/${comics[i % comics.length].id}/cover?w=320`).then((r) => r.arrayBuffer()));
  endPhase();

  // 翻页：单部漫画，6 路并发拉 6 页 standard
  const det = await (await fetch(`${BASE}/api/comics/${comics[0].id}`)).json();
  const ch = det.data?.chapters?.[0];
  if (ch) {
    const ck = encodeURIComponent(ch.id);
    beginPhase('P4 翻页 ×6 并发');
    await par(6, (i) =>
      fetch(`${BASE}/api/comics/${comics[0].id}/chapters/${ck}/pages/${i % 6}?quality=standard&w=1080`).then((r) => r.arrayBuffer()),
    );
    endPhase();
  }

  beginPhase('P5 收尾稳定（12s，等后台归还器跑一轮）');
  await sleep(12000);
  endPhase();

  /* -------- 汇总 -------- */
  const idle = phases.find((p) => p.name.startsWith('P1'));
  const worst = phases.reduce((a, b) => (b.peak > a.peak ? b : a), phases[0]);
  const settle = phases[phases.length - 1];
  console.log('\n' + '='.repeat(64));
  console.log(`基线 rss        ${mb(idle?.peak ?? 0)} MB`);
  console.log(`峰值 rss        ${mb(worst.peak)} MB   （${worst.name}）`);
  console.log(`收尾 rss        ${mb(settle.end)} MB   （峰值后回落 ${mb(worst.peak - settle.end)} MB）`);
  console.log(`峰值/基线       ${((worst.peak / (idle?.peak || 1)) || 0).toFixed(2)}×`);
  console.log(`采样点           ${samples.length}  日志 ${logFile}`);
  console.log('='.repeat(64));

  clearInterval(timer);
  child.kill();
  if (!KEEP) {
    await sleep(500);
    fs.rmSync(LIB, { recursive: true, force: true });
    fs.rmSync(DATA, { recursive: true, force: true });
    console.log('已清理夹具与数据目录（--keep 可保留）');
  } else {
    console.log(`保留夹具：${LIB} / ${DATA}`);
  }
}

main().catch((e) => {
  console.error('压测失败：', e.message);
  if (timer) clearInterval(timer);
  if (child) child.kill();
  process.exit(1);
});
