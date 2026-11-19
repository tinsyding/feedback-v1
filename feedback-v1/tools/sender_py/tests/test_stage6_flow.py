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
    archive_key_for_input, candidate_search_plan, decide_action, ensure_roi,
    load_feedback_inputs, open_sample_chat_for_calibration, run_candidate_outcomes,
    search_and_enter, send_student, status_matches_filter, summarize_status_counts,
)
from sender_py.store import HistoryManager, SentFilesManager
from sender_py.utils import load_feedback_items


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
            export_csv([make_note("90001张三", 1, "t", True, _j(needs_reply=True))], p)
            with open(p, encoding="utf-8-sig") as f:
                rows = list(csv.DictReader(f))
            self.assertEqual(rows[0]["学生"], "90001张三")
            self.assertEqual(rows[0]["会话"], "t")
            self.assertEqual(rows[0]["需回"], "需回")

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

    def test_load_feedback_html_embedded_data(self):
        payload = [{"studentName": "90001张三", "message": "第一行\n第二行 </script> & 内容"}]
        embedded = json.dumps(payload, ensure_ascii=False).replace("</script", "<\\/script")
        html_text = (
            '<html><body><script type="application/json" id="feedback-data">'
            + embedded
            + "</script></body></html>"
        )
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "snapshot.html")
            with open(p, "w", encoding="utf-8") as f:
                f.write(html_text)
            items = load_feedback_items(p)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["studentName"], "90001张三")
        self.assertEqual((items[0]["sid"], items[0]["sname"]), ("90001", "张三"))
        self.assertEqual(items[0]["message"], "第一行\n第二行 </script> & 内容")

    def test_load_feedback_html_table_fallback(self):
        html_text = """
        <html><body><table><tbody><tr>
        <td><span class="student-name">80001李四</span></td>
        <td><div class="feedback-content">第一行<br>第二行 &amp; 内容</div></td>
        </tr></tbody></table></body></html>
        """
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "old-snapshot.htm")
            with open(p, "w", encoding="utf-8") as f:
                f.write(html_text)
            items = load_feedback_items(p)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["studentName"], "80001李四")
        self.assertEqual(items[0]["message"], "第一行\n第二行 & 内容")

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

        # 特殊情况：针对「文件传输助手」或 down_first=True，即使 candidate_index=1 也会先按 Down
        self.assertEqual(candidate_search_plan(1, down_first=True), ["down", "enter"])
        self.assertEqual(candidate_search_plan(2, down_first=True), ["down", "down", "enter"])
        self.assertEqual(candidate_search_plan(0, down_first=True), ["enter"])

    def test_status_filter_and_summary_helpers(self):
        self.assertTrue(status_matches_filter("发送失败", "失败/未匹配"))
        self.assertTrue(status_matches_filter("未匹配", "失败/未匹配"))
        self.assertFalse(status_matches_filter("已发送", "失败/未匹配"))
        self.assertTrue(status_matches_filter("已跳过（已发送）", "已跳过"))
        self.assertTrue(status_matches_filter("已发送", "全部"))
        counts = summarize_status_counts([
            "已发送", "发送失败", "未匹配", "已拦截", "已跳过（已发送）", "待发送",
        ])
        self.assertEqual(counts, {
            "已发送": 1, "发送失败": 1, "已拦截": 1,
            "未匹配": 1, "已跳过": 2,
        })

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

    def test_search_and_enter_file_helper_down_first(self):
        """测试文件传输助手特殊处理：第1候选依然先发 Down 再发 Enter。"""
        calls_file_helper = []
        calls_normal_student = []
        calls_explicit_down = []

        def make_recorder(target_list):
            def record_key(vk):
                target_list.append(("key", vk))
                return True
            return record_key

        with mock.patch.object(wu, "find_and_activate_wecom", return_value=True), \
                mock.patch.object(wu, "tap_keys", return_value=True), \
                mock.patch.object(wu, "is_foreground_wecom", return_value=True), \
                mock.patch("sender_py.sender.safe_copy", return_value=True), \
                mock.patch("sender_py.sender.time.sleep", return_value=None):

            # 1. 文件传输助手 (candidate_index=1): 自动 down_first
            with mock.patch.object(wu, "tap_key", side_effect=make_recorder(calls_file_helper)):
                self.assertTrue(search_and_enter("文件传输助手", 1))

            # 2. 普通学生 (candidate_index=1): 不发 Down，直接 Enter
            with mock.patch.object(wu, "tap_key", side_effect=make_recorder(calls_normal_student)):
                self.assertTrue(search_and_enter("90001张三", 1))

            # 3. 普通学生显式指定 down_first=True
            with mock.patch.object(wu, "tap_key", side_effect=make_recorder(calls_explicit_down)):
                self.assertTrue(search_and_enter("90001张三", 1, down_first=True))

        keys_file_helper = [c[1] for c in calls_file_helper if c[0] == "key"]
        self.assertEqual(keys_file_helper, [0x08, wu.VK_DOWN, wu.VK_RETURN])

        keys_normal_student = [c[1] for c in calls_normal_student if c[0] == "key"]
        self.assertEqual(keys_normal_student, [0x08, wu.VK_RETURN])

        keys_explicit_down = [c[1] for c in calls_explicit_down if c[0] == "key"]
        self.assertEqual(keys_explicit_down, [0x08, wu.VK_DOWN, wu.VK_RETURN])

    def test_async_reply_analyzer_pipeline_and_fail_open(self):
        import queue
        import time
        from sender_py.sender import AsyncReplyAnalyzer
        from sender_py import vision_api

        q = queue.Queue()
        analyzer = AsyncReplyAnalyzer("https://feedback.wxjifang.cn", "tok", max_workers=2, event_queue=q)

        # 1. 正常返回需回
        with mock.patch.object(vision_api, "identify_reply", return_value={
            "last_sender": "parent",
            "last_message_text": "老师请问这道题怎么做？",
            "needs_reply": True,
            "reason": "家长提问",
        }):
            analyzer.submit("90001张三", 1, "90001", "张三", "90001张三", True, object())
            deadline = time.monotonic() + 3.0
            while analyzer.pending_count > 0 and time.monotonic() < deadline:
                time.sleep(0.02)

        events = []
        while not q.empty():
            events.append(q.get_nowait())
        note_events = [e for e in events if e[0] == "note"]
        self.assertEqual(len(note_events), 1)
        note = note_events[0][1]
        self.assertEqual(note["student"], "90001张三")
        self.assertEqual(note["verdict"], "需回")
        self.assertEqual(note["last_message"], "老师请问这道题怎么做？")

        # 2. 网络异常时 fail-open 记为“待人工确认”
        with mock.patch.object(vision_api, "identify_reply", side_effect=RuntimeError("timeout")):
            analyzer.submit("80001李四", 1, "80001", "李四", "80001李四", True, object())
            deadline = time.monotonic() + 3.0
            while analyzer.pending_count > 0 and time.monotonic() < deadline:
                time.sleep(0.02)

        events2 = []
        while not q.empty():
            events2.append(q.get_nowait())
        note_events2 = [e for e in events2 if e[0] == "note"]
        self.assertEqual(len(note_events2), 1)
        note2 = note_events2[0][1]
        self.assertEqual(note2["student"], "80001李四")
        self.assertIsNone(note2["needs_reply"])
        self.assertEqual(note2["verdict"], "待人工确认")

    def test_judge_candidate_local_ocr_fallback(self):
        """测试场景2在 API 异常时自动降级到本地 OCR 备选方案。"""
        from sender_py import capture, vision_api
        from sender_py.local_ocr import set_ocr_hook_for_testing
        from sender_py.sender import judge_candidate

        class _StubImg:
            def __init__(self, w=400, h=300):
                self.size = (w, h)

            def crop(self, box):
                return _StubImg(100, 50)

        dummy_img = _StubImg(400, 300)
        roi = {
            "title": (0.2, 0.0, 0.8, 0.1),
            "input": (0.2, 0.8, 0.8, 0.2),
            "chat": (0.2, 0.1, 0.8, 0.7),
        }
        rect = (0, 0, 400, 300)

        # 1. 模拟 API 报错，自动降级至本地 OCR 并成功核验
        set_ocr_hook_for_testing(lambda img: "202401-张三 (极方学员)")
        with mock.patch.object(capture, "capture_wecom_window", return_value=dummy_img), \
             mock.patch.object(vision_api, "identify_title", side_effect=RuntimeError("503 Service Unavailable")):
            judgment, chat_title, err, chat_img = judge_candidate(
                rect, roi, "202401", "张三", "https://mock.server", None,
                fast_title_only=True, verify_mode="auto"
            )
            self.assertIsNone(err)
            self.assertIsNotNone(judgment)
            self.assertTrue(judgment["matched"])
            self.assertFalse(judgment["is_group"])
            self.assertIn("[备选方案: 本地OCR]", judgment["reason"])
            self.assertEqual(chat_title, "202401-张三 (极方学员)")

        # 1.5. 模拟本地未匹配尝试调用 API 时，服务端返回 ADMIN_FORCED_LOCAL_OCR，自动标记为 [强制本地OCR]
        set_ocr_hook_for_testing(lambda img: "未识别标题")
        with mock.patch.object(capture, "capture_wecom_window", return_value=dummy_img), \
             mock.patch.object(vision_api, "identify_title", side_effect=RuntimeError("标题核验被拒绝：ADMIN_FORCED_LOCAL_OCR: 管理员已开启强制本地OCR")):
            judgment, chat_title, err, chat_img = judge_candidate(
                rect, roi, "202401", "张三", "https://mock.server", None,
                fast_title_only=True, verify_mode="auto"
            )
            self.assertIsNone(err)
            self.assertIsNotNone(judgment)
            self.assertFalse(judgment["matched"])
            self.assertIn("[强制本地OCR]", judgment["reason"])

        # 2. 模拟本地 OCR 识别到群聊，即使 API 挂了也严格拦截群聊
        set_ocr_hook_for_testing(lambda img: "202401班级交流群 (38)")
        with mock.patch.object(capture, "capture_wecom_window", return_value=dummy_img), \
             mock.patch.object(vision_api, "identify_title", side_effect=RuntimeError("Network Timeout")):
            judgment, chat_title, err, chat_img = judge_candidate(
                rect, roi, "202401", "张三", "https://mock.server", None,
                fast_title_only=True, verify_mode="auto"
            )
            self.assertIsNone(err)
            self.assertIsNotNone(judgment)
            self.assertFalse(judgment["matched"])
            self.assertTrue(judgment["is_group"])
            self.assertIn("群聊", judgment["reason"])

        # 3. 强制本地模式（verify_mode='local'）：不调用 API，直接由本地 OCR 秒级核验
        set_ocr_hook_for_testing(lambda img: "202401-张三")
        with mock.patch.object(capture, "capture_wecom_window", return_value=dummy_img), \
             mock.patch.object(vision_api, "identify_title") as mock_api:
            judgment, chat_title, err, chat_img = judge_candidate(
                rect, roi, "202401", "张三", "https://mock.server", None,
                fast_title_only=True, verify_mode="local"
            )
            mock_api.assert_not_called()
            self.assertIsNone(err)
            self.assertTrue(judgment["matched"])
            self.assertIn("[本地OCR模式]", judgment["reason"])

        set_ocr_hook_for_testing(None)

    def test_record_sent_files_flow(self):
        from sender_py.sender import SenderApp
        with tempfile.TemporaryDirectory() as d:
            sfm = SentFilesManager(base_dir=d)
            class DummyApp:
                input_paths = ["test1.json"]
                items = [
                    {"studentName": "90001张三", "sid": "90001", "sname": "张三", "_status": "已发送", "_archive_key": "test1 [第 1 周]"},
                    {"studentName": "90002李四", "sid": "90002", "sname": "李四", "_status": "待发送", "_archive_key": "test1 [第 1 周]"},
                ]
                _sent_files = sfm
                def emit(self, msg): pass

            SenderApp._record_sent_files(DummyApp())
            self.assertEqual(len(sfm.get_records()), 1)
            self.assertTrue(sfm.is_file_sent("test1.json"))
            rec = sfm.get_records()[0]
            self.assertEqual(rec["sent_count"], 1)
            self.assertEqual(rec["total_count"], 2)

    def test_file_pool_operations(self):
        from sender_py.sender import SenderApp

        with tempfile.TemporaryDirectory() as d:
            f1 = os.path.join(d, "class1.json")
            f2 = os.path.join(d, "class2.json")
            with open(f1, "w", encoding="utf-8") as fp:
                json.dump([{"studentName": "90001张三", "message": "张三评语"}], fp)
            with open(f2, "w", encoding="utf-8") as fp:
                json.dump([{"studentName": "90002李四", "message": "李四评语"}], fp)

            class DummyVar:
                def __init__(self, val=""):
                    self.val = val
                def set(self, v):
                    self.val = v

            class DummyFilePoolApp:
                def __init__(self):
                    self._running = False
                    self.input_paths = []
                    self.items = []
                    self.duplicate_count = 0
                    self._file_counts = {}
                    self.reply_notes = []
                    self._sent_files = None
                    self.root = None
                    self.search_var = DummyVar()
                    self.filter_var = DummyVar()
                    self.emitted = []

                def emit(self, msg):
                    self.emitted.append(msg)

                def refresh_reply_count(self): pass
                def update_file_pool_ui(self): pass
                def update_input_label(self): pass
                def update_summary(self): pass
                def _reset_progress(self): pass
                def _reset_hint(self): pass
                def _cancel_search_rebuild(self): pass
                def rebuild_student_list(self): pass

                add_input_files = SenderApp.add_input_files
                remove_input_file = SenderApp.remove_input_file
                clear_input_files = SenderApp.clear_input_files

            app = DummyFilePoolApp()

            # 1. 添加第一个文件
            app.add_input_files([f1], replace=False)
            self.assertEqual(len(app.input_paths), 1)
            self.assertEqual(len(app.items), 1)
            self.assertEqual(app.items[0]["studentName"], "90001张三")
            self.assertEqual(app._file_counts[f1], 1)

            # 2. 追加第二个文件（不覆盖第一个文件）
            app.add_input_files([f2], replace=False)
            self.assertEqual(len(app.input_paths), 2)
            self.assertEqual(len(app.items), 2)
            names = [it["studentName"] for it in app.items]
            self.assertIn("90001张三", names)
            self.assertIn("90002李四", names)

            # 3. 重复添加已存在的文件 -> 提示无需重复添加
            prev_emitted_len = len(app.emitted)
            app.add_input_files([f1], replace=False)
            self.assertEqual(len(app.input_paths), 2)
            self.assertTrue(any("无需重复添加" in msg for msg in app.emitted[prev_emitted_len:]))

            # 4. 从文件池移除一个文件
            app.remove_input_file(f1)
            self.assertEqual(len(app.input_paths), 1)
            self.assertEqual(app.input_paths[0], f2)
            self.assertEqual(len(app.items), 1)
            self.assertEqual(app.items[0]["studentName"], "90002李四")

            # 5. 清空文件
            app.clear_input_files()
            self.assertEqual(len(app.input_paths), 0)
            self.assertEqual(len(app.items), 0)
            self.assertEqual(len(app._file_counts), 0)

    def test_calibration_loading_dialog_headless_safe(self):
        from sender_py.sender import CalibrationLoadingDialog
        # 在无 Tkinter / Headless 环境下实例化与方法调用应安全回退不抛异常
        dialog = CalibrationLoadingDialog(None, title="测试加载", message="测试准备中...")
        dialog.set_status("测试更新状态...", "副标题")
        dialog.close()

    def test_search_gap_and_batch_break_constants(self):
        from sender_py.pacing import BATCH_BREAK_EVERY, BATCH_BREAK_GAP, SEARCH_GAP
        self.assertEqual(SEARCH_GAP, (0.3, 0.6))
        self.assertEqual(BATCH_BREAK_EVERY, 15)
        self.assertEqual(BATCH_BREAK_GAP, (2.0, 3.0))

    def test_run_all_selected_ids_defined(self):
        from sender_py.sender import SenderApp
        import unittest.mock
        import sys

        class DummyVar:
            def __init__(self, val=True): self.val = val
            def get(self): return self.val
            def set(self, v): self.val = v

        class DummyBtn:
            def __init__(self): self.state = "normal"
            def config(self, **kwargs):
                if "state" in kwargs: self.state = kwargs["state"]

        class DummySender:
            items = [
                {"sid": "001", "sname": "张三", "_selected_var": DummyVar(True)},
                {"sid": "002", "sname": "李四", "_selected_var": DummyVar(False)},
            ]
            _running = False
            start_btn = DummyBtn()
            hint_var = DummyVar("")
            result_var = DummyVar("")
            server = "https://mock"
            _reply_analyzer = None
            _reply_event_queue = None
            root = None
            def emit(self, msg): pass
            def _start_esc_watcher(self): pass
            def _set_running_ui(self, v): pass
            def _update_progress(self, *a, **k): pass
            def _current_verify_mode(self): return "hybrid"
            def _run_all_worker(self, *a, **k): pass
            def _status_of(self, item):
                return item.get("_status", "待发送")
            def set_status(self, item, st): item["_status"] = st

        inst = DummySender()
        mock_tk = unittest.mock.MagicMock()
        mock_mb = unittest.mock.MagicMock()
        mock_tk.messagebox = mock_mb
        with unittest.mock.patch.dict(sys.modules, {"tkinter": mock_tk, "tkinter.messagebox": mock_mb}):
            mock_mb.askyesno.return_value = False
            SenderApp.run_all(inst)
            self.assertEqual(inst.start_btn.state, "normal")

            mock_mb.askyesno.return_value = True
            with unittest.mock.patch("threading.Thread") as mock_thread:
                SenderApp.run_all(inst)
                self.assertTrue(inst._running)
                mock_thread.assert_called_once()
                called_args = mock_thread.call_args[1]["args"]
                selected_ids = called_args[0]
                selected_count = called_args[1]
                self.assertEqual(selected_count, 1)
                self.assertIn(id(inst.items[0]), selected_ids)
                self.assertNotIn(id(inst.items[1]), selected_ids)

    def test_breakpoint_resume_skips_already_sent_students(self):
        from sender_py.sender import SenderApp
        from sender_py.window_utils import GlobalEscWatcher
        import unittest.mock
        import sys

        class DummyVar:
            def __init__(self, val=True): self.val = val
            def get(self): return self.val
            def set(self, v): self.val = v

        class DummyBtn:
            def __init__(self): self.state = "normal"
            def config(self, **kwargs):
                if "state" in kwargs: self.state = kwargs["state"]

        class DummySender:
            items = [
                {"sid": "001", "sname": "张三", "_selected_var": DummyVar(True), "_status": "已发送"},
                {"sid": "002", "sname": "李四", "_selected_var": DummyVar(True), "_status": "待发送"},
            ]
            _running = False
            start_btn = DummyBtn()
            hint_var = DummyVar("")
            result_var = DummyVar("")
            server = "https://mock"
            _reply_analyzer = None
            _reply_event_queue = None
            root = None
            def emit(self, msg): pass
            def _start_esc_watcher(self): pass
            def _set_running_ui(self, v): pass
            def _update_progress(self, *a, **k): pass
            def _current_verify_mode(self): return "hybrid"
            def _run_all_worker(self, *a, **k): pass
            def _status_of(self, item): return item.get("_status", "待发送")
            def set_status(self, item, st): item["_status"] = st

        inst = DummySender()
        mock_tk = unittest.mock.MagicMock()
        mock_mb = unittest.mock.MagicMock()
        mock_tk.messagebox = mock_mb
        with unittest.mock.patch.dict(sys.modules, {"tkinter": mock_tk, "tkinter.messagebox": mock_mb}):
            mock_mb.askyesno.return_value = True
            with unittest.mock.patch("threading.Thread") as mock_thread:
                SenderApp.run_all(inst)
                self.assertTrue(inst._running)
                mock_thread.assert_called_once()
                called_args = mock_thread.call_args[1]["args"]
                target_ids = called_args[0]
                effective_count = called_args[1]
                # 只有未发送的“李四”被纳入本次发送名单，已发送的“张三”被自动跳过保护
                self.assertEqual(effective_count, 1)
                self.assertNotIn(id(inst.items[0]), target_ids)
                self.assertIn(id(inst.items[1]), target_ids)
                self.assertEqual(inst.items[0]["_status"], "已发送")

    def test_global_esc_watcher_cross_platform_safe(self):
        from sender_py.window_utils import GlobalEscWatcher
        callback_called = [False]
        def on_stop():
            callback_called[0] = True

        watcher = GlobalEscWatcher(on_stop_callback=on_stop)
        watcher.start()
        watcher._trigger_stop()
        self.assertTrue(callback_called[0])
        watcher.stop()

    def test_rescue_option1_fuzzy_match(self):
        from sender_py.sender import rescue_option1_fuzzy_match
        # 模拟云端 API 严格返回 matched=False，但 detected_title 中包含学号与形近字姓名
        mock_judgment = {
            "matched": False,
            "is_group": False,
            "detected_title": "65405胡籽墨 @微信",
            "reason": "学号或姓名不匹配",
        }
        rescued = rescue_option1_fuzzy_match(mock_judgment, "65405", "胡耔墨")
        self.assertTrue(rescued["matched"])
        self.assertIn("方案1容错放行", rescued["reason"])

        # 若是群聊，决不放行
        group_judgment = {
            "matched": False,
            "is_group": True,
            "detected_title": "65405胡籽墨群聊",
            "reason": "群聊",
        }
        self.assertFalse(rescue_option1_fuzzy_match(group_judgment, "65405", "胡耔墨")["matched"])

    def test_treeview_high_perf_ui_helpers(self):
        from sender_py.sender import SenderApp

        class DummyVar:
            def __init__(self, val): self.val = val
            def get(self): return self.val
            def set(self, v): self.val = v

        class DummyTree:
            def __init__(self):
                self.rows = {}
                self.heading_text = {}
                self.seen = []
            def get_children(self):
                return tuple(self.rows.keys())
            def delete(self, *iids):
                for iid in iids:
                    self.rows.pop(iid, None)
            def insert(self, _parent, _index, iid=None, values=(), tags=()):
                self.rows[iid] = {"values": values, "tags": tags}
            def item(self, iid, values=None, tags=None):
                if iid in self.rows:
                    if values is not None:
                        self.rows[iid]["values"] = values
                    if tags is not None:
                        self.rows[iid]["tags"] = tags
            def heading(self, col, text=None, **_kw):
                if text is not None:
                    self.heading_text[col] = text
            def see(self, iid):
                self.seen.append(iid)
            def yview_moveto(self, _v):
                pass

        class DummyTk:
            TclError = RuntimeError
            @staticmethod
            def BooleanVar(master=None, value=True):
                return DummyVar(value)
            @staticmethod
            def StringVar(master=None, value=""):
                return DummyVar(value)

        class DummyApp:
            tk = DummyTk
            root = None
            _running = False
            _search_after = None
            search_var = DummyVar("")
            filter_var = DummyVar("全部")
            summary_var = DummyVar("")
            input_paths = ["a.json"]
            items = [
                {"sid": "65405", "sname": "胡耔墨", "studentName": "65405胡耔墨", "message": "m1"},
                {"sid": "65406", "sname": "李四", "studentName": "65406李四", "message": "m2"},
            ]
            students_tree = DummyTree()
            _status_of = SenderApp._status_of
            _visible_items = SenderApp._visible_items
            _cancel_search_rebuild = SenderApp._cancel_search_rebuild
            _tree_tag_for_item = SenderApp._tree_tag_for_item
            _tree_values_for_item = SenderApp._tree_values_for_item
            _refresh_tree_row = SenderApp._refresh_tree_row
            rebuild_student_list = SenderApp.rebuild_student_list
            _do_set_status = SenderApp._do_set_status
            set_status = SenderApp.set_status
            update_summary = SenderApp.update_summary
            _apply_selection_status = SenderApp._apply_selection_status
            set_all_selected = SenderApp.set_all_selected

        app = DummyApp()
        app.rebuild_student_list()
        self.assertEqual(len(app.students_tree.rows), 2)
        self.assertEqual(app.students_tree.rows["row_0"]["values"][0], "☑")
        self.assertEqual(app.students_tree.rows["row_0"]["tags"], ("st_待发送_even",))
        self.assertEqual(app.students_tree.rows["row_1"]["tags"], ("st_待发送_odd",))

        app.set_all_selected(False)
        self.assertEqual(app.students_tree.rows["row_0"]["values"][0], "☐")
        self.assertEqual(app.students_tree.rows["row_0"]["values"][3], "已跳过")
        self.assertEqual(app.students_tree.heading_text.get("select"), "☐ 选")

        app._running = True
        app._do_set_status(app.items[1], "发送中")
        self.assertEqual(app.students_tree.rows["row_1"]["tags"], ("st_发送中",))
        self.assertIn("row_1", app.students_tree.seen)

    def test_find_and_close_wecom_search_tab_wnd(self):
        # Linux 默认无 win32 模块，安全返回 None / False
        self.assertIsNone(wu.find_wecom_search_tab_wnd())
        self.assertFalse(wu.close_wecom_search_tab_wnd())

        # 模拟 win32 环境
        mock_win32gui = mock.MagicMock()
        mock_win32con = mock.MagicMock()
        mock_win32con.WM_CLOSE = 0x0010

        with mock.patch.dict("sys.modules", {"win32gui": mock_win32gui, "win32con": mock_win32con}):
            # 情况 1：前台窗口就是 SearchTabWnd2
            mock_win32gui.GetForegroundWindow.return_value = 0x1234
            mock_win32gui.IsWindow.return_value = True
            mock_win32gui.IsWindowVisible.return_value = True
            mock_win32gui.GetClassName.return_value = "SearchTabWnd2"
            mock_win32gui.GetWindowText.return_value = "全局搜索"
            self.assertEqual(wu.find_wecom_search_tab_wnd(), 0x1234)

            # 情况 2：前台窗口不是，枚举窗口发现 SearchTabWnd2
            mock_win32gui.GetForegroundWindow.return_value = 0x9999
            mock_win32gui.GetClassName.side_effect = lambda h: "SearchTabWnd2" if h == 0x5678 else "OtherWnd"
            mock_win32gui.GetWindowText.side_effect = lambda h: "全局搜索" if h == 0x5678 else "其他窗口"
            def _fake_enum(cb, extra):
                cb(0x1111, extra)
                cb(0x5678, extra)
            mock_win32gui.EnumWindows.side_effect = _fake_enum
            self.assertEqual(wu.find_wecom_search_tab_wnd(), 0x5678)

            # 情况 3：关闭弹窗
            mock_win32gui.IsWindow.return_value = False
            with mock.patch.object(wu, "find_and_activate_wecom", return_value=True) as mock_act:
                ok = wu.close_wecom_search_tab_wnd(0x5678)
                self.assertTrue(ok)
                mock_win32gui.PostMessage.assert_called_with(0x5678, mock_win32con.WM_CLOSE, 0, 0)
                mock_act.assert_called_once()

    def test_send_student_search_tab_wnd_auto_skip(self):
        """测试搜人未匹配弹出全局搜索窗口时，立即关闭弹窗并标记未匹配，直接跳过剩余候选。"""
        logs = []
        item = {
            "sid": "65405",
            "sname": "胡耔墨",
            "studentName": "65405胡耔墨",
            "message": "测试反馈话术内容",
        }

        with mock.patch.object(wu, "find_and_activate_wecom", return_value=True), \
             mock.patch.object(wu, "ensure_fully_visible", return_value=(True, (0, 0, 1000, 800))), \
             mock.patch.object(wu, "get_dpi_scale", return_value=1.0), \
             mock.patch("sender_py.sender.ensure_roi", return_value=(10, 10, 200, 50)), \
             mock.patch("sender_py.sender.search_and_enter", return_value=True) as mock_search, \
             mock.patch.object(wu, "find_wecom_search_tab_wnd") as mock_find_tab, \
             mock.patch.object(wu, "close_wecom_search_tab_wnd", return_value=True) as mock_close_tab:

            # 第一次调用（开始前的残留检查）返回 None，候选 1 搜索后返回弹窗 HWND
            mock_find_tab.side_effect = [None, 0x171286]

            res = send_student(item, "http://localhost:8000", log=logs.append)

            self.assertEqual(res["result"], "unmatched")
            self.assertEqual(res["reason"], "未找到学生（弹出全局搜索窗口）")
            # 必须仅执行了 1 次搜索，候选 2 和候选 3 被立即熔断跳过
            self.assertEqual(mock_search.call_count, 1)
            mock_close_tab.assert_called_with(0x171286)
            # 验证日志输出
            log_str = "\n".join(logs)
            self.assertIn("SearchTabWnd2", log_str)
            self.assertIn("自动关闭全局搜索窗口，直接跳过并开始处理下一位学生", log_str)

    def test_open_sample_chat_for_calibration_with_student(self):
        """测试校准前预搜索：提供了有效学生姓名时优先检索该学生。"""
        logs = []
        with mock.patch.object(wu, "find_and_activate_wecom", return_value=True), \
             mock.patch("sender_py.sender.search_and_enter", return_value=True) as mock_search, \
             mock.patch.object(wu, "find_wecom_search_tab_wnd", return_value=None):
            ok = open_sample_chat_for_calibration("90001张三", log=logs.append)
            self.assertTrue(ok)
            mock_search.assert_called_once_with("90001张三", 1)
            self.assertTrue(any("90001张三" in l for l in logs))

    def test_open_sample_chat_for_calibration_fallback_to_file_helper(self):
        """测试校准前预搜索：若搜学生未找到弹出全局搜索，自动回退到 [文件传输助手]。"""
        logs = []
        with mock.patch.object(wu, "find_and_activate_wecom", return_value=True), \
             mock.patch("sender_py.sender.search_and_enter", return_value=True) as mock_search, \
             mock.patch.object(wu, "find_wecom_search_tab_wnd") as mock_find_tab, \
             mock.patch.object(wu, "close_wecom_search_tab_wnd", return_value=True) as mock_close_tab:
            # 第一次搜学生返回弹窗句柄，第二次搜文件传输助手返回 None
            mock_find_tab.side_effect = [0x9999, None]
            ok = open_sample_chat_for_calibration("90001张三", log=logs.append)
            self.assertTrue(ok)
            self.assertEqual(mock_search.call_count, 2)
            mock_search.assert_any_call("90001张三", 1)
            mock_search.assert_any_call("文件传输助手", 1)
            mock_close_tab.assert_called_with(0x9999)
            self.assertTrue(any("文件传输助手" in l for l in logs))

    def test_open_sample_chat_for_calibration_default_helper(self):
        """测试校准前预搜索：未提供姓名时默认检索 [文件传输助手]。"""
        logs = []
        with mock.patch.object(wu, "find_and_activate_wecom", return_value=True), \
             mock.patch("sender_py.sender.search_and_enter", return_value=True) as mock_search, \
             mock.patch.object(wu, "find_wecom_search_tab_wnd", return_value=None):
            ok = open_sample_chat_for_calibration(None, log=logs.append)
            self.assertTrue(ok)
            mock_search.assert_called_once_with("文件传输助手", 1)
            self.assertTrue(any("文件传输助手" in l for l in logs))

    def test_find_and_activate_wecom_skips_alt_when_already_foreground(self):
        """企微已在前台且非最小化时，不发送 Alt(VK_MENU)，避免打断焦点或误触发菜单。"""
        mock_win32gui = mock.MagicMock()
        mock_win32con = mock.MagicMock()
        mock_u32 = mock.MagicMock()

        with mock.patch.dict("sys.modules", {"win32gui": mock_win32gui, "win32con": mock_win32con}), \
             mock.patch.object(wu, "_user32", return_value=mock_u32), \
             mock.patch.object(wu, "get_wecom_hwnd", return_value=0xABCD), \
             mock.patch.object(wu, "is_window_iconic", return_value=False):
            # 已在前台：直接返回 True，不按 Alt、不调用 SetForegroundWindow
            mock_win32gui.GetForegroundWindow.return_value = 0xABCD
            self.assertTrue(wu.find_and_activate_wecom())
            mock_u32.keybd_event.assert_not_called()
            mock_win32gui.SetForegroundWindow.assert_not_called()

            # 不在前台：使用 Alt 绕前台锁并调用 SetForegroundWindow
            mock_win32gui.GetForegroundWindow.return_value = 0x9999
            self.assertTrue(wu.find_and_activate_wecom())
            self.assertEqual(mock_u32.keybd_event.call_count, 2)
            mock_win32gui.SetForegroundWindow.assert_called_once_with(0xABCD)

    def test_send_student_retries_unfocused_search_and_skips_stale_capture(self):
        """search_and_enter 返回 False 时先重试一次；仍失焦则跳过截图，防止截到上一个人。"""
        item = {
            "sid": "65405",
            "sname": "胡耔墨",
            "studentName": "65405胡耔墨",
            "message": "测试反馈话术内容",
        }
        roi = {"title": [0.3, 0.02, 0.6, 0.08], "chat": [0.3, 0.1, 0.9, 0.8]}

        # 情况 1：第 1 次失焦返回 False，重试成功返回 True，随后匹配发送
        logs_a = []
        with mock.patch.object(wu, "find_and_activate_wecom", return_value=True), \
             mock.patch.object(wu, "ensure_fully_visible", return_value=(True, (0, 0, 1000, 800))), \
             mock.patch.object(wu, "get_dpi_scale", return_value=1.0), \
             mock.patch.object(wu, "get_wecom_rect", return_value=(0, 0, 1000, 800)), \
             mock.patch.object(wu, "find_wecom_search_tab_wnd", return_value=None), \
             mock.patch("sender_py.sender.ensure_roi", return_value=roi), \
             mock.patch("sender_py.sender._capture_title_crop", return_value=None), \
             mock.patch("sender_py.sender.search_and_enter", side_effect=[False, True]) as mock_search, \
             mock.patch("sender_py.sender.judge_candidate", return_value=(
                 {"matched": True, "is_group": False, "needs_reply": False, "detected_title": "65405胡耔墨"},
                 "65405胡耔墨",
                 None,
             )) as mock_judge, \
             mock.patch("sender_py.sender.paste_and_send", return_value=(True, "已发送")), \
             mock.patch("sender_py.sender.time.sleep", return_value=None):
            res_a = send_student(item, "http://localhost:8000", log=logs_a.append)
        self.assertEqual(res_a["result"], "sent")
        self.assertEqual(mock_search.call_count, 2)
        self.assertEqual(mock_search.call_args_list[1].kwargs, {"search_wait": 1.8, "enter_wait": 1.3})
        self.assertEqual(mock_judge.call_count, 1)

        # 情况 2：全部候选均失焦返回 False -> 绝不调用 judge_candidate
        logs_b = []
        with mock.patch.object(wu, "find_and_activate_wecom", return_value=True), \
             mock.patch.object(wu, "ensure_fully_visible", return_value=(True, (0, 0, 1000, 800))), \
             mock.patch.object(wu, "get_dpi_scale", return_value=1.0), \
             mock.patch.object(wu, "get_wecom_rect", return_value=(0, 0, 1000, 800)), \
             mock.patch.object(wu, "find_wecom_search_tab_wnd", return_value=None), \
             mock.patch("sender_py.sender.ensure_roi", return_value=roi), \
             mock.patch("sender_py.sender._capture_title_crop", return_value=None), \
             mock.patch("sender_py.sender.search_and_enter", return_value=False) as mock_search_b, \
             mock.patch("sender_py.sender.judge_candidate") as mock_judge_b, \
             mock.patch("sender_py.sender.time.sleep", return_value=None):
            res_b = send_student(item, "http://localhost:8000", log=logs_b.append)
        self.assertEqual(res_b["result"], "unmatched")
        self.assertEqual(mock_search_b.call_count, 6)
        mock_judge_b.assert_not_called()

    def test_send_student_title_unchanged_triggers_slow_retry(self):
        """回车后标题栏画面与搜索前一致时，轮询等待并在仍未切换时放慢重搜一次。"""
        item = {
            "sid": "65405",
            "sname": "胡耔墨",
            "studentName": "65405胡耔墨",
            "message": "测试反馈话术内容",
        }
        roi = {"title": [0.3, 0.02, 0.6, 0.08], "chat": [0.3, 0.1, 0.9, 0.8]}
        dummy_prev = object()
        dummy_cur = object()

        # 轮询 4 次均视觉一致 -> 触发慢速重搜 search_wait=2.2, enter_wait=1.5
        logs = []
        with mock.patch.object(wu, "find_and_activate_wecom", return_value=True), \
             mock.patch.object(wu, "ensure_fully_visible", return_value=(True, (0, 0, 1000, 800))), \
             mock.patch.object(wu, "get_dpi_scale", return_value=1.0), \
             mock.patch.object(wu, "get_wecom_rect", return_value=(0, 0, 1000, 800)), \
             mock.patch.object(wu, "find_wecom_search_tab_wnd", return_value=None), \
             mock.patch("sender_py.sender.ensure_roi", return_value=roi), \
             mock.patch("sender_py.sender._capture_title_crop", side_effect=[dummy_prev, dummy_cur, dummy_cur, dummy_cur, dummy_cur]), \
             mock.patch("sender_py.sender._images_visually_same", return_value=True), \
             mock.patch("sender_py.sender.search_and_enter", return_value=True) as mock_search, \
             mock.patch("sender_py.sender.judge_candidate", return_value=(
                 {"matched": True, "is_group": False, "needs_reply": False, "detected_title": "65405胡耔墨"},
                 "65405胡耔墨",
                 None,
             )), \
             mock.patch("sender_py.sender.paste_and_send", return_value=(True, "已发送")), \
             mock.patch("sender_py.sender.time.sleep", return_value=None):
            res = send_student(item, "http://localhost:8000", log=logs.append)
        self.assertEqual(res["result"], "sent")
        self.assertEqual(mock_search.call_count, 2)
        self.assertEqual(mock_search.call_args_list[1].kwargs, {"search_wait": 2.2, "enter_wait": 1.5})
        self.assertTrue(any("疑似尚未切入目标会话" in l for l in logs))

        # 轮询第 2 次标题栏发生变化 -> 不触发重搜
        with mock.patch.object(wu, "find_and_activate_wecom", return_value=True), \
             mock.patch.object(wu, "ensure_fully_visible", return_value=(True, (0, 0, 1000, 800))), \
             mock.patch.object(wu, "get_dpi_scale", return_value=1.0), \
             mock.patch.object(wu, "get_wecom_rect", return_value=(0, 0, 1000, 800)), \
             mock.patch.object(wu, "find_wecom_search_tab_wnd", return_value=None), \
             mock.patch("sender_py.sender.ensure_roi", return_value=roi), \
             mock.patch("sender_py.sender._capture_title_crop", side_effect=[dummy_prev, dummy_cur, dummy_cur]), \
             mock.patch("sender_py.sender._images_visually_same", side_effect=[True, False]), \
             mock.patch("sender_py.sender.search_and_enter", return_value=True) as mock_search_fast, \
             mock.patch("sender_py.sender.judge_candidate", return_value=(
                 {"matched": True, "is_group": False, "needs_reply": False, "detected_title": "65405胡耔墨"},
                 "65405胡耔墨",
                 None,
             )), \
             mock.patch("sender_py.sender.paste_and_send", return_value=(True, "已发送")), \
             mock.patch("sender_py.sender.time.sleep", return_value=None):
            res2 = send_student(item, "http://localhost:8000", log=[].append)
        self.assertEqual(res2["result"], "sent")
        self.assertEqual(mock_search_fast.call_count, 1)

    def test_search_and_enter_interrupts_on_should_stop(self):
        """搜索等待期间收到停止信号时应立即中止，不再发送 Enter。"""
        stop_flag = {"val": False}
        pressed_keys = []

        def fake_tap_keys(*vks):
            # 在 Ctrl+V 粘贴后模拟用户触发停止
            if wu.VK_V in vks:
                stop_flag["val"] = True
            return True

        with mock.patch.object(wu, "find_and_activate_wecom", return_value=True), \
             mock.patch.object(wu, "tap_keys", side_effect=fake_tap_keys), \
             mock.patch.object(wu, "tap_key", side_effect=lambda vk: pressed_keys.append(vk) or True), \
             mock.patch.object(wu, "is_foreground_wecom", return_value=True), \
             mock.patch("sender_py.sender.safe_copy", return_value=True), \
             mock.patch("sender_py.sender.time.sleep", return_value=None):
            entered = search_and_enter(
                "55165朴奕欣", 1,
                search_wait=1.5,
                should_stop=lambda: stop_flag["val"],
            )
        self.assertFalse(entered)
        self.assertNotIn(wu.VK_RETURN, pressed_keys)

    def test_judge_candidate_local_ocr_fast_pass_label(self):
        """auto 模式下本地 OCR 首发命中不调用云端 API，且日志区分极速核验与 API 异常降级。"""
        from sender_py import capture, vision_api
        from sender_py.local_ocr import set_ocr_hook_for_testing

        class _StubImg:
            def __init__(self, w=400, h=300):
                self.size = (w, h)

            def crop(self, box):
                return _StubImg(100, 50)

        roi = {"title": (0.2, 0.0, 0.8, 0.1), "input": (0.2, 0.8, 0.8, 0.2), "chat": (0.2, 0.1, 0.8, 0.7)}
        item = {"sid": "35882", "sname": "胡诚洋", "studentName": "35882胡诚洋", "message": "测试"}
        logs = []
        set_ocr_hook_for_testing(lambda img: "35882胡诚洋")
        try:
            with mock.patch.object(wu, "find_and_activate_wecom", return_value=True), \
                 mock.patch.object(wu, "ensure_fully_visible", return_value=(True, (0, 0, 400, 300))), \
                 mock.patch.object(wu, "get_dpi_scale", return_value=1.0), \
                 mock.patch.object(wu, "get_wecom_rect", return_value=(0, 0, 400, 300)), \
                 mock.patch.object(wu, "find_wecom_search_tab_wnd", return_value=None), \
                 mock.patch("sender_py.sender.ensure_roi", return_value=roi), \
                 mock.patch("sender_py.sender._capture_title_crop", return_value=None), \
                 mock.patch("sender_py.sender.search_and_enter", return_value=True), \
                 mock.patch.object(capture, "capture_wecom_window", return_value=_StubImg()), \
                 mock.patch.object(vision_api, "identify_title") as mock_api, \
                 mock.patch("sender_py.sender.paste_and_send", return_value=(True, "已发送")), \
                 mock.patch("sender_py.sender.time.sleep", return_value=None):
                res = send_student(item, "https://mock.server", log=logs.append, reply_analyzer=mock.MagicMock())
        finally:
            set_ocr_hook_for_testing(None)

        mock_api.assert_not_called()
        self.assertEqual(res["result"], "sent")
        log_text = "\n".join(logs)
        self.assertIn("采用本地 OCR 极速核验", log_text)
        self.assertNotIn("采用本地 OCR 备用通道核验", log_text)

    def test_send_student_sidebar_detection_stops_before_sending(self):
        """开启 check_sidebar=True 时，首个私聊命中后若大模型检测到右侧边栏，应阻止发送并提示关闭。"""
        item = {"sid": "55650", "sname": "徐思琪", "studentName": "55650徐思琪", "message": "反馈话术"}
        roi = {"title": [0.2, 0.0, 0.8, 0.1], "input": [0.2, 0.8, 0.8, 0.2], "chat": [0.2, 0.1, 0.8, 0.7]}
        logs = []

        # 1. 检测到侧边栏 -> 立即停止，不调用 paste_and_send，不投递 reply_analyzer
        fake_analyzer = mock.MagicMock()
        with mock.patch.object(wu, "find_and_activate_wecom", return_value=True), \
             mock.patch.object(wu, "ensure_fully_visible", return_value=(True, (0, 0, 1000, 700))), \
             mock.patch.object(wu, "get_dpi_scale", return_value=1.0), \
             mock.patch.object(wu, "get_wecom_rect", return_value=(0, 0, 1000, 700)), \
             mock.patch.object(wu, "find_wecom_search_tab_wnd", return_value=None), \
             mock.patch("sender_py.sender.ensure_roi", return_value=roi), \
             mock.patch("sender_py.sender._capture_title_crop", return_value=None), \
             mock.patch("sender_py.sender.search_and_enter", return_value=True), \
             mock.patch("sender_py.sender.judge_candidate", return_value=(
                 {"matched": True, "is_group": False, "detected_title": "55650徐思琪"},
                 "55650徐思琪", None, object(),
             )), \
             mock.patch("sender_py.sender.check_wecom_sidebar", return_value={
                 "checked": True, "has_sidebar": True, "sidebar_title": "学员详情", "reason": "右侧展开学员详情",
             }) as mock_sb, \
             mock.patch("sender_py.sender.paste_and_send") as mock_paste, \
             mock.patch("sender_py.sender.time.sleep", return_value=None):
            res = send_student(
                item, "https://mock.server", log=logs.append,
                reply_analyzer=fake_analyzer, check_sidebar=True,
            )

        self.assertEqual(res["result"], "sidebar_open")
        self.assertTrue(res["sidebar_checked"])
        self.assertIn("关闭企微右侧边栏", res["reason"])
        mock_sb.assert_called_once()
        mock_paste.assert_not_called()
        fake_analyzer.submit.assert_not_called()

        # 2. 群聊拦截时不触发侧边栏检测，sidebar_checked=False 留给下一个真实私聊学生
        with mock.patch.object(wu, "find_and_activate_wecom", return_value=True), \
             mock.patch.object(wu, "ensure_fully_visible", return_value=(True, (0, 0, 1000, 700))), \
             mock.patch.object(wu, "get_dpi_scale", return_value=1.0), \
             mock.patch.object(wu, "get_wecom_rect", return_value=(0, 0, 1000, 700)), \
             mock.patch.object(wu, "find_wecom_search_tab_wnd", return_value=None), \
             mock.patch("sender_py.sender.ensure_roi", return_value=roi), \
             mock.patch("sender_py.sender._capture_title_crop", return_value=None), \
             mock.patch("sender_py.sender.search_and_enter", return_value=True), \
             mock.patch("sender_py.sender.judge_candidate", return_value=(
                 {"matched": False, "is_group": True, "detected_title": "初二数学群(45)"},
                 "初二数学群(45)", None,
             )), \
             mock.patch("sender_py.sender.check_wecom_sidebar") as mock_sb_grp, \
             mock.patch("sender_py.sender.time.sleep", return_value=None):
            res_grp = send_student(item, "https://mock.server", log=[].append, check_sidebar=True)

        self.assertEqual(res_grp["result"], "blocked")
        self.assertFalse(res_grp["sidebar_checked"])
        mock_sb_grp.assert_not_called()

        # 3. 侧边栏检测异常时 fail-open 放行，不阻断发送
        from sender_py import capture, vision_api
        with mock.patch.object(wu, "find_and_activate_wecom", return_value=True), \
             mock.patch.object(wu, "ensure_fully_visible", return_value=(True, (0, 0, 1000, 700))), \
             mock.patch.object(wu, "get_dpi_scale", return_value=1.0), \
             mock.patch.object(wu, "get_wecom_rect", return_value=(0, 0, 1000, 700)), \
             mock.patch.object(wu, "find_wecom_search_tab_wnd", return_value=None), \
             mock.patch("sender_py.sender.ensure_roi", return_value=roi), \
             mock.patch("sender_py.sender._capture_title_crop", return_value=None), \
             mock.patch("sender_py.sender.search_and_enter", return_value=True), \
             mock.patch("sender_py.sender.judge_candidate", return_value=(
                 {"matched": True, "is_group": False, "detected_title": "55650徐思琪"},
                 "55650徐思琪", None,
             )), \
             mock.patch.object(capture, "capture_wecom_window", return_value=object()), \
             mock.patch.object(vision_api, "detect_sidebar", side_effect=RuntimeError("network timeout")), \
             mock.patch("sender_py.sender.paste_and_send", return_value=(True, "已发送")) as mock_paste_ok, \
             mock.patch("sender_py.sender.time.sleep", return_value=None):
            res_ok = send_student(item, "https://mock.server", log=[].append, check_sidebar=True)

        self.assertEqual(res_ok["result"], "sent")
        self.assertTrue(res_ok["sidebar_checked"])
        mock_paste_ok.assert_called_once()

    def test_ensure_roi_never_hits_disk_cache_and_uses_session_cache_only(self):
        """关闭本地 roi_config.json 持久化缓存命中：即使磁盘已有同签名缓存，新批次仍须重新校准；同一会话缓存内可复用。"""
        import os
        import tempfile
        from sender_py import capture, roi_manager, vision_api

        stale_roi = {"title": [0.9, 0.0, 0.1, 0.1], "input": [0.9, 0.8, 0.1, 0.2], "chat": [0.9, 0.1, 0.1, 0.7]}
        fresh_ai_roi = {"title": [0.3, 0.0, 0.5, 0.1], "input": [0.3, 0.7, 0.5, 0.3], "chat": [0.3, 0.1, 0.5, 0.6], "reason": "ok"}

        with tempfile.TemporaryDirectory() as td:
            cfg_path = os.path.join(td, "roi_config.json")
            roi_manager.save_roi(cfg_path, "1232x812@1.000", stale_roi["title"], stale_roi["input"], stale_roi["chat"])

            batch1_cache = {}
            with mock.patch.object(wu, "find_and_activate_wecom", return_value=True), \
                 mock.patch.object(wu, "restore_and_center_wecom", return_value=(True, (0, 0, 1232, 812))), \
                 mock.patch.object(wu, "get_wecom_rect", return_value=(0, 0, 1232, 812)), \
                 mock.patch.object(wu, "get_dpi_scale", return_value=1.0), \
                 mock.patch("sender_py.sender.open_sample_chat_for_calibration", return_value=True) as mock_open, \
                 mock.patch.object(capture, "capture_wecom_window", return_value=object()), \
                 mock.patch.object(vision_api, "calibrate_roi", return_value=fresh_ai_roi) as mock_cal, \
                 mock.patch("sender_py.sender.time.sleep", return_value=None):
                # 1. 新批次即使磁盘有同签名缓存，也绝不命中，必须重校准
                r1 = ensure_roi(
                    None, (0, 0, 1232, 812), 1.0, cfg_path,
                    server="https://mock.server", log=[].append,
                    sample_name="90001张三", session_cache=batch1_cache,
                )
                self.assertEqual(r1["title"], tuple(fresh_ai_roi["title"]))
                self.assertEqual(mock_open.call_count, 1)
                self.assertEqual(mock_cal.call_count, 1)

                # 2. 同一批次内同签名可复用 session_cache
                r2 = ensure_roi(
                    None, (0, 0, 1232, 812), 1.0, cfg_path,
                    server="https://mock.server", log=[].append,
                    sample_name="80001李四", session_cache=batch1_cache,
                )
                self.assertEqual(r2["title"], tuple(fresh_ai_roi["title"]))
                self.assertEqual(mock_open.call_count, 1)
                self.assertEqual(mock_cal.call_count, 1)

                # 3. 下一批次换新 session_cache 时再次重新校准，不命中上一批次结果
                batch2_cache = {}
                r3 = ensure_roi(
                    None, (0, 0, 1232, 812), 1.0, cfg_path,
                    server="https://mock.server", log=[].append,
                    sample_name="90001张三", session_cache=batch2_cache,
                )
                self.assertEqual(r3["title"], tuple(fresh_ai_roi["title"]))
                self.assertEqual(mock_open.call_count, 2)
                self.assertEqual(mock_cal.call_count, 2)

    def test_send_student_recalibrates_roi_when_window_resizes_after_search(self):
        """进入会话后若企微窗口尺寸变化（例如弹出侧边栏撑宽窗口），须按新尺寸重校 ROI 后再核验，从而正常触发侧边栏检测。"""
        item = {"sid": "90001", "sname": "张三", "studentName": "90001张三", "message": "反馈话术"}
        roi_narrow = {"title": (0.304, 0.0, 0.696, 0.097), "input": (0.304, 0.71, 0.696, 0.29), "chat": (0.304, 0.097, 0.696, 0.613)}
        roi_wide = {"title": (0.225, 0.0, 0.505, 0.09), "input": (0.225, 0.7, 0.505, 0.28), "chat": (0.225, 0.09, 0.505, 0.61)}
        logs = []

        # ensure_fully_visible 返回 1232x812；进入会话后 get_wecom_rect 变为 1683x812（侧边栏撑宽）
        rect_seq = [
            (694, 314, 1232, 812),  # ensure_roi 后刷新
            (694, 314, 1683, 812),  # search_and_enter 后截图前检测尺寸变化
            (694, 314, 1683, 812),  # 重校 ROI 后再次刷新
        ]

        with mock.patch.object(wu, "find_and_activate_wecom", return_value=True), \
             mock.patch.object(wu, "ensure_fully_visible", return_value=(True, (694, 314, 1232, 812))), \
             mock.patch.object(wu, "get_dpi_scale", return_value=1.0), \
             mock.patch.object(wu, "get_wecom_rect", side_effect=rect_seq), \
             mock.patch.object(wu, "find_wecom_search_tab_wnd", return_value=None), \
             mock.patch("sender_py.sender.ensure_roi", side_effect=[roi_narrow, roi_wide]) as mock_roi, \
             mock.patch("sender_py.sender._capture_title_crop", return_value=None), \
             mock.patch("sender_py.sender.search_and_enter", return_value=True), \
             mock.patch("sender_py.sender.judge_candidate", return_value=(
                 {"matched": True, "is_group": False, "detected_title": "90001张三"},
                 "90001张三", None,
             )) as mock_judge, \
             mock.patch("sender_py.sender.check_wecom_sidebar", return_value={
                 "checked": True, "has_sidebar": True, "sidebar_title": "学员详情", "reason": "右侧展开学员详情",
             }) as mock_sb, \
             mock.patch("sender_py.sender.time.sleep", return_value=None):
            res = send_student(
                item, "https://mock.server", log=logs.append, check_sidebar=True, roi_cache={},
            )

        self.assertEqual(mock_roi.call_count, 2)
        self.assertFalse(mock_roi.call_args_list[0].kwargs.get("skip_sample_chat", False))
        self.assertTrue(mock_roi.call_args_list[1].kwargs.get("skip_sample_chat", False))
        self.assertEqual(mock_judge.call_args.args[0], (694, 314, 1683, 812))
        self.assertEqual(mock_judge.call_args.args[1], roi_wide)
        self.assertEqual(res["result"], "sidebar_open")
        mock_sb.assert_called_once()

    def test_archive_key_week_hash_and_history_message_check(self):
        """测试同名文件跨周/不同话术内容时生成不同归档键，且 HistoryManager.is_sent 支持比对消息正文。"""
        k_default = archive_key_for_input("高一物理班.json")
        self.assertEqual(k_default, "高一物理班 [第 1 周]")

        k_week3_file = archive_key_for_input("高一物理班_第3周反馈.json")
        self.assertEqual(k_week3_file, "高一物理班_第3周反馈 [第 3 周]")

        items_w1 = [{"studentName": "90001张三", "message": "本周（第1周）表现优秀，作业满分！"}]
        items_w2 = [{"studentName": "90001张三", "message": "本周（第2周）表现良好，第3题需巩固。"}]
        k1 = archive_key_for_input("反馈话术.json", items_w1)
        k2 = archive_key_for_input("反馈话术.json", items_w2)
        self.assertIn("[第 1 周 #", k1)
        self.assertIn("[第 2 周 #", k2)
        self.assertNotEqual(k1, k2)

        with tempfile.TemporaryDirectory() as d:
            hm = HistoryManager(storage_path=os.path.join(d, "history.json"))
            hm.mark_status("反馈话术 [第 1 周]", "90001张三", "✅已发送", "第一周话术")
            self.assertTrue(hm.is_sent("反馈话术 [第 1 周]", "90001张三"))
            self.assertTrue(hm.is_sent("反馈话术 [第 1 周]", "90001张三", "第一周话术"))
            self.assertFalse(hm.is_sent("反馈话术 [第 1 周]", "90001张三", "第二周新话术"))

    def test_paste_and_send_clears_draft_and_checks_focus(self):
        """测试 paste_and_send 在粘贴前清空残余草稿，并在失焦时中止发送。"""
        from sender_py.sender import paste_and_send

        events = []
        with mock.patch("sender_py.sender.safe_copy", return_value=True), \
             mock.patch.object(wu, "is_foreground_wecom", return_value=True), \
             mock.patch.object(wu, "tap_keys", side_effect=lambda *ks: events.append(("keys", ks)) or True), \
             mock.patch.object(wu, "tap_key", side_effect=lambda k: events.append(("key", k)) or True), \
             mock.patch("sender_py.sender.time.sleep", return_value=None):
            ok, msg = paste_and_send("测试话术")
        self.assertTrue(ok)
        self.assertEqual(msg, "已发送")
        # 顺序必须是：Ctrl+A -> Backspace -> Ctrl+V -> Enter
        self.assertEqual(events, [
            ("keys", (wu.VK_CONTROL, wu.VK_A)),
            ("key", 0x08),
            ("keys", (wu.VK_CONTROL, wu.VK_V)),
            ("key", wu.VK_RETURN),
        ])

        # 若粘贴后失焦且重激活失败，绝不按 Enter
        events_unfocused = []
        with mock.patch("sender_py.sender.safe_copy", return_value=True), \
             mock.patch.object(wu, "is_foreground_wecom", side_effect=[True, False]), \
             mock.patch.object(wu, "find_and_activate_wecom", return_value=False), \
             mock.patch.object(wu, "tap_keys", side_effect=lambda *ks: events_unfocused.append(("keys", ks)) or True), \
             mock.patch.object(wu, "tap_key", side_effect=lambda k: events_unfocused.append(("key", k)) or True), \
             mock.patch("sender_py.sender.time.sleep", return_value=None):
            ok2, msg2 = paste_and_send("测试话术")
        self.assertFalse(ok2)
        self.assertIn("失去前台焦点", msg2)
        self.assertNotIn(("key", wu.VK_RETURN), events_unfocused)


if __name__ == "__main__":
    unittest.main()
