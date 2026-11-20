<?php
/**
 * MySQL 共享 Session 存储适配器 (api/session_mysql.php)
 *
 * 将 PHP 原生文件 Session 迁移至 MySQL `app_sessions` 表，实现：
 * 1. 消除 PHP 默认文件 Session 存储攻击面；
 * 2. 双写 payload_php（PHP 原生序列化）与 payload_json（标准 JSON），供 Go 后端共享鉴权。
 */

class MySqlSessionHandler implements SessionHandlerInterface
{
    private PDO $pdo;
    private int $ttl;
    private string $lockFile;
    /** @var array<string, bool> */
    private array $knownExisting = [];

    public function __construct(PDO $pdo, int $ttl = 0, string $lockFile = '')
    {
        $this->pdo = $pdo;
        if ($ttl <= 0) {
            $ttl = (int)ini_get('session.gc_maxlifetime');
        }
        $this->ttl = max(1440, $ttl);
        $this->lockFile = $lockFile;
    }

    private static function isValidId(string $id): bool
    {
        return (bool)preg_match('/^[A-Za-z0-9,_-]{16,128}$/', $id);
    }

    private function isMissingTableError(Throwable $e): bool
    {
        if ($e instanceof PDOException) {
            if ($e->getCode() === '42S02') {
                return true;
            }
            if (isset($e->errorInfo[0]) && $e->errorInfo[0] === '42S02') {
                return true;
            }
        }
        $msg = $e->getMessage();
        return strpos($msg, '42S02') !== false || strpos($msg, "doesn't exist") !== false;
    }

    private function recoverMissingTable(): bool
    {
        if ($this->lockFile !== '' && is_file($this->lockFile)) {
            @unlink($this->lockFile);
        }
        if (!ensureAppSessionsTable($this->pdo)) {
            return false;
        }
        if ($this->lockFile !== '') {
            $dir = dirname($this->lockFile);
            if (!is_dir($dir)) {
                @mkdir($dir, 0755, true);
            }
            @file_put_contents($this->lockFile, date('Y-m-d H:i:s'));
        }
        return true;
    }

    public function open(string $path, string $name): bool
    {
        return true;
    }

    public function close(): bool
    {
        return true;
    }

    public function read(string $id): string|false
    {
        unset($this->knownExisting[$id]);
        if (!self::isValidId($id)) {
            return '';
        }
        for ($attempt = 0; $attempt < 2; $attempt++) {
            try {
                $stmt = $this->pdo->prepare(
                    'SELECT `payload_php`, `payload_json` FROM `app_sessions` WHERE `session_id` = ? AND `expires_at` >= ? LIMIT 1'
                );
                $stmt->execute([$id, time()]);
                $row = $stmt->fetch(PDO::FETCH_ASSOC);
                if (!$row) {
                    return '';
                }
                $this->knownExisting[$id] = true;
                $phpPayload = (string)($row['payload_php'] ?? '');
                if ($phpPayload !== '') {
                    return $phpPayload;
                }
                // 兼容由 Go 端写入的纯 JSON 会话（payload_php 为空时按 php 格式回编）
                $jsonRaw = $row['payload_json'] ?? null;
                if (is_string($jsonRaw) && $jsonRaw !== '') {
                    $decoded = json_decode($jsonRaw, true);
                    if (is_array($decoded)) {
                        $encoded = '';
                        foreach ($decoded as $k => $v) {
                            $ks = (string)$k;
                            if ($ks === '' || strpos($ks, '|') !== false || strpos($ks, '!') !== false) {
                                continue;
                            }
                            $encoded .= $ks . '|' . serialize($v);
                        }
                        return $encoded;
                    }
                }
                return '';
            } catch (Throwable $e) {
                if ($attempt === 0 && $this->isMissingTableError($e) && $this->recoverMissingTable()) {
                    continue;
                }
                error_log('MySqlSessionHandler::read error: ' . $e->getMessage());
                return '';
            }
        }
        return '';
    }

