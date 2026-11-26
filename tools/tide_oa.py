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


def _extract_answer_text(val: Any) -> str:
    if val is None:
        return ""
    if isinstance(val, (str, int, float, bool)):
        return str(val).strip()
    if isinstance(val, list):
        parts = [_extract_answer_text(item) for item in val]
        return ", ".join(p for p in parts if p)
    if isinstance(val, dict):
        for k in ("value", "label", "name", "nickName", "nick_name", "text", "url", "fileName"):
            if val.get(k) not in (None, ""):
                return _extract_answer_text(val.get(k))
    return ""


def _map_answers_to_header(answers: list[dict[str, Any]]) -> dict[str, str]:
    mapped: dict[str, str] = {}
    rules: list[tuple[str, tuple[str, ...]]] = [
        ("import_project", ("导入项目", "项目名称", "项目")),
        ("internal_model", ("内部机型号", "机型号", "机型")),
        ("emmc_brand", ("emmc品牌", "品牌", "厂商")),
        ("emmc_capacity_gb", ("容量",)),
        ("read_speed_mbs", ("读速度", "理论读")),
        ("write_speed_mbs", ("写速度", "理论写")),
        ("emmc_model", ("emmc型号", "物料型号", "颗粒型号")),
        ("sw_test_userdebug", ("软件测试版本", "小系统", "userdebug")),
        ("emmc_spec", ("规格书", "spec")),
        ("gota_version", ("gota",)),
    ]
    for ans in answers:
        if not isinstance(ans, dict):
            continue
        title = str(ans.get("queTitle") or ans.get("title") or ans.get("name") or "").strip()
        if not title:
            continue
        val = _extract_answer_text(
            ans.get("values") if "values" in ans else ans.get("value")
        )
        if not val:
            continue
        low = title.lower()
        for field_key, kws in rules:
            if field_key in mapped:
                continue
            if any(kw in low for kw in kws):
                mapped[field_key] = val
                break
    return mapped


def _discover_emmc_app_key(token: str, ws_id: str) -> str:
    from tools.settings_store import get, put

    cached = str(get("tide_oa.emmc_app_key", "") or "").strip()
    if cached:
        return cached
    for ep in (f"/ws/{ws_id}/app", "/app", "/app/list"):
        try:
            res = request_tide_oa_api("GET", ep, token=token, ws_id=ws_id, timeout=10.0)
        except Exception:
            continue
        items = (
            res.get("result")
            if isinstance(res.get("result"), list)
            else (res.get("data") if isinstance(res.get("data"), list) else [])
        )
        for item in items:
            if not isinstance(item, dict):
                continue
            name = str(item.get("appName") or item.get("name") or "").strip()
            key = str(item.get("appKey") or item.get("key") or "").strip()
            if key and ("emmc" in name.lower() or "关键物料" in name):
                put("tide_oa.emmc_app_key", key)
                return key
    return ""


def fetch_emmc_flow_header(flow_no: str) -> dict[str, Any]:
    """按流程号从 Tide OA 拉取「eMMC Agent 关键物料导入流程 V2026」并映射为报告头部字段。"""
    flow = (flow_no or "").strip()
    if not flow:
        raise ValueError("请先填写流程号")
    cfg = load_tide_oa_config()
    tok = cfg["token"]
    ws_id = cfg["ws_id"]
    if not tok:
        raise ValueError("尚未登录 Tide OA，请先点击「OA未登录 · 点击登录」")

    record: dict[str, Any] | None = None
    # 1) 直接按 applyId 查询
    try:
        res = request_tide_oa_api("GET", f"/apply/{flow}", token=tok, ws_id=ws_id, timeout=10.0)
        cand = res.get("result") if isinstance(res.get("result"), dict) else res.get("data")
        if isinstance(cand, dict) and (cand.get("answers") or cand.get("applyId")):
            record = cand
    except Exception:
        pass

    # 2) 按应用列表筛选查询
    if record is None:
        app_key = _discover_emmc_app_key(tok, ws_id)
        if not app_key:
            raise RuntimeError("未找到「eMMC Agent 关键物料导入流程 V2026」应用，请确认当前账号有该流程访问权限")
        for payload in (
            {"pageNum": 1, "pageSize": 20, "queryKey": flow},
            {"pageNum": 1, "pageSize": 20, "serialNo": flow},
        ):
            try:
                fres = request_tide_oa_api(
                    "POST",
                    f"/app/{app_key}/apply/filter",
                    token=tok,
                    ws_id=ws_id,
                    body=payload,
                    timeout=12.0,
                )
                fdata = fres.get("result") or fres.get("data") or {}
                rows = (
                    fdata.get("result")
                    or fdata.get("list")
                    or fdata.get("records")
                    or (fdata if isinstance(fdata, list) else [])
                )
                if isinstance(rows, list) and rows:
                    first = rows[0] if isinstance(rows[0], dict) else None
                    if first:
                        aid = str(first.get("applyId") or first.get("id") or "").strip()
                        if aid and not first.get("answers"):
                            dres = request_tide_oa_api(
                                "GET", f"/apply/{aid}", token=tok, ws_id=ws_id, timeout=10.0
                            )
                            dcand = dres.get("result") or dres.get("data")
                            if isinstance(dcand, dict):
                                record = dcand
                        else:
                            record = first
                        if record is not None:
                            break
            except Exception:
                continue

    if record is None:
        raise RuntimeError(f"在 Tide OA 中未查到流程 {flow} 的记录")

    answers = record.get("answers") or []
    header = _map_answers_to_header(answers if isinstance(answers, list) else [])
    return {
        "ok": True,
        "flow_no": flow,
        "apply_id": str(record.get("applyId") or flow),
        "header": header,
    }
