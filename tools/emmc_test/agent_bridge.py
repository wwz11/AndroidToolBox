#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PC 端 ADB 与设备端 ToolboxAgent APK 联动桥接。"""

from __future__ import annotations

import hashlib
import json
import subprocess
import time
from pathlib import Path
from typing import Any

from tools.adb_runtime import _subprocess_kwargs, adb_subprocess_env, build_adb_cmd

AGENT_PACKAGE = "com.seirobotics.toolboxagent"
AGENT_MAIN_ACTIVITY = f"{AGENT_PACKAGE}/.MainActivity"
AGENT_RECEIVER = f"{AGENT_PACKAGE}/.CommandReceiver"
AGENT_STATE_PATH = f"/sdcard/Android/data/{AGENT_PACKAGE}/files/state.json"
AGENT_LOG_PATH = f"/sdcard/Android/data/{AGENT_PACKAGE}/files/agent.log"
AGENT_APK_HASH_PATH = f"/sdcard/Android/data/{AGENT_PACKAGE}/files/apk.sha256"

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


def _local_apk_sha256(apk: Path) -> str:
    return hashlib.sha256(apk.read_bytes()).hexdigest()[:16]


def _needs_agent_install(sn: str, *, base_dir: Path | None = None) -> bool:
    if not is_agent_installed(sn):
        return True
    apk = find_agent_apk(base_dir)
    if not apk:
        return False
    expected = _local_apk_sha256(apk)
    try:
        proc = _run_adb(sn, ["shell", "cat", AGENT_APK_HASH_PATH], timeout=8)
        if proc.returncode != 0:
            return True
        return _out_text(proc) != expected
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

    # 加入 Doze 白名单 + 解除后台限制 + 允许后台拉起界面 + 拉起一次 Activity
    _run_adb(sn, ["shell", "dumpsys", "deviceidle", "whitelist", f"+{AGENT_PACKAGE}"], timeout=10)
    _run_adb(sn, ["shell", "cmd", "appops", "set", AGENT_PACKAGE, "RUN_IN_BACKGROUND", "allow"], timeout=10)
    _run_adb(sn, ["shell", "cmd", "appops", "set", AGENT_PACKAGE, "SYSTEM_ALERT_WINDOW", "allow"], timeout=10)
    _run_adb(sn, ["shell", "am", "start", "-n", AGENT_MAIN_ACTIVITY], timeout=10)
    time.sleep(1.0)
    try:
        expected = _local_apk_sha256(apk)
        _run_adb(
            sn,
            ["shell", f"mkdir -p /sdcard/Android/data/{AGENT_PACKAGE}/files && printf '%s' '{expected}' > {AGENT_APK_HASH_PATH}"],
            timeout=8,
        )
    except Exception:
        pass
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
    stable_sec: int = 30,
) -> dict[str, Any]:
    if _needs_agent_install(sn):
        install_and_init_agent(sn)
    # 先确保 Activity/Service 激活
    _run_adb(sn, ["shell", "am", "start", "-n", AGENT_MAIN_ACTIVITY], timeout=10)
    args = [
        "shell", "am", "broadcast",
        "-a", ACTION_START_REBOOT,
        "-n", AGENT_RECEIVER,
        "--es", "mode", "hours" if mode == "hours" else "count",
        "--ei", "target_count", str(max(1, int(target_count))),
        "--ef", "run_hours", str(max(1.0 / 60.0, float(run_hours))),
        "--ei", "stable_sec", str(max(5, int(stable_sec))),
    ]
    proc = _run_adb(sn, args, timeout=15)
    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"下发设备端压测指令失败: {err or _out_text(proc)}")
    # 等待 APK 将 state.json 刷新为 RUNNING（避免读取到上一轮遗留的 COMPLETED/FAILED）
    for _ in range(10):
        st = read_agent_state_fast(sn)
        if st and st.get("state") == "RUNNING" and int(st.get("current_round") or 0) == 0:
            return {"ok": True, "status": st}
        time.sleep(0.5)
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


