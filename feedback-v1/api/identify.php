<?php
/**
 * 企业微信反馈发送器 - 云端视觉判定接口 (api/identify.php)
 *
 * multipart 接收：image_title + image_chat（PNG/JPEG，各 ≤5MB）
 *   + target_id / target_name + 可选 token（POST 字段或 Authorization: Bearer）。
 * 一次调用同时裁决：会话身份 matched、是否群聊 is_group、待回 needs_reply。
 * 严格 JSON 返回（见 sendResponse data）：
 *   {matched, is_group, title_in_header, detected_title,
 *    last_sender, last_message_text, needs_reply, reason, duration_ms}
 *
 * 服务端配置（只放配置/环境变量，无管理后台编辑页）：
 *   SENDER_API_TOKEN  发送器访问令牌（可选；默认支持内置内部 Token 开箱即用）
 *                     亦可在环境变量或 api/secret_key.local.php 中设置 'senderApiToken' 自定义
 *   DASHSCOPE_API_KEY 视觉模型 Key（必填）或 secret_key.local.php 中 'dashscopeApiKey'
 *   IDENTIFY_API_BASE 兼容 OpenAI chat-completions 的 endpoint（环境变量或
 *                     secret_key.local.php 中 'identifyApiBase'；可只写到 …/v1，
 *                     程序自动补 /chat/completions；默认 DashScope 官方地址）
 *   IDENTIFY_MODEL     视觉模型（环境变量或 secret_key.local.php 中 'identifyModel'；
 *                     默认 qwen-vl-max）
 *
 * 存档举证：每次判定存 data/identify_archive/YYYYMMDD/uniqid/ 下
 *   title.png + chat.png + request.json + response.json。
 * 保留期限：14 天（概率清理，与 upload_capture.php 同策略）。
 */

require_once __DIR__ . '/bootstrap.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    sendResponse(false, null, '仅支持 POST', 405);
}

// ---- 访问令牌（小范围内部使用：默认放行内置默认 Token，也可通过环境变量或 secret_key.local.php 覆盖自定义）----
const DEFAULT_SENDER_TOKEN = 'jf_feedback_sender_internal_token_2026';

$serverToken = getenv('SENDER_API_TOKEN') ?: '';
if ($serverToken === '') {
    $localFile = __DIR__ . '/secret_key.local.php';
    if (is_file($localFile)) {
        $local = require $localFile;
        if (is_array($local) && !empty($local['senderApiToken'])) {
            $serverToken = (string)$local['senderApiToken'];
        }
    }
}

$given = $_POST['token'] ?? '';
$authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
if ($given === '' && stripos($authHeader, 'bearer ') === 0) {
    $given = trim(substr($authHeader, 7));
}

// 鉴权放行策略：
// 1. 若客户端携带内置默认 Token，直接予以放行（开箱即用，所有电脑免配置）
// 2. 若服务端配置了自定义 Token 且客户端匹配，予以放行
// 3. 若服务端未配置任何自定义 Token，且客户端也未传，按内部小范围默认放行
$authorized = false;
if ($given !== '' && hash_equals(DEFAULT_SENDER_TOKEN, (string)$given)) {
    $authorized = true;
} elseif ($serverToken !== '' && $given !== '' && hash_equals($serverToken, (string)$given)) {
    $authorized = true;
} elseif ($serverToken === '' && $given === '') {
    $authorized = true;
}

if (!$authorized) {
    sendResponse(false, null, '鉴权失败', 200);
}

$t0 = microtime(true);

