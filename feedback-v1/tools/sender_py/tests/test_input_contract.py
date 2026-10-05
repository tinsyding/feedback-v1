"""阶段 1 输入契约单测：解析规则 + 测试.json 读取 + 2 条仿真数据（非真实隐私）。"""

import json
import os
import tempfile
import unittest

from sender_py.utils import load_feedback_items, parse_student_identifier
from sender_py.store import HistoryManager
from sender_py.reply_notes import verdict


class TestInputContract(unittest.TestCase):
    def test_parse_variants(self):
        self.assertEqual(parse_student_identifier("90001张三"), ("90001", "张三"))
        self.assertEqual(parse_student_identifier("90001,张三"), ("90001", "张三"))
        self.assertEqual(parse_student_identifier("90001，张三"), ("90001", "张三"))
        self.assertEqual(parse_student_identifier("80001 李四"), ("80001", "李四"))
        # 仿真数据（非真实隐私）
        self.assertEqual(parse_student_identifier("99999测试甲"), ("99999", "测试甲"))
        self.assertEqual(parse_student_identifier("88888,测试乙"), ("88888", "测试乙"))

    def test_load_real_sample_file(self):
        path = os.path.join(os.path.dirname(__file__), "..", "..", "测试.json")
        if not os.path.isfile(path):
            self.skipTest("缺少 测试.json")
        items = load_feedback_items(path)
        self.assertEqual(len(items), 3)
        self.assertEqual(items[0]["sid"], "90001")
        self.assertIn("\n", items[0]["message"])  # 换行原样保留

    def test_load_simulated_two_entries(self):
        fake = [
            {"studentName": "99999测试甲", "message": "甲家长您好，\n第一行\n第二行"},
            {"studentName": "88888,测试乙", "message": "乙家长您好，\n只有一行"},
        ]
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
            json.dump(fake, f, ensure_ascii=False)
            tmp = f.name
        try:
            items = load_feedback_items(tmp)
            self.assertEqual(len(items), 2)
            self.assertEqual(items[0]["sname"], "测试甲")
            self.assertIn("\n", items[0]["message"])
        finally:
            os.unlink(tmp)

    def test_history_compat_read(self):
        legacy = {"classes": {"三年二班 [第 1 周]": {"cycle": "第 1 周", "students": []}}}
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
            json.dump(legacy, f, ensure_ascii=False)
            tmp = f.name
        try:
            hm = HistoryManager(storage_path=tmp)
            self.assertIn("三年二班 [第 1 周]", hm._data["classes"])
        finally:
            os.unlink(tmp)

    def test_verdict_fail_open(self):
        self.assertEqual(verdict(None), "待人工确认")
        self.assertEqual(verdict(True), "需回")
        self.assertEqual(verdict(False), "无需回")


if __name__ == "__main__":
    unittest.main()
