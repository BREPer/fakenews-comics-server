#!/usr/bin/env python3
"""生成测试漫画数据：folder 型 + zip 型，纯标准库 PNG。

用法：python make_test_data.py [输出目录]
  不传则用 $FC_TEST_OUT，再退回 %TEMP%/fakenews-comics。
  之所以支持指定目录：开发实例常常正扫描默认目录（Windows 会锁住 epub/cbz 句柄），
  测试脚本必须能把夹具生成到互不干扰的位置。
"""
import os, struct, sys, zlib, zipfile, shutil, random, tempfile

ROOT = (
    sys.argv[1]
    if len(sys.argv) > 1
    else os.environ.get("FC_TEST_OUT") or os.path.join(os.environ.get("TEMP", "/tmp"), "fakenews-comics")
)
ROOT = os.path.abspath(ROOT)

# 构建中间的临时目录一律用系统临时目录下的独立随机目录，
# 不用写死的 /tmp/_op_build（在 Windows 上会落到盘符根目录，多实例还会互相踩）
def mktmp(tag):
    return tempfile.mkdtemp(prefix=f"fc-{tag}-")

def png(path, w, h, rgb):
    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
    raw = b""
    for y in range(h):
        raw += b"\x00" + bytes(rgb) * w
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)  # truecolor
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(data)

def make_comic(base, ch_count=2, pages=3, w=120, h=170, seed=0):
    rnd = random.Random(seed)
    for ch in range(1, ch_count + 1):
        d = os.path.join(base, f"第{ch:02d}卷")
        os.makedirs(d, exist_ok=True)
        for p in range(1, pages + 1):
            rgb = (rnd.randint(60, 255), rnd.randint(60, 255), rnd.randint(60, 255))
            png(os.path.join(d, f"{p:03d}.png"), w, h, rgb)

if os.path.exists(ROOT):
    try:
        shutil.rmtree(ROOT)
    except PermissionError as e:
        # 句柄被占用（杀软索引 / 仍开着的扫描器）时不再中断：后续写入会覆盖同名文件，
        # 残留项由调用方按需清理——比直接崩掉更难排查的是「什么都没生成」。
        print(f"[warn] 无法完全清空 {ROOT}: {e}", file=sys.stderr)
os.makedirs(ROOT, exist_ok=True)

# 1) folder 型漫画（两本，章数不同，验证自然排序）
c1 = os.path.join(ROOT, "阿飞正传")
make_comic(c1, ch_count=3, pages=4, seed=1)
c2 = os.path.join(ROOT, "格林童话")
make_comic(c2, ch_count=2, pages=3, w=200, h=150, seed=2)  # 横向图（split 候选）

# 2) zip/cbz 型漫画：包内一级目录 = 章（12 章验证 第2章 < 第10章 自然排序）
#    每章用不同颜色/尺寸，便于做「章隔离」的字节级断言
c3 = os.path.join(ROOT, "海贼王")
tmp = mktmp("op-build")
for ch in range(1, 13):
    d = os.path.join(tmp, f"第{ch}章")
    os.makedirs(d, exist_ok=True)
    rgb = (20 + ch * 15, 100, 220 - ch * 12)
    for p in range(1, 3):
        png(os.path.join(d, f"{p:02d}.png"), 60 + ch * 4, 140, rgb)
cbz = os.path.join(ROOT, "海贼王.cbz")
with zipfile.ZipFile(cbz, "w", zipfile.ZIP_DEFLATED) as z:
    for dirpath, _, files in os.walk(tmp):
        for f in files:
            full = os.path.join(dirpath, f)
            z.write(full, os.path.relpath(full, tmp))
shutil.rmtree(tmp)

# 3) 样本文件应被跳过（sample.png 不参与页列表，也不单独成章）
c4 = os.path.join(ROOT, "样张测试")
make_comic(c4, ch_count=1, pages=2, seed=4)
png(os.path.join(c4, "sample.png"), 80, 80, (255, 0, 0))

# 4) 混合结构：顶层散图 + 章目录并存 → 散图单独成章（topOnly），章目录依次在后
#    散图故意不用 sample/preview 命名（那类文件会被当推广图跳过）
c6 = os.path.join(ROOT, "混合结构")
os.makedirs(c6, exist_ok=True)
png(os.path.join(c6, "封面页.png"), 30, 30, (230, 180, 30))
make_comic(c6, ch_count=2, pages=2, w=50, h=70, seed=6)

