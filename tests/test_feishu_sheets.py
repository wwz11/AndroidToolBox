from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools import feishu_sheets as fs
from tools.emmc_test import report_template as rt


class TestFeishuSheets(unittest.TestCase):
    def test_parse_feishu_doc_url(self) -> None:
        self.assertEqual(
            fs.parse_feishu_doc_url(
                "https://seirobotics.feishu.cn/sheets/shtcnYmpb0mKyOwYTFIHSqjBYic?from=1"
            ),
            ("sheet", "shtcnYmpb0mKyOwYTFIHSqjBYic"),
        )
        self.assertEqual(
            fs.parse_feishu_doc_url(
                "https://my.feishu.cn/wiki/Ychmw1Guvid8wPkmV6wcs00Gnzh?create_from=create_doc_to_wiki"
            ),
            ("wiki", "Ychmw1Guvid8wPkmV6wcs00Gnzh"),
        )

    def test_synced_template_overrides_builtin_when_present(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            default_tpl = rt.default_template_path(base)
            self.assertIn("v3.0", default_tpl.name)

            synced = rt.synced_template_path(base)
            synced.parent.mkdir(parents=True, exist_ok=True)
            synced.write_bytes(b"placeholder")
            self.assertEqual(rt.default_template_path(base), synced)

    def test_resolve_wiki_to_sheet_token(self) -> None:
        with patch.object(
            fs,
            "_request_json",
            return_value={
                "code": 0,
                "data": {"node": {"obj_type": "sheet", "obj_token": "shtABC12345"}},
            },
        ):
            tok = fs.resolve_spreadsheet_token(
                "t-token",
                "https://my.feishu.cn/wiki/Ychmw1Guvid8wPkmV6wcs00Gnzh",
            )
            self.assertEqual(tok, "shtABC12345")


if __name__ == "__main__":
    unittest.main()
