-- ============================================================
-- Migration 002: 桌面发送工具云端诊断表
-- 一位教师一行（username 主键，upsert 覆盖），存其最新上传的发送历史快照。
-- 诊断日志不另建表，直接走 system_logs（module='desktop'），后台日志页可按模块过滤查看。
-- ============================================================

CREATE TABLE IF NOT EXISTS `desktop_uploads` (
  `username` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '教师登录账号',
  `payload` mediumtext COLLATE utf8mb4_unicode_ci COMMENT '发送历史 JSON 快照（≤512KB，服务端强制截断）',
  `client_info` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '上报端标识（主机名/版本）',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='桌面端上传的发送历史快照';
