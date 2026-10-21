<?php
/**
 * 错题本学生身份 Key 纯函数库
 *
 * 统一身份格式：学号_姓名_年级_学科
 * 目的：同名学生（不同学号）绝不串档；学生换老师 / 换班型后，错题本历史仍连续。
 *
 * 兼容约定：
 * - 旧格式：学号_姓名（迁移前的数据、旧链接 token_map 中的 k）
 * - 无学号脏数据：纯姓名（仅这类数据允许在受控条件下按姓名兜底匹配）
 */

if (!function_exists('build_student_key')) {
    /**
     * 构建当前标准身份 Key。
     * 学号为空时退化为纯姓名；年级/学科缺失时退化为旧格式，避免拼出畸形 Key。
     */
    function build_student_key(string $id, string $name, string $grade, string $subject): string
    {
        $id = trim($id);
        $name = trim($name);
        $grade = trim($grade);
        $subject = trim($subject);

        if ($id === '') {
            return $name;
        }
        if ($grade === '' || $subject === '') {
            return "{$id}_{$name}";
        }
        return "{$id}_{$name}_{$grade}_{$subject}";
    }
}

if (!function_exists('legacy_student_key')) {
    /**
     * 旧格式 Key：学号_姓名。
     */
    function legacy_student_key(string $id, string $name): string
    {
        $id = trim($id);
        $name = trim($name);
        return $id !== '' ? "{$id}_{$name}" : $name;
    }
}

if (!function_exists('student_key_candidates')) {
    /**
     * 查询数据库 / 历史档案时使用的候选 Key（新格式优先，兼容旧格式）。
     * 无学号时只有纯姓名一个候选。
     *
     * @return string[]
     */
    function student_key_candidates(string $id, string $name, string $grade, string $subject): array
    {
        $keys = [build_student_key($id, $name, $grade, $subject)];
        $legacy = legacy_student_key($id, $name);
        if (!in_array($legacy, $keys, true)) {
            $keys[] = $legacy;
        }
        return array_values(array_unique(array_filter($keys, static fn($k) => $k !== '')));
    }
}

if (!function_exists('is_legacy_name_only_key')) {
    /**
     * 该行是否为"无学号旧数据"（Key 为空或等于姓名）。
     * 只有这种行才允许按姓名兜底匹配，避免同名不同学号互相串档。
     */
    function is_legacy_name_only_key(string $key, string $name): bool
    {
        $key = trim($key);
        $name = trim($name);
        return $name !== '' && ($key === '' || $key === $name);
    }
}

if (!function_exists('merge_history_for_keys')) {
    /**
     * 从单个历史档案文件中提取某学生的周次数据。
     * 多个候选 Key 按传入顺序合并，先到优先（调用方把权威/最新的数据源放前面）。
     *
     * @param array<string,mixed> $history 档案文件内容
     * @param string[] $keys 候选 Key
     * @return array<string,mixed> week => errors
     */
    function merge_history_for_keys(array $history, array $keys): array
    {
        $merged = [];
        foreach ($keys as $key) {
            if (!isset($history[$key]) || !is_array($history[$key])) {
                continue;
            }
            foreach ($history[$key] as $week => $errors) {
                $week = (string)$week;
                if (!array_key_exists($week, $merged)) {
                    $merged[$week] = $errors;
                }
            }
        }
        return $merged;
    }
}

if (!function_exists('rewrite_history_keys')) {
    /**
     * 迁移辅助：把档案文件内的旧格式 Key（学号_姓名）改写为新格式。
     * - 已含 `_年级_学科` 后缀的 Key 不改（含其它年级/学科的历史 Key，需传入 knownPairs）
     * - 纯姓名 Key 不改（无学号脏数据）
     * - 返回 [改写后的数据, 改动条数, 冲突列表]
     *
     * @param array<string,mixed> $data
     * @param array<int,array{0:string,1:string}> $knownPairs 已知的 [年级, 学科] 组合，用于识别已迁移 Key
     * @return array{0: array<string,mixed>, 1: int, 2: string[]}
     */
    function rewrite_history_keys(array $data, string $grade, string $subject, array $knownPairs = []): array
    {
        $grade = trim($grade);
        $subject = trim($subject);
        $pairs = [];
        if ($grade !== '' && $subject !== '') {
            $pairs[] = [$grade, $subject];
        }
        foreach ($knownPairs as $pair) {
            if (!is_array($pair) || count($pair) < 2) continue;
            $kg = trim((string)$pair[0]);
            $ks = trim((string)$pair[1]);
            if ($kg !== '' && $ks !== '') {
                $pairs[] = [$kg, $ks];
            }
        }
        $pairs = array_values(array_unique($pairs, SORT_REGULAR));

        $out = [];
        $changed = 0;
        $collisions = [];

        foreach ($data as $key => $value) {
            $key = (string)$key;
            if (preg_match('/^(\d+)_(.+)$/u', $key, $m)) {
                $alreadyNew = false;
                foreach ($pairs as $pair) {
                    if (str_ends_with($key, "_{$pair[0]}_{$pair[1]}")) {
                        $alreadyNew = true;
                        break;
                    }
                }
                if (!$alreadyNew) {
                    $newKey = "{$m[1]}_{$m[2]}_{$grade}_{$subject}";
                    if ($grade === '' || $subject === '') {
                        $newKey = $key;
                    }
                    if ($newKey !== $key) {
                        if (array_key_exists($newKey, $data) || array_key_exists($newKey, $out)) {
                            $collisions[] = "{$key} -> {$newKey}";
                        } else {
                            $key = $newKey;
                            $changed++;
                        }
                    }
                }
            }
            $out[$key] = $value;
        }

        return [$out, $changed, $collisions];
    }
}
