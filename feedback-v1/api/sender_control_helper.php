<?php
/**
 * 发送器云控策略与远程指令共享辅助模块 (Two-Tier Cloud Control)
 *
 * Tier 1（轻档 · 全局策略）：存储在 config.json['senderControl'] 中，决定所有端点的默认策略、
 *   版本门禁、停服锁定、全员公告与防风控节奏参数。
 * Tier 2（重档 · 单机控制）：按 client_slug 存储在 data/sender_control/clients/<slug>.json 中，
 *   支持针对特定电脑下发一次性远程指令（如 stop_batch 远程急停）与单机策略覆盖。
 */

const SENDER_CONTROL_VERIFY_MODES = ['auto', 'local', 'api'];
const SENDER_CONTROL_SNAPSHOT_POLICIES = ['errors_only', 'always', 'off'];
const SENDER_CONTROL_VERSION_ACTIONS = ['block', 'warn'];
const SENDER_CONTROL_COMMAND_TYPES = ['stop_batch', 'refresh_policy', 'clear_roi', 'sync_logs'];

function getSenderControlStorageDir(): string {
    $dir = __DIR__ . '/../data/sender_control/clients';
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
    return $dir;
}

function getDefaultSenderControlPolicy(): array {
    return [
        'policyVersion' => 1,
        'senderServiceEnabled' => true,
        'verifyMode' => 'auto',
        'enableReplyAnalysis' => true,
        'snapshotPolicy' => 'errors_only',
        'minSenderVersion' => '',
        'minVersionAction' => 'block',
        'updateUrl' => '',
        'noticeMessage' => '',
        'searchWait' => 1.5,
        'enterWait' => 1.2,
        'studentGapMin' => 0.5,
        'studentGapMax' => 1.0,
        'batchBreakEvery' => 15,
        'batchBreakMin' => 2.0,
        'batchBreakMax' => 3.0,
        'updatedAt' => '',
    ];
}

function clampFloat($val, float $min, float $max, float $default): float {
    if ($val === null || $val === '' || !is_numeric($val)) {
        return $default;
    }
    $f = round((float)$val, 2);
    if ($f < $min) return $min;
    if ($f > $max) return $max;
    return $f;
}

function clampInt($val, int $min, int $max, int $default): int {
    if ($val === null || $val === '' || !is_numeric($val)) {
        return $default;
    }
    $i = (int)$val;
    if ($i < $min) return $min;
    if ($i > $max) return $max;
    return $i;
}

function sanitizeControlVersion(string $ver): string {
    $ver = trim($ver);
    $ver = preg_replace('/^[vV]/', '', $ver);
    if ($ver === '' || !preg_match('/^\d+(?:\.\d+){0,3}(?:[-+][A-Za-z0-9._-]+)?$/', $ver)) {
        return '';
    }
    return substr($ver, 0, 32);
}

function sanitizeControlUrl(string $url): string {
    $url = trim($url);
    if ($url === '') return '';
    if (!preg_match('#^https?://#i', $url)) return '';
    return substr($url, 0, 500);
}

/**
 * 规范化全局发送器云控策略，并保持与历史字段 disableQwenFlashTitle 一致。
 */
