-- ============================================================
-- 同考点错题共享变式（多原题号关联）数据表扩展
-- 说明：
-- 1. qbank_questions 增加 parent_question_nums 记录关联的多个原课后题号 (例如 "2,5")
-- ============================================================

ALTER TABLE `qbank_questions`
  ADD COLUMN `parent_question_nums` VARCHAR(128) NULL DEFAULT NULL
    COMMENT '举一反三关联的多个原题号（逗号分隔，如 2,5）' AFTER `parent_question_num`;
