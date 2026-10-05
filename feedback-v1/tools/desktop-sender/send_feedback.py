# -*- coding: utf-8 -*-
"""
企业微信自动发送反馈脚本 (AI 视觉智能防误发与周次管理版 v1.6)
功能：
1. 读取反馈 JSON 文件及网站导出的 HTML 网页快照文件，严格按学生信息逐个发送反馈
2. 发送周次分类管理：支持按周次/周期独立归档，不同周期自动清空已发状态，支持周期筛选与导出
3. AI 视觉智能防误发：候选按第 1/2/3 项顺序逐个试探，用 WGC 抓「画面已稳定」的企微整窗，
   一次云端视觉调用同时裁决会话身份、是否群聊、以及家长是否有待回消息（群聊一律拦截）
4. 实时消息预览：点击名单任意学生即可在右侧查看完整反馈文案
5. 智能断点续发与重试：自动跳过当前周期已发送记录，支持一键重试失败与拦截项
6. 前台窗口守护与防失焦：自动寻找企微窗口，检测到焦点被抢夺立即自动暂停，防止误发
7. 剪贴板安全核验：防止剪贴板延迟导致发错上一个学生的内容
8. 批次防风控休息：支持每发送 N 人自动休眠，模拟真人节奏
9. 导出发送记录：一键导出 CSV 报表留档
10. 待回消息名单：打开会话本身就会清掉家长未读角标，本工具逐条留痕并在 app 内展示/导出，
    补回这个被我们自己消费掉的信号
"""

import os
import re
import sys
import csv
import json
import html
import time
import random
import ctypes
import asyncio
import datetime
import tempfile
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from threading import Thread, Event

from PIL import Image, ImageEnhance
import pyautogui
import pyperclip

# 开启 Windows 进程级高级 DPI 感知 (Per-Monitor DPI Aware V2)
# 确保在 100%、125%、150%、200% 等不同分辨率、缩放级别及多显示器环境下，
# 窗口坐标 (GetWindowRect) 与 PyAutoGUI 截图 (1:1物理像素) 绝对对齐、绝无坐标偏移
try:
    ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except Exception:
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass

# Windows API 支持 (pywin32)
try:
    import win32gui
    import win32con
    import win32process
    HAS_WIN32 = True
except ImportError:
    HAS_WIN32 = False

# RapidOCR (基于 PaddleOCR v4 / ONNX Runtime，第一首选高精度离线 OCR 模块)
try:
    from rapidocr_onnxruntime import RapidOCR
    import numpy as np
    HAS_RAPIDOCR = True
except ImportError:
    HAS_RAPIDOCR = False

# Windows 原生离线 OCR 模块 (winocr，兜底应急备用)
try:
    import winocr
    HAS_WINOCR = True
except ImportError:
    HAS_WINOCR = False

HAS_OCR = HAS_RAPIDOCR or HAS_WINOCR
HAS_SMART_CHECK = True  # 视觉智能核验综合可用状态 (模式 A 大模型 + 模式 B 本地 OCR)
_RAPID_OCR_INSTANCE = None


def _get_rapid_ocr():
    """获取 RapidOCR 单例引擎"""
    global _RAPID_OCR_INSTANCE
    if not HAS_RAPIDOCR:
        return None
    if _RAPID_OCR_INSTANCE is None:
        try:
            from rapidocr_onnxruntime import RapidOCR
            _RAPID_OCR_INSTANCE = RapidOCR()
        except Exception as e:
            try:
                log(f"[RapidOCR] 初始化失败: {e}", "WARN")
            except Exception:
                pass
            return None
    return _RAPID_OCR_INSTANCE


def get_rapid_ocr():
    """获取 RapidOCR 引擎（向后兼容别名）"""
    return _get_rapid_ocr()

# 客户端应用版本号
APP_VERSION = "v2.6.0"


def detect_cycle_from_string(text: str) -> str:
    """
    从文本或文件名中智能提取周次/周期标识
    支持：
      - 第 1 周 / 第1周 / 第5周
      - 第 1 讲 / 第1讲 / 第5讲
      - 第 1 期 / 第1期 / 第2课
      - W01 / W1 / Week 2 / Week2
    提取成功返回标准化字符串（如 '第 1 周'、'第 5 讲'），未匹配返回空字符串 ''
    """
    if not text:
        return ""

    # 1. 匹配中文大写数字：第[一二三四五六七八九十]+周/讲/期/课/次/天/步
    cn_nums = {'一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10}
    m_cn = re.search(r"第\s*([一二三四五六七八九十]+)\s*([周讲期课次天步])", text)
    if m_cn:
        cn_str = m_cn.group(1)
        val = 0
        if len(cn_str) == 1 and cn_str in cn_nums:
            val = cn_nums[cn_str]
        elif len(cn_str) == 2 and cn_str.startswith('十'):
            val = 10 + cn_nums.get(cn_str[1], 0)
        elif len(cn_str) == 2 and cn_str.endswith('十'):
            val = cn_nums.get(cn_str[0], 1) * 10
        elif len(cn_str) == 3 and cn_str[1] == '十':
            val = cn_nums.get(cn_str[0], 1) * 10 + cn_nums.get(cn_str[2], 0)
        if val > 0:
            return f"第 {val} {m_cn.group(2)}"

    # 2. 匹配阿拉伯数字：第 X 周/讲/期/课/次/天/步
    m = re.search(r"第\s*(\d+)\s*([周讲期课次天步])", text)
    if m:
        return f"第 {int(m.group(1))} {m.group(2)}"

    # 3. 匹配 Week X / W03 / W 3
    m2 = re.search(r"(?:^|[\b_\-\s])(?:week|w)\s*0*(\d+)(?:[_\-\s\.]|$)", text, re.IGNORECASE)
    if m2:
        return f"第 {int(m2.group(1))} 周"

    return ""


def clean_class_name_from_path(file_path: str) -> str:
    """从文件路径或文件名中提取纯净班级名"""
    if not file_path:
        return ""
    filename = os.path.basename(file_path)
    base_name = os.path.splitext(filename)[0]
    clean = re.sub(r"([_\-](反馈快照|反馈|快照|错题|评语))+$", "", base_name, flags=re.I).strip()
    return clean or base_name


def detect_cycle_from_data(raw_data: list, file_path: str = "") -> str:
    """
    自动根据文件内容倒推周次/周期：
      1. 优先扫描学生反馈文案（message / 评语正文）中出现的「第X周/讲」等标记，取众数；
      2. 文案中无标记时，回退到文件名；
      3. 仍无则返回空字符串，由调用方决定默认值（第 1 周）。
    返回标准化字符串，如 '第 3 周'。
    """
    votes = {}
    if isinstance(raw_data, list):
        for item in raw_data:
            if not isinstance(item, dict):
                continue
            text = str(item.get("message") or item.get("评语") or item.get("content") or "")
            cyc = detect_cycle_from_string(text)
            if cyc:
                votes[cyc] = votes.get(cyc, 0) + 1
    if votes:
        # 取出现次数最多的周期（并列时取数字更大者）
        def _num(c):
            m = re.search(r"(\d+)", c)
            return int(m.group(1)) if m else 0
        return max(votes.items(), key=lambda kv: (kv[1], _num(kv[0])))[0]

    cyc = detect_cycle_from_string(file_path)
    if cyc:
        return cyc
    return ""

# 基础默认延时配置 (秒)
SEARCH_DELAY = 0.5
CLICK_DELAY = 0.5
TYPE_DELAY = 0.3
SEND_DELAY = 1.0
DEFAULT_MIN_DELAY = 2.0
DEFAULT_MAX_DELAY = 5.0
DEFAULT_BATCH_SIZE = 10
DEFAULT_BATCH_DELAY = 8.0

# ---- Windows Graphics Capture (WGC) 抓帧 ----
# WGC_SETTLE_INTERVAL: 连拍两帧的间隔，要大于一帧的渲染时间
# WGC_SETTLE_TIMEOUT: 最多等多久画面才静止；超时就用最后一帧
# WGC_FRAME_TIMEOUT: 单次建会话抓一帧的硬超时（capture.start() 是阻塞调用，
#   不设上限会在「窗口最小化 / 无新帧」时把整个发送线程挂死）
WGC_SETTLE_INTERVAL = 0.3
WGC_SETTLE_TIMEOUT = 1.5
WGC_FRAME_TIMEOUT = 6.0
WGC_RETRIES = 2


def get_resource_path(relative_path: str) -> str:
    """获取打包后临时目录或本地开发目录中的资源绝对路径"""
    if hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, relative_path)
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), relative_path)


def get_app_base_dir() -> str:
    """应用根目录：打包后为 exe 所在目录，源码运行为工程目录（原 get_data_dir 的选址逻辑）"""
    if getattr(sys, 'frozen', False):
        return os.path.dirname(os.path.abspath(sys.executable))
    script_dir = os.path.dirname(os.path.abspath(__file__))
    parent_dir = os.path.dirname(script_dir)
    if os.path.exists(os.path.join(parent_dir, "assets")):
        return parent_dir
    return script_dir


# 用户数据目录名（ASCII，避免中文路径在部分环境下的问题）
USER_DATA_DIRNAME = "JFFeedback"
# exe 旁旧数据目录（历史版本用过，保留作迁移源）
LEGACY_DATA_SUBDIR = "appdata"


def _move_into(src: str, dst: str) -> None:
    """把文件搬进目标位置（目标已存在则跳过，不覆盖）。"""
    try:
        if os.path.isfile(src) and not os.path.exists(dst):
            os.replace(src, dst)
    except Exception:
        pass


def _get_user_documents_dir() -> str:
    """取当前用户的「文档」目录（含 OneDrive 重定向的兼容）。
    返回 \"\" 表示取不到。"""
    candidates = []
    try:
        candidates.append(os.path.join(os.path.expanduser("~"), "Documents"))
    except Exception:
        pass
    try:
        up = os.environ.get("USERPROFILE", "")
        if up:
            candidates.append(os.path.join(up, "Documents"))
            candidates.append(os.path.join(up, "OneDrive", "Documents"))
    except Exception:
        pass
    for c in candidates:
        try:
            if c and os.path.isdir(c):
                return c
        except Exception:
            continue
    return ""


def _migrate_legacy_data(base_dir: str, data_dir: str) -> None:
    """一次性迁移：把 exe 旁的老数据（appdata/ 子目录 + 更早的根目录散文件）
    搬进新的用户数据目录。不覆盖目标已有文件；搬完不删源目录。
    不做会丢失已发送记录（程序以为没人发过，有重发风险），所以必须自动搬。"""
    legacy_files = ["feedback_history.json", "feedback_debug.log", "feedback_debug.log.bak"]
    try:
        os.makedirs(data_dir, exist_ok=True)
        sources = [os.path.join(base_dir, LEGACY_DATA_SUBDIR), base_dir]
        for src_dir in sources:
            for name in legacy_files:
                _move_into(os.path.join(src_dir, name), os.path.join(data_dir, name))
        for src_dir in sources:
            legacy_shots = os.path.join(src_dir, "debug_screenshots")
            new_shots = os.path.join(data_dir, "debug_screenshots")
            try:
                if os.path.isdir(legacy_shots):
                    if not os.path.exists(new_shots):
                        os.replace(legacy_shots, new_shots)
                    else:
                        for fn in os.listdir(legacy_shots):
                            _move_into(os.path.join(legacy_shots, fn),
                                       os.path.join(new_shots, fn))
            except Exception:
                pass
    except Exception:
        pass


def get_data_dir() -> str:
    """获取持久化数据（如历史记录、日志、截图）存储目录。
    优先放在当前用户「文档」下的 JFFeedback/（重装/换 exe 位置不丢，且多用户互不串）；
    取不到或写不了时回退到 exe 旁的 appdata/。"""
    base_dir = get_app_base_dir()
    fallback = os.path.join(base_dir, LEGACY_DATA_SUBDIR)
    docs = _get_user_documents_dir()
    if docs:
        data_dir = os.path.join(docs, USER_DATA_DIRNAME)
        try:
            os.makedirs(data_dir, exist_ok=True)
            _migrate_legacy_data(base_dir, data_dir)
            return data_dir
        except Exception:
            pass
    _migrate_legacy_data(base_dir, fallback)
    try:
        os.makedirs(fallback, exist_ok=True)
    except Exception:
        pass
    return fallback


LOG_FILE_PATH = os.path.join(get_data_dir(), "feedback_debug.log")
DEBUG_IMG_DIR = os.path.join(get_data_dir(), "debug_screenshots")


def log(msg: str, level: str = "INFO"):
    """
    全局多通道调试日志输出：
    1. 格式化时间戳并写入 feedback_debug.log (UTF-8, 追加模式, 超 5MB 自动滚动保留 bak)
    2. 控制台存在时 (Debug 控制台版本或终端运行) 安全实时输出至 sys.stdout (无控制台时静默不报错)
    """
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    line = f"[{now_str}] [{level}] {msg}"

    # 1. 控制台实时安全输出
    try:
        if sys.stdout and not getattr(sys.stdout, 'closed', False):
            print(line, flush=True)
    except Exception:
        pass

    # 2. 写入本地持久化日志文件
    try:
        log_path = LOG_FILE_PATH
        if os.path.exists(log_path) and os.path.getsize(log_path) > 5 * 1024 * 1024:
            old_path = log_path + ".bak"
            if os.path.exists(old_path):
                try:
                    os.remove(old_path)
                except Exception:
                    pass
            try:
                os.rename(log_path, old_path)
            except Exception:
                pass

        with open(log_path, "a", encoding="utf-8", errors="replace") as f:
            f.write(line + "\n")
    except Exception:
        pass


