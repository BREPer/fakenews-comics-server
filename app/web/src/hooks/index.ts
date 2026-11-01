import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { applyAccent, applyTheme, watchSystemTheme } from '@/theme';
import {
  getDevicePrefs, migrateLegacyPrefsOnce, setDevicePref, subscribeDevicePrefs,
} from '@/utils/devicePrefs';
import type { DevicePrefs } from '@/types';

/** 响应式断点查询（Tailwind 断点同源） */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export const useIsDesktop = () => useMediaQuery('(min-width: 1024px)');
export const useIsTablet = () => useMediaQuery('(min-width: 640px) and (max-width: 1023px)');
export const useIsMobile = () => useMediaQuery('(max-width: 639px)');

/**
 * 无限滚动哨兵：返回一个 ref，挂到列表末尾的空 div 上。
 * 该元素进入「视口下方 600px」范围时触发 onReach（等价于提前一屏开始预取）。
 *
 * 为什么用 IntersectionObserver 而不是监听 scroll：
 *   - scroll 事件在移动端每帧都触发，回调里还得读 scrollHeight（强制重排）
 *   - 观察者失效重连一次即可重新判定，正好覆盖「加载完还不到一屏」的情况：
 *     enabled 从 true 变 false 再变 true 时会重新 observe，浏览器立即回调一次，
 *     于是视口没填满就会连着拉下一页，直到填满或没有更多
 *
 * onReach 用 ref 转存：调用方几乎都是内联箭头函数，直接进依赖数组会每次渲染
 * 都断掉重连观察者，滚动中反复 observe 容易漏掉一次交叉。
 */
/**
 * 延迟显示：等待超过 ms 才置 true。
 *
 * 只用于加载态——本地库打开一章只要 4~10ms（实测），一帧灰块闪过去比不显示更像故障。
 * 同理，等待页的吉祥物也挂在这个 hook 上：局域网里所有等待都在 60ms 内结束，
 * 那时它不该出现（一闪而过的插画等于打扰）；只有真的等久了才请它出来，
 * 阈值见 ui/Loading 与 Reader 里的 MASCOT_DELAY（取自三档限速实测）。
 */
export function useDelayedShow(ms: number): boolean {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setShow(true), ms);
    return () => window.clearTimeout(t);
  }, [ms]);
  return show;
}

export function useInfiniteSentinel(onReach: () => void, enabled: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const cb = useRef(onReach);
  useEffect(() => {
    cb.current = onReach;
  }, [onReach]);
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) cb.current();
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [enabled]);
  return ref;
}

/**
 * 设备偏好（10 项阅读偏好 + 外观）：localStorage 为唯一真源。
 *
 * 用 useSyncExternalStore 而不是 useState + effect：
 * 设置页、阅读器、阅读设置弹层可能同时挂载，各自持一份 state 会出现
 * 「这边改完那边还是旧值」；store 保证同一时刻所有订阅者看到同一个快照。
 */
export function useDevicePrefs(): {
  prefs: DevicePrefs;
  setPref: <K extends keyof DevicePrefs>(key: K, value: DevicePrefs[K]) => void;
} {
  const prefs = useSyncExternalStore(subscribeDevicePrefs, getDevicePrefs, getDevicePrefs);
  const setPref = useCallback(<K extends keyof DevicePrefs>(key: K, value: DevicePrefs[K]) => {
    setDevicePref(key, value);
  }, []);
  return { prefs, setPref };
}

/**
 * 把外观与旧数据接上（在 App 根部挂一次）：
 *   - theme/accent 变化时应用到 <html>
 *   - system 模式下跟随系统明暗
 *   - 首次启动把服务端那份旧偏好迁到本机（一次性，迁完删源）
 *
 * 为什么不做成 ThemeSync 组件：以前那个组件从 `/api/settings` 拿外观，现在
 * 外观就在本机，没有任何需要"同步"的东西——多一个组件只会多一条隐式的数据路径。
 */
export function useApplyDevicePrefs(): void {
  const prefs = useSyncExternalStore(subscribeDevicePrefs, getDevicePrefs, getDevicePrefs);

  useEffect(() => {
    applyTheme(prefs.theme);
  }, [prefs.theme]);

  useEffect(() => {
    applyAccent(prefs.accent);
  }, [prefs.accent]);

  useEffect(() => {
    if (prefs.theme !== 'system') return;
    return watchSystemTheme(() => applyTheme('system'));
  }, [prefs.theme]);

  // 迁移只跑一次；失败会在下次启动重试（函数内部不写完成标记）
  useEffect(() => {
    void migrateLegacyPrefsOnce();
  }, []);
}
