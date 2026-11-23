#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ADB 诊断工具：logcat、bugreport、dumpsys、getprop 等。

包管理、远程文件系统、设备信息卡及存储填充已拆分为独立子模块（``pkg_ops``、``remote_fs``、``device_info``、``mem_fill``），
此处保持完整重导出以兼容所有现有调用方。
"""

from __future__ import annotations

import re
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable

from tools.adb_runtime import (
    _subprocess_kwargs,
    adb_available,
    adb_subprocess_env,
    build_adb_cmd,
    decode_adb_bytes,
    get_ready_devices,
    run_adb,
)
from tools.adb_tools.common import (
    AdbCommandResult,
    AdbShellResult,
    _adb_output_denied,
    format_adb_raw_output,
)
from tools.adb_tools.device_info import (
    BUILD_INFO_FIELDS,
    BuildInfoField,
    _CARD_SHELL,
    _adb_prop,
    _block_sectors_from_text,
    _ddr_from_meminfo,
    _ddr_size,
    _df_avail_kb,
    _df_row_used_kb,
    _df_space_kb,
    _disk_bytes_from_df,
    _disk_bytes_from_diskstats,
    _disk_bytes_from_partitions,
    _disk_used_bytes_from_df,
    _emmc_fields,
    _emmc_probe_bytes,
    _emmc_size,
    _format_capacity_bytes,
    _guess_device_ip,
    _ip_from_addr_text,
    _iter_df_k_rows,
    _parse_df_space_for_path,
    _parse_human_capacity_bytes,
    _parse_positive_int,
    _parse_wm_density,
    _parse_wm_size,
    _prop_lookup,
    _read_device_card_shell,
    _read_sysfs_sectors,
    _snap_flash_bytes,
    _split_card_sections,
    capture_build_project_info,
    capture_device_info,
    collect_device_card,
    read_device_properties,
)
from tools.adb_tools.mem_fill import (
    MEM_FILL_CHUNK_MB,
    MEM_FILL_DIR,
    MEM_FILL_GLOB,
    MEM_FILL_MAX_FILE_MB,
    MEM_FILL_PREFIX,
    MEM_FILL_REMOTE,
    MEM_FILL_RESERVE_MB,
    _clear_fill_files,
    _fill_files_total_bytes,
    _fill_next_file_index,
    _fill_part_path,
    _fill_paths,
    _remote_file_bytes,
    fill_device_memory,
    normalize_fill_dir,
    preview_fill_memory,
    release_device_memory,
)
from tools.adb_tools.pkg_ops import (
    _adb_install_succeeded,
    adb_clear_package,
    adb_export_package_apk,
    adb_force_stop_package,
    adb_foreground_app,
    adb_grant_all_package_permissions,
    adb_install_apk,
    adb_install_apks,
    adb_launch_package,
    adb_list_packages,
    adb_package_pids,
    adb_restart_package,
    adb_set_package_enabled,
    adb_set_package_permission,
    adb_uninstall_package,
    collect_apk_paths,
)
from tools.adb_tools.remote_fs import (
    REMOTE_PATH_PRESETS,
    RemoteEntry,
    _absorb_ls_output,
    _adb_ls_exists,
    _adb_rm_once,
    _canonicalize_remote_dir,
    _entry_name_from_ls_path,
    _list_all_entry_names,
    _list_dir_names_via_glob,
    _list_entries_via_ls_la,
    _listing_parent_dir,
    _normalize_remote_dir_for_listing,
    _parse_ls_la_line,
    _parse_size_token,
    _sdcard_path_aliases,
    _shell_quote_sh,
    adb_chmod,
    adb_copy,
    adb_create_file,
    adb_delete_path,
    adb_df_path,
    adb_find_remote,
    adb_md5_remote,
    adb_mkdir,
    adb_pull_file,
    adb_push_file,
    adb_read_remote_file,
    adb_rename,
    adb_stat,
    adb_write_remote_file,
    join_remote_path,
    list_remote_entries,
    open_folder,
    parent_remote_path,
)

LOG_LEVELS = ("V", "D", "I", "W", "E", "F", "S")
LOG_BUFFERS = ("默认", "main", "system", "kernel", "radio", "events", "crash", "all")


def _normalize_buffer(buffer: str) -> str:
    """GUI 选项 -> adb -b 参数；空串表示不指定 -b（与旧版 main 行为一致）。"""
    b = buffer.strip().lower()
    if not b or b in ("默认", "default"):
        return ""
    return b


def _logcat_args(
    buffer: str,
    *,
    dump: bool = False,
    verbose: str = "threadtime",
    tag: str = "",
    level: str = "",
    pid: str = "",
) -> list[str]:
    args = ["logcat"]
    buf = _normalize_buffer(buffer)
    if buf:
        args.extend(["-b", buf])
    if dump:
        args.append("-d")
    clean_pid = (pid or "").strip()
    if clean_pid and clean_pid.isdigit():
        args.append(f"--pid={clean_pid}")
    if verbose:
        args.extend(["-v", verbose])
    lvl = level.strip().upper()
    tags = [t for t in re.split(r"[\s,]+", tag.strip()) if t]
    if tags:
        # 仅显示指定 Tag；未写级别时默认 V（含 V/D/I/W/E/F）
        tag_lvl = lvl if lvl in LOG_LEVELS and lvl != "S" else "V"
        for t in tags:
            args.append(f"{t}:{tag_lvl}")
        args.append("*:S")
    elif lvl in LOG_LEVELS:
        args.append(f"*:{lvl}")
    return args


def list_devices() -> list[str]:
    return get_ready_devices()


_ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")


def strip_ansi(text: str) -> str:
    """去掉终端 ANSI 控制序列（颜色、光标等），便于阅读。"""
    if not text:
        return ""
    return _ANSI_ESCAPE_RE.sub("", text)


_ADB_SHELL_NOISE_LINES = frozenset(
    {
        "Remote PTY will not be allocated because stdin is not a terminal.",
        "Use multiple -t options to force remote PTY allocation.",
    }
)


def filter_adb_shell_noise(text: str) -> str:
    """去掉 adb 在管道模式下常见的 PTY 提示行。"""
    if not text:
        return ""
    out: list[str] = []
    for line in text.splitlines(keepends=True):
        if line.strip() in _ADB_SHELL_NOISE_LINES:
            continue
        out.append(line)
    return "".join(out)


_SHELL_PROMPT_LINE = re.compile(
    r"^\s*[\w@.\[\]-]+(?::[\w@./-]*)?/\s*[$#]\s*$"
)


def trim_shell_prompt_lines(text: str) -> str:
    """去掉首尾仅含 shell 提示符（如 ``HOST:/ $``）的行。"""
    if not text:
        return ""
    lines = text.splitlines(keepends=True)
    while lines:
        stripped = lines[-1].strip()
        if not stripped:
            lines.pop()
            continue
        if _SHELL_PROMPT_LINE.match(stripped):
            lines.pop()
            continue
        break
    while lines and not lines[0].strip():
        lines.pop(0)
    return "".join(lines)


def decode_adb_pipe_bytes(raw: bytes | None) -> str:
    """将 adb 管道原始字节解码为 str；复用统一 decode_adb_bytes。"""
    return decode_adb_bytes(raw)


def run_adb_shell(device: str | None, shell_line: str) -> AdbShellResult:
    """执行 ``adb shell <单行命令>``，捕获原始字节再解码（避免固定 UTF-8 replace 与 cmd 观感不一致）。"""
    line = shell_line.strip()
    if not line:
        raise ValueError("命令为空")
    if not adb_available():
        raise RuntimeError("未找到 adb（内置 platform-tools 不可用）")
    cmd = build_adb_cmd(["shell", line], device)
    r = subprocess.run(
        cmd,
        capture_output=True,
        env=adb_subprocess_env(),
        **_subprocess_kwargs(),
    )
    return AdbShellResult(
        returncode=r.returncode,
        stdout=decode_adb_pipe_bytes(r.stdout),
        stderr=decode_adb_pipe_bytes(r.stderr),
    )


def adb_root_device(device: str | None) -> str:
    """对目标设备执行 ``adb root`` 并等待在线。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    r = run_adb(["root"], device)
    out = format_adb_raw_output(r.stdout, r.stderr).strip()
    low = out.lower()
    if r.returncode != 0 or "cannot run as root" in low or "not allowed" in low:
        raise RuntimeError(out or "adb root 失败")
    w = run_adb(["wait-for-device"], device)
    if w.returncode != 0:
        msg = (w.stderr or w.stdout or "").strip()
        raise RuntimeError(msg or "wait-for-device 失败")
    return out + ("\n" if out else "")


