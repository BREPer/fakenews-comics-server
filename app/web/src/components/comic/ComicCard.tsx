import { memo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Heart, ImageOff, Loader2 } from 'lucide-react';
import type { Comic } from '@/types';
import { api } from '@/api/client';

/** 封面图（懒加载 + 骨架 + 加载淡入 + hover 缩放 + 失败回退） */
export function ComicCover({
  comic,
  className = '',
  eager = false,
}: {
  comic: Comic;
  className?: string;
  /** 首屏前几张置为 eager + high：慢网下先出可见区域的封面，而不是按 DOM 顺序排队 */
  eager?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  return (
    <div
      className={`group media-frame relative overflow-hidden rounded-xl bg-ink-800
                  shadow-soft transition-[box-shadow,transform] duration-300 ease-out-quint
                  group-hover:shadow-lift ${className}`}
    >
      {failed ? (
        <div className="flex h-full w-full items-center justify-center text-ink-600">
          <ImageOff size={20} />
        </div>
      ) : (
        <>
          {!loaded && <div className="absolute inset-0 skeleton rounded-none" />}
          <img
            src={api.coverUrl(comic.id, 320)}
            alt={comic.title}
            loading={eager ? 'eager' : 'lazy'}
            fetchPriority={eager ? 'high' : 'auto'}
            decoding="async"
            onError={() => setFailed(true)}
            onLoad={() => setLoaded(true)}
            className={`cover-img h-full w-full object-cover ${loaded ? 'is-loaded' : ''} group-hover:scale-[1.04]`}
          />
        </>
      )}
      {/* 底部压暗：让标题/角标在浅色封面上也读得清，同时给进度条一个底 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/35 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      {comic.progress && comic.progress.percent > 0 && (
        <div className="absolute inset-x-0 bottom-0 h-[3px] bg-black/45">
          <div
            className="h-full rounded-r-full bg-gradient-to-r from-brand-600 to-brand-400 shadow-[0_0_8px_rgb(var(--brand-500)/0.5)] transition-[width] duration-500 ease-out-quint"
            style={{ width: `${Math.min(100, comic.progress.percent)}%` }}
          />
        </div>
      )}
    </div>
  );
}

/** 封面卡片：网格单元。点击 → 详情；收藏徽标；阅读进度条 */
export const ComicCard = memo(
  function ComicCard({ comic, index = 0 }: { comic: Comic; index?: number }) {
    return (
      // 外层负责入场动画（transform 由 card-in 持有），内层负责 hover 上浮，
      // 二者分别作用在不同元素上，避免 animation-fill 与 hover transform 互相覆盖。
      // 入场按序号错峰（前 12 个，每个 26ms），首屏是「依次浮现」而不是整片同时闪出。
      <Link
        to={`/comic/${comic.id}`}
        className="group block anim-card-in"
        style={{ animationDelay: `${Math.min(index, 11) * 26}ms` }}
      >
        {/*
          按压反馈必须落在这一层：
            - 外层 Link 持有 anim-card-in 的 animation（fill 后 transform 归动画管），
              写 hover/active 的 transform 会被它覆盖；
            - 这一层是手指真正按到的元素（点击目标的后代才会匹配 :active）。
          不用 .press：它是 transition-[transform,color,background-color] duration-100
          的简写，与这里的 duration-300 hover 上浮在同一元素上争 transition 属性，
          谁生效取决于 CSS 生成顺序。改成手写 utilities：上浮仍 300ms，
          按压回弹收到 100ms —— 按下要跟手，回弹要比悬停快。
        */}
        <div className="transition-transform duration-300 ease-out-quint group-hover:-translate-y-1.5 active:scale-[0.97] active:duration-100">
          <div className="relative">
            <ComicCover comic={comic} className="aspect-[3/4] w-full" eager={index < 6} />
            {comic.isFavorite && (
              <div className="absolute right-1.5 top-1.5 rounded-full bg-black/45 p-1 backdrop-blur-sm ring-1 ring-white/10">
                {/* 胭脂红（固定语义色），不随高亮颜色变化 */}
                <Heart size={12} className="fill-fav-500 text-fav-500" />
              </div>
            )}
            {comic.readStatus === 'finished' && (
              <span className="absolute left-1.5 top-1.5 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm ring-1 ring-white/10">
                已读完
              </span>
            )}
          </div>
          <p className="mt-2 line-clamp-1 text-xs font-medium text-ink-200 transition-colors duration-200 group-hover:text-accent">
            {comic.title}
          </p>
          <p className="line-clamp-1 text-[11px] text-ink-500">
            {/* pageCount 在扫描期只统计「散图页」，章全是压缩包/PDF 时会是 0；
                这种情况改显示章数，避免卡片出现「0 页」 */}
            {comic.chapterCount > 1 || comic.pageCount === 0
              ? comic.chapterCount > 0
                ? `${comic.chapterCount} 章`
                : ''
              : `${comic.pageCount} 页`}
            {comic.progress && comic.progress.percent > 0 && comic.readStatus !== 'finished'
              ? ` · ${Math.round(comic.progress.percent)}%`
              : ''}
          </p>
        </div>
      </Link>
    );
  },
  // 只比较「影响这张卡片画面」的字段：列表整体刷新时（进度写入/收藏切换/翻页）
  // 只有真正变化的那几张会重新渲染，其余 100+ 张直接跳过。
  (a, b) => {
    const x = a.comic;
    const y = b.comic;
    if (x === y && a.index === b.index) return true;
    return (
      a.index === b.index &&
      x.id === y.id &&
      x.title === y.title &&
      x.isFavorite === y.isFavorite &&
      x.readStatus === y.readStatus &&
      x.chapterCount === y.chapterCount &&
      x.pageCount === y.pageCount &&
      (x.progress?.percent ?? 0) === (y.progress?.percent ?? 0)
    );
  },
);

/** 封面网格（响应式列数见 index.css .comic-grid） */
export function ComicGrid({ comics }: { comics: Comic[] }) {
  return (
    <div className="comic-grid">
      {comics.map((c, i) => (
        <ComicCard key={c.id} comic={c} index={i} />
      ))}
    </div>
  );
}

/** 网格骨架屏（与真实卡片同构：封面 + 两行文字，避免数据到达时高度跳动） */
export function ComicGridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="comic-grid">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{ animationDelay: `${Math.min(i, 11) * 26}ms` }} className="anim-card-in">
          <div className="skeleton aspect-[3/4] w-full rounded-xl" />
          <div className="skeleton mt-2 h-3 w-3/4" />
          <div className="skeleton mt-1.5 h-2.5 w-1/2" />
        </div>
      ))}
    </div>
  );
}

