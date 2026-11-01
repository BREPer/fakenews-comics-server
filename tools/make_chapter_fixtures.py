#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
「章节型库」识别夹具生成器（纯标准库，无三方依赖）。

覆盖的分章形态：
  01 纯子目录       子目录各一章 + 自然排序（第02卷 < 第10卷）
  02 散图加子目录   顶层散图成「散图章」(topOnly) + 子目录章
  03 纯打包         顶层 zip/cbz/pdf/epub 各自成章（无子目录）
  04 包内分组       单个 cbz 包内有分组目录（作为「一章」时应含整包所有页）
  05 全混合         散图 + 子目录 + 四种打包格式，验证章序：散图 → 子目录 → 打包
  06 嵌套过深       章目录下再套子目录（章内递归取图）
  07 怪名           章名含 # % 空格 emoji，验证标题与 URL 编码
  08 空章节         含一个无图的子目录（应成为 0 页章节而不是让整部漫画消失）
  09 坏包           顶层损坏的 zip（章节存在但取页应 4xx，不能 500）
  10 单章           目录里直接放图（无子目录无包）→ 整册一章
  11 包里套包       组织目录只含 zip + 一个「只有 cbz 的子目录」（记录当前行为）

每章的页图都用**互不相同的宽度**编码，manifest 里记录期望的页宽序列，
测试端逐页校验宽度，可同时发现「章串页」「页序错」「少页/多页」。

输出：
  %TEMP%/fc-chapter-lib   章节型库根目录
  %TEMP%/fc-single-lib    单篇型库根目录（对照，确认 promote=false 行为不变）
  %TEMP%/fc-chapter-manifest.json
"""
import json
import os
import random
import shutil
import struct
import tempfile
import zipfile
import zlib

TMP = tempfile.gettempdir()
ROOT = os.path.join(TMP, "fc-chapter-lib")
SINGLE = os.path.join(TMP, "fc-single-lib")
MANIFEST = os.path.join(TMP, "fc-chapter-manifest.json")

# 先清空再生成（否则上次的残留会被扫描进来，断言基数就不对了）
for _d in (ROOT, SINGLE):
    if os.path.exists(_d):
        shutil.rmtree(_d)
os.makedirs(ROOT)
os.makedirs(SINGLE)

rnd = random.Random(20261021)


# ---------------------------------------------------------------- 基础构造
def png(path, w, h, rgb):
    """写一个纯色 PNG，宽度用于断言页序/章隔离。"""
    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)

    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    data = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 1)) + chunk(b"IEND", b""))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def png_bytes(w, h, rgb):
    buf = tempfile.mkdtemp()
    p = os.path.join(buf, "x.png")
    png(p, w, h, rgb)
    with open(p, "rb") as f:
        data = f.read()
    shutil.rmtree(buf)
    return data


def make_pdf(path, pages, rgb=(210, 70, 70)):
    """手写最小 PDF（xref 合法），pdfjs 可解析并逐页光栅化。"""
    colors = [rgb, (70, 150, 210), (90, 200, 130), (230, 180, 40)]
    objects = []
    nid = 1
    catalog, pages_obj, font = nid, nid + 1, nid + 2
    nid += 3
    page_ids, content_ids = [], []
    for _ in range(pages):
        page_ids.append(nid); nid += 1
        content_ids.append(nid); nid += 1
    objects.append((catalog, "<< /Type /Catalog /Pages %d 0 R >>" % pages_obj))
    kids = " ".join("%d 0 R" % x for x in page_ids)
    objects.append((pages_obj, "<< /Type /Pages /Kids [%s] /Count %d >>" % (kids, pages)))
    objects.append((font, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"))
    for i in range(pages):
        r, g, b = colors[i % len(colors)]
        stream = (
            "0.95 0.95 0.95 rg 0 0 612 792 re f\n"
            "%.3f %.3f %.3f rg 60 300 492 360 re f\n" % (r / 255, g / 255, b / 255)
            + "0 0 0 rg BT /F1 48 Tf 72 720 Td (chapter pdf page %d) Tj ET" % (i + 1)
        )
        objects.append((page_ids[i],
                        "<< /Type /Page /Parent %d 0 R /MediaBox [0 0 612 792] "
                        "/Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>"
                        % (pages_obj, font, content_ids[i])))
        objects.append((content_ids[i],
                        "<< /Length %d >>\nstream\n%s\nendstream" % (len(stream.encode()), stream)))
    pdf = "%PDF-1.4\n"
    offsets = {}
    for oid, body in objects:
        offsets[oid] = len(pdf.encode("latin1"))
        pdf += "%d 0 obj\n%s\nendobj\n" % (oid, body)
    xref = len(pdf.encode("latin1"))
    pdf += "xref\n0 %d\n" % nid
    pdf += "0000000000 65535 f \n"
    for oid in range(1, nid):
        pdf += "%010d 00000 n \n" % offsets[oid]
    pdf += "trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF" % (nid, catalog, xref)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(pdf.encode("latin1"))


def write_zip(path, files):
    """files: list[(arcname, bytes)]，按给定顺序写入。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files:
            z.writestr(name, data)


