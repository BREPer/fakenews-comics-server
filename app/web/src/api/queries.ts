/**
 * TanStack Query  hooks：服务端状态唯一入口。
 * key 规范：['comics', query] / ['comic', id] / ['facets'] / ['favorites'] / ['history'] / ['settings'] / ['libraries'] / ['scan']
 */
import { useEffect, useRef } from 'react';
import {
  keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient,
} from '@tanstack/react-query';
import { api, ApiError } from './client';
import { clearLocalMirror } from '@/components/reader/useProgressSync';
import {
  SETTINGS_DEFAULTS, type AuthState, type ComicQuery, type ScanStatus, type Settings,
} from '@/types';

export const queryKeys = {
  /**
   * 漫画列表（分页 / 无限滚动）。
   * 前缀必须是 ['comics']：进度写入、收藏切换、元数据编辑、扫描完成都用
   * `invalidateQueries({ queryKey: ['comics'] })` 做前缀失效，换前缀会让这些刷新全部失灵。
   */
  comics: (q: ComicListQuery, pageSize: number) => ['comics', 'list', q, pageSize] as const,
  comic: (id: string) => ['comic', id] as const,
  facets: () => ['facets'] as const,
  favorites: () => ['favorites'] as const,
  history: () => ['history'] as const,
  settings: () => ['settings'] as const,
  libraries: () => ['libraries'] as const,
  scan: () => ['scan'] as const,
  cache: () => ['cache', 'stats'] as const,
  about: () => ['about'] as const,
  auth: () => ['auth', 'status'] as const,
};

/** 登录门禁状态：每次进页面都可能变（会话过期 / 开关切换），staleTime 给短一点 */
export function useAuthStatus() {
  return useQuery({
    queryKey: queryKeys.auth(),
    // 404 = 后端没有登录能力 → 按「未启用」处理，静默降级
    queryFn: async (): Promise<AuthState> => {
      try {
        return await api.authStatus();
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          return { enabled: false, authenticated: false, hasCredential: false };
        }
        throw e;
      }
    },
    staleTime: 10_000,
    retry: 0, // 401/网络问题时不要重试，直接让守卫去处理
  });
}

/** 登录：成功后刷新状态（守卫随之放行） */
export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { username: string; password: string }) => api.login(v.username, v.password),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.auth() }),
  });
}

/** 退出登录 */
export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      qc.clear(); // 清掉全部缓存：避免下一个登录者看到上一个人的书架/进度
      return qc.invalidateQueries({ queryKey: queryKeys.auth() });
    },
  });
}

/** 设置/修改用户名密码 */
export function useSetCredentials() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { username: string; password: string }) => api.setCredentials(v.username, v.password),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.auth() }),
  });
}

/** 开关登录保护 */
export function useSetAuthEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => api.setAuthEnabled(enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.auth() }),
  });
}

/**
 * 列表首屏条数。
 *
 * 原来是写死的 120：512 本的库首屏只出 120 张，剩下 392 本没有任何入口
 * （`hasMore` 字段服务端一直在返回，前端却从没读过）。
 * 现在改成无限滚动，首屏 36 条 = 手机 3 列 × 12 行，足够铺满一屏还有一屏余量，
 * 首包体积也跟着降下来（120 条约 58KB → 36 条约 17KB，gzip 后 2KB 级别）。
 */
export const LIST_PAGE_SIZE = 36;

/**
 * 「离开后多久仍保留缓存」——给所有「返回时会再看到」的查询用。
 *
 * 30 分钟是按真实阅读时长定的，不是随手取的数：一次阅读普遍 5~30 分钟，
 * 而 react-query 的默认 gcTime 只有 5 分钟，正好卡在「读完了回来缓存已经没了」。
 */
const KEEP_GC_TIME = 30 * 60_000;

/** 列表查询：分页参数由 hook 自己管，调用方只描述筛选条件 */
export type ComicListQuery = Omit<ComicQuery, 'page' | 'pageSize'>;

