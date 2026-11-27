#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""OTA 产线自动化升级 v5（逻辑移植自 ota_upgrade_v5.exe / ota_upgrade_v5.py）。"""

from __future__ import annotations

import configparser
import datetime as dt
import logging
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from tools.adb_runtime import _decode_adb_bytes, _subprocess_kwargs, adb_subprocess_env, build_adb_cmd, resolve_adb_exe
# _subprocess_kwargs imported from tools.adb_runtime

LogFn = Callable[[str], None]

_SUCCESS_MARKERS = (
    "UPDATE_STATUS_UPDATED_NEED_REBOOT",
    "Current update state: UPDATED_NEED_REBOOT",
    "Update successfully applied",
    "kSuccess",
    "Update completed successfully",
)
_ALREADY_LATEST_MARKERS = (
    "already on this build",
    "Update already applied",
)
_BUSY_MARKERS = (
    "reset not allowed",
    "ongoing update",
    "already processing",
    "cancel the ongoing",
    "cancel it first",
)
_BOOT_STABLE_SEC = 10
_BOOT_TIMEOUT_SEC = 600


def _decode_output(raw: bytes | str | None) -> str:
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw
    return _decode_adb_bytes(raw)


def _run_adb_argv(
    adb_exe: str,
    argv: list[str],
    *,
    timeout: float | None = None,
    log: LogFn | None = None,
) -> subprocess.CompletedProcess[bytes]:
    cmd = [adb_exe, *argv]
    if log:
        log(f"INFO 执行ADB: {' '.join(cmd)}")
    try:
        return subprocess.run(
            cmd,
            capture_output=True,
            text=False,
            timeout=timeout,
            env=adb_subprocess_env(),
            **_subprocess_kwargs(),
        )
    except subprocess.TimeoutExpired as exc:
        if log:
            log(f"ERROR ADB命令超时: {' '.join(cmd)}")
        raise exc


def _terminate_process(proc: subprocess.Popen | None) -> None:
    if proc is None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def _sleep_until_deadline(
    total_sec: float,
    chunk_sec: float,
    *,
    stop: threading.Event | None = None,
) -> bool:
    """在 total_sec 内分块睡眠；stop 置位或超时返回 False，正常睡满返回 True。"""
    deadline = time.monotonic() + total_sec
    while time.monotonic() < deadline:
        if stop and stop.is_set():
            return False
        remain = deadline - time.monotonic()
        time.sleep(min(chunk_sec, max(0.0, remain)))
    return not (stop and stop.is_set())


@dataclass
class OtaV5Config:
    device_sn: str
    ota_file_path: Path
    upgrade_count: int = 500
    retry_limit: int = 3
    max_run_minutes: int = 1440
    timeout_minutes: int = 10
    round_interval_minutes: int = 10
    log_level: str = "INFO"
    engine_idle_wait_seconds: int = 900
    engine_status_poll_seconds: int = 3
    try_cancel_before_apply: bool = True
    engine_client_timeout_seconds: int = 120

    @property
    def update_timeout_seconds(self) -> float | None:
        if self.timeout_minutes <= 0:
            return None
        return float(self.timeout_minutes * 60)


def load_ota_v5_config(path: Path, base_dir: Path) -> OtaV5Config:
    parser = configparser.ConfigParser()
    parser.read(path, encoding="utf-8")

    def sec(name: str) -> configparser.SectionProxy:
        if name in parser:
            return parser[name]
        return parser["SETTING"] if "SETTING" in parser else {}

    def get_str(section: str, key: str, default: str = "") -> str:
        s = sec(section)
        return str(s.get(key, default)).split(";")[0].strip()

    def parse_int(section: str, key: str, default: int) -> int:
        raw = get_str(section, key, str(default))
        try:
            return int(raw)
        except ValueError:
            return default

    def parse_bool(section: str, key: str, default: bool) -> bool:
        raw = get_str(section, key, "true" if default else "false").lower()
        if raw in ("1", "true", "yes", "on"):
            return True
        if raw in ("0", "false", "no", "off"):
            return False
        return default

    # 兼容原版 config.ini 分段与 toolbox [SETTING] 扁平键
    device_sn = get_str("DEVICE", "device_sn") or get_str("SETTING", "sn")
    ota_raw = get_str("OTA", "ota_file_path") or get_str("SETTING", "ota_file_path")
    ota_path = Path(ota_raw) if ota_raw else Path("vendor/ota/ota_package.zip")
    if not ota_path.is_absolute():
        from tools.bundled_paths import resolve_bundle_path

        found = resolve_bundle_path(*ota_path.parts)
        ota_path = found if found is not None else (base_dir / ota_path).resolve()

    test = "TEST" if "TEST" in parser else "SETTING"
    adv = "ADVANCED" if "ADVANCED" in parser else "SETTING"

    return OtaV5Config(
        device_sn=device_sn,
        ota_file_path=ota_path,
        upgrade_count=parse_int(test, "upgrade_count", 500),
        retry_limit=parse_int(test, "retry_limit", 3),
        max_run_minutes=parse_int(test, "max_run_minutes", 1440),
        timeout_minutes=parse_int(test, "timeout_minutes", 10),
        round_interval_minutes=parse_int(test, "round_interval_minutes", 10),
        log_level=get_str(adv, "log_level", "INFO") or "INFO",
        engine_idle_wait_seconds=parse_int(adv, "engine_idle_wait_seconds", 900),
        engine_status_poll_seconds=parse_int(adv, "engine_status_poll_seconds", 3),
        try_cancel_before_apply=parse_bool(adv, "try_cancel_before_apply", True),
        engine_client_timeout_seconds=parse_int(adv, "engine_client_timeout_seconds", 120),
    )