function normalizeGlobalSenderControl(array $raw = [], array $rootConfig = []): array {
    $defaults = getDefaultSenderControlPolicy();
    $out = $defaults;

    $out['policyVersion'] = max(1, (int)($raw['policyVersion'] ?? 1));
    if (array_key_exists('senderServiceEnabled', $raw)) {
        $out['senderServiceEnabled'] = (bool)$raw['senderServiceEnabled'];
    }

    // verifyMode 优先读 senderControl.verifyMode，缺失时按 disableQwenFlashTitle 派生
    $verifyMode = strtolower(trim((string)($raw['verifyMode'] ?? '')));
    if (!in_array($verifyMode, SENDER_CONTROL_VERIFY_MODES, true)) {
        $verifyMode = !empty($rootConfig['disableQwenFlashTitle']) ? 'local' : 'auto';
    }
    $out['verifyMode'] = $verifyMode;

    if (array_key_exists('enableReplyAnalysis', $raw)) {
        $out['enableReplyAnalysis'] = (bool)$raw['enableReplyAnalysis'];
    }

    $snap = strtolower(trim((string)($raw['snapshotPolicy'] ?? $defaults['snapshotPolicy'])));
    $out['snapshotPolicy'] = in_array($snap, SENDER_CONTROL_SNAPSHOT_POLICIES, true) ? $snap : $defaults['snapshotPolicy'];

    $out['minSenderVersion'] = sanitizeControlVersion((string)($raw['minSenderVersion'] ?? ''));
    $verAct = strtolower(trim((string)($raw['minVersionAction'] ?? $defaults['minVersionAction'])));
    $out['minVersionAction'] = in_array($verAct, SENDER_CONTROL_VERSION_ACTIONS, true) ? $verAct : $defaults['minVersionAction'];
    $out['updateUrl'] = sanitizeControlUrl((string)($raw['updateUrl'] ?? ''));
    $out['noticeMessage'] = substr(trim((string)($raw['noticeMessage'] ?? '')), 0, 500);

    $out['searchWait'] = clampFloat($raw['searchWait'] ?? null, 0.4, 8.0, $defaults['searchWait']);
    $out['enterWait'] = clampFloat($raw['enterWait'] ?? null, 0.4, 8.0, $defaults['enterWait']);

    $gapMin = clampFloat($raw['studentGapMin'] ?? null, 0.0, 30.0, $defaults['studentGapMin']);
    $gapMax = clampFloat($raw['studentGapMax'] ?? null, 0.0, 30.0, $defaults['studentGapMax']);
    if ($gapMax < $gapMin) {
        $gapMax = $gapMin;
    }
    $out['studentGapMin'] = $gapMin;
    $out['studentGapMax'] = $gapMax;

    $out['batchBreakEvery'] = clampInt($raw['batchBreakEvery'] ?? null, 1, 200, $defaults['batchBreakEvery']);
    $brkMin = clampFloat($raw['batchBreakMin'] ?? null, 0.0, 60.0, $defaults['batchBreakMin']);
    $brkMax = clampFloat($raw['batchBreakMax'] ?? null, 0.0, 60.0, $defaults['batchBreakMax']);
    if ($brkMax < $brkMin) {
        $brkMax = $brkMin;
    }
    $out['batchBreakMin'] = $brkMin;
    $out['batchBreakMax'] = $brkMax;

    $out['updatedAt'] = trim((string)($raw['updatedAt'] ?? ''));
    return $out;
}

/**
 * 读取全局发送器云控策略（从 config.json 读入并规范化）。
 */
function loadGlobalSenderControl(?string $configFile = null): array {
    $cfgPath = $configFile ?: (__DIR__ . '/../config.json');
    $cfg = is_file($cfgPath) ? (@json_decode(@file_get_contents($cfgPath), true) ?: []) : [];
    if (!is_array($cfg)) {
        $cfg = [];
    }
    $raw = is_array($cfg['senderControl'] ?? null) ? $cfg['senderControl'] : [];
    return normalizeGlobalSenderControl($raw, $cfg);
}

function sanitizeControlSlug(string $slug): string {
    $clean = preg_replace('/[^a-zA-Z0-9_-]/', '_', trim($slug));
    $clean = trim((string)$clean, '_');
    if ($clean === '') {
        return 'unknown_pc';
    }
    return substr($clean, 0, 64);
}

function getClientControlFilePath(string $clientSlug): string {
    $slug = sanitizeControlSlug($clientSlug);
    return getSenderControlStorageDir() . '/' . $slug . '.json';
}

