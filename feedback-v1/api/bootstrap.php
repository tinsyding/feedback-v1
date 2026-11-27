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
    function verifySameOriginRequest(bool $strictSameHost = false, ?string $errorMessage = null): void {
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

        if ($checkHost !== '' && hash_equals($host, $checkHost)) {
            return;
        }
        // 非严格模式下，允许受信白名单域名或 wxjifang.cn 子域
        if (!$strictSameHost && $checkHost !== '' && (
            in_array($checkHost, ['localhost', '127.0.0.1', 'feedback.wxjifang.cn', 'vip.wxjifang.cn', 'vip.jokerx.top'], true) ||
            preg_match('/(^|\.)wxjifang\.cn$/', $checkHost)
        )) {
            return;
        }
        $msg = $errorMessage ?? ($strictSameHost
            ? '跨站请求已拦截（Origin 校验失败）'
            : '非法跨站请求 (CSRF Origin Mismatch)');
        sendResponse(false, null, $msg, 403);
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

/**
 * 解析学科权限字符串（如 "数学"、"数学,物理"、"*"）
 * @return array{all:bool, subjects:string[], raw:string}
 */
if (!function_exists('parseSubjectScope')) {
    function parseSubjectScope(string $rawSubject): array {
        $raw = trim($rawSubject);
        if ($raw === '') {
            return ['all' => false, 'subjects' => [], 'raw' => ''];
        }
        $parts = preg_split('/[,，、;；\/|]+/u', $raw) ?: [];
        $subjects = [];
        foreach ($parts as $p) {
            $t = trim($p);
            if ($t === '') continue;
            $lower = strtolower($t);
            if ($t === '*' || $lower === 'all' || $t === '全部' || $t === '所有学科' || $t === '全学科') {
                return ['all' => true, 'subjects' => ['*'], 'raw' => '*'];
            }
            if (!in_array($t, $subjects, true)) {
                $subjects[] = $t;
            }
        }
        return ['all' => false, 'subjects' => $subjects, 'raw' => implode(',', $subjects)];
    }
}

/**
 * 从数据库实时解析账号的有效学科（助教自动继承所属主教师的学科）
 */
if (!function_exists('resolveUserSubjectFromDb')) {
    function resolveUserSubjectFromDb(int $userId = 0, string $username = '', string $role = '', int $teacherId = 0, string $createdBy = ''): ?string {
        $dbFile = __DIR__ . '/db.php';
        if (!is_file($dbFile)) {
            return null;
        }
        require_once $dbFile;
        if (!class_exists('DB')) {
            return null;
        }
        try {
            $row = null;
            if ($userId > 0) {
                $row = DB::fetchOne("SELECT `subject`, `role`, `teacher_id`, `created_by` FROM `users` WHERE `id` = ? LIMIT 1", [$userId]);
            } elseif ($username !== '') {
                $row = DB::fetchOne("SELECT `subject`, `role`, `teacher_id`, `created_by` FROM `users` WHERE `username` = ? LIMIT 1", [$username]);
            }
            if (DB::getLastError() !== null) {
                return null;
            }
            if (!$row) {
                return null;
            }
            $effectiveRole = (string)($row['role'] ?? $role);
            if ($effectiveRole === 'assistant') {
                $parentId = (int)($row['teacher_id'] ?? $teacherId);
                $parentUser = trim((string)($row['created_by'] ?? $createdBy));
                $parent = null;
                if ($parentId > 0) {
                    $parent = DB::fetchOne("SELECT `subject` FROM `users` WHERE `id` = ? LIMIT 1", [$parentId]);
                }
                if (!$parent && $parentUser !== '') {
                    $parent = DB::fetchOne("SELECT `subject` FROM `users` WHERE `username` = ? LIMIT 1", [$parentUser]);
                }
                if ($parent && isset($parent['subject'])) {
                    return trim((string)$parent['subject']);
                }
            }
            return trim((string)($row['subject'] ?? ''));
        } catch (Throwable $e) {
            return null;
        }
    }
}

/**
 * 获取当前登录用户的有效学科权限范围
 * @return array{all:bool, subjects:string[], raw:string}
 */
if (!function_exists('getCurrentUserSubjectScope')) {
    function getCurrentUserSubjectScope(): array {
        $uRole = (string)($_SESSION['user_role'] ?? ($_SESSION['role'] ?? ''));
        if (isAdminLoggedIn() || in_array($uRole, ['admin', 'super_admin'], true)) {
            return ['all' => true, 'subjects' => ['*'], 'raw' => '*'];
        }
        if (!isUserLoggedIn()) {
            return ['all' => false, 'subjects' => [], 'raw' => ''];
        }
        $userId = (int)($_SESSION['user_id'] ?? 0);
        $username = trim((string)($_SESSION['username'] ?? ''));
        $teacherId = (int)($_SESSION['user_teacher_id'] ?? 0);
        $createdBy = trim((string)($_SESSION['user_created_by'] ?? ''));

        $dbSubject = resolveUserSubjectFromDb($userId, $username, $uRole, $teacherId, $createdBy);
        if ($dbSubject !== null) {
            return parseSubjectScope($dbSubject);
        }
        return parseSubjectScope((string)($_SESSION['user_subject'] ?? ''));
    }
}

/**
 * 判断指定学科是否在当前用户权限内
 */
if (!function_exists('isSubjectAllowed')) {
    function isSubjectAllowed(string $subject, ?array $scope = null): bool {
        $scope = $scope ?? getCurrentUserSubjectScope();
        if (!empty($scope['all'])) {
            return true;
        }
        $subject = trim($subject);
        if ($subject === '') {
            return false;
        }
        return in_array($subject, $scope['subjects'] ?? [], true);
    }
}

/**
 * 强校验当前用户对指定学科的访问权限，越权直接返回 403
 * @return array{all:bool, subjects:string[], raw:string}
 */
if (!function_exists('requireSubjectAccess')) {
    function requireSubjectAccess(string $subject, string $actionDesc = '访问该学科数据'): array {
        $scope = getCurrentUserSubjectScope();
        if (!empty($scope['all'])) {
            return $scope;
        }
        if (empty($scope['subjects'])) {
            sendResponse(false, null, '当前账号尚未分配所属学科，请联系管理员配置', 403);
        }
        if (!isSubjectAllowed($subject, $scope)) {
            $allowedText = implode('、', $scope['subjects']);
            sendResponse(false, null, "无权{$actionDesc}（当前账号仅限学科：{$allowedText}）", 403);
        }
        return $scope;
    }
}

// 7. 持久化服务端认证防爆破限频器（优先 MySQL auth_rate_limits 共享表，DB 离线/未迁移时自动回退本地文件）
if (!function_exists('getAuthRateLimitFilePath')) {
    function getAuthRateLimitFilePath(): string {
        $dir = __DIR__ . '/../data';
        if (!is_dir($dir)) {
            @mkdir($dir, 0755, true);
        }
        return $dir . '/.rate_limit_auth.json';
    }
}

if (!function_exists('getAuthRateLimitPdo')) {
    function getAuthRateLimitPdo(): ?PDO {
        if (strtolower(trim((string)getenv('FEEDBACK_RATELIMIT_DRIVER'))) === 'files') {
            return null;
        }
        $dbFile = __DIR__ . '/db.php';
        if (!is_file($dbFile)) {
            return null;
        }
        require_once $dbFile;
        if (!class_exists('DB')) {
            return null;
        }
        return DB::getConnection();
    }
}

if (!function_exists('normalizeAuthRateLimitKey')) {
    function normalizeAuthRateLimitKey(string $scope, string $identifier): string {
        $key = $scope . ':' . strtolower(trim($identifier));
        if (strlen($key) > 191) {
            $key = substr($key, 0, 158) . ':' . md5($key);
        }
        return $key;
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
        // 账号登录/重置密码封禁锁定功能已关闭
        return ['count' => 0, 'locked' => false, 'remaining_seconds' => 0];
    }
}

if (!function_exists('recordAuthRateLimitFailure')) {
    /**
     * 记录一次认证失败；若达到阈值则触发锁定
     * @return array{count:int, locked:bool, remaining_seconds:int}
     */
    function recordAuthRateLimitFailure(string $scope, string $identifier, int $maxAttempts = 5, int $windowSeconds = 900, int $lockoutSeconds = 900): array {
        // 账号登录/重置密码封禁锁定功能已关闭
        return ['count' => 0, 'locked' => false, 'remaining_seconds' => 0];
    }
}

if (!function_exists('clearAuthRateLimitFailures')) {
    /**
     * 认证成功后清理对应桶的失败记录
     */
    function clearAuthRateLimitFailures(string $scope, string $identifier): void {
        $key = normalizeAuthRateLimitKey($scope, $identifier);

        $pdo = getAuthRateLimitPdo();
        if ($pdo) {
            try {
                $stmt = $pdo->prepare('DELETE FROM `auth_rate_limits` WHERE `bucket_key` = ?');
                $stmt->execute([$key]);
                return;
            } catch (Throwable $e) {
                error_log('clearAuthRateLimitFailures MySQL fallback: ' . $e->getMessage());
            }
        }

        withAuthRateLimitStore(function (array &$store, bool &$modified = false) use ($key) {
            if (isset($store[$key])) {
                unset($store[$key]);
                $modified = true;
            }
            return true;
        });
    }
}

