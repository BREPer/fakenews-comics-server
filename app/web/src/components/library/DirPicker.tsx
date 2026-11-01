import { useEffect, useState } from 'react';
import { ChevronRight, Folder, FolderOpen, Loader2 } from 'lucide-react';
import { api } from '@/api/client';
import { Sheet } from '@/components/ui';

/**
 * 库路径点选器（对齐 2026-10-28 的决定：路径手输是错的温床，点选从挂载根
 * 起步给出来的路径天然可访问）。从 /api/libraries/browse 逐层下钻，多选勾选
 * （对应表单「每行一个路径」），确定后回填。
 *
 * leafHint（目录直接含图/压缩包 = 扫描器语义下「本身就是一部漫画」）用来在
 * 行尾给一个「单部」小标：用户点进「海贼王」看到章节、或在父层看到这个标，
 * 就知道选哪层是「整片收录」、哪层是「只收这一部」。
 */
export default function DirPicker({
  open,
  initialPaths,
  onClose,
  onConfirm,
}: {
  open: boolean;
  /** 编辑库时把已有路径预勾上（这些路径可能不在当前浏览层，勾选状态独立维护） */
  initialPaths: string[];
  onClose: () => void;
  /** 返回勾选的路径（顺序 = 勾选顺序） */
  onConfirm: (paths: string[]) => void;
}) {
  type Level = Awaited<ReturnType<typeof api.browseLibraries>>;
  const [levels, setLevels] = useState<Level[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);

  // 每次打开都回到根并按 initialPaths 预勾（关开之间不保留旧浏览位置，
  // 弹层复用同一实例，不重置会把上次的深层目录带到下一个库的编辑里）
  useEffect(() => {
    if (!open) return;
    setChecked([...initialPaths]);
    setLevels([]);
    setError(null);
    setLoading(true);
    api
      .browseLibraries()
      .then((r) => setLevels([r]))
      .catch((e) => setError(e instanceof Error ? e.message : '无法读取目录'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const drill = (path: string) => {
    setLoading(true);
    setError(null);
    api
      .browseLibraries(path)
      .then((r) => setLevels((s) => [...s, r]))
      .catch((e) => setError(e instanceof Error ? e.message : '无法读取目录'))
      .finally(() => setLoading(false));
  };

  const toggle = (path: string) =>
    setChecked((s) => (s.includes(path) ? s.filter((p) => p !== path) : [...s, path]));

  const cur = levels[levels.length - 1];
  /** 面包屑段：从根往下（levels[0].path 是根本身） */
  const crumbs = levels.map((l, i) => ({ name: i === 0 ? '漫画根目录' : l.path.split('/').pop() || l.path, path: l.path }));

  return (
    <Sheet open={open} title="选择目录" onClose={onClose}>
      <div className="flex flex-col gap-3 p-4">
        {/* 面包屑：点任意一级回跳（裁掉其上的层级） */}
        <div className="flex flex-wrap items-center gap-0.5 text-xs text-ink-500">
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex items-center gap-0.5">
              {i > 0 && <ChevronRight size={12} className="text-ink-600" />}
              <button
                className={`rounded px-1 py-0.5 ${i === crumbs.length - 1 ? 'font-medium text-ink-200' : 'hover:text-accent'}`}
                onClick={() => i < crumbs.length - 1 && setLevels((s) => s.slice(0, i + 1))}
              >
                {c.name}
              </button>
            </span>
          ))}
        </div>

        {loading && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink-500">
            <Loader2 size={16} className="animate-spin" /> 读取中…
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-300">
            ⚠️ {error}。若为 fnOS，请在「设置 → 应用 → 肥牛漫画 → 文件夹访问权限」勾选允许访问，然后重试。
          </div>
        )}

        {!loading && cur && (
          <div className="flex max-h-[50vh] min-h-[160px] flex-col gap-0.5 overflow-y-auto rounded-xl bg-ink-900 p-1.5">
            {cur.items.length === 0 && (
              <p className="py-8 text-center text-xs text-ink-500">此层没有子目录了</p>
            )}
            {cur.items.map((it) => {
              const isChecked = checked.includes(it.path);
              return (
                <div key={it.path} className="flex items-center gap-1">
                  {/* 下钻：整行点击进目录 */}
                  <button
                    className="press flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-ink-100 hover:bg-ink-800"
                    onClick={() => drill(it.path)}
                  >
                    <Folder size={16} className="shrink-0 text-accent" />
                    <span className="truncate">{it.name}</span>
                    {it.leafHint && (
                      <span
                        className="ml-auto shrink-0 rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-400"
                        title="此目录直接包含图片/压缩包，本身就是一部漫画。勾选它只会收录这一部，勾上层才能整片收录"
                      >
                        单部
                      </span>
                    )}
                  </button>
                  {/* 勾选：独立热区，避免和下钻抢点击 */}
                  <button
                    className={`press touch-hit shrink-0 rounded-lg p-2 ${isChecked ? 'text-accent' : 'text-ink-600 hover:text-ink-300'}`}
                    title={isChecked ? '取消勾选' : '勾选为库路径'}
                    onClick={() => toggle(it.path)}
                  >
                    {isChecked ? <FolderOpen size={17} /> : <Folder size={17} />}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] leading-relaxed text-ink-500">
            已选 {checked.length} 个目录
            {checked.length > 0 && (
              <span className="ml-1 block truncate font-mono text-ink-400" title={checked.join('\n')}>
                {checked[checked.length - 1].split('/').pop()}
              </span>
            )}
          </p>
          <button
            className="btn-primary shrink-0"
            disabled={checked.length === 0}
            onClick={() => onConfirm(checked)}
          >
            确定
          </button>
        </div>
      </div>
    </Sheet>
  );
}
