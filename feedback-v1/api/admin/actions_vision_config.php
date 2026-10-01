<?php
/**
 * Admin 视觉大模型与提示词配置动作处理
 *
 * actions:
 * - vision_config (GET / POST)
 * - test_vision_config (POST)
 */

if (!defined('CONFIG_FILE_PATH')) {
    define('VISION_CONFIG_FILE_PATH', dirname(__DIR__, 2) . '/data/vision_config.json');
}

function getVisionDefaultDropdownPrompt(): string {
    return "你是一个企业微信搜索下拉结果决策专家。请仔细观察这张企业微信搜索下拉候选人列表的截屏，找出目标学生本人或其家长，并判定其排在候选列表的第几项。\n\n" .
           "【目标学生信息】：\n" .
           "- 目标学号：{target_id}\n" .
           "- 目标姓名：{target_name}\n\n" .
           "【核心判定准则与红线禁令】：\n" .
           "1. 【红线：严禁选择群聊与聊天记录！】：目标必须且只能是“联系人”分类下的独立个人微信/企微联系人！“群聊”分类下的任何群聊（班级群、教研群等）以及“聊天记录”分类下的任何条目（如包含该学生学号/姓名的图片或聊天文本），绝对不可作为候选目标！若“联系人”分类下没有目标本人的独立条目，一律判定为未找到本人！\n" .
           "2. 【本人条目判定】：观察“联系人”分类下的条目。条目的主标题（大字加粗标题）中直接包含目标学号（例如 \"{target_id}\"）或目标姓名（例如 \"{target_name}\"、\"{target_name}家长\"、\"{target_name}妈妈\"）。其下方浅灰色小字即使显示其他微信昵称（如 \"微信昵称: 花开富贵\"），只要主标题是本人备注，即为本人条目！\n" .
           "3. 【他人描述/聊天记录拦截】：条目主标题是其他人（例如 \"90001张三@微信\"），下方浅灰色小字写着“描述: {target_id}”或“包含: {target_id}”或属于聊天记录。这代表在他人备注或聊天记录中提到了该学生，绝对不是目标本人！\n" .
           "4. 【候选条目排序编号】：按搜索结果从上往下可点击的条目顺序计数（第 1 项、第 2 项、第 3 项...，忽略纯分类标签文本如“联系人”）。\n\n" .
           "【choice 取值与拦截规范 - 极其重要】：\n" .
           "- 若第 1 项【联系人】的主标题即为目标本人：target_found 填 true，choice 填 1\n" .
           "- 若第 1 项是他人描述，第 2~4 项才是目标本人独立联系人：target_found 填 true，choice 填对应项数（2~4）\n" .
           "- 若通讯录中没有目标学生本人的独立联系人条目（目标仅在他人描述、聊天记录、群聊中被提及）：target_found 必须填 false！choice 必须填 -2！绝对严禁输出 choice: 1！\n" .
           "- 若完全未找到该联系人 / 列表为空 / 显示“进入全局搜索”或“网络查找”：target_found 必须填 false！choice 必须填 0！绝对严禁输出 choice: 1！\n\n" .
           "请输出严格 JSON 格式：\n" .
           "{\n" .
           "  \"target_found\": true,\n" .
           "  \"choice\": 1,\n" .
           "  \"matched_title\": \"命中条目的主标题，未找到则填空字符串\",\n" .
           "  \"reason\": \"简述判定理由\"\n" .
           "}";
}

