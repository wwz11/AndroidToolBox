#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""解析 ADB shell 命令文本（多行剪贴板、含 adb shell 前缀）。"""

from __future__ import annotations

import re

# adb shell … / adb -s SERIAL shell … / adb.exe …
_ADB_SHELL_PREFIX = re.compile(
    r"^adb(?:\.exe)?(?:\s+-s\s+\S+)?\s+shell\s+(.+)$",
    re.IGNORECASE,
)


def normalize_shell_line(line: str) -> str | None:
    """单行：去空白；剥掉 ``adb shell`` 前缀；空行与 # 注释返回 None。"""
    s = line.strip()
    if not s or s.startswith("#"):
        return None
    m = _ADB_SHELL_PREFIX.match(s)
    if m:
        s = m.group(1).strip()
    return s or None


def parse_adb_shell_lines(text: str) -> list[str]:
    """从多行文本解析 shell 命令列表（每行一条，已规范化）。"""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    out: list[str] = []
    for line in normalized.split("\n"):
        cmd = normalize_shell_line(line)
        if cmd is not None:
            out.append(cmd)
    return out
