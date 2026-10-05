"""pacing 单测：区间与注入桩，无真实 sleep。"""

import unittest

from sender_py.pacing import AFTER_SEND_GAP, CANDIDATE_GAP, STUDENT_GAP, pause


class TestPacing(unittest.TestCase):
    def test_ranges_ordered(self):
        for low, high in (CANDIDATE_GAP, AFTER_SEND_GAP, STUDENT_GAP):
            self.assertLess(low, high)
            self.assertGreaterEqual(low, 0)
            self.assertLessEqual(high, 1.0)  # 全部控制在 1 秒以内

    def test_pause_stubbed(self):
        calls = []
        secs = pause(0.8, 2.0, _sleep=calls.append, _rand=lambda a, b: 1.5)
        self.assertEqual(secs, 1.5)
        self.assertEqual(calls, [1.5])

    def test_pause_clamps_negative(self):
        calls = []
        pause(0, 1, _sleep=calls.append, _rand=lambda a, b: -2.0)
        self.assertEqual(calls, [0.0])


if __name__ == "__main__":
    unittest.main()
