"""
send_single_feedback 重试流程的行为验证（Linux 上跑，靠桩件替换 Win32/tkinter 依赖）。

验证 5 件事：
 1. 标题 MATCH 才允许走到粘贴+回车（唯一放行闸门）
 2. MISMATCH / UNCERTAIN 触发换候选，且最多共 2 次，绝不无限循环
 3. 换候选方向：首轮第 1 项 -> 改第 2 项；首轮第 >=2 项 -> 改第 1 项
 4. choice<=0（0 未找到 / -1 接口故障）一律按第 1 项试探
 5. 【↓】次数 = choice-1，且目标在第 3 项以后仍能精确命中（不封顶）
"""
import sys
import os
import types


def _stub(name, **attrs):
    m = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(m, k, v)
    sys.modules[name] = m
    return m


# ---- 桩件：tkinter / PIL / pyautogui / pyperclip ----
_stub("tkinter", Tk=object, StringVar=object, BooleanVar=object, IntVar=object, END="end")
_stub("tkinter.ttk", Treeview=object, Style=object, Notebook=object, Frame=object, Label=object, Button=object)
_stub("tkinter.filedialog", askopenfilenames=lambda **k: [], askdirectory=lambda **k: "")
_stub("tkinter.messagebox", showinfo=lambda *a, **k: None, showwarning=lambda *a, **k: None,
      showerror=lambda *a, **k: None, askyesno=lambda *a, **k: True)
_stub("PIL")
_stub("PIL.Image", Image=object, new=lambda *a, **k: None, frombytes=lambda *a, **k: None)
_stub("PIL.ImageEnhance", Contrast=lambda *a, **k: None, Brightness=lambda *a, **k: None, Sharpness=lambda *a, **k: None)
_stub("pyautogui", hotkey=lambda *a: None, press=lambda *a: None, click=lambda *a: None,
      screenshot=lambda **k: None, write=lambda *a: None, FAILSAFE=False)
_stub("pyperclip", copy=lambda *a: True, paste=lambda: "")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import send_feedback as sf  # noqa: E402


class Recorder:
    """记录一次 send_single_feedback 过程中的全部外部动作。"""

    def __init__(self, dropdown_results, header_results):
        # dropdown_results: 每个 attempt 调用一次，返回 (choice, reason)
        self.dropdown = list(dropdown_results)
        # header_results: 每个 attempt 调用一次，返回 (status, title)
        self.header = list(header_results)
        self.presses = []          # pyautogui.press 的按键序列
        self.hotkeys = []          # pyautogui.hotkey 的键序列
        self.clipboard = []        # safe_copy 写入剪贴板的内容（先搜索词，后文案）
        self.dismisses = 0         # dismiss_and_clear_search 调用次数
        self.header_calls = 0
        self.dropdown_calls = 0    # detect_dropdown_target 调用次数（重试轮不应再问模型）

    def run(self, search_name="90001张三"):
        rec = self

        class FakeStatus:
            def config(self, **k):
                pass

        class FakeRoot:
            def after(self, _delay, fn):
                pass

        app = object.__new__(sf.FeedbackSender)
        app.root = FakeRoot()
        app.status_label = FakeStatus()
        app.safe_sleep = lambda _s: True
        app.smart_mode_var = types.SimpleNamespace(get=lambda: "A")
        app.auto_fallback_var = types.SimpleNamespace(get=lambda: True)

        sf.get_wecom_rect = lambda: (0, 0, 1200, 800)
        sf.parse_student_identifier = lambda s: ("90001", "张三")
        sf.safe_copy = lambda t: (rec.clipboard.append(t), True)[1]
        sf.dismiss_and_clear_search = lambda: rec.__setattr__("dismisses", rec.dismisses + 1)
        sf.pyautogui = types.SimpleNamespace(
            hotkey=lambda *a: rec.hotkeys.append("+".join(a)),
            press=lambda k: rec.presses.append(k),
        )
        sf.time = types.SimpleNamespace(sleep=lambda _s: None)

        def fake_dropdown(*_a, **_k):
            rec.dropdown_calls += 1
            return rec.dropdown.pop(0) if rec.dropdown else (0, "no more")

        def fake_header(*_a, **_k):
            rec.header_calls += 1
            return rec.header.pop(0) if rec.header else ("UNCERTAIN", "")

        sf.detect_dropdown_target = fake_dropdown
        sf.verify_chat_header_title = fake_header

        result = app.send_single_feedback(search_name, "这是一条测试反馈文案")
        rec.result = result
        return rec

    @property
    def downs(self):
        return self.presses.count("down")

    @property
    def sent(self):
        """文案是否已粘贴并回车发出——即是否真的发出去了。"""
        return "这是一条测试反馈文案" in self.clipboard


FAILED = []


def check(name, cond, detail=""):
    mark = "PASS" if cond else "FAIL"
    print(f"[{mark}] {name}" + (f"  <- {detail}" if not cond and detail else ""))
    if not cond:
        FAILED.append(name)


# ============ 用例 1：首轮 choice=1 且标题相符 ============
r = Recorder([(1, "第1项即本人")], [("MATCH", "90001张三")]).run()
check("用例1 首轮命中直接发送", r.result == "SUCCESS" and r.sent, f"result={r.result}")
check("用例1 只按 0 次↓", r.downs == 0, f"downs={r.downs}")
check("用例1 只核验 1 次标题", r.header_calls == 1, f"calls={r.header_calls}")

# ============ 用例 2：目标在第 3 项，不封顶 ============
r = Recorder([(3, "第3项才是本人")], [("MATCH", "90001张三")]).run()
check("用例2 choice=3 精确命中", r.result == "SUCCESS" and r.downs == 2, f"result={r.result} downs={r.downs}")

