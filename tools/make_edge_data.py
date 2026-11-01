#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成边界/压力测试数据（独立于主测试库，避免污染）。

产出到 $TEMP/fc-edge：
  异常命名、空目录、坏压缩包、无图片包、深层嵌套、零字节图片、单图漫画、
  emoji/中文/特殊字符目录、__MACOSX 噪音、200 部压力库（stress/）
用法：python tools/make_edge_data.py
"""
import os
import random
import shutil
import struct
import zipfile
import zlib

ROOT = os.path.join(os.environ.get("TEMP", "/tmp"), "fc-edge")


def png_bytes(w, h, rgb):
    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)

    raw = b""
    for _ in range(h):
        raw += b"\x00" + bytes(rgb) * w
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


if os.path.exists(ROOT):
    shutil.rmtree(ROOT)
os.makedirs(ROOT)

# 1) 各种"怪名"漫画目录（空格/括号/井号/百分号/中英混排/emoji）
for name in [
    "带 空格 与 (括号) 的漫画",
    "井号#1 与 百分号%20 的漫画",
    "【中文】漫画 第二季 [作者名]",
    "emoji 😀📚 漫画",
    "a" * 80 + " 超长名字漫画",
]:
    d = os.path.join(ROOT, name, "第01卷")
    for i in (1, 2):
        write(os.path.join(d, f"{i:03d}.png"), png_bytes(40, 60, (random.randint(50, 220), 80, 160)))

# 2) 空目录（无图片）→ 不应入库
os.makedirs(os.path.join(ROOT, "空目录", "子目录A"), exist_ok=True)

# 3) 坏压缩包（扩展名是 cbz，内容不是 zip）
write(os.path.join(ROOT, "坏包.cbz"), b"this is definitely not a zip file" * 20)

# 4) 无图片的包（只有元数据与文本）→ 0 页漫画，不应崩溃
with zipfile.ZipFile(os.path.join(ROOT, "无图片.zip"), "w") as z:
    z.writestr("ComicInfo.xml", "<ComicInfo><Title>只有元数据</Title></ComicInfo>")
    z.writestr("readme.txt", "no images here")

# 5) 深层嵌套（6 层）→ walker 应能钻进到含图目录
write(os.path.join(ROOT, "深层嵌套", "a", "b", "c", "d", "e", "第01卷", "001.png"), png_bytes(50, 70, (10, 200, 200)))

# 6) 零字节图片（伪 PNG）→ 缩略图生成会失败，接口不应 500 崩服务
write(os.path.join(ROOT, "零字节图片", "第01卷", "001.png"), b"")
write(os.path.join(ROOT, "零字节图片", "第01卷", "002.png"), png_bytes(30, 30, (200, 30, 30)))

# 7) 单图漫画（1 页 1 章）
write(os.path.join(ROOT, "单图漫画", "only.png"), png_bytes(60, 90, (90, 90, 220)))

# 8) 噪音：__MACOSX 与隐藏目录（应被跳过）
write(os.path.join(ROOT, "__MACOSX", "junk", "001.png"), png_bytes(10, 10, (0, 0, 0)))
write(os.path.join(ROOT, ".hidden_dir", "001.png"), png_bytes(10, 10, (0, 0, 0)))

# 9) 章节名非标准（不是"第N卷"）→ 混入章目录，应作为普通子目录处理
d = os.path.join(ROOT, "非标准章名")
for sub in ["Opening", "middle_part", "END"]:
    for i in (1, 2):
        write(os.path.join(d, sub, f"{i}.png"), png_bytes(40, 60, (120, 40, 200)))

# 10) 压力库：200 部小漫画（每部 2 章 × 2 页）
stress = os.path.join(ROOT, "stress")
for n in range(1, 201):
    for ch in (1, 2):
        for p in (1, 2):
            write(os.path.join(stress, f"漫画{n:03d}", f"第{ch:02d}卷", f"{p:03d}.png"), png_bytes(20, 30, (n % 255, 100, 150)))

total = sum(len(files) for _, _, files in os.walk(ROOT))
print("边界测试数据就绪:", ROOT)
print("顶层条目:", len(os.listdir(ROOT)), "| 文件总数:", total)
