<?php
/**
 * 专属错题本 API
 *
 * POST ?action=encrypt_batch  -> 批量加密学生信息，归档历史记录并返回Token字典
 * GET  ?action=decrypt&token=xxx -> 解密Token并返回本周及历史各周错题对应的PDF地址
 */

require_once __DIR__ . '/bootstrap.php';
require_once __DIR__ . '/logs.php';

$action = $_GET['action'] ?? '';

// Directories
$qbankDir = __DIR__ . '/../data/qbank';
$historyDir = __DIR__ . '/../data/history';
$tempDir = __DIR__ . '/../data/temp';

if (!is_dir($historyDir)) {
    mkdir($historyDir, 0755, true);
}
if (!is_dir($tempDir)) {
    mkdir($tempDir, 0755, true);
}

// 自动清理超过 30 分钟的临时生成 PDF 文件（25%概率触发，避免磁盘占用膨胀）
if (mt_rand(1, 4) === 1) {
    $tempFiles = glob($tempDir . '/*');
    if ($tempFiles) {
        $now = time();
        foreach ($tempFiles as $tf) {
            if (is_file($tf) && ($now - filemtime($tf)) > 1800) {
                @unlink($tf);
            }
        }
    }
}

// Load config and private secret key
$configFile = __DIR__ . '/../config.json';
$configContent = file_exists($configFile) ? file_get_contents($configFile) : '{}';
// _comment 为合法 JSON 字段，直接解码后忽略即可，无需正则剥离
$config = json_decode($configContent, true) ?: [];

$secretConfig = file_exists(__DIR__ . '/secret_key.php') ? require(__DIR__ . '/secret_key.php') : [];
// secret_key.php 在未配置时已直接 500 退出；此处不再保留占位密钥兜底
$secretKey = $secretConfig['retestSecret'] ?? ($config['retestSecret'] ?? '');
if ($secretKey === '' || $secretKey === 'default_fallback_secret_please_change' || $secretKey === 'your-secret-key-template-placeholder') {
    http_response_code(500);
    error_log('retest.php: RETEST_SECRET 未配置，拒绝启动');
    echo json_encode(['success' => false, 'error' => '服务端密钥未配置，请联系管理员'], JSON_UNESCAPED_UNICODE);
    exit;
}
$cipherAlgo = 'aes-256-cbc';

// 加载 MySQL 数据库模块
require_once __DIR__ . '/db.php';
// 错题本身份 Key 纯函数（统一 学号_姓名_年级_学科，兼容旧格式）
require_once __DIR__ . '/lib_retest_keys.php';

/**
 * 记录家长端访问与下载审计日志
 */
function logRetestAccess($token, $studentName, $action, $details = '') {
    try {
        if (empty($token) && empty($studentName)) {
            return;
        }
        $ip = getClientIP();
        $ua = substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 500);
        $db = Database::getInstance();
        $db->execute(
            "INSERT INTO retest_access_logs (`token`, `student_name`, `action`, `details`, `ip`, `user_agent`) VALUES (?, ?, ?, ?, ?, ?)",
            [substr((string)$token, 0, 64), substr((string)$studentName, 0, 100), substr((string)$action, 0, 50), $details, substr((string)$ip, 0, 50), $ua]
        );
    } catch (Throwable $e) {
        error_log("Access log error: " . $e->getMessage());
    }
}

/**
 * Token 吊销黑名单（持久有效）
 * 背景：短 Token 由 HMAC 确定性派生，重生成会得到同一 Token；
 * 因此吊销必须独立于映射表，重生成后仍不可用，直到管理员恢复。
 * 存储：data/history/revoked_tokens.json { token: {by, at, reason} }
 */
