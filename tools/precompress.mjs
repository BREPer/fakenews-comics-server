/**
 * 构建期预压缩：为前端产物生成 `.gz` 兄弟文件，运行时由 @fastify/static 的
 * preCompressed 直接命中（Content-Encoding: gzip），不占用服务端 CPU。
 *
 * 为什么不运行时压：NAS 多半是 ARM，每个请求现压一遍 235KB 的 JS 要几毫秒到几十毫秒；
 * 而产物文件名带内容指纹（index-<hash>.js），预压缩 + 强缓存等于「每个客户端只下一次」。
 *
 * 用法：node tools/precompress.mjs [distDir]（默认 app/web/dist）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dir = process.argv[2] ?? 'app/web/dist';
const MIN_BYTES = 1024; // 小文件压了反而更大，且没有收益
const EXT = new Set(['.js', '.css', '.html', '.json', '.svg', '.map']);

let saved = 0;
let made = 0;

function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      walk(p);
      continue;
    }
    if (!EXT.has(path.extname(e.name))) continue;
    if (e.name.endsWith('.gz')) continue;
    const buf = fs.readFileSync(p);
    if (buf.length < MIN_BYTES) continue;
    const gz = zlib.gzipSync(buf, { level: 9 });
    if (gz.length >= buf.length) continue; // 压不动就别放，省得 preCompressed 反而更大
    fs.writeFileSync(`${p}.gz`, gz);
    saved += buf.length - gz.length;
    made++;
  }
}

if (!fs.existsSync(dir)) {
  console.error(`precompress: ${dir} 不存在（先构建前端）`);
  process.exit(1);
}
walk(dir);
const files = [];
(function count(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) count(p);
    else if (e.name.endsWith('.gz')) files.push(p);
  }
})(dir);
console.log(`precompress: ${made} 个文件 → .gz，原 ${(saved / 1024).toFixed(0)}KB 压缩节省，共 ${files.length} 个 .gz`);
