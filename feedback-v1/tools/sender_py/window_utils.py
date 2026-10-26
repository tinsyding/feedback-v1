"""窗口查找（Windows 专属，win32gui/ctypes 只在函数内导入，Linux 导入本模块不报错）。"""

import time


def set_per_monitor_dpi_awareness():
    """启动时设置 Per-Monitor DPI 感知，三段兜底（与旧版一致）；非 Windows 返回 False。

    顺序：SetProcessDpiAwarenessContext(-4, V2) → shcore.SetProcessDpiAwareness(2)
    → user32.SetProcessDPIAware()。ctypes.windll 只在 Windows 存在，Linux 直接 False。
    """
    try:
        import ctypes
        windll = ctypes.windll  # Linux 无此属性，直接抛 AttributeError 走 False
    except Exception:
        return False
    try:
        windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        return True
    except Exception:
        pass
    try:
        windll.shcore.SetProcessDpiAwareness(2)
        return True
    except Exception:
        pass
    try:
        windll.user32.SetProcessDPIAware()
        return True
    except Exception:
        return False


def get_wecom_hwnd():
    """标题含企业微信/WeCom（兼容 WeCom），过滤 Wedoc/全局搜索，面积>300x300。无则返回 None。"""
    try:
        import win32gui
    except Exception:
        return None
    found = []

    def _cb(hwnd, _):
        try:
            if not win32gui.IsWindow(hwnd):
                return True
            cls = win32gui.GetClassName(hwnd)
            title = win32gui.GetWindowText(hwnd)
            if ("WeWorkWindow" in cls or "企业微信" in title or "WeCom" in title or "WXWork" in cls) and "Wedoc" not in cls and "SearchTab" not in cls and "全局搜索" not in title:
                r = win32gui.GetWindowRect(hwnd)
                if r[2] - r[0] > 300 and r[3] - r[1] > 300:
                    found.append(hwnd)
        except Exception:
            pass
        return True

    try:
        win32gui.EnumWindows(_cb, None)
    except Exception:
        return None
    return found[0] if found else None


def find_wecom_search_tab_wnd():
    """查找企业微信“全局搜索”独立弹窗 (SearchTabWnd2)。

    当搜索联系人无本地匹配时，企业微信会弹出此独立窗口（顶级窗口无宿主，类名 SearchTabWnd2，标题 全局搜索）。
    若存在返回窗口句柄 (hwnd)，否则返回 None。非 Windows 或找不到返回 None。
    """
    try:
        import win32gui
    except Exception:
        return None

    # 1. 优先检查当前前台窗口
    try:
        fg = win32gui.GetForegroundWindow()
        if fg and win32gui.IsWindow(fg) and win32gui.IsWindowVisible(fg):
            cls = win32gui.GetClassName(fg)
            title = win32gui.GetWindowText(fg)
            if "SearchTab" in cls or "全局搜索" in title:
                return fg
    except Exception:
        pass

    # 2. 枚举所有顶层可见窗口
    found = []

    def _cb(hwnd, _):
        try:
            if not win32gui.IsWindow(hwnd) or not win32gui.IsWindowVisible(hwnd):
                return True
            cls = win32gui.GetClassName(hwnd)
            title = win32gui.GetWindowText(hwnd)
            if "SearchTab" in cls or ("全局搜索" in title and ("Search" in cls or "Wnd" in cls or "WeWork" in cls or not cls)):
                found.append(hwnd)
        except Exception:
            pass
        return True

    try:
        win32gui.EnumWindows(_cb, None)
    except Exception:
        return None

    return found[0] if found else None


def close_wecom_search_tab_wnd(search_hwnd=None) -> bool:
    """关闭企业微信“全局搜索”弹窗并重新激活企微主窗口。

    成功关闭返回 True，未发现弹窗返回 False。
    """
    try:
        import win32gui
        import win32con
    except Exception:
        return False

    hwnd = search_hwnd or find_wecom_search_tab_wnd()
    if not hwnd:
        return False

    try:
        win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
        time.sleep(0.15)
        if win32gui.IsWindow(hwnd):
            try:
                win32gui.SendMessage(hwnd, win32con.WM_CLOSE, 0, 0)
                time.sleep(0.1)
            except Exception:
                pass
    except Exception:
        pass

    # 重新激活企微主窗口
    try:
        find_and_activate_wecom()
        time.sleep(0.15)
    except Exception:
        pass

    return True


