<?php
/**
 * 题库知识点管理 API (纯 MySQL 数据库存储)
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

// 读取系统配置中的默认年份和学期（_comment 为合法 JSON 字段，直接解码后忽略）
$configFile = __DIR__ . '/../config.json';
$config = [];
if (file_exists($configFile)) {
    $rawConfig = file_get_contents($configFile);
    $config = json_decode($rawConfig, true) ?: [];
}

$defaultSemesterYear = intval($config['semesterYear'] ?? 2026);
$defaultSeasonCode = strval($config['defaultSeason'] ?? 'autumn');
$defaultSeasonZh = normalizeSeason($defaultSeasonCode, '春');

/**
 * 清洗并规范化大题小问元数据 (groupNums, box)
 */
function sanitizeQuestionMeta($rawMeta) {
    if (empty($rawMeta)) return null;
    if (is_string($rawMeta)) {
        $rawMeta = @json_decode($rawMeta, true);
    }
    if (!is_array($rawMeta)) return null;

    $clean = [];
    if (!empty($rawMeta['groupNums']) && is_array($rawMeta['groupNums'])) {
        $gNums = array_values(array_unique(array_filter(array_map('intval', $rawMeta['groupNums']), function($n) {
            return $n > 0 && $n <= 500;
        })));
        sort($gNums);
        if (count($gNums) >= 1) {
            $clean['groupNums'] = $gNums;
        }
    }

    foreach (['box', 'answerBox'] as $boxKey) {
        if (!empty($rawMeta[$boxKey]) && is_array($rawMeta[$boxKey])) {
            $b = $rawMeta[$boxKey];
            $x = isset($b['x']) ? max(0.0, min(1.0, round(floatval($b['x']), 4))) : null;
            $y = isset($b['y']) ? max(0.0, min(1.0, round(floatval($b['y']), 4))) : null;
            $w = isset($b['w']) ? max(0.005, min(1.0, round(floatval($b['w']), 4))) : null;
            $h = isset($b['h']) ? max(0.005, min(1.0, round(floatval($b['h']), 4))) : null;
            $pageOffset = isset($b['pageOffset']) ? max(0, intval($b['pageOffset'])) : 0;
            if ($x !== null && $y !== null && $w !== null && $h !== null) {
                $clean[$boxKey] = [
                    'pageOffset' => $pageOffset,
                    'x' => $x,
                    'y' => $y,
                    'w' => $w,
                    'h' => $h
                ];
            }
        }
    }

    if (!empty($rawMeta['mode']) && $rawMeta['mode'] === 'region_crop') {
        $clean['mode'] = 'region_crop';
    }

    if (!empty($rawMeta['answerLines'])) {
        $clean['answerLines'] = true;
    }

    foreach (['stemBoxes', 'regions', 'answerRegions', 'boxes', 'answerBoxes'] as $arrKey) {
        if (!empty($rawMeta[$arrKey]) && is_array($rawMeta[$arrKey])) {
            $cleanList = [];
            foreach ($rawMeta[$arrKey] as $sb) {
                if (!is_array($sb)) continue;
                $x = isset($sb['x']) ? max(0.0, min(1.0, round(floatval($sb['x']), 4))) : null;
                $y = isset($sb['y']) ? max(0.0, min(1.0, round(floatval($sb['y']), 4))) : null;
                $w = isset($sb['w']) ? max(0.005, min(1.0, round(floatval($sb['w']), 4))) : null;
                $h = isset($sb['h']) ? max(0.005, min(1.0, round(floatval($sb['h']), 4))) : null;
                $pageOffset = isset($sb['pageOffset']) ? max(0, intval($sb['pageOffset'])) : 0;
                if ($x !== null && $y !== null && $w !== null && $h !== null) {
                    $cleanList[] = [
                        'pageOffset' => $pageOffset,
                        'x' => $x,
                        'y' => $y,
                        'w' => $w,
                        'h' => $h
                    ];
                }
            }
            if (!empty($cleanList)) {
                $clean[$arrKey] = $cleanList;
            }
        }
    }

    return !empty($clean) ? $clean : null;
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
 * 构建 题号 => 知识点 映射（兼容共享 PDF 题目的 id 为 "7,8" 这种写法）
 */
function buildHomeworkTopicMap($questions) {
    $map = [];
    if (!is_array($questions)) return $map;
    foreach ($questions as $q) {
        if (!is_array($q)) continue;
        $topic = trim((string)($q['topic'] ?? ''));
        if ($topic === '') continue;

        $rawId = $q['question_num'] ?? ($q['id'] ?? null);
        $nums = [];
        if (is_array($rawId)) {
            $nums = $rawId;
        } elseif (is_string($rawId)) {
            $nums = preg_split('/[,，、]/u', $rawId) ?: [];
        } elseif ($rawId !== null && $rawId !== '') {
            $nums = [$rawId];
        }

        foreach ($nums as $n) {
            $n = intval($n);
            if ($n > 0) $map[$n] = $topic;
        }
    }
    return $map;
}

/**
 * 解析变式题关联的原题号，主原题号优先
 */
function getVariationParentNums($q) {
    if (!is_array($q)) return [];
    $nums = [];

    $primary = intval($q['parentQuestionNum'] ?? ($q['parent_question_num'] ?? 0));
    if ($primary > 0) $nums[] = $primary;

    $raw = $q['parentQuestionNums'] ?? ($q['parent_question_nums'] ?? null);
    if (is_array($raw)) {
        foreach ($raw as $n) {
            $n = intval($n);
            if ($n > 0) $nums[] = $n;
        }
    } elseif (is_string($raw) && trim($raw) !== '') {
        foreach (explode(',', $raw) as $n) {
            $n = intval($n);
            if ($n > 0) $nums[] = $n;
        }
    }

    return array_values(array_unique($nums));
}

/**
 * 变式题知识点始终跟随原题：按主原题号（找不到时退回其它关联原题号）取当前知识点。
 * 仅覆盖非空的当前原题知识点，避免原题暂未填写时把变式题知识点清空。
 */
function syncVariationTopicsToHomework($variations, $homeworkTopicMap) {
    if (!is_array($variations) || empty($homeworkTopicMap)) return $variations;
    foreach ($variations as &$q) {
        if (!is_array($q)) continue;
        foreach (getVariationParentNums($q) as $pNum) {
            if (!empty($homeworkTopicMap[$pNum])) {
                $q['topic'] = $homeworkTopicMap[$pNum];
                break;
            }
        }
    }
    unset($q);
    return $variations;
}

/**
 * 读取同一专题下课后巩固题目的当前知识点映射
 */
function loadHomeworkTopicMapFromDb($year, $season, $subject, $grade, $tier, $week) {
    try {
        $rows = DB::fetchAll(
            "SELECT `question_num`, `topic`
             FROM `qbank_questions`
             WHERE `bank_type` = 'homework' AND `year` = ? AND `season` = ? AND `subject` = ? AND `grade` = ? AND `tier` = ? AND `week` = ?
             ORDER BY `question_num` ASC",
            [$year, $season, $subject, $grade, $tier, intval($week)]
        );
        if (DB::getLastError() !== null) return [];
        return buildHomeworkTopicMap($rows);
    } catch (Throwable $e) {
        error_log("loadHomeworkTopicMap error: " . $e->getMessage());
        return [];
    }
}

/**
 * 课后巩固保存后，级联刷新同专题变式题的知识点（同时支持单原题 parent_question_num 与多原题 parent_question_nums），避免变式题继续显示旧考点。
 */
function cascadeHomeworkTopicsToVariations($db, $year, $season, $subject, $grade, $tier, $week, $questions) {
    if (!$db) return 0;
    $topicMap = buildHomeworkTopicMap($questions);
    if (empty($topicMap)) return 0;

    $varRows = DB::fetchAll(
        "SELECT `id`, `parent_question_num` AS `parentQuestionNum`, `parent_question_nums` AS `parentQuestionNums`, `topic`
         FROM `qbank_questions`
         WHERE `bank_type` = 'variation'
           AND `year` = ? AND `season` = ? AND `subject` = ? AND `grade` = ? AND `tier` = ? AND `week` = ?",
        [$year, $season, $subject, $grade, $tier, intval($week)]
    );
    if (empty($varRows)) return 0;

    $stmtUpdate = $db->prepare(
        "UPDATE `qbank_questions` SET `topic` = ?, `updated_at` = `updated_at` WHERE `id` = ?"
    );
    if (!$stmtUpdate) return 0;

    $changed = 0;
    foreach ($varRows as $vr) {
        $parentNums = getVariationParentNums($vr);
        $newTopic = '';
        foreach ($parentNums as $pNum) {
            if (!empty($topicMap[$pNum])) {
                $newTopic = $topicMap[$pNum];
                break;
            }
        }
        if ($newTopic !== '' && $newTopic !== (string)($vr['topic'] ?? '')) {
            $stmtUpdate->execute([$newTopic, intval($vr['id'])]);
            $changed += $stmtUpdate->rowCount();
        }
    }
    return $changed;
}

/**
 * 同步刷新举一反三 JSON 灾备镜像中的知识点。
 */
// ========== 路由请求 ==========
$method = $_SERVER['REQUEST_METHOD'];

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

                http_response_code(500);
                echo json_encode(['success' => false, 'error' => '题库数据库查询失败，请稍后重试'], JSON_UNESCAPED_UNICODE);

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
                                    `topic`, `video_url`, `question_meta`, `exercise_pdf`, `exercise_name`,
                                    `answer_pdf`, `answer_name`
                             FROM `qbank_questions`
                             WHERE `qbank_id` = ?
                             ORDER BY `question_num` ASC",
                            [$qbank['id']]
                        );
                        if (DB::getLastError() !== null) {
                            $qRows = DB::fetchAll(
                                "SELECT `question_num` AS `id`, `parent_question_num` AS `parentQuestionNum`, `sub_num` AS `subNum`,
                                        `topic`, `video_url`, `exercise_pdf`, `exercise_name`,
                                        `answer_pdf`, `answer_name`
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
                            $qMeta = sanitizeQuestionMeta($qr['question_meta'] ?? null);

                            $qObj = [
                                'id' => intval($qr['id']),
                                'parentQuestionNum' => $primaryParentNum,
                                'parentQuestionNums' => $parsedParentNums,
                                'subNum' => intval($qr['subNum'] ?? 1),
                                'topic' => $qr['topic'] ?? '',
                                'videoUrl' => $qr['video_url'] ?? '',
                                'exercisePdf' => [
                                    'url' => $qr['exercise_pdf'] ?? '',
                                    'name' => $qr['exercise_name'] ?? '',
                                    'status' => !empty($qr['exercise_pdf']) ? 'uploaded' : 'empty'
                                ],
                                'answerPdf' => [
                                    'url' => $qr['answer_pdf'] ?? '',
                                    'name' => $qr['answer_name'] ?? '',
                                    'status' => !empty($qr['answer_pdf']) ? 'uploaded' : 'empty'
                                ]
                            ];
                            if ($qMeta) {
                                $qObj['questionMeta'] = $qMeta;
                            }
                            $questions[] = $qObj;
                        }

                        // 变式题知识点始终跟随原题：读取时用当前课后巩固知识点覆盖历史镜像值
                        if (normalizeBankType($qbank['bankType'] ?? $bankType) === 'variation') {
                            $homeworkTopicMap = loadHomeworkTopicMapFromDb(
                                intval($qbank['year']),
                                $qbank['season'],
                                $qbank['subject'],
                                $qbank['grade'],
                                $qbank['tier'],
                                intval($qbank['week'])
                            );
                            if (!empty($homeworkTopicMap)) {
                                $questions = syncVariationTopicsToHomework($questions, $homeworkTopicMap);
                            }
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
                    http_response_code(500);
                    echo json_encode(['success' => false, 'error' => '题库数据库查询失败，请稍后重试'], JSON_UNESCAPED_UNICODE);
                    exit;
                }

                echo json_encode(['success' => true, 'data' => null], JSON_UNESCAPED_UNICODE);
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
            $removedPdfCandidates = [];
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
                        // 记录覆盖前的旧 PDF URL，以便在提交后清理不再引用的孤儿 PDF
                        $oldPdfRows = DB::fetchAll(
                            "SELECT `exercise_pdf`, `answer_pdf` FROM `qbank_questions` WHERE `qbank_id` = ?",
                            [$qbankId]
                        );
                        $oldPdfUrls = [];
                        foreach ($oldPdfRows as $opr) {
                            if (!empty($opr['exercise_pdf'])) $oldPdfUrls[] = $opr['exercise_pdf'];
                            if (!empty($opr['answer_pdf'])) $oldPdfUrls[] = $opr['answer_pdf'];
                        }
                        $newPdfUrls = [];

                        $keepQnums = [];
                        $stmtQuestion = $db->prepare("
                            INSERT INTO `qbank_questions`
                                (`qbank_id`, `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week`, `question_num`, `parent_question_num`, `parent_question_nums`, `sub_num`, `topic`, `video_url`, `question_meta`,
                                 `exercise_pdf`, `exercise_name`,
                                 `answer_pdf`, `answer_name`, `created_by`, `updated_by`, `updated_at`)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                            ON DUPLICATE KEY UPDATE
                                `parent_question_num` = VALUES(`parent_question_num`),
                                `parent_question_nums` = VALUES(`parent_question_nums`),
                                `sub_num` = VALUES(`sub_num`),
                                `topic` = VALUES(`topic`),
                                `video_url` = VALUES(`video_url`),
                                `question_meta` = VALUES(`question_meta`),
                                `exercise_pdf` = VALUES(`exercise_pdf`),
                                `exercise_name` = VALUES(`exercise_name`),
                                `answer_pdf` = VALUES(`answer_pdf`),
                                `answer_name` = VALUES(`answer_name`),
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
                            $cleanMeta = sanitizeQuestionMeta($q['questionMeta'] ?? ($q['question_meta'] ?? null));
                            $metaJsonStr = $cleanMeta ? json_encode($cleanMeta, JSON_UNESCAPED_UNICODE) : null;
                            $exUrl = $q['exercisePdf']['url'] ?? '';
                            $exName = $q['exercisePdf']['name'] ?? '';
                            $ansUrl = $q['answerPdf']['url'] ?? '';
                            $ansName = $q['answerPdf']['name'] ?? '';

                            if ($exUrl !== '') $newPdfUrls[] = $exUrl;
                            if ($ansUrl !== '') $newPdfUrls[] = $ansUrl;

                            $stmtQuestion->execute([
                                $qbankId, $bankType, $year, $season, $subject, $grade, $tier, $week,
                                $qNum, $parentQNum, $parentNumsStr, $subNum, $topic, $videoUrl, $metaJsonStr, $exUrl, $exName, $ansUrl, $ansName,
                                $currentTeacher, $currentTeacher
                            ]);
                        }

                        // 清除本次已删除的题目题号（使用预处理占位符）
                        if (!empty($keepQnums)) {
                            $cleanKeepNums = array_values(array_map('intval', $keepQnums));
                            $placeholders = implode(',', array_fill(0, count($cleanKeepNums), '?'));
                            $stmtDelRemoved = $db->prepare("DELETE FROM `qbank_questions` WHERE `qbank_id` = ? AND `question_num` NOT IN ({$placeholders})");
                            $stmtDelRemoved->execute(array_merge([intval($qbankId)], $cleanKeepNums));
                        } else {
                            $stmtDelAll = $db->prepare("DELETE FROM `qbank_questions` WHERE `qbank_id` = ?");
                            $stmtDelAll->execute([intval($qbankId)]);
                        }

                        $db->commit();
                        $dbSaved = true;
                        $removedPdfCandidates = array_values(array_diff(array_unique($oldPdfUrls), array_unique($newPdfUrls)));
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

            if (!$dbSaved) {
                http_response_code(500);
                echo json_encode([
                    'success' => false,
                    'error' => '题库保存到数据库失败，请稍后重试'
                ], JSON_UNESCAPED_UNICODE);
                exit;
            }

            if (!empty($removedPdfCandidates)) {
                cleanupUnreferencedPdfs($removedPdfCandidates);
            }

            // 1.5 课后巩固知识点变化后，级联刷新同专题举一反三变式题的知识点
            if ($bankType === 'homework' && isset($db) && $db) {
                try {
                    cascadeHomeworkTopicsToVariations($db, $year, $season, $subject, $grade, $tier, $week, $questions);
                } catch (Throwable $e) {
                    error_log("Cascade variation topic error: " . $e->getMessage());
                }
            }

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

            // 1. 从 MySQL 级联删除并清理不再被任何题库引用的孤儿 PDF
            $deletedPdfCandidates = [];
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
                    $oldPdfRows = DB::fetchAll(
                        "SELECT `exercise_pdf`, `answer_pdf` FROM `qbank_questions` WHERE `qbank_id` = ?",
                        [$qbankId]
                    );
                    foreach ($oldPdfRows as $opr) {
                        if (!empty($opr['exercise_pdf'])) $deletedPdfCandidates[] = $opr['exercise_pdf'];
                        if (!empty($opr['answer_pdf'])) $deletedPdfCandidates[] = $opr['answer_pdf'];
                    }
                    DB::execute("DELETE FROM `qbank_questions` WHERE `qbank_id` = ?", [$qbankId]);
                    DB::execute("DELETE FROM `qbank_weeks` WHERE `id` = ?", [$qbankId]);
                }
            } catch (Throwable $e) {
                error_log("DB qbank delete error: " . $e->getMessage());
            }

            if (!empty($deletedPdfCandidates)) {
                cleanupUnreferencedPdfs($deletedPdfCandidates);
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
