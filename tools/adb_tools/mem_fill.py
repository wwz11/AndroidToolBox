#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ADB 设备 eMMC / 分区存储填充与释放引擎。"""

from __future__ import annotations

import re
import subprocess
import threading
import time

from tools.adb_runtime import (
    _subprocess_kwargs,
    adb_available,
    adb_subprocess_env,
    build_adb_cmd,
    decode_adb_bytes,
    kill_process_tree,
    run_adb,
)
from tools.adb_tools.common import _adb_output_denied
from tools.adb_tools.device_info import (
    _df_avail_kb,
    _df_space_kb,
    _format_capacity_bytes,
    _parse_positive_int,
)

MEM_FILL_DIR = "/data/local/tmp"
MEM_FILL_PREFIX = "sei_toolbox_mem_fill"
MEM_FILL_REMOTE = f"{MEM_FILL_DIR}/{MEM_FILL_PREFIX}.bin"
MEM_FILL_GLOB = f"{MEM_FILL_DIR}/{MEM_FILL_PREFIX}*.bin"
MEM_FILL_RESERVE_MB = 32
MEM_FILL_CHUNK_MB = 64
MEM_FILL_MAX_FILE_MB = 1536
_FILL_DIR_RE = re.compile(r"^/(?:[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*)?$")


def normalize_fill_dir(raw: str | None) -> str:
    """规范化填充目录；须为绝对路径且不含 shell 特殊字符。"""
    s = (raw or "").strip().replace("\\", "/")
    if not s:
        s = MEM_FILL_DIR
    if not s.startswith("/"):
        raise ValueError("填充路径须为绝对路径，例如 /data/local/tmp")
    s = re.sub(r"/{2,}", "/", s)
    if s != "/":
        s = s.rstrip("/")
    if any(p == ".." for p in s.split("/")):
        raise ValueError("填充路径无效")
    if not _FILL_DIR_RE.match(s):
        raise ValueError("填充路径含非法字符，仅允许字母数字 . _ - /")
    return s


def _fill_paths(fill_dir: str | None) -> tuple[str, str, str]:
    d = normalize_fill_dir(fill_dir)
    return d, f"{d}/{MEM_FILL_PREFIX}.bin", f"{d}/{MEM_FILL_PREFIX}*.bin"


def _remote_file_bytes(device: str | None, path: str) -> int:
    r = run_adb(["shell", f"ls -l '{path}' 2>/dev/null"], device, timeout=10.0)
    parts = (r.stdout or "").split()
    if len(parts) >= 5 and parts[4].isdigit():
        return int(parts[4])
    r = run_adb(
        ["shell", f"stat -c %s '{path}' 2>/dev/null"],
        device,
        timeout=10.0,
    )
    n = _parse_positive_int(r.stdout or "")
    return n if n > 0 else 0


def _fill_part_path(index: int, fill_dir: str = MEM_FILL_DIR) -> str:
    d = normalize_fill_dir(fill_dir)
    return f"{d}/{MEM_FILL_PREFIX}_{index:03d}.bin"


def _fill_next_file_index(device: str | None, fill_dir: str = MEM_FILL_DIR) -> int:
    """下一个可用分片序号（保留已有填充文件，追加写入）。"""
    d, legacy, _glob = _fill_paths(fill_dir)
    max_idx = -1
    r = run_adb(
        ["shell", f"ls -1 {d}/{MEM_FILL_PREFIX}_*.bin 2>/dev/null"],
        device,
        timeout=20.0,
    )
    for raw in (r.stdout or "").splitlines():
        name = raw.strip().rsplit("/", 1)[-1]
        if not name or "*" in name:
            continue
        m = re.search(rf"^{re.escape(MEM_FILL_PREFIX)}_(\d+)\.bin$", name)
        if not m:
            continue
        try:
            max_idx = max(max_idx, int(m.group(1)))
        except ValueError:
            continue
    if max_idx < 0 and _remote_file_bytes(device, legacy) > 0:
        return 0
    return max_idx + 1


def _clear_fill_files(device: str | None, fill_dir: str = MEM_FILL_DIR) -> None:
    d, legacy, _glob = _fill_paths(fill_dir)
    run_adb(
        [
            "shell",
            f"rm -f {legacy} {d}/{MEM_FILL_PREFIX}_*.bin; sync",
        ],
        device,
        timeout=120.0,
    )


