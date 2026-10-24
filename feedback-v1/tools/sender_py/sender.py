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
    """纯函数：按 1→2→3 机械顺序推演整学生结局（供单测与 dry-run）。"""
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
    """搜人进会话：第 candidate_index 个结果。Ctrl+F 聚焦→全选→Backspace 清空→粘贴→回车搜→Down 定位→回车进会话。"""
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
                 parent=None, log=print, dry_run: bool = False) -> dict:
    """单个学生全流程：最多 3 候选机械 1→2→3。返回 {result, notes, ...}（notes 供待回名单）。"""
    try:
        from sender_py import window_utils as wu
    except ModuleNotFoundError:
        import window_utils as wu
    name, sid, sname, message = item["studentName"], item["sid"], item["sname"], item["message"]
    notes = []

    def _paced(gaps):
        if not dry_run:
            log(f"[{name}] 随机停顿 {pause(*gaps):.1f}s")

    for cand in range(1, MAX_CANDIDATES + 1):
        if dry_run:
            rect = wu.get_wecom_rect()  # Linux 下为 None，dry-run 不真用
        else:  # 所有截图的前提：企微完整可见，否则 mss 截到遮挡物/屏外黑边
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
        if entered and not dry_run:  # 截图前焦点守护：mss 截的是屏幕像素，失焦会被遮挡物污染
            if not wu.find_and_activate_wecom():
                log(f"[{name}] 候选{cand}：企微唤起失败，换下一候选")
                _paced(CANDIDATE_GAP)
                continue
            time.sleep(0.3)
        judgment, chat_title, err = (None, None, "dry-run 跳过截图判定") if dry_run else judge_candidate(
            rect, roi, sid, sname, server, token)
        if dry_run:
            judgment = {"matched": cand == 1, "is_group": False, "title_in_header": True,
                        "detected_title": name, "last_sender": "parent",
                        "last_message_text": "（dry-run 桩判定）", "needs_reply": None, "reason": "dry-run"}
            chat_title, err = name, None
        if entered and should_record(chat_title, judgment):
            dedupe_add(notes, make_note(name, cand, chat_title, bool((judgment or {}).get("matched")), judgment or {}))
        if err is not None and not dry_run:
            log(f"[{name}] 候选{cand}：{err}，换下一候选")
            _paced(CANDIDATE_GAP)
            continue
        decision = decide_action(judgment)
        log(f"[{name}] 候选{cand}：{decision['action']}（{decision['reason']}）")
        if decision["action"] == "send":
            if dry_run:
                return {"result": "sent", "at_candidate": cand, "reason": "dry-run 未真发",
                        "notes": notes}
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
    def __init__(self, root, items: list, server: str, archive_key: str):
        import tkinter as tk
        from tkinter import ttk
        self.tk = tk
        self.items = items
        self.server = server
        self.archive_key = archive_key
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
        root.title("反馈发送器（mss + ROI 反推）")
        top = tk.Frame(root)
        top.pack(fill="x", padx=10, pady=6)
        self.dry = tk.BooleanVar(value=False)
        tk.Checkbutton(top, text="dry-run（不真发）", variable=self.dry).pack(side="left")
        self.roi_btn = tk.Button(top, text="重新校准 ROI", command=self.recalibrate)
        self.roi_btn.pack(side="left", padx=6)
        self.reply_btn = tk.Button(top, text="📨 待回名单 (0)", command=self.show_reply_notes_dialog)
        self.reply_btn.pack(side="left", padx=6)
        tk.Button(top, text="开始发送", command=self.run_all).pack(side="right")
        self.log = tk.Text(root, height=20, width=100)
        self.log.pack(fill="both", expand=True, padx=10, pady=6)
        self._ttk = ttk

    def emit(self, msg: str):
        self.log.insert("end", msg + "\n")
        self.log.see("end")
        self.log.update_idletasks()

    def refresh_reply_count(self):
        self.reply_btn.config(text=f"📨 待回名单 ({len(actionable(self.reply_notes))})")

    def recalibrate(self):
        try:
            from sender_py import window_utils as wu
            from sender_py.capture import capture_wecom_window
            from sender_py.roi_calibrator import run_calibration
            from sender_py.roi_manager import save_roi
        except ModuleNotFoundError:
            import window_utils as wu
            from capture import capture_wecom_window
            from roi_calibrator import run_calibration
            from roi_manager import save_roi
        rect = wu.get_wecom_rect()
        if not rect:
            self.emit("找不到企微窗口，无法校准")
            return
        roi = run_calibration(self.log.master, capture_wecom_window(rect))
        if roi is None:
            self.emit("已放弃校准")
            return
        save_roi(default_config_path(), signature_key(rect[2], rect[3], wu.get_dpi_scale()),
                 roi["title"], roi["input"], roi["chat"])
        self.emit("ROI 已保存")

    def show_reply_notes_dialog(self):
        tk, ttk = self.tk, self._ttk
        from tkinter import filedialog, messagebox
        try:
            from sender_py.reply_notes import export_csv
        except ModuleNotFoundError:
            from reply_notes import export_csv
        win = tk.Toplevel(self.log.master)
        win.title("待回消息名单（进会话会清未读角标，此表补回信号）")
        cols = ("student", "chat_title", "identity", "last_sender", "last_message", "verdict", "time")
        tree = ttk.Treeview(win, columns=cols, show="headings", height=15)
        for c in cols:
            tree.heading(c, text=c)
            tree.column(c, width=120 if c != "last_message" else 260)
        for n in self.reply_notes:
            tree.insert("", "end", values=tuple(n.get(c, "") for c in cols))
        tree.pack(fill="both", expand=True, padx=8, pady=8)

        def do_export():
            path = filedialog.asksaveasfilename(
                title="导出待回消息名单", defaultextension=".csv",
                initialfile="待回名单.csv", filetypes=[("CSV", "*.csv")])
            if not path:
                return
            export_csv(self.reply_notes, path)
            messagebox.showinfo("导出成功", f"已导出至：\n{path}", parent=win)
        tk.Button(win, text="导出 CSV", command=do_export).pack(pady=(0, 8))

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
        for item in self.items:
            if SKIP_SENT and self._history and self._history.is_sent(self.archive_key, item["studentName"]):
                self.emit(f"[{item['studentName']}] 已发送过，跳过")
                continue
            res = send_student(item, self.server, token, parent=self.log.master,
                               log=self.emit, dry_run=self.dry.get())
            for n in res.get("notes", []):
                dedupe_add(self.reply_notes, n)
            self.refresh_reply_count()
            if res["result"] == "sent" and self._history and not self.dry.get():
                self._history.mark_status(self.archive_key, item["studentName"], "✅已发送", item["message"])
            self.emit(f"[{item['studentName']}] → {res['result']}：{res.get('reason', '')}")
            if not self.dry.get():
                self.emit(f"学生间随机停顿 {pause(*STUDENT_GAP):.1f}s")
        self.emit("本批处理结束")


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="企业微信反馈发送器（mss + ROI 反推）")
    ap.add_argument("--input", default="测试.json", help="输入 JSON（数组 {studentName,message}）")
    ap.add_argument("--server", default="https://feedback.wxjifang.cn", help="判定服务端")
    ap.add_argument("--dry-run", action="store_true", help="只走流程不真发")
    args = ap.parse_args(argv)
    items = load_feedback_items(args.input)
    key = archive_key_for_input(args.input)
    if args.dry_run:  # 无界面干跑：决策链全覆盖，供 Linux/CI 验证
        for item in items:
            out = run_candidate_outcomes([
                {"matched": True, "is_group": False, "needs_reply": None},
            ])
            print(f"[{item['studentName']}] dry-run 决策：{out['result']}（{out['reason']}）")
        return 0
    import tkinter as tk
    try:
        from sender_py.window_utils import set_per_monitor_dpi_awareness
    except ModuleNotFoundError:
        from window_utils import set_per_monitor_dpi_awareness
    set_per_monitor_dpi_awareness()
    root = tk.Tk()
    SenderApp(root, items, args.server, key)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
