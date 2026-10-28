<?php
/**
 * Admin Config 动作处理: config
 */

switch ($action) {
        case 'config':
            requireAdmin();
            if ($method === 'GET') {
                // Get config
                if (!file_exists($configFile)) {
                    sendResponse(false, null, '配置文件不存在', 500);
                }
                
                $config = json_decode(file_get_contents($configFile), true);
                if ($config === null) {
                    sendResponse(false, null, '配置文件格式错误', 500);
                }
                
                // 补充回显 AI 相关配置（若 config.json 中未显式保存，回退读取 secret_key.php 或环境变量）
                $keys = @include dirname(__DIR__) . '/secret_key.php';
                $localKeys = is_array($keys) ? $keys : [];

                if (!isset($config['dashscopeApiKey'])) {
                    $config['dashscopeApiKey'] = getenv('DASHSCOPE_API_KEY') ?: ($localKeys['dashscopeApiKey'] ?? '');
                }
                if (!isset($config['identifyApiBase'])) {
                    $config['identifyApiBase'] = getenv('IDENTIFY_API_BASE') ?: ($localKeys['identifyApiBase'] ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
                }
                if (!isset($config['identifyModel'])) {
                    $config['identifyModel'] = getenv('IDENTIFY_MODEL') ?: ($localKeys['identifyModel'] ?? 'qwen3.8-max');
                }
                if (!isset($config['identifyFastModel'])) {
                    $config['identifyFastModel'] = getenv('IDENTIFY_FAST_MODEL') ?: ($localKeys['identifyFastModel'] ?? 'qwen3.8-flash');
                }

                sendResponse(true, $config);
                
            } elseif ($method === 'POST') {
                // Update config - require auth
                requireAdmin();
                
                $input = json_decode(file_get_contents('php://input'), true);
                
                // Read current config
                if (!file_exists($configFile)) {
                    sendResponse(false, null, '配置文件不存在', 500);
                }
                
                $config = json_decode(file_get_contents($configFile), true);
                if ($config === null) {
                    $config = [];
                }
                
                // Update fields
                if (isset($input['defaultSeason'])) {
                    $config['defaultSeason'] = is_numeric($input['defaultSeason']) ? (int)$input['defaultSeason'] : (string)$input['defaultSeason'];
                }
                if (isset($input['semesterYear'])) {
                    $config['semesterYear'] = (int)$input['semesterYear'];
                }
                if (isset($input['semesterWeeks'])) {
                    $config['semesterWeeks'] = (int)$input['semesterWeeks'];
                }
                if (isset($input['forceIntegerScores'])) {
                    $config['forceIntegerScores'] = (bool)$input['forceIntegerScores'];
                }
                if (isset($input['retestQuestionSpacing'])) {
                    $config['retestQuestionSpacing'] = max(10, min(260, (int)$input['retestQuestionSpacing']));
                }
                if (isset($input['retestQrCodeEnabled'])) {
                    $config['retestQrCodeEnabled'] = (bool)$input['retestQrCodeEnabled'];
                }
                if (isset($input['disableQwenFlashTitle'])) {
                    $config['disableQwenFlashTitle'] = (bool)$input['disableQwenFlashTitle'];
                }
                if (isset($input['dashscopeApiKey'])) {
                    $config['dashscopeApiKey'] = trim((string)$input['dashscopeApiKey']);
                }
                if (isset($input['identifyApiBase'])) {
                    $config['identifyApiBase'] = trim((string)$input['identifyApiBase']);
                }
                if (isset($input['identifyModel'])) {
                    $config['identifyModel'] = trim((string)$input['identifyModel']);
                }
                if (isset($input['identifyFastModel'])) {
                    $config['identifyFastModel'] = trim((string)$input['identifyFastModel']);
                }
                
                // Keep comment
                $config['_comment'] = "defaultSeason: spring/summer/autumn/winter (春/暑/秋/寒). semesterYear: 当前学年. semesterWeeks: 学期总周/次数. retestQuestionSpacing: 错题本拼页题目间隙(pt). retestQrCodeEnabled: 下载PDF是否包含视频讲解二维码. disableQwenFlashTitle: 是否停用云端Qwen-Flash标题核验(强制本地OCR). dashscopeApiKey / identifyApiBase / identifyModel / identifyFastModel: 大语言模型视觉接口配置.";
                
                // Save
                $result = file_put_contents($configFile, json_encode($config, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
                
                if ($result === false) {
                    sendResponse(false, null, '保存配置失败，请检查服务器权限', 500);
                }

                recordServerLog('action', 'admin', 'config_updated', [
                    'semesterYear' => $config['semesterYear'] ?? 2026,
                    'defaultSeason' => $config['defaultSeason'] ?? 'autumn',
                    'semesterWeeks' => $config['semesterWeeks'] ?? 14,
                    'retestQrCodeEnabled' => $config['retestQrCodeEnabled'] ?? true,
                    'disableQwenFlashTitle' => $config['disableQwenFlashTitle'] ?? false,
                    'hasApiKey' => !empty($config['dashscopeApiKey']),
                    'identifyModel' => $config['identifyModel'] ?? '',
                    'identifyFastModel' => $config['identifyFastModel'] ?? '',
                    'message' => '管理员修改系统配置及 AI 大模型接口设置'
                ]);
                
                sendResponse(true, [
                    'message' => '配置已更新',
                    'config' => $config
                ]);
            } else {
                sendResponse(false, null, '不支持的请求方法', 405);
            }
            break;

        case 'test_ai_config':
            requireAdmin();
            if ($method !== 'POST') {
                sendResponse(false, null, '不支持的请求方法', 405);
            }

            $input = json_decode(file_get_contents('php://input'), true) ?: [];

            $apiKey = trim((string)($input['api_key'] ?? ''));
            $apiBase = trim((string)($input['base_url'] ?? ''));
            $model = trim((string)($input['model'] ?? ''));

            if ($apiKey === '' || $apiBase === '' || $model === '') {
                $currConfig = file_exists($configFile) ? (json_decode(file_get_contents($configFile), true) ?: []) : [];
                $keys = @include dirname(__DIR__) . '/secret_key.php';
                $localKeys = is_array($keys) ? $keys : [];

                if ($apiKey === '') {
                    $apiKey = ($currConfig['dashscopeApiKey'] ?? '') ?: (getenv('DASHSCOPE_API_KEY') ?: ($localKeys['dashscopeApiKey'] ?? ''));
                }
                if ($apiBase === '') {
                    $apiBase = ($currConfig['identifyApiBase'] ?? '') ?: (getenv('IDENTIFY_API_BASE') ?: ($localKeys['identifyApiBase'] ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'));
                }
                if ($model === '') {
                    $model = ($currConfig['identifyModel'] ?? '') ?: (getenv('IDENTIFY_MODEL') ?: ($localKeys['identifyModel'] ?? 'qwen3.8-max'));
                }
            }

            if (empty($apiKey)) {
                sendResponse(false, null, 'API Key 为空，无法进行连通性测试', 400);
            }
            if (empty($apiBase)) {
                sendResponse(false, null, 'API 端点 Base URL 为空', 400);
            }
            if (substr($apiBase, -17) !== '/chat/completions') {
                $apiBase = rtrim($apiBase, '/') . '/chat/completions';
            }
            if (!function_exists('curl_init')) {
                sendResponse(false, null, '服务端缺少 curl 扩展', 500);
            }

            $t0 = microtime(true);
            $payload = [
                'model' => $model,
                'messages' => [
                    [
                        'role' => 'user',
                        'content' => '测试连接。请回复简短确认。'
                    ]
                ],
                'max_tokens' => 15,
                'temperature' => 0
            ];

            $ch = curl_init($apiBase);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_POST => true,
                CURLOPT_HTTPHEADER => [
                    'Content-Type: application/json',
                    'Authorization: Bearer ' . $apiKey
                ],
                CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE),
                CURLOPT_TIMEOUT => 15,
                CURLOPT_CONNECTTIMEOUT => 6,
                CURLOPT_SSL_VERIFYPEER => true
            ]);
            $raw = curl_exec($ch);
            $durationMs = round((microtime(true) - $t0) * 1000);
            $httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $curlErr = curl_error($ch);
            curl_close($ch);

            if ($raw === false || $raw === '') {
                sendResponse(false, [
                    'duration_ms' => $durationMs,
                    'http_code' => $httpCode,
                    'error' => '网络连接失败: ' . ($curlErr ?: '未收到响应')
                ], 'API 请求失败: ' . ($curlErr ?: '未收到响应'), 200);
            }

            $decoded = json_decode($raw, true);
            if ($httpCode >= 200 && $httpCode < 300 && isset($decoded['choices'])) {
                $reply = trim((string)($decoded['choices'][0]['message']['content'] ?? ''));
                sendResponse(true, [
                    'duration_ms' => $durationMs,
                    'http_code' => $httpCode,
                    'model' => $model,
                    'reply' => $reply
                ], '连通测试成功');
            } else {
                $errMsg = $decoded['error']['message'] ?? $decoded['message'] ?? ("HTTP {$httpCode}: " . substr($raw, 0, 150));
                sendResponse(false, [
                    'duration_ms' => $durationMs,
                    'http_code' => $httpCode,
                    'error' => $errMsg
                ], 'API 返回错误: ' . $errMsg, 200);
            }
            break;
        // ========== 数据库可视化 CRUD 接口 ==========
}
