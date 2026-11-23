-- ============================================================
-- 012_qbank_attestation_anchors.sql
-- 题库存证 Merkle Tree 批量外部可信时间锚定（RFC 3161 TSA / 公开透明清单）
-- 约束：必须保持纯标准幂等 CREATE TABLE IF NOT EXISTS（兼容 migrate.php 分号切分）
-- ============================================================

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
