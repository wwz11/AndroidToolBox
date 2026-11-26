#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tide OA（私有化轻流 https://cloud.seirobotics.net）Token 管理与接口调用。"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

TIDE_OA_BASE_URL = "https://cloud.seirobotics.net/api"
_KEY_TOKEN = "tide_oa.token"
_KEY_WS_ID = "tide_oa.ws_id"
_KEY_USER_NAME = "tide_oa.user_name"
_KEY_EMAIL = "tide_oa.email"


def load_tide_oa_config() -> dict[str, Any]:
    from tools.settings_store import get

    token = str(get(_KEY_TOKEN, "") or "").strip()
    ws_id = str(get(_KEY_WS_ID, "") or "").strip() or "2"
    user_name = str(get(_KEY_USER_NAME, "") or "").strip()
    email = str(get(_KEY_EMAIL, "") or "").strip()
    return {
        "base_url": TIDE_OA_BASE_URL,
        "token": token,
        "ws_id": ws_id,
        "user_name": user_name,
        "email": email,
        "logged_in": bool(token),
    }


def load_tide_oa_status() -> dict[str, Any]:
    cfg = load_tide_oa_config()
    return {
        "base_url": cfg["base_url"],
        "ws_id": cfg["ws_id"],
        "user_name": cfg["user_name"],
        "email": cfg["email"],
        "logged_in": cfg["logged_in"],
    }


def request_tide_oa_api(
    method: str,
    path: str,
    *,
    token: str = "",
    ws_id: str = "",
    body: dict[str, Any] | None = None,
    timeout: float = 15.0,
) -> dict[str, Any]:
    cfg = load_tide_oa_config()
    tok = (token or cfg["token"]).strip()
    ws = (ws_id or cfg["ws_id"] or "2").strip()
    if not tok:
        raise ValueError("尚未登录 Tide OA，请先点击「OA未登录 · 点击登录」")

    url = path if path.startswith("http") else f"{TIDE_OA_BASE_URL}{path}"
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    headers = {
        "Token": tok,
        "Wsid": ws,
        "Accept": "application/json",
    }
    if data is not None:
        headers["Content-Type"] = "application/json; charset=utf-8"

    req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as exc:
        err_body = ""
        try:
            err_body = exc.read().decode("utf-8", "replace")
        except Exception:
            pass
        raise RuntimeError(f"Tide OA 接口错误 ({exc.code}): {err_body or exc.reason}") from exc


def validate_and_save_tide_token(token: str, ws_id: str = "2") -> dict[str, Any]:
    from tools.settings_store import put

    tok = (token or "").strip()
    ws = (ws_id or "2").strip() or "2"
    if not tok:
        raise ValueError("Tide OA Token 不能为空")

    res = request_tide_oa_api("GET", "/user", token=tok, ws_id=ws)
    data = res.get("result") if isinstance(res.get("result"), dict) else (
        res.get("data") if isinstance(res.get("data"), dict) else res
    )
    if not isinstance(data, dict):
        data = {}
    user_name = str(
        data.get("nick_name")
        or data.get("nickName")
        or data.get("name")
        or data.get("email")
        or ""
    ).strip()
    email = str(data.get("email") or "").strip()

    put(_KEY_TOKEN, tok)
    put(_KEY_WS_ID, ws)
    put(_KEY_USER_NAME, user_name)
    put(_KEY_EMAIL, email)
    return load_tide_oa_status()


def logout_tide_oa() -> dict[str, Any]:
    from tools.settings_store import put

    for k in (_KEY_TOKEN, _KEY_USER_NAME, _KEY_EMAIL):
        put(k, "")
    return load_tide_oa_status()
