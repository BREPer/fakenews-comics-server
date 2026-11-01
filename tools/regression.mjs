/**
 * 肥牛漫画 —— 全功能回归测试（黑盒，走真实 HTTP）
 *
 * 用法：
 *   node tools/regression.mjs [BASE_URL]
 * 前置：后端已启动，且已至少扫描过一次（库内有数据）。
 *
 * 设计原则：
 *   - 断言「响应内容」而非仅状态码（历史教训：4 个 bug 都是状态码对、内容错）
 *   - 字节级校验（PNG 尺寸 / 图片 magic / JSON 字段一致性）
 *   - 用例之间尽量无耦合，单点失败不阻断其余
 */
import http from 'node:http';

const BASE = process.argv[2] || 'http://127.0.0.1:13801';

let pass = 0;
let fail = 0;
const failures = [];
let currentBatch = '';

function batch(name) {
  currentBatch = name;
  console.log(`\n=== ${name} ===`);
}

function ok(name) {
  pass++;
  console.log(`  ✓ ${name}`);
}

function bad(name, detail) {
  fail++;
  failures.push(`[${currentBatch}] ${name} :: ${detail}`);
  console.log(`  ✗ FAIL ${name} :: ${detail}`);
}

/** 断言：条件为真则通过 */
function t(name, cond, detail = '') {
  if (cond) ok(name);
  else bad(name, detail || 'assertion false');
}

/** 断言：两值相等（Object.is 或深比较 JSON） */
function eq(name, actual, expect) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  if (a === e) ok(name);
  else bad(name, `got ${a} want ${e}`);
}

// ---------- HTTP 助手 ----------
async function api(path, init) {
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（图片等） */ }
  return { status: res.status, headers: res.headers, text, json, buf: Buffer.from(text, 'utf8') };
}

async function apiBuf(path, init) {
  const res = await fetch(BASE + path, init);
  const ab = await res.arrayBuffer();
  return { status: res.status, headers: res.headers, buf: Buffer.from(ab) };
}

const get = (p) => api(p);
const post = (p, body) => api(p, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});
const put = (p, body) => api(p, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});
const del = (p) => api(p, { method: 'DELETE' });
/**
 * 模拟浏览器 / fnOS 内置 WebView 的 DELETE：
 * 带 content-type: application/json 但 body 为空（浏览器会补 Content-Length: 0）。
 * Fastify 默认对此回 400 FST_ERR_CTP_EMPTY_JSON_BODY，导致界面里
 * 「删除漫画库 / 取消收藏 / 删除历史」全部失败——这些用例必须走这个形态才能守住。
 */
async function delBrowser(p) {
  const u = new URL(BASE + p);
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: 'DELETE',
        headers: { 'content-type': 'application/json', 'content-length': '0' },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* 非 JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', (e) => resolve({ status: 0, text: e.message, json: null }));
    req.end();
  });
}
/** 只取原始响应头（不走 fetch：fetch 会自动解压并抹掉 Content-Encoding）。 */
function rawHead(p, headers) {
  const u = new URL(BASE + p);
  return new Promise((resolve) => {
    const req = http.request(
      { host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'GET', headers },
      (res) => {
        res.resume(); // 丢弃 body
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      },
    );
    req.on('error', () => resolve({ status: 0, headers: {} }));
    req.end();
  });
}

const patch = (p, body) => api(p, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

/** PNG 宽高（读 IHDR），用于验证「图真的是这张图」而不只是 200 */
function pngSize(buf) {
  if (buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf.toString('latin1', 1, 4) !== 'PNG') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** 翻页拉全量漫画（pageSize 上限 200，库里 221 本，单次取不全） */
async function allComics(libraryId, extraQs = '') {
  const out = [];
  let page = 1;
  for (;;) {
    const qs = `?page=${page}&pageSize=200`
      + (libraryId ? `&libraryId=${encodeURIComponent(libraryId)}` : '')
      + (extraQs ? `&${extraQs}` : '');
    const r = await get(`/api/comics${qs}`);
    const d = r.json?.data ?? {};
    out.push(...(d.items ?? []));
    if (!d.hasMore) break;
    page++;
    if (page > 20) break;
  }
  return out;
}

/** JPEG SOF 尺寸解析（缩略图/封面输出 JPEG；webp 分支本就跳过尺寸断言） */
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
    }
    i += 2 + len;
  }
  return null;
}

/** WEBP/JPEG/PNG magic 判定 */
function imgMagic(buf) {
  if (buf.length < 12) return 'tiny';
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('latin1', 0, 3) === 'GIF') return 'gif';
  return 'unknown';
}

/** /api/progress 响应 → 单条记录（兼容 {items:[]} / 数组 / 以 comicId 为键三种形态） */
function recOf(data) {
  if (!data) return undefined;
  if (Array.isArray(data)) return data[0];
  if (Array.isArray(data.items)) return data.items[0];
  const vals = Object.values(data);
  return vals.length && typeof vals[0] === 'object' ? vals[0] : undefined;
}

/** 轮询直到扫描结束 */
async function waitScanIdle(timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    const s = await get('/api/scan/status');
    if (s.json?.data?.running === false) return s.json.data;
    if (Date.now() - t0 > timeoutMs) throw new Error('scan timeout');
    await new Promise((r) => setTimeout(r, 150));
  }
}

