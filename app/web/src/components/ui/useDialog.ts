/**
 * 弹层的键盘与读屏支持（Sheet / ConfirmDialog 共用）。
 *
 * 之前这三件事全都没有：
 *   1. **Esc 关不掉**——桌面用户按 Esc 毫无反应，只能去点右上角那个「关闭」；
 *   2. **焦点不进来**——打开面板后焦点还停在背后的按钮上，Tab 一下直接跑到页面里，
 *      键盘用户等于被「困在面板外面」，读屏也读不到面板内容；
 *   3. **没有 dialog 语义**——读屏不会播报「这是一个对话框」，也不知道它是模态的。
 *
 * 另外补了 Tab 循环：面板外的元素本来就是视觉上被遮住的，焦点不该往那儿跑。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * 弹层的「挂载 / 显隐」状态机（Sheet / ConfirmDialog 共用）。
 *
 * 为什么要拆成 mounted + show 两个状态：入场过渡必须有起点。元素得先以「关闭态」
 * 插入 DOM 并被浏览器算过一次样式，再切到「打开态」，transition 才有可插值的起点；
 * 直接以打开态插入的话没有起点，过渡不触发，面板就是「啪地一下出现」。
 *
 * 关键在**什么时机切换**，这里换过两版，都是实测踩出来的：
 *
 *   1. **不能用双 rAF**（第一版）。`rAF(() => rAF(() => setShow(true)))` 假定
 *      「两帧之内 React 一定已经把面板提交进 DOM」——CPU 忙的时候这个假定不成立，
 *      两层 rAF 跑完了元素还没插入，于是它是以「打开态」第一次出现的：没有起点、
 *      没有动画。手机端最容易命中：390x844 + 触摸下实测 4x 节流丢 2/10、6x 节流丢
 *      3/10（逐帧采样显示 ty 恒为 0，首帧就在终态）。桌面 1280x900 同样压到 20x
 *      却一次没丢——手机是 DPR2 + mobile 合成路径，两层 backdrop-filter 贵得多。
 *      在 rAF 回调里补一次强制 reflow 也救不回来：面板那时可能根本还没插入。
 *   2. **也不能只靠 cleanup 取消**（第二版打的补丁）。React 对非离散更新会异步
 *      调度 effect，cleanup 可能晚于内层 rAF 才执行，那时取消已经没意义。
 *
 *   现在：**在 layout effect 里切换**。它运行在 DOM 插入之后、绘制之前，元素此时
 *   一定在文档里；先读一次布局属性强迫浏览器完成 style + layout（把「关闭态」的
 *   transform 真正算出来），紧接着切到「打开态」，过渡必然触发。不依赖任何帧时序，
 *   上面两个竞态也就不存在了。
 *
 * 另外：**兜底卸载时长必须 ≥ CSS 的 transition 时长**，两者写在一起。原来是各自
 * 硬编码的数字（Sheet 320/320、Dialog 240/200），改了 CSS 忘了改数字的话，面板会
 * 在动画没跑完时被卸载——退出动画被截断。
 */
export function usePresence(open: boolean, exitMs: number) {
  const [mounted, setMounted] = useState(open);
  const [show, setShow] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    setShow(false);
    const t = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(t);
  }, [open, exitMs]);

  /*
   * 入场切换：见上面注释。两个条件缺一不可——
   *   - 必须是 layout effect：此时面板已经在文档里，读布局才有意义；
   *   - 必须先读一次布局属性：否则「关闭态」的 transform 从未被计算过，
   *     浏览器看到的是「从无到 translateY(0)」，同样不会有过渡。
   */
  useLayoutEffect(() => {
    if (!mounted || !open || show) return;
    void document.body.offsetHeight;
    if (openRef.current) setShow(true);
  }, [mounted, open, show]);
  /*
   * 给过渡结束用：退出过渡跑完就可以立刻卸载，不必等兜底定时器。
   * 调用方需要在 !open 时才调它（入场过渡也会触发 transitionend）。
   */
  const unmount = useCallback(() => setMounted(false), []);
  return { mounted, show, unmount };
}

/*
 * 背景滚动锁的引用计数。
 *
 * 为什么需要计数：Sheet 里还能再开 ConfirmDialog（比如「编辑漫画库」面板里点删除），
 * 两层都上锁。如果各自只管自己，关掉里层那个就会提前解锁——外层的面板还开着，
 * 背景却已经能滚了。
 */
let lockCount = 0;
let savedOverflow = '';
let savedPaddingRight = '';

