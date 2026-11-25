#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""飞书开放平台（企业自建应用 tenant_access_token）在线表格同步辅助。"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

_BASE_URL = "https://open.feishu.cn/open-apis"
_KEY_APP_ID = "feishu.app_id"
_KEY_APP_SECRET = "feishu.app_secret"
_KEY_TEMPLATE_URL = "feishu.template_url"

_TOKEN_LOCK = threading.Lock()
_TOKEN_CACHE: dict[tuple[str, str], tuple[str, float]] = {}


def load_feishu_config() -> dict[str, Any]:
    from tools.settings_store import get

    app_id = str(get(_KEY_APP_ID, "") or "").strip()
    app_secret = str(get(_KEY_APP_SECRET, "") or "").strip()
    template_url = str(get(_KEY_TEMPLATE_URL, "") or "").strip()
    return {
        "app_id": app_id,
        "app_secret": app_secret,
        "has_secret": bool(app_secret),
        "template_url": template_url,
    }


def save_feishu_config(
    *,
    app_id: str | None = None,
    app_secret: str | None = None,
    template_url: str | None = None,
) -> dict[str, Any]:
    from tools.settings_store import put

    if app_id is not None:
        put(_KEY_APP_ID, app_id.strip())
    if app_secret is not None and app_secret.strip():
        put(_KEY_APP_SECRET, app_secret.strip())
        with _TOKEN_LOCK:
            _TOKEN_CACHE.clear()
    if template_url is not None:
        put(_KEY_TEMPLATE_URL, template_url.strip())
    return load_feishu_config()


def parse_feishu_doc_url(url_or_token: str) -> tuple[str, str]:
    """解析飞书表格/Wiki 链接，返回 (kind, token)，kind 为 'sheet' 或 'wiki'。"""
    raw = (url_or_token or "").strip()
    if not raw:
        raise ValueError("请填写飞书在线表格链接或 token")

    m_sheet = re.search(r"/sheets/([A-Za-z0-9_-]+)", raw)
    if m_sheet:
        return "sheet", m_sheet.group(1)

    m_wiki = re.search(r"/wiki/([A-Za-z0-9_-]+)", raw)
    if m_wiki:
        return "wiki", m_wiki.group(1)

    if re.fullmatch(r"[A-Za-z0-9_-]{8,}", raw):
        return ("sheet" if raw.startswith("sht") else "wiki"), raw

    raise ValueError("无法识别飞书链接，请粘贴包含 /sheets/ 或 /wiki/ 的完整地址")


def _request_json(
    method: str,
    path: str,
    *,
    token: str = "",
    body: dict[str, Any] | None = None,
    timeout: float = 20.0,
) -> dict[str, Any]:
    url = path if path.startswith("http") else f"{_BASE_URL}{path}"
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    headers: dict[str, str] = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json; charset=utf-8"
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", "replace") if exc.fp else ""
        try:
            parsed = json.loads(err_body)
            msg = parsed.get("msg") or err_body or str(exc)
            code = parsed.get("code")
            raise RuntimeError(f"飞书接口错误 ({code or exc.code}): {msg}") from exc
        except json.JSONDecodeError:
            raise RuntimeError(f"飞书 HTTP {exc.code}: {err_body or exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法连接飞书接口: {exc.reason}") from exc

    payload = json.loads(raw or "{}")
    code = payload.get("code", 0)
    if code not in (0, None):
        raise RuntimeError(f"飞书接口错误 ({code}): {payload.get('msg') or '未知错误'}")
    return payload


