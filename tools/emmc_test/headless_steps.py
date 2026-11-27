#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""eMMC 自动化子项无界面执行（供多设备并行编排使用）。"""

from __future__ import annotations

import configparser
import datetime as dt
import re
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from tools.adb_runtime import (
    _subprocess_kwargs,
    adb_available,
    adb_subprocess_env,
    build_adb_cmd,
    kill_process_tree as _kill_process_tree,
)
from tools.bundled_paths import app_base_dir as _app_base_dir
from tools.bundled_paths import vendor_path
from tools.emmc_test.adb_shell import string_run_shell
from tools.emmc_test.auto_runner import AUTO_LABELS, AUTO_STEPS
from tools.emmc_test.config_util import (
    default_iozone_bin as _default_iozone_bin_impl,
    ensure_iozone_vendor,
    path_from_config_str as _path_from_config_str,
    read_stress_config as _read_stress_config,
    runtime_config_path as _runtime_config_path,
)
from tools.emmc_test.headless_log import HeadlessLogSession
from tools.emmc_test.ota_v5 import OtaUpgradeRunner, judge_ota_result, load_ota_v5_config
from tools.emmc_test.read_excel import ReadExcel, average_rates
from tools.emmc_test.reboot_test import RebootConfig, RebootTestRunner, load_reboot_config
from tools.emmc_test.report_template import (
    _iozone_pass,
    ensure_flow_report,
    get_ab_upgrade_for_flow,
    save_log_text_as_png,
    write_iozone_result,
    write_ota_result,
    write_reboot_result,
    write_rpmb_result,
    write_stress_result,
)

LogFn = Callable[[str], None]
# step_id, current, total, text（如 "120/1000"）
ProgressFn = Callable[[str, int, int, str], None]

_RPMB_FILES = ("mmc_utils", "rpmb_test_v7_dev.sh", "rpmbkey.bin")
_RPMB_SCRIPT = "rpmb_test_v7_dev.sh"
_STRESS_RESULT_XLSX = "stress_result.xlsx"
_IOZONE_RESULT_XLSX = "iozone_result.xlsx"
_SUCCESS_FLAG = "<stdin>[3]: 0:"
_LAST_LINE_DATA_RE = re.compile(r"(\d+)\s*$")
_SOURCE_CANDIDATES = (
    "/dev/block/system",
    "/dev/block/by-name/super",
)


def _emmc_output_dir() -> Path:
    path = _app_base_dir() / "output" / "emmc"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _emmc_result_xlsx(name: str) -> Path:
    return _emmc_output_dir() / name


def _default_iozone_bin() -> Path:
    ensure_iozone_vendor()
    return _default_iozone_bin_impl()


def _load_iozone_settings(path: Path) -> tuple[int, bool, Path, float, float]:
    parser = configparser.ConfigParser()
    parser.read(path, encoding="utf-8")
    sec = parser["SETTING"] if "SETTING" in parser else {}
    try:
        file_size = int(str(sec.get("file_size", "100")).strip())
    except ValueError:
        file_size = 100
    samsung_raw = str(sec.get("samsung_emmc", "")).strip().lower()
    samsung = samsung_raw in ("1", "true", "yes", "on")
    iozone_raw = str(sec.get("iozone_bin", "")).strip()
    iozone_bin = _path_from_config_str(iozone_raw, _default_iozone_bin())

    def _min_rate(key: str, default: float) -> float:
        raw = str(sec.get(key, "")).strip()
        if not raw:
            return default
        try:
            return max(0.0, float(raw))
        except ValueError:
            return default

    # 普通默认 100；三星默认写 40（若未单独配置 write_min）
    write_default = 40.0 if samsung else 100.0
    write_min = _min_rate("write_min_mbs", write_default)
    read_min = _min_rate("read_min_mbs", 100.0)
    return max(1, file_size), samsung, iozone_bin, write_min, read_min


def _load_rpmb_settings(path: Path) -> tuple[float, Path]:
    parser = configparser.ConfigParser()
    parser.read(path, encoding="utf-8")
    sec = parser["SETTING"] if "SETTING" in parser else {}
    run_minutes_raw = str(sec.get("run_minutes", "")).strip()
    if run_minutes_raw:
        run_minutes = float(run_minutes_raw)
    elif (legacy := str(sec.get("run_hours", "")).strip()):
        run_minutes = float(legacy) * 60.0
    else:
        run_minutes = 720.0
    assets_raw = str(sec.get("assets_dir", "")).strip()
    assets_dir = _path_from_config_str(assets_raw, vendor_path("rpmb"))
    return max(0.1, run_minutes), assets_dir.resolve()


def order_steps(steps: list[str], flow_no: str) -> list[str]:
    ordered = [s for s in AUTO_STEPS if s in steps]
    if "ota" in ordered and flow_no.strip() and not get_ab_upgrade_for_flow(flow_no):
        ordered = [s for s in ordered if s != "ota"]
    if "rpmb" in ordered and ordered[-1] != "rpmb":
        ordered = [s for s in ordered if s != "rpmb"] + ["rpmb"]
    return ordered


@dataclass
class DeviceStepParams:
    """单台设备各测试项参数（None 表示回退到 config/*.ini）。"""

    loop_num: int | None = None
    stress_max_run_minutes: float | None = None
    iozone_file_size_mb: int | None = None
    samsung_emmc: bool | None = None
    iozone_write_min_mbs: float | None = None
    iozone_read_min_mbs: float | None = None
    reboot_run_hours: float | None = None
    reboot_boot_timeout_sec: int | None = None
    reboot_count: int | None = None
    rpmb_run_minutes: float | None = None
    ota_upgrade_count: int | None = None
    ota_file_path: str | None = None
    ota_retry_limit: int | None = None
    ota_max_run_minutes: int | None = None
    ota_timeout_minutes: int | None = None
    ota_round_interval_minutes: int | None = None


@dataclass
class StepEnv:
    sn: str
    flow_no: str
    log: LogFn
    stop: threading.Event
    report_path: Path
    base_dir: Path = field(default_factory=_app_base_dir)
    loop_num: int | None = None
    params: DeviceStepParams = field(default_factory=DeviceStepParams)
    progress: ProgressFn | None = None
    current_step: str = ""

    def report_progress(
        self, current: int, total: int, text: str = ""
    ) -> None:
        if self.progress is None:
            return
        step = (self.current_step or "").strip()
        if not step:
            return
        cur = max(0, int(current))
        tot = max(0, int(total))
        label = (text or "").strip() or (f"{cur}/{tot}" if tot > 0 else str(cur))
        try:
            self.progress(step, cur, tot, label)
        except Exception:
            pass


