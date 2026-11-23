# -*- coding: utf-8 -*-
"""工具箱本机 API（供 Electron 桌面壳调用）。"""

__all__ = ["create_app"]


def create_app():
    from tools.api.app import create_app as _create

    return _create()
