/**
 * 生成「扫描图 PDF」测试样本（内嵌 DCTDecode JPEG，模拟真实漫画扫描 PDF）。
 *
 * 与 make_pdf.mjs（矢量矩形）互补：那个测「渲染路径」，这个测「内嵌图提取路径」——
 * 真实漫画 PDF 基本是扫描图直接嵌 DCTDecode，服务端 PDF 源走内嵌图提取，
 * DCTDecode 页应字节级还原嵌入的 JPEG（不重编码、无质量损失）。
 *
 * 依赖：无。源图直接给 JPEG 即可原样嵌入（最常见）；
 *       传 PNG 等非 JPEG 时需要本机有可用的转码器（本仓库不内置）。
 *
 * 用法：node tools/make_scan_pdf.mjs <输出.pdf> <源图.jpg|png> [页数=3]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { imageMeta } from './lib/image.mjs';

const out = process.argv[2];
const src = process.argv[3];
const pages = Math.max(1, Number(process.argv[4] ?? 3));
if (!out || !src) {
  console.error('用法: node tools/make_scan_pdf.mjs <输出.pdf> <源图.jpg|png> [页数=3]');
  process.exit(1);
}

/** 源图 → JPEG 字节。JPEG 直接透传；其他格式尝试 sharp（可选依赖）。 */
async function toJpeg(file) {
  const raw = fs.readFileSync(file);
  if (raw[0] === 0xff && raw[1] === 0xd8) return raw; // 已经是 JPEG
  let sharp = null;
  try {
    sharp = createRequire(import.meta.url)('sharp');
  } catch {
    throw new Error(
      `源图不是 JPEG（${path.basename(file)}），且本机没装 sharp 无法转码。\n` +
        '解决：先把源图另存为 .jpg，或在本仓库任一目录 npm i sharp 后再跑。',
    );
  }
  return sharp(raw).jpeg({ quality: 90 }).toBuffer();
}

// quality 90 与真实扫描件压缩特征接近
const jpeg = await toJpeg(src);
const meta = imageMeta(jpeg);
if (!meta) throw new Error(`无法解析 JPEG 头: ${src}`);
const W = meta.width;
const H = meta.height;
console.log(`嵌入 JPEG: ${W}×${H}, ${jpeg.length} bytes × ${pages} 页`);

const objects = []; // [id, body]；stream 型 body 用 { dict, stream }
let id = 1;
const catalogId = id++;
const pagesId = id++;
const pageIds = [];
const contentIds = [];
const imgIds = [];
for (let p = 0; p < pages; p++) {
  pageIds.push(id++);
  contentIds.push(id++);
  imgIds.push(id++);
}

objects.push([catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`]);
objects.push([pagesId, `<< /Type /Pages /Kids [${pageIds.map((x) => `${x} 0 R`).join(' ')}] /Count ${pages} >>`]);
for (let p = 0; p < pages; p++) {
  // 每页一个独立 Image XObject（真实扫描 PDF 的形态；字节相同但对象不同，可验证逐页提取）
  objects.push([imgIds[p], {
    dict: `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`,
    stream: jpeg,
  }]);
  objects.push([contentIds[p], {
    dict: `<< /Length ${30 + String(W).length + String(H).length + 8} >>`,
    stream: Buffer.from(`q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q\n`, 'latin1'),
  }]);
  objects.push([pageIds[p],
    `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W} ${H}] ` +
    `/Resources << /XObject << /Im0 ${imgIds[p]} 0 R >> >> /Contents ${contentIds[p]} 0 R >>`]);
}

let pdf = Buffer.from('%PDF-1.5\n', 'latin1');
const offsets = [];
for (const [oid, body] of objects) {
  offsets[oid] = pdf.length;
  if (typeof body === 'string') {
    pdf = Buffer.concat([pdf, Buffer.from(`${oid} 0 obj\n${body}\nendobj\n`, 'latin1')]);
  } else {
    const head = Buffer.from(`${oid} 0 obj\n${body.dict}\nstream\n`, 'latin1');
    const tail = Buffer.from('\nendstream\nendobj\n', 'latin1');
    pdf = Buffer.concat([pdf, head, body.stream, tail]);
  }
}
const xrefPos = pdf.length;
const n = id;
let xref = `xref\n0 ${n}\n0000000000 65535 f \n`;
for (let i = 1; i < n; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
pdf = Buffer.concat([pdf, Buffer.from(
  xref + `trailer\n<< /Size ${n} /Root ${catalogId} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`, 'latin1')]);

fs.writeFileSync(out, pdf);
console.log(`已生成 ${out}（${(pdf.length / 1024).toFixed(0)} KB, ${pages} 页）`);
