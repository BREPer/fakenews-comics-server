#!/usr/bin/env python3
"""从 tools/logo_source.png（1024px 满幅方图，由 docs/logo/fakenews-mark-clean.svg
光栅化得到）生成全部位图图标。

两种外形，沿用旧规则：
  - 圆角透明：ICON.PNG / ICON_256.PNG / app/ui/images/icon_*（桌面与 fpk 应用中心）
  - 满幅方图：pwa-* / apple-touch-icon / favicon（iOS/Android 会自己套遮罩，
    给它们透明角反而会露出黑底）

源图是满幅橙色方图（无留白、无透明），圆角遮罩只裁外圈橙色，不会碰到内部
白色标记 / 灰色折面；边缘填充步骤保留以防缩放产生发丝级透明边。

用法：python tools/gen_icons.py
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import binary_erosion, distance_transform_edt

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "tools" / "logo_source.png"

# 2026-11 最终版：满幅方图，橙色铺满整张 1024 画板（无留白、无透明）。
# 圆角只裁在外圈橙色上，不会碰到内部白色标记 / 灰色折面。
LEFT, RIGHT, TOP, BOTTOM = 0.0, 1024.0, 0.0, 1024.0
R_TL, R_TR, R_BL, R_BR = 192.0, 192.0, 192.0, 192.0
CROP = (0, 0, 1024, 1024)  # 整幅
SS = 4  # 遮罩超采样倍数

ROUNDED = [
    ("ICON.PNG", 256),
    ("ICON_256.PNG", 256),
    ("app/ui/images/icon_48.png", 48),
    ("app/ui/images/icon_64.png", 64),
    ("app/ui/images/icon_128.png", 128),
    ("app/ui/images/icon_256.png", 256),
    ("app/ui/images/icon_512.png", 512),
    ("app/web/public/logo.png", 192),
]
SQUARE = [
    ("app/web/public/pwa-192.png", 192),
    ("app/web/public/pwa-512.png", 512),
    ("app/web/public/apple-touch-icon.png", 180),
]
WEBP = ("app/web/public/logo.webp", 192)
ICO = ("app/web/public/favicon.ico", 48)


def rounded_mask(size):
    """圆角矩形遮罩；四角半径不同，用两个矩形 + 四个圆求并集。"""
    w_img = Image.new("L", (size * SS, size * SS), 0)
    d = ImageDraw.Draw(w_img)
    k = SS
    x0, y0 = (LEFT - CROP[0]) * k, (TOP - CROP[1]) * k
    x1, y1 = (RIGHT - CROP[0]) * k, (BOTTOM - CROP[1]) * k
    rtl, rtr, rbl, rbr = (r * k for r in (R_TL, R_TR, R_BL, R_BR))
    d.rectangle([x0 + max(rtl, rbl), y0, x1 - max(rtr, rbr), y1], fill=255)
    d.rectangle([x0, y0 + max(rtl, rtr), x1, y1 - max(rbl, rbr)], fill=255)
    for cx, cy, r in (
        (x0 + rtl, y0 + rtl, rtl),
        (x1 - rtr, y0 + rtr, rtr),
        (x0 + rbl, y1 - rbl, rbl),
        (x1 - rbr, y1 - rbr, rbr),
    ):
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    return w_img.resize((size, size), Image.LANCZOS)


def main():
    src = Image.open(SRC).convert("RGB")
    if src.size != (1024, 1024):
        raise SystemExit(f"logo_source.png 应为 1024x1024，实际 {src.size}")
    canvas = src.crop(CROP)
    w, h = canvas.size
    assert w == h

    # 遮罩（crop 坐标系）：整体平移 CROP 起点
    mask = rounded_mask(w)
    # 源图轮廓有 1~2px 与白底混合的抗锯齿，多腐蚀几像素再取色，避免图标边缘发白
    interior = binary_erosion(np.asarray(mask) > 127, structure=np.ones((3, 3)), iterations=4)
    _, idx = distance_transform_edt(~interior, return_indices=True)
    arr = np.asarray(canvas)
    filled = arr[idx[0], idx[1]]

    rgb = Image.fromarray(filled)
    alpha = mask

    def rounded_at(size):
        r = rgb.resize((size, size), Image.LANCZOS)
        a = alpha.resize((size, size), Image.LANCZOS)
        return Image.merge("RGBA", (*r.split(), a))

    def square_at(size):
        return rgb.resize((size, size), Image.LANCZOS)

    for rel, size in ROUNDED:
        img = rounded_at(size)
        out = ROOT / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        img.save(out, optimize=True)
        print(f"{rel:<40} {size}x{size}  {out.stat().st_size / 1024:.1f}KB")

    rel, size = WEBP
    out = ROOT / rel
    rounded_at(size).save(out, "WEBP", quality=90, method=6)
    print(f"{rel:<40} {size}x{size}  {out.stat().st_size / 1024:.1f}KB")

    for rel, size in SQUARE:
        img = square_at(size)
        out = ROOT / rel
        img.save(out, optimize=True)
        print(f"{rel:<40} {size}x{size}  {out.stat().st_size / 1024:.1f}KB")

    rel, size = ICO
    out = ROOT / rel
    square_at(size).save(out, sizes=[(16, 16), (32, 32), (48, 48)])
    print(f"{rel:<40} 16/32/48  {out.stat().st_size / 1024:.1f}KB")


if __name__ == "__main__":
    main()
