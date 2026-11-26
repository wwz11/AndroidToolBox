#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""eMMC 自动化任务（headless pipeline）与报告。"""

from __future__ import annotations

import re
import tempfile
import threading
import uuid
from collections import deque
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from tools.api.deps import evict_finished_jobs
from tools.bundled_paths import app_base_dir
from tools.emmc_test.auto_runner import AUTO_LABELS, AUTO_STEPS
from tools.emmc_test.headless_log import emmc_logs_dir
from tools.emmc_test.headless_steps import DeviceStepParams, StepEnv, order_steps, run_pipeline
from tools.emmc_test.report_template import (
    ReportHeaderMeta,
    create_report_with_header,
    emmc_reports_dir,
    ensure_flow_report,
    flow_lock,
    get_feishu_report_for_flow,
    read_report_header,
    report_filename,
    report_path_for_flow,
    report_path_for_project,
    set_feishu_report_for_flow,
    synced_template_path,
    update_report_header,
)
from tools.feishu_sheets import (
    build_feishu_oauth_url,
    copy_feishu_spreadsheet,
    exchange_feishu_oauth_code,
    find_feishu_spreadsheet_in_folder,
    get_feishu_reports_folder_url,
    is_feishu_file_alive,
    load_feishu_config,
    logout_feishu_user,
    save_feishu_config,
    send_feishu_report_notification,
    sync_report_xlsx_to_feishu,
    test_feishu_connection,
)
from tools.tide_oa import (
    fetch_emmc_flow_header,
    load_tide_oa_status,
    logout_tide_oa,
    validate_and_save_tide_token,
)

router = APIRouter()


@dataclass
class _Job:
    id: str
    sn: str
    flow_no: str
    steps: list[str]
    stop: threading.Event
    logs: deque[str] = field(default_factory=lambda: deque(maxlen=2000))
    log_seq: int = 0
    running: bool = False
    ok: bool | None = None
    error: str = ""
    started_at: str = ""
    finished_at: str = ""
    report_path: str = ""
    feishu_report_url: str = ""
    current_step: str = ""
    step_results: dict[str, str] = field(default_factory=dict)
    # 每项进度：{ step_id: { current, total, text } }
    step_progress: dict[str, dict[str, int | str]] = field(default_factory=dict)
    progress_current: int = 0
    progress_total: int = 0
    progress_text: str = ""


_JOBS: dict[str, _Job] = {}
_LOCK = threading.Lock()


class EmmcParams(BaseModel):
    loop_num: int | None = None
    stress_max_run_minutes: float | None = None
    iozone_file_size_mb: int | None = None
    samsung_emmc: bool | None = None
    iozone_write_min_mbs: float | None = None
    iozone_read_min_mbs: float | None = None
    reboot_run_hours: float | None = None
    reboot_boot_timeout_sec: int | None = None
    reboot_count: int | None = None
    rpmb_run_minutes: float | None = None
    ota_upgrade_count: int | None = None
    ota_file_path: str | None = None
    ota_retry_limit: int | None = None
    ota_max_run_minutes: int | None = None
    ota_timeout_minutes: int | None = None
    ota_round_interval_minutes: int | None = None


class StartBody(BaseModel):
    device: str = Field(..., min_length=1)
    flow_no: str = "1"
    steps: list[str] = Field(default_factory=lambda: list(AUTO_STEPS))
    stop_on_fail: bool = False
    params: EmmcParams = Field(default_factory=EmmcParams)


class ReportHeaderBody(BaseModel):
    flow_no: str = Field(..., min_length=1)
    import_project: str = ""
    internal_model: str = ""
    emmc_brand: str = ""
    emmc_capacity_gb: str = ""
    read_speed_mbs: str = ""
    write_speed_mbs: str = ""
    emmc_model: str = ""
    sw_test_userdebug: str = ""
    emmc_spec: str = ""
    gota_version: str = ""
    tester: str = ""
    test_time: str = ""
    initial_result: str = ""
    remarks: str = ""
    ab_upgrade: bool = True


def _base() -> Path:
    return app_base_dir()


