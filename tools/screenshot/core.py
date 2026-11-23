#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""截图：ADB 设备屏幕。"""

from __future__ import annotations

import struct
import subprocess
import sys
from datetime import datetime
from io import BytesIO
from pathlib import Path
from typing import TYPE_CHECKING

from tools.adb_runtime import adb_subprocess_env, build_adb_cmd
from tools.adb_runtime import _subprocess_kwargs, adb_available, get_ready_devices

if TYPE_CHECKING:
    from PIL.Image import Image as PILImage


def _run_adb_bytes(args: list[str], device: str | None) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        build_adb_cmd(args, device),
        capture_output=True,
        env=adb_subprocess_env(),
        **_subprocess_kwargs(),
    )


def _extract_png_dimensions(raw: bytes) -> tuple[int, int] | None:
    """若 raw 为合法 PNG 流（含 IHDR 块与 IEND 结尾），直接解析宽高，免去完整 PIL 解码。"""
    if (
        len(raw) >= 33
        and raw[:8] == b"\x89PNG\r\n\x1a\n"
        and raw[12:16] == b"IHDR"
        and b"IEND\xaeB`\x82" in raw[-32:]
    ):
        w, h = struct.unpack(">II", raw[16:24])
        if 1 <= w <= 8192 and 1 <= h <= 8192:
            return w, h
    return None


def _parse_screencap_bytes(raw: bytes) -> PILImage:
    """解析 adb exec-out screencap 输出（raw 或 PNG）。"""
    from PIL import Image

    if not raw:
        raise RuntimeError("adb screencap 返回空数据")
    if raw.startswith(b"\x89PNG"):
        img = Image.open(BytesIO(raw))
        img.load()
        return img.convert("RGB")

    if len(raw) < 12:
        raise RuntimeError("screencap 数据过短")

    w, h = struct.unpack("<II", raw[:8])
    if not (1 <= w <= 8192 and 1 <= h <= 8192):
        raise RuntimeError("screencap 尺寸异常")

    rgba_size = w * h * 4
    for skip in (12, 16, 8):
        if len(raw) == skip + rgba_size:
            return Image.frombytes("RGBA", (w, h), raw[skip : skip + rgba_size]).convert("RGB")
    if len(raw) >= 8 + rgba_size:
        return Image.frombytes("RGBA", (w, h), raw[8 : 8 + rgba_size]).convert("RGB")
    raise RuntimeError(f"screencap 格式无法解析 (len={len(raw)}, {w}x{h})")


def screencap_frame_byte_length(buf: bytes, offset: int = 0) -> int | None:
    """从缓冲区开头判断一帧 screencap 的字节长度；数据不足时返回 None。"""
    if len(buf) <= offset:
        return None
    view = memoryview(buf)[offset:]
    if len(view) >= 8 and view[:4] == b"\x89PNG":
        iend = buf.find(b"IEND\xaeB`\x82", offset)
        if iend < 0:
            return None
        return iend + 8 - offset
    if len(view) < 12:
        return None
    w, h = struct.unpack("<II", view[:8])
    if not (1 <= w <= 8192 and 1 <= h <= 8192):
        return None
    rgba_size = w * h * 4
    for skip in (12, 16, 8):
        total = skip + rgba_size
        if len(view) >= total:
            return total
    return None


def capture_adb_screen(device: str | None, *, fast: bool = False) -> PILImage:
    from PIL import Image

    if not adb_available():
        raise RuntimeError("未找到 adb（内置 platform-tools 不可用）")

    args = ["exec-out", "screencap"] if fast else ["exec-out", "screencap", "-p"]
    r = _run_adb_bytes(args, device)
    if r.returncode != 0:
        err = r.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(err or "adb screencap 失败")
    try:
        return _parse_screencap_bytes(r.stdout)
    except RuntimeError:
        if fast:
            r2 = _run_adb_bytes(["exec-out", "screencap", "-p"], device)
            if r2.returncode != 0:
                raise
            img = Image.open(BytesIO(r2.stdout))
            img.load()
            return img.convert("RGB")
        raise


