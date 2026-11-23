#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""工具箱版本号（打包时由 build/write_build_version.py 生成）。"""

from __future__ import annotations

try:
    from tools._build_version import BUILD_TAG, __version__
except ImportError:
    __version__ = "dev"
    BUILD_TAG = ""


def app_title(base: str = "SEIAndroidTVTestToolBox") -> str:
    if __version__ == "dev":
        return base
    return f"{base} {__version__}"
