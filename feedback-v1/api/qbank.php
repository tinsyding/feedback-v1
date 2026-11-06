<?php
/**
 * 题库知识点管理 API (MySQL 优先 + JSON 灾备)
 *
 * GET    ?action=list[&year=2026][&season=春][&subject=数学][&grade=七年级][&search=关键词] -> 获取题目列表
 * GET    ?action=get&subject=数学&grade=七年级&tier=S+&week=3[&year=2026][&season=春]       -> 获取指定题目数据
 * POST   JSON body {year, season, subject, grade, tier, week, questions}                    -> 保存/更新题目数据
 * DELETE ?subject=数学&grade=七年级&tier=S+&week=3[&year=2026][&season=春]                  -> 删除指定题目数据
 */

require_once __DIR__ . '/bootstrap.php';

// 引入数据库核心模块
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/logs.php';

// Data directory for JSON backup
$dataDir = __DIR__ . '/../data/qbank';
if (!is_dir($dataDir)) {
    mkdir($dataDir, 0755, true);
}

// 读取系统配置中的默认年份和学期（_comment 为合法 JSON 字段，直接解码后忽略）
$configFile = __DIR__ . '/../config.json';
$config = [];
if (file_exists($configFile)) {
    $rawConfig = file_get_contents($configFile);
    $config = json_decode($rawConfig, true) ?: [];
}

$defaultSemesterYear = intval($config['semesterYear'] ?? 2026);
$defaultSeasonCode = strval($config['defaultSeason'] ?? 'autumn');

/**
 * 规范化学期字符串为中文枚举 (春/暑/秋/寒)
 */
function normalizeSeason($season, $fallback = '秋') {
    if (empty($season)) return $fallback;
    $map = [
        'spring' => '春',
        'summer' => '暑',
        'autumn' => '秋',
        'winter' => '寒',
        '春季'   => '春',
        '暑假'   => '暑',
        '秋季'   => '秋',
        '寒假'   => '寒',
        '春'     => '春',
        '暑'     => '暑',
        '秋'     => '秋',
        '寒'     => '寒',
    ];
    $lower = strtolower(trim($season));
    return $map[$lower] ?? $map[$season] ?? $fallback;
}

$defaultSeasonZh = normalizeSeason($defaultSeasonCode, '春');

/**
 * 自动检测并补齐 qbank_questions 表结构 (004_shared_topic_variation: parent_question_nums)
 * 若此前因缺少字段导致 MySQL 事务回滚而仅写入了 JSON 灾备文件，自动将近期 JSON 灾备恢复回数据库。
 */
