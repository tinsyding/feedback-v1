<?php
declare(strict_types=1);

/**
 * 错题本身份 Key 纯函数测试（无需数据库）
 * 运行：php scripts/test_retest_keys.php
 */

require_once __DIR__ . '/../api/lib_retest_keys.php';

$failures = 0;
$checks = 0;

function check(string $label, $actual, $expected): void
{
    global $failures, $checks;
    $checks++;
    if ($actual !== $expected) {
        $failures++;
        fwrite(STDERR, "[FAIL] {$label}\n  期望: " . var_export($expected, true) . "\n  实际: " . var_export($actual, true) . "\n");
    }
}

// 1. 标准 Key 构建
check('新格式-有学号', build_student_key('65369', '王可昕', '八年级', '数学'), '65369_王可昕_八年级_数学');
check('新格式-无学号退化姓名', build_student_key('', '王可昕', '八年级', '数学'), '王可昕');
check('新格式-缺年级学科退化旧格式', build_student_key('65369', '王可昕', '', ''), '65369_王可昕');
check('旧格式构建', legacy_student_key('65369', '王可昕'), '65369_王可昕');
check('旧格式构建-无学号', legacy_student_key('', '王可昕'), '王可昕');

// 2. 查询候选 Key
check(
    '候选Key-有学号含新旧两版',
    student_key_candidates('65369', '王可昕', '八年级', '数学'),
    ['65369_王可昕_八年级_数学', '65369_王可昕']
);
check(
    '候选Key-无学号只有姓名',
    student_key_candidates('', '王可昕', '八年级', '数学'),
    ['王可昕']
);
check(
    '候选Key-缺年级学科时去重',
    student_key_candidates('65369', '王可昕', '', ''),
    ['65369_王可昕']
);

// 3. 姓名兜底只允许无学号旧数据
check('纯姓名空Key', is_legacy_name_only_key('', '张三'), true);
check('纯姓名Key', is_legacy_name_only_key('张三', '张三'), true);
check('正常学号Key不允许姓名兜底', is_legacy_name_only_key('65369_王可昕', '王可昕'), false);
check('新格式Key不允许姓名兜底', is_legacy_name_only_key('65369_王可昕_八年级_数学', '王可昕'), false);

// 4. 多来源历史合并（先到优先）
$history = [
    '65369_王可昕_八年级_数学' => ['1' => [1, 2], '3' => [5]],
    '65369_王可昕' => ['1' => [9], '2' => [3]],
    '王可昕' => ['4' => [7]],
];
check(
    '历史合并-新格式优先',
    merge_history_for_keys($history, ['65369_王可昕_八年级_数学', '65369_王可昕', '王可昕']),
    ['1' => [1, 2], '3' => [5], '2' => [3], '4' => [7]]
);

// 5. 档案 Key 迁移
$data = [
    '65369_王可昕' => ['1' => [1]],
    '65225_王可昕' => ['2' => [2]],
    '张三' => ['3' => [3]],
    '99999_李四_八年级_数学' => ['4' => [4]],
];
[$rewritten, $changed, $collisions] = rewrite_history_keys($data, '八年级', '数学');
check('迁移改写数量', $changed, 2);
check('迁移无冲突', $collisions, []);
check('迁移后旧Key消失', isset($rewritten['65369_王可昕']), false);
check('迁移后新Key存在', $rewritten['65369_王可昕_八年级_数学']['1'], [1]);
check('迁移保留纯姓名Key', $rewritten['张三']['3'], [3]);
check('迁移保留已是新格式的Key', $rewritten['99999_李四_八年级_数学']['4'], [4]);
check('迁移不重复追加年级学科', array_key_exists('99999_李四_八年级_数学_八年级_数学', $rewritten), false);

// 6. 目标 Key 已存在时报告冲突、不覆盖
$conflictData = [
    '65369_王可昕' => ['1' => [1]],
    '65369_王可昕_八年级_数学' => ['2' => [2]],
];
[$conflictOut, $conflictChanged, $conflictCollisions] = rewrite_history_keys($conflictData, '八年级', '数学');
check('冲突时不覆盖', $conflictOut['65369_王可昕_八年级_数学']['2'], [2]);
check('冲突时旧Key保留', $conflictOut['65369_王可昕']['1'], [1]);
check('冲突计数', count($conflictCollisions), 1);
check('冲突时不计数为改动', $conflictChanged, 0);

// 7. 其它年级/学科的新格式 Key 不误改（已知组合由调用方传入）
$otherData = ['65369_王可昕_九年级_物理' => ['1' => [8]]];
[$otherOut, $otherChanged] = rewrite_history_keys($otherData, '八年级', '数学', [['九年级', '物理']]);
check('其它年级学科Key原样保留', $otherOut, $otherData);
check('其它年级学科Key无改动', $otherChanged, 0);

if ($failures > 0) {
    fwrite(STDERR, "\n{$failures}/{$checks} 项失败\n");
    exit(1);
}

echo "OK: {$checks} 项检查全部通过\n";
