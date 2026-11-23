#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""核心优化项与纯逻辑模块自动化单元测试。"""

from __future__ import annotations

import asyncio
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi import HTTPException

from tools import settings_store
from tools.api.deps import evict_finished_jobs, require_sn
from tools.emmc_test.adb_shell import string_run_shell
from tools.emmc_test.ota_v5 import _decode_output, judge_ota_result
from tools.emmc_test.read_excel import average_rates


class TestDeps(unittest.TestCase):
    """测试路由公共依赖与内存任务淘汰逻辑。"""

    def test_require_sn_valid(self) -> None:
        self.assertEqual(require_sn("  SN12345  "), "SN12345")

    def test_require_sn_invalid(self) -> None:
        for invalid in ("", "   ", "未选设备"):
            with self.assertRaises(HTTPException) as ctx:
                require_sn(invalid)
            self.assertEqual(ctx.exception.status_code, 400)

    def test_evict_finished_jobs_keeps_running_and_caps_finished(self) -> None:
        jobs: dict[str, dict[str, bool]] = {}
        # 插入 5 个已完成、2 个运行中、5 个已完成
        for i in range(5):
            jobs[f"done_old_{i}"] = {"running": False}
        for i in range(2):
            jobs[f"run_{i}"] = {"running": True}
        for i in range(5):
            jobs[f"done_new_{i}"] = {"running": False}

        evict_finished_jobs(
            jobs,
            is_running=lambda j: j["running"],
            max_finished=6,
        )
        # 运行中的 2 个必须全部保留
        self.assertIn("run_0", jobs)
        self.assertIn("run_1", jobs)
        # 已完成的最多保留 6 个（最旧的 4 个应被淘汰）
        finished_remaining = [k for k, v in jobs.items() if not v["running"]]
        self.assertEqual(len(finished_remaining), 6)
        self.assertEqual(
            finished_remaining,
            ["done_old_4", "done_new_0", "done_new_1", "done_new_2", "done_new_3", "done_new_4"],
        )


