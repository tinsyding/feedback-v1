"""多引擎识别基准评测单元测试 (test_benchmark.py)"""

import unittest
from unittest import mock
import os
import sys

from sender_py import benchmark


class TestBenchmark(unittest.TestCase):
    """测试多引擎基准评测核心逻辑。"""

    def setUp(self):
        benchmark.set_benchmark_hook_for_testing(None)

    def tearDown(self):
        benchmark.set_benchmark_hook_for_testing(None)

    def test_evaluate_title_image_hook(self):
        """测试注入 Hook 时正确返回模拟的多引擎评测结果。"""
        def mock_hook(img, sid, sname, server, token):
            return {
                "qwen_flash": {"name": "Qwen3.8-Flash", "status": "ok", "matched": True, "text": "202401张三", "latency_ms": 350},
                "rapid_rec": {"name": "RapidOCR(纯识别)", "status": "ok", "matched": True, "text": "202401张三", "latency_ms": 12},
                "rapid_full": {"name": "RapidOCR(全流程)", "status": "ok", "matched": True, "text": "202401张三", "latency_ms": 48},
                "winocr": {"name": "winocr", "status": "ok", "matched": True, "text": "202401张三", "latency_ms": 20},
                "ps_winrt": {"name": "PowerShell WinRT", "status": "ok", "matched": True, "text": "202401张三", "latency_ms": 420},
            }, False, "RapidOCR(纯识别)"

        benchmark.set_benchmark_hook_for_testing(mock_hook)
        results, has_disc, fastest = benchmark.evaluate_title_image_all_engines(
            None, "202401", "张三", "https://mock.server", "tok"
        )
        self.assertFalse(has_disc)
        self.assertEqual(fastest, "RapidOCR(纯识别)")
        self.assertEqual(results["rapid_rec"]["latency_ms"], 12)
        self.assertTrue(results["qwen_flash"]["matched"])

    def test_discrepancy_detection(self):
        """测试当引擎之间识别结论不一致时，精准标记分歧。"""
        def mock_disc_hook(img, sid, sname, server, token):
            return {
                "qwen_flash": {"name": "Qwen3.8-Flash", "status": "ok", "matched": True, "text": "65405胡耔墨", "latency_ms": 320},
                "rapid_rec": {"name": "RapidOCR(纯识别)", "status": "ok", "matched": True, "text": "65405胡籽墨", "latency_ms": 14},
                "winocr": {"name": "winocr", "status": "ok", "matched": False, "text": "65405乱码墨", "latency_ms": 25},
            }, True, "RapidOCR(纯识别)"

        benchmark.set_benchmark_hook_for_testing(mock_disc_hook)
        results, has_disc, fastest = benchmark.evaluate_title_image_all_engines(
            None, "65405", "胡耔墨", "https://mock.server"
        )
        self.assertTrue(has_disc)
        self.assertEqual(fastest, "RapidOCR(纯识别)")
        self.assertFalse(results["winocr"]["matched"])
        self.assertTrue(results["qwen_flash"]["matched"])

    def test_compute_benchmark_summary(self):
        """测试基准评测全局汇总指标计算。"""
        records = [
            {
                "studentName": "202401张三",
                "sid": "202401",
                "sname": "张三",
                "has_discrepancy": False,
                "engines": {
                    "qwen_flash": {"status": "ok", "matched": True, "latency_ms": 300},
                    "rapid_rec": {"status": "ok", "matched": True, "latency_ms": 10},
                    "rapid_full": {"status": "ok", "matched": True, "latency_ms": 40},
                    "winocr": {"status": "ok", "matched": True, "latency_ms": 20},
                    "ps_winrt": {"status": "ok", "matched": True, "latency_ms": 400},
                }
            },
            {
                "studentName": "202402李四",
                "sid": "202402",
                "sname": "李四",
                "has_discrepancy": True,
                "engines": {
                    "qwen_flash": {"status": "ok", "matched": True, "latency_ms": 400},
                    "rapid_rec": {"status": "ok", "matched": True, "latency_ms": 20},
                    "rapid_full": {"status": "ok", "matched": False, "latency_ms": 60},
                    "winocr": {"status": "skipped", "matched": False, "latency_ms": 0},
                    "ps_winrt": {"status": "ok", "matched": False, "latency_ms": 500},
                }
            }
        ]

        summary = benchmark.compute_benchmark_summary(records)
        self.assertEqual(summary["total"], 2)
        self.assertEqual(summary["discrepancy_count"], 1)
        self.assertEqual(summary["discrepancy_rate_pct"], 50.0)

        engs = summary["engines"]
        # Qwen-Flash: 2/2 = 100%, avg latency = (300+400)/2 = 350.0
        self.assertEqual(engs["qwen_flash"]["match_rate_pct"], 100.0)
        self.assertEqual(engs["qwen_flash"]["avg_latency_ms"], 350.0)

        # RapidOCR (Rec-Only): 2/2 = 100%, avg latency = (10+20)/2 = 15.0
        self.assertEqual(engs["rapid_rec"]["match_rate_pct"], 100.0)
        self.assertEqual(engs["rapid_rec"]["avg_latency_ms"], 15.0)

        # RapidOCR (Det+Rec): 1/2 = 50%, avg latency = 50.0
        self.assertEqual(engs["rapid_full"]["match_rate_pct"], 50.0)
        self.assertEqual(engs["rapid_full"]["avg_latency_ms"], 50.0)

        # winocr: evaluated 1, matched 1 = 100%
        self.assertEqual(engs["winocr"]["evaluated_count"], 1)
        self.assertEqual(engs["winocr"]["match_rate_pct"], 100.0)

    def test_generate_benchmark_csv_content(self):
        """测试 CSV 导出内容格式完备性。"""
        records = [
            {
                "studentName": "202401张三",
                "sid": "202401",
                "sname": "张三",
                "has_discrepancy": False,
                "fastest": "RapidOCR(纯识别)",
                "engines": {
                    "qwen_flash": {"text": "202401张三", "matched": True, "latency_ms": 350},
                    "rapid_rec": {"text": "202401张三", "matched": True, "latency_ms": 12},
                    "rapid_full": {"text": "202401张三", "matched": True, "latency_ms": 50},
                    "winocr": {"text": "202401张三", "matched": True, "latency_ms": 22},
                    "ps_winrt": {"text": "202401张三", "matched": True, "latency_ms": 410},
                }
            }
        ]
        summary = benchmark.compute_benchmark_summary(records)
        csv_str = benchmark.generate_benchmark_csv_content(records, summary)

        self.assertIn("多引擎识别基准评测报告", csv_str)
        self.assertIn("Qwen3.8-Flash", csv_str)
        self.assertIn("RapidOCR(纯识别)", csv_str)
        self.assertIn("202401张三", csv_str)
        self.assertIn("350", csv_str)
        self.assertIn("12", csv_str)

    def test_benchmark_single_student_zero_send_safety(self):
        """核心安全红线测试：确保评测学生时绝不调用 paste_and_send。"""
        from sender_py import sender
        from sender_py import window_utils as wu

        mock_paste_send = mock.MagicMock(return_value=(True, ""))
        mock_search = mock.MagicMock(return_value=True)

        class DummyImg:
            size = (500, 400)
            def crop(self, box):
                return DummyImg()

        item = {
            "studentName": "90001测试生",
            "sid": "90001",
            "sname": "测试生",
            "message": "这是一条绝不应该发送出去的测试消息",
        }

        dummy_roi = {
            "title": (0.2, 0.0, 0.8, 0.1),
            "input": (0.2, 0.8, 0.8, 0.2),
            "chat": (0.2, 0.1, 0.8, 0.7),
        }

        with mock.patch.object(wu, "get_wecom_rect", return_value=(0, 0, 500, 400)), \
             mock.patch.object(wu, "get_dpi_scale", return_value=1.0), \
             mock.patch.object(wu, "find_and_activate_wecom", return_value=True), \
             mock.patch.object(benchmark, "ensure_roi", return_value=dummy_roi), \
             mock.patch.object(benchmark, "search_and_enter", mock_search), \
             mock.patch.object(benchmark, "check_and_handle_search_tab", return_value=False), \
             mock.patch.object(benchmark, "capture_wecom_window", return_value=DummyImg()), \
             mock.patch.object(sender, "paste_and_send", mock_paste_send):

            # 注入评测结果
            benchmark.set_benchmark_hook_for_testing(lambda img, sid, sname, srv, tok: ({
                "rapid_rec": {"name": "RapidOCR(纯识别)", "status": "ok", "matched": True, "text": "90001测试生", "latency_ms": 12}
            }, False, "RapidOCR(纯识别)"))

            res = benchmark.benchmark_single_student(
                item, server="https://mock.server", config_path=None, log=lambda m: None
            )

            self.assertTrue(res["success"])
            self.assertIsNotNone(res["record"])
            self.assertEqual(res["record"]["studentName"], "90001测试生")

            # 严格断言：paste_and_send 绝对未被调用！
            mock_paste_send.assert_not_called()

    def test_web_controller_benchmark_lifecycle(self):
        """测试 WebController 的基准评测生命周期管控。"""
        from sender_py.web_controller import WebController
        controller = WebController()
        controller.items = [
            {"_id": "1", "studentName": "202401张三", "sid": "202401", "sname": "张三", "_selected": True},
            {"_id": "2", "studentName": "202402李四", "sid": "202402", "sname": "李四", "_selected": True},
        ]

        # 1. 模拟评测单人返回
        def dummy_eval(item, *args, **kwargs):
            return {
                "success": True,
                "record": {
                    "studentName": item["studentName"],
                    "sid": item["sid"],
                    "sname": item["sname"],
                    "engines": {"rapid_rec": {"name": "RapidOCR(纯识别)", "status": "ok", "matched": True, "latency_ms": 11}},
                    "has_discrepancy": False,
                    "fastest": "RapidOCR(纯识别)"
                }
            }

        with mock.patch("sender_py.benchmark.benchmark_single_student", side_effect=dummy_eval):
            res = controller.start_benchmark()
            self.assertTrue(res["success"])
            self.assertEqual(res["total"], 2)

            # 等待工作线程执行完成
            if controller._benchmark_worker_thread:
                controller._benchmark_worker_thread.join(timeout=3.0)

            state = controller.get_benchmark_state()
            self.assertFalse(state["running"])
            self.assertEqual(len(state["records"]), 2)
            self.assertEqual(state["summary"]["total"], 2)

            csv_text, fname = controller.get_benchmark_csv_content()
            self.assertTrue(fname.startswith("OCR_Benchmark_"))
            self.assertIn("202401张三", csv_text)
            self.assertIn("202402李四", csv_text)


if __name__ == "__main__":
    unittest.main()
