#!/usr/bin/env python3
"""品牌 logo 流水线（2026-11 最终版）。

唯一真源：docs/logo/fakenews-mark-clean.svg
（由源图反解几何、人工定稿的矢量母版，最终确定版）。

本脚本只负责把它光栅化成各尺寸位图，并写出 tools/logo_source.png，
供 tools/gen_icons.py 继续派生 Web / 桌面 / 应用中心图标。

用法：python tools/logo_rebuild.py
"""
from pathlib import Path

import io

import resvg_py
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC_SVG = ROOT / "docs" / "logo" / "fakenews-mark-clean.svg"
OUT_DIR = ROOT / "docs" / "logo"
SIZES = (1024, 512, 192)


def main():
    if not SRC_SVG.exists():
        raise SystemExit(f"缺少母版：{SRC_SVG}")
    # 去掉 crispEdges，让 resvg 对 18px 圆角等曲线做抗锯齿（45° 直边不受影响）。
    svg = SRC_SVG.read_text(encoding="utf-8").replace('shape-rendering="crispEdges"', "")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        png = resvg_py.svg_to_bytes(svg_string=svg, width=size, height=size)
        img = Image.open(io.BytesIO(bytes(png))).convert("RGB")
        path = OUT_DIR / f"fakenews-mark-clean-{size}.png"
        img.save(path, optimize=True)
        print(f"{path.name:<34} {size}x{size}  {path.stat().st_size / 1024:.1f}KB")
        if size == 1024:
            wp = OUT_DIR / "fakenews-mark-clean-1024.webp"
            img.save(wp, "WEBP", quality=92, method=6)
            print(f"{wp.name:<34} 1024x1024  {wp.stat().st_size / 1024:.1f}KB")
            # 供 gen_icons.py 派生全套位图
            src = ROOT / "tools" / "logo_source.png"
            img.save(src, optimize=True)
            print(f"{src.name:<34} 1024x1024  (gen_icons 源)")


if __name__ == "__main__":
    main()
