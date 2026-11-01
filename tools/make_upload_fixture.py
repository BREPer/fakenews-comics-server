#!/usr/bin/env python3
"""生成「上传整部漫画」专用测试夹具（不放进标准夹具，避免动到其它断言的计数）。

用法: python tools/make_upload_fixture.py <输出目录>

产物:
  整包测试.cbz   整个包只有一个顶层文件夹「整包测试」（一键打包的常见形态），
                包内 第01卷×2页 + 第02卷×2页。
                用于验证上传解压时的「单根目录上提」：
                解压结果应为 <库>/整包测试/第01卷/...，而不是双层嵌套。
  散图漫画.cbz   3 张散图平铺在包根（001.png~003.png），用于单篇型原样上传用例。
  分章漫画.cbz   包根两级目录 第01卷/001.png + 第02卷/001.png，
                用于章节型解压用例（多根目录，不触发上提）。
"""
import os
import struct
import sys
import zipfile
import zlib


def png(path, w, h, rgb):
    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    raw = b""
    for _ in range(h):
        raw += b"\x00" + bytes(rgb) * w
    idat = zlib.compress(raw)
    with open(path, "wb") as f:
        f.write(sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b""))


def build_single_root_cbz(out):
    """整包测试.cbz：整个包只有一个顶层文件夹（一键打包形态，2章×2页）"""
    build = os.path.join(out, "_build")
    if os.path.exists(build):
        import shutil

        shutil.rmtree(build)
    os.makedirs(build, exist_ok=True)
    for ch in range(1, 3):
        d = os.path.join(build, "整包测试", f"第{ch:02d}卷")
        os.makedirs(d, exist_ok=True)
        for p in range(1, 3):
            png(os.path.join(d, f"{p:03d}.png"), 100, 140, (60 * ch, 90, 160))
    cbz = os.path.join(out, "整包测试.cbz")
    with zipfile.ZipFile(cbz, "w", zipfile.ZIP_DEFLATED) as z:
        for dirpath, _, files in os.walk(build):
            for f in files:
                full = os.path.join(dirpath, f)
                z.write(full, os.path.relpath(full, build))
    import shutil

    shutil.rmtree(build)
    print(f"上传夹具已生成: {cbz}")


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join("/tmp", "fc-upload-fixtures")
    os.makedirs(out, exist_ok=True)
    build_single_root_cbz(out)
    build_flat_cbz(out)
    build_chapter_cbz(out)


def build_flat_cbz(out):
    """散图漫画.cbz：3 张散图平铺包根（单篇型原样上传用例）"""
    build = os.path.join(out, "_build_flat")
    if os.path.exists(build):
        import shutil

        shutil.rmtree(build)
    os.makedirs(build, exist_ok=True)
    for p in range(1, 4):
        png(os.path.join(build, f"{p:03d}.png"), 90, 130, (40 * p, 110, 180))
    cbz = os.path.join(out, "散图漫画.cbz")
    with zipfile.ZipFile(cbz, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(os.listdir(build)):
            z.write(os.path.join(build, f), f)
    import shutil

    shutil.rmtree(build)
    print(f"上传夹具已生成: {cbz}")


def build_chapter_cbz(out):
    """分章漫画.cbz：包根两级目录 第01卷/001.png + 第02卷/001.png（章节型解压用例）"""
    build = os.path.join(out, "_build_ch")
    if os.path.exists(build):
        import shutil

        shutil.rmtree(build)
    for ch in range(1, 3):
        d = os.path.join(build, f"第{ch:02d}卷")
        os.makedirs(d, exist_ok=True)
        png(os.path.join(d, "001.png"), 80, 120, (70 * ch, 100, 190))
    cbz = os.path.join(out, "分章漫画.cbz")
    with zipfile.ZipFile(cbz, "w", zipfile.ZIP_DEFLATED) as z:
        for dirpath, _, files in os.walk(build):
            for f in files:
                full = os.path.join(dirpath, f)
                z.write(full, os.path.relpath(full, build))
    import shutil

    shutil.rmtree(build)
    print(f"上传夹具已生成: {cbz}")


if __name__ == "__main__":
    main()