def _download_bytes(url: str, *, token: str, timeout: float = 60.0) -> bytes:
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {token}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", "replace") if exc.fp else ""
        raise RuntimeError(f"下载导出文件失败 (HTTP {exc.code}): {err_body or exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"下载导出文件网络失败: {exc.reason}") from exc


def get_tenant_access_token(app_id: str, app_secret: str) -> str:
    aid = app_id.strip()
    sec = app_secret.strip()
    if not aid or not sec:
        raise ValueError("请先填写飞书应用的 App ID 和 App Secret")
    now = time.monotonic()
    with _TOKEN_LOCK:
        cached = _TOKEN_CACHE.get((aid, sec))
        if cached and cached[1] > now:
            return cached[0]

    payload = _request_json(
        "POST",
        "/auth/v3/tenant_access_token/internal",
        body={"app_id": aid, "app_secret": sec},
    )
    token = str(payload.get("tenant_access_token") or "").strip()
    if not token:
        raise RuntimeError("飞书未返回 tenant_access_token")
    expire = int(payload.get("expire") or 7200)
    with _TOKEN_LOCK:
        _TOKEN_CACHE[(aid, sec)] = (token, now + max(60, expire - 120))
    return token


def resolve_spreadsheet_token(tenant_token: str, url_or_token: str) -> str:
    kind, token = parse_feishu_doc_url(url_or_token)
    if kind == "sheet":
        return token
    q = urllib.parse.urlencode({"token": token})
    payload = _request_json("GET", f"/wiki/v2/spaces/get_node?{q}", token=tenant_token)
    node = (payload.get("data") or {}).get("node") or {}
    obj_type = str(node.get("obj_type") or "").strip()
    obj_token = str(node.get("obj_token") or "").strip()
    if not obj_token:
        raise RuntimeError("未从知识库节点解析到文档 token，请确认应用有该知识库阅读权限")
    if obj_type and obj_type != "sheet":
        raise RuntimeError(f"该链接指向的是 {obj_type}，不是飞书电子表格（sheet）")
    return obj_token


def test_feishu_connection(
    *,
    app_id: str,
    app_secret: str,
    url_or_token: str = "",
) -> dict[str, Any]:
    token = get_tenant_access_token(app_id, app_secret)
    info: dict[str, Any] = {"ok": True, "message": "飞书应用凭证校验成功"}
    if (url_or_token or "").strip():
        sheet_token = resolve_spreadsheet_token(token, url_or_token)
        meta = _request_json("GET", f"/sheets/v3/spreadsheets/{sheet_token}", token=token)
        title = str(((meta.get("data") or {}).get("spreadsheet") or {}).get("title") or "").strip()
        info["spreadsheet_token"] = sheet_token
        info["title"] = title
        info["message"] = f"连接成功：{title or sheet_token}"
    return info


def export_feishu_spreadsheet_xlsx(
    *,
    app_id: str,
    app_secret: str,
    url_or_token: str,
    dest_path: Path,
) -> dict[str, Any]:
    token = get_tenant_access_token(app_id, app_secret)
    sheet_token = resolve_spreadsheet_token(token, url_or_token)

    title = ""
    try:
        meta = _request_json("GET", f"/sheets/v3/spreadsheets/{sheet_token}", token=token)
        title = str(((meta.get("data") or {}).get("spreadsheet") or {}).get("title") or "").strip()
    except Exception:
        title = ""

    created = _request_json(
        "POST",
        "/drive/v1/export_tasks",
        token=token,
        body={"file_extension": "xlsx", "token": sheet_token, "type": "sheet"},
    )
    ticket = str((created.get("data") or {}).get("ticket") or "").strip()
    if not ticket:
        raise RuntimeError("飞书导出任务未返回 ticket")

    file_token = ""
    q = urllib.parse.urlencode({"token": sheet_token})
    for _ in range(30):
        status_res = _request_json(
            "GET",
            f"/drive/v1/export_tasks/{ticket}?{q}",
            token=token,
        )
        result = (status_res.get("data") or {}).get("result") or {}
        job_status = int(result.get("job_status", -1))
        if job_status == 0:
            file_token = str(result.get("file_token") or "").strip()
            break
        if job_status in (1, 2):
            time.sleep(0.6)
            continue
        raise RuntimeError(
            f"飞书导出失败（status={job_status}）: {result.get('job_error_msg') or '未知错误'}"
        )

    if not file_token:
        raise RuntimeError("飞书导出超时，未获取到 file_token")

    raw = _download_bytes(
        f"{_BASE_URL}/drive/v1/export_tasks/file/{file_token}/download",
        token=token,
    )
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = dest_path.with_suffix(".tmp.xlsx")
    tmp_path.write_bytes(raw)

    try:
        import warnings
        from openpyxl import load_workbook

        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", message="Title is more than 31 characters*", category=UserWarning)
            wb = load_workbook(tmp_path)
            wb.close()
    except Exception as exc:
        tmp_path.unlink(missing_ok=True)
        raise RuntimeError(f"导出的文件不是有效的 Excel (.xlsx): {exc}") from exc

    os.replace(tmp_path, dest_path)
    return {
        "ok": True,
        "path": str(dest_path),
        "spreadsheet_token": sheet_token,
        "title": title,
    }
