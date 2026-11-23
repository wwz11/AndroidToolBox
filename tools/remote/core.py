#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""虚拟遥控器：ADB 按键 + 投屏。"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from dataclasses import dataclass
from typing import TYPE_CHECKING

from tools.screenshot.core import (
    _parse_screencap_bytes,
    capture_adb_screen_fast,
    screencap_frame_byte_length,
)
from tools.adb_runtime import adb_subprocess_env, build_adb_cmd
from tools.adb_runtime import _subprocess_kwargs, adb_available, get_ready_devices, run_adb

if TYPE_CHECKING:
    from PIL.Image import Image as PILImage


class CaptureAborted(Exception):
    """投屏截屏被主动跳过（兼容旧逻辑）。"""


@dataclass(frozen=True)
class RemoteAction:
    label: str
    kind: str = "key"  # key | netflix | youtube | tv_settings | reboot | wipe
    keycode: int = 0
    hint: str = ""
    confirm: str = ""


KEY_ACTIONS: tuple[RemoteAction, ...] = (
    RemoteAction("主页", "key", 3),
    RemoteAction("返回", "key", 4),
    RemoteAction(
        "设置",
        "tv_settings",
        hint="am start -n com.android.tv.settings/.MainSettings",
    ),
    RemoteAction("上", "key", 19),
    RemoteAction("下", "key", 20),
    RemoteAction("左", "key", 21),
    RemoteAction("右", "key", 22),
    RemoteAction("确定", "key", 23),
    RemoteAction("Enter", "key", 66, hint="KEYCODE_ENTER (66)"),
)

# android.view.KeyEvent — adb shell input keyevent
KEYCODE_BACK = 4
KEYCODE_ENTER = 66  # KEYCODE_ENTER
KEYCODE_DEL = 67  # KEYCODE_DEL

APP_ACTIONS: tuple[RemoteAction, ...] = (
    RemoteAction("Netflix", "netflix", hint="adb am start 启动 Netflix"),
    RemoteAction("YouTube", "youtube", hint="adb am start 启动 YouTube"),
    RemoteAction(
        "格式化",
        "wipe",
        confirm=(
            "将恢复设备出厂设置，所有用户数据将被清除，且不可恢复。\n"
            "请确认设备已连接且具备 root 权限。\n\n确定继续？"
        ),
        hint="恢复出厂（需 root）",
    ),
    RemoteAction(
        "重启",
        "reboot",
        confirm="确定通过 ADB 重启设备？",
        hint="adb reboot",
    ),
)

REMOTE_ACTIONS: tuple[RemoteAction, ...] = KEY_ACTIONS + APP_ACTIONS

_NETFLIX_COMPONENTS = (
    "com.netflix.ninja/.MainActivity",
    "com.netflix.ninja/com.netflix.ninja.MainActivity",
    "com.netflix.mediaclient/com.netflix.mediaclient.ui.launch.UIWebViewActivity",
    "com.netflix.mediaclient/.ui.launch.UIWebViewActivity",
)

_YOUTUBE_COMPONENTS = (
    "com.google.android.youtube.tv/com.google.android.youtube.tv.HomeActivity",
    "com.google.android.youtube.tv/.HomeActivity",
    "com.google.android.youtube/com.google.android.youtube.HomeActivity",
    "com.google.android.youtube/com.google.android.youtube.app.honeycomb.Shell$HomeActivity",
)

_TV_SETTINGS_COMPONENTS = (
    "com.android.tv.settings/.MainSettings",
    "com.android.tv.settings/com.android.tv.settings.MainSettings",
)


def list_devices() -> list[str]:
    return get_ready_devices()


def resolve_scrcpy_exe(explicit: str | None = None) -> str | None:
    """解析 scrcpy 可执行文件：参数 > 环境变量 SCRCPY > PATH。"""
    if explicit:
        p = Path(explicit.strip().strip('"'))
        if p.is_file():
            return str(p.resolve())
        return None
    env = os.environ.get("SCRCPY", "").strip().strip('"')
    if env:
        p = Path(env)
        if p.is_file():
            return str(p.resolve())
    found = shutil.which("scrcpy")
    return found if found else None


def scrcpy_available(explicit: str | None = None) -> bool:
    return resolve_scrcpy_exe(explicit) is not None


def _scrcpy_popen_kwargs(exe: str) -> dict:
    """启动外挂 scrcpy：在其目录运行并显示窗口（勿用 adb 的隐藏窗口参数）。"""
    kwargs: dict = {"cwd": str(Path(exe).resolve().parent)}
    if sys.platform == "win32":
        return kwargs
    return kwargs


def _shell_am_start(device: str | None, component: str) -> None:
    r = run_adb(["shell", "am", "start", "-n", component], device)
    out = (r.stdout or "") + (r.stderr or "")
    if r.returncode != 0 or "Error" in out:
        raise RuntimeError(out.strip() or f"启动失败: {component}")


