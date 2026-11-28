"""极方每周反馈程序 (Web版) · 桌面伴随控制台 (Tkinter Companion Window)。

背景与作用：
  Web 版的主前端界面运行于默认浏览器中。当打包为无控制台模式（--windows-console-mode=disable）
  或在后台运行时，若用户在浏览器中直接关闭了标签页或浏览器窗口（未点击页面中的退出按钮），
  后台 Python 服务仍会默默常驻，导致用户难以感知或完全关闭。

  本桌面伴随微型控制台常驻于桌面与任务栏：
  1. 显著展示程序当前服务状态、端口、加载的文件数与发送统计；
  2. 提供「打开/重新打开浏览器界面」大按钮，方便误关浏览器时一键恢复前端页面；
  3. 提供「添加反馈文件」与「紧急停止发送」捷径；
  4. 当用户点击右上角 [X] 或「退出程序」按钮时，联动关闭本地 HTTP 服务、终止发送线程并彻底退出进程；
  5. 在无图形界面的无头环境（如 Linux CI）下自动安全回退，不影响纯命令行运行。
"""

import os
import sys
import webbrowser


def app_icon_path():
    """获取程序图标 favicon.ico 路径。"""
    try:
        try:
            from sender_py.sender import asset_path
        except ModuleNotFoundError:
            from sender import asset_path
        path = asset_path("favicon.ico")
        return path if os.path.isfile(path) else None
    except Exception:
        return None


def apply_window_icon(root, ico_path=None):
    """为 Tk 窗口设置应用程序图标（标题栏与任务栏图标），确保任务栏显示公司 Logo 而非默认羽毛/叶子。

    多重适配保障：
      1. 确保已设置进程级 AppUserModelID（Windows 任务栏识别独立应用的关键）；
      2. 优先通过 PIL 加载并调用 root.iconphoto(True, photo)（对各种尺寸 ico/png 兼容性最佳，直接更新任务栏大图标）；
      3. Windows 原生 root.iconbitmap(default=ico) 设置缺省图标；
      4. Windows Win32 API 终极兜底：直接向顶层窗口句柄发送 WM_SETICON (ICON_BIG & ICON_SMALL)；
      5. 返回 PhotoImage 强引用，调用方需挂载在实例上防止被 Python GC 回收导致图标失效。
    """
    if not ico_path:
        ico_path = app_icon_path()
    if not ico_path or not os.path.isfile(ico_path):
        return None

    # 1. 设置进程级 AppUserModelID
    try:
        try:
            from sender_py.window_utils import set_app_user_model_id
        except ModuleNotFoundError:
            from window_utils import set_app_user_model_id
        set_app_user_model_id()
    except Exception:
        pass

    photo_ref = None

    # 2. PIL + root.iconphoto (Windows / Linux 均通用，最稳妥的任务栏大图标设置机制)
    try:
        from PIL import Image, ImageTk
        with Image.open(ico_path) as im:
            rgba = im.convert("RGBA")
            photo_ref = ImageTk.PhotoImage(rgba, master=root)
            if hasattr(root, "iconphoto"):
                root.iconphoto(True, photo_ref)
    except Exception:
        pass

    # 3. 原生 iconbitmap 兜底
    try:
        if hasattr(root, "iconbitmap"):
            try:
                root.iconbitmap(default=ico_path)
            except Exception:
                root.iconbitmap(ico_path)
    except Exception:
        pass

    # 4. Windows Win32 API 终极兜底：向 OS 顶层窗口发送 WM_SETICON 消息
    if sys.platform.startswith("win"):
        try:
            import ctypes
            if hasattr(root, "update_idletasks") and hasattr(root, "winfo_id"):
                root.update_idletasks()
                client_hwnd = root.winfo_id()
                user32 = ctypes.windll.user32
                parent_hwnd = user32.GetParent(client_hwnd)
                target_hwnds = [h for h in (parent_hwnd, client_hwnd) if h]

                # LR_LOADFROMFILE = 0x0010; IMAGE_ICON = 1; WM_SETICON = 0x0080
                # 任务栏使用 ICON_BIG (1)，标题栏使用 ICON_SMALL (0)
                hicon_big = user32.LoadImageW(None, os.path.abspath(ico_path), 1, 32, 32, 0x0010)
                hicon_small = user32.LoadImageW(None, os.path.abspath(ico_path), 1, 16, 16, 0x0010)

                for hwnd in target_hwnds:
                    if hicon_big:
                        user32.SendMessageW(hwnd, 0x0080, 1, hicon_big)
                    if hicon_small:
                        user32.SendMessageW(hwnd, 0x0080, 0, hicon_small)
        except Exception:
            pass

    return photo_ref


