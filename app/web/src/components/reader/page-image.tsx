// 页图与共用件：单页 URL 构造、预加载池（含解码预热）、适应方式、单图组件。
//
// 预加载池是模块级 Map —— 必须长期持有 Image 引用，否则未完成的请求会被 GC 取消。
import { memo, useEffect, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { api } from '@/api/client';
import type { FitMode, PageMeta, Quality } from '@/types';

/* ---------------- 通用：URL / 预加载 / 适应方式 / 单图 ---------------- */

/** 构造单页 URL（standard=缩略图 / original=原图 Range） */
export function pageUrl(
  comicId: string,
  chapterId: string,
  index: number,
  quality: Quality,
): string {
  // 服务端只有两档契约：standard（按 w 缩放）/ original（原字节 Range）。
  // 「流畅」在客户端映射为更小的目标宽度（720），不新增后端契约。
  if (quality === 'original') return api.pageUrl(comicId, chapterId, index, 'original');
  const w = quality === 'smooth' ? 720 : 1080;
  return api.pageUrl(comicId, chapterId, index, 'standard', w);
}

/**
 * 预加载池：模块级持有 Image 引用 + 预热解码。
 *
 * 之前是在 effect 里 `const imgs = []` 存局部数组，effect 一结束引用就没了——
 * 未完成的请求可能被 GC 连带取消；更关键的是**没有解码预热**：平移翻页时
 * 新页的 <img> 是全新挂载的（轨道按页号做 key，slot 会新加一格），即使命中
 * HTTP 缓存，浏览器仍要重新解码，那一帧画不出来，就是用户看到的「新一页短暂空白」。
 *
 * 这里做两件事：
 *   ① 长期持有引用（上限 PRELOAD_KEEP），预加载请求不会中途被取消；
 *   ② decode() 把解码结果预热进缓存，新 <img> 挂载时可直接绘制。
 */
// PRELOAD_KEEP 是「长期持有引用」的上限，每个 HTMLImageElement 都握着**解码后的
// 位图**：1080 宽的页图约 1080×1600×4B ≈ 7MB，24 张就是 170MB 量级。
// 手机 WebView 上这会明显推高内存（被系统杀进程的常见原因），
// 而真正同时需要覆盖的只有「当前页 ± 预加载页数（默认 3、最大 8）」，
// 12 已经足够往回翻一页仍命中，同时把常驻内存压到 ~84MB。
const PRELOAD_KEEP = 12;
const preloadPool = new Map<string, HTMLImageElement>();

/** 退出阅读器时释放：引用一放，解码位图才可能被回收 */
export function releasePreloadPool(): void {
  preloadPool.clear();
}

function preloadOne(url: string): void {
  const existing = preloadPool.get(url);
  if (existing) {
    // 命中：移到队尾（LRU），否则「往回翻一页」时它可能恰好是被淘汰的那个
    preloadPool.delete(url);
    preloadPool.set(url, existing);
    return;
  }
  const im = new Image();
  im.decoding = 'async';
  im.src = url;
  preloadPool.set(url, im);
  // decode() 失败不影响正常加载（<img> 自己会继续走 onLoad）
  im.decode?.().catch(() => { /* 忽略 */ });
  // 超出上限：丢最早的引用（HTTP 缓存仍在，只是不再阻止 GC）
  while (preloadPool.size > PRELOAD_KEEP) {
    const oldest = preloadPool.keys().next().value;
    if (!oldest) break;
    preloadPool.delete(oldest);
  }
}

/** 单独预取某一页（跨章预热用：章末提前把下一章首页拉进缓存） */
export function preloadPage(comicId: string, chapterId: string, index: number, quality: Quality): void {
  preloadOne(pageUrl(comicId, chapterId, index, quality));
}

/** 预加载前后 N 页（创建 Image 对象利用浏览器缓存 + 预热解码） */
export function usePreloader(
  comicId: string,
  chapterId: string,
  pages: PageMeta[],
  current: number,
  count: number,
  quality: Quality,
): void {
  useEffect(() => {
    if (count <= 0 || pages.length === 0) return;
    // 双页最后一跨的右页下标可能正好等于 pages.length（奇数页），
    // 直接预热会稳定打出一个 404；夹到末页后仍能把左页拉进缓存。
    const cur = Math.max(0, Math.min(current, pages.length - 1));
    // 当前页也预热：续读进入时 pageIndex 可能直接是第 N 页，它不在「前后 N 页」里，
    // 而 <img loading=eager> 要等挂载后才发请求 —— 先经池子发起，落进 HTTP 缓存，
    // 首屏那张图能早一个往返出来（卷轴模式尤其明显，见 WebtoonPager 的定位注释）
    preloadOne(pageUrl(comicId, chapterId, cur, quality));
    for (let i = cur + 1; i <= Math.min(pages.length - 1, cur + count); i++) {
      preloadOne(pageUrl(comicId, chapterId, i, quality));
    }
    // 回看一页（翻回去不白屏）
    if (cur > 0) {
      preloadOne(pageUrl(comicId, chapterId, cur - 1, quality));
    }
    // 不在这里清空/释放：preloadPool 长期持有引用，未完成的请求不会被取消
  }, [comicId, chapterId, pages.length, current, count, quality]);
}

export const FIT_CLASS: Record<FitMode, string> = {
  width: 'h-auto w-full',
  // 高度：按视口高度铺满、宽度等比（横向可能超出被裁切）。
  // 必须 max-w-none，否则被 Tailwind preflight 的全局 img{max-width:100%} 截断宽度，导致被拉长变形
  height: 'h-full w-auto max-w-none',
  // 完整：铺满容器并等比缩放（可放大/缩小），整图完整可见；横向跨页图也不会被裁切
  contain: 'h-full w-full object-contain',
  // 原始：按图片原生像素显示（1:1），不放大也不缩小；配合单页模式的滚动容器查看细节
  original: 'h-auto w-auto max-w-none max-h-none object-none',
};

/** 单图（加载淡入 + 适应方式）。memo：拖动中轨道每帧重渲染，页图 props 不变就不必重算 */
export const PageImage = memo(function PageImage({
  src,
  alt,
  fit,
  className = '',
  priority = 'auto',
  fadeIn = true,
  pageNumber,
}: {
  src: string;
  alt: string;
  fit: FitMode;
  className?: string;
  /** 当前页给 high，轨道里的邻页给 low：让首图先占带宽，而不是和预加载抢 */
  priority?: 'high' | 'low' | 'auto';
  /**
   * 加载完是否淡入（默认开）。
   *
   * 平移轨道的邻页必须关掉：那里每个槽位都按页号做 key，滑进来的新页是**全新挂载**的
   * <img>，loaded 初始为 false → 会从 opacity:0 用 150ms 渐变到 1。而轨道动画只有 260ms，
   * 于是「翻页过程中新页是半透明的、透出黑底」，看起来像图在发灰闪烁。
   * 轨道是胶片语义：相邻格子本来就该是实心的。
   */
  fadeIn?: boolean;
  /** 失败提示里显示「第 N 页」，没有就只说「这一页」 */
  pageNumber?: number;
}) {
  const [loaded, setLoaded] = useState(false);
  /**
   * 加载失败态。
   *
   * 之前**完全没有 onError**：压缩包里某张图损坏 / 服务端 415 时，<img> 永远停在
   * opacity:0 —— 用户看到的是一整屏纯黑，分不清「这页就是黑的」还是「还在加载」还是
   * 「应用卡死了」，只能往前翻再翻回来碰运气。现在给一块说明 + 一键重试。
   *
   * 重试靠给 URL 加 `?retry=N` 绕开 HTTP 缓存：同一个 URL 再请求一次很可能还是拿
   * 缓存的失败结果（有些浏览器会把失败的图片响应也缓存住）。
   */
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const imgRef = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    // 命中浏览器缓存时 load 可能先于 effect 派发；这里若无条件压回 false，
    // 之后不会再有第二次 load，页图就永远停在 opacity:0（整屏黑）。
    const el = imgRef.current;
    const cached = !!el && el.complete && el.naturalWidth > 0;
    setLoaded(cached);
    setFailed(!!el && el.complete && el.naturalWidth === 0);
    setAttempt(0);
  }, [src]);

  if (failed) {
    return (
      <div className="flex max-h-full min-h-24 w-full max-w-full flex-col items-center justify-center gap-2 px-6 text-center">
        <ImageOff size={22} className="text-white/35" />
        <p className="text-xs text-white/60">
          {pageNumber !== undefined ? `第 ${pageNumber} 页` : '这一页'}没能显示
        </p>
        <p className="text-[11px] leading-relaxed text-white/35">
          图片可能已损坏或格式不支持，跳过这一页不影响后面的阅读
        </p>
        <button
          className="mt-1 rounded-lg bg-white/10 px-3 py-1.5 text-[11px] text-white/80 ring-1 ring-white/15
                     transition-colors duration-150 hover:bg-white/15"
          // 阅读器的「点击切工具栏」和横滑翻页都监听在容器上，必须拦住，
          // 否则点一下重试会顺带翻页或弹出工具栏
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setFailed(false);
            setAttempt((n) => n + 1);
          }}
        >
          重新加载
        </button>
      </div>
    );
  }

  const url = attempt > 0 ? `${src}${src.includes('?') ? '&' : '?'}retry=${attempt}` : src;
  return (
    <img
      ref={imgRef}
      src={url}
      alt={alt}
      decoding="async"
      loading="eager"
      fetchPriority={priority}
      onLoad={() => setLoaded(true)}
      onError={() => setFailed(true)}
      className={`${FIT_CLASS[fit]} shrink-0 select-none ${
        fadeIn ? `transition-opacity duration-150 ${loaded ? 'opacity-100' : 'opacity-0'}` : ''
      } ${className}`}
      draggable={false}
    />
  );
});
