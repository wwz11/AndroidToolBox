#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""零外部依赖构建 android_agent/dist/ToolboxAgent.apk。"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent
DIST_APK = ROOT / "dist" / "ToolboxAgent.apk"
VENDOR_APK = PROJECT_ROOT / "vendor" / "apk" / "ToolboxAgent.apk"


def _find_sdk() -> Path:
    for env_key in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        val = os.environ.get(env_key, "").strip()
        if val and Path(val).is_dir():
            return Path(val)
    default = Path(r"D:\Android\android-sdk")
    if default.is_dir():
        return default
    raise RuntimeError("未找到 Android SDK（请设置 ANDROID_HOME）")


def _pick_latest(parent: Path, prefix: str = "") -> Path:
    items = sorted(
        [p for p in parent.iterdir() if p.is_dir() and (not prefix or p.name.startswith(prefix))],
        key=lambda p: p.name,
    )
    if not items:
        raise RuntimeError(f"未在 {parent} 找到 {prefix or '*'} 目录")
    return items[-1]


def _run(cmd: list[str]) -> None:
    print(">", " ".join(str(c) for c in cmd))
    subprocess.run([str(c) for c in cmd], check=True)


def main() -> int:
    sdk = _find_sdk()
    bt_dir = _pick_latest(sdk / "build-tools")
    platform_dir = sdk / "platforms" / "android-34"
    if not platform_dir.is_dir():
        platform_dir = _pick_latest(sdk / "platforms", "android-")

    android_jar = platform_dir / "android.jar"
    aapt2 = bt_dir / "aapt2.exe"
    d8 = bt_dir / "d8.bat"
    zipalign = bt_dir / "zipalign.exe"
    apksigner = bt_dir / "apksigner.bat"

    build_dir = ROOT / "build"
    if build_dir.exists():
        shutil.rmtree(build_dir)
    classes_dir = build_dir / "classes"
    dex_dir = build_dir / "dex"
    classes_dir.mkdir(parents=True, exist_ok=True)
    dex_dir.mkdir(parents=True, exist_ok=True)
    DIST_APK.parent.mkdir(parents=True, exist_ok=True)
    VENDOR_APK.parent.mkdir(parents=True, exist_ok=True)

    unaligned_apk = build_dir / "app-unaligned.apk"
    aligned_apk = build_dir / "app-aligned.apk"

    _run([
        str(aapt2),
        "link",
        "-o", str(unaligned_apk),
        "-I", str(android_jar),
        "--manifest", str(ROOT / "AndroidManifest.xml"),
        "--auto-add-overlay",
    ])

    java_files = sorted(str(p) for p in (ROOT / "src").rglob("*.java"))
    lambda_stubs = bt_dir / "core-lambda-stubs.jar"
    boot_cp = f"{android_jar}{os.pathsep}{lambda_stubs}" if lambda_stubs.is_file() else str(android_jar)
    _run([
        "javac",
        "-source", "8",
        "-target", "8",
        "-encoding", "UTF-8",
        "-bootclasspath", boot_cp,
        "-classpath", str(android_jar),
        "-d", str(classes_dir),
        *java_files,
    ])

    class_files = sorted(str(p) for p in classes_dir.rglob("*.class"))
    _run([
        str(d8),
        "--min-api", "26",
        "--lib", str(android_jar),
        "--output", str(dex_dir),
        *class_files,
    ])

    # Add classes.dex into unaligned_apk using Python zipfile
    import zipfile
    with zipfile.ZipFile(unaligned_apk, "a", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.write(dex_dir / "classes.dex", "classes.dex")

    _run([str(zipalign), "-f", "4", str(unaligned_apk), str(aligned_apk)])

    keystore = ROOT / "debug.keystore"
    if not keystore.exists():
        _run([
            "keytool", "-genkeypair", "-v",
            "-keystore", str(keystore),
            "-storepass", "android",
            "-alias", "androiddebugkey",
            "-keypass", "android",
            "-keyalg", "RSA",
            "-keysize", "2048",
            "-validity", "10000",
            "-dname", "CN=Android Debug,O=Android,C=US",
        ])

    _run([
        str(apksigner),
        "sign",
        "--ks", str(keystore),
        "--ks-pass", "pass:android",
        "--key-pass", "pass:android",
        "--ks-key-alias", "androiddebugkey",
        "--out", str(DIST_APK),
        str(aligned_apk),
    ])

    shutil.copy2(DIST_APK, VENDOR_APK)
    print(f"[OK] APK built: {DIST_APK} ({DIST_APK.stat().st_size} bytes)")
    print(f"[OK] Copied to: {VENDOR_APK}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
