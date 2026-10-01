<?php
/**
 * 桌面发送工具云端诊断接口 (api/desktop.php)
 *
 * 桌面端为单机程序，启动/退出时自动在后台上报诊断日志与发送历史，
 * 供管理员远程协助排查（后台日志页按 module=desktop 过滤；历史快照走 admin 通用 CRUD 查 desktop_uploads 表）。
 * 无需账号密码：上报方以机器指纹标识，服务端记为未核验来源（operator=anon:*），
 * 仅用于排查参考，不作为业务依据。
 *
 * 上报内容：diagnostic 日志（末尾 300 行）、发送历史快照。含学生隐私数据，
 * 上报即视为老师知情（程序内不再二次弹窗）。
 *
 * 限频：每 IP 每分钟最多 30 次（文件锁计数，与 logs.php 同策略）。
 * 载荷上限：日志 ≤100 条/次；历史快照 ≤512KB（超限 413）。
 *
 * POST ?action=upload_logs     { client, entries: [{ts?, level?, msg}] }
 * POST ?action=upload_history  { client, history: {...} }
 * 兼容旧版桌面端：仍可传 username/password，经 users 表 bcrypt 核验后记为该教师。
 */

require_once __DIR__ . '/bootstrap.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/logs.php';

const DESKTOP_MAX_LOG_ENTRIES = 100;
const DESKTOP_MAX_HISTORY_BYTES = 524288; // 512KB
const DESKTOP_RATE_LIMIT = 30;
const DESKTOP_VISION_RATE_LIMIT = 120; // 视觉检测允许更高频调用以适应批量发送节奏

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'error' => 'Method Not Allowed'], JSON_UNESCAPED_UNICODE);
    exit;
}

$action = $_GET['action'] ?? '';

/** IP 级限频（桌面端无 session，只能按 IP） */
function desktopCheckRateLimit(string $ip, int $limit = DESKTOP_RATE_LIMIT): void {
    $f = sys_get_temp_dir() . '/jf_desktop_rate_' . md5($ip) . '.json';
    $now = time();
    $info = ['count' => 0, 'window' => $now];
    if (is_file($f)) {
        $cached = json_decode(@file_get_contents($f), true);
        if (is_array($cached) && isset($cached['window']) && ($now - (int)$cached['window']) < 60) {
            $info = $cached;
        }
    }
    if ((int)($info['count'] ?? 0) >= $limit) {
        http_response_code(429);
        echo json_encode(['success' => false, 'error' => '请求过于频繁，请稍后再试'], JSON_UNESCAPED_UNICODE);
        exit;
    }
    $info['count'] = (int)($info['count'] ?? 0) + 1;
    if (empty($info['window'])) {
        $info['window'] = $now;
    }
    @file_put_contents($f, json_encode($info), LOCK_EX);
}

/** 校验教师账号（users 表，status=1，bcrypt；测试账号 0 拒绝） */
function desktopAuthTeacher(string $username, string $password): array {
    if ($username === '' || $password === '') {
        sendResponse(false, null, '请输入教师账号和密码', 400);
    }
    if ($username === '0') {
        sendResponse(false, null, '测试账号不支持云端诊断', 403);
    }
    try {
        $user = DB::fetchOne("SELECT * FROM `users` WHERE `username` = ? LIMIT 1", [$username]);
    } catch (Throwable $e) {
        error_log("desktop auth db error: " . $e->getMessage());
        sendResponse(false, null, '数据库服务异常', 500);
    }
    if (!$user || intval($user['status']) !== 1
        || empty($user['password_hash']) || !password_verify($password, $user['password_hash'])) {
        recordServerLog('warn', 'desktop', 'cloud_auth_failed', [
            'username' => $username,
            'ip' => getClientIp(),
            'message' => "桌面端云端诊断鉴权失败: {$username}"
        ]);
        sendResponse(false, null, '账号或密码错误', 401);
    }
    return $user;
}

/**
 * 获取视觉大模型运行时配置 (优先 data/vision_config.json -> secret_key.local.php -> 环境变量)
 */
