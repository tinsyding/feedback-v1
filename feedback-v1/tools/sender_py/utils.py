"""输入契约纯函数：学生标识解析 + 反馈 JSON/HTML 加载。Windows 无关，可在 Linux 单测。"""

import html
import json
import os
import re

_STUDENT_RE = re.compile(r"^(\d+)[\s\-_.、，,;；:：]*(.*)$")
_HTML_DATA_RE = re.compile(
    r'<script\b[^>]*\bid\s*=\s*["\']feedback-data["\'][^>]*>(.*?)</script\s*>',
    re.IGNORECASE | re.DOTALL,
)
_HTML_ROW_RE = re.compile(r"<tr\b[^>]*>(.*?)</tr\s*>", re.IGNORECASE | re.DOTALL)
_HTML_NAME_RE = re.compile(
    r'<span\b[^>]*\bclass\s*=\s*["\'][^"\']*\bstudent-name\b[^"\']*["\'][^>]*>(.*?)</span\s*>',
    re.IGNORECASE | re.DOTALL,
)
_HTML_MSG_RE = re.compile(
    r'<div\b[^>]*\bclass\s*=\s*["\'][^"\']*\bfeedback-content\b[^"\']*["\'][^>]*>(.*?)</div\s*>',
    re.IGNORECASE | re.DOTALL,
)


def parse_student_identifier(raw_name: str) -> tuple:
    """从 '90001张三' / '90001,张三' / '90001，张三' 拆出 (sid, sname)。"""
    raw = (raw_name or "").strip()
    m = _STUDENT_RE.match(raw)
    if m:
        return m.group(1), m.group(2).strip()
    return "", raw


def _feedback_items_from_entries(data) -> list:
    if not isinstance(data, list):
        raise ValueError("反馈数据顶层必须是数组")
    items = []
    for entry in data:
        if not isinstance(entry, dict):
            raise ValueError("反馈数据数组元素必须是对象")
        name = str(entry.get("studentName") or entry.get("name") or "").strip()
        msg = entry.get("message") or entry.get("feedbackText") or ""
        if not isinstance(msg, str):
            msg = str(msg)
        if not name or not msg:
            continue
        sid, sname = parse_student_identifier(name)
        items.append({"studentName": name, "sid": sid, "sname": sname, "message": msg})
    return items


def _html_fragment_text(raw: str) -> str:
    # 快照里正文已 HTML 转义；兼容少量带 <br> 的 HTML 导出。
    raw = re.sub(r"<br\s*/?>", "\n", raw or "", flags=re.IGNORECASE)
    return html.unescape(raw).strip()


def _feedback_items_from_html(text: str) -> list:
    # 新版网页快照：优先读内嵌 JSON，能原样保留换行和特殊字符。
    m = _HTML_DATA_RE.search(text)
    if m:
        payload = (m.group(1) or "").strip()
        try:
            data = json.loads(payload)
        except json.JSONDecodeError as exc:
            raise ValueError(f"HTML 内嵌 feedback-data 不是合法 JSON：{exc}") from exc
        return _feedback_items_from_entries(data)

    # 旧版快照兜底：从表格的 student-name / feedback-content 提取。
    entries = []
    for row in _HTML_ROW_RE.findall(text):
        name_m = _HTML_NAME_RE.search(row)
        msg_m = _HTML_MSG_RE.search(row)
        if not name_m or not msg_m:
            continue
        name = _html_fragment_text(name_m.group(1))
        msg = _html_fragment_text(msg_m.group(1))
        if name and msg:
            entries.append({"studentName": name, "message": msg})
    if not entries:
        raise ValueError("HTML 中没有找到 feedback-data 或可识别的学生表格")
    return _feedback_items_from_entries(entries)


def load_feedback_items(path: str) -> list:
    """读取反馈输入：JSON 数组，或网站导出的 HTML 快照。"""
    ext = os.path.splitext(path)[1].lower()
    with open(path, "r", encoding="utf-8-sig") as f:
        if ext in (".html", ".htm"):
            return _feedback_items_from_html(f.read())
        data = json.load(f)
    return _feedback_items_from_entries(data)
