#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GOTA序列号分割器：加前缀并按指定行数拆分为多个 txt。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

DEFAULT_PREFIX = "serial:YVR:"
DEFAULT_CHUNK = 1000


def normalize_prefix(prefix: str) -> str:
    return prefix.strip()


def transform_line(line: str, prefix: str) -> str | None:
    s = line.strip()
    if not s:
        return None
    if prefix and s.startswith(prefix):
        return s
    return f"{prefix}{s}"


def part_path(out_dir: Path, stem: str, part: int, suffix: str = ".txt") -> Path:
    return out_dir / f"{stem}_{part:03d}{suffix}"


def output_stem_from_input(src: Path) -> str:
    return f"{src.stem}_serial"


def convert_text(
    text: str,
    out_dir: Path,
    chunk_size: int,
    prefix: str = DEFAULT_PREFIX,
    *,
    output_stem: str = "pasted_serial",
) -> tuple[int, list[Path]]:
    """从纯文本内容分割（与 convert_file 相同规则）。"""
    if chunk_size < 1:
        raise ValueError("chunk_size 必须 >= 1")

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = (output_stem or "pasted_serial").strip() or "pasted_serial"

    prefix = normalize_prefix(prefix)
    total = 0
    in_part = 0
    part = 0
    fout = None
    written_files: list[Path] = []

    try:
        for line in text.splitlines():
            out = transform_line(line, prefix)
            if out is None:
                continue

            if in_part == 0:
                part += 1
                path = part_path(out_dir, stem, part)
                fout = path.open("w", encoding="utf-8", newline="\n")
                written_files.append(path)

            assert fout is not None
            fout.write(out + "\n")
            total += 1
            in_part += 1

            if in_part >= chunk_size:
                fout.close()
                fout = None
                in_part = 0
    finally:
        if fout is not None and not fout.closed:
            fout.close()

    return total, written_files


def convert_file(
    src: Path,
    out_dir: Path,
    chunk_size: int,
    prefix: str = DEFAULT_PREFIX,
    *,
    output_stem: str | None = None,
) -> tuple[int, list[Path]]:
    if not src.is_file():
        raise FileNotFoundError(f"源文件不存在: {src}")
    if chunk_size < 1:
        raise ValueError("chunk_size 必须 >= 1")

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = (output_stem or output_stem_from_input(src)).strip()
    if not stem:
        stem = "serial"

    prefix = normalize_prefix(prefix)
    total = 0
    in_part = 0
    part = 0
    fout = None
    written_files: list[Path] = []

    try:
        with src.open("r", encoding="utf-8", errors="replace") as fin:
            for line in fin:
                out = transform_line(line, prefix)
                if out is None:
                    continue

                if in_part == 0:
                    part += 1
                    path = part_path(out_dir, stem, part)
                    fout = path.open("w", encoding="utf-8", newline="\n")
                    written_files.append(path)

                assert fout is not None
                fout.write(out + "\n")
                total += 1
                in_part += 1

                if in_part >= chunk_size:
                    fout.close()
                    fout = None
                    in_part = 0
    finally:
        if fout is not None and not fout.closed:
            fout.close()

    return total, written_files


def main() -> int:
    from tools.bundled_paths import output_dir

    desktop = Path.home() / "Desktop"
    default_in = desktop / "新建文本文档.txt"
    default_out_dir = output_dir("gota")

    parser = argparse.ArgumentParser(
        description=(
            f"GOTA序列号分割器：每行加前缀，每 {DEFAULT_CHUNK} 行拆成一个文件，"
            f"输出到目录（如 <输入名>_serial_001.txt）。"
        )
    )
    parser.add_argument("-i", "--input", type=Path, default=default_in)
    parser.add_argument(
        "-o",
        "--output-dir",
        type=Path,
        default=default_out_dir,
        help="输出目录",
    )
    parser.add_argument("-p", "--prefix", default=DEFAULT_PREFIX)
    parser.add_argument("-n", "--chunk-size", type=int, default=DEFAULT_CHUNK, metavar="N")
    args = parser.parse_args()

    try:
        total, files = convert_file(
            args.input, args.output_dir, args.chunk_size, args.prefix
        )
    except (FileNotFoundError, ValueError) as e:
        print(f"[错误] {e}", file=sys.stderr)
        return 1
    except OSError as e:
        print(f"[错误] 读写失败: {e}", file=sys.stderr)
        return 1

    if total == 0:
        print("[警告] 输入无有效行，未生成文件。")
        return 1

    pfx = normalize_prefix(args.prefix)
    print(f"[完成] 共处理 {total} 行，前缀: {pfx!r}，生成 {len(files)} 个文件")
    print(f"  输入: {args.input}")
    for path in files:
        print(f"  输出: {path}")
    return 0