def _meta_from_body(body: ReportHeaderBody) -> ReportHeaderMeta:
    return ReportHeaderMeta(
        import_project=body.import_project,
        internal_model=body.internal_model,
        emmc_brand=body.emmc_brand,
        emmc_capacity_gb=body.emmc_capacity_gb,
        read_speed_mbs=body.read_speed_mbs,
        write_speed_mbs=body.write_speed_mbs,
        emmc_model=body.emmc_model,
        sw_test_userdebug=body.sw_test_userdebug,
        emmc_spec=body.emmc_spec,
        gota_version=body.gota_version,
        tester=body.tester,
        test_time=body.test_time
        or datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        initial_result=body.initial_result,
        remarks=body.remarks,
        ab_upgrade=body.ab_upgrade,
    )


@router.get("/steps")
def steps() -> dict:
    return {
        "steps": [
            {"id": s, "label": AUTO_LABELS.get(s, s)} for s in AUTO_STEPS
        ]
    }


@router.get("/dirs")
def dirs() -> dict:
    reports = emmc_reports_dir(base_dir=_base())
    reports.mkdir(parents=True, exist_ok=True)
    logs = emmc_logs_dir()
    logs.mkdir(parents=True, exist_ok=True)
    return {
        "reports_dir": str(reports.resolve()),
        "logs_dir": str(logs.resolve()),
    }


@router.get("/report")
def report_info(flow_no: str = Query(..., min_length=1)) -> dict:
    flow = flow_no.strip()
    if not flow:
        raise HTTPException(status_code=400, detail="请填写流程号")
    path = report_path_for_flow(flow, base_dir=_base())
    exists = path.is_file()
    header: dict = {}
    if exists:
        try:
            header = asdict(read_report_header(path))
        except Exception:
            header = {}
    return {
        "flow_no": flow,
        "path": str(path.resolve()),
        "exists": exists,
        "reports_dir": str(emmc_reports_dir(base_dir=_base()).resolve()),
        "header": header,
        "feishu_report_url": get_feishu_report_for_flow(flow),
    }


@router.post("/report/header")
def save_report_header(body: ReportHeaderBody) -> dict:
    flow = body.flow_no.strip()
    if not flow:
        raise HTTPException(status_code=400, detail="请填写流程号")
    if not (body.import_project or "").strip():
        raise HTTPException(status_code=400, detail="请填写「导入项目」")
    meta = _meta_from_body(body)
    path = report_path_for_flow(flow, base_dir=_base())
    target_path = report_path_for_project(flow, meta.import_project or flow, base_dir=_base())
    existing_path = path if path.is_file() else (target_path if target_path.is_file() else None)
    try:
        if existing_path is not None:
            saved = update_report_header(
                flow,
                meta,
                current_path=existing_path,
                base_dir=_base(),
            )
            created = False
        else:
            saved = create_report_with_header(flow, meta, base_dir=_base())
            created = True
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "ok": True,
        "created": created,
        "flow_no": flow,
        "path": str(saved.resolve()),
        "message": ("已创建报告" if created else "报告头部已更新")
        + f"：{saved}",
    }


def _notify_feishu_start(
    cfg: dict,
    flow: str,
    local_report: Path,
    url: str,
    *,
    sn: str = "",
    steps: list[str] | None = None,
) -> None:
    if not cfg.get("notify_enabled") or not cfg.get("user_open_id"):
        return
    try:
        meta = read_report_header(local_report) if local_report.is_file() else ReportHeaderMeta()
        step_names = "、".join(AUTO_LABELS.get(s, s) for s in (steps or []))
        send_feishu_report_notification(
            app_id=cfg["app_id"],
            app_secret=cfg["app_secret"],
            open_id=cfg["user_open_id"],
            project=meta.import_project,
            flow_no=flow,
            report_url=url,
            title="eMMC 测试已开始",
            sn=sn,
            steps_text=step_names,
            is_start=True,
        )
    except Exception:
        pass