def capture_adb_screen_png_bytes(
    device: str | None, *, fast: bool = False
) -> tuple[bytes, int, int]:
    """抓取设备屏幕并返回 (png_bytes, width, height)。

    当 fast=False 且设备直接输出标准 PNG 字节流时，跳过 PIL 解码与二次 PNG 编码。
    """
    if not fast:
        if not adb_available():
            raise RuntimeError("未找到 adb（内置 platform-tools 不可用）")
        r = _run_adb_bytes(["exec-out", "screencap", "-p"], device)
        if r.returncode != 0:
            err = r.stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(err or "adb screencap 失败")
        dims = _extract_png_dimensions(r.stdout)
        if dims is not None:
            return r.stdout, dims[0], dims[1]
        img = _parse_screencap_bytes(r.stdout)
    else:
        img = capture_adb_screen(device, fast=True)

    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue(), img.width, img.height


def capture_adb_screen_fast(device: str | None) -> PILImage:
    """投屏用：优先 raw screencap，比 PNG 更快。"""
    return capture_adb_screen(device, fast=True)


def default_save_path(prefix: str = "screenshot") -> Path:
    from tools.bundled_paths import output_dir

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return output_dir("screenshots") / f"{prefix}_{ts}.png"


def save_image(img: PILImage, path: Path) -> Path:
    out = Path(path)
    if out.suffix.lower() not in (".png", ".jpg", ".jpeg", ".bmp"):
        out = out.with_suffix(".png")
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, format="PNG")
    return out


def _pil_to_dib_bytes(img: PILImage) -> bytes:
    """PIL Image -> Windows CF_DIB 原始数据（无 BMP 文件头）。"""
    out = BytesIO()
    img.convert("RGB").save(out, format="BMP")
    dib = out.getvalue()[14:]
    out.close()
    if not dib:
        raise RuntimeError("无法生成剪贴板图像数据")
    return dib


def _copy_dib_win32(dib: bytes) -> None:
    import time

    import win32clipboard

    last_err: Exception | None = None
    for _ in range(12):
        try:
            win32clipboard.OpenClipboard()
            try:
                win32clipboard.EmptyClipboard()
                win32clipboard.SetClipboardData(win32clipboard.CF_DIB, dib)
                return
            finally:
                win32clipboard.CloseClipboard()
        except Exception as e:
            last_err = e
            try:
                win32clipboard.CloseClipboard()
            except Exception:
                pass
            time.sleep(0.05)
    raise RuntimeError(f"无法打开剪贴板: {last_err}") from last_err


def _win32_clipboard_apis():
    import ctypes

    kernel32 = ctypes.windll.kernel32
    user32 = ctypes.windll.user32
    kernel32.GlobalAlloc.argtypes = [ctypes.c_uint32, ctypes.c_size_t]
    kernel32.GlobalAlloc.restype = ctypes.c_void_p
    kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalFree.argtypes = [ctypes.c_void_p]
    user32.OpenClipboard.argtypes = [ctypes.c_void_p]
    user32.OpenClipboard.restype = ctypes.c_bool
    user32.EmptyClipboard.restype = ctypes.c_bool
    user32.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
    user32.SetClipboardData.restype = ctypes.c_void_p
    user32.CloseClipboard.restype = ctypes.c_bool
    return kernel32, user32


