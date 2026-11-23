#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ADB 设备磁盘空间填充与释放后台任务路由。"""

from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from tools.adb_runtime import adb_available
from tools.adb_tools.core import (
    fill_device_memory,
    preview_fill_memory,
    release_device_memory,
)
from tools.api.deps import evict_finished_jobs, require_sn as _require_sn

router = APIRouter()


class FillMemoryBody(BaseModel):
    fill_pct: int = Field(100, ge=1, le=100)
    reserve_mb: int = Field(32, ge=0, le=8192)
    fill_dir: str = ""


class FillReleaseBody(BaseModel):
    fill_dir: str = ""


@dataclass
class _FillJob:
    id: str
    device: str
    stop: threading.Event
    state: str = "running"  # running|done|error|stopped
    message: str = ""
    fill_pct: int = 90
    target_bytes: int = 0
    target_label: str = ""
    written_bytes: int = 0
    written_label: str = "0 B"
    pct: int = 0
    started_at: str = ""
    finished_at: str = ""
    result: dict = field(default_factory=dict)


_FILL_LOCK = threading.Lock()
_FILL_JOBS: dict[str, _FillJob] = {}
_FILL_BY_DEVICE: dict[str, str] = {}


def _fill_job_payload(job: _FillJob) -> dict:
    return {
        "job_id": job.id,
        "device": job.device,
        "state": job.state,
        "message": job.message,
        "fill_pct": job.fill_pct,
        "target_bytes": job.target_bytes,
        "target_label": job.target_label,
        "written_bytes": job.written_bytes,
        "written_label": job.written_label,
        "pct": job.pct,
        "started_at": job.started_at,
        "finished_at": job.finished_at,
        "running": job.state == "running",
        "result": job.result,
    }


@router.get("/fill-memory/preview")
def fill_memory_preview(
    device: str = Query(...),
    fill_pct: int = Query(100, ge=1, le=100),
    reserve_mb: int = Query(32, ge=0, le=8192),
    fill_dir: str = Query(""),
) -> dict:
    sn = _require_sn(device)
    if not adb_available():
        raise HTTPException(status_code=503, detail="adb 不可用")
    try:
        preview = preview_fill_memory(
            sn, fill_pct=fill_pct, reserve_mb=reserve_mb, fill_dir=fill_dir
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"device": sn, **preview}


@router.post("/fill-memory")
def fill_memory(body: FillMemoryBody | None = None, device: str = Query(...)) -> dict:
    """后台按百分比填充所选路径所在分区的可用空间。"""
    sn = _require_sn(device)
    if not adb_available():
        raise HTTPException(status_code=503, detail="adb 不可用")
    pct = int((body.fill_pct if body else 100) or 100)
    reserve = int((body.reserve_mb if body else 32) or 32)
    fill_dir = (body.fill_dir if body else "") or ""
    try:
        preview = preview_fill_memory(
            sn, fill_pct=pct, reserve_mb=reserve, fill_dir=fill_dir
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if not preview.get("ok"):
        raise HTTPException(
            status_code=400, detail=str(preview.get("message") or "无法开始填充")
        )

    with _FILL_LOCK:
        old_id = _FILL_BY_DEVICE.get(sn)
        if old_id and old_id in _FILL_JOBS and _FILL_JOBS[old_id].state == "running":
            raise HTTPException(status_code=409, detail="该设备已有填充任务进行中")
        job_id = uuid.uuid4().hex[:12]
        job = _FillJob(
            id=job_id,
            device=sn,
            stop=threading.Event(),
            fill_pct=int(preview["fill_pct"]),
            target_bytes=int(preview["target_bytes"]),
            target_label=str(preview["target_label"]),
            message="排队中…",
            started_at=datetime.now().isoformat(timespec="seconds"),
        )
        evict_finished_jobs(
            _FILL_JOBS, is_running=lambda j: j.state == "running", max_finished=50
        )
        _FILL_JOBS[job_id] = job
        _FILL_BY_DEVICE[sn] = job_id

    def _run() -> None:
        def on_progress(info: dict) -> None:
            with _FILL_LOCK:
                job.state = str(info.get("state") or "running")
                job.message = str(info.get("message") or "")
                job.written_bytes = int(info.get("written_bytes") or 0)
                job.written_label = str(info.get("written_label") or "0 B")
                job.target_bytes = int(info.get("target_bytes") or job.target_bytes)
                job.target_label = str(info.get("target_label") or job.target_label)
                job.pct = int(info.get("pct") or 0)

        try:
            result = fill_device_memory(
                sn,
                fill_pct=pct,
                reserve_mb=reserve,
                fill_dir=fill_dir,
                stop_event=job.stop,
                on_progress=on_progress,
            )
            with _FILL_LOCK:
                job.result = result
                job.finished_at = datetime.now().isoformat(timespec="seconds")
                if result.get("stopped"):
                    job.state = "stopped"
                elif result.get("ok"):
                    job.state = "done"
                else:
                    job.state = "error"
                job.message = str(result.get("message") or job.message)
                job.written_bytes = int(
                    result.get("filled_bytes") or job.written_bytes
                )
                job.written_label = str(
                    result.get("filled_label") or job.written_label
                )
                if job.target_bytes:
                    job.pct = min(
                        100, int(job.written_bytes * 100 / job.target_bytes)
                    )
        except Exception as exc:  # noqa: BLE001
            with _FILL_LOCK:
                job.state = "error"
                job.message = str(exc)
                job.finished_at = datetime.now().isoformat(timespec="seconds")
                job.result = {"ok": False, "message": str(exc)}

    threading.Thread(target=_run, name=f"fill-{job_id}", daemon=True).start()
    return {
        "device": sn,
        "ok": True,
        "message": "填充任务已启动",
        **_fill_job_payload(job),
        **{k: preview[k] for k in ("avail_label", "usable_label", "path", "fill_dir")},
    }


@router.get("/fill-memory/jobs/{job_id}")
def fill_memory_job(job_id: str) -> dict:
    with _FILL_LOCK:
        job = _FILL_JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="填充任务不存在")
        payload = _fill_job_payload(job)
    return payload


@router.get("/fill-memory/active")
def fill_memory_active(device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    with _FILL_LOCK:
        job_id = _FILL_BY_DEVICE.get(sn)
        job = _FILL_JOBS.get(job_id) if job_id else None
        if not job:
            return {"device": sn, "active": False, "job": None}
        return {
            "device": sn,
            "active": job.state == "running",
            "job": _fill_job_payload(job),
        }


@router.post("/fill-memory/jobs/{job_id}/stop")
def fill_memory_stop(job_id: str) -> dict:
    with _FILL_LOCK:
        job = _FILL_JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="填充任务不存在")
        job.stop.set()
        if job.state == "running":
            job.message = "正在停止…"
    return {"job_id": job_id, "ok": True, "message": "已请求停止"}


@router.post("/fill-memory/release")
def fill_memory_release(
    body: FillReleaseBody | None = None, device: str = Query(...)
) -> dict:
    """释放一键填充占用的空间。"""
    sn = _require_sn(device)
    if not adb_available():
        raise HTTPException(status_code=503, detail="adb 不可用")
    fill_dir = (body.fill_dir if body else "") or ""
    with _FILL_LOCK:
        job_id = _FILL_BY_DEVICE.get(sn)
        job = _FILL_JOBS.get(job_id) if job_id else None
        if job and job.state == "running":
            raise HTTPException(status_code=409, detail="填充进行中，请先停止再释放")
    try:
        result = release_device_memory(sn, fill_dir=fill_dir)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"device": sn, **result}
