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
    """获取单页面 web_ui.html 路径（自适应 PyInstaller onefile/onedir、Nuitka standalone/onefile 及源码路径）。"""
    # 0. Nuitka onefile 临时解压目录
    nuitka_dir = os.environ.get("NUITKA_ONEFILE_DIRECTORY")
    if nuitka_dir:
        p1 = os.path.join(nuitka_dir, "sender_py", "web_ui.html")
        if os.path.isfile(p1):
            return p1
        p2 = os.path.join(nuitka_dir, "web_ui.html")
        if os.path.isfile(p2):
            return p2
    # 1. PyInstaller _MEIPASS 优先
    if getattr(sys, "frozen", False) and getattr(sys, "_MEIPASS", None):
        p1 = os.path.join(sys._MEIPASS, "sender_py", "web_ui.html")
        if os.path.isfile(p1):
            return p1
        p2 = os.path.join(sys._MEIPASS, "web_ui.html")
        if os.path.isfile(p2):
            return p2
    # 2. Nuitka standalone 或 PyInstaller onedir (exe 同级或 sender_py 子目录)
    if getattr(sys, "frozen", False) or "__compiled__" in globals():
        exe_dir = os.path.dirname(os.path.abspath(sys.executable))
        p1 = os.path.join(exe_dir, "sender_py", "web_ui.html")
        if os.path.isfile(p1):
            return p1
        p2 = os.path.join(exe_dir, "web_ui.html")
        if os.path.isfile(p2):
            return p2
    # 3. 源码同级目录
    here = os.path.dirname(os.path.abspath(__file__))
    p = os.path.join(here, "web_ui.html")
    if os.path.isfile(p):
        return p
    return ""


