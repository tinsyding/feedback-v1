"""针对 local_ocr.py 本地 OCR 备用核验的单元测试。"""

import unittest
from unittest.mock import patch

from sender_py.local_ocr import (
    detect_is_group,
    identify_title_local,
    normalize_clean,
    parse_title_judgment,
    set_ocr_hook_for_testing,
)


class LocalOcrTest(unittest.TestCase):
    def tearDown(self):
        set_ocr_hook_for_testing(None)

    def test_detect_is_group_patterns(self):
        # 纯数字括号：群聊人数特征
        self.assertTrue(detect_is_group("初一数学交流群(45)"))
        self.assertTrue(detect_is_group("王小明作业沟通（3）"))
        self.assertTrue(detect_is_group("研发组 ( 12 )"))

        # 群聊关键词
        self.assertTrue(detect_is_group("极方教师交流群"))
        self.assertTrue(detect_is_group("2024届家校沟通讨论组"))
        self.assertTrue(detect_is_group("初二全员群"))
        self.assertTrue(detect_is_group("李老师的班级群"))

        # 顿号或逗号分隔的中文多人名
        self.assertTrue(detect_is_group("张三、李四、王五"))
        self.assertTrue(detect_is_group("张三,李四"))

        # 正常个人会话（含非数字括号或单聊备注）
        self.assertFalse(detect_is_group("202401-张三"))
        self.assertFalse(detect_is_group("李四 (学生)"))
        self.assertFalse(detect_is_group("王五 (初二1班)"))
        self.assertFalse(detect_is_group("赵六"))
        self.assertFalse(detect_is_group(""))
        self.assertFalse(detect_is_group(None))

    def test_normalize_clean(self):
        self.assertEqual(normalize_clean(" 2024-001 _ 张三 "), "2024001张三")
        self.assertEqual(normalize_clean("Abc-123·李四"), "abc123李四")
        self.assertEqual(normalize_clean(""), "")
        self.assertEqual(normalize_clean(None), "")

    def test_parse_title_judgment_fail_closed_on_empty(self):
        res = parse_title_judgment("", "202401", "张三")
        self.assertFalse(res["matched"])
        self.assertFalse(res["is_group"])
        self.assertFalse(res["title_in_header"])
        self.assertEqual(res["detected_title"], "")
        self.assertIn("fail-closed", res["reason"])

    def test_parse_title_judgment_group_intercept(self):
        res = parse_title_judgment("初一数学交流群(45)", "202401", "张三")
        self.assertFalse(res["matched"])
        self.assertTrue(res["is_group"])
        self.assertTrue(res["title_in_header"])
        self.assertIn("群聊", res["reason"])

    def test_parse_title_judgment_match_success(self):
        # 同时包含学号与姓名
        res = parse_title_judgment("202401-张三 (极方学员)", "202401", "张三")
        self.assertTrue(res["matched"])
        self.assertFalse(res["is_group"])
        self.assertTrue(res["title_in_header"])
        self.assertEqual(res["detected_title"], "202401-张三 (极方学员)")
        self.assertIn("匹配成功", res["reason"])

    def test_parse_title_judgment_mismatch(self):
        # 名字对但学号不对
        res1 = parse_title_judgment("202499-张三", "202401", "张三")
        self.assertFalse(res1["matched"])
        self.assertIn("缺失学号[202401]", res1["reason"])

        # 学号对但名字不对
        res2 = parse_title_judgment("202401-李四", "202401", "张三")
        self.assertFalse(res2["matched"])
        self.assertIn("缺失姓名[张三]", res2["reason"])

    def test_identify_title_local_with_hook(self):
        # 模拟 OCR 提取到标题
        set_ocr_hook_for_testing(lambda img: "202405 王小明")
        res = identify_title_local(None, "202405", "王小明")
        self.assertTrue(res["matched"])
        self.assertFalse(res["is_group"])
        self.assertEqual(res["detected_title"], "202405 王小明")

    def test_option1_fuzzy_match_homoglyph_and_rare_characters(self):
        # 验证方案1：学号精确匹配(65405)，姓名支持1字形近/OCR误差(胡耔墨 vs 胡籽墨)
        res = parse_title_judgment("65405胡籽墨 @微信", "65405", "胡耔墨")
        self.assertTrue(res["matched"])
        self.assertFalse(res["is_group"])
        self.assertIn("命中形近容错", res["reason"])

        # 验证其他生僻字/形近字：如 峰 vs 夆
        res2 = parse_title_judgment("99001张夆 @微信", "99001", "张峰")
        self.assertTrue(res2["matched"])

        # 验证若是群聊，哪怕学号姓名都符合，依然坚决拦截
        res_group = parse_title_judgment("65405胡籽墨家校沟通群(3)", "65405", "胡耔墨")
        self.assertFalse(res_group["matched"])
        self.assertTrue(res_group["is_group"])

        # 验证如果人名完全风马牛不相及（差异大于1字），拒绝放行
        res_mismatch = parse_title_judgment("65405李四 @微信", "65405", "胡耔墨")
        self.assertFalse(res_mismatch["matched"])

    def test_identify_title_local_cascade_fallback(self):
        # 1. 模拟 winocr 抛异常/返回空（如缺失 projection table），由 RapidOCR 稳健兜底
        with patch("sender_py.local_ocr._ocr_via_winocr", return_value=""), \
             patch("sender_py.local_ocr._ocr_via_rapidocr", return_value="65405胡耔墨"):
            res = identify_title_local("dummy_img", "65405", "胡耔墨")
            self.assertTrue(res["matched"])
            self.assertEqual(res["engine"], "rapidocr")
            self.assertIn("RapidOCR全流程通过", res["reason"])

        # 2. 模拟 winocr 识别出了错误名字（未匹配），由 RapidOCR 兜底识别出正确名字
        with patch("sender_py.local_ocr._ocr_via_winocr", return_value="65405错误人名"), \
             patch("sender_py.local_ocr._ocr_via_rapidocr", return_value="65405胡耔墨"):
            res = identify_title_local("dummy_img", "65405", "胡耔墨")
            self.assertTrue(res["matched"])
            self.assertEqual(res["engine"], "rapidocr")
            self.assertIn("RapidOCR全流程通过", res["reason"])

        # 3. 模拟 winocr 成功匹配，直接 47ms 极速放行，不再调用 RapidOCR
        with patch("sender_py.local_ocr._ocr_via_winocr", return_value="65405胡耔墨"), \
             patch("sender_py.local_ocr._ocr_via_rapidocr") as mock_rapid:
            res = identify_title_local("dummy_img", "65405", "胡耔墨")
            self.assertTrue(res["matched"])
            self.assertEqual(res["engine"], "winocr")
            self.assertIn("winocr极速通过", res["reason"])
            mock_rapid.assert_not_called()

    def test_ocr_via_winocr_logs_warning_on_exception(self):
        from sender_py.local_ocr import _ocr_via_winocr
        with patch.dict("sys.modules", {"winocr": None}), \
             patch("sender_py.file_logger.write_log") as mock_write_log:
            res = _ocr_via_winocr("dummy_img")
            self.assertEqual(res, "")
            mock_write_log.assert_called()
            args, kwargs = mock_write_log.call_args
            self.assertIn("winocr调用异常", args[0])
            self.assertEqual(kwargs.get("level"), "WARNING")

    def test_rapidocr_probe_circuit_breaker_on_native_crash(self):
        """模拟子进程探活因原生指令集/DLL 崩溃返回 0xC000001D 时，自动熔断禁用 RapidOCR 并不再重试。"""
        from sender_py.local_ocr import (
            _get_rapidocr_engine,
            _probe_rapidocr_safe,
            reset_rapidocr_state_for_testing,
        )

        reset_rapidocr_state_for_testing()
        self.addCleanup(reset_rapidocr_state_for_testing)

        class _FakeProc:
            returncode = -1073741795  # 0xC000001D STATUS_ILLEGAL_INSTRUCTION
            stderr = b""

        with patch("subprocess.run", return_value=_FakeProc()) as mock_run, \
             patch("sender_py.file_logger.write_log") as mock_write_log:
            ok, detail = _probe_rapidocr_safe()
            self.assertFalse(ok)
            self.assertIn("0xC000001D", detail)

            # 首次调用 _get_rapidocr_engine 触发探活并熔断
            eng1 = _get_rapidocr_engine()
            self.assertIsNone(eng1)
            mock_write_log.assert_called()
            self.assertIn("已自动熔断禁用 RapidOCR", mock_write_log.call_args[0][0])

            # 再次调用 _get_rapidocr_engine 应直接命中熔断缓存，不再拉起子进程
            call_count_after_first = mock_run.call_count
            eng2 = _get_rapidocr_engine()
            self.assertIsNone(eng2)
            self.assertEqual(mock_run.call_count, call_count_after_first)

    def test_rapidocr_probe_uses_cli_flag_when_frozen(self):
        """打包为独立 exe 时，子进程探活必须走 --probe-rapidocr 而非 python -c。"""
        from sender_py.local_ocr import _probe_rapidocr_safe

        class _OkProc:
            returncode = 0
            stderr = b""

        with patch("sender_py.local_ocr._is_frozen_binary", return_value=True), \
             patch("subprocess.run", return_value=_OkProc()) as mock_run:
            ok, _ = _probe_rapidocr_safe()
            self.assertTrue(ok)
            cmd = mock_run.call_args[0][0]
            self.assertEqual(cmd[-1], "--probe-rapidocr")

    def test_judge_candidate_api_mode_skips_local_ocr(self):
        """verify_mode='api' 在 fast_title_only=True 时必须真正跳过本地 OCR，直接调用云端 API。"""
        from PIL import Image
        from sender_py import sender

        fake_img = Image.new("RGB", (986, 650), (255, 255, 255))
        fake_roi = {
            "title": (0.3, 0.0, 0.7, 0.1),
            "chat": (0.3, 0.1, 0.7, 0.6),
            "input": (0.3, 0.7, 0.7, 0.3),
        }
        api_judgment = {
            "matched": True,
            "is_group": False,
            "detected_title": "35404朱旻涵",
            "reason": "云端匹配",
        }

        with patch("sender_py.capture.capture_wecom_window", return_value=fake_img), \
             patch("sender_py.local_ocr.identify_title_local") as mock_local, \
             patch("sender_py.vision_api.identify_title", return_value=dict(api_judgment)) as mock_api, \
             patch("sender_py.debug_utils.save_candidate_snapshot", return_value={}):
            judgment, title, err, _ = sender.judge_candidate(
                (0, 0, 986, 650), fake_roi, "35404", "朱旻涵",
                "https://feedback.wxjifang.cn", token="t",
                fast_title_only=True, verify_mode="api",
            )
            mock_local.assert_not_called()
            mock_api.assert_called_once()
            self.assertIsNone(err)
            self.assertTrue(judgment["matched"])
            self.assertIn("[云端API直验]", judgment["reason"])
            self.assertEqual(title, "35404朱旻涵")

        # 云端报错时（非 ADMIN_FORCED_LOCAL_OCR），api 模式应返回错误而非静默触发本地 OCR
        with patch("sender_py.capture.capture_wecom_window", return_value=fake_img), \
             patch("sender_py.local_ocr.identify_title_local") as mock_local, \
             patch("sender_py.vision_api.identify_title", side_effect=RuntimeError("network down")):
            judgment, title, err, _ = sender.judge_candidate(
                (0, 0, 986, 650), fake_roi, "35404", "朱旻涵",
                "https://feedback.wxjifang.cn", token="t",
                fast_title_only=True, verify_mode="api",
            )
            mock_local.assert_not_called()
            self.assertIsNone(judgment)
            self.assertIn("network down", err)


if __name__ == "__main__":
    unittest.main()