def make_epub(path, page_widths, spine_order):
    """EPUB：spine 顺序与文件名顺序故意不同，验证按 spine 取页。"""
    files = [("mimetype", b"application/epub+zip")]
    files.append(("META-INF/container.xml",
                  b'<?xml version="1.0"?><container version="1.0" '
                  b'xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
                  b'<rootfiles><rootfile full-path="OEBPS/content.opf" '
                  b'media-type="application/oebps-package+xml"/></rootfiles></container>'))
    manifest_items = "".join(
        '<item id="p%d" href="images/page%d.png" media-type="image/png"/>' % (i + 1, i + 1)
        for i in range(len(page_widths)))
    spine = "".join('<itemref idref="p%d"/>' % (i + 1) for i in spine_order)
    opf = ('<?xml version="1.0" encoding="utf-8"?>'
           '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">'
           '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
           '<dc:title>外传 EPUB</dc:title><dc:creator>EPUB 作者</dc:creator>'
           '<dc:description>EPUB 章简介</dc:description><dc:subject>奇幻</dc:subject>'
           '</metadata><manifest>%s</manifest><spine>%s</spine></package>' % (manifest_items, spine))
    files.append(("OEBPS/content.opf", opf.encode("utf-8")))
    for i, w in enumerate(page_widths):
        files.append(("OEBPS/images/page%d.png" % (i + 1), png_bytes(w, 160, (30, 90, 200))))
    write_zip(path, files)


# ---------------------------------------------------------------- 夹具数据
comics = []   # 期望清单


def pages_in(dirpath, widths):
    for i, w in enumerate(widths):
        png(os.path.join(dirpath, "%03d.png" % (i + 1)), w, 170,
            (rnd.randint(40, 200), rnd.randint(40, 200), rnd.randint(40, 200)))


def comic(name, chapters, raw_title=None, note=None):
    """raw_title = 扫描后 comic 的目录名（默认取 name 的末级）。

    嵌套两层的章目录（漫画名/第01卷/章节A/*.png）会被 walkRoot 提升成
    名为「第01卷」的独立漫画——这是 promote 启发式的固有取舍，这里按现状断言并记录。
    """
    entry = {"dir": name, "rawTitle": raw_title or os.path.basename(name), "chapters": chapters}
    if note:
        entry["note"] = note
    comics.append(entry)


# 01 纯子目录：自然排序 第02卷 < 第10卷
c = os.path.join(ROOT, "01 纯子目录")
pages_in(os.path.join(c, "第01卷"), [201, 202, 203])
pages_in(os.path.join(c, "第02卷"), [204, 205])
pages_in(os.path.join(c, "第10卷"), [206, 207, 208, 209])
comic("01 纯子目录", [
    {"title": "第01卷", "kind": "folder", "widths": [201, 202, 203]},
    {"title": "第02卷", "kind": "folder", "widths": [204, 205]},
    {"title": "第10卷", "kind": "folder", "widths": [206, 207, 208, 209]},
])

# 02 散图加子目录：散图章（topOnly）在前，子目录章在后
c = os.path.join(ROOT, "02 散图加子目录")
png(os.path.join(c, "001封面.png"), 301, 170, (240, 200, 60))
png(os.path.join(c, "002版权.png"), 302, 170, (220, 220, 220))
pages_in(os.path.join(c, "第01卷"), [303, 304])
pages_in(os.path.join(c, "第02卷"), [305, 306, 307])
comic("02 散图加子目录", [
    {"title": "02 散图加子目录", "kind": "folder", "widths": [301, 302], "loose": True},
    {"title": "第01卷", "kind": "folder", "widths": [303, 304]},
    {"title": "第02卷", "kind": "folder", "widths": [305, 306, 307]},
])

