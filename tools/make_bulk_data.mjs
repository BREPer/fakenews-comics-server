/**
 * 批量假数据：造 N 本漫画（默认 500）+ 给其中 M 本造阅读记录（默认 100）。
 *
 * 用途：验证「库里有大量漫画」时的列表分页 / 筛选 / 首页聚合 / 进度聚合表现，
 * 以及书架、历史、卡片状态的各种组合（在读 / 已读完 / 未开始）。
 *
 * 数据落在**独立库**（默认 %TEMP%/fc-bulk-500），不污染现有库：
 *   <root>/<书名>/第01卷/001.png ...   ← chapter 型库：一层漫画、二层章
 *
 * 阅读记录走真实 API（PUT /api/progress）：
 *   - 不传 percent，让服务端按全书累计（章内页数 / 全书页数）
 *   - 约 10% 的书标记为「读完最后一章」，用于验证 finished 角标
 *
 * 用法：
 *   node tools/make_bulk_data.mjs                     # 500 本 + 100 条记录
 *   node tools/make_bulk_data.mjs --comics 50 --records 20
 *   node tools/make_bulk_data.mjs --clean             # 只删除这批数据
 *   node tools/make_bulk_data.mjs --keep              # 保留已有目录，只补进度
 *
 * 注意：--comics 与 --chapters/--pages 会显著影响扫描耗时（每本 = 章数×页数 张图）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const FLAG = (n) => process.argv.includes(`--${n}`);

const API = (ARG('api', process.env.API_BASE || 'http://127.0.0.1:13800')).replace(/\/$/, '');
const N_COMICS = Number(ARG('comics', '500'));
const N_RECORDS = Number(ARG('records', '100'));
const CHAPTERS = Number(ARG('chapters', '2'));
const PAGES = Number(ARG('pages', '4'));
const W = Number(ARG('w', '300'));
const H = Number(ARG('h', '420'));
const LIB_NAME = ARG('name', `压力测试（${N_COMICS}）`);
const ROOT = ARG('dir', path.join(os.tmpdir(), 'fc-bulk-500'));
const KEEP = FLAG('keep');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p, init) => {
  const r = await fetch(API + p, init);
  const text = await r.text();
  try {
    return { status: r.status, json: JSON.parse(text) };
  } catch {
    return { status: r.status, text };
  }
};
const putJson = (p, body, method = 'PUT') =>
  j(p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/* ---------------- 书名：词库组合，避免 500 本看起来一样 ---------------- */
const PRE = ['星海', '银河', '深渊', '幻境', '荒野', '孤岛', '极夜', '白塔', '迷雾', '机械',
  '樱花', '铁血', '幽兰', '赤焰', '苍狼', '雨夜', '夏日', '冬雪', '风之', '月下'];
const POST = ['旅人', '传说', '少女', '骑士', '日记', '回声', '之城', '契约', '歌谣', '尽头',
  '信使', '花园', '边境', '序曲', '遗书', '猎手', '灯塔', '图书馆', '列车', '面具'];
function bookTitle(i) {
  const a = PRE[i % PRE.length];
  const b = POST[Math.floor(i / PRE.length) % POST.length];
  const round = Math.floor(i / (PRE.length * POST.length)); // 第几轮（>0 时加序号后缀）
  return round === 0 ? `${a}${b}` : `${a}${b} ${String(round + 1).padStart(2, '0')}`;
}

/** 每本书一个主色调，页面用「主色 → 副色」斜向渐变 + 细条纹，肉眼能分辨不同书 */
function painterFor(seed) {
  const h1 = (seed * 47) % 360;
  const h2 = (h1 + 40 + (seed % 7) * 12) % 360;
  const css = (h, s, l) => {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const seg = [
      [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
    ][Math.floor(h / 60) % 6];
    return seg.map((v) => Math.round((v + m) * 255));
  };
  const A = css(h1, 0.45, 0.62);
  const B = css(h2, 0.5, 0.4);
  return (x, y) => {
    const t = (x / W + y / H) / 2;
    const band = Math.floor(x / 6) % 2 === 0 ? 1 : 0.94;
    return [
      Math.round((A[0] + (B[0] - A[0]) * t) * band),
      Math.round((A[1] + (B[1] - A[1]) * t) * band),
      Math.round((A[2] + (B[2] - A[2]) * t) * band),
    ];
  };
}

/* ---------------- 1. 生成目录与图片 ---------------- */
function generate() {
  if (fs.existsSync(ROOT) && !KEEP) {
    console.log(`清空旧目录 ${ROOT} …`);
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
  fs.mkdirSync(ROOT, { recursive: true });

  const t0 = Date.now();
  let files = 0;
  for (let i = 0; i < N_COMICS; i++) {
    const book = path.join(ROOT, bookTitle(i));
    if (KEEP && fs.existsSync(book)) continue;
    for (let c = 1; c <= CHAPTERS; c++) {
      const dir = path.join(book, `第${String(c).padStart(2, '0')}卷`);
      fs.mkdirSync(dir, { recursive: true });
      for (let p = 1; p <= PAGES; p++) {
        const file = path.join(dir, `${String(p).padStart(3, '0')}.png`);
        if (KEEP && fs.existsSync(file)) continue;
        writePng(file, W, H, painterFor(i * 31 + c * 7 + p));
        files++;
      }
    }
    if ((i + 1) % 100 === 0) console.log(`  已生成 ${i + 1}/${N_COMICS} 本（${files} 张图）`);
  }
  const bytes = (() => {
    let total = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else total += fs.statSync(full).size;
      }
    };
    walk(ROOT);
    return total;
  })();
  console.log(`图片生成完成：${files} 张 / ${(bytes / 1024 / 1024).toFixed(1)} MB / ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

/* ---------------- 2. 建库 + 扫描 ---------------- */
async function ensureLibraryAndScan() {
  const libs = (await j('/api/libraries')).json?.data?.items ?? [];
  let lib = libs.find((l) => l.name === LIB_NAME);
  if (!lib) {
    const r = await putJson('/api/libraries', { name: LIB_NAME, type: 'chapter', paths: [ROOT] }, 'POST');
    if (r.json?.code !== 0) throw new Error(`建库失败：${JSON.stringify(r.json ?? r.text)}`);
    lib = { id: r.json.data.id };
    console.log(`已建库「${LIB_NAME}」→ ${ROOT}`);
  } else {
    lib = libs.find((l) => l.name === LIB_NAME);
    console.log(`复用已有库「${LIB_NAME}」（${lib.comicCount ?? '?'} 本）`);
  }

  console.log('触发扫描（只扫这一个库，不动现有库）…');
  const t0 = Date.now();
  await putJson('/api/scan', { libraryId: lib.id }, 'POST');
  for (let i = 0; i < 600; i++) {
    await sleep(1000);
    const st = (await j('/api/scan/status')).json?.data;
    if (!st?.running) {
      console.log(`扫描完成：${st?.scanned ?? '?'} 本 / ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      break;
    }
    if (i % 5 === 0) console.log(`  扫描中… ${st.scanned ?? 0}/${st.total ?? '?'}`);
  }
  return lib;
}

