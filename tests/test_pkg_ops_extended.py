#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""应用管理新增后端能力的单元测试（停用/启用、权限、前台定位、重启、导出 APK）。"""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.adb_tools import apk_analyze, pkg_ops


def _cp(stdout: str = "", stderr: str = "", returncode: int = 0) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args=["adb"], returncode=returncode, stdout=stdout, stderr=stderr)


class TestPkgOpsExtended(unittest.TestCase):
    def test_validate_pkg_token_rejects_injection(self) -> None:
        self.assertEqual(pkg_ops._validate_pkg_token("com.example.tv", "包名"), "com.example.tv")
        for bad in ("", "   ", "com.a; rm -rf /", "com.a && id", "com.a pkg"):
            with self.assertRaises(ValueError):
                pkg_ops._validate_pkg_token(bad, "包名")

    def test_parse_foreground_output_prefers_resumed_over_focus(self) -> None:
        sample = """
        mFocusedApp=ActivityRecord{111 u0 com.android.tv.settings/.MainSettings t4}
        topResumedActivity=ActivityRecord{222 u0 com.netflix.ninja/.MainActivity t12}
        mCurrentFocus=Window{333 u0 com.android.systemui/com.android.systemui.SystemUI}
        """
        pkg, act, _ = pkg_ops._parse_foreground_output(sample)
        self.assertEqual(pkg, "com.netflix.ninja")
        self.assertEqual(act, ".MainActivity")

        focus_only = "  mCurrentFocus=Window{abc u0 com.demo.tv/com.demo.tv.HomeActivity}"
        pkg2, act2, _ = pkg_ops._parse_foreground_output(focus_only)
        self.assertEqual(pkg2, "com.demo.tv")
        self.assertEqual(act2, "com.demo.tv.HomeActivity")

    def test_set_package_enabled(self) -> None:
        with (
            patch.object(pkg_ops, "adb_available", return_value=True),
            patch.object(pkg_ops, "run_adb", return_value=_cp("Package com.demo new state: disabled-user\n")) as m_run,
        ):
            res = pkg_ops.adb_set_package_enabled("SN1", "com.demo", False)
            self.assertTrue(res.ok)
            self.assertEqual(m_run.call_args[0][0], ["shell", "pm", "disable-user", "--user", "0", "com.demo"])

            res2 = pkg_ops.adb_set_package_enabled("SN1", "com.demo", True)
            self.assertTrue(res2.ok)
            self.assertEqual(m_run.call_args[0][0], ["shell", "pm", "enable", "com.demo"])

        with (
            patch.object(pkg_ops, "adb_available", return_value=True),
            patch.object(
                pkg_ops,
                "run_adb",
                side_effect=[
                    _cp("", "SecurityException: Shell cannot change component state", returncode=1),
                    _cp("", "Error: unknown option", returncode=1),
                    _cp("Package com.demo new state: disabled\n"),
                ],
            ) as m_fb,
        ):
            res3 = pkg_ops.adb_set_package_enabled("SN1", "com.demo", False)
            self.assertTrue(res3.ok)
            self.assertEqual(m_fb.call_count, 3)

    def test_grant_all_package_permissions(self) -> None:
        calls: list[list[str]] = []

        def fake_run(args: list[str], device: str | None = None, **_: object) -> subprocess.CompletedProcess[str]:
            calls.append(args)
            if args[-1] == "android.permission.BAD":
                return _cp("", "SecurityException: unknown permission", returncode=1)
            return _cp("")

        with (
            patch.object(pkg_ops, "adb_available", return_value=True),
            patch.object(pkg_ops, "run_adb", side_effect=fake_run),
        ):
            res = pkg_ops.adb_grant_all_package_permissions(
                "SN1",
                "com.demo",
                ["android.permission.CAMERA", "android.permission.CAMERA", "android.permission.BAD"],
            )
            self.assertEqual(res["granted_count"], 1)
            self.assertEqual(res["failed_count"], 1)
            self.assertEqual(len(calls), 2)

    def test_restart_package(self) -> None:
        with (
            patch.object(pkg_ops, "adb_available", return_value=True),
            patch.object(pkg_ops, "run_adb", return_value=_cp("Events injected: 1")) as m_run,
            patch.object(pkg_ops.time, "sleep", return_value=None),
        ):
            res = pkg_ops.adb_restart_package("SN1", "com.demo")
            self.assertTrue(res.ok)
            self.assertEqual(m_run.call_count, 2)
            self.assertEqual(m_run.call_args_list[0][0][0], ["shell", "am", "force-stop", "com.demo"])
            self.assertEqual(m_run.call_args_list[1][0][0][:4], ["shell", "monkey", "-p", "com.demo"])

    def test_export_package_apk_single_and_split(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with (
                patch.object(pkg_ops, "adb_available", return_value=True),
                patch.object(
                    pkg_ops,
                    "run_adb",
                    return_value=_cp("package:/data/app/~~abc/com.demo-1/base.apk\n"),
                ),
                patch("tools.adb_tools.remote_fs.adb_pull_file") as m_pull,
            ):
                m_pull.return_value = pkg_ops.AdbCommandResult(
                    label="pull",
                    returncode=0,
                    output="1 file pulled",
                    saved_path=Path(tmp) / "com.demo_1.2.3.apk",
                )
                out = pkg_ops.adb_export_package_apk(
                    "SN1",
                    "com.demo",
                    dest_dir=tmp,
                    version_name="1.2.3",
                )
                self.assertTrue(out["ok"])
                self.assertEqual(len(out["saved_paths"]), 1)
                self.assertTrue(str(out["saved_paths"][0]).endswith("com.demo_1.2.3.apk"))

    def test_query_installed_package_parses_enabled(self) -> None:
        dumpsys = """
Package [com.demo] (12345):
  versionCode=10 minSdk=21 targetSdk=33
  versionName=2.0.0
  User 0: ceDataInode=1 installed=true hidden=false stopped=false enabled=3
"""

        def fake_run(args: list[str], device: str | None = None, **_: object) -> subprocess.CompletedProcess[str]:
            if args[:3] == ["shell", "dumpsys", "package"]:
                return _cp(dumpsys)
            return _cp("package:/data/app/com.demo/base.apk\n")

        with (
            patch("tools.adb_runtime.adb_available", return_value=True),
            patch("tools.adb_runtime.run_adb", side_effect=fake_run),
        ):
            info = apk_analyze.query_installed_package("SN1", "com.demo")
            self.assertEqual(info["installed"], "true")
            self.assertFalse(info["enabled"])


if __name__ == "__main__":
    unittest.main()
