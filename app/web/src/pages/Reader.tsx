import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { ReaderShell } from '@/components/reader/ReaderShell';
import { ChevronLeft } from 'lucide-react';
import { useDelayedShow, useDevicePrefs } from '@/hooks';
import { useProgressSync, readLocalMirror } from '@/components/reader/useProgressSync';
import type { ResumeHint } from '@/components/reader/ReaderPrompt';
import { cachedPages, clearPagesCache, prefetchChapter } from '@/components/reader/chapterPrefetch';
import { useComicDetail } from '@/api/queries';
import { api } from '@/api/client';
import { readUrl } from '@/utils/nav';
import { doubleSubOffset, imageToModePage, modePageCount, modePageToImage } from '@/utils/pagerMode';
import type { DevicePrefs, PageMeta } from '@/types';
import { applyDevicePrefs } from '@/utils/devicePrefs';
import { Mascot } from '@/components/ui';

/** 空页清单常量：换章那一帧用它顶替上一章的页，避免用旧页数算起始位置 */
const EMPTY_PAGES: PageMeta[] = [];

/**
 * 阅读器异常/空状态页：阅读器是独立全屏路由（不在 AppShell 内），
 * 因此这些状态必须自带返回入口，否则用户只能靠浏览器后退。
 */
function ReaderFallback({
  title,
  hint,
  comicId,
  onRetry,
}: {
  title: string;
  hint?: string;
  comicId?: string;
  onRetry?: () => void;
}) {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-base font-semibold text-ink-200">{title}</p>
      {hint && <p className="max-w-sm text-xs leading-relaxed text-ink-500">{hint}</p>}
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        {/* 网络类失败可以原地重试，不必先退出再找回来 */}
        {onRetry && (
          <button className="btn-primary" onClick={onRetry}>
            重试
          </button>
        )}
        {comicId && (
          <button className="btn-ghost ring-1 ring-ink-800" onClick={() => navigate(`/comic/${comicId}`, { replace: true })}>
            返回漫画详情
          </button>
        )}
        <button className="btn-ghost ring-1 ring-ink-800" onClick={() => navigate('/')}>
          回首页
        </button>
      </div>
    </div>
  );
}

/**
 * 阅读器加载态：黑底 + 返回 + 吉祥物 + 一行提示词。
 *
 * 这里曾经是一套与真实阅读器**同构**的骨架（复刻顶栏 / 纸页 / 底栏），
 * 初衷是让加载完成时「只有中间那张纸从灰度变彩色」而不是整屏跳变。
 * 换成现在的方案，理由与代价都记在下面，将来要改回来先读完：
 *
 *   - 减下来的量没有想象中大：把「等待帧 → 完成帧」逐像素差分，有骨架时
 *     结构性变化 49.9%、无骨架 59.0%，平均亮度差 64.2 vs 83.2。
 *     一页漫画铺满屏幕本来就是「从无到有」，骨架只能抹平其中一小截。
 *   - 骨架在信息不足时是在**编造**：第一次进入连书名、页数都还没回来，
 *     那时画的顶栏占位条和 1:1.44 的纸框都是猜的，却伪装成确定的界面。
 *   - 反过来，这一层的陪伴价值被低估了——NAS 唤醒、手机离路由远时
 *     实测要干等 0.9~2.5 秒，屏幕上只有一个转圈。
 *
 * 仍然是实测约束，不是审美偏好：
 *   1. **120ms 阈值**：本地库打开一章 4~10ms 就绪，一闪而过的东西比不显示更像故障。
 *      阈值期间只铺黑底（与阅读器同色），所以「不显示」等于零闪烁。
 *   2. **700ms 门槛**：吉祥物只在确认这是次慢加载后才淡入，局域网里不会出现。
 *   3. **144px**：插画是 mask 线稿，缩到 80px 时线条细到亚像素、实测几乎隐形。
 *   4. **退出口不能省**：阅读器是全屏路由，没有返回就只能靠浏览器后退。
 */
