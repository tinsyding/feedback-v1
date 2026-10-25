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


if __name__ == "__main__":
    unittest.main()
