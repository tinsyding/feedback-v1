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
                self::ensureSchemaUpgrades(self::$instance);
            } catch (PDOException $e) {
                error_log("Database connection failed: " . $e->getMessage());
                return null;
            }
        }
        return self::$instance;
    }

    /**
     * 一次性轻量数据库结构自愈升级（通过 lock 文件标记，仅在首次连接时执行一次，零运行时开销）
     * 1. 为 student_records 补齐 submission_status / preview_submission_status 显式提交状态字段
     * 2. 归一化 class_batches.season，归并历史重复批次并添加 uk_batch_identity 唯一索引
     */
    private static function ensureSchemaUpgrades(PDO $pdo): void {
        $lockFile = dirname(__DIR__) . '/data/.schema_v202611_migrated.lock';
        if (is_file($lockFile)) {
            return;
        }
        try {
            // 1. 检查并补齐 student_records.submission_status 与 preview_submission_status
            $colStmt = $pdo->query("SHOW COLUMNS FROM `student_records` LIKE 'submission_status'");
            if ($colStmt && !$colStmt->fetch()) {
                $pdo->exec("ALTER TABLE `student_records`
                    ADD COLUMN `submission_status` VARCHAR(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'submitted' COMMENT '课后作业提交状态: submitted/unsubmitted/exempt' AFTER `total_score`,
                    ADD COLUMN `preview_submission_status` VARCHAR(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'submitted' COMMENT '预习作业提交状态: submitted/unsubmitted/exempt' AFTER `submission_status`");
            }

            // 2. 归一化 class_batches 的 season 并归并重复批次后添加 uk_batch_identity 唯一索引
            $idxStmt = $pdo->query("SHOW INDEX FROM `class_batches` WHERE Key_name = 'uk_batch_identity'");
            if ($idxStmt && !$idxStmt->fetch()) {
                $pdo->exec("UPDATE `class_batches` SET `season` = '春' WHERE LOWER(`season`) IN ('spring', '春季')");
                $pdo->exec("UPDATE `class_batches` SET `season` = '暑' WHERE LOWER(`season`) IN ('summer', '暑假', '夏')");
                $pdo->exec("UPDATE `class_batches` SET `season` = '秋' WHERE LOWER(`season`) IN ('autumn', 'fall', '秋季')");
                $pdo->exec("UPDATE `class_batches` SET `season` = '寒' WHERE LOWER(`season`) IN ('winter', '寒假', '冬')");

                $dupGroups = $pdo->query("
                    SELECT `year`, `season`, `grade`, `tier`, `subject`, `class_name`, MIN(`id`) AS `keep_id`, COUNT(*) AS `cnt`
                    FROM `class_batches`
                    GROUP BY `year`, `season`, `grade`, `tier`, `subject`, `class_name`
                    HAVING `cnt` > 1
                ")->fetchAll();

                foreach ($dupGroups as $grp) {
                    $keepId = (int)$grp['keep_id'];
                    $dupStmt = $pdo->prepare("SELECT `id` FROM `class_batches` WHERE `year` = ? AND `season` = ? AND `grade` = ? AND `tier` = ? AND `subject` = ? AND `class_name` = ? AND `id` <> ?");
                    $dupStmt->execute([$grp['year'], $grp['season'], $grp['grade'], $grp['tier'], $grp['subject'], $grp['class_name'], $keepId]);
                    $dupIds = array_map('intval', array_column($dupStmt->fetchAll(), 'id'));
                    foreach ($dupIds as $dupId) {
                        // 将重复批次下的 student_records 迁移到主批次（若同周同生已存在则忽略旧重复行）
                        $pdo->exec("UPDATE IGNORE `student_records` SET `batch_id` = {$keepId} WHERE `batch_id` = {$dupId}");
                        $pdo->exec("DELETE FROM `student_records` WHERE `batch_id` = {$dupId}");
                        $pdo->exec("UPDATE `generation_batches` SET `class_id` = {$keepId} WHERE `class_id` = {$dupId}");
                        $pdo->exec("DELETE FROM `class_batches` WHERE `id` = {$dupId}");
                    }
                }

                $pdo->exec("ALTER TABLE `class_batches` ADD UNIQUE KEY `uk_batch_identity` (`year`, `season`, `grade`, `tier`, `subject`, `class_name`)");
            }

            $dataDir = dirname($lockFile);
            if (!is_dir($dataDir)) {
                @mkdir($dataDir, 0755, true);
            }
            @file_put_contents($lockFile, date('Y-m-d H:i:s'));
        } catch (Throwable $e) {
            error_log("DB::ensureSchemaUpgrades non-fatal warning: " . $e->getMessage());
        }
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

