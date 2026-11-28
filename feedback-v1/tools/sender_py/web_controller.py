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
        APP_VERSION, AsyncReplyAnalyzer, archive_key_for_input, load_feedback_inputs,
        open_sample_chat_for_calibration, safe_copy, send_student, summarize_status_counts
    )
    from sender_py.store import HistoryManager, SentFilesManager
    from sender_py.utils import (
        build_items_from_attachment_files,
        match_files_to_students,
        parse_student_identifier,
    )
    from sender_py.window_utils import GlobalEscWatcher
    from sender_py.cloud_control import get_cloud_control_manager
    from sender_py.file_logger import (
        cleanup_old_logs, write_log, open_logs_dir, list_log_files, read_log_file,
        update_log_context, sync_batch_summary, flush_cloud_logs, pull_cloud_control,
        get_client_identity, get_teacher_note, set_teacher_note, get_cloud_sync_status,
        _SYNCER,
    )
except ModuleNotFoundError:
    from pacing import (
        AFTER_SEND_GAP, BATCH_BREAK_EVERY, BATCH_BREAK_GAP,
        CANDIDATE_GAP, SEARCH_GAP, STUDENT_GAP, pause
    )
    from reply_notes import actionable, dedupe_add
    from roi_manager import default_config_path, save_roi, signature_key, validate_rel
    from sender import (
        APP_VERSION, AsyncReplyAnalyzer, archive_key_for_input, load_feedback_inputs,
        open_sample_chat_for_calibration, safe_copy, send_student, summarize_status_counts
    )
    from store import HistoryManager, SentFilesManager
    from utils import (
        build_items_from_attachment_files,
        match_files_to_students,
        parse_student_identifier,
    )
    try:
        from cloud_control import get_cloud_control_manager
    except Exception:
        get_cloud_control_manager = None
    try:
        from window_utils import GlobalEscWatcher
    except Exception:
        GlobalEscWatcher = None
    try:
        from file_logger import (
            cleanup_old_logs, write_log, open_logs_dir, list_log_files, read_log_file,
            update_log_context, sync_batch_summary, flush_cloud_logs, pull_cloud_control,
            get_client_identity, get_teacher_note, set_teacher_note, get_cloud_sync_status,
            _SYNCER,
        )
    except ModuleNotFoundError:
        cleanup_old_logs = lambda max_days=30: None
        write_log = lambda msg, level=None, exc_info=None: ("", "")
        open_logs_dir = lambda: False
        list_log_files = lambda: []
        read_log_file = lambda filename, max_lines=2000: ""
        update_log_context = lambda **kwargs: None
        sync_batch_summary = lambda *args, **kwargs: None
        flush_cloud_logs = lambda timeout=2.5: None
        pull_cloud_control = lambda **kwargs: None
        get_client_identity = lambda base_dir=None: {}
        get_teacher_note = lambda base_dir=None: ""
        set_teacher_note = lambda note, base_dir=None: str(note or "")
        get_cloud_sync_status = lambda: {"enabled": False}
        _SYNCER = None


