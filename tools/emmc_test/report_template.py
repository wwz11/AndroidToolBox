#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""eMMC 导入测试报告模版 v3.0 写入（中英文 sheet 同步更新）。"""

from __future__ import annotations

import datetime as dt
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

_TEMPLATE_NAME = "eMMC For SEIxxxxx 导入测试报告模版v3.0.xlsx"
_REPORT_DIR_NAME = "reports"
_REPORT_FILENAME_MIDDLE = " 导入测试报告模版v3.0 "
_LEGACY_REPORT_FILENAME_MIDDLE = " 导入测试报告模版v2.0 "
_REPORT_HEADER_TITLE_CN = " 导入测试报告3.0"
_REPORT_HEADER_TITLE_EN = " Import Test Report v3.0"
# 报告内嵌截图尺寸（日志 PNG 与 Excel 嵌入共用）
_REPORT_SCREENSHOT_WIDTH = 200
_REPORT_SCREENSHOT_HEIGHT = 120
_LOG_PNG_WIDTH = 400
_LOG_PNG_FONT_SIZE = 8
_LOG_PNG_LINE_HEIGHT = 11
_LOG_PNG_MAX_LINES = 28
_LOG_PNG_CHAR_LIMIT = 80

# iozone 写入区域（与模版 v2.0 一致，见「100M」区块）
# 行 17-20：第一次 / 第二次 / 第三次 / 平均值
# 列 4-9：write_rate … random_write_rate；列 2：测试时长；列 10：Pass/Fail
_IOZONE_SIZE_ROWS: dict[int, tuple[int, int, int, int]] = {
    1024: (13, 14, 15, 16),
    100: (17, 18, 19, 20),
    50: (21, 22, 23, 24),
}
_IOZONE_SIZE_LABELS: dict[int, str] = {
    1024: "1G",
    100: "100M",
    50: "50M",
}

_RATE_COLS = (
    (("write_max", "write_rate"), 4),
    (("rewrite_max", "rewrite_rate"), 5),
    (("read_max", "read_rate"), 6),
    (("reread_max", "reread_rate"), 7),
    (("randomread_max", "random_read_rate", "randomread_rate"), 8),
    (("randomwrite_max", "random_write_rate", "randomwrite_rate", "randomwrit_rate"), 9),
)


def _dev_dir() -> Path:
    return Path(__file__).resolve().parents[2]


def synced_template_path(base_dir: Path | None = None) -> Path:
    """从飞书在线表格同步到本地缓存的 .xlsx 模板路径。"""
    return _report_base_dir(base_dir) / "output" / "emmc" / "feishu_template_cache.xlsx"


def default_template_path(base_dir: Path | None = None) -> Path:
    from tools.bundled_paths import resolve_vendor, repo_root

    synced = synced_template_path(base_dir)
    if synced.is_file():
        return synced
    found = resolve_vendor("emmc", _TEMPLATE_NAME)
    if found is not None and found.is_file():
        return found
    if base_dir is not None:
        return base_dir / "vendor" / "emmc" / _TEMPLATE_NAME
    return repo_root() / "vendor" / "emmc" / _TEMPLATE_NAME


def _safe_flow_for_filename(flow_no: str) -> str:
    safe = re.sub(r"[^\w.-]+", "_", flow_no.strip())
    if not safe:
        raise ValueError("流程号不能为空")
    return safe


def _reports_root(base_dir: Path | None = None) -> Path:
    root = base_dir or (
        _dev_dir() if not getattr(sys, "frozen", False) else Path(sys.executable).resolve().parent
    )
    return root / "output" / "emmc" / _REPORT_DIR_NAME