function getRevokedTokensFile() {
    return __DIR__ . '/../data/history/revoked_tokens.json';
}
function loadRevokedTokens() {
    $f = getRevokedTokensFile();
    if (!file_exists($f)) return [];
    $d = json_decode(@file_get_contents($f), true);
    return is_array($d) ? $d : [];
}
function saveRevokedTokens(array $map) {
    $f = getRevokedTokensFile();
    $fp = @fopen($f, 'c+');
    if (!$fp) return false;
    if (!flock($fp, LOCK_EX)) { fclose($fp); return false; }
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, json_encode($map ?: (object)[], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    return true;
}

/**
 * 获取指定周次题目的 PDF 列表 (优先从 MySQL qbank_questions 查询，回退到 JSON 文件)
 */
function getWeekPdfs($qbankDir, $subject, $grade, $tier, $weekNum, $errorNums, $year = null, $season = null, $bankType = 'homework') {
    $bankType = $bankType === 'preview' ? 'preview' : 'homework';
    $pdfList = [];
    $uniquePdfs = []; // 防止 3,4,5 题共享同一 PDF 时重复添加

    // 1. 优先从 MySQL qbank_questions 查询
    try {
        $db = Database::getInstance();
        if ($db && !empty($errorNums)) {
            $inNums = implode(',', array_map('intval', $errorNums));
            $whereParts = ["`bank_type` = ?", "`subject` = ?", "`grade` = ?", "`tier` = ?", "`week` = ?", "`question_num` IN ({$inNums})"];
            $params = [$bankType, $subject, $grade, $tier, intval($weekNum)];

            if ($year) {
                $whereParts[] = "`year` = ?";
                $params[] = intval($year);
            }
            if ($season) {
                $whereParts[] = "(`season` = ? OR `season` = ?)";
                $params[] = $season;
                $seasonMap = ['spring'=>'春','summer'=>'暑','autumn'=>'秋','winter'=>'寒','春'=>'spring','暑'=>'summer','秋'=>'autumn','寒'=>'winter'];
                $params[] = $seasonMap[$season] ?? $season;
            }

            $sql = "SELECT `question_num`, `topic`, `video_url`, `exercise_pdf`, `answer_pdf`
                    FROM `qbank_questions`
                    WHERE " . implode(' AND ', $whereParts) . "
                    ORDER BY `question_num` ASC";
            $rows = $db->fetchAll($sql, $params);

            // 若为课后巩固题，查询是否有对应的举一反三变式题
            $varMap = [];
            if ($bankType === 'homework') {
                try {
                    $varWhereParts = ["`bank_type` = 'variation'", "`subject` = ?", "`grade` = ?", "`tier` = ?", "`week` = ?", "`parent_question_num` IN ({$inNums})"];
                    $varParams = [$subject, $grade, $tier, intval($weekNum)];
                    if ($year) {
                        $varWhereParts[] = "`year` = ?";
                        $varParams[] = intval($year);
                    }
                    if ($season) {
                        $varWhereParts[] = "(`season` = ? OR `season` = ?)";
                        $varParams[] = $season;
                        $varParams[] = $seasonMap[$season] ?? $season;
                    }
                    $varSql = "SELECT `parent_question_num`, `sub_num`, `topic`, `exercise_pdf`, `answer_pdf`
                               FROM `qbank_questions`
                               WHERE " . implode(' AND ', $varWhereParts) . "
                               ORDER BY `parent_question_num` ASC, `sub_num` ASC, `id` ASC";
                    $varRows = $db->fetchAll($varSql, $varParams);
                    if (!empty($varRows)) {
                        foreach ($varRows as $vr) {
                            $pNum = intval($vr['parent_question_num']);
                            if (!isset($varMap[$pNum])) $varMap[$pNum] = [];
                            $varMap[$pNum][] = $vr;
                        }
                    }
                } catch (Throwable $varErr) {
                    error_log("Query variation questions error: " . $varErr->getMessage());
                }
            }

            if (!empty($rows)) {
                $rowMap = [];
                foreach ($rows as $r) {
                    $rowMap[intval($r['question_num'])] = $r;
                }
                foreach ($errorNums as $errNum) {
                    $qNum = intval($errNum);
                    // 1. 先加入课后巩固原题
                    if (isset($rowMap[$qNum])) {
                        $r = $rowMap[$qNum];
                        $exerciseUrl = $r['exercise_pdf'] ?: null;
                        if ($exerciseUrl && !isset($uniquePdfs[$exerciseUrl])) {
                            $pdfList[] = [
                                'errorNum' => $errNum,
                                'topic' => $r['topic'] ?? '',
                                'videoUrl' => $r['video_url'] ?: null,
                                'exercisePdf' => $exerciseUrl,
                                'answerPdf' => $r['answer_pdf'] ?: null,
                                'sourceType' => $bankType
                            ];
                            $uniquePdfs[$exerciseUrl] = true;
                        }
                    }
                    // 2. 紧接着排入该题对应的举一反三题目
                    if (isset($varMap[$qNum])) {
                        foreach ($varMap[$qNum] as $vRow) {
                            $vExUrl = $vRow['exercise_pdf'] ?: null;
                            if ($vExUrl && !isset($uniquePdfs[$vExUrl])) {
                                $pdfList[] = [
                                    'errorNum' => $errNum,
                                    'subNum' => intval($vRow['sub_num'] ?? 1),
                                    'topic' => $vRow['topic'] ?? '',
                                    'videoUrl' => null,
                                    'exercisePdf' => $vExUrl,
                                    'answerPdf' => $vRow['answer_pdf'] ?: null,
                                    'sourceType' => 'variation',
                                    'isVariation' => true
                                ];
                                $uniquePdfs[$vExUrl] = true;
                            }
                        }
                    }
                }
                if (!empty($pdfList)) {
                    return $pdfList;
                }
            }
        }
    } catch (Throwable $e) {
        error_log("DB getWeekPdfs error: " . $e->getMessage());
    }

    // 2. 备用回退: 查找本地 JSON 文件
    //    课后巩固沿用旧文件名；预习使用带 _preview 的文件名，两类题库不互相回退。
    $typeSegment = $bankType === 'preview' ? '_preview' : '';
    $qbankFile = null;
    if ($year && $season) {
        $candidate = $qbankDir . '/' . rawurlencode($year) . '_' . rawurlencode($season) . '_' . rawurlencode($subject) . '_' . rawurlencode($grade) . '_' . rawurlencode($tier) . $typeSegment . '_week' . intval($weekNum) . '.json';
        if (file_exists($candidate)) {
            $qbankFile = $candidate;
        }
    }
    if (!$qbankFile) {
        $safeName = rawurlencode($subject) . '_' . rawurlencode($grade) . '_' . rawurlencode($tier) . $typeSegment . '_week' . intval($weekNum);
        $candidate = $qbankDir . '/' . $safeName . '.json';
        if (file_exists($candidate)) {
            $qbankFile = $candidate;
        }
    }

    $foundEntry = null;
    if ($qbankFile && file_exists($qbankFile)) {
        $foundEntry = json_decode(file_get_contents($qbankFile), true);
    } elseif ($bankType === 'homework') {
        $legacyFile = $qbankDir . '/../qbank.json';
        if (file_exists($legacyFile)) {
            $qbankData = json_decode(file_get_contents($legacyFile), true) ?: [];
            foreach ($qbankData as $entry) {
                if (($entry['bankType'] ?? 'homework') !== 'homework') continue;
                if ($entry['subject'] === $subject &&
                    $entry['grade'] === $grade &&
                    $entry['tier'] === $tier &&
                    (int)$entry['week'] === (int)$weekNum) {
                    $foundEntry = $entry;
                    break;
                }
            }
        }
    }

    if ($foundEntry && isset($foundEntry['questions'])) {
        foreach ($errorNums as $errNum) {
            foreach ($foundEntry['questions'] as $q) {
                $ids = array_map('trim', explode(',', str_replace(['，', '、'], ',', (string)$q['id'])));
                if (in_array((string)$errNum, $ids)) {
                    $exerciseUrl = $q['exercisePdf']['url'] ?? null;
                    if ($exerciseUrl && !isset($uniquePdfs[$exerciseUrl])) {
                        $pdfList[] = [
                            'errorNum' => $errNum,
                            'topic' => $q['topic'] ?? '',
                            'videoUrl' => $q['videoUrl'] ?? ($q['video_url'] ?? null),
                            'exercisePdf' => $exerciseUrl,
                            'answerPdf' => $q['answerPdf']['url'] ?? null,
                            'sourceType' => $bankType
                        ];
                        $uniquePdfs[$exerciseUrl] = true;
                    }
                    break;
                }
            }
        }
    }
    return $pdfList;
}

/**
 * 动态生成纯矢量 SVG 图形验证码（无需 GD 扩展依赖）
 */
function generateSvgCaptcha($code) {
    $width = 120;
    $height = 42;
    $chars = str_split($code);

    $svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' . $width . '" height="' . $height . '" viewBox="0 0 ' . $width . ' ' . $height . '">';
    $svg .= '<rect width="100%" height="100%" fill="#f8fafc" rx="8"/>';

    // 背景干扰线条
    $palette = ['#94a3b8', '#64748b', '#3b82f6', '#8b5cf6', '#0ea5e9'];
    for ($i = 0; $i < 4; $i++) {
        $x1 = random_int(0, $width); $y1 = random_int(0, $height);
        $x2 = random_int(0, $width); $y2 = random_int(0, $height);
        $col = $palette[array_rand($palette)];
        $stroke = random_int(1, 2);
        $svg .= '<line x1="' . $x1 . '" y1="' . $y1 . '" x2="' . $x2 . '" y2="' . $y2 . '" stroke="' . $col . '" stroke-width="' . $stroke . '" stroke-opacity="0.45"/>';
    }

    // 背景干扰杂点
    for ($i = 0; $i < 18; $i++) {
        $cx = random_int(2, $width - 2); $cy = random_int(2, $height - 2);
        $r = random_int(1, 2);
        $col = $palette[array_rand($palette)];
        $svg .= '<circle cx="' . $cx . '" cy="' . $cy . '" r="' . $r . '" fill="' . $col . '" fill-opacity="0.5"/>';
    }

    // 字符扭曲与随机颜色渲染
    $textColors = ['#1e293b', '#1d4ed8', '#6d28d9', '#047857', '#b45309'];
    $xOffset = 12;
    foreach ($chars as $idx => $char) {
        $color = $textColors[array_rand($textColors)];
        $rot = random_int(-15, 15);
        $x = $xOffset + ($idx * 26);
        $y = random_int(28, 32);
        $svg .= '<text x="' . $x . '" y="' . $y . '" fill="' . $color . '" font-size="24" font-weight="bold" font-family="Arial, Helvetica, sans-serif" transform="rotate(' . $rot . ', ' . $x . ', ' . $y . ')">' . htmlspecialchars($char) . '</text>';
    }

    $svg .= '</svg>';
    return $svg;
}

// ── Action: 获取图形验证码 ──
if ($action === 'captcha') {
    $chars = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
    $code = '';
    $charsLen = strlen($chars);
    for ($i = 0; $i < 4; $i++) {
        $code .= $chars[random_int(0, $charsLen - 1)];
    }
    $_SESSION['retest_captcha'] = strtolower($code);

    header('Content-Type: image/svg+xml; charset=utf-8');
    header('Cache-Control: no-cache, no-store, must-revalidate');
    header('Pragma: no-cache');
    header('Expires: 0');
    echo generateSvgCaptcha($code);
    exit;
}

// ── Action: 检测当前班级本周是否已有历史学情数据（覆盖前检查与预览） ──
if ($action === 'check_existing_batch') {
    requireAuth();

    $rawInput = file_get_contents('php://input');
    $input = json_decode($rawInput, true) ?: [];

    $subject = trim($input['subject'] ?? $_REQUEST['subject'] ?? '');
    $grade = trim($input['grade'] ?? $_REQUEST['grade'] ?? '');
    $tier = trim($input['tier'] ?? $_REQUEST['tier'] ?? '');
    $week = intval($input['week'] ?? $_REQUEST['week'] ?? 0);
    $year = intval($input['year'] ?? $_REQUEST['year'] ?? 2026);
    $season = trim($input['season'] ?? $_REQUEST['season'] ?? '秋');
    $incomingStudents = $input['students'] ?? null;

    $seasonZhMap = [
        'spring' => '春', '春季' => '春', '春' => '春',
        'summer' => '暑', '暑假' => '暑', '暑' => '暑',
        'autumn' => '秋', '秋季' => '秋', '秋' => '秋',
        'winter' => '寒', '寒假' => '寒', '寒' => '寒'
    ];
    $normalizedSeason = $seasonZhMap[strtolower($season)] ?? $season;

    if (empty($subject) || empty($grade) || empty($tier) || empty($week)) {
        echo json_encode(['success' => true, 'exists' => false, 'hasDiff' => false, 'modifiedStudents' => []], JSON_UNESCAPED_UNICODE);
        exit;
    }

    try {
        $db = Database::getInstance();
        $classBatch = $db->fetchOne(
            "SELECT id, class_name, created_by FROM class_batches
             WHERE `year` = ? AND (`season` = ? OR `season` = ?) AND `grade` = ? AND `tier` = ? AND `subject` = ?
             LIMIT 1",
            [$year, $normalizedSeason, $season, $grade, $tier, $subject]
        );

        if (!$classBatch) {
            echo json_encode(['success' => true, 'exists' => false, 'hasDiff' => false, 'modifiedStudents' => []], JSON_UNESCAPED_UNICODE);
            exit;
        }

        $batchId = (int)$classBatch['id'];

        // 获取最新生成批次时间与操作人
        $genBatch = $db->fetchOne(
            "SELECT created_by, created_at FROM `generation_batches` WHERE `class_id` = ? AND `week_num` = ? ORDER BY `id` DESC LIMIT 1",
            [$batchId, $week]
        );

        $operator = $genBatch['created_by'] ?? ($classBatch['created_by'] ?? '');
        $operatorName = '';
        if (!empty($operator)) {
            $uRow = $db->fetchOne("SELECT real_name FROM users WHERE username = ? LIMIT 1", [$operator]);
            if ($uRow && !empty($uRow['real_name'])) {
                $operatorName = $uRow['real_name'];
            }
        }

        $createdAtFormatted = !empty($genBatch['created_at'])
            ? date('Y-m-d H:i', strtotime($genBatch['created_at']))
            : '';

        // 如果传入了当前上传的学生名单，按学生白名单维度进行精准对比
        if (is_array($incomingStudents)) {
            $studentKeys = [];
            $nameOnlyNames = [];
            $incomingMap = [];
            foreach ($incomingStudents as $st) {
                $sName = trim($st['name'] ?? '');
                if ($sName === '') continue;
                $sId = trim((string)($st['id'] ?? ''));
                // 服务端统一构建身份 Key，不信任前端传来的旧格式 Key
                $sKey = build_student_key($sId, $sName, $grade, $subject);
                $legacyKey = legacy_student_key($sId, $sName);
                $sScore = isset($st['score']) ? floatval($st['score']) : 0.0;
                $sErrors = isset($st['errors']) && is_array($st['errors']) ? array_values(array_unique(array_map('intval', $st['errors']))) : [];
                sort($sErrors, SORT_NUMERIC);
                $incomingData = [
                    'name' => $sName,
                    'id' => $sId,
                    'key' => $sKey,
                    'score' => $sScore,
                    'errors' => $sErrors
                ];
                $incomingMap[$sKey] = $incomingData;
                if ($legacyKey !== $sKey) {
                    $incomingMap[$legacyKey] = $incomingData;
                }
                $studentKeys[] = $sKey;
                if ($legacyKey !== $sKey) {
                    $studentKeys[] = $legacyKey;
                }
                // 仅无学号学生允许进入姓名兜底匹配集合
                if ($sId === '') {
                    $nameOnlyNames[$sName] = true;
                }
            }

            $studentKeys = array_values(array_unique(array_filter($studentKeys)));
            $nameOnlyNames = array_keys($nameOnlyNames);

            if (empty($studentKeys) && empty($nameOnlyNames)) {
                echo json_encode(['success' => true, 'exists' => false, 'hasDiff' => false, 'modifiedStudents' => []], JSON_UNESCAPED_UNICODE);
                exit;
            }

            // 仅查询当前上传的学生在数据库中的已有存档（忽略其他老师的学生或未上传学生）
            $whereOr = [];
            $params = [$batchId, $week];
            if (!empty($studentKeys)) {
                $placeholders = implode(',', array_fill(0, count($studentKeys), '?'));
                $whereOr[] = "`student_key` IN ($placeholders)";
                $params = array_merge($params, $studentKeys);
            }
            if (!empty($nameOnlyNames)) {
                $placeholders = implode(',', array_fill(0, count($nameOnlyNames), '?'));
                $whereOr[] = "((`student_key` IS NULL OR `student_key` = '' OR `student_key` = `student_name`) AND `student_name` IN ($placeholders))";
                $params = array_merge($params, $nameOnlyNames);
            }
            $recRows = $db->fetchAll(
                "SELECT student_name, student_id, student_key, homework_score, error_count, error_questions, updated_at, created_by
                 FROM `student_records`
                 WHERE `batch_id` = ? AND `week_num` = ? AND (" . implode(' OR ', $whereOr) . ")
                 ORDER BY updated_at ASC, id ASC",
                $params
            );

            $matchedCount = count($recRows);
            $modifiedStudents = [];
            $lastUpdated = '';
            $latestRowOperator = '';

            foreach ($recRows as $r) {
                $rKey = trim($r['student_key'] ?? '');
                $rName = trim($r['student_name']);
                $matchedData = ($rKey !== '' && isset($incomingMap[$rKey])) ? $incomingMap[$rKey] : null;
                if (!$matchedData) {
                    $rLegacyKey = legacy_student_key((string)($r['student_id'] ?? ''), $rName);
                    if ($rLegacyKey !== $rKey && isset($incomingMap[$rLegacyKey])) {
                        $matchedData = $incomingMap[$rLegacyKey];
                    }
                }
                if (!$matchedData && is_legacy_name_only_key($rKey, $rName) && isset($incomingMap[$rName])) {
                    $matchedData = $incomingMap[$rName];
                }
                if (!$matchedData) continue;

                if (!empty($r['updated_at']) && $r['updated_at'] > $lastUpdated) {
                    $lastUpdated = $r['updated_at'];
                }
                // 记录按 updated_at 升序，最后一条即该批学生最近一次操作的教师
                $latestRowOperator = trim((string)($r['created_by'] ?? ''));

                $incoming = $matchedData;

                $oldScoreNum = isset($r['homework_score']) ? floatval($r['homework_score']) : 0.0;
                $newScoreNum = $incoming['score'];
                $scoreChanged = (abs($oldScoreNum - $newScoreNum) > 0.01);

                $oldErrs = json_decode($r['error_questions'], true);
                if (!is_array($oldErrs)) $oldErrs = [];
                $oldErrs = array_values(array_unique(array_map('intval', $oldErrs)));
                sort($oldErrs, SORT_NUMERIC);

                $newErrs = $incoming['errors'];
                $errorsChanged = ($oldErrs !== $newErrs);

                // 只有已存档且得分或错题发生变动的学生，才判定为需要预警的覆盖修改
                if ($scoreChanged || $errorsChanged) {
                    $oldScoreDisplay = (abs($oldScoreNum - round($oldScoreNum)) < 0.001) ? (int)round($oldScoreNum) : round($oldScoreNum, 1);
                    $newScoreDisplay = (abs($newScoreNum - round($newScoreNum)) < 0.001) ? (int)round($newScoreNum) : round($newScoreNum, 1);

                    $displayName = $rName;
                    if (!empty($r['student_id'])) {
                        $displayName = $r['student_id'] . ' ' . $rName;
                    }
                    $modifiedStudents[] = [
                        'name' => $displayName,
                        'rawName' => $rName,
                        'studentId' => $r['student_id'] ?? '',
                        'operator' => trim((string)($r['created_by'] ?? '')),
                        'scoreChanged' => $scoreChanged,
                        'errorsChanged' => $errorsChanged,
                        'oldScore' => $oldScoreDisplay,
                        'newScore' => $newScoreDisplay,
                        'oldErrors' => $oldErrs,
                        'newErrors' => $newErrs
                    ];
                }
            }

            if (!empty($lastUpdated)) {
                $createdAtFormatted = date('Y-m-d H:i', strtotime($lastUpdated));
            }
            // 班级批次被多个教师共用，批次级操作人可能属于别的班；
            // 这里以本次上传学生的实际记录为准，显示最近一次操作教师。
            if ($latestRowOperator !== '') {
                $operator = $latestRowOperator;
                $operatorName = '';
                $uRow = $db->fetchOne("SELECT real_name FROM users WHERE username = ? LIMIT 1", [$operator]);
                if ($uRow && !empty($uRow['real_name'])) {
                    $operatorName = $uRow['real_name'];
                }
            }

            echo json_encode([
                'success' => true,
                'exists' => ($matchedCount > 0),
                'hasDiff' => (count($modifiedStudents) > 0),
                'modifiedStudents' => $modifiedStudents,
                'data' => [
                    'createdAt' => $createdAtFormatted,
                    'createdBy' => $operator,
                    'createdByName' => $operatorName,
                    'matchedCount' => $matchedCount,
                    'modifiedCount' => count($modifiedStudents)
                ]
            ], JSON_UNESCAPED_UNICODE);
            exit;
        }

        // 未传入学生名单时的回退逻辑：检查该班级该周是否有任何记录并返回学生列表
        $recordCount = (int)$db->fetchValue(
            "SELECT COUNT(*) FROM `student_records` WHERE `batch_id` = ? AND `week_num` = ?",
            [$batchId, $week]
        );

        if ($recordCount === 0) {
            echo json_encode(['success' => true, 'exists' => false, 'hasDiff' => false, 'modifiedStudents' => []], JSON_UNESCAPED_UNICODE);
            exit;
        }

        // 获取该班级该周所有学生的历史成绩与错题数据
        $recRows = $db->fetchAll(
            "SELECT student_name, student_id, student_key, homework_score, error_count, error_questions
             FROM `student_records`
             WHERE `batch_id` = ? AND `week_num` = ?
             ORDER BY id ASC",
            [$batchId, $week]
        );

        $studentsList = [];
        foreach ($recRows as $r) {
            $errs = json_decode($r['error_questions'], true);
            if (!is_array($errs)) {
                $errs = [];
            }
            $studentsList[] = [
                'name' => trim($r['student_name']),
                'id' => trim($r['student_id'] ?? ''),
                'key' => trim($r['student_key'] ?? ''),
                'score' => floatval($r['homework_score']),
                'errors' => array_values(array_map('intval', $errs))
            ];
        }

        echo json_encode([
            'success' => true,
            'exists' => true,
            'hasDiff' => false,
            'modifiedStudents' => [],
            'data' => [
                'createdAt' => $createdAtFormatted,
                'createdBy' => $operator,
                'createdByName' => $operatorName,
                'students' => $studentsList
            ]
        ], JSON_UNESCAPED_UNICODE);
        exit;
    } catch (Throwable $e) {
        error_log("check_existing_batch error: " . $e->getMessage());
        http_response_code(500);
        echo json_encode(['success' => false, 'error' => '检查班级历史批次失败，数据库服务异常'], JSON_UNESCAPED_UNICODE);
        exit;
    }
}

if ($action === 'encrypt_batch') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        http_response_code(405);
        echo json_encode(['success' => false, 'error' => 'Method not allowed']);
        exit;
    }

    requireAuth();

    $input = json_decode(file_get_contents('php://input'), true);
    if (!$input || !isset($input['students'])) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Invalid payload']);
        exit;
    }

    $subject = $input['subject'] ?? '';
    $grade = $input['grade'] ?? '';
    $tier = $input['tier'] ?? '';
    $week = intval($input['week'] ?? 0);
    $previewWeek = intval($input['preview_week'] ?? ($input['previewWeek'] ?? 0));
    if ($previewWeek <= 0) $previewWeek = $week;
    // 本次是否携带预习/课后数据：未携带时必须保留已有数据，不能被空数组误清空
    $hasPreviewData = !empty($input['has_preview_data']) || !empty($input['hasPreviewData']);
    // 兼容旧客户端：未显式声明时按“有课后数据”处理，保持原有覆盖行为
    $hasHomeworkData = !array_key_exists('has_homework_data', $input) || !empty($input['has_homework_data']);
    $year = intval($input['year'] ?? 2026);
    $season = trim($input['season'] ?? '秋');

    $seasonZhMap = [
        'spring' => '春', '春季' => '春', '春' => '春',
        'summer' => '暑', '暑假' => '暑', '暑' => '暑',
        'autumn' => '秋', '秋季' => '秋', '秋' => '秋',
        'winter' => '寒', '寒假' => '寒', '寒' => '寒'
    ];
    $normalizedSeason = $seasonZhMap[strtolower($season)] ?? $season;
    $shortYear = substr((string)$year, -2);
    $className = "{$shortYear}{$normalizedSeason}_{$grade}_{$tier}_{$subject}";

    // 获取当前操作教师账号 (Session 优先，请求体兜底)
    $currentTeacher = trim($_SESSION['username'] ?? ($input['teacher_username'] ?? ''));

    // 同步获取或创建班级批次 (MySQL)
    $batchId = null;
    $db = null;
    try {
        $db = Database::getInstance();
        $batch = $db->fetchOne(
            "SELECT id, created_by FROM class_batches WHERE `year` = ? AND (`season` = ? OR `season` = ?) AND `grade` = ? AND `tier` = ? AND `subject` = ? LIMIT 1",
            [$year, $normalizedSeason, $season, $grade, $tier, $subject]
        );
        if ($batch) {
            $batchId = (int)$batch['id'];
            if (!empty($currentTeacher) && empty($batch['created_by'])) {
                $db->execute("UPDATE class_batches SET `created_by` = ? WHERE `id` = ?", [$currentTeacher, $batchId]);
            }
        } else {
            $db->execute(
                "INSERT INTO class_batches (`year`, `season`, `grade`, `tier`, `subject`, `class_name`, `created_by`) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [$year, $normalizedSeason, $grade, $tier, $subject, $className, $currentTeacher]
            );
            $batchId = (int)$db->lastInsertId();
        }
    } catch (Throwable $e) {
        error_log("DB class_batches error: " . $e->getMessage());
    }

    if (!$batchId || !$db) {
        http_response_code(500);
        echo json_encode([
            'success' => false,
            'error' => '无法创建或获取班级批次信息，数据库操作异常'
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 班级历史错题档案路径与短 Token 索引路径（文件系统，双写保证向下兼容）
    // 错题本按学生身份聚合，不再按班型分档：新写入统一落到 `学科_年级.json`；
    // 读取时会同时合并旧的 `学科_年级_班型.json`，保证换班型后历史不断档。
    $historyFile = $historyDir . '/' . rawurlencode($subject) . '_' . rawurlencode($grade) . '.json';
    $previewHistoryFile = $historyDir . '/' . rawurlencode($subject) . '_' . rawurlencode($grade) . '_preview.json';
    $tokenMapFile = $historyDir . '/token_map.json';
    $batchHistoryUpdates = [];
    $batchPreviewHistoryUpdates = [];
    $batchNameMap = [];
    $batchTokenMapEntries = [];

    // 生成当次操作的唯一批次编号（老师每一次生成就生成一次，作为一次完整的批次）
    $batchCode = 'B' . date('Ymd_His') . '_' . substr(bin2hex(random_bytes(2)), 0, 4);
    $validStudentCount = 0;
    $errorStudentCount = 0;

    // 解析上传的来源文件名列表（有几个记录几个）
    $sourceFilesRaw = $input['source_files'] ?? [];
    if (is_string($sourceFilesRaw)) {
        $sourceFilesList = array_values(array_unique(array_filter(array_map('trim', explode("\n", $sourceFilesRaw)))));
    } elseif (is_array($sourceFilesRaw)) {
        $sourceFilesList = array_values(array_unique(array_filter(array_map('strval', $sourceFilesRaw))));
    } else {
        $sourceFilesList = [];
    }
    $sourceFilesJson = !empty($sourceFilesList) ? json_encode($sourceFilesList, JSON_UNESCAPED_UNICODE) : null;

    // 开启数据库事务，确保归档、成绩更新与批次表写入的原子性
    $pdo = DB::getConnection();
    if ($pdo && !$pdo->inTransaction()) {
        $pdo->beginTransaction();
    }

    // 核心安全防护：在即将被本次生成覆盖之前，自动将已有学情记录归档至 student_record_history 历史版本元组库
    if ($batchId && !empty($input['students'])) {
        try {
            $studentKeysToArchive = [];
            $studentNamesToArchive = [];
            foreach ($input['students'] as $stItem) {
                $stName = trim($stItem['name'] ?? '');
                if (empty($stName)) continue;
                $stId = trim((string)($stItem['id'] ?? ''));
                if ($stId !== '') {
                    $studentKeysToArchive[] = build_student_key($stId, $stName, $grade, $subject);
                    $studentKeysToArchive[] = legacy_student_key($stId, $stName);
                } else {
                    $studentNamesToArchive[] = $stName;
                }
            }
            $studentKeysToArchive = array_values(array_unique(array_filter($studentKeysToArchive)));
            $studentNamesToArchive = array_values(array_unique(array_filter($studentNamesToArchive)));

            $whereOr = [];
            $queryParams = [$batchId, $week];
            if (!empty($studentKeysToArchive)) {
                $inPls1 = implode(',', array_fill(0, count($studentKeysToArchive), '?'));
                $whereOr[] = "`student_key` IN ({$inPls1})";
                $queryParams = array_merge($queryParams, $studentKeysToArchive);
            }
            if (!empty($studentNamesToArchive)) {
                $inPls2 = implode(',', array_fill(0, count($studentNamesToArchive), '?'));
                $whereOr[] = "(`student_name` IN ({$inPls2}) AND (`student_key` IS NULL OR `student_key` = '' OR `student_key` = `student_name`))";
                $queryParams = array_merge($queryParams, $studentNamesToArchive);
            }

            if (!empty($whereOr)) {
                $whereSql = implode(' OR ', $whereOr);
                $existingRows = $db->fetchAll(
                    "SELECT * FROM `student_records`
                     WHERE `batch_id` = ? AND `week_num` = ? AND ({$whereSql})",
                    $queryParams
                );
                if (!empty($existingRows)) {
                    $prevGen = $db->fetchOne(
                        "SELECT batch_code, created_by FROM `generation_batches` WHERE `class_id` = ? AND `week_num` = ? ORDER BY id DESC LIMIT 1",
                        [$batchId, $week]
                    );
                    $prevBatchCode = $prevGen['batch_code'] ?? '';
                    $prevCreator = $prevGen['created_by'] ?? '';

                    $histStmt = "INSERT INTO `student_record_history`
                        (`record_id`, `batch_id`, `batch_code`, `student_id`, `student_name`, `student_key`, `week_num`,
                         `preview_week_num`, `homework_score`, `preview_score`, `total_score`, `error_count`, `error_questions`,
                         `preview_error_questions`, `teacher_comment`, `preview_comment`,
                         `source_files`, `retest_token`, `created_by`, `operator`, `operation_type`, `record_created_at`, `record_updated_at`, `archived_at`)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'batch_overwrite', ?, ?, NOW())";
                    foreach ($existingRows as $ex) {
                        $db->execute($histStmt, [
                            $ex['id'],
                            $ex['batch_id'],
                            $prevBatchCode,
                            $ex['student_id'] ?? '',
                            $ex['student_name'],
                            $ex['student_key'] ?? '',
                            $ex['week_num'],
                            $ex['preview_week_num'] ?? null,
                            $ex['homework_score'],
                            $ex['preview_score'],
                            $ex['total_score'],
                            $ex['error_count'],
                            $ex['error_questions'],
                            $ex['preview_error_questions'] ?? null,
                            $ex['teacher_comment'],
                            $ex['preview_comment'] ?? null,
                            $ex['source_files'] ?? null,
                            $ex['retest_token'] ?? null,
                            $prevCreator,
                            $currentTeacher,
                            $ex['created_at'],
                            $ex['updated_at']
                        ]);
                    }
                }
            }
        } catch (Throwable $e) {
            if ($pdo && $pdo->inTransaction()) {
                $pdo->rollBack();
            }
            error_log("DB student_record_history archive error: " . $e->getMessage());
            http_response_code(500);
            echo json_encode([
                'success' => false,
                'error' => '历史学情归档失败，为防止数据丢失已终止覆盖操作'
            ], JSON_UNESCAPED_UNICODE);
            exit;
        }
    }

    $tokens = [];
    foreach ($input['students'] as $student) {
        $name = trim($student['name'] ?? '');
        if (empty($name)) continue;
        $studentId = trim((string)($student['id'] ?? ''));
        $studentKey = build_student_key($studentId, $name, $grade, $subject);
        $legacyKey = legacy_student_key($studentId, $name);
        $rawErrors = $student['errors'] ?? [];

        $errors = [];
        if (!empty($rawErrors)) {
            if (is_string($rawErrors)) {
                $errors = preg_split('/[\s,，、]+/', trim($rawErrors));
            } elseif (is_array($rawErrors)) {
                $errors = $rawErrors;
            } else {
                $errors = [$rawErrors];
            }
            $errors = array_map(function($val) {
                if (is_string($val)) {
                    $val = strtr($val, [
                        '０'=>'0','１'=>'1','２'=>'2','３'=>'3','４'=>'4',
                        '５'=>'5','６'=>'6','７'=>'7','８'=>'8','９'=>'9'
                    ]);
                }
                return intval($val);
            }, $errors);
            $errors = array_values(array_unique(array_filter($errors)));
        }

        // 提取成绩与评语
        $hwScore = (isset($student['homeworkScore']) && is_numeric($student['homeworkScore'])) ? floatval($student['homeworkScore']) : null;
        $preScore = (isset($student['previewScore']) && is_numeric($student['previewScore'])) ? floatval($student['previewScore']) : null;
        $totScore = (isset($student['totalScore']) && is_numeric($student['totalScore'])) ? floatval($student['totalScore']) : null;
        $comment = trim($student['comment'] ?? '');
        $previewComment = trim($student['previewComment'] ?? ($student['preview_comment'] ?? ''));
        $previewWeekValue = intval($student['previewWeek'] ?? ($student['preview_week'] ?? $previewWeek));
        if ($previewWeekValue <= 0) $previewWeekValue = $week;

        // 预习错题独立于课后巩固错题，使用同样的错题题号解析规则
        $rawPreviewErrors = $student['previewErrors'] ?? [];
        $studentHasPreview = $hasPreviewData
            || !empty($student['previewProvided'])
            || !empty($student['preview_provided'])
            || $previewComment !== ''
            || !empty($rawPreviewErrors);
        $previewErrors = [];
        if (!empty($rawPreviewErrors)) {
            if (is_string($rawPreviewErrors)) {
                $previewErrors = preg_split('/[\s,，、]+/', trim($rawPreviewErrors));
            } elseif (is_array($rawPreviewErrors)) {
                $previewErrors = $rawPreviewErrors;
            } else {
                $previewErrors = [$rawPreviewErrors];
            }
            $previewErrors = array_map(function($val) {
                if (is_string($val)) {
                    $val = strtr($val, [
                        '０'=>'0','１'=>'1','２'=>'2','３'=>'3','４'=>'4',
                        '５'=>'5','６'=>'6','７'=>'7','８'=>'8','９'=>'9'
                    ]);
                }
                return intval($val);
            }, $previewErrors);
            $previewErrors = array_values(array_unique(array_filter($previewErrors)));
        }

        // 服务端智能兜底：若前端传来的 errors 为空，但评语包含错题声明，自动解析题号
        if (empty($errors) && !empty($comment)) {
            $commentNorm = strtr($comment, [
                '０'=>'0','１'=>'1','２'=>'2','３'=>'3','４'=>'4',
                '５'=>'5','６'=>'6','７'=>'7','８'=>'8','９'=>'9'
            ]);
            $firstLine = trim(explode("\n", $commentNorm)[0]);
            if (preg_match('/^(?:本次|本周|这周|今天)?(?:的)?(?:家庭)?(?:作业|测验|测试|练习)?(?:的)?(?:错题|做错的题|做错|错误)(?:题号|序号|编号|列表)?(?:为|是)?(?:\s*[:：]\s*|\s*(?=\d|第|无|0|零|全对|全部))(.*)$/iu', $firstLine, $m)) {
                $after = trim($m[1]);
                if (!preg_match('/^(?:无|没有|0|零|全对|全部正确|无错题|none)/iu', $after)) {
                    $numsPart = preg_split('/[。!！;；\n]|(?=[\x{4e00}-\x{9fa5}]{2,})/u', $after)[0];
                    if (preg_match_all('/\d+/', $numsPart, $numMatches)) {
                        $parsedNums = array_values(array_unique(array_filter(array_map('intval', $numMatches[0]))));
                        if (!empty($parsedNums)) {
                            $errors = $parsedNums;
                        }
                    }
                }
            }
        }

        // 预习评语同样兜底解析；预习评语为空时不影响课后巩固错题
        if (empty($previewErrors) && !empty($previewComment)) {
            $previewCommentNorm = strtr($previewComment, [
                '０'=>'0','１'=>'1','２'=>'2','３'=>'3','４'=>'4',
                '５'=>'5','６'=>'6','７'=>'7','８'=>'8','９'=>'9'
            ]);
            $firstLine = trim(explode("\n", $previewCommentNorm)[0]);
            if (preg_match('/^(?:本次|本周|这周|今天)?(?:的)?(?:家庭)?(?:作业|测验|测试|练习)?(?:的)?(?:错题|做错的题|做错|错误)(?:题号|序号|编号|列表)?(?:为|是)?(?:\s*[:：]\s*|\s*(?=\d|第|无|0|零|全对|全部))(.*)$/iu', $firstLine, $m)) {
                $after = trim($m[1]);
                if (!preg_match('/^(?:无|没有|0|零|全对|全部正确|无错题|none)/iu', $after)) {
                    $numsPart = preg_split('/[。!！;；\n]|(?=[\x{4e00}-\x{9fa5}]{2,})/u', $after)[0];
                    if (preg_match_all('/\d+/', $numsPart, $numMatches)) {
                        $parsedNums = array_values(array_unique(array_filter(array_map('intval', $numMatches[0]))));
                        if (!empty($parsedNums)) {
                            $previewErrors = $parsedNums;
                        }
                    }
                }
            }
        }

        // 归档到本次批次变更集：以唯一 studentKey 隔离存储
        $batchNameMap[$studentKey] = $name;
        if ($hasHomeworkData) {
            $batchHistoryUpdates[$studentKey][(string)$week] = $errors;
        }
        if ($studentHasPreview) {
            $batchPreviewHistoryUpdates[$studentKey][(string)$week] = [
                'errors' => $previewErrors,
                'previewWeek' => $previewWeekValue
            ];
        }

        // 生成简短、高熵且防篡改的短 Token（10位，基于 HMAC-SHA256）
        // 哈希因子不再包含班型：学生换班型后仍得到同一个稳定链接，历史不断档
        $rawHash = hash_hmac('sha256', "{$subject}_{$grade}_{$studentKey}", $secretKey, true);
        $shortToken = substr(str_replace(['+', '/', '='], ['-', '_', ''], base64_encode($rawHash)), 0, 10);

        // 记录短 Token 映射条目
        $batchTokenMapEntries[$shortToken] = [
            's' => $subject,
            'g' => $grade,
            't' => $tier,
            'w' => $week,
            'pw' => $previewWeekValue, // 预习周次（可与课后巩固不同）
            'pq' => $previewErrors,    // 当前周预习错题，数据库不可用时兜底
            'n' => $name,       // 真实姓名（供家长核验输入）
            'k' => $studentKey, // 唯一标识（定位历史库中该学生的独立档案）
            'id' => $studentId, // 学号
            'year' => $year,
            'season' => $season,
            'u' => time()
        ];

        // 同步写入或更新 MySQL student_records 表（即使 0 错题也同步更新最新成绩、评语和 0 错题，避免残留旧批改数据！）
        if ($batchId) {
            try {
                $errCount = count($errors);
                $errJson = json_encode($errors, JSON_UNESCAPED_UNICODE);
                $previewErrCount = count($previewErrors);
                // 未携带预习数据时写 NULL，配合 COALESCE 保留数据库里已有的预习错题与评语
                $previewErrJson = $studentHasPreview ? json_encode($previewErrors, JSON_UNESCAPED_UNICODE) : null;
                $previewWeekForDb = $studentHasPreview ? $previewWeekValue : null;
                $previewCommentForDb = $studentHasPreview ? $previewComment : null;
                // 迁移过渡期自愈：若该生本周还是旧格式 Key 的旧行，先原地升级 Key，
                // 再走 ON DUPLICATE KEY UPDATE，避免同一学生同一周出现新旧两行。
                if ($legacyKey !== $studentKey) {
                    $db->execute(
                        "UPDATE `student_records` SET `student_key` = ?
                         WHERE `batch_id` = ? AND `week_num` = ? AND `student_key` = ?",
                        [$studentKey, $batchId, $week, $legacyKey]
                    );
                }
                $updateParts = [
                    "`student_id` = VALUES(`student_id`)",
                    "`student_name` = VALUES(`student_name`)",
                    "`preview_week_num` = COALESCE(VALUES(`preview_week_num`), `preview_week_num`)",
                    "`preview_score` = COALESCE(VALUES(`preview_score`), `preview_score`)",
                    "`preview_error_questions` = COALESCE(VALUES(`preview_error_questions`), `preview_error_questions`)",
                    "`preview_comment` = COALESCE(VALUES(`preview_comment`), `preview_comment`)",
                    "`retest_token` = VALUES(`retest_token`)",
                    "`created_by` = IF(VALUES(`created_by`) != '', VALUES(`created_by`), `created_by`)",
                    "`updated_at` = CURRENT_TIMESTAMP"
                ];
                if ($hasHomeworkData) {
                    array_unshift($updateParts,
                        "`batch_code` = VALUES(`batch_code`)",
                        "`source_files` = VALUES(`source_files`)",
                        "`homework_score` = VALUES(`homework_score`)",
                        "`total_score` = VALUES(`total_score`)",
                        "`error_count` = VALUES(`error_count`)",
                        "`error_questions` = VALUES(`error_questions`)",
                        "`teacher_comment` = VALUES(`teacher_comment`)"
                    );
                }
                $updateClause = implode(",\n                            ", $updateParts);
                $db->execute(
                    "INSERT INTO student_records
                        (`batch_id`, `batch_code`, `source_files`, `student_id`, `student_name`, `student_key`, `week_num`, `preview_week_num`, `homework_score`, `preview_score`, `total_score`, `error_count`, `error_questions`, `preview_error_questions`, `teacher_comment`, `preview_comment`, `retest_token`, `created_by`)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE
                            {$updateClause}",
                    [
                        $batchId,
                        $batchCode,
                        $sourceFilesJson,
                        $studentId,
                        $name,
                        $studentKey,
                        $week,
                        $previewWeekForDb,
                        $hwScore,
                        $preScore,
                        $totScore,
                        $errCount,
                        $errJson,
                        $previewErrJson,
                        $comment,
                        $previewCommentForDb,
                        $shortToken,
                        $currentTeacher
                    ]
                );
                $validStudentCount++;
                if ($errCount > 0 || $previewErrCount > 0) {
                    $errorStudentCount++;
                }
            } catch (Throwable $e) {
                if ($pdo && $pdo->inTransaction()) {
                    $pdo->rollBack();
                }
                error_log("DB student_records insert error: " . $e->getMessage());
                http_response_code(500);
                echo json_encode([
                    'success' => false,
                    'error' => '学生学情记录写入失败，操作已回滚'
                ], JSON_UNESCAPED_UNICODE);
                exit;
            }
        }

        // 新 Key + 旧 Key 双映射；纯姓名只映射给无学号数据，避免同名学生互相覆盖
        $tokens[$studentKey] = $shortToken;
        if ($legacyKey !== $studentKey) {
            $tokens[$legacyKey] = $shortToken;
        }
        $fullName = trim((string)($student['fullName'] ?? ''));
        if ($fullName !== '') {
            $tokens[$fullName] = $shortToken;
        }
        if ($studentId !== '') {
            // 兼容历史前端可能使用的无下划线拼接
            $tokens[$studentId . $name] = $shortToken;
        } else {
            $tokens[$name] = $shortToken;
        }
    }

    // 记录生成批次汇总表 (generation_batches)
    if ($batchId && $validStudentCount > 0) {
        try {
            $db->execute(
                "INSERT INTO generation_batches (`batch_code`, `class_id`, `week_num`, `student_count`, `error_student_count`, `source_files`, `created_by`, `created_at`) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())",
                [$batchCode, $batchId, $week, $validStudentCount, $errorStudentCount, $sourceFilesJson, $currentTeacher]
            );
        } catch (Throwable $e) {
            if ($pdo && $pdo->inTransaction()) {
                $pdo->rollBack();
            }
            error_log("DB generation_batches insert error: " . $e->getMessage());
            http_response_code(500);
            echo json_encode([
                'success' => false,
                'error' => '生成批次记录失败，操作已回滚'
            ], JSON_UNESCAPED_UNICODE);
            exit;
        }
    }

    // 提交数据库事务
    if ($pdo && $pdo->inTransaction()) {
        $pdo->commit();
    }

    // 原子更新班级历史错题档案 ($historyFile) 并加排他锁 (flock LOCK_EX)
    if (!empty($batchHistoryUpdates)) {
        $fp = @fopen($historyFile, 'c+');
        if ($fp) {
            if (flock($fp, LOCK_EX)) {
                $content = '';
                while (!feof($fp)) {
                    $content .= fread($fp, 8192);
                }
                $existingHistory = json_decode($content, true) ?: [];
                foreach ($batchHistoryUpdates as $stKey => $weekUpdates) {
                    if (!isset($existingHistory[$stKey])) {
                        $existingHistory[$stKey] = [];
                    }
                    foreach ($weekUpdates as $wk => $errs) {
                        if (empty($errs)) {
                            unset($existingHistory[$stKey][(string)$wk]);
                            $stName = $batchNameMap[$stKey] ?? '';
                            if ($stName !== '' && isset($existingHistory[$stName][(string)$wk])) {
                                unset($existingHistory[$stName][(string)$wk]);
                            }
                            if (empty($existingHistory[$stKey])) {
                                unset($existingHistory[$stKey]);
                            }
                        } else {
                            $existingHistory[$stKey][(string)$wk] = $errs;
                        }
                    }
                }
                $historyOutput = !empty($existingHistory) ? $existingHistory : (object)[];
                ftruncate($fp, 0);
                rewind($fp);
                fwrite($fp, json_encode($historyOutput, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
                fflush($fp);
                flock($fp, LOCK_UN);
            }
            fclose($fp);
        }
    }

    // 原子更新预习错题档案 ($previewHistoryFile)：与课后巩固档案分开，避免两类错题混写
    if (!empty($batchPreviewHistoryUpdates)) {
        $fp = @fopen($previewHistoryFile, 'c+');
        if ($fp) {
            if (flock($fp, LOCK_EX)) {
                $content = '';
                while (!feof($fp)) {
                    $content .= fread($fp, 8192);
                }
                $existingPreviewHistory = json_decode($content, true) ?: [];
                foreach ($batchPreviewHistoryUpdates as $stKey => $weekUpdates) {
                    if (!isset($existingPreviewHistory[$stKey])) {
                        $existingPreviewHistory[$stKey] = [];
                    }
                    foreach ($weekUpdates as $wk => $previewEntry) {
                        $previewErrs = $previewEntry['errors'] ?? [];
                        if (empty($previewErrs)) {
                            unset($existingPreviewHistory[$stKey][(string)$wk]);
                            if (empty($existingPreviewHistory[$stKey])) {
                                unset($existingPreviewHistory[$stKey]);
                            }
                        } else {
                            $existingPreviewHistory[$stKey][(string)$wk] = [
                                'errors' => $previewErrs,
                                'previewWeek' => intval($previewEntry['previewWeek'] ?? $week)
                            ];
                        }
                    }
                }
                $previewHistoryOutput = !empty($existingPreviewHistory) ? $existingPreviewHistory : (object)[];
                ftruncate($fp, 0);
                rewind($fp);
                fwrite($fp, json_encode($previewHistoryOutput, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
                fflush($fp);
                flock($fp, LOCK_UN);
            }
            fclose($fp);
        }
    }

    // 原子更新短 Token 映射表 ($tokenMapFile) 并加排他锁 (flock LOCK_EX)
    if (!empty($batchTokenMapEntries)) {
        $fp = @fopen($tokenMapFile, 'c+');
        if ($fp) {
            if (flock($fp, LOCK_EX)) {
                $content = '';
                while (!feof($fp)) {
                    $content .= fread($fp, 8192);
                }
                $existingTokenMap = json_decode($content, true) ?: [];
                foreach ($batchTokenMapEntries as $tok => $entry) {
                    $existingTokenMap[$tok] = $entry;
                }
                $tokenMapOutput = !empty($existingTokenMap) ? $existingTokenMap : (object)[];
                ftruncate($fp, 0);
                rewind($fp);
                fwrite($fp, json_encode($tokenMapOutput, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
                fflush($fp);
                flock($fp, LOCK_UN);
            }
            fclose($fp);
        }
    }

    // 记录生成反馈的审计日志
    if (function_exists('recordServerLog')) {
        recordServerLog('action', 'retest', 'generate_feedback', [
            'batch_code'    => $batchCode,
            'class_name'    => $className,
            'subject'       => $subject,
            'grade'         => $grade,
            'tier'          => $tier,
            'week'          => $week,
            'student_count' => count($input['students'])
        ], [
            'operator' => $currentTeacher
        ]);
    }

    echo json_encode([
        'success' => true,
        'batch_code' => $batchCode,
        'tokens' => $tokens
    ]);
    exit;
}

if ($action === 'decrypt') {
    $rawToken = '';
    $inputName = '';
    $inputCaptcha = '';

    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $postInput = json_decode(file_get_contents('php://input'), true) ?: [];
        $rawToken = trim($postInput['token'] ?? ($_GET['token'] ?? ''));
        $inputName = trim($postInput['studentName'] ?? ($_GET['name'] ?? ''));
        $inputCaptcha = trim($postInput['captcha'] ?? ($_GET['captcha'] ?? ''));
    } else {
        $rawToken = trim($_GET['token'] ?? '');
        $inputName = trim($_GET['name'] ?? '');
        $inputCaptcha = trim($_GET['captcha'] ?? '');
    }

    if (empty($rawToken)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => '缺少访问凭证（Token）']);
        exit;
    }

    $tokenMapFile = $historyDir . '/token_map.json';
    $tokenMap = file_exists($tokenMapFile) ? (json_decode(file_get_contents($tokenMapFile), true) ?: []) : [];

    $data = null;
    if (isset($tokenMap[$rawToken])) {
        // 1. 优先从短 Token 索引中解析
        $data = $tokenMap[$rawToken];
    } else {
        // 2. 兼容旧版 AES-256 长 Token
        $token = str_replace(['-', '_'], ['+', '/'], $rawToken);
        $mod4 = strlen($token) % 4;
        if ($mod4) {
            $token .= substr('====', $mod4);
        }

        $decoded = base64_decode($token);
        $ivlen = openssl_cipher_iv_length($cipherAlgo);
        if ($decoded !== false && strlen($decoded) > $ivlen) {
            $iv = substr($decoded, 0, $ivlen);
            $ciphertext = substr($decoded, $ivlen);
            $decrypted = openssl_decrypt($ciphertext, $cipherAlgo, $secretKey, 0, $iv);
            if ($decrypted !== false) {
                $data = json_decode($decrypted, true);
            }
        }
    }

    if (!$data) {
        // 3. 回退从 MySQL student_records 表中查找
        try {
            $db = Database::getInstance();
            $record = $db->fetchOne(
                "SELECT sr.*, cb.year, cb.season, cb.grade, cb.tier, cb.subject
                 FROM student_records sr
                 JOIN class_batches cb ON sr.batch_id = cb.id
                 WHERE sr.retest_token = ? LIMIT 1",
                [$rawToken]
            );
            if ($record) {
                $data = [
                    's' => $record['subject'],
                    'g' => $record['grade'],
                    't' => $record['tier'],
                    'w' => (int)$record['week_num'],
                    'n' => $record['student_name'],
                    'k' => $record['student_key'],
                    'id' => $record['student_id'] ?: '',
                    'year' => (int)$record['year'],
                    'season' => $record['season'],
                    'u' => strtotime($record['created_at'])
                ];
            }
        } catch (Throwable $e) {
            error_log("DB lookup error: " . $e->getMessage());
        }
    }

    if (!$data) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => '链接无效或已过期']);
        exit;
    }

    // 黑名单吊销检查（失败前置：被作废的链接连核验门都不展示）
    $revokedMap = loadRevokedTokens();
    if (isset($revokedMap[$rawToken])) {
        logRetestAccess($rawToken, $data['n'] ?? '', 'access_revoked', '链接已被作废');
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => '该错题本链接已被老师作废，请联系老师重新获取'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 基础信息
    $subject = $data['s'] ?? '';
    $grade = $data['g'] ?? '';
    $tier = $data['t'] ?? '';
    $currWeek = intval($_GET['w'] ?? ($data['w'] ?? 0));
    $hasExplicitWeek = isset($_GET['w']) && intval($_GET['w']) > 0;
    $studentName = trim($data['n'] ?? '');
    $studentKey = trim($data['k'] ?? $studentName);
    $studentId = trim($data['id'] ?? '');
    // 兼容极旧的长 Token：未存 id 字段时，从 k 的旧格式 "学号_姓名" 前缀还原学号
    if ($studentId === '' && preg_match('/^(\d+)_/u', $studentKey, $kvMatch)) {
        $studentId = $kvMatch[1];
    }
    $studentKeyCandidates = student_key_candidates($studentId, $studentName, $grade, $subject);
    if (empty($studentKeyCandidates)) {
        $studentKeyCandidates = [(string)$studentKey];
    }
    // Token 内的 q/pq/pw 只对签发时的周次有效，切换到历史周时不能复用
    $tokenWeek = intval($data['w'] ?? 0);
    $currErrors = [];
    $tokenYear = intval($data['year'] ?? 0);
    $tokenSeason = trim($data['season'] ?? '');

    // 身份验证检查（学生姓名 + 图形验证码）
    $sessionKey = 'verified_token_' . md5($rawToken);
    $verifiedIdentity = (string)($_SESSION[$sessionKey] ?? '');
    $isSessionVerified = $verifiedIdentity !== ''
        && in_array($verifiedIdentity, array_merge([$studentName], $studentKeyCandidates), true);

    // 管理员免密直通判定（通过签名或后台已登录会话）
    if (!$isSessionVerified) {
        $adminSig = trim($_GET['admin_sig'] ?? '');
        $adminTs = intval($_GET['admin_ts'] ?? 0);
        $isAdminAuthorized = false;
        if (!empty($adminSig)) {
            // 仅接受带时间戳的签名（24小时有效期：86400秒）。
            // 安全基线：不带 admin_ts 的旧版签名已彻底移除。保留该分支等于留下
            // 一个永久有效的免密后门——任何历史签发的链接都无法再被作废。
            if ($adminTs > 0 && abs(time() - $adminTs) <= 86400) {
                $expectedSigWithTs = hash_hmac('sha256', "{$rawToken}_{$adminTs}", $secretKey);
                if (hash_equals($expectedSigWithTs, $adminSig)) {
                    $isAdminAuthorized = true;
                }
            }
        }
        // 独立判断：管理员会话豁免不应受 admin_sig 是否存在或其是否合法的影响
        if (!$isAdminAuthorized && isset($_SESSION['admin_logged_in']) && $_SESSION['admin_logged_in'] === true) {
            $isAdminAuthorized = true;
        }

        if ($isAdminAuthorized) {
            $isSessionVerified = true;
            $_SESSION[$sessionKey] = $studentKeyCandidates[0] ?? $studentKey;
            logRetestAccess($rawToken, $studentName . ' (管理员直通)', 'admin_bypass', '管理员免密查看');
        }
    }

    if (!$isSessionVerified) {
        // 如果未提交姓名或未提交验证码，提示前端弹出身份验证门禁
        if (empty($inputName) && empty($inputCaptcha)) {
            echo json_encode([
                'success' => false,
                'needVerify' => true,
                'error' => '请先输入学生姓名和图形验证码以验证身份'
            ], JSON_UNESCAPED_UNICODE);
            exit;
        }

        // 1. 验证图形验证码
        $savedCaptcha = strtolower($_SESSION['retest_captcha'] ?? '');
        unset($_SESSION['retest_captcha']); // 一次性验证码作废防重放

        if (empty($savedCaptcha) || strtolower($inputCaptcha) !== $savedCaptcha) {
            logRetestAccess($rawToken, $inputName, 'verify_fail', '图形验证码错误');
            echo json_encode([
                'success' => false,
                'needVerify' => true,
                'error' => '图形验证码错误或已失效，请点击图片刷新重试',
                'captchaError' => true
            ], JSON_UNESCAPED_UNICODE);
            exit;
        }

        // 2. 验证学生姓名（去除首尾及中间多余空格与全角空格，忽略英文大小写）
        $cleanInputName = str_replace(["\xe3\x80\x80", ' ', "\t", "\r", "\n"], '', trim($inputName));
        $cleanTargetName = str_replace(["\xe3\x80\x80", ' ', "\t", "\r", "\n"], '', trim($studentName));
        $cleanStudentKey = str_replace(["\xe3\x80\x80", ' ', "\t", "\r", "\n"], '', trim($studentKey));
        if (function_exists('mb_strtolower')) {
            $cleanInputName = mb_strtolower($cleanInputName, 'UTF-8');
            $cleanTargetName = mb_strtolower($cleanTargetName, 'UTF-8');
            $cleanStudentKey = mb_strtolower($cleanStudentKey, 'UTF-8');
        } else {
            $cleanInputName = strtolower($cleanInputName);
            $cleanTargetName = strtolower($cleanTargetName);
            $cleanStudentKey = strtolower($cleanStudentKey);
        }

        // 允许家长输入纯姓名（如“张三”），或包含学号的完整名字（如“01张三”或“01_张三”）
        $nameMatched = ($cleanInputName === $cleanTargetName)
            || ($cleanInputName === $cleanStudentKey)
            || (!empty($studentId) && $cleanInputName === ($studentId . $cleanTargetName));

        if (!$nameMatched) {
            logRetestAccess($rawToken, $inputName, 'verify_fail', '姓名不匹配: ' . $inputName);
            echo json_encode([
                'success' => false,
                'needVerify' => true,
                'error' => '学生姓名不匹配，请输入该作业对应的学生姓名',
                'nameError' => true
            ], JSON_UNESCAPED_UNICODE);
            exit;
        }

        // 验证通过，记录到当前会话中，并记录日志
        $_SESSION[$sessionKey] = $studentKeyCandidates[0] ?? $studentKey;
        logRetestAccess($rawToken, $studentName, 'verify_success', "第 {$currWeek} 周");
    } else {
        // 会话已验证，记录访问轨迹
        if (isset($_GET['w'])) {
            logRetestAccess($rawToken, $studentName, 'switch_week', "切换至第 {$currWeek} 周");
        } else {
            logRetestAccess($rawToken, $studentName, 'view_page', "第 {$currWeek} 周");
        }
    }

    // 检索该学生的历史记录
    // 新写入落在 `学科_年级.json`；旧数据仍在 `学科_年级_班型.json`。
    // 这里把全部相关档案合并读取，学生换班型后历史保持连续。
    $studentHistory = [];
    $historyWeekTiers = [];
    $historyByTier = [];
    $tierlessWeeks = [];
    $historyFiles = [];
    $tierlessHistoryFile = $historyDir . '/' . rawurlencode($subject) . '_' . rawurlencode($grade) . '.json';
    if (is_file($tierlessHistoryFile)) {
        $historyFiles[] = $tierlessHistoryFile;
    }
    $legacyHistoryFiles = glob($historyDir . '/' . rawurlencode($subject) . '_' . rawurlencode($grade) . '_*.json') ?: [];
    // 新的档案优先；旧班型档案按修改时间从新到旧合并
    usort($legacyHistoryFiles, static function ($a, $b) {
        return (filemtime($b) ?: 0) <=> (filemtime($a) ?: 0);
    });
    $historyFiles = array_merge($historyFiles, $legacyHistoryFiles);
    foreach ($historyFiles as $hf) {
        // 预习档案结构不同，由下方单独的 previewHistory 逻辑读取
        if (substr(basename($hf), -strlen('_preview.json')) === '_preview.json') continue;
        $rawHistory = @file_get_contents($hf);
        if ($rawHistory === false) continue;
        $historyData = json_decode($rawHistory, true);
        if (!is_array($historyData)) continue;
        // 旧档案文件名末尾带班型：用于在数据库缺行时仍按原班型定位 PDF
        $hfParts = explode('_', basename($hf, '.json'));
        $hfTier = count($hfParts) >= 3 ? rawurldecode(implode('_', array_slice($hfParts, 2))) : '';
        foreach (merge_history_for_keys($historyData, $studentKeyCandidates) as $histWeek => $histErrors) {
            $histWeek = (string)$histWeek;
            if (!array_key_exists($histWeek, $studentHistory)) {
                $studentHistory[$histWeek] = $histErrors;
            }
            if ($hfTier !== '') {
                if (!isset($historyByTier[$hfTier][$histWeek])) {
                    $historyByTier[$hfTier][$histWeek] = $histErrors;
                }
            } else {
                // 无班型后缀的是迁移后新写入的档案，优先级最高
                $tierlessWeeks[$histWeek] = true;
            }
            if ($hfTier !== '' && !isset($historyWeekTiers[$histWeek])) {
                $historyWeekTiers[$histWeek] = $hfTier;
            }
        }
    }

    // 预习错题历史档案：结构与课后巩固分开，按“课后巩固周次”关联，内部记录预习周次
    $previewHistory = [];
    $previewHistoryFile = $historyDir . '/' . rawurlencode($subject) . '_' . rawurlencode($grade) . '_preview.json';
    if (is_file($previewHistoryFile)) {
        $previewHistoryData = json_decode((string)@file_get_contents($previewHistoryFile), true);
        if (is_array($previewHistoryData)) {
            foreach ($studentKeyCandidates as $candidateKey) {
                if (empty($previewHistoryData[$candidateKey]) || !is_array($previewHistoryData[$candidateKey])) continue;
                foreach ($previewHistoryData[$candidateKey] as $previewWeekKey => $previewEntry) {
                    $pErrs = [];
                    $pWeek = intval($previewWeekKey);
                    if (is_array($previewEntry) && array_key_exists('errors', $previewEntry)) {
                        $pErrs = is_array($previewEntry['errors']) ? $previewEntry['errors'] : [];
                        $pWeek = intval($previewEntry['previewWeek'] ?? $previewWeekKey);
                    } elseif (is_array($previewEntry)) {
                        $pErrs = $previewEntry;
                    }
                    if (!isset($previewHistory[(string)$previewWeekKey])) {
                        $previewHistory[(string)$previewWeekKey] = [
                            'errors' => array_values(array_unique(array_filter(array_map('intval', $pErrs)))),
                            'previewWeek' => $pWeek > 0 ? $pWeek : intval($previewWeekKey)
                        ];
                    }
                }
            }
        }
    }
    // 预习错题在数据库查询后按“预习周次”统一归档，见下方 $previewByTopic

    // 尝试从 MySQL student_records 查询该学生的历史周次数据及成绩评语进行双向融合
    // 匹配只认身份 Key（新/旧格式），不再按姓名 OR 匹配，杜绝同名学生串档；
    // 仅无学号旧数据允许受控的姓名兜底。
    $dbStudentScores = [];
    $dbPreviewData = [];
    $dbWeekAverages = [];
    $dbWeekAveragesByBatch = [];
    $dbWeekTiers = [];
    $dbWeekBatchIds = [];
    try {
        $db = Database::getInstance();
        $keyPlaceholders = implode(',', array_fill(0, count($studentKeyCandidates), '?'));
        $dbWhere = "cb.subject = ? AND cb.grade = ? AND (sr.student_key IN ($keyPlaceholders)";
        $dbParams = array_merge([$subject, $grade], $studentKeyCandidates);
        if ($studentId === '') {
            $dbWhere .= " OR ((sr.student_key IS NULL OR sr.student_key = '' OR sr.student_key = sr.student_name) AND sr.student_name = ?)";
            $dbParams[] = $studentName;
        }
        $dbWhere .= ")";
        $dbRecords = $db->fetchAll(
            "SELECT sr.batch_id, sr.week_num, sr.preview_week_num, sr.homework_score, sr.preview_score, sr.total_score, sr.teacher_comment, sr.preview_comment, sr.error_questions, sr.preview_error_questions, cb.tier AS batch_tier
             FROM student_records sr
             JOIN class_batches cb ON sr.batch_id = cb.id
             WHERE {$dbWhere}
             ORDER BY sr.updated_at ASC, sr.id ASC",
            $dbParams
        );
        if (!empty($dbRecords)) {
            foreach ($dbRecords as $r) {
                $wn = (int)$r['week_num'];
                $eq = json_decode($r['error_questions'], true);
                if (!isset($studentHistory[(string)$wn])) {
                    $studentHistory[(string)$wn] = is_array($eq) ? array_values(array_unique(array_filter(array_map('intval', $eq)))) : [];
                }
                $peq = json_decode($r['preview_error_questions'] ?? 'null', true);
                $dbPreviewData[(string)$wn] = [
                    'errors' => is_array($peq) ? array_values(array_unique(array_filter(array_map('intval', $peq)))) : [],
                    'previewWeek' => intval($r['preview_week_num'] ?? 0) > 0 ? intval($r['preview_week_num']) : $wn,
                    'previewScore' => $r['preview_score'],
                    'previewComment' => $r['preview_comment'] ?? '',
                    'sourceWeek' => (int)$wn,
                    // 该行是否真的携带预习数据：空行不能覆盖其它作业关联过来的预习
                    'hasPreview' => ($r['preview_week_num'] !== null || $r['preview_error_questions'] !== null)
                ];
                $dbStudentScores[(string)$wn] = [
                    'homeworkScore' => $r['homework_score'],
                    'previewScore' => $r['preview_score'],
                    'totalScore' => $r['total_score'],
                    'comment' => $r['teacher_comment'],
                    'previewComment' => $r['preview_comment'] ?? ''
                ];
                $dbWeekTiers[(string)$wn] = trim((string)($r['batch_tier'] ?? ''));
                $dbWeekBatchIds[(string)$wn] = (int)$r['batch_id'];
            }

            // 计算该学生所在班级在各周次的平均巩固分
            // 口径与家长文案一致（viewer.js）：剔除 0 分、逐个分数先取整再平均
            $batchIds = array_values(array_unique(array_filter(array_column($dbRecords, 'batch_id'))));
            if (!empty($batchIds)) {
                $placeholders = implode(',', array_fill(0, count($batchIds), '?'));
                $avgRows = $db->fetchAll(
                    "SELECT batch_id, week_num, ROUND(AVG(ROUND(homework_score)), 1) as avg_score
                     FROM student_records
                     WHERE batch_id IN ($placeholders) AND homework_score IS NOT NULL AND homework_score > 0
                     GROUP BY batch_id, week_num",
                    $batchIds
                );
                foreach ($avgRows as $ar) {
                    $dbWeekAveragesByBatch[(int)$ar['batch_id'] . ':' . (int)$ar['week_num']] = (float)$ar['avg_score'];
                    $dbWeekAverages[(string)$ar['week_num']] = (float)$ar['avg_score'];
                }
            }
        }

        // 兜底：若班级没有平均分，则按同科目年级班型查询
        if (empty($dbWeekAverages)) {
            $avgRows = $db->fetchAll(
                "SELECT sr.week_num, ROUND(AVG(ROUND(sr.homework_score)), 1) as avg_score
                 FROM student_records sr
                 JOIN class_batches cb ON sr.batch_id = cb.id
                 WHERE cb.subject = ? AND cb.grade = ? AND cb.tier = ? AND sr.homework_score IS NOT NULL AND sr.homework_score > 0
                 GROUP BY sr.week_num",
                [$subject, $grade, $tier]
            );
            foreach ($avgRows as $ar) {
                $dbWeekAverages[(string)$ar['week_num']] = (float)$ar['avg_score'];
            }
        }
    } catch (Throwable $e) {
        error_log("DB studentHistory query error: " . $e->getMessage());
    }

    // 同一周可能在多个班型都有记录：以数据库中最新的班型为准，
    // 优先采用该班型历史档案中的错题，避免多个档案 mtime 相同导致取值不确定。
    foreach ($dbWeekTiers as $dbWeek => $dbTier) {
        $dbWeek = (string)$dbWeek;
        if ($dbTier === '' || isset($tierlessWeeks[$dbWeek])) continue;
        if (isset($historyByTier[$dbTier][$dbWeek])) {
            $studentHistory[$dbWeek] = $historyByTier[$dbTier][$dbWeek];
        }
    }

    // 如果未指定有效当前周，默认采用历史记录中的最大周次
    if ($currWeek <= 0 && !empty($studentHistory)) {
        $currWeek = max(array_map('intval', array_keys($studentHistory)));
    }

    // 预习错题按“预习周次”重新归档：教师可以把专题二的预习随专题一作业一起生成，
    // 错题本中必须落在专题二，不能串到专题一。数据库优先于文件档案。
    $previewByTopic = [];
    foreach ($dbPreviewData as $wn => $entry) {
        if (empty($entry['hasPreview'])) continue;
        $topic = intval($entry['previewWeek'] ?? 0);
        if ($topic <= 0) $topic = intval($wn);
        $entry['topic'] = $topic;
        $entry['tier'] = trim((string)($dbWeekTiers[(string)$wn] ?? ''));
        $previewByTopic[$topic] = $entry;
    }
    foreach ($previewHistory as $previewWeekKey => $entry) {
        $topic = intval($entry['previewWeek'] ?? 0);
        if ($topic <= 0) $topic = intval($previewWeekKey);
        if (!isset($previewByTopic[$topic])) {
            $entry['topic'] = $topic;
            $entry['sourceWeek'] = intval($previewWeekKey);
            $previewByTopic[$topic] = $entry;
        }
    }

    // Token 内的当前周数据只在访问签发周次时生效
    $useTokenWeek = ($tokenWeek <= 0 || $currWeek === $tokenWeek);
    $tokenCurrentErrors = ($useTokenWeek && is_array($data['q'] ?? null)) ? $data['q'] : [];
    $tokenPreviewErrors = ($useTokenWeek && is_array($data['pq'] ?? null)) ? $data['pq'] : [];
    $tokenPreviewWeek = $useTokenWeek ? intval($data['pw'] ?? 0) : 0;
    if ($tokenPreviewWeek <= 0) $tokenPreviewWeek = $currWeek;

    // 即使课后巩固没有错题，只要预习有错题，也让该预习专题单独出现在错题本中
    foreach ($previewByTopic as $topic => $entry) {
        if (!empty($entry['errors']) && !isset($studentHistory[(string)$topic])) {
            $studentHistory[(string)$topic] = [];
        }
    }
    // Token 兜底：数据库与预习档案都没有该预习周时，用 Token 内数据补齐
    if (!empty($tokenPreviewErrors) && !isset($previewByTopic[$tokenPreviewWeek])) {
        $previewByTopic[$tokenPreviewWeek] = [
            'errors' => array_values(array_unique(array_filter(array_map('intval', $tokenPreviewErrors)))),
            'previewWeek' => $tokenPreviewWeek,
            'tier' => $tier
        ];
        if (!isset($studentHistory[(string)$tokenPreviewWeek])) {
            $studentHistory[(string)$tokenPreviewWeek] = [];
        }
    }

    // 默认预览专题：优先找与当前周同一次生成关联的预习；否则用 Token 内的预习周次
    $defaultPreviewTopic = 0;
    foreach ($previewByTopic as $topic => $entry) {
        if (intval($entry['sourceWeek'] ?? 0) === $currWeek && !empty($entry['errors'])) {
            $defaultPreviewTopic = intval($topic);
        }
    }
    if ($defaultPreviewTopic <= 0 && !empty($previewByTopic[$tokenPreviewWeek]['errors'] ?? [])) {
        $defaultPreviewTopic = $tokenPreviewWeek;
    }

    // 默认打开有内容的专题：巩固无错题但本次预习属于其它专题时，直接切到预习专题
    if (!$hasExplicitWeek && $useTokenWeek
        && empty($studentHistory[(string)$currWeek])
        && empty($tokenCurrentErrors)
        && empty($previewByTopic[$currWeek]['errors'] ?? [])
        && $defaultPreviewTopic > 0
        && $defaultPreviewTopic !== $currWeek) {
        $currWeek = $defaultPreviewTopic;
        $useTokenWeek = ($currWeek === $tokenWeek);
    }

    // 若历史库已有该周错题，优先采用历史库数据；否则仅在同周 Token 数据有效时兜底
    if (isset($studentHistory[(string)$currWeek])) {
        $currErrors = $studentHistory[(string)$currWeek];
    } elseif ($currWeek > 0 && $useTokenWeek && !empty($tokenCurrentErrors)) {
        $currErrors = $tokenCurrentErrors;
        $studentHistory[(string)$currWeek] = $currErrors;
    } else {
        $currErrors = [];
    }

    // 按周次升序排列
    uksort($studentHistory, function($a, $b) {
        return intval($a) - intval($b);
    });

    $weeksData = [];
    foreach ($studentHistory as $weekStr => $errors) {
        $wNum = intval($weekStr);
        // 历史周次可能属于旧班型：按该周实际所在班型取 PDF，保证换班后旧周错题仍可下载
        $weekTier = $dbWeekTiers[(string)$wNum] ?? '';
        if ($weekTier === '') $weekTier = $historyWeekTiers[(string)$wNum] ?? '';
        if ($weekTier === '') $weekTier = $tier;
        $pdfList = getWeekPdfs($qbankDir, $subject, $grade, $weekTier, $wNum, $errors, $tokenYear, $tokenSeason, 'homework');

        $previewEntry = $previewByTopic[$wNum] ?? null;
        $previewErrors = is_array($previewEntry['errors'] ?? null) ? $previewEntry['errors'] : [];
        $previewWeekNum = $wNum;
        $previewTier = trim((string)($previewEntry['tier'] ?? ''));
        if ($previewTier === '') $previewTier = $weekTier;
        $previewErrors = array_values(array_unique(array_filter(array_map('intval', $previewErrors))));
        $previewPdfList = !empty($previewErrors)
            ? getWeekPdfs($qbankDir, $subject, $grade, $previewTier, $previewWeekNum, $previewErrors, $tokenYear, $tokenSeason, 'preview')
            : [];

        $wEntry = [
            'week' => $wNum,
            'errors' => $errors,
            'pdfs' => $pdfList,
            'previewErrors' => $previewErrors,
            'previewPdfs' => $previewPdfList,
            'previewWeek' => $previewWeekNum,
            'previewScore' => $previewEntry['previewScore'] ?? null,
            'previewComment' => $previewEntry['previewComment'] ?? '',
            'homeworkScore' => null,
            'avgScore' => null
        ];
        if (isset($dbStudentScores[(string)$wNum])) {
            $hw = $dbStudentScores[(string)$wNum]['homeworkScore'];
            $wEntry['homeworkScore'] = ($hw !== null && $hw !== '') ? (float)$hw : null;
            $wEntry['totalScore'] = $dbStudentScores[(string)$wNum]['totalScore'];
            $wEntry['comment'] = $dbStudentScores[(string)$wNum]['comment'];
        }
        $cm = $wEntry['comment'] ?? '';
        $isUnsub = (!empty($cm) && (mb_strpos($cm, '未交') !== false || mb_strpos($cm, '未提交') !== false || mb_strpos($cm, '缺交') !== false))
            || (empty($errors) && empty($previewErrors) && ($wEntry['homeworkScore'] === null || $wEntry['homeworkScore'] <= 0));
        $wEntry['isUnsubmitted'] = $isUnsub;
        $weekBatchId = $dbWeekBatchIds[(string)$wNum] ?? 0;
        if ($weekBatchId > 0 && isset($dbWeekAveragesByBatch[$weekBatchId . ':' . $wNum])) {
            $wEntry['avgScore'] = $dbWeekAveragesByBatch[$weekBatchId . ':' . $wNum];
        } elseif (isset($dbWeekAverages[(string)$wNum])) {
            $wEntry['avgScore'] = $dbWeekAverages[(string)$wNum];
        }
        $weeksData[(string)$wNum] = $wEntry;
    }

    // 兜底（如果没有任何周次数据，至少放当前周）
    if (empty($weeksData) && $currWeek > 0) {
        $currWeekTier = (($dbWeekTiers[(string)$currWeek] ?? '') ?: (($historyWeekTiers[(string)$currWeek] ?? '') ?: $tier));
        $fallbackPreviewEntry = $previewByTopic[$currWeek] ?? null;
        $fallbackPreviewErrors = is_array($fallbackPreviewEntry['errors'] ?? null) ? $fallbackPreviewEntry['errors'] : [];
        $fallbackPreviewTier = trim((string)($fallbackPreviewEntry['tier'] ?? ''));
        if ($fallbackPreviewTier === '') $fallbackPreviewTier = $currWeekTier;
        $wEntry = [
            'week' => $currWeek,
            'errors' => $currErrors,
            'pdfs' => getWeekPdfs($qbankDir, $subject, $grade, $currWeekTier, $currWeek, $currErrors, $tokenYear, $tokenSeason, 'homework'),
            'previewErrors' => $fallbackPreviewErrors,
            'previewPdfs' => !empty($fallbackPreviewErrors) ? getWeekPdfs($qbankDir, $subject, $grade, $fallbackPreviewTier, $currWeek, $fallbackPreviewErrors, $tokenYear, $tokenSeason, 'preview') : [],
            'previewWeek' => $currWeek,
            'previewScore' => $fallbackPreviewEntry['previewScore'] ?? null,
            'previewComment' => $fallbackPreviewEntry['previewComment'] ?? '',
            'homeworkScore' => null,
            'avgScore' => null
        ];
        if (isset($dbStudentScores[(string)$currWeek])) {
            $hw = $dbStudentScores[(string)$currWeek]['homeworkScore'];
            $wEntry['homeworkScore'] = ($hw !== null && $hw !== '') ? (float)$hw : null;
            $wEntry['totalScore'] = $dbStudentScores[(string)$currWeek]['totalScore'];
            $wEntry['comment'] = $dbStudentScores[(string)$currWeek]['comment'];
        }
        $cm = $wEntry['comment'] ?? '';
        $isUnsub = (!empty($cm) && (mb_strpos($cm, '未交') !== false || mb_strpos($cm, '未提交') !== false || mb_strpos($cm, '缺交') !== false))
            || (empty($currErrors) && empty($fallbackPreviewErrors) && ($wEntry['homeworkScore'] === null || $wEntry['homeworkScore'] <= 0));
        $wEntry['isUnsubmitted'] = $isUnsub;
        if (isset($dbWeekAverages[(string)$currWeek])) {
            $wEntry['avgScore'] = $dbWeekAverages[(string)$currWeek];
        }
        $weeksData[(string)$currWeek] = $wEntry;
    }

    $availableWeeks = array_map('intval', array_keys($weeksData));
    sort($availableWeeks);

    // 读取系统题隙配置与二维码开关并回传给前端，防止客户端静态文件缓存
    $retestQuestionSpacing = 26;
    $retestQrCodeEnabled = true;
    if (file_exists($configFile)) {
        $cfgJson = json_decode(file_get_contents($configFile), true);
        if (isset($cfgJson['retestQuestionSpacing'])) {
            $retestQuestionSpacing = max(10, min(260, (int)$cfgJson['retestQuestionSpacing']));
        }
        if (isset($cfgJson['retestQrCodeEnabled'])) {
            $retestQrCodeEnabled = (bool)$cfgJson['retestQrCodeEnabled'];
        }
    }

    header('Cache-Control: no-cache, no-store, must-revalidate');
    header('Pragma: no-cache');
    header('Expires: 0');

    echo json_encode([
        'success' => true,
        'data' => $data,
        'currentWeek' => $currWeek,
        'availableWeeks' => $availableWeeks,
        'weeksData' => $weeksData,
        'retestQuestionSpacing' => $retestQuestionSpacing,
        'retestQrCodeEnabled' => $retestQrCodeEnabled,
        'pdfs' => $weeksData[(string)$currWeek]['pdfs'] ?? [], // 保持旧版兼容
        'previewPdfs' => $weeksData[(string)$currWeek]['previewPdfs'] ?? [],
        'previewErrors' => $weeksData[(string)$currWeek]['previewErrors'] ?? []
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

/**
 * 接收客户端合成的 PDF 并暂存为服务端真实文件（专为微信/移动端下载优化）
 */
if ($action === 'create_temp_download') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        http_response_code(405);
        echo json_encode(['success' => false, 'error' => 'Method Not Allowed']);
        exit;
    }

    // 1. 严格身份鉴权：必须持有已核验的学生 Token 会话或处于登录态（教师/管理员）
    $token = trim($_POST['token'] ?? ($_GET['token'] ?? ''));
    $isTokenVerified = !empty($token) && !empty($_SESSION['verified_token_' . md5($token)]);
    $isUserAuth = isLoggedIn();

    if (!$isTokenVerified && !$isUserAuth) {
        http_response_code(401);
        echo json_encode(['success' => false, 'error' => '未授权的下载请求：请先通过学生身份验证'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 2. 频控限制：单会话每小时最多生成 30 个临时下载文件
    $tempDownloadCount = $_SESSION['temp_download_count'] ?? 0;
    $tempDownloadTime = $_SESSION['temp_download_time'] ?? time();
    if (time() - $tempDownloadTime > 3600) {
        $tempDownloadCount = 0;
        $tempDownloadTime = time();
    }
    if ($tempDownloadCount >= 30) {
        http_response_code(429);
        echo json_encode(['success' => false, 'error' => '生成下载文件过于频繁，请稍后再试'], JSON_UNESCAPED_UNICODE);
        exit;
    }
    $_SESSION['temp_download_count'] = $tempDownloadCount + 1;
    $_SESSION['temp_download_time'] = $tempDownloadTime;

    $uploadedFile = null;
    $fileName = '';

    if (isset($_FILES['file']) && $_FILES['file']['error'] === UPLOAD_ERR_OK) {
        $uploadedFile = $_FILES['file']['tmp_name'];
        $fileName = $_POST['filename'] ?? $_FILES['file']['name'] ?? '错题本.pdf';
    } else {
        $raw = file_get_contents('php://input');
        if (!empty($raw) && strlen($raw) > 10) {
            $tmpPath = tempnam(sys_get_temp_dir(), 'retest_');
            file_put_contents($tmpPath, $raw);
            $uploadedFile = $tmpPath;
            $fileName = $_GET['filename'] ?? '错题本.pdf';
        }
    }

    if (!$uploadedFile || !file_exists($uploadedFile)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => '未检测到有效的 PDF 文件流']);
        exit;
    }

    // 3. 文件体积安全限制：单文件严禁超过 25MB
    if (filesize($uploadedFile) > 25 * 1024 * 1024) {
        @unlink($uploadedFile);
        http_response_code(413);
        echo json_encode(['success' => false, 'error' => '文件大小超出限制（最大 25MB）'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 4. 校验 PDF 头部魔数 %PDF
    $handle = fopen($uploadedFile, 'rb');
    $header = fread($handle, 4);
    fclose($handle);
    if ($header !== '%PDF') {
        @unlink($uploadedFile);
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => '文件非合法 PDF 格式']);
        exit;
    }

    // 生成安全随机 Key
    $fileKey = bin2hex(random_bytes(16));
    $targetPath = $tempDir . '/' . $fileKey . '.pdf';
    $metaPath = $tempDir . '/' . $fileKey . '.json';

    if (is_uploaded_file($uploadedFile)) {
        move_uploaded_file($uploadedFile, $targetPath);
    } else {
        copy($uploadedFile, $targetPath);
        @unlink($uploadedFile);
    }

    $cleanFileName = preg_replace('/[\\\\\/:\*\?"<>\|]/', '_', trim($fileName));
    if (!str_ends_with(strtolower($cleanFileName), '.pdf')) {
        $cleanFileName .= '.pdf';
    }

    file_put_contents($metaPath, json_encode([
        'filename' => $cleanFileName,
        'created_at' => time()
    ], JSON_UNESCAPED_UNICODE));

    // 记录临时下载生成审计
    $token = trim($_POST['token'] ?? ($_GET['token'] ?? ''));
    $studentName = trim($_POST['studentName'] ?? ($_GET['studentName'] ?? ''));
    if (empty($studentName) && !empty($token)) {
        $studentName = $_SESSION['verified_token_' . md5($token)] ?? '';
    }
    logRetestAccess($token, $studentName, 'create_temp_download', $cleanFileName);

    // 构造相对与绝对下载直链
    $relativeUrl = 'api/retest.php?action=download_file&key=' . $fileKey . '&fn=' . rawurlencode($cleanFileName) . ($token ? '&token=' . rawurlencode($token) : '');

    $protocol = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off' || ($_SERVER['SERVER_PORT'] ?? 80) == 443) ? "https://" : "http://";
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $scriptName = $_SERVER['SCRIPT_NAME'] ?? '/api/retest.php';
    $fullUrl = $protocol . $host . $scriptName . '?action=download_file&key=' . $fileKey . '&fn=' . rawurlencode($cleanFileName) . ($token ? '&token=' . rawurlencode($token) : '');

    echo json_encode([
        'success' => true,
        'key' => $fileKey,
        'downloadUrl' => $relativeUrl,
        'fullUrl' => $fullUrl,
        'fileName' => $cleanFileName
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

/**
 * 下发暂存的 PDF 文件（带标准 Content-Disposition，支持微信拦截跳转浏览器下载）
 */
if ($action === 'download_file') {
    $fileKey = trim($_GET['key'] ?? '');
    if (!preg_match('/^[a-f0-9]{32}$/', $fileKey)) {
        http_response_code(400);
        die('无效的文件凭证（Invalid Key）');
    }

    $filePath = $tempDir . '/' . $fileKey . '.pdf';
    $metaPath = $tempDir . '/' . $fileKey . '.json';

    if (!file_exists($filePath)) {
        http_response_code(404);
        die('文件不存在或已过期，请返回页面重新生成');
    }

    $fileName = '错题本.pdf';
    $metaCreatedAt = 0;
    if (file_exists($metaPath)) {
        $meta = json_decode(file_get_contents($metaPath), true);
        if (!empty($meta['filename'])) {
            $fileName = $meta['filename'];
        }
        $metaCreatedAt = (int)($meta['created_at'] ?? 0);
    }
    // 临时直链有效期 2 小时：过期即删并提示重建（避免 bearer 链接永久有效）
    if ($metaCreatedAt > 0 && (time() - $metaCreatedAt) > 7200) {
        @unlink($filePath);
        @unlink($metaPath);
        http_response_code(410);
        die('下载链接已过期（有效期2小时），请返回页面重新生成');
    }
    if (!empty($_GET['fn'])) {
        $fileName = trim($_GET['fn']);
    }

    $cleanFileName = preg_replace('/[\\\\\/:\*\?"<>\|]/', '_', $fileName);
    if (!str_ends_with(strtolower($cleanFileName), '.pdf')) {
        $cleanFileName .= '.pdf';
    }

    $token = trim($_GET['token'] ?? '');
    $studentName = '';
    if (!empty($token)) {
        $studentName = $_SESSION['verified_token_' . md5($token)] ?? '';
    }
    logRetestAccess($token, $studentName, 'download_file', $cleanFileName);

    // 清理缓冲区
    while (ob_get_level()) {
        ob_end_clean();
    }

    header('Content-Description: File Transfer');
    header('Content-Type: application/pdf');
    header('Content-Disposition: attachment; filename="' . rawurlencode($cleanFileName) . '"; filename*=UTF-8\'\'' . rawurlencode($cleanFileName));
    header('Content-Transfer-Encoding: binary');
    header('Expires: 0');
    header('Cache-Control: must-revalidate, post-check=0, pre-check=0');
    header('Pragma: public');
    header('Content-Length: ' . filesize($filePath));

    readfile($filePath);
    exit;
}

/**
 * 记录客户端下载行为（Web端本地 Blob 下载或外部下载）
 */
if ($action === 'log_download') {
    $token = trim($_REQUEST['token'] ?? '');
    $fileName = trim($_REQUEST['filename'] ?? '');
    $studentName = trim($_REQUEST['studentName'] ?? '');
    if (empty($studentName) && !empty($token)) {
        $studentName = $_SESSION['verified_token_' . md5($token)] ?? '';
    }
    logRetestAccess($token, $studentName, 'download_pdf', $fileName);
    echo json_encode(['success' => true]);
    exit;
}

/**
 * 作废 / 恢复专属错题本链接（需教师登录）
 * POST ?action=revoke_token   { token, reason? } -> 加入黑名单
 * POST ?action=unrevoke_token { token }         -> 移出黑名单
 */
if ($action === 'revoke_token' || $action === 'unrevoke_token') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        http_response_code(405);
        echo json_encode(['success' => false, 'error' => 'Method Not Allowed']);
        exit;
    }
    requireAuth();

    $body = json_decode(file_get_contents('php://input'), true) ?: [];
    $token = trim($body['token'] ?? ($_POST['token'] ?? ''));
    if ($token === '') {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => '缺少 Token 参数'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // 仅允许操作真实存在的 Token（短映射或 DB 记录），防止黑名单被垃圾填满
    $tokenMapFile = $historyDir . '/token_map.json';
    $tokenMap = file_exists($tokenMapFile) ? (json_decode(@file_get_contents($tokenMapFile), true) ?: []) : [];
    $exists = isset($tokenMap[$token]);
    if (!$exists) {
        try {
            $db = Database::getInstance();
            $exists = (bool)$db->fetchOne("SELECT id FROM student_records WHERE retest_token = ? LIMIT 1", [$token]);
        } catch (Throwable $e) {
            $exists = false;
        }
    }
    if (!$exists) {
        http_response_code(404);
        echo json_encode(['success' => false, 'error' => '未找到该 Token 对应的错题本记录'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $operator = trim($_SESSION['username'] ?? 'unknown');
    $map = loadRevokedTokens();
    if ($action === 'revoke_token') {
        $reason = substr(trim($body['reason'] ?? ($_POST['reason'] ?? '')), 0, 200);
        $map[$token] = ['by' => $operator, 'at' => date('Y-m-d H:i:s'), 'reason' => $reason];
        $event = 'revoke_token';
        $msg = '已作废该错题本链接（重生成同一 Token 仍不可用，直至恢复）';
    } else {
        unset($map[$token]);
        $event = 'unrevoke_token';
        $msg = '已恢复该错题本链接';
    }
    if (!saveRevokedTokens($map)) {
        http_response_code(500);
        echo json_encode(['success' => false, 'error' => '黑名单写入失败'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    logRetestAccess($token, $operator, $event, $msg);
    if (function_exists('recordServerLog')) {
        recordServerLog('warn', 'retest', $event, ['token' => $token, 'message' => $msg], ['operator' => $operator]);
    }
    echo json_encode(['success' => true, 'message' => $msg], JSON_UNESCAPED_UNICODE);
    exit;
}

http_response_code(400);
echo json_encode(['success' => false, 'error' => 'Invalid action']);

