"""本地日志文件持久化、错误/警告分流记录与云端自动双轨同步模块。

将运行日志、警告和错误日志保存至本地 (~/.sender_py/logs/)，
支持日志分流（常规运行流 + 专属错误警告流）、历史日志定期清理，
并通过后台守护线程自动将实时日志、历史未同步 .log 文件及批次汇总同步至服务端。
"""

import datetime
import getpass
import hashlib
import json
import os
import platform
import queue
import re
import socket
import threading
import time
import traceback
from typing import Dict, List, Optional, Tuple

try:
    from sender_py.store import default_storage_base_dir, open_folder_or_file
    from sender_py.cloud_control import CONTROL_PULL_PATH, get_cloud_control_manager
except ModuleNotFoundError:
    from store import default_storage_base_dir, open_folder_or_file
    from cloud_control import CONTROL_PULL_PATH, get_cloud_control_manager


_LOG_LOCK = threading.RLock()
_CONFIG_LOCK = threading.RLock()

SYNC_LOG_PATH = "/api/logs.php?action=sender_sync"
SYNC_SNAPSHOT_PATH = "/api/logs.php?action=sender_snapshot"
DEFAULT_SERVER_URL = "https://feedback.wxjifang.cn"
APP_VERSION_STR = "2.0.3"


def get_logs_dir(base_dir: Optional[str] = None) -> str:
    """获取并确保日志目录存在 (~/.sender_py/logs)。"""
    base = base_dir or default_storage_base_dir()
    logs_dir = os.path.join(base, "logs")
    os.makedirs(logs_dir, exist_ok=True)
    return logs_dir


def _get_config_path(base_dir: Optional[str] = None) -> str:
    base = base_dir or default_storage_base_dir()
    os.makedirs(base, exist_ok=True)
    return os.path.join(base, "config.json")