def user_desktop_dir() -> Path:
    """解析本机桌面目录（兼容中文「桌面」、OneDrive Desktop）。"""
    home = Path.home()
    candidates: list[Path] = []

    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes

            CSIDL_DESKTOP = 0x00
            SHGFP_TYPE_CURRENT = 0
            buf = ctypes.create_unicode_buffer(wintypes.MAX_PATH)
            if ctypes.windll.shell32.SHGetFolderPathW(
                None, CSIDL_DESKTOP, None, SHGFP_TYPE_CURRENT, buf
            ) == 0 and buf.value:
                candidates.append(Path(buf.value))
        except Exception:
            pass
        try:
            import os

            userprofile = os.environ.get("USERPROFILE") or str(home)
            onedrive = os.environ.get("OneDrive") or os.environ.get("OneDriveConsumer")
            for base in (userprofile, onedrive):
                if not base:
                    continue
                p = Path(base)
                candidates.extend(
                    [
                        p / "Desktop",
                        p / "桌面",
                    ]
                )
        except Exception:
            pass

    candidates.extend(
        [
            home / "Desktop",
            home / "桌面",
        ]
    )

    seen: set[str] = set()
    for cand in candidates:
        try:
            key = str(cand.resolve()) if cand.exists() else str(cand)
        except OSError:
            key = str(cand)
        if key in seen:
            continue
        seen.add(key)
        try:
            if cand.is_dir():
                return cand.resolve()
        except OSError:
            continue

    fallback = home / "Desktop"
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback.resolve()


