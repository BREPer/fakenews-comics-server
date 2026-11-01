import { DEVICE_PREFS_DEFAULTS, type Accent, type DevicePrefs, type FitMode, type PageAnimation, type Quality, type ReadDir, type ReaderMode, type Theme } from '@/types';
import { getStoredAccent, getStoredTheme, normalizeAccent, storeAccent, storeTheme } from '@/theme';
import { api } from '@/api/client';

/**
 * 设备偏好（10 项阅读偏好 + 外观）的唯一真源。
 *
 * 设计要点（论证见 docs/2026-10-24-偏好归属论证.md）：
 *   1. **localStorage 是唯一真源**，服务端不再存这 10 项（`/api/settings` 只剩 L1）。
 *      以前是「服务端全局 + 本地镜像」双写，任何设备的修改都会覆盖其它设备
 *      （实测：A 设备在设置页改「按高度」，B 设备刷新后也变成按高度）。
 *   2. **一项一个 key**，不用单个 JSON：`index.html` 的首帧脚本要同步读
 *      `fakenews-theme` / `fakenews-accent` 定下背景与配色（避免白闪），
 *      单个 JSON 会让那段内联脚本变复杂、也更容易在解析失败时闪一下。
 *   3. **读出来的每个值都校验**：localStorage 是用户可编辑的，脏值不能进渲染路径。
 *   4. 对外用 `useSyncExternalStore`：设置页和阅读器同时挂载时不会各自持一份旧快照。
 */

/** 每一项的存储键。前 8 项是本项目自有前缀，后 2 项沿用首帧脚本认的旧键。 */
const KEYS: Record<keyof DevicePrefs, string> = {
  readerMode: 'fakenews:readerMode',
  readDir: 'fakenews:readDir',
  fitMode: 'fakenews:fitMode',
  quality: 'fakenews:quality',
  preloadCount: 'fakenews:preloadCount',
  pageAnimation: 'fakenews:pageAnimation',
  pinchZoom: 'fakenews:pinchZoom',
  keepScreenOn: 'fakenews:keepScreenOn',
  theme: 'fakenews-theme',
  accent: 'fakenews-accent',
};

/** 迁移完成标记：这台设备已经处理过服务端的旧值，不再重复拉取 */
const MIGRATED_KEY = 'fakenews:prefsMigrated';

const READER_MODES: ReaderMode[] = ['single', 'double', 'split', 'webtoon'];
const READ_DIRS: ReadDir[] = ['ltr', 'rtl'];
const FIT_MODES: FitMode[] = ['width', 'height', 'contain', 'original'];
const QUALITIES: Quality[] = ['smooth', 'standard', 'original'];
const ANIMATIONS: PageAnimation[] = ['pan', 'slide', 'fade', 'none'];
const THEMES: Theme[] = ['light', 'dark', 'system'];

/**
 * 预加载页数的可选档位（对应 UI 上的「关/1/3/5/8」）。
 * 存量中间值（2/4/6/7，来自步进器时代）吸附到最近档；距离相等取先遇到的更小档
 * —— 少预载最多慢一点，多预载可能挤爆内存/带宽。
 */
export const PRELOAD_STEPS = [0, 1, 3, 5, 8] as const;

function snapPreload(v: number): number {
  const clamped = Math.max(0, Math.min(8, Math.round(v)));
  return PRELOAD_STEPS.reduce(
    (best, s) => (Math.abs(s - clamped) < Math.abs(best - clamped) ? s : best),
    PRELOAD_STEPS[0],
  );
}

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // 隐私模式 / 禁止存储
  }
}

function writeRaw(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 存储不可用：只失去记忆能力，不影响本次会话 */
  }
}

function oneOf<T extends string>(key: string, allowed: T[], fallback: T): T {
  const v = readRaw(key);
  return v && (allowed as string[]).includes(v) ? (v as T) : fallback;
}

function boolOf(key: string, fallback: boolean): boolean {
  const v = readRaw(key);
  return v === '1' || v === 'true' ? true : v === '0' || v === 'false' ? false : fallback;
}

/** 预加载页数：吸附到档位（PRELOAD_STEPS），中间值不留存 */
function preloadStepOf(key: string, fallback: number): number {
  const raw = readRaw(key);
  // 必须先判 null：`Number(null) === 0`，否则"没存过"会被当成 0（预加载直接失效）
  if (raw === null) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) return fallback;
  const snapped = snapPreload(v);
  // 吸附后写回：存储值必须与 UI/阅读器实际用的值一致，否则"存 2 显示 1"的分叉
  // 会在下一次读取时再吸一遍，排查时永远对不上账
  if (snapped !== v) writeRaw(key, String(snapped));
  return snapped;
}

function load(): DevicePrefs {
  const d = DEVICE_PREFS_DEFAULTS;
  return {
    readerMode: oneOf(KEYS.readerMode, READER_MODES, d.readerMode),
    readDir: oneOf(KEYS.readDir, READ_DIRS, d.readDir),
    fitMode: oneOf(KEYS.fitMode, FIT_MODES, d.fitMode),
    quality: oneOf(KEYS.quality, QUALITIES, d.quality),
    preloadCount: preloadStepOf(KEYS.preloadCount, d.preloadCount),
    pageAnimation: oneOf(KEYS.pageAnimation, ANIMATIONS, d.pageAnimation),
    pinchZoom: boolOf(KEYS.pinchZoom, d.pinchZoom),
    keepScreenOn: boolOf(KEYS.keepScreenOn, d.keepScreenOn),
    // 外观沿用 theme.ts 的读取（它已处理旧值映射与 system 解析）
    theme: getStoredTheme(),
    accent: getStoredAccent(),
  };
}

