"""窗口查找（Windows 专属，win32gui/ctypes 只在函数内导入，Linux 导入本模块不报错）。"""


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
    """标题含企业微信/WeCom（兼容 WeCom），过滤 Wedoc，面积>300x300。无则返回 None。"""
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
            if ("WeWorkWindow" in cls or "企业微信" in title or "WeCom" in title or "WXWork" in cls) and "Wedoc" not in cls:
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