def default_output_dir(tool: str) -> Path:
    """工具输出目录：userdata/output/<tool>/…"""
    from tools.bundled_paths import output_dir

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = output_dir(tool) / ts
    path.mkdir(parents=True, exist_ok=True)
    return path


def default_log_base_dir() -> Path:
    """日志抓取默认根目录（userdata/logs/adb，每次抓取在其下建子目录）。"""
    from tools.bundled_paths import logs_dir

    return logs_dir("adb")


def _safe_device_slug(device: str | None) -> str:
    raw = (device or "device").strip() or "device"
    slug = re.sub(r'[<>:"/\\|?*\s]+', "_", raw)
    return slug[:48] or "device"


def new_capture_session_dir(base: Path, device: str | None = None) -> Path:
    """在根目录下创建带时间戳的子目录，避免多次抓取互相覆盖。"""
    root = Path(base)
    root.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    slug = _safe_device_slug(device)
    session = root / f"{ts}_{slug}"
    if not session.exists():
        session.mkdir(parents=True, exist_ok=True)
        return session.resolve()
    n = 2
    while True:
        candidate = root / f"{ts}_{slug}_{n}"
        if not candidate.exists():
            candidate.mkdir(parents=True, exist_ok=True)
            return candidate.resolve()
        n += 1


def _adb_cmd(args: list[str], device: str | None) -> list[str]:
    return build_adb_cmd(args, device)


def clear_logcat(device: str | None, *, buffer: str = "") -> None:
    if not adb_available():
        raise RuntimeError("未找到 adb")
    args = _logcat_args(buffer, dump=False, verbose="")
    args.append("-c")
    r = run_adb(args, device)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or "").strip() or "清空 logcat 失败")


