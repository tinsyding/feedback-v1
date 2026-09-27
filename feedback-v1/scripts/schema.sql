-- ============================================================
-- Feedback-V1 数据库结构基线（与线上生产库逐项核对一致）
-- 来源：2026-09-28 线上 SHOW CREATE TABLE 实导
-- 注意：
-- 1. student_records 有唯一键 uniq_batch_student_week，
--    encrypt_batch 的 ON DUPLICATE KEY UPDATE 依赖它，请勿删除。
-- 2. student_records.batch_id 有外键 ON DELETE CASCADE，
--    后台删 class_batches 会级联删学情（管理后台 db_delete 未做二次确认之外的防护）。
-- 3. 本文件仅用于建库/对账；变更请走 scripts/migrations/ 编号 SQL + migrate.php。
-- ============================================================

CREATE DATABASE IF NOT EXISTS `feedback`
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `feedback`;

-- ---------- 前台教师账号（含助教，role='assistant'） ----------
CREATE TABLE IF NOT EXISTS `users` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `username` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `password_hash` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `initial_password` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `real_name` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `role` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'teacher',
  `teacher_id` int(11) NOT NULL DEFAULT '0' COMMENT '所属教师用户ID',
  `created_by` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '创建该账号的教师账号名',
  `status` tinyint(4) NOT NULL DEFAULT '1',
  `last_login_at` datetime DEFAULT NULL,
  `last_login_ip` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT '',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_username` (`username`),
  KEY `idx_teacher_id` (`teacher_id`),
  KEY `idx_created_by` (`created_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 系统管理员账号 ----------
CREATE TABLE IF NOT EXISTS `admin_users` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `username` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '登录账号',
  `password_hash` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '加密密码(BCrypt)',
  `real_name` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '超级管理员' COMMENT '真实姓名/备注',
  `role` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'super_admin' COMMENT '权限角色: super_admin/admin',
  `status` tinyint(4) NOT NULL DEFAULT '1' COMMENT '状态: 1正常 0禁用',
  `last_login_at` datetime DEFAULT NULL COMMENT '最后登录时间',
  `last_login_ip` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '最后登录IP',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='系统管理员账号表';

-- ---------- 班级教学期次（无唯一键，靠应用层去重；无 updated_at） ----------
CREATE TABLE IF NOT EXISTS `class_batches` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `year` int(11) NOT NULL COMMENT '年份，如 2026',
  `season` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '秋' COMMENT '学期：春/暑/秋/寒',
  `grade` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '年级，如 七年级/高一先学',
  `tier` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '班型，如 S+/S/A+/A/U',
  `subject` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '学科，如 数学/物理/英语/化学/语文',
  `class_name` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '班级别名/时段',
  `created_by` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '生成教师账号',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_query` (`year`,`season`,`grade`,`tier`,`subject`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='班级教学期次表';

-- ---------- 学生学情错题（当前版本） ----------
CREATE TABLE IF NOT EXISTS `student_records` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `batch_id` int(11) NOT NULL COMMENT '所属班级批次ID',
  `batch_code` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '生成批次编号',
  `student_id` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '学号',
  `student_name` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '姓名',
  `student_key` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '唯一标识学号_姓名',
  `week_num` int(11) NOT NULL COMMENT '专题周次/讲次',
  `homework_score` decimal(6,2) DEFAULT '0.00' COMMENT '课后巩固得分',
  `preview_score` decimal(6,2) DEFAULT NULL COMMENT '预习得分',
  `total_score` decimal(6,2) DEFAULT NULL COMMENT '作业满分',
  `error_count` int(11) NOT NULL DEFAULT '0' COMMENT '错题总道数',
  `error_questions` json NOT NULL COMMENT '错题具体题号数组，如 [1, 3, 5]',
  `source_files` text COLLATE utf8mb4_unicode_ci COMMENT '上传来源文件名列表(JSON)',
  `teacher_comment` text COLLATE utf8mb4_unicode_ci COMMENT '教师针对性评语',
  `retest_token` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '专属错题本短Token(10位)',
  `created_by` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '生成教师账号',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_batch_student_week` (`batch_id`,`student_key`,`week_num`),
  KEY `idx_student` (`student_id`,`student_name`),
  KEY `idx_batch_week` (`batch_id`,`week_num`),
  KEY `idx_batch_code` (`batch_code`),
  KEY `idx_token` (`retest_token`),
  CONSTRAINT `student_records_ibfk_1` FOREIGN KEY (`batch_id`) REFERENCES `class_batches` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='学生学情与错题记录表';

-- ---------- 学情历史版本（覆盖/回滚归档） ----------
CREATE TABLE IF NOT EXISTS `student_record_history` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `record_id` bigint(20) NOT NULL COMMENT '对应student_records.id',
  `batch_id` int(11) NOT NULL DEFAULT '0',
  `batch_code` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `student_id` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT '',
  `student_name` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `student_key` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT '',
  `week_num` int(11) NOT NULL DEFAULT '0',
  `homework_score` decimal(6,2) DEFAULT NULL,
  `preview_score` decimal(6,2) DEFAULT NULL,
  `total_score` decimal(6,2) DEFAULT NULL,
  `error_count` int(11) NOT NULL DEFAULT '0',
  `error_questions` json DEFAULT NULL,
  `teacher_comment` text COLLATE utf8mb4_unicode_ci,
  `source_files` text COLLATE utf8mb4_unicode_ci,
  `retest_token` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_by` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `operator` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '产生修改或覆盖的操作人',
  `operation_type` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'batch_overwrite' COMMENT '操作类型: batch_overwrite/manual_edit/before_rollback',
  `record_created_at` timestamp NULL DEFAULT NULL,
  `record_updated_at` timestamp NULL DEFAULT NULL,
  `archived_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_record_id` (`record_id`),
  KEY `idx_batch_student_week` (`batch_id`,`student_name`,`week_num`),
  KEY `idx_batch_code` (`batch_code`),
  KEY `idx_archived_at` (`archived_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='学生学情错题历史版本元组表';

