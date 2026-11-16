"""窗口查找（Windows 专属，win32gui/ctypes 只在函数内导入，Linux 导入本模块不报错）。"""

import time


def _ensure_thread_dpi_aware():
    """确保当前线程处于 Per-Monitor DPI Aware V2 (物理像素坐标空间)，与 mss 截屏坐标系严格一致。"""
    try:
        import ctypes
        ctypes.windll.user32.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
    except Exception:
        pass


def set_per_monitor_dpi_awareness():
    """启动时设置 Per-Monitor DPI 感知，三段兜底 + 当前线程强制 V2；非 Windows 返回 False。

    顺序：SetProcessDpiAwarenessContext(-4, V2) → shcore.SetProcessDpiAwareness(2)
    → user32.SetProcessDPIAware()，并同步设置当前线程 SetThreadDpiAwarenessContext(-4)。
    ctypes.windll 只在 Windows 存在，Linux 直接 False。
    """
    try:
        import ctypes
        windll = ctypes.windll  # Linux 无此属性，直接抛 AttributeError 走 False
    except Exception:
        return False
    ok = False
    try:
        if windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
            ok = True
    except Exception:
        pass
    if not ok:
        try:
            if windll.shcore.SetProcessDpiAwareness(2) == 0:
                ok = True
        except Exception:
            pass
    if not ok:
        try:
            if windll.user32.SetProcessDPIAware():
                ok = True
        except Exception:
            pass
    try:
        if windll.user32.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4)):
            ok = True
    except Exception:
        pass
    return ok


def set_app_user_model_id(app_id: str = "JiFang.Feedback.WebEdition") -> bool:
    """在 Windows 下为当前进程设置独立的 AppUserModelID。

    必须在创建任何窗口/Tk/GUI 之前调用，以确保 Windows 任务栏将程序识别为独立应用，
    显示公司专属 Logo 图标，彻底避免显示为 Python 默认的羽毛/叶子图标或被归入 Python 组。
    非 Windows 环境安全返回 False。
    """
    try:
        import ctypes
        windll = ctypes.windll
    except Exception:
        return False
    try:
        windll.shell32.SetCurrentProcessExplicitAppUserModelID(str(app_id))
        return True
    except Exception:
        return False


# 模块导入时即自动初始化进程与主线程 DPI 感知
set_per_monitor_dpi_awareness()


def get_wecom_hwnd():
    """标题含企业微信/WeCom（兼容 WeCom），过滤 Wedoc/全局搜索，面积>300x300。无则返回 None。"""
    _ensure_thread_dpi_aware()
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
    _ensure_thread_dpi_aware()
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
    _ensure_thread_dpi_aware()
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


def is_window_zoomed(hwnd) -> bool:
    """判断窗口是否处于最大化状态（安全兼容 user32.IsZoomed 与 pywin32 GetWindowPlacement）。"""
    if not hwnd:
        return False
    try:
        u32 = _user32()
        return bool(u32.IsZoomed(hwnd))
    except Exception:
        pass
    try:
        import win32gui
        import win32con
        placement = win32gui.GetWindowPlacement(hwnd)
        return placement[1] == win32con.SW_SHOWMAXIMIZED
    except Exception:
        return False


def is_window_iconic(hwnd) -> bool:
    """判断窗口是否处于最小化状态。"""
    if not hwnd:
        return False
    try:
        u32 = _user32()
        return bool(u32.IsIconic(hwnd))
    except Exception:
        pass
    try:
        import win32gui
        return bool(win32gui.IsIconic(hwnd))
    except Exception:
        return False


def tap_keys(*vks) -> bool:
    """依次按下又松开一组键（如 Ctrl+V 传 (VK_CONTROL, VK_V)）；按住修饰键再按主键。"""
    try:
        u32 = _user32()
        multi = len(vks) > 1
        for vk in vks:
            u32.keybd_event(vk, 0, 0, 0)
            if multi:
                time.sleep(0.015)
        time.sleep(0.025 if multi else 0.015)
        for vk in reversed(vks):
            u32.keybd_event(vk, 0, _KEYEVENTF_KEYUP, 0)
            if multi:
                time.sleep(0.01)
        return True
    except Exception:
        return False


def tap_key(vk) -> bool:
    """单击单个键（Enter/Esc/Down）。"""
    return tap_keys(vk)


