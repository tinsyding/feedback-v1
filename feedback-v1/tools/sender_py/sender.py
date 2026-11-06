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
APP_VERSION = "1.8.23"


def asset_path(filename: str) -> str:
    """返回运行时资源路径：自适应 PyInstaller onefile/onedir、Nuitka standalone/onefile 及源码运行。"""
    # 0. Nuitka onefile 临时解压目录
    nuitka_dir = os.environ.get("NUITKA_ONEFILE_DIRECTORY")
    if nuitka_dir:
        for p in (
            os.path.join(nuitka_dir, filename),
            os.path.join(nuitka_dir, "sender_py", filename),
        ):
            if os.path.isfile(p):
                return p
    # 1. PyInstaller _MEIPASS 优先 (onefile / onedir 临时目录)
    if getattr(sys, "frozen", False) and getattr(sys, "_MEIPASS", None):
        for p in (
            os.path.join(sys._MEIPASS, filename),
            os.path.join(sys._MEIPASS, "sender_py", filename),
        ):
            if os.path.isfile(p):
                return p
    # 2. Nuitka standalone 或 PyInstaller onedir (exe 同级目录)
    if getattr(sys, "frozen", False) or "__compiled__" in globals() or hasattr(sys, "__compiled__"):
        exe_dir = os.path.dirname(os.path.abspath(sys.executable))
        for p in (
            os.path.join(exe_dir, filename),
            os.path.join(exe_dir, "sender_py", filename),
        ):
            if os.path.isfile(p):
                return p
    # 3. 源码同级与上级多层查找
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(here, filename),
        os.path.join(here, "sender_py", filename),
        os.path.normpath(os.path.join(here, "..", filename)),
        os.path.normpath(os.path.join(here, "..", "..", filename)),
    ]
    if sys.argv and sys.argv[0]:
        argv_dir = os.path.dirname(os.path.abspath(sys.argv[0]))
        candidates.extend([
            os.path.join(argv_dir, filename),
            os.path.join(argv_dir, "sender_py", filename),
        ])
    for c in candidates:
        if os.path.isfile(c):
            return c
    return candidates[0]


def app_icon_path():
    """网站 favicon 作为程序图标；找不到时返回 None。"""
    path = asset_path("favicon.ico")
    return path if os.path.isfile(path) else None


try:  # 仓库结构优先；散装拷贝（文件同目录）兜底
    from sender_py.pacing import (
        AFTER_SEND_GAP, BATCH_BREAK_EVERY, BATCH_BREAK_GAP,
        CANDIDATE_GAP, SEARCH_GAP, STUDENT_GAP, pause
    )
    from sender_py.reply_notes import actionable, dedupe_add, make_note, should_record
    from sender_py.roi_manager import (
        crop_chat_tail, default_config_path, derive_chat, load_roi, needs_calibration,
        save_roi, signature_key, to_abs, to_rel, validate_rel, window_signature,
    )
    from sender_py.utils import load_feedback_items, parse_student_identifier
except ModuleNotFoundError:
    from pacing import (
        AFTER_SEND_GAP, BATCH_BREAK_EVERY, BATCH_BREAK_GAP,
        CANDIDATE_GAP, SEARCH_GAP, STUDENT_GAP, pause
    )
    from reply_notes import actionable, dedupe_add, make_note, should_record
    from roi_manager import (
        crop_chat_tail, default_config_path, derive_chat, load_roi, needs_calibration,
        save_roi, signature_key, to_abs, to_rel, validate_rel, window_signature,
    )
    from utils import load_feedback_items, parse_student_identifier

MAX_CANDIDATES = 3
# 默认启用“已发送自动跳过”，避免对同一批次或本周已发学生重复打扰家长
SKIP_SENT = True

FILTER_ALL = "全部"
FILTER_FAILED = "失败/未匹配"
FILTER_VALUES = (FILTER_ALL, "待发送", "已发送", FILTER_FAILED, "已跳过", "已拦截")

VERIFY_MODE_AUTO = "⚡ API优先 (故障自动降级本地OCR)"
VERIFY_MODE_LOCAL = "💻 仅本地OCR (离线免网络)"
VERIFY_MODE_API = "☁️ 仅云端API (Qwen3.8)"
VERIFY_MODES = (VERIFY_MODE_AUTO, VERIFY_MODE_LOCAL, VERIFY_MODE_API)


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


def candidate_search_plan(candidate_index: int, down_first: bool = False) -> list:
    """候选定位按键：先按 Down 选中第 N 个搜索结果，最后 Enter 进入会话。

    企业微信粘贴搜索词后结果列表已经刷新；不能先按 Enter，否则会直接进入
    第一个结果，Down 就变成在会话里移动，第二个候选会选错。

    特殊情况：针对「文件传输助手」或显式指定 down_first=True 时，企微搜索后光标/焦点
    停留在搜索框中，必须先按一次 Down 键才能选中第一项（文件传输助手），再按 Enter 进会话。
    """
    downs = int(candidate_index) if down_first else max(0, int(candidate_index) - 1)
    return ["down"] * max(0, downs) + ["enter"]


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


def search_and_enter(name: str, candidate_index: int = 1, down_first: bool = None) -> bool:
    """搜人进会话：第 candidate_index 个结果。Ctrl+F 聚焦→全选→Backspace 清空→粘贴→等结果→Down 定位→回车进会话。

    注意：企微中「文件传输助手」比较特殊，搜索后焦点停在输入框中，必须先按下一次 Down 键才能选中；
    因此当 name == "文件传输助手" 或显式指定 down_first=True 时，自动在回车前按 Down 键。
    """
    if down_first is None:
        down_first = (name == "文件传输助手")
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
    for action in candidate_search_plan(candidate_index, down_first=down_first):
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


