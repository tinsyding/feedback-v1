"""极方每周反馈程序 · Web 版启动入口。

启动本地轻量 HTTP 服务，并在默认浏览器中自动打开 Web 控制面板。
"""

import os
import socket
import sys
import threading
import time
import webbrowser

APP_NAME = "极方每周反馈程序 (Web版)"
APP_VERSION = "1.8.1"


def find_free_port(start: int = 8765, max_attempts: int = 100) -> int:
    """寻找本地可用的端口号。"""
    for port in range(start, start + max_attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    # 随机回退
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def run_smoke_test() -> int:
    """CI/CD 烟雾测试模式：启动微型实例验证模块与服务器能否正常实例化并立刻退出。"""
    print(f"[{APP_NAME}] 正在执行 smoke test (v{APP_VERSION})...")
    try:
        try:
            from sender_py.web_controller import WebController
            from sender_py.web_server import ThreadingFeedbackServer, get_web_ui_html_path
        except ModuleNotFoundError:
            from web_controller import WebController
            from web_server import ThreadingFeedbackServer, get_web_ui_html_path

        html_path = get_web_ui_html_path()
        if not html_path or not os.path.isfile(html_path):
            print("ERROR: web_ui.html not found!")
            return 1

        controller = WebController()
        port = find_free_port(9800)
        server = ThreadingFeedbackServer(("127.0.0.1", port), controller)
        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()
        time.sleep(0.5)
        server.shutdown()
        server.server_close()
        print("Smoke test passed successfully!")
        return 0
    except Exception as exc:
        print(f"Smoke test failed: {exc}")
        return 1


def main():
    if "--smoke-test" in sys.argv:
        sys.exit(run_smoke_test())

    try:
        from sender_py.web_controller import WebController
        from sender_py.web_server import ThreadingFeedbackServer
    except ModuleNotFoundError:
        from web_controller import WebController
        from web_server import ThreadingFeedbackServer

    port = find_free_port(8765)
    controller = WebController()
    server = ThreadingFeedbackServer(("127.0.0.1", port), controller)

    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    url = f"http://127.0.0.1:{port}"
    print(f"==================================================")
    print(f"  {APP_NAME} v{APP_VERSION}")
    print(f"  本地服务已启动: {url}")
    print(f"  按 Ctrl+C 可停止程序")
    print(f"==================================================")

    # 启动 Windows 全局 ESC 键监听（按 ESC 即可打断发送）
    try:
        try:
            from sender_py import window_utils as wu
        except ModuleNotFoundError:
            import window_utils as wu
        wu.listen_esc(controller.stop_send)
    except Exception:
        pass

    # 在系统默认浏览器打开 Web 控制面板
    def _open_browser():
        time.sleep(0.4)
        try:
            webbrowser.open(url)
        except Exception:
            pass

    threading.Thread(target=_open_browser, daemon=True).start()

    try:
        while server_thread.is_alive():
            time.sleep(1.0)
    except (KeyboardInterrupt, SystemExit):
        print("\n正在停止本地服务...")
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
