"""Web 版控制器与本地 HTTP 服务单元测试。"""

import json
import os
import tempfile
import threading
import time
import unittest
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


if __name__ == "__main__":
    unittest.main()
