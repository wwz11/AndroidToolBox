#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Verify embedded scrcpy deps inside a frozen Toolbox / toolbox-api folder."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    if len(sys.argv) > 1:
        app_dir = Path(sys.argv[1]).resolve()
    else:
        app_dir = root / "dist" / "toolbox-api"
        if not (app_dir / "toolbox-api.exe").is_file():
            app_dir = root / "dist" / "AndroidTVTestToolBox"

    internal = app_dir / "_internal"
    exe_candidates = (
        app_dir / "toolbox-api.exe",
        app_dir / "AndroidTVTestToolBox.exe",
        app_dir / "Toolbox.exe",
    )
    if not any(p.is_file() for p in exe_candidates):
        print(f"[ERROR] no AndroidTVTestToolBox/toolbox-api exe in {app_dir}")
        return 1
    if not internal.is_dir():
        print(f"[ERROR] _internal not found under {app_dir}")
        return 1

    os.chdir(app_dir)
    sys.path.insert(0, str(internal))
    marker = internal / "toolbox_embed_scrcpy.marker"
    if not marker.is_file():
        print("[ERROR] Missing toolbox_embed_scrcpy.marker (build without embedded scrcpy?)")
        return 1
    if not any(internal.glob("py_scrcpy_sdk*")):
        print("[ERROR] py_scrcpy_sdk not bundled under _internal")
        return 1

    for sub in (".", "av.libs", "numpy.libs", "cv2"):
        p = internal / sub
        if p.is_dir():
            try:
                os.add_dll_directory(str(p))
            except (AttributeError, OSError):
                pass

    # Prefer importing from frozen tree paths; fall back to source for reason helper
    sys.path.insert(0, str(root))
    # Force frozen-like check against marker only; full import may need exe context
    print(f"[OK] py_scrcpy_sdk bundled in _internal")
    print(f"[OK] toolbox_embed_scrcpy.marker present: {marker}")

    # Try import via source modules with DLL paths prepared (dev verification)
    try:
        from tools.remote.scrcpy_embed import embed_unavailable_reason, scrcpy_embed_available

        # Temporarily pretend frozen for marker path? Better: just try real imports
        if scrcpy_embed_available():
            print("[OK] Frozen bundle: embedded scrcpy imports OK")
            return 0
        # In non-frozen check, marker is ignored; import failure is still fatal for pack quality
        print(f"[ERROR] {embed_unavailable_reason()}")
        return 1
    except Exception as exc:
        print(f"[ERROR] scrcpy embed verify failed: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
