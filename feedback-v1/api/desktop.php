<?php
/**
 * 桌面发送工具云端诊断接口 (api/desktop.php)
 *
 * 桌面端为单机程序，启动/退出时自动在后台上报诊断日志与发送历史，
 * 供管理员远程协助排查（后台日志页按 module=desktop 过滤；历史快照走 admin 通用 CRUD 查 desktop_uploads 表）。
 * 无需账号密码：上报方以机器指纹标识，服务端记为未核验来源（operator=anon:*），
 * 仅用于排查参考，不作为业务依据。
 *
 * 上报内容：diagnostic 日志（末尾 300 行）、发送历史快照。含学生隐私数据，
 * 上报即视为老师知情（程序内不再二次弹窗）。
 *
 * 限频：每 IP 每分钟最多 30 次（文件锁计数，与 logs.php 同策略）。
 * 载荷上限：日志 ≤100 条/次；历史快照 ≤512KB（超限 413）。
 *
 * POST ?action=upload_logs     { client, entries: [{ts?, level?, msg}] }
 * POST ?action=upload_history  { client, history: {...} }
 * 兼容旧版桌面端：仍可传 username/password，经 users 表 bcrypt 核验后记为该教师。
 */

require_once __DIR__ . '/bootstrap.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/logs.php';

const DESKTOP_MAX_LOG_ENTRIES = 100;
const DESKTOP_MAX_HISTORY_BYTES = 524288; // 512KB
const DESKTOP_RATE_LIMIT = 30;

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'error' => 'Method Not Allowed'], JSON_UNESCAPED_UNICODE);
    exit;
}

$action = $_GET['action'] ?? '';

/** IP 级限频（桌面端无 session，只能按 IP） */
function desktopCheckRateLimit(string $ip): void {
    $f = sys_get_temp_dir() . '/jf_desktop_rate_' . md5($ip) . '.json';
    $now = time();
    $info = ['count' => 0, 'window' => $now];
    if (is_file($f)) {
        $cached = json_decode(@file_get_contents($f), true);
        if (is_array($cached) && isset($cached['window']) && ($now - (int)$cached['window']) < 60) {
            $info = $cached;
        }
    }
    if ((int)($info['count'] ?? 0) >= DESKTOP_RATE_LIMIT) {
        http_response_code(429);
        echo json_encode(['success' => false, 'error' => '上报过于频繁，请稍后再试'], JSON_UNESCAPED_UNICODE);
        exit;
    }
    $info['count'] = (int)($info['count'] ?? 0) + 1;
    if (empty($info['window'])) {
        $info['window'] = $now;
    }
    @file_put_contents($f, json_encode($info), LOCK_EX);
}

/** 校验教师账号（users 表，status=1，bcrypt；测试账号 0 拒绝） */
function desktopAuthTeacher(string $username, string $password): array {
    if ($username === '' || $password === '') {
        sendResponse(false, null, '请输入教师账号和密码', 400);
    }
    if ($username === '0') {
        sendResponse(false, null, '测试账号不支持云端诊断', 403);
    }
    try {
        $user = DB::fetchOne("SELECT * FROM `users` WHERE `username` = ? LIMIT 1", [$username]);
    } catch (Throwable $e) {
        error_log("desktop auth db error: " . $e->getMessage());
        sendResponse(false, null, '数据库服务异常', 500);
    }
    if (!$user || intval($user['status']) !== 1
        || empty($user['password_hash']) || !password_verify($password, $user['password_hash'])) {
        recordServerLog('warn', 'desktop', 'cloud_auth_failed', [
            'username' => $username,
            'ip' => getClientIp(),
            'message' => "桌面端云端诊断鉴权失败: {$username}"
        ]);
        sendResponse(false, null, '账号或密码错误', 401);
    }
    return $user;
}

$clientIp = getClientIp();
desktopCheckRateLimit($clientIp);

