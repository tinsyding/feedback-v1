<?php
/**
 * Admin 模块公共辅助函数与认证常量
 */

// Fallback admin credentials (used only if database table is empty or offline)
$localAdminFile = __DIR__ . '/helpers.local.php';
$localAdmin = file_exists($localAdminFile) ? require $localAdminFile : [];

if (!defined('ADMIN_USERNAME')) {
    define('ADMIN_USERNAME', getenv('ADMIN_FALLBACK_USER') ?: ($localAdmin['admin_username'] ?? ($localAdmin['username'] ?? 'admin')));
}
if (!defined('ADMIN_PASSWORD_HASH')) {
    define('ADMIN_PASSWORD_HASH', getenv('ADMIN_FALLBACK_HASH') ?: ($localAdmin['admin_password_hash'] ?? ($localAdmin['password_hash'] ?? '')));
}
if (!defined('ADMIN_PASSWORD_HASHES')) {
    define('ADMIN_PASSWORD_HASHES', $localAdmin['admin_password_hashes'] ?? ($localAdmin['password_hashes'] ?? (ADMIN_PASSWORD_HASH !== '' ? [ADMIN_PASSWORD_HASH] : [])));
}

// Config file path
$configFile = dirname(__DIR__, 2) . '/config.json';



// 禁止通过通用后台 CRUD / 元数据接口访问或修改的系统表黑名单
if (!defined('ADMIN_HIDDEN_TABLES')) {
    define('ADMIN_HIDDEN_TABLES', [
        'app_sessions',
        'schema_migrations'
    ]);
}

/**
 * 判断指定表是否属于禁止通用后台访问的系统表
 */
function isAdminHiddenTable(string $table): bool {
    return in_array(strtolower(trim($table)), ADMIN_HIDDEN_TABLES, true);
}

/**
 * 获取数据库所有有效表（自动排除系统敏感/基础设施表）
 */
function getValidTables(): array {
    $rows = DB::fetchAll("SHOW TABLES");
    $tables = [];
    foreach ($rows as $r) {
        $tbl = (string)reset($r);
        if ($tbl === '' || isAdminHiddenTable($tbl)) {
            continue;
        }
        $tables[] = $tbl;
    }
    return $tables;
}

/**
 * 校验并确保表名安全合法
 */
function validateTable(?string $table): string {
    if (empty($table) || !preg_match('/^[a-zA-Z0-9_]+$/', $table)) {
        sendResponse(false, null, '无效的数据表名称', 400);
    }
    if (isAdminHiddenTable($table)) {
        sendResponse(false, null, "系统表 '{$table}' 禁止通过通用后台接口访问", 403);
    }
    $tables = getValidTables();
    if (!in_array($table, $tables, true)) {
        sendResponse(false, null, "数据表 '{$table}' 不存在", 404);
    }
    return $table;
}

/**
 * 获取指定表字段结构元数据
 */
function getTableColumns(string $table): array {
    $rows = DB::fetchAll("SHOW FULL COLUMNS FROM `{$table}`");
    $cols = [];
    foreach ($rows as $r) {
        $cols[$r['Field']] = [
            'field'   => $r['Field'],
            'name'    => $r['Field'],
            'type'    => $r['Type'],
            'null'    => $r['Null'] === 'YES',
            'key'     => $r['Key'],
            'default' => $r['Default'],
            'extra'   => $r['Extra'],
            'comment' => $r['Comment'] ?? ''
        ];
    }
    return $cols;
}

/**
 * 获取表主键字段名
 */
function getTablePrimaryKey(string $table): string {
    $cols = getTableColumns($table);
    foreach ($cols as $name => $c) {
        if ($c['key'] === 'PRI') {
            return $name;
        }
    }
    return 'id';
}

/**
 * 归一化题库类型并返回文件名后缀片段
 * @return array{0:string, 1:string} [$bankType, $typeSegment]
 */
function resolveQbankTypeAndSegment(?string $rawType): array {
    $t = strtolower(trim((string)$rawType));
    $bankType = in_array($t, ['homework', 'preview', 'variation'], true) ? $t : 'homework';
    $typeSegment = $bankType === 'preview' ? '_preview' : ($bankType === 'variation' ? '_variation' : '');
    return [$bankType, $typeSegment];
}
