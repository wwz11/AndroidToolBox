#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PC 端 ADB 与设备端 ToolboxAgent APK 联动桥接。"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from tools.adb_runtime import _subprocess_kwargs, adb_subprocess_env, build_adb_cmd

AGENT_PACKAGE = "com.seirobotics.toolboxagent"
AGENT_MAIN_ACTIVITY = f"{AGENT_PACKAGE}/.MainActivity"
AGENT_RECEIVER = f"{AGENT_PACKAGE}/.CommandReceiver"
AGENT_STATE_PATH = f"/sdcard/Android/data/{AGENT_PACKAGE}/files/state.json"
AGENT_LOG_PATH = f"/sdcard/Android/data/{AGENT_PACKAGE}/files/agent.log"

ACTION_START_REBOOT = f"{AGENT_PACKAGE}.ACTION_START_REBOOT"
ACTION_STOP = f"{AGENT_PACKAGE}.ACTION_STOP"
ACTION_RESET = f"{AGENT_PACKAGE}.ACTION_RESET"
ACTION_ENABLE_TCP_ADB = f"{AGENT_PACKAGE}.ACTION_ENABLE_TCP_ADB"


def find_agent_apk(base_dir: Path | None = None) -> Path | None:
    roots: list[Path] = []
    if base_dir:
        roots.append(base_dir)
    roots.append(Path(__file__).resolve().parents[2])
    for r in roots:
        for rel in (
            Path("vendor/apk/ToolboxAgent.apk"),
            Path("android_agent/dist/ToolboxAgent.apk"),
            Path("_internal/vendor/apk/ToolboxAgent.apk"),
        ):
            p = r / rel
            if p.is_file():
                return p
    return None


def _run_adb(sn: str, args: list[str], *, timeout: float = 20.0) -> subprocess.CompletedProcess:
    cmd = build_adb_cmd(args, sn or None)
    return subprocess.run(
        cmd,
        capture_output=True,
        timeout=timeout,
        env=adb_subprocess_env(),
        **_subprocess_kwargs(),
    )


def _out_text(proc: subprocess.CompletedProcess) -> str:
    raw = proc.stdout or b""
    return raw.decode("utf-8", errors="replace").strip()


def is_agent_installed(sn: str) -> bool:
    try:
        proc = _run_adb(sn, ["shell", "pm", "path", AGENT_PACKAGE], timeout=10)
        return proc.returncode == 0 and "package:" in _out_text(proc)
    except Exception:
        return False


def install_and_init_agent(sn: str, *, base_dir: Path | None = None) -> dict[str, Any]:
    apk = find_agent_apk(base_dir)
    if not apk:
        raise FileNotFoundError("未找到 ToolboxAgent.apk，请先运行 python android_agent/build_apk.py")

    proc = _run_adb(sn, ["install", "-r", "-g", str(apk)], timeout=60)
    out = _out_text(proc)
    err = (proc.stderr or b"").decode("utf-8", errors="replace").strip()
    if proc.returncode != 0 and "success" not in out.lower():
        # 部分旧系统不支持 -g
        proc = _run_adb(sn, ["install", "-r", str(apk)], timeout=60)
        out = _out_text(proc)
        err = (proc.stderr or b"").decode("utf-8", errors="replace").strip()
        if proc.returncode != 0 and "success" not in out.lower():
            raise RuntimeError(f"安装 ToolboxAgent.apk 失败: {err or out}")

    # 加入 Doze 白名单 + 解除后台限制 + 拉起一次 Activity（确保可接收 BOOT_COMPLETED）
    _run_adb(sn, ["shell", "dumpsys", "deviceidle", "whitelist", f"+{AGENT_PACKAGE}"], timeout=10)
    _run_adb(sn, ["shell", "cmd", "appops", "set", AGENT_PACKAGE, "RUN_IN_BACKGROUND", "allow"], timeout=10)
    _run_adb(sn, ["shell", "am", "start", "-n", AGENT_MAIN_ACTIVITY], timeout=10)
    return {"ok": True, "apk": str(apk), "status": get_agent_status(sn)}


def get_agent_status(sn: str) -> dict[str, Any]:
    installed = is_agent_installed(sn)
    if not installed:
        return {"installed": False, "state": "NOT_INSTALLED"}

    # 确保服务已拉起（若被系统清理）
    proc = _run_adb(sn, ["shell", "cat", AGENT_STATE_PATH], timeout=10)
    raw = _out_text(proc)
    if proc.returncode != 0 or not raw.startswith("{"):
        _run_adb(sn, ["shell", "am", "start", "-n", AGENT_MAIN_ACTIVITY], timeout=10)
        proc = _run_adb(sn, ["shell", "cat", AGENT_STATE_PATH], timeout=10)
        raw = _out_text(proc)

    data: dict[str, Any] = {"installed": True, "state": "IDLE"}
    if raw.startswith("{"):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                data.update(parsed)
                data["installed"] = True
        except Exception:
            pass
    return data


def start_agent_reboot(
    sn: str,
    *,
    mode: str = "count",
    target_count: int = 10,
    run_hours: float = 1.0,
    stable_sec: int = 15,
) -> dict[str, Any]:
    if not is_agent_installed(sn):
        install_and_init_agent(sn)
    # 先确保 Activity/Service 激活
    _run_adb(sn, ["shell", "am", "start", "-n", AGENT_MAIN_ACTIVITY], timeout=10)
    args = [
        "shell", "am", "broadcast",
        "-a", ACTION_START_REBOOT,
        "-n", AGENT_RECEIVER,
        "--es", "mode", "hours" if mode == "hours" else "count",
        "--ei", "target_count", str(max(1, int(target_count))),
        "--ef", "run_hours", str(max(0.05, float(run_hours))),
        "--ei", "stable_sec", str(max(5, int(stable_sec))),
    ]
    proc = _run_adb(sn, args, timeout=15)
    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"下发设备端压测指令失败: {err or _out_text(proc)}")
    return {"ok": True, "status": get_agent_status(sn)}


def stop_agent_test(sn: str) -> dict[str, Any]:
    if not is_agent_installed(sn):
        return {"ok": True, "status": {"installed": False, "state": "NOT_INSTALLED"}}
    _run_adb(sn, ["shell", "am", "broadcast", "-a", ACTION_STOP, "-n", AGENT_RECEIVER], timeout=10)
    return {"ok": True, "status": get_agent_status(sn)}


def reset_agent_state(sn: str) -> dict[str, Any]:
    if not is_agent_installed(sn):
        return {"ok": True, "status": {"installed": False, "state": "NOT_INSTALLED"}}
    _run_adb(sn, ["shell", "am", "broadcast", "-a", ACTION_RESET, "-n", AGENT_RECEIVER], timeout=10)
    return {"ok": True, "status": get_agent_status(sn)}
