-- ============================================================
-- 009_consolidate_schema_upgrades.sql
-- 将历史运行期自愈 DDL (DB::ensureSchemaUpgrades) 正式收口至版本化迁移
-- 注意：每条 ALTER TABLE 拆分为独立语句，依赖 migrate.php 对 1060/1061 的幂等容错
-- ============================================================

ALTER TABLE `student_records`
  ADD COLUMN `submission_status` VARCHAR(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'submitted' COMMENT '课后作业提交状态: submitted/unsubmitted/exempt' AFTER `total_score`;

ALTER TABLE `student_records`
  ADD COLUMN `preview_submission_status` VARCHAR(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'submitted' COMMENT '预习作业提交状态: submitted/unsubmitted/exempt' AFTER `submission_status`;

UPDATE `class_batches` SET `season` = '春' WHERE LOWER(`season`) IN ('spring', '春季');
UPDATE `class_batches` SET `season` = '暑' WHERE LOWER(`season`) IN ('summer', '暑假', '夏');
UPDATE `class_batches` SET `season` = '秋' WHERE LOWER(`season`) IN ('autumn', 'fall', '秋季');
UPDATE `class_batches` SET `season` = '寒' WHERE LOWER(`season`) IN ('winter', '寒假', '冬');

-- 归并历史遗留的重复 class_batches 记录（以最小 id 为主批次），避免创建 uk_batch_identity 触发 1062
-- 使用派生表 JOIN 避开 MySQL 1093 (target table in FROM clause) 限制，并用 <=> 兼容 NULL class_name
UPDATE IGNORE `student_records` AS sr
INNER JOIN `class_batches` AS dup
  ON sr.`batch_id` = dup.`id`
INNER JOIN (
  SELECT `year`, `season`, `grade`, `tier`, `subject`, `class_name`, MIN(`id`) AS `keep_id`
  FROM `class_batches`
  GROUP BY `year`, `season`, `grade`, `tier`, `subject`, `class_name`
  HAVING COUNT(*) > 1
) AS k
  ON dup.`year` = k.`year`
 AND dup.`season` = k.`season`
 AND dup.`grade` = k.`grade`
 AND dup.`tier` = k.`tier`
 AND dup.`subject` = k.`subject`
 AND dup.`class_name` <=> k.`class_name`
 AND dup.`id` <> k.`keep_id`
SET sr.`batch_id` = k.`keep_id`;

-- 冲突未能迁移的重复 student_records 先归档到 student_record_history 再删除，避免数据静默丢失
INSERT INTO `student_record_history` (
  `record_id`, `batch_id`, `batch_code`, `student_id`, `student_name`, `student_key`,
  `week_num`, `preview_week_num`, `homework_score`, `preview_score`, `total_score`, `error_count`,
  `error_questions`, `preview_error_questions`, `teacher_comment`, `preview_comment`,
  `source_files`, `retest_token`, `created_by`, `operator`, `operation_type`,
  `record_created_at`, `record_updated_at`, `archived_at`
)
SELECT
  sr.`id`, k.`keep_id`, COALESCE(sr.`batch_code`, ''), COALESCE(sr.`student_id`, ''), sr.`student_name`, COALESCE(sr.`student_key`, ''),
  sr.`week_num`, sr.`preview_week_num`, sr.`homework_score`, sr.`preview_score`, sr.`total_score`, sr.`error_count`,
  sr.`error_questions`, sr.`preview_error_questions`, sr.`teacher_comment`, sr.`preview_comment`,
  sr.`source_files`, sr.`retest_token`, COALESCE(sr.`created_by`, ''), 'migration_009', 'batch_overwrite',
  sr.`created_at`, sr.`updated_at`, NOW()
FROM `student_records` AS sr
INNER JOIN `class_batches` AS dup
  ON sr.`batch_id` = dup.`id`
INNER JOIN (
  SELECT `year`, `season`, `grade`, `tier`, `subject`, `class_name`, MIN(`id`) AS `keep_id`
  FROM `class_batches`
  GROUP BY `year`, `season`, `grade`, `tier`, `subject`, `class_name`
  HAVING COUNT(*) > 1
) AS k
  ON dup.`year` = k.`year`
 AND dup.`season` = k.`season`
 AND dup.`grade` = k.`grade`
 AND dup.`tier` = k.`tier`
 AND dup.`subject` = k.`subject`
 AND dup.`class_name` <=> k.`class_name`
 AND dup.`id` <> k.`keep_id`;

DELETE sr
FROM `student_records` AS sr
INNER JOIN `class_batches` AS dup
  ON sr.`batch_id` = dup.`id`
INNER JOIN (
  SELECT `year`, `season`, `grade`, `tier`, `subject`, `class_name`, MIN(`id`) AS `keep_id`
  FROM `class_batches`
  GROUP BY `year`, `season`, `grade`, `tier`, `subject`, `class_name`
  HAVING COUNT(*) > 1
) AS k
  ON dup.`year` = k.`year`
 AND dup.`season` = k.`season`
 AND dup.`grade` = k.`grade`
 AND dup.`tier` = k.`tier`
 AND dup.`subject` = k.`subject`
 AND dup.`class_name` <=> k.`class_name`
 AND dup.`id` <> k.`keep_id`;

UPDATE `student_record_history` AS srh
INNER JOIN `class_batches` AS dup
  ON srh.`batch_id` = dup.`id`
INNER JOIN (
  SELECT `year`, `season`, `grade`, `tier`, `subject`, `class_name`, MIN(`id`) AS `keep_id`
  FROM `class_batches`
  GROUP BY `year`, `season`, `grade`, `tier`, `subject`, `class_name`
  HAVING COUNT(*) > 1
) AS k
  ON dup.`year` = k.`year`
 AND dup.`season` = k.`season`
 AND dup.`grade` = k.`grade`
 AND dup.`tier` = k.`tier`
 AND dup.`subject` = k.`subject`
 AND dup.`class_name` <=> k.`class_name`
 AND dup.`id` <> k.`keep_id`
SET srh.`batch_id` = k.`keep_id`;

UPDATE `generation_batches` AS gb
INNER JOIN `class_batches` AS dup
  ON gb.`class_id` = dup.`id`
INNER JOIN (
  SELECT `year`, `season`, `grade`, `tier`, `subject`, `class_name`, MIN(`id`) AS `keep_id`
  FROM `class_batches`
  GROUP BY `year`, `season`, `grade`, `tier`, `subject`, `class_name`
  HAVING COUNT(*) > 1
) AS k
  ON dup.`year` = k.`year`
 AND dup.`season` = k.`season`
 AND dup.`grade` = k.`grade`
 AND dup.`tier` = k.`tier`
 AND dup.`subject` = k.`subject`
 AND dup.`class_name` <=> k.`class_name`
 AND dup.`id` <> k.`keep_id`
SET gb.`class_id` = k.`keep_id`;

DELETE dup
FROM `class_batches` AS dup
INNER JOIN (
  SELECT `year`, `season`, `grade`, `tier`, `subject`, `class_name`, MIN(`id`) AS `keep_id`
  FROM `class_batches`
  GROUP BY `year`, `season`, `grade`, `tier`, `subject`, `class_name`
  HAVING COUNT(*) > 1
) AS k
  ON dup.`year` = k.`year`
 AND dup.`season` = k.`season`
 AND dup.`grade` = k.`grade`
 AND dup.`tier` = k.`tier`
 AND dup.`subject` = k.`subject`
 AND dup.`class_name` <=> k.`class_name`
 AND dup.`id` <> k.`keep_id`;

ALTER TABLE `class_batches`
  ADD UNIQUE KEY `uk_batch_identity` (`year`, `season`, `grade`, `tier`, `subject`, `class_name`);
