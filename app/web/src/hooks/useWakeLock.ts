import { useEffect } from 'react';

/**
 * 屏幕常亮（Screen Wake Lock API）。
 *
 * 之前「保持常亮」只是个设置开关：字段和 UI 都在，但**从来没调用过 Wake Lock**，
 * 用户开了照样息屏。这里补上实际实现。
 *
 * 几个必须处理的细节：
 *   - 浏览器会在页面切到后台时自动释放唤醒锁，回前台要**重新申请**（否则切一次标签页就失效）
 *   - API 不存在（桌面 Firefox / 部分 WebView）或申请被策略拒绝时**静默降级**，不能抛错打断阅读
 *   - 组件卸载要释放，否则离开阅读器后屏幕一直亮着，白耗电
 */
export function useWakeLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;

    type Sentinel = { release: () => Promise<void>; released?: boolean };
    type WakeLockNav = { wakeLock?: { request: (type: 'screen') => Promise<Sentinel> } };

    let sentinel: Sentinel | null = null;
    let disposed = false;

    const request = async () => {
      const nav = navigator as unknown as WakeLockNav;
      if (!nav.wakeLock?.request) return; // 不支持 → 静默降级
      try {
        const s = await nav.wakeLock.request('screen');
        if (disposed) {
          void s.release().catch(() => undefined);
          return;
        }
        sentinel = s;
      } catch {
        // 常见原因：页面不可见 / 非用户手势触发 / 系统省电策略拒绝。
        // 都属于「拿不到就别管」，不影响阅读。
        sentinel = null;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void request();
    };

    void request();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      const s = sentinel;
      sentinel = null;
      if (s) void s.release().catch(() => undefined);
    };
  }, [enabled]);
}
