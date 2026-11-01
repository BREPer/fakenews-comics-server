// 平移轨道（胶片式）：相邻页挂在同一条轨道上，拖动只移动轨道本身。
//
// 独立成文件的原因：这块是阅读器里状态最密集的一处（槽位 / 过渡 / 是否拖动 /
// 待提交页码 / 边界柔光），和四个 Pager 的渲染逻辑混在近千行里很难安全改动。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ReadDir } from '@/types';

/* ================= 平移翻页参数（横滑手感：1:1 跟手 + 速度/位移双阈值吸附） ================= */

/** 点击/按键翻页的整页位移时长（拆分模式的半页平移也用它，保持整屏位移手感一致） */
export const PAN_MS = 260;

/**
 * 缓动：≈ easeOutQuad。拆分模式的半页平移共用，避免同一阅读器里两套手感。
 * 不要用 cubic-bezier(0.22, 1, 0.36, 1)——那是极端 ease-out（起步吃掉大半行程、
 * 尾巴拖很长），整屏位移时观感是「窜出去再慢慢爬」，正是旧版「效果不对」的主因之一。
 */
export const PAN_EASE = 'cubic-bezier(0.22, 0.61, 0.36, 1)';

/** 松手时位移超过页宽的这个比例就翻页 */
const PAN_COMMIT_RATIO = 0.18;
/** 或者甩动速度超过这个值也算翻页（快速轻扫，px/ms） */
const PAN_COMMIT_VELOCITY = 0.5;
/** 已到首/末页还继续拖时的阻尼（橡皮筋） */
const PAN_RUBBER = 0.3;
/**
 * 橡皮筋最多能拉开多少（按页宽计）= 越界上限 × 阻尼。
 * 边缘光的亮度按「实际拉开量 / 这个上限」归一，所以手指拉满时正好最亮。
 */
const EDGE_PULL_MAX = 0.55 * PAN_RUBBER;
/**
 * 越界回弹：比翻页稍慢、带一点过冲（back-out）。
 * 翻页要利落，回弹要有「被纸边顶住又弹回来」的重量感，所以两者用不同曲线。
 */
const PAN_SETTLE_MS = 380;
const PAN_SETTLE = 'cubic-bezier(0.22, 1.24, 0.36, 1)';
/** 越界位移达到这个比例才算「确实顶到了」，否则轻碰一下不弹提示 */
const EDGE_TELL_RATIO = 0.3;
/** 位移超过这个像素才算「拖动」，否则仍当点击处理（手指抖动常到 6px） */
const PAN_DRAG_SLOP = 10;

/**
 * 拖动结束后短时间内吞掉随之而来的 click。
 *
 * 浏览器在 pointerup 之后仍会派发 click（只要按下/抬起落在同一元素上），
 * 不吞的话「滑动翻页」和「点击右侧翻页」会叠加，一次翻两页。
 */
export const dragClickGuard = { until: 0 };

/** 供阅读器外壳的 onClick 调用：返回 true 表示这次 click 是拖动的尾巴，应忽略 */
export function consumePanDragClick(): boolean {
  if (Date.now() < dragClickGuard.until) {
    dragClickGuard.until = 0;
    return true;
  }
  return false;
}

/* ================= 平移轨道（胶片式） ================= */

/**
 * 平移轨道的核心：**相邻页始终挂在同一条轨道上**，只移动轨道本身。
 *
 * 为什么不用「旧页滑出层 + 新页滑入层」两个独立图层做动画：
 *   1. 旧页那层是靠 useEffect 补挂的，比新页晚一帧 → 会先露一帧黑底；
 *   2. 两层各自跑 CSS 动画，进度无法严格对齐，观感是「两张图各走各的」；
 *   3. 旧页层级复用了带加载淡入的 <img>，滑出过程中是半透明的。
 * 轨道法把这三个问题一次性消掉：同一次布局、同一个合成层、同一段 transform。
 *
 * 位置用「槽位」计量：1 = 中间槽位（当前页）居中；0 / 2 = 左右槽位居中。
 * slots 恒定三个，轨道宽度 300%，所以 translateX 用百分比即可精确换算，
 * 不需要测量容器像素（拖拽时才需要，用 ResizeObserver 拿一次）。
 */
