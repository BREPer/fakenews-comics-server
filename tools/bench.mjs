/**
 * 轻量压测：给常见读接口打点，输出 p50 / p95 / 吞吐。
 *
 * 用法：node tools/bench.mjs [baseUrl] [--rounds=60] [--conc=16]
 *
 * 指标口径：
 *  - seq  ：单请求串行往返（含 TCP 复用），代表「点一下要等多久」
 *  - conc ：固定并发下跑满 N 个请求的总耗时 → QPS，代表「滚动书架时同时拉缩略图」
 *  - 只打读接口（写接口会污染回归数据），封面/缩略图走缓存命中路径
 */
const BASE = (process.argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:13801').replace(/\/$/, '');
const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : def;
};
const ROUNDS = arg('rounds', 60);
const CONC = arg('conc', 16);

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
};
const ms = (n) => `${n.toFixed(1).padStart(7)}ms`;

async function seq(name, path, rounds = ROUNDS) {
  const times = [];
  let bytes = 0;
  // 预热（JIT / 语句编译 / 缓存）
  await (await fetch(BASE + path)).arrayBuffer();
  for (let i = 0; i < rounds; i++) {
    const t = performance.now();
    const r = await fetch(BASE + path);
    const buf = await r.arrayBuffer();
    times.push(performance.now() - t);
    bytes += buf.byteLength;
    if (r.status !== 200) {
      console.log(`  ${name.padEnd(30)} HTTP ${r.status}  ${path}`);
    }
  }
  console.log(
    `  ${name.padEnd(30)} p50 ${ms(pct(times, 0.5))}  p95 ${ms(pct(times, 0.95))}  avg ${ms(times.reduce((a, b) => a + b, 0) / times.length)}  ${(bytes / 1024).toFixed(0)}KB`,
  );
  return pct(times, 0.5);
}

async function conc(name, path, total = 160, conc = CONC) {
  const t = performance.now();
  let done = 0;
  const worker = async () => {
    while (done < total) {
      done++;
      const r = await fetch(BASE + path);
      await r.arrayBuffer();
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  const dur = performance.now() - t;
  console.log(`  ${name.padEnd(30)} ${total} req / ${conc} 并发  ${dur.toFixed(0)}ms  →  ${(total / (dur / 1000)).toFixed(0)} QPS`);
}

const j = async (p) => (await (await fetch(BASE + p)).json()).data;

const comics = await j('/api/comics?pageSize=200');
const one = comics.items.find((c) => c.chapterCount > 1) ?? comics.items[0];
const detail = await j(`/api/comics/${encodeURIComponent(one.id)}`);
const ch = detail.chapters.find((x) => x.pageCount > 0) ?? detail.chapters[0];

console.log(`\n目标 ${BASE} · 漫画 ${comics.total} 部 · 样本「${one.title}」(${detail.chapters.length} 章)`);
console.log('\n[串行往返]');
await seq('列表 pageSize=60', '/api/comics?pageSize=60');
await seq('列表 + 搜索 "a"', '/api/comics?q=a&pageSize=60');
await seq('列表 sort=title', '/api/comics?sort=title&order=asc&pageSize=60');
await seq('facets（题材/格式聚合）', '/api/comics/facets');
await seq('详情（含章列表）', `/api/comics/${encodeURIComponent(one.id)}`);
await seq('章节页清单', `/api/comics/${encodeURIComponent(one.id)}/chapters/${encodeURIComponent(ch.id)}/pages`);
await seq('封面（缓存命中）', `/api/comics/${encodeURIComponent(one.id)}/cover?w=320`);
await seq('缩略图 standard（缓存命中）', `/api/comics/${encodeURIComponent(one.id)}/chapters/${encodeURIComponent(ch.id)}/pages/0?quality=standard&w=800`);
await seq('原图（整页）', `/api/comics/${encodeURIComponent(one.id)}/chapters/${encodeURIComponent(ch.id)}/pages/0?quality=original`);

console.log('\n[并发]');
await conc('列表 ×160 并发 16', '/api/comics?pageSize=60');
await conc('facets ×160 并发 16', '/api/comics/facets');
await conc('封面 ×160 并发 16', `/api/comics/${encodeURIComponent(one.id)}/cover?w=320`);
console.log();