def _fill_files_total_bytes(device: str | None, fill_dir: str = MEM_FILL_DIR) -> int:
    """单次 ls -l 汇总所有填充测试文件总大小（兼容旧单文件名）。"""
    d, legacy, _glob = _fill_paths(fill_dir)
    r = run_adb(
        ["shell", f"ls -l '{legacy}' {d}/{MEM_FILL_PREFIX}_*.bin 2>/dev/null"],
        device,
        timeout=20.0,
    )
    total = 0
    seen: set[str] = set()
    for raw in (r.stdout or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("total "):
            continue
        parts = line.split()
        if len(parts) < 5 or not parts[4].isdigit():
            continue
        name = parts[-1]
        if name in seen:
            continue
        seen.add(name)
        total += int(parts[4])
    return total


def _try_fallocate_part(
    device: str | None, part: str, size_bytes: int
) -> tuple[bool, str]:
    """尝试使用 fallocate 秒级分配真实磁盘块（非稀疏文件）。"""
    cmd = (
        f"fallocate -l {size_bytes} '{part}' 2>&1 && "
        f"stat -c '%b %B %s' '{part}' 2>/dev/null"
    )
    r = run_adb(["shell", cmd], device, timeout=30.0)
    out = ((r.stdout or "") + (r.stderr or "")).strip()
    if r.returncode != 0:
        run_adb(["shell", f"rm -f '{part}'"], device, timeout=10.0)
        return False, out
    last_line = out.splitlines()[-1].strip() if out else ""
    parts = last_line.split()
    if len(parts) == 3 and all(p.isdigit() for p in parts):
        blocks, blk_size, file_size = int(parts[0]), int(parts[1]), int(parts[2])
        alloc_bytes = blocks * (blk_size or 512)
        if file_size >= size_bytes and alloc_bytes >= int(size_bytes * 0.9):
            return True, out
    # 若 stat 不可用或分配为稀疏文件，清理后回退 dd
    run_adb(["shell", f"rm -f '{part}'"], device, timeout=10.0)
    return False, out


def _dd_part_with_progress(
    device: str | None,
    part: str,
    part_mb: int,
    is_stopped: object,
    on_tick: object,
) -> tuple[int, str, bool]:
    """使用 bs=4M 流式写入单个分片并定时回调进度，支持中断。"""
    blocks_4m = part_mb // 4
    rem_1m = part_mb % 4
    dd_cmds: list[str] = []
    if blocks_4m > 0:
        dd_cmds.append(f"dd if=/dev/zero of='{part}' bs=4M count={blocks_4m} 2>&1")
    if rem_1m > 0:
        if blocks_4m > 0:
            dd_cmds.append(
                f"dd if=/dev/zero of='{part}' bs=1M count={rem_1m} "
                f"seek={blocks_4m * 4} conv=notrunc 2>&1"
            )
        else:
            dd_cmds.append(f"dd if=/dev/zero of='{part}' bs=1M count={rem_1m} 2>&1")
    shell_cmd = " && ".join(dd_cmds)
    proc = subprocess.Popen(
        build_adb_cmd(["shell", shell_cmd], device),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=adb_subprocess_env(),
        **_subprocess_kwargs(),
    )
    out_chunks: list[bytes] = []
    err_chunks: list[bytes] = []

    def _drain(stream: object, target: list[bytes]) -> None:
        try:
            reader = getattr(stream, "read", None)
            if callable(reader):
                target.append(reader())
        except Exception:
            pass

    t_out = threading.Thread(target=_drain, args=(proc.stdout, out_chunks), daemon=True)
    t_err = threading.Thread(target=_drain, args=(proc.stderr, err_chunks), daemon=True)
    t_out.start()
    t_err.start()

    last_tick = time.monotonic()
    stopped = False
    while proc.poll() is None:
        if callable(is_stopped) and is_stopped():
            stopped = True
            kill_process_tree(proc)
            break
        now = time.monotonic()
        if callable(on_tick) and now - last_tick >= 0.45:
            on_tick()
            last_tick = now
        time.sleep(0.12)

    t_out.join(timeout=1.5)
    t_err.join(timeout=1.5)
    out = (
        decode_adb_bytes(b"".join(out_chunks)) + decode_adb_bytes(b"".join(err_chunks))
    ).strip()
    return (-1 if stopped else int(proc.returncode or 0)), out, stopped


def preview_fill_memory(
    device: str | None,
    *,
    fill_pct: int = 100,
    reserve_mb: int = MEM_FILL_RESERVE_MB,
    fill_dir: str | None = None,
) -> dict:
    """按所选路径所在分区的可用空间百分比估算填充目标。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    pct = max(1, min(100, int(fill_pct or 100)))
    reserve = max(0, int(reserve_mb or 0))
    d, _legacy, glob = _fill_paths(fill_dir)
    space = _df_space_kb(device, d)
    avail_kb = int(space.get("avail_kb") or 0)
    size_kb = int(space.get("size_kb") or 0)
    used_kb = int(space.get("used_kb") or 0)
    if avail_kb <= 0:
        raise RuntimeError(f"无法读取 {d} 所在分区的可用空间")
    reserve_kb = reserve * 1024
    usable_kb = max(0, avail_kb - reserve_kb)
    target_kb = (usable_kb * pct) // 100
    target_bytes = target_kb * 1024
    existing = _fill_files_total_bytes(device, d)
    parts = max(
        1, (max(target_kb // 1024, 1) + MEM_FILL_MAX_FILE_MB - 1) // MEM_FILL_MAX_FILE_MB
    )
    return {
        "path": glob,
        "fill_dir": d,
        "fill_pct": pct,
        "reserve_mb": reserve,
        "avail_kb": avail_kb,
        "avail_label": _format_capacity_bytes(avail_kb * 1024, decimals=1),
        "size_kb": size_kb,
        "size_label": _format_capacity_bytes(size_kb * 1024, decimals=1) if size_kb else "",
        "used_kb": used_kb,
        "used_label": _format_capacity_bytes(used_kb * 1024, decimals=1) if used_kb else "",
        "usable_kb": usable_kb,
        "usable_label": _format_capacity_bytes(usable_kb * 1024, decimals=1),
        "target_kb": target_kb,
        "target_bytes": target_bytes,
        "target_label": (
            _format_capacity_bytes(target_bytes, decimals=1) if target_bytes else "0 B"
        ),
        "existing_bytes": existing,
        "existing_label": (
            _format_capacity_bytes(existing, decimals=1) if existing else ""
        ),
        "parts_estimate": parts,
        "ok": target_kb >= 1024,
        "message": (
            (
                (f"已有 {_format_capacity_bytes(existing, decimals=1)}，" if existing else "")
                + f"剩余 {_format_capacity_bytes(avail_kb * 1024, decimals=1)}，"
                + f"将追加约 {_format_capacity_bytes(target_bytes, decimals=1)}"
            )
            if target_kb >= 1024
            else "剩余空间不足"
        ),
    }


def fill_device_memory(
    device: str | None,
    *,
    reserve_mb: int = MEM_FILL_RESERVE_MB,
    fill_pct: int = 100,
    fill_dir: str | None = None,
    stop_event: object | None = None,
    on_progress: object | None = None,
) -> dict:
    """按百分比填充所选路径所在分区的剩余空间；多文件分片以突破约 2GB 单文件限制。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    d, _legacy, glob = _fill_paths(fill_dir)
    run_adb(["shell", f"mkdir -p '{d}'"], device, timeout=15.0)
    preview = preview_fill_memory(
        device, fill_pct=fill_pct, reserve_mb=reserve_mb, fill_dir=d
    )
    if not preview.get("ok"):
        raise RuntimeError(str(preview.get("message") or "无法开始填充"))

    target_mb = int(preview["target_kb"]) // 1024
    if target_mb < 1:
        raise RuntimeError("目标过小")

    base_bytes = _fill_files_total_bytes(device, d)
    start_idx = _fill_next_file_index(device, d)

    written_mb = 0
    last_err = ""
    max_file = max(64, int(MEM_FILL_MAX_FILE_MB))
    use_fallocate: bool | None = None

    def _stopped() -> bool:
        if stop_event is None:
            return False
        is_set = getattr(stop_event, "is_set", None)
        return bool(is_set()) if callable(is_set) else False

    def _session_bytes() -> int:
        return max(0, _fill_files_total_bytes(device, d) - base_bytes)

    def _emit(state: str, message: str) -> None:
        if not callable(on_progress):
            return
        session = _session_bytes()
        total = base_bytes + session
        target_bytes = int(preview["target_bytes"])
        on_progress(
            {
                "state": state,
                "written_bytes": session,
                "written_label": (
                    _format_capacity_bytes(session, decimals=1) if session else "0 B"
                ),
                "target_bytes": target_bytes,
                "target_label": preview["target_label"],
                "pct": (
                    min(100, int(session * 100 / target_bytes)) if target_bytes else 0
                ),
                "message": message,
                "total_filled_bytes": total,
                "total_filled_label": (
                    _format_capacity_bytes(total, decimals=1) if total else ""
                ),
            }
        )

    def _stopped_result() -> dict:
        session = _session_bytes()
        total = base_bytes + session
        return {
            "ok": session > 0 or base_bytes > 0,
            "stopped": True,
            "path": glob,
            "fill_dir": d,
            "filled_bytes": total,
            "filled_label": (
                _format_capacity_bytes(total, decimals=1) if total else ""
            ),
            "session_bytes": session,
            "target_mb": target_mb,
            "target_bytes": int(preview["target_bytes"]),
            "fill_pct": int(preview["fill_pct"]),
            "reserve_mb": int(preview["reserve_mb"]),
            "avail_kb_before": int(preview["avail_kb"]),
            "avail_kb_after": _df_avail_kb(device, d),
            "message": (
                f"已停止，本次 {_format_capacity_bytes(session, decimals=1)}，"
                f"累计 {_format_capacity_bytes(total, decimals=1)}"
                if total
                else "已停止"
            ),
            "detail": last_err,
            "returncode": 0,
        }

    if base_bytes > 0:
        _emit(
            "running",
            f"保留已有 {_format_capacity_bytes(base_bytes, decimals=1)}，"
            f"继续写入约 {preview['target_label']}…",
        )
    else:
        _emit("running", "开始填充 eMMC…")
    while written_mb < target_mb:
        if _stopped():
            return _stopped_result()

        file_idx = start_idx + (written_mb // max_file)
        part = _fill_part_path(file_idx, d)
        part_mb = min(max_file, target_mb - written_mb)
        part_bytes = part_mb * 1024 * 1024

        if use_fallocate is not False:
            ok_falloc, falloc_out = _try_fallocate_part(device, part, part_bytes)
            if falloc_out:
                last_err = falloc_out[-400:]
            if ok_falloc:
                use_fallocate = True
                written_mb += part_mb
                session_now = _session_bytes()
                total_now = base_bytes + session_now
                _emit(
                    "running",
                    f"极速占位 {_format_capacity_bytes(session_now, decimals=1)}"
                    + (
                        f"（累计 {_format_capacity_bytes(total_now, decimals=1)}）"
                        if base_bytes > 0
                        else ""
                    )
                    + f" · 分片 {file_idx + 1}",
                )
                continue
            if falloc_out and _adb_output_denied(falloc_out):
                raise RuntimeError(f"无权限写入填充文件\n{falloc_out}")
            use_fallocate = False

        def _on_dd_tick() -> None:
            session_now = _session_bytes()
            total_now = base_bytes + session_now
            _emit(
                "running",
                f"本次 {_format_capacity_bytes(session_now, decimals=1)}"
                + (
                    f"（累计 {_format_capacity_bytes(total_now, decimals=1)}）"
                    if base_bytes > 0
                    else ""
                )
                + f" · 分片 {file_idx + 1}",
            )

        rc, out, was_stopped = _dd_part_with_progress(
            device, part, part_mb, _stopped, _on_dd_tick
        )
        if was_stopped:
            return _stopped_result()
        if out:
            last_err = out[-400:]
        if rc != 0 and _adb_output_denied(out):
            raise RuntimeError(f"无权限写入填充文件\n{out}")

        session_now = _session_bytes()
        expect_min = written_mb * 1024 * 1024
        if session_now <= expect_min and rc != 0:
            raise RuntimeError(last_err or "填充写入失败")
        written_mb = max(written_mb + part_mb, session_now // (1024 * 1024))
        _on_dd_tick()

    run_adb(["shell", "sync"], device, timeout=120.0)
    session = _session_bytes()
    filled = base_bytes + session
    avail_after = _df_avail_kb(device, d)
    ok = session > 0
    if ok and base_bytes > 0:
        msg = (
            f"已追加 {_format_capacity_bytes(session, decimals=1)}"
            f"（累计 {_format_capacity_bytes(filled, decimals=1)}，"
            f"本次为当时剩余的 {int(preview['fill_pct'])}%）"
        )
    elif ok:
        msg = (
            f"已填充 {_format_capacity_bytes(filled, decimals=1)}"
            f"（eMMC 剩余空间的 {int(preview['fill_pct'])}%）"
        )
    else:
        msg = "填充失败"
    _emit("done" if ok else "error", msg)
    return {
        "ok": ok,
        "stopped": False,
        "path": glob,
        "fill_dir": d,
        "filled_bytes": filled,
        "filled_label": _format_capacity_bytes(filled, decimals=1) if filled else "",
        "session_bytes": session,
        "target_mb": target_mb,
        "target_bytes": int(preview["target_bytes"]),
        "fill_pct": int(preview["fill_pct"]),
        "reserve_mb": int(preview["reserve_mb"]),
        "avail_kb_before": int(preview["avail_kb"]),
        "avail_kb_after": avail_after,
        "message": msg,
        "detail": last_err,
        "returncode": 0 if ok else 1,
    }


def release_device_memory(device: str | None, fill_dir: str | None = None) -> dict:
    """删除所选路径下的填充测试文件（含分片）。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    d, _legacy, glob = _fill_paths(fill_dir)
    before = _fill_files_total_bytes(device, d)
    _clear_fill_files(device, d)
    left = _fill_files_total_bytes(device, d)
    ok = left == 0
    freed_label = _format_capacity_bytes(before) if before else ""
    return {
        "ok": ok,
        "path": glob,
        "fill_dir": d,
        "freed_bytes": before if ok else max(0, before - left),
        "freed_label": freed_label,
        "message": (
            f"已释放 {freed_label}" if ok and before else ("已释放" if ok else "释放失败")
        ),
        "returncode": 0 if ok else 1,
    }
