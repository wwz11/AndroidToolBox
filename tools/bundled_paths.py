#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打包资源与可写数据目录。

- 只读资源（adb / iozone / 模版）：随安装包，覆盖升级即更新
- 可写数据（config / output / logs / 串口日志 / 报告）：
  安装目录下 userdata/（开发=仓库根）
  可用 TOOLBOX_DATA_DIR 覆盖；安装目录不可写时回退 %LOCALAPPDATA%
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from functools import lru_cache
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[1]
_APP_NAME = "SEIAndroidTVTestToolBox"
_LEGACY_DATA_DIR_NAME = "Toolbox"
_APP_EXE_NAMES = (_APP_NAME + ".exe", "Toolbox.exe")
_USERDATA_NAME = "userdata"

_VENDOR_ALIASES: dict[str, tuple[tuple[str, ...], ...]] = {
    "platform-tools": (("vendor", "platform-tools"), ("platform-tools",)),
    "rpmb": (("vendor", "rpmb"), ("rpmb",)),
    "iozone": (("vendor", "iozone"),),
    "emmc": (("vendor", "emmc"),),
    "ota": (("vendor", "ota"),),
}

_DATA_MARKER = ".toolbox_data"
_INSTALL_MARKER = "install_dir.txt"


def _is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def _has_app_exe(directory: Path) -> bool:
    return any((directory / name).is_file() for name in _APP_EXE_NAMES)


