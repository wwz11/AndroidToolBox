#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ADB 网络连接（adb connect / disconnect）。"""

from __future__ import annotations

import re

from tools.adb_runtime import run_adb

_DEFAULT_PORT = 5555
_IPV4_PORT_RE = re.compile(
    r"^(?P<host>\d{1,3}(?:\.\d{1,3}){3})(?::(?P<port>\d+))?$"
)


def normalize_network_target(raw: str) -> str:
    """规范为 ``host:port``；仅 IP 时默认端口 5555。"""
    s = raw.strip()
    if not s:
        raise ValueError("请输入 IP 地址或 IP:端口")

    # 已是 host:port（IPv6 可用 [fe80::1]:5555）
    if s.startswith("[") and "]" in s:
        host, _, port = s.partition("]:")
        inner = host[1:].strip()
        if not inner:
            raise ValueError("IPv6 地址格式无效")
        p = port.strip() if port else str(_DEFAULT_PORT)
        if not p.isdigit() or not (1 <= int(p) <= 65535):
            raise ValueError("端口号无效")
        return f"[{inner}]:{p}"

    if ":" in s:
        host, _, port = s.rpartition(":")
        host = host.strip()
        port = port.strip()
        if not host or not port.isdigit() or not (1 <= int(port) <= 65535):
            raise ValueError("IP:端口 格式无效，示例：192.168.1.100:5555")
        return f"{host}:{port}"

    m = _IPV4_PORT_RE.match(s)
    if m:
        port = m.group("port") or str(_DEFAULT_PORT)
        return f"{m.group('host')}:{port}"

    raise ValueError("IP 格式无效，示例：192.168.1.100 或 192.168.1.100:5555")


def _connect_ok_message(msg: str) -> bool:
    low = msg.lower()
    if "cannot" in low or "failed" in low or "unable" in low or "refused" in low:
        return False
    return "connected" in low or "already connected" in low


def adb_connect(raw: str) -> str:
    """执行 ``adb connect``，成功返回 adb 输出文本。"""
    target = normalize_network_target(raw)
    r = run_adb(["connect", target], None)
    msg = "\n".join(
        x.strip() for x in (r.stdout or "", r.stderr or "") if x.strip()
    ).strip()
    if not msg:
        msg = f"已连接 {target}" if r.returncode == 0 else "connect 失败"
    if not _connect_ok_message(msg):
        raise RuntimeError(msg)
    return msg


def adb_disconnect(raw: str | None = None) -> str:
    """``adb disconnect``；*raw* 为空则断开全部网络设备。"""
    args = ["disconnect"]
    if raw and raw.strip():
        args.append(normalize_network_target(raw))
    r = run_adb(args, None)
    msg = "\n".join(
        x.strip() for x in (r.stdout or "", r.stderr or "") if x.strip()
    ).strip()
    if r.returncode != 0:
        raise RuntimeError(msg or "disconnect 失败")
    return msg or "已断开"
