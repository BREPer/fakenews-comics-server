/**
 * Python 解释器定位（跨平台，可被环境变量覆盖）
 *
 * 为什么单独一个模块：以前各脚本直接写死 `'python'`，
 * 在只有 `py` / `python3` 别名的机器（Windows 商店版、精简发行版）上，
 * 夹具生成会静默失败——E2E 用 stdio:'ignore' 把真实报错吞掉了，
 * 表现成「莫名其妙的非零退出」，排查成本极高。
 *
 * 解析顺序：`PYTHON` 环境变量 → python → python3 → py -3
 * 用法：
 *   import { pyCmd, py } from './py.mjs';
 *   execFileSync(...pyCmd(script, [args]), opts);
 *   spawnSync(...pyCmd(script), opts);
 */
import { execFileSync } from 'node:child_process';

const PROBE = 'import sys; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)';

const candidates = [
  ...(process.env.PYTHON ? [[process.env.PYTHON, []]] : []),
  ['python', []],
  ['python3', []],
  ['py', ['-3']],
];

export const PY = (() => {
  for (const [cmd, pre] of candidates) {
    try {
      execFileSync(cmd, [...pre, '-c', PROBE], { stdio: 'ignore' });
      return { cmd, pre };
    } catch {
      /* 试下一个候选 */
    }
  }
  throw new Error(
    '未找到可用的 Python 3.8+ 解释器。请安装 Python，或设置环境变量 PYTHON 指向解释器可执行文件。'
  );
})();

/** 返回可直接展开给 spawn/execFileSync 的 [cmd, argv] */
export function pyCmd(script, args = []) {
  return [PY.cmd, [...PY.pre, script, ...args]];
}

/** execFileSync 语义的简写：py(script, [args], opts) */
export function py(script, args = [], opts = {}) {
  return execFileSync(PY.cmd, [...PY.pre, script, ...args], opts);
}