function normalizeClientOverrides(array $raw): array {
    $out = [];
    if (array_key_exists('senderServiceEnabled', $raw) && $raw['senderServiceEnabled'] !== null && $raw['senderServiceEnabled'] !== '') {
        $out['senderServiceEnabled'] = (bool)$raw['senderServiceEnabled'];
    }
    if (isset($raw['verifyMode'])) {
        $vm = strtolower(trim((string)$raw['verifyMode']));
        if (in_array($vm, SENDER_CONTROL_VERIFY_MODES, true)) {
            $out['verifyMode'] = $vm;
        }
    }
    if (array_key_exists('enableReplyAnalysis', $raw) && $raw['enableReplyAnalysis'] !== null && $raw['enableReplyAnalysis'] !== '') {
        $out['enableReplyAnalysis'] = (bool)$raw['enableReplyAnalysis'];
    }
    if (isset($raw['snapshotPolicy'])) {
        $sp = strtolower(trim((string)$raw['snapshotPolicy']));
        if (in_array($sp, SENDER_CONTROL_SNAPSHOT_POLICIES, true)) {
            $out['snapshotPolicy'] = $sp;
        }
    }
    if (array_key_exists('searchWait', $raw) && $raw['searchWait'] !== null && $raw['searchWait'] !== '' && is_numeric($raw['searchWait'])) {
        $out['searchWait'] = clampFloat($raw['searchWait'], 0.4, 8.0, 1.5);
    }
    if (array_key_exists('enterWait', $raw) && $raw['enterWait'] !== null && $raw['enterWait'] !== '' && is_numeric($raw['enterWait'])) {
        $out['enterWait'] = clampFloat($raw['enterWait'], 0.4, 8.0, 1.2);
    }
    if (array_key_exists('studentGapMin', $raw) && $raw['studentGapMin'] !== null && $raw['studentGapMin'] !== '' && is_numeric($raw['studentGapMin'])) {
        $out['studentGapMin'] = clampFloat($raw['studentGapMin'], 0.0, 30.0, 0.5);
    }
    if (array_key_exists('studentGapMax', $raw) && $raw['studentGapMax'] !== null && $raw['studentGapMax'] !== '' && is_numeric($raw['studentGapMax'])) {
        $out['studentGapMax'] = clampFloat($raw['studentGapMax'], 0.0, 30.0, 1.0);
    }
    if (isset($out['studentGapMin']) && isset($out['studentGapMax']) && $out['studentGapMax'] < $out['studentGapMin']) {
        $out['studentGapMax'] = $out['studentGapMin'];
    }
    if (array_key_exists('batchBreakEvery', $raw) && $raw['batchBreakEvery'] !== null && $raw['batchBreakEvery'] !== '' && is_numeric($raw['batchBreakEvery'])) {
        $out['batchBreakEvery'] = clampInt($raw['batchBreakEvery'], 1, 200, 15);
    }
    if (array_key_exists('batchBreakMin', $raw) && $raw['batchBreakMin'] !== null && $raw['batchBreakMin'] !== '' && is_numeric($raw['batchBreakMin'])) {
        $out['batchBreakMin'] = clampFloat($raw['batchBreakMin'], 0.0, 60.0, 2.0);
    }
    if (array_key_exists('batchBreakMax', $raw) && $raw['batchBreakMax'] !== null && $raw['batchBreakMax'] !== '' && is_numeric($raw['batchBreakMax'])) {
        $out['batchBreakMax'] = clampFloat($raw['batchBreakMax'], 0.0, 60.0, 3.0);
    }
    if (isset($out['batchBreakMin']) && isset($out['batchBreakMax']) && $out['batchBreakMax'] < $out['batchBreakMin']) {
        $out['batchBreakMax'] = $out['batchBreakMin'];
    }
    if (isset($raw['noticeMessage'])) {
        $nm = substr(trim((string)$raw['noticeMessage']), 0, 500);
        if ($nm !== '') {
            $out['noticeMessage'] = $nm;
        }
    }
    return $out;
}

function loadClientControlState(string $clientSlug): array {
    $slug = sanitizeControlSlug($clientSlug);
    $path = getClientControlFilePath($slug);
    $empty = [
        'client_slug' => $slug,
        'overrides' => [],
        'note' => '',
        'updated_at' => '',
        'commands' => [],
    ];
    if (!is_file($path)) {
        return $empty;
    }
    $data = @json_decode(@file_get_contents($path), true);
    if (!is_array($data)) {
        return $empty;
    }
    return [
        'client_slug' => $slug,
        'overrides' => normalizeClientOverrides(is_array($data['overrides'] ?? null) ? $data['overrides'] : []),
        'note' => substr(trim((string)($data['note'] ?? '')), 0, 200),
        'updated_at' => (string)($data['updated_at'] ?? ''),
        'commands' => array_values(array_filter(is_array($data['commands'] ?? null) ? $data['commands'] : [], 'is_array')),
    ];
}