def _ts_log(log: LogFn) -> LogFn:
    def _inner(line: str) -> None:
        ts = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        log(f"{ts} {line}")

    return _inner


def _log_report_saved(env: StepEnv, log: LogFn, path: Path, detail: str = "") -> None:
    """记录报告保存结果；若因占用另存则更新 env.report_path。"""
    suffix = f"（{detail}）" if detail else ""
    try:
        saved = path.resolve()
        original = env.report_path.resolve()
    except OSError:
        saved = path
        original = env.report_path
    if saved != original:
        log(f"WARNING 原报告被占用（请先关闭 Excel）: {original}")
        log(f"INFO 测试报告已另存: {saved}{suffix}")
        env.report_path = path
    else:
        log(f"INFO 测试报告已更新: {saved}{suffix}")


def _parse_size_to_kb(token: str) -> int | None:
    m = re.match(
        r"^(\d+(?:\.\d+)?)\s*([KMGT]?)(?:i?B)?$",
        token.strip(),
        re.IGNORECASE,
    )
    if not m:
        return None
    val = float(m.group(1))
    unit = m.group(2).upper()
    if unit == "T":
        return int(val * 1024 * 1024 * 1024)
    if unit == "G":
        return int(val * 1024 * 1024)
    if unit == "M":
        return int(val * 1024)
    return int(val)


def _extract_df_available_kb(lines: list[str]) -> int | None:
    """从 `df -k /data` 或 `df /data` 输出中提取可用空间（KB）。"""
    data_tokens: list[str] = []
    for raw in lines:
        s = raw.strip()
        if not s:
            continue
        low = s.lower()
        if "filesystem" in low or "1k-blocks" in low or "mounted on" in low or "blksize" in low:
            continue
        parts = s.split()
        # 优先取挂载点为 /data 或 /data/local/tmp 的行，或带百分比的行
        for idx, tok in enumerate(parts):
            if re.match(r"^\d+%$", tok) and idx >= 1:
                kb = _parse_size_to_kb(parts[idx - 1])
                if kb is not None:
                    return kb
        data_tokens.extend(parts)
    # 处理超长设备路径换行，或旧版 toolbox `df /data` 无百分比列的情况
    for idx, tok in enumerate(data_tokens):
        if re.match(r"^\d+%$", tok) and idx >= 1:
            kb = _parse_size_to_kb(data_tokens[idx - 1])
            if kb is not None:
                return kb
    if len(data_tokens) >= 4:
        kb = _parse_size_to_kb(data_tokens[3])
        if kb is not None:
            return kb
    return None


def _detect_source_block(sn: str) -> str | None:
    for candidate in _SOURCE_CANDIDATES:
        cmd = build_adb_cmd(["shell", f"dd if={candidate} of=/dev/null bs=1024 count=1"], sn)
        r = subprocess.run(
            cmd,
            env=adb_subprocess_env(),
            capture_output=True,
            text=True,
            **_subprocess_kwargs(),
        )
        output = ((r.stdout or "") + (r.stderr or "")).lower()
        if r.returncode == 0 and "permission denied" not in output and "no such file" not in output:
            return candidate
    for candidate in _SOURCE_CANDIDATES:
        cmd = build_adb_cmd(["shell", "ls", candidate], sn)
        r = subprocess.run(
            cmd,
            env=adb_subprocess_env(),
            capture_output=True,
            text=True,
            **_subprocess_kwargs(),
        )
        output = (r.stdout or "") + (r.stderr or "")
        if r.returncode == 0 and "No such file" not in output:
            return candidate
    return None


def _exe_shell(
    command: str | list[str], log: LogFn, stop: threading.Event
) -> tuple[int, str]:
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        shell=isinstance(command, str),
        env=adb_subprocess_env(),
        **_subprocess_kwargs(),
    )
    lines: list[str] = []
    assert process.stdout is not None
    for raw in iter(process.stdout.readline, b""):
        if not raw:
            break
        if stop.is_set():
            _kill_process_tree(process)
            break
        line = raw.decode("utf-8", errors="ignore").strip()
        if line:
            lines.append(line)
            log(line)
    try:
        code = process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        _kill_process_tree(process)
        code = process.wait(timeout=5)
    return code, "\n".join(lines)


def _is_adb_device_online(sn: str) -> bool:
    try:
        r = subprocess.run(
            build_adb_cmd(["get-state"], sn),
            env=adb_subprocess_env(),
            capture_output=True,
            text=True,
            timeout=5,
            **_subprocess_kwargs(),
        )
        return r.returncode == 0 and "device" in (r.stdout or "").strip().lower()
    except Exception:
        return False


def _wait_adb_online(
    sn: str, stop: threading.Event, *, timeout_sec: float = 60.0
) -> bool:
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        if stop.is_set():
            return False
        if _is_adb_device_online(sn):
            return True
        time.sleep(1.0)
    return _is_adb_device_online(sn)


def _is_remote_iozone_running(sn: str) -> bool:
    try:
        r = subprocess.run(
            build_adb_cmd(
                ["shell", "pidof iozone || ps -A | grep '[i]ozone' || ps | grep '[i]ozone'"],
                sn,
            ),
            env=adb_subprocess_env(),
            capture_output=True,
            text=True,
            timeout=8,
            **_subprocess_kwargs(),
        )
        return bool((r.stdout or "").strip())
    except Exception:
        return False


def _remote_file_nonempty(sn: str, remote_path: str) -> bool:
    try:
        r = subprocess.run(
            build_adb_cmd(["shell", f"test -s {remote_path} && echo OK"], sn),
            env=adb_subprocess_env(),
            capture_output=True,
            text=True,
            timeout=8,
            **_subprocess_kwargs(),
        )
        return "OK" in (r.stdout or "")
    except Exception:
        return False


