#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
通过 ADB 向设备 /sys/class/unifykeys 写入并回读校验。

设备端流程（需 root）:
  cd /sys/class/unifykeys
  echo <key名> > name
  echo <内容> > write
  cat read
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

# 通用 ADB 运行时与命令原语统一由 tools.adb_runtime 提供并向后兼容导出
from tools.adb_runtime import (
    _subprocess_kwargs,
    _try_restart_adb_server,
    adb_available,
    adb_subprocess_env,
    build_adb_cmd,
    get_ready_devices,
    list_adb_devices,
    resolve_adb_exe,
    run_adb,
)

UNIFYKEYS_DIR = "/sys/class/unifykeys"
DEFAULT_KEY = "usid"
_LIST_LINE_RE = re.compile(r"^\s*(\d+):\s*([^,]+),\s*([^,]+),\s*(\S+)")


@dataclass(frozen=True)
class UnifyKeyInfo:
    index: str
    name: str
    key_type: str
    attr: str

    def label(self) -> str:
        return f"{self.index}: {self.name}"


def filter_normal_keys(keys: list[UnifyKeyInfo]) -> list[UnifyKeyInfo]:
    return [k for k in keys if k.key_type.lower() == "normal"]


def parse_keys_from_list(text: str) -> list[UnifyKeyInfo]:
    keys: list[UnifyKeyInfo] = []
    for line in text.splitlines():
        m = _LIST_LINE_RE.match(line)
        if m:
            keys.append(
                UnifyKeyInfo(
                    m.group(1),
                    m.group(2).strip(),
                    m.group(3).strip(),
                    m.group(4).strip(),
                )
            )
    return keys


def pick_device(explicit: str | None) -> str | None:
    if explicit:
        return explicit
    ready = get_ready_devices()
    if not ready:
        return None
    if len(ready) == 1:
        return ready[0]
    print("多台设备已连接，请用 -s 指定序列号：")
    for i, s in enumerate(ready, 1):
        print(f"  {i}) {s}")
    while True:
        raw = input(f"选择 (1-{len(ready)}): ").strip()
        if raw.isdigit() and 1 <= int(raw) <= len(ready):
            return ready[int(raw) - 1]
        print("无效输入。")


def adb_shell(script: str, device: str | None, use_su: bool) -> tuple[int, str, str]:
    if use_su:
        escaped = script.replace("'", "'\"'\"'")
        full = f"su 0 sh -c '{escaped}'"
    else:
        full = script
    r = run_adb(["shell", full], device)
    return r.returncode, r.stdout, r.stderr


def sh_quote(s: str) -> str:
    return "'" + s.replace("'", "'\"'\"'") + "'"


def list_keys(device: str | None, use_su: bool) -> str:
    code, out, err = adb_shell(f"cat {UNIFYKEYS_DIR}/list", device, use_su)
    if code != 0:
        raise RuntimeError(err.strip() or "读取 list 失败")
    return out


def fetch_key_list(device: str | None, use_su: bool, normal_only: bool = True) -> list[UnifyKeyInfo]:
    raw = list_keys(device, use_su)
    keys = parse_keys_from_list(raw)
    if not keys:
        raise RuntimeError("未能解析 key 列表，请确认设备支持 unifykeys")
    if normal_only:
        keys = filter_normal_keys(keys)
    if not keys:
        raise RuntimeError("未找到 normal 类型的 key")
    return keys


def validate_key_name(key: str) -> str:
    name = key.strip()
    if not name:
        raise ValueError("key 名不能为空")
    if not re.match(r"^[\w.]+$", name):
        raise ValueError("key 名仅允许字母数字下划线和点")
    return name


def read_key(key: str, device: str | None, use_su: bool) -> str:
    """读取 unifykey 当前值：echo KEY > name; cat read（不写入）。"""
    name = validate_key_name(key)
    script = (
        f"cd {UNIFYKEYS_DIR} && "
        f"echo {name} > name && "
        f"cat read"
    )
    code, out, err = adb_shell(script, device, use_su)
    if code != 0:
        raise RuntimeError(err.strip() or f"读取 {name} 失败")
    return out.strip()


