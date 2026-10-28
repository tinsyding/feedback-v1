"""阶段 2 单测（Linux 可全跑）：尺寸门槛 + crop_by_rel 边界，桩件内存图无 Pillow 依赖。"""

import unittest
from unittest import mock

from sender_py.capture import capture_wecom_window, crop_by_rel, _is_all_black, _is_invalid_or_incomplete
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
        self.assertFalse(window_utils.is_window_zoomed(None))
        self.assertFalse(window_utils.is_window_iconic(None))
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

    def test_is_all_black_helper(self):
        class MockImgBlack:
            def getextrema(self):
                return ((0, 0), (0, 0), (0, 0))

        class MockImgNormal:
            def getextrema(self):
                return ((0, 255), (0, 128), (0, 64))

        self.assertTrue(_is_all_black(MockImgBlack()))
        self.assertFalse(_is_all_black(MockImgNormal()))

    def test_is_invalid_or_incomplete_helper(self):
        class MockFullImg:
            def __init__(self, global_ext, corner_ext):
                self._g = global_ext
                self._c = corner_ext
            def getextrema(self):
                return self._g
            def crop(self, box):
                class MockCorner:
                    def __init__(self, c): self._c = c
                    def getextrema(self): return self._c
                return MockCorner(self._c)

        # 全黑 -> 无效
        self.assertTrue(_is_invalid_or_incomplete(
            MockFullImg(((0, 0), (0, 0), (0, 0)), ((0, 0), (0, 0), (0, 0))), 1000, 800
        ))
        # 单色死图 (全白) -> 无效
        self.assertTrue(_is_invalid_or_incomplete(
            MockFullImg(((255, 255), (255, 255), (255, 255)), ((255, 255), (255, 255), (255, 255))), 1000, 800
        ))
        # 没截全（全局有内容，但右下角全是黑底0） -> 判定为不完整截断，触发降级
        self.assertTrue(_is_invalid_or_incomplete(
            MockFullImg(((0, 255), (0, 255), (0, 255)), ((0, 0), (0, 0), (0, 0))), 1000, 800
        ))
        # 正常全图（全局有内容，右下角也有内容） -> 有效通过
        self.assertFalse(_is_invalid_or_incomplete(
            MockFullImg(((0, 255), (0, 255), (0, 255)), ((20, 240), (20, 240), (20, 240))), 1000, 800
        ))

    def test_dual_engine_fallback_logic(self):
        # 1. 当 PrintWindow 成功返回正常图像时，优先采用
        mock_pw_img = _StubImg(1086, 650)
        with mock.patch("sender_py.capture._capture_by_printwindow", return_value=mock_pw_img), \
             mock.patch("sender_py.capture._capture_by_mss") as mock_mss:
            res = capture_wecom_window(rect=(100, 100, 1086, 650), hwnd=12345)
            self.assertEqual(res, mock_pw_img)
            mock_mss.assert_not_called()

        # 2. 当 PrintWindow 失败返回 None（如黑屏或不受支持）时，自动降级调用 mss
        mock_mss_img = _StubImg(1086, 650)
        with mock.patch("sender_py.capture._capture_by_printwindow", return_value=None), \
             mock.patch("sender_py.capture._capture_by_mss", return_value=mock_mss_img) as mock_mss:
            res = capture_wecom_window(rect=(100, 100, 1086, 650), hwnd=12345)
            self.assertEqual(res, mock_mss_img)
            mock_mss.assert_called_once()


if __name__ == "__main__":
    unittest.main()