def _shell_monkey_launch(device: str | None, package: str) -> None:
    r = run_adb(
        [
            "shell",
            "monkey",
            "-p",
            package,
            "-c",
            "android.intent.category.LAUNCHER",
            "1",
        ],
        device,
    )
    out = (r.stdout or "") + (r.stderr or "")
    if r.returncode != 0 or "Error" in out or "No activities" in out:
        raise RuntimeError(out.strip() or f"monkey 启动失败: {package}")


def _package_from_component(component: str) -> str:
    return component.split("/", 1)[0]


def _launch_app_via_adb(device: str | None, components: tuple[str, ...]) -> str:
    """仅用 adb 启动应用：依次 am start，再按包名 monkey 回退。"""
    last_err: Exception | None = None
    for comp in components:
        try:
            _shell_am_start(device, comp)
            return f"am start -n {comp}"
        except Exception as e:
            last_err = e

    tried: set[str] = set()
    for comp in components:
        pkg = _package_from_component(comp)
        if pkg in tried:
            continue
        tried.add(pkg)
        try:
            _shell_monkey_launch(device, pkg)
            return f"monkey -p {pkg}"
        except Exception as e:
            last_err = e

    raise RuntimeError(str(last_err) if last_err else "无法通过 adb 启动应用")


def _perform_factory_wipe(device: str | None) -> str:
    """恢复出厂：adb root 后发送 FACTORY_RESET 广播。"""
    r = run_adb(["root"], device)
    root_out = ((r.stdout or "") + (r.stderr or "")).strip()
    if r.returncode != 0:
        raise RuntimeError(
            root_out or "无法获取 root 权限，请确认设备支持 root 后再试"
        )

    r = run_adb(
        [
            "shell",
            "am",
            "broadcast",
            "-a",
            "android.intent.action.FACTORY_RESET",
            "android",
        ],
        device,
    )
    out = ((r.stdout or "") + (r.stderr or "")).strip()
    if r.returncode != 0 or "Error" in out:
        raise RuntimeError(out or "恢复出厂指令发送失败")

    return "已下发恢复出厂请求"


def perform_remote_action(device: str | None, action: RemoteAction) -> str:
    """执行遥控动作，返回日志说明。"""
    if not adb_available():
        raise RuntimeError("未找到 adb（内置 platform-tools 不可用）")
    if action.kind == "key":
        send_keyevent(device, action.keycode)
        return f"keyevent {action.keycode}"
    if action.kind == "netflix":
        return _launch_app_via_adb(device, _NETFLIX_COMPONENTS)
    if action.kind == "youtube":
        return _launch_app_via_adb(device, _YOUTUBE_COMPONENTS)
    if action.kind == "tv_settings":
        return _launch_app_via_adb(device, _TV_SETTINGS_COMPONENTS)
    if action.kind == "reboot":
        r = run_adb(["reboot"], device)
        if r.returncode != 0:
            err = (r.stderr or r.stdout or "").strip()
            raise RuntimeError(err or "adb reboot 失败")
        return "adb reboot"
    if action.kind == "wipe":
        return _perform_factory_wipe(device)
    raise RuntimeError(f"未知动作: {action.kind}")


def send_keyevent(device: str | None, keycode: int, *, longpress: bool = False) -> None:
    if not adb_available():
        raise RuntimeError("未找到 adb（内置 platform-tools 不可用）")
    args = ["shell", "input", "keyevent"]
    if longpress:
        args.append("--longpress")
    args.append(str(keycode))
    r = run_adb(args, device)
    if r.returncode != 0:
        err = (r.stderr or r.stdout or "").strip()
        raise RuntimeError(err or f"keyevent {keycode} 失败")


def send_text(device: str | None, text: str) -> None:
    if not adb_available():
        raise RuntimeError("未找到 adb")
    if any(ord(ch) > 127 for ch in text):
        import base64
        import shlex

        b64 = base64.b64encode(text.encode("utf-8")).decode("ascii")
        # 优先尝试 ADBKeyboard 广播（支持任意中文/Unicode）
        r_ime = run_adb(
            ["shell", "am", "broadcast", "-a", "ADB_INPUT_B64", "--es", "msg", b64],
            device,
        )
        out_ime = (r_ime.stdout or "").strip()
        if r_ime.returncode == 0 and "result=-1" in out_ime:
            return
        # 回退到系统剪贴板 + 粘贴（Android 10+）
        q_text = shlex.quote(text)
        r_clip = run_adb(
            ["shell", f"cmd clipboard set text {q_text} && input keyevent 279"],
            device,
        )
        if r_clip.returncode == 0:
            return
        raise RuntimeError(
            "设备不支持直接输入中文：请安装 ADBKeyboard 或升级至支持 cmd clipboard 的系统"
        )
    safe = []
    for ch in text:
        if ch == " ":
            safe.append("%s")
        elif ch in ('\\', '%', "'", '"', "&", "|", ";", "<", ">", "(", ")", "$", "`"):
            safe.append("\\" + ch)
        else:
            safe.append(ch)
    payload = "".join(safe)
    r = run_adb(["shell", "input", "text", payload], device)
    if r.returncode != 0:
        err = (r.stderr or r.stdout or "").strip()
        raise RuntimeError(err or "发送文本失败")


