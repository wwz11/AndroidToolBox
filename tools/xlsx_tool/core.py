# -*- coding: utf-8 -*-
"""通用 XLSX 工具：预览 / 导出 CSV / CSV 转 XLSX。"""

from __future__ import annotations

import csv
import hashlib
import io
import json
from pathlib import Path
from typing import Any

from openpyxl import Workbook, load_workbook
from openpyxl.utils import get_column_letter


def default_xlsx_out_dir() -> Path:
    from tools.bundled_paths import output_dir

    return output_dir("xlsx")


_MAX_SNAPSHOT_ROWS = 400
_MAX_SNAPSHOT_COLS = 36
# Univer 合并过多时一点击编辑就会卡死（已知问题），默认不导入合并
_MAX_MERGES = 0
_MAX_IMAGES = 24

# Univer enums（与 @univerjs/core 对齐）
_HT = {"left": 1, "center": 2, "right": 3, "justify": 4, "distributed": 6, "centerContinuous": 2}
_VT = {"top": 1, "center": 2, "bottom": 3}
_WRAP = {"wrapText": 3}  # openpyxl wrap_text True → WRAP
_BORDER = {
    "thin": 1,
    "hair": 2,
    "dotted": 3,
    "dashed": 4,
    "dashDot": 5,
    "dashDotDot": 6,
    "double": 7,
    "medium": 8,
    "mediumDashed": 9,
    "mediumDashDot": 10,
    "mediumDashDotDot": 11,
    "slantDashDot": 12,
    "thick": 13,
}


def _new_id(prefix: str) -> str:
    import random
    import string

    suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=8))
    return f"{prefix}-{suffix}"


def _color_to_rgb(color) -> str | None:
    """openpyxl Color → #RRGGBB。"""
    if color is None:
        return None
    rgb = getattr(color, "rgb", None)
    if rgb and isinstance(rgb, str) and rgb not in ("00000000", "None"):
        s = rgb[-6:] if len(rgb) >= 6 else rgb
        if len(s) == 6 and all(ch in "0123456789abcdefABCDEF" for ch in s):
            return f"#{s.upper()}"
    theme = getattr(color, "theme", None)
    # 主题色无法精确还原，给常见默认
    if theme is not None:
        theme_map = {
            0: "#000000",
            1: "#FFFFFF",
            2: "#1F497D",
            3: "#EEECE1",
            4: "#4F81BD",
            5: "#C0504D",
            6: "#9BBB59",
            7: "#8064A2",
            8: "#4BACC6",
            9: "#F79646",
        }
        return theme_map.get(int(theme))
    return None


def _border_side(side) -> dict[str, Any] | None:
    if side is None or not getattr(side, "style", None):
        return None
    style = _BORDER.get(str(side.style), 1)
    rgb = _color_to_rgb(getattr(side, "color", None)) or "#000000"
    return {"s": style, "cl": {"rgb": rgb}}


def _style_from_cell(cell) -> dict[str, Any] | None:
    """openpyxl 单元格样式 → Univer IStyleData。"""
    style: dict[str, Any] = {}
    font = cell.font
    if font is not None:
        if font.name:
            style["ff"] = str(font.name)
        if font.size:
            try:
                style["fs"] = float(font.size)
            except (TypeError, ValueError):
                pass
        if font.bold:
            style["bl"] = 1
        if font.italic:
            style["it"] = 1
        if font.underline and font.underline != "none":
            style["ul"] = {"s": 1}
        if font.strike:
            style["st"] = {"s": 1}
        rgb = _color_to_rgb(font.color)
        if rgb:
            style["cl"] = {"rgb": rgb}

    fill = cell.fill
    if fill is not None:
        pattern = getattr(fill, "patternType", None) or getattr(fill, "fill_type", None)
        if pattern and pattern != "none":
            fg = getattr(fill, "fgColor", None) or getattr(fill, "start_color", None)
            rgb = _color_to_rgb(fg)
            if rgb:
                style["bg"] = {"rgb": rgb}

    align = cell.alignment
    if align is not None:
        if align.horizontal:
            ht = _HT.get(str(align.horizontal))
            if ht is not None:
                style["ht"] = ht
        if align.vertical:
            vt = _VT.get(str(align.vertical))
            if vt is not None:
                style["vt"] = vt
        if align.wrap_text:
            style["tb"] = 3  # WrapStrategy.WRAP

    border = cell.border
    if border is not None:
        bd: dict[str, Any] = {}
        for key, attr in (("t", "top"), ("r", "right"), ("b", "bottom"), ("l", "left")):
            side = _border_side(getattr(border, attr, None))
            if side:
                bd[key] = side
        if bd:
            style["bd"] = bd

    num = cell.number_format
    if num and num not in ("General", "general", "@"):
        style["n"] = {"pattern": str(num)}

    return style or None


