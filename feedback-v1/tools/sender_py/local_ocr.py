"""本地 OCR 备选核验模块 (local_ocr.py)

用于场景2（标题栏会话核验）的本地兜底/故障转移方案：
当云端多模态 API（DashScope / Qwen3.8-Flash）出现断网、超时、5xx、配额耗尽等异常时，
自动无缝切换到本地离线 OCR，实现：
  1. 零网络依赖，极速识别标题栏文本；
  2. 严格核验学号与姓名（fail-closed：未匹配不放行）；
  3. 严格检测群聊与多人会话（发现群聊一律拦截）。

OCR 引擎优先级：
  1. 测试 Hook（供单元测试注入）
  2. winocr（若已安装 Python WinRT 绑定，在进程内极速运行，约 20ms）
  3. Windows 10/11 原生 PowerShell WinRT OCR（系统内置 Windows.Media.Ocr，零额外依赖）
  4. rapidocr_onnxruntime / pytesseract（如环境中有安装）
"""

import os
import re
import subprocess
import sys
import tempfile
import time

_OCR_HOOK = None


def set_ocr_hook_for_testing(hook):
    """供单元测试注入模拟 OCR 文本提取函数。传入 None 清除。"""
    global _OCR_HOOK
    _OCR_HOOK = hook


def get_ocr_hook_for_testing():
    return _OCR_HOOK


def detect_is_group(title_text: str) -> bool:
    """检测标题栏是否呈现群聊/多人会话特征。
    
    企微群聊典型特征：
      1. 标题尾部包含括号人数，如：初一数学群(45)、项目交流组（5）
      2. 包含群关键词：群聊、交流群、班级群、家长群、教研群、工作群、全员等
      3. 包含多位人名分隔符：张三、李四 或 张三,李四
    """
    if not title_text:
        return False
    text = title_text.strip()
    # 1. 括号人数检测 (数字) 或 （数字）
    if re.search(r'[\(（]\s*\d+\s*[\)）]', text):
        return True
    # 2. 群特征关键词
    if re.search(r'(群聊|讨论组|交流群|班级群|家长群|教研群|工作群|项目群|全员|年级群)', text):
        return True
    # 3. 顿号或逗号分隔的连续中文人名
    if re.search(r'[\u4e00-\u9fa5]{2,}[、,，/][\u4e00-\u9fa5]{2,}', text):
        return True
    return False


def normalize_clean(s: str) -> str:
    """去除非关键字符（空格、横线、下划线、点等）并转小写，便于宽容但精确的比对。"""
    if s is None:
        return ""
    return re.sub(r'[\s\-_—·.,，:：()（）\[\]【】]+', '', str(s)).lower()


def parse_title_judgment(ocr_text: str, target_id: str, target_name: str) -> dict:
    """纯函数：依据 OCR 识别出的文本做确定性核验决策（无环境依赖，可 100% 单测）。
    
    返回字段与 identify.php 接口完全对齐：
      - matched: bool（标题同时包含学号与姓名才为 true，任一缺失或为群聊则 false）
      - is_group: bool（是否检测到群聊）
      - title_in_header: bool（是否识别到有效标题）
      - detected_title: str（识别原文）
      - reason: str（一句话理由）
    """
    raw = (ocr_text or "").strip()
    if not raw:
        return {
            "matched": False,
            "is_group": False,
            "title_in_header": False,
            "detected_title": "",
            "reason": "本地OCR未能识别出有效文字 (fail-closed)",
        }

    # 1. 红线拦截：检测是否为群聊
    if detect_is_group(raw):
        return {
            "matched": False,
            "is_group": True,
            "title_in_header": True,
            "detected_title": raw,
            "reason": f"本地OCR检测到群聊特征（{raw}），严格拦截",
        }

    # 2. 身份核验：检查学号与姓名
    clean_text = normalize_clean(raw)
    clean_id = normalize_clean(target_id)
    clean_name = normalize_clean(target_name)

    has_id = (clean_id in clean_text) if clean_id else True
    has_name = (clean_name in clean_text) if clean_name else True

    # 至少学号或姓名之一有要求，否则不可无条件通过
    if not clean_id and not clean_name:
        return {
            "matched": False,
            "is_group": False,
            "title_in_header": True,
            "detected_title": raw,
            "reason": "目标学号与姓名均为空，拒绝放行",
        }

    if has_id and has_name:
        return {
            "matched": True,
            "is_group": False,
            "title_in_header": True,
            "detected_title": raw,
            "reason": f"本地OCR匹配成功：识别到标题包含学号[{target_id}]与姓名[{target_name}]",
        }

    missing = []
    if not has_id:
        missing.append(f"学号[{target_id}]")
    if not has_name:
        missing.append(f"姓名[{target_name}]")
    return {
        "matched": False,
        "is_group": False,
        "title_in_header": True,
        "detected_title": raw,
        "reason": f"本地OCR未完全匹配目标：缺失{'和'.join(missing)}（识别原文: {raw}）",
    }


