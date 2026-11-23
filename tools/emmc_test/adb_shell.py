#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""eMMC 测试用 adb shell 批命令（直接通过 adb shell stdin 执行，消除 cmd.exe 管道与硬编码行切片脆弱性）。"""

from __future__ import annotations

import re
import subprocess

from tools.adb_runtime import _subprocess_kwargs, adb_subprocess_env, build_adb_cmd

_ADB_SHELL_HEADER_RE = re.compile(
    r"^\s*adb(?:\.exe)?\s+(?:-s\s+(\S+)\s+)?shell\s*$", re.IGNORECASE
)
_LEGACY_SUCCESS_MARKER = "<stdin>[3]: 0: not found"


def string_run_shell(commands: str, *, timeout: float = 300.0) -> list[str]:
    """下发多行 adb shell 命令并返回输出行列表。

    兼容历史入参格式（首行 ``adb -s <sn> shell``，后续为设备端命令，以及 ``$? -ne 0`` 状态判定），
    但不再经过 Windows ``cmd.exe`` 与 ``content[3:-2]`` 切片，避免不同系统区域设置或提示符导致解析错位。
    """
    raw_lines = [ln for ln in (commands or "").splitlines() if ln.strip()]
    if not raw_lines:
        return []

    m = _ADB_SHELL_HEADER_RE.match(raw_lines[0])
    if m:
        sn = m.group(1)
        body_lines: list[str] = []
        for ln in raw_lines[1:]:
            stripped = ln.strip()
            if stripped == "$? -ne 0":
                body_lines.append(
                    f'if [ $? -eq 0 ]; then echo "{_LEGACY_SUCCESS_MARKER}"; '
                    'else echo "command_failed:$?"; fi'
                )
            else:
                body_lines.append(stripped)
        script = "\n".join(body_lines) + "\n"
        cmd = build_adb_cmd(["shell"], sn)
        process = subprocess.Popen(
            cmd,
            shell=False,
            stdout=subprocess.PIPE,
            stdin=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=adb_subprocess_env(),
            **_subprocess_kwargs(),
        )
        try:
            outs, _ = process.communicate(
                script.encode("utf-8", errors="replace"), timeout=timeout
            )
        except subprocess.TimeoutExpired:
            process.kill()
            outs, _ = process.communicate()
        text = outs.decode("utf-8", errors="replace")
        return [line.strip() for line in text.splitlines() if line.strip()]

    # 兜底：非 adb shell 首行的普通命令
    process = subprocess.Popen(
        ["cmd"],
        shell=True,
        stdout=subprocess.PIPE,
        stdin=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=adb_subprocess_env(),
        **_subprocess_kwargs(),
    )
    outs, _errs = process.communicate(commands.encode("gbk", errors="ignore"))
    content = [
        line.strip()
        for line in outs.decode("gbk", errors="ignore").split("\n")
        if line.strip()
    ]
    if len(content) >= 5:
        return content[3:-2]
    return content