function getVisionDefaultHeaderPrompt(): string {
    return "你是一个企业微信会话标题核验专家。请仔细观察这张企业微信聊天窗口顶部的标题栏截图，核实当前会话是否为目标学生本人或其家长。\n\n" .
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

function maskVisionApiKey(string $key): string {
    $len = strlen($key);
    if ($len <= 8) {
        return str_repeat('*', $len);
    }
    if ($len <= 16) {
        return substr($key, 0, 3) . '***' . substr($key, -3);
    }
    return substr($key, 0, 7) . '...' . substr($key, -4);
}

function loadVisionConfigRaw(): array {
    $cfgFile = VISION_CONFIG_FILE_PATH;
    $config = [];
    if (file_exists($cfgFile)) {
        $json = @file_get_contents($cfgFile);
        $parsed = json_decode($json, true);
        if (is_array($parsed)) {
            $config = $parsed;
        }
    }

    // 若无单独配置的 API Key，尝试读取 secret_key.local.php 或 secret_key.php
    if (empty($config['api_key'])) {
        $secretKeyFile = dirname(__DIR__) . '/secret_key.local.php';
        if (file_exists($secretKeyFile)) {
            $keys = @include $secretKeyFile;
            if (is_array($keys) && !empty($keys['dashscopeApiKey'])) {
                $config['api_key'] = $keys['dashscopeApiKey'];
            }
        }
    }
    if (empty($config['api_key'])) {
        $secretKeyFile = dirname(__DIR__) . '/secret_key.php';
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

    if (empty($config['base_url'])) {
        $config['base_url'] = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
    }
    if (empty($config['model'])) {
        $config['model'] = 'qwen3.8-flash';
    }
    if (empty($config['prompt_dropdown'])) {
        $config['prompt_dropdown'] = getVisionDefaultDropdownPrompt();
    }
    if (empty($config['prompt_header'])) {
        $config['prompt_header'] = getVisionDefaultHeaderPrompt();
    }

    return $config;
}

switch ($action) {
    case 'vision_config': {
        requireAdmin();

        if ($method === 'GET') {
            $raw = loadVisionConfigRaw();
            $fullKey = $raw['api_key'] ?? '';
            $response = [
                'base_url' => $raw['base_url'] ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
                'model' => $raw['model'] ?? 'qwen3.8-flash',
                'api_key' => $fullKey ? maskVisionApiKey($fullKey) : '',
                'has_api_key' => !empty($fullKey),
                'prompt_dropdown' => $raw['prompt_dropdown'] ?? getVisionDefaultDropdownPrompt(),
                'prompt_header' => $raw['prompt_header'] ?? getVisionDefaultHeaderPrompt(),
                'default_prompt_dropdown' => getVisionDefaultDropdownPrompt(),
                'default_prompt_header' => getVisionDefaultHeaderPrompt()
            ];
            sendResponse(true, $response);

        } elseif ($method === 'POST') {
            $input = json_decode(file_get_contents('php://input'), true);
            if (!is_array($input)) {
                sendResponse(false, null, '无效的 JSON 请求体', 400);
            }

            $current = loadVisionConfigRaw();

            // API 端点
            $baseUrl = trim((string)($input['base_url'] ?? $current['base_url']));
            if (!empty($baseUrl) && !str_starts_with($baseUrl, 'http://') && !str_starts_with($baseUrl, 'https://')) {
                sendResponse(false, null, 'API 端点必须以 http:// 或 https:// 开头', 400);
            }
            if (!empty($baseUrl)) {
                $current['base_url'] = $baseUrl;
            }

            // 模型名称
            $model = trim((string)($input['model'] ?? $current['model']));
            if (!empty($model)) {
                $current['model'] = $model;
            }

            // API 密钥 (如果传入非空且不包含星号/省略号，则更新)
            if (isset($input['api_key'])) {
                $newKey = trim((string)$input['api_key']);
                if ($newKey !== '' && !str_contains($newKey, '...') && !str_contains($newKey, '***')) {
                    $current['api_key'] = $newKey;
                }
            }

            // 提示词
            if (isset($input['prompt_dropdown'])) {
                $pDrop = trim((string)$input['prompt_dropdown']);
                if (!empty($pDrop)) {
                    $current['prompt_dropdown'] = $pDrop;
                }
            }
            if (isset($input['prompt_header'])) {
                $pHead = trim((string)$input['prompt_header']);
                if (!empty($pHead)) {
                    $current['prompt_header'] = $pHead;
                }
            }

            $cfgFile = VISION_CONFIG_FILE_PATH;
            $saveRes = @file_put_contents($cfgFile, json_encode($current, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
            if ($saveRes === false) {
                sendResponse(false, null, '保存配置文件失败，请检查 data 目录写权限', 500);
            }

            recordServerLog('action', 'admin', 'vision_config_updated', [
                'model' => $current['model'] ?? 'qwen3.8-flash',
                'base_url' => $current['base_url'] ?? '',
                'has_api_key' => !empty($current['api_key']),
                'message' => '管理员更新视觉大模型与提示词配置'
            ]);

            sendResponse(true, [
                'message' => '视觉大模型配置已成功保存',
                'base_url' => $current['base_url'],
                'model' => $current['model'],
                'api_key' => maskVisionApiKey($current['api_key']),
                'has_api_key' => !empty($current['api_key']),
                'prompt_dropdown' => $current['prompt_dropdown'],
                'prompt_header' => $current['prompt_header']
            ]);
        } else {
            sendResponse(false, null, '不支持的 HTTP 请求方法', 405);
        }
        break;
    }

    case 'test_vision_config': {
        requireAdmin();
        if ($method !== 'POST') {
            sendResponse(false, null, '不支持的 HTTP 请求方法', 405);
        }

        $input = json_decode(file_get_contents('php://input'), true) ?: [];
        $current = loadVisionConfigRaw();

        $baseUrl = trim((string)($input['base_url'] ?? $current['base_url']));
        $model = trim((string)($input['model'] ?? $current['model']));
        $apiKey = trim((string)($input['api_key'] ?? ''));

        // 如果传入的是脱敏或空，用已保存的 Key
        if ($apiKey === '' || str_contains($apiKey, '...') || str_contains($apiKey, '***')) {
            $apiKey = $current['api_key'] ?? '';
        }

        if (empty($apiKey)) {
            sendResponse(false, null, 'API Key 未配置，无法进行探测', 400);
        }
        if (empty($baseUrl)) {
            sendResponse(false, null, 'API 端点未配置', 400);
        }

        // 构造一个微型 16x16 绿色纯色 PNG 图片作为连通性测活载荷
        $tinyPngBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAUSURBVDhPY/wPBAxUBCMNA8VBAAA2ugf53+fOzwAAAABJRU5ErkJggg==';

        $testPrompt = "这是一张系统连通性测试图片。请以严格的 JSON 格式回复一个简短确认，格式为：{\"status\": \"ok\", \"model\": \"{$model}\"}";

        $payload = [
            'model' => $model,
            'enable_thinking' => false,
            'messages' => [
                [
                    'role' => 'user',
                    'content' => [
                        [
                            'type' => 'image_url',
                            'image_url' => ['url' => $tinyPngBase64]
                        ],
                        [
                            'type' => 'text',
                            'text' => $testPrompt
                        ]
                    ]
                ]
            ],
            'response_format' => ['type' => 'json_object'],
            'max_tokens' => 150
        ];

        $ch = curl_init($baseUrl);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => [
                'Authorization: Bearer ' . $apiKey,
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
            sendResponse(false, [
                'duration_ms' => $durationMs,
                'error' => "网络连接异常: {$curlErr}"
            ], "网络连接异常: {$curlErr}", 502);
        }

        if ($httpCode !== 200) {
            $errDetail = json_decode($response, true);
            $errMsg = $errDetail['error']['message'] ?? $errDetail['message'] ?? "HTTP {$httpCode}";
            sendResponse(false, [
                'duration_ms' => $durationMs,
                'http_code' => $httpCode,
                'raw' => substr((string)$response, 0, 500),
                'error' => $errMsg
            ], "模型服务返回异常 (HTTP {$httpCode}): {$errMsg}", 502);
        }

        $resData = json_decode($response, true);
        $content = $resData['choices'][0]['message']['content'] ?? '';

        sendResponse(true, [
            'duration_ms' => $durationMs,
            'http_code' => $httpCode,
            'model' => $model,
            'reply' => $content,
            'message' => "连通成功！模型响应耗时 {$durationMs}ms"
        ]);
        break;
    }
}
