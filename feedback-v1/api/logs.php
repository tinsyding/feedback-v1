<?php
/**
 * 操作日志 API（v3 - 支持 MySQL 极速索引存储 + 文件高速追加双重保障）
 *
 * POST   ?action=log             -> 记录日志（支持单条和批量）
 * GET    ?action=list            -> 获取日志列表（需管理员登录）
 * GET    ?action=export          -> 导出 CSV（需管理员登录）
 * GET    ?action=filters         -> 获取筛选选项（需管理员登录）
 * GET    ?action=stats           -> 获取统计概览（需管理员登录）
 * DELETE ?id=xxx                 -> 删除日志（需管理员登录）
 * DELETE ?action=clear&date=xxx  -> 清空指定日期日志（需管理员登录）
 */

require_once __DIR__ . '/bootstrap.php';

require_once __DIR__ . '/db.php';

require_once __DIR__ . '/sender_control_helper.php';

$logDir = __DIR__ . '/../data/logs';
if (!is_dir($logDir)) {
    @mkdir($logDir, 0755, true);
}

$senderLogDir = __DIR__ . '/../data/sender_logs';
if (!is_dir($senderLogDir)) {
    @mkdir($senderLogDir, 0755, true);
}

require_once __DIR__ . '/sender_auth_helper.php';

const LOG_RETENTION_DAYS = 30;
const DEFAULT_SENDER_LOG_TOKEN = DEFAULT_SENDER_TOKEN;

/**
 * 校验 Python 发送器访问令牌（与 api/identify.php 鉴权策略保持一致）
 */
function verifySenderApiToken(string $given = ''): bool {
    return verifySenderRequestToken($given);
}

function sanitizeSenderSlug(string $slug): string {
    $clean = preg_replace('/[^a-zA-Z0-9_-]/', '_', trim($slug));
    $clean = trim((string)$clean, '_');
    return $clean !== '' ? substr($clean, 0, 64) : 'unknown_pc';
}

function sanitizeSenderDate(string $date): string {
    $d = trim($date);
    if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $d)) {
        return $d;
    }
    if (preg_match('/^(\d{4})(\d{2})(\d{2})/', $d, $m)) {
        return "{$m[1]}-{$m[2]}-{$m[3]}";
    }
    return date('Y-m-d');
}

function verifySameOriginAdminPost(): void {
    $host = strtolower(preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? ''));
    $originHost = isset($_SERVER['HTTP_ORIGIN']) && $_SERVER['HTTP_ORIGIN'] !== ''
        ? strtolower((string)parse_url($_SERVER['HTTP_ORIGIN'], PHP_URL_HOST)) : '';
    $refererHost = isset($_SERVER['HTTP_REFERER']) && $_SERVER['HTTP_REFERER'] !== ''
        ? strtolower((string)parse_url($_SERVER['HTTP_REFERER'], PHP_URL_HOST)) : '';
    if (($originHost !== '' && !hash_equals($host, $originHost)) ||
        ($originHost === '' && $refererHost !== '' && !hash_equals($host, $refererHost))) {
        sendResponse(false, null, '跨站请求已拦截（Origin 校验失败）', 403);
    }
}

function updateSenderClientMeta(string $clientDir, array $clientInfo, array $activeFiles, string $ip, ?array $runtimeState = null): array {
    $metaFile = $clientDir . '/meta.json';
    $existing = [];
    if (is_file($metaFile)) {
        $decoded = @json_decode(@file_get_contents($metaFile), true);
        if (is_array($decoded)) {
            $existing = $decoded;
        }
    }
    $hostname = trim((string)($clientInfo['hostname'] ?? ($existing['hostname'] ?? 'UnknownPC')));
    $osUser = trim((string)($clientInfo['os_user'] ?? ($existing['os_user'] ?? 'user')));
    $teacherNote = array_key_exists('teacher_note', $clientInfo)
        ? trim((string)$clientInfo['teacher_note'])
        : trim((string)($existing['teacher_note'] ?? ''));
    $displayName = $teacherNote !== '' ? "{$teacherNote} ({$hostname}/{$osUser})" : "{$hostname} ({$osUser})";
    $operator = $teacherNote !== '' ? "{$teacherNote}@{$hostname}" : "{$hostname}({$osUser})";

    $mergedFiles = $existing['active_files'] ?? [];
    if (!empty($activeFiles)) {
        $mergedFiles = array_values(array_unique(array_merge($mergedFiles, array_map('strval', $activeFiles))));
        $mergedFiles = array_slice($mergedFiles, -20);
    }

    $mergedRuntime = is_array($existing['runtime_state'] ?? null) ? $existing['runtime_state'] : [];
    if (is_array($runtimeState)) {
        $mergedRuntime = [
            'running' => !empty($runtimeState['running']),
            'processed' => max(0, (int)($runtimeState['processed'] ?? 0)),
            'total' => max(0, (int)($runtimeState['total'] ?? 0)),
            'current_name' => substr(trim((string)($runtimeState['current_name'] ?? '')), 0, 60),
            'verify_mode' => substr(trim((string)($runtimeState['verify_mode'] ?? '')), 0, 20),
            'policy_version' => max(0, (int)($runtimeState['policy_version'] ?? 0)),
            'updated_at' => date('Y-m-d H:i:s'),
        ];
    }

    $meta = array_merge($existing, [
        'client_id' => (string)($clientInfo['client_id'] ?? ($existing['client_id'] ?? '')),
        'client_slug' => basename($clientDir),
        'hostname' => $hostname,
        'os_user' => $osUser,
        'teacher_note' => $teacherNote,
        'display_name' => $displayName,
        'operator' => substr($operator, 0, 60),
        'platform' => (string)($clientInfo['platform'] ?? ($existing['platform'] ?? '')),
        'app_version' => (string)($clientInfo['app_version'] ?? ($existing['app_version'] ?? '')),
        'ip' => $ip,
        'active_files' => $mergedFiles,
        'runtime_state' => $mergedRuntime,
        'last_sync_at' => date('Y-m-d H:i:s'),
        'last_sync_ts' => time(),
    ]);
    @file_put_contents($metaFile, json_encode($meta, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), LOCK_EX);
    return $meta;
}

function cleanupOldSenderLogs(string $senderLogDir, int $days = 30): void {
    try {
        $cutoffDate = date('Y-m-d', time() - $days * 86400);
        foreach (glob($senderLogDir . '/????-??-??', GLOB_ONLYDIR) ?: [] as $dateDir) {
            $baseDate = basename($dateDir);
            if ($baseDate < $cutoffDate) {
                $it = new RecursiveDirectoryIterator($dateDir, RecursiveDirectoryIterator::SKIP_DOTS);
                $files = new RecursiveIteratorIterator($it, RecursiveIteratorIterator::CHILD_FIRST);
                foreach ($files as $file) {
                    if ($file->isDir()) {
                        @rmdir($file->getRealPath());
                    } else {
                        @unlink($file->getRealPath());
                    }
                }
                @rmdir($dateDir);
            }
        }
    } catch (Throwable $e) {
        // 静默忽略
    }
}

/**
 * 服务端统一日志写入辅助函数（供其他 PHP 脚本直接调用）
 */
