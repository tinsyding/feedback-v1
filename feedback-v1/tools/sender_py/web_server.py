"""Web 端本地 HTTP 服务器。

使用 Python 原生标准库 http.server，提供现代化 REST API 与 SSE 实时事件流，
零第三方 Web 依赖，稳定轻巧。
"""

import http.server
import json
import os
import queue
import sys
import threading
import time
import urllib.parse

try:
    from sender_py.web_controller import WebController
except ModuleNotFoundError:
    from web_controller import WebController


def get_web_ui_html_path() -> str:
    """获取单页面 web_ui.html 路径（支持 PyInstaller onefile 解压目录与源码路径）。"""
    if getattr(sys, "frozen", False) and getattr(sys, "_MEIPASS", None):
        p1 = os.path.join(sys._MEIPASS, "sender_py", "web_ui.html")
        if os.path.isfile(p1):
            return p1
        p2 = os.path.join(sys._MEIPASS, "web_ui.html")
        if os.path.isfile(p2):
            return p2
    here = os.path.dirname(os.path.abspath(__file__))
    p = os.path.join(here, "web_ui.html")
    if os.path.isfile(p):
        return p
    return ""


class FeedbackHttpHandler(http.server.BaseHTTPRequestHandler):
    """处理 WebUI 静态资源与 REST API 请求。"""

    server_version = "JiFangFeedbackWeb/1.8.1"

    def log_message(self, format, *args):
        # 静默常规 HTTP 请求，避免终端滚屏刷屏
        pass

    @property
    def controller(self) -> WebController:
        return self.server.controller

    def _send_json(self, data: dict, status_code: int = 200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # 1. 首页与静态资源
        if path in ("/", "/index.html"):
            html_path = get_web_ui_html_path()
            if html_path and os.path.isfile(html_path):
                with open(html_path, "rb") as f:
                    content = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)
            else:
                self._send_json({"error": "web_ui.html 未找到"}, 404)
            return

        if path == "/favicon.ico":
            icon_path = ""
            if getattr(sys, "frozen", False) and getattr(sys, "_MEIPASS", None):
                icon_path = os.path.join(sys._MEIPASS, "favicon.ico")
            if not os.path.isfile(icon_path):
                here = os.path.dirname(os.path.abspath(__file__))
                icon_path = os.path.normpath(os.path.join(here, "..", "..", "favicon.ico"))
            if os.path.isfile(icon_path):
                with open(icon_path, "rb") as f:
                    content = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "image/x-icon")
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)
            else:
                self.send_response(404)
                self.end_headers()
            return

        # 2. REST API 接口
        if path == "/api/state":
            self._send_json(self.controller.get_state())
            return

        if path == "/api/logs":
            since = int(query.get("since", [0])[0])
            self._send_json({"logs": self.controller.get_logs(since)})
            return

        if path == "/api/reply_notes":
            self._send_json({"notes": self.controller.reply_notes})
            return

        if path == "/api/sent_files":
            try:
                records = self.controller.sent_files.get_records()
            except Exception:
                records = []
            self._send_json({"records": records})
            return

        if path == "/api/sent_files/view":
            try:
                idx = int(query.get("index", [-1])[0])
                records = self.controller.sent_files.get_records()
                if 0 <= idx < len(records):
                    html_path = records[idx].get("html_record", "")
                    if html_path and os.path.isfile(html_path):
                        with open(html_path, "rb") as f:
                            content = f.read()
                        self.send_response(200)
                        self.send_header("Content-Type", "text/html; charset=utf-8")
                        self.send_header("Content-Length", str(len(content)))
                        self.send_header("Cache-Control", "no-cache")
                        self.end_headers()
                        self.wfile.write(content)
                        return
            except Exception:
                pass
            self.send_error(404, "Sent file report not found")
            return

        # 3. Server-Sent Events (SSE 实时事件推送)
        if path == "/api/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()

            # 先推送当前状态
            init_data = json.dumps({"type": "init", "state": self.controller.get_state()}, ensure_ascii=False)
            self.wfile.write(f"data: {init_data}\n\n".encode("utf-8"))
            self.wfile.flush()

            q = self.controller.add_listener()
            try:
                while True:
                    try:
                        event = q.get(timeout=15.0)
                        payload = json.dumps(event, ensure_ascii=False)
                        self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
                        self.wfile.flush()
                    except queue.Empty:
                        # 定时发送心跳保持连接
                        self.wfile.write(b": heartbeat\n\n")
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                self.controller.remove_listener(q)
            return

        self._send_json({"error": "Not Found"}, 404)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # 1. 文件上传 (同时兼容 multipart/form-data 与 JSON Base64/Text)
        if path == "/api/upload":
            content_type = self.headers.get("Content-Type", "")
            saved_paths = []

            if "multipart/form-data" in content_type:
                try:
                    from email.parser import BytesParser
                    from email.policy import default
                    length = int(self.headers.get("Content-Length", 0))
                    raw_data = self.rfile.read(length)
                    header_line = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8")
                    msg = BytesParser(policy=default).parsebytes(header_line + raw_data)
                    for part in msg.iter_parts():
                        fname = part.get_filename() or "uploaded_feedback.json"
                        payload = part.get_payload(decode=True)
                        if payload:
                            saved = self.controller.save_uploaded_file(fname, payload)
                            saved_paths.append(saved)
                except Exception as exc:
                    self._send_json({"success": False, "message": f"Multipart 解析失败: {exc}"}, 400)
                    return
            else:
                body = self._read_json_body()
                # 兼容 JSON 格式上传 {files: [{"name": "1.json", "content": "..."}]}
                for f in body.get("files", []):
                    fname = f.get("name", "uploaded.json")
                    raw = f.get("content", "")
                    raw_bytes = raw.encode("utf-8") if isinstance(raw, str) else bytes(raw)
                    saved = self.controller.save_uploaded_file(fname, raw_bytes)
                    saved_paths.append(saved)

            if saved_paths:
                res = self.controller.add_input_files(saved_paths, replace=False)
                self._send_json(res)
            else:
                self._send_json({"success": False, "message": "未能提取有效的文件内容"}, 400)
            return

        body = self._read_json_body()

        # 2. 从已有路径添加本地文件
        if path == "/api/files/add":
            paths = body.get("paths", [])
            replace = bool(body.get("replace", False))
            res = self.controller.add_input_files(paths, replace=replace)
            self._send_json(res)
            return

        # 3. 移除指定文件
        if path == "/api/files/remove":
            target_path = body.get("path", "")
            res = self.controller.remove_input_file(target_path)
            self._send_json(res)
            return

        # 4. 清空文件池
        if path == "/api/files/clear":
            res = self.controller.clear_all_files()
            self._send_json(res)
            return

        # 5. 勾选切换
        if path == "/api/students/toggle":
            action = body.get("action", "all")
            ids = body.get("ids", None)
            res = self.controller.set_selection(action, ids)
            self._send_json(res)
            return

        # 6. 开始发送
        if path == "/api/send":
            ids = body.get("target_ids", None)
            res = self.controller.start_send(ids)
            self._send_json(res)
            return

        # 7. 停止发送
        if path == "/api/stop":
            res = self.controller.stop_send()
            self._send_json(res)
            return

        # 8. 视野校准
        if path == "/api/calibrate":
            threading.Thread(target=self.controller.run_calibration, daemon=True).start()
            self._send_json({"success": True, "message": "已在后台启动视野校准"})
            return

        # 9. 打开已发文件记录目录
        if path == "/api/sent_files/open_folder":
            try:
                try:
                    from sender_py.store import open_folder_or_file
                except ModuleNotFoundError:
                    from store import open_folder_or_file
                ok = open_folder_or_file(self.controller.sent_files.records_dir)
            except Exception:
                ok = False
            self._send_json({"success": ok})
            return

        # 10. 退出后台程序
        if path == "/api/shutdown":
            self._send_json({"success": True, "message": "服务正在退出..."})
            def _exit_later():
                time.sleep(0.5)
                os._exit(0)
            threading.Thread(target=_exit_later, daemon=True).start()
            return

        self._send_json({"error": "Endpoint Not Found"}, 404)

    def _read_json_body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length <= 0:
                return {}
            raw = self.rfile.read(length).decode("utf-8")
            return json.loads(raw)
        except Exception:
            return {}


class ThreadingFeedbackServer(http.server.ThreadingHTTPServer):
    """支持多线程请求处理并挂载 WebController 实例。"""
    daemon_threads = True

    def __init__(self, server_address, controller: WebController):
        self.controller = controller
        super().__init__(server_address, FeedbackHttpHandler)
