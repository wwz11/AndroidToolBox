#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ADB 设备会话内操作（设备信息、Shell、诊断抓取与子路由聚合）。"""

from __future__ import annotations

import base64
import tempfile
from io import BytesIO
from pathlib import Path

import asyncio
import json
import threading
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from tools.adb_runtime import adb_available, run_adb
from tools.adb_tools.capture_session import (
    ensure_session,
    export_filename,
    logcat_filename,
    session_info,
)
from tools.adb_tools.core import (
    BUILD_INFO_FIELDS,
    adb_package_pids,
    adb_root_device,
    capture_bugreport,
    capture_bugreport_with_progress,
    capture_dumpsys,
    capture_getprop,
    clear_logcat,
    collect_crash_artifacts,
    collect_device_card,
    dump_logcat,
    dump_ui_hierarchy,
    parse_ui_nodes,
    read_device_properties,
    run_adb_shell,
)
from tools.adb_tools.shell_presets import (
    load_shell_presets,
    save_shell_presets,
)
from tools.api.deps import require_sn as _require_sn
from tools.api.routes import adb_fs_routes, adb_memory_fill, adb_pkg_routes
from tools.api.routes.adb_fs_routes import (
    PullBody,
    PushPathBody,
    RemoteChmodBody,
    RemoteCopyBody,
    RemoteDeleteBody,
    RemotePathBody,
    RemoteRenameBody,
    _default_pull_local,
    _normalize_push_remote,
)
from tools.api.routes.adb_memory_fill import (
    FillMemoryBody,
    FillReleaseBody,
    _FILL_BY_DEVICE,
    _FILL_JOBS,
    _FILL_LOCK,
    _FillJob,
    _fill_job_payload,
)
from tools.api.routes.adb_pkg_routes import (
    PackageBody,
    UninstallBody,
    _write_upload_to_path,
)
from tools.screenshot.core import (
    capture_adb_screen,
    capture_adb_screen_png_bytes,
    copy_image_to_clipboard,
)

router = APIRouter()
router.include_router(adb_memory_fill.router)
router.include_router(adb_pkg_routes.router)
router.include_router(adb_fs_routes.router)


class ShellBody(BaseModel):
    command: str = Field(..., min_length=1)


class LogcatDumpBody(BaseModel):
    buffer: str = ""
    tag: str = ""
    level: str = ""
    pid: str = ""
    package: str = ""
    max_chars: int = Field(200_000, ge=1000, le=2_000_000)
    save: bool = True
    session: str = ""


class CrashCollectBody(BaseModel):
    session: str = ""


class DumpsysBody(BaseModel):
    service: str = "activity"
    save: bool = True
    max_chars: int = Field(400_000, ge=1000, le=2_000_000)
    session: str = ""


class PresetItem(BaseModel):
    cmd: str = Field(..., min_length=1)
    label: str = ""


class PresetsBody(BaseModel):
    presets: list[PresetItem] = Field(default_factory=list)


@router.get("/props")
def device_props(device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    if not adb_available():
        raise HTTPException(status_code=503, detail="adb 不可用")
    props: dict[str, str] = {}
    failed = 0
    dump = read_device_properties(sn)
    if dump is None:
        for field in BUILD_INFO_FIELDS:
            r = run_adb(["shell", "getprop", field.prop_key], sn, timeout=12.0)
            if r.returncode != 0:
                props[field.build_name] = "(error)"
                failed += 1
            else:
                props[field.build_name] = (r.stdout or "").strip()
        for key, prop in (
            ("ANDROID", "ro.build.version.release"),
            ("SDK", "ro.build.version.sdk"),
            ("SERIAL", "ro.serialno"),
        ):
            r = run_adb(["shell", "getprop", prop], sn, timeout=12.0)
            props[key] = (r.stdout or "").strip() if r.returncode == 0 else "(error)"
    else:
        for field in BUILD_INFO_FIELDS:
            props[field.build_name] = dump.get(field.prop_key, "")
        for key, prop in (
            ("ANDROID", "ro.build.version.release"),
            ("SDK", "ro.build.version.sdk"),
            ("SERIAL", "ro.serialno"),
        ):
            props[key] = dump.get(prop, "")
    return {"device": sn, "props": props, "failed": failed}


@router.get("/info")
def device_info(device: str = Query(...)) -> dict:
    """设备信息卡：型号 / 软件版本 / DDR / eMMC / IP 等一览。"""
    sn = _require_sn(device)
    if not adb_available():
        raise HTTPException(status_code=503, detail="adb 不可用")
    try:
        card = collect_device_card(sn)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "info": card.get("info") or {},
        "props": card.get("props") or {},
        "failed": int(card.get("failed") or 0),
    }


@router.post("/shell")
def shell(body: ShellBody, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    try:
        result = run_adb_shell(sn, body.command)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "command": body.command,
        "returncode": result.returncode,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "ok": result.returncode == 0,
    }


@router.post("/root")
def root(device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    try:
        msg = adb_root_device(sn)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"device": sn, "ok": True, "message": msg.strip() or "adb root 成功"}


