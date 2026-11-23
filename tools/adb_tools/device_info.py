#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ADB 设备信息卡片、系统属性读取与 DDR/eMMC 容量探测。"""

from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from tools.adb_runtime import adb_available, run_adb
from tools.adb_tools.common import AdbCommandResult

_GETPROP_LINE = re.compile(r"^\[([^\]]+)\]:\s*\[(.*)\]\s*$")


def _adb_prop(device: str | None, key: str, *, timeout: float = 10.0) -> tuple[str, bool]:
    r = run_adb(["shell", "getprop", key], device, timeout=timeout)
    if r.returncode != 0:
        return "(error)", False
    return (r.stdout or "").strip(), True


def read_device_properties(device: str | None) -> dict[str, str] | None:
    """一次 ``getprop`` 读出全部属性。失败返回 None，调用方再逐条查询。"""
    try:
        r = run_adb(["shell", "getprop"], device, timeout=15.0)
    except Exception:
        return None
    text = r.stdout or ""
    if r.returncode != 0 and not text.strip():
        return None
    out: dict[str, str] = {}
    for line in text.splitlines():
        matched = _GETPROP_LINE.match(line.strip())
        if matched:
            out[matched.group(1)] = matched.group(2)
    return out or None


def _prop_lookup(
    device: str | None,
    key: str,
    props: dict[str, str] | None,
    *,
    timeout: float = 10.0,
) -> tuple[str, bool]:
    if props is not None:
        return props.get(key, ""), True
    return _adb_prop(device, key, timeout=timeout)


