#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""纯 Python 解析 APK：包名、版本、SDK、权限、组件、ABI 等。"""

from __future__ import annotations

import hashlib
import re
import struct
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

# Android binary XML chunk types
_RES_STRING_POOL = 0x0001
_RES_XML = 0x0003
_RES_XML_START_ELEMENT = 0x0102
_RES_XML_END_ELEMENT = 0x0103
_RES_XML_RESOURCE_MAP = 0x0180

# Common Android resource attribute IDs (framework attrs)
_ATTR_NAME = 0x01010003
_ATTR_VERSION_CODE = 0x0101021B
_ATTR_VERSION_NAME = 0x0101021C
_ATTR_MIN_SDK = 0x0101020C
_ATTR_TARGET_SDK = 0x01010270
_ATTR_MAX_SDK = 0x01010271
_ATTR_LABEL = 0x01010001
_ATTR_ICON = 0x01010002
_ATTR_DEBUGGABLE = 0x0101000F
_ATTR_EXPORTED = 0x01010010
_ATTR_PERMISSION = 0x01010006
_ATTR_MIME_TYPE = 0x01010026
_ATTR_SCHEME = 0x01010027
_ATTR_HOST = 0x01010028
_ATTR_PORT = 0x01010029
_ATTR_PATH = 0x0101002A
_ATTR_PATH_PREFIX = 0x0101002B
_ATTR_PATH_PATTERN = 0x0101002C
_ATTR_PRIORITY = 0x0101001C

_TYPED_NULL = 0
_TYPED_REFERENCE = 1
_TYPED_STRING = 3
_TYPED_INT_DEC = 16
_TYPED_INT_HEX = 17
_TYPED_INT_BOOLEAN = 18


@dataclass
class ApkIntentData:
    scheme: str = ""
    host: str = ""
    port: str = ""
    path: str = ""
    path_prefix: str = ""
    path_pattern: str = ""
    mime_type: str = ""

    def as_dict(self) -> dict:
        return {
            "scheme": self.scheme,
            "host": self.host,
            "port": self.port,
            "path": self.path,
            "pathPrefix": self.path_prefix,
            "pathPattern": self.path_pattern,
            "mimeType": self.mime_type,
        }

    def is_empty(self) -> bool:
        return not any(
            (
                self.scheme,
                self.host,
                self.port,
                self.path,
                self.path_prefix,
                self.path_pattern,
                self.mime_type,
            )
        )

    def format_short(self) -> str:
        parts: list[str] = []
        if self.scheme or self.host or self.port or self.path or self.path_prefix or self.path_pattern:
            uri = self.scheme or "*"
            if self.host:
                uri += "://" + self.host
                if self.port:
                    uri += ":" + self.port
            elif self.scheme:
                uri += ":"
            for p in (self.path, self.path_prefix, self.path_pattern):
                if p:
                    uri += p
                    break
            parts.append(uri)
        if self.mime_type:
            parts.append(f"type={self.mime_type}")
        return " ".join(parts)


@dataclass
class ApkIntentFilter:
    actions: list[str] = field(default_factory=list)
    categories: list[str] = field(default_factory=list)
    data: list[ApkIntentData] = field(default_factory=list)
    priority: str = ""

    def as_dict(self) -> dict:
        return {
            "actions": list(self.actions),
            "categories": list(self.categories),
            "data": [d.as_dict() for d in self.data],
            "priority": self.priority,
        }


@dataclass
class ApkComponent:
    kind: str  # activity / service / receiver / provider
    name: str
    exported: bool | None = None
    permission: str = ""
    intent_filters: list[ApkIntentFilter] = field(default_factory=list)


