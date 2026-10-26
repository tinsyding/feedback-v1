<?php
/**
 * Admin 模块公共辅助函数与认证常量
 */

// Fallback admin credentials (used only if database table is empty or offline)
$localAdminFile = __DIR__ . '/helpers.local.php';
$localAdmin = file_exists($localAdminFile) ? require $localAdminFile : [];

if (!defined('ADMIN_USERNAME')) {
    define('ADMIN_USERNAME', getenv('ADMIN_FALLBACK_USER') ?: ($localAdmin['admin_username'] ?? ($localAdmin['username'] ?? 'admin')));
}
if (!defined('ADMIN_PASSWORD_HASH')) {
    define('ADMIN_PASSWORD_HASH', getenv('ADMIN_FALLBACK_HASH') ?: ($localAdmin['admin_password_hash'] ?? ($localAdmin['password_hash'] ?? '')));
}
if (!defined('ADMIN_PASSWORD_HASHES')) {
    define('ADMIN_PASSWORD_HASHES', $localAdmin['admin_password_hashes'] ?? ($localAdmin['password_hashes'] ?? (ADMIN_PASSWORD_HASH !== '' ? [ADMIN_PASSWORD_HASH] : [])));
}

// Config file path
$configFile = dirname(__DIR__, 2) . '/config.json';



/**
 * 获取数据库所有有效表
 */
function getValidTables(): array {
    $rows = DB::fetchAll("SHOW TABLES");
    $tables = [];
    foreach ($rows as $r) {
        $tables[] = reset($r);
    }
    return $tables;
}

/**
 * 校验并确保表名安全合法
 */
function validateTable(?string $table): string {
    if (empty($table) || !preg_match('/^[a-zA-Z0-9_]+$/', $table)) {
        sendResponse(false, null, '无效的数据表名称', 400);
    }
    $tables = getValidTables();
    if (!in_array($table, $tables, true)) {
        sendResponse(false, null, "数据表 '{$table}' 不存在", 404);
    }
    return $table;
}

/**
 * 获取指定表字段结构元数据
 */
function getTableColumns(string $table): array {
    $rows = DB::fetchAll("SHOW FULL COLUMNS FROM `{$table}`");
    $cols = [];
    foreach ($rows as $r) {
        $cols[$r['Field']] = [
            'field'   => $r['Field'],
            'name'    => $r['Field'],
            'type'    => $r['Type'],
            'null'    => $r['Null'] === 'YES',
            'key'     => $r['Key'],
            'default' => $r['Default'],
            'extra'   => $r['Extra'],
            'comment' => $r['Comment'] ?? ''
        ];
    }
    return $cols;
}

/**
 * 获取表主键字段名
 */
function getTablePrimaryKey(string $table): string {
    $cols = getTableColumns($table);
    foreach ($cols as $name => $c) {
        if ($c['key'] === 'PRI') {
            return $name;
        }
    }
    return 'id';
}

/**
 * 同步指定题库专题期次的 JSON 灾备镜像文件
 * @param int $qbankId 题库专题期次 ID (qbank_weeks.id)
 * @param array|null $oldWeekRec 修改前的期次记录（用于清理已失效的原文件名）
 */
