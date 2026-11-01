/**
 * 主题（外观）：light / dark / system。
 * - 通过 <html class="dark"> 切换，配色由 index.css 的 CSS 变量驱动（ink 色阶整体反相）
 * - 选择持久化到 localStorage，首帧在 main.tsx 里同步应用，避免浅色模式下先闪一下深色
 * - 阅读器固定黑底（漫画阅读习惯），不受主题影响
 */

export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'fakenews-theme';
const THEME_COLOR = { dark: '#161923', light: '#f5f6f8' } as const;

export function getStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* 隐私模式等场景：忽略 */
  }
  // 兜底必须和 index.html 首帧脚本、启动壳一致（都是浅色）：
  // 这里曾写死 'dark'，导致新设备先按浅色铺开、JS 一到又翻成深色（实测 2 次翻转）。
  return 'light';
}

export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
}

/** system → 依据系统偏好解析为实际明暗 */
function resolve(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'dark';
  }
}

/**
 * 切换瞬间临时开启一次全局颜色过渡（见 index.css 的 .theme-transition）。
 *
 * 底色是：常驻颜色过渡的只有 `body / .card / .btn-ghost / .input` 四个选择器，
 * 而 brand 系类名、玻璃层、渐变、图标的 currentColor 全是硬跳 ——
 * 于是切明暗时是「一部分在渐变、一部分瞬变」，看着像闪了一下。
 *
 * 之所以不能常驻：常驻之后每次 hover、每次列表刷新都会把整页元素拖进颜色插值，
 * 是笔不划算的常开开销。只在切换那一帧挂上、220ms 后摘掉。
 */
let themeTransitionTimer = 0;
function beginThemeTransition(): void {
  const root = document.documentElement;
  root.classList.add('theme-transition');
  window.clearTimeout(themeTransitionTimer);
  themeTransitionTimer = window.setTimeout(() => {
    root.classList.remove('theme-transition');
  }, 220);
}

/** 应用主题：切 .dark 类 + 同步移动端状态栏色 */
export function applyTheme(theme: Theme): void {
  const dark = resolve(theme) === 'dark';
  const root = document.documentElement;
  beginThemeTransition();
  root.classList.toggle('dark', dark);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? THEME_COLOR.dark : THEME_COLOR.light);
}

/** 监听系统明暗变化（仅 system 模式用） */
export function watchSystemTheme(cb: () => void): () => void {
  let mql: MediaQueryList;
  try {
    mql = window.matchMedia('(prefers-color-scheme: dark)');
  } catch {
    return () => {};
  }
  mql.addEventListener('change', cb);
  return () => mql.removeEventListener('change', cb);
}

/* ------------------------------ 高亮色 ------------------------------ */

/**
 * 高亮色：
 *   amber 琥珀橙（默认，原暖橙，色值未变）
 *   sora  空色（日本传统色「そらいろ」，标准色 #A0D8EF）
 *   bean  豆沙绿（标准色 #C7EDCC）
 * 只切 <html data-accent>，配色由 index.css 的 --brand-* 变量重映射，
 * 因此几十处 bg-brand-500 / text-brand-400 类名无需改动。
 */
export type Accent = 'amber' | 'sora' | 'bean';

const ACCENT_KEY = 'fakenews-accent';

/**
 * 历史值兼容：
 *   orange                  → amber（改名）
 *   blue / gray             → sora / bean（第一版的两个颜色被替换）
 *   prussian                → sora（上一版是普鲁士蓝 #003153，这一版改成空色）
 * 全靠这层映射完成迁移——选过「蓝色」或「普鲁士蓝」的用户升级后看到的就是空色，
 * 不需要重新选一次；服务端 settings 里存的老值也一样。
 */
const LEGACY_ACCENT: Record<string, Accent> = {
  orange: 'amber',
  blue: 'sora',
  prussian: 'sora',
  gray: 'bean',
};

export function normalizeAccent(v: unknown): Accent {
  if (v === 'amber' || v === 'sora' || v === 'bean') return v;
  if (typeof v === 'string' && LEGACY_ACCENT[v]) return LEGACY_ACCENT[v];
  return 'amber';
}

/** 三种高亮色的代表色（标准色），供设置页色板与首帧启动壳使用 */
export const ACCENT_SWATCH: Record<Accent, string> = {
  amber: '#f97316',
  sora: '#a0d8ef',
  bean: '#c7edcc',
};

export function getStoredAccent(): Accent {
  try {
    const v = localStorage.getItem(ACCENT_KEY);
    if (v) return normalizeAccent(v);
  } catch {
    /* 隐私模式等场景：忽略 */
  }
  return 'amber';
}

export function storeAccent(accent: Accent): void {
  try {
    localStorage.setItem(ACCENT_KEY, accent);
  } catch {
    /* ignore */
  }
}

/** 应用高亮色：默认琥珀橙就不写属性，省掉一次无意义的属性变更 */
export function applyAccent(accent: Accent | undefined): void {
  if (!accent) return;
  const root = document.documentElement;
  const a = normalizeAccent(accent);
  // 高亮色切的是 --brand-* 变量，与切明暗同理：不同步过渡的话 brand 系类名会硬跳
  beginThemeTransition();
  if (a === 'amber') root.removeAttribute('data-accent');
  else root.setAttribute('data-accent', a);
}


