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

-- ---------- 班级教学期次（带唯一键防重复批次裂变） ----------
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
  UNIQUE KEY `uk_batch_identity` (`year`,`season`,`grade`,`tier`,`subject`,`class_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='班级教学期次表';

-- ---------- 学生学情错题（当前版本） ----------
CREATE TABLE IF NOT EXISTS `student_records` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `batch_id` int(11) NOT NULL COMMENT '所属班级批次ID',
  `batch_code` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '生成批次编号',
  `student_id` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '学号',
  `student_name` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '姓名',
  `student_key` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '唯一标识：学号_姓名_年级_学科（无学号则纯姓名）',
  `week_num` int(11) NOT NULL COMMENT '专题周次/讲次',
  `preview_week_num` int(11) DEFAULT NULL COMMENT '预习作业对应周次/讲次，可与课后巩固不同',
  `homework_score` decimal(6,2) DEFAULT '0.00' COMMENT '课后巩固得分',
  `preview_score` decimal(6,2) DEFAULT NULL COMMENT '预习得分',
  `total_score` decimal(6,2) DEFAULT NULL COMMENT '作业满分',
  `submission_status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'submitted' COMMENT '课后作业提交状态: submitted/unsubmitted/exempt',
  `preview_submission_status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'submitted' COMMENT '预习作业提交状态: submitted/unsubmitted/exempt',
  `error_count` int(11) NOT NULL DEFAULT '0' COMMENT '错题总道数',
  `error_questions` json NOT NULL COMMENT '课后巩固错题具体题号数组，如 [1, 3, 5]',
  `preview_error_questions` json DEFAULT NULL COMMENT '预习错题具体题号数组，如 [2, 4]',
  `source_files` text COLLATE utf8mb4_unicode_ci COMMENT '上传来源文件名列表(JSON)',
  `teacher_comment` text COLLATE utf8mb4_unicode_ci COMMENT '教师针对性评语',
  `preview_comment` text COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '预习针对性评语',
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
  `preview_week_num` int(11) DEFAULT NULL,
  `homework_score` decimal(6,2) DEFAULT NULL,
  `preview_score` decimal(6,2) DEFAULT NULL,
  `total_score` decimal(6,2) DEFAULT NULL,
  `error_count` int(11) NOT NULL DEFAULT '0',
  `error_questions` json DEFAULT NULL,
  `preview_error_questions` json DEFAULT NULL,
  `teacher_comment` text COLLATE utf8mb4_unicode_ci,
  `preview_comment` text COLLATE utf8mb4_unicode_ci DEFAULT NULL,
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
  `bank_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'homework' COMMENT '题库类型：homework=课后巩固，preview=预习',
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
  UNIQUE KEY `uk_week` (`year`,`season`,`subject`,`grade`,`tier`,`week`,`bank_type`),
  KEY `idx_list` (`year`,`season`,`subject`,`grade`,`bank_type`),
  KEY `idx_updated` (`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='题库专题主表';

-- ---------- 题库题目与考点 ----------
CREATE TABLE IF NOT EXISTS `qbank_questions` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `qbank_id` int(11) NOT NULL COMMENT '关联 qbank_weeks.id',
  `bank_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'homework' COMMENT '题库类型：homework=课后巩固，preview=预习',
  `year` int(11) NOT NULL DEFAULT '2026',
  `season` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '秋' COMMENT '学期：春/暑/秋/寒',
  `subject` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `grade` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `tier` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `week` int(11) NOT NULL,
  `question_num` int(11) NOT NULL COMMENT '题号 (1, 2, 3...)',
  `parent_question_num` int(11) DEFAULT NULL COMMENT '举一反三关联的原课后题号 (1, 2, 3...)',
  `parent_question_nums` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '举一反三关联的多个原题号（逗号分隔，如 2,5）',
  `sub_num` int(11) NOT NULL DEFAULT '1' COMMENT '变式题序号 (1, 2...)',
  `topic` text COLLATE utf8mb4_unicode_ci,
  `video_url` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `question_meta` text COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '大题分组及小问框选坐标JSON(groupNums/box)',
  `exercise_pdf` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '题目PDF路径',
  `exercise_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '题目文件原名',
  `answer_pdf` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '答案PDF路径',
  `answer_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT '' COMMENT '答案文件原名',
  `created_by` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '初始录入教师账号',
  `updated_by` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '最后修改教师账号',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_qbank_qnum` (`qbank_id`,`question_num`),
  KEY `idx_lookup` (`bank_type`,`year`,`season`,`subject`,`grade`,`tier`,`week`,`question_num`),
  KEY `idx_parent_lookup` (`bank_type`,`year`,`season`,`subject`,`grade`,`tier`,`week`,`parent_question_num`),
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

-- ---------- 错题本吊销 Token 黑名单 ----------
CREATE TABLE IF NOT EXISTS `retest_revoked_tokens` (
  `token` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '被吊销的错题本Token',
  `revoked_by` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '执行作废的操作人',
  `reason` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '作废原因',
  `revoked_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '作废时间',
  PRIMARY KEY (`token`),
  KEY `idx_revoked_at` (`revoked_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='错题本吊销Token黑名单表';

-- ---------- PHP 与 Go 共享会话表 ----------
CREATE TABLE IF NOT EXISTS `app_sessions` (
  `session_id` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'PHPSESSID',
  `payload_php` mediumtext COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'PHP原生序列化会话载荷',
  `payload_json` json DEFAULT NULL COMMENT '标准JSON会话镜像（供Go后端共享读取/写入）',
  `expires_at` int unsigned NOT NULL COMMENT '过期Unix时间戳',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`session_id`),
  KEY `idx_expires_at` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='PHP与Go共享会话表';

-- ---------- PHP 与 Go 共享认证防爆破限频表 ----------
CREATE TABLE IF NOT EXISTS `auth_rate_limits` (
  `bucket_key` varchar(191) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'scope:identifier 限频桶键',
  `fail_count` int unsigned NOT NULL DEFAULT 0 COMMENT '当前时间窗口内失败次数',
  `first_at` int unsigned NOT NULL DEFAULT 0 COMMENT '当前时间窗口起始Unix时间戳',
  `updated_at` int unsigned NOT NULL DEFAULT 0 COMMENT '最后一次失败Unix时间戳',
  `lock_until` int unsigned NOT NULL DEFAULT 0 COMMENT '锁定截止Unix时间戳',
  PRIMARY KEY (`bucket_key`),
  KEY `idx_cleanup` (`lock_until`, `updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='PHP与Go共享认证防爆破限频表';

-- ---------- 题库存证 Ed25519 公钥注册表 ----------
CREATE TABLE IF NOT EXISTS `qbank_attestation_keys` (
  `kid` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '密钥ID，如 jf-qb-xxxxxxxx',
  `alg` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'Ed25519' COMMENT '签名算法',
  `public_key` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Base64URL raw 32-byte Ed25519 public key',
  `status` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active' COMMENT 'active/retired/revoked',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `retired_at` timestamp NULL DEFAULT NULL,
  `revoked_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`kid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='题库存证Ed25519公钥注册表';

-- ---------- 题库配置不可变存证修订账本 ----------
CREATE TABLE IF NOT EXISTS `qbank_revisions` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `receipt_code` varchar(40) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '存证回执号 QB-YYYYMMDD-XXXXXX-XXXX',
  `qbank_id` int NOT NULL DEFAULT 0 COMMENT '关联 qbank_weeks.id（删除时可为0或原ID）',
  `action` varchar(24) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'create/update/tier_sync/delete/admin_edit/admin_delete',
  `bank_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'homework',
  `year` int NOT NULL,
  `season` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `subject` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `grade` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `tier` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `week` int NOT NULL,
  `revision_no` int NOT NULL DEFAULT 1 COMMENT '同7维专题递增版本号',
  `supersedes_receipt_code` varchar(40) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '被覆盖的上一版本回执号',
  `question_count` int NOT NULL DEFAULT 0,
  `exercise_pdf_count` int NOT NULL DEFAULT 0,
  `answer_pdf_count` int NOT NULL DEFAULT 0,
  `topic_filled_count` int NOT NULL DEFAULT 0,
  `snapshot_json` longtext COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '规范化题目完整快照（含每道题PDF URL与SHA-256）',
  `content_sha256` char(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'snapshot_json UTF-8 SHA-256 hex',
  `canonical_payload` longtext COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '精确被Ed25519签名的规范化JSON原文',
  `prev_entry_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '前一条账本记录的entry_hash',
  `entry_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'SHA256(prev_entry_hash + LF + receipt_code + LF + content_sha256 + LF + issued_at_utc)',
  `kid` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '签名密钥ID',
  `signature` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Base64URL原始64字节Ed25519签名',
  `operator` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `operator_name` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `client_ip` varchar(45) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `issued_at_utc` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'RFC3339 UTC时间戳',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_receipt_code` (`receipt_code`),
  KEY `idx_scope_rev` (`year`, `season`, `bank_type`, `subject`, `grade`, `tier`, `week`, `revision_no`),
  KEY `idx_operator_created` (`operator`, `created_at`),
  KEY `idx_qbank_id` (`qbank_id`),
  KEY `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='题库配置不可变存证修订账本';

-- ---------- 题库配置过程事件与拦截留痕日志 ----------
CREATE TABLE IF NOT EXISTS `qbank_attempt_logs` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `event_type` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'upload_pdf/save_rejected/save_error/save_cancelled/client_blocked',
  `bank_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `year` int NOT NULL DEFAULT 0,
  `season` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `subject` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `grade` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `tier` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `week` int NOT NULL DEFAULT 0,
  `operator` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `operator_name` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `client_ip` varchar(45) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `reason` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `file_url` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `file_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `file_sha256` char(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `file_size` bigint NOT NULL DEFAULT 0,
  `details_json` json DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_operator_time` (`operator`, `created_at`),
  KEY `idx_scope_time` (`year`, `season`, `subject`, `grade`, `tier`, `week`, `created_at`),
  KEY `idx_event_time` (`event_type`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='题库配置过程事件与拦截留痕日志';


-- ---------- 题库存证外部可信时间锚定（Merkle + RFC 3161 TSA） ----------
CREATE TABLE IF NOT EXISTS `qbank_attestation_anchors` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `anchor_code` varchar(40) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '锚定批次编号 ANC-YYYYMMDD-XXXXXX',
  `anchor_type` varchar(24) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'rfc3161_tsa' COMMENT 'rfc3161_tsa/local_merkle/git_manifest',
  `seq_from` bigint NOT NULL COMMENT '本次锚定起始 qbank_revisions.id',
  `seq_to` bigint NOT NULL COMMENT '本次锚定结束 qbank_revisions.id',
  `leaf_count` int NOT NULL DEFAULT 0 COMMENT '纳入 Merkle Tree 的存证叶子数量',
  `merkle_root` char(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'SHA-256 Merkle Tree 根哈希',
  `prev_anchor_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '前一个锚定批次的 merkle_root',
  `tsa_url` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'RFC 3161 TSA 服务地址',
  `tsa_status` varchar(24) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'local_only' COMMENT 'anchored/local_only/failed',
  `tsa_token_b64` longtext COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT 'RFC 3161 TimeStampResp DER Base64 令牌',
  `tsa_gen_time` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT 'TSA 签发时间 (RFC3339 UTC)',
  `external_ref` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '外部凭据引用（如 TSA serial / manifest ref）',
  `error_message` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '若 TSA 请求失败记录简短原因',
  `anchored_by` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '触发者（scheduler / 管理员账号）',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_anchor_code` (`anchor_code`),
  KEY `idx_seq_range` (`seq_from`, `seq_to`),
  KEY `idx_merkle_root` (`merkle_root`),
  KEY `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='题库存证 Merkle 外部可信时间锚定表';
