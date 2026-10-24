"""主流程：下一学生→搜人进会话→整窗截图→裁两图→identify→MATCH 则粘贴发送。

红线：is_group=true 一律拦截；matched 假/缺失不放行（fail-closed）；
needs_reply null/缺失照发 + 记“待人工确认”（fail-open）。
tkinter/requests/PIL/mss 只在 Windows 流程函数内导入；决策纯函数 Linux 可单测。
"""

import os
import time

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


# ================= 纯决策（无依赖，可单测） =================

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


def ensure_roi(parent, rect, scale, config_path: str = None):
    """每个候选处理前检查窗口签名；变了先校准再截图。返回 rel roi 或 None（放弃）。"""
    config_path = config_path or default_config_path()
    key = signature_key(rect[2], rect[3], scale)
    if not needs_calibration(config_path, key):
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
    roi = run_calibration(parent, img)
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
                 parent=None, log=print) -> dict:
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
        roi = ensure_roi(parent, rect, scale, config_path)
        if roi is None:
            return {"result": "error", "reason": "ROI 校准未完成", "notes": notes}
        entered = search_and_enter(name, cand)
        if entered:  # 截图前焦点守护：mss 截的是屏幕像素，失焦会被遮挡物污染
            if not wu.find_and_activate_wecom():
                log(f"[{name}] 候选{cand}：企微唤起失败，换下一候选")
                _paced(CANDIDATE_GAP)
                continue
            time.sleep(0.3)
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
            ok, why = paste_and_send(message)
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
        self.log_buffer = []
        self.log_window = None
        self.log_text = None

        root.title("反馈发送器")
        root.minsize(860, 560)

        top = tk.Frame(root)
        top.pack(fill="x", padx=10, pady=(8, 4))
        tk.Button(top, text="选择 JSON / HTML 文件（可多选）",
                  command=self.choose_input_files).pack(side="left")
        self.start_btn = tk.Button(top, text="开始发送", command=self.run_all)
        self.start_btn.pack(side="right", padx=(6, 0))
        self.reply_btn = tk.Button(top, text="📨 待回名单 (0)", command=self.show_reply_notes_dialog)
        self.reply_btn.pack(side="right", padx=6)
        tk.Button(top, text="运行日志", command=self.open_log_window).pack(side="right", padx=6)

        self.input_label = tk.Label(root, text="", anchor="w", justify="left", wraplength=900)
        self.input_label.pack(fill="x", padx=12, pady=(0, 6))
        self.update_input_label()

        summary = tk.Frame(root)
        summary.pack(fill="x", padx=12, pady=(0, 4))
        self.summary_var = tk.StringVar(master=root)
        tk.Label(summary, textvariable=self.summary_var, anchor="w").pack(side="left")
        tk.Button(summary, text="全不选", command=lambda: self.set_all_selected(False)).pack(side="right", padx=2)
        tk.Button(summary, text="全选", command=lambda: self.set_all_selected(True)).pack(side="right", padx=2)

        header = tk.Frame(root)
        header.pack(fill="x", padx=12)
        tk.Label(header, text="选", width=3, anchor="w").pack(side="left")
        tk.Label(header, text="学号", width=8, anchor="w").pack(side="left")
        tk.Label(header, text="姓名", width=12, anchor="w").pack(side="left")
        tk.Label(header, text="状态", width=18, anchor="w").pack(side="left")
        tk.Label(header, text="操作", anchor="e").pack(side="right")
        ttk.Separator(root, orient="horizontal").pack(fill="x", padx=12, pady=(2, 4))

        list_outer = tk.Frame(root)
        list_outer.pack(fill="both", expand=True, padx=12, pady=(0, 4))
        self.students_canvas = tk.Canvas(list_outer, highlightthickness=0)
        scrollbar = tk.Scrollbar(list_outer, orient="vertical", command=self.students_canvas.yview)
        self.students_inner = tk.Frame(self.students_canvas)
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

        self.hint_var = tk.StringVar(master=root, value="勾选要发送的学生，然后点“开始发送”。")
        tk.Label(root, textvariable=self.hint_var, anchor="w", fg="#555555").pack(
            fill="x", padx=12, pady=(0, 6))
        self._ttk = ttk
        self.rebuild_student_list()

    STATUS_COLORS = {
        "待发送": "#5f6368",
        "发送中": "#1a73e8",
        "已发送": "#188038",
        "发送失败": "#d93025",
        "已拦截": "#b06000",
        "未匹配": "#b06000",
        "已跳过": "#80868b",
        "已跳过（已发送）": "#80868b",
    }
    STATUS_DEFAULT_COLOR = "#202124"

    def open_log_window(self):
        tk = self.tk
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
        win.title("运行日志")
        win.geometry("900x480")
        body = tk.Frame(win)
        body.pack(fill="both", expand=True, padx=8, pady=8)
        text = tk.Text(body, wrap="word")
        scroll = tk.Scrollbar(body, orient="vertical", command=text.yview)
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
        tk.Button(win, text="清空日志", command=clear).pack(pady=(0, 8))

    def rebuild_student_list(self):
        tk = self.tk
        for child in self.students_inner.winfo_children():
            child.destroy()
        for item in self.items:
            if "_selected_var" not in item:
                item["_selected_var"] = tk.BooleanVar(master=self.root, value=True)
            if "_status_var" not in item:
                item["_status_var"] = tk.StringVar(master=self.root, value="待发送")
            row = tk.Frame(self.students_inner)
            row.pack(fill="x", pady=1)
            tk.Checkbutton(row, variable=item["_selected_var"], width=3,
                           command=lambda it=item: self.on_select_change(it)).pack(side="left")
            sid = item.get("sid") or "-"
            sname = item.get("sname") or item.get("studentName") or "-"
            tk.Label(row, text=sid, width=8, anchor="w").pack(side="left")
            tk.Label(row, text=sname, width=12, anchor="w").pack(side="left")
            status_lbl = tk.Label(
                row, textvariable=item["_status_var"], width=18, anchor="w",
                fg=self.STATUS_COLORS.get(item["_status_var"].get(), self.STATUS_DEFAULT_COLOR))
            status_lbl.pack(side="left")
            item["_status_label"] = status_lbl
            tk.Button(row, text="复制话术", width=9,
                      command=lambda it=item: self.copy_message(it)).pack(side="right", padx=2)
            tk.Button(row, text="复制学号姓名", width=14,
                      command=lambda it=item: self.copy_student(it)).pack(side="right", padx=2)
        if not self.items:
            tk.Label(self.students_inner,
                     text="还没有加载学生，请点击上方“选择 JSON / HTML 文件”。",
                     fg="#666666").pack(pady=24)
        self.students_canvas.yview_moveto(0)
        self.update_summary()

    def set_status(self, item, text):
        var = item.get("_status_var")
        if var is not None:
            var.set(text)
        label = item.get("_status_label")
        if label is not None:
            try:
                label.configure(fg=self.STATUS_COLORS.get(text, self.STATUS_DEFAULT_COLOR))
            except self.tk.TclError:
                pass
        self.root.update_idletasks()

    def update_summary(self):
        selected = 0
        for item in self.items:
            var = item.get("_selected_var")
            if var is not None and var.get():
                selected += 1
        self.summary_var.set(f"共 {len(self.items)} 人，已勾选 {selected} 人")

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
        self.hint_var.set("勾选要发送的学生，然后点“开始发送”。")

    def copy_to_clipboard(self, text, label):
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
        self.reply_btn.config(text=f"📨 待回名单 ({len(actionable(self.reply_notes))})")

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
        win.title("待回消息名单（仅显示需回复/待确认）")
        win.geometry("900x500")
        cols = [
            ("student", "学生", 160),
            ("chat_title", "会话", 180),
            ("last_message", "最后消息", 360),
            ("verdict", "需回", 90),
            ("time", "时间", 150),
        ]
        body = tk.Frame(win)
        body.pack(fill="both", expand=True, padx=8, pady=8)
        tree = ttk.Treeview(body, columns=[c for c, _, _ in cols],
                            show="headings", height=15, selectmode="browse")
        for c, label, width in cols:
            tree.heading(c, text=label)
            tree.column(c, width=width, anchor="w")
        for n in notes:
            tree.insert("", "end", values=tuple(n.get(c, "") for c, _, _ in cols))
        scroll = ttk.Scrollbar(body, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=scroll.set)
        tree.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")

        copy_hint = tk.StringVar(master=win, value="选中一行后点“复制学号姓名”，或双击该行。")
        tk.Label(win, textvariable=copy_hint, anchor="w", fg="#555555").pack(fill="x", padx=10)

        def copy_selected(_event=None):
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
            path = filedialog.asksaveasfilename(
                parent=win, title="导出待回消息名单", defaultextension=".csv",
                initialfile="待回名单.csv", filetypes=[("CSV", "*.csv")])
            if not path:
                return
            export_csv(notes, path)
            messagebox.showinfo("导出成功", f"已导出至：\n{path}", parent=win)

        actions = tk.Frame(win)
        actions.pack(pady=(4, 10))
        tk.Button(actions, text="复制选中学生学号姓名",
                  command=copy_selected).pack(side="left", padx=4)
        tk.Button(actions, text="导出 CSV", command=do_export).pack(side="left", padx=4)
        tree.bind("<Double-1>", copy_selected)
        if not notes:
            tk.Label(win, text="当前没有需要回复的学生", fg="#666666").pack(pady=(0, 6))

    def run_all(self):
        token = None
        try:
            try:
                from sender_py.vision_api import load_token
            except ModuleNotFoundError:
                from vision_api import load_token
            token = load_token() or None
        except Exception:
            pass
        if not self.items:
            self.emit("没有可发送的学生，请先选择 JSON / HTML 文件")
            self.hint_var.set("没有可发送的学生，请先选择文件")
            return
        selected_count = sum(
            1 for item in self.items
            if item.get("_selected_var") is not None and item["_selected_var"].get())
        if not selected_count:
            self.emit("没有勾选任何学生，请先勾选要发送的学生")
            self.hint_var.set("没有勾选任何学生")
            return
        for item in self.items:
            var = item.get("_selected_var")
            self.set_status(item, "待发送" if var is not None and var.get() else "已跳过")
        self.start_btn.config(state="disabled")
        self.hint_var.set("正在发送...")
        try:
            for item in self.items:
                var = item.get("_selected_var")
                name = item.get("studentName", "(未知学生)")
                if var is None or not var.get():
                    self.emit(f"[{name}] 未勾选，跳过")
                    continue
                item_key = item.get("_archive_key") or self.archive_key
                if SKIP_SENT and self._history and self._history.is_sent(item_key, name):
                    self.set_status(item, "已跳过（已发送）")
                    self.emit(f"[{name}] 已发送过，跳过")
                    continue
                self.set_status(item, "发送中")
                self.hint_var.set(f"正在发送：{name}")
                try:
                    res = send_student(item, self.server, token, parent=self.root,
                                       log=self.emit)
                except Exception as exc:
                    res = {"result": "error", "reason": f"程序异常：{exc}", "notes": []}
                for n in res.get("notes", []):
                    dedupe_add(self.reply_notes, n)
                self.refresh_reply_count()
                result = res.get("result", "")
                if result == "sent" and self._history:
                    self._history.mark_status(
                        item_key, name, "✅已发送", item.get("message", ""))
                status = {
                    "sent": "已发送",
                    "error": "发送失败",
                    "blocked": "已拦截",
                    "unmatched": "未匹配",
                }.get(result, result or "未知状态")
                self.set_status(item, status)
                self.emit(f"[{name}] → {result}：{res.get('reason', '')}")
                self.emit(f"学生间随机停顿 {pause(*STUDENT_GAP):.1f}s")
        finally:
            self.start_btn.config(state="normal")
            self.hint_var.set("本批处理结束")
        self.emit("本批处理结束")


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="企业微信反馈发送器")
    ap.add_argument("--input", default=None,
                    help="输入 JSON / HTML 快照；省略时尝试 测试.json，不存在则启动后选择")
    ap.add_argument("--server", default="https://feedback.wxjifang.cn", help="判定服务端")
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
                load_error = f"启动文件 {input_path} 没有有效学生数据，请点击“选择 JSON / HTML 文件（可多选）”重新选择。"
        except Exception as exc:
            load_error = f"启动时未能读取 {input_path}：{exc}\n请点击“选择 JSON / HTML 文件（可多选）”。"
    elif args.input:
        load_error = f"启动时未能读取 {input_path}：文件不存在\n请点击“选择 JSON / HTML 文件（可多选）”。"
    import tkinter as tk
    try:
        from sender_py.window_utils import set_per_monitor_dpi_awareness
    except ModuleNotFoundError:
        from window_utils import set_per_monitor_dpi_awareness
    set_per_monitor_dpi_awareness()
    root = tk.Tk()
    app = SenderApp(root, items, args.server, key, input_paths=input_paths)
    if load_error:
        app.emit(load_error)
        from tkinter import messagebox
        messagebox.showwarning("加载失败", load_error, parent=root)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
