<?php
/**
 * 清理错题本历史档案与 Token（数据库已删除，但文件档案仍残留的情况）。
 *
 * 默认只做 dry-run，不写任何文件；确认后加 --apply。
 *
 * 单学生模式：
 *   php scripts/purge_retest_student.php --token=wPrNrbZNqK
 *   php scripts/purge_retest_student.php --token=wPrNrbZNqK --apply --revoke
 *   php scripts/purge_retest_student.php --subject=语文 --grade=八年级 --name=李四 --apply
 *
 * 孤儿数据模式（数据库已无该学生记录，但 Token / 历史档案还在）：
 *   php scripts/purge_retest_student.php --subject=语文 --orphans
 *   php scripts/purge_retest_student.php --subject=语文 --grade=八年级 --orphans --apply --revoke
 */

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "This script can only be run from CLI.\n");
    exit(1);
}

require_once __DIR__ . '/../api/lib_retest_keys.php';
require_once __DIR__ . '/../api/lib_retest_cleanup.php';

function purge_usage(): void
{
    $self = basename(__FILE__);
    fwrite(STDERR, <<<TXT
Usage:
  php {$self} --token=TOKEN [--apply] [--revoke]
  php {$self} --subject=语文 --grade=八年级 --name=李四 [--id=1001] [--key=KEY] [--apply] [--revoke]
  php {$self} --subject=语文 [--grade=八年级] --orphans [--apply] [--revoke]

Options:
  --token=TOKEN       从 data/history/token_map.json 解析学生信息
  --subject=SUBJECT   学科
  --grade=GRADE       年级
  --name=NAME         学生姓名
  --id=ID             学号
  --key=KEY           额外学生 Key（新/旧格式）
  --orphans           扫描数据库中已无记录、但仍残留 Token/历史档案的学生
  --history-dir=DIR   历史档案目录，默认 feedback-v1/data/history
  --apply             真正写入；不加时仅预览
  --revoke            清理后同时把 Token 加入 revoked_tokens.json
  --help              显示帮助

TXT);
}

$opts = getopt('', [
    'token::',
    'subject::',
    'grade::',
    'name::',
    'id::',
    'key::',
    'orphans',
    'history-dir::',
    'apply',
    'revoke',
    'help',
]);

if (isset($opts['help'])) {
    purge_usage();
    exit(0);
}

$historyDir = trim((string)($opts['history-dir'] ?? ''));
if ($historyDir === '') {
    $historyDir = dirname(__DIR__) . '/data/history';
}
$historyDir = rtrim($historyDir, '/\\');

$apply = isset($opts['apply']);
$revoke = isset($opts['revoke']);
$orphansMode = isset($opts['orphans']);

$tokenMapFile = $historyDir . '/token_map.json';
$tokenMap = [];
if (is_file($tokenMapFile)) {
    $tokenMap = json_decode((string)@file_get_contents($tokenMapFile), true);
    if (!is_array($tokenMap)) {
        fwrite(STDERR, "token_map.json 解析失败: {$tokenMapFile}\n");
        exit(2);
    }
}

/**
 * 按学生身份合并孤儿 Token，避免同一位学生的多个 Token 重复清理档案。
 *
 * @param array<string,array<string,mixed>> $tokenMap
 * @return array{groups:array<string,array<string,mixed>>,matched:int,invalid:int}
 */
