"""待回名单：本地展示给老师，不自动上报云端。

字段：student/candidate/chat_title/identity/last_sender/last_message/needs_reply/time/verdict
语义 fail-open：needs_reply 为 None 记“待人工确认”，不拦发送。
"""

import csv
import datetime

_SENDER_CN = {"parent": "家长", "me": "我"}

# 导出给老师看的精简列：内部字段名 -> 中文表头
EXPORT_FIELDS = [
    ("student", "学生"),
    ("chat_title", "会话"),
    ("last_message", "最后消息"),
    ("verdict", "需回"),
    ("time", "时间"),
]


def verdict(needs_reply) -> str:
    if needs_reply is True:
        return "需回"
    if needs_reply is False:
        return "无需回"
    return "待人工确认"


def make_note(student_name, candidate_index, chat_title, matched: bool, judgment: dict) -> dict:
    """纯函数：一次进过的候选 → 一条名单记录。"""
    judgment = judgment or {}
    sender = judgment.get("last_sender")
    note = {
        "student": student_name,
        "candidate": candidate_index,
        "chat_title": chat_title or "(标题读取失败)",
        "identity": "✅已确认" if matched else "❌未确认",
        "last_sender": _SENDER_CN.get(sender, "未知"),
        "last_message": (judgment.get("last_message_text") or "").strip(),
        "needs_reply": judgment.get("needs_reply"),
        "time": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    note["verdict"] = verdict(note["needs_reply"])
    return note


def should_record(chat_title, judgment: dict) -> bool:
    """三者全空（抓帧失败/模型无返回）才跳过，否则每进一候选都记。"""
    judgment = judgment or {}
    return bool((judgment.get("last_message_text") or "").strip() or chat_title or judgment.get("needs_reply") is not None)


def dedupe_add(notes: list, note: dict) -> list:
    """同一学生+同一会话标题只保留最新一条。返回 notes（原地改）。"""
    for i, old in enumerate(notes):
        if old.get("student") == note.get("student") and old.get("chat_title") == note.get("chat_title"):
            notes[i] = note
            break
    else:
        notes.append(note)
    return notes


def actionable(notes: list) -> list:
    """真正需要老师去回的：排除明确“无需回”。"""
    return [n for n in notes if n.get("needs_reply") is not False]


def export_csv(notes: list, path: str) -> str:
    """导出 CSV（中文精简表头，含 BOM，Excel 直接开不乱码）；返回 path。"""
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow([label for _, label in EXPORT_FIELDS])
        for note in notes or []:
            w.writerow([note.get(key, "") for key, _ in EXPORT_FIELDS])
    return path
