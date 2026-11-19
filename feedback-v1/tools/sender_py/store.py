"""本地存档：兼容读旧版 feedback_history.json（{"classes": {...}}），断点续发不丢历史。
并记录已发送过的 JSON / HTML 文件，保存在本地。
"""

import html
import json
import os
import platform
import shutil
import subprocess


def default_storage_base_dir() -> str:
    return os.path.join(os.path.expanduser("~"), ".sender_py")


def open_directory(dir_path: str) -> bool:
    """跨平台在系统文件资源管理器中打开指定目录。"""
    if not dir_path:
        return False
    os.makedirs(dir_path, exist_ok=True)
    sys_name = platform.system()
    try:
        if sys_name == "Windows":
            os.startfile(dir_path)  # type: ignore[attr-defined]
            return True
        elif sys_name == "Darwin":
            subprocess.Popen(["open", dir_path])
            return True
        else:
            subprocess.Popen(["xdg-open", dir_path])
            return True
    except Exception:
        return False


open_folder_or_file = open_directory


class SentFilesManager:
    """管理已经发送过的 JSON / HTML 文件记录，保存在本地。"""
    def __init__(self, base_dir: str = None):
        self.base_dir = base_dir or default_storage_base_dir()
        self.records_dir = os.path.join(self.base_dir, "sent_records")
        self.index_path = os.path.join(self.base_dir, "sent_files_index.json")
        self._records = []
        self.load()

    def load(self):
        if not os.path.isfile(self.index_path):
            self._records = []
            return
        try:
            with open(self.index_path, "r", encoding="utf-8") as f:
                content = f.read().strip()
                data = json.loads(content) if content else []
                self._records = data if isinstance(data, list) else []
        except Exception:
            self._records = []

    def save(self):
        os.makedirs(os.path.dirname(os.path.abspath(self.index_path)), exist_ok=True)
        with open(self.index_path, "w", encoding="utf-8") as f:
            json.dump(self._records, f, ensure_ascii=False, indent=2)

    def get_records(self) -> list:
        return list(self._records)

    list_records = get_records

    def is_file_sent(self, file_path_or_name: str) -> bool:
        """检查某个文件是否在本地有发送成功的记录。"""
        if not file_path_or_name:
            return False
        norm = os.path.abspath(file_path_or_name)
        base = os.path.basename(file_path_or_name)
        for r in self._records:
            if not isinstance(r, dict):
                continue
            r_path = r.get("file_path", "")
            r_name = r.get("file_name", "")
            if r_path and os.path.abspath(r_path) == norm:
                return True
            if r_name and r_name == base:
                return True
        return False

    def record_sent_file(self, file_path: str, items: list, sent_time: str = None) -> dict:
        """记录已发送的文件，并生成本地独立的 JSON 和 HTML 快照文件。"""
        import datetime as _dt

        now_str = sent_time or _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        ts_tag = _dt.datetime.now().strftime("%Y%m%d_%H%M%S")
        os.makedirs(self.records_dir, exist_ok=True)

        file_name = os.path.basename(file_path) if file_path else "已发送反馈"
        name_root, ext = os.path.splitext(file_name)
        ext_clean = ext.lstrip(".").lower() or "json"

        # 统计发送结果
        sent_items = []
        failed_items = []
        serializable_students = []
        for item in items or []:
            st = str(item.get("_status") or item.get("status") or "")
            res = str(item.get("_last_result") or "")
            if "已发送" in st or "sent" in res or "✓" in st:
                sent_items.append(item)
            elif "失败" in st or "未匹配" in st or "error" in res or "unmatched" in res:
                failed_items.append(item)

            serializable_students.append({
                "studentName": item.get("studentName", ""),
                "sid": item.get("sid", ""),
                "sname": item.get("sname", ""),
                "status": st or "已发送",
                "message": item.get("message", ""),
                "last_reason": item.get("_last_reason") or "",
            })

        total_count = len(items or [])
        sent_count = len(sent_items)
        failed_count = len(failed_items)

        # 1. 保存本地 JSON 记录
        safe_name = "".join(c for c in name_root if c.isalnum() or c in ("-", "_", " "))
        safe_name = safe_name.strip() or "feedback"
        json_filename = f"{ts_tag}_{safe_name}_已发记录.json"
        json_record_path = os.path.join(self.records_dir, json_filename)

        record_data = {
            "source_file": file_path,
            "file_name": file_name,
            "sent_time": now_str,
            "total_count": total_count,
            "sent_count": sent_count,
            "failed_count": failed_count,
            "students": serializable_students,
        }
        with open(json_record_path, "w", encoding="utf-8") as f:
            json.dump(record_data, f, ensure_ascii=False, indent=2)

        # 2. 保存本地独立漂亮的 HTML 记录（可在浏览器直接双击打开查看）
        html_filename = f"{ts_tag}_{safe_name}_已发记录.html"
        html_record_path = os.path.join(self.records_dir, html_filename)
        html_rows = []
        for idx, s in enumerate(serializable_students, 1):
            s_name = html.escape(str(s.get("studentName", "")))
            s_status = html.escape(str(s.get("status", "")))
            s_msg = html.escape(str(s.get("message", ""))).replace("\n", "<br>")
            status_color = "#16a34a" if "已发送" in s_status else ("#dc2626" if ("失败" in s_status or "未匹配" in s_status) else "#64748b")
            html_rows.append(
                f"<tr><td>{idx}</td><td><strong>{s_name}</strong></td>"
                f"<td><span style='color:{status_color};font-weight:bold;'>{s_status}</span></td>"
                f"<td style='font-size:12px;color:#334155;'>{s_msg}</td></tr>"
            )

        html_content = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>极方每周反馈 - 发送记录 ({html.escape(file_name)})</title>
