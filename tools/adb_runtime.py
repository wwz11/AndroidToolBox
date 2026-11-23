#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ADB 运行环境与核心执行原语。

提供：
- ADB 可执行文件解析（优先内置 platform-tools，其次 PATH / 环境变量）
- 子进程执行参数封装（Windows 隐藏控制台窗口）
- 基础 ADB 命令执行 (run_adb) 与设备发现 (get_ready_devices)
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from functools import lru_cache
from pathlib import Path


def _adb_binary_name() -> str:
    return "adb.exe" if sys.platform == "win32" else "adb"


@lru_cache(maxsize=1)
def _search_roots() -> tuple[Path, ...]:
    roots: list[Path] = []
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        roots.append(exe_dir)
        roots.append(exe_dir / "_internal")
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            roots.append(Path(meipass))
    else:
        # tools/adb_runtime.py -> repo root
        roots.append(Path(__file__).resolve().parents[1])
    return tuple(roots)


@lru_cache(maxsize=1)
def resolve_adb_exe() -> str | None:
    """返回 adb 可执行文件绝对路径；找不到时返回 None。"""
    for key in ("TOOLBOX_ADB", "ADB"):
        explicit = os.environ.get(key, "").strip().strip('"')
        if not explicit:
            continue
        p = Path(explicit)
        if p.is_file():
            return str(p.resolve())

    name = _adb_binary_name()
    for root in _search_roots():
        for sub in ("vendor/platform-tools", "platform-tools"):
            candidate = root / sub / name
            if candidate.is_file():
                return str(candidate.resolve())

    return shutil.which("adb")


def adb_subprocess_env() -> dict[str, str]:
    """确保 adb 同目录 DLL（Windows）可被加载。"""
    env = os.environ.copy()
    exe = resolve_adb_exe()
    if exe:
        adb_dir = str(Path(exe).parent)
        env["PATH"] = adb_dir + os.pathsep + env.get("PATH", "")
    return env


def build_adb_cmd(args: list[str], device: str | None) -> list[str]:
    """构造完整 adb 命令行列表。"""
    exe = resolve_adb_exe() or "adb"
    cmd = [exe]
    if device:
        cmd.extend(["-s", device])
    cmd.extend(args)
    return cmd


def _subprocess_kwargs() -> dict:
    """Windows 下隐藏子进程弹出的黑窗口。"""
    if sys.platform != "win32":
        return {}
    kwargs: dict = {"creationflags": subprocess.CREATE_NO_WINDOW}
    si = subprocess.STARTUPINFO()
    si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    si.wShowWindow = subprocess.SW_HIDE
    kwargs["startupinfo"] = si
    return kwargs


def run_adb(
    args: list[str],
    device: str | None,
    *,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    """执行通用 adb 命令并捕获输出。"""
    kw = dict(_subprocess_kwargs())
    if timeout is not None:
        kw["timeout"] = timeout
    return subprocess.run(
        build_adb_cmd(args, device),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=adb_subprocess_env(),
        **kw,
    )


def adb_available() -> bool:
    """检测当前环境中 adb 是否可用。"""
    try:
        return run_adb(["version"], None, timeout=8.0).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _try_restart_adb_server() -> None:
    """尝试重启本地 adb server。"""
    try:
        run_adb(["start-server"], None, timeout=10.0)
    except Exception:
        pass


def list_adb_devices(*, timeout: float = 4.0) -> list[tuple[str, str]]:
    """列出当前所有已识别的 ADB 设备及对应状态 (serial, state)。"""
    r = run_adb(["devices"], None, timeout=timeout)
    out: list[tuple[str, str]] = []
    for raw in r.stdout.splitlines():
        line = raw.strip()
        if not line or line.startswith("List of") or line.startswith("*"):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        serial, state = parts[0], parts[1]
        if serial in ("adb", "daemon") or serial.startswith("*"):
            continue
        out.append((serial, state))
    return out


def get_ready_devices(*, timeout: float = 15.0) -> list[str]:
    """获取所有处于 'device' 就绪状态的序列号列表。"""
    try:
        rows = list_adb_devices(timeout=timeout)
    except subprocess.TimeoutExpired:
        _try_restart_adb_server()
        rows = list_adb_devices(timeout=timeout)
    return [s for s, st in rows if st == "device"]


def pick_device(explicit: str | None) -> str | None:
    """选择目标设备序列号；若只连接了一台则自动选择。"""
    if explicit:
        return explicit
    ready = get_ready_devices()
    if not ready:
        return None
    if len(ready) == 1:
        return ready[0]
    return None


def kill_process_tree(process: subprocess.Popen) -> None:
    """终止进程及其子进程树（防止 Windows 下残留孤儿 adb/scrcpy 子进程）。"""
    if process.poll() is not None:
        return
    if sys.platform == "win32" and process.pid:
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(process.pid)],
                capture_output=True,
                timeout=5,
                **_subprocess_kwargs(),
            )
            return
        except Exception:
            pass
    try:
        process.terminate()
        process.wait(timeout=3)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass


def decode_adb_bytes(raw: bytes | str | None) -> str:
    """解码 ADB 子进程输出字节（优先 UTF-8，回退 GBK / Latin-1）。"""
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw
    for enc in ("utf-8", "gbk", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1", errors="replace")


_decode_adb_bytes = decode_adb_bytes

