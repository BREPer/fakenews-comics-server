import { useCallback, useEffect, useRef, useState } from 'react';
import { History, X } from 'lucide-react';

/**
 * 阅读器「可操作提示卡」：目前只用于**续读告知**（落到恢复出来的页码时告诉用户
 * 「你在这里」+ 给一个回到开头的出口）。
 *
 * 与 ReaderShell 里的 notice（居中玻璃胶囊）分工不同，不要合并：
 *   notice = 瞬时反馈（「到头了」「进入下一章」），1.5s、无按钮、居中；
 *   prompt = 带出口的卡（用户此刻需要一个动作入口），6s、有按钮、从底部浮入——
 *            不遮画面中央，也不打断还在看的人。
 *
 * 曾经这里还有「章末读完 / 读完全书」两张收尾卡，因打断阅读而整体移除：
 * 读到最后几页正是最投入的时候，弹出一张带按钮的卡会把人从故事里拽出来。
 * 结论是**收尾只在书架 / 详情页体现**（readStatus 的「已读完」角标），阅读器内保持安静。
 * 将来要加别的卡，再给 PromptState 补一个 kind 字段区分图标即可。
 */

/** 卡片上的一个动作 */
export interface PromptAction {
  label: string;
  /** 主行动：品牌色实心。一行最多一个，放最右 */
  primary?: boolean;
  onClick: () => void;
}

export interface PromptState {
  /** 只用来重播入场动画（同一张卡连着出现两次也要重新浮入） */
  id: number;
  title: string;
  desc?: string;
  actions: PromptAction[];
  /** 退场中：播完 out 动画才真正卸载 */
  leaving?: boolean;
}

/**
 * 续读提示（由 Reader 判定后传进来）。
 * key 用于去重（同一章只提示一次），label 是格式化好的正文。
 */
export interface ResumeHint {
  key: string;
  label: string;
}

/** 卡片默认驻留时长。比 notice 长得多：带按钮的卡要给够读 + 点的時間 */
const DEFAULT_TTL = 6000;
/** 退场动画时长，必须与 CSS 的 prompt-out 一致 */
const OUT_MS = 200;

export function useReaderPrompt(ttl: number = DEFAULT_TTL) {
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const hideTimer = useRef<number | null>(null);
  const outTimer = useRef<number | null>(null);
  const seq = useRef(0);

  const clearTimers = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    if (outTimer.current) window.clearTimeout(outTimer.current);
    hideTimer.current = null;
    outTimer.current = null;
  };

  /**
   * 关闭：先播退场动画，再卸载。
   * 直接 setPrompt(null) 会让卡片硬消失——阅读器里其它退场（toast / 弹层）都是有收尾的，
   * 唯独这里硬切会显得像「卡被系统抽走」。
   */
  const dismiss = useCallback(() => {
    clearTimers();
    setPrompt((cur) => (cur && !cur.leaving ? { ...cur, leaving: true } : cur));
    outTimer.current = window.setTimeout(() => setPrompt((cur) => (cur?.leaving ? null : cur)), OUT_MS);
  }, []);

  const show = useCallback(
    (p: Omit<PromptState, 'id' | 'leaving'>) => {
      clearTimers();
      seq.current += 1;
      setPrompt({ ...p, id: seq.current });
      hideTimer.current = window.setTimeout(dismiss, ttl);
    },
    [dismiss, ttl],
  );

  useEffect(() => clearTimers, []);

  return { prompt, show, dismiss };
}

export function ReaderPrompt({
  prompt,
  onDismiss,
}: {
  prompt: PromptState | null;
  onDismiss: () => void;
}) {
  if (!prompt) return null;
  return (
    // 容器 pointer-events-none：只有卡片本体可点，别挡住后面的翻页点击区
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center px-3 pb-[calc(4.5rem+env(safe-area-inset-bottom))]">
      <div
        key={prompt.id}
        className={`reader-prompt ${prompt.leaving ? 'is-leaving' : ''}`}
        role="status"
        aria-live="polite"
        data-testid="reader-prompt"
        data-kind="resume"
      >
        <div className="flex items-start gap-2">
          <History size={15} className="reader-prompt-icon mt-[1px] shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold leading-tight text-white">{prompt.title}</p>
            {prompt.desc && (
              <p className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-white/60">{prompt.desc}</p>
            )}
          </div>
          <button
            className="press -mr-1 -mt-1 shrink-0 rounded-md p-1 text-white/45 hover:text-white/85"
            onClick={onDismiss}
            aria-label="关闭提示"
          >
            <X size={13} />
          </button>
        </div>
        {prompt.actions.length > 0 && (
          <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
            {prompt.actions.map((a) => (
              <button
                key={a.label}
                className={`reader-prompt-btn ${a.primary ? 'is-primary' : ''}`}
                // 点了就收起：动作已经发生，卡片留在屏幕上会挡住新的那一页
                onClick={() => {
                  a.onClick();
                  onDismiss();
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
