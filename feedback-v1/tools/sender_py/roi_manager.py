"""ROI 存储/签名/反推（阶段 3 实现纯函数；此处仅占位，接口形状先行冻结）。"""

ROUND_DIGITS = 3


def window_signature(w: int, h: int, scale: float) -> dict:
    raise NotImplementedError


def derive_chat(title_abs, input_abs, img_size):
    raise NotImplementedError


def validate_rel(rel) -> bool:
    raise NotImplementedError


def needs_calibration(*args, **kwargs) -> bool:
    raise NotImplementedError


def crop_chat_tail(chat_img, ratio: float = 0.28):
    raise NotImplementedError