def clean_html_text(html_text: str) -> str:
    """将 HTML 片段转换为纯文本，保留换行符并解码 HTML 实体字符"""
    if not html_text:
        return ""
    text = re.sub(r'<br\s*/?>', '\n', html_text, flags=re.IGNORECASE)
    text = re.sub(r'</(p|div|tr|li|h[1-6])>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'<[^>]+>', '', text)
    text = html.unescape(text)
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    lines = [line.rstrip() for line in text.split('\n')]
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return '\n'.join(lines)


def parse_feedback_html(content: str) -> list:
    """
    从网站导出的 HTML 快照 / 网页中智能解析并提取学生姓名与反馈评语
    支持：
    1. 包含嵌入式 JSON 的 HTML (<script id="feedback-data" type="application/json">)
    2. 网站标准离线网页快照表格 (包含 .student-name 和 .feedback-content)
    3. Word 导出格式的 HTML 表格 (<tr><td>姓名</td><td>评语</td></tr>)
    4. 其他含学生评语的通用卡片或表格布局
    """
    if not content or not content.strip():
        return []

    # 策略 1: 优先提取嵌入的结构化 JSON 数据 (高保真无损还原)
    embedded_matches = re.findall(
        r'<script[^>]*\bid=["\']feedback-data["\'][^>]*>(.*?)</script>',
        content,
        re.DOTALL | re.IGNORECASE,
    )
    if not embedded_matches:
        embedded_matches = re.findall(
            r'<script[^>]*\btype=["\']application/json["\'][^>]*\bid=["\']feedback-data["\'][^>]*>(.*?)</script>',
            content,
            re.DOTALL | re.IGNORECASE,
        )
    for m in embedded_matches:
        try:
            raw_json = m.strip().replace(r'<\/', '</')
            data = json.loads(raw_json)
            if isinstance(data, list) and len(data) > 0:
                normalized = []
                for item in data:
                    if isinstance(item, dict):
                        s_name = (item.get("studentName") or item.get("name") or "").strip()
                        s_msg = (item.get("message") or item.get("feedbackText") or "").strip()
                        if s_name and s_msg:
                            normalized.append({"studentName": s_name, "message": s_msg})
                if normalized:
                    return normalized
        except Exception:
            pass

    results = []

    # 策略 2: 解析 <tr> 表格行
    tr_matches = re.findall(r'<tr\b[^>]*>(.*?)</tr>', content, re.DOTALL | re.IGNORECASE)
    for tr in tr_matches:
        name_match = re.search(
            r'<[^>]*class=["\'][^"\']*\bstudent-name\b[^"\']*["\'][^>]*>(.*?)</[^>]+>',
            tr,
            re.DOTALL | re.IGNORECASE,
        )
        feedback_match = re.search(
            r'<[^>]*class=["\'][^"\']*\bfeedback-content\b[^"\']*["\'][^>]*>(.*?)</[^>]+>',
            tr,
            re.DOTALL | re.IGNORECASE,
        )

        s_name = ""
        s_msg = ""

        if name_match:
            s_name = clean_html_text(name_match.group(1))
        else:
            copy_match = re.search(r'copyText\(\s*[\'"]([^\'"]+)[\'"]', tr, re.IGNORECASE)
            if copy_match:
                s_name = copy_match.group(1).replace(r"\'", "'").replace(r"\\", "\\").strip()

        if feedback_match:
            s_msg = clean_html_text(feedback_match.group(1))

        if s_name and s_msg:
            results.append({"studentName": s_name, "message": s_msg})
            continue

        # 兼容 Word / 通用表格: <td>姓名</td><td>评语</td>
        tds = re.findall(r'<td\b[^>]*>(.*?)</td>', tr, re.DOTALL | re.IGNORECASE)
        if len(tds) >= 2:
            candidate_name = clean_html_text(tds[0])
            candidate_msg = clean_html_text(tds[1])
            if (
                candidate_name
                and candidate_msg
                and len(candidate_msg) >= 5
                and candidate_name not in ["学生姓名", "姓名", "学号", "序号"]
            ):
                results.append({"studentName": candidate_name, "message": candidate_msg})

    if results:
        return results

    # 策略 3: 兼容卡片布局
    card_matches = re.findall(
        r'<div\b[^>]*class=["\'][^"\']*\bfeedback-card\b[^"\']*["\'][^>]*>(.*?)</div>\s*</div>',
        content,
        re.DOTALL | re.IGNORECASE,
    )
    for card in card_matches:
        name_match = re.search(
            r'<[^>]*class=["\'][^"\']*\bstudent-name\b[^"\']*["\'][^>]*>(.*?)</[^>]+>',
            card,
            re.DOTALL | re.IGNORECASE,
        )
        feedback_match = re.search(
            r'<[^>]*class=["\'][^"\']*\bfeedback-content\b[^"\']*["\'][^>]*>(.*?)</[^>]+>',
            card,
            re.DOTALL | re.IGNORECASE,
        )
        if name_match and feedback_match:
            s_name = clean_html_text(name_match.group(1))
            s_msg = clean_html_text(feedback_match.group(1))
            if s_name and s_msg:
                results.append({"studentName": s_name, "message": s_msg})

    return results


def load_feedback_data_from_file(file_path: str) -> list:
    """从给定文件路径载入反馈数据，支持 JSON 文件和 HTML 网页快照"""
    with open(file_path, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()

    ext = os.path.splitext(file_path)[1].lower()
    stripped = content.strip()

    # 优先尝试 JSON
    if ext == ".json" or (stripped.startswith("[") and stripped.endswith("]")):
        try:
            data = json.loads(content)
            if isinstance(data, list) and len(data) > 0:
                return data
        except Exception as e:
            if ext == ".json":
                raise ValueError(f"JSON 文件解析失败：\n{e}")

    # 尝试 HTML 快照解析
    html_data = parse_feedback_html(content)
    if html_data:
        return html_data

    # 备用：尝试直接作为 JSON 解析
    try:
        data = json.loads(content)
        if isinstance(data, list) and len(data) > 0:
            return data
    except Exception:
        pass

    raise ValueError("无法识别该文件中的反馈内容：既非有效的 JSON 数组，也未能从中提取出学生反馈评语。")


def safe_copy(text: str, retries: int = 5) -> bool:
    """确保文本成功写入系统剪贴板，防止剪贴板竞争或延迟导致发错上一个内容"""
    for _ in range(retries):
        try:
            pyperclip.copy(text)
            time.sleep(0.05)
            if pyperclip.paste() == text:
                return True
        except Exception:
            time.sleep(0.05)
    return False


def parse_student_identifier(raw_name: str) -> tuple:
    """
    从学生字符串中拆分学号与纯姓名（例如从 '90001张三' 拆为 ('90001', '张三')）

    分隔符必须覆盖中英文逗号：源数据里出现 '90001，张三' 时，旧正则的
    r"[\\s\\-_.、]" 不含逗号，会把姓名切成 '，张三'，导致后续
    `target_name in detected_title` 必然失败 —— 该学生被静默拦截，日志却显示
    「会话标题与目标不符」，会被误诊成模型判错。
    """
    raw = raw_name.strip()
    match = re.match(r"^(\d+)[\s\-_.、，,;；:：]*(.*)$", raw)
    if match:
        return match.group(1), match.group(2).strip()
    return "", raw


def get_wecom_hwnd():
    """获取企业微信主窗口在屏幕上的顶级句柄 (HWND)"""
    if not HAS_WIN32:
        return None

    wecom_hwnd = None

    def enum_cb(hwnd, _):
        nonlocal wecom_hwnd
        if win32gui.IsWindow(hwnd):
            cls = win32gui.GetClassName(hwnd)
            title = win32gui.GetWindowText(hwnd)
            if ("WeWorkWindow" in cls or "企业微信" in title or "WXWork" in cls) and "Wedoc" not in cls:
                rect = win32gui.GetWindowRect(hwnd)
                w, h = rect[2] - rect[0], rect[3] - rect[1]
                if w > 300 and h > 300:
                    wecom_hwnd = hwnd
                    return False
        return True

    try:
        win32gui.EnumWindows(enum_cb, None)
    except Exception:
        pass

    return wecom_hwnd


def get_wecom_rect() -> tuple:
    """获取企业微信主窗口在屏幕上的绝对矩形 (x, y, w, h)"""
    if not HAS_WIN32:
        return None

    hwnd = get_wecom_hwnd()
    if hwnd:
        rect = win32gui.GetWindowRect(hwnd)
        return (rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1])
    return None


def get_display_scale(hwnd=None) -> float:
    """
    获取指定窗口 (或主系统) 当前的 DPI 缩放比例
    1.0 = 100% 缩放 (96 DPI)
    1.25 = 125% 缩放 (120 DPI)
    1.5 = 150% 缩放 (144 DPI)
    2.0 = 200% 缩放 (192 DPI)
    """
    user32 = ctypes.windll.user32
    dpi = 96
    if hwnd:
        try:
            w_dpi = user32.GetDpiForWindow(hwnd)
            if w_dpi > 0:
                dpi = w_dpi
        except AttributeError:
            pass

    if dpi == 96:
        try:
            dpi = user32.GetDpiForSystem()
        except AttributeError:
            try:
                hdc = user32.GetDC(0)
                dpi = ctypes.windll.gdi32.GetDeviceCaps(hdc, 88)  # LOGPIXELSX
                user32.ReleaseDC(0, hdc)
            except Exception:
                dpi = 96

    return max(0.5, min(4.0, dpi / 96.0))


def get_virtual_screen_bounds() -> tuple:
    """
    获取多显示器虚拟桌面的整体边界 (vx, vy, vw, vh)
    支持副显示器在主屏左侧/上方时的负坐标安全保护
    """
    user32 = ctypes.windll.user32
    vx = user32.GetSystemMetrics(76)  # SM_XVIRTUALSCREEN
    vy = user32.GetSystemMetrics(77)  # SM_YVIRTUALSCREEN
    vw = user32.GetSystemMetrics(78)  # SM_CXVIRTUALSCREEN
    vh = user32.GetSystemMetrics(79)  # SM_CYVIRTUALSCREEN
    if vw <= 0 or vh <= 0:
        vx, vy = 0, 0
        vw = user32.GetSystemMetrics(0)
        vh = user32.GetSystemMetrics(1)
    return vx, vy, vw, vh


def _redraw_wecom(hwnd):
    """强制整窗立即重绘——从托盘恢复/最大化后的 GPU 合成窗口可能保持黑屏"""
    try:
        RDW = 0x0001 | 0x0004 | 0x0080 | 0x0100 | 0x0400  # INVALIDATE|ERASE|ALLCHILDREN|UPDATENOW|FRAME
        ctypes.windll.user32.RedrawWindow(hwnd, None, None, RDW)
        ctypes.windll.user32.UpdateWindow(hwnd)
    except Exception:
        pass


def _is_zoomed(hwnd) -> bool:
    """判断窗口是否已最大化。

    不要用 win32gui.IsZoomed：pywin32 312 并未导出该属性，真机上抛
    AttributeError。ensure_wecom_maximized 的 try/except 会把它吞成一条 WARN，
    使「自动最大化」静默失效 —— 探针在真机上实测到了这个坑。直接走 user32。
    """
    try:
        return bool(ctypes.windll.user32.IsZoomed(hwnd))
    except Exception:
        return False


def ensure_wecom_maximized(timeout: float = 2.0) -> bool:
    """确保企业微信主窗口处于最大化状态且矩形已稳定。返回是否就绪。

    动机：历史上的下拉裁剪宽度上限是 `min(380*scale, ww * 0.45)`，标题条是
    `min(400*scale, ww - 260*scale)`——都带「相对窗口宽度」的封顶，窗口一窄
    就把条目尾部切掉，模型读不全 -> 误判为「查无此人」。最大化后窗口宽度足够，
    这类封顶不再生效；下拉判定已进一步改为整窗截图（capture_wecom_full），
    彻底不再有宽度上限。标题条仍按窗口宽度封顶在 400*scale，故本步骤对它
    依旧是必需的。

    幂等：已最大化时只做一次 IsZoomed 查询即返回，用户中途手动还原也能拉回。
    """
    if not HAS_WIN32:
        return False
    hwnd = get_wecom_hwnd()
    if not hwnd:
        return False
    try:
        if _is_zoomed(hwnd):
            return True
        log("企微窗口未最大化，自动最大化以避免下拉框被裁剪...", "INFO")
        win32gui.ShowWindow(hwnd, win32con.SW_MAXIMIZE)
        _redraw_wecom(hwnd)
        # 轮询直到 GetWindowRect 连续两次相同，确认最大化动画结束、坐标已稳定。
        # 拿未稳定的 rect 去截图会整块偏位。
        last = None
        deadline = time.time() + timeout
        while time.time() < deadline:
            time.sleep(0.12)
            rect = win32gui.GetWindowRect(hwnd)
            if rect == last:
                log(f"企微窗口已最大化并稳定: {rect}", "DEBUG")
                return True
            last = rect
        log("等待企微窗口最大化完成超时，仍按当前矩形继续", "WARN")
        return True
    except Exception as e:
        log(f"企微窗口最大化异常: {e}", "WARN")
        return False


def find_and_activate_wecom() -> bool:
    """查找并自动激活企业微信主窗口（支持最小化恢复与Windows前台锁绕过）"""
    if not HAS_WIN32:
        return False

    wecom_hwnd = get_wecom_hwnd()
    if wecom_hwnd:
        try:
            if win32gui.IsIconic(wecom_hwnd):
                win32gui.ShowWindow(wecom_hwnd, win32con.SW_RESTORE)
                time.sleep(0.15)
            else:
                win32gui.ShowWindow(wecom_hwnd, win32con.SW_SHOW)

            # 从托盘恢复的 GPU 合成窗口可能保持黑屏：强制整窗立即重绘
            _redraw_wecom(wecom_hwnd)

            # 模拟 Alt 键绕过 Windows SetForegroundWindow 权限限制
            ctypes.windll.user32.keybd_event(0x12, 0, 0, 0)  # Alt key down
            win32gui.SetForegroundWindow(wecom_hwnd)
            ctypes.windll.user32.keybd_event(0x12, 0, 2, 0)  # Alt key up
            time.sleep(0.1)
            return True
        except Exception as e:
            log(f"唤醒企微前台窗口异常: {e}", "WARN")
    return False


def is_foreground_wecom() -> bool:
    """检查当前前台窗口是否为企业微信"""
    if not HAS_WIN32:
        return True
    try:
        fg_hwnd = win32gui.GetForegroundWindow()
        if not fg_hwnd:
            return True
        title = win32gui.GetWindowText(fg_hwnd)
        cls = win32gui.GetClassName(fg_hwnd)
        if "WeWorkWindow" in cls or "企业微信" in title or "WXWork" in cls or "WeChat" in cls:
            return True
        return False
    except Exception:
        return True


def dismiss_and_clear_search():
    """安全退出搜索下拉浮层并彻底清空搜索输入框，杜绝残留文字或焦点干扰后续操作"""
    try:
        pyautogui.hotkey("ctrl", "f")
        time.sleep(0.08)
        pyautogui.hotkey("ctrl", "a")
        time.sleep(0.05)
        pyautogui.press("backspace")
        time.sleep(0.08)
        pyautogui.press("esc")
        time.sleep(0.05)
        pyautogui.press("esc")
    except Exception as e:
        log(f"清空搜索框异常: {e}", "DEBUG")


def _save_debug_header_shot(crop_img, target_id: str, target_name: str, header_text: str, tag: str):
    """保存标题检查点现场快照用于事后审计与排查"""
    if not crop_img:
        return
    try:
        os.makedirs(DEBUG_IMG_DIR, exist_ok=True)
        safe_name = re.sub(r'[\\/:*?"<>|\s]', '_', f"{target_id}_{target_name}").strip('_') or "unknown"
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
        shot_path = os.path.join(DEBUG_IMG_DIR, f"{ts}_header_{tag}_{safe_name}.png")
        crop_img.save(shot_path)
        log(f"[标题检查点快照] 已归档至: {shot_path}", "DEBUG")
    except Exception:
        pass


def verify_chat_header_title_via_ocr(wecom_rect: tuple, target_id: str, target_name: str, timeout: float = 1.2) -> tuple:
    """
    【模式 B：会话标题安全检查点 (本地 OCR 轮询)】
    回车进入会话后，带超时的谓词异步轮询（默认最长 timeout 秒，每 80ms 采样一次），
    动态按当前屏幕 DPI 缩放截取企微主窗口右侧聊天区域顶部的标题条，
    核验当前打开的会话是否确实为目标学生（如 '80001李四 @微信'）。

    返回: (status, detected_title)
      - "MATCH": 标题包含目标学号或目标姓名，核验通过！
      - "MISMATCH": 标题包含其他联系人姓名/学号且不含目标，确凿误选！
      - "UNCERTAIN": 未能在顶部读取到有效文本或无法确切判定
    """
    if not wecom_rect or not HAS_OCR:
        return "UNCERTAIN", ""

    wx, wy, ww, wh = wecom_rect
    wecom_hwnd = get_wecom_hwnd()
    scale = get_display_scale(wecom_hwnd)
    vx, vy, vw, vh = get_virtual_screen_bounds()

    # 以 100% 缩放 (96 DPI) 为基准：
    # 左侧导航与会话列表约 240px，标题高度约 52px
    offset_x = int(240 * scale)
    offset_y = int(4 * scale)
    base_w = int(400 * scale)
    base_h = int(52 * scale)

    crop_x = max(vx, wx + offset_x)
    crop_y = max(vy, wy + offset_y)
    crop_w = max(int(160 * scale), min(base_w, max(200, ww - int(260 * scale))))
    crop_h = max(int(40 * scale), base_h)

    # 确保裁剪区域不超出虚拟桌面总边界
    if crop_x + crop_w > vx + vw:
        crop_w = max(50, (vx + vw) - crop_x)
    if crop_y + crop_h > vy + vh:
        crop_h = max(30, (vy + vh) - crop_y)

    start_time = time.time()
    last_detected = ""
    rapid_engine = get_rapid_ocr()

    while time.time() - start_time < timeout:
        crop_img = None
        try:
            crop_img = pyautogui.screenshot(region=(crop_x, crop_y, crop_w, crop_h))
            header_text = ""
            if rapid_engine is not None:
                import numpy as np
                res, _ = rapid_engine(np.array(crop_img.convert("RGB")))
                if res:
                    header_text = "".join(item[1].replace(" ", "") for item in res)
            elif HAS_WINOCR:
                res_win = asyncio.run(winocr.recognize_pil(crop_img, lang="zh-Hans-CN"))
                header_text = "".join(l.text.replace(" ", "") for l in res_win.lines)

            if header_text:
                last_detected = header_text
                # 1. 匹配目标学号加姓名 (必须完全同时匹配放行)
                is_full_match = False
                if target_id and target_name:
                    is_full_match = (target_id in header_text) and (target_name in header_text)
                elif target_id:
                    is_full_match = target_id in header_text
                elif target_name:
                    is_full_match = target_name in header_text

                if is_full_match:
                    log(f"[标题检查点 ✓ 放行] 标题完全命中目标: '{header_text}' (预期: id='{target_id}', name='{target_name}')", "INFO")
                    return "MATCH", header_text

                # 2. 误选判据 A：包含明确的其他数字学号（4-6位数字）且不含目标
                id_matches = re.findall(r'\b\d{4,6}\b', header_text)
                if id_matches and target_id and target_id not in id_matches:
                    log(f"[标题检查点 ✗ 误选拦截] 标题为其他学生学号: '{header_text}' (预期: id='{target_id}', name='{target_name}')", "WARN")
                    _save_debug_header_shot(crop_img, target_id, target_name, header_text, "mismatch")
                    return "MISMATCH", header_text

                # 3. 误选判据 B：包含 '@' 或 '@微信' 且不含目标姓名与目标学号
                if ("@微信" in header_text or "@" in header_text) and target_name and target_name not in header_text:
                    log(f"[标题检查点 ✗ 误选拦截] 标题为其他联系人: '{header_text}' (预期: id='{target_id}', name='{target_name}')", "WARN")
                    _save_debug_header_shot(crop_img, target_id, target_name, header_text, "mismatch")
                    return "MISMATCH", header_text

        except Exception as e:
            log(f"标题检查点识别异常: {e}", "DEBUG")

        time.sleep(0.08)

    if last_detected:
        is_full_match = False
        if target_id and target_name:
            is_full_match = (target_id in last_detected) and (target_name in last_detected)
        elif target_id:
            is_full_match = target_id in last_detected
        elif target_name:
            is_full_match = target_name in last_detected

        if is_full_match:
            return "MATCH", last_detected
        else:
            return "MISMATCH", last_detected

    return "UNCERTAIN", ""


def verify_chat_header_title(wecom_rect: tuple, target_id: str, target_name: str, timeout: float = 1.2, mode: str = "A", auto_fallback: bool = True) -> tuple:
    """
    【会话标题安全检查点 (Check Point) 总控】
    回车进入会话后执行二次验证，支持模式 A (Qwen3.8-Flash 大模型) 与模式 B (本地 OCR 引擎)。
    自动消除切换残影，核验当前会话标题是否为目标学生/家长。
    返回: (status, detected_title)
      - 'MATCH': 核验通过
      - 'MISMATCH': 确凿误选（进入了他人聊天）
      - 'UNCERTAIN': 未知或无法确认
    """
    if not wecom_rect:
        return "UNCERTAIN", ""

    if mode == "A":
        # 1. 消除企微会话切换动画的残影 (延时 0.35s)
        time.sleep(0.35)
        crop_img = capture_header_crop(wecom_rect)
        if crop_img:
            status, detected_title = verify_chat_header_title_via_vlm(crop_img, target_id, target_name)
            if status in ("MATCH", "MISMATCH"):
                if status == "MISMATCH":
                    _save_debug_header_shot(crop_img, target_id, target_name, detected_title, "vlm_mismatch")
                return status, detected_title

            # status 为 ERROR 或 UNCERTAIN
            if auto_fallback and HAS_OCR:
                log(f"云端标题核验异常/存疑 ({detected_title})，自动无缝切换至本地备用引擎...", "WARN")
                return verify_chat_header_title_via_ocr(wecom_rect, target_id, target_name, timeout=timeout)
            return status, detected_title
        else:
            if auto_fallback and HAS_OCR:
                log("截取标题条失败，自动切换至本地备用引擎...", "WARN")
                return verify_chat_header_title_via_ocr(wecom_rect, target_id, target_name, timeout=timeout)
            return "UNCERTAIN", ""

    elif mode == "B":
        if HAS_OCR:
            return verify_chat_header_title_via_ocr(wecom_rect, target_id, target_name, timeout=timeout)
        log("本地标题核验跳过: 未安装可用本地 OCR 引擎", "WARN")
        return "UNCERTAIN", ""

    return "UNCERTAIN", ""


# ============================================================
# 云端诊断（自动后台上报，供管理员远程协助排查）
# - 启动时上传诊断日志、退出时追加上传发送历史；daemon 线程，不阻塞界面；
#   全程无弹窗。上报方以机器指纹标识（未核验来源，仅供排查参考）。
# - 服务端：api/desktop.php（匿名机器上报 + 教师账号兼容）。
# ============================================================

DEFAULT_CLOUD_SERVER = "https://feedback.wxjifang.cn"
CLOUD_LOG_TAIL_LINES = 300

# 本地日志级别 -> 服务端级别（服务端只认 info/warn/error/action）
_LOG_LEVEL_MAP = {
    "DEBUG": "info",
    "INFO": "info",
    "WARN": "warn",
    "WARNING": "warn",
    "ERROR": "error",
}


def machine_tag() -> str:
    """本机指纹（服务端匿名上报的身份标识）：计算机名清洗，不可用则用 pc"""
    name = (os.environ.get("COMPUTERNAME") or os.environ.get("HOSTNAME") or "pc").strip()
    name = re.sub(r"[^A-Za-z0-9_\-]", "", name) or "pc"
    return name[:40]


def cloud_post(server: str, action: str, payload: dict, timeout: int = 20) -> dict:
    """向云端诊断接口 POST JSON，返回解析后的 dict；失败抛 RuntimeError（消息可直接展示）"""
    import urllib.request
    import urllib.error
    server = (server or "").strip().rstrip("/")
    if not server.startswith(("http://", "https://")):
        raise RuntimeError("服务器地址必须以 http:// 或 https:// 开头")
    url = f"{server}/api/desktop.php?action={action}"
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": f"JF-Feedback-Sender/{APP_VERSION}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read().decode("utf-8", errors="replace"))
            msg = detail.get("error") or detail.get("message") or f"HTTP {e.code}"
            raise RuntimeError(f"服务器返回: {msg}")
        except RuntimeError:
            raise
        except Exception:
            raise RuntimeError(f"服务器返回 HTTP {e.code}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"网络连接失败：{e.reason}")
    except Exception as e:
        raise RuntimeError(f"请求异常：{e}")
    try:
        data = json.loads(raw)
    except Exception:
        raise RuntimeError("服务器返回了无法解析的内容")
    if not isinstance(data, dict) or not data.get("success"):
        raise RuntimeError((data.get("error") if isinstance(data, dict) else None) or "上传被服务器拒绝")
    return data.get("data") or {}


def image_to_base64_jpeg(pil_img: Image.Image, quality: int = 85) -> str:
    """将 PIL 图像转换为 base64 编码的 JPEG 字符串"""
    import io
    import base64
    buf = io.BytesIO()
    rgb_img = pil_img.convert("RGB")
    rgb_img.save(buf, format="JPEG", quality=quality)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


# 各视觉任务的独立超时（秒）。dropdown 送的是整窗原图，payload 远大于 header
# 的窄标题条，沿用 10s 会频繁超时并静默降级成「按第 1 项试探」，白白浪费一轮。
VISION_TIMEOUT = {"dropdown": 30.0, "header": 10.0, "chatview": 30.0}
DEFAULT_VISION_TIMEOUT = 10.0


def call_cloud_vision(task: str, crop_img: Image.Image, target_id: str, target_name: str, timeout: float = 0.0) -> dict:
    """
    向服务端 api/desktop.php?action=vision_detect 发起大模型视觉分析请求。
    task: 'chatview'（当前主流程唯一使用：一次调用同时取身份/is_group/needs_reply）
          'header'（旧版窄标题条路径，仅保留给历史日志排查与模式 B 回退对照）
          'dropdown'（v2.5.x 的下拉选人，v2.6.0 起已从主流程删除）
    timeout<=0 时取 VISION_TIMEOUT[task]。
    返回: dict (含 matched/detected_title/title_in_header/is_group/last_sender/
                last_message_text/needs_reply/reason/duration_ms)
    """
    if timeout <= 0:
        timeout = VISION_TIMEOUT.get(task, DEFAULT_VISION_TIMEOUT)
    if not crop_img:
        return {"success": False, "error": "截屏图像为空"}
    try:
        b64_str = image_to_base64_jpeg(crop_img)
        payload = {
            "client": machine_tag(),
            "task": task,
            "target_id": target_id,
            "target_name": target_name,
            "image": f"data:image/jpeg;base64,{b64_str}"
        }
        res = cloud_post(DEFAULT_CLOUD_SERVER, "vision_detect", payload, timeout=int(timeout + 1))
        if isinstance(res, dict):
            res["success"] = True
            return res
        return {"success": False, "error": "服务端未返回有效数据字典"}
    except Exception as e:
        log(f"[大模型{task}视觉请求异常]: {e}", "WARN")
        return {"success": False, "error": str(e)}


# ============================================================
# 窗口抓帧层：Windows Graphics Capture (WGC)
# ------------------------------------------------------------
# 选 WGC 的实证依据（probe_wgc.py 真机取证，见 probe_out/）：
#   - wgc-visible：1240x1015、mean=226.92、380ms、非黑 → 可用
#   - wgc-minimized 与 wgc-visible 的 md5 **完全相同**，耗时 5104ms
#     → WGC 在拿不到新表面时会返回**缓存旧帧而不报错**，故必须自己判新鲜度
#   - PyAutoGUI 在窗口出屏时会截出纯黑条（见 _capture_wecom_full_via_screen 注释）
#
# windows-capture 的两个硬约束（务必记住）：
#   1. Python 接口只接受 window_name（窗口标题），**不接受 hwnd** → 按标题匹配
#      可能抓错同名窗口，故标题从 hwnd 实时取，取不到才退回硬编码的「企业微信」。
#   2. 是**事件回调式**（@capture.event + capture.start() 阻塞），没有同步单张
#      接口；且真机上「紧接上一个会话后建新会话」会抛 `Failed to initialize
#      WinRT`，故必须退避重试。
# ============================================================

_WGC_CLASS = None    # windows_capture.WindowsCapture；None = 不可用
_WGC_PROBED = False  # 惰性探测只做一次，失败后不再重复 import


def _load_wgc_class():
    """惰性导入 windows_capture 并缓存结果（失败只警告一次，不刷屏）。"""
    global _WGC_CLASS, _WGC_PROBED
    if _WGC_PROBED:
        return _WGC_CLASS
    _WGC_PROBED = True
    try:
        from windows_capture import WindowsCapture
        _WGC_CLASS = WindowsCapture
        log("已启用 Windows Graphics Capture (WGC) 抓帧：整窗截图不再受出屏/遮挡影响", "INFO")
    except Exception as e:
        _WGC_CLASS = None
        log(f"未安装 windows-capture，整窗抓帧回退 PyAutoGUI（窗口出屏或被遮挡时会截不全）: {e}", "WARN")
    return _WGC_CLASS


def get_wecom_window_title() -> str:
    """取企微主窗口标题。windows_capture 只认标题不认 hwnd，这里从 hwnd 实时取，
    取不到才退回硬编码值——硬编码只在拿不到 hwnd 时用。"""
    if HAS_WIN32:
        try:
            import win32gui
            hwnd = get_wecom_hwnd()
            if hwnd:
                title = (win32gui.GetWindowText(hwnd) or "").strip()
                if title:
                    return title
        except Exception:
            pass
    return "企业微信"


def _grab_via_wgc_once(window_title: str, png_path: str) -> str:
    """建一次 WGC 会话抓一帧存到 png_path。返回 "" 表示成功，否则返回错误描述。"""
    cls = _load_wgc_class()
    if cls is None:
        return "windows-capture 不可用"

    done = Event()
    errors = []

    def on_frame(frame, control):
        try:
            frame.save_as_image(png_path)
        except Exception as e:
            errors.append(f"save_as_image: {e}")
        finally:
            try:
                control.stop()
            except Exception:
                pass
            done.set()

    def on_closed():
        done.set()

    try:
        capture = cls(
            cursor_capture=None,
            draw_border=None,
            monitor_index=None,
            window_name=window_title,
        )
    except Exception as e:
        return f"建会话对象失败: {e}"

    try:
        capture.event(on_frame)
        capture.event(on_closed)
    except Exception as e:
        return f"注册回调失败: {e}"

    def run():
        try:
            capture.start()   # 阻塞，直到 on_frame 里 control.stop()
        except Exception as e:
            errors.append(str(e))
            done.set()

    th = Thread(target=run, daemon=True)
    th.start()
    # start() 是阻塞的：窗口最小化 / 无新帧 / 标题匹配不到窗口时它可能永不返回。
    # 这里必须有硬超时，否则整条发送线程会被永久挂死。
    if not done.wait(WGC_FRAME_TIMEOUT):
        return f"等待首帧超过 {WGC_FRAME_TIMEOUT}s（窗口可能被最小化，或标题 {window_title!r} 未匹配到窗口）"

    if errors:
        return str(errors[0])
    return ""


def grab_wecom_via_wgc(retries: int = WGC_RETRIES):
    """用 WGC 抓企微整窗。成功返回 PIL Image，失败返回 None（调用方走 PyAutoGUI 兜底）。

    退避重试的理由：真机上「紧接上一个 WGC 会话结束后立刻建新会话」会抛
    `Failed to initialize WinRT`，间隔 0.8s/1.6s 后成功率显著提高。
    """
    if _load_wgc_class() is None:
        return None

    title = get_wecom_window_title()
    fd, png_path = tempfile.mkstemp(prefix="wgc_", suffix=".png")
    os.close(fd)
    last_err = "未知原因"
    try:
        for attempt in range(retries + 1):
            if attempt:
                time.sleep(0.8 * attempt)

            err = _grab_via_wgc_once(title, png_path)
            if err:
                last_err = err
                log(f"[WGC] 第 {attempt + 1}/{retries + 1} 次抓帧失败: {err}", "WARN")
                continue

            # save_as_image 的落盘与 start() 返回之间没有显式完成保证，0 字节时稍等
            for _ in range(10):
                if os.path.exists(png_path) and os.path.getsize(png_path) > 0:
                    break
                time.sleep(0.1)

            if not os.path.exists(png_path) or os.path.getsize(png_path) == 0:
                last_err = "回调已触发但 PNG 为 0 字节"
                continue

            try:
                img = Image.open(png_path)
                img.load()   # 必须在 remove 之前把像素读进来
                return img
            except Exception as e:
                last_err = f"读取 PNG 失败: {e}"
                continue

        log(f"[WGC] 抓帧彻底失败（已尝试 {retries + 1} 次，回退 PyAutoGUI）: {last_err}", "WARN")
        return None
    finally:
        try:
            os.remove(png_path)
        except Exception:
            pass


def capture_wecom_full(wecom_rect: tuple):
    """截取企业微信主窗口**整窗**区域（会话身份 + 待回消息判定共用一张图）。

    抓帧优先级：Windows Graphics Capture (WGC) → PyAutoGUI 屏幕像素。

    为什么必须走 WGC：PyAutoGUI 截的是屏幕像素，真机已抓到实证——
      1. 【出屏】企微窗口摆在 y=1212、约 77% 悬在屏幕下边缘外时，截图第 7~29 行
         纯黑（亮度 0），模型看到的是「半个窗口」；
      2. 【遮挡】任何置顶窗口（含本工具自己的 Tk 主窗口、告警条）压住企微时，
         截到的是别人的画面。
    WGC 直接向合成器要窗口表面，与屏幕位置、被谁遮挡完全无关。

    仍保留 PyAutoGUI 兜底（未装 windows-capture / WGC 建会话失败时），
    此时行为退化为旧版，但至少不会因为没有 WGC 就完全不可用。

    注意：会话核验的放行判据是 `target_id in detected_title and
    target_name in detected_title`，模型一旦把聊天区正文也转录进 detected_title，
    别人会话里出现过目标学号+姓名就会造成误判 MATCH。因此 detected_title 侧有
    两道本地防线（judge_chat_identity）：长度封顶 + title_in_header 标记。
    """
    img = grab_wecom_via_wgc()
    if img is not None:
        return img
    return _capture_wecom_full_via_screen(wecom_rect)


def _capture_wecom_full_via_screen(wecom_rect: tuple):
    """PyAutoGUI 兜底整窗截图：按虚拟屏幕边界裁剪，窗口出屏时只取可见部分。"""
    if not wecom_rect:
        return None
    try:
        wx, wy, ww, wh = wecom_rect
        vx, vy, vw, vh = get_virtual_screen_bounds()
        crop_x, crop_y = max(vx, wx), max(vy, wy)
        crop_w = min(ww, vx + vw - crop_x)
        crop_h = min(wh, vy + vh - crop_y)
        if crop_w < 200 or crop_h < 200:
            log(f"企微窗口尺寸异常({crop_w}x{crop_h})，放弃整窗截图", "WARN")
            return None
        return pyautogui.screenshot(region=(crop_x, crop_y, crop_w, crop_h))
    except Exception as e:
        log(f"截取企微整窗异常: {e}", "WARN")
        return None


def _frames_identical(a, b) -> bool:
    """逐像素比较两张图是否完全一致（用于「等画面渲染稳定」）。"""
    if a is None or b is None:
        return False
    try:
        if a.size != b.size:
            return False
        return a.convert("RGB").tobytes() == b.convert("RGB").tobytes()
    except Exception:
        return False


def capture_chat_view_stable(wecom_rect: tuple, settle_interval: float = WGC_SETTLE_INTERVAL,
                             settle_timeout: float = WGC_SETTLE_TIMEOUT):
    """抓一张「画面已经稳定」的企微整窗图。

    为什么必须等稳定：按回车后企微是渐进渲染的（标题栏先出、消息气泡后出），
    立刻截图会拍到半张画面；而 WGC 在最小化等场景下已被实证会**返回缓存旧帧而
    不报错**（probe_out 里 wgc-minimized.png 与 wgc-visible.png md5 完全相同）。
    所以这里连拍两帧比对：一致 = 画面已静止，可以采信；不一致就继续等，直到
    settle_timeout 仍然拿不到稳定帧，才退回最后一帧。

    注意：这只挡住「正在渲染」和「尺寸还在变」，**挡不住**内容完全静止的陈旧
    缓存帧。真机若证明 WGC 会回旧帧，唯一可靠的补救是让判定 fail-closed
    （judge_chat_identity 对读不到标题栏一律 UNCERTAIN），而不是放宽判据。
    """
    prev = capture_wecom_full(wecom_rect)
    if prev is None:
        return None

    deadline = time.monotonic() + settle_timeout
    shots = 1
    while time.monotonic() < deadline:
        time.sleep(settle_interval)
        cur = capture_wecom_full(wecom_rect)
        shots += 1
        if cur is None:
            continue
        if _frames_identical(prev, cur):
            log(f"[抓帧] 连拍 {shots} 帧一致，判定画面已稳定（{prev.size[0]}x{prev.size[1]}）", "DEBUG")
            return cur
        prev = cur

    log(f"[抓帧] {settle_timeout}s 内未取得稳定帧（已拍 {shots} 帧），退回最后一帧", "WARN")
    return prev


def capture_header_crop(wecom_rect: tuple):
    """动态 DPI 自适应截取企微聊天窗口顶部标题条区域 (约 400x52 物理像素)"""
    if not wecom_rect:
        return None
    try:
        wx, wy, ww, wh = wecom_rect
        wecom_hwnd = get_wecom_hwnd()
        scale = get_display_scale(wecom_hwnd)
        vx, vy, vw, vh = get_virtual_screen_bounds()

        offset_x = int(240 * scale)
        offset_y = int(4 * scale)
        base_w = int(400 * scale)
        base_h = int(52 * scale)

        crop_x = max(vx, wx + offset_x)
        crop_y = max(vy, wy + offset_y)
        crop_w = max(int(160 * scale), min(base_w, max(200, ww - int(260 * scale))))
        crop_h = max(int(40 * scale), base_h)

        if crop_x + crop_w > vx + vw:
            crop_w = max(50, (vx + vw) - crop_x)
        if crop_y + crop_h > vy + vh:
            crop_h = max(30, (vy + vh) - crop_y)

        return pyautogui.screenshot(region=(crop_x, crop_y, crop_w, crop_h))
    except Exception as e:
        log(f"截取标题条区域异常: {e}", "WARN")
        return None



# 会话标题长度上限（物理字符）。企微的会话名都很短（「90001张三（家长）」这类），
# 模型若把聊天区正文也当成标题塞进 detected_title，长度必然远超这个量级。
# 这是「模型误把聊天记录当标题」的最后一道本地拦截，替代旧版「靠窄裁剪保证图里
# 只有标题」的结构性保证 —— 整窗图里还有聊天区，必须补这道长度防线。
CHAT_TITLE_MAX_LEN = 15


def _empty_chat_res(error: str = "") -> dict:
    """抓帧失败 / 接口故障时的空判定结果。status 直接给 ERROR → fail-closed 拦截。"""
    return {
        "status": "ERROR",
        "error": error,
        "detected_title": "",
        "title_in_header": False,
        "is_group": False,
        "model_matched": False,
        "last_sender": "unknown",
        "last_message_text": "",
        "needs_reply": None,
        "reason": "",
    }


def inspect_chat_view_via_vlm(crop_img, target_id: str, target_name: str) -> dict:
    """一次云端视觉调用，同时取回「会话身份」与「是否有待回消息」。

    旧流程是两张图两次调用（下拉选人 + 窄标题条核验）。现在下拉选人已删除、
    标题条必须换整窗（否则看不见聊天内容），两者合并为一次整窗调用：

      身份（fail-closed，判不出=拦截）：detected_title / title_in_header / is_group
      待回（fail-open，判不出=照发）：last_sender / last_message_text / needs_reply

    两个方向**相反**，务必别写反：
      身份闸门判不出来 → 绝不发（少发一条反馈可以补，误发一条是事故）；
      待回名单判不出来 → 标「待人工确认」照发（宁可让老师多回一条消息）。
    """
    res = call_cloud_vision("chatview", crop_img, target_id, target_name)
    if not res.get("success"):
        return _empty_chat_res(res.get("error", "VLM 接口调用失败"))

    detected_title = str(res.get("detected_title", "") or "").strip()
    model_matched = bool(res.get("matched", False))
    title_in_header = res.get("title_in_header")
    is_group = bool(res.get("is_group", False))

    # 模型没给 title_in_header 时不许默认 True：那等于放弃这道防线。
    # 缺字段一律按「没能从标题栏读到标题」处理 → UNCERTAIN → fail-closed。
    if title_in_header is None:
        title_in_header = False

    last_sender = str(res.get("last_sender", "unknown") or "unknown").strip().lower()
    if last_sender not in ("parent", "me", "unknown"):
        last_sender = "unknown"

    needs_reply = res.get("needs_reply", None)
    if isinstance(needs_reply, bool):
        pass
    elif isinstance(needs_reply, (int, float)) and needs_reply in (0, 1):
        needs_reply = bool(needs_reply)
    elif isinstance(needs_reply, str):
        _s = needs_reply.strip().lower()
        if _s in ("true", "yes", "1", "是", "需要", "需回", "需要回复", "要回"):
            needs_reply = True
        elif _s in ("false", "no", "0", "否", "不需要", "无需", "不用回"):
            needs_reply = False
        else:
            needs_reply = None      # 模型给的不是可识别结论 → 判不出，按「待人工确认」处理

    out = {
        "status": None,
        "error": "",
        "detected_title": detected_title,
        "title_in_header": bool(title_in_header),
        "is_group": is_group,
        "model_matched": model_matched,
        "last_sender": last_sender,
        "last_message_text": str(res.get("last_message_text", "") or "").strip(),
        "needs_reply": needs_reply,
        "reason": str(res.get("reason", "") or ""),
    }
    out["status"] = judge_chat_identity(out, target_id, target_name)
    log(
        f"[大模型会话判定] status={out['status']}, title='{detected_title}', "
        f"title_in_header={out['title_in_header']}, is_group={is_group}, "
        f"last_sender={last_sender}, needs_reply={needs_reply}, reason='{out['reason']}'",
        "INFO",
    )
    return out


def judge_chat_identity(res: dict, target_id: str, target_name: str) -> str:
    """【唯一放行闸门】从模型返回值里裁决会话身份。fail-closed：判不出即不放行。

    返回 "MATCH" | "MISMATCH" | "UNCERTAIN"
      - MISMATCH:  有确凿反证（是群 / 标题明确是别人 / 标题被聊天正文污染）
      - UNCERTAIN: 读不出可信标题（缺 title_in_header、标题为空、模型报错），
                   与 MISMATCH 一样**不放行**，但日志与状态文案区分开，
                   便于老师分辨「进错了」和「没看清」。
    """
    if res.get("is_group"):
        # 群聊拦截：整窗图里能看到群成员数与头像拼图，这是图像证据，不是靠
        # 「群名不会恰好同时含学号和姓名」这种假设（旧版 TODO 的根治路径）。
        return "MISMATCH"

    detected_title = (res.get("detected_title") or "").strip()
    if not detected_title:
        return "UNCERTAIN"
    if not res.get("title_in_header"):
        return "UNCERTAIN"
    if len(detected_title) > CHAT_TITLE_MAX_LEN:
        log(
            f"[身份判定纠偏] 标题 '{detected_title}' 长度 {len(detected_title)} 超过上限 "
            f"{CHAT_TITLE_MAX_LEN}，判定为模型把聊天正文当成了标题，拒绝放行",
            "WARN",
        )
        return "MISMATCH"

    if target_id and target_name:
        if not (target_id in detected_title and target_name in detected_title):
            log(
                f"[身份判定纠偏] 标题 '{detected_title}' 未同时包含学号 '{target_id}' 与姓名 "
                f"'{target_name}'，拒绝放行（模型 matched={res.get('model_matched')}）",
                "WARN",
            )
            return "MISMATCH"
    elif target_id and target_id not in detected_title:
        log(f"[身份判定纠偏] 标题 '{detected_title}' 不含学号 '{target_id}'，拒绝放行", "WARN")
        return "MISMATCH"
    elif target_name and target_name not in detected_title:
        log(f"[身份判定纠偏] 标题 '{detected_title}' 不含姓名 '{target_name}'，拒绝放行", "WARN")
        return "MISMATCH"

    return "MATCH"


def reply_note_verdict(note: dict) -> str:
    """把一次会话的待回信息归成三档，供 app 名单展示（纯展示，不参与放行）。"""
    need = note.get("needs_reply")
    if need is True:
        return "需回"
    if need is False:
        return "无需回"
    return "待人工确认"


def verify_chat_header_title_via_vlm(crop_img, target_id: str, target_name: str) -> tuple:
    """
    旧版「窄标题条 + 云端视觉」核验路径。v2.6.0 起主流程改用
    inspect_chat_view_via_vlm（整窗、一次调用同时取身份与待回信息），本函数仅保留：
      - 供历史日志/旧版截图复现时对照排查；
      - verify_chat_header_title(mode="A") 分支的入口（该分支当前主流程不再走）。
    返回: (status, detected_title)
    """
    res = call_cloud_vision("header", crop_img, target_id, target_name)
    if not res.get("success"):
        return "ERROR", res.get("error", "VLM 接口调用失败")
    matched = res.get("matched", False)
    detected_title = res.get("detected_title", "")
    reason = res.get("reason", "")
    log(f"[大模型标题核验] matched={matched}, title='{detected_title}', reason='{reason}'", "INFO")
    if matched:
        # 双重防御：标题必须完全同时包含学号与姓名
        if target_id and target_name:
            if not (target_id in detected_title and target_name in detected_title):
                log(f"[大模型标题核验纠偏] 警告：模型返回 matched=True 但标题 '{detected_title}' 未同时包含学号 '{target_id}' 与姓名 '{target_name}'，修正为 MISMATCH", "WARN")
                return "MISMATCH", f"{detected_title}"
        elif target_id and target_id not in detected_title:
            log(f"[大模型标题核验纠偏] 警告：模型返回 matched=True 但标题 '{detected_title}' 不含学号 '{target_id}'，修正为 MISMATCH", "WARN")
            return "MISMATCH", f"{detected_title}"
        elif target_name and target_name not in detected_title:
            log(f"[大模型标题核验纠偏] 警告：模型返回 matched=True 但标题 '{detected_title}' 不含姓名 '{target_name}'，修正为 MISMATCH", "WARN")
            return "MISMATCH", f"{detected_title}"
        return "MATCH", f"{detected_title}"
    else:
        return "MISMATCH", f"{detected_title}"


def parse_log_entries(limit: int = CLOUD_LOG_TAIL_LINES, align_task: bool = True) -> list:
    """读取本地日志末尾，解析为 [{ts, level, msg}]（纯函数，可单测）。
    align_task=True 时优先对齐到最近一次“批量发送任务启动”，保证至少一个
    完整任务（启动参数→逐人轨迹→结束统计）不断头；硬上限 1000 行兜底。
    找不到任务标记时回退为普通末尾 limit 行。"""
    entries = []
    try:
        if not os.path.isfile(LOG_FILE_PATH):
            return entries
        with open(LOG_FILE_PATH, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except Exception:
        return entries
    if not lines:
        return entries
    TASK_MARK = "批量发送任务启动"
    HARD_CAP = 1000
    if align_task:
        # 只在最近 1000 行内找任务头：找到了就整段带上（天然 ≤1000），
        # 找不到（任务超大或无任务）就回退普通截尾，把上传体积封顶。
        window = lines[-HARD_CAP:]
        start = None
        for i, line in enumerate(window):
            if TASK_MARK in line:
                start = i
        if start is None:
            selected = lines[-limit:]
        else:
            selected = window[start:]
    else:
        selected = lines[-limit:]
    pattern = re.compile(r"^\[(?P<ts>[^\]]+)\]\s*\[(?P<level>[A-Za-z]+)\]\s*(?P<msg>.*)$")
    for line in selected:
        line = line.rstrip("\n")
        if not line.strip():
            continue
        m = pattern.match(line)
        if m:
            entries.append({
                "ts": m.group("ts")[:40],
                "level": _LOG_LEVEL_MAP.get(m.group("level").upper(), "info"),
                "msg": m.group("msg")[:2000],
            })
        else:
            entries.append({"ts": "", "level": "info", "msg": line[:2000]})
    return entries


def read_history_payload() -> dict:
    """读取本机发送历史 JSON（调用方为后台自动上报）"""
    p = os.path.join(get_data_dir(), "feedback_history.json")
    if not os.path.isfile(p):
        raise RuntimeError("本机暂无发送历史记录")
    with open(p, "r", encoding="utf-8", errors="replace") as f:
        data = json.load(f)
    if not isinstance(data, dict) or not data:
        raise RuntimeError("发送历史为空，无需上传")
    return data


def cloud_upload_async(include_history: bool = False) -> "Thread":
    """后台线程上报诊断日志（+可选发送历史），失败仅记本地 DEBUG，不打扰用户。
    返回线程对象，调用方可 join(timeout) 做有限等待。"""
    from threading import Thread

    def _work():
        tag = machine_tag()
        try:
            entries = parse_log_entries()
            # 服务端单次最多收 100 条，超了按 100 切片分批发（仍在 30次/分钟 限频内）
            total = 0
            for i in range(0, len(entries), 100):
                try:
                    data = cloud_post(DEFAULT_CLOUD_SERVER, "upload_logs",
                                      {"client": tag, "version": APP_VERSION, "entries": entries[i:i + 100]})
                    total += int(data.get("saved", 0))
                except Exception as e:
                    log(f"云端诊断日志分片上传失败[{i // 100 + 1}]: {e}", "DEBUG")
                    break
            if entries:
                log(f"云端诊断日志已自动上报：{total}/{len(entries)} 条", "DEBUG")
        except Exception as e:
            log(f"云端诊断日志自动上报失败: {e}", "DEBUG")
        if not include_history:
            return
        try:
            payload = read_history_payload()
        except Exception:
            return
        try:
            data = cloud_post(DEFAULT_CLOUD_SERVER, "upload_history",
                              {"client": tag, "version": APP_VERSION, "history": payload})
            log(f"云端发送历史已自动上报：{data.get('bytes', 0)} 字节", "DEBUG")
        except Exception as e:
            log(f"云端发送历史自动上报失败: {e}", "DEBUG")

    t = Thread(target=_work, daemon=True)
    t.start()
    return t


class HistoryManager:
    """负责跨班级/文件/周次的发送历史持久化与统计管理"""
    def __init__(self, storage_path: str = None):
        if storage_path is None:
            storage_path = os.path.join(get_data_dir(), "feedback_history.json")
        self.storage_path = storage_path
        self._data = {"classes": {}}
        self.load()

    def load(self):
        if os.path.exists(self.storage_path):
            try:
                with open(self.storage_path, "r", encoding="utf-8") as f:
                    content = f.read().strip()
                    if content:
                        self._data = json.loads(content)
                if "classes" not in self._data or not isinstance(self._data["classes"], dict):
                    self._data = {"classes": {}}
                # 向后平滑兼容：补充缺失的 cycle 属性
                for k, entry in list(self._data["classes"].items()):
                    if not isinstance(entry, dict):
                        continue
                    if "cycle" not in entry or not entry["cycle"]:
                        cyc = detect_cycle_from_string(entry.get("file_name", "")) or detect_cycle_from_string(entry.get("class_name", "")) or "第 1 周"
                        entry["cycle"] = cyc
                    if "class_name" not in entry or not entry["class_name"]:
                        entry["class_name"] = clean_class_name_from_path(entry.get("file_name", k))
            except Exception as e:
                print(f"读取历史记录文件异常: {e}")
                self._data = {"classes": {}}
        else:
            self._data = {"classes": {}}

    def save(self):
        try:
            os.makedirs(os.path.dirname(os.path.abspath(self.storage_path)), exist_ok=True)
            with open(self.storage_path, "w", encoding="utf-8") as f:
                json.dump(self._data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"保存历史记录异常: {e}")

    def _build_archive_key(self, class_name: str, cycle: str) -> str:
        c_name = (class_name or "未命名班级").strip()
        cyc = (cycle or "第 1 周").strip()
        return f"{c_name} [{cyc}]"

    def _resolve_archive_key(self, file_path_or_name: str, cycle: str = "") -> str:
        """根据文件名或路径及周次，解析或匹配档案的主键"""
        if not file_path_or_name:
            return ""
        cyc = (cycle or "").strip()

        # 1. 直接命中现有 key (若指定了 cycle，则必须匹配该 entry 的 cycle)
        if file_path_or_name in self._data["classes"]:
            entry = self._data["classes"][file_path_or_name]
            if not cyc or entry.get("cycle") == cyc:
                return file_path_or_name

        c_name = clean_class_name_from_path(file_path_or_name)
        f_name = os.path.basename(file_path_or_name)
        if not cyc:
            cyc = detect_cycle_from_string(f_name) or "第 1 周"

        # 2. 匹配 c_name [cyc]
        target_key = self._build_archive_key(c_name, cyc)
        if target_key in self._data["classes"]:
            return target_key

        # 3. 兼容旧的按文件名直接建档的记录
        if f_name in self._data["classes"]:
            old_entry = self._data["classes"][f_name]
            if old_entry.get("cycle") == cyc:
                return f_name

        return target_key

    def _recalc_stats(self, key: str):
        if key not in self._data["classes"]:
            return
        entry = self._data["classes"][key]
        students = entry.get("students", [])
        total = len(students)
        sent = 0
        unsent = 0
        failed = 0
        for s in students:
            st = s.get("status", "未发送")
            if "已发送" in st or "✓" in st:
                sent += 1
            elif "未发送" in st or "待发送" in st:
                unsent += 1
            else:
                failed += 1
        entry["stats"] = {
            "total": total,
            "sent": sent,
            "unsent": unsent,
            "failed": failed,
        }

    def sync_file_loaded(self, file_path: str, student_data: list, cycle: str = ""):
        """当载入文件时，按班级+周次建立或更新档案并同步学生"""
        if not file_path or not student_data:
            return
        filename = os.path.basename(file_path)
        clean_class_name = clean_class_name_from_path(file_path)
        cyc = (cycle or "").strip()
        if not cyc:
            cyc = detect_cycle_from_string(filename) or "第 1 周"

        key = self._build_archive_key(clean_class_name, cyc)
        now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        if key not in self._data["classes"]:
            students_list = []
            for idx, item in enumerate(student_data):
                name = (item.get("studentName") or item.get("name") or "未知学生").strip()
                msg = (item.get("message") or item.get("feedbackText") or "").strip()
                students_list.append({
                    "index": idx + 1,
                    "name": name,
                    "status": "未发送",
                    "time": "-",
                    "message": msg,
                    "msg_len": len(msg),
                })
            self._data["classes"][key] = {
                "key": key,
                "cycle": cyc,
                "class_name": clean_class_name,
                "file_name": filename,
                "file_path": file_path,
                "created_time": now_str,
                "last_update_time": now_str,
                "students": students_list,
            }
        else:
            entry = self._data["classes"][key]
            entry["file_path"] = file_path
            entry["file_name"] = filename
            entry["class_name"] = clean_class_name
            entry["cycle"] = cyc
            existing_map = {s["name"]: s for s in entry.get("students", [])}
            merged_list = []
            for idx, item in enumerate(student_data):
                name = (item.get("studentName") or item.get("name") or "未知学生").strip()
                msg = (item.get("message") or item.get("feedbackText") or "").strip()
                if name in existing_map:
                    s = existing_map[name]
                    s["index"] = idx + 1
                    if msg:
                        s["message"] = msg
                        s["msg_len"] = len(msg)
                    merged_list.append(s)
                else:
                    merged_list.append({
                        "index": idx + 1,
                        "name": name,
                        "status": "未发送",
                        "time": "-",
                        "message": msg,
                        "msg_len": len(msg),
                    })
            entry["students"] = merged_list
            entry["last_update_time"] = now_str

        self._recalc_stats(key)
        self.save()

    def update_student_status(self, file_path_or_name: str, student_name: str, status: str, time_str: str = None, cycle: str = ""):
        """实时更新某学生在特定周次档案中的发送状态"""
        if not file_path_or_name:
            return
        key = self._resolve_archive_key(file_path_or_name, cycle)
        if key not in self._data["classes"]:
            return
        if not time_str:
            time_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        entry = self._data["classes"][key]
        for s in entry.get("students", []):
            if s["name"] == student_name:
                s["status"] = status
                s["time"] = time_str
                break
        entry["last_update_time"] = time_str
        self._recalc_stats(key)
        self.save()

    def get_student_historical_status(self, file_path_or_name: str, student_name: str, cycle: str = "") -> str:
        """获取某学生在特定周次档案中的历史发送状态"""
        if not file_path_or_name:
            return ""
        key = self._resolve_archive_key(file_path_or_name, cycle)
        if key not in self._data["classes"]:
            return ""
        entry = self._data["classes"][key]
        for s in entry.get("students", []):
            if s["name"] == student_name:
                return s.get("status", "")
        return ""

    def get_cycles_list(self) -> list:
        """获取历史记录中所有出现过的周次/周期列表（去重并智能数字排序）"""
        cycles = set()
        for c in self._data["classes"].values():
            cyc = c.get("cycle")
            if cyc:
                cycles.add(cyc)
        def cycle_sort_key(c_str):
            m = re.search(r"\d+", c_str)
            return int(m.group(0)) if m else 999
        return sorted(list(cycles), key=cycle_sort_key)

    def get_classes_list(self) -> list:
        items = list(self._data["classes"].values())
        items.sort(key=lambda x: x.get("last_update_time", ""), reverse=True)
        return items

    def get_class_details(self, key: str) -> dict:
        return self._data["classes"].get(key)

    def delete_class(self, key: str):
        if key in self._data["classes"]:
            del self._data["classes"][key]
            self.save()

    def clear_all(self):
        self._data = {"classes": {}}
        self.save()


class HistoryDialog:
    """按班级/文件分类的历史记录查看与管理中心"""
    def __init__(self, parent, history_mgr: HistoryManager, on_reload_file=None):
        self.parent = parent
        self.history_mgr = history_mgr
        self.on_reload_file = on_reload_file

        self.dialog = tk.Toplevel(parent)
        self.dialog.title("📜 发送历史记录 (按班级/文件分类存档)")
        self.dialog.transient(parent)
        self.dialog.configure(bg="#F5F7FA")

        sw = self.dialog.winfo_screenwidth()
        sh = self.dialog.winfo_screenheight()
        dw = min(1080, max(920, int(sw * 0.78)))
        dh = min(720, max(600, int(sh * 0.78)))
        x = max(0, parent.winfo_x() + (parent.winfo_width() - dw) // 2)
        y = max(0, parent.winfo_y() + (parent.winfo_height() - dh) // 2)
        self.dialog.geometry(f"{dw}x{dh}+{x}+{y}")
        self.dialog.minsize(860, 540)

        self.current_class_key = None
        self.current_filter = "ALL"
        self.filter_cycle_var = tk.StringVar(value="全部周次")
        self.search_class_var = tk.StringVar()
        self.search_student_var = tk.StringVar()

        self._build_ui()
        self._load_classes()

        self.dialog.bind("<Escape>", lambda e: self.dialog.destroy())

    def _build_ui(self):
        container = ttk.Frame(self.dialog, padding=12)
        container.pack(fill="both", expand=True)

        top_bar = tk.Frame(container, bg="#F5F7FA")
        top_bar.pack(side="top", fill="x", pady=(0, 10))

        tk.Label(
            top_bar,
            text="班级发送历史与存档记录",
            font=("Microsoft YaHei", 14, "bold"),
            fg="#303133",
            bg="#F5F7FA",
        ).pack(side="left")

        tk.Label(
            top_bar,
            text="（自动记录已发、待发与失败名单，支持一键重发或导出表格）",
            font=("Microsoft YaHei", 9),
            fg="#909399",
            bg="#F5F7FA",
        ).pack(side="left", padx=(8, 0), pady=(4, 0))

        paned = ttk.PanedWindow(container, orient=tk.HORIZONTAL)
        paned.pack(side="top", fill="both", expand=True)

        # 左侧：班级列表 (含周次筛选)
        left_frame = ttk.LabelFrame(paned, text="📚 班级 / 发送周次", padding=8)
        paned.add(left_frame, weight=3)

        # 1. 周次筛选器
        cycle_filter_frame = tk.Frame(left_frame, bg="#F5F7FA")
        cycle_filter_frame.pack(fill="x", pady=(0, 4))
        tk.Label(cycle_filter_frame, text="📅 周次:", bg="#F5F7FA", font=("Microsoft YaHei", 9, "bold")).pack(side="left")
        self.cycle_filter_combo = ttk.Combobox(
            cycle_filter_frame,
            textvariable=self.filter_cycle_var,
            state="readonly",
            width=12
        )
        self.cycle_filter_combo.pack(side="left", fill="x", expand=True, padx=(4, 0))
        self.cycle_filter_combo.bind("<<ComboboxSelected>>", lambda e: self._filter_classes())

        # 2. 班级搜索框
        search_frame = tk.Frame(left_frame, bg="#F5F7FA")
        search_frame.pack(fill="x", pady=(0, 6))

        tk.Label(search_frame, text="🔍", bg="#F5F7FA", font=("Microsoft YaHei", 10)).pack(side="left")
        class_entry = ttk.Entry(search_frame, textvariable=self.search_class_var)
        class_entry.pack(side="left", fill="x", expand=True, padx=(4, 0))
        self.search_class_var.trace_add("write", lambda *a: self._filter_classes())

        class_tree_frame = tk.Frame(left_frame, bg="#F5F7FA")
        class_tree_frame.pack(fill="both", expand=True)

        self.class_tree = ttk.Treeview(
            class_tree_frame,
            columns=("cycle", "class_name", "progress"),
            show="headings",
            selectmode="browse",
        )
        self.class_tree.heading("cycle", text="周次")
        self.class_tree.heading("class_name", text="班级名称")
        self.class_tree.heading("progress", text="进度 (已发/总数)")
        self.class_tree.column("cycle", width=75, minwidth=60, anchor="center")
        self.class_tree.column("class_name", width=145, minwidth=100, anchor="w")
        self.class_tree.column("progress", width=85, minwidth=70, anchor="center")

        class_scroll = ttk.Scrollbar(class_tree_frame, orient="vertical", command=self.class_tree.yview)
        self.class_tree.configure(yscrollcommand=class_scroll.set)

        self.class_tree.pack(side="left", fill="both", expand=True)
        class_scroll.pack(side="right", fill="y")
        self.class_tree.bind("<<TreeviewSelect>>", self._on_class_select)

        left_btns = tk.Frame(left_frame, bg="#F5F7FA")
        left_btns.pack(fill="x", pady=(8, 0))

        ttk.Button(left_btns, text="🗑️ 删除选中", command=self._delete_selected_class, width=11).pack(side="left")
        ttk.Button(left_btns, text="🧹 清空全部", command=self._clear_all_history, width=11).pack(side="right")

        # 右侧：学生明细
        right_frame = ttk.LabelFrame(paned, text="📋 发送名单明细", padding=8)
        paned.add(right_frame, weight=7)

        header_box = tk.Frame(right_frame, bg="#FFFFFF", relief="solid", borderwidth=1, padx=10, pady=8)
        header_box.pack(fill="x", pady=(0, 8))

        self.cur_class_title = tk.Label(
            header_box,
            text="请在左侧选择一个班级查看",
            font=("Microsoft YaHei", 12, "bold"),
            fg="#303133",
            bg="#FFFFFF",
        )
        self.cur_class_title.pack(anchor="w")

        self.cur_class_file = tk.Label(
            header_box,
            text="",
            font=("Microsoft YaHei", 9),
            fg="#909399",
            bg="#FFFFFF",
        )
        self.cur_class_file.pack(anchor="w", pady=(2, 6))

        badges_row = tk.Frame(header_box, bg="#FFFFFF")
        badges_row.pack(anchor="w")

        self.badge_total = tk.Label(badges_row, text="总计: 0 人", font=("Microsoft YaHei", 9, "bold"), fg="#409EFF", bg="#ECF5FF", padx=8, pady=2)
        self.badge_total.pack(side="left", padx=(0, 6))

        self.badge_sent = tk.Label(badges_row, text="✓ 已发送: 0", font=("Microsoft YaHei", 9, "bold"), fg="#67C23A", bg="#F0F9EB", padx=8, pady=2)
        self.badge_sent.pack(side="left", padx=(0, 6))

        self.badge_unsent = tk.Label(badges_row, text="⏳ 未发送: 0", font=("Microsoft YaHei", 9, "bold"), fg="#909399", bg="#F4F4F5", padx=8, pady=2)
        self.badge_unsent.pack(side="left", padx=(0, 6))

        self.badge_failed = tk.Label(badges_row, text="⚠️ 异常/失败: 0", font=("Microsoft YaHei", 9, "bold"), fg="#F56C6C", bg="#FEF0F0", padx=8, pady=2)
        self.badge_failed.pack(side="left")

        filter_row = tk.Frame(right_frame, bg="#F5F7FA")
        filter_row.pack(fill="x", pady=(0, 6))

        self.btn_filter_all = ttk.Button(filter_row, text="全部", command=lambda: self._set_filter("ALL"), width=8)
        self.btn_filter_all.pack(side="left", padx=(0, 4))

        self.btn_filter_sent = ttk.Button(filter_row, text="已发送", command=lambda: self._set_filter("SENT"), width=8)
        self.btn_filter_sent.pack(side="left", padx=(0, 4))

        self.btn_filter_unsent = ttk.Button(filter_row, text="未发送", command=lambda: self._set_filter("UNSENT"), width=8)
        self.btn_filter_unsent.pack(side="left", padx=(0, 4))

        self.btn_filter_failed = ttk.Button(filter_row, text="失败/拦截", command=lambda: self._set_filter("FAILED"), width=10)
        self.btn_filter_failed.pack(side="left", padx=(0, 10))

        tk.Label(filter_row, text="🔍", bg="#F5F7FA", font=("Microsoft YaHei", 9)).pack(side="left")
        stu_search = ttk.Entry(filter_row, textvariable=self.search_student_var, width=16)
        stu_search.pack(side="left", padx=(4, 0))
        self.search_student_var.trace_add("write", lambda *a: self._render_students())

        stu_tree_frame = tk.Frame(right_frame, bg="#F5F7FA")
        stu_tree_frame.pack(fill="both", expand=True)

        cols = ("序号", "姓名", "状态", "记录时间", "字数")
        self.stu_tree = ttk.Treeview(stu_tree_frame, columns=cols, show="headings", selectmode="browse")
        self.stu_tree.heading("序号", text="序号")
        self.stu_tree.heading("姓名", text="学员标识/姓名")
        self.stu_tree.heading("状态", text="发送状态")
        self.stu_tree.heading("记录时间", text="记录时间")
        self.stu_tree.heading("字数", text="字数")

        self.stu_tree.column("序号", width=50, minwidth=40, anchor="center")
        self.stu_tree.column("姓名", width=180, minwidth=140, anchor="w")
        self.stu_tree.column("状态", width=140, minwidth=110, anchor="center")
        self.stu_tree.column("记录时间", width=150, minwidth=130, anchor="center")
        self.stu_tree.column("字数", width=65, minwidth=50, anchor="center")

        self.stu_tree.tag_configure("status_sent", foreground="#2E7D32")
        self.stu_tree.tag_configure("status_unsent", foreground="#616161")
        self.stu_tree.tag_configure("status_failed", foreground="#C62828")

        stu_scroll = ttk.Scrollbar(stu_tree_frame, orient="vertical", command=self.stu_tree.yview)
        self.stu_tree.configure(yscrollcommand=stu_scroll.set)

        self.stu_tree.pack(side="left", fill="both", expand=True)
        stu_scroll.pack(side="right", fill="y")
        self.stu_tree.bind("<<TreeviewSelect>>", self._on_student_select)

        preview_label = tk.Label(right_frame, text="💬 评语文案摘要与预览:", font=("Microsoft YaHei", 9, "bold"), fg="#606266", bg="#F5F7FA")
        preview_label.pack(anchor="w", pady=(6, 2))

        preview_frame = tk.Frame(right_frame, bg="#FFFFFF", relief="solid", borderwidth=1)
        preview_frame.pack(fill="x", pady=(0, 8))

        self.msg_preview = tk.Text(preview_frame, height=3, font=("Consolas", 9), wrap="word", bg="#FFFFFF", fg="#303133", padx=6, pady=4, relief="flat")
        self.msg_preview.pack(fill="x", expand=True)
        self.msg_preview.insert("1.0", "（点击上方学生行可预览其完整反馈评语）")
        self.msg_preview.config(state="disabled")

        bottom_bar = tk.Frame(container, bg="#F5F7FA")
        bottom_bar.pack(side="bottom", fill="x", pady=(8, 0))

        self.reload_btn = ttk.Button(
            bottom_bar,
            text="🔄 载入主界面继续发送",
            command=self._reload_to_main,
            width=20,
        )
        self.reload_btn.pack(side="left", padx=(0, 8))

        self.export_csv_btn = ttk.Button(
            bottom_bar,
            text="📤 导出该班级记录 (CSV)",
            command=self._export_class_csv,
            width=20,
        )
        self.export_csv_btn.pack(side="left", padx=(0, 8))

        self.copy_unsent_btn = ttk.Button(
            bottom_bar,
            text="📋 复制未发送名单",
            command=self._copy_unsent_names,
            width=16,
        )
        self.copy_unsent_btn.pack(side="left", padx=(0, 8))

        ttk.Button(bottom_bar, text="关闭", command=self.dialog.destroy, width=10).pack(side="right")

    def _load_classes(self, select_key=None):
        for item in self.class_tree.get_children():
            self.class_tree.delete(item)

        classes = self.history_mgr.get_classes_list()
        kw = self.search_class_var.get().strip().lower()
        selected_cycle = self.filter_cycle_var.get().strip()

        # 动态更新周次下拉菜单选项
        cycles = ["全部周次"] + self.history_mgr.get_cycles_list()
        self.cycle_filter_combo["values"] = cycles
        if selected_cycle not in cycles:
            selected_cycle = "全部周次"
            self.filter_cycle_var.set("全部周次")

        found_item = None
        for c in classes:
            c_name = c.get("class_name", "")
            f_name = c.get("file_name", "")
            c_cycle = c.get("cycle", "第 1 周")

            if selected_cycle != "全部周次" and c_cycle != selected_cycle:
                continue

            if kw and (kw not in c_name.lower() and kw not in f_name.lower() and kw not in c_cycle.lower()):
                continue

            stats = c.get("stats", {})
            sent = stats.get("sent", 0)
            total = stats.get("total", 0)
            prog_str = f"{sent} / {total}"

            display_title = c_name if c_name else f_name
            item_id = self.class_tree.insert("", "end", values=(c_cycle, display_title, prog_str), tags=(c["key"],))

            if select_key and c["key"] == select_key:
                found_item = item_id

        children = self.class_tree.get_children()
        if children:
            target = found_item if found_item else children[0]
            self.class_tree.selection_set(target)
            self.class_tree.see(target)
            self._on_class_select(None)
        else:
            self.current_class_key = None
            self.cur_class_title.config(text="暂无历史发送记录")
            self.cur_class_file.config(text="当您载入文件或开始发送后，系统将自动在此按周次分类归档。")
            self.badge_total.config(text="总计: 0 人")
            self.badge_sent.config(text="✓ 已发送: 0")
            self.badge_unsent.config(text="⏳ 未发送: 0")
            self.badge_failed.config(text="⚠️ 异常/失败: 0")
            for item in self.stu_tree.get_children():
                self.stu_tree.delete(item)

    def _filter_classes(self):
        self._load_classes(select_key=self.current_class_key)

    def _on_class_select(self, event):
        sel = self.class_tree.selection()
        if not sel:
            return
        item_id = sel[0]
        tags = self.class_tree.item(item_id, "tags")
        if not tags:
            return
        key = tags[0]
        self.current_class_key = key
        detail = self.history_mgr.get_class_details(key)
        if not detail:
            return

        c_name = detail.get("class_name", "")
        f_name = detail.get("file_name", "")
        f_path = detail.get("file_path", "")
        c_cycle = detail.get("cycle", "第 1 周")
        up_time = detail.get("last_update_time", "")

        self.cur_class_title.config(text=f"【{c_name}】 {c_cycle} - {f_name}")
        self.cur_class_file.config(text=f"周次: {c_cycle} | 文件: {f_path} (最近更新: {up_time})")

        stats = detail.get("stats", {})
        total = stats.get("total", 0)
        sent = stats.get("sent", 0)
        unsent = stats.get("unsent", 0)
        failed = stats.get("failed", 0)

        self.badge_total.config(text=f"总计: {total} 人")
        self.badge_sent.config(text=f"✓ 已发送: {sent}")
        self.badge_unsent.config(text=f"⏳ 未发送: {unsent}")
        self.badge_failed.config(text=f"⚠️ 异常/失败: {failed}")

        self.btn_filter_all.config(text=f"全部 ({total})")
        self.btn_filter_sent.config(text=f"已发送 ({sent})")
        self.btn_filter_unsent.config(text=f"未发送 ({unsent})")
        self.btn_filter_failed.config(text=f"失败/拦截 ({failed})")

        self._render_students()

    def _set_filter(self, filter_type):
        self.current_filter = filter_type
        self._render_students()

    def _render_students(self):
        for item in self.stu_tree.get_children():
            self.stu_tree.delete(item)

        if not self.current_class_key:
            return

        detail = self.history_mgr.get_class_details(self.current_class_key)
        if not detail:
            return

        students = detail.get("students", [])
        kw = self.search_student_var.get().strip().lower()

        for s in students:
            name = s.get("name", "")
            status = s.get("status", "未发送")
            time_str = s.get("time", "-")
            msg_len = s.get("msg_len", 0)

            if kw and kw not in name.lower():
                continue

            is_sent = ("已发送" in status or "✓" in status)
            is_unsent = ("未发送" in status or "待发送" in status)
            is_failed = not is_sent and not is_unsent

            if self.current_filter == "SENT" and not is_sent:
                continue
            if self.current_filter == "UNSENT" and not is_unsent:
                continue
            if self.current_filter == "FAILED" and not is_failed:
                continue

            tag = "status_sent" if is_sent else ("status_unsent" if is_unsent else "status_failed")
            self.stu_tree.insert(
                "",
                "end",
                values=(s.get("index", 1), name, status, time_str, f"{msg_len} 字"),
                tags=(tag,),
            )

        children = self.stu_tree.get_children()
        if children:
            self.stu_tree.selection_set(children[0])
            self._on_student_select(None)
        else:
            self.msg_preview.config(state="normal")
            self.msg_preview.delete("1.0", "end")
            self.msg_preview.insert("1.0", "（当前筛选条件下无学生记录）")
            self.msg_preview.config(state="disabled")

    def _on_student_select(self, event):
        sel = self.stu_tree.selection()
        if not sel or not self.current_class_key:
            return
        vals = self.stu_tree.item(sel[0], "values")
        if not vals:
            return
        s_name = vals[1]
        detail = self.history_mgr.get_class_details(self.current_class_key)
        if not detail:
            return
        for s in detail.get("students", []):
            if s.get("name") == s_name:
                msg = s.get("message", "（无评语内容）")
                self.msg_preview.config(state="normal")
                self.msg_preview.delete("1.0", "end")
                self.msg_preview.insert("1.0", msg)
                self.msg_preview.config(state="disabled")
                break

    def _reload_to_main(self):
        if not self.current_class_key:
            return
        detail = self.history_mgr.get_class_details(self.current_class_key)
        if not detail:
            return
        f_path = detail.get("file_path", "")
        c_cycle = detail.get("cycle", "第 1 周")
        if not f_path or not os.path.exists(f_path):
            messagebox.showwarning(
                "文件不存在",
                f"未能找到原始文件：\n{f_path}\n\n该文件可能已被移动或删除。您可手动选择文件载入。",
                parent=self.dialog,
            )
            return

        if self.on_reload_file:
            self.dialog.destroy()
            self.on_reload_file(f_path, c_cycle)

    def _export_class_csv(self):
        if not self.current_class_key:
            return
        detail = self.history_mgr.get_class_details(self.current_class_key)
        if not detail:
            return
        students = detail.get("students", [])
        if not students:
            messagebox.showinfo("提示", "当前班级暂无学生记录。", parent=self.dialog)
            return

        c_name = detail.get("class_name", "班级")
        c_cycle = detail.get("cycle", "第 1 周")
        clean_cycle_tag = re.sub(r"\s+", "", c_cycle)
        default_file = f"{c_name}_{clean_cycle_tag}_发送记录_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"

        save_path = filedialog.asksaveasfilename(
            title="导出班级记录",
            defaultextension=".csv",
            filetypes=[("CSV 表格 (Excel 兼容)", "*.csv")],
            initialfile=default_file,
            parent=self.dialog,
        )
        if not save_path:
            return

        try:
            import csv
            with open(save_path, "w", newline="", encoding="utf-8-sig") as f:
                writer = csv.writer(f)
                writer.writerow(["周次", "班级", "序号", "学生学号/姓名", "发送状态", "记录时间", "评语字数", "评语内容"])
                for s in students:
                    writer.writerow([
                        c_cycle,
                        c_name,
                        s.get("index", 1),
                        s.get("name", ""),
                        s.get("status", ""),
                        s.get("time", "-"),
                        s.get("msg_len", 0),
                        s.get("message", ""),
                    ])
            messagebox.showinfo("导出成功", f"班级发送记录已导出至：\n{save_path}", parent=self.dialog)
        except Exception as e:
            messagebox.showerror("导出失败", f"保存 CSV 失败：\n{e}", parent=self.dialog)

    def _copy_unsent_names(self):
        if not self.current_class_key:
            return
        detail = self.history_mgr.get_class_details(self.current_class_key)
        if not detail:
            return
        students = detail.get("students", [])
        unsent_names = []
        for s in students:
            st = s.get("status", "未发送")
            if "已发送" not in st and "✓" not in st:
                unsent_names.append(s.get("name", ""))

        if not unsent_names:
            messagebox.showinfo("提示", "该班级所有学生均已发送完成！无未发送名单。", parent=self.dialog)
            return

        text = "\n".join(unsent_names)
        if safe_copy(text):
            orig = self.copy_unsent_btn.cget("text")
            self.copy_unsent_btn.config(text=f"✓ 已复制 {len(unsent_names)} 人!")
            self.dialog.after(1500, lambda: self.copy_unsent_btn.config(text=orig))
            messagebox.showinfo("复制成功", f"已复制 {len(unsent_names)} 位未发送/失败学生名单至剪贴板！", parent=self.dialog)
        else:
            messagebox.showerror("复制失败", "写入剪贴板失败，请重试。", parent=self.dialog)

    def _delete_selected_class(self):
        if not self.current_class_key:
            return
        detail = self.history_mgr.get_class_details(self.current_class_key)
        c_name = detail.get("class_name", self.current_class_key) if detail else self.current_class_key
        if messagebox.askyesno("确认删除", f"确定要从历史记录中删除【{c_name}】的发送档案吗？\n\n（不会删除您电脑中的原始反馈文件）", parent=self.dialog):
            self.history_mgr.delete_class(self.current_class_key)
            self._load_classes()

    def _clear_all_history(self):
        if messagebox.askyesno("确认清空", "确定要清空所有班级的发送历史档案吗？\n\n（此操作不可恢复，但不会删除任何原始文件）", parent=self.dialog):
            self.history_mgr.clear_all()
            self._load_classes()


class FeedbackSender:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title(f"极方每周反馈程序 {APP_VERSION}")

        # 尝试设置窗口图标
        try:
            icon_path = get_resource_path("favicon.ico")
            if not os.path.exists(icon_path):
                # 尝试从项目根目录探测
                parent_icon = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "favicon.ico")
                if os.path.exists(parent_icon):
                    icon_path = parent_icon
            if os.path.exists(icon_path):
                self.root.iconbitmap(icon_path)
        except Exception:
            pass

        # 屏幕分辨率动态自适应计算，确保在笔记本大缩放及各类屏幕下首次打开即可完整看到底部按钮
        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()
        win_w = min(1120, max(980, int(sw * 0.82)))
        win_h = min(840, max(720, int(sh * 0.86)))
        pos_x = max(0, (sw - win_w) // 2)
        pos_y = max(0, (sh - win_h) // 2 - 25)
        self.root.geometry(f"{win_w}x{win_h}+{pos_x}+{pos_y}")
        self.root.minsize(920, 660)
        self.root.configure(bg="#F5F7FA")

        # 数据与状态（多文件队列：loaded_files 记录来源，self.data 为合并发送队列）
        self.data = []
        self.loaded_files = []
        self.is_running = False
        self.current_file_path = ""
        self.send_logs = []
        # 待回名单：每进入过一个候选会话就留一条（哪怕身份没通过），
        # 因为打开会话本身就会清掉家长的未读角标，这是不留就永久丢失的信息。
        self.reply_notes = []
        self.reply_btn = None
        self.history_mgr = HistoryManager()
        self.current_cycle = "第 1 周"
        self.cycle_var = tk.StringVar(value="第 1 周")

        # 配置参数变量 (默认保存在内存，可通过隐藏入口配置)
        self.min_delay_var = tk.DoubleVar(value=DEFAULT_MIN_DELAY)
        self.max_delay_var = tk.DoubleVar(value=DEFAULT_MAX_DELAY)
        self.batch_rest_enable_var = tk.BooleanVar(value=True)
        self.batch_size_var = tk.IntVar(value=DEFAULT_BATCH_SIZE)
        self.batch_delay_var = tk.DoubleVar(value=DEFAULT_BATCH_DELAY)
        self.smart_mode_var = tk.StringVar(value="A")  # 视觉智能核验模式: "A"(大模型API), "B"(本地OCR), "OFF"(关闭)
        self.auto_fallback_var = tk.BooleanVar(value=True)  # 模式 A 异常时自动降级到模式 B
        self.smart_ocr_enable_var = tk.BooleanVar(value=True)  # 兼容旧开关引用

        # 隐藏入口点击计数器
        self._title_click_count = 0
        self._last_title_click_time = 0.0

        self.float_win = None
        self.setup_ui()
        log(f"极方每周反馈程序 {APP_VERSION} 初始化完成 | 数据目录: {get_data_dir()} | 日志路径: {LOG_FILE_PATH} | RapidOCR可用: {HAS_RAPIDOCR} | WinOCR可用: {HAS_WINOCR}", "INFO")
        # 启动时后台上报诊断日志；关闭时上报日志+发送历史（见 _on_app_close）
        self.root.protocol("WM_DELETE_WINDOW", self._on_app_close)
        try:
            cloud_upload_async(include_history=False)
        except Exception:
            pass

    def _on_app_close(self):
        """退出：后台上报本次日志与发送历史（最多等 5 秒），然后关闭窗口"""
        try:
            t = cloud_upload_async(include_history=True)
            t.join(timeout=5)
        except Exception:
            pass
        try:
            if getattr(self, "history_mgr", None) is not None:
                self.history_mgr.save()
        except Exception:
            pass
        try:
            self.root.destroy()
        except Exception:
            pass

    def setup_ui(self):
        """设置界面组件"""
        self._init_styles()

        main_frame = ttk.Frame(self.root, padding=14)
        main_frame.pack(fill="both", expand=True)

        self._create_header(main_frame)
        self._create_file_panel(main_frame)
        # 优先停靠底部控制栏 (side='bottom')，确保任何分辨率或缩放下均绝对不会被挤出屏幕
        self._create_control_panel(main_frame)
        # 中间内容区分栏区填满剩余全部空间
        self._create_content_paned(main_frame)

        # 快捷键支持打开高级设置 (Ctrl+Shift+C 或 Ctrl+,)、历史记录 (Ctrl+H) 及运行日志 (Ctrl+L)
        self.root.bind("<Control-Shift-C>", lambda e: self.open_config_dialog())
        self.root.bind("<Control-comma>", lambda e: self.open_config_dialog())
        self.root.bind("<Control-h>", lambda e: self.open_history_dialog())
        self.root.bind("<Control-H>", lambda e: self.open_history_dialog())
        self.root.bind("<Control-l>", lambda e: self.open_log_file())
        self.root.bind("<Control-L>", lambda e: self.open_log_file())

    def _init_styles(self):
        """初始化现代样式"""
        style = ttk.Style()
        if "clam" in style.theme_names():
            style.theme_use("clam")

        style.configure(".", background="#F5F7FA", font=("Microsoft YaHei", 10))
        style.configure("TFrame", background="#F5F7FA")
        style.configure("TLabelframe", background="#F5F7FA", bordercolor="#DCDFE6")
        style.configure("TLabelframe.Label", font=("Microsoft YaHei", 10, "bold"), foreground="#303133", background="#F5F7FA")

        style.configure("TButton", font=("Microsoft YaHei", 10), padding=5, background="#FFFFFF", bordercolor="#DCDFE6")
        style.map("TButton", background=[("active", "#ECF5FF")])

        # 主按钮
        style.configure("Primary.TButton", font=("Microsoft YaHei", 11, "bold"), background="#409EFF", foreground="white", padding=8)
        style.map("Primary.TButton", background=[("active", "#66B1FF"), ("disabled", "#E4E7ED")], foreground=[("disabled", "#C0C4CC")])

        # 危险/停止按钮
        style.configure("Danger.TButton", font=("Microsoft YaHei", 11, "bold"), background="#F56C6C", foreground="white", padding=8)
        style.map("Danger.TButton", background=[("active", "#F78989"), ("disabled", "#E4E7ED")], foreground=[("disabled", "#C0C4CC")])

        # 橙色重试按钮
        style.configure("Warning.TButton", font=("Microsoft YaHei", 10, "bold"), background="#E6A23C", foreground="white", padding=6)
        style.map("Warning.TButton", background=[("active", "#EBB563"), ("disabled", "#E4E7ED")], foreground=[("disabled", "#C0C4CC")])

        # 进度条
        style.configure("Horizontal.TProgressbar", thickness=14, background="#409EFF", troughcolor="#EBEEF5")

        # Treeview 表格
        style.configure("Treeview", font=("Microsoft YaHei", 10), rowheight=28, bordercolor="#E4E7ED", fieldbackground="#FFFFFF")
        style.configure("Treeview.Heading", font=("Microsoft YaHei", 10, "bold"), background="#F0F2F5", foreground="#606266", padding=5)
        style.map("Treeview", background=[("selected", "#ECF5FF")], foreground=[("selected", "#409EFF")])

    def _create_header(self, parent):
        """顶部标题与安全提示 (支持连击标题进入高级设置)"""
        header_frame = tk.Frame(parent, bg="#F5F7FA")
        header_frame.pack(side="top", fill="x", pady=(0, 8))

        self.title_label = tk.Label(
            header_frame,
            text=f"极方每周反馈程序 {APP_VERSION}",
            font=("Microsoft YaHei", 16, "bold"),
            bg="#F5F7FA",
            fg="#303133",
            cursor="hand2",
        )
        self.title_label.pack(side="left")
        self.title_label.bind("<Button-1>", self._on_title_click)

        # 安全防误发提示标签
        tip_frame = tk.Frame(header_frame, bg="#FDF6EC", relief="solid", borderwidth=1)
        tip_frame.pack(side="right")
        tip_text = "🛡️ 防失焦守护已就绪 | 随时按【ESC】停止"
        tk.Label(
            tip_frame,
            text=tip_text,
            font=("Microsoft YaHei", 9, "bold"),
            bg="#FDF6EC",
            fg="#E6A23C",
            padx=10,
            pady=4,
        ).pack()

    def _on_title_click(self, event):
        """连击主标题 3 次触发隐藏的高级配置面板"""
        now = time.time()
        if now - self._last_title_click_time <= 1.5:
            self._title_click_count += 1
        else:
            self._title_click_count = 1
        self._last_title_click_time = now

        if self._title_click_count == 2:
            self.status_label.config(text="💡 再点击 1 次标题打开高级设置...", fg="#E6A23C")
        elif self._title_click_count >= 3:
            self._title_click_count = 0
            self.open_config_dialog()

    def open_config_dialog(self):
        """打开隐藏的高级运行参数配置窗口"""
        dialog = tk.Toplevel(self.root)
        dialog.title("⚙️ 高级发送配置 (管理员/高级设置)")
        dialog.resizable(False, False)
        dialog.transient(self.root)
        dialog.grab_set()
        dialog.configure(bg="#F5F7FA")

        # 弹窗居中
        dialog_w, dialog_h = 560, 310
        x = max(0, self.root.winfo_x() + (self.root.winfo_width() - dialog_w) // 2)
        y = max(0, self.root.winfo_y() + (self.root.winfo_height() - dialog_h) // 2)
        dialog.geometry(f"{dialog_w}x{dialog_h}+{x}+{y}")

        container = ttk.Frame(dialog, padding=16)
        container.pack(fill="both", expand=True)

        # 临时变量，防止取消时直接被修改
        temp_min_delay = tk.DoubleVar(value=self.min_delay_var.get())
        temp_max_delay = tk.DoubleVar(value=self.max_delay_var.get())
        temp_batch_enable = tk.BooleanVar(value=self.batch_rest_enable_var.get())
        temp_batch_size = tk.IntVar(value=self.batch_size_var.get())
        temp_batch_delay = tk.DoubleVar(value=self.batch_delay_var.get())

        # 1. 延时设置
        group_delay = ttk.LabelFrame(container, text="⏱️ 单人发送间隔设置", padding=10)
        group_delay.pack(fill="x", pady=(0, 10))

        row1 = tk.Frame(group_delay, bg="#F5F7FA")
        row1.pack(fill="x")
        tk.Label(row1, text="最小休眠:", bg="#F5F7FA", fg="#606266").pack(side="left")
        ttk.Entry(row1, textvariable=temp_min_delay, width=6, justify="center").pack(side="left", padx=(4, 15))
        tk.Label(row1, text="最大休眠:", bg="#F5F7FA", fg="#606266").pack(side="left")
        ttk.Entry(row1, textvariable=temp_max_delay, width=6, justify="center").pack(side="left", padx=(4, 8))
        tk.Label(row1, text="秒 (单条发送后在两者之间随机休眠)", bg="#F5F7FA", fg="#909399", font=("Microsoft YaHei", 9)).pack(side="left")

        # 2. 防风控休眠
        group_batch = ttk.LabelFrame(container, text="🛡️ 批次防风控休眠设置", padding=10)
        group_batch.pack(fill="x", pady=(0, 12))

        row2 = tk.Frame(group_batch, bg="#F5F7FA")
        row2.pack(fill="x", pady=(0, 4))
        ttk.Checkbutton(row2, text="启用批次休眠：每连续发送", variable=temp_batch_enable).pack(side="left")
        ttk.Entry(row2, textvariable=temp_batch_size, width=4, justify="center").pack(side="left", padx=4)
        tk.Label(row2, text="人，额外长休息", bg="#F5F7FA", fg="#606266").pack(side="left")
        ttk.Entry(row2, textvariable=temp_batch_delay, width=5, justify="center").pack(side="left", padx=4)
        tk.Label(row2, text="秒", bg="#F5F7FA", fg="#606266").pack(side="left")

        tk.Label(
            group_batch,
            text="💡 提示：高频向不同好友发消息易触发企微风控，适当休息可模拟真人操作习惯。",
            font=("Microsoft YaHei", 9),
            fg="#909399",
            bg="#F5F7FA",
        ).pack(anchor="w")

        # 底部操作按钮
        btn_box = tk.Frame(container, bg="#F5F7FA")
        btn_box.pack(side="bottom", fill="x", pady=(6, 0))

        def do_reset():
            temp_min_delay.set(DEFAULT_MIN_DELAY)
            temp_max_delay.set(DEFAULT_MAX_DELAY)
            temp_batch_enable.set(True)
            temp_batch_size.set(DEFAULT_BATCH_SIZE)
            temp_batch_delay.set(DEFAULT_BATCH_DELAY)

        def do_save():
            try:
                mi = float(temp_min_delay.get())
                ma = float(temp_max_delay.get())
                if mi < 0 or ma < 0 or mi > ma:
                    messagebox.showerror("参数错误", "单人发送间隔必须为非负数，且最小间隔不能大于最大间隔！", parent=dialog)
                    return
                bs = int(temp_batch_size.get())
                bd = float(temp_batch_delay.get())
                if bs < 1 or bd < 0:
                    messagebox.showerror("参数错误", "批次人数需至少为1，休眠秒数需大于0！", parent=dialog)
                    return
            except Exception:
                messagebox.showerror("参数错误", "请输入有效的数字！", parent=dialog)
                return

            self.min_delay_var.set(mi)
            self.max_delay_var.set(ma)
            self.batch_rest_enable_var.set(temp_batch_enable.get())
            self.batch_size_var.set(bs)
            self.batch_delay_var.set(bd)

            dialog.destroy()
            self.status_label.config(text="✓ 运行延时参数已保存更新", fg="#67C23A")

        ttk.Button(btn_box, text="恢复默认值", command=do_reset, width=12).pack(side="left")
        ttk.Button(btn_box, text="取消", command=dialog.destroy, width=10).pack(side="right", padx=(8, 0))
        ttk.Button(btn_box, text="💾 保存配置", command=do_save, style="Primary.TButton", width=12).pack(side="right")

    def _create_file_panel(self, parent):
        """文件选择面板 (简洁清爽，不在主界面展示配置参数)"""
        file_frame = tk.Frame(parent, bg="#F5F7FA")
        file_frame.pack(side="top", fill="x", pady=(0, 8))

        select_btn = ttk.Button(file_frame, text="📂 选择反馈文件 (可多选)", command=self.select_files, width=26)
        select_btn.pack(side="left")

        history_btn = ttk.Button(file_frame, text="📜 班级发送历史", command=self.open_history_dialog, width=15)
        history_btn.pack(side="left", padx=(8, 0))

        log_btn = ttk.Button(file_frame, text="📑 运行日志", command=self.open_log_file, width=12)
        log_btn.pack(side="left", padx=(8, 0))

        debug_btn = ttk.Button(file_frame, text="🖼️ 调试截图", command=self.open_debug_dir, width=12)
        debug_btn.pack(side="left", padx=(8, 0))

        clear_btn = ttk.Button(file_frame, text="清空", command=self.clear_all_files, width=8)
        clear_btn.pack(side="left", padx=(8, 0))

        self.file_label = tk.Label(
            file_frame,
            text=" 请先载入导出的 feedback.json 或 .html 快照文件（可多选追加）",
            font=("Microsoft YaHei", 10),
            fg="#909399",
            bg="#F5F7FA",
            anchor="w",
        )
        self.file_label.pack(side="left", fill="x", expand=True, padx=(10, 0))

        # 发送周次 / 周期管理控制栏
        cycle_bar = tk.Frame(parent, bg="#F5F7FA")
        cycle_bar.pack(side="top", fill="x", pady=(0, 6))

        tk.Label(
            cycle_bar,
            text="📅 发送周次 / 周期:",
            font=("Microsoft YaHei", 9, "bold"),
            fg="#303133",
            bg="#F5F7FA",
        ).pack(side="left")

        self.cycle_combo = ttk.Combobox(
            cycle_bar,
            textvariable=self.cycle_var,
            values=[f"第 {i} 周" for i in range(1, 25)],
            width=12,
            state="normal",
        )
        self.cycle_combo.pack(side="left", padx=(6, 8))
        self.cycle_combo.bind("<<ComboboxSelected>>", self._on_cycle_changed)
        self.cycle_combo.bind("<FocusOut>", self._on_cycle_changed)
        self.cycle_combo.bind("<Return>", self._on_cycle_changed)

        tk.Label(
            cycle_bar,
            text="（💡 系统按周次独立归档；隔周发送时切换周次，学生名单将自动就绪为【待发送】）",
            font=("Microsoft YaHei", 9),
            fg="#909399",
            bg="#F5F7FA",
        ).pack(side="left")

        # 已载入文件条（文件名 + 条数 + 移除按钮）
        self.files_frame = tk.Frame(parent, bg="#F5F7FA")
        self.files_frame.pack(side="top", fill="x", pady=(0, 8))

    def _on_cycle_changed(self, event=None):
        """当用户手动切换或输入新周次/周期时，自动联动刷新名单状态"""
        val = self.cycle_var.get().strip()
        if not val:
            val = "第 1 周"
            self.cycle_var.set(val)
        if val != self.current_cycle:
            self.current_cycle = val
            log(f"当前发送周次已切换为: 【{self.current_cycle}】", "INFO")
            # 重新同步已载入文件的档案至新周次
            for f_info in self.loaded_files:
                f_path = f_info.get("path")
                if f_path:
                    try:
                        raw_data = load_feedback_data_from_file(f_path)
                        self.history_mgr.sync_file_loaded(f_path, raw_data, cycle=self.current_cycle)
                    except Exception:
                        pass
            self.load_preview()

    def _create_content_paned(self, parent):
        """主内容分栏区：左侧名单，右侧实时消息预览"""
        paned = ttk.PanedWindow(parent, orient=tk.HORIZONTAL)
        paned.pack(side="top", fill="both", expand=True, pady=(0, 8))
        self.paned = paned

        # 左侧：名单列表 (赋予更大权重 weight=6，更宽裕)
        left_frame = ttk.LabelFrame(paned, text="发送名单列表", padding=8)
        paned.add(left_frame, weight=6)

        left_header = tk.Frame(left_frame, bg="#F5F7FA")
        left_header.pack(fill="x", pady=(0, 6))

        tip_label = tk.Label(
            left_header,
            text="💡 点击首列勾选/跳过；右键或 Ctrl+C 复制学员标识",
            font=("Microsoft YaHei", 9),
            fg="#909399",
            bg="#F5F7FA",
            anchor="w",
        )
        tip_label.pack(side="left")

        # 左侧一键复制学员标识按钮
        self.copy_student_btn = ttk.Button(
            left_header,
            text="📋 复制学员标识",
            command=self.copy_selected_student_name,
            width=14,
        )
        self.copy_student_btn.pack(side="right")

        tree_frame = tk.Frame(left_frame, bg="#F5F7FA")
        tree_frame.pack(fill="both", expand=True)

        columns = ("勾选", "序号", "姓名", "状态", "来源")
        self.tree = ttk.Treeview(tree_frame, columns=columns, show="headings", selectmode="browse")

        self.tree.heading("勾选", text="勾选 (☑)")
        self.tree.heading("序号", text="序号")
        self.tree.heading("姓名", text="学员标识/姓名")
        self.tree.heading("状态", text="状态")
        self.tree.heading("来源", text="来源文件")

        # 调宽学员姓名列与状态列，首次进入舒展不拥挤
        self.tree.column("勾选", width=65, minwidth=60, anchor="center")
        self.tree.column("序号", width=55, minwidth=50, anchor="center")
        self.tree.column("姓名", width=220, minwidth=160, anchor="w")
        self.tree.column("状态", width=160, minwidth=140, anchor="center")
        self.tree.column("来源", width=110, minwidth=80, anchor="center")

        tree_scroll = ttk.Scrollbar(tree_frame, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=tree_scroll.set)

        self.tree.pack(side="left", fill="both", expand=True)
        tree_scroll.pack(side="right", fill="y")

        # 树形视图事件绑定
        self.tree.bind("<ButtonRelease-1>", self.on_tree_click)
        self.tree.bind("<<TreeviewSelect>>", self.on_tree_select)
        self.tree.bind("<Button-3>", self.show_context_menu)
        self.tree.bind("<Control-c>", lambda e: self.copy_selected_student_name())
        self.tree.bind("<Control-C>", lambda e: self.copy_selected_student_name())

        # 右键上下文菜单
        self.context_menu = tk.Menu(self.tree, tearoff=0, font=("Microsoft YaHei", 9))
        self.context_menu.add_command(label="📋 复制学员标识 (学号/姓名)", command=self.copy_selected_student_name)
        self.context_menu.add_separator()
        self.context_menu.add_command(label="一键全选 (☑)", command=lambda: self.set_all_checks(True))
        self.context_menu.add_command(label="一键全部取消 (☐)", command=lambda: self.set_all_checks(False))
        self.context_menu.add_separator()
        self.context_menu.add_command(label="仅勾选【未发送/已跳过】项", command=self.check_only_unsent)
        self.context_menu.add_command(label="仅勾选【失败/被拦截】项", command=self.check_only_failed)
        self.context_menu.add_separator()
        self.context_menu.add_command(label="重置所有状态为【待发送】", command=self.reset_all_status)

        # 右侧：消息预览面板 (weight=4)
        right_frame = ttk.LabelFrame(paned, text="选中学生反馈文案预览", padding=8)
        paned.add(right_frame, weight=4)

        # 窗体首次显示后，自动将分栏拉杆调整至舒适宽敞位置 (左侧约 58%)
        self.root.after(80, lambda: self._init_paned_sash(paned))

        preview_header = tk.Frame(right_frame, bg="#F5F7FA")
        preview_header.pack(fill="x", pady=(0, 6))

        self.preview_title_label = tk.Label(
            preview_header,
            text="当前未选中学生",
            font=("Microsoft YaHei", 10, "bold"),
            fg="#409EFF",
            bg="#F5F7FA",
            anchor="w",
        )
        self.preview_title_label.pack(side="left")

        # 一键复制文案按钮
        self.copy_btn = ttk.Button(
            preview_header,
            text="📋 复制文案",
            command=self.copy_current_preview,
            width=11,
        )
        self.copy_btn.pack(side="right", padx=(8, 0))

        self.preview_len_label = tk.Label(
            preview_header,
            text="",
            font=("Microsoft YaHei", 9),
            fg="#909399",
            bg="#F5F7FA",
        )
        self.preview_len_label.pack(side="right")

        preview_box_frame = tk.Frame(right_frame, bg="#FFFFFF", relief="solid", borderwidth=1)
        preview_box_frame.pack(fill="both", expand=True)

        self.preview_text = tk.Text(
            preview_box_frame,
            font=("Consolas", 10),
            wrap="word",
            bg="#FFFFFF",
            fg="#303133",
            padx=8,
            pady=8,
            relief="flat",
        )
        preview_scroll = ttk.Scrollbar(preview_box_frame, orient="vertical", command=self.preview_text.yview)
        self.preview_text.configure(yscrollcommand=preview_scroll.set)

        self.preview_text.pack(side="left", fill="both", expand=True)
        preview_scroll.pack(side="right", fill="y")
        self.preview_text.insert("1.0", "（点击左侧列表中的学生，此处将实时展示该学生的完整评语与错题本链接）")
        self.preview_text.config(state="disabled")

    def _init_paned_sash(self, paned):
        """自动调整初始分栏位置，使左侧名单列表宽敞舒展"""
        try:
            self.root.update_idletasks()
            w = paned.winfo_width()
            if w > 500:
                sash_x = int(w * 0.58)
                paned.sashpos(0, sash_x)
            else:
                paned.sashpos(0, 580)
        except Exception:
            pass

    def copy_selected_student_name(self):
        """复制当前选中学员的标识/姓名到剪贴板"""
        selected = self.tree.selection()
        if not selected:
            messagebox.showinfo("提示", "请先在左侧列表中点击选择一位学生。")
            return

        item_id = selected[0]
        values = self.tree.item(item_id, "values")
        if not values or len(values) < 3:
            return

        student_name = str(values[2]).strip()
        if not student_name or student_name == "未知学生":
            messagebox.showinfo("提示", "当前行未包含有效的学员标识。")
            return

        sid, sname = parse_student_identifier(student_name)
        # 不要加任何分隔符：复制出来的文本要能直接粘进企微搜索框，
        # 夹一个全角逗号会让 '90001，张三' 匹配不到目标会话。
        copy_text = f"{sid}{sname}" if sid and sname else (sname or student_name)

        if safe_copy(copy_text):
            orig_text = self.copy_student_btn.cget("text")
            self.copy_student_btn.config(text=f"✓ 已复制 ({copy_text})!")
            self.root.after(1500, lambda: self.copy_student_btn.config(text=orig_text))
            self.status_label.config(text=f"✓ 已复制学员标识: {copy_text}", fg="#67C23A")
        else:
            messagebox.showerror("复制失败", "写入系统剪贴板失败，请重试。")

    def copy_current_preview(self):
        """将当前预览面板中的学生反馈文案一键复制到剪贴板"""
        text = self.preview_text.get("1.0", "end-1c").strip()
        if not text or text.startswith("（点击左侧列表中的学生"):
            messagebox.showinfo("提示", "当前没有选中任何学生的反馈文案。")
            return

        if safe_copy(text):
            orig_text = self.copy_btn.cget("text")
            self.copy_btn.config(text="✓ 已复制!")
            self.root.after(1500, lambda: self.copy_btn.config(text=orig_text))
        else:
            messagebox.showerror("复制失败", "写入系统剪贴板失败，请重试。")

    def _create_control_panel(self, parent):
        """底部控制与状态区 (停靠在窗口底部，确保永不被裁切)"""
        control_frame = tk.Frame(parent, bg="#F5F7FA")
        control_frame.pack(side="bottom", fill="x", pady=(6, 0))

        # 进度条与统计
        prog_row = tk.Frame(control_frame, bg="#F5F7FA")
        prog_row.pack(fill="x", pady=(0, 6))

        self.progress = ttk.Progressbar(prog_row, mode="determinate", style="Horizontal.TProgressbar")
        self.progress.pack(side="left", fill="x", expand=True, padx=(0, 10))

        self.progress_percent_label = tk.Label(
            prog_row, text="0 / 0 (0%)", font=("Microsoft YaHei", 9), fg="#909399", bg="#F5F7FA", width=12, anchor="e"
        )
        self.progress_percent_label.pack(side="right")

        # 状态文本
        self.status_label = tk.Label(
            control_frame,
            text="等待加载数据...",
            font=("Microsoft YaHei", 10, "bold"),
            fg="#409EFF",
            bg="#F5F7FA",
        )
        self.status_label.pack(pady=(0, 8))

        # 按钮容器
        btn_frame = tk.Frame(control_frame, bg="#F5F7FA")
        btn_frame.pack()

        self.start_btn = ttk.Button(
            btn_frame,
            text="▶ 开始发送",
            command=self.start_sending,
            style="Primary.TButton",
            state="disabled",
            width=16,
        )
        self.start_btn.pack(side="left", padx=8)

        self.stop_btn = ttk.Button(
            btn_frame,
            text="⏹ 停止发送",
            command=self.stop_sending,
            style="Danger.TButton",
            state="disabled",
            width=14,
        )
        self.stop_btn.pack(side="left", padx=8)

        self.retry_failed_btn = ttk.Button(
            btn_frame,
            text="🔄 仅重试失败/拦截项",
            command=self.retry_failed,
            style="Warning.TButton",
            state="disabled",
            width=16,
        )
        self.retry_failed_btn.pack(side="left", padx=8)

        self.export_btn = ttk.Button(
            btn_frame,
            text="📄 导出发送记录",
            command=self.export_report,
            state="disabled",
            width=14,
        )
        self.export_btn.pack(side="left", padx=8)

        self.history_btn = ttk.Button(
            btn_frame,
            text="📜 发送历史",
            command=self.open_history_dialog,
            width=12,
        )
        self.history_btn.pack(side="left", padx=8)

        # 待回消息名单：打开会话会清掉家长未读角标，这份名单是补回该信号的唯一途径
        self.reply_btn = ttk.Button(
            btn_frame,
            text="📨 待回名单 (0)",
            command=self.show_reply_notes_dialog,
            style="Warning.TButton",
            width=15,
        )
        self.reply_btn.pack(side="left", padx=8)

        self.log_btn = ttk.Button(
            btn_frame,
            text="📑 运行日志",
            command=self.open_log_file,
            width=12,
        )
        self.log_btn.pack(side="left", padx=8)

    # ================= 数据载入与表格交互 =================

    def flash_status(self, msg, color="#67C23A", ms=2500):
        """底部状态栏短暂提示后自动恢复（非阻塞轻提示，发送中也可安全调用）"""
        try:
            prev = (self.status_label.cget("text"), self.status_label.cget("fg"))
        except Exception:
            return
        try:
            self.status_label.config(text=msg, fg=color)
        except Exception:
            return

        def _restore():
            try:
                if self.status_label.cget("text") == msg:
                    self.status_label.config(text=prev[0], fg=prev[1])
            except Exception:
                pass
        try:
            self.root.after(ms, _restore)
        except Exception:
            pass

    def _short_file_label(self, file_path):
        """文件短标签：优先用纯净班级名，否则用文件名（去扩展名，超长截断）"""
        try:
            c_name = clean_class_name_from_path(file_path)
            if c_name:
                return c_name
        except Exception:
            pass
        stem = os.path.splitext(os.path.basename(file_path))[0]
        return stem if len(stem) <= 12 else (stem[:12] + "…")

    def _read_file_with_cycle(self, file_path):
        """读取单文件并返回 (raw_data, 推断周次)。格式错误抛异常。"""
        raw_data = load_feedback_data_from_file(file_path)

        if not isinstance(raw_data, list) or len(raw_data) == 0:
            raise ValueError("未能从该文件中提取到有效的学生反馈记录！")

        # 自动根据文件内容倒推周次（优先正文，其次文件名）
        detected_cyc = detect_cycle_from_data(raw_data, file_path)
        return raw_data, detected_cyc

    def _load_one_file(self, file_path):
        """载入单个文件并追加到发送队列。返回新增条数；已载入过返回 0；格式错误抛异常。
        每条数据打上 _src_file（全路径）与 _src_label（展示用短标签）。"""
        norm = os.path.abspath(file_path)
        if any(os.path.abspath(f["path"]) == norm for f in self.loaded_files):
            return 0

        # 同名不同路径拦截：历史档案按文件名建档，同名文件会串发送状态，
        # 来源列也无法区分。必须先改名再载入（放文件读取之前，失败不污染档案）。
        base = os.path.basename(file_path)
        if any(os.path.basename(f["path"]) == base for f in self.loaded_files):
            raise ValueError(f"队列中已有同名文件「{base}」，不同目录的同名文件会共用发送记录导致串档。请先将其中一个重命名后再载入。")

        raw_data, detected_cyc = self._read_file_with_cycle(file_path)

        # 自动倒推的周次优先用于归档；仅当冲突检测通过后才真正切换全局周次
        sync_cycle = detected_cyc or self.current_cycle
        self.history_mgr.sync_file_loaded(file_path, raw_data, cycle=sync_cycle)
        label = self._short_file_label(file_path)
        for item in raw_data:
            if isinstance(item, dict):
                item["_src_file"] = file_path
                item["_src_label"] = label
        self.data.extend(raw_data)
        self.loaded_files.append({
            "path": file_path,
            "name": os.path.basename(file_path),
            "label": label,
            "count": len(raw_data),
            "cycle": detected_cyc,
        })
        # 首个文件兼容旧的 current_file_path 用法
        if not self.current_file_path:
            self.current_file_path = file_path
        return len(raw_data)

    def select_file(self, target_path: str = None):
        """选择单个反馈文件（替换当前队列；历史记录窗口的重载走此入口，保持旧行为）"""
        if target_path:
            paths = [target_path]
        else:
            sel = filedialog.askopenfilename(
                title="选择反馈数据文件 (JSON / HTML 快照)",
                filetypes=[
                    ("反馈数据文件 (*.json, *.html, *.htm)", "*.json;*.html;*.htm"),
                    ("HTML 网页快照 (*.html, *.htm)", "*.html;*.htm"),
                    ("JSON 文件 (*.json)", "*.json"),
                    ("所有文件 (*.*)", "*.*"),
                ],
            )
            if not sel:
                return
            paths = [sel]
        self.clear_queue_silent()
        self._append_files(paths)

    def select_files(self):
        """选择多个反馈文件（追加到当前队列）"""
        paths = filedialog.askopenfilenames(
            title="选择反馈数据文件，可多选 (JSON / HTML 快照)",
            filetypes=[
                ("反馈数据文件 (*.json, *.html, *.htm)", "*.json *.html *.htm"),
                ("HTML 网页快照 (*.html, *.htm)", "*.html *.htm"),
                ("JSON 文件 (*.json)", "*.json"),
                ("所有文件 (*.*)", "*.*"),
            ],
        )
        if not paths:
            return
        self._append_files(list(paths))

    def _append_files(self, paths):
        """批量追加文件，逐个容错，汇总提示（含跨文件重名 / 周次冲突拦截）"""
        added = 0
        skipped = 0
        failed = []
        added_paths = []
        for p in paths:
            try:
                n = self._load_one_file(p)
                if n > 0:
                    added += n
                    added_paths.append(p)
                else:
                    skipped += 1
            except Exception as e:
                failed.append(f"{os.path.basename(p)}：{e}")
        if failed:
            messagebox.showerror("读取错误", "以下文件读取失败：\n" + "\n".join(failed))

        # 跨文件周次冲突检测：多个文件自动倒推出的周次不一致时，弹提示并回滚本次新增，不进入下一步
        conflict = self._detect_cycle_conflict()
        if conflict:
            self._rollback_conflict_load(added_paths)
            messagebox.showerror(
                "周次冲突",
                "检测到多个文件的周次不一致，已取消本次载入，请确认后再试：\n\n"
                + conflict["detail"]
                + "\n\n💡 请核对各文件名或反馈正文中的周次标记，确认它们属于同一发送周期。",
            )
            self.refresh_queue_ui()
            return

        self.refresh_queue_ui()
        if added > 0:
            # 队列周次就位：优先采用自动倒推出的周次
            inferred = self._infer_queue_cycle()
            if inferred:
                self.current_cycle = inferred
                self.cycle_var.set(inferred)
                self.load_preview()
            dup_names = self._find_cross_file_duplicates()
            tip = f"✓ 已载入 {len(self.loaded_files)} 个文件，共 {len(self.data)} 条反馈数据。"
            if inferred:
                tip += f"（自动识别周次：{inferred}）"
            if dup_names:
                shown = "、".join(dup_names[:5])
                more = f"等{len(dup_names)}人" if len(dup_names) > 5 else ""
                tip += f"\n⚠️ {shown}{more}在多个文件中都出现，将按每条各发一次。"
                try:
                    self.status_label.config(text=tip, fg="#E6A23C")
                except Exception:
                    pass
            else:
                try:
                    self.status_label.config(text=tip + "请核对名单后点击开始。", fg="#67C23A")
                except Exception:
                    pass
        elif skipped > 0 and not failed:
            self.flash_status("所选文件均已在队列中，未重复载入", "#909399")

    def _detect_cycle_conflict(self):
        """
        扫描全队列文件，若不同文件自动倒推出的周次存在两个及以上不同值，判定为冲突。
        返回 {'cycles': [...], 'paths': [...], 'detail': '...'} 或 None。
        """
        cycle_to_files = {}
        conflict_paths = []
        for f in self.loaded_files:
            cyc = (f.get("cycle") or "").strip()
            if not cyc:
                continue
            cycle_to_files.setdefault(cyc, []).append(f.get("name") or f.get("path"))
        if len(cycle_to_files) <= 1:
            return None

        lines = []
        for cyc in sorted(cycle_to_files.keys(), key=lambda c: (len(c), c)):
            names = cycle_to_files[cyc]
            lines.append(f"• 【{cyc}】: " + "、".join(names))
            conflict_paths.extend(
                f.get("path") for f in self.loaded_files if (f.get("cycle") or "").strip() == cyc
            )
        return {
            "cycles": sorted(cycle_to_files.keys()),
            "paths": conflict_paths,
            "detail": "\n".join(lines),
        }

    def _rollback_conflict_load(self, paths):
        """周次冲突时回滚：移除本次新增的文件及其数据，恢复原队列。"""
        norm_paths = {os.path.abspath(p) for p in paths if p}
        self.loaded_files = [
            f for f in self.loaded_files if os.path.abspath(f["path"]) not in norm_paths
        ]
        self.data = [
            it for it in self.data
            if not (isinstance(it, dict) and os.path.abspath(it.get("_src_file", "\0")) in norm_paths)
        ]
        if self.current_file_path and os.path.abspath(self.current_file_path) in norm_paths:
            self.current_file_path = self.loaded_files[0]["path"] if self.loaded_files else ""

    def _infer_queue_cycle(self):
        """从队列中所有文件推断统一周次；若有且仅有一个非空周次则返回它。"""
        cycles = {(f.get("cycle") or "").strip() for f in self.loaded_files}
        cycles.discard("")
        if len(cycles) == 1:
            return cycles.pop()
        return ""

    def _find_cross_file_duplicates(self):
        """找出出现在多个文件中的学生姓名（按纯姓名比对，用于提醒）"""
        seen_files = {}
        for item in self.data:
            if not isinstance(item, dict):
                continue
            full = str(item.get("studentName") or item.get("name") or "").strip()
            if not full:
                continue
            m = re.match(r"^(\d+)[\s\-_\.、]*(.*)$", full)
            name = (m.group(2).strip() if m else full) or full
            f = item.get("_src_file", "")
            seen_files.setdefault(name, set()).add(f)
        return sorted([n for n, fs in seen_files.items() if len(fs) > 1])

    def remove_one_file(self, file_path):
        """从队列移除单个文件（含其全部条目），历史发送记录保留"""
        if self.is_running:
            self.flash_status("发送中，无法移除文件", "#E6A23C")
            return
        norm = os.path.abspath(file_path)
        self.loaded_files = [f for f in self.loaded_files if os.path.abspath(f["path"]) != norm]
        self.data = [it for it in self.data
                     if not (isinstance(it, dict) and os.path.abspath(it.get("_src_file", "\0")) == norm)]
        if self.current_file_path and os.path.abspath(self.current_file_path) == norm:
            self.current_file_path = self.loaded_files[0]["path"] if self.loaded_files else ""
        self.refresh_queue_ui()
        self.flash_status(f"已移除文件：{os.path.basename(file_path)}")

    def clear_all_files(self):
        """清空整个发送队列（不删历史记录）"""
        if self.is_running:
            self.flash_status("发送中，无法清空", "#E6A23C")
            return
        self.clear_queue_silent()
        self.refresh_queue_ui()
        self.flash_status("已清空发送队列")

    def clear_queue_silent(self):
        """静默清空内存队列（换文件/清空时用，不碰历史档案）"""
        self.data = []
        self.loaded_files = []
        self.current_file_path = ""
        self.send_logs = []
        self.reply_notes = []
        self._refresh_reply_btn()

    def refresh_queue_ui(self):
        """刷新文件条、汇总标签、预览表与按钮状态"""
        # 文件条
        for w in self.files_frame.winfo_children():
            try:
                w.destroy()
            except Exception:
                pass
        for f in self.loaded_files:
            chip = tk.Frame(self.files_frame, bg="#ECF5FF", highlightbackground="#409EFF",
                            highlightthickness=1, padx=8, pady=3)
            chip.pack(side="left", padx=(0, 6), pady=2)
            tk.Label(chip, text=f"{f['label']}（{f['count']}条）", font=("Microsoft YaHei", 9),
                     fg="#303133", bg="#ECF5FF").pack(side="left")
            tk.Button(chip, text="×", font=("Microsoft YaHei", 9, "bold"), fg="#F56C6C",
                      bg="#ECF5FF", bd=0, activebackground="#ECF5FF",
                      command=lambda p=f["path"]: self.remove_one_file(p)).pack(side="left", padx=(4, 0))

        total = len(self.data)
        if self.loaded_files:
            ext0 = os.path.splitext(self.loaded_files[0]["name"])[1].lower()
            type_badge = "HTML 快照" if ext0 in [".html", ".htm"] else "JSON"
            mixed = len({os.path.splitext(f["name"])[1].lower() for f in self.loaded_files}) > 1
            self.file_label.config(
                text=f" ✓ 已载入: {len(self.loaded_files)} 个文件 [{type_badge}{' +混合' if mixed else ''}] ({total} 条)",
                fg="#67C23A")
        else:
            self.file_label.config(text=" 请先载入导出的 feedback.json 或 .html 快照文件（可多选追加）", fg="#909399")

        self.load_preview()
        has_data = total > 0
        self.start_btn.config(state="normal" if has_data else "disabled")
        self.retry_failed_btn.config(state="disabled")
        self.export_btn.config(state="disabled" if not self.send_logs else "normal")
        self.send_logs = [] if not has_data else self.send_logs
        self._refresh_reply_btn()

        if has_data:
            self.status_label.config(text=f"✓ 已就绪，共 {total} 条反馈数据。请核对名单后点击开始。", fg="#67C23A")
        else:
            self.status_label.config(text="暂无数据，请先载入反馈文件。", fg="#909399")

    def load_preview(self):
        """载入列表预览 (智能同步历史记录中的已发送/失败状态)"""
        for item in self.tree.get_children():
            self.tree.delete(item)

        completed_count = 0
        for i, item in enumerate(self.data):
            student_name = item.get("studentName") or item.get("name") or "未知学生"
            src_file = item.get("_src_file") or self.current_file_path
            src_label = item.get("_src_label") or os.path.splitext(os.path.basename(src_file or ""))[0]
            hist_status = self.history_mgr.get_student_historical_status(src_file, student_name, cycle=self.current_cycle)

            if "✓" in hist_status or "已发送" in hist_status:
                status_text = "✓ 已发送"
                chk = "☐"
                completed_count += 1
            elif hist_status and hist_status != "未发送":
                status_text = hist_status
                chk = "☑"
            else:
                status_text = "待发送"
                chk = "☑"

            self.tree.insert("", "end", values=(chk, i + 1, student_name, status_text, src_label))

        self.progress["maximum"] = len(self.data)
        self.progress["value"] = completed_count
        self._update_progress_label(completed_count, len(self.data))
        self._refresh_start_button_text()

        children = self.tree.get_children()
        if children:
            self.tree.selection_set(children[0])
            self.show_preview_at(0)

    def _update_progress_label(self, current, total):
        pct = int((current / total * 100)) if total > 0 else 0
        self.progress_percent_label.config(text=f"{current} / {total} ({pct}%)")

    def on_tree_select(self, event):
        """选中表格行时在右侧预览文本"""
        selected = self.tree.selection()
        if not selected:
            return
        item_id = selected[0]
        values = self.tree.item(item_id, "values")
        if not values:
            return
        idx = int(values[1]) - 1
        self.show_preview_at(idx)

    def show_preview_at(self, idx):
        """展示指定索引学生的消息"""
        if 0 <= idx < len(self.data):
            item = self.data[idx]
            name = item.get("studentName") or item.get("name") or "未知学生"
            msg = item.get("message") or item.get("feedbackText") or "（无文案内容）"

            self.preview_title_label.config(text=f"学生: {name} (第 {idx + 1} 项)" + (f" [{item.get('_src_label')}]" if item.get('_src_label') else ""))
            self.preview_len_label.config(text=f"字数: {len(msg)}")

            self.preview_text.config(state="normal")
            self.preview_text.delete("1.0", "end")
            self.preview_text.insert("1.0", msg)
            self.preview_text.config(state="disabled")

    def on_tree_click(self, event):
        """点击第一列切换勾选状态"""
        if self.is_running:
            return
        region = self.tree.identify("region", event.x, event.y)
        if region == "cell":
            column = self.tree.identify_column(event.x)
            if column == "#1":
                item = self.tree.identify_row(event.y)
                if item:
                    values = list(self.tree.item(item, "values"))
                    if values[0] == "☑":
                        values[0] = "☐"
                        if values[3] == "待发送":
                            values[3] = "已跳过"
                    else:
                        values[0] = "☑"
                        if values[3] == "已跳过":
                            values[3] = "待发送"
                    self.tree.item(item, values=values)
                    self._refresh_start_button_text()

    def show_context_menu(self, event):
        """右键菜单 (自动高亮右键点击的行并更新预览)"""
        if not self.is_running and self.data:
            item = self.tree.identify_row(event.y)
            if item:
                self.tree.selection_set(item)
                self.on_tree_select(None)
            self.context_menu.tk_popup(event.x_root, event.y_root)

    def set_all_checks(self, checked=True):
        """全选/全部取消"""
        if self.is_running:
            return
        sym = "☑" if checked else "☐"
        for item in self.tree.get_children():
            values = list(self.tree.item(item, "values"))
            values[0] = sym
            if checked and values[3] == "已跳过":
                values[3] = "待发送"
            elif not checked and values[3] == "待发送":
                values[3] = "已跳过"
            self.tree.item(item, values=values)
        self._refresh_start_button_text()

    def check_only_unsent(self):
        """仅勾选未发送或已跳过的项"""
        if self.is_running:
            return
        for item in self.tree.get_children():
            values = list(self.tree.item(item, "values"))
            if "✓" not in values[3]:
                values[0] = "☑"
                values[3] = "待发送"
            else:
                values[0] = "☐"
            self.tree.item(item, values=values)
        self._refresh_start_button_text()

    def check_only_failed(self):
        """仅勾选失败、被拦截或未找到的项"""
        if self.is_running:
            return
        for item in self.tree.get_children():
            values = list(self.tree.item(item, "values"))
            if any(k in values[3] for k in ["失败", "拦截", "无此联系人", "未找到"]):
                values[0] = "☑"
                values[3] = "待发送"
            else:
                values[0] = "☐"
            self.tree.item(item, values=values)
        self._refresh_start_button_text()

    def reset_all_status(self):
        """重置所有状态为待发送"""
        if self.is_running:
            return
        for item in self.tree.get_children():
            values = list(self.tree.item(item, "values"))
            values[0] = "☑"
            values[3] = "待发送"
            self.tree.item(item, values=values)
            s_name = str(values[2]).strip()
            try:
                row_idx = int(values[1]) - 1
                row_item = self.data[row_idx] if 0 <= row_idx < len(self.data) else {}
                src_file = row_item.get("_src_file") if isinstance(row_item, dict) else None
            except Exception:
                src_file = None
            self.history_mgr.update_student_status(src_file or self.current_file_path, s_name, "未发送", "-", cycle=self.current_cycle)
        self.progress["value"] = 0
        self._update_progress_label(0, len(self.data))
        self._refresh_start_button_text()

    def _refresh_start_button_text(self):
        """动态刷新开始/继续按钮文本"""
        items = self.tree.get_children()
        has_sent = any("✓" in self.tree.item(i, "values")[3] for i in items)
        if has_sent:
            self.start_btn.config(text="▶ 继续发送未完成项")
        else:
            self.start_btn.config(text="▶ 开始发送")

    def update_status(self, index, status):
        """更新表格中的状态（保留来源列）"""
        items = self.tree.get_children()
        if index < len(items):
            item = items[index]
            values = self.tree.item(item, "values")
            src = values[4] if len(values) > 4 else ""
            self.tree.item(item, values=(values[0], values[1], values[2], status, src))
            self.tree.see(item)

    def reorder_roster_after_completion(self):
        """
        全部发送任务结束后自动重排序名单：
        所有【未发送/异常/拦截/失败】项置于最前，所有【✓ 已发送】项置于最后。
        同时同步重排 self.data，保证序号与预览 100% 精准对应。
        """
        items = self.tree.get_children()
        if not items or not self.data:
            return

        rows = []
        for i, item in enumerate(items):
            vals = list(self.tree.item(item, "values"))
            data_item = self.data[i]
            chk = vals[0]
            name = vals[2]
            status = vals[3]
            is_sent = ("✓" in status)
            rows.append({
                "data": data_item,
                "chk": chk,
                "name": name,
                "status": status,
                "is_sent": is_sent,
                "label": (data_item.get("_src_label") if isinstance(data_item, dict) else "") or "",
            })

        unsent_rows = [r for r in rows if not r["is_sent"]]
        sent_rows = [r for r in rows if r["is_sent"]]

        # 仅当同时存在已发送和未发送项时才需要重排序
        if not unsent_rows or not sent_rows:
            return

        reordered = unsent_rows + sent_rows
        self.data = [r["data"] for r in reordered]

        # 重新渲染表格
        for item in self.tree.get_children():
            self.tree.delete(item)

        for new_idx, r in enumerate(reordered):
            # 未完成的项保持勾选状态，方便老师一键重试或核对；已发送项默认取消勾选
            chk_sym = "☑" if not r["is_sent"] else "☐"
            self.tree.insert("", "end", values=(chk_sym, new_idx + 1, r["name"], r["status"], r["label"]))

        # 自动选中并展示首个未完成学生
        children = self.tree.get_children()
        if children:
            self.tree.selection_set(children[0])
            self.tree.see(children[0])
            self.show_preview_at(0)

        self._refresh_start_button_text()
        has_retryable = any(
            any(k in r["status"] for k in ["失败", "拦截", "无此联系人", "未找到"])
            for r in unsent_rows
        )
        if has_retryable:
            self.retry_failed_btn.config(state="normal")

    # ================= 截图前自遮挡防护 =================

    # 视觉判定抓的是屏幕像素，本程序自己的 Tk 主窗口压在企微上方就会截到控件。
    # 收起用 withdraw 而非 iconify：withdraw 后窗口完全不参与屏幕合成，且
    # root.after 事件循环照常运行（后台线程的状态回填依赖它）。

    def _hide_self_for_capture(self):
        """发送开始前收起本程序主窗口，避免遮挡企微截图"""
        try:
            already_withdrawn = self.root.state() == "withdrawn"
            # 只有「本程序主动收起」的才负责恢复。若用户本来就自己收起了窗口，
            # 发送结束后不得把它强行弹出来。
            self._withdrawn_by_us = not already_withdrawn
            if not already_withdrawn:
                self.root.withdraw()
                self.root.update_idletasks()
                log("已收起本程序主窗口，避免遮挡企业微信截图", "DEBUG")
        except Exception as e:
            log(f"收起主窗口失败(继续发送): {e}", "WARN")
            self._withdrawn_by_us = False

    def _restore_self_after_capture(self):
        """发送结束后恢复本程序主窗口（仅当是本程序主动收起的）"""
        try:
            if not getattr(self, "_withdrawn_by_us", False):
                return
            self.root.deiconify()
            self.root.lift()
            self._withdrawn_by_us = False
            log("已恢复本程序主窗口", "DEBUG")
        except Exception as e:
            log(f"恢复主窗口失败: {e}", "WARN")

    def start_sending(self):
        """开始或继续发送"""
        if getattr(self, "is_running", False):
            return
        if hasattr(self, "_sending_thread") and self._sending_thread and self._sending_thread.is_alive():
            return

        if not self.data:
            messagebox.showwarning("警告", "请先选择反馈数据文件 (JSON / HTML)")
            return

        try:
            min_d = float(self.min_delay_var.get())
            max_d = float(self.max_delay_var.get())
            if min_d < 0 or max_d < 0 or min_d > max_d:
                raise ValueError
        except Exception:
            messagebox.showerror("参数错误", "发送间隔无效，请确保为正数且最小不大于最大。")
            return

        items = self.tree.get_children()
        to_send_indices = []
        for i, item in enumerate(items):
            vals = self.tree.item(item, "values")
            if vals[0] == "☑" and "✓" not in vals[3]:
                to_send_indices.append(i)

        if not to_send_indices:
            messagebox.showinfo("提示", "当前没有勾选任何【未发送】或【待重试】的记录。")
            return

        wecom_found = find_and_activate_wecom()
        zoomed = ensure_wecom_maximized() if wecom_found else False
        file_count = len(getattr(self, "loaded_files", []))
        tip_msg = f"即将发送 {len(to_send_indices)} 条反馈消息"
        tip_msg += f"（来自 {file_count} 个文件）。\n\n" if file_count > 1 else "。\n\n"
        if wecom_found:
            tip_msg += "✓ 已自动检测并激活企业微信主窗口。\n"
            tip_msg += (
                "✓ 已自动最大化，避免窄窗口裁掉下拉候选条目。\n"
                if zoomed
                else "⚠️ 未能自动最大化企微窗口，窄窗口下下拉候选尾部可能被裁掉。\n"
            )
        else:
            tip_msg += "⚠️ 未自动探测到企业微信，请确保企业微信已在电脑上登录并打开！\n"

        tip_msg += f"✓ 发送周次 / 周期：【{self.current_cycle}】（记录将独立归档至该周次）\n"
        tip_msg += "✓ 【AI 智能防误发双保险】全自动守护中：已开启下拉智能纠偏与会话标题二次核验双重防线。\n"

        tip_msg += (
            "\n【安全提示】\n"
            "1. 开始后 3 秒请勿触碰键盘与鼠标！\n"
            "2. 随时可按键盘左上角 【ESC】 键紧急停止。"
        )

        if not messagebox.askokcancel("确认启动", tip_msg):
            return

        self.is_running = True
        self.start_btn.config(state="disabled")
        self.stop_btn.config(state="normal")
        self.retry_failed_btn.config(state="disabled")

        self.status_label.config(text="⏳ 3 秒后开始发送，请将目光移至企业微信...", fg="#E6A23C")
        # 主窗口仍需收起，但理由已经变窄：
        #   v2.6.0 主判定走 WGC（抓窗口表面），**对本程序自己遮挡免疫**；
        #   真正还依赖屏幕像素的只剩两条兜底路径 ——
        #     1. capture_wecom_full 回退到 PyAutoGUI 时（未装/装失败的 windows-capture）；
        #     2. 模式 B 的 capture_header_crop 窄标题条 OCR。
        #   只要这两条还在，本程序自己的 Tk 主窗口（1120x840）压在企微上方就会截到控件，
        #   所以保留收起。置顶告警条是 Toplevel，收起主窗口不受影响。
        self._hide_self_for_capture()
        self.root.update()
        time.sleep(3)

        def _thread_wrapper():
            try:
                self._run_sending_thread(to_send_indices)
            finally:
                self.is_running = False
                self._restore_self_after_capture()
                self.root.after(0, self.hide_floating_window)
                self.root.after(0, lambda: self.start_btn.config(state="normal"))
                self.root.after(0, lambda: self.stop_btn.config(state="disabled"))
                self.root.after(0, self._refresh_start_button_text)

        self._sending_thread = Thread(target=_thread_wrapper)
        self._sending_thread.daemon = True
        self._sending_thread.start()

    def retry_failed(self):
        """一键重试失败或拦截项"""
        self.check_only_failed()
        self.start_sending()

    def stop_sending(self):
        """停止发送"""
        self.is_running = False
        self.status_label.config(text="⏹ 正在停止发送，请稍候...", fg="#E6A23C")
        self.start_btn.config(state="disabled")
        self.stop_btn.config(state="disabled")
        self.hide_floating_window()

    def _run_sending_thread(self, to_send_indices):
        """后台发送工作线程"""
        success_count = 0
        fail_count = 0
        not_found_count = 0
        desc_only_count = 0
        header_mismatch_count = 0
        interrupted = False

        min_delay = float(self.min_delay_var.get())
        max_delay = float(self.max_delay_var.get())
        batch_enable = self.batch_rest_enable_var.get()
        batch_size = max(1, self.batch_size_var.get())
        batch_delay = max(1.0, self.batch_delay_var.get())

        total_items = len(self.data)
        consecutive_sent = 0
        try:
            initial_completed = int(self.progress["value"])
        except Exception:
            initial_completed = 0
        log(f"=== 批量发送任务启动 === 待发学生数: {len(to_send_indices)}, 延时范围: [{min_delay}, {max_delay}]秒, 批次防风控: 每{batch_size}人休息{batch_delay}秒", "INFO")

        for current_loop_idx, i in enumerate(to_send_indices):
            if not self.is_running:
                interrupted = True
                break

            # 前台失焦守护检测：若中途被其他弹窗切走，先尝试自动唤回前台
            if HAS_WIN32 and not is_foreground_wecom():
                log("检测到前台脱离企业微信，尝试唤回企微前台...", "WARN")
                find_and_activate_wecom()
                time.sleep(0.3)
                if not is_foreground_wecom():
                    log("无法唤回企微前台，触发安全暂停", "WARN")
                    self.root.after(
                        0,
                        lambda: self.status_label.config(
                            text="⚠️ 防失焦拦截：检测到离开企业微信！已自动安全暂停，请切回后继续。",
                            fg="#F56C6C",
                        ),
                    )
                    self.root.after(
                        0,
                        lambda: messagebox.showwarning(
                            "安全暂停",
                            "检测到前台窗口已离开企业微信（可能弹出了其他软件或通知）！\n"
                            "为防止消息误发到其他应用，自动化已自动安全暂停。\n\n"
                            "请切回企业微信主窗口后，点击【继续发送未完成项】即可继续。",
                        ),
                    )
                    interrupted = True
                    break

            item = self.data[i]
            student_name = item.get("studentName") or item.get("name") or ""
            message = item.get("message") or item.get("feedbackText") or ""
            src_label = item.get("_src_label") or ""

            # 更新界面状态
            self.root.after(
                0,
                lambda idx=i, name=student_name, cur=current_loop_idx + 1, tot=len(to_send_indices), src=src_label: (
                    self.status_label.config(
                        text=f"📤 正在发送 [{cur}/{tot}]: {name}" + (f"（{src}）" if src else ""), fg="#409EFF"
                    ),
                    self.update_status(idx, "发送中..."),
                    self.tree.see(self.tree.get_children()[idx]),
                    self.show_preview_at(idx),
                ),
            )

            # 执行单条发送（包含 AI 智能防误发核验）
            send_result = "FAILED"
            try:
                send_result = self.send_single_feedback(student_name, message)
            except Exception as e:
                log(f"发送异常 [{student_name}]: {e}", "ERROR")
                send_result = "FAILED"

            # 待回名单可能新增了条目（含身份未通过的候选会话），刷新按钮计数
            self.root.after(0, self._refresh_reply_btn)

            now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

            if send_result == "SUCCESS":
                success_count += 1
                consecutive_sent += 1
                self.root.after(0, lambda idx=i: self.update_status(idx, "✓ 已发送"))
                self.history_mgr.update_student_status(item.get("_src_file") or self.current_file_path, student_name, "✓ 已发送", now_str, cycle=self.current_cycle)
                self.send_logs.append(
                    {"index": i + 1, "name": student_name, "status": "成功", "time": now_str, "msg_len": len(message), "file": item.get("_src_label", "")}
                )
            elif send_result == "NOT_FOUND":
                # 兼容旧版返回值：v2.5.0 起程序不再下「查无此人」的结论（无正向证据不写死），
                # send_single_feedback 不再返回该值，此分支仅作防御保留。
                not_found_count += 1
                self.root.after(0, lambda idx=i: self.update_status(idx, "⚠️ 无此联系人"))
                self.history_mgr.update_student_status(item.get("_src_file") or self.current_file_path, student_name, "⚠️ 无此联系人", now_str, cycle=self.current_cycle)
                self.send_logs.append(
                    {"index": i + 1, "name": student_name, "status": "无此联系人", "time": now_str, "msg_len": len(message), "file": item.get("_src_label", "")}
                )
            elif send_result == "DESC_ONLY":
                # 同上：v2.5.0 起 choice=-2 语义已取消，程序不再直接返回该值，仅作防御保留。
                desc_only_count += 1
                self.root.after(0, lambda idx=i: self.update_status(idx, "⚠️ 仅他人描述(拦截)"))
                self.history_mgr.update_student_status(item.get("_src_file") or self.current_file_path, student_name, "⚠️ 仅他人描述(拦截)", now_str, cycle=self.current_cycle)
                self.send_logs.append(
                    {"index": i + 1, "name": student_name, "status": "仅他人描述(拦截)", "time": now_str, "msg_len": len(message), "file": item.get("_src_label", "")}
                )
            elif send_result in ["HEADER_MISMATCH", "UNCERTAIN_INTERCEPT"]:
                header_mismatch_count += 1
                status_str = "⚠️ 标题不符(拦截)" if send_result == "HEADER_MISMATCH" else "⚠️ 存疑拦截"
                self.root.after(0, lambda idx=i, st=status_str: self.update_status(idx, st))
                self.history_mgr.update_student_status(item.get("_src_file") or self.current_file_path, student_name, status_str, now_str, cycle=self.current_cycle)
                self.send_logs.append(
                    {"index": i + 1, "name": student_name, "status": status_str, "time": now_str, "msg_len": len(message), "file": item.get("_src_label", "")}
                )
            elif send_result == "ABORTED":
                interrupted = True
                break
            else:
                fail_count += 1
                self.root.after(0, lambda idx=i: self.update_status(idx, "✗ 失败"))
                self.history_mgr.update_student_status(item.get("_src_file") or self.current_file_path, student_name, "✗ 失败", now_str, cycle=self.current_cycle)
                self.send_logs.append(
                    {"index": i + 1, "name": student_name, "status": "失败", "time": now_str, "msg_len": len(message), "file": item.get("_src_label", "")}
                )

            # 更新进度条 (采用工作线程计数，杜绝子线程直接跨线程遍历访问 UI 树控件)
            completed_count = initial_completed + success_count
            self.root.after(
                0,
                lambda cur=completed_count, tot=total_items: (
                    self.progress.config(value=cur),
                    self._update_progress_label(cur, tot),
                ),
            )

            if not self.is_running:
                interrupted = True
                break

            # 批次冷却 (防风控机制)
            if batch_enable and consecutive_sent >= batch_size and current_loop_idx < len(to_send_indices) - 1:
                consecutive_sent = 0
                self.root.after(
                    0,
                    lambda sec=batch_delay: self.status_label.config(
                        text=f"☕ 批次防风控冷却中：已连续发送 {batch_size} 人，额外休息 {sec} 秒...",
                        fg="#E6A23C",
                    ),
                )
                if not self.safe_sleep(batch_delay):
                    interrupted = True
                    break

            # 正常人际随机延时
            if current_loop_idx < len(to_send_indices) - 1 and self.is_running:
                random_delay = random.uniform(min_delay, max_delay)
                if not self.safe_sleep(random_delay):
                    interrupted = True
                    break

        # 结束收尾
        self.is_running = False
        self.history_mgr.save()
        log(f"=== 批量发送任务完毕 === 成功: {success_count}, 无此人: {not_found_count}, 描述拦截: {desc_only_count}, 标题拦截: {header_mismatch_count}, 失败: {fail_count}, 是否被中断: {interrupted}", "INFO")
        self.root.after(0, self.hide_floating_window)
        self.root.after(0, lambda: self.start_btn.config(state="normal"))
        self.root.after(0, lambda: self.stop_btn.config(state="disabled"))
        # 自动将未发送/异常/拦截项置前，已发送项置后
        self.root.after(0, self.reorder_roster_after_completion)
        self.root.after(0, self._refresh_start_button_text)

        if self.send_logs:
            self.root.after(0, lambda: self.export_btn.config(state="normal"))

        # 汇总提示
        total_intercepted = not_found_count + desc_only_count + header_mismatch_count
        if interrupted:
            self.root.after(
                0,
                lambda: self.status_label.config(
                    text=f"⏹ 任务已暂停/中断！成功 {success_count} 条，无此人 {not_found_count} 条，描述拦截 {desc_only_count} 条，标题拦截 {header_mismatch_count} 条，失败 {fail_count} 条",
                    fg="#F56C6C",
                ),
            )
        else:
            self.root.after(
                0,
                lambda: self.status_label.config(
                    text=f"✅ 发送任务结束！成功 {success_count} 条，拦截 {total_intercepted} 条，失败 {fail_count} 条",
                    fg="#67C23A",
                ),
            )
            msg_text = f"全部勾选任务已执行完毕！\n\n本次成功：{success_count} 条"
            if not_found_count > 0:
                msg_text += f"\n无此联系人：{not_found_count} 条（通讯录未加好友/未搜到）"
            if desc_only_count > 0:
                msg_text += f"\n描述冲突拦截：{desc_only_count} 条（仅他人描述命中，防止误发）"
            if header_mismatch_count > 0:
                msg_text += f"\n会话标题拦截：{header_mismatch_count} 条（核验聊天窗口非本人，防止误发）"
            if fail_count > 0:
                msg_text += f"\n本次失败：{fail_count} 条"
            if total_intercepted > 0 or fail_count > 0:
                msg_text += "\n\n💡 您可点击【🔄 仅重试失败/拦截项】查看或手动处理被跳过的学生。"
                self.root.after(0, lambda: messagebox.showwarning("任务完成", msg_text))
            else:
                self.root.after(0, lambda: messagebox.showinfo("任务完成", msg_text))

    def safe_sleep(self, duration: float) -> bool:
        """带 ESC 紧急中断与毫秒轮询的休眠"""
        end_time = time.time() + duration
        while time.time() < end_time:
            if not self.is_running:
                return False
            # 监听全局 ESC 物理键 (0x1B)
            if ctypes.windll.user32.GetAsyncKeyState(0x1B) & 0x8000:
                self.is_running = False
                return False
            time.sleep(0.05)
        return True

    def send_single_feedback(self, search_name: str, message: str) -> str:
        """
        发送单条反馈核心动作序列：
        1. 确保企微前台且已最大化（窗口尺寸变化会让已算好的裁剪坐标失效）
        2. Ctrl+F 激活搜索框，全选删除清空后粘贴「学号+姓名」，等待下拉框展开
        3. 按 (choice-1) 次【↓】定位后回车，进入第 choice 项候选会话
           —— **不再询问模型选人**：v2.6.0 起下拉截图整步删除，候选按 1→2→3 顺序试
        4. 消除切换残影 + 连拍两帧等画面稳定 → WGC 抓企微整窗
        5. 【唯一放行闸门】一次云端视觉调用同时裁决：会话身份（fail-closed）、
           是否群聊、是否有待回消息（fail-open，只记录）
        6. 身份不符 → 换下一个候选重走 2~5，最多共 3 个；仍不符则拦截，绝不发
        7. 安全写入剪贴板并粘贴完整反馈，回车发送

        为什么把下拉选人整步删掉：
          下拉截图唯一的产出是 choice（指一个起始项），而身份认定权本来就在标题
          闸门。删掉后常见情况（输全「学号+姓名」，目标通常就在第 1 项）从
          2 次 API 调用降到 1 次。
          代价是目标不在第 1 项时必须按 3 次回车、进 3 个会话。而**进会话这一步
          本身就会清掉该家长会话的未读角标**（不是发消息那一步），所以第 6 步对
          **每一个进入过的候选**都记录待回信息，哪怕身份没通过——否则老师事后
          完全无从知道哪位家长找过我们。

        返回: "SUCCESS" | "HEADER_MISMATCH" | "UNCERTAIN_INTERCEPT" | "ABORTED" | "FAILED"
        """
        log(f">>> 开始发送单条: '{search_name}', 文案字数={len(message)}", "INFO")

        target_id, target_name = parse_student_identifier(search_name)
        wecom_rect = get_wecom_rect()
        smart_mode = self.smart_mode_var.get()
        auto_fallback = self.auto_fallback_var.get()
        # 未开启智能核验 / 取不到窗口坐标 → 退化为「进第 1 项」，且无身份闸门（等同旧版直发路径）
        use_smart = smart_mode != "OFF" and HAS_SMART_CHECK and bool(wecom_rect)

        if use_smart and smart_mode == "B":
            # 模式 B（本地 OCR）只在云端异常时作为兜底接管**身份**闸门；它只截窄标题条，
            # 看不见聊天内容，因此拿不到 needs_reply —— 选 B 会让待回名单整体失效。
            log(
                "[{0}] 当前为模式 B（本地 OCR）：它只读窄标题条、看不到聊天内容，"
                "本次运行的【待回消息名单】将无法生成。需该功能请切回模式 A。".format(search_name),
                "WARN",
            )

        MAX_ATTEMPTS = 3  # 候选按第 1、2、3 项顺序试；三个都不符则拦截，绝不发

        for attempt in range(1, MAX_ATTEMPTS + 1):
            choice = attempt  # 机械顺序 1→2→3，不再询问模型
            if attempt == 1:
                if not self.safe_sleep(0.1):
                    log(f"[{search_name}] 中断退出", "WARN")
                    return "ABORTED"
            else:
                log(
                    f"[{search_name}] ↩ 换候选重试（第 {attempt}/{MAX_ATTEMPTS} 次）：改选第 {choice} 项",
                    "INFO",
                )
                self.root.after(
                    0,
                    lambda n=search_name, c=choice: self.status_label.config(
                        text=f"🔄 换候选重试 [{n}]：上一候选身份不符，改选第{c}项重新核验",
                        fg="#E6A23C",
                    ),
                )
                # 先安全退出上一个会话并彻底清空搜索框，杜绝盲按【↓】误入智能搜索
                dismiss_and_clear_search()
                if not self.safe_sleep(0.4):
                    return "ABORTED"

            # ---------- 0. 确保企微前台且已最大化 ----------
            # 必须在按 Ctrl+F 之前完成：窗口尺寸变化会让已算好的裁剪坐标失效，
            # 而搜索后再最大化会把已经展开的下拉框冲掉。
            if HAS_WIN32:
                ensure_wecom_maximized()
                wecom_rect = get_wecom_rect()  # 最大化后必须重取，旧 rect 已失效

            # ---------- 1. 激活搜索框 ----------
            pyautogui.hotkey("ctrl", "f")
            if not self.safe_sleep(CLICK_DELAY):
                return "ABORTED"

            # ---------- 2. 全选并删除清空搜索框，杜绝残留文字累加 ----------
            pyautogui.hotkey("ctrl", "a")
            time.sleep(0.04)
            pyautogui.press("backspace")
            if not self.safe_sleep(0.05):
                return "ABORTED"

            # ---------- 3. 复制学生学号/姓名并粘贴搜索 ----------
            if not safe_copy(search_name):
                log(f"[{search_name}] 学号/姓名写入剪贴板失败", "ERROR")
                return "FAILED"
            pyautogui.hotkey("ctrl", "v")
            if not self.safe_sleep(SEARCH_DELAY):
                return "ABORTED"

            if choice > 1:
                self.root.after(
                    0,
                    lambda n=search_name, c=choice: self.status_label.config(
                        text=f"🎯 [{n}]：已按【向下键】定位至第{c}项",
                        fg="#E6A23C",
                    ),
                )

            # ---------- 4. 按【↓】定位到候选项并回车进入 ----------
            for _ in range(choice - 1):
                pyautogui.press("down")
                time.sleep(0.12)
            if choice > 1:
                time.sleep(0.15)
            pyautogui.press("enter")
            if not self.safe_sleep(0.2):
                return "ABORTED"

            if not use_smart:
                break  # 无身份闸门，直接进入发送阶段

            # ---------- 5. 会话视觉判定（唯一放行闸门） ----------
            # 5.1 消除企微会话切换动画的残影（旧版窄标题条路径的 0.35s，保留）
            time.sleep(0.35)
            # 5.2 连拍两帧等画面稳定后抓整窗（WGC；未装则回退 PyAutoGUI）
            chat_img = capture_chat_view_stable(wecom_rect)
            if chat_img is None:
                log(f"[{search_name}] 企微整窗抓帧失败", "ERROR")
                chat_res = _empty_chat_res("抓帧失败")
                status, title = chat_res["status"], chat_res["detected_title"]
            else:
                chat_res = inspect_chat_view_via_vlm(chat_img, target_id, target_name)
                status, title = chat_res["status"], chat_res["detected_title"]

            # 云端异常/存疑时无缝切到本地 OCR 备用引擎（模式 B）
            if status in ("UNCERTAIN", "ERROR") and auto_fallback and HAS_OCR and smart_mode == "A":
                log(f"[{search_name}] 云端会话判定异常/存疑（{status}），自动切换至本地备用引擎...", "WARN")
                status, title = verify_chat_header_title(
                    wecom_rect, target_id, target_name, timeout=1.2, mode="B"
                )
                # 必须把模式 B 读到的标题回填进 chat_res：否则待回名单里会出现
                # 「✅已确认」配「(标题读取失败)」这种自相矛盾的组合 —— 云端当时是
                # 失败的，chat_res.detected_title 还是空的，但身份已被模式 B 判定通过了。
                # 只回填标题，不动 needs_reply：模式 B 看不见聊天内容，云端那份仍然更可信。
                if status == "MATCH" and title:
                    chat_res["detected_title"] = title
                    chat_res["title_in_header"] = True

            # ---------- 6. 待回信息：每一个进入过的候选都要留痕 ----------
            # 进会话已经清掉了家长的未读角标，身份没过也必须记录，
            # 否则老师事后无从知道这位家长找过我们。
            self._record_reply_note(search_name, choice, status, title, chat_res)

            if status == "MATCH":
                log(f"[{search_name}] ✓ 第 {choice} 项会话身份核验通过: '{title}'", "INFO")
                break

            log(
                f"[{search_name}] ⛔ 第 {choice} 项身份核验未通过（{status}），"
                f"当前会话为【{title or '无法读取'}】",
                "WARN",
            )

            if attempt == MAX_ATTEMPTS:
                if status in ("UNCERTAIN", "ERROR"):
                    log(f"[{search_name}] 已尝试 {MAX_ATTEMPTS} 个候选仍无法核准身份，触发安全拦截防盲发！", "ERROR")
                    self.root.after(
                        0,
                        lambda n=search_name, m=MAX_ATTEMPTS: self.status_label.config(
                            text=f"⛔ 身份存疑已拦截 [{n}]：{m} 个候选均无法核准，已拦截！",
                            fg="#F56C6C",
                        ),
                    )
                    dismiss_and_clear_search()
                    return "UNCERTAIN_INTERCEPT"

                log(f"[{search_name}] 已尝试 {MAX_ATTEMPTS} 个候选均与目标不符，触发安全拦截防误发！", "ERROR")
                self.root.after(
                    0,
                    lambda n=search_name, m=MAX_ATTEMPTS, t=title: self.status_label.config(
                        text=f"⛔ 标题不符已拦截 [{n}]：{m} 个候选均不符（当前为【{t or '无法读取'}】），已拦截！",
                        fg="#F56C6C",
                    ),
                )
                # 立即安全退出会话并彻底清空搜索输入框
                dismiss_and_clear_search()
                return "HEADER_MISMATCH"

        # ---------- 7. 安全写入剪贴板并粘贴完整反馈文案 ----------
        if not safe_copy(message):
            log(f"[{search_name}] 反馈文案写入系统剪贴板失败", "ERROR")
            return "FAILED"
        pyautogui.hotkey("ctrl", "v")
        if not self.safe_sleep(TYPE_DELAY):
            # 用户中断/按ESC，清理已粘贴在输入框中的内容，防止下次发送残留叠加
            pyautogui.hotkey("ctrl", "a")
            time.sleep(0.05)
            pyautogui.press("backspace")
            return "ABORTED"

        # ---------- 8. 发送消息 (Enter) ----------
        pyautogui.press("enter")
        if not self.safe_sleep(SEND_DELAY):
            return "ABORTED"

        log(f"[{search_name}] 单条反馈发送成功 ✓", "INFO")
        return "SUCCESS"


    # ================= 待回消息名单 =================

    def _record_reply_note(self, student_name, candidate_index, status, title, chat_res):
        """把一次进入过的候选会话的待回信息记进名单。

        **对每一个进入过的候选都调用**（身份没通过也要记）：企微在打开会话的瞬间
        就清掉该会话的未读角标，所以「进入」这个动作本身是不可逆的信息销毁。
        老师事后是靠未读角标发现家长找过我们的，我们把角标消费掉了，就得用这份
        名单把信号补回来。

        这个字段是 fail-open 的：needs_reply 为 None（模型判不出）时记「待人工确认」，
        **绝不能**因此拦住发送。
        """
        need = chat_res.get("needs_reply")
        text = (chat_res.get("last_message_text") or "").strip()
        sender = chat_res.get("last_sender", "unknown")
        # 三者全空（抓帧失败 / 模型什么都没返回）才跳过：连会话标题都没读到时
        # 记一条纯噪声，老师无从处理。
        if need is None and not text and not title:
            return

        note = {
            "student": student_name,
            "candidate": candidate_index,
            "chat_title": title or "(标题读取失败)",
            "identity": "✅已确认" if status == "MATCH" else "❌未确认",
            "last_sender": {"parent": "家长", "me": "我"}.get(sender, "未知"),
            "last_message": text,
            "needs_reply": need,
            "time": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        note["verdict"] = reply_note_verdict(note)

        # 同一学生 + 同一会话标题只保留最新一条（重跑/重试时不重复堆叠）
        for i, old in enumerate(self.reply_notes):
            if old["student"] == note["student"] and old["chat_title"] == note["chat_title"]:
                self.reply_notes[i] = note
                break
        else:
            self.reply_notes.append(note)

        log(
            f"[待回名单] {note['student']} 第{note['candidate']}项 | 会话【{note['chat_title']}】"
            f" | 身份{note['identity']} | 最后一条({note['last_sender']}): {text[:50]} | → {note['verdict']}",
            "INFO",
        )

    def reply_actionable(self) -> list:
        """待回名单里真正需要老师去回的条目：排除明确判为「无需回」的。"""
        return [n for n in self.reply_notes if n.get("needs_reply") is not False]

    def _refresh_reply_btn(self):
        """刷新按钮上的待回数量。必须在 Tk 主线程调用。"""
        if not self.reply_btn:
            return
        n = len(self.reply_actionable())
        try:
            self.reply_btn.config(text=f"📨 待回名单 ({n})")
        except Exception:
            pass

    def show_reply_notes_dialog(self):
        """展示待回消息名单（老师据此逐个给家长回消息）。"""
        rows = self.reply_actionable()
        win = tk.Toplevel(self.root)
        win.title("待回消息名单（进入会话会清掉未读角标，此表用于补回该信号）")
        win.geometry("1080x560")
        win.configure(bg="#F5F7FA")

        tk.Label(
            win,
            text=(
                f"共 {len(self.reply_actionable())} 条需要老师处理"
                f"（本次运行共进入 {len(self.reply_notes)} 个会话）。\n"
                "「❌未确认」= 身份核验未通过，但该会话里检测到家长有消息；请人工打开核对。\n"
                "「待人工确认」= 模型没给出明确结论，请自行判断是否需要回复。"
            ),
            font=("Microsoft YaHei", 9),
            fg="#606266",
            bg="#F5F7FA",
            justify="left",
        ).pack(anchor="w", padx=10, pady=(10, 6))

        cols = ("student", "chat", "identity", "sender", "message", "verdict", "time")
        tree = ttk.Treeview(win, columns=cols, show="headings", height=20)
        heads = {
            "student": "学员（本次搜索目标）", "chat": "会话标题", "identity": "身份",
            "sender": "最后一条发送方", "message": "最后一条内容", "verdict": "判定", "time": "记录时间",
        }
        widths = {"student": 130, "chat": 170, "identity": 80, "sender": 90, "message": 330, "verdict": 90, "time": 140}
        for c in cols:
            tree.heading(c, text=heads[c])
            tree.column(c, width=widths[c], stretch=(c == "message"))
        vsb = ttk.Scrollbar(win, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=vsb.set)
        tree.pack(side="top", fill="both", expand=True, padx=10)
        vsb.pack(side="right", fill="y")

        for n in rows:
            tree.insert(
                "", "end",
                values=(
                    n["student"], n["chat_title"], n["identity"], n["last_sender"],
                    (n["last_message"] or "(空)")[:120], n["verdict"], n["time"],
                ),
            )
        tree.tag_configure("need", foreground="#F56C6C")
        tree.tag_configure("unknown", foreground="#E6A23C")
        for i, n in enumerate(rows):
            tree.item(i, tags=("need",) if n["needs_reply"] is True else ("unknown",))

        bar = tk.Frame(win, bg="#F5F7FA")
        bar.pack(side="bottom", fill="x", pady=8)

        def do_export():
            if not rows:
                messagebox.showinfo("提示", "名单为空，无需导出。", parent=win)
                return
            path = filedialog.asksaveasfilename(
                title="导出待回消息名单",
                defaultextension=".csv",
                filetypes=[("CSV 表格 (Excel 兼容)", "*.csv")],
                initialfile=f"待回名单_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.csv",
                parent=win,
            )
            if not path:
                return
            try:
                with open(path, "w", newline="", encoding="utf-8-sig") as f:
                    w = csv.writer(f)
                    w.writerow(["学员（本次搜索目标）", "会话标题", "身份", "最后一条发送方", "最后一条内容", "判定", "记录时间"])
                    for n in rows:
                        w.writerow([n["student"], n["chat_title"], n["identity"], n["last_sender"],
                                    n["last_message"], n["verdict"], n["time"]])
                messagebox.showinfo("导出成功", f"待回名单已导出至：\n{path}", parent=win)
            except Exception as e:
                messagebox.showerror("导出失败", f"保存 CSV 失败：\n{e}", parent=win)

        ttk.Button(bar, text="📤 导出 CSV", command=do_export, width=16).pack(side="left", padx=(0, 8))
        ttk.Button(bar, text="关闭", command=win.destroy, width=12).pack(side="right")

    # ================= 导出记录与悬浮条 =================

    def export_report(self):
        """导出当前发送结果报告为 CSV"""
        if not self.send_logs:
            messagebox.showinfo("提示", "暂无发送日志可导出。")
            return

        save_path = filedialog.asksaveasfilename(
            title="导出发送记录",
            defaultextension=".csv",
            filetypes=[("CSV 表格 (Excel 兼容)", "*.csv")],
            initialfile=f"发送记录_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.csv",
        )
        if not save_path:
            return

        try:
            with open(save_path, "w", newline="", encoding="utf-8-sig") as f:
                writer = csv.writer(f)
                writer.writerow(["序号", "学生学号/姓名", "来源文件", "发送状态", "发送时间", "消息字数"])
                for log in self.send_logs:
                    writer.writerow([log["index"], log["name"], log.get("file", ""), log["status"], log["time"], log["msg_len"]])
            messagebox.showinfo("导出成功", f"发送记录已成功导出至：\n{save_path}")
        except Exception as e:
            messagebox.showerror("导出失败", f"保存 CSV 失败：\n{e}")

    def show_floating_window(self, text):
        """展示屏幕顶部置顶黄色/红色告警条"""
        if self.float_win:
            try:
                self.float_win.destroy()
            except Exception:
                pass

        self.float_win = tk.Toplevel(self.root)
        self.float_win.overrideredirect(True)
        self.float_win.attributes("-topmost", True)
        self.float_win.attributes("-alpha", 0.92)
        self.float_win.configure(bg="#FFF8E6")

        frame = tk.Frame(self.float_win, bg="#FFF8E6", highlightbackground="#F56C6C", highlightthickness=2)
        frame.pack(fill="both", expand=True)

        lbl = tk.Label(
            frame,
            text=text,
            font=("Microsoft YaHei", 11, "bold"),
            fg="#F56C6C",
            bg="#FFF8E6",
            padx=18,
            pady=8,
        )
        lbl.pack()

        self.float_win.update_idletasks()
        w = self.float_win.winfo_reqwidth()
        h = self.float_win.winfo_reqheight()
        sw = self.root.winfo_screenwidth()
        x = (sw - w) // 2
        y = 25
        self.float_win.geometry(f"{w}x{h}+{x}+{y}")

    def hide_floating_window(self):
        """隐藏悬浮窗"""
        if self.float_win:
            try:
                self.float_win.destroy()
            except Exception:
                pass
            self.float_win = None

    def open_history_dialog(self):
        """打开班级发送历史记录管理中心"""
        HistoryDialog(self.root, self.history_mgr, on_reload_file=self.reload_from_history)

    def reload_from_history(self, file_path: str, cycle: str = ""):
        """从历史记录窗口重载班级文件到主界面"""
        self.select_file(target_path=file_path)
        if cycle:
            self.current_cycle = cycle
            self.cycle_var.set(cycle)
            # 重新以此周次同步并刷新名单状态
            self.history_mgr.sync_file_loaded(file_path, self.data, cycle=self.current_cycle)
            self.load_preview()

    def open_log_file(self):
        """打开本地运行调试日志文件 (feedback_debug.log)"""
        try:
            if not os.path.exists(LOG_FILE_PATH):
                log("初始化调试日志文件", "INFO")
            os.startfile(LOG_FILE_PATH)
        except Exception as e:
            try:
                import subprocess
                subprocess.Popen(["notepad.exe", LOG_FILE_PATH])
            except Exception as err2:
                messagebox.showerror("打开失败", f"无法打开日志文件：\n{e}\n{err2}")

    def open_debug_dir(self):
        """打开现场调试截图归档目录"""
        try:
            os.makedirs(DEBUG_IMG_DIR, exist_ok=True)
            os.startfile(DEBUG_IMG_DIR)
        except Exception as e:
            messagebox.showerror("打开失败", f"无法打开调试截图目录：\n{e}")

    def run(self):
        """启动应用"""
        self.root.mainloop()


if __name__ == "__main__":
    # 避免在无控制台(--noconsole)模式下由于 sys.stdout 为 None 引发的输出异常
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w")

    pyautogui.FAILSAFE = True
    pyautogui.PAUSE = 0.08

    app = FeedbackSender()
    app.run()
