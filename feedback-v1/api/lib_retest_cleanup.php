<?php
/**
 * 错题本历史档案 / Token 清理辅助
 *
 * 后台删除 `student_records` 或 `class_batches` 时，数据库外键只会处理数据库行，
 * 不会清理 `data/history/token_map.json` 与 `学科_年级*.json`。本文件提供级联清理，
 * 避免“学情记录已删除，但错题本链接仍能打开”的问题。
 */

require_once __DIR__ . '/lib_retest_keys.php';

if (!function_exists('retest_cleanup_history_dir')) {
    function retest_cleanup_history_dir(?string $historyDir = null): string
    {
        if ($historyDir !== null && trim($historyDir) !== '') {
            return rtrim($historyDir, '/\\');
        }
        return dirname(__DIR__) . '/data/history';
    }
}

if (!function_exists('retest_cleanup_json_update')) {
    /**
     * 在排他锁内读取、修改并写回 JSON 文件。
     *
     * @param callable(array):array $mutator
     */
    function retest_cleanup_json_update(string $path, callable $mutator): bool
    {
        $fp = @fopen($path, 'c+');
        if (!$fp) {
            return false;
        }
        if (!flock($fp, LOCK_EX)) {
            fclose($fp);
            return false;
        }

        try {
            rewind($fp);
            $content = stream_get_contents($fp);
            $data = json_decode($content === false ? '' : $content, true);
            if (!is_array($data)) {
                $data = [];
            }

            $before = $data;
            $data = $mutator($data);
            if (!is_array($data)) {
                $data = [];
            }
            if ($data === $before) {
                return true;
            }

            $output = empty($data)
                ? '{}'
                : json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
            if ($output === false) {
                return false;
            }

            ftruncate($fp, 0);
            rewind($fp);
            if (fwrite($fp, $output) === false) {
                return false;
            }
            fflush($fp);
            return true;
        } finally {
            flock($fp, LOCK_UN);
            fclose($fp);
        }
    }
}

if (!function_exists('retest_cleanup_history_files')) {
    /**
     * 返回某学科/年级对应的错题历史文件（含旧班型档案与预习档案）。
     *
     * @return string[]
     */
    function retest_cleanup_history_files(string $subject, string $grade, ?string $historyDir = null): array
    {
        $dir = retest_cleanup_history_dir($historyDir);
        $base = $dir . '/' . rawurlencode($subject) . '_' . rawurlencode($grade);
        $files = [];

        if (is_file($base . '.json')) {
            $files[] = $base . '.json';
        }
        foreach (glob($base . '_*.json') ?: [] as $file) {
            if (substr($file, -strlen('_preview.json')) === '_preview.json') {
                continue;
            }
            $files[] = $file;
        }
        if (is_file($base . '_preview.json')) {
            $files[] = $base . '_preview.json';
        }

        return array_values(array_unique($files));
    }
}

if (!function_exists('retest_cleanup_purge_history')) {
    /**
     * 从历史档案中删除学生数据。
     *
     * @param string[] $keys 学生 Key 候选
     * @param int[]|null $weeks null 表示删除该学生全部周次；数组表示只删除指定周次
     * @return array{files:int,keys_removed:int,weeks_removed:int,paths:string[]}
     */
    function retest_cleanup_purge_history(
        string $subject,
        string $grade,
        array $keys,
        ?array $weeks = null,
        ?string $historyDir = null
    ): array {
        $keys = array_values(array_unique(array_filter(array_map('strval', $keys), static fn($k) => $k !== '')));
        $stats = ['files' => 0, 'keys_removed' => 0, 'weeks_removed' => 0, 'paths' => []];
        if (empty($keys)) {
            return $stats;
        }

        $weekSet = [];
        if ($weeks !== null) {
            foreach ($weeks as $week) {
                $week = (int)$week;
                if ($week > 0) {
                    $weekSet[(string)$week] = true;
                }
            }
            if (empty($weekSet)) {
                return $stats;
            }
        }

        foreach (retest_cleanup_history_files($subject, $grade, $historyDir) as $file) {
            $keysRemoved = 0;
            $weeksRemoved = 0;
            $ok = retest_cleanup_json_update($file, static function (array $data) use ($keys, $weekSet, $weeks, &$keysRemoved, &$weeksRemoved): array {
                foreach ($keys as $key) {
                    if (!isset($data[$key]) || !is_array($data[$key])) {
                        continue;
                    }
                    if ($weeks === null) {
                        unset($data[$key]);
                        $keysRemoved++;
                        continue;
                    }
                    foreach (array_keys($weekSet) as $week) {
                        if (array_key_exists($week, $data[$key])) {
                            unset($data[$key][$week]);
                            $weeksRemoved++;
                        }
                    }
                    if (empty($data[$key])) {
                        unset($data[$key]);
                    }
                }
                return $data;
            });
            if ($ok && ($keysRemoved > 0 || $weeksRemoved > 0)) {
                $stats['files']++;
                $stats['paths'][] = $file;
                $stats['keys_removed'] += $keysRemoved;
                $stats['weeks_removed'] += $weeksRemoved;
            }
        }

        return $stats;
    }
}

