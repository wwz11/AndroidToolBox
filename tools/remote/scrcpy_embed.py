#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""内嵌 scrcpy 投屏（py-scrcpy-sdk，需 Python 3.10+ 与 av/opencv）。"""

from __future__ import annotations

import importlib
import os
import subprocess
import sys
import threading
from collections.abc import Iterable
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from PIL.Image import Image as PILImage

_EMBED_MARKER = "toolbox_embed_scrcpy.marker"
_last_import_error: str | None = None


def _frozen_bundle_dir() -> str | None:
    if not getattr(sys, "frozen", False):
        return None
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        return str(meipass)
    return str(os.path.join(os.path.dirname(sys.executable), "_internal"))


def _prepare_frozen_dll_paths() -> None:
    base = _frozen_bundle_dir()
    if not base:
        return
    for sub in (".", "av.libs", "numpy.libs", "cv2"):
        path = os.path.join(base, sub)
        if os.path.isdir(path):
            try:
                os.add_dll_directory(path)  # type: ignore[attr-defined]
            except (AttributeError, OSError):
                os.environ["PATH"] = path + os.pathsep + os.environ.get("PATH", "")


def _embed_marker_present() -> bool:
    base = _frozen_bundle_dir()
    if not base:
        return True
    return os.path.isfile(os.path.join(base, _EMBED_MARKER))


def _try_import_embed_modules() -> bool:
    global _last_import_error
    _last_import_error = None
    if sys.version_info < (3, 10):
        return False
    _prepare_frozen_dll_paths()
    for label, mod in (
        ("av", "av"),
        ("cv2", "cv2"),
        ("imageio", "imageio"),
        ("py_scrcpy_sdk", "py_scrcpy_sdk"),
    ):
        try:
            importlib.import_module(mod)
        except ImportError as e:
            _last_import_error = f"{label}: {e}"
            return False
        except OSError as e:
            _last_import_error = f"{label}: {e}"
            return False
    return True


def scrcpy_embed_available() -> bool:
    return _try_import_embed_modules()


def _frozen_app() -> bool:
    return bool(getattr(sys, "frozen", False))


def embed_unavailable_reason() -> str:
    if sys.version_info < (3, 10):
        if _frozen_app():
            return (
                "当前安装包为旧版 Python 运行时，内嵌 scrcpy 需要 3.10+。"
                "请用 Python 3.10+ 重新执行 build.bat 打包。"
            )
        return f"当前 Python {sys.version_info.major}.{sys.version_info.minor}，内嵌 scrcpy 需要 3.10+"
    if _frozen_app() and not _embed_marker_present():
        return (
            "当前安装包未启用内嵌 scrcpy（缺少打包标记）。"
            "请重新执行 build.bat / scripts\\build_desktop.bat，"
            "日志须出现 [OK] Full build with embedded scrcpy"
        )
    if not _try_import_embed_modules():
        detail = _last_import_error or "未知导入错误"
        if _frozen_app():
            return (
                f"内嵌 scrcpy 依赖加载失败（{detail}）。"
                "请关闭 Toolbox 后重新执行 build.bat，"
                "并确认 [OK] Frozen bundle: embedded scrcpy imports OK"
            )
        return (
            f"未安装内嵌 scrcpy 依赖（{detail}）。"
            "请执行 build.bat（需本机 Python 3.10+ 用于打包）"
        )
    return ""


_adb_client_patched = False