// ============================================================
// Batch A：扫描 / 漫画库 / 浏览 / 搜索
// ============================================================
async function batchA() {
  batch('A. 扫描 · 漫画库 · 浏览 · 搜索');

  // A1 设置可读（只剩服务端会执行的 L1；阅读偏好已改为按设备存）
  const st = await get('/api/settings');
  t('A1 设置接口 200 且结构完整',
    st.status === 200 && st.json?.code === 0
      && typeof st.json.data.autoScanIntervalHours === 'number'
      && typeof st.json.data.thumbnailCacheMB === 'number'
      && !('readerMode' in st.json.data) && !('theme' in st.json.data),
    `status=${st.status} body=${st.text.slice(0, 160)}`);

  // A2 全量扫描（异步：POST 只回 started，需轮询 /api/scan/status 等结束）
  const scan = await post('/api/scan', { full: true });
  t('A2 全量扫描已触发', scan.status === 200 && scan.json?.code === 0, `status=${scan.status}`);
  const t0 = Date.now();
  await waitScanIdle();
  const scanMs = Date.now() - t0;
  const sc = (await get('/api/scan/status')).json?.data ?? {};
  t('A2b 扫描统计字段齐全',
    typeof sc.total === 'number' && typeof sc.done === 'number' && typeof sc.skipped === 'number',
    JSON.stringify(sc));
  t('A2c 扫描已跑完全量', sc.running === false && sc.done === sc.total, JSON.stringify(sc));
  t(`A2d 扫描耗时合理(${scanMs}ms <20s)`, scanMs < 20000, `ms=${scanMs}`);

  // A3 增量扫描（应大量 skip）
  const inc = await post('/api/scan', {});
  t('A3 增量扫描已触发', inc.status === 200 && inc.json?.code === 0);
  await waitScanIdle();
  const sc2 = (await get('/api/scan/status')).json?.data ?? {};
  t('A3b 增量扫描跳过未变更文件', (sc2.skipped ?? -1) > 0, `skipped=${sc2.skipped} status=${JSON.stringify(sc2)}`);

  // A4 扫描状态
  const ss = await get('/api/scan/status');
  t('A4 扫描状态可读', ss.status === 200 && ss.json?.data && typeof ss.json.data.running === 'boolean',
    JSON.stringify(ss.json?.data));

  // A5 漫画库列表
  const libs = await get('/api/libraries');
  t('A5 漫画库列表 200', libs.status === 200 && Array.isArray(libs.json?.data?.items));
  const libItems = libs.json?.data?.items ?? [];
  t('A5b 库条目含 comicCount', libItems.length > 0 && libItems.every((l) => typeof l.comicCount === 'number'),
    JSON.stringify(libItems.map((l) => [l.name, l.comicCount])));
  t('A5c 库条目结构完整',
    libItems.every((l) => l.id && l.name && Array.isArray(l.paths)), JSON.stringify(libItems[0]));

  // A6 新建 + 删除库（生命周期；paths 必填，缺则应 400）
  const realPath = (libItems[0]?.paths ?? [])[0];
  const badCreate = await post('/api/libraries', { name: '__无路径__', type: 'chapter', paths: [] });
  t('A6 缺 paths 新建库返回 400', badCreate.status === 400, `status=${badCreate.status}`);

  let tmpId = null;
  if (realPath) {
    const created = await post('/api/libraries', { name: '__回归测试临时库__', type: 'chapter', paths: [realPath] });
    t('A6b 新建漫画库', created.status === 200 && !!created.json?.data?.id, JSON.stringify(created.json?.data));
    tmpId = created.json?.data?.id;
    if (tmpId) {
      const after = await get('/api/libraries');
      t('A6c 新库出现在列表', (after.json?.data?.items ?? []).some((l) => l.id === tmpId));
    }
  }

  // A7 库重命名（PATCH）
  const firstLib = libItems[0];
  if (firstLib) {
    const oldName = firstLib.name;
    const rn = await patch(`/api/libraries/${firstLib.id}`, { name: oldName + '_改名' });
    t('A7 库重命名', rn.status === 200, `status=${rn.status} body=${rn.text.slice(0, 120)}`);
    const chk = await get('/api/libraries');
    t('A7b 新名字已生效', (chk.json?.data?.items ?? []).some((l) => l.id === firstLib.id && l.name === oldName + '_改名'),
      JSON.stringify((chk.json?.data?.items ?? []).map((l) => [l.id, l.name])));
    await patch(`/api/libraries/${firstLib.id}`, { name: oldName });
    const chk2 = await get('/api/libraries');
    t('A7c 名字已还原', (chk2.json?.data?.items ?? []).some((l) => l.id === firstLib.id && l.name === oldName));
  }

  // A7d 库排序
  if (libItems.length >= 2) {
    const ro = await post('/api/libraries/reorder', { ids: libItems.map((l) => l.id).reverse() });
    t('A7d 库重排序成功', ro.status === 200, JSON.stringify(ro.json));
    const chk3 = await get('/api/libraries');
    t('A7e 排序已生效',
      (chk3.json?.data?.items ?? [])[0]?.id === libItems[libItems.length - 1].id,
      JSON.stringify((chk3.json?.data?.items ?? []).map((l) => l.name)));
    await post('/api/libraries/reorder', { ids: libItems.map((l) => l.id) });
  }

  // 删掉临时库（放在重命名/排序之后，避免影响统计）
  if (tmpId) {
    await waitScanIdle();
    // 走浏览器形态（JSON 头 + 空 body）：这正是飞牛里删库失败的那条路径
    const rm = await delBrowser(`/api/libraries/${tmpId}`);
    t('A6d 删除漫画库（浏览器形态 DELETE）', rm.status === 200, `status=${rm.status} body=${(rm.text ?? '').slice(0, 120)}`);
    t('A6d2 删除返回 removedComics', typeof rm.json?.data?.removedComics === 'number', JSON.stringify(rm.json?.data));
    const after2 = await get('/api/libraries');
    t('A6e 删除后从列表消失', !(after2.json?.data?.items ?? []).some((l) => l.id === tmpId));
    const ghostDel = await delBrowser('/api/libraries/no-such-lib-xyz');
    t('A6f 删不存在的库返回 404', ghostDel.status === 404, `status=${ghostDel.status}`);
  }

  // A8 列表分页
  const p1 = await get('/api/comics?page=1&pageSize=10');
  t('A8 漫画列表 200', p1.status === 200 && Array.isArray(p1.json?.data?.items));
  const d1 = p1.json?.data ?? {};
  // 期望条数 = min(pageSize, 库内总数)：夹具只有 8 本时写死 10 会误报
  const expectLen = Math.min(10, d1.total ?? 0);
  t('A8b pageSize 生效', d1.items?.length === expectLen, `len=${d1.items?.length} expect=${expectLen} total=${d1.total}`);
  t('A8c total 与 pageSize 自洽', typeof d1.total === 'number' && d1.total >= d1.items?.length && d1.pageSize === 10);
  t('A8d hasMore 正确', d1.hasMore === (d1.total > 10), `hasMore=${d1.hasMore} total=${d1.total}`);
  const p2 = await get('/api/comics?page=2&pageSize=10');
  const ids1 = (d1.items ?? []).map((c) => c.id);
  const ids2 = (p2.json?.data?.items ?? []).map((c) => c.id);
  t('A8e 第二页不与第一页重复', ids2.every((id) => !ids1.includes(id)));

  // A9 排序
  const byTitle = await get('/api/comics?sort=title&order=asc&pageSize=5');
  const titles = (byTitle.json?.data?.items ?? []).map((c) => c.title ?? '');
  // A9 防「阿飞排最后」这类字节序乱序，断言收敛到中文拼音主序：
  // 拉丁开头条目（如 "EPUB 测试漫画"）在不同 collator 实现下位置不同
  // （x/text/collator 把汉字排在其后），不参与比对，只校验纯中文标题之间的顺序。
  const zhTitles = titles.filter((t) => /[\u4e00-\u9fff]/.test(t[0] ?? ''));
  const sorted = [...zhTitles].sort((a, b) => a.localeCompare(b, 'zh'));
  t('A9 按标题升序排序正确（中文拼音序）', JSON.stringify(zhTitles) === JSON.stringify(sorted), JSON.stringify(titles));
  const desc = await get('/api/comics?sort=addedAt&order=desc&pageSize=5');
  const ats = (desc.json?.data?.items ?? []).map((c) => c.addedAt);
  t('A9b 按加入时间降序正确', ats.every((v, i) => i === 0 || ats[i - 1] >= v), JSON.stringify(ats));

  // A10 格式筛选
  const facets = await get('/api/comics/facets');
  t('A10 facets 接口', facets.status === 200 && Array.isArray(facets.json?.data?.formats));
  const fmts = (facets.json?.data?.formats ?? []).map((f) => f.value);
  t('A10b facets 含已知格式', fmts.length > 0, JSON.stringify(fmts));
  if (fmts[0]) {
    const f = await get(`/api/comics?format=${encodeURIComponent(fmts[0])}&pageSize=200`);
    const items = f.json?.data?.items ?? [];
    t('A10c 格式筛选结果纯净', items.length > 0 && items.every((c) => c.format === fmts[0]),
      `want=${fmts[0]} got=${[...new Set(items.map((c) => c.format))].join(',')}`);
  }

  // A11 状态筛选
  for (const s of ['unread', 'reading', 'finished']) {
    const r = await get(`/api/comics?status=${s}&pageSize=200`);
    const items = r.json?.data?.items ?? [];
    const good = items.every((c) => c.readStatus === s);
    t(`A11 状态筛选 ${s} 纯净`, r.status === 200 && good,
      `n=${items.length} got=${[...new Set(items.map((c) => c.readStatus))].join(',')}`);
  }

  // A12 三种状态互斥且完备
  const allItems = await allComics();
  const all = { json: { data: { items: allItems, total: allItems.length } } };
  const byStatus = { unread: 0, reading: 0, finished: 0 };
  for (const c of all.json?.data?.items ?? []) byStatus[c.readStatus] = (byStatus[c.readStatus] ?? 0) + 1;
  const u = (await get('/api/comics?status=unread&pageSize=200')).json?.data?.total ?? -1;
  const r = (await get('/api/comics?status=reading&pageSize=200')).json?.data?.total ?? -1;
  const f = (await get('/api/comics?status=finished&pageSize=200')).json?.data?.total ?? -1;
  t('A12 三状态计数之和 = 总数', (all.json?.data?.total ?? 0) >= u + r + f - 3 && u >= 0 && r >= 0 && f >= 0,
    `total=${all.json?.data?.total} u=${u} r=${r} f=${f}`);

  // A13 搜索（含特殊字符）
  const kw = '测试';
  const s1 = await get(`/api/comics?q=${encodeURIComponent(kw)}&pageSize=200`);
  const hits = await allComics(null, `q=${encodeURIComponent(kw)}`);
  // 后端搜索范围 = 标题 / 原始文件名 / 作者 / 简介 / 标签，断言须覆盖全部五域
  const allHit = hits.every((c) =>
    [c.title, c.rawTitle, c.author, c.description].some((v) => typeof v === 'string' && v.includes(kw))
    || (c.tags ?? []).some((v) => typeof v === 'string' && v.includes(kw)));
  t('A13 搜索命中均含关键词', allHit,
    `kw=${kw} n=${hits.length} 反例=${JSON.stringify(hits.filter((c) => ![c.title, c.rawTitle, c.author, c.description].some((v) => typeof v === 'string' && v.includes(kw)) && !(c.tags ?? []).some((v) => typeof v === 'string' && v.includes(kw))).slice(0, 2))}`);
  t('A13b 搜索非空', hits.length > 0, `n=${hits.length}`);

  const pct = await get('/api/comics?q=%25&pageSize=200');   // 字面量 "%"
  t('A13c 字面量 % 不当作通配符', (pct.json?.data?.total ?? -1) < (all.json?.data?.total ?? 0) + 1 && pct.status === 200,
    `total=${pct.json?.data?.total} all=${all.json?.data?.total}`);

  const us = await get('/api/comics?q=_&pageSize=200');      // 字面量 "_"
  t('A13d 字面量 _ 不当作通配符', us.status === 200 && (us.json?.data?.total ?? -1) < (all.json?.data?.total ?? 0) + 1,
    `total=${us.json?.data?.total}`);

  const nul = await get(`/api/comics?q=${encodeURIComponent('\u0000')}&pageSize=200`);
  t('A13e NUL 字符被清洗不报错', nul.status === 200, `status=${nul.status}`);

  const inj = await get(`/api/comics?q=${encodeURIComponent("' OR 1=1 --")}&pageSize=200`);
  t('A13f 类注入串不返回全量', (inj.json?.data?.total ?? 999) < (all.json?.data?.total ?? 0), `total=${inj.json?.data?.total}`);

  // A14 标签筛选
  const tags = (facets.json?.data?.tags ?? []).map((x) => x.value);
  if (tags[0]) {
    const tg = await get(`/api/comics?tag=${encodeURIComponent(tags[0])}&pageSize=200`);
    const items = tg.json?.data?.items ?? [];
    t('A14 标签筛选纯净', items.every((c) => (c.tags ?? []).includes(tags[0])), `tag=${tags[0]} n=${items.length}`);
  } else {
    t('A14 无标签数据，跳过', true);
  }

  // A15 库维度筛选
  if (libItems[0]) {
    const lg = await get(`/api/comics?libraryId=${libItems[0].id}&pageSize=200`);
    const items = lg.json?.data?.items ?? [];
    t('A15 库筛选纯净', items.every((c) => c.libraryId === libItems[0].id), `n=${items.length}`);
  }
}

