"""发送 pacing：动作间随机停顿，降机械规律性。纯函数可单测。"""

import random
import time

CANDIDATE_GAP = (0.3, 0.8)  # 换候选前
AFTER_SEND_GAP = (0.4, 1.0)  # 发完一条后
STUDENT_GAP = (0.5, 1.0)  # 换下一学生前
SEARCH_GAP = (0.3, 0.6)  # 搜索之后停顿 0.3-0.6 秒
BATCH_BREAK_EVERY = 15  # 每 15 人
BATCH_BREAK_GAP = (2.0, 3.0)  # 停顿 2-3 秒


def pause(low: float, high: float, _sleep=time.sleep, _rand=random.uniform) -> float:
    """睡 low~high 秒，返回实际秒数（供日志）。"""
    secs = _rand(low, high)
    _sleep(max(0.0, secs))
    return secs