/* ---------------- 3. 造阅读记录 ---------------- */
async function seedRecords(lib) {
  if (N_RECORDS <= 0) return;
  // 只取这个库里的漫画（避免把现有库的书也写上进度）
  const all = [];
  for (let page = 1; page <= 20 && all.length < N_COMICS + 200; page++) {
    const r = await j(`/api/comics?libraryId=${encodeURIComponent(lib.id)}&page=${page}&pageSize=100`);
    const items = r.json?.data?.items ?? [];
    all.push(...items);
    if (items.length < 100) break;
  }
  console.log(`库里取到 ${all.length} 本漫画，准备给其中 ${Math.min(N_RECORDS, all.length)} 本写进度`);

  const targets = all.slice(0, Math.min(N_RECORDS, all.length));
  let done = 0;
  let finished = 0;
  for (let i = 0; i < targets.length; i++) {
    const comic = targets[i];
    const detail = (await j(`/api/comics/${encodeURIComponent(comic.id)}`)).json?.data;
    const chapters = detail?.chapters ?? [];
    if (!chapters.length) continue;
    // 进度分布：0~100% 均匀铺开；每 10 本里有 1 本读到最后（finished 角标）
    const readAll = i % 10 === 9;
    const chapterIndex = readAll ? chapters.length - 1 : Math.floor((i % 3) * chapters.length / 3);
    const ch = chapters[Math.min(chapterIndex, chapters.length - 1)];
    const pc = ch.pageCount > 0 ? ch.pageCount : PAGES;
    const pageIndex = readAll ? pc - 1 : Math.min(pc - 1, Math.floor(((i * 37) % 100) / 100 * pc));
    const r = await putJson('/api/progress', {
      comicId: comic.id,
      chapterId: ch.id,
      chapterIndex: ch.index,
      pageIndex,
      pageCount: pc,
    });
    if (r.json?.code === 0) {
      done++;
      if (readAll) finished++;
    }
  }
  console.log(`阅读记录写入 ${done} 条（其中读完 ${finished} 本）`);
}

/* ---------------- 4. 清理 ---------------- */
async function clean() {
  const libs = (await j('/api/libraries')).json?.data?.items ?? [];
  const lib = libs.find((l) => l.name === LIB_NAME);
  if (lib) {
    await j(`/api/libraries/${encodeURIComponent(lib.id)}`, { method: 'DELETE' });
    console.log(`已删除库「${LIB_NAME}」及其中漫画/进度/收藏`);
  }
  if (fs.existsSync(ROOT)) {
    fs.rmSync(ROOT, { recursive: true, force: true });
    console.log(`已删除目录 ${ROOT}`);
  }
}

/* ---------------- main ---------------- */
if (FLAG('clean')) {
  await clean();
  process.exit(0);
}

console.log(`目标：${N_COMICS} 本 × ${CHAPTERS} 章 × ${PAGES} 页（${W}×${H}），库「${LIB_NAME}」`);
generate();
const lib = await ensureLibraryAndScan();
await seedRecords(lib);

const summary = (await j(`/api/comics?libraryId=${encodeURIComponent(lib.id)}&pageSize=1`)).json?.data;
console.log(`\n完成：库里 ${summary?.total ?? '?'} 本漫画；阅读记录 ${N_RECORDS} 条`);
console.log(`打开首页/书架查看效果；清理：node tools/make_bulk_data.mjs --clean`);