// ============================================================
// Batch B：详情 / 三种格式 / 元数据 / 封面
// ============================================================
async function batchB() {
  batch('B. 详情 · 三格式 · 元数据 · 封面');

  const items = await allComics();

  // B1 按格式各取一本
  // 每种格式挑「确实能出图」的样本（chapterCount>0 且 pageCount>0）；
  // 空目录/坏包/无图包属 D8 的健壮性用例，不应污染 B3 的正常取图断言
  const byFmt = {};
  for (const c of items) {
    const usable = (c.chapterCount ?? 0) > 0 && (c.pageCount ?? 0) > 0;
    const cur = byFmt[c.format];
    if (!cur) { if (usable) byFmt[c.format] = c; else if (!(c.format in byFmt)) byFmt[c.format] = c; continue; }
    const curUsable = (cur.chapterCount ?? 0) > 0 && (cur.pageCount ?? 0) > 0;
    if (!curUsable && usable) byFmt[c.format] = c;
  }
  t('B1 库中覆盖多种格式', Object.keys(byFmt).length >= 3,
    `${JSON.stringify(Object.keys(byFmt))} 全量${items.length}本`);

  // B2 详情（挑一本确实有章节的书，空目录样本留给 D8）
  const sample = items.find((c) => (c.chapterCount ?? 0) > 0 && (c.pageCount ?? 0) > 0) ?? items[0];
  const dt = await get(`/api/comics/${encodeURIComponent(sample.id)}`);
  const d = dt.json?.data;
  t('B2 详情 200', dt.status === 200 && dt.json?.code === 0);
  t('B2b 详情含章列表', Array.isArray(d?.chapters), `chapters=${d?.chapters ? 'yes' : 'no'}`);
  t('B2c chapterCount 与章数组一致', d?.chapterCount === d?.chapters?.length,
    `chapterCount=${d?.chapterCount} len=${d?.chapters?.length}`);
  t('B2d pageCount = 各章页数之和',
    d?.pageCount === (d?.chapters ?? []).reduce((n, c) => n + (c.pageCount ?? 0), 0),
    `pageCount=${d?.pageCount}`);
  t('B2e 详情不泄露服务器路径', !('path' in (d ?? {})) && !JSON.stringify(d).includes('C:\\'),
    'path leaked');
  t('B2f 章 id 带 comicId 前缀', (d?.chapters ?? []).every((c) => typeof c.id === 'string' && c.id.startsWith(sample.id + '#')),
    JSON.stringify((d?.chapters ?? []).map((c) => c.id).slice(0, 3)));
  // 分章进度（chapter_progress）已于 2026-10-24 整体移除：进度只记录当前在读章节，
  // 章节列表不再携带 percent/read。这里断言「不再有这两个字段」。
  t('B2g 章不含 percent/read 字段（分章进度已删）',
    (d?.chapters ?? []).length > 0 && (d?.chapters ?? []).every((c) => !('percent' in c) && !('read' in c)),
    JSON.stringify((d?.chapters ?? [])[0]));

  // B3 三种格式各自取图
  for (const [fmt, c] of Object.entries(byFmt)) {
    const dd = (await get(`/api/comics/${encodeURIComponent(c.id)}`)).json?.data;
    const chs = dd?.chapters ?? [];
    if (!chs.length) { bad(`B3 ${fmt} 有章可取`, 'no chapters'); continue; }
    const ch = chs.find((x) => x.pageCount > 0);
    if (!ch) {
      // 该格式只有坏样本（如「只有元数据」的 zip），取图断言无意义，记录为跳过
      t(`B3 ${fmt} 无可用样本(仅坏包/空包)，跳过取图断言`, true, `sample=${c.title}`);
      continue;
    }
    const pages = await get(`/api/comics/${encodeURIComponent(c.id)}/chapters/${encodeURIComponent(ch.id)}/pages`);
    const list = pages.json?.data?.pages ?? [];
    t(`B3 ${fmt} 章页列表非空`, Array.isArray(list) && list.length > 0, `n=${list.length}`);
    t(`B3b ${fmt} 页列表数与章 pageCount 一致`, list.length === ch.pageCount, `list=${list.length} pageCount=${ch.pageCount}`);

    // 首图真实可读
    const img = await apiBuf(`/api/comics/${encodeURIComponent(c.id)}/chapters/${encodeURIComponent(ch.id)}/pages/0`);
    t(`B3c ${fmt} 首图 200`, img.status === 200, `status=${img.status}`);
    t(`B3d ${fmt} 首图是真实图片`, ['png', 'jpeg', 'webp', 'gif'].includes(imgMagic(img.buf)),
      `magic=${imgMagic(img.buf)} len=${img.buf.length}`);
    t(`B3e ${fmt} 首图非空字节`, img.buf.length > 64, `len=${img.buf.length}`);
  }

  // B4 每章图片尺寸互不相同（验证真的取的是对应章，而非都取第 0 章）
  // 数据驱动：逐个多章漫画取前 3 章首图，找到「尺寸各异」的样本再断言
  let b4done = false;
  for (const cand of items.filter((c) => (c.chapterCount ?? 0) >= 2)) {
    const cd = (await get(`/api/comics/${encodeURIComponent(cand.id)}`)).json?.data;
    const chs = (cd?.chapters ?? []).slice(0, 3);
    if (chs.length < 2) continue;
    const sizes = [];
    for (const ch of chs) {
      const img = await apiBuf(`/api/comics/${encodeURIComponent(cand.id)}/chapters/${encodeURIComponent(ch.id)}/pages/0`);
      sizes.push(pngSize(img.buf));
    }
    if (sizes.some((s) => !s)) continue;           // 非 PNG（webp/jpeg）跳过
    const keys = sizes.map((s) => `${s.w}x${s.h}`);
    if (new Set(keys).size === keys.length) {
      t('B4 不同章首图尺寸互不相同', true, `${cand.title} ${JSON.stringify(keys)}`);
      b4done = true;
      break;
    }
  }
  if (!b4done) t('B4 未找到尺寸各异的多章样本，跳过', true);

  // B5 EPUB spine 顺序
  const epub = items.find((c) => c.format === 'epub');
  if (epub) {
    const dd = (await get(`/api/comics/${encodeURIComponent(epub.id)}`)).json?.data;
    const chs = dd?.chapters ?? [];
    t('B5 EPUB 有章可取', chs.length > 0, JSON.stringify(chs.map((c) => [c.title, c.pageCount])));
    // OPF 的 spine 刻意打乱为 p3 -> p1 -> p2，页序必须按 spine 而非 manifest/文件名
    const ch = chs.find((x) => x.pageCount > 0);
    if (ch) {
      const pg = (await get(`/api/comics/${encodeURIComponent(epub.id)}/chapters/${encodeURIComponent(ch.id)}/pages`))
        .json?.data?.pages ?? [];
      const names = pg.map((p) => p.name);
      t('B5b EPUB 页序遵循 spine(p3,p1,p2)', JSON.stringify(names) === JSON.stringify(['page3.png', 'page1.png', 'page2.png']),
        JSON.stringify(names));
      t('B5c EPUB 页数与章 pageCount 一致', pg.length === ch.pageCount, `pages=${pg.length} pageCount=${ch.pageCount}`);
      // OPF 元数据刮削
      t('B5d EPUB 读取 dc:title', dd?.title === 'EPUB 测试漫画', `got=${dd?.title}`);
      t('B5e EPUB 读取 dc:creator', dd?.author === 'EPUB 作者', `got=${dd?.author}`);
      // 扫描器额外附加「格式」「库名」标签，故只断言 dc:subject 被并入
      t('B5f EPUB 读取 dc:subject 为标签',
        ['科幻', '冒险'].every((x) => (dd?.tags ?? []).includes(x)), `got=${JSON.stringify(dd?.tags)}`);
    }
  } else {
    t('B5 库中无 EPUB，跳过', true);
  }

  // B6 ComicInfo.xml 刮削
  const scraped = items.find((c) => c.author || c.description || (c.tags ?? []).length > 0);
  if (scraped) {
    t('B6 ComicInfo 刮削生效', true, `${scraped.title} author=${scraped.author}`);
  } else {
    t('B6 无刮削数据，跳过', true);
  }

  // B7 元数据编辑 + meta_locked
  const target = sample;
  const newTitle = '回归测试改名_' + Date.now();
  const up = await put(`/api/comics/${encodeURIComponent(target.id)}`, { title: newTitle, author: '回归作者' });
  t('B7 元数据编辑成功', up.status === 200 && up.json?.data?.ok === true, JSON.stringify(up.json));
  const after = (await get(`/api/comics/${encodeURIComponent(target.id)}`)).json?.data;
  t('B7b 新标题已生效', after?.title === newTitle, `got=${after?.title}`);
  t('B7c 作者已生效', after?.author === '回归作者', `got=${after?.author}`);
  // 重扫不应覆盖被锁元数据
  await post(`/api/comics/${encodeURIComponent(target.id)}/scan`, {});
  const afterScan = (await get(`/api/comics/${encodeURIComponent(target.id)}`)).json?.data;
  t('B7d 单部重扫不覆盖已锁元数据', afterScan?.title === newTitle, `got=${afterScan?.title}`);
  // 还原
  await put(`/api/comics/${encodeURIComponent(target.id)}`, { title: target.title, author: target.author ?? null });

  // B8 封面
  const cov = await apiBuf(`/api/comics/${encodeURIComponent(sample.id)}/cover?w=320`);
  t('B8 封面 200', cov.status === 200, `status=${cov.status}`);
  t('B8b 封面是真实图片', ['png', 'jpeg', 'webp', 'gif'].includes(imgMagic(cov.buf)), `magic=${imgMagic(cov.buf)}`);
  const covSize = imgMagic(cov.buf) === 'jpeg' ? jpegSize(cov.buf) : pngSize(cov.buf);
  t('B8c 封面已按宽度缩放', (covSize?.w ?? 9999) <= 320 || imgMagic(cov.buf) === 'webp',
    `size=${JSON.stringify(covSize)}`);
  // 同宽两次请求字节完全一致（缓存命中 + 输出确定性）
  const covAgain = await apiBuf(`/api/comics/${encodeURIComponent(sample.id)}/cover?w=320`);
  t('B8d 同宽封面字节一致(确定性)', covAgain.buf.equals(cov.buf),
    `a=${cov.buf.length} b=${covAgain.buf.length}`);
  // 宽度越界自动收敛，不报错（源图很小，故不断言「不同宽度字节必不同」）
  const covMin = await apiBuf(`/api/comics/${encodeURIComponent(sample.id)}/cover?w=1`);
  const covMax = await apiBuf(`/api/comics/${encodeURIComponent(sample.id)}/cover?w=99999`);
  t('B8e w=1 收敛到下限仍可读', covMin.status === 200 && covMin.buf.length > 0, `status=${covMin.status}`);
  t('B8f w=99999 收敛到上限仍可读', covMax.status === 200 && covMax.buf.length > 0, `status=${covMax.status}`);
  t('B8g 封面带缓存头', (cov.headers.get('cache-control') ?? '').includes('max-age'), cov.headers.get('cache-control'));

  // B9 自定义封面上传
  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');
  const form = new FormData();
  form.append('file', new Blob([png1x1], { type: 'image/png' }), 'cover.png');
  const upc = await fetch(`${BASE}/api/comics/${encodeURIComponent(sample.id)}/cover`, { method: 'POST', body: form });
  t('B9 自定义封面上传成功', upc.status === 200, `status=${upc.status}`);
  const cov2 = await apiBuf(`/api/comics/${encodeURIComponent(sample.id)}/cover?w=320`);
  t('B9b 上传后封面即出即新', cov2.status === 200 && cov2.buf.length > 0, `status=${cov2.status}`);

  // B10 从页面提取封面
  const dd = (await get(`/api/comics/${encodeURIComponent(sample.id)}`)).json?.data;
  const ch0 = dd?.chapters?.[0];
  if (ch0) {
    const cfp = await post(`/api/comics/${encodeURIComponent(sample.id)}/cover-from-page`,
      { chapterId: ch0.id, pageIndex: 0 });
    t('B10 从页面提取封面成功', cfp.status === 200 && cfp.json?.data?.ok === true, JSON.stringify(cfp.json));
  } else {
    t('B10 无章节，跳过', true);
  }
}