<style>
body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f8fafc; color: #1e293b; margin: 0; padding: 24px; }}
.card {{ background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 20px 24px; max-width: 1080px; margin: 0 auto; }}
h2 {{ margin-top: 0; color: #0f172a; display: flex; align-items: center; gap: 8px; }}
.meta {{ color: #64748b; font-size: 13px; margin-bottom: 16px; border-bottom: 1px solid #e2e8f0; padding-bottom: 12px; }}
.badge {{ display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; margin-right: 8px; }}
.badge-blue {{ background: #e0f2fe; color: #0369a1; }}
.badge-green {{ background: #dcfce7; color: #15803d; }}
table {{ width: 100%; border-collapse: collapse; margin-top: 12px; }}
th, td {{ padding: 10px 12px; text-align: left; border-bottom: 1px solid #e2e8f0; }}
th {{ background: #f1f5f9; color: #475569; font-size: 13px; }}
tr:hover {{ background: #f8fafc; }}
</style>
</head>
<body>
<div class="card">
  <h2>📋 极方反馈发送记录</h2>
  <div class="meta">
    <span class="badge badge-blue">文件: {html.escape(file_name)}</span>
    <span class="badge badge-green">已发: {sent_count}/{total_count} 人</span>
    <span>发送时间: {now_str}</span>
  </div>
  <table>
    <thead><tr><th style="width:40px">#</th><th style="width:160px">学员姓名</th><th style="width:100px">发送状态</th><th>反馈内容</th></tr></thead>
    <tbody>
      {''.join(html_rows)}
    </tbody>
  </table>
</div>
</body>
</html>"""
        with open(html_record_path, "w", encoding="utf-8") as f:
            f.write(html_content)

        # 3. 备份原源文件（若存在）
        source_backup_path = ""
        if file_path and os.path.isfile(file_path):
            src_dir = os.path.join(self.records_dir, "sources")
            os.makedirs(src_dir, exist_ok=True)
            source_backup_path = os.path.join(src_dir, f"{ts_tag}_{file_name}")
            try:
                shutil.copy2(file_path, source_backup_path)
            except Exception:
                source_backup_path = ""

        # 4. 更新索引
        entry = {
            "file_name": file_name,
            "file_path": os.path.abspath(file_path) if file_path else "",
            "file_type": ext_clean,
            "sent_time": now_str,
            "total_count": total_count,
            "sent_count": sent_count,
            "failed_count": failed_count,
            "json_record": json_record_path,
            "html_record": html_record_path,
            "source_backup": source_backup_path,
        }
        # 若已有同名且同路径记录，新记录置顶替换
        new_records = [entry]
        for r in self._records:
            if not isinstance(r, dict):
                continue
            if r.get("file_name") == file_name and r.get("file_path") == entry["file_path"]:
                continue
            new_records.append(r)
        self._records = new_records[:200]
        self.save()
        return entry


class HistoryManager:
    def __init__(self, storage_path: str = None):
        if storage_path is None:
            storage_path = os.path.join(os.path.expanduser("~"), ".sender_py", "feedback_history.json")
        self.storage_path = storage_path
        self._data = {"classes": {}}
        self.load()

    def load(self):
        if not os.path.isfile(self.storage_path):
            self._data = {"classes": {}}
            return
        try:
            with open(self.storage_path, "r", encoding="utf-8") as f:
                content = f.read().strip()
                self._data = json.loads(content) if content else {"classes": {}}
        except Exception:
            self._data = {"classes": {}}
            return
        if not isinstance(self._data, dict) or not isinstance(self._data.get("classes"), dict):
            self._data = {"classes": {}}
            return
        for entry in self._data["classes"].values():
            if not isinstance(entry, dict):
                continue
            entry.setdefault("cycle", "第 1 周")
            entry.setdefault("class_name", entry.get("file_name", ""))

    def save(self):
        os.makedirs(os.path.dirname(os.path.abspath(self.storage_path)), exist_ok=True)
        with open(self.storage_path, "w", encoding="utf-8") as f:
            json.dump(self._data, f, ensure_ascii=False, indent=2)

    def is_sent(self, archive_key: str, student_name: str, message: str = None) -> bool:
        entry = self._data["classes"].get(archive_key, {})
        for s in entry.get("students", []):
            if s.get("name") == student_name and ("已发送" in s.get("status", "") or "✓" in s.get("status", "")):
                saved_msg = s.get("message")
                if message is not None and saved_msg and str(saved_msg).strip() != str(message).strip():
                    return False
                return True
        return False

    def mark_status(self, archive_key: str, student_name: str, status: str,
                    message: str = "", time_str: str = None) -> None:
        """断点续发写盘：兼容旧条目形状 {index,name,status,time,message,msg_len}。"""
        import datetime as _dt
        entry = self._data["classes"].get(archive_key)
        if not isinstance(entry, dict):
            entry = {"key": archive_key, "cycle": "第 1 周", "class_name": archive_key,
                     "students": []}
            self._data["classes"][archive_key] = entry
        students = entry.setdefault("students", [])
        for s in students:
            if isinstance(s, dict) and s.get("name") == student_name:
                s["status"] = status
                s["time"] = time_str or _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                if message:
                    s["message"] = message
                    s["msg_len"] = len(message)
                break
        else:
            students.append({
                "index": len(students) + 1,
                "name": student_name,
                "status": status,
                "time": time_str or _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "message": message,
                "msg_len": len(message or ""),
            })
        self.save()