def _style_has_visual(style: dict[str, Any]) -> bool:
    """空单元格若仅有默认字体名/字号，不写入，避免撑爆 cellData 导致卡顿。"""
    return any(
        k in style
        for k in ("bg", "bd", "ht", "vt", "tb", "n", "bl", "it", "ul", "st", "cl")
    )


def _col_width_px(ws, col_idx: int) -> float | None:
    """Excel 列宽（字符）≈ px。"""
    letter = get_column_letter(col_idx)
    dim = ws.column_dimensions.get(letter)
    if dim is None or dim.width is None:
        return None
    try:
        return max(24.0, float(dim.width) * 8.0 + 5.0)
    except (TypeError, ValueError):
        return None


def _row_height_px(ws, row_idx: int) -> float | None:
    dim = ws.row_dimensions.get(row_idx)
    if dim is None or dim.height is None:
        return None
    try:
        return max(12.0, float(dim.height) * 1.33)
    except (TypeError, ValueError):
        return None


def _cell_to_univer(
    cell_fmt,
    cell_val,
    *,
    styles: dict[str, Any],
    style_key_of: dict[str, str],
) -> dict[str, Any] | None:
    """取值用 data_only 单元格，样式用格式簿；不写入公式，避免编辑时公式引擎卡死。"""
    if cell_fmt is None and cell_val is None:
        return None
    out: dict[str, Any] = {}
    raw = cell_val.value if cell_val is not None else None
    # 公式格在 data_only 下可能为 None（未缓存），回退显示公式文本（不当作可计算 f）
    if raw is None and cell_fmt is not None:
        fmt_v = cell_fmt.value
        if isinstance(fmt_v, str) and fmt_v.startswith("="):
            # 不当公式：加零宽字符，避免进入编辑时触发公式引擎
            raw = "\u200b" + fmt_v
        else:
            raw = fmt_v

    if raw is None or raw == "":
        pass
    elif isinstance(raw, bool):
        out["v"] = raw
        out["t"] = 3
    elif isinstance(raw, (int, float)) and not isinstance(raw, bool):
        out["v"] = float(raw) if isinstance(raw, float) else int(raw)
        out["t"] = 2
    elif hasattr(raw, "isoformat"):
        try:
            out["v"] = raw.isoformat()
        except Exception:
            out["v"] = str(raw)
        out["t"] = 1
    else:
        text = str(raw)
        # 已缓存的计算结果也可能被写成公式文本；一律当字符串
        if text.startswith("="):
            text = "\u200b" + text
        out["v"] = text
        out["t"] = 1

    if cell_fmt is not None:
        style = _style_from_cell(cell_fmt)
        if style and (("v" in out) or _style_has_visual(style)):
            key = json.dumps(style, sort_keys=True, ensure_ascii=False)
            sid = style_key_of.get(key)
            if sid is None:
                sid = f"s{len(styles)}"
                styles[sid] = style
                style_key_of[key] = sid
            out["s"] = sid

    return out or None