def emmc_reports_dir(*, base_dir: Path | None = None) -> Path:
    """eMMC 测试报告输出目录（不存在则创建）。"""
    path = _reports_root(base_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _sanitize_report_name_part(text: str) -> str:
    """文件名片段：保留空格与中文，去掉 Windows 非法字符。"""
    cleaned = re.sub(r'[<>:"/\\|?*]', "_", text.strip())
    if not cleaned:
        raise ValueError("导入项目不能为空")
    return cleaned


def _sanitize_flow_for_filename(flow_no: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*]', "_", flow_no.strip())
    if not cleaned:
        raise ValueError("流程号不能为空")
    return cleaned


def report_filename(flow_no: str, import_project: str) -> str:
    project = _sanitize_report_name_part(import_project or flow_no)
    flow = _sanitize_flow_for_filename(flow_no)
    return f"eMMC For {project}{_REPORT_FILENAME_MIDDLE}{flow}.xlsx"


def report_path_for_project(
    flow_no: str,
    import_project: str,
    *,
    base_dir: Path | None = None,
) -> Path:
    return _reports_root(base_dir) / report_filename(flow_no, import_project)


def report_title_for_sheet(import_project: str, *, english: bool = False) -> str:
    project = import_project.strip() or "SEIxxxxx"
    if english:
        return f"eMMC For {project}{_REPORT_HEADER_TITLE_EN}"
    return f"eMMC For {project}{_REPORT_HEADER_TITLE_CN}"


def _flow_report_path_key(flow_no: str) -> str:
    return f"emmc_test.report.flow.{flow_no.strip()}.path"


def _flow_import_project_key(flow_no: str) -> str:
    return f"emmc_test.report.flow.{flow_no.strip()}.import_project"


def _report_path_flow_key(report_path: Path) -> str:
    return f"emmc_test.report.path.{str(report_path.resolve()).replace(chr(92), '/')}.flow_no"


def bind_flow_report(flow_no: str, report_path: Path, *, import_project: str = "") -> None:
    """记录流程号与报告文件路径的对应关系（供按流程号查找、初判汇总等）。"""
    try:
        from tools.settings_store import put
    except ImportError:
        return
    flow = flow_no.strip()
    if not flow:
        return
    resolved = report_path.resolve()
    put(_flow_report_path_key(flow), str(resolved))
    put(_report_path_flow_key(resolved), flow)
    if import_project.strip():
        put(_flow_import_project_key(flow), import_project.strip())


def _import_project_for_flow(flow_no: str) -> str:
    try:
        from tools.settings_store import get
    except ImportError:
        return flow_no.strip()
    flow = flow_no.strip()
    saved = str(get(_flow_import_project_key(flow), "")).strip()
    return saved or flow


def _legacy_report_path(flow_no: str, *, base_dir: Path | None = None) -> Path:
    safe_flow = _safe_flow_for_filename(flow_no)
    return _reports_root(base_dir) / f"eMMC_测试报告_{safe_flow}.xlsx"


def report_path_for_flow(flow_no: str, *, base_dir: Path | None = None) -> Path:
    """按流程号确定报告文件路径（固定文件名，便于多项测试汇总到同一报告）。"""
    flow = flow_no.strip()
    if not flow:
        raise ValueError("流程号不能为空")
    try:
        from tools.settings_store import get

        saved = str(get(_flow_report_path_key(flow), "")).strip()
        if saved:
            path = Path(saved)
            if path.is_file():
                return path
    except ImportError:
        pass
    import_project = _import_project_for_flow(flow)
    named = report_path_for_project(flow, import_project, base_dir=base_dir)
    if named.is_file():
        return named
    # 旧版：…导入测试报告模版v2.0 {流程号}.xlsx / …OA.xlsx
    try:
        sanitized = _sanitize_report_name_part(import_project)
        safe_flow = _sanitize_flow_for_filename(flow)
        for legacy_name in (
            f"eMMC For {sanitized}{_LEGACY_REPORT_FILENAME_MIDDLE}{safe_flow}.xlsx",
            f"eMMC For {sanitized} 导入测试报告模版v2.0 OA.xlsx",
        ):
            legacy_p = _reports_root(base_dir) / legacy_name
            if legacy_p.is_file():
                return legacy_p
    except ValueError:
        pass
    legacy = _legacy_report_path(flow, base_dir=base_dir)
    if legacy.is_file():
        return legacy
    return named


def ensure_flow_report(
    flow_no: str,
    *,
    base_dir: Path | None = None,
    import_project: str = "",
) -> Path:
    """打开已有报告；不存在时用默认表头创建（无 GUI 弹窗）。"""
    import datetime as dt

    path = report_path_for_flow(flow_no, base_dir=base_dir)
    if path.is_file():
        return path
    project = (import_project or flow_no).strip()
    meta = ReportHeaderMeta(
        import_project=project,
        test_time=dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        ab_upgrade=get_ab_upgrade_for_flow(flow_no) if flow_no.strip() else True,
    )
    return create_report_with_header(flow_no, meta, base_dir=base_dir)


def relocate_report_for_import_project(
    flow_no: str,
    import_project: str,
    *,
    current_path: Path,
    base_dir: Path | None = None,
) -> Path:
    """按「导入项目」重命名报告文件，并更新流程号映射。"""
    project = import_project.strip() or flow_no.strip()
    target = report_path_for_project(flow_no, project, base_dir=base_dir)
    current = current_path.resolve()
    resolved_target = target.resolve()
    if resolved_target == current:
        bind_flow_report(flow_no, target, import_project=project)
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file() and resolved_target != current:
        raise FileExistsError(f"目标报告已存在: {target}")
    if current.is_file():
        current.replace(resolved_target)
    bind_flow_report(flow_no, resolved_target, import_project=project)
    return resolved_target


def create_report_with_header(
    flow_no: str,
    meta: ReportHeaderMeta,
    *,
    base_dir: Path | None = None,
) -> Path:
    """填写表头后从模版创建报告文件。"""
    flow = flow_no.strip()
    if not flow:
        raise ValueError("流程号不能为空")
    project = meta.import_project.strip() or flow
    path = report_path_for_project(flow, project, base_dir=base_dir)
    if path.is_file():
        raise FileExistsError(f"报告文件已存在: {path}")
    template = default_template_path(base_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    _ensure_workbook(path, template)
    return write_report_header(
        report_path=path,
        template_path=template,
        meta=meta,
        flow_no=flow,
    )


def update_report_header(
    flow_no: str,
    meta: ReportHeaderMeta,
    *,
    current_path: Path,
    base_dir: Path | None = None,
) -> Path:
    """更新已有报告头部，必要时按导入项目/流程号重命名文件。"""
    path = relocate_report_for_import_project(
        flow_no,
        meta.import_project or flow_no,
        current_path=current_path,
        base_dir=base_dir,
    )
    return write_report_header(
        report_path=path,
        template_path=default_template_path(base_dir),
        meta=meta,
        flow_no=flow_no.strip(),
    )


def prepare_report_for_flow(
    flow_no: str,
    sn: str = "",
    *,
    base_dir: Path | None = None,
) -> tuple[Path, bool]:
    """按流程号打开报告：不存在则从模版新建，存在则直接写入。返回 (路径, 是否新建)。"""
    path = report_path_for_flow(flow_no, base_dir=base_dir)
    created = not path.is_file()
    template = default_template_path(base_dir)
    _ensure_workbook(path, template)
    if not created:
        bind_flow_report(flow_no, path, import_project=_import_project_for_flow(flow_no))
    return path, created


def new_report_path(
    test_key: str,
    sn: str = "",
    *,
    base_dir: Path | None = None,
    when: dt.datetime | None = None,
) -> Path:
    """每次测试新建独立报告文件（时间戳 + 测试项，避免多机并行时互相覆盖）。"""
    root = base_dir or (_dev_dir() if not getattr(sys, "frozen", False) else Path(sys.executable).resolve().parent)
    ts = (when or dt.datetime.now()).strftime("%Y%m%d_%H%M%S_%f")
    safe_key = re.sub(r"[^\w.-]+", "_", test_key.strip()) or "test"
    name = f"eMMC For {safe_key}{_REPORT_FILENAME_MIDDLE}{safe_key}_{ts}.xlsx"
    return _reports_root(base_dir) / name


def _iozone_row_group(file_size_mb: int) -> tuple[int, int, int, int, str]:
    """返回 (三次+平均行号, 模版 -S 参数值标签)。"""
    if file_size_mb >= 1000:
        return (*_IOZONE_SIZE_ROWS[1024], _IOZONE_SIZE_LABELS[1024])
    if file_size_mb >= 100:
        return (*_IOZONE_SIZE_ROWS[100], _IOZONE_SIZE_LABELS[100])
    if file_size_mb >= 50:
        return (*_IOZONE_SIZE_ROWS[50], _IOZONE_SIZE_LABELS[50])
    # 模版标准测试规格为 100M（AML 仅保留 100M）
    return (*_IOZONE_SIZE_ROWS[100], _IOZONE_SIZE_LABELS[100])


def _parse_rate_mb(value: str) -> float:
    m = re.search(r"([\d.]+)", value or "")
    return float(m.group(1)) if m else 0.0


def _rate_value(rates: dict[str, str], keys: tuple[str, ...]) -> str:
    for key in keys:
        if key in rates and rates[key]:
            return rates[key]
    return ""


def _iozone_pass(
    rates: dict[str, str],
    *,
    samsung_emmc: bool = False,
    write_min_mbs: float = 100.0,
    read_min_mbs: float = 100.0,
) -> str:
    write_v = _parse_rate_mb(_rate_value(rates, ("write_max", "write_rate")))
    write_need = float(write_min_mbs)
    if samsung_emmc:
        return "Pass" if write_v >= write_need else "Fail"
    read_v = _parse_rate_mb(_rate_value(rates, ("read_max", "read_rate")))
    read_need = float(read_min_mbs)
    return "Pass" if write_v >= write_need and read_v >= read_need else "Fail"


@dataclass
class ReportHeaderMeta:
    """报告模版头部需手工填写字段（中英文 sheet 同位置写入）。"""

    import_project: str = ""
    internal_model: str = ""
    emmc_brand: str = ""
    emmc_capacity_gb: str = ""
    read_speed_mbs: str = ""
    write_speed_mbs: str = ""
    emmc_model: str = ""
    sw_test_userdebug: str = ""
    emmc_spec: str = ""
    gota_version: str = ""
    tester: str = ""
    test_time: str = ""
    initial_result: str = ""
    remarks: str = ""
    ab_upgrade: bool = True  # True=A/B 升级（需 OTA 测试）；False=非 A/B（OTA 可不测）


_REPORT_HEADER_CELLS_V3: dict[str, tuple[int, int]] = {
    "import_project": (3, 2),
    "internal_model": (3, 8),
    "emmc_brand": (4, 2),
    "emmc_capacity_gb": (4, 8),
    "read_speed_mbs": (5, 2),
    "write_speed_mbs": (5, 8),
    "emmc_model": (6, 2),
    "sw_test_userdebug": (6, 8),
    "emmc_spec": (7, 2),
    "gota_version": (7, 8),
    "tester": (8, 2),
    "test_time": (8, 8),
    "remarks": (9, 8),
}

_REPORT_HEADER_CELLS_V2: dict[str, tuple[int, int]] = {
    "import_project": (3, 2),
    "internal_model": (3, 5),
    "emmc_brand": (4, 2),
    "emmc_capacity_gb": (4, 5),
    "read_speed_mbs": (5, 2),
    "write_speed_mbs": (5, 5),
    "emmc_model": (6, 2),
    "sw_test_userdebug": (6, 5),
    "emmc_spec": (7, 2),
    "gota_version": (7, 5),
    "tester": (8, 2),
    "test_time": (8, 5),
    "remarks": (9, 5),
}

# 默认指向最新版 v3.0
_REPORT_HEADER_CELLS = _REPORT_HEADER_CELLS_V3


def _is_v3_sheet(ws) -> bool:
    """判断工作表是否为 v3.0 布局（头部右列在 F/H，iozone 新增 J 列日志）。"""
    f3 = str(ws.cell(3, 6).value or "").strip()
    k12 = str(ws.cell(12, 11).value or "").strip()
    return bool(f3) or "Pass/Fail" in k12 or "Result" in k12


def _header_cells_for_sheet(ws) -> dict[str, tuple[int, int]]:
    return _REPORT_HEADER_CELLS_V3 if _is_v3_sheet(ws) else _REPORT_HEADER_CELLS_V2


def read_report_header(report_path: Path) -> ReportHeaderMeta:
    """从已有报告读取头部字段（供编辑弹窗预填）。"""
    wb = _load_workbook(report_path)
    meta = ReportHeaderMeta()
    try:
        ws = next(_iter_report_sheets(wb))
        for name, (row, col) in _header_cells_for_sheet(ws).items():
            val = ws.cell(row, col).value
            if val is not None and str(val).strip():
                setattr(meta, name, str(val).strip())
        initial = ws.cell(9, 2).value
        if initial is not None and str(initial).strip():
            meta.initial_result = str(initial).strip()
        flow = flow_no_from_report_path(report_path)
        if flow:
            meta.ab_upgrade = get_ab_upgrade_for_flow(flow)
    finally:
        wb.close()
    return meta


_SHEET_TITLE_MAX = 31
_KNOWN_SHEET_RENAMES = {
    "eMMC For SEIxxxxx 导入测试报告模版(Chinese)": "eMMC 导入测试报告(Chinese)",
    "eMMC For SEIxxxxx Import test report template(English)": "eMMC Import test report (EN)",
}


def _normalize_sheet_titles(wb) -> None:
    used: set[str] = set()
    for ws in wb.worksheets:
        title = ws.title
        if title in _KNOWN_SHEET_RENAMES:
            title = _KNOWN_SHEET_RENAMES[title]
        if len(title) <= _SHEET_TITLE_MAX and title not in used:
            used.add(title)
            if ws.title != title:
                ws.title = title
            continue
        base = title[:_SHEET_TITLE_MAX]
        candidate = base
        n = 1
        while candidate in used:
            suffix = f"~{n}"
            candidate = base[: _SHEET_TITLE_MAX - len(suffix)] + suffix
            n += 1
        ws.title = candidate
        used.add(candidate)


def _load_workbook(path: Path):
    import warnings

    from openpyxl import load_workbook

    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message="Title is more than 31 characters*",
            category=UserWarning,
        )
        wb = load_workbook(path)
    _normalize_sheet_titles(wb)
    return wb


def _save_workbook(wb, path: Path) -> Path:
    """保存工作簿。目标被 Excel 占用时另存为带时间戳的文件并返回实际路径。"""
    _normalize_sheet_titles(wb)
    path = Path(path)
    try:
        wb.save(path)
        return path
    except PermissionError:
        stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
        alt = path.with_name(f"{path.stem}_另存{stamp}{path.suffix}")
        wb.save(alt)
        return alt


def _ensure_workbook(report_path: Path, template_path: Path) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    if report_path.is_file():
        return
    if not template_path.is_file():
        raise FileNotFoundError(f"测试报告模版不存在: {template_path}")
    shutil.copy2(template_path, report_path)
    wb = _load_workbook(report_path)
    _save_workbook(wb, report_path)
    wb.close()


def create_report(test_key: str, sn: str = "", *, base_dir: Path | None = None) -> Path:
    """每次测试新建独立报告文件（时间戳 + 测试项，避免多机并行时互相覆盖）。"""
    path = new_report_path(test_key, sn, base_dir=base_dir)
    _ensure_workbook(path, default_template_path(base_dir))
    return path


def _iter_report_sheets(wb):
    """遍历需写入结果的报告 sheet。

    Excel 工作表名最长 31 字符，英文名常被截成 ``Import test r``，
    不能再依赖完整子串 ``Import test report``。
    """
    for name in wb.sheetnames:
        if name.strip().lower() == "history":
            continue
        lower = name.lower()
        if (
            "Import test" in name
            or "导入测试报告" in name
            or "模版" in name
            or "template" in lower
            or name.startswith("eMMC For")
        ):
            yield wb[name]


def write_report_header(
    *,
    report_path: Path,
    template_path: Path,
    meta: ReportHeaderMeta,
    flow_no: str = "",
) -> Path:
    _ensure_workbook(report_path, template_path)
    wb = _load_workbook(report_path)
    try:
        for ws in _iter_report_sheets(wb):
            english = "Import" in (ws.title or "") or "(EN)" in (ws.title or "")
            project = meta.import_project.strip() or flow_no.strip() or "SEIxxxxx"
            _safe_set_cell(ws, 1, 1, report_title_for_sheet(project, english=english))
            for name, (row, col) in _header_cells_for_sheet(ws).items():
                value = getattr(meta, name, "")
                if value:
                    _safe_set_cell(ws, row, col, value)
        fn = flow_no.strip() or flow_no_from_report_path(report_path)
        if fn:
            bind_flow_report(
                fn,
                report_path,
                import_project=meta.import_project.strip() or fn,
            )
            set_ab_upgrade_for_flow(fn, meta.ab_upgrade)
        _finalize_report_workbook(wb, report_path)
        _save_workbook(wb, report_path)
    finally:
        wb.close()
    return report_path


def _safe_set_cell(ws, row: int, col: int, value) -> None:
    """写入单元格；若目标在合并区域内则写到合并区左上角。"""
    from openpyxl.cell.cell import MergedCell

    cell = ws.cell(row, col)
    if isinstance(cell, MergedCell):
        for merged in ws.merged_cells.ranges:
            if (
                merged.min_row <= row <= merged.max_row
                and merged.min_col <= col <= merged.max_col
            ):
                ws.cell(merged.min_row, merged.min_col, value)
                return
        return
    cell.value = value


def _stamp_test_time(wb) -> str:
    now = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for ws in _iter_report_sheets(wb):
        _safe_set_cell(ws, 8, 8 if _is_v3_sheet(ws) else 5, now)
    return now


def touch_report_test_time(
    report_path: Path,
    *,
    template_path: Path | None = None,
    base_dir: Path | None = None,
) -> None:
    """测试项写入时仅刷新「测试时间」，不覆盖头部其它手工字段。

    若报告正被 Excel 打开导致无法保存，静默跳过；完整写入时会再次刷新时间。
    """
    tpl = template_path or default_template_path(base_dir)
    _ensure_workbook(report_path, tpl)
    wb = _load_workbook(report_path)
    now = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        for ws in _iter_report_sheets(wb):
            _safe_set_cell(ws, 8, 8 if _is_v3_sheet(ws) else 5, now)
        try:
            wb.save(report_path)
        except PermissionError:
            return
    finally:
        wb.close()


def _stress_duration_label(ws, run_count: int, loop_num: int) -> str:
    title = ws.title or ""
    if "Import" in title or "(EN)" in title:
        return f"Duration of running {run_count}/{loop_num} times （minutes）"
    return f"测试 {run_count}/{loop_num} 次花费的总时长"


def write_stress_result(
    *,
    sn: str,
    loop_num: int,
    make_file_kb: int,
    write_pass: int,
    read_pass: int,
    check_pass: int,
    run_count: int,
    duration_minutes: float,
    passed: bool,
    report_path: Path | None = None,
    template_path: Path | None = None,
    base_dir: Path | None = None,
) -> Path:
    tpl = template_path or default_template_path(base_dir)
    if report_path is None:
        raise ValueError("report_path 必填：请在测试开始时调用 create_report() 生成独立报告文件")
    out = report_path
    touch_report_test_time(out, template_path=tpl, base_dir=base_dir)
    wb = _load_workbook(out)
    _stamp_test_time(wb)
    write_fail = max(0, run_count - write_pass)
    read_fail = max(0, run_count - read_pass)
    check_fail = max(0, run_count - check_pass)
    # 用字符串写入，避免部分 Excel「不显示零值」把失败次数 0 显示成空白；
    # 同时清掉模版占位「（次）」长空格文本。
    from openpyxl.styles import Alignment

    center = Alignment(horizontal="center", vertical="center")
    for ws in _iter_report_sheets(wb):
        _safe_set_cell(ws, 26, 6, _stress_duration_label(ws, run_count, loop_num))
        _safe_set_cell(ws, 27, 1, int(loop_num))
        _safe_set_cell(ws, 27, 3, int(make_file_kb))
        _safe_set_cell(ws, 27, 4, int(make_file_kb))
        _safe_set_cell(ws, 27, 5, int(make_file_kb))
        _safe_set_cell(ws, 28, 3, str(int(write_pass)))
        _safe_set_cell(ws, 28, 4, str(int(read_pass)))
        _safe_set_cell(ws, 28, 5, str(int(check_pass)))
        _safe_set_cell(ws, 28, 6, round(float(duration_minutes), 1))
        _safe_set_cell(ws, 28, 8, "Pass" if passed else "Fail")
        _safe_set_cell(ws, 29, 3, str(int(write_fail)))
        _safe_set_cell(ws, 29, 4, str(int(read_fail)))
        _safe_set_cell(ws, 29, 5, str(int(check_fail)))
        for row, col in ((28, 3), (28, 4), (28, 5), (29, 3), (29, 4), (29, 5)):
            ws.cell(row, col).alignment = center
    _finalize_report_workbook(wb, out)
    saved = _save_workbook(wb, out)
    wb.close()
    return saved


_IOZONE_LOG_COL = 10  # J 列「Izone 的 日志文件」（v3.0 新增）
_IOZONE_RESULT_COL = 11  # K 列「测试结果（Pass/Fail)」（v3.0）
_IOZONE_SCREENSHOT_COL = 12  # L 列「测试结果截图」（v3.0）

# RPMB 写入区域（第 35 行）
_RPMB_ROW = 35
_RPMB_DURATION_COL = 1  # A 列「测试总时长（小时）」
_RPMB_SCREENSHOT_COL = 4  # D 列「测试结果截图」
_RPMB_RESULT_COL = 8  # H 列 Pass/Fail

# reboot 测试写入区域（第 32 行）
_REBOOT_ROW = 32
_REBOOT_SUCCESS_COL = 1  # A 列成功次数
_REBOOT_FAIL_COL = 2  # B 列失败次数
_REBOOT_DURATION_COL = 3  # C 列测试时长（小时）
_REBOOT_SCREENSHOT_COL = 4  # D 列测试图片
_REBOOT_RESULT_COL = 8  # H 列 Pass/Fail

# OTA / 升级压力测试写入区域（第 38 行）
_OTA_ROW = 38
_OTA_SUCCESS_COL = 1  # A 列成功次数
_OTA_FAIL_COL = 2  # B 列升级失败次数
_OTA_DURATION_COL = 3  # C 列测试时长（分钟）
_OTA_SCREENSHOT_COL = 4  # D 列测试结果截图
_OTA_RESULT_COL = 8  # H 列 Pass/Fail


def _iozone_cols_for_sheet(ws) -> tuple[int | None, int, int]:
    """返回 (log_col, result_col, screenshot_col)。"""
    if _is_v3_sheet(ws):
        return _IOZONE_LOG_COL, _IOZONE_RESULT_COL, _IOZONE_SCREENSHOT_COL
    return None, 10, 11


def _result_sections_for_sheet(ws) -> tuple[tuple[int, int, str, bool, bool], ...]:
    ioz_col = _IOZONE_RESULT_COL if _is_v3_sheet(ws) else 10
    return (
        (16, ioz_col, "iozone_1g", False, False),
        (20, ioz_col, "iozone_100m", False, True),
        (24, ioz_col, "iozone_50m", False, False),
        (28, 8, "stress", False, True),
        (32, 8, "reboot", False, True),
        (35, 8, "rpmb", False, True),
        (38, 8, "ota", True, True),
    )


_REPORT_INITIAL_RESULT_CELL = (9, 2)
_OTA_NA_LABEL = "N/A"


def flow_no_from_report_path(report_path: Path) -> str:
    try:
        from tools.settings_store import get

        flow = str(get(_report_path_flow_key(report_path), "")).strip()
        if flow:
            return flow
    except ImportError:
        pass
    m = re.match(r"eMMC_测试报告_(.+)\.xlsx$", report_path.name)
    if m:
        return m.group(1)
    for middle in (_REPORT_FILENAME_MIDDLE, _LEGACY_REPORT_FILENAME_MIDDLE):
        m = re.match(
            rf"eMMC For .+?{re.escape(middle)}(.+?)\.xlsx$",
            report_path.name,
        )
        if m:
            return m.group(1).strip()
    # 旧版命名：…导入测试报告模版v2.0 OA.xlsx
    m = re.match(r"eMMC For .+? 导入测试报告模版v2\.0 OA\.xlsx$", report_path.name)
    if m:
        return ""
    return ""


def _ab_upgrade_settings_key(flow_no: str) -> str:
    return f"emmc_test.report.{flow_no.strip()}.ab_upgrade"


def get_ab_upgrade_for_flow(flow_no: str) -> bool:
    """是否 A/B 升级（需执行 OTA 升级压力测试）。非 A/B 返回 False，OTA 可不测。"""
    text = flow_no.strip()
    if text:
        try:
            from tools.settings_store import get

            val = get(_ab_upgrade_settings_key(text), None)
            if val is not None:
                return str(val).strip().lower() in ("1", "true", "yes", "on")
        except ImportError:
            pass
    try:
        from tools.settings_store import get

        default = get("emmc_test.report_header.ab_upgrade", True)
        if isinstance(default, bool):
            return default
        return str(default).strip().lower() in ("1", "true", "yes", "on")
    except ImportError:
        return True


def set_ab_upgrade_for_flow(flow_no: str, ab_upgrade: bool) -> None:
    try:
        from tools.settings_store import get, put

        put(_ab_upgrade_settings_key(flow_no.strip()), ab_upgrade)
        put("emmc_test.report_header.ab_upgrade", ab_upgrade)
    except ImportError:
        pass


def _cell_display_value(ws, row: int, col: int):
    """读取单元格值；合并区域内非左上角时取合并区左上角的值。"""
    from openpyxl.cell.cell import MergedCell

    cell = ws.cell(row, col)
    if not isinstance(cell, MergedCell) and cell.value is not None:
        return cell.value
    for merged in ws.merged_cells.ranges:
        if (
            merged.min_row <= row <= merged.max_row
            and merged.min_col <= col <= merged.max_col
        ):
            return ws.cell(merged.min_row, merged.min_col).value
    if isinstance(cell, MergedCell):
        return None
    return cell.value


def _parse_pass_fail(value) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    upper = text.upper()
    if upper == "PASS" or text == "通过":
        return "Pass"
    if upper == "FAIL" or text == "失败":
        return "Fail"
    return None


def _parse_pass_fail_cell(ws, row: int, col: int) -> str | None:
    return _parse_pass_fail(_cell_display_value(ws, row, col))


def _collect_pass_fail_results(ws, *, include_ota: bool = True) -> list[str]:
    """收集已写入 Pass/Fail 的测试项（未测项无值则忽略）。"""
    results: list[str] = []
    for row, col, _name, ab_only, _required in _result_sections_for_sheet(ws):
        if ab_only and not include_ota:
            continue
        parsed = _parse_pass_fail_cell(ws, row, col)
        if parsed:
            results.append(parsed)
    return results


def _mark_ota_not_applicable(ws) -> None:
    """非 A/B 升级：OTA 结果区标记 N/A（若尚未有 Pass/Fail）。"""
    if _parse_pass_fail_cell(ws, _OTA_ROW, _OTA_RESULT_COL):
        return
    _safe_set_cell(ws, _OTA_ROW, _OTA_RESULT_COL, _OTA_NA_LABEL)


def _evaluate_initial_result(ws, *, include_ota: bool = True) -> str:
    """
    初判 Pass：所有必测项均已 Pass，且无任何 Fail。
    必测项未齐或仅有部分结果时留空（不显示 Pass）。
    任一项 Fail → Fail。
    """
    sections = _result_sections_for_sheet(ws)
    for row, col, _name, ab_only, _required in sections:
        if ab_only and not include_ota:
            continue
        parsed = _parse_pass_fail_cell(ws, row, col)
        if parsed == "Fail":
            return "Fail"

    for row, col, _name, ab_only, required in sections:
        if ab_only and not include_ota:
            continue
        if not required:
            continue
        parsed = _parse_pass_fail_cell(ws, row, col)
        if parsed != "Pass":
            return ""

    return "Pass"


def _sheet_include_ota(ws, *, flow_no: str) -> bool:
    """是否将 OTA 纳入初判：报告已标 N/A 则视为非 A/B；否则读流程号配置。"""
    ota_text = str(_cell_display_value(ws, _OTA_ROW, _OTA_RESULT_COL) or "").strip().upper()
    if ota_text == "N/A":
        return False
    if flow_no.strip():
        return get_ab_upgrade_for_flow(flow_no)
    return True


def _update_initial_result_on_sheet(ws, *, include_ota: bool = True) -> str:
    """根据各测试项 Pass/Fail 刷新「测试初判结果」，返回写入值（可能为空）。"""
    if not include_ota:
        _mark_ota_not_applicable(ws)
    initial = _evaluate_initial_result(ws, include_ota=include_ota)
    row, col = _REPORT_INITIAL_RESULT_CELL
    _safe_set_cell(ws, row, col, initial or None)
    return initial


def _finalize_report_workbook(wb, report_path: Path | None = None) -> str:
    """保存前汇总初判结果（中英文 sheet 同步）。"""
    flow_no = flow_no_from_report_path(report_path) if report_path else ""
    last = ""
    for ws in _iter_report_sheets(wb):
        include_ota = _sheet_include_ota(ws, flow_no=flow_no)
        last = _update_initial_result_on_sheet(ws, include_ota=include_ota)
    return last


def _report_base_dir(base_dir: Path | None) -> Path:
    if base_dir is not None:
        return base_dir
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return _dev_dir()


def _screenshot_dir(base_dir: Path | None) -> Path:
    path = _report_base_dir(base_dir) / "output" / "emmc" / "screenshots"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _pillow_font(size: int = 14):
    from PIL import ImageFont

    fonts_dir = Path("C:/Windows/Fonts")
    for name in ("msyh.ttc", "msyhbd.ttc", "simhei.ttf", "arial.ttf"):
        candidate = fonts_dir / name
        if candidate.is_file():
            try:
                return ImageFont.truetype(str(candidate), size)
            except OSError:
                continue
    return ImageFont.load_default()


def save_log_text_as_png(
    log_text: str,
    *,
    base_dir: Path | None = None,
    name_prefix: str = "iozone_log",
) -> Path:
    """将测试日志文本渲染为 PNG，供 Excel 报告嵌入。"""
    from PIL import Image, ImageDraw

    lines = [line for line in log_text.splitlines() if line.strip()]
    if not lines:
        raise ValueError("日志为空，无法生成截图")

    font = _pillow_font(_LOG_PNG_FONT_SIZE)
    pad = 8
    line_h = _LOG_PNG_LINE_HEIGHT
    width = _LOG_PNG_WIDTH
    max_lines = _LOG_PNG_MAX_LINES
    if len(lines) > max_lines:
        lines = lines[-max_lines:]
    height = pad * 2 + line_h * len(lines)

    img = Image.new("RGB", (width, height), "#f5f5f5")
    draw = ImageDraw.Draw(img)
    y = pad
    for line in lines:
        draw.text((pad, y), line[:_LOG_PNG_CHAR_LIMIT], fill="#111111", font=font)
        y += line_h

    ts = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    out = _screenshot_dir(base_dir) / f"{name_prefix}_{ts}.png"
    img.save(out, format="PNG")
    return out


def _image_anchor_cell(img) -> tuple[int, int] | None:
    """图片锚点左上角单元格 (row, col)，均为 1-based。"""
    from openpyxl.utils.cell import column_index_from_string, coordinate_from_string

    anchor = img.anchor
    if isinstance(anchor, str):
        col_letters, row = coordinate_from_string(anchor)
        return row, column_index_from_string(col_letters)
    if hasattr(anchor, "_from"):
        return anchor._from.row + 1, anchor._from.col + 1
    return None


def _clear_sheet_images_at(ws, row: int, col: int) -> None:
    """移除锚定在指定单元格的旧截图，避免重复写入叠加。"""
    target = (row, col)
    ws._images = [
        img for img in ws._images if _image_anchor_cell(img) != target
    ]


def _embed_sheet_image(
    ws,
    row: int,
    col: int,
    image_path: Path,
    *,
    width: int = _REPORT_SCREENSHOT_WIDTH,
    height: int = _REPORT_SCREENSHOT_HEIGHT,
) -> None:
    from openpyxl.drawing.image import Image as XLImage
    from openpyxl.utils import get_column_letter

    img = XLImage(str(image_path))
    img.width = width
    img.height = height
    anchor = f"{get_column_letter(col)}{row}"
    _clear_sheet_images_at(ws, row, col)
    ws.add_image(img, anchor)
    row_h = max(18, int(height / 6))
    for r in range(row, row + 2):
        ws.row_dimensions[r].height = max(ws.row_dimensions[r].height or 0, row_h)


def write_iozone_result(
    *,
    sn: str,
    file_size_mb: int,
    runs: list[dict[str, str]],
    average: dict[str, str],
    duration_minutes: float,
    report_path: Path | None = None,
    template_path: Path | None = None,
    base_dir: Path | None = None,
    flow_no: str = "",
    samsung_emmc: bool = False,
    write_min_mbs: float = 100.0,
    read_min_mbs: float = 100.0,
    screenshot_path: Path | None = None,
    log_paths: list[Path] | None = None,
    run_logs: list[str] | None = None,
) -> Path:
    tpl = template_path or default_template_path(base_dir)
    if report_path is None:
        raise ValueError("report_path 必填：请在测试开始时调用 create_report() 生成独立报告文件")
    out = report_path
    touch_report_test_time(out, template_path=tpl, base_dir=base_dir)
    r1, r2, r3, r_avg, size_label = _iozone_row_group(file_size_mb)
    wb = _load_workbook(out)
    _stamp_test_time(wb)

    def _fill_row(ws, row: int, rates: dict[str, str]) -> None:
        for keys, col in _RATE_COLS:
            _safe_set_cell(ws, row, col, _rate_value(rates, keys))

    passed = _iozone_pass(
        average,
        samsung_emmc=samsung_emmc,
        write_min_mbs=write_min_mbs,
        read_min_mbs=read_min_mbs,
    )

    for ws in _iter_report_sheets(wb):
        log_col, result_col, shot_col = _iozone_cols_for_sheet(ws)
        _safe_set_cell(ws, r1, 1, size_label)
        _safe_set_cell(ws, r1, 2, round(duration_minutes, 1))
        for idx, row in enumerate((r1, r2, r3)):
            if idx < len(runs):
                _fill_row(ws, row, runs[idx])
            if log_col is not None:
                if log_paths and idx < len(log_paths) and log_paths[idx] is not None:
                    lp = Path(log_paths[idx])
                    _safe_set_cell(ws, row, log_col, lp.name)
                    try:
                        ws.cell(row, log_col).hyperlink = f"../logs/{lp.name}"
                    except Exception:
                        pass
                elif run_logs and idx < len(run_logs) and run_logs[idx].strip():
                    _safe_set_cell(ws, row, log_col, run_logs[idx].strip()[-1000:])
        _fill_row(ws, r_avg, average)
        if log_col is not None:
            _safe_set_cell(ws, r_avg, log_col, "N/A")
        _safe_set_cell(ws, r_avg, result_col, passed)
        if screenshot_path is not None and screenshot_path.is_file():
            _embed_sheet_image(ws, r1, shot_col, screenshot_path)
    _finalize_report_workbook(wb, out)
    saved = _save_workbook(wb, out)
    wb.close()
    return saved


def write_rpmb_result(
    *,
    sn: str,
    duration_hours: float,
    passed: bool,
    report_path: Path | None = None,
    template_path: Path | None = None,
    base_dir: Path | None = None,
    flow_no: str = "",
    screenshot_path: Path | None = None,
) -> Path:
    tpl = template_path or default_template_path(base_dir)
    if report_path is None:
        raise ValueError("report_path 必填：请在测试开始时调用 create_report() 生成独立报告文件")
    out = report_path
    touch_report_test_time(out, template_path=tpl, base_dir=base_dir)
    wb = _load_workbook(out)
    _stamp_test_time(wb)
    for ws in _iter_report_sheets(wb):
        _safe_set_cell(ws, _RPMB_ROW, _RPMB_DURATION_COL, round(duration_hours, 2))
        _safe_set_cell(ws, _RPMB_ROW, _RPMB_RESULT_COL, "Pass" if passed else "Fail")
        if screenshot_path is not None and screenshot_path.is_file():
            _embed_sheet_image(ws, _RPMB_ROW, _RPMB_SCREENSHOT_COL, screenshot_path)
    _finalize_report_workbook(wb, out)
    saved = _save_workbook(wb, out)
    wb.close()
    return saved


def write_reboot_result(
    *,
    sn: str,
    success_count: int,
    fail_count: int,
    duration_hours: float,
    passed: bool,
    report_path: Path | None = None,
    template_path: Path | None = None,
    base_dir: Path | None = None,
    flow_no: str = "",
    screenshot_path: Path | None = None,
) -> Path:
    tpl = template_path or default_template_path(base_dir)
    if report_path is None:
        raise ValueError("report_path 必填：请在测试开始时调用 create_report() 生成独立报告文件")
    out = report_path
    touch_report_test_time(out, template_path=tpl, base_dir=base_dir)
    wb = _load_workbook(out)
    _stamp_test_time(wb)
    for ws in _iter_report_sheets(wb):
        # 字符串写入，避免 Excel「不显示零值」导致失败次数空白
        _safe_set_cell(ws, _REBOOT_ROW, _REBOOT_SUCCESS_COL, str(int(success_count)))
        _safe_set_cell(ws, _REBOOT_ROW, _REBOOT_FAIL_COL, str(int(fail_count)))
        _safe_set_cell(ws, _REBOOT_ROW, _REBOOT_DURATION_COL, round(float(duration_hours), 2))
        _safe_set_cell(ws, _REBOOT_ROW, _REBOOT_RESULT_COL, "Pass" if passed else "Fail")
        if screenshot_path is not None and screenshot_path.is_file():
            _embed_sheet_image(ws, _REBOOT_ROW, _REBOOT_SCREENSHOT_COL, screenshot_path)
    _finalize_report_workbook(wb, out)
    saved = _save_workbook(wb, out)
    wb.close()
    return saved


def write_ota_result(
    *,
    sn: str,
    success_count: int,
    fail_count: int,
    duration_minutes: float,
    passed: bool,
    report_path: Path | None = None,
    template_path: Path | None = None,
    base_dir: Path | None = None,
    flow_no: str = "",
    screenshot_path: Path | None = None,
) -> Path:
    tpl = template_path or default_template_path(base_dir)
    if report_path is None:
        raise ValueError("report_path 必填：请在测试开始时调用 create_report() 生成独立报告文件")
    out = report_path
    touch_report_test_time(out, template_path=tpl, base_dir=base_dir)
    wb = _load_workbook(out)
    _stamp_test_time(wb)
    for ws in _iter_report_sheets(wb):
        _safe_set_cell(ws, _OTA_ROW, _OTA_SUCCESS_COL, success_count)
        _safe_set_cell(ws, _OTA_ROW, _OTA_FAIL_COL, fail_count)
        _safe_set_cell(ws, _OTA_ROW, _OTA_DURATION_COL, round(duration_minutes, 1))
        _safe_set_cell(ws, _OTA_ROW, _OTA_RESULT_COL, "Pass" if passed else "Fail")
        if screenshot_path is not None and screenshot_path.is_file():
            _embed_sheet_image(ws, _OTA_ROW, _OTA_SCREENSHOT_COL, screenshot_path)
    _finalize_report_workbook(wb, out)
    saved = _save_workbook(wb, out)
    wb.close()
    return saved
