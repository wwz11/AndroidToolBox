#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""eMMC 无界面测试日志会话（并行编排等场景）。"""

from __future__ import annotations

import datetime as dt
import re
import threading
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
        self._lines: list[str] = []
        self._started_at: dt.datetime | None = None

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
        self._lines = header.rstrip("\n").split("\n")
        self._started_at = dt.datetime.now()
        return path

    def append(self, line: str) -> None:
        with self._lock:
            if self._file is None:
                return
            self._file.write(line + "\n")
            self._file.flush()
            self._lines.append(line)

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
            lines = list(self._lines)
            started = self._started_at

        times: list[dt.datetime] = []
        if started is not None:
            times.append(started)

        header_ts = re.compile(r"时间:\s*(\d{4}-\d{2}-\d{2} %H:%M:%S)")
        line_ts = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})")
        for line in lines:
            m = header_ts.search(line) or line_ts.match(line)
            if m:
                try:
                    times.append(dt.datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S"))
                except ValueError:
                    pass
        if len(times) >= 2:
            return max(0.0, (max(times) - min(times)).total_seconds() / 60.0)
        if started is not None:
            return max(0.0, (dt.datetime.now() - started).total_seconds() / 60.0)
        return 0.0

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
