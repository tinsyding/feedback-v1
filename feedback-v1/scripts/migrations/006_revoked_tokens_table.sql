-- ============================================================
-- 006_revoked_tokens_table.sql
-- 将错题本吊销 Token 黑名单从 data/history/revoked_tokens.json 迁移至 MySQL 表
-- ============================================================

CREATE TABLE IF NOT EXISTS `retest_revoked_tokens` (
  `token` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '被吊销的错题本Token',
  `revoked_by` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '执行作废的操作人',
  `reason` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '作废原因',
  `revoked_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '作废时间',
  PRIMARY KEY (`token`),
  KEY `idx_revoked_at` (`revoked_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='错题本吊销Token黑名单表';
