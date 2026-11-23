#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Log 抓取增强功能的单元测试（PID/多Tag、文件切分、Mark、异常现场收集）。"""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.adb_tools import core, pkg_ops


def _cp(stdout: str = "", stderr: str = "", returncode: int = 0) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args=["adb"], returncode=returncode, stdout=stdout, stderr=stderr)


class TestLogcatExtended(unittest.TestCase):
    def test_logcat_args_pid_and_multi_tags(self) -> None:
        args = core._logcat_args("main", dump=True, tag="MyTag, FooBar", level="W", pid="4321")
        self.assertEqual(
            args,
            ["logcat", "-b", "main", "-d", "--pid=4321", "-v", "threadtime", "MyTag:W", "FooBar:W", "*:S"],
        )

    def test_package_pids_pidof_and_ps_fallback(self) -> None:
        with (
            patch.object(pkg_ops, "adb_available", return_value=True),
            patch.object(pkg_ops, "run_adb", return_value=_cp("1024 2048\n")),
        ):
            self.assertEqual(pkg_ops.adb_package_pids("SN1", "com.demo.tv"), ["1024", "2048"])

        ps_out = "u0_a12   5678  123 100000 50000 0 0 S com.demo.tv\n"
        with (
            patch.object(pkg_ops, "adb_available", return_value=True),
            patch.object(
                pkg_ops,
                "run_adb",
                side_effect=[_cp("", returncode=1), _cp(ps_out)],
            ),
        ):
            self.assertEqual(pkg_ops.adb_package_pids("SN1", "com.demo.tv"), ["5678"])

    def test_logcat_session_mark_and_rotate(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "live.log"
            emitted: list[str] = []
            rotated: list[Path] = []
            sess = core.LogcatSession(
                "SN1",
                out,
                rotate_mb=0.0001,  # ~104 bytes
                on_line=emitted.append,
                on_rotate=rotated.append,
            )
            sess._file_handle = out.open("ab")
            try:
                line1 = sess.append_mark("step 1")
                line2 = sess.append_mark("step 2")
                self.assertIn("[MARK ", line1)
                self.assertIn("step 1", line1)
                self.assertEqual(len(emitted), 2)
                self.assertTrue(len(rotated) >= 1)
                self.assertTrue((Path(tmp) / "live_part2.log").exists())
                self.assertIn("step 2", line2)
            finally:
                if sess._file_handle is not None:
                    sess._file_handle.close()

    def test_collect_crash_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            session_dir = Path(tmp) / "sess"
            session_dir.mkdir(parents=True, exist_ok=True)
            with (
                patch.object(core, "adb_available", return_value=True),
                patch.object(core, "dump_logcat", side_effect=lambda d, p, **kw: p.write_text("crash", encoding="utf-8") and p),
                patch.object(core, "capture_dumpsys", side_effect=lambda d, s, p, **kw: p.write_text(s, encoding="utf-8") and p),
                patch.object(core, "run_adb", return_value=_cp("ro.build.version=1\n")),
            ):
                res = core.collect_crash_artifacts("SN1", session_dir)
                self.assertTrue(res["ok"])
                self.assertTrue(res["count"] >= 3)
                self.assertTrue(Path(str(res["dir"])).is_dir())


if __name__ == "__main__":
    unittest.main()
