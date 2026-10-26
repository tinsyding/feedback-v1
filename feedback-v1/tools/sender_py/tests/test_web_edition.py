"""Web 版控制器与本地 HTTP 服务单元测试。"""

import json
import os
import tempfile
import threading
import time
import unittest
import urllib.request

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
        ctrl = WebController()
        state = ctrl.get_state()
        self.assertFalse(state["running"])
        self.assertEqual(len(state["students"]), 0)
        self.assertEqual(len(state["files"]), 0)

        # 创建测试 JSON 文件
        with tempfile.TemporaryDirectory() as td:
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
            ctrl.set_selection("toggle_specific", [first_id])
            state = ctrl.get_state()
            self.assertEqual(state["summary"]["selected"], 1)

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
        ctrl = WebController()
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

        finally:
            server.shutdown()
            server.server_close()

    def test_smoke_test(self):
        ret = run_smoke_test()
        self.assertEqual(ret, 0)


if __name__ == "__main__":
    unittest.main()
