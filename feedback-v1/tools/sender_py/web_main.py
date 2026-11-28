"""极方每周反馈程序 · Web 版启动入口。

启动本地轻量 HTTP 服务，并在默认浏览器中自动打开 Web 控制面板。
"""

import faulthandler
import os
import socket
import sys
import threading
import time
import webbrowser

_FAULT_LOG_FILE = None


def _enable_crash_faulthandler():
    """启用 Python faulthandler，将 C/C++ 原生崩溃栈落盘至 ~/.sender_py/logs/crash_fault.log。"""
    global _FAULT_LOG_FILE
    try:
        try:
            from sender_py.file_logger import get_logs_dir
        except ModuleNotFoundError:
            from file_logger import get_logs_dir
        logs_dir = get_logs_dir()
        fault_path = os.path.join(logs_dir, "crash_fault.log")
        _FAULT_LOG_FILE = open(fault_path, "a", encoding="utf-8", buffering=1)
        faulthandler.enable(file=_FAULT_LOG_FILE, all_threads=True)
    except Exception:
        pass


def run_rapidocr_probe() -> int:
    """独立子进程探活模式：验证 RapidOCR/ONNXRuntime 加载与单次微型推理是否触发原生崩溃。"""
    try:
        from PIL import Image
        from rapidocr_onnxruntime import RapidOCR
        engine = RapidOCR()
        engine(Image.new("RGB", (120, 48), (255, 255, 255)))
        safe_print("RAPIDOCR_PROBE_OK")
        return 0
    except Exception as exc:
        safe_print(f"RAPIDOCR_PROBE_FAILED: {exc}", file=sys.stderr)
        return 2

# 确保在各平台（尤其 Windows 终端默认 cp1252/gbk）下标准输出流支持 UTF-8，避免打印中文抛出 UnicodeEncodeError
for _stream_name in ("stdout", "stderr"):
    _stream = getattr(sys, _stream_name, None)
    if _stream is not None and hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def safe_print(*args, **kwargs):
    """安全控制台输出：防御 sys.stdout is None (PyInstaller windowed 模式) 及编码不支持异常。"""
    stream = kwargs.get("file", sys.stdout)
    if stream is None:
        return
    try:
        print(*args, **kwargs)
    except UnicodeEncodeError:
        try:
            encoding = getattr(stream, "encoding", None) or "utf-8"
            sep = kwargs.get("sep", " ")
            end = kwargs.get("end", "\n")
            text = sep.join(str(a) for a in args)
            encoded = text.encode(encoding, errors="replace").decode(encoding)
            stream.write(encoded + end)
            stream.flush()
        except Exception:
            pass
    except Exception:
        pass


APP_NAME = "极方每周反馈程序 (Web版)"
APP_VERSION = "2.1.2"


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
    safe_print(f"[{APP_NAME}] 正在执行 smoke test (v{APP_VERSION})...")
    try:
        try:
            from sender_py.web_controller import WebController
            from sender_py.web_server import ThreadingFeedbackServer, get_web_ui_html_path
        except ModuleNotFoundError:
            from web_controller import WebController
            from web_server import ThreadingFeedbackServer, get_web_ui_html_path

        html_path = get_web_ui_html_path()
        if not html_path or not os.path.isfile(html_path):
            safe_print("ERROR: web_ui.html not found!")
            return 1

        controller = WebController()
        port = find_free_port(9800)
        server = ThreadingFeedbackServer(("127.0.0.1", port), controller)
        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()
        time.sleep(0.5)
        server.shutdown()
        server.server_close()

        if sys.platform == "win32":
            try:
                import winocr
                safe_print(f"[{APP_NAME}] winocr WinRT 模块可用")
            except Exception as e:
                safe_print(f"[{APP_NAME}] winocr 模块加载提示: {e}")

        safe_print("Smoke test passed successfully!")
        return 0
    except Exception as exc:
        safe_print(f"Smoke test failed: {exc}")
        return 1


def main():
    # 0. 最优先处理子进程探活模式（避免执行 DPI/GUI/HTTP 启动逻辑）
    if "--probe-rapidocr" in sys.argv:
        sys.exit(run_rapidocr_probe())

    # 0.5 启用原生崩溃栈落盘（捕获 C/C++ 扩展层 Segfault / Access Violation / Illegal Instruction）
    _enable_crash_faulthandler()

    # 1. 最优先启用 Per-Monitor DPI 感知与独立 AppUserModelID
    # (必须在创建任何窗口/Tk/Win32调用前执行，确保物理像素对齐与任务栏公司 Logo 正常显示)
    try:
        try:
            from sender_py.window_utils import set_per_monitor_dpi_awareness, set_app_user_model_id
        except ModuleNotFoundError:
            from window_utils import set_per_monitor_dpi_awareness, set_app_user_model_id
        set_per_monitor_dpi_awareness()
        set_app_user_model_id()
    except Exception:
        pass

    # 2. 自动清理旧版（未开启 DPI V2 时留存的偏移坐标）roi_config.json 缓存
    try:
        import json
        try:
            from sender_py.roi_manager import default_config_path
        except ModuleNotFoundError:
            from roi_manager import default_config_path
        cfg_p = default_config_path()
        if os.path.isfile(cfg_p):
            with open(cfg_p, "r", encoding="utf-8") as f:
                cfg_data = json.load(f)
            if not isinstance(cfg_data, dict) or cfg_data.get("schema_v") != 2:
                os.remove(cfg_p)
    except Exception:
        pass

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
    safe_print(f"==================================================")
    safe_print(f"  {APP_NAME} v{APP_VERSION}")
    safe_print(f"  本地服务已启动: {url}")
    safe_print(f"  按 Ctrl+C 可停止程序")
    safe_print(f"==================================================")

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

    # 尝试启动桌面微型伴随控制台（提供托盘/窗口驻留，解决关闭浏览器后后台无感知残留的问题）
    gui_started = False
    if "--headless" not in sys.argv and "--no-gui" not in sys.argv:
        try:
            try:
                from sender_py.web_companion import launch_web_gui_companion
            except ModuleNotFoundError:
                from web_companion import launch_web_gui_companion
            gui_started = launch_web_gui_companion(controller, server, port, url)
        except Exception as exc:
            safe_print(f"伴随控制台未启动 ({exc})，继续以纯后台/终端模式运行。")
            gui_started = False

    if not gui_started:
        try:
            while server_thread.is_alive():
                time.sleep(1.0)
        except (KeyboardInterrupt, SystemExit):
            safe_print("\n正在停止本地服务...")
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
