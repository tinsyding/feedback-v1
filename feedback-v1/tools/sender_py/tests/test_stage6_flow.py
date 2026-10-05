"""阶段 6 单测（Linux 全测）：决策矩阵/候选推演/名单/断点续发。无 tkinter/真机依赖。"""

import csv
import os
import tempfile
import unittest

from sender_py.reply_notes import (
    actionable, dedupe_add, export_csv, make_note, should_record, verdict,
)
from sender_py.sender import archive_key_for_input, decide_action, run_candidate_outcomes
from sender_py.store import HistoryManager


def _j(**kw):
    base = {"matched": False, "is_group": False, "title_in_header": True,
            "detected_title": "t", "last_sender": "parent",
            "last_message_text": "你好", "needs_reply": False, "reason": ""}
    base.update(kw)
    return base


class TestStage6(unittest.TestCase):
    def test_decide_send(self):
        d = decide_action(_j(matched=True, needs_reply=True))
        self.assertEqual(d["action"], "send")

    def test_decide_send_fail_open_null(self):
        d = decide_action(_j(matched=True, needs_reply=None))
        self.assertEqual(d["action"], "send")  # null 照发

    def test_decide_group_intercept(self):
        d = decide_action(_j(matched=True, is_group=True))
        self.assertEqual(d["action"], "intercept")

    def test_decide_mismatch_next(self):
        d = decide_action(_j(matched=False))
        self.assertEqual(d["action"], "next")

    def test_decide_missing_fail_closed(self):
        self.assertEqual(decide_action(None)["action"], "next")
        self.assertEqual(decide_action({})["action"], "next")  # matched 缺失≠放行
        self.assertEqual(decide_action({"matched": 1})["action"], "next")

    def test_run_outcomes(self):
        r = run_candidate_outcomes([_j(matched=True, needs_reply=None)])
        self.assertEqual((r["result"], r["at_candidate"]), ("sent", 1))
        r = run_candidate_outcomes([_j(), _j(), _j()])
        self.assertEqual(r["result"], "unmatched")
        r = run_candidate_outcomes([_j(), _j(matched=True, is_group=True)])
        self.assertEqual((r["result"], r["at_candidate"]), ("blocked", 2))
        r = run_candidate_outcomes([None, _j(matched=True)])
        self.assertEqual((r["result"], r["at_candidate"]), ("sent", 2))

    def test_notes(self):
        n = make_note("90001张三", 1, "90001张三", True, _j(needs_reply=None))
        self.assertEqual(n["verdict"], "待人工确认")  # fail-open
        self.assertEqual(n["identity"], "✅已确认")
        self.assertTrue(should_record("t", _j()))
        self.assertFalse(should_record("", {"needs_reply": None, "last_message_text": ""}))
        notes = []
        dedupe_add(notes, n)
        dedupe_add(notes, dict(n, last_message="新"))
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0]["last_message"], "新")
        self.assertEqual(verdict(False), "无需回")
        self.assertEqual(len(actionable(notes)), 1)  # None 不算无需回
        notes.append(make_note("s", 1, "t", False, _j(needs_reply=False)))
        self.assertEqual(len(actionable(notes)), 1)

    def test_export_csv(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "n.csv")
            export_csv([make_note("90001张三", 1, "t", True, _j())], p)
            with open(p, encoding="utf-8-sig") as f:
                rows = list(csv.DictReader(f))
            self.assertEqual(rows[0]["student"], "90001张三")

    def test_history_mark_and_skip(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "h.json")
            hm = HistoryManager(storage_path=p)
            key = "测试 [第 1 周]"
            self.assertFalse(hm.is_sent(key, "90001张三"))
            hm.mark_status(key, "90001张三", "✅已发送", "msg")
            hm2 = HistoryManager(storage_path=p)  # 重读兼容
            self.assertTrue(hm2.is_sent(key, "90001张三"))
            self.assertFalse(hm2.is_sent(key, "80001李四"))

    def test_archive_key(self):
        self.assertEqual(archive_key_for_input("测试.json"), "测试 [第 1 周]")


if __name__ == "__main__":
    unittest.main()
