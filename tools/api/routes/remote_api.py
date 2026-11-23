#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""虚拟遥控（ADB keyevent / 应用 / 文本 / 预览 / 内嵌 scrcpy）。"""

from __future__ import annotations

import asyncio
import base64
import json
import subprocess
import threading
from io import BytesIO

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from starlette.websockets import WebSocketState

from tools.remote.core import (
    REMOTE_ACTIONS,
    RemoteAction,
    perform_remote_action,
    scrcpy_available,
    send_keyevent,
    send_text,
    start_scrcpy,
)
from tools.adb_tools.heavy import adb_heavy_busy, adb_heavy_reason
from tools.remote.embed_hub import embed_hub
from tools.remote.login_accounts import (
    fill_account_field,
    find_account,
    load_login_accounts,
    save_login_accounts,
)
from tools.remote.scrcpy_embed import embed_unavailable_reason, scrcpy_embed_available
from tools.adb_runtime import kill_process_tree
from tools.api.deps import require_sn as _require_sn
from tools.screenshot.core import capture_adb_screen

router = APIRouter()

_SCRCPY: dict[str, subprocess.Popen] = {}
_SCRCPY_LOCK = threading.Lock()


class ActionBody(BaseModel):
    label: str = Field(..., min_length=1)


class KeyBody(BaseModel):
    keycode: int = Field(..., ge=0, le=10000)
    longpress: bool = False


class StayAwakeBody(BaseModel):
    enabled: bool


class TextBody(BaseModel):
    text: str = ""


class AccountItem(BaseModel):
    id: str = ""
    label: str = ""
    username: str = ""
    password: str = ""
    next: str = "down"


class AccountsBody(BaseModel):
    accounts: list[AccountItem] = Field(default_factory=list)


class AccountFillBody(BaseModel):
    account_id: str = Field(..., min_length=1)
    field: str = Field("login", description="user | pass | login")
    submit: bool = False
    pause_ms: int = 280


@router.get("/actions")
def actions() -> dict:
    return {
        "actions": [
            {
                "label": a.label,
                "kind": a.kind,
                "keycode": a.keycode,
                "hint": a.hint,
                "confirm": a.confirm,
            }
            for a in REMOTE_ACTIONS
        ]
    }


def _find_action(label: str) -> RemoteAction:
    for a in REMOTE_ACTIONS:
        if a.label == label:
            return a
    raise HTTPException(status_code=404, detail=f"未知动作: {label}")


@router.post("/action")
def do_action(body: ActionBody, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    action = _find_action(body.label)
    # 内嵌投屏时优先走 scrcpy 按键，延迟更低
    if action.kind in ("key",) and action.keycode and embed_hub.running(sn):
        try:
            mirror = embed_hub.get(sn)
            if mirror is not None:
                mirror.press_key(action.keycode)
                return {
                    "device": sn,
                    "ok": True,
                    "label": action.label,
                    "message": f"{action.label} (scrcpy)",
                }
        except Exception:
            pass
    try:
        msg = perform_remote_action(sn, action)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"device": sn, "ok": True, "label": action.label, "message": msg}


@router.post("/keyevent")
def keyevent(body: KeyBody, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    if not body.longpress and embed_hub.running(sn):
        try:
            mirror = embed_hub.get(sn)
            if mirror is not None:
                mirror.press_key(int(body.keycode))
                return {"device": sn, "ok": True, "keycode": body.keycode, "via": "scrcpy"}
        except Exception:
            pass
    try:
        send_keyevent(sn, body.keycode, longpress=bool(body.longpress))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "ok": True,
        "keycode": body.keycode,
        "longpress": bool(body.longpress),
        "via": "adb",
    }


@router.post("/stay-awake")
def stay_awake(body: StayAwakeBody, device: str = Query(...)) -> dict:
    from tools.adb_runtime import run_adb

    sn = _require_sn(device)
    mode = "true" if body.enabled else "false"
    r = run_adb(["shell", "svc", "power", "stayon", mode], sn)
    if r.returncode != 0:
        err = (r.stderr or r.stdout or "").strip()
        raise HTTPException(status_code=502, detail=err or "设置常亮失败")
    return {"device": sn, "ok": True, "enabled": body.enabled}


@router.post("/text")
def text_input(body: TextBody, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    try:
        send_text(sn, body.text)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"device": sn, "ok": True, "chars": len(body.text)}


@router.get("/accounts")
def list_accounts() -> dict:
    return {"accounts": load_login_accounts()}


@router.put("/accounts")
def put_accounts(body: AccountsBody) -> dict:
    saved = save_login_accounts([a.model_dump() for a in body.accounts])
    return {"ok": True, "accounts": saved}


