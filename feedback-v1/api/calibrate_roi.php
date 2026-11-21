<?php
/**
 * 企业微信反馈发送器 - 多模态自动 ROI 视窗校准接口 (api/calibrate_roi.php)
 *
 * 接收：整张企业微信主窗口截图 image（PNG/JPEG，≤10MB）+ 可选 token。
 * 调用 Qwen3.8-Max 多模态旗舰模型智能定位右侧聊天窗口的「标题栏」与「输入框」边界。
 * 返回规范的相对比例坐标 (0.0~1.0)：
 *   {
 *     title: [x, y, w, h],
 *     input: [x, y, w, h],
 *     chat:  [x, y, w, h],
 *     reason: string,
 *     duration_ms: int
 *   }
 */

require_once __DIR__ . '/bootstrap.php';
require_once __DIR__ . '/sender_auth_helper.php';

// 健康探针支持 GET 返回 200
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
    sendResponse(true, ['service' => 'calibrate_roi', 'status' => 'ready'], 'ok');
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    sendResponse(false, null, '仅支持 POST', 405);
}

// 鉴权（支持 SENDER_API_TOKENS 多令牌轮换与 ALLOW_DEFAULT_SENDER_TOKEN 开关）
if (!verifySenderRequestToken()) {
    sendResponse(false, null, '鉴权失败', 200);
}

$t0 = microtime(true);

