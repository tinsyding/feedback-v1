"""输入契约纯函数：学生标识解析 + 反馈 JSON 加载。Windows 无关，可在 Linux 单测。"""

import json
import re

_STUDENT_RE = re.compile(r"^(\d+)[\s\-_.、，,;；:：]*(.*)$")


def parse_student_identifier(raw_name: str) -> tuple:
    """从 '90001张三' / '90001,张三' / '90001，张三' 拆出 (sid, sname)。"""
    raw = (raw_name or "").strip()
    m = _STUDENT_RE.match(raw)
    if m:
        return m.group(1), m.group(2).strip()
    return "", raw


def load_feedback_items(path: str) -> list:
    """读取 tools/测试.json：数组元素 {studentName, message}，message 含换行原样返回。"""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError("输入 JSON 顶层必须是数组")
    items = []
    for entry in data:
        name = (entry.get("studentName") or entry.get("name") or "").strip()
        msg = entry.get("message") or entry.get("feedbackText") or ""
        if not name or not msg:
            continue
        sid, sname = parse_student_identifier(name)
        items.append({"studentName": name, "sid": sid, "sname": sname, "message": msg})
    return items
