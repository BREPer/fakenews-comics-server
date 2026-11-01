import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

export const MIN_SCALE = 1;
export const MAX_SCALE = 4;

type Transform = { s: number; x: number; y: number };
const IDENTITY: Transform = { s: 1, x: 0, y: 0 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * 双指缩放 + 放大后单指平移。
 *
 * 为什么不用 CSS `touch-action: pinch-zoom` 交给浏览器：那会把**整页**连工具栏一起缩放，
 * 且无法在缩放时禁用翻页。这里自己接管指针事件，只变换画布层。
 *
 * 边界处理（都是踩过坑的地方）：
 *   - 换页必须复位，否则新页会继承上一页的缩放和位移
 *   - 缩放过程中（含松手后 350ms）要吞掉随后的 click，否则松手会被当成「点右侧翻页」
 *   - 缩放 >1 时单指拖动是平移而非滑动翻页（由调用方配合 pointer-events 与 zoomed 判定）
 */
export function usePinchZoom(enabled: boolean, resetKey: string | number) {
  const [tf, setTf] = useState<Transform>(IDENTITY);
  const [pinching, setPinching] = useState(false);
  /** 最近一次手势结束时间：用于吞掉紧随其后的 click */
  const gestureEndAt = useRef(0);
  /**
   * 本次触摸序列是否发生过「真手势」（双指缩放 / 放大后单指拖动）。
   *
   * 以前只要有一根手指抬起来就记 gestureEndAt，于是**普通单击**也被记进 350ms
   * 窗口，紧随其后的 click 被 shouldSwallowClick() 吞掉——表现就是「开了双指缩放
   * 之后，单击再也呼不出菜单」。只有真手势的尾巴才需要吞。
   */
  const gestureActive = useRef(false);
  const elRef = useRef<HTMLDivElement | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchStart = useRef<{ dist: number; tf: Transform; fx: number; fy: number } | null>(null);
  const panStart = useRef<{ x: number; y: number; tf: Transform } | null>(null);

  // 换页 / 关闭开关 → 复位
  useEffect(() => {
    setTf(IDENTITY);
    pointers.current.clear();
    pinchStart.current = null;
    panStart.current = null;
    gestureActive.current = false;
  }, [resetKey, enabled]);

  const zoomed = tf.s > 1.01;

  const centerOfEl = () => {
    const r = elRef.current?.getBoundingClientRect();
    if (!r) return { cx: 0, cy: 0, w: 0, h: 0 };
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height };
  };

  const limit = (t: Transform): Transform => {
    const { w, h } = centerOfEl();
    const mx = (w * (t.s - 1)) / 2;
    const my = (h * (t.s - 1)) / 2;
    return { s: t.s, x: clamp(t.x, -mx, mx), y: clamp(t.y, -my, my) };
  };

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const { cx, cy } = centerOfEl();
        pinchStart.current = {
          dist: dist || 1,
          tf,
          fx: (a.x + b.x) / 2 - cx,
          fy: (a.y + b.y) / 2 - cy,
        };
        panStart.current = null;
        gestureActive.current = true;
        setPinching(true);
      } else if (pointers.current.size === 1 && zoomed) {
        panStart.current = { x: e.clientX, y: e.clientY, tf };
      }
    },
    [enabled, tf, zoomed],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled) return;
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      const ps = pinchStart.current;
      if (ps && pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const s = clamp((ps.tf.s * dist) / ps.dist, MIN_SCALE, MAX_SCALE);
        // 以手势中心为锚点：t2 = t1 + (s1 - s2) * f
        const k = 1 - s / ps.tf.s;
        setTf(limit({ s, x: ps.tf.x + ps.fx * k, y: ps.tf.y + ps.fy * k }));
        gestureActive.current = true;
        return;
      }

      const pn = panStart.current;
      if (pn && pointers.current.size === 1 && zoomed) {
        // 位移攒够 8px 才算「拖动」：放大状态下手指微抖不该吃掉单击
        if (Math.hypot(e.clientX - pn.x, e.clientY - pn.y) > 8) gestureActive.current = true;
        setTf(limit({ s: pn.tf.s, x: pn.tf.x + (e.clientX - pn.x), y: pn.tf.y + (e.clientY - pn.y) }));
      }
    },
    [enabled, zoomed],
  );

  const end = useCallback((e: React.PointerEvent) => {
    if (!enabled) return;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) {
      pinchStart.current = null;
      setPinching(false);
    }
    if (pointers.current.size === 0) {
      panStart.current = null;
      // 只有真手势的尾巴才记时间，普通单击不记（否则单击会被 shouldSwallowClick 吞掉）
      if (gestureActive.current) {
        gestureEndAt.current = Date.now();
        gestureActive.current = false;
      }
      setTf((t) => (t.s <= 1.02 ? IDENTITY : t)); // 放大不足 → 回弹到原始大小
    }
  }, [enabled]);

  /** 是否应该吞掉这次 click（刚结束缩放手势） */
  const shouldSwallowClick = useCallback(() => Date.now() - gestureEndAt.current < 350, []);

  const style: CSSProperties = {
    transform: `translate3d(${tf.x}px, ${tf.y}px, 0) scale(${tf.s})`,
    transformOrigin: 'center center',
    transition: pinching ? 'none' : 'transform 160ms ease-out',
    // 关闭开关时不接管触摸，保持浏览器默认（含整页缩放）
    touchAction: enabled ? 'none' : undefined,
    willChange: enabled ? 'transform' : undefined,
  };

  return {
    style,
    zoomed,
    scale: tf.s,
    bind: { ref: elRef, onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end },
    reset: () => setTf(IDENTITY),
    shouldSwallowClick,
  };
}
