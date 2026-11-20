<?php
/**
 * 错题本 Token 吊销辅助（纯 MySQL 数据库方案）
 *
 * 说明：学生错题数据的 JSON 双写档案（data/history/*.json、token_map.json、revoked_tokens.json）
 * 已全面下线，统一以 MySQL `student_records` 与 `retest_revoked_tokens` 表为唯一数据源。
 * 本文件仅保留吊销 Token 写入数据库接口及旧清理函数签名兼容（空操作）。
 */

require_once __DIR__ . '/lib_retest_keys.php';

if (!function_exists('retest_cleanup_add_revoked_token')) {
    function retest_cleanup_add_revoked_token(
        string $token,
        string $operator = 'system',
        string $reason = '',
        ?string $historyDir = null
    ): bool {
        $token = substr(trim($token), 0, 64);
        if ($token === '') {
            return false;
        }
        if (!class_exists('DB')) {
            require_once __DIR__ . '/db.php';
        }
        try {
            DB::execute(
                "INSERT INTO `retest_revoked_tokens` (`token`, `revoked_by`, `reason`, `revoked_at`)
                 VALUES (?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE
                     `revoked_by` = VALUES(`revoked_by`),
                     `reason` = VALUES(`reason`),
                     `revoked_at` = NOW()",
                [$token, substr(trim($operator), 0, 50), substr(trim($reason), 0, 255)]
            );
            return true;
        } catch (Throwable $e) {
            error_log("retest_cleanup_add_revoked_token DB error: " . $e->getMessage());
            return false;
        }
    }
}

if (!function_exists('retest_cleanup_after_deleted_records')) {
    function retest_cleanup_after_deleted_records(array $affectedRows, ?string $historyDir = null): array
    {
        return [];
    }
}

if (!function_exists('retest_sync_student_record_to_json')) {
    function retest_sync_student_record_to_json(int $recordId, ?string $historyDir = null): bool
    {
        return true;
    }
}
