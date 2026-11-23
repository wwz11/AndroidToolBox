#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ADB 远端文件系统管理接口（ls / stat / pull / push / 增删改查）。"""

from __future__ import annotations

import asyncio
import json
import tempfile
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from tools.adb_tools.core import (
    adb_chmod,
    adb_copy,
    adb_create_file,
    adb_delete_path,
    adb_df_path,
    adb_find_remote,
    adb_md5_remote,
    adb_mkdir,
    adb_pull_file,
    adb_push_file,
    adb_read_remote_file,
    adb_rename,
    adb_stat,
    adb_write_remote_file,
    list_remote_entries,
    parent_remote_path,
)
from tools.adb_tools.remote_fs import adb_pull_with_progress, adb_push_with_progress
from tools.api.deps import require_sn as _require_sn
from tools.api.routes.adb_pkg_routes import _write_upload_to_path

router = APIRouter()


class PullBody(BaseModel):
    remote: str = Field(..., min_length=1)
    local: str = ""


class PushPathBody(BaseModel):
    local: str = Field(..., min_length=1)
    remote: str = Field(..., min_length=1)


class RemotePathBody(BaseModel):
    path: str = Field(..., min_length=1)


class RemoteDeleteBody(BaseModel):
    path: str = Field(..., min_length=1)
    recursive: bool = False


class RemoteRenameBody(BaseModel):
    src: str = Field(..., min_length=1)
    dst: str = Field(..., min_length=1)


class RemoteCopyBody(BaseModel):
    src: str = Field(..., min_length=1)
    dst: str = Field(..., min_length=1)
    recursive: bool = True


class RemoteChmodBody(BaseModel):
    path: str = Field(..., min_length=1)
    mode: str = Field(..., min_length=3, max_length=4)


def _default_pull_local(remote: str, local_hint: str) -> Path:
    """本机路径为空或为目录时，落到 userdata/output/adb_pulls/<文件名>。"""
    from tools.bundled_paths import output_dir

    name = Path((remote or "").rstrip("/")).name or "pulled.bin"
    hint = (local_hint or "").strip()
    if not hint:
        out_dir = output_dir("adb_pulls")
        return (out_dir / name).resolve()
    local = Path(hint).expanduser()
    if hint.endswith(("/", "\\")) or (local.exists() and local.is_dir()):
        local.mkdir(parents=True, exist_ok=True)
        return (local / name).resolve()
    local.parent.mkdir(parents=True, exist_ok=True)
    return local.resolve()


def _normalize_push_remote(remote: str, filename: str) -> str:
    """Push 目标为目录时自动拼接文件名。"""
    target = (remote or "").strip() or "/sdcard/"
    if not target.startswith("/"):
        target = f"/{target}"
    name = Path(str(filename).replace("\\", "/")).name or "upload.bin"
    if target.endswith("/"):
        return f"{target}{name}"
    # 无扩展名时按目录处理（避免把 /sdcard/Download 当成文件覆盖）
    base = Path(target).name
    if "." not in base:
        return f"{target.rstrip('/')}/{name}"
    return target


@router.get("/ls")
def list_dir(device: str = Query(...), path: str = "/") -> dict:
    sn = _require_sn(device)
    try:
        directory, entries = list_remote_entries(sn, path)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "path": directory.rstrip("/") or "/",
        "parent": parent_remote_path(directory),
        "entries": [
            {
                "name": e.name,
                "path": e.path,
                "is_dir": e.is_dir,
                "size": e.size,
                "mtime": e.mtime,
                "mode": e.mode,
                "owner": e.owner,
                "group": e.group,
                "is_link": e.is_link,
                "link_target": e.link_target,
            }
            for e in entries
        ],
    }


@router.get("/stat")
def stat_path(device: str = Query(...), path: str = Query(...)) -> dict:
    sn = _require_sn(device)
    try:
        info = adb_stat(sn, path)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"device": sn, "ok": True, **info}


@router.post("/rename")
def rename_path(body: RemoteRenameBody, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    try:
        result = adb_rename(sn, body.src, body.dst)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "ok": result.ok,
        "src": body.src,
        "dst": body.dst,
        "output": result.output,
        "message": result.output.strip() or ("完成" if result.ok else "失败"),
    }