def get_wecom_rect():
    """win32gui.GetWindowRect -> (x, y, w, h) 物理坐标；失败返回 None。"""
    try:
        import win32gui
    except Exception:
        return None
    hwnd = get_wecom_hwnd()
    if hwnd is None:
        return None
    try:
        l, t, r, b = win32gui.GetWindowRect(hwnd)
        return (l, t, r - l, b - t)
    except Exception:
        return None


def get_dpi_scale(hwnd=None) -> float:
    """GetDpiForWindow → GetDpiForSystem → GetDeviceCaps(88) 兜底；clamp 到 [0.5, 4.0]。"""
    try:
        import ctypes
        user32 = ctypes.windll.user32
    except Exception:
        return 1.0
    dpi = 96
    if hwnd:
        try:
            v = user32.GetDpiForWindow(hwnd)
            if v > 0:
                dpi = v
        except Exception:
            pass
    if dpi == 96:
        try:
            dpi = user32.GetDpiForSystem()
        except Exception:
            dpi = 96
    if dpi == 96:
        try:
            hdc = user32.GetDC(0)
            dpi = ctypes.windll.gdi32.GetDeviceCaps(hdc, 88)  # LOGPIXELSX
            user32.ReleaseDC(0, hdc)
        except Exception:
            dpi = 96
    try:
        dpi = int(dpi)
    except Exception:
        dpi = 96
    if dpi <= 0:
        dpi = 96
    return max(0.5, min(4.0, dpi / 96.0))


# ---- 键盘/鼠标（Windows 专属，ctypes user32；Linux 返回 False，不抛异常）----
VK_RETURN = 0x0D
VK_ESCAPE = 0x1B
VK_CONTROL = 0x11
VK_MENU = 0x12  # Alt
VK_F = 0x46
VK_V = 0x56
VK_A = 0x41
VK_DOWN = 0x28
_KEYEVENTF_KEYUP = 0x0002
_MOUSEEVENTF_LEFTDOWN = 0x0002
_MOUSEEVENTF_LEFTUP = 0x0004


def _user32():
    import ctypes
    return ctypes.windll.user32


def tap_keys(*vks) -> bool:
    """依次按下又松开一组键（如 Ctrl+V 传 (VK_CONTROL, VK_V)）；按住修饰键再按主键。"""
    try:
        u32 = _user32()
        for vk in vks:
            u32.keybd_event(vk, 0, 0, 0)
        for vk in reversed(vks):
            u32.keybd_event(vk, 0, _KEYEVENTF_KEYUP, 0)
        return True
    except Exception:
        return False


def tap_key(vk) -> bool:
    """单击单个键（Enter/Esc/Down）。"""
    return tap_keys(vk)


