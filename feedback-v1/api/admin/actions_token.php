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

            // 3. 策略二：若数据库未检索到或离线，回退检索文件映射 `data/history/token_map.json`
            if (empty($results)) {
                $tokenMapFile = dirname(__DIR__, 2) . '/data/history/token_map.json';
                if (file_exists($tokenMapFile)) {
                    $tokenMap = json_decode(file_get_contents($tokenMapFile), true) ?: [];
                    $mapEntry = null;
                    $matchedTokenKey = $token;

                    if (isset($tokenMap[$token])) {
                        $mapEntry = $tokenMap[$token];
                    } else {
                        foreach ($tokenMap as $tk => $tv) {
                            if (strcasecmp($tk, $token) === 0 || strpos($tk, $token) !== false) {
                                $mapEntry = $tv;
                                $matchedTokenKey = $tk;
                                break;
                            }
                        }
                    }

                    if ($mapEntry) {
                        $sub = $mapEntry['s'] ?? '';
                        $grd = $mapEntry['g'] ?? '';
                        $tier = $mapEntry['t'] ?? '';
                        $wk = $mapEntry['w'] ?? null;
                        $sName = $mapEntry['n'] ?? '';
                        $sKey = $mapEntry['k'] ?? $sName;
                        $sId = $mapEntry['id'] ?? '';
                        $yr = $mapEntry['year'] ?? null;
                        $sea = $mapEntry['season'] ?? '';

                        // 尝试从历史错题档案获取题号
                        $errList = [];
                        $histFile = dirname(__DIR__, 2) . '/data/history/' . rawurlencode($sub) . '_' . rawurlencode($grd) . '_' . rawurlencode($tier) . '.json';
                        if (file_exists($histFile)) {
                            $histData = json_decode(file_get_contents($histFile), true) ?: [];
                            if (isset($histData[$sKey][(string)$wk])) {
                                $errList = $histData[$sKey][(string)$wk];
                            } elseif (isset($histData[$sName][(string)$wk])) {
                                $errList = $histData[$sName][(string)$wk];
                            }
                        }

                        $nowTs = time();
                        $sig = hash_hmac('sha256', "{$matchedTokenKey}_{$nowTs}", $retestSecret);
                        $results[] = [
                            'record_id'        => null,
                            'token'            => $matchedTokenKey,
                            'student_name'     => $sName,
                            'student_id'       => $sId,
                            'student_key'      => $sKey,
                            'year'             => $yr,
                            'season'           => $sea,
                            'grade'            => $grd,
                            'tier'             => $tier,
                            'subject'          => $sub,
                            'class_name'       => ($yr ? substr((string)$yr, -2) : '') . $sea . "_{$grd}_{$tier}_{$sub}",
                            'week_num'         => $wk,
                            'homework_score'   => null,
                            'preview_score'    => null,
                            'total_score'      => null,
                            'error_count'      => count($errList),
                            'error_questions'  => $errList,
                            'teacher_comment'  => '',
                            'created_by'       => '',
                            'created_at'       => isset($mapEntry['u']) ? date('Y-m-d H:i:s', $mapEntry['u']) : '',
                            'updated_at'       => isset($mapEntry['u']) ? date('Y-m-d H:i:s', $mapEntry['u']) : '',
                            'retest_beta_url'  => "retest.html?token=" . urlencode($matchedTokenKey) . "&admin_sig=" . urlencode($sig) . "&admin_ts=" . $nowTs,
                            'retest_url'       => "retest.html?token=" . urlencode($matchedTokenKey) . "&admin_sig=" . urlencode($sig) . "&admin_ts=" . $nowTs,
                            'source'           => '历史映射表 (token_map.json)'
                        ];
                    }
                }
            }

            // 4. 策略三：尝试对 Token 进行 AES-256-CBC 逆向解密（兼容旧版或长加密 Token）
            if (empty($results)) {
                $cipherAlgo = 'aes-256-cbc';
                $tryToken = str_replace(['-', '_'], ['+', '/'], $token);
                $mod4 = strlen($tryToken) % 4;
                if ($mod4) $tryToken .= substr('====', $mod4);
                $decoded = base64_decode($tryToken);
                $ivlen = openssl_cipher_iv_length($cipherAlgo);
                if ($decoded !== false && strlen($decoded) > $ivlen) {
                    $iv = substr($decoded, 0, $ivlen);
                    $ciphertext = substr($decoded, $ivlen);
                    $decrypted = openssl_decrypt($ciphertext, $cipherAlgo, $retestSecret, 0, $iv);
                    if ($decrypted !== false) {
                        $decData = json_decode($decrypted, true);
                        if ($decData && (isset($decData['n']) || isset($decData['name']))) {
                            $sName = $decData['n'] ?? ($decData['name'] ?? '');
                            $sub = $decData['s'] ?? ($decData['subject'] ?? '');
                            $grd = $decData['g'] ?? ($decData['grade'] ?? '');
                            $tier = $decData['t'] ?? ($decData['tier'] ?? '');
                            $wk = $decData['w'] ?? ($decData['week'] ?? null);
                            $errs = $decData['q'] ?? ($decData['errors'] ?? []);
                            $sId = $decData['id'] ?? '';
                            $sKey = trim((string)($decData['k'] ?? ''));
                            // 旧长 Token 里的 k 可能是旧格式，展示时归一化为新格式
                            if ($sId !== '' && ($sKey === '' || $sKey === legacy_student_key($sId, $sName))) {
                                $sKey = build_student_key($sId, $sName, $grd, $sub);
                            } elseif ($sKey === '') {
                                $sKey = $sName;
                            }

                            $nowTs = time();
                            $sig = hash_hmac('sha256', "{$token}_{$nowTs}", $retestSecret);
                            $results[] = [
                                'record_id'        => null,
                                'token'            => $token,
                                'student_name'     => $sName,
                                'student_id'       => $sId,
                                'student_key'      => $sKey,
                                'year'             => $decData['year'] ?? null,
                                'season'           => $decData['season'] ?? '',
                                'grade'            => $grd,
                                'tier'             => $tier,
                                'subject'          => $sub,
                                'class_name'       => "{$grd}_{$tier}_{$sub}",
                                'week_num'         => $wk,
                                'homework_score'   => null,
                                'preview_score'    => null,
                                'total_score'      => null,
                                'error_count'      => is_array($errs) ? count($errs) : 0,
                                'error_questions'  => is_array($errs) ? $errs : [],
                                'teacher_comment'  => '',
                                'created_by'       => '',
                                'created_at'       => '',
                                'updated_at'       => '',
                                'retest_beta_url'  => "retest.html?token=" . urlencode($token) . "&admin_sig=" . urlencode($sig) . "&admin_ts=" . $nowTs,
                                'retest_url'       => "retest.html?token=" . urlencode($token) . "&admin_sig=" . urlencode($sig) . "&admin_ts=" . $nowTs,
                                'source'           => 'AES-256 解密数据'
                            ];
                        }
                    }
                }
            }

            // 5. 附带家长访问日志
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
