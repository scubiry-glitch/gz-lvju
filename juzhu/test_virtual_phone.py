#!/usr/bin/env python3
"""项目虚拟号：校验 / 格式化 / 导出脱敏 / handler 无缓存。"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from tp_client import (  # noqa: E402
    TpError,
    format_virtual_phone,
    validate_real_phone,
)


class TestPhoneHelpers(unittest.TestCase):
    def test_validate_ok(self):
        self.assertEqual(validate_real_phone("138-0013-8000"), "13800138000")
        self.assertIsNone(validate_real_phone(""))
        self.assertIsNone(validate_real_phone(None))

    def test_validate_rejects_400(self):
        with self.assertRaises(ValueError):
            validate_real_phone("4008891279")

    def test_validate_rejects_short(self):
        with self.assertRaises(ValueError):
            validate_real_phone("12345")

    def test_format_virtual(self):
        out = format_virtual_phone("4008891279-0355")
        self.assertEqual(out["virtual_phone"], "4008891279-0355")
        self.assertIn("转", out["display"])
        self.assertEqual(out["tel"], "tel:4008891279,0355")


class TestExportStripsPhone(unittest.TestCase):
    def test_normalize_strips_by_default(self):
        from db import normalize_project_row

        row = {"id": 1, "name": "x", "contact_phone": "13800138000", "rating": None}
        pub = normalize_project_row(row)
        self.assertNotIn("contact_phone", pub)
        admin = normalize_project_row(row, include_contact_phone=True)
        self.assertEqual(admin["contact_phone"], "13800138000")


class TestVirtualPhoneNoCache(unittest.TestCase):
    def test_call_alloc_invoked_twice(self):
        from tp_client import call_alloc

        responses = [
            {
                "errno": 0,
                "data": [{"errno": 0, "virtual_phone_number": "4008891279-0001"}],
            },
            {
                "errno": 0,
                "data": [{"errno": 0, "virtual_phone_number": "4008891279-0002"}],
            },
        ]
        call_count = {"n": 0}

        class FakeResp:
            status = 200

            def __init__(self, body):
                self._body = json.dumps(body).encode("utf-8")

            def read(self):
                return self._body

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        class FakeOpener:
            def open(self, req, timeout=20):
                i = call_count["n"]
                call_count["n"] += 1
                return FakeResp(responses[i])

        with patch.dict(
            "os.environ",
            {"TP_APP_ID": "1", "TP_APP_KEY": "testkey", "TP_BASE": "http://tp-test.lianjia.com"},
        ), patch("urllib.request.build_opener", return_value=FakeOpener()):
            a = call_alloc(number="13800138000")
            b = call_alloc(number="13800138000")
        self.assertEqual(call_count["n"], 2)
        self.assertEqual(a["virtual_phone"], "4008891279-0001")
        self.assertEqual(b["virtual_phone"], "4008891279-0002")
        self.assertNotIn("138", a["tel"])


if __name__ == "__main__":
    unittest.main()
