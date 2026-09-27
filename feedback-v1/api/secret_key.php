<?php
declare(strict_types=1);

/**
 * 极方教学反馈系统 - 服务端私密密钥配置 (api/secret_key.php)
 * 
 * 仅供后端 PHP 服务加载，严禁直接暴露给 Web 静态下载。
 */
$localSecretFile = __DIR__ . '/secret_key.local.php';
if (file_exists($localSecretFile)) {
    return require $localSecretFile;
}

$envSecret = getenv('RETEST_SECRET') ?: '';
if ($envSecret === '' || $envSecret === 'your-secret-key-template-placeholder') {
    // 拒绝以占位/空密钥运行：Token 与 admin_sig 将可预测，属高危
    http_response_code(500);
    error_log('secret_key.php: RETEST_SECRET 未配置，拒绝启动 (missing secret_key.local.php / RETEST_SECRET)');
    echo json_encode(['success' => false, 'error' => '服务端密钥未配置，请联系管理员'], JSON_UNESCAPED_UNICODE);
    exit;
}

return [
    'retestSecret' => $envSecret
];
