#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地工具：MD5 / BASE64 / 条码 / GOTA / 打开路径。"""

from __future__ import annotations

import base64
import hashlib
import io
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from tools.barcode_gen.core import render_barcode_image
from tools.base64_codec.core import decode_text, encode_text
from tools.md5_tool.core import format_md5, md5_bytes, md5_text
from tools.serial_prefix.core import (
    DEFAULT_CHUNK,
    DEFAULT_PREFIX,
    convert_file,
    convert_text,
)

router = APIRouter()


def default_gota_out_dir() -> Path:
    """GOTA 分割输出：userdata/output/gota。"""
    from tools.bundled_paths import output_dir

    return output_dir("gota")

class Md5TextBody(BaseModel):
    text: str = ""
    uppercase: bool = False


class Base64Body(BaseModel):
    text: str = ""
    urlsafe: bool = False
    compact_json: bool = True
    pretty_json: bool = True
    lines: int = 0


class BarcodeBody(BaseModel):
    data: str = Field(..., min_length=1)


class OpenPathBody(BaseModel):
    path: str = Field(..., min_length=1)


@router.post("/md5/text")
def md5_of_text(body: Md5TextBody) -> dict:
    digest = format_md5(md5_text(body.text), uppercase=body.uppercase)
    return {"md5": digest, "chars": len(body.text)}


@router.post("/md5/file")
async def md5_of_file(
    file: UploadFile = File(...),
    uppercase: bool = Form(False),
) -> dict:
    hasher = hashlib.md5()
    total_bytes = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        hasher.update(chunk)
        total_bytes += len(chunk)
    digest = format_md5(hasher.hexdigest(), uppercase=uppercase)
    return {
        "md5": digest,
        "filename": file.filename or "",
        "bytes": total_bytes,
    }


@router.post("/base64/encode")
def b64_encode(body: Base64Body) -> dict:
    try:
        out = encode_text(
            body.text,
            urlsafe=body.urlsafe,
            lines=body.lines,
            compact_json=body.compact_json,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"result": out}


@router.post("/base64/decode")
def b64_decode(body: Base64Body) -> dict:
    try:
        out = decode_text(
            body.text, urlsafe=body.urlsafe, pretty_json=body.pretty_json
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"result": out}


@router.post("/open-path")
def open_path(body: OpenPathBody) -> dict:
    """用系统资源管理器打开文件或目录。"""
    p = Path(body.path).expanduser()
    try:
        p = p.resolve()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    target = p if p.exists() else p.parent
    if not target.exists():
        raise HTTPException(status_code=404, detail=f"路径不存在: {body.path}")
    try:
        if sys.platform == "win32":
            if target.is_file():
                subprocess.run(
                    ["explorer", "/select,", str(target)],
                    check=False,
                )
            else:
                os.startfile(str(target))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.run(["open", str(target)], check=False)
        else:
            subprocess.run(["xdg-open", str(target)], check=False)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True, "path": str(target), "message": f"已打开 {target}"}


@router.post("/barcode/preview")
def barcode_preview(body: BarcodeBody) -> dict:
    try:
        img = render_barcode_image(body.data)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        raw = buf.getvalue()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        msg = str(exc) or exc.__class__.__name__
        if "cannot open resource" in msg.lower():
            msg = "条码字体不可用，请重开应用或重新安装完整包"
        raise HTTPException(status_code=502, detail=msg) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "ok": True,
        "mime": "image/png",
        "png_base64": base64.b64encode(raw).decode("ascii"),
        "width": img.width,
        "height": img.height,
    }


class GotaSplitTextBody(BaseModel):
    text: str = ""
    prefix: str = DEFAULT_PREFIX
    chunk_size: int = Field(default=DEFAULT_CHUNK, ge=1)
    out_dir: str = ""


@router.get("/gota/default-dir")
def gota_default_dir() -> dict:
    dest = default_gota_out_dir()
    try:
        dest.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    return {"ok": True, "out_dir": str(dest.resolve())}


def _resolve_gota_out_dir(raw_out: str) -> Path:
    dest = Path(raw_out).expanduser() if raw_out.strip() else default_gota_out_dir()
    try:
        return dest.resolve()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"无效输出目录: {exc}") from exc


@router.post("/gota/split")
async def gota_split(
    file: UploadFile = File(...),
    prefix: str = Form(DEFAULT_PREFIX),
    chunk_size: int = Form(DEFAULT_CHUNK),
    out_dir: str = Form(""),
) -> dict:
    """分割序列号 txt，直接写入 out_dir（不打包 zip）。"""
    if chunk_size < 1:
        raise HTTPException(status_code=400, detail="每文件行数必须 >= 1")
    dest = _resolve_gota_out_dir(str(out_dir or ""))

    name = (file.filename or "serials.txt").strip() or "serials.txt"
    try:
        with tempfile.TemporaryDirectory(prefix="toolbox_gota_") as tmp:
            src = Path(tmp) / Path(name).name
            with src.open("wb") as f:
                while True:
                    chunk = await file.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
            total, files = convert_file(src, dest, chunk_size, prefix)
            if total == 0:
                raise HTTPException(status_code=400, detail="源文件没有有效行")
            names = [p.name for p in files]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return {
        "ok": True,
        "total_lines": total,
        "part_count": len(names),
        "out_dir": str(dest),
        "files": names,
    }


@router.post("/gota/split-text")
def gota_split_text(body: GotaSplitTextBody) -> dict:
    """直接粘贴文本分割序列号，写入 out_dir。"""
    text = body.text or ""
    if not text.strip():
        raise HTTPException(status_code=400, detail="请输入序列号文本")
    dest = _resolve_gota_out_dir(body.out_dir or "")
    try:
        total, files = convert_text(
            text, dest, body.chunk_size, body.prefix, output_stem="pasted_serial"
        )
        if total == 0:
            raise HTTPException(status_code=400, detail="文本没有有效行")
        names = [p.name for p in files]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return {
        "ok": True,
        "total_lines": total,
        "part_count": len(names),
        "out_dir": str(dest),
        "files": names,
    }


class LogCleanBody(BaseModel):
    max_days: int = 14
    max_total_mb: int = 500


@router.get("/logs/stats")
def logs_stats() -> dict:
    from tools.log_manager import get_logs_stats

    return get_logs_stats()


@router.post("/logs/clean")
def logs_clean(body: LogCleanBody | None = None) -> dict:
    from tools.log_manager import cleanup_expired_logs

    b = body or LogCleanBody()
    return cleanup_expired_logs(max_days=b.max_days, max_total_mb=b.max_total_mb)
