/**
 * 阅读模式的「页」换算。
 *
 * pageIndex 是**模式页**：
 *   single / webtoon  1 图 = 1 页
 *   double            对开（见 [doubleSpreads]：首页/末页单占，中间两两成对）
 *   split             1 图 = 2 页（宽幅跨页图对半看；
 *                     竖版页的第二页仍是同一张整图，页码域与图片尺寸无关）
 * 而阅读进度统一按**图索引**存（换模式不丢位置）。
 *
 * 阅读器与外壳（页码、滑块上限、翻页越界判定）必须用同一套换算，
 * 否则会出现「拆分模式拖不到后半页」「双页模式到章末翻不出下一章」这类页码域不一致的 bug。
 *
 * 双页的两个换算都需要 imageCount：末页单占让配对偏移与总页数有关，
 * 光看图索引推不出它落在第几个对开（末尾那张尤其）。
 */
import type { ReaderMode } from '@/types';

/**
 * 双页对开的排布：**首页与末页各自单独占一屏**，中间两两成对。
 *
 * 为什么不是简单的「相邻两图一跨」：绝大多数章节的图 0 是封面，硬配对会把封面和第一张
 * 内页挤在一屏，此后所有对开整体错位一页 —— 真正的跨页图被撕到两屏上，是双页模式
 * 最刺眼的错。首页单占之后，1/2、3/4… 才恢复成真正的对开。
 *
 * 末页同理：最后一跨常常只剩一张，与其让它和空白并排缩成半屏，不如整屏给它。
 *
 * 没有做「横版页一律单张」那条：它需要每张图的宽高，而页元信息（PageMeta）
 * 只有 name/size，服务端列页时并不解码图片。要做要么每次列页全章解码（几百页的章节
 * 首屏会慢一个数量级），要么加一层尺寸缓存 —— 都不属于「翻开就能感觉到」的收益，
 * 等真有人抱怨跨页图被拆再补。
 *
 * 结果按 imageCount 缓存：这个函数在页码、滑块、续读文案多处被调，不该每次重建数组。
 */
const spreadCache = new Map<number, number[][]>();

export function doubleSpreads(imageCount: number): number[][] {
  if (imageCount <= 0) return [[]];
  const hit = spreadCache.get(imageCount);
  if (hit) return hit;

  // 首页单占
  const out: number[][] = [[0]];
  const last = imageCount - 1;
  // 中间从图 1 起两两成对；配对必须止于末页之前，否则末页会被并进倒数第二跨
  for (let i = 1; i < last; i += 2) {
    out.push(i + 1 < last ? [i, i + 1] : [i]);
  }
  // 末页单占（只有一张图的章节上面已经处理完，这里不再重复压一页空跨）
  if (last > 0) out.push([last]);

  spreadCache.set(imageCount, out);
  return out;
}

/** 本章共多少「模式页」 */
export function modePageCount(mode: ReaderMode, imageCount: number): number {
  if (mode === 'double') return Math.max(1, doubleSpreads(imageCount).length);
  if (mode === 'split') return imageCount * 2;
  return imageCount;
}

/** 图索引 → 模式页索引 */
export function imageToModePage(mode: ReaderMode, img: number, imageCount: number): number {
  if (mode === 'double') {
    const spreads = doubleSpreads(imageCount);
    for (let i = 0; i < spreads.length; i++) {
      if (spreads[i].includes(img)) return i;
    }
    // 越界的图索引（换章瞬间 pages 还是旧的）统一落到最后一跨，
    // 别返回 -1 让调用方再夹一次
    return spreads.length - 1;
  }
  if (mode === 'split') return img * 2;
  return img;
}

/** 模式页索引 → 图索引（不叠加对开内偏移） */
export function modePageToImage(mode: ReaderMode, page: number, imageCount: number): number {
  if (mode === 'double') {
    const spreads = doubleSpreads(imageCount);
    const safe = Math.max(0, Math.min(page, spreads.length - 1));
    return spreads[safe]?.[0] ?? 0;
  }
  if (mode === 'split') return Math.floor(page / 2);
  return page;
}

/**
 * 图索引在它所在对开内的偏移（0 或 1）。
 *
 * 不能再拿 `img % 2` 代替：首页单占之后，一跨里的第一张图索引可能是奇也可能是偶
 * （[1,2] 从奇数张起头），旧规则里「偶数开头」的假设不再成立。
 * 用偏移反推图索引的地方（进度、续读、切模式）必须走这里。
 */
export function doubleSubOffset(img: number, imageCount: number): number {
  const first = modePageToImage('double', imageToModePage('double', img, imageCount), imageCount);
  return Math.max(0, img - first);
}
