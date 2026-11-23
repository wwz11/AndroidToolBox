#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 Toolbox 高清 Windows 图标 (build/assets/toolbox.ico)。

自定义：将 .ico 放到 build/assets/toolbox.custom.ico 后重新运行。
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ASSETS = Path(__file__).resolve().parent
OUT_ICO = ASSETS / "toolbox.ico"
OUT_PNG = ASSETS / "toolbox_256.png"
CUSTOM_ICO = ASSETS / "toolbox.custom.ico"

# tools/ui_theme.py
ACCENT = (47, 111, 237)
ACCENT_HI = (105, 158, 255)
ACCENT_LO = (29, 93, 216)
ACCENT_DEEP = (18, 58, 145)
WHITE = (255, 255, 255)
WHITE_SOFT = (240, 245, 252)
BORDER = (180, 198, 224)
SHADOW = (15, 30, 70, 100)

MASTER = 512
ICO_SIZES = (16, 20, 24, 32, 40, 48, 64, 96, 128, 256)


def _lerp(a: tuple[int, ...], b: tuple[int, ...], t: float) -> tuple[int, ...]:
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def _vertical_gradient(size: tuple[int, int], top: tuple[int, ...], bottom: tuple[int, ...]) -> Image.Image:
    w, h = size
    strip = Image.new("RGB", (1, h))
    px = strip.load()
    for y in range(h):
        px[0, y] = _lerp(top, bottom, y / max(h - 1, 1))[:3]
    return strip.resize(size, Image.Resampling.BICUBIC).convert("RGBA")


def _rounded_mask(size: int, radius: float, margin: float = 0.0) -> Image.Image:
    m = int(size * margin)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((m, m, size - m - 1, size - m - 1), radius=radius, fill=255)
    return mask


def _draw_master(size: int = MASTER) -> Image.Image:
    """圆角 App 图标：蓝底 + 白色工具箱（盖/提手/三格）。"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    s = size / 512.0

    def sc(v: float) -> int:
        return int(round(v * s))

    pad = sc(40)
    outer_r = sc(108)
    cx = size // 2

    # 阴影
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (pad + sc(4), pad + sc(8), size - pad + sc(4), size - pad + sc(8)),
        radius=outer_r,
        fill=SHADOW,
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=max(2, sc(16))))
    img = Image.alpha_composite(img, shadow)

    # 蓝色圆角底
    bg_mask = _rounded_mask(size, outer_r, margin=pad / size)
    bg = _vertical_gradient((size, size), ACCENT_HI, ACCENT_DEEP)
    gloss = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(gloss).rounded_rectangle(
        (pad, pad, size - pad, pad + sc(200)),
        radius=outer_r,
        fill=(255, 255, 255, 48),
    )
    bg = Image.alpha_composite(bg, gloss)
    bg.putalpha(bg_mask)
    img = Image.alpha_composite(img, bg)

    draw = ImageDraw.Draw(img)

    # 工具箱外轮廓（白）
    box_l = sc(108)
    box_r = size - sc(108)
    lid_top = sc(118)
    lid_bot = sc(228)
    body_bot = sc(392)

    # 箱体
    draw.rounded_rectangle(
        (box_l, lid_bot - sc(6), box_r, body_bot),
        radius=sc(20),
        fill=WHITE + (255,),
        outline=BORDER + (255,),
        width=max(1, sc(3)),
    )

    # 箱盖（略亮）
    draw.rounded_rectangle(
        (box_l - sc(4), lid_top, box_r + sc(4), lid_bot),
        radius=sc(22),
        fill=WHITE_SOFT + (255,),
        outline=WHITE + (255,),
        width=max(1, sc(2)),
    )
    draw.rounded_rectangle(
        (box_l, lid_top + sc(8), box_r, lid_bot - sc(4)),
        radius=sc(18),
        fill=WHITE + (255,),
    )

    # 盖高光
    draw.rounded_rectangle(
        (box_l + sc(16), lid_top + sc(14), box_r - sc(16), lid_top + sc(36)),
        radius=sc(10),
        fill=(255, 255, 255, 200),
    )

    # 提手
    hw, hh = sc(96), sc(24)
    hx0 = cx - hw // 2
    hy0 = lid_top + sc(52)
    draw.rounded_rectangle(
        (hx0, hy0, hx0 + hw, hy0 + hh),
        radius=hh // 2,
        fill=ACCENT_LO + (255,),
        outline=WHITE + (255,),
        width=max(1, sc(2)),
    )
    draw.rounded_rectangle(
        (hx0 + sc(8), hy0 + sc(5), hx0 + hw - sc(8), hy0 + hh - sc(5)),
        radius=hh // 2,
        fill=ACCENT_HI + (255,),
    )

    # 锁扣
    lw = sc(18)
    draw.rounded_rectangle(
        (cx - lw, lid_bot - sc(6), cx + lw, lid_bot + sc(14)),
        radius=sc(5),
        fill=ACCENT + (255,),
    )

    # 三格抽屉（象征多工具）
    slot_l = box_l + sc(28)
    slot_r = box_r - sc(28)
    y0 = lid_bot + sc(28)
    slot_h = sc(44)
    gap = sc(12)
    for i, col in enumerate((ACCENT, ACCENT_HI, ACCENT_LO)):
        y = y0 + i * (slot_h + gap)
        draw.rounded_rectangle(
            (slot_l, y, slot_r, y + slot_h),
            radius=sc(12),
            fill=col + (255,),
        )
        draw.rounded_rectangle(
            (slot_l + sc(12), y + sc(8), slot_r - sc(12), y + sc(16)),
            radius=sc(6),
            fill=(255, 255, 255, 80),
        )
        # 拉手凹槽
        draw.rounded_rectangle(
            (cx - sc(20), y + slot_h - sc(14), cx + sc(20), y + slot_h - sc(6)),
            radius=sc(4),
            fill=ACCENT_DEEP + (255,),
        )

    return img


def _downscale(master: Image.Image, size: int) -> Image.Image:
    if size >= master.width:
        return master.resize((size, size), Image.Resampling.LANCZOS)
    scale = max(2, min(4, master.width // max(size, 1)))
    mid = master.resize((size * scale, size * scale), Image.Resampling.LANCZOS)
    return mid.resize((size, size), Image.Resampling.LANCZOS)


def generate_default_ico(path: Path) -> None:
    master = _draw_master(MASTER)
    path.parent.mkdir(parents=True, exist_ok=True)
    img256 = _downscale(master, 256).convert("RGBA")
    img256.save(OUT_PNG, format="PNG", optimize=True)
    img256.save(path, format="ICO", sizes=[(s, s) for s in ICO_SIZES])


def main() -> int:
    if CUSTOM_ICO.is_file():
        shutil.copy2(CUSTOM_ICO, OUT_ICO)
        print(f"[icon] Using custom: {CUSTOM_ICO.name} -> {OUT_ICO.name}")
        return 0
    generate_default_ico(OUT_ICO)
    print(f"[icon] Generated HD icon: {OUT_ICO} ({OUT_ICO.stat().st_size} bytes)")
    print(f"[icon] Preview: {OUT_PNG}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
