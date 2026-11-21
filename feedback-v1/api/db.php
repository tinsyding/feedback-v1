<?php
/**
 * 数据库核心连接与操作模块 (MySQL PDO)
 */

class DB {
    private static ?PDO $instance = null;

    private static array $config = [
        'host'     => '127.0.0.1',
        'port'     => 3306,
        'dbname'   => 'feedback',
        'username' => 'root',
        'password' => '',
        'charset'  => 'utf8mb4'
    ];

    /**
     * 获取 PDO 单例连接
     */
    public static function getConnection(): ?PDO {
        if (self::$instance === null) {
            $cfg = self::$config;

            // 优先读取本地配置文件 (已加 .gitignore 保护)
            $localConfig = __DIR__ . '/db.local.php';
            if (file_exists($localConfig)) {
                $local = require $localConfig;
                if (is_array($local)) {
                    $cfg = array_merge($cfg, $local);
                }
            }

            // 环境变量覆盖支持
            if (getenv('DB_HOST'))     $cfg['host']     = getenv('DB_HOST');
            if (getenv('DB_PORT'))     $cfg['port']     = (int)getenv('DB_PORT');
            if (getenv('DB_DATABASE')) $cfg['dbname']   = getenv('DB_DATABASE');
            if (getenv('DB_USERNAME')) $cfg['username'] = getenv('DB_USERNAME');
            if (getenv('DB_PASSWORD') !== false) $cfg['password'] = getenv('DB_PASSWORD');

            $dsn = "mysql:host={$cfg['host']};port={$cfg['port']};dbname={$cfg['dbname']};charset={$cfg['charset']}";
            $options = [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES   => false
            ];
            if (defined('PDO::MYSQL_ATTR_INIT_COMMAND')) {
                $options[PDO::MYSQL_ATTR_INIT_COMMAND] = "SET NAMES {$cfg['charset']} COLLATE utf8mb4_unicode_ci";
            }

            try {
                self::$instance = new PDO($dsn, $cfg['username'], $cfg['password'], $options);
                self::$instance->exec("SET NAMES {$cfg['charset']} COLLATE utf8mb4_unicode_ci");
            } catch (PDOException $e) {
                error_log("Database connection failed: " . $e->getMessage());
                return null;
            }
        }
        return self::$instance;
    }

    private static ?string $lastError = null;

    public static function getLastError(): ?string {
        return self::$lastError;
    }

    /**
     * 快速执行参数化查询
     */
    public static function query(string $sql, array $params = []): ?PDOStatement {
        self::$lastError = null;
        $db = self::getConnection();
        if (!$db) {
            self::$lastError = "数据库连接失败";
            return null;
        }
        try {
            $stmt = $db->prepare($sql);
            $stmt->execute($params);
            return $stmt;
        } catch (PDOException $e) {
            self::$lastError = $e->getMessage();
            error_log("DB Query Error: " . $e->getMessage() . " | SQL: " . $sql);
            return null;
        }
    }

    /**
     * 获取单行数据
     */
    public static function fetchOne(string $sql, array $params = []): ?array {
        $stmt = self::query($sql, $params);
        return $stmt ? ($stmt->fetch() ?: null) : null;
    }

    /**
     * 获取多行数据
     */
    public static function fetchAll(string $sql, array $params = []): array {
        $stmt = self::query($sql, $params);
        return $stmt ? $stmt->fetchAll() : [];
    }

    /**
     * 获取单个值
     */
    public static function fetchValue(string $sql, array $params = []): mixed {
        $stmt = self::query($sql, $params);
        return $stmt ? $stmt->fetchColumn() : null;
    }

    /**
     * 执行插入/更新/删除，返回受影响行数；执行失败时抛出异常
     * @throws RuntimeException
     */
    public static function execute(string $sql, array $params = []): int {
        $stmt = self::query($sql, $params);
        if ($stmt === null) {
            throw new RuntimeException(self::$lastError ?: "数据库操作执行失败");
        }
        return $stmt->rowCount();
    }

    /**
     * 获取最后插入的自增 ID
     */
    public static function lastInsertId(): string {
        $db = self::getConnection();
        return $db ? $db->lastInsertId() : '0';
    }

    /**
     * 获取单例实例（支持链式与面向对象调用）
     */
    public static function getInstance(): self {
        return new self();
    }

    public function __call(string $name, array $args): mixed {
        if (method_exists(self::class, $name)) {
            return forward_static_call_array([self::class, $name], $args);
        }
        throw new BadMethodCallException("Method {$name} does not exist in DB class");
    }
}

class_alias('DB', 'Database');

