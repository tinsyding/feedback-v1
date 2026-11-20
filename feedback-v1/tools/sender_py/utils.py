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


def _normalize_entry_files(raw_files) -> list:
    if not raw_files:
        return []
    if isinstance(raw_files, str):
        raw_list = [raw_files]
    elif isinstance(raw_files, (list, tuple)):
        raw_list = list(raw_files)
    else:
        return []
    out = []
    seen = set()
    for p in raw_list:
        s = str(p or "").strip()
        if not s:
            continue
        norm = os.path.normpath(s)
        if norm not in seen:
            seen.add(norm)
            out.append(norm)
    return out


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
        files = _normalize_entry_files(entry.get("files") or entry.get("attachments"))
        if not name or (not msg and not files):
            continue
        sid, sname = parse_student_identifier(name)
        item = {"studentName": name, "sid": sid, "sname": sname, "message": msg}
        if files:
            item["files"] = files
        items.append(item)
    return items


_FILENAME_ID_NAME_RE = re.compile(r"(\d{4,12})[\s\-_.、，,;；:：()（）【】\[\]]*([\u4e00-\u9fa5·]{2,8})")
_FILENAME_NAME_ID_RE = re.compile(r"([\u4e00-\u9fa5·]{2,8})[\s\-_.、，,;；:：()（）【】\[\]]*(\d{4,12})")
_FILENAME_STOPWORDS = ("第", "周", "巩固", "预习", "错题", "反馈", "成绩", "报告", "作业", "试卷", "答案", "解析", "高一", "高二", "高三", "初一", "初二", "初三")


def _clean_extracted_chinese_name(raw_cname: str) -> str:
    cname = (raw_cname or "").strip()
    for sw in _FILENAME_STOPWORDS:
        idx = cname.find(sw)
        if idx >= 0:
            cname = cname[:idx]
    return cname.strip()


def extract_student_from_filename(path_or_name: str) -> tuple:
    """从文件名（如 '90001张三_第8周错题.pdf' 或 '张三_90001.pdf'）提取 (sid, sname, studentName)。
    无法提取学号时返回 ("", "", "")。
    """
    stem = os.path.splitext(os.path.basename(str(path_or_name or "").strip()))[0].strip()
    if not stem:
        return ("", "", "")
    for m1 in _FILENAME_ID_NAME_RE.finditer(stem):
        sid = m1.group(1)
        sname = _clean_extracted_chinese_name(m1.group(2))
        if len(sname) >= 2:
            return (sid, sname, f"{sid}{sname}")
    for m2 in _FILENAME_NAME_ID_RE.finditer(stem):
        sname = _clean_extracted_chinese_name(m2.group(1))
        sid = m2.group(2)
        if len(sname) >= 2:
            return (sid, sname, f"{sid}{sname}")
    return ("", "", "")


def _sid_in_stem(sid: str, stem: str) -> bool:
    if not sid or not stem:
        return False
    pattern = rf"(?<!\d){re.escape(sid)}(?!\d)"
    return bool(re.search(pattern, stem))


def match_files_to_students(file_paths: list, items: list) -> dict:
    """将一批本地文件路径按『学号+姓名 -> 唯一学号 -> 唯一姓名』自动匹配并挂载到 items 的 files 列表。

    返回 {"matched_files": int, "unmatched_files": list, "matched_students": int}
    """
    valid_paths = []
    for p in (file_paths or []):
        s = str(p or "").strip()
        if s:
            valid_paths.append(os.path.normpath(s))

    sid_map = {}
    sname_map = {}
    for it in items:
        sid = (it.get("sid") or "").strip()
        sname = (it.get("sname") or "").strip()
        if sid:
            sid_map.setdefault(sid, []).append(it)
        if sname:
            sname_map.setdefault(sname, []).append(it)

    matched_files = 0
    unmatched_files = []
    touched_ids = set()

    for path in valid_paths:
        stem = os.path.splitext(os.path.basename(path))[0]
        candidates = []

        # 优先级 1：同时命中 sid 与 sname
        for it in items:
            sid = (it.get("sid") or "").strip()
            sname = (it.get("sname") or "").strip()
            if sid and sname and _sid_in_stem(sid, stem) and (sname in stem):
                candidates.append(it)

        # 优先级 2：仅命中学号（且该学号在列表中唯一）
        if not candidates:
            hit_sids = [sid for sid in sid_map if _sid_in_stem(sid, stem)]
            if len(hit_sids) == 1 and len(sid_map[hit_sids[0]]) == 1:
                candidates = list(sid_map[hit_sids[0]])

        # 优先级 3：仅命中姓名（且该姓名在列表中唯一，长度 >= 2）
        if not candidates:
            hit_names = [sn for sn in sname_map if len(sn) >= 2 and (sn in stem)]
            # 取最长匹配姓名，防止「王伟」误命中「王伟豪」
            if hit_names:
                max_len = max(len(sn) for sn in hit_names)
                longest = [sn for sn in hit_names if len(sn) == max_len]
                if len(longest) == 1 and len(sname_map[longest[0]]) == 1:
                    candidates = list(sname_map[longest[0]])

        if candidates:
            matched_files += 1
            for target in candidates:
                cur_files = list(target.get("files") or [])
                if path not in cur_files:
                    cur_files.append(path)
                target["files"] = cur_files
                touched_ids.add(id(target))
        else:
            unmatched_files.append(path)

    return {
        "matched_files": matched_files,
        "unmatched_files": unmatched_files,
        "matched_students": len(touched_ids),
    }


def build_items_from_attachment_files(file_paths: list, default_message: str = "") -> tuple:
    """直接从带有『学号+姓名』的文件路径列表生成发送队列 items（支持同一学生多个附件自动归并）。

    返回 (items, unmatched_files)
    """
    grouped = {}
    order = []
    unmatched = []
    msg = str(default_message or "")

    for raw_p in (file_paths or []):
        s = str(raw_p or "").strip()
        if not s:
            continue
        norm_p = os.path.normpath(s)
        sid, sname, student_name = extract_student_from_filename(norm_p)
        if not sid or not sname:
            unmatched.append(norm_p)
            continue
        key = (sid, sname)
        if key not in grouped:
            grouped[key] = {
                "studentName": student_name,
                "sid": sid,
                "sname": sname,
                "message": msg,
                "files": [norm_p],
            }
            order.append(key)
        else:
            if norm_p not in grouped[key]["files"]:
                grouped[key]["files"].append(norm_p)

    return [grouped[k] for k in order], unmatched


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