/**
 * 漫画列表（无限滚动）。
 *
 * 为什么用 useInfiniteQuery 而不是自己维护 page state：
 * 筛选条件在 URL 里，切筛选会生成新的 queryKey，页码随 key 一起重置——
 * 手写 page state 很容易出现「换了筛选条件还从第 3 页开始」。
 */
/**
 * 列表查询。
 *
 * `enabled: false` 的用处：搜索页在没有关键词时不该发请求——它拉回来的整库列表
 * 会被 keepPreviousData 当成「上一次的数据」占位渲染（实测会闪出一屏
 * 「找到 509 部」的整库网格，30ms 后才被真正的空结果顶掉），即浪费一次请求，
 * 又把与关键词无关的旧内容塞给用户。
 */
export function useComics(
  q: ComicListQuery,
  pageSize = LIST_PAGE_SIZE,
  opts?: { enabled?: boolean },
) {
  return useInfiniteQuery({
    enabled: opts?.enabled ?? true,
    queryKey: queryKeys.comics(q, pageSize),
    queryFn: ({ pageParam }) => api.listComics({ ...q, page: pageParam, pageSize }),
    initialPageParam: 1,
    getNextPageParam: (last, all) => (last.hasMore ? all.length + 1 : undefined),
    // 切筛选/排序时保留上一份列表，避免整片网格闪成骨架屏
    placeholderData: keepPreviousData,
    // 列表变化频繁（进度写入会失效它），但仍然值得给 1 分钟：
    // 换来的是「从阅读器退回首页」不重复拉取已经看过的页
    staleTime: 60_000,
    /*
      缓存保留时长必须显式给：默认只有 5 分钟，而一次真实阅读是 5~30 分钟。

      实测（滚到底 180 张 → 进阅读器 → 后退）：
        读 75 秒   → 180 张，滚动位置 9686 保留
        读 5.5 分钟 → 只剩 36 张，滚动位置被 clamp 到 488（文档高度 13032 → 3024）
      也就是说「读完一本书回来，书架缩回第一页、人被扔回顶部」——
      上面 staleTime 想保证的那件事，被 gcTime 的默认值整个抵消了。

      gcTime 只管「缓存留不留」，不管新鲜度：进度上报的 invalidate 照样会让它
      重新拉取，所以给长一点不会让数据变陈旧，代价只是几百 KB 内存。
    */
    gcTime: KEEP_GC_TIME,
  });
}

export function useComicDetail(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.comic(id!),
    queryFn: () => api.comicDetail(id!),
    enabled: !!id,
    staleTime: 30_000,
    // 从阅读器退回详情页是高频路径，读几分钟后缓存没了会整页闪一次骨架屏
    gcTime: KEEP_GC_TIME,
  });
}

export function useFacets() {
  return useQuery({ queryKey: queryKeys.facets(), queryFn: api.facets, staleTime: 60_000 });
}

export function useFavorites() {
  return useQuery({
    queryKey: queryKeys.favorites(),
    queryFn: api.favorites,
    staleTime: 30_000,
    // 回收藏页时第一屏不该闪骨架屏
    gcTime: KEEP_GC_TIME,
  });
}

export function useHistory(limit = 50) {
  return useQuery({
    queryKey: queryKeys.history(),
    queryFn: () => api.history(limit),
    staleTime: 15_000,
    // 首页「继续阅读」是返回首页的第一眼，同理
    gcTime: KEEP_GC_TIME,
  });
}

