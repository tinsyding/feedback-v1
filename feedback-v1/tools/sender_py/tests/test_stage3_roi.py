"""阶段 3 单测（Linux 全测）：正常反推、非法 case、越界 rel、tail 上下限。"""

import json
import os
import tempfile
import unittest

from sender_py import roi_manager as rm


class _StubImg:
    def __init__(self, w, h):
        self.size = (w, h)
        self.box = None

    def crop(self, box):
        self.box = box
        x0, y0, x1, y1 = box
        return (x1 - x0, y1 - y0)


class TestRoi(unittest.TestCase):
    def test_signature_key(self):
        sig = rm.window_signature(1241, 1070, 1.25)
        self.assertEqual(sig, {"w": 1241, "h": 1070, "scale": 1.25})
        self.assertEqual(rm.signature_key(1241, 1070, 1.25), "1241x1070@1.250")
        self.assertEqual(rm.signature_key(800, 600, 1.23456), "800x600@1.235")

    def test_derive_normal(self):
        chat = rm.derive_chat((0, 0, 1000, 60), (0, 700, 1000, 100), (1000, 800))
        self.assertEqual(chat, (0, 60, 1000, 640))

    def test_derive_offset_x(self):
        chat = rm.derive_chat((300, 10, 700, 50), (280, 700, 720, 100), (1000, 800))
        self.assertEqual(chat, (280, 60, 720, 640))

    def test_derive_input_over_title(self):
        with self.assertRaises(ValueError) as ctx:
            rm.derive_chat((0, 100, 500, 60), (0, 120, 500, 60), (1000, 800))
        self.assertIn("重", str(ctx.exception))

    def test_derive_chat_too_short(self):
        with self.assertRaises(ValueError) as ctx:
            rm.derive_chat((0, 0, 500, 60), (0, 80, 500, 60), (1000, 800))
        self.assertIn("重新校准", str(ctx.exception))

    def test_validate_rel(self):
        self.assertTrue(rm.validate_rel((0.1, 0.1, 0.8, 0.8)))
        self.assertFalse(rm.validate_rel((0.9, 0.9, 0.5, 0.5)))
        self.assertFalse(rm.validate_rel((-0.1, 0, 0.5, 0.5)))
        self.assertFalse(rm.validate_rel((0, 0, 0, 0.5)))

    def test_rel_roundtrip(self):
        box = (280, 60, 720, 640)
        rel = rm.to_rel(box, (1000, 800))
        self.assertTrue(rm.validate_rel(rel))
        self.assertEqual(rm.to_abs(rel, (1000, 800)), box)

    def test_tail_clamps(self):
        tall = _StubImg(800, 2000)
        self.assertEqual(rm.crop_chat_tail(tall), (800, 560))  # 2000*0.28=560 封顶
        mid = _StubImg(800, 400)
        self.assertEqual(rm.crop_chat_tail(mid), (800, 160))  # 112→160 保底
        tiny = _StubImg(800, 100)
        self.assertEqual(rm.crop_chat_tail(tiny), (800, 100))  # 不足160取整张

    def test_needs_calibration(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "roi_config.json")
            self.assertTrue(rm.needs_calibration(p, "1x1@1.000"))  # 无文件
            rm.save_roi(p, "1241x1070@1.250", (0, 0, 1, 0.05), (0, 0.9, 1, 0.1), (0, 0.05, 1, 0.85))
            self.assertFalse(rm.needs_calibration(p, "1241x1070@1.250"))
            self.assertTrue(rm.needs_calibration(p, "800x600@1.000"))  # 签名未命中
            with open(p, "w", encoding="utf-8") as f:  # ROI 非法
                json.dump({"signatures": {"k": {"title": [9, 9, 9, 9], "input": [0, 0, 1, 1], "chat": [0, 0, 1, 1]}}}, f)
            self.assertTrue(rm.needs_calibration(p, "k"))
            with self.assertRaises(ValueError):  # 存非法 rel 直接拦
                rm.save_roi(p, "k2", (9, 9, 9, 9), (0, 0, 1, 1), (0, 0, 1, 1))


if __name__ == "__main__":
    unittest.main()
