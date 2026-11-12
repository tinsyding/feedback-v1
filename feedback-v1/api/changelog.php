<?php
require_once __DIR__ . '/bootstrap.php';

$dataFile = dirname(__DIR__) . '/data/changelog.json';

// Initialize file if not exists
if (!file_exists($dataFile)) {
    $initialData = [
        [
            "id" => "update_2026_11_12",
            "version" => "v1.2.0",
            "date" => "2026-11-12",
            "title" => "系统更新提示",
            "active" => true,
            "items" => [
                [
                    "title" => "首页单人错题录入工作台",
                    "desc" => "无需上传整班文件，在首页即可直接为单个学员录入或补录预习与课后错题，并即时生成专属错题本链接与薄弱考点家校反馈。"
                ]
            ]
        ],
        [
            "id" => "update_2026_03_21",
            "version" => "v1.1.0",
            "date" => "2026-03-21",
            "title" => "系统更新提示",
            "active" => false,
            "items" => [
                ["title" => "复姓反馈显示优化", "desc" => "全面优化了带有复姓（如：诸葛、欧阳）的学生的反馈系统显示与逻辑。"],
                ["title" => "全新接入退课识别（可选）", "desc" => "新增通过 jf-alpha.com 网站的实施名单来排除已退课的学生，避免生成冗余反馈。此功能为可选使用。"]
            ]
        ]
    ];
    file_put_contents($dataFile, json_encode($initialData, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
}

function getLogs()
{
    global $dataFile;
    $content = file_get_contents($dataFile);
    return json_decode($content, true) ?: [];
}

function saveLogs($logs)
{
    global $dataFile;
    file_put_contents($dataFile, json_encode($logs, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
}

$action = $_GET['action'] ?? $_POST['action'] ?? '';

try {
    switch ($action) {
        case 'getAll':
            echo json_encode(['success' => true, 'data' => getLogs()]);
            break;

        case 'getActive':
            $logs = getLogs();
            $activeLog = null;
            foreach ($logs as $log) {
                if (!empty($log['active'])) {
                    $activeLog = $log;
                    break;
                }
            }
            echo json_encode(['success' => true, 'data' => $activeLog]);
            break;

        case 'save':
            requireAdmin();
            $input = json_decode(file_get_contents('php://input'), true);
            if (!$input || !isset($input['log'])) {
                throw new Exception('无效的数据');
            }
            $newLog = $input['log'];
            $logs = getLogs();

            // If new log is active, deactivate others
            if (!empty($newLog['active'])) {
                foreach ($logs as &$log) {
                    $log['active'] = false;
                }
            }

            $found = false;
            foreach ($logs as &$log) {
                if ($log['id'] === $newLog['id']) {
                    $log = $newLog;
                    $found = true;
                    break;
                }
            }
            if (!$found) {
                if (empty($newLog['id'])) {
                    $newLog['id'] = 'update_' . time();
                }
                array_unshift($logs, $newLog);
            }

            saveLogs($logs);
            echo json_encode(['success' => true]);
            break;

        case 'delete':
            requireAdmin();
            $input = json_decode(file_get_contents('php://input'), true);
            if (!$input || empty($input['id'])) {
                throw new Exception('缺少ID');
            }
            $logs = getLogs();
            $logs = array_values(array_filter($logs, function ($l) use ($input) {
                return $l['id'] !== $input['id'];
            }));
            saveLogs($logs);
            echo json_encode(['success' => true]);
            break;

        case 'setActive':
            requireAdmin();
            $input = json_decode(file_get_contents('php://input'), true);
            if (!$input || empty($input['id'])) {
                throw new Exception('缺少ID');
            }
            $logs = getLogs();
            foreach ($logs as &$log) {
                $log['active'] = ($log['id'] === $input['id']);
            }
            saveLogs($logs);
            echo json_encode(['success' => true]);
            break;

        default:
            throw new Exception('未知的操作');
    }
}
catch (Throwable $e) {
    error_log("changelog.php error: " . $e->getMessage() . "\n" . $e->getTraceAsString());
    $msg = $e->getMessage();
    $knownMessages = ['未知的操作', '无效的数据', '缺少ID'];
    $outMsg = in_array($msg, $knownMessages, true) ? $msg : '系统服务异常，请稍后重试';
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => $outMsg], JSON_UNESCAPED_UNICODE);
}
