#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""交互式 adb shell（持久会话，输出与 CMD 中 adb shell 一致）。"""

from __future__ import annotations

import subprocess
import threading
import time
from collections.abc import Callable

from tools.adb_runtime import adb_subprocess_env, build_adb_cmd
from tools.adb_tools.core import decode_adb_pipe_bytes
from tools.adb_runtime import _subprocess_kwargs

OnData = Callable[[str], None]
OnExit = Callable[[int | None], None]


class AdbInteractiveShell:
    """维持 ``adb shell``（优先 ``-t``），按行写入 stdin，原样读出 stdout。"""

    def __init__(
        self,
        *,
        on_data: OnData,
        on_exit: OnExit,
    ) -> None:
        self._on_data = on_data
        self._on_exit = on_exit
        self._proc: subprocess.Popen[bytes] | None = None
        self._device: str | None = None
        self._reader: threading.Thread | None = None
        self._write_lock = threading.Lock()
        self._io_lock = threading.Lock()
        self._stopping = False

    @property
    def device(self) -> str | None:
        return self._device

    @property
    def active(self) -> bool:
        with self._io_lock:
            return self._proc is not None and self._proc.poll() is None

    def start(self, device: str) -> None:
        """在后台线程调用；勿在主线程阻塞读 stdout。"""
        self.stop()
        with self._io_lock:
            last_err: Exception | None = None
            # 管道 stdin 时需双 -t 才能强制远端 PTY（与 cmd 中 ls 多列一致）
            for shell_args in (["shell", "-t", "-t"], ["shell", "-t"], ["shell"]):
                cmd = build_adb_cmd(shell_args, device)
                try:
                    proc = subprocess.Popen(
                        cmd,
                        stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        bufsize=0,
                        env=adb_subprocess_env(),
                        **_subprocess_kwargs(),
                    )
                except OSError as e:
                    last_err = e
                    continue

                if proc.poll() is not None:
                    last_err = RuntimeError(
                        f"adb shell 立即退出 (exit {proc.returncode})"
                    )
                    continue

                self._proc = proc
                self._device = device
                self._stopping = False
                self._reader = threading.Thread(
                    target=self._read_loop,
                    name="adb-shell-reader",
                    daemon=True,
                )
                self._reader.start()
                return

            raise RuntimeError(f"无法启动 adb shell: {last_err}") from last_err

    def stop(self) -> None:
        with self._io_lock:
            self._stopping = True
            proc = self._proc
            self._proc = None
            self._device = None
            reader = self._reader
            self._reader = None

        if proc is None:
            self._stopping = False
            return
        try:
            if proc.stdin:
                proc.stdin.close()
        except OSError:
            pass
        try:
            proc.terminate()
        except OSError:
            pass
        try:
            proc.wait(timeout=2)
        except (subprocess.TimeoutExpired, OSError):
            try:
                proc.kill()
            except OSError:
                pass
        if reader is not None:
            reader.join(timeout=2)
        self._stopping = False

    def send_raw(self, data: bytes | str) -> None:
        """向 shell 写入原始字节（用于 Tab 补全、方向键、逐键输入等）。"""
        payload = data.encode("utf-8") if isinstance(data, str) else data
        if not payload:
            return
        # 单独 CR 在管道 adb shell 上往往不会提交行；与 send_line / xterm 侧对齐为 LF
        if payload == b"\r":
            payload = b"\n"
        with self._io_lock:
            proc = self._proc
            if proc is None or proc.poll() is not None or proc.stdin is None:
                raise RuntimeError("adb shell 未连接")
            stdin = proc.stdin
        with self._write_lock:
            stdin.write(payload)
            stdin.flush()

    def send_line(self, line: str) -> None:
        self.send_raw(line + "\n")

    def send_interrupt(self) -> None:
        """向 shell 发送 Ctrl+C（中断 logcat 等前台命令）。"""
        self.send_raw(b"\x03")

    def _read_loop(self) -> None:
        with self._io_lock:
            proc = self._proc
        if proc is None or proc.stdout is None:
            return
        stream = proc.stdout
        try:
            while proc.poll() is None:
                try:
                    chunk = stream.read(4096)
                except OSError:
                    break
                if chunk:
                    self._on_data(decode_adb_pipe_bytes(chunk))
                else:
                    time.sleep(0.02)
            try:
                tail = stream.read()
            except OSError:
                tail = b""
            if tail:
                self._on_data(decode_adb_pipe_bytes(tail))
        except OSError:
            pass
        finally:
            if not self._stopping:
                self._on_exit(proc.poll())
