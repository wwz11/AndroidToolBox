#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""eMMC reboot 循环测试（adb reboot + 等待系统开机完成 + 重启原因/异常检测）。"""

from __future__ import annotations

import configparser
import re
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from tools.adb_runtime import resolve_adb_exe
from tools.emmc_test.agent_bridge import (
    ensure_device_reboot_daemon,
    find_agent_apk,
    install_and_init_agent,
    is_agent_installed,
    read_agent_state_fast,
    sync_agent_on_reboot_end,
    sync_agent_on_reboot_start,
)
from tools.emmc_test.ota_v5 import _decode_output, _run_adb_argv, is_tcp_serial, reconnect_adb, wait_for_boot

LogFn = Callable[[str], None]

_DEFAULT_RUN_HOURS = 1.0
_DEFAULT_BOOT_TIMEOUT_SEC = 600
_WAIT_FOR_DEVICE_TIMEOUT_SEC = 120
_AGENT_COMM_TIMEOUT_SEC = 600
_MAX_CONSECUTIVE_FAILS = 3

# 预期原因（受控 adb reboot 后常见）
_EXPECTED_REASON_TOKENS = (
    "reboot",
    "adb",
    "shell",
    "userrequested",
    "user_requested",
    "cold",
    "powerkey",
    "normal",
    "charger",
    "rtc",
)

# 异常原因关键字（命中任一即判定异常）
_ANOMALY_REASON_TOKENS = (
    "kernel_panic",
    "panic",
    "watchdog",
    "hw_watchdog",
    "sw_watchdog",
    "under_voltage",
    "undervoltage",
    "uvlo",
    "brownout",
    "thermal",
    "overheat",
    "crash",
    "fatal",
    "ocpm",
    "rescueparty",
    "rescue_party",
    "hang",
    "oops",
    "bug",
)

_PSTORE_PATHS = (
    "/sys/fs/pstore/console-ramoops-0",
    "/sys/fs/pstore/console-ramoops",
    "/proc/last_kmsg",
)

_REASON_PROPS = (
    "sys.boot.reason",
    "ro.boot.bootreason",
    "sys.boot.reason.last",
    "persist.sys.boot.reason",
)

_REASON_SYSFS = (
    "/sys/class/aml_watchdog/reboot_reason",
    "/sys/devices/platform/aml_wdt/reboot_reason",
    "/proc/sys/kernel/boot_reason",
    "/sys/kernel/boot_reason",
)


@dataclass
class RebootConfig:
    device_sn: str
    run_hours: float = _DEFAULT_RUN_HOURS
    boot_timeout_sec: int = _DEFAULT_BOOT_TIMEOUT_SEC
    # >0：按次数模式（忽略时长）；0：按时长模式
    target_count: int = 0


@dataclass
class RebootReasonReport:
    """单次开机后的重启原因与异常判定。"""

    primary: str = ""
    details: dict[str, str] = field(default_factory=dict)
    pstore_hit: str = ""
    is_anomaly: bool = False
    anomaly_tags: list[str] = field(default_factory=list)

    def summary(self) -> str:
        if self.primary:
            base = self.primary
        elif self.details:
            base = "; ".join(f"{k}={v}" for k, v in self.details.items())
        else:
            base = "(未获取到)"
        if self.pstore_hit:
            base = f"{base} | pstore:{self.pstore_hit}"
        if self.is_anomaly:
            tags = ",".join(self.anomaly_tags) if self.anomaly_tags else "anomaly"
            return f"{base} [异常:{tags}]"
        return f"{base} [正常]"


def load_reboot_config(path: Path) -> RebootConfig:
    parser = configparser.ConfigParser()
    parser.read(path, encoding="utf-8")
    sec = parser["SETTING"] if "SETTING" in parser else {}
    sn = str(sec.get("sn", "")).strip()
    try:
        run_hours = float(str(sec.get("run_hours", _DEFAULT_RUN_HOURS)).strip())
    except ValueError:
        run_hours = _DEFAULT_RUN_HOURS
    try:
        boot_timeout = int(str(sec.get("boot_timeout_sec", _DEFAULT_BOOT_TIMEOUT_SEC)).strip())
    except ValueError:
        boot_timeout = _DEFAULT_BOOT_TIMEOUT_SEC
    try:
        target_count = int(
            str(sec.get("target_count", sec.get("reboot_count", "0"))).strip() or "0"
        )
    except ValueError:
        target_count = 0
    return RebootConfig(
        device_sn=sn,
        run_hours=max(0.1, run_hours),
        boot_timeout_sec=max(60, boot_timeout),
        target_count=max(0, target_count),
    )


