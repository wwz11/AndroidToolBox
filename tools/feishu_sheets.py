#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""飞书开放平台（企业自建应用 tenant_access_token）在线表格同步辅助。"""

from __future__ import annotations

import base64
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
_KEY_NOTIFY_ENABLED = "feishu.notify_enabled"
_KEY_USER_OPEN_ID = "feishu.user_open_id"
_KEY_USER_NAME = "feishu.user_name"
_KEY_USER_ACCESS_TOKEN = "feishu.user_access_token"
_KEY_USER_REFRESH_TOKEN = "feishu.user_refresh_token"
_KEY_USER_EXPIRES_AT = "feishu.user_expires_at"
_DEFAULT_TEMPLATE_URL = "https://seirobotics.feishu.cn/wiki/LxtOwpFGRi6mWskBXeBcqq8wnOe"
_CRED_KEY = b"atv_tb_fs_2026_key"
_DEFAULT_APP_ID_ENC = "AhgfABUAZwVBOQIDA1U9CVAaUEA="
_DEFAULT_APP_SECRET_ENC = "NDYjKCQYERY4MgEIAVUVXAsuKxsXOgYFBQEJL0FfcHs="

_TOKEN_LOCK = threading.Lock()
_TOKEN_CACHE: dict[tuple[str, str], tuple[str, float]] = {}


def _decode_default_cred(blob: str) -> str:
    raw = base64.b64decode(blob.encode("ascii"))
    return bytes(b ^ _CRED_KEY[i % len(_CRED_KEY)] for i, b in enumerate(raw)).decode("utf-8")


def load_feishu_config() -> dict[str, Any]:
    from tools.settings_store import get

    app_id = str(get(_KEY_APP_ID, "") or "").strip() or _decode_default_cred(_DEFAULT_APP_ID_ENC)
    app_secret = str(get(_KEY_APP_SECRET, "") or "").strip() or _decode_default_cred(_DEFAULT_APP_SECRET_ENC)
    template_url = str(get(_KEY_TEMPLATE_URL, "") or "").strip() or _DEFAULT_TEMPLATE_URL
    raw_notify = get(_KEY_NOTIFY_ENABLED, True)
    notify_enabled = (
        raw_notify
        if isinstance(raw_notify, bool)
        else str(raw_notify).strip().lower() in ("1", "true", "yes", "on")
    )
    user_open_id = str(get(_KEY_USER_OPEN_ID, "") or "").strip()
    user_name = str(get(_KEY_USER_NAME, "") or "").strip()
    return {
        "app_id": app_id,
        "app_secret": app_secret,
        "has_secret": bool(app_secret),
        "template_url": template_url,
        "notify_enabled": notify_enabled,
        "user_open_id": user_open_id,
        "user_name": user_name,
        "user_logged_in": bool(user_open_id),
    }