// ---- 入参校验 ----
function _clip_text($v, $max = 64) {
    $v = trim((string)$v);
    if (function_exists('mb_substr')) {
        $v = mb_substr($v, 0, $max, 'UTF-8');
    } else {
        $v = substr($v, 0, $max * 3);
    }
    return $v;
}
$targetId = _clip_text($_POST['target_id'] ?? '');
$targetName = _clip_text($_POST['target_name'] ?? '');
if ($targetId === '' && $targetName === '') {
    sendResponse(false, null, 'target_id 与 target_name 不能同时为空', 400);
}
foreach (['image_title', 'image_chat'] as $field) {
    if (!isset($_FILES[$field]) || ($_FILES[$field]['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
        sendResponse(false, null, '缺少上传图：' . $field, 400);
    }
    if (($_FILES[$field]['size'] ?? 0) > 5 * 1024 * 1024) {
        sendResponse(false, null, '上传图超过 5MB：' . $field, 400);
    }
    $info = @getimagesize($_FILES[$field]['tmp_name']);
    if ($info === false || !in_array($info[2], [IMAGETYPE_PNG, IMAGETYPE_JPEG], true)) {
        sendResponse(false, null, '只收 PNG/JPEG：' . $field, 400);
    }
}

// ---- 视觉模型配置（环境变量优先，secret_key.local.php 次之，均无则 fail-closed）----
$keys = require __DIR__ . '/secret_key.php';
$localKeys = is_array($keys) ? $keys : [];
$visionKey = getenv('DASHSCOPE_API_KEY') ?: ($localKeys['dashscopeApiKey'] ?? '');
if ($visionKey === '') {
    sendResponse(false, null, '服务端视觉模型未配置，请联系管理员', 200);
}
$apiBase = getenv('IDENTIFY_API_BASE') ?: ($localKeys['identifyApiBase'] ?? '');
if ($apiBase === '') {
    $apiBase = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
} elseif (substr($apiBase, -17) !== '/chat/completions') {
    $apiBase = rtrim($apiBase, '/') . '/chat/completions';
}
$model = getenv('IDENTIFY_MODEL') ?: ($localKeys['identifyModel'] ?? '') ?: 'qwen-vl-max';
if (!function_exists('curl_init')) {
    sendResponse(false, null, '服务端缺少 curl 扩展', 200);
}

$prompt = '你是企业微信窗口核验器。看两张图：图1是聊天窗口顶部标题栏截图，图2是同一窗口聊天区末尾截图。'
    . '目标学生学号为“' . $targetId . '”，姓名为“' . $targetName . '”。'
    . '只输出 JSON（无 markdown、无多余文字），字段：'
    . '{"matched":bool(标题同时包含学号与姓名才为true，任一缺失/是群聊则false),'
    . '"is_group":bool(是群聊/多人会话为true),'
    . '"title_in_header":bool(标题栏能读到有效标题),'
    . '"detected_title":string(标题栏读到的原文，读不到为空字符串),'
    . '"last_sender":"me"|"parent"|"unknown"|null(聊天末尾最后一条是谁发的：我/家长/无法判断/无消息),'
    . '"last_message_text":string(最后一条文本内容，无则为空字符串),'
    . '"needs_reply":bool|null(家长最后一条需要老师回复为true，明确无需回为false，判不出为null),'
    . '"reason":string(一句话理由)}';

function _img_data_url($tmpPath) {
    $info = getimagesize($tmpPath);
    $mime = $info['mime'] === 'image/png' ? 'image/png' : 'image/jpeg';
    return 'data:' . $mime . ';base64,' . base64_encode(file_get_contents($tmpPath));
}

$payload = [
    'model' => $model,
    'messages' => [[
        'role' => 'user',
        'content' => [
            ['type' => 'text', 'text' => $prompt],
            ['type' => 'image_url', 'image_url' => ['url' => _img_data_url($_FILES['image_title']['tmp_name'])]],
            ['type' => 'image_url', 'image_url' => ['url' => _img_data_url($_FILES['image_chat']['tmp_name'])]],
        ],
    ]],
    'temperature' => 0,
];

$ch = curl_init($apiBase);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $visionKey],
    CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE),
    CURLOPT_TIMEOUT => 50,
]);
$raw = curl_exec($ch);
$httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlErr = curl_error($ch);
curl_close($ch);
if ($raw === false || $raw === '') {
    // 注：不用 HTTP 502——本站 nginx 对 502 配了 error_page，会吞掉 JSON 包。
    // 应用层失败一律 200 + success:false，调用方只看 success。
    sendResponse(false, null, '视觉模型调用失败：' . $curlErr, 200);
}
$decoded = json_decode($raw, true);
$content = $decoded['choices'][0]['message']['content'] ?? '';
if (!is_string($content) || trim($content) === '') {
    $upErr = $decoded['error']['message'] ?? ('HTTP ' . $httpCode);
    sendResponse(false, null, '视觉模型返回为空：' . $upErr, 200);
}
$text = trim($content);
$text = preg_replace('/^```(?:json)?\s*/i', '', $text);
$text = preg_replace('/\s*```$/', '', $text);
$parsed = json_decode(trim($text), true);
if (!is_array($parsed)) {
    sendResponse(false, null, '视觉模型返回非 JSON', 200);
}