if (!function_exists('retest_cleanup_token_matches_student')) {
    /**
     * Token 条目是否属于目标学生。
     * 仅纯姓名旧 Key 才允许按姓名兜底，避免同名不同学号互相误删。
     *
     * @param array<string,mixed> $entry
     * @param string[] $keys
     * @param string[] $names
     * @param string[] $ids
     */
    function retest_cleanup_token_matches_student(array $entry, array $keys, array $names, array $ids): bool
    {
        $entryKey = (string)($entry['k'] ?? '');
        $entryName = (string)($entry['n'] ?? '');
        $entryId = (string)($entry['id'] ?? '');

        if ($entryKey !== '' && in_array($entryKey, $keys, true)) {
            return true;
        }
        if (($entryKey === '' || $entryKey === $entryName)
            && $entryName !== '' && in_array($entryName, $names, true)) {
            if (empty($ids) || $entryId === '' || in_array($entryId, $ids, true)) {
                return true;
            }
        }

        return false;
    }
}

if (!function_exists('retest_cleanup_purge_tokens')) {
    /**
     * 删除或修正 token_map.json 中的 Token 映射。
     *
     * 若该学生已无剩余周次，则删除 Token；若仍有其它周次，则把 Token 指向剩余最大周次，
     * 并清空可能指向已删除周次的预习兜底数据。
     *
     * @param string[] $keys
     * @param string[] $names
     * @param string[] $ids
     * @param int[] $deletedWeeks
     * @param int[] $remainingWeeks
     * @return array{removed:string[],updated:string[]}
     */
    function retest_cleanup_purge_tokens(
        string $subject,
        string $grade,
        array $keys,
        array $names,
        array $ids,
        array $deletedWeeks,
        array $remainingWeeks,
        ?string $historyDir = null
    ): array {
        $stats = ['removed' => [], 'updated' => []];
        $tokenMapFile = retest_cleanup_history_dir($historyDir) . '/token_map.json';
        if (!is_file($tokenMapFile)) {
            return $stats;
        }

        $keys = array_values(array_unique(array_filter(array_map('strval', $keys), static fn($k) => $k !== '')));
        $names = array_values(array_unique(array_filter(array_map('strval', $names), static fn($n) => $n !== '')));
        $ids = array_values(array_unique(array_filter(array_map('strval', $ids), static fn($i) => $i !== '')));
        $deletedWeekSet = [];
        foreach ($deletedWeeks as $week) {
            $week = (int)$week;
            if ($week > 0) {
                $deletedWeekSet[$week] = true;
            }
        }
        $remainingWeeks = array_values(array_unique(array_filter(array_map('intval', $remainingWeeks), static fn($w) => $w > 0)));
        sort($remainingWeeks);

        retest_cleanup_json_update($tokenMapFile, static function (array $data) use (
            $subject,
            $grade,
            $keys,
            $names,
            $ids,
            $deletedWeekSet,
            $remainingWeeks,
            &$stats
        ): array {
            foreach ($data as $token => $entry) {
                if (!is_array($entry)) {
                    continue;
                }
                if ((string)($entry['s'] ?? '') !== $subject || (string)($entry['g'] ?? '') !== $grade) {
                    continue;
                }

                if (!retest_cleanup_token_matches_student($entry, $keys, $names, $ids)) {
                    continue;
                }

                if (empty($remainingWeeks)) {
                    unset($data[$token]);
                    $stats['removed'][] = (string)$token;
                    continue;
                }

                $tokenWeek = (int)($entry['w'] ?? 0);
                if (isset($deletedWeekSet[$tokenWeek]) && !in_array($tokenWeek, $remainingWeeks, true)) {
                    $entry['w'] = max($remainingWeeks);
                    $entry['pw'] = 0;
                    $entry['pq'] = [];
                    $data[$token] = $entry;
                    $stats['updated'][] = (string)$token;
                }
            }
            return $data;
        });

        return $stats;
    }
}

