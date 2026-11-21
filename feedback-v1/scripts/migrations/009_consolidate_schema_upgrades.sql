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
-- 使用派生表 JOIN 避开 MySQL 1093 (target table in FROM clause) 限制
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
 AND dup.`class_name` = k.`class_name`
 AND dup.`id` <> k.`keep_id`
SET sr.`batch_id` = k.`keep_id`;

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
 AND dup.`class_name` = k.`class_name`
 AND dup.`id` <> k.`keep_id`;

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
 AND dup.`class_name` = k.`class_name`
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
 AND dup.`class_name` = k.`class_name`
 AND dup.`id` <> k.`keep_id`;

ALTER TABLE `class_batches`
  ADD UNIQUE KEY `uk_batch_identity` (`year`, `season`, `grade`, `tier`, `subject`, `class_name`);
