#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ADB 应用包管理与 APK 解析对比接口。"""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field

from tools.adb_tools.apk_analyze import (
    analyze_apk,
    compare_with_device_data,
    format_compare_report,
    query_installed_package,
)
from tools.adb_tools.core import (
    adb_clear_package,
    adb_export_package_apk,
    adb_force_stop_package,
    adb_foreground_app,
    adb_grant_all_package_permissions,
    adb_install_apk,
    adb_launch_package,
    adb_list_packages,
    adb_restart_package,
    adb_set_package_enabled,
    adb_set_package_permission,
    adb_uninstall_package,
)
from tools.adb_tools.heavy import adb_heavy_op
from tools.api.deps import require_sn as _require_sn

router = APIRouter()


async def _write_upload_to_path(upload: UploadFile, dest: Path) -> int:
    """分块流式写入 UploadFile 到临时文件，避免大文件整包载入内存。"""
    total = 0
    with dest.open("wb") as fp:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            fp.write(chunk)
            total += len(chunk)
    return total


class UninstallBody(BaseModel):
    package: str = Field(..., min_length=1)
    keep_data: bool = False


class PackageBody(BaseModel):
    package: str = Field(..., min_length=1)


class PackageStateBody(BaseModel):
    package: str = Field(..., min_length=1)
    enabled: bool


class PackagePermissionBody(BaseModel):
    package: str = Field(..., min_length=1)
    permission: str = Field(..., min_length=1)
    granted: bool


class PackagePermissionsBatchBody(BaseModel):
    package: str = Field(..., min_length=1)
    permissions: list[str] = Field(default_factory=list)


class ExportApkBody(BaseModel):
    package: str = Field(..., min_length=1)
    dest_dir: str = ""
    version_name: str = ""


@router.get("/packages")
def packages(
    device: str = Query(...),
    q: str = "",
    scope: str = Query("all", description="all | third | system"),
) -> dict:
    sn = _require_sn(device)
    kind = (scope or "all").strip().lower()
    if kind not in ("all", "third", "system", "3", "-3", "s", "-s"):
        raise HTTPException(status_code=400, detail="scope 应为 all / third / system")
    try:
        pkgs = adb_list_packages(sn, scope=kind)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    needle = (q or "").strip().lower()
    if needle:
        pkgs = [p for p in pkgs if needle in p.lower()]
    return {
        "device": sn,
        "packages": pkgs,
        "count": len(pkgs),
        "scope": "third" if kind in ("third", "3", "-3") else "system" if kind in ("system", "s", "-s") else "all",
    }


@router.get("/packages/info")
def package_info(
    device: str = Query(...),
    package: str = Query(..., min_length=1),
) -> dict:
    """查询设备已安装应用的版本等信息。"""
    sn = _require_sn(device)
    pkg = package.strip()
    if not pkg:
        raise HTTPException(status_code=400, detail="包名不能为空")
    try:
        info = query_installed_package(sn, pkg)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    installed = str(info.get("installed", "")).lower() in ("true", "1", "yes")
    return {
        "device": sn,
        "package": pkg,
        "installed": installed,
        "enabled": bool(info.get("enabled", True)),
        "version_name": str(info.get("versionName") or ""),
        "version_code": str(info.get("versionCode") or ""),
        "min_sdk": str(info.get("minSdk") or ""),
        "target_sdk": str(info.get("targetSdk") or ""),
        "first_install_time": str(info.get("firstInstallTime") or ""),
        "last_update_time": str(info.get("lastUpdateTime") or ""),
        "path": str(info.get("path") or ""),
        "permissions": list(info.get("permissions") or []),
        "install_granted": list(info.get("install_granted") or []),
        "runtime_granted": list(info.get("runtime_granted") or []),
        "runtime_denied": list(info.get("runtime_denied") or []),
    }


@router.get("/foreground-app")
def foreground_app(device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    try:
        res = adb_foreground_app(sn)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "ok": bool(res.get("package")),
        "package": res.get("package", ""),
        "activity": res.get("activity", ""),
        "raw": res.get("raw", ""),
    }


