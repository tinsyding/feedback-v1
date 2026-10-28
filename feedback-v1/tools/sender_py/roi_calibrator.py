"""ROI 校准 UI（阶段 4）：模态框，只许两框，chat 绿虚线只读预览。

tkinter 只在 run_calibration 内导入；坐标映射/门槛校验是纯函数，Linux 可单测。
"""

try:  # 仓库结构（…/tools 下运行）优先；散装拷贝（文件同目录）兜底
    from sender_py.roi_manager import derive_chat, to_abs, to_rel, validate_rel
except ModuleNotFoundError:
    from roi_manager import derive_chat, to_abs, to_rel, validate_rel

TITLE_COLOR = "#3B82F6"
INPUT_COLOR = "#EF4444"
CHAT_COLOR = "#22C55E"
GUIDE_TEXT = "先框标题栏（蓝），再框底部输入框（红），中间聊天区自动算出"
EXAMPLE_MAX_W = 360


def fit_scale(W, H, Dw, Dh):
    """Fit 缩放：s=min(Dw/W,Dh/H)，居中偏移 ox,oy。返回 (s, ox, oy, dw, dh)。"""
    s = min(Dw / W, Dh / H)
    dw, dh = W * s, H * s
    return (s, (Dw - dw) / 2, (Dh - dh) / 2, dw, dh)


def canvas_to_orig(cx, cy, s, ox, oy):
    """显示坐标 → 原图坐标，四舍五入。rel 只用原图坐标算。"""
    return (int(round((cx - ox) / s)), int(round((cy - oy) / s)))


def orig_to_canvas(x, y, s, ox, oy):
    """原图坐标 → 显示坐标。"""
    return (ox + x * s, oy + y * s)


def validate_boxes(title_abs, input_abs, img_size):
    """确认门槛：两框非空且在图内、原图尺度宽≥40高≥20、input 在 title 之下、chat.h≥40。

    返回 (ok, reason)；非法时 reason 即阻止文案（含怎么重框）。
    """
    W, H = img_size
    for name, box in (("标题栏", title_abs), ("输入框", input_abs)):
        try:
            x, y, w, h = (int(round(v)) for v in box)
        except Exception:
            return (False, f"{name}还没框好：在图上按住左键拖出矩形。")
        if w <= 0 or h <= 0:
            return (False, f"{name}还没框好：在图上按住左键拖出矩形。")
        if x < 0 or y < 0 or x + w > W or y + h > H:
            return (False, f"{name}超出截图范围：请把框完全放在企微窗口图内。")
        if w < 40 or h < 20:
            return (False, f"{name}太小（原图尺度宽≥40且高≥20）：请贴边框足。")
    try:
        derive_chat(title_abs, input_abs, img_size)
    except ValueError as e:
        return (False, str(e))
    return (True, "OK")


def _load_example_photo(tk, max_w=EXAMPLE_MAX_W):
    """加载 example.png 等比缩到宽≤max_w；源码与 onefile 都能找到。"""
    import os
    import sys

    here = os.path.dirname(os.path.abspath(__file__))
    candidates = []
    base = getattr(sys, "_MEIPASS", None)
    if base:
        candidates.append(os.path.join(base, "example.png"))
    exe_dir = os.path.dirname(os.path.abspath(sys.executable))
    candidates.append(os.path.join(exe_dir, "example.png"))
    candidates.extend((os.path.join(here, "..", "example.png"),
                       os.path.join(here, "example.png")))
    path = next((p for p in candidates if os.path.isfile(p)), None)
    if path is None:
        return None
    try:
        from PIL import Image, ImageTk
        img = Image.open(path).convert("RGB")
        if img.size[0] > max_w:
            img = img.resize((max_w, int(round(img.size[1] * max_w / img.size[0]))))
        return ImageTk.PhotoImage(img)
    except Exception:
        return None


