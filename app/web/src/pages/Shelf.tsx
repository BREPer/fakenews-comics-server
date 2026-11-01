import { Link } from 'react-router-dom';
import { readUrl } from '@/utils/nav';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Heart, Trash2 } from 'lucide-react';
import { useFavorites, useHistoryFeed, queryKeys } from '@/api/queries';
import { api } from '@/api/client';
import { ComicGrid, ComicGridSkeleton } from '@/components/comic/ComicCard';
import { EmptyState, ErrorState } from '@/components/ui';
import { toast } from '@/components/ui/toast';
import { useInfiniteSentinel } from '@/hooks';
import { clearLocalMirror } from '@/components/reader/useProgressSync';
import type { HistoryItem } from '@/types';

/**
 * 书架页（方案 §4 P3）：收藏网格 + 阅读记录时间线。
 * 记录可单条删除（不动收藏，可撤销）；点击记录续读。
 *
 * 阅读记录改成分页：以前写死 `useHistory(100)`，读过 100 本以上的用户
 * 更早的记录**完全看不到**（接口只有 limit 没有 offset）。现在每页 30 条，
 * 滚到底自动续拉，并显示总条数。
 */
export default function ShelfPage() {
  const {
    data: favs, isLoading: favLoading, isError: favError, error: favErr, refetch: refetchFavs,
  } = useFavorites();
  const {
    data: hist, isLoading: hisLoading, isError: hisError, error: hisErr, refetch: refetchHis,
    fetchNextPage, hasNextPage, isFetchingNextPage,
  } = useHistoryFeed();
  const qc = useQueryClient();

  const history = hist?.pages.flatMap((p) => p.items) ?? [];
  const historyTotal = hist?.pages[0]?.total ?? 0;
  const sentinelRef = useInfiniteSentinel(
    () => void fetchNextPage(),
    !!hasNextPage && !isFetchingNextPage,
  );

  const invalidate = (comicId: string) => {
    qc.invalidateQueries({ queryKey: queryKeys.history() });
    qc.invalidateQueries({ queryKey: ['comics'] });
    // 删记录 = 这部书的进度没了，详情页的「继续阅读 xx%」与列表卡片进度条也要跟着变
    qc.invalidateQueries({ queryKey: queryKeys.comic(comicId) });
  };

  /**
   * 删除一条阅读记录。
   *
   * 以前点了就消失、没有任何挽回手段 —— 而它删的是**阅读进度**，误触的代价是
   * 「这本书记得读到哪」直接没了。现在给 6 秒撤销窗口：
   * 撤销时把原位置连同**原时间戳**一起写回，记录会回到原来的位置，
   * 而不是跳到列表最前面（否则用户看到的是「撤销了但顺序变了」）。
   */
  const removeHistory = async (h: HistoryItem) => {
    try {
      await api.removeHistory(h.id);
    } catch (e) {
      toast.error(`删除失败：${e instanceof Error ? e.message : '未知错误'}`);
      return;
    }
    // 本地镜像必须一起清：Reader 在「服务端没有进度」时会采信镜像，
    // 不清的话删完记录，一进阅读器又按旧页码定位并把进度写回服务端（记录复活）
    clearLocalMirror(h.id);
    invalidate(h.id);
    toast.undo(`已删除《${h.title}》的阅读记录`, () => {
      void api
        .putProgress({
          comicId: h.id,
          chapterId: h.chapterId,
          chapterIndex: h.chapterIndex,
          pageIndex: h.pageIndex,
          pageCount: h.progressPageCount,
          percent: h.progress?.percent ?? 0,
          updatedAt: h.progress?.updatedAt,
        })
        .then(() => {
          invalidate(h.id);
          toast.success('阅读记录已恢复');
        })
        .catch(() => toast.error('恢复失败，可能这部漫画已被移除'));
    });
  };

  return (
    <div className="flex flex-col gap-7">
      <section>
        <h1 className="mb-3 flex items-center gap-2 text-lg font-bold">
          <Heart size={18} className="text-fav-500" /> 我的收藏
          <span className="text-sm font-normal text-ink-500">({favs?.items.length ?? 0})</span>
        </h1>
        {favLoading ? (
          <ComicGridSkeleton count={6} />
        ) : favError ? (
          <ErrorState title="收藏加载失败" error={favErr} onRetry={() => void refetchFavs()} />
        ) : favs && favs.items.length > 0 ? (
          <ComicGrid comics={favs.items} />
        ) : (
          <EmptyState
            mascot="empty"
            title="还没有收藏"
            hint="在详情页点「收藏」，漫画会出现在这里"
            action={
              <Link to="/" className="btn-primary mt-2">
                去挑一本 <ChevronRight size={14} />
              </Link>
            }
          />
        )}
      </section>

      <section>
        <h1 className="mb-3 text-lg font-bold">
          阅读记录{' '}
          <span className="text-sm font-normal text-ink-500">
            ({historyTotal}{history.length > 0 && history.length < historyTotal ? ` · 已显示 ${history.length}` : ''})
          </span>
        </h1>
        {hisLoading ? (
          <ComicGridSkeleton count={4} />
        ) : hisError ? (
          <ErrorState title="阅读记录加载失败" error={hisErr} onRetry={() => void refetchHis()} />
        ) : history.length > 0 ? (
          <>
            <ul className="card divide-y divide-ink-800">
              {history.map((h, i) => (
                <li
                  key={h.id}
                  className="animate-rise flex items-center gap-3 px-3 py-2.5"
                  // 错峰按**页内**序号取模。写成 min(i, 11) 的话第 12 条之后会挤在同一刻
                  // 出现，无限滚动续拉的第二页起更是整页同时冒出来 —— 网格卡片踩过同一个坑
                  style={{ animationDelay: `${(i % 12) * 14}ms` }}
                >
                  <Link to={readUrl(h.id, h.chapterId, h.pageIndex)} className="group flex min-w-0 flex-1 items-center gap-3">
                    <div className="h-14 w-11 shrink-0 overflow-hidden rounded">
                      <img src={api.coverUrl(h.id, 160)} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-1 text-sm font-medium">{h.title}</p>
                      <p className="text-[11px] text-ink-500">
                        第 {h.chapterIndex + 1} 章 · 第 {h.pageIndex + 1}/{h.progressPageCount} 页 ·{' '}
                        {new Date(h.progress?.updatedAt ?? 0).toLocaleDateString('zh-CN')}
                      </p>
                      <div className="mt-1 h-1 w-24 overflow-hidden rounded-full bg-ink-800">
                        <div
                          className="h-full bg-brand-500 transition-[width] duration-500 ease-out"
                          style={{ width: `${h.progress?.percent ?? 0}%` }}
                        />
                      </div>
                    </div>
                  </Link>
                  <button
                    className="btn-ghost touch-hit p-2 text-ink-500 hover:text-red-400"
                    title="删除记录（可撤销）"
                    aria-label={`删除${h.title}的阅读记录`}
                    onClick={() => void removeHistory(h)}
                  >
                    <Trash2 size={15} />
                  </button>
                </li>
              ))}
            </ul>
            {/* 哨兵 + 状态行：还有更早的记录就自动续拉，到底了说一句 */}
            <div ref={sentinelRef} aria-hidden="true" className="h-px" />
            {isFetchingNextPage ? (
              <p className="py-4 text-center text-[11px] text-ink-500" role="status">
                正在加载更早的记录…
              </p>
            ) : !hasNextPage && history.length >= 30 ? (
              <p className="py-4 text-center text-[11px] text-ink-600">已经到底了 · 共 {historyTotal} 条</p>
            ) : null}
          </>
        ) : (
          <EmptyState
            mascot="empty"
            title="没有阅读记录"
            hint="开始阅读后，进度会自动出现在这里"
            action={
              <Link to="/" className="btn-primary mt-2">
                去挑一本 <ChevronRight size={14} />
              </Link>
            }
          />
        )}
      </section>
    </div>
  );
}
