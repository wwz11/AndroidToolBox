#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ADB 远程设备文件系统操作（浏览、属性、重命名、复制、权限、新建、删除、推拉）。"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from tools.adb_runtime import (
    _subprocess_kwargs,
    adb_available,
    adb_subprocess_env,
    build_adb_cmd,
    decode_adb_bytes,
    kill_process_tree,
    run_adb,
)
from tools.adb_tools.common import AdbCommandResult, format_adb_raw_output

REMOTE_PATH_PRESETS: tuple[str, ...] = (
    "/sdcard/",
    "/sdcard/Download/",
    "/storage/emulated/0/",
    "/data/local/tmp/",
    "/mnt/sdcard/",
)


@dataclass(frozen=True)
class RemoteEntry:
    name: str
    path: str
    is_dir: bool
    size: int = 0
    mtime: str = ""
    mode: str = ""
    owner: str = ""
    group: str = ""
    is_link: bool = False
    link_target: str = ""


def join_remote_path(base: str, name: str) -> str:
    base = (base or "/").rstrip("/") or "/"
    name = name.strip().strip("/")
    if not name:
        return base
    if base == "/":
        return f"/{name}"
    return f"{base}/{name}"


def parent_remote_path(path: str) -> str:
    p = (path or "/").rstrip("/") or "/"
    if p == "/":
        return "/"
    parent = p.rsplit("/", 1)[0]
    return parent or "/"


def _normalize_remote_dir_for_listing(remote_dir: str) -> str:
    """目录列表路径规范化；末尾加 / 以便 ls 进入符号链接目录（如 /sdcard）。"""
    directory = (remote_dir or "/").strip() or "/"
    if not directory.startswith("/"):
        directory = f"/{directory}"
    if directory != "/" and not directory.endswith("/"):
        directory += "/"
    return directory


def _listing_parent_dir(directory: str) -> str:
    """用于 join_remote_path 的目录路径（无末尾 /）。"""
    parent = directory.rstrip("/")
    return parent or "/"