export function usePanTrack({
  index,
  count,
  readDir,
  enabled,
  resetKey,
  onCommit,
  onEdge,
  canEdge,
}: {
  index: number;
  count: number;
  readDir: ReadDir;
  enabled: boolean;
  /** 换章等「整段上下文变了」的场景：直接落位，不要补动画 */
  resetKey: string;
  onCommit: (i: number) => void;
  /**
   * 越过章边界：章末继续往后 / 章首继续往前拉。
   * 返回 true = 已换章（外层会改 resetKey，本 hook 随之落位）；
   * 返回 false = 整部漫画到头，由外层负责提示，这里滑回原位。
   */
  onEdge?: (forward: boolean) => boolean;
  /** 当前章之外还有没有上一章 / 下一章：决定越界处要不要橡皮筋抵抗 */
  canEdge?: { prev: boolean; next: boolean };
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const widthRef = useRef(1);
  const [pos, setPos] = useState(1);
  const posRef = useRef(1);
  const [animate, setAnimate] = useState(false);
  /** 本次过渡是否用「越界回弹」曲线（只有抵住边界那一下用） */
  const [settle, setSettle] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** 边界柔光层：--pull 直接写 DOM，不经过 React（拖动中每帧都会变） */
  const glowRef = useRef<HTMLDivElement | null>(null);

  const prevIndex = useRef(index);
  const prevReset = useRef(resetKey);
  /** 拖动松手后待提交的目标页：等吸附动画结束再翻页，否则中途换槽位会跳变 */
  const pendingCommit = useRef<number | null>(null);
  /** 本次 index 变化来自拖动提交：画面已经到位，直接落位 */
  const skipAnim = useRef(false);
  /** transitionend 兜底（目标位置恰好等于起点时不会触发过渡） */
  const fallback = useRef<number | null>(null);

  // 槽位：左 → 右。rtl（日漫右翻）镜像，保证「往后翻的那页」总在翻页方向上。
  const slots = useMemo(() => {
    const arr = readDir === 'rtl' ? [index + 1, index, index - 1] : [index - 1, index, index + 1];
    return arr.map((i) => (i >= 0 && i < count ? i : -1));
  }, [index, count, readDir]);
  const hasLeft = slots[0] >= 0;
  const hasRight = slots[2] >= 0;
  /**
   * 左槽位是不是「下一页」：rtl（日漫右翻）时槽位是镜像的，
   * 于是同一侧在两种阅读方向下对应相反的翻页方向。
   * 拖出与换章都要按这个换算，否则 rtl 下会「往回拖却进了下一章」。
   */
  const leftIsNext = readDir === 'rtl';
  const canEdgePrev = canEdge?.prev ?? false;
  const canEdgeNext = canEdge?.next ?? false;
  /** 这一侧能不能拖出去：有相邻页，或者虽然没有相邻页但还有相邻章 */
  const canGoLeft = hasLeft || (leftIsNext ? canEdgeNext : canEdgePrev);
  const canGoRight = hasRight || (leftIsNext ? canEdgePrev : canEdgeNext);

  useLayoutEffect(() => {
    posRef.current = pos;
  }, [pos]);

  // 容器宽度（拖动位移按像素换算，槽位宽 = 容器宽）。
  // 依赖 enabled：拆分模式在别的动画偏好下不挂轨道，切到「平移」时才换成轨道容器，
  // 只测量一次的话 widthRef 会停在空节点时的 1px，拖动距离就会被放大成几十页。
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      widthRef.current = el.clientWidth || 1;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [enabled]);

  /**
   * index 变化统一在这里变成动画。
   * 好处是「点击 / 键盘 / 音量键 / 页码滑块 / 章间跳转 / 拖动提交」全部走同一条路径，
   * 不会出现某一种入口没有动画。
   */
  useLayoutEffect(() => {
    if (prevReset.current !== resetKey) {
      prevReset.current = resetKey;
      prevIndex.current = index;
      setSettle(false);
      setAnimate(false);
      setPos(1);
      return;
    }
    const prev = prevIndex.current;
    if (prev === index) return;
    prevIndex.current = index;

    if (skipAnim.current) {
      skipAnim.current = false;
      setSettle(false);
      setAnimate(false);
      setPos(1);
      return;
    }
    const from = slots.indexOf(prev);
    if (!enabled || from < 0) {
      // 跳转（滑块/跨章联动/超过一页的位移）或未启用平移：不做横滑
      setSettle(false);
      setAnimate(false);
      setPos(1);
      return;
    }
    // 先用「无过渡」把画面摆回旧页所在槽位，下一帧再过渡到居中
    setAnimate(false);
    setPos(from);
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        setSettle(false);
        setAnimate(true);
        setPos(1);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [index, resetKey, enabled, slots]);

  useEffect(
    () => () => {
      if (fallback.current) window.clearTimeout(fallback.current);
      if (posRaf.current) cancelAnimationFrame(posRaf.current);
    },
    [],
  );

  const finishCommit = useCallback(
    (target: number) => {
      if (fallback.current) {
        window.clearTimeout(fallback.current);
        fallback.current = null;
      }
      skipAnim.current = true;
      onCommit(target);
    },
    [onCommit],
  );

  const onTransitionEnd = useCallback(
    (e: React.TransitionEvent) => {
      if (e.target !== e.currentTarget) return;
      if (e.propertyName !== 'transform') return;
      const target = pendingCommit.current;
      if (target == null) return;
      pendingCommit.current = null;
      finishCommit(target);
    },
    [finishCommit],
  );

  /* ---------------- 拖动 ---------------- */
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    lastX: number;
    lastT: number;
    vx: number;
    moved: boolean;
    startPos: number;
  } | null>(null);
  const pointers = useRef(0);

  /**
   * 拖动中的位置更新：rAF 合并 + 直接写 posRef。
   *
   * pointermove 在触屏上能到 120Hz，原来每个事件都 setState，于是 SinglePager 与三个
   * 槽位每帧重渲染两次；其中真正变的只有轨道的一个 transform。
   * 现在 pointermove 只改 ref，rAF 里每帧最多 setPos 一次；
   * posRef 立刻生效是为了 endDrag 的位移/速度判定能读到最新位置。
   */
  const posRaf = useRef(0);
  const queuePos = useCallback((v: number) => {
    posRef.current = v;
    if (posRaf.current) return;
    posRaf.current = requestAnimationFrame(() => {
      posRaf.current = 0;
      setPos(posRef.current);
    });
  }, []);

  /** 取消未执行的 rAF（松手/换页时由后续显式 setPos 接管） */
  const cancelQueuedPos = useCallback(() => {
    if (posRaf.current) {
      cancelAnimationFrame(posRaf.current);
      posRaf.current = 0;
    }
  }, []);

  /**
   * 边界柔光：side = 被拉开的那一侧（物理方向，不是阅读方向）。
   * 直接写 style.customProperty，避免拖动中每帧 setState 触发整条轨道重渲染。
   * amount=0 且不传 side 时只把 --pull 归零，CSS 的 opacity transition 负责收光。
   */
  const applyPull = useCallback((side: 'left' | 'right' | null, amount: number) => {
    const el = glowRef.current;
    if (!el) return;
    if (side) el.dataset.side = side;
    el.style.setProperty('--pull', amount > 0 ? amount.toFixed(3) : '0');
  }, []);

  const snapBack = useCallback(
    (spring = false) => {
      setSettle(spring);
      setAnimate(true);
      setPos(1);
    },
    [],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if (!enabled || pendingCommit.current != null) return;
    pointers.current += 1;
    if (pointers.current > 1) {
      // 第二根手指落下 = 用户想缩放，交还给缩放手势；把已拖出的位移弹回
      if (drag.current) {
        drag.current = null;
        setDragging(false);
        snapBack();
      }
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    setSettle(false);
    applyPull(null, 0);
    const now = performance.now();
    drag.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      lastX: e.clientX,
      lastT: now,
      vx: 0,
      moved: false,
      startPos: posRef.current,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved) {
      // 起手先判方向：明显是竖划就放行（避免和纵向滚动/缩放手势打架）
      if (Math.abs(dx) < PAN_DRAG_SLOP || Math.abs(dx) <= Math.abs(dy)) return;
      d.moved = true;
      setDragging(true);
      setAnimate(false);
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    }
    const now = performance.now();
    const dt = now - d.lastT;
    if (dt > 0) d.vx = (e.clientX - d.lastX) / dt; // px/ms，正 = 手指向右
    d.lastX = e.clientX;
    d.lastT = now;

    // 手指向右 → 轨道右移 → 露出左边那页 → 槽位值变小
    let next = d.startPos - dx / widthRef.current;
    // 抵抗只在「真没东西了」时出现：章末还有下一章时要能顺畅拖出去，
    // 否则手感是「拖到章末像撞墙」，用户根本不知道松手就能换章
    if (next < 1 && !canGoLeft) {
      next = 1 + (next - 1) * PAN_RUBBER;
      // pos 变小 = 轨道整体右移 = 左边被拉开一道缝
      applyPull('left', Math.min(1, (1 - next) / EDGE_PULL_MAX));
    } else if (next > 1 && !canGoRight) {
      next = 1 + (next - 1) * PAN_RUBBER;
      applyPull('right', Math.min(1, (next - 1) / EDGE_PULL_MAX));
    } else {
      applyPull(null, 0);
    }
    queuePos(Math.max(-0.6, Math.min(2.6, next)));
  };

  const endDrag = (e: React.PointerEvent) => {
    // 拖动中排队的位置更新到此为止：下面每个分支都会显式 setPos，直接接管
    cancelQueuedPos();
    pointers.current = Math.max(0, pointers.current - 1);
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) {
      setDragging(false);
      return; // 只是一次点击：交给外层 onClick
    }
    setDragging(false);
    // 真实拖动过：吞掉随后的 click
    dragClickGuard.until = Date.now() + 350;

    const moved = posRef.current - 1; // <0 = 正在往左槽位走
    let toward: -1 | 1 | 0 = 0;
    if (Math.abs(d.vx) >= PAN_COMMIT_VELOCITY) {
      toward = d.vx > 0 ? -1 : 1; // 快扫以速度为准（指尖向右 → 看左槽位）
    } else if (Math.abs(moved) >= PAN_COMMIT_RATIO) {
      toward = moved < 0 ? -1 : 1;
    }

    const target = toward === -1 ? slots[0] : toward === 1 ? slots[2] : -1;
    if (toward === 0) {
      applyPull(null, 0);
      snapBack(); // 距离/速度不够：弹回
      return;
    }

    /* 整本到头（这一侧既没有相邻页，也没有相邻章）。
       以前和「章末还有下一章」共用一条路径：先 setPos(0|2) 把整页滑出去
       （空槽是黑底），等 260ms 才发现换不了章再滑回来 —— 观感是「先闪黑、再抖一下」。
       现在知道这侧真的没东西，就直接抵住回弹：光带收光 + 380ms 带过冲的回位，
       位移够大时才调 onEdge 让外层弹提示（轻碰一下不打扰）。 */
    const canGo = toward === -1 ? canGoLeft : canGoRight;
    if (target < 0 && !canGo) {
      const forward = toward === 1 ? !leftIsNext : leftIsNext;
      const pulled = Math.min(1, Math.abs(posRef.current - 1) / EDGE_PULL_MAX);
      applyPull(null, 0);
      snapBack(true);
      if (pulled >= EDGE_TELL_RATIO) onEdge?.(forward);
      return;
    }

    applyPull(null, 0);
    if (target < 0) {
      /*
       * 该侧槽位是空的（章首/章末），但**还有相邻章**。以前一律弹回，于是
       * 「平移模式下怎么拖都换不了章」—— 点击与键盘能换章，因为它们走 ReaderShell.turn()，
       * 而拖动走的是这里的 onCommit（只翻页）。
       * 现在把这一下交给外层：
       *   先把轨道滑出去（视觉上「翻出去了」），动画结束后问外层能否换章；
       *   能换 → 外层改章，resetKey 变化让本 hook 落位到新章首页；
       *   不能换（整部漫画到头）→ 滑回原位，外层同时给「已经是第一页/最后一页」的提示。
       */
      const forward = toward === 1 ? !leftIsNext : leftIsNext;
      if (!onEdge) {
        snapBack();
        return;
      }
      pendingCommit.current = null;
      setSettle(false);
      setAnimate(true);
      setPos(toward === -1 ? 0 : 2);
      fallback.current = window.setTimeout(() => {
        fallback.current = null;
        if (!onEdge(forward)) snapBack(true);
      }, PAN_MS);
      return;
    }
    // 吸附到相邻槽位，动画结束再提交页码
    pendingCommit.current = target;
    setSettle(false);
    setAnimate(true);
    setPos(toward === -1 ? 0 : 2);
    fallback.current = window.setTimeout(() => {
      const t = pendingCommit.current;
      pendingCommit.current = null;
      if (t != null) finishCommit(t);
    }, PAN_MS + 140);
  };

  /** pointercancel = 手势被系统/浏览器打断，不能按「松手提交」处理 */
  const cancelDrag = (e: React.PointerEvent) => {
    cancelQueuedPos();
    pointers.current = Math.max(0, pointers.current - 1);
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    applyPull(null, 0);
    if (d.moved) snapBack();
  };

  /**
   * 松手发生在元素外时收不到 pointerup（未拖动过就没有 setPointerCapture），
   * pointers 会永久停在 1；下一次按下被当成第二根手指 → 平移彻底失效。
   * 挂在 window 冒泡阶段兜底：元素内正常松手时 endDrag 已清掉 drag，这里只补计数。
   */
  useEffect(() => {
    if (!enabled) return;
    const release = () => {
      pointers.current = 0;
      if (!drag.current) return;
      drag.current = null;
      setDragging(false);
      applyPull(null, 0);
      snapBack();
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('blur', release);
    };
  }, [enabled, applyPull, snapBack]);

  const handlers = enabled
    ? {
        onPointerDown,
        onPointerMove,
        onPointerUp: endDrag,
        onPointerCancel: cancelDrag,
      }
    : {};

  const trackStyle: CSSProperties = {
    // 轨道宽度是容器的 300%（三个槽位），所以 -pos/3 * 100% 就等于「移动 pos 个槽位」
    transform: `translate3d(${(-pos / 3) * 100}%, 0, 0)`,
    transition: animate
      ? `transform ${settle ? PAN_SETTLE_MS : PAN_MS}ms ${settle ? PAN_SETTLE : PAN_EASE}`
      : 'none',
  };

  return { wrapRef, glowRef, slots, dragging, handlers, trackStyle, onTransitionEnd };
}
