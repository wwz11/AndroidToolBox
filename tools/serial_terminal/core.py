#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""串口通信与日志。"""

from __future__ import annotations

import re
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Callable

BAUD_PRESETS: tuple[int, ...] = (
    9600,
    19200,
    38400,
    57600,
    115200,
    230400,
    460800,
    921600,
    1500000,
    2000000,
)


def pyserial_available() -> bool:
    try:
        import serial  # noqa: F401

        return True
    except ImportError:
        return False


def list_port_choices() -> list[str]:
    """返回 COM 口显示列表，如 COM3 - USB Serial。"""
    if not pyserial_available():
        return []
    from serial.tools import list_ports

    out: list[str] = []
    try:
        infos = list(list_ports.comports())
    except Exception:
        return []
    for info in infos:
        desc = (info.description or "").strip()
        # 用 ASCII 连字符，避免部分控制台/代理把 em dash 弄乱
        label = info.device if not desc else f"{info.device} - {desc}"
        out.append(label)
    return sorted(out, key=lambda s: s.upper())


def port_from_choice(choice: str) -> str:
    """从下拉项解析设备名（COMx）。"""
    s = choice.strip()
    if not s:
        return ""
    for sep in (" - ", " — ", "—"):
        if sep in s:
            return s.split(sep, 1)[0].strip()
    return s.split("—", 1)[0].strip()


def pick_serial_port_after_refresh(current: str, ports: list[str]) -> str:
    """刷新后保留仍在线的端口，仅当前端口不可用时改选第一项。"""
    cur = (current or "").strip()
    online = [p.strip() for p in ports if p and p.strip()]
    if cur and cur in online:
        return cur
    if online:
        return online[0]
    return ""


def format_serial_open_error(exc: BaseException, port: str) -> str:
    """把 pyserial / Windows 串口打开失败转成可读说明。"""
    text = str(exc).strip() or type(exc).__name__
    # open() 已包装过时，API/GUI 再次调用会重复「无法打开」与 tip；直接返回
    if text.startswith("无法打开 ") or "\n请确认端口仍在线" in text or "\n设备未就绪" in text:
        return text

    # 优先用最内层原始异常（SerialException / OSError）提取 WinError
    root: BaseException = exc
    while getattr(root, "__cause__", None) is not None:
        root = root.__cause__  # type: ignore[assignment]

    raw = str(root).strip() or type(root).__name__
    # 若外层已是 RuntimeError(format...)，上面已早退；此处 raw 为底层串口错误
    winerr = getattr(root, "winerror", None)
    if winerr is None:
        # PermissionError(13, '...', None, 31) / OSError(22, '...', None, 1) → args
        args = getattr(root, "args", ())
        if len(args) >= 4 and isinstance(args[3], int):
            winerr = args[3]
        elif len(args) >= 1 and isinstance(args[0], int) and args[0] in (
            5,
            22,
            31,
            32,
            2,
            1167,
        ):
            winerr = args[0]
        elif "Original message" in raw and "31" in raw:
            winerr = 31
        elif "PermissionError(13" in raw or "Access is denied" in raw:
            winerr = 5
        elif "函数不正确" in raw or "Incorrect function" in raw:
            winerr = 22

    tips: list[str] = []
    if winerr in (31, 2, 1167) or "没有作用" in raw or "not functioning" in raw.lower():
        tips = [
            "设备未就绪或驱动异常（常见于 USB 转串口刚插上/掉线后）。",
            "请检查：线缆是否松动、设备是否上电、设备管理器中该 COM 口是否正常。",
            "可先拔插 USB，点「刷新」后再打开；并确认未被其他程序或其它串口标签页占用（SecureCRT、Putty、烧录工具等）。",
        ]
    elif winerr == 22 or "函数不正确" in raw or "Incorrect function" in raw:
        tips = [
            "系统返回「函数不正确」(WinError 22)：常见于驱动异常、虚拟/蓝牙串口不稳，或端口句柄已失效。",
            "建议在设备管理器中禁用再启用该 COM，拔插 USB 后点「刷新」，并关闭其他占用该端口的程序后重试。",
        ]
    elif winerr in (5, 32) or "PermissionError" in type(root).__name__ or "Access is denied" in raw:
        tips = [
            "端口被占用或无权限打开。",
            "请关闭其他已打开该 COM 的软件；并检查 Toolbox 其它串口标签页是否已连接同一端口。",
        ]
    else:
        tips = [
            "请确认端口仍在线，并关闭其他占用该 COM 的程序后重试。",
        ]

    lines = [f"无法打开 {port}", "", raw, ""]
    lines.extend(tips)
    return "\n".join(lines)


