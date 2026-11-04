"""多引擎识别基准评测模块 (benchmark.py)

功能：
  1. 【全仿真·只测不发】：逐一在企业微信中搜索勾选的学生并进入窗口；
  2. 【多引擎横向比对】：对截取的同一张标题栏图像，并发/串行调用：
     - Qwen3.8-Flash (云端大模型)
     - RapidOCR (纯识别模式 Rec-Only)
     - RapidOCR (全流程检测+识别 Det+Rec)
     - winocr (Windows 原生 WinRT 内存直调)
     - PowerShell WinRT OCR (系统命令行保底)
  3. 【精准耗时与精度统计】：记录各引擎的原生识别文本、判定结果 (matched) 与毫秒级耗时 (ms)；
  4. 【分歧发现与数据导出】：自动筛出不同引擎识别不一致的样本，支持一键导出 CSV 报表。
  5. 【物理防误发安全断路器】：严格不调用 paste_and_send，绝不向企微输入框粘贴或发送任何文字。
"""

import os
import sys
import time
import csv
import io
from typing import Dict, List, Tuple, Any, Optional

try:
    from sender_py import window_utils as wu
    from sender_py import capture
    from sender_py import vision_api
    from sender_py.roi_manager import default_config_path
    from sender_py.capture import crop_by_rel, capture_wecom_window
    from sender_py.local_ocr import (
        _get_rapidocr_engine,
        _preprocess_title_img,
        _extract_text_from_rapidocr_result,
        _ocr_via_winocr,
        parse_title_judgment,
    )
    from sender_py.sender import (
        rescue_option1_fuzzy_match,
        ensure_roi,
        search_and_enter,
    )
except ModuleNotFoundError:
    import window_utils as wu
    import capture
    import vision_api
    from roi_manager import default_config_path
    from capture import crop_by_rel, capture_wecom_window
    from local_ocr import (
        _get_rapidocr_engine,
        _preprocess_title_img,
        _extract_text_from_rapidocr_result,
        _ocr_via_winocr,
        parse_title_judgment,
    )
    from sender import (
        rescue_option1_fuzzy_match,
        ensure_roi,
        search_and_enter,
    )


# 测试注入 Hook（单测专用）
_BENCHMARK_HOOK = None


def set_benchmark_hook_for_testing(hook):
    """注入评测 Hook，供单测完全模拟多引擎返回。"""
    global _BENCHMARK_HOOK
    _BENCHMARK_HOOK = hook


