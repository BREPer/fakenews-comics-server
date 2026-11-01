/**
 * 轻提示（toast）——「这件事成功了 / 失败了」的唯一出口。
 *
 * 为什么要它：本轮之前，大量操作是**完全静默**的——
 *   - 详情页保存元数据：成功只是面板消失（看不出保存了没），失败连提示都没有
 *   - 收藏切换：只有爱心变红，失败时只有一行小字且立刻消失
 *   - 清缓存 / 立即淘汰：没有任何回报
 *   - 漫画库新建/编辑/删除：只有面板关闭
 *   - 阅读记录删除：点了就没了，无法后悔
 * 「点了没反应」是最伤的体验，比慢一点、丑一点都更伤人——因为用户无从判断该重试还是该放弃。
 *
 * 为什么用模块级 store 而不是 Context：
 *   `useMutation` 的 onSuccess 里、事件回调里、甚至非组件模块里都要能调用，
 *   Context 需要拿到 hook，反过来会逼着每个调用点都变成组件。
 *   和 `utils/devicePrefs.ts` 用的是同一套 `useSyncExternalStore` 思路。
 *
 * 层级放在 --layer-toast(140)：必须在阅读器(100)、底部弹层(120)、确认框(130) 之上，
 * 否则「在弹层里点保存」看不到结果，提示等于没做。
 */
import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Check, Info, X } from 'lucide-react';

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
  /** 附带操作（目前只用于「撤销」），点了就执行并关闭 */
  action?: { label: string; run: () => void };
  /** 正在播退场动画：还在 DOM 里，但已经不可点，到点就移除 */
  leaving?: boolean;
}

/** 普通提示停留时长；错误留久一点（要读得完），带撤销的再久一点（要够手速） */
const TTL = { info: 2400, success: 2400, error: 4600 };
const TTL_ACTION = 6000;
/** 同时最多 3 条：再多会盖住内容，也没有阅读价值 */
const MAX = 3;
/**
 * 退场时长：淡出下沉 160ms，留 20ms 余量再卸载。
 * 之前是 0ms —— 进场 200ms 做得很细，消失却是一瞬间；多条堆叠时新条插入、
 * 旧条被挤掉也都是硬跳。
 */
const LEAVE_MS = 180;

let items: ToastItem[] = [];
const listeners = new Set<() => void>();
const timers = new Map<number, number>();
let seq = 0;

function emit() {
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function getSnapshot() {
  return items;
}

export function dismissToast(id: number) {
  const t = timers.get(id);
  if (t !== undefined) {
    window.clearTimeout(t);
    timers.delete(id);
  }
  const target = items.find((x) => x.id === id);
  // 已经在退场就不重复排定时器：否则「自动到点」和「手动点 X」会各排一个，
  // 第二次的 remove 会提前把元素摘掉，动画被截断
  if (!target || target.leaving) return;
  items = items.map((x) => (x.id === id ? { ...x, leaving: true } : x));
  emit();
  window.setTimeout(() => {
    items = items.filter((x) => x.id !== id);
    emit();
  }, LEAVE_MS);
}

function push(kind: ToastKind, text: string, action?: ToastItem['action']): number {
  const id = ++seq;
  items = [...items, { id, kind, text, action }].slice(-MAX);
  // 被挤出窗口的旧条目要把定时器收掉，否则它到点还会去改一次数组
  for (const k of [...timers.keys()]) {
    if (!items.some((i) => i.id === k)) {
      window.clearTimeout(timers.get(k)!);
      timers.delete(k);
    }
  }
  emit();
  timers.set(
    id,
    window.setTimeout(() => dismissToast(id), action ? TTL_ACTION : TTL[kind]),
  );
  return id;
}

export const toast = {
  info: (text: string) => push('info', text),
  success: (text: string) => push('success', text),
  error: (text: string) => push('error', text),
  /** 危险但可恢复的操作：给一个 6 秒的「撤销」窗口 */
  undo: (text: string, onUndo: () => void) =>
    push('info', text, {
      label: '撤销',
      run: () => {
        try {
          onUndo();
        } catch {
          toast.error('撤销失败');
        }
      },
    }),
  dismiss: dismissToast,
};

const ICON = {
  info: Info,
  success: Check,
  error: AlertCircle,
} as const;

/** 提示容器：挂在 App 根部（createPortal 到 body），登录页与阅读器同样可见 */
export function ToastHost() {
  const list = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (list.length === 0) return null;
  return createPortal(
    <div
      // 移动端抬到底部 Tab 之上；桌面收在右下角，不挡内容
      // 条目间距由每条的 pb-2 提供（不是容器 gap）：gap 在元素高度收起后仍然占位，
      // 会留下一道收不掉的空隙；放在内层则可以随 grid 行一起收掉
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[var(--layer-toast)] flex flex-col items-center
                 px-3 pb-[calc(4.75rem+env(safe-area-inset-bottom))] sm:inset-x-auto sm:right-6 sm:bottom-6 sm:items-end sm:px-0 sm:pb-0"
      aria-live="polite"
      aria-atomic="false"
    >
      {list.map((t) => {
        const Icon = ICON[t.kind];
        return (
          /*
            退场要收高度，否则「消失」只是淡出，下面的条目是瞬间往上跳一格。
            grid-template-rows 0fr↔1fr 让浏览器自己算目标高度，无需测量
            （和首页扫描横幅用的是同一招）。
          */
          <div
            key={t.id}
            className={`grid transition-[grid-template-rows] duration-150 ease-out ${
              t.leaving ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'
            }`}
          >
            <div className="overflow-hidden pb-2 last:pb-0">
              <div
                role={t.kind === 'error' ? 'alert' : 'status'}
                // 探针用（tools/feedback_check.mjs）：页面上还有别的 role=status（加载态）
                data-toast={t.kind}
                // 退场期间仍在 DOM 里，给探针一个排除手段：断言「关掉了」时按这个过滤
                data-toast-leaving={t.leaving ? '1' : undefined}
                /*
                  进场 / 退场两个 animation 类必须互斥：入场是 `both`，动画结束后
                  transform 仍由它持有，会盖掉退场动画的位移，只剩透明度在变。
                */
                className={`${t.leaving ? 'anim-toast-out pointer-events-none' : 'anim-toast-in pointer-events-auto'} flex max-w-[min(92vw,26rem)] items-center gap-2.5 rounded-xl
                           bg-ink-900/90 px-3 py-2.5 text-xs text-ink-200 shadow-panel ring-1 ring-ink-800/70
                           backdrop-blur-xl backdrop-saturate-150`}
              >
                <Icon
                  size={15}
                  className={`shrink-0 ${
                    t.kind === 'error' ? 'text-red-400' : t.kind === 'success' ? 'text-brand-500' : 'text-ink-400'
                  }`}
                />
                <span className="min-w-0 flex-1 leading-relaxed">{t.text}</span>
                {t.action && (
                  <button
                    className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-brand-500
                               transition-colors duration-150 hover:bg-brand-500/10"
                    onClick={() => {
                      dismissToast(t.id);
                      t.action!.run();
                    }}
                  >
                    {t.action.label}
                  </button>
                )}
                <button
                  className="shrink-0 rounded-md p-1 text-ink-500 transition-colors duration-150 hover:text-ink-200"
                  onClick={() => dismissToast(t.id)}
                  aria-label="关闭提示"
                >
                  <X size={12} />
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