-- ---------- 学情生成批次汇总 ----------
CREATE TABLE IF NOT EXISTS `generation_batches` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `batch_code` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '生成批次唯一编号',
  `class_id` int(11) NOT NULL DEFAULT '0' COMMENT '对应班级ID (class_batches.id)',
  `week_num` int(11) NOT NULL DEFAULT '0' COMMENT '专题周次',
  `student_count` int(11) NOT NULL DEFAULT '0' COMMENT '本次生成学生总数',
  `error_student_count` int(11) NOT NULL DEFAULT '0' COMMENT '本次有错题学生数',
  `source_files` text COLLATE utf8mb4_unicode_ci COMMENT '上传来源文件名列表(JSON)',
  `created_by` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '生成教师账号',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP COMMENT '生成时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_batch_code` (`batch_code`),
  KEY `idx_class_week` (`class_id`,`week_num`),
  KEY `idx_created_by` (`created_by`),
  KEY `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='学情生成批次表';

-- ---------- 题库专题期次 ----------
CREATE TABLE IF NOT EXISTS `qbank_weeks` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `year` int(11) NOT NULL DEFAULT '2026' COMMENT '年份，如2026',
  `season` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '秋' COMMENT '学期：春/暑/秋/寒',
  `subject` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '学科',
  `grade` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '年级',
  `tier` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '班层',
  `week` int(11) NOT NULL COMMENT '专题/周次序号 (1, 2, 3...)',
  `question_count` int(11) NOT NULL DEFAULT '0' COMMENT '题目总数',
  `created_by` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '初始录入教师账号',
  `updated_by` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '最后修改教师账号',
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_week` (`year`,`season`,`subject`,`grade`,`tier`,`week`),
  KEY `idx_list` (`year`,`season`,`subject`,`grade`),
  KEY `idx_updated` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='题库专题主表';

-- ---------- 题库题目与考点 ----------
CREATE TABLE IF NOT EXISTS `qbank_questions` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `qbank_id` int(11) NOT NULL COMMENT '关联 qbank_weeks.id',
  `year` int(11) NOT NULL DEFAULT '2026',
  `season` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '秋' COMMENT '学期：春/暑/秋/寒',
  `subject` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `grade` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `tier` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `week` int(11) NOT NULL,
  `question_num` int(11) NOT NULL COMMENT '题号 (1, 2, 3...)',
  `topic` text COLLATE utf8mb4_unicode_ci,
  `video_url` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `exercise_pdf` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '题目PDF路径',
  `exercise_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '题目文件原名',
  `exercise_thumb` mediumtext COLLATE utf8mb4_unicode_ci COMMENT '题目缩略图Base64',
  `answer_pdf` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '答案PDF路径',
  `answer_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '答案文件原名',
  `answer_thumb` mediumtext COLLATE utf8mb4_unicode_ci COMMENT '答案缩略图Base64',
  `created_by` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '初始录入教师账号',
  `updated_by` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '最后修改教师账号',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_qbank_qnum` (`qbank_id`,`question_num`),
  KEY `idx_lookup` (`year`,`season`,`subject`,`grade`,`tier`,`week`,`question_num`),
  KEY `idx_topic_search` (`subject`,`grade`,`topic`(100))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='题库题目与考点明细表';

-- ---------- 系统运行日志 ----------
CREATE TABLE IF NOT EXISTS `system_logs` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `log_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `timestamp` bigint(20) NOT NULL,
  `level` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'info',
  `module` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'global',
  `event` varchar(80) COLLATE utf8mb4_unicode_ci NOT NULL,
  `operator` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '操作人教师账号',
  `details` json DEFAULT NULL,
  `context` json DEFAULT NULL,
  `client_ip` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `client_info` json DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_log_id` (`log_id`),
  KEY `idx_level` (`level`),
  KEY `idx_module` (`module`),
  KEY `idx_event` (`event`),
  KEY `idx_created_at` (`created_at`),
  KEY `idx_timestamp` (`timestamp`),
  KEY `idx_system_logs_operator` (`operator`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 家长端访问与下载审计 ----------
CREATE TABLE IF NOT EXISTS `retest_access_logs` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `token` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '访问的专属Token',
  `student_name` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '核验的学生姓名',
  `action` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '行为类型：verify_success, verify_fail, download_exercise, download_both, download_all',
  `details` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '详细信息',
  `ip` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '客户端IP',
  `user_agent` text COLLATE utf8mb4_unicode_ci COMMENT 'User Agent',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_token` (`token`),
  KEY `idx_created_at` (`created_at`),
  KEY `idx_action_created` (`action`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='家长端查阅与下载日志表';