def normalize_terminal_display(text: str) -> str:
    """Text 控件不模拟 \\r 覆写，将终端换行规范为 LF 并去掉多余空行。"""
    if not text:
        return ""
    text = text.replace("\r\n", "\n")
    text = text.replace("\r", "\n")
    text = re.sub(r"\n{2,}", "\n", text)
    return text


def parse_send_lines(text: str) -> list[str]:
    """从多行文本解析待发送行（去空行与 # 注释）。"""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    out: list[str] = []
    for line in normalized.split("\n"):
        s = line.strip()
        if s and not s.startswith("#"):
            out.append(s)
    return out


def default_log_path(port: str) -> Path:
    """每次打开串口生成带时间戳的新日志（安装目录 userdata/logs/serial）。"""
    from tools.bundled_paths import logs_dir

    safe = port.replace("\\", "_").replace("/", "_").replace(":", "")
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return logs_dir("serial") / f"serial_{safe}_{ts}.log"


def timestamp_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def _escape_payload(text: str) -> str:
    return text.replace("\r", "\\r").replace("\n", "\\n")


def sanitize_for_log(text: str) -> str:
    """日志中去掉 \\r，并裁掉尾部换行（界面仍保留原始数据）。"""
    if not text:
        return ""
    s = text.replace("\r", "")
    return s.rstrip("\n")


def stamp_block(direction: str, text: str, *, escape_payload: bool = False) -> str:
    """为一段完整数据加一条时间戳（不按字节拆分）。"""
    if not text:
        return ""
    body = _escape_payload(text) if escape_payload else text
    return f"[{timestamp_str()}] {direction} {body}"


def format_stamped(direction: str, text: str, *, escape_payload: bool = False) -> str:
    """为串口数据加时间戳；按行分段（同一批数据共用同一时间）。"""
    if not text:
        return ""
    ts = timestamp_str()
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        j = i
        while j < n and text[j] not in "\r\n":
            j += 1
        line = text[i:j]
        i = j
        ending = ""
        while i < n and text[i] in "\r\n":
            ending += text[i]
            i += 1
        if not line and not ending:
            continue
        payload = line + ending
        if escape_payload:
            payload = _escape_payload(line) + ending
        out.append(f"[{ts}] {direction} {payload}")
    return "".join(out)


def format_log_line(direction: str, payload: str) -> str:
    body_text = sanitize_for_log(payload)
    if not body_text.strip():
        return ""
    body = stamp_block(direction, body_text, escape_payload=False)
    if body and not body.endswith("\n"):
        return body + "\n"
    return body


class RxLineBuffer:
    """合并零碎读入；遇换行或空闲超时后输出一条带时间戳的 RX。"""

    def __init__(self, *, idle_flush_s: float = 0.08) -> None:
        self._buf = ""
        self._idle_flush_s = idle_flush_s

    def push(self, chunk: str) -> list[str]:
        if not chunk:
            return []
        self._buf += chunk
        return self._drain_lines()

    def flush_idle(self) -> list[str]:
        if not self._buf:
            return []
        block = self._buf
        self._buf = ""
        line = stamp_block("RX", block)
        return [line] if line else []

    def flush_all(self) -> list[str]:
        return self.flush_idle()

    def has_pending(self) -> bool:
        return bool(self._buf)

    def _drain_lines(self) -> list[str]:
        out: list[str] = []
        while self._buf:
            break_at = -1
            for i, ch in enumerate(self._buf):
                if ch in "\r\n":
                    break_at = i
                    break
            if break_at < 0:
                break
            end = break_at + 1
            while end < len(self._buf) and self._buf[end] in "\r\n":
                end += 1
            block = self._buf[:end]
            self._buf = self._buf[end:]
            line = stamp_block("RX", block)
            if line:
                out.append(line)
        return out