@dataclass
class ApkInfo:
    path: Path
    file_size: int = 0
    file_md5: str = ""
    package: str = ""
    version_code: str = ""
    version_name: str = ""
    min_sdk: str = ""
    target_sdk: str = ""
    max_sdk: str = ""
    label: str = ""
    icon: str = ""
    debuggable: bool | None = None
    permissions: list[str] = field(default_factory=list)
    activities: list[ApkComponent] = field(default_factory=list)
    services: list[ApkComponent] = field(default_factory=list)
    receivers: list[ApkComponent] = field(default_factory=list)
    providers: list[ApkComponent] = field(default_factory=list)
    intent_filters: list[dict] = field(default_factory=list)
    abis: list[str] = field(default_factory=list)
    has_dex: bool = False
    dex_count: int = 0
    has_native: bool = False
    warnings: list[str] = field(default_factory=list)

    def collect_intent_filters(self) -> list[dict]:
        """汇总所有组件上的 intent-filter，供 UI 展示。"""
        out: list[dict] = []
        for items in (self.activities, self.services, self.receivers, self.providers):
            for c in items:
                for flt in c.intent_filters:
                    if not flt.actions and not flt.categories and not flt.data:
                        continue
                    out.append(
                        {
                            "component": c.name,
                            "component_kind": c.kind,
                            "exported": c.exported,
                            **flt.as_dict(),
                        }
                    )
        return out

    def as_dict(self) -> dict:
        """结构化结果，供桌面 UI 展示（不再只靠文本报告）。"""

        def _comps(items: list[ApkComponent]) -> list[dict]:
            return [
                {
                    "kind": c.kind,
                    "name": c.name,
                    "exported": c.exported,
                    "permission": c.permission or "",
                    "intent_filters": [f.as_dict() for f in c.intent_filters],
                }
                for c in items
            ]

        classified = classify_permissions(self.permissions)
        intents = self.intent_filters or self.collect_intent_filters()
        return {
            "filename": self.path.name,
            "file_size": self.file_size,
            "file_size_label": _format_size(self.file_size),
            "md5": self.file_md5,
            "package": self.package,
            "version_name": self.version_name,
            "version_code": self.version_code,
            "min_sdk": self.min_sdk,
            "target_sdk": self.target_sdk,
            "max_sdk": self.max_sdk,
            "label": self.label,
            "icon": self.icon,
            "debuggable": self.debuggable,
            "permissions": list(self.permissions),
            "permissions_auto": classified["auto"],
            "permissions_runtime": classified["runtime"],
            "permissions_special": classified["special"],
            "activities": _comps(self.activities),
            "services": _comps(self.services),
            "receivers": _comps(self.receivers),
            "providers": _comps(self.providers),
            "intent_filters": intents,
            "abis": list(self.abis),
            "has_dex": self.has_dex,
            "dex_count": self.dex_count,
            "has_native": self.has_native,
            "warnings": list(self.warnings),
        }

    def format_report(self) -> str:
        lines = [
            f"# APK 分析: {self.path.name}",
            f"# path: {self.path}",
            "",
            "## 文件",
            f"大小: {_format_size(self.file_size)} ({self.file_size} bytes)",
            f"MD5: {self.file_md5 or '(未计算)'}",
            f"DEX: {'是' if self.has_dex else '否'} (classes*.dex × {self.dex_count})",
            f"Native: {'是' if self.has_native else '否'}",
            f"ABI: {', '.join(self.abis) if self.abis else '(无/纯 Java)'}",
            "",
            "## 包信息",
            f"package: {self.package or '(未知)'}",
            f"versionName: {self.version_name or '(未知)'}",
            f"versionCode: {self.version_code or '(未知)'}",
            f"minSdkVersion: {self.min_sdk or '(未知)'}",
            f"targetSdkVersion: {self.target_sdk or '(未知)'}",
            f"maxSdkVersion: {self.max_sdk or '(未声明)'}",
            f"label: {self.label or '(未知/资源引用)'}",
            f"icon: {self.icon or '(未知)'}",
            f"debuggable: {_fmt_bool(self.debuggable)}",
            "",
            f"## 权限 ({len(self.permissions)})",
        ]
        classified = classify_permissions(self.permissions)
        if classified["auto"]:
            lines.append(f"  系统默认授予 / 安装即生效 ({len(classified['auto'])}):")
            lines.extend(f"    - {p}" for p in classified["auto"])
        if classified["runtime"]:
            lines.append(f"  需运行时授权 ({len(classified['runtime'])}):")
            lines.extend(f"    - {p}" for p in classified["runtime"])
        if classified["special"]:
            lines.append(f"  需特殊授权/设置页 ({len(classified['special'])}):")
            lines.extend(f"    - {p}" for p in classified["special"])
        if not self.permissions:
            lines.append("  (无)")
        lines.append("")
        intents = self.intent_filters or self.collect_intent_filters()
        lines.append(f"## Intent Filter ({len(intents)})")
        if intents:
            for it in intents:
                kind = it.get("component_kind") or ""
                comp = it.get("component") or "?"
                lines.append(f"  - [{kind}] {comp}")
                actions = it.get("actions") or []
                cats = it.get("categories") or []
                data_list = it.get("data") or []
                if actions:
                    lines.append("      actions: " + ", ".join(str(a) for a in actions))
                if cats:
                    lines.append("      categories: " + ", ".join(str(c) for c in cats))
                for d in data_list:
                    if isinstance(d, dict):
                        dd = ApkIntentData(
                            scheme=str(d.get("scheme") or ""),
                            host=str(d.get("host") or ""),
                            port=str(d.get("port") or ""),
                            path=str(d.get("path") or ""),
                            path_prefix=str(d.get("pathPrefix") or ""),
                            path_pattern=str(d.get("pathPattern") or ""),
                            mime_type=str(d.get("mimeType") or ""),
                        )
                        if not dd.is_empty():
                            lines.append(f"      data: {dd.format_short()}")
        else:
            lines.append("  (无)")
        lines.append("")
        lines.extend(self._format_components("Activity", self.activities))
        lines.append("")
        lines.extend(self._format_components("Service", self.services))
        lines.append("")
        lines.extend(self._format_components("Receiver", self.receivers))
        lines.append("")
        lines.extend(self._format_components("Provider", self.providers))
        if self.warnings:
            lines.extend(["", "## 警告"])
            lines.extend(f"  - {w}" for w in self.warnings)
        lines.append("")
        return "\n".join(lines)

    @staticmethod
    def _format_components(title: str, items: list[ApkComponent]) -> list[str]:
        out = [f"## {title} ({len(items)})"]
        if not items:
            out.append("  (无)")
            return out
        for c in items:
            exp = "" if c.exported is None else f" exported={c.exported}"
            perm = f" permission={c.permission}" if c.permission else ""
            filt = f" intentFilters={len(c.intent_filters)}" if c.intent_filters else ""
            out.append(f"  - {c.name}{exp}{perm}{filt}")
            for flt in c.intent_filters:
                if flt.actions:
                    out.append("      action: " + ", ".join(flt.actions))
                if flt.categories:
                    out.append("      category: " + ", ".join(flt.categories))
                for d in flt.data:
                    if not d.is_empty():
                        out.append(f"      data: {d.format_short()}")
        return out


def _fmt_bool(v: bool | None) -> str:
    if v is None:
        return "(未声明)"
    return "true" if v else "false"


def _format_size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / (1024 * 1024):.2f} MB"


def _u16(data: bytes, off: int) -> int:
    return struct.unpack_from("<H", data, off)[0]


def _u32(data: bytes, off: int) -> int:
    return struct.unpack_from("<I", data, off)[0]


def _s32(data: bytes, off: int) -> int:
    return struct.unpack_from("<i", data, off)[0]