def _extract_sheet_images(
    ws,
    *,
    sheet_index: int,
    sheet_name: str,
    embed_dir: Path,
    use_rows: int,
    use_cols: int,
) -> list[dict[str, Any]]:
    """导出工作表内嵌图片到 embed_dir。"""
    out: list[dict[str, Any]] = []
    images = list(getattr(ws, "_images", None) or [])
    for i, img in enumerate(images[:_MAX_IMAGES]):
        try:
            anchor = getattr(img, "anchor", None)
            row = col = 0
            if anchor is not None:
                fr = getattr(anchor, "_from", None) or getattr(anchor, "from", None)
                if fr is not None:
                    row = int(getattr(fr, "row", 0) or 0)
                    col = int(getattr(fr, "col", 0) or 0)
            if row >= use_rows or col >= use_cols:
                # 仍导出，便于侧栏查看
                pass
            data = None
            if hasattr(img, "_data") and callable(img._data):
                data = img._data()
            elif getattr(img, "ref", None) and Path(str(img.ref)).is_file():
                data = Path(str(img.ref)).read_bytes()
            if not data:
                continue
            ext = ".png"
            ct = str(getattr(img, "format", "") or "").lower()
            if "jpeg" in ct or "jpg" in ct:
                ext = ".jpg"
            elif "gif" in ct:
                ext = ".gif"
            name = f"s{sheet_index}_{i}{ext}"
            dest = embed_dir / name
            dest.write_bytes(data)
            w = int(getattr(img, "width", 0) or 160)
            h = int(getattr(img, "height", 0) or 120)
            out.append(
                {
                    "sheetIndex": sheet_index,
                    "sheetName": sheet_name,
                    "row": row,
                    "col": col,
                    "width": max(24, w),
                    "height": max(24, h),
                    "mediaId": name,
                }
            )
        except Exception:
            continue
    return out