def _shell_quote_sh(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def _entry_name_from_ls_path(line: str) -> str:
    line = line.strip().rstrip("/@")
    if not line:
        return ""
    return line.rsplit("/", 1)[-1]


def _list_dir_names_via_glob(device: str | None, directory: str) -> set[str]:
    """用 ``ls -d */`` 列出当前目录下的文件夹（含符号链接目录）。"""
    parent = _listing_parent_dir(directory)
    if parent == "/":
        shell_cmds = ("ls -d /*/", "cd / && ls -d */")
    else:
        q = _shell_quote_sh(parent)
        shell_cmds = (f"ls -d {q}/*/", f"cd {q} && ls -d */")

    names: set[str] = set()
    for shell_cmd in shell_cmds:
        r = run_adb(["shell", shell_cmd], device)
        if r.returncode != 0:
            continue
        for raw in (r.stdout or "").splitlines():
            name = _entry_name_from_ls_path(raw)
            if name and name not in (".", ".."):
                names.add(name)
        if names:
            break
    return names


def _absorb_ls_output(
    text: str,
    seen: set[str],
    names: list[str],
    *,
    one_per_line: bool = False,
) -> None:
    """从 ls 输出提取条目名。

    ``one_per_line=True``（ls -1）时整行作为文件名，避免空格/中文名被拆开。
    """
    for raw in text.splitlines():
        line = raw.rstrip("\r\n")
        if not line.strip():
            continue
        if one_per_line:
            name = line.rstrip().rstrip("/@")
            if not name or name in (".", "..") or name in seen:
                continue
            seen.add(name)
            names.append(name)
            continue
        tokens = line.split() if any(ch.isspace() for ch in line) else [line.strip()]
        for token in tokens:
            name = _entry_name_from_ls_path(token)
            if not name or name in (".", "..") or name in seen:
                continue
            seen.add(name)
            names.append(name)


def _list_all_entry_names(device: str | None, directory: str) -> list[str]:
    """列出当前目录全部条目名称（优先 ls -a -1）。"""
    parent = _listing_parent_dir(directory)
    names: list[str] = []
    seen: set[str] = set()
    last_err = ""
    listed_ok = False

    for args, one_per_line in (
        (["ls", "-a", "-1", "--", parent], True),
        (["ls", "-1", "--", parent], True),
        (["ls", "-1", parent], True),
        (["ls", parent], False),
    ):
        r = run_adb(["shell", *args], device)
        if r.returncode != 0:
            last_err = ((r.stdout or "") + (r.stderr or "")).strip()
            continue
        listed_ok = True
        _absorb_ls_output(r.stdout or "", seen, names, one_per_line=one_per_line)
        if names:
            break

    if not listed_ok:
        raise RuntimeError(last_err or f"无法列出目录: {parent}")
    return names


def _canonicalize_remote_dir(device: str | None, directory: str) -> str:
    """尽量把 /sdcard 解析成真实路径，避免列表与删除路径不一致。"""
    parent = _listing_parent_dir(directory)
    if parent not in ("/sdcard", "/storage/emulated/0"):
        return directory
    for cmd in (
        ["shell", "realpath", parent],
        ["shell", "readlink", "-f", parent],
        ["shell", f"cd {_shell_quote_sh(parent)} && pwd"],
    ):
        r = run_adb(cmd, device)
        line = (r.stdout or "").strip().splitlines()
        if r.returncode == 0 and line:
            resolved = line[0].strip()
            if resolved.startswith("/"):
                return _normalize_remote_dir_for_listing(resolved)
    return directory


def _parse_size_token(token: str) -> int:
    t = (token or "").strip().lower().replace(",", "")
    if not t:
        return 0
    try:
        if t[-1] in "kmgtp" and len(t) >= 2:
            mult = {"k": 1024, "m": 1024**2, "g": 1024**3, "t": 1024**4, "p": 1024**5}[
                t[-1]
            ]
            return int(float(t[:-1]) * mult)
        return int(t)
    except (ValueError, KeyError):
        return 0


def _parse_ls_la_line(line: str) -> RemoteEntry | None:
    """解析 ``ls -la`` 单行；兼容 Android toybox 常见格式。"""
    s = line.rstrip("\r\n")
    if not s or s.startswith("total "):
        return None
    parts = s.split(None, 7)
    if len(parts) < 8:
        return None
    mode, _nlink, owner, group, size_s, date_s, time_s, rest = parts
    if not mode or mode[0] not in "-dlcbps":
        return None
    name = rest
    link_target = ""
    is_link = mode[0] == "l"
    if is_link and " -> " in rest:
        name, link_target = rest.split(" -> ", 1)
    name = name.rstrip("/")
    if not name or name in (".", ".."):
        return None
    return RemoteEntry(
        name=name,
        path="",
        is_dir=mode[0] == "d" or (is_link and link_target.endswith("/")),
        size=_parse_size_token(size_s),
        mtime=f"{date_s} {time_s}".strip(),
        mode=mode,
        owner=owner,
        group=group,
        is_link=is_link,
        link_target=link_target.strip(),
    )


def _adb_output_denied(text: str) -> bool:
    """识别 adb/shell 无权限类输出。"""
    raw = text or ""
    low = raw.lower()
    if any(
        s in low
        for s in (
            "permission denied",
            "access denied",
            "operation not permitted",
            "not allowed",
        )
    ):
        return True
    if "权限" in raw and any(s in raw for s in ("拒绝", "不足", "没有", "无")):
        return True
    return False


def _raise_if_fatal_ls_error(parent: str, text: str) -> None:
    if _adb_output_denied(text):
        raise RuntimeError(f"无权限访问目录: {parent}\n{text}")
    if "transport endpoint is not connected" in (text or "").lower():
        raise RuntimeError(
            f"存储挂载点已断开（{text}）：设备可能正在开机或系统存储服务重启中，请稍后重试或先访问 /data/local/tmp"
        )


def _list_entries_via_ls_la(
    device: str | None, parent: str
) -> list[RemoteEntry] | None:
    last_err = ""
    for args in (
        ["ls", "-la", "--", parent],
        ["ls", "-la", parent],
        ["ls", "-l", "--", parent],
    ):
        r = run_adb(["shell", *args], device)
        text = format_adb_raw_output(r.stdout, r.stderr).strip()
        if r.returncode != 0:
            last_err = text
            _raise_if_fatal_ls_error(parent, text)
            continue
        entries: list[RemoteEntry] = []
        seen: set[str] = set()
        for raw in (r.stdout or "").splitlines():
            ent = _parse_ls_la_line(raw)
            if ent is None or ent.name in seen:
                continue
            seen.add(ent.name)
            entries.append(
                RemoteEntry(
                    name=ent.name,
                    path=join_remote_path(parent, ent.name),
                    is_dir=ent.is_dir,
                    size=ent.size,
                    mtime=ent.mtime,
                    mode=ent.mode,
                    owner=ent.owner,
                    group=ent.group,
                    is_link=ent.is_link,
                    link_target=ent.link_target,
                )
            )
        if entries:
            return entries
        if r.returncode == 0:
            return entries
    if last_err:
        _raise_if_fatal_ls_error(parent, last_err)
    return None


def list_remote_entries(device: str | None, remote_dir: str) -> tuple[str, list[RemoteEntry]]:
    """列出设备目录内容（优先 ls -la 带大小/时间/权限）。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    directory = _normalize_remote_dir_for_listing(remote_dir)
    directory = _canonicalize_remote_dir(device, directory)
    parent = _listing_parent_dir(directory)

    detailed = _list_entries_via_ls_la(device, parent)
    if detailed is not None:
        detailed.sort(key=lambda e: (not e.is_dir, e.name.lower()))
        return directory, detailed

    try:
        dir_names = _list_dir_names_via_glob(device, directory)
        all_names = _list_all_entry_names(device, directory)
    except RuntimeError as exc:
        msg = str(exc)
        if _adb_output_denied(msg):
            raise RuntimeError(f"无权限访问目录: {parent}\n{msg}") from exc
        raise
    seen = set(all_names)
    for name in dir_names:
        if name not in seen:
            all_names.append(name)
            seen.add(name)
    entries = [
        RemoteEntry(
            name=name,
            path=join_remote_path(parent, name),
            is_dir=name in dir_names,
        )
        for name in all_names
    ]
    entries.sort(key=lambda e: (not e.is_dir, e.name.lower()))
    return directory, entries


def adb_stat(device: str | None, remote_path: str) -> dict:
    """单文件/目录属性。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    target = (remote_path or "").strip()
    if not target.startswith("/"):
        target = f"/{target}"
    if len(target) > 1:
        target = target.rstrip("/") or "/"
    q = _shell_quote_sh(target)
    r = run_adb(["shell", f"ls -ld -- {q}"], device)
    text = format_adb_raw_output(r.stdout, r.stderr).strip()
    if r.returncode != 0:
        raise RuntimeError(text or f"无法获取属性: {target}")
    line = next((ln for ln in text.splitlines() if ln.strip()), "")
    ent = _parse_ls_la_line(line)
    info = {
        "path": target,
        "name": target.rsplit("/", 1)[-1] or target,
        "exists": True,
        "raw": line,
    }
    if ent is not None:
        info.update(
            {
                "name": ent.name if ent.name != target else info["name"],
                "is_dir": ent.is_dir,
                "size": ent.size,
                "mtime": ent.mtime,
                "mode": ent.mode,
                "owner": ent.owner,
                "group": ent.group,
                "is_link": ent.is_link,
                "link_target": ent.link_target,
            }
        )
    return info


def adb_rename(device: str | None, src: str, dst: str) -> AdbCommandResult:
    if not adb_available():
        raise RuntimeError("未找到 adb")
    s = (src or "").strip()
    d = (dst or "").strip()
    if not s or not d:
        raise ValueError("源与目标路径不能为空")
    if not s.startswith("/"):
        s = f"/{s}"
    if not d.startswith("/"):
        d = f"/{d}"
    r = run_adb(
        ["shell", f"mv -f -- {_shell_quote_sh(s)} {_shell_quote_sh(d)}"],
        device,
    )
    out = format_adb_raw_output(r.stdout, r.stderr)
    if r.returncode == 0 and not out.strip():
        out = f"已重命名/移动 {s} → {d}\n"
    return AdbCommandResult(label=f"mv {s}", returncode=r.returncode, output=out)


def adb_copy(
    device: str | None,
    src: str,
    dst: str,
    *,
    recursive: bool = True,
) -> AdbCommandResult:
    if not adb_available():
        raise RuntimeError("未找到 adb")
    s = (src or "").strip()
    d = (dst or "").strip()
    if not s or not d:
        raise ValueError("源与目标路径不能为空")
    if not s.startswith("/"):
        s = f"/{s}"
    if not d.startswith("/"):
        d = f"/{d}"
    flag = "-a" if recursive else "-p"
    r = run_adb(
        ["shell", f"cp {flag} -- {_shell_quote_sh(s)} {_shell_quote_sh(d)}"],
        device,
    )
    out = format_adb_raw_output(r.stdout, r.stderr)
    if r.returncode != 0:
        r = run_adb(
            ["shell", f"cp -r -- {_shell_quote_sh(s)} {_shell_quote_sh(d)}"],
            device,
        )
        out = format_adb_raw_output(r.stdout, r.stderr)
    if r.returncode == 0 and not out.strip():
        out = f"已复制 {s} → {d}\n"
    return AdbCommandResult(label=f"cp {s}", returncode=r.returncode, output=out)


def adb_chmod(device: str | None, remote_path: str, mode: str) -> AdbCommandResult:
    if not adb_available():
        raise RuntimeError("未找到 adb")
    target = (remote_path or "").strip()
    m = (mode or "").strip()
    if not target:
        raise ValueError("路径为空")
    if not re.fullmatch(r"[0-7]{3,4}", m):
        raise ValueError("权限应为 3~4 位八进制，如 644 / 0755")
    if not target.startswith("/"):
        target = f"/{target}"
    r = run_adb(
        ["shell", f"chmod {m} -- {_shell_quote_sh(target)}"],
        device,
    )
    out = format_adb_raw_output(r.stdout, r.stderr)
    if r.returncode == 0 and not out.strip():
        out = f"已设置权限 {m} → {target}\n"
    return AdbCommandResult(label=f"chmod {m}", returncode=r.returncode, output=out)


def adb_mkdir(device: str | None, remote_dir: str) -> AdbCommandResult:
    if not adb_available():
        raise RuntimeError("未找到 adb")
    target = (remote_dir or "").strip()
    if not target:
        raise ValueError("请填写目录路径")
    if not target.startswith("/"):
        target = f"/{target}"
    r = run_adb(["shell", f"mkdir -p {_shell_quote_sh(target)}"], device)
    out = format_adb_raw_output(r.stdout, r.stderr)
    if r.returncode == 0 and not out.strip():
        out = f"已创建目录 {target}\n"
    return AdbCommandResult(
        label=f"mkdir {target}",
        returncode=r.returncode,
        output=out,
    )


def adb_create_file(device: str | None, remote_file: str) -> AdbCommandResult:
    """在设备上创建空文件（父目录需已存在或可创建）。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    target = (remote_file or "").strip()
    if not target or target.endswith("/"):
        raise ValueError("请填写文件路径")
    if not target.startswith("/"):
        target = f"/{target}"
    parent = parent_remote_path(target)
    q_parent = _shell_quote_sh(parent)
    q_file = _shell_quote_sh(target)
    r = run_adb(["shell", f"mkdir -p {q_parent} && touch {q_file}"], device)
    out = format_adb_raw_output(r.stdout, r.stderr)
    if r.returncode == 0 and not out.strip():
        out = f"已创建文件 {target}\n"
    return AdbCommandResult(
        label=f"touch {target}",
        returncode=r.returncode,
        output=out,
    )


def _sdcard_path_aliases(remote_path: str) -> list[str]:
    """/sdcard 与 /storage/emulated/0 在设备上常互通，删除/探测时都试一遍。"""
    p = (remote_path or "").strip()
    if not p.startswith("/"):
        p = f"/{p}"
    if len(p) > 1:
        p = p.rstrip("/") or "/"
    out: list[str] = []
    for cand in (
        p,
        (
            "/storage/emulated/0/" + p[len("/sdcard/") :]
            if p.startswith("/sdcard/")
            else None
        ),
        (
            "/sdcard/" + p[len("/storage/emulated/0/") :]
            if p.startswith("/storage/emulated/0/")
            else None
        ),
        (
            "/storage/emulated/0"
            if p in ("/sdcard", "/sdcard/")
            else None
        ),
    ):
        if not cand:
            continue
        if cand not in out:
            out.append(cand)
    return out


def _adb_ls_exists(device: str | None, remote_path: str) -> bool:
    """用 ls 探测路径是否存在（比 ``[ -e ]`` 更贴近列表，且对 /sdcard 更稳）。"""
    for path in _sdcard_path_aliases(remote_path):
        r = run_adb(["shell", "ls", "-ld", "--", path], device)
        text = ((r.stdout or "") + (r.stderr or "")).lower()
        if r.returncode == 0 and "no such file" not in text:
            return True
        q = _shell_quote_sh(path)
        r2 = run_adb(["shell", f"ls -ld -- {q}"], device)
        text2 = ((r2.stdout or "") + (r2.stderr or "")).lower()
        if r2.returncode == 0 and "no such file" not in text2:
            return True
    return False


def _adb_rm_once(device: str | None, remote_path: str) -> str:
    """对单一路径尝试多种删除方式，返回合并日志。"""
    logs: list[str] = []
    q = _shell_quote_sh(remote_path)
    attempts: list[list[str]] = [
        ["shell", "rm", "-rf", "--", remote_path],
        ["shell", f"chmod -R ugo+w {q} 2>/dev/null; rm -rf -- {q}"],
        ["shell", f"rm -rf -- {q}"],
        ["shell", "su", "0", "rm", "-rf", "--", remote_path],
        ["shell", f"su -c {_shell_quote_sh(f'rm -rf -- {remote_path}')}"],
    ]
    for args in attempts:
        r = run_adb(args, device)
        piece = format_adb_raw_output(r.stdout, r.stderr).strip()
        if piece:
            logs.append(piece)
        if not _adb_ls_exists(device, remote_path):
            break
    return "\n".join(logs).strip()


def adb_delete_path(
    device: str | None,
    remote_path: str,
    *,
    recursive: bool = True,
) -> AdbCommandResult:
    """删除设备文件/目录。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    raw = (remote_path or "").strip()
    if not raw.startswith("/"):
        raw = f"/{raw}"
    target = raw if len(raw) == 1 or not raw.endswith("/") else raw.rstrip("/")
    protected = {
        "/",
        "/system",
        "/system/bin",
        "/data",
        "/data/data",
        "/sdcard",
        "/storage",
        "/storage/emulated",
        "/storage/emulated/0",
        "/mnt",
        "/vendor",
        "/proc",
        "/dev",
    }
    norm = target.rstrip("/") or "/"
    if norm in protected:
        raise ValueError(f"拒绝删除受保护路径: {norm}")

    _ = recursive
    candidates = _sdcard_path_aliases(target)
    existed = any(_adb_ls_exists(device, c) for c in candidates)
    logs: list[str] = []

    for cand in candidates:
        piece = _adb_rm_once(device, cand)
        if piece:
            logs.append(piece)
        if not any(_adb_ls_exists(device, c) for c in candidates):
            msg = f"已删除 {target}\n"
            if logs:
                msg = "\n".join(logs) + "\n" + msg
            return AdbCommandResult(
                label=f"rm {target}",
                returncode=0,
                output=msg,
            )

    still = any(_adb_ls_exists(device, c) for c in candidates)
    detail = "\n".join(logs).strip()
    if not existed and not still:
        parent = parent_remote_path(target)
        base = target.rsplit("/", 1)[-1]
        q_parent = _shell_quote_sh(parent)
        q_base = _shell_quote_sh(base)
        match_cmd = (
            f"cd {q_parent} 2>/dev/null || exit 1; "
            f"for f in * .*; do "
            f'[ "$f" = "." ] || [ "$f" = ".." ] && continue; '
            f'[ "$f" = {q_base} ] && rm -rf -- "$f" && echo matched; '
            f"done"
        )
        r = run_adb(["shell", match_cmd], device)
        piece = format_adb_raw_output(r.stdout, r.stderr).strip()
        if piece:
            logs.append(piece)
        if not _adb_ls_exists(device, target) and "matched" in (r.stdout or ""):
            return AdbCommandResult(
                label=f"rm {target}",
                returncode=0,
                output=f"已删除 {target}\n",
            )
        out = (
            f"无法确认路径（ls 与探测不一致），删除未成功: {target}\n"
            "可尝试进 Shell 手动 rm，或检查文件名编码。"
        )
        if detail:
            out = detail + "\n" + out
        return AdbCommandResult(label=f"rm {target}", returncode=1, output=out + "\n")

    hint = "删除失败（可能权限不足，可先在 Shell 执行 adb root 后再试）"
    out = f"{detail}\n{hint}: {target}\n" if detail else f"{hint}: {target}\n"
    return AdbCommandResult(
        label=f"rm {target}",
        returncode=1,
        output=out,
    )


def adb_pull_file(device: str | None, remote: str, local: Path) -> AdbCommandResult:
    """拉取设备文件或整个目录到本机。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    remote = (remote or "").strip()
    if not remote:
        raise ValueError("请填写设备路径")
    if not remote.startswith("/"):
        remote = f"/{remote}"
    if len(remote) > 1:
        remote = remote.rstrip("/") or "/"

    local = Path(local)
    remote_name = Path(remote).name or "pulled"

    is_remote_dir = False
    try:
        is_remote_dir = bool(adb_stat(device, remote).get("is_dir"))
    except Exception:
        is_remote_dir = False

    if is_remote_dir:
        dest_parent = local.parent if local.name == remote_name else local
        dest_parent.mkdir(parents=True, exist_ok=True)
        r = run_adb(["pull", remote, str(dest_parent)], device)
        candidates = [
            dest_parent / remote_name,
            local,
            dest_parent,
        ]
    else:
        local.parent.mkdir(parents=True, exist_ok=True)
        r = run_adb(["pull", remote, str(local)], device)
        candidates = [local, local.parent / remote_name]

    out_text = format_adb_raw_output(r.stdout, r.stderr)
    saved: Path | None = None
    if r.returncode == 0:
        for cand in candidates:
            try:
                if cand.exists():
                    saved = cand.resolve()
                    break
            except OSError:
                continue
    if r.returncode == 0 and not out_text.strip():
        out_text = f"已保存到 {saved or local}\n"
    elif r.returncode == 0 and saved and str(saved) not in out_text:
        out_text = f"{out_text.rstrip()}\n已保存到 {saved}\n"

    return AdbCommandResult(
        label=f"pull {remote}",
        returncode=r.returncode,
        output=out_text,
        saved_path=saved,
    )


def adb_push_file(device: str | None, local: Path, remote: str) -> AdbCommandResult:
    if not adb_available():
        raise RuntimeError("未找到 adb")
    local = Path(local)
    if not local.exists():
        raise RuntimeError(f"本地路径不存在: {local}")
    remote = remote.strip()
    if not remote:
        raise ValueError("请填写设备目标路径")
    r = run_adb(["push", str(local), remote], device)
    out_text = format_adb_raw_output(r.stdout, r.stderr)
    if r.returncode == 0 and not out_text.strip():
        out_text = f"已推送到 {remote}\n"
    return AdbCommandResult(
        label=f"push {local.name} → {remote}",
        returncode=r.returncode,
        output=out_text,
    )


def _dir_tree_bytes(root: Path) -> int:
    """统计本地目录下所有普通文件总字节数。"""
    if not root.exists():
        return 0
    if root.is_file():
        try:
            return root.stat().st_size
        except OSError:
            return 0
    total = 0
    for p in root.rglob("*"):
        if p.is_file():
            try:
                total += p.stat().st_size
            except OSError:
                continue
    return total


def _probe_remote_file_size(device: str | None, remote: str) -> int:
    """快速探测远端单文件当前字节数（用于 adb push 实时进度）。"""
    q = _shell_quote_sh(remote)
    cmd = build_adb_cmd(["shell", f"stat -c %s -- {q} 2>/dev/null || ls -ld -- {q}"], device)
    try:
        r = subprocess.run(
            cmd,
            capture_output=True,
            timeout=1.5,
            env=adb_subprocess_env(),
            **_subprocess_kwargs(),
        )
    except Exception:
        return 0
    if r.returncode != 0:
        return 0
    text = format_adb_raw_output(r.stdout, r.stderr).strip()
    if not text:
        return 0
    first = text.splitlines()[0].strip()
    if first.isdigit():
        return int(first)
    ent = _parse_ls_la_line(first)
    return int(ent.size) if ent is not None and ent.size > 0 else 0


def _run_adb_transfer_with_progress(
    device: str | None,
    args: list[str],
    total_bytes: int,
    probe_done_bytes: Callable[[], int] | None,
    on_progress: Callable[[dict[str, Any]], None] | None,
    cancel_event: threading.Event | None = None,
) -> tuple[int, str, bool]:
    """执行 adb pull/push 子进程并定时回调字节进度、速率与取消状态。"""
    cmd = build_adb_cmd(args, device)
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=adb_subprocess_env(),
        **_subprocess_kwargs(),
    )
    out_chunks: list[bytes] = []
    err_chunks: list[bytes] = []

    def _drain(stream: Any, target: list[bytes]) -> None:
        try:
            if stream is not None:
                target.append(stream.read())
        except Exception:
            pass

    t_out = threading.Thread(target=_drain, args=(proc.stdout, out_chunks), daemon=True)
    t_err = threading.Thread(target=_drain, args=(proc.stderr, err_chunks), daemon=True)
    t_out.start()
    t_err.start()

    started_at = time.monotonic()
    last_emit = started_at
    cancelled = False

    while proc.poll() is None:
        if cancel_event is not None and cancel_event.is_set():
            cancelled = True
            kill_process_tree(proc)
            break
        now = time.monotonic()
        if on_progress is not None and now - last_emit >= 0.18:
            done_bytes = 0
            if probe_done_bytes is not None:
                try:
                    done_bytes = max(0, int(probe_done_bytes()))
                except Exception:
                    done_bytes = 0
            after_probe = time.monotonic()
            if total_bytes > 0:
                done_bytes = min(done_bytes, total_bytes)
                pct: int | None = min(99, int(done_bytes * 100 / total_bytes))
            else:
                pct = None
            elapsed = max(0.2, after_probe - started_at)
            speed_bps = int(done_bytes / elapsed) if done_bytes > 0 else 0
            on_progress(
                {
                    "type": "progress",
                    "done_bytes": done_bytes,
                    "total_bytes": total_bytes,
                    "percent": pct,
                    "speed_bps": speed_bps,
                }
            )
            last_emit = after_probe
        time.sleep(0.08)

    t_out.join(timeout=1.5)
    t_err.join(timeout=1.5)
    rc = -1 if cancelled else int(proc.returncode or 0)
    out_text = format_adb_raw_output(
        decode_adb_bytes(b"".join(out_chunks)),
        decode_adb_bytes(b"".join(err_chunks)),
    )
    if cancelled:
        out_text = (out_text.rstrip() + "\n已取消传输").strip()
    return rc, out_text, cancelled


def adb_pull_with_progress(
    device: str | None,
    remote: str,
    local: Path,
    on_progress: Callable[[dict[str, Any]], None] | None = None,
    cancel_event: threading.Event | None = None,
) -> AdbCommandResult:
    """流式带进度拉取设备文件或目录到本机。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    remote = (remote or "").strip()
    if not remote:
        raise ValueError("请填写设备路径")
    if not remote.startswith("/"):
        remote = f"/{remote}"
    if len(remote) > 1:
        remote = remote.rstrip("/") or "/"

    local = Path(local)
    remote_name = Path(remote).name or "pulled"
    is_remote_dir = False
    total_bytes = 0
    try:
        st = adb_stat(device, remote)
        is_remote_dir = bool(st.get("is_dir"))
        if not is_remote_dir:
            total_bytes = max(0, int(st.get("size") or 0))
    except Exception:
        is_remote_dir = False

    if on_progress is not None:
        on_progress(
            {
                "type": "start",
                "remote": remote,
                "local": str(local),
                "total_bytes": total_bytes,
            }
        )

    if is_remote_dir:
        dest_parent = local.parent if local.name == remote_name else local
        dest_parent.mkdir(parents=True, exist_ok=True)
        watch_dir = dest_parent / remote_name
        args = ["pull", remote, str(dest_parent)]
        probe = lambda: _dir_tree_bytes(watch_dir)
        candidates = [watch_dir, local, dest_parent]
    else:
        local.parent.mkdir(parents=True, exist_ok=True)
        try:
            if local.exists() and local.is_file():
                local.unlink()
        except OSError:
            pass
        args = ["pull", remote, str(local)]
        probe = lambda: local.stat().st_size if local.exists() else 0
        candidates = [local, local.parent / remote_name]

    rc, out_text, cancelled = _run_adb_transfer_with_progress(
        device, args, total_bytes, probe, on_progress, cancel_event
    )
    saved: Path | None = None
    if rc == 0 and not cancelled:
        for cand in candidates:
            try:
                if cand.exists():
                    saved = cand.resolve()
                    break
            except OSError:
                continue
    if rc == 0 and not cancelled:
        final_bytes = total_bytes or (_dir_tree_bytes(saved) if saved else 0)
        if on_progress is not None:
            on_progress(
                {
                    "type": "progress",
                    "done_bytes": final_bytes,
                    "total_bytes": final_bytes,
                    "percent": 100,
                    "speed_bps": 0,
                }
            )
    if rc == 0 and not out_text.strip():
        out_text = f"已保存到 {saved or local}\n"
    elif rc == 0 and saved and str(saved) not in out_text:
        out_text = f"{out_text.rstrip()}\n已保存到 {saved}\n"

    return AdbCommandResult(
        label=f"pull {remote}",
        returncode=rc,
        output=out_text,
        saved_path=saved,
    )


def adb_push_with_progress(
    device: str | None,
    local: Path,
    remote: str,
    on_progress: Callable[[dict[str, Any]], None] | None = None,
    cancel_event: threading.Event | None = None,
) -> AdbCommandResult:
    """流式带进度推送本机文件或目录到设备。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    local = Path(local)
    if not local.exists():
        raise RuntimeError(f"本地路径不存在: {local}")
    remote = remote.strip()
    if not remote:
        raise ValueError("请填写设备目标路径")

    is_dir = local.is_dir()
    total_bytes = _dir_tree_bytes(local)
    if on_progress is not None:
        on_progress(
            {
                "type": "start",
                "local": str(local),
                "remote": remote,
                "total_bytes": total_bytes,
            }
        )

    probe = None if is_dir else (lambda: _probe_remote_file_size(device, remote))
    rc, out_text, cancelled = _run_adb_transfer_with_progress(
        device, ["push", str(local), remote], total_bytes, probe, on_progress, cancel_event
    )
    if rc == 0 and not cancelled and on_progress is not None:
        on_progress(
            {
                "type": "progress",
                "done_bytes": total_bytes,
                "total_bytes": total_bytes,
                "percent": 100,
                "speed_bps": 0,
            }
        )
    if rc == 0 and not out_text.strip():
        out_text = f"已推送到 {remote}\n"
    return AdbCommandResult(
        label=f"push {local.name} → {remote}",
        returncode=rc,
        output=out_text,
    )


def open_folder(path: Path) -> None:
    p = Path(path)
    folder = p if p.is_dir() else p.parent
    folder.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        os.startfile(str(folder))
    elif sys.platform == "darwin":
        subprocess.run(["open", str(folder)], check=False)
    else:
        subprocess.run(["xdg-open", str(folder)], check=False)


def _parse_df_output(text: str) -> dict[str, str]:
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    if len(lines) < 2:
        return {}
    # 处理 df 因文件系统名过长折行的情况
    cols = lines[-1].split()
    if len(cols) < 5 and len(lines) >= 3:
        cols = (lines[-2] + " " + lines[-1]).split()
    if len(cols) < 5:
        return {}
    # Filesystem Size Used Avail Use% Mounted on
    mount = cols[-1]
    use_pct = next((c for c in cols if c.endswith("%")), "")
    pct_idx = cols.index(use_pct) if use_pct in cols else len(cols) - 2
    avail = cols[pct_idx - 1] if pct_idx >= 1 else ""
    used = cols[pct_idx - 2] if pct_idx >= 2 else ""
    total = cols[pct_idx - 3] if pct_idx >= 3 else ""
    fs = cols[0] if pct_idx >= 4 else ""
    return {
        "filesystem": fs,
        "total": total,
        "used": used,
        "avail": avail,
        "use_pct": use_pct,
        "mount": mount,
    }


def adb_df_path(device: str | None, remote_path: str) -> dict[str, str]:
    """查询远程目录所在分区的磁盘空间（df -h）。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    target = (remote_path or "/").strip() or "/"
    q = _shell_quote_sh(target)
    r = run_adb(["shell", f"df -h {q}"], device, timeout=12.0)
    if r.returncode != 0:
        r = run_adb(["shell", f"df {q}"], device, timeout=12.0)
    parsed = _parse_df_output(r.stdout or "")
    if not parsed:
        return {"raw": (r.stdout or r.stderr or "").strip()}
    parsed["raw"] = (r.stdout or "").strip()
    return parsed


def adb_find_remote(
    device: str | None,
    base_dir: str,
    query: str,
    *,
    max_results: int = 120,
) -> list[dict[str, object]]:
    """在指定远程目录下递归查找匹配名称的条目。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    needle = (query or "").strip()
    if not needle:
        raise ValueError("请输入查找关键词")
    root = (base_dir or "/").strip().rstrip("/") or "/"
    q_root = _shell_quote_sh(root)
    q_pat = _shell_quote_sh(f"*{needle}*")
    limit = max(10, min(int(max_results), 300))
    cmd = f"find {q_root} -maxdepth 6 -iname {q_pat} 2>/dev/null | head -n {limit}"
    r = run_adb(["shell", cmd], device, timeout=25.0)
    out: list[dict[str, object]] = []
    seen: set[str] = set()
    for raw in (r.stdout or "").splitlines():
        p = raw.strip()
        if not p or not p.startswith("/") or p in seen:
            continue
        seen.add(p)
        if p == root:
            continue
        name = p.rstrip("/").rsplit("/", 1)[-1] or p
        out.append(
            {
                "path": p,
                "name": name,
                "parent": parent_remote_path(p),
            }
        )
    return out


def adb_md5_remote(device: str | None, remote_path: str) -> str:
    """计算设备上指定文件的 MD5 校验值。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    target = (remote_path or "").strip()
    if not target:
        raise ValueError("路径不能为空")
    q = _shell_quote_sh(target)
    r = run_adb(["shell", f"md5sum {q} || toybox md5sum {q} || busybox md5sum {q}"], device, timeout=60.0)
    raw = format_adb_raw_output(r.stdout, r.stderr).strip()
    m = re.search(r"\b([a-fA-F0-9]{32})\b", raw)
    if not m:
        raise RuntimeError(raw or "计算 MD5 失败")
    return m.group(1).lower()


_IMAGE_MIME_BY_EXT: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
}


