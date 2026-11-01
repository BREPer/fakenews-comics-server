import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, CloudUpload, FileWarning, FolderArchive, X } from 'lucide-react';
import { Sheet } from '@/components/ui';
import type { Library } from '@/types';
import { uploadToLibrary, type UploadResult } from '@/api/client';

interface UploadItem {
  file: File;
  relPath: string;
}

interface UploadSheetProps {
  open: boolean;
  library: Library | null;
  onClose: () => void;
  /** 上传成功后回调（用于刷新列表 / 轮询扫描） */
  onUploaded: () => void;
}

/** 章节型：整部漫画压缩包（服务端自动建文件夹并解压） */
const CHAPTER_EXTS = ['cbz', 'zip', 'tar', 'cbt', 'rar', 'cbr'];
/** 单篇型：压缩包 + epub / pdf（原样上传，不解压） */
const SINGLE_EXTS = ['cbz', 'zip', 'tar', 'cbt', 'rar', 'cbr', '7z', 'cb7', 'epub', 'pdf'];

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** 浏览器给的 File.name 理论上就是基名，这里再剥一次目录，防止非常规输入框带回路径 */
function baseName(name: string): string {
  const parts = name.split(/[\\/]/);
  return parts[parts.length - 1] || name;
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 上传漫画到库（按库类型分流，2026-10-23 起）：
 *  - 章节型：「上传整部漫画」——仅压缩包，服务端创建以压缩包名称命名的文件夹并解压进去；
 *  - 单篇型：「上传漫画」——压缩包 / epub / pdf 原样上传，不解压。
 * 写入后由服务端触发扫描入库。
 */
export default function UploadSheet({ open, library, onClose, onUploaded }: UploadSheetProps) {
  const isChapter = library?.type === 'chapter';
  const exts = isChapter ? CHAPTER_EXTS : SINGLE_EXTS;
  const accept = exts.map((e) => `.${e}`).join(',');

  const [items, setItems] = useState<UploadItem[]>([]);
  const [rejected, setRejected] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const totalBytes = useMemo(() => items.reduce((n, it) => n + it.file.size, 0), [items]);

  const reset = () => {
    setItems([]);
    setRejected([]);
    setResult(null);
    setError(null);
    setProgress(0);
  };

  const handleClose = () => {
    // 上传中也能关：先中止请求再退出。以前关不掉，弱网时用户只能刷新整页。
    if (uploading) {
      abortRef.current?.abort();
      setUploading(false);
    }
    reset();
    onClose();
  };

  // 组件被卸载（切路由等）时同样中止，别让请求在后台挂着
  useEffect(() => () => abortRef.current?.abort(), []);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const next: UploadItem[] = [];
    const bad: string[] = [];
    for (const f of Array.from(files)) {
      const name = baseName(f.name);
      if (!exts.includes(extOf(name))) {
        bad.push(f.name);
        continue
      }
      next.push({ file: f, relPath: name });
    }
    if (bad.length) setRejected((prev) => [...new Set([...prev, ...bad])]);
    setItems((prev) => {
      // 按文件名去重
      const seen = new Set(prev.map((p) => p.relPath));
      return [...prev, ...next.filter((n) => !seen.has(n.relPath))];
    });
  };

  const removeItem = (i: number) => setItems((prev) => prev.filter((_, idx) => idx !== i));

  const startUpload = async () => {
    if (!library || items.length === 0 || uploading) return;
    setUploading(true);
    setError(null);
    setResult(null);
    setProgress(0);
    const form = new FormData();
    for (const it of items) form.append('files', it.file, it.relPath);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await uploadToLibrary(library.id, form, (loaded, total) => {
        setProgress(total > 0 ? Math.min(1, loaded / total) : 0);
      }, ac.signal);
      setResult(res);
      setProgress(1);
      onUploaded();
    } catch (e) {
      // 用户主动关闭导致的取消不是错误；超时/网络失败仍要显示原因
      if (!ac.signal.aborted) setError(e instanceof Error ? e.message : '上传失败');
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      setUploading(false);
    }
  };

  const folders = result?.folders ?? [];

  return (
    <Sheet open={open} title={`上传到「${library?.name ?? ''}」`} onClose={handleClose}>
      <div className="flex flex-col gap-4 p-4">
        {!result ? (
          <>
            <p className="text-xs leading-relaxed text-ink-500">
              {isChapter ? (
                <>
                  章节型漫画库请<span className="text-ink-300">上传整部漫画</span>：仅支持压缩包
                  （.cbz/.zip/.tar/.cbt/.rar/.cbr）。上传后会自动创建以压缩包名称命名的文件夹，
                  并把漫画解压到该文件夹中，一部漫画一个包。
                </>
              ) : (
                <>
                  单篇型漫画库支持压缩包与 epub / pdf，文件按原样上传、不会解压
                  （7z/cb7 可上传但暂不支持阅读）。
                </>
              )}
            </p>

            {/* 选择入口 */}
            <button
              className="btn-ghost ring-1 ring-ink-800 py-3 press"
              onClick={() => fileInput.current?.click()}
              disabled={uploading}
            >
              {isChapter ? <FolderArchive size={16} /> : <CloudUpload size={16} />}
              {isChapter ? '上传整部漫画' : '上传漫画'}
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={accept}
              className="hidden"
              onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
            />

            {/* 拖拽区：拖文件进来等同于「选择文件」 */}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
              }}
              className={`flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed py-6 text-center transition-colors ${
                dragOver ? 'border-brand-500 bg-brand-500/10' : 'border-ink-700'
              }`}
            >
              {isChapter ? <FolderArchive size={22} className="text-ink-500" /> : <CloudUpload size={22} className="text-ink-500" />}
              <p className="text-xs text-ink-500">
                {isChapter ? '把整部漫画压缩包拖到这里' : '把漫画文件拖到这里'}
              </p>
              <p className="text-[10px] text-ink-600">支持 {accept.replace(/,/g, ' ')}</p>
            </div>

            {/* 已选文件 */}
            {items.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between text-xs text-ink-400">
                  <span>已选 {items.length} 个文件</span>
                  <span>{humanSize(totalBytes)}</span>
                </div>
                <div className="max-h-44 space-y-1 overflow-y-auto overscroll-contain rounded-lg bg-ink-900 p-2">
                  {items.map((it, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 px-1 text-[11px]">
                      <span className="truncate text-ink-300" title={it.relPath}>
                        {it.relPath}
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-ink-500">
                        {humanSize(it.file.size)}
                        {!uploading && (
                          <button className="text-ink-500 hover:text-red-400" onClick={() => removeItem(i)}>
                            <X size={13} />
                          </button>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {rejected.length > 0 && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-300">
                已忽略 {rejected.length} 个不支持的文件：
                <span className="ml-1 font-mono">{rejected.slice(0, 5).join('、')}{rejected.length > 5 ? ' 等' : ''}</span>
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {error}
              </div>
            )}

            <button
              className="btn-primary mt-1"
              disabled={!uploading && items.length === 0}
              onClick={() => (uploading ? handleClose() : void startUpload())}
            >
              {uploading
                ? '取消上传'
                : isChapter
                  ? `上传并解压 ${items.length} 个压缩包`
                  : `上传 ${items.length} 个文件`}
            </button>

            {uploading && (
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
                <div
                  className="h-full origin-left rounded-full bg-brand-500 transition-transform duration-150"
                  style={{ transform: `scaleX(${progress})` }}
                />
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <CheckCircle2 size={36} className="text-green-400" />
            <p className="text-sm font-medium text-ink-200">
              {isChapter ? '上传并解压完成' : '上传完成'}
            </p>
            <p className="text-xs text-ink-500">
              {isChapter ? (
                <>
                  已解压 {result.written} 个文件（{humanSize(result.bytes)}），
                  创建 {folders.length} 个漫画文件夹，正在扫描入库…
                </>
              ) : (
                <>
                  已写入 {result.written} 个文件（{humanSize(result.bytes)}），正在扫描入库…
                </>
              )}
            </p>
            {folders.length > 0 && (
              <div className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-left">
                <div className="mb-1 flex items-center gap-1 text-[11px] text-ink-400">
                  <FolderArchive size={13} /> 新建文件夹：
                </div>
                <div className="max-h-24 space-y-0.5 overflow-y-auto font-mono text-[11px] text-ink-300">
                  {folders.map((f) => (
                    <div key={f} className="truncate" title={f}>{f}/</div>
                  ))}
                </div>
              </div>
            )}
            {result.skipped.length > 0 && (
              <div className="w-full rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-left text-[11px] text-amber-300">
                <div className="mb-1 flex items-center gap-1">
                  <FileWarning size={13} /> 跳过 {result.skipped.length} 个不支持的文件：
                </div>
                <div className="max-h-24 overflow-y-auto font-mono">
                  {result.skipped.slice(0, 20).map((s) => (
                    <div key={s} className="truncate" title={s}>{s}</div>
                  ))}
                </div>
              </div>
            )}
            <button className="btn-primary mt-1 w-40" onClick={handleClose}>
              完成
            </button>
          </div>
        )}
      </div>
    </Sheet>
  );
}
