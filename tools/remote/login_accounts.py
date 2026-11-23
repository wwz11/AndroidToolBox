#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""遥控页快捷登录账号（本地持久化，供 ADB 填入账号/密码）。"""

from __future__ import annotations

import re
import time
import uuid
from typing import Any, Literal, TypedDict

from tools.remote.core import send_keyevent, send_text
from tools.settings_store import get, put

_SETTINGS_KEY = "remote.login_accounts"

NextKey = Literal["down", "tab", "enter", "none"]

_NEXT_KEYCODES: dict[str, int] = {
    "down": 20,  # KEYCODE_DPAD_DOWN
    "tab": 61,  # KEYCODE_TAB
    "enter": 66,  # KEYCODE_ENTER
    "none": 0,
}


class LoginAccount(TypedDict):
    id: str
    label: str
    username: str
    password: str
    next: str  # down | tab | enter | none


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def _normalize_next(raw: Any) -> str:
    v = str(raw or "down").strip().lower()
    if v in _NEXT_KEYCODES:
        return v
    return "down"


def _normalize_item(raw: Any) -> LoginAccount | None:
    if not isinstance(raw, dict):
        return None
    username = str(raw.get("username", "")).strip()
    password = str(raw.get("password", ""))
    label = str(raw.get("label", "")).strip()
    if not username and not password and not label:
        return None
    aid = str(raw.get("id", "")).strip() or _new_id()
    if not re.fullmatch(r"[0-9a-zA-Z_-]{4,64}", aid):
        aid = _new_id()
    if not label:
        label = username or "未命名账号"
    return {
        "id": aid,
        "label": label,
        "username": username,
        "password": password,
        "next": _normalize_next(raw.get("next")),
    }


def load_login_accounts() -> list[LoginAccount]:
    saved = get(_SETTINGS_KEY, None)
    if not isinstance(saved, list) or not saved:
        return []
    out: list[LoginAccount] = []
    seen: set[str] = set()
    for item in saved:
        norm = _normalize_item(item)
        if norm is None or norm["id"] in seen:
            continue
        seen.add(norm["id"])
        out.append(norm)
    return out


def save_login_accounts(accounts: list[LoginAccount] | list[dict[str, Any]]) -> list[LoginAccount]:
    cleaned: list[LoginAccount] = []
    seen: set[str] = set()
    for item in accounts:
        norm = _normalize_item(item)
        if norm is None:
            continue
        if norm["id"] in seen:
            norm = {**norm, "id": _new_id()}
        seen.add(norm["id"])
        cleaned.append(norm)
    put(_SETTINGS_KEY, cleaned)
    return cleaned


def find_account(account_id: str) -> LoginAccount | None:
    aid = (account_id or "").strip()
    if not aid:
        return None
    for a in load_login_accounts():
        if a["id"] == aid:
            return a
    return None


def fill_account_field(
    device: str,
    account: LoginAccount,
    field: str,
    *,
    submit: bool = False,
    pause_ms: int = 280,
) -> str:
    """向当前焦点控件填入账号字段。

    field:
      - user: 仅账号
      - pass: 仅密码
      - login: 账号 → next 键 → 密码（可选再按 Enter）
    """
    pause = max(0, min(int(pause_ms), 2000)) / 1000.0
    mode = (field or "").strip().lower()

    def _sleep() -> None:
        if pause > 0:
            time.sleep(pause)

    if mode == "user":
        if not account["username"]:
            raise ValueError("该账号未填写用户名")
        send_text(device, account["username"])
        return f"已填入账号「{account['label']}」"

    if mode == "pass":
        if account["password"] == "":
            raise ValueError("该账号未填写密码")
        send_text(device, account["password"])
        return f"已填入密码「{account['label']}」"

    if mode in ("login", "both", "all"):
        if not account["username"]:
            raise ValueError("该账号未填写用户名")
        send_text(device, account["username"])
        next_key = _normalize_next(account.get("next"))
        code = _NEXT_KEYCODES.get(next_key, 0)
        if code:
            _sleep()
            send_keyevent(device, code)
        if account["password"] != "":
            _sleep()
            send_text(device, account["password"])
        if submit:
            _sleep()
            send_keyevent(device, 66)
        parts = ["账号"]
        if code:
            parts.append({"down": "下", "tab": "Tab", "enter": "Enter"}.get(next_key, next_key))
        if account["password"] != "":
            parts.append("密码")
        if submit:
            parts.append("确认")
        return f"已依次填入「{account['label']}」：{' → '.join(parts)}"

    raise ValueError(f"未知填入方式: {field}")