def adb_read_remote_file(
    device: str | None,
    remote_path: str,
    *,
    max_text_bytes: int = 512 * 1024,
    max_image_bytes: int = 8 * 1024 * 1024,
) -> dict[str, object]:
    """拉取并读取远程文本/配置文件或图片内容供在线预览。"""
    import base64
    import tempfile

    if not adb_available():
        raise RuntimeError("未找到 adb")
    target = (remote_path or "").strip()
    if not target:
        raise ValueError("路径不能为空")
    ext = Path(target).suffix.lower()
    is_img = ext in _IMAGE_MIME_BY_EXT
    with tempfile.TemporaryDirectory(prefix="toolbox_fpreview_") as tmp:
        local = Path(tmp) / (Path(target).name or "preview.bin")
        res = adb_pull_file(device, target, local)
        saved = Path(res.saved_path) if res.saved_path else local
        if not res.ok or not saved.is_file():
            raise RuntimeError(res.output or f"读取失败: {target}")
        size = saved.stat().st_size
        if is_img:
            if size > max_image_bytes:
                raise RuntimeError(f"图片过大（{size // (1024 * 1024)} MB），请直接拉取到本地查看")
            raw_bytes = saved.read_bytes()
            return {
                "kind": "image",
                "path": target,
                "name": saved.name,
                "size": size,
                "mime": _IMAGE_MIME_BY_EXT[ext],
                "base64": base64.b64encode(raw_bytes).decode("ascii"),
                "truncated": False,
            }
        raw_bytes = saved.read_bytes()
        if b"\x00" in raw_bytes[:4096]:
            raise RuntimeError("该文件为二进制格式，暂不支持文本预览")
        truncated = len(raw_bytes) > max_text_bytes
        view_bytes = raw_bytes[:max_text_bytes] if truncated else raw_bytes
        return {
            "kind": "text",
            "path": target,
            "name": saved.name,
            "size": size,
            "text": view_bytes.decode("utf-8", errors="replace"),
            "truncated": truncated,
        }


def adb_write_remote_file(
    device: str | None,
    remote_path: str,
    content: str,
) -> AdbCommandResult:
    """将文本内容写回设备指定路径。"""
    import tempfile

    if not adb_available():
        raise RuntimeError("未找到 adb")
    target = (remote_path or "").strip()
    if not target:
        raise ValueError("路径不能为空")
    with tempfile.TemporaryDirectory(prefix="toolbox_fwrite_") as tmp:
        local = Path(tmp) / (Path(target).name or "file.txt")
        local.write_text(content, encoding="utf-8", newline="\n")
        return adb_push_file(device, local, target)
