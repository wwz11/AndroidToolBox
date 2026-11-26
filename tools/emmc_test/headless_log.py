#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""eMMC 无界面测试日志会话（并行编排等场景）。"""

from __future__ import annotations

import datetime as dt
import re
import threading
from collections import deque
from pathlib import Path

from tools.bundled_paths import app_base_dir as _app_base_dir


def _safe_sn_for_filename(sn: str) -> str:
    safe = re.sub(r"[^\w.-]+", "_", sn.strip())
    return safe or "unknown"


def emmc_logs_dir() -> Path:
    return _app_base_dir() / "logs" / "emmc"


class HeadlessLogSession:
    """每次测试新建 .log 文件，供报告截图等使用。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._file = None
        self.path: Path | None = None
        self._lines: deque[str] = deque(maxlen=500)
        self._started_at: dt.datetime | None = None
        self._last_ts: dt.datetime | None = None

    @property
    def active(self) -> bool:
        return self._file is not None

    def start(self, test_key: str, sn: str, *, title: str) -> Path:
        self.close()
        log_dir = emmc_logs_dir()
        log_dir.mkdir(parents=True, exist_ok=True)
        ts = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
        path = log_dir / f"{test_key}_{_safe_sn_for_filename(sn)}_{ts}.log"
        self.path = path
        self._file = path.open("w", encoding="utf-8", newline="\n")
        header = (
            f"=== {title} ===\n"
            f"时间: {dt.datetime.now():%Y-%m-%d %H:%M:%S}\n"
            f"SN: {sn or '(未指定)'}\n"
            f"{'=' * 40}\n"
        )
        self._file.write(header)
        self._file.flush()
        self._lines = deque(header.rstrip("\n").split("\n"), maxlen=500)
        now = dt.datetime.now()
        self._started_at = now
        self._last_ts = now
        return path

    def append(self, line: str) -> None:
        with self._lock:
            if self._file is None:
                return
            self._file.write(line + "\n")
            self._file.flush()
            self._lines.append(line)
            self._last_ts = dt.datetime.now()

    def read_all(self) -> str:
        with self._lock:
            if self.path is not None and self.path.is_file():
                try:
                    return self.path.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    pass
            if self._lines:
                return "\n".join(self._lines) + "\n"
            return ""

    def elapsed_minutes(self) -> float:
        with self._lock:
            started = self._started_at
            last_ts = self._last_ts
        if started is None:
            return 0.0
        end_ts = last_ts or dt.datetime.now()
        return max(0.0, (end_ts - started).total_seconds() / 60.0)

    def close(self) -> Path | None:
        with self._lock:
            path = self.path
            if self._file is not None:
                try:
                    self._file.close()
                except OSError:
                    pass
                self._file = None
            self.path = None
            return path
