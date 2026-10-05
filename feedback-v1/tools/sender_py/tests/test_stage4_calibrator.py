"""阶段 4 单测（Linux 全测）：Fit 映射 roundtrip + 确认门槛。tkinter 不导入。"""

import unittest

from sender_py.roi_calibrator import (
    GUIDE_TEXT, canvas_to_orig, fit_scale, orig_to_canvas, validate_boxes,
)


class TestStage4(unittest.TestCase):
    def test_guide_text(self):
        self.assertIn("标题栏", GUIDE_TEXT)
        self.assertIn("输入框", GUIDE_TEXT)
        self.assertIn("自动", GUIDE_TEXT)

    def test_fit_centered(self):
        s, ox, oy, dw, dh = fit_scale(1241, 1070, 1000, 640)
        self.assertAlmostEqual(s, min(1000 / 1241, 640 / 1070), places=9)
        self.assertAlmostEqual(ox, (1000 - 1241 * s) / 2, places=9)
        self.assertAlmostEqual(oy, (640 - 1070 * s) / 2, places=9)

    def test_mapping_roundtrip(self):
        s, ox, oy, _, _ = fit_scale(1000, 800, 500, 400)
        cx, cy = orig_to_canvas(280, 60, s, ox, oy)
        self.assertEqual(canvas_to_orig(cx, cy, s, ox, oy), (280, 60))

    def test_validate_ok(self):
        ok, _ = validate_boxes((0, 0, 1000, 60), (0, 700, 1000, 100), (1000, 800))
        self.assertTrue(ok)

    def test_validate_empty(self):
        ok, msg = validate_boxes((0, 0, 0, 0), (0, 700, 1000, 100), (1000, 800))
        self.assertFalse(ok)
        self.assertIn("拖", msg)

    def test_validate_too_small(self):
        ok, msg = validate_boxes((0, 0, 30, 60), (0, 700, 1000, 100), (1000, 800))
        self.assertFalse(ok)
        self.assertIn("40", msg)

    def test_validate_overlap(self):
        ok, msg = validate_boxes((0, 100, 500, 60), (0, 120, 500, 60), (1000, 800))
        self.assertFalse(ok)
        self.assertIn("标题栏", msg)

    def test_validate_outside(self):
        ok, msg = validate_boxes((900, 0, 200, 60), (0, 700, 1000, 100), (1000, 800))
        self.assertFalse(ok)
        self.assertIn("图内", msg)


if __name__ == "__main__":
    unittest.main()