def dump_logcat(
    device: str | None,
    out_path: Path,
    *,
    buffer: str = "",
    tag: str = "",
    level: str = "",
    pid: str = "",
    timeout: float = 60.0,
) -> Path:
    """抓取当前缓冲区 logcat 到文件（adb logcat -d）。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    args = _logcat_args(buffer, dump=True, tag=tag, level=level, pid=pid)
    cmd = _adb_cmd(args, device)
    try:
        r = subprocess.run(
            cmd,
            capture_output=True,
            timeout=timeout,
            env=adb_subprocess_env(),
            **_subprocess_kwargs(),
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"抓取 logcat -d 超时（已超过 {int(timeout)} 秒）") from exc
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    if r.returncode != 0:
        err = (r.stderr or b"").decode("utf-8", errors="replace").strip()
        raise RuntimeError(err or "logcat -d 失败")
    out.write_bytes(r.stdout)
    return out.resolve()


class LogcatSession:
    """持续抓取 logcat 到文件，支持按大小切分、打标记并回调每行用于界面预览。"""

    def __init__(
        self,
        device: str | None,
        out_path: Path,
        *,
        buffer: str = "",
        tag: str = "",
        level: str = "",
        pid: str = "",
        rotate_mb: float = 0.0,
        on_line: Callable[[str], None] | None = None,
        on_exit: Callable[[bool, str], None] | None = None,
        on_rotate: Callable[[Path], None] | None = None,
    ) -> None:
        self._device = device
        self._base_out_path = Path(out_path)
        self._out_path = Path(out_path)
        self._buffer = buffer
        self._tag = tag.strip()
        self._level = level.strip().upper() if level else ""
        self._pid = (pid or "").strip()
        self._rotate_bytes = max(0, int(float(rotate_mb or 0.0) * 1024 * 1024))
        self._part_idx = 1
        self._bytes_written = 0
        self._file_handle: Any = None
        self._write_lock = threading.Lock()
        self._on_line = on_line
        self._on_exit = on_exit
        self._on_rotate = on_rotate
        self._stop = threading.Event()
        self._proc: subprocess.Popen[bytes] | None = None
        self._thread: threading.Thread | None = None

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def _next_part_path(self, part: int) -> Path:
        base = self._base_out_path
        return base.with_name(f"{base.stem}_part{part}{base.suffix}")

    def _rotate_if_needed(self) -> None:
        if self._rotate_bytes <= 0 or self._bytes_written < self._rotate_bytes:
            return
        if self._file_handle is not None:
            try:
                self._file_handle.flush()
                self._file_handle.close()
            except Exception:
                pass
        self._part_idx += 1
        next_path = self._next_part_path(self._part_idx).resolve()
        self._out_path = next_path
        self._file_handle = next_path.open("ab")
        self._bytes_written = 0
        rot_cb = self._on_rotate
        if rot_cb is not None and not self._stop.is_set():
            try:
                rot_cb(next_path)
            except Exception:
                pass

    def append_mark(self, note: str = "") -> str:
        """向实时流和当前日志文件同步插入带时间戳的标记分割线。"""
        ts = datetime.now().strftime("%H:%M:%S")
        clean_note = " ".join((note or "").split()).strip()
        label = f"[MARK {ts}] {clean_note}" if clean_note else f"[MARK {ts}] 手动标记"
        line = f"==================== {label} ===================="
        raw = (line + "\n").encode("utf-8")
        with self._write_lock:
            fh = self._file_handle
            if fh is not None and not fh.closed:
                fh.write(raw)
                fh.flush()
                self._bytes_written += len(raw)
                self._rotate_if_needed()
        cb = self._on_line
        if cb is not None and not self._stop.is_set():
            cb(line)
        return line

    def start(self) -> Path:
        if self.running:
            raise RuntimeError("logcat 已在抓取中")
        if not adb_available():
            raise RuntimeError("未找到 adb")
        self._out_path.parent.mkdir(parents=True, exist_ok=True)
        args = _logcat_args(
            self._buffer,
            dump=False,
            tag=self._tag,
            level=self._level,
            pid=self._pid,
        )
        cmd = _adb_cmd(args, self._device)
        self._proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=adb_subprocess_env(),
            **_subprocess_kwargs(),
        )
        self._stop.clear()
        self._bytes_written = 0
        self._part_idx = 1

        def reader() -> None:
            assert self._proc is not None and self._proc.stdout is not None
            lines_since_flush = 0
            last_flush = time.monotonic()
            unexpected = False
            detail = ""
            with self._write_lock:
                self._file_handle = self._out_path.open("ab")
            try:
                while not self._stop.is_set():
                    line = self._proc.stdout.readline()
                    if not line:
                        unexpected = not self._stop.is_set()
                        break
                    try:
                        text = line.decode("utf-8", errors="replace")
                    except Exception:
                        text = str(line)
                    now = time.monotonic()
                    lines_since_flush += 1
                    do_flush = lines_since_flush >= 64 or now - last_flush >= 0.25
                    with self._write_lock:
                        fh = self._file_handle
                        if fh is not None and not fh.closed:
                            fh.write(line)
                            self._bytes_written += len(line)
                            if do_flush:
                                fh.flush()
                                lines_since_flush = 0
                                last_flush = now
                            self._rotate_if_needed()
                    cb = self._on_line
                    if cb is not None and not self._stop.is_set():
                        cb(text.rstrip("\n\r"))
                with self._write_lock:
                    if self._file_handle is not None and not self._file_handle.closed:
                        self._file_handle.flush()
            finally:
                with self._write_lock:
                    if self._file_handle is not None:
                        try:
                            self._file_handle.close()
                        except Exception:
                            pass
                        self._file_handle = None
                if unexpected:
                    proc = self._proc
                    err = ""
                    if proc is not None and proc.stderr is not None:
                        try:
                            err = (
                                proc.stderr.read(400)
                                .decode("utf-8", errors="replace")
                                .strip()
                            )
                        except Exception:
                            err = ""
                    detail = err or "logcat 进程已结束（设备可能断开）"
                exit_cb = self._on_exit
                if exit_cb is not None:
                    try:
                        exit_cb(unexpected, detail)
                    except Exception:
                        pass

        self._thread = threading.Thread(target=reader, daemon=True)
        self._thread.start()
        return self._out_path.resolve()

    def stop(self) -> None:
        """立刻停预览回调并结束 adb logcat 进程。"""
        self._stop.set()
        self._on_line = None
        proc = self._proc
        self._proc = None
        if proc is not None:
            for pipe in (proc.stdout, proc.stderr):
                if pipe is None:
                    continue
                try:
                    pipe.close()
                except Exception:
                    pass
            try:
                proc.kill()
            except Exception:
                try:
                    proc.terminate()
                except Exception:
                    pass
            try:
                proc.wait(timeout=2)
            except Exception:
                pass
        if self._thread is not None:
            self._thread.join(timeout=2)
            self._thread = None
        self._on_exit = None


def capture_bugreport(
    device: str | None, out_path: Path, *, timeout: float = 600.0
) -> Path:
    """生成 bugreport（耗时较长，可能数分钟，默认 600 秒超时上限防止设备挂死）。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    out = Path(out_path)
    if out.suffix.lower() not in (".zip", ".txt"):
        out = out.with_suffix(".zip")
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = _adb_cmd(["bugreport", str(out)], device)
    try:
        r = subprocess.run(
            cmd,
            capture_output=True,
            timeout=timeout,
            env=adb_subprocess_env(),
            **_subprocess_kwargs(),
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"生成 bugreport 超时（已超过 {int(timeout)} 秒）") from exc
    if r.returncode != 0:
        err = (r.stderr or r.stdout or b"").decode("utf-8", errors="replace").strip()
        raise RuntimeError(err or "bugreport 失败")
    if not out.is_file():
        raise RuntimeError(f"未生成文件: {out}")
    return out.resolve()


