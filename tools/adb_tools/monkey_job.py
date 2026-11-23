# -*- coding: utf-8 -*-
"""Android Monkey 压力测试：后台跑 adb shell monkey，可中断。"""

from __future__ import annotations

import re
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from typing import Any

from tools.adb_runtime import adb_subprocess_env, build_adb_cmd
from tools.adb_runtime import adb_available, run_adb

OnLine = Callable[[str], None]


def _subprocess_kwargs() -> dict:
    if sys.platform != "win32":
        return {}
    kwargs: dict = {"creationflags": subprocess.CREATE_NO_WINDOW}
    si = subprocess.STARTUPINFO()
    si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    si.wShowWindow = subprocess.SW_HIDE
    kwargs["startupinfo"] = si
    return kwargs


def build_monkey_shell_line(
    *,
    event_count: int = 10000,
    throttle_ms: int = 300,
    packages: list[str] | None = None,
    seed: int | None = None,
    verbose: int = 1,
    ignore_crashes: bool = True,
    ignore_timeouts: bool = True,
    ignore_security: bool = True,
    kill_process_after: bool = False,
) -> str:
    """拼一条可在 ``adb shell`` 里执行的 monkey 命令。"""
    count = max(1, min(int(event_count), 10_000_000))
    throttle = max(0, min(int(throttle_ms), 60_000))
    parts: list[str] = ["monkey"]
    pkgs = [p.strip() for p in (packages or []) if str(p or "").strip()]
    for p in pkgs[:50]:
        if not re.fullmatch(r"[A-Za-z0-9._]+", p):
            raise ValueError(f"非法包名: {p}")
        parts.extend(["-p", p])
    if seed is not None:
        parts.extend(["-s", str(int(seed))])
    if throttle > 0:
        parts.extend(["--throttle", str(throttle)])
    if ignore_crashes:
        parts.append("--ignore-crashes")
    if ignore_timeouts:
        parts.append("--ignore-timeouts")
    if ignore_security:
        parts.append("--ignore-security-exceptions")
    if kill_process_after:
        parts.append("--kill-process-after-error")
    v = max(0, min(int(verbose), 3))
    if v:
        parts.append("-" + ("v" * v))
    parts.append(str(count))
    return " ".join(parts)


def _monkey_pids_from_ps(text: str) -> list[str]:
    """从 ``ps`` / ``ps -A`` 输出里抽出 monkey 的 PID。"""
    pids: list[str] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        low = line.lower()
        # 进程名常见：com.android.commands.monkey / monkey / app_process …
        if "com.android.commands.monkey" not in low and not re.search(
            r"(?:^|\s)monkey(?:\s|$)", low
        ):
            continue
        if "grep" in low:
            continue
        parts = line.split()
        # ps 列：USER PID PPID ... NAME；少数 ROM 为 PID USER ...
        cand = ""
        if len(parts) >= 2 and parts[1].isdigit():
            cand = parts[1]
        elif parts and parts[0].isdigit():
            cand = parts[0]
        if cand and cand not in pids:
            pids.append(cand)
    return pids


def list_device_monkey_pids(device: str | None) -> list[str]:
    """探测设备上是否已有 monkey 进程，返回 PID 列表。"""
    if not adb_available():
        return []
    sn = (device or "").strip() or None
    found: list[str] = []
    for ps_args in (["shell", "ps", "-A"], ["shell", "ps"]):
        try:
            r = run_adb(ps_args, sn, timeout=8.0)
        except Exception:
            continue
        pids = _monkey_pids_from_ps(r.stdout or "")
        if not pids and r.stderr:
            pids = _monkey_pids_from_ps(r.stderr)
        for pid in pids:
            if pid not in found:
                found.append(pid)
        if found:
            break
    return found


def kill_device_monkey(device: str | None) -> None:
    """尽量结束设备上的 monkey（本机 adb 断开后 monkey 仍可能继续跑）。"""
    if not adb_available():
        return
    sn = (device or "").strip() or None

    # 1) 主机侧解析 ps，再 kill -9（比设备端 pkill/pidof 更稳）
    pids = list_device_monkey_pids(sn)
    for pid in pids:
        for sig in ("-9", "-15"):
            try:
                run_adb(["shell", "kill", sig, pid], sn, timeout=5.0)
            except Exception:
                pass

    # 2) 设备端再兜底几条（均带超时，避免卡死「停止」）
    for script in (
        "killall com.android.commands.monkey 2>/dev/null || true",
        "killall monkey 2>/dev/null || true",
        "pkill -f com.android.commands.monkey 2>/dev/null || true",
        "kill -9 $(pidof com.android.commands.monkey) 2>/dev/null || true",
        "kill -9 $(pidof monkey) 2>/dev/null || true",
        "for p in $(ps -A 2>/dev/null | grep '[m]onkey' | tr -s ' ' | cut -d' ' -f2); "
        "do kill -9 $p 2>/dev/null; done; true",
    ):
        try:
            run_adb(["shell", "sh", "-c", script], sn, timeout=6.0)
        except Exception:
            continue


def _looks_like_network_serial(sn: str) -> bool:
    s = (sn or "").strip()
    if not s or s.startswith("emulator-"):
        return False
    if s.startswith("[") and "]:" in s:
        return True
    if re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}", s):
        return True
    if s.count(":") == 1:
        host, _, port = s.partition(":")
        if host and port.isdigit() and 1 <= int(port) <= 65535:
            return True
    return False