function ensureQbankSchema($dataDir, $defaultYear, $defaultSeason) {
    $flagFile = $dataDir . '/.schema_v4_migrated';
    if (file_exists($flagFile)) {
        return;
    }
    try {
        $db = DB::getConnection();
        if (!$db) {
            return;
        }
        $col = DB::fetchOne("SHOW COLUMNS FROM `qbank_questions` LIKE 'parent_question_nums'");
        if (!$col) {
            $db->exec("ALTER TABLE `qbank_questions` ADD COLUMN `parent_question_nums` VARCHAR(128) NULL DEFAULT NULL COMMENT '举一反三关联的多个原题号（逗号分隔，如 2,5）' AFTER `parent_question_num`");
        }
        try {
            $db->exec("INSERT IGNORE INTO `schema_migrations` (`version`) VALUES ('004_shared_topic_variation')");
        } catch (Throwable $ignore) {}

        // 扫描最近 48 小时内写入的 JSON 灾备文件，恢复因字段缺失回滚而未入库的专题数据
        $files = glob($dataDir . '/*.json') ?: [];
        $cutoff = time() - 172800;
        foreach ($files as $file) {
            if (@filemtime($file) < $cutoff) {
                continue;
            }
            $content = @json_decode(@file_get_contents($file), true);
            if (!is_array($content) || empty($content['questions']) || !is_array($content['questions'])) {
                continue;
            }
            $meta = parseFileName(basename($file), $defaultYear, $defaultSeason);
            $bType = normalizeBankType($content['bankType'] ?? ($meta['bankType'] ?? 'homework'));
            $yr = intval($content['year'] ?? ($meta['year'] ?? $defaultYear));
            $sn = normalizeSeason($content['season'] ?? ($meta['season'] ?? $defaultSeason), $defaultSeason);
            $sub = trim($content['subject'] ?? ($meta['subject'] ?? ''));
            $grd = trim($content['grade'] ?? ($meta['grade'] ?? ''));
            $tr = trim($content['tier'] ?? ($meta['tier'] ?? ''));
            $wk = intval($content['week'] ?? ($meta['week'] ?? 0));
            if (!$sub || !$grd || !$tr || $wk <= 0) {
                continue;
            }
            $existingWeek = DB::fetchOne(
                "SELECT `id`, ROUND(UNIX_TIMESTAMP(`updated_at`)*1000) AS `updatedAt` FROM `qbank_weeks`
                 WHERE `year` = ? AND `season` = ? AND `subject` = ? AND `grade` = ? AND `tier` = ? AND `week` = ? AND `bank_type` = ? LIMIT 1",
                [$yr, $sn, $sub, $grd, $tr, $wk, $bType]
            );
            $jsonUpdatedAt = floatval($content['updatedAt'] ?? (@filemtime($file) * 1000));
            $needRecover = !$existingWeek || ($jsonUpdatedAt > floatval($existingWeek['updatedAt']) + 2000);
            if (!$needRecover && $existingWeek) {
                $qCnt = intval(DB::fetchValue("SELECT COUNT(*) FROM `qbank_questions` WHERE `qbank_id` = ?", [$existingWeek['id']]));
                if ($qCnt === 0 && count($content['questions']) > 0) {
                    $needRecover = true;
                }
            }
            if ($needRecover) {
                $db->beginTransaction();
                try {
                    $stmtW = $db->prepare("
                        INSERT INTO `qbank_weeks` (`bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week`, `question_count`, `created_by`, `updated_by`, `updated_at`)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', CURRENT_TIMESTAMP)
                        ON DUPLICATE KEY UPDATE
                            `question_count` = VALUES(`question_count`),
                            `updated_at` = CURRENT_TIMESTAMP
                    ");
                    $stmtW->execute([$bType, $yr, $sn, $sub, $grd, $tr, $wk, count($content['questions'])]);
                    $qbId = DB::fetchValue(
                        "SELECT `id` FROM `qbank_weeks` WHERE `year` = ? AND `season` = ? AND `subject` = ? AND `grade` = ? AND `tier` = ? AND `week` = ? AND `bank_type` = ? LIMIT 1",
                        [$yr, $sn, $sub, $grd, $tr, $wk, $bType]
                    );
                    if ($qbId) {
                        $stmtQ = $db->prepare("
                            INSERT INTO `qbank_questions`
                                (`qbank_id`, `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week`, `question_num`, `parent_question_num`, `parent_question_nums`, `sub_num`, `topic`, `video_url`,
                                 `exercise_pdf`, `exercise_name`, `exercise_thumb`,
                                 `answer_pdf`, `answer_name`, `answer_thumb`, `created_by`, `updated_by`, `updated_at`)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', CURRENT_TIMESTAMP)
                            ON DUPLICATE KEY UPDATE
                                `parent_question_num` = VALUES(`parent_question_num`),
                                `parent_question_nums` = VALUES(`parent_question_nums`),
                                `sub_num` = VALUES(`sub_num`),
                                `topic` = VALUES(`topic`),
                                `video_url` = VALUES(`video_url`),
                                `exercise_pdf` = VALUES(`exercise_pdf`),
                                `exercise_name` = VALUES(`exercise_name`),
                                `exercise_thumb` = VALUES(`exercise_thumb`),
                                `answer_pdf` = VALUES(`answer_pdf`),
                                `answer_name` = VALUES(`answer_name`),
                                `answer_thumb` = VALUES(`answer_thumb`),
                                `updated_at` = CURRENT_TIMESTAMP
                        ");
                        foreach ($content['questions'] as $q) {
                            $qNum = intval($q['id'] ?? ($q['question_num'] ?? ($q['num'] ?? 0)));
                            if ($qNum <= 0) continue;
                            $rawPNums = $q['parentQuestionNums'] ?? ($q['parent_question_nums'] ?? null);
                            $pArr = [];
                            if (is_array($rawPNums)) {
                                $pArr = array_values(array_unique(array_filter(array_map('intval', $rawPNums))));
                                sort($pArr);
                            } elseif (is_string($rawPNums) && trim($rawPNums) !== '') {
                                $pArr = array_values(array_unique(array_filter(array_map('intval', explode(',', $rawPNums)))));
                                sort($pArr);
                            }
                            $pQNum = isset($q['parentQuestionNum']) && $q['parentQuestionNum'] !== null && $q['parentQuestionNum'] !== ''
                                ? intval($q['parentQuestionNum'])
                                : null;
                            if (empty($pArr) && $pQNum !== null && $pQNum > 0) {
                                $pArr = [$pQNum];
                            }
                            if ($pQNum === null && !empty($pArr)) {
                                $pQNum = $pArr[0];
                            }
                            $pNumsStr = !empty($pArr) ? implode(',', $pArr) : null;
                            $sNum = intval($q['subNum'] ?? ($q['sub_num'] ?? 1));
                            $tpc = trim($q['topic'] ?? '');
                            $vUrl = trim($q['videoUrl'] ?? ($q['video_url'] ?? ''));
                            $exU = $q['exercisePdf']['url'] ?? '';
                            $exN = $q['exercisePdf']['name'] ?? '';
                            $exT = $q['exercisePdf']['thumb'] ?? '';
                            $anU = $q['answerPdf']['url'] ?? '';
                            $anN = $q['answerPdf']['name'] ?? '';
                            $anT = $q['answerPdf']['thumb'] ?? '';
                            $stmtQ->execute([
                                $qbId, $bType, $yr, $sn, $sub, $grd, $tr, $wk,
                                $qNum, $pQNum, $pNumsStr, $sNum, $tpc, $vUrl, $exU, $exN, $exT, $anU, $anN, $anT
                            ]);
                        }
                    }
                    $db->commit();
                } catch (Throwable $recErr) {
                    if ($db->inTransaction()) {
                        $db->rollBack();
                    }
                    error_log("Recover qbank JSON error: " . $recErr->getMessage());
                }
            }
        }

        $colVerify = DB::fetchOne("SHOW COLUMNS FROM `qbank_questions` LIKE 'parent_question_nums'");
        if ($colVerify) {
            @file_put_contents($flagFile, date('Y-m-d H:i:s'));
        }
    } catch (Throwable $e) {
        error_log("ensureQbankSchema error: " . $e->getMessage());
    }
}

/**
 * 规范题库类型：homework=课后巩固（旧数据默认），preview=预习，variation=课后举一反三
 */
function normalizeBankType($bankType) {
    if ($bankType === 'preview') return 'preview';
    if ($bankType === 'variation') return 'variation';
    return 'homework';
}

/**
 * 获取备份 JSON 文件路径 (兼容带年份/学期与老版不带年份/学期格式)
 * 课后巩固沿用旧文件名，预习使用带 _preview，举一反三使用带 _variation 的新文件名。
 */
function getFilePath($dataDir, $subject, $grade, $tier, $week, $year = null, $season = null, $bankType = 'homework') {
    $bankType = normalizeBankType($bankType);
    $typeSegment = $bankType === 'preview' ? '_preview' : ($bankType === 'variation' ? '_variation' : '');
    if ($year !== null && $season !== null) {
        $yearSeasonName = rawurlencode($year) . '_' . rawurlencode($season) . '_' . rawurlencode($subject) . '_' . rawurlencode($grade) . '_' . rawurlencode($tier) . $typeSegment . '_week' . intval($week);
        $fullPath = $dataDir . '/' . $yearSeasonName . '.json';
        if (file_exists($fullPath)) {
            return $fullPath;
        }
    }
    // 兼容原版无年份学期文件名
    $legacyName = rawurlencode($subject) . '_' . rawurlencode($grade) . '_' . rawurlencode($tier) . $typeSegment . '_week' . intval($week);
    $legacyPath = $dataDir . '/' . $legacyName . '.json';
    if (file_exists($legacyPath)) {
        return $legacyPath;
    }
    // 默认写入路径（若指定了年份学期则采用新命名，否则老命名）
    if ($year !== null && $season !== null) {
        $yearSeasonName = rawurlencode($year) . '_' . rawurlencode($season) . '_' . rawurlencode($subject) . '_' . rawurlencode($grade) . '_' . rawurlencode($tier) . $typeSegment . '_week' . intval($week);
        return $dataDir . '/' . $yearSeasonName . '.json';
    }
    return $legacyPath;
}

/**
 * 解析文件名以备回退
 */
function parseFileName($filename, $defaultYear, $defaultSeason) {
    $name = pathinfo($filename, PATHINFO_FILENAME);
    // 新版格式: {year}_{season}_{subject}_{grade}_{tier}_(preview|homework|variation)_week{N}.json
    if (preg_match('/^(\d+)_(.+)_(.+)_(.+)_(.+?)_(preview|homework|variation)_week(\d+)$/', $name, $matches)) {
        return [
            'year' => intval($matches[1]),
            'season' => normalizeSeason(rawurldecode($matches[2])),
            'subject' => rawurldecode($matches[3]),
            'grade' => rawurldecode($matches[4]),
            'tier' => rawurldecode($matches[5]),
            'bankType' => normalizeBankType($matches[6]),
            'week' => intval($matches[7])
        ];
    }
    // 新版格式（课后巩固，旧文件名没有类型段）: {year}_{season}_{subject}_{grade}_{tier}_week{N}.json
    if (preg_match('/^(\d+)_(.+)_(.+)_(.+)_(.+)_week(\d+)$/', $name, $matches)) {
        return [
            'year' => intval($matches[1]),
            'season' => normalizeSeason(rawurldecode($matches[2])),
            'subject' => rawurldecode($matches[3]),
            'grade' => rawurldecode($matches[4]),
            'tier' => rawurldecode($matches[5]),
            'bankType' => 'homework',
            'week' => intval($matches[6])
        ];
    }
    // 原版格式: {subject}_{grade}_{tier}_week{N}.json
    if (preg_match('/^(.+)_(.+)_(.+)_week(\d+)$/', $name, $matches)) {
        return [
            'year' => $defaultYear,
            'season' => $defaultSeason,
            'subject' => rawurldecode($matches[1]),
            'grade' => rawurldecode($matches[2]),
            'tier' => rawurldecode($matches[3]),
            'bankType' => 'homework',
            'week' => intval($matches[4])
        ];
    }
    // 早期遗留格式: {subject}_{tier}_week{N}.json
    if (preg_match('/^(.+)_(.+)_week(\d+)$/', $name, $matches)) {
        return [
            'year' => $defaultYear,
            'season' => $defaultSeason,
            'subject' => rawurldecode($matches[1]),
            'grade' => '未指定年级',
            'tier' => rawurldecode($matches[2]),
            'bankType' => 'homework',
            'week' => intval($matches[3])
        ];
    }
    return null;
}

// ========== 路由请求 ==========
$method = $_SERVER['REQUEST_METHOD'];

ensureQbankSchema($dataDir, $defaultSemesterYear, $defaultSeasonZh);

try {
    switch ($method) {
        case 'GET':
            requireAuth();
            $action = $_GET['action'] ?? 'list';

            if ($action === 'list') {
                $yearFilter = !empty($_GET['year']) && $_GET['year'] !== 'all' ? intval($_GET['year']) : null;
                $seasonFilter = !empty($_GET['season']) && $_GET['season'] !== 'all' ? normalizeSeason($_GET['season']) : null;
                $subjectFilter = !empty($_GET['subject']) && $_GET['subject'] !== 'all' ? trim($_GET['subject']) : null;
                $gradeFilter = !empty($_GET['grade']) && $_GET['grade'] !== 'all' ? trim($_GET['grade']) : null;
                $bankTypeFilter = !empty($_GET['bankType']) && $_GET['bankType'] !== 'all' ? normalizeBankType($_GET['bankType']) : null;
                $searchFilter = !empty($_GET['search']) ? trim($_GET['search']) : null;

                $dbItems = [];
                $dbSuccess = false;

                try {
                    $where = [];
                    $params = [];
                    if ($yearFilter !== null) {
                        $where[] = "`year` = ?";
                        $params[] = $yearFilter;
                    }
                    if ($seasonFilter !== null) {
                        $where[] = "`season` = ?";
                        $params[] = $seasonFilter;
                    }
                    if ($subjectFilter !== null) {
                        $where[] = "`subject` = ?";
                        $params[] = $subjectFilter;
                    }
                    if ($gradeFilter !== null) {
                        $where[] = "`grade` = ?";
                        $params[] = $gradeFilter;
                    }
                    if ($bankTypeFilter !== null) {
                        $where[] = "`bank_type` = ?";
                        $params[] = $bankTypeFilter;
                    }
                    if ($searchFilter !== null) {
                        $where[] = "(`subject` LIKE ? OR `grade` LIKE ? OR `tier` LIKE ?)";
                        $kw = '%' . $searchFilter . '%';
                        $params[] = $kw;
                        $params[] = $kw;
                        $params[] = $kw;
                    }

                    $whereClause = !empty($where) ? 'WHERE ' . implode(' AND ', $where) : '';
                    $sql = "SELECT `id`, `bank_type` AS `bankType`, `year`, `season`, `subject`, `grade`, `tier`, `week`,
                                   `question_count` AS `questionCount`,
                                   ROUND(UNIX_TIMESTAMP(`updated_at`)*1000) AS `updatedAt`
                            FROM `qbank_weeks` {$whereClause}
                            ORDER BY `year` DESC, `season` ASC, `updated_at` DESC";
                    $dbItems = DB::fetchAll($sql, $params);
                    $dbSuccess = (DB::getLastError() === null);
                } catch (Throwable $e) {
                    error_log("DB qbank list query error: " . $e->getMessage());
                    $dbSuccess = false;
                }

                if ($dbSuccess) {
                    echo json_encode(['success' => true, 'data' => $dbItems], JSON_UNESCAPED_UNICODE);
                    exit;
                }

                // 数据库异常时的备用逻辑: 读取本地 JSON 文件
                $files = glob($dataDir . '/*.json');
                $items = [];
                if ($files) {
                    foreach ($files as $file) {
                        $meta = parseFileName(basename($file), $defaultSemesterYear, $defaultSeasonZh);
                        if ($meta) {
                            if ($yearFilter !== null && $meta['year'] !== $yearFilter) continue;
                            if ($seasonFilter !== null && $meta['season'] !== $seasonFilter) continue;
                            if ($subjectFilter !== null && $meta['subject'] !== $subjectFilter) continue;
                            if ($gradeFilter !== null && $meta['grade'] !== $gradeFilter) continue;
                            if ($bankTypeFilter !== null && ($meta['bankType'] ?? 'homework') !== $bankTypeFilter) continue;

                            $content = json_decode(file_get_contents($file), true);
                            $items[] = [
                                'year' => $meta['year'],
                                'season' => $meta['season'],
                                'subject' => $meta['subject'],
                                'grade' => $meta['grade'] ?? '未指定年级',
                                'tier' => $meta['tier'],
                                'bankType' => $meta['bankType'] ?? 'homework',
                                'week' => $meta['week'],
                                'questionCount' => count($content['questions'] ?? []),
                                'updatedAt' => $content['updatedAt'] ?? filemtime($file) * 1000
                            ];
                        }
                    }
                }
                usort($items, function($a, $b) {
                    return ($b['updatedAt'] ?? 0) - ($a['updatedAt'] ?? 0);
                });
                echo json_encode(['success' => true, 'data' => $items, 'fallback' => true], JSON_UNESCAPED_UNICODE);

            } elseif ($action === 'get') {
                $subject = trim($_GET['subject'] ?? '');
                $grade = trim($_GET['grade'] ?? '');
                $tier = trim($_GET['tier'] ?? '');
                $week = intval($_GET['week'] ?? 0);
                $year = !empty($_GET['year']) ? intval($_GET['year']) : $defaultSemesterYear;
                $season = normalizeSeason($_GET['season'] ?? '', $defaultSeasonZh);
                $bankType = normalizeBankType($_GET['bankType'] ?? 'homework');

                if (!$subject || !$grade || !$tier || !$week) {
                    http_response_code(400);
                    echo json_encode(['success' => false, 'error' => '缺少必要参数: subject, grade, tier, week'], JSON_UNESCAPED_UNICODE);
                    exit;
                }

                // 1. 优先从 MySQL 数据库精准查询
                try {
                    $qbank = DB::fetchOne(
                        "SELECT `id`, `bank_type` AS `bankType`, `year`, `season`, `subject`, `grade`, `tier`, `week`, `question_count`, `created_by`, `updated_by`, `updated_at`,
                                ROUND(UNIX_TIMESTAMP(`updated_at`)*1000) AS `updatedAt`
                         FROM `qbank_weeks`
                         WHERE `year` = ? AND `season` = ? AND `subject` = ? AND `grade` = ? AND `tier` = ? AND `week` = ? AND `bank_type` = ?
                         LIMIT 1",
                        [$year, $season, $subject, $grade, $tier, $week, $bankType]
                    );

                    // 兜底: 若指定年份/学期未找到，尝试按学科/年级/班层/周次查询最新记录
                    if (!$qbank) {
                        $qbank = DB::fetchOne(
                            "SELECT `id`, `bank_type` AS `bankType`, `year`, `season`, `subject`, `grade`, `tier`, `week`, `question_count`, `created_by`, `updated_by`, `updated_at`,
                                    ROUND(UNIX_TIMESTAMP(`updated_at`)*1000) AS `updatedAt`
                             FROM `qbank_weeks`
                             WHERE `subject` = ? AND `grade` = ? AND `tier` = ? AND `week` = ? AND `bank_type` = ?
                             ORDER BY `year` DESC, `updated_at` DESC LIMIT 1",
                            [$subject, $grade, $tier, $week, $bankType]
                        );
                    }

                    if ($qbank) {
                        $qRows = DB::fetchAll(
                            "SELECT `question_num` AS `id`, `parent_question_num` AS `parentQuestionNum`, `parent_question_nums` AS `parentQuestionNums`, `sub_num` AS `subNum`,
                                    `topic`, `video_url`, `exercise_pdf`, `exercise_name`, `exercise_thumb`,
                                    `answer_pdf`, `answer_name`, `answer_thumb`
                             FROM `qbank_questions`
                             WHERE `qbank_id` = ?
                             ORDER BY `question_num` ASC",
                            [$qbank['id']]
                        );
                        if (DB::getLastError() !== null) {
                            $qRows = DB::fetchAll(
                                "SELECT `question_num` AS `id`, `parent_question_num` AS `parentQuestionNum`, `sub_num` AS `subNum`,
                                        `topic`, `video_url`, `exercise_pdf`, `exercise_name`, `exercise_thumb`,
                                        `answer_pdf`, `answer_name`, `answer_thumb`
                                 FROM `qbank_questions`
                                 WHERE `qbank_id` = ?
                                 ORDER BY `question_num` ASC",
                                [$qbank['id']]
                            );
                        }

                        $questions = [];
                        foreach ($qRows as $qr) {
                            $rawParentNums = $qr['parentQuestionNums'] ?? null;
                            $parsedParentNums = [];
                            if (!empty($rawParentNums)) {
                                $parsedParentNums = array_values(array_unique(array_filter(array_map('intval', explode(',', $rawParentNums)))));
                                sort($parsedParentNums);
                            } elseif ($qr['parentQuestionNum'] !== null) {
                                $parsedParentNums = [intval($qr['parentQuestionNum'])];
                            }
                            $primaryParentNum = $qr['parentQuestionNum'] !== null ? intval($qr['parentQuestionNum']) : (!empty($parsedParentNums) ? $parsedParentNums[0] : null);

                            $questions[] = [
                                'id' => intval($qr['id']),
                                'parentQuestionNum' => $primaryParentNum,
                                'parentQuestionNums' => $parsedParentNums,
                                'subNum' => intval($qr['subNum'] ?? 1),
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

                        $operator = !empty($qbank['updated_by']) ? $qbank['updated_by'] : ($qbank['created_by'] ?? '');
                        $operatorName = '';
                        if (!empty($operator)) {
                            $uRow = DB::fetchOne("SELECT real_name FROM users WHERE username = ? LIMIT 1", [$operator]);
                            if ($uRow && !empty($uRow['real_name'])) {
                                $operatorName = $uRow['real_name'];
                            }
                        }

                        $result = [
                            'bankType' => normalizeBankType($qbank['bankType'] ?? $bankType),
                            'year' => intval($qbank['year']),
                            'season' => $qbank['season'],
                            'subject' => $qbank['subject'],
                            'grade' => $qbank['grade'],
                            'tier' => $qbank['tier'],
                            'week' => intval($qbank['week']),
                            'questionCount' => intval($qbank['question_count'] ?? count($questions)),
                            'createdBy' => $qbank['created_by'] ?? '',
                            'updatedBy' => $qbank['updated_by'] ?? '',
                            'operator' => $operator,
                            'operatorName' => $operatorName,
                            'updatedAt' => floatval($qbank['updatedAt']),
                            'updatedAtFormatted' => !empty($qbank['updated_at']) ? date('Y-m-d H:i', strtotime($qbank['updated_at'])) : '',
                            'questions' => $questions
                        ];

                        echo json_encode(['success' => true, 'data' => $result], JSON_UNESCAPED_UNICODE);
                        exit;
                    }
                } catch (Throwable $e) {
                    error_log("DB qbank get error: " . $e->getMessage());
                }

                // 2. 数据库中未找到时，回退检查本地 JSON 文件
                $filePath = getFilePath($dataDir, $subject, $grade, $tier, $week, $year, $season, $bankType);
                if (file_exists($filePath)) {
                    $content = json_decode(file_get_contents($filePath), true);
                    if ($content) {
                        $content['bankType'] = normalizeBankType($content['bankType'] ?? $bankType);
                        $content['year'] = $content['year'] ?? $year;
                        $content['season'] = $content['season'] ?? $season;
                        $content['questionCount'] = count($content['questions'] ?? []);
                        if (empty($content['updatedAtFormatted']) && !empty($content['updatedAt'])) {
                            $content['updatedAtFormatted'] = date('Y-m-d H:i', round($content['updatedAt'] / 1000));
                        }
                    }
                    echo json_encode(['success' => true, 'data' => $content], JSON_UNESCAPED_UNICODE);
                } else {
                    echo json_encode(['success' => true, 'data' => null], JSON_UNESCAPED_UNICODE);
                }
            } else {
                http_response_code(400);
                echo json_encode(['success' => false, 'error' => '未知操作: ' . $action], JSON_UNESCAPED_UNICODE);
            }
            break;

        case 'POST':
            requireAuth();

            // 助教权限拦截：助教只能查看题库，禁止增删改
            if (($_SESSION['user_role'] ?? '') === 'assistant') {
                http_response_code(403);
                echo json_encode(['success' => false, 'error' => '助教账号仅具备查看题库权限，禁止修改或保存题目'], JSON_UNESCAPED_UNICODE);
                exit;
            }

            // 保存/更新题目数据
            $input = json_decode(file_get_contents('php://input'), true);

            if (!$input) {
                http_response_code(400);
                echo json_encode(['success' => false, 'error' => '无效的 JSON 数据'], JSON_UNESCAPED_UNICODE);
                exit;
            }

            $subject = trim($input['subject'] ?? '');
            $grade = trim($input['grade'] ?? '');
            $tier = trim($input['tier'] ?? '');
            $week = intval($input['week'] ?? 0);
            $year = !empty($input['year']) ? intval($input['year']) : $defaultSemesterYear;
            $season = normalizeSeason($input['season'] ?? '', $defaultSeasonZh);
            $bankType = normalizeBankType($input['bankType'] ?? 'homework');
            $questions = $input['questions'] ?? [];
            $currentTeacher = trim($_SESSION['username'] ?? ($input['teacher_username'] ?? ''));

            if (!$subject || !$grade || !$tier || !$week) {
                http_response_code(400);
                echo json_encode(['success' => false, 'error' => '缺少必要字段: subject, grade, tier, week'], JSON_UNESCAPED_UNICODE);
                exit;
            }

            if (!is_array($questions) || empty($questions)) {
                http_response_code(400);
                echo json_encode(['success' => false, 'error' => '题目列表不能为空，请至少添加一道题目'], JSON_UNESCAPED_UNICODE);
                exit;
            }

            // 自动清理知识点末尾的标点符号，并严格校验必填项（知识点与错题/题目PDF）
            foreach ($questions as $idx => &$q) {
                if (isset($q['topic']) && is_string($q['topic'])) {
                    $q['topic'] = trim(preg_replace('/[\s,，.。;；:：、\-_—]+$/u', '', trim($q['topic'])));
                }
                $qNum = $q['id'] ?? ($q['question_num'] ?? ($idx + 1));
                $topic = trim($q['topic'] ?? '');
                $exUrl = $q['exercisePdf']['url'] ?? ($q['exercise_pdf'] ?? '');

                if ($topic === '' && $bankType !== 'preview') {
                    http_response_code(400);
                    echo json_encode(['success' => false, 'error' => "第 {$qNum} 题【知识点】为必填项，请填写完整！"], JSON_UNESCAPED_UNICODE);
                    exit;
                }
                if (empty($exUrl)) {
                    http_response_code(400);
                    echo json_encode(['success' => false, 'error' => "第 {$qNum} 题【错题文件】（题目PDF）为必传项，请上传！"], JSON_UNESCAPED_UNICODE);
                    exit;
                }
            }
            unset($q);

            $currentTimeMs = round(microtime(true) * 1000);

            // 1. 同步入库 MySQL
            $dbSaved = false;
            try {
                $db = DB::getConnection();
                if ($db) {
                    $db->beginTransaction();

                    // 插入或更新专题主表
                    $stmtWeek = $db->prepare("
                        INSERT INTO `qbank_weeks` (`bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week`, `question_count`, `created_by`, `updated_by`, `updated_at`)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                        ON DUPLICATE KEY UPDATE
                            `question_count` = VALUES(`question_count`),
                            `created_by` = IF(`created_by` = '' OR `created_by` IS NULL, VALUES(`created_by`), `created_by`),
                            `updated_by` = IF(VALUES(`updated_by`) != '', VALUES(`updated_by`), `updated_by`),
                            `updated_at` = CURRENT_TIMESTAMP
                    ");
                    $stmtWeek->execute([$bankType, $year, $season, $subject, $grade, $tier, $week, count($questions), $currentTeacher, $currentTeacher]);

                    $qbankId = DB::fetchValue(
                        "SELECT `id` FROM `qbank_weeks` WHERE `year` = ? AND `season` = ? AND `subject` = ? AND `grade` = ? AND `tier` = ? AND `week` = ? AND `bank_type` = ? LIMIT 1",
                        [$year, $season, $subject, $grade, $tier, $week, $bankType]
                    );

                    if ($qbankId) {
                        $keepQnums = [];
                        $stmtQuestion = $db->prepare("
                            INSERT INTO `qbank_questions`
                                (`qbank_id`, `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week`, `question_num`, `parent_question_num`, `parent_question_nums`, `sub_num`, `topic`, `video_url`,
                                 `exercise_pdf`, `exercise_name`, `exercise_thumb`,
                                 `answer_pdf`, `answer_name`, `answer_thumb`, `created_by`, `updated_by`, `updated_at`)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                            ON DUPLICATE KEY UPDATE
                                `parent_question_num` = VALUES(`parent_question_num`),
                                `parent_question_nums` = VALUES(`parent_question_nums`),
                                `sub_num` = VALUES(`sub_num`),
                                `topic` = VALUES(`topic`),
                                `video_url` = VALUES(`video_url`),
                                `exercise_pdf` = VALUES(`exercise_pdf`),
                                `exercise_name` = VALUES(`exercise_name`),
                                `exercise_thumb` = VALUES(`exercise_thumb`),
                                `answer_pdf` = VALUES(`answer_pdf`),
                                `answer_name` = VALUES(`answer_name`),
                                `answer_thumb` = VALUES(`answer_thumb`),
                                `created_by` = IF(`created_by` = '' OR `created_by` IS NULL, VALUES(`created_by`), `created_by`),
                                `updated_by` = IF(VALUES(`updated_by`) != '', VALUES(`updated_by`), `updated_by`),
                                `updated_at` = CURRENT_TIMESTAMP
                        ");

                        foreach ($questions as $q) {
                            $qNum = intval($q['id'] ?? ($q['question_num'] ?? ($q['num'] ?? 0)));
                            if ($qNum <= 0) continue;
                            $keepQnums[] = $qNum;

                            $rawParentNums = $q['parentQuestionNums'] ?? ($q['parent_question_nums'] ?? null);
                            $parentNumsArray = [];
                            if (is_array($rawParentNums)) {
                                $parentNumsArray = array_values(array_unique(array_filter(array_map('intval', $rawParentNums))));
                                sort($parentNumsArray);
                            } elseif (is_string($rawParentNums) && trim($rawParentNums) !== '') {
                                $parentNumsArray = array_values(array_unique(array_filter(array_map('intval', explode(',', $rawParentNums)))));
                                sort($parentNumsArray);
                            }

                            $parentQNum = isset($q['parentQuestionNum']) && $q['parentQuestionNum'] !== null && $q['parentQuestionNum'] !== ''
                                ? intval($q['parentQuestionNum'])
                                : (isset($q['parent_question_num']) && $q['parent_question_num'] !== null && $q['parent_question_num'] !== '' ? intval($q['parent_question_num']) : null);

                            if (empty($parentNumsArray) && $parentQNum !== null && $parentQNum > 0) {
                                $parentNumsArray = [$parentQNum];
                            }
                            if ($parentQNum === null && !empty($parentNumsArray)) {
                                $parentQNum = $parentNumsArray[0];
                            }
                            $parentNumsStr = !empty($parentNumsArray) ? implode(',', $parentNumsArray) : null;

                            $subNum = intval($q['subNum'] ?? ($q['sub_num'] ?? 1));

                            $topic = trim($q['topic'] ?? '');
                            if (mb_strlen($topic, 'UTF-8') > 60000) {
                                $topic = mb_substr($topic, 0, 60000, 'UTF-8');
                            }
                            $videoUrl = trim($q['videoUrl'] ?? ($q['video_url'] ?? ''));
                            $exUrl = $q['exercisePdf']['url'] ?? '';
                            $exName = $q['exercisePdf']['name'] ?? '';
                            $exThumb = $q['exercisePdf']['thumb'] ?? '';
                            $ansUrl = $q['answerPdf']['url'] ?? '';
                            $ansName = $q['answerPdf']['name'] ?? '';
                            $ansThumb = $q['answerPdf']['thumb'] ?? '';

                            $stmtQuestion->execute([
                                $qbankId, $bankType, $year, $season, $subject, $grade, $tier, $week,
                                $qNum, $parentQNum, $parentNumsStr, $subNum, $topic, $videoUrl, $exUrl, $exName, $exThumb, $ansUrl, $ansName, $ansThumb,
                                $currentTeacher, $currentTeacher
                            ]);
                        }

                        // 清除本次已删除的题目题号
                        if (!empty($keepQnums)) {
                            $inNums = implode(',', array_map('intval', $keepQnums));
                            $db->exec("DELETE FROM `qbank_questions` WHERE `qbank_id` = {$qbankId} AND `question_num` NOT IN ({$inNums})");
                        } else {
                            $db->exec("DELETE FROM `qbank_questions` WHERE `qbank_id` = {$qbankId}");
                        }

                        $db->commit();
                        $dbSaved = true;
                    } else {
                        $db->rollBack();
                    }
                }
            } catch (Throwable $e) {
                if (isset($db) && $db && $db->inTransaction()) {
                    $db->rollBack();
                }
                error_log("DB qbank save error: " . $e->getMessage());
            }

            // 2. 同步写入 JSON 文件作为灾备和静态镜像
            $data = [
                'bankType' => $bankType,
                'year' => $year,
                'season' => $season,
                'subject' => $subject,
                'grade' => $grade,
                'tier' => $tier,
                'week' => intval($week),
                'questions' => $questions,
                'updatedAt' => $currentTimeMs
            ];

            $filePath = getFilePath($dataDir, $subject, $grade, $tier, $week, $year, $season, $bankType);
            @file_put_contents($filePath, json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));

            // 记录保存题库的审计日志
            if (function_exists('recordServerLog')) {
                recordServerLog('action', 'qbank', 'save_questions', [
                    'bankType'       => $bankType,
                    'year'           => $year,
                    'season'         => $season,
                    'subject'        => $subject,
                    'grade'          => $grade,
                    'tier'           => $tier,
                    'week'           => $week,
                    'question_count' => count($questions)
                ], [
                    'operator' => $currentTeacher
                ]);
            }

            echo json_encode([
                'success' => true,
                'message' => '保存成功',
                'data' => $data,
                'dbSaved' => $dbSaved
            ], JSON_UNESCAPED_UNICODE);
            break;

        case 'DELETE':
            requireAuth();

            // 助教权限拦截：助教只能查看题库，禁止增删改
            if (($_SESSION['user_role'] ?? '') === 'assistant') {
                http_response_code(403);
                echo json_encode(['success' => false, 'error' => '助教账号仅具备查看题库权限，禁止删除题目'], JSON_UNESCAPED_UNICODE);
                exit;
            }

            $subject = trim($_GET['subject'] ?? '');
            $grade = trim($_GET['grade'] ?? '');
            $tier = trim($_GET['tier'] ?? '');
            $week = intval($_GET['week'] ?? 0);
            $year = !empty($_GET['year']) ? intval($_GET['year']) : null;
            $season = !empty($_GET['season']) ? normalizeSeason($_GET['season']) : null;
            $bankType = normalizeBankType($_GET['bankType'] ?? 'homework');
            $delTeacher = trim($_SESSION['username'] ?? ($_GET['teacher_username'] ?? ''));

            if (!$subject || !$grade || !$tier || !$week) {
                http_response_code(400);
                echo json_encode(['success' => false, 'error' => '缺少必要参数: subject, grade, tier, week'], JSON_UNESCAPED_UNICODE);
                exit;
            }

            // 1. 从 MySQL 级联删除
            try {
                if ($year !== null && $season !== null) {
                    $qbankId = DB::fetchValue(
                        "SELECT `id` FROM `qbank_weeks` WHERE `year` = ? AND `season` = ? AND `subject` = ? AND `grade` = ? AND `tier` = ? AND `week` = ? AND `bank_type` = ? LIMIT 1",
                        [$year, $season, $subject, $grade, $tier, $week, $bankType]
                    );
                } else {
                    $qbankId = DB::fetchValue(
                        "SELECT `id` FROM `qbank_weeks` WHERE `subject` = ? AND `grade` = ? AND `tier` = ? AND `week` = ? AND `bank_type` = ? LIMIT 1",
                        [$subject, $grade, $tier, $week, $bankType]
                    );
                }

                if ($qbankId) {
                    DB::execute("DELETE FROM `qbank_questions` WHERE `qbank_id` = ?", [$qbankId]);
                    DB::execute("DELETE FROM `qbank_weeks` WHERE `id` = ?", [$qbankId]);
                }
            } catch (Throwable $e) {
                error_log("DB qbank delete error: " . $e->getMessage());
            }

            // 2. 从文件系统删除
            $filePath = getFilePath($dataDir, $subject, $grade, $tier, $week, $year, $season, $bankType);
            if (file_exists($filePath)) {
                @unlink($filePath);
            }

            // 记录删除题库的审计日志
            if (function_exists('recordServerLog')) {
                recordServerLog('warn', 'qbank', 'delete_questions', [
                    'bankType' => $bankType,
                    'year'    => $year,
                    'season'  => $season,
                    'subject' => $subject,
                    'grade'   => $grade,
                    'tier'    => $tier,
                    'week'    => $week
                ], [
                    'operator' => $delTeacher
                ]);
            }

            echo json_encode(['success' => true, 'message' => '删除成功'], JSON_UNESCAPED_UNICODE);
            break;

        default:
            http_response_code(405);
            echo json_encode(['success' => false, 'error' => '不支持的请求方法'], JSON_UNESCAPED_UNICODE);
    }
} catch (Throwable $e) {
    error_log("qbank.php error: " . $e->getMessage() . "\n" . $e->getTraceAsString());
    http_response_code(500);
    echo json_encode(['success' => false, 'error' => '题库系统服务异常，请稍后重试'], JSON_UNESCAPED_UNICODE);
}
