#!/usr/bin/env php
<?php
/**
 * Feedback-V1 数据库迁移运行器 (scripts/migrate.php)
 *
 * 用法（仅限服务器 SSH 命令行，禁止经 Web 访问）：
 *   php scripts/migrate.php status    查看已应用/待应用版本（只读）
 *   php scripts/migrate.php dry-run   预览待应用 SQL（不执行）
 *   php scripts/migrate.php migrate   按顺序应用待应用版本并记录
 *
 * 约定：
 * - scripts/migrations/NNN_*.sql，文件名即版本号，按字典序执行。
 * - 每个文件可含多条语句，以分号 + 换行分隔（字符串与注释内的分号会被正确跳过）。
 * - 已应用版本记入 schema_migrations 表；重复执行安全（幂等，靠 IF NOT EXISTS / 重复键保护）。
 * - 回滚：本工具只做向前迁移。线上出问题先用数据库备份恢复，再补新迁移修复，
 *   不要手写逆向 SQL 去改生产库。
 */

if (php_sapi_name() !== 'cli') {
    http_response_code(403);
    exit('Forbidden: CLI only');
}

require_once __DIR__ . '/../api/db.php';

const MIGRATIONS_DIR = __DIR__ . '/migrations';
const TRACKING_TABLE = 'schema_migrations';

/** 按语句切分 SQL：跳过引号字符串与各类注释内的分号 */
function splitStatements(string $sql): array {
    $stmts = [];
    $buf = '';
    $len = strlen($sql);
    $quote = null; // ', ", `
    for ($i = 0; $i < $len; $i++) {
        $ch = $sql[$i];
        $next = ($i + 1 < $len) ? $sql[$i + 1] : '';
        if ($quote !== null) {
            $buf .= $ch;
            if ($ch === '\\' && $i + 1 < $len) {
                $buf .= $next;
                $i++;
            } elseif ($ch === $quote) {
                // '' 转义
                if ($next === $quote) {
                    $buf .= $next;
                    $i++;
                } else {
                    $quote = null;
                }
            }
            continue;
        }
        if ($ch === "'" || $ch === '"' || $ch === '`') {
            $quote = $ch;
            $buf .= $ch;
            continue;
        }
        // 行注释
        if (($ch === '-' && $next === '-' && ($i + 2 >= $len || $sql[$i + 2] === ' ' || $sql[$i + 2] === "\t" || $sql[$i + 2] === "\n" || $sql[$i + 2] === "\r"))
            || $ch === '#') {
            while ($i < $len && $sql[$i] !== "\n") {
                $buf .= $sql[$i];
                $i++;
            }
            $buf .= "\n";
            continue;
        }
        // 块注释
        if ($ch === '/' && $next === '*') {
            $buf .= $ch . $next;
            $i += 2;
            while ($i < $len && !($sql[$i] === '*' && ($i + 1 < $len) && $sql[$i + 1] === '/')) {
                $buf .= $sql[$i];
                $i++;
            }
            if ($i < $len) {
                $buf .= '*/';
                $i++;
            }
            continue;
        }
        if ($ch === ';') {
            $trimmed = trim($buf);
            if ($trimmed !== '') {
                $stmts[] = $trimmed;
            }
            $buf = '';
            continue;
        }
        $buf .= $ch;
    }
    $trimmed = trim($buf);
    if ($trimmed !== '') {
        $stmts[] = $trimmed;
    }
    return $stmts;
}

function listMigrations(): array {
    $files = glob(MIGRATIONS_DIR . '/*.sql') ?: [];
    sort($files, SORT_STRING);
    $out = [];
    foreach ($files as $f) {
        $out[basename($f, '.sql')] = $f;
    }
    return $out;
}

function ensureTrackingTable(): void {
    $db = DB::getConnection();
    if (!$db) {
        fwrite(STDERR, "数据库连接失败\n");
        exit(1);
    }
    $db->exec("CREATE TABLE IF NOT EXISTS `" . TRACKING_TABLE . "` (
        `version` varchar(64) NOT NULL,
        `applied_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (`version`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
}

function appliedVersions(): array {
    $rows = DB::fetchAll("SELECT `version` FROM `" . TRACKING_TABLE . "` ORDER BY `version` ASC");
    return array_column($rows, 'version');
}

function cmdStatus(): void {
    ensureTrackingTable();
    $applied = array_flip(appliedVersions());
    foreach (listMigrations() as $ver => $file) {
        echo (isset($applied[$ver]) ? '[applied] ' : '[pending] ') . $ver . "\n";
    }
}

function cmdDryRun(): void {
    ensureTrackingTable();
    $applied = array_flip(appliedVersions());
    foreach (listMigrations() as $ver => $file) {
        if (isset($applied[$ver])) {
            continue;
        }
        echo "=== $ver (" . basename($file) . ") ===\n";
        foreach (splitStatements(file_get_contents($file)) as $i => $stmt) {
            $preview = mb_substr(preg_replace('/\s+/', ' ', $stmt), 0, 160, 'UTF-8');
            echo "  [$i] $preview\n";
        }
    }
}

function cmdMigrate(): void {
    ensureTrackingTable();
    $applied = array_flip(appliedVersions());
    $db = DB::getConnection();
    $done = 0;
    foreach (listMigrations() as $ver => $file) {
        if (isset($applied[$ver])) {
            continue;
        }
        echo "applying $ver ... ";
        $stmts = splitStatements(file_get_contents($file));
        try {
            // 注意：MySQL 的 DDL 自带隐式提交，显式事务包不住混合迁移；
            // 因此逐条执行、失败即停且不记录版本，靠“迁移必须幂等”保证可重入。
            foreach ($stmts as $stmt) {
                // 跳过纯注释残留与 USE（连接已指向 feedback 库）
                $head = strtoupper(ltrim($stmt));
                if ($head === '' || str_starts_with($head, 'USE ')) {
                    continue;
                }
                try {
                    $db->exec($stmt);
                } catch (PDOException $stmtErr) {
                    // 兼容幂等重入：1060 Duplicate column name / 1061 Duplicate key name / 1091 Can't DROP column
                    $driverCode = intval($stmtErr->errorInfo[1] ?? 0);
                    if (!in_array($driverCode, [1060, 1061, 1091], true)) {
                        throw $stmtErr;
                    }
                }
            }
            $ins = $db->prepare("INSERT INTO `" . TRACKING_TABLE . "` (`version`) VALUES (?)");
            $ins->execute([$ver]);
            echo "OK (" . count($stmts) . " statements)\n";
            $done++;
        } catch (Throwable $e) {
            fwrite(STDERR, "FAILED: " . $e->getMessage() . "（版本未记录，修复后可重跑）\n");
            exit(1);
        }
    }
    echo $done === 0 ? "nothing to do, database is up to date\n" : "done, applied $done migration(s)\n";
}

$cmd = $argv[1] ?? 'status';
switch ($cmd) {
    case 'status':
        cmdStatus();
        break;
    case 'dry-run':
        cmdDryRun();
        break;
    case 'migrate':
        cmdMigrate();
        break;
    default:
        fwrite(STDERR, "用法: php scripts/migrate.php [status|dry-run|migrate]\n");
        exit(1);
}
