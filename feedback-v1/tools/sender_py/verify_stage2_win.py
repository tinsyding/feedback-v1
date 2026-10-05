"""Windows 真机验证：打印 rect + 存整窗图，人眼确认截到完整企微窗口。另充当 mss 签名实测.

运行位置（二选一）：
  A. 仓库结构：cd feedback-v1/tools && python sender_py/verify_stage2_win.py
  B. 散装拷贝（把 sender_py 内文件拷到某目录）：cd 该目录 && python verify_stage2_win.py
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (os.path.dirname(_HERE), _HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)
try:
    from sender_py.window_utils import set_per_monitor_dpi_awareness, get_wecom_rect, get_dpi_scale
    from sender_py.capture import capture_wecom_window
except ModuleNotFoundError:
    from window_utils import set_per_monitor_dpi_awareness, get_wecom_rect, get_dpi_scale
    from capture import capture_wecom_window
set_per_monitor_dpi_awareness()
rect = get_wecom_rect()
print("rect=", rect, "scale=", get_dpi_scale())
img = capture_wecom_window(rect)
print("shot=", None if img is None else img.size)
if img is not None:
    out = os.path.join(os.environ.get("TEMP", "."), "sender_py_debug_wecom_full.png")
    img.save(out)
    print("saved=", out)
