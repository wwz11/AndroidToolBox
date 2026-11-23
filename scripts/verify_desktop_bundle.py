#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""校验 Electron 便携包：无需本机 Python / adb 即可运行所需资源。"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

REQUIRED_REL: tuple[tuple[str, ...], ...] = (
    ("AndroidTVTestToolBox.exe",),
    ("resources", "toolbox-api", "toolbox-api.exe"),
    ("resources", "toolbox-api", "_internal", "vendor", "platform-tools", "adb.exe"),
    ("resources", "toolbox-api", "_internal", "vendor", "platform-tools", "AdbWinApi.dll"),
    ("resources", "toolbox-api", "_internal", "vendor", "platform-tools", "AdbWinUsbApi.dll"),
    ("resources", "toolbox-api", "_internal", "vendor", "iozone", "iozone"),
    ("resources", "toolbox-api", "_internal", "vendor", "rpmb", "rpmb_test_v7_dev.sh"),
    ("resources", "toolbox-api", "_internal", "vendor", "rpmb", "mmc_utils"),
    ("resources", "toolbox-api", "_internal", "vendor", "rpmb", "rpmbkey.bin"),
    (
        "resources",
        "toolbox-api",
        "_internal",
        "vendor",
        "emmc",
        "eMMC For SEIxxxxx 导入测试报告模版v2.0.xlsx",
    ),
    ("resources", "toolbox-api", "_internal", "vendor", "ota", "config.ini.example"),
    ("resources", "toolbox-api", "_internal", "toolbox_embed_scrcpy.marker"),
)


def main() -> int:
    app_dir = (
        Path(sys.argv[1])
        if len(sys.argv) > 1
        else ROOT / "desktop" / "release" / "win-unpacked"
    )
    if not app_dir.is_dir():
        print(f"[ERROR] 输出目录不存在: {app_dir}")
        return 1

    missing: list[str] = []
    for parts in REQUIRED_REL:
        p = app_dir.joinpath(*parts)
        if not p.exists():
            missing.append("  " + "/".join(parts))

    if missing:
        print("[ERROR] 便携包缺少以下资源（目标机将无法零依赖运行）：")
        print("\n".join(missing))
        return 1

    print(f"[OK] 桌面便携包校验通过: {app_dir}")
    print(
        "     已内置: Electron 壳 + toolbox-api + adb + eMMC/RPMB/iozone + embed scrcpy 标记"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
