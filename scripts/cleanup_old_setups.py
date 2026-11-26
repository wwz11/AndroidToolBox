#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""发布新版后清理旧的 Setup / blockmap，只保留当前版本。

用法:
  python cleanup_old_setups.py <dir> <version>
  python cleanup_old_setups.py \\\\nas\\...\\ToolBox 2026.8.16
"""

from __future__ import annotations

import sys
from pathlib import Path

PREFIX = "AndroidTVTestToolBox-Setup-"


def cleanup(dir_path: Path, version: str) -> int:
    if not version.strip():
        print("[cleanup] skip: empty version", file=sys.stderr)
        return 1
    if not dir_path.is_dir():
        print(f"[cleanup] skip: not a directory: {dir_path}", file=sys.stderr)
        return 1

    keep_exe = f"{PREFIX}{version}.exe"
    keep_blockmap = f"{PREFIX}{version}.exe.blockmap"
    removed = 0
    kept = 0

    for p in sorted(dir_path.iterdir()):
        name = p.name
        if not p.is_file():
            continue
        is_setup = name.startswith(PREFIX) and name.endswith(".exe") and ".exe." not in name
        is_blockmap = name.startswith(PREFIX) and name.endswith(".exe.blockmap")
        if not is_setup and not is_blockmap:
            continue
        if name in (keep_exe, keep_blockmap):
            kept += 1
            continue
        try:
            p.unlink()
            removed += 1
            print(f"[cleanup] removed {p}")
        except OSError as exc:
            print(f"[cleanup] WARN cannot remove {p}: {exc}", file=sys.stderr)

    print(f"[cleanup] {dir_path}: kept={kept} removed={removed} keep={keep_exe}")
    return 0


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: cleanup_old_setups.py <dir> <version>", file=sys.stderr)
        return 2
    return cleanup(Path(sys.argv[1]), sys.argv[2].strip())


if __name__ == "__main__":
    sys.exit(main())
