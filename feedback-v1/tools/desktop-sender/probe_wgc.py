#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WGC（Windows.Graphics.Capture）可行性探针 —— 只做实验，不改动 send_feedback.py。

要回答的唯一问题：
    「企微窗口能不能用 WGC 抓到真实内容（而不是黑屏）？」

背景与动机（均有代码依据，见下方各场景注释）：
  * send_feedback.py 现在全部 4 处截图都是 `pyautogui.screenshot(region=...)`，
    抓的是**屏幕像素**。企微被任何窗口盖住，截到的就是那个窗口。
  * 本程序自己的 Tk 主窗口（1120x840，发送全程不隐藏）压在企微上方时，
    下拉候选与标题条截图都会拍到控件 —— 而 `is_foreground_wecom()` 只检查
    **谁持有前台焦点**，检测不到「有人画在企微上面」，所以不会有任何告警。
  * WGC 抓的是 DWM 为该窗口维护的独立视频表面，理论上免疫遮挡、且不受窗口
    是否部分出屏影响。如果成立，就能删掉自遮挡防护、也不再需要为「窗口太窄
    导致 ww*0.45 封顶切掉下拉条目尾部」而强制最大化。

用法（必须在 Windows 上、开着企业微信登录状态下跑）：
    python probe_wgc.py                 # 跑全部场景并给出结论
    python probe_wgc.py --list          # 只列出将要执行的场景

依赖：
    pip install windows-capture         # WGC 后端；缺失时脚本会明确提示
    pyautogui / pillow / pywin32        # 项目本就有；缺失则跳过对应后端

安全约定（重要）：
  本脚本会**移动、还原、最小化**企业微信窗口，并在屏幕上弹出黑色遮挡窗。
  每个场景跑在独立子进程里，子进程用 try/finally 还原窗口；父进程另有一道
  最终兜底还原 —— 因为被硬超时 kill 掉的子进程不会执行 finally。
  跑完请确认企微窗口已回到原位。

退出码：
  0 = 全部场景跑完（不代表 WGC 可用，看结论）
  1 = 环境不满足（缺依赖 / 找不到企微窗口）