@router.post("/screencap")
def screencap(device: str = Query(...), fast: bool = False) -> dict:
    sn = _require_sn(device)
    try:
        raw, width, height = capture_adb_screen_png_bytes(sn, fast=fast)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "ok": True,
        "mime": "image/png",
        "width": width,
        "height": height,
        "png_base64": base64.b64encode(raw).decode("ascii"),
    }


class ScreencapClipboardBody(BaseModel):
    image_base64: str = Field(..., min_length=1)


@router.post("/screencap/clipboard")
def screencap_clipboard(body: ScreencapClipboardBody) -> dict:
    """将 PNG/JPEG base64 写入系统剪贴板（Electron 剪贴板 API 失败时的兜底）。"""
    try:
        from PIL import Image

        raw = base64.b64decode(body.image_base64)
        img = Image.open(BytesIO(raw))
        img.load()
        copy_image_to_clipboard(img.convert("RGB"))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True, "message": "已复制到剪贴板"}


@router.get("/logcat/session")
def logcat_session_get(device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    info = session_info(sn)
    info["ok"] = True
    return info


@router.post("/logcat/session")
def logcat_session_post(
    device: str = Query(...),
    new: bool = Query(False),
) -> dict:
    sn = _require_sn(device)
    path = ensure_session(sn, force_new=new)
    info = session_info(sn)
    info["ok"] = True
    info["session"] = str(path)
    info["has_session"] = True
    info["message"] = "已新建本次目录" if new else "已就绪本次目录"
    return info


@router.post("/logcat/clear")
def logcat_clear(device: str = Query(...), buffer: str = "") -> dict:
    sn = _require_sn(device)
    try:
        clear_logcat(sn, buffer=buffer)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"device": sn, "ok": True, "message": "logcat 缓冲区已清空"}


@router.post("/logcat/dump")
def logcat_dump(body: LogcatDumpBody, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    saved_path = ""
    try:
        pid = (body.pid or "").strip()
        pkg = (body.package or "").strip()
        if pkg and not pid:
            pids = adb_package_pids(sn, pkg)
            if not pids:
                raise RuntimeError(f"应用 {pkg} 当前未运行（未找到 PID）")
            pid = pids[0]
        if body.save:
            session = ensure_session(sn, session_hint=body.session)
            out = session / logcat_filename(
                "logcat_dump",
                device=sn,
                buffer=body.buffer,
                tag=body.tag or pkg,
                level=body.level,
            )
            dump_logcat(
                sn,
                out,
                buffer=body.buffer,
                tag=body.tag,
                level=body.level,
                pid=pid,
            )
            saved_path = str(out.resolve())
            text = out.read_text(encoding="utf-8", errors="replace")
        else:
            with tempfile.TemporaryDirectory(prefix="toolbox_logcat_") as tmp:
                out = Path(tmp) / "logcat.txt"
                dump_logcat(
                    sn,
                    out,
                    buffer=body.buffer,
                    tag=body.tag,
                    level=body.level,
                    pid=pid,
                )
                text = out.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    truncated = False
    if len(text) > body.max_chars:
        text = text[-body.max_chars :]
        truncated = True
    return {
        "device": sn,
        "ok": True,
        "text": text,
        "truncated": truncated,
        "chars": len(text),
        "saved_path": saved_path,
        "pid": pid,
        "session": session_info(sn).get("session") or "",
    }


@router.post("/logcat/collect-crash")
def logcat_collect_crash(body: CrashCollectBody, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    try:
        session = ensure_session(sn, session_hint=body.session)
        res = collect_crash_artifacts(sn, session)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "session": str(session),
        **res,
    }


@router.post("/ui-dump")
def ui_dump(device: str = Query(...), only_with_id: bool = False) -> dict:
    sn = _require_sn(device)
    try:
        with tempfile.TemporaryDirectory(prefix="toolbox_ui_") as tmp:
            out = Path(tmp) / "window_dump.xml"
            path, xml = dump_ui_hierarchy(sn, out)
            nodes = parse_ui_nodes(xml)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    items = []
    for n in nodes:
        if only_with_id and not (n.resource_id or "").strip():
            continue
        items.append(
            {
                "depth": n.depth,
                "text": n.text,
                "resource_id": n.resource_id,
                "class": n.cls,
                "content_desc": n.content_desc,
                "package": n.package,
                "bounds": n.bounds,
                "clickable": n.clickable,
                "label": n.label,
            }
        )
    return {
        "device": sn,
        "ok": True,
        "path": str(path),
        "count": len(items),
        "nodes": items[:2000],
        "xml_preview": xml[:80_000],
    }


class CaptureSessionBody(BaseModel):
    session: str = ""


@router.post("/bugreport")
def bugreport(body: CaptureSessionBody | None = None, device: str = Query(...)) -> dict:
    """生成 bugreport（可能较慢），保存到本次 Log 抓取会话目录。"""
    sn = _require_sn(device)
    hint = (body.session if body else "") or ""
    session = ensure_session(sn, session_hint=hint)
    out = session / export_filename("bugreport", ext="zip")
    try:
        saved = capture_bugreport(sn, out)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "ok": True,
        "saved_path": str(saved),
        "session": str(session),
        "message": f"已保存到 {saved}",
    }