def click_xy(x, y) -> bool:
    """移动光标并左键单击一次（物理像素坐标）。"""
    try:
        u32 = _user32()
        u32.SetCursorPos(int(x), int(y))
        u32.mouse_event(_MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
        u32.mouse_event(_MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
        return True
    except Exception:
        return False


def find_and_activate_wecom() -> bool:
    """恢复/显示企微主窗口并抢前台（Alt 绕前台锁）；失败返回 False。"""
    try:
        import win32gui
        import win32con
        u32 = _user32()
    except Exception:
        return False
    hwnd = get_wecom_hwnd()
    if hwnd is None:
        return False
    try:
        if win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        else:
            win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
        u32.keybd_event(VK_MENU, 0, 0, 0)
        win32gui.SetForegroundWindow(hwnd)
        u32.keybd_event(VK_MENU, 0, _KEYEVENTF_KEYUP, 0)
        return True
    except Exception:
        return False


def is_foreground_wecom() -> bool:
    """当前前台是否为企微；取不到信息时按 True 放行（不误拦）。"""
    try:
        import win32gui
    except Exception:
        return True
    try:
        fg = win32gui.GetForegroundWindow()
        if not fg:
            return True
        title = win32gui.GetWindowText(fg)
        cls = win32gui.GetClassName(fg)
        return ("WeWorkWindow" in cls or "企业微信" in title
                or "WeCom" in title or "WXWork" in cls)
    except Exception:
        return True


def ensure_fully_visible() -> tuple:
    """mss 截屏幕像素：窗口半截出屏则截不全。把企微 Clamp 回虚拟屏内（保尺寸只挪位置）。

    返回 (True, rect)；窗口比整块虚拟屏还大则 (False, reason)，请用户手动处理。
    """
    try:
        import win32gui
        u32 = _user32()
    except Exception:
        return (False, "无 win32 环境")
    hwnd = get_wecom_hwnd()
    if hwnd is None:
        return (False, "找不到企微窗口")
    try:
        vx = u32.GetSystemMetrics(76)
        vy = u32.GetSystemMetrics(77)
        vw = u32.GetSystemMetrics(78)
        vh = u32.GetSystemMetrics(79)
        l, t, r, b = win32gui.GetWindowRect(hwnd)
        w, h = r - l, b - t
        if w > vw or h > vh:
            return (False, "企微窗口比屏幕还大，请先恢复/缩小窗口再跑")
        nx = min(max(l, vx), vx + vw - w)
        ny = min(max(t, vy), vy + vh - h)
        if (nx, ny) != (l, t):
            win32gui.MoveWindow(hwnd, nx, ny, w, h, True)
        l, t, r, b = win32gui.GetWindowRect(hwnd)
        return (True, (l, t, r - l, b - t))
    except Exception as e:
        return (False, f"窗口归位失败：{e}")


import sys
import threading
import time


class GlobalEscWatcher:
    """Windows 全局 ESC 紧急停止监听器。

    双重拦截机制：
    1. 底层键盘钩子 (WH_KEYBOARD_LL = 13)：
       - 全局捕获物理 ESC 按键；
       - 拦截并吞掉 ESC 击键（return 1），阻止 Windows 将 ESC 发送给前台企业微信，彻底解决“按ESC导致企微最小化”的问题！
       - 立即触发停止回调（0ms 响应）。
    2. 高频 GetAsyncKeyState (15ms) 异步轮询兜底：
       - 当系统安全软件或受限权限阻止全局钩子注入时，自动提供 15ms 级灵敏轮询，确保 100% 捕获 ESC。
    """
    def __init__(self, on_stop_callback=None):
        self.on_stop = on_stop_callback
        self._stop_event = threading.Event()
        self._thread = None
        self._hook = None
        self._hook_proc_ref = None

    def start(self):
        if sys.platform != "win32":
            return
        self.stop()
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._worker, name="GlobalEscWatcher", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop_event.set()
        if self._hook:
            try:
                import ctypes
                ctypes.windll.user32.UnhookWindowsHookEx(self._hook)
            except Exception:
                pass
            self._hook = None

    def _trigger_stop(self):
        if callable(self.on_stop):
            try:
                self.on_stop()
            except Exception:
                pass

    def _worker(self):
        try:
            import ctypes
            from ctypes import wintypes
            user32 = ctypes.windll.user32
            kernel32 = ctypes.windll.kernel32

            # 清掉启动前残留的 ESC 击键状态
            user32.GetAsyncKeyState(0x1B)

            HOOKPROC = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)

            def _py_hook_proc(nCode, wParam, lParam):
                if nCode >= 0 and wParam in (0x0100, 0x0104):  # WM_KEYDOWN, WM_SYSKEYDOWN
                    try:
                        vk = ctypes.cast(lParam, ctypes.POINTER(wintypes.DWORD))[0]
                        if vk == 0x1B:  # VK_ESCAPE
                            self._trigger_stop()
                            return 1  # 拦截该按键，不让 Windows 传递给前台的企微，防止企微意外最小化
                    except Exception:
                        pass
                return user32.CallNextHookEx(self._hook, nCode, wParam, lParam)

            self._hook_proc_ref = HOOKPROC(_py_hook_proc)
            self._hook = user32.SetWindowsHookExW(13, self._hook_proc_ref, kernel32.GetModuleHandleW(None), 0)

            msg = wintypes.MSG()
            while not self._stop_event.is_set():
                while user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, 1):
                    user32.TranslateMessage(ctypes.byref(msg))
                    user32.DispatchMessageW(ctypes.byref(msg))
                # 轮询双保险
                if user32.GetAsyncKeyState(0x1B) & 0x8000:
                    self._trigger_stop()
                time.sleep(0.015)
        except Exception:
            while not self._stop_event.is_set():
                try:
                    import ctypes
                    if ctypes.windll.user32.GetAsyncKeyState(0x1B) & 0x8000:
                        self._trigger_stop()
                except Exception:
                    pass
                time.sleep(0.02)
        finally:
            if self._hook:
                try:
                    import ctypes
                    ctypes.windll.user32.UnhookWindowsHookEx(self._hook)
                except Exception:
                    pass
                self._hook = None
