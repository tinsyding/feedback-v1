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
           "【截图说明】：收到的是企业微信主窗口的整窗截图，不是只截搜索框。搜索框位于窗口左侧导航栏顶部，展开的下拉候选列表紧贴其下方浮出。请先在整图中定位左侧的搜索框与下拉候选列表，再据其内容判定。\n\n" .
           "【核心判定准则与红线禁令】：\n" .
           "1. 【红线：严禁选择群聊与聊天记录！】：目标必须且只能是“联系人”分类下的独立个人微信/企微联系人！“群聊”分类下的任何群聊（班级群、教研群等）以及“聊天记录”分类下的任何条目（如包含该学生学号/姓名的图片或聊天文本），绝对不可作为候选目标！若“联系人”分类下没有目标本人的独立条目，一律判定为未找到本人！\n" .
           "2. 【本人条目判定】：观察“联系人”分类下的条目。条目的主标题（大字加粗标题）必须完全同时包含目标学号（\"{target_id}\"）与目标姓名（例如 \"{target_name}\"、\"{target_name}家长\"、\"{target_name}妈妈\"），二者缺一不可！仅有学号无姓名或仅有姓名无学号均不符合本人条目判定。其下方浅灰色小字即使显示其他微信昵称（如 \"微信昵称: 花开富贵\"），只要主标题完全匹配学号与姓名，即为本人条目！\n" .
           "3. 【他人描述/聊天记录拦截】：条目主标题是其他人（例如 \"90001张三@微信\"），下方浅灰色小字写着“描述: {target_id}”或“包含: {target_id}”或属于聊天记录。这代表在他人备注或聊天记录中提到了该学生，绝对不是目标本人！\n" .
           "4. 【候选条目排序编号】：按搜索结果从上往下可点击的条目顺序计数（第 1 项、第 2 项、第 3 项...，忽略纯分类标签文本如“联系人”）。\n\n" .
           "【choice 取值规范 - 极其重要】：\n" .
           "- choice 只能填 0 或正整数（候选项序号），严禁输出任何负数！\n" .
           "- 若第 1 项【联系人】的主标题即为目标本人：target_found 填 true，choice 填 1\n" .
           "- 若第 1 项是他人描述，目标本人独立联系人排在第 N 项：target_found 填 true，choice 填 N（如 2、3、4）\n" .
           "- 若通讯录中没有目标学生本人的独立联系人条目（目标仅在他人描述、聊天记录、群聊中被提及）：target_found 填 false，choice 填 0！绝对严禁输出 choice: 1！\n" .
           "- 若完全未找到该联系人 / 列表为空 / 显示“进入全局搜索”或“网络查找”：target_found 填 false，choice 填 0！绝对严禁输出 choice: 1！\n\n" .
           "请输出严格 JSON 格式：\n" .
           "{\n" .
           "  \"target_found\": true,\n" .
           "  \"choice\": 1,\n" .
           "  \"matched_title\": \"命中条目的主标题，未找到则填空字符串\",\n" .
           "  \"reason\": \"简述判定理由\"\n" .
           "}";
}