class SerialConnection:
    """单路串口：后台读线程 + 可选写日志文件。"""

    def __init__(
        self,
        *,
        on_rx: Callable[[str], None],
        on_status: Callable[[str], None],
        on_error: Callable[[str], None],
        on_lost: Callable[[str], None] | None = None,
        # raw（默认）：on_rx 推原样字节流（桌面 xterm）；False：打戳行（Tk 旧 UI）
        ui_raw: bool = True,
    ) -> None:
        self._on_rx = on_rx
        self._on_status = on_status
        self._on_error = on_error
        self._on_lost = on_lost or (lambda _msg: None)
        self._ui_raw = bool(ui_raw)
        self._ser = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._log_lock = threading.Lock()
        self._log_file = None
        self._log_path: Path | None = None
        self.port = ""
        self.baudrate = 115200
        self._rx_buffer = RxLineBuffer()
        self._read_coalesce_s = 0.02
        self._last_rx_at = 0.0
        self._rx_idle_flush_s = 0.08

    @property
    def is_open(self) -> bool:
        return self._ser is not None and getattr(self._ser, "is_open", False)

    @property
    def log_path(self) -> Path | None:
        return self._log_path

    def set_log_target(self, path: Path | None, *, enabled: bool) -> None:
        with self._log_lock:
            self._close_log_file()
            if enabled and path is not None:
                path.parent.mkdir(parents=True, exist_ok=True)
                self._log_file = path.open("a", encoding="utf-8", newline="\n")
                self._log_path = path
            else:
                self._log_path = None

    def _close_log_file(self) -> None:
        if self._log_file is not None:
            try:
                self._log_file.close()
            except Exception:
                pass
            self._log_file = None

    def _write_log(self, direction: str, payload: str) -> None:
        line = format_log_line(direction, payload)
        if not line:
            return
        with self._log_lock:
            if self._log_file is not None:
                try:
                    self._log_file.write(line)
                    self._log_file.flush()
                except OSError as e:
                    self._on_error(f"写日志失败: {e}")

    def open(self, port: str, baudrate: int) -> None:
        if not pyserial_available():
            raise RuntimeError("未安装 pyserial（pip install pyserial）")
        if self.is_open:
            raise RuntimeError("串口已打开")
        import serial
        from serial import SerialException

        self.port = port
        self.baudrate = int(baudrate)
        last_err: BaseException | None = None
        # Windows 上偶发 WinError 31 / PermissionError(13)：设备刚枚举或句柄未释放，多次重试
        retry_delays = (0.0, 0.4, 0.8)
        for attempt, delay in enumerate(retry_delays):
            if delay > 0:
                time.sleep(delay)
            ser = None
            try:
                ser = serial.Serial()
                ser.port = port
                ser.baudrate = self.baudrate
                ser.timeout = 0.05
                ser.write_timeout = 2.0
                ser.open()
                self._ser = ser
                last_err = None
                break
            except (SerialException, OSError, PermissionError) as e:
                last_err = e
                if ser is not None:
                    try:
                        ser.close()
                    except Exception:
                        pass
                if attempt + 1 >= len(retry_delays):
                    raise RuntimeError(format_serial_open_error(e, port)) from e
        if last_err is not None and self._ser is None:
            raise RuntimeError(format_serial_open_error(last_err, port)) from last_err

        self._rx_buffer = RxLineBuffer()
        self._stop.clear()
        self._thread = threading.Thread(target=self._read_loop, daemon=True)
        self._thread.start()
        header = f"[{timestamp_str()}] --- 打开 {port} @ {self.baudrate} ---\n"
        with self._log_lock:
            if self._log_file is not None:
                try:
                    self._log_file.write(header)
                    self._log_file.flush()
                except OSError:
                    pass
        self._on_status(f"已打开 {port} @ {self.baudrate}")

    def close(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1.5)
            self._thread = None
        for line in self._rx_buffer.flush_all():
            if self._ui_raw:
                self._write_log_stamped(line)
            else:
                self._emit_rx_stamped(line)
        if self._ser is not None:
            try:
                if self._ser.is_open:
                    self._ser.close()
            except Exception:
                pass
            self._ser = None
        footer = f"[{timestamp_str()}] --- 关闭 {self.port} ---\n"
        with self._log_lock:
            if self._log_file is not None:
                try:
                    self._log_file.write(footer)
                    self._log_file.flush()
                except OSError:
                    pass
        self._on_status("已关闭")

    def send_text(self, text: str, *, log: bool = True, status: bool = True) -> None:
        if not self.is_open or self._ser is None:
            raise RuntimeError("串口未打开")
        data = text.encode("utf-8", errors="replace")
        self._ser.write(data)
        if log:
            self._write_log("TX", text)
        if status:
            self._on_status(f"已发送 {len(data)} 字节")

    def flush_rx_idle(self) -> None:
        for line in self._rx_buffer.flush_idle():
            if self._ui_raw:
                # UI 已在收包时推送原文；此处只补写落盘日志
                self._write_log_stamped(line)
            else:
                self._emit_rx_stamped(line)

    @staticmethod
    def _stamped_payload(stamped: str) -> str | None:
        for tag in ("] RX ", "] TX ", "] ERR "):
            if tag in stamped:
                return stamped.split(tag, 1)[1]
        return None

    @staticmethod
    def _is_blank_serial(payload: str) -> bool:
        return not payload.strip("\r\n\t ")

    def _emit_rx_stamped(self, stamped: str) -> None:
        if not stamped:
            return
        payload = self._stamped_payload(stamped)
        if payload is not None and self._is_blank_serial(payload):
            return
        self._write_log_stamped(stamped)
        self._on_rx(stamped)

    def _emit_rx_raw(self, text: str) -> None:
        """xterm：立刻推送原文；同时按行打戳写入日志文件。"""
        if not text:
            return
        self._on_rx(text)
        for stamped in self._rx_buffer.push(text):
            payload = self._stamped_payload(stamped)
            if payload is not None and self._is_blank_serial(payload):
                continue
            self._write_log_stamped(stamped)

    def _write_log_stamped(self, stamped: str) -> None:
        if "] RX " in stamped:
            direction, payload = "RX", stamped.split("] RX ", 1)[1]
        elif "] TX " in stamped:
            direction, payload = "TX", stamped.split("] TX ", 1)[1]
        elif "] ERR " in stamped:
            direction, payload = "ERR", stamped.split("] ERR ", 1)[1]
        else:
            log_line = stamped if stamped.endswith("\n") else stamped + "\n"
            with self._log_lock:
                if self._log_file is not None:
                    try:
                        self._log_file.write(log_line)
                        self._log_file.flush()
                    except OSError as e:
                        self._on_error(f"写日志失败: {e}")
            return
        log_line = format_log_line(direction, payload)
        if not log_line:
            return
        with self._log_lock:
            if self._log_file is not None:
                try:
                    self._log_file.write(log_line)
                    self._log_file.flush()
                except OSError as e:
                    self._on_error(f"写日志失败: {e}")

    def _read_coalesced(self) -> bytes:
        assert self._ser is not None
        waiting = self._ser.in_waiting
        if waiting <= 0:
            first = self._ser.read(1)
            if not first:
                return b""
            parts = [first]
        else:
            parts = [self._ser.read(waiting)]
        deadline = time.monotonic() + self._read_coalesce_s
        while time.monotonic() < deadline and not self._stop.is_set():
            extra = self._ser.in_waiting
            if extra > 0:
                parts.append(self._ser.read(extra))
                deadline = time.monotonic() + self._read_coalesce_s
            else:
                time.sleep(0.003)
        return b"".join(parts)

    def _read_loop(self) -> None:
        assert self._ser is not None
        while not self._stop.is_set():
            try:
                buf = self._read_coalesced()
                if not buf:
                    if (
                        self._rx_buffer.has_pending()
                        and self._last_rx_at > 0
                        and time.monotonic() - self._last_rx_at >= self._rx_idle_flush_s
                    ):
                        self.flush_rx_idle()
                    else:
                        time.sleep(0.01)
                    continue
                self._last_rx_at = time.monotonic()
                text = buf.decode("utf-8", errors="replace")
                if self._ui_raw:
                    self._emit_rx_raw(text)
                else:
                    for stamped in self._rx_buffer.push(text):
                        self._emit_rx_stamped(stamped)
            except Exception as e:
                if not self._stop.is_set():
                    reason = str(e).strip() or type(e).__name__
                    self._on_error(reason)
                    self._stop.set()
                    self._on_lost(reason)
                break

    def shutdown(self) -> None:
        try:
            self.close()
        except Exception:
            pass
        with self._log_lock:
            self._close_log_file()
