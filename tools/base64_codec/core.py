#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""BASE64 编码 / 解码。"""

from __future__ import annotations

import base64
import binascii
import re


def _normalize_b64_input(text: str) -> str:
    """去掉空白，兼容换行分段。"""
    return re.sub(r"\s+", "", text.strip())


def _pad_b64(data: str) -> str:
    missing = (-len(data)) % 4
    if missing:
        data += "=" * missing
    return data


def compact_json_if_possible(text: str) -> tuple[str, bool]:
    """若为合法 JSON 则压成紧凑单行（与美化仅差空白，便于加密结果与原文一致）。"""
    import json

    stripped = text.strip()
    if not stripped:
        return text, False
    if stripped.startswith("\ufeff"):
        stripped = stripped[1:]
    try:
        obj = json.loads(stripped)
    except json.JSONDecodeError:
        return text, False
    compact = json.dumps(
        obj,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=False,
    )
    return compact, True


def encode_text(
    text: str,
    *,
    urlsafe: bool = False,
    lines: int = 0,
    compact_json: bool = True,
) -> str:
    payload = text
    if compact_json:
        compacted, ok = compact_json_if_possible(text)
        if ok:
            payload = compacted
    raw = payload.encode("utf-8")
    if urlsafe:
        out = base64.urlsafe_b64encode(raw).decode("ascii")
    else:
        out = base64.b64encode(raw).decode("ascii")
    if lines and lines > 0:
        chunks = [out[i : i + lines] for i in range(0, len(out), lines)]
        return "\n".join(chunks)
    return out


def beautify_json(text: str, *, indent: int = 2) -> tuple[str, bool]:
    """若为合法 JSON 则仅做缩进美化，不改变键顺序与数据含义（sort_keys=False）。"""
    import json

    stripped = text.strip()
    if not stripped:
        return text, False
    if stripped.startswith("\ufeff"):
        stripped = stripped[1:]
    try:
        obj = json.loads(stripped)
    except json.JSONDecodeError:
        return text, False
    pretty = json.dumps(
        obj,
        ensure_ascii=False,
        indent=indent,
        sort_keys=False,
    )
    return pretty + "\n", True


def decode_text(text: str, *, urlsafe: bool = False, pretty_json: bool = True) -> str:
    data = _pad_b64(_normalize_b64_input(text))
    if not data:
        raise ValueError("请输入 Base64 内容")
    try:
        if urlsafe:
            raw = base64.urlsafe_b64decode(data, validate=False)
        else:
            raw = base64.b64decode(data, validate=False)
    except (binascii.Error, ValueError) as e:
        raise ValueError(f"Base64 解码失败: {e}") from e
    try:
        plain = raw.decode("utf-8")
    except UnicodeDecodeError:
        plain = raw.decode("utf-8", errors="replace")
    if pretty_json:
        formatted, ok = beautify_json(plain)
        if ok:
            return formatted
    return plain


def encode_bytes(data: bytes, *, urlsafe: bool = False) -> str:
    if urlsafe:
        return base64.urlsafe_b64encode(data).decode("ascii")
    return base64.b64encode(data).decode("ascii")


def decode_to_bytes(text: str, *, urlsafe: bool = False) -> bytes:
    data = _pad_b64(_normalize_b64_input(text))
    if urlsafe:
        return base64.urlsafe_b64decode(data, validate=False)
    return base64.b64decode(data, validate=False)
