<?php
/**
 * 集中修复脚本：修复因评语中冒号后换行导致预习/巩固错题未正确识别的问题
 *
 * 用法：
 *   php fix_batch_preview_errors.php [batch_code] [--dry-run] [--apply]
 *
 * 示例：
 *   php fix_batch_preview_errors.php B20261108_135518_7bbe --dry-run
 *   php fix_batch_preview_errors.php B20261108_135518_7bbe --apply
 *   php fix_batch_preview_errors.php --all --apply
 */

declare(strict_types=1);

require_once __DIR__ . '/../api/db.php';

// 错题前缀正则
const ERROR_PREFIX_REGEX = '/^(?:本次|本周|这周|今天)?(?:的)?(?:家庭)?(?:作业|测验|测试|练习)?(?:的)?(?:错题|做错的题|做错|错误)(?:题号|序号|编号|列表)?(?:为|是)?(?:\s*[:：]\s*|\s*(?=\d|第|无|0|零|全对|全部))(.*)$/iu';

/**
 * 跨行智能提取错题题号
 */
function extractErrorNumbersFromComment(string $comment): array {
    if (trim($comment) === '') return [];

    // 全角数字转半角
    $norm = strtr($comment, [
        '０'=>'0','１'=>'1','２'=>'2','３'=>'3','４'=>'4',
        '５'=>'5','６'=>'6','７'=>'7','８'=>'8','９'=>'9'
    ]);

    $rawLines = explode("\n", $norm);
    $lines = [];
    foreach ($rawLines as $l) {
        $t = trim($l);
        if ($t !== '') {
            $lines[] = $t;
        }
    }
    if (empty($lines)) return [];

    foreach ($lines as $idx => $line) {
        if (preg_match(ERROR_PREFIX_REGEX, $line, $matches)) {
            $after = trim($matches[1] ?? '');
            // 如果冒号后换行了（after 为空），题号在下一行
            if ($after === '' && isset($lines[$idx + 1])) {
                $after = $lines[$idx + 1];
            }

            // 显式无错题声明
            if (preg_match('/^(?:无|没有|0|零|全对|全部正确|无错题|none)\s*[。!！.]?$/iu', $after)) {
                return [];
            }

            // 截取数字部分（遇到连续两个汉字或标点符号截断）
            $numsPart = preg_split('/[。!！;；\n]|(?=[\x{4e00}-\x{9fa5}]{2,})/u', $after)[0];
            if (preg_match_all('/\d+/', $numsPart, $numMatches)) {
                $nums = array_values(array_unique(array_filter(array_map('intval', $numMatches[0]))));
                // 有效题号限制在 1~100 之间
                return array_values(array_filter($nums, fn($n) => $n >= 1 && $n <= 100));
            }
        }
    }

    return [];
}

/**
 * 主执行函数
 */
