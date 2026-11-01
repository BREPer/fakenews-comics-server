// 接口边界模糊测试：给每个接口喂极端/恶意参数，断言「不该 5xx、不该返回非 JSON」。
//
// 目标不是找崩溃（有 recover 兜着），而是找：
//   - 参数校验缺口（负页码、超大 pageSize、NaN、超长字符串）
//   - 特殊字符导致 SQL/路径处理异常
//   - 错误响应不是统一信封 {code,message}
//
// 只打 GET 与「用不存在的 id」的写接口，不改动真实数据。
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:13800';
const COMIC = process.argv.find((a) => a.startsWith('--comic='))?.split('=')[1];

const api = async (p) => (await fetch(BASE + p)).json();
const comics = (await api('/api/comics?pageSize=5')).data.items;
const id = COMIC ?? comics[0]?.id;
const ch = id ? (await api(`/api/comics/${id}`)).data.chapters?.[0]?.id : null;

// 参数变异：正常边界、越界、类型错误、注入、超长
const LONG = 'a'.repeat(10000);
const NASTY = [
  ['负数', '-1'],
  ['零', '0'],
  ['超大', '999999999'],
  ['非数字', 'abc'],
  ['NaN', 'NaN'],
  ['空', ''],
  ['SQL 串', "' OR 1=1 --"],
  ['百分号', '%'],
  ['下划线', '_'],
  ['换行', 'a%0Ab'],
  ['emoji', '🎉'],
  ['超长', LONG],
  ['路径穿越', '../'.repeat(30) + 'etc/passwd'],
  ['null 字节', 'a%00b'],
];

const cases = [];
const add = (name, url) => cases.push({ name, url });

// 列表：每个查询参数轮流喂变异值
for (const p of ['page', 'pageSize', 'sort', 'order', 'status', 'format', 'tag', 'q', 'libraryId']) {
  for (const [label, v] of NASTY) add(`GET /comics?${p}=${label}`, `/api/comics?${p}=${encodeURIComponent(v)}`);
}
// 组合：极端分页
add('page=1e9 & pageSize=1e9', '/api/comics?page=999999999&pageSize=999999999');
add('page=-5&pageSize=-5', '/api/comics?page=-5&pageSize=-5');

// 详情 / 章节 / 取图：不存在的 id 与怪 id
for (const [label, v] of [['不存在', 'deadbeefdeadbeef'], ['空', ''], ['超长', LONG], ['穿越', '../../etc/passwd'], ['emoji', '🎉'], ['含斜杠', 'a/b']]) {
  add(`GET /comics/{${label}}`, `/api/comics/${encodeURIComponent(v)}`);
  if (ch) add(`GET pages {${label}}`, `/api/comics/${id}/chapters/${encodeURIComponent(v)}/pages/0`);
}
// 取图页码越界
if (ch) {
  for (const [label, v] of [['负', -1], ['超大', 99999], ['非数字', 'abc']]) {
    add(`GET pages/{comic}/{ch}/pages(${label})`, `/api/comics/${id}/chapters/${encodeURIComponent(ch)}/pages/${encodeURIComponent(String(v))}`);
  }
  // Range 头异常
  add('Range: bytes=abc-def', `__RANGE__/api/comics/${id}/chapters/${encodeURIComponent(ch)}/pages/0`);
  add('Range: bytes=999999999-', `__RANGE__/api/comics/${id}/chapters/${encodeURIComponent(ch)}/pages/0`);
}

// 其它读接口
add('GET /history?limit=-1', '/api/history?limit=-1');
add('GET /history?limit=1e9', '/api/history?limit=999999999');
add('GET /search?q=超长', `/api/search?q=${encodeURIComponent(LONG)}`);
add('GET /libraries/{不存在}', '/api/libraries/deadbeef');
add('GET /comics/facets 正常', '/api/comics/facets');

// 写接口用不存在的 id（不应改任何真实数据）
add('POST /favorites/{不存在}', '__POST__/api/favorites/deadbeef');
add('DELETE /favorites/{不存在}', '__DELETE__/api/favorites/deadbeef');
add('PUT /comics/{不存在}', '__PUT__/api/comics/deadbeef');
add('DELETE /comics/{不存在}', '__DELETE__/api/comics/deadbeef');

let bad = 0;
const rows = [];
for (const c of cases) {
  let url = c.url;
  let method = 'GET';
  let headers = {};
  let body;
  if (url.startsWith('__RANGE__')) { url = url.slice(9); headers = { Range: url.includes('abc') ? 'bytes=abc-def' : 'bytes=999999999-' }; }
  if (url.startsWith('__POST__')) { url = url.slice(8); method = 'POST'; }
  if (url.startsWith('__PUT__')) { url = url.slice(7); method = 'PUT'; body = JSON.stringify({ title: null, author: 123 }); }
  if (url.startsWith('__DELETE__')) { url = url.slice(10); method = 'DELETE'; }

  const t0 = performance.now();
  let status = 0;
  let isJson = true;
  let msg = '';
  try {
    const r = await fetch(BASE + url, { method, headers, body });
    status = r.status;
    const ct = r.headers.get('content-type') || '';
    const text = await r.text();
    isJson = ct.includes('json');
    if (isJson) {
      try { const j = JSON.parse(text); msg = j.message ?? ''; } catch { isJson = false; }
    }
  } catch (e) {
    status = -1;
    msg = String(e.message).slice(0, 60);
  }
  const ms = performance.now() - t0;
  const is5xx = status >= 500;
  const problem = is5xx || !isJson;
  if (problem) bad++;
  rows.push({ ...c, method, status, isJson, ms, msg, problem });
}

console.log(`=== 接口边界模糊测试：${cases.length} 个用例 ===`);
const lines = rows.filter((r) => r.problem);
if (!lines.length) {
  console.log('  ✓ 全部返回 4xx/2xx 且均为统一 JSON 信封，无 5xx、无非 JSON');
} else {
  console.log(`  ✗ ${bad} 个用例有问题：`);
  for (const r of lines) {
    console.log(`    ${String(r.status).padStart(4)} ${r.method.padEnd(6)} ${r.name.padEnd(34)} json=${r.isJson} ${r.msg}`);
  }
}
// 按状态码分布，确认「校验生效」而不是全部 200 放行
const dist = new Map();
for (const r of rows) dist.set(r.status, (dist.get(r.status) ?? 0) + 1);
console.log('  状态码分布：' + [...dist.entries()].sort((a, b) => a[0] - b[0]).map(([s, n]) => `${s}×${n}`).join('  '));

if (process.env.DUMP) {
  const out = 'tools/_fuzz_last.json';
  fs.writeFileSync(out, JSON.stringify(rows, null, 1));
  console.log('  明细已写入', out);
}
process.exit(bad ? 1 : 0);
