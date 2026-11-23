#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ADB 应用包（APK 安装、卸载、列表、清理、停止、启动）操作。"""

from __future__ import annotations

import re
import time
from pathlib import Path

from tools.adb_runtime import adb_available, run_adb
from tools.adb_tools.common import AdbCommandResult, format_adb_raw_output


def _validate_pkg_token(value: str, label: str = "参数") -> str:
    s = (value or "").strip()
    if not s or not re.fullmatch(r"[A-Za-z0-9_.$:-]+", s):
        raise ValueError(f"{label}不合法: {value!r}")
    return s


def collect_apk_paths(items: list[str | Path], *, recursive: bool = True) -> list[Path]:
    """从 APK 文件或目录（含子目录）收集去重后的 .apk 路径。"""
    seen: set[Path] = set()
    out: list[Path] = []
    for raw in items:
        p = Path(raw)
        if p.is_file():
            if p.suffix.lower() == ".apk":
                key = p.resolve()
                if key not in seen:
                    seen.add(key)
                    out.append(key)
            continue
        if not p.is_dir():
            continue
        pattern = "**/*.apk" if recursive else "*.apk"
        for apk in sorted(p.glob(pattern)):
            if not apk.is_file():
                continue
            key = apk.resolve()
            if key not in seen:
                seen.add(key)
                out.append(key)
    return out


def _adb_install_succeeded(returncode: int, output: str) -> bool:
    """adb install 有时 returncode 非 0 但输出含 Success。"""
    text = output.strip()
    low = text.lower()
    if "failure" in low or "install_failed" in low:
        return False
    if "success" in low:
        return True
    return returncode == 0


def adb_install_apk(
    device: str | None,
    apk_path: Path,
    *,
    reinstall: bool = True,
    downgrade: bool = False,
    grant_permissions: bool = False,
) -> AdbCommandResult:
    if not adb_available():
        raise RuntimeError("未找到 adb")
    apk = Path(apk_path)
    if not apk.is_file():
        raise RuntimeError(f"APK 不存在: {apk}")
    args = ["install"]
    if reinstall:
        args.append("-r")
    if downgrade:
        args.append("-d")
    if grant_permissions:
        args.append("-g")
    args.append(str(apk))
    r = run_adb(args, device, timeout=300.0)
    output = format_adb_raw_output(r.stdout, r.stderr)
    ok = _adb_install_succeeded(r.returncode, output)
    return AdbCommandResult(
        label=f"install {apk.name}",
        returncode=0 if ok else (r.returncode or 1),
        output=output,
    )


def adb_install_apks(
    device: str | None,
    apk_paths: list[Path],
    *,
    reinstall: bool = True,
    downgrade: bool = False,
    grant_permissions: bool = False,
) -> AdbCommandResult:
    """依次安装多个 APK，汇总输出。"""
    if not apk_paths:
        raise ValueError("没有可安装的 APK")
    lines: list[str] = []
    failed = 0
    for apk in apk_paths:
        result = adb_install_apk(
            device,
            apk,
            reinstall=reinstall,
            downgrade=downgrade,
            grant_permissions=grant_permissions,
        )
        status = "OK" if result.ok else "FAIL"
        lines.append(f"[{status}] {apk.name}")
        if result.output:
            lines.append(result.output)
        if not result.ok:
            failed += 1
    total = len(apk_paths)
    ok_count = total - failed
    summary = f"完成 {ok_count}/{total}，失败 {failed}"
    body = "\n".join(lines)
    return AdbCommandResult(
        label=f"install {total} apk(s)",
        returncode=0 if failed == 0 else 1,
        output=f"{body}\n\n{summary}\n" if body else f"{summary}\n",
    )


