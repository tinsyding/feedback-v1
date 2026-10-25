"""云端视觉判定客户端：一次上传 title.png + chat_tail.png(+target 字段)到 api/identify.php。

云端上传声明（README 与此处注释保持原样）：
每次判定调用云端视觉 API 时，通过 HTTPS 上传 title.png、chat_tail.png 两张裁剪图
与 target_id/target_name 等请求字段，这是判定所必需的，由所配置的视觉服务端
处理与留存，使用前请确认服务商隐私政策。服务端收到后存档两图 + 请求/返回 JSON
用于举证复盘。客户端本地默认不长期存判定原图；reply_notes 只存本地展示给老师，
不自动上报云端。
"""

import json
import os

IDENTIFY_PATH = "/api/identify.php"
CALIBRATE_ROI_PATH = "/api/calibrate_roi.php"

# 内置默认访问令牌（小范围内部使用，开箱即用免配置）
DEFAULT_SENDER_TOKEN = "jf_feedback_sender_internal_token_2026"

_VALID_SENDERS = ("me", "parent", "unknown", None)


def load_token(explicit=None) -> str:
    """发送器访问令牌：显式参数 → 环境变量 SENDER_API_TOKEN → ~/.sender_py/config.json → 内置默认令牌。"""
    if explicit:
        return explicit
    env = (os.environ.get("SENDER_API_TOKEN") or "").strip()
    if env:
        return env
    cfg = os.path.join(os.path.expanduser("~"), ".sender_py", "config.json")
    try:
        with open(cfg, "r", encoding="utf-8") as f:
            token = (json.load(f).get("token") or "").strip()
            if token:
                return token
    except Exception:
        pass
    return DEFAULT_SENDER_TOKEN


def _as_bool_or_none(v):
    if v is True:
        return True
    if v is False:
        return False
    return None


def map_response(data: dict) -> dict:
    """纯函数：服务端 data → 严格判定 dict。matched 缺失/非真一律 False（调用方 fail-closed）。

    返回 {matched, is_group, title_in_header, detected_title,
          last_sender, last_message_text, needs_reply, reason, duration_ms}。
    """
    if not isinstance(data, dict):
        raise ValueError("判定返回不是 JSON 对象")
    sender = data.get("last_sender")
    if sender not in _VALID_SENDERS:
        sender = "unknown"
    needs = data.get("needs_reply")
    return {
        "matched": data.get("matched") is True,
        "is_group": data.get("is_group") is True,
        "title_in_header": data.get("title_in_header") is True,
        "detected_title": str(data.get("detected_title") or ""),
        "last_sender": sender,
        "last_message_text": str(data.get("last_message_text") or ""),
        "needs_reply": _as_bool_or_none(needs),
        "reason": str(data.get("reason") or ""),
        "duration_ms": int(data.get("duration_ms") or 0),
    }


def identify(title_img, chat_tail_img, target_id: str, target_name: str,
             server: str, token=None, timeout: int = 60) -> dict:
    """两图一次上传判定。requests/PIL 只在函数内导入；失败抛 RuntimeError（调用方视为不放行）。"""
    try:
        import io
        from PIL import Image  # noqa: F401  (确保 Pillow 存在，编码经 BytesIO)
        import requests
    except Exception as e:
        raise RuntimeError(f"缺少依赖（requests/Pillow）：{e}")

    server = (server or "").strip().rstrip("/")
    if not server.startswith(("http://", "https://")):
        raise RuntimeError("服务器地址必须以 http(s):// 开头")
    tok = load_token(token) or DEFAULT_SENDER_TOKEN

    def _png_bytes(img):
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()

    try:
        resp = requests.post(
            server + IDENTIFY_PATH,
            data={"target_id": target_id or "", "target_name": target_name or "", "token": tok},
            files={
                "image_title": ("title.png", _png_bytes(title_img), "image/png"),
                "image_chat": ("chat.png", _png_bytes(chat_tail_img), "image/png"),
            },
            timeout=timeout,
        )
    except Exception as e:
        raise RuntimeError(f"判定请求失败：{e}")
    try:
        payload = resp.json()
    except Exception:
        raise RuntimeError(f"判定返回非 JSON（HTTP {resp.status_code}）")
    if not isinstance(payload, dict) or not payload.get("success"):
        err = payload.get("error") if isinstance(payload, dict) else None
        raise RuntimeError(f"判定被拒绝：{err or resp.status_code}")
    return map_response(payload.get("data"))