@router.post("/accounts/fill")
def fill_account(body: AccountFillBody, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    account = find_account(body.account_id)
    if account is None:
        raise HTTPException(status_code=404, detail="未找到该账号")
    try:
        message = fill_account_field(
            sn,
            account,
            body.field,
            submit=bool(body.submit),
            pause_ms=int(body.pause_ms),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "ok": True,
        "account_id": account["id"],
        "label": account["label"],
        "field": body.field,
        "message": message,
    }


@router.get("/preview")
def preview_frame(device: str = Query(...), max_side: int = 720) -> dict:
    """单帧截图预览（前端可轮询，作内嵌 scrcpy 不可用时的回退）。"""
    sn = _require_sn(device)
    try:
        img = capture_adb_screen(sn, fast=True)
        if max_side > 0 and max(img.size) > max_side:
            img = img.copy()
            img.thumbnail((max_side, max_side))
        buf = BytesIO()
        img.save(buf, format="JPEG", quality=70)
        raw = buf.getvalue()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "ok": True,
        "mime": "image/jpeg",
        "width": img.width,
        "height": img.height,
        "jpeg_base64": base64.b64encode(raw).decode("ascii"),
    }


def _external_running(sn: str) -> bool:
    with _SCRCPY_LOCK:
        if not sn or sn not in _SCRCPY:
            return False
        proc = _SCRCPY[sn]
        if proc.poll() is None:
            return True
        _SCRCPY.pop(sn, None)
        return False


def _stop_external(sn: str) -> None:
    with _SCRCPY_LOCK:
        proc = _SCRCPY.pop(sn, None)
    if proc is None:
        return
    kill_process_tree(proc)


@router.get("/scrcpy/status")
def scrcpy_status(device: str = Query("")) -> dict:
    sn = (device or "").strip()
    embed_ok = scrcpy_embed_available()
    return {
        "available": scrcpy_available(),
        "running": _external_running(sn) if sn else False,
        "embed_available": embed_ok,
        "embed_reason": "" if embed_ok else embed_unavailable_reason(),
        "embed_running": embed_hub.running(sn) if sn else False,
        "recording": embed_hub.recording(sn) if sn else False,
        "record_path": embed_hub.record_path(sn) if sn else "",
        "device": sn,
    }


@router.post("/scrcpy/start")
def scrcpy_start(device: str = Query(...), max_size: int = 0) -> dict:
    """外挂窗口（兼容旧客户端）；桌面端优先用内嵌 WS。"""
    sn = _require_sn(device)
    if _external_running(sn):
        return {"device": sn, "ok": True, "message": "scrcpy 已在运行"}
    try:
        proc = start_scrcpy(sn, max_size=max_size)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    with _SCRCPY_LOCK:
        _SCRCPY[sn] = proc
    return {
        "device": sn,
        "ok": True,
        "message": "已启动外挂 scrcpy 窗口",
        "pid": proc.pid,
    }


@router.post("/scrcpy/stop")
def scrcpy_stop(
    device: str = Query(...),
    keep_record: bool = Query(False),
) -> dict:
    sn = _require_sn(device)
    recording = embed_hub.recording(sn)
    embed_hub.stop(sn, keep_record=bool(keep_record) and recording)
    _stop_external(sn)
    return {
        "device": sn,
        "ok": True,
        "message": "已停止 scrcpy（保留录屏）"
        if keep_record and recording
        else "已停止 scrcpy",
        "recording": embed_hub.recording(sn),
    }