# framework android.R.attr → 短名（用于 resource map 反查）
_ANDROID_ATTR_IDS: dict[int, str] = {
    _ATTR_NAME: "name",
    _ATTR_VERSION_CODE: "versionCode",
    _ATTR_VERSION_NAME: "versionName",
    _ATTR_MIN_SDK: "minSdkVersion",
    _ATTR_TARGET_SDK: "targetSdkVersion",
    _ATTR_MAX_SDK: "maxSdkVersion",
    _ATTR_LABEL: "label",
    _ATTR_ICON: "icon",
    _ATTR_DEBUGGABLE: "debuggable",
    _ATTR_EXPORTED: "exported",
    _ATTR_PERMISSION: "permission",
    _ATTR_MIME_TYPE: "mimeType",
    _ATTR_SCHEME: "scheme",
    _ATTR_HOST: "host",
    _ATTR_PORT: "port",
    _ATTR_PATH: "path",
    _ATTR_PATH_PREFIX: "pathPrefix",
    _ATTR_PATH_PATTERN: "pathPattern",
    _ATTR_PRIORITY: "priority",
    0x0101000B: "package",  # 较少直接出现；package 多为普通字符串属性
}


class _AxmlParser:
    """解析 Android binary AndroidManifest.xml。"""

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.strings: list[str] = []
        self.resource_ids: list[int] = []
        self.package = ""
        self.version_code = ""
        self.version_name = ""
        self.min_sdk = ""
        self.target_sdk = ""
        self.max_sdk = ""
        self.label = ""
        self.icon = ""
        self.debuggable: bool | None = None
        self.permissions: list[str] = []
        self.activities: list[ApkComponent] = []
        self.services: list[ApkComponent] = []
        self.receivers: list[ApkComponent] = []
        self.providers: list[ApkComponent] = []
        self._tag_stack: list[str] = []
        self._current_component: ApkComponent | None = None
        self._current_filter: ApkIntentFilter | None = None

    def parse(self) -> None:
        data = self.data
        if len(data) < 8:
            raise ValueError("AndroidManifest.xml 过短")
        if _u16(data, 0) != _RES_XML:
            raise ValueError("不是有效的 binary AndroidManifest.xml")
        size = _u32(data, 4)
        if size > len(data):
            size = len(data)
        off = 8
        while off + 8 <= size:
            ctype = _u16(data, off)
            header_size = _u16(data, off + 2)
            chunk_size = _u32(data, off + 4)
            if chunk_size < 8 or off + chunk_size > size:
                break
            if ctype == _RES_STRING_POOL:
                self.strings = self._parse_string_pool(off)
            elif ctype == _RES_XML_RESOURCE_MAP:
                self.resource_ids = self._parse_resource_map(off, chunk_size)
            elif ctype == _RES_XML_START_ELEMENT:
                self._parse_start_element(off, header_size)
            elif ctype == _RES_XML_END_ELEMENT:
                self._parse_end_element(off)
            off += chunk_size

    def _parse_resource_map(self, off: int, chunk_size: int) -> list[int]:
        data = self.data
        count = (chunk_size - 8) // 4
        out: list[int] = []
        for i in range(count):
            out.append(_u32(data, off + 8 + i * 4))
        return out

    def _attr_name(self, name_idx: int) -> str:
        name = self._get_string(name_idx)
        if name:
            return name
        if 0 <= name_idx < len(self.resource_ids):
            resid = self.resource_ids[name_idx]
            mapped = _ANDROID_ATTR_IDS.get(resid)
            if mapped:
                return mapped
        return ""

    def _parse_string_pool(self, off: int) -> list[str]:
        data = self.data
        # header: type, headerSize, size, stringCount, styleCount, flags, stringsStart, stylesStart
        string_count = _u32(data, off + 8)
        flags = _u32(data, off + 16)
        strings_start = _u32(data, off + 20)
        is_utf8 = bool(flags & (1 << 8))
        offsets_base = off + 28
        out: list[str] = []
        for i in range(string_count):
            str_off = offsets_base + i * 4
            if str_off + 4 > len(data):
                break
            rel = _u32(data, str_off)
            abs_off = off + strings_start + rel
            try:
                if is_utf8:
                    out.append(self._read_utf8_string(abs_off))
                else:
                    out.append(self._read_utf16_string(abs_off))
            except Exception:
                out.append("")
        return out

    def _read_utf16_string(self, off: int) -> str:
        data = self.data
        if off + 2 > len(data):
            return ""
        length = _u16(data, off)
        # 超长字符串用 32bit 长度
        char_off = off + 2
        if length & 0x8000:
            length = ((length & 0x7FFF) << 16) | _u16(data, off + 2)
            char_off = off + 4
        end = char_off + length * 2
        if end > len(data):
            end = len(data)
        raw = data[char_off:end]
        return raw.decode("utf-16le", errors="replace")

    def _read_utf8_string(self, off: int) -> str:
        data = self.data
        if off >= len(data):
            return ""
        # UTF-8: [utf16_len*][utf8_len*][bytes][0]
        i = off
        # skip utf16 length
        b0 = data[i]
        i += 1
        if b0 & 0x80:
            i += 1
        if i >= len(data):
            return ""
        b1 = data[i]
        i += 1
        utf8_len = b1 & 0x7F
        if b1 & 0x80:
            if i >= len(data):
                return ""
            utf8_len = ((b1 & 0x7F) << 8) | data[i]
            i += 1
        end = i + utf8_len
        if end > len(data):
            end = len(data)
        return data[i:end].decode("utf-8", errors="replace")

    def _get_string(self, idx: int) -> str:
        if idx < 0 or idx >= len(self.strings):
            return ""
        return self.strings[idx]

    def _parse_start_element(self, off: int, header_size: int) -> None:
        data = self.data
        # After common header(8) + lineNumber(4) + comment(4): ns(4) name(4) attrStart(2) attrSize(2) attrCount(2) idIndex(2)
        base = off + 16
        if base + 20 > len(data):
            return
        name_idx = _s32(data, base + 4)
        attr_start = _u16(data, base + 8)
        attr_size = _u16(data, base + 10)
        attr_count = _u16(data, base + 12)
        tag = self._get_string(name_idx)
        attrs: dict[str, object] = {}
        # attrs at off + 16 + attrStart（attrStart 通常为 20）
        attr_abs = off + 16 + attr_start
        if attr_size == 0:
            attr_size = 20
        for i in range(attr_count):
            aoff = attr_abs + i * attr_size
            if aoff + 20 > len(data):
                break
            name_i = _s32(data, aoff + 4)
            raw_value = _s32(data, aoff + 8)
            data_type = data[aoff + 15]
            typed_data = _u32(data, aoff + 16)
            aname = self._attr_name(name_i)
            val = self._decode_typed(data_type, typed_data, raw_value)
            if aname:
                attrs[aname] = val

        self._handle_element(tag, attrs)
        self._tag_stack.append(tag)

    def _parse_end_element(self, off: int) -> None:
        data = self.data
        base = off + 16
        tag = ""
        if base + 8 <= len(data):
            tag = self._get_string(_s32(data, base + 4))
        if self._tag_stack:
            self._tag_stack.pop()
        if tag == "intent-filter":
            self._current_filter = None
        elif tag in ("activity", "activity-alias", "service", "receiver", "provider"):
            self._current_component = None
            self._current_filter = None

    def _decode_typed(self, data_type: int, typed_data: int, raw_value: int) -> object:
        if data_type == _TYPED_STRING:
            return self._get_string(typed_data if typed_data >= 0 else raw_value)
        if data_type == _TYPED_INT_BOOLEAN:
            return bool(typed_data)
        if data_type in (_TYPED_INT_DEC, _TYPED_INT_HEX):
            return typed_data
        if data_type == _TYPED_REFERENCE:
            return f"@0x{typed_data:08x}"
        if data_type == _TYPED_NULL:
            if raw_value >= 0:
                # sometimes string index stored in rawValue
                s = self._get_string(raw_value)
                if s:
                    return s
            return ""
        # fallback: prefer string from rawValue
        if raw_value >= 0:
            s = self._get_string(raw_value)
            if s:
                return s
        return typed_data

    def _attr_str(self, attrs: dict[str, object], *keys: str) -> str:
        for k in keys:
            v = attrs.get(k)
            if v is None or v == "":
                continue
            return str(v)
        return ""

    def _attr_bool(self, attrs: dict[str, object], key: str) -> bool | None:
        if key not in attrs:
            return None
        v = attrs[key]
        if isinstance(v, bool):
            return v
        s = str(v).lower()
        if s in ("true", "1"):
            return True
        if s in ("false", "0"):
            return False
        return None

    def _handle_element(self, tag: str, attrs: dict[str, object]) -> None:
        if tag == "manifest":
            self.package = self._attr_str(attrs, "package") or self.package
            vc = attrs.get("versionCode")
            if vc is not None and vc != "":
                self.version_code = str(vc)
            vn = self._attr_str(attrs, "versionName")
            if vn:
                self.version_name = vn
        elif tag == "uses-sdk":
            for key, field in (
                ("minSdkVersion", "min_sdk"),
                ("targetSdkVersion", "target_sdk"),
                ("maxSdkVersion", "max_sdk"),
            ):
                v = attrs.get(key)
                if v is not None and v != "":
                    setattr(self, field, str(v))
        elif tag == "uses-permission" or tag == "uses-permission-sdk-23":
            name = self._attr_str(attrs, "name")
            if name and name not in self.permissions:
                self.permissions.append(name)
        elif tag == "application":
            label = self._attr_str(attrs, "label")
            if label:
                self.label = label
            icon = self._attr_str(attrs, "icon")
            if icon:
                self.icon = icon
            deb = self._attr_bool(attrs, "debuggable")
            if deb is not None:
                self.debuggable = deb
        elif tag in ("activity", "activity-alias", "service", "receiver", "provider"):
            name = self._attr_str(attrs, "name")
            if not name:
                self._current_component = None
                return
            if name.startswith(".") and self.package:
                name = self.package + name
            elif "." not in name and self.package:
                name = f"{self.package}.{name}"
            comp = ApkComponent(
                kind=tag,
                name=name,
                exported=self._attr_bool(attrs, "exported"),
                permission=self._attr_str(attrs, "permission"),
            )
            if tag in ("activity", "activity-alias"):
                self.activities.append(comp)
            elif tag == "service":
                self.services.append(comp)
            elif tag == "receiver":
                self.receivers.append(comp)
            elif tag == "provider":
                self.providers.append(comp)
            self._current_component = comp
            self._current_filter = None
        elif tag == "intent-filter":
            if not self._current_component:
                self._current_filter = None
                return
            flt = ApkIntentFilter(priority=self._attr_str(attrs, "priority"))
            self._current_component.intent_filters.append(flt)
            self._current_filter = flt
        elif tag == "action":
            name = self._attr_str(attrs, "name")
            if name and self._current_filter is not None:
                if name not in self._current_filter.actions:
                    self._current_filter.actions.append(name)
        elif tag == "category":
            name = self._attr_str(attrs, "name")
            if name and self._current_filter is not None:
                if name not in self._current_filter.categories:
                    self._current_filter.categories.append(name)
        elif tag == "data":
            if self._current_filter is None:
                return
            d = ApkIntentData(
                scheme=self._attr_str(attrs, "scheme"),
                host=self._attr_str(attrs, "host"),
                port=self._attr_str(attrs, "port"),
                path=self._attr_str(attrs, "path"),
                path_prefix=self._attr_str(attrs, "pathPrefix"),
                path_pattern=self._attr_str(attrs, "pathPattern"),
                mime_type=self._attr_str(attrs, "mimeType"),
            )
            if not d.is_empty():
                self._current_filter.data.append(d)


