<?php
/**
 * 公开系统配置接口 (api/public_config.php)
 *
 * 背景：nginx 出于安全考虑拦截一切 *.json 直接访问（含可能残留历史密钥的
 * config.json），前端此前直读 config.json 实际全部 404，只能静默降级。
 * 本接口仅返回脱敏后的公开字段子集，无需登录，供各页面学期文案与开关使用。
 *
 * GET -> { success, data: { semesterYear, defaultSeason, semesterWeeks,
 *         forceIntegerScores, retestQuestionSpacing, retestQrCodeEnabled } }
 */

require_once __DIR__ . '/bootstrap.php';

$defaults = [
    'semesterYear' => 2026,
    'defaultSeason' => 'autumn',
    'semesterWeeks' => 18,
    'forceIntegerScores' => true,
    'retestQuestionSpacing' => 26,
    'retestQrCodeEnabled' => false,
];

$configFile = __DIR__ . '/../config.json';
if (file_exists($configFile)) {
    // _comment 为合法 JSON 字段，无需正则剥离，直接解码后忽略
    $raw = json_decode(file_get_contents($configFile), true);
    if (is_array($raw)) {
        foreach ($defaults as $k => $v) {
            if (array_key_exists($k, $raw)) {
                $defaults[$k] = $raw[$k];
            }
        }
    }
}

// 类型收敛，避免错误配置导致前端异常
$defaults['semesterYear'] = (int)$defaults['semesterYear'];
$defaults['defaultSeason'] = (string)$defaults['defaultSeason'];
$defaults['semesterWeeks'] = max(1, min(30, (int)$defaults['semesterWeeks']));
$defaults['forceIntegerScores'] = (bool)$defaults['forceIntegerScores'];
$defaults['retestQuestionSpacing'] = max(10, min(260, (int)$defaults['retestQuestionSpacing']));
$defaults['retestQrCodeEnabled'] = (bool)$defaults['retestQrCodeEnabled'];

// 注意：绝不在此输出 retestSecret / DB 凭据等敏感字段
// 扁平输出（而非 {success,data} 包裹），以兼容既有前端 c.xxx 直接访问写法
header('Cache-Control: public, max-age=300');
http_response_code(200);
echo json_encode(array_merge(['success' => true], $defaults), JSON_UNESCAPED_UNICODE);
exit;
