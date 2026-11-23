"""eMMC 结果 xlsx 读写（openpyxl）。"""

from __future__ import annotations

from pathlib import Path

from openpyxl import Workbook, load_workbook


class Excel:
    def __init__(self, file_path: str) -> None:
        self.file_path = file_path
        self.wb = load_workbook(file_path)

    def select_sheet(self, name: str) -> None:
        if name in self.wb.sheetnames:
            self.live_sheet = self.wb[name]
        else:
            self.live_sheet = self.wb.active
            self.live_sheet.title = name
        self.live_sheet.column_dimensions["A"].width = 20.0
        self.live_sheet.column_dimensions["B"].width = 15.0
        self.live_sheet.column_dimensions["C"].width = 15.0
        self.live_sheet.column_dimensions["D"].width = 15.0

    def write_value_in_cell(self, row: int, column: int, value) -> None:
        self.live_sheet.cell(row, column, value)

    def close(self) -> None:
        self.wb.save(self.file_path)
        self.wb.close()


def write_stress_result_xlsx(
    path: str | Path,
    *,
    make_file_kb: int | str,
    write_pass: int,
    read_pass: int,
    check_pass: int,
    run_count: int,
) -> Path:
    """写入读写压力汇总表 stress_result.xlsx，返回实际路径。"""
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    wb = Workbook()
    ws = wb.active
    ws.title = "Sheet1"
    ws.cell(1, 2, "write")
    ws.cell(1, 3, "read")
    ws.cell(1, 4, "check")
    ws.cell(2, 1, "测试文件大小,单位为k")
    ws.cell(2, 2, str(make_file_kb))
    ws.cell(2, 3, str(make_file_kb))
    ws.cell(2, 4, str(make_file_kb))
    ws.cell(3, 1, "成功次数")
    ws.cell(3, 2, str(write_pass))
    ws.cell(3, 3, str(read_pass))
    ws.cell(3, 4, str(check_pass))
    ws.cell(4, 1, "失败次数")
    ws.cell(4, 2, str(run_count - write_pass))
    ws.cell(4, 3, str(run_count - read_pass))
    ws.cell(4, 4, str(run_count - check_pass))
    wb.save(out)
    wb.close()
    if not out.is_file():
        raise RuntimeError(f"结果文件未生成: {out}")
    return out