function getVisionDefaultChatviewPrompt(): string {
    // 必须与 api/desktop.php 里 $task === 'chatview' 的兜底 prompt 逐字一致。
    return "你是一个企业微信会话核验专家。请观察这张企业微信整窗截图，完成两件事：核实当前打开的会话是不是目标学生本人（或其家长），以及判断家长最后一条消息是否需要老师回复。\n\n" .
           "【目标学生信息】：\n" .
           "- 目标学号：{target_id}\n" .
           "- 目标姓名：{target_name}\n\n" .
           "【截图说明】：收到的是企业微信主窗口的整窗截图（Windows Graphics Capture 直接抓窗口表面，不受遮挡或窗口出屏影响）。布局自上而下为：顶部标题栏（会话名 + 群成员数/头像拼图）、中间聊天记录区（按时间正序，最新的一条在最下方）、底部消息输入框。左侧是会话列表导航栏，与本次判定无关。\n\n" .
           "【第一部分：会话身份（判定错误会导致把反馈发错人，请极其谨慎）】\n" .
           "1. 【detected_title 的取值范围 —— 极其重要】：只输出**顶部标题栏里显示的会话名原文**，最多十几个字。绝对禁止把聊天记录里的任何文字（消息气泡、系统提示、对方昵称、引用内容）写进 detected_title！如果你无法在标题栏位置读到会话名，就把 detected_title 留空、title_in_header 填 false。\n" .
           "2. 【title_in_header】：detected_title 是否确实是从顶部标题栏读到的。为 true 表示你确实在标题栏位置看到了会话名；为 false 表示你没能读到标题栏（例如画面还没渲染完、当前不是聊天界面、或只看到会话列表）。\n" .
           "3. 【matched】：会话名必须**完全同时**包含目标学号 \"{target_id}\" 与目标姓名 \"{target_name}\"（允许带「家长」「妈妈」等后缀、表情符号、\"@微信\"），二者缺一不可才可填 true。若会话名是其他人、或只含学号无姓名、或只含姓名无学号，一律填 false。\n" .
           "4. 【is_group —— 群聊红线】：若当前是群聊（标题栏右侧显示成员数量或成员头像拼图、或聊天区内可见系统提示如「XX 邀请 YY 加入群聊」），is_group 填 true。这类会话即使标题里恰好含有目标学号和姓名（例如 \"{target_id}{target_name}家长群\"）也**绝对不是**目标本人，必须 matched 填 false。\n\n" .
           "【第二部分：是否有待回消息】\n" .
           "5. 【last_sender】：看**聊天记录区最下方那一条消息**的发送方。若在输入框右侧/左侧、位于自己发出的消息那一列（即自己发的），填 \"me\"；若是对方发的，填 \"parent\"；看不清或聊天区为空，填 \"unknown\"。\n" .
           "6. 【last_message_text】：把最下方那一条消息的原文抄下来（最多 100 字）。若最下方那条是系统提示（例如「以上是打招呼的内容」或群公告），则继续往上找最近一条**对方发的真实消息**。\n" .
           "7. 【needs_reply 判定规则】：\n" .
           "   - last_sender 为 \"parent\" 且该消息**不是**下列客套/无需回复的内容时，填 true：\n" .
           "     · 纯确认与客套：「收到」「好的」「好」「嗯」「嗯嗯」「ok」「OK」「明白了」「辛苦了」「谢谢」「谢谢老师」「谢谢x老师」「THX」等；\n" .
           "     · 纯表情符号、纯 emoji、纯符号（👍🙏🌹🌸❤️ 等），或「好的👌」这类客套加表情；\n" .
           "     · 只是重复你（老师）上一条消息里已经说过的内容、没有提出任何新问题。\n" .
           "   - 家长提出了问题、请求、需要确认的事项、表达不满或催促，或只是陈述一件需要你处理的事（如「明天能请假吗」「成绩什么时候出」「老师说下周家长会」），填 true。\n" .
           "   - last_sender 为 \"me\"（最后一条是你自己发的，说明你已经回过了），填 false。\n" .
           "   - 聊天区为空、或看不清最后一条消息，填 null（表示无法判断）。\n" .
           "8. 【判错是可以接受的】：你只需要尽力按上述规则判断；判断需要回复时哪怕偶尔判断错一两个，程序也只做记录、不会自动回消息，老师会自己核对。但如果实在看不出来，请老实填 null，不要猜。\n\n" .
           "请输出严格 JSON 格式（不要输出任何额外文字、不要用 Markdown 代码块包裹）：\n" .
           "{\n" .
           "  \"matched\": true,\n" .
           "  \"title_in_header\": true,\n" .
           "  \"is_group\": false,\n" .
           "  \"detected_title\": \"90001张三（家长）\",\n" .
           "  \"last_sender\": \"parent\",\n" .
           "  \"last_message_text\": \"老师收到成绩了，太感谢\",\n" .
           "  \"needs_reply\": false,\n" .
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
    if (empty($config['prompt_chatview'])) {
        $config['prompt_chatview'] = getVisionDefaultChatviewPrompt();
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
                'prompt_chatview' => $raw['prompt_chatview'] ?? getVisionDefaultChatviewPrompt(),
                'prompt_dropdown' => $raw['prompt_dropdown'] ?? getVisionDefaultDropdownPrompt(),
                'prompt_header' => $raw['prompt_header'] ?? getVisionDefaultHeaderPrompt(),
                'default_prompt_chatview' => getVisionDefaultChatviewPrompt(),
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
            if (isset($input['prompt_chatview'])) {
                $pView = trim((string)$input['prompt_chatview']);
                if (!empty($pView)) {
                    $current['prompt_chatview'] = $pView;
                }
            }
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
                'prompt_chatview' => $current['prompt_chatview'],
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
