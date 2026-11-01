import type { Chapter } from '@/types';

/**
 * 章节抽屉：只标「当前正在阅读的章」。
 *
 * 早期还有「已读 / 在读百分比」标记，数据来自 chapter_progress（每章一行进度）。
 * 该表已整体移除 —— 进度只记录当前在读章节，非当前章不存任何进度数据，
 * 这里也就没有什么可显示的了：跳着读的用户看到的章节列表回归"干净"状态。
 */
export function ChapterDrawer({
  chapters,
  currentId,
  onSelect,
  view = 'list',
}: {
  chapters: Chapter[];
  currentId: string;
  onSelect: (index: number) => void;
  /** list=一行一章（信息全）｜grid=一行四格（章多时一屏能看更多） */
  view?: 'list' | 'grid';
}) {
  if (chapters.length === 0) {
    return <div className="px-4 py-6 text-center text-sm text-ink-500">未找到章节</div>;
  }

  if (view === 'grid') {
    return (
      <div className="grid grid-cols-4 gap-2 p-3">
        {chapters.map((ch) => {
          const isCurrent = ch.id === currentId;
          return (
            <button
              key={ch.id}
              title={`${ch.title}${ch.pageCount > 0 ? ` · ${ch.pageCount} 页` : ''}`}
              onClick={() => onSelect(ch.index)}
              // 高度固定（44px），与详情页章节四格保持一致。
              // 不用 aspect-square：宽度随容器变化时高度也会跟着变，横屏/平板上会过高。
              className={`press relative flex h-11 flex-col items-center justify-center rounded-lg text-sm transition-colors ${
                isCurrent ? 'bg-brand-600 font-semibold text-white' : 'bg-ink-800 text-ink-200 hover:bg-ink-700'
              }`}
            >
              <span className="tabular-nums">{ch.index + 1}</span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <ul className="divide-y divide-ink-800">
      {chapters.map((ch) => {
        const isCurrent = ch.id === currentId;
        return (
          <li key={ch.id}>
            <button
              className={`press flex w-full items-center justify-between border-l-2 px-4 py-3 text-left text-sm transition-colors hover:bg-ink-800/60 ${
                isCurrent ? 'border-brand-500 bg-brand-600/10 text-brand-400' : 'border-transparent text-ink-200'
              }`}
              onClick={() => onSelect(ch.index)}
            >
              <span className="line-clamp-1">
                {ch.index + 1}. {ch.title}
              </span>
              <span className="ml-3 flex shrink-0 items-center gap-2 text-[11px]">
                {isCurrent && <span className="text-brand-400">当前</span>}
                <span className="text-ink-500">{ch.pageCount > 0 ? `${ch.pageCount} 页` : ''}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
