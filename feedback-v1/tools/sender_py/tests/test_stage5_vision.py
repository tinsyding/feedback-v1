"""阶段 5 单测（Linux 全测）：判定映射三态 + fail-closed 默认。无需 requests/PIL。"""

import unittest

from sender_py.vision_api import (
    DEFAULT_SENDER_TOKEN, IDENTIFY_PATH, load_token, map_response,
)


class TestStage5(unittest.TestCase):
    def test_path(self):
        self.assertEqual(IDENTIFY_PATH, "/api/identify.php")

    def test_match_true(self):
        out = map_response({
            "matched": True, "is_group": False, "title_in_header": True,
            "detected_title": "90001张三", "last_sender": "parent",
            "last_message_text": "老师好", "needs_reply": True,
            "reason": "ok", "duration_ms": 123,
        })
        self.assertTrue(out["matched"])
        self.assertFalse(out["is_group"])
        self.assertEqual(out["last_sender"], "parent")
        self.assertTrue(out["needs_reply"])
        self.assertEqual(out["duration_ms"], 123)

    def test_group_intercept_shape(self):
        out = map_response({"matched": False, "is_group": True, "detected_title": "数学群"})
        self.assertFalse(out["matched"])
        self.assertTrue(out["is_group"])

    def test_needs_reply_tristate(self):
        self.assertTrue(map_response({"needs_reply": True})["needs_reply"] is True)
        self.assertTrue(map_response({"needs_reply": False})["needs_reply"] is False)
        self.assertIsNone(map_response({"needs_reply": None})["needs_reply"])
        self.assertIsNone(map_response({})["needs_reply"])  # 缺失→待人工确认（fail-open 由调用方定）

    def test_fail_closed_defaults(self):
        out = map_response({})
        self.assertFalse(out["matched"])  # 缺失不放行
        self.assertFalse(out["is_group"])
        self.assertIsNone(out["last_sender"])  # 缺失即 null（无信息），非法字符串才归 unknown
        out2 = map_response({"matched": 1, "last_sender": "hacker"})
        self.assertFalse(out2["matched"])
        self.assertEqual(out2["last_sender"], "unknown")

    def test_bad_input(self):
        with self.assertRaises(ValueError):
            map_response(None)
        with self.assertRaises(ValueError):
            map_response("ok")

    def test_token_sources(self):
        import os
        os.environ["SENDER_API_TOKEN"] = "abc"
        try:
            self.assertEqual(load_token(), "abc")
            self.assertEqual(load_token("zzz"), "zzz")
        finally:
            del os.environ["SENDER_API_TOKEN"]
        self.assertEqual(load_token(), DEFAULT_SENDER_TOKEN)

    def test_calibrate_roi_path_and_guards(self):
        from sender_py.vision_api import CALIBRATE_ROI_PATH, calibrate_roi
        self.assertEqual(CALIBRATE_ROI_PATH, "/api/calibrate_roi.php")
        self.assertIsNone(calibrate_roi(None, "https://feedback.wxjifang.cn"))
        self.assertIsNone(calibrate_roi("invalid", "not-a-valid-url"))

    def test_detect_sidebar_guards_and_mapping(self):
        import sys
        import types
        from unittest import mock
        from sender_py.vision_api import detect_sidebar

        class _StubImg:
            size = (400, 300)

            def save(self, buf, format="PNG"):
                buf.write(b"fake-png")

        fake_pil_image = types.SimpleNamespace(LANCZOS=1)
        fake_pil = types.SimpleNamespace(Image=fake_pil_image)
        fake_resp = mock.MagicMock()
        fake_resp.status_code = 200
        fake_resp.json.return_value = {
            "success": True,
            "data": {
                "has_sidebar": True,
                "sidebar_title": "学员详情",
                "reason": "右侧存在学员详情侧边栏",
                "duration_ms": 321,
            },
        }
        fake_requests = types.SimpleNamespace(post=mock.MagicMock(return_value=fake_resp))

        with mock.patch.dict(sys.modules, {
            "PIL": fake_pil,
            "PIL.Image": fake_pil_image,
            "requests": fake_requests,
        }):
            with self.assertRaises(RuntimeError):
                detect_sidebar(None, "https://feedback.wxjifang.cn")
            img = _StubImg()
            with self.assertRaises(RuntimeError):
                detect_sidebar(img, "not-a-url")

            res = detect_sidebar(
                img, "https://feedback.wxjifang.cn",
                token="tok", target_id="55650", target_name="徐思琪",
            )
        self.assertTrue(res["has_sidebar"])
        self.assertEqual(res["sidebar_title"], "学员详情")
        self.assertEqual(res["duration_ms"], 321)
        self.assertEqual(fake_requests.post.call_args.kwargs["data"]["mode"], "sidebar")
        self.assertIn("image_window", fake_requests.post.call_args.kwargs["files"])


if __name__ == "__main__":
    unittest.main()