def _ensure_feishu_report_for_flow(
    flow: str,
    local_report: Path,
    *,
    sn: str = "",
    steps: list[str] | None = None,
) -> tuple[str, str]:
    """开始测试前确保当前流程已从飞书模板复制生成独立在线报告，并异步同步表头与通知。"""
    with flow_lock(flow):
        cfg = load_feishu_config()
        if not cfg["app_id"] or not cfg["app_secret"]:
            return get_feishu_report_for_flow(flow), ""

        existing = get_feishu_report_for_flow(flow)
        if existing:
            if is_feishu_file_alive(
                app_id=cfg["app_id"], app_secret=cfg["app_secret"], url_or_token=existing
            ):
                threading.Thread(
                    target=_notify_feishu_start,
                    args=(cfg, flow, local_report, existing),
                    kwargs={"sn": sn, "steps": steps},
                    name=f"feishu-start-{flow}",
                    daemon=True,
                ).start()
                return existing, ""
            # 旧在线报告已被删除，清除绑定并重新从模板复制
            set_feishu_report_for_flow(flow, "")

        if not cfg.get("user_open_id") or not cfg["template_url"]:
            return "", ""
        try:
            found = find_feishu_spreadsheet_in_folder(
                app_id=cfg["app_id"],
                app_secret=cfg["app_secret"],
                template_url=cfg["template_url"],
                name=local_report.stem,
                flow_no=flow,
            )
            if found and found.get("url"):
                url = str(found["url"]).strip()
            else:
                res = copy_feishu_spreadsheet(
                    app_id=cfg["app_id"],
                    app_secret=cfg["app_secret"],
                    url_or_token=cfg["template_url"],
                    name=local_report.stem,
                )
                url = str(res.get("url") or "").strip()
            if url:
                set_feishu_report_for_flow(flow, url)

                def _bg_sync_and_notify() -> None:
                    try:
                        if local_report.is_file():
                            sync_report_xlsx_to_feishu(
                                app_id=cfg["app_id"],
                                app_secret=cfg["app_secret"],
                                report_path=local_report,
                                url_or_token=url,
                            )
                    except Exception:
                        pass
                    _notify_feishu_start(cfg, flow, local_report, url, sn=sn, steps=steps)

                threading.Thread(
                    target=_bg_sync_and_notify,
                    name=f"feishu-sync-start-{flow}",
                    daemon=True,
                ).start()
            return url, ""
        except Exception as exc:
            return "", str(exc)


