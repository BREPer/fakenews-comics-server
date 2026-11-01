/**
 * 生成一个多页 PDF 测试样本（纯文本手写，无第三方依赖）。
 * 每页一个不同颜色的填充矩形 + 页码文字，pdfjs 可光栅化出差异明显的图，
 * 用于验证 PDF 格式的章节/取页/标准&原图画质链路。
 *
 * 用法： node tools/make_pdf.mjs <输出路径> [页数]
 */
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? path.join(process.cwd(), 'sample.pdf');
const pages = Math.max(1, Number(process.argv[3] ?? 3));

const colors = [
  [220, 60, 60], [60, 160, 220], [80, 200, 120],
  [230, 180, 40], [160, 90, 220], [40, 200, 200],
];

const objects = []; // 每项是 [id, body]
let id = 1;
const catalogId = id++;
const pagesId = id++;
const fontId = id++;

const pageObjIds = [];
const contentObjIds = [];
for (let p = 0; p < pages; p++) {
  pageObjIds.push(id++);
  contentObjIds.push(id++);
}

// Catalog
objects.push([catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`]);

// Pages tree
const kids = pageObjIds.map((x) => `${x} 0 R`).join(' ');
objects.push([pagesId, `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`]);

// Font
objects.push([fontId, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`]);

// Pages + contents
for (let p = 0; p < pages; p++) {
  const [r, g, b] = colors[p % colors.length];
  const pageId = pageObjIds[p];
  const contentId = contentObjIds[p];
  objects.push([pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`]);
  const stream =
    `0.95 0.95 0.95 rg 0 0 612 792 re f\n` +
    `${r / 255} ${g / 255} ${b / 255} rg 60 300 492 360 re f\n` +
    `0 0 0 rg BT /F1 48 Tf 72 720 Td (PDF Page ${p + 1}) Tj ET\n` +
    `BT /F1 24 Tf 72 260 Td (fakenews-comics pdf fixture) Tj ET`;
  objects.push([contentId, `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`]);
}

// 组装带 xref 的完整文件
let pdf = '%PDF-1.4\n';
const offsets = [];
for (const [oid, body] of objects) {
  offsets[oid] = Buffer.byteLength(pdf, 'latin1');
  pdf += `${oid} 0 obj\n${body}\nendobj\n`;
}
const xrefStart = Buffer.byteLength(pdf, 'latin1');
const total = id; // 下一个空闲 id
pdf += `xref\n0 ${total}\n`;
pdf += `0000000000 65535 f \n`;
for (let oid = 1; oid < total; oid++) {
  pdf += `${String(offsets[oid]).padStart(10, '0')} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${total} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, pdf, 'latin1');
console.log(`wrote ${out} (${pages} pages)`);