def capture_bugreport_with_progress(
    device: str | None,
    out_path: Path,
    on_progress: Callable[[dict], None] | None = None,
    cancel_event: threading.Event | None = None,
    *,
    timeout: float = 600.0,
) -> Path:
    """流式生成 bugreport：回调耗时、文件大小与阶段信息，支持取消。"""
    import re
    import time
    from tools.adb_runtime import decode_adb_bytes, kill_process_tree

    if not adb_available():
        raise RuntimeError("未找到 adb")
    out = Path(out_path)
    if out.suffix.lower() not in (".zip", ".txt"):
        out = out.with_suffix(".zip")
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = _adb_cmd(["bugreport", str(out)], device)
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=adb_subprocess_env(),
        **_subprocess_kwargs(),
    )
    out_chunks: list[bytes] = []
    err_chunks: list[bytes] = []
    pct_lock = threading.Lock()
    state: dict[str, int | None] = {"percent": None}
    pct_re = re.compile(r"\[\s*(\d{1,3})%\]")

    def _drain(stream, target: list[bytes]) -> None:
        try:
            if stream is None:
                return
            while True:
                chunk = stream.read(512)
                if not chunk:
                    break
                target.append(chunk)
                txt = decode_adb_bytes(chunk)
                m = pct_re.findall(txt)
                if m:
                    val = max(0, min(99, int(m[-1])))
                    with pct_lock:
                        state["percent"] = val
        except Exception:
            pass

    t_out = threading.Thread(target=_drain, args=(proc.stdout, out_chunks), daemon=True)
    t_err = threading.Thread(target=_drain, args=(proc.stderr, err_chunks), daemon=True)
    t_out.start()
    t_err.start()

    started_at = time.monotonic()
    last_emit = 0.0
    cancelled = False
    timed_out = False

    if on_progress is not None:
        on_progress({"type": "start", "elapsed_sec": 0, "size_bytes": 0, "percent": None})

    while proc.poll() is None:
        if cancel_event is not None and cancel_event.is_set():
            cancelled = True
            kill_process_tree(proc)
            break
        now = time.monotonic()
        elapsed = now - started_at
        if elapsed >= timeout:
            timed_out = True
            kill_process_tree(proc)
            break
        if on_progress is not None and now - last_emit >= 0.45:
            size_bytes = 0
            try:
                if out.is_file():
                    size_bytes = out.stat().st_size
            except OSError:
                size_bytes = 0
            with pct_lock:
                pct = state["percent"]
            on_progress(
                {
                    "type": "progress",
                    "elapsed_sec": int(elapsed),
                    "size_bytes": size_bytes,
                    "percent": pct,
                    "stage": "pull" if size_bytes > 0 else "collect",
                }
            )
            last_emit = now
        time.sleep(0.15)

    t_out.join(timeout=1.5)
    t_err.join(timeout=1.5)
    if cancelled:
        try:
            if out.is_file():
                out.unlink()
        except OSError:
            pass
        raise RuntimeError("已取消生成 bugreport")
    if timed_out:
        raise RuntimeError(f"生成 bugreport 超时（已超过 {int(timeout)} 秒）")
    if proc.returncode != 0:
        err = decode_adb_bytes(b"".join(err_chunks) or b"".join(out_chunks)).strip()
        raise RuntimeError(err or "bugreport 失败")
    if not out.is_file():
        raise RuntimeError(f"未生成文件: {out}")
    return out.resolve()


