/**
 * 路由 URL 构造工具。
 *
 * 章节 id 形如 `<comicId>#<index>`，含 `#`——**放进 URL 必须编码**，
 * 否则 `#` 会被浏览器当作锚点分隔符，路径在 `#` 处截断，
 * 路由参数变成半截 id（曾导致「开始阅读」永远提示章节不存在）。
 * 所有跳转阅读器的位置统一走 readUrl()，不要手拼字符串。
 */

export function readUrl(comicId: string, chapterId: string, page?: number): string {
  const base = `/read/${encodeURIComponent(comicId)}/${encodeURIComponent(chapterId)}`;
  return page !== undefined && Number.isFinite(page) ? `${base}?page=${Math.max(0, Math.trunc(page))}` : base;
}