@router.get("/scrcpy/record/status")
def scrcpy_record_status(device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    return {
        "device": sn,
        "recording": embed_hub.recording(sn),
        "path": embed_hub.record_path(sn),
        "embed_running": embed_hub.running(sn),
    }


@router.post("/scrcpy/record/start")
def scrcpy_record_start(device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    try:
        r = embed_hub.start_record(sn)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"device": sn, **r}


@router.post("/scrcpy/record/stop")
def scrcpy_record_stop(device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    r = embed_hub.stop_record(sn)
    return {"device": sn, **r}


def _frame_jpeg_b64(
    pil_img,
    max_side: int = 960,
    quality: int = 65,
) -> tuple[str, int, int]:
    img = pil_img
    if max_side > 0 and max(img.size) > max_side:
        img = img.copy()
        img.thumbnail((max_side, max_side))
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return base64.b64encode(buf.getvalue()).decode("ascii"), img.width, img.height


@router.websocket("/scrcpy/embed/ws")
async def scrcpy_embed_ws(
    websocket: WebSocket,
    device: str = Query(...),
    max_side: int = Query(960),
) -> None:
    """内嵌 scrcpy：推送 JPEG 帧到前端预览区。"""
    await websocket.accept()
    sn = (device or "").strip()
    if not sn or sn == "未选设备":
        await websocket.send_json({"type": "error", "text": "请先选择设备 SN"})
        await websocket.close()
        return

    if not scrcpy_embed_available():
        await websocket.send_json(
            {
                "type": "error",
                "text": embed_unavailable_reason() or "内嵌 scrcpy 不可用",
            }
        )
        await websocket.close()
        return

    # 避免与外挂窗口抢同一设备
    _stop_external(sn)

    try:
        await asyncio.to_thread(embed_hub.acquire, sn)
    except Exception as exc:
        await websocket.send_json({"type": "error", "text": str(exc)})
        await websocket.close()
        return

    await websocket.send_json({"type": "started", "device": sn, "mode": "embed"})

    stop = asyncio.Event()
    user_stop = False
    cleaned = False

    async def cleanup(*, keep_record: bool) -> None:
        nonlocal cleaned
        if cleaned:
            return
        cleaned = True
        await asyncio.to_thread(embed_hub.stop, sn, keep_record=keep_record)

    async def reader() -> None:
        nonlocal user_stop
        try:
            while not stop.is_set():
                raw = await websocket.receive_text()
                try:
                    data = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                kind = (data.get("type") or "").strip()
                if kind == "stop":
                    user_stop = True
                    stop.set()
                    await cleanup(keep_record=False)
                    break
                if kind == "key":
                    code = data.get("keycode")
                    if code is None:
                        continue
                    mirror = embed_hub.get(sn)
                    if mirror is None:
                        continue
                    try:
                        await asyncio.to_thread(mirror.press_key, int(code))
                    except Exception as exc:
                        if websocket.client_state == WebSocketState.CONNECTED:
                            await websocket.send_json(
                                {"type": "error", "text": str(exc)}
                            )
        except WebSocketDisconnect:
            stop.set()
        except asyncio.CancelledError:
            stop.set()
            # 任务被 finally 取消：正常收尾，勿向上抛以免刷屏
            return
        except Exception:
            stop.set()

    reader_task = asyncio.create_task(reader())
    none_streak = 0
    was_busy = False
    last_sent_pil = None
    try:
        while not stop.is_set():
            mirror = embed_hub.get(sn)
            if mirror is None or not mirror.running:
                await websocket.send_json({"type": "error", "text": "内嵌 scrcpy 已断开"})
                break
            busy = adb_heavy_busy()
            if busy != was_busy:
                was_busy = busy
                if websocket.client_state == WebSocketState.CONNECTED:
                    why = adb_heavy_reason() if busy else ""
                    if why == "install":
                        busy_text = "正在安装应用，投屏保持最后一帧"
                    elif why == "bugreport":
                        busy_text = "正在生成 Bugreport，投屏保持最后一帧"
                    else:
                        busy_text = "ADB 繁忙中，投屏保持最后一帧"
                    await websocket.send_json(
                        {
                            "type": "busy",
                            "on": busy,
                            "reason": why,
                            "text": busy_text if busy else "",
                        }
                    )
            if busy:
                # 把 USB/ADB 让给重负载操作，不推新帧、不因取帧超时断开
                await asyncio.sleep(0.2)
                continue
            try:
                pil = await asyncio.to_thread(
                    lambda: mirror.get_frame_pil(timeout=0.06)
                )
            except Exception as exc:
                none_streak += 1
                if none_streak >= 30:
                    await websocket.send_json(
                        {"type": "error", "text": f"取帧失败: {exc}"}
                    )
                    break
                await asyncio.sleep(0.05)
                continue
            if pil is None:
                none_streak += 1
                if none_streak >= 100:
                    await websocket.send_json(
                        {"type": "error", "text": "内嵌 scrcpy 取帧超时"}
                    )
                    break
                await asyncio.sleep(0.03)
                continue
            none_streak = 0
            if embed_hub.recording(sn):
                try:
                    await asyncio.to_thread(embed_hub.write_record_frame, sn, pil)
                except Exception:
                    pass
            if pil is last_sent_pil:
                await asyncio.sleep(0.02)
                continue
            try:
                side = int(max_side) if max_side else 960
                b64, w, h = await asyncio.to_thread(_frame_jpeg_b64, pil, side, 65)
            except Exception as exc:
                await websocket.send_json({"type": "error", "text": str(exc)})
                break
            if websocket.client_state != WebSocketState.CONNECTED:
                break
            last_sent_pil = pil
            await websocket.send_json(
                {
                    "type": "frame",
                    "mime": "image/jpeg",
                    "width": w,
                    "height": h,
                    "jpeg_base64": b64,
                }
            )
            await asyncio.sleep(0.01)
    except WebSocketDisconnect:
        pass
    except asyncio.CancelledError:
        # 客户端断开 / 服务端取消：按正常停止处理
        pass
    finally:
        stop.set()
        if not reader_task.done():
            reader_task.cancel()
        try:
            await reader_task
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
        keep_rec = (not user_stop) and embed_hub.recording(sn)
        await cleanup(keep_record=keep_rec)
        if websocket.client_state == WebSocketState.CONNECTED:
            try:
                if keep_rec:
                    await websocket.send_json(
                        {
                            "type": "waiting_reconnect",
                            "timeout_sec": 300,
                            "text": "投屏已断开，录屏保留，等待设备重连（5 分钟）",
                        }
                    )
                else:
                    await websocket.send_json({"type": "stopped"})
            except Exception:
                pass