def compute_side_hud_geometry(
    wecom_rect,
    work_rect,
    hud_w: int = 276,
    hud_h: int = 236,
    margin: int = 12,
    min_w: int = 196,
) -> tuple:
    """纯函数：计算侧边进度浮窗的几何位置 (x, y, w, h)，紧贴企微窗口旁侧且不遮挡企微。

    优先级：
      1. 企微右侧有足够空间（≥ hud_w）→ 停靠在企微右侧；
      2. 企微左侧有足够空间（≥ hud_w）→ 停靠在企微左侧；
      3. 两侧空间不足 hud_w 但较宽一侧 ≥ min_w → 窄幅贴靠在该侧且不重叠企微；
      4. 极窄屏（企微几乎占满全宽）→ 退避至工作区右上角。
    """
    wl, wt, ww_work, wh_work = (int(v) for v in work_rect)
    work_r = wl + max(1, ww_work)
    work_b = wt + max(1, wh_work)
    actual_h = min(int(hud_h), max(120, wh_work - 2 * margin))

    if not wecom_rect or len(wecom_rect) < 4:
        actual_w = min(int(hud_w), max(min_w, ww_work - 2 * margin))
        return (work_r - actual_w - margin, wt + margin, actual_w, actual_h)

    wx, wy, ww, _wh = (int(v) for v in wecom_rect[:4])
    right_avail = work_r - (wx + ww) - margin
    left_avail = (wx - wl) - margin

    if right_avail >= hud_w:
        actual_w = int(hud_w)
        x = wx + ww + margin
    elif left_avail >= hud_w:
        actual_w = int(hud_w)
        x = wx - margin - actual_w
    elif max(right_avail, left_avail) >= min_w:
        if right_avail >= left_avail:
            actual_w = min(int(hud_w), max(min_w, right_avail - 2))
            x = wx + ww + margin
        else:
            actual_w = min(int(hud_w), max(min_w, left_avail - 2))
            x = wx - margin - actual_w
    else:
        actual_w = min(int(hud_w), max(min_w, ww_work - 2 * margin))
        x = work_r - actual_w - margin

    max_y = max(wt + margin, work_b - actual_h - margin)
    y = min(max(wy, wt + margin), max_y)
    return (int(x), int(y), int(actual_w), int(actual_h))


