"""Web 端后台任务控制器与状态管理。

管理学员数据、文件池、后台发送线程、运行日志与防风控延迟，供本地 WebUI 调用。
"""

import datetime
import os
import queue
import random
import sys
import threading
import time

try:
    from sender_py.pacing import (
        AFTER_SEND_GAP, BATCH_BREAK_EVERY, BATCH_BREAK_GAP,
        CANDIDATE_GAP, SEARCH_GAP, STUDENT_GAP, pause
    )
    from sender_py.reply_notes import actionable, dedupe_add
    from sender_py.roi_manager import default_config_path, save_roi, signature_key, validate_rel
    from sender_py.sender import (
        AsyncReplyAnalyzer, archive_key_for_input, load_feedback_inputs,
        safe_copy, send_student, summarize_status_counts
    )
    from sender_py.store import HistoryManager, SentFilesManager
    from sender_py.utils import parse_student_identifier
    from sender_py.window_utils import GlobalEscWatcher
except ModuleNotFoundError:
    from pacing import (
        AFTER_SEND_GAP, BATCH_BREAK_EVERY, BATCH_BREAK_GAP,
        CANDIDATE_GAP, SEARCH_GAP, STUDENT_GAP, pause
    )
    from reply_notes import actionable, dedupe_add
    from roi_manager import default_config_path, save_roi, signature_key, validate_rel
    from sender import (
        AsyncReplyAnalyzer, archive_key_for_input, load_feedback_inputs,
        safe_copy, send_student, summarize_status_counts
    )
    from store import HistoryManager, SentFilesManager
    from utils import parse_student_identifier
    try:
        from window_utils import GlobalEscWatcher
    except Exception:
        GlobalEscWatcher = None