@router.post("/jobs")
def start_job(body: StartBody) -> dict:
    sn = body.device.strip()
    if not sn or sn == "未选设备":
        raise HTTPException(status_code=400, detail="请先选择设备 SN")
    selected = [s for s in AUTO_STEPS if s in body.steps]
    if not selected:
        raise HTTPException(status_code=400, detail="请至少选择一个测试项")
    flow = (body.flow_no or "1").strip() or "1"
    runnable = order_steps(selected, flow)
    if not runnable:
        raise HTTPException(
            status_code=400,
            detail=(
                "当前流程非 A/B 升级，OTA 不会执行。"
                "请在「填写报告头部」勾选 A/B 升级，或再勾选其他测试项。"
            ),
        )
    if "ota" in runnable:
        ota_path = (body.params.ota_file_path or "").strip()
        if not ota_path:
            raise HTTPException(status_code=400, detail="OTA 路径不能为空，请选择升级包")
        ota_file = Path(ota_path)
        if not ota_file.is_file():
            raise HTTPException(status_code=400, detail=f"OTA 文件不存在: {ota_path}")

    try:
        report = ensure_flow_report(flow, base_dir=_base())
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"准备测试报告失败: {exc}",
        ) from exc

    feishu_url, feishu_warn = _ensure_feishu_report_for_flow(
        flow, report, sn=sn, steps=selected
    )

    p = body.params
    params = DeviceStepParams(
        loop_num=p.loop_num,
        stress_max_run_minutes=p.stress_max_run_minutes,
        iozone_file_size_mb=p.iozone_file_size_mb,
        samsung_emmc=p.samsung_emmc,
        iozone_write_min_mbs=p.iozone_write_min_mbs,
        iozone_read_min_mbs=p.iozone_read_min_mbs,
        reboot_run_hours=p.reboot_run_hours,
        reboot_boot_timeout_sec=p.reboot_boot_timeout_sec,
        reboot_count=p.reboot_count,
        rpmb_run_minutes=p.rpmb_run_minutes,
        ota_upgrade_count=p.ota_upgrade_count,
        ota_file_path=p.ota_file_path,
        ota_retry_limit=p.ota_retry_limit,
        ota_max_run_minutes=p.ota_max_run_minutes,
        ota_timeout_minutes=p.ota_timeout_minutes,
        ota_round_interval_minutes=p.ota_round_interval_minutes,
    )

    job_id = uuid.uuid4().hex[:12]
    stop = threading.Event()
    job = _Job(
        id=job_id,
        sn=sn,
        flow_no=flow,
        steps=selected,
        stop=stop,
        running=True,
        started_at=datetime.now().isoformat(timespec="seconds"),
        report_path=str(report.resolve()),
        feishu_report_url=feishu_url,
    )
    if feishu_url:
        job.logs.append(f"INFO 飞书在线报告已就绪: {feishu_url}")
        job.log_seq += 1
    elif feishu_warn:
        job.logs.append(f"WARNING 复制飞书模板失败（将继续本地测试）: {feishu_warn}")
        job.log_seq += 1

    def _log(line: str) -> None:
        text = line if len(line) <= 2000 else f"{line[:2000]}... [truncated]"
        with _LOCK:
            job.logs.append(text)
            job.log_seq += 1

    def _on_step(step_id: str, status: str) -> None:
        with _LOCK:
            job.current_step = step_id if status == "running" else ""
            job.step_results[step_id] = status
            if status == "running":
                job.step_progress[step_id] = {
                    "current": 0,
                    "total": 0,
                    "text": "进行中",
                }
                job.progress_current = 0
                job.progress_total = 0
                job.progress_text = "进行中"
            else:
                prev = job.step_progress.get(step_id) or {}
                tot = int(prev.get("total") or 0)
                cur = int(prev.get("current") or 0)
                prev_text = str(prev.get("text") or "").strip()
                if prev_text in ("进行中", "执行中"):
                    prev_text = ""
                final_cur = tot
                text = prev_text
                # 完成时无论 Pass/Fail 均拉满进度，并保留「次/分钟/小时」单位
                m = re.match(
                    r"^[\d.]+\s*/\s*([\d.]+)\s*(次|分钟|小时)\s*$",
                    prev_text,
                )
                if m:
                    text = f"{m.group(1)}/{m.group(1)} {m.group(2)}"
                elif not text and tot > 0:
                    text = f"{final_cur}/{tot} 次" if tot == 1 else f"{final_cur}/{tot}"
                elif status == "Pass" and not text:
                    text = "完成"
                elif status != "Pass" and not text:
                    text = "失败"
                if tot > 0:
                    job.step_progress[step_id] = {
                        "current": final_cur,
                        "total": tot,
                        "text": text,
                    }
                else:
                    job.step_progress[step_id] = {
                        "current": 1,
                        "total": 1,
                        "text": text or ("完成" if status == "Pass" else "失败"),
                    }
                job.progress_current = 0
                job.progress_total = 0
                job.progress_text = ""

    def _on_progress(step_id: str, current: int, total: int, text: str) -> None:
        with _LOCK:
            sid = (step_id or job.current_step or "").strip()
            if not sid:
                return
            cur = int(current)
            tot = int(total)
            label = str(text or "")
            job.step_progress[sid] = {
                "current": cur,
                "total": tot,
                "text": label,
            }
            # 兼容旧字段：当前正在跑的那一项
            if sid == job.current_step or job.step_results.get(sid) == "running":
                job.progress_current = cur
                job.progress_total = tot
                job.progress_text = label

    def _run() -> None:
        try:
            import importlib
            import sys
            import tools.emmc_test.headless_steps as _hs_mod

            if not getattr(sys, "frozen", False):
                try:
                    _hs_mod = importlib.reload(_hs_mod)
                except Exception:
                    pass
            _log(f"INFO 设备 SN: {sn}，流程号: {flow}")
            _log(f"INFO 测试报告: {report.resolve()}")
            env = _hs_mod.StepEnv(
                sn=sn,
                flow_no=job.flow_no,
                log=_log,
                stop=stop,
                report_path=report,
                base_dir=_base(),
                params=params,
                progress=_on_progress,
            )
            ok = _hs_mod.run_pipeline(
                env,
                selected,
                stop_on_fail=body.stop_on_fail,
                on_step=_on_step,
            )
            with _LOCK:
                job.ok = ok
                job.current_step = ""
                job.progress_current = 0
                job.progress_total = 0
                job.progress_text = ""
                # 报告被占用时可能另存，同步回任务状态供「打开报告」
                job.report_path = str(env.report_path.resolve())
            if stop.is_set():
                _log("INFO 任务已停止")
            else:
                _log("INFO 任务完成: " + ("Pass" if ok else "Fail"))
            _log(f"INFO 测试报告: {env.report_path.resolve()}")
        except Exception as exc:
            with _LOCK:
                job.error = str(exc)
                job.ok = False
                job.current_step = ""
                job.progress_current = 0
                job.progress_total = 0
                job.progress_text = ""
            _log(f"ERROR {exc}")
        finally:
            with _LOCK:
                job.running = False
                job.finished_at = datetime.now().isoformat(timespec="seconds")

    with _LOCK:
        evict_finished_jobs(_JOBS, is_running=lambda j: j.running, max_finished=50)
        _JOBS[job_id] = job
    threading.Thread(target=_run, name=f"emmc-{job_id}", daemon=True).start()
    return {
        "job_id": job_id,
        "device": sn,
        "steps": selected,
        "report_path": str(report.resolve()),
        "feishu_report_url": feishu_url,
        "feishu_report_warn": feishu_warn,
    }


