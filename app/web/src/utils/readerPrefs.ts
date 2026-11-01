/**
 * 阅读器里「与章节视图有关」的本机记忆（列表 / 一格四列）。
 *
 * 注意：翻页模式等 10 项阅读偏好已统一收到 `utils/devicePrefs.ts`（localStorage 唯一真源），
 * 这里只保留"视图形态"这类**只影响当前界面排布**的小偏好——它们不属于阅读偏好，
 * 也不需要出现在设置页里，但同样按设备记。
 */
const CHAPTER_VIEW_KEY = 'fakenews:chapterView';

export type ChapterView = 'list' | 'grid';

/** 章节抽屉的视图（列表 / 一格四列的网格） */
export function readChapterView(): ChapterView {
  try {
    return localStorage.getItem(CHAPTER_VIEW_KEY) === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
}

export function writeChapterView(v: ChapterView): void {
  try {
    localStorage.setItem(CHAPTER_VIEW_KEY, v);
  } catch {
    /* 同上 */
  }
}

/**
 * 详情页章节区的视图。和阅读器抽屉用**不同的 key**：两处是不同场景的偏好，
 * 在详情页切成四格不代表在阅读器里也想用四格。
 */
const DETAIL_VIEW_KEY = 'fakenews:detailChapterView';

/** 详情页章节视图（列表 / 一行四格） */
export function readDetailChapterView(): ChapterView {
  try {
    return localStorage.getItem(DETAIL_VIEW_KEY) === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
}

export function writeDetailChapterView(v: ChapterView): void {
  try {
    localStorage.setItem(DETAIL_VIEW_KEY, v);
  } catch {
    /* 同上 */
  }
}