@router.post("/copy")
def copy_path(body: RemoteCopyBody, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    try:
        result = adb_copy(sn, body.src, body.dst, recursive=body.recursive)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "ok": result.ok,
        "src": body.src,
        "dst": body.dst,
        "output": result.output,
        "message": result.output.strip() or ("完成" if result.ok else "失败"),
    }


@router.post("/chmod")
def chmod_path(body: RemoteChmodBody, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    try:
        result = adb_chmod(sn, body.path, body.mode)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "ok": result.ok,
        "path": body.path,
        "mode": body.mode,
        "output": result.output,
        "message": result.output.strip() or ("完成" if result.ok else "失败"),
    }


@router.post("/mkdir")
def mkdir(body: RemotePathBody, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    try:
        result = adb_mkdir(sn, body.path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "ok": result.ok,
        "path": body.path,
        "output": result.output,
        "message": result.output.strip() or ("完成" if result.ok else "失败"),
    }


@router.post("/create-file")
def create_file(body: RemotePathBody, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    try:
        result = adb_create_file(sn, body.path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "ok": result.ok,
        "path": body.path,
        "output": result.output,
        "message": result.output.strip() or ("完成" if result.ok else "失败"),
    }


@router.post("/delete")
def delete_path(body: RemoteDeleteBody, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    try:
        result = adb_delete_path(sn, body.path, recursive=body.recursive)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "ok": result.ok,
        "path": body.path,
        "output": result.output,
        "message": result.output.strip() or ("完成" if result.ok else "失败"),
    }


@router.post("/pull")
def pull(body: PullBody, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    try:
        local = _default_pull_local(body.remote, body.local)
        result = adb_pull_file(sn, body.remote, local)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    saved = str(result.saved_path) if result.saved_path else str(local)
    return {
        "device": sn,
        "ok": result.ok,
        "returncode": result.returncode,
        "output": result.output,
        "saved_path": saved,
    }


@router.post("/push")
async def push_upload(
    device: str = Query(...),
    remote: str = Form(...),
    mkdir_parent: bool = Form(False),
    file: UploadFile = File(...),
) -> dict:
    sn = _require_sn(device)
    # 浏览器/Electron 偶发带上本机全路径，只取文件名
    name = Path(str(file.filename or "upload.bin").replace("\\", "/")).name or "upload.bin"
    dest = _normalize_push_remote(remote, name)
    try:
        if mkdir_parent:
            parent = parent_remote_path(dest)
            if parent and parent != "/":
                await asyncio.to_thread(adb_mkdir, sn, parent)
        with tempfile.TemporaryDirectory(prefix="toolbox_push_") as tmp:
            local = Path(tmp) / name
            await _write_upload_to_path(file, local)
            result = await asyncio.to_thread(adb_push_file, sn, local, dest)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "ok": result.ok,
        "returncode": result.returncode,
        "output": result.output,
        "remote": dest,
        "filename": name,
    }


class RemoteWriteBody(BaseModel):
    path: str = Field(..., min_length=1)
    content: str = ""


@router.get("/fs/df")
def fs_df(device: str = Query(...), path: str = "/") -> dict:
    sn = _require_sn(device)
    try:
        info = adb_df_path(sn, path)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"device": sn, "path": path, **info}


@router.get("/fs/find")
def fs_find(
    device: str = Query(...),
    path: str = "/",
    q: str = Query(..., min_length=1),
) -> dict:
    sn = _require_sn(device)
    try:
        items = adb_find_remote(sn, path, q)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"device": sn, "base": path, "query": q, "items": items, "count": len(items)}


@router.get("/fs/md5")
def fs_md5(device: str = Query(...), path: str = Query(..., min_length=1)) -> dict:
    sn = _require_sn(device)
    try:
        digest = adb_md5_remote(sn, path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"device": sn, "path": path, "md5": digest}


@router.get("/fs/read")
def fs_read(device: str = Query(...), path: str = Query(..., min_length=1)) -> dict:
    sn = _require_sn(device)
    try:
        data = adb_read_remote_file(sn, path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"device": sn, **data}