# 03 纯打包：zip / cbz / pdf / epub 各一章
c = os.path.join(ROOT, "03 纯打包")
write_zip(os.path.join(c, "第01卷.zip"), [
    ("001.png", png_bytes(401, 170, (200, 60, 60))),
    ("002.png", png_bytes(402, 170, (200, 90, 60))),
    ("003.png", png_bytes(403, 170, (200, 120, 60))),
])
write_zip(os.path.join(c, "第02卷.cbz"), [
    ("001.png", png_bytes(404, 170, (60, 120, 200))),
    ("002.png", png_bytes(405, 170, (60, 150, 200))),
])
make_pdf(os.path.join(c, "第03卷.pdf"), 2)
make_epub(os.path.join(c, "第04卷.epub"), [80, 40, 60], [2, 0, 1])  # spine: page3,page1,page2
comic("03 纯打包", [
    {"title": "第01卷", "kind": "zip", "widths": [401, 402, 403]},
    {"title": "第02卷", "kind": "cbz", "widths": [404, 405]},
    {"title": "第03卷", "kind": "pdf", "widths": [None, None]},
    {"title": "第04卷", "kind": "epub", "widths": [60, 80, 40]},  # 按 spine 顺序
])

# 04 包内分组：一个 cbz 内部分目录，作为「一章」应含整包所有页
c = os.path.join(ROOT, "04 包内分组")
write_zip(os.path.join(c, "合集.cbz"), [
    ("第1话/001.png", png_bytes(501, 170, (120, 60, 200))),
    ("第1话/002.png", png_bytes(502, 170, (120, 90, 200))),
    ("第1话/003.png", png_bytes(503, 170, (120, 120, 200))),
    ("第2话/001.png", png_bytes(504, 170, (90, 60, 200))),
    ("第2话/002.png", png_bytes(505, 170, (60, 60, 200))),
])
comic("04 包内分组", [
    {"title": "合集", "kind": "cbz", "widths": [501, 502, 503, 504, 505]},
])

# 05 全混合：散图 → 子目录 → 打包
c = os.path.join(ROOT, "05 全混合")
png(os.path.join(c, "000封面.png"), 601, 170, (60, 160, 160))
pages_in(os.path.join(c, "第01卷"), [602, 603])
pages_in(os.path.join(c, "第02卷"), [604, 605])
write_zip(os.path.join(c, "第03卷.zip"), [("001.png", png_bytes(606, 170, (160, 60, 160))),
                                          ("002.png", png_bytes(607, 170, (180, 60, 160)))])
make_pdf(os.path.join(c, "第04卷.pdf"), 2)
make_epub(os.path.join(c, "第05卷.epub"), [70, 90], [0, 1])
comic("05 全混合", [
    {"title": "05 全混合", "kind": "folder", "widths": [601], "loose": True},
    {"title": "第01卷", "kind": "folder", "widths": [602, 603]},
    {"title": "第02卷", "kind": "folder", "widths": [604, 605]},
    {"title": "第03卷", "kind": "zip", "widths": [606, 607]},
    {"title": "第04卷", "kind": "pdf", "widths": [None, None]},
    {"title": "第05卷", "kind": "epub", "widths": [70, 90]},
])

# 06 嵌套过深：漫画名/第01卷/章节A/*.png —— 现状是「第01卷」被提升成独立漫画
c = os.path.join(ROOT, "06 嵌套过深")
pages_in(os.path.join(c, "第01卷", "章节A"), [701, 702])
pages_in(os.path.join(c, "第01卷", "章节B"), [703])
comic("06 嵌套过深/第01卷", [
    {"title": "章节A", "kind": "folder", "widths": [701, 702], "orderSensitive": False},
    {"title": "章节B", "kind": "folder", "widths": [703]},
], raw_title="第01卷", note="两层嵌套：comic 变成「第01卷」，漫画名丢失（promote 启发式取舍）")

