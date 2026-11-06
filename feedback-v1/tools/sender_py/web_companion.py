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


class WebCompanionWindow:
    def __init__(self, controller, server, port: int, url: str, root=None):
        self.controller = controller
        self.server = server
        self.port = port
        self.url = url

        import tkinter as tk
        from tkinter import ttk

        self.root = root if root is not None else tk.Tk()
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
        # 将原生文件选择器回调挂载到控制器上，供 Web 界面点击「选择本地文件」时线程安全调度
        self.controller.native_file_picker = self.request_file_picker

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
        from tkinter import filedialog
        try:
            paths = filedialog.askopenfilenames(
                parent=self.root,
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
        """每 800ms 轮询一次控制器状态，刷新控制台界面。"""
        try:
            self._update_status_display()
            self.root.after(800, self._schedule_poll)
        except Exception:
            pass

    def _update_status_display(self):
        try:
            state = self.controller.get_state()
        except Exception:
            return

        is_running = state.get("running", False)
        files = state.get("files", [])
        summary = state.get("summary", {})
        total_students = summary.get("total", 0)
        selected_students = summary.get("selected", 0)
        sent_count = summary.get("sent", 0)
        failed_count = summary.get("failed", 0)
        mismatch_count = summary.get("mismatch", 0)
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