class TestSettingsStore(unittest.TestCase):
    """测试配置存储的原子落盘与多线程并发读写安全。"""

    def test_atomic_save_and_concurrent_put(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            fake_settings_path = Path(tmpdir) / "settings.json"
            with patch.object(settings_store, "config_path", return_value=fake_settings_path):
                settings_store._DATA = {}
                settings_store._LOADED = True

                errors: list[Exception] = []

                def _worker(tid: int) -> None:
                    try:
                        for i in range(15):
                            settings_store.put(f"thread_{tid}.key_{i}", i)
                            settings_store.save()
                    except Exception as exc:
                        errors.append(exc)

                threads = [threading.Thread(target=_worker, args=(t,)) for t in range(4)]
                for t in threads:
                    t.start()
                for t in threads:
                    t.join()

                self.assertEqual(errors, [])
                self.assertTrue(fake_settings_path.is_file())
                raw = json.loads(fake_settings_path.read_text(encoding="utf-8"))
                for t in range(4):
                    self.assertEqual(raw[f"thread_{t}.key_14"], 14)


class TestAdbShell(unittest.TestCase):
    """测试重构后的 string_run_shell 命令解析与 POSIX 状态码转换。"""

    @patch("tools.emmc_test.adb_shell.subprocess.Popen")
    def test_string_run_shell_parses_sn_and_translates_status_check(
        self, mock_popen: MagicMock
    ) -> None:
        proc = MagicMock()
        proc.communicate.return_value = (b"1024\n<stdin>[3]: 0: not found\n", b"")
        mock_popen.return_value = proc

        cmd = (
            "adb -s DEVICE001 shell \n"
            "dd if=/dev/block/system of=/data/test bs=1024 count=10 \n"
            "$? -ne 0 \n"
            "exit \n"
        )
        out = string_run_shell(cmd)
        self.assertIn("1024", out)
        self.assertIn("<stdin>[3]: 0:", "\n".join(out))

        # 验证直接调用 adb [-s DEVICE001] shell，且 shell=False
        args, kwargs = mock_popen.call_args
        self.assertFalse(kwargs.get("shell", True))
        self.assertIn("-s", args[0])
        self.assertIn("DEVICE001", args[0])
        self.assertEqual(args[0][-1], "shell")

        sent_script = proc.communicate.call_args[0][0].decode("utf-8")
        self.assertIn('if [ $? -eq 0 ]; then echo "<stdin>[3]: 0: not found"', sent_script)


class TestOtaAndExcelHelpers(unittest.TestCase):
    """测试 OTA 结果判定、字节解码与 IOzone 均值计算。"""

    def test_decode_output(self) -> None:
        self.assertEqual(_decode_output(None), "")
        self.assertEqual(_decode_output("hello"), "hello")
        self.assertEqual(_decode_output("中文UTF8".encode("utf-8")), "中文UTF8")
        self.assertEqual(_decode_output("中文GBK".encode("gbk")), "中文GBK")

    def test_judge_ota_result(self) -> None:
        self.assertEqual(
            judge_ota_result(
                user_stopped=True,
                completed=5,
                failed_rounds=0,
                upgrade_count=5,
                stop_reason="用户中断",
            ),
            "STOP",
        )
        self.assertEqual(
            judge_ota_result(
                user_stopped=False,
                completed=5,
                failed_rounds=0,
                upgrade_count=5,
                stop_reason="已达设定轮次 5",
            ),
            "PASS",
        )
        self.assertEqual(
            judge_ota_result(
                user_stopped=False,
                completed=3,
                failed_rounds=0,
                upgrade_count=0,
                stop_reason="达到最大运行时长 (60 分钟)",
            ),
            "PASS",
        )
        self.assertEqual(
            judge_ota_result(
                user_stopped=False,
                completed=2,
                failed_rounds=1,
                upgrade_count=5,
                stop_reason="轮次 3 升级失败",
            ),
            "FAIL",
        )

    def test_average_rates(self) -> None:
        runs = [
            {
                "write_max": "100.00 MB/S",
                "rewrite_max": "120.00 MB/S",
                "read_max": "200.00 MB/S",
                "reread_max": "220.00 MB/S",
                "randomread_max": "50.00 MB/S",
                "randomwrite_max": "60.00 MB/S",
            },
            {
                "write_max": "140.00 MB/S",
                "rewrite_max": "160.00 MB/S",
                "read_max": "240.00 MB/S",
                "reread_max": "260.00 MB/S",
                "randomread_max": "70.00 MB/S",
                "randomwrite_max": "80.00 MB/S",
            },
        ]
        avg = average_rates(runs)
        self.assertEqual(avg["write_rate"], "120.00 MB/S")
        self.assertEqual(avg["read_rate"], "220.00 MB/S")
        self.assertEqual(avg["randomwrite_rate"], "70.00 MB/S")


class TestSerialBoundedQueueAndUploadStream(unittest.IsolatedAsyncioTestCase):
    """测试串口 WebSocket 有界队列背压丢弃与 UploadFile 分块流式落盘。"""

    async def test_serial_enqueue_bounded_drops_oldest_when_full(self) -> None:
        import asyncio
        from tools.api.routes.serial_api import _enqueue_bounded

        q: asyncio.Queue[dict[str, str]] = asyncio.Queue(maxsize=3)
        for i in range(5):
            _enqueue_bounded(q, {"type": "rx", "text": f"line-{i}"})
        items = [q.get_nowait()["text"] for _ in range(q.qsize())]
        self.assertEqual(items, ["line-2", "line-3", "line-4"])

    async def test_write_upload_to_path_streams_chunks(self) -> None:
        from io import BytesIO
        from fastapi import UploadFile
        from tools.api.routes.adb_ops import _write_upload_to_path

        payload = b"ABCD" * (300 * 1024)  # ~1.2 MB
        upload = UploadFile(filename="demo.apk", file=BytesIO(payload))
        with tempfile.TemporaryDirectory() as tmpdir:
            dest = Path(tmpdir) / "demo.apk"
            written = await _write_upload_to_path(upload, dest)
            self.assertEqual(written, len(payload))
            self.assertEqual(dest.read_bytes(), payload)

    def test_adb_stream_bounded_queue_and_buffered_log(self) -> None:
        from tools.api.routes.adb_stream import _ShellSessionLog, _enqueue_stream_bounded

        q: asyncio.Queue[dict[str, str]] = asyncio.Queue(maxsize=3)
        for i in range(5):
            _enqueue_stream_bounded(q, {"type": "rx", "text": f"msg-{i}"})
        items = [q.get_nowait()["text"] for _ in range(q.qsize())]
        self.assertEqual(items, ["msg-2", "msg-3", "msg-4"])

        with tempfile.TemporaryDirectory() as tmpdir:
            target_path = Path(tmpdir) / "shell.log"
            log = _ShellSessionLog()
            log.set_target(target_path, enabled=True)
            try:
                log.write("partial_without_newline")
                self.assertEqual(log._unflushed_chars, len("partial_without_newline"))
                log.write("end\n")
                self.assertEqual(log._unflushed_chars, 0)
            finally:
                log.close()
            content = target_path.read_text(encoding="utf-8")
            self.assertIn("partial_without_newlineend\n", content)

    def test_adb_tools_submodules_reexported(self) -> None:
        import struct
        from tools.adb_tools import apk_analyze, common, core, device_info, mem_fill, pkg_ops, remote_fs
        from tools.api.routes import adb_fs_routes, adb_ops, adb_pkg_routes
        from tools.emmc_test import auto_runner
        from tools.screenshot.core import _extract_png_dimensions

        self.assertIs(core.AdbCommandResult, common.AdbCommandResult)
        self.assertIs(core.collect_apk_paths, pkg_ops.collect_apk_paths)
        self.assertIs(core.list_remote_entries, remote_fs.list_remote_entries)
        self.assertIs(core.collect_device_card, device_info.collect_device_card)
        self.assertIs(core.fill_device_memory, mem_fill.fill_device_memory)
        self.assertIs(adb_ops._write_upload_to_path, adb_pkg_routes._write_upload_to_path)
        self.assertIs(adb_ops._normalize_push_remote, adb_fs_routes._normalize_push_remote)
        self.assertEqual(remote_fs.join_remote_path("/sdcard/", "Download/"), "/sdcard/Download")
        self.assertEqual(remote_fs.parent_remote_path("/sdcard/Download"), "/sdcard")
        self.assertEqual(auto_runner.AUTO_STEPS, ("iozone", "stress", "reboot", "ota", "rpmb"))
        self.assertFalse(hasattr(settings_store, "bind_app"))
        self.assertFalse(hasattr(auto_runner, "EmmcAutoOrchestrator"))

        # 验证 PNG IHDR + IEND 宽高解析零拷贝直读
        fake_png = (
            b"\x89PNG\r\n\x1a\n"
            + struct.pack(">I", 13)
            + b"IHDR"
            + struct.pack(">II", 1920, 1080)
            + b"\x08\x06\x00\x00\x00"
            + b"\x00\x00\x00\x00"
            + b"\x00\x00\x00\x00IEND\xaeB`\x82"
        )
        self.assertEqual(_extract_png_dimensions(fake_png), (1920, 1080))
        self.assertIsNone(_extract_png_dimensions(b"not_a_png"))

        # 验证 APK 权限单次扫描合并与去重
        yes, no = apk_analyze._merge_grant_sections(
            ["android.permission.INTERNET"],
            [],
            ["android.permission.CAMERA"],
        )
        self.assertEqual(yes, ["android.permission.INTERNET"])
        self.assertEqual(no, ["android.permission.CAMERA"])
        perms = apk_analyze._parse_requested_permissions(
            "requested permissions:\n"
            "  android.permission.INTERNET\n"
            "  android.permission.INTERNET\n"
            "  android.permission.CAMERA\n"
        )
        self.assertEqual(perms, ["android.permission.CAMERA", "android.permission.INTERNET"])


if __name__ == "__main__":
    unittest.main()