def bounce_adb_device(device: str | None, *, on_line: OnLine | None = None) -> str:
    """断开 ADB 再连上：踢掉卡住的 shell，并尽量让设备回到 online。"""
    sn = (device or "").strip()
    if not sn or not adb_available():
        return ""
    notes: list[str] = []

    def _log(msg: str) -> None:
        notes.append(msg)
        if on_line:
            try:
                on_line(f"[stop] {msg}")
            except Exception:
                pass

    if _looks_like_network_serial(sn):
        try:
            run_adb(["disconnect", sn], None, timeout=8.0)
            _log(f"adb disconnect {sn}")
        except Exception as exc:
            _log(f"disconnect 失败: {exc}")
        time.sleep(0.45)
        try:
            r = run_adb(["connect", sn], None, timeout=15.0)
            out = "\n".join(
                x.strip() for x in (r.stdout or "", r.stderr or "") if x.strip()
            ).strip()
            _log(out or f"adb connect {sn}")
        except Exception as exc:
            _log(f"connect 失败: {exc}")
    else:
        try:
            r = run_adb(["reconnect"], sn, timeout=12.0)
            out = "\n".join(
                x.strip() for x in (r.stdout or "", r.stderr or "") if x.strip()
            ).strip()
            _log(out or f"adb reconnect {sn}")
        except Exception:
            try:
                run_adb(["reconnect", "device"], sn, timeout=12.0)
                _log(f"adb reconnect device {sn}")
            except Exception as exc:
                _log(f"reconnect 失败: {exc}")
        time.sleep(0.5)
        try:
            run_adb(["wait-for-device"], sn, timeout=20.0)
        except Exception:
            pass

    return "；".join(notes) if notes else "已尝试断开重连"


def stop_device_monkey(
    device: str | None,
    *,
    bounce: bool = True,
    on_line: OnLine | None = None,
) -> str:
    """杀 monkey，必要时断开 ADB 再连上（与手工拔线重连效果接近）。"""
    kill_device_monkey(device)
    if not bounce:
        return "已请求结束 monkey"
    msg = bounce_adb_device(device, on_line=on_line)
    # 重连后再补一刀，防止断线瞬间没杀掉
    try:
        kill_device_monkey(device)
    except Exception:
        pass
    return msg or "已停止并重连 ADB"


def run_monkey(
    device: str | None,
    *,
    event_count: int = 10000,
    throttle_ms: int = 300,
    packages: list[str] | None = None,
    seed: int | None = None,
    verbose: int = 1,
    ignore_crashes: bool = True,
    ignore_timeouts: bool = True,
    ignore_security: bool = True,
    kill_process_after: bool = False,
    stop_event: threading.Event | None = None,
    on_line: OnLine | None = None,
) -> dict[str, Any]:
    """同步跑 monkey；stop_event 置位时杀本机 adb 与设备端 monkey。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    sn = (device or "").strip() or None
    shell_line = build_monkey_shell_line(
        event_count=event_count,
        throttle_ms=throttle_ms,
        packages=packages,
        seed=seed,
        verbose=verbose,
        ignore_crashes=ignore_crashes,
        ignore_timeouts=ignore_timeouts,
        ignore_security=ignore_security,
        kill_process_after=kill_process_after,
    )
    cmd = build_adb_cmd(["shell", shell_line], sn)
    if on_line:
        on_line(f"$ adb{' -s ' + sn if sn else ''} shell {shell_line}")

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        env=adb_subprocess_env(),
        **_subprocess_kwargs(),
    )

    lines: list[str] = []
    stopped = False

    def _reader() -> None:
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.rstrip("\r\n")
            lines.append(line)
            if on_line:
                try:
                    on_line(line)
                except Exception:
                    pass
            if len(lines) > 4000:
                del lines[:1000]

    reader = threading.Thread(target=_reader, name="monkey-reader", daemon=True)
    reader.start()

    while True:
        if stop_event is not None and stop_event.is_set():
            stopped = True
            # 先杀 monkey + 断开重连 ADB，再结束本机 adb shell
            try:
                stop_device_monkey(sn, bounce=True, on_line=on_line)
            except Exception:
                try:
                    kill_device_monkey(sn)
                except Exception:
                    pass
            try:
                proc.terminate()
            except Exception:
                pass
            time.sleep(0.35)
            try:
                if proc.poll() is None:
                    proc.kill()
            except Exception:
                pass
            break
        rc = proc.poll()
        if rc is not None:
            break
        time.sleep(0.15)

    try:
        proc.wait(timeout=3)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
    reader.join(timeout=2)
    if stopped:
        try:
            kill_device_monkey(sn)
        except Exception:
            pass

    code = proc.returncode if proc.returncode is not None else -1
    if stopped:
        return {
            "ok": True,
            "stopped": True,
            "returncode": code,
            "message": "已停止 Monkey（已断开并重连 ADB）",
            "command": shell_line,
            "lines_tail": lines[-80:],
        }
    ok = code == 0
    return {
        "ok": ok,
        "stopped": False,
        "returncode": code,
        "message": "Monkey 完成" if ok else f"Monkey 结束（code={code}）",
        "command": shell_line,
        "lines_tail": lines[-80:],
    }
