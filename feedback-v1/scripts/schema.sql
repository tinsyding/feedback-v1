-- ============================================================
-- Feedback-V1 数据库建表脚本（逆向草案）
-- 来源：根据 api/*.php / api/admin/*.php 的实际 SQL 调用点逆向整理
-- 警告：
-- 1. 部署前必须与线上生产库逐项 `SHOW CREATE TABLE` 核对，
--    尤其标有 [NEEDS-VERIFY] 的唯一键与字段长度。
-- 2. `student_records` 的 ON DUPLICATE KEY UPDATE 依赖唯一键；
--    若线上缺失该唯一键，重复生成会刷出重复行而非覆盖。
-- 3. 字符集统一 utf8mb4_unicode_ci，与 DB::getConnection() 一致。
-- ============================================================

CREATE DATABASE IF NOT EXISTS `feedback`
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `feedback`;

-- ---------- 前台教师账号（含助教，role='assistant'） ----------
CREATE TABLE IF NOT EXISTS `users` (
  `id`               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `username`         VARCHAR(64)  NOT NULL COMMENT '登录账号，助教为 教师前缀_后缀',
  `password_hash`    VARCHAR(255) NOT NULL COMMENT 'bcrypt 哈希',
  `initial_password` VARCHAR(255) NOT NULL DEFAULT '' COMMENT '已废弃，统一清空',
  `real_name`        VARCHAR(64)  NOT NULL DEFAULT '',
  `role`             VARCHAR(16)  NOT NULL DEFAULT 'teacher' COMMENT 'teacher/assistant',
  `teacher_id`       INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '助教归属教师 id',
  `created_by`       VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '创建人 username',
  `status`           TINYINT      NOT NULL DEFAULT 1 COMMENT '1 正常，0 停用',
  `last_login_at`    DATETIME NULL DEFAULT NULL,
  `last_login_ip`    VARCHAR(50)  NOT NULL DEFAULT '',
  `created_at`       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_username` (`username`),
  KEY `idx_role_teacher` (`role`, `teacher_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 系统管理员账号 ----------
CREATE TABLE IF NOT EXISTS `admin_users` (
  `id`            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `username`      VARCHAR(64)  NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL COMMENT 'bcrypt（兼容老 SHA256，登录时平滑升级）',
  `real_name`     VARCHAR(64)  NOT NULL DEFAULT '超级管理员',
  `role`          VARCHAR(16)  NOT NULL DEFAULT 'super_admin',
  `status`        TINYINT      NOT NULL DEFAULT 1,
  `last_login_at` DATETIME NULL DEFAULT NULL,
  `last_login_ip` VARCHAR(50)  NOT NULL DEFAULT '',
  `created_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 班级教学期次 ----------
CREATE TABLE IF NOT EXISTS `class_batches` (
  `id`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `year`       INT          NOT NULL COMMENT '如 2026',
  `season`     VARCHAR(8)   NOT NULL COMMENT '春/暑/秋/寒',
  `grade`      VARCHAR(32)  NOT NULL,
  `tier`       VARCHAR(16)  NOT NULL COMMENT 'U/S+/S/A+/A',
  `subject`    VARCHAR(16)  NOT NULL,
  `class_name` VARCHAR(128) NOT NULL DEFAULT '' COMMENT '如 26秋_八年级_S+_数学',
  `created_by` VARCHAR(64)  NOT NULL DEFAULT '',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_class` (`year`, `season`, `grade`, `tier`, `subject`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 学生学情错题（当前版本） ----------
CREATE TABLE IF NOT EXISTS `student_records` (
  `id`              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `batch_id`        INT UNSIGNED NOT NULL COMMENT 'class_batches.id',
  `batch_code`      VARCHAR(32)  NOT NULL DEFAULT '' COMMENT 'B+时间戳批次号',
  `source_files`    JSON NULL COMMENT '来源 CSV 文件名列表',
  `student_id`      VARCHAR(32)  NOT NULL DEFAULT '' COMMENT '学号，可空',
  `student_name`    VARCHAR(64)  NOT NULL,
  `student_key`     VARCHAR(128) NOT NULL DEFAULT '' COMMENT '学号_姓名 或纯姓名，同名隔离',
  `week_num`        INT          NOT NULL COMMENT '专题/周次',
  `homework_score`  DECIMAL(6,1) NULL DEFAULT NULL,
  `preview_score`   DECIMAL(6,1) NULL DEFAULT NULL,
  `total_score`     DECIMAL(6,1) NULL DEFAULT NULL,
  `error_count`     INT          NOT NULL DEFAULT 0,
  `error_questions` JSON NULL COMMENT '错题号数组',
  `teacher_comment` MEDIUMTEXT NULL,
  `retest_token`    VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '10 位短 Token（HMAC 确定性派生）',
  `created_by`      VARCHAR(64)  NOT NULL DEFAULT '',
  `created_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  -- [VERIFIED] 生产库唯一约束：按班级+学生+周次唯一；retest_token 为普通索引供极速反查
  UNIQUE KEY `uniq_batch_student_week` (`batch_id`, `student_key`, `week_num`),
  KEY `idx_token` (`retest_token`),
  KEY `idx_batch_week` (`batch_id`, `week_num`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 学情历史版本（覆盖/回滚归档） ----------
CREATE TABLE IF NOT EXISTS `student_record_history` (
  `id`               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `record_id`        INT UNSIGNED NULL DEFAULT NULL COMMENT '来源 student_records.id',
  `batch_id`         INT UNSIGNED NOT NULL,
  `batch_code`       VARCHAR(32)  NOT NULL DEFAULT '',
  `student_id`       VARCHAR(32)  NOT NULL DEFAULT '',
  `student_name`     VARCHAR(64)  NOT NULL,
  `student_key`      VARCHAR(128) NOT NULL DEFAULT '',
  `week_num`         INT          NOT NULL,
  `homework_score`   DECIMAL(6,1) NULL DEFAULT NULL,
  `preview_score`    DECIMAL(6,1) NULL DEFAULT NULL,
  `total_score`      DECIMAL(6,1) NULL DEFAULT NULL,
  `error_count`      INT          NOT NULL DEFAULT 0,
  `error_questions`  JSON NULL,
  `teacher_comment`  MEDIUMTEXT NULL,
  `source_files`     JSON NULL,
  `retest_token`     VARCHAR(64)  NOT NULL DEFAULT '',
  `created_by`       VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '原记录创建人',
  `operator`         VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '触发归档的操作人',
  `operation_type`   VARCHAR(32)  NOT NULL DEFAULT '' COMMENT 'batch_overwrite/admin_edit/before_rollback',
  `record_created_at` DATETIME NULL DEFAULT NULL,
  `record_updated_at` DATETIME NULL DEFAULT NULL,
  `archived_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_record` (`record_id`),
  KEY `idx_batch_student_week` (`batch_id`, `student_name`, `week_num`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 学情生成批次汇总 ----------
CREATE TABLE IF NOT EXISTS `generation_batches` (
  `id`                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `batch_code`          VARCHAR(32)  NOT NULL,
  `class_id`            INT UNSIGNED NOT NULL COMMENT 'class_batches.id',
  `week_num`            INT          NOT NULL,
  `student_count`       INT          NOT NULL DEFAULT 0,
  `error_student_count` INT          NOT NULL DEFAULT 0,
  `source_files`        JSON NULL,
  `created_by`          VARCHAR(64)  NOT NULL DEFAULT '',
  `created_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_batch_code` (`batch_code`),
  KEY `idx_class_week` (`class_id`, `week_num`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 题库专题期次 ----------
CREATE TABLE IF NOT EXISTS `qbank_weeks` (
  `id`             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `year`           INT          NOT NULL,
  `season`         VARCHAR(8)   NOT NULL COMMENT '春/暑/秋/寒',
  `subject`        VARCHAR(16)  NOT NULL,
  `grade`          VARCHAR(32)  NOT NULL,
  `tier`           VARCHAR(16)  NOT NULL,
  `week`           INT          NOT NULL COMMENT '课后巩固专题序号',
  `question_count` INT          NOT NULL DEFAULT 0,
  `created_by`     VARCHAR(64)  NOT NULL DEFAULT '',
  `updated_by`     VARCHAR(64)  NOT NULL DEFAULT '',
  `created_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_week` (`year`, `season`, `subject`, `grade`, `tier`, `week`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 题库题目与考点 ----------
CREATE TABLE IF NOT EXISTS `qbank_questions` (
  `id`             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `qbank_id`       INT UNSIGNED NOT NULL COMMENT 'qbank_weeks.id',
  `year`           INT          NOT NULL,
  `season`         VARCHAR(8)   NOT NULL,
  `subject`        VARCHAR(16)  NOT NULL,
  `grade`          VARCHAR(32)  NOT NULL,
  `tier`           VARCHAR(16)  NOT NULL,
  `week`           INT          NOT NULL,
  `question_num`   INT          NOT NULL COMMENT '作业题号',
  `topic`          TEXT NULL COMMENT '考点与题目说明（见 alter_qbank_topic.sql，已由 VARCHAR(500) 扩容）',
  `video_url`      VARCHAR(512) NOT NULL DEFAULT '',
  `exercise_pdf`   VARCHAR(512) NOT NULL DEFAULT '' COMMENT '题目切片 data/pdfs/xxx.pdf',
  `exercise_name`  VARCHAR(255) NOT NULL DEFAULT '',
  `exercise_thumb` MEDIUMTEXT NULL COMMENT 'base64 缩略图，列表查询时不返回',
  `answer_pdf`     VARCHAR(512) NOT NULL DEFAULT '',
  `answer_name`    VARCHAR(255) NOT NULL DEFAULT '',
  `answer_thumb`   MEDIUMTEXT NULL,
  `created_by`     VARCHAR(64)  NOT NULL DEFAULT '',
  `updated_by`     VARCHAR(64)  NOT NULL DEFAULT '',
  `created_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_qbank_num` (`qbank_id`, `question_num`),
  KEY `idx_dim` (`subject`, `grade`, `tier`, `week`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 系统运行日志 ----------
CREATE TABLE IF NOT EXISTS `system_logs` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `log_id`      VARCHAR(64)   NOT NULL COMMENT 'srv_/log_ 前缀业务 id',
  `timestamp`   BIGINT        NOT NULL COMMENT '毫秒时间戳',
  `level`       VARCHAR(16)   NOT NULL COMMENT 'error/warn/action/info',
  `module`      VARCHAR(32)   NOT NULL,
  `event`       VARCHAR(64)   NOT NULL,
  `operator`    VARCHAR(64)   NOT NULL DEFAULT '',
  `details`     JSON NULL,
  `context`     JSON NULL,
  `client_ip`   VARCHAR(50)   NOT NULL DEFAULT '',
  `client_info` JSON NULL,
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_log_id` (`log_id`),
  KEY `idx_level_module_event` (`level`, `module`, `event`),
  KEY `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------- 家长端访问与下载审计 ----------
CREATE TABLE IF NOT EXISTS `retest_access_logs` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `token`        VARCHAR(64)  NOT NULL DEFAULT '',
  `student_name` VARCHAR(100) NOT NULL DEFAULT '',
  `action`       VARCHAR(50)  NOT NULL DEFAULT '' COMMENT 'view_page/verify_success/switch_week/download_pdf/...',
  `details`      VARCHAR(512) NOT NULL DEFAULT '',
  `ip`           VARCHAR(50)  NOT NULL DEFAULT '',
  `user_agent`   VARCHAR(500) NOT NULL DEFAULT '',
  `created_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_token` (`token`),
  KEY `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
