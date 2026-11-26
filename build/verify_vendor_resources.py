#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打包前检查 vendor/ 必需资源是否齐全；缺失则退出非 0。"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor"

# (相对 vendor/ 的路径, 说明)
REQUIRED: tuple[tuple[str, str], ...] = (
    ("platform-tools/adb.exe", "adb 可执行文件（运行 build\\fetch_platform_tools.bat）"),
    ("platform-tools/AdbWinApi.dll", "adb Windows DLL"),
    ("platform-tools/AdbWinUsbApi.dll", "adb Windows USB DLL"),
    ("rpmb/rpmb_test_v7_dev.sh", "RPMB 测试脚本"),
    ("rpmb/mmc_utils", "RPMB mmc_utils"),
    ("rpmb/rpmbkey.bin", "RPMB 密钥文件"),
    ("iozone/iozone", "iozone 二进制（Android push）"),
    ("ota/config.ini.example", "OTA 配置示例"),
)


def main() -> int:
    missing: list[str] = []
    if not VENDOR.is_dir():
        print("[ERROR] vendor/ 目录不存在")
        return 1

    for rel, hint in REQUIRED:
        path = VENDOR / rel.replace("/", "\\") if sys.platform == "win32" else VENDOR / rel
        # Path handles both separators
        path = VENDOR.joinpath(*rel.split("/"))
        if not path.exists():
            missing.append(f"  vendor/{rel}  ({hint})")

    if missing:
        print("[ERROR] 以下 vendor 资源缺失，无法打包为零依赖安装包：")
        print("\n".join(missing))
        print("\n请补齐 vendor/ 后重试。platform-tools 可由 build\\fetch_platform_tools.bat 自动下载。")
        return 1

    print(f"[OK] vendor 资源检查通过（{len(REQUIRED)} 项）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
