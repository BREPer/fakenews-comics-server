import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Heart, ImageOff, LayoutGrid, ListOrdered, List, Loader2, Pencil, Play, RefreshCw, RotateCcw, Tag, X } from 'lucide-react';
import { queryKeys, useComicDetail, useResetProgress, useToggleFavorite, useUpdateComic } from '@/api/queries';
import { api } from '@/api/client';
import { EmptyState, ErrorState, Sheet, ConfirmDialog } from '@/components/ui';
import { toast } from '@/components/ui/toast';
import { readUrl } from '@/utils/nav';
import { readDetailChapterView, writeDetailChapterView, type ChapterView } from '@/utils/readerPrefs';
import type { Chapter } from '@/types';

/**
 * 详情页骨架屏。
 * 之前这里是一个居中 spinner：慢网下整屏只有一圈转圈，用户既不知道在等什么、
 * 也不知道等多久、数据到达后还会整页重排。骨架屏与真实布局同构，感知更快、也不跳。
 */
function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      <div className="skeleton h-8 w-20" />
      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="skeleton aspect-[3/4] w-40 shrink-0 self-center rounded-2xl sm:w-48 sm:self-start" />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="skeleton h-6 w-2/3" />
          <div className="skeleton h-3 w-1/3" />
          <div className="skeleton h-3 w-4/5" />
          <div className="skeleton h-3 w-2/3" />
          <div className="mt-3 flex flex-wrap gap-2">
            <div className="skeleton h-9 w-28 rounded-xl" />
            <div className="skeleton h-9 w-24 rounded-xl" />
            <div className="skeleton h-9 w-24 rounded-xl" />
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <div className="skeleton h-4 w-24" />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="skeleton h-12 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}

/**
 * 详情页（方案 §4 P4）：封面 + 元信息 + 操作 + 章节列表。
 * 「开始/继续阅读」定位到进度章节页码（实际阅读才记进度，见阅读器）。
 */
