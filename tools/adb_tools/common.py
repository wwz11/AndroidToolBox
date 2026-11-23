#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ADB 工具公共结果模型与输出格式化。"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class AdbShellResult:
    returncode: int
    stdout: str
    stderr: str


@dataclass
class AdbCommandResult:
    label: str
    returncode: int
    output: str
    saved_path: Path | None = None

    @property
    def ok(self) -> bool:
        return self.returncode == 0


def format_adb_raw_output(stdout: str | None, stderr: str | None) -> str:
    """合并 adb 子进程输出，保持与命令行一致（不 strip、不插入 exit 行）。"""
    out = stdout if stdout is not None else ""
    err = stderr if stderr is not None else ""
    if not err:
        return out
    if not out:
        return err
    if err in out:
        return out
    return out + err


def _adb_output_denied(text: str) -> bool:
    """识别 adb/shell 无权限类输出。"""
    raw = text or ""
    low = raw.lower()
    if any(
        s in low
        for s in (
            "permission denied",
            "access denied",
            "operation not permitted",
            "not allowed",
        )
    ):
        return True
    if "权限" in raw and any(s in raw for s in ("拒绝", "不足", "没有", "无")):
        return True
    return False

