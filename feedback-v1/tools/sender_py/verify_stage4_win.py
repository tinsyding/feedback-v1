"""Windows 真机走查 S4：首次校准→保存→重进直接可用→改窗口大小→提示重校准."""
import os
import sys
_HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (os.path.dirname(_HERE), _HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)
try:
    from sender_py.window_utils import find_and_activate_wecom, get_wecom_rect, get_dpi_scale
    from sender_py.capture import capture_wecom_window
    from sender_py.roi_manager import needs_calibration, save_roi, signature_key
    from sender_py.roi_calibrator import run_calibration
except ModuleNotFoundError:
    from window_utils import find_and_activate_wecom, get_wecom_rect, get_dpi_scale
    from capture import capture_wecom_window
    from roi_manager import needs_calibration, save_roi, signature_key
    from roi_calibrator import run_calibration
CFG = os.path.join(os.environ.get("TEMP", "."), "sender_py_debug_roi_config.json")
rect = get_wecom_rect()
print("rect=", rect, "scale=", get_dpi_scale(), flush=True)
key = signature_key(rect[2], rect[3], get_dpi_scale())
print("sig=", key, "need_calib=", needs_calibration(CFG, key), flush=True)
try:
    if find_and_activate_wecom():
        import time as _t
        _t.sleep(0.4)
        rect = get_wecom_rect() or rect
except Exception:
    pass
img = capture_wecom_window(rect)
print("shot=", None if img is None else img.size, flush=True)
print("已弹出校准窗口（标题“ROI 校准”，任务栏有图标）：先点“知道了，开始框选”，再框两框；控制台在此等你确认/放弃。", flush=True)
roi = run_calibration(None, img)
print("roi=", None if roi is None else "got2boxes", flush=True)
if roi is not None:
    save_roi(CFG, key, roi["title"], roi["input"], roi["chat"])
    print("saved=", CFG, "reenter_usable=", not needs_calibration(CFG, key), flush=True)
