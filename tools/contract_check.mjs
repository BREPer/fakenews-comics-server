/**
 * 前后端契约漂移检查（A3）
 *
 * 为什么不是「从 Go struct 生成 TS」：
 *   Go 后端的响应体是 `map[string]any` 字面量（见 internal/routes/*.go），没有带 json tag 的
 *   结构体可供反射/AST 推导。硬造一层 DTO 只为了生成类型，等于把契约写两遍。
 *   所以这里反过来：**打真实接口，把响应里出现的键与 `src/types/index.ts` 的声明逐键比对**。
 *   它校验的是「服务端实际吐出的形状」，比校验「服务端打算吐出的形状」更接近用户看到的东西。
 *
 * 检查内容：
 *   1. 响应里出现、TS 里没声明的键 → drift（错误，退出码 1）；
 *   2. TS 里声明为非可选、响应里却没有的键 → 提示（警告，不失败；空数据/聚合字段可能合法缺省）。
 *
 * 用法：
 *   node tools/contract_check.mjs                 # 打 http://127.0.0.1:13800
 *   API_BASE=http://host:port node tools/contract_check.mjs
 *   需要鉴权时：API_COOKIE='fc_session=...' 或 API_TOKEN='...' 传入
 *
 * 前置：有一个跑起来且已扫描出漫画的实例（dev.sh 起的开发实例即可）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WEB = path.join(ROOT, 'app', 'web');
const TYPES = path.join(WEB, 'src', 'types', 'index.ts');
const BASE = (process.env.API_BASE || 'http://127.0.0.1:13800').replace(/\/$/, '');

/* ---------------- 1. 解析 TS 接口声明 ---------------- */

const require2 = createRequire(path.join(WEB, 'package.json'));
const ts = require2('typescript');

