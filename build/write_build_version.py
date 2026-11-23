#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打包前写入版本号。

版本策略（给 electron-updater / NSIS / 产物文件名用，需合法 semver）：
  应用版本 = 年.月.序号   例：2026.8.3 = 2026 年 8 月第 3 次发布
  构建号   = 与应用版本相同（不再使用 YYYYMMDD 日期）

同月再次打包会自动 +1 序号；换月从 .1 起。
可用环境变量覆盖：
  TOOLBOX_APP_VERSION=2026.8.10   强制指定版本
  TOOLBOX_BUMP=none               不抬版本，沿用 package.json
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GENERATED = ROOT / "build" / "generated"
VERSION_ISS = GENERATED / "version.iss"
BUILD_TAG_TXT = GENERATED / "build_tag.txt"
APP_VERSION_TXT = GENERATED / "app_version.txt"
BUILD_VERSION_PY = ROOT / "tools" / "_build_version.py"
PKG_PATH = ROOT / "desktop" / "package.json"


def _semver_tuple(v: str) -> tuple[int, ...]:
    parts: list[int] = []
    for x in str(v).strip().split(".")[:3]:
        try:
            parts.append(int(x))
        except ValueError:
            parts.append(0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts)


def _read_pkg_version() -> str:
    try:
        return str(json.loads(PKG_PATH.read_text(encoding="utf-8")).get("version") or "")
    except Exception:
        return ""


def _next_calver(cur: str, now: datetime) -> str:
    """年.月.序号：同月递增序号，换月从 1 开始。"""
    y, m = now.year, now.month
    seq = 1
    if cur:
        parts = [p.strip() for p in cur.split(".")]
        try:
            cy, cm, cs = int(parts[0]), int(parts[1]), int(parts[2]) if len(parts) > 2 else 0
        except (ValueError, IndexError):
            cy = cm = cs = 0
        if cy == y and cm == m:
            seq = max(cs, 0) + 1
        elif _semver_tuple(cur) > _semver_tuple(f"{y}.{m}.0"):
            # 手工抬过更高版本时，在其第三段继续 +1，避免回退
            seq = max(cs, 0) + 1
            return f"{cy}.{cm}.{seq}"
    return f"{y}.{m}.{seq}"


def main() -> int:
    now = datetime.now()
    cur = _read_pkg_version()
    bump = (os.environ.get("TOOLBOX_BUMP") or "seq").strip().lower()
    force = (os.environ.get("TOOLBOX_APP_VERSION") or "").strip()

    if force:
        version = force
        print(f"[version] TOOLBOX_APP_VERSION={force}")
    elif bump in ("none", "keep", "0"):
        version = cur or _next_calver("", now)
        print(f"[version] keep package.json version={version}")
    else:
        version = _next_calver(cur, now)
        if cur:
            print(f"[version] bump {cur} -> {version}")
        else:
            print(f"[version] init {version}")

    # 构建号与应用版本一致，产物命名统一用版本，不用打包日期
    build_tag = version

    GENERATED.mkdir(parents=True, exist_ok=True)
    VERSION_ISS.write_text(
        f'#define AppVersion "{version}"\n#define BuildTag "{build_tag}"\n',
        encoding="utf-8",
    )
    BUILD_TAG_TXT.write_text(build_tag + "\n", encoding="ascii")
    APP_VERSION_TXT.write_text(version + "\n", encoding="ascii")
    BUILD_VERSION_PY.write_text(
        f'__version__ = "{version}"\nBUILD_TAG = "{build_tag}"\n',
        encoding="utf-8",
    )

    try:
        pkg = json.loads(PKG_PATH.read_text(encoding="utf-8"))
        pkg["version"] = version
        PKG_PATH.write_text(
            json.dumps(pkg, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"[version] desktop/package.json -> {version}")
    except Exception as exc:
        print(f"[version] WARN sync package.json failed: {exc}", file=sys.stderr)

    print(f"[version] AppVersion={version} BuildTag={build_tag}")
    print("[version] 规则: 年.月.序号（同月打包自动 +1）；产物/构建号均用版本号，不用日期")
    return 0


if __name__ == "__main__":
    sys.exit(main())