def capture_device_info(device: str | None, out_path: Path) -> Path:
    """汇总设备型号、Android 版本等基础信息。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")

    props = [
        "ro.product.model",
        "ro.product.brand",
        "ro.product.device",
        "ro.build.version.release",
        "ro.build.version.sdk",
        "ro.build.id",
        "ro.serialno",
    ]
    lines = [f"# device: {device or '(default)'}", f"# time: {datetime.now().isoformat()}", ""]
    dump = read_device_properties(device)
    for p in props:
        if dump is not None:
            val = dump.get(p, "").strip() or "(empty)"
        else:
            r = run_adb(["shell", "getprop", p], device)
            val = (r.stdout or "").strip() if r.returncode == 0 else "(error)"
        lines.append(f"{p}={val}")
    r = run_adb(["shell", "wm", "size"], device)
    if r.returncode == 0 and (r.stdout or "").strip():
        lines.extend(["", "# wm size", (r.stdout or "").strip()])
    r = run_adb(["shell", "dumpsys", "battery"], device)
    if r.returncode == 0 and (r.stdout or "").strip():
        lines.extend(["", "# dumpsys battery (excerpt)", (r.stdout or "").strip()[:4000]])

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return out.resolve()


def _parse_wm_size(text: str) -> str:
    """从 `wm size` 输出取 Physical / Override 尺寸。"""
    physical = ""
    override = ""
    for line in (text or "").splitlines():
        s = line.strip()
        low = s.lower()
        if "physical size:" in low:
            physical = s.split(":", 1)[-1].strip()
        elif "override size:" in low:
            override = s.split(":", 1)[-1].strip()
    if override and override.lower() not in {"", "null"}:
        return f"{override}（物理 {physical}）" if physical else override
    return physical or (text or "").strip()


def _parse_wm_density(text: str) -> str:
    physical = ""
    override = ""
    for line in (text or "").splitlines():
        s = line.strip()
        low = s.lower()
        if "physical density:" in low:
            physical = s.split(":", 1)[-1].strip()
        elif "override density:" in low:
            override = s.split(":", 1)[-1].strip()
    if override and override.lower() not in {"", "null"}:
        return f"{override}（物理 {physical}）" if physical else override
    return physical or (text or "").strip()


def _ip_from_addr_text(text: str) -> str:
    for line in (text or "").splitlines():
        parts = line.split()
        if "inet" in parts:
            i = parts.index("inet")
            if i + 1 < len(parts):
                return parts[i + 1].split("/", 1)[0]
    return ""


def _guess_device_ip(
    device: str | None,
    *,
    props: dict[str, str] | None = None,
    ip_text: str | None = None,
) -> str:
    for prop in (
        "dhcp.wlan0.ipaddress",
        "dhcp.eth0.ipaddress",
        "dhcp.eth1.ipaddress",
    ):
        val, ok = _prop_lookup(device, prop, props, timeout=8.0)
        if ok and val and val != "(error)":
            return val
    if ip_text is not None:
        return _ip_from_addr_text(ip_text)
    r = run_adb(
        [
            "shell",
            "ip",
            "-o",
            "-4",
            "addr",
            "show",
            "scope",
            "global",
        ],
        device,
        timeout=12.0,
    )
    if r.returncode != 0:
        return ""
    return _ip_from_addr_text(r.stdout or "")


def _format_capacity_bytes(
    num: int, *, snap_flash: bool = False, decimals: int | None = None
) -> str:
    """字节 → 可读容量；闪存可按常见规格就近显示。"""
    if num <= 0:
        return ""
    gib = num / (1024**3)
    if snap_flash:
        for target in (4, 8, 16, 32, 64, 128, 256, 512):
            if gib <= target * 1.05 and gib >= target * 0.70:
                return f"{target} GB"
    if decimals is not None:
        if gib >= 1:
            return f"{gib:.{int(decimals)}f} GB"
        mib = num / (1024**2)
        if mib >= 1:
            return f"{mib:.{int(decimals)}f} MB"
        return f"{num} B"
    if gib >= 10:
        return f"{gib:.0f} GB"
    if gib >= 1:
        half = round(gib * 2) / 2
        if abs(half - round(half)) < 1e-6:
            return f"{int(round(half))} GB"
        return f"{half:g} GB"
    mib = num / (1024**2)
    if mib >= 1:
        return f"{mib:.0f} MB"
    return f"{num} B"


def _ddr_from_meminfo(text: str) -> str:
    for line in (text or "").splitlines():
        if not line.startswith("MemTotal:"):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        try:
            kb = int(parts[1])
        except ValueError:
            continue
        return _format_capacity_bytes(kb * 1024)
    return ""


def _ddr_size(
    device: str | None,
    *,
    props: dict[str, str] | None = None,
    meminfo: str | None = None,
) -> str:
    """DDR / 内存：优先属性，其次 /proc/meminfo MemTotal。"""
    for prop in (
        "ro.boot.ddr.size",
        "ro.ddr.size",
        "persist.sys.ddr.size",
        "ro.memtotal.size",
    ):
        val, ok = _prop_lookup(device, prop, props, timeout=8.0)
        if ok and val and val not in {"(error)", ""}:
            if any(u in val.upper() for u in ("GB", "G", "MB", "M")):
                return val
            try:
                n = int(val.strip())
                if n < 1024 * 1024:
                    n *= 1024 * 1024
                return _format_capacity_bytes(n)
            except ValueError:
                return val

    if meminfo is not None:
        return _ddr_from_meminfo(meminfo)
    r = run_adb(["shell", "cat", "/proc/meminfo"], device, timeout=12.0)
    if r.returncode != 0:
        return ""
    return _ddr_from_meminfo(r.stdout or "")


def _parse_positive_int(text: str) -> int:
    s = (text or "").strip().splitlines()
    if not s:
        return 0
    raw = s[0].strip()
    if not raw.isdigit():
        return 0
    try:
        return int(raw)
    except ValueError:
        return 0


def _read_sysfs_sectors(device: str | None, path: str) -> int:
    """读取 block size（扇区数）；忽略 returncode，兼容 Permission denied 仍有输出的机型。"""
    for cmd in (
        f"cat {path}",
        f"toybox cat {path}",
        f"su 0 cat {path}",
        f"su -c 'cat {path}'",
    ):
        try:
            r = run_adb(["shell", cmd], device, timeout=10.0)
        except Exception:
            continue
        n = _parse_positive_int(r.stdout or "")
        if n > 0:
            return n
    return 0


def _disk_bytes_from_partitions(text: str) -> int:
    """从 /proc/partitions 取整盘容量（优先 mmcblkN / sdX / nvme）。"""
    best = 0
    for line in (text or "").splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        name = parts[3]
        if not (
            re.fullmatch(r"mmcblk\d+", name)
            or re.fullmatch(r"sd[a-z]+", name)
            or re.fullmatch(r"nvme\d+n\d+", name)
        ):
            continue
        try:
            blocks = int(parts[2])
        except ValueError:
            continue
        best = max(best, blocks * 1024)
    return best


def _iter_df_k_rows(
    text: str,
) -> list[tuple[str, int, int, int, int | None, str]]:
    """解析 ``df -k``：[(fs, size_kb, used_kb, avail_kb, use_pct|None, mount), ...]。"""
    rows: list[tuple[str, int, int, int, int | None, str]] = []
    pending_fs = ""
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.lower().startswith("filesystem"):
            continue
        parts = line.split()
        if len(parts) == 1 and parts[0].startswith("/"):
            pending_fs = parts[0]
            continue
        if len(parts) >= 5 and parts[0][0].isdigit() and pending_fs:
            parts = [pending_fs, *parts]
            pending_fs = ""
        if len(parts) < 5:
            continue
        fs = parts[0]
        mount = parts[-1]
        try:
            size_kb = int(parts[1])
            used_kb = int(parts[2])
            avail_kb = int(parts[3])
        except ValueError:
            continue
        use_pct: int | None = None
        if len(parts) >= 6 and parts[4].endswith("%"):
            try:
                use_pct = int(parts[4].rstrip("%"))
            except ValueError:
                use_pct = None
        if size_kb <= 0:
            continue
        rows.append((fs, size_kb, used_kb, avail_kb, use_pct, mount))
    return rows


def _df_row_used_kb(
    size_kb: int, used_rep: int, avail_rep: int, use_pct: int | None
) -> int:
    """单行已用 KB；修正 Used/Available 约 2GiB 截断。"""
    cap = 2 * 1024 * 1024
    slack = 1024
    by_pct = None
    if use_pct is not None and 0 <= use_pct <= 100:
        by_pct = (size_kb * use_pct) // 100

    if (
        by_pct is not None
        and size_kb > cap
        and used_rep <= cap + slack
        and by_pct > used_rep + slack
    ):
        return max(0, by_pct)

    if (
        avail_rep <= cap + slack
        and size_kb - used_rep > avail_rep + slack
        and used_rep > cap + slack
    ):
        return max(0, used_rep)

    if (
        used_rep <= cap + slack
        and avail_rep > cap + slack
        and size_kb - avail_rep > used_rep + slack
    ):
        return max(0, size_kb - avail_rep)

    if used_rep <= cap + slack and avail_rep <= cap + slack and size_kb > cap + slack:
        if by_pct is not None:
            return max(0, by_pct)
        return max(used_rep, size_kb - avail_rep, 0)

    return max(0, used_rep)


def _disk_bytes_from_df(text: str) -> int:
    """无 root 时：累加 df 可见的 /dev/block 分区容量（去重），再交给 snap_flash。"""
    rows = _iter_df_k_rows(text)
    seen: set[str] = set()
    total_kb = 0
    for fs, size_kb, _used, _avail, _pct, _mount in rows:
        if not fs.startswith("/dev/"):
            continue
        low = fs.lower()
        if "/fuse" in low or "/loop" in low:
            continue
        if fs in seen:
            continue
        if size_kb <= 0:
            continue
        seen.add(fs)
        total_kb += size_kb
    if total_kb <= 0:
        return 0
    return total_kb * 1024


def _disk_used_bytes_from_df(text: str) -> int:
    """累加 df 可见分区已用空间。"""
    rows = _iter_df_k_rows(text)
    seen: set[str] = set()
    used_kb = 0
    for fs, size_kb, used_rep, avail_rep, use_pct, _mount in rows:
        if not fs.startswith("/dev/"):
            continue
        low = fs.lower()
        if "/fuse" in low or "/loop" in low:
            continue
        if fs in seen or size_kb <= 0:
            continue
        seen.add(fs)
        used_kb += _df_row_used_kb(size_kb, used_rep, avail_rep, use_pct)
    if used_kb <= 0:
        return 0
    return used_kb * 1024


def _snap_flash_bytes(num: int) -> int:
    """实测容量对齐到常见 eMMC 标称字节数。"""
    if num <= 0:
        return 0
    gib = num / (1024**3)
    for target in (4, 8, 16, 32, 64, 128, 256, 512):
        if gib <= target * 1.05 and gib >= target * 0.70:
            return target * (1024**3)
    return num


def _parse_human_capacity_bytes(val: str) -> int:
    s = (val or "").strip().upper().replace(" ", "")
    if not s:
        return 0
    m = re.fullmatch(r"([0-9]*\.?[0-9]+)(T|TB|G|GB|M|MB|K|KB|B)?", s)
    if not m:
        return 0
    try:
        n = float(m.group(1))
    except ValueError:
        return 0
    unit = m.group(2) or "B"
    mul = {
        "T": 1024**4,
        "TB": 1024**4,
        "G": 1024**3,
        "GB": 1024**3,
        "M": 1024**2,
        "MB": 1024**2,
        "K": 1024,
        "KB": 1024,
        "B": 1,
    }.get(unit, 1)
    return int(n * mul)


def _disk_bytes_from_diskstats(text: str) -> int:
    """dumpsys diskstats 的 System Size（部分机型写成整机闪存近似值）。"""
    for line in (text or "").splitlines():
        s = line.strip()
        if not s.lower().startswith("system size:"):
            continue
        raw = s.split(":", 1)[-1].strip().replace(",", "")
        try:
            n = int(raw)
        except ValueError:
            continue
        if n >= 1024**3:
            return n
    return 0


def _block_sectors_from_text(text: str) -> int:
    best_sectors = 0
    for line in (text or "").splitlines():
        parts = line.split()
        if len(parts) < 2 or not parts[1].isdigit():
            continue
        name, sectors_s = parts[0], parts[1]
        if not (
            re.fullmatch(r"mmcblk\d+", name)
            or re.fullmatch(r"sd[a-z]+", name)
            or re.fullmatch(r"nvme\d+n\d+", name)
        ):
            continue
        best_sectors = max(best_sectors, int(sectors_s))
    return best_sectors


def _emmc_probe_bytes(
    device: str | None,
    *,
    props: dict[str, str] | None = None,
    blocks_text: str | None = None,
    df_text: str | None = None,
) -> int:
    """探测 eMMC/闪存总容量（字节）；失败返回 0。"""
    for prop in (
        "ro.boot.emmc.size",
        "ro.boot.emmcsize",
        "ro.emmc.size",
        "ro.emmc_size",
        "persist.sys.emmc.size",
        "ro.vendor.emmc.size",
        "ro.vendor.ril.emmc_size",
        "ril.emmc.size",
    ):
        val, ok = _prop_lookup(device, prop, props, timeout=8.0)
        if not (ok and val and val not in {"(error)", ""}):
            continue
        human = _parse_human_capacity_bytes(val)
        if human > 0:
            return _snap_flash_bytes(human)
        try:
            n = int(val.strip())
            if n < 1024 * 1024:
                n *= 1024 * 1024
            return _snap_flash_bytes(n)
        except ValueError:
            continue

    if blocks_text is not None:
        best_sectors = _block_sectors_from_text(blocks_text)
        if best_sectors > 0:
            return _snap_flash_bytes(best_sectors * 512)
    else:
        try:
            r = run_adb(
                [
                    "shell",
                    "for d in /sys/block/mmcblk* /sys/block/sd* /sys/block/nvme*; "
                    "do [ -d \"$d\" ] || continue; "
                    'n=${d##*/}; case "$n" in *rpmb*|*boot*) continue;; esac; '
                    's=$(cat "$d/size" 2>/dev/null); '
                    'case "$s" in ""|*[!0-9]*) continue;; esac; '
                    'echo "$n $s"; done',
                ],
                device,
                timeout=15.0,
            )
            best_sectors = _block_sectors_from_text(r.stdout or "")
            if best_sectors > 0:
                return _snap_flash_bytes(best_sectors * 512)
        except Exception:
            pass

    for path in (
        "/sys/block/mmcblk0/size",
        "/sys/class/block/mmcblk0/size",
        "/sys/block/mmcblk1/size",
        "/sys/block/sda/size",
        "/sys/block/sdb/size",
    ):
        sectors = _read_sysfs_sectors(device, path)
        if sectors > 0:
            return _snap_flash_bytes(sectors * 512)

    for node in (
        "/dev/block/mmcblk0",
        "/dev/mmcblk0",
        "/dev/block/sda",
        "/dev/sda",
    ):
        try:
            r = run_adb(
                ["shell", f"blockdev --getsize64 {node} 2>/dev/null"],
                device,
                timeout=10.0,
            )
        except Exception:
            continue
        n = _parse_positive_int(r.stdout or "")
        if n > 0:
            return _snap_flash_bytes(n)

    try:
        r = run_adb(["shell", "cat /proc/partitions"], device, timeout=12.0)
        best = _disk_bytes_from_partitions(r.stdout or "")
        if best > 0:
            return _snap_flash_bytes(best)
    except Exception:
        pass

    if df_text:
        best = _disk_bytes_from_df(df_text)
        if best > 0:
            return _snap_flash_bytes(best)
    else:
        try:
            r = run_adb(["shell", "df", "-k"], device, timeout=12.0)
            probed = r.stdout or ""
            best = _disk_bytes_from_df(probed)
            if best > 0:
                return _snap_flash_bytes(best)
        except Exception:
            pass

    try:
        r = run_adb(["shell", "dumpsys", "diskstats"], device, timeout=15.0)
        best = _disk_bytes_from_diskstats(r.stdout or "")
        if best > 0:
            return _snap_flash_bytes(best)
    except Exception:
        pass

    return 0


def _df_avail_kb(device: str | None, path: str = "/data") -> int:
    """读取挂载点可用空间（KB）。"""
    return _df_space_kb(device, path).get("avail_kb", 0)


def _df_space_kb(device: str | None, path: str = "/data") -> dict[str, int]:
    """返回 size/used/avail（1K-blocks）及是否修正过截断。"""
    empty = {"size_kb": 0, "used_kb": 0, "avail_kb": 0, "capped_fix": 0}
    if not path:
        path = "/data"
    texts: list[str] = []
    for args in (
        ["df", "-k", path],
        ["df", "-k"],
        ["toybox", "df", "-k", path],
        ["toybox", "df", "-k"],
    ):
        try:
            r = run_adb(["shell", *args], device, timeout=12.0)
        except Exception:
            continue
        if (r.stdout or "").strip():
            texts.append(r.stdout or "")
        if r.returncode == 0 and len(texts) >= 1 and path in (r.stdout or ""):
            break

    best: dict[str, int] | None = None
    for text in texts:
        parsed = _parse_df_space_for_path(text, path)
        if not parsed:
            continue
        if best is None or parsed["avail_kb"] > best["avail_kb"]:
            best = parsed
    return best or empty


def _parse_df_space_for_path(text: str, path: str) -> dict[str, int] | None:
    """解析 df -k 输出中目标挂载点的 size/used/avail。"""
    path = (path or "/data").rstrip("/") or "/"
    rows: list[tuple[str, int, int, int]] = []
    pending_fs = ""
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.lower().startswith("filesystem"):
            continue
        parts = line.split()
        if len(parts) == 1 and parts[0].startswith("/"):
            pending_fs = parts[0]
            continue
        if len(parts) >= 5 and parts[0][0].isdigit() and pending_fs:
            parts = [pending_fs, *parts]
            pending_fs = ""
        if len(parts) < 5:
            continue
        mount = parts[-1]
        try:
            size_kb = int(parts[1])
            used_kb = int(parts[2])
            avail_rep = int(parts[3])
        except ValueError:
            continue
        if size_kb <= 0:
            continue
        rows.append((mount, size_kb, used_kb, avail_rep))

    if not rows:
        return None

    candidates = [r for r in rows if r[0] == path]
    if not candidates:
        candidates = [
            r
            for r in rows
            if r[0] == path
            or (path != "/" and (r[0].startswith(path + "/") or path.startswith(r[0].rstrip("/") + "/")))
            or r[0].rstrip("/") == path
        ]
    if not candidates and (path == "/data" or path.startswith("/data/")):
        candidates = [r for r in rows if r[0] == "/data" or r[0].startswith("/data/")]
    if not candidates:
        if len(rows) == 1:
            candidates = rows
        else:
            prefix = [
                r
                for r in rows
                if path == r[0] or path.startswith((r[0].rstrip("/") or "/") + "/")
            ]
            candidates = prefix or rows

    def score(row: tuple[str, int, int, int]) -> tuple[int, int]:
        mount, size_kb, _used_kb, _avail = row
        exact = 1 if mount.rstrip("/") == path else 0
        return (exact, size_kb)

    mount, size_kb, used_kb, avail_rep = max(candidates, key=score)
    computed = max(0, size_kb - used_kb)
    cap_kb = 2 * 1024 * 1024
    capped = 0
    if (
        avail_rep > 0
        and avail_rep <= cap_kb + 2048
        and computed > avail_rep + 1024
    ):
        avail_kb = computed
        capped = 1
    else:
        avail_kb = avail_rep if avail_rep > 0 else computed
    return {
        "size_kb": size_kb,
        "used_kb": used_kb,
        "avail_kb": avail_kb,
        "capped_fix": capped,
    }


def _emmc_fields(
    device: str | None,
    *,
    props: dict[str, str] | None = None,
    blocks_text: str | None = None,
    df_text: str | None = None,
    df_data_text: str | None = None,
) -> dict[str, str]:
    """eMMC 总容量 + 剩余 + 占用比例。"""
    total = _emmc_probe_bytes(
        device, props=props, blocks_text=blocks_text, df_text=df_text
    )
    label = _format_capacity_bytes(total, snap_flash=True) if total else ""

    used = 0
    visible_size = 0
    disk_text = df_text
    if disk_text is None:
        try:
            r = run_adb(["shell", "df", "-k"], device, timeout=12.0)
            disk_text = r.stdout or ""
        except Exception:
            disk_text = ""
    if disk_text:
        used = _disk_used_bytes_from_df(disk_text)
        visible_size = _disk_bytes_from_df(disk_text)

    if total > 0 and visible_size > 0 and total > visible_size:
        used = min(total, used + (total - visible_size))
    elif total > 0 and used > total:
        used = total

    if df_text is not None or df_data_text is not None:
        texts = [t for t in (df_data_text, df_text) if t]
        data_space = {"avail_kb": 0}
        for text in texts:
            parsed = _parse_df_space_for_path(text, "/data")
            if parsed and int(parsed.get("avail_kb") or 0) >= int(data_space.get("avail_kb") or 0):
                data_space = parsed
    else:
        data_space = _df_space_kb(device, "/data")
    data_free = max(0, int(data_space.get("avail_kb") or 0) * 1024)
    free = data_free
    if free <= 0 and total > 0 and used >= 0:
        free = max(0, total - used)

    free_label = _format_capacity_bytes(free, decimals=1) if free else ""
    used_label = _format_capacity_bytes(used, decimals=1) if used else ""
    pct = ""
    pct_num = 0
    if total > 0 and used > 0:
        pct_num = int(round(100.0 * used / total))
        pct_num = max(0, min(100, pct_num))
        pct = f"{pct_num}%"

    return {
        "emmc": label,
        "emmc_used": used_label,
        "emmc_free": free_label,
        "emmc_pct": pct,
        "emmc_pct_num": str(pct_num) if pct else "",
    }


def _emmc_size(device: str | None) -> str:
    """兼容：仅返回 eMMC 标称容量文案。"""
    return _emmc_fields(device).get("emmc", "")


_CARD_SHELL = (
    "echo '---CARD:WM_SIZE---'; wm size; "
    "echo '---CARD:WM_DENSITY---'; wm density; "
    "echo '---CARD:IP---'; ip -o -4 addr show scope global; "
    "echo '---CARD:MEM---'; cat /proc/meminfo; "
    "echo '---CARD:BLOCKS---'; "
    "for d in /sys/block/mmcblk* /sys/block/sd* /sys/block/nvme*; do "
    '[ -d "$d" ] || continue; '
    'n=${d##*/}; case "$n" in *rpmb*|*boot*) continue;; esac; '
    's=$(cat "$d/size" 2>/dev/null); '
    'case "$s" in ""|*[!0-9]*) continue;; esac; '
    'echo "$n $s"; done; '
    "echo '---CARD:DF---'; df -k; "
    "echo '---CARD:DF_DATA---'; df -k /data; "
    "echo '---CARD:END---'"
)


def _split_card_sections(text: str) -> dict[str, str]:
    sections: dict[str, str] = {}
    current = ""
    buf: list[str] = []
    for line in (text or "").splitlines():
        if line.startswith("---CARD:") and line.endswith("---"):
            if current:
                sections[current] = "\n".join(buf)
            current = line[len("---CARD:") : -len("---")]
            buf = []
            continue
        if current:
            buf.append(line)
    if current:
        sections[current] = "\n".join(buf)
    return sections


def _read_device_card_shell(device: str | None) -> dict[str, str]:
    try:
        r = run_adb(["shell", _CARD_SHELL], device, timeout=20.0)
    except Exception:
        return {}
    return _split_card_sections(r.stdout or "")


def collect_device_card(device: str | None) -> dict:
    """设备信息卡：一次 getprop，再一次 shell 取分辨率、内存和磁盘。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")

    prop_map = (
        ("model", "ro.product.model"),
        ("brand", "ro.product.brand"),
        ("manufacturer", "ro.product.manufacturer"),
        ("device", "ro.product.device"),
        ("product", "ro.product.name"),
        ("board", "ro.product.board"),
        ("android", "ro.build.version.release"),
        ("sdk", "ro.build.version.sdk"),
        ("version", "ro.build.display.id"),
        ("incremental", "ro.build.version.incremental"),
        ("security_patch", "ro.build.version.security_patch"),
        ("build_id", "ro.build.id"),
        ("build_type", "ro.build.type"),
        ("build_tags", "ro.build.tags"),
        ("fingerprint", "ro.build.fingerprint"),
        ("serial", "ro.serialno"),
        ("abi", "ro.product.cpu.abi"),
        ("hardware", "ro.hardware"),
        ("bootloader", "ro.bootloader"),
        ("timezone", "persist.sys.timezone"),
    )
    with ThreadPoolExecutor(max_workers=2) as pool:
        dump_call = pool.submit(read_device_properties, device)
        shell_call = pool.submit(_read_device_card_shell, device)
        dump = dump_call.result()
        sections = shell_call.result()
    props: dict[str, str] = {}
    info: dict[str, str] = {}
    failed = 0
    for key, prop in prop_map:
        val, ok = _prop_lookup(device, prop, dump)
        props[prop] = val if ok else "(error)"
        info[key] = val if ok else ""
        if not ok:
            failed += 1

    info["locale"] = ""
    for loc_prop in (
        "persist.sys.locale",
        "ro.product.locale",
        "persist.sys.language",
    ):
        val, ok = _prop_lookup(device, loc_prop, dump)
        props[loc_prop] = val if ok else "(error)"
        if ok and (val or "").strip():
            info["locale"] = val.strip()
            break
        if not ok:
            failed += 1

    abilist, abi_ok = _prop_lookup(device, "ro.product.cpu.abilist", dump)
    props["ro.product.cpu.abilist"] = abilist if abi_ok else "(error)"
    if abi_ok and (abilist or "").strip():
        abi_main = (info.get("abi") or "").strip()
        if abilist.strip() != abi_main:
            info["abi_list"] = abilist.strip()
        else:
            info["abi_list"] = ""
    else:
        info["abi_list"] = ""
        if not abi_ok:
            failed += 1

    if "WM_SIZE" in sections:
        info["display"] = _parse_wm_size(sections["WM_SIZE"])
        if not info["display"]:
            failed += 1
    else:
        r = run_adb(["shell", "wm", "size"], device, timeout=10.0)
        if r.returncode == 0:
            info["display"] = _parse_wm_size(r.stdout or "")
        else:
            info["display"] = ""
            failed += 1

    if "WM_DENSITY" in sections:
        info["density"] = _parse_wm_density(sections["WM_DENSITY"])
        if not info["density"]:
            failed += 1
    else:
        r = run_adb(["shell", "wm", "density"], device, timeout=10.0)
        if r.returncode == 0:
            info["density"] = _parse_wm_density(r.stdout or "")
        else:
            info["density"] = ""
            failed += 1

    info["ip"] = _guess_device_ip(
        device, props=dump, ip_text=sections.get("IP")
    )
    info["ddr"] = _ddr_size(device, props=dump, meminfo=sections.get("MEM"))
    info.update(
        _emmc_fields(
            device,
            props=dump,
            blocks_text=sections.get("BLOCKS"),
            df_text=sections.get("DF"),
            df_data_text=sections.get("DF_DATA"),
        )
    )

    return {
        "info": info,
        "props": props,
        "failed": failed,
    }