def adb_uninstall_package(
    device: str | None,
    package_name: str,
    *,
    keep_data: bool = False,
) -> AdbCommandResult:
    """卸载应用包（可选保留数据：adb uninstall -k）。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    pkg = package_name.strip()
    if not pkg:
        raise ValueError("包名不能为空")
    args = ["uninstall"]
    if keep_data:
        args.append("-k")
    args.append(pkg)
    r = run_adb(args, device)
    return AdbCommandResult(
        label=f"uninstall {pkg}",
        returncode=r.returncode,
        output=format_adb_raw_output(r.stdout, r.stderr),
    )


def adb_list_packages(device: str | None, *, scope: str = "all") -> list[str]:
    """读取设备已安装包名列表（adb shell pm list packages）。

    scope: ``all`` | ``third`` (-3) | ``system`` (-s)
    """
    if not adb_available():
        raise RuntimeError("未找到 adb")
    args = ["shell", "pm", "list", "packages"]
    kind = (scope or "all").strip().lower()
    if kind in ("third", "3", "-3"):
        args.append("-3")
    elif kind in ("system", "s", "-s"):
        args.append("-s")
    r = None
    msg = ""
    for attempt in range(3):
        r = run_adb(args, device)
        msg = (r.stderr or r.stdout or "").strip()
        if r.returncode == 0 and "can't find service: package" not in msg.lower():
            break
        if "can't find service: package" in msg.lower() and attempt < 2:
            time.sleep(1.0)
            continue
        break
    assert r is not None
    if "can't find service: package" in msg.lower():
        raise RuntimeError(
            "设备 package 服务未就绪（可能正在开机、处于 Recovery 或系统服务重启中），请稍后再点刷新"
        )
    if r.returncode != 0:
        raise RuntimeError(msg or "获取包名失败")
    packages: list[str] = []
    seen: set[str] = set()
    for raw in (r.stdout or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("package:"):
            line = line[len("package:") :]
        pkg = line.strip()
        if not pkg or pkg in seen:
            continue
        seen.add(pkg)
        packages.append(pkg)
    packages.sort()
    return packages


def adb_clear_package(device: str | None, package_name: str) -> AdbCommandResult:
    """清空应用数据：pm clear。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    pkg = package_name.strip()
    if not pkg:
        raise ValueError("包名不能为空")
    r = run_adb(["shell", "pm", "clear", pkg], device)
    return AdbCommandResult(
        label=f"pm clear {pkg}",
        returncode=r.returncode,
        output=format_adb_raw_output(r.stdout, r.stderr),
    )


def adb_force_stop_package(device: str | None, package_name: str) -> AdbCommandResult:
    """强制停止应用：am force-stop。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    pkg = package_name.strip()
    if not pkg:
        raise ValueError("包名不能为空")
    r = run_adb(["shell", "am", "force-stop", pkg], device)
    return AdbCommandResult(
        label=f"am force-stop {pkg}",
        returncode=r.returncode,
        output=format_adb_raw_output(r.stdout, r.stderr) or f"force-stop {pkg}",
    )


def adb_launch_package(device: str | None, package_name: str) -> AdbCommandResult:
    """尝试启动应用（monkey LAUNCHER）。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    pkg = package_name.strip()
    if not pkg:
        raise ValueError("包名不能为空")
    r = run_adb(
        [
            "shell",
            "monkey",
            "-p",
            pkg,
            "-c",
            "android.intent.category.LAUNCHER",
            "1",
        ],
        device,
        timeout=30.0,
    )
    return AdbCommandResult(
        label=f"launch {pkg}",
        returncode=r.returncode,
        output=format_adb_raw_output(r.stdout, r.stderr),
    )


def adb_restart_package(device: str | None, package_name: str) -> AdbCommandResult:
    """强制停止并重新启动应用。"""
    pkg = _validate_pkg_token(package_name, "包名")
    stop_res = adb_force_stop_package(device, pkg)
    time.sleep(0.25)
    launch_res = adb_launch_package(device, pkg)
    combined = "\n".join(p for p in (stop_res.output.strip(), launch_res.output.strip()) if p)
    return AdbCommandResult(
        label=f"restart {pkg}",
        returncode=launch_res.returncode,
        output=combined or f"restart {pkg}",
    )


def _pm_state_ok(returncode: int, output: str) -> bool:
    low = (output or "").lower()
    if any(
        bad in low
        for bad in (
            "exception",
            "securityexception",
            "error:",
            "unknown option",
            "cannot disable",
            "failed",
        )
    ):
        return False
    if "new state:" in low:
        return True
    return returncode == 0


