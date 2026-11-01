/**
 * 全功能旅程测试：覆盖库/漫画/章节/页面/进度/收藏/搜索/设置/扫描/备份 + 新增的上传功能。
 * 直接打 /api/* 并校验响应内容与字节，不仅是状态码（历史教训：4 个 bug 都是状态码对内容错）。
 * 运行：node tools/journey_test.mjs  （需先启动服务在 13801）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { py, pyCmd } from './lib/py.mjs';

const ROOT = path.resolve('.');
const BASE = process.env.BASE || 'http://localhost:13801';
const STAGING = path.join(os.tmpdir(), 'fc-upload-staging');

let pass = 0;
let fail = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✅', msg); }
  else { fail++; fails.push(msg); console.log('  ❌', msg); }
}
async function getJson(p) {
  const r = await fetch(BASE + p);
  const body = await r.json().catch(() => null);
  return { r, body };
}
async function sendJson(p, method, obj) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: obj ? JSON.stringify(obj) : undefined,
  });
  const body = await r.json().catch(() => null);
  return { r, body };
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function waitScanDone(timeoutMs = 30000) {
  const start = Date.now();
  let sawRunning = false;
  let stableFalse = 0;
  while (Date.now() - start < timeoutMs) {
    const { body } = await getJson('/api/scan/status');
    const running = body?.data?.running === true;
    if (running) { sawRunning = true; stableFalse = 0; }
    else { stableFalse++; }
    // 必须曾观察到扫描在跑，且连续两次（约 800ms）都处于空闲，
    // 才能排除「排队扫描之间的真空窗口」导致的误判
    if (sawRunning && stableFalse >= 2) return true;
    if (!sawRunning && stableFalse >= 3) return true;
    await sleep(400);
  }
  return false;
}

/** 手动拼 multipart（Node 的 FormData 会剥掉文件名里的目录分隔符，无法模拟文件夹上传，
 *  这里直接构造带完整相对路径 filename 的请求体，贴合浏览器 webkitdirectory 的真实行为） */