@dataclass(frozen=True)
class BuildInfoField:
    """android.os.Build 字段与 getprop 属性对应。"""

    build_name: str
    prop_key: str


BUILD_INFO_FIELDS: tuple[BuildInfoField, ...] = (
    BuildInfoField("MODEL", "ro.product.model"),
    BuildInfoField("BRAND", "ro.product.brand"),
    BuildInfoField("PRODUCT", "ro.product.name"),
    BuildInfoField("DEVICE", "ro.product.device"),
    BuildInfoField("MANUFACTURER", "ro.product.manufacturer"),
    BuildInfoField("BOARD", "ro.product.board"),
)


def capture_build_project_info(device: str | None) -> AdbCommandResult:
    """读取 Build 相关项目信息（adb shell getprop）。"""
    if not adb_available():
        raise RuntimeError("未找到 adb")

    lines = [
        f"# device: {device or '(default)'}",
        f"# time: {datetime.now().isoformat()}",
        "",
    ]
    failed = 0
    dump = read_device_properties(device)
    for field in BUILD_INFO_FIELDS:
        if dump is not None:
            val = dump.get(field.prop_key, "").strip() or "(empty)"
        else:
            r = run_adb(["shell", "getprop", field.prop_key], device)
            if r.returncode != 0:
                val = "(error)"
                failed += 1
            else:
                val = (r.stdout or "").strip() or "(empty)"
        lines.append(f"android.os.Build.{field.build_name}")
        lines.append(f"  getprop {field.prop_key}")
        lines.append(f"  = {val}")
        lines.append("")

    text = "\n".join(lines).rstrip() + "\n"
    return AdbCommandResult(
        label="项目信息",
        returncode=0 if failed == 0 else 1,
        output=text,
    )
