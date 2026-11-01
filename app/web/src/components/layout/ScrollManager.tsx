import { useLayoutEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

const KEY = 'fakenews:scroll:';

/**
 * 滚动位置管理。
 *
 * 之前没有这层，实测的后果是：在首页滚到 y=69（文档只有 969 高，滚不动更多）后点「书架」，
 * 新页面高度更矮，浏览器把 scrollY 从 69 一路 clamp 到 4——连采样帧能看到
 * top 从 -69 → -13 → -4 连续变化，观感就是「页面打开时内容往上溜了一下」。
 *
 * 规则按导航类型分开：
 *   PUSH/REPLACE（点导航进新页）→ 回到顶部，这是「打开一个新页面」的预期；
 *   POP（浏览器后退）→ 恢复离开时记住的位置，否则从详情/阅读器退回来会丢上下文。
 */
export default function ScrollManager() {
  const { pathname, search } = useLocation();
  const nav = useNavigationType();
  const key = pathname + search;

  // 离开时记一笔（会话级就够，刷新后从头开始是合理的）。
  // 必须用 layout effect 的 cleanup：路由切换时新页面的 layout effect 会先 scrollTo(0,0)，
  // passive effect 的 cleanup 排在那之后，存到的永远是 0（POP 恢复因此从未生效）。
  useLayoutEffect(() => {
    const k = KEY + key;
    return () => {
      try {
        sessionStorage.setItem(k, String(window.scrollY));
      } catch {
        /* 隐私模式：忽略 */
      }
    };
  }, [key]);

  useLayoutEffect(() => {
    if (nav === 'POP') {
      let y = 0;
      try {
        y = Number(sessionStorage.getItem(KEY + key) ?? '') || 0;
      } catch {
        /* 忽略 */
      }
      if (!y) return;
      // 列表页大多命中 react-query 缓存、首帧就有内容；但图片行高度可能还没铺开，
      // 双 rAF 之后文档高度才稳定，直接 scrollTo 会被 clamp 回 0
      requestAnimationFrame(() => {
        requestAnimationFrame(() => window.scrollTo(0, y));
      });
      return;
    }
    // 同步执行（paint 前），否则用户会先看到旧滚动位置再被拽回顶部
    window.scrollTo(0, 0);
  }, [key, nav]);

  return null;
}