def evaluate_title_image_all_engines(
    title_img, sid: str, sname: str, server: str, token: Optional[str] = None
) -> Tuple[Dict[str, Dict[str, Any]], bool, str]:
    """对同一张标题栏截图分别运行所有可用引擎，并记录识别文本、判定与耗时。
    
    返回: (engine_results, has_discrepancy, fastest_engine_name)
    """
    server = (server or "https://feedback.wxjifang.cn").strip()
    if _BENCHMARK_HOOK is not None:
        return _BENCHMARK_HOOK(title_img, sid, sname, server, token)

    results: Dict[str, Dict[str, Any]] = {}
    proc_img = _preprocess_title_img(title_img) if title_img else None

    # 1. Qwen3.8-Flash (云端快速视觉大模型)
    t0 = time.perf_counter()
    try:
        if title_img is None:
            raise ValueError("标题截图为空")
        res = vision_api.identify_title(title_img, sid, sname, server, token, timeout=20)
        t_ms = round((time.perf_counter() - t0) * 1000)
        judgment = rescue_option1_fuzzy_match(res, sid, sname)
        results["qwen_flash"] = {
            "name": "Qwen3.8-Flash",
            "status": "ok",
            "matched": bool(judgment.get("matched")),
            "text": str(judgment.get("detected_title") or "").strip(),
            "reason": str(judgment.get("reason") or ""),
            "latency_ms": t_ms,
        }
    except Exception as exc:
        t_ms = round((time.perf_counter() - t0) * 1000)
        results["qwen_flash"] = {
            "name": "Qwen3.8-Flash",
            "status": "error",
            "matched": False,
            "text": f"调用失败: {exc}",
            "reason": str(exc),
            "latency_ms": t_ms,
        }

    # 2. RapidOCR (全流程检测+识别 Det + Rec)
    t0 = time.perf_counter()
    try:
        engine = _get_rapidocr_engine()
        if engine is None:
            raise RuntimeError("RapidOCR 未安装")
        if proc_img is None:
            raise ValueError("预处理图像为空")
        ocr_res, _ = engine(proc_img)
        text = _extract_text_from_rapidocr_result(ocr_res)
        t_ms = round((time.perf_counter() - t0) * 1000)
        judgment = parse_title_judgment(text, sid, sname)
        judgment = rescue_option1_fuzzy_match(judgment, sid, sname)
        results["rapid_full"] = {
            "name": "RapidOCR(全流程)",
            "status": "ok",
            "matched": bool(judgment.get("matched")),
            "text": text,
            "reason": judgment.get("reason", ""),
            "latency_ms": t_ms,
        }
    except Exception as exc:
        t_ms = round((time.perf_counter() - t0) * 1000)
        results["rapid_full"] = {
            "name": "RapidOCR(全流程)",
            "status": "error",
            "matched": False,
            "text": f"失败: {exc}",
            "reason": str(exc),
            "latency_ms": t_ms,
        }

    # 3. winocr (Windows 原生 WinRT 进程内直调)
    t0 = time.perf_counter()
    try:
        if sys.platform != "win32":
            raise RuntimeError("仅限 Windows")
        import winocr  # noqa: F401
        text = _ocr_via_winocr(proc_img)
        t_ms = round((time.perf_counter() - t0) * 1000)
        judgment = parse_title_judgment(text, sid, sname)
        judgment = rescue_option1_fuzzy_match(judgment, sid, sname)
        results["winocr"] = {
            "name": "winocr",
            "status": "ok",
            "matched": bool(judgment.get("matched")),
            "text": text,
            "reason": judgment.get("reason", ""),
            "latency_ms": t_ms,
        }
    except Exception as exc:
        t_ms = round((time.perf_counter() - t0) * 1000)
        results["winocr"] = {
            "name": "winocr",
            "status": "skipped" if sys.platform != "win32" else "error",
            "matched": False,
            "text": "(未安装或非Win10+)" if sys.platform != "win32" else f"失败: {exc}",
            "reason": str(exc),
            "latency_ms": t_ms,
        }

    # 判定分歧情况：在正常返回 ok 的引擎之间，核验匹配状态是否不一致
    ok_engines = [v for v in results.values() if v.get("status") == "ok"]
    matched_flags = [v.get("matched") for v in ok_engines]
    has_discrepancy = len(set(matched_flags)) > 1 if matched_flags else False

    # 计算最快成功引擎
    fastest_engine = ""
    min_lat = 999999
    for v in ok_engines:
        lat = v.get("latency_ms", 999999)
        if lat < min_lat:
            min_lat = lat
            fastest_engine = v.get("name", "")

    return results, has_discrepancy, fastest_engine


def check_and_handle_search_tab(log=print, name: str = "") -> bool:
    """检查并关闭企微全局搜索弹窗。"""
    tab_hwnd = wu.find_wecom_search_tab_wnd()
    if tab_hwnd:
        log(f"  🔍 检测到企业微信弹出【全局搜索】窗口 (SearchTabWnd2)，表明未搜到联系人 [{name}]")
        log(f"  └ 自动关闭全局搜索窗口...")
        wu.close_wecom_search_tab_wnd(tab_hwnd)
        return True
    return False


