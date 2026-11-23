#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用 dumpsys input 读蓝牙遥控器的 VID / PID。"""

from __future__ import annotations

import re

from tools.adb_tools.core import run_adb_shell

_BUS_BLUETOOTH = 0x0005
_DEVICE = re.compile(r"^\s*(?:Device\s+)?\d+\s*:\s*(.+?)\s*$")
_IDENT = re.compile(
    r"bus=0x([0-9a-fA-F]+)\s*,\s*vendor=0x([0-9a-fA-F]+)\s*,\s*product=0x([0-9a-fA-F]+)",
    re.IGNORECASE,
)


def format_usb_id(raw: str) -> str:
    return f"0x{int(raw, 16) & 0xFFFF:04X}"


def parse_bluetooth_ids(text: str) -> list[dict[str, str]]:
    """解析 dumpsys input，只留蓝牙输入设备。"""
    found: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    name = ""
    for line in text.splitlines():
        header = _DEVICE.match(line)
        if header and "Identifier" not in line and "=" not in header.group(1):
            name = header.group(1).strip() or "未命名"
            continue
        ident = _IDENT.search(line)
        if not ident:
            continue
        if int(ident.group(1), 16) != _BUS_BLUETOOTH:
            continue
        vendor = ident.group(2)
        product = ident.group(3)
        if int(vendor, 16) == 0 and int(product, 16) == 0:
            continue
        vid = format_usb_id(vendor)
        pid = format_usb_id(product)
        label = name or "未命名"
        key = (vid, pid, label)
        if key in seen:
            continue
        seen.add(key)
        found.append({"name": label, "vid": vid, "pid": pid, "bus": "bluetooth"})
    return found


def query_bluetooth_ids(device: str) -> dict:
    sn = device.strip()
    if not sn:
        raise RuntimeError("请先选择设备")
    try:
        result = run_adb_shell(sn, "dumpsys input")
    except RuntimeError as exc:
        raise RuntimeError(str(exc)) from exc
    text = result.stdout or ""
    if result.returncode != 0 and not text.strip():
        detail = (result.stderr or "").strip().splitlines()
        raise RuntimeError(detail[-1][:240] if detail else "dumpsys input 失败")
    devices = parse_bluetooth_ids(text)
    return {
        "ok": True,
        "message": "" if devices else "未读到蓝牙输入设备的 VID / PID",
        "devices": devices,
    }
