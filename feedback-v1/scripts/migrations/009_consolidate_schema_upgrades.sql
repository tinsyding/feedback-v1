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

ALTER TABLE `class_batches`
  ADD UNIQUE KEY `uk_batch_identity` (`year`, `season`, `grade`, `tier`, `subject`, `class_name`);
