# -*- coding: utf-8 -*-
"""Unit tests for local utilities (Base64, MD5, Serial/GOTA splitting)."""

import json
import tempfile
import unittest
from pathlib import Path

from tools.base64_codec.core import decode_text, encode_text
from tools.md5_tool.core import format_md5, md5_text
from tools.serial_prefix.core import convert_text


class TestLocalTools(unittest.TestCase):
    def test_md5_calculation(self) -> None:
        val = md5_text("hello")
        self.assertEqual(format_md5(val, uppercase=False), "5d41402abc4b2a76b9719d911017c592")
        self.assertEqual(format_md5(val, uppercase=True), "5D41402ABC4B2A76B9719D911017C592")

    def test_base64_encode_decode(self) -> None:
        plain = "Hello Android TV!"
        encoded = encode_text(plain, urlsafe=False, compact_json=False)
        decoded = decode_text(encoded, urlsafe=False, pretty_json=False)
        self.assertEqual(decoded, plain)

    def test_base64_compact_json(self) -> None:
        raw_json = json.dumps({"key": "value", "arr": [1, 2, 3]}, indent=4)
        encoded = encode_text(raw_json, compact_json=True)
        decoded = decode_text(encoded, pretty_json=False)
        self.assertEqual(json.loads(decoded), {"key": "value", "arr": [1, 2, 3]})

    def test_gota_serial_splitting(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            dest = Path(tmp_dir)
            serials = "\n".join([f"SN_{i:04d}" for i in range(1, 26)])  # 25 serials
            # Split with chunk_size = 10
            total, files = convert_text(
                serials, out_dir=dest, chunk_size=10, prefix="prefix_", output_stem="test_split"
            )
            self.assertEqual(total, 25)
            self.assertEqual(len(files), 3)  # 10 + 10 + 5
            # Check content of first chunk
            lines_0 = files[0].read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(lines_0), 10)
            self.assertTrue(lines_0[0].startswith("prefix_SN_0001"))


if __name__ == "__main__":
    unittest.main()
