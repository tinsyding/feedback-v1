<?php
/**
 * 极方教学反馈系统 - 核心公共启动引导底座 (api/bootstrap.php)
 * 
 * 统一收敛：
 * 1. 安全 Session 初始化与 Cookie 强化配置
 * 2. 跨域 CORS 白名单与响应头
 * 3. 全局 JSON 输出标准函数 (sendResponse / sendJson)
 * 4. 统一鉴权辅助函数 (isLoggedIn, isUserLoggedIn, isAdminLoggedIn, requireAuth, requireAdmin)
 * 5. 客户端真实 IP 提取
 */

// 1. 安全 Session 初始化
if (session_status() === PHP_SESSION_NONE && !headers_sent()) {
    ini_set('session.cookie_httponly', 1);
    ini_set('session.use_only_cookies', 1);
    ini_set('session.cookie_samesite', 'Lax');
    if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') {
        ini_set('session.cookie_secure', 1);
    }
    session_start();
}

// 2. CORS 跨域请求头与预检统一收敛
$allowedOrigins = [
    'http://localhost',
    'http://127.0.0.1',
    'https://feedback.wxjifang.cn',
    'https://vip.wxjifang.cn',
    'https://vip.jokerx.top'
];
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, $allowedOrigins, true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Access-Control-Allow-Credentials: true');
}
header('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With');

// 统一处理 OPTIONS 预检请求
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// 默认响应格式为 UTF-8 JSON
if (!headers_sent()) {
    header('Content-Type: application/json; charset=utf-8');
}

// 3. 统一 JSON 响应函数
if (!function_exists('sendResponse')) {
    function sendResponse(bool $success, $data = null, ?string $error = null, int $code = 200): void {
        http_response_code($code);
        echo json_encode([
            'success' => $success,
            'data'    => $data,
            'error'   => $error
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }
}

if (!function_exists('sendJson')) {
    function sendJson(bool $success, $data = null, ?string $error = null, int $code = 200): void {
        sendResponse($success, $data, $error, $code);
    }
}

// 4. 客户端 IP 提取 (防伪造版：仅在 REMOTE_ADDR 为受信任代理时采信转发头)
if (!function_exists('getClientIp')) {
    function getClientIp(): string {
        $remoteAddr = $_SERVER['REMOTE_ADDR'] ?? '127.0.0.1';

        $isTrustedProxy = in_array($remoteAddr, ['127.0.0.1', '::1'], true) ||
                          preg_match('/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/', $remoteAddr);

        if ($isTrustedProxy) {
            if (!empty($_SERVER['HTTP_X_REAL_IP'])) {
                $realIp = trim($_SERVER['HTTP_X_REAL_IP']);
                if (filter_var($realIp, FILTER_VALIDATE_IP)) {
                    return substr($realIp, 0, 50);
                }
            }
            if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
                $parts = explode(',', $_SERVER['HTTP_X_FORWARDED_FOR']);
                for ($i = count($parts) - 1; $i >= 0; $i--) {
                    $candidate = trim($parts[$i]);
                    if (filter_var($candidate, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
                        return substr($candidate, 0, 50);
                    }
                }
                $first = trim($parts[0]);
                if (filter_var($first, FILTER_VALIDATE_IP)) {
                    return substr($first, 0, 50);
                }
            }
        }

        return substr($remoteAddr, 0, 50);
    }
}

if (!function_exists('getClientIP')) {
    function getClientIP(): string {
        return getClientIp();
    }
}

// 5. 鉴权辅助函数
if (!function_exists('isUserLoggedIn')) {
    function isUserLoggedIn(): bool {
        return !empty($_SESSION['user_logged_in']);
    }
}

if (!function_exists('isAdminLoggedIn')) {
    function isAdminLoggedIn(): bool {
        return !empty($_SESSION['admin_logged_in']);
    }
}

if (!function_exists('isLoggedIn')) {
    function isLoggedIn(): bool {
        return isUserLoggedIn() || isAdminLoggedIn();
    }
}

/**
 * 拦截未登录访客（允许已登录前台教师或管理员）
 */
if (!function_exists('requireAuth')) {
    function requireAuth(): void {
        if (!isLoggedIn()) {
            sendResponse(false, null, '未登录或登录会话已过期，请重新登录', 401);
        }
    }
}

/**
 * 严格拦截非管理员访客
 */
if (!function_exists('requireAdmin')) {
    function requireAdmin(): void {
        if (!isAdminLoggedIn()) {
            sendResponse(false, null, '未登录或会话已过期，需管理员权限', 401);
        }
    }
}
