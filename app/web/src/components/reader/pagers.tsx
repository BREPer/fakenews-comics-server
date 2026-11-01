// 四种翻页模式的渲染层：单页 / 双页 / 拆分双页 / 卷轴。
//
// 共用件已拆出：平移轨道见 pan-track.ts，页图与预加载见 page-image.tsx。
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ImageOff } from 'lucide-react';
import type { FitMode, PageMeta, Quality, ReadDir } from '@/types';
import { doubleSpreads } from '@/utils/pagerMode';
import { consumePanDragClick, dragClickGuard, PAN_EASE, PAN_MS, usePanTrack } from './pan-track';
import { PageImage, pageUrl, usePreloader } from './page-image';

export type PageAnimation = 'pan' | 'slide' | 'fade' | 'none';

// 阅读器外壳与横滑侦测共用：吞掉拖动尾随的 click（一次手势别翻两页）
export { consumePanDragClick };

/** 非平移模式下的翻页动画（slide / fade / none） */
function pageAnim(
  animation: PageAnimation,
  forward: boolean,
  readDir: ReadDir,
): { className: string; style?: CSSProperties } {
  if (animation === 'fade') return { className: 'anim-page-fade' };
  if (animation === 'none' || animation === 'pan') return { className: '' };
  // slide：新页从「翻页方向」那侧滑入；rtl 时镜像，贴合日漫右翻的视觉流向
  let dx = forward ? 32 : -32;
  if (readDir === 'rtl') dx = -dx;
  return { className: 'anim-page-slide', style: { '--dx': `${dx}px` } as unknown as CSSProperties };
}

