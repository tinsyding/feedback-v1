"""主流程：下一学生→搜人进会话→整窗截图→裁两图→identify→MATCH 则粘贴发送。

红线：is_group=true 一律拦截；matched 假/缺失不放行（fail-closed）；
needs_reply null/缺失照发 + 记“待人工确认”（fail-open）。
tkinter/requests/PIL/mss 只在 Windows 流程函数内导入；决策纯函数 Linux 可单测。
"""

import os
import random
import sys
import threading
import time

APP_NAME = "极方每周反馈程序"
APP_VERSION = "1.3.0"


def asset_path(filename: str) -> str:
    """返回运行时资源路径：onefile 解压目录优先，源码运行回退到 feedback-v1/。"""
    if getattr(sys, "frozen", False) and getattr(sys, "_MEIPASS", None):
        return os.path.join(sys._MEIPASS, filename)
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, "..", "..", filename))


def app_icon_path():
    """网站 favicon 作为程序图标；找不到时返回 None。"""
    path = asset_path("favicon.ico")
    return path if os.path.isfile(path) else None


try:  # 仓库结构优先；散装拷贝（文件同目录）兜底
    from sender_py.pacing import AFTER_SEND_GAP, CANDIDATE_GAP, STUDENT_GAP, pause
    from sender_py.reply_notes import actionable, dedupe_add, make_note, should_record
    from sender_py.roi_manager import (
        crop_chat_tail, default_config_path, derive_chat, load_roi, needs_calibration,
        save_roi, signature_key, to_abs, to_rel, validate_rel, window_signature,
    )
    from sender_py.utils import load_feedback_items
except ModuleNotFoundError:
    from pacing import AFTER_SEND_GAP, CANDIDATE_GAP, STUDENT_GAP, pause
    from reply_notes import actionable, dedupe_add, make_note, should_record
    from roi_manager import (
        crop_chat_tail, default_config_path, derive_chat, load_roi, needs_calibration,
        save_roi, signature_key, to_abs, to_rel, validate_rel, window_signature,
    )
    from utils import load_feedback_items

MAX_CANDIDATES = 3
# 临时关闭“已发送自动跳过”，方便用同一文件反复测试；恢复时改为 True。
SKIP_SENT = False

FILTER_ALL = "全部"
FILTER_FAILED = "失败/未匹配"
FILTER_VALUES = (FILTER_ALL, "待发送", "已发送", FILTER_FAILED, "已跳过", "已拦截")


# ================= 纯决策（无依赖，可单测） =================

def status_matches_filter(status: str, filter_name: str) -> bool:
    """状态筛选：待发送/已发送/失败/跳过/拦截。"""
    if not filter_name or filter_name == FILTER_ALL:
        return True
    if filter_name == FILTER_FAILED:
        return status in ("发送失败", "未匹配")
    if filter_name == "已跳过":
        return status in ("已跳过", "已跳过（已发送）")
    return status == filter_name


def summarize_status_counts(statuses) -> dict:
    """把一批学生状态压成结束汇总；未处理状态归入跳过。"""
    counts = {"已发送": 0, "发送失败": 0, "已拦截": 0, "未匹配": 0, "已跳过": 0}
    for status in statuses:
        if status == "已跳过（已发送）":
            counts["已跳过"] += 1
        elif status in counts:
            counts[status] += 1
        elif status in ("待发送", "发送中"):
            counts["已跳过"] += 1
    return counts


def decide_action(judgment) -> dict:
    """单候选决策：send=放行发送 / next=换下一候选 / intercept=拦截本学生。

    judgment 为 None（抓帧/判定失败）→ next，由调用方记日志。
    """
    if not isinstance(judgment, dict):
        return {"action": "next", "reason": "判定失败（抓帧或接口异常），换下一候选"}
    if judgment.get("is_group") is True:
        return {"action": "intercept", "reason": "群聊一律拦截"}
    if judgment.get("matched") is True:
        if judgment.get("needs_reply") is None:
            return {"action": "send", "reason": "MATCH；待回判不出，照发+记待人工确认"}
        return {"action": "send", "reason": "MATCH"}
    return {"action": "next", "reason": "会话标题与目标不符，换下一候选"}


def run_candidate_outcomes(judgments: list) -> dict:
    """纯函数：按 1→2→3 机械顺序推演整学生结局（供单测）。"""
    notes = []
    for idx, judgment in enumerate(list(judgments)[:MAX_CANDIDATES], start=1):
        decision = decide_action(judgment)
        if decision["action"] == "send":
            return {"result": "sent", "at_candidate": idx, "reason": decision["reason"], "notes": notes}
        if decision["action"] == "intercept":
            return {"result": "blocked", "at_candidate": idx, "reason": decision["reason"], "notes": notes}
    return {"result": "unmatched", "at_candidate": min(len(judgments), MAX_CANDIDATES),
            "reason": "3 候选均未 MATCH", "notes": notes}


def archive_key_for_input(input_path: str) -> str:
    """存档键：输入文件名（去扩展名）+ [第 1 周]，兼容旧 classes 结构。"""
    base = os.path.splitext(os.path.basename(input_path or "未命名"))[0]
    return f"{base} [第 1 周]"


def load_feedback_inputs(paths) -> tuple:
    """读取多个 JSON / HTML，合并并按学号+姓名去重，给每条数据标上来源存档键。

    返回 (items, file_counts, duplicate_count)：
      items: 合并后的反馈条目
      file_counts: [(path, 该文件有效条目数), ...]
      duplicate_count: 跨文件/文件内被去掉的重复条目数
    """
    merged = []
    seen = set()
    file_counts = []
    duplicate_count = 0
    for path in paths:
        loaded = load_feedback_items(path)
        file_counts.append((path, len(loaded)))
        key = archive_key_for_input(path)
        for item in loaded:
            sid = (item.get("sid") or "").strip()
            sname = (item.get("sname") or "").strip()
            identity = (sid, sname) if (sid or sname) else (item.get("studentName") or "", "")
            if identity in seen:
                duplicate_count += 1
                continue
            seen.add(identity)
            item["_archive_key"] = key
            merged.append(item)
    return merged, file_counts, duplicate_count


def candidate_search_plan(candidate_index: int) -> list:
    """候选定位按键：先按 Down 选中第 N 个搜索结果，最后 Enter 进入会话。

    企业微信粘贴搜索词后结果列表已经刷新；不能先按 Enter，否则会直接进入
    第一个结果，Down 就变成在会话里移动，第二个候选会选错。
    """
    return ["down"] * max(0, int(candidate_index) - 1) + ["enter"]


# ================= Windows 动作（需真机验证） =================

def safe_copy(text: str, retries: int = 5) -> bool:
    """剪贴板写入 + 粘出核验，防止发错上一次的内容。"""
    import pyperclip
    for _ in range(retries):
        try:
            pyperclip.copy(text)
            time.sleep(0.05)
            if pyperclip.paste() == text:
                return True
        except Exception:
            time.sleep(0.05)
    return False


def search_and_enter(name: str, candidate_index: int) -> bool:
    """搜人进会话：第 candidate_index 个结果。Ctrl+F 聚焦→全选→Backspace 清空→粘贴→等结果→Down 定位→回车进会话。"""
    try:
        from sender_py import window_utils as wu
    except ModuleNotFoundError:
        import window_utils as wu
    if not wu.find_and_activate_wecom():
        return False
    time.sleep(0.2)
    wu.tap_keys(wu.VK_CONTROL, wu.VK_F)
    time.sleep(0.15)
    wu.tap_keys(wu.VK_CONTROL, wu.VK_A)
    time.sleep(0.1)
    wu.tap_key(0x08)  # Backspace：清掉搜索框残留，防粘贴追加
    time.sleep(0.1)
    if not safe_copy(name):
        return False
    wu.tap_keys(wu.VK_CONTROL, wu.VK_V)
    time.sleep(1.0)  # 等搜索结果列表刷新；先 Down 选中候选，最后再 Enter
    for action in candidate_search_plan(candidate_index):
        if action == "down":
            wu.tap_key(wu.VK_DOWN)
            time.sleep(0.2)
        else:
            wu.tap_key(wu.VK_RETURN)
            time.sleep(1.2)  # 等会话切换渲染完再截图
    return wu.is_foreground_wecom()