if (!isset($_FILES['image']) || ($_FILES['image']['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
    sendResponse(false, null, '缺少上传整窗截图：image', 400);
}
if (($_FILES['image']['size'] ?? 0) > 10 * 1024 * 1024) {
    sendResponse(false, null, '截图不能超过 10MB', 400);
}
$imgInfo = @getimagesize($_FILES['image']['tmp_name']);
if ($imgInfo === false || !in_array($imgInfo[2], [IMAGETYPE_PNG, IMAGETYPE_JPEG], true)) {
    sendResponse(false, null, '只支持 PNG/JPEG 截图', 400);
}
$imgW = $imgInfo[0];
$imgH = $imgInfo[1];
if ($imgW < 300 || $imgH < 200) {
    sendResponse(false, null, '截图尺寸过小，无法进行界面分析', 200);
}

// 视觉模型配置（data/.ai_secrets.json 优先，兼容旧 config.json，环境变量次之，secret_key.local.php 兜底）
require_once __DIR__ . '/sender_control_helper.php';
$cfgFile = __DIR__ . '/../config.json';
$cfgJson = file_exists($cfgFile) ? @json_decode(file_get_contents($cfgFile), true) : [];
if (!is_array($cfgJson)) {
    $cfgJson = [];
}
$sc = normalizeGlobalSenderControl(is_array($cfgJson['senderControl'] ?? null) ? $cfgJson['senderControl'] : [], $cfgJson);
if (empty($sc['enableAutoCalibration'])) {
    sendResponse(false, null, 'ADMIN_DISABLED_AUTO_CALIBRATION: 管理员已关闭 AI 自动窗口校准，请改用本地手动框选', 200);
}
$keys = require __DIR__ . '/secret_key.php';
$localKeys = is_array($keys) ? $keys : [];
$visionKey = resolveDashscopeApiKey($cfgJson, $localKeys);
if ($visionKey === '') {
    sendResponse(false, null, '服务端视觉模型未配置，请联系管理员', 200);
}
$apiBase = trim((string)($cfgJson['identifyApiBase'] ?? '')) ?: (getenv('IDENTIFY_API_BASE') ?: ($localKeys['identifyApiBase'] ?? ''));
if ($apiBase === '') {
    $apiBase = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
} elseif (substr($apiBase, -17) !== '/chat/completions') {
    $apiBase = rtrim($apiBase, '/') . '/chat/completions';
}
// 环节 1：自动窗口校准（优先读 calibrateModel，缺失回退 identifyModel -> qwen3.8-max）
$model = trim((string)($cfgJson['calibrateModel'] ?? ''))
    ?: trim((string)($cfgJson['identifyModel'] ?? ''))
    ?: (getenv('IDENTIFY_MODEL') ?: ($localKeys['identifyModel'] ?? '') ?: 'qwen3.8-max');

if (!function_exists('curl_init')) {
    sendResponse(false, null, '服务端缺少 curl 扩展', 200);
}

$prompt = '你是企业微信客户端界面分析专家。图中是一个在 Windows 上运行的企业微信客户端主窗口截图。'
    . '请在图中精准定位当前主聊天会话区域（核心沟通区域）的两个关键矩形：'
    . '1. title_bar（顶部标题栏）：主聊天区域顶部的水平横条，显示当前聊天对象的姓名/群名/在线状态或右侧操作图标。左边界紧贴聊天区左侧分界线，高度约40-70像素。'
    . '2. input_box（底部输入框）：主聊天区域底部的消息输入与发送区域，包含表情工具栏、文字输入区和「发送(S)」按钮，底边界紧贴窗口下沿，高度约120-240像素。'
    . '【边界与防误识别关键规则】：'
    . '① 左边界：绝对不要包含最左侧的深灰/浅蓝导航图标栏与会话/联系人列表栏。'
    . '② 右边界：必须精准止于聊天主区域的右侧垂直分界线。特别注意：若聊天区右侧展开了【查找聊天记录面板】或【学员详情/客户画像/快捷回复侧边栏】等额外功能栏，右边界必须在聊天区与右侧功能栏之间的垂直分割线处截断（即以输入框右下角「发送(S)」按钮右侧边缘为界），绝对不能把右侧的查找记录或侧边栏包含进 title_bar 或 input_box 中！若右侧未展开任何额外面板，则右边界紧贴窗口右沿。'
    . '请严格输出 JSON（无 markdown 标记，无多余文字）：'
    . '{"success":true,"title_bar":[ymin,xmin,ymax,xmax],"input_box":[ymin,xmin,ymax,xmax],"reason":"简述检测到的会话对象或状态"}'
    . '坐标使用 0 到 1000 之间的整数归一化坐标。若图中未打开任何聊天会话，输出 {"success":false,"reason":"未检测到打开的聊天会话"}。';

function _img_data_url_cal($tmpPath, $info) {
    $mime = $info['mime'] === 'image/png' ? 'image/png' : 'image/jpeg';
    return 'data:' . $mime . ';base64,' . base64_encode(file_get_contents($tmpPath));
}

$payload = [
    'model' => $model,
    'messages' => [[
        'role' => 'user',
        'content' => [
            ['type' => 'text', 'text' => $prompt],
            ['type' => 'image_url', 'image_url' => ['url' => _img_data_url_cal($_FILES['image']['tmp_name'], $imgInfo)]],
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
    CURLOPT_TIMEOUT => 45,
]);
$raw = curl_exec($ch);
$httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlErr = curl_error($ch);
curl_close($ch);

if ($raw === false || $raw === '') {
    sendResponse(false, null, '视觉模型调用失败：' . $curlErr, 200);
}
$decoded = json_decode($raw, true);
$content = $decoded['choices'][0]['message']['content'] ?? '';
if (!is_string($content) || trim($content) === '') {
    $upErr = $decoded['error']['message'] ?? ('HTTP ' . $httpCode);
    sendResponse(false, null, '视觉模型返回为空：' . $upErr, 200);
}

$text = trim($content);
// 移除可能存在的思维链 <think>...</think>
$text = preg_replace('/<think>[\s\S]*?<\/think>/i', '', $text);
$text = trim($text);
$text = preg_replace('/^```(?:json)?\s*/i', '', $text);
$text = preg_replace('/\s*```$/', '', $text);
if (!str_starts_with(trim($text), '{') || !str_ends_with(trim($text), '}')) {
    if (preg_match('/\{[\s\S]*\}/', $text, $m)) {
        $text = $m[0];
    }
}
$parsed = json_decode(trim($text), true);
if (!is_array($parsed)) {
    sendResponse(false, null, '视觉模型返回非 JSON', 200);
}

if (empty($parsed['success'])) {
    sendResponse(false, null, (string)($parsed['reason'] ?? '多模态未能在截图中检测到会话窗口'), 200);
}

// 解析并归一化坐标为 [rel_x, rel_y, rel_w, rel_h]
function _parse_box_rel($box) {
    if (!is_array($box) || count($box) < 4) {
        return null;
    }
    $v0 = (float)$box[0];
    $v1 = (float)$box[1];
    $v2 = (float)$box[2];
    $v3 = (float)$box[3];
    if ($v0 > 1.0 || $v1 > 1.0 || $v2 > 1.0 || $v3 > 1.0) {
        $v0 /= 1000.0;
        $v1 /= 1000.0;
        $v2 /= 1000.0;
        $v3 /= 1000.0;
    }
    // 判断哪对是 y(高小)，哪对是 x(宽大)
    $d02 = abs($v2 - $v0);
    $d13 = abs($v3 - $v1);
    if ($d02 < $d13) {
        $ymin = min($v0, $v2);
        $ymax = max($v0, $v2);
        $xmin = min($v1, $v3);
        $xmax = max($v1, $v3);
    } else {
        $ymin = min($v1, $v3);
        $ymax = max($v1, $v3);
        $xmin = min($v0, $v2);
        $xmax = max($v0, $v2);
    }
    $w = $xmax - $xmin;
    $h = $ymax - $ymin;
    if ($w <= 0.05 || $h <= 0.01 || $xmin < 0 || $ymin < 0 || $xmin + $w > 1.05 || $ymin + $h > 1.05) {
        return null;
    }
    return [
        round(max(0.0, min(1.0, $xmin)), 4),
        round(max(0.0, min(1.0, $ymin)), 4),
        round(max(0.0, min(1.0, $w)), 4),
        round(max(0.0, min(1.0, $h)), 4),
    ];
}

$titleRel = _parse_box_rel($parsed['title_bar'] ?? null);
$inputRel = _parse_box_rel($parsed['input_box'] ?? null);

if (!$titleRel || !$inputRel) {
    sendResponse(false, null, '检测到的窗口区域坐标不完整或越界', 200);
}

// 校验上下关系
$titleBottom = $titleRel[1] + $titleRel[3];
$inputTop = $inputRel[1];
if ($inputTop <= $titleBottom) {
    sendResponse(false, null, '检测到输入框位置异常（压住标题栏）', 200);
}

// 计算聊天区
$chatX = min($titleRel[0], $inputRel[0]);
$chatY = $titleBottom;
$chatW = max($titleRel[0] + $titleRel[2], $inputRel[0] + $inputRel[2]) - $chatX;
$chatH = $inputTop - $chatY;

if ($chatH < 0.04) {
    sendResponse(false, null, '检测到的聊天消息区高度过小', 200);
}

$chatRel = [
    round($chatX, 4),
    round($chatY, 4),
    round($chatW, 4),
    round($chatH, 4),
];

$out = [
    'title' => $titleRel,
    'input' => $inputRel,
    'chat'  => $chatRel,
    'reason' => (string)($parsed['reason'] ?? 'Qwen3.8-Max 自动识别成功'),
    'duration_ms' => (int)round((microtime(true) - $t0) * 1000),
];

sendResponse(true, $out, 'ok');