function saveClientControlState(string $clientSlug, array $state): bool {
    $slug = sanitizeControlSlug($clientSlug);
    $path = getClientControlFilePath($slug);
    $payload = [
        'client_slug' => $slug,
        'overrides' => normalizeClientOverrides(is_array($state['overrides'] ?? null) ? $state['overrides'] : []),
        'note' => substr(trim((string)($state['note'] ?? '')), 0, 200),
        'updated_at' => (string)($state['updated_at'] ?? date('Y-m-d H:i:s')),
        'commands' => array_slice(array_values(is_array($state['commands'] ?? null) ? $state['commands'] : []), -30),
    ];
    return @file_put_contents($path, json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), LOCK_EX) !== false;
}

function setClientControlOverrides(string $clientSlug, array $overrides, string $note = ''): array {
    $state = loadClientControlState($clientSlug);
    $cleanOverrides = normalizeClientOverrides($overrides);
    $state['overrides'] = $cleanOverrides;
    $state['note'] = substr(trim($note), 0, 200);
    $state['updated_at'] = date('Y-m-d H:i:s');
    saveClientControlState($clientSlug, $state);
    return $state;
}

function enqueueClientRemoteCommand(string $clientSlug, string $cmdType, array $params = [], string $operator = 'admin'): ?array {
    $type = strtolower(trim($cmdType));
    if (!in_array($type, SENDER_CONTROL_COMMAND_TYPES, true)) {
        return null;
    }
    $state = loadClientControlState($clientSlug);
    try {
        $randHex = bin2hex(random_bytes(4));
    } catch (Throwable $e) {
        $randHex = substr(md5((string)microtime(true)), 0, 8);
    }
    $cmd = [
        'cmd_id' => 'cmd_' . date('YmdHis') . '_' . $randHex,
        'type' => $type,
        'params' => $params,
        'created_at' => date('Y-m-d H:i:s'),
        'created_ts' => time(),
        'created_by' => substr(trim($operator) ?: 'admin', 0, 60),
        'delivered_at' => '',
        'acked_at' => '',
        'ack_status' => '',
        'ack_message' => '',
    ];
    $commands = $state['commands'];
    // 同类型未回执指令自动去重替换，防止管理员连续双击堆积过多重复指令
    $commands = array_values(array_filter($commands, function ($existing) use ($type) {
        return !(($existing['type'] ?? '') === $type && empty($existing['acked_at']));
    }));
    $commands[] = $cmd;
    $state['commands'] = array_slice($commands, -30);
    $state['updated_at'] = date('Y-m-d H:i:s');
    saveClientControlState($clientSlug, $state);
    return $cmd;
}

/**
 * 标记客户端已回执的指令，并记录完成状态。
 */
function acknowledgeClientCommands(string $clientSlug, array $acks): int {
    if (empty($acks)) return 0;
    $ackMap = [];
    foreach ($acks as $item) {
        if (is_string($item) && trim($item) !== '') {
            $ackMap[trim($item)] = ['status' => 'ok', 'message' => ''];
        } elseif (is_array($item) && !empty($item['cmd_id'])) {
            $ackMap[trim((string)$item['cmd_id'])] = [
                'status' => substr(trim((string)($item['status'] ?? 'ok')), 0, 30),
                'message' => substr(trim((string)($item['message'] ?? '')), 0, 300),
            ];
        }
    }
    if (empty($ackMap)) return 0;

    $state = loadClientControlState($clientSlug);
    $changed = 0;
    $now = date('Y-m-d H:i:s');
    foreach ($state['commands'] as &$cmd) {
        $cid = (string)($cmd['cmd_id'] ?? '');
        if ($cid !== '' && isset($ackMap[$cid]) && empty($cmd['acked_at'])) {
            $cmd['acked_at'] = $now;
            if (empty($cmd['delivered_at'])) {
                $cmd['delivered_at'] = $now;
            }
            $cmd['ack_status'] = $ackMap[$cid]['status'];
            $cmd['ack_message'] = $ackMap[$cid]['message'];
            $changed++;
        }
    }
    unset($cmd);

    if ($changed > 0) {
        saveClientControlState($clientSlug, $state);
    }
    return $changed;
}

