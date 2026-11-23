"""iozone 结果 xls 解析并写入 result.xlsx（移植自原程序）。"""

from __future__ import annotations

from pathlib import Path

import xlrd
from openpyxl import Workbook

from tools.emmc_test.write_xlsx import Excel


class ReadExcel:
    def __init__(self, filename: str | Path) -> None:
        self.filename = str(filename)
        workbook = xlrd.open_workbook(filename=self.filename, encoding_override="utf-8")
        self.table = workbook.sheet_by_index(0)

    def read_device_value(self):
        write_report = self._lst_append(3, 6)
        re_write_report = self._lst_append(6, 9)
        read_report = self._lst_append(9, 12)
        re_read_report = self._lst_append(12, 15)
        random_read_report = self._lst_append(15, 18)
        random_write_report = self._lst_append(18, 21)
        return (
            write_report,
            re_write_report,
            read_report,
            re_read_report,
            random_read_report,
            random_write_report,
        )

    @staticmethod
    def _numeric_cells(values) -> list[float]:
        out: list[float] = []
        for x in values:
            if x in ("", None):
                continue
            try:
                out.append(float(x))
            except (TypeError, ValueError):
                continue
        return out

    def _lst_append(self, start: int, end: int) -> list[float]:
        """从 iozone 导出的 xls 块中提取速率样本。

        旧逻辑固定取扁平化后的 [36:42]，在小文件（列更少）或末尾空单元格时会
        IndexError / float('')，导致整段结果无法写入测试报告。
        """
        end = min(end, self.table.nrows)
        flat: list = []
        for i in range(start, end):
            flat.extend(self.table.row_values(rowx=i, start_colx=0, end_colx=None))

        # 兼容旧版大文件布局：三行 × 约 14 列，取末尾 6 个有效数字
        if len(flat) >= 42:
            chunk = self._numeric_cells(flat[36:42])
            if chunk:
                return chunk

        # 通用：找「文件大小 + 各 reclen 速率」数据行，跳过空单元格
        for i in range(start, end):
            row = self.table.row_values(rowx=i, start_colx=0, end_colx=None)
            if not row:
                continue
            head = self._numeric_cells(row[:1])
            if not head or head[0] <= 0:
                continue
            rates = self._numeric_cells(row[1:])
            if rates:
                return rates
        return []

    @staticmethod
    def _get_lst_max(lst: list) -> float:
        if not lst:
            raise ValueError("iozone 结果中无有效速率数据")
        return max(float(x) for x in lst)

    def get_rate(self) -> dict[str, str]:
        (
            write_report,
            re_write_report,
            read_report,
            re_read_report,
            random_read_report,
            random_write_report,
        ) = self.read_device_value()
        return {
            "write_max": f"{self._get_lst_max(write_report) / 1024:.2f} MB/S",
            "rewrite_max": f"{self._get_lst_max(re_write_report) / 1024:.2f} MB/S",
            "read_max": f"{self._get_lst_max(read_report) / 1024:.2f} MB/S",
            "reread_max": f"{self._get_lst_max(re_read_report) / 1024:.2f} MB/S",
            "randomread_max": f"{self._get_lst_max(random_read_report) / 1024:.2f} MB/S",
            "randomwrite_max": f"{self._get_lst_max(random_write_report) / 1024:.2f} MB/S",
        }

    @staticmethod
    def _ensure_result_workbook(result_path: Path) -> None:
        if result_path.is_file():
            return
        wb = Workbook()
        ws = wb.active
        ws.title = "Sheet1"
        wb.save(result_path)
        wb.close()

    @staticmethod
    def write_dict(result_path: str | Path, i: int, dic: dict[str, str]) -> Excel:
        result_path = Path(result_path)
        ReadExcel._ensure_result_workbook(result_path)

        write_excel = Excel(str(result_path))
        write_excel.select_sheet("Sheet1")
        if i == 0:
            write_excel.write_value_in_cell(1, 2, "write_rate")
            write_excel.write_value_in_cell(1, 3, "rewrite_rate")
            write_excel.write_value_in_cell(1, 4, "read_rate")
            write_excel.write_value_in_cell(1, 5, "reread_rate")
            write_excel.write_value_in_cell(1, 6, "random_read_rate")
            write_excel.write_value_in_cell(1, 7, "random_write_rate")

        row_map = {0: (2, "第一次"), 1: (3, "第二次"), 2: (4, "第三次"), 3: (5, "平均值")}
        row, label = row_map[i]
        write_excel.write_value_in_cell(row, 1, label)
        colum = 1
        for item in dic:
            colum += 1
            write_excel.write_value_in_cell(row, colum, dic[item])
        return write_excel


def average_rates(lst: list[dict[str, str]]) -> dict[str, str]:
    write_rate = rewrite_rate = read_rate = 0.0
    reread_rate = randomread_rate = randomwrit_rate = 0.0
    for item in lst:
        write_rate += float(item["write_max"].split(" ")[0])
        rewrite_rate += float(item["rewrite_max"].split(" ")[0])
        read_rate += float(item["read_max"].split(" ")[0])
        reread_rate += float(item["reread_max"].split(" ")[0])
        randomread_rate += float(item["randomread_max"].split(" ")[0])
        randomwrit_rate += float(item["randomwrite_max"].split(" ")[0])
    n = len(lst) or 1
    return {
        "write_rate": f"{write_rate / n:.2f} MB/S",
        "rewrite_rate": f"{rewrite_rate / n:.2f} MB/S",
        "read_rate": f"{read_rate / n:.2f} MB/S",
        "reread_rate": f"{reread_rate / n:.2f} MB/S",
        "randomread_rate": f"{randomread_rate / n:.2f} MB/S",
        "randomwrite_rate": f"{randomwrit_rate / n:.2f} MB/S",
        # 兼容旧键名
        "randomwrit_rate": f"{randomwrit_rate / n:.2f} MB/S",
    }
