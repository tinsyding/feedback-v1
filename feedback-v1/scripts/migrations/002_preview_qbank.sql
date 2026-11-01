-- ============================================================
-- 预习错题本 / 预习题库迁移
-- 说明：
-- 1. 题库增加 bank_type 维度：homework=课后巩固（旧数据默认值），preview=预习。
-- 2. 学生记录增加预习错题与预习周次字段；错题本 Token 仍按学生+课后巩固周次聚合。
-- 3. 所有旧数据自动归为 homework，不影响现有课后巩固错题本。
-- 请在备份站验证后再发布生产；执行前建议先备份数据库。
-- 执行方式（不要把库名写死在 SQL 里）：
--   备份站：mysql feedback_backup < 002_preview_qbank.sql
--   生产站：mysql feedback < 002_preview_qbank.sql
-- ============================================================

ALTER TABLE `qbank_weeks`
  ADD COLUMN `bank_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'homework'
    COMMENT '题库类型：homework=课后巩固，preview=预习' AFTER `id`,
  DROP INDEX `uk_week`,
  DROP INDEX `idx_list`,
  ADD UNIQUE KEY `uk_week` (`year`,`season`,`subject`,`grade`,`tier`,`week`,`bank_type`),
  ADD KEY `idx_list` (`year`,`season`,`subject`,`grade`,`bank_type`);

ALTER TABLE `qbank_questions`
  ADD COLUMN `bank_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'homework'
    COMMENT '题库类型：homework=课后巩固，preview=预习' AFTER `qbank_id`,
  DROP INDEX `idx_lookup`,
  ADD KEY `idx_lookup` (`bank_type`,`year`,`season`,`subject`,`grade`,`tier`,`week`,`question_num`);

ALTER TABLE `student_records`
  ADD COLUMN `preview_week_num` int(11) DEFAULT NULL
    COMMENT '预习作业对应周次/讲次，可与课后巩固不同' AFTER `week_num`,
  ADD COLUMN `preview_error_questions` json DEFAULT NULL
    COMMENT '预习错题具体题号数组，如 [2, 4]' AFTER `error_questions`,
  ADD COLUMN `preview_comment` text COLLATE utf8mb4_unicode_ci DEFAULT NULL
    COMMENT '预习针对性评语' AFTER `teacher_comment`;

ALTER TABLE `student_record_history`
  ADD COLUMN `preview_week_num` int(11) DEFAULT NULL AFTER `week_num`,
  ADD COLUMN `preview_error_questions` json DEFAULT NULL AFTER `error_questions`,
  ADD COLUMN `preview_comment` text COLLATE utf8mb4_unicode_ci DEFAULT NULL AFTER `teacher_comment`;