function recordServerLog(string $level, string $module, string $event, array $details = [], array $context = []): bool {
    global $logDir;
    
    $ts = round(microtime(true) * 1000);
    $logId = uniqid('srv_') . '_' . substr(md5((string)microtime(true)), 0, 6);
    $serverIP = getClientIP();
    $serverUA = $_SERVER['HTTP_USER_AGENT'] ?? 'ServerInternal';
    $createdAt = date('Y-m-d H:i:s');
    
    $clientInfo = [
        'ip' => $serverIP,
        'userAgent' => $serverUA,
        'platform' => PHP_OS,
        'source' => 'backend'
    ];

    $operator = trim((string)($context['operator'] ?? ($details['operator'] ?? ($_SESSION['username'] ?? ''))));

    // 1. 尝试写入 MySQL
    try {
        $db = DB::getConnection();
        if ($db) {
            $stmt = $db->prepare("INSERT INTO system_logs 
                (log_id, timestamp, level, module, event, operator, details, context, client_ip, client_info, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
            $stmt->execute([
                $logId,
                $ts,
                $level,
                $module,
                $event,
                $operator,
                json_encode($details, JSON_UNESCAPED_UNICODE),
                json_encode($context, JSON_UNESCAPED_UNICODE),
                $serverIP,
                json_encode($clientInfo, JSON_UNESCAPED_UNICODE),
                $createdAt
            ]);
        }
    } catch (Throwable $e) {
        // 忽略异常，降级写文件
    }

    // 2. 高速追加写入当天 .jsonl 文件（NDJSON 格式，零内存开销）
    try {
        $today = date('Y-m-d');
        $jsonlFile = $logDir . '/' . $today . '.jsonl';
        $entryLine = json_encode([
            'id' => $logId,
            'timestamp' => $ts,
            'level' => $level,
            'module' => $module,
            'event' => $event,
            'operator' => $operator,
            'details' => $details,
            'context' => $context,
            'client' => $clientInfo
        ], JSON_UNESCAPED_UNICODE);
        @file_put_contents($jsonlFile, $entryLine . "\n", FILE_APPEND | LOCK_EX);
    } catch (Throwable $e) {
        // 静默
    }

    // 3. 超期数据清理（2% 概率触发，分摊开销；DB 与磁盘双清，保留 LOG_RETENTION_DAYS 天）
    if (mt_rand(1, 50) === 1) {
        try {
            $db = DB::getConnection();
            if ($db) {
                $stmt = $db->prepare("DELETE FROM system_logs WHERE created_at < (NOW() - INTERVAL " . LOG_RETENTION_DAYS . " DAY) LIMIT 5000");
                $stmt->execute();
            }
        } catch (Throwable $e) {
            // 忽略异常，降级跳过
        }
        try {
            $cutoff = time() - LOG_RETENTION_DAYS * 86400;
            foreach (glob($logDir . '/????-??-??.*') ?: [] as $f) {
                if (is_file($f) && filemtime($f) < $cutoff) {
                    @unlink($f);
                }
            }
        } catch (Throwable $e) {
            // 静默
        }
    }

    return true;
}

// ========== 格式化导出 ==========

function formatDetailsForExport($entry) {
    $details = $entry['details'] ?? [];
    if (is_string($details)) return $details;
    if (!empty($details['message'])) return $details['message'];
    $parts = [];
    foreach ($details as $key => $value) {
        if (is_array($value) || is_object($value)) {
            $value = json_encode($value, JSON_UNESCAPED_UNICODE);
        }
        $parts[] = "$key: $value";
    }
    return implode(' | ', $parts);
}

function getLevelLabel($level) {
    $labels = [
        'error' => '错误',
        'warn' => '警告',
        'action' => '操作',
        'info' => '信息'
    ];
    return $labels[$level] ?? $level;
}

function sanitizeCsvCell($val) {
    $str = (string)$val;
    if (strlen($str) > 0) {
        $first = $str[0];
        if (in_array($first, ['=', '+', '-', '@', "\t", "\r"], true)) {
            return "'" . $str;
        }
    }
    return $str;
}

function getAvailableDatesFromDisk($logDir) {
    $dates = [];
    $files = glob($logDir . '/????-??-??.*');
    if ($files) {
        foreach ($files as $file) {
            $basename = pathinfo($file, PATHINFO_FILENAME);
            if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $basename)) {
                $dates[$basename] = true;
            }
        }
    }
    $dates = array_keys($dates);
    rsort($dates);
    return $dates;
}

// ========== 路由处理 ==========