def write_and_read(
    key: str,
    value: str,
    device: str | None,
    use_su: bool,
) -> str:
    name = validate_key_name(key)
    script = (
        f"cd {UNIFYKEYS_DIR} && "
        f"echo {name} > name && "
        f"echo {sh_quote(value)} > write && "
        f"cat read"
    )
    code, out, err = adb_shell(script, device, use_su)
    if code != 0:
        raise RuntimeError(err.strip() or f"写入 {name} 失败")
    return out.strip()


def read_value_from_file(path: Path, line_no: int) -> str:
    lines = [ln.strip() for ln in path.read_text(encoding="utf-8", errors="replace").splitlines()]
    lines = [ln for ln in lines if ln]
    if not lines:
        raise ValueError("文件无有效行")
    if line_no < 1 or line_no > len(lines):
        raise ValueError(f"行号 {line_no} 超出范围 (1-{len(lines)})")
    return lines[line_no - 1]


def main() -> int:
    parser = argparse.ArgumentParser(description="ADB 写入 unifykeys 并 cat read 校验")
    parser.add_argument("-s", "--device", help="adb 设备序列号")
    parser.add_argument("-k", "--key", default=DEFAULT_KEY, help=f"key 名，对应 echo KEY > name（默认: {DEFAULT_KEY}）")
    parser.add_argument("-v", "--value", help="要写入的内容")
    parser.add_argument("-f", "--file", type=Path, help="从 txt 取一行作为写入值")
    parser.add_argument("-l", "--line", type=int, default=1, help="配合 -f 使用，取第几行（默认 1）")
    parser.add_argument("--list-keys", action="store_true", help="adb shell cat .../list")
    parser.add_argument(
        "--read",
        action="store_true",
        help="仅读取 key 当前值（echo KEY > name; cat read，不写入）",
    )
    parser.add_argument("--no-su", action="store_true", help="不用 su（仅当 adb 已是 root shell 时）")
    parser.add_argument("--no-verify", action="store_true", help="写入后不比对 read 与写入值")
    args = parser.parse_args()

    use_su = not args.no_su

    if not adb_available():
        print(
            "[错误] 未找到 adb 或 adb 不可用（可设置 TOOLBOX_ADB 或安装 platform-tools）",
            file=sys.stderr,
        )
        return 1

    device = pick_device(args.device)
    if device is None:
        print("[错误] 无 device 状态设备", file=sys.stderr)
        return 1

    if args.list_keys:
        try:
            keys = fetch_key_list(device, use_su, normal_only=True)
            print(f"{len(keys)} normal keys:")
            for k in keys:
                print(f"  {k.index}: {k.name}, {k.key_type}, {k.attr}")
        except RuntimeError as e:
            print(f"[错误] {e}", file=sys.stderr)
            return 1
        return 0

    try:
        key_name = validate_key_name(args.key)
    except ValueError as e:
        print(f"[错误] {e}", file=sys.stderr)
        return 1

    if args.read:
        print(f"设备: {device}")
        print(f"key : {key_name}")
        if use_su:
            print("模式: su 0 sh -c ...")
        try:
            read_back = read_key(key_name, device, use_su)
        except RuntimeError as e:
            print(f"[错误] {e}", file=sys.stderr)
            return 1
        print(f"read: {read_back}")
        print("[完成] 读取成功")
        return 0

    value = args.value
    if args.file:
        try:
            value = read_value_from_file(args.file, args.line)
        except (OSError, ValueError) as e:
            print(f"[错误] {e}", file=sys.stderr)
            return 1
    if not value:
        print("[错误] 请指定 -v 或 -f（读取请用 --read）", file=sys.stderr)
        return 1

    print(f"设备: {device}")
    print(f"key : {key_name}")
    print(f"写入: {value}")
    if use_su:
        print("模式: su 0 sh -c ...")

    try:
        read_back = write_and_read(key_name, value, device, use_su)
    except RuntimeError as e:
        print(f"[错误] {e}", file=sys.stderr)
        print("提示: 多数机型需 root，请确认 adb root 或 su 可用；可尝试去掉 --no-su", file=sys.stderr)
        return 1

    print(f"read: {read_back}")
    if not args.no_verify and read_back != value.strip():
        print("[警告] 回读与写入不一致（部分 key 可能只存部分字节或格式不同）", file=sys.stderr)
        return 2

    print("[完成] 写入成功")
    return 0


if __name__ == "__main__":
    sys.exit(main())
