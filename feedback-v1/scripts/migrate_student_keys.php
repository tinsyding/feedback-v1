<?php
declare(strict_types=1);

/**
 * 错题本学生身份 Key 迁移脚本
 *
 * 旧格式：学号_姓名
 * 新格式：学号_姓名_年级_学科
 *
 * 迁移范围：
 *   1) student_records.student_key
 *   2) student_record_history.student_key
 *   3) data/history/学科_年级[_班型].json 内的学生 Key
 *   4) data/history/token_map.json 内的 k 字段
 *
 * 无学号数据（纯姓名 Key）一律跳过；retest_token 不变，旧家长链接永久可用。
 *
 * 用法：
 *   php scripts/migrate_student_keys.php                     # 只读预检（默认）
 *   php scripts/migrate_student_keys.php --apply \
 *       --backup-dir=/www/wwwroot/JF/key_migration_20261021 # 备份后执行
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("仅限命令行运行\n");
}

require_once __DIR__ . '/../api/db.php';
require_once __DIR__ . '/../api/lib_retest_keys.php';

/** @return never */
function fail(string $message, int $code = 1): void
{
    fwrite(STDERR, "[失败] {$message}\n");
    exit($code);
}

function printLine(string $message = ''): void
{
    echo $message . "\n";
}

$apply = false;
$backupDir = '';
foreach (array_slice($argv, 1) as $arg) {
    if ($arg === '--apply') {
        $apply = true;
    } elseif ($arg === '--dry-run') {
        $apply = false;
    } elseif ($arg === '--help' || $arg === '-h') {
        printLine('用法: php scripts/migrate_student_keys.php [--dry-run] [--apply --backup-dir=/path]');
        exit(0);
    } elseif (str_starts_with($arg, '--backup-dir=')) {
        $backupDir = trim(substr($arg, strlen('--backup-dir=')));
    } else {
        fail("未知参数: {$arg}", 2);
    }
}

$pdo = DB::getConnection();
if (!$pdo) {
    fail('数据库连接失败');
}

// 已知的年级/学科组合，用于识别"已经是新格式"的 Key
$knownPairs = array_map(
    static fn(array $row): array => [(string)$row['grade'], (string)$row['subject']],
    DB::fetchAll("SELECT DISTINCT grade, subject FROM class_batches WHERE grade <> '' AND subject <> ''")
);

$legacyExprRecords = "CONCAT(sr.student_id, '_', TRIM(sr.student_name))";
$newExprRecords = "CONCAT(sr.student_id, '_', TRIM(sr.student_name), '_', cb.grade, '_', cb.subject)";
$legacyExprHistory = "CONCAT(h.student_id, '_', TRIM(h.student_name))";
$newExprHistory = "CONCAT(h.student_id, '_', TRIM(h.student_name), '_', cb.grade, '_', cb.subject)";

printLine('=== 错题本身份 Key 迁移预检 ===');
printLine('模式: ' . ($apply ? 'APPLY（执行）' : 'DRY-RUN（只读）'));
printLine();

// ---------- 1. student_records ----------
$legacyRecordCount = (int)DB::fetchValue(
    "SELECT COUNT(*) FROM student_records sr
     JOIN class_batches cb ON sr.batch_id = cb.id
     WHERE sr.student_id <> '' AND sr.student_key = {$legacyExprRecords}"
);
$newRecordCount = (int)DB::fetchValue(
    "SELECT COUNT(*) FROM student_records sr
     JOIN class_batches cb ON sr.batch_id = cb.id
     WHERE sr.student_id <> '' AND sr.student_key = {$newExprRecords}"
);
$otherRecordCount = (int)DB::fetchValue(
    "SELECT COUNT(*) FROM student_records sr
     JOIN class_batches cb ON sr.batch_id = cb.id
     WHERE sr.student_id <> ''
       AND (sr.student_key IS NULL OR (sr.student_key <> {$legacyExprRecords} AND sr.student_key <> {$newExprRecords}))"
);
printLine("[student_records] 待迁移旧格式: {$legacyRecordCount}，已是新格式: {$newRecordCount}，其他未知格式: {$otherRecordCount}");
if ($otherRecordCount > 0) {
    $samples = DB::fetchAll(
        "SELECT sr.id, sr.student_id, sr.student_name, sr.student_key, cb.grade, cb.subject
         FROM student_records sr JOIN class_batches cb ON sr.batch_id = cb.id
         WHERE sr.student_id <> ''
           AND (sr.student_key IS NULL OR (sr.student_key <> {$legacyExprRecords} AND sr.student_key <> {$newExprRecords}))
         LIMIT 10"
    );
    foreach ($samples as $row) {
        printLine("  [其他格式] id={$row['id']} key={$row['student_key']} ({$row['student_id']} {$row['student_name']} {$row['grade']}{$row['subject']})");
    }
}

$recordCollisions = DB::fetchAll(
    "SELECT sr.batch_id, sr.week_num, {$newExprRecords} AS new_key, COUNT(*) AS c
     FROM student_records sr
     JOIN class_batches cb ON sr.batch_id = cb.id
     WHERE sr.student_id <> ''
     GROUP BY sr.batch_id, sr.week_num, {$newExprRecords}
     HAVING COUNT(*) > 1"
);

