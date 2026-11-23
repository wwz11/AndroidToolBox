#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations

from fastapi import APIRouter

from tools.bundled_paths import data_dir, electron_app_root, install_dir
from tools.version import BUILD_TAG, __version__

router = APIRouter(tags=["health"])

API_REV = 93
FEATURES = (
    "adb.devices",
    "adb.device.shell_ws",
    "adb.device.shell_raw",
    "adb.device.logcat_ws",
    "adb.device.logcat_session",
    "adb.device.ls",
    "adb.device.fs_ops",
    "adb.device.apk_analyze",
    "adb.device.dumpsys",
    "adb.device.getprop",
    "adb.device.info",
    "adb.device.shell_presets",
    "adb.device.package_ops",
    "adb.device.install_flags",
    "adb.device.monkey",
    "adb.device.key_capture",
    "adb.device.key_ids",
    "remote.preview",
    "remote.scrcpy",
    "remote.scrcpy_embed",
    "emmc.jobs",
    "emmc.params",
    "emmc.report",
    "emmc.step_results",
    "emmc.progress",
    "serial.ws",
    "unifykey",
    "local",
    "userdata.install_dir",
)


def _health_body() -> dict:
    app_root = electron_app_root()
    return {
        "ok": True,
        "service": "toolbox-api",
        "api_rev": API_REV,
        "features": list(FEATURES),
        "data_dir": str(data_dir()),
        "install_dir": str(app_root or install_dir()),
    }


@router.api_route("/health", methods=["GET", "HEAD"])
def health() -> dict:
    return _health_body()


@router.get("/version")
def version() -> dict:
    body = _health_body()
    body.update(
        {
            "version": __version__,
            "build_tag": BUILD_TAG or "",
        }
    )
    return body