def path_to_univer_snapshot(
    path: str | Path,
    *,
    max_rows: int = _MAX_SNAPSHOT_ROWS,
    max_cols: int = _MAX_SNAPSHOT_COLS,
) -> dict[str, Any]:
    """本机 xlsx → Univer 快照。

    为可编辑性做了取舍：
    - 用计算结果填充，不注入公式（避免点击编辑卡死）
    - 合并过多则跳过合并
    - 限制行列，样式去重
    - 抽出内嵌图片供前端叠层显示
    """
    p = Path(path).expanduser()
    try:
        p = p.resolve()
    except Exception as exc:
        raise ValueError(f"无效路径: {exc}") from exc
    if not p.is_file():
        raise ValueError(f"文件不存在: {p}")
    if p.suffix.lower() not in (".xlsx", ".xlsm"):
        raise ValueError("仅支持 .xlsx / .xlsm")

    import uuid

    max_rows = max(1, min(int(max_rows), 2000))
    max_cols = max(1, min(int(max_cols), 80))

    # 每次打开独立目录，避免同路径再次打开时清空其它标签的图库
    path_digest = hashlib.sha1(str(p).encode("utf-8", errors="replace")).hexdigest()[:12]
    digest = f"{path_digest}_{uuid.uuid4().hex[:10]}"
    embed_dir = default_xlsx_out_dir() / "_embeds" / digest
    embed_dir.mkdir(parents=True, exist_ok=True)

    # 值簿：避免公式；格式簿：样式/合并/图片
    wb_val = load_workbook(p, data_only=True, read_only=False)
    wb_fmt = load_workbook(p, data_only=False, read_only=False)
    try:
        sheets: dict[str, Any] = {}
        sheet_order: list[str] = []
        styles: dict[str, Any] = {}
        style_key_of: dict[str, str] = {}
        drawings: list[dict[str, Any]] = []
        truncated = False
        merges_skipped = False
        warnings: list[str] = []

        for si, ws_fmt in enumerate(wb_fmt.worksheets):
            name = ws_fmt.title or f"Sheet{si + 1}"
            ws_val = wb_val[name] if name in wb_val.sheetnames else wb_val.worksheets[min(si, len(wb_val.worksheets) - 1)]
            sid = _new_id("sheet")
            cell_data: dict[str, dict[str, Any]] = {}
            row_n = int(ws_fmt.max_row or 0)
            col_n = int(ws_fmt.max_column or 0)
            if row_n > max_rows or col_n > max_cols:
                truncated = True
            use_rows = min(row_n or 1, max_rows)
            use_cols = min(col_n or 1, max_cols)

            for r in range(1, use_rows + 1):
                row_map: dict[str, Any] = {}
                for c in range(1, use_cols + 1):
                    data = _cell_to_univer(
                        ws_fmt.cell(r, c),
                        ws_val.cell(r, c),
                        styles=styles,
                        style_key_of=style_key_of,
                    )
                    if data is None:
                        continue
                    row_map[str(c - 1)] = data
                if row_map:
                    cell_data[str(r - 1)] = row_map

            merge_data: list[dict[str, int]] = []
            ranges = list(ws_fmt.merged_cells.ranges)
            if _MAX_MERGES <= 0:
                if ranges:
                    merges_skipped = True
            elif len(ranges) > _MAX_MERGES:
                merges_skipped = True
            else:
                for merged in ranges:
                    if merged.max_row > use_rows or merged.max_col > use_cols:
                        continue
                    merge_data.append(
                        {
                            "startRow": max(0, merged.min_row - 1),
                            "startColumn": max(0, merged.min_col - 1),
                            "endRow": max(0, merged.max_row - 1),
                            "endColumn": max(0, merged.max_col - 1),
                        }
                    )

            column_data: dict[str, Any] = {}
            for c in range(1, use_cols + 1):
                w = _col_width_px(ws_fmt, c)
                if w is not None:
                    column_data[str(c - 1)] = {"w": w, "hd": 0}

            row_data: dict[str, Any] = {}
            for r in range(1, use_rows + 1):
                h = _row_height_px(ws_fmt, r)
                if h is not None:
                    row_data[str(r - 1)] = {"h": h, "hd": 0}

            drawings.extend(
                _extract_sheet_images(
                    ws_fmt,
                    sheet_index=si,
                    sheet_name=name,
                    embed_dir=embed_dir,
                    use_rows=use_rows,
                    use_cols=use_cols,
                )
            )

            sheets[sid] = {
                "id": sid,
                "name": name,
                "tabColor": "",
                "hidden": 0,
                "rowCount": max(use_rows + 20, 80),
                "columnCount": max(use_cols + 5, 20),
                "zoomRatio": 1,
                "freeze": {
                    "startRow": -1,
                    "startColumn": -1,
                    "ySplit": 0,
                    "xSplit": 0,
                },
                "scrollTop": 0,
                "scrollLeft": 0,
                "defaultColumnWidth": 88,
                "defaultRowHeight": 24,
                "mergeData": merge_data,
                "cellData": cell_data,
                "rowData": row_data,
                "columnData": column_data,
                "showGridlines": 1,
                "rowHeader": {"width": 46, "hidden": 0},
                "columnHeader": {"height": 20, "hidden": 0},
                "rightToLeft": 0,
            }
            sheet_order.append(sid)

        if not sheet_order:
            sid = _new_id("sheet")
            sheets[sid] = {
                "id": sid,
                "name": "Sheet1",
                "cellData": {},
                "mergeData": [],
                "rowData": {},
                "columnData": {},
                "rowCount": 80,
                "columnCount": 20,
                "defaultColumnWidth": 88,
                "defaultRowHeight": 24,
                "showGridlines": 1,
            }
            sheet_order.append(sid)

        if truncated:
            warnings.append(f"仅导入前 {max_rows} 行 × {max_cols} 列（过大文件）")
        if merges_skipped:
            warnings.append("为避免点击编辑卡死，已跳过合并单元格（内容仍可读可改）")
        if drawings:
            warnings.append(f"已提取 {len(drawings)} 张图片（将贴到表格）")

        return {
            "ok": True,
            "path": str(p),
            "name": p.name,
            "truncated": truncated,
            "merges_skipped": merges_skipped,
            "embed_id": digest,
            "embed_dir": str(embed_dir),
            "drawings": drawings,
            "warnings": warnings,
            "workbook": {
                "id": _new_id("wb"),
                "name": p.stem or "workbook",
                "appVersion": "0.25.1",
                "locale": "zhCN",
                "styles": styles,
                "sheetOrder": sheet_order,
                "sheets": sheets,
            },
        }
    finally:
        wb_val.close()
        wb_fmt.close()