def sync_agent_on_reboot_start(
    sn: str,
    *,
    mode: str,
    target_count: int,
    run_hours: float,
    stable_sec: int = 30,
) -> bool:
    """若设备已安装 ToolboxAgent，同步启动设备端状态记录与电视端展示。"""
    try:
        if not is_agent_installed(sn):
            return False
        start_agent_reboot(
            sn,
            mode=mode,
            target_count=target_count,
            run_hours=run_hours,
            stable_sec=stable_sec,
        )
        return True
    except Exception:
        return False


def sync_agent_on_reboot_end(sn: str, *, wait_sec: float = 60.0) -> bool:
    """PC 端 Reboot 测试结束/用户点击停止时，同步停止设备端 Agent 压测状态。

    若恰好在设备重启（ADB 离线）瞬间点击停止，会在 wait_sec 内等待 ADB 恢复并下发 ACTION_STOP，
    避免设备开机后继续自主重启。
    """
    deadline = time.monotonic() + max(0.0, wait_sec)
    while True:
        try:
            proc = _run_adb(
                sn,
                ["shell", "am", "broadcast", "-a", ACTION_STOP, "-n", AGENT_RECEIVER],
                timeout=8,
            )
            if proc.returncode == 0:
                return True
        except Exception:
            pass
        if time.monotonic() >= deadline:
            return False
        from tools.emmc_test.ota_v5 import reconnect_adb
        from tools.adb_runtime import resolve_adb_exe

        reconnect_adb(sn, resolve_adb_exe() or "adb")
        time.sleep(2.0)


_REBOOT_REQ_PATH = f"/sdcard/Android/data/{AGENT_PACKAGE}/files/reboot.req"


def ensure_device_reboot_daemon(sn: str) -> None:
    """在 userdebug 设备端拉起轻量化 shell 守护，监听 APK 写入的 reboot.req 并以 shell/su 权限执行重启。"""
    script = (
        "pgrep -f toolbox_rebootd >/dev/null 2>&1 || "
        f"nohup sh -c 'exec -a toolbox_rebootd sh -c \""
        f"while true; do "
        f"if [ -f {_REBOOT_REQ_PATH} ]; then "
        f"rm -f {_REBOOT_REQ_PATH}; "
        f"/system/xbin/su 0 reboot 2>/dev/null || reboot; "
        f"exit 0; "
        f"fi; "
        f"sleep 1; "
        f"done\"' </dev/null >/dev/null 2>&1 &"
    )
    try:
        _run_adb(sn, ["shell", script], timeout=8)
    except Exception:
        pass


def read_agent_state_fast(sn: str) -> dict[str, Any] | None:
    """非阻塞读取设备端 APK 的 state.json；ADB 断连或读取失败时返回 None。"""
    try:
        proc = _run_adb(sn, ["shell", "cat", AGENT_STATE_PATH], timeout=6)
    except Exception:
        return None
    if proc.returncode != 0:
        return None
    raw = _out_text(proc)
    if not raw.startswith("{"):
        return None
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


def ensure_agent_alive(sn: str) -> bool:
    """若设备 ADB 在线但 APK 进程已退出，通过 ADB 拉起 AgentService/MainActivity。返回是否执行了拉起。"""
    try:
        proc = _run_adb(sn, ["shell", "pidof", AGENT_PACKAGE], timeout=6)
        if proc.returncode == 0 and _out_text(proc).strip():
            return False
    except Exception:
        return False

    try:
        _run_adb(
            sn,
            [
                "shell", "am", "start-foreground-service",
                "-n", f"{AGENT_PACKAGE}/.AgentService",
                "-a", f"{AGENT_PACKAGE}.INTERNAL_BOOT",
            ],
            timeout=10,
        )
        _run_adb(sn, ["shell", "am", "start", "-n", AGENT_MAIN_ACTIVITY], timeout=10)
        return True
    except Exception:
        return False
