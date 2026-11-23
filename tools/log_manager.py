#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""日志目录管理与自动轮转清理。

功能：
- 扫描 userdata/logs 目录，统计日志文件数量、体积与分类占比。
- 自动清理过期日志（按天数，如 >14 天）。
- 磁盘容量保护：当日志总占用超过阈值（如 >500MB），按最旧时间优先删除。
- 异常安全保护：正在被 ADB 或测试占用的日志文件自动跳过，不阻断主流程。
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from tools.bundled_paths import logs_dir

logger = logging.getLogger("toolbox.log_manager")


@dataclass
class LogFileInfo:
    path: Path
    size: int
    mtime: float


def _format_size(size_bytes: int) -> str:
    """人类可读的文件大小格式化。"""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.2f} KB"
    elif size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.2f} MB"
    return f"{size_bytes / (1024 * 1024 * 1024):.2f} GB"


def collect_log_files(root: Path | None = None) -> list[LogFileInfo]:
    """递归收集日志目录下所有的文件元数据。"""
    base = root or logs_dir()
    if not base.exists():
        return []

    files: list[LogFileInfo] = []
    for p in base.rglob("*"):
        if p.is_file():
            try:
                st = p.stat()
                files.append(LogFileInfo(path=p, size=st.st_size, mtime=st.st_mtime))
            except (OSError, PermissionError):
                continue
    return files


def get_logs_stats(root: Path | None = None) -> dict[str, Any]:
    """返回日志目录的健康状态与占用分布。"""
    base = root or logs_dir()
    files = collect_log_files(base)

    total_bytes = sum(f.size for f in files)
    total_count = len(files)

    # 按一级子目录分类统计
    sub_stats: dict[str, dict[str, Any]] = {}
    oldest_mtime = None
    newest_mtime = None

    for f in files:
        if oldest_mtime is None or f.mtime < oldest_mtime:
            oldest_mtime = f.mtime
        if newest_mtime is None or f.mtime > newest_mtime:
            newest_mtime = f.mtime

        try:
            rel = f.path.relative_to(base)
            category = rel.parts[0] if len(rel.parts) > 1 else "root"
        except ValueError:
            category = "other"

        cat = sub_stats.setdefault(category, {"count": 0, "bytes": 0})
        cat["count"] += 1
        cat["bytes"] += f.size

    for cat_name, data in sub_stats.items():
        data["size_str"] = _format_size(data["bytes"])

    return {
        "root": str(base),
        "total_count": total_count,
        "total_bytes": total_bytes,
        "total_size_str": _format_size(total_bytes),
        "oldest_ts": oldest_mtime,
        "newest_ts": newest_mtime,
        "categories": sub_stats,
    }


def cleanup_expired_logs(
    *,
    root: Path | None = None,
    max_days: int = 14,
    max_total_mb: int = 500,
) -> dict[str, Any]:
    """执行日志清理并返回清理报告。

    参数：
    - max_days: 超过该天数的文件无条件删除（默认 14 天，<=0 则不按天数删）。
    - max_total_mb: 日志总容量上限（MB），超出时按最旧时间优先清理至上限的 80%。
    """
    base = root or logs_dir()
    files = collect_log_files(base)
    now = time.time()
    cutoff_time = now - (max_days * 86400) if max_days > 0 else 0

    deleted_count = 0
    freed_bytes = 0
    remaining_files: list[LogFileInfo] = []

    # 第一阶段：按过期时间筛选删除
    for f in files:
        if cutoff_time > 0 and f.mtime < cutoff_time:
            try:
                f.path.unlink(missing_ok=True)
                deleted_count += 1
                freed_bytes += f.size
            except (OSError, PermissionError):
                remaining_files.append(f)
        else:
            remaining_files.append(f)

    # 第二阶段：容量超标裁决
    max_bytes = max_total_mb * 1024 * 1024
    current_total = sum(f.size for f in remaining_files)

    if max_bytes > 0 and current_total > max_bytes:
        target_bytes = int(max_bytes * 0.8)  # 清理留出缓冲空间
        # 按修改时间从旧到新排序
        remaining_files.sort(key=lambda x: x.mtime)
        still_remaining: list[LogFileInfo] = []

        for f in remaining_files:
            if current_total > target_bytes:
                try:
                    f.path.unlink(missing_ok=True)
                    deleted_count += 1
                    freed_bytes += f.size
                    current_total -= f.size
                except (OSError, PermissionError):
                    still_remaining.append(f)
            else:
                still_remaining.append(f)
        remaining_files = still_remaining

    # 尝试清理已变空的空子目录
    if base.exists():
        for d in sorted(base.rglob("*"), key=lambda p: len(p.parts), reverse=True):
            if d.is_dir() and d != base:
                try:
                    d.rmdir()
                except OSError:
                    pass

    return {
        "deleted_count": deleted_count,
        "freed_bytes": freed_bytes,
        "freed_size_str": _format_size(freed_bytes),
        "remaining_count": len(remaining_files),
        "remaining_bytes": sum(f.size for f in remaining_files),
        "remaining_size_str": _format_size(sum(f.size for f in remaining_files)),
    }


def schedule_background_cleanup(
    max_days: int = 14,
    max_total_mb: int = 500,
) -> threading.Thread:
    """在后台静默执行一次日志清理。"""
    def _run() -> None:
        try:
            # 延时 2 秒，避免启动初期与主业务抢占磁盘 IO
            time.sleep(2.0)
            res = cleanup_expired_logs(max_days=max_days, max_total_mb=max_total_mb)
            if res["deleted_count"] > 0:
                logger.info(
                    "Background log cleanup completed: removed %d files, freed %s",
                    res["deleted_count"],
                    res["freed_size_str"],
                )
        except Exception as e:
            logger.warning("Background log cleanup failed: %s", e)

    t = threading.Thread(target=_run, name="toolbox-log-cleanup", daemon=True)
    t.start()
    return t
