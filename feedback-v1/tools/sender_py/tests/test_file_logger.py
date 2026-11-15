"""测试本地日志持久化与错误警告分流模块 (file_logger.py)。"""

import datetime
import os
import shutil
import tempfile
import time
import unittest

from sender_py import file_logger
from sender_py.web_controller import WebController


class TestFileLogger(unittest.TestCase):

    def setUp(self):
        self.test_dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_write_normal_log(self):
        all_path, err_path = file_logger.write_log("正常初始化完成", base_dir=self.test_dir)
        self.assertTrue(os.path.isfile(all_path))
        self.assertFalse(os.path.exists(err_path))

        with open(all_path, "r", encoding="utf-8") as f:
            content = f.read()
        self.assertIn("[INFO]", content)
        self.assertIn("正常初始化完成", content)

    def test_write_warning_and_error_log(self):
        # 警告：包含 ⚠️
        all_path, err_path = file_logger.write_log("⚠️ [张三] 未在本地搜索到联系人", base_dir=self.test_dir)
        self.assertTrue(os.path.isfile(all_path))
        self.assertTrue(os.path.isfile(err_path))

        # 错误：包含 ❌ 与异常
        try:
            raise ValueError("测试异常堆栈")
        except Exception as e:
            file_logger.write_log("❌ 发送任务异常中止", exc_info=e, base_dir=self.test_dir)

        with open(err_path, "r", encoding="utf-8") as f:
            err_content = f.read()

        self.assertIn("[WARNING] ⚠️ [张三] 未在本地搜索到联系人", err_content)
        self.assertIn("[ERROR] ❌ 发送任务异常中止", err_content)
        self.assertIn("ValueError: 测试异常堆栈", err_content)

    def test_list_and_read_log_files(self):
        file_logger.write_log("普通日志 1", base_dir=self.test_dir)
        file_logger.write_log("错误日志 2 ❌ 失败", base_dir=self.test_dir)

        files = file_logger.list_log_files(base_dir=self.test_dir)
        self.assertGreaterEqual(len(files), 2)
        names = [f["name"] for f in files]
        today = datetime.datetime.now().strftime("%Y-%m-%d")
        self.assertIn(f"sender_{today}.log", names)
        self.assertIn(f"error_{today}.log", names)

        # 测试安全读取
        content = file_logger.read_log_file(f"sender_{today}.log", max_lines=10, base_dir=self.test_dir)
        self.assertIn("普通日志 1", content)
        self.assertIn("错误日志 2", content)

        # 测试防穿越安全检查
        bad_res = file_logger.read_log_file("../secret.txt", base_dir=self.test_dir)
        self.assertIn("只允许读取 .log 文件", bad_res)

    def test_cleanup_old_logs(self):
        logs_dir = file_logger.get_logs_dir(self.test_dir)
        old_file = os.path.join(logs_dir, "sender_2020-01-01.log")
        with open(old_file, "w", encoding="utf-8") as f:
            f.write("古老的日志")
        # 修改文件时间戳为 40 天前
        past_time = time.time() - (40 * 86400)
        os.utime(old_file, (past_time, past_time))

        file_logger.write_log("新日志", base_dir=self.test_dir)

        removed = file_logger.cleanup_old_logs(max_days=30, base_dir=self.test_dir)
        self.assertEqual(removed, 1)
        self.assertFalse(os.path.exists(old_file))

    def test_web_controller_emit_integration(self):
        # 覆盖 file_logger.default_storage_base_dir 目录为测试临时目录
        orig_fn = file_logger.default_storage_base_dir
        file_logger.default_storage_base_dir = lambda: self.test_dir
        try:
            ctrl = WebController()
            ctrl.emit("测试控制器普通日志")
            ctrl.emit("测试控制器报警 ⚠️ 未匹配")

            today = datetime.datetime.now().strftime("%Y-%m-%d")
            logs_dir = os.path.join(self.test_dir, "logs")
            all_log = os.path.join(logs_dir, f"sender_{today}.log")
            err_log = os.path.join(logs_dir, f"error_{today}.log")

            self.assertTrue(os.path.isfile(all_log))
            self.assertTrue(os.path.isfile(err_log))

            with open(err_log, "r", encoding="utf-8") as f:
                content = f.read()
            self.assertIn("测试控制器报警 ⚠️ 未匹配", content)
            self.assertNotIn("测试控制器普通日志", content)
        finally:
            file_logger.default_storage_base_dir = orig_fn

    def test_teacher_note_and_client_identity(self):
        self.assertEqual(file_logger.get_teacher_note(base_dir=self.test_dir), "")
        saved = file_logger.set_teacher_note("  张老师-高一数学  ", base_dir=self.test_dir)
        self.assertEqual(saved, "张老师-高一数学")
        self.assertEqual(file_logger.get_teacher_note(base_dir=self.test_dir), "张老师-高一数学")

        identity = file_logger.get_client_identity(base_dir=self.test_dir)
        self.assertEqual(identity["teacher_note"], "张老师-高一数学")
        self.assertIn("张老师-高一数学", identity["display_name"])
        self.assertTrue(identity["client_slug"])

    def test_classify_log_event(self):
        self.assertEqual(
            file_logger.classify_log_event("状态更新：已拦截（群聊拦截）", "WARNING"),
            ("warn", "student_blocked"),
        )
        self.assertEqual(
            file_logger.classify_log_event("状态更新：已发送", "INFO"),
            ("action", "student_sent"),
        )
        self.assertEqual(
            file_logger.classify_log_event("❌ 发送任务异常中止", "ERROR"),
            ("error", "sender_error"),
        )

    def test_incremental_unsynced_log_files_catchup(self):
        today = datetime.datetime.now().strftime("%Y-%m-%d")
        logs_dir = file_logger.get_logs_dir(self.test_dir)
        sender_log = os.path.join(logs_dir, f"sender_{today}.log")
        with open(sender_log, "w", encoding="utf-8") as f:
            f.write(f"[{today} 10:00:00] [INFO] 第一行离线日志\n")
            f.write(f"[{today} 10:00:01] [ERROR] ❌ 第二行离线报错\n")

        captured_payloads = []

        def fake_post(server, path, payload, timeout=8.0):
            captured_payloads.append(payload)
            return {"success": True}

        orig_post = file_logger._post_json_to_server
        file_logger._post_json_to_server = fake_post
        try:
            synced1 = file_logger.sync_unsynced_log_files(base_dir=self.test_dir)
            self.assertEqual(synced1, 1)
            self.assertEqual(len(captured_payloads), 1)
            self.assertEqual(captured_payloads[0]["sync_mode"], "chunk")
            self.assertIn("第一行离线日志", captured_payloads[0]["content"])

            # 再次执行无新增字节时不应重复上传
            synced2 = file_logger.sync_unsynced_log_files(base_dir=self.test_dir)
            self.assertEqual(synced2, 0)

            # 追加新内容后只上传新增尾部字节
            with open(sender_log, "a", encoding="utf-8") as f:
                f.write(f"[{today} 10:05:00] [INFO] ✅ [赵六] 反馈已成功投递\n")

            synced3 = file_logger.sync_unsynced_log_files(base_dir=self.test_dir)
            self.assertEqual(synced3, 1)
            self.assertEqual(len(captured_payloads), 2)
            self.assertIn("赵六", captured_payloads[1]["content"])
            self.assertNotIn("第一行离线日志", captured_payloads[1]["content"])
        finally:
            file_logger._post_json_to_server = orig_post

    def test_detect_log_level_summary_lines(self):
        """批次结束/暂停汇总行在 失败 0 时应判为 INFO，不污染 error_*.log。"""
        self.assertEqual(
            file_logger.detect_log_level("本批发送结束（共 27 人）：成功 27，失败 0，拦截 0，未匹配 0，跳过 0"),
            "INFO",
        )
        self.assertEqual(
            file_logger.detect_log_level("⏹ 已暂停（共 27 人）：成功 2，失败 0，拦截 0，未匹配 0，跳过 1，待发 24"),
            "INFO",
        )
        self.assertEqual(
            file_logger.detect_log_level("本批发送结束（共 27 人）：成功 25，失败 0，拦截 1，未匹配 1，跳过 0"),
            "WARNING",
        )
        self.assertEqual(
            file_logger.detect_log_level("本批发送结束（共 27 人）：成功 26，失败 1，拦截 0，未匹配 0，跳过 0"),
            "ERROR",
        )

    def test_sync_batch_summary_and_realtime_syncer(self):
        captured = []

        def fake_post(server, path, payload, timeout=8.0):
            captured.append(payload)
            return {"success": True}

        orig_post = file_logger._post_json_to_server
        file_logger._post_json_to_server = fake_post
        try:
            items = [
                {"sid": "S001", "sname": "张三", "_status": "已发送", "_last_reason": "", "text": "很长的反馈正文不应上传"},
                {"sid": "S002", "sname": "李四", "_status": "已拦截", "_last_reason": "群聊人数(35)", "text": "保密正文"},
            ]
            ok = file_logger.sync_batch_summary(
                items,
                input_paths=["/tmp/高二物理.xlsx"],
                base_dir=self.test_dir,
                immediate=True,
            )
            self.assertTrue(ok)
            self.assertEqual(len(captured), 1)
            summary = captured[0]["batch_summary"]
            self.assertEqual(summary["counts"]["total"], 2)
            self.assertEqual(summary["counts"]["sent"], 1)
            self.assertEqual(summary["counts"]["blocked"], 1)
            self.assertEqual(summary["files"], ["高二物理.xlsx"])
            # 确认未上传长反馈正文 text
            for st in summary["students"]:
                self.assertNotIn("text", st)
        finally:
            file_logger._post_json_to_server = orig_post

    def test_detect_log_level_summary_lines(self):
        """批次结束/暂停汇总行在 失败 0 时应判为 INFO，不污染 error_*.log。"""
        self.assertEqual(
            file_logger.detect_log_level("本批发送结束（共 27 人）：成功 27，失败 0，拦截 0，未匹配 0，跳过 0"),
            "INFO",
        )
        self.assertEqual(
            file_logger.detect_log_level("⏹ 已暂停（共 27 人）：成功 2，失败 0，拦截 0，未匹配 0，跳过 1，待发 24"),
            "INFO",
        )
        self.assertEqual(
            file_logger.detect_log_level("本批发送结束（共 27 人）：成功 25，失败 0，拦截 1，未匹配 1，跳过 0"),
            "WARNING",
        )
        self.assertEqual(
            file_logger.detect_log_level("本批发送结束（共 27 人）：成功 26，失败 1，拦截 0，未匹配 0，跳过 0"),
            "ERROR",
        )


if __name__ == "__main__":
    unittest.main()

