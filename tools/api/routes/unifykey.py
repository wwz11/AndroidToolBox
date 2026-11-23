#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""UnifyKey 读写 API。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from tools.api.deps import require_sn as _require_sn
from tools.unifykey.core import fetch_key_list, read_key, write_and_read

router = APIRouter()


class KeyItem(BaseModel):
    index: str
    name: str
    key_type: str
    attr: str


class ReadBody(BaseModel):
    key: str = Field(..., min_length=1)
    use_su: bool = True


class WriteBody(BaseModel):
    key: str = Field(..., min_length=1)
    value: str = ""
    use_su: bool = True


@router.get("/keys")
def list_keys(
    device: str = Query(..., description="ADB 序列号"),
    use_su: bool = True,
    normal_only: bool = True,
) -> dict:
    sn = _require_sn(device)
    try:
        keys = fetch_key_list(sn, use_su, normal_only=normal_only)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "keys": [
            KeyItem(
                index=k.index, name=k.name, key_type=k.key_type, attr=k.attr
            ).model_dump()
            for k in keys
        ],
    }


@router.post("/read")
def read_value(
    body: ReadBody,
    device: str = Query(..., description="ADB 序列号"),
) -> dict:
    sn = _require_sn(device)
    try:
        value = read_key(body.key, sn, body.use_su)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"device": sn, "key": body.key, "value": value}


@router.post("/write")
def write_value(
    body: WriteBody,
    device: str = Query(..., description="ADB 序列号"),
) -> dict:
    sn = _require_sn(device)
    try:
        readback = write_and_read(body.key, body.value, sn, body.use_su)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    matched = readback == body.value
    return {
        "device": sn,
        "key": body.key,
        "written": body.value,
        "readback": readback,
        "matched": matched,
    }
