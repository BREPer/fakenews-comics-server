/**
 * 章节型库识别黑盒测试（纯 API，无需浏览器）。
 *
 * 用法：先起服务，再 `node tools/chapter_probe.mjs [baseUrl]`
 * 前置：已跑 `python tools/make_chapter_fixtures.py`（生成夹具 + manifest）
 *
 * 断言原则（历史教训：4 个 bug 都是状态码对、内容错）：
 *   - 章数 / 章标题 / 章顺序 / 每章页数
 *   - 每章逐页取原图，校验 PNG 宽度与本夹具的「页宽指纹」一致 → 能发现章串页、页序错、少页多页
 *   - 坏包/空目录等异常态必须是可解释的 4xx 或空列表，不能 500
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { imageMeta } from './lib/image.mjs';

// 零依赖解析封面头，验证「真能解出一张图」而不只是返回 200

const BASE = process.argv[2] || 'http://127.0.0.1:13920';
const MANIFEST = path.join(os.tmpdir(), 'fc-chapter-manifest.json');

let pass = 0;
let fail = 0;
const failures = [];
const t = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name} :: ${detail}`);
    console.log(`  ✗ FAIL ${name} :: ${detail}`);
  }
};

async function req(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}
const get = (p) => req('GET', p);
const post = (p, b) => req('POST', p, b ?? {});
const del = (p) => req('DELETE', p);
const apiBuf = async (p) => {
  const res = await fetch(BASE + p);
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') ?? '' };
};

const enc = encodeURIComponent;
const pngWidth = (buf) => (buf.length > 24 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG'
  ? buf.readUInt32BE(16)
  : null);
const magic = (buf) => {
  if (buf.length > 12 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return 'unknown';
};

async function waitScan() {
  for (let i = 0; i < 300; i++) {
    const s = (await get('/api/scan/status')).json?.data;
    if (s && !s.running) return s;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('扫描超时');
}

async function ensureLibrary(name, type, root) {
  const libs = (await get('/api/libraries')).json?.data?.items ?? [];
  for (const old of libs.filter((l) => l.name === name)) await del(`/api/libraries/${old.id}`);
  const created = await post('/api/libraries', { name, type, paths: [root] });
  const id = created.json?.data?.id;
  if (!id) throw new Error(`建库失败: ${JSON.stringify(created.json)}`);
  await waitScan();
  return id;
}

async function listComics(libraryId) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const r = (await get(`/api/comics?libraryId=${enc(libraryId)}&page=${page}&pageSize=200`)).json?.data;
    out.push(...(r?.items ?? []));
    if (!r?.hasMore) break;
  }
  return out;
}

const byDir = (list, exp) => list.find((c) => c.rawTitle === (exp.rawTitle ?? exp.dir) || c.title === exp.dir);

/** 校验一章：页数 + 逐页取图（宽度指纹） */
async function checkChapter(comicId, ch, exp) {
  const label = `    ${ch.index}.「${ch.title}」`;
  t(`${label} 标题匹配`, ch.title === exp.title, `got=${ch.title} want=${exp.title}`);
  const expectPages = exp.widths.length;
  t(`${label} 页数=${expectPages}`, ch.pageCount === expectPages, `got=${ch.pageCount}`);

  const pagesRes = await get(`/api/comics/${enc(comicId)}/chapters/${enc(ch.id)}/pages`);
  if (exp.broken) {
    t(`${label} 坏包取页为可解释的 4xx（非 500）`, pagesRes.status >= 400 && pagesRes.status < 500,
      `status=${pagesRes.status} body=${pagesRes.text.slice(0, 100)}`);
    return;
  }
  t(`${label} 页清单 200`, pagesRes.status === 200, `status=${pagesRes.status} body=${(pagesRes.text ?? '').slice(0, 160)}`);
  const pages = pagesRes.json?.data?.pages ?? [];
  t(`${label} 页清单长度=${expectPages}`, pages.length === expectPages, `got=${pages.length}`);

  const widths = [];
  for (let i = 0; i < pages.length; i++) {
    const r = await apiBuf(`/api/comics/${enc(comicId)}/chapters/${enc(ch.id)}/pages/${i}?quality=original`);
    if (r.status !== 200) {
      t(`${label} 第${i + 1}页 200`, false, `status=${r.status}`);
      return;
    }
    if (exp.kind === 'pdf') {
      t(`${label} 第${i + 1}页 为光栅化 jpeg`, magic(r.buf) === 'jpeg', `magic=${magic(r.buf)} bytes=${r.buf.length}`);
    } else {
      widths.push(pngWidth(r.buf));
    }
  }
  if (exp.kind !== 'pdf') {
    const got = widths.join(',');
    const want = exp.widths.join(',');
    if (exp.orderSensitive === false) {
      const a = [...widths].sort((x, y) => x - y).join(',');
      const b = [...exp.widths].sort((x, y) => x - y).join(',');
      t(`${label} 页集合与夹具一致`, a === b, `got=${got}`);
    } else {
      t(`${label} 页序与夹具一致（宽度指纹）`, got === want, `got=${got} want=${want}`);
    }
  }
}

