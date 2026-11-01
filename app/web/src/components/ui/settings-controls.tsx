import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * 设置类控件的共享原语：Row / Segmented / Toggle。
 *
 * 为什么必须放在模块级而不是写在页面组件里：
 * 组件函数体内定义 `const Row = (...) => ...` 每次渲染都会生成**新的组件类型**，
 * React 视其为不同组件 → 整棵子树 unmount 后重新 mount。
 * 实测后果（设置页）：给滑块打标记并聚焦，点一下别的设置项，滑块节点就被销毁重建
 * （sameNode=false、焦点丢失），拖动因此只有按下位置生效。
 *
 * 布局规则（手机端统一的基本盘）：
 *   Row.block —— 窄屏（<sm）控件独占一行、左起，配合 Segmented.fill 等分整行；
 *                ≥sm 回到「标签左 + 控件右」，桌面观感不变。
 *   开关类（Toggle）不传 block：始终「标签左 + 开关右」，与 iOS 设置页一致。
 *
 *   Row.uniform —— 控件列取固定宽度（13rem），配合 Segmented.stretch。
 *      两种用法：
 *      a) 弹层这类「多行并排、每行控件选项数不同」的场景（不带 block）：所有视口
 *         都固定宽。不统一时右缘虽然对齐，左缘会随选项数/文字长短参差 160px 以上。
 *      b) 设置页的分段行（block + uniform）：窄屏仍走 block 的「独占一行等分」，
 *         ≥sm 控件列固定 13rem、Segmented.stretch 铺满 —— 与弹层同一套尺寸，
 *         桌面上各行的控件左缘才落在同一条竖线上（设置页桌面实测左缘参差 88px）。
 *      宽度取 13rem ≈ 最宽的一行（弹层「翻页模式」4 段含「拆分双页」实测 204px，
 *      设置页最宽为 180px，都在此余量内）；父级是 flex-wrap，空间不够时控件
 *      整块落到第二行，不会被压缩变形。
 */

