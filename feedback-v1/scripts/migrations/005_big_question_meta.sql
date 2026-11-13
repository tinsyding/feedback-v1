-- ============================================================
-- 英语/文科大题（一题多问共享题干 + 小问框选坐标）数据表扩展
-- 说明：
-- 1. qbank_questions 增加 question_meta 存储大题题号范围与该小问在大题PDF中的归一化框选坐标 JSON
--    格式示例: {"groupNums":[7,8,9,10,11],"box":{"pageOffset":0,"x":0.08,"y":0.52,"w":0.84,"h":0.09}}
-- ============================================================

ALTER TABLE `qbank_questions`
  ADD COLUMN `question_meta` TEXT NULL DEFAULT NULL
    COMMENT '大题分组及小问框选坐标JSON(groupNums/box)' AFTER `video_url`;