# 07 怪名：章名含 # % 空格 emoji
c = os.path.join(ROOT, "07 怪名")
pages_in(os.path.join(c, "第#01卷"), [801, 802])
pages_in(os.path.join(c, "第 02 卷"), [803, 804])
pages_in(os.path.join(c, "🎨彩页"), [805, 806])
write_zip(os.path.join(c, "100%外传.zip"), [("001.png", png_bytes(807, 170, (90, 90, 90))),
                                            ("002.png", png_bytes(808, 170, (110, 110, 110)))])
comic("07 怪名", [
    {"title": "100%外传", "kind": "zip", "widths": [807, 808]},
    {"title": "第#01卷", "kind": "folder", "widths": [801, 802]},
    {"title": "第 02 卷", "kind": "folder", "widths": [803, 804]},
    {"title": "🎨彩页", "kind": "folder", "widths": [805, 806]},
])

# 08 空章节：一个无图子目录
c = os.path.join(ROOT, "08 空章节")
os.makedirs(os.path.join(c, "空目录"), exist_ok=True)
pages_in(os.path.join(c, "第01卷"), [901, 902])
comic("08 空章节", [
    {"title": "空目录", "kind": "folder", "widths": []},
    {"title": "第01卷", "kind": "folder", "widths": [901, 902]},
])

# 09 坏包：损坏的 zip
c = os.path.join(ROOT, "09 坏包")
pages_in(os.path.join(c, "第01卷"), [1001, 1002])
os.makedirs(c, exist_ok=True)
with open(os.path.join(c, "损坏.zip"), "wb") as f:
    f.write(b"not a zip at all" * 40)
comic("09 坏包", [
    {"title": "第01卷", "kind": "folder", "widths": [1001, 1002]},
    {"title": "损坏", "kind": "zip", "widths": [], "broken": True},
])

# 10 单章：目录直接放图
c = os.path.join(ROOT, "10 单章")
pages_in(c, [1101, 1102, 1103])
comic("10 单章", [
    {"title": "10 单章", "kind": "folder", "widths": [1101, 1102, 1103]},
])

# 11 包里套包：顶层 zip + 一个「只含 cbz 的子目录」（记录当前行为）
c = os.path.join(ROOT, "11 包里套包")
write_zip(os.path.join(c, "单行本.zip"), [("001.png", png_bytes(1201, 170, (40, 140, 40))),
                                          ("002.png", png_bytes(1202, 170, (40, 170, 40)))])
write_zip(os.path.join(c, "系列", "第01卷.cbz"), [("001.png", png_bytes(1203, 170, (140, 40, 40)))])
comic("11 包里套包", [
    {"title": "系列", "kind": "folder", "widths": []},
    {"title": "单行本", "kind": "zip", "widths": [1201, 1202]},
])

# 隐藏目录/样张：不应成为漫画或章节
pages_in(os.path.join(ROOT, ".hidden", "第01卷"), [1301])
png(os.path.join(ROOT, "02 散图加子目录", "sample.png"), 50, 50, (255, 0, 0))

# ---------------------------------------------------------------- 单篇型对照库
single = []
c = os.path.join(SINGLE, "书架", "漫画A")
pages_in(os.path.join(c, "第01卷"), [21, 22])
pages_in(os.path.join(c, "第02卷"), [23])
single.append({"dir": "书架/漫画A/第01卷", "chapters": [{"title": "第01卷", "kind": "folder", "widths": [21, 22]}]})
single.append({"dir": "书架/漫画A/第02卷", "chapters": [{"title": "第02卷", "kind": "folder", "widths": [23]}]})
write_zip(os.path.join(SINGLE, "书架", "单行本.cbz"),
          [("001.png", png_bytes(31, 170, (10, 10, 10))), ("002.png", png_bytes(32, 170, (20, 20, 20)))])
single.append({"dir": "书架/单行本.cbz", "chapters": [{"title": "单行本", "kind": "cbz", "widths": [31, 32]}]})

# ---------------------------------------------------------------- 输出
with open(MANIFEST, "w", encoding="utf-8") as f:
    json.dump({"chapterRoot": ROOT, "singleRoot": SINGLE, "comics": comics, "single": single},
              f, ensure_ascii=False, indent=2)

print("章节型夹具就绪:", ROOT)
for cm in comics:
    print(" -", cm["dir"], "→", len(cm["chapters"]), "章")
print("单篇型对照库:", SINGLE, "→", len(single), "本")
print("清单:", MANIFEST)
