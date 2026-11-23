# -*- coding: utf-8 -*-
"""Unit tests for log_manager."""

import os
import tempfile
import time
import unittest
from pathlib import Path

from tools.log_manager import cleanup_expired_logs, get_logs_stats


class TestLogManager(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_empty_directory_stats(self) -> None:
        stats = get_logs_stats(self.root)
        self.assertEqual(stats["total_count"], 0)
        self.assertEqual(stats["total_bytes"], 0)
        self.assertEqual(stats["categories"], {})

    def test_log_stats_categorization(self) -> None:
        shell_dir = self.root / "shell"
        shell_dir.mkdir(parents=True, exist_ok=True)
        (shell_dir / "shell_1.log").write_text("hello shell", encoding="utf-8")

        emmc_dir = self.root / "emmc"
        emmc_dir.mkdir(parents=True, exist_ok=True)
        (emmc_dir / "test.log").write_text("hello emmc test", encoding="utf-8")

        stats = get_logs_stats(self.root)
        self.assertEqual(stats["total_count"], 2)
        self.assertIn("shell", stats["categories"])
        self.assertIn("emmc", stats["categories"])
        self.assertEqual(stats["categories"]["shell"]["count"], 1)
        self.assertEqual(stats["categories"]["emmc"]["count"], 1)

    def test_cleanup_expired_by_days(self) -> None:
        # Create an old file (>20 days old)
        old_file = self.root / "old.log"
        old_file.write_text("old content", encoding="utf-8")
        past_time = time.time() - (25 * 86400)
        os.utime(old_file, (past_time, past_time))

        # Create a recent file (now)
        new_file = self.root / "new.log"
        new_file.write_text("new content", encoding="utf-8")

        # Cleanup with max_days=14
        res = cleanup_expired_logs(root=self.root, max_days=14, max_total_mb=500)
        self.assertEqual(res["deleted_count"], 1)
        self.assertFalse(old_file.exists())
        self.assertTrue(new_file.exists())

    def test_cleanup_by_capacity(self) -> None:
        # Create 3 files of 1MB each
        f1 = self.root / "file1.log"
        f2 = self.root / "file2.log"
        f3 = self.root / "file3.log"
        f1.write_bytes(b"A" * (1024 * 1024))
        f2.write_bytes(b"B" * (1024 * 1024))
        f3.write_bytes(b"C" * (1024 * 1024))

        t0 = time.time()
        os.utime(f1, (t0 - 300, t0 - 300))
        os.utime(f2, (t0 - 200, t0 - 200))
        os.utime(f3, (t0 - 100, t0 - 100))

        # Limit to 2MB (exceeded, should prune oldest down to 80% of 2MB = ~1.6MB)
        res = cleanup_expired_logs(root=self.root, max_days=0, max_total_mb=2)
        self.assertGreater(res["deleted_count"], 0)
        self.assertFalse(f1.exists())  # oldest must be deleted first


if __name__ == "__main__":
    unittest.main()