function readInterfaces(file) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const raw = new Map(); // name -> { own: {name, optional}[], bases: string[] }

  for (const node of sf.statements) {
    if (!ts.isInterfaceDeclaration(node)) continue;
    const own = [];
    for (const m of node.members) {
      if (!ts.isPropertySignature(m) || !m.name) continue;
      const name = m.name.getText(sf).replace(/^['"]|['"]$/g, '');
      own.push({ name, optional: !!m.questionToken });
    }
    const bases = (node.heritageClauses ?? [])
      .flatMap((h) => h.types.map((t) => t.expression.getText(sf)));
    raw.set(node.name.text, { own, bases });
  }

  // 摊平继承（ComicDetail extends Comic）
  const resolved = new Map();
  const resolveOne = (name, seen = new Set()) => {
    if (resolved.has(name)) return resolved.get(name);
    const def = raw.get(name);
    if (!def) return null;
    if (seen.has(name)) return { fields: new Map() };
    seen.add(name);
    const fields = new Map();
    for (const b of def.bases) {
      const base = resolveOne(b, seen);
      if (base) for (const [k, v] of base.fields) fields.set(k, v);
    }
    for (const f of def.own) fields.set(f.name, { optional: f.optional, from: name });
    const out = { fields };
    resolved.set(name, out);
    return out;
  };
  for (const name of raw.keys()) resolveOne(name);
  return resolved;
}

/* ---------------- 2. 接口清单 ---------------- */

/** 每个条目：请求路径（ctx 里带已发现的 id）+ 要校验的「路径 → 接口名」 */
const SPECS = [
  { path: () => '/api/comics?pageSize=1', checks: [
    { at: 'data', iface: 'Paged', note: '列表信封' },
    { at: 'data.items[0]', iface: 'Comic' },
  ] },
  { path: (ctx) => `/api/comics/${ctx.comicId}`, checks: [
    { at: 'data', iface: 'ComicDetail' },
    { at: 'data.chapters[0]', iface: 'Chapter' },
    { at: 'data.progress', iface: 'ReadingProgress', skipIfAbsent: true },
  ] },
  { path: (ctx) => `/api/comics/${ctx.comicId}/chapters/${encodeURIComponent(ctx.chapterId)}/pages`, checks: [
    { at: 'data.pages[0]', iface: 'PageMeta' },
  ] },
  { path: () => '/api/libraries', checks: [{ at: 'data.items[0]', iface: 'Library' }] },
  { path: () => '/api/settings', checks: [{ at: 'data', iface: 'Settings' }] },
  { path: () => '/api/about', checks: [{ at: 'data', iface: 'AboutInfo' }] },
  { path: () => '/api/auth/status', checks: [{ at: 'data', iface: 'AuthState' }] },
  { path: () => '/api/cache/stats', checks: [{ at: 'data', iface: 'CacheStats' }] },
  { path: () => '/api/history?pageSize=1', checks: [{ at: 'data.items[0]', iface: 'HistoryItem', skipIfAbsent: true }] },
];

/* ---------------- 3. 取值与比对 ---------------- */

function pick(obj, expr) {
  let cur = obj;
  for (const seg of expr.split('.')) {
    const m = seg.match(/^(\w+)((?:\[\d+\])*)$/);
    if (!m) return undefined;
    cur = cur?.[m[1]];
    for (const idx of m[2].match(/\d+/g) ?? []) cur = cur?.[Number(idx)];
    if (cur === undefined) return undefined;
  }
  return cur;
}

const headers = {};
if (process.env.API_COOKIE) headers.cookie = process.env.API_COOKIE;
if (process.env.API_TOKEN) headers.authorization = `Bearer ${process.env.API_TOKEN}`;

async function getJson(p) {
  const res = await fetch(BASE + p, { headers });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${p} 返回非 JSON（status=${res.status}）：${text.slice(0, 120)}`);
  }
  if (res.status === 401) {
    throw new Error(`${p} 401 未授权：该实例开了登录保护，请用 API_COOKIE='fc_session=...' 传入会话`);
  }
  return { status: res.status, json };
}

const table = readInterfaces(TYPES);
const problems = [];
const warnings = [];
const stats = { checked: 0, fields: 0 };

function compare(label, value, ifaceName) {
  const iface = table.get(ifaceName);
  if (!iface) {
    problems.push(`${label}: TS 里找不到接口 ${ifaceName}`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const known = iface.fields;
  const actualKeys = Object.keys(value);
  const extra = actualKeys.filter((k) => !known.has(k));
  const missing = [...known.entries()]
    .filter(([k, v]) => !v.optional && !(k in value) && !(k === 'total' || k === 'page' || k === 'pageSize'))
    .map(([k]) => k);

  stats.checked++;
  stats.fields += actualKeys.length;

  if (extra.length) problems.push(`${label}（${ifaceName}）服务端多出未声明字段：${extra.join(', ')}`);
  if (missing.length) warnings.push(`${label}（${ifaceName}）声明为非可选但响应缺失：${missing.join(', ')}`);
  console.log(
    `${extra.length || missing.length ? '!' : '✓'} ${label.padEnd(34)} ${ifaceName.padEnd(14)} ${actualKeys.length} 字段` +
      (extra.length ? `  多出 ${extra.join(',')}` : ''),
  );
}

async function main() {
  console.log(`契约检查 → ${BASE}\n接口类型来源：${path.relative(ROOT, TYPES)}\n`);

  const ctx = {};
  // 先拿到 comic/chapter id（后续路径依赖）
  const list = await getJson('/api/comics?pageSize=1');
  ctx.comicId = pick(list.json, 'data.items[0].id');
  if (!ctx.comicId) throw new Error('列表为空：请先用 dev.sh 起实例并扫描出至少一部漫画');
  const detail = await getJson(`/api/comics/${ctx.comicId}`);
  ctx.chapterId = pick(detail.json, 'data.chapters[0].id');
  if (!ctx.chapterId) throw new Error(`漫画 ${ctx.comicId} 没有章节，无法校验 pages 接口`);

  for (const spec of SPECS) {
    const p = spec.path(ctx);
    const { status, json } = await getJson(p);
    if (status >= 400 || json.code !== 0) {
      problems.push(`${p} 返回错误：status=${status} code=${json.code} message=${json.message ?? ''}`);
      continue;
    }
    for (const c of spec.checks) {
      const v = pick(json, c.at);
      if (v === undefined || v === null) {
        if (!c.skipIfAbsent) problems.push(`${p} 缺少 ${c.at}，无法校验 ${c.iface}`);
        continue;
      }
      compare(c.at === 'data' ? p : `${p} ${c.at}`, v, c.iface);
    }
  }

  console.log(`\n共校验 ${stats.checked} 个对象 / ${stats.fields} 个字段。`);
  if (warnings.length) {
    console.log(`\n提示（不失败，通常是聚合字段或空数据）：`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
  if (problems.length) {
    console.log(`\n漂移 ${problems.length} 处：`);
    for (const p of problems) console.log(`  ✗ ${p}`);
    console.log(`\n修法：改 app/web/src/types/index.ts 对齐服务端，或检查服务端是否误改了字段名。`);
    process.exitCode = 1;
    return;
  }
  console.log('\n契约一致：服务端响应字段全部能在 TS 类型里找到。');
}

main().catch((e) => {
  console.error(`\n检查中断：${e.message}`);
  process.exitCode = 2;
});
