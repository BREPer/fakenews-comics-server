import { type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, X } from 'lucide-react';
import { useDelayedShow } from '@/hooks';
import { useDialogA11y, usePresence, useScrollLock } from './useDialog';

/*
 * 弹层退出动画的兜底卸载时长（ms）。
 * 必须与对应面板的 CSS transition duration 对齐（或略大），否则面板会在动画
 * 没跑完时被卸载 —— 表现为退出动画被截断。两处分开写死最容易漏改，所以放一起。
 * - Sheet：面板 transition-transform duration-[320ms]
 * - ConfirmDialog：面板 transition-[transform,opacity] duration-200（留 40ms 余量）
 */
const SHEET_EXIT_MS = 320;
const DIALOG_EXIT_MS = 240;

/**
 * 应用 Logo（与 fpk 图标同源：`app/web/public/logo.*` 由 `tools/gen_icons.py`
 * 从 `tools/logo_source.png` 生成）。用 <picture> 优先 webp，老浏览器回退 png；
 * 圆角已经烘进图片，外层的 22% 圆角只用于让阴影/裁切贴合。
 */
export function BrandLogo({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <picture>
      <source srcSet="/logo.webp" type="image/webp" />
      <img
        src="/logo.png"
        alt="肥牛漫画"
        width={size}
        height={size}
        draggable={false}
        className={`shrink-0 rounded-[22%] object-cover ${className}`}
        style={{ width: size, height: size }}
      />
    </picture>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return <Loader2 className={`animate-spin ${className}`} size={18} />;
}

/** 通用骨架块（尺寸/圆角由调用方给，流光样式见 index.css 的 .skeleton） */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

/**
 * 等待页吉祥物的出场门槛。
 *
 * 不是凭感觉定的（三档限速实测，tools/wait_timing.mjs）：
 *   局域网 0~95ms、弱 WiFi 157~420ms、NAS 唤醒 448~2538ms。
 * 600ms 落在中间那条空档上，于是前两档一次都不会出现，只有第三档迎接它。
 * 定在 500ms 时试过：会出现「刚淡入就结束」的 41ms 闪影，比不出现更糟。
 */
const MASCOT_DELAY = 600;

/**
 * 「骨架顶不住、已经换页」之后用的参数：**不再压门槛**（0ms），淡入 300ms。
 *
 * 背景（2026-10-28 限速实测，见 docs §7.7）：首屏守卫现在先延续启动壳，
 * 600ms 之后才换成等待页（`RequireAuth` 的 SHELL_HOLD_MS）。既然用户已经盯着骨架
 * 等了 600ms，换页那一刻吉祥物就该在场，再叠一道 200ms 门槛只会让"换页"看起来像
 * "又从头开始加载"。
 *
 * 早先这里是 {200ms, 120ms}——那是直接显示等待页时的取值，实测在真实弱网下
 * （这一屏只活 206ms）她仍然来不及出场，属于对参数过度自信，已废弃。
 */
export const AFTER_BOOT_MASCOT = { delayMs: 0, fadeMs: 300 } as const;

/**
 * 整块等待（首屏守卫、书库/设置加载、路由 Suspense 兜底）。
 *
 * mascot：等过门槛才把吉祥物放上来。以前这里只有 spinner + 一行字，
 * NAS 唤醒那次实测要干等 2.5 秒，屏幕上什么都没有。
 * variant="after-boot"：首屏守卫换页后立刻显示，理由见 AFTER_BOOT_MASCOT。
 */
export function Loading({
  label,
  mascot = true,
  variant = 'default',
}: {
  label?: string;
  mascot?: boolean;
  variant?: 'default' | 'after-boot';
}) {
  // hook 必须无条件调用：写成 mascot && useDelayedShow() 会在 mascot=false 时少调用一次
  const { delayMs, fadeMs } = variant === 'after-boot' ? AFTER_BOOT_MASCOT : { delayMs: MASCOT_DELAY, fadeMs: 300 };
  const delayed = useDelayedShow(delayMs);
  const showMascot = mascot && delayed;
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-400">
      {/*
        占位常驻、只淡入：届时若凭空插一个元素会把下面的 spinner 顶下去
        108px（这是整块居中的等待，位移会读成一次抖动）。占着位也没有
        副作用——局域网里这块总共只存在几十毫秒。
      */}
      <div
        className={`transition-opacity ${showMascot ? 'opacity-100' : 'opacity-0'}`}
        style={{ transitionDuration: `${fadeMs}ms` }}
      >
        <Mascot kind="loading" className="h-24 w-24" />
      </div>
      <Spinner className="h-6 w-6" />
      {label && <p className="text-sm">{label}</p>}
    </div>
  );
}

export type MascotKind = '404' | 'empty' | 'search' | 'load-failed' | 'login' | 'loading' | 'thank';

