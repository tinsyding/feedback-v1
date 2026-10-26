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
    run_candidate_outcomes, search_and_enter, status_matches_filter,
    summarize_status_counts,
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


if __name__ == "__main__":
    unittest.main()
