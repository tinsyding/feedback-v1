import json
import os
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from sender_py.cloud_control import (
    CloudControlManager,
    DEFAULT_CLOUD_POLICY,
    is_version_below,
    normalize_policy,
    parse_semver,
)
from sender_py import file_logger
from sender_py import sender as sender_mod
from sender_py.web_controller import WebController


class CloudControlUnitTest(unittest.TestCase):
    def test_semver_comparison(self):
        self.assertEqual(parse_semver("v2.0.3"), (2, 0, 3))
        self.assertEqual(parse_semver("2.1"), (2, 1, 0))
        self.assertTrue(is_version_below("2.0.2", "2.0.3"))
        self.assertTrue(is_version_below("v2.0.3", "2.1.0"))
        self.assertFalse(is_version_below("2.0.3", "2.0.3"))
        self.assertFalse(is_version_below("2.0.4", "2.0.3"))
        self.assertFalse(is_version_below("2.0.2", ""))
        self.assertFalse(is_version_below("2.0.2", "invalid"))

    def test_normalize_policy_clamps_and_sanitizes(self):
        pol = normalize_policy({
            "verifyMode": "INVALID",
            "snapshotPolicy": "ALWAYS",
            "searchWait": 99.0,
            "enterWait": 0.01,
            "studentGapMin": 3.0,
            "studentGapMax": 1.0,  # reversed -> should raise to min
            "batchBreakEvery": 0,
            "batchBreakMin": 5.0,
            "batchBreakMax": 2.0,
            "updateUrl": "javascript:alert(1)",
        })
        self.assertEqual(pol["verifyMode"], "auto")
        self.assertEqual(pol["snapshotPolicy"], "always")
        self.assertEqual(pol["searchWait"], 8.0)
        self.assertEqual(pol["enterWait"], 0.4)
        self.assertEqual(pol["studentGapMin"], 3.0)
        self.assertEqual(pol["studentGapMax"], 3.0)
        self.assertEqual(pol["batchBreakEvery"], 1)
        self.assertEqual(pol["batchBreakMin"], 5.0)
        self.assertEqual(pol["batchBreakMax"], 5.0)
        self.assertEqual(pol["updateUrl"], "")

    def test_command_dedupe_and_ack_lifecycle(self):
        mgr = CloudControlManager()
        executed = []
        mgr.set_command_handler(lambda cmd: executed.append(cmd["cmd_id"]) or {"success": True, "message": "done"})

        payload = {
            "global_version": 5,
            "has_client_override": True,
            "client_overrides": {"verifyMode": "local"},
            "effective_policy": {
                **DEFAULT_CLOUD_POLICY,
                "policyVersion": 5,
                "verifyMode": "local",
                "enableReplyAnalysis": False,
            },
            "pending_commands": [
                {"cmd_id": "cmd_101", "type": "stop_batch", "params": {"reason": "test"}},
            ],
        }

        res1 = mgr.apply_server_payload(payload)
        self.assertTrue(res1["updated"])
        self.assertEqual(res1["commands_executed"], 1)
        self.assertEqual(executed, ["cmd_101"])
        self.assertEqual(mgr.get_policy()["verifyMode"], "local")
        self.assertFalse(mgr.get_policy()["enableReplyAnalysis"])

        # Re-applying the same pending command ID must NOT execute twice
        res2 = mgr.apply_server_payload(payload)
        self.assertEqual(res2["commands_executed"], 0)
        self.assertEqual(executed, ["cmd_101"])

        acks = mgr.peek_pending_acks()
        self.assertEqual(len(acks), 1)
        self.assertEqual(acks[0]["cmd_id"], "cmd_101")
        self.assertEqual(acks[0]["status"], "ok")

        # Failed upload should preserve acks; confirm_acks_sent removes only sent ones
        mgr.confirm_acks_sent(acks)
        self.assertEqual(mgr.peek_pending_acks(), [])

    def test_start_gate_service_lock_and_min_version(self):
        mgr = CloudControlManager()
        mgr.apply_server_payload({
            "effective_policy": {
                **DEFAULT_CLOUD_POLICY,
                "senderServiceEnabled": False,
                "noticeMessage": "今晚22点系统维护",
            }
        })
        gate_locked = mgr.evaluate_start_gate("2.0.3")
        self.assertFalse(gate_locked["allowed"])
        self.assertIn("管理员已暂停发送服务", gate_locked["block_reason"])
        self.assertIn("今晚22点系统维护", gate_locked["block_reason"])

        mgr.apply_server_payload({
            "effective_policy": {
                **DEFAULT_CLOUD_POLICY,
                "senderServiceEnabled": True,
                "minSenderVersion": "2.1.0",
                "minVersionAction": "block",
                "updateUrl": "https://example.com/dl",
            }
        })
        gate_ver_block = mgr.evaluate_start_gate("2.0.3")
        self.assertFalse(gate_ver_block["allowed"])
        self.assertIn("2.1.0", gate_ver_block["block_reason"])
        self.assertEqual(gate_ver_block["update_url"], "https://example.com/dl")

        mgr.apply_server_payload({
            "effective_policy": {
                **DEFAULT_CLOUD_POLICY,
                "senderServiceEnabled": True,
                "minSenderVersion": "2.1.0",
                "minVersionAction": "warn",
            }
        })
        gate_ver_warn = mgr.evaluate_start_gate("2.0.3")
        self.assertTrue(gate_ver_warn["allowed"])
        self.assertIn("2.1.0", gate_ver_warn["warning"])

    def test_web_controller_start_gate_and_remote_stop(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            sample = os.path.join(tmpdir, "students.json")
            with open(sample, "w", encoding="utf-8") as f:
                json.dump([{"studentName": "001张三", "message": "测试评语"}], f, ensure_ascii=False)

            ctrl = WebController(enable_cloud_sync=False)
            ctrl.add_input_files([sample], replace=True)

            # Service disabled by cloud control -> block start_send
            ctrl._cloud_control.apply_server_payload({
                "effective_policy": {**DEFAULT_CLOUD_POLICY, "senderServiceEnabled": False, "noticeMessage": "紧急维护"}
            })
            res = ctrl.start_send()
            self.assertFalse(res["success"])
            self.assertIn("紧急维护", res["message"])

            # Restore service and test remote stop_batch command handler
            ctrl._cloud_control.apply_server_payload({
                "effective_policy": {**DEFAULT_CLOUD_POLICY, "senderServiceEnabled": True}
            })
            ctrl._running = True
            ctrl._stop_requested = False
            ctrl._cloud_control.apply_server_payload({
                "effective_policy": DEFAULT_CLOUD_POLICY,
                "pending_commands": [
                    {"cmd_id": "cmd_remote_stop_test", "type": "stop_batch", "params": {"reason": "后台急停"}}
                ],
            })
            self.assertTrue(ctrl._stop_requested)

            state = ctrl.get_state()
            self.assertIn("cloud_control", state)
            self.assertEqual(state["app_version"], sender_mod.APP_VERSION)

            # Cleanup acks from singleton
            ctrl._cloud_control.confirm_acks_sent(ctrl._cloud_control.peek_pending_acks())

    def test_send_student_skips_reply_analysis_when_disabled(self):
        fake_analyzer = MagicMock()
        fake_judgment = {"matched": True, "is_group": False, "detected_title": "001张三", "reason": "ok"}

        with patch("sender_py.window_utils.find_wecom_search_tab_wnd", return_value=None), \
             patch("sender_py.window_utils.find_and_activate_wecom", return_value=True), \
             patch("sender_py.window_utils.ensure_fully_visible", return_value=(True, (0, 0, 800, 600))), \
             patch("sender_py.window_utils.get_dpi_scale", return_value=1.0), \
             patch("sender_py.window_utils.get_wecom_rect", return_value=(0, 0, 800, 600)), \
             patch("sender_py.sender.ensure_roi", return_value={"title": [0, 0, 1, 1], "input": [0, 0, 1, 1], "chat": [0, 0, 1, 1]}), \
             patch("sender_py.sender._capture_title_crop", return_value=None), \
             patch("sender_py.sender.search_and_enter", return_value=True) as mock_search, \
             patch("sender_py.sender.judge_candidate", return_value=(fake_judgment, "001张三", None, MagicMock())) as mock_judge, \
             patch("sender_py.sender.paste_and_send", return_value=(True, "")):

            res = sender_mod.send_student(
                {"studentName": "001张三", "sid": "001", "sname": "张三", "message": "hello"},
                server="https://example.com",
                verify_mode="local",
                search_wait=2.1,
                enter_wait=1.7,
                enable_reply_analysis=False,
                snapshot_policy="off",
                reply_analyzer=fake_analyzer,
                log=lambda _m: None,
            )

        self.assertEqual(res["result"], "sent")
        mock_search.assert_called()
        _, kwargs = mock_search.call_args
        self.assertAlmostEqual(kwargs["search_wait"], 2.1)
        self.assertAlmostEqual(kwargs["enter_wait"], 1.7)
        _, jkwargs = mock_judge.call_args
        self.assertTrue(jkwargs["fast_title_only"])
        self.assertEqual(jkwargs["verify_mode"], "local")
        self.assertEqual(jkwargs["snapshot_policy"], "off")
        fake_analyzer.submit.assert_not_called()

    def test_file_logger_apply_cloud_control_response(self):
        mgr = CloudControlManager()
        with patch.object(file_logger, "get_cloud_control_manager", return_value=mgr):
            mgr.set_command_handler(lambda c: {"success": True, "message": "executed"})
            res = {
                "success": True,
                "data": {
                    "cloud_control": {
                        "global_version": 9,
                        "effective_policy": {**DEFAULT_CLOUD_POLICY, "policyVersion": 9, "searchWait": 2.4},
                        "pending_commands": [{"cmd_id": "cmd_fl_1", "type": "refresh_policy"}],
                    }
                },
            }
            self.assertTrue(file_logger._apply_cloud_control_response(res))
            self.assertAlmostEqual(mgr.get_policy()["searchWait"], 2.4)
            self.assertEqual(len(mgr.peek_pending_acks()), 1)
            # Simulate next round confirming acks sent
            self.assertTrue(file_logger._apply_cloud_control_response(
                {"success": True, "data": {}},
                sent_acks=mgr.peek_pending_acks(),
            ))
            self.assertEqual(mgr.peek_pending_acks(), [])


if __name__ == "__main__":
    unittest.main()