def _patch_py_scrcpy_adb() -> None:
    """修复 Windows 下黑框、UTF-8 编码问题，以及 logcat/高负载下 forward 隧道握手竞争与重试缺陷。"""
    global _adb_client_patched
    if _adb_client_patched:
        return

    from random import randint
    import socket
    import time
    import av
    from py_scrcpy_sdk import adb as adb_mod
    from py_scrcpy_sdk import client as client_mod
    from py_scrcpy_sdk.constants import (
        DEVICE_SOCKET_PREFIX,
        SCRCPY_REMOTE_PATH,
        SCRCPY_SERVER_VERSION,
    )
    from py_scrcpy_sdk.errors import ScrcpyError, ScrcpyProtocolError
    from py_scrcpy_sdk.protocol import (
        recv_codec_meta,
        recv_device_name,
        recv_dummy_byte,
        recv_video_packet,
    )

    from tools.adb_runtime import adb_subprocess_env
    from tools.adb_runtime import _subprocess_kwargs

    hide = _subprocess_kwargs()
    env = adb_subprocess_env()

    def ensure_server_noop(self) -> None:
        # 投屏前已通过设备在线检查，无需每次重复启动 adb start-server 子进程
        return

    def popen(self, args: Iterable[str]) -> subprocess.Popen[str]:
        command = self._base() + list(args)
        try:
            return subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=env,
                **hide,
            )
        except FileNotFoundError as exc:
            raise adb_mod.AdbError("adb not found in PATH") from exc

    def run(
        self,
        args: Iterable[str],
        *,
        check: bool = True,
        capture_output: bool = True,
        text: bool = True,
        timeout: float | None = None,
    ) -> subprocess.CompletedProcess[str]:
        command = self._base() + list(args)
        run_kwargs: dict[str, object] = {}
        if text:
            run_kwargs["encoding"] = "utf-8"
            run_kwargs["errors"] = "replace"
        try:
            completed = subprocess.run(
                command,
                check=False,
                capture_output=capture_output,
                text=text,
                timeout=timeout,
                env=env,
                **run_kwargs,
                **hide,
            )
        except FileNotFoundError as exc:
            raise adb_mod.AdbError("adb not found in PATH") from exc
        if check and completed.returncode != 0:
            stderr = (completed.stderr or completed.stdout or "").strip()
            raise adb_mod.AdbError(f"adb command failed: {' '.join(command)}\n{stderr}")
        return completed

    def _connect_forward_socket_patched(
        self, *, expect_dummy_byte: bool = False
    ) -> socket.socket:
        deadline = time.monotonic() + max(float(self.config.connect_timeout), 6.0)
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            sock: socket.socket | None = None
            try:
                sock = socket.create_connection(
                    ("127.0.0.1", self.local_port), timeout=2.0
                )
                if expect_dummy_byte:
                    # 仅在设备端尚未监听、adbd 立即关闭连接 (EOFError) 时重连
                    sock.settimeout(max(1.0, deadline - time.monotonic()))
                    recv_dummy_byte(sock)
                sock.settimeout(None)
                return sock
            except (OSError, EOFError, ScrcpyProtocolError) as exc:
                last_error = exc
                if sock is not None:
                    try:
                        sock.close()
                    except OSError:
                        pass
                if (
                    self.server_process is not None
                    and self.server_process.poll() is not None
                ):
                    logs = "\n".join(self.server_logs)
                    raise ScrcpyError(
                        f"scrcpy server exited before sockets were ready.\n{logs}"
                    ) from exc
                time.sleep(0.05)
        raise ScrcpyError(f"failed to connect to scrcpy socket: {last_error}")

    def _start_server_process_patched(
        self,
        *,
        tunnel_mode: str,
        max_size: int,
        max_fps: int,
        video_bit_rate: int,
        video_encoder: str | None = None,
    ) -> None:
        options = {
            "scid": self.scid_hex,
            "log_level": self.config.log_level,
            "video": "true",
            "audio": "false",
            "control": "true",
            "video_codec": "h264",
            "max_size": str(max_size),
            "video_bit_rate": str(video_bit_rate),
            "max_fps": str(max_fps),
            "clipboard_autosync": "false",
            "cleanup": "true",
            "power_on": "true",
        }
        if video_encoder:
            options["video_encoder"] = video_encoder
        if tunnel_mode == "forward":
            options["tunnel_forward"] = "true"
        args = [
            "shell",
            f"CLASSPATH={SCRCPY_REMOTE_PATH}",
            "app_process",
            "/",
            "com.genymobile.scrcpy.Server",
            SCRCPY_SERVER_VERSION,
        ] + [f"{key}={value}" for key, value in options.items()]
        self.server_logs.clear()
        self.server_process = self.adb.popen(args)
        self.log_thread = threading.Thread(
            target=self._capture_server_logs, name="scrcpy-server-log", daemon=True
        )
        self.log_thread.start()

    def _startup_profiles_patched(self) -> list[dict[str, object]]:
        conservative_size = min(self.config.max_size, 720)
        conservative_fps = min(self.config.max_fps, 20)
        conservative_bitrate = min(self.config.video_bit_rate, 4_000_000)
        primary_mode = "forward" if self.config.prefer_forward else "reverse"
        fallback_mode = "reverse" if primary_mode == "forward" else "forward"
        # Android TV (尤其 Amlogic Android 14-16) 硬件编码器 c2.amlogic.avc.encoder 在虚拟显示下
        # 极易触发 c2-service 连续 SIGSEGV 崩溃重试（阻塞 45 秒以上）。优先使用 Google 标准
        # c2.android.avc.encoder 编码器可将连接时间稳定控制在 ~1 秒内；若旧系统无此编码器则瞬间回退默认编码器。
        return [
            {
                "name": f"{primary_mode} tunnel, c2.android.avc.encoder",
                "tunnel_mode": primary_mode,
                "max_size": self.config.max_size,
                "max_fps": self.config.max_fps,
                "video_bit_rate": self.config.video_bit_rate,
                "video_encoder": "c2.android.avc.encoder",
            },
            {
                "name": f"{primary_mode} tunnel, default encoder",
                "tunnel_mode": primary_mode,
                "max_size": self.config.max_size,
                "max_fps": self.config.max_fps,
                "video_bit_rate": self.config.video_bit_rate,
                "video_encoder": None,
            },
            {
                "name": f"{fallback_mode} tunnel, c2.android.avc.encoder",
                "tunnel_mode": fallback_mode,
                "max_size": conservative_size,
                "max_fps": conservative_fps,
                "video_bit_rate": conservative_bitrate,
                "video_encoder": "c2.android.avc.encoder",
            },
            {
                "name": f"{fallback_mode} tunnel, conservative default",
                "tunnel_mode": fallback_mode,
                "max_size": conservative_size,
                "max_fps": conservative_fps,
                "video_bit_rate": conservative_bitrate,
                "video_encoder": None,
            },
        ]

    def _start_with_profile_patched(self, profile: dict[str, object]) -> None:
        self.scid_hex = f"{randint(0, 0x7FFFFFFF):08x}"
        self.socket_name = f"{DEVICE_SOCKET_PREFIX}_{self.scid_hex}"
        self.local_port = self._pick_free_port()
        self.reader_error = None
        self.latest_frame = None
        self.latest_pts = None
        self.frame_counter = 0

        tunnel_mode = str(profile["tunnel_mode"])
        if tunnel_mode == "forward":
            self.adb.forward(self.local_port, self.socket_name)
            self._tunnel_mode = "forward"
        else:
            self._listen_socket = self._open_server_listener(self.local_port)
            self.adb.reverse(self.socket_name, self.local_port)
            self._tunnel_mode = "reverse"

        _start_server_process_patched(
            self,
            tunnel_mode=tunnel_mode,
            max_size=int(profile["max_size"]),
            max_fps=int(profile["max_fps"]),
            video_bit_rate=int(profile["video_bit_rate"]),
            video_encoder=profile.get("video_encoder"),  # type: ignore[arg-type]
        )

        if tunnel_mode == "forward":
            self.video_socket = _connect_forward_socket_patched(
                self, expect_dummy_byte=True
            )
            self.control_socket = _connect_forward_socket_patched(
                self, expect_dummy_byte=False
            )
        else:
            self.video_socket = self._accept_reverse_socket()
            self.control_socket = self._accept_reverse_socket()

        self.video_socket.settimeout(6.0)
        self.device_name = recv_device_name(self.video_socket)
        self.codec_meta = recv_codec_meta(self.video_socket)
        self.video_socket.settimeout(None)
        self.decoder = av.CodecContext.create(self.codec_meta.codec_name, "r")
        self.decode_thread = threading.Thread(
            target=self._decode_loop, name="scrcpy-decode", daemon=True
        )
        self.decode_thread.start()

    def _decode_loop_patched(self) -> None:
        assert self.video_socket is not None
        assert self.decoder is not None
        pending_config: bytes | None = None
        try:
            while not self.stop_event.is_set():
                packet = recv_video_packet(self.video_socket)
                if packet.is_config:
                    pending_config = packet.payload
                    continue

                payload = packet.payload
                if pending_config:
                    payload = pending_config + payload
                    pending_config = None

                av_packet = av.Packet(payload)
                if packet.pts is not None:
                    av_packet.pts = packet.pts
                    av_packet.dts = packet.pts

                for frame in self.decoder.decode(av_packet):
                    image = frame.to_ndarray(format="bgr24")
                    with self.frame_condition:
                        self.latest_frame = image
                        self.latest_pts = packet.pts
                        self.frame_counter += 1
                        self.frame_condition.notify_all()
        except EOFError:
            if not self.stop_event.is_set():
                logs = " | ".join(list(self.server_logs)[-3:])
                msg = "scrcpy video stream closed by device"
                if logs:
                    msg = f"{msg} ({logs})"
                self.reader_error = ScrcpyError(msg)
                with self.frame_condition:
                    self.frame_condition.notify_all()
        except Exception as exc:
            self.reader_error = exc
            with self.frame_condition:
                self.frame_condition.notify_all()

    orig_cleanup = client_mod.ScrcpyClient._cleanup_runtime

    def _cleanup_runtime_patched(self, *, remove_tunnel: bool) -> None:
        proc = self.server_process
        if proc is not None and proc.poll() is None:
            try:
                proc.kill()
            except Exception:
                pass
        orig_cleanup(self, remove_tunnel=remove_tunnel)

    adb_mod.ADBClient.ensure_server = ensure_server_noop  # type: ignore[method-assign]
    adb_mod.ADBClient.popen = popen  # type: ignore[method-assign]
    adb_mod.ADBClient.run = run  # type: ignore[method-assign]
    client_mod.ScrcpyClient._connect_forward_socket = _connect_forward_socket_patched  # type: ignore[method-assign]
    client_mod.ScrcpyClient._startup_profiles = _startup_profiles_patched  # type: ignore[method-assign]
    client_mod.ScrcpyClient._start_with_profile = _start_with_profile_patched  # type: ignore[method-assign]
    client_mod.ScrcpyClient._decode_loop = _decode_loop_patched  # type: ignore[method-assign]
    client_mod.ScrcpyClient._cleanup_runtime = _cleanup_runtime_patched  # type: ignore[method-assign]
    _adb_client_patched = True