function buildMultipart(files) {
  const boundary = '----fnboundary' + Date.now();
  const chunks = [];
  for (const f of files) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="files"; filename="${f.name}"\r\n`));
    chunks.push(Buffer.from('Content-Type: application/octet-stream\r\n\r\n'));
    chunks.push(f.data);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
async function uploadRaw(libId, files) {
  const { body, contentType } = buildMultipart(files);
  const res = await fetch(BASE + `/api/libraries/${libId}/upload`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
  return { res, json: await res.json() };
}

async function main() {
  console.log('\n=== 0. 健康检查 ===');
  const { body: h } = await getJson('/api/health');
  ok(h?.code === 0 && h?.data?.ok === true, 'health 返回 ok');

  console.log('\n=== 1. 漫画库列表 ===');
  const { body: libs } = await getJson('/api/libraries');
  ok(libs?.code === 0 && Array.isArray(libs.data.items) && libs.data.items.length >= 1, 'libraries 有至少一个库');
  const lib = libs.data.items[0];
  const libRoot = lib.paths[0];
  ok(lib.comicCount >= 8, `库收录漫画数=${lib.comicCount} (>=8)`);
  ok(Array.isArray(lib.inaccessiblePaths), 'inaccessiblePaths 字段存在');

  console.log('\n=== 2. 漫画列表 + 分页 + facets ===');
  const { body: list } = await getJson('/api/comics?pageSize=200');
  ok(list?.code === 0 && list.data.total >= 8, `comics total=${list.data.total} (>=8)`);
  ok(list.data.items[0]?.id && list.data.items[0]?.title, 'comic 含 id/title');
  ok(list.data.hasMore === false || list.data.total <= 200, '分页 hasMore 字段正常');
  const { body: facets } = await getJson('/api/comics/facets');
  ok(facets?.data?.formats?.length >= 1, `facets.formats 非空 (${facets?.data?.formats?.length})`);
  ok(facets?.data?.tags?.length >= 1, `facets.tags 非空 (${facets?.data?.tags?.length})`);

  console.log('\n=== 3. 漫画详情 + 章节 ===');
  const { body: searchHaitang } = await getJson('/api/comics?q=' + encodeURIComponent('海贼王'));
  const op = searchHaitang.data.items[0];
  ok(!!op, '搜到 海贼王');
  const { body: detail } = await getJson('/api/comics/' + encodeURIComponent(op.id));
  ok(detail?.code === 0 && Array.isArray(detail.data.chapters), 'detail 含 chapters');
  ok(detail.data.chapters.length === 12, `海贼王 章数=12 (实得 ${detail.data.chapters.length})`);
  ok(detail.data.pageCount === 24, `海贼王 总页数=24 (实得 ${detail.data.pageCount})`);

  console.log('\n=== 4. 章节页列表 + 页面图片（含 Range） ===');
  const ch0 = detail.data.chapters[0];
  const { body: pages } = await getJson(
    `/api/comics/${encodeURIComponent(op.id)}/chapters/${encodeURIComponent(ch0.id)}/pages`,
  );
  ok(pages?.code === 0 && pages.data.pages.length === ch0.pageCount, `章0 页数=${pages.data.pages.length} 与 detail 一致`);
  // standard 缩略图（webp，小源图 no-enlarge 故字节少，仅校验有效图片）
  const imgUrl =
    `/api/comics/${encodeURIComponent(op.id)}/chapters/${encodeURIComponent(ch0.id)}/pages/0?quality=standard&w=400`;
  const imgRes = await fetch(BASE + imgUrl);
  ok(imgRes.status === 200, '页面图片 standard 返回 200');
  ok((imgRes.headers.get('content-type') || '').startsWith('image/'), `content-type 是图片 (${imgRes.headers.get('content-type')})`);
  const imgBuf = Buffer.from(await imgRes.arrayBuffer());
  ok(imgBuf.length > 20, `缩略图字节数=${imgBuf.length} (>20，有效 webp)`);
  // original 原图支持 Range：带 Range 应回 206 且只返回部分
  const origUrl =
    `/api/comics/${encodeURIComponent(op.id)}/chapters/${encodeURIComponent(ch0.id)}/pages/0?quality=original`;
  const origRes = await fetch(BASE + origUrl);
  ok(origRes.status === 200, '原图返回 200');
  const totalBytes = Number(origRes.headers.get('content-length') || 0);
  const rangeRes = await fetch(BASE + origUrl, { headers: { Range: 'bytes=0-99' } });
  ok(rangeRes.status === 206, `原图 Range 请求返回 206 (实得 ${rangeRes.status})`);
  ok(rangeRes.headers.get('content-range') != null, '206 带 content-range');
  const rangeBuf = Buffer.from(await rangeRes.arrayBuffer());
  ok(rangeBuf.length === Math.min(100, totalBytes) && totalBytes > 100, `Range 仅返回部分字节 (${rangeBuf.length}/${totalBytes})`);

  console.log('\n=== 5. 搜索 ===');
  const { body: s1 } = await getJson('/api/comics?q=' + encodeURIComponent('格林'));
  ok(s1.data.total >= 1, `搜索"格林"命中 ${s1.data.total}`);
  const { body: s2 } = await getJson('/api/comics?q=' + encodeURIComponent('不存在的漫画xyz'));
  ok(s2.data.total === 0, '搜索不存在词返回 0');

  console.log('\n=== 6. 进度上报 + 读取 ===');
  const progBody = {
    comicId: op.id, chapterId: ch0.id, chapterIndex: ch0.index,
    pageIndex: 1, pageCount: ch0.pageCount, percent: 50,
  };
  const { body: putP } = await sendJson('/api/progress', 'PUT', progBody);
  ok(putP?.code === 0, 'PUT progress 成功');
  const { body: getP } = await getJson('/api/progress?comicIds=' + encodeURIComponent(op.id));
  ok(getP?.data?.items?.some?.((i) => i.comicId === op.id && i.percent === 50), 'progress 读取到 50%');
  // 详情应反映 reading 状态
  const { body: detail2 } = await getJson('/api/comics/' + encodeURIComponent(op.id));
  ok(detail2.data.readStatus === 'reading', `详情 readStatus=reading (实得 ${detail2.data.readStatus})`);

  console.log('\n=== 7. 收藏 / 取消 ===');
  await sendJson('/api/favorites', 'POST', { comicId: op.id });
  const { body: fav1 } = await getJson('/api/favorites');
  ok(fav1.data.items.some((c) => c.id === op.id), '收藏后出现在收藏列表');
  await fetch(BASE + `/api/favorites/${encodeURIComponent(op.id)}`, { method: 'DELETE' });
  const { body: fav2 } = await getJson('/api/favorites');
  ok(!fav2.data.items.some((c) => c.id === op.id), '取消收藏后不在列表');

  console.log('\n=== 8. 设置读写 ===');
  const { body: setGet } = await getJson('/api/settings');
  ok(setGet?.code === 0 && typeof setGet.data === 'object', 'GET settings 返回对象');
  // 阅读偏好/外观已改为按设备存（localStorage），服务端只剩会执行的项；
  // 这里用 autoScanIntervalHours 验读写，并断言偏好键既不接受写入也不在响应里出现。
  const { body: setPut } = await sendJson('/api/settings', 'PUT', { autoScanIntervalHours: 5, theme: 'light' });
  ok(setPut?.code === 0, 'PUT settings 成功');
  const { body: setGet2 } = await getJson('/api/settings');
  ok(setGet2.data.autoScanIntervalHours === 5, `设置持久化=5 (实得 ${setGet2.data.autoScanIntervalHours})`);
  ok(!('theme' in setGet2.data), '设备偏好键不出现在服务端设置里');
  await sendJson('/api/settings', 'PUT', { autoScanIntervalHours: setGet?.data?.autoScanIntervalHours ?? 0 });

  console.log('\n=== 9. 扫描状态 ===');
  const { body: scan } = await getJson('/api/scan/status');
  ok(scan?.code === 0 && typeof scan.data.running === 'boolean', 'scan/status 返回 running 布尔');

  console.log('\n=== 10. 备份导出 ===');
  const { body: bak } = await getJson('/api/backup/export');
  ok(bak?.code === 0 && Array.isArray(bak.data.progress) && 'settings' in bak.data, 'backup/export 结构正常');

  console.log('\n=== 11. 上传功能（按库类型分流） ===');
  const ts = Date.now();
  // 夹具由 tools/make_upload_fixture.py 生成（章节型/单篇型各一套）
  py(path.join(ROOT, 'tools', 'make_upload_fixture.py'), [STAGING], { stdio: 'ignore' });
  const isChapterLib = lib.type === 'chapter';
  const cbzBuf = fs.readFileSync(path.join(STAGING, isChapterLib ? '分章漫画.cbz' : '散图漫画.cbz'));
  const pngBuf = () => Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8ffff3f000005fe02fea735c4670000000049454e44ae426082', 'hex');

  if (isChapterLib) {
    // 11a. 章节型「上传整部漫画」：建文件夹 + 解压，压缩包本体不保留
    const base = `分章漫画_${ts}`;
    const up1 = await uploadRaw(lib.id, [{ name: `${base}.cbz`, data: cbzBuf }]);
    ok(up1.res.status === 200 && up1.json.code === 0, `章节型上传 HTTP200 (written=${up1.json?.data?.written})`);
    ok(up1.json.data.written === 2, `解压出 2 个文件 (实得 ${up1.json.data.written})`);
    ok((up1.json.data.folders ?? []).includes(base), `返回新建文件夹 ${base}`);
    const comicDir = path.join(libRoot, base);
    ok(fs.existsSync(comicDir) && fs.existsSync(path.join(comicDir, '第01卷', '001.png')),
      `已创建文件夹并解压: ${comicDir}`);
    ok(!fs.existsSync(path.join(libRoot, `${base}.cbz`)), '压缩包本体不残留在库根');

    // 11b. 多段路径（旧文件夹上传形态）应被跳过
    const up2 = await uploadRaw(lib.id, [{ name: `UpFolder_${ts}/001.png`, data: pngBuf() }]);
    ok(up2.json.data.written === 0 && up2.json.data.skipped.includes(`UpFolder_${ts}/001.png`),
      '带目录层级的文件名被跳过（不再支持文件夹上传）');
  } else {
    // 11a. 单篇型：压缩包原样上传、不解压
    const cbzName = `散图漫画_${ts}.cbz`;
    const up1 = await uploadRaw(lib.id, [{ name: cbzName, data: cbzBuf }]);
    ok(up1.res.status === 200 && up1.json.code === 0, `单篇型上传 HTTP200 (written=${up1.json?.data?.written})`);
    ok(up1.json.data.written === 1, `压缩包原样写入 1 个文件 (实得 ${up1.json.data.written})`);
    ok(fs.existsSync(path.join(libRoot, cbzName)), `压缩包已落地库根: ${cbzName}`);
    ok(!fs.existsSync(path.join(libRoot, `散图漫画_${ts}`)), '不创建文件夹、不解压');
  }

  // 11c. 不支持的文件应被跳过（written=0, skipped 含该文件）
  const up3 = await uploadRaw(lib.id, [{ name: 'notes.txt', data: Buffer.from('hello') }]);
  ok(up3.json.data.written === 0 && up3.json.data.skipped.includes('notes.txt'), '不支持的文件被跳过');

  // 11d. 路径穿越防护：相对路径含 .. 应被拒绝/跳过（文件既不在根内也不在根外）
  const up4 = await uploadRaw(lib.id, [{ name: '../evil_test.cbz', data: cbzBuf }]);
  ok(up4.json.data.skipped.includes('../evil_test.cbz'), '穿越路径被跳过');
  ok(!fs.existsSync(path.join(libRoot, 'evil_test.cbz')) &&
     !fs.existsSync(path.resolve(libRoot, '..', 'evil_test.cbz')), '穿越文件未写出（根内/根外均无）');

  // 11e. 防御：松散图片直接落库根应被拒绝（避免触发扫描器把库根当整册漫画）
  const up5 = await uploadRaw(lib.id, [{ name: 'loose.png', data: pngBuf() }]);
  ok(up5.json.data.written === 0 && up5.json.data.skipped.includes('loose.png'), '松散图片被拒绝（需打包后上传）');
  ok(!fs.existsSync(path.join(libRoot, 'loose.png')), '松散图片未落盘');

  // 11f. 章节型仅支持压缩包：epub 应被跳过；单篇型则允许
  const epubFake = Buffer.from('PK\x03\x04fake-epub');
  const up6 = await uploadRaw(lib.id, [{ name: 'test_book.epub', data: epubFake }]);
  if (isChapterLib) {
    ok(up6.json.data.written === 0 && up6.json.data.skipped.some((s) => s.includes('test_book.epub')),
      '章节型拒绝 epub（仅支持压缩包）');
  } else {
    ok(up6.json.data.written === 1 && fs.existsSync(path.join(libRoot, 'test_book.epub')),
      '单篇型允许 epub 原样上传');
  }

  console.log('\n=== 12. 上传后扫描入库验证 ===');
  const scanned = await waitScanDone();
  ok(scanned, '扫描在超时内完成');
  if (isChapterLib) {
    const { body: afterUp } = await getJson('/api/comics?q=' + encodeURIComponent(`分章漫画_${ts}`));
    ok(afterUp.data.total >= 1, `上传的压缩包已被扫描入库 (命中 ${afterUp.data.total})`);
    const upComic = afterUp.data.items[0];
    ok(upComic?.format === 'folder' && upComic.pageCount === 2,
      `入库漫画格式=folder 页数=2 (实得 ${upComic?.format}/${upComic?.pageCount})`);
  } else {
    const { body: afterUp } = await getJson('/api/comics?q=' + encodeURIComponent(`散图漫画_${ts}`));
    ok(afterUp.data.total >= 1, `上传的压缩包已被扫描入库 (命中 ${afterUp.data.total})`);
    const upComic = afterUp.data.items[0];
    ok(upComic?.format === 'cbz' && upComic.pageCount === 3,
      `入库漫画格式=cbz 页数=3 (实得 ${upComic?.format}/${upComic?.pageCount})`);
  }

  console.log('\n==================== 结果汇总 ====================');
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (fail > 0) { console.log('失败项:'); fails.forEach((f) => console.log('  - ' + f)); process.exitCode = 1; }
  else console.log('🎉 全部通过');
}

main().catch((e) => { console.error('测试崩溃:', e); process.exitCode = 1; });
