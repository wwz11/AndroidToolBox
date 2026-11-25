from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from tools.emmc_test import report_template as rt


class TestReportTemplateV3(unittest.TestCase):
    def test_v3_template_header_and_iozone_columns(self) -> None:
        tpl = rt.default_template_path()
        self.assertTrue(tpl.is_file(), f"Missing template: {tpl}")
        self.assertIn("v3.0", tpl.name)

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            meta = rt.ReportHeaderMeta(
                import_project="PROJ_X",
                internal_model="MODEL_X",
                emmc_brand="Samsung",
                emmc_capacity_gb="32",
                read_speed_mbs="250",
                write_speed_mbs="120",
                emmc_model="KLMBG2JETD",
                sw_test_userdebug="v1.0-userdebug",
                emmc_spec="spec.pdf",
                gota_version="gota_v1",
                tester="TesterA",
                test_time="2026-11-25 15:50:00",
                remarks="note",
                ab_upgrade=False,
            )
            report_path = rt.create_report_with_header("FLOW123", meta, base_dir=base)
            self.assertIn("v3.0", report_path.name)

            read_back = rt.read_report_header(report_path)
            self.assertEqual(read_back.import_project, "PROJ_X")
            self.assertEqual(read_back.internal_model, "MODEL_X")
            self.assertEqual(read_back.emmc_capacity_gb, "32")
            self.assertEqual(read_back.write_speed_mbs, "120")
            self.assertEqual(read_back.sw_test_userdebug, "v1.0-userdebug")
            self.assertEqual(read_back.gota_version, "gota_v1")
            self.assertEqual(read_back.remarks, "note")

            log1 = base / "output" / "emmc" / "logs" / "iozone_100M_run1.log"
            log1.parent.mkdir(parents=True, exist_ok=True)
            log1.write_text("iozone run 1 complete\n", encoding="utf-8")

            rates = {
                "write_rate": "150",
                "rewrite_rate": "140",
                "read_rate": "260",
                "reread_rate": "255",
                "random_read_rate": "90",
                "random_write_rate": "60",
            }
            rt.write_iozone_result(
                sn="SN1",
                file_size_mb=100,
                runs=[rates, rates, rates],
                average=rates,
                duration_minutes=12.5,
                report_path=report_path,
                base_dir=base,
                flow_no="FLOW123",
                log_paths=[log1],
            )

            wb = rt._load_workbook(report_path)
            try:
                ws = next(rt._iter_report_sheets(wb))
                self.assertEqual(ws.cell(1, 1).value, "eMMC For PROJ_X 导入测试报告3.0")
                self.assertEqual(ws.cell(17, 10).value, "iozone_100M_run1.log")
                self.assertEqual(rt._cell_display_value(ws, 20, 11), "Pass")
                self.assertEqual(ws.cell(38, 8).value, "N/A")
            finally:
                wb.close()


if __name__ == "__main__":
    unittest.main()
