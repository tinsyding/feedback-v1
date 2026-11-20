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

// 1. 安全 Session 初始化（优先挂载 MySQL 共享会话表，DB 离线时自动回退原生 Session）
if (session_status() === PHP_SESSION_NONE && !headers_sent()) {
    ini_set('session.cookie_httponly', 1);
    ini_set('session.use_only_cookies', 1);
    ini_set('session.cookie_samesite', 'Lax');
    if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') {
        ini_set('session.cookie_secure', 1);
    }
    require_once __DIR__ . '/session_mysql.php';
    registerSharedMySqlSessionHandler();
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
$isAllowedOrigin = in_array($origin, $allowedOrigins, true);
if (!$isAllowedOrigin && !empty($origin)) {
    // 自动适配所有 wxjifang.cn 子域名（如 feedbackbackup / feedbacktest 等测试与预览站）
    if (preg_match('#^https?://([a-zA-Z0-9-]+\.)*wxjifang\.cn(:\d+)?$#', $origin)) {
        $isAllowedOrigin = true;
    }
}
if ($isAllowedOrigin) {
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

require_once __DIR__ . '/lib_normalize.php';

// 5. 全局写请求同源 CSRF 校验（当请求携带 Origin 或 Referer 时校验是否属于当前站点或白名单域名）
if (!function_exists('verifySameOriginRequest')) {
    function verifySameOriginRequest(): void {
        $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
        if (!in_array($method, ['POST', 'PUT', 'DELETE', 'PATCH'], true)) {
            return;
        }
        $reqOrigin = $_SERVER['HTTP_ORIGIN'] ?? '';
        $reqReferer = $_SERVER['HTTP_REFERER'] ?? '';
        if ($reqOrigin === '' && $reqReferer === '') {
            return;
        }
        $host = strtolower(explode(':', $_SERVER['HTTP_HOST'] ?? '')[0]);
        if ($host === '') {
            return;
        }
        $checkHost = $reqOrigin !== ''
            ? strtolower((string)parse_url($reqOrigin, PHP_URL_HOST))
            : strtolower((string)parse_url($reqReferer, PHP_URL_HOST));

        if ($checkHost === $host) {
            return;
        }
        // 允许受信白名单域名或 wxjifang.cn 子域
        if ($checkHost !== '' && (
            in_array($checkHost, ['localhost', '127.0.0.1', 'feedback.wxjifang.cn', 'vip.wxjifang.cn', 'vip.jokerx.top'], true) ||
            preg_match('/(^|\.)wxjifang\.cn$/', $checkHost)
        )) {
            return;
        }
        sendResponse(false, null, '非法跨站请求 (CSRF Origin Mismatch)', 403);
    }
}
verifySameOriginRequest();

// 6. 鉴权辅助函数
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
 * @param bool $closeSession 鉴权通过后是否立即释放 Session 排他文件锁（默认 true，防止耗时请求阻塞并发）
 */
if (!function_exists('requireAuth')) {
    function requireAuth(bool $closeSession = true): void {
        if (!isLoggedIn()) {
            sendResponse(false, null, '未登录或登录会话已过期，请重新登录', 401);
        }
        if ($closeSession && session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
    }
}

/**
 * 拦截助教（assistant）角色执行越权写操作（管理员或主讲教师放行）
 */
if (!function_exists('requireNonAssistant')) {
    function requireNonAssistant(string $actionDesc = '执行此操作'): void {
        if (!isAdminLoggedIn() && ($_SESSION['user_role'] ?? ($_SESSION['role'] ?? '')) === 'assistant') {
            sendResponse(false, null, "助教账号无权{$actionDesc}，仅主讲教师或管理员可操作", 403);
        }
    }
}

/**
 * 严格拦截非管理员访客
 */
if (!function_exists('requireAdmin')) {
    function requireAdmin(bool $closeSession = false): void {
        if (!isAdminLoggedIn()) {
            sendResponse(false, null, '未登录或会话已过期，需管理员权限', 401);
        }
        if ($closeSession && session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
    }
}

// 7. 持久化服务端认证防爆破限频器（基于 IP + 账号落盘，防止不带 PHPSESSID Cookie 绕过）
if (!function_exists('getAuthRateLimitFilePath')) {
    function getAuthRateLimitFilePath(): string {
        $dir = __DIR__ . '/../data';
        if (!is_dir($dir)) {
            @mkdir($dir, 0755, true);
        }
        return $dir . '/.rate_limit_auth.json';
    }
}

if (!function_exists('withAuthRateLimitStore')) {
    function withAuthRateLimitStore(callable $callback) {
        $file = getAuthRateLimitFilePath();
        $fp = @fopen($file, 'c+');
        if (!$fp) {
            return $callback([]);
        }
        $result = null;
        if (flock($fp, LOCK_EX)) {
            $raw = stream_get_contents($fp);
            $store = json_decode((string)$raw, true);
            if (!is_array($store)) {
                $store = [];
            }
            $now = time();
            // 清理超过 24 小时的过期桶
            foreach ($store as $k => $v) {
                $lastTs = intval($v['updated_at'] ?? 0);
                $lockUntil = intval($v['lock_until'] ?? 0);
                if ($now > $lockUntil && ($now - $lastTs) > 86400) {
                    unset($store[$k]);
                }
            }
            $modified = false;
            $result = $callback($store, $modified);
            if ($modified) {
                ftruncate($fp, 0);
                rewind($fp);
                fwrite($fp, json_encode($store, JSON_UNESCAPED_UNICODE));
                fflush($fp);
            }
            flock($fp, LOCK_UN);
        } else {
            $result = $callback([]);
        }
        fclose($fp);
        return $result;
    }
}

if (!function_exists('getAuthRateLimitStatus')) {
    /**
     * 查询某作用域 (scope + identifier) 的当前失败次数与剩余锁定秒数
     * @return array{count:int, locked:bool, remaining_seconds:int}
     */
    function getAuthRateLimitStatus(string $scope, string $identifier, int $windowSeconds = 900): array {
        $key = $scope . ':' . strtolower(trim($identifier));
        $now = time();
        return withAuthRateLimitStore(function (array &$store) use ($key, $now, $windowSeconds) {
            $entry = $store[$key] ?? null;
            if (!is_array($entry)) {
                return ['count' => 0, 'locked' => false, 'remaining_seconds' => 0];
            }
            $lockUntil = intval($entry['lock_until'] ?? 0);
            if ($lockUntil > $now) {
                return [
                    'count' => intval($entry['count'] ?? 0),
                    'locked' => true,
                    'remaining_seconds' => $lockUntil - $now
                ];
            }
            $firstAt = intval($entry['first_at'] ?? ($entry['updated_at'] ?? 0));
            if ($windowSeconds > 0 && ($now - $firstAt) > $windowSeconds) {
                return ['count' => 0, 'locked' => false, 'remaining_seconds' => 0];
            }
            return [
                'count' => intval($entry['count'] ?? 0),
                'locked' => false,
                'remaining_seconds' => 0
            ];
        });
    }
}

if (!function_exists('recordAuthRateLimitFailure')) {
    /**
     * 记录一次认证失败；若达到阈值则触发锁定
     * @return array{count:int, locked:bool, remaining_seconds:int}
     */
    function recordAuthRateLimitFailure(string $scope, string $identifier, int $maxAttempts = 5, int $windowSeconds = 900, int $lockoutSeconds = 900): array {
        $key = $scope . ':' . strtolower(trim($identifier));
        $now = time();
        return withAuthRateLimitStore(function (array &$store, bool &$modified = false) use ($key, $now, $maxAttempts, $windowSeconds, $lockoutSeconds) {
            $modified = true;
            $entry = $store[$key] ?? null;
            if (!is_array($entry)) {
                $entry = ['count' => 0, 'first_at' => $now, 'updated_at' => $now, 'lock_until' => 0];
            } else {
                $firstAt = intval($entry['first_at'] ?? 0);
                $lockUntil = intval($entry['lock_until'] ?? 0);
                if ($lockUntil <= $now && $windowSeconds > 0 && ($now - $firstAt) > $windowSeconds) {
                    $entry = ['count' => 0, 'first_at' => $now, 'updated_at' => $now, 'lock_until' => 0];
                }
            }
            $entry['count'] = intval($entry['count'] ?? 0) + 1;
            $entry['updated_at'] = $now;
            if ($maxAttempts > 0 && $entry['count'] >= $maxAttempts && $lockoutSeconds > 0) {
                $entry['lock_until'] = $now + $lockoutSeconds;
            }
            $store[$key] = $entry;
            $rem = max(0, intval($entry['lock_until'] ?? 0) - $now);
            return [
                'count' => $entry['count'],
                'locked' => $rem > 0,
                'remaining_seconds' => $rem
            ];
        });
    }
}

if (!function_exists('clearAuthRateLimitFailures')) {
    /**
     * 认证成功后清理对应桶的失败记录
     */
    function clearAuthRateLimitFailures(string $scope, string $identifier): void {
        $key = $scope . ':' . strtolower(trim($identifier));
        withAuthRateLimitStore(function (array &$store, bool &$modified = false) use ($key) {
            if (isset($store[$key])) {
                unset($store[$key]);
                $modified = true;
            }
            return true;
        });
    }
}