/**
 * 列表底部（无限滚动）。
 *
 * 只在两种情况下占位：
 *   - 正在拉下一页 → 转圈，给「往上滑确实有反应」的反馈
 *   - 全部加载完且曾经翻过页 → 一句「已经到底了」，说明不是加载卡住
 * 一页就装完的小库不显示任何东西：底部多一行「已到底」纯属噪音。
 */
export function ComicListFooter({
  loading,
  hasMore,
  loaded,
  total,
  firstPageSize,
  error,
  onRetry,
}: {
  loading: boolean;
  hasMore: boolean;
  loaded: number;
  total: number;
  firstPageSize: number;
  error?: boolean;
  onRetry?: () => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-xs text-ink-500" role="status">
        <Loader2 size={14} className="animate-spin" />
        正在加载更多…
      </div>
    );
  }
  // 续拉失败：已加载的卡片必须留在原地，只在 footer 给重试入口
  if (error) {
    return (
      <div className="flex items-center justify-center py-6">
        <button className="press touch-hit text-xs text-ink-400 hover:text-ink-200" onClick={onRetry}>
          加载更多失败 · 点击重试
        </button>
      </div>
    );
  }
  if (hasMore || loaded < firstPageSize) return null;
  return <p className="py-6 text-center text-[11px] text-ink-600">已经到底了 · 共 {total} 部</p>;
}