def capture_dumpsys(
    device: str | None, service: str, out_path: Path, *, timeout: float = 60.0
) -> Path:
    if not adb_available():
        raise RuntimeError("未找到 adb")
    svc = service.strip() or "activity"
    try:
        r = run_adb(["shell", "dumpsys", svc], device, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"dumpsys {svc} 超时（已超过 {int(timeout)} 秒）") from exc
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or "").strip() or "dumpsys 失败")
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(r.stdout or "", encoding="utf-8", errors="replace")
    return out.resolve()


def collect_crash_artifacts(
    device: str | None,
    session_dir: Path,
) -> dict[str, object]:
    """一键收集 crash buffer、ANR、tombstones、activity/meminfo 与系统属性。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = (Path(session_dir) / f"crash_{ts}").resolve()
    dest.mkdir(parents=True, exist_ok=True)
    saved_files: list[str] = []
    notes: list[str] = []

    try:
        crash_log = dump_logcat(device, dest / "logcat_crash.txt", buffer="crash", timeout=30.0)
        saved_files.append(str(crash_log))
    except Exception as exc:
        notes.append(f"crash logcat: {exc}")

    for svc in ("activity", "meminfo"):
        try:
            p = capture_dumpsys(device, svc, dest / f"dumpsys_{svc}.txt", timeout=30.0)
            saved_files.append(str(p))
        except Exception as exc:
            notes.append(f"dumpsys {svc}: {exc}")

    try:
        r_prop = run_adb(["shell", "getprop"], device, timeout=20.0)
        if r_prop.returncode == 0:
            p_prop = (dest / "getprop.txt").resolve()
            p_prop.write_text(r_prop.stdout or "", encoding="utf-8", errors="replace")
            saved_files.append(str(p_prop))
    except Exception as exc:
        notes.append(f"getprop: {exc}")

    for remote_dir, local_name in (("/data/anr", "anr"), ("/data/tombstones", "tombstones")):
        local_sub = dest / local_name
        try:
            r_pull = run_adb(["pull", remote_dir, str(local_sub)], device, timeout=45.0)
            out_msg = format_adb_raw_output(r_pull.stdout, r_pull.stderr).strip()
            if r_pull.returncode == 0 and local_sub.exists():
                pulled = [str(f.resolve()) for f in local_sub.rglob("*") if f.is_file()]
                saved_files.extend(pulled)
                notes.append(f"{remote_dir}: 已拉取 {len(pulled)} 个文件")
            else:
                notes.append(f"{remote_dir}: {out_msg or '无文件或无权限（可先 adb root）'}")
        except Exception as exc:
            notes.append(f"{remote_dir}: {exc}")

    return {
        "ok": bool(saved_files),
        "dir": str(dest),
        "files": saved_files,
        "count": len(saved_files),
        "notes": notes,
    }


@dataclass(frozen=True)
class UiNode:
    """uiautomator dump 中的一个控件节点（扁平化，带层级深度）。"""

    depth: int
    index: str
    text: str
    resource_id: str
    cls: str
    content_desc: str
    package: str
    bounds: str
    clickable: bool
    focused: bool
    attrs: dict[str, str]

    @property
    def label(self) -> str:
        """用于列表首列展示：优先 text，其次 content-desc。"""
        return self.text or self.content_desc or ""


def _ui_dump_error_hint(raw: str) -> str:
    low = (raw or "").lower()
    if "could not get idle state" in low:
        return (
            (raw.strip() + "\n\n") if raw.strip() else ""
        ) + "提示：界面存在持续动画/刷新，uiautomator 取不到静止状态。请等界面静止（如暂停视频、停在静态页面）后重试。"
    if "null root node" in low:
        return (
            (raw.strip() + "\n\n") if raw.strip() else ""
        ) + "提示：当前窗口未开放无障碍节点（安全键盘 / DRM 视频 / 部分系统弹窗）。请切到普通界面后重试。"
    if "permission" in low or "denied" in low:
        return (
            (raw.strip() + "\n\n") if raw.strip() else ""
        ) + "提示：无权限执行 uiautomator。可尝试勾选 root 或改用有调试权限的设备。"
    return raw.strip() or "uiautomator dump 失败"


def dump_ui_hierarchy(device: str | None, out_path: Path) -> tuple[Path, str]:
    """dump 当前界面控件层级（uiautomator），pull 到本地并返回 (路径, XML 文本)。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    remote = "/sdcard/window_dump.xml"
    run_adb(["shell", "rm", "-f", remote], device)
    r = run_adb(["shell", "uiautomator", "dump", remote], device, timeout=40.0)
    combined = ((r.stdout or "") + "\n" + (r.stderr or "")).strip()
    if "dumped to" not in combined.lower():
        r2 = run_adb(["shell", "uiautomator", "dump"], device, timeout=40.0)
        combined = ((r2.stdout or "") + "\n" + (r2.stderr or "")).strip()
        if "dumped to" not in combined.lower():
            raise RuntimeError(_ui_dump_error_hint(combined))

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    pr = run_adb(["pull", remote, str(out)], device, timeout=40.0)
    if pr.returncode != 0 or not out.is_file():
        raise RuntimeError((pr.stderr or pr.stdout or "").strip() or "pull UI dump 失败")
    xml = out.read_text(encoding="utf-8", errors="replace")
    if not xml.strip():
        raise RuntimeError("UI dump 内容为空，当前界面可能不支持 uiautomator")
    return out.resolve(), xml