def write_reboot_config(path: Path, cfg: RebootConfig) -> None:
    parser = configparser.ConfigParser()
    parser["SETTING"] = {
        "sn": cfg.device_sn.strip(),
        "run_hours": str(cfg.run_hours),
        "boot_timeout_sec": str(cfg.boot_timeout_sec),
        "target_count": str(max(0, int(cfg.target_count))),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        parser.write(f)


def _adb_prefix(sn: str) -> list[str]:
    return ["-s", sn] if sn.strip() else []


def _sleep_with_stop(seconds: float, stop) -> bool:
    """Sleep in small slices; return False if stop was set."""
    if seconds <= 0:
        return True
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if stop is not None and stop.is_set():
            return False
        time.sleep(min(1.0, deadline - time.monotonic()))
    return True


def _normalize_reason(text: str) -> str:
    s = (text or "").strip().strip("'\"")
    s = re.sub(r"\s+", " ", s)
    return s


def _token_in_reason(token: str, reason_low: str) -> bool:
    """子串匹配；短词用分隔边界，避免 debug 误伤 bug。"""
    if not token or not reason_low:
        return False
    if len(token) >= 5:
        return token in reason_low
    # 按常见分隔符切词匹配
    parts = re.split(r"[,:;|/\\\s_\-]+", reason_low)
    return token in parts


def classify_reboot_reason(reason: str, *, pstore_hit: str = "") -> tuple[bool, list[str]]:
    """返回 (是否异常, 异常标签列表)。"""
    tags: list[str] = []
    low = (reason or "").strip().lower()
    if pstore_hit:
        tags.append(f"pstore:{pstore_hit}")
    if not low and not tags:
        return False, []

    for tok in _ANOMALY_REASON_TOKENS:
        if _token_in_reason(tok, low):
            tags.append(tok)

    # panic/watchdog 等已在上面；若仅有 expected token 则正常
    if tags:
        return True, sorted(set(tags))

    # 有明确原因但不在预期集合 → 记为可疑异常（未知原因）
    if low:
        expected = any(_token_in_reason(tok, low) for tok in _EXPECTED_REASON_TOKENS)
        if not expected:
            return True, ["unknown_reason"]
    return False, []


class RebootTestRunner:
    """循环 adb reboot，统计成功/失败次数与总时长，并检测重启原因异常。"""

    def __init__(
        self,
        cfg: RebootConfig,
        *,
        log: LogFn,
        stop=None,
        on_progress=None,
    ) -> None:
        self.cfg = cfg
        self.log = log
        self.stop = stop
        self.on_progress = on_progress
        self.adb_exe = resolve_adb_exe() or "adb"
        self.device_sn = cfg.device_sn.strip()
        self.anomaly_count = 0
        self.anomaly_records: list[str] = []

    def _emit_progress(self, current: int, total: int, text: str = "") -> None:
        if self.on_progress is None:
            return
        try:
            self.on_progress(current, total, text or f"{current}/{total}")
        except Exception:
            pass

    def _adb(self, args: list[str], *, timeout: float | None = None) -> subprocess.CompletedProcess:
        argv = _adb_prefix(self.device_sn) + args
        return _run_adb_argv(self.adb_exe, argv, timeout=timeout, log=None)

    def _shell(self, cmd: str, *, timeout: float = 15.0) -> str:
        try:
            proc = self._adb(["shell", cmd], timeout=timeout)
        except Exception:
            return ""
        out = _decode_output(proc.stdout).strip()
        # 过滤 shell 报错行
        if not out:
            return ""
        low = out.lower()
        if "no such file" in low or "permission denied" in low or "not found" in low:
            if "\n" not in out and len(out) < 80:
                return ""
        return out

    def _getprop(self, name: str) -> str:
        try:
            proc = self._adb(["shell", "getprop", name], timeout=10)
        except Exception:
            return ""
        return _normalize_reason(_decode_output(proc.stdout))

    def _is_stop_requested(self) -> bool:
        return self.stop is not None and self.stop.is_set()

    def _is_device_ready(self) -> bool:
        try:
            proc = self._adb(["get-state"], timeout=5)
        except Exception:
            return False
        return proc.returncode == 0 and "device" in _decode_output(proc.stdout).strip().lower()

    def _wait_for_device_online(self, timeout_sec: int) -> bool:
        deadline = time.monotonic() + max(1, timeout_sec)
        attempt = 0
        while time.monotonic() < deadline:
            if self._is_stop_requested():
                return False
            if self._is_device_ready():
                return True
            attempt += 1
            if is_tcp_serial(self.device_sn) or attempt % 2 == 1:
                reconnect_adb(self.device_sn, self.adb_exe)
            if not _sleep_with_stop(2.0, self.stop):
                return False
        self.log(f"WARNING 等待设备恢复在线超时（{timeout_sec}秒）")
        return False

    def _reboot_cmd_sent(self) -> bool:
        """执行 reboot；遇到短暂掉线时先重连再重试，部分平台返回非0但连接已断开按已发送处理。"""
        if not self._is_device_ready():
            self.log("WARNING 发送 reboot 前检测到 ADB 暂未就绪，尝试等待重连...")
            if not self._wait_for_device_online(30):
                self.log("ERROR 发送 reboot 前设备仍未恢复在线")
                return False

        for attempt in (1, 2):
            try:
                self.log("INFO 执行 adb reboot")
                proc = self._adb(["reboot"], timeout=30)
            except Exception as exc:
                self.log(f"ERROR adb reboot 异常: {exc}")
                return False
            if proc.returncode == 0:
                return True
            output = (_decode_output(proc.stdout) + "\n" + _decode_output(proc.stderr)).strip().lower()
            if any(key in output for key in ("closed", "broken pipe", "connection reset")):
                self.log("WARNING adb reboot 返回非0，但连接已断开，按已发送 reboot 处理")
                return True
            if attempt == 1 and any(key in output for key in ("not found", "offline", "no devices")):
                self.log("WARNING adb reboot 遇到设备短暂掉线，尝试重连后重试...")
                if self._wait_for_device_online(20):
                    continue
            self.log(f"ERROR adb reboot 失败: {output or proc.returncode}")
            return False
        return False

    def _scan_pstore(self) -> str:
        """扫描 last_kmsg / pstore，返回命中的异常关键字（空表示无）。"""
        for path in _PSTORE_PATHS:
            # 只取尾部，避免大文件拖慢
            text = self._shell(f"tail -n 80 {path} 2>/dev/null", timeout=12)
            if not text:
                continue
            low = text.lower()
            for key in ("kernel panic", "watchdog", "oops:", "fatal exception", "bug:"):
                if key in low:
                    return key.replace(":", "").strip()
        return ""

    def collect_reboot_reason(self) -> RebootReasonReport:
        """开机完成后采集重启原因并判定是否异常。"""
        details: dict[str, str] = {}
        for prop in _REASON_PROPS:
            val = self._getprop(prop)
            if val:
                details[prop] = val
        for path in _REASON_SYSFS:
            # 单行读
            val = _normalize_reason(
                self._shell(f"cat {path} 2>/dev/null | head -n 1", timeout=10)
            )
            if val:
                details[path] = val

        primary = (
            details.get("sys.boot.reason")
            or details.get("ro.boot.bootreason")
            or details.get("sys.boot.reason.last")
            or details.get("persist.sys.boot.reason")
            or next(iter(details.values()), "")
        )
        pstore_hit = self._scan_pstore()
        is_anomaly, tags = classify_reboot_reason(primary, pstore_hit=pstore_hit)
        # 若 primary 看似正常，但其它字段含异常，仍判异常
        if not is_anomaly:
            for v in details.values():
                bad, more = classify_reboot_reason(v)
                if bad and "unknown_reason" not in more:
                    is_anomaly = True
                    tags = sorted(set(tags + more))
                    break
        return RebootReasonReport(
            primary=primary,
            details=details,
            pstore_hit=pstore_hit,
            is_anomaly=is_anomaly,
            anomaly_tags=tags,
        )

    def _log_reason_report(self, round_no: int, report: RebootReasonReport) -> None:
        self.log(f"INFO 第 {round_no} 次重启原因: {report.summary()}")
        if report.details:
            for k, v in report.details.items():
                if v != report.primary:
                    self.log(f"INFO   · {k} = {v}")
        if report.is_anomaly:
            self.anomaly_count += 1
            rec = f"第{round_no}次: {report.summary()}"
            self.anomaly_records.append(rec)
            self.log(f"ERROR 检测到异常重启原因 → {rec}")

    def run_test_loop(self) -> tuple[int, int, str, float, int]:
        """
        返回 (成功次数, 失败次数, 停止原因, 时长小时, 异常次数)。
        """
        duration_sec = self.cfg.run_hours * 3600.0
        success = 0
        fail = 0
        consecutive_fail = 0
        round_no = 0
        start = time.monotonic()
        stop_reason = ""
        self.anomaly_count = 0
        self.anomaly_records = []

        target_count = max(0, int(self.cfg.target_count or 0))
        count_mode = target_count > 0
        if count_mode:
            self.log(f"INFO 停止条件: 按次数（目标 {target_count} 次）")
        else:
            self.log(f"INFO 停止条件: 按时长（目标 {self.cfg.run_hours:g} 小时）")
        self.log(f"INFO 单次开机超时: {self.cfg.boot_timeout_sec} 秒")
        self.log(f"INFO 连续失败阈值: {_MAX_CONSECUTIVE_FAILS} 次")
        self.log("INFO 已启用重启原因/异常检测（sys.boot.reason / pstore 等）")

        self.log("INFO 预检设备连通性...")
        if not self._wait_for_device_online(_WAIT_FOR_DEVICE_TIMEOUT_SEC):
            fail = 1
            stop_reason = f"{_WAIT_FOR_DEVICE_TIMEOUT_SEC}秒内未检测到设备在线，测试失败并退出"
            self.log(f"ERROR {stop_reason}")
            duration_hours = (time.monotonic() - start) / 3600.0
            self.log(
                f"ERROR reboot 测试结束: 成功 {success} 次，失败 {fail} 次，"
                f"异常 {self.anomaly_count} 次，时长 {duration_hours:.2f} 小时"
            )
            return success, fail, stop_reason, duration_hours, self.anomaly_count

        if not is_agent_installed(self.device_sn) and find_agent_apk() is not None:
            try:
                self.log("INFO 未检测到设备端 ToolboxAgent，正在自动安装并激活...")
                install_and_init_agent(self.device_sn)
            except Exception as exc:
                self.log(f"WARNING 自动安装 ToolboxAgent 失败，将回退到纯 PC ADB 模式: {exc}")

        agent_linked = sync_agent_on_reboot_start(
            self.device_sn,
            mode="count" if count_mode else "hours",
            target_count=target_count if count_mode else 10,
            run_hours=self.cfg.run_hours,
        )
        if agent_linked:
            ensure_device_reboot_daemon(self.device_sn)
            self.log("INFO 已启用 APK 主导 Reboot 压测（每次重启由设备端 APK 发起，ADB 断连最长重试 10 分钟）")
            return self._run_agent_driven_loop(
                start=start,
                count_mode=count_mode,
                target_count=target_count,
                duration_sec=duration_sec,
            )

        # 基线：记录测试前原因（不计入异常）
        try:
            baseline = self.collect_reboot_reason()
            self.log(f"INFO 测试前重启原因基线: {baseline.summary()}")
        except Exception as exc:
            self.log(f"WARNING 采集基线重启原因失败: {exc}")

        while True:
            if self._is_stop_requested():
                stop_reason = "用户停止"
                break
            elapsed = time.monotonic() - start
            # 次数 / 时长二选一，不可同时作为停止条件
            if count_mode:
                if round_no >= target_count:
                    stop_reason = f"已达设定次数 {target_count}"
                    break
            elif elapsed >= duration_sec:
                stop_reason = f"已达设定时长 {self.cfg.run_hours:g} 小时"
                break

            round_no += 1
            self.log(f"INFO ========== 第 {round_no} 次 reboot ==========")
            if count_mode:
                self.log(f"INFO 进度 {round_no}/{target_count}（已成功 {success}，失败 {fail}）")
                self._emit_progress(
                    success,
                    target_count,
                    f"{success}/{target_count} 次"
                    if fail == 0
                    else f"{success}/{target_count} 次 (失败 {fail})",
                )
            else:
                remaining_min = max(0.0, (duration_sec - elapsed) / 60.0)
                self.log(f"INFO 剩余目标时长约 {remaining_min:.1f} 分钟")
                pct_den = max(1, int(duration_sec))
                pct_num = min(pct_den, int(elapsed))
                hrs = elapsed / 3600.0
                self._emit_progress(
                    pct_num,
                    pct_den,
                    f"{hrs:.2f}/{self.cfg.run_hours:g} 小时",
                )
            if not self._reboot_cmd_sent():
                fail += 1
                consecutive_fail += 1
                if not _sleep_with_stop(5.0, self.stop):
                    stop_reason = "用户停止"
                    break
                if consecutive_fail >= _MAX_CONSECUTIVE_FAILS:
                    stop_reason = f"连续失败 {consecutive_fail} 次，提前停止"
                    break
                continue

            # reboot 发出后先等设备回到 online，减少 getprop 报错噪音并缩短恢复时间。
            self._wait_for_device_online(min(self.cfg.boot_timeout_sec, _WAIT_FOR_DEVICE_TIMEOUT_SEC))
            boot_ok = wait_for_boot(
                self.device_sn,
                self.adb_exe,
                timeout=self.cfg.boot_timeout_sec,
                log=self.log,
                stop=self.stop,
            )
            if self._is_stop_requested():
                stop_reason = "用户停止"
                break
            if not boot_ok:
                fail += 1
                consecutive_fail += 1
                self.log(f"ERROR 第 {round_no} 次 reboot 失败（开机超时）")
                # 若之后又能连上，仍尝试采集原因辅助排查
                if self._wait_for_device_online(30):
                    try:
                        report = self.collect_reboot_reason()
                        self._log_reason_report(round_no, report)
                    except Exception as exc:
                        self.log(f"WARNING 开机超时后采集重启原因失败: {exc}")
                if consecutive_fail >= _MAX_CONSECUTIVE_FAILS:
                    stop_reason = f"连续失败 {consecutive_fail} 次，提前停止"
                    break
                continue

            # 开机成功：采集重启原因；异常原因记为本轮失败
            try:
                report = self.collect_reboot_reason()
                self._log_reason_report(round_no, report)
            except Exception as exc:
                self.log(f"WARNING 采集重启原因失败: {exc}")
                report = RebootReasonReport(primary="", is_anomaly=False)

            if report.is_anomaly:
                fail += 1
                consecutive_fail += 1
                self.log(
                    f"ERROR 第 {round_no} 次 reboot 判定失败（异常重启原因）"
                    f"（累计 成功 {success} / 失败 {fail} / 异常 {self.anomaly_count}）"
                )
                if consecutive_fail >= _MAX_CONSECUTIVE_FAILS:
                    stop_reason = (
                        f"连续失败 {consecutive_fail} 次（含异常重启原因），提前停止"
                    )
                    break
                continue

            success += 1
            consecutive_fail = 0
            elapsed_min = (time.monotonic() - start) / 60.0
            self.log(
                f"INFO 第 {round_no} 次 reboot 成功"
                f"（累计 成功 {success} / 失败 {fail} / 异常 {self.anomaly_count}，"
                f"已运行 {elapsed_min:.1f} 分钟）"
            )

        if agent_linked:
            sync_agent_on_reboot_end(self.device_sn)
        duration_hours = (time.monotonic() - start) / 3600.0
        if not stop_reason:
            stop_reason = "测试结束"
        self.log(
            f"INFO reboot 测试结束: 成功 {success} 次，失败 {fail} 次，"
            f"异常 {self.anomaly_count} 次，时长 {duration_hours:.2f} 小时"
        )
        if self.anomaly_records:
            self.log("ERROR 异常重启汇总:")
            for rec in self.anomaly_records:
                self.log(f"ERROR   · {rec}")
        return success, fail, stop_reason, duration_hours, self.anomaly_count

    def _run_agent_driven_loop(
        self,
        *,
        start: float,
        count_mode: bool,
        target_count: int,
        duration_sec: float,
    ) -> tuple[int, int, str, float, int]:
        """APK 主导每轮重启，PC 端实时同步进度；ADB 断连重试 10 分钟无反应再判 Fail。"""
        success = 0
        fail = 0
        last_logged_round = 0
        last_boot_id = ""
        last_comm_ok = time.monotonic()
        last_offline_warn = 0.0
        last_reconnect_try = 0.0
        waiting_reboot_since: float | None = None
        stop_reason = ""

        if count_mode:
            self._emit_progress(0, target_count, f"0/{target_count} 次")
        else:
            self._emit_progress(0, max(1, int(duration_sec)), f"0.00/{self.cfg.run_hours:g} 小时")

        while True:
            if self._is_stop_requested():
                stop_reason = "用户停止"
                sync_agent_on_reboot_end(self.device_sn)
                break

            now = time.monotonic()
            st = read_agent_state_fast(self.device_sn)
            if st is None:
                offline_sec = now - last_comm_ok
                if now - last_reconnect_try >= 4.0:
                    last_reconnect_try = now
                    reconnect_adb(self.device_sn, self.adb_exe)
                if now - last_offline_warn >= 30.0:
                    last_offline_warn = now
                    self.log(
                        f"WARNING ADB 断连，正在重试与设备端 APK 通信"
                        f"（已重试 {int(offline_sec)}/{_AGENT_COMM_TIMEOUT_SEC} 秒）..."
                    )
                if offline_sec >= _AGENT_COMM_TIMEOUT_SEC:
                    fail += 1
                    stop_reason = (
                        f"ADB 断连重试 {int(_AGENT_COMM_TIMEOUT_SEC // 60)} 分钟仍无法与设备端 APK 通信，判定失败"
                    )
                    self.log(f"ERROR {stop_reason}")
                    break
                if not _sleep_with_stop(2.0, self.stop):
                    stop_reason = "用户停止"
                    break
                continue

            last_comm_ok = now
            last_offline_warn = 0.0
            boot_id = str(st.get("last_boot_id") or "")
            if boot_id and boot_id != last_boot_id:
                last_boot_id = boot_id
                ensure_device_reboot_daemon(self.device_sn)
                waiting_reboot_since = None

            agent_state = str(st.get("state") or "")
            cur_round = int(st.get("current_round") or 0)
            success = int(st.get("success_rounds") or 0)
            fail = int(st.get("fail_rounds") or 0)
            self.anomaly_count = int(st.get("anomaly_count") or 0)
            reason = str(st.get("last_boot_reason") or "")
            anomaly_detail = str(st.get("last_anomaly_detail") or "")

            if cur_round > last_logged_round:
                last_logged_round = cur_round
                if anomaly_detail:
                    rec = f"第{cur_round}次: {anomaly_detail} (reason={reason or '-'})"
                    self.anomaly_records.append(rec)
                    self.log(f"ERROR 第 {cur_round} 次开机检测到异常 → {rec}")
                else:
                    self.log(
                        f"INFO 第 {cur_round} 次开机正常 (reason={reason or '-'})"
                        f"（累计 成功 {success} / 失败 {fail} / 异常 {self.anomaly_count}）"
                    )

            elapsed = now - start
            if count_mode:
                msg = (
                    f"{success}/{target_count} 次"
                    if fail == 0
                    else f"{success}/{target_count} 次 (失败 {fail})"
                )
                self._emit_progress(success, target_count, msg)
            else:
                pct_den = max(1, int(duration_sec))
                pct_num = min(pct_den, int(elapsed))
                hrs = elapsed / 3600.0
                msg = (
                    f"{hrs:.2f}/{self.cfg.run_hours:g} 小时"
                    if fail == 0
                    else f"{hrs:.2f}/{self.cfg.run_hours:g} 小时 (失败 {fail})"
                )
                self._emit_progress(pct_num, pct_den, msg)

            if agent_state in ("COMPLETED", "FAILED", "STOPPED"):
                stop_reason = str(st.get("stop_reason") or agent_state)
                break

            # 若设备端已发起 reboot.req 但守护尚未消费（如刚开机或被系统限制），3秒后由 PC ADB 辅助触发
            if st.get("waiting_pc_reboot"):
                if waiting_reboot_since is None:
                    waiting_reboot_since = now
                elif now - waiting_reboot_since >= 3.0:
                    waiting_reboot_since = now
                    ensure_device_reboot_daemon(self.device_sn)
                    self._reboot_cmd_sent()
            else:
                waiting_reboot_since = None

            if not _sleep_with_stop(2.0, self.stop):
                stop_reason = "用户停止"
                sync_agent_on_reboot_end(self.device_sn)
                break

        duration_hours = (time.monotonic() - start) / 3600.0
        if not stop_reason:
            stop_reason = "测试结束"
        self.log(
            f"INFO reboot 测试结束: 成功 {success} 次，失败 {fail} 次，"
            f"异常 {self.anomaly_count} 次，时长 {duration_hours:.2f} 小时"
        )
        if self.anomaly_records:
            self.log("ERROR 异常重启汇总:")
            for rec in self.anomaly_records:
                self.log(f"ERROR   · {rec}")
        return success, fail, stop_reason, duration_hours, self.anomaly_count