/** 书架的阅读记录：分页拉取（以前写死 limit=100，读完 100 本以上更早的记录没有入口） */
export function useHistoryFeed(pageSize = 30) {
  return useInfiniteQuery({
    queryKey: [...queryKeys.history(), 'feed', pageSize] as const,
    queryFn: ({ pageParam }) => api.history(pageSize, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    staleTime: 15_000,
    // 与列表同理：翻过几页记录再回来，不该只剩第一页 30 条
    gcTime: KEEP_GC_TIME,
  });
}

export function useLibraries() {
  return useQuery({ queryKey: queryKeys.libraries(), queryFn: api.libraries, staleTime: 60_000 });
}

/**
 * 扫描状态轮询。
 * @param enabled 是否启用
 * @param idleMs  空闲时的轮询间隔（默认不轮询，只在挂载时取一次）
 *
 * 空闲间隔存在的意义：首页要能发现「扫描刚开始」（自动扫描定时器到点、
 * 或用户在漫画库点了扫描但还停留在原页面）。running 时固定 800ms 快轮询。
 */
export function useScanStatus(enabled = false, idleMs: number | false = false) {
  return useQuery({
    queryKey: queryKeys.scan(),
    queryFn: api.scanStatus,
    enabled,
    refetchInterval: (q) => (q.state.data?.running ? 800 : idleMs),
  });
}

/**
 * 首页用的扫描观察器：轮询状态，并在「running → 结束」那一刻自动刷新列表。
 *
 * 不刷新的话，首扫结束时首页仍然停在「还没有漫画」的旧结果上，
 * 用户必须手动下拉/刷新才能看到新扫出来的书。
 */
export function useScanWatch(enabled: boolean, idleMs: number | false = 15_000): ScanStatus | undefined {
  const qc = useQueryClient();
  const { data } = useScanStatus(enabled, idleMs);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (!data) return;
    if (data.running) {
      wasRunning.current = true;
      return;
    }
    if (!wasRunning.current) return;
    wasRunning.current = false;
    qc.invalidateQueries({ queryKey: ['comics'] });
    qc.invalidateQueries({ queryKey: queryKeys.facets() });
    qc.invalidateQueries({ queryKey: queryKeys.libraries() });
  }, [data, qc]);
  return data;
}

/**
 * 服务端设置（L1）：只有服务端会执行的项（自动扫描间隔 / 缓存上限）。
 * 阅读偏好与外观已改为**按设备存**（见 utils/devicePrefs.ts 与
 * docs/2026-10-24-偏好归属论证.md），不再经过这个接口。
 */
export function useSettings() {
  return useQuery({
    queryKey: queryKeys.settings(),
    queryFn: async (): Promise<Settings> => {
      const s = await api.getSettings();
      return { ...SETTINGS_DEFAULTS, ...s };
    },
    staleTime: 5 * 60_000,
  });
}

/** 缓存用量（设置页展示，进页面时取一次） */
export function useCacheStats() {
  return useQuery({ queryKey: queryKeys.cache(), queryFn: api.cacheStats, staleTime: 10_000 });
}

/** 关于（版本/运行环境）：进程内不会变，取一次就够 */
export function useAbout() {
  return useQuery({ queryKey: queryKeys.about(), queryFn: api.about, staleTime: Infinity });
}

/** 清空缓存 */
export function useClearCache() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.clearCache,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.cache() }),
  });
}

/** 按当前上限立即淘汰一次（改小上限后即时生效） */
export function useEvictCache() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.evictCache,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.cache() }),
  });
}

/** 收藏切换：乐观更新 */
export function useToggleFavorite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ comicId, fav }: { comicId: string; fav: boolean }) =>
      fav ? api.removeFavorite(comicId) : api.addFavorite(comicId),
    onMutate: async ({ comicId, fav }) => {
      await qc.cancelQueries({ queryKey: queryKeys.favorites() });
      const prev = qc.getQueryData<{ items: Array<{ id: string }> }>(queryKeys.favorites());
      if (prev) {
        qc.setQueryData(queryKeys.favorites(), {
          items: fav ? prev.items.filter((i) => i.id !== comicId) : prev.items,
        });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKeys.favorites(), ctx.prev);
    },
    onSettled: (_e, _v, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.favorites() });
      qc.invalidateQueries({ queryKey: ['comics'] });
      // 详情页的 isFavorite 由自身查询持有，不失效会停留在切换前的值，
      // 导致按钮卡在「收藏」永远只走 addFavorite（无法取消收藏）
      if (vars?.comicId) qc.invalidateQueries({ queryKey: queryKeys.comic(vars.comicId) });
    },
  });
}

