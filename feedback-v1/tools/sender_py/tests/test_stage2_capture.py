"""阶段 2 单测（Linux 可全跑）：尺寸门槛 + crop_by_rel 边界，桩件内存图无 Pillow 依赖。"""

import unittest

from sender_py.capture import capture_wecom_window, crop_by_rel
from sender_py import window_utils


class _StubImg:
    def __init__(self, w, h):
        self.size = (w, h)
        self.box = None

    def crop(self, box):
        self.box = box
        x0, y0, x1, y1 = box
        return (x1 - x0, y1 - y0)


class TestStage2(unittest.TestCase):
    def test_size_guard_returns_none_without_mss(self):
        self.assertIsNone(capture_wecom_window((0, 0, 199, 800)))
        self.assertIsNone(capture_wecom_window((0, 0, 800, 149)))
        self.assertIsNone(capture_wecom_window(None))  # Linux 无 win32 → None
        self.assertIsNone(capture_wecom_window(()))

    def test_window_utils_linux_safe(self):
        self.assertIsNone(window_utils.get_wecom_hwnd())
        self.assertIsNone(window_utils.get_wecom_rect())
        self.assertEqual(window_utils.get_dpi_scale(), 1.0)
        self.assertFalse(window_utils.set_per_monitor_dpi_awareness())
        ok, res = window_utils.restore_and_center_wecom()
        self.assertFalse(ok)
        self.assertIn("win32", res)

    def test_crop_center(self):
        img = _StubImg(1000, 800)
        self.assertEqual(crop_by_rel(img, (0.25, 0.25, 0.5, 0.5)), (500, 400))
        self.assertEqual(img.box, (250, 200, 750, 600))

    def test_crop_clamp_overflow(self):
        img = _StubImg(1000, 800)
        self.assertEqual(crop_by_rel(img, (0.9, 0.9, 0.5, 0.5)), (100, 80))
        self.assertEqual(img.box, (900, 720, 1000, 800))

    def test_crop_clamp_negative(self):
        img = _StubImg(1000, 800)
        w, h = crop_by_rel(img, (-0.1, -0.1, 0.3, 0.3))
        self.assertEqual((w, h), (300, 240))
        self.assertEqual(img.box, (0, 0, 300, 240))


if __name__ == "__main__":
    unittest.main()
