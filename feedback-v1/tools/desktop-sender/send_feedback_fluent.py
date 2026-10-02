# -*- coding: utf-8 -*-
"""
企业微信自动发送反馈脚本 (Fluent 现代版 v1.6)
- 基于 Sun Valley ttk (sv-ttk) 现代 Windows 11 设计语言
- 支持 ☀️ 浅色 / 🌙 深色 (Dark Mode) 一键无感切换
- 核心功能：
  1. 周次与周期分类管理体系
  2. AI 视觉智能防误发双保险体系 (云端 Qwen3.8-Flash + 本地离线引擎)
  3. 会话标题安全二次核验检查点与自愈熔断机制
  4. 前台失焦守护、剪贴板竞态校验与防风控真人拟态延时
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
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from threading import Thread

from PIL import Image, ImageEnhance
import pyautogui
import pyperclip
import webbrowser
try:
    import sv_ttk
    HAS_SV_TTK = True
except ImportError:
    HAS_SV_TTK = False

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


def get_rapid_ocr():
    """获取 RapidOCR 全局单例，避免多轮发送反复加载模型的计算与内存开销"""
    global _RAPID_OCR_INSTANCE
    if _RAPID_OCR_INSTANCE is None and HAS_RAPIDOCR:
        try:
            _RAPID_OCR_INSTANCE = RapidOCR()
            log("RapidOCR (PaddleOCR ONNX) 引擎单例初始化成功", "INFO")
        except Exception as e:
            log(f"RapidOCR 初始化异常: {e}", "ERROR")
    return _RAPID_OCR_INSTANCE


def preprocess_dropdown_image(pil_img: Image.Image) -> Image.Image:
    """
    图像前置预处理管线：
    1. 转灰度图消除 ClearType 边缘彩斑杂色
    2. 水印擦除：将企微背景微弱倾斜防泄密水印（亮度通常 > 205）归一化为纯白底色（255），保留核心文字
    3. 双三次插值（BICUBIC）放大 2 倍，强化 12px~14px 小字笔画特征
    """
    try:
        gray = pil_img.convert("L")
        if HAS_RAPIDOCR:
            import numpy as np
            arr = np.array(gray)
            arr[arr > 205] = 255
            cleaned = Image.fromarray(arr)
        else:
            cleaned = gray
        w, h = cleaned.size
        return cleaned.resize((w * 2, h * 2), Image.Resampling.BICUBIC)
    except Exception as e:
        log(f"图像预处理异常，降级使用原图: {e}", "WARN")
        return pil_img

# 客户端应用版本号
APP_VERSION = "v1.6-fluent"


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

# 基础默认延时配置 (秒)
SEARCH_DELAY = 1.5
CLICK_DELAY = 0.5
TYPE_DELAY = 0.3
SEND_DELAY = 1.0
DEFAULT_MIN_DELAY = 2.0
DEFAULT_MAX_DELAY = 5.0
DEFAULT_BATCH_SIZE = 10
DEFAULT_BATCH_DELAY = 8.0


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
    """
    raw = raw_name.strip()
    match = re.match(r"^(\d+)[\s\-_\.、]*(.*)$", raw)
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


def evaluate_contact_candidates(contacts: list, target_id: str, target_name: str, full_text_summary: str = "", engine: str = "OCR") -> tuple:
    """
    通用联系人列表决策中枢：
    输入有序的联系人列表（从上到下），统一做出智能决策：
    - choice == 1: 第 1 项即为本人
    - choice >= 2: 第 1 项为他人描述，第 choice 项为本人 (自动按向下键纠正)
    - choice == -2: 全部为他人描述，无本人备注 (安全拦截)
    - choice == 0: 未找到该联系人 / 显示全局搜索提示 (安全跳过)
    """
    if not contacts:
        empty_keywords = ["进入全局搜索", "全局搜索", "查找所有", "网络查找", "没有找到", "无结果", "未找到", "暂无结果"]
        if any(k in full_text_summary for k in empty_keywords):
            return 0, f"未找到该联系人(显示全局搜索) [{engine}]"
        return 0, f"未找到该联系人 [{engine}]"

    def match_contact(c):
        title = c.get('title', '').strip()
        if not title:
            return False
        # 排除全局搜索等按钮项
        if any(k in title for k in ["全局", "查找", "搜索", "网络"]):
            return False
        # 1. 标题包含数字学号 (如 '90001', '90001张三')
        if target_id and target_id in title:
            return True
        # 2. 标题包含目标学生纯姓名 (如 '张三', '张三妈妈')
        if target_name and target_name in title:
            return True
        # 3. 复合验证：学号 + 姓名首字
        if target_id and target_name and len(target_name) >= 2:
            if target_id in title and target_name[0] in title:
                return True
        # 4. 姓名多字模糊容错 (如 3 字中 2 字，防止 OCR 或字体漏字符)
        if not target_id and target_name and len(target_name) >= 3:
            hits = sum(1 for ch in target_name if ch in title)
            if hits >= len(target_name) - 1:
                return True
        return False

    for c in contacts:
        c['is_target'] = match_contact(c)

    target_pos = None
    for idx, c in enumerate(contacts):
        if c['is_target']:
            target_pos = idx + 1
            break

    has_any_desc = any(c.get('has_desc', False) for c in contacts)

    if target_pos == 1:
        choice = 1
        reason = f"第1项即为目标本人 ({contacts[0].get('title', '')}) [{engine}]"
    elif target_pos is not None and target_pos >= 2:
        choice = target_pos
        reason = f"第1项为他人描述，第{target_pos}项为目标本人 ({contacts[target_pos-1].get('title', '')}) [{engine}]"
    elif has_any_desc and target_pos is None:
        choice = -2
        reason = f"全部为他人描述，无本人备注 [{engine}]"
    else:
        choice = 0
        reason = f"未找到该联系人 [{engine}]"

    return choice, reason


def detect_dropdown_target_via_ocr(wecom_rect: tuple, target_id: str, target_name: str) -> tuple:
    """
    【模式 B 核心决策：自适应 RapidOCR / WinOCR 视觉智能识别】
    自动根据当前显示器 DPI 缩放比例 (100%~200%+) 动态换算物理裁剪坐标，
    精准避开顶部搜索框自身文字，截取下拉候选框并做结构化分析。
    """
    if not HAS_OCR or not wecom_rect:
        log(f"模式 B OCR 视觉决策跳过: HAS_OCR={HAS_OCR}, wecom_rect={wecom_rect}", "WARN")
        return -1, ""

    crop_img = None
    try:
        wx, wy, ww, wh = wecom_rect
        wecom_hwnd = get_wecom_hwnd()
        scale = get_display_scale(wecom_hwnd)
        vx, vy, vw, vh = get_virtual_screen_bounds()

        # 动态缩放设计基准 (以 100% 缩放 96 DPI 为基准):
        # 1. 搜索框自身高度基准约 46px (在 100% 屏为 46px，在 125% 屏为 58px，在 150% 屏为 69px，在 200% 屏为 92px)
        offset_y = int(46 * scale)
        offset_x = int(38 * scale)

        # 2. 下拉框裁剪宽度与高度基准
        base_w = int(350 * scale)
        base_h = int(360 * scale)

        crop_x = max(vx, wx + offset_x)
        crop_y = max(vy, wy + offset_y)
        crop_w = max(int(200 * scale), min(base_w, int(ww * 0.45)))
        crop_h = max(int(100 * scale), min(base_h, wh - offset_y - 10))

        # 确保裁剪区域不超出虚拟桌面总边界
        if crop_x + crop_w > vx + vw:
            crop_w = max(50, (vx + vw) - crop_x)
        if crop_y + crop_h > vy + vh:
            crop_h = max(50, (vy + vh) - crop_y)

        crop_img = pyautogui.screenshot(region=(crop_x, crop_y, crop_w, crop_h))

        lines_with_pos = []
        dropdown_full_text = ""
        engine_used = "none"

        # 优先使用 RapidOCR (PaddleOCR ONNX 极速离线高精度引擎)
        rapid_engine = get_rapid_ocr()
        if rapid_engine is not None:
            try:
                import numpy as np
                res, _ = rapid_engine(np.array(crop_img.convert("RGB")))
                if res:
                    engine_used = "RapidOCR"
                    dropdown_full_text = "".join(item[1].replace(" ", "") for item in res)
                    for box, text, score in res:
                        xs = [pt[0] for pt in box]
                        ys = [pt[1] for pt in box]
                        min_x = min(xs)
                        avg_y = (min(ys) + max(ys)) / 2.0
                        cleaned_text = text.replace(" ", "")
                        if cleaned_text:
                            lines_with_pos.append((avg_y, min_x, cleaned_text))
            except Exception as rapid_err:
                log(f"RapidOCR 执行异常，尝试降级至 WinOCR: {rapid_err}", "WARN")

        # 降级备用: WinOCR
        if not lines_with_pos and HAS_WINOCR:
            try:
                proc_win_img = preprocess_dropdown_image(crop_img)
                res_win = asyncio.run(winocr.recognize_pil(proc_win_img, lang="zh-Hans-CN"))
                engine_used = "WinOCR"
                dropdown_full_text = "".join(l.text.replace(" ", "") for l in res_win.lines)
                for l in res_win.lines:
                    if not l.words:
                        continue
                    min_x = min(w.bounding_rect.x for w in l.words) / 2.0
                    avg_y = (sum(w.bounding_rect.y for w in l.words) / len(l.words)) / 2.0
                    text = "".join(w.text for w in l.words).replace(" ", "")
                    if text:
                        lines_with_pos.append((avg_y, min_x, text))
            except Exception as we:
                log(f"WinOCR 降级执行异常: {we}", "WARN")

        log(f"[{engine_used}识别] 目标: 学号='{target_id}', 姓名='{target_name}', 下拉文本: {dropdown_full_text}", "DEBUG")

        # 按 Y 轴垂直坐标升序排序
        lines_with_pos.sort(key=lambda item: item[0])

        # 过滤杂质行与右侧浮动水印 (自适应当前 DPI 缩放)
        min_text_x = int(25 * scale)
        max_text_x = int(360 * scale)
        watermark_x_threshold = int(120 * scale)

        valid_lines = []
        for y, x, text in lines_with_pos:
            if x < min_text_x or x > max_text_x:
                continue
            if text.isdigit() and len(text) <= 4:
                continue
            # 排除全局搜索、微盘等非联系人按钮文本
            if any(k in text for k in ["全局搜索", "查找所有", "微盘等", "网络查找", "相关搜索"]):
                continue
            # 水印与右侧浮动杂质过滤：真实联系人标题及副标题均紧贴左侧头像
            # 若 x 超过阈值且不包含联系人关键字段（如描述/手机/包含/昵称），则属于屏幕防泄密倾斜水印或右侧标签，坚决过滤
            if x > watermark_x_threshold and not any(kw in text for kw in ["描述", "手机", "包含", "昵称", "微信", "外部"]):
                continue
            valid_lines.append((y, x, text))

        contact_headers = ["联系人", "外部联系人", "客户", "企业通讯录"]
        section_end_keywords = [
            "群聊", "最常使用", "功能", "聊天记录", "文档",
            "网络查找", "相关搜索", "查看全部", "进入全局搜索", "查找所有"
        ]
        subtitle_keywords = [
            "描述", "庙述", "猫述", "描术", "微信昵称", "昵称",
            "手机号", "手机", "包含", "部门", "企业", "公司", "邮箱", "微信号", "备注", "含"
        ]

        def is_subtitle(t):
            return any(kw in t for kw in subtitle_keywords) or ("：" in t) or (":" in t)

        has_contact_header = any(any(h in item[2] for h in contact_headers) for item in valid_lines)
        has_empty_indicator = any(k in dropdown_full_text for k in ["进入全局搜索", "全局搜索", "查找所有", "网络查找", "没有找到", "无结果", "未找到", "暂无结果"])

        # 核心防误点：若下拉框中明确提示“进入全局搜索”，且上方没有任何“联系人”分组标题，直接判定为无此联系人，严禁盲点进入！
        if not has_contact_header and has_empty_indicator:
            log(f"[OCR识别] 下拉框无联系人分组且显示全局搜索提示，确凿判定通讯录中无此联系人", "INFO")
            _save_dropdown_debug_shot(crop_img, target_id, target_name, 0, tag="not_found")
            return 0, f"通讯录中无此联系人(显示全局搜索) [{engine_used}]"

        contacts = []
        current_contact = None
        in_contacts_section = not has_contact_header

        for y, x, text in valid_lines:
            if any(h in text for h in contact_headers):
                in_contacts_section = True
                continue

            # 遇到群聊或下一分类，联系人分组正常结束
            if in_contacts_section and any(h in text for h in section_end_keywords):
                if current_contact:
                    contacts.append(current_contact)
                    current_contact = None
                in_contacts_section = False
                break

            # 遇到“包含”（通常是群聊名称匹配或聊天记录包含），也代表进入了群聊分组
            if in_contacts_section and ("包含" in text or "包含:" in text or "包含：" in text):
                current_contact = None
                in_contacts_section = False
                break

            if in_contacts_section:
                if is_subtitle(text):
                    if current_contact:
                        current_contact['subtitles'].append(text)
                        if any(k in text for k in ["描述", "庙述", "猫述", "描术", "含"]):
                            current_contact['has_desc'] = True
                            current_contact['desc_text'] = text
                    else:
                        current_contact = {
                            'title': '',
                            'subtitles': [text],
                            'has_desc': True,
                            'desc_text': text,
                            'y': y
                        }
                else:
                    if current_contact:
                        contacts.append(current_contact)
                    current_contact = {
                        'title': text,
                        'subtitles': [],
                        'has_desc': False,
                        'desc_text': '',
                        'y': y
                    }

        if current_contact:
            contacts.append(current_contact)

        log(f"[OCR解析联系人] 数量={len(contacts)}: {[c['title'] + (' [含描述]' if c['has_desc'] else '') for c in contacts]}", "DEBUG")

        choice, reason = evaluate_contact_candidates(contacts, target_id, target_name, dropdown_full_text, engine=engine_used)
        log(f"[OCR决策({engine_used})] 目标: id={target_id}, name={target_name} => choice={choice}, reason={reason}", "INFO" if choice > 0 else "WARN")

        # 现场调试截图归档 (全量留存每个学生的识别现场以供审查)
        _save_dropdown_debug_shot(crop_img, target_id, target_name, choice)

        return choice, reason

    except Exception as e:
        log(f"模式 B 下拉框 OCR 分析异常: {e}", "ERROR")
        _save_dropdown_debug_shot(crop_img, target_id, target_name, -1, tag="exception")
        return -1, ""


