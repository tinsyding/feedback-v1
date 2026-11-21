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
    /** @var array<string, bool> */
    private array $knownExisting = [];

    public function __construct(PDO $pdo, int $ttl = 0)
    {
        $this->pdo = $pdo;
        if ($ttl <= 0) {
            $ttl = (int)ini_get('session.gc_maxlifetime');
        }
        $this->ttl = max(1440, $ttl);
    }

    private static function isValidId(string $id): bool
    {
        return (bool)preg_match('/^[A-Za-z0-9,_-]{16,128}$/', $id);
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
            error_log('MySqlSessionHandler::read error: ' . $e->getMessage());
            return '';
        }
    }

    public function write(string $id, string $data): bool
    {
        if (!self::isValidId($id)) {
            return false;
        }
        $sessionArr = (isset($_SESSION) && is_array($_SESSION)) ? $_SESSION : [];
        $isEmpty = ($data === '' && empty($sessionArr));

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
            error_log('MySqlSessionHandler::write error: ' . $e->getMessage());
            return false;
        }
    }

    public function destroy(string $id): bool
    {
        unset($this->knownExisting[$id]);
        if (!self::isValidId($id)) {
            return true;
        }
        try {
            $stmt = $this->pdo->prepare('DELETE FROM `app_sessions` WHERE `session_id` = ?');
            return $stmt->execute([$id]);
        } catch (Throwable $e) {
            error_log('MySqlSessionHandler::destroy error: ' . $e->getMessage());
            return false;
        }
    }

    public function gc(int $max_lifetime): int|false
    {
        try {
            $stmt = $this->pdo->prepare('DELETE FROM `app_sessions` WHERE `expires_at` < ?');
            $stmt->execute([time()]);
            return $stmt->rowCount();
        } catch (Throwable $e) {
            error_log('MySqlSessionHandler::gc error: ' . $e->getMessage());
            return false;
        }
    }
}

/**
 * 若数据库可用且未显式强制 files 模式，注册 MySQL 共享 Session 处理器。
 * 表结构由 scripts/migrations/008_app_sessions_table.sql 维护，不在请求路径执行 DDL。
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
        return session_set_save_handler(new MySqlSessionHandler($pdo, 0), true);
    } catch (Throwable $e) {
        error_log('registerSharedMySqlSessionHandler warning: ' . $e->getMessage());
        return false;
    }
}