def paste_and_send(message: str) -> tuple:
    """剪贴板粘贴发送（含前后核验 + 焦点守护）。返回 (ok, reason)。"""
    try:
        from sender_py import window_utils as wu
    except ModuleNotFoundError:
        import window_utils as wu
    if not wu.is_foreground_wecom():
        if not wu.find_and_activate_wecom():
            return (False, "企微不在前台且唤起失败")
        time.sleep(0.2)
    if not safe_copy(message):
        return (False, "剪贴板写入核验失败")
    wu.tap_keys(wu.VK_CONTROL, wu.VK_V)
    time.sleep(0.3)
    try:
        import pyperclip
        if pyperclip.paste() != message:
            return (False, "粘贴后剪贴板被篡改，停止发送")
    except Exception:
        pass
    wu.tap_key(wu.VK_RETURN)
    return (True, "已发送")


def ensure_roi(parent, rect, scale, config_path: str = None, server: str = None,
               token=None, log=print, force: bool = False):
    """每个候选处理前检查窗口签名；变了先校准再截图。优先 AI 自动框选，失败优雅回退手动校准。返回 rel roi 或 None（放弃）。"""
    config_path = config_path or default_config_path()
    key = signature_key(rect[2], rect[3], scale)
    if not force and not needs_calibration(config_path, key):
        return load_roi(config_path, key)
    try:
        from sender_py.capture import capture_wecom_window
        from sender_py.roi_calibrator import run_calibration
    except ModuleNotFoundError:
        from capture import capture_wecom_window
        from roi_calibrator import run_calibration
    try:  # 校准画布必须是没有遮挡的实拍：先把企微顶到最前再截
        try:
            from sender_py import window_utils as wu
        except ModuleNotFoundError:
            import window_utils as wu
        wu.find_and_activate_wecom()
        time.sleep(0.4)
        fresh = wu.get_wecom_rect()
        if fresh and fresh[2] >= 200 and fresh[3] >= 150:
            rect = fresh
    except Exception:
        pass
    img = capture_wecom_window(rect)
    if img is None:
        return None

    # 1. 优先调用 Qwen-VL-Max 多模态旗舰模型智能自动框选
    ai_roi = None
    try:
        try:
            from sender_py.vision_api import calibrate_roi
        except ModuleNotFoundError:
            from vision_api import calibrate_roi
        log("正在使用 Qwen-VL-Max 多模态模型自动识别企微窗口区域...")
        ai_roi = calibrate_roi(img, server=server or "https://feedback.wxjifang.cn", token=token)
    except Exception as exc:
        log(f"AI 自动识别网络异常：{exc}")

    if ai_roi and isinstance(ai_roi, dict) and all(k in ai_roi for k in ("title", "input", "chat")):
        if all(validate_rel(ai_roi[k]) for k in ("title", "input", "chat")):
            log(f"✓ Qwen-VL-Max 自动框选成功（{ai_roi.get('reason', '')}），已自动生效！")
            save_roi(config_path, key, ai_roi["title"], ai_roi["input"], ai_roi["chat"])
            return {"title": tuple(ai_roi["title"]), "input": tuple(ai_roi["input"]), "chat": tuple(ai_roi["chat"])}
        else:
            log("AI 识别坐标超出有效范围，正在回退至手动校准...")
    else:
        log("AI 自动定位未通过（可能未点进具体聊天），正在弹出手动校准窗口...")

    # 2. 优雅回退到手动框选（弹出居中大窗口，若有 AI 坐标则自动预填）
    roi = run_calibration(parent, img, initial_roi=ai_roi)
    if roi is None:
        return None
    save_roi(config_path, key, roi["title"], roi["input"], roi["chat"])
    return {"title": tuple(roi["title"]), "input": tuple(roi["input"]), "chat": tuple(roi["chat"])}


def judge_candidate(rect, roi, target_id: str, target_name: str, server: str, token=None) -> tuple:
    """整窗截图→裁 title/chat_tail→identify 一次判定。返回 (judgment|None, chat_title|None, error|None)。"""
    try:
        from sender_py.capture import capture_wecom_window, crop_by_rel
        from sender_py.vision_api import identify
    except ModuleNotFoundError:
        from capture import capture_wecom_window, crop_by_rel
        from vision_api import identify
    img = capture_wecom_window(rect)
    if img is None:
        return (None, None, "整窗截图失败")
    W, H = img.size
    title_abs = to_abs(roi["title"], (W, H))
    chat_abs = to_abs(roi["chat"], (W, H))
    title_img = crop_by_rel(img, roi["title"])
    chat_img = crop_chat_tail(crop_by_rel(img, roi["chat"]))
    _ = (title_abs, chat_abs)
    try:
        judgment = identify(title_img, chat_img, target_id, target_name, server, token)
    except Exception as e:
        return (None, None, str(e))
    return (judgment, judgment.get("detected_title"), None)


def send_student(item: dict, server: str, token=None, config_path: str = None,
                 parent=None, log=print, should_stop=None) -> dict:
    """单个学生全流程：最多 3 候选机械 1→2→3。返回 {result, notes, ...}（notes 供待回名单）。"""
    try:
        from sender_py import window_utils as wu
    except ModuleNotFoundError:
        import window_utils as wu
    name, sid, sname, message = item["studentName"], item["sid"], item["sname"], item["message"]
    notes = []

    def _paced(gaps):
        log(f"[{name}] 随机停顿 {pause(*gaps):.1f}s")

    for cand in range(1, MAX_CANDIDATES + 1):
        if should_stop is not None and should_stop():
            log(f"[{name}] 收到停止请求，当前学生未发送")
            return {"result": "stopped", "reason": "用户停止", "notes": notes}
        # 所有截图的前提：企微完整可见，否则 mss 截到遮挡物/屏外黑边
        if not wu.find_and_activate_wecom():
            return {"result": "error", "reason": "企微唤起失败（最小化或无响应），请手动点开后重试",
                    "notes": notes}
        time.sleep(0.3)
        ok_vis, vis = wu.ensure_fully_visible()
        if not ok_vis:
            return {"result": "error", "reason": f"窗口半截在屏幕外且无法自动归位：{vis}",
                    "notes": notes}
        rect = vis
        if not rect:
            return {"result": "error", "reason": "找不到企微窗口", "notes": notes}
        scale = wu.get_dpi_scale()
        roi = ensure_roi(parent, rect, scale, config_path, server=server, token=token, log=log)
        if roi is None:
            return {"result": "error", "reason": "ROI 校准未完成", "notes": notes}
        if should_stop is not None and should_stop():
            log(f"[{name}] 收到停止请求，候选{cand}未发送")
            return {"result": "stopped", "reason": "用户停止", "notes": notes}
        entered = search_and_enter(name, cand)
        if entered:  # 截图前焦点守护：mss 截的是屏幕像素，失焦会被遮挡物污染
            if not wu.find_and_activate_wecom():
                log(f"[{name}] 候选{cand}：企微唤起失败，换下一候选")
                _paced(CANDIDATE_GAP)
                continue
            time.sleep(0.3)
        if should_stop is not None and should_stop():
            log(f"[{name}] 收到停止请求，候选{cand}未发送")
            return {"result": "stopped", "reason": "用户停止", "notes": notes}
        judgment, chat_title, err = judge_candidate(rect, roi, sid, sname, server, token)
        if entered and should_record(chat_title, judgment):
            dedupe_add(notes, make_note(name, cand, chat_title, bool((judgment or {}).get("matched")), judgment or {}))
        if err is not None:
            log(f"[{name}] 候选{cand}：{err}，换下一候选")
            _paced(CANDIDATE_GAP)
            continue
        decision = decide_action(judgment)
        log(f"[{name}] 候选{cand}：{decision['action']}（{decision['reason']}）")
        if decision["action"] == "send":
            if should_stop is not None and should_stop():
                log(f"[{name}] 收到停止请求，候选{cand}未发送")
                return {"result": "stopped", "reason": "用户停止", "notes": notes}
            ok, why = paste_and_send(message)
            if should_stop is None or not should_stop():
                _paced(AFTER_SEND_GAP)
            return {"result": "sent" if ok else "error",
                    "at_candidate": cand, "reason": why, "notes": notes}
        if decision["action"] == "intercept":
            return {"result": "blocked", "at_candidate": cand,
                    "reason": decision["reason"], "notes": notes}
        _paced(CANDIDATE_GAP)
    return {"result": "unmatched", "reason": "3 候选均未 MATCH", "notes": notes}


# ================= Tk 主界面 =================

