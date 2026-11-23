#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""核对遥控器：adb getevent 抓按下。"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Query, WebSocket
from starlette.websockets import WebSocketDisconnect

from tools.keycheck.ids import query_bluetooth_ids
from tools.keycheck.capture import (
    CaptureBusy,
    CaptureCancelled,
    CaptureFailed,
    CaptureTimeout,
    HidPress,
    cancel_capture,
    capture_one_press,
    watch_presses,
)

router = APIRouter()


def _payload(press: HidPress, *, ok: bool, message: str = "") -> dict:
    return {
        "ok": ok,
        "page": press.page,
        "usage": press.usage,
        "scan": press.scan,
        "input": press.input_dev,
        "key_code": press.key_code,
        "page_known": press.page_known,
        "message": message or press.message(),
    }


@router.get("/key-ids")
def key_ids(device: str = Query(...)) -> dict:
    try:
        return query_bluetooth_ids(device)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/key-capture")
def key_capture(
    device: str = Query(...),
    timeout: float = Query(20.0, ge=3, le=60),
) -> dict:
    try:
        press = capture_one_press(device, timeout)
    except CaptureBusy as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except CaptureTimeout as exc:
        raise HTTPException(status_code=408, detail=str(exc)) from exc
    except CaptureCancelled as exc:
        return _payload(
            HidPress("", "", "", "", None, False),
            ok=False,
            message=str(exc),
        )
    except CaptureFailed as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return _payload(press, ok=press.page_known or bool(press.usage))


@router.post("/key-capture/cancel")
def key_capture_cancel(device: str = Query(...)) -> dict:
    stopped = cancel_capture(device)
    return {"ok": True, "stopped": stopped, "message": "已取消" if stopped else "没有进行中的核对"}


def _press_message(press: HidPress) -> dict:
    return {
        "type": "press",
        "ok": press.page_known or bool(press.usage),
        "page": press.page,
        "usage": press.usage,
        "scan": press.scan,
        "input": press.input_dev,
        "key_code": press.key_code,
        "page_known": press.page_known,
        "message": press.message(),
    }


@router.websocket("/key-capture/ws")
async def key_capture_ws(websocket: WebSocket, device: str = Query(...)) -> None:
    """一次连接内按顺序上报每次按下。打开瞬间的自动上报不发给页面。"""
    await websocket.accept()
    sn = (device or "").strip()
    if not sn:
        await websocket.send_json({"type": "error", "message": "请先选择设备"})
        await websocket.close()
        return

    loop = asyncio.get_running_loop()

    def emit(payload: dict) -> None:
        if loop.is_closed():
            return
        future = asyncio.run_coroutine_threadsafe(websocket.send_json(payload), loop)
        try:
            future.result(timeout=5)
        except Exception:
            cancel_capture(sn)

    def worker() -> None:
        try:
            watch_presses(
                sn,
                lambda press: emit(_press_message(press)),
                timeout=None,
                skip_initial=True,
                on_ready=lambda: emit({"type": "ready", "device": sn}),
            )
        except CaptureCancelled:
            return
        except CaptureTimeout as exc:
            emit({"type": "error", "message": str(exc)})
        except (CaptureBusy, CaptureFailed) as exc:
            emit({"type": "error", "message": str(exc)})
        except Exception as exc:
            emit({"type": "error", "message": str(exc) or "核对中断"})

    worker_task = asyncio.create_task(asyncio.to_thread(worker))
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        cancel_capture(sn)
        try:
            await worker_task
        except Exception:
            pass
