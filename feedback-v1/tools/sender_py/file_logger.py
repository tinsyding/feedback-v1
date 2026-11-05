"""本地日志文件持久化与错误/警告分流记录模块。

将运行日志、警告和错误日志保存至本地 (~/.sender_py/logs/)，
并支持日志分流（常规运行流 + 专属错误警告流）与历史日志定期清理。
"""

import datetime
import os
import threading
import traceback
from typing import List, Optional, Tuple

try:
    from sender_py.store import default_storage_base_dir, open_folder_or_file
except ModuleNotFoundError:
    from store import default_storage_base_dir, open_folder_or_file


_LOG_LOCK = threading.RLock()


def get_logs_dir(base_dir: Optional[str] = None) -> str:
    """获取并确保日志目录存在 (~/.sender_py/logs)。"""
    base = base_dir or default_storage_base_dir()
    logs_dir = os.path.join(base, "logs")
    os.makedirs(logs_dir, exist_ok=True)
    return logs_dir


def detect_log_level(msg: str) -> str:
    """根据日志消息关键字与图标智能识别级别。"""
    msg_str = str(msg)
    error_keywords = ("❌", "✗", "[ERROR]", "[CRITICAL]", "错误", "失败", "异常", "Traceback", "Exception")
    for kw in error_keywords:
        if kw in msg_str:
            return "ERROR"
            
    warn_keywords = ("⚠️", "▲", "[WARN]", "[WARNING]", "警告", "未匹配", "拦截", "跳过", "超时")
    for kw in warn_keywords:
        if kw in msg_str:
            return "WARNING"

    return "INFO"


def _clean_raw_msg(msg: str) -> str:
    """去除可能已有的旧时间戳前缀，保持文件记录格式整洁统一。"""
    s = str(msg).strip()
    # 形如 "[10:20:30] xxx"
    if len(s) >= 10 and s.startswith("[") and s[3] == ":" and s[6] == ":" and s[9] == "]":
        s = s[10:].strip()
    return s


def write_log(
    msg: str,
    level: Optional[str] = None,
    exc_info: Optional[object] = None,
    base_dir: Optional[str] = None,
) -> Tuple[str, str]:
    """将日志写入本地文件。
    
    所有日志写入 sender_YYYY-MM-DD.log；
    错误与警告同时分流写入 error_YYYY-MM-DD.log。
    """
    now = datetime.datetime.now()
    date_str = now.strftime("%Y-%m-%d")
    time_str = now.strftime("%Y-%m-%d %H:%M:%S")

    clean_msg = _clean_raw_msg(msg)
    eff_level = (level or detect_log_level(clean_msg)).upper()

    log_entry = f"[{time_str}] [{eff_level}] {clean_msg}\n"

    # 如果有异常信息，追加堆栈
    if exc_info:
        if isinstance(exc_info, BaseException):
            tb = "".join(traceback.format_exception(type(exc_info), exc_info, exc_info.__traceback__))
            log_entry += tb.rstrip() + "\n"
        elif isinstance(exc_info, str):
            log_entry += exc_info.rstrip() + "\n"
        elif exc_info is True:
            tb = traceback.format_exc()
            if tb and tb.strip() != "NoneType: None":
                log_entry += tb.rstrip() + "\n"

    logs_dir = get_logs_dir(base_dir)
    all_log_path = os.path.join(logs_dir, f"sender_{date_str}.log")
    err_log_path = os.path.join(logs_dir, f"error_{date_str}.log")

    with _LOG_LOCK:
        try:
            with open(all_log_path, "a", encoding="utf-8") as f:
                f.write(log_entry)
        except Exception:
            pass

        # 错误或警告分流写入专属错误日志文件
        if eff_level in ("ERROR", "WARNING", "CRITICAL"):
            try:
                with open(err_log_path, "a", encoding="utf-8") as f:
                    f.write(log_entry)
            except Exception:
                pass

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
