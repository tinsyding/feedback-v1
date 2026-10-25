import os
import unittest

from sender_py.sender import APP_NAME, APP_VERSION, app_icon_path


class AppMetadataTest(unittest.TestCase):
    def test_app_identity(self):
        self.assertEqual(APP_NAME, "极方每周反馈程序")
        self.assertEqual(APP_VERSION, "1.7.0")

    def test_website_icon_exists(self):
        path = app_icon_path()
        self.assertIsNotNone(path)
        self.assertTrue(os.path.isfile(path))
        self.assertEqual(os.path.basename(path), "favicon.ico")
