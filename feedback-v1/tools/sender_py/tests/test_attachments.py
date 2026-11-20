"""附件匹配、无评语直发建队、CF_HDROP 结构与半成功续发保护单元测试。"""

import os
import tempfile
import unittest
from unittest.mock import patch

from sender_py.utils import (
    _feedback_items_from_entries,
    build_items_from_attachment_files,
    extract_student_from_filename,
    match_files_to_students,
)
from sender_py.window_utils import build_cf_hdrop_bytes, parse_cf_hdrop_bytes
from sender_py.web_controller import WebController
import sender_py.sender as sender_mod


class TestAttachments(unittest.TestCase):

    def test_extract_student_from_filename_variants(self):
        self.assertEqual(
            extract_student_from_filename("/tmp/90001张三_第8周错题.pdf"),
            ("90001", "张三", "90001张三"),
        )
        self.assertEqual(
            extract_student_from_filename("C:\\files\\10002-欧阳修(巩固).pdf"),
            ("10002", "欧阳修", "10002欧阳修"),
        )
        self.assertEqual(
            extract_student_from_filename("李四_90003_成绩单.png"),
            ("90003", "李四", "90003李四"),
        )
        self.assertEqual(
            extract_student_from_filename("本周公共标准答案.pdf"),
            ("", "", ""),
        )

    def test_match_files_to_students_priorities(self):
        items = [
            {"studentName": "90001张三", "sid": "90001", "sname": "张三", "message": "m1"},
            {"studentName": "90002李四", "sid": "90002", "sname": "李四", "message": "m2"},
            {"studentName": "90003欧阳修", "sid": "90003", "sname": "欧阳修", "message": "m3"},
        ]
        files = [
            "/tmp/90001张三_错题.pdf",
            "/tmp/90001张三_成绩.png",
            "/tmp/90002_仅学号报告.pdf",
            "/tmp/欧阳修_仅姓名试卷.pdf",
            "/tmp/未匹配公共说明.pdf",
        ]
        res = match_files_to_students(files, items)
        self.assertEqual(res["matched_students"], 3)
        self.assertEqual(res["matched_files"], 4)
        self.assertEqual(len(res["unmatched_files"]), 1)
        self.assertEqual(len(items[0]["files"]), 2)
        self.assertEqual(len(items[1]["files"]), 1)
        self.assertEqual(len(items[2]["files"]), 1)

    def test_build_items_from_attachment_files_direct_queue(self):
        files = [
            "/tmp/90001张三_1.pdf",
            "/tmp/90001张三_2.png",
            "/tmp/90002李四.pdf",
            "/tmp/说明文档.txt",
        ]
        built, unmatched = build_items_from_attachment_files(files, default_message="")
        self.assertEqual(len(built), 2)
        self.assertEqual(built[0]["studentName"], "90001张三")
        self.assertEqual(len(built[0]["files"]), 2)
        self.assertEqual(built[1]["studentName"], "90002李四")
        self.assertEqual(len(unmatched), 1)

    def test_cf_hdrop_bytes_roundtrip_with_chinese_and_spaces(self):
        paths = [
            os.path.normpath("/tmp/高二物理 90001张三 错题本.pdf"),
            os.path.normpath("/tmp/本周标准答案 (第8周).docx"),
        ]
        raw = build_cf_hdrop_bytes(paths)
        parsed = parse_cf_hdrop_bytes(raw)
        self.assertEqual(parsed, paths)

    def test_entries_allow_empty_message_when_files_present(self):
        items = _feedback_items_from_entries([
            {"studentName": "90001张三", "message": "", "files": ["/tmp/90001张三.pdf"]},
            {"studentName": "90002李四", "message": ""},
        ])
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["sid"], "90001")
        self.assertEqual(len(items[0]["files"]), 1)

    def test_web_controller_attachment_folder_creates_queue_and_global_attachments(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            f1 = os.path.join(tmpdir, "90001张三_错题.pdf")
            f2 = os.path.join(tmpdir, "90002李四_错题.pdf")
            g1 = os.path.join(tmpdir, "公共答案.pdf")
            for p in (f1, f2, g1):
                with open(p, "wb") as wf:
                    wf.write(b"%PDF-1.4 dummy")

            ctrl = WebController(enable_cloud_sync=False)
            # 队列为空时导入文件夹 -> 直接建队并切为 files_only
            res = ctrl.attach_and_match_files([f1, f2], create_items_if_empty=True)
            self.assertTrue(res["success"])
            self.assertEqual(res["mode"], "created_queue")
            self.assertEqual(res["matched_students"], 2)
            self.assertEqual(ctrl.send_mode, "files_only")

            # 添加全员公共附件
            gres = ctrl.add_global_attachments([g1])
            self.assertTrue(gres["success"])
            state = ctrl.get_state()
            self.assertEqual(len(state["global_attachments"]), 1)
            self.assertEqual(state["students"][0]["effective_files_count"], 2)

            # 统一设置话术 -> 自动切回 both 模式
            ctrl.set_attachment_options(default_file_message="请查收本周错题PDF", apply_message_to_all=True)
            self.assertEqual(ctrl.send_mode, "both")
            self.assertEqual(ctrl.items[0]["message"], "请查收本周错题PDF")

    def test_send_student_text_then_file_and_semi_success_resume(self):
        item = {
            "studentName": "90001张三",
            "sid": "90001",
            "sname": "张三",
            "message": "张三家长您好，请查收附件",
            "files": ["/tmp/90001张三.pdf"],
        }
        call_order = []

        def fake_paste_text(msg):
            call_order.append(("text", msg))
            return (True, "已发送")

        # 第一次：文字成功，附件失败
        def fake_paste_files_fail(paths):
            call_order.append(("files", list(paths)))
            return (False, "剪贴板占用")

        with patch("sender_py.window_utils.find_wecom_search_tab_wnd", return_value=None), \
             patch("sender_py.window_utils.find_and_activate_wecom", return_value=True), \
             patch("sender_py.window_utils.ensure_fully_visible", return_value=(True, (0, 0, 900, 700))), \
             patch("sender_py.window_utils.get_wecom_rect", return_value=(0, 0, 900, 700)), \
             patch("sender_py.window_utils.get_dpi_scale", return_value=1.0), \
             patch.object(sender_mod, "ensure_roi", return_value={"title": [0.2, 0.0, 0.5, 0.08], "input": [0.2, 0.8, 0.7, 0.15]}), \
             patch.object(sender_mod, "_capture_title_crop", return_value=None), \
             patch.object(sender_mod, "search_and_enter", return_value=True), \
             patch.object(sender_mod, "judge_candidate", return_value=({"matched": True, "is_group": False}, "90001张三", None, None)), \
             patch.object(sender_mod, "paste_and_send", side_effect=fake_paste_text), \
             patch.object(sender_mod, "paste_files_and_send", side_effect=fake_paste_files_fail):
            res1 = sender_mod.send_student(
                item, server="http://localhost", token="t",
                enable_reply_analysis=False, search_wait=0.01, enter_wait=0.01,
                send_mode="both",
            )
            self.assertEqual(res1["result"], "error")
            self.assertTrue(res1.get("text_sent"))
            self.assertFalse(res1.get("files_sent"))
            self.assertEqual([c[0] for c in call_order], ["text", "files"])

        # 第二次重试：标记 _text_sent=True 后，应跳过文字仅补发附件
        item["_text_sent"] = True
        call_order.clear()

        def fake_paste_files_ok(paths):
            call_order.append(("files", list(paths)))
            return (True, "已发送 1 个附件")

        with patch("sender_py.window_utils.find_wecom_search_tab_wnd", return_value=None), \
             patch("sender_py.window_utils.find_and_activate_wecom", return_value=True), \
             patch("sender_py.window_utils.ensure_fully_visible", return_value=(True, (0, 0, 900, 700))), \
             patch("sender_py.window_utils.get_wecom_rect", return_value=(0, 0, 900, 700)), \
             patch("sender_py.window_utils.get_dpi_scale", return_value=1.0), \
             patch.object(sender_mod, "ensure_roi", return_value={"title": [0.2, 0.0, 0.5, 0.08], "input": [0.2, 0.8, 0.7, 0.15]}), \
             patch.object(sender_mod, "_capture_title_crop", return_value=None), \
             patch.object(sender_mod, "search_and_enter", return_value=True), \
             patch.object(sender_mod, "judge_candidate", return_value=({"matched": True, "is_group": False}, "90001张三", None, None)), \
             patch.object(sender_mod, "paste_and_send", side_effect=fake_paste_text), \
             patch.object(sender_mod, "paste_files_and_send", side_effect=fake_paste_files_ok):
            res2 = sender_mod.send_student(
                item, server="http://localhost", token="t",
                enable_reply_analysis=False, search_wait=0.01, enter_wait=0.01,
                send_mode="both",
            )
            self.assertEqual(res2["result"], "sent")
            self.assertEqual([c[0] for c in call_order], ["files"])


if __name__ == "__main__":
    unittest.main()
