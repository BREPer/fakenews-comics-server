#!/usr/bin/env python3
"""统计漫画库源图的分辨率分布（只读，不改任何文件）。

用途：决定「画质增强」要不要上真超分模型，还是靠高质量插值就够。
判据是「源图宽 / 阅读时目标宽」这个倍率：
  - 主流倍率 <= 1.5x  → 传统插值 + 锐化就够，不值得进模型
  - 主流倍率 >= 2.0x  → 真超分才有明显收益

用法：
    python tools/source_resolution_survey.py <漫画根目录> [--limit N]

支持：散图目录、.cbz/.zip、.epub（epub 里是图片条目，走同一个 zip 路径）。
PDF 不采样（需要 pdfium，且 PDF 页多是渲染出来的，意义不同）。

输出：总体宽度分位、按库/漫画的分布、以及「在 1080 宽屏上需要放大的占比」。
"""
import argparse
import io
import os
import sys
import zipfile
from collections import Counter, defaultdict

IMG_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".avif"}
ARCHIVE_EXT = {".cbz", ".zip", ".epub"}
SKIP_NAMES = {"@eaDir", "__MACOSX", ".git", ".hidden"}

TARGET_WIDTH = 1080  # Android 标准画质请求宽；超过它才有放大需求


def pix_size(head: bytes):
    """只读文件头判断 (w, h)，不整图解码。支持 PNG / JPEG / WebP / GIF / BMP。"""
    if len(head) < 26:
        return None
    # PNG: IHDR 宽高在固定偏移
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        w = int.from_bytes(head[16:20], "big")
        h = int.from_bytes(head[20:24], "big")
        return (w, h)
    # GIF
    if head[:6] in (b"GIF87a", b"GIF89a"):
        w = int.from_bytes(head[6:8], "little")
        h = int.from_bytes(head[8:10], "little")
        return (w, h)
    # BMP
    if head[:2] == b"BM":
        w = int.from_bytes(head[18:22], "little", signed=True)
        h = abs(int.from_bytes(head[22:26], "little", signed=True))
        return (w, h)
    # WebP: RIFF....WEBP，后面 VP8 / VP8L / VP8X 三种头
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        ck = head[12:16]
        if ck == b"VP8 ":
            w = int.from_bytes(head[26:28], "little") & 0x3FFF
            h = int.from_bytes(head[28:30], "little") & 0x3FFF
            return (w, h)
        if ck == b"VP8L":
            b = int.from_bytes(head[21:25], "little")
            return ((b & 0x3FFF) + 1, ((b >> 14) & 0x3FFF) + 1)
        if ck == b"VP8X":
            w = int.from_bytes(head[24:27], "little") + 1
            h = int.from_bytes(head[27:30], "little") + 1
            return (w, h)
    # JPEG: 扫 SOF0/1/2 段
    if head[:2] == b"\xff\xd8":
        i = 2
        n = len(head)
        while i + 9 < n:
            if head[i] != 0xFF:
                i += 1
                continue
            m = head[i + 1]
            if m in (0xD8, 0xD9) or 0xD0 <= m <= 0xD7:
                i += 2
                continue
            seg = int.from_bytes(head[i + 2:i + 4], "big")
            if m in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                     0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                h = int.from_bytes(head[i + 5:i + 7], "big")
                w = int.from_bytes(head[i + 7:i + 9], "big")
                return (w, h)
            if seg < 2:
                break
            i += 2 + seg
        return None
    return None


def read_head(fp, need=64 * 1024) -> bytes:
    try:
        return fp.read(need)
    except Exception:
        return b""


def scan_dir(root, comic_name):
    """散图目录：返回 [(漫画名, 宽, 高, 字节)]"""
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_NAMES]
        for fn in filenames:
            ext = os.path.splitext(fn)[1].lower()
            if ext not in IMG_EXT:
                continue
            p = os.path.join(dirpath, fn)
            rel = comic_name
            try:
                size = os.path.getsize(p)
                if size < 1024:
                    continue
                with open(p, "rb") as f:
                    s = pix_size(read_head(f))
                if s:
                    out.append((rel, s[0], s[1], size))
            except OSError:
                continue
    return out


def scan_archive(path, comic_name):
    out = []
    try:
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist()
                     if os.path.splitext(n)[1].lower() in IMG_EXT
                     and not n.startswith("__MACOSX")]
            names.sort()
            for n in names:
                try:
                    info = z.getinfo(n)
                    if info.file_size < 1024:
                        continue
                    with z.open(n) as fp:
                        s = pix_size(read_head(fp))
                    if s:
                        out.append((comic_name, s[0], s[1], info.file_size))
                except Exception:
                    continue
    except (zipfile.BadZipFile, OSError):
        pass
    return out


