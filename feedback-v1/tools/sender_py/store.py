"""本地存档：兼容读旧版 feedback_history.json（{"classes": {...}}），断点续发不丢历史。"""

import json
import os


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

    def is_sent(self, archive_key: str, student_name: str) -> bool:
        entry = self._data["classes"].get(archive_key, {})
        for s in entry.get("students", []):
            if s.get("name") == student_name and ("已发送" in s.get("status", "") or "✓" in s.get("status", "")):
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
