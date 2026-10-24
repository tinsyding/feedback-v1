"""阶段 6 单测（Linux 全测）：决策矩阵/候选推演/名单/断点续发。无 tkinter/真机依赖。"""

import csv
import json
import os
import tempfile
import unittest
from unittest import mock

from sender_py import window_utils as wu
from sender_py.reply_notes import (
    actionable, dedupe_add, export_csv, make_note, should_record, verdict,
)
from sender_py.sender import (
    archive_key_for_input, candidate_search_plan, decide_action, load_feedback_inputs,
    run_candidate_outcomes, search_and_enter,
)
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

    def test_load_feedback_inputs_merge_dedupe(self):
        with tempfile.TemporaryDirectory() as d:
            p1 = os.path.join(d, "a.json")
            p2 = os.path.join(d, "b.json")
            with open(p1, "w", encoding="utf-8") as f:
                json.dump([
                    {"studentName": "90001张三", "message": "a1"},
                    {"studentName": "80001李四", "message": "a2"},
                ], f, ensure_ascii=False)
            with open(p2, "w", encoding="utf-8") as f:
                json.dump([
                    {"studentName": "90001,张三", "message": "dup"},
                    {"studentName": "70001王五", "message": "b2"},
                ], f, ensure_ascii=False)
            items, file_counts, duplicates = load_feedback_inputs([p1, p2])

        self.assertEqual([i["studentName"] for i in items],
                         ["90001张三", "80001李四", "70001王五"])
        self.assertEqual([n for _, n in file_counts], [2, 2])
        self.assertEqual(duplicates, 1)
        self.assertEqual(items[0]["_archive_key"], "a [第 1 周]")
        self.assertEqual(items[1]["_archive_key"], "a [第 1 周]")
        self.assertEqual(items[2]["_archive_key"], "b [第 1 周]")

    def test_candidate_search_plan_down_before_enter(self):
        # 先按 Down 选中候选，最后才 Enter；不能先 Enter 进第一个会话
        self.assertEqual(candidate_search_plan(1), ["enter"])
        self.assertEqual(candidate_search_plan(2), ["down", "enter"])
        self.assertEqual(candidate_search_plan(3), ["down", "down", "enter"])
        self.assertEqual(candidate_search_plan(0), ["enter"])
        for idx in (1, 2, 3):
            plan = candidate_search_plan(idx)
            self.assertEqual(plan.count("enter"), 1)
            self.assertEqual(plan[-1], "enter")
            self.assertNotIn("enter", plan[:-1])

    def test_search_and_enter_down_before_enter(self):
        calls = []

        def record_key(vk):
            calls.append(("key", vk))
            return True

        def record_keys(*vks):
            calls.append(("keys",) + tuple(vks))
            return True

        with mock.patch.object(wu, "find_and_activate_wecom", return_value=True), \
                mock.patch.object(wu, "tap_keys", side_effect=record_keys), \
                mock.patch.object(wu, "tap_key", side_effect=record_key), \
                mock.patch.object(wu, "is_foreground_wecom", return_value=True), \
                mock.patch("sender_py.sender.safe_copy", return_value=True), \
                mock.patch("sender_py.sender.time.sleep", return_value=None):
            self.assertTrue(search_and_enter("80001李四", 2))

        key_calls = [c for c in calls if c[0] == "key"]
        self.assertEqual([c[1] for c in key_calls],
                         [0x08, wu.VK_DOWN, wu.VK_RETURN])
        self.assertLess(key_calls.index(("key", wu.VK_DOWN)),
                        key_calls.index(("key", wu.VK_RETURN)))


if __name__ == "__main__":
    unittest.main()
