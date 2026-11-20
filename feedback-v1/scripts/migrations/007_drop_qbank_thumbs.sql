-- ============================================================
-- 007_drop_qbank_thumbs.sql
-- 移除 qbank_questions 表的 exercise_thumb / answer_thumb Base64 缩略图大字段
-- ============================================================

ALTER TABLE `qbank_questions` DROP COLUMN `exercise_thumb`;
ALTER TABLE `qbank_questions` DROP COLUMN `answer_thumb`;