class SenderApp:
    def __init__(self, root, items: list, server: str, archive_key: str, input_paths=None):
        import tkinter as tk
        from tkinter import ttk
        self.tk = tk
        self.items = items
        self.server = server
        self.archive_key = archive_key
        self.input_paths = list(input_paths or [])
        self.duplicate_count = 0
        self.reply_notes = []
        self._history = None
        try:
            try:
                from sender_py.store import HistoryManager
            except ModuleNotFoundError:
                from store import HistoryManager
            self._history = HistoryManager()
        except Exception:
            pass
        self.root = root
        self._ttk = ttk
        self.log_buffer = []
        self.log_window = None
        self.log_text = None
        self._running = False
        self._stop_requested = False
        self._stop_announced = False
        self._esc_watch_stop = None
        self._close_after_stop = False
        self._search_after = None
        self._suspend_filter = False
        self._row_checkbuttons = []
        self._row_action_buttons = []

        self._setup_appearance(root)
        root.title(APP_NAME)
        root.geometry("1040x700")
        root.minsize(920, 620)
        root.protocol("WM_DELETE_WINDOW", self.on_close)
        root.bind("<Escape>", self.request_stop)

        self._build_ui()
        self.search_var.trace_add("write", self._on_search_change)
        self.rebuild_student_list()

    def _setup_appearance(self, root):
        """字体、sv-ttk 主题、状态色、网站 logo；避免主界面停留在 Tk 默认外观。"""
        import tkinter.font as tkfont

        ttk = self._ttk
        available = set()
        try:
            available = set(tkfont.families(root))
        except Exception:
            pass
        family = next(
            (name for name in ("Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI",
                               "DejaVu Sans", "Arial") if name in available),
            "Arial",
        )
        self._font_family = family
        self._using_sv_ttk = False
        try:
            import sv_ttk
            sv_ttk.set_theme("light")
            self._using_sv_ttk = True
        except Exception:
            try:
                ttk.Style(root).theme_use("vista" if sys.platform == "win32" else "clam")
            except Exception:
                pass

        # 主题设置完再覆盖命名字体，确保中文在 Entry/Combobox/Checkbutton 里也一致。
        for name in ("TkDefaultFont", "TkTextFont", "TkMenuFont", "TkHeadingFont"):
            try:
                tkfont.nametofont(name).configure(family=family, size=10)
            except Exception:
                pass

        style = ttk.Style(root)
        self._style = style
        app_bg = "#f8fafc"
        card_bg = "#ffffff"

        try:
            root.configure(bg=app_bg)
        except Exception:
            pass

        # Card & Container Styles
        style.configure("MainBg.TFrame", background=app_bg)
        style.configure("Card.TFrame", background=card_bg)
        style.configure("TableHeader.TFrame", background="#f1f5f9")

        # Typography & Labels
        style.configure("AppTitle.TLabel", font=(family, 15, "bold"), foreground="#0f172a", background=card_bg)
        style.configure("AppSubtitle.TLabel", font=(family, 9), foreground="#64748b", background=card_bg)
        style.configure("VersionBadge.TLabel", font=(family, 8, "bold"), foreground="#0284c7", background="#e0f2fe", padding=(5, 1))
        style.configure("StatTitle.TLabel", font=(family, 9), foreground="#64748b", background=card_bg)
        style.configure("StatNum.TLabel", font=(family, 12, "bold"), foreground="#0f172a", background=card_bg)
        style.configure("StatNumGreen.TLabel", font=(family, 12, "bold"), foreground="#15803d", background=card_bg)
        style.configure("StatNumRed.TLabel", font=(family, 12, "bold"), foreground="#b91c1c", background=card_bg)
        style.configure("HeaderCol.TLabel", font=(family, 9, "bold"), foreground="#475569", background="#f1f5f9")
        style.configure("IdBadge.TLabel", font=("Consolas", 9), foreground="#475569", background="#f1f5f9", padding=(4, 1))
        style.configure("RowName.TLabel", font=(family, 10, "bold"), foreground="#1e293b", background=card_bg)
        style.configure("RowReason.TLabel", font=(family, 9), foreground="#64748b", background=card_bg)
        style.configure("EmptyTitle.TLabel", font=(family, 12, "bold"), foreground="#334155", background=card_bg)
        style.configure("EmptyDesc.TLabel", font=(family, 9), foreground="#94a3b8", background=card_bg)
        style.configure("Hint.TLabel", font=(family, 9), foreground="#64748b", background=card_bg)
        style.configure("Muted.TLabel", font=(family, 9), foreground="#64748b", background=card_bg)
        style.configure("Section.TLabel", font=(family, 10, "bold"), foreground="#111827", background=card_bg)
        style.configure("Logo.TLabel", font=(family, 22, "bold"), foreground="#2563eb", background=card_bg)

        # Button Styles
        style.configure("TButton", font=(family, 9))
        style.configure("Toolbar.TButton", font=(family, 9), padding=(7, 3))
        style.configure("Secondary.TButton", font=(family, 9), padding=(8, 4))
        style.configure("RowAction.TButton", font=(family, 8), padding=(5, 2))
        style.configure("PrimaryLarge.TButton", font=(family, 10, "bold"), padding=(14, 6))
        style.configure("Danger.TButton", font=(family, 9, "bold"), foreground="#dc2626", padding=(9, 4))

        self._accent_style = "Accent.TButton" if self._using_sv_ttk else "TButton"
        if self._using_sv_ttk:
            style.configure("Accent.TButton", font=(family, 10, "bold"), padding=(12, 5))

        self._status_styles = {}
        for idx, (status, pal) in enumerate(self.STATUS_PALETTE.items()):
            style_name = f"Status{idx}.TLabel"
            style.configure(
                style_name,
                foreground=pal["fg"],
                background=pal["bg"],
                font=(family, 8, "bold"),
                padding=(5, 2),
                anchor="center",
            )
            self._status_styles[status] = style_name
        style.configure(
            "StatusDefault.TLabel",
            foreground="#475569",
            background="#f1f5f9",
            font=(family, 8, "bold"),
            padding=(5, 2),
            anchor="center",
        )
        self._status_styles[""] = "StatusDefault.TLabel"

        self._logo_image = None
        self._window_icon = None
        icon_path = app_icon_path()
        if icon_path:
            try:
                from PIL import Image, ImageTk
                source = Image.open(icon_path).convert("RGBA")
                logo = source.copy()
                logo.thumbnail((44, 44), Image.LANCZOS)
                self._logo_image = ImageTk.PhotoImage(logo)
                window_icon = source.copy()
                window_icon.thumbnail((64, 64), Image.LANCZOS)
                self._window_icon = ImageTk.PhotoImage(window_icon)
                try:
                    root.iconphoto(True, self._window_icon)
                except Exception:
                    pass
                try:
                    root.iconbitmap(default=icon_path)
                except Exception:
                    pass
            except Exception:
                try:
                    root.iconbitmap(default=icon_path)
                except Exception:
                    pass

    def _status_style(self, status):
        return self._status_styles.get(status, self._status_styles[""])

    def _build_ui(self):
        tk, ttk = self.tk, self._ttk
        family = self._font_family
        card_bg = "#ffffff"

        main = ttk.Frame(self.root, style="MainBg.TFrame", padding=(16, 12, 16, 10))
        main.pack(fill="both", expand=True)

        # ================= 1. 顶部 Header 导览卡片 =================
        header_card = ttk.Frame(main, style="Card.TFrame", padding=(14, 10))
        header_card.pack(fill="x", pady=(0, 10))

        header_left = ttk.Frame(header_card, style="Card.TFrame")
        header_left.pack(side="left", fill="y")
        if self._logo_image is not None:
            ttk.Label(header_left, image=self._logo_image, style="Card.TFrame").pack(side="left", padx=(0, 10))
        else:
            ttk.Label(header_left, text="极", style="Logo.TLabel").pack(side="left", padx=(0, 10))

        title_box = ttk.Frame(header_left, style="Card.TFrame")
        title_box.pack(side="left", fill="y")

        title_line = ttk.Frame(title_box, style="Card.TFrame")
        title_line.pack(anchor="w")
        ttk.Label(title_line, text=APP_NAME, style="AppTitle.TLabel").pack(side="left", padx=(0, 8))
        ttk.Label(title_line, text=f"v{APP_VERSION}", style="VersionBadge.TLabel").pack(side="left")

        header_actions = ttk.Frame(header_card, style="Card.TFrame")
        header_actions.pack(side="right", anchor="center")

        self.calib_btn = ttk.Button(
            header_actions, text="🎯 校准视野", style="Toolbar.TButton",
            command=self.force_calibrate)
        self.calib_btn.pack(side="left", padx=(0, 6))

        self.reply_btn = ttk.Button(
            header_actions, text="📨 待回名单 · 0", style="Toolbar.TButton",
            command=self.show_reply_notes_dialog)
        self.reply_btn.pack(side="left", padx=(0, 6))

        self.log_btn = ttk.Button(
            header_actions, text="📜 运行日志", style="Toolbar.TButton",
            command=self.open_log_window)
        self.log_btn.pack(side="left", padx=(0, 6))

        self.file_btn = ttk.Button(
            header_actions, text="📁 导入文件", style=self._accent_style,
            command=self.choose_input_files)
        self.file_btn.pack(side="left")

        # ================= 2. 统计概览指标卡片组 (Dashboard 风格) =================
        stats_frame = ttk.Frame(main, style="MainBg.TFrame")
        stats_frame.pack(fill="x", pady=(0, 10))

        self.stat_files_val = tk.StringVar(master=self.root, value="未选择文件")
        self.stat_selected_val = tk.StringVar(master=self.root, value="0 人")
        self.stat_sent_val = tk.StringVar(master=self.root, value="0 人")
        self.stat_failed_val = tk.StringVar(master=self.root, value="0 人")

        cards_spec = [
            ("📁 数据来源", self.stat_files_val, "StatNum.TLabel"),
            ("🎯 本次待发", self.stat_selected_val, "StatNum.TLabel"),
            ("🚀 发送成功", self.stat_sent_val, "StatNumGreen.TLabel"),
            ("⚠️ 失败/未匹配", self.stat_failed_val, "StatNumRed.TLabel"),
        ]

        for idx, (title, val_var, val_style) in enumerate(cards_spec):
            card = ttk.Frame(stats_frame, style="Card.TFrame", padding=(12, 7))
            card.pack(side="left", fill="both", expand=True, padx=(0 if idx == 0 else 6, 0))
            ttk.Label(card, text=title, style="StatTitle.TLabel").pack(anchor="w")
            if idx == 0:
                self.input_label = ttk.Label(card, textvariable=val_var, style=val_style, anchor="w")
                self.input_label.pack(anchor="w", pady=(2, 0))
            else:
                ttk.Label(card, textvariable=val_var, style=val_style, anchor="w").pack(anchor="w", pady=(2, 0))

        # ================= 3. 控制工具栏 (搜索、筛选与批量操作) =================
        self.search_var = tk.StringVar(master=self.root)
        self.filter_var = tk.StringVar(master=self.root, value=FILTER_ALL)
        self.summary_var = tk.StringVar(master=self.root, value="共 0 人")

        toolbar_card = ttk.Frame(main, style="Card.TFrame", padding=(12, 7))
        toolbar_card.pack(fill="x", pady=(0, 8))

        tb_left = ttk.Frame(toolbar_card, style="Card.TFrame")
        tb_left.pack(side="left", fill="y")

        ttk.Label(tb_left, text="🔍", font=(family, 10), background=card_bg).pack(side="left", padx=(0, 4))
        self.search_entry = ttk.Entry(tb_left, textvariable=self.search_var, width=20)
        self.search_entry.pack(side="left", padx=(0, 10))

        ttk.Label(tb_left, text="状态:", font=(family, 9), foreground="#64748b", background=card_bg).pack(side="left", padx=(0, 4))
        self.filter_combo = ttk.Combobox(
            tb_left, textvariable=self.filter_var, values=FILTER_VALUES,
            state="readonly", width=11)
        self.filter_combo.pack(side="left", padx=(0, 8))
        self.filter_combo.bind("<<ComboboxSelected>>", lambda e: self.rebuild_student_list())

        self.failed_only_btn = ttk.Button(
            tb_left, text="⚠️ 只看失败", style="Toolbar.TButton", command=self.show_failed_only)
        self.failed_only_btn.pack(side="left", padx=(0, 4))

        self.retry_failed_btn = ttk.Button(
            tb_left, text="🔄 重试失败项", style="Toolbar.TButton",
            command=self.select_failed_only)
        self.retry_failed_btn.pack(side="left")

        tb_right = ttk.Frame(toolbar_card, style="Card.TFrame")
        tb_right.pack(side="right", fill="y")

        ttk.Label(tb_right, textvariable=self.summary_var, font=(family, 9, "bold"),
                  foreground="#334155", background=card_bg).pack(side="left", padx=(0, 8))

        self.select_all_btn = ttk.Button(
            tb_right, text="✓ 全选", style="Toolbar.TButton",
            command=lambda: self.set_all_selected(True))
        self.select_all_btn.pack(side="left", padx=(0, 4))

        self.select_none_btn = ttk.Button(
            tb_right, text="✕ 全不选", style="Toolbar.TButton",
            command=lambda: self.set_all_selected(False))
        self.select_none_btn.pack(side="left")

        # ================= 4. 学生列表主卡片 (含表头 + 滚动容器) =================
        list_card = ttk.Frame(main, style="Card.TFrame")
        list_card.pack(fill="both", expand=True, pady=(0, 8))

        table_header = ttk.Frame(list_card, style="TableHeader.TFrame", padding=(12, 6))
        table_header.pack(fill="x")
        ttk.Label(table_header, text="选", width=3, style="HeaderCol.TLabel").pack(side="left", padx=(0, 6))
        ttk.Label(table_header, text="学号", width=9, style="HeaderCol.TLabel").pack(side="left", padx=(0, 8))
        ttk.Label(table_header, text="姓名", width=14, style="HeaderCol.TLabel").pack(side="left", padx=(0, 8))
        ttk.Label(table_header, text="状态", width=13, anchor="center", style="HeaderCol.TLabel").pack(side="left", padx=(0, 10))
        ttk.Label(table_header, text="处理明细 / 最新备注", style="HeaderCol.TLabel").pack(side="left", fill="x", expand=True)
        ttk.Label(table_header, text="快捷复制", width=18, anchor="e", style="HeaderCol.TLabel").pack(side="right")

        list_outer = ttk.Frame(list_card, style="Card.TFrame")
        list_outer.pack(fill="both", expand=True)

        self.students_canvas = tk.Canvas(list_outer, highlightthickness=0, bg=card_bg)
        scrollbar = ttk.Scrollbar(
            list_outer, orient="vertical", command=self.students_canvas.yview)
        self.students_inner = ttk.Frame(self.students_canvas, style="Card.TFrame")
        self.students_window = self.students_canvas.create_window(
            (0, 0), window=self.students_inner, anchor="nw")
        self.students_canvas.configure(yscrollcommand=scrollbar.set)
        self.students_canvas.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")
        self.students_inner.bind(
            "<Configure>",
            lambda e: self.students_canvas.configure(scrollregion=self.students_canvas.bbox("all")))
        self.students_canvas.bind(
            "<Configure>",
            lambda e: self.students_canvas.itemconfigure(self.students_window, width=e.width))

        def _on_mousewheel(event):
            delta = event.delta
            if sys.platform != "win32":
                delta = -120 if event.num == 5 else 120
            self.students_canvas.yview_scroll(int(-1 * (delta / 120)), "units")

        self.students_canvas.bind_all("<MouseWheel>", _on_mousewheel)
        self.students_canvas.bind_all("<Button-4>", _on_mousewheel)
        self.students_canvas.bind_all("<Button-5>", _on_mousewheel)

        # ================= 5. 底部控制与进度栏 (Floating Dock) =================
        footer = ttk.Frame(main, style="Card.TFrame", padding=(14, 9))
        footer.pack(fill="x")

        progress_box = ttk.Frame(footer, style="Card.TFrame")
        progress_box.pack(side="left", fill="x", expand=True)

        prog_title_row = ttk.Frame(progress_box, style="Card.TFrame")
        prog_title_row.pack(fill="x")
        self.progress_var = tk.StringVar(master=self.root, value="进度：等待开始")
        ttk.Label(prog_title_row, textvariable=self.progress_var,
                  font=(family, 10, "bold"), foreground="#1e293b", background=card_bg).pack(side="left")

        self.result_var = tk.StringVar(master=self.root)
        ttk.Label(prog_title_row, textvariable=self.result_var,
                  font=(family, 9), foreground="#64748b", background=card_bg).pack(side="right")

        self.progress_bar = ttk.Progressbar(
            progress_box, orient="horizontal", mode="determinate", maximum=1, value=0)
        self.progress_bar.pack(fill="x", pady=(4, 4))

        self.hint_var = tk.StringVar(
            master=self.root,
            value="💡 勾选学生后点“开始发送” · 发送中按 Esc 安全停止 · 双击状态列可查看详细原因")
        ttk.Label(progress_box, textvariable=self.hint_var, style="Hint.TLabel",
                  anchor="w", wraplength=640).pack(fill="x")

        actions = ttk.Frame(footer, style="Card.TFrame")
        actions.pack(side="right", padx=(14, 0), anchor="center")

        self.copy_failed_btn = ttk.Button(
            actions, text="📋 复制失败名单", style="Secondary.TButton",
            command=self.copy_failed_list)
        self.copy_failed_btn.pack(side="left", padx=(0, 6))

        self.stop_btn = ttk.Button(
            actions, text="⏹ 停止 (Esc)", style="Danger.TButton",
            command=self.request_stop, state="disabled")
        self.stop_btn.pack(side="left", padx=(0, 8))

        self.start_btn = ttk.Button(
            actions, text="▶ 开始发送", style="PrimaryLarge.TButton", command=self.run_all)
        self.start_btn.pack(side="left")

    STATUS_PALETTE = {
        "待发送": {"fg": "#475569", "bg": "#f1f5f9"},
        "发送中": {"fg": "#1d4ed8", "bg": "#dbeafe"},
        "已发送": {"fg": "#15803d", "bg": "#dcfce7"},
        "发送失败": {"fg": "#b91c1c", "bg": "#fee2e2"},
        "已拦截": {"fg": "#b45309", "bg": "#fef3c7"},
        "未匹配": {"fg": "#b45309", "bg": "#fef3c7"},
        "已跳过": {"fg": "#64748b", "bg": "#f8fafc"},
        "已跳过（已发送）": {"fg": "#64748b", "bg": "#f8fafc"},
    }
    STATUS_COLORS = {k: v["fg"] for k, v in STATUS_PALETTE.items()}
    STATUS_DEFAULT_COLOR = "#202124"

    def _status_of(self, item):
        var = item.get("_status_var")
        if var is not None:
            try:
                return var.get()
            except self.tk.TclError:
                pass
        return item.get("_status", "待发送")

    def _visible_items(self):
        query = (self.search_var.get() or "").strip().lower()
        filter_name = self.filter_var.get() or FILTER_ALL
        result = []
        for item in self.items:
            if query:
                hay = " ".join(
                    str(item.get(k, "") or "") for k in ("sid", "sname", "studentName")
                ).lower()
                if query not in hay:
                    continue
            if not status_matches_filter(self._status_of(item), filter_name):
                continue
            result.append(item)
        return result

    def _cancel_search_rebuild(self):
        if self._search_after is not None:
            try:
                self.root.after_cancel(self._search_after)
            except Exception:
                pass
            self._search_after = None

    def _on_search_change(self, *_args):
        if self._suspend_filter or self._running:
            return
        self._cancel_search_rebuild()
        self._search_after = self.root.after(150, self._run_scheduled_rebuild)

    def _run_scheduled_rebuild(self):
        self._search_after = None
        if not self._running:
            self.rebuild_student_list()

    def show_failed_only(self):
        self.filter_var.set(FILTER_FAILED)
        self.rebuild_student_list()
        if not any(self._status_of(item) in ("发送失败", "未匹配") for item in self.items):
            self.hint_var.set("没有失败/未匹配学生")
        else:
            self.hint_var.set("已筛选失败/未匹配学生")

    def select_failed_only(self):
        failed_ids = {
            id(item) for item in self.items
            if self._status_of(item) in ("发送失败", "未匹配")
        }
        if not failed_ids:
            self.hint_var.set("没有失败/未匹配学生")
            return
        self._suspend_filter = True
        try:
            self.search_var.set("")
            self.filter_var.set(FILTER_FAILED)
        finally:
            self._suspend_filter = False
        self._cancel_search_rebuild()
        for item in self.items:
            var = item.get("_selected_var")
            if var is not None:
                var.set(id(item) in failed_ids)
                self._apply_selection_status(item, var.get())
        self.rebuild_student_list()
        self.hint_var.set(
            f"已只勾选 {len(failed_ids)} 个失败/未匹配学生，点“开始发送”重试")

    def copy_failed_list(self):
        lines = []
        for item in self.items:
            status = self._status_of(item)
            if status not in ("发送失败", "未匹配"):
                continue
            student = (item.get("studentName")
                       or f"{item.get('sid', '')}{item.get('sname', '')}")
            raw_reason = item.get("_last_failure_reason") or item.get("_last_reason") or ""
            reason = " ".join(raw_reason.split()) or "-"
            lines.append(f"{student}\t{status}\t{reason}")
        if not lines:
            self.hint_var.set("没有失败/未匹配学生")
            return
        self.copy_to_clipboard("学生\t状态\t原因\n" + "\n".join(lines), "失败名单")

    def show_row_reason(self, item):
        if self._running:
            return
        last_reason = (item.get("_last_reason") or "").strip()
        last_failure = (item.get("_last_failure_reason") or "").strip()
        parts = []
        if last_reason:
            parts.append(f"最近一次：{last_reason}")
        if last_failure and last_failure != last_reason:
            parts.append(f"上次失败：{last_failure}")
        if not parts:
            self.hint_var.set("该学生暂无失败原因")
            return
        from tkinter import messagebox
        name = item.get("studentName", "") or "该学生"
        messagebox.showinfo(f"{name} 的处理原因", "\n\n".join(parts), parent=self.root)

    def _set_running_ui(self, running: bool):
        state = "disabled" if running else "normal"
        # 日志/待回名单在发送中保持可查看；其余编辑类控件锁定。
        for widget in (self.file_btn, self.select_all_btn, self.select_none_btn,
                       self.failed_only_btn, self.retry_failed_btn,
                       self.copy_failed_btn):
            widget.config(state=state)
        self.search_entry.config(state=state)
        self.filter_combo.config(state="disabled" if running else "readonly")
        self.start_btn.config(state=state)
        self.stop_btn.config(state="normal" if running else "disabled")
        for widget in self._row_checkbuttons + self._row_action_buttons:
            try:
                widget.config(state=state)
            except self.tk.TclError:
                pass

    def _update_progress(self, processed, total, stopped=False):
        self.progress_bar.config(maximum=max(1, total), value=processed)
        suffix = "（已停止）" if stopped else ""
        self.progress_var.set(f"进度：{processed}/{total}{suffix}")
        self.root.update_idletasks()

    def _reset_progress(self):
        self.progress_bar.config(maximum=1, value=0)
        self.progress_var.set("进度：未开始")
        self.result_var.set("")

    def _announce_stop(self):
        if self._stop_announced:
            return
        self._stop_announced = True
        self.hint_var.set("正在停止：当前学生处理完后结束...")
        self.emit("收到停止请求：当前学生处理完后结束")

    def _start_esc_watcher(self):
        self._stop_esc_watcher()
        try:
            import ctypes
            user32 = ctypes.windll.user32
            user32.GetAsyncKeyState(0x1B)  # 清掉发送前残留的按键状态
        except Exception:
            return
        stop_event = threading.Event()
        self._esc_watch_stop = stop_event

        def watch():
            while not stop_event.is_set() and self._running:
                try:
                    state = user32.GetAsyncKeyState(0x1B)
                except Exception:
                    return
                if state & 0x8001:
                    self._stop_requested = True
                    return
                time.sleep(0.05)

        threading.Thread(target=watch, name="sender-esc-watch", daemon=True).start()

    def _stop_esc_watcher(self):
        event = self._esc_watch_stop
        self._esc_watch_stop = None
        if event is not None:
            event.set()

    def _esc_pressed(self):
        try:
            import ctypes
            return bool(ctypes.windll.user32.GetAsyncKeyState(0x1B) & 0x8001)
        except Exception:
            return False

    def _poll_stop(self):
        if self._stop_requested:
            self._announce_stop()
            return True
        try:
            self.root.update()
        except self.tk.TclError:
            self._stop_requested = True
            self._announce_stop()
            return True
        if self._esc_pressed():
            self.request_stop()
        if self._stop_requested:
            self._announce_stop()
            return True
        return False

    def request_stop(self, event=None):
        if not self._running:
            return None
        self._stop_requested = True
        self._announce_stop()
        return "break"

    def on_close(self):
        from tkinter import messagebox
        if self._running:
            if not messagebox.askyesno(
                    "正在发送",
                    "正在发送，确定停止并退出吗？\n当前学生处理完后退出。",
                    parent=self.root, default=messagebox.NO):
                return
            self._close_after_stop = True
            self.request_stop()
            return
        self.root.destroy()

    def _interruptible_pause(self, seconds):
        end = time.monotonic() + max(0.0, seconds)
        while time.monotonic() < end:
            if self._poll_stop():
                return False
            time.sleep(0.05)
        return not self._poll_stop()

    def _summary_text(self, stopped: bool, selected_count: int):
        counts = summarize_status_counts(
            self._status_of(item) for item in self.items)
        title = "已停止" if stopped else "本批结束"
        return (f"{title}（共 {len(self.items)} 人，本次勾选 {selected_count} 人）："
                f"成功 {counts['已发送']}，失败 {counts['发送失败']}，"
                f"拦截 {counts['已拦截']}，未匹配 {counts['未匹配']}，"
                f"跳过 {counts['已跳过']}")

    def force_calibrate(self):
        """手动触发视野校准：优先 Qwen-VL-Max 自动框选，识别失败时弹出居中大手动画布。"""
        try:
            try:
                from sender_py import window_utils as wu
            except ModuleNotFoundError:
                import window_utils as wu
            if not wu.find_and_activate_wecom():
                from tkinter import messagebox
                messagebox.showwarning("提示", "未能激活企业微信窗口，请先打开企微并点进任意聊天后重试。", parent=self.root)
                return
            time.sleep(0.4)
            rect = wu.get_wecom_rect()
            if not rect or rect[2] < 200 or rect[3] < 150:
                from tkinter import messagebox
                messagebox.showwarning("提示", "未能获取有效的企业微信窗口尺寸。", parent=self.root)
                return
            scale = wu.get_dpi_scale()
            self.emit("用户点击“校准视野”，准备重新校准窗口...")
            token = getattr(self, "token", None)
            roi = ensure_roi(self.root, rect, scale, server=self.server, token=token, log=self.emit, force=True)
            if roi:
                self.emit("✓ 企业微信窗口视野校准成功并已保存！")
                from tkinter import messagebox
                messagebox.showinfo("校准成功", "企业微信窗口区域已成功校准并保存！", parent=self.root)
            else:
                self.emit("校准已取消或未完成。")
        except Exception as exc:
            self.emit(f"校准过程异常：{exc}")
            from tkinter import messagebox
            messagebox.showerror("校准失败", f"校准异常：{exc}", parent=self.root)

    def open_log_window(self):
        tk, ttk = self.tk, self._ttk
        if self.log_window is not None:
            try:
                if self.log_window.winfo_exists():
                    self.log_window.deiconify()
                    self.log_window.lift()
                    return
            except tk.TclError:
                pass
            self.log_window = None
            self.log_text = None
        win = tk.Toplevel(self.root)
        win.title(f"{APP_NAME} · 运行调试日志")
        win.geometry("940x540")
        try:
            win.transient(self.root)
        except Exception:
            pass
        body = ttk.Frame(win, style="Card.TFrame", padding=16)
        body.pack(fill="both", expand=True)
        ttk.Label(body, text="📜 运行调试日志", style="Section.TLabel").pack(anchor="w")
        ttk.Label(body, text="实时记录会话搜索、整窗截图分析、大模型视觉判定、发送进度与异常堆栈", style="Hint.TLabel").pack(
            anchor="w", pady=(2, 10))
        text_frame = ttk.Frame(body, style="Card.TFrame")
        text_frame.pack(fill="both", expand=True)
        text = tk.Text(
            text_frame, wrap="word", font=("Consolas", 10), bg="#0f172a", fg="#f1f5f9",
            insertbackground="#38bdf8", relief="flat", borderwidth=0,
            padx=12, pady=10, highlightthickness=1, highlightbackground="#334155")
        scroll = ttk.Scrollbar(text_frame, orient="vertical", command=text.yview)
        text.configure(yscrollcommand=scroll.set)
        text.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")
        if self.log_buffer:
            text.insert("end", "\n".join(self.log_buffer) + "\n")
        text.see("end")
        self.log_window = win
        self.log_text = text

        def close():
            self.log_window = None
            self.log_text = None
            win.destroy()

        def clear():
            self.log_buffer.clear()
            text.delete("1.0", "end")

        win.protocol("WM_DELETE_WINDOW", close)
        footer = ttk.Frame(body, style="Card.TFrame")
        footer.pack(fill="x", pady=(10, 0))
        ttk.Button(footer, text="清空日志", style="Toolbar.TButton",
                   command=clear).pack(side="right")

    def rebuild_student_list(self):
        if self._running:
            return
        self._cancel_search_rebuild()
        tk, ttk = self.tk, self._ttk
        self._row_checkbuttons = []
        self._row_action_buttons = []
        for child in self.students_inner.winfo_children():
            child.destroy()
        visible = self._visible_items()
        card_bg = "#ffffff"

        for idx, item in enumerate(visible):
            if "_selected_var" not in item:
                item["_selected_var"] = tk.BooleanVar(master=self.root, value=True)
            if "_status_var" not in item:
                item["_status_var"] = tk.StringVar(master=self.root, value="待发送")

            row = ttk.Frame(self.students_inner, style="Card.TFrame", padding=(12, 6))
            row.pack(fill="x")

            check = ttk.Checkbutton(row, variable=item["_selected_var"],
                                    command=lambda it=item: self.on_select_change(it))
            check.pack(side="left", padx=(0, 6))
            self._row_checkbuttons.append(check)

            sid = item.get("sid") or "-"
            ttk.Label(row, text=sid, width=9, anchor="w", style="IdBadge.TLabel").pack(side="left", padx=(0, 8))

            sname = item.get("sname") or item.get("studentName") or "-"
            ttk.Label(row, text=sname, width=14, anchor="w", style="RowName.TLabel").pack(side="left", padx=(0, 8))

            st = item["_status_var"].get()
            status_lbl = ttk.Label(
                row, textvariable=item["_status_var"], width=13, anchor="center",
                cursor="hand2", style=self._status_style(st))
            status_lbl.pack(side="left", padx=(0, 10))
            status_lbl.bind("<Double-1>", lambda _e, it=item: self.show_row_reason(it))
            item["_status_label"] = status_lbl

            reason = item.get("_last_reason") or ""
            reason_var = item.setdefault("_reason_var", tk.StringVar(master=self.root, value=reason))
            reason_var.set(reason)
            reason_lbl = ttk.Label(row, textvariable=reason_var, style="RowReason.TLabel", anchor="w")
            reason_lbl.pack(side="left", fill="x", expand=True, padx=(0, 8))

            msg_btn = ttk.Button(row, text="📋 话术", style="RowAction.TButton",
                                 command=lambda it=item: self.copy_message(it))
            msg_btn.pack(side="right", padx=(4, 0))
            name_btn = ttk.Button(row, text="👤 学号姓名", style="RowAction.TButton",
                                  command=lambda it=item: self.copy_student(it))
            name_btn.pack(side="right", padx=(4, 0))
            self._row_action_buttons.extend((msg_btn, name_btn))

            sep = ttk.Separator(self.students_inner, orient="horizontal")
            sep.pack(fill="x", padx=8)

        if not self.items:
            empty_box = ttk.Frame(self.students_inner, style="Card.TFrame", padding=(20, 48))
            empty_box.pack(fill="both", expand=True)
            ttk.Label(empty_box, text="📂", font=(self._font_family, 36), background=card_bg).pack()
            ttk.Label(empty_box, text="暂未加载任何学生反馈数据", style="EmptyTitle.TLabel").pack(pady=(8, 4))
            ttk.Label(empty_box, text="支持同时多选网站导出的 HTML 快照与 JSON 结果文件", style="EmptyDesc.TLabel").pack(pady=(0, 16))
            ttk.Button(empty_box, text="立即选择文件导入", style=self._accent_style, command=self.choose_input_files).pack()
        elif not visible:
            empty_box = ttk.Frame(self.students_inner, style="Card.TFrame", padding=(20, 40))
            empty_box.pack(fill="both", expand=True)
            ttk.Label(empty_box, text="🔍", font=(self._font_family, 30), background=card_bg).pack()
            ttk.Label(empty_box, text="未找到符合条件的学生", style="EmptyTitle.TLabel").pack(pady=(6, 2))
            ttk.Label(empty_box, text="请尝试清除搜索关键词或切换状态筛选下拉框", style="EmptyDesc.TLabel").pack()

        self.students_canvas.yview_moveto(0)
        self.update_summary()

    def set_status(self, item, text):
        var = item.get("_status_var")
        if var is not None:
            var.set(text)
        label = item.get("_status_label")
        if label is not None:
            try:
                label.configure(style=self._status_style(text))
            except self.tk.TclError:
                pass
        reason_var = item.get("_reason_var")
        if reason_var is not None:
            try:
                reason_var.set(item.get("_last_reason", ""))
            except self.tk.TclError:
                pass
        self.update_summary()
        self.root.update_idletasks()

    def update_summary(self):
        selected = 0
        sent = 0
        failed = 0
        for item in self.items:
            var = item.get("_selected_var")
            if var is not None and var.get():
                selected += 1
            st = self._status_of(item)
            if st == "已发送":
                sent += 1
            elif st in ("发送失败", "未匹配", "已拦截"):
                failed += 1
        total = len(self.items)
        self.summary_var.set(f"已选 {selected} / 共 {total} 人")
        if hasattr(self, "stat_selected_val"):
            self.stat_selected_val.set(f"{selected} 人")
            self.stat_sent_val.set(f"{sent} 人")
            self.stat_failed_val.set(f"{failed} 人")
            f_count = len(self.input_paths)
            self.stat_files_val.set(f"{f_count} 个文件 · 共 {total} 人" if f_count else f"共 {total} 人")

    def _apply_selection_status(self, item, selected: bool):
        status_var = item.get("_status_var")
        if status_var is None:
            return
        status = status_var.get()
        if selected and status in ("已跳过", "已跳过（已发送）"):
            self.set_status(item, "待发送")
        elif not selected and status in ("待发送", "已跳过"):
            self.set_status(item, "已跳过")

    def on_select_change(self, item):
        var = item.get("_selected_var")
        if var is not None:
            self._apply_selection_status(item, var.get())
        self.update_summary()

    def set_all_selected(self, value: bool):
        for item in self.items:
            var = item.get("_selected_var")
            if var is not None:
                var.set(value)
                self._apply_selection_status(item, value)
        self.update_summary()

    def _reset_hint(self):
        if self._running:
            return
        self.hint_var.set("勾选学生后点击“开始发送”；发送中按 Esc 停止；双击状态列查看失败原因。")

    def copy_to_clipboard(self, text, label):
        if self._running:
            return
        text = str(text or "")
        self.root.clipboard_clear()
        self.root.clipboard_append(text)
        self.root.update_idletasks()
        preview = " ".join(text.split())
        if len(preview) > 60:
            preview = preview[:60] + "…"
        self.hint_var.set(f"已复制{label}：{preview}")
        self.emit(f"已复制{label}")
        self.root.after(3000, self._reset_hint)

    def copy_student(self, item):
        self.copy_to_clipboard(item.get("studentName", ""), "学号姓名")

    def copy_message(self, item):
        self.copy_to_clipboard(item.get("message", ""), "话术")

    def emit(self, msg: str):
        msg = str(msg)
        self.log_buffer.append(msg)
        if len(self.log_buffer) > 5000:
            del self.log_buffer[:1000]
        if self.log_text is not None:
            try:
                self.log_text.insert("end", msg + "\n")
                self.log_text.see("end")
                self.log_text.update_idletasks()
            except self.tk.TclError:
                self.log_text = None
                self.log_window = None
        self.root.update_idletasks()

    def refresh_reply_count(self):
        self.reply_btn.config(text=f"待回名单 · {len(actionable(self.reply_notes))}")

    def update_input_label(self):
        if not self.input_paths:
            text = f"当前输入：未选择文件（{len(self.items)} 个学生）"
        elif len(self.input_paths) == 1:
            text = f"当前输入：{os.path.basename(self.input_paths[0])}（{len(self.items)} 个学生）"
        else:
            names = "、".join(os.path.basename(p) for p in self.input_paths)
            text = f"已选 {len(self.input_paths)} 个文件：{names}；共 {len(self.items)} 个学生"
        if self.duplicate_count:
            text += f"（已去重 {self.duplicate_count} 条）"
        self.input_label.config(text=text)

    def choose_input_files(self):
        from tkinter import filedialog, messagebox
        paths = filedialog.askopenfilenames(
            parent=self.root,
            title="选择反馈文件（JSON / HTML，可多选）",
            filetypes=[
                ("反馈文件（JSON / HTML）", "*.json *.html *.htm"),
                ("JSON 文件", "*.json"),
                ("HTML 快照", "*.html *.htm"),
                ("所有文件", "*.*"),
            ],
        )
        if not paths:
            return
        try:
            items, file_counts, duplicates = load_feedback_inputs(paths)
        except Exception as exc:
            messagebox.showerror("读取失败",
                                 f"本次选择未生效，仍保留原来的文件列表。\n{exc}",
                                 parent=self.root)
            return
        if not items:
            messagebox.showwarning("没有可用数据",
                                   "选中的文件里没有有效的学生数据，本次选择未生效。",
                                   parent=self.root)
            return
        self.items = items
        self.input_paths = list(paths)
        self.duplicate_count = duplicates
        self.reply_notes = []
        self.refresh_reply_count()
        self.archive_key = (archive_key_for_input(paths[0]) if len(paths) == 1
                            else "多文件 [第 1 周]")
        self.update_input_label()
        self._suspend_filter = True
        try:
            self.search_var.set("")
            self.filter_var.set(FILTER_ALL)
        finally:
            self._suspend_filter = False
        self._cancel_search_rebuild()
        self._reset_progress()
        self._reset_hint()
        self.rebuild_student_list()
        details = "，".join(f"{os.path.basename(p)} {n} 人" for p, n in file_counts)
        self.emit(f"已加载 {len(paths)} 个文件：{details}")
        self.emit(f"合并后共 {len(items)} 个学生" + (f"（去重 {duplicates} 条）" if duplicates else ""))

    def show_reply_notes_dialog(self):
        tk, ttk = self.tk, self._ttk
        from tkinter import filedialog, messagebox
        try:
            from sender_py.reply_notes import export_csv
        except ModuleNotFoundError:
            from reply_notes import export_csv
        notes = actionable(self.reply_notes)
        win = tk.Toplevel(self.root)
        win.title(f"{APP_NAME} · 待回名单")
        win.geometry("960x560")
        try:
            win.transient(self.root)
        except Exception:
            pass
        cols = [
            ("student", "学生", 160),
            ("chat_title", "会话", 180),
            ("last_message", "最后消息", 380),
            ("verdict", "需回", 90),
            ("time", "时间", 150),
        ]
        body = ttk.Frame(win, style="Card.TFrame", padding=16)
        body.pack(fill="both", expand=True)
        ttk.Label(body, text="📨 待回消息名单", style="Section.TLabel").pack(anchor="w")
        ttk.Label(body, text="自动过滤出家长留言中明确需要老师跟进回复或存疑待确认的会话", style="Hint.TLabel").pack(
            anchor="w", pady=(2, 10))
        tree_frame = ttk.Frame(body, style="Card.TFrame")
        tree_frame.pack(fill="both", expand=True)

        style = ttk.Style(win)
        try:
            style.configure("Treeview", font=(self._font_family, 9), rowheight=28)
            style.configure("Treeview.Heading", font=(self._font_family, 9, "bold"), padding=(6, 4))
        except Exception:
            pass

        tree = ttk.Treeview(tree_frame, columns=[c for c, _, _ in cols],
                            show="headings", height=15, selectmode="browse")
        for c, label, width in cols:
            tree.heading(c, text=label)
            tree.column(c, width=width, anchor="w")
        for n in notes:
            tree.insert("", "end", values=tuple(n.get(c, "") for c, _, _ in cols))
        scroll = ttk.Scrollbar(tree_frame, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=scroll.set)
        tree.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")

        copy_hint = tk.StringVar(master=win, value="选中一行后点“复制学号姓名”，或双击该行。")
        ttk.Label(body, textvariable=copy_hint, style="Hint.TLabel",
                  anchor="w").pack(fill="x", pady=(8, 4))

        def copy_selected(_event=None):
            if self._running:
                copy_hint.set("正在发送，暂不可复制。")
                return
            sel = tree.selection()
            if not sel:
                copy_hint.set("请先选中一个学生。")
                return
            values = tree.item(sel[0], "values")
            student = values[0] if values else ""
            if not student:
                copy_hint.set("这一行没有学生学号姓名。")
                return
            self.copy_to_clipboard(student, "学号姓名")
            copy_hint.set(f"已复制：{student}")

        def do_export():
            if self._running:
                return
            path = filedialog.asksaveasfilename(
                parent=win, title="导出待回消息名单", defaultextension=".csv",
                initialfile="待回名单.csv", filetypes=[("CSV", "*.csv")])
            if not path:
                return
            export_csv(notes, path)
            messagebox.showinfo("导出成功", f"已导出至：\n{path}", parent=win)

        actions = ttk.Frame(body)
        actions.pack(fill="x", pady=(4, 0))
        ttk.Button(actions, text="复制选中学生学号姓名", style="Toolbar.TButton",
                   command=copy_selected).pack(side="left", padx=(0, 6))
        ttk.Button(actions, text="导出 CSV", style="Toolbar.TButton",
                   command=do_export).pack(side="left")
        tree.bind("<Double-1>", copy_selected)
        if not notes:
            ttk.Label(body, text="当前没有需要回复的学生",
                      style="Hint.TLabel").pack(pady=(8, 0))

    def run_all(self):
        if self._running:
            return
        from tkinter import messagebox
        if not self.items:
            self.emit("没有可发送的学生，请先选择 JSON / HTML 文件")
            self.hint_var.set("没有可发送的学生，请先选择文件")
            return
        selected_items = [
            item for item in self.items
            if item.get("_selected_var") is not None and item["_selected_var"].get()
        ]
        selected_count = len(selected_items)
        if not selected_count:
            self.emit("没有勾选任何学生，请先勾选要发送的学生")
            self.hint_var.set("没有勾选任何学生")
            return
        selected_ids = {id(item) for item in selected_items}
        visible_items = self._visible_items()
        visible_selected = sum(1 for item in visible_items if id(item) in selected_ids)
        hidden_selected = selected_count - visible_selected
        confirm_lines = [
            f"本次将发送 {selected_count} 人（共 {len(self.items)} 人）。"
        ]
        if hidden_selected:
            confirm_lines.append(
                f"其中 {hidden_selected} 名已勾选学生因搜索/筛选未显示，仍会发送。")
        confirm_lines.append(
            "发送中按 Esc 可停止（企业微信在前台也可）；为防发半条，当前学生处理完后结束。")
        confirm_lines.extend(("", "是否继续？"))
        self.start_btn.config(state="disabled")
        try:
            confirmed = messagebox.askyesno(
                "确认发送", "\n".join(confirm_lines), parent=self.root,
                default=messagebox.NO)
        except Exception:
            self.start_btn.config(state="normal")
            raise
        if not confirmed:
            self.start_btn.config(state="normal")
            self.hint_var.set("已取消发送")
            return

        token = None
        try:
            try:
                from sender_py.vision_api import load_token
            except ModuleNotFoundError:
                from vision_api import load_token
            token = load_token() or None
        except Exception:
            pass

        for item in self.items:
            if id(item) in selected_ids:
                self.set_status(item, "待发送")
                item["_last_result"] = ""
                item["_last_reason"] = ""
            else:
                self.set_status(item, "已跳过")
                item["_last_result"] = "skipped"
                item["_last_reason"] = "未勾选"

        self._running = True
        self._stop_requested = False
        self._stop_announced = False
        self._close_after_stop = False
        self._start_esc_watcher()
        self._set_running_ui(True)
        self._update_progress(0, selected_count)
        self.result_var.set("正在发送...")
        self.hint_var.set("正在发送...按 Esc 可停止")
        processed = 0
        stopped = False
        try:
            for item in self.items:
                if id(item) not in selected_ids:
                    self.emit(f"[{item.get('studentName', '(未知学生)')}] 未勾选，跳过")
                    continue
                if self._poll_stop():
                    stopped = True
                    break
                name = item.get("studentName", "(未知学生)")
                item_key = item.get("_archive_key") or self.archive_key
                if SKIP_SENT and self._history and self._history.is_sent(item_key, name):
                    self.set_status(item, "已跳过（已发送）")
                    item["_last_result"] = "skipped_sent"
                    item["_last_reason"] = "已发送过，自动跳过"
                    processed += 1
                    self._update_progress(processed, selected_count)
                    self.emit(f"[{name}] 已发送过，跳过")
                    continue
                self.set_status(item, "发送中")
                self.hint_var.set(f"正在发送：{name}")
                try:
                    res = send_student(
                        item, self.server, token, parent=self.root,
                        log=self.emit, should_stop=self._poll_stop)
                except Exception as exc:
                    res = {"result": "error", "reason": f"程序异常：{exc}", "notes": []}
                result = res.get("result", "")
                reason = res.get("reason", "") or ""
                item["_last_result"] = result
                status = {
                    "sent": "已发送",
                    "error": "发送失败",
                    "blocked": "已拦截",
                    "unmatched": "未匹配",
                    "stopped": "已跳过",
                }.get(result)
                if status is None:
                    status = "发送失败"
                    reason = reason or f"未知返回：{result or '空'}"
                item["_last_reason"] = reason
                if status in ("发送失败", "未匹配"):
                    item["_last_failure_reason"] = reason or status
                self.set_status(item, status)
                processed += 1
                self._update_progress(processed, selected_count)
                for note in res.get("notes", []):
                    dedupe_add(self.reply_notes, note)
                self.refresh_reply_count()
                if result == "sent" and self._history:
                    try:
                        self._history.mark_status(
                            item_key, name, "✅已发送", item.get("message", ""))
                    except Exception as exc:
                        self.emit(f"[{name}] 历史记录写入失败：{exc}")
                self.emit(f"[{name}] → {result}：{reason}")
                if result == "stopped":
                    stopped = True
                    break
                if processed < selected_count and not self._stop_requested:
                    gap = random.uniform(*STUDENT_GAP)
                    self.emit(f"学生间随机停顿 {gap:.1f}s")
                    if not self._interruptible_pause(gap):
                        stopped = True
                        break
        except Exception as exc:
            self.emit(f"发送流程异常：{exc}")
            stopped = True
        finally:
            self._running = False
            self._stop_esc_watcher()
            if stopped:
                for item in self.items:
                    if (id(item) in selected_ids
                            and self._status_of(item) in ("待发送", "发送中")):
                        self.set_status(item, "已跳过")
                        item["_last_result"] = "stopped"
                        item["_last_reason"] = "用户停止，未发送"
            for item in self.items:
                if self._status_of(item) == "发送中":
                    self.set_status(item, "发送失败")
                    item["_last_result"] = "error"
                    reason = item.get("_last_reason") or "程序异常中断"
                    item["_last_reason"] = reason
                    item["_last_failure_reason"] = reason
            summary = self._summary_text(stopped, selected_count)
            self.result_var.set(summary)
            self._update_progress(processed, selected_count, stopped=stopped)
            self.hint_var.set(
                "已停止，未发送学生已标记为“已跳过”。" if stopped else "本批处理结束")
            self._set_running_ui(False)
            if not self._close_after_stop:
                if self.filter_var.get() != FILTER_ALL or self.search_var.get().strip():
                    self.rebuild_student_list()
                else:
                    self.update_summary()
        if self._close_after_stop:
            self.root.destroy()
            return
        self.emit(summary)
        counts = summarize_status_counts(self._status_of(item) for item in self.items)
        extra = ""
        if counts["发送失败"] or counts["未匹配"]:
            extra = ("\n\n可点主界面的“重试失败项”只勾选失败/未匹配学生，"
                     "或“复制失败名单”。")
        messagebox.showinfo("发送结束", summary + extra, parent=self.root)


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description=APP_NAME)
    ap.add_argument("--version", action="version", version=f"{APP_NAME} {APP_VERSION}")
    ap.add_argument("--input", default=None,
                    help="输入 JSON / HTML 快照；省略时尝试 测试.json，不存在则启动后选择")
    ap.add_argument("--server", default="https://feedback.wxjifang.cn", help="判定服务端")
    ap.add_argument("--smoke-test", action="store_true", help=argparse.SUPPRESS)
    args = ap.parse_args(argv)
    input_path = args.input or "测试.json"
    items = []
    key = ""
    input_paths = []
    load_error = None
    if os.path.isfile(input_path):
        try:
            items = load_feedback_items(input_path)
            key = archive_key_for_input(input_path)
            input_paths = [input_path]
            if not items:
                load_error = f"启动文件 {input_path} 没有有效学生数据，请点击“选择文件”重新选择。"
        except Exception as exc:
            load_error = f"启动时未能读取 {input_path}：{exc}\n请点击“选择文件”。"
    elif args.input:
        load_error = f"启动时未能读取 {input_path}：文件不存在\n请点击“选择文件”。"
    import tkinter as tk
    try:
        from sender_py.window_utils import set_per_monitor_dpi_awareness
    except ModuleNotFoundError:
        from window_utils import set_per_monitor_dpi_awareness
    set_per_monitor_dpi_awareness()
    root = tk.Tk()
    if args.smoke_test:
        root.withdraw()
    app = SenderApp(root, items, args.server, key, input_paths=input_paths)
    if args.smoke_test:
        if not app._using_sv_ttk:
            if sys.stderr is not None:
                print("smoke test failed: sv-ttk not loaded", file=sys.stderr)
            return 2
        if app._logo_image is None:
            if sys.stderr is not None:
                print("smoke test failed: favicon not loaded", file=sys.stderr)
            return 2
        root.update_idletasks()
        root.update()
        root.destroy()
        return 0
    if load_error:
        app.emit(load_error)
        from tkinter import messagebox
        messagebox.showwarning("加载失败", load_error, parent=root)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
