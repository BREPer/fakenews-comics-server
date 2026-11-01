/**
 * 边界/畸形数据集冒烟（配合 `python tools/make_edge_data.py` 生成的 %TEMP%/fc-edge）。
 *
 * 断言：畸形/压力数据集能扫完、详情与取页无 500（坏包/空包应为 4xx）、
 * LIKE 通配符已转义（搜 "100%"/"%" 不会命中全部）、Range 206/416、各读接口 200。
 *
 * 用法：node tools/edge_probe.mjs [baseUrl]
 */
const B = process.argv[2] || 'http://127.0.0.1:13801';
let pass = 0;
let fail = 0;
const t = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}${d ? '  ' + d : ''}`); }
  else { fail++; console.log(`  ✗ FAIL ${n}${d ? '  ' + d : ''}`); }
};
const j = async (p, init) => {
  const r = await fetch(B + p, init);
  const txt = await r.text();
  let o = null;
  try { o = JSON.parse(txt); } catch { /* 非 JSON */ }
  return { s: r.status, o, txt };
};

// 1) 等扫描结束（压力库 200 部，给足时间）
let st;
for (let i = 0; i < 600; i++) {
  st = (await j('/api/scan/status')).o?.data;
  if (st && !st.running) break;
  await new Promise((r) => setTimeout(r, 200));
}
const ms = st?.finishedAt && st?.startedAt ? st.finishedAt - st.startedAt : '?';
console.log(`扫描: total=${st?.total} done=${st?.done} skipped=${st?.skipped} skippedLibs=${JSON.stringify(st?.skippedLibs)} error=${st?.error ?? 'none'} 用时=${ms}ms`);
t('扫描无异常记录', !st?.error, String(st?.error ?? ''));
t('没有整库被跳过', (st?.skippedLibs ?? []).length === 0, JSON.stringify(st?.skippedLibs));

// 2) 列表与详情
const list = (await j('/api/comics?pageSize=200')).o.data;
console.log(`入库漫画: ${list.total} 部`);
t('畸形数据下仍能列出漫画', list.total > 10, `total=${list.total}`);

const detailBad = [];
const pageBad = [];
for (const c of list.items.slice(0, 60)) {
  const d = await j('/api/comics/' + encodeURIComponent(c.id));
  if (d.s !== 200) detailBad.push(`${c.title}:${d.s}`);
  const ch = d.o?.data?.chapters?.[0];
  if (ch) {
    const p = await fetch(`${B}/api/comics/${encodeURIComponent(c.id)}/chapters/${encodeURIComponent(ch.id)}/pages/0?quality=original`);
    await p.arrayBuffer();
    if (p.status >= 500) pageBad.push(`${c.title}:${p.status}`);
  }
}
t('详情接口无 500', detailBad.length === 0, detailBad.slice(0, 5).join(','));
t('取页无 500（坏包/空包应为 4xx）', pageBad.length === 0, pageBad.slice(0, 5).join(','));

// 3) 搜索边界：LIKE 通配符必须转义（否则搜 "%" 命中全部）
const total = list.total;
for (const q of ['100%', '%', '_', '   ', 'a'.repeat(120), '\u0000']) {
  const r = await j('/api/comics?q=' + encodeURIComponent(q) + '&pageSize=20');
  const got = r.o?.data?.total ?? -1;
  t(`搜索 ${JSON.stringify(q).slice(0, 24)} 不报错`, r.s === 200, `status=${r.s} total=${got}`);
  if (q === '100%' || q === '%' || q === '_') {
    t(`搜索 ${JSON.stringify(q)} 不会命中全部`, got < total, `total=${got}/${total}`);
  }
}

// 4) Range 语义
const c0 = list.items.find((c) => c.chapterCount > 0);
const d0 = (await j('/api/comics/' + encodeURIComponent(c0.id))).o.data;
const ch0 = d0.chapters.find((x) => x.pageCount > 0);
const base = `/api/comics/${encodeURIComponent(c0.id)}/chapters/${encodeURIComponent(ch0.id)}/pages/0`;
const r206 = await fetch(B + base, { headers: { range: 'bytes=0-99' } });
await r206.arrayBuffer();
t('Range 0-99 → 206', r206.status === 206, `status=${r206.status} len=${r206.headers.get('content-length')}`);
const r416 = await fetch(B + base, { headers: { range: 'bytes=99999999-' } });
await r416.arrayBuffer();
t('越界 Range → 416', r416.status === 416, `status=${r416.status}`);

// 5) 其它读接口
for (const p of ['/api/comics/facets', '/api/settings', '/api/cache/stats', '/api/favorites', '/api/history']) {
  const r = await j(p);
  t(`${p} 200`, r.s === 200, `status=${r.s}`);
}

console.log(`\n边界数据集: 通过 ${pass} 失败 ${fail}`);
process.exit(fail ? 1 : 0);