def _save_dropdown_debug_shot(crop_img, target_id: str, target_name: str, choice: int, tag: str = ""):
    """保存下拉框判定现场快照留证 (全量存档以供审查复盘)"""
    if not crop_img:
        return
    try:
        os.makedirs(DEBUG_IMG_DIR, exist_ok=True)
        safe_name = re.sub(r'[\\/:*?"<>|\s]', '_', f"{target_id}_{target_name}").strip('_') or "unknown"
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
        suffix = f"_{tag}" if tag else ""
        shot_path = os.path.join(DEBUG_IMG_DIR, f"{ts}_{safe_name}_choice{choice}{suffix}.png")
        crop_img.save(shot_path)
        log(f"[现场调试快照] 已归档至: {shot_path}", "DEBUG")
    except Exception as se:
        log(f"[现场调试快照保存失败]: {se}", "WARN")


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


def detect_dropdown_target(wecom_rect: tuple, target_id: str, target_name: str, mode: str = "A", auto_fallback: bool = True) -> tuple:
    """
    【下拉候选框视觉智能决策总控】
    模式 A: 通义千问 Qwen3.8-Flash 大模型视觉感知 (语义推断、关系消歧)
    模式 B: 本地 RapidOCR / WinOCR 视觉引擎 (离线、本地)
    auto_fallback: 模式 A 发生网络或服务端异常时，自动平滑降级至模式 B
    返回: (choice, reason)
      choice >= 1: 命中项序号
      choice == 0: 通讯录中无此联系人 (全局搜索)
      choice == -2: 仅他人描述 (无本人独立条目)
      choice == -1: 未确立或出错
    """
    if not wecom_rect:
        log("未获取到企业微信窗口坐标，跳过下拉框视觉核验", "WARN")
        return -1, ""

    if mode == "A":
        crop_img = capture_dropdown_crop(wecom_rect)
        if crop_img:
            choice, reason = detect_dropdown_target_via_vlm(crop_img, target_id, target_name)
            if choice != -1:
                _save_dropdown_debug_shot(crop_img, target_id, target_name, choice, tag="vlm")
                return choice, reason

            # choice == -1 表示 VLM 调用出错或网络异常
            if auto_fallback and HAS_OCR:
                log(f"云端 AI 视觉识别异常 ({reason})，自动无缝切换为本地备用引擎...", "WARN")
                return detect_dropdown_target_via_ocr(wecom_rect, target_id, target_name)
            return choice, reason
        else:
            if auto_fallback and HAS_OCR:
                log("截取下拉框区域失败，自动切换至本地备用引擎...", "WARN")
                return detect_dropdown_target_via_ocr(wecom_rect, target_id, target_name)
            return -1, "截屏失败"

    elif mode == "B":
        if HAS_OCR:
            return detect_dropdown_target_via_ocr(wecom_rect, target_id, target_name)
        log("本地视觉核验跳过: 未安装可用本地 OCR 引擎", "WARN")
        return -1, ""

    return -1, "智能核验已关闭"


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
                # 1. 匹配目标学号或姓名 (直接放行)
                if (target_id and target_id in header_text) or (target_name and target_name in header_text):
                    log(f"[标题检查点 ✓ 放行] 标题命中目标: '{header_text}' (预期: id='{target_id}', name='{target_name}')", "INFO")
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
        if (target_id and target_id in last_detected) or (target_name and target_name in last_detected):
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


def call_cloud_vision(task: str, crop_img: Image.Image, target_id: str, target_name: str, timeout: float = 10.0) -> dict:
    """
    向服务端 api/desktop.php?action=vision_detect 发起大模型视觉分析请求。
    task: 'dropdown' | 'header'
    返回: dict (包含 choice/matched, reason, duration_ms 等)
    """
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


def capture_dropdown_crop(wecom_rect: tuple):
    """动态 DPI 自适应截取企微搜索下拉列表区域 (约 380x460 物理像素)"""
    if not wecom_rect:
        return None
    try:
        wx, wy, ww, wh = wecom_rect
        wecom_hwnd = get_wecom_hwnd()
        scale = get_display_scale(wecom_hwnd)
        vx, vy, vw, vh = get_virtual_screen_bounds()

        offset_y = int(46 * scale)
        offset_x = int(38 * scale)
        base_w = int(380 * scale)
        base_h = int(460 * scale)

        crop_x = max(vx, wx + offset_x)
        crop_y = max(vy, wy + offset_y)
        crop_w = max(int(200 * scale), min(base_w, int(ww * 0.45)))
        crop_h = max(int(120 * scale), min(base_h, wh - offset_y - 10))

        if crop_x + crop_w > vx + vw:
            crop_w = max(50, (vx + vw) - crop_x)
        if crop_y + crop_h > vy + vh:
            crop_h = max(50, (vy + vh) - crop_y)

        return pyautogui.screenshot(region=(crop_x, crop_y, crop_w, crop_h))
    except Exception as e:
        log(f"截取下拉框区域异常: {e}", "WARN")
        return None


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


def detect_dropdown_target_via_vlm(crop_img, target_id: str, target_name: str) -> tuple:
    """
    通过云端大模型 API 分析搜索下拉候选列表
    返回: (choice, reason)
    """
    res = call_cloud_vision("dropdown", crop_img, target_id, target_name)
    if not res.get("success"):
        return -1, res.get("error", "VLM 接口调用失败")
    choice = int(res.get("choice", -1))
    matched_title = res.get("matched_title", "")
    reason = res.get("reason", "")
    target_found = res.get("target_found", True)

    # 逻辑防御层 1：如果大模型在 target_found 中标记为 False，坚决不允许 choice > 0
    if target_found is False:
        if choice > 0:
            choice = -2 if ("描述" in reason or "聊天记录" in reason or "群聊" in reason) else 0

    # 逻辑防御层 2：如果 reason 明确指出“不存在”、“拦截”、“非独立联系人”、“仅在他人描述”或“聊天记录”
    intercept_keywords = ["不存在", "拦截", "他人描述", "聊天记录", "群聊", "未找到", "无独立联系人", "并非本人", "非本人"]
    if any(kw in reason for kw in intercept_keywords):
        if "仅在他人描述" in reason or "聊天记录" in reason or "群聊" in reason or "他人备注" in reason:
            choice = -2
        elif "不存在" in reason or "未找到" in reason:
            choice = 0

    # 逻辑防御层 3：如果 choice == 1，但 matched_title 既不包含 target_id 也不包含 target_name
    # 比如模型把【老板（企微）】作为第1项输出 choice: 1，这属于幻觉/模板惯性，坚决纠偏拦截
    if choice == 1:
        has_id = bool(target_id and target_id in matched_title)
        has_name = bool(target_name and target_name in matched_title)
        if not has_id and not has_name:
            log(f"[大模型决策纠偏] 警告：模型返回 choice=1 但标题 '{matched_title}' 既不含学号 '{target_id}' 也不含姓名 '{target_name}'，修正为安全拦截 (choice=-2)", "WARN")
            choice = -2

    log(f"[大模型选人决策] choice={choice}, title='{matched_title}', reason='{reason}'", "INFO")
    return choice, f"{reason}"