/**
 * 吉祥物状态插画（品牌牛角娘，布卡娘式的点缀）。
 *
 * 两种出场场合，规则不同：
 *   - **结果性状态**（空 / 出错 / 404 / 登录）：事情有结果了，直接给。
 *   - **等待**：要延迟 ——— 局域网里等待只有几十毫秒，那时候她出现等于一闪而过的
 *     噪点；等真的慢下来（NAS 硬盘休眠、手机离路由远，实测 0.9~2.5 秒的干等）
 *     才请她出来。阈值 600ms，依据见上面的 MASCOT_DELAY。
 * 素材与配色（跟着主题文字走）见 index.css 的 .mascot 区块。
 */
export function Mascot({ kind, className = '' }: { kind: MascotKind; className?: string }) {
  return <div aria-hidden="true" className={`mascot mascot-${kind} ${className}`} />;
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
  mascot,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
  /** 传了就用吉祥物插画顶替 icon（两者不并用，插画本身就是大号图标） */
  mascot?: MascotKind;
}) {
  return (
    // animate-rise：这一块是「请求回来了但什么都没有 / 出错了」的整块替换，
    // 之前是凭空出现；它是居中的小块（不是大容器），位移不会读成错位。
    <div className="animate-rise flex flex-col items-center justify-center gap-3 py-20 text-center">
      {mascot && <Mascot kind={mascot} className="h-32 w-32" />}
      {!mascot && icon && <div className="text-ink-600">{icon}</div>}
      <p className="text-sm font-medium text-ink-300">{title}</p>
      {hint && <p className="max-w-xs text-xs text-ink-500">{hint}</p>}
      {action}
    </div>
  );
}

/**
 * 请求失败态。
 *
 * 必须和 EmptyState 分开：以前首页/搜索页把 `isError` 也走「还没有漫画 / 没有找到」，
 * 于是「NAS 关机」「扫描期间后端忙到超时」看起来都像「你真的没有书」——
 * 用户既不知道发生了什么，也没有任何重试入口。这里把原始 message 摆出来并给重试。
 */