class FloatingProgressHUD:
    """发送期间紧贴企微窗口旁侧的置顶进度浮窗（不抢焦点、不遮挡企微画面）。"""

    def __init__(self, master, on_stop=None):
        self.master = master
        self.on_stop = on_stop
        self.win = None
        self._visible = False
        self._dismissed = False
        self._user_moved = False
        self._last_geom = None
        self._auto_hide_after_id = None
        self._drag_offset = None

    def _cancel_auto_hide(self):
        if self._auto_hide_after_id is not None and self.master is not None:
            try:
                self.master.after_cancel(self._auto_hide_after_id)
            except Exception:
                pass
            self._auto_hide_after_id = None

    def _get_scale_and_rects(self):
        try:
            try:
                from sender_py import window_utils as wu
            except ModuleNotFoundError:
                import window_utils as wu
            hwnd = wu.get_wecom_hwnd()
            wecom_rect = wu.get_wecom_rect()
            work_rect = wu.get_monitor_work_rect(hwnd)
            scale = wu.get_dpi_scale(hwnd) if hwnd else wu.get_dpi_scale()
        except Exception:
            wecom_rect, work_rect, scale = None, None, 1.0

        if not isinstance(scale, (int, float)) or scale <= 0:
            scale = 1.0
        if not work_rect:
            try:
                sw = self.master.winfo_screenwidth()
                sh = self.master.winfo_screenheight()
                if isinstance(sw, (int, float)) and isinstance(sh, (int, float)) and sw > 100 and sh > 100:
                    work_rect = (0, 0, int(sw), int(sh))
            except Exception:
                pass
        if not work_rect:
            work_rect = (0, 0, 1920, 1040)
        return scale, wecom_rect, work_rect

    def _ensure_window(self):
        if self.win is not None:
            try:
                if self.win.winfo_exists():
                    return True
            except Exception:
                self.win = None

        import tkinter as tk
        from tkinter import ttk

        win = tk.Toplevel(self.master)
        win.withdraw()
        try:
            win.overrideredirect(True)
        except Exception:
            pass
        try:
            win.attributes("-topmost", True)
        except Exception:
            pass
        win.configure(bg="#cbd5e1")

        outer = tk.Frame(win, bg="#ffffff", bd=0, highlightthickness=0)
        outer.pack(fill="both", expand=True, padx=1, pady=1)

        header = tk.Frame(outer, bg="#0f172a", padx=10, pady=6, cursor="fleur")
        header.pack(fill="x")

        title_lbl = tk.Label(
            header, text="📊 极方反馈 · 发送进度",
            font=("Microsoft YaHei", 9, "bold"), fg="#f8fafc", bg="#0f172a", anchor="w",
        )
        title_lbl.pack(side="left", fill="x", expand=True)

        close_lbl = tk.Label(
            header, text="×", font=("Microsoft YaHei", 11, "bold"),
            fg="#94a3b8", bg="#0f172a", padx=4, cursor="hand2",
        )
        close_lbl.pack(side="right")
        close_lbl.bind("<Button-1>", lambda _e: self.dismiss())

        def _on_drag_start(ev):
            try:
                self._drag_offset = (ev.x_root - win.winfo_x(), ev.y_root - win.winfo_y())
            except Exception:
                self._drag_offset = None

        def _on_drag_move(ev):
            if not self._drag_offset:
                return
            try:
                self._user_moved = True
                nx = int(ev.x_root - self._drag_offset[0])
                ny = int(ev.y_root - self._drag_offset[1])
                win.geometry(f"+{nx}+{ny}")
            except Exception:
                pass

        for w_drag in (header, title_lbl):
            w_drag.bind("<ButtonPress-1>", _on_drag_start)
            w_drag.bind("<B1-Motion>", _on_drag_move)

        body = tk.Frame(outer, bg="#ffffff", padx=12, pady=10)
        body.pack(fill="both", expand=True)

        top_row = tk.Frame(body, bg="#ffffff")
        top_row.pack(fill="x", pady=(0, 6))

        self._badge_lbl = tk.Label(
            top_row, text="准备中", font=("Microsoft YaHei", 8, "bold"),
            fg="#1d4ed8", bg="#dbeafe", padx=6, pady=2,
        )
        self._badge_lbl.pack(side="left")

        self._pct_lbl = tk.Label(
            top_row, text="0/0 (0%)", font=("Microsoft YaHei", 9, "bold"),
            fg="#0f172a", bg="#ffffff",
        )
        self._pct_lbl.pack(side="right")

        self._pbar = ttk.Progressbar(body, mode="determinate", maximum=100, value=0)
        self._pbar.pack(fill="x", pady=(0, 8))

        self._current_lbl = tk.Label(
            body, text="当前学员：等待开始...", font=("Microsoft YaHei", 9, "bold"),
            fg="#1e293b", bg="#ffffff", anchor="w",
        )
        self._current_lbl.pack(fill="x", pady=(0, 4))

        self._step_lbl = tk.Label(
            body, text="正在准备发送任务...", font=("Microsoft YaHei", 8),
            fg="#475569", bg="#ffffff", anchor="w", justify="left", wraplength=240,
        )
        self._step_lbl.pack(fill="x", pady=(0, 8))

        self._stats_lbl = tk.Label(
            body, text="成功 0 · 失败 0 · 未匹配 0 · 拦截 0", font=("Microsoft YaHei", 8),
            fg="#64748b", bg="#f8fafc", padx=6, pady=4, anchor="w",
        )
        self._stats_lbl.pack(fill="x", pady=(0, 8))

        self._action_btn = tk.Button(
            body, text="⏹ 停止发送 (Esc)", font=("Microsoft YaHei", 9, "bold"),
            bg="#fee2e2", fg="#dc2626", activebackground="#fecaca", activeforeground="#b91c1c",
            relief="flat", cursor="hand2", pady=4, command=self._handle_action_click,
        )
        self._action_btn.pack(fill="x")

        self.win = win
        return True

    def _handle_action_click(self):
        if getattr(self, "_is_running_state", False):
            if callable(self.on_stop):
                try:
                    self._action_btn.config(state="disabled", text="正在停止...")
                except Exception:
                    pass
                self.on_stop()
        else:
            self.dismiss()

    def _apply_geometry(self, force_show: bool = False):
        if self.win is None:
            return
        scale, wecom_rect, work_rect = self._get_scale_and_rects()
        hud_w = int(round(276 * scale))
        hud_h = int(round(238 * scale))
        margin = int(round(12 * scale))
        min_w = int(round(196 * scale))
        x, y, w, h = compute_side_hud_geometry(
            wecom_rect, work_rect, hud_w=hud_w, hud_h=hud_h, margin=margin, min_w=min_w,
        )
        try:
            self._step_lbl.config(wraplength=max(150, w - int(round(28 * scale))))
        except Exception:
            pass
        if not self._user_moved:
            geom = (x, y, w, h)
            if geom != self._last_geom:
                self._last_geom = geom
                try:
                    self.win.geometry(f"{w}x{h}+{x}+{y}")
                except Exception:
                    pass
        if force_show or not self._visible:
            self._visible = True
            try:
                try:
                    from sender_py import window_utils as wu
                except ModuleNotFoundError:
                    import window_utils as wu
                wu.show_window_topmost_noactivate(self.win)
            except Exception:
                try:
                    self.win.deiconify()
                except Exception:
                    pass

    def reset_for_new_run(self):
        self._cancel_auto_hide()
        self._dismissed = False
        self._user_moved = False
        self._last_geom = None

    def update(self, state: dict, just_finished: bool = False):
        if self._dismissed:
            return
        try:
            if not self._ensure_window():
                return
        except Exception:
            return

        is_running = bool(state.get("running", False))
        self._is_running_state = is_running
        prog = state.get("progress") if isinstance(state.get("progress"), dict) else {}
        summary = state.get("summary") if isinstance(state.get("summary"), dict) else {}

        processed = int(prog.get("processed") or 0)
        total = max(0, int(prog.get("total") or 0))
        countdown = int(prog.get("countdown") or 0)
        cur_name = str(prog.get("current_name") or "").strip()
        step_text = str(prog.get("step_text") or "").strip()
        sidebar_alert = prog.get("sidebar_alert")

        sent_c = int(summary.get("sent") or 0)
        fail_c = int(summary.get("failed") or 0)
        unmatched_c = int(summary.get("unmatched", summary.get("mismatch", 0)) or 0)
        blocked_c = int(summary.get("blocked") or 0)

        pct = min(100, int(round((processed / total) * 100))) if total > 0 else 0
        try:
            self._pbar.config(value=100 if (not is_running and not sidebar_alert and total > 0 and processed >= total) else pct)
            self._pct_lbl.config(text=f"{processed}/{total} ({pct}%)" if total > 0 else "0/0")
            self._stats_lbl.config(text=f"成功 {sent_c} · 失败 {fail_c} · 未匹配 {unmatched_c} · 拦截 {blocked_c}")
        except Exception:
            pass

        if is_running:
            self._cancel_auto_hide()
            if countdown > 0:
                badge_txt, badge_fg, badge_bg = f"倒计时 {countdown}s", "#b45309", "#fef3c7"
                cur_txt = "即将开始发送..."
            else:
                badge_txt, badge_fg, badge_bg = "发送中", "#1d4ed8", "#dbeafe"
                cur_txt = f"当前：{cur_name}" if cur_name else "当前：准备中..."
            try:
                self._badge_lbl.config(text=badge_txt, fg=badge_fg, bg=badge_bg)
                self._current_lbl.config(text=cur_txt, fg="#1e293b")
                self._step_lbl.config(text=step_text or "正在执行发送...", fg="#475569")
                self._action_btn.config(
                    state="normal", text="⏹ 停止发送 (Esc)",
                    bg="#fee2e2", fg="#dc2626", activebackground="#fecaca",
                )
            except Exception:
                pass
            self._apply_geometry(force_show=not self._visible)
            return

        if just_finished and self._visible:
            if sidebar_alert:
                badge_txt, badge_fg, badge_bg = "请关侧边栏", "#b91c1c", "#fee2e2"
                cur_txt = "检测到企微右侧边栏已打开"
                detail_txt = (sidebar_alert.get("message") if isinstance(sidebar_alert, dict) else "") or step_text
                delay_ms = 15000
            elif "暂停" in step_text:
                badge_txt, badge_fg, badge_bg = "已暂停", "#b45309", "#fef3c7"
                cur_txt = f"已完成 {processed}/{total}"
                detail_txt = step_text
                delay_ms = 8000
            else:
                badge_txt, badge_fg, badge_bg = "发送完成", "#15803d", "#dcfce7"
                cur_txt = f"本批结束（成功 {sent_c} / 共 {total}）"
                detail_txt = step_text or "本批处理已结束"
                delay_ms = 8000
            try:
                self._badge_lbl.config(text=badge_txt, fg=badge_fg, bg=badge_bg)
                self._current_lbl.config(text=cur_txt, fg=badge_fg)
                self._step_lbl.config(text=detail_txt, fg="#334155")
                self._action_btn.config(
                    state="normal", text="关闭浮窗",
                    bg="#e2e8f0", fg="#1e293b", activebackground="#cbd5e1",
                )
            except Exception:
                pass
            self._apply_geometry(force_show=False)
            self._cancel_auto_hide()
            try:
                self._auto_hide_after_id = self.master.after(delay_ms, self.hide)
            except Exception:
                pass

    def dismiss(self):
        self._dismissed = True
        self.hide()

    def hide(self):
        self._cancel_auto_hide()
        self._visible = False
        if self.win is not None:
            try:
                self.win.withdraw()
            except Exception:
                pass

    def destroy(self):
        self._cancel_auto_hide()
        self._visible = False
        if self.win is not None:
            try:
                self.win.destroy()
            except Exception:
                pass
            self.win = None


