<?php
/**
 * Admin Tables 动作处理: db_tables, db_schema, db_batches_options, dimensions, db_filter_options, student_records_stats
 */

switch ($action) {
        case 'db_tables':
            requireAdmin();
            $statusRows = DB::fetchAll("SHOW TABLE STATUS");
            $friendlyNames = [
                'users'             => '前台教师账号',
                'student_records'   => '学生学情错题',
                'student_record_history' => '学情历史版本',
                'generation_batches'=> '学情生成批次',
                'class_batches'     => '班级教学期次',
                'retest_access_logs'=> '重测查阅日志',
                'retest_revoked_tokens' => '错题本吊销黑名单',
                'qbank_weeks'       => '题库专题期次',
                'qbank_questions'   => '题库题目与考点',
                'admin_users'       => '系统管理员表',
                'system_logs'       => '系统运行日志'
            ];
            $tables = [];
            foreach ($statusRows as $r) {
                $tblName = $r['Name'] ?? ($r['name'] ?? '');
                if (empty($tblName) || isAdminHiddenTable($tblName)) continue;
                // 实时查询精确 COUNT(*)（前台教师账号排除助教）
                $exactCount = $tblName === 'users' 
                    ? (int)DB::fetchValue("SELECT COUNT(*) FROM `users` WHERE (`role` != 'assistant' OR `role` IS NULL)") 
                    : (int)DB::fetchValue("SELECT COUNT(*) FROM `{$tblName}`");
                $friendly = $friendlyNames[$tblName] ?? (!empty($r['Comment']) ? $r['Comment'] : $tblName);
                $tables[] = [
                    'name'           => $tblName,
                    'friendly_name'  => $friendly,
                    'count'          => $exactCount,
                    'rows'           => $exactCount,
                    'comment'        => !empty($r['Comment']) ? $r['Comment'] : $friendly,
                    'avg_row_length' => (int)($r['Avg_row_length'] ?? 0),
                    'data_length'    => (int)($r['Data_length'] ?? 0),
                    'auto_increment' => !empty($r['Auto_increment']) ? (int)$r['Auto_increment'] : null,
                    'update_time'    => $r['Update_time'] ?? $r['Create_time'] ?? null
                ];
            }
            sendResponse(true, ['tables' => $tables]);
            break;

        case 'db_schema':
            requireAdmin();
            $table = validateTable($_GET['table'] ?? '');
            $cols = array_values(getTableColumns($table));
            $pk = getTablePrimaryKey($table);
            sendResponse(true, [
                'table'       => $table,
                'primary_key' => $pk,
                'columns'     => $cols
            ]);
            break;

        case 'db_batches_options':
            requireAdmin();
            $batches = DB::fetchAll("SELECT id, `year`, `season`, `grade`, `tier`, `subject`, `class_name` FROM `class_batches` ORDER BY id DESC");
            $opts = [];
            foreach ($batches as $b) {
                $label = !empty($b['class_name']) ? $b['class_name'] : sprintf("%s%s %s%s %s", $b['year'], $b['season'], $b['grade'], $b['tier'], $b['subject']);
                $opts[] = [
                    'id'    => (int)$b['id'],
                    'label' => sprintf("#%d %s", $b['id'], $label),
                    'raw'   => $b
                ];
            }
            sendResponse(true, $opts);
            break;

        case 'dimensions':
        case 'db_filter_options':
            requireAdmin();
            $grades = DB::fetchAll("SELECT DISTINCT `grade` FROM `class_batches` WHERE `grade` IS NOT NULL AND `grade` != '' ORDER BY `grade`");
            $tiers = DB::fetchAll("SELECT DISTINCT `tier` FROM `class_batches` WHERE `tier` IS NOT NULL AND `tier` != '' ORDER BY `tier`");
            $subjects = DB::fetchAll("SELECT DISTINCT `subject` FROM `class_batches` WHERE `subject` IS NOT NULL AND `subject` != '' ORDER BY `subject`");
            $logLevels = DB::fetchAll("SELECT DISTINCT `level` FROM `system_logs` WHERE `level` IS NOT NULL AND `level` != '' ORDER BY `level`");
            $logModules = DB::fetchAll("SELECT DISTINCT `module` FROM `system_logs` WHERE `module` IS NOT NULL AND `module` != '' ORDER BY `module`");

            $teachers = [];
            $activeTeachers = [];
            try {
                $teachers = DB::fetchAll("SELECT `username`, `real_name` FROM `users` WHERE `status` = 1 AND (`role` != 'assistant' OR `role` IS NULL) ORDER BY (username != '0'), username ASC");
                $activeTeachersRaw = DB::fetchAll("SELECT DISTINCT `created_by` FROM `student_records` WHERE `created_by` IS NOT NULL AND `created_by` != ''");
                $activeTeachers = array_values(array_filter(array_column($activeTeachersRaw, 'created_by')));
            } catch (Throwable $ignore) {}

            sendResponse(true, [
                'grades'          => array_values(array_filter(array_column($grades, 'grade'))),
                'tiers'           => array_values(array_filter(array_column($tiers, 'tier'))),
                'subjects'        => array_values(array_filter(array_column($subjects, 'subject'))),
                'log_levels'      => array_values(array_filter(array_column($logLevels, 'level'))),
                'log_modules'     => array_values(array_filter(array_column($logModules, 'module'))),
                'teachers'        => $teachers,
                'active_teachers' => $activeTeachers
            ]);
            break;

        case 'student_records_stats':
            requireAdmin();
            $total = (int)DB::fetchValue("SELECT COUNT(*) FROM `student_records`");
            $hasErr = (int)DB::fetchValue("SELECT COUNT(*) FROM `student_records` WHERE `error_count` > 0");
            $noErr = (int)DB::fetchValue("SELECT COUNT(*) FROM `student_records` WHERE `error_count` = 0");
            $batches = (int)DB::fetchValue("SELECT COUNT(DISTINCT `batch_id`) FROM `student_records` WHERE `batch_id` IS NOT NULL AND `batch_id` > 0");
            $students = (int)DB::fetchValue("SELECT COUNT(DISTINCT `student_name`) FROM `student_records` WHERE `student_name` IS NOT NULL AND `student_name` != ''");
            sendResponse(true, [
                'total'    => $total,
                'has_err'  => $hasErr,
                'no_err'   => $noErr,
                'batches'  => $batches,
                'students' => $students
            ]);
            break;

}
