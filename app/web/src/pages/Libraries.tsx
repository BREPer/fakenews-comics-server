import { useState } from 'react';
import { FolderOpen, FolderPlus, RefreshCw, Trash2, Upload } from 'lucide-react';
import { useLibraries, useTriggerScan, useScanStatus } from '@/api/queries';
import { api } from '@/api/client';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/api/queries';
import { ConfirmDialog, EmptyState, ErrorState, Loading, Sheet } from '@/components/ui';
import { toast } from '@/components/ui/toast';
import UploadSheet from '@/components/library/UploadSheet';
import DirPicker from '@/components/library/DirPicker';
import type { Library, LibraryType } from '@/types';

/**
 * 漫画库管理（方案 §4 P7）：库卡片 + 新建/编辑/删除 + 立即扫描 + 扫描状态。
 */
export default function LibrariesPage() {
  const { data, isLoading, isError, error, refetch } = useLibraries();
  const scan = useTriggerScan();
  const { data: scanStatus } = useScanStatus(true);
  const qc = useQueryClient();
  const [editing, setEditing] = useState<{ id?: string; name: string; type: LibraryType; paths: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);
  const [uploadLib, setUploadLib] = useState<Library | null>(null);
  // 路径点选器开着时编辑表单一定也开着（入口在表单里），确定后回填 textarea
  const [picking, setPicking] = useState(false);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: queryKeys.libraries() });
    qc.invalidateQueries({ queryKey: ['comics'] });
    // 新建/上传后后端会立刻开扫。不刷新 scan 状态的话，页内那份「没在扫」的旧结果
    // 不会轮询（useScanStatus 只在 running 时才 800ms 轮询），进度条永远不出现。
    qc.invalidateQueries({ queryKey: queryKeys.scan() });
  };

  const saveLibrary = async () => {
    if (!editing) return;
    const paths = editing.paths.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!editing.name.trim() || paths.length === 0) return;
    const isNew = !editing.id;
    try {
      if (editing.id) {
        await api.updateLibrary(editing.id, { name: editing.name.trim(), type: editing.type, paths });
      } else {
        await api.createLibrary({ name: editing.name.trim(), type: editing.type, paths });
      }
    } catch (e) {
      // 以前这里没有 try/catch：失败会变成未处理的 promise rejection，
      // 面板原地不动、一个字都不提示，用户只会反复点保存
      toast.error(`${isNew ? '创建' : '保存'}失败：${e instanceof Error ? e.message : '未知错误'}`);
      return;
    }
    setEditing(null);
    refresh();
    toast.success(isNew ? '漫画库已创建，正在扫描' : '漫画库已更新');
  };

  const confirmDelete = async () => {
    if (!deleting || delBusy) return;
    setDelBusy(true);
    setDelError(null);
    try {
      await api.deleteLibrary(deleting);
      const name = data?.items.find((l) => l.id === deleting)?.name;
      setDeleting(null);
      refresh();
      // 删除不可撤销，一定要留下明确回执（尤其是误删时要让人知道删的是哪个）
      toast.success(name ? `已删除漫画库「${name}」（不删磁盘文件）` : '漫画库已删除（不删磁盘文件）');
    } catch (e) {
      // 失败必须说清原因：以前这里直接 await，出错时弹窗保持原样，用户只看到「点了没反应」
      setDelError(e instanceof Error ? e.message : '删除失败，请重试');
    } finally {
      setDelBusy(false);
    }
  };

  if (isLoading) return <Loading label="加载漫画库…" />;
  if (isError) {
    return (
      <ErrorState
        title="漫画库加载失败"
        error={error}
        hint="服务可能正在忙，稍后再试"
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      {/*
        标题行在超窄屏（≤230px 左右）会「标题折成两行、按钮挤成一列」：
        h1 是可收缩的 flex 子项，宽度不够就先把自己折行，右侧按钮组又抢着不放
        —— 结果「漫画库」竖成两条、「扫描/新建」被压扁。改成：标题不折行
        （whitespace-nowrap），按钮组 shrink-0 + ml-auto，整行允许换行（flex-wrap）。
        宽度不够时按钮整组落到第二行并靠右，标题始终是一整行 —— 190px 下也是完整的。
      */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <h1 className="whitespace-nowrap text-lg font-bold">漫画库</h1>
        <div className="ml-auto flex shrink-0 gap-2">
          <button
            className="btn-ghost ring-1 ring-ink-800"
            disabled={scan.isPending}
            onClick={() =>
              scan.mutate(undefined, {
                onSuccess: (r) =>
                  r.started
                    ? toast.success('已开始扫描全部漫画库')
                    : toast.info('已有扫描在进行中，请稍候'),
                onError: (e) => toast.error(`扫描启动失败：${e instanceof Error ? e.message : '未知错误'}`),
              })
            }
          >
            <RefreshCw size={15} className={scan.isPending ? 'animate-spin' : ''} /> 扫描
            {scanStatus?.running && (
              <span className="text-[11px] text-ink-500">
                {scanStatus.done}/{scanStatus.total}
              </span>
            )}
          </button>
          <button
            className="btn-primary"
            onClick={() => setEditing({ name: '', type: 'chapter', paths: '' })}
          >
            <FolderPlus size={15} /> 新建
          </button>
        </div>
      </div>

      {data && data.items.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {data.items.map((lib) => (
            /*
             * min-w-0 + overflow-hidden：没有它，卡片里的路径行（`truncate` =
             * white-space:nowrap）的 min-content 宽度会一路顶到 grid item 上 ——
             * grid/flex 子项的自动最小尺寸是 min-content，于是整张卡被撑到路径那么宽
             * （实测 519px），页面最小宽度变成 531px。手机上浏览器随之 shrink-to-fit
             * 把整页缩到 ~68% 显示，卡片右上角的「编辑 / 上传 / 删除」被推到屏幕外
             * （x=404/448/483，360 宽屏根本看不见）。
             * min-w-0 解除自动最小尺寸、overflow-hidden 让 truncate 真正生效。
             */
            <div key={lib.id} className="card flex min-w-0 flex-col gap-2 overflow-hidden p-4">
              <div className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
                {/*
                  标题这一侧必须 min-w-0 + line-clamp：库名是用户输入的任意长度，
                  flex 子项的自动最小尺寸是 min-content，长名字会把右侧按钮组挤扁
                  —— 280px 屏上「编辑」曾被压成竖排的「编 / 辑」两个字，三颗按钮错位。
                  按钮组反过来要 shrink-0 + nowrap，宁可标题省略，也不能让按钮变形。
                  两行封顶：中文库名截一半就认不出，两行 + 省略号更够用。

                  但「宁可标题省略」在极窄屏会走过头：190~240px 时按钮组固定 110px，
                  留给标题只剩十几像素，库名被压成竖排的一两个字、类型标签直接竖着写。
                  所以给标题一侧一个 5rem 的下限 + 整行 flex-wrap：放不下时按钮组
                  整组换到第二行（ml-auto 靠右），标题至少还有一行完整的位置。
                */}
                <div className="min-w-[5rem] flex-1">
                  <h3 className="line-clamp-2 break-words text-sm font-semibold" title={lib.name}>
                    {lib.name}
                  </h3>
                  <span className="mt-0.5 inline-block whitespace-nowrap rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-400">
                    {lib.type === 'chapter' ? '章节漫画' : '单篇漫画'}
                  </span>
                </div>
                <div className="ml-auto flex shrink-0 gap-1">
                  <button
                    className="btn-ghost touch-hit whitespace-nowrap px-2 py-1 text-xs"
                    onClick={() =>
                      setEditing({ id: lib.id, name: lib.name, type: lib.type, paths: lib.paths.join('\n') })
                    }
                  >
                    编辑
                  </button>
                  {/*
                    图标按钮必须有 aria-label：Android 端同样是图标按钮，用的是
                    contentDescription（等价语义），只有 title 的话读屏念不出按钮用途，
                    两边不齐。编辑是文字按钮，本身有可读文本，不需要。
                  */}
                  <button
                    className="btn-ghost touch-hit p-2 text-ink-500 hover:text-accent"
                    aria-label={lib.type === 'chapter' ? '上传整部漫画' : '上传漫画'}
                    title={lib.type === 'chapter' ? '上传整部漫画' : '上传漫画'}
                    onClick={() => setUploadLib(lib)}
                  >
                    <Upload size={15} />
                  </button>
                  <button
                    className="btn-ghost touch-hit p-2 text-ink-500 hover:text-red-400"
                    aria-label="删除漫画库"
                    title="删除漫画库"
                    onClick={() => {
                      setDelError(null);
                      setDeleting(lib.id);
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
              {/* 同上：路径可长到几百像素，这一层也要能收缩，否则撑破卡片 */}
              <div className="min-w-0 text-[11px] leading-relaxed text-ink-500">
                {lib.paths.map((p) => (
                  <div key={p} className="truncate" title={p}>
                    📁 {p}
                  </div>
                ))}
              </div>
              {lib.inaccessiblePaths && lib.inaccessiblePaths.length > 0 && (
                <div className="mt-1 min-w-0 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber-300">
                  ⚠️ 以下目录无法访问，书架会保持为空：
                  <div className="mt-1 min-w-0 font-mono text-amber-200/90">
                    {lib.inaccessiblePaths.map((p) => (
                      <div key={p} className="truncate" title={p}>
                        {p}
                      </div>
                    ))}
                  </div>
                  请到 fnOS「设置 → 应用 → 肥牛漫画 → 文件夹访问权限」中把该目录授权给本应用（只读即可）；
                  若为文件管理里的共享文件夹，还需在其属性勾选「允许 Docker 容器访问」。
                </div>
              )}
              <p className="text-[11px] text-ink-500">
                收录 {lib.comicCount ?? 0} 部漫画
              </p>
              <button
                className="btn-ghost mt-1 w-fit text-xs"
                disabled={scan.isPending}
                onClick={() =>
                  scan.mutate(lib.id, {
                    onSuccess: (r) =>
                      r.started ? toast.success(`已开始扫描「${lib.name}」`) : toast.info('已有扫描在进行中'),
                    onError: (e) => toast.error(`扫描启动失败：${e instanceof Error ? e.message : '未知错误'}`),
                  })
                }
              >
                立即扫描此库
              </button>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          mascot="empty"
          title="还没有漫画库"
          hint="新建一个库并指向 NAS 上的漫画目录（支持多目录）。若该目录在 fnOS「设置 → 应用 → 肥牛漫画 → 文件夹访问权限」中尚未授权，扫描会读不到内容。"
          action={
            <button className="btn-primary mt-2" onClick={() => setEditing({ name: '', type: 'chapter', paths: '' })}>
              新建漫画库
            </button>
          }
        />
      )}

      {/* 新建 / 编辑 */}
      <Sheet open={!!editing} title={editing?.id ? '编辑漫画库' : '新建漫画库'} onClose={() => setEditing(null)}>
        <div className="flex flex-col gap-3 p-4">
          <label className="text-xs text-ink-400">名称</label>
          <input
            className="input"
            value={editing?.name ?? ''}
            onChange={(e) => setEditing((s) => (s ? { ...s, name: e.target.value } : s))}
            placeholder="例如：本机漫画"
          />
          <label className="text-xs text-ink-400">类型</label>
          <div className="flex gap-2">
            {(['chapter', 'single'] as LibraryType[]).map((t) => (
              <button
                key={t}
                className={`press touch-hit ${editing?.type === t ? 'chip-on' : 'chip-off'}`}
                onClick={() => setEditing((s) => (s ? { ...s, type: t } : s))}
              >
                {t === 'chapter' ? '章节漫画' : '单篇漫画'}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between">
            <label className="text-xs text-ink-400">目录路径（每行一个）</label>
            <button className="btn-ghost touch-hit px-2 py-1 text-xs" onClick={() => setPicking(true)}>
              <FolderOpen size={13} /> 浏览选择
            </button>
          </div>
          <textarea
            className="input min-h-[120px] resize-none font-mono text-xs"
            value={editing?.paths ?? ''}
            onChange={(e) => setEditing((s) => (s ? { ...s, paths: e.target.value } : s))}
            placeholder="点右侧「浏览选择」从根目录勾选；或手输 /comics/子目录"
          />
          <p className="text-[11px] leading-relaxed text-ink-500">
            推荐<strong className="text-ink-300">点「浏览选择」</strong>从挂载根逐层勾选，给出来的路径必然有效。
            手输的话填<strong className="text-ink-300">容器内</strong>路径：安装时你填写的「漫画根目录」（宿主机路径）已被只读挂载到容器内的
            <code className="mx-0.5 rounded bg-ink-800 px-1">/comics</code>。默认库的
            <code className="mx-0.5 rounded bg-ink-800 px-1">/comics</code>即整盘漫画；只收录某个子目录请填
            <code className="mx-0.5 rounded bg-ink-800 px-1">/comics/子目录</code>。
            不要填宿主机路径（如 <code className="mx-0.5 rounded bg-ink-800 px-1">/vol1/...</code>），容器内看不到，会导致书架为空。
          </p>
          <p className="text-[11px] leading-relaxed text-ink-500">
            识别规则与支持格式：
          </p>
          <ul className="list-inside list-disc space-y-1 text-[11px] leading-relaxed text-ink-500">
            <li>
              支持：图片文件夹、<code className="rounded bg-ink-800 px-1">.cbz/.zip</code>、
              <code className="rounded bg-ink-800 px-1">.tar/.cbt</code>、
              <code className="rounded bg-ink-800 px-1">.rar/.cbr</code>、
              <code className="rounded bg-ink-800 px-1">.epub</code>、<code className="rounded bg-ink-800 px-1">.pdf</code>
              （PDF 需为扫描图型；文字型 PDF 没有可提取的图，会被当成 0 页）
            </li>
            <li>
              暂不支持：7Z/CB7、加密压缩包。RAR 支持 RAR3/RAR5（含固实归档，但固实包翻到后面会明显变慢，
              这是格式本身的代价）
            </li>
            <li>
              隐藏目录（点号开头）与样张文件（<code className="rounded bg-ink-800 px-1">sample/preview</code> 等）会被忽略
            </li>
            <li>
              <strong className="text-ink-300">章节型</strong>：每个子文件夹是一部漫画；其顶层散图成一章、
              再下一层子目录各成一章，压缩包按「包内一级目录」分章
            </li>
            <li>
              <strong className="text-ink-300">单篇型</strong>：每个含图文件夹/压缩包各自成书
            </li>
            <li>
              <strong className="text-ink-300">章节型上传</strong>：仅支持压缩包（.cbz/.zip/.tar/.cbt/.rar/.cbr），
              上传后自动创建以压缩包名称命名的文件夹并解压入库（一部漫画一个包）
            </li>
            <li>
              <strong className="text-ink-300">单篇型上传</strong>：支持压缩包 / epub / pdf，原样上传、不解压
            </li>
          </ul>
          <p className="text-[11px] leading-relaxed text-ink-500">保存后自动触发扫描。</p>
          <button className="btn-primary mt-1" onClick={saveLibrary}>
            保存并扫描
          </button>
        </div>
      </Sheet>

      {/* 路径点选器（DirPicker 自带 Sheet，叠在编辑表单之上；确定时回填 textarea） */}
      <DirPicker
        open={picking}
        initialPaths={(editing?.paths ?? '').split('\n').map((s) => s.trim()).filter(Boolean)}
        onClose={() => setPicking(false)}
        onConfirm={(paths) => {
          setEditing((s) => (s ? { ...s, paths: paths.join('\n') } : s));
          setPicking(false);
        }}
      />

      <ConfirmDialog
        open={!!deleting}
        title="删除漫画库？"
        message="库内漫画条目及其阅读进度、分章已读、收藏都会被清除（磁盘上的漫画文件不受影响）。"
        confirmText="删除"
        danger
        busy={delBusy}
        error={delError}
        onConfirm={confirmDelete}
        onCancel={() => {
          setDeleting(null);
          setDelError(null);
        }}
      />

      <UploadSheet
        open={!!uploadLib}
        library={uploadLib}
        onClose={() => setUploadLib(null)}
        onUploaded={refresh}
      />
    </div>
  );
}