function purge_collect_orphans(array $tokenMap, string $subject, string $grade): array
{
    $groups = [];
    $matched = 0;
    $invalid = 0;

    foreach ($tokenMap as $mapToken => $entry) {
        if (!is_array($entry)) {
            continue;
        }
        $entrySubject = trim((string)($entry['s'] ?? ''));
        $entryGrade = trim((string)($entry['g'] ?? ''));
        if ($entrySubject !== $subject) {
            continue;
        }
        if ($grade !== '' && $entryGrade !== $grade) {
            continue;
        }
        $matched++;

        $name = trim((string)($entry['n'] ?? ''));
        $studentId = trim((string)($entry['id'] ?? ''));
        $entryKey = trim((string)($entry['k'] ?? ''));
        $keys = student_key_candidates($studentId, $name, $entryGrade, $entrySubject);
        if ($entryKey !== '') {
            $keys[] = $entryKey;
        }
        $keys = array_values(array_unique(array_filter($keys, static fn($key) => $key !== '')));
        if (empty($keys) && $name === '') {
            $invalid++;
            continue;
        }

        $names = $name !== '' ? [$name] : [];
        $ids = $studentId !== '' ? [$studentId] : [];
        $remainingWeeks = retest_cleanup_query_remaining_weeks($entrySubject, $entryGrade, $keys, $names);
        if ($remainingWeeks === null) {
            fwrite(STDERR, "数据库查询失败，无法判断学生是否仍有学情记录，已中止（未写入任何文件）。\n");
            exit(3);
        }
        if (!empty($remainingWeeks)) {
            continue;
        }

        $groupKey = $entrySubject . "\0" . $entryGrade . "\0" . ($studentId !== ''
            ? 'id:' . $studentId
            : ($name !== '' ? 'name:' . $name : 'keys:' . implode('|', $keys)));
        if (!isset($groups[$groupKey])) {
            $groups[$groupKey] = [
                'subject' => $entrySubject,
                'grade' => $entryGrade,
                'keys' => [],
                'names' => [],
                'ids' => [],
                'tokens' => [],
            ];
        }
        foreach ($keys as $key) {
            $groups[$groupKey]['keys'][$key] = $key;
        }
        foreach ($names as $n) {
            $groups[$groupKey]['names'][$n] = $n;
        }
        foreach ($ids as $id) {
            $groups[$groupKey]['ids'][$id] = $id;
        }
        $groups[$groupKey]['tokens'][(string)$mapToken] = (string)$mapToken;
    }

    foreach ($groups as &$group) {
        $group['keys'] = array_values($group['keys']);
        $group['names'] = array_values($group['names']);
        $group['ids'] = array_values($group['ids']);
        $group['tokens'] = array_values($group['tokens']);
    }
    unset($group);

    return ['groups' => $groups, 'matched' => $matched, 'invalid' => $invalid];
}