@router.post("/bugreport-stream")
def bugreport_stream(
    request: Request,
    body: CaptureSessionBody | None = None,
    device: str = Query(...),
) -> StreamingResponse:
    """流式生成 bugreport，推送耗时/大小/阶段进度，支持客户端断开取消。"""
    sn = _require_sn(device)
    hint = (body.session if body else "") or ""
    session = ensure_session(sn, session_hint=hint)
    out = session / export_filename("bugreport", ext="zip")

    async def event_gen():
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[dict | None] = asyncio.Queue()
        cancel_event = threading.Event()

        def emit(payload: dict) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, payload)

        def run_worker() -> None:
            try:
                saved = capture_bugreport_with_progress(sn, out, emit, cancel_event)
                emit(
                    {
                        "type": "done",
                        "device": sn,
                        "ok": True,
                        "saved_path": str(saved),
                        "session": str(session),
                        "message": f"已保存到 {saved}",
                    }
                )
            except Exception as exc:
                emit({"type": "error", "detail": str(exc)})
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        task = asyncio.create_task(asyncio.to_thread(run_worker))
        try:
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=0.4)
                except asyncio.TimeoutError:
                    if await request.is_disconnected():
                        cancel_event.set()
                        break
                    continue
                if item is None:
                    break
                yield json.dumps(item, ensure_ascii=False) + "\n"
        finally:
            cancel_event.set()
            try:
                await task
            except Exception:
                pass

    return StreamingResponse(event_gen(), media_type="application/x-ndjson")


@router.post("/dumpsys")
def dumpsys(body: DumpsysBody, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    svc = (body.service or "activity").strip() or "activity"
    session = (
        ensure_session(sn, session_hint=body.session) if body.save else None
    )
    out = (
        (session / export_filename(f"dumpsys_{svc}"))
        if session is not None
        else Path()
    )
    try:
        if body.save:
            assert session is not None
            saved = capture_dumpsys(sn, svc, out)
            text = saved.read_text(encoding="utf-8", errors="replace")
            saved_path = str(saved)
        else:
            with tempfile.TemporaryDirectory(prefix="toolbox_dumpsys_") as tmp:
                saved = capture_dumpsys(sn, svc, Path(tmp) / "dumpsys.txt")
                text = saved.read_text(encoding="utf-8", errors="replace")
                saved_path = ""
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    truncated = False
    if len(text) > body.max_chars:
        text = text[: body.max_chars]
        truncated = True
    return {
        "device": sn,
        "ok": True,
        "service": svc,
        "saved_path": saved_path,
        "session": str(session) if session else "",
        "truncated": truncated,
        "chars": len(text),
        "text": text,
        "message": f"dumpsys {svc}" + (f" → {saved_path}" if saved_path else ""),
    }


class GetpropBody(BaseModel):
    session: str = ""
    save: bool = True
    max_chars: int = Field(400_000, ge=1000, le=2_000_000)


@router.post("/getprop")
def getprop_export(
    body: GetpropBody | None = None,
    device: str = Query(...),
    save: bool = Query(True),
    max_chars: int = Query(400_000, ge=1000, le=2_000_000),
) -> dict:
    sn = _require_sn(device)
    do_save = body.save if body is not None else save
    limit = body.max_chars if body is not None else max_chars
    hint = (body.session if body is not None else "") or ""
    session = ensure_session(sn, session_hint=hint) if do_save else None
    try:
        if do_save:
            assert session is not None
            out = session / export_filename("getprop")
            saved = capture_getprop(sn, out)
            text = saved.read_text(encoding="utf-8", errors="replace")
            saved_path = str(saved)
        else:
            with tempfile.TemporaryDirectory(prefix="toolbox_getprop_") as tmp:
                saved = capture_getprop(sn, Path(tmp) / "getprop.txt")
                text = saved.read_text(encoding="utf-8", errors="replace")
                saved_path = ""
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    truncated = False
    if len(text) > limit:
        text = text[:limit]
        truncated = True
    return {
        "device": sn,
        "ok": True,
        "saved_path": saved_path,
        "session": str(session) if session else "",
        "truncated": truncated,
        "chars": len(text),
        "text": text,
        "message": "getprop" + (f" → {saved_path}" if saved_path else ""),
    }


@router.get("/shell/presets")
def shell_presets_get() -> dict:
    return {"presets": load_shell_presets()}


@router.put("/shell/presets")
def shell_presets_put(body: PresetsBody) -> dict:
    items = [
        {"cmd": p.cmd, "label": (p.label or "").strip() or p.cmd}
        for p in body.presets
    ]
    save_shell_presets(items)
    return {"ok": True, "presets": load_shell_presets()}