# 5) 元数据刮削（ComicInfo.xml）：zip 内嵌 + 文件夹内嵌各一份
#    期望：title = Series - Title、author = Writer、description = Summary、
#          tags 含 Genre/Tags 拆分项（扫描后通过 /api/comics 校验）
COMIC_INFO_CBZ = """<?xml version="1.0" encoding="utf-8"?>
<ComicInfo>
  <Series>刮削测试系列</Series>
  <Title>第01卷</Title>
  <Number>1</Number>
  <Writer>测试作者</Writer>
  <Summary>这是一段简介 &amp; 需要正确解码的实体。</Summary>
  <Genre>冒险,奇幻</Genre>
  <Tags>全彩</Tags>
  <Year>2026</Year>
</ComicInfo>
"""
COMIC_INFO_DIR = """<?xml version="1.0" encoding="utf-8"?>
<ComicInfo>
  <Series>目录刮削</Series>
  <Title>单行本</Title>
  <Writer>目录作者</Writer>
  <Summary>目录版简介</Summary>
  <Genre>悬疑</Genre>
</ComicInfo>
"""

# 5a) cbz 内嵌 ComicInfo.xml（根级）
tmp2 = mktmp("op-build2")
for ch in range(1, 3):
    d = os.path.join(tmp2, f"第{ch:02d}卷")
    os.makedirs(d, exist_ok=True)
    for p in range(1, 3):
        png(os.path.join(d, f"{p:03d}.png"), 90, 130, (30 * ch, 120, 200))
open(os.path.join(tmp2, "ComicInfo.xml"), "w", encoding="utf-8").write(COMIC_INFO_CBZ)
with zipfile.ZipFile(os.path.join(ROOT, "刮削测试.cbz"), "w", zipfile.ZIP_DEFLATED) as z:
    for dirpath, _, files in os.walk(tmp2):
        for f in files:
            full = os.path.join(dirpath, f)
            z.write(full, os.path.relpath(full, tmp2))
shutil.rmtree(tmp2)

# 5b) 文件夹内嵌 ComicInfo.xml
c7 = os.path.join(ROOT, "刮削目录")
make_comic(c7, ch_count=1, pages=2, w=100, h=140, seed=7)
open(os.path.join(c7, "ComicInfo.xml"), "w", encoding="utf-8").write(COMIC_INFO_DIR)

# 6) EPUB：页面顺序由 OPF spine 决定（故意与文件名顺序不同，验证按 spine 取页）
#    spine 顺序 = page3, page1, page2；尺寸分别 80/40/60 便于字节级断言
tmp3 = mktmp("op-build3")
os.makedirs(os.path.join(tmp3, "META-INF"), exist_ok=True)
os.makedirs(os.path.join(tmp3, "OEBPS", "images"), exist_ok=True)
open(os.path.join(tmp3, "mimetype"), "w").write("application/epub+zip")
open(os.path.join(tmp3, "META-INF", "container.xml"), "w", encoding="utf-8").write(
    '<?xml version="1.0"?>\n'
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
    '  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n'
    '</container>\n'
)
open(os.path.join(tmp3, "OEBPS", "content.opf"), "w", encoding="utf-8").write(
    '<?xml version="1.0" encoding="utf-8"?>\n'
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">\n'
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
    '    <dc:title>EPUB 测试漫画</dc:title>\n'
    '    <dc:creator>EPUB 作者</dc:creator>\n'
    '    <dc:description>来自 OPF 的简介</dc:description>\n'
    '    <dc:subject>科幻,冒险</dc:subject>\n'
    '  </metadata>\n'
    '  <manifest>\n'
    '    <item id="p1" href="images/page1.png" media-type="image/png"/>\n'
    '    <item id="p2" href="images/page2.png" media-type="image/png"/>\n'
    '    <item id="p3" href="images/page3.png" media-type="image/png"/>\n'
    '  </manifest>\n'
    '  <spine>\n'
    '    <itemref idref="p3"/>\n'
    '    <itemref idref="p1"/>\n'
    '    <itemref idref="p2"/>\n'
    '  </spine>\n'
    '</package>\n'
)
png(os.path.join(tmp3, "OEBPS", "images", "page1.png"), 40, 40, (10, 120, 220))
png(os.path.join(tmp3, "OEBPS", "images", "page2.png"), 60, 60, (30, 180, 120))
png(os.path.join(tmp3, "OEBPS", "images", "page3.png"), 80, 80, (220, 90, 30))
with zipfile.ZipFile(os.path.join(ROOT, "EPUB测试.epub"), "w", zipfile.ZIP_DEFLATED) as z:
    # mimetype 必须首个且不压缩（EPUB 规范）
    z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip")
    for dirpath, _, files in os.walk(tmp3):
        for f in files:
            full = os.path.join(dirpath, f)
            rel = os.path.relpath(full, tmp3).replace(os.sep, "/")
            if rel == "mimetype":
                continue
            z.write(full, rel)
shutil.rmtree(tmp3)

# 7) 隐藏目录应被跳过
c5 = os.path.join(ROOT, ".hidden")
make_comic(c5, ch_count=1, pages=2, seed=5)

print("测试漫画数据就绪:", ROOT)
for d in sorted(os.listdir(ROOT)):
    print(" -", d)