# ============ 用例 3：choice=0 -> 进第1项 -> 标题不符 -> 换第2项 -> 命中 ============
r = Recorder([(0, "未找到本人")], [("MISMATCH", "老板（企微）"), ("MATCH", "90001张三")]).run()
check("用例3 换候选后命中", r.result == "SUCCESS" and r.sent, f"result={r.result}")
check("用例3 首轮按0次↓(第1项)、次轮按1次↓(第2项)", r.downs == 1, f"downs={r.downs}")
check("用例3 次轮切换前先清场", r.dismisses == 1, f"dismisses={r.dismisses}")

# ============ 用例 4：两次都不符 -> 拦截，且只有 2 次 ============
r = Recorder([(1, "x")], [("MISMATCH", "老板（企微）"), ("MISMATCH", "同事小李")]).run()
check("用例4 两次不符被拦截", r.result == "HEADER_MISMATCH", f"result={r.result}")
check("用例4 绝不发送", not r.sent, f"clipboard={r.clipboard}")
check("用例4 恰好 2 次尝试(不循环)", r.header_calls == 2, f"header_calls={r.header_calls}")

# ============ 用例 5：两次都存疑 -> 身份存疑拦截 ============
r = Recorder([(1, "x")], [("UNCERTAIN", ""), ("UNCERTAIN", "")]).run()
check("用例5 存疑归为存疑拦截", r.result == "UNCERTAIN_INTERCEPT", f"result={r.result}")
check("用例5 绝不发送", not r.sent)

# ============ 用例 6：接口故障(ERROR) 也算存疑，且不循环 ============
r = Recorder([(1, "x")], [("ERROR", "VLM 接口调用失败"), ("ERROR", "VLM 接口调用失败")]).run()
check("用例6 接口故障归为存疑拦截", r.result == "UNCERTAIN_INTERCEPT", f"result={r.result}")
check("用例6 恰好 2 次尝试", r.header_calls == 2, f"header_calls={r.header_calls}")

# ============ 用例 7：首轮 choice>=2 -> 重试改第 1 项 ============
r = Recorder([(3, "x")], [("MISMATCH", "老板"), ("MATCH", "90001张三")]).run()
check("用例7 choice3 失败后改选第1项", r.result == "SUCCESS", f"result={r.result}")
check("用例7 两轮共按 2 次↓(第3项)", r.downs == 2, f"downs={r.downs}")

# ============ 用例 8：模型故障 -1 -> 按第 1 项试探 ============
r = Recorder([(-1, "VLM 接口调用失败")], [("MATCH", "90001张三")]).run()
check("用例8 接口故障按第1项试探并命中", r.result == "SUCCESS" and r.downs == 0, f"result={r.result} downs={r.downs}")

# ============ 用例 9：模型仍吐 -2 也归一化为 0 ============
r = Recorder([(-2, "仅在他人描述")], [("MISMATCH", "老板"), ("MATCH", "90001张三")]).run()
check("用例9 choice=-2 归一化后仍能自愈", r.result == "SUCCESS", f"result={r.result}")

# ============ 用例 10：真正查无此人 -> 两个候选都不符 -> 拦截而非误发 ============
r = Recorder([(0, "显示进入全局搜索")], [("MISMATCH", "老板（企微）"), ("MISMATCH", "同事小李")]).run()
check("用例10 查无此人被拦截且不发", r.result == "HEADER_MISMATCH" and not r.sent, f"result={r.result}")

# ============ 用例 11：进入会话只按 1 次回车（改动前是 2 次） ============
r = Recorder([(1, "x")], [("MATCH", "90001张三")]).run()
enters_before_send = r.presses.count("enter")
check("用例11 每轮进入会话仅 1 次回车", enters_before_send == 2, f"enter 总数={enters_before_send}（应为 1 次进入 + 1 次发送）")

# ============ 用例 12：SEARCH_DELAY 已缩到 0.5s ============
check("用例12 SEARCH_DELAY=0.5", sf.SEARCH_DELAY == 0.5, f"实际={sf.SEARCH_DELAY}")

# ============ 用例 13（回归）：重试轮不得再问模型 ============
# 模型两次都给 3。若重试轮又问一次模型，choice 仍是 3 -> 白白重进第 3 项，永远试不到第 1 项。
r = Recorder([(3, "模型说第3项"), (3, "模型又说第3项")], [("MISMATCH", "老板"), ("MATCH", "90001张三")]).run()
check("用例13 重试轮不再询问模型", r.dropdown_calls == 1, f"dropdown_calls={r.dropdown_calls}")
check("用例13 重试确实改选第1项(0次↓)", r.downs == 2, f"downs={r.downs}（首轮第3项2次 + 次轮第1项0次）")
check("用例13 重试后命中", r.result == "SUCCESS", f"result={r.result}")

# ============ 用例 14：首轮第1项 -> 重试必须改选第 2 项（按 1 次↓） ============
r = Recorder([(1, "模型说第1项")], [("MISMATCH", "老板"), ("MATCH", "90001张三")]).run()
check("用例14 首轮第1项->重试按1次↓进第2项", r.downs == 1, f"downs={r.downs}")
check("用例14 重试轮不再询问模型", r.dropdown_calls == 1, f"dropdown_calls={r.dropdown_calls}")
check("用例14 重试后命中", r.result == "SUCCESS", f"result={r.result}")

print()
if FAILED:
    print(f"❌ {len(FAILED)} 项未通过: {FAILED}")
    sys.exit(1)
print("✅ 全部通过")