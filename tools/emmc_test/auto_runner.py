#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""eMMC 多子项自动化常量定义（测试步骤顺序与显示名称）。"""

from __future__ import annotations

AUTO_STEPS = ("iozone", "stress", "reboot", "ota", "rpmb")
AUTO_LABELS: dict[str, str] = {
    "iozone": "iozone读写速度",
    "stress": "读写压力测试",
    "reboot": "reboot测试",
    "ota": "OTA测试v5",
    "rpmb": "RPMB测试",
}

__all__ = ["AUTO_STEPS", "AUTO_LABELS"]
