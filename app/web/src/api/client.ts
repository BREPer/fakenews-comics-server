/**
 * API client：统一 code:0 信封解包 + 错误归一化。
 * 开发态经 Vite 代理到 :13800；生产态同容器伺服（见 server index.ts）。
 */

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * 默认请求超时。
 *
 * fetch 本身没有超时：NAS 上如果后端卡住（正在扫描大库、磁盘休眠唤醒、
 * PDF 渲染排队），前端就是无限转圈，用户只能刷新页面。
 * 60 秒足够覆盖正常接口（扫描/备份都是异步立即返回），超时后给明确错误。
 */
const DEFAULT_TIMEOUT_MS = 60_000;

/** AbortSignal.timeout 在部分老 WebView 上没有：没有就不加超时，保持原行为 */
function timeoutSignal(ms: number): AbortSignal | undefined {
  const holder = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
  return typeof holder.timeout === 'function' ? holder.timeout(ms) : undefined;
}

/** 401 广播节流：一屏可能同时有 6 张图 + 详情一起 401，别弹 6 次 */
let lastUnauthorizedAt = 0;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // 只有真的带 body 时才声明 content-type: application/json。
  // DELETE（删除库/取消收藏/删阅读记录）本身没有 body，浏览器与 fnOS 内置 WebView
  // 仍会补上 Content-Length: 0，服务端会以 400 FST_ERR_CTP_EMPTY_JSON_BODY 拒绝，
  // 表现为「点了删除毫无反应」。
  const hasBody = init?.body !== undefined && init?.body !== null;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      signal: init?.signal ?? timeoutSignal(DEFAULT_TIMEOUT_MS),
      headers: hasBody
        ? { 'content-type': 'application/json', ...(init?.headers as Record<string, string> | undefined) }
        : init?.headers,
    });
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ApiError(0, '请求超时：服务可能正在忙（扫描/转码），稍后重试');
    }
    // 断网 / 服务未启动：给出比 "Failed to fetch" 更有用的提示
    throw new ApiError(0, '无法连接服务，请确认 NAS 上的应用正在运行');
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(res.status, `响应解析失败 (${res.status})`);
  }
  const env = body as { code?: number; data?: T; message?: string };
  if (!res.ok || (env.code !== undefined && env.code !== 0)) {
    // 401 = 登录态失效（会话过期 / 服务端被关掉了门禁再打开）。
    // 广播出去让路由守卫统一跳登录页，而不是每个页面各写一遍。
    if (res.status === 401 && typeof window !== 'undefined') {
      const now = Date.now();
      if (now - lastUnauthorizedAt > 1000) {
        lastUnauthorizedAt = now;
        window.dispatchEvent(new CustomEvent('fakenews:unauthorized'));
      }
    }
    throw new ApiError(res.status, env.message ?? `请求失败 (${res.status})`);
  }
  return env.data as T;
}

