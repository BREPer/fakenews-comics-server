/**
 * 性能测试夹具：在开发实例的库目录里造一部「长章节」漫画（默认 ch01 30 页 + ch02 6 页，900×1300）
 *
 * 为什么需要：仓库自带的测试夹具每章只有 2~4 页，而阅读器默认预加载 3 页——
 * 短章节的所有邻页都会被预取，翻页永远命中缓存（实测 ~20ms），量不出「现取一页」的成本，
 * 也看不出首屏与预加载之间的带宽竞争。30 页 / 单页约 950KB 才接近真实扫描件。
 *
 * 为什么要有第二章：跨章翻页（章末继续往后）曾经是整段白屏，量它得有一部多章漫画，
 * 且第二章首页必须是「冷」的。
 *
 * 用法：node tools/perf_fixture.mjs [--pages 30] [--next 6] [--force]
 *   之后 node tools/perf_reader.mjs 会选中它（按页数取最大的一部）。
 * 清理：删掉 %TEMP%/fakenews-comics/perf-big 后重新扫描即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writePng } from './lib/image.mjs';

// 允许 `--key=value` 与 `--key value` 两种写法（历史上探针混用，写错会被静默忽略）
process.argv = process.argv.flatMap((a) => {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  return m ? [`--${m[1]}`, m[2]] : [a];
});
const ARG = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const PAGES = Number(ARG('pages', '30'));
const NEXT = Number(ARG('next', '6'));
const FORCE = process.argv.includes('--force');
const BASE = (process.env.API_BASE || 'http://127.0.0.1:13800').replace(/\/$/, '');
const LIB_ROOT = path.join(os.tmpdir(), 'fakenews-comics');
const ROOT = path.join(LIB_ROOT, 'perf-big');
const W = 900;
const H = 1300;

/** 造一章：pageOffset 让第二章的噪声纹理与第一章不同，避免被当成同一张图 */
function makeChapter(name, count, pageOffset) {
  const dir = path.join(ROOT, name);
  const have = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.png')).length : 0;
  if (have >= count && !FORCE) {
    console.log(`夹具已存在：${dir}（${have} 页），跳过生成`);
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  for (let i = 1; i <= count; i++) {
    const k = i + pageOffset;
    // 用噪声纹理而不是纯色：纯色 PNG 会被压到几 KB，量不出带宽
    writePng(path.join(dir, String(i).padStart(3, '0') + '.png'), W, H, (x, y) => [
      (x + k * 7) % 256,
      (y + k * 3) % 256,
      ((x ^ y) + k * 5) % 256,
    ]);
  }
  console.log(`已生成 ${count} 页 → ${dir}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
}

makeChapter('ch01', PAGES, 0);
makeChapter('ch02', NEXT, 100);

// 触发扫描并等它跑完，否则阅读器拿不到这部漫画
const scan = await fetch(`${BASE}/api/scan`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
});
if (!scan.ok) {
  console.error(`扫描请求失败（${scan.status}）：确认 ${BASE} 的开发实例在跑（./dev.sh）`);
  process.exit(1);
}
for (let i = 0; i < 60; i++) {
  const st = await (await fetch(`${BASE}/api/scan/status`)).json();
  if (!st?.data?.running) break;
  await new Promise((r) => setTimeout(r, 500));
}

const list = await (await fetch(`${BASE}/api/comics?pageSize=50`)).json();
const hit = (list?.data?.items ?? []).find((c) => c.title === 'perf-big');
if (!hit) {
  console.error('扫描完成但库里没有 perf-big：检查库路径是否包含 ' + LIB_ROOT);
  process.exit(1);
}
console.log(`已入库：${hit.title} id=${hit.id} 页数=${hit.pageCount}`);