@router.post("/fs/write")
def fs_write(body: RemoteWriteBody, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    try:
        result = adb_write_remote_file(sn, body.path, body.content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "ok": result.ok,
        "output": result.output,
        "path": body.path,
    }


@router.post("/push-path")
def push_path(body: PushPathBody, device: str = Query(...)) -> dict:
    """本机已有文件路径推送（桌面侧车场景）。"""
    sn = _require_sn(device)
    local = Path(body.local).expanduser()
    dest = _normalize_push_remote(body.remote, local.name)
    try:
        result = adb_push_file(sn, local, dest)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "ok": result.ok,
        "returncode": result.returncode,
        "output": result.output,
        "remote": dest,
        "local": str(local.resolve()) if local.exists() else str(local),
        "filename": local.name,
    }


def _stream_adb_transfer(
    request: Request,
    worker: Callable[[Callable[[dict[str, Any]], None], threading.Event], dict[str, Any]],
) -> StreamingResponse:
    """将阻塞式推/拉任务包装为 NDJSON 流式进度响应，并在客户端断开时终止子进程。"""

    async def event_gen():
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        cancel_event = threading.Event()

        def emit(payload: dict[str, Any]) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, payload)

        def run_worker() -> None:
            try:
                done_payload = worker(emit, cancel_event)
                emit({"type": "done", **done_payload})
            except Exception as exc:
                emit({"type": "error", "detail": str(exc)})
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        task = asyncio.create_task(asyncio.to_thread(run_worker))
        try:
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=0.35)
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


@router.post("/pull-stream")
def pull_stream(request: Request, body: PullBody, device: str = Query(...)) -> StreamingResponse:
    sn = _require_sn(device)
    local = _default_pull_local(body.remote, body.local)

    def worker(emit: Callable[[dict[str, Any]], None], cancel_event: threading.Event) -> dict[str, Any]:
        result = adb_pull_with_progress(sn, body.remote, local, emit, cancel_event)
        saved = str(result.saved_path) if result.saved_path else str(local)
        return {
            "device": sn,
            "ok": result.ok,
            "returncode": result.returncode,
            "output": result.output,
            "saved_path": saved,
        }

    return _stream_adb_transfer(request, worker)


@router.post("/push-path-stream")
def push_path_stream(
    request: Request, body: PushPathBody, device: str = Query(...)
) -> StreamingResponse:
    sn = _require_sn(device)
    local = Path(body.local).expanduser()
    dest = _normalize_push_remote(body.remote, local.name)

    def worker(emit: Callable[[dict[str, Any]], None], cancel_event: threading.Event) -> dict[str, Any]:
        result = adb_push_with_progress(sn, local, dest, emit, cancel_event)
        return {
            "device": sn,
            "ok": result.ok,
            "returncode": result.returncode,
            "output": result.output,
            "remote": dest,
            "local": str(local.resolve()) if local.exists() else str(local),
            "filename": local.name,
        }

    return _stream_adb_transfer(request, worker)


@router.post("/push-stream")
async def push_upload_stream(
    request: Request,
    device: str = Query(...),
    remote: str = Form(...),
    mkdir_parent: bool = Form(False),
    file: UploadFile = File(...),
) -> StreamingResponse:
    sn = _require_sn(device)
    name = Path(str(file.filename or "upload.bin").replace("\\", "/")).name or "upload.bin"
    dest = _normalize_push_remote(remote, name)
    tmp_dir = tempfile.TemporaryDirectory(prefix="toolbox_push_")
    local = Path(tmp_dir.name) / name
    try:
        if mkdir_parent:
            parent = parent_remote_path(dest)
            if parent and parent != "/":
                await asyncio.to_thread(adb_mkdir, sn, parent)
        await _write_upload_to_path(file, local)
    except Exception as exc:
        tmp_dir.cleanup()
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    def worker(emit: Callable[[dict[str, Any]], None], cancel_event: threading.Event) -> dict[str, Any]:
        try:
            result = adb_push_with_progress(sn, local, dest, emit, cancel_event)
            return {
                "device": sn,
                "ok": result.ok,
                "returncode": result.returncode,
                "output": result.output,
                "remote": dest,
                "filename": name,
            }
        finally:
            tmp_dir.cleanup()

    return _stream_adb_transfer(request, worker)