// ---- 类型归一（缺失不放行由客户端 fail-closed；此处只做归一）----
function _as_bool_or_null($v) {
    if ($v === true || $v === 1 || $v === 'true') {
        return true;
    }
    if ($v === false || $v === 0 || $v === 'false') {
        return false;
    }
    return null;
}
$out = [
    'matched' => ($parsed['matched'] ?? false) === true,
    'is_group' => ($parsed['is_group'] ?? false) === true,
    'title_in_header' => ($parsed['title_in_header'] ?? false) === true,
    'detected_title' => (string)($parsed['detected_title'] ?? ''),
    'last_sender' => in_array($parsed['last_sender'] ?? null, ['me', 'parent', 'unknown', null], true)
        ? ($parsed['last_sender'] ?? null) : 'unknown',
    'last_message_text' => (string)($parsed['last_message_text'] ?? ''),
    'needs_reply' => _as_bool_or_null($parsed['needs_reply'] ?? null),
    'reason' => (string)($parsed['reason'] ?? ''),
    'duration_ms' => (int)round((microtime(true) - $t0) * 1000),
];

// ---- 存档：两图 + 请求 JSON + 返回 JSON（保留 14 天）----
$archiveRoot = __DIR__ . '/../data/identify_archive';
$dayDir = $archiveRoot . '/' . date('Ymd') . '/' . date('His') . '_' . bin2hex(random_bytes(4));
@mkdir($dayDir, 0755, true);
@move_uploaded_file($_FILES['image_title']['tmp_name'], $dayDir . '/title.png');
@move_uploaded_file($_FILES['image_chat']['tmp_name'], $dayDir . '/chat.png');
@file_put_contents($dayDir . '/request.json', json_encode([
    'target_id' => $targetId, 'target_name' => $targetName,
    'model' => $model, 'ip' => getClientIp(), 'time' => date('Y-m-d H:i:s'),
], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
@file_put_contents($dayDir . '/response.json', json_encode([
    'mapped' => $out, 'raw_content' => $content,
], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));

if (rand(1, 10) === 1) {
    $cutoff = time() - 14 * 24 * 3600;
    foreach (glob($archiveRoot . '/*', GLOB_ONLYDIR) ?: [] as $dd) {
        foreach (glob($dd . '/*') ?: [] as $leaf) {
            if (is_dir($leaf)) {
                if (filemtime($leaf) < $cutoff) {
                    foreach (glob($leaf . '/*') ?: [] as $f) {
                        if (is_file($f)) {
                            @unlink($f);
                        }
                    }
                    @rmdir($leaf);
                }
            } elseif (is_file($leaf) && filemtime($leaf) < $cutoff) {
                @unlink($leaf);
            }
        }
        $rest = glob($dd . '/*');
        if (!$rest) {
            @rmdir($dd);
        }
    }
}

sendResponse(true, $out);
