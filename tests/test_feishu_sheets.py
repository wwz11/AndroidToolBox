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

    def test_copy_feishu_spreadsheet_payload(self) -> None:
        calls: list[tuple[str, str]] = []

        def fake_req(method: str, path: str, **kwargs: object) -> dict:
            calls.append((method, path))
            if path.endswith("/copy"):
                return {
                    "code": 0,
                    "data": {
                        "file": {
                            "token": "shtNEW999",
                            "url": "https://feishu.cn/sheets/shtNEW999",
                            "name": "Report_Flow1",
                        }
                    },
                }
            if "metas/batch_query" in path:
                return {"code": 0, "data": {"metas": [{"parent_token": "fldPARENT"}]}}
            return {"code": 0, "data": {}}

        with (
            patch.object(fs, "get_tenant_access_token", return_value="t-tok"),
            patch.object(fs, "_request_json", side_effect=fake_req),
            patch.object(fs, "load_feishu_config", return_value={"user_open_id": "ou_tester_1"}),
        ):
            res = fs.copy_feishu_spreadsheet(
                app_id="aid",
                app_secret="sec",
                url_or_token="https://seirobotics.feishu.cn/sheets/shtSRC111",
                name="Report_Flow1",
            )
            self.assertEqual(res["spreadsheet_token"], "shtNEW999")
            self.assertEqual(res["url"], "https://feishu.cn/sheets/shtNEW999")
            self.assertTrue(any(p.endswith("/copy") for _, p in calls))
            self.assertTrue(any("/permissions/shtNEW999/members" in p for _, p in calls))

    def test_send_feishu_report_notification_by_open_id(self) -> None:
        calls: list[tuple[str, str]] = []

        def fake_req(method: str, path: str, **kwargs: object) -> dict:
            calls.append((method, path))
            if "/im/v1/messages" in path:
                return {"code": 0, "data": {"message_id": "om_msg_1"}}
            return {"code": 0, "data": {}}

        with (
            patch.object(fs, "get_tenant_access_token", return_value="t-tok"),
            patch.object(fs, "_request_json", side_effect=fake_req),
        ):
            res = fs.send_feishu_report_notification(
                app_id="aid",
                app_secret="sec",
                open_id="ou_tester_1",
                project="PROJ_X",
                flow_no="FLOW1",
                report_url="https://feishu.cn/sheets/shtNEW999",
                initial_result="Pass",
            )
            self.assertEqual(res["open_id"], "ou_tester_1")
            self.assertEqual(res["message_id"], "om_msg_1")
            self.assertTrue(any("/im/v1/messages" in p for _, p in calls))

    def test_oauth_url_and_code_exchange(self) -> None:
        url = fs.build_feishu_oauth_url("cli_123", "http://127.0.0.1:8000/emmc/feishu/oauth/callback")
        self.assertIn("app_id=cli_123", url)
        self.assertIn("authen/v1/authorize", url)

        def fake_req(method: str, path: str, **kwargs: object) -> dict:
            if "/authen/v1/oidc/access_token" in path:
                return {
                    "code": 0,
                    "data": {"access_token": "u-tok", "refresh_token": "r-tok", "expires_in": 7200},
                }
            if "/authen/v1/user_info" in path:
                return {"code": 0, "data": {"open_id": "ou_qr_1", "name": "李四"}}
            return {"code": 0, "data": {}}

        with (
            patch.object(fs, "get_app_access_token", return_value="a-tok"),
            patch.object(fs, "_request_json", side_effect=fake_req),
            patch("tools.settings_store.put") as m_put,
        ):
            res = fs.exchange_feishu_oauth_code(app_id="aid", app_secret="sec", code="code_1")
            self.assertEqual(res["open_id"], "ou_qr_1")
            self.assertEqual(res["name"], "李四")
            self.assertTrue(m_put.called)

    def test_default_credentials_and_template_url_fallback(self) -> None:
        with patch("tools.settings_store.get", return_value=""):
            cfg = fs.load_feishu_config()
            self.assertEqual(cfg["app_id"], "cli_ab8c2f031cbb5c14")
            self.assertTrue(cfg["has_secret"])
            self.assertEqual(
                cfg["template_url"],
                "https://seirobotics.feishu.cn/sheets/shtcnYmpb0mKyOwYTFIHSqjBYic",
            )


if __name__ == "__main__":
    unittest.main()
