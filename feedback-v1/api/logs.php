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

$logDir = __DIR__ . '/../data/logs';
if (!is_dir($logDir)) {
    @mkdir($logDir, 0755, true);
}

const LOG_RETENTION_DAYS = 30;

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
                        $where[] = "(event LIKE ? OR module LIKE ? OR details LIKE ? OR client_ip LIKE ?)";
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
                    'modules' => ['viewer', 'upload', 'qbank', 'admin'],
                    'events' => [],
                    'ips' => [],
                    'levels' => ['error', 'warn', 'action', 'info'],
                    'dates' => getAvailableDatesFromDisk($logDir)
                ]);

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
                    $where[] = "(event LIKE ? OR module LIKE ? OR details LIKE ? OR client_ip LIKE ?)";
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
                fputcsv($output, ['时间', '级别', '模块', '事件', '详情', '页面', '学科', 'Session', 'IP 地址', '用户代理']);

                $stmt = $db->prepare("SELECT * FROM system_logs $whereSql ORDER BY timestamp DESC LIMIT 5000");
                $stmt->execute($params);

                while ($r = $stmt->fetch(PDO::FETCH_ASSOC)) {
                    $timestamp = $r['created_at'];
                    $lvl = getLevelLabel($r['level']);
                    $mod = $r['module'];
                    $ev = $r['event'];
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
                        $timestamp, $lvl, $mod, $ev, $detailsStr, $page, $subject, $sessionId, $clientIp, $ua
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
