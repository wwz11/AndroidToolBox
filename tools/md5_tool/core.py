#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MD5 摘要计算。"""

from __future__ import annotations

import hashlib
from pathlib import Path

_CHUNK_SIZE = 1024 * 1024


def format_md5(hex_digest: str, *, uppercase: bool = False) -> str:
    return hex_digest.upper() if uppercase else hex_digest.lower()


def md5_bytes(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def md5_text(text: str, *, encoding: str = "utf-8") -> str:
    return md5_bytes(text.encode(encoding))


def md5_file(path: Path, *, chunk_size: int = _CHUNK_SIZE) -> str:
    digest = hashlib.md5()
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()