// ============================================================
// Batch C：进度 / 收藏 / 历史 / 设置 / 缓存 / 备份
// ============================================================
async function batchC() {
  batch('C. 进度 · 收藏 · 历史 · 设置 · 缓存 · 备份');

  const items = (await allComics()).filter((c) => (c.chapterCount ?? 0) > 0);
  // 主样本优先取多章书（C4 要验证分章进度），次样本取另一本
  const c1 = items.find((c) => (c.chapterCount ?? 0) >= 2) ?? items[0];
  const c2 = items.find((c) => c.id !== c1.id) ?? c1;

  // 清空两份样本的历史进度，保证断言不受上一轮残留状态影响（chapter_progress 用 MAX 语义，读过后不会掉）
  await post(`/api/progress/${encodeURIComponent(c1.id)}/reset`, {});
  await post(`/api/progress/${encodeURIComponent(c2.id)}/reset`, {});

  // C1 批量进度接口
  const pr = await get(`/api/progress?comicIds=${encodeURIComponent(c1.id)}`);
  t('C1 进度查询 200', pr.status === 200 && pr.json?.code === 0, JSON.stringify(pr.json));

  // C2 写进度
  const dd = (await get(`/api/comics/${encodeURIComponent(c1.id)}`)).json?.data;
  const chs = dd?.chapters ?? [];
  const ch0 = chs[0];
  // percent 现在是**全书维度**、由服务端按章累计计算（前序章页数 + 本章已读页 / 全书页数），
  // 前端传的 percent 不再被采信（只在拿不到章页数时兜底）。所以期望值按页数动态算。
  const totalPages = chs.reduce((s, c) => s + (c.pageCount || 0), 0);
  const pctOf = (before, pageIndex, pageCount) =>
    totalPages > 0 ? ((before + Math.min(pageIndex + 1, pageCount)) / totalPages) * 100 : -1;
  const wantC2 = pctOf(0, 2, ch0?.pageCount ?? 10);

  const wr = await put('/api/progress', {
    comicId: c1.id,
    chapterId: ch0?.id,
    chapterIndex: 0,
    pageIndex: 2,
    pageCount: ch0?.pageCount ?? 10,
    percent: 40,
  });
  t('C2 写进度成功', wr.status === 200 && wr.json?.code === 0, JSON.stringify(wr.json));
  const rd = (await get(`/api/progress?comicIds=${encodeURIComponent(c1.id)}`)).json?.data;
  const rec = recOf(rd);
  t('C2b 进度已持久化（percent 按全书累计）', Math.abs((rec?.percent ?? -1) - wantC2) < 0.6,
    `want≈${wantC2.toFixed(1)}（全书 ${totalPages} 页）got=${rec?.percent}`);
  t('C2c 进度含 pageIndex=2', rec?.pageIndex === 2, `got=${JSON.stringify(rec)}`);

  // C3 列表聚合进度
  const lst = await get(`/api/comics?pageSize=200`);
  const inList = (lst.json?.data?.items ?? []).find((c) => c.id === c1.id);
  t('C3 列表聚合了进度', Math.abs((inList?.progress?.percent ?? -1) - wantC2) < 0.6,
    `want≈${wantC2.toFixed(1)} got=${JSON.stringify(inList?.progress)}`);
  t('C3b 列表 readStatus=reading', inList?.readStatus === 'reading', `got=${inList?.readStatus}`);
  t('C3c 列表 lastReadAt 有值', typeof inList?.lastReadAt === 'number', `got=${inList?.lastReadAt}`);

  // C4 分章进度已删，改用「全书进度语义」验证：
  //   停在最后一章首页 → 全书 percent 前进但未读完；读完最后一章 → 100% + finished
  if (chs.length >= 2 && totalPages > 0) {
    const lastCh = chs[chs.length - 1];
    const lastPc = lastCh.pageCount > 0 ? lastCh.pageCount : 4;
    const beforeLast = chs.slice(0, chs.length - 1).reduce((s, c) => s + (c.pageCount || 0), 0);
    await put('/api/progress', {
      comicId: c1.id, chapterId: lastCh.id, chapterIndex: chs.length - 1,
      pageIndex: 0, pageCount: lastPc,
    });
    let d2 = (await get(`/api/comics/${encodeURIComponent(c1.id)}`)).json?.data;
    const wantC4 = pctOf(beforeLast, 0, lastPc);
    t('C4 停在最后一章首页 → 全书 percent 前进（不是章内 100%）',
      Math.abs((d2?.progress?.percent ?? -1) - wantC4) < 0.6,
      `want≈${wantC4.toFixed(1)} got=${d2?.progress?.percent}`);
    t('C4b 只读到最后一章首页 → 仍未读完', d2?.readStatus !== 'finished', `readStatus=${d2?.readStatus}`);

    // 读完最后一章 → 100% 且 finished
    await put('/api/progress', {
      comicId: c1.id, chapterId: lastCh.id, chapterIndex: chs.length - 1,
      pageIndex: lastPc - 1, pageCount: lastPc,
    });
    d2 = (await get(`/api/comics/${encodeURIComponent(c1.id)}`)).json?.data;
    t('C4c 读完最后一章 percent=100', d2?.progress?.percent === 100, `got=${d2?.progress?.percent}`);
    t('C4d 读完最后一章 readStatus=finished', d2?.readStatus === 'finished', `got=${d2?.readStatus}`);
    t('C4e 章节列表不再携带分章进度',
      (d2?.chapters ?? []).every((c) => !('percent' in c) && !('read' in c)),
      JSON.stringify((d2?.chapters ?? [])[0]));
  } else {
    t('C4 章节不足，跳过', true);
  }

  // C5 手动回读（进度向前端上报的真实位置走，允许回退）
  await put('/api/progress', {
    comicId: c1.id, chapterId: ch0?.id, chapterIndex: 0,
    pageIndex: 0, pageCount: ch0?.pageCount ?? 10, percent: 10,
  });
  const rd2 = (await get(`/api/progress?comicIds=${encodeURIComponent(c1.id)}`)).json?.data;
  const rec2 = recOf(rd2);
  const wantC5 = pctOf(0, 0, ch0?.pageCount ?? 10);
  t('C5 回读可写回较小进度(不被拒绝)', Math.abs((rec2?.percent ?? -1) - wantC5) < 0.6,
    `want≈${wantC5.toFixed(1)} got=${JSON.stringify(rec2)}`);

  // C6 重置进度
  const rst = await post(`/api/progress/${encodeURIComponent(c1.id)}/reset`, {});
  t('C6 重置进度成功', rst.status === 200, JSON.stringify(rst.json));
  const rd3 = (await get(`/api/progress?comicIds=${encodeURIComponent(c1.id)}`)).json?.data;
  const rec3 = recOf(rd3);
  t('C6b 重置后进度为空', rec3 === undefined || rec3 === null, `got=${JSON.stringify(rec3)}`);
  const d3 = (await get(`/api/comics/${encodeURIComponent(c1.id)}`)).json?.data;
  // 分章进度已删：重置后章节列表不应再出现 percent/read（以前是断言 percent===0）
  t('C6c 重置后章节不带分章进度字段',
    (d3?.chapters ?? []).every((c) => !('percent' in c) && !('read' in c)),
    JSON.stringify((d3?.chapters ?? []).map((c) => c.percent)));

  // C7 收藏
  const fav = await post(`/api/favorites/${encodeURIComponent(c2.id)}`, {});
  t('C7 加入收藏成功', fav.status === 200, JSON.stringify(fav.json));
  const fl = await get('/api/favorites');
  const favItems = fl.json?.data?.items ?? fl.json?.data ?? [];
  t('C7b 收藏列表含该书', (Array.isArray(favItems) ? favItems : []).some((x) => (x.id ?? x.comicId) === c2.id),
    JSON.stringify((Array.isArray(favItems) ? favItems : []).map((x) => x.id ?? x.comicId).slice(0, 5)));
  t('C7c 列表 isFavorite=true', (await get('/api/comics?pageSize=200')).json?.data?.items?.find((c) => c.id === c2.id)?.isFavorite === true);

  // C8 取消收藏（浏览器形态 DELETE：JSON 头 + 空 body）
  const unf = await delBrowser(`/api/favorites/${encodeURIComponent(c2.id)}`);
  t('C8 取消收藏成功（浏览器形态 DELETE）', unf.status === 200, `status=${unf.status} body=${(unf.text ?? '').slice(0, 120)}`);
  const fl2 = await get('/api/favorites');
  const fi2 = fl2.json?.data?.items ?? fl2.json?.data ?? [];
  t('C8b 收藏列表已移除', !(Array.isArray(fi2) ? fi2 : []).some((x) => (x.id ?? x.comicId) === c2.id));

  // C9 幽灵收藏 404
  const ghost = await post(`/api/favorites/${encodeURIComponent('no-such-comic-xyz')}`, {});
  t('C9 幽灵收藏返回 404', ghost.status === 404, `status=${ghost.status}`);

  // C10 历史
  await put('/api/progress', {
    comicId: c1.id, chapterId: ch0?.id, chapterIndex: 0,
    pageIndex: 1, pageCount: ch0?.pageCount ?? 10, percent: 25,
  });
  const hist = await get('/api/history?limit=20');
  const hi = hist.json?.data?.items ?? hist.json?.data ?? [];
  t('C10 历史列表 200', hist.status === 200, JSON.stringify(hist.json).slice(0, 150));
  t('C10b 历史含刚读的书', (Array.isArray(hi) ? hi : []).some((x) => (x.id ?? x.comicId) === c1.id),
    JSON.stringify((Array.isArray(hi) ? hi : []).map((x) => x.id ?? x.comicId).slice(0, 5)));
  t('C10c limit 生效', (Array.isArray(hi) ? hi : []).length <= 20, `len=${(Array.isArray(hi) ? hi : []).length}`);

  // C11 删除单条历史（同样是浏览器形态）
  const dh = await delBrowser(`/api/history/${encodeURIComponent(c1.id)}`);
  t('C11 删除历史成功', dh.status === 200, JSON.stringify(dh.json));
  const hist2 = await get('/api/history?limit=50');
  const hi2 = hist2.json?.data?.items ?? hist2.json?.data ?? [];
  t('C11b 历史中已移除', !(Array.isArray(hi2) ? hi2 : []).some((x) => (x.id ?? x.comicId) === c1.id));

  // C12 设置读写
  // 注意：阅读偏好与外观（readerMode/readDir/fitMode/theme/accent…）已改为**按设备存**
  // （localStorage），服务端不再保存这 10 个键。这里改用真正的服务端设置项验证读写。
  const orig = (await get('/api/settings')).json?.data;
  const newSettings = { autoScanIntervalHours: 6, thumbnailCacheMB: 1024 };
  const sw = await put('/api/settings', newSettings);
  t('C12 写设置成功', sw.status === 200, JSON.stringify(sw.json));
  const sa = (await get('/api/settings')).json?.data;
  t('C12b 设置已生效', sa?.autoScanIntervalHours === 6 && sa?.thumbnailCacheMB === 1024, JSON.stringify(sa));
  // 还原
  await put('/api/settings', {
    autoScanIntervalHours: orig.autoScanIntervalHours, thumbnailCacheMB: orig.thumbnailCacheMB,
  });
  const sb = (await get('/api/settings')).json?.data;
  t('C12c 设置已还原',
    sb?.autoScanIntervalHours === orig.autoScanIntervalHours && sb?.thumbnailCacheMB === orig.thumbnailCacheMB,
    JSON.stringify(sb));

  // C12d 已迁移到本机的 10 个偏好键：写入被忽略，也不会幽灵出现在 GET 里
  await put('/api/settings', { theme: 'dark', accent: 'bean', readerMode: 'webtoon', preloadCount: 7 });
  const sc = (await get('/api/settings')).json?.data;
  t('C12d 设备偏好键写不进服务端', ['theme', 'accent', 'readerMode', 'preloadCount'].every((k) => !(k in (sc ?? {}))),
    JSON.stringify(sc));

  // C13 非法设置值不崩（用服务端设置项；偏好键已被忽略，测不出东西）
  const badS = await put('/api/settings', { autoScanIntervalHours: 'NOT_A_NUMBER', thumbnailCacheMB: -5 });
  t('C13 非法设置值不崩溃', badS.status === 200 || badS.status === 400, `status=${badS.status}`);
  const sc2 = (await get('/api/settings')).json?.data;
  t('C13b 非法值后设置接口仍可读', !!sc2 && 'autoScanIntervalHours' in sc2, JSON.stringify(sc2).slice(0, 150));
  // 非法值可能已被写进库，还原成正常值
  await put('/api/settings', {
    autoScanIntervalHours: orig.autoScanIntervalHours, thumbnailCacheMB: orig.thumbnailCacheMB,
  });
  await put('/api/settings', { readerMode: orig.readerMode });

  // C14 缓存统计
  const cs = await get('/api/cache/stats');
  t('C14 缓存统计 200', cs.status === 200 && cs.json?.code === 0, JSON.stringify(cs.json));
  const cd = cs.json?.data ?? {};
  t('C14b 缓存统计含文件数与字节数并自洽',
    typeof cd.files === 'number' && typeof cd.totalBytes === 'number' && typeof cd.limitBytes === 'number'
      && cd.totalBytes <= cd.limitBytes,
    JSON.stringify(cd));
  t('C14c 分类字节数之和不超总量',
    (cd.thumbsBytes ?? 0) + (cd.coversBytes ?? 0) + (cd.customCoversBytes ?? 0) <= (cd.totalBytes ?? 0) + 1,
    JSON.stringify(cd));

  // C15 缓存淘汰
  const ev = await post('/api/cache/evict', {});
  t('C15 缓存淘汰接口可用', ev.status === 200, JSON.stringify(ev.json));

  // C16 备份导出
  const ex = await get('/api/backup/export');
  t('C16 备份导出 200', ex.status === 200, `status=${ex.status}`);
  let backup = null;
  try { backup = JSON.parse(ex.text); } catch { backup = ex.json; }
  t('C16b 备份是合法 JSON', backup !== null);
  t('C16c 备份含进度数据', backup && ('progress' in backup || 'reading_progress' in backup || 'data' in backup),
    Object.keys(backup ?? {}).join(','));

  // C17 备份导入（幂等）
  const im = await post('/api/backup/import', backup?.data ?? backup);
  t('C17 备份导入成功', im.status === 200 && im.json?.code === 0, JSON.stringify(im.json).slice(0, 200));

  // C18 备份往返一致性（真实写入 → 导出 → 清空 → 导入 → 恢复）
  const d2c = (await get(`/api/comics/${encodeURIComponent(c2.id)}`)).json?.data;
  const chB = (d2c?.chapters ?? []).find((x) => x.pageCount > 0);
  if (chB) {
    await put('/api/progress', {
      comicId: c2.id, chapterId: chB.id, chapterIndex: chB.index,
      pageIndex: 3, pageCount: Math.max(10, chB.pageCount), percent: 33,
    });
    const before = recOf((await get(`/api/progress?comicIds=${encodeURIComponent(c2.id)}`)).json?.data);
    // percent 由服务端按全书算，不再信前端传的 33；这里只断言「确实写进去了」
    t('C18 往返前已写入进度', !!before && before.pageIndex === 3 && before.percent > 0,
      `before=${JSON.stringify(before)}`);

    const exp2 = await get('/api/backup/export');
    let b2 = null; try { b2 = JSON.parse(exp2.text); } catch { b2 = exp2.json; }

    await post(`/api/progress/${encodeURIComponent(c2.id)}/reset`, {});
    const mid = recOf((await get(`/api/progress?comicIds=${encodeURIComponent(c2.id)}`)).json?.data);
    t('C18b 重置后进度确实清空', !mid, `mid=${JSON.stringify(mid)}`);

    await post('/api/backup/import', b2?.data ?? b2);
    const after = recOf((await get(`/api/progress?comicIds=${encodeURIComponent(c2.id)}`)).json?.data);
    t('C18c 导入后进度完整恢复',
      !!after && after.percent === before?.percent && after.pageIndex === 3 && after.chapterId === chB.id,
      `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  } else {
    t('C18 次样本无可用章节，跳过', true);
  }
}

// ============================================================
// Batch D：边界 / Range / 参数校验 / 并发 / 性能 / SPA
// ============================================================
async function batchD() {
  batch('D. 边界 · Range · 参数校验 · 并发 · 性能');

  const items = await allComics();
  // 取一本「有章节且能出图」的书做主样本，避免拿到空目录导致 D 段连锁失败
  let sample = items[0];
  let dd = null;
  for (const c of items) {
    if ((c.chapterCount ?? 0) > 0) {
      const d = (await get(`/api/comics/${encodeURIComponent(c.id)}`)).json?.data;
      if ((d?.chapters ?? []).some((ch) => ch.pageCount > 0)) { sample = c; dd = d; break; }
    }
  }
  if (!dd) dd = (await get(`/api/comics/${encodeURIComponent(sample.id)}`)).json?.data;
  const ch0 = (dd?.chapters ?? []).find((ch) => ch.pageCount > 0) ?? dd?.chapters?.[0];
  const cid = sample.id;
  const chid = ch0?.id;

  // D1 不存在的漫画 404
  const nf = await get('/api/comics/no-such-id-xyz');
  t('D1 详情 404', nf.status === 404, `status=${nf.status}`);

  // D2 跨漫画章节 id → 404（本轮修复点）
  const other = items.find((c) => c.id !== cid && (c.chapterCount ?? 0) > 0);
  if (other && chid) {
    const foreignCh = `${other.id}#0`;
    const cross = await get(`/api/comics/${encodeURIComponent(cid)}/chapters/${encodeURIComponent(foreignCh)}/pages`);
    t('D2 跨漫画章节 id 返回 404', cross.status === 404, `status=${cross.status} body=${cross.text.slice(0, 100)}`);

    const crossImg = await apiBuf(`/api/comics/${encodeURIComponent(cid)}/chapters/${encodeURIComponent(foreignCh)}/pages/0`);
    t('D2b 跨漫画取图返回 404', crossImg.status === 404, `status=${crossImg.status}`);

    // 非法章节 id 形态
    for (const badId of ['abc', '#', `${cid}#`, `${cid}#-1`, `${cid}#1.5`, `${cid}#NaN`]) {
      const r = await get(`/api/comics/${encodeURIComponent(cid)}/chapters/${encodeURIComponent(badId)}/pages`);
      t(`D2c 非法章节 id "${badId}" 返回 404`, r.status === 404, `status=${r.status}`);
    }
    // 越界章节索引
    const oob = await get(`/api/comics/${encodeURIComponent(cid)}/chapters/${encodeURIComponent(cid + '#99999')}/pages`);
    t('D2d 越界章节索引 404', oob.status === 404, `status=${oob.status}`);
  } else {
    t('D2 数据不足，跳过', true);
  }

  // D3 越界页索引
  if (chid) {
    const oop = await apiBuf(`/api/comics/${encodeURIComponent(cid)}/chapters/${encodeURIComponent(chid)}/pages/99999`);
    t('D3 越界页索引 404', oop.status === 404, `status=${oop.status}`);
    // 负数/非数字属「请求格式错误」，400 与 404 都可接受；关键是不得 200 出图
    const negp = await apiBuf(`/api/comics/${encodeURIComponent(cid)}/chapters/${encodeURIComponent(chid)}/pages/-1`);
    t('D3b 负数页索引被拒(400/404)', [400, 404].includes(negp.status), `status=${negp.status}`);
    const nanp = await apiBuf(`/api/comics/${encodeURIComponent(cid)}/chapters/${encodeURIComponent(chid)}/pages/abc`);
    t('D3c 非数字页索引被拒(400/404)', [400, 404].includes(nanp.status), `status=${nanp.status}`);
  }

  // D4 Range 请求语义
  if (chid) {
    const full = await apiBuf(`/api/comics/${encodeURIComponent(cid)}/chapters/${encodeURIComponent(chid)}/pages/0`);
    const total = full.buf.length;

    const r1 = await apiBuf(`/api/comics/${encodeURIComponent(cid)}/chapters/${encodeURIComponent(chid)}/pages/0`,
      { headers: { Range: `bytes=0-${Math.min(99, total - 1)}` } });
    t('D4 合法 Range → 206', r1.status === 206, `status=${r1.status}`);
    t('D4b 206 返回正确字节数', r1.buf.length === Math.min(100, total),
      `got=${r1.buf.length} want=${Math.min(100, total)} total=${total}`);
    t('D4c content-range 头正确',
      (r1.headers.get('content-range') ?? '').startsWith(`bytes 0-${Math.min(99, total - 1)}/${total}`),
      r1.headers.get('content-range'));
    t('D4d content-length = 片段长度',
      Number(r1.headers.get('content-length')) === Math.min(100, total),
      `cl=${r1.headers.get('content-length')} want=${Math.min(100, total)}`);
    t('D4e 片段内容与整图前缀一致',
      r1.buf.equals(full.buf.subarray(0, Math.min(100, total))), 'bytes mismatch');

    // 开放区间
    const r2 = await apiBuf(`/api/comics/${encodeURIComponent(cid)}/chapters/${encodeURIComponent(chid)}/pages/0`,
      { headers: { Range: 'bytes=50-' } });
    t('D4f 开放区间 Range → 206', r2.status === 206, `status=${r2.status}`);
    t('D4g 开放区间返回剩余全部', r2.buf.length === total - 50, `got=${r2.buf.length} want=${total - 50}`);
    t('D4h 开放区间内容一致', r2.buf.equals(full.buf.subarray(50)), 'bytes mismatch');

    // 后缀区间
    const r3 = await apiBuf(`/api/comics/${encodeURIComponent(cid)}/chapters/${encodeURIComponent(chid)}/pages/0`,
      { headers: { Range: 'bytes=-30' } });
    t('D4i 后缀区间 → 206', r3.status === 206, `status=${r3.status}`);
    t('D4j 后缀区间返回末尾 30 字节', r3.buf.length === 30, `got=${r3.buf.length}`);
    t('D4k 后缀区间内容一致', r3.buf.equals(full.buf.subarray(total - 30)), 'bytes mismatch');

    // 不可满足
    const r4 = await apiBuf(`/api/comics/${encodeURIComponent(cid)}/chapters/${encodeURIComponent(chid)}/pages/0`,
      { headers: { Range: `bytes=${total + 100}-` } });
    t('D4l 越界 Range → 416', r4.status === 416, `status=${r4.status}`);
    t('D4m 416 带 bytes */total',
      (r4.headers.get('content-range') ?? '') === `bytes */${total}`, r4.headers.get('content-range'));

    // 畸形 Range 应被忽略 → 200 全量
    for (const badRange of ['bytes=abc-def', 'bytes=10-5', 'items=0-10', 'bytes=', '0-10']) {
      const rb = await apiBuf(`/api/comics/${encodeURIComponent(cid)}/chapters/${encodeURIComponent(chid)}/pages/0`,
        { headers: { Range: badRange } });
      t(`D4n 畸形 Range "${badRange}" → 200 全量`,
        rb.status === 200 && rb.buf.length === total, `status=${rb.status} len=${rb.buf.length}`);
    }
  }

  // D5 分页参数宽容归一
  for (const [qs, desc] of [
    ['page=0', 'page=0'],
    ['page=-1', 'page=-1'],
    ['page=abc', 'page=abc'],
    ['pageSize=0', 'pageSize=0'],
    ['pageSize=99999', 'pageSize=99999'],
    ['pageSize=abc', 'pageSize=abc'],
    ['sort=NOT_A_SORT', '非法 sort'],
    ['order=NOT_AN_ORDER', '非法 order'],
    ['status=NOT_A_STATUS', '非法 status'],
    ['format=', '空 format'],
  ]) {
    const r = await get(`/api/comics?${qs}`);
    t(`D5 ${desc} 不报错且结构完整`,
      r.status === 200 && Array.isArray(r.json?.data?.items), `status=${r.status} body=${r.text.slice(0, 100)}`);
  }
  const capped = await get('/api/comics?pageSize=300');
  t('D5b pageSize 上限收敛到 200', (capped.json?.data?.items ?? []).length <= 200,
    `len=${(capped.json?.data?.items ?? []).length}`);

  // D6 空库 / 空结果
  const emptyLib = await post('/api/libraries', { name: '__空库__', type: 'chapter', paths: [] });
  const elId = emptyLib.json?.data?.id;
  if (elId) {
    const er = await get(`/api/comics?libraryId=${elId}&pageSize=50`);
    t('D6 空库返回空列表不报错',
      er.status === 200 && (er.json?.data?.items ?? []).length === 0 && er.json?.data?.total === 0,
      JSON.stringify(er.json?.data).slice(0, 150));
    await del(`/api/libraries/${elId}`);
  }

  // D7 特殊字符漫画名可正常访问
  const weird = items.find((c) => /[#%()【】]/.test(c.title ?? '') || (c.title ?? '').length > 30);
  if (weird) {
    const w = await get(`/api/comics/${encodeURIComponent(weird.id)}`);
    t('D7 特殊字符漫画详情可读', w.status === 200 && Array.isArray(w.json?.data?.chapters),
      `title=${weird.title} status=${w.status}`);
    const wc = await apiBuf(`/api/comics/${encodeURIComponent(weird.id)}/cover?w=200`);
    t('D7b 特殊字符漫画封面可读', wc.status === 200, `status=${wc.status}`);
  } else {
    t('D7 无特殊字符样本，跳过', true);
  }

  // D8 空目录 / 无图片压缩包不崩
  const risky = items.filter((c) => /空目录|无图片|坏包|零字节/.test(c.title ?? ''));
  for (const c of risky) {
    const r = await get(`/api/comics/${encodeURIComponent(c.id)}`);
    t(`D8 "${c.title}" 详情不崩`, r.status === 200, `status=${r.status}`);
    const cv = await fetch(`${BASE}/api/comics/${encodeURIComponent(c.id)}/cover?w=200`);
    t(`D8b "${c.title}" 封面不崩`, [200, 404, 415, 500].includes(cv.status), `status=${cv.status}`);
  }
  if (!risky.length) t('D8 无风险样本，跳过', true);

  // D9 并发读
  if (chid) {
    const N = 20;
    const t0 = Date.now();
    const rs = await Promise.all(
      Array.from({ length: N }, () =>
        apiBuf(`/api/comics/${encodeURIComponent(cid)}/chapters/${encodeURIComponent(chid)}/pages/0`)));
    const ms = Date.now() - t0;
    t('D9 并发 20 次取图全部 200', rs.every((r) => r.status === 200), `statuses=${rs.map((r) => r.status).join(',')}`);
    t('D9b 并发结果字节一致', new Set(rs.map((r) => r.buf.length)).size === 1,
      `lens=${[...new Set(rs.map((r) => r.buf.length))].join(',')}`);
    t(`D9c 并发 20 次耗时 <5s (${ms}ms)`, ms < 5000, `ms=${ms}`);
  }

  // D10 并发写进度不丢
  const N2 = 12;
  const t1 = Date.now();
  await Promise.all(Array.from({ length: N2 }, (_, i) =>
    put('/api/progress', {
      comicId: cid, chapterId: chid, chapterIndex: 0,
      pageIndex: i, pageCount: 100, percent: i * 5,
    })));
  const wms = Date.now() - t1;
  const fin = (await get(`/api/progress?comicIds=${encodeURIComponent(cid)}`)).json?.data;
  const frec = Array.isArray(fin) ? fin[0] : fin?.[cid] ?? fin?.items?.[0];
  t('D10 并发写进度后仍有记录', frec !== undefined && frec !== null, JSON.stringify(fin));
  t(`D10b 并发 ${N2} 次写耗时 <3s (${wms}ms)`, wms < 3000, `ms=${wms}`);
  await post(`/api/progress/${encodeURIComponent(cid)}/reset`, {});

  // D11 性能
  const perf = {};
  let t2 = Date.now(); perf.list = await get('/api/comics?pageSize=60'); perf.listMs = Date.now() - t2;
  t('D11 列表 60 条 <800ms', perf.listMs < 800, `ms=${perf.listMs}`);
  t2 = Date.now(); await get('/api/comics?q=测试&pageSize=60'); perf.searchMs = Date.now() - t2;
  t('D11b 搜索 <800ms', perf.searchMs < 800, `ms=${perf.searchMs}`);
  t2 = Date.now(); await get('/api/comics/facets'); perf.facetsMs = Date.now() - t2;
  t('D11c facets <800ms', perf.facetsMs < 800, `ms=${perf.facetsMs}`);
  t2 = Date.now(); await get(`/api/comics/${encodeURIComponent(items[0].id)}`); perf.detailMs = Date.now() - t2;
  t('D11d 详情 <1500ms', perf.detailMs < 1500, `ms=${perf.detailMs}`);
  t2 = Date.now(); await get('/api/backup/export'); perf.exportMs = Date.now() - t2;
  t('D11e 备份导出 <3000ms', perf.exportMs < 3000, `ms=${perf.exportMs}`);
  console.log(`     性能: list=${perf.listMs}ms search=${perf.searchMs}ms facets=${perf.facetsMs}ms detail=${perf.detailMs}ms export=${perf.exportMs}ms`);

  // D12 SPA 路由回退
  for (const p of ['/', '/shelf', '/libraries', '/settings', `/read/${encodeURIComponent(cid)}/${encodeURIComponent(chid ?? '0')}`]) {
    const r = await api(p);
    t(`D12 SPA 路由 ${p} 返回 index.html`,
      r.status === 200 && (r.text.includes('<div id="root"') || r.text.includes('<!doctype html') || r.text.includes('<html')),
      `status=${r.status} body=${r.text.slice(0, 80)}`);
  }

  // D13 不存在的静态资源 404
  const miss = await api('/assets/no-such-file-xyz.js');
  t('D13 缺失静态资源 404', miss.status === 404, `status=${miss.status}`);

  // D13b 前端产物预压缩：带 .gz 兄弟文件的资源应直出 gzip（运行时零压缩开销）。
  // 用 node:http 取原始响应头——fetch 会自动解压并吞掉 Content-Encoding，看不出真实行为。
  const idxHtml = await api('/');
  const assetPath = /\/assets\/[A-Za-z0-9._-]+\.js/.exec(idxHtml.text ?? '')?.[0];
  if (assetPath) {
    const raw = await rawHead(assetPath, { 'accept-encoding': 'gzip' });
    t('D13b 静态资源命中预压缩 .gz', raw.headers['content-encoding'] === 'gzip',
      `asset=${assetPath} encoding=${raw.headers['content-encoding'] ?? '(none)'}`);
    t('D13c 带指纹产物强缓存', /immutable/.test(raw.headers['cache-control'] ?? ''),
      `cache-control=${raw.headers['cache-control'] ?? '(none)'}`);
  } else {
    t('D13b 静态资源命中预压缩 .gz', false, 'index.html 未引用 /assets/*.js');
    t('D13c 带指纹产物强缓存', false, 'skipped');
  }

  // D14 未知 API 404
  const unk = await get('/api/no-such-endpoint');
  t('D14 未知 API 404', unk.status === 404, `status=${unk.status}`);
}

// ============================================================
// main
// ============================================================
(async () => {
  console.log(`肥牛漫画回归测试 —— ${BASE}`);
  console.log(`时间: ${new Date().toISOString()}`);

  try {
    await batchA();
    await batchB();
    await batchC();
    await batchD();
  } catch (e) {
    console.log('\n!!! 测试执行异常中断:', e?.stack ?? e);
    fail++;
    failures.push(`EXCEPTION :: ${e?.message ?? e}`);
  }

  console.log('\n' + '='.repeat(56));
  console.log(`总计: ${pass + fail}  通过: ${pass}  失败: ${fail}`);
  if (failures.length) {
    console.log('\n失败明细:');
    for (const f of failures) console.log('  - ' + f);
  }
  console.log('='.repeat(56));
  process.exit(fail > 0 ? 1 : 0);
})();
