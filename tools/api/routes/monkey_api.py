#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ADB Monkey 压力测试任务。"""

from __future__ import annotations

import threading
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from tools.adb_runtime import adb_available
from tools.adb_tools.monkey_job import (
    list_device_monkey_pids,
    run_monkey,
    stop_device_monkey,
)
from tools.api.deps import evict_finished_jobs, require_sn as _require_sn

router = APIRouter()


class MonkeyStartBody(BaseModel):
    event_count: int = Field(10000, ge=1, le=10_000_000)
    throttle_ms: int = Field(300, ge=0, le=60_000)
    packages: list[str] = Field(default_factory=list)
    seed: int | None = None
    verbose: int = Field(1, ge=0, le=3)
    ignore_crashes: bool = True
    ignore_timeouts: bool = True
    ignore_security: bool = True
    kill_process_after: bool = False


@dataclass
class _MonkeyJob:
    id: str
    device: str
    stop: threading.Event
    state: str = "running"  # running|done|error|stopped
    message: str = ""
    command: str = ""
    event_count: int = 0
    throttle_ms: int = 0
    packages: list[str] = field(default_factory=list)
    started_at: str = ""
    finished_at: str = ""
    logs: deque[str] = field(default_factory=lambda: deque(maxlen=2000))
    log_seq: int = 0
    result: dict = field(default_factory=dict)


_LOCK = threading.Lock()
_JOBS: dict[str, _MonkeyJob] = {}
_BY_DEVICE: dict[str, str] = {}


def _payload(job: _MonkeyJob) -> dict:
    return {
        "job_id": job.id,
        "device": job.device,
        "state": job.state,
        "message": job.message,
        "command": job.command,
        "event_count": job.event_count,
        "throttle_ms": job.throttle_ms,
        "packages": list(job.packages),
        "started_at": job.started_at,
        "finished_at": job.finished_at,
        "running": job.state == "running",
        "logs": list(job.logs),
        "log_cursor": job.log_seq,
        "result": job.result,
    }


