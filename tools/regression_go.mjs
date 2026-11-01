#!/usr/bin/env node
/**
 * 全量回归：构建 Go 二进制 → 起 3 个实例（标准/章节/边界夹具）→
 * 跑全部 7 个黑盒/浏览器套件，校验接口契约与前端类型逐字段一致。
 *
 * 套件全走黑盒 HTTP（+ CDP 浏览器探针），不 import 后端代码——换实现也要全绿。
 * 用法：node tools/regression_go.mjs
 */
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { py, pyCmd } from './lib/py.mjs';

const ROOT = path.resolve('.');
const TMP = os.tmpdir();
const GO = process.env.GO_EXE || 'go';
const BIN = path.join(TMP, 'fakenews-go-server.exe');
const WEB_DIST = path.join(ROOT, 'app', 'web', 'dist');
const SERVER_GO = path.join(ROOT, 'app', 'server-go');
const NODE = process.execPath;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 构建 ---------------- */
function goBuild() {
  const t = Date.now();
  execFileSync(GO, ['build', '-o', BIN, '.'], {
    cwd: SERVER_GO,
    env: {
      ...process.env,
      GOPROXY: 'https://mirrors.aliyun.com/goproxy/,direct',
      GOSUMDB: 'off',
      GOTOOLCHAIN: 'local',
      GOFLAGS: '-buildvcs=false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return Date.now() - t;
}

/* ---------------- 服务管理 ---------------- */
const servers = [];
async function startServer(port, comicRoot, dataDir, opts = {}) {
  // 每次全新数据目录：残留 DB 会让「增量跳过」把新库的条目全跳过（chapter_probe got=0 的坑）
  fs.rmSync(dataDir, { recursive: true, force: true });
  const child = spawn(BIN, [], {
    env: {
      ...process.env,
      APP_PORT: String(port),
      COMIC_ROOT: comicRoot,
      DATA_DIR: dataDir,
      ...(opts.webDist ? { WEB_DIST: opts.webDist } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(child);
  // 服务日志落盘（排障：回归期 Go 侧 scan/panic 一目了然）
  const logStream = fs.createWriteStream(path.join(TMP, `go-reg-${port}.log`));
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  // 等 health
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) {
        const j = await r.json();
        return { child, port, version: j.data?.version ?? '?' };
      }
    } catch { /* not ready */ }
    await sleep(200);
  }
  throw new Error(`Go 服务 ${port} 未就绪`);
}

async function killServer(child) {
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
  await sleep(300);
}

/* ---------------- 套件 ---------------- */
const SUITES = [
  { name: 'regression', label: 'API 全功能（标准夹具）', server: 'std', file: 'tools/regression.mjs' },
  { name: 'chapter_probe', label: '章节识别（11 部假数据）', server: 'chapter', file: 'tools/chapter_probe.mjs' },
  { name: 'reader_probe', label: '阅读器（真浏览器）', server: 'std', file: 'tools/reader_probe.mjs' },
  { name: 'fav_probe', label: '收藏/取消收藏（真浏览器）', server: 'std', file: 'tools/fav_probe.mjs' },
  { name: 'edit_probe', label: '分类/标签编辑（真浏览器）', server: 'std', file: 'tools/edit_probe.mjs' },
  { name: 'edge_probe', label: '边界/畸形数据集', server: 'edge', file: 'tools/edge_probe.mjs' },
  { name: 'viewport_probe', label: '多设备视口 UI', server: 'std', file: 'tools/viewport_probe.mjs' },
];

function parseSummary(out) {
  const passes = [...out.matchAll(/通过[:：\s]+(\d+)/g)].map((m) => Number(m[1]));
  const fails = [...out.matchAll(/失败[:：\s]+(\d+)/g)].map((m) => Number(m[1]));
  const p = passes.at(-1);
  const f = fails.at(-1);
  return p === undefined || f === undefined ? null : { pass: p, fail: f };
}

const hr = (t) => console.log('\n' + '─'.repeat(14) + ` ${t} ` + '─'.repeat(14));

async function main() {
  hr('构建');
  const ms = goBuild();
  console.log(`  Go build: OK  ${ms}ms → ${BIN}`);
  console.log(`  二进制大小: ${(fs.statSync(BIN).size / 1048576).toFixed(1)} MB（含内嵌 WASM PDFium）`);

  hr('夹具');
  for (const script of ['tools/make_test_data.py', 'tools/make_chapter_fixtures.py', 'tools/make_edge_data.py']) {
    const r = spawnSync(...pyCmd(script), { cwd: ROOT });
    console.log(`  ${path.basename(script)}: ${r.status === 0 ? 'OK' : 'FAIL'}`);
    if (r.status !== 0) throw new Error(script + ' 生成失败');
  }
  // 空根目录：14103 启动库指向它（与 regression_all 语义一致）——
  // chapter_probe 会自建库并期望全新识别，若启动库直接指向 chapter-lib，
  // 11 部会先被默认库收走，新库增量全跳过、按 libraryId 过滤出 0 部。
  fs.mkdirSync(path.join(TMP, 'fc-empty-root'), { recursive: true });

  hr('启动 Go 服务');
  const std = await startServer(14101, path.join(TMP, 'fakenews-comics'), path.join(TMP, 'fc-go-reg-std'), { webDist: WEB_DIST });
  console.log(`  14101 标准夹具（API+浏览器套件）   v${std.version}`);
  const chapter = await startServer(14103, path.join(TMP, 'fc-empty-root'), path.join(TMP, 'fc-go-reg-chapter'));
  console.log(`  14103 空根目录（章节识别自建库）   v${chapter.version}`);
  const edge = await startServer(14104, path.join(TMP, 'fc-edge'), path.join(TMP, 'fc-go-reg-edge'));
  console.log(`  14104 边界数据集                   v${edge.version}`);

  hr('套件');
  const byName = { std, chapter, edge };
  const results = [];
  for (const s of SUITES) {
    const port = byName[s.server].port;
    const t = Date.now();
    const r = spawnSync(NODE, [s.file, `http://127.0.0.1:${port}`], { cwd: ROOT, encoding: 'utf8' });
    const ms2 = Date.now() - t;
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    const sum = parseSummary(out);
    results.push({ ...s, code: r.status, ms: ms2, sum, out });
    if (sum) {
      const mark = sum.fail === 0 ? '✓' : '✗';
      console.log(`  ${mark} ${s.name.padEnd(15)} ${String(sum.pass).padStart(3)} 通过 / ${String(sum.fail).padStart(2)} 失败  (${(ms2 / 1000).toFixed(1)}s)`);
      if (sum.fail > 0) {
        for (const line of out.split('\n').filter((l) => l.includes('FAIL') || l.includes('✗')).slice(0, 12)) {
          console.log(`      ${line.trim()}`);
        }
      }
    } else {
      console.log(`  ? ${s.name.padEnd(15)} 无法解析结果（exit=${r.status}）`);
      console.log(out.split('\n').slice(-10).join('\n'));
    }
  }

  hr('清理');
  for (const srv of servers) await killServer(srv);
  console.log('  已关闭全部 Go 服务');

  const totalPass = results.reduce((n, r) => n + (r.sum?.pass ?? 0), 0);
  const totalFail = results.reduce((n, r) => n + (r.sum?.fail ?? 0), 0);
  console.log('\n' + '='.repeat(24));
  console.log(`Go 后端回归：${results.length} 个套件 · 总断言 ${totalPass + totalFail} · 通过 ${totalPass} · 失败 ${totalFail}`);
  console.log('='.repeat(24));
  process.exit(totalFail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  for (const srv of servers) {
    try { srv.kill(); } catch { /* ignore */ }
  }
  process.exit(1);
});