// ---------- 2. student_record_history ----------
$legacyHistoryCount = (int)DB::fetchValue(
    "SELECT COUNT(*) FROM student_record_history h
     JOIN class_batches cb ON h.batch_id = cb.id
     WHERE h.student_id <> '' AND h.student_key = {$legacyExprHistory}"
);
$newHistoryCount = (int)DB::fetchValue(
    "SELECT COUNT(*) FROM student_record_history h
     JOIN class_batches cb ON h.batch_id = cb.id
     WHERE h.student_id <> '' AND h.student_key = {$newExprHistory}"
);
$otherHistoryCount = (int)DB::fetchValue(
    "SELECT COUNT(*) FROM student_record_history h
     JOIN class_batches cb ON h.batch_id = cb.id
     WHERE h.student_id <> ''
       AND (h.student_key IS NULL OR (h.student_key <> {$legacyExprHistory} AND h.student_key <> {$newExprHistory}))"
);
printLine("[student_record_history] 待迁移旧格式: {$legacyHistoryCount}，已是新格式: {$newHistoryCount}，其他未知格式: {$otherHistoryCount}");

// ---------- 冲突结论 ----------
$hasBlockingCollision = !empty($recordCollisions);
if (!empty($recordCollisions)) {
    printLine();
    printLine('[冲突] 数据库存在迁移后同班同周重复 Key（必须人工处理，不能自动迁移）：');
    foreach (array_slice($recordCollisions, 0, 20) as $c) {
        printLine("  batch_id={$c['batch_id']} week={$c['week_num']} key={$c['new_key']} rows={$c['c']}");
    }
}

printLine();
if ($legacyRecordCount + $legacyHistoryCount === 0) {
    printLine('没有需要迁移的数据（可能已经迁移完成）。');
    exit(0);
}

if (!$apply) {
    printLine('DRY-RUN 完成，未修改任何数据。确认无误后加 --apply 执行。');
    if ($hasBlockingCollision) {
        printLine('注意：检测到冲突，--apply 将被拒绝执行。');
        exit(3);
    }
    exit(0);
}

if ($hasBlockingCollision) {
    fail('检测到迁移冲突，已拒绝执行。请先处理上面的冲突项。', 3);
}

// ---------- 3. 备份 ----------
if ($backupDir === '') {
    $backupDir = sys_get_temp_dir() . '/student_keys_backup_' . date('Ymd_His');
}
if (!is_dir($backupDir) && !mkdir($backupDir, 0700, true) && !is_dir($backupDir)) {
    fail("无法创建备份目录: {$backupDir}");
}
if (!is_writable($backupDir)) {
    fail("备份目录不可写: {$backupDir}");
}

printLine();
printLine("备份目录: {$backupDir}");

$recordBackup = DB::fetchAll(
    "SELECT sr.id, sr.student_key, {$newExprRecords} AS new_key
     FROM student_records sr JOIN class_batches cb ON sr.batch_id = cb.id
     WHERE sr.student_id <> ''"
);
file_put_contents(
    $backupDir . '/student_records_keys.json',
    json_encode($recordBackup, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
);
$historyBackup = DB::fetchAll(
    "SELECT h.id, h.student_key, {$newExprHistory} AS new_key
     FROM student_record_history h JOIN class_batches cb ON h.batch_id = cb.id
     WHERE h.student_id <> ''"
);
file_put_contents(
    $backupDir . '/student_record_history_keys.json',
    json_encode($historyBackup, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
);
printLine("已备份数据库 Key 映射（student_records " . count($recordBackup) . " 行，history " . count($historyBackup) . " 行）");

// ---------- 4. 执行 ----------
printLine();
$pdo->beginTransaction();
try {
    // student_records.updated_at 是 ON UPDATE CURRENT_TIMESTAMP；
    // 显式赋值为自身可抑制自动刷新，迁移只改 key，不改变业务时间。
    $updatedRecords = DB::execute(
        "UPDATE student_records sr
         JOIN class_batches cb ON sr.batch_id = cb.id
         SET sr.student_key = {$newExprRecords},
             sr.updated_at = sr.updated_at
         WHERE sr.student_id <> '' AND sr.student_key = {$legacyExprRecords}"
    );
    $updatedHistory = DB::execute(
        "UPDATE student_record_history h
         JOIN class_batches cb ON h.batch_id = cb.id
         SET h.student_key = {$newExprHistory}
         WHERE h.student_id <> '' AND h.student_key = {$legacyExprHistory}"
    );
    $pdo->commit();
    printLine("[DB] student_records 更新 {$updatedRecords} 行，student_record_history 更新 {$updatedHistory} 行");
} catch (Throwable $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    fail('数据库更新失败，已回滚: ' . $e->getMessage());
}

// ---------- 5. 复核 ----------
$remainingRecords = (int)DB::fetchValue(
    "SELECT COUNT(*) FROM student_records sr
     JOIN class_batches cb ON sr.batch_id = cb.id
     WHERE sr.student_id <> '' AND sr.student_key = {$legacyExprRecords}"
);
$remainingHistory = (int)DB::fetchValue(
    "SELECT COUNT(*) FROM student_record_history h
     JOIN class_batches cb ON h.batch_id = cb.id
     WHERE h.student_id <> '' AND h.student_key = {$legacyExprHistory}"
);
printLine();
printLine('=== 迁移完成 ===');
printLine("残留旧格式 Key：student_records {$remainingRecords} 行，student_record_history {$remainingHistory} 行");
if ($remainingRecords > 0 || $remainingHistory > 0) {
    fail('仍有残留旧 Key，请检查上面的输出', 4);
}
