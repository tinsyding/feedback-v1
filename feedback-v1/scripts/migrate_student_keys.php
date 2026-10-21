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

$historyDir = realpath(__DIR__ . '/../data/history');
if ($historyDir === false || !is_dir($historyDir)) {
    fail('找不到 data/history 目录');
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

// ---------- 3. 历史档案文件 ----------
$files = glob($historyDir . '/*.json') ?: [];
sort($files);
$filePlans = [];
$fileLegacyKeys = 0;
$fileCollisions = [];
foreach ($files as $file) {
    $base = basename($file, '.json');
    if ($base === 'token_map') continue;

    $parts = explode('_', $base);
    if (count($parts) < 2) {
        $filePlans[] = ['file' => basename($file), 'changed' => 0, 'skip' => '文件名无法解析'];
        continue;
    }
    $fileSubject = rawurldecode($parts[0]);
    $fileGrade = rawurldecode($parts[1]);

    $raw = @file_get_contents($file);
    $data = $raw !== false ? json_decode($raw, true) : null;
    if (!is_array($data)) {
        $filePlans[] = ['file' => basename($file), 'changed' => 0, 'skip' => 'JSON 解析失败'];
        continue;
    }

    [$newData, $changed, $collisions] = rewrite_history_keys($data, $fileGrade, $fileSubject, $knownPairs);
    $fileLegacyKeys += $changed;
    foreach ($collisions as $c) {
        $fileCollisions[] = basename($file) . ': ' . $c;
    }
    $filePlans[] = [
        'file' => basename($file),
        'changed' => $changed,
        'data' => $newData,
        'path' => $file,
        'skip' => '',
    ];
}
printLine("[历史档案] 共 " . count($filePlans) . " 个文件，待改写旧 Key: {$fileLegacyKeys}");
foreach ($filePlans as $plan) {
    if ($plan['skip'] !== '') {
        printLine("  - {$plan['file']}：跳过（{$plan['skip']}）");
    } elseif ($plan['changed'] > 0) {
        printLine("  - {$plan['file']}：{$plan['changed']} 个 Key");
    }
}

// ---------- 4. token_map.json ----------
$tokenMapPath = $historyDir . '/token_map.json';
$tokenMap = [];
if (is_file($tokenMapPath)) {
    $raw = @file_get_contents($tokenMapPath);
    $decoded = $raw !== false ? json_decode($raw, true) : null;
    if (is_array($decoded)) {
        $tokenMap = $decoded;
    } else {
        fail('token_map.json 解析失败，终止迁移');
    }
}
$tokenPlans = [];
foreach ($tokenMap as $token => $entry) {
    if (!is_array($entry)) continue;
    $entryId = trim((string)($entry['id'] ?? ''));
    $entryKey = trim((string)($entry['k'] ?? ''));
    $entryName = trim((string)($entry['n'] ?? ''));
    if ($entryId === '' || $entryKey === '' || $entryName === '') continue;
    // 注意 token_map 字段：s = 学科，g = 年级
    $entrySubject = trim((string)($entry['s'] ?? ''));
    $entryGrade = trim((string)($entry['g'] ?? ''));
    $correctKey = build_student_key($entryId, $entryName, $entryGrade, $entrySubject);
    // 兼容 2026-10-21 首轮迁移中 s/g 传反产生的错误 key
    $swappedKey = build_student_key($entryId, $entryName, $entrySubject, $entryGrade);
    $legacyKey = legacy_student_key($entryId, $entryName);
    $needsRewrite = $entryKey !== $correctKey
        && ($entryKey === $legacyKey || ($swappedKey !== $correctKey && $entryKey === $swappedKey));
    if ($needsRewrite) {
        $tokenPlans[$token] = ['old' => $entryKey, 'new' => $correctKey];
    }
}
printLine("[token_map] 共 " . count($tokenMap) . " 条，待改写: " . count($tokenPlans));

// ---------- 冲突结论 ----------
$hasBlockingCollision = !empty($recordCollisions) || !empty($fileCollisions);
if (!empty($recordCollisions)) {
    printLine();
    printLine('[冲突] 数据库存在迁移后同班同周重复 Key（必须人工处理，不能自动迁移）：');
    foreach (array_slice($recordCollisions, 0, 20) as $c) {
        printLine("  batch_id={$c['batch_id']} week={$c['week_num']} key={$c['new_key']} rows={$c['c']}");
    }
}
if (!empty($fileCollisions)) {
    printLine();
    printLine('[冲突] 历史档案文件内目标 Key 已存在（不能自动迁移）：');
    foreach (array_slice(array_unique($fileCollisions), 0, 20) as $c) {
        printLine("  {$c}");
    }
}

printLine();
if ($legacyRecordCount + $legacyHistoryCount + $fileLegacyKeys + count($tokenPlans) === 0) {
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

// ---------- 5. 备份 ----------
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
foreach ($files as $file) {
    if (!copy($file, $backupDir . '/' . basename($file))) {
        fail('备份失败: ' . basename($file));
    }
}

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

// ---------- 6. 执行 ----------
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

$rewrittenFiles = 0;
$rewrittenKeys = 0;
foreach ($filePlans as $plan) {
    if ($plan['skip'] !== '' || $plan['changed'] === 0) continue;
    $tmp = $plan['path'] . '.tmp_' . getmypid();
    $json = json_encode($plan['data'], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    if ($json === false || file_put_contents($tmp, $json) === false) {
        @unlink($tmp);
        fail('写入临时文件失败: ' . $plan['file']);
    }
    @chmod($tmp, 0644);
    if (!rename($tmp, $plan['path'])) {
        @unlink($tmp);
        fail('替换档案文件失败: ' . $plan['file']);
    }
    $rewrittenFiles++;
    $rewrittenKeys += $plan['changed'];
}
printLine("[档案] 已改写 {$rewrittenFiles} 个文件，共 {$rewrittenKeys} 个 Key");

if (!empty($tokenPlans)) {
    foreach ($tokenPlans as $token => $change) {
        $tokenMap[$token]['k'] = $change['new'];
    }
    $tmp = $tokenMapPath . '.tmp_' . getmypid();
    $json = json_encode($tokenMap, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    if ($json === false || file_put_contents($tmp, $json) === false) {
        @unlink($tmp);
        fail('写入 token_map.json 临时文件失败');
    }
    @chmod($tmp, 0644);
    if (!rename($tmp, $tokenMapPath)) {
        @unlink($tmp);
        fail('替换 token_map.json 失败');
    }
    printLine('[token_map] 已改写 ' . count($tokenPlans) . ' 条');
}

// ---------- 7. 复核 ----------
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
printLine('提示：如脚本以 root 运行，请执行 chown -R www:www ' . dirname($historyDir));
