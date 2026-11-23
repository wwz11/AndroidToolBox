#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""FastAPI 路由层公共依赖与内存任务清理辅助。"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import HTTPException


def require_sn(device: str) -> str:
    """校验并返回去空白的设备序列号。"""
    sn = (device or "").strip()
    if not sn or sn == "未选设备":
        raise HTTPException(status_code=400, detail="请先选择设备 SN")
    return sn


def evict_finished_jobs(
    jobs: dict[str, Any],
    *,
    is_running: Callable[[Any], bool],
    max_finished: int = 50,
) -> None:
    """限制内存中已完成任务的最大保留数量，防止长时间挂机导致内存泄漏。

    由于 Python 3.7+ 字典保持插入顺序，直接按插入顺序淘汰最旧的已完成任务。
    调用方需在持有对应锁的情况下调用此函数。
    """
    if len(jobs) <= max_finished:
        return
    finished_keys = [k for k, v in jobs.items() if not is_running(v)]
    overflow = len(finished_keys) - max_finished
    if overflow <= 0:
        return
    for k in finished_keys[:overflow]:
        jobs.pop(k, None)
