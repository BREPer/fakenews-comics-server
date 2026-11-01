import { useEffect, useState } from 'react';
import { ArrowUp } from 'lucide-react';

/**
 * 回到顶部。
 *
 * 为什么需要：列表是无限滚动的（首屏 36 条，滚到底实测文档高 13032px —— 509 本的库
 * 在手机上要滑十几屏）。而全项目此前只有一处 scrollTo(0, 0)，那是路由切换时用的，
 * 不是给用户按的入口。滚动位置能恢复（ScrollManager），但「主动回顶」没有。
 *
 * 为什么挂在 AppShell 而不是各页面里：/read/:comicId/:chapterId 是独立路由、
 * 不走 AppShell，所以全屏阅读器天然不会出现这个按钮 —— 不需要额外判断路由。
 *
 * 层级取 --layer-nav（40）：比它高的 sheet(120) / modal(130) / toast(140) 都会盖在
 * 它上面，不会出现「按钮浮在弹层遮罩之上」。
 *
 * 落点为什么是「手机 5.5rem / 桌面 96px」：
 *   - 手机：底部 Tab 实测 58px 高（含 safe-area 更高），5.5rem = 88px 落在它之上。
 *   - 桌面：上移一档避开 toast。toast 容器在 sm 下是 right-6 + bottom-6，和按钮的
 *     落点完全重合，而它层级更高（140 > 40）——一条 toast 就会把按钮整个盖住 2.4 秒。
 *     96px 能让最常见的单条 toast（约占据 24~64px）不再压到它。
 */
export function BackToTop() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let raf = 0;
    const read = () => {
      raf = 0;
      /*
       * 阈值 480px，且不超过一屏。
       *
       * 不能直接用「一屏」（innerHeight）：桌面宽屏下首屏 36 张卡片排成多列，
       * 实测 1280×900 可滚动只有 648px、1440×900 也才 781px —— 都不到一屏，
       * 按一屏判这个按钮在桌面上永远不会出现，而桌面恰恰是要滚很多屏的场景。
       *
       * 也不能用「可滚动距离的比例」：无限滚动会不断把文档变高，阈值跟着涨，
       * 于是「加载更多 → 阈值变大 → 按钮消失 → 再滚 → 又出现」，来回抖。
       *
       * 480 是折中：桌面上约滚到 3/4 时出现（滚到底一定能看到它），
       * 手机（844 高）上是 0.6 屏，横屏（390 高）则退化为整屏才出现。
       */
      setShow(window.scrollY > Math.min(window.innerHeight, 480));
    };
    const onScroll = () => {
      // rAF 节流：scroll 一帧可能触发多次，setState 又是整组件重渲染
      if (!raf) raf = requestAnimationFrame(read);
    };
    read();
    window.addEventListener('scroll', onScroll, { passive: true });
    // 旋屏 / 改窗口高度会改变「一屏」的值，阈值要跟着重算
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  return (
    <button
      aria-label="回到顶部"
      // 常驻挂载、只切样式，不做条件渲染：否则「滚回顶 → 又滚下来」每次都要重播
      // 入场动画，而这个来回恰恰是最常见的用法。
      // 隐藏时必须同时摘掉可聚焦性，否则键盘 Tab 会停在一个看不见的按钮上。
      aria-hidden={!show}
      tabIndex={show ? 0 : -1}
      onClick={() => {
        // 全局那条 reduce 规则只写了 scroll-behavior: auto，管不到 JS 的
        // scrollTo({ behavior })，所以这里自己判断一次
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
      }}
      className={`fixed right-4 z-[var(--layer-nav)] grid h-11 w-11 place-items-center rounded-full
                  bg-ink-900/85 text-ink-200 shadow-panel ring-1 ring-ink-800 backdrop-blur-md
                  transition-[opacity,transform] duration-200 ease-out-quint
                  bottom-[calc(5.5rem+env(safe-area-inset-bottom))] sm:right-6 sm:bottom-24 ${
                    show
                      ? 'translate-y-0 opacity-100 active:scale-90'
                      : // 收起时下移一点：只有透明度变化的话，它看起来是「原地淡掉」而不是「沉下去」
                        'pointer-events-none translate-y-2 opacity-0'
                  }`}
    >
      <ArrowUp size={18} />
    </button>
  );
}
