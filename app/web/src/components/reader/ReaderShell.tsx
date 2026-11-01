import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, LayoutGrid, List, Settings2, X } from 'lucide-react';
import { consumePanDragClick, DoublePager, SinglePager, SplitPager, WebtoonPager } from './pagers';
import { preloadPage, releasePreloadPool } from './page-image';
import { ChapterDrawer } from './ChapterDrawer';
import { ReaderSettingsSheet } from './ReaderSettingsSheet';
import { ReaderPrompt, useReaderPrompt, type ResumeHint } from './ReaderPrompt';
import { Sheet } from '@/components/ui';
import { modePageCount } from '@/utils/pagerMode';
import { useWakeLock } from '@/hooks/useWakeLock';
import { usePinchZoom } from './usePinchZoom';
import { readChapterView, writeChapterView, type ChapterView } from '@/utils/readerPrefs';
import type { Chapter, ComicDetail, DevicePrefs, PageMeta } from '@/types';

export interface ReaderShellProps {
  comic: ComicDetail;
  chapter: Chapter;
  chapterIndex: number;
  pages: PageMeta[];
  pageIndex: number;
  onPageChange: (i: number) => void;
  onChapterChange: (index: number, page?: number) => void;
  /** 设备偏好（翻页模式/方向/画质/适应/预加载/动画/常亮/双指） */
  prefs: DevicePrefs;
  onPrefsChange: (patch: Partial<DevicePrefs>) => void;
  /**
   * 续读提示：进入本章时落点是从「上次读到哪」恢复出来的（不是第 1 页）。
   * null = 从头开始读，不需要告知。判定在 Reader 里做（只有它知道落点来源）。
   */
  resume?: ResumeHint | null;
}

/**
 * 阅读器外壳（方案 §4 P5）：全屏独立层，脱离 AppShell。
 * 结构：顶部工具栏 / 页面区（四种翻页模式）/ 底部工具栏 + 两个弹出层。
 * 交互：单击中部显隐工具栏；两侧点击区翻页（rtl 左=下一页）；键盘 ←→↑↓ Esc。
 */
