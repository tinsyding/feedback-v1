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


if __name__ == "__main__":
    unittest.main()