def verify_chat_header_title_via_vlm(crop_img, target_id: str, target_name: str) -> tuple:
    """
    通过云端大模型 API 核验会话顶部标题栏
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
        # 1. 直接命中现有 key
        if file_path_or_name in self._data["classes"]:
            return file_path_or_name

        c_name = clean_class_name_from_path(file_path_or_name)
        f_name = os.path.basename(file_path_or_name)
        cyc = (cycle or "").strip()
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

        top_bar = ttk.Frame(container)
        top_bar.pack(side="top", fill="x", pady=(0, 10))

        ttk.Label(
            top_bar,
            text="班级发送历史与存档记录",
            font=("Microsoft YaHei", 14, "bold"),
        ).pack(side="left")

        ttk.Label(
            top_bar,
            text="（自动记录已发、待发与失败名单，支持一键重发或导出表格）",
            font=("Microsoft YaHei", 9),
        ).pack(side="left", padx=(8, 0), pady=(4, 0))

        paned = ttk.PanedWindow(container, orient=tk.HORIZONTAL)
        paned.pack(side="top", fill="both", expand=True)

        # 左侧：班级列表 (含周次筛选)
        left_frame = ttk.LabelFrame(paned, text="📚 班级 / 发送周次", padding=8)
        paned.add(left_frame, weight=3)

        # 1. 周次筛选器
        cycle_filter_frame = ttk.Frame(left_frame)
        cycle_filter_frame.pack(fill="x", pady=(0, 4))
        ttk.Label(cycle_filter_frame, text="📅 周次:", font=("Microsoft YaHei", 9, "bold")).pack(side="left")
        self.cycle_filter_combo = ttk.Combobox(
            cycle_filter_frame,
            textvariable=self.filter_cycle_var,
            state="readonly",
            width=12
        )
        self.cycle_filter_combo.pack(side="left", fill="x", expand=True, padx=(4, 0))
        self.cycle_filter_combo.bind("<<ComboboxSelected>>", lambda e: self._filter_classes())

        # 2. 班级搜索框
        search_frame = ttk.Frame(left_frame)
        search_frame.pack(fill="x", pady=(0, 6))

        ttk.Label(search_frame, text="🔍", font=("Microsoft YaHei", 10)).pack(side="left")
        class_entry = ttk.Entry(search_frame, textvariable=self.search_class_var)
        class_entry.pack(side="left", fill="x", expand=True, padx=(4, 0))
        self.search_class_var.trace_add("write", lambda *a: self._filter_classes())

        class_tree_frame = ttk.Frame(left_frame)
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

        left_btns = ttk.Frame(left_frame)
        left_btns.pack(fill="x", pady=(8, 0))

        ttk.Button(left_btns, text="🗑️ 删除选中", command=self._delete_selected_class, width=11).pack(side="left")
        ttk.Button(left_btns, text="🧹 清空全部", command=self._clear_all_history, width=11).pack(side="right")

        # 右侧：学生明细
        right_frame = ttk.LabelFrame(paned, text="📋 发送名单明细", padding=8)
        paned.add(right_frame, weight=7)

        header_box = ttk.Frame(right_frame, padding=8)
        header_box.pack(fill="x", pady=(0, 8))

        self.cur_class_title = ttk.Label(
            header_box,
            text="请在左侧选择一个班级查看",
            font=("Microsoft YaHei", 12, "bold"),
        )
        self.cur_class_title.pack(anchor="w")

        self.cur_class_file = ttk.Label(
            header_box,
            text="",
            font=("Microsoft YaHei", 9),
        )
        self.cur_class_file.pack(anchor="w", pady=(2, 6))

        badges_row = ttk.Frame(header_box)
        badges_row.pack(anchor="w")

        self.badge_total = ttk.Label(badges_row, text="总计: 0 人", font=("Microsoft YaHei", 9, "bold"), padding=(6, 2))
        self.badge_total.pack(side="left", padx=(0, 6))

        self.badge_sent = ttk.Label(badges_row, text="✓ 已发送: 0", font=("Microsoft YaHei", 9, "bold"), padding=(6, 2))
        self.badge_sent.pack(side="left", padx=(0, 6))

        self.badge_unsent = ttk.Label(badges_row, text="⏳ 未发送: 0", font=("Microsoft YaHei", 9, "bold"), padding=(6, 2))
        self.badge_unsent.pack(side="left", padx=(0, 6))

        self.badge_failed = ttk.Label(badges_row, text="⚠️ 异常/失败: 0", font=("Microsoft YaHei", 9, "bold"), padding=(6, 2))
        self.badge_failed.pack(side="left")

        filter_row = ttk.Frame(right_frame)
        filter_row.pack(fill="x", pady=(0, 6))

        self.btn_filter_all = ttk.Button(filter_row, text="全部", command=lambda: self._set_filter("ALL"), width=8)
        self.btn_filter_all.pack(side="left", padx=(0, 4))

        self.btn_filter_sent = ttk.Button(filter_row, text="已发送", command=lambda: self._set_filter("SENT"), width=8)
        self.btn_filter_sent.pack(side="left", padx=(0, 4))

        self.btn_filter_unsent = ttk.Button(filter_row, text="未发送", command=lambda: self._set_filter("UNSENT"), width=8)
        self.btn_filter_unsent.pack(side="left", padx=(0, 4))

        self.btn_filter_failed = ttk.Button(filter_row, text="失败/拦截", command=lambda: self._set_filter("FAILED"), width=10)
        self.btn_filter_failed.pack(side="left", padx=(0, 10))

        ttk.Label(filter_row, text="🔍", font=("Microsoft YaHei", 9)).pack(side="left")
        stu_search = ttk.Entry(filter_row, textvariable=self.search_student_var, width=16)
        stu_search.pack(side="left", padx=(4, 0))
        self.search_student_var.trace_add("write", lambda *a: self._render_students())

        stu_tree_frame = ttk.Frame(right_frame)
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

        stu_scroll = ttk.Scrollbar(stu_tree_frame, orient="vertical", command=self.stu_tree.yview)
        self.stu_tree.configure(yscrollcommand=stu_scroll.set)

        self.stu_tree.pack(side="left", fill="both", expand=True)
        stu_scroll.pack(side="right", fill="y")
        self.stu_tree.bind("<<TreeviewSelect>>", self._on_student_select)

        preview_label = ttk.Label(right_frame, text="💬 评语文案摘要与预览:", font=("Microsoft YaHei", 9, "bold"))
        preview_label.pack(anchor="w", pady=(6, 2))

        preview_frame = ttk.Frame(right_frame)
        preview_frame.pack(fill="x", pady=(0, 8))

        self.msg_preview = tk.Text(preview_frame, height=3, font=("Consolas", 9), wrap="word", padx=6, pady=4, relief="solid", borderwidth=1)
        self.msg_preview.pack(fill="x", expand=True)
        self.msg_preview.insert("1.0", "（点击上方学生行可预览其完整反馈评语）")
        self.msg_preview.config(state="disabled")

        bottom_bar = ttk.Frame(container)
        bottom_bar.pack(side="bottom", fill="x", pady=(8, 0))

        self.reload_btn = ttk.Button(
            bottom_bar,
            text="🔄 载入主界面继续发送",
            command=self._reload_to_main,
            style="Accent.TButton",
            width=22,
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
    """极方每周反馈程序 (Fluent 现代版) - Windows 11 Fluent 架构主控制器"""

    def __init__(self):
        self.root = tk.Tk()
        self.root.title(f"极方每周反馈程序 (Fluent 现代版) {APP_VERSION}")

        # 尝试设置窗口图标
        try:
            icon_path = get_resource_path("favicon.ico")
            if not os.path.exists(icon_path):
                parent_icon = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "favicon.ico")
                if os.path.exists(parent_icon):
                    icon_path = parent_icon
            if os.path.exists(icon_path):
                self.root.iconbitmap(icon_path)
        except Exception:
            pass

        # 屏幕分辨率动态自适应计算
        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()
        win_w = min(1200, max(1000, int(sw * 0.85)))
        win_h = min(860, max(740, int(sh * 0.88)))
        pos_x = max(0, (sw - win_w) // 2)
        pos_y = max(0, (sh - win_h) // 2 - 25)
        self.root.geometry(f"{win_w}x{win_h}+{pos_x}+{pos_y}")
        self.root.minsize(980, 680)

        # 主题初始化
        self.current_theme = "light"
        self._init_styles()

        # 数据与状态
        self.data = []           # 内存合并发送队列
        self.loaded_files = []   # 已载入文件列表
        self.is_running = False
        self.current_file_path = ""
        self.send_logs = []
        self.history_mgr = HistoryManager()
        self.current_cycle = "第 1 周"
        self.cycle_var = tk.StringVar(value="第 1 周")

        # 搜索与过滤状态
        self.search_var = tk.StringVar()
        self.current_filter = "ALL"  # "ALL", "UNSENT", "SENT", "FAILED"
        self.current_preview_idx = -1
        self.current_preview_url = ""

        # 配置参数变量
        self.min_delay_var = tk.DoubleVar(value=DEFAULT_MIN_DELAY)
        self.max_delay_var = tk.DoubleVar(value=DEFAULT_MAX_DELAY)
        self.batch_rest_enable_var = tk.BooleanVar(value=True)
        self.batch_size_var = tk.IntVar(value=DEFAULT_BATCH_SIZE)
        self.batch_delay_var = tk.DoubleVar(value=DEFAULT_BATCH_DELAY)
        self.smart_mode_var = tk.StringVar(value="A")  # "A"(大模型), "B"(本地OCR), "OFF"(关闭)
        self.auto_fallback_var = tk.BooleanVar(value=True)
        self.smart_ocr_enable_var = tk.BooleanVar(value=True)

        self.float_win = None
        self.pages = {}
        self.nav_buttons = {}
        self.current_page = "workspace"

        # 历史中心页面独立状态变量
        self.hist_selected_class_key = None
        self.hist_filter_cycle_var = tk.StringVar(value="全部周次")
        self.hist_search_class_var = tk.StringVar()
        self.hist_current_filter = "ALL"

        self.setup_ui()

        # 全局快捷键
        self.root.bind("<Escape>", lambda e: self.stop_sending())
        self.root.bind("<Control-Key-1>", lambda e: self.switch_page("workspace"))
        self.root.bind("<Control-Key-2>", lambda e: self.switch_page("history"))
        self.root.bind("<Control-Key-3>", lambda e: self.switch_page("logs"))
        self.root.bind("<Control-Key-4>", lambda e: self.switch_page("settings"))
        self.root.bind("<Control-comma>", lambda e: self.switch_page("settings"))
        self.root.bind("<Control-h>", lambda e: self.switch_page("history"))
        self.root.bind("<Control-H>", lambda e: self.switch_page("history"))
        self.root.bind("<Control-l>", lambda e: self.switch_page("logs"))
        self.root.bind("<Control-L>", lambda e: self.switch_page("logs"))
        self.root.bind("<Control-c>", lambda e: self.copy_selected_student_name())
        self.root.bind("<Control-C>", lambda e: self.copy_selected_student_name())

        log(f"极方每周反馈程序 (Fluent 现代版) {APP_VERSION} 初始化完成 | 数据目录: {get_data_dir()} | 日志路径: {LOG_FILE_PATH} | RapidOCR可用: {HAS_RAPIDOCR} | WinOCR可用: {HAS_WINOCR}", "INFO")

        self.root.protocol("WM_DELETE_WINDOW", self._on_app_close)
        try:
            cloud_upload_async(include_history=False)
        except Exception:
            pass

    def _on_app_close(self):
        """退出：后台上报本次日志与发送历史，然后销毁窗口"""
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

    def _init_styles(self):
        """初始化现代 Fluent 主题"""
        if HAS_SV_TTK:
            try:
                sv_ttk.set_theme(getattr(self, "current_theme", "light"))
            except Exception:
                pass
        else:
            style = ttk.Style()
            if "clam" in style.theme_names():
                style.theme_use("clam")

    def toggle_app_theme(self):
        """一键切换 ☀️ 浅色 / 🌙 深色 Fluent 现代主题"""
        if HAS_SV_TTK:
            try:
                sv_ttk.toggle_theme()
                self.current_theme = sv_ttk.get_theme()
            except Exception:
                self.current_theme = "dark" if self.current_theme == "light" else "light"
        else:
            self.current_theme = "dark" if self.current_theme == "light" else "light"

        if hasattr(self, "theme_btn"):
            if self.current_theme == "dark":
                self.theme_btn.config(text="☀️ 浅色模式")
            else:
                self.theme_btn.config(text="🌙 深色模式")

        self._update_theme_colors()
        log(f"界面主题已切换为: {self.current_theme}", "INFO")

    def _update_theme_colors(self):
        """根据深浅色同步原生 Tk 组件色彩"""
        is_dark = (self.current_theme == "dark")
        text_bg = "#252525" if is_dark else "#FFFFFF"
        text_fg = "#F0F0F0" if is_dark else "#1F1F1F"

        if hasattr(self, "preview_text"):
            try:
                self.preview_text.config(
                    bg=text_bg,
                    fg=text_fg,
                    insertbackground="#FFFFFF" if is_dark else "#000000",
                    selectbackground="#0078D4" if is_dark else "#CDE6F7",
                )
            except Exception:
                pass

        if hasattr(self, "log_text"):
            try:
                self.log_text.config(
                    bg="#1E1E1E" if is_dark else "#FAFAFA",
                    fg="#D4D4D4" if is_dark else "#2C3E50",
                    insertbackground="#FFFFFF" if is_dark else "#000000",
                )
            except Exception:
                pass

        self._update_nav_styles()

    # ================= 整体页面与侧边栏 =================

    def setup_ui(self):
        """搭建现代 Fluent 侧边栏与多视图工作区"""
        self.app_container = ttk.Frame(self.root)
        self.app_container.pack(fill="both", expand=True)

        # 1. 侧边导航栏 (Navigation Rail)
        self._create_sidebar(self.app_container)

        # 2. 页面容器区
        self.page_container = ttk.Frame(self.app_container)
        self.page_container.pack(side="left", fill="both", expand=True, padx=(4, 12), pady=12)

        # 3. 创建四大核心页面视图
        self._create_workspace_page(self.page_container)
        self._create_history_page(self.page_container)
        self._create_logs_page(self.page_container)
        self._create_settings_page(self.page_container)

        # 默认呈现工作台
        self.switch_page("workspace")
        self.refresh_wecom_status()

    def switch_page(self, page_name: str):
        """在单窗体内无缝切换功能页面"""
        if page_name not in self.pages:
            return
        for name, p_frame in self.pages.items():
            if name == page_name:
                p_frame.pack(fill="both", expand=True)
            else:
                p_frame.pack_forget()

        self.current_page = page_name
        self._update_nav_styles()

        if page_name == "history":
            self._load_history_classes()
        elif page_name == "logs":
            self._load_recent_logs()

    def _update_nav_styles(self):
        """更新侧边栏当前激活 Tab 的高亮样式"""
        for name, btn in self.nav_buttons.items():
            if name == self.current_page:
                btn.config(style="Accent.TButton")
            else:
                btn.config(style="TButton")

    def refresh_wecom_status(self):
        """检测企微前台句柄并更新状态指示器"""
        hwnd = get_wecom_hwnd() if HAS_WIN32 else None
        if hasattr(self, "wecom_status_label"):
            if hwnd:
                self.wecom_status_label.config(text="● 企微已连接", foreground="#67C23A")
            else:
                self.wecom_status_label.config(text="○ 企微未运行", foreground="#909399")
        # 每隔 8 秒静默巡检一次
        self.root.after(8000, self.refresh_wecom_status)

    def _create_sidebar(self, parent):
        """左侧 Fluent Navigation Rail 导航边栏"""
        sidebar = ttk.Frame(parent, width=195, padding=(12, 14, 10, 14))
        sidebar.pack(side="left", fill="y")
        sidebar.pack_propagate(False)

        # 顶部品牌标识
        brand_frame = ttk.Frame(sidebar)
        brand_frame.pack(side="top", fill="x", pady=(0, 16))

        title_lbl = ttk.Label(brand_frame, text="极方反馈", font=("Microsoft YaHei", 15, "bold"))
        title_lbl.pack(anchor="w")

        sub_row = ttk.Frame(brand_frame)
        sub_row.pack(fill="x", pady=(3, 0))

        badge = ttk.Label(sub_row, text="Fluent 2.0", font=("Consolas", 8, "bold"))
        badge.pack(side="left")

        self.wecom_status_label = ttk.Label(sub_row, text="○ 企微检测中", font=("Microsoft YaHei", 8))
        self.wecom_status_label.pack(side="right")

        # 导航按钮清单
        nav_items = [
            ("workspace", "🚀 发送工作台"),
            ("history", "📚 历史档案"),
            ("logs", "📊 运行日志"),
            ("settings", "⚙️ 偏好设置"),
        ]

        nav_frame = ttk.Frame(sidebar)
        nav_frame.pack(side="top", fill="x", pady=(8, 0))

        for key, label in nav_items:
            btn = ttk.Button(
                nav_frame,
                text=label,
                command=lambda k=key: self.switch_page(k),
                width=17,
            )
            btn.pack(fill="x", pady=4)
            self.nav_buttons[key] = btn

        # 底部快捷工具栏
        footer = ttk.Frame(sidebar)
        footer.pack(side="bottom", fill="x")

        self.theme_btn = ttk.Button(
            footer,
            text="🌙 深色模式" if self.current_theme == "light" else "☀️ 浅色模式",
            command=self.toggle_app_theme,
            width=17,
        )
        self.theme_btn.pack(fill="x", pady=(0, 6))

        scale_val = get_display_scale() if HAS_WIN32 else 1.0
        scale_pct = int(round(scale_val * 100))
        scale_lbl = ttk.Label(
            footer,
            text=f"DPI: {scale_pct}% | {APP_VERSION}",
            font=("Microsoft YaHei", 8),
            anchor="center",
        )
        scale_lbl.pack(fill="x")

    # ================= 页面 1：发送工作台 =================

    def _create_workspace_page(self, parent):
        """发送工作台主视图"""
        page = ttk.Frame(parent)
        self.pages["workspace"] = page

        # 1. 顶部控制栏 (周次选择 + 载入文件 + 清空)
        top_bar = ttk.Frame(page)
        top_bar.pack(side="top", fill="x", pady=(0, 10))

        cycle_frame = ttk.Frame(top_bar)
        cycle_frame.pack(side="left")

        ttk.Label(cycle_frame, text="📅 归档周次:", font=("Microsoft YaHei", 10, "bold")).pack(side="left")
        self.cycle_combo = ttk.Combobox(
            cycle_frame,
            textvariable=self.cycle_var,
            values=[f"第 {i} 周" for i in range(1, 25)],
            width=10,
            state="normal",
        )
        self.cycle_combo.pack(side="left", padx=(6, 12))
        self.cycle_combo.bind("<<ComboboxSelected>>", self._on_cycle_changed)
        self.cycle_combo.bind("<FocusOut>", self._on_cycle_changed)
        self.cycle_combo.bind("<Return>", self._on_cycle_changed)

        btn_row = ttk.Frame(top_bar)
        btn_row.pack(side="right")

        select_btn = ttk.Button(
            btn_row,
            text="📂 载入反馈文件 (可多选)",
            command=self.select_files,
            style="Accent.TButton",
            width=22,
        )
        select_btn.pack(side="left", padx=(0, 8))

        clear_btn = ttk.Button(btn_row, text="🗑️ 清空队列", command=self.clear_all_files, width=10)
        clear_btn.pack(side="left")

        # 已载入文件 Chips 胶囊容器
        self.files_frame = ttk.Frame(page)
        self.files_frame.pack(side="top", fill="x", pady=(0, 8))

        self.file_label = ttk.Label(
            self.files_frame,
            text="请先载入导出的 feedback.json 或 .html 网页快照文件（支持多文件追加）",
            font=("Microsoft YaHei", 9),
        )
        self.file_label.pack(side="left", pady=2)

        # 2. 四项数据统计指标卡片 (具备点击一键过滤名单交互)
        self._create_metric_cards(page)

        # 3. 底部命令控制栏 (绝对优先底停靠，防止遮挡)
        self._create_control_panel(page)

        # 4. 双栏分栏内容区 (左名单，右卡片预览)
        self._create_workspace_paned(page)

    def _create_metric_cards(self, parent):
        """创建顶部 4 块可点击交互的数据统计卡片"""
        cards_container = ttk.Frame(parent)
        cards_container.pack(side="top", fill="x", pady=(0, 10))

        # 配置 4 列均匀拉伸
        cards_container.columnconfigure(0, weight=1)
        cards_container.columnconfigure(1, weight=1)
        cards_container.columnconfigure(2, weight=1)
        cards_container.columnconfigure(3, weight=1)

        def make_card(col, title, count_var_name, filter_key, icon_sym):
            card = ttk.Frame(cards_container, padding=(10, 8), style="Card.TFrame" if hasattr(self, "_has_card_style") else "TFrame")
            card.grid(row=0, column=col, sticky="nsew", padx=4)

            top_row = ttk.Frame(card)
            top_row.pack(fill="x")
            ttk.Label(top_row, text=f"{icon_sym} {title}", font=("Microsoft YaHei", 9)).pack(side="left")
            filter_tip = ttk.Label(top_row, text="[点击筛选]", font=("Microsoft YaHei", 8))
            filter_tip.pack(side="right")

            num_lbl = ttk.Label(card, text="0", font=("Microsoft YaHei", 18, "bold"))
            num_lbl.pack(anchor="w", pady=(2, 0))
            setattr(self, count_var_name, num_lbl)

            # 点击卡片联动列表筛选
            def _on_card_click(e):
                self.set_filter(filter_key)
            card.bind("<Button-1>", _on_card_click)
            num_lbl.bind("<Button-1>", _on_card_click)
            top_row.bind("<Button-1>", _on_card_click)
            card.configure(cursor="hand2")

        make_card(0, "总名单人数", "metric_total_num", "ALL", "👥")
        make_card(1, "待发送学员", "metric_unsent_num", "UNSENT", "⏳")
        make_card(2, "已成功发送", "metric_sent_num", "SENT", "✅")
        make_card(3, "异常与拦截", "metric_failed_num", "FAILED", "⚠️")

    def _create_workspace_paned(self, parent):
        """工作台主内容双栏：左侧搜索过滤名单，右侧学员反馈卡片"""
        paned = ttk.PanedWindow(parent, orient=tk.HORIZONTAL)
        paned.pack(side="top", fill="both", expand=True, pady=(0, 6))
        self.paned = paned

        # ---------- 左侧：名单表格区 ----------
        left_frame = ttk.LabelFrame(paned, text="学员发送名单", padding=8)
        paned.add(left_frame, weight=6)

        # 搜索与过滤工具栏
        tool_row = ttk.Frame(left_frame)
        tool_row.pack(fill="x", pady=(0, 6))

        # 搜索框
        search_box = ttk.Frame(tool_row)
        search_box.pack(side="left", fill="x", expand=True)

        ttk.Label(search_box, text="🔍", font=("Segoe UI Emoji", 9)).pack(side="left", padx=(0, 2))
        self.search_entry = ttk.Entry(search_box, textvariable=self.search_var, width=18)
        self.search_entry.pack(side="left", fill="x", expand=True)
        self.search_entry.bind("<KeyRelease>", self._on_search_changed)

        clear_search_btn = ttk.Button(search_box, text="×", width=2, command=self._clear_search)
        clear_search_btn.pack(side="left", padx=(2, 8))

        # 过滤胶囊按钮组
        filter_box = ttk.Frame(tool_row)
        filter_box.pack(side="right")

        self.filter_buttons = {}
        for f_key, f_name in [("ALL", "全部"), ("UNSENT", "待发送"), ("SENT", "已发"), ("FAILED", "异常")]:
            btn = ttk.Button(
                filter_box,
                text=f_name,
                command=lambda k=f_key: self.set_filter(k),
                width=5,
            )
            btn.pack(side="left", padx=1)
            self.filter_buttons[f_key] = btn

        # 表格批量勾选行
        batch_row = ttk.Frame(left_frame)
        batch_row.pack(fill="x", pady=(0, 6))

        ttk.Button(batch_row, text="全选", width=5, command=lambda: self.set_all_checks(True)).pack(side="left", padx=(0, 3))
        ttk.Button(batch_row, text="取消", width=5, command=lambda: self.set_all_checks(False)).pack(side="left", padx=3)
        ttk.Button(batch_row, text="仅待发", width=6, command=self.check_only_unsent).pack(side="left", padx=3)
        ttk.Button(batch_row, text="仅异常", width=6, command=self.check_only_failed).pack(side="left", padx=3)
        ttk.Button(batch_row, text="重置状态", width=8, command=self.reset_all_status).pack(side="left", padx=3)

        self.copy_student_btn = ttk.Button(batch_row, text="📋 复制姓名", width=10, command=self.copy_selected_student_name)
        self.copy_student_btn.pack(side="right")

        # 名单 Treeview 表格
        tree_frame = ttk.Frame(left_frame)
        tree_frame.pack(fill="both", expand=True)

        columns = ("勾选", "序号", "姓名", "状态", "来源")
        self.tree = ttk.Treeview(tree_frame, columns=columns, show="headings", selectmode="browse")

        self.tree.heading("勾选", text="勾选")
        self.tree.heading("序号", text="序号")
        self.tree.heading("姓名", text="学员标识/学号")
        self.tree.heading("状态", text="状态")
        self.tree.heading("来源", text="来源文件")

        self.tree.column("勾选", width=50, minwidth=45, anchor="center")
        self.tree.column("序号", width=50, minwidth=40, anchor="center")
        self.tree.column("姓名", width=220, minwidth=150, anchor="w")
        self.tree.column("状态", width=140, minwidth=120, anchor="center")
        self.tree.column("来源", width=100, minwidth=70, anchor="center")

        tree_scroll = ttk.Scrollbar(tree_frame, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=tree_scroll.set)

        self.tree.pack(side="left", fill="both", expand=True)
        tree_scroll.pack(side="right", fill="y")

        self.tree.bind("<ButtonRelease-1>", self.on_tree_click)
        self.tree.bind("<<TreeviewSelect>>", self.on_tree_select)
        self.tree.bind("<Button-3>", self.show_context_menu)

        # 右键菜单
        self.context_menu = tk.Menu(self.tree, tearoff=0, font=("Microsoft YaHei", 9))
        self.context_menu.add_command(label="📋 复制学员标识 (学号/姓名)", command=self.copy_selected_student_name)
        self.context_menu.add_separator()
        self.context_menu.add_command(label="一键全选 (☑)", command=lambda: self.set_all_checks(True))
        self.context_menu.add_command(label="一键取消全选 (☐)", command=lambda: self.set_all_checks(False))
        self.context_menu.add_separator()
        self.context_menu.add_command(label="仅勾选【未发送/已跳过】", command=self.check_only_unsent)
        self.context_menu.add_command(label="仅勾选【失败/被拦截】", command=self.check_only_failed)
        self.context_menu.add_separator()
        self.context_menu.add_command(label="重置所有状态为【待发送】", command=self.reset_all_status)

        # ---------- 右侧：学员反馈卡片区 ----------
        right_frame = ttk.LabelFrame(paned, text="学员反馈文案卡片", padding=8)
        paned.add(right_frame, weight=5)

        self.root.after(80, lambda: self._init_paned_sash(paned))

        # 卡片 Header
        preview_header = ttk.Frame(right_frame)
        preview_header.pack(fill="x", pady=(0, 6))

        self.preview_title_label = ttk.Label(
            preview_header,
            text="当前未选中学生",
            font=("Microsoft YaHei", 12, "bold"),
        )
        self.preview_title_label.pack(side="left")

        self.preview_status_badge = ttk.Label(
            preview_header,
            text="",
            font=("Microsoft YaHei", 9),
        )
        self.preview_status_badge.pack(side="left", padx=(8, 0))

        self.copy_btn = ttk.Button(
            preview_header,
            text="📋 复制文案",
            command=self.copy_current_preview,
            width=10,
        )
        self.copy_btn.pack(side="right")

        self.preview_len_label = ttk.Label(
            preview_header,
            text="",
            font=("Microsoft YaHei", 9),
        )
        self.preview_len_label.pack(side="right", padx=(0, 8))

        # 反馈正文 Text 区域
        preview_box_frame = ttk.Frame(right_frame)
        preview_box_frame.pack(fill="both", expand=True)

        self.preview_text = tk.Text(
            preview_box_frame,
            font=("Consolas", 10),
            wrap="word",
            padx=8,
            pady=8,
            relief="solid",
            borderwidth=1,
        )
        preview_scroll = ttk.Scrollbar(preview_box_frame, orient="vertical", command=self.preview_text.yview)
        self.preview_text.configure(yscrollcommand=preview_scroll.set)

        self.preview_text.pack(side="left", fill="both", expand=True)
        preview_scroll.pack(side="right", fill="y")
        self.preview_text.insert("1.0", "（点击左侧列表中的学生，此处将实时展示该学生的完整反馈评语与错题本落地页专属链接）")
        self.preview_text.config(state="disabled")

        # 错题本落地页独立卡片 (检测到链接时自动展开)
        self.retest_panel = ttk.Frame(right_frame, padding=(6, 6))
        
        retest_top = ttk.Frame(self.retest_panel)
        retest_top.pack(fill="x")
        ttk.Label(retest_top, text="🔗 专属错题本落地页链接:", font=("Microsoft YaHei", 9, "bold")).pack(side="left")

        retest_btn_box = ttk.Frame(retest_top)
        retest_btn_box.pack(side="right")

        self.copy_retest_url_btn = ttk.Button(
            retest_btn_box,
            text="复制链接",
            command=self.copy_retest_url,
            width=8,
        )
        self.copy_retest_url_btn.pack(side="left", padx=2)

        self.open_retest_url_btn = ttk.Button(
            retest_btn_box,
            text="浏览器打开",
            command=self.open_retest_url,
            width=10,
        )
        self.open_retest_url_btn.pack(side="left", padx=2)

        self.retest_url_label = ttk.Label(
            self.retest_panel,
            text="",
            font=("Consolas", 9),
            foreground="#0066CC",
        )
        self.retest_url_label.pack(anchor="w", pady=(2, 0))

    def _init_paned_sash(self, paned):
        """居中自适应初始分栏拉杆"""
        try:
            self.root.update_idletasks()
            w = paned.winfo_width()
            if w > 500:
                paned.sashpos(0, int(w * 0.56))
            else:
                paned.sashpos(0, 560)
        except Exception:
            pass

    # ================= 底部命令栏 =================

    def _create_control_panel(self, parent):
        """底部进度与动作控制栏 (底停靠)"""
        control_frame = ttk.Frame(parent)
        control_frame.pack(side="bottom", fill="x", pady=(6, 0))

        prog_row = ttk.Frame(control_frame)
        prog_row.pack(fill="x", pady=(0, 6))

        self.progress = ttk.Progressbar(prog_row, mode="determinate")
        self.progress.pack(side="left", fill="x", expand=True, padx=(0, 10))

        self.progress_percent_label = ttk.Label(
            prog_row, text="0 / 0 (0%)", font=("Microsoft YaHei", 9), width=12, anchor="e"
        )
        self.progress_percent_label.pack(side="right")

        self.status_label = ttk.Label(
            control_frame,
            text="等待加载数据...",
            font=("Microsoft YaHei", 10, "bold"),
            anchor="center",
        )
        self.status_label.pack(pady=(0, 8))

        btn_frame = ttk.Frame(control_frame)
        btn_frame.pack()

        self.start_btn = ttk.Button(
            btn_frame,
            text="▶ 开始发送",
            command=self.start_sending,
            style="Accent.TButton",
            state="disabled",
            width=18,
        )
        self.start_btn.pack(side="left", padx=8)

        self.stop_btn = ttk.Button(
            btn_frame,
            text="⏹ 停止发送",
            command=self.stop_sending,
            state="disabled",
            width=14,
        )
        self.stop_btn.pack(side="left", padx=8)

        self.retry_failed_btn = ttk.Button(
            btn_frame,
            text="🔄 仅重试失败/拦截项",
            command=self.retry_failed,
            state="disabled",
            width=18,
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

    # ================= 页面 2：内置历史档案中心 =================

    def _create_history_page(self, parent):
        """内置历史记录与周期管理中心视图"""
        page = ttk.Frame(parent)
        self.pages["history"] = page

        top_row = ttk.Frame(page)
        top_row.pack(side="top", fill="x", pady=(0, 10))

        ttk.Label(top_row, text="班级发送历史与存档记录", font=("Microsoft YaHei", 14, "bold")).pack(side="left")
        ttk.Label(top_row, text="（按班级与周次独立归档，可一键将已存档班级直接载入工作台）", font=("Microsoft YaHei", 9)).pack(side="left", padx=(10, 0), pady=(4, 0))

        hist_paned = ttk.PanedWindow(page, orient=tk.HORIZONTAL)
        hist_paned.pack(side="top", fill="both", expand=True)

        # 左栏：班级与归档周次列表
        left_box = ttk.LabelFrame(hist_paned, text="📚 班级 / 发送周次", padding=8)
        hist_paned.add(left_box, weight=4)

        cycle_row = ttk.Frame(left_box)
        cycle_row.pack(fill="x", pady=(0, 4))
        ttk.Label(cycle_row, text="📅 周次:", font=("Microsoft YaHei", 9, "bold")).pack(side="left")
        self.hist_cycle_combo = ttk.Combobox(
            cycle_row,
            textvariable=self.hist_filter_cycle_var,
            state="readonly",
            width=12,
        )
        self.hist_cycle_combo.pack(side="left", padx=(4, 0), fill="x", expand=True)
        self.hist_cycle_combo.bind("<<ComboboxSelected>>", lambda e: self._filter_history_classes())

        search_row = ttk.Frame(left_box)
        search_row.pack(fill="x", pady=(4, 6))
        ttk.Label(search_row, text="🔍 搜索:", font=("Microsoft YaHei", 9)).pack(side="left")
        self.hist_search_entry = ttk.Entry(search_row, textvariable=self.hist_search_class_var)
        self.hist_search_entry.pack(side="left", padx=(4, 0), fill="x", expand=True)
        self.hist_search_entry.bind("<KeyRelease>", lambda e: self._filter_history_classes())

        class_tree_frame = ttk.Frame(left_box)
        class_tree_frame.pack(fill="both", expand=True)

        self.hist_class_tree = ttk.Treeview(
            class_tree_frame,
            columns=("班级名称", "周次", "进度", "最近时间"),
            show="headings",
            selectmode="browse",
        )
        self.hist_class_tree.heading("班级名称", text="班级名称")
        self.hist_class_tree.heading("周次", text="周次")
        self.hist_class_tree.heading("进度", text="已发/总数")
        self.hist_class_tree.heading("最近时间", text="最近发送时间")

        self.hist_class_tree.column("班级名称", width=110, anchor="w")
        self.hist_class_tree.column("周次", width=65, anchor="center")
        self.hist_class_tree.column("进度", width=65, anchor="center")
        self.hist_class_tree.column("最近时间", width=110, anchor="center")

        hct_scroll = ttk.Scrollbar(class_tree_frame, orient="vertical", command=self.hist_class_tree.yview)
        self.hist_class_tree.configure(yscrollcommand=hct_scroll.set)
        self.hist_class_tree.pack(side="left", fill="both", expand=True)
        hct_scroll.pack(side="right", fill="y")
        self.hist_class_tree.bind("<<TreeviewSelect>>", self._on_history_class_select)

        class_btn_box = ttk.Frame(left_box)
        class_btn_box.pack(fill="x", pady=(6, 0))
        ttk.Button(class_btn_box, text="🗑️ 删除选中", command=self._delete_selected_history_class, width=10).pack(side="left")
        ttk.Button(class_btn_box, text="⚠️ 清空全部", command=self._clear_all_history_archives, width=10).pack(side="right")

        # 右栏：学员发送详情
        right_box = ttk.LabelFrame(hist_paned, text="👥 学员详细记录", padding=8)
        hist_paned.add(right_box, weight=6)

        hist_detail_header = ttk.Frame(right_box)
        hist_detail_header.pack(fill="x", pady=(0, 6))

        self.hist_class_title_label = ttk.Label(
            hist_detail_header,
            text="请在左侧选择班级档案",
            font=("Microsoft YaHei", 11, "bold"),
        )
        self.hist_class_title_label.pack(side="left")

        self.hist_class_stat_label = ttk.Label(
            hist_detail_header,
            text="",
            font=("Microsoft YaHei", 9),
        )
        self.hist_class_stat_label.pack(side="right")

        # 学员状态过滤胶囊
        s_filter_row = ttk.Frame(right_box)
        s_filter_row.pack(fill="x", pady=(0, 6))

        self.hist_student_filter_btns = {}
        for f_key, f_name in [("ALL", "全部"), ("SENT", "已发送"), ("UNSENT", "未发送"), ("FAILED", "失败/拦截")]:
            btn = ttk.Button(
                s_filter_row,
                text=f_name,
                command=lambda k=f_key: self._set_history_student_filter(k),
                width=8,
            )
            btn.pack(side="left", padx=2)
            self.hist_student_filter_btns[f_key] = btn

        # 学员明细表格
        stud_tree_frame = ttk.Frame(right_box)
        stud_tree_frame.pack(fill="both", expand=True)

        self.hist_student_tree = ttk.Treeview(
            stud_tree_frame,
            columns=("序号", "学员姓名/学号", "状态", "发送时间"),
            show="headings",
            selectmode="browse",
        )
        self.hist_student_tree.heading("序号", text="序号")
        self.hist_student_tree.heading("学员姓名/学号", text="学员姓名/学号")
        self.hist_student_tree.heading("状态", text="状态")
        self.hist_student_tree.heading("发送时间", text="发送时间")

        self.hist_student_tree.column("序号", width=50, anchor="center")
        self.hist_student_tree.column("学员姓名/学号", width=180, anchor="w")
        self.hist_student_tree.column("状态", width=110, anchor="center")
        self.hist_student_tree.column("发送时间", width=140, anchor="center")

        hst_scroll = ttk.Scrollbar(stud_tree_frame, orient="vertical", command=self.hist_student_tree.yview)
        self.hist_student_tree.configure(yscrollcommand=hst_scroll.set)
        self.hist_student_tree.pack(side="left", fill="both", expand=True)
        hst_scroll.pack(side="right", fill="y")

        # 右侧底部操作按钮
        hist_action_row = ttk.Frame(right_box)
        hist_action_row.pack(fill="x", pady=(8, 0))

        self.hist_reload_btn = ttk.Button(
            hist_action_row,
            text="🚀 载入到工作台直接发送",
            command=self._reload_history_to_workspace,
            style="Accent.TButton",
            width=22,
        )
        self.hist_reload_btn.pack(side="left")

        ttk.Button(
            hist_action_row,
            text="📋 复制未发名单",
            command=self._copy_history_unsent_names,
            width=14,
        ).pack(side="left", padx=6)

        ttk.Button(
            hist_action_row,
            text="📥 导出班级报表 (CSV)",
            command=self._export_history_class_csv,
            width=18,
        ).pack(side="right")

    # ================= 页面 3：实时运行日志 =================

    def _create_logs_page(self, parent):
        """内置日志与自检面板"""
        page = ttk.Frame(parent)
        self.pages["logs"] = page

        top_row = ttk.Frame(page)
        top_row.pack(side="top", fill="x", pady=(0, 10))

        ttk.Label(top_row, text="运行调试日志与现场诊断", font=("Microsoft YaHei", 14, "bold")).pack(side="left")

        btn_box = ttk.Frame(top_row)
        btn_box.pack(side="right")

        ttk.Button(btn_box, text="🔄 刷新日志", command=self._load_recent_logs, width=10).pack(side="left", padx=3)
        ttk.Button(btn_box, text="📂 打开日志文件", command=self.open_log_file, width=12).pack(side="left", padx=3)
        ttk.Button(btn_box, text="🖼️ 调试截图", command=self.open_debug_dir, width=10).pack(side="left", padx=3)
        ttk.Button(btn_box, text="☁️ 上报诊断", command=lambda: cloud_upload_async(include_history=False), width=10).pack(side="left", padx=3)

        log_frame = ttk.Frame(page)
        log_frame.pack(fill="both", expand=True)

        self.log_text = tk.Text(
            log_frame,
            font=("Consolas", 10),
            wrap="word",
            padx=10,
            pady=10,
            relief="solid",
            borderwidth=1,
        )
        log_scroll = ttk.Scrollbar(log_frame, orient="vertical", command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=log_scroll.set)

        self.log_text.pack(side="left", fill="both", expand=True)
        log_scroll.pack(side="right", fill="y")

        # 语法标签配色
        self.log_text.tag_config("INFO", foreground="#67C23A")
        self.log_text.tag_config("WARN", foreground="#E6A23C")
        self.log_text.tag_config("ERROR", foreground="#F56C6C")

    # ================= 页面 4：偏好设置中心 =================

    def _create_settings_page(self, parent):
        """现代 Fluent 卡片式设置中心"""
        page = ttk.Frame(parent)
        self.pages["settings"] = page

        top_row = ttk.Frame(page)
        top_row.pack(side="top", fill="x", pady=(0, 12))

        ttk.Label(top_row, text="偏好设置与运行参数", font=("Microsoft YaHei", 14, "bold")).pack(side="left")
        ttk.Label(top_row, text="（设置参数即时生效并持久化保存）", font=("Microsoft YaHei", 9)).pack(side="left", padx=(8, 0), pady=(4, 0))

        # 主滚动或卡片容器
        cards_box = ttk.Frame(page)
        cards_box.pack(fill="both", expand=True)

        # 卡片 1：单人发送间隔设置
        card1 = ttk.LabelFrame(cards_box, text="⏱️ 单人发送间隔控制", padding=12)
        card1.pack(fill="x", pady=(0, 10))

        r1 = ttk.Frame(card1)
        r1.pack(fill="x")
        ttk.Label(r1, text="最小休眠间隔:").pack(side="left")
        ttk.Entry(r1, textvariable=self.min_delay_var, width=6, justify="center").pack(side="left", padx=(4, 16))
        ttk.Label(r1, text="最大休眠间隔:").pack(side="left")
        ttk.Entry(r1, textvariable=self.max_delay_var, width=6, justify="center").pack(side="left", padx=(4, 8))
        ttk.Label(r1, text="秒（每人发送完毕后在两者之间随机浮动，模拟真人节奏）", font=("Microsoft YaHei", 9)).pack(side="left")

        # 卡片 2：批次防风控休眠设置
        card2 = ttk.LabelFrame(cards_box, text="🛡️ 批次防风控休眠策略", padding=12)
        card2.pack(fill="x", pady=(0, 10))

        r2 = ttk.Frame(card2)
        r2.pack(fill="x", pady=(0, 4))
        ttk.Checkbutton(r2, text="启用批次防风控休眠：每连续发送", variable=self.batch_rest_enable_var).pack(side="left")
        ttk.Entry(r2, textvariable=self.batch_size_var, width=4, justify="center").pack(side="left", padx=4)
        ttk.Label(r2, text="人，额外长休息").pack(side="left")
        ttk.Entry(r2, textvariable=self.batch_delay_var, width=5, justify="center").pack(side="left", padx=4)
        ttk.Label(r2, text="秒").pack(side="left")

        ttk.Label(
            card2,
            text="💡 说明：短时间内向大量不同联系人发送消息容易触发企业微信风控限制，设置批次长休息可有效防封禁。",
            font=("Microsoft YaHei", 9),
        ).pack(anchor="w")

        # 卡片 3：AI 视觉防误发引擎
        card3 = ttk.LabelFrame(cards_box, text="🤖 AI 视觉智能防误发双保险体系", padding=12)
        card3.pack(fill="x", pady=(0, 10))

        r3 = ttk.Frame(card3)
        r3.pack(fill="x", pady=(0, 6))

        ttk.Radiobutton(r3, text="模式 A: 通义千问 Qwen3.8-Flash 大模型 (首选推荐 / 语义抗干扰)", variable=self.smart_mode_var, value="A").pack(anchor="w", pady=2)
        ttk.Radiobutton(r3, text="模式 B: RapidOCR / WinOCR 本地离线引擎 (零网络开销 / 毫秒级推断)", variable=self.smart_mode_var, value="B").pack(anchor="w", pady=2)
        ttk.Radiobutton(r3, text="关闭视觉核验 (仅回车进入，不推荐)", variable=self.smart_mode_var, value="OFF").pack(anchor="w", pady=2)

        ttk.Checkbutton(card3, text="模式 A 受阻时毫秒级自动降级至本地 OCR 引擎 (双保险无缝守护)", variable=self.auto_fallback_var).pack(anchor="w", pady=(4, 0))

        # 卡片 4：运行环境与数据目录
        card4 = ttk.LabelFrame(cards_box, text="ℹ️ 运行环境与存储信息", padding=12)
        card4.pack(fill="x", pady=(0, 12))

        data_row = ttk.Frame(card4)
        data_row.pack(fill="x")
        ttk.Label(data_row, text=f"本地历史存储: {os.path.join(get_data_dir(), 'feedback_history.json')}", font=("Consolas", 9)).pack(side="left")
        ttk.Button(data_row, text="打开数据目录", command=lambda: os.startfile(get_data_dir()), width=12).pack(side="right")

        # 保存与重置操作栏
        settings_btn_row = ttk.Frame(page)
        settings_btn_row.pack(side="bottom", fill="x", pady=(8, 0))

        ttk.Button(
            settings_btn_row,
            text="💾 保存配置",
            command=self._save_settings,
            style="Accent.TButton",
            width=16,
        ).pack(side="right")

        ttk.Button(
            settings_btn_row,
            text="恢复默认值",
            command=self._reset_settings,
            width=12,
        ).pack(side="right", padx=8)

    def _save_settings(self):
        """保存配置并给予视觉轻提示"""
        try:
            mi = float(self.min_delay_var.get())
            ma = float(self.max_delay_var.get())
            if mi < 0 or ma < 0 or mi > ma:
                messagebox.showerror("参数错误", "单人发送间隔必须为非负数，且最小间隔不能大于最大间隔！")
                return
            bs = int(self.batch_size_var.get())
            bd = float(self.batch_delay_var.get())
            if bs < 1 or bd < 0:
                messagebox.showerror("参数错误", "批次人数需至少为1，休眠秒数需大于0！")
                return
        except Exception:
            messagebox.showerror("参数错误", "请输入有效的数字！")
            return

        self.flash_status("✓ 偏好设置已成功保存！", ms=2000)
        messagebox.showinfo("保存成功", "所有发送参数与策略已成功更新！")

    def _reset_settings(self):
        """恢复默认设置"""
        self.min_delay_var.set(DEFAULT_MIN_DELAY)
        self.max_delay_var.set(DEFAULT_MAX_DELAY)
        self.batch_rest_enable_var.set(True)
        self.batch_size_var.set(DEFAULT_BATCH_SIZE)
        self.batch_delay_var.set(DEFAULT_BATCH_DELAY)
        self.smart_mode_var.set("A")
        self.auto_fallback_var.set(True)
        self.flash_status("✓ 已恢复默认参数配置", ms=2000)

    # ================= 数据载入与工作台队列 =================

    def _on_cycle_changed(self, event=None):
        """用户切换或输入周次时联动刷新当前名单与档案"""
        val = self.cycle_var.get().strip()
        if not val:
            val = "第 1 周"
            self.cycle_var.set(val)
        if val != self.current_cycle:
            self.current_cycle = val
            log(f"当前发送周次已切换为: 【{self.current_cycle}】", "INFO")
            for f_info in self.loaded_files:
                f_path = f_info.get("path")
                if f_path:
                    try:
                        raw_data = load_feedback_data_from_file(f_path)
                        self.history_mgr.sync_file_loaded(f_path, raw_data, cycle=self.current_cycle)
                    except Exception:
                        pass
            self.load_preview()

    def _short_file_label(self, file_path):
        """生成带周次信息的简短班级标签"""
        clean_name = clean_class_name_from_path(file_path)
        cyc = self.current_cycle
        return f"{clean_name} [{cyc}]"

    def _load_one_file(self, file_path):
        """载入单个文件并追加到队列"""
        norm = os.path.abspath(file_path)
        if any(os.path.abspath(f["path"]) == norm for f in self.loaded_files):
            return 0

        base = os.path.basename(file_path)
        if any(os.path.basename(f["path"]) == base for f in self.loaded_files):
            raise ValueError(f"队列中已有同名文件「{base}」，不同目录的同名文件会共用发送记录导致串档。请先将其中一个重命名后再载入。")

        raw_data = load_feedback_data_from_file(file_path)
        if not isinstance(raw_data, list) or len(raw_data) == 0:
            raise ValueError("未能从该文件中提取到有效的学生反馈记录！")

        detected_cyc = detect_cycle_from_string(base)
        if detected_cyc:
            self.current_cycle = detected_cyc
            self.cycle_var.set(detected_cyc)

        self.history_mgr.sync_file_loaded(file_path, raw_data, cycle=self.current_cycle)
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
        })
        if not self.current_file_path:
            self.current_file_path = file_path
        return len(raw_data)

    def select_file(self, target_path: str = None):
        """选择单个反馈文件 (替换当前队列)"""
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
        """多选载入文件 (追加到当前队列)"""
        selected = filedialog.askopenfilenames(
            title="选择反馈数据文件 (可按住 Ctrl / Shift 多选)",
            filetypes=[
                ("反馈数据文件 (*.json, *.html, *.htm)", "*.json;*.html;*.htm"),
                ("HTML 网页快照 (*.html, *.htm)", "*.html;*.htm"),
                ("JSON 文件 (*.json)", "*.json"),
                ("所有文件 (*.*)", "*.*"),
            ],
        )
        if not selected:
            return
        self._append_files(selected)

    def _append_files(self, paths):
        """将选中的文件列表追加到队列"""
        added_files = 0
        added_students = 0
        failed_errors = []

        for p in paths:
            try:
                cnt = self._load_one_file(p)
                if cnt > 0:
                    added_files += 1
                    added_students += cnt
            except Exception as e:
                failed_errors.append(f"{os.path.basename(p)}: {e}")

        self.refresh_queue_ui()
        if failed_errors:
            messagebox.showwarning("部分文件载入失败", "\n".join(failed_errors[:5]))

    def remove_one_file(self, file_path):
        """从队列中移除单个文件"""
        norm = os.path.abspath(file_path)
        self.loaded_files = [f for f in self.loaded_files if os.path.abspath(f["path"]) != norm]
        self.data = [item for item in self.data if os.path.abspath(item.get("_src_file", "")) != norm]
        if self.loaded_files:
            self.current_file_path = self.loaded_files[0]["path"]
        else:
            self.current_file_path = ""
        self.refresh_queue_ui()

    def clear_all_files(self):
        """清空当前队列中的全部文件"""
        if not self.data and not self.loaded_files:
            return
        if self.is_running:
            messagebox.showwarning("警告", "当前正在发送中，无法清空队列！")
            return
        self.clear_queue_silent()
        self.refresh_queue_ui()

    def clear_queue_silent(self):
        """静默清空内存队列"""
        self.data.clear()
        self.loaded_files.clear()
        self.current_file_path = ""
        self.send_logs.clear()

    def refresh_queue_ui(self):
        """刷新已载入文件 Chips 与就绪状态"""
        for child in self.files_frame.winfo_children():
            try:
                child.destroy()
            except Exception:
                pass

        for f in self.loaded_files:
            chip = ttk.Frame(self.files_frame, padding=(6, 2))
            chip.pack(side="left", padx=(0, 6), pady=2)
            ttk.Label(chip, text=f"{f['label']}（{f['count']}条）", font=("Microsoft YaHei", 9)).pack(side="left")
            ttk.Button(chip, text="×", width=2, command=lambda p=f["path"]: self.remove_one_file(p)).pack(side="left", padx=(3, 0))

        total = len(self.data)
        if self.loaded_files:
            ext0 = os.path.splitext(self.loaded_files[0]["name"])[1].lower()
            type_badge = "HTML 快照" if ext0 in [".html", ".htm"] else "JSON"
            self.file_label = ttk.Label(
                self.files_frame,
                text=f" ✓ 已载入 {len(self.loaded_files)} 个文件 [{type_badge}] 共 {total} 条数据",
                font=("Microsoft YaHei", 9),
            )
            self.file_label.pack(side="left", padx=(8, 0))
        else:
            self.file_label = ttk.Label(
                self.files_frame,
                text="请先载入导出的 feedback.json 或 .html 网页快照文件（支持多文件追加）",
                font=("Microsoft YaHei", 9),
            )
            self.file_label.pack(side="left", pady=2)

        self.load_preview()

        has_data = total > 0
        self.start_btn.config(state="normal" if has_data else "disabled")
        self.retry_failed_btn.config(state="normal" if has_data else "disabled")
        self.export_btn.config(state="normal" if has_data else "disabled")

        if has_data:
            self.status_label.config(text=f"✓ 已就绪，共 {total} 条反馈数据。请核对名单后点击开始。")
        else:
            self.status_label.config(text="暂无数据，请先载入反馈文件。")

    # ================= 名单筛选、搜索与预览 =================

    def load_preview(self):
        """同步历史档案状态至内存数据队列并渲染视图"""
        for i, item in enumerate(self.data):
            student_name = item.get("studentName") or item.get("name") or "未知学生"
            src_file = item.get("_src_file") or self.current_file_path
            src_label = item.get("_src_label") or os.path.splitext(os.path.basename(src_file or ""))[0]
            hist_status = self.history_mgr.get_student_historical_status(src_file, student_name, cycle=self.current_cycle)

            if "✓" in hist_status or "已发送" in hist_status:
                item["_status"] = "✓ 已发送"
                item["_checked"] = "☐"
            elif hist_status and hist_status != "未发送":
                item["_status"] = hist_status
                item["_checked"] = "☑"
            else:
                item["_status"] = "待发送"
                item["_checked"] = "☑"

            item["_raw_index"] = i
            item["_src_label"] = src_label

        self.refresh_roster_view()

    def _on_search_changed(self, event=None):
        """即时响应搜索输入过滤"""
        self.refresh_roster_view()

    def _clear_search(self):
        """清空搜索框"""
        self.search_var.set("")
        self.refresh_roster_view()

    def set_filter(self, filter_type: str):
        """设置当前名单状态筛选模式并刷新"""
        self.current_filter = filter_type
        # 高亮当前选中的过滤按钮
        for k, btn in self.filter_buttons.items():
            if k == filter_type:
                btn.config(style="Accent.TButton")
            else:
                btn.config(style="TButton")
        self.refresh_roster_view()

    def refresh_roster_view(self):
        """根据搜索关键词与状态筛选重绘名单列表与统计卡片"""
        kw = self.search_var.get().strip().lower()
        f_type = self.current_filter

        # 清空 Treeview
        for item in self.tree.get_children():
            self.tree.delete(item)

        total_cnt = len(self.data)
        sent_cnt = 0
        unsent_cnt = 0
        failed_cnt = 0

        first_matching_iid = None

        for i, item in enumerate(self.data):
            st = item.get("_status", "待发送")
            chk = item.get("_checked", "☑")
            name = item.get("studentName") or item.get("name") or "未知学生"
            src = item.get("_src_label", "")

            # 统计计算
            if "✓" in st or "已发送" in st:
                sent_cnt += 1
            elif any(f in st for f in ["失败", "拦截", "无此联系人", "存疑", "不符"]):
                failed_cnt += 1
            else:
                unsent_cnt += 1

            # 筛选过滤判断
            match_search = True
            if kw:
                match_search = (kw in name.lower() or kw in str(item.get("studentId", "")).lower())

            match_filter = True
            if f_type == "UNSENT":
                match_filter = ("✓" not in st and "已发送" not in st and not any(f in st for f in ["失败", "拦截", "无此联系人"]))
            elif f_type == "SENT":
                match_filter = ("✓" in st or "已发送" in st)
            elif f_type == "FAILED":
                match_filter = any(f in st for f in ["失败", "拦截", "无此联系人", "存疑", "不符"])

            if match_search and match_filter:
                iid = str(i)
                self.tree.insert("", "end", iid=iid, values=(chk, i + 1, name, st, src))
                if first_matching_iid is None:
                    first_matching_iid = iid

        # 更新 4 块统计卡片数字
        if hasattr(self, "metric_total_num"):
            self.metric_total_num.config(text=str(total_cnt))
        if hasattr(self, "metric_unsent_num"):
            self.metric_unsent_num.config(text=str(unsent_cnt))
        if hasattr(self, "metric_sent_num"):
            self.metric_sent_num.config(text=str(sent_cnt))
        if hasattr(self, "metric_failed_num"):
            self.metric_failed_num.config(text=str(failed_cnt))

        # 更新进度条
        self.progress["maximum"] = total_cnt
        self.progress["value"] = sent_cnt
        self._update_progress_label(sent_cnt, total_cnt)
        self._refresh_start_button_text()

        # 选中并预览首个匹配项
        if first_matching_iid is not None:
            self.tree.selection_set(first_matching_iid)
            self.show_preview_at(int(first_matching_iid))

    def _update_progress_label(self, current, total):
        pct = int((current / total * 100)) if total > 0 else 0
        self.progress_percent_label.config(text=f"{current} / {total} ({pct}%)")

    def on_tree_select(self, event):
        """单击表格行在右侧卡片实时预览"""
        selected = self.tree.selection()
        if not selected:
            return
        idx = int(selected[0])
        self.show_preview_at(idx)

    def show_preview_at(self, idx):
        """展示指定索引学生的完整反馈文案与错题本落地页解析"""
        if 0 <= idx < len(self.data):
            self.current_preview_idx = idx
            item = self.data[idx]
            name = item.get("studentName") or item.get("name") or "未知学生"
            msg = item.get("message") or item.get("feedbackText") or ""
            status = item.get("_status", "待发送")

            self.preview_title_label.config(text=f"{name}")
            self.preview_status_badge.config(text=f"[{status}]")
            self.preview_len_label.config(text=f"共 {len(msg)} 字")

            self.preview_text.config(state="normal")
            self.preview_text.delete("1.0", "end")
            self.preview_text.insert("1.0", msg or "（无文案内容）")
            self.preview_text.config(state="disabled")

            # 智能提取错题本落地页专属链接
            url_match = re.search(r"https?://[^\s\u4e00-\u9fa5]+", msg)
            if url_match:
                clean_url = url_match.group(0).rstrip("，。！？；）)」】>")
                self.current_preview_url = clean_url
                self.retest_url_label.config(text=clean_url)
                self.retest_panel.pack(fill="x", pady=(6, 0))
            else:
                self.current_preview_url = ""
                self.retest_panel.pack_forget()

    def on_tree_click(self, event):
        """点击第一列切换勾选状态"""
        if self.is_running:
            return
        region = self.tree.identify("region", event.x, event.y)
        if region == "cell":
            column = self.tree.identify_column(event.x)
            if column == "#1":
                item_iid = self.tree.identify_row(event.y)
                if item_iid:
                    idx = int(item_iid)
                    item_data = self.data[idx]
                    if item_data.get("_checked") == "☑":
                        item_data["_checked"] = "☐"
                        if item_data.get("_status") == "待发送":
                            item_data["_status"] = "已跳过"
                    else:
                        item_data["_checked"] = "☑"
                        if item_data.get("_status") == "已跳过":
                            item_data["_status"] = "待发送"

                    self.tree.item(item_iid, values=(
                        item_data["_checked"],
                        idx + 1,
                        item_data.get("studentName") or item_data.get("name"),
                        item_data["_status"],
                        item_data.get("_src_label", ""),
                    ))
                    self._refresh_start_button_text()

    def show_context_menu(self, event):
        """右键快捷上下文菜单"""
        iid = self.tree.identify_row(event.y)
        if iid:
            self.tree.selection_set(iid)
            self.show_preview_at(int(iid))
        self.context_menu.post(event.x_root, event.y_root)

    def set_all_checks(self, checked=True):
        """一键全选或取消勾选"""
        if self.is_running:
            return
        sym = "☑" if checked else "☐"
        for item in self.data:
            item["_checked"] = sym
            if not checked and item.get("_status") == "待发送":
                item["_status"] = "已跳过"
            elif checked and item.get("_status") == "已跳过":
                item["_status"] = "待发送"
        self.refresh_roster_view()

    def check_only_unsent(self):
        """仅勾选未发送项"""
        if self.is_running:
            return
        for item in self.data:
            st = item.get("_status", "")
            if "✓" not in st and "已发送" not in st:
                item["_checked"] = "☑"
                if item.get("_status") == "已跳过":
                    item["_status"] = "待发送"
            else:
                item["_checked"] = "☐"
        self.refresh_roster_view()

    def check_only_failed(self):
        """仅勾选失败或拦截项"""
        if self.is_running:
            return
        for item in self.data:
            st = item.get("_status", "")
            if any(f in st for f in ["失败", "拦截", "无此联系人", "存疑", "不符"]):
                item["_checked"] = "☑"
            else:
                item["_checked"] = "☐"
        self.refresh_roster_view()

    def reset_all_status(self):
        """一键将所有人重置为待发送"""
        if self.is_running:
            return
        if not messagebox.askyesno("重置状态", "确定要将当前名单所有学员状态重置为【待发送】吗？"):
            return
        for item in self.data:
            item["_status"] = "待发送"
            item["_checked"] = "☑"
            src = item.get("_src_file", self.current_file_path)
            s_name = item.get("studentName") or item.get("name")
            if src and s_name:
                self.history_mgr.update_student_status(src, s_name, "待发送", cycle=self.current_cycle)
        self.refresh_roster_view()
        self.flash_status("✓ 所有名单已重置为待发送", ms=2000)

    def _refresh_start_button_text(self):
        """根据待发人数智能刷新开始按钮文字"""
        checked_unsent = sum(1 for item in self.data if item.get("_checked") == "☑" and "✓" not in item.get("_status", ""))
        if checked_unsent > 0:
            self.start_btn.config(text=f"▶ 开始发送 ({checked_unsent}人)")
        else:
            self.start_btn.config(text="▶ 开始发送")

    def copy_selected_student_name(self):
        """复制选中学员的标识/姓名"""
        if self.current_preview_idx < 0 or self.current_preview_idx >= len(self.data):
            return
        name = self.data[self.current_preview_idx].get("studentName") or self.data[self.current_preview_idx].get("name") or ""
        if safe_copy(name):
            self.flash_status(f"✓ 已复制学员: {name}", ms=1800)
            orig = self.copy_student_btn.cget("text")
            self.copy_student_btn.config(text="✓ 已复制")
            self.root.after(1500, lambda: self.copy_student_btn.config(text=orig))

    def copy_current_preview(self):
        """复制右侧反馈文案到剪贴板"""
        txt = self.preview_text.get("1.0", "end-1c").strip()
        if not txt or txt.startswith("（点击左侧列表中的学生"):
            return
        if safe_copy(txt):
            orig = self.copy_btn.cget("text")
            self.copy_btn.config(text="✓ 已复制")
            self.root.after(1500, lambda: self.copy_btn.config(text=orig))
            self.flash_status("✓ 已复制反馈文案至剪贴板", ms=1800)

    def copy_retest_url(self):
        """一键复制错题本落地页专属链接"""
        if self.current_preview_url:
            if safe_copy(self.current_preview_url):
                orig = self.copy_retest_url_btn.cget("text")
                self.copy_retest_url_btn.config(text="✓ 已复制")
                self.root.after(1500, lambda: self.copy_retest_url_btn.config(text=orig))
                self.flash_status("✓ 错题本专属链接已复制", ms=1800)

    def open_retest_url(self):
        """在系统默认浏览器中打开错题本落地页"""
        if self.current_preview_url:
            try:
                webbrowser.open(self.current_preview_url)
            except Exception as e:
                messagebox.showerror("打开失败", f"无法打开浏览器：\n{e}")

    def flash_status(self, msg, color="", ms=2500):
        """状态栏轻量临时提示"""
        prev = self.status_label.cget("text")
        self.status_label.config(text=msg)
        def _restore():
            try:
                if self.status_label.cget("text") == msg:
                    self.status_label.config(text=prev)
            except Exception:
                pass
        self.root.after(ms, _restore)

    def update_status(self, index, status):
        """更新指定学生的发送状态"""
        if 0 <= index < len(self.data):
            self.data[index]["_status"] = status
            iid = str(index)
            if self.tree.exists(iid):
                vals = list(self.tree.item(iid, "values"))
                vals[3] = status
                self.tree.item(iid, values=vals)
            if self.current_preview_idx == index:
                self.preview_status_badge.config(text=f"[{status}]")

    def reorder_roster_after_completion(self):
        """全部发送完成后自动将发送成功的行勾选去掉，未完成的保留"""
        for item in self.data:
            if "✓" in item.get("_status", ""):
                item["_checked"] = "☐"
        self.refresh_roster_view()

    # ================= 自动化发送工作线程 =================

    def start_sending(self):
        """开始自动化发送"""
        if self.is_running:
            return
        if hasattr(self, "_sending_thread") and self._sending_thread and self._sending_thread.is_alive():
            return
        if not self.data:
            messagebox.showwarning("警告", "请先选择反馈数据文件 (JSON / HTML)")
            return

        to_send_indices = [i for i, item in enumerate(self.data) if item.get("_checked") == "☑" and "✓" not in item.get("_status", "")]
        if not to_send_indices:
            messagebox.showinfo("提示", "当前没有勾选任何【未发送】或【待重试】的记录。")
            return

        wecom_found = find_and_activate_wecom()
        file_count = len(self.loaded_files)
        tip_msg = f"即将发送 {len(to_send_indices)} 条反馈消息"
        tip_msg += f"（来自 {file_count} 个文件）。\n\n" if file_count > 1 else "。\n\n"
        if wecom_found:
            tip_msg += "✓ 已自动检测并激活企业微信主窗口。\n"
        else:
            tip_msg += "⚠️ 未自动探测到企业微信，请确保企业微信已在电脑上登录并打开！\n"

        tip_msg += f"✓ 发送周次 / 周期：【{self.current_cycle}】（记录将独立归档至该周次）\n"
        tip_msg += "✓ 【AI 智能防误发双保险】全自动守护中：已开启下拉智能纠偏与会话标题二次核验双重防线。\n"
        tip_msg += "\n【安全提示】\n1. 开始后 3 秒请勿触碰键盘与鼠标！\n2. 随时可按键盘左上角 【ESC】 键紧急停止。"

        if not messagebox.askokcancel("确认启动", tip_msg):
            return

        self.is_running = True
        self.start_btn.config(state="disabled")
        self.stop_btn.config(state="normal")
        self.retry_failed_btn.config(state="disabled")

        self.show_floating_window("⚠️ 自动发送即将启动，请勿动鼠标键盘！按 ESC 停止")
        self.status_label.config(text="⏳ 3 秒后开始发送，请将目光移至企业微信...")
        self.root.update()
        time.sleep(3)

        def _thread_wrapper():
            try:
                self._run_sending_thread(to_send_indices)
            finally:
                self.is_running = False
                self.root.after(0, self.hide_floating_window)
                self.root.after(0, lambda: self.start_btn.config(state="normal"))
                self.root.after(0, lambda: self.stop_btn.config(state="disabled"))
                self.root.after(0, self._refresh_start_button_text)

        self._sending_thread = Thread(target=_thread_wrapper, daemon=True)
        self._sending_thread.start()

    def retry_failed(self):
        """一键仅重试失败或被拦截的学员"""
        self.check_only_failed()
        self.start_sending()

    def stop_sending(self):
        """紧急停止发送"""
        self.is_running = False
        self.status_label.config(text="⏹ 正在停止发送，请稍候...")
        self.start_btn.config(state="disabled")
        self.stop_btn.config(state="disabled")
        self.hide_floating_window()

    def _run_sending_thread(self, to_send_indices):
        """后台发送主循环线程"""
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
        log(f"=== 批量发送任务启动 === 待发学生数: {len(to_send_indices)}, 延时范围: [{min_delay}, {max_delay}]秒, 批次防风控: 每{batch_size}人休息{batch_delay}秒", "INFO")

        for current_loop_idx, i in enumerate(to_send_indices):
            if not self.is_running:
                interrupted = True
                break

            # 前台失焦守护检测
            if HAS_WIN32 and not is_foreground_wecom():
                log("检测到前台脱离企业微信，尝试唤回企微前台...", "WARN")
                find_and_activate_wecom()
                time.sleep(0.3)
                if not is_foreground_wecom():
                    log("无法唤回企微前台，触发安全暂停", "WARN")
                    self.root.after(
                        0,
                        lambda: self.status_label.config(text="⚠️ 防失焦拦截：检测到离开企业微信！已自动安全暂停，请切回后继续。"),
                    )
                    self.root.after(
                        0,
                        lambda: messagebox.showwarning(
                            "安全暂停",
                            "检测到前台窗口已离开企业微信（可能弹出了其他软件或通知）！\n为防止消息误发到其他应用，自动化已自动安全暂停。\n\n请切回企业微信主窗口后，点击【继续发送未完成项】即可继续。",
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
                    self.status_label.config(text=f"📤 正在发送 [{cur}/{tot}]: {name}" + (f"（{src}）" if src else "")),
                    self.update_status(idx, "发送中..."),
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
                not_found_count += 1
                self.root.after(0, lambda idx=i: self.update_status(idx, "⚠️ 无此联系人"))
                self.history_mgr.update_student_status(item.get("_src_file") or self.current_file_path, student_name, "⚠️ 无此联系人", now_str, cycle=self.current_cycle)
                self.send_logs.append(
                    {"index": i + 1, "name": student_name, "status": "无此联系人", "time": now_str, "msg_len": len(message), "file": item.get("_src_label", "")}
                )
            elif send_result == "DESC_ONLY":
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

            # 更新进度条与卡片统计
            completed_count = sum(1 for item in self.data if "✓" in item.get("_status", ""))
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
                    ),
                )
                if not self.safe_sleep(batch_delay):
                    interrupted = True
                    break

            # 单条间随机抖动延时
            delay = random.uniform(min_delay, max_delay)
            self.root.after(
                0,
                lambda d=delay, n=student_name: self.status_label.config(
                    text=f"⏳ [{n}] 发送完毕，随机休息 {d:.1f} 秒模拟人工...",
                ),
            )
            if not self.safe_sleep(delay):
                interrupted = True
                break

        # 结算提示
        total_intercepted = desc_only_count + header_mismatch_count
        summary = (
            f"发送任务结束！\n"
            f"✓ 成功: {success_count} 人\n"
            f"⚠️ 智能拦截防误发: {total_intercepted} 人 (他人描述: {desc_only_count}, 标题不符: {header_mismatch_count})\n"
            f"⚠️ 无此联系人: {not_found_count} 人\n"
            f"✗ 失败: {fail_count} 人"
        )
        if interrupted:
            summary += "\n\n（任务已被提前手动停止）"

        self.root.after(0, self.reorder_roster_after_completion)
        self.root.after(0, lambda: self.status_label.config(text=f"✓ 发送结束：成功 {success_count} 人，失败 {fail_count} 人，拦截防误发 {total_intercepted} 人"))
        self.root.after(0, lambda: messagebox.showinfo("发送结果", summary))

    def safe_sleep(self, duration: float) -> bool:
        """带中断感知的微粒度睡眠"""
        start = time.time()
        while time.time() - start < duration:
            if not self.is_running:
                return False
            time.sleep(0.05)
        return True

    def send_single_feedback(self, search_name: str, message: str) -> str:
        """发送单条反馈 (核心 AI 视觉智能防误发双保险)"""
        log(f">>> 开始发送单条: '{search_name}', 文案字数={len(message)}", "INFO")
        if not self.safe_sleep(0.1):
            log(f"[{search_name}] 中断退出", "WARN")
            return "ABORTED"

        # 1. 激活搜索框
        pyautogui.hotkey("ctrl", "f")
        if not self.safe_sleep(CLICK_DELAY):
            return "ABORTED"

        # 2. 全选并清空搜索框
        pyautogui.hotkey("ctrl", "a")
        time.sleep(0.04)
        pyautogui.press("backspace")
        if not self.safe_sleep(0.05):
            return "ABORTED"

        # 3. 粘贴学号/姓名
        if not safe_copy(search_name):
            log(f"[{search_name}] 学号/姓名写入剪贴板失败", "ERROR")
            return "FAILED"
        pyautogui.hotkey("ctrl", "v")
        if not self.safe_sleep(SEARCH_DELAY):
            return "ABORTED"

        # 4. 【第一道防线：下拉候选框智能纠偏】
        choice = -1
        matched_title = ""
        target_id, target_name = parse_student_identifier(search_name)
        wecom_rect = get_wecom_rect()
        smart_mode = self.smart_mode_var.get()
        auto_fallback = self.auto_fallback_var.get()

        if smart_mode != "OFF" and HAS_SMART_CHECK:
            if wecom_rect:
                choice, matched_title = detect_dropdown_target(
                    wecom_rect, target_id, target_name, mode=smart_mode, auto_fallback=auto_fallback
                )

                if choice == 0:
                    log(f"[{search_name}] 通讯录中无此联系人(或全局搜索)，安全跳过", "WARN")
                    self.root.after(0, lambda n=search_name: self.status_label.config(text=f"⚠️ 自动跳过 [{n}]：企微通讯录中无此联系人"))
                    dismiss_and_clear_search()
                    return "NOT_FOUND"

                elif choice == -2:
                    log(f"[{search_name}] 仅他人描述命中，无本人备注，安全拦截", "WARN")
                    self.root.after(0, lambda n=search_name: self.status_label.config(text=f"⚠️ 智能拦截 [{n}]：搜索结果仅为他人描述，已拦截防误发"))
                    dismiss_and_clear_search()
                    return "DESC_ONLY"

                elif choice >= 2:
                    log(f"[{search_name}] 智能纠偏：前项为他人描述，已自动按向下键纠正至第{choice}项 ({matched_title})", "INFO")
                    self.root.after(0, lambda n=search_name, t=matched_title, c=choice: self.status_label.config(text=f"🎯 智能纠偏 [{n}]：已自动纠偏至第{c}项 ({t})"))
                    for _ in range(choice - 1):
                        pyautogui.press("down")
                        time.sleep(0.12)
                    time.sleep(0.15)
                    pyautogui.press("enter")
                    time.sleep(0.2)
                    pyautogui.press("enter")
                elif choice == 1:
                    log(f"[{search_name}] 下拉初选第1项即为本人 ({matched_title})，回车进入会话", "INFO")
                    pyautogui.press("enter")
                    time.sleep(0.2)
                    pyautogui.press("enter")
                else:
                    log(f"[{search_name}] 下拉识别未明确，试探性进入第1项等待会话标题检查点裁决...", "WARN")
                    pyautogui.press("enter")
                    time.sleep(0.2)
                    pyautogui.press("enter")
            else:
                log(f"[{search_name}] 未能获取企微窗口坐标，试探性回车并等待核验", "WARN")
                pyautogui.press("enter")
                time.sleep(0.2)
                pyautogui.press("enter")
        else:
            log(f"[{search_name}] 未开启视觉智能核验，走传统回车进入第1项", "INFO")
            pyautogui.press("enter")
            time.sleep(0.2)
            pyautogui.press("enter")

        if not self.safe_sleep(CLICK_DELAY):
            return "ABORTED"

        # 5. 【第二道防线：会话标题安全检查点】
        if smart_mode != "OFF" and wecom_rect:
            header_status, header_title = verify_chat_header_title(
                wecom_rect, target_id, target_name, timeout=1.2, mode=smart_mode, auto_fallback=auto_fallback
            )

            if header_status == "MISMATCH":
                log(f"[{search_name}] ⛔ 会话标题安全检查点拦截！当前处于【{header_title}】，与目标学生不符，立即清空退出！", "ERROR")
                self.root.after(0, lambda n=search_name, t=header_title: self.status_label.config(text=f"⛔ 标题不符已拦截 [{n}]：当前为【{t}】，已立即退出！"))
                dismiss_and_clear_search()
                return "HEADER_MISMATCH"

            elif header_status == "UNCERTAIN":
                log(f"[{search_name}] ⛔ 安全拦截：会话标题无法确切核准（存疑），触发安全拦截防盲发！", "ERROR")
                self.root.after(0, lambda n=search_name: self.status_label.config(text=f"⛔ 身份存疑已拦截 [{n}]：无法核准会话身份，已拦截！"))
                dismiss_and_clear_search()
                return "UNCERTAIN_INTERCEPT"

            elif header_status == "MATCH":
                log(f"[{search_name}] ✓ 会话标题安全检查点完全通过: '{header_title}'", "INFO")

        # 6. 安全粘贴反馈文案
        if not safe_copy(message):
            log(f"[{search_name}] 反馈文案写入系统剪贴板失败", "ERROR")
            return "FAILED"
        pyautogui.hotkey("ctrl", "v")
        if not self.safe_sleep(TYPE_DELAY):
            pyautogui.hotkey("ctrl", "a")
            time.sleep(0.05)
            pyautogui.press("backspace")
            return "ABORTED"

        # 7. 回车发送
        pyautogui.press("enter")
        if not self.safe_sleep(SEND_DELAY):
            return "ABORTED"

        log(f"[{search_name}] 单条反馈发送成功 ✓", "INFO")
        return "SUCCESS"

    # ================= 历史中心交互实现 =================

    def _load_history_classes(self, select_key=None):
        """刷新历史档案班级列表与周次筛选器"""
        cycles = self.history_mgr.get_cycles_list()
        combo_vals = ["全部周次"] + cycles
        self.hist_cycle_combo["values"] = combo_vals
        if self.hist_filter_cycle_var.get() not in combo_vals:
            self.hist_filter_cycle_var.set("全部周次")

        self._filter_history_classes(select_key=select_key)

    def _filter_history_classes(self, select_key=None):
        """按周次和搜索关键词过滤班级列表"""
        for item in self.hist_class_tree.get_children():
            self.hist_class_tree.delete(item)

        filter_c = self.hist_filter_cycle_var.get().strip()
        search_kw = self.hist_search_class_var.get().strip().lower()

        classes = self.history_mgr.get_classes_list()
        matched_keys = []

        for c_info in classes:
            key = c_info.get("key", "")
            c_name = c_info.get("class_name", "") or c_info.get("file_name", "未知班级")
            c_cycle = c_info.get("cycle", "第 1 周")
            last_t = c_info.get("last_update_time", "") or c_info.get("created_time", "")
            stats = c_info.get("stats", {})
            sent = stats.get("sent", 0)
            total = stats.get("total", 0)
            prog_str = f"{sent}/{total}"

            if filter_c != "全部周次" and c_cycle != filter_c:
                continue
            if search_kw and (search_kw not in c_name.lower() and search_kw not in c_cycle.lower()):
                continue

            self.hist_class_tree.insert("", "end", iid=key, values=(c_name, c_cycle, prog_str, last_t))
            matched_keys.append(key)

        target_key = select_key if (select_key and select_key in matched_keys) else (matched_keys[0] if matched_keys else None)
        if target_key:
            self.hist_class_tree.selection_set(target_key)
            self._render_history_students(target_key)
        else:
            self.hist_selected_class_key = None
            self.hist_class_title_label.config(text="暂未选择班级")
            self.hist_class_stat_label.config(text="")
            for item in self.hist_student_tree.get_children():
                self.hist_student_tree.delete(item)

    def _on_history_class_select(self, event):
        """选中左侧班级档案"""
        selected = self.hist_class_tree.selection()
        if not selected:
            return
        key = selected[0]
        self._render_history_students(key)

    def _render_history_students(self, key):
        """渲染右侧学员档案明细"""
        self.hist_selected_class_key = key
        detail = self.history_mgr.get_class_details(key)
        if not detail:
            return

        c_name = detail.get("class_name", "") or detail.get("file_name", key)
        c_cycle = detail.get("cycle", "第 1 周")
        students = detail.get("students", [])
        stats = detail.get("stats", {})
        total_cnt = stats.get("total", len(students))
        sent_cnt = stats.get("sent", 0)
        unsent_cnt = stats.get("unsent", 0)
        failed_cnt = stats.get("failed", 0)

        self.hist_class_title_label.config(text=f"📚 【{c_name}】 {c_cycle}")
        self.hist_class_stat_label.config(text=f"总计 {total_cnt} 人 | 已发 {sent_cnt} | 未发 {unsent_cnt} | 异常 {failed_cnt}")

        for item in self.hist_student_tree.get_children():
            self.hist_student_tree.delete(item)

        for s in students:
            s_name = s.get("name", "")
            st = s.get("status", "未发送")
            st_time = s.get("time", "-")
            idx = s.get("index", 1)

            is_sent = ("已发送" in st or "✓" in st)
            is_unsent = ("未发送" in st or "待发送" in st or "已跳过" in st)
            is_failed = not is_sent and not is_unsent

            f = self.hist_current_filter
            if f == "SENT" and not is_sent:
                continue
            elif f == "UNSENT" and not is_unsent:
                continue
            elif f == "FAILED" and not is_failed:
                continue

            self.hist_student_tree.insert("", "end", values=(idx, s_name, st, st_time))

    def _set_history_student_filter(self, filter_key):
        """历史档案学员状态过滤"""
        self.hist_current_filter = filter_key
        for k, btn in self.hist_student_filter_btns.items():
            if k == filter_key:
                btn.config(style="Accent.TButton")
            else:
                btn.config(style="TButton")
        if self.hist_selected_class_key:
            self._render_history_students(self.hist_selected_class_key)

    def _reload_history_to_workspace(self):
        """将选中的历史班级一键载入工作台直接发送"""
        if not self.hist_selected_class_key:
            messagebox.showinfo("提示", "请先在左侧选择一个班级档案。")
            return
        detail = self.history_mgr.get_class_details(self.hist_selected_class_key)
        if not detail:
            return

        f_path = detail.get("file_path", "")
        c_cycle = detail.get("cycle", "第 1 周")
        if not f_path or not os.path.exists(f_path):
            messagebox.showwarning("文件不存在", f"该班级的原始文件已被移动或删除：\n{f_path}")
            return

        self.reload_from_history(f_path, cycle=c_cycle)
        self.switch_page("workspace")
        self.flash_status(f"✓ 已将【{detail.get('class_name', '')}】载入工作台！", ms=2500)

    def _copy_history_unsent_names(self):
        """复制未发送学生姓名"""
        if not self.hist_selected_class_key:
            return
        detail = self.history_mgr.get_class_details(self.hist_selected_class_key)
        if not detail:
            return
        students = detail.get("students", [])
        unsent_names = [s.get("name", "") for s in students if "✓" not in s.get("status", "") and "已发送" not in s.get("status", "")]
        if not unsent_names:
            messagebox.showinfo("提示", "该班级所有学生均已发送完成！")
            return
        copy_text = "\n".join(unsent_names)
        if safe_copy(copy_text):
            messagebox.showinfo("复制成功", f"已复制 {len(unsent_names)} 位未发送/失败学生名单至剪贴板！")

    def _export_history_class_csv(self):
        """导出当前班级历史记录为 CSV"""
        if not self.hist_selected_class_key:
            return
        detail = self.history_mgr.get_class_details(self.hist_selected_class_key)
        if not detail:
            return
        c_name = detail.get("class_name", "班级")
        c_cycle = detail.get("cycle", "第 1 周")
        save_path = filedialog.asksaveasfilename(
            title="导出班级发送记录",
            defaultextension=".csv",
            filetypes=[("CSV 表格", "*.csv")],
            initialfile=f"{c_name}_{c_cycle}_发送记录.csv",
        )
        if not save_path:
            return
        try:
            with open(save_path, "w", newline="", encoding="utf-8-sig") as f:
                writer = csv.writer(f)
                writer.writerow(["序号", "学生学号/姓名", "周次", "发送状态", "发送时间"])
                for s in detail.get("students", []):
                    writer.writerow([s.get("index", 1), s.get("name", ""), c_cycle, s.get("status", "未发送"), s.get("time", "-")])
            messagebox.showinfo("导出成功", f"班级发送记录已导出至：\n{save_path}")
        except Exception as e:
            messagebox.showerror("导出失败", f"保存 CSV 失败：\n{e}")


    def _delete_selected_history_class(self):
        """删除选中的班级档案"""
        if not self.hist_selected_class_key:
            return
        detail = self.history_mgr.get_class_details(self.hist_selected_class_key)
        c_name = detail.get("class_name", self.hist_selected_class_key) if detail else self.hist_selected_class_key
        if messagebox.askyesno("确认删除", f"确定要从历史记录中删除【{c_name}】的档案吗？\n\n（不会删除您电脑中的原始反馈文件）"):
            self.history_mgr.delete_class(self.hist_selected_class_key)
            self._load_history_classes()

    def _clear_all_history_archives(self):
        """清空所有历史档案"""
        if messagebox.askyesno("确认清空", "确定要清空所有班级的发送历史档案吗？\n\n（此操作不可恢复，但不会删除任何电脑中的原始文件）"):
            self.history_mgr.clear_all()
            self._load_history_classes()

    # ================= 日志读取与展示 =================

    def _load_recent_logs(self):
        """读取最近的日志文本并带语法色彩展示"""
        if not hasattr(self, "log_text"):
            return
        self.log_text.config(state="normal")
        self.log_text.delete("1.0", "end")

        lines = []
        if os.path.exists(LOG_FILE_PATH):
            try:
                with open(LOG_FILE_PATH, "r", encoding="utf-8", errors="ignore") as f:
                    all_lines = f.readlines()
                    lines = all_lines[-300:]  # 最近 300 行
            except Exception as e:
                lines = [f"读取日志文件失败: {e}\n"]

        if not lines and self.send_logs:
            lines = [f"[{l['time']}] 学生: {l['name']} -> {l['status']}\n" for l in self.send_logs]

        for line in lines:
            tag = None
            if "[INFO]" in line or "✓" in line:
                tag = "INFO"
            elif "[WARN]" in line or "⚠️" in line:
                tag = "WARN"
            elif "[ERROR]" in line or "⛔" in line or "✗" in line:
                tag = "ERROR"
            self.log_text.insert("end", line, tag)

        self.log_text.see("end")
        self.log_text.config(state="disabled")

    # ================= 报表导出、悬浮窗与系统入口 =================

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
                for log_item in self.send_logs:
                    writer.writerow([log_item["index"], log_item["name"], log_item.get("file", ""), log_item["status"], log_item["time"], log_item["msg_len"]])
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
        """直接无缝切换至内置历史档案中心"""
        self.switch_page("history")

    def reload_from_history(self, file_path: str, cycle: str = ""):
        """从历史档案重载班级文件到工作台"""
        self.select_file(target_path=file_path)
        if cycle:
            self.current_cycle = cycle
            self.cycle_var.set(cycle)
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