@router.post("/uninstall")
def uninstall(body: UninstallBody, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    try:
        result = adb_uninstall_package(sn, body.package, keep_data=body.keep_data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "ok": result.ok,
        "returncode": result.returncode,
        "output": result.output,
        "package": body.package,
    }


@router.post("/clear-data")
def clear_data(body: PackageBody, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    try:
        result = adb_clear_package(sn, body.package)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "ok": result.ok,
        "returncode": result.returncode,
        "output": result.output,
        "package": body.package,
    }


@router.post("/force-stop")
def force_stop(body: PackageBody, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    try:
        result = adb_force_stop_package(sn, body.package)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "ok": result.ok,
        "returncode": result.returncode,
        "output": result.output,
        "package": body.package,
    }


@router.post("/launch")
def launch_package(body: PackageBody, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    try:
        result = adb_launch_package(sn, body.package)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "ok": result.ok,
        "returncode": result.returncode,
        "output": result.output,
        "package": body.package,
    }


@router.post("/restart")
def restart_package(body: PackageBody, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    try:
        result = adb_restart_package(sn, body.package)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "ok": result.ok,
        "returncode": result.returncode,
        "output": result.output,
        "package": body.package,
    }


@router.post("/package-state")
def set_package_state(body: PackageStateBody, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    try:
        result = adb_set_package_enabled(sn, body.package, body.enabled)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "ok": result.ok,
        "returncode": result.returncode,
        "output": result.output,
        "package": body.package,
        "enabled": body.enabled,
    }


@router.post("/package-permission")
def set_package_permission(body: PackagePermissionBody, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    try:
        result = adb_set_package_permission(sn, body.package, body.permission, body.granted)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "ok": result.ok,
        "returncode": result.returncode,
        "output": result.output,
        "package": body.package,
        "permission": body.permission,
        "granted": body.granted,
    }


@router.post("/package-permissions/grant-all")
def grant_all_package_permissions(body: PackagePermissionsBatchBody, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    try:
        res = adb_grant_all_package_permissions(sn, body.package, body.permissions)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"device": sn, "package": body.package, **res}


@router.post("/export-apk")
async def export_apk(body: ExportApkBody, device: str = Query(...)) -> dict:
    sn = _require_sn(device)
    try:
        res = await asyncio.to_thread(
            adb_export_package_apk,
            sn,
            body.package,
            dest_dir=body.dest_dir,
            version_name=body.version_name,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"device": sn, **res}


@router.post("/install")
async def install(
    device: str = Query(...),
    reinstall: bool = Form(True),
    downgrade: bool = Form(False),
    grant_permissions: bool = Form(False),
    file: UploadFile = File(...),
) -> dict:
    sn = _require_sn(device)
    name = (file.filename or "app.apk").strip() or "app.apk"
    if not name.lower().endswith(".apk"):
        raise HTTPException(status_code=400, detail="请上传 .apk 文件")
    try:
        with tempfile.TemporaryDirectory(prefix="toolbox_apk_") as tmp:
            apk = Path(tmp) / Path(name).name
            written = await _write_upload_to_path(file, apk)
            if written <= 0:
                raise HTTPException(status_code=400, detail="APK 文件为空")
            with adb_heavy_op("install"):
                result = await asyncio.to_thread(
                    adb_install_apk,
                    sn,
                    apk,
                    reinstall=reinstall,
                    downgrade=downgrade,
                    grant_permissions=grant_permissions,
                )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "device": sn,
        "ok": result.ok,
        "returncode": result.returncode,
        "output": result.output,
        "filename": name,
    }


@router.post("/apk/analyze")
async def apk_analyze(file: UploadFile = File(...)) -> dict:
    name = (file.filename or "app.apk").strip() or "app.apk"
    if not name.lower().endswith(".apk"):
        raise HTTPException(status_code=400, detail="请上传 .apk 文件")
    try:
        with tempfile.TemporaryDirectory(prefix="toolbox_apk_analyze_") as tmp:
            apk = Path(tmp) / Path(name).name
            await _write_upload_to_path(file, apk)
            info = await asyncio.to_thread(analyze_apk, apk)
            report = info.format_report()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "ok": True,
        "filename": name,
        "package": info.package,
        "version_name": info.version_name,
        "version_code": info.version_code,
        "min_sdk": info.min_sdk,
        "target_sdk": info.target_sdk,
        "md5": info.file_md5,
        "abis": info.abis,
        "permissions": info.permissions[:200],
        "report": report,
        "info": info.as_dict(),
    }


@router.post("/apk/compare")
async def apk_compare(
    device: str = Query(...),
    file: UploadFile = File(...),
) -> dict:
    sn = _require_sn(device)
    name = (file.filename or "app.apk").strip() or "app.apk"
    try:
        with tempfile.TemporaryDirectory(prefix="toolbox_apk_cmp_") as tmp:
            apk = Path(tmp) / Path(name).name
            await _write_upload_to_path(file, apk)
            info = await asyncio.to_thread(analyze_apk, apk)
            cmp_data = await asyncio.to_thread(compare_with_device_data, info, sn)
            cmp_text = format_compare_report(info, cmp_data)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    payload = info.as_dict()
    payload["filename"] = name
    return {
        "ok": True,
        "device": sn,
        "filename": name,
        "package": info.package,
        "version_name": info.version_name,
        "version_code": info.version_code,
        "compare": cmp_text,
        "compare_info": cmp_data,
        "report": info.format_report(),
        "info": payload,
    }