def save_feishu_config(
    *,
    app_id: str | None = None,
    app_secret: str | None = None,
    template_url: str | None = None,
    notify_enabled: bool | None = None,
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
    if notify_enabled is not None:
        put(_KEY_NOTIFY_ENABLED, bool(notify_enabled))
    return load_feishu_config()


def logout_feishu_user() -> dict[str, Any]:
    from tools.settings_store import put

    for k in (
        _KEY_USER_OPEN_ID,
        _KEY_USER_NAME,
        _KEY_USER_ACCESS_TOKEN,
        _KEY_USER_REFRESH_TOKEN,
        _KEY_USER_EXPIRES_AT,
    ):
        put(k, "")
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


def _col_letter(col: int) -> str:
    res = ""
    n = col
    while n > 0:
        n, rem = divmod(n - 1, 26)
        res = chr(65 + rem) + res
    return res


def get_spreadsheet_sheets(tenant_token: str, spreadsheet_token: str) -> list[dict[str, Any]]:
    payload = _request_json(
        "GET",
        f"/sheets/v3/spreadsheets/{spreadsheet_token}/sheets/query",
        token=tenant_token,
    )
    return list((payload.get("data") or {}).get("sheets") or [])


def _get_parent_folder_token(tenant_token: str, file_token: str, file_type: str = "sheet") -> str:
    try:
        res = _request_json(
            "POST",
            "/drive/v1/metas/batch_query",
            token=tenant_token,
            body={"request_docs": [{"doc_token": file_token, "doc_type": file_type}]},
        )
        metas = (res.get("data") or {}).get("metas") or []
        if metas:
            parent = str(metas[0].get("parent_token") or "").strip()
            if parent:
                return parent
    except Exception:
        pass
    try:
        root_res = _request_json("GET", "/drive/explorer/v2/root_folder/meta", token=tenant_token)
        root_tok = str((root_res.get("data") or {}).get("token") or "").strip()
        if root_tok:
            return root_tok
    except Exception:
        pass
    return ""


def copy_feishu_spreadsheet(
    *,
    app_id: str,
    app_secret: str,
    url_or_token: str,
    name: str,
    folder_token: str = "",
) -> dict[str, Any]:
    """复制在线飞书表格生成新在线报告，返回新表格 token 与 URL。"""
    token = get_tenant_access_token(app_id, app_secret)
    src_token = resolve_spreadsheet_token(token, url_or_token)
    target_folder = folder_token.strip() or _get_parent_folder_token(token, src_token, "sheet")

    body: dict[str, Any] = {"name": name.strip() or "eMMC 测试报告", "type": "sheet"}
    if target_folder:
        body["folder_token"] = target_folder

    res = _request_json(
        "POST",
        f"/drive/v1/files/{src_token}/copy",
        token=token,
        body=body,
    )
    file_info = (res.get("data") or {}).get("file") or {}
    new_token = str(file_info.get("token") or "").strip()
    new_url = str(file_info.get("url") or "").strip() or f"https://feishu.cn/sheets/{new_token}"
    if not new_token:
        raise RuntimeError("复制飞书表格失败：未返回新文件 token")

    # 尽量开启企业内可编辑链接，方便团队成员直接查看/编辑
    try:
        _request_json(
            "PATCH",
            f"/drive/v1/permissions/{new_token}/public?type=sheet",
            token=token,
            body={"link_share_entity": "tenant_editable"},
        )
    except Exception:
        pass

    return {
        "ok": True,
        "spreadsheet_token": new_token,
        "url": new_url,
        "name": str(file_info.get("name") or name).strip(),
    }


def _match_online_sheet_id(local_title: str, online_sheets: list[dict[str, Any]]) -> str:
    low = (local_title or "").lower()
    is_en = "import" in low or "(en)" in low or "english" in low
    for s in online_sheets:
        title = str(s.get("title") or "")
        tlow = title.lower()
        if tlow == "history":
            continue
        online_en = "import" in tlow or "english" in tlow
        if is_en == online_en:
            return str(s.get("sheet_id") or "")
    for s in online_sheets:
        if str(s.get("title") or "").lower() != "history":
            return str(s.get("sheet_id") or "")
    return ""


def sync_report_xlsx_to_feishu(
    *,
    app_id: str,
    app_secret: str,
    report_path: Path,
    url_or_token: str,
) -> dict[str, Any]:
    """将本地 eMMC 报告表头与各测试项结果直接写入在线飞书表格。"""
    from tools.emmc_test import report_template as rt

    if not report_path.is_file():
        raise FileNotFoundError(f"本地报告不存在: {report_path}")

    token = get_tenant_access_token(app_id, app_secret)
    sheet_token = resolve_spreadsheet_token(token, url_or_token)
    online_sheets = get_spreadsheet_sheets(token, sheet_token)
    if not online_sheets:
        raise RuntimeError("在线飞书表格未包含任何工作表")

    wb = rt._load_workbook(report_path)
    value_ranges: list[dict[str, Any]] = []
    try:
        for ws in rt._iter_report_sheets(wb):
            sid = _match_online_sheet_id(ws.title or "", online_sheets)
            if not sid:
                continue
            rows_1_to_38: list[list[Any]] = []
            for r in range(1, 39):
                row_vals: list[Any] = []
                for c in range(1, 15):
                    v = ws.cell(r, c).value
                    row_vals.append("" if v is None else v)
                rows_1_to_38.append(row_vals)
            # 按单元格粒度只写有值的单元格（避免覆盖模板原有说明/公式/合并格占位）
            for r in range(1, 39):
                for c in range(1, 15):
                    # 仅同步软件写入区：R1C1标题、R3-R9表头值、R13-R24 iozone、R26-R29 压测、R32 reboot、R35 rpmb、R38 ota
                    if not (
                        (r == 1 and c == 1)
                        or (3 <= r <= 9 and c in (2, 5, 8))
                        or (13 <= r <= 24 and 1 <= c <= 11)
                        or (26 <= r <= 29 and 1 <= c <= 8)
                        or (r in (32, 35, 38) and 1 <= c <= 8)
                    ):
                        continue
                    v = ws.cell(r, c).value
                    if v is None:
                        continue
                    a1 = f"{_col_letter(c)}{r}"
                    value_ranges.append({"range": f"{sid}!{a1}:{a1}", "values": [[v]]})
    finally:
        wb.close()

    if value_ranges:
        # 飞书 values_batch_update 单次建议分批（每批最多 100 个 range）
        for i in range(0, len(value_ranges), 100):
            _request_json(
                "POST",
                f"/sheets/v2/spreadsheets/{sheet_token}/values_batch_update",
                token=token,
                body={"valueRanges": value_ranges[i : i + 100]},
            )

    return {
        "ok": True,
        "spreadsheet_token": sheet_token,
        "updated_cells": len(value_ranges),
        "url": f"https://feishu.cn/sheets/{sheet_token}",
    }


def get_app_access_token(app_id: str, app_secret: str) -> str:
    aid = app_id.strip()
    sec = app_secret.strip()
    if not aid or not sec:
        raise ValueError("请先填写飞书应用的 App ID 和 App Secret")
    payload = _request_json(
        "POST",
        "/auth/v3/app_access_token/internal",
        body={"app_id": aid, "app_secret": sec},
    )
    token = str(payload.get("app_access_token") or "").strip()
    if not token:
        raise RuntimeError("飞书未返回 app_access_token")
    return token


def build_feishu_oauth_url(app_id: str, redirect_uri: str, state: str = "toolbox") -> str:
    aid = app_id.strip()
    if not aid:
        raise ValueError("请先填写飞书应用的 App ID")
    q = urllib.parse.urlencode(
        {
            "app_id": aid,
            "redirect_uri": redirect_uri,
            "state": state,
        }
    )
    return f"{_BASE_URL}/authen/v1/authorize?{q}"


def exchange_feishu_oauth_code(*, app_id: str, app_secret: str, code: str) -> dict[str, Any]:
    """用飞书 OAuth code 换取当前登录用户的姓名与 open_id 并持久化保存。"""
    from tools.settings_store import put

    auth_code = (code or "").strip()
    if not auth_code:
        raise ValueError("缺少授权 code")

    app_token = get_app_access_token(app_id, app_secret)
    tok_res = _request_json(
        "POST",
        "/authen/v1/oidc/access_token",
        token=app_token,
        body={"grant_type": "authorization_code", "code": auth_code},
    )
    tok_data = tok_res.get("data") or {}
    user_token = str(tok_data.get("access_token") or "").strip()
    refresh_token = str(tok_data.get("refresh_token") or "").strip()
    expires_in = int(tok_data.get("expires_in") or 7200)
    if not user_token:
        raise RuntimeError("飞书登录未返回 user_access_token")

    info_res = _request_json("GET", "/authen/v1/user_info", token=user_token)
    u = info_res.get("data") or {}
    open_id = str(u.get("open_id") or "").strip()
    name = str(u.get("name") or u.get("en_name") or "").strip()
    if not open_id:
        raise RuntimeError("未获取到飞书用户 open_id")

    put(_KEY_USER_OPEN_ID, open_id)
    put(_KEY_USER_NAME, name)
    put(_KEY_USER_ACCESS_TOKEN, user_token)
    if refresh_token:
        put(_KEY_USER_REFRESH_TOKEN, refresh_token)
    put(_KEY_USER_EXPIRES_AT, str(int(time.time()) + expires_in))

    return {"ok": True, "open_id": open_id, "name": name}


def send_feishu_report_notification(
    *,
    app_id: str,
    app_secret: str,
    open_id: str = "",
    project: str = "",
    flow_no: str = "",
    report_url: str = "",
    initial_result: str = "",
    summary: str = "",
) -> dict[str, Any]:
    """通过飞书应用机器人私聊通知已扫码登录的测试人员（使用永久 open_id + 应用凭证，长测不失效）。"""
    target_open_id = (open_id or load_feishu_config().get("user_open_id") or "").strip()
    if not target_open_id:
        raise ValueError("尚未扫码登录飞书，请先点击「扫码登录飞书」获取本人信息")

    token = get_tenant_access_token(app_id, app_secret)

    lines: list[list[dict[str, Any]]] = []
    if project or flow_no:
        lines.append([{"tag": "text", "text": f"项目：{project or '-'}  |  流程号：{flow_no or '-'}"}])
    if initial_result:
        lines.append([{"tag": "text", "text": f"当前初判：{initial_result}"}])
    if summary:
        lines.append([{"tag": "text", "text": summary}])
    if report_url:
        lines.append([
            {"tag": "text", "text": "在线报告："},
            {"tag": "a", "text": "点击打开飞书表格", "href": report_url},
        ])

    post_body = {
        "zh_cn": {
            "title": "eMMC 测试报告已更新",
            "content": lines or [[{"tag": "text", "text": "eMMC 测试结果已写入在线报告"}]],
        }
    }
    res = _request_json(
        "POST",
        "/im/v1/messages?receive_id_type=open_id",
        token=token,
        body={
            "receive_id": target_open_id,
            "msg_type": "post",
            "content": json.dumps(post_body, ensure_ascii=False),
        },
    )
    msg_id = str((res.get("data") or {}).get("message_id") or "").strip()
    return {"ok": True, "open_id": target_open_id, "message_id": msg_id}