/**
 * 进度上报（阅读器防抖调用）
 *
 * 必须同时失效『列表 / 历史 / 该漫画详情』三处：
 *   - 列表：卡片上的进度条与「继续阅读」排序
 *   - 历史：首页/书架的历史区块
 *   - 详情：按钮的「继续阅读 xx%」、章节列表的「在读 / 百分比」
 *
 * 详情这一条以前漏了，症状是「从阅读器返回详情页，阅读记录不更新」——
 * useComicDetail 的 staleTime 是 30s，返回时命中缓存直接渲染旧数据，连请求都不发。
 * 但阅读器自己也 active 地持有同一个 key（读章节列表），默认 invalidate 会在
 * 每个上报点触发一次整份详情重取（后端要重算章节页数）。所以只标脏、不重取：
 * 退出阅读器时详情页重新挂载，refetchOnMount 自然会拿到新进度。
 */
export function usePutProgress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.putProgress,
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['comics'] });
      qc.invalidateQueries({ queryKey: queryKeys.history() });
      if (vars?.comicId) qc.invalidateQueries({ queryKey: queryKeys.comic(vars.comicId), refetchType: 'none' });
    },
  });
}

/**
 * 重置某部漫画的阅读进度（详情页「重置进度」）。
 *
 * 必须同时失效『详情 / 列表 / 历史』三处，和 usePutProgress 是对称的：
 *   - 详情：按钮回到「开始阅读」、章节格子从「已读/百分比」变回未读
 *   - 列表：卡片上的进度条
 *   - 历史：首页 / 书架的历史区块
 *
 * 以前 Detail 里是手写的 `invalidateQueries({ queryKey: ['comics'] })`，
 * 只清了列表：详情用的是 ['comic', id]（单数），前缀不同，react-query 不认。
 * 加上 useComicDetail 的 staleTime 是 30s，界面会一直停在旧数据上——
 * 表现为「点了重置、服务端也确实清空了（/api/progress 已空），但页面一点变化没有」。
 */
export function useResetProgress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (comicId: string) => api.resetProgress(comicId),
    onSuccess: (_data, comicId) => {
      // 本地镜像必须一起清：Reader 在「服务端没有进度」时会无条件采信镜像，
      // 不清的话重置后一进阅读器就按旧页码定位，还把进度写回服务端 —— 重置被抵消
      clearLocalMirror(comicId);
      qc.invalidateQueries({ queryKey: queryKeys.comic(comicId) });
      qc.invalidateQueries({ queryKey: ['comics'] });
      qc.invalidateQueries({ queryKey: queryKeys.history() });
    },
  });
}

export function useUpdateComic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: { title?: string; author?: string; description?: string; tags?: string[] } }) =>
      api.updateComic(id, body),
    onSettled: (_d, _e, { id }) => {
      qc.invalidateQueries({ queryKey: queryKeys.comic(id) });
      // 标题/分类都参与列表与首页 facets（筛选 chips），改完必须一起刷新
      qc.invalidateQueries({ queryKey: ['comics'] });
      qc.invalidateQueries({ queryKey: queryKeys.facets() });
      // 收藏网格与书架记录行也带标题；它们 staleTime 30s/15s 且窗口聚焦不重取，
      // 不在这里失效的话，改完立刻切到书架看到的还是旧标题。
      qc.invalidateQueries({ queryKey: queryKeys.favorites() });
      qc.invalidateQueries({ queryKey: queryKeys.history() });
    },
  });
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Settings>) => api.putSettings(body),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: queryKeys.settings() });
      const prev = qc.getQueryData<Settings>(queryKeys.settings());
      if (prev) qc.setQueryData(queryKeys.settings(), { ...prev, ...body });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKeys.settings(), ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.settings() }),
  });
}

export function useTriggerScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (libraryId?: string) => api.triggerScan(libraryId),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: queryKeys.scan() });
      qc.invalidateQueries({ queryKey: ['comics'] });
      qc.invalidateQueries({ queryKey: queryKeys.libraries() });
    },
  });
}
