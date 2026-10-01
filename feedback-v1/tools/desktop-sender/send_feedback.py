# -*- coding: utf-8 -*-
"""
企业微信自动发送反馈脚本 (模式 B 智能核验与纠错升级版)
功能：
1. 读取反馈 JSON 文件及网站导出的 HTML 网页快照文件，严格按学生信息逐个发送反馈
2. 模式 B 搜索智能核验：本地 OCR 秒级识别企微下拉框，若第 1 项为他人描述自动按【↓】选中第 2 项本人，若全是他人描述则安全拦截
3. 实时消息预览：点击名单任意学生即可在右侧查看完整反馈文案
4. 智能断点续发与重试：自动跳过已发送记录，支持一键重试失败与拦截项
5. 前台窗口守护与防失焦：自动寻找企微窗口，检测到焦点被抢夺立即自动暂停，防止误发
6. 剪贴板安全核验：防止剪贴板延迟导致发错上一个学生的内容
7. 批次防风控休息：支持每发送 N 人自动休眠，模拟真人节奏
8. 导出发送记录：一键导出 CSV 报表留档
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
    """安全退出搜索下拉浮层并清空搜索输入框，杜绝残留浮层或焦点干扰后续操作"""
    try:
        pyautogui.press("esc")
        time.sleep(0.05)
        pyautogui.hotkey("ctrl", "a")
        time.sleep(0.05)
        pyautogui.press("backspace")
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
                log(f"模式 A (大模型) 视觉识别异常 ({reason})，自动平滑降级为模式 B (本地 OCR)...", "WARN")
                return detect_dropdown_target_via_ocr(wecom_rect, target_id, target_name)
            return choice, reason
        else:
            if auto_fallback and HAS_OCR:
                log("截取下拉框区域失败，自动降级至模式 B (本地 OCR)...", "WARN")
                return detect_dropdown_target_via_ocr(wecom_rect, target_id, target_name)
            return -1, "截屏失败"

    elif mode == "B":
        if HAS_OCR:
            return detect_dropdown_target_via_ocr(wecom_rect, target_id, target_name)
        log("模式 B 视觉核验跳过: 未安装可用本地 OCR 引擎", "WARN")
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
                log(f"模式 A 标题核验异常/无法判定 ({detected_title})，自动平滑降级至模式 B 本地 OCR 轮询...", "WARN")
                return verify_chat_header_title_via_ocr(wecom_rect, target_id, target_name, timeout=timeout)
            return status, detected_title
        else:
            if auto_fallback and HAS_OCR:
                log("截取标题条失败，自动降级至模式 B 本地 OCR 轮询...", "WARN")
                return verify_chat_header_title_via_ocr(wecom_rect, target_id, target_name, timeout=timeout)
            return "UNCERTAIN", ""

    elif mode == "B":
        if HAS_OCR:
            return verify_chat_header_title_via_ocr(wecom_rect, target_id, target_name, timeout=timeout)
        log("模式 B 标题核验跳过: 未安装可用本地 OCR 引擎", "WARN")
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
        headers={"Content-Type": "application/json", "User-Agent": "JF-Feedback-Sender/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read().decode("utf-8", errors="replace"))
            raise RuntimeError(detail.get("error") or f"服务器返回 HTTP {e.code}")
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


def call_cloud_vision(task: str, crop_img: Image.Image, target_id: str, target_name: str, timeout: float = 4.5) -> dict:
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
    log(f"[大模型选人决策] choice={choice}, title='{matched_title}', reason='{reason}'", "INFO")
    return choice, f"{reason} [模式A·大模型]"


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
        return "MATCH", f"{detected_title} [模式A·大模型]"
    else:
        return "MISMATCH", f"{detected_title} [模式A·大模型]"


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
                                      {"client": tag, "entries": entries[i:i + 100]})
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
                              {"client": tag, "history": payload})
            log(f"云端发送历史已自动上报：{data.get('bytes', 0)} 字节", "DEBUG")
        except Exception as e:
            log(f"云端发送历史自动上报失败: {e}", "DEBUG")

    t = Thread(target=_work, daemon=True)
    t.start()
    return t


class HistoryManager:
    """负责跨班级/文件的发送历史持久化与统计管理"""
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

    def sync_file_loaded(self, file_path: str, student_data: list):
        """当载入文件时，按班级/文件名建立档案并同步所有学生"""
        if not file_path or not student_data:
            return
        filename = os.path.basename(file_path)
        base_name = os.path.splitext(filename)[0]
        clean_class_name = re.sub(r"([_\-](反馈快照|反馈|快照|错题|评语))+$", "", base_name, flags=re.I).strip()
        if not clean_class_name:
            clean_class_name = base_name

        key = filename
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
            entry["class_name"] = clean_class_name
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

    def update_student_status(self, file_path_or_name: str, student_name: str, status: str, time_str: str = None):
        """实时更新某学生在此班级/文件中的发送状态"""
        if not file_path_or_name:
            return
        key = os.path.basename(file_path_or_name)
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

    def get_student_historical_status(self, file_path_or_name: str, student_name: str) -> str:
        """获取某学生在此文件中的历史发送状态"""
        if not file_path_or_name:
            return ""
        key = os.path.basename(file_path_or_name)
        if key not in self._data["classes"]:
            return ""
        entry = self._data["classes"][key]
        for s in entry.get("students", []):
            if s["name"] == student_name:
                return s.get("status", "")
        return ""

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

        # 左侧：班级列表
        left_frame = ttk.LabelFrame(paned, text="📚 班级 / 文件列表", padding=8)
        paned.add(left_frame, weight=3)

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
            columns=("class_name", "progress"),
            show="headings",
            selectmode="browse",
        )
        self.class_tree.heading("class_name", text="班级 / 文件")
        self.class_tree.heading("progress", text="进度 (已发/总数)")
        self.class_tree.column("class_name", width=170, minwidth=120, anchor="w")
        self.class_tree.column("progress", width=95, minwidth=80, anchor="center")

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

        found_item = None
        for c in classes:
            c_name = c.get("class_name", "")
            f_name = c.get("file_name", "")
            if kw and (kw not in c_name.lower() and kw not in f_name.lower()):
                continue

            stats = c.get("stats", {})
            sent = stats.get("sent", 0)
            total = stats.get("total", 0)
            prog_str = f"{sent} / {total}"

            display_title = c_name if c_name else f_name
            item_id = self.class_tree.insert("", "end", values=(display_title, prog_str), tags=(c["key"],))

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
            self.cur_class_file.config(text="当您载入文件或开始发送后，系统将自动在此分类归档。")
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
        up_time = detail.get("last_update_time", "")

        self.cur_class_title.config(text=f"【{c_name}】 {f_name}")
        self.cur_class_file.config(text=f"文件路径: {f_path}  (最近更新: {up_time})")

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
        if not f_path or not os.path.exists(f_path):
            messagebox.showwarning(
                "文件不存在",
                f"未能找到原始文件：\n{f_path}\n\n该文件可能已被移动或删除。您可手动选择文件载入。",
                parent=self.dialog,
            )
            return

        if self.on_reload_file:
            self.dialog.destroy()
            self.on_reload_file(f_path)

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
        default_file = f"{c_name}_发送记录_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"

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
                writer.writerow(["序号", "学生学号/姓名", "发送状态", "记录时间", "评语字数", "评语内容"])
                for s in students:
                    writer.writerow([
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
        self.root.title("极方每周反馈程序")

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
        self.history_mgr = HistoryManager()

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
        log(f"极方每周反馈程序 初始化完成 | 数据目录: {get_data_dir()} | 日志路径: {LOG_FILE_PATH} | RapidOCR可用: {HAS_RAPIDOCR} | WinOCR可用: {HAS_WINOCR}", "INFO")
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
            text="极方每周反馈程序",
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
        dialog_w, dialog_h = 580, 520
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
        temp_smart_mode = tk.StringVar(value=self.smart_mode_var.get())
        temp_auto_fallback = tk.BooleanVar(value=self.auto_fallback_var.get())

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
        group_batch.pack(fill="x", pady=(0, 10))

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

        # 3. 视觉智能防误发双防线系统
        group_ocr = ttk.LabelFrame(container, text="🎯 视觉智能防误发防御体系 (双防线架构)", padding=10)
        group_ocr.pack(fill="x", pady=(0, 12))

        mode_box = tk.Frame(group_ocr, bg="#F5F7FA")
        mode_box.pack(fill="x", pady=(0, 4))

        ttk.Radiobutton(
            mode_box,
            text="模式 A：大模型视觉 API (通义千问 Qwen3.8-Flash，极高精度/语义抗干扰，推荐)",
            variable=temp_smart_mode,
            value="A"
        ).pack(anchor="w", pady=(0, 2))

        ttk.Radiobutton(
            mode_box,
            text="模式 B：本地离线 OCR (RapidOCR / WinOCR，纯本地运行/零 API 成本)",
            variable=temp_smart_mode,
            value="B"
        ).pack(anchor="w", pady=(0, 2))

        ttk.Radiobutton(
            mode_box,
            text="关闭智能核验 (仅依赖企业微信默认回车，易受他人描述干扰)",
            variable=temp_smart_mode,
            value="OFF"
        ).pack(anchor="w", pady=(0, 4))

        ttk.Checkbutton(
            group_ocr,
            text="模式 A 异常时自动平滑降级：网络受阻或云端超时自动回退为本地 OCR",
            variable=temp_auto_fallback,
        ).pack(anchor="w", pady=(0, 4))

        engine_desc_parts = []
        if HAS_RAPIDOCR:
            engine_desc_parts.append("本地 RapidOCR: 已就绪")
        elif HAS_WINOCR:
            engine_desc_parts.append("本地 WinOCR: 已就绪")
        else:
            engine_desc_parts.append("本地 OCR: 未就绪")
        engine_status_str = " | ".join(engine_desc_parts)

        tk.Label(
            group_ocr,
            text=f"【引擎状态】云端大模型: Qwen3.8-Flash 在线 | {engine_status_str}\n"
                 f"✓ 第 1 道防线（候选纠偏）：智能区分他人描述与独立联系人，自动【↓】纠偏\n"
                 f"✓ 第 2 道防线（标题核验）：进入会话后二次核验顶部标题，彻底杜绝发错人\n"
                 f"✓ 终极安全闭环：多次核验不符或仅他人描述时坚决拦截防误发",
            font=("Microsoft YaHei", 9),
            fg="#409EFF",
            bg="#F5F7FA",
            justify="left",
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
            temp_smart_mode.set("A")
            temp_auto_fallback.set(True)

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
            self.smart_mode_var.set(temp_smart_mode.get())
            self.auto_fallback_var.set(temp_auto_fallback.get())
            self.smart_ocr_enable_var.set(temp_smart_mode.get() != "OFF")

            dialog.destroy()
            self.status_label.config(text="✓ 高级配置参数已保存更新", fg="#67C23A")

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

        # 已载入文件条（文件名 + 条数 + 移除按钮）
        self.files_frame = tk.Frame(parent, bg="#F5F7FA")
        self.files_frame.pack(side="top", fill="x", pady=(0, 8))

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

        if safe_copy(student_name):
            orig_text = self.copy_student_btn.cget("text")
            self.copy_student_btn.config(text="✓ 已复制!")
            self.root.after(1500, lambda: self.copy_student_btn.config(text=orig_text))
            self.status_label.config(text=f"✓ 已复制学员标识: {student_name}", fg="#67C23A")
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
        """文件短标签：优先用历史档案里的班级名，否则用文件名（去扩展名，超长截断）"""
        try:
            detail = self.history_mgr.get_class_details(os.path.basename(file_path))
            if detail and detail.get("class_name"):
                return str(detail["class_name"])
        except Exception:
            pass
        stem = os.path.splitext(os.path.basename(file_path))[0]
        return stem if len(stem) <= 12 else (stem[:12] + "…")

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

        raw_data = load_feedback_data_from_file(file_path)

        if not isinstance(raw_data, list) or len(raw_data) == 0:
            raise ValueError("未能从该文件中提取到有效的学生反馈记录！")

        # 先同步历史档案，再取班级短标签
        self.history_mgr.sync_file_loaded(file_path, raw_data)
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
        """批量追加文件，逐个容错，汇总提示（含跨文件重名预警）"""
        added = 0
        skipped = 0
        failed = []
        for p in paths:
            try:
                n = self._load_one_file(p)
                if n > 0:
                    added += n
                else:
                    skipped += 1
            except Exception as e:
                failed.append(f"{os.path.basename(p)}：{e}")
        if failed:
            messagebox.showerror("读取错误", "以下文件读取失败：\n" + "\n".join(failed))
        self.refresh_queue_ui()
        if added > 0:
            dup_names = self._find_cross_file_duplicates()
            tip = f"✓ 已载入 {len(self.loaded_files)} 个文件，共 {len(self.data)} 条反馈数据。"
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
            hist_status = self.history_mgr.get_student_historical_status(src_file, student_name)

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
            self.history_mgr.update_student_status(src_file or self.current_file_path, s_name, "未发送", "-")
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

    # ================= 发送控制与执行 =================

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
        file_count = len(getattr(self, "loaded_files", []))
        tip_msg = f"即将发送 {len(to_send_indices)} 条反馈消息"
        tip_msg += f"（来自 {file_count} 个文件）。\n\n" if file_count > 1 else "。\n\n"
        if wecom_found:
            tip_msg += "✓ 已自动检测并激活企业微信主窗口。\n"
        else:
            tip_msg += "⚠️ 未自动探测到企业微信，请确保企业微信已在电脑上登录并打开！\n"

        mode = self.smart_mode_var.get()
        if mode == "A":
            fallback_tip = " (已开启异常自动降级至本地OCR)" if self.auto_fallback_var.get() else ""
            tip_msg += f"✓ 【模式 A·大模型视觉防御】已启用 (Qwen3.8-Flash + 会话标题双重防御){fallback_tip}：语义消歧、精准纠偏并杜绝误发。\n"
        elif mode == "B":
            engine_desc = []
            if HAS_RAPIDOCR:
                engine_desc.append("RapidOCR")
            elif HAS_WINOCR:
                engine_desc.append("WinOCR")
            engine_str = " + ".join(engine_desc) if engine_desc else "本地视觉"
            tip_msg += f"✓ 【模式 B·本地智能核验】已启用 ({engine_str} + 会话标题检查点)：避开他人描述，纠错并拦截误发。\n"
        else:
            tip_msg += "⚠️ 智能视觉核验已关闭：将走传统回车发送模式。\n"

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

        self.show_floating_window("⚠️ 自动发送即将启动，请勿动鼠标键盘！按 ESC 停止")

        self.status_label.config(text="⏳ 3 秒后开始发送，请将目光移至企业微信...", fg="#E6A23C")
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

            # 执行单条发送（包含模式 B 智能核验）
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
                self.history_mgr.update_student_status(item.get("_src_file") or self.current_file_path, student_name, "✓ 已发送", now_str)
                self.send_logs.append(
                    {"index": i + 1, "name": student_name, "status": "成功", "time": now_str, "msg_len": len(message), "file": item.get("_src_label", "")}
                )
            elif send_result == "NOT_FOUND":
                not_found_count += 1
                self.root.after(0, lambda idx=i: self.update_status(idx, "⚠️ 无此联系人"))
                self.history_mgr.update_student_status(item.get("_src_file") or self.current_file_path, student_name, "⚠️ 无此联系人", now_str)
                self.send_logs.append(
                    {"index": i + 1, "name": student_name, "status": "无此联系人", "time": now_str, "msg_len": len(message), "file": item.get("_src_label", "")}
                )
            elif send_result == "DESC_ONLY":
                desc_only_count += 1
                self.root.after(0, lambda idx=i: self.update_status(idx, "⚠️ 仅他人描述(拦截)"))
                self.history_mgr.update_student_status(item.get("_src_file") or self.current_file_path, student_name, "⚠️ 仅他人描述(拦截)", now_str)
                self.send_logs.append(
                    {"index": i + 1, "name": student_name, "status": "仅他人描述(拦截)", "time": now_str, "msg_len": len(message), "file": item.get("_src_label", "")}
                )
            elif send_result in ["HEADER_MISMATCH", "UNCERTAIN_INTERCEPT"]:
                header_mismatch_count += 1
                status_str = "⚠️ 标题不符(拦截)" if send_result == "HEADER_MISMATCH" else "⚠️ 存疑拦截"
                self.root.after(0, lambda idx=i, st=status_str: self.update_status(idx, st))
                self.history_mgr.update_student_status(item.get("_src_file") or self.current_file_path, student_name, status_str, now_str)
                self.send_logs.append(
                    {"index": i + 1, "name": student_name, "status": status_str, "time": now_str, "msg_len": len(message), "file": item.get("_src_label", "")}
                )
            elif send_result == "ABORTED":
                interrupted = True
                break
            else:
                fail_count += 1
                self.root.after(0, lambda idx=i: self.update_status(idx, "✗ 失败"))
                self.history_mgr.update_student_status(item.get("_src_file") or self.current_file_path, student_name, "✗ 失败", now_str)
                self.send_logs.append(
                    {"index": i + 1, "name": student_name, "status": "失败", "time": now_str, "msg_len": len(message), "file": item.get("_src_label", "")}
                )

            # 更新进度条
            completed_count = sum(1 for child in self.tree.get_children() if "✓" in self.tree.item(child, "values")[3])
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
        1. Ctrl+F 激活搜索框
        2. 清空并粘贴学号/姓名
        3. 等待下拉框展开
        4. 【模式 B 智能核验】：OCR 秒级识别下拉框，若第 1 项为他人描述则自动按【↓】选中第 2 项，若全是他人描述则安全拦截
        5. 回车进入会话
        6. 安全写入剪贴板并粘贴完整反馈
        7. 回车发送
        返回: "SUCCESS" | "NOT_FOUND" | "DESC_ONLY" | "ABORTED" | "FAILED"
        """
        log(f">>> 开始发送单条: '{search_name}', 文案字数={len(message)}", "INFO")
        if not self.safe_sleep(0.1):
            log(f"[{search_name}] 中断退出", "WARN")
            return "ABORTED"

        # 1. 激活搜索框
        pyautogui.hotkey("ctrl", "f")
        if not self.safe_sleep(CLICK_DELAY):
            return "ABORTED"

        # 2. 全选清空搜索框
        pyautogui.hotkey("ctrl", "a")
        if not self.safe_sleep(0.05):
            return "ABORTED"

        # 3. 复制学生学号/姓名并粘贴搜索
        if not safe_copy(search_name):
            log(f"[{search_name}] 学号/姓名写入剪贴板失败", "ERROR")
            return "FAILED"
        pyautogui.hotkey("ctrl", "v")
        if not self.safe_sleep(SEARCH_DELAY):
            return "ABORTED"

        # 4. 【视觉智能核验与初选 (模式 A 大模型 / 模式 B 本地 OCR)】
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
                    # 细分状态 1：无此联系人 / 显示全局搜索
                    log(f"[{search_name}] 通讯录中无此联系人(或全局搜索)，安全跳过", "WARN")
                    self.root.after(
                        0,
                        lambda n=search_name: self.status_label.config(
                            text=f"⚠️ 自动跳过 [{n}]：企微通讯录中无此联系人，已安全跳过",
                            fg="#F56C6C",
                        ),
                    )
                    # 安全退出浮层并清空搜索框
                    dismiss_and_clear_search()
                    return "NOT_FOUND"

                elif choice == -2:
                    # 细分状态 2：仅他人描述匹配，无本人备注
                    log(f"[{search_name}] 仅他人描述命中，无本人备注，安全拦截", "WARN")
                    self.root.after(
                        0,
                        lambda n=search_name: self.status_label.config(
                            text=f"⚠️ 智能拦截 [{n}]：搜索结果仅为他人描述，无本人备注，已拦截防误发",
                            fg="#E6A23C",
                        ),
                    )
                    # 安全退出浮层并清空搜索框
                    dismiss_and_clear_search()
                    return "DESC_ONLY"

                elif choice >= 2:
                    # 发现第 1 项是他人描述，第 2 项（或更后）才是本人！自动按向下键【↓】纠正
                    log(f"[{search_name}] 智能纠偏：前项为他人描述，已自动按向下键纠正至第{choice}项 ({matched_title})", "INFO")
                    self.root.after(
                        0,
                        lambda n=search_name, t=matched_title, c=choice: self.status_label.config(
                            text=f"🎯 智能纠偏 [{n}]：前项为他人描述，已自动按【向下键】纠正至第{c}项 ({t})",
                            fg="#E6A23C",
                        ),
                    )
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
                    # choice == -1: 识别未确立，试探性回车进入会话，绝不直接发送，交由下一步标题检查点裁决
                    log(f"[{search_name}] 下拉识别未明确，试探性进入第1项等待会话标题检查点核准...", "WARN")
                    pyautogui.press("enter")
                    time.sleep(0.2)
                    pyautogui.press("enter")
            else:
                log(f"[{search_name}] 未能获取企微窗口坐标，试探性回车并等待核验", "WARN")
                pyautogui.press("enter")
                time.sleep(0.2)
                pyautogui.press("enter")
        else:
            # 未开启智能模式，走传统两次回车
            log(f"[{search_name}] 未开启视觉智能核验，走传统回车进入第1项", "INFO")
            pyautogui.press("enter")
            time.sleep(0.2)
            pyautogui.press("enter")

        if not self.safe_sleep(CLICK_DELAY):
            return "ABORTED"

        # 5. 【会话标题安全检查点 (Check Point) 与自愈回滚】
        if smart_mode != "OFF" and wecom_rect:
            header_status, header_title = verify_chat_header_title(
                wecom_rect, target_id, target_name, timeout=1.2, mode=smart_mode, auto_fallback=auto_fallback
            )

            # 异常感知：检测到会话标题为他人（如进入了 90001张三 @微信，而非 80001李四）
            if header_status == "MISMATCH":
                log(f"[{search_name}] ⚠️ 会话标题检查点拉响警报！当前处于【{header_title}】，非目标本人！触发自愈回滚...", "WARN")
                self.root.after(
                    0,
                    lambda n=search_name, t=header_title: self.status_label.config(
                        text=f"🔄 触发自愈纠偏 [{n}]：当前会话为【{t}】，正在重新搜索并尝试下一项...",
                        fg="#E6A23C",
                    ),
                )

                # 自愈回滚动作：重新按 Ctrl+F 激活搜索，并尝试下一项
                healed = False
                current_item = choice if choice >= 1 else 1
                next_item = current_item + 1

                for attempt in range(next_item, min(next_item + 2, 4)):
                    log(f"[{search_name}] 自愈尝试：重新唤起搜索并按【↓】尝试第 {attempt} 项...", "INFO")
                    pyautogui.hotkey("ctrl", "f")
                    time.sleep(0.25)
                    safe_copy(search_name)
                    pyautogui.hotkey("ctrl", "v")
                    time.sleep(0.7)
                    for _ in range(attempt - 1):
                        pyautogui.press("down")
                        time.sleep(0.12)
                    time.sleep(0.15)
                    pyautogui.press("enter")
                    time.sleep(0.3)

                    retry_status, retry_title = verify_chat_header_title(
                        wecom_rect, target_id, target_name, timeout=1.0, mode=smart_mode, auto_fallback=auto_fallback
                    )
                    if retry_status == "MATCH":
                        log(f"[{search_name}] ✓ 自愈纠偏成功！会话已更正为目标本人【{retry_title}】", "INFO")
                        header_status = "MATCH"
                        header_title = retry_title
                        healed = True
                        break
                    else:
                        log(f"[{search_name}] 第 {attempt} 项核验仍不匹配: '{retry_title}'", "WARN")

                if not healed and header_status == "MISMATCH":
                    # 自愈失败，坚决安全拦截，严禁误发！
                    log(f"[{search_name}] ⛔ 安全拦截：会话标题多次核验仍不符 (当前标题: '{header_title}')，绝不误发！", "ERROR")
                    self.root.after(
                        0,
                        lambda n=search_name, t=header_title: self.status_label.config(
                            text=f"⛔ 标题不符已拦截 [{n}]：当前会话为【{t}】，已安全拦截防误发！",
                            fg="#F56C6C",
                        ),
                    )
                    # 安全退出浮层并清空搜索框
                    dismiss_and_clear_search()
                    return "HEADER_MISMATCH"

            elif header_status == "UNCERTAIN":
                # 会话标题未能核准（存疑），坚决触发安全拦截防盲发
                log(f"[{search_name}] ⛔ 安全拦截：会话标题无法确切核准（存疑状态），触发安全拦截防盲发！", "ERROR")
                self.root.after(
                    0,
                    lambda n=search_name: self.status_label.config(
                        text=f"⛔ 身份存疑已拦截 [{n}]：无法核准会话身份，已拦截！",
                        fg="#F56C6C",
                    ),
                )
                dismiss_and_clear_search()
                return "UNCERTAIN_INTERCEPT"

            elif header_status == "MATCH":
                log(f"[{search_name}] ✓ 会话标题安全检查点完全通过: '{header_title}'", "INFO")

        # 6. 安全写入剪贴板并粘贴完整反馈文案
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

        # 7. 发送消息 (Enter)
        pyautogui.press("enter")
        if not self.safe_sleep(SEND_DELAY):
            return "ABORTED"

        log(f"[{search_name}] 单条反馈发送成功 ✓", "INFO")
        return "SUCCESS"


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

    def reload_from_history(self, file_path: str):
        """从历史记录窗口重载班级文件到主界面"""
        self.select_file(target_path=file_path)

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