export function ReaderShell({
  comic,
  chapter,
  chapterIndex,
  pages,
  pageIndex,
  onPageChange,
  onChapterChange,
  prefs,
  onPrefsChange,
  resume = null,
}: ReaderShellProps) {
  const navigate = useNavigate();
  const [chromeVisible, setChromeVisible] = useState(true);
  // 保持常亮：真正申请 Screen Wake Lock（此前只有设置项，从未生效）
  useWakeLock(prefs.keepScreenOn);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * 阅读器内的一条轻提示。
   *   dir 有值 = 「到头了」那类，带方向图标、卡片从拉动的那一侧浮入；
   *   dir 为空 = 换章提示，纯文字。id 只用来重播入场动画（同一个文案连按两次也要重新入场）。
   */
  const [notice, setNotice] = useState<{ text: string; dir?: 'prev' | 'next'; id: number } | null>(null);
  /** 首/末页继续外翻时页面本体的「顶住-回弹」方向（340ms 后清空，与 CSS 动画时长一致） */
  const [bump, setBump] = useState<'next' | 'prev' | null>(null);
  /**
   * 提示与回弹的定时器句柄。
   * 不能直接 window.setTimeout 裸用：连续两次边界操作时，**上一次的清除定时器会把新提示清掉**
   * （表现为第二次提示一闪而过甚至看不到）。这里统一走 showNotice 并取消上一次。
   */
  const noticeTimer = useRef<number | null>(null);
  const bumpTimer = useRef<number | null>(null);
  const noticeSeq = useRef(0);
  const showNotice = (text: string, dir?: 'prev' | 'next', ms = 1500) => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeSeq.current += 1;
    setNotice({ text, dir, id: noticeSeq.current });
    noticeTimer.current = window.setTimeout(() => setNotice(null), ms);
  };
  const flashBump = (dir: 'next' | 'prev') => {
    if (bumpTimer.current) window.clearTimeout(bumpTimer.current);
    setBump(dir);
    bumpTimer.current = window.setTimeout(() => setBump(null), 360);
  };
  /** 可操作提示卡（目前只有续读告知一种）。与 notice 的分工见 ReaderPrompt.tsx 顶部 */
  const prompt = useReaderPrompt();
  /** 已弹过续读提示的章节：切翻页模式会重新定位一次，但那是同一次阅读，不该再告知一遍 */
  const resumePrompted = useRef('');
  useEffect(
    () => () => {
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
      if (bumpTimer.current) window.clearTimeout(bumpTimer.current);
    },
    [],
  );
  /** 章节抽屉视图：列表 / 一行四格（本机记忆） */
  const [chapterView, setChapterView] = useState<ChapterView>(() => readChapterView());
  // 双指缩放：换章/换页复位；关闭时整套手势不接管触摸
  const zoom = usePinchZoom(prefs.pinchZoom && prefs.readerMode !== 'webtoon', `${chapter.id}#${pageIndex}`);

  // 页码 / 滑块上限 / 越界判定一律按「模式页」算：
  // 双页 2 图 1 页、拆分 1 图 2 页，直接用图片数会算错（拆分拖不到后半页、双页到章末翻不出下一章）
  const total = modePageCount(prefs.readerMode, pages.length);
  const rtl = prefs.readDir === 'rtl';

  // 全屏时锁页面滚动
  useEffect(() => {
    document.body.classList.add('reader-lock');
    return () => document.body.classList.remove('reader-lock');
  }, []);

  /**
   * 退出阅读器时释放预加载池。
   * 池里每个 HTMLImageElement 都持有解码后的位图（约 7MB/张），不清的话回到
   * 首页浏览时这些内存仍然占着，手机 WebView 上很容易被系统回收整个页面。
   */
  useEffect(() => () => releasePreloadPool(), []);

  // 3 秒无操作自动隐藏工具栏（沉浸阅读）
  useEffect(() => {
    if (!chromeVisible || drawerOpen || settingsOpen) return;
    const t = setTimeout(() => setChromeVisible(false), 3000);
    return () => clearTimeout(t);
  }, [chromeVisible, drawerOpen, settingsOpen, pageIndex]);

  /**
   * 章末预取下一章首页。
   *
   * 预加载只覆盖「当前章内的页」；而「拖到章末继续拖」会直接换章，新章第 0 页
   * 从未请求过 —— 要等整张图下载 + 解码，观感就是换章那一下的明显白屏。
   * 距章末 2 页时开始预取，换章时通常已经在缓存里（preloadPage 幂等）。
   */
  useEffect(() => {
    if (pageIndex < total - 2) return;
    const next = comic.chapters[chapterIndex + 1];
    if (!next) return;
    preloadPage(comic.id, next.id, 0, prefs.quality);
  }, [comic.id, comic.chapters, chapterIndex, pageIndex, total, prefs.quality]);

  /**
   * 换章立刻收起提示卡。
   * 续读卡说的是「**这一章**的落点」，换了章还挂在那里就是指鹿为马。
   * 必须排在下面的 show 之前：同一轮渲染里先关再弹，新卡才不会被这次关闭带走。
   */
  useEffect(() => {
    prompt.dismiss();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter.id]);

  /**
   * 续读告知：落点是恢复出来的（不是第 1 页）时告诉用户「你在这里」，并给出回到开头的出口。
   *
   * 为什么需要它：进度是静默生效的——打开章节直接落在第 30 页，与「这本书本来就从
   * 第 30 页开始」在画面上完全无法区分。用户若其实是想从头重看，只能自己去拖滑块。
   */
  useEffect(() => {
    if (!resume || resumePrompted.current === resume.key) return;
    resumePrompted.current = resume.key;
    prompt.show({
      title: '已续读',
      desc: resume.label,
      actions: [{ label: '从头开始', onClick: () => onPageChange(0) }],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resume?.key]);

  /**
   * 越过章边界：forward = 往书的后一页方向。
   * 返回 true 表示确实换了章；false 表示整部漫画到头（已给提示 + 回弹）。
   *
   * 单独抽出来是因为有两条入口：点击/键盘走 turn()，拖动/横滑走 pager 的 onEdge。
   * 之前只有 turn() 里写了换章，拖动那条路在 pager 内部被 clamp 掉，
   * 于是「平移模式下拖到章末只会弹回，进不了下一章」。
   */
  const crossChapter = (forward: boolean): boolean => {
    if (forward && chapterIndex < comic.chapters.length - 1) {
      showNotice(`进入「${comic.chapters[chapterIndex + 1].title}」`);
      onChapterChange(chapterIndex + 1, 0);
      return true;
    }
    if (!forward && chapterIndex > 0) {
      const prev = comic.chapters[chapterIndex - 1];
      showNotice(`回到「${prev.title}」`);
      // 回上一章落到末页：与「往回翻」的预期一致
      onChapterChange(chapterIndex - 1, Math.max(0, (prev.pageCount || 1) - 1));
      return true;
    }
    /* 整部漫画的绝对边界。以前是「整页横抖 20px + 居中纯黑胶囊」，
       观感像系统 alert；现在是「页面被顶住后回弹一次 + 玻璃提示卡从拉动那一侧浮入」。
       注意 forward 是「翻页方向」，提示卡要从**拉动方向**进来，所以 dir 传的是反的。 */
    const dir = forward ? 'next' : 'prev';
    flashBump(dir);
    showNotice(dir === 'next' ? '已经是最后一页了' : '已经是第一页了', dir);
    return false;
  };

  const turn = (dir: 1 | -1) => {
    if (prefs.readerMode === 'webtoon') return; // 卷轴模式滚动即翻页
    const next = pageIndex + (rtl ? -dir : dir);
    if (next >= 0 && next < total) {
      onPageChange(next);
      return;
    }
    // 越界：章末继续往后 → 自动进入下一章首页；章首往前 → 上一章末页
    crossChapter(rtl ? dir === -1 : dir === 1);
  };

  // 键盘翻页（←/→、↑/↓、PageUp/PageDown、Esc）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 焦点在输入控件（页码滑块、设置项）时不要抢键，否则方向键会既拖滑块又翻页
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      // 弹层打开时不翻背后的页：焦点在面板按钮上时方向键会一路冒泡到这里，
      // 用户以为在操作面板，实际改的是阅读进度。Esc 由 useDialogA11y 在捕获阶段处理。
      if (drawerOpen || settingsOpen) return;
      switch (e.key) {
        case 'ArrowRight': turn(1); setChromeVisible(false); break;
        case 'ArrowLeft': turn(-1); setChromeVisible(false); break;
        // ↑/↓ 与 PageUp/PageDown 一直是桌面翻页键（与 ←/→ 等价）。
        // 原先这里还挂着 AudioVolume*/Volume*（音量键翻页），该功能已整体移除。
        case 'ArrowUp':
        case 'PageUp':
          turn(-1); setChromeVisible(false);
          break;
        case 'ArrowDown':
        case 'PageDown':
          turn(1); setChromeVisible(false);
          break;
        case 'Escape':
          if (drawerOpen) setDrawerOpen(false);
          else if (settingsOpen) setSettingsOpen(false);
          else navigate(`/comic/${comic.id}`);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIndex, total, chapterIndex, prefs.readerMode, prefs.readDir, drawerOpen, settingsOpen]);

  const exit = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate(`/comic/${comic.id}`);
  };

  const onSurfaceClick = (e: React.MouseEvent) => {
    // 松手那一刻的 click 不该被当成「点右侧翻页」
    if (zoom.shouldSwallowClick()) return;
    // 刚刚拖动过（横滑翻页 / 滑动待翻）：这次 click 是拖动的尾巴，吞掉
    if (consumePanDragClick()) return;
    const rect = e.currentTarget.getBoundingClientRect();
    // 放大状态下点击只切换工具栏：让用户能拖看细节，不会误翻页
    if (zoom.zoomed) {
      setChromeVisible((v) => !v);
      return;
    }
    const x = (e.clientX - rect.left) / rect.width;
    // 点哪边就往那边翻：与键盘 ←/→ 完全一致（turn 内部已按 readDir 处理方向），
    // 之前这里又乘了一次 rtl，导致「点左侧」与「按左键」方向相反
    if (prefs.readerMode !== 'webtoon' && x < 0.3) {
      turn(-1);
      setChromeVisible(false);
    } else if (prefs.readerMode !== 'webtoon' && x > 0.7) {
      turn(1);
      setChromeVisible(false);
    } else {
      setChromeVisible((v) => !v);
    }
  };

  const pagerProps = {
    comicId: comic.id,
    chapterId: chapter.id,
    pages,
    pageIndex,
    onPageChange,
    quality: prefs.quality,
    fit: prefs.fitMode,
    readDir: prefs.readDir,
    preloadCount: prefs.preloadCount,
    animation: prefs.pageAnimation,
    // 拖动/横滑越界时换章；相邻章是否存在决定边界要不要橡皮筋抵抗
    onEdge: crossChapter,
    hasPrevChapter: chapterIndex > 0,
    hasNextChapter: chapterIndex < comic.chapters.length - 1,
  };

  const Pager =
    prefs.readerMode === 'single' ? SinglePager
    : prefs.readerMode === 'double' ? DoublePager
    : prefs.readerMode === 'split' ? SplitPager
    : WebtoonPager;

  return (
    // h-dvh：手机地址栏展开时 inset-0 会按大视口铺满、底部工具栏被地址栏吞掉；
    // 显式 dvh 高度（top:0 + height 过约束时 bottom 被忽略）让工具栏始终贴在可见区底部
    <div className="fixed inset-0 z-[var(--layer-reader)] flex h-dvh flex-col bg-black anim-reader-in">
      {/* 顶部阅读进度细线：随页码推进，沉浸阅读时也能看到整体位置。
          用 scaleX 而不是 width：宽度动画每帧触发布局，进度线又是常驻元素 */}
      <div className="absolute inset-x-0 top-0 z-20 h-0.5 bg-white/10">
        <div
          className="h-full origin-left bg-brand-500 transition-transform duration-300 ease-out"
          style={{ transform: `scaleX(${total > 1 ? (pageIndex + 1) / total : 1})` }}
        />
      </div>

      {/* 顶部工具栏 */}
      <header
        className={`absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-black/85 via-black/45 to-transparent backdrop-blur-[2px] transition-opacity duration-200 ${
          chromeVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        {/* px 带左右安全区：平板横屏时前置挖孔在左侧/右侧，避免返回按钮与翻页按钮被吞 */}
        <div className="flex items-center gap-2 py-2.5 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-[max(0.625rem,env(safe-area-inset-top))]">
          <button className="btn-ghost touch-hit p-2 text-white" onClick={exit} aria-label="退出阅读">
            <ChevronLeft size={20} />
          </button>
          <div className="min-w-0 flex-1">
            <p className="line-clamp-1 text-sm font-medium text-white">{comic.title}</p>
            <p className="text-[11px] text-white/60">
              {chapterIndex + 1}/{comic.chapters.length} {chapter.title} · 第 {pageIndex + 1}/{total} 页
            </p>
          </div>
          <button className="btn-ghost touch-hit p-2 text-white" onClick={() => setDrawerOpen(true)} aria-label="章节目录">
            <List size={19} />
          </button>
          <button className="btn-ghost touch-hit p-2 text-white" onClick={() => setSettingsOpen(true)} aria-label="阅读设置">
            <Settings2 size={19} />
          </button>
        </div>
      </header>

      {/* 页面区（外层处理边界回弹，内层处理双指缩放变换） */}
      <div
        className="relative min-h-0 flex-1 select-none"
        onClick={onSurfaceClick}
      >
        <div
          className={`h-full w-full ${bump === 'next' ? 'anim-edge-bump-next' : bump === 'prev' ? 'anim-edge-bump-prev' : ''}`}
        >
          <div {...zoom.bind} style={zoom.style} className="reader-canvas h-full w-full overflow-hidden">
            {/* 放大时禁止内层接管指针：否则单指拖动会被当成滑动翻页 */}
            <div className={zoom.zoomed ? 'pointer-events-none h-full w-full' : 'h-full w-full'}>
              <Pager {...pagerProps} />
            </div>
          </div>
        </div>
      </div>

      {/* 底部工具栏 */}
      <footer
        className={`absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/85 via-black/45 to-transparent backdrop-blur-[2px] transition-opacity duration-200 ${
          chromeVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      >
        <div className="flex items-center gap-3 py-2.5 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pb-[max(0.625rem,env(safe-area-inset-bottom))]">
          <button
            className="btn-ghost touch-hit p-2 text-white"
            disabled={chapterIndex <= 0}
            onClick={() => onChapterChange(chapterIndex - 1)}
          >
            <ChevronLeft size={18} /> 上一章
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {/* 同理不要套 .touch-hit：会挡住 range 自己的触摸拖动 */}
            <span className="flex min-w-0 flex-1 items-center">
              <input
                type="range"
                min={0}
                max={Math.max(0, total - 1)}
                value={pageIndex}
                onChange={(e) => onPageChange(Number(e.target.value))}
                className="w-full accent-brand-500"
                aria-label="页码"
              />
            </span>
            <span className="w-14 text-right text-[11px] tabular-nums text-white/70">
              {pageIndex + 1}/{total}
            </span>
          </div>
          <button
            className="btn-ghost touch-hit p-2 text-white"
            disabled={chapterIndex >= comic.chapters.length - 1}
            onClick={() => onChapterChange(chapterIndex + 1)}
          >
            下一章 <ChevronRight size={18} />
          </button>
        </div>
      </footer>

      {/* 轻提示：玻璃胶囊。到头提示带方向图标，并从拉动的那一侧浮入（--from） */}
      {notice && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
          <div
            key={notice.id}
            className={`reader-notice ${notice.dir ? 'reader-notice-edge' : ''}`}
            style={{ '--from': notice.dir === 'prev' ? '-14px' : notice.dir === 'next' ? '14px' : '0px' } as CSSProperties}
            role="status"
            aria-live="polite"
          >
            {notice.dir === 'prev' && <ChevronsLeft size={14} className="reader-notice-icon shrink-0" />}
            {notice.dir === 'next' && <ChevronsRight size={14} className="reader-notice-icon shrink-0" />}
            <span>{notice.text}</span>
          </div>
        </div>
      )}

      {/* 可操作提示卡（续读告知 / 章末收尾 / 全书收尾） */}
      <ReaderPrompt prompt={prompt.prompt} onDismiss={prompt.dismiss} />

      {/* 章节抽屉 / 阅读设置：跟随外部主题。
          之前这里套过一层 <div className="dark"> 强制深色（当初担心浅色主题下
          白面板浮在黑底上突兀），但实测用户感知是「弹层和 App 不是一个主题」——
          ink 色阶本身随主题翻转，去掉包裹层后浅色主题出白面板、深色出深面板，
          与设置页的 Sheet 观感完全一致。 */}
      <>
        <Sheet
          open={drawerOpen}
          title={`章节（${comic.chapters.length}）`}
          onClose={() => setDrawerOpen(false)}
          headerRight={
            <button
              className="btn-ghost touch-hit flex items-center gap-1 px-2 py-1 text-xs"
              title={chapterView === 'grid' ? '切换为列表' : '切换为四格'}
              aria-label="切换章节布局"
              onClick={() => {
                const next: ChapterView = chapterView === 'grid' ? 'list' : 'grid';
                setChapterView(next);
                writeChapterView(next);
              }}
            >
              {chapterView === 'grid' ? <List size={15} /> : <LayoutGrid size={15} />}
              <span>{chapterView === 'grid' ? '列表' : '四格'}</span>
            </button>
          }
        >
          <ChapterDrawer
            chapters={comic.chapters}
            currentId={chapter.id}
            view={chapterView}
            onSelect={(i) => {
              setDrawerOpen(false);
              onChapterChange(i);
            }}
          />
        </Sheet>

        {/* 阅读设置 */}
        <Sheet open={settingsOpen} title="阅读设置" onClose={() => setSettingsOpen(false)}>
          <ReaderSettingsSheet prefs={prefs} onChange={onPrefsChange} />
        </Sheet>
      </>

      {/* 关闭提示（双击返回快速退出） */}
      {chromeVisible && (
        <button
          className="absolute right-3 top-1/2 z-20 hidden -translate-y-1/2 rounded-full bg-black/40 p-1.5 text-white/70 touch-hit lg:block"
          onClick={exit}
          title="退出阅读"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