class CalibrationLoadingDialog:
    """校准视野时的极简加载动画弹窗。"""

    def __init__(self, parent, title="正在加载，请稍候", message="正在加载，请稍候..."):
        self.parent = parent
        self._closed = False
        self.top = None

        try:
            import tkinter as tk
            from tkinter import ttk
        except Exception:
            return

        self.tk = tk
        self.ttk = ttk

        try:
            top = tk.Toplevel(parent) if parent else tk.Tk()
            top.title("正在加载，请稍候")
            top.resizable(False, False)
            try:
                top.attributes("-topmost", True)
            except Exception:
                pass
            try:
                if parent:
                    top.transient(parent)
            except Exception:
                pass

            family = "Microsoft YaHei UI" if sys.platform == "win32" else "Arial"
            card = ttk.Frame(top, style="Card.TFrame", padding=(26, 20))
            card.pack(fill="both", expand=True)

            self.status_var = tk.StringVar(master=top, value="正在加载，请稍候...")
            ttk.Label(card, textvariable=self.status_var, font=(family, 10, "bold"), foreground="#1e293b").pack(pady=(4, 12))

            self.pbar = ttk.Progressbar(card, mode="indeterminate", length=260)
            self.pbar.pack(fill="x", pady=(0, 4))
            try:
                self.pbar.start(12)
            except Exception:
                pass

            self.top = top
            self._center(320, 105)
            try:
                top.grab_set()
            except Exception:
                pass
            try:
                top.update()
            except Exception:
                pass
        except Exception:
            self.top = None

    def _center(self, w, h):
        if not self.top:
            return
        try:
            self.top.update_idletasks()
            sw = self.top.winfo_screenwidth()
            sh = self.top.winfo_screenheight()
            if self.parent and hasattr(self.parent, "winfo_rootx") and self.parent.winfo_exists():
                px = self.parent.winfo_rootx()
                py = self.parent.winfo_rooty()
                pw = self.parent.winfo_width()
                ph = self.parent.winfo_height()
                cx = max(10, px + (pw - w) // 2)
                cy = max(10, py + (ph - h) // 2)
            else:
                cx = max(10, (sw - w) // 2)
                cy = max(10, (sh - h) // 2)
            self.top.geometry(f"{int(w)}x{int(h)}+{cx}+{cy}")
        except Exception:
            pass

    def set_status(self, text: str = "", hint: str = None):
        """保持极简纯净，不展示冗长过程说明。"""
        pass

    def close(self):
        self._closed = True
        if self.top:
            try:
                self.pbar.stop()
            except Exception:
                pass
            try:
                self.top.grab_release()
            except Exception:
                pass
            try:
                self.top.destroy()
            except Exception:
                pass
            self.top = None


def open_sample_chat_for_calibration(sample_name: str = None, log=print) -> bool:
    """在执行 ROI 视窗校准前，预先检索并进入一个真实聊天会话，确保企业微信右侧打开具体的聊天窗口。

    解决痛点：当企业微信刚启动或未选定任何联系人时，右侧主区域无聊天会话，导致 Qwen3.8-Max
    识别不到标题栏和输入框。

    优先级：
      1. 若传入有效样本姓名 (sample_name)，优先在企微搜索该姓名；
      2. 若未搜到该联系人（弹出全局搜索）或未传入姓名，自动回退到 100% 存在的系统内置联系人「文件传输助手」。
         注意：「文件传输助手」搜索后焦点在搜索框，需按 Down 键再回车才能进入（search_and_enter 已自动处理）。
    """
    try:
        from sender_py import window_utils as wu
    except ModuleNotFoundError:
        import window_utils as wu

    if not wu.find_and_activate_wecom():
        return False

    target = (sample_name or "").strip()
    candidate_target = target if target else "文件传输助手"

    log(f"  正在预先搜索会话 [{candidate_target}] 以唤起右侧聊天窗口...")
    time.sleep(0.2)
    search_and_enter(candidate_target, 1)

    # 检查是否弹出了全局搜索窗口（说明未在本地联系人中搜到）
    search_tab = wu.find_wecom_search_tab_wnd()
    if search_tab:
        wu.close_wecom_search_tab_wnd(search_tab)
        if candidate_target != "文件传输助手":
            log(f"  联系人 [{candidate_target}] 未搜到，自动切换为系统内置 [文件传输助手] 唤起会话...")
            time.sleep(0.3)
            search_and_enter("文件传输助手", 1)
            second_search = wu.find_wecom_search_tab_wnd()
            if second_search:
                wu.close_wecom_search_tab_wnd(second_search)

    time.sleep(0.6)  # 等待右侧聊天窗口渲染完成
    return True


def ensure_roi(parent, rect, scale, config_path: str = None, server: str = None,
               token=None, log=print, force: bool = False, sample_name: str = None):
    """每个候选处理前检查窗口签名；变了先校准再截图。优先 AI 自动框选，失败优雅回退手动校准。返回 rel roi 或 None（放弃）。"""
    config_path = config_path or default_config_path()
    key = signature_key(rect[2], rect[3], scale)
    if not force and not needs_calibration(config_path, key):
        return load_roi(config_path, key)

    loading = None
    if parent and hasattr(parent, "winfo_exists"):
        try:
            loading = CalibrationLoadingDialog(parent, title="正在加载，请稍候", message="正在加载，请稍候...")
        except Exception:
            loading = None

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
        # 尝试自动将企微向下还原、缩至最小极限尺寸并居中于当前屏幕
        try:
            wu.restore_and_center_wecom(log=log)
        except Exception:
            pass
        fresh = wu.get_wecom_rect()
        if fresh and fresh[2] >= 200 and fresh[3] >= 150:
            rect = fresh
            scale = wu.get_dpi_scale()
            key = signature_key(rect[2], rect[3], scale)
            if not force and not needs_calibration(config_path, key):
                if loading:
                    loading.close()
                return load_roi(config_path, key)
    except Exception:
        pass

    # 预先检索并进入一个聊天会话，确保企业微信右侧界面处于打开聊天的状态
    try:
        if loading:
            loading.set_status("正在打开聊天窗口...", "正在预先唤起会话以确保右侧界面完整...")
        open_sample_chat_for_calibration(sample_name, log=log)
    except Exception as exc:
        log(f"预打开会话提示（可忽略）：{exc}")

    try:
        fresh = wu.get_wecom_rect()
        if fresh and fresh[2] >= 200 and fresh[3] >= 150:
            rect = fresh
            scale = wu.get_dpi_scale()
            key = signature_key(rect[2], rect[3], scale)
    except Exception:
        pass

    img = capture_wecom_window(rect)
    if img is None:
        if loading:
            loading.close()
        return None

    # 1. 优先调用 Qwen3.8-Max 多模态旗舰模型智能自动框选
    ai_roi = None
    try:
        try:
            from sender_py.vision_api import calibrate_roi
        except ModuleNotFoundError:
            from vision_api import calibrate_roi
        log("正在使用 Qwen3.8-Max 多模态模型自动识别企微窗口区域...")
        if loading:
            loading.set_status("正在使用 AI 智能分析视野区域...", "正在使用 Qwen3.8-Max 模型自动框选")
        ai_roi = calibrate_roi(img, server=server or "https://feedback.wxjifang.cn", token=token)
    except Exception as exc:
        log(f"AI 自动识别网络异常：{exc}")

    if ai_roi and isinstance(ai_roi, dict) and all(k in ai_roi for k in ("title", "input", "chat")):
        if all(validate_rel(ai_roi[k]) for k in ("title", "input", "chat")):
            log(f"✓ Qwen3.8-Max 自动框选成功（{ai_roi.get('reason', '')}），已自动生效！")
            save_roi(config_path, key, ai_roi["title"], ai_roi["input"], ai_roi["chat"])
            if loading:
                loading.close()
            return {"title": tuple(ai_roi["title"]), "input": tuple(ai_roi["input"]), "chat": tuple(ai_roi["chat"])}
        else:
            log("AI 识别坐标超出有效范围，正在回退至手动校准...")
    else:
        log("AI 自动定位未通过（可能未点进具体聊天），正在弹出手动校准窗口...")

    if loading:
        loading.close()

    # 2. 优雅回退到手动框选（弹出居中大窗口，若有 AI 坐标则自动预填）
    roi = run_calibration(parent, img, initial_roi=ai_roi)
    if roi is None:
        return None
    save_roi(config_path, key, roi["title"], roi["input"], roi["chat"])
    return {"title": tuple(roi["title"]), "input": tuple(roi["input"]), "chat": tuple(roi["chat"])}


class AsyncReplyAnalyzer:
    """方案 A 后台异步留言分析线程池：主流程秒验标题后立即发作业，将留言截图交由后台并发判定。"""

    def __init__(self, server: str, token: str = None, max_workers: int = 3, event_queue=None):
        from concurrent.futures import ThreadPoolExecutor
        self.server = server
        self.token = token
        self.event_queue = event_queue
        self._lock = threading.Lock()
        self._pending = 0
        self._executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="ReplyWorker")

    @property
    def pending_count(self) -> int:
        with self._lock:
            return self._pending

    def _emit_event(self, event):
        if self.event_queue is not None:
            try:
                self.event_queue.put_nowait(event)
            except Exception:
                pass

    def submit(self, student_name: str, cand: int, sid: str, sname: str,
               chat_title: str, matched: bool, chat_img):
        if chat_img is None:
            return
        with self._lock:
            self._pending += 1
            pending = self._pending
        self._emit_event(("progress", pending))
        self._executor.submit(
            self._worker, student_name, cand, sid, sname, chat_title, matched, chat_img
        )

    def _worker(self, student_name: str, cand: int, sid: str, sname: str,
                chat_title: str, matched: bool, chat_img):
        try:
            try:
                from sender_py.vision_api import identify_reply
            except ModuleNotFoundError:
                from vision_api import identify_reply
            reply_res = identify_reply(
                chat_img, sid, sname, chat_title, self.server, self.token
            )
            judgment = {
                "matched": matched,
                "detected_title": chat_title,
                "last_sender": reply_res.get("last_sender"),
                "last_message_text": reply_res.get("last_message_text", ""),
                "needs_reply": reply_res.get("needs_reply"),
                "reason": reply_res.get("reason", ""),
            }
        except Exception as exc:
            # 异常时遵循 fail-open 原则：needs_reply=None（记“待人工确认”），绝不漏掉家长留言
            judgment = {
                "matched": matched,
                "detected_title": chat_title,
                "last_sender": "unknown",
                "last_message_text": f"(后台分析异常: {exc})",
                "needs_reply": None,
                "reason": str(exc),
            }
        try:
            if should_record(chat_title, judgment):
                note = make_note(student_name, cand, chat_title, matched, judgment)
                self._emit_event(("note", note, judgment))
        finally:
            with self._lock:
                self._pending = max(0, self._pending - 1)
                pending = self._pending
            self._emit_event(("progress", pending))

    def shutdown(self, wait: bool = False):
        try:
            self._executor.shutdown(wait=wait, cancel_futures=True)
        except Exception:
            try:
                self._executor.shutdown(wait=wait)
            except Exception:
                pass


def rescue_option1_fuzzy_match(judgment: dict, target_id: str, target_name: str) -> dict:
    """方案1智能容错：在非群聊且学号精确匹配的前提下，允许姓名存在1字形近/OCR误差。"""
    if not isinstance(judgment, dict):
        return judgment
    if judgment.get("matched") is True or judgment.get("is_group") is True:
        return judgment

    try:
        try:
            from sender_py.local_ocr import detect_is_group, match_name_fuzzy, normalize_clean
        except ModuleNotFoundError:
            from local_ocr import detect_is_group, match_name_fuzzy, normalize_clean

        title = str(judgment.get("detected_title") or "")
        clean_title = normalize_clean(title)
        clean_id = normalize_clean(target_id)
        if clean_id and not detect_is_group(title):
            if clean_id in clean_title:
                name_ok, name_reason = match_name_fuzzy(target_name, clean_title)
                if name_ok:
                    judgment["matched"] = True
                    judgment["reason"] = f"方案1容错放行：学号[{target_id}]精准吻合，{name_reason}"
    except Exception:
        pass
    return judgment


def judge_candidate(rect, roi, target_id: str, target_name: str, server: str,
                    token=None, fast_title_only: bool = False,
                    verify_mode: str = "auto", cand: int = 1) -> tuple:
    """整窗截图→裁 title/chat_tail→判定。

    verify_mode:
      - 'auto': 优先调用云端 API（qwen3.8-flash 秒验），API 异常时自动无缝降级到本地 OCR 备选方案；
      - 'local': 强制离线使用本地 OCR 核验（无需网络请求）；
      - 'api': 仅使用云端 API，不降级。

    fast_title_only=True（方案 A 异步加速）：
      仅上传极小的 title_img 秒验身份与群聊，同时把发送前截好的 chat_img 一并返回供后台线程异步分析。
      返回 (judgment|None, chat_title|None, error|None, chat_img|None)。
    fast_title_only=False（传统同步模式）：
      返回 (judgment|None, chat_title|None, error|None)。
    """
    try:
        from sender_py.capture import capture_wecom_window, crop_by_rel
        from sender_py.vision_api import identify, identify_title
    except ModuleNotFoundError:
        from capture import capture_wecom_window, crop_by_rel
        from vision_api import identify, identify_title
    img = capture_wecom_window(rect)
    if img is None:
        return (None, None, "整窗截图失败", None) if fast_title_only else (None, None, "整窗截图失败")
    W, H = img.size
    title_abs = to_abs(roi["title"], (W, H))
    chat_abs = to_abs(roi["chat"], (W, H))
    title_img = crop_by_rel(img, roi["title"])
    chat_img = crop_chat_tail(crop_by_rel(img, roi["chat"]))
    _ = (title_abs, chat_abs)

    def _fallback_local(err_msg: str):
        try:
            try:
                from sender_py.local_ocr import identify_title_local
            except ModuleNotFoundError:
                from local_ocr import identify_title_local
            local_res = identify_title_local(title_img, target_id, target_name)
            if local_res and local_res.get("title_in_header"):
                if "ADMIN_FORCED_LOCAL_OCR" in err_msg:
                    local_res["reason"] = f"[强制本地OCR] {local_res.get('reason', '')}"
                else:
                    local_res["reason"] = f"[备选方案: 本地OCR] {local_res.get('reason', '')} (API异常: {err_msg})"
                return local_res
        except Exception:
            pass
        return None

    if fast_title_only:
        judgment = None
        err = None
        if verify_mode == "local":
            try:
                from sender_py.local_ocr import identify_title_local
            except ModuleNotFoundError:
                from local_ocr import identify_title_local
            judgment = identify_title_local(title_img, target_id, target_name)
            judgment["reason"] = f"[本地OCR模式] {judgment.get('reason', '')}"
        else:
            # 三层阶梯式智能核验：
            # 第 1 层 winocr (WinRT ~47ms) -> 第 2 层 RapidOCR 全流程 (Det+Rec ~800ms)
            try:
                from sender_py.local_ocr import identify_title_local
            except ModuleNotFoundError:
                from local_ocr import identify_title_local
            local_res = identify_title_local(title_img, target_id, target_name)

            # 若本地两层已成功匹配，直接毫秒级极速放行！
            if local_res and local_res.get("matched"):
                judgment = local_res
                judgment["reason"] = f"[备选方案: 本地OCR] {judgment.get('reason', '')}"
            else:
                # 第 3 层：Qwen3.8-Flash 云端多模态大模型终极兜底（本地未通过时才介入）
                try:
                    judgment = identify_title(title_img, target_id, target_name, server, token)
                    if judgment and judgment.get("matched"):
                        judgment["reason"] = f"[Qwen-Flash兜底通过] {judgment.get('reason', '')}"
                except Exception as e:
                    # 云端报错或管理员开启了【强制本地OCR】(ADMIN_FORCED_LOCAL_OCR)，采纳本地判定
                    judgment = local_res or parse_title_judgment("", target_id, target_name)
                    if "ADMIN_FORCED_LOCAL_OCR" in str(e):
                        judgment["reason"] = f"[强制本地OCR] {judgment.get('reason', '')}"
                    else:
                        judgment["reason"] = f"[备选方案: 本地OCR] {judgment.get('reason', '')} (API异常: {e})"
        if judgment is not None:
            judgment = rescue_option1_fuzzy_match(judgment, target_id, target_name)
            try:
                try:
                    from sender_py.debug_utils import save_candidate_snapshot
                except ModuleNotFoundError:
                    from debug_utils import save_candidate_snapshot
                diag_meta = {
                    "title_abs": title_abs,
                    "roi": roi,
                    "rect": rect,
                    "local_res": local_res if 'local_res' in locals() else None,
                    "judgment": judgment,
                }
                snap_info = save_candidate_snapshot(img, roi, title_img, target_id, target_name, cand=cand, diag_info=diag_meta)
                judgment["_diag"] = {
                    "snapshot": snap_info,
                    "local_res": local_res if 'local_res' in locals() else None,
                    "title_abs": title_abs,
                }
            except Exception:
                pass
            return (judgment, judgment.get("detected_title"), None, chat_img)
        return (None, None, err, chat_img)

    if verify_mode == "local":
        try:
            from sender_py.local_ocr import identify_title_local
        except ModuleNotFoundError:
            from local_ocr import identify_title_local
        judgment = identify_title_local(title_img, target_id, target_name)
        judgment["last_sender"] = "unknown"
        judgment["last_message_text"] = "(本地OCR模式)"
        judgment["needs_reply"] = None
        judgment["reason"] = f"[本地OCR模式] {judgment.get('reason', '')}"
        judgment = rescue_option1_fuzzy_match(judgment, target_id, target_name)
        try:
            try:
                from sender_py.debug_utils import save_candidate_snapshot
            except ModuleNotFoundError:
                from debug_utils import save_candidate_snapshot
            diag_meta = {"title_abs": title_abs, "roi": roi, "rect": rect, "judgment": judgment}
            snap_info = save_candidate_snapshot(img, roi, title_img, target_id, target_name, cand=cand, diag_info=diag_meta)
            judgment["_diag"] = {"snapshot": snap_info, "local_res": judgment, "title_abs": title_abs}
        except Exception:
            pass
        return (judgment, judgment.get("detected_title"), None)

    try:
        judgment = identify(title_img, chat_img, target_id, target_name, server, token)
    except Exception as e:
        if verify_mode == "auto":
            local_res = _fallback_local(str(e))
            if local_res is not None:
                local_res["last_sender"] = "unknown"
                local_res["last_message_text"] = "(API异常，本地OCR备用通道)"
                local_res["needs_reply"] = None
                local_res = rescue_option1_fuzzy_match(local_res, target_id, target_name)
                try:
                    try:
                        from sender_py.debug_utils import save_candidate_snapshot
                    except ModuleNotFoundError:
                        from debug_utils import save_candidate_snapshot
                    diag_meta = {"title_abs": title_abs, "roi": roi, "rect": rect, "judgment": local_res}
                    snap_info = save_candidate_snapshot(img, roi, title_img, target_id, target_name, cand=cand, diag_info=diag_meta)
                    local_res["_diag"] = {"snapshot": snap_info, "local_res": local_res, "title_abs": title_abs}
                except Exception:
                    pass
                return (local_res, local_res.get("detected_title"), None)
        return (None, None, str(e))
    judgment = rescue_option1_fuzzy_match(judgment, target_id, target_name)
    try:
        try:
            from sender_py.debug_utils import save_candidate_snapshot
        except ModuleNotFoundError:
            from debug_utils import save_candidate_snapshot
        diag_meta = {"title_abs": title_abs, "roi": roi, "rect": rect, "judgment": judgment}
        snap_info = save_candidate_snapshot(img, roi, title_img, target_id, target_name, cand=cand, diag_info=diag_meta)
        judgment["_diag"] = {"snapshot": snap_info, "local_res": None, "title_abs": title_abs}
    except Exception:
        pass
    return (judgment, judgment.get("detected_title"), None)


def send_student(item: dict, server: str, token=None, config_path: str = None,
                 parent=None, log=print, should_stop=None, reply_analyzer=None,
                 verify_mode: str = "auto") -> dict:
    """单个学生全流程：最多 3 候选机械 1→2→3。返回 {result, notes, ...}（notes 供待回名单）。"""
    try:
        from sender_py import window_utils as wu
    except ModuleNotFoundError:
        import window_utils as wu
    name, sid, sname, message = item["studentName"], item["sid"], item["sname"], item["message"]
    notes = []

    # 清理之前可能遗留的企业微信“全局搜索”弹窗
    old_search = wu.find_wecom_search_tab_wnd()
    if old_search:
        wu.close_wecom_search_tab_wnd(old_search)

    def _check_and_handle_search_tab():
        tab_hwnd = wu.find_wecom_search_tab_wnd()
        if tab_hwnd:
            log(f"  检测到企业微信弹出【全局搜索】窗口 (SearchTabWnd2)，表明未搜到该学生 [{name}]")
            log(f"  └ 自动关闭全局搜索窗口，直接跳过并开始处理下一位学生...")
            wu.close_wecom_search_tab_wnd(tab_hwnd)
            return True
        return False

    def _paced(gaps):
        import random
        secs = random.uniform(*gaps)
        log(f"[{name}] 随机停顿 {secs:.1f}s")
        deadline = time.monotonic() + secs
        while time.monotonic() < deadline:
            if should_stop is not None and should_stop():
                break
            time.sleep(min(0.04, max(0.0, deadline - time.monotonic())))

    for cand in range(1, MAX_CANDIDATES + 1):
        if should_stop is not None and should_stop():
            log(f"[{name}] 收到停止请求，当前学生未发送")
            return {"result": "stopped", "reason": "用户停止", "notes": notes}
        # 所有截图的前提：企微完整可见，否则 mss 截到遮挡物/屏外黑边
        if not wu.find_and_activate_wecom():
            if should_stop is not None and should_stop():
                log(f"[{name}] 收到停止请求，当前学生未发送")
                return {"result": "stopped", "reason": "用户停止", "notes": notes}
            return {"result": "error", "reason": "企微唤起失败（最小化或无响应），请手动点开后重试",
                    "notes": notes}
        time.sleep(0.3)
        ok_vis, vis = wu.ensure_fully_visible(log=log)
        if not ok_vis:
            return {"result": "error", "reason": f"窗口半截在屏幕外且无法自动归位：{vis}",
                    "notes": notes}
        rect = vis
        if not rect:
            return {"result": "error", "reason": "找不到企微窗口", "notes": notes}
        scale = wu.get_dpi_scale()
        roi = ensure_roi(parent, rect, scale, config_path, server=server, token=token, log=log, sample_name=name)
        if roi is None:
            log("⏹ 视野校准已放弃，安全中止后续发送任务。")
            return {"result": "stopped", "reason": "ROI 校准未完成", "notes": notes}
        # 校准过程可能将企微向下还原并居中，此处必须刷新最新物理坐标
        try:
            fresh_rect = wu.get_wecom_rect()
            if fresh_rect and fresh_rect[2] >= 200 and fresh_rect[3] >= 150:
                rect = fresh_rect
        except Exception:
            pass
        if should_stop is not None and should_stop():
            log(f"[{name}] 收到停止请求，候选{cand}未发送")
            return {"result": "stopped", "reason": "用户停止", "notes": notes}
        log(f"  └ 正在通过企业微信快捷键 (Ctrl+F) 聚焦搜索候选 {cand}/{MAX_CANDIDATES}...")
        entered = search_and_enter(name, cand)
        if _check_and_handle_search_tab():
            return {"result": "unmatched", "reason": "未找到学生（弹出全局搜索窗口）", "notes": notes}
        if entered:  # 截图前焦点守护：mss 截的是屏幕像素，失焦会被遮挡物污染
            if should_stop is not None and should_stop():
                log(f"[{name}] 收到停止请求，候选 {cand} 未发送")
                return {"result": "stopped", "reason": "用户停止", "notes": notes}
            if not wu.find_and_activate_wecom():
                if should_stop is not None and should_stop():
                    log(f"[{name}] 收到停止请求，候选 {cand} 未发送")
                    return {"result": "stopped", "reason": "用户停止", "notes": notes}
                log(f"  └ 候选 {cand}：企微唤起失败，尝试下一候选")
                _paced(CANDIDATE_GAP)
                continue
            import random
            search_delay = random.uniform(*SEARCH_GAP)
            log(f"  └ 搜索完成，随机停顿 {search_delay:.2f} 秒...")
            deadline = time.monotonic() + search_delay
            while time.monotonic() < deadline:
                if should_stop is not None and should_stop():
                    break
                time.sleep(min(0.04, max(0.0, deadline - time.monotonic())))
            if _check_and_handle_search_tab():
                return {"result": "unmatched", "reason": "未找到学生（弹出全局搜索窗口）", "notes": notes}
        if should_stop is not None and should_stop():
            log(f"  └ 收到停止请求，候选 {cand} 未发送")
            return {"result": "stopped", "reason": "用户停止", "notes": notes}
        if _check_and_handle_search_tab():
            return {"result": "unmatched", "reason": "未找到学生（弹出全局搜索窗口）", "notes": notes}
        # 截图核验前再次确认最新窗口矩形
        try:
            fresh_rect = wu.get_wecom_rect()
            if fresh_rect and fresh_rect[2] >= 200 and fresh_rect[3] >= 150:
                rect = fresh_rect
        except Exception:
            pass
        if reply_analyzer is not None:
            judgment, chat_title, err, chat_img = judge_candidate(
                rect, roi, sid, sname, server, token, fast_title_only=True,
                verify_mode=verify_mode, cand=cand
            )
        else:
            judgment, chat_title, err = judge_candidate(
                rect, roi, sid, sname, server, token, verify_mode=verify_mode,
                cand=cand
            )
            chat_img = None
            if entered and should_record(chat_title, judgment):
                dedupe_add(notes, make_note(name, cand, chat_title, bool((judgment or {}).get("matched")), judgment or {}))
        if should_stop is not None and should_stop():
            log(f"  └ 收到停止请求，候选 {cand} 未发送")
            return {"result": "stopped", "reason": "用户停止", "notes": notes}

        # 输出详细核验诊断信息与截图存盘通知
        diag = (judgment or {}).get("_diag", {})
        title_abs = diag.get("title_abs")
        snap = diag.get("snapshot") or {}
        local_res = diag.get("local_res") or {}
        if title_abs:
            log(f"  [诊断] 标题栏裁切尺寸: {title_abs[2]}x{title_abs[3]} (位于原图坐标 x={title_abs[0]}, y={title_abs[1]})")
        if local_res:
            log(f"  [诊断] 本地OCR识别原文: [{local_res.get('detected_title') or '未检测到文字'}] ({local_res.get('reason', '')})")
        if snap.get("title_filename"):
            log(f"  [现场截图已存盘] 标题图: {snap['title_filename']} (存档目录: {snap.get('debug_dir')})")
        if err is not None:
            log(f"  └ 候选 {cand} 校验异常：{err}，换下一候选")
            _paced(CANDIDATE_GAP)
            continue
        if judgment and "方案1容错放行" in str(judgment.get("reason", "")):
            log(f"  方案1智能容错生效：{judgment.get('reason')}")
        elif judgment and ("[备选方案: 本地OCR]" in str(judgment.get("reason", "")) or "[本地OCR模式]" in str(judgment.get("reason", "")) or "[强制本地OCR]" in str(judgment.get("reason", ""))):
            if "[强制本地OCR]" in str(judgment.get("reason", "")):
                log(f"  └ 管理员已开启强制本地OCR：{judgment.get('reason')}")
            else:
                log(f"  └ 采用本地 OCR 备用通道核验：{judgment.get('reason')}")
        decision = decide_action(judgment)
        if decision["action"] == "send":
            log(f"  ✓ 候选 {cand} 核验通过 (窗口标题: [{chat_title or '未知'}])，符合发送条件")
            if should_stop is not None and should_stop():
                log(f"  └ 收到停止请求，候选 {cand} 未发送")
                return {"result": "stopped", "reason": "用户停止", "notes": notes}
            if reply_analyzer is not None and chat_img is not None:
                reply_analyzer.submit(name, cand, sid, sname, chat_title, True, chat_img)
                log("  └ 已将聊天区截图投递至后台分析家长留言，立即开始发送反馈话术...")
            ok, why = paste_and_send(message)
            if ok:
                log(f"  ✓ [{name}] 反馈话术已成功粘贴并回车发送！")
            else:
                log(f"  ✗ [{name}] 反馈话术发送失败：{why}")
            if should_stop is None or not should_stop():
                _paced(AFTER_SEND_GAP)
            return {"result": "sent" if ok else "error",
                    "at_candidate": cand, "reason": why, "notes": notes}
        if decision["action"] == "intercept":
            log(f"  ✗ 候选 {cand} 命中安全红线拦截：检测为群聊 (窗口标题: [{chat_title or '未知'}])，安全拦截！")
            return {"result": "blocked", "at_candidate": cand,
                    "reason": decision["reason"], "notes": notes}
        log(f"  ✗ 候选 {cand} 核验未通过：学号或姓名不匹配 (实际窗口标题: [{chat_title or '未检测到'}])")
        _paced(CANDIDATE_GAP)
    log(f"  ✗ [{name}] 前 {MAX_CANDIDATES} 个候选均未匹配到对应的私聊窗口")
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
        self._file_counts = {}
        if self.input_paths:
            for p in self.input_paths:
                try:
                    loaded = load_feedback_items(p)
                    self._file_counts[p] = len(loaded)
                except Exception:
                    self._file_counts[p] = 0
        self.reply_notes = []
        self._history = None
        self._sent_files = None
        try:
            try:
                from sender_py.store import HistoryManager, SentFilesManager
            except ModuleNotFoundError:
                from store import HistoryManager, SentFilesManager
            self._history = HistoryManager()
            self._sent_files = SentFilesManager()
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
        self._tree_item_map = {}
        self._item_tree_map = {}
        self._last_checked_idx = None
        import queue
        self._reply_event_queue = queue.Queue()
        self._pending_reply_tasks = 0
        self._reply_analyzer = None
        try:
            try:
                from sender_py.vision_api import load_token
            except ModuleNotFoundError:
                from vision_api import load_token
            self.token = load_token() or None
        except Exception:
            self.token = None

        self._setup_appearance(root)
        root.title(APP_NAME)
        # 默认大视窗居中启动，让表格与明细视野开阔，无需手动反复拉大
        sw = root.winfo_screenwidth() or 1920
        sh = root.winfo_screenheight() or 1080
        target_w = min(1360, max(1080, int(sw * 0.78)))
        target_h = min(880, max(720, int(sh * 0.82)))
        if target_w >= sw:
            target_w = max(960, sw - 50)
        if target_h >= sh:
            target_h = max(620, sh - 70)
        x = max(0, (sw - target_w) // 2)
        y = max(0, (sh - target_h) // 2 - 25)
        root.geometry(f"{target_w}x{target_h}+{x}+{y}")
        root.minsize(1040, 660)
        root.protocol("WM_DELETE_WINDOW", self.on_close)
        root.bind("<Escape>", self.request_stop)
        root.bind("<Control-Alt-b>", self.open_benchmark_window)
        root.bind("<Control-Alt-B>", self.open_benchmark_window)
        root.bind("<Control-Shift-D>", self.open_benchmark_window)
        root.bind("<Control-Shift-d>", self.open_benchmark_window)

        self._build_ui()
        self.search_var.trace_add("write", self._on_search_change)
        self.update_file_pool_ui()
        self.rebuild_student_list()
        self._schedule_reply_drain()

    def _center_window(self, win, w, h):
        try:
            win.update_idletasks()
            sw = win.winfo_screenwidth()
            sh = win.winfo_screenheight()
            if self.root and self.root.winfo_exists():
                px = self.root.winfo_rootx()
                py = self.root.winfo_rooty()
                pw = self.root.winfo_width()
                ph = self.root.winfo_height()
                cx = max(10, px + (pw - w) // 2)
                cy = max(10, py + (ph - h) // 2)
            else:
                cx = max(10, (sw - w) // 2)
                cy = max(10, (sh - h) // 2)
            win.geometry(f"{int(w)}x{int(h)}+{cx}+{cy}")
        except Exception:
            try:
                win.geometry(f"{int(w)}x{int(h)}")
            except Exception:
                pass

    def _setup_appearance(self, root):
        """字体、原生高速扁平化主题、状态色、网站 logo；使用 C 级原生渲染代替重型 PNG 贴图，确保拖拽与滚动丝滑零掉帧。"""
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
        self._using_sv_ttk = True
        style = ttk.Style(root)
        self._style = style
        try:
            style.theme_use("clam")
        except Exception:
            pass

        # 主题设置完再覆盖命名字体，确保中文在 Entry/Combobox/Treeview 里也一致。
        for name in ("TkDefaultFont", "TkTextFont", "TkMenuFont", "TkHeadingFont"):
            try:
                tkfont.nametofont(name).configure(family=family, size=10)
            except Exception:
                pass

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
        style.configure("Logo.TLabel", font=(family, 18, "bold"), foreground="#ffffff", background="#2563eb", padding=(7, 2))
        style.configure("LogoImg.TLabel", background=card_bg)

        # File Pool Tag Styles
        style.configure("FileTag.TFrame", background="#eff6ff")
        style.configure("FileTag.TLabel", font=(family, 9), foreground="#1d4ed8", background="#eff6ff")
        style.configure("FileTagDel.TLabel", font=(family, 9, "bold"), foreground="#94a3b8", background="#eff6ff", padding=(2, 0))
        style.map("FileTagDel.TLabel", foreground=[("active", "#ef4444")])

        # High-Performance Flat Button & Control Styles
        style.configure(
            "TButton", font=(family, 9), background="#f1f5f9", foreground="#1e293b",
            borderwidth=1, relief="flat", focusthickness=0, bordercolor="#cbd5e1", padding=(8, 4)
        )
        style.map(
            "TButton",
            background=[("active", "#e2e8f0"), ("pressed", "#cbd5e1"), ("disabled", "#f8fafc")],
            foreground=[("disabled", "#94a3b8")],
        )
        style.configure("Toolbar.TButton", font=(family, 9), padding=(8, 4))
        style.configure("Secondary.TButton", font=(family, 9), padding=(8, 4))
        style.configure("RowAction.TButton", font=(family, 8), padding=(5, 2))
        style.configure(
            "Accent.TButton", font=(family, 9, "bold"), background="#2563eb", foreground="#ffffff",
            borderwidth=0, relief="flat", padding=(11, 5)
        )
        style.map(
            "Accent.TButton",
            background=[("active", "#1d4ed8"), ("pressed", "#1e40af"), ("disabled", "#93c5fd")],
            foreground=[("disabled", "#e2e8f0")],
        )
        style.configure(
            "PrimaryLarge.TButton", font=(family, 10, "bold"), background="#2563eb", foreground="#ffffff",
            borderwidth=0, relief="flat", padding=(16, 7)
        )
        style.map(
            "PrimaryLarge.TButton",
            background=[("active", "#1d4ed8"), ("pressed", "#1e40af"), ("disabled", "#93c5fd")],
            foreground=[("disabled", "#e2e8f0")],
        )
        style.configure(
            "Danger.TButton", font=(family, 9, "bold"), background="#fee2e2", foreground="#dc2626",
            borderwidth=1, relief="flat", bordercolor="#fca5a5", padding=(10, 5)
        )
        style.map(
            "Danger.TButton",
            background=[("active", "#fecaca"), ("pressed", "#fca5a5"), ("disabled", "#f8fafc")],
            foreground=[("disabled", "#cbd5e1")],
        )
        self._accent_style = "Accent.TButton"

        # Entry, Combobox, Progressbar & Scrollbar Styles
        style.configure("TEntry", fieldbackground="#ffffff", foreground="#0f172a", bordercolor="#cbd5e1", padding=(6, 4))
        style.configure("TCombobox", fieldbackground="#ffffff", background="#f1f5f9", foreground="#0f172a", arrowsize=13, padding=(5, 3))
        style.map("TCombobox", fieldbackground=[("readonly", "#ffffff")])
        style.configure("Horizontal.TProgressbar", troughcolor="#e2e8f0", background="#2563eb", bordercolor="#e2e8f0", lightcolor="#2563eb", darkcolor="#2563eb", thickness=8)
        style.configure("Vertical.TScrollbar", background="#cbd5e1", troughcolor="#f8fafc", bordercolor="#f8fafc", arrowsize=12)

        # Native Hardware-Accelerated Treeview Styles (Single HWND for entire table)
        style.configure(
            "Treeview",
            font=(family, 10),
            rowheight=34,
            background="#ffffff",
            fieldbackground="#ffffff",
            foreground="#1e293b",
            borderwidth=0,
            relief="flat",
        )
        style.configure(
            "Treeview.Heading",
            font=(family, 9, "bold"),
            background="#f1f5f9",
            foreground="#475569",
            relief="flat",
            borderwidth=0,
            padding=(8, 7),
        )
        style.map(
            "Treeview.Heading",
            background=[("active", "#e2e8f0")],
            foreground=[("active", "#0f172a")],
        )
        style.map(
            "Treeview",
            background=[("selected", "#eff6ff")],
            foreground=[("selected", "#1d4ed8")],
        )

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

        # 确保设置独立 AppUserModelID，使任务栏识别极方应用图标
        try:
            try:
                from sender_py.window_utils import set_app_user_model_id
            except ModuleNotFoundError:
                from window_utils import set_app_user_model_id
            set_app_user_model_id()
        except Exception:
            pass

        icon_path = app_icon_path()
        if icon_path:
            try:
                from PIL import Image, ImageTk
                source = Image.open(icon_path).convert("RGBA")
                logo = source.copy()
                logo.thumbnail((44, 44), Image.LANCZOS)
                self._logo_image = ImageTk.PhotoImage(logo, master=root)
                window_icon = source.copy()
                window_icon.thumbnail((64, 64), Image.LANCZOS)
                self._window_icon = ImageTk.PhotoImage(window_icon, master=root)
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

    def _current_verify_mode(self) -> str:
        """默认走 API（Qwen3.8-Flash），API 异常时自动无缝降级走本地 OCR 兜底。"""
        return "auto"

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
        self.logo_label = ttk.Label(header_left, style="LogoImg.TLabel")
        if self._logo_image is not None:
            self.logo_label.config(image=self._logo_image)
            self.logo_label.image = self._logo_image
        else:
            self.logo_label.config(text="极", style="Logo.TLabel")
        self.logo_label.pack(side="left", padx=(0, 12))

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

        self.sent_files_btn = ttk.Button(
            header_actions, text="📁 已发文件", style="Toolbar.TButton",
            command=self.show_sent_files_dialog)
        self.sent_files_btn.pack(side="left", padx=(0, 6))

        self.log_btn = ttk.Button(
            header_actions, text="📜 运行日志", style="Toolbar.TButton",
            command=self.open_log_window)
        self.log_btn.pack(side="left")

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

        # ================= 2.5 已选反馈文件区 (可多次追加，支持直接拖入) =================
        file_pool_card = ttk.Frame(main, style="Card.TFrame", padding=(12, 8))
        file_pool_card.pack(fill="x", pady=(0, 10))

        pool_top = ttk.Frame(file_pool_card, style="Card.TFrame")
        pool_top.pack(fill="x")

        pool_left = ttk.Frame(pool_top, style="Card.TFrame")
        pool_left.pack(side="left", fill="y")
        self.file_pool_summary_var = tk.StringVar(master=self.root, value="尚未选择文件")
        ttk.Label(pool_left, textvariable=self.file_pool_summary_var, style="Hint.TLabel").pack(side="left")

        pool_actions = ttk.Frame(pool_top, style="Card.TFrame")
        pool_actions.pack(side="right")
        self.add_file_btn = ttk.Button(
            pool_actions, text="➕ 添加文件", style=self._accent_style,
            command=self.choose_and_add_files)
        self.add_file_btn.pack(side="left", padx=(0, 6))
        self.clear_pool_btn = ttk.Button(
            pool_actions, text="🗑️ 清空", style="Toolbar.TButton",
            command=self.clear_input_files)
        self.clear_pool_btn.pack(side="left")

        self.file_tags_container = ttk.Frame(file_pool_card, style="Card.TFrame")
        self.file_tags_container.pack(fill="x", pady=(6, 0))
        self.file_tags_inner = ttk.Frame(self.file_tags_container, style="Card.TFrame")
        self.file_tags_inner.pack(fill="x")

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
        self.retry_failed_btn.pack(side="left", padx=(0, 4))

        self.copy_failed_btn = ttk.Button(
            tb_left, text="📋 复制失败名单", style="Toolbar.TButton",
            command=self.copy_failed_list)
        self.copy_failed_btn.pack(side="left")

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

        # ================= 4. 学生列表主卡片 (原生单句柄 Treeview 极速表格) =================
        list_card = ttk.Frame(main, style="Card.TFrame")
        list_card.pack(fill="both", expand=True, pady=(0, 8))

        list_outer = ttk.Frame(list_card, style="Card.TFrame")
        list_outer.pack(fill="both", expand=True)

        cols = ("select", "sid", "sname", "status", "reason", "copy_name", "copy_msg")
        self.students_tree = ttk.Treeview(
            list_outer, columns=cols, show="headings", selectmode="browse"
        )
        scrollbar = ttk.Scrollbar(
            list_outer, orient="vertical", command=self.students_tree.yview
        )
        self.students_tree.configure(yscrollcommand=scrollbar.set)

        self.students_tree.heading("select", text="☑ 选", anchor="center")
        self.students_tree.heading("sid", text="学号", anchor="w")
        self.students_tree.heading("sname", text="姓名", anchor="w")
        self.students_tree.heading("status", text="状态", anchor="center")
        self.students_tree.heading("reason", text="处理明细 / 最新备注", anchor="w")
        self.students_tree.heading("copy_name", text="复制信息", anchor="center")
        self.students_tree.heading("copy_msg", text="复制话术", anchor="center")

        self.students_tree.column("select", width=54, minwidth=46, stretch=False, anchor="center")
        self.students_tree.column("sid", width=100, minwidth=75, stretch=False, anchor="w")
        self.students_tree.column("sname", width=115, minwidth=85, stretch=False, anchor="w")
        self.students_tree.column("status", width=115, minwidth=95, stretch=False, anchor="center")
        self.students_tree.column("reason", width=420, minwidth=180, stretch=True, anchor="w")
        self.students_tree.column("copy_name", width=128, minwidth=110, stretch=False, anchor="center")
        self.students_tree.column("copy_msg", width=106, minwidth=92, stretch=False, anchor="center")

        self.students_tree.tag_configure("st_待发送_even", background="#ffffff", foreground="#1e293b")
        self.students_tree.tag_configure("st_待发送_odd", background="#f8fafc", foreground="#1e293b")
        self.students_tree.tag_configure("st_发送中", background="#eff6ff", foreground="#1d4ed8")
        self.students_tree.tag_configure("st_已发送", background="#f0fdf4", foreground="#15803d")
        self.students_tree.tag_configure("st_发送失败", background="#fef2f2", foreground="#b91c1c")
        self.students_tree.tag_configure("st_已拦截", background="#fffbeb", foreground="#b45309")
        self.students_tree.tag_configure("st_未匹配", background="#fffbeb", foreground="#b45309")
        self.students_tree.tag_configure("st_已跳过", background="#f8fafc", foreground="#94a3b8")
        self.students_tree.tag_configure("st_已跳过（已发送）", background="#f8fafc", foreground="#94a3b8")
        self.students_tree.tag_configure("st_empty", background="#ffffff", foreground="#64748b")

        self.students_tree.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")

        self.students_tree.bind("<Button-1>", self._on_tree_click)
        self.students_tree.bind("<Double-1>", self._on_tree_double_click)
        self.students_tree.bind("<Motion>", self._on_tree_motion)

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
            value="💡 勾选学生后点“开始发送” · 发送中按 Esc 停止 · 请勿将企微拖出屏幕外或改动大小")
        ttk.Label(progress_box, textvariable=self.hint_var, style="Hint.TLabel",
                  anchor="w", wraplength=640).pack(fill="x")

        actions = ttk.Frame(footer, style="Card.TFrame")
        actions.pack(side="right", padx=(14, 0), anchor="center")

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
                self._apply_selection_status(item, var.get(), refresh_summary=False)
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
        widgets_to_toggle = [
            self.select_all_btn, self.select_none_btn,
            self.failed_only_btn, self.retry_failed_btn,
            self.copy_failed_btn, self.calib_btn
        ]
        if hasattr(self, "add_file_btn"):
            widgets_to_toggle.append(self.add_file_btn)
        if hasattr(self, "clear_pool_btn"):
            widgets_to_toggle.append(self.clear_pool_btn)
        for widget in widgets_to_toggle:
            try:
                widget.config(state=state)
            except Exception:
                pass
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
        if threading.current_thread() is not threading.main_thread():
            try:
                self.root.after(0, self._do_update_progress, processed, total, stopped)
            except Exception:
                pass
        else:
            self._do_update_progress(processed, total, stopped)

    def _do_update_progress(self, processed, total, stopped=False):
        try:
            self.progress_bar.config(maximum=max(1, total), value=processed)
            suffix = "（已停止）" if stopped else ""
            self.progress_var.set(f"进度：{processed}/{total}{suffix}")
        except Exception:
            pass

    def _reset_progress(self):
        self.progress_bar.config(maximum=1, value=0)
        self.progress_var.set("进度：未开始")
        self.result_var.set("")

    def _announce_stop(self):
        if self._stop_announced:
            return
        self._stop_announced = True
        self.hint_var.set("⏹ 正在停止：已收到停止指令，正在安全停止...")
        self.emit("⏹ 已收到停止请求（按ESC或停止按钮），正在安全停止并保持断点...")

    def _start_esc_watcher(self):
        self._stop_esc_watcher()
        try:
            try:
                from sender_py.window_utils import GlobalEscWatcher
            except ModuleNotFoundError:
                from window_utils import GlobalEscWatcher
            self._esc_watcher = GlobalEscWatcher(on_stop_callback=self._on_emergency_esc)
            self._esc_watcher.start()
        except Exception:
            pass

    def _stop_esc_watcher(self):
        if hasattr(self, "_esc_watcher") and self._esc_watcher:
            try:
                self._esc_watcher.stop()
            except Exception:
                pass
            self._esc_watcher = None

    def _on_emergency_esc(self):
        self._stop_requested = True
        try:
            self.root.after(0, self._announce_stop)
        except Exception:
            self._announce_stop()

    def _esc_pressed(self):
        try:
            import ctypes
            return bool(ctypes.windll.user32.GetAsyncKeyState(0x1B) & 0x8000)
        except Exception:
            return False

    def _poll_stop(self):
        self._drain_reply_events()
        if self._stop_requested:
            self._announce_stop()
            return True
        if self._esc_pressed():
            self._on_emergency_esc()
            return True
        return False

    def request_stop(self, event=None):
        if not self._running:
            self._set_running_ui(False)
            self.start_btn.config(state="normal")
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
        self._stop_esc_watcher()
        if self._reply_analyzer is not None:
            try:
                self._reply_analyzer.shutdown(wait=False)
            except Exception:
                pass
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
        """手动触发视野校准：弹出平滑加载动画，异步定位企微并使用 Qwen3.8-Max 智能分析，避免用户误以为卡顿。"""
        if self._running:
            return
        try:
            from sender_py import window_utils as wu
        except ModuleNotFoundError:
            import window_utils as wu

        loading = CalibrationLoadingDialog(self.root, title="正在加载，请稍候", message="正在加载，请稍候...")
        try:
            self.calib_btn.configure(state="disabled")
        except Exception:
            pass

        def _worker():
            err_data = None
            rect = None
            scale = 1.0
            img = None
            ai_roi = None

            try:
                if not wu.find_and_activate_wecom():
                    err_data = ("未能激活企业微信", "未能激活企业微信窗口，请先打开企业微信后重试。")
                    return

                time.sleep(0.4)
                # 尝试自动将企微向下还原、缩至最小极限尺寸并居中于当前屏幕
                try:
                    wu.restore_and_center_wecom(log=self.emit)
                except Exception:
                    pass
                rect = wu.get_wecom_rect()
                if not rect or rect[2] < 200 or rect[3] < 150:
                    err_data = ("窗口尺寸异常", "未能获取有效的企业微信窗口尺寸，请确认企业微信未处于最小化。")
                    return

                scale = wu.get_dpi_scale()

                # 优先检索并进入一个会话，确保企业微信右侧界面打开了具体的聊天界面
                sample_name = None
                try:
                    if hasattr(self, "items") and self.items:
                        sample_name = self.items[0].get("studentName")
                except Exception:
                    pass
                try:
                    loading.set_status("正在打开聊天窗口...", "正在唤起会话以确保右侧界面完整...")
                    open_sample_chat_for_calibration(sample_name, log=self.emit)
                except Exception as exc:
                    self.emit(f"预打开会话提示：{exc}")

                try:
                    from sender_py.capture import capture_wecom_window
                except ModuleNotFoundError:
                    from capture import capture_wecom_window

                img = capture_wecom_window(rect)
                if img is None:
                    err_data = ("截取失败", "未能捕获企业微信窗口画面，请确认企微未被遮挡。")
                    return

                token = getattr(self, "token", None)
                try:
                    try:
                        from sender_py.vision_api import calibrate_roi
                    except ModuleNotFoundError:
                        from vision_api import calibrate_roi
                    ai_roi = calibrate_roi(img, server=self.server, token=token)
                except Exception as exc:
                    self.emit(f"AI 自动识别网络异常：{exc}")
                    ai_roi = None
            except Exception as exc:
                err_data = ("校准异常", str(exc))
            finally:
                def _finish():
                    try:
                        loading.close()
                    except Exception:
                        pass
                    try:
                        self.calib_btn.configure(state="normal")
                    except Exception:
                        pass

                    from tkinter import messagebox
                    if err_data:
                        title, msg = err_data
                        messagebox.showwarning(title, msg, parent=self.root)
                        self.emit(f"校准未完成：{title} - {msg}")
                        return

                    config_path = default_config_path()
                    key = signature_key(rect[2], rect[3], scale)

                    if ai_roi and isinstance(ai_roi, dict) and all(k in ai_roi for k in ("title", "input", "chat")):
                        if all(validate_rel(ai_roi[k]) for k in ("title", "input", "chat")):
                            self.emit(f"✓ Qwen3.8-Max 自动框选成功（{ai_roi.get('reason', '')}），已自动生效！")
                            save_roi(config_path, key, ai_roi["title"], ai_roi["input"], ai_roi["chat"])
                            messagebox.showinfo("校准成功", "企业微信窗口区域已成功由 AI 智能自动校准并保存！", parent=self.root)
                            return
                        else:
                            self.emit("AI 识别坐标超出有效范围，正在打开手动校准画布...")
                    else:
                        self.emit("AI 自动定位未通过（可能未进入具体聊天），正在弹出手动校准窗口...")

                    try:
                        from sender_py.roi_calibrator import run_calibration
                    except ModuleNotFoundError:
                        from roi_calibrator import run_calibration

                    roi = run_calibration(self.root, img, initial_roi=ai_roi)
                    if roi:
                        save_roi(config_path, key, roi["title"], roi["input"], roi["chat"])
                        self.emit("✓ 企业微信窗口视野校准成功并已保存！")
                        messagebox.showinfo("校准成功", "企业微信窗口区域已成功校准并保存！", parent=self.root)
                    else:
                        self.emit("校准已取消或未完成。")

                try:
                    self.root.after(0, _finish)
                except Exception:
                    _finish()

        threading.Thread(target=_worker, daemon=True).start()

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
        self._center_window(win, 1020, 660)
        win.minsize(880, 520)
        try:
            win.transient(self.root)
        except Exception:
            pass
        body = ttk.Frame(win, style="Card.TFrame", padding=16)
        body.pack(fill="both", expand=True)
        ttk.Label(body, text="📜 运行调试日志", style="Section.TLabel").pack(anchor="w", pady=(0, 10))
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

        def export_logs():
            from tkinter import filedialog, messagebox
            import datetime
            ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            path = filedialog.asksaveasfilename(
                parent=win,
                title="保存运行日志",
                defaultextension=".txt",
                initialfile=f"极方反馈运行日志_{ts}.txt",
                filetypes=[("文本日志", "*.txt"), ("所有文件", "*.*")]
            )
            if not path:
                return
            try:
                content = text.get("1.0", "end-1c")
                with open(path, "w", encoding="utf-8") as fp:
                    fp.write(content)
                messagebox.showinfo("导出成功", f"运行日志已成功导出至：\n{path}", parent=win)
            except Exception as exc:
                messagebox.showerror("导出失败", f"保存日志文件失败：\n{exc}", parent=win)

        win.protocol("WM_DELETE_WINDOW", close)
        footer = ttk.Frame(body, style="Card.TFrame")
        footer.pack(fill="x", pady=(10, 0))
        ttk.Button(footer, text="💾 下载运行日志", style=self._accent_style,
                   command=export_logs).pack(side="left")
        ttk.Button(footer, text="🗑️ 清空日志", style="Toolbar.TButton",
                   command=clear).pack(side="right")

    def _tree_tag_for_item(self, item, row_idx: int = 0) -> str:
        st = self._status_of(item)
        if st == "待发送":
            return "st_待发送_even" if row_idx % 2 == 0 else "st_待发送_odd"
        if st in ("发送中", "已发送", "发送失败", "已拦截", "未匹配", "已跳过", "已跳过（已发送）"):
            return f"st_{st}"
        return "st_待发送_even"

    def _tree_values_for_item(self, item):
        var = item.get("_selected_var")
        selected = bool(var.get()) if var is not None else True
        check_mark = "☑" if selected else "☐"
        sid = item.get("sid") or "-"
        sname = item.get("sname") or item.get("studentName") or "-"
        st = self._status_of(item)
        reason = item.get("_last_reason") or ""
        return (check_mark, sid, sname, st, reason, "👤 复制学号、姓名", "📋 复制话术")

    def _refresh_tree_row(self, item):
        tree = getattr(self, "students_tree", None)
        if tree is None:
            return
        iid = getattr(self, "_item_tree_map", {}).get(id(item))
        if not iid:
            return
        try:
            row_idx = item.get("_tree_row_idx", 0)
            tree.item(iid, values=self._tree_values_for_item(item), tags=(self._tree_tag_for_item(item, row_idx),))
            if self._running and self._status_of(item) == "发送中":
                tree.see(iid)
        except Exception:
            pass

    def _on_tree_motion(self, event):
        tree = getattr(self, "students_tree", None)
        if tree is None:
            return
        region = tree.identify_region(event.x, event.y)
        col = tree.identify_column(event.x)
        if region in ("cell", "heading") and col in ("#1", "#6", "#7"):
            try:
                tree.configure(cursor="hand2")
            except Exception:
                pass
        else:
            try:
                tree.configure(cursor="")
            except Exception:
                pass

    def _on_tree_click(self, event):
        if self._running:
            return
        tree = getattr(self, "students_tree", None)
        if tree is None:
            return
        region = tree.identify_region(event.x, event.y)
        col = tree.identify_column(event.x)
        if region == "heading" and col == "#1":
            all_selected = all(
                item.get("_selected_var") is not None and item["_selected_var"].get()
                for item in self.items
            ) if self.items else False
            self.set_all_selected(not all_selected)
            return
        if region != "cell":
            return
        iid = tree.identify_row(event.y)
        if not iid:
            return
        item = self._tree_item_map.get(iid)
        if item is None:
            return
        if col == "#1":
            var = item.get("_selected_var")
            if var is None:
                return
            new_val = not var.get()
            visible = self._visible_items()
            cur_idx = next((i for i, it in enumerate(visible) if it is item), None)
            # 支持按住 Shift 键区间批量勾选/取消勾选
            shift_pressed = bool(getattr(event, "state", 0) & 0x0001)
            if shift_pressed and self._last_checked_idx is not None and cur_idx is not None:
                lo = min(self._last_checked_idx, cur_idx)
                hi = max(self._last_checked_idx, cur_idx)
                for rng_item in visible[lo:hi + 1]:
                    r_var = rng_item.get("_selected_var")
                    if r_var is not None:
                        r_var.set(new_val)
                        self._apply_selection_status(rng_item, new_val, refresh_summary=False)
                self.update_summary()
            else:
                var.set(new_val)
                self._apply_selection_status(item, new_val, refresh_summary=True)
            if cur_idx is not None:
                self._last_checked_idx = cur_idx
        elif col == "#6":
            self.copy_student(item)
        elif col == "#7":
            self.copy_message(item)

    def _on_tree_double_click(self, event):
        if self._running:
            return
        tree = getattr(self, "students_tree", None)
        if tree is None:
            return
        if tree.identify_region(event.x, event.y) != "cell":
            return
        col = tree.identify_column(event.x)
        if col in ("#1", "#6", "#7"):
            return
        iid = tree.identify_row(event.y)
        item = self._tree_item_map.get(iid)
        if item is not None:
            self.show_row_reason(item)

    def rebuild_student_list(self):
        if self._running:
            return
        self._cancel_search_rebuild()
        tk = self.tk
        self._row_checkbuttons = []
        self._row_action_buttons = []
        self._tree_item_map = {}
        self._item_tree_map = {}
        self._last_checked_idx = None

        tree = getattr(self, "students_tree", None)
        if tree is not None:
            children = tree.get_children()
            if children:
                tree.delete(*children)

        visible = self._visible_items()
        for idx, item in enumerate(visible):
            if "_selected_var" not in item:
                item["_selected_var"] = tk.BooleanVar(master=self.root, value=True)
            if "_status_var" not in item:
                item["_status_var"] = tk.StringVar(master=self.root, value=item.get("_status", "待发送"))
            item["_status"] = item["_status_var"].get()
            item["_tree_row_idx"] = idx
            if tree is not None:
                iid = f"row_{idx}"
                tree.insert(
                    "", "end", iid=iid,
                    values=self._tree_values_for_item(item),
                    tags=(self._tree_tag_for_item(item, idx),),
                )
                self._tree_item_map[iid] = item
                self._item_tree_map[id(item)] = iid

        if tree is not None:
            if not self.items:
                tree.insert(
                    "", "end", iid="empty_state",
                    values=("", "-", "暂无学员数据", "-", "请点击上方“➕ 添加文件”载入 JSON / HTML 反馈文件", "", ""),
                    tags=("st_empty",),
                )
            elif not visible:
                tree.insert(
                    "", "end", iid="empty_filter",
                    values=("", "-", "无匹配结果", "-", "未找到符合条件的学生，请清除搜索词或切换状态筛选", "", ""),
                    tags=("st_empty",),
                )
            try:
                tree.yview_moveto(0)
            except Exception:
                pass
        self.update_summary()

    def set_status(self, item, text):
        if threading.current_thread() is not threading.main_thread():
            try:
                self.root.after(0, self._do_set_status, item, text)
            except Exception:
                pass
        else:
            self._do_set_status(item, text)

    def _do_set_status(self, item, text, refresh_summary: bool = True):
        item["_status"] = text
        var = item.get("_status_var")
        if var is not None:
            try:
                var.set(text)
            except Exception:
                pass
        self._refresh_tree_row(item)
        if refresh_summary:
            self.update_summary()

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
        if hasattr(self, "students_tree"):
            try:
                all_checked = total > 0 and selected == total
                self.students_tree.heading("select", text="☑ 选" if all_checked else "☐ 选")
            except Exception:
                pass
        if hasattr(self, "stat_selected_val"):
            self.stat_selected_val.set(f"{selected} 人")
            self.stat_sent_val.set(f"{sent} 人")
            self.stat_failed_val.set(f"{failed} 人")
            f_count = len(self.input_paths)
            self.stat_files_val.set(f"{f_count} 个文件 · 共 {total} 人" if f_count else f"共 {total} 人")
        if hasattr(self, "start_btn") and not self._running:
            has_sent = sent > 0
            has_unsent_selected = any(
                (item.get("_selected_var") is not None and item["_selected_var"].get())
                and self._status_of(item) != "已发送"
                for item in self.items
            )
            if has_sent and has_unsent_selected:
                self.start_btn.config(text="▶ 继续发送")
            else:
                self.start_btn.config(text="▶ 开始发送")

    def _apply_selection_status(self, item, selected: bool, refresh_summary: bool = True):
        status = self._status_of(item)
        if selected and status in ("已跳过", "已跳过（已发送）"):
            self._do_set_status(item, "待发送", refresh_summary=refresh_summary)
        elif not selected and status in ("待发送", "已跳过"):
            self._do_set_status(item, "已跳过", refresh_summary=refresh_summary)
        else:
            self._refresh_tree_row(item)
            if refresh_summary:
                self.update_summary()

    def on_select_change(self, item):
        var = item.get("_selected_var")
        if var is not None:
            self._apply_selection_status(item, var.get(), refresh_summary=True)

    def set_all_selected(self, value: bool):
        for item in self.items:
            var = item.get("_selected_var")
            if var is not None:
                var.set(value)
                self._apply_selection_status(item, value, refresh_summary=False)
        self.update_summary()

    def _reset_hint(self):
        if self._running:
            return
        self.hint_var.set("💡 勾选学生后点“开始发送”；发送中请勿将企微拖出屏幕外或改动大小；按 Esc 停止。")

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

    def _schedule_reply_drain(self):
        q = getattr(self, "_reply_event_queue", None)
        if q is not None and not q.empty():
            self._drain_reply_events()
        try:
            if self.root.winfo_exists():
                interval = 250 if (self._running or getattr(self, "_pending_reply_tasks", 0) > 0) else 1000
                self.root.after(interval, self._schedule_reply_drain)
        except Exception:
            pass

    def _drain_reply_events(self):
        q = getattr(self, "_reply_event_queue", None)
        if q is None:
            return
        updated = False
        while True:
            try:
                event = q.get_nowait()
            except Exception:
                break
            kind = event[0]
            if kind == "progress":
                self._pending_reply_tasks = int(event[1] or 0)
                updated = True
            elif kind == "note":
                note = event[1]
                dedupe_add(self.reply_notes, note)
                updated = True
                student = note.get("student", "")
                verdict_str = note.get("verdict", "")
                last_msg = note.get("last_message", "")
                if note.get("needs_reply") is True:
                    self.emit(f"🔔 [{student}] 后台留言分析：{verdict_str}（最后消息：{last_msg or '无'}）", _drain=False)
                elif note.get("needs_reply") is None:
                    self.emit(f"⚠️ [{student}] 后台留言分析：{verdict_str}（{last_msg or '无'}）", _drain=False)
                else:
                    self.emit(f"✓ [{student}] 后台留言分析：无需回复", _drain=False)
        if updated:
            self.refresh_reply_count()

    def emit(self, msg: str, _drain: bool = True):
        msg = str(msg)
        if not (len(msg) >= 10 and msg.startswith("[") and msg[3] == ":" and msg[6] == ":"):
            import datetime
            ts = datetime.datetime.now().strftime("%H:%M:%S")
            msg = f"[{ts}] {msg}"
        self.log_buffer.append(msg)
        if len(self.log_buffer) > 5000:
            del self.log_buffer[:1000]

        try:
            try:
                from sender_py.file_logger import write_log
            except ModuleNotFoundError:
                from file_logger import write_log
            write_log(msg)
        except Exception:
            pass
        if threading.current_thread() is not threading.main_thread():
            try:
                self.root.after(0, self._do_emit, msg, _drain)
            except Exception:
                pass
        else:
            self._do_emit(msg, _drain)

    def _do_emit(self, msg: str, _drain: bool = True):
        if _drain:
            self._drain_reply_events()
        if self.log_text is not None:
            try:
                self.log_text.insert("end", msg + "\n")
                self.log_text.see("end")
            except Exception:
                self.log_text = None
                self.log_window = None

    def refresh_reply_count(self):
        if threading.current_thread() is not threading.main_thread():
            try:
                self.root.after(0, self._do_refresh_reply_count)
            except Exception:
                pass
        else:
            self._do_refresh_reply_count()

    def _do_refresh_reply_count(self):
        count = len(actionable(self.reply_notes))
        pending = getattr(self, "_pending_reply_tasks", 0)
        try:
            if pending > 0:
                self.reply_btn.config(text=f"📨 待回名单 · {count} (分析中 {pending})")
            else:
                self.reply_btn.config(text=f"📨 待回名单 · {count}")
        except Exception:
            pass

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

    def update_file_pool_ui(self):
        if not hasattr(self, "file_tags_inner"):
            return
        for child in self.file_tags_inner.winfo_children():
            child.destroy()

        if not self.input_paths:
            self.file_pool_summary_var.set("尚未选择文件（0 个文件 · 0 人）")
            if hasattr(self, "file_tags_container"):
                self.file_tags_container.pack_forget()
            if hasattr(self, "add_file_btn"):
                self.add_file_btn.configure(text="➕ 添加文件")
            if hasattr(self, "clear_pool_btn"):
                self.clear_pool_btn.configure(state="disabled")
            return

        if hasattr(self, "file_tags_container"):
            self.file_tags_container.pack(fill="x", pady=(6, 0))

        if hasattr(self, "add_file_btn"):
            self.add_file_btn.configure(text="➕ 继续添加")
        if hasattr(self, "clear_pool_btn"):
            self.clear_pool_btn.configure(state="normal")

        total_students = len(self.items)
        file_count = len(self.input_paths)
        summary_text = f"已载入 {file_count} 个文件 · 共 {total_students} 人"
        if self.duplicate_count:
            summary_text += f"（去重 {self.duplicate_count} 人）"
        self.file_pool_summary_var.set(summary_text)

        counts_map = getattr(self, "_file_counts", {})
        for path in self.input_paths:
            base = os.path.basename(path)
            ext = os.path.splitext(base)[1].lower()
            icon = "📄" if ext == ".json" else "🌐"
            count = counts_map.get(path, 0)
            tag_text = f"{icon} {base} ({count}人)"

            tag_frame = self._ttk.Frame(self.file_tags_inner, style="FileTag.TFrame", padding=(7, 2))
            tag_frame.pack(side="left", padx=(0, 6), pady=2)

            self._ttk.Label(tag_frame, text=tag_text, style="FileTag.TLabel").pack(side="left")
            del_btn = self._ttk.Label(tag_frame, text=" ✖", style="FileTagDel.TLabel", cursor="hand2")
            del_btn.pack(side="left")
            del_btn.bind("<Button-1>", lambda _e, p=path: self.remove_input_file(p))

    def choose_and_add_files(self):
        self.choose_input_files(append=True)

    def choose_input_files(self, append: bool = True):
        if self._running:
            return
        from tkinter import filedialog
        title = "选择反馈文件（可单选，可反复多次添加）" if append else "重新选择反馈文件"
        paths = filedialog.askopenfilenames(
            parent=self.root,
            title=title,
            filetypes=[
                ("反馈文件（JSON / HTML）", "*.json *.html *.htm"),
                ("JSON 文件", "*.json"),
                ("HTML 快照", "*.html *.htm"),
                ("所有文件", "*.*"),
            ],
        )
        if not paths:
            return
        self.add_input_files(paths, replace=not append)

    def add_input_files(self, new_paths: list, replace: bool = False):
        if self._running:
            return
        try:
            from tkinter import messagebox
        except Exception:
            messagebox = None
        if replace:
            target_paths = [p for p in new_paths if os.path.isfile(p)]
        else:
            target_paths = list(self.input_paths)
            added_any = False
            for p in new_paths:
                p_norm = os.path.normpath(p)
                if not any(os.path.normpath(ep) == p_norm for ep in target_paths) and os.path.isfile(p):
                    target_paths.append(p)
                    added_any = True
            if not target_paths:
                return
            if not added_any:
                self.emit("💡 提示：所选文件均已在列表中，无需重复添加。")
                return

        try:
            items, file_counts, duplicates = load_feedback_inputs(target_paths)
        except Exception as exc:
            if messagebox:
                messagebox.showerror("读取失败", f"文件解析异常：\n{exc}", parent=self.root)
            self.emit(f"❌ 文件解析异常：{exc}")
            return

        if not items:
            if messagebox:
                messagebox.showwarning("没有可用数据", "所选文件里没有有效的学生数据。", parent=self.root)
            self.emit("⚠️ 所选文件里没有有效的学生数据。")
            return

        self.items = items
        self.input_paths = target_paths
        self.duplicate_count = duplicates
        self._file_counts = dict(file_counts)
        self.reply_notes = []
        self.refresh_reply_count()
        self.archive_key = (archive_key_for_input(target_paths[0]) if len(target_paths) == 1
                            else "多文件 [第 1 周]")
        self.update_file_pool_ui()
        self.update_input_label()
        self.update_summary()
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
        details = "，".join(f"{os.path.basename(p)} {n}人" for p, n in file_counts)
        self.emit(f"📁 已加载反馈文件（当前共 {len(target_paths)} 个文件）：{details}")
        self.emit(f"合并后共 {len(items)} 个学生" + (f"（自动去重 {duplicates} 条）" if duplicates else ""))
        for p in new_paths:
            if self._sent_files and self._sent_files.is_file_sent(p):
                self.emit(f"💡 提示：文件 [{os.path.basename(p)}] 在本地已有发送记录（可在右上角“已发文件”中查看）")

    def remove_input_file(self, path: str):
        if self._running:
            return
        new_paths = [p for p in self.input_paths if os.path.normpath(p) != os.path.normpath(path)]
        if not new_paths:
            self.clear_input_files()
        else:
            self.add_input_files(new_paths, replace=True)
            self.emit(f"🗑️ 已移除文件：{os.path.basename(path)}")

    def clear_input_files(self):
        if self._running:
            return
        if not self.input_paths and not self.items:
            return
        self.input_paths = []
        self.items = []
        self.duplicate_count = 0
        self._file_counts = {}
        self.reply_notes = []
        self.refresh_reply_count()
        self.update_file_pool_ui()
        self.update_input_label()
        self.update_summary()
        self._reset_progress()
        self.rebuild_student_list()
        self.emit("🗑️ 已清空所选文件。")

    def show_reply_notes_dialog(self):
        tk, ttk = self.tk, self._ttk
        from tkinter import filedialog, messagebox
        try:
            from sender_py.reply_notes import export_csv
        except ModuleNotFoundError:
            from reply_notes import export_csv
        notes = actionable(self.reply_notes)
        win = tk.Toplevel(self.root)
        win.title(f"{APP_NAME} · 待回学员名单")
        self._center_window(win, 780, 560)
        win.minsize(680, 480)
        try:
            win.transient(self.root)
        except Exception:
            pass

        body = ttk.Frame(win, style="Card.TFrame", padding=16)
        body.pack(fill="both", expand=True)

        header_box = ttk.Frame(body, style="Card.TFrame")
        header_box.pack(fill="x", pady=(0, 10))
        ttk.Label(header_box, text=f"📨 待回学员名单（共 {len(notes)} 人）", style="Section.TLabel").pack(anchor="w")

        tree_frame = ttk.Frame(body, style="Card.TFrame")
        tree_frame.pack(fill="both", expand=True)

        cols = [
            ("sid", "学号", 180),
            ("sname", "姓名", 340),
            ("status", "复制状态", 140),
        ]

        tree = ttk.Treeview(tree_frame, columns=[c for c, _, _ in cols],
                            show="headings", height=12, selectmode="browse")
        for c, label, width in cols:
            tree.heading(c, text=label)
            tree.column(c, width=width, anchor="w")

        tree.tag_configure("copied", background="#dcfce7", foreground="#15803d")

        seen_students = set()
        student_rows = []
        for n in notes:
            raw = n.get("student", "")
            sid, sname = parse_student_identifier(raw)
            if not sid and not sname:
                sid, sname = "-", raw
            elif not sid:
                sid = "-"
            key = (sid, sname)
            if key in seen_students:
                continue
            seen_students.add(key)
            student_rows.append((sid, sname))
            tree.insert("", "end", values=(sid, sname, "未复制"))

        scroll = ttk.Scrollbar(tree_frame, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=scroll.set)
        tree.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")

        def copy_all():
            if not student_rows:
                messagebox.showinfo("提示", "当前没有需要回复的学生。", parent=win)
                return
            lines = []
            for item_id in tree.get_children():
                vals = tree.item(item_id, "values")
                if vals:
                    sid, sname = vals[0], vals[1]
                    text = f"{sid}{sname}".strip() if sid != "-" else sname
                    lines.append(text)
                    tree.item(item_id, values=(sid, sname, "✓ 已复制"), tags=("copied",))
            content = "\n".join(lines)
            self.copy_to_clipboard(content, "待回学员名单")
            messagebox.showinfo("复制成功", f"已复制全部 {len(lines)} 位待回学员名单（学号姓名）！", parent=win)

        def copy_selected(_event=None):
            sel = tree.selection()
            if not sel:
                return
            values = tree.item(sel[0], "values")
            if not values:
                return
            sid, sname = values[0], values[1]
            text = f"{sid}{sname}".strip() if sid != "-" else sname
            self.copy_to_clipboard(text, "学号姓名")
            tree.item(sel[0], values=(sid, sname, "✓ 已复制"), tags=("copied",))

        def do_export():
            path = filedialog.asksaveasfilename(
                parent=win, title="导出待回消息名单", defaultextension=".csv",
                initialfile="待回名单.csv", filetypes=[("CSV", "*.csv")])
            if not path:
                return
            export_csv(notes, path)
            messagebox.showinfo("导出成功", f"已导出至：\n{path}", parent=win)

        actions = ttk.Frame(body, style="Card.TFrame")
        actions.pack(fill="x", pady=(12, 0))
        ttk.Button(actions, text="📋 复制全部名单", style=self._accent_style,
                   command=copy_all).pack(side="left", padx=(0, 8))
        ttk.Button(actions, text="📋 复制选中学生", style="Toolbar.TButton",
                   command=copy_selected).pack(side="left", padx=(0, 8))
        ttk.Button(actions, text="导出 CSV", style="Toolbar.TButton",
                   command=do_export).pack(side="left")
        tree.bind("<Double-1>", copy_selected)
        if not notes:
            ttk.Label(body, text="当前没有需要回复的学生",
                      style="Hint.TLabel").pack(pady=(12, 0))

    def show_sent_files_dialog(self):
        tk, ttk = self.tk, self._ttk
        try:
            from sender_py.store import open_directory
        except ModuleNotFoundError:
            from store import open_directory

        win = tk.Toplevel(self.root)
        win.title(f"{APP_NAME} · 已发送文件记录")
        self._center_window(win, 1060, 640)
        win.minsize(920, 520)
        try:
            win.transient(self.root)
        except Exception:
            pass

        body = ttk.Frame(win, style="Card.TFrame", padding=16)
        body.pack(fill="both", expand=True)

        header_box = ttk.Frame(body, style="Card.TFrame")
        header_box.pack(fill="x", pady=(0, 10))
        ttk.Label(header_box, text="📁 已发送文件记录", style="Section.TLabel").pack(anchor="w")
        records_dir = getattr(self._sent_files, "records_dir", "") if self._sent_files else ""

        tree_frame = ttk.Frame(body, style="Card.TFrame")
        tree_frame.pack(fill="both", expand=True)

        cols = [
            ("file_name", "文件名", 240),
            ("sent_time", "最近发送时间", 160),
            ("counts", "发送情况", 140),
            ("file_type", "格式", 70),
            ("file_path", "源文件路径", 380),
        ]

        tree = ttk.Treeview(tree_frame, columns=[c for c, _, _ in cols],
                            show="headings", height=12, selectmode="browse")
        for c, label, width in cols:
            tree.heading(c, text=label)
            tree.column(c, width=width, anchor="w")

        def populate_tree():
            for item in tree.get_children():
                tree.delete(item)
            records = self._sent_files.get_records() if self._sent_files else []
            for r in records:
                fname = r.get("file_name", "")
                stime = r.get("sent_time", "")
                sent = r.get("sent_count", 0)
                tot = r.get("total_count", 0)
                fail = r.get("failed_count", 0)
                ftype = r.get("file_type", "").upper()
                fpath = r.get("file_path", "")
                counts_str = f"已发 {sent}/{tot} 人" + (f" (失败{fail})" if fail else "")
                tree.insert("", "end", values=(fname, stime, counts_str, ftype, fpath))

        populate_tree()

        scroll = ttk.Scrollbar(tree_frame, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=scroll.set)
        tree.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")

        def open_folder():
            if records_dir:
                open_directory(records_dir)

        def open_report(_event=None):
            sel = tree.selection()
            if not sel:
                return
            idx = tree.index(sel[0])
            records = self._sent_files.get_records() if self._sent_files else []
            if 0 <= idx < len(records):
                html_path = records[idx].get("html_record", "")
                if html_path and os.path.isfile(html_path):
                    import webbrowser
                    webbrowser.open(f"file://{os.path.abspath(html_path)}")
                    return
            open_folder()

        def copy_path():
            sel = tree.selection()
            if not sel:
                return
            values = tree.item(sel[0], "values")
            if values:
                p = values[4] or values[0]
                self.copy_to_clipboard(p, "文件路径")

        actions = ttk.Frame(body, style="Card.TFrame")
        actions.pack(fill="x", pady=(12, 0))
        ttk.Button(actions, text="📂 打开本地保存目录", style=self._accent_style,
                   command=open_folder).pack(side="left", padx=(0, 8))
        ttk.Button(actions, text="🌐 打开HTML报告", style="Toolbar.TButton",
                   command=open_report).pack(side="left", padx=(0, 8))
        ttk.Button(actions, text="📋 复制源文件路径", style="Toolbar.TButton",
                   command=copy_path).pack(side="left", padx=(0, 8))
        ttk.Button(actions, text="🔄 刷新", style="Toolbar.TButton",
                   command=populate_tree).pack(side="left")
        tree.bind("<Double-1>", open_report)

    def open_benchmark_window(self, _event=None):
        """打开隐藏的多引擎识别基准评测窗口 (Benchmark Dry-Run)。"""
        from tkinter import messagebox, filedialog
        try:
            try:
                from sender_py.benchmark import benchmark_single_student, compute_benchmark_summary, generate_benchmark_csv_content
                from sender_py.roi_manager import default_config_path
            except ModuleNotFoundError:
                from benchmark import benchmark_single_student, compute_benchmark_summary, generate_benchmark_csv_content
                from roi_manager import default_config_path
        except Exception as e:
            messagebox.showerror("错误", f"无法加载基准评测模块: {e}", parent=self.root)
            return

        selected_items = [it for it in self.items if it.get("_selected", True)]
        if not selected_items and self.items:
            selected_items = list(self.items)
        if not selected_items:
            messagebox.showinfo("提示", "当前暂无学生数据，请先加载反馈文件！", parent=self.root)
            return

        ok = messagebox.askyesno(
            "🧪 多引擎识别基准评测 (只测不发)",
            f"已激活隐藏功能：多引擎横向比对评测！\n\n"
            f"【物理安全防护】：\n"
            f"将逐一在企业微信中搜索勾选的 {len(selected_items)} 位学生并截图标题栏，"
            f"同时对同一张图调用 Qwen-Flash 与本地多种 OCR 进行精度与毫秒级耗时比对。\n\n"
            f"⚠️ 绝不向企微输入框粘贴或发送任何文字！\n\n"
            f"是否立即开始评测？",
            parent=self.root
        )
        if not ok:
            return

        records = []
        win = tk.Toplevel(self.root)
        win.title("🧪 多引擎识别基准评测进度 (只测不发)")
        win.geometry("750x450")
        win.transient(self.root)
        self._center_window(win, 750, 450)

        body = ttk.Frame(win, padding=16)
        body.pack(fill="both", expand=True)

        status_lbl = ttk.Label(body, text="正在准备评测...", font=("Microsoft YaHei UI", 10, "bold"))
        status_lbl.pack(anchor="w", pady=(0, 10))

        prog = ttk.Progressbar(body, maximum=len(selected_items), value=0)
        prog.pack(fill="x", pady=(0, 10))

        txt_frame = ttk.Frame(body)
        txt_frame.pack(fill="both", expand=True)
        txt = tk.Text(txt_frame, wrap="word", height=12, font=("Consolas", 9))
        scroll = ttk.Scrollbar(txt_frame, orient="vertical", command=txt.yview)
        txt.configure(yscrollcommand=scroll.set)
        txt.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")

        stopped = [False]
        def on_stop():
            stopped[0] = True
            status_lbl.config(text="正在停止...")

        btn_box = ttk.Frame(body)
        btn_box.pack(fill="x", pady=(10, 0))
        stop_btn = ttk.Button(btn_box, text="⏹ 停止评测", command=on_stop)
        stop_btn.pack(side="right", padx=(8, 0))
        export_btn = ttk.Button(btn_box, text="📥 导出对比表(CSV)", state="disabled")
        export_btn.pack(side="right")

        def do_export():
            if not records:
                return
            csv_str = generate_benchmark_csv_content(records, compute_benchmark_summary(records))
            fn = filedialog.asksaveasfilename(
                parent=win,
                title="保存评测对比表",
                defaultextension=".csv",
                initialfile=f"OCR_Benchmark_{time.strftime('%Y%m%d_%H%M%S')}.csv",
                filetypes=[("CSV 文件", "*.csv"), ("所有文件", "*.*")]
            )
            if fn:
                with open(fn, "w", encoding="utf-8-sig", newline="") as f:
                    f.write(csv_str)
                messagebox.showinfo("成功", f"评测报表已成功保存至:\n{fn}", parent=win)

        export_btn.config(command=do_export)

        def worker():
            try:
                config_path = default_config_path()
                for idx, item in enumerate(selected_items, 1):
                    if stopped[0]:
                        break
                    sname = item.get("studentName", "")
                    def _update_ui(i=idx, sn=sname):
                        status_lbl.config(text=f"正在评测 ({i}/{len(selected_items)}): {sn}")
                        prog.config(value=i)
                    win.after(0, _update_ui)

                    def log_fn(m):
                        def _log(msg=m):
                            txt.insert("end", f"{msg}\n")
                            txt.see("end")
                        win.after(0, _log)

                    res = benchmark_single_student(
                        item, self.server, getattr(self, "token", None),
                        config_path=config_path,
                        log=log_fn,
                        should_stop=lambda: stopped[0]
                    )
                    if res.get("record"):
                        records.append(res["record"])
                    time.sleep(0.3)

                def _finish():
                    summary = compute_benchmark_summary(records)
                    status_lbl.config(text=f"评测完成！共测试 {len(records)} 人，发现分歧 {summary.get('discrepancy_count', 0)} 例。")
                    stop_btn.config(state="disabled")
                    export_btn.config(state="normal")
                win.after(0, _finish)
            except Exception as exc:
                def _err(e=exc):
                    status_lbl.config(text=f"评测异常终止: {e}")
                    txt.insert("end", f"❌ 评测发生异常: {e}\n")
                    txt.see("end")
                    stop_btn.config(state="disabled")
                    if records:
                        export_btn.config(state="normal")
                win.after(0, _err)

        threading.Thread(target=worker, daemon=True).start()

    def _record_sent_files(self):
        """记录已经发送过的 JSON / HTML 文件，生成快照并保存在本地。"""
        if not self._sent_files:
            return
        if self.input_paths:
            for path in self.input_paths:
                key = archive_key_for_input(path)
                file_items = [it for it in self.items if it.get("_archive_key") == key]
                if not file_items:
                    file_items = self.items
                any_sent = any(
                    "已发送" in str(it.get("_status") or it.get("status") or "") or
                    str(it.get("_last_result") or "") == "sent"
                    for it in file_items
                )
                if any_sent:
                    rec = self._sent_files.record_sent_file(path, file_items)
                    self.emit(f"💾 已将文件 [{os.path.basename(path)}] 发送记录保存至本地：{os.path.basename(rec.get('html_record', ''))}")
        elif self.items:
            any_sent = any(
                "已发送" in str(it.get("_status") or it.get("status") or "") or
                str(it.get("_last_result") or "") == "sent"
                for it in self.items
            )
            if any_sent:
                rec = self._sent_files.record_sent_file("已发学生反馈.json", self.items)
                self.emit(f"💾 已将本次发送记录保存至本地：{os.path.basename(rec.get('html_record', ''))}")

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

        unsent_items = [it for it in selected_items if self._status_of(it) != "已发送"]
        already_sent_items = [it for it in selected_items if self._status_of(it) == "已发送"]
        total_count = len(self.items)

        if already_sent_items and not unsent_items:
            # 选中的全部都已是已发送状态，需用户主动确认才重新发送
            if not messagebox.askyesno(
                "重新发送确认",
                f"当前勾选的 {len(already_sent_items)} 位学生此前均已发送成功。\n\n是否确认重新发送这些学生？",
                parent=self.root,
                default=messagebox.NO
            ):
                self.hint_var.set("已取消重新发送")
                return
            target_items = selected_items
        elif already_sent_items and unsent_items:
            # 选中的既有已发送，又有未发送 -> 自动断点续发，仅发送未发学生，保护已发学生！
            target_items = unsent_items
            prompt_text = (
                f"3秒后即将继续发送，本次将发送剩余未发学生 {len(unsent_items)} 人"
                f"（已自动跳过已发 {len(already_sent_items)} 人，共 {total_count} 人），"
                "发送中按ESC可停止。"
            )
            self.start_btn.config(state="disabled")
            try:
                confirmed = messagebox.askyesno(
                    "确认继续发送", prompt_text, parent=self.root,
                    default=messagebox.YES)
            except Exception:
                self.start_btn.config(state="normal")
                raise
            if not confirmed:
                self.start_btn.config(state="normal")
                self.hint_var.set("已取消发送")
                return
        else:
            target_items = selected_items
            prompt_text = f"3秒后即将开始发送，本次将发送{len(selected_items)}人，共{total_count}人，发送中按ESC可停止。"
            self.start_btn.config(state="disabled")
            try:
                confirmed = messagebox.askyesno(
                    "确认发送", prompt_text, parent=self.root,
                    default=messagebox.YES)
            except Exception:
                self.start_btn.config(state="normal")
                raise
            if not confirmed:
                self.start_btn.config(state="normal")
                self.hint_var.set("已取消发送")
                return

        target_ids = {id(item) for item in target_items}
        effective_count = len(target_items)

        try:
            token = None
            try:
                try:
                    from sender_py.vision_api import load_token
                except ModuleNotFoundError:
                    from vision_api import load_token
                token = load_token() or None
            except Exception:
                pass

            if self._reply_analyzer is None:
                self._reply_analyzer = AsyncReplyAnalyzer(
                    server=self.server, token=token, max_workers=3,
                    event_queue=self._reply_event_queue
                )
            else:
                self._reply_analyzer.server = self.server
                self._reply_analyzer.token = token

            for item in self.items:
                if id(item) in target_ids:
                    self.set_status(item, "待发送")
                    item["_last_result"] = ""
                    item["_last_reason"] = ""
                elif self._status_of(item) != "已发送":
                    self.set_status(item, "已跳过")
                    item["_last_result"] = "skipped"
                    item["_last_reason"] = "未勾选"

            self._running = True
            self._stop_requested = False
            self._stop_announced = False
            self._close_after_stop = False
            self._start_esc_watcher()
            self._set_running_ui(True)
            self._update_progress(0, effective_count)
            self.result_var.set("正在发送...")
            self.hint_var.set("正在发送...按 Esc 可停止")
            verify_mode = self._current_verify_mode()

            # 启动后台工作线程执行实际发送，彻底避免 UI 假死与主线程阻塞
            self._worker_thread = threading.Thread(
                target=self._run_all_worker,
                args=(target_ids, effective_count, token, verify_mode),
                daemon=True,
                name="SenderWorkerThread"
            )
            self._worker_thread.start()
        except Exception as exc:
            self._running = False
            self._set_running_ui(False)
            self.start_btn.config(state="normal")
            self.emit(f"❌ 启动发送异常：{exc}")
            messagebox.showerror("启动失败", f"启动发送时发生异常：{exc}", parent=self.root)

    def _run_all_worker(self, target_ids, effective_count, token, verify_mode):
        processed = 0
        stopped = False
        self.emit("=================== 开始执行发送任务 ===================")
        self.emit(f"📋 任务概览：本次计划发送 {effective_count} 人（名单总计 {len(self.items)} 人）")
        self.emit("🔍 标题核验：Qwen3.8-Max 云端多模态大模型优先，网络异常自动降级本地 OCR")
        self.emit("🛡️ 安全机制：严格拦截群聊、学号姓名双重比对校验、按 ESC 随时安全停止（底层钩子拦截企微防最小化）")
        self.emit("-------------------------------------------------------")

        # 3 秒倒计时，给用户准备与按 ESC 取消的机会
        for c in (3, 2, 1):
            if self._stop_requested:
                self.emit("⏹ 用户已按 Esc 取消发送。")
                stopped = True
                break
            self.emit(f"⏳ {c} 秒后即将开始发送...（发送中按 ESC 可停止）")
            self.root.after(0, lambda cnt=c: self.hint_var.set(f"⏳ {cnt} 秒后即将开始发送...（按 ESC 取消）"))
            time.sleep(1.0)

        if not stopped:
            self.emit("🚀 倒计时结束，正式开始逐位处理学员！")

        try:
            for item in self.items:
                if id(item) not in target_ids:
                    continue
                if self._poll_stop():
                    stopped = True
                    break
                name = item.get("studentName", "(未知学生)")
                sid = item.get("sid", "-")
                msg_len = len(item.get("message", ""))
                item_key = item.get("_archive_key") or self.archive_key

                # 保护机制：如果当前学生已被判定为已发送，安全跳过
                if self._status_of(item) == "已发送":
                    self.emit(f"⏭ [{name}] 该学生已发送成功，安全跳过，防止重复打扰家长")
                    continue

                if SKIP_SENT and self._history and self._history.is_sent(item_key, name):
                    self.set_status(item, "已跳过（已发送）")
                    item["_last_result"] = "skipped_sent"
                    item["_last_reason"] = "已发送过，自动跳过"
                    processed += 1
                    self._update_progress(processed, effective_count)
                    self.emit(f"⏭ [{processed}/{effective_count}] [{name}] 本周历史记录已标记发送，自动跳过")
                    continue
                self.set_status(item, "发送中")
                self.hint_var.set(f"正在发送：{name} ({processed+1}/{effective_count})")
                self.emit(f"▶ 正在处理 [{processed+1}/{effective_count}]: {name} (学号: {sid}) | 话术字数: {msg_len} 字")
                try:
                    res = send_student(
                        item, self.server, token, parent=self.root,
                        log=self.emit, should_stop=self._poll_stop,
                        reply_analyzer=self._reply_analyzer,
                        verify_mode=verify_mode)
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
                    "stopped": "待发送",
                }.get(result)
                if status is None:
                    status = "发送失败"
                    reason = reason or f"未知返回：{result or '空'}"
                item["_last_reason"] = reason
                if status in ("发送失败", "未匹配"):
                    item["_last_failure_reason"] = reason or status
                self.set_status(item, status)
                processed += 1
                self._update_progress(processed, effective_count)
                for note in res.get("notes", []):
                    dedupe_add(self.reply_notes, note)
                self.refresh_reply_count()
                if result == "sent" and self._history:
                    try:
                        self._history.mark_status(
                            item_key, name, "✅已发送", item.get("message", ""))
                    except Exception as exc:
                        self.emit(f"  ⚠️ [{name}] 历史记录写入失败：{exc}")
                if result == "sent":
                    self.emit(f"  ✅ [{name}] 状态更新：已发送")
                    # 发送成功后自动取消勾选，防止后续重复发送
                    var = item.get("_selected_var")
                    if var is not None:
                        def _uncheck_sent(it=item, v=var):
                            v.set(False)
                            self._refresh_tree_row(it)
                            self.update_summary()
                        try:
                            self.root.after(0, _uncheck_sent)
                        except Exception:
                            v.set(False)
                elif result == "blocked":
                    self.emit(f"  🛑 [{name}] 状态更新：已拦截（{reason}）")
                elif result == "unmatched":
                    self.emit(f"  ⚠️ [{name}] 状态更新：未匹配（{reason}）")
                elif result == "stopped":
                    self.emit(f"  ⏹ [{name}] 状态保持：已暂停（{reason}）")
                else:
                    self.emit(f"  ❌ [{name}] 状态更新：发送失败（{reason}）")

                if result == "stopped":
                    stopped = True
                    break
                if processed < effective_count and not self._stop_requested:
                    if processed % BATCH_BREAK_EVERY == 0:
                        break_gap = random.uniform(*BATCH_BREAK_GAP)
                        self.emit(f"  ☕ 已连续处理 {processed} 人，执行防风控停顿 {break_gap:.1f} 秒（按ESC可停止）...")
                        if not self._interruptible_pause(break_gap):
                            stopped = True
                            break
                    else:
                        gap = random.uniform(*STUDENT_GAP)
                        self.emit(f"  ⏳ 随机停顿 {gap:.1f} 秒，模拟人工打字节奏...")
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
                    if (id(item) in target_ids
                            and self._status_of(item) in ("待发送", "发送中")):
                        self.set_status(item, "待发送")
                        item["_last_result"] = "paused"
                        item["_last_reason"] = "已暂停，可继续发送"
            for item in self.items:
                if self._status_of(item) == "发送中":
                    self.set_status(item, "待发送" if stopped else "发送失败")
                    item["_last_result"] = "paused" if stopped else "error"
                    reason = "已暂停，可继续发送" if stopped else (item.get("_last_reason") or "程序异常中断")
                    item["_last_reason"] = reason
                    if not stopped:
                        item["_last_failure_reason"] = reason
            summary = self._summary_text(stopped, effective_count)
            self.result_var.set(summary)
            self._update_progress(processed, effective_count, stopped=stopped)
            self.hint_var.set(
                "已暂停发送，点击“继续发送”可随时断点续发剩余学员。" if stopped else "本批处理结束")

            if not self._close_after_stop:
                try:
                    self._record_sent_files()
                except Exception as exc:
                    self.emit(f"⚠️ 保存已发送文件记录异常: {exc}")

            # 优雅等待后台留言分析收尾（最多 3.5 秒）
            if self._pending_reply_tasks > 0 and not stopped:
                self.hint_var.set(f"所有学生已发送完毕，正在等待最后 {self._pending_reply_tasks} 位家长留言分析收尾...")
                deadline = time.monotonic() + 3.5
                while self._pending_reply_tasks > 0 and time.monotonic() < deadline:
                    time.sleep(0.1)

            self.emit(summary)
            counts = summarize_status_counts(self._status_of(item) for item in self.items)

            # 调度回主线程更新 UI、恢复按键状态并弹出提示
            try:
                self.root.after(0, self._on_worker_finished, stopped, effective_count, counts, summary)
            except Exception:
                pass

    def _on_worker_finished(self, stopped: bool, selected_count: int, counts: dict, summary: str):
        self._set_running_ui(False)
        if self._close_after_stop:
            self._stop_esc_watcher()
            if self._reply_analyzer is not None:
                try:
                    self._reply_analyzer.shutdown(wait=False)
                except Exception:
                    pass
            self.root.destroy()
            return

        if self.filter_var.get() != FILTER_ALL or self.search_var.get().strip():
            self.rebuild_student_list()
        else:
            self.update_summary()

        extra = ""
        if counts["发送失败"] or counts["未匹配"]:
            extra = ("\n\n可点主界面的“重试失败项”只勾选失败/未匹配学生，"
                     "或“复制失败名单”。")
        if self._pending_reply_tasks > 0:
            extra += (f"\n\n后台仍有 {self._pending_reply_tasks} 条家长留言正在异步分析中，"
                      "完成后将自动更新右上角“待回名单”。")
        saved_hint = "\n\n📁 本次发送记录（JSON与HTML快照）已自动保存在本地，可在右上角“已发文件”中查看与打开。"
        from tkinter import messagebox
        messagebox.showinfo("发送结束", summary + extra + saved_hint, parent=self.root)


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