    public function write(string $id, string $data): bool
    {
        if (!self::isValidId($id)) {
            return false;
        }
        $sessionArr = (isset($_SESSION) && is_array($_SESSION)) ? $_SESSION : [];
        $isEmpty = ($data === '' && empty($sessionArr));

        for ($attempt = 0; $attempt < 2; $attempt++) {
            try {
                if ($isEmpty) {
                    // 已存在会话被清空（如 auth.php?action=logout 通过 unset 清空）时必须删行，避免登出失效
                    if (!empty($this->knownExisting[$id])) {
                        $del = $this->pdo->prepare('DELETE FROM `app_sessions` WHERE `session_id` = ?');
                        $del->execute([$id]);
                        unset($this->knownExisting[$id]);
                    }
                    return true;
                }

                $encoded = json_encode($sessionArr, JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR);
                $jsonPayload = ($encoded !== false && $encoded !== '[]') ? $encoded : '{}';
                $expiresAt = time() + $this->ttl;
                $stmt = $this->pdo->prepare(
                    'INSERT INTO `app_sessions` (`session_id`, `payload_php`, `payload_json`, `expires_at`)
                     VALUES (?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                       `payload_php` = VALUES(`payload_php`),
                       `payload_json` = VALUES(`payload_json`),
                       `expires_at` = VALUES(`expires_at`),
                       `updated_at` = CURRENT_TIMESTAMP'
                );
                $ok = $stmt->execute([$id, $data, $jsonPayload, $expiresAt]);
                if ($ok) {
                    $this->knownExisting[$id] = true;
                }
                return $ok;
            } catch (Throwable $e) {
                if ($attempt === 0 && $this->isMissingTableError($e) && $this->recoverMissingTable()) {
                    continue;
                }
                error_log('MySqlSessionHandler::write error: ' . $e->getMessage());
                return false;
            }
        }
        return false;
    }

    public function destroy(string $id): bool
    {
        unset($this->knownExisting[$id]);
        if (!self::isValidId($id)) {
            return true;
        }
        for ($attempt = 0; $attempt < 2; $attempt++) {
            try {
                $stmt = $this->pdo->prepare('DELETE FROM `app_sessions` WHERE `session_id` = ?');
                return $stmt->execute([$id]);
            } catch (Throwable $e) {
                if ($attempt === 0 && $this->isMissingTableError($e) && $this->recoverMissingTable()) {
                    continue;
                }
                error_log('MySqlSessionHandler::destroy error: ' . $e->getMessage());
                return false;
            }
        }
        return false;
    }

    public function gc(int $max_lifetime): int|false
    {
        for ($attempt = 0; $attempt < 2; $attempt++) {
            try {
                $stmt = $this->pdo->prepare('DELETE FROM `app_sessions` WHERE `expires_at` < ?');
                $stmt->execute([time()]);
                return $stmt->rowCount();
            } catch (Throwable $e) {
                if ($attempt === 0 && $this->isMissingTableError($e) && $this->recoverMissingTable()) {
                    continue;
                }
                error_log('MySqlSessionHandler::gc error: ' . $e->getMessage());
                return false;
            }
        }
        return false;
    }
}

/**
 * 检查并按需创建 app_sessions 表。
 */
function ensureAppSessionsTable(PDO $pdo): bool
{
    try {
        $chk = $pdo->query("SHOW TABLES LIKE 'app_sessions'");
        if (!$chk || !$chk->fetch()) {
            $pdo->exec("CREATE TABLE IF NOT EXISTS `app_sessions` (
                `session_id` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'PHPSESSID',
                `payload_php` mediumtext COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'PHP原生序列化会话载荷',
                `payload_json` json DEFAULT NULL COMMENT '标准JSON会话镜像（供Go后端共享读取/写入）',
                `expires_at` int unsigned NOT NULL COMMENT '过期Unix时间戳',
                `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (`session_id`),
                KEY `idx_expires_at` (`expires_at`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='PHP与Go共享会话表'");
        }
        return true;
    } catch (Throwable $e) {
        error_log('ensureAppSessionsTable warning: ' . $e->getMessage());
        return false;
    }
}

/**
 * 若数据库可用且未显式强制 files 模式，注册 MySQL 共享 Session 处理器。
 */
function registerSharedMySqlSessionHandler(): bool
{
    if (strtolower(trim((string)getenv('FEEDBACK_SESSION_DRIVER'))) === 'files') {
        return false;
    }
    $dbFile = __DIR__ . '/db.php';
    if (!is_file($dbFile)) {
        return false;
    }
    require_once $dbFile;
    if (!class_exists('DB')) {
        return false;
    }
    $pdo = DB::getConnection();
    if (!$pdo) {
        return false;
    }
    try {
        $lockFile = dirname(__DIR__) . '/data/.app_sessions_ready.lock';
        if (!is_file($lockFile)) {
            if (!ensureAppSessionsTable($pdo)) {
                return false;
            }
            $dataDir = dirname($lockFile);
            if (!is_dir($dataDir)) {
                @mkdir($dataDir, 0755, true);
            }
            @file_put_contents($lockFile, date('Y-m-d H:i:s'));
        }
        return session_set_save_handler(new MySqlSessionHandler($pdo, 0, $lockFile), true);
    } catch (Throwable $e) {
        error_log('registerSharedMySqlSessionHandler warning: ' . $e->getMessage());
        return false;
    }
}