class WebController:
    """Web 端集中状态管理与执行控制器。"""

    def __init__(self, server: str = "https://feedback.wxjifang.cn"):
        self.server = server
        self.token = None
        self._load_token()

        self.items = []          # 列表条目 dict
        self.input_paths = []    # 当前已载入的文件绝对路径列表
        self.file_counts = {}    # path -> count
        self.duplicate_count = 0 # 去重条数
        self.reply_notes = []    # 待回学员条目

        self.history = HistoryManager()
        self.sent_files = SentFilesManager()

        self.logs = []           # 历史日志列表 [str, ...]
        self._log_listeners = [] # 监听 SSE 的队列列表
        self._lock = threading.Lock()

        self._running = False
        self._stop_requested = False
        self._worker_thread = None

        self._reply_analyzer = None
        self._reply_event_queue = queue.Queue()
        self._esc_watcher = None

        self.progress = {
            "running": False,
            "processed": 0,
            "total": 0,
            "current_name": "",
            "step_text": "就绪",
            "countdown": 0,
        }

        self.benchmark_state = {
            "running": False,
            "progress": {
                "processed": 0,
                "total": 0,
                "current_name": "",
                "step_text": "就绪",
            },
            "records": [],
            "summary": {},
        }
        self._benchmark_stop_requested = False
        self._benchmark_worker_thread = None

    def _start_esc_watcher(self):
        self._stop_esc_watcher()
        if GlobalEscWatcher is None:
            return
        try:
            self._esc_watcher = GlobalEscWatcher(on_stop_callback=self._on_emergency_esc)
            self._esc_watcher.start()
        except Exception:
            self._esc_watcher = None

    def _stop_esc_watcher(self):
        if self._esc_watcher:
            try:
                self._esc_watcher.stop()
            except Exception:
                pass
            self._esc_watcher = None

    def _on_emergency_esc(self):
        self._stop_requested = True
        self._benchmark_stop_requested = True
        self.emit("⏹ 监听到全局 ESC 按键（已阻止企微最小化），正在安全停止任务并保持断点...")

    def _load_token(self):
        try:
            try:
                from sender_py.vision_api import load_token
            except ModuleNotFoundError:
                from vision_api import load_token
            self.token = load_token() or None
        except Exception:
            self.token = None

    # ================= 日志系统 =================

    def emit(self, msg: str):
        """记录带精确时间戳的日志，并实时推送到活跃的 SSE 队列。"""
        now = datetime.datetime.now().strftime("%H:%M:%S")
        line = f"[{now}] {msg}"
        with self._lock:
            self.logs.append(line)
            if len(self.logs) > 5000:
                self.logs = self.logs[-4000:]
            listeners = list(self._log_listeners)
        for q in listeners:
            try:
                q.put_nowait({"type": "log", "line": line})
            except Exception:
                pass

    def add_listener(self) -> queue.Queue:
        q = queue.Queue(maxsize=1000)
        with self._lock:
            self._log_listeners.append(q)
        return q

    def remove_listener(self, q: queue.Queue):
        with self._lock:
            if q in self._log_listeners:
                self._log_listeners.remove(q)

    def get_logs(self, since: int = 0) -> list:
        with self._lock:
            if since < 0 or since >= len(self.logs):
                return []
            return list(self.logs[since:])

    def clear_logs(self):
        with self._lock:
            self.logs.clear()

    # ================= 文件与学员数据管理 =================

    def get_upload_dir(self) -> str:
        base = os.path.join(os.path.expanduser("~"), ".sender_py", "uploads")
        os.makedirs(base, exist_ok=True)
        return base

    def add_input_files(self, paths: list, replace: bool = False) -> dict:
        """添加文件到文件池并解析学员数据。"""
        if self._running:
            return {"success": False, "message": "正在发送中，无法添加新文件"}

        valid_paths = [os.path.normpath(p) for p in paths if os.path.isfile(p)]
        if not valid_paths:
            if replace:
                return self.clear_all_files()
            return {"success": False, "message": "未找到有效的文件路径"}

        with self._lock:
            if replace:
                target_paths = list(valid_paths)
            else:
                target_paths = list(self.input_paths)
                for p in valid_paths:
                    if p not in target_paths:
                        target_paths.append(p)

        try:
            items, file_counts, duplicates = load_feedback_inputs(target_paths)
        except Exception as exc:
            self.emit(f"❌ 文件解析失败：{exc}")
            return {"success": False, "message": f"文件解析失败: {exc}"}

        with self._lock:
            self.input_paths = target_paths
            self.file_counts = dict(file_counts)
            self.duplicate_count = duplicates

            # 为每个 item 赋予唯一 ID 与默认选中状态
            for idx, it in enumerate(items):
                sid = (it.get("sid") or "").strip()
                sname = (it.get("sname") or "").strip()
                it["_id"] = f"{sid}_{sname}_{idx}"
                it["_selected"] = True
                it["_status"] = it.get("_status") or "待发送"
                it["_last_reason"] = it.get("_last_reason") or ""
                it["_last_result"] = it.get("_last_result") or ""
            self.items = items

        self.emit(f"📂 成功载入 {len(target_paths)} 个文件，共 {len(items)} 位学员（去重 {duplicates} 人）。")
        self._notify_state_change()
        return {"success": True, "count": len(items), "files": len(target_paths)}

    def save_uploaded_file(self, filename: str, content: bytes) -> str:
        """保存上传的二进制文件到本地缓存目录，保持原始文件名不变。"""
        upload_dir = self.get_upload_dir()
        base_name = os.path.basename(filename)
        save_path = os.path.join(upload_dir, base_name)
        with open(save_path, "wb") as f:
            f.write(content)
        return save_path

    def remove_input_file(self, path: str) -> dict:
        """从文件池移除指定文件。"""
        if self._running:
            return {"success": False, "message": "正在发送中，无法操作文件"}
        norm = os.path.normpath(path)
        with self._lock:
            new_paths = [p for p in self.input_paths if os.path.normpath(p) != norm]
        if not new_paths:
            return self.clear_all_files()
        return self.add_input_files(new_paths, replace=True)

    def clear_all_files(self) -> dict:
        """清空文件池。"""
        if self._running:
            return {"success": False, "message": "正在发送中，无法清空"}
        with self._lock:
            self.input_paths.clear()
            self.items.clear()
            self.file_counts.clear()
            self.duplicate_count = 0
            self.progress["processed"] = 0
            self.progress["total"] = 0
            self.progress["current_name"] = ""
            self.progress["step_text"] = "已清空"
        self.emit("🗑️ 已清空文件池与学员列表。")
        self._notify_state_change()
        return {"success": True}

    # ================= 勾选与筛选管理 =================

    def set_selection(self, action: str, ids: list = None) -> dict:
        """批量修改学员的勾选状态。"""
        if self._running:
            return {"success": False, "message": "正在发送中，无法修改选择"}

        with self._lock:
            if action == "all":
                for it in self.items:
                    it["_selected"] = True
            elif action == "none":
                for it in self.items:
                    it["_selected"] = False
            elif action == "failed":
                for it in self.items:
                    st = it.get("_status", "")
                    it["_selected"] = st in ("发送失败", "未匹配", "已拦截")
            elif action == "invert":
                for it in self.items:
                    it["_selected"] = not it.get("_selected", True)
            elif action == "select_ids" and ids is not None:
                id_set = set(ids)
                for it in self.items:
                    if it["_id"] in id_set:
                        it["_selected"] = True
            elif action == "deselect_ids" and ids is not None:
                id_set = set(ids)
                for it in self.items:
                    if it["_id"] in id_set:
                        it["_selected"] = False
            elif action == "toggle_specific" and ids is not None:
                id_set = set(ids)
                for it in self.items:
                    if it["_id"] in id_set:
                        it["_selected"] = not it.get("_selected", True)
            elif action == "set_specific" and ids is not None:
                id_set = set(ids)
                for it in self.items:
                    it["_selected"] = (it["_id"] in id_set)

        self._notify_state_change()
        return {"success": True}

    # ================= 发送流程控制 =================

    def start_send(self, target_ids: list = None) -> dict:
        """开始批量执行发送任务（含 3 秒安全倒计时缓冲与断点续发）。"""
        if self._running:
            return {"success": False, "message": "发送任务已在运行中"}

        with self._lock:
            if target_ids is not None:
                selected_ids = set(target_ids)
                for it in self.items:
                    it["_selected"] = (it["_id"] in selected_ids)
            else:
                selected_ids = {it["_id"] for it in self.items if it.get("_selected", True)}

            if not selected_ids:
                return {"success": False, "message": "当前未勾选任何学员，请先勾选需要发送的条目"}

            selected_items = [it for it in self.items if it["_id"] in selected_ids]
            unsent_items = [it for it in selected_items if it.get("_status") != "已发送"]
            already_sent_items = [it for it in selected_items if it.get("_status") == "已发送"]

            # 如果勾选的既有已发送又有未发送 -> 仅发送未发送学生，已发送学生保留并保护
            if unsent_items and already_sent_items:
                target_items = unsent_items
            else:
                target_items = selected_items

            effective_ids = {it["_id"] for it in target_items}
            effective_count = len(target_items)
            total_count = len(self.items)

            for it in self.items:
                if it["_id"] in effective_ids:
                    it["_status"] = "待发送"
                    it["_last_result"] = ""
                    it["_last_reason"] = ""
                elif it.get("_status") != "已发送":
                    it["_status"] = "已跳过"
                    it["_last_result"] = "skipped"
                    it["_last_reason"] = "未勾选"

            self._running = True
            self._stop_requested = False
            self.progress["running"] = True
            self.progress["processed"] = 0
            self.progress["total"] = effective_count
            self.progress["current_name"] = ""
            self.progress["step_text"] = "准备发送..."

        self._start_esc_watcher()
        self._load_token()
        if self._reply_analyzer is None:
            self._reply_analyzer = AsyncReplyAnalyzer(
                server=self.server, token=self.token, max_workers=3,
                event_queue=self._reply_event_queue
            )

        self._worker_thread = threading.Thread(
            target=self._run_worker,
            args=(effective_ids, effective_count, total_count),
            daemon=True
        )
        self._worker_thread.start()
        return {"success": True, "selected_count": effective_count, "total_count": total_count}

    def stop_send(self) -> dict:
        """请求停止正在运行的发送任务。"""
        if not self._running:
            return {"success": False, "message": "当前没有正在运行的发送任务"}
        self._stop_requested = True
        self.emit("⏹ 用户请求停止发送任务（保持断点），正在安全退出...")
        return {"success": True}

    def _interruptible_pause(self, seconds: float) -> bool:
        """可随时打断的平滑等待（50ms 轮询检测停止标志）。"""
        end = time.monotonic() + max(0.0, seconds)
        while time.monotonic() < end:
            if self._stop_requested:
                return False
            time.sleep(0.05)
        return not self._stop_requested

    def _drain_reply_events(self):
        """收取后台留言分析事件。"""
        while True:
            try:
                event = self._reply_event_queue.get_nowait()
            except Exception:
                break
            kind = event[0]
            if kind == "note":
                note = event[1]
                dedupe_add(self.reply_notes, note)
                student = note.get("student", "")
                verdict_str = note.get("verdict", "")
                last_msg = note.get("last_message", "")
                if note.get("needs_reply") is True:
                    self.emit(f"🔔 [{student}] 后台留言分析：{verdict_str}（最后消息：{last_msg or '无'}）")
                elif note.get("needs_reply") is None:
                    self.emit(f"⚠️ [{student}] 后台留言分析：{verdict_str}（{last_msg or '无'}）")
                else:
                    self.emit(f"✓ [{student}] 后台留言分析：无需回复")

    def _run_worker(self, selected_ids: set, selected_count: int, total_count: int):
        """发送工作者主线程。"""
        self.emit(f"🚀 发送任务已就绪（本次将发送 {selected_count} 人，共 {total_count} 人，发送中按 ESC 可停止）")

        # 1. 执行真实的 3 秒倒计时
        for sec in (3, 2, 1):
            if self._stop_requested:
                self.emit("⏹ 倒计时期间收到停止请求，已取消发送。")
                self._finish_run(stopped=True, selected_ids=selected_ids)
                return
            with self._lock:
                self.progress["countdown"] = sec
                self.progress["step_text"] = f"3秒后即将开始发送（{sec}...），按ESC可取消"
            self.emit(f"⏳ 距离开始发送还有 {sec} 秒，可随时按 ESC 键取消...")
            self._notify_state_change()
            time.sleep(1.0)

        with self._lock:
            self.progress["countdown"] = 0
            self.progress["step_text"] = "正在发送中..."
        self._notify_state_change()

        processed = 0
        stopped = False
        config_path = default_config_path()

        try:
            for item in self.items:
                if item["_id"] not in selected_ids:
                    continue

                if self._stop_requested:
                    stopped = True
                    break

                name = item.get("studentName", "")
                sid = item.get("sid", "")
                msg_len = len(item.get("message", ""))

                # 保护机制：如果当前学生已被标记为已发送，安全跳过
                if item.get("_status") == "已发送":
                    self.emit(f"⏭ [{name}] 该学生已发送成功，安全跳过，防止重复打扰家长")
                    continue

                with self._lock:
                    item["_status"] = "发送中"
                    self.progress["current_name"] = name
                    self.progress["step_text"] = f"正在发送：{name} ({processed + 1}/{selected_count})"
                self._notify_state_change()

                self.emit(f"▶ 正在处理 [{processed + 1}/{selected_count}]: {name} (学号: {sid}) | 话术字数: {msg_len} 字")

                try:
                    res = send_student(
                        item, self.server, self.token, config_path=config_path,
                        parent=None, log=self.emit,
                        should_stop=lambda: self._stop_requested,
                        reply_analyzer=self._reply_analyzer,
                        verify_mode="auto"
                    )
                except Exception as exc:
                    res = {"result": "error", "reason": f"异常: {exc}", "notes": []}

                self._drain_reply_events()

                result = res.get("result", "error")
                reason = res.get("reason", "")
                for note in res.get("notes", []):
                    dedupe_add(self.reply_notes, note)

                status_map = {
                    "sent": "已发送",
                    "blocked": "已拦截",
                    "unmatched": "未匹配",
                    "stopped": "待发送",
                    "error": "发送失败",
                }
                status = status_map.get(result, "发送失败")

                with self._lock:
                    item["_status"] = status
                    item["_last_result"] = result
                    item["_last_reason"] = reason
                    if result == "sent":
                        # 成功发送后自动取消勾选
                        item["_selected"] = False
                    processed += 1
                    self.progress["processed"] = processed

                item_key = item.get("_archive_key") or "反馈结果 [第 1 周]"
                if result == "sent":
                    try:
                        self.history.mark_status(item_key, name, "✅已发送", item.get("message", ""))
                    except Exception:
                        pass
                    self.emit(f"  ✅ [{name}] 状态更新：已发送")
                elif result == "blocked":
                    self.emit(f"  🛑 [{name}] 状态更新：已拦截（{reason}）")
                elif result == "unmatched":
                    self.emit(f"  ⚠️ [{name}] 状态更新：未匹配（{reason}）")
                elif result == "stopped":
                    self.emit(f"  ⏹ [{name}] 状态保持：已暂停（{reason}）")
                else:
                    self.emit(f"  ❌ [{name}] 状态更新：发送失败（{reason}）")

                self._notify_state_change()

                if result == "stopped" or self._stop_requested:
                    stopped = True
                    break

                # 防风控延迟控制：每 15 人大停顿 2~3 秒；其余学员停顿 0.5~1.0 秒
                if processed < selected_count and not self._stop_requested:
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
            self.emit(f"发送任务异常中止：{exc}")
            stopped = True
        finally:
            self._finish_run(stopped=stopped, selected_ids=selected_ids)

    def _finish_run(self, stopped: bool, selected_ids: set):
        self._stop_esc_watcher()
        with self._lock:
            self._running = False
            self.progress["running"] = False
            self.progress["countdown"] = 0
            if stopped:
                self.progress["step_text"] = "已暂停发送，可点击“继续发送”继续"
                for it in self.items:
                    if it["_id"] in selected_ids and it.get("_status") in ("待发送", "发送中"):
                        it["_status"] = "待发送"
                        it["_last_result"] = "paused"
                        it["_last_reason"] = "已暂停，可继续发送"
                        it["_selected"] = True
            else:
                self.progress["step_text"] = "发送完成"

        self._record_sent_files_summary()

        counts = summarize_status_counts(it.get("_status", "") for it in self.items)
        title = "已暂停" if stopped else "本批发送结束"
        summary_msg = (
            f"🏁 {title}（共 {len(self.items)} 人）："
            f"成功 {counts['已发送']}，失败 {counts['发送失败']}，"
            f"拦截 {counts['已拦截']}，未匹配 {counts['未匹配']}，"
            f"跳过 {counts['已跳过']}"
        )
        self.emit(summary_msg)
        self._notify_state_change()

        self._record_sent_files_summary()

        counts = summarize_status_counts(it.get("_status", "") for it in self.items)
        title = "已停止" if stopped else "本批发送结束"
        summary_msg = (
            f"🏁 {title}（共 {len(self.items)} 人）："
            f"成功 {counts['已发送']}，失败 {counts['发送失败']}，"
            f"拦截 {counts['已拦截']}，未匹配 {counts['未匹配']}，"
            f"跳过 {counts['已跳过']}"
        )
        self.emit(summary_msg)
        self._notify_state_change()

    def _record_sent_files_summary(self):
        """自动在本地已发文件库保存本次记录。"""
        try:
            if self.input_paths:
                for path in self.input_paths:
                    file_items = [it for it in self.items if it.get("_archive_key") == archive_key_for_input(path)]
                    if not file_items:
                        file_items = self.items
                    any_sent = any(it.get("_status") == "已发送" for it in file_items)
                    if any_sent:
                        rec = self.sent_files.record_sent_file(path, file_items)
                        self.emit(f"💾 已保存文件 [{os.path.basename(path)}] 发送记录：{os.path.basename(rec.get('html_record', ''))}")
            elif self.items:
                any_sent = any(it.get("_status") == "已发送" for it in self.items)
                if any_sent:
                    rec = self.sent_files.record_sent_file("已发学生反馈.json", self.items)
                    self.emit(f"💾 已保存本次发送记录：{os.path.basename(rec.get('html_record', ''))}")
        except Exception as exc:
            self.emit(f"⚠️ 记录已发文件失败：{exc}")

    # ================= 视野校准 =================

    def run_calibration(self) -> dict:
        """异步执行企业微信视野校准。"""
        if self._running:
            return {"success": False, "message": "正在发送中，无法校准视野"}

        self.emit("🎯 开始检测企业微信窗口视野...")
        try:
            try:
                from sender_py import window_utils as wu
            except ModuleNotFoundError:
                import window_utils as wu

            if not wu.find_and_activate_wecom():
                return {"success": False, "message": "未能激活企业微信窗口，请先打开企微并点进任意具体聊天。"}

            time.sleep(0.4)
            rect = wu.get_wecom_rect()
            if not rect or rect[2] < 200 or rect[3] < 150:
                return {"success": False, "message": "未能获取有效的企微窗口尺寸，请确认企微未处于最小化。"}

            scale = wu.get_dpi_scale()

            try:
                from sender_py.capture import capture_wecom_window
                from sender_py.vision_api import calibrate_roi
            except ModuleNotFoundError:
                from capture import capture_wecom_window
                from vision_api import calibrate_roi

            img = capture_wecom_window(rect)
            if img is None:
                return {"success": False, "message": "未能捕获企业微信画面，请确认企微窗口未被遮挡。"}

            self.emit("  └ 正在通过 Qwen3.8-Max 多模态模型自动智能框选...")
            ai_roi = calibrate_roi(img, server=self.server, token=self.token)

            if ai_roi and isinstance(ai_roi, dict) and all(k in ai_roi for k in ("title", "input", "chat")):
                if all(validate_rel(ai_roi[k]) for k in ("title", "input", "chat")):
                    key = signature_key(rect[2], rect[3], scale)
                    save_roi(default_config_path(), key, ai_roi["title"], ai_roi["input"], ai_roi["chat"])
                    msg = f"✓ 智能校准成功（{ai_roi.get('reason', 'AI框选生效')}），企业微信视野配置已自动保存！"
                    self.emit(msg)
                    return {"success": True, "message": msg}

            return {"success": False, "message": "AI 自动定位未通过（可能未点进具体聊天），建议打开聊天界面后重试。"}
        except Exception as exc:
            err = f"视野校准异常：{exc}"
            self.emit(f"❌ {err}")
            return {"success": False, "message": err}

    # ================= 状态序列化 =================

    def get_state(self) -> dict:
        """获取当前完整状态供前端渲染。"""
        with self._lock:
            counts = summarize_status_counts(it.get("_status", "") for it in self.items)
            selected_count = sum(1 for it in self.items if it.get("_selected", True))
            files_list = [
                {
                    "path": p,
                    "name": os.path.basename(p),
                    "ext": os.path.splitext(p)[1].lower(),
                    "count": self.file_counts.get(p, 0),
                }
                for p in self.input_paths
            ]
            students_list = [
                {
                    "id": it["_id"],
                    "sid": it.get("sid", ""),
                    "sname": it.get("sname", ""),
                    "studentName": it.get("studentName", ""),
                    "message": it.get("message", ""),
                    "status": it.get("_status", "待发送"),
                    "last_reason": it.get("_last_reason", ""),
                    "selected": it.get("_selected", True),
                    "archive_key": it.get("_archive_key", ""),
                }
                for it in self.items
            ]
            return {
                "running": self._running,
                "stop_requested": self._stop_requested,
                "progress": dict(self.progress),
                "summary": {
                    "total": len(self.items),
                    "selected": selected_count,
                    "sent": counts["已发送"],
                    "failed": counts["发送失败"],
                    "unmatched": counts["未匹配"],
                    "blocked": counts["已拦截"],
                    "skipped": counts["已跳过"],
                },
                "files": files_list,
                "duplicate_count": self.duplicate_count,
                "students": students_list,
                "reply_notes_count": len(actionable(self.reply_notes)),
                "logs_count": len(self.logs),
            }

    def _notify_state_change(self):
        """通知 SSE 监听者状态发生变化。"""
        with self._lock:
            listeners = list(self._log_listeners)
        for q in listeners:
            try:
                q.put_nowait({"type": "state_change"})
            except Exception:
                pass

    # ================= 多引擎基准评测 (Benchmark Dry-Run) =================

    def start_benchmark(self, target_ids: list = None) -> dict:
        """启动多引擎基准评测（全仿真·只测不发）。"""
        with self._lock:
            if self._running:
                return {"success": False, "message": "常规发送任务正在执行中，请先停止发送"}
            if self.benchmark_state["running"]:
                return {"success": False, "message": "基准评测已在运行中"}

            if target_ids is not None:
                selected_set = set(target_ids)
                items_to_run = [it for it in self.items if it["_id"] in selected_set]
            else:
                items_to_run = [it for it in self.items if it.get("_selected", True)]

            if not items_to_run:
                return {"success": False, "message": "未勾选任何需要评测的学生"}

            self.benchmark_state["running"] = True
            self.benchmark_state["progress"] = {
                "processed": 0,
                "total": len(items_to_run),
                "current_name": "",
                "step_text": "正在启动评测...",
            }
            self.benchmark_state["records"] = []
            self.benchmark_state["summary"] = {}
            self._benchmark_stop_requested = False

        self._benchmark_worker_thread = threading.Thread(
            target=self._run_benchmark_worker,
            args=(items_to_run,),
            daemon=True
        )
        self._benchmark_worker_thread.start()
        return {"success": True, "message": f"多引擎基准评测已启动，共 {len(items_to_run)} 人", "total": len(items_to_run)}

    def stop_benchmark(self) -> dict:
        """停止多引擎基准评测。"""
        with self._lock:
            if not self.benchmark_state["running"]:
                return {"success": True, "message": "当前未在运行评测"}
            self._benchmark_stop_requested = True
        self.emit("⏹ [评测] 已收到停止请求，正在中止当前学生评测...")
        return {"success": True, "message": "已发送停止请求"}

    def get_benchmark_state(self) -> dict:
        """获取当前评测状态与结果数据。"""
        with self._lock:
            return {
                "running": self.benchmark_state["running"],
                "stop_requested": self._benchmark_stop_requested,
                "progress": dict(self.benchmark_state["progress"]),
                "records": list(self.benchmark_state["records"]),
                "summary": dict(self.benchmark_state["summary"]),
            }

    def get_benchmark_csv_content(self) -> tuple:
        """生成评测 CSV 文本内容与建议文件名。"""
        try:
            try:
                from sender_py.benchmark import generate_benchmark_csv_content, compute_benchmark_summary
            except ModuleNotFoundError:
                from benchmark import generate_benchmark_csv_content, compute_benchmark_summary
        except Exception as exc:
            return (f"导出异常: {exc}", "error.csv")

        with self._lock:
            records = list(self.benchmark_state["records"])
            summary = self.benchmark_state.get("summary") or compute_benchmark_summary(records)

        csv_text = generate_benchmark_csv_content(records, summary)
        filename = f"OCR_Benchmark_{time.strftime('%Y%m%d_%H%M%S')}.csv"
        return (csv_text, filename)

    def _run_benchmark_worker(self, items_to_run: list):
        """评测工作线程：全仿真运行企微搜索与截图核验，物理断路不发消息。"""
        total = len(items_to_run)
        self.emit(f"🧪 [多引擎评测] 开始基准评测（共 {total} 人，全程只识别不发送，按 ESC 随时停止）")
        self._start_esc_watcher()

        try:
            try:
                from sender_py.benchmark import benchmark_single_student, compute_benchmark_summary
                from sender_py.roi_manager import default_config_path
            except ModuleNotFoundError:
                from benchmark import benchmark_single_student, compute_benchmark_summary
                from roi_manager import default_config_path

            records = []
            config_path = default_config_path()

            for idx, item in enumerate(items_to_run, 1):
                if self._benchmark_stop_requested:
                    self.emit("⏹ [多引擎评测] 收到停止请求，评测终止。")
                    break

                name = item.get("studentName", "")
                with self._lock:
                    self.benchmark_state["progress"] = {
                        "processed": idx,
                        "total": total,
                        "current_name": name,
                        "step_text": f"正在评测：{name} ({idx}/{total})",
                    }
                self._notify_state_change()

                self.emit(f"🧪 [{idx}/{total}] 正在全仿真比对联系人: {name}...")
                res = benchmark_single_student(
                    item,
                    self.server,
                    self.token,
                    config_path=config_path,
                    log=self.emit,
                    should_stop=lambda: self._benchmark_stop_requested,
                )

                if res.get("record"):
                    rec = res["record"]
                    records.append(rec)
                    with self._lock:
                        self.benchmark_state["records"] = list(records)
                        self.benchmark_state["summary"] = compute_benchmark_summary(records)
                    self._notify_state_change()
                else:
                    self.emit(f"  ⚠️ [{name}] 未能获取有效评测数据：{res.get('reason')}")

                time.sleep(0.4)

            summary = compute_benchmark_summary(records)
            with self._lock:
                self.benchmark_state["summary"] = summary
                self.benchmark_state["progress"]["step_text"] = "评测已完成"
            self._notify_state_change()

            self.emit(f"🎉 [多引擎评测] 评测任务全部完成！共测试 {len(records)} 人，发现分歧 {summary.get('discrepancy_count', 0)} 例。")
        except Exception as exc:
            self.emit(f"❌ [多引擎评测] 运行异常: {exc}")
        finally:
            with self._lock:
                self.benchmark_state["running"] = False
            self._stop_esc_watcher()
            self._notify_state_change()