def _dir_writable(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / ".toolbox_write_test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return True
    except OSError:
        return False


@lru_cache(maxsize=1)
def install_dir() -> Path:
    """安装/侧车目录（打包=toolbox-api.exe 所在目录；开发=仓库根）。"""
    if _is_frozen():
        return Path(sys.executable).resolve().parent
    return _REPO_ROOT


@lru_cache(maxsize=1)
def electron_app_root() -> Path | None:
    """Electron 安装根（含主 exe）；开发返回 None。"""
    raw = (os.environ.get("TOOLBOX_INSTALL_DIR") or "").strip().strip('"')
    if raw:
        try:
            return Path(raw).expanduser().resolve()
        except OSError:
            return Path(raw).expanduser()
    if not _is_frozen():
        return None
    # …/resources/toolbox-api → 上两级为应用根
    cand = install_dir().parent.parent
    if _has_app_exe(cand):
        try:
            return cand.resolve()
        except OSError:
            return cand
    return None


@lru_cache(maxsize=1)
def local_appdata_data_dir() -> Path:
    """旧版 / 回退：%LOCALAPPDATA%\\SEIAndroidTVTestToolBox。"""
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        preferred = Path(base) / _APP_NAME
        legacy = Path(base) / _LEGACY_DATA_DIR_NAME
        try:
            if not preferred.exists() and legacy.exists():
                legacy.rename(preferred)
        except OSError:
            if legacy.exists() and not preferred.exists():
                return legacy
        return preferred
    xdg = os.environ.get("XDG_DATA_HOME")
    if xdg:
        return Path(xdg) / "sei-android-tv-test-toolbox"
    return Path.home() / ".local" / "share" / "sei-android-tv-test-toolbox"


@lru_cache(maxsize=1)
def default_data_dir() -> Path:
    """默认可写根：安装目录/userdata；不可写则 LocalAppData。"""
    root = electron_app_root()
    if root is not None:
        candidate = root / _USERDATA_NAME
        if _dir_writable(candidate):
            return candidate
    # 仅侧车运行时：写在 toolbox-api 旁
    if _is_frozen():
        side = install_dir() / _USERDATA_NAME
        if _dir_writable(side):
            return side
    return local_appdata_data_dir()


@lru_cache(maxsize=1)
def data_dir() -> Path:
    """可写数据根：TOOLBOX_DATA_DIR > 安装目录/userdata > 开发仓库根。"""
    explicit = (os.environ.get("TOOLBOX_DATA_DIR") or "").strip().strip('"')
    if explicit:
        path = Path(explicit).expanduser()
    elif _is_frozen():
        path = default_data_dir()
    else:
        path = _REPO_ROOT
    path.mkdir(parents=True, exist_ok=True)
    return path.resolve()


def logs_dir(*parts: str) -> Path:
    """统一日志根：userdata/logs[/…]"""
    path = data_dir().joinpath("logs", *parts)
    path.mkdir(parents=True, exist_ok=True)
    return path


def output_dir(*parts: str) -> Path:
    """统一输出根：userdata/output[/…]（报告、录像、拉取、GOTA 等）"""
    path = data_dir().joinpath("output", *parts)
    path.mkdir(parents=True, exist_ok=True)
    return path


@lru_cache(maxsize=1)
def bundle_roots() -> tuple[Path, ...]:
    """可读的打包资源根目录（按优先级）。"""
    if _is_frozen():
        exe_dir = install_dir()
        roots: list[Path] = [exe_dir, exe_dir / "_internal"]
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            roots.append(Path(meipass))
        return tuple(roots)
    return (_REPO_ROOT,)


def app_base_dir() -> Path:
    """可写数据根目录（配置、output、logs）。开发=项目根；打包=userdata。"""
    return data_dir()


def repo_root() -> Path:
    return _REPO_ROOT


def resolve_bundle_path(*rel_parts: str) -> Path | None:
    if not rel_parts:
        return None
    for root in bundle_roots():
        candidate = root.joinpath(*rel_parts)
        if candidate.exists():
            return candidate
    return None


def resolve_vendor(name: str, *rel_parts: str) -> Path | None:
    for prefix in _VENDOR_ALIASES.get(name, ((name,),)):
        found = resolve_bundle_path(*prefix, *rel_parts)
        if found is not None:
            return found
    # 用户数据目录中的自备资源（如 OTA 包）
    data_candidate = data_dir().joinpath("vendor", name, *rel_parts)
    if data_candidate.exists():
        return data_candidate
    return None


def vendor_path(name: str, *rel_parts: str) -> Path:
    found = resolve_vendor(name, *rel_parts)
    if found is not None:
        return found
    # 自备 OTA 包写入数据目录；其余缺省落在安装包/仓库 vendor
    if name == "ota":
        return data_dir().joinpath("vendor", name, *rel_parts)
    root = install_dir() if _is_frozen() else _REPO_ROOT
    return root.joinpath("vendor", name, *rel_parts)


def _copy_tree_merge(src: Path, dst: Path) -> None:
    if not src.is_dir():
        return
    dst.mkdir(parents=True, exist_ok=True)
    for root, _dirs, files in os.walk(src):
        rel = Path(root).relative_to(src)
        target_root = dst / rel
        target_root.mkdir(parents=True, exist_ok=True)
        for name in files:
            s = Path(root) / name
            d = target_root / name
            if d.exists():
                continue
            try:
                shutil.copy2(s, d)
            except OSError:
                pass


def _migrate_settings_json(legacy_root: Path, dest: Path) -> None:
    """旧版 settings.json 在数据根目录，新版在 userdata/config/。"""
    candidates = (
        legacy_root / "settings.json",
        legacy_root / "config" / "settings.json",
    )
    src = next((p for p in candidates if p.is_file()), None)
    if src is None:
        return
    try:
        if src.resolve() == dest.resolve():
            return
    except OSError:
        pass
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.is_file():
        try:
            shutil.copy2(src, dest)
        except OSError:
            pass
        return
    try:
        old = json.loads(src.read_text(encoding="utf-8"))
        cur = json.loads(dest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return
    if not isinstance(old, dict) or not isinstance(cur, dict):
        return
    changed = False
    for key, value in old.items():
        if key not in cur:
            cur[key] = value
            changed = True
    for list_key in ("adb_tools.shell_presets", "remote.login_accounts"):
        old_list = old.get(list_key)
        cur_list = cur.get(list_key)
        if isinstance(old_list, list) and old_list:
            if not isinstance(cur_list, list) or not cur_list:
                cur[list_key] = old_list
                changed = True
    if changed:
        try:
            dest.write_text(
                json.dumps(cur, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        except OSError:
            pass


def _migrate_from(legacy_root: Path) -> None:
    if not legacy_root.is_dir():
        return
    base = data_dir()
    try:
        if legacy_root.resolve() == base.resolve():
            return
    except OSError:
        pass
    for name in ("config", "output", "logs"):
        _copy_tree_merge(legacy_root / name, base / name)
    _copy_tree_merge(legacy_root / "vendor" / "ota", base / "vendor" / "ota")
    _migrate_settings_json(legacy_root, base / "config" / "settings.json")
    # 旧版把 ini 放在根目录
    for ini in legacy_root.glob("emmc_*.ini"):
        dest = base / "config" / ini.name
        if not dest.is_file():
            try:
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ini, dest)
            except OSError:
                pass


def _migrate_desktop_artifacts() -> None:
    """把原先散落在桌面的日志/输出迁入 userdata（不覆盖已有）。"""
    try:
        from tools.adb_tools.core import user_desktop_dir

        desktop = user_desktop_dir()
    except Exception:
        desktop = Path.home() / "Desktop"
    if not desktop.is_dir():
        return
    mapping = (
        (desktop / "adb_logs", logs_dir("adb")),
        (desktop / "adb_pulls", output_dir("adb_pulls")),
        (desktop / "gota_serial_out", output_dir("gota")),
    )
    for src, dst in mapping:
        try:
            if src.is_dir():
                _copy_tree_merge(src, dst)
        except OSError:
            pass
    # 桌面 serial_*.log
    serial_dst = logs_dir("serial")
    try:
        for f in desktop.glob("serial_*.log"):
            if not f.is_file():
                continue
            dest = serial_dst / f.name
            if dest.exists():
                continue
            try:
                shutil.copy2(f, dest)
            except OSError:
                pass
    except OSError:
        pass


def remember_install_dir(app_root: Path | None = None) -> Path | None:
    """记录 Electron 安装根目录，供一键升级脚本定位。"""
    raw = (os.environ.get("TOOLBOX_INSTALL_DIR") or "").strip().strip('"')
    root = Path(raw) if raw else app_root
    if root is None:
        root = electron_app_root()
    if root is None:
        return None
    try:
        root = root.resolve()
        marker = data_dir() / _INSTALL_MARKER
        marker.write_text(str(root) + "\n", encoding="utf-8")
        return root
    except OSError:
        return None


def ensure_app_vendor_tree() -> None:
    """初始化数据目录、迁移旧版旁路/桌面数据、确保子目录可用。"""
    base = data_dir()
    try:
        (base / _DATA_MARKER).write_text("toolbox\n", encoding="utf-8")
    except OSError:
        pass

    for sub in (
        "config",
        "output",
        "output/emmc",
        "output/emmc/reports",
        "output/emmc/screenshots",
        "output/mirror",
        "output/screenshots",
        "output/adb_pulls",
        "output/gota",
        "logs",
        "logs/serial",
        "logs/adb",
        "logs/emmc",
        "logs/api",
        "vendor/ota",
    ):
        try:
            (base / sub).mkdir(parents=True, exist_ok=True)
        except OSError:
            pass

    # LocalAppData 旧数据 → userdata
    try:
        legacy_appdata = local_appdata_data_dir()
        if legacy_appdata.is_dir():
            _migrate_from(legacy_appdata)
        if sys.platform == "win32":
            local = Path(
                os.environ.get("LOCALAPPDATA")
                or str(Path.home() / "AppData" / "Local")
            )
            toolbox_legacy = local / _LEGACY_DATA_DIR_NAME
            if toolbox_legacy.is_dir():
                _migrate_from(toolbox_legacy)
            keep = local / _APP_NAME / "_keep_userdata"
            if keep.is_dir():
                _migrate_from(keep)
    except OSError:
        pass

    # 从安装目录旁路数据迁移（旧版写在 toolbox-api 旁）
    if _is_frozen():
        _migrate_from(install_dir())
        electron_root = electron_app_root()
        if electron_root is not None:
            _migrate_from(electron_root)
            _migrate_from(electron_root / "resources" / "toolbox-api")

    _migrate_desktop_artifacts()
    remember_install_dir()

    # 包内 OTA 示例拷到数据目录（不覆盖已有）
    bundled_ota = resolve_bundle_path("vendor", "ota")
    if bundled_ota is not None and bundled_ota.is_dir():
        _copy_tree_merge(bundled_ota, base / "vendor" / "ota")
