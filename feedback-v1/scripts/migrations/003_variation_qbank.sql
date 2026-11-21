-- ============================================================
-- 举一反三（同类变式题）数据表扩展
-- 说明：
-- 1. qbank_questions 增加 parent_question_num 记录关联的课后巩固原题号 (1, 2, 3...)
-- 2. qbank_questions 增加 sub_num 记录针对同一道原题的变式序号 (1, 2...)
-- 3. qbank_questions 增加 idx_parent_lookup 索引提升错题本快速聚合查询效率
-- ============================================================

ALTER TABLE `qbank_questions`
  ADD COLUMN `parent_question_num` INT NULL DEFAULT NULL
    COMMENT '举一反三关联的原课后题号 (1, 2, 3...)' AFTER `question_num`;
ALTER TABLE `qbank_questions`
  ADD COLUMN `sub_num` INT NOT NULL DEFAULT 1
    COMMENT '变式题序号 (1, 2...)' AFTER `parent_question_num`;
ALTER TABLE `qbank_questions`
  ADD KEY `idx_parent_lookup` (`bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week`, `parent_question_num`);
