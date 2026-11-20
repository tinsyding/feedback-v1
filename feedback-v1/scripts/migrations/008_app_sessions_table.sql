-- ============================================================
-- 008_app_sessions_table.sql
-- PHP 与 Go 后端共享会话表（替代 PHP 默认文件 Session）
-- ============================================================

CREATE TABLE IF NOT EXISTS `app_sessions` (
  `session_id` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'PHPSESSID',
  `payload_php` mediumtext COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'PHP原生序列化会话载荷',
  `payload_json` json DEFAULT NULL COMMENT '标准JSON会话镜像（供Go后端共享读取/写入）',
  `expires_at` int unsigned NOT NULL COMMENT '过期Unix时间戳',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`session_id`),
  KEY `idx_expires_at` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='PHP与Go共享会话表';
