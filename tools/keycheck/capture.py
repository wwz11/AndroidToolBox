#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用 adb getevent 抓一次按键的 HID Usage Page / Usage。

内核 hid-input 通常先上报 EV_MSC MSC_SCAN，数值高 16 位是 Usage Page，
低 16 位是 Usage，随后才是 EV_KEY 按下。一次按键在 SYN_REPORT 时收口。
"""

from __future__ import annotations

import queue
import re
import subprocess
import threading
import time
from dataclasses import dataclass

from tools.adb_runtime import adb_subprocess_env, build_adb_cmd
from tools.adb_runtime import _subprocess_kwargs, adb_available

_EVENT_RE = re.compile(
    r"^(\S+):\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s*$"
)
_EV_SYN = 0x00
_EV_KEY = 0x01
_EV_MSC = 0x04
_MSC_SCAN = 0x04
_SYN_REPORT = 0x00
# 松手之前的极短连发才丢掉。松手后的下一次按下马上算，避免第二次按得快时被吞掉。
_BOUNCE_SEC = 0.18
# getevent 刚打开时的补报只出现在这一小段里。过了这段就按用户的真实按下记。
_STARTUP_SKIP_SEC = 0.6

_lock = threading.Lock()
_jobs: dict[str, "_Job"] = {}


class CaptureBusy(RuntimeError):
    pass


class CaptureTimeout(TimeoutError):
    pass


class CaptureCancelled(RuntimeError):
    pass


class CaptureFailed(RuntimeError):
    pass


@dataclass
class HidPress:
    page: str
    usage: str
    scan: str
    input_dev: str
    key_code: int | None
    page_known: bool

    def message(self) -> str:
        if self.page_known:
            return f"已读取 {self.page} / {self.usage}"
        if self.usage:
            return f"扫描码没有 Usage Page，只读到 Usage {self.usage}"
        code = f"{self.key_code}" if self.key_code is not None else "未知"
        return f"只收到按键码 {code}，没有 HID Usage（MSC_SCAN）"


class _KeyUp:
    """松手，不是一次按下。"""


_KEY_UP = _KeyUp()


@dataclass
class _Burst:
    scan: int | None = None
    key_code: int | None = None
    down: bool = False
    last_scan: int | None = None
    last_key: int | None = None


@dataclass
class _Job:
    proc: subprocess.Popen[bytes]
    cancel: threading.Event


def format_page(value: int) -> str:
    return f"0x{value & 0xFFFF:02X}"


def format_usage(value: int) -> str:
    return f"0x{value & 0xFFFF:04x}"


def split_scan(value: int) -> tuple[str, str, bool]:
    page = (value >> 16) & 0xFFFF
    usage = value & 0xFFFF
    if page:
        return format_page(page), format_usage(usage), True
    if usage:
        return "", format_usage(usage), False
    return "", "", False


def feed_event(bursts: dict[str, _Burst], line: str) -> HidPress | _KeyUp | None:
    """喂一行 getevent。凑齐一次按下并在 SYN_REPORT 时返回。松手返回 _KEY_UP。"""
    match = _EVENT_RE.match(line.strip())
    if not match:
        return None
    dev = match.group(1)
    ev_type = int(match.group(2), 16)
    code = int(match.group(3), 16)
    value = int(match.group(4), 16)
    burst = bursts.setdefault(dev, _Burst())
    if ev_type == _EV_MSC and code == _MSC_SCAN and value:
        burst.scan = value
        return None
    if ev_type == _EV_KEY and value == 0:
        burst.down = False
        return _KEY_UP
    if ev_type == _EV_KEY and value == 1:
        burst.down = True
        burst.key_code = code
        return None
    if ev_type == _EV_SYN and code == _SYN_REPORT and burst.down:
        if burst.scan is None and burst.key_code is not None and burst.key_code == burst.last_key:
            burst.scan = burst.last_scan
        if burst.scan is not None:
            burst.last_scan = burst.scan
            burst.last_key = burst.key_code
        press = _press_from_burst(dev, burst)
        burst.down = False
        burst.scan = None
        burst.key_code = None
        return press
    return None


def _press_from_burst(dev: str, burst: _Burst) -> HidPress:
    page, usage, known = split_scan(burst.scan or 0)
    return HidPress(
        page=page,
        usage=usage,
        scan=f"{burst.scan:08x}" if burst.scan else "",
        input_dev=dev,
        key_code=burst.key_code,
        page_known=known,
    )


def _stop_job(sn: str) -> _Job | None:
    with _lock:
        job = _jobs.pop(sn, None)
    if not job:
        return None
    job.cancel.set()
    proc = job.proc
    if proc.poll() is None:
        proc.kill()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
    return job


def cancel_capture(device: str) -> bool:
    return _stop_job(device.strip()) is not None


def _decode_err(chunks: list[bytes]) -> str:
    return b"".join(chunks).decode("utf-8", errors="replace").strip()


def _fail_message(detail: str) -> str:
    low = detail.lower()
    if "permission" in low or "not permitted" in low:
        return "getevent 没有权限，请先 adb root 后再核对"
    if detail:
        return detail.splitlines()[-1][:240]
    return "getevent 已退出，没有读到按键"


def watch_presses(
    device: str,
    on_press,
    *,
    timeout: float | None = 20.0,
    skip_initial: bool = True,
    on_ready=None,
) -> None:
    """持续读 getevent。每次用户按下调用 on_press；取消或超时则结束。

    timeout 为 None 时不限时，直到取消。skip_initial 只丢掉打开后极短时间内的自动上报，
    不会把用户的第一下一起丢掉。静默期结束后调用 on_ready。
    """
    sn = device.strip()
    if not sn:
        raise CaptureFailed("请先选择设备")
    if not adb_available():
        raise CaptureFailed("未找到 adb")
    if timeout is not None:
        if timeout < 3:
            timeout = 3.0
        if timeout > 3600:
            timeout = 3600.0

    proc = subprocess.Popen(
        build_adb_cmd(["shell", "getevent"], sn),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=adb_subprocess_env(),
        **_subprocess_kwargs(),
    )
    job = _Job(proc=proc, cancel=threading.Event())
    with _lock:
        if sn in _jobs:
            proc.kill()
            raise CaptureBusy("该设备正在等待按键")
        _jobs[sn] = job

    lines: queue.Queue[str | None] = queue.Queue()
    err_box: list[bytes] = []

    def _reader() -> None:
        stdout = proc.stdout
        try:
            if stdout is None:
                return
            for raw in stdout:
                text = raw.decode("utf-8", errors="replace").strip()
                if text:
                    lines.put(text)
        finally:
            lines.put(None)

    def _err_reader() -> None:
        if proc.stderr is None:
            return
        err_box.append(proc.stderr.read())

    threading.Thread(target=_reader, name=f"key-capture-{sn}", daemon=True).start()
    threading.Thread(target=_err_reader, name=f"key-capture-err-{sn}", daemon=True).start()
    bursts: dict[str, _Burst] = {}
    started = time.monotonic()
    skip_until = started + (_STARTUP_SKIP_SEC if skip_initial else 0.0)
    ready_sent = False
    last_press_at = 0.0
    released = True
    deadline = threading.Event()
    timer: threading.Timer | None = None
    if timeout is not None:
        timer = threading.Timer(timeout, deadline.set)
        timer.daemon = True
        timer.start()
    def _arm_ready(now: float) -> None:
        nonlocal ready_sent
        if ready_sent or now < skip_until:
            return
        ready_sent = True
        if on_ready is not None:
            on_ready()

    try:
        while True:
            if job.cancel.is_set():
                raise CaptureCancelled("已取消")
            if deadline.is_set():
                raise CaptureTimeout("等待超时，请再按一次该键")
            now = time.monotonic()
            _arm_ready(now)
            try:
                line = lines.get(timeout=0.2)
            except queue.Empty:
                continue
            if line is None:
                if job.cancel.is_set():
                    raise CaptureCancelled("已取消")
                try:
                    proc.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    pass
                raise CaptureFailed(_fail_message(_decode_err(err_box)))
            press = feed_event(bursts, line)
            if press is _KEY_UP:
                released = True
                continue
            if not isinstance(press, HidPress):
                continue
            now = time.monotonic()
            # 打开瞬间的补报丢掉，且不占用下一次按下的时间。
            if now < skip_until:
                continue
            _arm_ready(now)
            if not released and last_press_at and now - last_press_at < _BOUNCE_SEC:
                continue
            released = False
            last_press_at = now
            on_press(press)
    finally:
        if timer is not None:
            timer.cancel()
        _stop_job(sn)


def capture_one_press(device: str, timeout: float = 20.0) -> HidPress:
    """阻塞到用户按下一次键，或超时 / 取消。"""
    found: list[HidPress] = []

    def _take(press: HidPress) -> None:
        found.append(press)
        cancel_capture(device)

    try:
        watch_presses(device, _take, timeout=timeout, skip_initial=True)
    except CaptureCancelled:
        if not found:
            raise
    if not found:
        raise CaptureCancelled("已取消")
    return found[0]