if ($orphansMode) {
    $orphanSubject = trim((string)($opts['subject'] ?? ''));
    $orphanGrade = trim((string)($opts['grade'] ?? ''));
    if ($orphanSubject === '') {
        fwrite(STDERR, "--orphans 模式必须提供 --subject；可选 --grade 限定年级。\n");
        purge_usage();
        exit(2);
    }
    if (isset($opts['token']) || isset($opts['name']) || isset($opts['id']) || isset($opts['key'])) {
        fwrite(STDERR, "--orphans 不能与 --token / --name / --id / --key 同时使用。\n");
        exit(2);
    }

    if (!class_exists('DB')) {
        require_once __DIR__ . '/../api/db.php';
    }
    if (!class_exists('DB')) {
        fwrite(STDERR, "无法加载数据库模块，已中止。\n");
        exit(3);
    }

    $collected = purge_collect_orphans($tokenMap, $orphanSubject, $orphanGrade);
    $groups = $collected['groups'];

    echo "错题本孤儿数据清理\n";
    echo "模式: " . ($apply ? "APPLY（会写入）" : "DRY-RUN（只预览）") . "\n";
    echo "历史目录: {$historyDir}\n";
    echo "学科/年级: {$orphanSubject} / " . ($orphanGrade !== '' ? $orphanGrade : '全部年级') . "\n";
    echo "扫描 Token: {$collected['matched']}\n";
    echo "发现孤儿学生: " . count($groups) . "\n";
    if ($collected['invalid'] > 0) {
        echo "身份信息缺失、无法处理的 Token: {$collected['invalid']}\n";
    }

    $totalHistoryWeeks = 0;
    $totalTokens = 0;
    foreach ($groups as $group) {
        $inspect = retest_cleanup_inspect_student(
            $group['subject'],
            $group['grade'],
            $group['keys'],
            null,
            $historyDir,
            $group['names'],
            $group['ids']
        );
        $totalHistoryWeeks += $inspect['history_weeks'];
        $totalTokens += count($group['tokens']);
        $displayName = !empty($group['names']) ? implode('/', $group['names']) : '(姓名未知)';
        $displayId = !empty($group['ids']) ? '(' . implode('/', $group['ids']) . ')' : '';
        echo "  - {$group['subject']}/{$group['grade']} {$displayName}{$displayId} "
            . "Token: " . implode(',', $group['tokens'])
            . " 历史 {$inspect['history_weeks']} 周\n";
    }
    echo "合计: 孤儿学生 " . count($groups) . " 名，历史 {$totalHistoryWeeks} 周，Token {$totalTokens} 个\n";

    if (!$apply) {
        echo "\n未写入任何文件。确认无误后加 --apply 执行清理。\n";
        exit(0);
    }

    $historyFiles = 0;
    $historyKeys = 0;
    $historyWeeks = 0;
    $tokensRemoved = 0;
    $tokensRevoked = 0;

    // 按学科/年级合并清理，避免整科孤儿数据逐人重写历史文件与 token_map。
    $purgeBuckets = [];
    foreach ($groups as $group) {
        $bucketKey = $group['subject'] . "\0" . $group['grade'];
        if (!isset($purgeBuckets[$bucketKey])) {
            $purgeBuckets[$bucketKey] = [
                'subject' => $group['subject'],
                'grade' => $group['grade'],
                'keys' => [],
                'names' => [],
                'ids' => [],
            ];
        }
        foreach ($group['keys'] as $key) {
            $purgeBuckets[$bucketKey]['keys'][$key] = $key;
        }
        foreach ($group['names'] as $name) {
            $purgeBuckets[$bucketKey]['names'][$name] = $name;
        }
        foreach ($group['ids'] as $id) {
            $purgeBuckets[$bucketKey]['ids'][$id] = $id;
        }
    }

    foreach ($purgeBuckets as $bucket) {
        $history = retest_cleanup_purge_history(
            $bucket['subject'],
            $bucket['grade'],
            array_values($bucket['keys']),
            null,
            $historyDir
        );
        $historyFiles += $history['files'];
        $historyKeys += $history['keys_removed'];
        $historyWeeks += $history['weeks_removed'];

        $tokenStats = retest_cleanup_purge_tokens(
            $bucket['subject'],
            $bucket['grade'],
            array_values($bucket['keys']),
            array_values($bucket['names']),
            array_values($bucket['ids']),
            [],
            [],
            $historyDir
        );
        $tokensRemoved += count($tokenStats['removed']);
    }

    if ($revoke) {
        foreach ($groups as $group) {
            foreach ($group['tokens'] as $orphanToken) {
                if (retest_cleanup_add_revoked_token($orphanToken, 'purge_script', '清理无学情记录的错题本 Token', $historyDir)) {
                    $tokensRevoked++;
                }
            }
        }
    }

    echo "\n清理完成:\n";
    echo "  历史文件: {$historyFiles} 个，删除 Key {$historyKeys} 个，删除周次 {$historyWeeks} 条\n";
    echo "  Token: 删除 {$tokensRemoved} 个\n";
    if ($revoke) {
        echo "  已作废 Token: {$tokensRevoked} 个\n";
    }
    echo "\n建议用原链接再请求一次 decrypt 接口，确认返回“链接无效或已过期”。\n";
    exit(0);
}

$token = trim((string)($opts['token'] ?? ''));
$tokenEntry = null;
if ($token !== '') {
    if (isset($tokenMap[$token])) {
        $tokenEntry = $tokenMap[$token];
    } else {
        foreach ($tokenMap as $mapToken => $entry) {
            if (strcasecmp((string)$mapToken, $token) === 0) {
                $token = (string)$mapToken;
                $tokenEntry = $entry;
                break;
            }
        }
    }
    if (!is_array($tokenEntry)) {
        fwrite(STDERR, "Token 不在 token_map.json 中，未找到可清理的学生信息: {$token}\n");
        fwrite(STDERR, "请改用 --subject/--grade/--name 指定学生，或使用 --subject=学科 --orphans 扫描孤儿数据。\n");
        exit(2);
    }
}