def identify_title(title_img, target_id: str, target_name: str,
                   server: str, token=None, timeout: int = 35) -> dict:
    """快速同步通道（方案 A）：仅上传极小的标题栏截图，秒级核验会话身份与是否群聊。"""
    try:
        import io
        from PIL import Image  # noqa: F401
        import requests
    except Exception as e:
        raise RuntimeError(f"缺少依赖（requests/Pillow）：{e}")

    server = (server or "").strip().rstrip("/")
    if not server.startswith(("http://", "https://")):
        raise RuntimeError("服务器地址必须以 http(s):// 开头")
    tok = load_token(token) or DEFAULT_SENDER_TOKEN

    buf = io.BytesIO()
    title_img.save(buf, format="PNG")

    try:
        resp = requests.post(
            server + IDENTIFY_PATH,
            data={
                "mode": "title",
                "target_id": target_id or "",
                "target_name": target_name or "",
                "token": tok,
            },
            files={
                "image_title": ("title.png", buf.getvalue(), "image/png"),
            },
            timeout=timeout,
        )
    except Exception as e:
        raise RuntimeError(f"标题核验请求失败：{e}")
    try:
        payload = resp.json()
    except Exception:
        raise RuntimeError(f"标题核验返回非 JSON（HTTP {resp.status_code}）")
    if not isinstance(payload, dict) or not payload.get("success"):
        err = payload.get("error") if isinstance(payload, dict) else None
        raise RuntimeError(f"标题核验被拒绝：{err or resp.status_code}")
    return map_response(payload.get("data"))


def identify_reply(chat_tail_img, target_id: str, target_name: str,
                   detected_title: str, server: str, token=None, timeout: int = 50) -> dict:
    """后台异步通道（方案 A）：上传聊天区尾部截图，深度分析家长最后一条消息及是否需要回复。"""
    try:
        import io
        from PIL import Image  # noqa: F401
        import requests
    except Exception as e:
        raise RuntimeError(f"缺少依赖（requests/Pillow）：{e}")

    server = (server or "").strip().rstrip("/")
    if not server.startswith(("http://", "https://")):
        raise RuntimeError("服务器地址必须以 http(s):// 开头")
    tok = load_token(token) or DEFAULT_SENDER_TOKEN

    buf = io.BytesIO()
    chat_tail_img.save(buf, format="PNG")

    try:
        resp = requests.post(
            server + IDENTIFY_PATH,
            data={
                "mode": "reply",
                "target_id": target_id or "",
                "target_name": target_name or "",
                "detected_title": detected_title or "",
                "token": tok,
            },
            files={
                "image_chat": ("chat.png", buf.getvalue(), "image/png"),
            },
            timeout=timeout,
        )
    except Exception as e:
        raise RuntimeError(f"留言分析请求失败：{e}")
    try:
        payload = resp.json()
    except Exception:
        raise RuntimeError(f"留言分析返回非 JSON（HTTP {resp.status_code}）")
    if not isinstance(payload, dict) or not payload.get("success"):
        err = payload.get("error") if isinstance(payload, dict) else None
        raise RuntimeError(f"留言分析被拒绝：{err or resp.status_code}")
    return map_response(payload.get("data"))


def calibrate_roi(base_image, server: str, token=None, timeout: int = 50) -> dict | None:
    """调用服务端 Qwen-VL-Max 多模态模型自动框选企业微信窗口区域。

    成功返回相对比例 dict: {"title": tuple, "input": tuple, "chat": tuple, "reason": str}
    识别失败、网络超时或校验未通过时返回 None（供调用方优雅回退至手动框选）。
    """
    if base_image is None:
        return None
    try:
        import io
        from PIL import Image  # noqa: F401
        import requests
    except Exception:
        return None

    server = (server or "").strip().rstrip("/")
    if not server.startswith(("http://", "https://")):
        return None
    tok = load_token(token) or DEFAULT_SENDER_TOKEN

    try:
        buf = io.BytesIO()
        # 如果尺寸极大，保持原图纵横比适当压缩，减少传输延时
        img_to_send = base_image
        if hasattr(base_image, "size") and (base_image.size[0] > 1920 or base_image.size[1] > 1080):
            scale = min(1920 / base_image.size[0], 1080 / base_image.size[1])
            new_size = (max(1, int(base_image.size[0] * scale)), max(1, int(base_image.size[1] * scale)))
            img_to_send = base_image.resize(new_size, Image.LANCZOS)
        img_to_send.save(buf, format="PNG")
        raw_bytes = buf.getvalue()

        resp = requests.post(
            server + CALIBRATE_ROI_PATH,
            data={"token": tok},
            files={"image": ("window.png", raw_bytes, "image/png")},
            timeout=timeout,
        )
        if resp.status_code != 200:
            return None
        payload = resp.json()
        if not isinstance(payload, dict) or not payload.get("success"):
            return None
        data = payload.get("data")
        if not isinstance(data, dict):
            return None
        t = tuple(float(x) for x in data.get("title", []))
        i = tuple(float(x) for x in data.get("input", []))
        c = tuple(float(x) for x in data.get("chat", []))
        if len(t) != 4 or len(i) != 4 or len(c) != 4:
            return None
        return {
            "title": t,
            "input": i,
            "chat": c,
            "reason": str(data.get("reason") or "Qwen-VL-Max 自动框选成功"),
        }
    except Exception:
        return None