def run_calibration(parent, base_image, example_max_w=EXAMPLE_MAX_W, initial_roi=None):
    """模态校准：先展示 example.png 指引 → 点确认进 Canvas → 阻塞到确认/放弃。

    parent 为 None 时自建 Tk 主窗口（任务栏有图标，最稳）；传入父窗口时用模态 Toplevel。
    返回 {"title": rel, "input": rel, "chat": rel} 或 None（放弃）。
    """
    import sys
    import tkinter as tk
    from tkinter import ttk
    try:
        import sv_ttk
    except Exception:
        sv_ttk = None

    if base_image is None:
        raise ValueError("实拍图为空，无法校准：请先确认企微窗口能被截到。")
    W, H = base_image.size
    result = {"roi": None}

    if parent is None:
        win = tk.Tk()
        own_root = True
    else:
        win = tk.Toplevel(parent)
        own_root = False
        try:
            win.transient(parent)
        except Exception:
            pass
    using_sv_ttk = False
    if sv_ttk is not None:
        try:
            sv_ttk.set_theme("light")
            using_sv_ttk = True
        except Exception:
            pass
    accent_style = "Accent.TButton" if using_sv_ttk else "TButton"
    win.title("企业微信窗口校准：框标题栏 + 输入框")

    sw = win.winfo_screenwidth()
    sh = win.winfo_screenheight()

    def _center_win(w, h):
        try:
            win.update_idletasks()
            cx = max(10, (sw - int(w)) // 2)
            cy = max(10, (sh - int(h)) // 2)
            win.geometry(f"{int(w)}x{int(h)}+{cx}+{cy}")
        except Exception:
            pass

    try:
        win.deiconify()
        win.lift()
        win.attributes("-topmost", True)
        win.after(1500, lambda: win.attributes("-topmost", False))
        win.focus_force()
    except Exception:
        pass
    try:
        win.grab_set()
    except Exception:
        pass

    style = ttk.Style(win)
    family = "Microsoft YaHei UI" if sys.platform == "win32" else "Arial"
    try:
        style.configure("CalTitle.TLabel", font=(family, 18, "bold"))
        style.configure("CalSection.TLabel", font=(family, 11, "bold"))
        style.configure("CalHint.TLabel", foreground="#6b7280", font=(family, 9))
    except Exception:
        pass

    guide = ttk.Frame(win, padding=20)
    guide.pack(fill="both", expand=True)
    ttk.Label(guide, text="企业微信窗口校准", style="CalTitle.TLabel").pack(anchor="w")
    ttk.Label(guide, text=GUIDE_TEXT, style="CalSection.TLabel").pack(anchor="w", pady=(4, 4))
    ttk.Label(guide, text="💡 提示：若右侧展开了「查找聊天记录」或「学员详情侧边栏」，框选右侧止于聊天区分界线即可（不要包含右侧面板）。",
              style="CalHint.TLabel").pack(anchor="w", pady=(0, 10))
    photo = _load_example_photo(tk, example_max_w)
    if photo is not None:
        lbl = ttk.Label(guide, image=photo)
        lbl.image = photo  # PhotoImage 引用保持
        lbl.pack()
    else:
        ttk.Label(guide, text="(未找到 example.png，以实拍为准框两框)",
                  style="CalHint.TLabel").pack()
    ttk.Button(guide, text="知道了，开始框选", style=accent_style,
               command=guide.destroy).pack(pady=(16, 0))

    _center_win(580, 540)

    win.wait_window(guide)
    if result["roi"] is not None:  # 不可能分支，保持形状
        return result["roi"]

    # 动态适应屏幕分辨率（占据约 82%~86% 视野，大而清晰，杜绝过小）
    DISP_W = max(1020, min(1440, int(sw * 0.85)))
    DISP_H = max(660, min(920, int(sh * 0.80)))
    s, ox, oy, _, _ = fit_scale(W, H, DISP_W, DISP_H)

    body = ttk.Frame(win, padding=12)
    body.pack(fill="both", expand=True)
    status = tk.StringVar(value="先拖出标题栏（蓝），再拖出输入框（红）")
    ttk.Label(body, textvariable=status, foreground="#B45309", font=(family, 10, "bold")).pack(pady=(0, 6))
    canvas = tk.Canvas(body, width=DISP_W, height=DISP_H, bg="#111827", highlightthickness=1)
    canvas.pack()

    _center_win(DISP_W + 36, DISP_H + 115)

    try:
        from PIL import ImageTk
        disp = base_image.resize((max(1, int(round(W * s))), max(1, int(round(H * s)))))
        tk_img = ImageTk.PhotoImage(disp)
        canvas.create_image(ox, oy, anchor="nw", image=tk_img)
        canvas.image = tk_img  # PhotoImage 引用保持
    except Exception as e:
        status.set(f"实拍图显示失败：{e}")
        tk_img = None

    state = {"title": None, "input": None, "drag": None, "mode": "title"}

    def _norm(a, b):
        return (min(a[0], b[0]), min(a[1], b[1]), abs(a[0] - b[0]), abs(a[1] - b[1]))

    def _to_orig_rect(canvas_rect):
        x, y, w, h = canvas_rect
        x0, y0 = canvas_to_orig(x, y, s, ox, oy)
        x1, y1 = canvas_to_orig(x + w, y + h, s, ox, oy)
        return (x0, y0, x1 - x0, y1 - y0)

    def _redraw():
        canvas.delete("box")
        for key, color in (("title", TITLE_COLOR), ("input", INPUT_COLOR)):
            r = state[key]
            if not r:
                continue
            x, y, w, h = r
            canvas.create_rectangle(x, y, x + w, y + h, outline=color, width=2, tags="box")
            for hx, hy in ((x, y), (x + w / 2, y), (x + w, y), (x, y + h / 2),
                           (x + w, y + h / 2), (x, y + h), (x + w / 2, y + h), (x + w, y + h)):
                canvas.create_rectangle(hx - 4, hy - 4, hx + 4, hy + 4,
                                        fill=color, outline="white", tags="box")
        if state["title"] and state["input"]:
            try:
                chat = derive_chat(_to_orig_rect(state["title"]), _to_orig_rect(state["input"]), (W, H))
                cx0, cy0 = orig_to_canvas(chat[0], chat[1], s, ox, oy)
                cx1, cy1 = orig_to_canvas(chat[0] + chat[2], chat[1] + chat[3], s, ox, oy)
                canvas.create_rectangle(cx0, cy0, cx1, cy1, outline=CHAT_COLOR,
                                        width=2, dash=(6, 4), tags="box")
                ok, msg = validate_boxes(_to_orig_rect(state["title"]),
                                         _to_orig_rect(state["input"]), (W, H))
                status.set("✓ 可确认保存" if ok else msg)
            except ValueError as e:
                status.set(str(e))

    if initial_roi and isinstance(initial_roi, dict) and "title" in initial_roi and "input" in initial_roi:
        try:
            t_box = to_abs(initial_roi["title"], (W, H))
            i_box = to_abs(initial_roi["input"], (W, H))
            tx0, ty0 = orig_to_canvas(t_box[0], t_box[1], s, ox, oy)
            tx1, ty1 = orig_to_canvas(t_box[0] + t_box[2], t_box[1] + t_box[3], s, ox, oy)
            ix0, iy0 = orig_to_canvas(i_box[0], i_box[1], s, ox, oy)
            ix1, iy1 = orig_to_canvas(i_box[0] + i_box[2], i_box[1] + i_box[3], s, ox, oy)
            state["title"] = (min(tx0, tx1), min(ty0, ty1), abs(tx1 - tx0), abs(ty1 - ty0))
            state["input"] = (min(ix0, ix1), min(iy0, iy1), abs(ix1 - ix0), abs(iy1 - iy0))
            _redraw()
            status.set("💡 已预填推荐框选，请核对；确认无误可直接保存，也可拖动调整。")
        except Exception:
            pass

    def _hit_handle(r, px, py):
        x, y, w, h = r
        for hx, hy, anchor in ((x, y, "nw"), (x + w, y + h, "se"), (x + w, y, "ne"), (x, y + h, "sw"),
                              (x + w / 2, y, "n"), (x + w / 2, y + h, "s"),
                              (x, y + h / 2, "w"), (x + w, y + h / 2, "e")):
            if abs(px - hx) <= 6 and abs(py - hy) <= 6:
                return anchor
        return None

    def _hit_box(r, px, py):
        x, y, w, h = r
        return x <= px <= x + w and y <= py <= y + h

    def on_press(ev):
        for key in ("input", "title"):
            r = state[key]
            if r and _hit_handle(r, ev.x, ev.y):
                state["drag"] = (key, "handle", _hit_handle(r, ev.x, ev.y), (ev.x, ev.y), tuple(r))
                return
        for key in ("input", "title"):
            r = state[key]
            if r and _hit_box(r, ev.x, ev.y):
                state["drag"] = (key, "move", None, (ev.x, ev.y), tuple(r))
                return
        target = "title" if state["title"] is None else ("input" if state["input"] is None else state["mode"])
        state["mode"] = target
        state["drag"] = (target, "new", None, (ev.x, ev.y), None)

    def on_move(ev):
        d = state["drag"]
        if not d:
            return
        key, kind, anchor, start, orig = d
        sx, sy = start
        if kind == "new":
            state[key] = _norm((sx, sy), (ev.x, ev.y))
        elif kind == "move":
            dx, dy = ev.x - sx, ev.y - sy
            x, y, w, h = orig
            state[key] = (x + dx, y + dy, w, h)
        elif kind == "handle":
            x, y, w, h = orig
            x0, y0, x1, y1 = x, y, x + w, y + h
            if "w" in anchor:
                x0 = ev.x
            if "e" in anchor:
                x1 = ev.x
            if "n" in anchor:
                y0 = ev.y
            if "s" in anchor:
                y1 = ev.y
            state[key] = (min(x0, x1), min(y0, y1), abs(x1 - x0), abs(y1 - y0))
        _redraw()

    def on_release(_ev):
        state["drag"] = None
        _redraw()

    canvas.bind("<Button-1>", on_press)
    canvas.bind("<B1-Motion>", on_move)
    canvas.bind("<ButtonRelease-1>", on_release)

    btns = ttk.Frame(body)
    btns.pack(pady=(10, 0))

    def do_reset():
        state["title"] = None
        state["input"] = None
        state["mode"] = "title"
        status.set("先拖出标题栏（蓝），再拖出输入框（红）")
        _redraw()

    def do_abort():
        result["roi"] = None
        win.destroy()

    def do_ok():
        if state["title"] is None or state["input"] is None:
            status.set("两框都要框：在图上先拖标题栏，再拖输入框。")
            return
        t_abs = _to_orig_rect(state["title"])
        i_abs = _to_orig_rect(state["input"])
        ok, msg = validate_boxes(t_abs, i_abs, (W, H))
        if not ok:
            status.set(msg)
            return
        try:
            chat_abs = derive_chat(t_abs, i_abs, (W, H))
        except ValueError as e:
            status.set(str(e))
            return
        t_rel, i_rel, c_rel = to_rel(t_abs, (W, H)), to_rel(i_abs, (W, H)), to_rel(chat_abs, (W, H))
        if not all(validate_rel(r) for r in (t_rel, i_rel, c_rel)):
            status.set("换算相对比例越界：请把两框完全放在图内后重试。")
            return
        result["roi"] = {"title": t_rel, "input": i_rel, "chat": c_rel}
        win.destroy()

    ttk.Button(btns, text="重置", command=do_reset).pack(side="left", padx=6)
    ttk.Button(btns, text="放弃", command=do_abort).pack(side="left", padx=6)
    ttk.Button(btns, text="确认并保存", style=accent_style,
               command=do_ok).pack(side="left", padx=6)

    win.wait_window(win)  # 阻塞到确认/放弃
    return result["roi"]