$subject = trim((string)($opts['subject'] ?? ($tokenEntry['s'] ?? '')));
$grade = trim((string)($opts['grade'] ?? ($tokenEntry['g'] ?? '')));
$name = trim((string)($opts['name'] ?? ($tokenEntry['n'] ?? '')));
$studentId = trim((string)($opts['id'] ?? ($tokenEntry['id'] ?? '')));
$extraKey = trim((string)($opts['key'] ?? ''));

if ($subject === '' || $grade === '') {
    fwrite(STDERR, "缺少 --subject 或 --grade，且无法从 Token 中解析。\n");
    purge_usage();
    exit(2);
}
if ($name === '' && $studentId === '' && $extraKey === '' && !is_array($tokenEntry)) {
    fwrite(STDERR, "缺少学生身份：请提供 --token，或至少提供 --name / --id / --key 之一。\n");
    exit(2);
}

$keys = student_key_candidates($studentId, $name, $grade, $subject);
if ($extraKey !== '') {
    $keys[] = $extraKey;
}
$keys = array_values(array_unique(array_filter($keys, static fn($key) => $key !== '')));

$inspect = retest_cleanup_inspect_student(
    $subject,
    $grade,
    $keys,
    null,
    $historyDir,
    $name !== '' ? [$name] : [],
    $studentId !== '' ? [$studentId] : []
);

echo "错题本数据清理\n";
echo "模式: " . ($apply ? "APPLY（会写入）" : "DRY-RUN（只预览）") . "\n";
echo "历史目录: {$historyDir}\n";
echo "Token: " . ($token !== '' ? $token : '(未指定)') . "\n";
echo "学科/年级: {$subject} / {$grade}\n";
echo "学生: " . ($name !== '' ? $name : '(姓名未知)') . ($studentId !== '' ? "（学号 {$studentId}）" : '') . "\n";
echo "Key 候选: " . implode(', ', $keys) . "\n";
echo "命中历史周次: {$inspect['history_weeks']}\n";
if (!empty($inspect['files'])) {
    foreach ($inspect['files'] as $file => $count) {
        echo "  - {$file}: {$count} 周\n";
    }
}
echo "命中 Token: " . (!empty($inspect['tokens']) ? implode(', ', $inspect['tokens']) : '(无)') . "\n";
echo "注意: 单学生模式会清空该生在本学科/年级下的全部错题本历史，不区分数据库中是否还有其它周次。\n";

if (!$apply) {
    echo "\n未写入任何文件。确认无误后加 --apply 执行清理。\n";
    exit(0);
}

$historyStats = retest_cleanup_purge_history($subject, $grade, $keys, null, $historyDir);
$tokenStats = retest_cleanup_purge_tokens(
    $subject,
    $grade,
    $keys,
    $name !== '' ? [$name] : [],
    $studentId !== '' ? [$studentId] : [],
    [],
    [],
    $historyDir
);

$tokensToRevoke = $inspect['tokens'];
if ($token !== '') {
    $tokensToRevoke[] = $token;
}
$tokensToRevoke = array_values(array_unique(array_filter($tokensToRevoke, static fn($t) => $t !== '')));
$revokedCount = 0;
if ($revoke) {
    foreach ($tokensToRevoke as $revokeToken) {
        if (retest_cleanup_add_revoked_token($revokeToken, 'purge_script', '清理学生数据时作废', $historyDir)) {
            $revokedCount++;
        }
    }
}

echo "\n清理完成:\n";
echo "  历史文件: {$historyStats['files']} 个，删除 Key {$historyStats['keys_removed']} 个，删除周次 {$historyStats['weeks_removed']} 条\n";
echo "  Token: 删除 " . count($tokenStats['removed']) . " 个，修正 " . count($tokenStats['updated']) . " 个\n";
if ($revoke) {
    echo "  已作废 Token: {$revokedCount} 个\n";
}
echo "\n建议用原链接再请求一次 decrypt 接口，确认返回“链接无效或已过期”。\n";
