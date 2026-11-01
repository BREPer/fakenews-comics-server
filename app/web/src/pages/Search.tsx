import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2, Search, X } from 'lucide-react';
import { useComics, LIST_PAGE_SIZE } from '@/api/queries';
import type { ComicListQuery } from '@/api/queries';
import { ComicGrid, ComicGridSkeleton, ComicListFooter } from '@/components/comic/ComicCard';
import { EmptyState, ErrorState } from '@/components/ui';
import { useInfiniteSentinel } from '@/hooks';

/**
 * 「还没有任何结果可展示」时，等多久才换成骨架屏。
 *
 * 实测（生产 bundle，本地库）：输入不存在的关键词，从发请求到空结果返回约 30ms。
 * 如果一上来就换骨架屏，那一帧灰块闪现约两帧，还是「闪一下」——而且骨架比
 * 空态高，页面会撑开再缩回。慢网（NAS 唤醒）下列表可见时长是 760~919ms，
 * 200ms 远在它之前，那里该给的「在搜了」信号不会被吞掉。
 */
const SEARCH_SLOW_MS = 200;

/** 搜索页：输入防抖 300ms → q 进 URL → 复用列表接口（无限滚动，按需续拉） */
export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const urlQ = params.get('q') ?? '';
  const [text, setText] = useState(urlQ);

  useEffect(() => {
    const t = setTimeout(() => {
      if (text !== urlQ) {
        const next = new URLSearchParams(params);
        if (text) next.set('q', text);
        else next.delete('q');
        setParams(next, { replace: true });
      }
    }, 300);
    return () => clearTimeout(t);
  }, [text, urlQ, params, setParams]);

  const query = useMemo<ComicListQuery>(() => ({ q: urlQ || undefined }), [urlQ]);
  const {
    data, isError, error, refetch,
    fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError, isFetching,
  } = useComics(query, LIST_PAGE_SIZE, { enabled: !!urlQ });

  const comics = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const total = data?.pages[0]?.total ?? 0;
  /** 有关键词、但一个结果都还没有（首次搜索，或上一轮也是空结果） */
  const pendingFirst = !!urlQ && comics.length === 0 && isFetching;

  /**
   * 慢到值得换骨架屏了吗。
   * 快搜索（本地 30ms）走完之前它一直是 false，下方区域保持原样不动——
   * 视觉上就是「什么都没闪，直接变成结果」。
   */
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!pendingFirst) {
      setSlow(false);
      return;
    }
    const t = window.setTimeout(() => setSlow(true), SEARCH_SLOW_MS);
    return () => window.clearTimeout(t);
  }, [pendingFirst]);
  const sentinelRef = useInfiniteSentinel(
    () => void fetchNextPage(),
    !!urlQ && !!hasNextPage && !isFetchingNextPage && !isFetchNextPageError,
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-500" />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="搜索漫画名 / 作者 / 文件名"
          className="input pl-9 pr-9"
        />
        {/*
          搜索中指示：防抖 300ms + 请求期间输入框原本毫无动静，慢网下敲完一段
          会以为没搜。只在真正发请求（isFetching）时转，不把防抖那 300ms 也算进去
          —— 每敲一个字都闪一下反而像故障。位置避开清除按钮（有 X 时左移）。
        */}
        {isFetching && (
          <span
            role="status"
            aria-label="正在搜索"
            className={`absolute top-1/2 -translate-y-1/2 text-ink-500 ${text ? 'right-8' : 'right-3'}`}
          >
            <Loader2 size={15} className="animate-spin" />
          </span>
        )}
        {text && (
          <button
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-ink-500 hover:text-ink-200"
            onClick={() => setText('')}
          >
            <X size={15} />
          </button>
        )}
      </div>

      {/*
        没有关键词时不发请求（见 useComics 的 enabled），所以这里不会出现
        「整库列表先占着位置」那一闪；搜索中且还没结果时保持原样，
        只有确认这是次慢搜索（>200ms）才换骨架屏。
      */}
      {!urlQ || (pendingFirst && !slow) ? (
        <EmptyState mascot="search" title="输入关键词开始搜索" hint="支持漫画名、作者、原始文件名模糊匹配" />
      ) : comics.length > 0 ? (
        <>
          <p className="text-xs text-ink-500">
            找到 {total} 部
            {comics.length < total && <span className="text-ink-600">（已显示 {comics.length} 部，继续下滑加载）</span>}
          </p>
          <ComicGrid comics={comics} />
          <div ref={sentinelRef} aria-hidden="true" className="h-px" />
          <ComicListFooter
            loading={isFetchingNextPage}
            hasMore={!!hasNextPage}
            loaded={comics.length}
            total={total}
            firstPageSize={LIST_PAGE_SIZE}
            error={isFetchNextPageError}
            onRetry={() => void fetchNextPage()}
          />
        </>
      ) : isError ? (
        <ErrorState
          title="搜索失败"
          error={error}
          hint="服务可能在忙（扫描大库），稍后重试"
          onRetry={() => void refetch()}
        />
      ) : pendingFirst ? (
        <ComicGridSkeleton />
      ) : (
        <EmptyState mascot="search" title={`没有找到「${urlQ}」`} hint="换个关键词，或检查漫画库是否已扫描" />
      )}
    </div>
  );
}
