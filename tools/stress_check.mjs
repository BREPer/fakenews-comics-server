// 并发压测：模拟阅读器真实负载，验证「源缓存共享 + 页数缓存 + 取图」在并发下稳定。
//
// 背景：sources 的 pageMap / files 缓存由 sourceCache 共享给多个 handler，之前是无锁
// map —— 首页封面与阅读器预加载并发打同一本书就是 concurrent map writes（Go 运行时
// 直接崩进程）。这个脚本用高并发反复打同一本书来验证修复，并给出延迟分位。
//
// 用法：
//   node tools/stress_check.mjs                     # 默认 2000 请求 / 并发 32
//   node tools/stress_check.mjs --n=5000 --c=64     # 自定义规模
//   node tools/stress_check.mjs --tag=before        # 截图/日志区分（仅影响输出前缀）
import { execSync } from 'node:child_process';

// 允许 `--key=value` 与 `--key value` 两种写法（历史上探针混用，写错会被静默忽略）
process.argv = process.argv.flatMap((a) => {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  return m ? [`--${m[1]}`, m[2]] : [a];
});
const ARG = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (hit) return hit.split('=')[1];
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};

const BASE = ARG('base', 'http://127.0.0.1:13800');
const TOTAL = Number(ARG('n', 2000));
const CONC = Number(ARG('c', 32));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (p) => {
  const r = await fetch(BASE + p);
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
};

/* ---------- 素材：漫画 + 章节 ---------- */
const list = (await api('/api/comics?pageSize=50')).data.items;
if (!list.length) {
  console.error('没有漫画，先扫描库');
  process.exit(1);
}
const targets = [];
for (const c of list) {
  const d = (await api(`/api/comics/${c.id}`)).data;
  for (const ch of d.chapters ?? []) {
    targets.push({ comicId: c.id, chapterId: ch.id, pages: ch.pageCount || 0, title: c.title });
  }
}
targets.sort((a, b) => b.pages - a.pages); // 大的排前面，压测更有意义
console.log(`素材：${list.length} 部 / ${targets.length} 章；最大 ${targets[0]?.title}（${targets[0]?.pages} 页）`);

/* ---------- 进程句柄/内存（仅本地直跑时可用） ---------- */
function procStats() {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "$p=(Get-NetTCPConnection -LocalPort 13800 -State Listen).OwningProcess; Get-Process -Id $p | Select-Object -Property HandleCount,WorkingSet64 | ConvertTo-Json -Compress"`,
      { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return JSON.parse(out.trim());
  } catch {
    return null;
  }
}

const before = procStats();

/* ---------- 请求池 ---------- */
const lat = [];
let ok = 0;
const failBy = new Map();
let seq = 0;

const pick = () => {
  const r = Math.random();
  // 70% 取图（阅读器主负载），20% 详情，10% 列表/筛选
  if (r < 0.7) {
    // 热度倾斜：一半请求集中在前 2 本，模拟「用户正在读这本书时反复翻页」
    const t = Math.random() < 0.5 ? targets[Math.floor(Math.random() * Math.min(2, targets.length))] : targets[Math.floor(Math.random() * targets.length)];
    const page = Math.floor(Math.random() * Math.max(1, t.pages));
    return { kind: 'page', t, page };
  }
  if (r < 0.9) {
    const t = targets[Math.floor(Math.random() * targets.length)];
    return { kind: 'detail', t };
  }
  return { kind: Math.random() < 0.5 ? 'list' : 'facets' };
};

async function one() {
  const job = pick();
  const t0 = performance.now();
  try {
    let url;
    let headers;
    if (job.kind === 'page') {
      // 模拟阅读器：standard 走缩略图（会落盘缓存），带 Range 更接近 original 路径
      const q = Math.random() < 0.5 ? 'standard' : 'original';
      url = `${BASE}/api/comics/${job.t.comicId}/chapters/${encodeURIComponent(job.t.chapterId)}/pages/${job.page}?quality=${q}`;
      headers = q === 'original' ? { Range: 'bytes=0-65535' } : {};
    } else if (job.kind === 'detail') {
      url = `${BASE}/api/comics/${job.t.comicId}`;
    } else if (job.kind === 'list') {
      url = `${BASE}/api/comics?pageSize=60&sort=addedAt`;
    } else {
      url = `${BASE}/api/comics/facets`;
    }
    const r = await fetch(url, { headers });
    // 读掉 body，否则连接不释放
    await r.arrayBuffer();
    if (!r.ok && r.status !== 206) throw new Error(`${r.status} ${url.replace(BASE, '')}`);
    ok++;
  } catch (e) {
    const key = `${job.kind}: ${String(e.message).slice(0, 60)}`;
    failBy.set(key, (failBy.get(key) ?? 0) + 1);
  } finally {
    lat.push(performance.now() - t0);
  }
}

const started = Date.now();
let launched = 0;
const workers = Array.from({ length: CONC }, async () => {
  while (launched < TOTAL) {
    launched++;
    await one();
  }
});
// 进度
const ticker = setInterval(() => {
  const done = lat.length;
  process.stdout.write(`\r  进度 ${done}/${TOTAL}  已用 ${((Date.now() - started) / 1000).toFixed(1)}s`);
}, 500);
await Promise.all(workers);
clearInterval(ticker);
await sleep(300);

const after = procStats();
const dur = (Date.now() - started) / 1000;
const sorted = lat.slice().sort((a, b) => a - b);
const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

console.log(`\n\n=== 压测结果 ${TOTAL} 请求 / 并发 ${CONC} ===`);
console.log(`  用时 ${dur.toFixed(2)}s  吞吐 ${(TOTAL / dur).toFixed(0)} req/s`);
console.log(`  成功 ${ok}  失败 ${TOTAL - ok}`);
console.log(`  延迟 p50 ${q(0.5).toFixed(0)}ms  p90 ${q(0.9).toFixed(0)}ms  p99 ${q(0.99).toFixed(0)}ms  max ${sorted[sorted.length - 1].toFixed(0)}ms`);
if (failBy.size) {
  console.log('  失败明细：');
  for (const [k, v] of [...failBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`    ×${v}  ${k}`);
}
if (before && after) {
  const dh = after.HandleCount - before.HandleCount;
  const dm = Math.round((after.WorkingSet64 - before.WorkingSet64) / 1048576);
  console.log(`  服务端句柄 ${before.HandleCount} → ${after.HandleCount}（${dh >= 0 ? '+' : ''}${dh}）  内存 ${dm >= 0 ? '+' : ''}${dm}MB`);
}
console.log(failBy.size === 0 ? '\n结论：全部成功，无崩溃、无 5xx。' : '\n结论：存在失败，见上方明细。');
process.exit(failBy.size === 0 ? 0 : 1);