export function ErrorState({
  title = '加载失败',
  hint,
  error,
  onRetry,
  retryLabel = '重试',
}: {
  title?: string;
  hint?: string;
  error?: unknown;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  const msg =
    error instanceof Error ? error.message : typeof error === 'string' && error ? error : '';
  return (
    <div
      role="alert"
      className="animate-rise flex flex-col items-center justify-center gap-3 rounded-2xl bg-red-500/[0.06] px-5 py-14 text-center ring-1 ring-red-500/25"
    >
      {/* 摊手耸肩的吉祥物顶替原来的警示三角：报错也可以不板着脸 */}
      <Mascot kind="load-failed" className="h-28 w-28" />
      {/* 标题与吉祥物同一个 ink-300：插画颜色取自这个变量，字和画永远同色 */}
      <p className="text-sm font-medium text-ink-300">{title}</p>
      {msg && <p className="max-w-sm text-xs leading-relaxed text-ink-400">{msg}</p>}
      {hint && <p className="max-w-sm text-[11px] text-ink-400/90">{hint}</p>}
      {onRetry && (
        <button className="btn-primary mt-1" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}

/**
 * 底部弹出层（章节抽屉 / 阅读设置 / 元数据编辑共用）。
 *
 * 与 ConfirmDialog 共用 .scrim（遮罩）与 .panel-surface（面板材质）——
 * 两者都是「浮在页面之上的模态层」，压暗程度与质感必须同口径；
 * 入场方式不同（面板从边缘滑入、对话框从中心冒出）是有意的，不统一。
 */
export function Sheet({
  open,
  title,
  onClose,
  children,
  side = 'bottom',
  headerRight,
}: {
  open: boolean;
  title?: string;
  onClose: () => void;
  children: ReactNode;
  side?: 'bottom' | 'right';
  /** 标题栏右侧的额外操作（如章节抽屉的列表/网格切换），排在「关闭」左边 */
  headerRight?: ReactNode;
}) {
  // 挂载/显隐状态机见 usePresence：双 rAF 建立过渡起点，且两层都要可取消
  const { mounted, show, unmount } = usePresence(open, SHEET_EXIT_MS);

  // 键盘 / 读屏支持（Esc 关闭、焦点移入并归还、Tab 只在面板内循环）。
  // 必须在下面那个 `if (!mounted) return null` 之前调用——hooks 不能被条件跳过。
  const panelRef = useDialogA11y<HTMLDivElement>(open, onClose);
  // 面板开着时不让背后页面滚动（关掉后位置变了要重新找，书库无限列表尤其明显）
  useScrollLock(open);

  if (!mounted) return null;
  const panelPos = side === 'bottom' ? (show ? 'translate-y-0' : 'translate-y-full') : show ? 'translate-x-0' : 'translate-x-full';  /*
   * 用 portal 挂到 body：
   * 弹层是 fixed inset-0，但渲染在页面组件树里时，只要任一祖先带有 transform /
   * opacity<1 / filter / animation（比如 <main> 的路由淡入）就会形成新的层叠上下文，
   * z-index 只在这个上下文内比较 —— 底栏（body 层级 z-40）就会盖到弹层上。
   * 实测：漫画库的「新建/编辑」面板底部被底栏压住，表单文字被截断。
   * 挂到 body 后弹层永远在页面内容与底栏之上，不再受任何祖先样式影响。
   *
   * 挂到 body 的代价是层级要和「全屏层」直接比数字：阅读器根节点是 --layer-reader(100)，
   * 所以弹层必须用 --layer-sheet(120)，否则阅读器里的章节/设置面板会被整片盖住
   * （面板渲染成功、点击却没反应）。层级定义见 index.css 的 :root。
   */
  return createPortal(
    <div className="fixed inset-0 z-[var(--layer-sheet)] flex">
      {/* 遮罩：与确认弹窗同一套（.scrim），压暗与模糊不再各写一份 */}
      <div
        className={`scrim transition-opacity duration-200 ease-out-quint ${
          show ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title ?? '面板'}
        className={`absolute flex w-full flex-col panel-surface shadow-panel
                    outline-none
                    transition-transform duration-[320ms] ease-out-quint ${
          side === 'bottom'
            ? 'inset-x-0 bottom-0 max-h-sheet rounded-t-3xl'
            : 'inset-y-0 right-0 max-w-md rounded-l-3xl'
        } ${panelPos}`}
        onTransitionEnd={(e) => {
          // 仅退出过渡结束时卸载；多个属性过渡会多次触发，限定面板自身
          if (!open && e.target === e.currentTarget) unmount();
        }}
      >
        {/* 底部弹层的把手：一个可抓的视觉锚点，配合上滑手感 */}
        {side === 'bottom' && <div className="sheet-grabber" />}
        {title && (
          <div className="flex items-center justify-between border-b border-ink-800/70 px-4 py-3">
            <h3 className="text-sm font-semibold">{title}</h3>
            <div className="flex items-center gap-1">
              {headerRight}
              {/*
                关闭改成图标：原来是个 24px 高的「关闭」二字按钮，手机上既不好点
                （没加 touch-hit），标题栏右侧还常年占着两个字的宽度。
                图标 + touch-hit 命中区补到 44px，视觉尺寸不变。
              */}
              <button
                className="press touch-hit rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
                onClick={onClose}
                aria-label="关闭"
                title="关闭"
              >
                <X size={16} />
              </button>
            </div>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** 简单的确认弹窗 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '确认',
  danger,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message?: string;
  confirmText?: string;
  danger?: boolean;
  /** 确认操作进行中：禁用按钮，避免重复提交 */
  busy?: boolean;
  /** 上次执行失败的原因（直接展示给用户，不再静默失败） */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { mounted, show, unmount } = usePresence(open, DIALOG_EXIT_MS);
  const panelRef = useDialogA11y<HTMLDivElement>(open, onCancel, busy);
  useScrollLock(open);
  if (!mounted) return null;
  // 同 Sheet：挂到 body，避免被祖先的层叠上下文/底栏盖住；层级用 --layer-modal（130），
  // 保证在阅读器（100）与底部弹层（120）之上
  return createPortal(
    <div className="fixed inset-0 z-[var(--layer-modal)] flex items-center justify-center p-6">
      <div
        className={`scrim transition-opacity duration-200 ${show ? 'opacity-100' : 'opacity-0'}`}
        onClick={onCancel}
      />
        <div
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          // 与底部面板同一套材质（.panel-surface）与圆角（3xl）：同为模态层，
          // 不该一个是实心 card、一个是半透玻璃。入场仍用缩放（从中心冒出），
          // 与面板的滑入区分开——这个差异是语义性的，保留。
          className={`panel-surface relative w-full max-w-sm rounded-3xl p-5 shadow-panel outline-none
                      transition-[transform,opacity] duration-200 ease-spring ${
            show ? 'scale-100 opacity-100' : 'scale-95 opacity-0'
          }`}
        onTransitionEnd={(e) => {
          if (!open && e.target === e.currentTarget) unmount();
        }}
      >
        <h3 className="text-base font-semibold">{title}</h3>
        {message && <p className="mt-2 text-sm text-ink-400">{message}</p>}
        {error && (
          <p className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-red-300">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          {/* 初始焦点给「取消」而不是「确认/删除」：危险操作不该被一个回车直接执行 */}
          <button className="btn-ghost" data-autofocus onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            className={`btn ${danger ? 'bg-red-600 text-white hover:bg-red-500' : 'bg-brand-600 text-white hover:bg-brand-500'} disabled:opacity-60`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? '处理中…' : confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
