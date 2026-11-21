<?php
/**
 * 发送器令牌鉴权与 AI 密钥隔离读取公共模块 (api/sender_auth_helper.php)
 *
 * 统一收敛：
 * 1. 发送器多令牌轮换校验（SENDER_API_TOKENS / SENDER_API_TOKEN / secret_key.local.php）
 *    与 ALLOW_DEFAULT_SENDER_TOKEN 严格开关（对齐 Go backend-go/internal/config/config.go）
 * 2. AI 视觉模型密钥隔离存储（data/.ai_secrets.json，权限 0600，与公开 config.json 解耦）
 * 3. 后台接口密钥掩码脱敏辅助函数
 */

if (!defined('DEFAULT_SENDER_TOKEN')) {
    define('DEFAULT_SENDER_TOKEN', 'jf_feedback_sender_internal_token_2026');
}

/**
 * 返回独立 AI 密钥文件路径（位于 data/ 下，受 Nginx location ^~ /data/ 拦截且不入库）
 */
function getAiSecretsFilePath(): string {
    return dirname(__DIR__) . '/data/.ai_secrets.json';
}

/**
 * 读取 data/.ai_secrets.json 内容
 */
function loadAiSecrets(): array {
    $path = getAiSecretsFilePath();
    if (!is_file($path)) {
        return [];
    }
    $raw = @file_get_contents($path);
    if ($raw === false || trim($raw) === '') {
        return [];
    }
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}

/**
 * 原子写入 data/.ai_secrets.json（0600 权限）
 */
function saveAiSecrets(array $secrets): bool {
    $path = getAiSecretsFilePath();
    $dir = dirname($path);
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
    $secrets['updatedAt'] = date('Y-m-d H:i:s');
    $json = json_encode($secrets, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    if ($json === false) {
        return false;
    }
    $tmp = $path . '.tmp.' . getmypid() . '.' . bin2hex(random_bytes(4));
    if (@file_put_contents($tmp, $json, LOCK_EX) === false) {
        @unlink($tmp);
        return false;
    }
    @chmod($tmp, 0600);
    if (!@rename($tmp, $path)) {
        @unlink($tmp);
        return false;
    }
    @chmod($path, 0600);
    return true;
}

/**
 * 对 API Key 进行掩码脱敏（保留前 4 位与后 4 位）
 */
function maskApiKey(string $key): string {
    $k = trim($key);
    if ($k === '') {
        return '';
    }
    $len = strlen($k);
    if ($len <= 8) {
        return '****';
    }
    return substr($k, 0, 4) . '****' . substr($k, -4);
}

/**
 * 判断输入值是否为掩码占位值
 */
function isMaskedApiKey(string $value): bool {
    return strpos(trim($value), '****') !== false;
}

/**
 * 统一解析 DashScope / 视觉模型 API Key
 * 优先级：data/.ai_secrets.json -> config.json（旧配置兼容） -> DASHSCOPE_API_KEY 环境变量 -> secret_key.local.php
 */
function resolveDashscopeApiKey(array $cfgJson = [], array $localKeys = []): string {
    $aiSecrets = loadAiSecrets();
    $fromAiSecrets = trim((string)($aiSecrets['dashscopeApiKey'] ?? ''));
    if ($fromAiSecrets !== '') {
        return $fromAiSecrets;
    }
    $fromCfg = trim((string)($cfgJson['dashscopeApiKey'] ?? ''));
    if ($fromCfg !== '') {
        return $fromCfg;
    }
    $fromEnv = trim((string)(getenv('DASHSCOPE_API_KEY') ?: ''));
    if ($fromEnv !== '') {
        return $fromEnv;
    }
    return trim((string)($localKeys['dashscopeApiKey'] ?? ''));
}

/**
 * 解析逗号分隔的令牌字符串为非空去重数组
 * @return string[]
 */
function splitSenderTokens(string $raw): array {
    $parts = explode(',', $raw);
    $out = [];
    foreach ($parts as $p) {
        $t = trim($p);
        if ($t !== '' && !in_array($t, $out, true)) {
            $out[] = $t;
        }
    }
    return $out;
}

/**
 * 解析服务端配置的自定义发送器令牌列表（支持多令牌平滑轮换）
 * 优先级：SENDER_API_TOKENS / SENDER_API_TOKEN 环境变量 -> secret_key.local.php (senderApiTokens / senderApiToken)
 * @return string[]
 */
function resolveServerSenderTokens(): array {
    $tokens = [];
    $envMulti = trim((string)(getenv('SENDER_API_TOKENS') ?: ''));
    if ($envMulti !== '') {
        $tokens = array_merge($tokens, splitSenderTokens($envMulti));
    }
    $envSingle = trim((string)(getenv('SENDER_API_TOKEN') ?: ''));
    if ($envSingle !== '' && !in_array($envSingle, $tokens, true)) {
        $tokens[] = $envSingle;
    }
    if (!empty($tokens)) {
        return $tokens;
    }

    $localFile = __DIR__ . '/secret_key.local.php';
    if (is_file($localFile)) {
        $local = require $localFile;
        if (is_array($local)) {
            if (!empty($local['senderApiTokens'])) {
                if (is_array($local['senderApiTokens'])) {
                    foreach ($local['senderApiTokens'] as $item) {
                        $t = trim((string)$item);
                        if ($t !== '' && !in_array($t, $tokens, true)) {
                            $tokens[] = $t;
                        }
                    }
                } else {
                    $tokens = array_merge($tokens, splitSenderTokens((string)$local['senderApiTokens']));
                }
            }
            if (!empty($local['senderApiToken'])) {
                $t = trim((string)$local['senderApiToken']);
                if ($t !== '' && !in_array($t, $tokens, true)) {
                    $tokens[] = $t;
                }
            }
        }
    }
    return $tokens;
}

/**
 * 是否允许在未配置自定义令牌时回退默认内置令牌（默认 true；设 ALLOW_DEFAULT_SENDER_TOKEN=false 可强制关闭）
 */
function allowDefaultSenderToken(): bool {
    $raw = getenv('ALLOW_DEFAULT_SENDER_TOKEN');
    if ($raw === false || trim((string)$raw) === '') {
        return true;
    }
    $norm = strtolower(trim((string)$raw));
    return !in_array($norm, ['0', 'false', 'no', 'off'], true);
}

/**
 * 统一校验发送器请求令牌（POST token 字段或 Authorization: Bearer）
 */
function verifySenderRequestToken(?string $given = null): bool {
    if ($given === null) {
        $given = (string)($_POST['token'] ?? '');
    }
    if ($given === '') {
        $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
        if (stripos($authHeader, 'bearer ') === 0) {
            $given = trim(substr($authHeader, 7));
        }
    }
    if ($given === '') {
        return false;
    }

    $serverTokens = resolveServerSenderTokens();
    if (!empty($serverTokens)) {
        foreach ($serverTokens as $expected) {
            if (hash_equals($expected, $given)) {
                return true;
            }
        }
        return false;
    }

    if (!allowDefaultSenderToken()) {
        return false;
    }

    if (hash_equals(DEFAULT_SENDER_TOKEN, $given)) {
        error_log('[SECURITY WARNING] SENDER_API_TOKEN is not configured; falling back to built-in DEFAULT_SENDER_TOKEN');
        return true;
    }
    return false;
}