function main(array $argv): void {
    $isDryRun = in_array('--dry-run', $argv, true);
    $isApply = in_array('--apply', $argv, true);
    $isAll = in_array('--all', $argv, true);

    // 默认如果既未传 --apply 也未传 --dry-run，则安全模式 dry-run
    if (!$isApply) {
        $isDryRun = true;
    }

    $targetBatch = null;
    foreach ($argv as $arg) {
        if (!str_starts_with($arg, '-') && !str_ends_with($arg, '.php')) {
            $targetBatch = trim($arg);
            break;
        }
    }
    if (!$targetBatch && !$isAll) {
        $targetBatch = 'B20261108_135518_7bbe';
    }

    echo "========================================================\n";
    echo "  错题评语冒号换行集中修复工具\n";
    echo "  运行模式: " . ($isApply ? "【正式写入执行模式 (--apply)】" : "【预演检查模式 (--dry-run)】") . "\n";
    echo "  目标批次: " . ($targetBatch ?: "全量检测") . "\n";
    echo "========================================================\n\n";

    $pdo = DB::getConnection();
    if (!$pdo) {
        echo "❌ 数据库连接失败！\n";
        exit(1);
    }

    $whereSql = $targetBatch ? "WHERE batch_code = ?" : "";
    $params = $targetBatch ? [$targetBatch] : [];

    $sql = "SELECT id, batch_code, student_id, student_name, student_key, 
                   week_num, preview_week_num, preview_score, preview_comment, preview_error_questions,
                   homework_score, teacher_comment, error_questions
            FROM student_records 
            {$whereSql} 
            ORDER BY batch_code, id ASC";

    $records = DB::fetchAll($sql, $params);
    echo "共扫描到 " . count($records) . " 条学生学情记录。\n\n";

    $previewFixList = [];
    $homeworkFixList = [];

    foreach ($records as $r) {
        // 1. 检查预习错题
        $pc = $r['preview_comment'] ?? '';
        $pe = json_decode($r['preview_error_questions'] ?? '[]', true) ?: [];
        if (empty($pe) && !empty($pc)) {
            $extracted = extractErrorNumbersFromComment($pc);
            if (!empty($extracted)) {
                $previewFixList[] = [
                    'record' => $r,
                    'extracted' => $extracted
                ];
            }
        }

        // 2. 检查课后巩固错题
        $tc = $r['teacher_comment'] ?? '';
        $te = json_decode($r['error_questions'] ?? '[]', true) ?: [];
        if (empty($te) && !empty($tc)) {
            $extractedHw = extractErrorNumbersFromComment($tc);
            if (!empty($extractedHw)) {
                $homeworkFixList[] = [
                    'record' => $r,
                    'extracted' => $extractedHw
                ];
            }
        }
    }

    echo "📊 诊断统计：\n";
    echo "  - 待修复预习错题学生数: " . count($previewFixList) . " 人\n";
    echo "  - 待修复巩固错题学生数: " . count($homeworkFixList) . " 人\n\n";

    if (empty($previewFixList) && empty($homeworkFixList)) {
        echo "✅ 未发现需要修复的记录，所有数据正常！\n";
        return;
    }

    echo "--------------------------------------------------------\n";
    echo "待修复学生明细清单 (前 40 条)：\n";
    echo "--------------------------------------------------------\n";
    $i = 0;
    foreach ($previewFixList as $item) {
        $i++;
        $r = $item['record'];
        $ext = $item['extracted'];
        $cleanC = str_replace(["\r", "\n"], ['\\r', '\\n'], $r['preview_comment']);
        echo sprintf("[%02d] 批次: %s | 学生: %s (ID: %d) | 提取预习错题: %s\n     评语: %s\n",
            $i, $r['batch_code'], $r['student_name'], $r['id'], json_encode($ext), $cleanC);
        if ($i >= 40) {
            echo "   ... 剩余 " . (count($previewFixList) - 40) . " 条省略 ...\n";
            break;
        }
    }
    echo "--------------------------------------------------------\n\n";

    if (!$isApply) {
        echo "💡 当前为【预演模式】，数据库和历史文件未作任何更改。\n";
        echo "   若确认以上提取结果无误，请执行：\n";
        echo "   php " . basename(__FILE__) . ($targetBatch ? " {$targetBatch}" : " --all") . " --apply\n\n";
        return;
    }

    // 真正执行修复
    echo "🚀 开始执行正式修复...\n";

    // 获取班级信息（用于历史档案 JSON 路径）
    $classInfoCache = [];
    $getClassInfo = function(int $classId) use (&$classInfoCache) {
        if (!isset($classInfoCache[$classId])) {
            $c = DB::fetchOne("SELECT subject, grade, tier FROM class_batches WHERE id = ?", [$classId]);
            $classInfoCache[$classId] = $c;
        }
        return $classInfoCache[$classId];
    };

    $batchInfoCache = [];
    $getBatchInfo = function(string $batchCode) use (&$batchInfoCache) {
        if (!isset($batchInfoCache[$batchCode])) {
            $b = DB::fetchOne("SELECT id, class_id, week_num FROM generation_batches WHERE batch_code = ?", [$batchCode]);
            $batchInfoCache[$batchCode] = $b;
        }
        return $batchInfoCache[$batchCode];
    };

    $historyDir = __DIR__ . '/../data/history';

    // 1. 批量更新数据库 student_records
    $pdo->beginTransaction();
    try {
        $updatePreviewStmt = $pdo->prepare("UPDATE student_records SET preview_error_questions = ? WHERE id = ?");
        foreach ($previewFixList as $item) {
            $json = json_encode($item['extracted']);
            $updatePreviewStmt->execute([$json, $item['record']['id']]);
        }

        $updateHwStmt = $pdo->prepare("UPDATE student_records SET error_questions = ?, error_count = ? WHERE id = ?");
        foreach ($homeworkFixList as $item) {
            $json = json_encode($item['extracted']);
            $cnt = count($item['extracted']);
            $updateHwStmt->execute([$json, $cnt, $item['record']['id']]);
        }

        $pdo->commit();
        echo "✅ 数据库记录批量更新成功！共更新 " . (count($previewFixList) + count($homeworkFixList)) . " 行数据。\n";
    } catch (Throwable $e) {
        $pdo->rollBack();
        echo "❌ 数据库更新失败，事务已回滚：" . $e->getMessage() . "\n";
        exit(1);
    }

    // 2. 更新历史档案 JSON 文件 (按学科_年级_preview.json)
    $previewUpdatesByFile = [];
    foreach ($previewFixList as $item) {
        $r = $item['record'];
        $b = $getBatchInfo($r['batch_code']);
        if (!$b) continue;
        $c = $getClassInfo((int)$b['class_id']);
        if (!$c) continue;

        $subject = $c['subject'];
        $grade = $c['grade'];
        $targetFile = $historyDir . '/' . rawurlencode($subject) . '_' . rawurlencode($grade) . '_preview.json';

        $stKey = $r['student_key'] ?: ($r['student_name'] . '_' . $grade . '_' . $subject);
        $hwWeek = (string)($r['week_num'] ?: $b['week_num']);
        $pWeek = (int)($r['preview_week_num'] ?: ($b['week_num'] + 1));

        $previewUpdatesByFile[$targetFile][$stKey][$hwWeek] = [
            'errors' => $item['extracted'],
            'previewWeek' => $pWeek
        ];
    }

    foreach ($previewUpdatesByFile as $filePath => $studentsData) {
        $existing = [];
        if (is_file($filePath)) {
            // 先备份
            @copy($filePath, $filePath . '.bak.' . date('Ymd_His'));
            $content = (string)@file_get_contents($filePath);
            $existing = json_decode($content, true) ?: [];
        }

        foreach ($studentsData as $stKey => $weeks) {
            if (!isset($existing[$stKey])) {
                $existing[$stKey] = [];
            }
            foreach ($weeks as $w => $entry) {
                $existing[$stKey][$w] = $entry;
            }
        }

        $fp = @fopen($filePath, 'c+');
        if ($fp && flock($fp, LOCK_EX)) {
            ftruncate($fp, 0);
            rewind($fp);
            fwrite($fp, json_encode($existing, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
            fflush($fp);
            flock($fp, LOCK_UN);
            fclose($fp);
            echo "✅ 预习历史档案已更新: " . basename($filePath) . " (已自动生成 .bak 备份)\n";
        } else {
            echo "⚠️ 无法锁定写入预习历史档案: " . basename($filePath) . "\n";
        }
    }

    echo "\n🎉 修复完成！\n";
    echo "  - 已成功修复 {$targetBatch} 批次中的 " . count($previewFixList) . " 位学生的预习错题。\n";
    echo "  - 学生错题本、知识点与微课已即时恢复，无需助教重传或重新制卡！\n";
}

main($argv);
