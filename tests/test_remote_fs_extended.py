#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""文件管理新增后端能力的单元测试（remount / df / find / md5 / 预览读写）。"""

from __future__ import annotations

import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.adb_tools import remote_fs


def _cp(stdout: str = "", stderr: str = "", returncode: int = 0) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args=["adb"], returncode=returncode, stdout=stdout, stderr=stderr)


class TestRemoteFsExtended(unittest.TestCase):
    def test_parse_df_output(self) -> None:
        sample = (
            "Filesystem      Size  Used Avail Use% Mounted on\n"
            "/dev/block/dm-0  11G  3.2G  7.8G  30% /data\n"
        )
        info = remote_fs._parse_df_output(sample)
        self.assertEqual(info["total"], "11G")
        self.assertEqual(info["avail"], "7.8G")
        self.assertEqual(info["use_pct"], "30%")
        self.assertEqual(info["mount"], "/data")

    def test_find_and_md5_remote(self) -> None:
        with (
            patch.object(remote_fs, "adb_available", return_value=True),
            patch.object(
                remote_fs,
                "run_adb",
                return_value=_cp("/sdcard/Download/test.log\n/sdcard/Download/sub/test2.log\n"),
            ),
        ):
            items = remote_fs.adb_find_remote("SN1", "/sdcard", "test")
            self.assertEqual(len(items), 2)
            self.assertEqual(items[0]["name"], "test.log")
            self.assertEqual(items[0]["parent"], "/sdcard/Download")

        with (
            patch.object(remote_fs, "adb_available", return_value=True),
            patch.object(
                remote_fs,
                "run_adb",
                return_value=_cp("d41d8cd98f00b204e9800998ecf8427e  /sdcard/a.txt\n"),
            ),
        ):
            digest = remote_fs.adb_md5_remote("SN1", "/sdcard/a.txt")
            self.assertEqual(digest, "d41d8cd98f00b204e9800998ecf8427e")

    def test_read_and_write_remote_file(self) -> None:
        def fake_pull(device: str | None, remote: str, local: Path) -> remote_fs.AdbCommandResult:
            Path(local).write_text("ro.test=1\n", encoding="utf-8", newline="\n")
            return remote_fs.AdbCommandResult(label="pull", returncode=0, output="ok", saved_path=Path(local))

        with (
            patch.object(remote_fs, "adb_available", return_value=True),
            patch.object(remote_fs, "adb_pull_file", side_effect=fake_pull),
        ):
            data = remote_fs.adb_read_remote_file("SN1", "/data/local.prop")
            self.assertEqual(data["kind"], "text")
            self.assertEqual(data["text"], "ro.test=1\n")

        with (
            patch.object(remote_fs, "adb_available", return_value=True),
            patch.object(
                remote_fs,
                "adb_push_file",
                return_value=remote_fs.AdbCommandResult(label="push", returncode=0, output="ok"),
            ) as m_push,
        ):
            res = remote_fs.adb_write_remote_file("SN1", "/data/local.prop", "ro.test=2\n")
            self.assertTrue(res.ok)
            self.assertEqual(m_push.call_args[0][2], "/data/local.prop")

    def test_transport_endpoint_not_connected_raises_friendly_error(self) -> None:
        with (
            patch.object(remote_fs, "adb_available", return_value=True),
            patch.object(remote_fs, "_canonicalize_remote_dir", return_value="/storage/emulated/0/"),
            patch.object(
                remote_fs,
                "run_adb",
                return_value=_cp("", "ls: /storage/emulated/0: Transport endpoint is not connected\n", 1),
            ) as m_run,
        ):
            with self.assertRaises(RuntimeError) as ctx:
                remote_fs.list_remote_entries("SN1", "/sdcard")
            self.assertIn("存储挂载点已断开", str(ctx.exception))
            self.assertEqual(m_run.call_count, 1)


if __name__ == "__main__":
    unittest.main()
