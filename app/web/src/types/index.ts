/**
 * 前后端共享契约（与 server 输出严格对应，字段名经 API 实测校准）。
 */

export type ComicFormat = 'cbz' | 'cbr' | 'cb7' | 'zip' | 'folder' | 'pdf' | 'rar' | '7z' | 'tar' | 'epub' | 'mobi' | string;
export type LibraryType = 'chapter' | 'single';
export type ReaderMode = 'webtoon' | 'single' | 'double' | 'split';
export type ReadDir = 'ltr' | 'rtl';
export type FitMode = 'width' | 'height' | 'contain' | 'original';
/** 画质档位：流畅（720 宽）/ 标准（1080 宽）/ 原图（原字节） */
export type Quality = 'smooth' | 'standard' | 'original';
export type ReadStatus = 'unread' | 'reading' | 'finished';

export interface ReadingProgress {
  comicId: string;
  chapterId: string;
  chapterIndex: number;
  pageIndex: number;
  pageCount: number;
  percent: number;
  updatedAt: number;
}

export interface Comic {
  id: string;
  libraryId: string;
  title: string;
  rawTitle: string;
  author?: string;
  description?: string;
  format: ComicFormat;
  sizeBytes: number;
  chapterCount: number;
  pageCount: number;
  tags: string[];
  fileModifiedAt: number;
  addedAt: number;
  progress?: ReadingProgress;
  isFavorite: boolean;
  lastReadAt?: number;
  readStatus: ReadStatus;
}

export interface Chapter {
  id: string;
  index: number;
  title: string;
  pageCount: number;
  sizeBytes: number;
  /** 服务端内部字段（前端不使用） */
  path?: string;
}

export interface ComicDetail extends Comic {
  chapters: Chapter[];
}

export interface Library {
  id: string;
  name: string;
  type: LibraryType;
  paths: string[];
  sort: number;
  createdAt: number;
  /** 库内漫画数（服务端聚合） */
  comicCount: number;
  /** 不可访问的路径（卷未挂载 / fnOS 未授权文件夹访问权限），用于提示用户去授权 */
  inaccessiblePaths?: string[];
}

export interface Facet {
  value: string;
  count: number;
}

export interface Facets {
  formats: Facet[];
  tags: Facet[];
}

export interface PageMeta {
  index: number;
  name: string;
  size: number;
}

export interface HistoryItem extends Comic {
  chapterId: string;
  chapterIndex: number;
  pageIndex: number;
  progressPageCount: number;
}

/**
 * 设备偏好（DevicePrefs）：**按设备存**，localStorage 是唯一真源。
 *
 * 为什么不是服务端全局设置：这 10 项的"正确值"由屏幕比例、内存、触控、网络决定，
 * 与用户账号无关。服务端只有一行全局值，任何设备的修改都会覆盖其它设备
 * （论证与实测见 docs/2026-10-24-偏好归属论证.md）。
 *
 * 归属例外：`readDir` 本质是"这本书的属性"（日漫右开/欧美左开），
 * 目前仍跟随设备，后续可迁到「每部漫画/每个库」。
 */
export interface DevicePrefs {
  readerMode: ReaderMode;
  readDir: ReadDir;
  fitMode: FitMode;
  quality: Quality;
  preloadCount: number;
  /** pan=平移（整页横向滑入滑出）｜slide=轻移（旧行为，32px 位移）｜fade｜none */
  pageAnimation: PageAnimation;
  /** 双指缩放（默认关闭：缩放与单击翻页/滑动翻页在手势上会互相干扰） */
  pinchZoom: boolean;
  /** 保持屏幕常亮（Screen Wake Lock） */
  keepScreenOn: boolean;
  /** 外观：light / dark / system（system 跟随系统明暗） */
  theme: Theme;
  /**
   * 高亮色：amber=琥珀橙（默认）｜sora=空色｜bean=豆沙绿。
   * 切换的是 <html data-accent>，颜色映射在 index.css；
   * 历史值 orange/blue/gray/prussian 由 theme.ts 的 normalizeAccent 迁移。
   */
  accent: Accent;
}