if (!function_exists('retest_cleanup_query_remaining_weeks')) {
    /**
     * 查询删除后该学生在同一学科/年级下剩余的周次。
     * 返回 null 表示查询失败，调用方应只做保守清理。
     *
     * @param string[] $keys
     * @param string[] $names
     * @return int[]|null
     */
    function retest_cleanup_query_remaining_weeks(string $subject, string $grade, array $keys, array $names): ?array
    {
        if (!class_exists('DB')) {
            return null;
        }

        $keys = array_values(array_unique(array_filter(array_map('strval', $keys), static fn($k) => $k !== '')));
        $names = array_values(array_unique(array_filter(array_map('strval', $names), static fn($n) => $n !== '')));
        if (empty($keys) && empty($names)) {
            return [];
        }

        $parts = [];
        $params = [$subject, $grade];
        if (!empty($keys)) {
            $placeholders = implode(',', array_fill(0, count($keys), '?'));
            $parts[] = "sr.student_key IN ({$placeholders})";
            $params = array_merge($params, $keys);
        }
        if (!empty($names)) {
            $placeholders = implode(',', array_fill(0, count($names), '?'));
            $parts[] = "((sr.student_key IS NULL OR sr.student_key = '' OR sr.student_key = sr.student_name) AND sr.student_name IN ({$placeholders}))";
            $params = array_merge($params, $names);
        }

        $sql = "SELECT DISTINCT sr.week_num
                FROM `student_records` sr
                INNER JOIN `class_batches` cb ON sr.batch_id = cb.id
                WHERE cb.subject = ? AND cb.grade = ? AND (" . implode(' OR ', $parts) . ")";
        $rows = DB::fetchAll($sql, $params);
        if (DB::getLastError()) {
            return null;
        }

        return array_values(array_unique(array_map('intval', array_column($rows, 'week_num'))));
    }
}