"""

import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "probe_out")

# 各场景的超时上限（秒）。WGC 是异步等帧，窗口无变化时可能一直不投递，
# 所以必须由父进程硬杀，不能指望子进程自己返回。
SCENARIO_TIMEOUT = {
    "wgc-visible": 20,
    "wgc-occluded": 20,
    "wgc-offscreen": 20,
    "wgc-minimized": 12,   # 预期就是拿不到帧，超时本身就是结论
    "wgc-freshness": 30,   # 连拍两次 + 中途改窗口宽度
    "pyautogui-visible": 15,
    "pyautogui-occluded": 15,
}

# 场景顺序即执行顺序：先拿基准，再做破坏性对比。
SCENARIOS = [
    "wgc-visible",
    "wgc-occluded",
    "wgc-offscreen",
    "wgc-minimized",
    "wgc-freshness",
    "pyautogui-visible",
    "pyautogui-occluded",
]


# ==================================================================== 小工具


def say(msg, **kwargs):
    print(msg, **kwargs)


def write_result(name, payload):
    """把子进程的结果落盘，供父进程读取。"""
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, name + ".json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return path


# ==================================================================== 企微窗口定位
# 刻意与 send_feedback.py:get_wecom_hwnd() 逐字一致 —— 探针必须测同一个窗口，
# 否则「探针能抓、主程序抓不到」这种情况会被误判成 WGC 不可用。


def get_wecom_hwnd():
    """获取企业微信主窗口在屏幕上的顶级句柄 (HWND)。

    逐字复制自 send_feedback.py，保证探针与主程序定位到同一个窗口。
    注意原实现返回 EnumWindows 顺序里的**第一个**匹配项，若机器上存在多个
    企微窗口（主窗口 + 独立聊天窗）可能取错 —— 探针会把全部候选列出来供核对。
    """
    try:
        import win32gui
    except Exception:
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


def _is_zoomed(hwnd):
    """pywin32 312 未导出 win32gui.IsZoomed（真机实测 AttributeError）。
    走 user32。这坑踩过一次：候选窗口枚举里的 IsZoomed 被外层 except 吞掉，
    导致 list_wecom_candidates 静默返回空列表。"""
    try:
        import ctypes

        return bool(ctypes.windll.user32.IsZoomed(hwnd))
    except Exception:
        return False


def list_wecom_candidates():
    """列出所有疑似企微顶层窗口，供人工核对探针是否挑对了窗口。"""
    try:
        import win32gui
    except Exception:
        return []

    found = []

    def enum_cb(hwnd, _):
        if win32gui.IsWindow(hwnd):
            cls = win32gui.GetClassName(hwnd)
            title = win32gui.GetWindowText(hwnd)
            if ("WeWorkWindow" in cls or "企业微信" in title or "WXWork" in cls) and "Wedoc" not in cls:
                rect = win32gui.GetWindowRect(hwnd)
                found.append(
                    {
                        "hwnd": hwnd,
                        "cls": cls,
                        "title": title,
                        "rect": [rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]],
                        "iconic": bool(win32gui.IsIconic(hwnd)),
                        "zoomed": _is_zoomed(hwnd),
                    }
                )
        return True

    try:
        win32gui.EnumWindows(enum_cb, None)
    except Exception:
        pass
    return found


def save_placement(hwnd):
    """记录窗口位置与显示状态（GetWindowPlacement 同时含 showCmd 与 rcNormalPosition）。"""
    import win32gui

    return win32gui.GetWindowPlacement(hwnd)


def restore_placement(hwnd, placement):
    import win32gui

    try:
        win32gui.SetWindowPlacement(hwnd, placement)
    except Exception:
        pass


# ==================================================================== 图像度量


def frame_stats(img):
    """返回灰度统计量，用于识别「整帧纯黑」——那是 WGC 对 GPU 合成窗口失败的表现。"""
    g = img.convert("L")
    hist = g.histogram()
    total = sum(hist)
    if total == 0:
        return {"mean": 0.0, "stddev": 0.0, "min": 0, "max": 0, "w": img.width, "h": img.height}

    mean = sum(i * c for i, c in enumerate(hist)) / total
    var = sum(((i - mean) ** 2) * c for i, c in enumerate(hist)) / total
    nonzero = [i for i, c in enumerate(hist) if c]
    return {
        "mean": round(mean, 2),
        "stddev": round(var ** 0.5, 2),
        "min": nonzero[0] if nonzero else 0,
        "max": nonzero[-1] if nonzero else 0,
        "w": img.width,
        "h": img.height,
    }


def looks_black(st):
    """整帧接近纯黑且无任何结构 -> 判定为「没抓到真实内容」。

    刻意用「无结构」而不只用「均值低」：企微整窗若恰好停在深色界面，
    均值也可能偏低，但 stddev 与 max 不会同时塌到接近 0。
    """
    return st["max"] < 24 and st["stddev"] < 8


def similarity(img_a, img_b, tol=24):
    """两图逐像素差异占比（0=完全一致，1=完全不同）。尺寸不同则返回 None。"""
    from PIL import ImageChops

    if img_a.size != img_b.size:
        return None
    diff = ImageChops.difference(img_a.convert("RGB"), img_b.convert("RGB")).convert("L")
    # 容差内视为「相同」——抗锯齿、焦点框闪烁、时钟跳动都会造成少量像素差
    hist = diff.point(lambda v: 0 if v < tol else 1).histogram()
    total = sum(hist)
    if total == 0:
        return 0.0
    return round(hist[1] / total, 4)


# ==================================================================== 遮挡窗


def make_occluder():
    """造一个铺满虚拟屏幕的纯黑置顶窗口，用来模拟「别的程序盖住企微」。

    重点不是美观，而是**确定性**：纯黑意味着任何抓屏幕像素的方案必然拍到它，
    因此 pyautogui 在此场景下的结果是可以事先预言的（= 全黑）。
    """
    import tkinter as tk

    try:
        import win32api
        vx, vy, vw, vh = win32api.GetSystemMetrics(76), win32api.GetSystemMetrics(77), \
            win32api.GetSystemMetrics(78), win32api.GetSystemMetrics(79)
    except Exception:
        vx, vy, vw, vh = 0, 0, 1920, 1080

    root = tk.Tk()
    root.overrideredirect(True)
    root.attributes("-topmost", True)
    root.geometry(f"{vw}x{vh}+{vx}+{vy}")
    root.configure(bg="#000000")
    tk.Label(root, text="", bg="#000000").pack(fill="both", expand=True)
    # 反复 update 直到窗口真正被合成，否则遮挡可能还没生效就开截
    for _ in range(6):
        root.update()
        time.sleep(0.08)
    return root


# ==================================================================== 子进程：抓一帧


def child_capture(name):
    """执行单个场景，产出 {name}.json + {name}.png，然后还原窗口。"""
    from PIL import Image

    backend = "wgc" if name.startswith("wgc") else "pyautogui"
    occluded = name.endswith("occluded")
    offscreen = "offscreen" in name
    minimized = "minimized" in name
    freshness = "freshness" in name

    result = {
        "scenario": name,
        "backend": backend,
        "ok": False,
        "png": None,
        "error": None,
        "elapsed_ms": 0,
        "stats": None,
        "window": None,
        "wecom": None,
    }

    hwnd = get_wecom_hwnd()
    if not hwnd:
        result["error"] = "找不到企业微信窗口（get_wecom_hwnd 返回 None）"
        write_result(name, result)
        return 1

    import win32con
    import win32gui

    placement = save_placement(hwnd)
    original_rect = list(win32gui.GetWindowRect(hwnd))
    result["wecom"] = {
        "hwnd": hwnd,
        "cls": win32gui.GetClassName(hwnd),
        "title": win32gui.GetWindowText(hwnd),
        "rect_before": original_rect,
    }

    occluder = None
    t0 = time.time()
    try:
        # ---- 布置场景 ----
        if minimized:
            win32gui.ShowWindow(hwnd, win32con.SW_MINIMIZE)
            time.sleep(0.6)

        if offscreen:
            # 先解除最大化，否则 SetWindowPos 会被系统的最大化态吞掉。
            # 期望尺寸必须取 SW_RESTORE **之后**的 rect —— 若窗口原本是最大化，
            # original_rect 是最大化尺寸，拿它比对会误报「出屏被裁」。
            if _is_zoomed(hwnd):
                win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
                time.sleep(0.3)
            left, top, w, h = win32gui.GetWindowRect(hwnd)
            win32gui.SetWindowPos(hwnd, 0, left - (w // 2), top, w, h, 0x0004)  # SWP_NOZORDER
            time.sleep(0.5)
            after = list(win32gui.GetWindowRect(hwnd))
            result["window"] = {
                "rect_before_move": [left, top, w, h],
                "rect_after": after,
                "expected_size": [w, h],
                "onscreen_width": after[0] + after[2],
            }

        if occluded:
            occluder = make_occluder()

        # ---- 抓帧 ----
        png_path = os.path.join(OUT_DIR, name + ".png")

        if freshness:
            # 决定性实验：wgc-minimized 拿到了与 wgc-visible **逐字节相同**的旧帧，
            # 说明「建会话->等第一帧->停」这套用法可能返回过期画面。
            # 这里连拍两次，中途把窗口宽度砍掉 120px：
            #   第二帧宽度 == 新宽度  -> 几何变化能拿到新帧，用法可修
            #   第二帧宽度 == 旧宽度  -> WGC 在本场景下就是给旧帧，无法用于判定
            # 无副作用：只改窗口宽度，父进程会还原。
            left, top, w0, h0 = win32gui.GetWindowRect(hwnd)
            png_a = os.path.join(OUT_DIR, name + "_a.png")
            png_b = os.path.join(OUT_DIR, name + "_b.png")
            img_a = grab_via_wgc(hwnd, win32gui.GetWindowText(hwnd), png_a)
            time.sleep(0.3)
            w1 = max(400, w0 - 120)
            win32gui.SetWindowPos(hwnd, 0, left, top, w1, h0, 0x0004)  # SWP_NOZORDER
            time.sleep(0.7)
            img_b = grab_via_wgc(hwnd, win32gui.GetWindowText(hwnd), png_b)
            result["freshness"] = {
                "w_before": w0,
                "w_after": w1,
                "frame_a": [img_a.width, img_a.height] if img_a else None,
                "frame_b": [img_b.width, img_b.height] if img_b else None,
                "png_a": png_a if img_a else None,
                "png_b": png_b if img_b else None,
            }
            result["ok"] = bool(img_a and img_b)
            result["png"] = png_b if img_b else None
            if img_b:
                result["stats"] = frame_stats(img_b)
                result["black"] = looks_black(result["stats"])
            if not result["ok"]:
                result["error"] = f"连拍失败 a={result['freshness']['frame_a']} b={result['freshness']['frame_b']}"
        elif backend == "wgc":
            img = grab_via_wgc(hwnd, win32gui.GetWindowText(hwnd), png_path)
            result["elapsed_ms"] = int((time.time() - t0) * 1000)
            if img is None:
                result["error"] = "未取得图像（详见 stderr）"
            else:
                result["ok"] = True
                result["png"] = png_path
                result["stats"] = frame_stats(img)
                result["black"] = looks_black(result["stats"])
        else:
            img = grab_via_pyautogui(win32gui.GetWindowRect(hwnd), png_path)
            result["elapsed_ms"] = int((time.time() - t0) * 1000)
            if img is None:
                result["error"] = "未取得图像（详见 stderr）"
            else:
                result["ok"] = True
                result["png"] = png_path
                result["stats"] = frame_stats(img)
                result["black"] = looks_black(result["stats"])

        if not freshness:
            result["elapsed_ms"] = int((time.time() - t0) * 1000)
    except Exception as e:
        result["elapsed_ms"] = int((time.time() - t0) * 1000)
        result["error"] = f"{type(e).__name__}: {e}"
    finally:
        if occluder is not None:
            try:
                occluder.destroy()
            except Exception:
                pass
        # 子进程自己的兜底（父进程还有一道，见 run_parent）
        restore_placement(hwnd, placement)
        write_result(name, result)

    return 0


def grab_via_wgc(hwnd, window_title, png_path, retries=2):
    """用 windows-capture 按窗口标题抓一帧，存 PNG 后用 PIL 读回。

    注意：windows-capture 的 Python 接口只接受 window_name（窗口标题），
    不接受 hwnd。企微主窗口标题通常是稳定的，但这是个额外的不确定因素 ——
    若多个窗口同名，可能抓错。

    retries：真机上观察到「紧接上一个会话后创建新会话」会抛
    `Failed to initialize WinRT`。这里做退避重试，同时也说明本探针
    「每拍一次就 start/stop」的用法不是该库的推荐用法（推荐常驻会话）。
    """
    from PIL import Image

    try:
        from windows_capture import WindowsCapture
    except Exception as e:
        raise RuntimeError(
            "未安装 windows-capture。请先执行：pip install windows-capture  (%s)" % e
        )

    os.makedirs(OUT_DIR, exist_ok=True)
    title = (window_title or "").strip() or "企业微信"
    last_err = None

    for attempt in range(retries + 1):
        if attempt:
            time.sleep(0.8 * attempt)

        def on_frame_arrived(frame, capture_control):
            try:
                frame.save_as_image(png_path)
                capture_control.stop()
            except Exception as e:
                print(f"[wgc] save_as_image 失败: {e}", file=sys.stderr, flush=True)

        def on_closed():
            print("[wgc] 会话已关闭", file=sys.stderr, flush=True)

        capture = WindowsCapture(
            cursor_capture=None,
            draw_border=None,
            monitor_index=None,
            window_name=title,
        )
        capture.event(on_frame_arrived)
        capture.event(on_closed)
        try:
            capture.start()  # 阻塞直到 on_frame_arrived 里 stop()
        except Exception as e:
            last_err = e
            print(f"[wgc] 第 {attempt + 1} 次建会话失败: {e}", file=sys.stderr, flush=True)
            continue
        break

    else:
        if last_err is not None:
            raise last_err

    # save_as_image 的落盘与 start() 返回之间没有显式完成保证，0 字节时稍等一下
    for _ in range(10):
        if os.path.exists(png_path) and os.path.getsize(png_path) > 0:
            break
        time.sleep(0.1)

    if not os.path.exists(png_path):
        return None
    if os.path.getsize(png_path) == 0:
        print("[wgc] PNG 为 0 字节", file=sys.stderr, flush=True)
        return None
    return Image.open(png_path)


def grab_via_pyautogui(wecom_rect, png_path):
    """对照组：现有生产路径用的就是它，抓屏幕像素。"""
    import pyautogui
    from PIL import Image

    os.makedirs(OUT_DIR, exist_ok=True)
    left, top, right, bottom = wecom_rect
    img = pyautogui.screenshot(region=(left, top, right - left, bottom - top))
    img.save(png_path)
    return Image.open(png_path)


# ==================================================================== 父进程：编排与结论


def run_parent():
    say("=" * 74)
    say("  WGC 可行性探针")
    say("=" * 74)

    try:
        import win32gui  # noqa: F401
    except Exception:
        say("[错误] 缺少 pywin32。请在 Windows 上用项目环境运行：pip install pywin32")
        return 1

    hwnd = get_wecom_hwnd()
    if not hwnd:
        say("[错误] 找不到企业微信窗口。请确认企业微信已登录并已打开主界面。")
        return 1

    say(f"企微窗口: hwnd={hwnd}  class={win32gui.GetClassName(hwnd)!r}")
    say(f"窗口标题: {win32gui.GetWindowText(hwnd)!r}   <- windows-capture 按这个标题匹配")

    cands = list_wecom_candidates()
    if len(cands) > 1:
        say("")
        say(f"⚠️ 发现 {len(cands)} 个疑似企微窗口，探针取了第一个。若下列有多个，")
        say("   说明主程序的 get_wecom_hwnd() 也存在取错窗口的风险：")
        for c in cands:
            say(f"   hwnd={c['hwnd']} cls={c['cls']!r} title={c['title']!r} rect={c['rect']}")

    placement = save_placement(hwnd)
    orig_rect = list(win32gui.GetWindowRect(hwnd))
    say(f"当前 rect: {orig_rect}  (w={orig_rect[2]-orig_rect[0]} h={orig_rect[3]-orig_rect[1]})")

    os.makedirs(OUT_DIR, exist_ok=True)
    say("")
    say("开始执行场景（每个场景独立子进程，硬超时保护）...")
    say("-" * 74)

    results = {}
    for name in SCENARIOS:
        say(f"  -> {name} (timeout {SCENARIO_TIMEOUT[name]}s)", flush=True)
        stderr_tail = ""
        try:
            proc = subprocess.run(
                [sys.executable, os.path.abspath(__file__), "--child", name],
                timeout=SCENARIO_TIMEOUT[name],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            # WGC 的真实报错都在子进程 stderr 里，吞掉等于探针失去诊断意义
            stderr_tail = (proc.stderr or "").strip()
        except subprocess.TimeoutExpired:
            write_result(name, {"scenario": name, "ok": False, "error": "超时未返回", "timeout": True})
        except Exception as e:
            write_result(name, {"scenario": name, "ok": False, "error": f"子进程异常: {e}"})

        # 每个场景都可能把窗口最小化/移出屏，且被硬超时的子进程不会执行 finally。
        # 必须在下一个场景开始前先还原，否则后续场景拍到的是被污染的窗口
        # （例如 wgc-minimized 之后企微仍最小化，pyautogui 对照就作废了）。
        restore_placement(hwnd, placement)

        path = os.path.join(OUT_DIR, name + ".json")
        try:
            with open(path, encoding="utf-8") as f:
                results[name] = json.load(f)
        except Exception as e:
            results[name] = {"scenario": name, "ok": False, "error": f"结果文件不可读: {e}"}

        r = results[name]
        if r.get("ok"):
            st = r.get("stats") or {}
            flag = "  ⚠️ 整帧纯黑" if r.get("black") else ""
            say(
                f"     ok {st.get('w')}x{st.get('h')} "
                f"mean={st.get('mean')} std={st.get('stddev')} max={st.get('max')} "
                f"{r.get('elapsed_ms')}ms{flag}"
            )
        else:
            say(f"     失败: {r.get('error')}")
            if stderr_tail:
                for line in stderr_tail.splitlines()[-6:]:
                    say(f"       | {line}")

    # 无论子进程是否被硬杀，最后一定要把企微放回原位
    restore_placement(hwnd, placement)
    now_rect = list(win32gui.GetWindowRect(hwnd))
    say("")
    say(f"已还原企微窗口: {now_rect}  (原 {orig_rect})")

    report(results)
    return 0


def load_png(name):
    from PIL import Image

    r_path = os.path.join(OUT_DIR, name + ".png")
    if not os.path.exists(r_path):
        return None
    return Image.open(r_path)


def report(results):
    say("")
    say("=" * 74)
    say("  结论")
    say("=" * 74)

    def res(n):
        return results.get(n) or {}

    def ok(n):
        return bool(res(n).get("ok")) and not res(n).get("black")

    say("")
    say("【最重要的证据是 PNG，请务必亲自打开这几张看】")
    for n in SCENARIOS:
        p = os.path.join(OUT_DIR, n + ".png")
        say(f"  {'[有]' if os.path.exists(p) else '[无]'} {p}")

    say("")
    say("-" * 74)

    # 1) GO / NO-GO
    say("")
    say("1) WGC 能否抓到企微真实内容（go/no-go）")
    if not res("wgc-visible").get("ok"):
        say("   ✗ NO-GO：WGC 连一帧都没拿到 -> " + str(res("wgc-visible").get("error")))
        say("     结论：不要迁移，本轮保持 pyautogui 方案。")
    elif res("wgc-visible").get("black"):
        st = res("wgc-visible").get("stats") or {}
        say(f"   ✗ NO-GO：拿到帧但是纯黑 (mean={st.get('mean')} max={st.get('max')})。")
        say("     企微是 GPU 合成窗口，WGC 在它身上失效 —— 与 send_feedback.py:672")
        say("     「从托盘恢复的 GPU 合成窗口可能保持黑屏」记录的现象一致。")
        say("     结论：不要迁移。")
    else:
        st = res("wgc-visible").get("stats") or {}
        say(f"   ✓ GO：拿到真实内容 mean={st.get('mean')} max={st.get('max')} "
            f"std={st.get('stddev')}，{res('wgc-visible').get('elapsed_ms')}ms")

    # 2) 遮挡免疫
    say("")
    say("2) 遮挡免疫（WGC vs pyautogui，同一遮挡条件下）")
    a, b = load_png("wgc-visible"), load_png("wgc-occluded")
    if a and b:
        sim = similarity(a, b)
        if sim is None:
            say(f"   ? 尺寸不同，无法比较: {a.size} vs {b.size}")
        elif sim <= 0.10:
            say(f"   ✓ WGC 遮挡免疫成立：被黑窗完全盖住时与基准差异仅 {sim:.1%}")
        else:
            say(f"   ✗ WGC 遮挡下内容变了（差异 {sim:.1%}）—— 说明并非完全免疫")
    else:
        say("   ? WGC 两张图不全，无法判定")

    pa, pb = load_png("pyautogui-visible"), load_png("pyautogui-occluded")
    if pa and pb:
        sim = similarity(pa, pb)
        if sim is not None:
            if sim >= 0.70:
                say(f"   · pyautogui 在遮挡下差异 {sim:.1%} —— 与预期一致（拍到黑窗）")
                say("     这实证了「遮挡确实会毁掉现有截图」，自遮挡防护不是杞人忧天。")
            else:
                say(f"   ? pyautogui 在遮挡下差异仅 {sim:.1%} —— 意外地没被遮挡影响。")
                say("     若属实，说明现有截图对遮挡其实较鲁棒，迁移收益要重新评估。")
    else:
        say("   ? pyautogui 两张图不全（未装 pyautogui 也可能），跳过对照")

    # 3) 出屏免疫
    say("")
    say("3) 部分出屏免疫")
    wo = res("wgc-offscreen")
    winfo = wo.get("window") or {}
    exp = winfo.get("expected_size")
    st = wo.get("stats") or {}
    if wo.get("ok") and exp:
        if [st.get("w"), st.get("h")] == exp:
            say(f"   ✓ WGC 部分出屏仍拿到完整窗口 {exp}（出屏后屏幕内仅剩 {winfo.get('onscreen_width')}px 宽）")
        else:
            say(f"   ✗ WGC 出屏后尺寸被裁：拿到 {st.get('w')}x{st.get('h')}，期望 {exp}")
    else:
        say(f"   ? 未取得数据 ({wo.get('error')})")

    # 4) 为何仍然需要激活窗口
    say("")
    say("4) 最小化窗口")
    wm = res("wgc-minimized")
    if wm.get("ok") and not wm.get("black"):
        wv = load_png("wgc-visible")
        wmi = load_png("wgc-minimized")
        same = ""
        if wv and wmi:
            if os.path.getsize(os.path.join(OUT_DIR, "wgc-visible.png")) == os.path.getsize(
                os.path.join(OUT_DIR, "wgc-minimized.png")
            ):
                same = "（且与 wgc-visible 逐字节相同 -> 确认是缓存旧帧）"
        say(f"   ! 最小化后竟拿到帧，而非「拿不到」{same}")
        say("     这比预期严重：WGC 没有如实报告「窗口不可见」，而是交出一张")
        say("     过期的真实画面。对本项目而言这是最危险的失败模式 —— 不会报错，")
        say("     会拿旧画面去做身份判定，且日志里看不出异常。")
    elif not wm.get("ok"):
        say(f"   ✓ 最小化后拿不到帧（{wm.get('error')}）—— 符合预期")
        say("     这证明 find_and_activate_wecom() 必须保留：")
        say("     键盘输入必须发给前台窗口，且 WGC 无法替代激活。")
    else:
        say("   ? 最小化后拿到纯黑帧")

    # 5) 帧新鲜度 —— 决定 WGC 到底能不能用于判定
    say("")
    say("5) 帧新鲜度（决定性）")
    fr = res("wgc-freshness")
    info = fr.get("freshness") or {}
    fa, fb = info.get("frame_a"), info.get("frame_b")
    if not (fa and fb):
        say(f"   ? 连拍失败 {fr.get('error')}")
    elif fb[0] == info.get("w_after"):
        say(f"   ✓ 改了窗口宽度后拿到的是新尺寸：{fa} -> {fb}（新宽 {info.get('w_after')}）")
        say("     说明几何变化能拿到新帧，「逐拍 start/stop」的旧帧问题可通过")
        say("     补一个「确认内容已更新」的等待机制来规避。")
    elif fb[0] == info.get("w_before"):
        say(f"   ✗ 窗口已改成宽 {info.get('w_after')}，拿到的却仍是旧宽 {fb[0]}（{fa} -> {fb}）")
        say("     即「等到第一帧就返回」拿到的是旧画面。")
        say("     结论：WGC 不能用于本项目的身份判定，除非改用常驻会话 + 内容变更检测。")
    else:
        say(f"   ? 尺寸既非新宽也非旧宽：{fa} -> {fb}（新宽 {info.get('w_after')}）")

    if info.get("png_a") and info.get("png_b"):
        say(f"     帧 A: {info['png_a']}")
        say(f"     帧 B: {info['png_b']}")

    say("")
    say("-" * 74)
    say("提醒：本探针只回答「能不能抓到」，没有回答下面两个同样关键的问题：")
    say("  a) 异步帧会不会拍到按键生效前的旧画面 —— 见上面第 4/5 项")
    say("  b) windows-capture 按窗口标题匹配，不是 hwnd；且是编译扩展，")
    say("     PyInstaller 打包是第二个风险点（项目已有 RapidOCR 打包失败的先例）")
    say("=" * 74)


# ==================================================================== 入口


def main():
    if "--list" in sys.argv:
        say("将执行的场景：")
        for n in SCENARIOS:
            say(f"  {n}  (timeout {SCENARIO_TIMEOUT[n]}s)")
        return 0

    if "--child" in sys.argv:
        return child_capture(sys.argv[sys.argv.index("--child") + 1])

    return run_parent()


if __name__ == "__main__":
    sys.exit(main())