def adb_set_package_enabled(
    device: str | None,
    package_name: str,
    enabled: bool,
) -> AdbCommandResult:
    """启用或停用应用（自动兼容 disable-user --user 0 / disable-user / disable）。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    pkg = _validate_pkg_token(package_name, "包名")
    candidates = (
        [
            (["shell", "pm", "enable", pkg], f"pm enable {pkg}"),
            (["shell", "pm", "enable", "--user", "0", pkg], f"pm enable --user 0 {pkg}"),
        ]
        if enabled
        else [
            (["shell", "pm", "disable-user", "--user", "0", pkg], f"pm disable-user {pkg}"),
            (["shell", "pm", "disable-user", pkg], f"pm disable-user {pkg}"),
            (["shell", "pm", "disable", pkg], f"pm disable {pkg}"),
        ]
    )
    last_out = ""
    last_rc = 1
    last_label = candidates[0][1]
    for args, label in candidates:
        r = run_adb(args, device)
        out = format_adb_raw_output(r.stdout, r.stderr).strip()
        if _pm_state_ok(r.returncode, out):
            return AdbCommandResult(label=label, returncode=0, output=out or label)
        last_out = out
        last_rc = r.returncode or 1
        last_label = label

    hint = ""
    low = last_out.lower()
    if "securityexception" in low or "cannot disable" in low or "permission" in low:
        hint = "权限不足（可先在「文件」页点 Root 后重试，或该系统应用受保护）："
    msg = f"{hint}{last_out}".strip() or f"{last_label} 失败"
    return AdbCommandResult(label=last_label, returncode=last_rc, output=msg)


def adb_set_package_permission(
    device: str | None,
    package_name: str,
    permission: str,
    granted: bool,
) -> AdbCommandResult:
    """授予或撤销应用运行时权限（pm grant / pm revoke）。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    pkg = _validate_pkg_token(package_name, "包名")
    perm = _validate_pkg_token(permission, "权限名")
    op = "grant" if granted else "revoke"
    r = run_adb(["shell", "pm", op, pkg, perm], device)
    output = format_adb_raw_output(r.stdout, r.stderr)
    low = output.lower()
    ok = r.returncode == 0 and "exception" not in low and "unknown permission" not in low
    return AdbCommandResult(
        label=f"pm {op} {pkg} {perm}",
        returncode=0 if ok else (r.returncode or 1),
        output=output or f"pm {op} {perm}",
    )


def adb_grant_all_package_permissions(
    device: str | None,
    package_name: str,
    permissions: list[str],
) -> dict[str, object]:
    """批量授予应用指定的运行时权限列表。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    pkg = _validate_pkg_token(package_name, "包名")
    cleaned: list[str] = []
    seen: set[str] = set()
    for raw in permissions:
        perm = _validate_pkg_token(raw, "权限名")
        if perm not in seen:
            seen.add(perm)
            cleaned.append(perm)
    if not cleaned:
        return {"ok": True, "granted_count": 0, "failed_count": 0, "output": "没有需要授予的权限"}

    granted_count = 0
    failed_lines: list[str] = []
    for perm in cleaned:
        res = adb_set_package_permission(device, pkg, perm, True)
        if res.ok:
            granted_count += 1
        else:
            msg = res.output.strip() or "失败"
            failed_lines.append(f"{perm}: {msg}")
    failed_count = len(failed_lines)
    summary = f"已尝试授予 {len(cleaned)} 项权限：成功 {granted_count}，失败 {failed_count}"
    if failed_lines:
        summary = f"{summary}\n" + "\n".join(failed_lines[:8])
    return {
        "ok": granted_count > 0 or failed_count == 0,
        "granted_count": granted_count,
        "failed_count": failed_count,
        "output": summary,
    }


_FOREGROUND_COMP_RE = re.compile(r"([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)/([A-Za-z0-9_.$]+)")


def _parse_foreground_output(text: str) -> tuple[str, str, str]:
    """从 dumpsys activity / window 输出提取前台 (package, activity, raw_line)。"""
    priority_prefixes = (
        "topresumedactivity",
        "mresumedactivity",
        "resumedactivity",
        "mcurrentfocus",
        "mfocusedapp",
    )
    best: tuple[int, str, str, str] | None = None
    for raw_line in (text or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        low = line.lower()
        rank = -1
        for i, pref in enumerate(priority_prefixes):
            if pref in low:
                rank = i
                break
        if rank < 0:
            continue
        m = _FOREGROUND_COMP_RE.search(line)
        if not m:
            continue
        pkg, act = m.group(1), m.group(2)
        if best is None or rank < best[0]:
            best = (rank, pkg, act, line)
            if rank == 0:
                break
    if best is None:
        return "", "", ""
    return best[1], best[2], best[3]


def adb_foreground_app(device: str | None) -> dict[str, str]:
    """获取当前设备前台正在运行的应用包名与 Activity。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    r_act = run_adb(["shell", "dumpsys", "activity", "activities"], device, timeout=15.0)
    pkg, act, raw = _parse_foreground_output((r_act.stdout or "") + "\n" + (r_act.stderr or ""))
    if not pkg:
        r_win = run_adb(["shell", "dumpsys", "window", "windows"], device, timeout=15.0)
        pkg, act, raw = _parse_foreground_output((r_win.stdout or "") + "\n" + (r_win.stderr or ""))
    return {"package": pkg, "activity": act, "raw": raw}