def _cell_value(v: Any) -> Any:
    if v is None:
        return ""
    if isinstance(v, (int, float, bool, str)):
        return v
    return str(v)


def inspect_workbook(
    data: bytes,
    *,
    sheet: str = "",
    max_rows: int = 80,
    max_cols: int = 40,
) -> dict[str, Any]:
    """解析 xlsx，返回工作表列表与预览网格。"""
    if not data:
        raise ValueError("文件为空")
    max_rows = max(1, min(int(max_rows), 500))
    max_cols = max(1, min(int(max_cols), 100))
    # 非 read_only：便于拿到准确 max_row/max_column；报告类文件通常不大
    wb = load_workbook(io.BytesIO(data), data_only=True)
    try:
        sheets: list[dict[str, Any]] = []
        for name in wb.sheetnames:
            ws = wb[name]
            sheets.append(
                {
                    "name": name,
                    "dimensions": str(ws.dimensions or ""),
                    "max_row": int(ws.max_row or 0),
                    "max_column": int(ws.max_column or 0),
                }
            )
        pick = (sheet or "").strip()
        if not pick or pick not in wb.sheetnames:
            pick = wb.sheetnames[0] if wb.sheetnames else ""
        if not pick:
            raise ValueError("工作簿没有工作表")
        ws = wb[pick]
        headers: list[str] = []
        rows: list[list[Any]] = []
        col_limit = min(int(ws.max_column or 0) or max_cols, max_cols)
        row_limit = min(int(ws.max_row or 0) or max_rows, max_rows)
        headers = [get_column_letter(j + 1) for j in range(col_limit)]
        for row in ws.iter_rows(
            min_row=1,
            max_row=row_limit,
            max_col=col_limit,
            values_only=True,
        ):
            cells = [_cell_value(c) for c in (row or ())]
            if len(cells) < col_limit:
                cells.extend([""] * (col_limit - len(cells)))
            rows.append(cells)
        return {
            "ok": True,
            "sheet": pick,
            "sheets": sheets,
            "headers": headers,
            "rows": rows,
            "preview_rows": len(rows),
            "preview_cols": col_limit,
            "truncated": bool(int(ws.max_row or 0) > max_rows)
            or bool(int(ws.max_column or 0) > max_cols),
        }
    finally:
        wb.close()


def sheet_to_csv_bytes(data: bytes, *, sheet: str = "") -> tuple[str, bytes]:
    """导出指定工作表为 CSV（UTF-8 BOM，便于 Excel 打开）。"""
    if not data:
        raise ValueError("文件为空")
    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    try:
        pick = (sheet or "").strip()
        if not pick or pick not in wb.sheetnames:
            pick = wb.sheetnames[0] if wb.sheetnames else ""
        if not pick:
            raise ValueError("工作簿没有工作表")
        ws = wb[pick]
        buf = io.StringIO(newline="")
        writer = csv.writer(buf)
        for row in ws.iter_rows(values_only=True):
            writer.writerow([_cell_value(c) for c in (row or ())])
        # Excel 友好 BOM
        payload = ("\ufeff" + buf.getvalue()).encode("utf-8")
        safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in pick).strip("_")
        name = f"{safe or 'sheet'}.csv"
        return name, payload
    finally:
        wb.close()


def csv_to_xlsx_bytes(data: bytes, *, sheet_name: str = "Sheet1") -> bytes:
    """CSV → 单表 xlsx。"""
    if not data:
        raise ValueError("文件为空")
    text = data.decode("utf-8-sig", errors="replace")
    reader = csv.reader(io.StringIO(text))
    wb = Workbook()
    ws = wb.active
    title = (sheet_name or "Sheet1").strip() or "Sheet1"
    ws.title = title[:31]
    for row in reader:
        ws.append(list(row))
    out = io.BytesIO()
    wb.save(out)
    wb.close()
    return out.getvalue()


def write_bytes(path: Path, data: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path.resolve()
