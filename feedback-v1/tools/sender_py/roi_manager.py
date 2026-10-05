"""ROI 存储、签名与反推（纯函数，Linux 可全测；Windows 调用不进本模块）。

约定：绝对坐标均为原图像素 (x, y, w, h)；相对比例 rel=(x/W, y/H, w/W, h/H)。
"""

import json
import os

ROUND_DIGITS = 3
CHAT_MIN_H = 40
TAIL_RATIO = 0.28
TAIL_MIN_PX = 160
TAIL_MAX_PX = 560


def window_signature(w: int, h: int, scale: float) -> dict:
    """窗口签名：标题不进 Key，只有宽高 + round3 后的 scale。"""
    return {"w": int(w), "h": int(h), "scale": round(float(scale), ROUND_DIGITS)}


def signature_key(w: int, h: int, scale: float) -> str:
    """Key=f"{w}x{h}@{scale:.3f}"。"""
    return f"{int(w)}x{int(h)}@{float(scale):.3f}"


def _as_box(box) -> tuple:
    x, y, w, h = box
    return (int(round(x)), int(round(y)), int(round(w)), int(round(h)))


def derive_chat(title_abs, input_abs, img_size) -> tuple:
    """由标题栏/输入框反推中间聊天区。

    chat.y=title.y+title.h；chat.h=input.y-(title.y+title.h)；
    chat.x=min(title.x,input.x)；chat.w=max(right)-chat.x。
    非法抛 ValueError，文案必须告诉用户怎么重框。
    """
    tx, ty, tw, th = _as_box(title_abs)
    ix, iy, iw, ih = _as_box(input_abs)
    W, H = int(img_size[0]), int(img_size[1])
    if tw < 40 or th < 20 or iw < 40 or ih < 20:
        raise ValueError(
            "框太小（标题/输入框在原图尺度宽≥40且高≥20才有效），"
            "请重新校准：先框顶部标题栏，再框底部输入框，框要贴边框足。"
        )
    title_bottom = ty + th
    if iy <= title_bottom:
        raise ValueError(
            "输入框压住了标题栏（输入框上沿必须在标题栏下沿之下），"
            "请重新校准：先框顶部标题栏（蓝），再框底部输入框（红）。"
        )
    chat_x = min(tx, ix)
    chat_y = title_bottom
    chat_w = max(tx + tw, ix + iw) - chat_x
    chat_h = iy - title_bottom
    if chat_h < CHAT_MIN_H:
        raise ValueError(
            f"反推聊天区高度仅 {chat_h}px（至少 {CHAT_MIN_H}px），"
            "请重新校准：标题栏框到顶、输入框框到底，中间留出聊天区。"
        )
    if chat_x < 0 or chat_y < 0 or chat_w <= 0 or chat_x + chat_w > W or chat_y + chat_h > H:
        raise ValueError(
            "反推聊天区超出截图范围，请重新校准：两框都必须在企微窗口图内，"
            "不要框到窗口外面。"
        )
    return (chat_x, chat_y, chat_w, chat_h)


def to_rel(box_abs, img_size) -> tuple:
    """绝对坐标 → 相对比例（只用原图坐标算）。"""
    x, y, w, h = box_abs
    W, H = img_size
    return (x / W, y / H, w / W, h / H)


def to_abs(rel, img_size) -> tuple:
    """相对比例 → 绝对坐标（四舍五入到像素）。"""
    x, y, w, h = rel
    W, H = img_size
    return (int(round(x * W)), int(round(y * H)), int(round(w * W)), int(round(h * H)))


def validate_rel(rel) -> bool:
    """相对比例越界校验：分量∈[0,1]、宽高>0、右下角不超界（容差 1e-6）。"""
    try:
        x, y, w, h = (float(v) for v in rel)
    except Exception:
        return False
    eps = 1e-6
    if not (0 - eps <= x <= 1 + eps and 0 - eps <= y <= 1 + eps):
        return False
    if not (w > 0 and h > 0 and w <= 1 + eps and h <= 1 + eps):
        return False
    if x + w > 1 + eps or y + h > 1 + eps:
        return False
    return True


def default_config_path() -> str:
    """roi_config.json 存 store 数据目录（~/.sender_py）。"""
    return os.path.join(os.path.expanduser("~"), ".sender_py", "roi_config.json")


def save_roi(config_path: str, sig_key: str, title_rel, input_rel, chat_rel):
    """title/input/反推 chat 全转相对比例存盘。非法 rel 直接抛 ValueError。"""
    for name, rel in (("title", title_rel), ("input", input_rel), ("chat", chat_rel)):
        if not validate_rel(rel):
            raise ValueError(f"ROI 非法：{name}={rel} 越界，请重新框选后再保存。")
    cfg = {}
    if os.path.isfile(config_path):
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception:
            cfg = {}
    if not isinstance(cfg, dict) or not isinstance(cfg.get("signatures"), dict):
        cfg = {"signatures": {}}
    cfg["signatures"][sig_key] = {
        "title": list(title_rel),
        "input": list(input_rel),
        "chat": list(chat_rel),
    }
    os.makedirs(os.path.dirname(os.path.abspath(config_path)), exist_ok=True)
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def load_roi(config_path: str, sig_key: str):
    """命中签名返回 {"title","input","chat"} rel 元组，否则返回 None。"""
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        entry = cfg["signatures"][sig_key]
        return {"title": tuple(entry["title"]), "input": tuple(entry["input"]), "chat": tuple(entry["chat"])}
    except Exception:
        return None


def needs_calibration(config_path: str, sig_key: str) -> bool:
    """无文件/签名未命中/ROI 非法 → True（调用方先重校准再截图）。"""
    if not os.path.isfile(config_path):
        return True
    roi = load_roi(config_path, sig_key)
    if roi is None:
        return True
    return not all(validate_rel(roi[k]) for k in ("title", "input", "chat"))


def crop_chat_tail(chat_img, ratio: float = TAIL_RATIO):
    """纯函数：截聊天区末尾。tail_h=clamp(round(H*ratio),160,560)；H<160 则取整张。"""
    W, H = chat_img.size
    tail_h = int(round(H * ratio))
    tail_h = max(TAIL_MIN_PX, min(TAIL_MAX_PX, tail_h))
    tail_h = min(H, tail_h)
    return chat_img.crop((0, H - tail_h, W, H))