def _copy_dib_ctypes(dib: bytes) -> None:
    import ctypes
    import time

    CF_DIB = 8
    GMEM_MOVEABLE = 0x0002
    kernel32, user32 = _win32_clipboard_apis()

    opened = False
    for _ in range(12):
        if user32.OpenClipboard(None):
            opened = True
            break
        time.sleep(0.05)
    if not opened:
        err = ctypes.get_last_error()
        raise RuntimeError(f"无法打开剪贴板 (错误码 {err})")

    h_global: int | None = None
    try:
        if not user32.EmptyClipboard():
            raise RuntimeError("无法清空剪贴板")

        size = len(dib)
        h_global = kernel32.GlobalAlloc(GMEM_MOVEABLE, size)
        if not h_global:
            err = ctypes.get_last_error()
            raise RuntimeError(f"GlobalAlloc 失败 (错误码 {err})")

        ptr = kernel32.GlobalLock(ctypes.c_void_p(h_global))
        if not ptr:
            err = ctypes.get_last_error()
            kernel32.GlobalFree(ctypes.c_void_p(h_global))
            h_global = None
            raise RuntimeError(f"GlobalLock 失败 (错误码 {err})")
        try:
            buf = (ctypes.c_char * size).from_address(int(ptr))
            buf[:] = dib
        finally:
            kernel32.GlobalUnlock(ctypes.c_void_p(h_global))

        if not user32.SetClipboardData(CF_DIB, ctypes.c_void_p(h_global)):
            err = ctypes.get_last_error()
            kernel32.GlobalFree(ctypes.c_void_p(h_global))
            h_global = None
            raise RuntimeError(f"SetClipboardData 失败 (错误码 {err})")
        h_global = None
    finally:
        user32.CloseClipboard()
        if h_global is not None:
            kernel32.GlobalFree(ctypes.c_void_p(h_global))


def _copy_image_powershell(img: PILImage) -> None:
    """通过 .NET 写入剪贴板（无 pywin32 时的兜底）。"""
    import os
    import tempfile

    fd, path = tempfile.mkstemp(suffix=".bmp")
    os.close(fd)
    try:
        img.convert("RGB").save(path, format="BMP")
        ps_path = str(Path(path)).replace("'", "''")
        ps = (
            "Add-Type -AssemblyName System.Windows.Forms; "
            "Add-Type -AssemblyName System.Drawing; "
            f"$i=[System.Drawing.Image]::FromFile('{ps_path}'); "
            "[System.Windows.Forms.Clipboard]::SetImage($i); "
            "$i.Dispose()"
        )
        kw = dict(_subprocess_kwargs())
        if hasattr(subprocess, "CREATE_NO_WINDOW"):
            kw["creationflags"] = kw.get("creationflags", 0) | subprocess.CREATE_NO_WINDOW
        r = subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-Command", ps],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            **kw,
        )
        if r.returncode != 0:
            msg = (r.stderr or r.stdout or "PowerShell 失败").strip()
            raise RuntimeError(msg)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def copy_image_to_clipboard(img: PILImage) -> None:
    if sys.platform != "win32":
        raise RuntimeError("复制到剪贴板仅支持 Windows")

    dib = _pil_to_dib_bytes(img)
    errors: list[str] = []

    try:
        _copy_dib_win32(dib)
        return
    except ImportError:
        pass
    except Exception as e:
        errors.append(f"win32clipboard: {e}")

    try:
        _copy_dib_ctypes(dib)
        return
    except Exception as e:
        errors.append(f"ctypes: {e}")

    try:
        _copy_image_powershell(img)
        return
    except Exception as e:
        errors.append(f"PowerShell: {e}")

    detail = "；".join(errors) if errors else "未知错误"
    raise RuntimeError(f"复制到剪贴板失败: {detail}")


def list_devices() -> list[str]:
    return get_ready_devices()


def open_image_file(path: Path) -> Path:
    """用系统默认程序打开图片文件。"""
    import os

    p = Path(path).resolve()
    if not p.is_file():
        raise FileNotFoundError(f"图片不存在: {p}")
    if sys.platform == "win32":
        os.startfile(str(p))
    elif sys.platform == "darwin":
        subprocess.run(["open", str(p)], check=False)
    else:
        subprocess.run(["xdg-open", str(p)], check=False)
    return p