/* ---------------- 单页 ---------------- */
export function SinglePager({ comicId, chapterId, pages, pageIndex, onPageChange, quality, fit, readDir, preloadCount, animation, onEdge, hasPrevChapter, hasNextChapter }: PagerProps) {
  usePreloader(comicId, chapterId, pages, pageIndex, preloadCount, quality);
  // 「原始」适配下容器可滚动，横滑会与滚动抢手势 → 该模式退回轻移
  const isOriginal = fit === 'original';
  const panOn = animation === 'pan' && !isOriginal;
  const track = usePanTrack({
    index: pageIndex,
    count: pages.length,
    readDir,
    enabled: panOn,
    resetKey: `${comicId}/${chapterId}`,
    onCommit: onPageChange,
    onEdge,
    canEdge: { prev: !!hasPrevChapter, next: !!hasNextChapter },
  });

  const dirRef = useRef(pageIndex);
  const forward = pageIndex >= dirRef.current;
  dirRef.current = pageIndex;
  const anim = pageAnim(animation, forward, readDir);
  const touch = useSwipe((dir) => {
    const delta = dir === 'next' ? (readDir === 'rtl' ? -1 : 1) : readDir === 'rtl' ? 1 : -1;
    const next = pageIndex + delta;
    // 越界不再默默 clamp：章末/章首继续滑 → 交给外层换章
    if (next < 0 || next >= pages.length) {
      onEdge?.(delta > 0);
      return;
    }
    onPageChange(next);
  });

  if (panOn) {
    return (
      <div
        ref={track.wrapRef}
        className="pan-surface relative h-full w-full overflow-hidden"
        {...track.handlers}
      >
        <div
          className="pan-track flex h-full w-[300%]"
          style={track.trackStyle}
          onTransitionEnd={track.onTransitionEnd}
        >
          {track.slots.map((p, slot) => (
            <div
              // 关键：按「页号」做 key 而不是槽位序号。
              // 用槽位序号时，翻一页会让每个槽位的页号都变 → img 元素被重建 →
              // PageImage 的 loaded 复位 → 正在滑动的两页一起从不透明淡入（闪白/半透）。
              // 用页号做 key，React 只移动同一个节点，图片保持已加载。
              key={p >= 0 ? `pg-${p}` : `empty-${slot}`}
              data-slot={slot}
              data-page={p}
              className="pan-slot flex h-full w-1/3 shrink-0 items-center justify-center"
            >
              {p >= 0 && (
                <PageImage
                  src={pageUrl(comicId, chapterId, p, quality)}
                  alt={`page ${p + 1}`}
                  fit={fit}
                  priority={p === pageIndex ? 'high' : 'low'}
                  pageNumber={p + 1}
                  // 轨道里的页要实心滑入，淡入会让滑动过程透出黑底（见 PageImage 注释）
                  fadeIn={false}
                />
              )}
            </div>
          ))}
        </div>
        {/* 边界柔光：到整本首/末页还继续拖时，被拉开的那道缝上压一层品牌色光。
            亮度由 usePanTrack 直接写 --pull（不经过 React），松手后 transition 自动收光 */}
        <div ref={track.glowRef} className="pan-edge-glow" data-side="left" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div
      className={`relative h-full w-full overflow-hidden ${
        isOriginal ? 'overflow-auto' : 'flex items-center justify-center'
      }`}
      {...touch.handlers}
    >
      <div
        key={pageIndex}
        className={`${anim.className} ${
          isOriginal ? 'grid min-h-full min-w-full place-items-center' : 'flex h-full w-full items-center justify-center'
        }`}
        style={anim.style}
      >
        <PageImage
          src={pageUrl(comicId, chapterId, pageIndex, quality)}
          alt={`page ${pageIndex + 1}`}
          pageNumber={pageIndex + 1}
          fit={isOriginal ? 'original' : fit}
        />
      </div>
    </div>
  );
}

/* ---------------- 双页 ---------------- */
export function DoublePager({ comicId, chapterId, pages, pageIndex, onPageChange, quality, readDir, preloadCount, animation, onEdge, hasPrevChapter, hasNextChapter }: PagerProps) {
  // 双页两图并排，每页放进「半屏」格子再 contain 缩放（设置页会禁用「适应方式」）。
  // 不能按高度铺满（h-full w-auto）：手机上两页并排后的总宽远超视口，
  // 居中溢出会把两页各自的外侧裁掉近一半。contain 让每页都完整可见：
  // 屏幕够宽时自然铺满高度，窄屏上则是「整对缩小」。
  //
  // 对开排布不在这里算死：首页与末页各自单占一屏（理由见 utils/pagerMode
  // 的 doubleSpreads）。所以页码域是「对开序号」，不是「图索引 / 2」。
  const spreads = useMemo(() => doubleSpreads(pages.length), [pages.length]);
  const spreadCount = spreads.length;
  usePreloader(comicId, chapterId, pages, spreads[pageIndex]?.[0] ?? 0, preloadCount, quality);

  const track = usePanTrack({
    index: pageIndex,
    count: spreadCount,
    readDir,
    enabled: animation === 'pan',
    resetKey: `${comicId}/${chapterId}`,
    onCommit: onPageChange,
    onEdge,
    canEdge: { prev: !!hasPrevChapter, next: !!hasNextChapter },
  });

  const dirRef = useRef(pageIndex);
  const forward = pageIndex >= dirRef.current;
  dirRef.current = pageIndex;
  const anim = pageAnim(animation, forward, readDir);
  const touch = useSwipe((dir) => {
    const delta = dir === 'next' ? (readDir === 'rtl' ? -1 : 1) : readDir === 'rtl' ? 1 : -1;
    const next = pageIndex + delta;
    if (next < 0 || next >= spreadCount) {
      onEdge?.(delta > 0);
      return;
    }
    onPageChange(next);
  });

  // rtl：先读右页（右=spread，左=spread+1）；ltr 相反
  // 注意：DOM 流从左到右，rtl 时必须把 pair[1] 放在前面，否则左右顺序与 ltr 相同
  const order = (list: PageMeta[]) => (readDir === 'rtl' ? [list[1], list[0]] : [list[0], list[1]]);
  const spreadRow = (spread: number, fadeIn = true) => {
    const pair = (spreads[spread] ?? []).map((i) => pages[i]).filter(Boolean) as PageMeta[];
    const ordered = order(pair).filter(Boolean);
    return (
      <div className="flex h-full w-full items-center justify-center gap-1">
        {ordered.map((p, i) => (
          <div
            key={p.index}
            // 单占一屏的那张（章首页 / 章末页）：整屏给它。
            // 旧行为是给它半屏格居中 —— 成对页缩小时还能对齐，但封面会缩成半屏宽居中，
            // 观感像「页面缩水了」，也和「单占一屏」这个语义不一致。
            className={`flex h-full items-center justify-center ${
              ordered.length === 1 ? 'w-full' : 'min-w-0 flex-1'
            }`}
          >
            <PageImage
              src={pageUrl(comicId, chapterId, p.index, quality)}
              alt={`page ${p.index + 1}`}
              pageNumber={p.index + 1}
              fit="contain"
              // 宽屏下图片按高度缩放、比半屏格窄，contain 默认居中会在书脊处留大空档；
              // 左右页各自向中线一侧对齐，让两页贴在一起，余量留给外侧。
              className={
                ordered.length === 1 ? '' : i === 0 ? 'object-right' : 'object-left'
              }
              // 平移轨道的跨页同样实心滑入，否则滑动中两页一起发灰
              fadeIn={fadeIn}
            />
          </div>
        ))}
      </div>
    );
  };

  if (animation === 'pan') {
    return (
      <div
        ref={track.wrapRef}
        className="pan-surface relative h-full w-full overflow-hidden"
        {...track.handlers}
      >
        <div
          className="pan-track flex h-full w-[300%]"
          style={track.trackStyle}
          onTransitionEnd={track.onTransitionEnd}
        >
          {track.slots.map((s, slot) => (
            <div
              // 同上：按跨页号做 key，避免翻页时重建两整页的 img
              key={s >= 0 ? `sp-${s}` : `empty-${slot}`}
              data-slot={slot}
              data-page={s}
              className="pan-slot h-full w-1/3 shrink-0"
            >
              {s >= 0 && spreadRow(s, false)}
            </div>
          ))}
        </div>
        <div ref={track.glowRef} className="pan-edge-glow" data-side="left" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden" {...touch.handlers}>
      {/* 入场层必须撑满：spreadRow 的 h-full 要靠它给出确定高度，
          否则 flex 行按图片高度收缩、整对贴在阅读区顶部（非平移偏好下） */}
      <div key={pageIndex} data-double-layer="1" className={`h-full w-full ${anim.className}`} style={anim.style}>
        {spreadRow(pageIndex)}
      </div>
    </div>
  );
}

/* ---------------- 拆分双页（宽幅跨页图对半显示） ---------------- */
/**
 * 宽高比达到这个值才认为「一张图跨了两页」，需要左右拆开看。
 * 不能拿「图比视口宽」当判据：手机视口又窄又高（390×844），按高度铺满后
 * 连普通竖版页都比视口宽，结果是每张竖版页都被当跨页拆开、左右各裁一截。
 */
const SPREAD_RATIO = 1.2;

/** 一张图在容器里的落位：宽幅图按「半页」适配，竖版图按整页适配 */
function splitGeom(
  box: { w: number; h: number },
  nat: { w: number; h: number },
  showRight: boolean,
): CSSProperties {
  const spread = nat.w / nat.h >= SPREAD_RATIO;
  const scale = spread
    ? Math.min(box.h / nat.h, box.w / (nat.w / 2))
    : Math.min(box.h / nat.h, box.w / nat.w);
  const w = nat.w * scale;
  const h = nat.h * scale;
  return {
    // 不拆分（竖版页）：整页居中；拆分：左半页居中，靠 translateX(-50%) 换到右半页
    left: spread ? (box.w - w / 2) / 2 : '50%',
    top: (box.h - h) / 2,
    width: w,
    height: h,
    // translateX 的百分比以元素自身宽度为基准：-50% = 恰好移到「后半页」
    transform: spread ? `translateX(${showRight ? '-50%' : '0%'})` : 'translateX(-50%)',
  };
}

/**
 * 平移轨道里的一个「半页」。
 *
 * 每个槽位都渲染自己的图（相邻槽位可能是同一张图的另一半，也可能是邻图），
 * 所以自然尺寸要各测各的：拿当前页的宽高比去排版邻页，跨页/竖版混排时会错位。
 * 没量到之前先按整槽 contain 画，别用高度铺满（手机上会先闪一帧被裁的图）。
 */
const SplitLeaf = memo(function SplitLeaf({
  comicId,
  chapterId,
  img,
  showRight,
  box,
  quality,
  priority,
}: {
  comicId: string;
  chapterId: string;
  img: number;
  showRight: boolean;
  box: { w: number; h: number } | null;
  quality: Quality;
  priority: 'high' | 'low';
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // 图片已在浏览器缓存时 onLoad 可能不再触发，挂载后补读一次
  useEffect(() => {
    const el = imgRef.current;
    if (el && el.complete && el.naturalWidth > 0) {
      setNat({ w: el.naturalWidth, h: el.naturalHeight });
    }
  }, [img, quality]);

  const geom = box && nat ? splitGeom(box, nat, showRight) : null;

  return (
    <>
      {!failed && (
        <img
          ref={imgRef}
          src={`${pageUrl(comicId, chapterId, img, quality)}${attempt ? `&retry=${attempt}` : ''}`}
          alt={`page ${img + 1}`}
          decoding="async"
          loading="eager"
          fetchPriority={priority}
          draggable={false}
          onError={() => setFailed(true)}
          onLoad={(e) => {
            const el = e.currentTarget;
            if (el.naturalWidth > 0) setNat({ w: el.naturalWidth, h: el.naturalHeight });
          }}
          className={`absolute select-none ${geom ? 'max-w-none' : 'inset-0 h-full w-full object-contain'}`}
          style={geom ?? undefined}
        />
      )}
      {failed && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
          <ImageOff size={22} className="text-white/35" />
          <p className="text-xs text-white/60">第 {img + 1} 页没能显示</p>
          <button
            className="mt-1 rounded-lg bg-white/10 px-3 py-1.5 text-[11px] text-white/80 ring-1 ring-white/15
                       transition-colors duration-150 hover:bg-white/15"
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
      )}
    </>
  );
});

/**
 * 非平移偏好下「换图」的动画层。
 *
 * 入场动画只在**挂载**那一刻决定一次：之后图片量到自然尺寸会重渲染，
 * 如果 class 跟着重算（或直接传进去），动画会被中途撤掉/改向。
 * key 由外部按「章 + 图号」给，所以每次换图都是新层、动画从头播。
 */
function SplitEntryLayer({
  enter,
  animation,
  forward,
  readDir,
  children,
}: {
  enter: boolean;
  animation: PageAnimation;
  forward: boolean;
  readDir: ReadDir;
  children: ReactNode;
}) {
  const [anim] = useState(() => (enter ? pageAnim(animation, forward, readDir) : { className: '' }));
  return (
    <div data-split-layer="1" className={`absolute inset-0 ${anim.className}`} style={anim.style}>
      {children}
    </div>
  );
}

export function SplitPager({ comicId, chapterId, pages, pageIndex, onPageChange, quality, readDir, preloadCount, animation, onEdge, hasPrevChapter, hasNextChapter }: PagerProps) {
  // 每张图拆 2 页：偶数页看前半，奇数页看后半；rtl（日漫右开）先看右半
  const imgIndex = Math.floor(pageIndex / 2);
  const halfIndex = pageIndex % 2;
  const showRight = readDir === 'rtl' ? halfIndex === 0 : halfIndex === 1;
  const totalHalf = pages.length * 2;
  usePreloader(comicId, chapterId, pages, imgIndex, Math.ceil(preloadCount / 2) + 1, quality);

  /**
   * 与单页同一条平移轨道：半页 = 一「格」，拖动 1:1 跟手、松手按距离/速度吸附，
   * 首末页有橡皮筋和边缘柔光。此前拆分只挂了横滑侦测（松手才跳一下），
   * 于是同一个阅读器里「拖动」有两种完全不同的手感。
   */
  const panOn = animation === 'pan';
  const track = usePanTrack({
    index: pageIndex,
    count: totalHalf,
    readDir,
    enabled: panOn,
    resetKey: `${comicId}/${chapterId}`,
    onCommit: onPageChange,
    onEdge,
    canEdge: { prev: !!hasPrevChapter, next: !!hasNextChapter },
  });

  const touch = useSwipe((dir) => {
    const delta = dir === 'next' ? (readDir === 'rtl' ? -1 : 1) : readDir === 'rtl' ? 1 : -1;
    const next = pageIndex + delta;
    if (next < 0 || next >= totalHalf) {
      onEdge?.(delta > 0);
      return;
    }
    onPageChange(next);
  });

  const chapter = `${comicId}/${chapterId}`;
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  /** 自然尺寸连同所属图一起存：换图当帧不能拿上一张的宽高比去排版 */
  const [natState, setNatState] = useState<{ chapter: string; img: number; w: number; h: number } | null>(null);
  const nat = natState && natState.chapter === chapter && natState.img === imgIndex ? natState : null;
  /** 加载失败 / 重试次数：失败时给一块说明，重试靠 `?retry=N` 绕开 HTTP 缓存 */
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // 容器尺寸变化（窗口缩放 / 横竖屏切换）时重算缩放。
  // 平移/非平移用的是两个不同的容器节点，切换偏好时要重新绑 ResizeObserver
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [panOn]);

  /**
   * 换图 / 换章：清掉失败态，并补一次尺寸测量。
   *
   * 为什么不能只靠 <img onLoad>：图片已在浏览器缓存、或本组件因切设置/切模式重新挂载时，
   * onLoad 可能不再触发 —— nat 于是永远为空，宽幅图不再拆半。
   * img.complete 为真时直接读尺寸，与 onLoad 是否触发无关。
   */
  useEffect(() => {
    setFailed(false);
    setAttempt(0);
    const el = imgRef.current;
    if (el && el.complete && el.naturalWidth > 0) {
      setNatState({ chapter, img: imgIndex, w: el.naturalWidth, h: el.naturalHeight });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter, imgIndex]);

  /**
   * 翻页方向：只在「换图那一次渲染」取准。
   * 用 effect 而不是渲染时赋值，重渲染（尺寸测量）不会把方向改掉。
   */
  const dirRef = useRef(pageIndex);
  const forward = pageIndex >= dirRef.current;
  useEffect(() => {
    dirRef.current = pageIndex;
  }, [pageIndex]);

  /**
   * 只有「同一章里换图」才播入场动画。
   * 首次进来 / 换章都不该整屏滑一下；effect 在提交后更新，渲染时读到的仍是旧值。
   */
  const entryRef = useRef<{ chapter: string; img: number } | null>(null);
  const enter = entryRef.current?.chapter === chapter && entryRef.current.img !== imgIndex;
  useEffect(() => {
    entryRef.current = { chapter, img: imgIndex };
  }, [chapter, imgIndex]);

  /** 半页平移的过渡是否已就绪（仅非平移偏好）：首次量到尺寸那帧不能过渡，
   *  否则 transform 会从「无」滑到 -50%，rtl 首屏会自己横滑一下 */
  const shiftArmed = useRef(false);

  const curGeom = box && nat ? splitGeom(box, nat, showRight) : null;
  const measured = !!curGeom;

  useEffect(() => {
    shiftArmed.current = measured;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measured, chapter, imgIndex]);

  if (panOn) {
    return (
      <div
        ref={(el) => {
          wrapRef.current = el;
          track.wrapRef.current = el;
        }}
        className="pan-surface relative h-full w-full overflow-hidden"
        {...track.handlers}
      >
        <div
          className="pan-track flex h-full w-[300%]"
          style={track.trackStyle}
          onTransitionEnd={track.onTransitionEnd}
        >
          {track.slots.map((p, slot) => (
            <div
              // 按半页号做 key：翻页只移动同一个节点，图片保持已解码（与单页轨道一致）
              key={p >= 0 ? `${chapter}#${p}` : `empty-${slot}`}
              data-page={p}
              data-split-layer={p === pageIndex ? '1' : undefined}
              className="pan-slot relative h-full w-1/3 shrink-0 overflow-hidden"
            >
              {p >= 0 && (
                <SplitLeaf
                  comicId={comicId}
                  chapterId={chapterId}
                  img={Math.floor(p / 2)}
                  // 半页号奇偶就是对开内的位置，rtl 先看右半
                  showRight={readDir === 'rtl' ? p % 2 === 0 : p % 2 === 1}
                  box={box}
                  quality={quality}
                  priority={p === pageIndex ? 'high' : 'low'}
                />
              )}
            </div>
          ))}
        </div>
        {/* 边界柔光：与单页轨道同一套「到边顶住再回弹」的反馈 */}
        <div ref={track.glowRef} className="pan-edge-glow" data-side="left" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden" {...touch.handlers}>
      <SplitEntryLayer
        key={`${chapter}#${imgIndex}`}
        enter={enter}
        animation={animation}
        forward={forward}
        readDir={readDir}
      >
        <img
          ref={imgRef}
          src={`${pageUrl(comicId, chapterId, imgIndex, quality)}${attempt ? `&retry=${attempt}` : ''}`}
          alt={`page ${imgIndex + 1}`}
          decoding="async"
          loading="eager"
          fetchPriority="high"
          draggable={false}
          onError={() => setFailed(true)}
          onLoad={(e) => {
            const img = e.currentTarget;
            if (img.naturalWidth > 0) {
              setNatState({ chapter, img: imgIndex, w: img.naturalWidth, h: img.naturalHeight });
            }
          }}
          // 尺寸未知前先按「整页 contain」画，别用高度铺满：手机上那会先闪一帧被裁的图
          className={`absolute select-none ${measured ? 'max-w-none' : 'inset-0 h-full w-full object-contain'} ${
            failed ? 'invisible' : ''
          }`}
          style={
            measured
              ? {
                  ...curGeom,
                  // 半页位移是同一张图内的平移，与翻页动画偏好无关（只有「无」时瞬时）；
                  // 时长/缓动对齐平移轨道，整屏位移不要用极端 ease-out
                  transition:
                    shiftArmed.current && animation !== 'none'
                      ? `transform ${PAN_MS}ms ${PAN_EASE}`
                      : undefined,
                }
              : undefined
          }
        />
      </SplitEntryLayer>
      {failed && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
          <ImageOff size={22} className="text-white/35" />
          <p className="text-xs text-white/60">第 {imgIndex + 1} 页没能显示</p>
          <button
            className="mt-1 rounded-lg bg-white/10 px-3 py-1.5 text-[11px] text-white/80 ring-1 ring-white/15
                       transition-colors duration-150 hover:bg-white/15"
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
      )}
    </div>
  );
}

/* ---------------- 卷轴（Webtoon 连续滚动）--------------- */
/**
 * 兜底高宽比（高/宽）：一张图都没加载成功时也要把页面撑起来。
 * 1.44 取常见漫画页比例（实测夹具为 1.4444）；实测值到达后会覆盖它。
 */
const FALLBACK_ASPECT = 1.44;

export function WebtoonPager({
  comicId,
  chapterId,
  pages,
  pageIndex,
  onPageChange,
  quality,
  preloadCount,
}: PagerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
  /** 章节页面的平均高宽比（由首张图实测），用于给未加载的页占位，保证滚动几何稳定 */
  const [aspect, setAspect] = useState<number | null>(null);
  /**
   * aspect 的来源：none=还没测到 / fallback=兜底值 / real=首张实测。
   * 兜底值只用于「一张图都没加载成功」的极端情况（请求 hang 或 500），
   * 一旦有实测值就替换掉它，之后不再变 —— 中途改比例会让已撑起的高度全变，
   * 滚动位置跟着漂移。
   */
  const aspectKind = useRef<'none' | 'fallback' | 'real'>('none');
  /** 写入 aspect：real 只接受第一次（保持滚动几何稳定），fallback 可被 real 覆盖 */
  const applyAspect = (value: number, kind: 'fallback' | 'real') => {
    if (aspectKind.current === 'real') return;
    if (aspectKind.current === 'fallback' && kind === 'fallback') return;
    aspectKind.current = kind;
    setAspect(value);
  };
  /** 本次 pageIndex 变化是否由「滚动本身」引起（是则不要再反向滚一次，避免抖动） */
  const fromScroll = useRef(false);
  /**
   * 滚动监听里要读「当前页」与回调，但监听只在 pages.length 变化时重建（重建会解绑/重绑
   * scroll 并打断 rAF）。所以必须走 ref：否则闭包里永远是首次渲染时的 pageIndex，
   * 表现为「滚到同一位置反复 onPageChange」，进而触发多余的进度上报与整页重渲染。
   */
  const latest = useRef({ pageIndex, onPageChange });
  latest.current = { pageIndex, onPageChange };

  /**
   * 单页加载失败（图片损坏 / 415 / 500）与重试次数。
   * 卷轴模式下失败页会留下一块按比例的空档，只靠 onError 撑高度是「无声的」——
   * 用户看到一片纯黑，不知道是页坏了还是没加载出来。这里补一句说明 + 重新加载。
   */
  const [failedPages, setFailedPages] = useState<Record<number, true>>({});
  const [retries, setRetries] = useState<Record<number, number>>({});

  // 换章时上一章的实测比例与失败页索引都不再适用。Pager 不随 chapterId 重挂载，
  // 不重置的话：旧比例继续撑高新章的占位盒（图片按新比例渲染 → 页与页重叠），
  // 旧章的坏页索引也会在新章继续显示「没能显示」。
  useEffect(() => {
    aspectKind.current = 'none';
    setAspect(null);
    setFailedPages({});
    setRetries({});
  }, [comicId, chapterId]);

  /**
   * 滚动定位的目标页。
   *
   * 「从第 N 页续读」时进入瞬间页 div 的高度全是 0（aspect 还没测到），容器
   * scrollHeight 只有尾部 h-16，此时 scrollIntoView 是 no-op —— 页面停在顶部，
   * 而窗口化又把前 N-6 页的图裁掉了，只剩空 div：用户看到的就是一片黑。
   * 所以把目标页记下来，等 aspect 就位后按它重新定位一次。
   */
  const targetRef = useRef(pageIndex);
  const scrollToPage = (i: number) => {
    itemRefs.current[i]?.scrollIntoView({ block: 'start' });
  };

  // 进入章节 / 外部指定页 → 主动滚到该页（续读定位、页码滑块、切章都走这里）
  useEffect(() => {
    if (fromScroll.current) {
      fromScroll.current = false;
      return;
    }
    targetRef.current = pageIndex;
    scrollToPage(pageIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIndex, chapterId]);

  /**
   * aspect 一到位就重新定位。
   * 上面那次 scrollIntoView 跑在「所有页高度为 0」的时刻，必然失败；
   * 高度撑起来之后必须补滚一次，否则续读位置（以及用户的眼睛）留在第一章第一页。
   * aspect 从兜底值升级成实测值时也会再触发一次，把兜底造成的偏差纠正回来。
   */
  useEffect(() => {
    if (aspect === null) return;
    scrollToPage(targetRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aspect]);

  // 没有任何图加载成功时兜底：1200ms 后按常见漫画页比例撑起页面，
  // 否则 scrollHeight 永远只有尾部占位，定位与滚动全部失效（整片黑）
  useEffect(() => {
    if (aspect !== null) return;
    const t = window.setTimeout(() => applyAspect(FALLBACK_ASPECT, 'fallback'), 1200);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aspect]);


  // 滚动 → 当前页（取视口上 1/3 处命中的图）
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const mid = c.scrollTop + c.clientHeight * 0.3;
        let lo = 0;
        let hi = pages.length - 1;
        while (lo < hi) {
          const m = (lo + hi + 1) >> 1;
          if ((itemRefs.current[m]?.offsetTop ?? 0) <= mid) lo = m;
          else hi = m - 1;
        }
        if (lo !== latest.current.pageIndex) {
          fromScroll.current = true;
          latest.current.onPageChange(lo);
        }
      });
    };
    c.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      c.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages.length]);

  usePreloader(comicId, chapterId, pages, pageIndex, preloadCount, quality);

  // 窗口化：只挂载当前页前后若干张，长章节（几百页）不占满内存与 DOM
  const WINDOW_BEFORE = 6;
  const WINDOW_AFTER = 10;
  const mounted = (i: number) => i >= pageIndex - WINDOW_BEFORE && i <= pageIndex + WINDOW_AFTER;

  return (
    <div ref={containerRef} className="scrollbar-hidden h-full w-full overflow-y-auto overscroll-contain">
      {pages.map((p, i) => (
        <div
          key={p.index}
          ref={(el) => { itemRefs.current[i] = el; }}
          className="relative w-full"
          // 已知比例时占位撑高，避免图片加载导致的滚动跳动
          style={aspect ? { aspectRatio: `1 / ${aspect}` } : undefined}
        >
          {mounted(i) && (
            <img
              src={`${pageUrl(comicId, chapterId, p.index, quality)}${
                retries[p.index] ? `&retry=${retries[p.index]}` : ''
              }`}
              alt={`page ${p.index + 1}`}
              decoding="async"
              loading={Math.abs(i - pageIndex) <= 2 ? 'eager' : 'lazy'}
              draggable={false}
              className={`block w-full select-none ${failedPages[p.index] ? 'invisible' : ''}`}
              onLoad={(e) => {
                const img = e.currentTarget;
                // 真实比例只写第一次：之后每张都写会让已撑起的高度反复变，滚动位置跟着漂
                if (img.naturalWidth > 0) applyAspect(img.naturalHeight / img.naturalWidth, 'real');
              }}
              // 加载失败（图 500 / 文件损坏）也要撑起高度：否则这一页高度为 0，
              // 续读定位与滚动几何都会坏在这里
              onError={() => {
                applyAspect(FALLBACK_ASPECT, 'fallback');
                setFailedPages((s) => (s[p.index] ? s : { ...s, [p.index]: true }));
              }}
            />
          )}
          {failedPages[p.index] && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
              <ImageOff size={22} className="text-white/35" />
              <p className="text-xs text-white/60">第 {p.index + 1} 页没能显示</p>
              <button
                className="mt-1 rounded-lg bg-white/10 px-3 py-1.5 text-[11px] text-white/80 ring-1 ring-white/15
                           transition-colors duration-150 hover:bg-white/15"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setFailedPages((s) => {
                    const next = { ...s };
                    delete next[p.index];
                    return next;
                  });
                  setRetries((r) => ({ ...r, [p.index]: (r[p.index] ?? 0) + 1 }));
                }}
              >
                重新加载
              </button>
            </div>
          )}
        </div>
      ))}
      <div className="h-16" />
    </div>
  );
}

