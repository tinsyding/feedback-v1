import os
import unittest
from unittest.mock import MagicMock

from sender_py.sender import APP_NAME, APP_VERSION, app_icon_path
from sender_py.window_utils import set_app_user_model_id
from sender_py.web_companion import apply_window_icon


class AppMetadataTest(unittest.TestCase):
    def test_app_identity(self):
        self.assertEqual(APP_NAME, "极方每周反馈程序")
        self.assertEqual(APP_VERSION, "2.1.2")
        from sender_py.web_main import APP_VERSION as WEB_APP_VERSION
        self.assertEqual(WEB_APP_VERSION, "2.1.2")

    def test_website_icon_exists(self):
        path = app_icon_path()
        self.assertIsNotNone(path)
        self.assertTrue(os.path.isfile(path))
        self.assertEqual(os.path.basename(path), "favicon.ico")

    def test_set_app_user_model_id(self):
        res = set_app_user_model_id("JiFang.Feedback.Test")
        self.assertIsInstance(res, bool)

    def test_apply_window_icon_with_mock(self):
        mock_root = MagicMock()
        apply_window_icon(mock_root)
        self.assertTrue(mock_root.iconbitmap.called or mock_root.iconphoto.called)