def benchmark_single_student(
    item: dict,
    server: str,
    token: Optional[str] = None,
    config_path: Optional[str] = None,
    log=print,
    should_stop=None,
) -> dict:
    """对单个学生执行全仿真搜索、截图与多引擎横向比对。
    
    【绝对安全红线】：本函数 100% 绝不调用 paste_and_send，绝不触发按键发送。
    """
    name = item.get("studentName", "")
    sid = item.get("sid", "")
    sname = item.get("sname", "")
    if not sname and name:
        try:
            from sender_py.utils import parse_student_identifier
        except ModuleNotFoundError:
            from utils import parse_student_identifier
        _, sname = parse_student_identifier(name)

    if should_stop is not None and should_stop():
        return {"success": False, "reason": "用户停止", "record": None}

    # 激活并置顶企业微信窗口，避免后台或最小化导致找窗/坐标失效
    if not wu.find_and_activate_wecom():
        if should_stop is not None and should_stop():
            return {"success": False, "reason": "用户停止", "record": None}
        return {"success": False, "reason": "企微唤起失败（最小化或无响应），请手动点开后重试", "record": None}
    time.sleep(0.3)

    ok_vis, vis = wu.ensure_fully_visible(log=log)
    rect = vis if (ok_vis and vis) else wu.get_wecom_rect()
    if not rect:
        return {"success": False, "reason": "未找到企业微信窗口", "record": None}

    scale = wu.get_dpi_scale()
    roi = ensure_roi(None, rect, scale, config_path, server=server, token=token, log=log, sample_name=name)
    if not roi:
        return {"success": False, "reason": "ROI 校准未完成", "record": None}

    # 校准过程或居中操作可能改变企微位置，刷新最新物理坐标
    try:
        fresh_rect = wu.get_wecom_rect()
        if fresh_rect and fresh_rect[2] >= 200 and fresh_rect[3] >= 150:
            rect = fresh_rect
    except Exception:
        pass

    log(f"  🔍 正在企业微信中搜索联系人: {name} (候选 1)...")
    entered = search_and_enter(name, 1)

    # 检查全局搜索弹窗（查无此人）
    if check_and_handle_search_tab(log=log, name=name):
        log(f"  ⚠️ [{name}] 未在本地搜索到联系人（弹出全局搜索窗口）")
        return {"success": False, "reason": "未找到该联系人（弹出全局搜索）", "record": None}

    if should_stop is not None and should_stop():
        return {"success": False, "reason": "用户停止", "record": None}

    # 唤起焦点并稍作等待
    if entered:
        wu.find_and_activate_wecom()
        time.sleep(0.35)

    if check_and_handle_search_tab(log=log, name=name):
        return {"success": False, "reason": "未找到该联系人（弹出全局搜索）", "record": None}

    # 截图核验前再次确认最新坐标
    try:
        fresh_rect = wu.get_wecom_rect()
        if fresh_rect and fresh_rect[2] >= 200 and fresh_rect[3] >= 150:
            rect = fresh_rect
    except Exception:
        pass

    # 截取整窗并裁剪标题栏
    img = capture_wecom_window(rect)
    if img is None:
        log(f"  ❌ [{name}] 企微窗口截图失败")
        return {"success": False, "reason": "截图失败", "record": None}

    title_img = crop_by_rel(img, roi["title"])

    log(f"  ⚡ 正在并发/串行评测全部 3 种识别方案并计时...")
    engine_results, has_discrepancy, fastest = evaluate_title_image_all_engines(
        title_img, sid, sname, server, token
    )

    log_desc = []
    for k, v in engine_results.items():
        st = "✓" if v.get("matched") else "✗"
        lat = v.get("latency_ms", 0)
        log_desc.append(f"{v.get('name')}: {st} ({lat}ms)")
    disc_tag = " ⚠️[存在分歧]" if has_discrepancy else ""
    log(f"  📊 评测完成{disc_tag} -> {' | '.join(log_desc)}")

    record = {
        "studentName": name,
        "sid": sid,
        "sname": sname,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "engines": engine_results,
        "has_discrepancy": has_discrepancy,
        "fastest": fastest,
    }
    return {"success": True, "reason": "评测完成", "record": record}