def _resolve_adb_path() -> str:
    from tools.adb_runtime import resolve_adb_exe

    return resolve_adb_exe() or "adb"


class EmbeddedScrcpyMirror:
    """在工具箱预览区内嵌 scrcpy 视频流。"""

    def __init__(
        self,
        device: str,
        *,
        max_size: int = 1280,
        max_fps: int = 30,
        video_bit_rate: int = 6_000_000,
    ) -> None:
        self.device = device
        self.max_size = max_size
        self.max_fps = max_fps
        self.video_bit_rate = video_bit_rate
        self._client = None
        self._lock = threading.Lock()
        self._started = False
        self._last_frame_counter = -1
        self._last_pil: Optional[PILImage] = None

    def start(self) -> None:
        if self._started:
            return
        _patch_py_scrcpy_adb()
        from py_scrcpy_sdk import ScrcpyClient, ScrcpyConfig

        config = ScrcpyConfig(
            serial=self.device,
            adb_path=_resolve_adb_path(),
            max_size=self.max_size,
            max_fps=self.max_fps,
            video_bit_rate=int(self.video_bit_rate),
            verify_server=False,
            prefer_forward=False,
            connect_timeout=6.0,
            frame_timeout=8.0,
        )
        client = ScrcpyClient(config)
        try:
            client.start()
            client.wait_until_ready(timeout=10.0, copy=False)
        except Exception:
            try:
                client.stop()
            except Exception:
                pass
            raise
        with self._lock:
            self._client = client
            self._started = True
            self._last_frame_counter = -1
            self._last_pil = None

    def stop(self) -> None:
        with self._lock:
            client = self._client
            self._client = None
            self._started = False
            self._last_frame_counter = -1
            self._last_pil = None
        if client is not None:
            try:
                client.stop()
            except Exception:
                pass

    @property
    def running(self) -> bool:
        with self._lock:
            return self._started and self._client is not None

    def press_key(self, keycode: int) -> None:
        with self._lock:
            client = self._client
        if client is None:
            raise RuntimeError("内嵌 scrcpy 未启动")
        client.press_key(keycode)

    def get_frame_pil(self, *, timeout: float = 0.08) -> Optional[PILImage]:
        """取一帧；直接等待解码线程条件变量并复用未变化的帧，避免高频创建线程与重复颜色转换。"""
        import cv2
        from PIL import Image

        with self._lock:
            client = self._client
        if client is None:
            return None

        with client.frame_condition:
            if (
                client.frame_counter == self._last_frame_counter
                and not client.reader_error
                and not client.stop_event.is_set()
            ):
                client.frame_condition.wait(timeout=max(timeout, 0.01))
            if client.reader_error:
                raise RuntimeError(f"视频流读取异常: {client.reader_error}") from client.reader_error
            if client.latest_frame is None:
                return self._last_pil
            counter = client.frame_counter
            if counter == self._last_frame_counter and self._last_pil is not None:
                return self._last_pil
            frame = client.latest_frame.copy()

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        pil = Image.fromarray(rgb)
        with self._lock:
            self._last_frame_counter = counter
            self._last_pil = pil
        return pil
