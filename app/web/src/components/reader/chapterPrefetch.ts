/**
 * 相邻章节预取（章末/章首附近触发）
 *
 * 为什么需要：换章要串行做两件事——取章节页清单、再取首页图片。
 * 实测（tools/perf_boundary.mjs，冷缩略图缓存）跨章 204ms，其中约 150ms 是
 * 「这一章首页的缩略图第一次被编码」。热缓存时同样的换章只要 53ms。
 * 也就是说，慢的是「第一次」，而不是换章这个动作本身。
 *
 * 所以做法不是加快换章，而是**在用户还在读上一章时就把这份成本付掉**：
 * 读到接近章末就预取下一章的页清单（存内存）与首页图（进 HTTP 缓存）。
 * 用户真要翻过去时，两步都已经命中，只剩渲染。
 *
 * 与 usePreloader 的分工：那个管「本章前后 N 页」；这里只管跨章那一次边界。
 */
import { api } from '@/api/client';
import { pageUrl } from './page-image';
import type { PageMeta, Quality } from '@/types';

const cacheKey = (comicId: string, chapterId: string) => `${comicId}|${chapterId}`;

/** 页清单内存缓存：键含 comicId，避免不同漫画的同名章节 id 撞车 */
const pagesCache = new Map<string, PageMeta[]>();
/** 已发起的页清单请求（同一章被多个入口同时预取时只发一次） */
const inflight = new Set<string>();

/** 读已缓存的页清单；页数与章节元数据对不上时视为失效（重新扫描会改变页数） */
export function cachedPages(comicId: string, chapterId: string, expectCount: number): PageMeta[] | null {
  const hit = pagesCache.get(cacheKey(comicId, chapterId));
  if (!hit) return null;
  return hit.length === expectCount ? hit : null;
}

/** 页面卸载/重扫描后清空，避免长期占内存（一部漫画的页清单只有几十 KB） */
export function clearPagesCache(): void {
  pagesCache.clear();
  inflight.clear();
}

/**
 * 预取一章：页清单进内存缓存 + 首页图进 HTTP 缓存。
 * `side`：从章首进入还是从章末进入（往回翻时要的是末页，不是首页）。
 */
export function prefetchChapter(
  comicId: string,
  chapterId: string,
  pageCount: number,
  quality: Quality,
  side: 'first' | 'last',
  imageCount = 2,
): void {
  const key = cacheKey(comicId, chapterId);
  if (!pagesCache.has(key) && !inflight.has(key)) {
    inflight.add(key);
    api
      .pages(comicId, chapterId)
      .then((r) => {
        pagesCache.set(key, r.pages);
      })
      // 预取失败无所谓：真换章时还有一次正常请求兜底
      .catch(() => {})
      .finally(() => inflight.delete(key));
  }

  // 首页/末页以及紧邻的那一页：换章后通常还会再翻一两页
  const start = side === 'first' ? 0 : Math.max(0, pageCount - 1);
  const step = side === 'first' ? 1 : -1;
  for (let n = 0; n < imageCount; n++) {
    const idx = start + step * n;
    if (idx < 0 || idx > pageCount - 1) break;
    const im = new Image();
    im.src = pageUrl(comicId, chapterId, idx, quality);
  }
}