if (!function_exists('retest_cleanup_after_deleted_records')) {
    /**
     * 删除 student_records / class_batches 后调用，级联清理历史 JSON 与 Token。
     *
     * @param array<int,array<string,mixed>> $affectedRows 删除前抓取的学生记录（需含 subject/grade）
     * @return array<int,array<string,mixed>>
     */
    function retest_cleanup_after_deleted_records(array $affectedRows, ?string $historyDir = null): array
    {
        $groups = [];
        foreach ($affectedRows as $row) {
            if (!is_array($row)) {
                continue;
            }
            $subject = trim((string)($row['subject'] ?? ''));
            $grade = trim((string)($row['grade'] ?? ''));
            if ($subject === '' || $grade === '') {
                continue;
            }

            $studentId = trim((string)($row['student_id'] ?? ''));
            $studentName = trim((string)($row['student_name'] ?? ''));
            $studentKey = trim((string)($row['student_key'] ?? ''));

            // 同一学科/年级下按学生身份分组；同一学生的多条周次必须先合并，
            // 再按该学生自己的剩余周次判断，不能用全组并集，否则会互相掩盖。
            $studentIdentity = $studentId !== ''
                ? 'id:' . $studentId
                : ($studentName !== '' ? 'name:' . $studentName : ($studentKey !== '' ? 'key:' . $studentKey : ''));
            if ($studentIdentity === '') {
                continue;
            }

            $groupId = $subject . "\0" . $grade;
            if (!isset($groups[$groupId])) {
                $groups[$groupId] = [
                    'subject' => $subject,
                    'grade' => $grade,
                    'students' => [],
                ];
            }
            if (!isset($groups[$groupId]['students'][$studentIdentity])) {
                $groups[$groupId]['students'][$studentIdentity] = [
                    'keys' => [],
                    'names' => [],
                    'ids' => [],
                    'weeks' => [],
                ];
            }
            $student = &$groups[$groupId]['students'][$studentIdentity];

            $keys = student_key_candidates($studentId, $studentName, $grade, $subject);
            if ($studentKey !== '') {
                $keys[] = $studentKey;
            }
            foreach ($keys as $key) {
                if ($key !== '') {
                    $student['keys'][$key] = $key;
                }
            }
            if ($studentName !== '') {
                $student['names'][$studentName] = $studentName;
            }
            if ($studentId !== '') {
                $student['ids'][$studentId] = $studentId;
            }
            $week = (int)($row['week_num'] ?? 0);
            if ($week > 0) {
                $student['weeks'][$week] = $week;
            }
            unset($student);
        }

        $results = [];
        foreach ($groups as $group) {
            $groupKeys = [];
            $groupDeletedWeeks = [];
            $groupRemainingWeeks = [];
            $dbQueryFailed = false;
            $fullPurgeKeys = [];
            $fullPurgeNames = [];
            $fullPurgeIds = [];
            $partialPurges = [];
            $historyStats = ['files' => 0, 'keys_removed' => 0, 'weeks_removed' => 0, 'paths' => []];
            $tokenStats = ['removed' => [], 'updated' => []];

            foreach ($group['students'] as $student) {
                $keys = array_values($student['keys']);
                $names = array_values($student['names']);
                $ids = array_values($student['ids']);
                $weeks = array_values($student['weeks']);

                foreach ($keys as $key) {
                    $groupKeys[$key] = $key;
                }
                foreach ($weeks as $week) {
                    $groupDeletedWeeks[$week] = $week;
                }

                $remainingWeeks = retest_cleanup_query_remaining_weeks($group['subject'], $group['grade'], $keys, $names);
                if ($remainingWeeks === null) {
                    // 数据库查询失败时保守处理：只删明确删除的周次，不整体清空学生档案。
                    $dbQueryFailed = true;
                    if (!empty($weeks)) {
                        $partialPurges[] = ['keys' => $keys, 'weeks' => $weeks];
                    }
                    continue;
                }

                foreach ($remainingWeeks as $week) {
                    $groupRemainingWeeks[$week] = $week;
                }

                if (empty($remainingWeeks)) {
                    // 该学生已无任何数据库记录：合并到整组清理，避免逐人重写文件。
                    foreach ($keys as $key) {
                        $fullPurgeKeys[$key] = $key;
                    }
                    foreach ($names as $name) {
                        $fullPurgeNames[$name] = $name;
                    }
                    foreach ($ids as $id) {
                        $fullPurgeIds[$id] = $id;
                    }
                    continue;
                }

                // 同一周次可能还存在其它批次的有效记录（如重读/补交），
                // 这些周次不能跟着本次删除一起清掉。
                $weeksToPurge = array_values(array_diff($weeks, $remainingWeeks));
                if (!empty($weeksToPurge)) {
                    $partialPurges[] = ['keys' => $keys, 'weeks' => $weeksToPurge];
                }
                $tokens = retest_cleanup_purge_tokens(
                    $group['subject'],
                    $group['grade'],
                    $keys,
                    $names,
                    $ids,
                    $weeksToPurge,
                    $remainingWeeks,
                    $historyDir
                );

                foreach ($tokens['removed'] as $token) {
                    $tokenStats['removed'][] = $token;
                }
                foreach ($tokens['updated'] as $token) {
                    $tokenStats['updated'][] = $token;
                }
            }

            // 整组已无记录的学生只写一次 token_map。
            if (!empty($fullPurgeKeys)) {
                $tokens = retest_cleanup_purge_tokens(
                    $group['subject'],
                    $group['grade'],
                    array_values($fullPurgeKeys),
                    array_values($fullPurgeNames),
                    array_values($fullPurgeIds),
                    [],
                    [],
                    $historyDir
                );
                foreach ($tokens['removed'] as $token) {
                    $tokenStats['removed'][] = $token;
                }
                foreach ($tokens['updated'] as $token) {
                    $tokenStats['updated'][] = $token;
                }
            }

            $mergeHistory = static function (array $history) use (&$historyStats): void {
                foreach ($history['paths'] ?? [] as $path) {
                    $historyStats['paths'][$path] = $path;
                }
                $historyStats['keys_removed'] += (int)($history['keys_removed'] ?? 0);
                $historyStats['weeks_removed'] += (int)($history['weeks_removed'] ?? 0);
            };

            // 已无记录的学生可以合并成一次清理，减少整班删除时的文件重写次数。
            if (!empty($fullPurgeKeys)) {
                $mergeHistory(retest_cleanup_purge_history(
                    $group['subject'],
                    $group['grade'],
                    array_values($fullPurgeKeys),
                    null,
                    $historyDir
                ));
            }
            foreach ($partialPurges as $purge) {
                $mergeHistory(retest_cleanup_purge_history(
                    $group['subject'],
                    $group['grade'],
                    $purge['keys'],
                    $purge['weeks'],
                    $historyDir
                ));
            }
            $historyStats['files'] = count($historyStats['paths']);

            $results[] = [
                'subject' => $group['subject'],
                'grade' => $group['grade'],
                'students' => count($group['students']),
                'keys' => array_values($groupKeys),
                'deleted_weeks' => array_values($groupDeletedWeeks),
                'remaining_weeks' => $dbQueryFailed ? null : array_values($groupRemainingWeeks),
                'db_query_failed' => $dbQueryFailed,
                'history' => [
                    'files' => $historyStats['files'],
                    'keys_removed' => $historyStats['keys_removed'],
                    'weeks_removed' => $historyStats['weeks_removed'],
                    'paths' => array_values($historyStats['paths']),
                ],
                'tokens' => [
                    'removed' => array_values(array_unique($tokenStats['removed'])),
                    'updated' => array_values(array_unique($tokenStats['updated'])),
                ],
            ];
        }

        return $results;
    }
}