def adb_package_pids(device: str | None, package_name: str) -> list[str]:
    """查询指定应用当前运行中的进程 PID 列表。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    pkg = _validate_pkg_token(package_name, "包名")
    r = run_adb(["shell", "pidof", pkg], device, timeout=10.0)
    pids = [tok for tok in (r.stdout or "").split() if tok.isdigit()]
    if pids:
        return pids
    r_ps = run_adb(["shell", "ps", "-A"], device, timeout=10.0)
    if r_ps.returncode != 0:
        r_ps = run_adb(["shell", "ps"], device, timeout=10.0)
    found: list[str] = []
    for raw in (r_ps.stdout or "").splitlines():
        cols = raw.split()
        if len(cols) >= 2 and cols[-1] == pkg:
            for col in cols[1:3]:
                if col.isdigit():
                    found.append(col)
                    break
    return found


def adb_export_package_apk(
    device: str | None,
    package_name: str,
    *,
    dest_dir: str = "",
    version_name: str = "",
) -> dict[str, object]:
    """从设备导出指定应用的 APK（兼容单包与 Split APKs）。"""
    from tools.adb_tools.remote_fs import adb_pull_file
    from tools.bundled_paths import output_dir

    if not adb_available():
        raise RuntimeError("未找到 adb")
    pkg = _validate_pkg_token(package_name, "包名")
    p = run_adb(["shell", "pm", "path", pkg], device, timeout=20.0)
    remote_paths = [
        ln.strip().removeprefix("package:").strip()
        for ln in (p.stdout or "").splitlines()
        if ln.strip().startswith("package:")
    ]
    if not remote_paths:
        err = (p.stderr or p.stdout or "").strip()
        raise RuntimeError(err or f"未找到 {pkg} 的安装包路径")

    base_dir = Path(dest_dir.strip()).expanduser() if dest_dir.strip() else output_dir("adb_pulls")
    base_dir.mkdir(parents=True, exist_ok=True)
    safe_ver = re.sub(r'[<>:"/\\|?*\s]+', "_", (version_name or "").strip())
    stem = f"{pkg}_{safe_ver}" if safe_ver else pkg

    saved_paths: list[str] = []
    outputs: list[str] = []
    if len(remote_paths) == 1:
        local_file = (base_dir / f"{stem}.apk").resolve()
        res = adb_pull_file(device, remote_paths[0], local_file)
        saved_paths.append(str(res.saved_path or local_file))
        if res.output:
            outputs.append(res.output.strip())
    else:
        sub_dir = (base_dir / stem).resolve()
        sub_dir.mkdir(parents=True, exist_ok=True)
        for rp in remote_paths:
            fname = Path(rp.rstrip("/")).name or "split.apk"
            local_file = (sub_dir / fname).resolve()
            res = adb_pull_file(device, rp, local_file)
            saved_paths.append(str(res.saved_path or local_file))
            if res.output:
                outputs.append(res.output.strip())

    return {
        "ok": True,
        "package": pkg,
        "saved_paths": saved_paths,
        "saved_dir": str(base_dir.resolve()),
        "output": "\n".join(outputs) or f"已导出 {len(saved_paths)} 个文件",
    }
