#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""串口：端口列表 + WebSocket 会话。"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from pathlib import Path

from tools.serial_terminal.core import (
    BAUD_PRESETS,
    SerialConnection,
    default_log_path,
    format_serial_open_error,
    list_port_choices,
    port_from_choice,
    pyserial_available,
)

router = APIRouter()


@router.get("/ports")
def ports() -> dict:
    available = pyserial_available()
    try:
        choices = list_port_choices() if available else []
    except Exception:
        choices = []
    return {
        "available": available,
        "ports": choices,
        "baud_presets": list(BAUD_PRESETS),
    }


def _enqueue_bounded(
    queue: asyncio.Queue[dict[str, Any]], msg: dict[str, Any]
) -> None:
    """有界队列入队：高波特率刷屏且前端消费滞后时，丢弃最旧一条消息以防内存无限膨胀。"""
    if queue.full():
        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:
            pass
    try:
        queue.put_nowait(msg)
    except asyncio.QueueFull:
        pass


@router.websocket("/ws")
async def serial_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=2000)
    conn_holder: dict[str, SerialConnection | None] = {"c": None}

    def push(msg: dict[str, Any]) -> None:
        try:
            loop.call_soon_threadsafe(_enqueue_bounded, queue, msg)
        except Exception:
            pass

    def on_rx(text: str) -> None:
        # xterm 需要原始 \\r；勿 normalize 成 LF
        push({"type": "rx", "text": text})

    def on_status(text: str) -> None:
        push({"type": "status", "text": text})

    def on_error(text: str) -> None:
        push({"type": "error", "text": text})

    def on_lost(text: str) -> None:
        push({"type": "lost", "text": text})

    async def pump_out() -> None:
        while True:
            msg = await queue.get()
            if websocket.client_state != WebSocketState.CONNECTED:
                break
            await websocket.send_json(msg)

    out_task = asyncio.create_task(pump_out())
    try:
        await websocket.send_json(
            {
                "type": "hello",
                "available": pyserial_available(),
                "baud_presets": list(BAUD_PRESETS),
            }
        )
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "text": "无效 JSON"})
                continue
            kind = (data.get("type") or "").strip()
            if kind == "list":
                await websocket.send_json(
                    {
                        "type": "ports",
                        "ports": list_port_choices() if pyserial_available() else [],
                    }
                )
            elif kind == "open":
                choice = str(data.get("port") or "")
                baud = int(data.get("baud") or 115200)
                port = port_from_choice(choice) or choice.strip()
                if not port:
                    await websocket.send_json({"type": "error", "text": "请选择串口"})
                    continue
                old = conn_holder["c"]
                if old is not None:
                    try:
                        old.close()
                    except Exception:
                        pass
                    conn_holder["c"] = None
                conn = SerialConnection(
                    on_rx=on_rx,
                    on_status=on_status,
                    on_error=on_error,
                    on_lost=on_lost,
                    ui_raw=True,
                )
                try:
                    await asyncio.to_thread(conn.open, port, baud)
                    conn_holder["c"] = conn
                    await websocket.send_json(
                        {"type": "opened", "port": port, "baud": baud}
                    )
                    # 打开后默认落盘日志（桌面 serial_端口_时间戳.log）
                    if bool(data.get("auto_log", True)):
                        log_path = default_log_path(port)
                        await asyncio.to_thread(
                            conn.set_log_target, log_path, enabled=True
                        )
                        await websocket.send_json(
                            {
                                "type": "log",
                                "enabled": True,
                                "path": str(log_path.resolve()),
                            }
                        )
                except Exception as exc:
                    # open() 内可能已 format；format_serial_open_error 自身会去重
                    err_text = str(exc).strip()
                    if not err_text.startswith("无法打开 "):
                        err_text = format_serial_open_error(exc, port)
                    await websocket.send_json({"type": "error", "text": err_text})
            elif kind == "send":
                conn = conn_holder["c"]
                text = str(data.get("text") or "")
                if conn is None:
                    await websocket.send_json({"type": "error", "text": "串口未打开"})
                    continue
                try:
                    # 逐键发送时不刷状态栏，避免「已发送 N 字节」刷屏
                    await asyncio.to_thread(
                        lambda t=text: conn.send_text(t, log=True, status=False)
                    )
                except Exception as exc:
                    await websocket.send_json({"type": "error", "text": str(exc)})
            elif kind == "set_log":
                conn = conn_holder["c"]
                if conn is None:
                    await websocket.send_json({"type": "error", "text": "串口未打开"})
                    continue
                enabled = bool(data.get("enabled", True))
                raw_path = str(data.get("path") or "").strip()
                try:
                    if not enabled:
                        await asyncio.to_thread(conn.set_log_target, None, enabled=False)
                        await websocket.send_json(
                            {"type": "log", "enabled": False, "path": ""}
                        )
                    else:
                        path = Path(raw_path) if raw_path else default_log_path(
                            str(data.get("port") or "COM")
                        )
                        await asyncio.to_thread(
                            conn.set_log_target, path, enabled=True
                        )
                        await websocket.send_json(
                            {
                                "type": "log",
                                "enabled": True,
                                "path": str(path.resolve()),
                            }
                        )
                except Exception as exc:
                    await websocket.send_json({"type": "error", "text": str(exc)})
            elif kind == "close":
                conn = conn_holder["c"]
                if conn is not None:
                    await asyncio.to_thread(conn.close)
                    conn_holder["c"] = None
                await websocket.send_json({"type": "closed"})
            else:
                await websocket.send_json({"type": "error", "text": f"未知类型: {kind}"})
    except WebSocketDisconnect:
        pass
    finally:
        out_task.cancel()
        conn = conn_holder["c"]
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