try {
  if (!fs.existsSync(MANIFEST)) throw new Error(`缺少 manifest：${MANIFEST}（先跑 make_chapter_fixtures.py）`);
  const M = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

  // ---------- 建库 ----------
  const chapterLib = await ensureLibrary('__章节型测试库__', 'chapter', M.chapterRoot);
  const singleLib = await ensureLibrary('__单篇型测试库__', 'single', M.singleRoot);
  const list = await listComics(chapterLib);
  console.log(`\n章节型库识别到 ${list.length} 部漫画（期望 ${M.comics.length}）`);
  console.log(list.map((c) => `  ${c.title} | ${c.chapterCount}章 | ${c.pageCount}页`).join('\n'));

  console.log('\n=== A. 漫画数量与隐藏项 ===');
  t('漫画数量与夹具一致', list.length === M.comics.length, `got=${list.length} want=${M.comics.length}`);
  t('隐藏目录未成书', !list.some((c) => c.title.startsWith('.') || c.rawTitle.startsWith('.')),
    JSON.stringify(list.map((c) => c.rawTitle)));

  console.log('\n=== B. 逐部逐章核对 ===');
  for (const exp of M.comics) {
    const comic = byDir(list, exp);
    if (!comic) {
      t(`找到漫画「${exp.dir}」`, false, '未识别');
      continue;
    }
    console.log(`\n  ${exp.dir}  (期望 ${exp.chapters.length} 章)`);
    const detail = (await get(`/api/comics/${enc(comic.id)}`)).json?.data;
    const chapters = detail?.chapters ?? [];
    t(`  「${exp.dir}」章数=${exp.chapters.length}`, chapters.length === exp.chapters.length,
      `got=${chapters.length} [${chapters.map((c) => c.title).join(' | ')}]`);
    t(`  「${exp.dir}」chapterCount 字段一致`, detail?.chapterCount === exp.chapters.length, `got=${detail?.chapterCount}`);
    const sumPages = chapters.reduce((n, c) => n + c.pageCount, 0);
    const wantPages = exp.chapters.reduce((n, c) => n + c.widths.length, 0);
    t(`  「${exp.dir}」总页数=${wantPages}`, sumPages === wantPages, `got=${sumPages}`);

    if (exp.chapters.length === 1) {
      await checkChapter(comic.id, chapters[0], exp.chapters[0]);
    } else if (exp.setOnly || exp.dir.includes('怪名') || exp.dir.includes('空章节') || exp.dir.includes('坏包') || exp.dir.includes('包里套包')) {
      // 章序由中文/emoji 排序或异常项决定，只核对「集合」
      const gotTitles = chapters.map((c) => c.title).sort();
      const wantTitles = exp.chapters.map((c) => c.title).sort();
      t(`  「${exp.dir}」章标题集合一致`, JSON.stringify(gotTitles) === JSON.stringify(wantTitles),
        `got=${gotTitles.join(',')} want=${wantTitles.join(',')}`);
      for (const expCh of exp.chapters) {
        const ch = chapters.find((c) => c.title === expCh.title);
        if (!ch) { t(`  「${exp.dir}」含章「${expCh.title}」`, false); continue; }
        await checkChapter(comic.id, ch, expCh);
      }
    } else {
      for (let i = 0; i < exp.chapters.length; i++) {
        await checkChapter(comic.id, chapters[i], exp.chapters[i]);
      }
    }

    // 封面
    const cover = await apiBuf(`/api/comics/${enc(comic.id)}/cover?w=320`);
    let coverMeta = null;
    try { coverMeta = cover.status === 200 ? imageMeta(cover.buf) : null; } catch { coverMeta = null; }
    t(`  「${exp.dir}」封面可解码且尺寸合理`,
      !!coverMeta && ['jpeg', 'webp', 'png'].includes(coverMeta.format) && coverMeta.width > 0 && coverMeta.height > 0 && coverMeta.width <= 320,
      `status=${cover.status} ${coverMeta ? `${coverMeta.format} ${coverMeta.width}x${coverMeta.height}` : 'decode fail'}`);
  }

  // ---------- C. 章 id 的 URL 编码（id 里含 #） ----------
  console.log('\n=== C. 章节 id 编码 ===');
  {
    const comic = byDir(list, { rawTitle: '01 纯子目录', dir: '01 纯子目录' });
    const detail = (await get(`/api/comics/${enc(comic.id)}`)).json?.data;
    const ch = detail.chapters[1];
    t('章 id 形如 <comicId>#<index>', ch.id === `${comic.id}#1`, ch.id);
    const encoded = await get(`/api/comics/${enc(comic.id)}/chapters/${enc(ch.id)}/pages`);
    const raw = await get(`/api/comics/${enc(comic.id)}/chapters/${ch.id}/pages`);
    t('编码后的章 id 可正常取页', encoded.status === 200 && (encoded.json?.data?.pages?.length ?? 0) > 0,
      `status=${encoded.status}`);
    t('未编码的章 id 会被 # 截断（因此前端必须编码）', raw.status === 404 || raw.status === 400,
      `status=${raw.status} body=${raw.text.slice(0, 80)}`);
  }

  // ---------- D. 单篇型库（promote=false）不受影响 ----------
  console.log('\n=== D. 单篇型库对照 ===');
  {
    const single = await listComics(singleLib);
    t('单篇型漫画数=3', single.length === 3, `got=${single.length} [${single.map((c) => c.title).join(',')}]`);
    t('单篇型每本只有 1 章', single.every((c) => c.chapterCount === 1),
      JSON.stringify(single.map((c) => [c.title, c.chapterCount])));
    for (const exp of M.single) {
      const comic = byDir(single, { rawTitle: path.basename(exp.dir), dir: path.basename(exp.dir) });
      if (!comic) { t(`单篇型识别「${exp.dir}」`, false); continue; }
      const detail = (await get(`/api/comics/${enc(comic.id)}`)).json?.data;
      await checkChapter(comic.id, detail.chapters[0], exp.chapters[0]);
    }
  }

  // ---------- E. 重扫稳定性 ----------
  console.log('\n=== E. 重扫稳定性 ===');
  {
    const comic = byDir(list, { rawTitle: '05 全混合', dir: '05 全混合' });
    const before = (await get(`/api/comics/${enc(comic.id)}`)).json?.data;
    const rescan = await post(`/api/comics/${enc(comic.id)}/scan`);
    t('单部重扫 200', rescan.status === 200, `status=${rescan.status} ${rescan.text.slice(0, 80)}`);
    t('重扫后章数不变', rescan.json?.data?.chapterCount === before.chapterCount,
      `before=${before.chapterCount} after=${rescan.json?.data?.chapterCount}`);
    await waitScan();
    const after = (await get(`/api/comics/${enc(comic.id)}`)).json?.data;
    t('重扫后章节结构完全一致',
      JSON.stringify(after.chapters.map((c) => [c.title, c.pageCount])) ===
      JSON.stringify(before.chapters.map((c) => [c.title, c.pageCount])),
      `after=${JSON.stringify(after.chapters.map((c) => [c.title, c.pageCount]))}`);
  }

  // ---------- F. 章目录增删 → 重扫能跟上（缓存失效） ----------
  console.log('\n=== F. 章结构变化 ===');
  {
    const comic = byDir(list, { rawTitle: '02 散图加子目录', dir: '02 散图加子目录' });
    const addedDir = path.join(M.chapterRoot, '02 散图加子目录', '第03卷');
    // 直接复用夹具里的 PNG 做两张新页（宽度 308/309）
    const src1 = path.join(M.chapterRoot, '01 纯子目录', '第01卷', '001.png');
    fs.mkdirSync(addedDir, { recursive: true });
    fs.copyFileSync(src1, path.join(addedDir, '001.png'));
    fs.copyFileSync(src1, path.join(addedDir, '002.png'));

    await post('/api/scan', {});
    await waitScan();
    let d = (await get(`/api/comics/${enc(comic.id)}`)).json?.data;
    t('新增章目录后章数 +1', d.chapters.length === 4, `got=${d.chapters.length} [${d.chapters.map((c) => c.title).join(' | ')}]`);
    const added = d.chapters.find((c) => c.title === '第03卷');
    t('新增章可读（页数=2）', !!added && added.pageCount === 2, `pageCount=${added?.pageCount}`);

    fs.rmSync(addedDir, { recursive: true, force: true });
    await post('/api/scan', {});
    await waitScan();
    d = (await get(`/api/comics/${enc(comic.id)}`)).json?.data;
    t('删除章目录后章数回到 3', d.chapters.length === 3, `got=${d.chapters.length}`);
  }
} catch (err) {
  fail++;
  failures.push(`异常中断：${err instanceof Error ? err.message : String(err)}`);
  console.error('\n异常:', err);
}

console.log(`\n${'='.repeat(46)}`);
console.log(`总计 ${pass + fail}  通过 ${pass}  失败 ${fail}`);
if (failures.length) {
  console.log('失败明细:');
  for (const f of failures) console.log('  -', f);
}
process.exit(fail ? 1 : 0);