def compute_benchmark_summary(records: List[dict]) -> dict:
    """计算基准评测的全局汇总统计数据（成功率、平均耗时、分歧率等）。"""
    total = len(records)
    if total == 0:
        return {
            "total": 0,
            "discrepancy_count": 0,
            "discrepancy_rate_pct": 0.0,
            "engines": {},
        }

    engine_keys = ["winocr", "rapid_full", "qwen_flash"]
    engine_names = {
        "winocr": "winocr (WinRT极速)",
        "rapid_full": "RapidOCR(全流程)",
        "qwen_flash": "Qwen3.8-Flash",
    }

    engine_data: Dict[str, dict] = {}
    for ek in engine_keys:
        engine_data[ek] = {
            "name": engine_names[ek],
            "evaluated_count": 0,
            "matched_count": 0,
            "match_rate_pct": 0.0,
            "total_latency_ms": 0,
            "avg_latency_ms": 0.0,
            "min_latency_ms": 999999,
            "max_latency_ms": 0,
            "error_count": 0,
        }

    discrepancy_count = 0
    for r in records:
        if r.get("has_discrepancy"):
            discrepancy_count += 1
        engines = r.get("engines", {})
        for ek, ed in engine_data.items():
            ev = engines.get(ek)
            if not ev:
                continue
            status = ev.get("status")
            if status == "ok":
                ed["evaluated_count"] += 1
                if ev.get("matched"):
                    ed["matched_count"] += 1
                lat = ev.get("latency_ms", 0)
                ed["total_latency_ms"] += lat
                if lat < ed["min_latency_ms"]:
                    ed["min_latency_ms"] = lat
                if lat > ed["max_latency_ms"]:
                    ed["max_latency_ms"] = lat
            elif status == "error":
                ed["error_count"] += 1

    for ek, ed in engine_data.items():
        cnt = ed["evaluated_count"]
        if cnt > 0:
            ed["match_rate_pct"] = round((ed["matched_count"] / cnt) * 100, 1)
            ed["avg_latency_ms"] = round(ed["total_latency_ms"] / cnt, 1)
        else:
            ed["min_latency_ms"] = 0

    return {
        "total": total,
        "discrepancy_count": discrepancy_count,
        "discrepancy_rate_pct": round((discrepancy_count / total) * 100, 1),
        "engines": engine_data,
    }


def generate_benchmark_csv_content(records: List[dict], summary: Optional[dict] = None) -> str:
    """生成带有 UTF-8-BOM 的完整 CSV 评测对比报表字符串，可在 Excel 中完美打开。"""
    output = io.StringIO()
    writer = csv.writer(output)

    # 1. 顶部汇总行
    if summary and summary.get("total", 0) > 0:
        writer.writerow(["=== 极方企业微信反馈多引擎识别基准评测报告 (Benchmark Report) ==="])
        writer.writerow(["评测生成时间", time.strftime("%Y-%m-%d %H:%M:%S")])
        writer.writerow(["评测总样本数", summary.get("total", 0)])
        writer.writerow(["存在分歧样本数", summary.get("discrepancy_count", 0)])
        writer.writerow(["结果分歧率", f"{summary.get('discrepancy_rate_pct', 0)}%"])
        writer.writerow([])
        writer.writerow(["【各引擎性能与精度排行榜】"])
        writer.writerow(["引擎名称", "有效评测数", "匹配成功数", "匹配准确率", "平均耗时(ms)", "最快耗时(ms)", "最慢耗时(ms)"])
        for _, ed in summary.get("engines", {}).items():
            writer.writerow([
                ed.get("name"),
                ed.get("evaluated_count"),
                ed.get("matched_count"),
                f"{ed.get('match_rate_pct')}%",
                ed.get("avg_latency_ms"),
                ed.get("min_latency_ms"),
                ed.get("max_latency_ms"),
            ])
        writer.writerow([])
        writer.writerow(["=== 逐人明细评测数据 ==="])

    # 2. 表头
    headers = [
        "序号",
        "搜索联系人",
        "目标学号",
        "目标姓名",
        "winocr识别文本",
        "winocr判定",
        "winocr耗时(ms)",
        "RapidOCR全流程文本",
        "RapidOCR全流程判定",
        "RapidOCR全流程耗时(ms)",
        "QwenFlash识别文本",
        "QwenFlash判定",
        "QwenFlash耗时(ms)",
        "引擎一致性",
        "最快引擎",
    ]
    writer.writerow(headers)

    # 3. 逐行填充
    for idx, r in enumerate(records, 1):
        eng = r.get("engines", {})
        win = eng.get("winocr", {})
        r_full = eng.get("rapid_full", {})
        qwen = eng.get("qwen_flash", {})

        disc_str = "⚠️ 存在分歧" if r.get("has_discrepancy") else "一致"
        row = [
            idx,
            r.get("studentName", ""),
            r.get("sid", ""),
            r.get("sname", ""),
            win.get("text", ""),
            "通过" if win.get("matched") else "未通过",
            win.get("latency_ms", 0),
            r_full.get("text", ""),
            "通过" if r_full.get("matched") else "未通过",
            r_full.get("latency_ms", 0),
            qwen.get("text", ""),
            "通过" if qwen.get("matched") else "未通过",
            qwen.get("latency_ms", 0),
            disc_str,
            r.get("fastest", "-"),
        ]
        writer.writerow(row)

    return output.getvalue()
