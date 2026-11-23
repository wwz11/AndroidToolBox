# -*- coding: utf-8 -*-
"""PyQt5 hook override: PyQt5.11+ uses PyQt5.sip, not standalone sip."""

from PyInstaller.utils.hooks.qt import ensure_single_qt_bindings_package, pyqt5_library_info

ensure_single_qt_bindings_package("PyQt5")

if pyqt5_library_info.version is not None:
    hiddenimports = [
        "PyQt5.sip",
        "pkgutil",
    ]
    binaries = pyqt5_library_info.collect_extra_binaries()
