import { useEffect, useRef } from 'react';
import { usePutProgress } from '@/api/queries';

const LS_KEY = 'fakenews-progress-mirror';
const DEBOUNCE_MS = 1000;

/** 本地镜像的内存副本（避免每次上报都 JSON.parse 整个 map） */
let mirror: Record<string, ProgressPayload> | null = null;
function mirrorOf(): Record<string, ProgressPayload> {
  if (!mirror) {
    try {
      mirror = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as Record<string, ProgressPayload>;
    } catch {
      mirror = {};
    }
  }
  return mirror;
}

export interface ProgressPayload {
  comicId: string;
  chapterId: string;
  chapterIndex: number;
  pageIndex: number;
  pageCount: number;
  percent: number;
  /** 镜像写入时刻（ms）。与服务端 ReadingProgress.updatedAt 同量纲，用于判断镜像是否已过期 */
  updatedAt?: number;
}

/**
 * 阅读进度同步（方案 §6 进度记忆三保险）：
 *   1. 翻页防抖 1s 上报服务端（SQLite 持久化）
 *   2. localStorage 镜像（服务端重启/离线时首页仍能续读）
 *   3. 切章 / 返回 / 页面隐藏 → 强制 flush，不丢最后一页
 *
 * payload 传 null 表示「位置尚未定位」，此时不写镜像也不上报——
 * 渲染初始值 0 不是真实阅读位置，写出去会覆盖掉正要读的续读数据。
 */
export function useProgressSync(payload: ProgressPayload | null) {
  const putProgress = usePutProgress();
  const latest = useRef<ProgressPayload | null>(payload);
  latest.current = payload;
  /** 最后一个已定位的位置：切章到定位生效之间 payload 为 null，离场 flush 仍要发它 */
  const lastValid = useRef<ProgressPayload | null>(null);
  if (payload) lastValid.current = payload;
  /** 上次成功上报的位置签名：同一位置不重复写（切章/卸载时会重复 flush） */
  const lastSent = useRef('');
  /**
   * 串行化上报（单飞 + 合并）。
   *
   * 以前每次 flush 都直接 mutate，于是「快速翻几页后立刻退出」会在同一瞬间发出
   * 多个 PUT。浏览器对同域会开多条连接，服务端收包顺序不定 —— 若第 5 页的请求
   * 晚于第 6 页到达，进度就被旧值覆盖（续读位置回退）。
   * 现在同一时刻只允许一个在飞，期间的新位置只覆盖待发值，回来后立刻发最新那个：
   * 既保证顺序（后发的值更新），又把中间的多次翻页合并成一次请求。
   */
  const pending = useRef<ProgressPayload | null>(null);
  const inFlight = useRef(false);

  const flushQueue = () => {
    if (inFlight.current) return;
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    const sig = `${p.comicId}|${p.chapterId}|${p.pageIndex}`;
    if (sig === lastSent.current) {
      // 这一页已经报过了：继续看有没有更晚的位置
      flushQueue();
      return;
    }
    inFlight.current = true;
    // 用 mutateAsync 而不是 mutate(options)：后者会**覆盖** hook 上注册的 onSuccess
    // （usePutProgress 里负责失效 comics/history/comic 三个缓存），进度就白报了。
    putProgress
      .mutateAsync(p)
      .then(() => { lastSent.current = sig; })
      .catch(() => { /* 失败不记为已上报，后续 flush 会重试 */ })
      .finally(() => {
        // 成功失败都要放行，否则一次网络抖动会把后续上报全堵住
        inFlight.current = false;
        flushQueue();
      });
  };

  const send = (p: ProgressPayload) => {
    // 本地镜像（前端可直接读，断网兜底）；updatedAt 供续读时判断镜像是否比服务端旧
    try {
      const all = mirrorOf();
      all[p.comicId] = { ...p, updatedAt: Date.now() };
      localStorage.setItem(LS_KEY, JSON.stringify(all));
    } catch { /* storage 不可用时静默 */ }
    pending.current = p;
    flushQueue();
  };

  // 1. 防抖上报
  useEffect(() => {
    if (!payload || payload.pageCount <= 0) return;
    const t = setTimeout(() => send(payload), DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload?.comicId, payload?.chapterId, payload?.pageIndex, payload?.pageCount]);

  // 2+3. 强制 flush：页面隐藏 / 卸载 / 切章
  useEffect(() => {
    const flush = () => {
      const p = latest.current ?? lastValid.current;
      if (p && p.pageCount > 0) send(p);
      // 发完就忘。切章时 chapterId 变化会先跑这里的 cleanup：把旧章位置立刻发掉
      // （省得等 1s 防抖），然后清掉 lastValid —— 否则新章定位出来之前若页面隐藏/
      // 卸载，这一下会把用户**已经离开**的旧章又写一遍，把新章位置顶掉。
      lastValid.current = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      flush();
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload?.comicId, payload?.chapterId]);
}

/** 首页/书架在服务端数据未返回时读本地镜像（保证刷新后续读） */
export function readLocalMirror(comicId: string): ProgressPayload | null {
  try {
    return mirrorOf()[comicId] ?? null;
  } catch {
    return null;
  }
}

/**
 * 清除某部漫画的本地镜像（重置进度 / 删除阅读历史时调用）。
 *
 * 不清的后果：Reader 的定位逻辑在「服务端没有进度」时会无条件采信镜像
 * （mirror.chapterId 匹配即可）→ 重置后重新进阅读器，页面按旧页码定位，
 * useProgressSync 再把这个页码写回服务端 —— 重置被完全抵消（实测复现过）。
 */
export function clearLocalMirror(comicId: string): void {
  try {
    const all = mirrorOf();
    if (!(comicId in all)) return;
    delete all[comicId];
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch {
    /* storage 不可用时静默 */
  }
}