def _ocr_via_windows_powershell(img) -> str:
    """调用 Windows 10/11 原生 Windows.Media.Ocr.OcrEngine（免安装任何第三方轮子）。"""
    if sys.platform != "win32":
        return ""
    temp_dir = tempfile.gettempdir()
    temp_path = os.path.join(temp_dir, f"wecom_ocr_{os.getpid()}_{time.time_ns()}.png")
    try:
        img.save(temp_path, format="PNG")
        ps_path = temp_path.replace("'", "''")
        ps_cmd = (
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;"
            "Add-Type -AssemblyName System.Runtime.WindowsRuntime;"
            "$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | "
            "Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and "
            "$_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0];"
            "function Await($task, $type) {"
            "  $asTask = $asTaskGeneric.MakeGenericMethod($type);"
            "  $netTask = $asTask.Invoke($null, @($task));"
            "  $netTask.Wait(4000) | Out-Null;"
            "  return $netTask.Result;"
            "};"
            "[void][Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime];"
            "[void][Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime];"
            "[void][Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime];"
            f"$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('{ps_path}')) ([Windows.Storage.StorageFile]);"
            "$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream]);"
            "$dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder]);"
            "$bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap]);"
            "$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages();"
            "if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans-CN')); };"
            "if ($engine) {"
            "  $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult]);"
            "  if ($res) { Write-Output $res.Text };"
            "};"
        )
        creationflags = 0x08000000 if sys.platform == "win32" else 0
        proc = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps_cmd],
            capture_output=True,
            timeout=6,
            creationflags=creationflags,
        )
        out = proc.stdout.decode("utf-8", errors="replace").strip()
        return out
    except Exception:
        return ""
    finally:
        try:
            if os.path.isfile(temp_path):
                os.remove(temp_path)
        except Exception:
            pass


def _ocr_via_winocr(img) -> str:
    """若环境中装有 winocr，直接在 Python 进程内调用，无子进程开销。"""
    try:
        import winocr
        res = winocr.recognize_pil_sync(img, "zh-Hans-CN")
        if isinstance(res, dict) and "text" in res:
            return str(res["text"]).strip()
        if hasattr(res, "text") and res.text:
            return str(res.text).strip()
    except Exception:
        pass
    return ""


def _ocr_via_rapidocr(img) -> str:
    """若环境中装有 rapidocr_onnxruntime，离线调用。"""
    try:
        from rapidocr_onnxruntime import RapidOCR
        engine = RapidOCR()
        res, _ = engine(img)
        if res:
            return " ".join(line[1] for line in res).strip()
    except Exception:
        pass
    return ""


def ocr_title_image(img) -> str:
    """执行标题栏 OCR 文字提取。依次尝试：测试Hook -> winocr -> Windows原生PowerShell -> RapidOCR。"""
    if _OCR_HOOK is not None:
        try:
            return str(_OCR_HOOK(img) or "").strip()
        except Exception:
            return ""
    if img is None:
        return ""

    # 1. winocr
    text = _ocr_via_winocr(img)
    if text:
        return text

    # 2. Windows 10/11 原生 WinRT OCR
    if sys.platform == "win32":
        text = _ocr_via_windows_powershell(img)
        if text:
            return text

    # 3. RapidOCR (跨平台备用)
    text = _ocr_via_rapidocr(img)
    if text:
        return text

    return ""


def identify_title_local(title_img, target_id: str, target_name: str) -> dict:
    """场景 2 本地备选接口：将标题栏图像传入本地 OCR 并执行身份核验。
    
    返回字段完全兼容 identify_title() 的出参规范。
    """
    text = ocr_title_image(title_img)
    return parse_title_judgment(text, target_id, target_name)