def _collect_abis(names: list[str]) -> list[str]:
    abis: list[str] = []
    seen: set[str] = set()
    for name in names:
        if not name.startswith("lib/") or not name.endswith(".so"):
            continue
        parts = name.split("/")
        if len(parts) < 3:
            continue
        abi = parts[1]
        if abi and abi not in seen:
            seen.add(abi)
            abis.append(abi)
    return sorted(abis)


def _file_md5(path: Path, *, limit: int = 64 * 1024 * 1024) -> str:
    h = hashlib.md5()
    size = 0
    with path.open("rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
            size += len(chunk)
            if size >= limit:
                return h.hexdigest() + " (partial)"
    return h.hexdigest()


def analyze_apk(path: str | Path) -> ApkInfo:
    """分析本地 APK，返回结构化信息。"""
    apk_path = Path(path)
    if not apk_path.is_file():
        raise FileNotFoundError(f"APK 不存在: {apk_path}")
    if apk_path.suffix.lower() != ".apk":
        raise ValueError("请选择 .apk 文件")

    info = ApkInfo(path=apk_path.resolve(), file_size=apk_path.stat().st_size)
    try:
        info.file_md5 = _file_md5(apk_path)
    except OSError as e:
        info.warnings.append(f"计算 MD5 失败: {e}")

    try:
        with zipfile.ZipFile(apk_path, "r") as zf:
            names = zf.namelist()
            dex_names = [n for n in names if n.startswith("classes") and n.endswith(".dex")]
            info.dex_count = len(dex_names)
            info.has_dex = info.dex_count > 0
            info.abis = _collect_abis(names)
            info.has_native = bool(info.abis)
            if "AndroidManifest.xml" not in names:
                raise RuntimeError("APK 内缺少 AndroidManifest.xml")
            manifest_data = zf.read("AndroidManifest.xml")
    except zipfile.BadZipFile as e:
        raise RuntimeError(f"不是有效的 APK/ZIP: {e}") from e

    try:
        parser = _AxmlParser(manifest_data)
        parser.parse()
        info.package = parser.package
        info.version_code = parser.version_code
        info.version_name = parser.version_name
        info.min_sdk = parser.min_sdk
        info.target_sdk = parser.target_sdk
        info.max_sdk = parser.max_sdk
        info.label = parser.label
        info.icon = parser.icon
        info.debuggable = parser.debuggable
        info.permissions = sorted(parser.permissions)
        info.activities = parser.activities
        info.services = parser.services
        info.receivers = parser.receivers
        info.providers = parser.providers
        info.intent_filters = info.collect_intent_filters()
    except Exception as e:
        info.warnings.append(f"解析 AndroidManifest 失败: {e}")
        if not info.package:
            raise RuntimeError(f"解析 AndroidManifest 失败: {e}") from e

    if not info.package:
        info.warnings.append("未能解析 package 名，APK 可能使用了特殊打包方式")
    return info


# 危险权限：需用户运行时授权（Android 6+），非安装即自动授予。
_DANGEROUS_PERMISSIONS: frozenset[str] = frozenset(
    {
        "android.permission.READ_CALENDAR",
        "android.permission.WRITE_CALENDAR",
        "android.permission.CAMERA",
        "android.permission.READ_CONTACTS",
        "android.permission.WRITE_CONTACTS",
        "android.permission.GET_ACCOUNTS",
        "android.permission.ACCESS_FINE_LOCATION",
        "android.permission.ACCESS_COARSE_LOCATION",
        "android.permission.ACCESS_BACKGROUND_LOCATION",
        "android.permission.RECORD_AUDIO",
        "android.permission.READ_PHONE_STATE",
        "android.permission.READ_PHONE_NUMBERS",
        "android.permission.CALL_PHONE",
        "android.permission.READ_CALL_LOG",
        "android.permission.WRITE_CALL_LOG",
        "android.permission.ADD_VOICEMAIL",
        "android.permission.USE_SIP",
        "android.permission.PROCESS_OUTGOING_CALLS",
        "android.permission.BODY_SENSORS",
        "android.permission.BODY_SENSORS_BACKGROUND",
        "android.permission.SEND_SMS",
        "android.permission.RECEIVE_SMS",
        "android.permission.READ_SMS",
        "android.permission.RECEIVE_WAP_PUSH",
        "android.permission.RECEIVE_MMS",
        "android.permission.READ_EXTERNAL_STORAGE",
        "android.permission.WRITE_EXTERNAL_STORAGE",
        "android.permission.ACTIVITY_RECOGNITION",
        "android.permission.ACCESS_MEDIA_LOCATION",
        "android.permission.BLUETOOTH_SCAN",
        "android.permission.BLUETOOTH_CONNECT",
        "android.permission.BLUETOOTH_ADVERTISE",
        "android.permission.NEARBY_WIFI_DEVICES",
        "android.permission.READ_MEDIA_IMAGES",
        "android.permission.READ_MEDIA_VIDEO",
        "android.permission.READ_MEDIA_AUDIO",
        "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
        "android.permission.POST_NOTIFICATIONS",
        "android.permission.UWB_RANGING",
        "android.permission.RANGING",
    }
)

# 特殊权限：不走运行时弹窗，但需用户在设置页手动开启（非系统默认授予）。
_SPECIAL_PERMISSIONS: frozenset[str] = frozenset(
    {
        "android.permission.SYSTEM_ALERT_WINDOW",
        "android.permission.WRITE_SETTINGS",
        "android.permission.REQUEST_INSTALL_PACKAGES",
        "android.permission.MANAGE_EXTERNAL_STORAGE",
        "android.permission.SCHEDULE_EXACT_ALARM",
        "android.permission.USE_EXACT_ALARM",
        "android.permission.ACCESS_NOTIFICATION_POLICY",
        "android.permission.PACKAGE_USAGE_STATS",
        "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
        "android.permission.MANAGE_MEDIA",
        "android.permission.BIND_NOTIFICATION_LISTENER_SERVICE",
        "android.permission.CAPTURE_VIDEO_OUTPUT",
        "android.permission.CAPTURE_AUDIO_OUTPUT",
        "android.permission.MEDIA_CONTENT_CONTROL",
    }
)


def classify_permissions(perms: list[str]) -> dict[str, list[str]]:
    """按保护级别粗分声明权限。

    - auto: 普通/签名类，安装时由系统默认授予，一般无需用户再点授权
    - runtime: 危险权限，需运行时弹窗由用户授予
    - special: 特殊访问权限，通常要进设置页手动开
    """
    auto: list[str] = []
    runtime: list[str] = []
    special: list[str] = []
    for p in perms:
        name = str(p).strip()
        if not name:
            continue
        if name in _SPECIAL_PERMISSIONS:
            special.append(name)
        elif name in _DANGEROUS_PERMISSIONS:
            runtime.append(name)
        else:
            auto.append(name)
    return {
        "auto": sorted(auto),
        "runtime": sorted(runtime),
        "special": sorted(special),
    }


def _parse_requested_permissions(dumpsys_text: str) -> list[str]:
    """从 dumpsys package 文本解析 requested permissions 列表。"""
    perms: set[str] = set()
    in_section = False
    for raw in dumpsys_text.splitlines():
        line = raw.rstrip()
        stripped = line.strip()
        low = stripped.lower()
        if low in ("requested permissions:", "requested permissions"):
            in_section = True
            continue
        if not in_section:
            continue
        if stripped.endswith(":") and (not line[:1].isspace()):
            break
        if stripped.startswith("User ") or stripped.startswith("Package ["):
            break
        if not stripped:
            continue
        name = stripped.split(":", 1)[0].strip()
        if name and "." in name:
            perms.add(name)
    return sorted(perms)


def _parse_grant_sections(
    dumpsys_text: str,
) -> tuple[list[str], list[str], list[str]]:
    """解析 dumpsys 中 install / runtime 权限授予状态。

    返回 (install_granted, runtime_granted, runtime_denied)。
    install 段为系统在安装时默认授予、通常无需用户再手动点授权的权限。
    """
    install_yes: dict[str, bool] = {}
    runtime_status: dict[str, bool] = {}
    section: str | None = None  # "install" | "runtime"

    for raw in dumpsys_text.splitlines():
        line = raw.rstrip()
        stripped = line.strip()
        low = stripped.lower()
        if low.startswith("install permissions"):
            section = "install"
            continue
        if low.startswith("runtime permissions"):
            section = "runtime"
            continue
        if section and stripped.endswith(":") and not line[:1].isspace():
            if not low.startswith("install permissions") and not low.startswith(
                "runtime permissions"
            ):
                section = None
            continue
        if not section or "granted=" not in stripped:
            continue
        name = stripped.split(":", 1)[0].strip()
        if not name or "." not in name:
            continue
        gpart = stripped.lower()
        granted = "granted=true" in gpart and "granted=false" not in gpart
        if "granted=false" in gpart:
            granted = False
        if section == "install":
            if granted:
                install_yes[name] = True
            else:
                install_yes.setdefault(name, False)
        else:
            if not granted:
                runtime_status[name] = False
            else:
                runtime_status.setdefault(name, True)

    install_granted = sorted(p for p, ok in install_yes.items() if ok)
    runtime_granted = sorted(p for p, ok in runtime_status.items() if ok)
    runtime_denied = sorted(p for p, ok in runtime_status.items() if not ok)
    return install_granted, runtime_granted, runtime_denied


def _merge_grant_sections(
    install_granted: list[str],
    runtime_granted: list[str],
    runtime_denied: list[str],
) -> tuple[list[str], list[str]]:
    """根据已解析的 install/runtime 权限段合并 (已授予, 未授予)。"""
    status: dict[str, bool] = {p: True for p in install_granted}
    for p in runtime_granted:
        status.setdefault(p, True)
    for p in runtime_denied:
        status[p] = False
    yes = sorted(p for p, ok in status.items() if ok)
    no = sorted(p for p, ok in status.items() if not ok)
    return yes, no


def _parse_grant_status(dumpsys_text: str) -> tuple[list[str], list[str]]:
    """解析 install/runtime permissions 的 granted 状态。

    返回 (已授予, 未授予)。同一权限若出现 granted=false，以未授予为准。
    """
    install_granted, runtime_granted, runtime_denied = _parse_grant_sections(dumpsys_text)
    return _merge_grant_sections(install_granted, runtime_granted, runtime_denied)


def query_installed_package(device: str | None, package: str) -> dict[str, object]:
    """查询设备上已安装包的版本与权限信息（需 adb）。"""
    from tools.adb_runtime import adb_available, run_adb

    empty = {
        "installed": "false",
        "enabled": True,
        "permissions": [],
        "granted": [],
        "denied": [],
        "install_granted": [],
        "runtime_granted": [],
        "runtime_denied": [],
    }
    if not package:
        raise ValueError("包名为空")
    if not adb_available():
        raise RuntimeError("未找到 adb")
    r = run_adb(["shell", "dumpsys", "package", package], device, timeout=30.0)
    text = (r.stdout or "") + "\n" + (r.stderr or "")
    if r.returncode != 0 and "Unable to find package" in text:
        return dict(empty)
    if "Unable to find package" in text or (
        "Package [" not in text and "versionName=" not in text
    ):
        p = run_adb(["shell", "pm", "path", package], device, timeout=15.0)
        if p.returncode != 0 or not (p.stdout or "").strip():
            return dict(empty)
    out: dict[str, object] = {
        "installed": "true",
        "enabled": True,
        "permissions": [],
        "granted": [],
        "denied": [],
        "install_granted": [],
        "runtime_granted": [],
        "runtime_denied": [],
    }
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("versionCode="):
            part = s.split(" ", 1)[0]
            out["versionCode"] = part.split("=", 1)[1]
            if "minSdk=" in s:
                for tok in s.split():
                    if tok.startswith("minSdk="):
                        out["minSdk"] = tok.split("=", 1)[1]
                    if tok.startswith("targetSdk="):
                        out["targetSdk"] = tok.split("=", 1)[1]
        elif s.startswith("versionName="):
            out["versionName"] = s.split("=", 1)[1]
        elif s.startswith("firstInstallTime="):
            out["firstInstallTime"] = s.split("=", 1)[1]
        elif s.startswith("lastUpdateTime="):
            out["lastUpdateTime"] = s.split("=", 1)[1]
        elif s.startswith("User ") and "enabled=" in s:
            m_en = re.search(r"\benabled=(\d+)\b", s)
            if m_en:
                # Android PackageManager enabled states: 0=DEFAULT, 1=ENABLED; 2/3/4=DISABLED*
                out["enabled"] = m_en.group(1) in ("0", "1")
    out["permissions"] = _parse_requested_permissions(text)
    install_granted, runtime_granted, runtime_denied = _parse_grant_sections(text)
    yes, no = _merge_grant_sections(install_granted, runtime_granted, runtime_denied)
    out["install_granted"] = install_granted
    out["runtime_granted"] = runtime_granted
    out["runtime_denied"] = runtime_denied
    out["granted"] = yes
    out["denied"] = no
    try:
        p = run_adb(["shell", "pm", "path", package], device, timeout=15.0)
        paths = [
            ln.strip().removeprefix("package:")
            for ln in (p.stdout or "").splitlines()
            if ln.strip()
        ]
        if paths:
            out["path"] = paths[0] if len(paths) == 1 else "; ".join(paths)
    except Exception:
        pass
    if "versionName" not in out and "versionCode" not in out:
        if f"Package [{package}]" not in text and ("Package [" + package + "]") not in text:
            if not out.get("path"):
                return dict(empty)
    return out


def _format_grant_lists(
    install_granted: list[str],
    runtime_granted: list[str],
    runtime_denied: list[str],
    *,
    granted: list[str] | None = None,
    denied: list[str] | None = None,
) -> list[str]:
    lines = ["", "设备权限状态:"]
    lines.append(f"  系统默认已授予 / 无需用户再点 ({len(install_granted)}):")
    if install_granted:
        lines.extend(f"    · {p}" for p in install_granted)
    else:
        lines.append("    （无）")
    lines.append(f"  运行时已授予 ({len(runtime_granted)}):")
    if runtime_granted:
        lines.extend(f"    · {p}" for p in runtime_granted)
    else:
        lines.append("    （无）")
    lines.append(f"  运行时未授予 / 需用户手动 ({len(runtime_denied)}):")
    if runtime_denied:
        lines.extend(f"    · {p}" for p in runtime_denied)
    else:
        lines.append("    （无）")
    # 兼容旧汇总字段（若分区为空但汇总有值）
    if not install_granted and not runtime_granted and not runtime_denied:
        g = granted or []
        d = denied or []
        if g or d:
            lines.append(f"  已授予 ({len(g)}):")
            lines.extend(f"    · {p}" for p in g) if g else lines.append("    （无）")
            lines.append(f"  未授予 ({len(d)}):")
            lines.extend(f"    · {p}" for p in d) if d else lines.append("    （无）")
    return lines


def _format_permission_diff(apk_perms: list[str], device_perms: list[str]) -> list[str]:
    apk_set = set(apk_perms)
    dev_set = set(device_perms)
    only_apk = sorted(apk_set - dev_set)
    only_dev = sorted(dev_set - apk_set)

    lines = ["", "相对新包声明:"]
    if not only_apk and not only_dev:
        lines.append("  无变化")
        return lines
    if only_apk:
        lines.append(f"  新包多了 {len(only_apk)} 个:")
        lines.extend(f"    + {p}" for p in only_apk)
    if only_dev:
        lines.append(f"  新包少了 {len(only_dev)} 个:")
        lines.extend(f"    - {p}" for p in only_dev)
    return lines


def compare_with_device_data(info: ApkInfo, device: str | None) -> dict:
    """结构化对比结果（版本 / 权限差异 / 授予状态）。"""
    if not info.package:
        return {
            "ok": False,
            "installed": False,
            "package": "",
            "verdict": "无法对比：APK 包名未知",
            "verdict_kind": "error",
        }
    try:
        installed = query_installed_package(device, info.package)
    except Exception as e:
        return {
            "ok": False,
            "installed": False,
            "package": info.package,
            "verdict": f"查询设备失败: {e}",
            "verdict_kind": "error",
        }

    apk_vn = info.version_name or ""
    apk_vc = info.version_code or ""
    classified = classify_permissions(info.permissions)
    if installed.get("installed") != "true":
        return {
            "ok": True,
            "installed": False,
            "package": info.package,
            "verdict": "设备未安装，可直接装",
            "verdict_kind": "fresh",
            "apk_version_name": apk_vn,
            "apk_version_code": apk_vc,
            "device_version_name": "",
            "device_version_code": "",
            "granted": [],
            "denied": [],
            "install_granted": [],
            "runtime_granted": [],
            "runtime_denied": [],
            "permissions_auto": classified["auto"],
            "permissions_runtime": classified["runtime"],
            "permissions_special": classified["special"],
            "perms_added": list(info.permissions),
            "perms_removed": [],
        }

    dev_vn = str(installed.get("versionName", "") or "")
    dev_vc = str(installed.get("versionCode", "") or "")
    try:
        apk_code = int(str(info.version_code))
        dev_code = int(str(installed.get("versionCode", "")))
    except ValueError:
        verdict = "版本无法比较"
        kind = "unknown"
    else:
        if apk_code > dev_code:
            verdict, kind = "可升级", "upgrade"
        elif apk_code == dev_code:
            verdict, kind = "版本相同", "same"
        else:
            verdict, kind = "新包更旧，需先卸载再装", "downgrade"

    device_perms = installed.get("permissions")
    if not isinstance(device_perms, list):
        device_perms = []
    granted = installed.get("granted")
    denied = installed.get("denied")
    install_granted = installed.get("install_granted")
    runtime_granted = installed.get("runtime_granted")
    runtime_denied = installed.get("runtime_denied")
    if not isinstance(granted, list):
        granted = []
    if not isinstance(denied, list):
        denied = []
    if not isinstance(install_granted, list):
        install_granted = []
    if not isinstance(runtime_granted, list):
        runtime_granted = []
    if not isinstance(runtime_denied, list):
        runtime_denied = []

    apk_set = set(info.permissions)
    # 设备侧：优先展示与本 APK 声明相关的系统默认授予权限
    install_for_apk = sorted(str(p) for p in install_granted if str(p) in apk_set)
    runtime_g_for_apk = sorted(
        str(p) for p in runtime_granted if not apk_set or str(p) in apk_set
    )
    runtime_d_for_apk = sorted(
        str(p) for p in runtime_denied if not apk_set or str(p) in apk_set
    )
    # 若 dumpsys 未分出 install 段，用声明分类中的 auto ∩ granted 兜底
    if not install_for_apk and classified["auto"]:
        gset = {str(p) for p in granted}
        install_for_apk = sorted(p for p in classified["auto"] if p in gset)

    dev_set = {str(p) for p in device_perms}
    return {
        "ok": True,
        "installed": True,
        "package": info.package,
        "verdict": verdict,
        "verdict_kind": kind,
        "apk_version_name": apk_vn,
        "apk_version_code": apk_vc,
        "device_version_name": dev_vn,
        "device_version_code": dev_vc,
        "device_min_sdk": str(installed.get("minSdk", "") or ""),
        "device_target_sdk": str(installed.get("targetSdk", "") or ""),
        "granted": [str(p) for p in granted],
        "denied": [str(p) for p in denied],
        "install_granted": install_for_apk,
        "runtime_granted": runtime_g_for_apk,
        "runtime_denied": runtime_d_for_apk,
        "permissions_auto": classified["auto"],
        "permissions_runtime": classified["runtime"],
        "permissions_special": classified["special"],
        "perms_added": sorted(apk_set - dev_set),
        "perms_removed": sorted(dev_set - apk_set),
    }


def format_compare_report(info: ApkInfo, data: dict) -> str:
    """把结构化对比结果格式化为日志文本。"""
    lines = [f"包名: {data.get('package') or info.package or '?'}", ""]
    lines.append(f"结论: {data.get('verdict', '')}")
    if not data.get("ok"):
        return "\n".join(lines) + "\n"
    if not data.get("installed"):
        lines.append(
            f"版本: 新包 {data.get('apk_version_name') or '?'} "
            f"({data.get('apk_version_code') or '?'})"
        )
        auto = data.get("permissions_auto") or []
        runtime = data.get("permissions_runtime") or []
        special = data.get("permissions_special") or []
        if isinstance(auto, list) and auto:
            lines.append(f"系统默认授予 ({len(auto)}):")
            lines.extend(f"  · {p}" for p in auto)
        if isinstance(runtime, list) and runtime:
            lines.append(f"需运行时授权 ({len(runtime)}):")
            lines.extend(f"  · {p}" for p in runtime)
        if isinstance(special, list) and special:
            lines.append(f"需特殊授权 ({len(special)}):")
            lines.extend(f"  · {p}" for p in special)
        if not auto and not runtime and not special:
            added = data.get("perms_added") or []
            if isinstance(added, list) and added:
                lines.append(f"新包声明权限 ({len(added)}):")
                lines.extend(f"  · {p}" for p in added)
        return "\n".join(lines) + "\n"

    lines.append(
        f"版本: 设备 {data.get('device_version_name') or '?'}("
        f"{data.get('device_version_code') or '?'})  ->  新包 "
        f"{data.get('apk_version_name') or '?'}({data.get('apk_version_code') or '?'})"
    )
    install_granted = (
        data.get("install_granted") if isinstance(data.get("install_granted"), list) else []
    )
    runtime_granted = (
        data.get("runtime_granted") if isinstance(data.get("runtime_granted"), list) else []
    )
    runtime_denied = (
        data.get("runtime_denied") if isinstance(data.get("runtime_denied"), list) else []
    )
    granted = data.get("granted") if isinstance(data.get("granted"), list) else []
    denied = data.get("denied") if isinstance(data.get("denied"), list) else []
    lines.extend(
        _format_grant_lists(
            [str(p) for p in install_granted],
            [str(p) for p in runtime_granted],
            [str(p) for p in runtime_denied],
            granted=[str(p) for p in granted],
            denied=[str(p) for p in denied],
        )
    )
    added = data.get("perms_added") if isinstance(data.get("perms_added"), list) else []
    removed = (
        data.get("perms_removed") if isinstance(data.get("perms_removed"), list) else []
    )
    diff_lines = ["", "相对新包声明:"]
    if not added and not removed:
        diff_lines.append("  无变化")
    else:
        if added:
            diff_lines.append(f"  新包多了 {len(added)} 个:")
            diff_lines.extend(f"    + {p}" for p in added)
        if removed:
            diff_lines.append(f"  新包少了 {len(removed)} 个:")
            diff_lines.extend(f"    - {p}" for p in removed)
    lines.extend(diff_lines)
    return "\n".join(lines) + "\n"


def compare_with_device(info: ApkInfo, device: str | None) -> str:
    """对比本地 APK 与设备已装版本（文本，兼容日志输出）。"""
    return format_compare_report(info, compare_with_device_data(info, device))