def parse_ui_nodes(xml_text: str) -> list[UiNode]:
    """把 uiautomator dump 的 XML 解析为扁平控件列表。"""
    import xml.etree.ElementTree as ET

    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        raise RuntimeError(f"解析 UI XML 失败: {e}") from e

    nodes: list[UiNode] = []

    def walk(elem, depth: int) -> None:
        for child in elem:
            if child.tag == "node":
                a = child.attrib
                nodes.append(
                    UiNode(
                        depth=depth,
                        index=a.get("index", ""),
                        text=a.get("text", ""),
                        resource_id=a.get("resource-id", ""),
                        cls=a.get("class", ""),
                        content_desc=a.get("content-desc", ""),
                        package=a.get("package", ""),
                        bounds=a.get("bounds", ""),
                        clickable=a.get("clickable", "") == "true",
                        focused=a.get("focused", "") == "true",
                        attrs=dict(a),
                    )
                )
                walk(child, depth + 1)
            else:
                walk(child, depth)

    walk(root, 0)
    return nodes


def capture_getprop(
    device: str | None, out_path: Path, *, timeout: float = 30.0
) -> Path:
    if not adb_available():
        raise RuntimeError("未找到 adb")
    try:
        r = run_adb(["shell", "getprop"], device, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"getprop 超时（已超过 {int(timeout)} 秒）") from exc
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or "").strip() or "getprop 失败")
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(r.stdout or "", encoding="utf-8", errors="replace")
    return out.resolve()