def run_stress(env: StepEnv, session: HeadlessLogSession) -> bool:
    if not adb_available():
        env.log("ERROR 读写压力: 未找到 adb")
        return False
    cfg_path = _runtime_config_path("emmc_stress.ini")
    try:
        cfg = _read_stress_config(cfg_path)
    except Exception as exc:
        env.log(f"ERROR 读写压力: 配置错误 {exc}")
        return False
    cfg.sn = env.sn.strip()
    loop_override = env.params.loop_num if env.params.loop_num is not None else env.loop_num
    if loop_override is not None:
        cfg.loop_num = loop_override
    max_run_min = 0.0
    if env.params.stress_max_run_minutes is not None:
        max_run_min = max(0.0, float(env.params.stress_max_run_minutes))
    time_mode = max_run_min > 0
    if time_mode:
        cfg.loop_num = 0  # 按时长时不以次数封顶
    elif cfg.loop_num <= 0:
        env.log("ERROR 读写压力: loop_num 必须大于 0")
        return False

    run_count = 0
    write_pass = 0
    read_pass = 0
    check_pass = 0
    start_mono = time.monotonic()
    session.start("stress", cfg.sn, title="读写压力测试", flow_no=env.flow_no)
    log = _ts_log(lambda line: (session.append(line), env.log(line)))
    if time_mode:
        log(f"INFO 停止条件: 按时长（目标 {max_run_min:g} 分钟）")
    else:
        log(f"INFO 停止条件: 按次数（目标 {int(cfg.loop_num)} 次）")

    work_dir = "/data"

    def check_free() -> bool:
        from tools.adb_tools.device_info import _df_avail_kb

        free = _df_avail_kb(cfg.sn, work_dir)
        if not free or free <= 0:
            out = string_run_shell(
                f"adb -s {cfg.sn} shell \n"
                f"df -k {work_dir} 2>/dev/null || df {work_dir} \n"
            )
            free = _extract_df_available_kb(out) or 0
        log(f"INFO free size:{free}")
        if free >= int(cfg.data_free_size):
            log("INFO free size enough")
            return True
        log(
            f"ERROR free size not enough (available={free}KB, required={int(cfg.data_free_size)}KB)"
        )
        return False

    def make_file() -> None:
        out = string_run_shell(
            f"adb -s {cfg.sn} shell \n"
            f"cd {work_dir}/ \n"
            f"dd if={cfg.source_bin_make} of={work_dir}/source.bin bs=1024 count={cfg.make_file} \n"
            "sync \n"
        )
        log(out[-1] if out else "DEBUG make_file done")

    def do_test(i: int) -> None:
        nonlocal write_pass, read_pass, check_pass
        out1 = string_run_shell(
            f"adb -s {cfg.sn} shell \n"
            f"cd {work_dir}/ \n"
            f"dd if={work_dir}/source.bin of={work_dir}/source.bin_copy \n"
            "$? -ne 0 \n"
        )
        if out1 and _SUCCESS_FLAG in out1[-1]:
            write_pass += 1
            log("DEBUG write successful")
        else:
            log(f"ERROR write fail : {out1}")

        out2 = string_run_shell(
            f"adb -s {cfg.sn} shell \n"
            f"cd {work_dir}/ \n"
            f"dd if={work_dir}/source.bin of=/dev/null \n"
            "$? -ne 0 \n"
        )
        if out2 and _SUCCESS_FLAG in out2[-1]:
            read_pass += 1
            log("DEBUG read successful")
        else:
            log(f"ERROR read fail : {out2}")

        out3 = string_run_shell(
            f"adb -s {cfg.sn} shell \n"
            f"cd {work_dir}/ \n"
            f"cmp {work_dir}/source.bin {work_dir}/source.bin_copy \n"
            "$? -ne 0 \n"
        )
        if out3 and _SUCCESS_FLAG in out3[-1]:
            check_pass += 1
            log("DEBUG check successful")
        else:
            log(f"ERROR check fail : {out3}")

        string_run_shell(
            f"adb -s {cfg.sn} shell \n"
            f"rm -f {work_dir}/source.bin \n"
            f"rm -f {work_dir}/source.bin_copy \n"
            "sync \n"
        )

    try:
        root_cmd = build_adb_cmd(["root"], cfg.sn)
        r_root = subprocess.run(
            root_cmd,
            env=adb_subprocess_env(),
            capture_output=True,
            text=True,
            **_subprocess_kwargs(),
        )
        root_out = ((r_root.stdout or "") + (r_root.stderr or "")).lower()
        if r_root.returncode == 0 and "cannot run as root" not in root_out and "not allowed" not in root_out:
            subprocess.run(
                build_adb_cmd(["wait-for-device"], cfg.sn),
                env=adb_subprocess_env(),
                capture_output=True,
                text=True,
                timeout=15,
                **_subprocess_kwargs(),
            )
            time.sleep(1)
        else:
            work_dir = "/data/local/tmp"
            log(f"INFO adb root 不可用，读写压力目录改用 {work_dir}")
        source = _detect_source_block(cfg.sn)
        if not source:
            raise RuntimeError("未检测到可用分区：/dev/block/system 或 /dev/block/by-name/super")
        # 校验当前权限下 source 是否可读，不可读则降级为 /dev/urandom
        probe = string_run_shell(
            f"adb -s {cfg.sn} shell \n"
            f"dd if={source} of=/dev/null bs=1024 count=1 \n"
            "$? -ne 0 \n"
        )
        if not (probe and _SUCCESS_FLAG in probe[-1]):
            source = "/dev/urandom"
            log(f"INFO 分区直读受限，数据源改用 {source}")
        else:
            log(f"INFO source_bin_make auto: {source}")
        cfg.source_bin_make = source
        log("INFO 开始 eMMC 循环读写压力测试")
        loop_total = int(cfg.loop_num)
        duration_sec = max_run_min * 60.0 if time_mode else 0.0
        reached_target = False
        consecutive_free_fail = 0
        if time_mode:
            env.report_progress(0, max(1, int(duration_sec)), f"0.0/{max_run_min:g} 分钟")
        else:
            env.report_progress(0, loop_total, f"0/{loop_total} 次")
        while True:
            if env.stop.is_set():
                log("WARNING 收到停止请求，提前结束测试")
                break
            elapsed = time.monotonic() - start_mono
            if time_mode:
                if elapsed >= duration_sec:
                    reached_target = True
                    log(f"INFO 已达设定时长 {max_run_min:g} 分钟")
                    break
                env.report_progress(
                    min(int(elapsed), int(duration_sec)),
                    max(1, int(duration_sec)),
                    f"{elapsed / 60.0:.1f}/{max_run_min:g} 分钟",
                )
            else:
                if run_count >= loop_total:
                    reached_target = True
                    break
                env.report_progress(
                    run_count + 1, loop_total, f"{run_count + 1}/{loop_total} 次"
                )
            run_count += 1
            if check_free():
                consecutive_free_fail = 0
                log(f"INFO -----------test {run_count}")
                make_file()
                do_test(run_count)
            else:
                consecutive_free_fail += 1
                if consecutive_free_fail >= 3:
                    log("ERROR 连续 3 次检测可用空间不足，中止读写压力测试")
                    break
            if env.stop.is_set():
                log("WARNING 收到停止请求，提前结束测试")
                break
        passed = (
            run_count > 0
            and write_pass == run_count
            and read_pass == run_count
            and check_pass == run_count
            and reached_target
            and not env.stop.is_set()
        )
        write_fail = run_count - write_pass
        read_fail = run_count - read_pass
        check_fail = run_count - check_pass
        elapsed_final = time.monotonic() - start_mono
        if time_mode:
            tot_s = max(1, int(duration_sec))
            cur_s = tot_s if passed else min(tot_s, int(elapsed_final))
            fail_cnt = max(write_fail, read_fail, check_fail)
            lbl = f"{elapsed_final / 60.0:.1f}/{max_run_min:g} 分钟"
            if not passed and fail_cnt > 0:
                lbl = f"{lbl} (失败 {fail_cnt})"
            env.report_progress(cur_s, tot_s, lbl)
        else:
            fail_cnt = max(write_fail, read_fail, check_fail)
            lbl = f"{check_pass}/{loop_total} 次"
            if not passed and fail_cnt > 0:
                lbl = f"{lbl} (失败 {fail_cnt})"
            env.report_progress(min(check_pass, loop_total), loop_total, lbl)
        log("INFO 测试完成")
        log(
            f"INFO {run_count} copies , copy failed {write_fail} , "
            f"read failed {read_fail} , check failed {check_fail}"
        )
        log(
            f"INFO 成功次数 write={write_pass} read={read_pass} check={check_pass} | "
            f"失败次数 write={write_fail} read={read_fail} check={check_fail}"
        )
        duration_min = max(session.elapsed_minutes(), (time.monotonic() - start_mono) / 60.0)
        report_loops = run_count if time_mode else loop_total
        log(
            f"INFO 总测试时长: {duration_min:.1f} 分钟"
            f"（完成 {run_count}"
            + (f" 次，目标 {max_run_min:g} 分钟" if time_mode else f"/{loop_total} 次")
            + "）"
        )
        try:
            from tools.emmc_test.write_xlsx import write_stress_result_xlsx

            xlsx_path = write_stress_result_xlsx(
                _emmc_result_xlsx(_STRESS_RESULT_XLSX),
                make_file_kb=int(cfg.make_file),
                write_pass=write_pass,
                read_pass=read_pass,
                check_pass=check_pass,
                run_count=run_count,
            )
            log(f"INFO 结果已写入 {xlsx_path.resolve()}")
        except Exception as exc:
            fallback = _emmc_output_dir() / "stress_result.txt"
            fallback.write_text(
                "\n".join(
                    [
                        f"size_k={cfg.make_file}",
                        f"write_pass={write_pass}",
                        f"read_pass={read_pass}",
                        f"check_pass={check_pass}",
                        f"run_count={run_count}",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            log(f"WARNING 写 stress_result.xlsx 失败（{exc}），已降级 {fallback.resolve()}")
        try:
            path = write_stress_result(
                sn=cfg.sn,
                loop_num=report_loops,
                make_file_kb=int(cfg.make_file),
                write_pass=write_pass,
                read_pass=read_pass,
                check_pass=check_pass,
                run_count=run_count,
                duration_minutes=duration_min,
                passed=passed,
                report_path=env.report_path,
                base_dir=env.base_dir,
            )
            _log_report_saved(env, log, path)
        except Exception as exc:
            log(f"WARNING 写入测试报告失败: {exc}")
        return passed
    except Exception as exc:
        env.log(f"ERROR {exc}")
        return False
    finally:
        saved = session.close()
        if saved:
            env.log(f"INFO 日志已保存: {saved.resolve()}")


def run_iozone(env: StepEnv, session: HeadlessLogSession) -> bool:
    cfg_path = _runtime_config_path("emmc_iozone.ini")
    file_size_mb, samsung_emmc, iozone_bin, write_min, read_min = _load_iozone_settings(
        cfg_path
    )
    if env.params.iozone_file_size_mb is not None:
        file_size_mb = max(1, int(env.params.iozone_file_size_mb))
    if env.params.samsung_emmc is not None:
        samsung_emmc = bool(env.params.samsung_emmc)
    if env.params.iozone_write_min_mbs is not None:
        write_min = max(0.0, float(env.params.iozone_write_min_mbs))
    if env.params.iozone_read_min_mbs is not None:
        read_min = max(0.0, float(env.params.iozone_read_min_mbs))
    if not iozone_bin.is_file():
        env.log(f"ERROR iozone 文件不存在: {iozone_bin}")
        return False

    session.start("iozone", env.sn, title="iozone读写速度", flow_no=env.flow_no)
    log = _ts_log(lambda line: (session.append(line), env.log(line)))
    silent_log = lambda _line: None
    env.report_progress(0, 3, "0/3 次")
    if samsung_emmc:
        log(
            f"INFO Pass 判定：三星 eMMC，write_rate >= {write_min:g}MB/S"
        )
    else:
        log(
            "INFO Pass 判定：普通 eMMC，"
            f"write_rate >= {write_min:g} 且 read_rate >= {read_min:g}MB/S"
        )
    log(f"INFO 开始 iozone 读写速度测试，文件大小 {file_size_mb}M")
    log(f"INFO iozone: {iozone_bin}")

    # 生产机无法 adb root，/data 不可写；改用 /data/local/tmp（adb 默认可写）
    remote_dir = "/data/local/tmp"
    remote_bin = f"{remote_dir}/iozone"
    remote_xls = f"{remote_dir}/2.xls"
    remote_testfile = f"{remote_dir}/iots"

    result_xlsx = _emmc_result_xlsx(_IOZONE_RESULT_XLSX)
    runs: list[dict[str, str]] = []
    avg: dict[str, str] | None = None
    start_mono = time.monotonic()
    passed = False
    try:
        if result_xlsx.is_file():
            result_xlsx.unlink()
        code, out = _exe_shell(build_adb_cmd(["root"], env.sn), log, env.stop)
        low = (out or "").lower()
        if code != 0 or "cannot run as root" in low or "not allowed" in low:
            log(
                "INFO adb root 不可用（生产机常见），"
                f"改用可写目录 {remote_dir}"
            )
        else:
            _exe_shell(build_adb_cmd(["wait-for-device"], env.sn), log, env.stop)
            time.sleep(1)
        if env.stop.is_set():
            return False
        def _ensure_remote_iozone(cur_log: LogFn) -> None:
            if cur_log is silent_log and _remote_file_nonempty(env.sn, remote_bin):
                _exe_shell(
                    build_adb_cmd(["shell", f"chmod 777 {remote_bin}"], env.sn),
                    silent_log,
                    env.stop,
                )
                return
            c_push, o_push = _exe_shell(
                build_adb_cmd(["push", str(iozone_bin), remote_bin], env.sn),
                cur_log,
                env.stop,
            )
            if c_push != 0 or "permission denied" in (o_push or "").lower():
                raise RuntimeError(
                    f"push iozone 失败 → {remote_bin}\n"
                    f"{(o_push or '').strip() or f'exit={c_push}'}\n"
                    "请确认设备在线且 /data/local/tmp 可写。"
                )
            c_ls, o_ls = _exe_shell(
                build_adb_cmd(["shell", f"ls -l {remote_bin}"], env.sn),
                cur_log,
                env.stop,
            )
            if c_ls != 0 or "No such file" in (o_ls or ""):
                raise RuntimeError(
                    f"设备上未找到 {remote_bin}，push 可能失败。"
                )
            _exe_shell(
                build_adb_cmd(["shell", f"chmod 777 {remote_bin}"], env.sn),
                cur_log,
                env.stop,
            )

        _ensure_remote_iozone(log)
        log(
            f"INFO iozone读写速度测试正在进行,测试文件大小为{file_size_mb}M,"
            "根据配置不同大概需要10-30min"
        )
        average_lst: list[dict[str, str]] = []
        run_log_paths: list[Path] = []
        for i in range(3):
            if env.stop.is_set():
                break
            round_log = log if i == 0 else silent_log
            round_done = False
            for attempt in range(3):
                if env.stop.is_set():
                    break
                if not _is_adb_device_online(env.sn):
                    log(f"WARNING 设备 {env.sn} ADB 暂时离线，等待重连...")
                    if not _wait_adb_online(env.sn, env.stop, timeout_sec=60.0):
                        raise RuntimeError(
                            f"设备 {env.sn} ADB 连接中断且 60 秒内未恢复，请检查 USB 连接或设备是否异常重启"
                        )
                _ensure_remote_iozone(silent_log)
                time.sleep(1)
                _exe_shell(
                    build_adb_cmd(
                        ["shell", f"rm -f {remote_xls} {remote_testfile}"], env.sn
                    ),
                    round_log,
                    env.stop,
                )
                _, ioz_out = _exe_shell(
                    build_adb_cmd(
                        [
                            "shell",
                            f"trap '' HUP; {remote_bin} -I -aezco -i0 -i1 -i2 "
                            f"-s {file_size_mb}M -f {remote_testfile} -Rb {remote_xls}",
                        ],
                        env.sn,
                    ),
                    round_log,
                    env.stop,
                )
                if env.stop.is_set():
                    break
                if "iozone test complete" not in (ioz_out or "").lower():
                    if not _is_adb_device_online(env.sn):
                        log(f"WARNING iozone 执行期间设备 {env.sn} ADB 闪断，正在等待重连...")
                        if not _wait_adb_online(env.sn, env.stop, timeout_sec=60.0):
                            raise RuntimeError(
                                f"设备 {env.sn} 在 iozone 测试期间断开连接且 60 秒内未恢复，请检查 USB 线缆/供电或设备是否重启"
                            )
                    # 若设备端 iozone 因忽略 HUP 仍在后台运行，等待其完成
                    while _is_remote_iozone_running(env.sn) and not env.stop.is_set():
                        time.sleep(3.0)
                        if not _is_adb_device_online(env.sn):
                            _wait_adb_online(env.sn, env.stop, timeout_sec=60.0)
                if not _remote_file_nonempty(env.sn, remote_xls):
                    if attempt < 2 and not env.stop.is_set():
                        log("WARNING 未检测到远端 iozone 结果文件，等待设备稳定后重试...")
                        time.sleep(2.0)
                        continue
                    raise RuntimeError("未拉取到 iozone 结果文件（设备端未生成结果，可能发生重启或断连）")

                tmp_path: Path | None = None
                try:
                    with tempfile.NamedTemporaryFile(suffix=".xls", delete=False) as tmp:
                        tmp_path = Path(tmp.name)
                    _wait_adb_online(env.sn, env.stop, timeout_sec=30.0)
                    _exe_shell(
                        build_adb_cmd(["pull", remote_xls, str(tmp_path)], env.sn),
                        round_log,
                        env.stop,
                    )
                    if not tmp_path.is_file() or tmp_path.stat().st_size <= 0:
                        if attempt < 2 and not env.stop.is_set():
                            continue
                        raise RuntimeError("未拉取到 iozone 结果文件")
                    try:
                        rate = ReadExcel(tmp_path).get_rate()
                    except Exception as exc:
                        log(f"WARNING 解析 iozone 结果失败: {exc}")
                        break
                    writer = ReadExcel.write_dict(result_xlsx, i, rate)
                    writer.close()
                    average_lst.append(rate)
                    runs.append(rate)
                    try:
                        logs_dir = (
                            (env.base_dir or Path(__file__).resolve().parents[2])
                            / "output"
                            / "emmc"
                            / "logs"
                        )
                        flow_clean = re.sub(r'[<>:"/\\|?*]+', "_", (env.flow_no or "").strip()).strip()
                        if flow_clean:
                            logs_dir = logs_dir / flow_clean
                        logs_dir.mkdir(parents=True, exist_ok=True)
                        lp = logs_dir / (
                            f"iozone_{file_size_mb}M_run{i + 1}_{time.strftime('%Y%m%d_%H%M%S')}.log"
                        )
                        lp.write_text(ioz_out or "", encoding="utf-8", errors="replace")
                        run_log_paths.append(lp)
                    except Exception:
                        pass
                    round_done = True
                    break
                finally:
                    if tmp_path is not None:
                        tmp_path.unlink(missing_ok=True)
                    if _is_adb_device_online(env.sn):
                        _exe_shell(
                            build_adb_cmd(
                                ["shell", f"rm -f {remote_xls} {remote_testfile}"], env.sn
                            ),
                            silent_log,
                            env.stop,
                        )
            if not round_done and env.stop.is_set():
                break
            if round_done:
                env.report_progress(i + 1, 3, f"{i + 1}/3 次")
        if average_lst:
            avg = average_rates(average_lst)
            log(f"INFO 测试结果: {avg}")
            writer = ReadExcel.write_dict(result_xlsx, 3, avg)
            writer.close()
        if result_xlsx.is_file():
            log(f"INFO 结果已写入 {result_xlsx.resolve()}")
        if runs and avg is not None:
            passed = (
                _iozone_pass(
                    avg,
                    samsung_emmc=samsung_emmc,
                    write_min_mbs=write_min,
                    read_min_mbs=read_min,
                )
                == "Pass"
            )
        if env.stop.is_set():
            passed = False
            log("WARNING 用户停止测试，判定失败")
        duration_min = max(session.elapsed_minutes(), (time.monotonic() - start_mono) / 60.0)
        screenshot_path: Path | None = None
        try:
            text = session.read_all().strip()
            if text:
                screenshot_path = save_log_text_as_png(
                    text, base_dir=env.base_dir, name_prefix="iozone_log"
                )
                log(f"INFO 测试日志图片: {screenshot_path.resolve()}")
        except Exception as exc:
            log(f"WARNING 生成测试日志图片失败: {exc}")
        if runs and avg is not None:
            try:
                path = write_iozone_result(
                    sn=env.sn,
                    file_size_mb=file_size_mb,
                    runs=runs,
                    average=avg,
                    samsung_emmc=samsung_emmc,
                    write_min_mbs=write_min,
                    read_min_mbs=read_min,
                    duration_minutes=duration_min,
                    report_path=env.report_path,
                    base_dir=env.base_dir,
                    flow_no=env.flow_no,
                    screenshot_path=screenshot_path,
                    log_paths=run_log_paths,
                )
                _log_report_saved(env, log, path)
            except Exception as exc:
                msg = str(exc)
                if isinstance(exc, PermissionError) or "Permission denied" in msg:
                    log(
                        "WARNING 写入测试报告失败：报告正被 Excel 打开，"
                        f"请关闭后重试（截图已生成）: {exc}"
                    )
                else:
                    log(f"WARNING 写入测试报告失败: {exc}")
        elif not runs or avg is None:
            log("WARNING 未写入测试报告：iozone 未产生有效测试结果")
        done_rounds = len(runs)
        env.report_progress(done_rounds, 3, f"{done_rounds}/3 次")
        return passed
    except Exception as exc:
        env.log(f"ERROR {exc}")
        done_rounds = len(runs) if "runs" in locals() else 0
        env.report_progress(done_rounds, 3, f"{done_rounds}/3 次")
        return False
    finally:
        saved = session.close()
        if saved:
            env.log(f"INFO 日志已保存: {saved.resolve()}")


def run_reboot(env: StepEnv, session: HeadlessLogSession) -> bool:
    cfg_path = _runtime_config_path("emmc_reboot.ini")
    cfg = load_reboot_config(cfg_path)
    cfg.device_sn = env.sn
    if env.params.reboot_boot_timeout_sec is not None:
        cfg.boot_timeout_sec = max(60, int(env.params.reboot_boot_timeout_sec))
    # 次数 / 时长二选一：有有效次数则按次数，否则按时长
    count = max(0, int(env.params.reboot_count or 0))
    if count > 0:
        cfg.target_count = count
    else:
        cfg.target_count = 0
        if env.params.reboot_run_hours is not None:
            cfg.run_hours = max(1.0 / 60.0, float(env.params.reboot_run_hours))
    session.start("reboot", env.sn, title="reboot测试", flow_no=env.flow_no)
    log = _ts_log(lambda line: (session.append(line), env.log(line)))
    log("INFO 开始 reboot 循环测试")
    result = "FAIL"
    success = fail = anomaly = 0
    duration_hours = 0.0
    stop_reason = ""
    try:
        runner = RebootTestRunner(
            cfg,
            log=log,
            stop=env.stop,
            on_progress=lambda c, t, s: env.report_progress(c, t, s),
        )
        success, fail, stop_reason, duration_hours, anomaly = runner.run_test_loop()
        target_count = max(0, int(cfg.target_count or 0))
        count_mode = target_count > 0
        if count_mode:
            msg = f"{success}/{target_count} 次" if fail == 0 else f"{success}/{target_count} 次 (失败 {fail})"
            env.report_progress(success, target_count, msg)
        else:
            from tools.emmc_test.reboot_test import format_reboot_duration_progress

            tot_sec = max(1, int(cfg.run_hours * 3600))
            cur_sec = min(tot_sec, int(duration_hours * 3600))
            msg = format_reboot_duration_progress(duration_hours, cfg.run_hours, fail)
            env.report_progress(cur_sec, tot_sec, msg)
        total_rounds = success + fail
        if count_mode:
            reached = total_rounds >= target_count
        else:
            reached = duration_hours >= cfg.run_hours * 0.999
        if fail == 0 and anomaly == 0 and reached:
            result = "PASS"
        elif env.stop.is_set() and fail == 0 and anomaly == 0 and reached:
            result = "PASS"
        elif env.stop.is_set() and fail == 0 and not reached:
            result = "FAIL"
            if count_mode:
                log(
                    f"WARNING 未达设定次数 {target_count}（已完成 {total_rounds}）即停止，判定失败"
                )
            else:
                log(f"WARNING 未达设定时长 {cfg.run_hours:g} 小时即停止，判定失败")
        else:
            result = "FAIL"
        log(f"INFO 停止原因: {stop_reason}")
        if anomaly:
            log(f"ERROR 异常重启合计 {anomaly} 次（详见上方日志）")
        passed = result == "PASS"
        screenshot_path: Path | None = None
        try:
            text = session.read_all().strip()
            if text:
                screenshot_path = save_log_text_as_png(text, base_dir=env.base_dir, name_prefix="reboot_log")
                log(f"INFO 测试日志图片: {screenshot_path.resolve()}")
        except Exception as exc:
            log(f"WARNING 生成测试日志图片失败: {exc}")
        log_hours = session.elapsed_minutes() / 60.0
        if log_hours > duration_hours:
            duration_hours = log_hours
        log(
            f"INFO 总测试时长: {duration_hours:.2f} 小时"
            f"（成功 {success} 次，失败 {fail} 次"
            + (f"，异常重启 {anomaly} 次" if anomaly else "")
            + (f"，目标 {target_count} 次" if target_count > 0 else "")
            + "）"
        )
        try:
            path = write_reboot_result(
                sn=env.sn,
                success_count=success,
                fail_count=fail,
                duration_hours=duration_hours,
                passed=passed,
                report_path=env.report_path,
                base_dir=env.base_dir,
                flow_no=env.flow_no,
                screenshot_path=screenshot_path,
            )
            _log_report_saved(env, log, path, "reboot → 模版第32行")
        except Exception as exc:
            log(f"WARNING 写入测试报告失败: {exc}")
        return passed
    except Exception as exc:
        env.log(f"ERROR 测试异常: {exc}")
        return False
    finally:
        saved = session.close()
        if saved:
            env.log(f"INFO 日志已保存: {saved.resolve()}")


def run_ota(env: StepEnv, session: HeadlessLogSession) -> bool:
    cfg_path = _runtime_config_path("emmc_ota_v5.ini")
    cfg = load_ota_v5_config(cfg_path, env.base_dir)
    cfg.device_sn = env.sn
    if env.params.ota_upgrade_count is not None:
        cfg.upgrade_count = max(0, int(env.params.ota_upgrade_count))
    if env.params.ota_retry_limit is not None:
        cfg.retry_limit = max(1, int(env.params.ota_retry_limit))
    if env.params.ota_max_run_minutes is not None:
        cfg.max_run_minutes = max(0, int(env.params.ota_max_run_minutes))
    if env.params.ota_timeout_minutes is not None:
        cfg.timeout_minutes = max(1, int(env.params.ota_timeout_minutes))
    if env.params.ota_round_interval_minutes is not None:
        cfg.round_interval_minutes = max(0, int(env.params.ota_round_interval_minutes))
    if cfg.upgrade_count <= 0 and cfg.max_run_minutes <= 0:
        env.log("ERROR OTA: 请设置升级轮次或最大运行时长")
        return False
    # 不使用 ini / vendor 默认包：必须由界面显式选择路径
    ota_raw = (env.params.ota_file_path or "").strip()
    if not ota_raw:
        env.log("ERROR OTA 路径不能为空，请选择升级包")
        return False
    raw = Path(ota_raw)
    cfg.ota_file_path = raw if raw.is_absolute() else (env.base_dir / raw).resolve()
    if not Path(cfg.ota_file_path).is_file():
        env.log(f"ERROR OTA 文件不存在: {cfg.ota_file_path}")
        return False
    session.start("ota_v5", env.sn, title="OTA测试v5", flow_no=env.flow_no)
    log = _ts_log(lambda line: (session.append(line), env.log(line)))
    log("INFO 开始 OTA v5 循环升级测试")
    result = "FAIL"
    completed = failed_rounds = 0
    duration_min = 0.0
    stop_reason = ""
    try:
        runner = OtaUpgradeRunner(
            cfg,
            base_dir=env.base_dir,
            log=log,
            stop=env.stop,
            on_progress=lambda c, t, s: env.report_progress(c, t, s),
        )
        completed, failed_rounds, stop_reason, duration_min = runner.run_test_loop()
        result = judge_ota_result(
            user_stopped=env.stop.is_set(),
            completed=completed,
            failed_rounds=failed_rounds,
            upgrade_count=cfg.upgrade_count,
            stop_reason=stop_reason,
        )
        log(f"INFO 停止原因: {stop_reason}")
        passed = result == "PASS"
        screenshot_path: Path | None = None
        try:
            text = session.read_all().strip()
            if text:
                screenshot_path = save_log_text_as_png(text, base_dir=env.base_dir, name_prefix="ota_v5_log")
                log(f"INFO 测试日志图片: {screenshot_path.resolve()}")
        except Exception as exc:
            log(f"WARNING 生成测试日志图片失败: {exc}")
        log_duration = session.elapsed_minutes()
        if log_duration > duration_min:
            duration_min = log_duration
        log(
            f"INFO 总测试时长: {duration_min:.1f} 分钟"
            f"（成功 {completed} 轮，失败 {failed_rounds} 轮）"
        )
        try:
            path = write_ota_result(
                sn=env.sn,
                success_count=completed,
                fail_count=failed_rounds,
                duration_minutes=duration_min,
                passed=passed,
                report_path=env.report_path,
                base_dir=env.base_dir,
                flow_no=env.flow_no,
                screenshot_path=screenshot_path,
            )
            _log_report_saved(env, log, path, "OTA → 升级压力测试 模版第38行")
        except Exception as exc:
            log(f"WARNING 写入测试报告失败: {exc}")
        return passed
    except Exception as exc:
        env.log(f"ERROR 测试异常: {exc}")
        return False
    finally:
        saved = session.close()
        if saved:
            env.log(f"INFO 日志已保存: {saved.resolve()}")


def _kill_rpmb_on_device(sn: str) -> None:
    stop_cmd = build_adb_cmd(
        [
            "shell",
            f"pkill -f {_RPMB_SCRIPT} 2>/dev/null; "
            "pkill -f mmc_utils 2>/dev/null; "
            "killall mmc_utils 2>/dev/null; "
            "true",
        ],
        sn,
    )
    subprocess.run(
        stop_cmd,
        shell=False,
        env=adb_subprocess_env(),
        capture_output=True,
        timeout=15,
        **_subprocess_kwargs(),
    )


def _run_rpmb_script(
    sn: str,
    duration_sec: int,
    log: LogFn,
    stop: threading.Event,
    progress: Callable[[int, int, str], None] | None = None,
) -> bool:
    shell_cmd = build_adb_cmd(
        [
            "shell",
            "cd /data && chmod 777 mmc_utils rpmb_test_v7_dev.sh rpmbkey.bin "
            f"&& /system/bin/sh ./{_RPMB_SCRIPT}",
        ],
        sn,
    )
    process = subprocess.Popen(
        shell_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        shell=False,
        env=adb_subprocess_env(),
        **_subprocess_kwargs(),
    )

    def _reader() -> None:
        assert process.stdout is not None
        for raw in iter(process.stdout.readline, b""):
            if not raw:
                break
            if stop.is_set():
                break
            line = raw.decode("utf-8", errors="ignore").strip()
            if line:
                log(line)

    def _emit(elapsed: int) -> None:
        if progress is None:
            return
        tot = max(1, int(duration_sec))
        cur = min(tot, max(0, int(elapsed)))
        try:
            progress(
                cur,
                tot,
                f"{cur // 60}/{max(1, tot // 60)} 分钟",
            )
        except Exception:
            pass

    reader = threading.Thread(target=_reader, daemon=True)
    reader.start()
    deadline = time.monotonic() + duration_sec
    start = time.monotonic()
    early_exit = False
    _emit(0)
    try:
        while time.monotonic() < deadline:
            if stop.is_set():
                early_exit = True
                break
            if process.poll() is not None:
                early_exit = True
                break
            _emit(int(time.monotonic() - start))
            time.sleep(1)
    finally:
        if not early_exit:
            _kill_rpmb_on_device(sn)
        elif process.poll() is not None and not stop.is_set():
            _kill_rpmb_on_device(sn)
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            pass
        reader.join(timeout=5)
        if process.poll() is None:
            _kill_process_tree(process)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
    return not early_exit


def run_rpmb(env: StepEnv, session: HeadlessLogSession) -> bool:
    cfg_path = _runtime_config_path("emmc_rpmb.ini")
    run_minutes, assets_dir = _load_rpmb_settings(cfg_path)
    if env.params.rpmb_run_minutes is not None:
        run_minutes = max(0.1, float(env.params.rpmb_run_minutes))
    missing = [name for name in _RPMB_FILES if not (assets_dir / name).is_file()]
    if missing:
        env.log(f"ERROR RPMB 资源文件缺失: {', '.join(missing)} 目录: {assets_dir}")
        return False
    duration_sec = int(run_minutes * 60)
    session.start("rpmb", env.sn, title="RPMB测试", flow_no=env.flow_no)
    log = _ts_log(lambda line: (session.append(line), env.log(line)))
    log(f"INFO 开始 RPMB 测试，设定运行 {run_minutes:g} 分钟")
    log(f"INFO 资源目录: {assets_dir}")
    start_mono = time.monotonic()
    passed = False
    try:
        # /data 需 root 才能写；顺序与 GUI RpmbTestPane 一致：先 root 再 push
        log("INFO adb root")
        code, out = _exe_shell(build_adb_cmd(["root"], env.sn), log, env.stop)
        low = out.lower()
        if code != 0 or "cannot run as root" in low or "not allowed" in low:
            hint = (
                "请确认：设备已连接且为 userdebug/eng；"
                "未弹出未授权；必要时重新插拔 USB 或执行 adb kill-server。"
            )
            raise RuntimeError(f"adb root 失败: {out.strip() or f'exit={code}'}\n{hint}")
        _exe_shell(build_adb_cmd(["wait-for-device"], env.sn), log, env.stop)
        time.sleep(0.5)
        for name in _RPMB_FILES:
            src = assets_dir / name
            log(f"INFO push {name} -> /data/")
            code, out = _exe_shell(
                build_adb_cmd(["push", str(src), "/data/"], env.sn), log, env.stop
            )
            if code != 0 or "permission denied" in out.lower():
                detail = out.strip() or f"exit={code}"
                raise RuntimeError(
                    f"push 失败: {name}\n{detail}\n"
                    "请确认：已 adb root、/data 可写、USB 未断开；"
                    "若提示 device offline，请重新插拔后再试。"
                )
        _kill_rpmb_on_device(env.sn)
        log("INFO 已清理设备端残留 RPMB 进程")
        log(f"INFO 运行 /system/bin/sh ./{_RPMB_SCRIPT}（设定运行 {run_minutes:g} 分钟）")
        completed = _run_rpmb_script(
            env.sn,
            duration_sec,
            log,
            env.stop,
            progress=lambda c, t, s: env.report_progress(c, t, s),
        )
        if env.stop.is_set():
            log("WARNING 用户停止测试")
            passed = False
        elif completed:
            log(f"INFO 已达设定运行时间 {run_minutes:g} 分钟，测试通过")
            passed = True
        else:
            log("ERROR 未达设定运行时间，脚本中途退出，测试失败")
            passed = False
        duration_hours = max(session.elapsed_minutes(), (time.monotonic() - start_mono) / 60.0) / 60.0
        actual_min = duration_hours * 60.0
        tot_sec = max(1, int(duration_sec))
        cur_sec = min(tot_sec, int(actual_min * 60.0)) if not passed else tot_sec
        env.report_progress(
            cur_sec,
            tot_sec,
            f"{run_minutes:g}/{run_minutes:g} 分钟" if passed else f"{actual_min:.1f}/{run_minutes:g} 分钟",
        )
        screenshot_path: Path | None = None
        try:
            text = session.read_all().strip()
            if text:
                screenshot_path = save_log_text_as_png(text, base_dir=env.base_dir, name_prefix="rpmb_log")
                log(f"INFO 测试日志图片: {screenshot_path.resolve()}")
        except Exception as exc:
            log(f"WARNING 生成测试日志图片失败: {exc}")
        log(f"INFO 总测试时长: {duration_hours:.2f} 小时")
        try:
            path = write_rpmb_result(
                sn=env.sn,
                duration_hours=duration_hours,
                passed=passed,
                report_path=env.report_path,
                base_dir=env.base_dir,
                flow_no=env.flow_no,
                screenshot_path=screenshot_path,
            )
            _log_report_saved(env, log, path, "RPMB → 模版第35行")
        except Exception as exc:
            log(f"WARNING 写入测试报告失败: {exc}")
        return passed
    except Exception as exc:
        env.log(f"ERROR {exc}")
        return False
    finally:
        saved = session.close()
        if saved:
            env.log(f"INFO 日志已保存: {saved.resolve()}")


_STEP_RUNNERS = {
    "iozone": run_iozone,
    "stress": run_stress,
    "reboot": run_reboot,
    "ota": run_ota,
    "rpmb": run_rpmb,
}


def run_pipeline(
    env: StepEnv,
    steps: list[str],
    *,
    stop_on_fail: bool,
    global_stop: threading.Event | None = None,
    on_step: Callable[[str, str], None] | None = None,
) -> bool:
    """在一台设备上顺序执行多项测试，返回是否全部通过。

    on_step(step_id, status)：status 为 running / Pass / Fail。
    """
    requested = [s for s in AUTO_STEPS if s in steps]
    if requested:
        env.log(
            "INFO 勾选测试项: "
            + " → ".join(AUTO_LABELS.get(s, s) for s in requested)
        )
    ordered = order_steps(steps, env.flow_no)
    if "ota" in requested and "ota" not in ordered:
        env.log("INFO 报告头部未勾选 A/B 升级，已跳过 OTA")
    if not ordered:
        if requested and set(requested) <= {"ota"}:
            env.log(
                "ERROR 当前流程非 A/B 升级，OTA 不会执行。"
                "请在「填写报告头部」勾选 A/B 升级，或再勾选其他测试项。"
            )
        elif not requested:
            env.log("ERROR 未选择任何测试项")
        else:
            env.log("ERROR 没有可执行的测试项")
        return False
    env.log(
        "INFO 执行顺序: " + " → ".join(AUTO_LABELS.get(s, s) for s in ordered)
    )
    all_passed = True
    for step in ordered:
        if env.stop.is_set() or (global_stop is not None and global_stop.is_set()):
            env.log("INFO 收到停止请求，流水线中止")
            return False
        env.log(f"INFO ── 开始: {AUTO_LABELS[step]} ──")
        env.current_step = step
        if on_step is not None:
            try:
                on_step(step, "running")
            except Exception:
                pass
        env.report_progress(0, 0, "进行中")
        runner = _STEP_RUNNERS.get(step)
        if runner is None:
            env.log(f"ERROR 未知步骤: {step}")
            all_passed = False
            if on_step is not None:
                try:
                    on_step(step, "Fail")
                except Exception:
                    pass
            env.current_step = ""
            if stop_on_fail:
                return False
            continue
        session = HeadlessLogSession()
        passed = runner(env, session)
        verdict = "Pass" if passed else "Fail"
        env.log(f"INFO ── 结束: {AUTO_LABELS[step]} → {verdict} ──")
        if on_step is not None:
            try:
                on_step(step, verdict)
            except Exception:
                pass
        env.current_step = ""
        if not passed:
            all_passed = False
            if stop_on_fail:
                return False
    return all_passed
