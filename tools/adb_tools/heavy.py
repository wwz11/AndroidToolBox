#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""占用 ADB/USB 的长时间操作（安装 APK 等），供投屏降速、避免误判断开。"""

from __future__ import annotations

import threading
from contextlib import contextmanager
from typing import Iterator

_lock = threading.Lock()
_count = 0
_reasons: dict[str, int] = {}


def adb_heavy_busy() -> bool:
    with _lock:
        return _count > 0


def adb_heavy_reason() -> str:
    with _lock:
        if not _reasons:
            return ""
        return next(iter(_reasons))


@contextmanager
def adb_heavy_op(reason: str = "install") -> Iterator[None]:
    global _count
    key = (reason or "install").strip() or "install"
    with _lock:
        _count += 1
        _reasons[key] = _reasons.get(key, 0) + 1
    try:
        yield
    finally:
        with _lock:
            _count = max(0, _count - 1)
            left = _reasons.get(key, 1) - 1
            if left <= 0:
                _reasons.pop(key, None)
            else:
                _reasons[key] = left
