"""阶段 1 输入契约单测：解析规则 + 测试.json 读取 + 2 条仿真数据（非真实隐私）。"""

import json
import os
import tempfile
import unittest

from sender_py.utils import load_feedback_items, parse_student_identifier
from sender_py.store import HistoryManager, SentFilesManager
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

    def test_sent_files_manager(self):
        with tempfile.TemporaryDirectory() as d:
            sfm = SentFilesManager(base_dir=d)
            self.assertEqual(len(sfm.get_records()), 0)
            self.assertFalse(sfm.is_file_sent("test.json"))

            fake_items = [
                {"studentName": "90001张三", "sid": "90001", "sname": "张三", "_status": "已发送", "message": "msg1"},
                {"studentName": "90002李四", "sid": "90002", "sname": "李四", "_status": "发送失败", "message": "msg2"},
            ]
            rec = sfm.record_sent_file("/path/to/test.json", fake_items, sent_time="2026-10-26 10:00:00")
            self.assertEqual(rec["file_name"], "test.json")
            self.assertEqual(rec["sent_count"], 1)
            self.assertEqual(rec["total_count"], 2)
            self.assertTrue(sfm.is_file_sent("test.json"))
            self.assertTrue(sfm.is_file_sent("/path/to/test.json"))

            # 验证生成的本地 JSON 和 HTML 记录文件真实存在且内容正确
            self.assertTrue(os.path.isfile(rec["json_record"]))
            self.assertTrue(os.path.isfile(rec["html_record"]))
            with open(rec["json_record"], "r", encoding="utf-8") as f:
                data = json.load(f)
                self.assertEqual(data["sent_count"], 1)
                self.assertEqual(len(data["students"]), 2)
            with open(rec["html_record"], "r", encoding="utf-8") as f:
                html_text = f.read()
                self.assertIn("90001张三", html_text)
                self.assertIn("极方反馈发送记录", html_text)

            # 测试重新加载
            sfm2 = SentFilesManager(base_dir=d)
            self.assertEqual(len(sfm2.get_records()), 1)
            self.assertTrue(sfm2.is_file_sent("test.json"))


if __name__ == "__main__":
    unittest.main()