def get_teacher_note(base_dir: Optional[str] = None) -> str:
    """读取本地保存的老师姓名/备注（位于 ~/.sender_py/config.json 的 teacher_note 字段）。"""
    cfg_path = _get_config_path(base_dir)
    with _CONFIG_LOCK:
        try:
            if os.path.isfile(cfg_path):
                with open(cfg_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    return str(data.get("teacher_note") or "").strip()
        except Exception:
            pass
    return ""


def set_teacher_note(note: str, base_dir: Optional[str] = None) -> str:
    """保存老师姓名/备注到 ~/.sender_py/config.json，保留已有的 token 等字段。"""
    clean_note = str(note or "").strip()[:40]
    cfg_path = _get_config_path(base_dir)
    with _CONFIG_LOCK:
        data = {}
        try:
            if os.path.isfile(cfg_path):
                with open(cfg_path, "r", encoding="utf-8") as f:
                    loaded = json.load(f)
                if isinstance(loaded, dict):
                    data = loaded
        except Exception:
            data = {}
        data["teacher_note"] = clean_note
        try:
            with open(cfg_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception:
            pass
    _SYNCER.update_context(teacher_note=clean_note)
    return clean_note


def get_client_identity(base_dir: Optional[str] = None) -> dict:
    """自动采集客户端机器标识与老师备注信息。"""
    try:
        hostname = socket.gethostname() or platform.node() or "UnknownPC"
    except Exception:
        hostname = "UnknownPC"
    try:
        os_user = getpass.getuser() or os.environ.get("USERNAME") or os.environ.get("USER") or "user"
    except Exception:
        os_user = os.environ.get("USERNAME") or os.environ.get("USER") or "user"

    raw_key = f"{hostname.strip().lower()}:{os_user.strip().lower()}"
    short_hash = hashlib.md5(raw_key.encode("utf-8", errors="ignore")).hexdigest()[:8]

    def _safe_slug(s: str) -> str:
        cleaned = "".join(c if (c.isalnum() or c in ("-", "_")) else "_" for c in str(s or "").strip())
        cleaned = cleaned.strip("_")
        return cleaned[:32] or "pc"

    client_slug = f"{_safe_slug(hostname)}_{_safe_slug(os_user)}_{short_hash}"
    teacher_note = get_teacher_note(base_dir)
    if not teacher_note and _SYNCER.teacher_note:
        teacher_note = _SYNCER.teacher_note

    if teacher_note:
        display_name = f"{teacher_note} ({hostname}/{os_user})"
        operator_name = f"{teacher_note}@{hostname}"
    else:
        display_name = f"{hostname} ({os_user})"
        operator_name = f"{hostname}({os_user})"

    return {
        "client_id": short_hash,
        "client_slug": client_slug,
        "hostname": hostname,
        "os_user": os_user,
        "teacher_note": teacher_note,
        "display_name": display_name,
        "operator": operator_name[:60],
        "platform": f"{platform.system()} {platform.release()}",
        "app_version": APP_VERSION_STR,
    }


def detect_log_level(msg: str) -> str:
    """根据日志消息关键字与图标智能识别级别。"""
    msg_str = str(msg)
    if "本批发送结束" in msg_str or "已暂停（共" in msg_str:
        fail_m = re.search(r"失败\s*(\d+)", msg_str)
        block_m = re.search(r"拦截\s*(\d+)", msg_str)
        unmatch_m = re.search(r"未匹配\s*(\d+)", msg_str)
        if fail_m and int(fail_m.group(1)) > 0:
            return "ERROR"
        if (block_m and int(block_m.group(1)) > 0) or (unmatch_m and int(unmatch_m.group(1)) > 0):
            return "WARNING"
        return "INFO"

    error_keywords = ("❌", "✗", "[ERROR]", "[CRITICAL]", "错误", "失败", "异常", "Traceback", "Exception")
    for kw in error_keywords:
        if kw in msg_str:
            return "ERROR"

    warn_keywords = ("⚠️", "▲", "[WARN]", "[WARNING]", "警告", "未匹配", "拦截", "跳过", "超时")
    for kw in warn_keywords:
        if kw in msg_str:
            return "WARNING"

    return "INFO"


def classify_log_event(clean_msg: str, eff_level: str) -> Tuple[str, str]:
    """将客户端日志映射为服务端审计日志的 (level, event)。

    服务端 system_logs 支持的 level: 'error' | 'warn' | 'action' | 'info'
    """
    s = str(clean_msg or "")
    lvl_upper = (eff_level or "INFO").upper()

    if "状态更新：已发送" in s:
        return "action", "student_sent"
    if "状态更新：已拦截" in s or "群聊拦截" in s:
        return "warn", "student_blocked"
    if "状态更新：未匹配" in s:
        return "warn", "student_unmatched"
    if "状态更新：发送失败" in s:
        return "error", "student_send_failed"
    if "本批发送结束" in s or "已暂停（共" in s:
        return "action", "batch_finished"
    if "发送任务已就绪" in s:
        return "action", "batch_started"
    if "智能校准成功" in s or "手动校准已保存" in s:
        return "action", "roi_calibrated"
    if "开始检测企业微信窗口视野" in s:
        return "info", "roi_calibrate_start"
    if "成功载入" in s and "位学员" in s:
        return "action", "files_loaded"
    if "后台留言分析" in s:
        return "info", "reply_analyzed"
    if "[多引擎评测]" in s:
        return "action" if "完成" in s or "开始" in s else "info", "ocr_benchmark"

    if lvl_upper in ("ERROR", "CRITICAL"):
        return "error", "sender_error"
    if lvl_upper in ("WARNING", "WARN"):
        return "warn", "sender_warn"
    return "info", "sender_log"


def _clean_raw_msg(msg: str) -> str:
    """去除可能已有的旧时间戳前缀，保持文件记录格式整洁统一。"""
    s = str(msg).strip()
    # 形如 "[10:20:30] xxx"
    if len(s) >= 10 and s.startswith("[") and s[3] == ":" and s[6] == ":" and s[9] == "]":
        s = s[10:].strip()
    return s


def _resolve_token(explicit_token: Optional[str] = None) -> str:
    if explicit_token:
        return explicit_token
    try:
        try:
            from sender_py.vision_api import load_token
        except ModuleNotFoundError:
            from vision_api import load_token
        return load_token()
    except Exception:
        return "jf_feedback_sender_internal_token_2026"


def _post_json_to_server(server: str, path: str, payload: dict, timeout: float = 8.0) -> Optional[dict]:
    """向服务端发送 JSON POST 请求，任何异常静默返回 None。"""
    server_clean = (server or "").strip().rstrip("/")
    if not server_clean.startswith(("http://", "https://")):
        return None
    url = server_clean + path
    try:
        import requests
        resp = requests.post(url, json=payload, timeout=timeout)
        if resp.status_code == 200:
            data = resp.json()
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return None


def _apply_cloud_control_response(res: Optional[dict], sent_acks: Optional[list] = None) -> bool:
    """消费服务端返回的 cloud_control 策略/指令载荷并确认已送达的回执。"""
    if not (isinstance(res, dict) and res.get("success")):
        return False
    mgr = get_cloud_control_manager()
    if sent_acks:
        mgr.confirm_acks_sent(sent_acks)
    data = res.get("data")
    if isinstance(data, dict) and isinstance(data.get("cloud_control"), dict):
        mgr.apply_server_payload(data["cloud_control"])
    return True


class CloudLogSyncer:
    """后台非阻塞云端日志同步器。"""

    BATCH_SIZE = 20
    FLUSH_INTERVAL = 2.0
    HEARTBEAT_INTERVAL = 12.0
    MAX_QUEUE_SIZE = 2000
    MAX_CHUNK_BYTES = 45000

    def __init__(self):
        self.enabled = False
        self.server = DEFAULT_SERVER_URL
        self.token = ""
        self.active_files: List[str] = []
        self.teacher_note: str = ""
        self.base_dir: Optional[str] = None
        self.runtime_state: Optional[dict] = None

        self._queue: queue.Queue = queue.Queue(maxsize=self.MAX_QUEUE_SIZE)
        self._lock = threading.RLock()
        self._worker: Optional[threading.Thread] = None
        self._last_sync_ok: Optional[bool] = None
        self._last_sync_time: str = ""
        self._synced_count: int = 0

    def update_context(
        self,
        server: Optional[str] = None,
        token: Optional[str] = None,
        active_files: Optional[List[str]] = None,
        teacher_note: Optional[str] = None,
        base_dir: Optional[str] = None,
        enabled: Optional[bool] = None,
        runtime_state: Optional[dict] = None,
    ):
        with self._lock:
            if server is not None:
                self.server = server.strip().rstrip("/") or DEFAULT_SERVER_URL
            if token is not None:
                self.token = token
            if active_files is not None:
                self.active_files = [os.path.basename(str(p)) for p in active_files if p]
            if teacher_note is not None:
                self.teacher_note = str(teacher_note).strip()
            if base_dir is not None:
                self.base_dir = base_dir
            if runtime_state is not None:
                self.runtime_state = dict(runtime_state) if isinstance(runtime_state, dict) else None
            if enabled is not None:
                self.enabled = bool(enabled)
            if self.enabled:
                self._ensure_worker_started()

    def _ensure_worker_started(self):
        if self._worker is None or not self._worker.is_alive():
            self._worker = threading.Thread(target=self._run_loop, name="CloudLogSyncer", daemon=True)
            self._worker.start()

    def get_status(self) -> dict:
        with self._lock:
            return {
                "enabled": self.enabled,
                "server": self.server,
                "last_sync_ok": self._last_sync_ok,
                "last_sync_time": self._last_sync_time,
                "synced_count": self._synced_count,
                "pending_count": self._queue.qsize(),
            }

    def enqueue_entry(self, entry: dict):
        if not self.enabled:
            return
        try:
            self._queue.put_nowait(("entry", entry))
            self._ensure_worker_started()
        except queue.Full:
            pass

    def enqueue_batch_summary(self, summary: dict):
        if not self.enabled:
            return
        try:
            self._queue.put_nowait(("batch_summary", summary))
            self._ensure_worker_started()
        except queue.Full:
            pass

    def trigger_history_sync(self, base_dir: Optional[str] = None):
        if not self.enabled:
            return
        try:
            self._queue.put_nowait(("history_sync", base_dir or self.base_dir))
            self._ensure_worker_started()
        except queue.Full:
            pass

    def _run_loop(self):
        buffer_entries: List[dict] = []
        last_flush = time.monotonic()
        last_heartbeat = time.monotonic() - self.HEARTBEAT_INTERVAL  # 启动后尽快拉取一次云控

        while True:
            timeout = max(0.1, self.FLUSH_INTERVAL - (time.monotonic() - last_flush))
            try:
                item = self._queue.get(timeout=timeout)
                kind, payload = item
                if kind == "entry":
                    buffer_entries.append(payload)
                    if len(buffer_entries) >= self.BATCH_SIZE:
                        if self._send_entries(buffer_entries):
                            last_heartbeat = time.monotonic()
                        buffer_entries = []
                        last_flush = time.monotonic()
                elif kind == "batch_summary":
                    if buffer_entries:
                        self._send_entries(buffer_entries)
                        buffer_entries = []
                        last_flush = time.monotonic()
                    if self._send_batch_summary(payload):
                        last_heartbeat = time.monotonic()
                elif kind == "history_sync":
                    if buffer_entries:
                        self._send_entries(buffer_entries)
                        buffer_entries = []
                        last_flush = time.monotonic()
                    sync_unsynced_log_files(base_dir=payload, server=self.server, token=self.token)
                    last_heartbeat = time.monotonic()
                elif kind == "flush_signal":
                    if buffer_entries:
                        if self._send_entries(buffer_entries):
                            last_heartbeat = time.monotonic()
                        buffer_entries = []
                        last_flush = time.monotonic()
                    if isinstance(payload, threading.Event):
                        payload.set()
            except queue.Empty:
                if buffer_entries:
                    if self._send_entries(buffer_entries):
                        last_heartbeat = time.monotonic()
                    buffer_entries = []
                elif (time.monotonic() - last_heartbeat) >= self.HEARTBEAT_INTERVAL:
                    self._send_heartbeat()
                    last_heartbeat = time.monotonic()
                last_flush = time.monotonic()
            except Exception:
                buffer_entries = []
                last_flush = time.monotonic()

    def _build_common_payload(self, base_dir: Optional[str] = None) -> dict:
        eff_base = base_dir or self.base_dir
        ident = get_client_identity(eff_base)
        tok = _resolve_token(self.token)
        with self._lock:
            active_files = list(self.active_files)
            server = self.server
            runtime_state = dict(self.runtime_state) if isinstance(self.runtime_state, dict) else None
        acks = get_cloud_control_manager().peek_pending_acks()
        payload = {
            "token": tok,
            "client": ident,
            "active_files": active_files,
            "_server": server,
            "_base_dir": eff_base,
            "_acks": acks,
        }
        if acks:
            payload["ack_commands"] = acks
        if runtime_state is not None:
            payload["runtime_state"] = runtime_state
        return payload

    def _send_heartbeat(self) -> bool:
        common = self._build_common_payload()
        server = common.pop("_server")
        common.pop("_base_dir", None)
        acks = common.pop("_acks", [])

        payload = {
            **common,
            "sync_mode": "heartbeat",
            "date_str": datetime.datetime.now().strftime("%Y-%m-%d"),
        }
        res = _post_json_to_server(server, SYNC_LOG_PATH, payload, timeout=6.0)
        ok = _apply_cloud_control_response(res, sent_acks=acks)
        with self._lock:
            self._last_sync_ok = ok
            if ok:
                self._last_sync_time = datetime.datetime.now().strftime("%H:%M:%S")
        return ok

    def _send_entries(self, entries: List[dict]) -> bool:
        if not entries:
            return True
        base_dir = entries[-1].get("_base_dir") or self.base_dir
        common = self._build_common_payload(base_dir)
        server = common.pop("_server")
        eff_base = common.pop("_base_dir")
        acks = common.pop("_acks", [])

        clean_entries = []
        dates_touched = set()
        for e in entries:
            ec = dict(e)
            ec.pop("_base_dir", None)
            clean_entries.append(ec)
            if ec.get("date_str"):
                dates_touched.add(ec["date_str"])

        payload = {
            **common,
            "sync_mode": "realtime",
            "entries": clean_entries,
        }
        res = _post_json_to_server(server, SYNC_LOG_PATH, payload, timeout=8.0)
        ok = _apply_cloud_control_response(res, sent_acks=acks)
        with self._lock:
            self._last_sync_ok = ok
            if ok:
                self._last_sync_time = datetime.datetime.now().strftime("%H:%M:%S")
                self._synced_count += len(clean_entries)

        if ok and dates_touched:
            # 实时日志已追加到服务端，更新对应本地日志文件的已同步偏移量，防止下次启动重复补传
            _mark_local_files_synced_to_current_size(dates_touched, eff_base)
        return ok

    def _send_batch_summary(self, summary: dict) -> bool:
        common = self._build_common_payload(summary.get("_base_dir"))
        server = common.pop("_server")
        common.pop("_base_dir", None)
        acks = common.pop("_acks", [])

        clean_summary = dict(summary)
        clean_summary.pop("_base_dir", None)

        payload = {
            **common,
            "sync_mode": "batch_summary",
            "batch_summary": clean_summary,
        }
        res = _post_json_to_server(server, SYNC_LOG_PATH, payload, timeout=10.0)
        ok = _apply_cloud_control_response(res, sent_acks=acks)
        with self._lock:
            self._last_sync_ok = ok
            if ok:
                self._last_sync_time = datetime.datetime.now().strftime("%H:%M:%S")
        return ok

    def flush(self, timeout: float = 2.5):
        if not self.enabled or self._worker is None or not self._worker.is_alive():
            return
        done_evt = threading.Event()
        try:
            self._queue.put_nowait(("flush_signal", done_evt))
            done_evt.wait(timeout=max(0.1, timeout))
        except Exception:
            pass


_SYNCER = CloudLogSyncer()


def update_log_context(
    server: Optional[str] = None,
    token: Optional[str] = None,
    active_files: Optional[List[str]] = None,
    teacher_note: Optional[str] = None,
    base_dir: Optional[str] = None,
    enabled: Optional[bool] = None,
    runtime_state: Optional[dict] = None,
):
    """更新云端日志同步器的上下文配置。"""
    _SYNCER.update_context(
        server=server,
        token=token,
        active_files=active_files,
        teacher_note=teacher_note,
        base_dir=base_dir,
        enabled=enabled,
        runtime_state=runtime_state,
    )


def pull_cloud_control(
    server: Optional[str] = None,
    token: Optional[str] = None,
    base_dir: Optional[str] = None,
    runtime_state: Optional[dict] = None,
    timeout: float = 4.0,
) -> Optional[dict]:
    """主动从服务端拉取最新有效云控策略及待执行远程指令。"""
    eff_server = (server or _SYNCER.server or DEFAULT_SERVER_URL).strip().rstrip("/")
    eff_token = _resolve_token(token if token is not None else _SYNCER.token)
    eff_base = base_dir or _SYNCER.base_dir
    ident = get_client_identity(eff_base)
    mgr = get_cloud_control_manager()
    acks = mgr.peek_pending_acks()
    with _SYNCER._lock:
        active_files = list(_SYNCER.active_files)
        eff_runtime = runtime_state if runtime_state is not None else (
            dict(_SYNCER.runtime_state) if isinstance(_SYNCER.runtime_state, dict) else None
        )

    payload = {
        "token": eff_token,
        "client": ident,
        "active_files": active_files,
    }
    if acks:
        payload["ack_commands"] = acks
    if eff_runtime is not None:
        payload["runtime_state"] = eff_runtime

    res = _post_json_to_server(eff_server, CONTROL_PULL_PATH, payload, timeout=timeout)
    if _apply_cloud_control_response(res, sent_acks=acks):
        with _SYNCER._lock:
            _SYNCER._last_sync_ok = True
            _SYNCER._last_sync_time = datetime.datetime.now().strftime("%H:%M:%S")
        return res.get("data", {}).get("cloud_control")
    mgr.mark_sync_error("云控策略拉取超时或网络不可达")
    return None


def get_cloud_sync_status() -> dict:
    """获取当前云端日志同步状态。"""
    return _SYNCER.get_status()


def flush_cloud_logs(timeout: float = 2.5):
    """等待后台队列中的日志立即同步至服务端。"""
    _SYNCER.flush(timeout=timeout)


def _get_sync_state_path(base_dir: Optional[str] = None) -> str:
    logs_dir = get_logs_dir(base_dir)
    return os.path.join(logs_dir, ".sync_state.json")


def _load_sync_state(base_dir: Optional[str] = None) -> Dict[str, int]:
    state_path = _get_sync_state_path(base_dir)
    try:
        if os.path.isfile(state_path):
            with open(state_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return {str(k): int(v) for k, v in data.items() if isinstance(v, (int, float))}
    except Exception:
        pass
    return {}


def _save_sync_state(state: Dict[str, int], base_dir: Optional[str] = None):
    state_path = _get_sync_state_path(base_dir)
    try:
        with open(state_path, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def _mark_local_files_synced_to_current_size(dates: set, base_dir: Optional[str] = None):
    """当实时同步成功且本地文件此前已同步完毕时，推进偏移量到最新大小。"""
    logs_dir = get_logs_dir(base_dir)
    with _LOG_LOCK:
        state = _load_sync_state(base_dir)
        changed = False
        for d in dates:
            for prefix in ("sender_", "error_"):
                fname = f"{prefix}{d}.log"
                fpath = os.path.join(logs_dir, fname)
                if os.path.isfile(fpath):
                    try:
                        sz = os.path.getsize(fpath)
                        state[fname] = sz
                        changed = True
                    except Exception:
                        pass
        if changed:
            _save_sync_state(state, base_dir)


def sync_unsynced_log_files(
    base_dir: Optional[str] = None,
    server: Optional[str] = None,
    token: Optional[str] = None,
    max_days: int = 7,
) -> int:
    """扫描本地最近 max_days 天的 .log 文件，将尚未同步的增量字节补传至服务端。

    返回成功补传的文件数量。
    """
    logs_dir = get_logs_dir(base_dir)
    if not os.path.isdir(logs_dir):
        return 0

    eff_server = (server or _SYNCER.server or DEFAULT_SERVER_URL).strip().rstrip("/")
    eff_token = _resolve_token(token or _SYNCER.token)
    ident = get_client_identity(base_dir)
    cutoff = datetime.datetime.now() - datetime.timedelta(days=max_days)

    with _LOG_LOCK:
        state = _load_sync_state(base_dir)
        try:
            names = sorted(os.listdir(logs_dir))
        except Exception:
            return 0

    synced_files = 0
    state_changed = False

    for fname in names:
        if not fname.endswith(".log") or not (fname.startswith("sender_") or fname.startswith("error_")):
            continue
        date_part = fname.replace("sender_", "").replace("error_", "").replace(".log", "")
        if len(date_part) != 10:
            continue
        fpath = os.path.join(logs_dir, fname)
        try:
            stat = os.stat(fpath)
            if datetime.datetime.fromtimestamp(stat.st_mtime) < cutoff:
                continue
            file_size = stat.st_size
        except Exception:
            continue

        prev_offset = state.get(fname, 0)
        if prev_offset < 0 or prev_offset > file_size:
            prev_offset = 0
        if file_size <= prev_offset:
            continue

        log_type = "error" if fname.startswith("error_") else "sender"
        cur_offset = prev_offset
        file_ok = True

        try:
            with open(fpath, "rb") as f:
                f.seek(cur_offset)
                while cur_offset < file_size:
                    raw_bytes = f.read(CloudLogSyncer.MAX_CHUNK_BYTES)
                    if not raw_bytes:
                        break
                    chunk_text = raw_bytes.decode("utf-8", errors="replace")
                    payload = {
                        "token": eff_token,
                        "sync_mode": "chunk",
                        "client": ident,
                        "active_files": list(_SYNCER.active_files),
                        "date_str": date_part,
                        "log_type": log_type,
                        "filename": fname,
                        "offset": cur_offset,
                        "content": chunk_text,
                    }
                    res = _post_json_to_server(eff_server, SYNC_LOG_PATH, payload, timeout=10.0)
                    if not _apply_cloud_control_response(res):
                        file_ok = False
                        break
                    cur_offset += len(raw_bytes)
                    state[fname] = cur_offset
                    state_changed = True
        except Exception:
            file_ok = False

        if file_ok and cur_offset >= file_size:
            synced_files += 1

    if state_changed:
        with _LOG_LOCK:
            _save_sync_state(state, base_dir)

    return synced_files


def sync_batch_summary(
    items: list,
    input_paths: Optional[ list ] = None,
    stopped: bool = False,
    base_dir: Optional[str] = None,
    immediate: bool = False,
) -> Optional[dict]:
    """构建并上报单批次发送完成后的结果汇总（含学生状态明细，不含长篇反馈话术正文）。"""
    now = datetime.datetime.now()
    date_str = now.strftime("%Y-%m-%d")
    time_str = now.strftime("%Y-%m-%d %H:%M:%S")
    files_names = [os.path.basename(str(p)) for p in (input_paths or []) if p]

    counts = {
        "total": 0,
        "sent": 0,
        "failed": 0,
        "blocked": 0,
        "unmatched": 0,
        "skipped": 0,
        "pending": 0,
    }
    student_details = []
    for it in (items or []):
        if not isinstance(it, dict):
            continue
        counts["total"] += 1
        st = str(it.get("_status") or it.get("status") or "待发送")
        if st == "已发送":
            counts["sent"] += 1
        elif st == "发送失败":
            counts["failed"] += 1
        elif st == "已拦截":
            counts["blocked"] += 1
        elif st == "未匹配":
            counts["unmatched"] += 1
        elif st == "已跳过":
            counts["skipped"] += 1
        else:
            counts["pending"] += 1

        student_details.append({
            "sid": str(it.get("sid") or ""),
            "sname": str(it.get("sname") or ""),
            "studentName": str(it.get("studentName") or ""),
            "status": st,
            "reason": str(it.get("_last_reason") or it.get("last_reason") or "")[:160],
        })

    summary_payload = {
        "timestamp": int(time.time() * 1000),
        "date_str": date_str,
        "sent_time": time_str,
        "stopped": bool(stopped),
        "files": files_names,
        "counts": counts,
        "students": student_details[:300],
        "_base_dir": base_dir,
    }

    if immediate:
        return _SYNCER._send_batch_summary(summary_payload)
    _SYNCER.enqueue_batch_summary(summary_payload)
    return summary_payload


def write_log(
    msg: str,
    level: Optional[str] = None,
    exc_info: Optional[object] = None,
    base_dir: Optional[str] = None,
    sync_cloud: Optional[bool] = None,
) -> Tuple[str, str]:
    """将日志写入本地文件，并在启用云端同步时推入后台同步队列。

    所有日志写入 sender_YYYY-MM-DD.log；
    错误与警告同时分流写入 error_YYYY-MM-DD.log。
    """
    now = datetime.datetime.now()
    date_str = now.strftime("%Y-%m-%d")
    time_str = now.strftime("%Y-%m-%d %H:%M:%S")
    ts_ms = int(now.timestamp() * 1000)

    clean_msg = _clean_raw_msg(msg)
    eff_level = (level or detect_log_level(clean_msg)).upper()

    log_entry = f"[{time_str}] [{eff_level}] {clean_msg}\n"

    # 如果有异常信息，追加堆栈
    tb_text = ""
    if exc_info:
        if isinstance(exc_info, BaseException):
            tb_text = "".join(traceback.format_exception(type(exc_info), exc_info, exc_info.__traceback__)).rstrip()
        elif isinstance(exc_info, str):
            tb_text = exc_info.rstrip()
        elif exc_info is True:
            tb = traceback.format_exc()
            if tb and tb.strip() != "NoneType: None":
                tb_text = tb.rstrip()
        if tb_text:
            log_entry += tb_text + "\n"

    logs_dir = get_logs_dir(base_dir)
    all_log_path = os.path.join(logs_dir, f"sender_{date_str}.log")
    err_log_path = os.path.join(logs_dir, f"error_{date_str}.log")
    is_error = eff_level in ("ERROR", "WARNING", "CRITICAL")

    with _LOG_LOCK:
        try:
            with open(all_log_path, "a", encoding="utf-8") as f:
                f.write(log_entry)
        except Exception:
            pass

        # 错误或警告分流写入专属错误日志文件
        if is_error:
            try:
                with open(err_log_path, "a", encoding="utf-8") as f:
                    f.write(log_entry)
            except Exception:
                pass

    # 判断是否需要推入云端队列：默认仅当 _SYNCER.enabled 且未指定独立测试 base_dir（或显式 sync_cloud=True）时上报
    should_sync = sync_cloud if sync_cloud is not None else (_SYNCER.enabled and base_dir is None)
    if should_sync:
        sys_level, sys_event = classify_log_event(clean_msg, eff_level)
        _SYNCER.enqueue_entry({
            "timestamp": ts_ms,
            "date_str": date_str,
            "time_str": time_str,
            "level": eff_level,
            "sys_level": sys_level,
            "event": sys_event,
            "message": clean_msg,
            "traceback": tb_text,
            "raw_line": log_entry,
            "is_error": is_error,
            "_base_dir": base_dir,
        })

    return all_log_path, err_log_path


def list_log_files(base_dir: Optional[str] = None) -> List[dict]:
    """返回日志目录下所有日志文件元数据列表，按最后修改时间倒序排列。"""
    logs_dir = get_logs_dir(base_dir)
    if not os.path.isdir(logs_dir):
        return []

    files = []
    try:
        entries = os.listdir(logs_dir)
    except Exception:
        return []

    for name in entries:
        if not name.endswith(".log"):
            continue
        full_path = os.path.join(logs_dir, name)
        if not os.path.isfile(full_path):
            continue
        try:
            stat = os.stat(full_path)
            size_kb = round(stat.st_size / 1024, 2)
            mtime = datetime.datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S")
            is_error = name.startswith("error_")
            files.append({
                "name": name,
                "size_kb": size_kb,
                "size_bytes": stat.st_size,
                "mtime": mtime,
                "is_error": is_error,
            })
        except Exception:
            continue

    files.sort(key=lambda x: x["mtime"], reverse=True)
    return files


def read_log_file(filename: str, max_lines: int = 2000, base_dir: Optional[str] = None) -> str:
    """安全读取指定日志文件的最后 max_lines 行，严防路径穿越。"""
    safe_name = os.path.basename(filename)
    if not safe_name.endswith(".log"):
        return f"错误：只允许读取 .log 文件 ({safe_name})"

    logs_dir = get_logs_dir(base_dir)
    full_path = os.path.join(logs_dir, safe_name)
    if not os.path.isfile(full_path):
        return f"日志文件不存在: {safe_name}"

    try:
        with open(full_path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
            if len(lines) > max_lines:
                lines = lines[-max_lines:]
            return "".join(lines)
    except Exception as e:
        return f"读取日志文件失败: {e}"


def cleanup_old_logs(max_days: int = 30, base_dir: Optional[str] = None) -> int:
    """清理超过 max_days 天的旧日志文件，避免长期运行占满磁盘空间。"""
    logs_dir = get_logs_dir(base_dir)
    if not os.path.isdir(logs_dir):
        return 0

    cutoff = datetime.datetime.now() - datetime.timedelta(days=max_days)
    removed_count = 0

    with _LOG_LOCK:
        try:
            entries = os.listdir(logs_dir)
        except Exception:
            return 0

        for name in entries:
            if not name.endswith(".log"):
                continue
            full_path = os.path.join(logs_dir, name)
            try:
                stat = os.stat(full_path)
                mtime = datetime.datetime.fromtimestamp(stat.st_mtime)
                if mtime < cutoff:
                    os.remove(full_path)
                    removed_count += 1
            except Exception:
                continue

    return removed_count


def open_logs_dir(base_dir: Optional[str] = None) -> bool:
    """在操作系统的文件资源管理器中打开日志文件夹。"""
    logs_dir = get_logs_dir(base_dir)
    return open_folder_or_file(logs_dir)
