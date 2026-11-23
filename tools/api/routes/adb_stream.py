#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ADB 交互式 Shell / 持续 Logcat WebSocket。"""

from __future__ import annotations

import asyncio
import json
import tempfile
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from tools.adb_tools.capture_session import ensure_session, logcat_filename
from tools.adb_tools.core import LogcatSession, adb_package_pids
from tools.adb_tools.interactive_shell import AdbInteractiveShell
from tools.bundled_paths import logs_dir

router = APIRouter()

# 持续 logcat：合并多行再推送，减轻前端 setState / WS 风暴
_LOGCAT_BATCH_LINES = 48
_LOGCAT_BATCH_MS = 0.12


def _shell_log_path(sn: str) -> Path:
    """Shell 自动落盘：adb_shell_设备_时间戳.log（与 log 抓命名一致带设备号）。"""
    safe = "".join(c if c.isalnum() or c in "-._" else "_" for c in sn) or "device"
    safe = safe[:48]
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return logs_dir("shell") / f"adb_shell_{safe}_{ts}.log"


class _ShellSessionLog:
    """线程安全地把交互 Shell 输出追加到 userdata/logs/shell。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._file = None
        self._unflushed_chars = 0
        self.path: Path | None = None

    def set_target(self, path: Path | None, enabled: bool = True) -> None:
        with self._lock:
            self._close_unlocked()
            if enabled and path is not None:
                path.parent.mkdir(parents=True, exist_ok=True)
                self._file = path.open("a", encoding="utf-8", errors="replace", newline="")
                self._unflushed_chars = 0
                self.path = path
            else:
                self.path = None

    def write(self, text: str) -> None:
        if not text:
            return
        with self._lock:
            fp = self._file
            if fp is None:
                return
            try:
                fp.write(text)
                self._unflushed_chars += len(text)
                if "\n" in text or self._unflushed_chars >= 4096:
                    fp.flush()
                    self._unflushed_chars = 0
            except OSError:
                pass

    def close(self) -> None:
        with self._lock:
            self._close_unlocked()

    def _close_unlocked(self) -> None:
        if self._file is not None:
            try:
                self._file.flush()
                self._file.close()
            except Exception:
                pass
            self._file = None
        self._unflushed_chars = 0
        self.path = None


def _require_sn(device: str) -> str:
    sn = (device or "").strip()
    if not sn or sn == "未选设备":
        raise ValueError("请先选择设备 SN")
    return sn


class _LogcatLineBatcher:
    """线程安全：积攒行后批量 push，避免每行一条 WS 消息。"""

    def __init__(
        self,
        push: Callable[[dict[str, Any]], None],
        *,
        max_lines: int = _LOGCAT_BATCH_LINES,
        flush_s: float = _LOGCAT_BATCH_MS,
    ) -> None:
        self._push = push
        self._max_lines = max_lines
        self._flush_s = flush_s
        self._lock = threading.Lock()
        self._buf: list[str] = []
        self._timer: threading.Timer | None = None
        self._closed = False

    def add(self, line: str) -> None:
        with self._lock:
            if self._closed:
                return
            self._buf.append(line)
            if len(self._buf) >= self._max_lines:
                self._flush_locked()
            elif self._timer is None:
                t = threading.Timer(self._flush_s, self._on_timer)
                t.daemon = True
                self._timer = t
                t.start()

    def _on_timer(self) -> None:
        with self._lock:
            self._timer = None
            if self._closed:
                return
            self._flush_locked()

    def _flush_locked(self) -> None:
        if self._timer is not None:
            try:
                self._timer.cancel()
            except Exception:
                pass
            self._timer = None
        if not self._buf:
            return
        batch = self._buf
        self._buf = []
        self._push({"type": "lines", "texts": batch})

    def flush(self) -> None:
        with self._lock:
            self._flush_locked()

    def close(self, *, discard: bool = False) -> None:
        with self._lock:
            self._closed = True
            if self._timer is not None:
                try:
                    self._timer.cancel()
                except Exception:
                    pass
                self._timer = None
            if discard:
                self._buf = []
                return
            self._flush_locked()


def _enqueue_stream_bounded(
    queue: asyncio.Queue[dict[str, Any]], msg: dict[str, Any]
) -> None:
    """有界队列入队：高频 Shell/Logcat 输出且前端消费滞后时，丢弃最旧消息防止内存无限堆积。"""
    if queue.full():
        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:
            pass
    try:
        queue.put_nowait(msg)
    except asyncio.QueueFull:
        pass


async def _pump(queue: asyncio.Queue[dict[str, Any]], websocket: WebSocket) -> None:
    while True:
        msg = await queue.get()
        if websocket.client_state != WebSocketState.CONNECTED:
            break
        await websocket.send_json(msg)


@router.websocket("/shell/ws")
async def interactive_shell_ws(
    websocket: WebSocket,
    device: str = Query(...),
) -> None:
    await websocket.accept()
    try:
        sn = _require_sn(device)
    except ValueError as exc:
        await websocket.send_json({"type": "error", "text": str(exc)})
        await websocket.close()
        return

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=1500)
    shell_holder: dict[str, AdbInteractiveShell | None] = {"s": None}
    slog = _ShellSessionLog()

    def push(msg: dict[str, Any]) -> None:
        try:
            loop.call_soon_threadsafe(_enqueue_stream_bounded, queue, msg)
        except Exception:
            pass

    def on_shell_data(text: str) -> None:
        slog.write(text)
        push({"type": "data", "text": text})

    out_task = asyncio.create_task(_pump(queue, websocket))
    try:
        await websocket.send_json({"type": "hello", "device": sn})
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "text": "无效 JSON"})
                continue
            kind = (data.get("type") or "").strip()
            if kind == "start":
                old = shell_holder["s"]
                if old is not None:
                    await asyncio.to_thread(old.stop)
                slog.close()
                auto_log = bool(data.get("auto_log", True))
                shell = AdbInteractiveShell(
                    on_data=on_shell_data,
                    on_exit=lambda code: push({"type": "exit", "code": code}),
                )
                try:
                    await asyncio.to_thread(shell.start, sn)
                    shell_holder["s"] = shell
                    await websocket.send_json({"type": "started", "device": sn})
                    if auto_log:
                        path = _shell_log_path(sn)
                        await asyncio.to_thread(slog.set_target, path, True)
                        await websocket.send_json(
                            {
                                "type": "log",
                                "enabled": True,
                                "path": str(path.resolve()),
                            }
                        )
                    else:
                        await websocket.send_json(
                            {"type": "log", "enabled": False, "path": ""}
                        )
                except Exception as exc:
                    await websocket.send_json({"type": "error", "text": str(exc)})
                    await websocket.send_json(
                        {"type": "log", "enabled": False, "path": ""}
                    )
            elif kind == "send":
                shell = shell_holder["s"]
                line = str(data.get("text") or "")
                if shell is None or not shell.active:
                    await websocket.send_json({"type": "error", "text": "Shell 未启动"})
                    continue
                try:
                    await asyncio.to_thread(shell.send_line, line.rstrip("\r\n"))
                except Exception as exc:
                    await websocket.send_json({"type": "error", "text": str(exc)})
            elif kind == "raw":
                # 原始按键：Tab 补全 / 方向键 / 逐字输入，与 CMD 中 adb shell 一致
                shell = shell_holder["s"]
                if shell is None or not shell.active:
                    await websocket.send_json({"type": "error", "text": "Shell 未启动"})
                    continue
                text = data.get("text")
                hex_data = data.get("hex")
                try:
                    if isinstance(hex_data, str) and hex_data:
                        raw_bytes = bytes.fromhex(hex_data)
                    else:
                        raw_bytes = str(text or "").encode("utf-8")
                    if raw_bytes:
                        await asyncio.to_thread(shell.send_raw, raw_bytes)
                except Exception as exc:
                    await websocket.send_json({"type": "error", "text": str(exc)})
            elif kind == "interrupt":
                shell = shell_holder["s"]
                if shell is None:
                    continue
                try:
                    await asyncio.to_thread(shell.send_interrupt)
                except Exception as exc:
                    await websocket.send_json({"type": "error", "text": str(exc)})
            elif kind == "stop":
                shell = shell_holder["s"]
                if shell is not None:
                    await asyncio.to_thread(shell.stop)
                    shell_holder["s"] = None
                await websocket.send_json({"type": "stopped"})
            elif kind == "set_log":
                enabled = bool(data.get("enabled", True))
                raw_path = str(data.get("path") or "").strip()
                try:
                    if not enabled:
                        await asyncio.to_thread(slog.set_target, None, False)
                        await websocket.send_json(
                            {"type": "log", "enabled": False, "path": ""}
                        )
                    else:
                        path = Path(raw_path) if raw_path else _shell_log_path(sn)
                        await asyncio.to_thread(slog.set_target, path, True)
                        await websocket.send_json(
                            {
                                "type": "log",
                                "enabled": True,
                                "path": str(path.resolve()),
                            }
                        )
                except Exception as exc:
                    await websocket.send_json({"type": "error", "text": str(exc)})
            else:
                await websocket.send_json({"type": "error", "text": f"未知类型: {kind}"})
    except WebSocketDisconnect:
        pass
    finally:
        out_task.cancel()
        slog.close()
        shell = shell_holder["s"]
        if shell is not None:
            try:
                shell.stop()
            except Exception:
                pass


@router.websocket("/logcat/ws")
async def logcat_stream_ws(
    websocket: WebSocket,
    device: str = Query(...),
) -> None:
    await websocket.accept()
    try:
        sn = _require_sn(device)
    except ValueError as exc:
        await websocket.send_json({"type": "error", "text": str(exc)})
        await websocket.close()
        return

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=1500)
    session_holder: dict[str, LogcatSession | None] = {"s": None}
    batcher_holder: dict[str, _LogcatLineBatcher | None] = {"b": None}
    tmp_dir: tempfile.TemporaryDirectory[str] | None = None

    def push(msg: dict[str, Any]) -> None:
        try:
            loop.call_soon_threadsafe(_enqueue_stream_bounded, queue, msg)
        except Exception:
            pass

    def close_batcher(*, discard: bool = False) -> None:
        b = batcher_holder["b"]
        batcher_holder["b"] = None
        if b is not None:
            try:
                b.close(discard=discard)
            except Exception:
                pass

    def drain_queue() -> None:
        """丢掉已排队但尚未发出的预览行，避免停止后继续刷屏。"""
        while True:
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                break

    out_task = asyncio.create_task(_pump(queue, websocket))
    try:
        await websocket.send_json({"type": "hello", "device": sn})
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "text": "无效 JSON"})
                continue
            kind = (data.get("type") or "").strip()
            if kind == "start":
                old = session_holder["s"]
                if old is not None:
                    await asyncio.to_thread(old.stop)
                    session_holder["s"] = None
                close_batcher(discard=True)
                drain_queue()
                if tmp_dir is not None:
                    try:
                        tmp_dir.cleanup()
                    except Exception:
                        pass
                    tmp_dir = None
                auto_save = bool(data.get("auto_save", True))
                session_hint = str(data.get("session") or "")
                pkg = str(data.get("package") or "").strip()
                pid = str(data.get("pid") or "").strip()
                tag_str = str(data.get("tag") or "")
                if pkg and not pid:
                    try:
                        pids = await asyncio.to_thread(adb_package_pids, sn, pkg)
                    except Exception as exc:
                        await websocket.send_json({"type": "error", "text": str(exc)})
                        continue
                    if not pids:
                        await websocket.send_json(
                            {"type": "error", "text": f"应用 {pkg} 当前未运行（未获取到 PID）"}
                        )
                        continue
                    pid = pids[0]
                try:
                    rotate_mb = max(0.0, float(data.get("rotate_mb") or 0.0))
                except (TypeError, ValueError):
                    rotate_mb = 0.0
                if auto_save:
                    session_dir = await asyncio.to_thread(
                        ensure_session,
                        sn,
                        session_hint=session_hint,
                    )
                    out = session_dir / logcat_filename(
                        "logcat_live",
                        device=sn,
                        buffer=str(data.get("buffer") or ""),
                        tag=tag_str or pkg,
                        level=str(data.get("level") or ""),
                    )
                else:
                    tmp_dir = tempfile.TemporaryDirectory(prefix="toolbox_logcat_live_")
                    out = Path(tmp_dir.name) / "live.log"
                batcher = _LogcatLineBatcher(push)
                batcher_holder["b"] = batcher
                sess_box: dict[str, LogcatSession | None] = {"s": None}

                def on_session_exit(unexpected: bool, detail: str) -> None:
                    # 仅处理当前会话的意外结束；用户 stop 走 stop 分支
                    if not unexpected:
                        return
                    mine = sess_box["s"]
                    if mine is None:
                        return
                    cur = session_holder["s"]
                    if cur is not None and cur is not mine:
                        return
                    session_holder["s"] = None
                    sess_box["s"] = None
                    close_batcher(discard=False)
                    push(
                        {
                            "type": "ended",
                            "text": detail or "logcat 进程已结束（设备可能断开）",
                        }
                    )

                def on_session_rotate(next_path: Path) -> None:
                    if auto_save:
                        push({"type": "rotated", "path": str(next_path)})

                sess = LogcatSession(
                    sn,
                    out,
                    buffer=str(data.get("buffer") or ""),
                    tag=tag_str,
                    level=str(data.get("level") or ""),
                    pid=pid,
                    rotate_mb=rotate_mb if auto_save else 0.0,
                    on_line=batcher.add,
                    on_exit=on_session_exit,
                    on_rotate=on_session_rotate,
                )
                sess_box["s"] = sess
                session_holder["s"] = sess
                try:
                    path = await asyncio.to_thread(sess.start)
                    await websocket.send_json(
                        {
                            "type": "started",
                            "path": str(path),
                            "auto_save": auto_save,
                            "pid": pid,
                            "session": str(path.parent) if auto_save else "",
                        }
                    )
                except Exception as exc:
                    if session_holder["s"] is sess:
                        session_holder["s"] = None
                    sess_box["s"] = None
                    close_batcher(discard=True)
                    await websocket.send_json({"type": "error", "text": str(exc)})
            elif kind == "mark":
                sess = session_holder["s"]
                if sess is not None and sess.running:
                    note = str(data.get("note") or "")
                    await asyncio.to_thread(sess.append_mark, note)
            elif kind == "stop":
                # 先切断预览推送，再停进程，避免停止后仍有输出
                close_batcher(discard=True)
                drain_queue()
                sess = session_holder["s"]
                session_holder["s"] = None
                if sess is not None:
                    await asyncio.to_thread(sess.stop)
                drain_queue()
                await websocket.send_json({"type": "stopped"})
            else:
                await websocket.send_json({"type": "error", "text": f"未知类型: {kind}"})
    except WebSocketDisconnect:
        pass
    finally:
        out_task.cancel()
        sess = session_holder["s"]
        session_holder["s"] = None
        if sess is not None:
            try:
                sess.stop()
            except Exception:
                pass
        close_batcher(discard=True)
        if tmp_dir is not None:
            try:
                tmp_dir.cleanup()
            except Exception:
                pass