@router.get("/jobs/{job_id}")
def job_status(
    job_id: str,
    tail: int = 200,
    since: int | None = Query(default=None, ge=0),
) -> dict:
    with _LOCK:
        job = _JOBS.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="任务不存在")
        cursor = job.log_seq
        if since is not None:
            if since >= cursor:
                lines = []
            else:
                all_lines = list(job.logs)
                base_seq = max(0, cursor - len(all_lines))
                start_idx = max(0, since - base_seq)
                lines = all_lines[start_idx:]
        else:
            all_lines = list(job.logs)
            lines = all_lines[-tail:] if tail > 0 else all_lines
        done = sum(
            1
            for sid in job.steps
            if job.step_results.get(sid) in ("Pass", "Fail")
        )
        total = len(job.steps)
        return {
            "job_id": job.id,
            "device": job.sn,
            "flow_no": job.flow_no,
            "steps": job.steps,
            "running": job.running,
            "ok": job.ok,
            "error": job.error,
            "started_at": job.started_at,
            "finished_at": job.finished_at,
            "report_path": job.report_path,
            "feishu_report_url": job.feishu_report_url,
            "current_step": job.current_step,
            "step_results": dict(job.step_results),
            "step_progress": {
                sid: {
                    "current": int(p.get("current") or 0),
                    "total": int(p.get("total") or 0),
                    "text": str(p.get("text") or ""),
                }
                for sid, p in dict(job.step_progress).items()
            },
            "progress_current": job.progress_current,
            "progress_total": job.progress_total,
            "progress_text": job.progress_text,
            "steps_done": done,
            "steps_total": total,
            "logs": lines,
            "log_cursor": cursor,
        }


@router.post("/jobs/{job_id}/stop")
def stop_job(job_id: str) -> dict:
    with _LOCK:
        job = _JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    job.stop.set()
    return {"job_id": job_id, "ok": True, "message": "已请求停止"}


class FeishuConfigBody(BaseModel):
    app_id: str | None = None
    app_secret: str | None = None
    template_url: str | None = None
    flow_no: str = ""
    report_url: str = ""
    report_name: str = ""
    notify_enabled: bool | None = None


def _feishu_status_payload(flow_no: str = "") -> dict:
    from tools.settings_store import get as _get_setting

    cfg = load_feishu_config()
    custom_app_id = str(_get_setting("feishu.app_id", "") or "").strip()
    custom_secret = str(_get_setting("feishu.app_secret", "") or "").strip()
    synced = synced_template_path(app_base_dir())
    exists = synced.is_file()
    mtime = ""
    if exists:
        mtime = datetime.fromtimestamp(synced.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")
    return {
        "app_id": custom_app_id,
        "has_secret": bool(custom_secret) or cfg["has_secret"],
        "has_custom_secret": bool(custom_secret),
        "template_url": cfg["template_url"],
        "notify_enabled": cfg["notify_enabled"],
        "user_open_id": cfg["user_open_id"],
        "user_name": cfg["user_name"],
        "user_logged_in": cfg["user_logged_in"],
        "flow_report_url": get_feishu_report_for_flow(flow_no) if flow_no.strip() else "",
        "synced_exists": exists,
        "synced_path": str(synced) if exists else "",
        "synced_mtime": mtime,
    }


@router.get("/feishu/config")
def get_feishu_config(flow_no: str = "") -> dict:
    return _feishu_status_payload(flow_no)


@router.put("/feishu/config")
def put_feishu_config(body: FeishuConfigBody) -> dict:
    save_feishu_config(
        app_id=body.app_id,
        app_secret=body.app_secret or None,
        template_url=body.template_url,
        notify_enabled=body.notify_enabled,
    )
    if body.flow_no.strip() and body.report_url.strip():
        set_feishu_report_for_flow(body.flow_no, body.report_url)
    return _feishu_status_payload(body.flow_no)


@router.get("/feishu/oauth/url")
def get_feishu_oauth_url(request: Request, app_id: str = "") -> dict:
    cfg = load_feishu_config()
    aid = app_id.strip() or cfg["app_id"]
    base = str(request.base_url).rstrip("/")
    redirect_uri = f"{base}/emmc/feishu/oauth/callback"
    try:
        url = build_feishu_oauth_url(aid, redirect_uri)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"url": url, "redirect_uri": redirect_uri}