class WebController:
    """Web 端集中状态管理与执行控制器。"""

    def __init__(self, server: str = "https://feedback.wxjifang.cn", enable_cloud_sync: bool = None):
        self.server = server
        self.token = None
        self._load_token()

        self.items = []          # 列表条目 dict
        self.input_paths = []    # 当前已载入的文件绝对路径列表
        self.file_counts = {}    # path -> count
        self.duplicate_count = 0 # 去重条数
        self.reply_notes = []    # 待回学员条目
        self.global_attachments = []   # 全员公共附件绝对路径列表
        self.send_mode = "both"        # "both" (文字+附件) | "files_only" (仅发附件) | "text_only" (仅发文字)
        self.default_file_message = "" # 直接从附件构建队列时的可选统一话术

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
            "sidebar_alert": None,
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

        try:
            cleanup_old_logs(max_days=30)
        except Exception:
            pass

        # 初始化云端日志自动同步与云控策略拉取（单元测试环境未显式开启时不对外发网络请求）
        if enable_cloud_sync is None:
            enable_cloud_sync = ("unittest" not in sys.modules) and (os.environ.get("SENDER_DISABLE_CLOUD_LOG") != "1")
        self._cloud_sync_enabled = bool(enable_cloud_sync)
        self._cloud_control = get_cloud_control_manager() if get_cloud_control_manager is not None else None
        if self._cloud_control is not None:
            self._cloud_control.set_command_handler(self._handle_cloud_command)
            self._cloud_control.set_policy_change_handler(lambda _pol: self._notify_state_change())
        try:
            update_log_context(
                server=self.server,
                token=self.token,
                active_files=[],
                teacher_note=get_teacher_note(),
                enabled=bool(enable_cloud_sync),
                runtime_state=self._build_runtime_state_payload(),
            )
            if enable_cloud_sync and _SYNCER is not None:
                _SYNCER.trigger_history_sync()
                threading.Thread(
                    target=lambda: pull_cloud_control(server=self.server, token=self.token, timeout=3.0),
                    name="CloudControlBootPull",
                    daemon=True,
                ).start()
        except Exception:
            pass

    def _build_runtime_state_payload(self) -> dict:
        pol = self._cloud_control.get_policy() if self._cloud_control is not None else {}
        return {
            "running": bool(self._running),
            "processed": int(self.progress.get("processed", 0)),
            "total": int(self.progress.get("total", 0)),
            "current_name": str(self.progress.get("current_name", "")),
            "verify_mode": str(pol.get("verifyMode", "auto")),
            "policy_version": int(pol.get("policyVersion", 1)),
        }

    def _sync_runtime_context(self):
        try:
            update_log_context(runtime_state=self._build_runtime_state_payload())
        except Exception:
            pass

    def refresh_cloud_control(self, timeout: float = 3.0) -> dict:
        if not self._cloud_sync_enabled:
            return {
                "success": True,
                "cloud_control": self._cloud_control.get_snapshot_state(APP_VERSION) if self._cloud_control else {},
            }
        res = pull_cloud_control(
            server=self.server,
            token=self.token,
            runtime_state=self._build_runtime_state_payload(),
            timeout=timeout,
        )
        self._notify_state_change()
        return {
            "success": bool(res is not None),
            "cloud_control": self._cloud_control.get_snapshot_state(APP_VERSION) if self._cloud_control else {},
        }

    def _handle_cloud_command(self, cmd: dict) -> dict:
        cmd_type = str(cmd.get("type") or "").strip().lower()
        params = cmd.get("params") if isinstance(cmd.get("params"), dict) else {}
        reason = str(params.get("reason") or "管理员从后台触发").strip()

        if cmd_type == "stop_batch":
            was_running = bool(self._running or self.benchmark_state.get("running"))
            self._stop_requested = True
            self._benchmark_stop_requested = True
            if was_running:
                self.emit(f"⏹ [云控指令] 收到管理员远程急停信号（{reason}），正在安全停止并保持断点...")
            else:
                self.emit(f"ℹ [云控指令] 收到管理员远程急停信号（当前未在发送中）")
            self._notify_state_change()
            return {"success": True, "message": "已执行远程急停" if was_running else "当前无运行中任务，已置位停止标记"}

        if cmd_type == "refresh_policy":
            self.emit("☁ [云控指令] 管理员通知刷新云控策略，最新策略已同步生效。")
            self._notify_state_change()
            return {"success": True, "message": "云控策略已刷新"}

        if cmd_type == "clear_roi":
            cfg_path = default_config_path()
            removed = False
            try:
                if os.path.isfile(cfg_path):
                    os.remove(cfg_path)
                    removed = True
            except Exception as exc:
                return {"success": False, "message": f"清理 ROI 文件失败: {exc}"}
            self.emit("☁ [云控指令] 管理员已远程重置本机企微视野校准缓存（下次发送前将重新自动标定）。")
            self._notify_state_change()
            return {"success": True, "message": "已清理 ROI 缓存" if removed else "本机暂无 ROI 缓存"}

        if cmd_type == "sync_logs":
            if self._cloud_sync_enabled and _SYNCER is not None:
                _SYNCER.trigger_history_sync()
            self.emit("☁ [云控指令] 已触发全量日志补传同步。")
            return {"success": True, "message": "已触发日志补传"}

        return {"success": False, "message": f"未知云控指令: {cmd_type}"}

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
        already = self._stop_requested and self._benchmark_stop_requested
        self._stop_requested = True
        self._benchmark_stop_requested = True
        if not already:
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

    def emit(self, msg: str, level: str = None, exc_info: object = None):
        """记录带精确时间戳的日志，实时推送到活跃的 SSE 队列，并保存到本地日志文件。"""
        now = datetime.datetime.now().strftime("%H:%M:%S")
        line = f"[{now}] {msg}"
        with self._lock:
            self.logs.append(line)
            if len(self.logs) > 5000:
                self.logs = self.logs[-4000:]
            listeners = list(self._log_listeners)

        try:
            write_log(msg, level=level, exc_info=exc_info)
        except Exception:
            pass

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
            self.emit(f"文件解析失败：{exc}")
            return {"success": False, "message": f"文件解析失败: {exc}"}

        with self._lock:
            prev_files_map = {}
            for old_it in self.items:
                old_key = ((old_it.get("sid") or "").strip(), (old_it.get("sname") or "").strip())
                if any(old_key) and old_it.get("files"):
                    prev_files_map[old_key] = list(old_it.get("files") or [])

            self.input_paths = target_paths
            self.file_counts = dict(file_counts)
            self.duplicate_count = duplicates

            # 为每个 item 赋予唯一 ID 与默认选中状态，并保留此前已挂载的专属附件
            for idx, it in enumerate(items):
                sid = (it.get("sid") or "").strip()
                sname = (it.get("sname") or "").strip()
                it["_id"] = f"{sid}_{sname}_{idx}"
                it["_selected"] = True
                it["_status"] = it.get("_status") or "待发送"
                it["_last_reason"] = it.get("_last_reason") or ""
                it["_last_result"] = it.get("_last_result") or ""
                it["_text_sent"] = bool(it.get("_text_sent", False))
                merged_files = list(it.get("files") or [])
                for old_f in prev_files_map.get((sid, sname), []):
                    if old_f not in merged_files:
                        merged_files.append(old_f)
                it["files"] = merged_files
            self.items = items

        try:
            update_log_context(active_files=target_paths)
        except Exception:
            pass
        self.emit(f"成功载入 {len(target_paths)} 个文件，共 {len(items)} 位学员（去重 {duplicates} 人）。")
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
            self.global_attachments.clear()
            self.progress["processed"] = 0
            self.progress["total"] = 0
            self.progress["current_name"] = ""
            self.progress["step_text"] = "已清空"
        try:
            update_log_context(active_files=[])
        except Exception:
            pass
        self.emit("已清空文件池与学员列表。")
        self._notify_state_change()
        return {"success": True}

    # ================= 附件管理与智能匹配 =================

    def _get_effective_files(self, item: dict) -> list:
        """获取某位学员最终应发送的附件列表（专属附件 + 全员公共附件，去重保序）。"""
        out = []
        seen = set()
        for p in list(item.get("files") or []) + list(self.global_attachments or []):
            s = str(p or "").strip()
            if not s:
                continue
            norm = os.path.normpath(s)
            key = os.path.normcase(norm)
            if key not in seen:
                seen.add(key)
                out.append(norm)
        return out

    def _expand_attachment_paths(self, paths: list) -> list:
        """将传入的文件或文件夹路径展开为有效本地文件绝对路径列表（忽略临时文件与隐藏文件）。"""
        expanded = []
        seen = set()
        ignored_names = {"thumbs.db", ".ds_store", "desktop.ini"}
        for raw in (paths or []):
            s = str(raw or "").strip()
            if not s:
                continue
            norm = os.path.normpath(os.path.abspath(s))
            if os.path.isdir(norm):
                try:
                    entries = sorted(os.listdir(norm))
                except Exception:
                    entries = []
                for fname in entries:
                    if fname.startswith(".") or fname.startswith("~$") or fname.lower() in ignored_names:
                        continue
                    fpath = os.path.join(norm, fname)
                    if os.path.isfile(fpath):
                        key = os.path.normcase(fpath)
                        if key not in seen:
                            seen.add(key)
                            expanded.append(fpath)
            elif os.path.isfile(norm):
                fname = os.path.basename(norm)
                if fname.startswith("~$") or fname.lower() in ignored_names:
                    continue
                key = os.path.normcase(norm)
                if key not in seen:
                    seen.add(key)
                    expanded.append(norm)
        return expanded

    def attach_and_match_files(
        self,
        paths: list,
        create_items_if_empty: bool = True,
        default_message: str = None,
    ) -> dict:
        """智能匹配专属附件；当队列为空且 create_items_if_empty=True 时直接从附件文件名构建发送队列。"""
        if self._running:
            return {"success": False, "message": "正在发送中，无法修改附件"}

        valid_files = self._expand_attachment_paths(paths)
        if not valid_files:
            return {"success": False, "message": "未找到有效的附件文件"}

        with self._lock:
            if default_message is not None:
                self.default_file_message = str(default_message)
            eff_default_msg = self.default_file_message

            if not self.items and create_items_if_empty:
                built_items, unmatched = build_items_from_attachment_files(
                    valid_files, default_message=eff_default_msg
                )
                if not built_items:
                    return {
                        "success": False,
                        "message": f"所选 {len(valid_files)} 个文件的文件名中均未识别出『学号+姓名』（如 90001张三.pdf）",
                    }
                for idx, it in enumerate(built_items):
                    sid = (it.get("sid") or "").strip()
                    sname = (it.get("sname") or "").strip()
                    it["_id"] = f"{sid}_{sname}_{idx}"
                    it["_selected"] = True
                    it["_status"] = "待发送"
                    it["_last_reason"] = ""
                    it["_last_result"] = ""
                    it["_text_sent"] = False
                    it["_archive_key"] = "附件直发队列 [第 1 周]"
                self.items = built_items
                matched_files_cnt = len(valid_files) - len(unmatched)
                if not eff_default_msg.strip():
                    self.send_mode = "files_only"
                msg = f"已从附件文件名自动生成 {len(built_items)} 位学员队列（共挂载 {matched_files_cnt} 个文件"
                if unmatched:
                    msg += f"，{len(unmatched)} 个文件未识别出学号姓名"
                msg += "）。"
                res_payload = {
                    "success": True,
                    "mode": "created_queue",
                    "matched_students": len(built_items),
                    "matched_files": matched_files_cnt,
                    "unmatched_count": len(unmatched),
                    "unmatched_files": [os.path.basename(p) for p in unmatched[:20]],
                    "message": msg,
                }
            else:
                match_res = match_files_to_students(valid_files, self.items)
                unmatched = match_res["unmatched_files"]
                msg = (
                    f"附件匹配完成：成功为 {match_res['matched_students']}/{len(self.items)} 位学员"
                    f"挂载 {match_res['matched_files']} 个专属文件"
                )
                if unmatched:
                    msg += f"（另有 {len(unmatched)} 个文件未匹配到当前名单）"
                res_payload = {
                    "success": True,
                    "mode": "matched_existing",
                    "matched_students": match_res["matched_students"],
                    "matched_files": match_res["matched_files"],
                    "unmatched_count": len(unmatched),
                    "unmatched_files": [os.path.basename(p) for p in unmatched[:20]],
                    "message": msg,
                }

        self.emit(res_payload["message"])
        self._notify_state_change()
        return res_payload

    def add_global_attachments(self, paths: list) -> dict:
        """添加全员公共附件。"""
        if self._running:
            return {"success": False, "message": "正在发送中，无法修改公共附件"}
        valid_files = self._expand_attachment_paths(paths)
        if not valid_files:
            return {"success": False, "message": "未找到有效的公共附件文件"}
        added = 0
        with self._lock:
            existing_norm = {os.path.normcase(p) for p in self.global_attachments}
            for p in valid_files:
                if os.path.normcase(p) not in existing_norm:
                    self.global_attachments.append(p)
                    existing_norm.add(os.path.normcase(p))
                    added += 1
            total_global = len(self.global_attachments)
        self.emit(f"已添加 {added} 个全员公共附件（当前共 {total_global} 个公共附件）。")
        self._notify_state_change()
        return {"success": True, "added": added, "total": total_global}

    def remove_global_attachment(self, path: str) -> dict:
        """移除指定的全员公共附件。"""
        if self._running:
            return {"success": False, "message": "正在发送中，无法移除公共附件"}
        target = os.path.normcase(os.path.normpath(str(path or "").strip()))
        with self._lock:
            before = len(self.global_attachments)
            self.global_attachments = [
                p for p in self.global_attachments if os.path.normcase(os.path.normpath(p)) != target
            ]
            after = len(self.global_attachments)
        if before != after:
            self.emit(f"已移除公共附件：{os.path.basename(path)}")
        self._notify_state_change()
        return {"success": True, "total": after}

    def clear_all_attachments(self) -> dict:
        """清空所有公共附件与学员专属附件。"""
        if self._running:
            return {"success": False, "message": "正在发送中，无法清空附件"}
        with self._lock:
            self.global_attachments.clear()
            for it in self.items:
                it["files"] = []
                it["_text_sent"] = False
            if self.send_mode == "files_only":
                self.send_mode = "both"
        self.emit("已清空所有专属附件与公共附件。")
        self._notify_state_change()
        return {"success": True}

    def update_student_attachments(
        self, student_id: str, action: str, paths: list = None, path: str = ""
    ) -> dict:
        """针对单个学员添加、移除或清空专属附件。"""
        if self._running:
            return {"success": False, "message": "正在发送中，无法修改学员附件"}
        sid_target = str(student_id or "").strip()
        with self._lock:
            target_item = next((it for it in self.items if it.get("_id") == sid_target), None)
            if target_item is None:
                return {"success": False, "message": "未找到对应的学员条目"}
            cur_files = list(target_item.get("files") or [])
            if action == "add":
                valid = self._expand_attachment_paths(paths or ([path] if path else []))
                existing = {os.path.normcase(p) for p in cur_files}
                for p in valid:
                    if os.path.normcase(p) not in existing:
                        cur_files.append(p)
                        existing.add(os.path.normcase(p))
                target_item["files"] = cur_files
            elif action == "remove":
                rm_norm = os.path.normcase(os.path.normpath(str(path or "").strip()))
                target_item["files"] = [
                    p for p in cur_files if os.path.normcase(os.path.normpath(p)) != rm_norm
                ]
            elif action == "clear":
                target_item["files"] = []
        self._notify_state_change()
        return {"success": True, "files": [os.path.basename(p) for p in target_item.get("files", [])]}

    def set_attachment_options(
        self,
        send_mode: str = None,
        default_file_message: str = None,
        apply_message_to_all: bool = False,
    ) -> dict:
        """设置附件发送模式（both / files_only / text_only）或统一补充话术。"""
        if self._running:
            return {"success": False, "message": "正在发送中，无法修改发送设置"}
        with self._lock:
            if send_mode in ("both", "files_only", "text_only"):
                self.send_mode = send_mode
            if default_file_message is not None:
                self.default_file_message = str(default_file_message)
                if apply_message_to_all:
                    for it in self.items:
                        it["message"] = self.default_file_message
                        it["_text_sent"] = False
                    if self.default_file_message.strip() and self.send_mode == "files_only":
                        self.send_mode = "both"
        self._notify_state_change()
        return {
            "success": True,
            "send_mode": self.send_mode,
            "default_file_message": self.default_file_message,
        }

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
            elif action == "has_attachments":
                for it in self.items:
                    it["_selected"] = bool(self._get_effective_files(it))
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
        """开始批量执行发送任务（含云控门禁检查、3 秒安全倒计时缓冲与断点续发）。"""
        if self._running:
            return {"success": False, "message": "发送任务已在运行中"}

        # 开跑前先尝试拉取最新云控策略，确保停服锁/最低版本门禁/核验策略即时生效
        if self._cloud_sync_enabled:
            try:
                pull_cloud_control(
                    server=self.server,
                    token=self.token,
                    runtime_state=self._build_runtime_state_payload(),
                    timeout=2.5,
                )
            except Exception:
                pass

        if self._cloud_control is not None:
            gate = self._cloud_control.evaluate_start_gate(APP_VERSION)
            if not gate.get("allowed", True):
                reason = gate.get("block_reason") or "云控策略禁止启动发送"
                self.emit(f"⛔ [云控拦截] {reason.replace(chr(10), ' ')}", level="WARNING")
                self._notify_state_change()
                return {"success": False, "message": reason, "update_url": gate.get("update_url", "")}
            if gate.get("warning"):
                self.emit(f"⚠ [版本提醒] {gate['warning']}", level="WARNING")

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
            self.progress["sidebar_alert"] = None

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
                    self.emit(f"[{student}] 后台留言分析：{verdict_str}（最后消息：{last_msg or '无'}）")
                elif note.get("needs_reply") is None:
                    self.emit(f"[{student}] 后台留言分析：{verdict_str}（{last_msg or '无'}）")
                else:
                    self.emit(f"✓ [{student}] 后台留言分析：无需回复")

    def _run_worker(self, selected_ids: set, selected_count: int, total_count: int):
        """发送工作者主线程。"""
        self.emit(f"▶ 发送任务已就绪（本次将发送 {selected_count} 人，共 {total_count} 人，发送中按 ESC 可停止）")

        # 1. 执行真实的 3 秒倒计时
        for sec in (3, 2, 1):
            if self._stop_requested:
                self.emit("⏹ 倒计时期间收到停止请求，已取消发送。")
                self._finish_run(stopped=True, selected_ids=selected_ids)
                return
            with self._lock:
                self.progress["countdown"] = sec
                self.progress["step_text"] = f"3秒后即将开始发送（{sec}...），按ESC可取消"
            self.emit(f"距离开始发送还有 {sec} 秒，可随时按 ESC 键取消...")
            self._notify_state_change()
            time.sleep(1.0)

        with self._lock:
            self.progress["countdown"] = 0
            self.progress["step_text"] = "正在发送中..."
        self._notify_state_change()

        # 开跑前先统一将企微窗口向下还原、缩至最小极限尺寸并居中于当前屏幕，保证后续坐标恒定
        try:
            try:
                from sender_py import window_utils as wu
            except ModuleNotFoundError:
                import window_utils as wu
            wu.restore_and_center_wecom(log=self.emit)
        except Exception:
            pass

        processed = 0
        stopped = False
        sidebar_checked = False
        sidebar_stop_reason = ""
        config_path = default_config_path()
        roi_cache = {}

        try:
            for item in self.items:
                if item["_id"] not in selected_ids:
                    continue

                if self._stop_requested:
                    stopped = True
                    break

                cur_policy = self._cloud_control.get_policy() if self._cloud_control is not None else {}
                if cur_policy and not cur_policy.get("senderServiceEnabled", True):
                    self.emit("⛔ [云控停服] 管理员在发送过程中启用了全局暂停/单机锁定，已安全暂停并保持断点！", level="WARNING")
                    self._stop_requested = True
                    stopped = True
                    break

                eff_verify_mode = str(cur_policy.get("verifyMode") or "auto")
                eff_enable_reply = bool(cur_policy.get("enableReplyAnalysis", True))
                eff_snapshot_policy = str(cur_policy.get("snapshotPolicy") or "errors_only")
                eff_search_wait = float(cur_policy.get("searchWait", 1.5))
                eff_enter_wait = float(cur_policy.get("enterWait", 1.2))
                eff_break_every = max(1, int(cur_policy.get("batchBreakEvery", BATCH_BREAK_EVERY)))
                eff_break_gap = (
                    float(cur_policy.get("batchBreakMin", BATCH_BREAK_GAP[0])),
                    float(cur_policy.get("batchBreakMax", BATCH_BREAK_GAP[1])),
                )
                eff_student_gap = (
                    float(cur_policy.get("studentGapMin", STUDENT_GAP[0])),
                    float(cur_policy.get("studentGapMax", STUDENT_GAP[1])),
                )

                name = item.get("studentName", "")
                sid = item.get("sid", "")
                msg_len = len(item.get("message", ""))
                eff_files = self._get_effective_files(item)
                eff_send_mode = self.send_mode

                # 保护机制：如果当前学生已被标记为已发送，安全跳过
                if item.get("_status") == "已发送":
                    self.emit(f"[{name}] 该学生已发送成功，安全跳过，防止重复打扰家长")
                    continue

                with self._lock:
                    item["_status"] = "发送中"
                    item["_effective_files"] = eff_files
                    self.progress["current_name"] = name
                    self.progress["step_text"] = f"正在发送：{name} ({processed + 1}/{selected_count})"
                self._sync_runtime_context()
                self._notify_state_change()

                file_info_str = f" | 附件: {len(eff_files)} 个" if eff_files else ""
                self.emit(f"▶ 正在处理 [{processed + 1}/{selected_count}]: {name} (学号: {sid}) | 话术字数: {msg_len} 字{file_info_str}")

                try:
                    res = send_student(
                        item, self.server, self.token, config_path=config_path,
                        parent=None, log=self.emit,
                        should_stop=lambda: self._stop_requested,
                        reply_analyzer=self._reply_analyzer if eff_enable_reply else None,
                        verify_mode=eff_verify_mode,
                        search_wait=eff_search_wait,
                        enter_wait=eff_enter_wait,
                        enable_reply_analysis=eff_enable_reply,
                        snapshot_policy=eff_snapshot_policy,
                        check_sidebar=(not sidebar_checked),
                        roi_cache=roi_cache,
                        send_mode=eff_send_mode,
                        calibration_runner=getattr(self, "native_roi_calibrator", None),
                    )
                except Exception as exc:
                    res = {"result": "error", "reason": f"异常: {exc}", "notes": []}

                if res.get("sidebar_checked"):
                    sidebar_checked = True

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
                    "sidebar_open": "待发送",
                    "error": "发送失败",
                }
                status = status_map.get(result, "发送失败")

                with self._lock:
                    item["_status"] = status
                    item["_last_result"] = "paused" if result == "sidebar_open" else result
                    item["_last_reason"] = reason
                    if result == "sent":
                        # 成功发送后自动取消勾选并清除半成功标记
                        item["_selected"] = False
                        item["_text_sent"] = False
                    elif res.get("text_sent"):
                        # 文字已发但附件失败：记录半成功标记，重试时仅补发附件不重复发文字
                        item["_text_sent"] = True
                    if result not in ("stopped", "sidebar_open"):
                        processed += 1
                    self.progress["processed"] = processed

                item_key = item.get("_archive_key") or "反馈结果 [第 1 周]"
                if result == "sent":
                    try:
                        self.history.mark_status(item_key, name, "✅已发送", item.get("message", ""))
                    except Exception:
                        pass
                    self.emit(f"  ✓ [{name}] 状态更新：已发送")
                elif result == "blocked":
                    self.emit(f"  ✗ [{name}] 状态更新：已拦截（{reason}）")
                elif result == "unmatched":
                    self.emit(f"  ✗ [{name}] 状态更新：未匹配（{reason}）")
                elif result == "stopped":
                    self.emit(f"  ⏹ [{name}] 状态保持：已暂停（{reason}）")
                elif result == "sidebar_open":
                    self.emit(f"  ⛔ [{name}] {reason}", level="WARNING")
                    sidebar_stop_reason = reason
                else:
                    self.emit(f"  ✗ [{name}] 状态更新：发送失败（{reason}）")

                self._sync_runtime_context()
                self._notify_state_change()

                if result in ("stopped", "sidebar_open") or self._stop_requested:
                    stopped = True
                    break

                # 防风控延迟控制：读取云控每 N 人大停顿与学员间隔参数（默认每 15 人停 2~3 秒，其余停 0.5~1.0 秒）
                if processed < selected_count and not self._stop_requested:
                    if processed % eff_break_every == 0:
                        break_gap = random.uniform(*eff_break_gap)
                        self.emit(f"  已连续处理 {processed} 人，执行防风控停顿 {break_gap:.1f} 秒（按ESC可停止）...")
                        if not self._interruptible_pause(break_gap):
                            stopped = True
                            break
                    else:
                        gap = random.uniform(*eff_student_gap)
                        self.emit(f"  随机停顿 {gap:.1f} 秒，模拟人工打字节奏...")
                        if not self._interruptible_pause(gap):
                            stopped = True
                            break

        except Exception as exc:
            self.emit(f"发送任务异常中止：{exc}", level="ERROR", exc_info=exc)
            stopped = True
        finally:
            self._finish_run(stopped=stopped, selected_ids=selected_ids, sidebar_stop_reason=sidebar_stop_reason)

    def _wait_and_drain_reply_analyzer(self, timeout: float = 4.0):
        """等待在途后台留言分析任务短暂收尾并排空事件队列。"""
        analyzer = self._reply_analyzer
        if analyzer is not None:
            deadline = time.monotonic() + max(0.0, timeout)
            while time.monotonic() < deadline:
                self._drain_reply_events()
                try:
                    if analyzer.pending_count <= 0:
                        break
                except Exception:
                    break
                time.sleep(0.1)
        self._drain_reply_events()

    def _finish_run(self, stopped: bool, selected_ids: set, sidebar_stop_reason: str = ""):
        self._stop_esc_watcher()
        analyzer = self._reply_analyzer
        try:
            has_pending = analyzer is not None and analyzer.pending_count > 0
        except Exception:
            has_pending = False
        if has_pending:
            with self._lock:
                self.progress["step_text"] = "正在收尾后台留言分析..."
            self._notify_state_change()
        self._wait_and_drain_reply_analyzer(timeout=2.5 if stopped else 4.5)

        with self._lock:
            self._running = False
            self.progress["running"] = False
            self.progress["countdown"] = 0
            if stopped:
                if sidebar_stop_reason:
                    self.progress["step_text"] = "已停止发送：请先关闭企业微信右侧边栏"
                    self.progress["sidebar_alert"] = {
                        "id": int(time.time() * 1000),
                        "title": "请先关闭企业微信右侧边栏",
                        "message": sidebar_stop_reason,
                    }
                else:
                    self.progress["step_text"] = "已暂停发送，可点击“继续发送”继续"
                for it in self.items:
                    if it["_id"] in selected_ids and it.get("_status") in ("待发送", "发送中"):
                        it["_status"] = "待发送"
                        it["_last_result"] = "paused"
                        if sidebar_stop_reason and it.get("_last_reason"):
                            pass
                        else:
                            it["_last_reason"] = sidebar_stop_reason or "已暂停，可继续发送"
                        it["_selected"] = True
            else:
                self.progress["step_text"] = "发送完成"

        self._sync_runtime_context()
        self._record_sent_files_summary()

        counts = summarize_status_counts(it.get("_status", "") for it in self.items)
        title = "⏹ 已暂停" if stopped else "本批发送结束"
        if stopped:
            pending_count = sum(1 for it in self.items if it.get("_status") in ("待发送", "发送中"))
            explicit_skipped = max(0, counts["已跳过"] - pending_count)
            summary_msg = (
                f"{title}（共 {len(self.items)} 人）："
                f"成功 {counts['已发送']}，失败 {counts['发送失败']}，"
                f"拦截 {counts['已拦截']}，未匹配 {counts['未匹配']}，"
                f"跳过 {explicit_skipped}，待发 {pending_count}"
            )
        else:
            summary_msg = (
                f"{title}（共 {len(self.items)} 人）："
                f"成功 {counts['已发送']}，失败 {counts['发送失败']}，"
                f"拦截 {counts['已拦截']}，未匹配 {counts['未匹配']}，"
                f"跳过 {counts['已跳过']}"
            )
        self.emit(summary_msg)
        try:
            sync_batch_summary(self.items, input_paths=self.input_paths, stopped=stopped)
            flush_cloud_logs(timeout=2.0)
        except Exception:
            pass
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
                        self.emit(f"已保存文件 [{os.path.basename(path)}] 发送记录：{os.path.basename(rec.get('html_record', ''))}")
            elif self.items:
                any_sent = any(it.get("_status") == "已发送" for it in self.items)
                if any_sent:
                    rec = self.sent_files.record_sent_file("已发学生反馈.json", self.items)
                    self.emit(f"已保存本次发送记录：{os.path.basename(rec.get('html_record', ''))}")
        except Exception as exc:
            self.emit(f"记录已发文件失败：{exc}")

    # ================= 视野校准 =================

    def run_calibration(self) -> dict:
        """异步执行企业微信视野校准。"""
        if self._running:
            return {"success": False, "message": "正在发送中，无法校准视野"}

        self.emit("开始检测企业微信窗口视野...")
        try:
            try:
                from sender_py import window_utils as wu
            except ModuleNotFoundError:
                import window_utils as wu

            if not wu.find_and_activate_wecom():
                return {"success": False, "message": "未能激活企业微信窗口，请先打开企微。"}

            time.sleep(0.4)

            # 自动将企业微信向下还原并收缩至最小标准尺寸、居中于当前屏幕
            try:
                wu.restore_and_center_wecom(log=self.emit)
            except Exception as exc:
                self.emit(f"企微窗口居中整理提示：{exc}")

            rect = wu.get_wecom_rect()
            if not rect or rect[2] < 200 or rect[3] < 150:
                return {"success": False, "message": "未能获取有效的企微窗口尺寸，请确认企微未处于最小化。"}

            scale = wu.get_dpi_scale()

            # 优先检索并进入一个会话，确保企业微信右侧界面打开了具体的聊天界面
            sample_name = None
            with self._lock:
                if self.items:
                    sample_name = self.items[0].get("studentName")
            try:
                open_sample_chat_for_calibration(sample_name, log=self.emit)
            except Exception as exc:
                self.emit(f"预打开会话提示：{exc}")

            # 预打开会话后重新读取一次物理窗口矩形
            fresh_rect = wu.get_wecom_rect()
            if fresh_rect and fresh_rect[2] >= 200 and fresh_rect[3] >= 150:
                rect = fresh_rect
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

            if self._cloud_control is not None and not self._cloud_control.is_auto_calibration_enabled():
                msg = "云控策略已关闭 AI 自动窗口校准，请点击【手动框选视野】完成框选。"
                self.emit(f"ℹ️ {msg}")
                return {"success": False, "message": msg}

            self.emit("  └ 正在通过云端多模态大模型自动智能框选...")
            ai_err_details = []
            try:
                ai_roi = calibrate_roi(img, server=self.server, token=self.token, error_out=ai_err_details)
            except TypeError:
                ai_roi = calibrate_roi(img, server=self.server, token=self.token)

            if ai_roi and isinstance(ai_roi, dict) and all(k in ai_roi for k in ("title", "input", "chat")):
                if all(validate_rel(ai_roi[k]) for k in ("title", "input", "chat")):
                    key = signature_key(rect[2], rect[3], scale)
                    save_roi(default_config_path(), key, ai_roi["title"], ai_roi["input"], ai_roi["chat"])
                    msg = f"✓ 智能校准成功（{ai_roi.get('reason', 'AI框选生效')}），企业微信视野配置已自动保存！"
                    self.emit(msg)
                    return {"success": True, "message": msg}

            detail = f"（{ai_err_details[-1]}）" if ai_err_details else "（可能未点进具体聊天）"
            return {"success": False, "message": f"AI 自动定位未通过{detail}，建议打开聊天界面后重试。"}
        except Exception as exc:
            err = f"视野校准异常：{exc}"
            self.emit(f"✗ {err}")
            return {"success": False, "message": err}

    def restore_and_center_wecom(self) -> dict:
        """手动请求将企业微信向下还原、缩至最小极限尺寸并居中于当前屏幕。"""
        self.emit("正在将企业微信窗口恢复为向下还原状态并居中...")
        try:
            try:
                from sender_py import window_utils as wu
            except ModuleNotFoundError:
                import window_utils as wu
            ok, res = wu.restore_and_center_wecom(log=self.emit)
            if ok:
                msg = f"✓ 企微窗口已恢复为标准最小尺寸 ({res[2]}x{res[3]}) 并已在屏幕居中"
                self.emit(msg)
                return {"success": True, "rect": res, "message": msg}
            return {"success": False, "message": str(res)}
        except Exception as exc:
            err = f"企微窗口居中异常：{exc}"
            self.emit(f"✗ {err}")
            return {"success": False, "message": err}

    def update_teacher_note(self, note: str) -> dict:
        """保存老师姓名/备注并立即同步到日志上下文。"""
        clean_note = set_teacher_note(note)
        ident = get_client_identity()
        if clean_note:
            self.emit(f"已更新老师备注为：{clean_note}（设备标识：{ident.get('hostname', '')}）")
        else:
            self.emit(f"已清除老师备注，恢复默认设备标识：{ident.get('display_name', '')}")
        self._notify_state_change()
        return {"success": True, "teacher_note": clean_note, "client": ident}

    # ================= 状态序列化 =================

    def get_state(self) -> dict:
        """获取当前完整状态供前端渲染。"""
        ident = {}
        sync_status = {}
        try:
            ident = get_client_identity()
            sync_status = get_cloud_sync_status()
        except Exception:
            pass
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
                    "files": [
                        {"path": p, "name": os.path.basename(p)}
                        for p in (it.get("files") or [])
                    ],
                    "effective_files_count": len(self._get_effective_files(it)),
                    "text_sent": bool(it.get("_text_sent", False)),
                    "status": it.get("_status", "待发送"),
                    "last_reason": it.get("_last_reason", ""),
                    "selected": it.get("_selected", True),
                    "archive_key": it.get("_archive_key", ""),
                }
                for it in self.items
            ]
            global_files_list = [
                {"path": p, "name": os.path.basename(p)}
                for p in self.global_attachments
            ]
            matched_students_count = sum(1 for it in self.items if it.get("files"))
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
                    "matched_attachments": matched_students_count,
                },
                "files": files_list,
                "global_attachments": global_files_list,
                "send_mode": self.send_mode,
                "default_file_message": self.default_file_message,
                "duplicate_count": self.duplicate_count,
                "students": students_list,
                "reply_notes_count": len(actionable(self.reply_notes)),
                "logs_count": len(self.logs),
                "teacher_note": ident.get("teacher_note", ""),
                "client_identity": ident,
                "cloud_sync": sync_status,
                "app_version": APP_VERSION,
                "cloud_control": self._cloud_control.get_snapshot_state(APP_VERSION) if self._cloud_control else {},
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

            if not items_to_run and self.items:
                items_to_run = list(self.items)

            if not items_to_run:
                return {"success": False, "message": "当前暂无学生数据，请先加载反馈文件"}

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
        self.emit(f"▶ [多引擎评测] 开始基准评测（共 {total} 人，全程只识别不发送，按 ESC 随时停止）")
        self._start_esc_watcher()

        # 评测开始前统一将企微窗口向下还原并居中，保证坐标稳定
        try:
            try:
                from sender_py import window_utils as wu
            except ModuleNotFoundError:
                import window_utils as wu
            wu.restore_and_center_wecom(log=self.emit)
        except Exception:
            pass

        try:
            try:
                from sender_py.benchmark import benchmark_single_student, compute_benchmark_summary
                from sender_py.roi_manager import default_config_path
            except ModuleNotFoundError:
                from benchmark import benchmark_single_student, compute_benchmark_summary
                from roi_manager import default_config_path

            records = []
            config_path = default_config_path()
            roi_cache = {}

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

                self.emit(f"▶ [{idx}/{total}] 正在全仿真比对联系人: {name}...")
                res = benchmark_single_student(
                    item,
                    self.server,
                    self.token,
                    config_path=config_path,
                    log=self.emit,
                    should_stop=lambda: self._benchmark_stop_requested,
                    roi_cache=roi_cache,
                )

                if res.get("record"):
                    rec = res["record"]
                    records.append(rec)
                    with self._lock:
                        self.benchmark_state["records"] = list(records)
                        self.benchmark_state["summary"] = compute_benchmark_summary(records)
                    self._notify_state_change()
                else:
                    reason = res.get("reason", "")
                    self.emit(f"  ✗ [{name}] 未能获取有效评测数据：{reason}")
                    if reason in ("ROI 校准未完成", "ROI 未校准", "用户停止"):
                        self.emit("⏹ 视野校准已放弃或用户终止，基准评测已停止。")
                        break

                time.sleep(0.4)

            summary = compute_benchmark_summary(records)
            with self._lock:
                self.benchmark_state["summary"] = summary
                self.benchmark_state["progress"]["step_text"] = "评测已完成"
            self._notify_state_change()

            self.emit(f"[多引擎评测] 评测任务全部完成！共测试 {len(records)} 人，发现分歧 {summary.get('discrepancy_count', 0)} 例。")
        except Exception as exc:
            self.emit(f"✗ [多引擎评测] 运行异常: {exc}", level="ERROR", exc_info=exc)
        finally:
            with self._lock:
                self.benchmark_state["running"] = False
            self._stop_esc_watcher()
            self._notify_state_change()
