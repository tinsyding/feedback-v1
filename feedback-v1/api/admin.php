<?php
/**
 * 管理员 API 核心入口分发器 (Dispatcher)
 *
 * 模块化架构：
 * - helpers: 公共数据表元数据校验与常量
 * - actions_auth: 登录/登出/状态检查/密码修改
 * - actions_config: 系统全局与学期配置
 * - actions_tables: 数据表元数据、字段结构、统计指标
 * - actions_crud: 通用数据列表、详情、增删改查
 * - actions_token: 专属错题本 Token 反查
 * - actions_history: 历史评语版本比对与一键回退
 */

require_once __DIR__ . '/bootstrap.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/logs.php';
require_once __DIR__ . '/admin/helpers.php';

$action = $_GET['action'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];

// CSRF 缓解：后台所有写操作要求 Origin/Referer 严格同主机（不放行跨子域）
verifySameOriginRequest(true, '跨站请求已拦截（Origin 校验失败）');

try {
    switch ($action) {
        // --- 1. 身份认证与密码维护 ---
        case 'login':
        case 'logout':
        case 'check':
        case 'change_password':
            require __DIR__ . '/admin/actions_auth.php';
            break;

        // --- 2. 系统全局与 AI 模型配置 ---
        case 'config':
        case 'test_ai_config':
            require __DIR__ . '/admin/actions_config.php';
            break;


        // --- 3. 数据表元数据与聚合统计 ---
        case 'db_tables':
        case 'db_schema':
        case 'db_batches_options':
        case 'dimensions':
        case 'db_filter_options':
        case 'student_records_stats':
            require __DIR__ . '/admin/actions_tables.php';
            break;

        // --- 4. 通用数据表 CRUD 与重置密码 ---
        case 'db_list':
        case 'db_get':
        case 'db_create':
        case 'db_update':
        case 'db_delete':
        case 'db_reset_teacher_password':
        case 'download_source_file':
            require __DIR__ . '/admin/actions_crud.php';
            break;

        // --- 5. 错题本与 Token 关联查询 ---
        case 'get_retest_admin_url':
        case 'search_by_token':
            require __DIR__ . '/admin/actions_token.php';
            break;

        // --- 6. 学情记录版本历史与回滚 ---
        case 'record_history':
        case 'record_rollback':
            require __DIR__ . '/admin/actions_history.php';
            break;

        default:
            sendResponse(false, null, '未知操作: ' . htmlspecialchars($action), 400);
    }
} catch (Throwable $e) {
    error_log("admin.php error: " . $e->getMessage() . "\n" . $e->getTraceAsString());
    sendResponse(false, null, '服务器内部错误，请稍后重试', 500);
}