def collect_crash_artifacts(
    device: str | None,
    session_dir: Path,
) -> dict[str, object]:
    """一键收集 crash buffer、ANR、tombstones、activity/meminfo 与系统属性。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = (Path(session_dir) / f"crash_{ts}").resolve()
    dest.mkdir(parents=True, exist_ok=True)
    saved_files: list[str] = []
    notes: list[str] = []

    try:
        crash_log = dump_logcat(device, dest / "logcat_crash.txt", buffer="crash", timeout=30.0)
        saved_files.append(str(crash_log))
    except Exception as exc:
        notes.append(f"crash logcat: {exc}")

    for svc in ("activity", "meminfo"):
        try:
            p = capture_dumpsys(device, svc, dest / f"dumpsys_{svc}.txt", timeout=30.0)
            saved_files.append(str(p))
        except Exception as exc:
            notes.append(f"dumpsys {svc}: {exc}")

    try:
        r_prop = run_adb(["shell", "getprop"], device, timeout=20.0)
        if r_prop.returncode == 0:
            p_prop = (dest / "getprop.txt").resolve()
            p_prop.write_text(r_prop.stdout or "", encoding="utf-8", errors="replace")
            saved_files.append(str(p_prop))
    except Exception as exc:
        notes.append(f"getprop: {exc}")

    for remote_dir, local_name in (("/data/anr", "anr"), ("/data/tombstones", "tombstones")):
        local_sub = dest / local_name
        try:
            r_pull = run_adb(["pull", remote_dir, str(local_sub)], device, timeout=45.0)
            out_msg = format_adb_raw_output(r_pull.stdout, r_pull.stderr).strip()
            if r_pull.returncode == 0 and local_sub.exists():
                pulled = [str(f.resolve()) for f in local_sub.rglob("*") if f.is_file()]
                saved_files.extend(pulled)
                notes.append(f"{remote_dir}: 已拉取 {len(pulled)} 个文件")
            else:
                notes.append(f"{remote_dir}: {out_msg or '无文件或无权限（可先 adb root）'}")
        except Exception as exc:
            notes.append(f"{remote_dir}: {exc}")

    return {
        "ok": bool(saved_files),
        "dir": str(dest),
        "files": saved_files,
        "count": len(saved_files),
        "notes": notes,
    }