class FeedbackHttpHandler(http.server.BaseHTTPRequestHandler):
    """处理 WebUI 静态资源与 REST API 请求。"""

    server_version = "JiFangFeedbackWeb/2.0.1"

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
            nuitka_dir = os.environ.get("NUITKA_ONEFILE_DIRECTORY")
            if nuitka_dir:
                for c in (os.path.join(nuitka_dir, "favicon.ico"), os.path.join(nuitka_dir, "sender_py", "favicon.ico")):
                    if os.path.isfile(c):
                        icon_path = c
                        break
            if not icon_path and getattr(sys, "frozen", False) and getattr(sys, "_MEIPASS", None):
                candidate = os.path.join(sys._MEIPASS, "favicon.ico")
                if os.path.isfile(candidate):
                    icon_path = candidate
            if not icon_path and (getattr(sys, "frozen", False) or "__compiled__" in globals()):
                candidate = os.path.join(os.path.dirname(os.path.abspath(sys.executable)), "favicon.ico")
                if os.path.isfile(candidate):
                    icon_path = candidate
            if not icon_path:
                here = os.path.dirname(os.path.abspath(__file__))
                candidate = os.path.normpath(os.path.join(here, "..", "..", "favicon.ico"))
                if os.path.isfile(candidate):
                    icon_path = candidate
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
        if path == "/api/debug/list":
            try:
                try:
                    from sender_py.debug_utils import list_debug_snapshots
                except ModuleNotFoundError:
                    from debug_utils import list_debug_snapshots
                self._send_json({"snapshots": list_debug_snapshots()})
            except Exception as exc:
                self._send_json({"snapshots": [], "error": str(exc)})
            return

        if path in ("/api/debug/latest", "/api/debug/detail"):
            prefix = query.get("prefix", [""])[0] or None
            try:
                try:
                    from sender_py.debug_utils import get_debug_info
                except ModuleNotFoundError:
                    from debug_utils import get_debug_info
                self._send_json(get_debug_info(prefix))
            except Exception as exc:
                self._send_json({"available": False, "error": str(exc)})
            return

        if path == "/api/debug/image":
            name = query.get("name", [""])[0]
            safe_name = os.path.basename(name)
            try:
                try:
                    from sender_py.debug_utils import get_debug_dir
                except ModuleNotFoundError:
                    from debug_utils import get_debug_dir
                debug_dir = get_debug_dir()
                target_path = os.path.join(debug_dir, safe_name)
                if safe_name and os.path.isfile(target_path):
                    with open(target_path, "rb") as f:
                        img_bytes = f.read()
                    self.send_response(200)
                    self.send_header("Content-Type", "image/png")
                    self.send_header("Content-Length", str(len(img_bytes)))
                    self.send_header("Cache-Control", "no-cache, no-store")
                    self.end_headers()
                    self.wfile.write(img_bytes)
                    return
            except Exception:
                pass
            self.send_response(404)
            self.end_headers()
            return

        if path == "/api/state":
            self._send_json(self.controller.get_state())
            return

        if path == "/api/logs":
            since = int(query.get("since", [0])[0])
            self._send_json({"logs": self.controller.get_logs(since)})
            return

        if path == "/api/logs/files":
            try:
                try:
                    from sender_py.file_logger import list_log_files
                except ModuleNotFoundError:
                    from file_logger import list_log_files
                files = list_log_files()
            except Exception:
                files = []
            self._send_json({"files": files})
            return

        if path == "/api/logs/view":
            filename = query.get("file", [""])[0]
            try:
                lines = int(query.get("lines", [2000])[0])
            except (ValueError, TypeError):
                lines = 2000
            try:
                try:
                    from sender_py.file_logger import read_log_file
                except ModuleNotFoundError:
                    from file_logger import read_log_file
                content = read_log_file(filename, max_lines=lines)
            except Exception as e:
                content = f"无法读取日志：{e}"
            self._send_json({"filename": filename, "content": content})
            return

        if path == "/api/reply_notes":
            try:
                from sender_py.reply_notes import actionable
                from sender_py.utils import parse_student_identifier
            except ModuleNotFoundError:
                from reply_notes import actionable
                from utils import parse_student_identifier
            notes = actionable(self.controller.reply_notes)
            result = []
            seen = set()
            for n in notes:
                raw = n.get("student", "")
                sid, sname = parse_student_identifier(raw)
                key = (sid, sname)
                if key in seen:
                    continue
                seen.add(key)
                result.append({
                    "sid": sid or "-",
                    "sname": sname or raw,
                    "student": raw,
                    "chat_title": n.get("chat_title", ""),
                    "last_message": n.get("last_message", ""),
                    "parent_reply": n.get("last_message", ""),
                    "verdict": n.get("verdict", "需回"),
                    "time": n.get("time", ""),
                })
            self._send_json({"notes": result})
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

        # 2.8 多引擎基准评测 API
        if path == "/api/benchmark/state":
            self._send_json(self.controller.get_benchmark_state())
            return

        if path == "/api/benchmark/export":
            csv_text, fname = self.controller.get_benchmark_csv_content()
            csv_bytes = ("\ufeff" + csv_text).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="{fname}"')
            self.send_header("Content-Length", str(len(csv_bytes)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(csv_bytes)
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

    def _choose_native_files(self):
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            try:
                root.attributes("-topmost", True)
            except Exception:
                pass
            paths = filedialog.askopenfilenames(
                parent=root,
                title="选择反馈文件（可按 Ctrl+A 全选所有文件）",
                filetypes=[
                    ("反馈文件（JSON / HTML）", "*.json *.html *.htm"),
                    ("JSON 文件", "*.json"),
                    ("HTML 快照", "*.html *.htm"),
                    ("所有文件", "*.*"),
                ],
            )
            root.destroy()
            if paths:
                self.controller.add_input_files(list(paths), replace=False)
        except Exception as exc:
            self.controller.emit(f"⚠️ 打开本地文件选择器失败：{exc}")

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

        # 2.5 弹出原生 Windows 文件选择器（支持 Ctrl+A 全选多文件）
        if path == "/api/files/choose_native":
            if getattr(self.controller, "native_file_picker", None):
                self.controller.native_file_picker()
            else:
                threading.Thread(target=self._choose_native_files, daemon=True).start()
            self._send_json({"success": True})
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
            res = self.controller.run_calibration()
            self._send_json(res)
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

        # 9.5 多引擎基准评测控制
        if path == "/api/benchmark/start":
            ids = body.get("ids", None)
            res = self.controller.start_benchmark(ids)
            self._send_json(res)
            return

        if path == "/api/benchmark/stop":
            res = self.controller.stop_benchmark()
            self._send_json(res)
            return

        # 9.8 企业微信窗口向下还原并居中
        if path == "/api/wecom/center":
            res = self.controller.restore_and_center_wecom()
            self._send_json(res)
            return

        # 9.9 打开现场截图存档文件夹
        if path == "/api/debug/open_folder":
            try:
                try:
                    from sender_py.debug_utils import get_debug_dir
                    from sender_py.store import open_folder_or_file
                except ModuleNotFoundError:
                    from debug_utils import get_debug_dir
                    from store import open_folder_or_file
                ok = open_folder_or_file(get_debug_dir())
                self._send_json({"success": ok})
            except Exception as exc:
                self._send_json({"success": False, "error": str(exc)})
            return

        # 9.95 打开本地日志文件夹
        if path == "/api/logs/open_folder":
            try:
                try:
                    from sender_py.file_logger import open_logs_dir
                except ModuleNotFoundError:
                    from file_logger import open_logs_dir
                ok = open_logs_dir()
                self._send_json({"success": ok})
            except Exception as exc:
                self._send_json({"success": False, "error": str(exc)})
            return

        # 9.98 保存老师姓名/备注配置
        if path == "/api/config/teacher_note":
            try:
                note = str(body.get("teacher_note") or "")
                res = self.controller.update_teacher_note(note)
                self._send_json(res)
            except Exception as exc:
                self._send_json({"success": False, "error": str(exc)}, 400)
            return

        # 10. 退出后台程序
        if path == "/api/shutdown":
            try:
                try:
                    from sender_py.file_logger import flush_cloud_logs
                except ModuleNotFoundError:
                    from file_logger import flush_cloud_logs
                flush_cloud_logs(timeout=1.5)
            except Exception:
                pass
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