export type Theme = 'light' | 'dark' | 'system';
export type Accent = 'amber' | 'sora' | 'bean';
export type PageAnimation = 'pan' | 'slide' | 'fade' | 'none';

/**
 * 服务端设置（L1）：只有**服务端会执行**的项留在这里。
 *
 * autoScanIntervalHours → scanner/scheduler.go 的定时器
 * thumbnailCacheMB      → images/cache.go 的缓存上限
 *
 * 认证凭据与扫描记账也在 settings 表里，但它们属于内部键，从不下发给前端。
 */
export interface Settings {
  autoScanIntervalHours: number;
  thumbnailCacheMB: number;
  /**
   * 备注（服务端 settingDefaults 保留键，默认空串）。
   * 前端目前不展示、不写入，但 GET /api/settings 会回传，故声明为可选以免契约检查报漂移。
   */
  note?: string;
}

/** 缓存用量（GET /api/cache/stats） */
export interface CacheStats {
  totalBytes: number;
  files: number;
  limitBytes: number;
  thumbsBytes: number;
  coversBytes: number;
  customCoversBytes: number;
}

/** 阅读数据备份（GET /api/backup/export） */
export interface BackupData {
  version: number;
  exportedAt: number;
  progress: Array<{
    comicId: string; chapterId: string; chapterIndex: number;
    pageIndex: number; pageCount: number; percent: number; updatedAt: number;
  }>;
  favorites: Array<{ comicId: string; createdAt: number }>;
  settings: Record<string, unknown>;
  /**
   * 本机偏好快照（导出时由前端附加，导入时前端自己消费后剥离）。
   * 服务端不认识这个字段，所以它不会进 settings 表；跨设备迁移靠它。
   */
  devicePrefs?: Partial<DevicePrefs>;
}

/** 服务端设置（L1）缺省值 */
export const SETTINGS_DEFAULTS: Settings = {
  autoScanIntervalHours: 0,
  thumbnailCacheMB: 2048,
};

/**
 * 设备偏好缺省值。theme 取 light：与 index.html 首帧脚本、启动壳一致，
 * 否则新设备会先按浅色铺开、再被 JS 翻成深色（实测两次翻转）。
 */
export const DEVICE_PREFS_DEFAULTS: DevicePrefs = {
  readerMode: 'single',
  readDir: 'ltr',
  fitMode: 'contain',
  quality: 'standard',
  preloadCount: 3,
  pageAnimation: 'pan',
  pinchZoom: false,
  keepScreenOn: false,
  theme: 'light',
  accent: 'amber',
};

export interface ScanStatus {
  running: boolean;
  total: number;
  done: number;
  current: string;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

/** 列表查询参数（URL 可恢复） */
export interface ComicQuery {
  libraryId?: string;
  q?: string;
  status?: ReadStatus;
  format?: string;
  tag?: string;
  sort?: 'addedAt' | 'title' | 'lastReadAt' | 'progress';
  order?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** 「设置 → 关于」的运行信息（GET /api/about） */
export interface AboutInfo {
  name: string;
  version: string;
  builtAt: number | null;
  node: string;
  platform: string;
  uptimeSec: number;
  port: number;
  comicRoot: string;
  dataDir: string;
  dbFile: string;
  dbBytes: number;
  dataWritable: boolean;
  // 说明：cacheDir / logLevel / thumbCacheMB 三个字段已随 Go 后端下线删除——
  // 服务端不再返回、前端也从未读取，留着只是迁移时的手抄残留（由 tools/contract_check.mjs 查出）。
}

/** 登录门禁状态（GET /api/auth/status） */
export interface AuthState {
  /** 是否开启了登录保护 */
  enabled: boolean;
  /** 当前请求是否已登录 */
  authenticated: boolean;
  /** 已登录用户名（未登录时缺省） */
  username?: string;
  /** 是否已设置过密码（决定「启用」开关能否直接打开） */
  hasCredential: boolean;
}
