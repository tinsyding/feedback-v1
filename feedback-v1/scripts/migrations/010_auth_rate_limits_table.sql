-- ============================================================
-- 010_auth_rate_limits_table.sql
-- PHP 与 Go 后端共享认证防爆破限频表（替代本地 data/.rate_limit_auth.json）
-- ============================================================

CREATE TABLE IF NOT EXISTS `auth_rate_limits` (
  `bucket_key` varchar(191) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'scope:identifier 限频桶键',
  `fail_count` int unsigned NOT NULL DEFAULT 0 COMMENT '当前时间窗口内失败次数',
  `first_at` int unsigned NOT NULL DEFAULT 0 COMMENT '当前时间窗口起始Unix时间戳',
  `updated_at` int unsigned NOT NULL DEFAULT 0 COMMENT '最后一次失败Unix时间戳',
  `lock_until` int unsigned NOT NULL DEFAULT 0 COMMENT '锁定截止Unix时间戳',
  PRIMARY KEY (`bucket_key`),
  KEY `idx_cleanup` (`lock_until`, `updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='PHP与Go共享认证防爆破限频表';