@router.post("/monkey")
def monkey_start(body: MonkeyStartBody | None = None, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    if not adb_available():
        raise HTTPException(status_code=503, detail="adb 不可用")
    b = body or MonkeyStartBody()
    pkgs = [p.strip() for p in (b.packages or []) if str(p or "").strip()]

    with _LOCK:
        old_id = _BY_DEVICE.get(sn)
        if old_id and old_id in _JOBS and _JOBS[old_id].state == "running":
            raise HTTPException(status_code=409, detail="该设备已有 Monkey 任务进行中")
        evict_finished_jobs(
            _JOBS, is_running=lambda j: j.state == "running", max_finished=50
        )
        job_id = uuid.uuid4().hex[:12]
        job = _MonkeyJob(
            id=job_id,
            device=sn,
            stop=threading.Event(),
            message="正在启动 Monkey…",
            event_count=int(b.event_count),
            throttle_ms=int(b.throttle_ms),
            packages=pkgs,
            started_at=datetime.now().isoformat(timespec="seconds"),
        )
        _JOBS[job_id] = job
        _BY_DEVICE[sn] = job_id

    def _run() -> None:
        def on_line(line: str) -> None:
            with _LOCK:
                job.logs.append(line)
                job.log_seq += 1
                if line.startswith("$ adb"):
                    job.command = line.split("shell ", 1)[-1].strip()
                    job.message = "Monkey 运行中…"

        try:
            result = run_monkey(
                sn,
                event_count=b.event_count,
                throttle_ms=b.throttle_ms,
                packages=pkgs,
                seed=b.seed,
                verbose=b.verbose,
                ignore_crashes=b.ignore_crashes,
                ignore_timeouts=b.ignore_timeouts,
                ignore_security=b.ignore_security,
                kill_process_after=b.kill_process_after,
                stop_event=job.stop,
                on_line=on_line,
            )
            with _LOCK:
                job.result = result
                job.finished_at = datetime.now().isoformat(timespec="seconds")
                job.command = str(result.get("command") or job.command)
                if result.get("stopped"):
                    job.state = "stopped"
                elif result.get("ok"):
                    job.state = "done"
                else:
                    job.state = "error"
                job.message = str(result.get("message") or job.message)
        except Exception as exc:  # noqa: BLE001
            with _LOCK:
                job.state = "error"
                job.message = str(exc)
                job.finished_at = datetime.now().isoformat(timespec="seconds")
                job.result = {"ok": False, "message": str(exc)}
                job.logs.append(f"[error] {exc}")
                job.log_seq += 1

    threading.Thread(target=_run, name=f"monkey-{job_id}", daemon=True).start()
    return {
        "ok": True,
        "message": "Monkey 已启动",
        **_payload(job),
    }


@router.get("/monkey/jobs/{job_id}")
def monkey_job(job_id: str, since: int = Query(0, ge=0)) -> dict:
    with _LOCK:
        job = _JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Monkey 任务不存在")
        logs = list(job.logs)
        cursor = job.log_seq
        payload = _payload(job)
    base_seq = max(0, cursor - len(logs))
    start_idx = max(0, int(since) - base_seq)
    payload["logs"] = logs[start_idx:]
    payload["log_cursor"] = cursor
    return payload


@router.get("/monkey/active")
def monkey_active(device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    with _LOCK:
        job_id = _BY_DEVICE.get(sn)
        job = _JOBS.get(job_id) if job_id else None
        if not job or job.state != "running":
            job_payload = None
            job_active = False
        else:
            job_payload = _payload(job)
            job_active = True

    device_pids: list[str] = []
    if adb_available():
        try:
            device_pids = list_device_monkey_pids(sn)
        except Exception:
            device_pids = []
    device_running = bool(device_pids)

    return {
        "device": sn,
        "active": job_active,
        "job": job_payload,
        "device_monkey": {
            "running": device_running,
            "pids": device_pids,
        },
    }


@router.post("/monkey/stop")
def monkey_stop_device(device: str = Query(...)) -> dict:
    """停止本机任务（若有）并结束设备上已有的 monkey，无需先点开始。"""
    sn = _require_sn(device)
    if not adb_available():
        raise HTTPException(status_code=503, detail="adb 不可用")

    job_id = ""
    with _LOCK:
        old_id = _BY_DEVICE.get(sn)
        job = _JOBS.get(old_id) if old_id else None
        if job and job.state == "running":
            job_id = job.id
            job.stop.set()
            job.message = "正在停止（断开 ADB 并重连）…"

    before = []
    try:
        before = list_device_monkey_pids(sn)
    except Exception:
        before = []

    # 同步停止：用户期望点停止就能清掉设备上的 monkey
    detail = stop_device_monkey(sn, bounce=True)
    after = []
    try:
        after = list_device_monkey_pids(sn)
    except Exception:
        after = []

    still = bool(after)
    msg = (
        "设备上仍有 monkey 进程，请稍后重试停止"
        if still
        else (
            "已停止设备上的 Monkey"
            + (f"（原 PID: {', '.join(before)}）" if before else "")
        )
    )
    if detail:
        msg = f"{msg}；{detail}"

    return {
        "ok": not still,
        "message": msg,
        "device": sn,
        "job_id": job_id or None,
        "running": False,
        "device_monkey": {"running": still, "pids": after},
        "stopped_pids": before,
    }


@router.post("/monkey/jobs/{job_id}/stop")
def monkey_stop(job_id: str) -> dict:
    with _LOCK:
        job = _JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Monkey 任务不存在")
        if job.state != "running":
            return {"ok": True, "message": "任务已结束", **_payload(job)}
        device = job.device
        job.stop.set()
        job.message = "正在停止（断开 ADB 并重连）…"
    # 立刻后台：杀 monkey + 断开重连 ADB（与手工拔线重连接近）
    threading.Thread(
        target=stop_device_monkey,
        args=(device,),
        kwargs={"bounce": True},
        name=f"monkey-stop-{job_id}",
        daemon=True,
    ).start()
    return {
        "ok": True,
        "message": "已请求停止（正在断开并重连 ADB）",
        "job_id": job_id,
        "running": True,
    }