/**
 * 合并 Tier 1 全局策略 + Tier 2 单机覆盖策略 + 待执行指令队列，生成发送器下发载荷。
 */
function buildEffectiveSenderControl(string $clientSlug, ?string $configFile = null, bool $markDelivered = true): array {
    $global = loadGlobalSenderControl($configFile);
    $clientState = loadClientControlState($clientSlug);
    $overrides = $clientState['overrides'];

    $effective = $global;
    foreach ($overrides as $k => $v) {
        if ($k === 'noticeMessage') {
            $globalNotice = trim((string)($global['noticeMessage'] ?? ''));
            $clientNotice = trim((string)$v);
            if ($clientNotice !== '' && $globalNotice !== '' && $clientNotice !== $globalNotice) {
                $effective['noticeMessage'] = "[定向通知] {$clientNotice}\n[全员公告] {$globalNotice}";
            } elseif ($clientNotice !== '') {
                $effective['noticeMessage'] = $clientNotice;
            }
        } else {
            $effective[$k] = $v;
        }
    }

    if ($effective['studentGapMax'] < $effective['studentGapMin']) {
        $effective['studentGapMax'] = $effective['studentGapMin'];
    }
    if ($effective['batchBreakMax'] < $effective['batchBreakMin']) {
        $effective['batchBreakMax'] = $effective['batchBreakMin'];
    }

    // 收集未回执且未过期的待执行指令（>24小时的旧指令自动过期避免误触发）
    $nowTs = time();
    $nowStr = date('Y-m-d H:i:s', $nowTs);
    $pending = [];
    $deliveryUpdated = false;
    foreach ($clientState['commands'] as &$cmd) {
        if (!empty($cmd['acked_at'])) continue;
        $createdTs = (int)($cmd['created_ts'] ?? 0);
        if ($createdTs > 0 && ($nowTs - $createdTs) > 86400) {
            $cmd['acked_at'] = $nowStr;
            $cmd['ack_status'] = 'expired';
            $cmd['ack_message'] = '指令超过24小时未上线，已自动失效';
            $deliveryUpdated = true;
            continue;
        }
        if ($markDelivered && empty($cmd['delivered_at'])) {
            $cmd['delivered_at'] = $nowStr;
            $deliveryUpdated = true;
        }
        $pending[] = [
            'cmd_id' => (string)$cmd['cmd_id'],
            'type' => (string)$cmd['type'],
            'params' => is_array($cmd['params'] ?? null) ? $cmd['params'] : [],
            'created_at' => (string)($cmd['created_at'] ?? ''),
            'created_by' => (string)($cmd['created_by'] ?? 'admin'),
        ];
    }
    unset($cmd);

    if ($deliveryUpdated) {
        saveClientControlState($clientSlug, $clientState);
    }

    return [
        'client_slug' => $clientState['client_slug'],
        'global_version' => (int)($global['policyVersion'] ?? 1),
        'has_client_override' => !empty($overrides),
        'client_overrides' => $overrides,
        'client_override_note' => $clientState['note'],
        'effective_policy' => $effective,
        'pending_commands' => $pending,
        'server_time' => $nowStr,
    ];
}

function summarizeClientControlForAdmin(string $clientSlug): array {
    $state = loadClientControlState($clientSlug);
    $pendingCount = 0;
    foreach ($state['commands'] as $c) {
        if (empty($c['acked_at'])) {
            $pendingCount++;
        }
    }
    return [
        'has_override' => !empty($state['overrides']),
        'overrides' => $state['overrides'],
        'override_note' => $state['note'],
        'updated_at' => $state['updated_at'],
        'pending_commands_count' => $pendingCount,
        'recent_commands' => array_slice(array_reverse($state['commands']), 0, 8),
    ];
}