@router.get("/feishu/oauth/callback", response_class=HTMLResponse)
def feishu_oauth_callback(code: str = "", state: str = "") -> HTMLResponse:
    cfg = load_feishu_config()
    try:
        info = exchange_feishu_oauth_code(
            app_id=cfg["app_id"],
            app_secret=cfg["app_secret"],
            code=code,
        )
        msg = f"飞书登录成功：{info['name'] or info['open_id']}，可以关闭此窗口返回工具。"
        payload = {"type": "feishu-oauth-ok", "name": info["name"], "open_id": info["open_id"]}
    except Exception as exc:
        msg = f"飞书登录失败：{exc}"
        payload = {"type": "feishu-oauth-err", "error": str(exc)}
    import json as _json

    html = (
        "<!doctype html><meta charset='utf-8'><title>飞书授权</title>"
        "<body style='font-family:sans-serif;padding:32px;text-align:center'>"
        f"<h3>{msg}</h3>"
        "<script>"
        f"try{{window.opener&&window.opener.postMessage({_json.dumps(payload)},'*');}}catch(e){{}}"
        "setTimeout(function(){window.close();},1200);"
        "</script></body>"
    )
    return HTMLResponse(html)


@router.post("/feishu/logout")
def feishu_logout(flow_no: str = "") -> dict:
    logout_feishu_user()
    return _feishu_status_payload(flow_no)