// 若作为库被包含引用，则直接返回函数定义
if (isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) !== realpath(__FILE__)) {
    return;
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = $_GET['action'] ?? '';

try {
    switch ($method) {
        case 'POST':
            if ($action === 'log') {
                $rawInput = file_get_contents('php://input');
                if (strlen($rawInput) > 65536) {
                    sendResponse(false, null, '请求载荷超出限制', 413);
                }

                $input = json_decode($rawInput, true);
                if (!$input || !is_array($input)) {
                    sendResponse(false, null, '无效的请求数据', 400);
                }

                $serverIP = getClientIP();

                // IP 级限流（防无 cookie 刷库：session 限流可被丢弃 cookie 绕过）
                // 每 IP 每分钟最多 60 次上报，计数文件落系统临时目录
                $ipRateFile = sys_get_temp_dir() . '/jf_log_rate_' . md5($serverIP) . '.json';
                $ipRate = ['count' => 0, 'window' => time()];
                if (is_file($ipRateFile)) {
                    $cached = json_decode(@file_get_contents($ipRateFile), true);
                    if (is_array($cached) && isset($cached['window']) && (time() - (int)$cached['window']) < 60) {
                        $ipRate = $cached;
                    }
                }
                if ((int)($ipRate['count'] ?? 0) >= 60) {
                    sendResponse(false, null, '日志上报频次超限，请稍后再试', 429);
                }
                $ipRate['count'] = (int)($ipRate['count'] ?? 0) + 1;
                if (empty($ipRate['window'])) {
                    $ipRate['window'] = time();
                }
                @file_put_contents($ipRateFile, json_encode($ipRate), LOCK_EX);

                // 针对未登录访客实施会话级速率限制 (每分钟最多 30 条日志)
                if (empty($_SESSION['username']) && empty($_SESSION['admin_username'])) {
                    if (session_status() === PHP_SESSION_NONE) {
                        @session_start();
                    }
                    $now = time();
                    $logHistory = $_SESSION['client_log_rate'] ?? [];
                    // 清理 60 秒之前的记录
                    $logHistory = array_filter($logHistory, fn($t) => ($now - $t) < 60);
                    if (count($logHistory) >= 30) {
                        sendResponse(false, null, '日志上报频次超限，请稍后再试', 429);
                    }
                    $logHistory[] = $now;
                    $_SESSION['client_log_rate'] = $logHistory;
                }

                $serverUA = $_SERVER['HTTP_USER_AGENT'] ?? 'unknown';
                $serverReferer = $_SERVER['HTTP_REFERER'] ?? '';

                $entries = [];
                if (isset($input['entries']) && is_array($input['entries'])) {
                    $entries = array_slice($input['entries'], 0, 20);
                } else {
                    $entries[] = $input;
                }

                $db = DB::getConnection();
                $today = date('Y-m-d');
                $jsonlFile = $logDir . '/' . $today . '.jsonl';
                $savedCount = 0;

                // 准备 MySQL 插入
                $insertStmt = null;
                if ($db) {
                    try {
                        $insertStmt = $db->prepare("INSERT INTO system_logs 
                            (log_id, timestamp, level, module, event, operator, details, context, client_ip, client_info, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
                        $db->beginTransaction();
                    } catch (Throwable $e) {
                        $insertStmt = null;
                    }
                }

                $jsonlBuffer = '';

                foreach ($entries as $entry) {
                    $ts = $entry['timestamp'] ?? round(microtime(true) * 1000);
                    $logId = uniqid('log_') . '_' . substr(md5((string)microtime(true)), 0, 6);
                    $level = $entry['level'] ?? 'action';
                    $module = $entry['module'] ?? 'global';
                    $event = $entry['event'] ?? ($entry['action'] ?? 'unknown');
                    $details = $entry['details'] ?? [];
                    $context = $entry['context'] ?? [];
                    $sessionUser = trim($_SESSION['username'] ?? ($_SESSION['admin_username'] ?? ''));
                    $reqOperator = trim((string)($entry['operator'] ?? ($context['operator'] ?? '')));
                    if (!empty($sessionUser)) {
                        $operator = $sessionUser;
                    } elseif (!empty($reqOperator)) {
                        $operator = 'guest:' . substr($reqOperator, 0, 30);
                    } else {
                        $operator = 'guest';
                    }
                    $client = array_merge(
                        $entry['client'] ?? [],
                        ['ip' => $serverIP]
                    );
                    if (empty($client['userAgent']) && $serverUA) {
                        $client['userAgent'] = $serverUA;
                    }

                    $createdAt = date('Y-m-d H:i:s', ceil($ts / 1000));

                    // 1. MySQL 写入
                    if ($insertStmt) {
                        try {
                            $insertStmt->execute([
                                $logId,
                                $ts,
                                $level,
                                $module,
                                $event,
                                $operator,
                                json_encode($details, JSON_UNESCAPED_UNICODE),
                                json_encode($context, JSON_UNESCAPED_UNICODE),
                                $serverIP,
                                json_encode($client, JSON_UNESCAPED_UNICODE),
                                $createdAt
                            ]);
                        } catch (Throwable $e) {
                            // 降级忽略
                        }
                    }

                    // 2. 累积到文件追加 buffer（NDJSON）
                    $jsonlBuffer .= json_encode([
                        'id' => $logId,
                        'timestamp' => $ts,
                        'level' => $level,
                        'module' => $module,
                        'event' => $event,
                        'operator' => $operator,
                        'details' => $details,
                        'context' => $context,
                        'client' => $client
                    ], JSON_UNESCAPED_UNICODE) . "\n";

                    $savedCount++;
                }

                if ($insertStmt && $db && $db->inTransaction()) {
                    $db->commit();
                }

                // 高速追加写入当天磁盘日志
                if (!empty($jsonlBuffer)) {
                    @file_put_contents($jsonlFile, $jsonlBuffer, FILE_APPEND | LOCK_EX);
                }

                sendResponse(true, ['count' => $savedCount, 'message' => '日志记录成功']);

            } elseif ($action === 'sender_sync') {
                $rawInput = file_get_contents('php://input');
                if (strlen($rawInput) > 524288) {
                    sendResponse(false, null, '请求载荷超出限制', 413);
                }
                $input = json_decode($rawInput, true);
                if (!$input || !is_array($input)) {
                    sendResponse(false, null, '无效的请求数据', 400);
                }

                $token = (string)($input['token'] ?? '');
                if (!verifySenderApiToken($token)) {
                    sendResponse(false, null, '发送器鉴权失败', 200);
                }

                $serverIP = getClientIP();
                $clientInfo = is_array($input['client'] ?? null) ? $input['client'] : [];
                $clientSlug = sanitizeSenderSlug((string)($clientInfo['client_slug'] ?? ($clientInfo['hostname'] ?? 'unknown_pc')));
                $activeFiles = is_array($input['active_files'] ?? null) ? $input['active_files'] : [];
                $runtimeState = is_array($input['runtime_state'] ?? null) ? $input['runtime_state'] : null;
                $ackCommands = is_array($input['ack_commands'] ?? null) ? $input['ack_commands'] : [];
                $syncMode = (string)($input['sync_mode'] ?? 'realtime');

                if (!empty($ackCommands)) {
                    acknowledgeClientCommands($clientSlug, $ackCommands);
                }

                if (mt_rand(1, 30) === 1) {
                    cleanupOldSenderLogs($senderLogDir, LOG_RETENTION_DAYS);
                }

                if ($syncMode === 'heartbeat') {
                    $dateStr = sanitizeSenderDate((string)($input['date_str'] ?? date('Y-m-d')));
                    $clientDir = $senderLogDir . '/' . $dateStr . '/' . $clientSlug;
                    if (!is_dir($clientDir)) {
                        @mkdir($clientDir, 0755, true);
                    }
                    updateSenderClientMeta($clientDir, $clientInfo, $activeFiles, $serverIP, $runtimeState);
                    $cloudControl = buildEffectiveSenderControl($clientSlug);
                    sendResponse(true, [
                        'mode' => 'heartbeat',
                        'client_slug' => $clientSlug,
                        'cloud_control' => $cloudControl,
                    ]);

                } elseif ($syncMode === 'chunk') {
                    $dateStr = sanitizeSenderDate((string)($input['date_str'] ?? date('Y-m-d')));
                    $logType = (($input['log_type'] ?? 'sender') === 'error') ? 'error' : 'sender';
                    $offset = max(0, (int)($input['offset'] ?? 0));
                    $content = (string)($input['content'] ?? '');

                    $clientDir = $senderLogDir . '/' . $dateStr . '/' . $clientSlug;
                    if (!is_dir($clientDir)) {
                        @mkdir($clientDir, 0755, true);
                    }
                    $meta = updateSenderClientMeta($clientDir, $clientInfo, $activeFiles, $serverIP, $runtimeState);

                    $targetFile = $clientDir . '/' . $logType . '_' . $dateStr . '.log';
                    if ($content !== '') {
                        if (!is_file($targetFile) || $offset === 0) {
                            $curSize = is_file($targetFile) ? (int)@filesize($targetFile) : 0;
                            if ($curSize === 0) {
                                @file_put_contents($targetFile, $content, LOCK_EX);
                            } elseif ($curSize < strlen($content)) {
                                // 已有部分实时日志，仅补齐缺失尾部
                                $tail = substr($content, $curSize);
                                if ($tail !== false && $tail !== '') {
                                    @file_put_contents($targetFile, $tail, FILE_APPEND | LOCK_EX);
                                }
                            }
                        } else {
                            $curSize = (int)@filesize($targetFile);
                            if ($curSize === $offset) {
                                @file_put_contents($targetFile, $content, FILE_APPEND | LOCK_EX);
                            } elseif ($curSize < $offset + strlen($content) && $curSize >= $offset) {
                                $skip = $curSize - $offset;
                                $tail = substr($content, $skip);
                                if ($tail !== false && $tail !== '') {
                                    @file_put_contents($targetFile, $tail, FILE_APPEND | LOCK_EX);
                                }
                            } elseif ($curSize < $offset) {
                                @file_put_contents($targetFile, $content, FILE_APPEND | LOCK_EX);
                            }
                        }
                    }

                    sendResponse(true, [
                        'mode' => 'chunk',
                        'date' => $dateStr,
                        'client_slug' => $clientSlug,
                        'size' => is_file($targetFile) ? (int)@filesize($targetFile) : 0,
                        'cloud_control' => buildEffectiveSenderControl($clientSlug),
                    ]);

                } elseif ($syncMode === 'batch_summary') {
                    $summary = is_array($input['batch_summary'] ?? null) ? $input['batch_summary'] : [];
                    $dateStr = sanitizeSenderDate((string)($summary['date_str'] ?? date('Y-m-d')));
                    $clientDir = $senderLogDir . '/' . $dateStr . '/' . $clientSlug;
                    if (!is_dir($clientDir)) {
                        @mkdir($clientDir, 0755, true);
                    }
                    $meta = updateSenderClientMeta($clientDir, $clientInfo, $summary['files'] ?? $activeFiles, $serverIP, $runtimeState);

                    $batchesFile = $clientDir . '/batches.jsonl';
                    @file_put_contents($batchesFile, json_encode($summary, JSON_UNESCAPED_UNICODE) . "\n", FILE_APPEND | LOCK_EX);

                    $counts = $summary['counts'] ?? [];
                    $hasIssue = ((int)($counts['failed'] ?? 0) > 0) || ((int)($counts['blocked'] ?? 0) > 0) || ((int)($counts['unmatched'] ?? 0) > 0);
                    $sysLevel = $hasIssue ? 'warn' : 'action';
                    recordServerLog($sysLevel, 'sender_py', 'batch_summary', [
                        'message' => sprintf(
                            '[%s] 批次发送完成：共 %d 人（成功 %d / 失败 %d / 拦截 %d / 未匹配 %d / 跳过 %d）',
                            $meta['display_name'],
                            (int)($counts['total'] ?? 0),
                            (int)($counts['sent'] ?? 0),
                            (int)($counts['failed'] ?? 0),
                            (int)($counts['blocked'] ?? 0),
                            (int)($counts['unmatched'] ?? 0),
                            (int)($counts['skipped'] ?? 0)
                        ),
                        'counts' => $counts,
                        'files' => $summary['files'] ?? [],
                        'stopped' => !empty($summary['stopped']),
                        'client_slug' => $clientSlug,
                        'client_display' => $meta['display_name'],
                        'students' => array_slice($summary['students'] ?? [], 0, 150),
                    ], [
                        'operator' => $meta['operator'],
                        'source' => 'sender_py',
                        'client_slug' => $clientSlug,
                        'hostname' => $meta['hostname'],
                        'teacher_note' => $meta['teacher_note'],
                    ]);

                    sendResponse(true, [
                        'mode' => 'batch_summary',
                        'client_slug' => $clientSlug,
                        'cloud_control' => buildEffectiveSenderControl($clientSlug),
                    ]);

                } else {
                    // realtime 模式：同时追加 .log 原文件 + 写入 system_logs 审计表
                    $entries = is_array($input['entries'] ?? null) ? array_slice($input['entries'], 0, 100) : [];
                    $db = DB::getConnection();
                    $insertStmt = null;
                    if ($db) {
                        try {
                            $insertStmt = $db->prepare("INSERT INTO system_logs 
                                (log_id, timestamp, level, module, event, operator, details, context, client_ip, client_info, created_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
                            $db->beginTransaction();
                        } catch (Throwable $e) {
                            $insertStmt = null;
                        }
                    }

                    $byDateRaw = [];
                    $byDateErr = [];
                    $jsonlByDate = [];
                    $metaCache = [];
                    $savedCount = 0;

                    if (empty($entries)) {
                        $dateStr = sanitizeSenderDate((string)($input['date_str'] ?? date('Y-m-d')));
                        $cDir = $senderLogDir . '/' . $dateStr . '/' . $clientSlug;
                        if (!is_dir($cDir)) {
                            @mkdir($cDir, 0755, true);
                        }
                        updateSenderClientMeta($cDir, $clientInfo, $activeFiles, $serverIP, $runtimeState);
                    }

                    foreach ($entries as $entry) {
                        if (!is_array($entry)) continue;
                        $dateStr = sanitizeSenderDate((string)($entry['date_str'] ?? date('Y-m-d')));
                        if (!isset($metaCache[$dateStr])) {
                            $cDir = $senderLogDir . '/' . $dateStr . '/' . $clientSlug;
                            if (!is_dir($cDir)) {
                                @mkdir($cDir, 0755, true);
                            }
                            $metaCache[$dateStr] = [
                                'dir' => $cDir,
                                'meta' => updateSenderClientMeta($cDir, $clientInfo, $activeFiles, $serverIP, $runtimeState),
                            ];
                        }
                        $curMeta = $metaCache[$dateStr]['meta'];

                        $rawLine = (string)($entry['raw_line'] ?? '');
                        if ($rawLine !== '') {
                            if (substr($rawLine, -1) !== "\n") {
                                $rawLine .= "\n";
                            }
                            $byDateRaw[$dateStr] = ($byDateRaw[$dateStr] ?? '') . $rawLine;
                            if (!empty($entry['is_error'])) {
                                $byDateErr[$dateStr] = ($byDateErr[$dateStr] ?? '') . $rawLine;
                            }
                        }

                        $ts = (float)($entry['timestamp'] ?? round(microtime(true) * 1000));
                        $logId = uniqid('snd_') . '_' . substr(md5((string)microtime(true) . $savedCount), 0, 6);
                        $sysLevel = in_array($entry['sys_level'] ?? '', ['error', 'warn', 'action', 'info'], true)
                            ? $entry['sys_level'] : 'info';
                        $event = substr(trim((string)($entry['event'] ?? 'sender_log')), 0, 60) ?: 'sender_log';
                        $operator = $curMeta['operator'];
                        $msg = (string)($entry['message'] ?? '');
                        $tb = (string)($entry['traceback'] ?? '');

                        $details = [
                            'message' => $msg,
                            'client' => $curMeta['display_name'],
                            'raw_level' => (string)($entry['level'] ?? 'INFO'),
                        ];
                        if (!empty($activeFiles)) {
                            $details['files'] = $activeFiles;
                        }
                        if ($tb !== '') {
                            $details['traceback'] = $tb;
                        }
                        $context = [
                            'operator' => $operator,
                            'source' => 'sender_py',
                            'client_slug' => $clientSlug,
                            'hostname' => $curMeta['hostname'],
                            'os_user' => $curMeta['os_user'],
                            'teacher_note' => $curMeta['teacher_note'],
                            'files' => $activeFiles,
                        ];
                        $clientRecord = array_merge($curMeta, ['ip' => $serverIP, 'source' => 'sender_py']);
                        $createdAt = date('Y-m-d H:i:s', (int)ceil($ts / 1000));

                        if ($insertStmt) {
                            try {
                                $insertStmt->execute([
                                    $logId,
                                    $ts,
                                    $sysLevel,
                                    'sender_py',
                                    $event,
                                    $operator,
                                    json_encode($details, JSON_UNESCAPED_UNICODE),
                                    json_encode($context, JSON_UNESCAPED_UNICODE),
                                    $serverIP,
                                    json_encode($clientRecord, JSON_UNESCAPED_UNICODE),
                                    $createdAt,
                                ]);
                            } catch (Throwable $e) {
                                // 降级忽略
                            }
                        }

                        $jsonlByDate[$dateStr] = ($jsonlByDate[$dateStr] ?? '') . json_encode([
                            'id' => $logId,
                            'timestamp' => $ts,
                            'level' => $sysLevel,
                            'module' => 'sender_py',
                            'event' => $event,
                            'operator' => $operator,
                            'details' => $details,
                            'context' => $context,
                            'client' => $clientRecord,
                        ], JSON_UNESCAPED_UNICODE) . "\n";

                        $savedCount++;
                    }

                    if ($insertStmt && $db && $db->inTransaction()) {
                        $db->commit();
                    }

                    foreach ($byDateRaw as $dStr => $buf) {
                        $cDir = $metaCache[$dStr]['dir'];
                        @file_put_contents($cDir . '/sender_' . $dStr . '.log', $buf, FILE_APPEND | LOCK_EX);
                    }
                    foreach ($byDateErr as $dStr => $buf) {
                        $cDir = $metaCache[$dStr]['dir'];
                        @file_put_contents($cDir . '/error_' . $dStr . '.log', $buf, FILE_APPEND | LOCK_EX);
                    }
                    foreach ($jsonlByDate as $dStr => $buf) {
                        @file_put_contents($logDir . '/' . $dStr . '.jsonl', $buf, FILE_APPEND | LOCK_EX);
                    }

                    sendResponse(true, [
                        'count' => $savedCount,
                        'client_slug' => $clientSlug,
                        'cloud_control' => buildEffectiveSenderControl($clientSlug),
                    ]);
                }

            } elseif ($action === 'sender_snapshot') {
                $token = (string)($_POST['token'] ?? '');
                if (!verifySenderApiToken($token)) {
                    sendResponse(false, null, '发送器鉴权失败', 200);
                }

                $serverIP = getClientIP();
                $clientInfo = json_decode((string)($_POST['client_json'] ?? '{}'), true);
                if (!is_array($clientInfo)) $clientInfo = [];
                $metaIn = json_decode((string)($_POST['meta_json'] ?? '{}'), true);
                if (!is_array($metaIn)) $metaIn = [];

                $rawPrefix = (string)($_POST['prefix'] ?? ($metaIn['timestamp'] ?? date('Ymd_His')));
                $safePrefix = preg_replace('/[^a-zA-Z0-9_\-\x{4e00}-\x{9fa5}]/u', '_', basename($rawPrefix));
                $safePrefix = trim((string)$safePrefix, '_') ?: date('Ymd_His');

                $tsStr = (string)($metaIn['timestamp'] ?? $safePrefix);
                $dateStr = sanitizeSenderDate($tsStr);
                $clientSlug = sanitizeSenderSlug((string)($clientInfo['client_slug'] ?? ($clientInfo['hostname'] ?? 'unknown_pc')));

                $clientDir = $senderLogDir . '/' . $dateStr . '/' . $clientSlug;
                $snapDir = $clientDir . '/snapshots/' . $safePrefix;
                if (!is_dir($snapDir)) {
                    @mkdir($snapDir, 0755, true);
                }
                $clientMeta = updateSenderClientMeta($clientDir, $clientInfo, [], $serverIP);

                foreach (['image_title' => 'title.png', 'image_annotated' => 'annotated.png'] as $field => $destName) {
                    if (isset($_FILES[$field]) && ($_FILES[$field]['error'] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_OK) {
                        if (($_FILES[$field]['size'] ?? 0) <= 5 * 1024 * 1024) {
                            $info = @getimagesize($_FILES[$field]['tmp_name']);
                            if ($info !== false && in_array($info[2], [IMAGETYPE_PNG, IMAGETYPE_JPEG], true)) {
                                @move_uploaded_file($_FILES[$field]['tmp_name'], $snapDir . '/' . $destName);
                            }
                        }
                    }
                }

                $metaIn['saved_at'] = date('Y-m-d H:i:s');
                $metaIn['client_slug'] = $clientSlug;
                $metaIn['client_display'] = $clientMeta['display_name'];
                @file_put_contents($snapDir . '/meta.json', json_encode($metaIn, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), LOCK_EX);

                $judgment = $metaIn['diag_info']['judgment'] ?? [];
                $reason = (string)($judgment['reason'] ?? ($metaIn['diag_info']['reason'] ?? '核验未通过'));
                $targetId = (string)($metaIn['target_id'] ?? '');
                $targetName = (string)($metaIn['target_name'] ?? '');
                $cand = (int)($metaIn['candidate'] ?? 1);

                recordServerLog('warn', 'sender_py', 'verify_snapshot', [
                    'message' => sprintf('[%s] 核验现场快照：%s%s (候选%d) - %s', $clientMeta['display_name'], $targetId, $targetName, $cand, $reason),
                    'target_id' => $targetId,
                    'target_name' => $targetName,
                    'candidate' => $cand,
                    'reason' => $reason,
                    'date' => $dateStr,
                    'client_slug' => $clientSlug,
                    'prefix' => $safePrefix,
                ], [
                    'operator' => $clientMeta['operator'],
                    'source' => 'sender_py',
                    'client_slug' => $clientSlug,
                ]);

                sendResponse(true, ['prefix' => $safePrefix, 'date' => $dateStr, 'client_slug' => $clientSlug]);

            } elseif ($action === 'sender_control_pull') {
                $rawInput = file_get_contents('php://input');
                $input = json_decode($rawInput, true);
                if (!is_array($input)) {
                    $input = [];
                }
                $token = (string)($input['token'] ?? ($_POST['token'] ?? ''));
                if (!verifySenderApiToken($token)) {
                    sendResponse(false, null, '发送器鉴权失败', 200);
                }
                $serverIP = getClientIP();
                $clientInfo = is_array($input['client'] ?? null) ? $input['client'] : [];
                $rawSlug = (string)($clientInfo['client_slug'] ?? ($input['client_slug'] ?? ($clientInfo['hostname'] ?? 'unknown_pc')));
                $clientSlug = sanitizeSenderSlug($rawSlug);
                $activeFiles = is_array($input['active_files'] ?? null) ? $input['active_files'] : [];
                $runtimeState = is_array($input['runtime_state'] ?? null) ? $input['runtime_state'] : null;
                $ackCommands = is_array($input['ack_commands'] ?? null) ? $input['ack_commands'] : [];

                if (!empty($ackCommands)) {
                    acknowledgeClientCommands($clientSlug, $ackCommands);
                }
                if (!empty($clientInfo)) {
                    $dateStr = date('Y-m-d');
                    $clientDir = $senderLogDir . '/' . $dateStr . '/' . $clientSlug;
                    if (!is_dir($clientDir)) {
                        @mkdir($clientDir, 0755, true);
                    }
                    updateSenderClientMeta($clientDir, $clientInfo, $activeFiles, $serverIP, $runtimeState);
                }
                sendResponse(true, [
                    'client_slug' => $clientSlug,
                    'cloud_control' => buildEffectiveSenderControl($clientSlug),
                ]);

            } elseif ($action === 'sender_client_override') {
                verifySameOriginAdminPost();
                requireAdmin();
                $input = json_decode(file_get_contents('php://input'), true);
                if (!is_array($input)) {
                    sendResponse(false, null, '无效的请求载荷', 400);
                }
                $clientSlug = trim((string)($input['client_slug'] ?? ''));
                if ($clientSlug === '') {
                    sendResponse(false, null, '缺少 client_slug', 400);
                }
                $clearAll = !empty($input['clear']);
                $overrides = $clearAll ? [] : (is_array($input['overrides'] ?? null) ? $input['overrides'] : []);
                $note = $clearAll ? '' : (string)($input['note'] ?? '');
                $state = setClientControlOverrides($clientSlug, $overrides, $note);

                recordServerLog('action', 'admin', 'sender_client_override', [
                    'client_slug' => $state['client_slug'],
                    'clear' => $clearAll,
                    'overrides' => $state['overrides'],
                    'note' => $state['note'],
                    'message' => $clearAll
                        ? "已清空发送器 [{$state['client_slug']}] 的单机云控覆盖（恢复继承全局）"
                        : "已更新发送器 [{$state['client_slug']}] 的单机云控覆盖策略",
                ]);

                sendResponse(true, [
                    'client_slug' => $state['client_slug'],
                    'control' => $state,
                    'summary' => summarizeClientControlForAdmin($state['client_slug']),
                ]);

            } elseif ($action === 'sender_client_command') {
                verifySameOriginAdminPost();
                requireAdmin();
                $input = json_decode(file_get_contents('php://input'), true);
                if (!is_array($input)) {
                    sendResponse(false, null, '无效的请求载荷', 400);
                }
                $clientSlug = trim((string)($input['client_slug'] ?? ''));
                $cmdType = trim((string)($input['type'] ?? ''));
                $params = is_array($input['params'] ?? null) ? $input['params'] : [];
                if ($clientSlug === '' || $cmdType === '') {
                    sendResponse(false, null, '缺少 client_slug 或指令类型', 400);
                }
                $operator = trim((string)($_SESSION['username'] ?? ($_SESSION['admin_username'] ?? 'admin'))) ?: 'admin';
                $cmd = enqueueClientRemoteCommand($clientSlug, $cmdType, $params, $operator);
                if ($cmd === null) {
                    sendResponse(false, null, '不支持的远程指令类型: ' . htmlspecialchars($cmdType), 400);
                }

                $cmdLabels = [
                    'stop_batch' => '远程急停（暂停发送并保持断点）',
                    'refresh_policy' => '立即拉取最新云控策略',
                    'clear_roi' => '清除本机视野校准缓存',
                    'sync_logs' => '立即补传本地日志',
                ];
                recordServerLog('action', 'admin', 'sender_client_command', [
                    'client_slug' => $clientSlug,
                    'cmd_id' => $cmd['cmd_id'],
                    'type' => $cmd['type'],
                    'params' => $cmd['params'],
                    'message' => sprintf('管理员向 [%s] 下发远程指令：%s', $clientSlug, $cmdLabels[$cmd['type']] ?? $cmd['type']),
                ]);

                sendResponse(true, [
                    'command' => $cmd,
                    'summary' => summarizeClientControlForAdmin($clientSlug),
                ]);

            } else {
                sendResponse(false, null, '未知操作', 400);
            }
            break;

        case 'GET':
            if ($action === 'list') {
                requireAdmin();

                $page = max(1, intval($_GET['page'] ?? 1));
                $perPage = min(100, max(1, intval($_GET['perPage'] ?? 20)));
                $level = trim($_GET['level'] ?? '');
                $module = trim($_GET['module'] ?? '');
                $event = trim($_GET['event'] ?? '');
                $date = trim($_GET['date'] ?? '');
                $search = trim($_GET['search'] ?? '');
                $ip = trim($_GET['ip'] ?? '');
                $fingerprint = trim($_GET['fingerprint'] ?? '');

                $db = DB::getConnection();
                if ($db) {
                    $where = [];
                    $params = [];

                    if ($level) {
                        $where[] = "level = ?";
                        $params[] = $level;
                    }
                    if ($module) {
                        $where[] = "module = ?";
                        $params[] = $module;
                    }
                    if ($event) {
                        $where[] = "event LIKE ?";
                        $params[] = "%$event%";
                    }
                    if ($date && preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
                        $where[] = "DATE(created_at) = ?";
                        $params[] = $date;
                    }
                    if ($ip) {
                        $where[] = "client_ip LIKE ?";
                        $params[] = "%$ip%";
                    }
                    if ($search) {
                        $where[] = "(event LIKE ? OR module LIKE ? OR details LIKE ? OR client_ip LIKE ? OR operator LIKE ?)";
                        $params[] = "%$search%";
                        $params[] = "%$search%";
                        $params[] = "%$search%";
                        $params[] = "%$search%";
                        $params[] = "%$search%";
                    }
                    if ($fingerprint) {
                        $where[] = "client_info LIKE ?";
                        $params[] = "%$fingerprint%";
                    }

                    $whereSql = !empty($where) ? "WHERE " . implode(' AND ', $where) : "";

                    // 统计数据
                    $statSql = "SELECT 
                        COUNT(*) as total,
                        COALESCE(SUM(level = 'error'), 0) as err_cnt,
                        COALESCE(SUM(level = 'warn'), 0) as warn_cnt,
                        COALESCE(SUM(level = 'action'), 0) as action_cnt,
                        COALESCE(SUM(level = 'info'), 0) as info_cnt,
                        COALESCE(SUM(event = 'save'), 0) as save_cnt,
                        COALESCE(SUM(event = 'delete'), 0) as del_cnt
                        FROM system_logs $whereSql";
                    
                    $statStmt = $db->prepare($statSql);
                    $statStmt->execute($params);
                    $statRow = $statStmt->fetch(PDO::FETCH_ASSOC);

                    $total = (int)($statRow['total'] ?? 0);
                    $totalPages = ceil($total / $perPage);
                    $offset = ($page - 1) * $perPage;

                    // 分页查询日志记录
                    $listSql = "SELECT * FROM system_logs $whereSql ORDER BY timestamp DESC LIMIT ? OFFSET ?";
                    $listStmt = $db->prepare($listSql);
                    $bindIdx = 1;
                    foreach ($params as $p) {
                        $listStmt->bindValue($bindIdx++, $p);
                    }
                    $listStmt->bindValue($bindIdx++, $perPage, PDO::PARAM_INT);
                    $listStmt->bindValue($bindIdx++, $offset, PDO::PARAM_INT);
                    $listStmt->execute();

                    $rows = $listStmt->fetchAll(PDO::FETCH_ASSOC);
                    $logs = [];

                    foreach ($rows as $r) {
                        $logs[] = [
                            'id' => $r['log_id'],
                            'timestamp' => (float)$r['timestamp'],
                            'level' => $r['level'],
                            'module' => $r['module'],
                            'event' => $r['event'],
                            'operator' => $r['operator'] ?? '',
                            'details' => $r['details'] ? json_decode($r['details'], true) : [],
                            'context' => $r['context'] ? json_decode($r['context'], true) : [],
                            'client' => $r['client_info'] ? json_decode($r['client_info'], true) : ['ip' => $r['client_ip']]
                        ];
                    }

                    // 获取可用日期列表
                    $datesStmt = $db->query("SELECT DISTINCT DATE(created_at) as log_date FROM system_logs ORDER BY log_date DESC LIMIT 30");
                    $dbDates = $datesStmt->fetchAll(PDO::FETCH_COLUMN);

                    sendResponse(true, [
                        'logs' => $logs,
                        'pagination' => [
                            'page' => $page,
                            'perPage' => $perPage,
                            'total' => $total,
                            'totalPages' => $totalPages
                        ],
                        'stats' => [
                            'total' => $total,
                            'error' => (int)$statRow['err_cnt'],
                            'warn' => (int)$statRow['warn_cnt'],
                            'action' => (int)$statRow['action_cnt'],
                            'info' => (int)$statRow['info_cnt'],
                            'save' => (int)$statRow['save_cnt'],
                            'delete' => (int)$statRow['del_cnt']
                        ],
                        'dates' => !empty($dbDates) ? $dbDates : getAvailableDatesFromDisk($logDir)
                    ]);
                }

                // 降级回退：报错提示
                sendResponse(false, null, '数据库暂时不可用', 500);

            } elseif ($action === 'filters') {
                requireAdmin();

                $db = DB::getConnection();
                if ($db) {
                    $modules = $db->query("SELECT DISTINCT module FROM system_logs WHERE module IS NOT NULL AND module != '' ORDER BY module")->fetchAll(PDO::FETCH_COLUMN);
                    if (!in_array('sender_py', $modules, true)) {
                        $modules[] = 'sender_py';
                    }
                    $events = $db->query("SELECT DISTINCT event FROM system_logs WHERE event IS NOT NULL AND event != '' ORDER BY event LIMIT 50")->fetchAll(PDO::FETCH_COLUMN);
                    $ips = $db->query("SELECT DISTINCT client_ip FROM system_logs WHERE client_ip IS NOT NULL AND client_ip != '' ORDER BY client_ip LIMIT 50")->fetchAll(PDO::FETCH_COLUMN);
                    $levels = ['error', 'warn', 'action', 'info'];
                    $dates = $db->query("SELECT DISTINCT DATE(created_at) as log_date FROM system_logs ORDER BY log_date DESC LIMIT 30")->fetchAll(PDO::FETCH_COLUMN);

                    sendResponse(true, [
                        'modules' => $modules,
                        'events' => $events,
                        'ips' => $ips,
                        'levels' => $levels,
                        'dates' => !empty($dates) ? $dates : getAvailableDatesFromDisk($logDir),
                        'subjects' => [],
                        'fingerprints' => []
                    ]);
                }

                sendResponse(true, [
                    'modules' => ['viewer', 'upload', 'qbank', 'admin', 'sender_py'],
                    'events' => [],
                    'ips' => [],
                    'levels' => ['error', 'warn', 'action', 'info'],
                    'dates' => getAvailableDatesFromDisk($logDir)
                ]);

            } elseif ($action === 'sender_clients') {
                requireAdmin();

                $reqDate = trim($_GET['date'] ?? '');
                $dateDirs = glob($senderLogDir . '/????-??-??', GLOB_ONLYDIR) ?: [];
                $availableDates = array_map('basename', $dateDirs);
                rsort($availableDates);

                $targetDates = [];
                if ($reqDate !== '' && preg_match('/^\d{4}-\d{2}-\d{2}$/', $reqDate)) {
                    $targetDates = [$reqDate];
                } else {
                    $targetDates = array_slice($availableDates, 0, 7);
                }

                $clientsList = [];
                foreach ($targetDates as $dStr) {
                    $dPath = $senderLogDir . '/' . $dStr;
                    if (!is_dir($dPath)) continue;
                    foreach (glob($dPath . '/*', GLOB_ONLYDIR) ?: [] as $cDir) {
                        $cSlug = basename($cDir);
                        $metaFile = $cDir . '/meta.json';
                        $meta = is_file($metaFile) ? (@json_decode(@file_get_contents($metaFile), true) ?: []) : [];

                        $senderLogPath = $cDir . '/sender_' . $dStr . '.log';
                        $errorLogPath = $cDir . '/error_' . $dStr . '.log';
                        $senderSize = is_file($senderLogPath) ? (int)@filesize($senderLogPath) : 0;
                        $errorSize = is_file($errorLogPath) ? (int)@filesize($errorLogPath) : 0;

                        // 读取批次汇总记录
                        $batches = [];
                        $batchesFile = $cDir . '/batches.jsonl';
                        if (is_file($batchesFile)) {
                            $bLines = @file($batchesFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];
                            foreach (array_reverse($bLines) as $bl) {
                                $bObj = @json_decode($bl, true);
                                if (is_array($bObj)) {
                                    $batches[] = $bObj;
                                }
                            }
                        }

                        // 读取核验失败/拦截现场快照
                        $snapshots = [];
                        $snapsRoot = $cDir . '/snapshots';
                        if (is_dir($snapsRoot)) {
                            $sDirs = glob($snapsRoot . '/*', GLOB_ONLYDIR) ?: [];
                            usort($sDirs, fn($a, $b) => (@filemtime($b) ?: 0) <=> (@filemtime($a) ?: 0));
                            foreach (array_slice($sDirs, 0, 50) as $sDir) {
                                $sPrefix = basename($sDir);
                                $sMetaFile = $sDir . '/meta.json';
                                $sMeta = is_file($sMetaFile) ? (@json_decode(@file_get_contents($sMetaFile), true) ?: []) : [];
                                $judgment = $sMeta['diag_info']['judgment'] ?? [];
                                $snapshots[] = [
                                    'prefix' => $sPrefix,
                                    'timestamp' => $sMeta['timestamp'] ?? $sPrefix,
                                    'saved_at' => $sMeta['saved_at'] ?? '',
                                    'target_id' => $sMeta['target_id'] ?? '',
                                    'target_name' => $sMeta['target_name'] ?? '',
                                    'candidate' => $sMeta['candidate'] ?? 1,
                                    'matched' => $judgment['matched'] ?? false,
                                    'is_group' => $judgment['is_group'] ?? false,
                                    'detected_title' => $judgment['detected_title'] ?? '',
                                    'reason' => $judgment['reason'] ?? ($sMeta['diag_info']['reason'] ?? ''),
                                    'has_title' => is_file($sDir . '/title.png'),
                                    'has_annotated' => is_file($sDir . '/annotated.png'),
                                ];
                            }
                        }

                        $clientsList[] = [
                            'date' => $dStr,
                            'client_slug' => $cSlug,
                            'display_name' => $meta['display_name'] ?? $cSlug,
                            'teacher_note' => $meta['teacher_note'] ?? '',
                            'hostname' => $meta['hostname'] ?? $cSlug,
                            'os_user' => $meta['os_user'] ?? '',
                            'ip' => $meta['ip'] ?? '',
                            'app_version' => $meta['app_version'] ?? '',
                            'active_files' => $meta['active_files'] ?? [],
                            'runtime_state' => is_array($meta['runtime_state'] ?? null) ? $meta['runtime_state'] : [],
                            'control_summary' => summarizeClientControlForAdmin($cSlug),
                            'last_sync_at' => $meta['last_sync_at'] ?? '',
                            'last_sync_ts' => (int)($meta['last_sync_ts'] ?? (@filemtime($cDir) ?: 0)),
                            'has_sender_log' => $senderSize > 0,
                            'sender_log_size_kb' => round($senderSize / 1024, 2),
                            'has_error_log' => $errorSize > 0,
                            'error_log_size_kb' => round($errorSize / 1024, 2),
                            'batches' => $batches,
                            'snapshots' => $snapshots,
                        ];
                    }
                }

                usort($clientsList, fn($a, $b) => ($b['last_sync_ts'] <=> $a['last_sync_ts']));

                sendResponse(true, [
                    'dates' => $availableDates,
                    'clients' => $clientsList,
                    'global_sender_control' => loadGlobalSenderControl(),
                ]);

            } elseif ($action === 'sender_client_control') {
                requireAdmin();
                $clientSlug = trim((string)($_GET['client'] ?? ''));
                if ($clientSlug === '') {
                    sendResponse(false, null, '缺少 client 参数', 400);
                }
                sendResponse(true, [
                    'client_slug' => sanitizeControlSlug($clientSlug),
                    'global' => loadGlobalSenderControl(),
                    'client_control' => loadClientControlState($clientSlug),
                    'summary' => summarizeClientControlForAdmin($clientSlug),
                ]);

            } elseif ($action === 'sender_control_pull') {
                $token = (string)($_GET['token'] ?? ($_SERVER['HTTP_X_SENDER_TOKEN'] ?? ''));
                if (!verifySenderApiToken($token)) {
                    sendResponse(false, null, '发送器鉴权失败', 200);
                }
                $clientSlug = sanitizeSenderSlug((string)($_GET['client_slug'] ?? 'unknown_pc'));
                sendResponse(true, [
                    'client_slug' => $clientSlug,
                    'cloud_control' => buildEffectiveSenderControl($clientSlug),
                ]);

            } elseif ($action === 'sender_log_file') {
                requireAdmin();

                $dateStr = sanitizeSenderDate((string)($_GET['date'] ?? date('Y-m-d')));
                $clientSlug = sanitizeSenderSlug((string)($_GET['client'] ?? ''));
                $logType = (($_GET['type'] ?? 'sender') === 'error') ? 'error' : 'sender';
                $maxLines = min(10000, max(50, intval($_GET['lines'] ?? 2000)));
                $isDownload = !empty($_GET['download']);

                $filePath = $senderLogDir . '/' . $dateStr . '/' . $clientSlug . '/' . $logType . '_' . $dateStr . '.log';
                if (!is_file($filePath)) {
                    if ($isDownload) {
                        header('HTTP/1.1 404 Not Found');
                        echo "日志文件不存在";
                        exit;
                    }
                    sendResponse(false, null, '指定的日志文件不存在', 404);
                }

                if ($isDownload) {
                    $dlName = $clientSlug . '_' . $logType . '_' . $dateStr . '.log';
                    header('Content-Type: text/plain; charset=utf-8');
                    header('Content-Disposition: attachment; filename="' . $dlName . '"');
                    header('Content-Length: ' . filesize($filePath));
                    readfile($filePath);
                    exit;
                }

                $allLines = @file($filePath, FILE_IGNORE_NEW_LINES) ?: [];
                $totalLines = count($allLines);
                if ($totalLines > $maxLines) {
                    $allLines = array_slice($allLines, -$maxLines);
                }
                sendResponse(true, [
                    'date' => $dateStr,
                    'client_slug' => $clientSlug,
                    'type' => $logType,
                    'filename' => $logType . '_' . $dateStr . '.log',
                    'total_lines' => $totalLines,
                    'size_kb' => round(filesize($filePath) / 1024, 2),
                    'content' => implode("\n", $allLines),
                ]);

            } elseif ($action === 'sender_snapshot_img') {
                requireAdmin();

                $dateStr = sanitizeSenderDate((string)($_GET['date'] ?? ''));
                $clientSlug = sanitizeSenderSlug((string)($_GET['client'] ?? ''));
                $rawPrefix = (string)($_GET['prefix'] ?? '');
                $safePrefix = preg_replace('/[^a-zA-Z0-9_\-\x{4e00}-\x{9fa5}]/u', '_', basename($rawPrefix));
                $imgType = (($_GET['img'] ?? 'title') === 'annotated') ? 'annotated.png' : 'title.png';

                $imgPath = $senderLogDir . '/' . $dateStr . '/' . $clientSlug . '/snapshots/' . $safePrefix . '/' . $imgType;
                if (!is_file($imgPath)) {
                    header('HTTP/1.1 404 Not Found');
                    exit;
                }
                $info = @getimagesize($imgPath);
                $mime = ($info && !empty($info['mime'])) ? $info['mime'] : 'image/png';
                header('Content-Type: ' . $mime);
                header('Content-Length: ' . filesize($imgPath));
                header('Cache-Control: private, max-age=3600');
                readfile($imgPath);
                exit;

            } elseif ($action === 'export') {
                requireAdmin();

                $db = DB::getConnection();
                if (!$db) {
                    sendResponse(false, null, '数据库连接失败', 500);
                }

                $level = trim($_GET['level'] ?? '');
                $module = trim($_GET['module'] ?? '');
                $event = trim($_GET['event'] ?? '');
                $date = trim($_GET['date'] ?? '');
                $search = trim($_GET['search'] ?? '');
                $ip = trim($_GET['ip'] ?? '');

                $where = [];
                $params = [];
                if ($level) { $where[] = "level = ?"; $params[] = $level; }
                if ($module) { $where[] = "module = ?"; $params[] = $module; }
                if ($event) { $where[] = "event LIKE ?"; $params[] = "%$event%"; }
                if ($date && preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) { $where[] = "DATE(created_at) = ?"; $params[] = $date; }
                if ($ip) { $where[] = "client_ip LIKE ?"; $params[] = "%$ip%"; }
                if ($search) {
                    $where[] = "(event LIKE ? OR module LIKE ? OR details LIKE ? OR client_ip LIKE ? OR operator LIKE ?)";
                    $params[] = "%$search%";
                    $params[] = "%$search%";
                    $params[] = "%$search%";
                    $params[] = "%$search%";
                    $params[] = "%$search%";
                }

                $whereSql = !empty($where) ? "WHERE " . implode(' AND ', $where) : "";

                header('Content-Type: text/csv; charset=utf-8');
                header('Content-Disposition: attachment; filename=logs_' . date('Ymd_His') . '.csv');
                header('Pragma: no-cache');
                header('Expires: 0');

                $output = fopen('php://output', 'w');
                fprintf($output, chr(0xEF).chr(0xBB).chr(0xBF));
                fputcsv($output, ['时间', '级别', '模块', '事件', '操作人/设备', '详情', '页面', '学科', 'Session', 'IP 地址', '用户代理']);

                $stmt = $db->prepare("SELECT * FROM system_logs $whereSql ORDER BY timestamp DESC LIMIT 5000");
                $stmt->execute($params);

                while ($r = $stmt->fetch(PDO::FETCH_ASSOC)) {
                    $timestamp = $r['created_at'];
                    $lvl = getLevelLabel($r['level']);
                    $mod = $r['module'];
                    $ev = $r['event'];
                    $op = $r['operator'] ?: '-';
                    $detailsObj = $r['details'] ? json_decode($r['details'], true) : [];
                    $detailsStr = formatDetailsForExport(['details' => $detailsObj]);
                    $contextObj = $r['context'] ? json_decode($r['context'], true) : [];
                    $page = $contextObj['page'] ?? '-';
                    $subject = $contextObj['subject'] ?? ($detailsObj['subject'] ?? '-');
                    $sessionId = $contextObj['sessionId'] ?? '-';
                    $clientIp = $r['client_ip'] ?: '-';
                    $clientObj = $r['client_info'] ? json_decode($r['client_info'], true) : [];
                    $ua = $clientObj['userAgent'] ?? '-';

                    $csvRow = array_map('sanitizeCsvCell', [
                        $timestamp, $lvl, $mod, $ev, $op, $detailsStr, $page, $subject, $sessionId, $clientIp, $ua
                    ]);
                    fputcsv($output, $csvRow);
                }

                fclose($output);
                exit;

            } elseif ($action === 'stats') {
                requireAdmin();
                $db = DB::getConnection();
                $dailyStats = [];
                $dates = [];

                if ($db) {
                    $statRows = $db->query("SELECT 
                        DATE(created_at) as log_date,
                        COUNT(*) as total,
                        COALESCE(SUM(level = 'error'), 0) as error,
                        COALESCE(SUM(level = 'warn'), 0) as warn,
                        COALESCE(SUM(level = 'action'), 0) as action,
                        COALESCE(SUM(level = 'info'), 0) as info
                        FROM system_logs 
                        GROUP BY log_date 
                        ORDER BY log_date DESC 
                        LIMIT 7")->fetchAll(PDO::FETCH_ASSOC);

                    foreach ($statRows as $row) {
                        $dates[] = $row['log_date'];
                        $dailyStats[] = [
                            'date' => $row['log_date'],
                            'total' => (int)$row['total'],
                            'error' => (int)$row['error'],
                            'warn' => (int)$row['warn'],
                            'action' => (int)$row['action'],
                            'info' => (int)$row['info']
                        ];
                    }
                }

                sendResponse(true, [
                    'dates' => $dates,
                    'dailyStats' => $dailyStats,
                    'retentionDays' => LOG_RETENTION_DAYS
                ]);

            } else {
                sendResponse(false, null, '未知操作', 400);
            }
            break;

        case 'DELETE':
            requireAdmin();
            $db = DB::getConnection();
            $deleteAction = $_GET['action'] ?? '';

            if ($deleteAction === 'clear') {
                $date = $_GET['date'] ?? '';
                if (!$date) {
                    sendResponse(false, null, '缺少日期参数', 400);
                }
                if ($db) {
                    $stmt = $db->prepare("DELETE FROM system_logs WHERE DATE(created_at) = ?");
                    $stmt->execute([$date]);
                    $cnt = $stmt->rowCount();
                    sendResponse(true, ['deleted' => $cnt, 'message' => "已删除 {$cnt} 条日志"]);
                }
                sendResponse(true, ['deleted' => 0, 'message' => '日志已清理']);
            } else {
                $id = trim($_GET['id'] ?? '');
                if (!$id) {
                    sendResponse(false, null, '缺少日志 ID', 400);
                }
                if ($db) {
                    $stmt = $db->prepare("DELETE FROM system_logs WHERE log_id = ? OR id = ?");
                    $stmt->execute([$id, $id]);
                    if ($stmt->rowCount() > 0) {
                        sendResponse(true, ['message' => '日志已删除']);
                    }
                }
                sendResponse(true, ['message' => '日志已删除']);
            }
            break;

        default:
            sendResponse(false, null, '不支持的请求方法', 405);
    }
} catch (Throwable $e) {
    error_log("logs.php uncaught error: " . $e->getMessage() . " at " . $e->getFile() . ":" . $e->getLine());
    sendResponse(false, null, '服务器错误: 日志系统服务异常', 500);
}