function getVisionRuntimeConfig(): array {
    $cfgFile = dirname(__DIR__) . '/data/vision_config.json';
    $config = [];
    if (file_exists($cfgFile)) {
        $parsed = json_decode(@file_get_contents($cfgFile), true);
        if (is_array($parsed)) {
            $config = $parsed;
        }
    }

    if (empty($config['base_url'])) {
        $config['base_url'] = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
    }
    if (empty($config['model'])) {
        $config['model'] = 'qwen3.8-flash';
    }

    if (empty($config['api_key'])) {
        $secretKeyFile = __DIR__ . '/secret_key.local.php';
        if (file_exists($secretKeyFile)) {
            $keys = @include $secretKeyFile;
            if (is_array($keys) && !empty($keys['dashscopeApiKey'])) {
                $config['api_key'] = $keys['dashscopeApiKey'];
            }
        }
    }
    if (empty($config['api_key'])) {
        $secretKeyFile = __DIR__ . '/secret_key.php';
        if (file_exists($secretKeyFile)) {
            $keys = @include $secretKeyFile;
            if (is_array($keys) && !empty($keys['dashscopeApiKey'])) {
                $config['api_key'] = $keys['dashscopeApiKey'];
            }
        }
    }
    if (empty($config['api_key'])) {
        $config['api_key'] = getenv('DASHSCOPE_API_KEY') ?: '';
    }

    return $config;
}

/**
 * 调用多模态视觉模型 (支持根据后台配置动态切换模型、端点与提示词模板)
 */
function callDashScopeVision(string $apiKey, string $task, string $targetId, string $targetName, string $imageBase64): array {
    $imgUrl = $imageBase64;
    if (!str_starts_with($imgUrl, 'data:image/')) {
        $imgUrl = 'data:image/jpeg;base64,' . $imgUrl;
    }

    $runtimeCfg = getVisionRuntimeConfig();
    $useApiKey = !empty($apiKey) ? $apiKey : ($runtimeCfg['api_key'] ?? '');
    $baseUrl = $runtimeCfg['base_url'] ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
    $model = $runtimeCfg['model'] ?? 'qwen3.8-flash';

    if (empty($useApiKey)) {
        throw new RuntimeException("服务端未配置视觉模型 API 密钥 (DASHSCOPE_API_KEY 或后台设置)");
    }

    if ($task === 'dropdown') {
        $template = $runtimeCfg['prompt_dropdown'] ?? '';
        if (empty($template)) {
            $template = "你是一个企业微信搜索下拉结果决策专家。请仔细观察这张企业微信搜索下拉候选人列表的截屏，找出目标学生本人或其家长，并判定其排在候选列表的第几项。\n\n" .
                        "【目标学生信息】：\n" .
                        "- 目标学号：{target_id}\n" .
                        "- 目标姓名：{target_name}\n\n" .
                        "【核心判定准则与红线禁令】：\n" .
                        "1. 【红线：严禁选择群聊！】：目标必须且只能是“联系人”分类下的独立个人微信/企微联系人！“群聊”分类下的任何群聊（如班级群、教研群、助教群、交流群等）无论其名称或下方包含文字如何，绝对不可作为候选目标！若“联系人”下没有目标本人的独立条目，一律判定为未找到本人！\n" .
                        "2. 【本人条目判定】：观察“联系人”分类下的条目。条目的主标题（大字加粗标题）中直接包含目标学号（例如 \"{target_id}\"）或目标姓名（例如 \"{target_name}\"、\"{target_name}家长\"、\"{target_name}妈妈\"）。其下方浅灰色小字即使显示其他微信昵称（如 \"微信昵称: 花开富贵\"），只要主标题是本人备注，即为本人条目！\n" .
                        "3. 【他人描述/聊天记录】：条目主标题是其他人（例如 \"90001张三@微信\"），下方浅灰色小字写着“描述: {target_id}”或“包含: {target_id}”或“聊天记录: ...”。这代表在他人备注或聊天记录中提到了该学生，绝对不是目标本人！\n" .
                        "4. 【候选条目排序编号】：按搜索结果从上往下可点击的条目顺序计数（第 1 项、第 2 项、第 3 项...，忽略纯分类标签文本如“联系人”）。\n\n" .
                        "请输出严格 JSON 格式：\n" .
                        "{\n" .
                        "  \"target_found\": true,\n" .
                        "  \"choice\": 1,\n" .
                        "  \"matched_title\": \"命中条目的主标题，未找到则填空字符串\",\n" .
                        "  \"reason\": \"简述判定理由\"\n" .
                        "}\n\n" .
                        "【choice 取值规范】：\n" .
                        "- 1: 列表第 1 项即为目标本人独立联系人\n" .
                        "- 2~4: 列表第 1 项是他人描述，第 choice 项才是目标本人独立联系人（程序将自动按向下键纠偏）\n" .
                        "- -2: 目标仅在他人描述、聊天记录或群聊中被提及，通讯录中不存在其独立联系人（安全拦截防误发）\n" .
                        "- 0: 未找到该联系人 / 列表为空 / 显示“进入全局搜索”或“网络查找”（安全跳过）";
        }
        $prompt = str_replace(['{target_id}', '{target_name}'], [$targetId, $targetName], $template);
    } else {
        $template = $runtimeCfg['prompt_header'] ?? '';
        if (empty($template)) {
            $template = "你是一个企业微信会话标题核验专家。请仔细观察这张企业微信聊天窗口顶部的标题栏截图，核实当前会话是否为目标学生本人或其家长。\n\n" .
                        "【目标学生信息】：\n" .
                        "- 目标学号：{target_id}\n" .
                        "- 目标姓名：{target_name}\n\n" .
                        "【判断准则】：\n" .
                        "1. 标题中只要包含目标学号（例如 \"{target_id}\"）或目标姓名（例如 \"{target_name}\"、\"{target_name}妈妈\"、\"{target_name}家长\"），均判定为匹配成功！允许包含各类表情符号（如 💐、🌸）和系统后缀（如 \"@微信\"）。\n" .
                        "2. 若标题明确属于其他联系人（例如包含其他学生姓名、其他四位以上学号，且完全不含目标学生），判定为不匹配。\n" .
                        "3. 若截图完全空白或未见有效文字，判定为存疑。\n\n" .
                        "请输出严格 JSON 格式：\n" .
                        "{\n" .
                        "  \"matched\": true,\n" .
                        "  \"detected_title\": \"识别出的完整标题文本\",\n" .
                        "  \"reason\": \"简述判定理由\"\n" .
                        "}";
        }
        $prompt = str_replace(['{target_id}', '{target_name}'], [$targetId, $targetName], $template);
    }

    $payload = [
        'model' => $model,
        'enable_thinking' => false,
        'messages' => [
            [
                'role' => 'user',
                'content' => [
                    [
                        'type' => 'image_url',
                        'image_url' => ['url' => $imgUrl]
                    ],
                    [
                        'type' => 'text',
                        'text' => $prompt
                    ]
                ]
            ]
        ],
        'response_format' => ['type' => 'json_object'],
        'max_tokens' => 300
    ];

    $ch = curl_init($baseUrl);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => [
            'Authorization: Bearer ' . $useApiKey,
            'Content-Type: application/json'
        ],
        CURLOPT_TIMEOUT => 15,
        CURLOPT_SSL_VERIFYPEER => true
    ]);

    $startTime = microtime(true);
    $response = curl_exec($ch);
    $durationMs = (int)round((microtime(true) - $startTime) * 1000);
    $curlErr = curl_error($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($curlErr) {
        throw new RuntimeException("大模型接口网络异常: " . $curlErr);
    }
    if ($httpCode !== 200) {
        $errDetail = json_decode($response, true);
        $errMsg = $errDetail['error']['message'] ?? $errDetail['message'] ?? "HTTP {$httpCode}";
        throw new RuntimeException("大模型服务返回异常: {$errMsg}");
    }

    $resData = json_decode($response, true);
    $content = $resData['choices'][0]['message']['content'] ?? '';
    $parsed = json_decode($content, true);
    if (!is_array($parsed)) {
        throw new RuntimeException("模型返回了无法解析的非 JSON 内容");
    }

    $parsed['duration_ms'] = $durationMs;
    return $parsed;
}