function ReaderLoading({ label, comicId }: { label: string; comicId?: string }) {
  const navigate = useNavigate();
  const show = useDelayedShow(120);
  const showMascot = useDelayedShow(700);
  const exit = () => (comicId ? navigate(`/comic/${comicId}`, { replace: true }) : navigate('/'));

  return (
    <div
      className="dark fixed inset-0 z-[var(--layer-reader)] flex h-dvh flex-col bg-black"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      {show && (
        <div className="anim-loading-in flex h-full flex-col">
          {/* 顶栏只留返回：其余按钮此刻点了也不会有反应，不如不放 */}
          <div className="px-3 pb-2.5 pt-[max(0.625rem,env(safe-area-inset-top))]">
            <button
              className="btn-ghost touch-hit -ml-1 p-2 text-white/70"
              onClick={exit}
              aria-label={comicId ? '退出阅读，返回详情' : '退出阅读，回首页'}
            >
              <ChevronLeft size={20} />
            </button>
          </div>
          <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6">
            {/* 占位常驻、只淡入：届时凭空插一个 144px 元素会把下面那行字挤下去 */}
            <div className={`transition-opacity duration-300 ${showMascot ? 'opacity-100' : 'opacity-0'}`}>
              <Mascot kind="loading" className="mascot-light h-36 w-36" />
            </div>
            <p className="text-[13px] text-white/55">{label}</p>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 阅读器页面（方案 §4 P5）：加载章节页清单，驱动 ReaderShell。
 * 进度持久化按图索引（切模式不乱跳）；URL ?page= 承担恢复语义。
 *
 * 起始页优先级：**本次切章显式指定的页** > URL ?page= > 服务端进度 > 本地镜像 > 0。
 * 「显式指定」必须排第一：comic.progress 存的是「这本书上次读到哪」，
 * 目标章若恰好是上次读过的那章，续读逻辑就会把用户刚点的「下一章」顶回旧页号
 * （表现为切章后不从第 1 页开始）。
 */
export default function ReaderPage() {
  const { comicId = '', chapterId = '' } = useParams();
  const { hash } = useLocation();
  const navigate = useNavigate();
  const { data: comic, isLoading, isError, error, refetch } = useComicDetail(comicId);
  // 阅读偏好（翻页模式/方向/画质/适应/预加载/动画/常亮/双指）全部来自本机：
  // localStorage 是唯一真源，服务端不再保存这些项（见 docs/2026-10-24-偏好归属论证.md）
  const { prefs } = useDevicePrefs();
  const mode = prefs.readerMode;

  // 找不到对应章节时返回 -1（不回落到第 0 章，避免 URL 指向无效章节却展示别的章内容）
  const chapterIndex = useMemo(() => {
    if (!comic) return -1;
    const direct = comic.chapters.findIndex((c) => c.id === chapterId);
    if (direct >= 0) return direct;
    // 兼容旧链接：章节 id 含 '#'，未编码时会被当作锚点截断（/read/x/x#3 → chapterId=x, hash=#3）
    const m = /^#(\d+)$/.exec(hash);
    if (m) return comic.chapters.findIndex((c) => c.id === `${chapterId}#${m[1]}`);
    return -1;
  }, [comic, chapterId, hash]);
  const chapter = comic && chapterIndex >= 0 ? comic.chapters[chapterIndex] : undefined;

  /**
   * 页清单与章节 id 绑定：换章那一帧 pagesState 还是上一章的数据，
   * 这里直接当作空，避免用「上一章的页数/页序」算本章起始位置（两章页数相同时尤其隐蔽）。
   */
  const [pagesState, setPagesState] = useState<{ chapterId: string; items: PageMeta[]; error: string | null }>({
    chapterId: '',
    items: EMPTY_PAGES,
    error: null,
  });
  /** 页清单失败后的重试计数（详情/章节缺失都有重试，唯独这里没有入口） */
  const [pagesAttempt, setPagesAttempt] = useState(0);
  const loaded = chapter && pagesState.chapterId === chapter.id ? pagesState.items : null;
  /**
   * 预取过的章节直接用内存里的页清单渲染：换章不再等一次 JSON 往返。
   * 页数与章节元数据不一致时 cachedPages 返回 null（重新扫描会改页数），退回正常加载。
   */
  const cached = chapter ? cachedPages(comicId, chapter.id, chapter.pageCount) : null;
  const pages = loaded && loaded.length > 0 ? loaded : (cached ?? EMPTY_PAGES);
  const pagesError = loaded ? pagesState.error : null;
  const pagesLoading = !!chapter && !loaded && !cached;

  const [pageIndex, setPageIndex] = useState(0);
  /**
   * 双页模式下「当前对开里读到第几张」（0 / 1）。
   *
   * 双页的 pageIndex 只是对开号：图 6 和图 7 都映射到 3。只存对开号时，
   * 「单页读到图 7 → 切双页 → 切回单页」会退回图 6，用户感受到的是「切一下模式，
   * 在读页被改掉了」。用这个 0/1 偏移把对开内的位置也带上，进度、URL、
   * 切回单页都以它为准；整对开翻页时清零（新对开从第一张读起）。
   */
  const [doubleSub, setDoubleSub] = useState(0);
  /**
   * 已完成定位的「章节|模式」。上报进度必须等它，否则会把渲染初始值 pageIndex=0
   * 当成真实阅读位置写进服务端和本地镜像——定位逻辑随后恰好要读这份数据，
   * 于是「续读位置被自己覆盖成第 1 页」，且每次打开章节都白写一次进度。
   */
  const [positionedKey, setPositionedKey] = useState('');

  /** 本次切章的显式起始页（onChapterChange 写入，定位一次后消费掉） */
  const startRef = useRef<{ chapterId: string; image: number } | null>(null);
  /** 已定位过的「章节 + 模式」：同一章只定位一次，之后翻页不被入口逻辑改写 */
  const enteredRef = useRef('');
  /** 当前章内是否发生过用户主动翻页（用于判断「往回翻」，见相邻章节预取） */
  const turnedFor = useRef('');
  /** 续读提示：本章落点是从「上次读到哪」恢复出来的（判定见下方定位 effect） */
  const [resume, setResume] = useState<ResumeHint | null>(null);
  /**
   * 换章那一帧必须同步作废续读提示。
   * 切章时页清单要重新加载，ReaderShell 会整体卸载再挂回；它内部「同一条提示只弹一次」
   * 的 ref 随之丢失，而 resume 还是上一章的值 → 卸掉的那一帧还没定位就被重新播一遍
   * （表现为点「上一章/下一章」也弹「已续读」）。
   */
  const resumeChapter = useRef('');
  if (chapter && resumeChapter.current !== chapter.id) {
    resumeChapter.current = chapter.id;
    if (resume) setResume(null);
  }
  /**
   * 已生成过续读提示的章节。
   * 切翻页模式会让定位 effect 用同一个落点再跑一遍（URL 里带着图索引），
   * 那时不该又弹一次「已续读」——用户只是在改设置，不是被接回来。
   * 顺带让 StrictMode 的双次执行幂等（第二次不会再写，更不会把值清回 null）。
   */
  const resumeDoneFor = useRef('');

  // 加载章节页清单（预取已经拿到的章节不再重复请求）
  useEffect(() => {
    if (!comicId || !chapter?.id) return;
    const target = chapter.id;
    const ready = cachedPages(comicId, target, chapter.pageCount);
    if (ready) {
      setPagesState({ chapterId: target, items: ready, error: null });
      return;
    }
    let alive = true;
    api
      .pages(comicId, target)
      .then((r) => {
        if (!alive) return;
        setPagesState({ chapterId: target, items: r.pages, error: null });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setPagesState({
          chapterId: target,
          items: EMPTY_PAGES,
          error: e instanceof Error ? e.message : '章节加载失败',
        });
      });
    return () => {
      alive = false;
    };
  }, [comicId, chapter?.id, pagesAttempt]);

  // 进入章节：定位起始页（显式指定 > URL > 服务端进度 > 本地镜像 > 0）
  useEffect(() => {
    if (!chapter || pages.length === 0) return;
    const key = `${chapter.id}|${mode}`;
    if (enteredRef.current === key) return;
    enteredRef.current = key;

    const pending = startRef.current?.chapterId === chapter.id ? startRef.current : null;
    if (pending) startRef.current = null;

    const sp = new URLSearchParams(window.location.search);
    // ?page= 缺省和 ?page=0 必须区分：Number('') 也是 0，用 `> 0` 判断会让「第 1 页」被当成没写
    const rawPage = sp.get('page');
    const urlImg = rawPage === null || rawPage.trim() === '' ? null : Math.trunc(Number(rawPage));
    const urlPage = urlImg !== null && Number.isFinite(urlImg) && urlImg >= 0 ? urlImg : null;

    const progress = comic?.progress && comic.progress.chapterId === chapter.id ? comic.progress : null;
    // 本地镜像只作兜底：服务端没有这本书的进度，或镜像确实比服务端新时才采信，
    // 否则一份旧镜像会把「上次读的是别的章」这个事实顶掉
    const mirror = readLocalMirror(comicId);
    const mirrorImg =
      mirror && mirror.chapterId === chapter.id && (!comic?.progress || (mirror.updatedAt ?? 0) > comic.progress.updatedAt)
        ? mirror.pageIndex
        : null;

    const img = pending ? pending.image : (urlPage ?? progress?.pageIndex ?? mirrorImg ?? 0);
    const half = mode === 'split' && sp.get('half') === '1' ? 1 : 0;
    const maxPage = Math.max(0, modePageCount(mode, pages.length) - 1);
    const target = Math.max(0, Math.min(img, pages.length - 1));
    setPageIndex(Math.min(maxPage, imageToModePage(mode, target, pages.length) + half));
    // 双页：恢复「在这两页里读的是第几张」，才不会丢左/右页。
    // 不能写 target % 2 —— 首页单占之后对开起点可能是奇数张（见 doubleSpreads）
    setDoubleSub(mode === 'double' ? doubleSubOffset(target, pages.length) : 0);
    setPositionedKey(key);
    /**
     * 续读告知：只有「被接回来」才提示，三种情况不算——
     *   ① 本次切章是显式指定的（用户刚点「下一章」，本来就要从新章开头读）
     *   ② 落点就是第 1 页（没有「续」的成分，提示是自作多情）
     *   ③ 落点是本章最后一页（那一帧该出的是章末收尾卡，两张卡会互相顶掉）
     * 页码按**模式页**显示，与底部工具栏的「第 N / M 页」同一个口径。
     */
    if (!pending && img > 0 && img < pages.length - 1 && resumeDoneFor.current !== chapter.id) {
      resumeDoneFor.current = chapter.id;
      const shown = imageToModePage(mode, img, pages.length) + 1;
      const all = modePageCount(mode, pages.length);
      setResume({ key: `${chapter.id}|${img}`, label: `上次读到第 ${shown} / ${all} 页` });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages.length, chapter?.id, mode, comic]);

  /**
   * 当前读到的**图索引**（进度、URL、切模式都以它为准）。
   * 双页要叠上对开内的偏移 doubleSub（偏移本身由 pagerMode 的 doubleSubOffset 算出，
   * 不是图索引的奇偶）；末页是单张的对开会算出越界一页，clamp 掉。
   */
  const imageIndex =
    pages.length === 0
      ? 0
      : Math.min(
          pages.length - 1,
          Math.max(0, modePageToImage(mode, pageIndex, pages.length) + (mode === 'double' ? doubleSub : 0)),
        );

  // 翻页 → 同步 URL（replaceState，不污染历史）
  useEffect(() => {
    if (pages.length === 0) return;
    const url = new URL(window.location.href);
    // page 一律写图索引：切模式、刷新都能落回同一张图（双页对开内的偏移已并进图索引）
    url.searchParams.set('page', String(imageIndex));
    // 拆分模式一图两页，图索引之外还要记左半/右半
    if (mode === 'split') url.searchParams.set('half', String(pageIndex % 2));
    else url.searchParams.delete('half');
    window.history.replaceState(null, '', url);
  }, [pageIndex, pages.length, mode, imageIndex]);

  /**
   * 章末/章首提前预热相邻章节。
   *
   * 冷缩略图缓存下跨章实测 204ms，热缓存只要 53ms——慢的是「下一章首页第一次被编码」。
   * 所以不在换章那一刻抢时间，而是在用户还在读本章最后几页时把成本付掉：
   * 预取页清单（进内存）与首页图（进 HTTP 缓存），换章时就只剩渲染。
   * 延迟 300ms 再发，避免和当前页的渲染/解码抢带宽。
   */
  useEffect(() => {
    if (!comic || !chapter || pages.length === 0) return;
    const maxPage = Math.max(0, modePageCount(mode, pages.length) - 1);
    const NEAR = 3;
    const jobs: Array<() => void> = [];
    const next = comic.chapters[chapterIndex + 1];
    if (next && pageIndex >= maxPage - NEAR) {
      jobs.push(() => prefetchChapter(comic.id, next.id, next.pageCount, prefs.quality, 'first'));
    }
    const prev = comic.chapters[chapterIndex - 1];
    // 往回翻才预热上一章：刚打开就停在章首（续读、从目录进来）时预热上一章纯属白烧编码，
    // 还会和本章首屏那几张图抢服务端 CPU
    if (prev && pageIndex <= NEAR && turnedFor.current === chapter.id) {
      jobs.push(() => prefetchChapter(comic.id, prev.id, prev.pageCount, prefs.quality, 'last'));
    }
    if (jobs.length === 0) return;
    const t = window.setTimeout(() => jobs.forEach((run) => run()), 300);
    return () => window.clearTimeout(t);
  }, [comic, chapter, chapterIndex, pageIndex, pages.length, mode, prefs.quality]);

  // 离开阅读器就丢掉页清单缓存，避免长时间累积
  useEffect(() => () => clearPagesCache(), []);

  // 进度上报（按图索引）：定位生效后才上报，见 positionedKey 的注释
  const positioned = !!chapter && positionedKey === `${chapter.id}|${mode}`;
  useProgressSync(
    positioned && pages.length > 0 && comic && chapter
      ? {
          comicId,
          chapterId: chapter.id,
          chapterIndex,
          pageIndex: imageIndex,
          pageCount: pages.length,
          percent: Math.round(((imageIndex + 1) / pages.length) * 1000) / 10,
        }
      : null,
  );

  if (isLoading) return <ReaderLoading label="打开漫画…" comicId={comicId || undefined} />;
  // 请求失败 ≠ 漫画不存在：断网/服务重启时以前会说「漫画可能已被移动、删除」，
  // 而用户其实只需要重试一次
  if (isError) {
    return (
      <ReaderFallback
        title="打开失败"
        hint={`${error instanceof Error ? error.message : '请求失败'}｜检查 NAS 上的服务是否在运行`}
        comicId={comicId || undefined}
        onRetry={() => void refetch()}
      />
    );
  }
  if (!comic) {
    return <ReaderFallback title="漫画不存在" hint="可能已被移动、删除，或扫描尚未完成" />;
  }
  if (!chapter) {
    return (
      <ReaderFallback
        title="章节不存在"
        hint="该章节可能已随扫描结果变化，请回到详情页重新选择章节"
        comicId={comic.id}
      />
    );
  }
  if (pagesLoading) {
    return <ReaderLoading label="正在载入页面…" comicId={comic.id} />;
  }
  if (pagesError) {
    return (
      <ReaderFallback
        title="章节加载失败"
        hint={`${pagesError}｜可能是压缩包损坏、文件已移动，或尚未完成扫描`}
        comicId={comic.id}
        onRetry={() => {
          // 清掉当前章的失败态回到加载页，再触发一次请求
          setPagesState({ chapterId: '', items: EMPTY_PAGES, error: null });
          setPagesAttempt((n) => n + 1);
        }}
      />
    );
  }
  if (pages.length === 0) {
    return (
      <ReaderFallback
        title="章节没有页面"
        hint="该章目录中没有找到图片文件，请确认文件已放入并重新扫描"
        comicId={comic.id}
      />
    );
  }

  const maxPage = Math.max(0, modePageCount(mode, pages.length) - 1);
  const onPageChange = (i: number) => {
    turnedFor.current = chapter.id;
    setPageIndex(Math.min(maxPage, Math.max(0, i)));
    // 整对开翻页：新对开从第一张读起，不能把上一对开记下的右页偏移带过去
    setDoubleSub(0);
  };

  /**
   * 切章：显式给出目标页（默认第 1 页 = 图 0）。
   * 同时写入 startRef，让定位逻辑无视「这本书上次读到哪」——
   * 用户点「下一章」的意思是从新章开头读，不是回到上次那一页。
   */
  const onChapterChange = (i: number, page?: number) => {
    const target = comic.chapters[i];
    if (!target) return;
    const image = page ?? 0;
    startRef.current = { chapterId: target.id, image };
    navigate(readUrl(comic.id, target.id, image), { replace: true });
  };

  /**
   * 偏好变更：全部写本机（utils/devicePrefs.ts 的 store），不碰服务端。
   *
   * 翻页模式要先把「当前图索引」换算成新模式下的页码，否则单页读到图 7 时切双页
   * 会退成图 6。imageIndex 已含双页对开内的偏移，所以换算来回都稳。
   */
  const onPrefsChange = (patch: Partial<DevicePrefs>) => {
    if (patch.readerMode && patch.readerMode !== mode) {
      const next = patch.readerMode;
      setPageIndex(imageToModePage(next, imageIndex, pages.length));
      setDoubleSub(next === 'double' ? doubleSubOffset(imageIndex, pages.length) : 0);
    }
    applyDevicePrefs(patch);
  };

  return (
    <ReaderShell
      comic={comic}
      chapter={chapter}
      chapterIndex={chapterIndex}
      pages={pages}
      pageIndex={pageIndex}
      onPageChange={onPageChange}
      onChapterChange={onChapterChange}
      prefs={prefs}
      onPrefsChange={onPrefsChange}
      resume={resume}
    />
  );
}
