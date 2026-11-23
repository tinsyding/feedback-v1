-- ============================================================
-- 011_qbank_attestation_tables.sql
-- 题库配置密码学存证、哈希链版本账本与操作过程留痕表
-- 约束：必须保持纯标准幂等 CREATE TABLE IF NOT EXISTS（兼容 migrate.php 分号切分）
-- ============================================================

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