$clientIp = getClientIp();
$rateLimit = ($action === 'vision_detect') ? DESKTOP_VISION_RATE_LIMIT : DESKTOP_RATE_LIMIT;
desktopCheckRateLimit($clientIp, $rateLimit);

$input = json_decode(file_get_contents('php://input'), true) ?: [];
$username = trim((string)($input['username'] ?? ''));
$password = (string)($input['password'] ?? '');
$clientTag = substr(trim((string)($input['client'] ?? '')), 0, 100);

// 身份归属：提供账号密码则核验为教师；否则按匿名机器上报（需带 client 指纹）
$operator = '';
$realName = '';
if ($username === '' && $password === '') {
    $fp = substr(preg_replace('/[^A-Za-z0-9_\-]/', '', $clientTag) ?: 'pc', 0, 50);
    if ($clientTag === '') {
        sendResponse(false, null, '缺少机器标识', 400);
    }
    $operator = 'anon:' . $fp;
} else {
    $user = desktopAuthTeacher($username, $password);
    $realName = $user['real_name'] ?? $username;
    $operator = $username;
}

switch ($action) {
    case 'upload_logs': {
        $entries = $input['entries'] ?? [];
        if (!is_array($entries) || empty($entries)) {
            sendResponse(false, null, '没有可上传的日志条目', 400);
        }
        $entries = array_slice(array_values($entries), 0, DESKTOP_MAX_LOG_ENTRIES);
        $allowedLevels = ['info' => 'info', 'warn' => 'warn', 'error' => 'error', 'action' => 'action'];
        $saved = 0;
        foreach ($entries as $e) {
            if (!is_array($e)) {
                continue;
            }
            $level = strtolower(trim((string)($e['level'] ?? 'info')));
            $level = $allowedLevels[$level] ?? 'info';
            $msg = substr(trim((string)($e['msg'] ?? '')), 0, 2000);
            if ($msg === '') {
                continue;
            }
            recordServerLog($level, 'desktop', 'cloud_log', [
                'message' => $msg,
                'client' => $clientTag,
                'client_ts' => isset($e['ts']) ? substr((string)$e['ts'], 0, 40) : ''
            ], [
                'operator' => $operator
            ]);
            $saved++;
        }
        recordServerLog('action', 'desktop', 'cloud_logs_uploaded', [
            'username' => $operator,
            'real_name' => $realName,
            'count' => $saved,
            'client' => $clientTag,
            'message' => "桌面端 {$operator} 上传了 {$saved} 条诊断日志"
        ]);
        sendResponse(true, ['saved' => $saved, 'message' => "已上传 {$saved} 条诊断日志"]);
        break;
    }

    case 'upload_history': {
        $history = $input['history'] ?? null;
        if (!is_array($history) || empty($history)) {
            sendResponse(false, null, '没有可上传的发送历史', 400);
        }
        $payload = json_encode($history, JSON_UNESCAPED_UNICODE);
        if ($payload === false || $payload === '') {
            sendResponse(false, null, '发送历史序列化失败', 400);
        }
        if (strlen($payload) > DESKTOP_MAX_HISTORY_BYTES) {
            sendResponse(false, null, '发送历史过大（超过 512KB），请清理后重试', 413);
        }
        try {
            DB::execute(
                "INSERT INTO `desktop_uploads` (`username`, `payload`, `client_info`) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE `payload` = VALUES(`payload`), `client_info` = VALUES(`client_info`), `updated_at` = CURRENT_TIMESTAMP",
                [$operator, $payload, $clientTag]
            );
        } catch (Throwable $e) {
            error_log("desktop history upload error: " . $e->getMessage());
            sendResponse(false, null, '发送历史入库失败', 500);
        }
        recordServerLog('action', 'desktop', 'cloud_history_uploaded', [
            'username' => $operator,
            'real_name' => $realName,
            'bytes' => strlen($payload),
            'client' => $clientTag,
            'message' => "桌面端 {$operator} 上传了发送历史快照"
        ]);
        sendResponse(true, ['bytes' => strlen($payload), 'message' => '发送历史已上传，管理员可在后台查看']);
        break;
    }

    case 'vision_detect': {
        $task = trim((string)($input['task'] ?? ''));
        if ($task !== 'dropdown' && $task !== 'header') {
            sendResponse(false, null, '无效的视觉任务类型（仅支持 dropdown 或 header）', 400);
        }
        $targetId = trim((string)($input['target_id'] ?? ''));
        $targetName = trim((string)($input['target_name'] ?? ''));
        $imageBase64 = trim((string)($input['image'] ?? ''));
        if ($imageBase64 === '') {
            sendResponse(false, null, '缺少截屏图像数据', 400);
        }

        // 获取视觉大模型运行时配置 (优先 data/vision_config.json -> secret_key.local.php -> 环境变量)
        $runtimeCfg = getVisionRuntimeConfig();
        $apiKey = $runtimeCfg['api_key'] ?? '';
        if (empty($apiKey)) {
            sendResponse(false, null, '服务端未配置视觉模型 API 密钥，请在管理后台【视觉大模型配置】中配置并点击保存', 400);
        }

        try {
            $result = callDashScopeVision($apiKey, $task, $targetId, $targetName, $imageBase64);
            recordServerLog('info', 'desktop', 'vision_detect_success', [
                'task' => $task,
                'target_id' => $targetId,
                'target_name' => $targetName,
                'client' => $clientTag,
                'duration_ms' => $result['duration_ms'] ?? 0
            ], [
                'operator' => $operator
            ]);
            sendResponse(true, $result);
        } catch (Throwable $e) {
            recordServerLog('warn', 'desktop', 'vision_detect_failed', [
                'task' => $task,
                'target_id' => $targetId,
                'target_name' => $targetName,
                'client' => $clientTag,
                'error' => $e->getMessage()
            ], [
                'operator' => $operator
            ]);
            sendResponse(false, null, $e->getMessage(), 422);
        }
        break;
    }

    default:
        sendResponse(false, null, '未知操作', 400);
}