/**
 * body 的 content-box 宽度。
 *
 * 滚动锁的补偿量只能靠它来量：`window.innerWidth - html.clientWidth` 这个常见口径
 * 在本项目里是错的 —— 根元素上有 `scrollbar-gutter: stable`（index.css），锁滚动时
 * 滚动条槽位并不会被回收，`clientWidth` 却会从 2552 跳到 2560（= innerWidth），
 * 于是「视口变宽了 8px」是假象，按它补 padding 就是重复扣减。
 *
 * 全屏 2560×1440 实测（页面内容 max-w-7xl 居中，锁前 main.left=748）：
 *   - 只设 overflow:hidden            → body 内容盒 2552 不变、main.left 748 不变
 *   - 再补 8px padding-right          → body 内容盒 2544、main.left 744  ← 整体左移 4px
 * 这 4px 就是「点新建/编辑/上传时页面横向抖一下」的真身；窄窗口下内容满宽、只在右侧
 * 让出 8px，所以看不出来，一到全屏居中布局就暴露。
 */
function bodyContentWidth(body: HTMLElement): number {
  const cs = getComputedStyle(body);
  return body.getBoundingClientRect().width - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0');
}

/**
 * 弹层打开期间锁住背景滚动。
 *
 * 之前完全没有：面板开着时用滚轮 / 手指滑动，背后的页面照样滚，
 * 关掉面板后发现"位置变了"——尤其是书库这种无限列表，滚走了就得重新找。
 *
 * 滚动条补偿不再"猜"，而是**实测**：先记下 body 内容盒宽，锁滚动后再量一次，
 * 差值就是真的被回收掉的宽度（gutter 生效时为 0，老浏览器上是 8），按差值补。
 * 两次量测在同一帧内完成，浏览器不会绘出中间态，所以不会引入新的闪动。
 *
 * 计数：见上面的 lockCount，支持弹层叠加。
 *
 * 已知边界：iOS Safari 上 overflow:hidden 挡不住橡皮筋回弹，只能挡住常规滚动。
 * 面板内容区另有 overscroll-contain，滚到底不会把整页带走。
 */
export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const html = document.documentElement;
    const body = document.body;
    if (lockCount === 0) {
      savedOverflow = html.style.overflow;
      savedPaddingRight = body.style.paddingRight;
      // 顺序很重要：先量、后锁、再量差。反过来就测不到「锁滚动到底吃掉了多少宽度」。
      const before = bodyContentWidth(body);
      html.style.overflow = 'hidden';
      const lost = before - bodyContentWidth(body);
      if (lost > 0) {
        const cur = parseFloat(getComputedStyle(body).paddingRight || '0') || 0;
        body.style.paddingRight = `${cur + lost}px`;
      }
    }
    lockCount += 1;
    return () => {
      lockCount -= 1;
      if (lockCount === 0) {
        html.style.overflow = savedOverflow;
        body.style.paddingRight = savedPaddingRight;
      }
    };
  }, [active]);
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useDialogA11y<T extends HTMLElement>(
  open: boolean,
  onClose: () => void,
  /** 危险操作进行中：Esc 不生效（避免「按一下 Esc 把正在删的东西关掉」的错觉） */
  disabled = false,
) {
  const ref = useRef<T>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  // 回调每次渲染都是新箭头函数，直接进依赖会让监听器反复重挂（滚动中尤其容易漏事件）
  const closeRef = useRef(onClose);
  const disabledRef = useRef(disabled);
  useEffect(() => {
    closeRef.current = onClose;
    disabledRef.current = disabled;
  }, [onClose, disabled]);

  // 焦点：进入时移入面板，退出时还给原来的元素
  useEffect(() => {
    if (!open) return;
    restoreRef.current = (document.activeElement as HTMLElement | null) ?? null;
    /*
     * Sheet / ConfirmDialog 都是「open 变 true 之后组件才真正挂载」的两段式渲染
     * （先 setMounted(true) 再出 DOM），本 effect 触发时 ref.current 还是 null，
     * 一次性 focus 会静默失败 —— 实测焦点停在背后的导航上，Tab 一出面板就跑到页面里。
     * 所以退回几帧内重试，拿到节点就聚焦。
     */
    let raf = 0;
    let tries = 0;
    const tryFocus = () => {
      const panel = ref.current;
      if (panel) {
        const target = panel.querySelector<HTMLElement>('[data-autofocus]') ?? panel;
        target.focus({ preventScroll: true });
        if (panel.contains(document.activeElement)) return;
      }
      if (tries++ < 12) raf = requestAnimationFrame(tryFocus);
    };
    raf = requestAnimationFrame(tryFocus);
    return () => {
      cancelAnimationFrame(raf);
      // 还焦点时用 preventScroll：抽屉关闭瞬间页面可能已经在滚动，"抢回焦点"
      // 会把视口拽回去，用户看到的是「关掉面板页面跳了一下」
      const back = restoreRef.current;
      if (back && document.contains(back)) back.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (disabledRef.current) return;
        // 阻止继续冒泡：阅读器自己也监听 Esc（退出阅读），别一次按两件事
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = ref.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      if (items.length === 0) {
        e.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === panel || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      }
    };
    // 捕获阶段：面板里的输入框（比如搜索）自己处理 Esc 时先让它们过一遍
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  return ref;
}