export function Row({
  label,
  hint,
  children,
  block = false,
  uniform = false,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  /** 选择类控件（分段选择器）在窄屏独占一行并铺满整宽 */
  block?: boolean;
  /** 控件列固定宽度：让同一组里各行的控件左右缘都对齐（见文件头） */
  uniform?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-start justify-end gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-[8rem] flex-1">
        <p className="text-sm">{label}</p>
        {/* break-words：目录路径这类无空格长 token 必须在容器内断开，否则撑宽标签列 */}
        {hint && <p className="break-words text-[11px] text-ink-500">{hint}</p>}
      </div>
      <div
        className={`flex shrink-0 flex-wrap items-center gap-2 ${
          block
            ? // 窄屏独占一行、左起；≥sm 控件列固定宽（uniform）或按内容宽贴右
              uniform
              ? 'w-full justify-start sm:w-[13rem] sm:justify-end'
              : 'w-full justify-start sm:w-auto sm:justify-end'
            : uniform
              ? 'w-[13rem] justify-end'
              : // 非 block（开关/数值）行：容器取标签首行高度，控件在其中垂直居中
                'min-h-[1.25rem] justify-end'
        }`}
      >
        {children}
      </div>
    </div>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  disabled,
  fill,
  stretch,
  disabledHint,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
  /** 配合 Row 的 block：窄屏下按钮等分整行宽度（≥sm 恢复按内容宽度排列） */
  fill?: boolean;
  /**
   * 配合 Row 的 uniform：始终铺满控件列，把多余宽度**按内容比例**分给各段。
   *
   * 与 fill 的区别不只是「始终」：按钮用 grow + basis-auto（不是 basis-0），
   * 分配的是剩余空间而不是把每段拉成等宽 —— 「拆分双页」这类长段若被等分压到
   * 51px，4 个字（需 68px）会挤成两行；basis-auto 下它拿到 68+2，短段拿到 44+2，
   * 各段仍按文字长短，整块宽度才统一。
   */
  stretch?: boolean;
  disabledHint?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  /**
   * 滑动指示器的位置（相对容器的 left / width）。
   *
   * 必须实测而不是按序号算百分比：选项宽度并不相等（「关 / 1 / 3 / 5 / 8」与
   * 「列表 / 四格」就不一样），写死比例会错位。
   */
  const [ind, setInd] = useState<{ left: number; width: number } | null>(null);
  /*
   * options 是调用方内联的字面量，每次渲染都是新数组 —— 直接进依赖数组的话，
   * 下面的 effect 会每渲染一次就重连一次 ResizeObserver 并 setState，形成回环。
   * 用「取值的拼接串」当依赖：既稳定，又能在选项本身变化时重新测量。
   */
  const optKey = options.map((o) => String(o.value)).join('|');

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => {
      const el = wrap.querySelector<HTMLElement>(`[data-seg-value="${CSS.escape(String(value))}"]`);
      if (!el) {
        setInd(null);
        return;
      }
      const w = wrap.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const next = { left: r.left - w.left, width: r.width };
      // 值没变就返回原对象：返回新对象会让 React 每次都重渲染 → 再次测量 → 回环
      setInd((prev) => (prev && prev.left === next.left && prev.width === next.width ? prev : next));
    };
    measure();
    // 容器宽度随断点变化（fill 时按钮在窄屏等分整行），尺寸变了必须重新测量，
    // 否则旋转屏幕 / 改变窗口宽度后指示器会停在旧位置
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [value, optKey]);

  // 三种排布的 grow/basis 互斥，必须整串替换：同时写出 .grow 与 .grow-0 时
  // 生效的取决于 CSS 里的先后顺序，不是 class 属性的书写顺序。
  // fill+stretch 组合（设置页分段行）：窄屏按 fill 等分（basis-0），≥sm 按
  // stretch 铺满控件列、各段拿「自身内容宽 + 均分剩余」—— 与弹层同款观感。
  const growClass = stretch
    ? fill
      ? 'grow basis-auto max-sm:basis-0'
      : 'grow basis-auto'
    : fill
      ? 'max-sm:basis-0 max-sm:grow'
      : 'grow-0 basis-auto';

  return (
    <div
      ref={wrapRef}
      className={`relative flex shrink-0 rounded-lg bg-ink-800 p-0.5 ${
        stretch ? 'w-full' : fill ? 'w-full sm:w-auto' : ''
      }`}
    >
      {/*
        滑动指示器：把「选中背景」从按钮自身挪到这一层，它才能在选项之间滑过去。
        只在测量到位置之后才渲染 —— 首次渲染就带 transform 时，mount 那一帧没有
        起始值（过渡不会跑），正好省掉「页面一进来指示器从最左边滑过来」。
      */}
      {ind && !disabled && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0.5 left-0 top-0.5 rounded-md bg-brand-600
                     transition-transform duration-200 ease-out-quint"
          style={{ transform: `translateX(${ind.left}px)`, width: ind.width }}
        />
      )}
      {options.map((o) => (
        <button
          key={String(o.value)}
          data-seg-value={String(o.value)}
          disabled={disabled}
          title={disabled ? disabledHint : undefined}
          aria-pressed={!disabled && value === o.value}
          className={`touch-hit relative z-10 rounded-md px-2.5 py-1 text-xs transition-colors ${growClass} ${
            disabled
              ? 'cursor-not-allowed text-ink-500 opacity-50'
              : value === o.value
                ? 'text-white'
                : 'text-ink-400 hover:text-ink-200'
          }`}
          onClick={() => !disabled && onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  /** 行标题（读屏用）—— 行标题是 <p>，不会自动成为按钮的可访问名 */
  label: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`touch-hit relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ${
        on ? 'bg-brand-600' : 'bg-ink-700'
      }`}
      onClick={() => onChange(!on)}
    >
      {/*
        滑块位移走 transform，不再过渡 left。

        left 是布局属性：动画期间每一帧都要重算布局（reflow），而这类弱 CPU 的
        NAS 设备上，交互路径上最不该出现的就是逐帧重排。transform 走合成器，
        不触发重排，观感完全一致。

        位移量 20px（= translate-x-5）：轨道 44 − 滑块 20 − 左右各留 2，
        与原来的 left-0.5 → left-[22px] 是同一个落点。

        transition-all 也要收窄成 transition-transform：all 会把 box-shadow 之类
        一并拖进过渡，属于白付的开销。
      */}
      <span
        className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200 ease-out-quint ${
          on ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

/**
 * 预加载页数为什么不做成步进器/滑块，而是档位（Segmented）：
 *   - 滑块（input[type=range]）：触屏下被做到 44px 高还横跨大半个行宽，「瞄一眼」
 *     和「真改」在手势上无法区分，蹭过去就改值，连带触发保存请求与预加载池重建。
 *   - 步进器（− 3 页 +）：意图分得开，但它是全页唯一的数字控件——20px 大数字
 *     夹在一堆 12-14px 的 Segmented/Toggle 中间，视觉重量失衡，用户反馈「碍眼」。
 *   - 档位（关/1/3/5/8）：与适应方式、翻页动画完全同款，大数字消失，点击目标
 *     反而更大。0-8 里用户真正会用的就这几档；存量中间值由 devicePrefs 吸附到
 *     最近档（平局取更小：少预载不会 OOM）。
 */