if (!function_exists('retest_cleanup_inspect_student')) {
    /**
     * 供清理脚本 dry-run 使用：统计指定学生会命中多少历史周次与 Token。
     *
     * @param string[] $keys
     * @param int[]|null $weeks
     * @param string[] $names
     * @param string[] $ids
     * @return array{files:array<string,int>,history_weeks:int,tokens:string[]}
     */
    function retest_cleanup_inspect_student(
        string $subject,
        string $grade,
        array $keys,
        ?array $weeks = null,
        ?string $historyDir = null,
        array $names = [],
        array $ids = []
    ): array {
        $keys = array_values(array_unique(array_filter(array_map('strval', $keys), static fn($k) => $k !== '')));
        $names = array_values(array_unique(array_filter(array_map('strval', $names), static fn($n) => $n !== '')));
        $ids = array_values(array_unique(array_filter(array_map('strval', $ids), static fn($i) => $i !== '')));
        $weekSet = [];
        if ($weeks !== null) {
            foreach ($weeks as $week) {
                $week = (int)$week;
                if ($week > 0) {
                    $weekSet[(string)$week] = true;
                }
            }
        }

        $result = ['files' => [], 'history_weeks' => 0, 'tokens' => []];
        foreach (retest_cleanup_history_files($subject, $grade, $historyDir) as $file) {
            $data = json_decode((string)@file_get_contents($file), true);
            if (!is_array($data)) {
                continue;
            }
            $count = 0;
            foreach ($keys as $key) {
                if (!isset($data[$key]) || !is_array($data[$key])) {
                    continue;
                }
                if ($weeks === null) {
                    $count += count($data[$key]);
                } else {
                    foreach (array_keys($weekSet) as $week) {
                        if (array_key_exists($week, $data[$key])) {
                            $count++;
                        }
                    }
                }
            }
            if ($count > 0) {
                $result['files'][$file] = $count;
                $result['history_weeks'] += $count;
            }
        }

        $tokenMapFile = retest_cleanup_history_dir($historyDir) . '/token_map.json';
        if (is_file($tokenMapFile)) {
            $tokenMap = json_decode((string)@file_get_contents($tokenMapFile), true);
            if (is_array($tokenMap)) {
                foreach ($tokenMap as $token => $entry) {
                    if (!is_array($entry)) {
                        continue;
                    }
                    if ((string)($entry['s'] ?? '') !== $subject || (string)($entry['g'] ?? '') !== $grade) {
                        continue;
                    }
                    if (retest_cleanup_token_matches_student($entry, $keys, $names, $ids)) {
                        $result['tokens'][] = (string)$token;
                    }
                }
            }
        }

        return $result;
    }
}

if (!function_exists('retest_cleanup_add_revoked_token')) {
    function retest_cleanup_add_revoked_token(
        string $token,
        string $operator = 'system',
        string $reason = '',
        ?string $historyDir = null
    ): bool {
        $token = trim($token);
        if ($token === '') {
            return false;
        }
        $file = retest_cleanup_history_dir($historyDir) . '/revoked_tokens.json';
        return retest_cleanup_json_update($file, static function (array $data) use ($token, $operator, $reason): array {
            $data[$token] = [
                'by' => $operator,
                'at' => date('Y-m-d H:i:s'),
                'reason' => $reason,
            ];
            return $data;
        });
    }
}