/** 把任意来源的值（localStorage 字符串 / 服务端迁移值）规整成合法值 */
function coerce<K extends keyof DevicePrefs>(key: K, raw: unknown): DevicePrefs[K] | null {
  if (raw === null || raw === undefined) return null;
  const d = DEVICE_PREFS_DEFAULTS;
  switch (key) {
    case 'readerMode': {
      const v = String(raw);
      return (READER_MODES as string[]).includes(v) ? (v as DevicePrefs[K]) : null;
    }
    case 'readDir': {
      const v = String(raw);
      return (READ_DIRS as string[]).includes(v) ? (v as DevicePrefs[K]) : null;
    }
    case 'fitMode': {
      const v = String(raw);
      return (FIT_MODES as string[]).includes(v) ? (v as DevicePrefs[K]) : null;
    }
    case 'quality': {
      const v = String(raw);
      return (QUALITIES as string[]).includes(v) ? (v as DevicePrefs[K]) : null;
    }
    case 'pageAnimation': {
      const v = String(raw);
      return (ANIMATIONS as string[]).includes(v) ? (v as DevicePrefs[K]) : null;
    }
    case 'theme': {
      const v = String(raw);
      return (THEMES as string[]).includes(v) ? (v as DevicePrefs[K]) : null;
    }
    case 'accent': {
      // 老键 orange/blue/gray/prussian 由 normalizeAccent 迁移，永远有合法值
      return normalizeAccent(raw) as DevicePrefs[K];
    }
    case 'preloadCount': {
      const v = Number(raw);
      return Number.isFinite(v) ? (snapPreload(v) as DevicePrefs[K]) : null;
    }
    case 'pinchZoom':
    case 'keepScreenOn': {
      if (typeof raw === 'boolean') return raw as DevicePrefs[K];
      if (raw === 'true' || raw === '1') return true as DevicePrefs[K];
      if (raw === 'false' || raw === '0') return false as DevicePrefs[K];
      return null;
    }
    default: {
      void d;
      return null;
    }
  }
}

function write<K extends keyof DevicePrefs>(key: K, value: DevicePrefs[K]): void {
  if (key === 'theme') {
    storeTheme(value as Theme);
    return;
  }
  if (key === 'accent') {
    storeAccent(value as Accent);
    return;
  }
  writeRaw(KEYS[key], typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
}

/* ------------------------------ 外部 store ------------------------------ */

let snapshot: DevicePrefs | null = null;
const listeners = new Set<() => void>();

/** 当前快照（同一引用直到有变更，useSyncExternalStore 依赖这一点） */
export function getDevicePrefs(): DevicePrefs {
  if (!snapshot) snapshot = load();
  return snapshot;
}

export function subscribeDevicePrefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(): void {
  snapshot = null;
  for (const fn of listeners) fn();
}

/** 改一项：写盘 + 通知所有订阅者 */
export function setDevicePref<K extends keyof DevicePrefs>(key: K, value: DevicePrefs[K]): void {
  if (getDevicePrefs()[key] === value) return;
  write(key, value);
  emit();
}

/** 批量改（迁移 / 从备份导入用）：只处理合法值，未变化的项不写盘 */
export function applyDevicePrefs(patch: Partial<DevicePrefs>): void {
  let changed = false;
  for (const key of Object.keys(patch) as Array<keyof DevicePrefs>) {
    const v = coerce(key, patch[key]);
    if (v === null || v === undefined) continue;
    if (getDevicePrefs()[key] === v) continue;
    write(key, v as DevicePrefs[typeof key]);
    changed = true;
  }
  if (changed) emit();
}

/** 导出用：一份纯数据的快照（不含额外字段） */
export function devicePrefsSnapshot(): DevicePrefs {
  return { ...getDevicePrefs() };
}

/* ------------------------------ 一次性迁移 ------------------------------ */

/**
 * 把服务端那份旧设置搬到本机，然后**消费掉**服务端数据。
 *
 * 为什么消费掉：偏好既然按设备独立，第二台设备首次访问就不该继承第一台的选择；
 * 「老用户升级」与「新设备首访」在无状态前提下无法区分，只能迁一次、然后删源。
 * 首台设备（升级用户）无感，后续设备用默认值。
 *
 * 只填**本机还没有值**的项：本地已有的值优先，避免覆盖用户刚改过的选择。
 */
export async function migrateLegacyPrefsOnce(): Promise<void> {
  if (readRaw(MIGRATED_KEY)) return;
  try {
    const legacy = await api.legacyPrefs();
    const patch: Partial<DevicePrefs> = {};
    // 这里的下标是"联合键"，直接赋值 TS 会要求值同时满足所有键的类型；
    // 值本身已由 coerce 校验过，所以按 unknown 写入再整体交给 applyDevicePrefs 二次校验。
    const writable = patch as Record<string, unknown>;
    for (const key of Object.keys(KEYS) as Array<keyof DevicePrefs>) {
      if (readRaw(KEYS[key]) !== null) continue; // 本机已有 → 以本机为准
      const v = coerce(key, (legacy as Record<string, unknown>)?.[key]);
      if (v !== null && v !== undefined) writable[key] = v;
    }
    applyDevicePrefs(patch);
    await api.consumeLegacyPrefs();
    writeRaw(MIGRATED_KEY, String(Date.now()));
  } catch {
    /* 迁移失败不影响使用；下次启动再试（不写标记） */
  }
}

/** 测试/调试用：清掉迁移标记，下次启动会重新尝试迁移 */
export function resetMigrationFlag(): void {
  try {
    localStorage.removeItem(MIGRATED_KEY);
  } catch {
    /* ignore */
  }
}
