import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.TESTLIB || path.join(os.tmpdir(), 'fc-pdf-test', 'comics');
fs.mkdirSync(base, { recursive: true });
const sharpMod = await import('sharp');

// 高分辨率漫画样张：不同尺寸，用于验证「标准 / 原图」字节差异
const sizes = [[1600, 2400], [1200, 1800], [1000, 1500]];
const dir = path.join(base, 'SampleManga');
fs.mkdirSync(dir, { recursive: true });
for (let i = 0; i < sizes.length; i++) {
  const [w, h] = sizes[i];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="hsl(${i*120},70%,55%)"/><stop offset="100%" stop-color="hsl(${i*120+60},70%,35%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="50%" font-size="${Math.floor(h/10)}" fill="white" text-anchor="middle" font-family="sans-serif">PAGE ${i+1}</text></svg>`;
  await sharpMod.default(Buffer.from(svg)).png().toFile(path.join(dir, `00${i+1}.png`));
  console.log('wrote', path.join(dir, `00${i+1}.png`));
}

// PDF 测试样本
const { execSync } = await import('node:child_process');
execSync(`node ${ROOT}/tools/make_pdf.mjs ${path.join(base, 'Manual.pdf')} 5`);
console.log('wrote Manual.pdf');
console.log('TESTLIB =', base);