/* ---------------- 滑动侦测（仅非平移模式使用：平移模式由 usePanTrack 接管） ---------------- */
function useSwipe(onSwipe: (dir: 'next' | 'prev') => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        start.current = { x: e.clientX, y: e.clientY };
      },
      onPointerUp: (e: React.PointerEvent) => {
        if (!start.current) return;
        const dx = e.clientX - start.current.x;
        const dy = e.clientY - start.current.y;
        start.current = null;
        if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy)) {
          // 滑动已翻页 → 吞掉随之而来的 click，避免「滑动 + 点击」一次翻两页
          dragClickGuard.until = Date.now() + 350;
          onSwipe(dx < 0 ? 'next' : 'prev');
        }
      },
    },
  };
}

export interface PagerProps {
  comicId: string;
  chapterId: string;
  pages: PageMeta[];
  pageIndex: number;
  onPageChange: (i: number) => void;
  quality: Quality;
  fit: FitMode;
  readDir: ReadDir;
  preloadCount: number;
  animation: PageAnimation;
  /**
   * 越界翻页（章末继续往后 / 章首继续往前）：返回 true 表示已换章。
   * 拖动与横滑都靠它换章——点击/键盘走 ReaderShell.turn()，不走这里。
   */
  onEdge?: (forward: boolean) => boolean;
  hasPrevChapter?: boolean;
  hasNextChapter?: boolean;
}
