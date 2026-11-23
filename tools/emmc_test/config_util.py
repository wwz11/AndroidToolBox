#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""eMMC 配置路径与 ini 解析（无 GUI/tkinter 依赖，供 headless API 与 Tk 共用）。"""

from __future__ import annotations

import configparser
import shutil
from dataclasses import dataclass
from pathlib import Path

from tools.bundled_paths import app_base_dir, resolve_bundle_path, vendor_path


def config_dir() -> Path:
    path = app_base_dir() / "config"
    path.mkdir(parents=True, exist_ok=True)
    return path


def runtime_config_path(filename: str) -> Path:
    target = config_dir() / filename
    legacy = app_base_dir() / filename
    if not target.is_file() and legacy.is_file():
        try:
            shutil.copy2(legacy, target)
        except OSError:
            return legacy
    if not target.is_file():
        for rel in (("config_defaults", filename), ("config", filename)):
            bundled = resolve_bundle_path(*rel)
            if bundled is not None and bundled.is_file():
                try:
                    shutil.copy2(bundled, target)
                except OSError:
                    pass
                break
    return target


def path_to_config_str(path: Path) -> str:
    try:
        resolved = path.resolve()
    except OSError:
        resolved = path
    base = app_base_dir().resolve()
    try:
        return resolved.relative_to(base).as_posix()
    except ValueError:
        return str(resolved)


def path_from_config_str(value: str, default: Path) -> Path:
    text = value.strip()
    if not text:
        return default.resolve()
    raw = Path(text)
    if not raw.is_absolute():
        found = resolve_bundle_path(*raw.parts)
        if found is not None:
            return found.resolve()
        return (app_base_dir() / raw).resolve()
    try:
        resolved = raw.resolve()
    except OSError:
        resolved = raw
    if resolved.is_file() or resolved.is_dir():
        return resolved
    fallbacks = (
        default.resolve(),
        vendor_path("rpmb"),
        vendor_path("iozone", "iozone"),
        app_base_dir() / raw.name,
        app_base_dir() / "rpmb",
        app_base_dir() / "vendor" / "rpmb",
        app_base_dir() / "vendor" / "iozone" / "iozone",
        app_base_dir() / "iozone",
    )
    for candidate in fallbacks:
        if candidate.is_file() or candidate.is_dir():
            return candidate.resolve()
    return default.resolve()


def default_iozone_bin() -> Path:
    return vendor_path("iozone", "iozone")


def ensure_iozone_vendor() -> None:
    target_dir = vendor_path("iozone")
    target = target_dir / "iozone"
    if target.is_file():
        return
    target_dir.mkdir(parents=True, exist_ok=True)
    base = app_base_dir()
    for legacy in (base / "iozone", base / "vendor" / "iozone"):
        if legacy.is_file():
            try:
                shutil.copy2(legacy, target)
            except OSError:
                pass
            return


@dataclass
class StressConfig:
    sn: str
    loop_num: int
    make_file: int
    data_free_f: int
    data_free_size: int
    source_bin_make: str


def read_stress_config(path: Path) -> StressConfig:
    parser = configparser.ConfigParser()
    parser.read(path, encoding="utf-8")
    if "SETTING" not in parser:
        raise ValueError("配置文件缺少 [SETTING] 段")
    sec = parser["SETTING"]
    return StressConfig(
        sn=sec.get("sn", "").strip(),
        loop_num=int(sec.get("loop_num", "1000")),
        make_file=int(sec.get("make_file", "25600")),
        data_free_f=int(sec.get("data_free_f", "10")),
        data_free_size=int(sec.get("data_free_size", "200000")),
        source_bin_make=sec.get("source_bin_make", "/dev/block/by-name/super").strip(),
    )


def write_stress_config(path: Path, cfg: StressConfig) -> None:
    parser = configparser.ConfigParser()
    parser["SETTING"] = {
        "sn": cfg.sn,
        "loop_num": str(cfg.loop_num),
        "make_file": str(cfg.make_file),
        "data_free_f": str(cfg.data_free_f),
        "data_free_size": str(cfg.data_free_size),
        "source_bin_make": cfg.source_bin_make,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        parser.write(f)


def default_stress_config() -> StressConfig:
    return StressConfig(
        sn="",
        loop_num=1000,
        make_file=25600,
        data_free_f=10,
        data_free_size=200000,
        source_bin_make="/dev/block/by-name/super",
    )


# 兼容旧私有名（gui / headless 过渡）
_Config = StressConfig
_runtime_config_path = runtime_config_path
_path_from_config_str = path_from_config_str
_path_to_config_str = path_to_config_str
_default_iozone_bin = default_iozone_bin
_ensure_iozone_vendor = ensure_iozone_vendor
_read_config = read_stress_config
_write_config = write_stress_config
_default_config = default_stress_config
_config_dir = config_dir
_app_base_dir = app_base_dir