$input = json_decode(file_get_contents('php://input'), true) ?: [];
$username = trim((string)($input['username'] ?? ''));
$password = (string)($input['password'] ?? '');
$clientTag = substr(trim((string)($input['client'] ?? '')), 0, 100);

// 身份归属：提供账号密码则核验为教师；否则按匿名机器上报（需带 client 指纹）
$operator = '';
$realName = '';
if ($username === '' && $password === '') {
    $fp = substr(preg_replace('/[^A-Za-z0-9_\-]/', '', $clientTag) ?: 'pc', 0, 50);
    if ($clientTag === '') {
        sendResponse(false, null, '缺少机器标识', 400);
    }
    $operator = 'anon:' . $fp;
} else {
    $user = desktopAuthTeacher($username, $password);
    $realName = $user['real_name'] ?? $username;
    $operator = $username;
}

switch ($action) {
    case 'upload_logs': {
        $entries = $input['entries'] ?? [];
        if (!is_array($entries) || empty($entries)) {
            sendResponse(false, null, '没有可上传的日志条目', 400);
        }
        $entries = array_slice(array_values($entries), 0, DESKTOP_MAX_LOG_ENTRIES);
        $allowedLevels = ['info' => 'info', 'warn' => 'warn', 'error' => 'error', 'action' => 'action'];
        $saved = 0;
        foreach ($entries as $e) {
            if (!is_array($e)) {
                continue;
            }
            $level = strtolower(trim((string)($e['level'] ?? 'info')));
            $level = $allowedLevels[$level] ?? 'info';
            $msg = substr(trim((string)($e['msg'] ?? '')), 0, 2000);
            if ($msg === '') {
                continue;
            }
            recordServerLog($level, 'desktop', 'cloud_log', [
                'message' => $msg,
                'client' => $clientTag,
                'client_ts' => isset($e['ts']) ? substr((string)$e['ts'], 0, 40) : ''
            ], [
                'operator' => $operator
            ]);
            $saved++;
        }
        recordServerLog('action', 'desktop', 'cloud_logs_uploaded', [
            'username' => $operator,
            'real_name' => $realName,
            'count' => $saved,
            'client' => $clientTag,
            'message' => "桌面端 {$operator} 上传了 {$saved} 条诊断日志"
        ]);
        sendResponse(true, ['saved' => $saved, 'message' => "已上传 {$saved} 条诊断日志"]);
        break;
    }

    case 'upload_history': {
        $history = $input['history'] ?? null;
        if (!is_array($history) || empty($history)) {
            sendResponse(false, null, '没有可上传的发送历史', 400);
        }
        $payload = json_encode($history, JSON_UNESCAPED_UNICODE);
        if ($payload === false || $payload === '') {
            sendResponse(false, null, '发送历史序列化失败', 400);
        }
        if (strlen($payload) > DESKTOP_MAX_HISTORY_BYTES) {
            sendResponse(false, null, '发送历史过大（超过 512KB），请清理后重试', 413);
        }
        try {
            DB::execute(
                "INSERT INTO `desktop_uploads` (`username`, `payload`, `client_info`) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE `payload` = VALUES(`payload`), `client_info` = VALUES(`client_info`), `updated_at` = CURRENT_TIMESTAMP",
                [$operator, $payload, $clientTag]
            );
        } catch (Throwable $e) {
            error_log("desktop history upload error: " . $e->getMessage());
            sendResponse(false, null, '发送历史入库失败', 500);
        }
        recordServerLog('action', 'desktop', 'cloud_history_uploaded', [
            'username' => $operator,
            'real_name' => $realName,
            'bytes' => strlen($payload),
            'client' => $clientTag,
            'message' => "桌面端 {$operator} 上传了发送历史快照"
        ]);
        sendResponse(true, ['bytes' => strlen($payload), 'message' => '发送历史已上传，管理员可在后台查看']);
        break;
    }

    default:
        sendResponse(false, null, '未知操作', 400);
}
