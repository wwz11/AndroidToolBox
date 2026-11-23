# PyInstaller runtime hook: DLL search paths for av / cv2 before embed import.
import os
import sys

if getattr(sys, "frozen", False):
    base = getattr(sys, "_MEIPASS", None)
    if base:
        for sub in (".", "av.libs", "numpy.libs", "cv2"):
            path = os.path.join(base, sub)
            if os.path.isdir(path):
                try:
                    os.add_dll_directory(path)  # type: ignore[attr-defined]
                except (AttributeError, OSError):
                    os.environ["PATH"] = path + os.pathsep + os.environ.get("PATH", "")
