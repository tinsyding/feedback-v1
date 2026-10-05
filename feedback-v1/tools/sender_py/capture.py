"""整窗截图：主截图只许 mss；Windows 调用与纯逻辑分离，纯函数可在 Linux 单测。"""


def crop_by_rel(img, rel: tuple):
    """纯函数：按相对比例 (x, y, w, h) ∈ [0,1] 裁剪 PIL 图，越界 clamp。"""
    x, y, w, h = rel
    W, H = img.size
    ix = max(0, min(W, int(round(x * W))))
    iy = max(0, min(H, int(round(y * H))))
    iw = max(1, min(W - ix, int(round(w * W))))
    ih = max(1, min(H - iy, int(round(h * H))))
    return img.crop((ix, iy, ix + iw, iy + ih))


def capture_wecom_window(rect=None):
    """mss.grab 整窗 -> PIL RGB 原图，不做缩放；w<200 或 h<150 返回 None。

    mss 只在函数内导入，Linux 无 mss 时返回 None 由调用方处理。
    """
    if rect is None:
        try:
            from sender_py.window_utils import get_wecom_rect
        except ModuleNotFoundError:
            from window_utils import get_wecom_rect
        rect = get_wecom_rect()
    if not rect:
        return None
    x, y, w, h = rect
    if w < 200 or h < 150:
        return None
    try:
        import mss
    except Exception:
        return None
    with mss.mss() as sct:
        shot = sct.grab({"left": int(x), "top": int(y), "width": int(w), "height": int(h)})
        from PIL import Image
        return Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
