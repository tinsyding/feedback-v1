"""
send_single_feedback 会话判定流程的行为验证（Linux 上跑，靠桩件替换 Win32/tkinter 依赖）。

v2.6.0 流程变更（下拉选人整步删除 + 整窗统一判定 + 待回名单）：
  1. 候选**不再询问模型**，机械按第 1 → 2 → 3 项顺序试，最多 3 次，绝不无限循环
  2. 每进入一个候选：抓「画面已稳定」的企微整窗 -> 一次云端调用同时裁决
     身份（fail-closed）+ is_group + needs_reply（fail-open，只记录）
  3. 身份 MATCH 才允许走到粘贴+回车（唯一放行闸门）
  4. 【关键】进入会话本身就会清掉家长未读角标，所以**每一个进入过的候选都要留痕**，
     哪怕身份没通过 —— 否则老师事后无从知道哪位家长找过我们
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

_REAL_get_virtual_screen_bounds = None

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import send_feedback as sf  # noqa: E402

# Recorder.run() 会把 sf.parse_student_identifier 换成桩件，必须在替换前留真引用
_REAL_parse_student_identifier = sf.parse_student_identifier
_SRC = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "send_feedback.py"), encoding="utf-8").read()

TARGET_ID = "90001"
TARGET_NAME = "张三"
MATCH_TITLE = "90001张三（家长）"


def chat(status="MATCH", title=MATCH_TITLE, *, is_group=False, title_in_header=True,
         last_sender="parent", last_message="老师收到成绩了", needs_reply=True, matched=None):
    """构造一份 inspect_chat_view_via_vlm 的返回值。"""
    return {
        "status": status,
        "error": "",
        "detected_title": title,
        "title_in_header": title_in_header,
        "is_group": is_group,
        "model_matched": status == "MATCH" if matched is None else matched,
        "last_sender": last_sender,
        "last_message_text": last_message,
        "needs_reply": needs_reply,
        "reason": "测试桩件",
    }


class _FakeImg:
    """最小 PIL 替身：够 _frames_identical 逐像素比较即可。"""

    def __init__(self, pixels, size=(2, 2)):
        self._pixels = pixels
        self.size = size

    def convert(self, _mode):
        return self

    def tobytes(self):
        return self._pixels


class Recorder:
    """记录一次 send_single_feedback 过程中的全部外部动作。

    chat_results: 每个进入的候选调用一次 inspect_chat_view_via_vlm，按序弹出。
    """

    def __init__(self, chat_results, *, capture_ok=True):
        self.chat = list(chat_results)
        self.capture_ok = capture_ok
        self.presses = []          # pyautogui.press 的按键序列
        self.hotkeys = []          # pyautogui.hotkey 的键序列
        self.clipboard = []        # safe_copy 写入剪贴板的内容（先搜索词，后文案）
        self.dismisses = 0         # dismiss_and_clear_search 调用次数
        self.chat_calls = 0        # inspect_chat_view_via_vlm 调用次数
        self.capture_calls = 0     # capture_chat_view_stable 调用次数
        self.notes = []            # 落进 app.reply_notes 的待回条目
        self.result = None

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
        app.reply_notes = rec.notes

        def fake_capture(*_a, **_k):
            rec.capture_calls += 1
            return _FakeImg(b"img") if rec.capture_ok else None

        def fake_inspect(*_a, **_k):
            rec.chat_calls += 1
            # 脚本用尽 = 「后面几次调用拿不到任何信号」，不能返回一个带默认消息
            # 文本的富结果，否则会把桩件默认值误当成真实待回信息记进名单。
            return rec.chat.pop(0) if rec.chat else chat("ERROR", "", last_message="", needs_reply=None)

        # 这些都是模块级全局名，必须**逐个还原**。早期版本只在 run() 里替换不还原，
        # 导致后续用例测的其实还是 Recorder 的桩件 —— 全绿但什么都没验证到。
        patches = {
            "get_wecom_rect": lambda: (0, 0, 1200, 800),
            "parse_student_identifier": lambda s: (TARGET_ID, TARGET_NAME),
            "safe_copy": lambda t: (rec.clipboard.append(t), True)[1],
            "dismiss_and_clear_search": lambda: rec.__setattr__("dismisses", rec.dismisses + 1),
            "pyautogui": types.SimpleNamespace(
                hotkey=lambda *a: rec.hotkeys.append("+".join(a)),
                press=lambda k: rec.presses.append(k),
            ),
            "time": types.SimpleNamespace(sleep=lambda _s: None, monotonic=lambda: 0.0),
            "capture_chat_view_stable": fake_capture,
            "inspect_chat_view_via_vlm": fake_inspect,
        }
        saved = {k: getattr(sf, k) for k in patches}
        for k, v in patches.items():
            setattr(sf, k, v)
        try:
            rec.result = app.send_single_feedback(search_name, "这是一条测试反馈文案")
        finally:
            for k, v in saved.items():
                setattr(sf, k, v)
        return rec

    @property
    def downs(self):
        return self.presses.count("down")

    @property
    def sent(self):
        """文案是否已粘贴并回车发出——即是否真的发出去了。"""
        return "这是一条测试反馈文案" in self.clipboard

    @property
    def actionable(self):
        """会在「待回名单」里展示出来的条目（排除明确判为无需回）。"""
        return [n for n in self.notes if n["needs_reply"] is not False]


FAILED = []


def check(name, cond, detail=""):
    mark = "PASS" if cond else "FAIL"
    print(f"[{mark}] {name}" + (f"  <- {detail}" if not cond and detail else ""))
    if not cond:
        FAILED.append(name)


# ============ 用例 1：第 1 项即命中，一次调用搞定 ============
r = Recorder([chat()]).run()
check("用例1 第1项命中直接发送", r.result == "SUCCESS" and r.sent, f"result={r.result}")
check("用例1 不按任何↓", r.downs == 0, f"downs={r.downs}")
check("用例1 只调 1 次云端(下拉已删除)", r.chat_calls == 1, f"chat_calls={r.chat_calls}")
check("用例1 只抓 1 帧组", r.capture_calls == 1, f"capture_calls={r.capture_calls}")

# ============ 用例 2：第 1 项不符 -> 换第 2 项命中 ============
r = Recorder([chat("MISMATCH", "老板（企微）"), chat()]).run()
check("用例2 换候选后命中", r.result == "SUCCESS" and r.sent, f"result={r.result}")
check("用例2 第1项0次↓+第2项1次↓", r.downs == 1, f"downs={r.downs}")
check("用例2 切换前先清场", r.dismisses == 1, f"dismisses={r.dismisses}")

# ============ 用例 3：前两项都不符 -> 第 3 项命中 ============
r = Recorder([chat("MISMATCH", "老板"), chat("MISMATCH", "同事小李"), chat()]).run()
check("用例3 第3项命中", r.result == "SUCCESS", f"result={r.result}")
check("用例3 三项共按3次↓", r.downs == 3, f"downs={r.downs}")

# ============ 用例 4：三个都不符 -> 拦截，且恰好 3 次，绝不循环 ============
r = Recorder([chat("MISMATCH", "老板"), chat("MISMATCH", "同事小李"), chat("MISMATCH", "王五")]).run()
check("用例4 三项不符被拦截", r.result == "HEADER_MISMATCH", f"result={r.result}")
check("用例4 绝不发送", not r.sent, f"clipboard={r.clipboard}")
check("用例4 恰好3次尝试(不循环)", r.chat_calls == 3, f"chat_calls={r.chat_calls}")

# ============ 用例 5：全存疑 -> 身份存疑拦截 ============
r = Recorder([chat("UNCERTAIN", ""), chat("UNCERTAIN", ""), chat("UNCERTAIN", "")]).run()
check("用例5 存疑归为存疑拦截", r.result == "UNCERTAIN_INTERCEPT", f"result={r.result}")
check("用例5 绝不发送", not r.sent)

# ============ 用例 6：抓帧失败 -> 不发 ============
r = Recorder([], capture_ok=False).run()
check("用例6 抓帧失败归为存疑拦截", r.result == "UNCERTAIN_INTERCEPT", f"result={r.result}")
check("用例6 抓帧失败绝不发送", not r.sent)
check("用例6 抓帧失败不产生云端调用", r.chat_calls == 0, f"chat_calls={r.chat_calls}")

# ============ 用例 7：每轮进入会话仅 1 次回车 ============
r = Recorder([chat()]).run()
check("用例7 1次进入+1次发送", r.presses.count("enter") == 2, f"enter={r.presses.count('enter')}")

# ============ 用例 8：下拉选人整步已从主流程删除 ============
check("用例8 主流程不再引用 detect_dropdown_target", "detect_dropdown_target(" not in _SRC, "仍在主流程里调用")
check("用例8 主流程不再引用 capture_wecom_full 之外的裁剪", "capture_dropdown_crop" not in _SRC, "旧裁剪函数仍在")
_fn = _SRC[_SRC.index("def send_single_feedback"):]
_fn = _fn[:_fn.index("\n    # =================")]
check("用例8 判定走 capture_chat_view_stable", "capture_chat_view_stable(wecom_rect)" in _fn, "未用等稳定的整窗抓帧")
check("用例8 判定走 inspect_chat_view_via_vlm", "inspect_chat_view_via_vlm(" in _fn, "未用统一会话判定")
check("用例8 三个候选是机械顺序", "choice = attempt" in _fn, "候选序号不是机械递增")
check("用例8 每个候选都记录待回", "self._record_reply_note(" in _fn, "待回记录不在主流程里")

# ============ 用例 9：每个进入过的候选都要留痕（含身份未通过的） ============
# 进会话已经清掉了未读角标，身份没过也必须记录，否则老师无从知道家长找过我们。
r = Recorder([chat("MISMATCH", "90001张三家长群", is_group=True, last_message="明天开家长会"),
              chat("MISMATCH", "老板", last_message="在吗"),
              chat()]).run()
check("用例9 三个候选都留痕", len(r.notes) == 3, f"notes={len(r.notes)}")
check("用例9 记录了群会话那条", any("家长群" in n["chat_title"] for n in r.notes), f"{[n['chat_title'] for n in r.notes]}")
check("用例9 群会话标为身份未确认", any(n["identity"] == "❌未确认" and "家长群" in n["chat_title"] for n in r.notes),
      f"{[(n['chat_title'], n['identity']) for n in r.notes]}")
check("用例9 三条都在待回名单里", len(r.actionable) == 3, f"actionable={len(r.actionable)}")

# ============ 用例 10：needs_reply 判不出 -> 记「待人工确认」且照发 ============
# fail-open：待回名单判不出来绝不能拦住发送。
r = Recorder([chat(needs_reply=None, last_message="")]).run()
check("用例10 判不出仍发送成功", r.result == "SUCCESS" and r.sent, f"result={r.result}")
check("用例10 判不出进名单", len(r.actionable) == 1 and r.actionable[0]["verdict"] == "待人工确认",
      f"{[(n['verdict']) for n in r.actionable]}")

# ============ 用例 11：needs_reply=False 不占用老师待办 ============
r = Recorder([chat(needs_reply=False, last_message="收到", last_sender="parent")]).run()
check("用例11 无需回也记全量", len(r.notes) == 1, f"notes={len(r.notes)}")
check("用例11 无需回不进待办", len(r.actionable) == 0, f"actionable={len(r.actionable)}")
check("用例11 判定文案正确", r.notes[0]["verdict"] == "无需回", f"{r.notes[0]['verdict']}")

# ============ 用例 12：完全无信号（抓帧失败/模型啥也没返回）不记噪声 ============
r = Recorder([chat("ERROR", "", last_message="", needs_reply=None, last_sender="unknown")]).run()
check("用例12 无信号不记", len(r.notes) == 0, f"notes={len(r.notes)}")

# ============ 用例 13：同学生同会话重跑不重复堆叠 ============
r = Recorder([chat(), chat()]).run()
check("用例13 同会话只留一条", len(r.notes) == 1, f"notes={len(r.notes)}")

# ============ 用例 14：judge_chat_identity 必须 fail-closed ============
_J = sf.judge_chat_identity
check("用例14 正常标题放行", _J(chat(), TARGET_ID, TARGET_NAME) == "MATCH")
check("用例14 群聊一律拒绝（旧版 TODO 的根治点）",
      _J(chat(title="90001张三家长群", is_group=True), TARGET_ID, TARGET_NAME) == "MISMATCH")
# 群里名字恰好同时含学号+姓名（截图已排除聊天区污染，长度超限）
check("用例14 标题被聊天正文污染(超长)拒绝",
      _J(chat(title="90001张三家长群下面是张三妈妈昨天发的" + "老师收到成绩了" * 3), TARGET_ID, TARGET_NAME) == "MISMATCH")
check("用例14 缺 title_in_header 不得默认放行",
      _J(chat(title_in_header=False), TARGET_ID, TARGET_NAME) == "UNCERTAIN")
check("用例14 空标题=存疑", _J(chat(title=""), TARGET_ID, TARGET_NAME) == "UNCERTAIN")
check("用例14 只有学号无姓名拒绝",
      _J(chat(title="90001王家长"), TARGET_ID, TARGET_NAME) == "MISMATCH")
check("用例14 只有姓名无学号拒绝",
      _J(chat(title="张三家长"), TARGET_ID, TARGET_NAME) == "MISMATCH")
check("用例14 模型 matched=True 也救不回来",
      _J(chat(title="老板", status="MATCH", matched=True), TARGET_ID, TARGET_NAME) == "MISMATCH")
check("用例14 标题长度上限可配置且生效", sf.CHAT_TITLE_MAX_LEN == 15, f"实际={sf.CHAT_TITLE_MAX_LEN}")

# ============ 用例 15：needs_reply 类型归一化（模型可能吐字符串） ============
_real_call = sf.call_cloud_vision
try:
    for raw, want in [(True, True), (False, False), ("true", True), ("否", False),
                      ("需要回复", True), (None, None), ("乱七八糟", None), (1, True), (0, False)]:
        sf.call_cloud_vision = lambda *_a, _r=raw, **_k: {
            "success": True, "matched": True, "detected_title": MATCH_TITLE,
            "title_in_header": True, "is_group": False, "last_sender": "parent",
            "last_message_text": "在吗", "needs_reply": _r, "reason": "",
        }
        got = sf.inspect_chat_view_via_vlm(None, TARGET_ID, TARGET_NAME)["needs_reply"]
        check(f"用例15 needs_reply={raw!r} -> {want!r}", got is want, f"实际={got!r}")

    # 模型没给 title_in_header 时绝不能默认 True（等于放弃这道防线）
    sf.call_cloud_vision = lambda *_a, **_k: {
        "success": True, "matched": True, "detected_title": MATCH_TITLE,
        "last_sender": "parent", "last_message_text": "在吗", "needs_reply": True,
    }
    res = sf.inspect_chat_view_via_vlm(None, TARGET_ID, TARGET_NAME)
    check("用例15 缺 title_in_header -> 不放行", res["status"] == "UNCERTAIN", f"status={res['status']}")
finally:
    sf.call_cloud_vision = _real_call

# ============ 用例 16：逐像素比较 ============
_I = sf._frames_identical
check("用例16 同内容同尺寸=一致", _I(_FakeImg(b"aaaa"), _FakeImg(b"aaaa")))
check("用例16 不同内容=不一致", not _I(_FakeImg(b"aaaa"), _FakeImg(b"aaab")))
check("用例16 尺寸不同=不一致", not _I(_FakeImg(b"aaaa", (2, 2)), _FakeImg(b"aaaa", (4, 4))))
check("用例16 None 永不误判为一致", not _I(None, _FakeImg(b"aaaa")) and not _I(_FakeImg(b"aaaa"), None))


# ============ 用例 17：等画面稳定（连拍两帧一致才采信） ============
class _FakeClock:
    def __init__(self, step=0.35):
        self.t = 0.0
        self.step = step
        self.slept = []

    def sleep(self, s):
        self.slept.append(s)
        self.t += max(float(s), self.step)

    def monotonic(self):
        return self.t


def _settle(frames, timeout=1.5, interval=0.3):
    """按 frames 序列喂图给 capture_chat_view_stable，返回 (用掉的帧数, 结果)。"""
    seq = list(frames)
    used = {"n": 0}

    def fake_cap(_rect):
        used["n"] += 1
        return seq.pop(0) if seq else None

    _real_cap, _real_time = sf.capture_wecom_full, sf.time
    try:
        sf.capture_wecom_full = fake_cap
        sf.time = _FakeClock(step=interval)
        img = sf.capture_chat_view_stable((0, 0, 1200, 800), settle_interval=interval, settle_timeout=timeout)
        return used["n"], img
    finally:
        sf.capture_wecom_full, sf.time = _real_cap, _real_time


# 内容在变 -> 继续等，直到两帧一致才采信
n, img = _settle([_FakeImg(b"A"), _FakeImg(b"B"), _FakeImg(b"C"), _FakeImg(b"SETTLED"), _FakeImg(b"SETTLED")])
check("用例17 内容变化时继续等", n == 5, f"拍了 {n} 帧")
check("用例17 采信稳定后的那一帧", img is not None and img.tobytes() == b"SETTLED", f"img={img and img.tobytes()}")

# 一上来就稳定 -> 只拍 2 帧就返回
n, img = _settle([_FakeImg(b"SAME"), _FakeImg(b"SAME")])
check("用例17 已稳定则立即返回", n == 2, f"拍了 {n} 帧")
check("用例17 返回的就是稳定帧", img.tobytes() == b"SAME", f"img={img.tobytes()}")

# 一直不稳定 -> 超时后仍返回最后一帧（交由身份闸门 fail-closed 裁决）
n, img = _settle([_FakeImg(b"a"), _FakeImg(b"b"), _FakeImg(b"c"), _FakeImg(b"d")], timeout=1.0, interval=0.3)
check("用例17 抖动耗尽时间仍给最后一帧", img is not None and img.tobytes() == b"d", f"n={n} img={img and img.tobytes()}")

# 第一帧就抓不到
n, img = _settle([None])
check("用例17 首帧抓不到返回None", img is None and n == 1, f"n={n} img={img}")

# ---- 已知局限（必须写进断言，免得后人误以为这里能挡住旧帧）----
# 真机已实证 WGC 在拿不到新表面时返回**内容稳定的陈旧帧**（wgc-minimized.png 与
# wgc-visible.png 的 md5 完全相同）。此时「两帧一致」判据完全失效，等稳定白等。
# 唯一的补救不是放宽判据，而是让身份闸门 fail-closed：陈旧帧读不到当前会话标题，
# 一律 UNCERTAIN → 拦截，绝不放行。下列断言锁死这条链路。
n, img = _settle([_FakeImg(b"STALE"), _FakeImg(b"STALE")])
check("用例17 局限：陈旧但稳定的帧照样会被采信(等稳定挡不住)", img is not None and img.tobytes() == b"STALE",
      "若这条失败说明等稳定逻辑被改动了，需重新评估")
check("用例17 局限的补救：陈旧帧读不到标题 -> fail-closed",
      _J(chat(status="MATCH", title="", title_in_header=False), TARGET_ID, TARGET_NAME) == "UNCERTAIN",
      "空标题必须判存疑而非放行")

# ============ 用例 18：整窗抓帧优先 WGC，失败回退 PyAutoGUI ============
_real_wgc, _real_vsb = sf.grab_wecom_via_wgc, sf.get_virtual_screen_bounds
try:
    seen = {}
    sf.get_virtual_screen_bounds = lambda: (0, 0, 1920, 1080)

    def fake_shot(region=None, **_k):
        # 必须显式 return 图：dict.setdefault 首次调用会**返回刚设进去的值**，
        # 用 `seen.setdefault(...) or img` 会把 region 元组当返回值，桩件自身成假阳性。
        seen["shot"] = region
        return _FakeImg(b"SCREEN")

    sf.grab_wecom_via_wgc = lambda *_a, **_k: _FakeImg(b"WGC")
    sf.pyautogui = types.SimpleNamespace(screenshot=fake_shot)
    check("用例18 WGC 命中时不碰屏幕像素", sf.capture_wecom_full((0, 0, 1200, 800)).tobytes() == b"WGC")
    check("用例18 WGC 命中时不调 pyautogui", "shot" not in seen, f"shot={seen.get('shot')}")

    sf.grab_wecom_via_wgc = lambda *_a, **_k: None
    sf.pyautogui = types.SimpleNamespace(screenshot=fake_shot)
    check("用例18 WGC 挂时回退屏幕像素", sf.capture_wecom_full((0, 0, 1200, 800)).tobytes() == b"SCREEN")
    check("用例18 回退时真的传了屏幕区域", seen.get("shot") == (0, 0, 1200, 800), f"shot={seen.get('shot')}")
finally:
    sf.grab_wecom_via_wgc, sf.get_virtual_screen_bounds = _real_wgc, _real_vsb

# WGC 不可用时只探测一次，不在每次抓帧时刷屏
_real_load, sf._WGC_CLASS, sf._WGC_PROBED = sf._load_wgc_class, None, False
try:
    check("用例18 未装 windows-capture 时判定为不可用", sf._load_wgc_class() is None, "应返回 None")
    check("用例18 探测结果被缓存", sf._WGC_PROBED is True, "应只探测一次")
finally:
    sf._load_wgc_class, sf._WGC_CLASS, sf._WGC_PROBED = _real_load, None, False

# ============ 用例 19：PyAutoGUI 兜底的出屏裁剪（真机已证伪路径的保护） ============
class _RegionImg:
    def __init__(self, region):
        self.region = region


def _screen_capture(rect, virtual=(0, 0, 1920, 1080)):
    seen = {}

    def fake_screenshot(region=None, **_k):
        seen["region"] = region
        return _RegionImg(region)

    _r_cap, _r_pya = sf.capture_wecom_full, sf.pyautogui
    _r_gwcb, _r_vsb = sf.grab_wecom_via_wgc, sf.get_virtual_screen_bounds
    try:
        sf.grab_wecom_via_wgc = lambda *_a, **_k: None  # 强制走屏幕像素
        sf.pyautogui = types.SimpleNamespace(screenshot=fake_screenshot)
        sf.get_virtual_screen_bounds = lambda: virtual
        img = sf.capture_wecom_full(rect)
        # 必须先跑完 capture 再读 seen：Python 从左到右求值，
        # 写成 `seen.get(...) , capture(...)` 会读到还没填的空字典。
        return seen.get("region"), img
    finally:
        sf.capture_wecom_full, sf.pyautogui = _r_cap, _r_pya
        sf.grab_wecom_via_wgc, sf.get_virtual_screen_bounds = _r_gwcb, _r_vsb


region, _ = _screen_capture((0, 31, 1920, 1049))
check("用例19 1080p整窗=窗口原尺寸", region == (0, 31, 1920, 1049), f"region={region}")
region, _ = _screen_capture((100, 50, 700, 600))
check("用例19 窄窗口仍取整窗(无宽度上限)", region == (100, 50, 700, 600), f"region={region}")
region, _ = _screen_capture((1500, 800, 1920, 1049), virtual=(0, 0, 1920, 1080))
check("用例19 超出屏幕右侧被裁剪", region[0] + region[2] <= 1920, f"region={region}")
check("用例19 超出屏幕下侧被裁剪", region[1] + region[3] <= 1080, f"region={region}")
region, _ = _screen_capture((-1920, 0, 1920, 1049), virtual=(-1920, 0, 3840, 1080))
check("用例19 负坐标显示器取整窗", region == (-1920, 0, 1920, 1049), f"region={region}")
region, img = _screen_capture((0, 0, 120, 100))
check("用例19 过小窗口返回None", img is None, f"img={img}")

# ============ 用例 20：整窗任务的超时预算 ============
check("用例20 chatview超时=30s", sf.VISION_TIMEOUT["chatview"] == 30.0, f"实际={sf.VISION_TIMEOUT['chatview']}")
check("用例20 等画面稳定有硬上限", sf.WGC_SETTLE_TIMEOUT > 0 and sf.WGC_FRAME_TIMEOUT > 0,
      f"settle={sf.WGC_SETTLE_TIMEOUT} frame={sf.WGC_FRAME_TIMEOUT}")
check("用例20 start() 有硬超时(否则会挂死发送线程)", "done.wait(WGC_FRAME_TIMEOUT)" in _SRC, "缺硬超时")

# ============ 用例 21：分隔符污染会把学生静默拦死 ============
# 源数据里混入中英文逗号时，旧正则 [\s\-_.、] 不含逗号，姓名被切成 '，张三'，
# 于是 `target_name in detected_title` 必然失败 —— 该学生三次重试全被拦，
# 日志却显示「会话标题与目标不符」，会被误诊成模型判错。
_real = _REAL_parse_student_identifier
for raw, want_id, want_name in [
    ("90001张三", "90001", "张三"),
    ("90001，张三", "90001", "张三"),        # 全角逗号
    ("90001,张三", "90001", "张三"),         # 半角逗号
    ("90001 张三", "90001", "张三"),
    ("90001、张三", "90001", "张三"),
    ("90001-张三", "90001", "张三"),
    ("90001_张三", "90001", "张三"),
    ("  90001张三  ", "90001", "张三"),
]:
    got_id, got_name = _real(raw)
    check(f"用例21 拆分 {raw.strip()!r}", (got_id, got_name) == (want_id, want_name), f"实际={got_id!r},{got_name!r}")
    check(f"用例21 {raw.strip()!r} 标题可匹配", got_name in MATCH_TITLE, f"name={got_name!r}")

got_id, got_name = _real("90001张，三")
check("用例21 姓名内部逗号保留", (got_id, got_name) == ("90001", "张，三"), f"实际={got_id!r},{got_name!r}")
check("用例21 无学号则整体为姓名", _real("张三") == ("", "张三"), f"实际={_real('张三')}")

# ============ 用例 22：复制按钮不得插入分隔符 ============
# 复制出来的文本要能直接粘进企微搜索框；夹一个全角逗号就匹配不到目标会话。
check(
    "用例22 复制文本不含全角逗号",
    'f"{sid}{sname}"' in _SRC and 'f"{sid}，{sname}"' not in _SRC,
    "复制文本仍插入了分隔符",
)

print()
if FAILED:
    print(f"❌ {len(FAILED)} 项未通过: {FAILED}")
    sys.exit(1)
print("✅ 全部通过")
