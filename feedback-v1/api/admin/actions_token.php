<?php
/**
 * Admin Token 错题本反查动作处理: get_retest_admin_url, search_by_token
 */

require_once __DIR__ . '/../lib_retest_keys.php';

switch ($action) {
        case 'get_retest_admin_url':
            requireAdmin();
            $token = trim($_GET['token'] ?? '');
            if (empty($token)) {
                sendResponse(false, null, '缺少Token参数', 400);
            }
            $configContent = file_exists($configFile) ? file_get_contents($configFile) : '{}';
            $cfg = json_decode($configContent, true) ?: [];
            $secCfg = file_exists(dirname(__DIR__) . '/secret_key.php') ? require(dirname(__DIR__) . '/secret_key.php') : [];
            $retestSecret = $secCfg['retestSecret'] ?? ($cfg['retestSecret'] ?? '');
            if ($retestSecret === '') {
                sendResponse(false, null, '服务端密钥未配置，无法签发免密链接', 500);
            }
            $nowTs = time();
            $adminSig = hash_hmac('sha256', "{$token}_{$nowTs}", $retestSecret);
            $url = "retest.html?token=" . urlencode($token) . "&admin_sig=" . urlencode($adminSig) . "&admin_ts=" . $nowTs;
            sendResponse(true, ['url' => $url, 'admin_sig' => $adminSig, 'admin_ts' => $nowTs]);
            break;

        case 'search_by_token':
            requireAdmin();
            $rawInput = trim($_GET['token'] ?? ($_POST['token'] ?? ''));
            if ($rawInput === '') {
                $body = json_decode(file_get_contents('php://input'), true);
                $rawInput = trim($body['token'] ?? '');
            }

            if (empty($rawInput)) {
                sendResponse(false, null, '请输入要查询的 Token 或错题本链接', 400);
            }

            // 1. 智能清洗与提取 Token (兼容长链接、短链接、URL 参数或原始 Token)
            $token = $rawInput;
            if (preg_match('/[?&]token=([^&#\s]+)/i', $rawInput, $matches)) {
                $token = urldecode($matches[1]);
            } else {
                $token = trim(urldecode($rawInput));
            }
            $token = trim($token, " \t\n\r\0\x0B\"'<>");

            if (empty($token)) {
                sendResponse(false, null, '未能从输入中识别到有效的 Token 字符串', 400);
            }

            // 读取密钥以备签名和 AES 解密
            $configContent = file_exists($configFile) ? file_get_contents($configFile) : '{}';
            $cfg = json_decode($configContent, true) ?: [];
            $secCfg = file_exists(dirname(__DIR__) . '/secret_key.php') ? require(dirname(__DIR__) . '/secret_key.php') : [];
            $retestSecret = $secCfg['retestSecret'] ?? ($cfg['retestSecret'] ?? '');

            $results = [];

            // 2. 策略一：从 MySQL `student_records` 联合 `class_batches` 查询
            try {
                $db = DB::getConnection();
                if ($db) {
                    $sql = "SELECT sr.*, 
                                   cb.year, cb.season, cb.grade, cb.tier, cb.subject, cb.class_name, cb.created_by AS batch_creator
                            FROM `student_records` sr
                            LEFT JOIN `class_batches` cb ON sr.batch_id = cb.id
                            WHERE sr.retest_token = ? OR sr.retest_token LIKE ?
                            ORDER BY (sr.retest_token = ?) DESC, sr.updated_at DESC
                            LIMIT 6";
                    $likePattern = "%{$token}%";
                    $rows = DB::fetchAll($sql, [$token, $likePattern, $token]);

                    if (!empty($rows)) {
                        foreach ($rows as $r) {
                            $errList = [];
                            if (!empty($r['error_questions'])) {
                                if (is_array($r['error_questions'])) {
                                    $errList = $r['error_questions'];
                                } else {
                                    $decoded = json_decode($r['error_questions'], true);
                                    $errList = is_array($decoded) ? $decoded : [];
                                }
                            }
                            $previewErrList = [];
                            if (!empty($r['preview_error_questions'])) {
                                if (is_array($r['preview_error_questions'])) {
                                    $previewErrList = $r['preview_error_questions'];
                                } else {
                                    $decoded = json_decode($r['preview_error_questions'], true);
                                    $previewErrList = is_array($decoded) ? $decoded : [];
                                }
                            }
                            $rToken = $r['retest_token'] ?: $token;
                            $nowTs = time();
                            $sig = hash_hmac('sha256', "{$rToken}_{$nowTs}", $retestSecret);
                            $results[] = [
                                'record_id'        => (int)$r['id'],
                                'token'            => $rToken,
                                'student_name'     => $r['student_name'] ?? '',
                                'student_id'       => $r['student_id'] ?? '',
                                'student_key'      => $r['student_key'] ?? '',
                                'year'             => $r['year'] ?? null,
                                'season'           => $r['season'] ?? '',
                                'grade'            => $r['grade'] ?? '',
                                'tier'             => $r['tier'] ?? '',
                                'subject'          => $r['subject'] ?? '',
                                'class_name'       => $r['class_name'] ?? '',
                                'week_num'         => $r['week_num'] !== null ? (int)$r['week_num'] : null,
                                'preview_week_num' => $r['preview_week_num'] !== null ? (int)$r['preview_week_num'] : null,
                                'homework_score'   => $r['homework_score'] !== null ? (float)$r['homework_score'] : null,
                                'preview_score'    => $r['preview_score'] !== null ? (float)$r['preview_score'] : null,
                                'total_score'      => $r['total_score'] !== null ? (float)$r['total_score'] : null,
                                'error_count'      => isset($r['error_count']) ? (int)$r['error_count'] : count($errList),
                                'error_questions'  => $errList,
                                'preview_error_questions' => $previewErrList,
                                'teacher_comment'  => $r['teacher_comment'] ?? '',
                                'preview_comment'  => $r['preview_comment'] ?? '',
                                'created_by'       => $r['created_by'] ?? ($r['batch_creator'] ?? ''),
                                'created_at'       => $r['created_at'] ?? '',
                                'updated_at'       => $r['updated_at'] ?? '',
                                'retest_beta_url'  => "retest.html?token=" . urlencode($rToken) . "&admin_sig=" . urlencode($sig) . "&admin_ts=" . $nowTs,
                                'retest_url'       => "retest.html?token=" . urlencode($rToken) . "&admin_sig=" . urlencode($sig) . "&admin_ts=" . $nowTs,
                                'source'           => '数据库 (student_records)'
                            ];
                        }
                    }
                }
            } catch (Throwable $e) {
                error_log("search_by_token mysql error: " . $e->getMessage());
            }

            // 3. 附带家长访问日志
            $accessLogs = [];
            try {
                if (!empty($token) && DB::getConnection()) {
                    $accessLogs = DB::fetchAll(
                        "SELECT `id`, `student_name`, `action`, `details`, `ip`, `user_agent`, `created_at` 
                         FROM `retest_access_logs` 
                         WHERE `token` = ? 
                         ORDER BY `id` DESC LIMIT 6",
                        [$token]
                    );
                }
            } catch (Throwable $ignore) {}

            recordServerLog('action', 'admin', 'token_search', [
                'token' => $token,
                'found' => !empty($results),
                'match_count' => count($results)
            ]);

            sendResponse(true, [
                'found'        => !empty($results),
                'search_token' => $token,
                'raw_input'    => $rawInput,
                'matches'      => $results,
                'access_logs'  => $accessLogs
            ]);
            break;

}
