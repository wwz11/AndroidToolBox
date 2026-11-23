#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""条形码图片生成（基于 python-barcode + Pillow）。"""

from __future__ import annotations

import argparse
import os
import re
import sys
from io import BytesIO
from pathlib import Path
from typing import TYPE_CHECKING, Any

try:
    import barcode
    from barcode.writer import ImageWriter
except ImportError as e:
    raise ImportError("请先安装依赖: pip install python-barcode Pillow") from e

if TYPE_CHECKING:
    from PIL.Image import Image as PILImage

BARCODE_CLASS = "code128"
DEFAULT_FORMAT = "Code128"
SUPPORTED_FORMATS: dict[str, str] = {DEFAULT_FORMAT: BARCODE_CLASS}
_SAFE_NAME = re.compile(r'[<>:"/\\|?*]')

_DEFAULT_WRITER_OPTS = {
    "module_width": 0.35,
    "module_height": 14.0,
    "font_size": 13,
    "text_distance": 4.0,
    "quiet_zone": 4.0,
    "dpi": 200,
    "write_text": True,
}


def _barcode_font_path() -> str | None:
    """打包后 python-barcode 自带 TTF 常丢失，依次回退到系统字体。"""
    try:
        pkg = Path(barcode.__file__).resolve().parent / "fonts" / "DejaVuSansMono.ttf"
        if pkg.is_file():
            return str(pkg)
    except OSError:
        pass
    win_dir = os.environ.get("WINDIR") or r"C:\Windows"
    fonts_dir = Path(win_dir) / "Fonts"
    for name in (
        "consola.ttf",
        "cour.ttf",
        "arial.ttf",
        "calibri.ttf",
        "msyh.ttc",
        "simhei.ttf",
        "simsun.ttc",
    ):
        candidate = fonts_dir / name
        if candidate.is_file():
            return str(candidate)
    return None


def normalize_format(name: str) -> str:
    key = name.strip().lower().replace(" ", "")
    if not name.strip() or key in ("code128", "default"):
        return BARCODE_CLASS
    if key in SUPPORTED_FORMATS or key == BARCODE_CLASS:
        return BARCODE_CLASS
    raise ValueError("仅支持 Code128 条码")


def _safe_filename(text: str, max_len: int = 80) -> str:
    s = _SAFE_NAME.sub("_", text.strip())
    return s[:max_len] if s else "barcode"


def _get_class(code: str):
    try:
        return barcode.get_barcode_class(code)
    except Exception as e:
        raise ValueError(f"条码类型 {code!r} 不可用: {e}") from e


def _build_instance(data: str, fmt: str, writer_opts: dict[str, Any] | None = None):
    text = data.strip()
    if not text:
        raise ValueError("条码内容不能为空")
    code = normalize_format(fmt)
    writer = ImageWriter()
    opts = dict(_DEFAULT_WRITER_OPTS)
    if writer_opts:
        opts.update(writer_opts)
    font = str(opts.get("font_path") or "").strip() or _barcode_font_path()
    if font:
        opts["font_path"] = font
    else:
        opts["write_text"] = False
    writer.set_options(opts)
    return _get_class(code)(text, writer=writer)


def render_barcode_image(
    data: str,
    fmt: str = DEFAULT_FORMAT,
    **writer_opts: Any,
) -> PILImage:
    """在内存中渲染条形码，返回 PIL Image（不写磁盘）。"""
    from PIL import Image

    instance = _build_instance(data, fmt, writer_opts or None)
    buffer = BytesIO()
    instance.write(buffer, options={"format": "PNG"})
    buffer.seek(0)
    img = Image.open(buffer)
    img.load()
    return img.copy()


def generate_barcode(
    data: str,
    output_path: Path,
    fmt: str = DEFAULT_FORMAT,
    **writer_opts: Any,
) -> Path:
    img = render_barcode_image(data, fmt, **writer_opts)
    out = Path(output_path)
    if out.suffix.lower() not in (".png", ".jpg", ".jpeg", ".bmp", ".gif"):
        out = out.with_suffix(".png")
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, format="PNG")
    return out


def _read_lines(path: Path) -> list[str]:
    lines = [
        ln.strip()
        for ln in path.read_text(encoding="utf-8", errors="replace").splitlines()
        if ln.strip()
    ]
    if not lines:
        raise ValueError("输入文件无有效行")
    return lines


def generate_batch(
    lines: list[str],
    out_dir: Path,
    fmt: str = DEFAULT_FORMAT,
    name_from_content: bool = True,
) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    results: list[Path] = []
    for i, line in enumerate(lines, 1):
        name = _safe_filename(line) if name_from_content else f"barcode_{i:04d}"
        path = out_dir / f"{name}.png"
        if path.exists():
            path = out_dir / f"{name}_{i}.png"
        results.append(generate_barcode(line, path, fmt))
    return results


def main() -> int:
    desktop = Path.home() / "Desktop"
    parser = argparse.ArgumentParser(description="生成条形码 PNG 图片")
    parser.add_argument("-d", "--data", help="条码内容（单条）")
    parser.add_argument("-f", "--file", type=Path, help="从 txt 批量生成（每行一条）")
    parser.add_argument("-o", "--output", type=Path, default=desktop / "barcode.png")
    args = parser.parse_args()

    if not args.data and not args.file:
        print("[错误] 请指定 -d 或 -f", file=sys.stderr)
        return 1

    try:
        if args.file:
            lines = _read_lines(args.file)
            out_dir = args.output
            files = generate_batch(lines, Path(out_dir))
            print(f"[完成] 生成 {len(files)} 个文件 → {out_dir}")
        else:
            p = generate_barcode(args.data, args.output)
            print(f"[完成] {p}")
    except (ValueError, OSError, ImportError) as e:
        print(f"[错误] {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
