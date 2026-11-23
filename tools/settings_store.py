#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""工具箱设置持久化（供 FastAPI sidecar 与核心模块使用，纯 Python 零 GUI 依赖）。"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any, Callable

_LOCK = threading.RLock()
_DATA: dict[str, Any] = {}
_LOADED = False
_DIRTY = False
_FLUSH_HOOKS: list[Callable[[], None]] = []


def config_path() -> Path:
    try:
        from tools.bundled_paths import data_dir

        base = data_dir() / "config"
        base.mkdir(parents=True, exist_ok=True)
        return base / "settings.json"
    except Exception:
        pass
    if sys.platform == "win32":
        local = Path(os.environ.get("LOCALAPPDATA", Path.home()))
        preferred = local / "SEIAndroidTVTestToolBox"
        legacy = local / "Toolbox"
        try:
            if not preferred.exists() and legacy.exists():
                legacy.rename(preferred)
        except OSError:
            if legacy.exists() and not preferred.exists():
                return legacy / "settings.json"
        base = preferred
    else:
        base = Path.home() / ".config" / "sei-android-tv-test-toolbox"
    return base / "settings.json"


def load() -> None:
    global _LOADED
    with _LOCK:
        if _LOADED:
            return
        _LOADED = True
        path = config_path()
        if not path.is_file():
            return
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        if isinstance(raw, dict):
            _DATA.update(raw)


def register_flush_hook(callback: Callable[[], None]) -> None:
    """在写入磁盘前调用（用于多标签等聚合状态）。"""
    _FLUSH_HOOKS.append(callback)


def save() -> None:
    global _DIRTY
    with _LOCK:
        load()
        for hook in _FLUSH_HOOKS:
            try:
                hook()
            except Exception:
                pass
        path = config_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(_DATA, ensure_ascii=False, indent=2) + "\n"
        tmp_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                "w",
                encoding="utf-8",
                dir=str(path.parent),
                prefix=".settings_",
                suffix=".tmp",
                delete=False,
            ) as tf:
                tf.write(payload)
                tmp_path = Path(tf.name)
            os.replace(tmp_path, path)
        except OSError:
            if tmp_path is not None:
                try:
                    tmp_path.unlink(missing_ok=True)
                except OSError:
                    pass
            path.write_text(payload, encoding="utf-8")
        _DIRTY = False


def get(key: str, default: Any = "") -> Any:
    with _LOCK:
        load()
        return _DATA.get(key, default)


def put(key: str, value: Any) -> None:
    global _DIRTY
    with _LOCK:
        load()
        if _DATA.get(key) == value:
            return
        _DATA[key] = value
        _DIRTY = True
        save()


def get_str(key: str, default: str = "") -> str:
    value = get(key, default)
    if value is None:
        return default
    return str(value)


def get_bool(key: str, default: bool = False) -> bool:
    value = get(key, default)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.lower() in ("1", "true", "yes", "on")
    return bool(value)


def get_int(key: str, default: int = 0) -> int:
    value = get(key, default)
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
