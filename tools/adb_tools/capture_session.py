#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ADB 日志抓取会话目录（桌面 adb_logs 下按次建目录，跨进程持久化）。"""

from __future__ import annotations

import json
import re
import threading
from datetime import datetime
from pathlib import Path

from tools.adb_tools.core import default_log_base_dir, new_capture_session_dir

_LOCK = threading.Lock()
_SESSIONS: dict[str, Path] = {}


def log_root() -> Path:
    root = default_log_base_dir()
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def _state_file() -> Path:
    return log_root() / ".sessions.json"


def _load_persisted() -> dict[str, str]:
    path = _state_file()
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_persisted() -> None:
    try:
        payload = {sn: str(p) for sn, p in _SESSIONS.items() if p is not None}
        _state_file().write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception:
        pass


def _is_under_log_root(path: Path) -> bool:
    try:
        path = path.resolve()
        root = log_root()
        return path == root or root in path.parents
    except Exception:
        return False


def resolve_session_dir(device: str, session_hint: str = "") -> Path | None:
    """校验客户端传入的会话目录（必须在 adb_logs 下且存在）。"""
    hint = (session_hint or "").strip()
    if not hint:
        return None
    try:
        path = Path(hint).expanduser().resolve()
    except Exception:
        return None
    if not path.is_dir():
        return None
    if not _is_under_log_root(path):
        return None
    return path


def get_session(device: str) -> Path | None:
    sn = (device or "").strip()
    if not sn:
        return None
    with _LOCK:
        path = _SESSIONS.get(sn)
        if path is not None and path.is_dir():
            return path
        persisted = _load_persisted().get(sn)
        if persisted:
            p = Path(persisted)
            try:
                if p.is_dir() and _is_under_log_root(p):
                    _SESSIONS[sn] = p.resolve()
                    return _SESSIONS[sn]
            except Exception:
                pass
        return None


def bind_session(device: str, session_dir: Path) -> Path:
    """绑定设备到已有会话目录。"""
    sn = (device or "").strip() or "device"
    path = Path(session_dir).resolve()
    path.mkdir(parents=True, exist_ok=True)
    with _LOCK:
        _SESSIONS[sn] = path
        _save_persisted()
        return path


def ensure_session(
    device: str,
    *,
    force_new: bool = False,
    session_hint: str = "",
) -> Path:
    sn = (device or "").strip() or "device"
    hinted = resolve_session_dir(sn, session_hint)
    if hinted is not None and not force_new:
        return bind_session(sn, hinted)
    with _LOCK:
        if not force_new:
            cur = _SESSIONS.get(sn)
            if cur is not None and cur.is_dir():
                return cur
            persisted = _load_persisted().get(sn)
            if persisted:
                p = Path(persisted)
                try:
                    if p.is_dir() and _is_under_log_root(p):
                        _SESSIONS[sn] = p.resolve()
                        return _SESSIONS[sn]
                except Exception:
                    pass
        path = new_capture_session_dir(log_root(), sn)
        _SESSIONS[sn] = path
        _save_persisted()
        return path


def _safe_name_token(raw: str, *, max_len: int = 40) -> str:
    s = re.sub(r'[<>:"/\\|?*\s]+', "_", (raw or "").strip())
    s = re.sub(r"_+", "_", s).strip("._")
    if not s:
        return ""
    skip = {"默认", "default", "all", "*", "none"}
    if s.lower() in skip or s in skip:
        return ""
    return s[:max_len]


def logcat_filename(
    prefix: str = "logcat",
    *,
    device: str = "",
    buffer: str = "",
    tag: str = "",
    level: str = "",
) -> str:
    """log 抓文件名。

    例：
    - 默认缓冲：logcat_dump_设备_时间戳.txt
    - kernel：logcat_kernel_设备_时间戳.txt
    - 持续 + main：logcat_live_main_设备_时间戳.txt
    """
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    kind = _safe_name_token(prefix, max_len=24) or "logcat"
    buf = _safe_name_token(buffer)

    if kind in ("logcat_dump", "logcat"):
        stem = f"logcat_{buf}" if buf else "logcat_dump"
    elif kind == "logcat_live":
        stem = f"logcat_live_{buf}" if buf else "logcat_live"
    elif kind == "logcat_preview":
        stem = f"logcat_preview_{buf}" if buf else "logcat_preview"
    else:
        stem = f"{kind}_{buf}" if buf else kind

    parts = [stem]
    for token in (device, tag, level):
        t = _safe_name_token(token)
        if t:
            parts.append(t)
    parts.append(ts)
    return "_".join(parts) + ".txt"


def export_filename(prefix: str, *, ext: str = "txt") -> str:
    """会话目录内导出文件名。"""
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe = re.sub(r'[<>:"/\\|?*\s]+', "_", (prefix or "export").strip()) or "export"
    suffix = (ext or "txt").lstrip(".") or "txt"
    return f"{safe}_{ts}.{suffix}"


def session_info(device: str) -> dict:
    sn = (device or "").strip()
    sess = get_session(sn) if sn else None
    return {
        "device": sn,
        "root": str(log_root()),
        "session": str(sess) if sess else "",
        "has_session": bool(sess),
    }