def pct(sorted_vals, p):
    if not sorted_vals:
        return 0
    k = max(0, min(len(sorted_vals) - 1, int(round((len(sorted_vals) - 1) * p / 100))))
    return sorted_vals[k]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root", help="漫画根目录")
    ap.add_argument("--limit", type=int, default=20000, help="最多采样多少页（默认 20000）")
    a = ap.parse_args()

    root = a.root
    if not os.path.isdir(root):
        print(f"目录不存在: {root}")
        return 2

    rows = []
    archives = 0
    for name in sorted(os.listdir(root)):
        if name in SKIP_NAMES:
            continue
        p = os.path.join(root, name)
        if os.path.isfile(p):
            ext = os.path.splitext(name)[1].lower()
            if ext in ARCHIVE_EXT:
                archives += 1
                rows += scan_archive(p, os.path.splitext(name)[0])
        elif os.path.isdir(p):
            rows += scan_dir(p, name)

    rows = rows[: a.limit]
    if not rows:
        print("没有采到任何图片。确认路径是否指向漫画库根目录。")
        return 1

    widths = sorted(r[1] for r in rows)
    heights = sorted(r[2] for r in rows)
    sizes = [r[3] for r in rows]
    n = len(rows)

    print(f"采样页数: {n}    压缩包: {archives}\n")
    print("宽度分位 (px):")
    for p in (1, 5, 25, 50, 75, 95, 99):
        print(f"  p{p:<2} {pct(widths, p):>6}")
    print(f"  均值 {sum(widths)/n:>6.0f}    最宽 {widths[-1]}    最窄 {widths[0]}")

    print("\n高度分位 (px):")
    for p in (1, 25, 50, 75, 99):
        print(f"  p{p:<2} {pct(heights, p):>6}")

    print(f"\n单页字节: 中位 {pct(sorted(sizes), 50)/1024:.0f} KB    "
          f"p95 {pct(sorted(sizes), 95)/1024:.0f} KB    合计 {sum(sizes)/1024/1024:.0f} MB")

    up = [w for w in widths if w < TARGET_WIDTH]
    print(f"\n在 {TARGET_WIDTH} 宽屏上需要放大的页: {len(up)}/{n} = {len(up)*100/n:.1f}%")
    print("需要的放大倍率分布（源宽 → 屏宽，即 1080/源宽）:")
    buckets = Counter()
    for w in widths:
        if w >= TARGET_WIDTH:
            buckets["无需放大 (>=1080)"] += 1
        else:
            r = TARGET_WIDTH / w
            if r <= 1.2:
                buckets["1.0-1.2x"] += 1
            elif r <= 1.5:
                buckets["1.2-1.5x"] += 1
            elif r <= 2.0:
                buckets["1.5-2.0x"] += 1
            elif r <= 3.0:
                buckets["2.0-3.0x"] += 1
            else:
                buckets[">3.0x"] += 1
    order = ["无需放大 (>=1080)", "1.0-1.2x", "1.2-1.5x", "1.5-2.0x", "2.0-3.0x", ">3.0x"]
    for k in order:
        if buckets[k]:
            print(f"  {k:<18} {buckets[k]:>6}  {buckets[k]*100/n:5.1f}%")

    print("\n按漫画（宽度中位 / 页数，最多 15 本）:")
    by = defaultdict(list)
    for name, w, h, s in rows:
        by[name].append(w)
    top = sorted(by.items(), key=lambda kv: -len(kv[1]))[:15]
    for name, ws in top:
        ws.sort()
        print(f"  {name[:28]:<30} 中位 {pct(ws, 50):>5}  页数 {len(ws):>4}")

    # 结论提示：这里只给判据，不作决定
    heavy = sum(v for k, v in buckets.items() if k in ("1.5-2.0x", "2.0-3.0x", ">3.0x"))
    print()
    if heavy * 100 / n >= 30:
        print(f"判据：{heavy*100/n:.0f}% 的页需要 >1.5x 放大 → 真超分有明确收益")
    else:
        print(f"判据：只有 {heavy*100/n:.0f}% 的页需要 >1.5x 放大 → 高质量插值+锐化大概率够用")
    return 0


if __name__ == "__main__":
    sys.exit(main())