function syncQbankJsonBackup(int $qbankId, ?array $oldWeekRec = null): void {
    try {
        if ($qbankId <= 0) return;
        $qbankDataDir = dirname(__DIR__, 2) . '/data/qbank';
        if (!is_dir($qbankDataDir)) {
            @mkdir($qbankDataDir, 0755, true);
        }

        $weekRec = DB::fetchOne("SELECT `year`, `season`, `subject`, `grade`, `tier`, `week` FROM `qbank_weeks` WHERE `id` = ?", [$qbankId]);
        if (!$weekRec) return;

        // 若修改前记录存在，且文件名发生改变，安全删除旧文件
        if ($oldWeekRec) {
            $oldF1 = $qbankDataDir . '/' . rawurlencode($oldWeekRec['year']) . '_' . rawurlencode($oldWeekRec['season']) . '_' . rawurlencode($oldWeekRec['subject']) . '_' . rawurlencode($oldWeekRec['grade']) . '_' . rawurlencode($oldWeekRec['tier']) . '_week' . intval($oldWeekRec['week']) . '.json';
            $oldF2 = $qbankDataDir . '/' . rawurlencode($oldWeekRec['subject']) . '_' . rawurlencode($oldWeekRec['grade']) . '_' . rawurlencode($oldWeekRec['tier']) . '_week' . intval($oldWeekRec['week']) . '.json';
            $newF1 = $qbankDataDir . '/' . rawurlencode($weekRec['year']) . '_' . rawurlencode($weekRec['season']) . '_' . rawurlencode($weekRec['subject']) . '_' . rawurlencode($weekRec['grade']) . '_' . rawurlencode($weekRec['tier']) . '_week' . intval($weekRec['week']) . '.json';
            if ($oldF1 !== $newF1 && file_exists($oldF1)) @unlink($oldF1);
            if (file_exists($oldF2)) @unlink($oldF2);
        }

        // 获取明细题目
        $qRows = DB::fetchAll("SELECT * FROM `qbank_questions` WHERE `qbank_id` = ? ORDER BY `question_num` ASC", [$qbankId]);
        $questions = [];
        foreach ($qRows as $qr) {
            $questions[] = [
                'id' => intval($qr['question_num']),
                'topic' => $qr['topic'] ?? '',
                'videoUrl' => $qr['video_url'] ?? '',
                'exercisePdf' => [
                    'url' => $qr['exercise_pdf'] ?? '',
                    'name' => $qr['exercise_name'] ?? '',
                    'status' => !empty($qr['exercise_pdf']) ? 'uploaded' : 'empty',
                    'thumb' => $qr['exercise_thumb'] ?? ''
                ],
                'answerPdf' => [
                    'url' => $qr['answer_pdf'] ?? '',
                    'name' => $qr['answer_name'] ?? '',
                    'status' => !empty($qr['answer_pdf']) ? 'uploaded' : 'empty',
                    'thumb' => $qr['answer_thumb'] ?? ''
                ]
            ];
        }

        $jsonData = [
            'year' => intval($weekRec['year']),
            'season' => $weekRec['season'],
            'subject' => $weekRec['subject'],
            'grade' => $weekRec['grade'],
            'tier' => $weekRec['tier'],
            'week' => intval($weekRec['week']),
            'questions' => $questions,
            'updatedAt' => round(microtime(true) * 1000)
        ];
        $targetF = $qbankDataDir . '/' . rawurlencode($weekRec['year']) . '_' . rawurlencode($weekRec['season']) . '_' . rawurlencode($weekRec['subject']) . '_' . rawurlencode($weekRec['grade']) . '_' . rawurlencode($weekRec['tier']) . '_week' . intval($weekRec['week']) . '.json';
        @file_put_contents($targetF, json_encode($jsonData, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
    } catch (Throwable $e) {
        error_log("syncQbankJsonBackup error: " . $e->getMessage());
    }
}

/**
 * 删除指定题库专题期次的 JSON 灾备镜像文件
 * @param array|null $weekRec 期次记录
 */
function deleteQbankJsonBackup(?array $weekRec): void {
    try {
        if (!$weekRec) return;
        $qbankDataDir = dirname(__DIR__, 2) . '/data/qbank';
        if (!is_dir($qbankDataDir)) return;
        $f1 = $qbankDataDir . '/' . rawurlencode($weekRec['year']) . '_' . rawurlencode($weekRec['season']) . '_' . rawurlencode($weekRec['subject']) . '_' . rawurlencode($weekRec['grade']) . '_' . rawurlencode($weekRec['tier']) . '_week' . intval($weekRec['week']) . '.json';
        $f2 = $qbankDataDir . '/' . rawurlencode($weekRec['subject']) . '_' . rawurlencode($weekRec['grade']) . '_' . rawurlencode($weekRec['tier']) . '_week' . intval($weekRec['week']) . '.json';
        if (file_exists($f1)) @unlink($f1);
        if (file_exists($f2)) @unlink($f2);
    } catch (Throwable $e) {
        error_log("deleteQbankJsonBackup error: " . $e->getMessage());
    }
}


