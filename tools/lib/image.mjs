/**
 * 零依赖图像工具：读图片头 + 写 PNG。
 *
 * 为什么不用 sharp：探针脚本原本 `require('app/server/package.json')` 借后端的 sharp，
 * 一旦 Node 历史后端下线就断链；而 reader_probe 又自称「无第三方依赖」，前后矛盾。
 * 这里只用 node:zlib + 几十行头解析，做到装个 Node 就能跑。
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

/* ---------------- CRC32 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---------------- 读图片头 ---------------- */
function pngMeta(b) {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  // IHDR 必须是第一个 chunk
  if (b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { format: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpegMeta(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    // SOF0..SOF15，跳过 DHT(C4)/JPG(C8)/DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { format: 'jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webpMeta(b) {
  if (b.length < 30 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = b.toString('ascii', 12, 16);
  if (kind === 'VP8 ') {
    return { format: 'webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (kind === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8X') {
    return { format: 'webp', width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return null;
}

function gifMeta(b) {
  if (b.length < 10 || b.toString('ascii', 0, 3) !== 'GIF') return null;
  return { format: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

/**
 * 从缓冲区解析图片尺寸，不认识就返回 null。
 * @returns {{format:string,width:number,height:number}|null}
 */
export function imageMeta(buf) {
  return pngMeta(buf) || jpegMeta(buf) || webpMeta(buf) || gifMeta(buf);
}

/* ---------------- 写 PNG ---------------- */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * 写一张 RGB PNG。
 * @param {string} file 目标路径
 * @param {number} w
 * @param {number} h
 * @param {(x:number,y:number)=>[number,number,number]} painter 逐像素取色（对小图够快；1700x1000 也只需 ~5MB 缓冲）
 */
export function writePng(file, w, h, painter) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b] = painter(x, y);
      const o = row + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type: truecolor
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  // 同步写，调用方是顺序流程，省掉 await
  fs.writeFileSync(file, png);
  return { width: w, height: h, bytes: png.length };
}

/** '#1b5e20' → [27,94,32] */
export function hex([...s]) {
  const v = s.slice(1).join('');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}
