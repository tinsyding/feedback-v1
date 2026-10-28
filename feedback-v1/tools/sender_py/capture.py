"""整窗截图：优先 PrintWindow 内存渲染（免遮挡、免任务栏与多屏 DPI 偏移），失败自动优雅降级为 mss 屏幕物理抓取。"""


def crop_by_rel(img, rel: tuple):
    """纯函数：按相对比例 (x, y, w, h) ∈ [0,1] 裁剪 PIL 图，越界 clamp。"""
    x, y, w, h = rel
    W, H = img.size
    ix = max(0, min(W, int(round(x * W))))
    iy = max(0, min(H, int(round(y * H))))
    iw = max(1, min(W - ix, int(round(w * W))))
    ih = max(1, min(H - iy, int(round(h * H))))
    return img.crop((ix, iy, ix + iw, iy + ih))


def _is_all_black(img) -> bool:
    """检查 PIL 图片是否为全黑图像（所有像素通道最大值均为 0）。"""
    try:
        extrema = img.getextrema()
        # RGB 模式：((min_r, max_r), (min_g, max_g), (min_b, max_b))
        if isinstance(extrema, (list, tuple)) and len(extrema) == 3:
            return all(max_v == 0 for _, max_v in extrema)
        elif isinstance(extrema, (list, tuple)) and len(extrema) == 2:
            return extrema[1] == 0
    except Exception:
        pass
    return False


