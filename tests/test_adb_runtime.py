# -*- coding: utf-8 -*-
"""Unit tests for adb_runtime."""

import sys
import unittest

from tools.adb_runtime import (
    _subprocess_kwargs,
    adb_subprocess_env,
    build_adb_cmd,
)


class TestAdbRuntime(unittest.TestCase):
    def test_build_adb_cmd_without_device(self) -> None:
        cmd = build_adb_cmd(["devices"], None)
        self.assertEqual(cmd[-1], "devices")
        self.assertNotIn("-s", cmd)

    def test_build_adb_cmd_with_device(self) -> None:
        cmd = build_adb_cmd(["shell", "getprop"], "192.168.1.50:5555")
        self.assertIn("-s", cmd)
        idx = cmd.index("-s")
        self.assertEqual(cmd[idx + 1], "192.168.1.50:5555")
        self.assertEqual(cmd[-2:], ["shell", "getprop"])

    def test_subprocess_kwargs_on_windows(self) -> None:
        kw = _subprocess_kwargs()
        if sys.platform == "win32":
            self.assertIn("creationflags", kw)
            self.assertIn("startupinfo", kw)
        else:
            self.assertEqual(kw, {})

    def test_adb_subprocess_env(self) -> None:
        env = adb_subprocess_env()
        self.assertIn("PATH", env)


if __name__ == "__main__":
    unittest.main()