function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const api = {
  // ---- 登录 ----
  authStatus: () => request<import('../types').AuthState>('/auth/status'),
  login: (username: string, password: string) =>
    request<{ ok: true; username: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),
  setCredentials: (username: string, password: string) =>
    request<{ ok: true }>('/auth/credentials', {
      method: 'PUT',
      body: JSON.stringify({ username, password }),
    }),
  setAuthEnabled: (enabled: boolean) =>
    request<{ enabled: boolean }>('/auth/enabled', { method: 'PUT', body: JSON.stringify({ enabled }) }),

  // ---- 漫画 ----
  listComics: (q: Record<string, unknown>) =>
    request<import('../types').Paged<import('../types').Comic>>(`/comics${qs(q)}`),

  comicDetail: (id: string) =>
    request<import('../types').ComicDetail>(`/comics/${encodeURIComponent(id)}`),

  facets: () => request<import('../types').Facets>('/comics/facets'),

  updateComic: (id: string, body: { title?: string; author?: string; description?: string; tags?: string[] }) =>
    request<{ ok: true }>(`/comics/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),

  coverUrl: (id: string, w = 320) => `/api/comics/${encodeURIComponent(id)}/cover?w=${w}`,

  /** 单部重扫（替换文件后局部刷新） */
  rescanComic: (id: string) =>
    request<{ chapterCount: number; pageCount: number; updated: boolean }>(
      `/comics/${encodeURIComponent(id)}/scan`,
      { method: 'POST' },
    ),

  // ---- 章节页 ----
  pages: (comicId: string, chapterId: string) =>
    request<{ pages: import('../types').PageMeta[] }>(
      `/comics/${encodeURIComponent(comicId)}/chapters/${encodeURIComponent(chapterId)}/pages`,
    ),

  /** 单页 URL：standard → webp 缩略图；original → 原图（Range） */
  pageUrl: (comicId: string, chapterId: string, index: number, quality: 'standard' | 'original', w = 800) =>
    `/api/comics/${encodeURIComponent(comicId)}/chapters/${encodeURIComponent(chapterId)}/pages/${index}?quality=${quality}${quality === 'standard' ? `&w=${w}` : ''}`,

  // ---- 进度 ----
  getProgress: (comicIds: string[]) =>
    request<{ items: import('../types').ReadingProgress[] }>(`/progress${qs({ comicIds: comicIds.join(',') })}`),

  /**
   * keepalive：最后一次进度上报常发生在 pagehide / 刷新 / 关标签的瞬间，
   * 普通 fetch 会被浏览器随文档一起取消，那一页就丢了。keepalive 让请求活到响应返回
   * （body 只有几十字节，远低于 64KB 的配额上限）。
   *
   * updatedAt 仅用于「撤销删除阅读记录」：不传则由服务端写当前时间。
   */
  putProgress: (body: {
    comicId: string; chapterId: string; chapterIndex: number;
    pageIndex: number; pageCount: number; percent: number;
    /** 秒级毫秒时间戳；只在恢复历史记录时传，避免记录跳到列表最前面 */
    updatedAt?: number;
  }) => request<{ ok: true; percent: number }>('/progress', { method: 'PUT', body: JSON.stringify(body), keepalive: true }),

  /** 重置某漫画的阅读进度（详情页） */
  resetProgress: (comicId: string) =>
    request<{ ok: true }>(`/progress/${encodeURIComponent(comicId)}/reset`, { method: 'POST' }),

  // ---- 收藏 / 历史 ----
  favorites: () => request<{ items: import('../types').Comic[] }>('/favorites'),
  addFavorite: (comicId: string) =>
    request<{ ok: true }>('/favorites', { method: 'POST', body: JSON.stringify({ comicId }) }),
  removeFavorite: (comicId: string) =>
    request<{ ok: true }>(`/favorites/${encodeURIComponent(comicId)}`, { method: 'DELETE' }),

  /** 阅读记录：offset 支持分页（书架「加载更多」用，避免只显示最新 100 条） */
  history: (limit = 50, offset = 0) =>
    request<{ items: import('../types').HistoryItem[]; total: number }>(`/history${qs({ limit, offset })}`),
  removeHistory: (comicId: string) =>
    request<{ ok: true }>(`/history/${encodeURIComponent(comicId)}`, { method: 'DELETE' }),

  // ---- 库 / 扫描 ----
  libraries: () => request<{ items: import('../types').Library[] }>('/libraries'),
  /** 目录浏览（库路径点选器）：只列子目录，path 缺省=挂载根 */
  browseLibraries: (path?: string) =>
    request<{
      path: string;
      root: string;
      leafHint: boolean;
      items: { name: string; path: string; leafHint: boolean }[];
    }>(`/libraries/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  createLibrary: (body: { name: string; type: import('../types').LibraryType; paths: string[] }) =>
    request<{ id: string }>('/libraries', { method: 'POST', body: JSON.stringify(body) }),
  updateLibrary: (id: string, body: Partial<{ name: string; type: import('../types').LibraryType; paths: string[] }>) =>
    request<{ ok: true }>(`/libraries/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteLibrary: (id: string) =>
    request<{ ok: true }>(`/libraries/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  reorderLibraries: (ids: string[]) =>
    request<{ ok: true }>('/libraries/reorder', { method: 'POST', body: JSON.stringify({ ids }) }),

  scanStatus: () => request<import('../types').ScanStatus>('/scan/status'),
  triggerScan: (libraryId?: string) =>
    request<{ started: boolean; status: import('../types').ScanStatus }>('/scan', {
      method: 'POST',
      body: JSON.stringify(libraryId ? { libraryId } : {}),
    }),

  // ---- 设置 ----
  getSettings: () => request<Partial<import('../types').Settings>>('/settings'),
  putSettings: (body: Partial<import('../types').Settings>) =>
    request<{ ok: true }>('/settings', { method: 'PUT', body: JSON.stringify(body) }),

  /**
   * 旧版「阅读偏好 + 外观」的服务端快照（迁移用，读一次）。
   * 这些键已从 `/api/settings` 移除（偏好改为按设备），这里只为了让升级用户
   * 不丢原有设置；读完之后前端会调用 consumeLegacyPrefs 把它们从服务端删掉。
   */
  legacyPrefs: () => request<Record<string, unknown>>('/settings/legacy-prefs'),

  /** 消费旧版偏好：删除服务端那份，避免第二台设备首次访问时继承 */
  consumeLegacyPrefs: () =>
    request<{ ok: true; removed: number }>('/settings/legacy-prefs/consume', { method: 'POST' }),

  // ---- 缓存管理 ----
  cacheStats: () => request<import('../types').CacheStats>('/cache/stats'),
  clearCache: () => request<{ ok: true; freed: number }>('/cache/clear', { method: 'POST' }),
  evictCache: () =>
    request<{ ok: true; freed: number; deleted: number; stats: import('../types').CacheStats }>('/cache/evict', {
      method: 'POST',
    }),

  // ---- 关于 ----
  about: () => request<import('../types').AboutInfo>('/about'),

  // ---- 阅读数据备份 ----
  exportBackup: () => request<import('../types').BackupData>('/backup/export'),
  importBackup: (data: unknown) =>
    request<{
      ok: true;
      imported: { progress: number; favorites: number; settings: number };
      skipped: number;
    }>('/backup/import', { method: 'POST', body: JSON.stringify(data) }),
};

/**
 * 上传漫画到库（multipart）。用 XMLHttpRequest 而非 fetch：浏览器 fetch 暂不支持上传进度回调，
 * XHR 的 upload.onprogress 才能驱动进度条。
 * 返回写入文件数 / 字节数 / 被跳过的文件名 / 是否已触发扫描。
 * 章节型库额外返回 folders：上传后新建并解压入库的漫画文件夹名。
 */
export interface UploadResult {
  written: number;
  bytes: number;
  skipped: string[];
  libraryId: string;
  scanning: boolean;
  folders?: string[];
}
export function uploadToLibrary(
  libraryId: string,
  formData: FormData,
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ApiError(0, '上传已取消'));
      return;
    }
    const xhr = new XMLHttpRequest();
    // 大文件正常上传可以远超任何总时长，所以不设总超时；改看「多久没有进度」。
    // 没有这条兜底时，弱网卡住只能刷新页面。
    const STALL_MS = 45_000;
    let stall: ReturnType<typeof setTimeout> | undefined;
    let abortedBy: 'user' | 'timeout' | null = null;
    const clearStall = () => {
      if (stall !== undefined) {
        clearTimeout(stall);
        stall = undefined;
      }
    };
    const finishReject = (msg: string) => {
      clearStall();
      signal?.removeEventListener('abort', onAbort);
      reject(new ApiError(0, msg));
    };
    const onAbort = () => {
      abortedBy = 'user';
      xhr.abort();
    };
    const armStall = () => {
      clearStall();
      stall = setTimeout(() => {
        abortedBy = 'timeout';
        xhr.abort();
      }, STALL_MS);
    };
    xhr.open('POST', `/api/libraries/${encodeURIComponent(libraryId)}/upload`);
    xhr.responseType = 'json';
    signal?.addEventListener('abort', onAbort, { once: true });
    xhr.upload.onprogress = (e) => {
      armStall();
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => {
      clearStall();
      signal?.removeEventListener('abort', onAbort);
      const body = (xhr.response ?? null) as { code?: number; data?: UploadResult; message?: string } | null;
      if (xhr.status >= 200 && xhr.status < 300 && (!body || body.code === undefined || body.code === 0)) {
        resolve(body?.data as UploadResult);
      } else {
        reject(new ApiError(xhr.status, body?.message ?? `上传失败 (${xhr.status})`));
      }
    };
    xhr.onerror = () => finishReject('网络错误，上传失败');
    xhr.onabort = () =>
      finishReject(abortedBy === 'timeout' ? '上传超时：45 秒没有收到进度，请检查网络后重试' : '上传已取消');
    xhr.send(formData);
    armStall();
  });
}