@router.post("/feishu/test")
def test_feishu(body: FeishuConfigBody) -> dict:
    cfg = load_feishu_config()
    app_id = (body.app_id or "").strip() or cfg["app_id"]
    app_secret = (body.app_secret or "").strip() or cfg["app_secret"]
    url = cfg["template_url"]
    try:
        return test_feishu_connection(
            app_id=app_id,
            app_secret=app_secret,
            url_or_token=url,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/feishu/copy-template")
def copy_feishu_template_report(body: FeishuConfigBody) -> dict:
    cfg = load_feishu_config()
    app_id = (body.app_id or "").strip() or cfg["app_id"]
    app_secret = (body.app_secret or "").strip() or cfg["app_secret"]
    url = cfg["template_url"]
    if (body.app_id or "").strip() or (body.app_secret or "").strip():
        save_feishu_config(
            app_id=app_id,
            app_secret=(body.app_secret or "").strip() or None,
        )
    flow = body.flow_no.strip() or "1"
    name = body.report_name.strip()
    if not name:
        local_path = report_path_for_flow(flow, base_dir=app_base_dir())
        name = local_path.stem if local_path.name else report_filename(flow, flow).removesuffix(".xlsx")
    try:
        res = copy_feishu_spreadsheet(
            app_id=app_id,
            app_secret=app_secret,
            url_or_token=url,
            name=name,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    set_feishu_report_for_flow(flow, res["url"])
    local_path = report_path_for_flow(flow, base_dir=app_base_dir())
    sync_info: dict = {}
    if local_path.is_file():
        sync_info = sync_report_xlsx_to_feishu(
            app_id=app_id,
            app_secret=app_secret,
            report_path=local_path,
            url_or_token=res["url"],
        )
    return {**_feishu_status_payload(flow), **res, **sync_info}


@router.post("/feishu/sync-report")
def sync_report_to_feishu(body: FeishuConfigBody) -> dict:
    cfg = load_feishu_config()
    app_id = (body.app_id or "").strip() or cfg["app_id"]
    app_secret = (body.app_secret or "").strip() or cfg["app_secret"]
    flow = body.flow_no.strip() or "1"
    target_url = body.report_url.strip() or get_feishu_report_for_flow(flow)
    if not target_url:
        raise HTTPException(status_code=400, detail="请先复制生成在线报告或填入目标在线表格链接")
    set_feishu_report_for_flow(flow, target_url)
    local_path = ensure_flow_report(flow, base_dir=app_base_dir())
    try:
        res = sync_report_xlsx_to_feishu(
            app_id=app_id,
            app_secret=app_secret,
            report_path=local_path,
            url_or_token=target_url,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    notified = ""
    notify_err = ""
    notify_on = cfg["notify_enabled"] if body.notify_enabled is None else body.notify_enabled
    if notify_on and cfg["user_open_id"]:
        meta = read_report_header(local_path)
        try:
            send_feishu_report_notification(
                app_id=app_id,
                app_secret=app_secret,
                open_id=cfg["user_open_id"],
                project=meta.import_project or flow,
                flow_no=flow,
                report_url=target_url,
                initial_result=meta.initial_result,
            )
            notified = cfg["user_name"] or cfg["user_open_id"]
        except Exception as exc:
            notify_err = str(exc)
    return {
        **_feishu_status_payload(flow),
        **res,
        "notified": notified,
        "notify_error": notify_err,
    }


@router.post("/feishu/test-notify")
def test_feishu_notify(body: FeishuConfigBody) -> dict:
    cfg = load_feishu_config()
    app_id = (body.app_id or "").strip() or cfg["app_id"]
    app_secret = (body.app_secret or "").strip() or cfg["app_secret"]
    flow = body.flow_no.strip() or "1"
    report_url = body.report_url.strip() or get_feishu_report_for_flow(flow)
    try:
        res = send_feishu_report_notification(
            app_id=app_id,
            app_secret=app_secret,
            open_id=cfg["user_open_id"],
            project=flow,
            flow_no=flow,
            report_url=report_url,
            summary="这是一条来自 eMMC 测试工具的通知测试消息",
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "tester": cfg["user_name"] or cfg["user_open_id"], **res}


@router.post("/feishu/sync-template")
def sync_feishu_template(body: FeishuConfigBody) -> dict:
    cfg = load_feishu_config()
    app_id = (body.app_id or "").strip() or cfg["app_id"]
    app_secret = (body.app_secret or "").strip() or cfg["app_secret"]
    url = cfg["template_url"]
    if (body.app_id or "").strip() or (body.app_secret or "").strip():
        save_feishu_config(
            app_id=app_id,
            app_secret=(body.app_secret or "").strip() or None,
        )
    try:
        res = export_feishu_spreadsheet_xlsx(
            app_id=app_id,
            app_secret=app_secret,
            url_or_token=url,
            dest_path=synced_template_path(app_base_dir()),
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {**_feishu_status_payload(), **res}


@router.delete("/feishu/synced-template")
def delete_feishu_synced_template() -> dict:
    synced = synced_template_path(app_base_dir())
    synced.unlink(missing_ok=True)
    return {"ok": True, **_feishu_status_payload()}


@router.get("/feishu/folder-url")
def feishu_reports_folder_url() -> dict:
    cfg = load_feishu_config()
    if not cfg["app_id"] or not cfg["app_secret"] or not cfg["template_url"]:
        raise HTTPException(status_code=400, detail="飞书模板或应用凭证未配置")
    try:
        url = get_feishu_reports_folder_url(
            app_id=cfg["app_id"],
            app_secret=cfg["app_secret"],
            template_url=cfg["template_url"],
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"url": url}


def _copy_and_sync_local_path_to_feishu(
    cfg: dict,
    local_path: Path,
    flow: str,
) -> dict:
    existing = get_feishu_report_for_flow(flow)
    if existing and is_feishu_file_alive(
        app_id=cfg["app_id"], app_secret=cfg["app_secret"], url_or_token=existing
    ):
        res = {"url": existing, "spreadsheet_token": "", "name": local_path.stem}
    else:
        found = find_feishu_spreadsheet_in_folder(
            app_id=cfg["app_id"],
            app_secret=cfg["app_secret"],
            template_url=cfg["template_url"],
            name=local_path.stem,
            flow_no=flow,
        )
        if found and found.get("url"):
            res = found
        else:
            res = copy_feishu_spreadsheet(
                app_id=cfg["app_id"],
                app_secret=cfg["app_secret"],
                url_or_token=cfg["template_url"],
                name=local_path.stem,
            )
    url = str(res.get("url") or "").strip()
    if url:
        set_feishu_report_for_flow(flow, url)
    sync_res = sync_report_xlsx_to_feishu(
        app_id=cfg["app_id"],
        app_secret=cfg["app_secret"],
        report_path=local_path,
        url_or_token=url,
    )
    meta = read_report_header(local_path)
    notified = ""
    notify_err = ""
    try:
        send_feishu_report_notification(
            app_id=cfg["app_id"],
            app_secret=cfg["app_secret"],
            open_id=cfg["user_open_id"],
            project=meta.import_project or flow,
            flow_no=flow,
            report_url=url,
            initial_result=meta.initial_result,
        )
        notified = cfg["user_name"] or cfg["user_open_id"]
    except Exception as exc:
        notify_err = str(exc)
    return {
        **_feishu_status_payload(flow),
        **res,
        **sync_res,
        "notified": notified,
        "notify_error": notify_err,
    }


@router.post("/feishu/copy-flow-local-report")
def copy_flow_local_report_to_feishu(body: FeishuConfigBody) -> dict:
    cfg = load_feishu_config()
    if not cfg.get("user_open_id"):
        raise HTTPException(status_code=400, detail="请先扫码登录飞书")
    if not cfg["app_id"] or not cfg["app_secret"] or not cfg["template_url"]:
        raise HTTPException(status_code=400, detail="飞书模板或应用凭证未配置")
    flow = body.flow_no.strip()
    if not flow:
        raise HTTPException(status_code=400, detail="请先填写流程号")
    local_path = report_path_for_flow(flow, base_dir=_base())
    if not local_path.is_file():
        raise HTTPException(status_code=404, detail=f"流程 {flow} 尚无本地报告")
    try:
        return _copy_and_sync_local_path_to_feishu(cfg, local_path, flow)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/feishu/copy-local-report")
async def copy_local_report_to_feishu(
    file: UploadFile = File(...),
    flow_no: str = Query(""),
) -> dict:
    cfg = load_feishu_config()
    if not cfg.get("user_open_id"):
        raise HTTPException(status_code=400, detail="请先扫码登录飞书")
    if not cfg["app_id"] or not cfg["app_secret"] or not cfg["template_url"]:
        raise HTTPException(status_code=400, detail="飞书模板或应用凭证未配置")

    filename = Path(file.filename or "report.xlsx").name
    if not filename.lower().endswith(".xlsx"):
        raise HTTPException(status_code=400, detail="仅支持上传 .xlsx 格式本地报告")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="上传的本地报告文件为空")

    with tempfile.TemporaryDirectory() as tmp:
        local_path = Path(tmp) / filename
        local_path.write_bytes(data)
        meta = read_report_header(local_path)
        flow = flow_no.strip()
        if not flow:
            m = re.search(r"导入测试报告模版v\d+\.\d+[_\s]+(.+)$", local_path.stem)
            if m:
                flow = m.group(1).strip()
        flow = flow or meta.import_project or local_path.stem
        try:
            return _copy_and_sync_local_path_to_feishu(cfg, local_path, flow)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc


class TideOaTokenBody(BaseModel):
    token: str = Field(..., min_length=1)
    ws_id: str = "2"


@router.get("/tide-oa/status")
def get_tide_oa_status() -> dict:
    return load_tide_oa_status()


@router.post("/tide-oa/token")
def save_tide_oa_token(body: TideOaTokenBody) -> dict:
    try:
        return validate_and_save_tide_token(body.token, body.ws_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/tide-oa/logout")
def post_tide_oa_logout() -> dict:
    return logout_tide_oa()


@router.get("/tide-oa/flow/{flow_no}")
def get_tide_oa_flow(flow_no: str) -> dict:
    try:
        return fetch_emmc_flow_header(flow_no)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
