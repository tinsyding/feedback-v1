"""Web 版控制器与本地 HTTP 服务单元测试。"""

import json
import os
import tempfile
import threading
import time
import unittest
from unittest import mock
import urllib.request

from sender_py.store import SentFilesManager
from sender_py.web_controller import WebController
from sender_py.web_main import find_free_port, run_smoke_test
from sender_py.web_server import ThreadingFeedbackServer, get_web_ui_html_path


class TestWebEdition(unittest.TestCase):
    def test_web_ui_html_exists(self):
        path = get_web_ui_html_path()
        self.assertTrue(bool(path))
        self.assertTrue(os.path.isfile(path))
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
        self.assertIn("极方每周反馈程序", content)
        self.assertIn("/api/state", content)
        self.assertNotIn("请勿将企业微信窗口拖出屏幕边缘", content)
        self.assertNotIn("cloudPolicyBadge", content)
        self.assertNotIn("纯本地OCR", content)
        self.assertIn("sidebarAlertModal", content)

    def test_find_free_port(self):
        port = find_free_port(18765)
        self.assertGreater(port, 1024)

    def test_controller_state_and_files(self):
        with tempfile.TemporaryDirectory() as td:
            ctrl = WebController()
            ctrl.sent_files = SentFilesManager(base_dir=td)
            state = ctrl.get_state()
            self.assertFalse(state["running"])
            self.assertEqual(len(state["students"]), 0)
            self.assertEqual(len(state["files"]), 0)

            # 创建测试 JSON 文件
            f1 = os.path.join(td, "test_1.json")
            with open(f1, "w", encoding="utf-8") as fp:
                json.dump([
                    {"sid": "90001", "sname": "张三", "studentName": "90001张三", "message": "评语1"},
                    {"sid": "90002", "sname": "李四", "studentName": "90002李四", "message": "评语2"},
                ], fp, ensure_ascii=False)

            # 1. 添加文件
            res = ctrl.add_input_files([f1])
            self.assertTrue(res["success"])
            self.assertEqual(res["count"], 2)

            state = ctrl.get_state()
            self.assertEqual(len(state["students"]), 2)
            self.assertEqual(len(state["files"]), 1)

            # 2. 勾选切换
            ctrl.set_selection("none")
            state = ctrl.get_state()
            self.assertEqual(state["summary"]["selected"], 0)

            ctrl.set_selection("all")
            state = ctrl.get_state()
            self.assertEqual(state["summary"]["selected"], 2)

            first_id = state["students"][0]["id"]
            second_id = state["students"][1]["id"]
            ctrl.set_selection("toggle_specific", [first_id])
            state = ctrl.get_state()
            self.assertEqual(state["summary"]["selected"], 1)

            # 测试 select_ids, deselect_ids, invert
            ctrl.set_selection("deselect_ids", [second_id])
            state = ctrl.get_state()
            self.assertEqual(state["summary"]["selected"], 0)

            ctrl.set_selection("select_ids", [first_id, second_id])
            state = ctrl.get_state()
            self.assertEqual(state["summary"]["selected"], 2)

            ctrl.set_selection("invert")
            state = ctrl.get_state()
            self.assertEqual(state["summary"]["selected"], 0)

            # 测试已发文件管理与 list_records 兼容性
            entry = ctrl.sent_files.record_sent_file(f1, ctrl.items)
            self.assertIn("file_name", entry)
            self.assertEqual(len(ctrl.sent_files.list_records()), 1)
            self.assertEqual(len(ctrl.sent_files.get_records()), 1)

            # 3. 日志与 SSE 队列
            q = ctrl.add_listener()
            ctrl.emit("测试日志一行")
            self.assertEqual(len(ctrl.get_logs()), 2)  # add_input_files 中有一行，加这行共2行
            event = q.get_nowait()
            self.assertEqual(event["type"], "log")
            self.assertIn("测试日志一行", event["line"])
            ctrl.remove_listener(q)

            # 4. 移除文件与清空
            ctrl.remove_input_file(f1)
            self.assertEqual(len(ctrl.items), 0)

    def test_http_server_endpoints(self):
        with tempfile.TemporaryDirectory() as td:
            ctrl = WebController()
            ctrl.sent_files = SentFilesManager(base_dir=td)
            port = find_free_port(19800)
            server = ThreadingFeedbackServer(("127.0.0.1", port), ctrl)
            t = threading.Thread(target=server.serve_forever, daemon=True)
            t.start()
            time.sleep(0.3)

            base_url = f"http://127.0.0.1:{port}"

            try:
                # 1. GET /
                with urllib.request.urlopen(f"{base_url}/") as resp:
                    self.assertEqual(resp.status, 200)
                    html = resp.read().decode("utf-8")
                    self.assertIn("极方每周反馈程序", html)

                # 2. GET /api/state
                with urllib.request.urlopen(f"{base_url}/api/state") as resp:
                    self.assertEqual(resp.status, 200)
                    data = json.loads(resp.read().decode("utf-8"))
                    self.assertEqual(data["running"], False)

                # 3. POST /api/upload (JSON 方式)
                upload_payload = json.dumps({
                    "files": [
                        {
                            "name": "mock.json",
                            "content": json.dumps([
                                {"sid": "90003", "sname": "王五", "studentName": "90003王五", "message": "评语3"}
                            ], ensure_ascii=False)
                        }
                    ]
                }).encode("utf-8")
                req = urllib.request.Request(f"{base_url}/api/upload", data=upload_payload, headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req) as resp:
                    self.assertEqual(resp.status, 200)
                    data = json.loads(resp.read().decode("utf-8"))
                    self.assertTrue(data["success"])
                    self.assertEqual(data["count"], 1)

                # 4. POST /api/students/toggle
                toggle_payload = json.dumps({"action": "none"}).encode("utf-8")
                req = urllib.request.Request(f"{base_url}/api/students/toggle", data=toggle_payload, headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req) as resp:
                    self.assertEqual(resp.status, 200)

                # 验证状态
                with urllib.request.urlopen(f"{base_url}/api/state") as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    self.assertEqual(data["summary"]["selected"], 0)

                # 5. GET /api/logs
                with urllib.request.urlopen(f"{base_url}/api/logs?since=0") as resp:
                    self.assertEqual(resp.status, 200)
                    data = json.loads(resp.read().decode("utf-8"))
                    self.assertIsInstance(data.get("logs"), list)

                # 6. POST /api/stop
                req = urllib.request.Request(f"{base_url}/api/stop", data=b"{}", headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req) as resp:
                    self.assertEqual(resp.status, 200)

                # 7. GET /api/sent_files 与 /api/sent_files/view
                # 先记录一个模拟已发文件
                ctrl.sent_files.record_sent_file("测试已发.json", [
                    {"sid": "90001", "studentName": "张三", "status": "已发送", "message": "好评"}
                ])
                with urllib.request.urlopen(f"{base_url}/api/sent_files") as resp:
                    self.assertEqual(resp.status, 200)
                    data = json.loads(resp.read().decode("utf-8"))
                    self.assertIsInstance(data.get("records"), list)
                    self.assertEqual(len(data["records"]), 1)
                    self.assertEqual(data["records"][0]["file_name"], "测试已发.json")

                with urllib.request.urlopen(f"{base_url}/api/sent_files/view?index=0") as resp:
                    self.assertEqual(resp.status, 200)
                    html_report = resp.read().decode("utf-8")
                    self.assertIn("极方反馈发送记录", html_report)
                    self.assertIn("张三", html_report)

                # 8. POST /api/sent_files/open_folder
                with unittest.mock.patch("sender_py.store.open_folder_or_file", return_value=True):
                    req = urllib.request.Request(f"{base_url}/api/sent_files/open_folder", data=b"{}", headers={"Content-Type": "application/json"})
                    with urllib.request.urlopen(req) as resp:
                        self.assertEqual(resp.status, 200)
                        data = json.loads(resp.read().decode("utf-8"))
                        self.assertEqual(data.get("success"), True)

                # 8.5 POST /api/wecom/center (测试企业微信居中接口)
                with unittest.mock.patch("sender_py.window_utils.restore_and_center_wecom", return_value=(True, (100, 100, 960, 640))):
                    req = urllib.request.Request(f"{base_url}/api/wecom/center", data=b"{}", headers={"Content-Type": "application/json"})
                    with urllib.request.urlopen(req) as resp:
                        self.assertEqual(resp.status, 200)
                        data = json.loads(resp.read().decode("utf-8"))
                        self.assertEqual(data.get("success"), True)
                        self.assertEqual(data.get("rect"), [100, 100, 960, 640])

                # 8.6 GET /api/debug/latest 与 GET /api/debug/image 与 POST /api/debug/open_folder
                with tempfile.TemporaryDirectory() as td:
                    with unittest.mock.patch("sender_py.debug_utils.get_debug_dir", return_value=td):
                        # 初始无数据
                        with urllib.request.urlopen(f"{base_url}/api/debug/latest") as resp:
                            self.assertEqual(resp.status, 200)
                            data = json.loads(resp.read().decode("utf-8"))
                            self.assertFalse(data.get("available"))

                        # 写入模拟现场截图和元数据
                        test_img_path = os.path.join(td, "latest_title.png")
                        with open(test_img_path, "wb") as f:
                            f.write(b"\x89PNG\r\n\x1a\nfakeimagebytes")
                        with open(os.path.join(td, "latest_meta.json"), "w", encoding="utf-8") as f:
                            json.dump({"target_id": "90001", "target_name": "张三"}, f)

                        with urllib.request.urlopen(f"{base_url}/api/debug/latest") as resp:
                            self.assertEqual(resp.status, 200)
                            data = json.loads(resp.read().decode("utf-8"))
                            self.assertTrue(data.get("available"))
                            self.assertEqual(data.get("meta", {}).get("target_id"), "90001")

                        # 测试 /api/debug/image
                        with urllib.request.urlopen(f"{base_url}/api/debug/image?name=latest_title.png") as resp:
                            self.assertEqual(resp.status, 200)
                            self.assertEqual(resp.headers.get("Content-Type"), "image/png")
                            self.assertEqual(resp.read(), b"\x89PNG\r\n\x1a\nfakeimagebytes")

                        # 测试不存在的文件返回 404
                        try:
                            urllib.request.urlopen(f"{base_url}/api/debug/image?name=notfound.png")
                            self.fail("Should have raised HTTPError 404")
                        except urllib.error.HTTPError as exc:
                            self.assertEqual(exc.code, 404)

                        # 测试 /api/debug/list 与按 prefix 查询
                        with open(os.path.join(td, "20261028_120000_90001_张三_cand1_meta.json"), "w", encoding="utf-8") as f:
                            json.dump({
                                "timestamp": "20261028_120000",
                                "target_id": "90001",
                                "target_name": "张三",
                                "candidate": 1,
                                "diag_info": {"judgment": {"matched": True, "reason": "成功"}}
                            }, f)

                        with urllib.request.urlopen(f"{base_url}/api/debug/list") as resp:
                            self.assertEqual(resp.status, 200)
                            data = json.loads(resp.read().decode("utf-8"))
                            self.assertIn("snapshots", data)
                            self.assertEqual(len(data["snapshots"]), 1)
                            self.assertEqual(data["snapshots"][0]["target_id"], "90001")

                        quoted_prefix = urllib.parse.quote("20261028_120000_90001_张三_cand1")
                        with urllib.request.urlopen(f"{base_url}/api/debug/latest?prefix={quoted_prefix}") as resp:
                            self.assertEqual(resp.status, 200)
                            data = json.loads(resp.read().decode("utf-8"))
                            self.assertTrue(data.get("available"))
                            self.assertEqual(data.get("prefix"), "20261028_120000_90001_张三_cand1")

                        # 测试 /api/debug/open_folder
                        with unittest.mock.patch("sender_py.store.open_folder_or_file", return_value=True):
                            req = urllib.request.Request(f"{base_url}/api/debug/open_folder", data=b"{}", headers={"Content-Type": "application/json"})
                            with urllib.request.urlopen(req) as resp:
                                self.assertEqual(resp.status, 200)
                                d = json.loads(resp.read().decode("utf-8"))
                                self.assertTrue(d.get("success"))

                        # 测试 /api/logs/files 与 /api/logs/view
                        with urllib.request.urlopen(f"{base_url}/api/logs/files") as resp:
                            self.assertEqual(resp.status, 200)
                            d = json.loads(resp.read().decode("utf-8"))
                            self.assertIn("files", d)

                        with urllib.request.urlopen(f"{base_url}/api/logs/view?file=test.log") as resp:
                            self.assertEqual(resp.status, 200)
                            d = json.loads(resp.read().decode("utf-8"))
                            self.assertEqual(d.get("filename"), "test.log")

                        # 测试 /api/logs/open_folder
                        with unittest.mock.patch("sender_py.file_logger.open_logs_dir", return_value=True):
                            req = urllib.request.Request(f"{base_url}/api/logs/open_folder", data=b"{}", headers={"Content-Type": "application/json"})
                            with urllib.request.urlopen(req) as resp:
                                self.assertEqual(resp.status, 200)
                                d = json.loads(resp.read().decode("utf-8"))
                                self.assertTrue(d.get("success"))

            finally:
                server.shutdown()
                server.server_close()

    def test_smoke_test(self):
        ret = run_smoke_test()
        self.assertEqual(ret, 0)

    def test_web_controller_breakpoint_resume(self):
        ctrl = WebController()
        ctrl.items = [
            {"_id": "id1", "sid": "101", "studentName": "学生甲", "_status": "已发送", "_selected": True},
            {"_id": "id2", "sid": "102", "studentName": "学生乙", "_status": "待发送", "_selected": True},
        ]
        with unittest.mock.patch("threading.Thread") as mock_thread:
            res = ctrl.start_send()
            self.assertTrue(res["success"])
            self.assertEqual(res["selected_count"], 1)
            called_args = mock_thread.call_args[1]["args"]
            effective_ids = called_args[0]
            self.assertIn("id2", effective_ids)
            self.assertNotIn("id1", effective_ids)
            self.assertEqual(ctrl.items[0]["_status"], "已发送")

        # 测试中断后恢复断点
        ctrl._finish_run(stopped=True, selected_ids={"id2"})
        self.assertEqual(ctrl.items[1]["_status"], "待发送")
        self.assertEqual(ctrl.items[1]["_last_reason"], "已暂停，可继续发送")
        self.assertTrue(ctrl.items[1]["_selected"])

    def test_save_uploaded_file_preserves_filename(self):
        ctrl = WebController()
        with tempfile.TemporaryDirectory() as td:
            with unittest.mock.patch.object(ctrl, "get_upload_dir", return_value=td):
                p1 = ctrl.save_uploaded_file("一班反馈.json", b"content1")
                self.assertEqual(os.path.basename(p1), "一班反馈.json")
                # 再次上传同名文件，不追加时间戳数字
                p2 = ctrl.save_uploaded_file("一班反馈.json", b"content2")
                self.assertEqual(os.path.basename(p2), "一班反馈.json")
                self.assertEqual(p1, p2)

    def test_reply_notes_actionable_only(self):
        ctrl = WebController()
        # 1. 明确无需回 (needs_reply=False) -> 不应出现在待回名单
        ctrl.reply_notes.append({
            "student": "90001张三",
            "chat_title": "90001张三",
            "last_message": "收到谢谢",
            "needs_reply": False,
            "verdict": "无需回",
        })
        # 2. 需回 (needs_reply=True) -> 应该出现
        ctrl.reply_notes.append({
            "student": "90002李四",
            "chat_title": "90002李四",
            "last_message": "老师下周几上课？",
            "needs_reply": True,
            "verdict": "需回",
        })
        # 3. 异常待确认 (needs_reply=None) -> 应该出现
        ctrl.reply_notes.append({
            "student": "90003王五",
            "chat_title": "90003王五",
            "last_message": "请问这个怎么做",
            "needs_reply": None,
            "verdict": "待人工确认",
        })

        state = ctrl.get_state()
        self.assertEqual(state["reply_notes_count"], 2)

    def test_launch_web_gui_companion_headless_fallback(self):
        """测试在无头/无图形环境（如 Linux WSL / CI）下，伴随窗启动安全回退返回 False。"""
        from sender_py.web_companion import launch_web_gui_companion
        ctrl = WebController()
        mock_server = unittest.mock.MagicMock()
        ok = launch_web_gui_companion(ctrl, mock_server, 8765, "http://127.0.0.1:8765")
        self.assertFalse(ok)

    def test_web_companion_window_interactions(self):
        """测试 WebCompanionWindow 伴随控制台的界面构建、状态轮询与联动退出逻辑。"""
        import sys
        mock_tk = unittest.mock.MagicMock()
        mock_ttk = unittest.mock.MagicMock()
        mock_mb = unittest.mock.MagicMock()
        mock_fd = unittest.mock.MagicMock()

        # 确保每个 Label / Button 拥有独立的 Mock 实例
        mock_tk.Label.side_effect = lambda *args, **kwargs: unittest.mock.MagicMock()
        mock_tk.Button.side_effect = lambda *args, **kwargs: unittest.mock.MagicMock()
        mock_tk.Frame.side_effect = lambda *args, **kwargs: unittest.mock.MagicMock()

        modules_patch = {
            "tkinter": mock_tk,
            "tkinter.ttk": mock_ttk,
            "tkinter.messagebox": mock_mb,
            "tkinter.filedialog": mock_fd,
        }

        with unittest.mock.patch.dict(sys.modules, modules_patch):
            from sender_py.web_companion import WebCompanionWindow

            ctrl = WebController()
            mock_server = unittest.mock.MagicMock()
            mock_root = unittest.mock.MagicMock()

            # 实例化伴随窗口
            win = WebCompanionWindow(ctrl, mock_server, 8765, "http://127.0.0.1:8765", root=mock_root)

            # 1. 验证窗口初始化与协议绑定
            mock_root.title.assert_called_with("极方每周反馈程序 (Web版) - 控制台")
            mock_root.protocol.assert_called_with("WM_DELETE_WINDOW", win.on_close)
            self.assertTrue(callable(ctrl.native_file_picker))

            # 2. 验证打开浏览器
            with unittest.mock.patch("webbrowser.open") as mock_open:
                win.open_browser()
                mock_open.assert_called_once_with("http://127.0.0.1:8765")

            # 3. 验证停止发送
            with unittest.mock.patch.object(ctrl, "stop_send") as mock_stop:
                win.stop_send()
                mock_stop.assert_called_once()

            # 4. 验证状态更新展示
            win._update_status_display()
            self.assertEqual(win.status_badge.config.call_args[1]["text"], "🟢 服务就绪")
            self.assertEqual(win.btn_stop.config.call_args[1]["state"], "disabled")

            # 模拟正在发送状态
            ctrl.is_running = True
            with unittest.mock.patch.object(ctrl, "get_state", return_value={"running": True, "files": ["a.json"], "summary": {"total": 10, "selected": 5, "sent": 2, "failed": 0, "mismatch": 0, "skipped": 0}}):
                win._update_status_display()
                self.assertEqual(win.status_badge.config.call_args[1]["text"], "🟡 正在发送中...")
                self.assertEqual(win.btn_stop.config.call_args[1]["state"], "normal")

            # 5. 验证点击退出逻辑（发送中 vs 空闲）
            # 5.1 发送中用户取消退出
            mock_mb.askyesno.return_value = False
            win.on_close()
            mock_server.shutdown.assert_not_called()

            # 5.2 空闲时用户确认退出
            ctrl.is_running = False
            mock_mb.askyesno.return_value = True
            with unittest.mock.patch("os._exit") as mock_exit:
                win.on_close()
                mock_server.shutdown.assert_called_once()
                mock_server.server_close.assert_called_once()
                mock_root.destroy.assert_called_once()
                mock_exit.assert_called_once_with(0)

    def test_debug_snapshot_lifecycle(self):
        """测试核验现场截图存盘、清理与最新元数据获取逻辑。"""
        from sender_py.debug_utils import (
            save_candidate_snapshot,
            get_latest_debug_info,
            list_debug_snapshots,
            _cleanup_old_snapshots,
        )

        with tempfile.TemporaryDirectory() as td:
            with unittest.mock.patch("sender_py.debug_utils.get_debug_dir", return_value=td):
                # 模拟带 save() 方法的截屏对象
                class MockImg:
                    def __init__(self, tag):
                        self.tag = tag
                    def save(self, path, format="PNG"):
                        with open(path, "wb") as f:
                            f.write(f"img-{self.tag}".encode("utf-8"))

                mock_full = MockImg("full")
                mock_title = MockImg("title")
                roi = {"title": [0.1, 0.01, 0.5, 0.05], "input": [0.1, 0.7, 0.8, 0.2]}

                res = save_candidate_snapshot(
                    mock_full, roi, mock_title, "90001", "张三", cand=1,
                    diag_info={"reason": "测试核验"}
                )

                self.assertIsNotNone(res.get("title_path"))
                self.assertIsNotNone(res.get("full_path"))
                self.assertTrue(os.path.isfile(os.path.join(td, "latest_title.png")))
                self.assertTrue(os.path.isfile(os.path.join(td, "latest_meta.json")))

                info = get_latest_debug_info()
                self.assertTrue(info.get("available"))
                self.assertEqual(info.get("meta", {}).get("target_id"), "90001")
                self.assertIn("latest_title.png", info.get("title_url"))

                # 测试 list_debug_snapshots 与按 prefix 查询
                snaps = list_debug_snapshots()
                self.assertEqual(len(snaps), 1)
                self.assertEqual(snaps[0]["target_id"], "90001")
                prefix_info = get_latest_debug_info(snaps[0]["prefix"])
                self.assertTrue(prefix_info.get("available"))
                self.assertEqual(prefix_info.get("prefix"), snaps[0]["prefix"])

                # 测试自动清理逻辑：生成超过限制的文件
                for i in range(10):
                    p = os.path.join(td, f"dummy_{i:02d}.png")
                    with open(p, "w") as f:
                        f.write("test")
                    # 微小间隔使得 mtime 有先后
                    time.sleep(0.01)

                _cleanup_old_snapshots(td, max_files=5)
                remaining = [f for f in os.listdir(td) if not f.startswith("latest_")]
                self.assertLessEqual(len(remaining), 5)

    def test_finish_run_drains_reply_analyzer_and_formats_paused_summary(self):
        """结束收尾应先等待排空后台留言分析，并把暂停未发人数拆分为 跳过/待发。"""
        with tempfile.TemporaryDirectory() as td:
            ctrl = WebController()
            ctrl.sent_files = SentFilesManager(base_dir=td)
            ctrl.items = [
                {"_id": "1", "studentName": "A", "_status": "已发送", "_selected": False},
                {"_id": "2", "studentName": "B", "_status": "待发送", "_selected": True},
                {"_id": "3", "studentName": "C", "_status": "已跳过", "_selected": False},
            ]

            class FakeAnalyzer:
                def __init__(self, controller):
                    self.pending_count = 1
                    self._ctrl = controller
                    self._polled = 0

                def check_and_finish(self):
                    self._polled += 1
                    if self._polled >= 2 and self.pending_count > 0:
                        self._ctrl._reply_event_queue.put(("note", {
                            "student": "A",
                            "needs_reply": True,
                            "verdict": "需回复",
                            "last_message": "老师请问",
                        }, {}))
                        self.pending_count = 0

            fake_analyzer = FakeAnalyzer(ctrl)
            ctrl._reply_analyzer = fake_analyzer

            orig_drain = ctrl._drain_reply_events

            def _stepping_drain():
                fake_analyzer.check_and_finish()
                orig_drain()

            with mock.patch.object(ctrl, "_drain_reply_events", side_effect=_stepping_drain), \
                 mock.patch.object(ctrl, "_stop_esc_watcher"), \
                 mock.patch("sender_py.web_controller.sync_batch_summary"), \
                 mock.patch("sender_py.web_controller.flush_cloud_logs"):
                ctrl._finish_run(stopped=True, selected_ids={"1", "2"})

            self.assertEqual(len(ctrl.reply_notes), 1)
            self.assertEqual(ctrl.reply_notes[0]["student"], "A")
            logs_joined = "\n".join(ctrl.get_logs())
            self.assertIn("后台留言分析：需回复", logs_joined)
            self.assertIn("跳过 1，待发 1", logs_joined)

    def test_run_worker_stops_on_sidebar_open_and_checks_only_first_person(self):
        """打开第一个人若大模型检测到侧边栏则立刻停止并设置告警；未打开侧边栏时后续学员不再重复检测。"""
        with tempfile.TemporaryDirectory() as td:
            # 1. 检测到右侧边栏 -> 立即停止发送且不继续处理第 2 人
            ctrl = WebController()
            ctrl.sent_files = SentFilesManager(base_dir=td)
            ctrl.items = [
                {"_id": "1", "sid": "55650", "sname": "徐思琪", "studentName": "55650徐思琪", "message": "m1", "_status": "待发送", "_selected": True},
                {"_id": "2", "sid": "55651", "sname": "李四", "studentName": "55651李四", "message": "m2", "_status": "待发送", "_selected": True},
            ]
            with mock.patch("sender_py.web_controller.time.sleep", return_value=None), \
                 mock.patch("sender_py.window_utils.restore_and_center_wecom", return_value=(True, (0, 0, 960, 640))), \
                 mock.patch("sender_py.web_controller.send_student", return_value={
                     "result": "sidebar_open",
                     "reason": "检测到企业微信右侧边栏（「学员详情」）已打开，已停止发送。请先关闭企微右侧边栏后再继续发送。",
                     "sidebar_checked": True,
                     "notes": [],
                 }) as mock_send, \
                 mock.patch.object(ctrl, "_stop_esc_watcher"), \
                 mock.patch("sender_py.web_controller.sync_batch_summary"), \
                 mock.patch("sender_py.web_controller.flush_cloud_logs"):
                ctrl._run_worker({"1", "2"}, 2, 2)

            self.assertEqual(mock_send.call_count, 1)
            self.assertTrue(mock_send.call_args.kwargs["check_sidebar"])
            self.assertFalse(ctrl._running)
            self.assertEqual(ctrl.items[0]["_status"], "待发送")
            self.assertTrue(ctrl.items[0]["_selected"])
            self.assertIsNotNone(ctrl.progress.get("sidebar_alert"))
            self.assertIn("关闭企业微信右侧边栏", ctrl.progress["step_text"])

            # 2. 第 1 人未检测到侧边栏 -> 第 2 人应传 check_sidebar=False
            ctrl2 = WebController()
            ctrl2.sent_files = SentFilesManager(base_dir=td)
            ctrl2.items = [
                {"_id": "1", "sid": "55650", "sname": "徐思琪", "studentName": "55650徐思琪", "message": "m1", "_status": "待发送", "_selected": True},
                {"_id": "2", "sid": "55651", "sname": "李四", "studentName": "55651李四", "message": "m2", "_status": "待发送", "_selected": True},
            ]
            with mock.patch("sender_py.web_controller.time.sleep", return_value=None), \
                 mock.patch("sender_py.window_utils.restore_and_center_wecom", return_value=(True, (0, 0, 960, 640))), \
                 mock.patch("sender_py.web_controller.send_student", side_effect=[
                     {"result": "sent", "reason": "已发送", "sidebar_checked": True, "notes": []},
                     {"result": "sent", "reason": "已发送", "sidebar_checked": False, "notes": []},
                 ]) as mock_send2, \
                 mock.patch.object(ctrl2, "_stop_esc_watcher"), \
                 mock.patch("sender_py.web_controller.sync_batch_summary"), \
                 mock.patch("sender_py.web_controller.flush_cloud_logs"):
                ctrl2._run_worker({"1", "2"}, 2, 2)

            self.assertEqual(mock_send2.call_count, 2)
            self.assertTrue(mock_send2.call_args_list[0].kwargs["check_sidebar"])
            self.assertFalse(mock_send2.call_args_list[1].kwargs["check_sidebar"])
            self.assertIsNone(ctrl2.progress.get("sidebar_alert"))

    def test_compute_side_hud_geometry_avoids_wecom(self):
        """侧边进度浮窗应优先停靠企微右侧，空间不足切左侧或窄幅贴靠，绝不遮挡企微。"""
        from sender_py.web_companion import compute_side_hud_geometry

        work = (0, 0, 1920, 1040)
        # 1. 企微居中 (480..1440) -> 右侧有 480px 空余，停在企微右侧
        wx, wy, ww, wh = (480, 200, 960, 640)
        x, y, w, h = compute_side_hud_geometry((wx, wy, ww, wh), work, hud_w=276, hud_h=236, margin=12)
        self.assertEqual((x, y, w, h), (480 + 960 + 12, 200, 276, 236))
        self.assertGreaterEqual(x, wx + ww + 12)

        # 2. 企微靠右 -> 右侧不足，自动切到企微左侧
        x2, y2, w2, _ = compute_side_hud_geometry((900, 100, 960, 640), work, hud_w=276, hud_h=236, margin=12)
        self.assertEqual(w2, 276)
        self.assertLessEqual(x2 + w2, 900 - 12)

        # 3. 笔记本高缩放窄边（两侧各剩 230px < 276，但 >= 196）-> 自动缩窄贴靠右侧，仍不重叠企微
        x3, _, w3, _ = compute_side_hud_geometry((230, 80, 900, 600), (0, 0, 1360, 720), hud_w=276, hud_h=236, margin=12, min_w=196)
        self.assertGreaterEqual(x3, 230 + 900 + 12)
        self.assertLessEqual(x3 + w3, 1360)
        self.assertGreaterEqual(w3, 196)

        # 4. 企微未就绪 (None) -> 停在工作区右上角
        x4, y4, w4, _ = compute_side_hud_geometry(None, work, hud_w=276, hud_h=236, margin=12)
        self.assertEqual((x4, y4, w4), (1920 - 276 - 12, 12, 276))

    def test_web_companion_side_hud_lifecycle(self):
        """发送启动时展示侧边进度浮窗，结束时切为完成提示并安排自动关闭。"""
        import sys
        mock_tk = unittest.mock.MagicMock()
        mock_ttk = unittest.mock.MagicMock()
        mock_tk.Label.side_effect = lambda *a, **kw: unittest.mock.MagicMock()
        mock_tk.Button.side_effect = lambda *a, **kw: unittest.mock.MagicMock()
        mock_tk.Frame.side_effect = lambda *a, **kw: unittest.mock.MagicMock()
        mock_tk.Toplevel.side_effect = lambda *a, **kw: unittest.mock.MagicMock()

        with unittest.mock.patch.dict(sys.modules, {"tkinter": mock_tk, "tkinter.ttk": mock_ttk}):
            from sender_py.web_companion import WebCompanionWindow
            ctrl = WebController()
            mock_server = unittest.mock.MagicMock()
            mock_root = unittest.mock.MagicMock()
            mock_root.winfo_screenwidth.return_value = 1920
            mock_root.winfo_screenheight.return_value = 1080

            win = WebCompanionWindow(ctrl, mock_server, 8765, "http://127.0.0.1:8765", root=mock_root)

            # 1. 发送中状态 -> 创建并展示 HUD
            with unittest.mock.patch.object(ctrl, "get_state", return_value={
                "running": True,
                "files": ["a.json"],
                "progress": {"processed": 2, "total": 5, "current_name": "55650徐思琪", "step_text": "正在发送：55650徐思琪 (3/5)", "countdown": 0},
                "summary": {"total": 5, "selected": 5, "sent": 2, "failed": 0, "unmatched": 0, "blocked": 0, "skipped": 0},
            }):
                running = win._update_status_display()
            self.assertTrue(running)
            self.assertIsNotNone(win._progress_hud)
            self.assertTrue(win._progress_hud._visible)
            self.assertEqual(win._progress_hud._pct_lbl.config.call_args[1]["text"], "2/5 (40%)")

            # 2. 发送结束 -> 切换结束态并调度自动隐藏
            with unittest.mock.patch.object(ctrl, "get_state", return_value={
                "running": False,
                "files": ["a.json"],
                "progress": {"processed": 5, "total": 5, "current_name": "", "step_text": "发送完成", "countdown": 0},
                "summary": {"total": 5, "selected": 0, "sent": 5, "failed": 0, "unmatched": 0, "blocked": 0, "skipped": 0},
            }):
                running_after = win._update_status_display()
            self.assertFalse(running_after)
            self.assertEqual(win._progress_hud._badge_lbl.config.call_args[1]["text"], "发送完成")
            self.assertTrue(mock_root.after.called)


if __name__ == "__main__":
    unittest.main()