export default function DetailPage() {
  const { comicId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: comic, isLoading, isError, error, refetch } = useComicDetail(comicId);
  const toggleFav = useToggleFavorite();
  const updateComic = useUpdateComic();
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<{ title: string; author: string; description: string; tags: string[] }>({
    title: '',
    author: '',
    description: '',
    tags: [],
  });
  /** 标签输入框（回车/逗号把内容并进 editForm.tags） */
  const [tagInput, setTagInput] = useState('');
  /** 章节区视图：列表（一行一章，信息全）／四格（一行四格，章多时一屏看更多）。本机记忆 */
  const [chapterView, setChapterView] = useState<ChapterView>(() => readDetailChapterView());
  /** 重置进度确认框是否展开（真正发请求走 useResetProgress） */
  const [confirmReset, setConfirmReset] = useState(false);
  const resetProgress = useResetProgress();
  const [rescanning, setRescanning] = useState(false);
  const [coverFailed, setCoverFailed] = useState(false);
  const [coverLoaded, setCoverLoaded] = useState(false);
  /**
   * 收藏图标「弹一下」的开关。
   * 只在用户主动切换成功后置 true —— 不能靠 `key={isFavorite}` 之类的手段让它
   * 每次挂载都播，那样刚进详情页（图标正在淡入）就会先弹一下，属于自作多情。
   */
  const [favBump, setFavBump] = useState(false);

  const doRescan = () => {
    setRescanning(true);
    api
      .rescanComic(comicId)
      .then((res) => {
        queryClient.invalidateQueries({ queryKey: ['comics'] });
        // 和重置进度同一个坑：重扫改的是章节数/页数，只清列表 key 的话详情页不会重取，
        // 界面上「重扫」就等于没反应。重扫接口是同步返回的，这里可以立即失效详情。
        queryClient.invalidateQueries({ queryKey: queryKeys.comic(comicId) });
        // 以前这里完全静默：按钮转一圈就恢复，用户不知道扫到了什么
        toast.success(`重扫完成：${res.chapterCount} 章 · ${res.pageCount} 页`);
      })
      .catch((e: unknown) => toast.error(`重扫失败：${e instanceof Error ? e.message : '未知错误'}`))
      .finally(() => setRescanning(false));
  };

  if (isLoading) return <DetailSkeleton />;
  // 请求失败 ≠ 漫画被删了。以前两者都走下面那句「漫画不存在」，
  // NAS 断网时用户会以为自己的书被删掉。
  if (isError) {
    return (
      <ErrorState
        title="详情加载失败"
        error={error}
        hint="稍后重试；如果反复失败，确认 NAS 上的服务与漫画目录挂载正常"
        onRetry={() => void refetch()}
      />
    );
  }
  if (!comic) return <EmptyState mascot="404" title="漫画不存在" hint="可能已被移动或删除" />;

  const openEdit = () => {
    setEditForm({
      title: comic.title,
      author: comic.author ?? '',
      description: comic.description ?? '',
      tags: [...(comic.tags ?? [])],
    });
    setTagInput('');
    setEditing(true);
  };

  /** 把输入框内容（支持逗号/空格分隔一次加多个）并进分类 */
  const addTags = () => {
    const parts = tagInput
      .split(/[,，;；\s]+/)
      .map((s) => s.trim().slice(0, 40))
      .filter(Boolean);
    if (parts.length === 0) return;
    setEditForm((f) => ({ ...f, tags: [...new Set([...f.tags, ...parts])].slice(0, 40) }));
    setTagInput('');
  };

  const progress = comic.progress;
  const chaptersReady = Array.isArray(comic.chapters) && comic.chapters.length > 0;
  const resumeChapter: Chapter | undefined =
    (progress && comic.chapters.find((c) => c.id === progress.chapterId)) || comic.chapters[0];
  const startReading = () => {
    if (!resumeChapter) {
      console.warn('[detail] 点击开始阅读时章节尚未就绪', {
        comicId: comic.id,
        chapters: comic.chapters?.length ?? null,
        chapterCount: comic.chapterCount,
      });
      return;
    }
    const page = progress && progress.chapterId === resumeChapter.id ? progress.pageIndex : 0;
    navigate(readUrl(comic.id, resumeChapter.id, page));
  };

  return (
    // anim-content-in：骨架 → 真实内容是**同一次路由内**的整棵子树替换，
    // AppShell 的 main.anim-route 只在路由切换时跑一次，覆盖不到这里；
    // 没有它时详情页加载完会硬切一下。纯淡入不带位移（理由同 .anim-route）。
    <div className="anim-content-in relative flex flex-col gap-5">
      {/* 顶部光晕：中性色薄雾（见 index.css 的 .page-ambient），既不随这本书的封面变色，
          也不跟随高亮色——高亮色是交互语言（按钮/选中/链接），背景氛围抢用会稀释它的语义。
          以前这里放的是封面图本身（模糊 40px + 提饱和），同一套 UI 会因为封面是蓝的/黑的
          而整体偏色，标题对比度也跟着浮动。 */}
      <div className="page-ambient" aria-hidden="true" />
      <button className="btn-ghost -ml-2 w-fit" onClick={() => navigate(-1)}>
        <ChevronLeft size={16} /> 返回
      </button>

      <div className="flex flex-col gap-4 sm:flex-row">
        {/* 封面框固定在 3:4（与网格卡片、骨架屏同比例）。
            之前只给宽没给高，图片高度由自身像素比例决定：方形封面只有 145px 高、
            竖长封面能到 418px，下面整块章节列表会被推着上下跳 270 多 px。 */}
        <div className="media-frame group relative aspect-[3/4] w-40 shrink-0 self-center overflow-hidden rounded-2xl bg-ink-800 shadow-lift sm:w-48 sm:self-start">
          {coverFailed ? (
            <div className="flex h-full w-full items-center justify-center text-ink-600">
              <ImageOff size={22} />
            </div>
          ) : (
            <>
              {!coverLoaded && <div className="absolute inset-0 skeleton rounded-none" />}
              <img
                src={api.coverUrl(comic.id, 480)}
                alt={comic.title}
                onError={() => setCoverFailed(true)}
                onLoad={() => setCoverLoaded(true)}
                className={`cover-img h-full w-full object-cover transition-transform duration-500 ease-out-quint group-hover:scale-[1.03] ${
                  coverLoaded ? 'is-loaded' : ''
                }`}
              />
            </>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-bold">{comic.title}</h1>
          {comic.rawTitle !== comic.title && (
            <p className="mt-0.5 text-xs text-ink-500">原名：{comic.rawTitle}</p>
          )}
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-400">
            {comic.author && <span>作者：{comic.author}</span>}
            <span>{comic.format.toUpperCase()}</span>
            <span>{comic.chapterCount} 章</span>
            <span>{comic.pageCount} 页</span>
            <span>{(comic.sizeBytes / 1024 / 1024).toFixed(1)} MB</span>
          </div>
          {/* 分类标签（就是首页筛选 chips 里的那些）：可直接看到这本书归在哪几类 */}
          {comic.tags && comic.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Tag size={12} className="shrink-0 text-ink-500" />
              {comic.tags.map((t) => (
                <span key={t} className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-400">
                  {t}
                </span>
              ))}
            </div>
          )}
          {comic.description && <p className="mt-3 text-sm leading-relaxed text-ink-300">{comic.description}</p>}

          <div className="mt-4 flex flex-wrap gap-2">
            {/* 章节未就绪时禁用：以前这个按钮点了会静默无反应（startReading 拿不到章节直接 return），
                用户只会以为「按钮坏了」。禁用比无声失败诚实。 */}
            <button
              className="btn-primary"
              onClick={startReading}
              disabled={!chaptersReady}
              data-testid="start-reading"
              title={chaptersReady ? undefined : '章节加载中，请稍候'}
            >
              <Play size={15} />
              {progress && progress.percent > 0 && progress.percent < 100 ? '继续阅读' : '开始阅读'}
              {progress && progress.percent > 0 && progress.percent < 100 && (
                <span className="text-xs opacity-80">（{Math.round(progress.percent)}%）</span>
              )}
            </button>
            <button
              className="btn-ghost ring-1 ring-ink-800"
              disabled={toggleFav.isPending}
              onClick={() =>
                toggleFav.mutate(
                  { comicId: comic.id, fav: comic.isFavorite },
                  {
                    // 收藏是个「点一下就该有回应」的动作：成功也给一句，
                    // 否则在收藏数很多的列表里，用户分不清自己刚才是加了还是取消了
                    onSuccess: () => {
                      setFavBump(true);
                      toast.success(comic.isFavorite ? '已取消收藏' : '已加入收藏');
                    },
                    onError: (e) => toast.error(`收藏操作失败：${e instanceof Error ? e.message : '未知错误'}`),
                  },
                )
              }
            >
              {/*
                请求中把爱心换成转圈：原来只有 disabled（整颗按钮淡到 45%），
                弱网下看起来像「点了没反应」，而爱心 pop 又只在成功后才播。
                size 与爱心一致（15），切换时按钮宽度不跳。
              */}
              {toggleFav.isPending ? (
                <Loader2 size={15} className="animate-spin text-ink-400" />
              ) : (
                /* 收藏用胭脂红（固定语义色），不跟「高亮颜色」变：换主题色时爱心仍该是爱心 */
                <Heart
                  size={15}
                  className={`${comic.isFavorite ? 'fill-fav-500 text-fav-500' : ''} ${
                    favBump ? 'anim-icon-bump' : ''
                  }`}
                  // 播完就摘掉类，否则下一次切换时类还在，动画不会被重新触发
                  onAnimationEnd={() => setFavBump(false)}
                />
              )}
              {comic.isFavorite ? '已收藏' : '收藏'}
            </button>
            <button className="btn-ghost ring-1 ring-ink-800" onClick={openEdit}>
              <Pencil size={15} /> 编辑信息
            </button>
            <button className="btn-ghost ring-1 ring-ink-800" disabled={rescanning} onClick={doRescan}>
              <RefreshCw size={15} className={rescanning ? 'animate-spin' : ''} />
              {rescanning ? '重扫中…' : '重扫'}
            </button>
            {progress && (
              <button className="btn-ghost ring-1 ring-ink-800" onClick={() => setConfirmReset(true)}>
                <RotateCcw size={15} /> 重置进度
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 章节列表（右上角可切「列表 / 一行四格」） */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink-300">
            <ListOrdered size={15} /> 章节（{comic.chapters.length}）
          </h2>
          {comic.chapters.length > 0 && (
            <button
              className="btn-ghost touch-hit flex items-center gap-1 px-2 py-1 text-xs text-ink-400 hover:text-ink-200"
              aria-label="切换章节布局"
              title={chapterView === 'grid' ? '切换为列表' : '切换为四格'}
              onClick={() => {
                const next: ChapterView = chapterView === 'grid' ? 'list' : 'grid';
                setChapterView(next);
                writeDetailChapterView(next);
              }}
            >
              {chapterView === 'grid' ? <List size={15} /> : <LayoutGrid size={15} />}
              <span>{chapterView === 'grid' ? '列表' : '四格'}</span>
            </button>
          )}
        </div>

        {chapterView === 'grid' ? (
          /* 四格：章多时一屏能看更多。只标「当前在读」——
             分章进度（已读/百分比）已随 chapter_progress 一并移除 */
          <div className="grid grid-cols-4 gap-2">
            {comic.chapters.map((ch) => {
              const isCurrent = progress?.chapterId === ch.id;
              return (
                <button
                  key={ch.id}
                  title={`${ch.title}${ch.pageCount > 0 ? ` · ${ch.pageCount} 页` : ''}`}
                  onClick={() =>
                    navigate(readUrl(comic.id, ch.id, isCurrent && progress ? progress.pageIndex : 0))
                  }
                  // 高度固定（44px，约等于手机上方形格的一半，且是标准触控目标）。
                  // 不用 aspect-square：宽度随容器变化时方形格会变得极高（桌面上四格能到两三百 px），
                  // 也不满足「高度固定不变」。
                  className={`press relative flex h-11 flex-col items-center justify-center overflow-hidden rounded-lg text-sm transition-colors ${
                    isCurrent ? 'bg-brand-600 font-semibold text-white' : 'bg-ink-800 text-ink-200 hover:bg-ink-700'
                  }`}
                >
                  <span className="tabular-nums">{ch.index + 1}</span>
                </button>
              );
            })}
            {comic.chapters.length === 0 && (
              <p className="col-span-4 px-4 py-6 text-center text-sm text-ink-500">未找到章节，请重新扫描</p>
            )}
          </div>
        ) : (
          <div className="card divide-y divide-ink-800/70 overflow-hidden">
            {comic.chapters.map((ch) => {
              const isCurrent = progress?.chapterId === ch.id;
              return (
                <button
                  key={ch.id}
                  className={`press flex w-full items-center justify-between border-l-2 px-4 py-3 text-left text-sm transition-colors hover:bg-ink-800/60 ${
                    isCurrent
                      ? 'border-brand-500 text-accent'
                      : 'border-transparent text-ink-200'
                  }`}
                  onClick={() => navigate(readUrl(comic.id, ch.id, isCurrent && progress ? progress.pageIndex : 0))}
                >
                  <span className="line-clamp-1">
                    {ch.index + 1}. {ch.title}
                  </span>
                  <span className="ml-3 flex shrink-0 items-center gap-2 text-xs text-ink-500">
                    {ch.pageCount > 0 ? <span>{ch.pageCount} 页</span> : null}
                    {isCurrent && progress && progress.percent < 100 && <span className="text-accent">在读</span>}
                  </span>
                </button>
              );
            })}
            {comic.chapters.length === 0 && (
              <p className="px-4 py-6 text-center text-sm text-ink-500">未找到章节，请重新扫描</p>
            )}
          </div>
        )}
      </section>

      {/* 重置阅读进度确认。以前成功后只 invalidate 了 ['comics']（列表 key），
          详情页用的是 ['comic', id]，前缀不同 → 详情根本不重取，界面停在旧数据上
          （「确认了但页面没变化」）。现在统一走 useResetProgress，详情/列表/历史一起失效。 */}
      <ConfirmDialog
        open={confirmReset}
        title="重置阅读进度"
        message="将清除这部漫画的阅读记录（章节、页码、进度），收藏不受影响。确定继续？"
        confirmText={resetProgress.isPending ? '重置中…' : '重置'}
        danger
        busy={resetProgress.isPending}
        error={resetProgress.error ? (resetProgress.error as Error).message : null}
        onConfirm={() => {
          resetProgress.mutate(comic.id, {
            // 失败时保持弹窗开着并显示原因（以前是 finally 关掉，用户只能看到一个「没反应」）
            onSuccess: () => {
              setConfirmReset(false);
              toast.success('阅读进度已重置');
            },
          });
        }}
        onCancel={() => {
          if (resetProgress.isPending) return;
          resetProgress.reset();
          setConfirmReset(false);
        }}
      />

      {/* 编辑元数据 */}
      <Sheet open={editing} title="编辑信息" onClose={() => setEditing(false)}>
        <div className="flex flex-col gap-3 p-4">
          <label className="text-xs text-ink-400">标题</label>
          <input
            className="input"
            value={editForm.title}
            onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
          />
          <label className="text-xs text-ink-400">作者</label>
          <input
            className="input"
            value={editForm.author}
            onChange={(e) => setEditForm((f) => ({ ...f, author: e.target.value }))}
          />
          <label className="text-xs text-ink-400">简介</label>
          <textarea
            className="input min-h-[96px] resize-none"
            value={editForm.description}
            onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
          />

          {/* 分类标签：首页筛选 chips 的来源 */}
          <label className="text-xs text-ink-400">分类 / 标签</label>
          <div className="flex flex-wrap gap-1.5">
            {editForm.tags.length === 0 && <span className="text-[11px] text-ink-500">还没有分类</span>}
            {editForm.tags.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1 rounded bg-ink-800 py-1 pl-2 pr-1 text-[11px] text-ink-200"
              >
                {t}
                <button
                  className="touch-hit rounded p-0.5 text-ink-500 transition-colors hover:text-red-400"
                  title={`删除分类「${t}」`}
                  onClick={() => setEditForm((f) => ({ ...f, tags: f.tags.filter((x) => x !== t) }))}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              className="input flex-1"
              value={tagInput}
              placeholder="输入分类后回车，多个用逗号分隔"
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addTags();
                }
              }}
            />
            <button className="btn-ghost px-3 ring-1 ring-ink-800" onClick={addTags}>
              添加
            </button>
          </div>
          <p className="text-[11px] leading-relaxed text-ink-500">
            这些分类就是首页筛选栏里的标签，点 × 删除后首页就不再显示它。保存过的分类会被锁定，重扫不会覆盖。
          </p>

          <button
            className="btn-primary mt-2"
            disabled={updateComic.isPending}
            onClick={() => {
              const title = editForm.title.trim();
              const author = editForm.author.trim();
              const description = editForm.description.trim();
              updateComic.mutate(
                {
                  id: comic.id,
                  body: {
                    title: title || undefined,
                    author: author || undefined,
                    description: description || undefined,
                    tags: editForm.tags,
                  },
                },
                {
                  onSuccess: () => {
                    setEditing(false);
                    toast.success('信息已保存');
                  },
                  // 以前保存失败是无提示的：面板一直开着，用户以为是网络卡了，反复点
                  onError: (e) =>
                    toast.error(`保存失败：${e instanceof Error ? e.message : '未知错误'}`),
                },
              );
            }}
          >
            {updateComic.isPending ? '保存中…' : '保存'}
          </button>
        </div>
      </Sheet>
    </div>
  );
}
