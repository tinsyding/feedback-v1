"""待回名单：本地展示给老师，不自动上报云端（阶段 6 接 UI）。

字段：student/candidate/chat_title/identity/last_sender/last_message/needs_reply/time/verdict
语义 fail-open：needs_reply 为 None 记“待人工确认”，不拦发送。
"""


def verdict(needs_reply) -> str:
    if needs_reply is True:
        return "需回"
    if needs_reply is False:
        return "无需回"
    return "待人工确认"
