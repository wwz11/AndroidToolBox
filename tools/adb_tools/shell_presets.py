#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ADB Shell 快捷命令预设（可自定义、持久化）。

内置列表随安装包更新。用户自己加的条目会保留；升级时只补新命令、
按显示名修正已有内置命令。userdata 里的旧列表不再把新默认挡掉。
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, TypedDict

from tools.settings_store import get, put

_SETTINGS_KEY = "adb_tools.shell_presets"
_PACK_KEY = "adb_tools.shell_presets_pack"


class ShellPreset(TypedDict):
    cmd: str
    label: str


DEFAULT_SHELL_PRESETS: list[ShellPreset] = [
    {
        "cmd": "am start -n com.android.tv.settings/.MainSettings",
        "label": "打开settings",
    },
    {"cmd": 'getprop | grep "oem"', "label": "OEM"},
    {"cmd": "dumpsys wifi | grep CountryCode", "label": "国家码（U）"},
    {
        "cmd": "getprop | grep first_api_leve",
        "label": "第一次过认证版本(O:26/P:28/Q:29/R:30/S:31/U:34)",
    },
    {"cmd": "getprop ro.boot.verifiedbootstate", "label": "verifiedbootstate"},
    {"cmd": "cat /sys/class/net/eth0/address", "label": "emac"},
    {"cmd": "lpdump", "label": "super分区大小"},
    {"cmd": "free -h", "label": "zramsize（swap）大小"},
    {"cmd": "getprop | grep oemmodel", "label": "NetflixModelGroup"},
    {
        "cmd": "cd /data/local/tmp && dd if=/dev/zero of=fill.bin bs=100M",
        "label": "dd命令填充sd卡",
    },
    {"cmd": "echo c > /proc/sysrq-trigger", "label": "kernel panic"},
]


def _normalize_item(raw: Any) -> ShellPreset | None:
    if not isinstance(raw, dict):
        return None
    # 保留多行命令（仅去掉首尾空白），支持一条快捷指令跑多条 shell
    cmd = str(raw.get("cmd", "")).replace("\r\n", "\n").replace("\r", "\n").strip()
    if not cmd or cmd == "@screenshot":
        return None
    first = next((ln.strip() for ln in cmd.split("\n") if ln.strip()), cmd)
    label = str(raw.get("label", "")).strip() or first
    return {"cmd": cmd, "label": label}


def _packaged_sig() -> str:
    blob = json.dumps(DEFAULT_SHELL_PRESETS, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def _merge_bundled(saved: list[ShellPreset]) -> list[ShellPreset]:
    """把本版内置命令补进已保存列表：同命令跳过，同名则更新命令，其余追加。"""
    out = [{"cmd": p["cmd"], "label": p["label"]} for p in saved]
    by_cmd = {p["cmd"]: i for i, p in enumerate(out)}
    by_label = {p["label"]: i for i, p in enumerate(out)}
    for item in DEFAULT_SHELL_PRESETS:
        cmd, label = item["cmd"], item["label"]
        if cmd in by_cmd:
            continue
        idx = by_label.get(label)
        if idx is not None:
            old_cmd = out[idx]["cmd"]
            out[idx]["cmd"] = cmd
            by_cmd.pop(old_cmd, None)
            by_cmd[cmd] = idx
            continue
        by_cmd[cmd] = len(out)
        by_label.setdefault(label, len(out))
        out.append({"cmd": cmd, "label": label})
    return out


def load_shell_presets() -> list[ShellPreset]:
    saved = get(_SETTINGS_KEY, None)
    out: list[ShellPreset] = []
    if isinstance(saved, list):
        for item in saved:
            norm = _normalize_item(item)
            if norm is not None:
                out.append(norm)
    sig = _packaged_sig()
    last = str(get(_PACK_KEY, "") or "")
    if not out:
        put(_PACK_KEY, sig)
        save_shell_presets(list(DEFAULT_SHELL_PRESETS))
        return list(DEFAULT_SHELL_PRESETS)
    if last != sig:
        merged = _merge_bundled(out)
        put(_PACK_KEY, sig)
        save_shell_presets(merged)
        return merged
    return out


def save_shell_presets(presets: list[ShellPreset]) -> None:
    cleaned: list[ShellPreset] = []
    seen: set[str] = set()
    for item in presets:
        norm = _normalize_item(item)
        if norm is None:
            continue
        key = norm["cmd"]
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(norm)
    if not cleaned:
        cleaned = list(DEFAULT_SHELL_PRESETS)
    put(_SETTINGS_KEY, cleaned)


def preset_combo_label(preset: ShellPreset) -> str:
    return f"{preset['cmd']}  ({preset['label']})"


def preset_combo_labels(presets: list[ShellPreset]) -> list[str]:
    return [preset_combo_label(p) for p in presets]