class WebCompanionWindow:
    def __init__(self, controller, server, port: int, url: str, root=None):
        self.controller = controller
        self.server = server
        self.port = port
        self.url = url

        import tkinter as tk
        from tkinter import ttk

        self.root = root if root is not None else tk.Tk()
        self._progress_hud = None
        self._alert_dialog = None
        self._was_running = False
        self._init_window()
        self._build_ui()
        self._setup_hooks()
        self._schedule_poll()

    def _init_window(self):
        self.root.title("极方每周反馈程序 (Web版) - 控制台")
        self.root.geometry("450x330")
        self.root.minsize(420, 310)
        self.root.resizable(True, True)

        # 尝试设置窗口与任务栏图标（杜绝 Tk 默认羽毛/叶子）
        self._window_icon = apply_window_icon(self.root)

        # 居中显示
        try:
            self.root.update_idletasks()
            sw = self.root.winfo_screenwidth()
            sh = self.root.winfo_screenheight()
            x = max(0, (sw - 450) // 2)
            y = max(0, (sh - 330) // 2)
            self.root.geometry(f"+{x}+{y}")
        except Exception:
            pass

        # 关闭窗口联动
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

    def _build_ui(self):
        import tkinter as tk
        from tkinter import ttk

        self.root.configure(bg="#f8fafc")

        # 样式定义
        style = ttk.Style(self.root)
        try:
            style.theme_use("clam")
        except Exception:
            pass

        # 容器 Frame
        main_frame = tk.Frame(self.root, bg="#f8fafc", padx=16, pady=14)
        main_frame.pack(fill="both", expand=True)

        # 1. 顶部 Header
        header_frame = tk.Frame(main_frame, bg="#f8fafc")
        header_frame.pack(fill="x", pady=(0, 10))

        title_row = tk.Frame(header_frame, bg="#f8fafc")
        title_row.pack(fill="x")

        tk.Label(
            title_row,
            text="极方每周反馈程序",
            font=("Microsoft YaHei", 12, "bold"),
            fg="#0f172a",
            bg="#f8fafc"
        ).pack(side="left")

        tk.Label(
            title_row,
            text="Web版",
            font=("Microsoft YaHei", 8, "bold"),
            fg="#2563eb",
            bg="#dbeafe",
            padx=6,
            pady=1
        ).pack(side="left", padx=6)

        self.status_badge = tk.Label(
            title_row,
            text="🟢 服务就绪",
            font=("Microsoft YaHei", 9),
            fg="#16a34a",
            bg="#f8fafc"
        )
        self.status_badge.pack(side="right")

        url_row = tk.Frame(header_frame, bg="#f8fafc")
        url_row.pack(fill="x", pady=(2, 0))

        tk.Label(
            url_row,
            text=f"本地服务地址：{self.url}",
            font=("Microsoft YaHei", 9),
            fg="#64748b",
            bg="#f8fafc"
        ).pack(side="left")

        # 2. 状态信息卡片 (Card)
        card = tk.Frame(main_frame, bg="#ffffff", bd=1, relief="solid", padx=12, pady=10)
        card.pack(fill="x", pady=(0, 12))

        self.lbl_task_status = tk.Label(
            card,
            text="当前任务：空闲待命中",
            font=("Microsoft YaHei", 9, "bold"),
            fg="#334155",
            bg="#ffffff",
            anchor="w"
        )
        self.lbl_task_status.pack(fill="x", pady=(0, 3))

        self.lbl_files_students = tk.Label(
            card,
            text="数据统计：已加载 0 个文件 · 共 0 位学生 (已选 0 位)",
            font=("Microsoft YaHei", 9),
            fg="#475569",
            bg="#ffffff",
            anchor="w"
        )
        self.lbl_files_students.pack(fill="x", pady=(0, 3))

        self.lbl_send_progress = tk.Label(
            card,
            text="发送进度：已发送 0 · 失败 0 · 未匹配 0 · 跳过 0",
            font=("Microsoft YaHei", 9),
            fg="#64748b",
            bg="#ffffff",
            anchor="w"
        )
        self.lbl_send_progress.pack(fill="x")

        # 3. 操作按钮区
        btn_frame = tk.Frame(main_frame, bg="#f8fafc")
        btn_frame.pack(fill="x", pady=(0, 10))

        # 3.1 核心主按钮：打开浏览器控制台
        self.btn_open_browser = tk.Button(
            btn_frame,
            text="打开 / 重新打开浏览器界面",
            font=("Microsoft YaHei", 10, "bold"),
            bg="#2563eb",
            fg="#ffffff",
            activebackground="#1d4ed8",
            activeforeground="#ffffff",
            relief="flat",
            cursor="hand2",
            pady=6,
            command=self.open_browser
        )
        self.btn_open_browser.pack(fill="x", pady=(0, 8))

        # 3.2 次级按钮行 (添加文件 + 停止发送 + 退出程序)
        sub_btn_row = tk.Frame(btn_frame, bg="#f8fafc")
        sub_btn_row.pack(fill="x")

        self.btn_add_files = tk.Button(
            sub_btn_row,
            text="添加反馈文件",
            font=("Microsoft YaHei", 9),
            bg="#e2e8f0",
            fg="#1e293b",
            relief="flat",
            cursor="hand2",
            padx=10,
            pady=4,
            command=self.request_file_picker
        )
        self.btn_add_files.pack(side="left", expand=True, fill="x", padx=(0, 4))

        self.btn_stop = tk.Button(
            sub_btn_row,
            text="⏹ 紧急停止发送",
            font=("Microsoft YaHei", 9),
            bg="#fee2e2",
            fg="#dc2626",
            relief="flat",
            cursor="hand2",
            state="disabled",
            padx=10,
            pady=4,
            command=self.stop_send
        )
        self.btn_stop.pack(side="left", expand=True, fill="x", padx=(4, 4))

        self.btn_exit = tk.Button(
            sub_btn_row,
            text="退出程序",
            font=("Microsoft YaHei", 9),
            bg="#f1f5f9",
            fg="#475569",
            relief="flat",
            cursor="hand2",
            padx=10,
            pady=4,
            command=self.on_close
        )
        self.btn_exit.pack(side="left", expand=True, fill="x", padx=(4, 0))

        # 4. 底部友好提示
        hint_label = tk.Label(
            main_frame,
            text="提示：主操作界面在浏览器中。关闭此控制台将彻底退出程序与后台服务。",
            font=("Microsoft YaHei", 8),
            fg="#94a3b8",
            bg="#f8fafc",
            anchor="center"
        )
        hint_label.pack(side="bottom", fill="x")

    def _setup_hooks(self):
        # 将原生文件选择器与手动视野校准弹窗回调挂载到控制器上，供 Web 后端线程安全调度至主 Tkinter 线程
        self.controller.native_file_picker = self.request_file_picker
        self.controller.native_roi_calibrator = self.request_roi_calibration

    def request_roi_calibration(self, base_image, initial_roi=None, should_stop=None):
        """线程安全地在主 Tkinter 线程弹出手动视野校准窗口（Toplevel），彻底避免子线程建 tk.Tk() 死锁。"""
        done_evt = threading.Event()
        holder = {"roi": None}

        def _open_on_main():
            try:
                try:
                    from sender_py.roi_calibrator import run_calibration
                except ModuleNotFoundError:
                    from roi_calibrator import run_calibration
                if should_stop is not None and should_stop():
                    holder["roi"] = None
                    return
                holder["roi"] = run_calibration(self.root, base_image, initial_roi=initial_roi)
            except Exception as exc:
                try:
                    self.controller.emit(f"打开手动校准窗口失败：{exc}", level="WARNING")
                except Exception:
                    pass
                holder["roi"] = None
            finally:
                done_evt.set()

        try:
            self.root.after(0, _open_on_main)
        except Exception:
            return None

        while not done_evt.wait(timeout=0.15):
            if should_stop is not None and should_stop():
                # 停止发送时继续等待主线程弹窗回调自然收尾，或最多等 0.5 秒后退出阻塞
                done_evt.wait(timeout=0.5)
                break
        return holder["roi"]

    def open_browser(self):
        """在系统默认浏览器打开 Web 控制面板。"""
        try:
            webbrowser.open(self.url)
        except Exception:
            pass

    def request_file_picker(self):
        """线程安全地在主 Tkinter 线程唤起文件选择对话框。"""
        try:
            self.root.after(0, self._do_pick_files)
        except Exception:
            pass

    def _do_pick_files(self):
        try:
            try:
                from sender_py import window_utils as wu
            except ModuleNotFoundError:
                import window_utils as wu
            paths = wu.pick_files_foreground(
                master=self.root,
                title="选择反馈文件（可按 Ctrl+A 全选所有文件）",
                filetypes=[
                    ("反馈文件（JSON / HTML）", "*.json *.html *.htm"),
                    ("JSON 文件", "*.json"),
                    ("HTML 快照", "*.html *.htm"),
                    ("所有文件", "*.*"),
                ],
            )
            if paths:
                self.controller.add_input_files(list(paths), replace=False)
                self._update_status_display()
        except Exception as exc:
            self.controller.emit(f"打开文件选择框失败：{exc}")

    def stop_send(self):
        """立即停止发送。"""
        self.controller.stop_send()
        self._update_status_display()

    def _schedule_poll(self):
        """运行期每 250ms、空闲期每 800ms 轮询一次控制器状态，刷新控制台与侧边进度浮窗。"""
        try:
            is_running = self._update_status_display()
            interval = 250 if is_running else 800
            self.root.after(interval, self._schedule_poll)
        except Exception:
            pass

    def _update_status_display(self):
        try:
            state = self.controller.get_state()
        except Exception:
            return False

        is_running = bool(state.get("running", False))
        files = state.get("files", [])
        summary = state.get("summary", {})
        total_students = summary.get("total", 0)
        selected_students = summary.get("selected", 0)
        sent_count = summary.get("sent", 0)
        failed_count = summary.get("failed", 0)
        mismatch_count = summary.get("unmatched", summary.get("mismatch", 0))
        skipped_count = summary.get("skipped", 0)

        # 更新状态指示徽标
        if is_running:
            self.status_badge.config(text="🟡 正在发送中...", fg="#d97706")
            self.btn_stop.config(state="normal")
            self.lbl_task_status.config(
                text=f"当前任务：▶ 正在发送反馈 (已选 {selected_students} 位)",
                fg="#2563eb"
            )
        else:
            self.status_badge.config(text="🟢 服务就绪", fg="#16a34a")
            self.btn_stop.config(state="disabled")
            if total_students > 0:
                self.lbl_task_status.config(
                    text="当前任务：就绪待命 (随时可在浏览器中点击开始发送)",
                    fg="#059669"
                )
            else:
                self.lbl_task_status.config(
                    text="当前任务：空闲待命中 (请在浏览器中添加反馈文件)",
                    fg="#475569"
                )

        # 更新文件与学生总计
        self.lbl_files_students.config(
            text=f"数据统计：已加载 {len(files)} 个文件 · 共 {total_students} 位学生 (已选 {selected_students} 位)"
        )

        # 更新发送结果统计
        self.lbl_send_progress.config(
            text=f"发送进度：已发送 {sent_count} · 失败 {failed_count} · 未匹配 {mismatch_count} · 跳过 {skipped_count}"
        )

        # 同步侧边进度浮窗（仅在发送期间或刚结束收尾时显示在企微旁侧，不挡企微且不抢焦点）
        just_started = is_running and not self._was_running
        just_finished = (not is_running) and self._was_running
        self._was_running = is_running
        if just_started:
            self._close_foreground_alert()
        try:
            if is_running or just_finished:
                if self._progress_hud is None:
                    self._progress_hud = FloatingProgressHUD(self.root, on_stop=self.stop_send)
                if just_started:
                    self._progress_hud.reset_for_new_run()
                self._progress_hud.update(state, just_finished=just_finished)
        except Exception:
            pass
        if just_finished:
            self._handle_run_finished_alert(state)
        return is_running

    def _close_foreground_alert(self):
        dlg = getattr(self, "_alert_dialog", None)
        if dlg is not None:
            try:
                dlg.destroy()
            except Exception:
                pass
            self._alert_dialog = None

    def _handle_run_finished_alert(self, state: dict):
        """发送异常停止或出现失败/侧边栏告警时，将浏览器控制台与置顶提示弹窗拉到企微前方，防止被企微遮挡。"""
        prog = state.get("progress") if isinstance(state.get("progress"), dict) else {}
        summary = state.get("summary") if isinstance(state.get("summary"), dict) else {}
        sidebar_alert = prog.get("sidebar_alert")
        step_text = str(prog.get("step_text") or "").strip()

        sent_c = int(summary.get("sent") or 0)
        failed_c = int(summary.get("failed") or 0)
        unmatched_c = int(summary.get("unmatched", summary.get("mismatch", 0)) or 0)
        blocked_c = int(summary.get("blocked") or 0)

        has_failure = bool(
            sidebar_alert
            or failed_c > 0
            or unmatched_c > 0
            or blocked_c > 0
            or any(k in step_text for k in ("异常", "失败", "校准"))
        )
        if not has_failure:
            return

        try:
            try:
                from sender_py import window_utils as wu
            except ModuleNotFoundError:
                import window_utils as wu
            wu.bring_browser_to_front("极方每周反馈程序")
        except Exception:
            pass

        if sidebar_alert:
            title = (sidebar_alert.get("title") if isinstance(sidebar_alert, dict) else "") or "请先关闭企业微信右侧边栏"
            message = (sidebar_alert.get("message") if isinstance(sidebar_alert, dict) else "") or (
                "检测到企业微信右侧边栏已打开，已停止发送。请先关闭企微右侧边栏后再继续发送。"
            )
            self._show_foreground_alert(title=title, message=message, is_error=True)
        else:
            stats_line = f"本批结果：成功 {sent_c} · 失败 {failed_c} · 未匹配 {unmatched_c} · 拦截 {blocked_c}"
            detail = f"{stats_line}\n{step_text}" if step_text else stats_line
            self._show_foreground_alert(
                title="部分学员发送未成功，请处理",
                message=detail,
                is_error=(failed_c > 0 or blocked_c > 0),
            )

    def _show_foreground_alert(self, title: str, message: str, is_error: bool = True):
        """在屏幕中央弹出置顶原生提示窗（不被企业微信遮挡），点击确认可切回浏览器控制台。"""
        self._close_foreground_alert()
        try:
            import tkinter as tk
            dlg = tk.Toplevel(self.root)
            dlg.withdraw()
            dlg.title(title)
            dlg.resizable(False, False)
            dlg.configure(bg="#ffffff")
            apply_window_icon(dlg)

            accent = "#dc2626" if is_error else "#b45309"

            shell = tk.Frame(dlg, bg="#ffffff")
            shell.pack(fill="both", expand=True)
            tk.Frame(shell, bg=accent, width=4).pack(side="left", fill="y")

            content = tk.Frame(shell, bg="#ffffff")
            content.pack(side="left", fill="both", expand=True)

            banner = tk.Frame(content, bg="#ffffff", padx=16, pady=12)
            banner.pack(fill="x")
            tk.Label(
                banner, text=title,
                font=("Microsoft YaHei", 11), fg="#171717", bg="#ffffff", anchor="w",
            ).pack(fill="x")

            tk.Frame(content, bg="#e5e5e5", height=1).pack(fill="x", padx=16)

            body = tk.Frame(content, bg="#ffffff", padx=16, pady=16)
            body.pack(fill="both", expand=True)
            tk.Label(
                body, text=message, font=("Microsoft YaHei", 10),
                fg="#525252", bg="#ffffff", justify="left", anchor="w", wraplength=380,
            ).pack(fill="x", pady=(0, 16))

            def _ack():
                self._close_foreground_alert()
                try:
                    try:
                        from sender_py import window_utils as wu
                    except ModuleNotFoundError:
                        import window_utils as wu
                    wu.bring_browser_to_front("极方每周反馈程序")
                except Exception:
                    pass

            btn_row = tk.Frame(body, bg="#ffffff")
            btn_row.pack(fill="x")
            tk.Button(
                btn_row, text="我知道了（切回控制台）", font=("Microsoft YaHei", 9),
                bg="#171717", fg="#ffffff", activebackground="#262626", activeforeground="#ffffff",
                relief="flat", padx=16, pady=8, cursor="hand2", command=_ack,
            ).pack(side="right")

            dlg.protocol("WM_DELETE_WINDOW", _ack)
            dlg.update_idletasks()
            w = max(420, int(dlg.winfo_reqwidth() or 420))
            h = max(170, int(dlg.winfo_reqheight() or 170))
            sw = int(self.root.winfo_screenwidth() or 1920)
            sh = int(self.root.winfo_screenheight() or 1080)
            x = max(0, (sw - w) // 2)
            y = max(0, (sh - h) // 2)
            dlg.geometry(f"{w}x{h}+{x}+{y}")

            try:
                try:
                    from sender_py import window_utils as wu
                except ModuleNotFoundError:
                    import window_utils as wu
                wu.bring_tk_window_to_front(dlg, topmost=True)
            except Exception:
                try:
                    dlg.attributes("-topmost", True)
                    dlg.deiconify()
                    dlg.lift()
                    dlg.focus_force()
                except Exception:
                    pass

            self._alert_dialog = dlg
        except Exception:
            pass

    def on_close(self):
        """用户点击右上角 [X] 或「退出程序」按钮时的退出确认与资源释放。"""
        from tkinter import messagebox
        is_running = getattr(self.controller, "is_running", False)
        if is_running:
            ok = messagebox.askyesno(
                "正在发送",
                "当前正在发送反馈，关闭控制台将终止发送并彻底退出程序。\n确定要退出吗？",
                parent=self.root,
                default=messagebox.NO
            )
            if not ok:
                return
        else:
            ok = messagebox.askyesno(
                "退出程序",
                "确定要完全退出极方每周反馈程序吗？\n（退出后本地后台服务将停止运行）",
                parent=self.root,
                default=messagebox.YES
            )
            if not ok:
                return

        self.shutdown_app()

    def shutdown_app(self):
        """执行彻底退出：停止发送、关闭 HTTP 服务、销毁窗口并终止进程。"""
        try:
            self.controller.stop_send()
        except Exception:
            pass

        try:
            self.server.shutdown()
            self.server.server_close()
        except Exception:
            pass

        try:
            self._close_foreground_alert()
            if self._progress_hud is not None:
                self._progress_hud.destroy()
        except Exception:
            pass

        try:
            self.root.destroy()
        except Exception:
            pass

        os._exit(0)

    def start_loop(self):
        """启动 Tkinter 事件主循环。"""
        self.root.mainloop()


def launch_web_gui_companion(controller, server, port: int, url: str) -> bool:
    """尝试启动 Tkinter 桌面微型伴随控制台。

    返回 True 表示桌面控制台成功启动并在用户退出后正常结束；
    返回 False 表示运行环境不支持图形界面（如 Linux CI / 无头服务器），由调用方回退至纯控制台阻塞。
    """
    try:
        try:
            from sender_py.window_utils import set_app_user_model_id
        except ModuleNotFoundError:
            from window_utils import set_app_user_model_id
        set_app_user_model_id()
    except Exception:
        pass

    try:
        import tkinter as tk
        # 探测是否能连接显示服务
        root = tk.Tk()
    except Exception:
        # 在 WSL / Linux 无 DISPLAY 或未装 tkinter 环境下安全捕获
        return False

    try:
        app = WebCompanionWindow(controller, server, port, url, root=root)
        app.start_loop()
        return True
    except Exception as exc:
        try:
            root.destroy()
        except Exception:
            pass
        return False