def click_xy(x, y) -> bool:
    """移动光标并左键单击一次（物理像素坐标）。"""
    _ensure_thread_dpi_aware()
    try:
        u32 = _user32()
        u32.SetCursorPos(int(x), int(y))
        u32.mouse_event(_MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
        u32.mouse_event(_MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
        return True
    except Exception:
        return False


def find_and_activate_wecom() -> bool:
    """恢复/显示企微主窗口并抢前台（仅非前台时用 Alt 绕前台锁）；失败返回 False。"""
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
        iconic = is_window_iconic(hwnd)
        if not iconic:
            try:
                if win32gui.GetForegroundWindow() == hwnd:
                    return True
            except Exception:
                pass
            win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
        else:
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
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


def get_monitor_work_rect(hwnd=None):
    """获取指定窗口（默认企微窗口）所在显示器的工作区矩形 (left, top, width, height)，排除任务栏。非 Windows 返回 None。"""
    _ensure_thread_dpi_aware()
    try:
        import ctypes
        from ctypes import wintypes
        user32 = _user32()
    except Exception:
        return None

    class _RECT(ctypes.Structure):
        _fields_ = [
            ("left", ctypes.c_long),
            ("top", ctypes.c_long),
            ("right", ctypes.c_long),
            ("bottom", ctypes.c_long),
        ]

    class _MONITORINFO(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("rcMonitor", _RECT),
            ("rcWork", _RECT),
            ("dwFlags", wintypes.DWORD),
        ]

    target_hwnd = hwnd or get_wecom_hwnd()
    try:
        if target_hwnd:
            h_monitor = user32.MonitorFromWindow(target_hwnd, 2)  # MONITOR_DEFAULTTONEAREST
            if h_monitor:
                mi = _MONITORINFO()
                mi.cbSize = ctypes.sizeof(_MONITORINFO)
                if user32.GetMonitorInfoW(h_monitor, ctypes.byref(mi)):
                    return (
                        int(mi.rcWork.left),
                        int(mi.rcWork.top),
                        int(mi.rcWork.right - mi.rcWork.left),
                        int(mi.rcWork.bottom - mi.rcWork.top),
                    )
        return (
            int(user32.GetSystemMetrics(76)),
            int(user32.GetSystemMetrics(77)),
            int(user32.GetSystemMetrics(78)),
            int(user32.GetSystemMetrics(79)),
        )
    except Exception:
        return None


def show_window_topmost_noactivate(tk_win) -> bool:
    """将 Tk 窗口置顶显示但不抢夺当前前台窗口（企微）焦点。"""
    try:
        tk_win.attributes("-topmost", True)
    except Exception:
        pass
    try:
        import ctypes
        import sys
        if sys.platform != "win32":
            tk_win.deiconify()
            return True
        user32 = ctypes.windll.user32
        tk_win.update_idletasks()
        hwnd = tk_win.winfo_id()
        try:
            if not tk_win.overrideredirect():
                parent_hwnd = user32.GetParent(hwnd)
                if parent_hwnd:
                    hwnd = parent_hwnd
        except Exception:
            pass
        # HWND_TOPMOST = -1; SWP_NOSIZE(1) | SWP_NOMOVE(2) | SWP_NOACTIVATE(0x10) | SWP_SHOWWINDOW(0x40) = 0x53
        user32.ShowWindow(hwnd, 4)  # SW_SHOWNOACTIVATE
        user32.SetWindowPos(hwnd, ctypes.c_void_p(-1), 0, 0, 0, 0, 0x0053)
        return True
    except Exception:
        try:
            tk_win.deiconify()
        except Exception:
            pass
        return False


def restore_and_center_wecom(hwnd=None, log=None) -> tuple:
    """将企业微信窗口恢复为「向下还原状态」，缩至其内置最小极限尺寸，并精准居中于其当前所在的显示器。

    解决痛点：
      1. 部分用户将企微手动拉扯得比屏幕还大，甚至跨越多屏，导致截图超出屏幕物理缓冲；
      2. 企微处于最大化状态时占用整屏，不便对照与操作；
      3. 企微在向下还原状态下具有物理最小尺寸门槛（四周都无法再往里缩）；
      4. 多显示器环境下（存在负坐标、不同 DPI 或扩展屏），必须精准识别企微当前所在的屏幕工作区（排除任务栏）。

    返回：
      (True, (x, y, w, h)) 成功归位后的外接矩形
      (False, reason) 失败原因
    """
    _ensure_thread_dpi_aware()
    try:
        import ctypes
        from ctypes import wintypes
        import win32con
        import win32gui
        user32 = _user32()
    except Exception:
        return (False, "无 win32 环境")

    hwnd = hwnd or get_wecom_hwnd()
    if hwnd is None or not win32gui.IsWindow(hwnd):
        return (False, "未找到有效的企业微信窗口")

    try:
        # 1. 向下还原状态：如果窗口处于最大化 (IsZoomed) 或最小化 (IsIconic)，触发还原
        if is_window_zoomed(hwnd) or is_window_iconic(hwnd):
            if log:
                try:
                    log("  检测到企微处于最大化/最小化状态，正在自动向下还原...")
                except Exception:
                    pass
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
            time.sleep(0.08)
        else:
            win32gui.ShowWindow(hwnd, win32con.SW_SHOWNORMAL)

        # 2. 获取企微最小限制尺寸（四周都不能再往里缩了）：
        # Windows 的 SetWindowPos 会向目标窗口触发 WM_GETMINMAXINFO。
        # 当传入一个极小尺寸（如 100x100）时，企微底层会自动将其 Clamp（钳制）到其程序设定的最小 Tracking 尺寸。
        win32gui.SetWindowPos(
            hwnd, 0, 0, 0, 100, 100,
            win32con.SWP_NOMOVE | win32con.SWP_NOZORDER | win32con.SWP_NOACTIVATE
        )
        time.sleep(0.06)

        # 读取被企微自身钳制后的实际物理宽高
        cur_l, cur_t, cur_r, cur_b = win32gui.GetWindowRect(hwnd)
        min_w = cur_r - cur_l
        min_h = cur_b - cur_t

        # 兜底防御：仅当系统或底层未正常钳制（如异常小于 500x350）时，才使用企微标准基准尺寸结合 DPI 换算
        if min_w < 500 or min_h < 350:
            dpi_scale = get_dpi_scale(hwnd)
            baseline_w = int(round(960 * dpi_scale))
            baseline_h = int(round(640 * dpi_scale))
            min_w = max(min_w, baseline_w)
            min_h = max(min_h, baseline_h)

        # 3. 屏幕识别（多显示器安全检测）：
        # 使用 get_monitor_work_rect 查找企微主要所在的显示器工作区（排除任务栏）。
        work_rect = get_monitor_work_rect(hwnd)
        if work_rect:
            work_l, work_t, work_w, work_h = work_rect
        else:
            work_l, work_t, work_w, work_h = 0, 0, 1920, 1080

        # 4. 计算居中坐标：保证窗口完全在工作区内，水平和垂直均精准居中
        final_w = min(min_w, work_w)
        final_h = min(min_h, work_h)
        target_x = work_l + max(0, (work_w - final_w) // 2)
        target_y = work_t + max(0, (work_h - final_h) // 2)

        # 5. 移动窗口并激活前台
        win32gui.MoveWindow(hwnd, target_x, target_y, final_w, final_h, True)
        time.sleep(0.08)

        # 抢前台保证焦点
        user32.keybd_event(VK_MENU, 0, 0, 0)
        win32gui.SetForegroundWindow(hwnd)
        user32.keybd_event(VK_MENU, 0, _KEYEVENTF_KEYUP, 0)

        final_l, final_t, final_r, final_b = win32gui.GetWindowRect(hwnd)
        result_rect = (final_l, final_t, final_r - final_l, final_b - final_t)
        if log:
            try:
                log(f"  ✓ 企微窗口已还原并居中至标准尺寸: {result_rect[2]}x{result_rect[3]} @ ({result_rect[0]}, {result_rect[1]})")
            except Exception:
                pass
        return (True, result_rect)
    except Exception as exc:
        return (False, f"企微窗口还原居中失败：{exc}")


def ensure_fully_visible(log=None) -> tuple:
    """mss 截屏幕像素：窗口半截出屏则截不全。若窗口超出屏幕或位置异常，自动还原居中或 Clamp 回可见区。

    返回 (True, rect)；窗口出现异常时自动恢复向下还原并居中。
    """
    _ensure_thread_dpi_aware()
    try:
        import win32gui
        u32 = _user32()
    except Exception:
        return (False, "无 win32 环境")
    hwnd = get_wecom_hwnd()
    if hwnd is None:
        return (False, "找不到企微窗口")
    try:
        # 如果窗口处于最大化，自动向下还原并居中
        if is_window_zoomed(hwnd):
            if log:
                try:
                    log("检测到企业微信处于最大化状态，正在自动向下还原并居中...")
                except Exception:
                    pass
            return restore_and_center_wecom(hwnd, log=log)

        vx = u32.GetSystemMetrics(76)
        vy = u32.GetSystemMetrics(77)
        vw = u32.GetSystemMetrics(78)
        vh = u32.GetSystemMetrics(79)
        l, t, r, b = win32gui.GetWindowRect(hwnd)
        w, h = r - l, b - t
        if w > vw or h > vh:
            # 窗口比整个虚拟屏还大（比最大化还大）：自动重置还原居中！
            if log:
                try:
                    log("检测到企业微信窗口尺寸超标（比屏幕还大），正在自动向下还原至标准最小尺寸并居中...")
                except Exception:
                    pass
            return restore_and_center_wecom(hwnd, log=log)

        nx = min(max(l, vx), vx + vw - w)
        ny = min(max(t, vy), vy + vh - h)
        if (nx, ny) != (l, t):
            if log:
                try:
                    log("检测到企业微信窗口部分飘出屏幕，已自动拉回可见区域（提示：发送或评测中请勿将窗口移出屏幕或改动大小）")
                except Exception:
                    pass
            win32gui.MoveWindow(hwnd, nx, ny, w, h, True)
            time.sleep(0.08)
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