def write_ota_v5_config(path: Path, cfg: OtaV5Config, *, path_for_ini: str) -> None:
    parser = configparser.ConfigParser()
    parser["SETTING"] = {
        "sn": cfg.device_sn,
        "ota_file_path": path_for_ini,
        "upgrade_count": str(cfg.upgrade_count),
        "retry_limit": str(cfg.retry_limit),
        "max_run_minutes": str(cfg.max_run_minutes),
        "timeout_minutes": str(cfg.timeout_minutes),
        "round_interval_minutes": str(cfg.round_interval_minutes),
        "log_level": cfg.log_level,
        "engine_idle_wait_seconds": str(cfg.engine_idle_wait_seconds),
        "engine_status_poll_seconds": str(cfg.engine_status_poll_seconds),
        "try_cancel_before_apply": "true" if cfg.try_cancel_before_apply else "false",
        "engine_client_timeout_seconds": str(cfg.engine_client_timeout_seconds),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        parser.write(f)


def is_tcp_serial(sn: str) -> bool:
    """判断序列号是否为网络 ADB 地址（host:port）。"""
    s = (sn or "").strip()
    if ":" not in s:
        return False
    host, _, port = s.rpartition(":")
    return bool(host) and port.isdigit()


def reconnect_adb(sn: str, adb_exe: str) -> None:
    """网络 ADB 自动 connect，USB ADB 尝试重置 offline 连接。"""
    target = (sn or "").strip()
    try:
        if is_tcp_serial(target):
            _run_adb_argv(adb_exe, ["connect", target], timeout=8, log=None)
        else:
            _run_adb_argv(adb_exe, ["reconnect", "offline"], timeout=5, log=None)
    except Exception:
        pass


def wait_for_boot(
    sn: str,
    adb_exe: str,
    *,
    timeout: int = _BOOT_TIMEOUT_SEC,
    log: LogFn,
    stop: threading.Event | None = None,
) -> bool:
    log(f"INFO 等待设备 {sn or '(默认)'} 开机...")
    start = time.monotonic()
    argv_prefix: list[str] = []
    if sn:
        argv_prefix = ["-s", sn]
    attempt = 0
    while time.monotonic() - start < timeout:
        if stop and stop.is_set():
            return False
        attempt += 1
        try:
            proc = _run_adb_argv(
                adb_exe,
                [*argv_prefix, "shell", "getprop", "sys.boot_completed"],
                timeout=30,
                log=None,
            )
            out = _decode_output(proc.stdout).strip()
            if out.endswith("1"):
                log("INFO 设备已启动，等待系统稳定...")
                if not _sleep_until_deadline(_BOOT_STABLE_SEC, 1.0, stop=stop):
                    return False
                return True
            if proc.returncode != 0 and (is_tcp_serial(sn) or attempt % 2 == 0):
                reconnect_adb(sn, adb_exe)
        except Exception as exc:
            log(f"WARNING 检查设备状态异常: {exc}")
            reconnect_adb(sn, adb_exe)
        elapsed = int(time.monotonic() - start)
        log(f"INFO 等待设备启动... {elapsed}秒")
        if not _sleep_until_deadline(5.0, 1.0, stop=stop):
            return False
    log(f"ERROR 设备启动超时 ({timeout}秒)")
    return False


class OtaUpgradeRunner:
    """单设备 OTA 循环升级（与原版 OtaUpdate + main 流程一致）。"""

    def __init__(
        self,
        cfg: OtaV5Config,
        *,
        base_dir: Path,
        log: LogFn,
        stop: threading.Event | None = None,
        on_progress=None,
    ) -> None:
        self.cfg = cfg
        self.base_dir = base_dir
        self.log = log
        self.stop = stop or threading.Event()
        self.on_progress = on_progress
        self.adb_exe = resolve_adb_exe() or "adb"
        self.device_sn = cfg.device_sn.strip()

        self.FILE_HASH = ""
        self.FILE_SIZE = "0"
        self.METADATA_HASH = ""
        self.METADATA_SIZE = "0"
        self.offset = "0"
        self.payload_bin_size = "0"
        self.payload = ""
        self.payload_properties = ""
        self.remote_ota_dir = "/data/ota_package"
        self._read_ota_zip_message()

    def _emit_progress(self, current: int, total: int, text: str = "") -> None:
        if self.on_progress is None:
            return
        try:
            self.on_progress(current, total, text or f"{current}/{total}")
        except Exception:
            pass

    def _adb(self, args: list[str], *, timeout: float | None = None) -> subprocess.CompletedProcess:
        argv: list[str] = []
        if self.device_sn:
            argv.extend(["-s", self.device_sn])
        argv.extend(args)
        try:
            proc = _run_adb_argv(self.adb_exe, argv, timeout=timeout, log=None)
            return proc
        except subprocess.TimeoutExpired:
            raise
        except Exception as exc:
            self.log(f"ERROR 执行ADB失败: {exc}")
            raise

    def _get_val(self, txt: bytes | str, key: str) -> str:
        if isinstance(txt, str):
            data = txt.encode("latin-1")
        else:
            data = txt
        search_key = (key + "=").encode("utf-8")
        key_index = data.find(search_key)
        if key_index == -1:
            return ""
        value_start = key_index + len(search_key)
        line_end = data.find(b"\n", value_start)
        if line_end == -1:
            line_end = len(data)
        value_bytes = data[value_start:line_end].rstrip(b"\r")
        try:
            return value_bytes.decode("utf-8").strip()
        except UnicodeDecodeError:
            try:
                return value_bytes.decode("latin-1").strip()
            except UnicodeDecodeError:
                return ""

    def _read_ota_zip_message(self) -> None:
        path = self.cfg.ota_file_path
        self.log(f"INFO 开始解析OTA包: {path}")
        if not path.is_file():
            raise FileNotFoundError(f"OTA文件不存在: {path}")
        if not zipfile.is_zipfile(path):
            raise ValueError(f"文件不是有效的ZIP包: {path}")

        self.FILE_HASH = ""
        self.FILE_SIZE = "0"
        self.METADATA_HASH = ""
        self.METADATA_SIZE = "0"
        self.offset = "0"
        self.payload_bin_size = "0"
        self.payload_properties = ""
        metadata_parsed = False

        try:
            with zipfile.ZipFile(path, "r") as zf:
                for name in zf.namelist():
                    if "META-INF/com/android/metadata" in name:
                        try:
                            data = zf.read(name).decode("utf-8", errors="ignore")
                            for line in data.splitlines():
                                if not line.startswith("ota-streaming-property-files="):
                                    continue
                                rest = line.split("=", 1)
                                if len(rest) < 2:
                                    break
                                value = rest[1]
                                parts = value.split(",")
                                if not parts:
                                    break
                                payload_part = parts[0]
                                segs = payload_part.split(":")
                                if len(segs) < 3:
                                    self.log(
                                        "WARNING metadata 中 ota-streaming-property-files 格式异常: "
                                        f"{payload_part[:80]}"
                                    )
                                    break
                                self.offset = segs[1]
                                self.payload_bin_size = segs[2]
                                metadata_parsed = True
                                self.log(
                                    f"INFO Parsed offset: {self.offset}, "
                                    f"payload.bin size: {self.payload_bin_size}"
                                )
                        except Exception as exc:
                            self.log(f"WARNING 解析metadata失败: {exc}")

                    if "payload_properties.txt" in name:
                        try:
                            raw_data = zf.read(name)
                            self.FILE_HASH = self._get_val(raw_data, "FILE_HASH")
                            self.FILE_SIZE = self._get_val(raw_data, "FILE_SIZE")
                            self.METADATA_HASH = self._get_val(raw_data, "METADATA_HASH")
                            self.METADATA_SIZE = self._get_val(raw_data, "METADATA_SIZE")
                            self.payload_properties = raw_data.decode("utf-8")
                            preview = (
                                self.FILE_HASH[:20] + "..."
                                if len(self.FILE_HASH) > 20
                                else self.FILE_HASH
                            )
                            self.log(
                                f"INFO 成功提取参数 - FILE_HASH: {preview}, "
                                f"FILE_SIZE: {self.FILE_SIZE}, METADATA_SIZE: {self.METADATA_SIZE}"
                            )
                        except Exception as exc:
                            self.log(f"WARNING 解析payload_properties失败: {exc}")
        except Exception as exc:
            raise ValueError(f"解析OTA包失败: {exc}") from exc

        self.log(f"INFO Offset: {self.offset}")
        self.log(f"INFO FILE_SIZE: {self.FILE_SIZE}")
        self.log(f"INFO METADATA_SIZE: {self.METADATA_SIZE}")

        if not self.FILE_SIZE or self.FILE_SIZE == "0":
            self.log("WARNING 未找到有效的FILE_SIZE，尝试从ZIP包文件大小填充（仅作后备）")
            self.FILE_SIZE = str(path.stat().st_size)

        if (
            not metadata_parsed
            or not self.payload_bin_size
            or self.payload_bin_size == "0"
        ):
            raise ValueError(
                "OTA 包缺少有效的 ota-streaming-property-files（offset/size）。"
                "请确认为标准 Android OTA ZIP，且包含 META-INF/com/android/metadata。"
            )

        if not self.FILE_HASH or not self.METADATA_HASH:
            self.log(
                "WARNING FILE_HASH 或 METADATA_HASH 为空，升级可能失败，请检查 payload_properties.txt"
            )

    def check_device(self) -> bool:
        try:
            proc = self._adb(["shell", "getprop", "ro.serialno"], timeout=30)
            out = _decode_output(proc.stdout).strip()
            if proc.returncode == 0 and out:
                self.log(f"INFO 设备连接正常，序列号: {out}")
                return True
            self.log("WARNING 设备序列号为空")
            return False
        except Exception as exc:
            self.log(f"ERROR 检查设备失败: {exc}")
            return False

    def _wait_adb(self, timeout_sec: float = 180) -> bool:
        """adb root / 推包掉线后等设备重新出现；超时返回 False，不抛异常。"""
        self.log(f"INFO 等待设备连接（最长 {int(timeout_sec)} 秒）...")
        deadline = time.monotonic() + timeout_sec
        while time.monotonic() < deadline:
            if self.stop.is_set():
                return False
            remain = max(5.0, min(30.0, deadline - time.monotonic()))
            try:
                self._adb(["wait-for-device"], timeout=remain)
                return True
            except subprocess.TimeoutExpired:
                elapsed = int(timeout_sec - (deadline - time.monotonic()))
                self.log(f"WARNING wait-for-device 未就绪，已等 {elapsed} 秒")
            except Exception as exc:
                self.log(f"WARNING wait-for-device: {exc}")
            time.sleep(2)
        self.log(f"ERROR 等待设备超时（{int(timeout_sec)} 秒）")
        return False

    def push_ota(self) -> bool:
        try:
            self.log("INFO 尝试ADB root...")
            try:
                self._adb(["root"], timeout=15)
            except subprocess.TimeoutExpired:
                self.log("WARNING adb root 超时，改为等待设备")
            except Exception as exc:
                self.log(f"WARNING adb root: {exc}")
            time.sleep(2)
            if not self._wait_adb(180):
                return False
            time.sleep(2)

            ota_name = os.path.basename(str(self.cfg.ota_file_path))
            self.payload = f"file:///data/ota_package/{ota_name}"
            target_dir = "/data/ota_package/"
            self.remote_ota_dir = target_dir.rstrip("/")

            result = self._adb(["shell", "ls", "/data/"], timeout=30)
            ls_out = _decode_output(result.stdout)
            if result.returncode == 0 and "ota_package" in ls_out:
                self.log("INFO /data/ota_package目录已存在")
            else:
                self.log("WARNING /data/ota_package目录不存在，尝试创建")
                result = self._adb(
                    ["shell", "mkdir", "-p", "/data/ota_package"], timeout=30
                )
                if result.returncode != 0:
                    self.log("WARNING 创建目录失败，尝试使用/tmp目录")
                    self.payload = f"file:///data/local/tmp/{ota_name}"
                    target_dir = "/data/local/tmp/"
                    self.remote_ota_dir = target_dir.rstrip("/")

            self.log("INFO 推送OTA文件到设备...")
            self.log(f"INFO 源文件: {self.cfg.ota_file_path}")
            self.log(f"INFO 目标目录: {target_dir}")
            result = self._adb(
                ["push", str(self.cfg.ota_file_path), target_dir],
                timeout=600,
            )
            if result.returncode != 0:
                err = _decode_output(result.stderr)
                self.log(f"ERROR 推送失败，返回码 {result.returncode} 错误: {err}")
                return False

            self.log("INFO OTA文件推送成功")
            remote_path = f"{target_dir.rstrip('/')}/{ota_name}"
            check = self._adb(["shell", "ls", "-la", remote_path], timeout=30)
            listing = _decode_output(check.stdout).strip()
            if check.returncode == 0 and listing:
                self.log(f"INFO 确认文件已在设备中: {listing}")
            return True
        except subprocess.TimeoutExpired as exc:
            self.log(f"ERROR 推送OTA超时: {exc}")
            return False
        except Exception as exc:
            self.log(f"ERROR 推送OTA失败: {exc}")
            return False

    def prepare_update_engine_for_apply(self) -> bool:
        cfg = self.cfg
        deadline = time.monotonic() + cfg.engine_idle_wait_seconds
        poll = max(1.0, float(cfg.engine_status_poll_seconds))
        shell_timeout = float(cfg.engine_client_timeout_seconds)
        cancel_tried = False
        last_status_log = 0.0

        self.log(
            f"INFO 预检 update_engine（最长等待 {cfg.engine_idle_wait_seconds} 秒，"
            f"轮询 {cfg.engine_status_poll_seconds} 秒）..."
        )

        while time.monotonic() < deadline:
            if self.stop.is_set():
                return False
            try:
                proc = self._adb(
                    ["shell", "update_engine_client", "--reset_status"],
                    timeout=min(20.0, shell_timeout),
                )
            except subprocess.TimeoutExpired:
                self.log("WARNING reset_status 无有效返回（ADB 可能断开），稍后重试...")
                if not _sleep_until_deadline(poll, 1.0, stop=self.stop):
                    return False
                continue
            except Exception as exc:
                self.log(f"WARNING reset_status 异常: {exc}")
                if not _sleep_until_deadline(poll, 1.0, stop=self.stop):
                    return False
                continue

            if proc.returncode == 0:
                self.log("INFO update_engine 已就绪（reset_status 成功）")
                return True

            out = _decode_output(proc.stdout) + _decode_output(proc.stderr)
            low = out.lower()
            retryable = any(m in low for m in _BUSY_MARKERS)
            now = time.monotonic()
            if now - last_status_log >= 30:
                try:
                    st = self._adb(
                        ["shell", "update_engine_client", "--status"],
                        timeout=min(20.0, shell_timeout),
                    )
                    snippet = (
                        _decode_output(st.stdout) + _decode_output(st.stderr)
                    ).strip()
                    if len(snippet) > 600:
                        snippet = snippet[:600] + "..."
                    if snippet:
                        self.log(f"INFO update_engine_client --status:\n{snippet}")
                except Exception as exc:
                    self.log(f"WARNING 查询 update_engine_client --status 失败: {exc}")
                last_status_log = now

            if retryable and cfg.try_cancel_before_apply and not cancel_tried:
                self.log("INFO 检测到进行中的更新，尝试 update_engine_client --cancel ...")
                try:
                    cr = self._adb(
                        ["shell", "update_engine_client", "--cancel"],
                        timeout=45,
                    )
                    cancel_out = _decode_output(cr.stdout) + _decode_output(cr.stderr)
                    if cr.returncode == 0:
                        self.log("INFO 已发送取消请求")
                    else:
                        self.log(
                            "WARNING 取消命令返回非零（部分版本无 --cancel 或任务已结束）: "
                            f"{cancel_out[:200]}"
                        )
                except Exception as exc:
                    self.log(f"WARNING cancel 异常: {exc}")
                cancel_tried = True

            remain = deadline - time.monotonic()
            self.log(f"INFO 等待 update_engine 空闲后再 reset（剩余约 {remain:.0f} 秒）...")
            if not _sleep_until_deadline(max(2.0, poll), 1.0, stop=self.stop):
                return False

        self.log(
            f"ERROR 预检超时：update_engine 在 {cfg.engine_idle_wait_seconds} 秒内未能 reset_status 成功"
        )
        return False

    def _pull_device_file(self, device_path: str, local_path: Path, timeout: float = 60) -> None:
        argv: list[str] = ["shell", "cat", device_path]
        if self.device_sn:
            argv = ["-s", self.device_sn, *argv]
        try:
            proc = subprocess.run(
                [self.adb_exe, *argv],
                capture_output=True,
                timeout=timeout,
                env=adb_subprocess_env(),
                **_subprocess_kwargs(),
            )
            local_path.write_bytes(proc.stdout or b"")
            if proc.returncode != 0:
                err = _decode_output(proc.stderr)
                self.log(f"WARNING 读取 {device_path} 非零退出: {err[:200]}")
        except subprocess.TimeoutExpired:
            self.log(f"WARNING 读取设备文件超时: {device_path}")
        except OSError as exc:
            self.log(f"WARNING 写入本地失败 {local_path}: {exc}")

    def dump_fail_logs(self) -> Path | None:
        ts = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
        out_dir = self.base_dir / "logs" / "emmc" / "ota_v5_fail_logs" / ts
        out_dir.mkdir(parents=True, exist_ok=True)
        self.log(f"INFO 收集失败日志到: {out_dir}")
        log_path = out_dir / f"logcat_{ts}.txt"
        try:
            argv: list[str] = []
            if self.device_sn:
                argv.extend(["-s", self.device_sn])
            argv.extend(["exec-out", "logcat", "-d"])
            proc = subprocess.run(
                [self.adb_exe, *argv],
                capture_output=True,
                timeout=120,
                env=adb_subprocess_env(),
                **_subprocess_kwargs(),
            )
            text = _decode_output(proc.stdout)
            if proc.returncode != 0 or not text.strip():
                proc = self._adb(["shell", "logcat", "-d"], timeout=120)
                text = _decode_output(proc.stdout)
            log_path.write_text(text, encoding="utf-8", errors="replace")
            self.log(f"INFO 日志已保存: {log_path}")
        except Exception as exc:
            self.log(f"WARNING 收集 logcat 异常: {exc}")
        for device_path in (
            "/cache/recovery/last_log",
            "/cache/update_engine.log",
            "/data/update_engine.log",
        ):
            base = Path(device_path).name or "_"
            self._pull_device_file(device_path, out_dir / f"{base}_{ts}.log")
        self.log(f"INFO 失败日志目录: {out_dir}")
        return out_dir

    def _classify_output(self, text: str) -> str:
        if any(m in text for m in _ALREADY_LATEST_MARKERS):
            return "already_latest"
        if any(m in text for m in _SUCCESS_MARKERS):
            return "success"
        return "fail"

    def run_update(self) -> bool:
        if not self.check_device():
            self.log("ERROR 设备不可用，无法继续升级")
            return False
        if not self.prepare_update_engine_for_apply():
            self.log("ERROR update_engine 预检失败，跳过本轮升级")
            return False

        temp_dir = tempfile.gettempdir()
        tag = f"ota_update_script_{int(time.time())}"
        local_script = os.path.join(temp_dir, f"{tag}.sh")
        remote_script = f"/data/local/tmp/ota_update_{tag}.sh"

        shell_cmd = (
            "update_engine_client --update --follow --payload="
            f"{self.payload}"
            f" --offset={self.offset}"
            f" --size={self.payload_bin_size}"
            f' --headers="FILE_HASH={self.FILE_HASH}\n'
            f"FILE_SIZE={self.FILE_SIZE}\n"
            f"METADATA_HASH={self.METADATA_HASH}\n"
            f'METADATA_SIZE={self.METADATA_SIZE}"\n'
        )
        script_body = "#!/system/bin/sh\n" + shell_cmd

        proc: subprocess.Popen | None = None
        try:
            with open(local_script, "w", encoding="utf-8", newline="\n") as f:
                f.write(script_body)
            self.log(f"INFO 已生成临时脚本: {local_script}")

            push_argv = build_adb_cmd(["push", local_script, remote_script], self.device_sn or None)
            push_proc = subprocess.run(
                push_argv,
                capture_output=True,
                timeout=120,
                env=adb_subprocess_env(),
                **_subprocess_kwargs(),
            )
            if push_proc.returncode != 0:
                self.log("ERROR 推送脚本到设备失败")
                return False

            self._adb(["shell", "chmod", "755", remote_script], timeout=30)
            run_argv = build_adb_cmd(["shell", "sh", remote_script], self.device_sn or None)
            self.log(f"INFO 执行升级: {shell_cmd[:120]}...")

            out_q: queue.Queue[str | None] = queue.Queue()
            deadline: float | None = None
            if self.cfg.update_timeout_seconds is not None:
                deadline = time.monotonic() + self.cfg.update_timeout_seconds

            proc = subprocess.Popen(
                run_argv,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=adb_subprocess_env(),
                **_subprocess_kwargs(),
            )

            def _reader() -> None:
                assert proc and proc.stdout
                try:
                    for raw_line in iter(proc.stdout.readline, b""):
                        line = _decode_output(raw_line).rstrip("\r\n")
                        if line:
                            out_q.put(line)
                except Exception as exc:
                    logging.debug("读升级输出结束: %s", exc)
                finally:
                    out_q.put(None)

            reader = threading.Thread(target=_reader, daemon=True)
            reader.start()

            lines: list[str] = []
            timed_out = False
            user_stopped = False
            success = False
            already_latest = False
            while True:
                if self.stop.is_set():
                    user_stopped = True
                    timed_out = True
                    break
                if deadline is not None and time.monotonic() > deadline:
                    timed_out = True
                    self.log(
                        "ERROR 单轮升级超过配置时限 (timeout_minutes)，终止 adb 子进程"
                    )
                    break
                try:
                    line = out_q.get(timeout=1.0)
                except queue.Empty:
                    if proc.poll() is not None and out_q.empty():
                        break
                    continue
                if line is None:
                    break
                lines.append(line)
                self.log(f"INFO update_engine: {line}")
                if any(m in line for m in _SUCCESS_MARKERS):
                    success = True
                if any(m in line for m in _ALREADY_LATEST_MARKERS):
                    already_latest = True

            if timed_out:
                _terminate_process(proc)
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.log("WARNING 升级进程 wait 超时，强制结束")
            else:
                try:
                    proc.wait(timeout=60)
                except subprocess.TimeoutExpired:
                    _terminate_process(proc)
                    self.log("WARNING 升级进程 wait 超时，强制结束")

            if user_stopped:
                return False

            full_output = "\n".join(lines)
            result = self._classify_output(full_output)
            if already_latest or result == "already_latest":
                self.log("INFO 设备已经是最新版本")
                return True
            if success or result == "success":
                self.log("INFO 升级成功")
                self.log("INFO 重启设备...")
                self._adb(["reboot"], timeout=30)
                return True

            self.log("ERROR 升级失败")
            self.dump_fail_logs()
            return False
        except Exception as exc:
            self.log(f"ERROR 执行升级命令异常: {exc}")
            self.dump_fail_logs()
            return False
        finally:
            try:
                self._adb(["shell", "rm", "-f", remote_script], timeout=30)
            except Exception:
                pass
            if os.path.exists(local_script):
                try:
                    os.remove(local_script)
                except OSError:
                    pass

    def _deadline_reached(self, deadline: float | None) -> bool:
        return deadline is not None and time.monotonic() >= deadline

    def _log_round_banner(self, round_idx: int, start_mono: float) -> None:
        cfg = self.cfg
        if cfg.upgrade_count > 0:
            self.log(
                f"INFO ========== 升级轮次 {round_idx}/{cfg.upgrade_count} =========="
            )
            return
        elapsed_min = (time.monotonic() - start_mono) / 60.0
        self.log(
            f"INFO ========== 升级轮次 {round_idx} "
            f"（已运行 {elapsed_min:.1f}/{cfg.max_run_minutes} 分钟） =========="
        )
        tot = max(1, int(cfg.max_run_minutes * 60))
        cur = min(int(time.monotonic() - start_mono), tot)
        self._emit_progress(cur, tot, f"{elapsed_min:.1f}/{cfg.max_run_minutes} 分钟")

    def _try_upgrade_round(self, attempts: int, deadline: float | None) -> str:
        """一轮升级（含重试）。返回 success / fail / user_stop / time_up。"""
        for attempt in range(1, attempts + 1):
            if self.stop.is_set():
                return "user_stop"
            if self._deadline_reached(deadline):
                return "time_up"
            self.log(f"INFO --- 尝试 {attempt}/{attempts} ---")
            ok = False
            try:
                if not self.push_ota():
                    self.log("WARNING 推送OTA失败")
                elif self.run_update():
                    ok = True
            except subprocess.TimeoutExpired as exc:
                self.log(f"ERROR 尝试 {attempt} ADB 超时: {exc}")
            except Exception as exc:
                self.log(f"ERROR 尝试 {attempt} 异常: {exc}")
            if ok:
                return "success"
            if attempt >= attempts:
                break
            self.log("INFO 升级失败，等待重试...")
            if not _sleep_until_deadline(15.0, 1.0, stop=self.stop):
                return "user_stop" if self.stop.is_set() else "fail"
        return "fail"

    def run_test_loop(self) -> tuple[int, int, str, float]:
        """执行完整 OTA 循环。返回 (完成轮次, 失败轮次, 停止原因, 耗时分钟)。

        正常结束：按轮次跑满，或按时长跑满（先到先停）。
        立刻停止：用户中断、开机失败、本轮重试用尽仍失败。
        """
        cfg = self.cfg
        start_mono = time.monotonic()
        max_deadline: float | None = None
        if cfg.max_run_minutes > 0:
            max_deadline = start_mono + cfg.max_run_minutes * 60
        attempts = max(1, int(cfg.retry_limit or 0))

        count_mode = cfg.upgrade_count > 0 and cfg.max_run_minutes <= 0
        time_mode = cfg.max_run_minutes > 0 and cfg.upgrade_count <= 0
        if count_mode:
            self.log(f"INFO 停止条件: 按次数（目标 {cfg.upgrade_count} 轮）")
        elif time_mode:
            self.log(f"INFO 停止条件: 按时长（目标 {cfg.max_run_minutes} 分钟）")
        else:
            self.log(
                f"INFO 停止条件: 轮次 {cfg.upgrade_count} 或时长 {cfg.max_run_minutes} 分钟（先到先停）"
            )
        self.log(f"INFO 每轮最多尝试 {attempts} 次，失败即停止")

        completed = 0
        failed_rounds = 0
        stop_reason = "手动停止"
        round_idx = 0

        while True:
            round_idx += 1
            if self.stop.is_set():
                stop_reason = "用户中断"
                break
            if cfg.upgrade_count > 0 and round_idx > cfg.upgrade_count:
                stop_reason = f"已达设定轮次 {cfg.upgrade_count}"
                break
            if self._deadline_reached(max_deadline):
                stop_reason = f"达到最大运行时长 ({cfg.max_run_minutes} 分钟)"
                self.log(f"INFO 已到达最大运行时长 ({cfg.max_run_minutes} 分钟)，停止测试")
                break

            self._log_round_banner(round_idx, start_mono)

            if not wait_for_boot(
                self.device_sn,
                self.adb_exe,
                log=self.log,
                stop=self.stop,
            ):
                if self.stop.is_set():
                    stop_reason = "用户中断"
                else:
                    failed_rounds += 1
                    stop_reason = f"轮次 {round_idx} 设备启动失败"
                    self.log(f"ERROR {stop_reason}，停止测试")
                break

            outcome = self._try_upgrade_round(attempts, max_deadline)
            if outcome == "user_stop":
                stop_reason = "用户中断"
                break
            if outcome == "time_up":
                stop_reason = f"达到最大运行时长 ({cfg.max_run_minutes} 分钟)"
                break
            if outcome != "success":
                failed_rounds += 1
                stop_reason = f"轮次 {round_idx} 升级失败（已重试 {attempts} 次）"
                self.log(f"ERROR {stop_reason}，停止测试")
                if cfg.upgrade_count > 0:
                    self._emit_progress(
                        completed,
                        cfg.upgrade_count,
                        f"{completed}/{cfg.upgrade_count} 次 (失败 {failed_rounds})",
                    )
                else:
                    elapsed_min = (time.monotonic() - start_mono) / 60.0
                    tot = max(1, int(cfg.max_run_minutes * 60))
                    cur = min(int(time.monotonic() - start_mono), tot)
                    self._emit_progress(
                        cur,
                        tot,
                        f"{elapsed_min:.1f}/{cfg.max_run_minutes} 分钟 (失败 {failed_rounds})",
                    )
                break

            completed += 1
            self.log(f"INFO 轮次 {round_idx} 完成")
            if cfg.upgrade_count > 0:
                self._emit_progress(
                    completed,
                    cfg.upgrade_count,
                    f"{completed}/{cfg.upgrade_count} 次",
                )
            if cfg.upgrade_count > 0 and round_idx >= cfg.upgrade_count:
                stop_reason = f"已达设定轮次 {cfg.upgrade_count}"
                break
            if cfg.round_interval_minutes <= 0:
                continue
            self.log(f"INFO 等待 {cfg.round_interval_minutes} 分钟后进行下一轮测试...")
            _sleep_until_deadline(
                cfg.round_interval_minutes * 60,
                5.0,
                stop=self.stop,
            )
            if self.stop.is_set():
                stop_reason = "用户中断"
                break
            if self._deadline_reached(max_deadline):
                stop_reason = f"轮次间隔期间达到最大运行时长 ({cfg.max_run_minutes} 分钟)"
                break

        elapsed = time.monotonic() - start_mono
        self.log(
            f"INFO OTA测试完成 - 实际完成轮次: {completed}, 耗时: {elapsed:.1f}秒 ({elapsed/60:.1f}分钟), "
            f"失败轮次: {failed_rounds}, 停止原因: {stop_reason}"
        )
        return completed, failed_rounds, stop_reason, elapsed / 60.0


def judge_ota_result(
    *,
    user_stopped: bool,
    completed: int,
    failed_rounds: int,
    upgrade_count: int,
    stop_reason: str,
) -> str:
    """统一判定 PASS / FAIL / STOP。"""
    if user_stopped:
        return "STOP"
    if failed_rounds > 0 or completed <= 0:
        return "FAIL"
    if upgrade_count > 0:
        return "PASS" if completed >= upgrade_count else "FAIL"
    if "最大运行时长" in (stop_reason or ""):
        return "PASS"
    return "FAIL"
