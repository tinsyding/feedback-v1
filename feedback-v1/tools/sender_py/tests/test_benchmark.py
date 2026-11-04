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
                "winocr": {"name": "winocr", "status": "ok", "matched": True, "text": "202401张三", "latency_ms": 20},
                "rapid_full": {"name": "RapidOCR(全流程)", "status": "ok", "matched": True, "text": "202401张三", "latency_ms": 48},
                "qwen_flash": {"name": "Qwen3.8-Flash", "status": "ok", "matched": True, "text": "202401张三", "latency_ms": 350},
            }, False, "winocr"

        benchmark.set_benchmark_hook_for_testing(mock_hook)
        results, has_disc, fastest = benchmark.evaluate_title_image_all_engines(
            None, "202401", "张三", "https://mock.server", "tok"
        )
        self.assertFalse(has_disc)
        self.assertEqual(fastest, "winocr")
        self.assertEqual(results["winocr"]["latency_ms"], 20)
        self.assertTrue(results["qwen_flash"]["matched"])

    def test_discrepancy_detection(self):
        """测试当引擎之间识别结论不一致时，精准标记分歧。"""
        def mock_disc_hook(img, sid, sname, server, token):
            return {
                "winocr": {"name": "winocr", "status": "ok", "matched": False, "text": "65405乱码墨", "latency_ms": 25},
                "rapid_full": {"name": "RapidOCR(全流程)", "status": "ok", "matched": True, "text": "65405胡耔墨", "latency_ms": 50},
                "qwen_flash": {"name": "Qwen3.8-Flash", "status": "ok", "matched": True, "text": "65405胡耔墨", "latency_ms": 320},
            }, True, "winocr"

        benchmark.set_benchmark_hook_for_testing(mock_disc_hook)
        results, has_disc, fastest = benchmark.evaluate_title_image_all_engines(
            None, "65405", "胡耔墨", "https://mock.server"
        )
        self.assertTrue(has_disc)
        self.assertEqual(fastest, "winocr")
        self.assertFalse(results["winocr"]["matched"])
        self.assertTrue(results["rapid_full"]["matched"])
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
                    "winocr": {"status": "ok", "matched": True, "latency_ms": 20},
                    "rapid_full": {"status": "ok", "matched": True, "latency_ms": 40},
                    "qwen_flash": {"status": "ok", "matched": True, "latency_ms": 300},
                }
            },
            {
                "studentName": "202402李四",
                "sid": "202402",
                "sname": "李四",
                "has_discrepancy": True,
                "engines": {
                    "winocr": {"status": "skipped", "matched": False, "latency_ms": 0},
                    "rapid_full": {"status": "ok", "matched": False, "latency_ms": 60},
                    "qwen_flash": {"status": "ok", "matched": True, "latency_ms": 400},
                }
            }
        ]

        summary = benchmark.compute_benchmark_summary(records)
        self.assertEqual(summary["total"], 2)
        self.assertEqual(summary["discrepancy_count"], 1)
        self.assertEqual(summary["discrepancy_rate_pct"], 50.0)

        engs = summary["engines"]
        # winocr: evaluated 1, matched 1 = 100%
        self.assertEqual(engs["winocr"]["evaluated_count"], 1)
        self.assertEqual(engs["winocr"]["match_rate_pct"], 100.0)

        # RapidOCR (Det+Rec): 1/2 = 50%, avg latency = 50.0
        self.assertEqual(engs["rapid_full"]["match_rate_pct"], 50.0)
        self.assertEqual(engs["rapid_full"]["avg_latency_ms"], 50.0)

        # Qwen-Flash: 2/2 = 100%, avg latency = (300+400)/2 = 350.0
        self.assertEqual(engs["qwen_flash"]["match_rate_pct"], 100.0)
        self.assertEqual(engs["qwen_flash"]["avg_latency_ms"], 350.0)

    def test_generate_benchmark_csv_content(self):
        """测试 CSV 导出内容格式完备性。"""
        records = [
            {
                "studentName": "202401张三",
                "sid": "202401",
                "sname": "张三",
                "has_discrepancy": False,
                "fastest": "winocr",
                "engines": {
                    "winocr": {"text": "202401张三", "matched": True, "latency_ms": 22},
                    "rapid_full": {"text": "202401张三", "matched": True, "latency_ms": 50},
                    "qwen_flash": {"text": "202401张三", "matched": True, "latency_ms": 350},
                }
            }
        ]
        summary = benchmark.compute_benchmark_summary(records)
        csv_str = benchmark.generate_benchmark_csv_content(records, summary)

        self.assertIn("多引擎识别基准评测报告", csv_str)
        self.assertIn("winocr", csv_str)
        self.assertIn("RapidOCR(全流程)", csv_str)
        self.assertIn("Qwen3.8-Flash", csv_str)
        self.assertIn("202401张三", csv_str)
        self.assertIn("350", csv_str)

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

    def test_web_controller_benchmark_fallback_to_all_when_unselected(self):
        """测试当所有学生均未被勾选（例如发送完毕后自动取消勾选），自动兜底为全员评测。"""
        from sender_py.web_controller import WebController
        controller = WebController()
        controller.items = [
            {"_id": "1", "studentName": "202401张三", "sid": "202401", "sname": "张三", "_selected": False},
            {"_id": "2", "studentName": "202402李四", "sid": "202402", "sname": "李四", "_selected": False},
        ]
        with mock.patch("sender_py.benchmark.benchmark_single_student", return_value={"success": True, "record": None}):
            res = controller.start_benchmark()
            self.assertTrue(res["success"])
            self.assertEqual(res["total"], 2)
            if controller._benchmark_worker_thread:
                controller._benchmark_stop_requested = True
                controller._benchmark_worker_thread.join(timeout=2.0)

    def test_web_ui_html_defines_escape_html(self):
        """测试 web_ui.html 必须定义 escapeHtml 函数，防止评测结果渲染时抛出未定义异常。"""
        cur_dir = os.path.dirname(os.path.abspath(__file__))
        web_ui_path = os.path.join(os.path.dirname(cur_dir), "web_ui.html")
        with open(web_ui_path, "r", encoding="utf-8") as f:
            content = f.read()
        self.assertIn("function escapeHtml(", content)
        self.assertIn(".replace(/&/g, \"&amp;\")", content)

    def test_sender_app_token_attribute_exists(self):
        """测试 SenderApp 必须具备 token 属性，防止基准评测抛出 AttributeError。"""
        from sender_py import sender
        dummy_root = mock.MagicMock()
        dummy_root.winfo_screenwidth.return_value = 1920
        dummy_root.winfo_screenheight.return_value = 1080
        mock_tk = mock.MagicMock()
        mock_ttk = mock.MagicMock()
        def fake_build_ui(inst):
            inst.search_var = mock.MagicMock()
        with mock.patch.dict(sys.modules, {"tkinter": mock_tk, "tkinter.ttk": mock_ttk}), \
             mock.patch.object(sender.SenderApp, "_build_ui", side_effect=fake_build_ui, autospec=True), \
             mock.patch.object(sender.SenderApp, "_setup_appearance", return_value=None), \
             mock.patch.object(sender.SenderApp, "update_file_pool_ui", return_value=None), \
             mock.patch.object(sender.SenderApp, "rebuild_student_list", return_value=None):
            app = sender.SenderApp(dummy_root, [], "https://mock.server", "archive")
            self.assertTrue(hasattr(app, "token"))


if __name__ == "__main__":
    unittest.main()