def _is_invalid_or_incomplete(img, w: int, h: int) -> bool:
    """全面校验 PrintWindow 截屏图像的有效性与完整度：
    1. 全局纯黑检测：整张图所有像素通道均为 0（显卡硬件加速阻断）；
    2. 单色无内容死图：整张图为单一纯色（如纯白/纯灰，min == max）；
    3. 边缘截断/没截全检测：右下角未画满（残留 GDI 内存初始 0 底色，说明因 DPI 虚拟化导致画面右侧/底部截断）。
    """
    try:
        extrema = img.getextrema()
        # 1. 检查全局是否全黑
        if isinstance(extrema, (list, tuple)) and len(extrema) == 3:
            if all(max_v == 0 for _, max_v in extrema):
                return True
            # 2. 检查单色死图
            if all(min_v == max_v for min_v, max_v in extrema):
                return True
        elif isinstance(extrema, (list, tuple)) and len(extrema) == 2:
            if extrema[1] == 0 or extrema[0] == extrema[1]:
                return True

        # 3. 检查右下角未渲染（没截全）
        # 企微右下角为输入框与发送按钮区域（非全黑背景）。
        # 若右下角采样区域全为 0，说明 PrintWindow 未能绘制到窗口边缘（存在截断）。
        if w >= 200 and h >= 150:
            corner_w = min(60, w // 4)
            corner_h = min(60, h // 4)
            corner = img.crop((w - corner_w, h - corner_h, w, h))
            c_extrema = corner.getextrema()
            if isinstance(c_extrema, (list, tuple)) and len(c_extrema) == 3:
                if all(max_v == 0 for _, max_v in c_extrema):
                    return True
    except Exception:
        pass
    return False


def _capture_by_printwindow(hwnd, w: int, h: int):
    """首选引擎：PrintWindow (PW_RENDERFULLCONTENT=2) 后台内存抓取。

    优势：
    1. 即使窗口被其他程序（浏览器、文件、通知弹窗）遮挡，也能抓取纯净企微界面；
    2. 不受多显示器负坐标、任务栏厚度以及 DPI 阴影边框偏移的干扰。
    若被显卡硬件加速阻断（画面全黑）或调用失败，返回 None 触发 mss 降级。
    """
    try:
        import win32gui
        import win32ui
        import ctypes
        from PIL import Image

        if not hwnd or not win32gui.IsWindow(hwnd):
            return None

        # 确保尺寸精准对齐当前物理尺寸
        try:
            l, t, r, b = win32gui.GetWindowRect(hwnd)
            cur_w, cur_h = r - l, b - t
            if cur_w >= 200 and cur_h >= 150:
                w, h = cur_w, cur_h
        except Exception:
            pass

        hdc = win32gui.GetWindowDC(hwnd)
        if not hdc:
            return None

        src_dc = None
        mdc = None
        bmp = None
        old_obj = None
        try:
            src_dc = win32ui.CreateDCFromHandle(hdc)
            mdc = src_dc.CreateCompatibleDC()
            bmp = win32ui.CreateBitmap()
            bmp.CreateCompatibleBitmap(src_dc, w, h)
            old_obj = mdc.SelectObject(bmp)

            # PW_RENDERFULLCONTENT = 2
            ret = ctypes.windll.user32.PrintWindow(hwnd, mdc.GetSafeHdc(), 2)
            if not ret:
                ret = ctypes.windll.user32.PrintWindow(hwnd, mdc.GetSafeHdc(), 0)

            if ret:
                bits = bmp.GetBitmapBits(True)
                img = Image.frombuffer("RGB", (w, h), bits, "raw", "BGRX", 0, 1)

                # 严格校验：若画面全黑或没截全（未画满残留黑底），判定为无效，自动退回 mss 降级
                if _is_invalid_or_incomplete(img, w, h):
                    return None
                return img
        finally:
            if mdc and bmp and old_obj:
                try:
                    mdc.SelectObject(old_obj)
                except Exception:
                    pass
            if bmp:
                try:
                    win32gui.DeleteObject(bmp.GetHandle())
                except Exception:
                    pass
            if mdc:
                try:
                    mdc.DeleteDC()
                except Exception:
                    pass
            if src_dc:
                try:
                    src_dc.DeleteDC()
                except Exception:
                    pass
            try:
                win32gui.ReleaseDC(hwnd, hdc)
            except Exception:
                pass
    except Exception:
        return None
    return None


def _capture_by_mss(rect):
    """降级备用引擎：mss 物理屏幕区域抓取（原有方案完整保留）。"""
    if not rect or len(rect) < 4:
        return None
    x, y, w, h = rect[:4]
    # 自动安全守护：若坐标为负（部分飘出屏幕，如藏在左边），自动将其拉回可视区域
    if x < 0 or y < 0:
        try:
            try:
                from sender_py.window_utils import ensure_fully_visible
            except ModuleNotFoundError:
                from window_utils import ensure_fully_visible
            ok, fresh = ensure_fully_visible()
            if ok and fresh and len(fresh) >= 4:
                rect = fresh
                x, y, w, h = rect[:4]
        except Exception:
            pass
    try:
        import mss
    except Exception:
        return None
    try:
        with mss.mss() as sct:
            shot = sct.grab({"left": int(x), "top": int(y), "width": int(w), "height": int(h)})
            from PIL import Image
            return Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
    except Exception:
        return None


def capture_wecom_window(rect=None, hwnd=None):
    """截取企微主窗口图像 -> PIL RGB 原图（不做缩放；w<200 或 h<150 返回 None）。

    双引擎机制：
    1. 优先调用 PrintWindow 内存渲染：无遮挡、无屏幕边缘偏移；
    2. 若 PrintWindow 不可用或画面全黑，自动无缝降级为 mss 物理屏幕抓取。
    """
    try:
        try:
            from sender_py.window_utils import _ensure_thread_dpi_aware
        except ModuleNotFoundError:
            from window_utils import _ensure_thread_dpi_aware
        _ensure_thread_dpi_aware()
    except Exception:
        pass

    if rect is None or not (isinstance(rect, (list, tuple)) and len(rect) >= 4):
        try:
            from sender_py.window_utils import get_wecom_rect
        except ModuleNotFoundError:
            from window_utils import get_wecom_rect
        rect = get_wecom_rect()

    if not rect or len(rect) < 4:
        return None

    x, y, w, h = rect[:4]
    if w < 200 or h < 150:
        return None

    # ---- 1. 首选引擎：PrintWindow ----
    try:
        target_hwnd = hwnd
        if target_hwnd is None:
            try:
                from sender_py.window_utils import get_wecom_hwnd
            except ModuleNotFoundError:
                from window_utils import get_wecom_hwnd
            target_hwnd = get_wecom_hwnd()

        if target_hwnd:
            img = _capture_by_printwindow(target_hwnd, int(w), int(h))
            if img is not None:
                return img
    except Exception:
        pass

    # ---- 2. 降级引擎：原有 mss 抓取 ----
    return _capture_by_mss(rect)