_SCRCPY_HELP_CACHE: dict[str, str] = {}


def _scrcpy_help_text(exe: str) -> str:
    if exe not in _SCRCPY_HELP_CACHE:
        try:
            r = subprocess.run(
                [exe, "--help"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=8,
                **_subprocess_kwargs(),
            )
            _SCRCPY_HELP_CACHE[exe] = (r.stdout or "") + (r.stderr or "")
        except Exception:
            _SCRCPY_HELP_CACHE[exe] = ""
    return _SCRCPY_HELP_CACHE[exe]


def _scrcpy_optional_args(exe: str) -> list[str]:
    """按本机 scrcpy 版本附加可选参数（兼容 2.4 与新版）。"""
    help_text = _scrcpy_help_text(exe)
    extra: list[str] = ["--max-fps", "60", "--window-title", "SEIAndroidTVTestToolBox投屏"]
    if "--no-audio" in help_text:
        extra = ["--no-audio", *extra]
    if "--video-buffer" in help_text:
        extra.extend(["--video-buffer", "30"])
    elif "--display-buffer" in help_text:
        extra.extend(["--display-buffer", "30"])
    return extra


def start_scrcpy(
    device: str | None,
    *,
    max_size: int = 0,
    scrcpy_exe: str | None = None,
) -> subprocess.Popen:
    """启动 scrcpy 独立窗口投屏（需已安装 scrcpy）。"""
    exe = resolve_scrcpy_exe(scrcpy_exe)
    if not exe:
        raise RuntimeError(
            "未找到 scrcpy。请指定路径、设置环境变量 SCRCPY，或将 scrcpy 加入 PATH。\n"
            "https://github.com/Genymobile/scrcpy"
        )
    cmd = [exe, "-m", str(max_size), *_scrcpy_optional_args(exe)]
    if device:
        cmd.extend(["-s", device])
    kwargs = _scrcpy_popen_kwargs(exe)
    kwargs["stdout"] = subprocess.PIPE
    kwargs["stderr"] = subprocess.PIPE
    proc = subprocess.Popen(cmd, **kwargs)
    time.sleep(1.0)
    code = proc.poll()
    if code is not None:
        err = ""
        if proc.stderr:
            try:
                err = proc.stderr.read().decode("utf-8", errors="replace").strip()
            except Exception:
                pass
        raise RuntimeError(
            err or f"scrcpy 启动后立即退出 (code {code})\n命令: {' '.join(cmd)}"
        )
    return proc


def _downscale(img: PILImage, max_side: int, *, fast: bool = False) -> PILImage:
    from PIL import Image

    if max_side <= 0 or max(img.size) <= max_side:
        return img
    out = img.copy()
    if hasattr(Image, "Resampling"):
        resample = (
            Image.Resampling.NEAREST if fast else Image.Resampling.BILINEAR
        )
    else:
        resample = Image.NEAREST if fast else Image.BILINEAR
    out.thumbnail((max_side, max_side), resample)
    return out


class ScreencapStream:
    """单条 adb 连接持续输出 screencap，避免每帧重启 adb（内置投屏加速）。"""

    def __init__(self, device: str, *, max_side: int = 720) -> None:
        self.device = device
        self.max_side = max_side
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._latest: PILImage | None = None
        self._generation = 0
        self._frame_event = threading.Event()
        self._proc: subprocess.Popen[bytes] | None = None
        self._thread: threading.Thread | None = None
        self._error: str | None = None
        self._started = threading.Event()

    @property
    def error(self) -> str | None:
        return self._error

    def start(self) -> bool:
        if not adb_available():
            self._error = "未找到 adb"
            return False
        cmd = build_adb_cmd(
            [
                "exec-out",
                "sh",
                "-c",
                "while true; do screencap 2>/dev/null; sleep 0.03; done",
            ],
            self.device,
        )
        try:
            self._proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=0,
                env=adb_subprocess_env(),
                **_subprocess_kwargs(),
            )
        except OSError as e:
            self._error = str(e)
            return False
        self._thread = threading.Thread(target=self._read_loop, daemon=True)
        self._thread.start()
        if not self._started.wait(timeout=5.0):
            self._error = "投屏流启动超时（设备可能不支持连续 screencap）"
            self.stop()
            return False
        return self._error is None

    @staticmethod
    def _resync_buffer(buf: bytearray) -> None:
        """解析失败时丢弃错位数据，减轻花屏。"""
        if not buf:
            return
        candidates = [buf.find(b"\x89PNG"), buf.find(b"\x00\x00\x00")]
        hits = [i for i in candidates if i > 0]
        if hits:
            del buf[: min(hits)]
        elif len(buf) > 256 * 1024:
            del buf[: len(buf) // 2]

    def _read_loop(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        buf = bytearray()
        try:
            while not self._stop.is_set():
                chunk = self._proc.stdout.read(262144)
                if not chunk:
                    break
                buf.extend(chunk)
                while True:
                    n = screencap_frame_byte_length(buf)
                    if n is None:
                        if len(buf) > 48 * 1024 * 1024:
                            del buf[: len(buf) // 2]
                        break
                    frame = bytes(buf[:n])
                    del buf[:n]
                    try:
                        img = _downscale(
                            _parse_screencap_bytes(frame), self.max_side, fast=True
                        )
                        with self._lock:
                            self._latest = img.copy()
                            self._generation += 1
                        self._frame_event.set()
                        if not self._started.is_set():
                            self._started.set()
                    except Exception:
                        self._resync_buffer(buf)
                        continue
        except Exception as e:
            self._error = str(e)
        finally:
            if self._proc and self._proc.poll() is None:
                try:
                    self._proc.terminate()
                except Exception:
                    pass
            if not self._started.is_set():
                self._started.set()

    def is_alive(self) -> bool:
        if self._stop.is_set():
            return False
        if self._proc is None or self._proc.poll() is not None:
            return False
        return self._thread is not None and self._thread.is_alive()

    def wait_frame(self, timeout: float) -> PILImage | None:
        if self._frame_event.wait(timeout):
            self._frame_event.clear()
        return self.get_latest()

    def generation(self) -> int:
        with self._lock:
            return self._generation

    def take_frame(self, last_gen: int) -> tuple[int, PILImage | None]:
        """取新帧（线程安全拷贝）；无新帧时返回 (last_gen, None)。"""
        with self._lock:
            if self._latest is None or self._generation == last_gen:
                return last_gen, None
            return self._generation, self._latest.copy()

    def peek_latest(self) -> PILImage | None:
        """最新帧（只读，勿修改）。"""
        with self._lock:
            return self._latest

    def get_latest(self) -> PILImage | None:
        with self._lock:
            if self._latest is None:
                return None
            return self._latest.copy()

    def stop(self) -> None:
        self._stop.set()
        if self._proc is not None and self._proc.poll() is None:
            try:
                self._proc.terminate()
                self._proc.wait(timeout=1)
            except Exception:
                try:
                    self._proc.kill()
                except Exception:
                    pass
        if self._thread is not None:
            self._thread.join(timeout=1.5)
        self._proc = None
        self._thread = None


class AdbDeviceSession:
    """逐帧 screencap（流模式不可用时的回退方案）。"""

    def __init__(self, device: str) -> None:
        self.device = device

    def capture_frame(self, *, max_side: int = 720) -> PILImage:
        if not adb_available():
            raise RuntimeError("未找到 adb")
        img = capture_adb_screen_fast(self.device)
        return _downscale(img, max_side, fast=True)

    def send_keyevent(self, keycode: int) -> None:
        send_keyevent(self.device, keycode)


def capture_screen_frame(device: str) -> PILImage:
    return AdbDeviceSession(device).capture_frame()


def prepare_mirror_frame(
    img: PILImage,
    max_w: int,
    max_h: int,
    *,
    fast: bool = True,
) -> PILImage:
    """等比缩放至预览区内（完整显示，不裁切）。fast 用较快重采样减轻卡顿。"""
    from PIL import Image

    if max_w < 1 or max_h < 1:
        return img
    w, h = img.size
    if w <= 0 or h <= 0:
        return img
    scale = min(max_w / w, max_h / h)
    if scale <= 0:
        return img
    if abs(scale - 1.0) < 0.01:
        return img
    nw = max(1, int(round(w * scale)))
    nh = max(1, int(round(h * scale)))
    if hasattr(Image, "Resampling"):
        resample = (
            Image.Resampling.BILINEAR if fast else Image.Resampling.LANCZOS
        )
    else:
        resample = Image.BILINEAR if fast else Image.LANCZOS  # type: ignore[attr-defined]
    return img.resize((nw, nh), resample)


def mirror_capture_max_side(display_w: int, display_h: int, *, cap: int = 1920) -> int:
    """adb 截屏边长上限：不小于预览区较短边对应需求，上限 cap。"""
    target = max(display_w, display_h)
    return min(max(target, 480), cap)
