import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { readUrl } from '@/utils/nav';
import { ChevronRight, History, Loader2, Search } from 'lucide-react';
import { useComics, useFacets, useHistory, useScanWatch, LIST_PAGE_SIZE } from '@/api/queries';
import type { ComicListQuery } from '@/api/queries';
import { ComicGrid, ComicGridSkeleton, ComicListFooter } from '@/components/comic/ComicCard';
import { EmptyState, ErrorState } from '@/components/ui';
import { toast } from '@/components/ui/toast';
import { useInfiniteSentinel } from '@/hooks';
import { api } from '@/api/client';
import type { ReadStatus } from '@/types';

/**
 * 首页（方案 §4 P1，四分区布局）：
 *   搜索入口 → 扫描进度 → 继续阅读横滑 → 筛选 chips → 封面网格（无限滚动）
 * 筛选状态全部进 URL query（刷新/后退可恢复）。
 *
 * 列表不再一次拉 120 条：512 本的库会有一大半书根本没有入口。现在首屏 36 条，
 * 滚到底自动续拉（见 useComics / useComicList 的注释），首包体积同时降了一个数量级。
 */
export default function HomePage() {
  const [params, setParams] = useSearchParams();
  const q = useMemo<ComicListQuery>(
    () => ({
      libraryId: params.get('library') ?? undefined,
      status: (params.get('status') as ReadStatus) ?? undefined,
      format: params.get('format') ?? undefined,
      tag: params.get('tag') ?? undefined,
      sort: (params.get('sort') as ComicListQuery['sort']) ?? 'addedAt',
      order: (params.get('order') as ComicListQuery['order']) ?? 'desc',
    }),
    [params],
  );

  const {
    data, isLoading, isError, error, refetch,
    fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError,
  } = useComics(q);
  const { data: facets } = useFacets();
  // 注意要把 isError 一起取出来：只看 data 是否为 undefined 的话，
  // 请求失败（重试 1 次后仍失败）会让「继续阅读」的骨架屏永久停在那里。
  // 多取一些再过滤：只取 12 条的话，刚读完 12 本短篇后这一块会整块消失，
  // 而更早还在读的书反而没有入口。
  const { data: history, isError: historyFailed } = useHistory(30);
  // 扫描状态常驻观察：首扫期间不能让首页显示「还没有漫画」，扫完也要自动刷新
  const scan = useScanWatch(true, 15_000);

  const comics = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const total = data?.pages[0]?.total ?? 0;
  const sentinelRef = useInfiniteSentinel(
    () => void fetchNextPage(),
    !!hasNextPage && !isFetchingNextPage && !isFetchNextPageError,
  );

  const setFilter = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null || params.get(key) === value) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const reading = (history?.items ?? []).filter((h) => h.progress && h.progress.percent < 100).slice(0, 12);
  // 标签栏只排除「格式」：扫描时自动写进 tags 的格式词在第一行已有独立筛选项
  // （FOLDER / CBZ / EPUB），重复一遍只是噪音。库名标签要保留——它同样是自动写入的，
  // 但首页没有别的库筛选入口，过滤掉就再也点不到了。
  const formatValues = new Set((facets?.formats ?? []).map((f) => f.value));

  const scanTotal = scan?.total ?? 0;
  const scanPct = scanTotal > 0 ? Math.min(100, Math.round(((scan?.done ?? 0) / scanTotal) * 100)) : 0;

  /**
   * 扫描横幅的展开 / 收起。两个标志分开：scanOpen 驱动过渡，scanMounted 驱动挂载。
   * 收起时不能立刻卸载内容 —— 那样行高瞬间归零（0fr 与 1fr 都解析成 0），动画等于没播。
   */
  const scanRunning = !!scan?.running;

  /*
    扫描结束的结果通知。

    扫描是唯一的长时间操作（几分钟到几十分钟），之前结束时只有横幅自己收起、
    列表自己刷新 —— 用户不知道「扫完了、扫到多少」。补一句 toast 把这个闭环补上。

    两个细节：
      - 数量差要用「扫描开始时记下的总数」比，而不是结束时现取：invalidate 之后的
        列表是异步到达的（useScanWatch 在 running→false 那一刻才 invalidate），
        立刻取还是旧值，delta 恒为 0。等一拍（1.2s）再取。
      - 总数取自当前列表查询，带筛选时它不等于全库，这种时候只说「扫描完成」，
        不报数字，免得给出误导性的增量。
    依赖只放 scanRunning（布尔）：放整个 scan 对象的话，轮询每次拿到新引用都会
    重跑 effect，把等待中的定时器清掉。
  */
  const totalRef = useRef(0);
  totalRef.current = total;
  const filteredRef = useRef(false);
  filteredRef.current = ['library', 'status', 'format', 'tag'].some((k) => params.get(k));
  const scanBefore = useRef<number | null>(null);
  const scanWasRunning = useRef(false);
  useEffect(() => {
    if (scanRunning) {
      if (!scanWasRunning.current) scanBefore.current = totalRef.current;
      scanWasRunning.current = true;
      return;
    }
    if (!scanWasRunning.current) return;
    scanWasRunning.current = false;
    const before = scanBefore.current ?? 0;
    const id = window.setTimeout(() => {
      const delta = totalRef.current - before;
      toast.success(delta > 0 && !filteredRef.current ? `扫描完成 · 新增 ${delta} 部` : '扫描完成');
    }, 1200);
    return () => window.clearTimeout(id);
  }, [scanRunning]);
  const [scanMounted, setScanMounted] = useState(scanRunning);
  const [scanOpen, setScanOpen] = useState(scanRunning);
  useEffect(() => {
    if (scanRunning) {
      setScanMounted(true);
      // 双 rAF：先以 0fr 渲染一帧，再切到 1fr，过渡才会真正跑起来（与 Sheet 同一套路）
      const r = requestAnimationFrame(() => requestAnimationFrame(() => setScanOpen(true)));
      return () => cancelAnimationFrame(r);
    }
    setScanOpen(false);
    // 兜底：系统级「减少动态效果」下过渡时长被压到 0.001ms，但 320ms 的卸载延迟
    // 仍要保证内容最终被摘掉，不能留下一个空壳占着 gap
    const t = setTimeout(() => setScanMounted(false), 320);
    return () => clearTimeout(t);
  }, [scanRunning]);

  return (
    <div className="flex flex-col gap-6">
      {/* 1. 搜索入口：做成"像输入框"的按钮——玻璃底 + 悬停提亮，比一张白卡片更有引导性 */}
      <Link
        to="/search"
        className="group flex w-full items-center gap-2.5 rounded-2xl bg-ink-900/70 px-4 py-3 text-sm text-ink-500
                   ring-1 ring-ink-800/70 shadow-soft backdrop-blur transition-[box-shadow,color,background-color]
                   duration-200 ease-out-quint hover:bg-ink-900 hover:text-ink-300 hover:shadow-lift"
      >
        <Search size={16} className="transition-colors duration-200 group-hover:text-accent" />
        搜索漫画 / 作者
        <span className="ml-auto hidden rounded-md bg-ink-800/70 px-1.5 py-0.5 text-[10px] text-ink-500 sm:block">
          搜索
        </span>
      </Link>

      {/*
        1.5 扫描进度条
        首次加库/换盘后扫描要跑几分钟到几十分钟，这期间首页原本毫无提示：
        列表是空的，用户看到「还没有漫画」，很自然会怀疑是不是导入失败。

        外层用 grid-template-rows 0fr→1fr 把**高度**也纳入过渡：它是插在页面顶部的，
        硬插入会把下面「继续阅读 / 筛选 chips / 整个网格」整块顶下去，只加淡入没用 ——
        位移在插入那一刻就已经发生了。0fr/1fr 的插值让浏览器自己算出目标高度，
        不必我们测量，也不用 max-height 那种「给个够大的值」的近似。

        收起同样要走完动画，所以内容延迟 320ms 才卸载。
        外层整块条件渲染（而不是常驻）：父级是 flex-col gap-6，
        常驻一个 0 高的空 div 照样会吃一份 24px 的 gap。
      */}
      {scanMounted && (
        <div
          className={`grid transition-[grid-template-rows] duration-300 ease-out-quint ${
            scanOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
          }`}
          aria-hidden={!scanRunning}
        >
          {/* 网格项自己要裁剪：行高为 0fr 时靠它把内容切掉 */}
          <div className="overflow-hidden">
            {scan && (
              <section
                role="status"
                className="overflow-hidden rounded-xl bg-brand-500/[0.10] ring-1 ring-brand-500/25"
              >
                {/*
                  配色刻意只让图标/进度条带品牌色，文字走 ink 阶：
                  brand-300/400 在浅色主题下是「浅橙压浅橙」，对比度不够（实测读不清），
                  而 ink 阶是反相映射的，深浅两套主题都稳。
                */}
                <div className="flex items-center gap-2.5 px-3 py-2 text-xs">
                  <Loader2 size={13} className="shrink-0 animate-spin text-brand-500" />
                  <span className="shrink-0 font-medium text-ink-200">正在扫描漫画库</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-ink-500">
                    {scanPct > 0 ? `已完成 ${scan.done} / ${scan.total}` : scan.current || ''}
                  </span>
                  <Link
                    to="/libraries"
                    className="shrink-0 text-ink-400 underline underline-offset-2 hover:text-ink-200"
                  >
                    查看
                  </Link>
                </div>
                <div className="h-[2px] bg-brand-500/15">
                  <div
                    className="h-full bg-brand-500 transition-[width] duration-500 ease-out-quint"
                    style={{ width: `${scanPct}%` }}
                  />
                </div>
              </section>
            )}
          </div>
        </div>
      )}

      {/*
        2. 继续阅读
        加载中必须占位：这块高度约 267px，之前是「数据到齐才插入」，
        实测把下面的筛选 chips 整整往下推了 267px（CLS 0.0243），
        看起来就是「打开首页时 UI 错位一下」。骨架与真实卡片同尺寸，插入即可无缝。
      */}
      {historyFailed ? null : history === undefined ? (
        <section aria-hidden="true">
          <div className="mb-2.5 h-[21px] w-24 skeleton" />
          <div className="-mx-3 flex gap-3 overflow-hidden px-3 pb-1 sm:mx-0 sm:px-0">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="w-28 shrink-0 sm:w-32">
                <div className="skeleton aspect-[3/4] w-full rounded-xl" />
                <div className="skeleton mt-1.5 h-3 w-3/4" />
                <div className="skeleton mt-1 h-2.5 w-1/2" />
              </div>
            ))}
          </div>
        </section>
      ) : reading.length > 0 ? (
        // anim-content-in：骨架 → 真实横滑列表是同一次路由内的替换，
        // 之前是硬切（骨架消失、卡片凭空出现）
        <section className="anim-content-in">
          <h2 className="mb-2.5 flex items-center gap-1.5 text-sm font-semibold tracking-tight text-ink-300">
            <History size={15} className="text-brand-500/80" /> 继续阅读
          </h2>
          <div className="-mx-3 flex gap-3 overflow-x-auto no-scrollbar px-3 pb-1 sm:mx-0 sm:px-0">
            {reading.map((h, i) => (
              <Link
                key={h.id}
                to={readUrl(h.id, h.chapterId, h.pageIndex)}
                className="group block w-28 shrink-0 transition-transform duration-300 ease-out-quint hover:-translate-y-1 sm:w-32"
              >
                <div className="media-frame relative overflow-hidden rounded-xl bg-ink-800 shadow-soft transition-shadow duration-300 group-hover:shadow-lift">
                  <img
                    src={api.coverUrl(h.id, 320)}
                    alt={h.title}
                    loading={i < 4 ? 'eager' : 'lazy'}
                    fetchPriority={i < 4 ? 'high' : 'auto'}
                    decoding="async"
                    className="aspect-[3/4] w-full object-cover transition-transform duration-500 ease-out-quint group-hover:scale-[1.04]"
                  />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-black/40 to-transparent" />
                  <div className="absolute inset-x-0 bottom-0 h-[3px] bg-black/45">
                    <div
                      className="h-full rounded-r-full bg-gradient-to-r from-brand-600 to-brand-400 shadow-[0_0_8px_rgb(var(--brand-500)/0.5)] transition-[width] duration-500 ease-out-quint"
                      style={{ width: `${h.progress!.percent}%` }}
                    />
                  </div>
                </div>
                <p className="mt-1.5 line-clamp-1 text-xs font-medium transition-colors duration-200 group-hover:text-accent">
                  {h.title}
                </p>
                <p className="text-[11px] text-ink-500">
                  {h.progress!.chapterIndex + 1} 章 · 第 {h.progress!.pageIndex + 1} 页
                </p>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {/* 3. 筛选 chips */}
      <section className="flex flex-col gap-2">
        <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
          {(['unread', 'reading', 'finished'] as ReadStatus[]).map((s) => (
            <button
              key={s}
              className={`press touch-hit ${params.get('status') === s ? 'chip-on' : 'chip-off'}`}
              onClick={() => setFilter('status', s)}
            >
              {s === 'unread' ? '未读' : s === 'reading' ? '在读' : '读完'}
            </button>
          ))}
          {(facets?.formats ?? []).map((f) => (
            <button
              key={f.value}
              className={`press touch-hit ${params.get('format') === f.value ? 'chip-on' : 'chip-off'}`}
              onClick={() => setFilter('format', f.value)}
            >
              {f.value.toUpperCase()} {f.count}
            </button>
          ))}
        </div>
        <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
          {(facets?.tags ?? [])
            .filter((t) => !formatValues.has(t.value))
            .map((t) => (
              <button
                key={t.value}
                className={`press touch-hit ${params.get('tag') === t.value ? 'chip-on' : 'chip-off'}`}
                onClick={() => setFilter('tag', t.value)}
              >
                {t.value} {t.count}
              </button>
            ))}
          <button className="press chip-off touch-hit ml-auto" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
            重置
          </button>
        </div>
      </section>

      {/* 4. 封面网格 */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-300">
            全部漫画 {/* 加载失败时不要显示 (0)：那会被读成「库里一本书都没有」 */}
            {!isError && <span className="text-ink-500">({total})</span>}
          </h2>
          <div className="flex gap-1">
            {(['addedAt', 'title', 'lastReadAt'] as const).map((s) => (
              <button
                key={s}
                className={`press touch-hit text-[11px] ${params.get('sort') === s ? 'text-accent' : 'text-ink-500'}`}
                onClick={() => setFilter('sort', s)}
              >
                {s === 'addedAt' ? '最近添加' : s === 'title' ? '名称' : '最近阅读'}
              </button>
            ))}
          </div>
        </div>
        {isLoading ? (
          <ComicGridSkeleton />
        ) : comics.length > 0 ? (
          <>
            <ComicGrid comics={comics} />
            {/* 哨兵：进入视口下方 600px 就拉下一页；列表加载完自动失效 */}
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
            title="漫画列表加载失败"
            error={error}
            hint="如果服务正在扫描大库，稍等一会儿再重试"
            onRetry={() => void refetch()}
          />
        ) : scan?.running ? (
          // 空库 + 正在扫描：这不是「你没有书」，而是「还在扫」，别让人以为是导入失败
          <div className="flex flex-col items-center justify-center gap-3 py-16" role="status">
            <Loader2 size={20} className="animate-spin text-accent" />
            <p className="text-sm text-ink-300">正在扫描漫画库</p>
            <p className="text-xs text-ink-500">
              {scanTotal > 0 ? `已完成 ${scan.done} / ${scan.total}，扫到的漫画会自动出现` : '扫到的漫画会自动出现'}
            </p>
          </div>
        ) : (
          <EmptyState
            mascot="empty"
            title="还没有漫画"
            hint="到「漫画库」添加目录并扫描，或换个筛选条件试试"
            action={
              <Link to="/libraries" className="btn-primary mt-2">
                去添加 <ChevronRight size={14} />
              </Link>
            }
          />
        )}
      </section>
    </div>
  );
}
