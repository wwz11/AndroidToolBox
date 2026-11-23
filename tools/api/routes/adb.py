#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ADB 设备列表与网络连接。"""

from __future__ import annotations

import time
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from tools.adb_network import adb_connect, adb_disconnect
from tools.adb_runtime import adb_available, list_adb_devices, run_adb

router = APIRouter()

# 进程内选中 SN（多标签打开时的默认源）
_selected_sn: str = ""

# 短缓存：避免多页面同时轮询反复拉起 adb 子进程导致界面卡顿
_CACHE_TTL_SEC = 1.5
_OFFLINE_GRACE_SEC = 1.5
_AVAIL_TTL_SEC = 30.0
_AVAIL_FAIL_TTL_SEC = 1.5
_devices_cache: dict | None = None
_devices_cache_at = 0.0
_last_online_cache: dict | None = None
_last_online_at = 0.0
_adb_ready: bool | None = None
_adb_ready_at = 0.0


def _pick_selected(current: str, devices: list[str]) -> str:
    cur = (current or "").strip()
    online = [d.strip() for d in devices if d and d.strip()]
    if cur and cur in online:
        return cur
    if online:
        return online[0]
    return ""


def _adb_ready_cached(*, force: bool = False) -> bool:
    global _adb_ready, _adb_ready_at
    now = time.monotonic()
    ttl = _AVAIL_TTL_SEC if _adb_ready else _AVAIL_FAIL_TTL_SEC
    if (
        not force
        and _adb_ready is not None
        and now - _adb_ready_at < ttl
    ):
        return _adb_ready
    ready = adb_available()
    _adb_ready = ready
    _adb_ready_at = now
    return ready


def _kick_adb_server() -> None:
    try:
        run_adb(["start-server"], None, timeout=10.0)
    except Exception:
        pass


def _list_message(ready: list[str], rows: list[tuple[str, str]]) -> str:
    if ready:
        return f"{len(ready)} 台在线"
    pending = [(s, st) for s, st in rows if st != "device"]
    if pending:
        return f"{len(pending)} 台已连接但未授权或离线"
    return "无在线设备"


def _devices_payload(*, force: bool = False) -> dict:
    global _selected_sn, _devices_cache, _devices_cache_at, _last_online_cache, _last_online_at, _adb_ready, _adb_ready_at
    now = time.monotonic()
    if (
        not force
        and _devices_cache is not None
        and now - _devices_cache_at < _CACHE_TTL_SEC
    ):
        cached = dict(_devices_cache)
        cached["selected"] = _pick_selected(_selected_sn, list(cached.get("devices") or []))
        _selected_sn = str(cached["selected"] or "")
        cached["selected"] = _selected_sn
        return cached

    rows: list[tuple[str, str]] = []
    try:
        rows = list_adb_devices()
        ready = [s for s, st in rows if st == "device"]
    except Exception as exc:
        if (
            not force
            and _last_online_cache is not None
            and now - _last_online_at < _OFFLINE_GRACE_SEC
        ):
            cached = dict(_last_online_cache)
            cached["selected"] = _pick_selected(
                _selected_sn, list(cached.get("devices") or [])
            )
            _selected_sn = str(cached["selected"] or "")
            cached["selected"] = _selected_sn
            return cached
        _kick_adb_server()
        if not _adb_ready_cached(force=force):
            payload = {
                "devices": [],
                "rows": [],
                "selected": _selected_sn,
                "adb_available": False,
                "message": "adb 不可用",
            }
            _devices_cache = payload
            _devices_cache_at = now
            return payload
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    _adb_ready = True
    _adb_ready_at = now
    _selected_sn = _pick_selected(_selected_sn, ready)
    payload = {
        "devices": ready,
        "rows": [{"serial": s, "state": st} for s, st in rows],
        "selected": _selected_sn,
        "adb_available": True,
        "message": _list_message(ready, rows),
    }
    _devices_cache = payload
    _devices_cache_at = now
    if ready:
        _last_online_cache = payload
        _last_online_at = now
    elif force:
        _last_online_cache = None
    return payload


class ConnectBody(BaseModel):
    target: str = Field(..., min_length=1, description="IP 或 IP:端口")


class DisconnectBody(BaseModel):
    target: str = ""


class SelectedBody(BaseModel):
    serial: str = ""


@router.get("/status")
def adb_status() -> dict:
    ready = adb_available()
    return {"adb_available": ready}


@router.get("/devices")
def devices() -> dict:
    return _devices_payload(force=False)


@router.post("/refresh")
def refresh() -> dict:
    return _devices_payload(force=True)


@router.get("/selected")
def get_selected() -> dict:
    return {"serial": _selected_sn}


@router.put("/selected")
def put_selected(body: SelectedBody) -> dict:
    global _selected_sn
    _selected_sn = (body.serial or "").strip()
    return {"serial": _selected_sn}


@router.post("/connect")
def connect(body: ConnectBody) -> dict:
    try:
        msg = adb_connect(body.target)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    snapshot = refresh()
    return {"ok": True, "message": msg, **snapshot}


@router.post("/disconnect")
def disconnect(body: DisconnectBody | None = None) -> dict:
    raw = (body.target if body else "") or None
    try:
        msg = adb_disconnect(raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    snapshot = refresh()
    return {"ok": True, "message": msg, **snapshot}
