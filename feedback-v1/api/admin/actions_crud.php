<?php
/**
 * Admin CRUD 动作处理: db_list, db_get, db_create, db_update, db_delete, db_reset_teacher_password
 */

require_once __DIR__ . '/../lib_retest_keys.php';
require_once __DIR__ . '/../lib_retest_cleanup.php';

switch ($action) {
        case 'db_list':
            requireAdmin();
            $table = validateTable($_GET['table'] ?? 'student_records');
            $cols = getTableColumns($table);
            $pk = getTablePrimaryKey($table);

            $page = max(1, (int)($_GET['page'] ?? 1));
            $pageSize = min(100, max(1, (int)($_GET['page_size'] ?? ($_GET['per_page'] ?? ($_GET['perPage'] ?? 20)))));
            $offset = ($page - 1) * $pageSize;

            $search = trim($_GET['search'] ?? '');
            $rawSort = trim($_GET['sort'] ?? ($_GET['sort_field'] ?? $pk));
            $order = strtolower(trim($_GET['order'] ?? ($_GET['sort_order'] ?? 'desc'))) === 'asc' ? 'ASC' : 'DESC';

            $isCustomSort = ($table === 'users' && $rawSort === 'assistant_count');
            $sort = (isset($cols[$rawSort]) || $isCustomSort) ? $rawSort : $pk;

            $whereParts = [];
            $params = [];

            $grade = trim($_GET['grade'] ?? '');
            $tier = trim($_GET['tier'] ?? '');
            $subject = trim($_GET['subject'] ?? '');

            if ($table === 'student_records') {
                if (!empty($_GET['batch_id']) && isset($cols['batch_id'])) {
                    $whereParts[] = "`batch_id` = ?";
                    $params[] = (int)$_GET['batch_id'];
                }
                if (!empty($_GET['batch_code']) && isset($cols['batch_code'])) {
                    $whereParts[] = "`batch_code` = ?";
                    $params[] = trim($_GET['batch_code']);
                }
                if (!empty($_GET['week_num']) && isset($cols['week_num'])) {
                    $whereParts[] = "`week_num` = ?";
                    $params[] = (int)$_GET['week_num'];
                }
                if (isset($_GET['has_errors']) && isset($cols['error_count'])) {
                    if ($_GET['has_errors'] === '1' || $_GET['has_errors'] === 'has_err') {
                        $whereParts[] = "`error_count` > 0";
                    } elseif ($_GET['has_errors'] === '0' || $_GET['has_errors'] === 'no_err') {
                        $whereParts[] = "`error_count` = 0";
                    }
                }
                if (isset($_GET['created_by']) && $_GET['created_by'] !== '' && isset($cols['created_by'])) {
                    $tFilter = trim($_GET['created_by']);
                    if ($tFilter === '__empty__') {
                        $whereParts[] = "(`created_by` = '' OR `created_by` IS NULL)";
                    } else {
                        $whereParts[] = "`created_by` = ?";
                        $params[] = $tFilter;
                    }
                }
                if ($grade !== '' || $tier !== '' || $subject !== '') {
                    $batchSubWhere = [];
                    $batchSubParams = [];
                    if ($grade !== '') {
                        $batchSubWhere[] = "`grade` = ?";
                        $batchSubParams[] = $grade;
                    }
                    if ($tier !== '') {
                        $batchSubWhere[] = "`tier` = ?";
                        $batchSubParams[] = $tier;
                    }
                    if ($subject !== '') {
                        $batchSubWhere[] = "`subject` = ?";
                        $batchSubParams[] = $subject;
                    }
                    $whereParts[] = "`batch_id` IN (SELECT `id` FROM `class_batches` WHERE " . implode(' AND ', $batchSubWhere) . ")";
                    foreach ($batchSubParams as $bParam) {
                        $params[] = $bParam;
                    }
                }
            } elseif ($table === 'generation_batches') {
                if (!empty($_GET['batch_code']) && isset($cols['batch_code'])) {
                    $whereParts[] = "`batch_code` = ?";
                    $params[] = trim($_GET['batch_code']);
                }
                if (!empty($_GET['class_id']) && isset($cols['class_id'])) {
                    $whereParts[] = "`class_id` = ?";
                    $params[] = (int)$_GET['class_id'];
                }
                if (!empty($_GET['week_num']) && isset($cols['week_num'])) {
                    $whereParts[] = "`week_num` = ?";
                    $params[] = (int)$_GET['week_num'];
                }
                if (isset($_GET['created_by']) && $_GET['created_by'] !== '' && isset($cols['created_by'])) {
                    $tFilter = trim($_GET['created_by']);
                    if ($tFilter === '__empty__') {
                        $whereParts[] = "(`created_by` = '' OR `created_by` IS NULL)";
                    } else {
                        $whereParts[] = "`created_by` = ?";
                        $params[] = $tFilter;
                    }
                }
                if ($grade !== '' || $tier !== '' || $subject !== '') {
                    $batchSubWhere = [];
                    $batchSubParams = [];
                    if ($grade !== '') {
                        $batchSubWhere[] = "`grade` = ?";
                        $batchSubParams[] = $grade;
                    }
                    if ($tier !== '') {
                        $batchSubWhere[] = "`tier` = ?";
                        $batchSubParams[] = $tier;
                    }
                    if ($subject !== '') {
                        $batchSubWhere[] = "`subject` = ?";
                        $batchSubParams[] = $subject;
                    }
                    $whereParts[] = "`class_id` IN (SELECT `id` FROM `class_batches` WHERE " . implode(' AND ', $batchSubWhere) . ")";
                    foreach ($batchSubParams as $bParam) {
                        $params[] = $bParam;
                    }
                }
            } elseif ($table === 'class_batches') {
                if ($grade !== '' && isset($cols['grade'])) {
                    $whereParts[] = "`grade` = ?";
                    $params[] = $grade;
                }
                if ($tier !== '' && isset($cols['tier'])) {
                    $whereParts[] = "`tier` = ?";
                    $params[] = $tier;
                }
                if ($subject !== '' && isset($cols['subject'])) {
                    $whereParts[] = "`subject` = ?";
                    $params[] = $subject;
                }
                if (!empty($_GET['year']) && isset($cols['year'])) {
                    $whereParts[] = "`year` = ?";
                    $params[] = (int)$_GET['year'];
                }
                if (!empty($_GET['season']) && isset($cols['season'])) {
                    $whereParts[] = "`season` = ?";
                    $params[] = trim($_GET['season']);
                }
            } elseif ($table === 'qbank_weeks' || $table === 'qbank_questions') {
                if ($grade !== '' && isset($cols['grade'])) {
                    $whereParts[] = "`grade` = ?";
                    $params[] = $grade;
                }
                if ($tier !== '' && isset($cols['tier'])) {
                    $whereParts[] = "`tier` = ?";
                    $params[] = $tier;
                }
                if ($subject !== '' && isset($cols['subject'])) {
                    $whereParts[] = "`subject` = ?";
                    $params[] = $subject;
                }
                if (!empty($_GET['year']) && isset($cols['year'])) {
                    $whereParts[] = "`year` = ?";
                    $params[] = (int)$_GET['year'];
                }
                if (!empty($_GET['season']) && isset($cols['season'])) {
                    $whereParts[] = "`season` = ?";
                    $params[] = trim($_GET['season']);
                }
                if (!empty($_GET['week']) && isset($cols['week'])) {
                    $whereParts[] = "`week` = ?";
                    $params[] = (int)$_GET['week'];
                }
            } elseif ($table === 'system_logs') {
                if (!empty($_GET['level']) && isset($cols['level'])) {
                    $whereParts[] = "`level` = ?";
                    $params[] = trim($_GET['level']);
                }
                if (!empty($_GET['module']) && isset($cols['module'])) {
                    $whereParts[] = "`module` = ?";
                    $params[] = trim($_GET['module']);
                }
            } elseif ($table === 'retest_access_logs') {
                if (!empty($_GET['log_action']) && isset($cols['action'])) {
                    $whereParts[] = "`action` = ?";
                    $params[] = trim($_GET['log_action']);
                }
            } elseif ($table === 'admin_users') {
                if (isset($_GET['status']) && $_GET['status'] !== '') {
                    $whereParts[] = "`status` = ?";
                    $params[] = (int)$_GET['status'];
                }
                if (!empty($_GET['role']) && isset($cols['role'])) {
                    $whereParts[] = "`role` = ?";
                    $params[] = trim($_GET['role']);
                }
            } elseif ($table === 'users') {
                $whereParts[] = "(`role` != 'assistant' OR `role` IS NULL)";
                if (isset($_GET['status']) && $_GET['status'] !== '') {
                    $whereParts[] = "`status` = ?";
                    $params[] = (int)$_GET['status'];
                }
            }

            if ($search !== '') {
                $searchConds = [];
                foreach ($cols as $colName => $colInfo) {
                    // 跳过大图 base64 字段，避免卡顿
                    if ($colName === 'exercise_thumb' || $colName === 'answer_thumb' || $colName === 'password_hash') {
                        continue;
                    }
                    $type = strtolower($colInfo['type']);
                    if (strpos($type, 'char') !== false || strpos($type, 'text') !== false || strpos($type, 'json') !== false) {
                        $searchConds[] = "`{$colName}` LIKE ?";
                        $params[] = "%{$search}%";
                    } elseif (is_numeric($search) && (strpos($type, 'int') !== false || strpos($type, 'decimal') !== false)) {
                        $searchConds[] = "`{$colName}` = ?";
                        $params[] = $search;
                    }
                }
                if (!empty($searchConds)) {
                    $whereParts[] = '(' . implode(' OR ', $searchConds) . ')';
                }
            }

            $whereSql = !empty($whereParts) ? 'WHERE ' . implode(' AND ', $whereParts) : '';

            $total = (int)DB::fetchValue("SELECT COUNT(*) FROM `{$table}` {$whereSql}", $params);

            // 对 qbank_questions 排除巨型 base64 缩略图以提升翻页性能；对 admin_users 脱敏密码哈希
            if ($table === 'qbank_questions') {
                $selectFields = "id, qbank_id, bank_type, `year`, `season`, subject, grade, tier, `week`, question_num, topic, video_url, exercise_pdf, exercise_name, (exercise_thumb IS NOT NULL AND exercise_thumb != '') AS has_exercise_thumb, answer_pdf, answer_name, (answer_thumb IS NOT NULL AND answer_thumb != '') AS has_answer_thumb, created_by, updated_by, created_at, updated_at";
                $rows = DB::fetchAll("SELECT {$selectFields} FROM `{$table}` {$whereSql} ORDER BY `{$sort}` {$order} LIMIT {$offset}, {$pageSize}", $params);
            } elseif ($table === 'admin_users') {
                $rows = DB::fetchAll("SELECT `id`, `username`, '●●●●●●●●' AS `password_hash`, `real_name`, `role`, `status`, `last_login_at`, `last_login_ip`, `created_at`, `updated_at` FROM `{$table}` {$whereSql} ORDER BY `{$sort}` {$order} LIMIT {$offset}, {$pageSize}", $params);
            } elseif ($table === 'users') {
                if ($sort === 'assistant_count') {
                    $orderClause = "(SELECT COUNT(*) FROM `users` `u_ast` WHERE `u_ast`.`role` = 'assistant' AND (`u_ast`.`teacher_id` = `users`.`id` OR `u_ast`.`created_by` = `users`.`username`)) {$order}, `users`.`id` ASC";
                } else {
                    $orderClause = "`{$sort}` {$order}";
                }
                $rows = DB::fetchAll("SELECT `id`, `username`, '' AS `initial_password`, `real_name`, `role`, `status`, `last_login_at`, `last_login_ip`, `created_at`, `updated_at` FROM `{$table}` {$whereSql} ORDER BY {$orderClause} LIMIT {$offset}, {$pageSize}", $params);
            } else {
                $rows = DB::fetchAll("SELECT * FROM `{$table}` {$whereSql} ORDER BY `{$sort}` {$order} LIMIT {$offset}, {$pageSize}", $params);
            }

            // 附带班级关联信息（student_records, generation_batches）
            if (($table === 'student_records' || $table === 'generation_batches') && !empty($rows)) {
                $batchIdKey = $table === 'student_records' ? 'batch_id' : 'class_id';
                $batchIds = array_unique(array_filter(array_column($rows, $batchIdKey)));
                if (!empty($batchIds)) {
                    $inPlaceholders = implode(',', array_fill(0, count($batchIds), '?'));
                    $batchRows = DB::fetchAll("SELECT id, `year`, `season`, `grade`, `tier`, `subject`, `class_name` FROM `class_batches` WHERE id IN ({$inPlaceholders})", array_values($batchIds));
                    $batchMap = [];
                    foreach ($batchRows as $br) {
                        $batchMap[$br['id']] = $br;
                    }
                    foreach ($rows as &$r) {
                        $cid = $r[$batchIdKey] ?? null;
                        $batchInfo = $cid ? ($batchMap[$cid] ?? null) : null;
                        $r['_batch'] = $batchInfo;
                        $r['class_name'] = $batchInfo['class_name'] ?? null;
                        $r['grade'] = $batchInfo['grade'] ?? null;
                        $r['tier'] = $batchInfo['tier'] ?? null;
                        $r['subject'] = $batchInfo['subject'] ?? null;
                    }
                    unset($r);
                }
            }

            // 附带教师真实姓名（student_records, class_batches, qbank_weeks, qbank_questions, system_logs, generation_batches, student_record_history）
            // 若创建人为助教，额外附带其所属教师账号（owner），前端用于“助教（所属：教师）”展示
            if (in_array($table, ['student_records', 'class_batches', 'qbank_weeks', 'qbank_questions', 'system_logs', 'generation_batches', 'student_record_history']) && !empty($rows)) {
                try {
                    $allTeachers = DB::fetchAll("SELECT `id`, `username`, `real_name`, `role`, `teacher_id`, `created_by` FROM `users`");
                    $teacherMap = [];
                    $userByUsername = [];
                    $userById = [];
                    foreach ($allTeachers as $t) {
                        $teacherMap[$t['username']] = $t['real_name'];
                        $userByUsername[$t['username']] = $t;
                        $userById[(int)$t['id']] = $t;
                    }
                    foreach ($rows as &$r) {
                        if (isset($r['created_by'])) {
                            $r['creator_name'] = $teacherMap[$r['created_by']] ?? $r['created_by'];
                            $creator = $userByUsername[$r['created_by']] ?? null;
                            $r['creator_role'] = $creator['role'] ?? null;
                            $r['creator_owner_username'] = null;
                            $r['creator_owner_name'] = null;
                            if ($creator && ($creator['role'] ?? '') === 'assistant') {
                                $owner = null;
                                $tid = (int)($creator['teacher_id'] ?? 0);
                                if ($tid > 0 && isset($userById[$tid])) {
                                    $owner = $userById[$tid];
                                } elseif (!empty($creator['created_by']) && isset($userByUsername[$creator['created_by']])) {
                                    $owner = $userByUsername[$creator['created_by']];
                                }
                                if ($owner) {
                                    $r['creator_owner_username'] = $owner['username'];
                                    $r['creator_owner_name'] = $owner['real_name'] !== '' ? $owner['real_name'] : $owner['username'];
                                } elseif (!empty($creator['created_by'])) {
                                    // 所属教师账号已被删除时，仍保留原始账号名字符串，避免前端空白
                                    $r['creator_owner_username'] = $creator['created_by'];
                                    $r['creator_owner_name'] = $teacherMap[$creator['created_by']] ?? $creator['created_by'];
                                }
                            }
                        }
                        if (isset($r['updated_by'])) {
                            $r['updater_name'] = $teacherMap[$r['updated_by']] ?? $r['updated_by'];
                        }
                        if (isset($r['operator'])) {
                            $r['operator_name'] = $teacherMap[$r['operator']] ?? $r['operator'];
                        }
                    }
                    unset($r);
                } catch (Throwable $ignore) {}
            }

            // 附带学情记录的个人薄弱点详细考点与来源文件解析 (student_records, student_record_history)
            if (($table === 'student_records' || $table === 'student_record_history') && !empty($rows)) {
                $qbankQueries = [];
                $previewQbankQueries = [];
                foreach ($rows as $r) {
                    $errs = [];
                    if (!empty($r['error_questions'])) {
                        $errs = is_array($r['error_questions']) ? $r['error_questions'] : json_decode($r['error_questions'], true);
                    }
                    $sSub = $r['subject'] ?? ($r['_batch']['subject'] ?? '');
                    $sGrd = $r['grade'] ?? ($r['_batch']['grade'] ?? '');
                    $sTier = $r['tier'] ?? ($r['_batch']['tier'] ?? '');
                    $sWk = (int)($r['week_num'] ?? 0);
                    if (!empty($errs) && !empty($sSub) && !empty($sGrd)) {
                        $key = $sSub . '___' . $sGrd . '___' . $sTier . '___' . $sWk;
                        $qbankQueries[$key] = [
                            'subject' => $sSub,
                            'grade'   => $sGrd,
                            'tier'    => $sTier,
                            'week'    => $sWk
                        ];
                    }

                    $pErrs = [];
                    if (!empty($r['preview_error_questions'])) {
                        $pErrs = is_array($r['preview_error_questions']) ? $r['preview_error_questions'] : json_decode($r['preview_error_questions'], true);
                    }
                    $pWk = (int)($r['preview_week_num'] ?? $sWk);
                    if (!empty($pErrs) && !empty($sSub) && !empty($sGrd) && $pWk > 0) {
                        $pKey = $sSub . '___' . $sGrd . '___' . $sTier . '___' . $pWk;
                        $previewQbankQueries[$pKey] = [
                            'subject' => $sSub,
                            'grade'   => $sGrd,
                            'tier'    => $sTier,
                            'week'    => $pWk
                        ];
                    }
                }
                $topicMap = [];
                $previewTopicMap = [];
                $gradeAliasMap = [
                    '初一' => ['七年级', '初一年级', '七年级先学'],
                    '初二' => ['八年级', '初二年级'],
                    '初三' => ['九年级', '初三年级'],
                    '七年级' => ['初一', '初一年级', '七年级先学'],
                    '八年级' => ['初二', '初二年级'],
                    '九年级' => ['初三', '初三年级'],
                    '高一' => ['高一年级'],
                    '高二' => ['高二年级'],
                    '高三' => ['高三年级'],
                ];

                foreach ($qbankQueries as $qItem) {
                    $cleanGrade = preg_replace('/(化学|物理|数学|英语|语文)$/u', '', $qItem['grade']);
                    $cleanGrade = preg_replace('/(班|层)$/u', '', $cleanGrade);

                    $gradeCandidates = [
                        $qItem['grade'],
                        $cleanGrade,
                        $cleanGrade . '年级',
                        preg_replace('/年级$/u', '', $cleanGrade)
                    ];
                    foreach ($gradeCandidates as $gc) {
                        if (isset($gradeAliasMap[$gc])) {
                            $gradeCandidates = array_merge($gradeCandidates, $gradeAliasMap[$gc]);
                        }
                    }
                    $gradeCandidates = array_values(array_unique(array_filter($gradeCandidates)));

                    $tierVal = trim($qItem['tier']);
                    $tierCandidates = array_values(array_unique(array_filter([$tierVal, str_replace('班', '', $tierVal)])));

                    $inGrades = implode(',', array_fill(0, count($gradeCandidates), '?'));
                    $inTiers = implode(',', array_fill(0, count($tierCandidates), '?'));
                    $params = array_merge([$qItem['subject']], $gradeCandidates, $tierCandidates, [$qItem['week']]);

                    $tRows = DB::fetchAll(
                        "SELECT `question_num`, `topic` FROM `qbank_questions` 
                         WHERE `bank_type` = 'homework' AND `subject` = ? AND `grade` IN ($inGrades) AND `tier` IN ($inTiers) AND `week` = ?",
                        $params
                    );
                    $subKey = $qItem['subject'] . '___' . $qItem['grade'] . '___' . $qItem['tier'] . '___' . $qItem['week'];
                    foreach ($tRows as $tr) {
                        $topicMap[$subKey . '___' . (int)$tr['question_num']] = trim($tr['topic']);
                    }
                }

                foreach ($previewQbankQueries as $qItem) {
                    $cleanGrade = preg_replace('/(化学|物理|数学|英语|语文)$/u', '', $qItem['grade']);
                    $cleanGrade = preg_replace('/(班|层)$/u', '', $cleanGrade);

                    $gradeCandidates = [
                        $qItem['grade'],
                        $cleanGrade,
                        $cleanGrade . '年级',
                        preg_replace('/年级$/u', '', $cleanGrade)
                    ];
                    foreach ($gradeCandidates as $gc) {
                        if (isset($gradeAliasMap[$gc])) {
                            $gradeCandidates = array_merge($gradeCandidates, $gradeAliasMap[$gc]);
                        }
                    }
                    $gradeCandidates = array_values(array_unique(array_filter($gradeCandidates)));

                    $tierVal = trim($qItem['tier']);
                    $tierCandidates = array_values(array_unique(array_filter([$tierVal, str_replace('班', '', $tierVal)])));

                    $inGrades = implode(',', array_fill(0, count($gradeCandidates), '?'));
                    $inTiers = implode(',', array_fill(0, count($tierCandidates), '?'));
                    $params = array_merge([$qItem['subject']], $gradeCandidates, $tierCandidates, [$qItem['week']]);

                    $tRows = DB::fetchAll(
                        "SELECT `question_num`, `topic` FROM `qbank_questions` 
                         WHERE `bank_type` = 'preview' AND `subject` = ? AND `grade` IN ($inGrades) AND `tier` IN ($inTiers) AND `week` = ?",
                        $params
                    );
                    $subKey = $qItem['subject'] . '___' . $qItem['grade'] . '___' . $qItem['tier'] . '___' . $qItem['week'];
                    foreach ($tRows as $tr) {
                        $previewTopicMap[$subKey . '___' . (int)$tr['question_num']] = trim($tr['topic']);
                    }
                }

                foreach ($rows as &$r) {
                    // 解析来源文件名
                    $srcFiles = [];
                    if (!empty($r['source_files'])) {
                        if (is_array($r['source_files'])) {
                            $srcFiles = $r['source_files'];
                        } else {
                            $decoded = json_decode($r['source_files'], true);
                            $srcFiles = is_array($decoded) ? $decoded : array_filter(array_map('trim', explode("\n", $r['source_files'])));
                        }
                    }
                    $r['source_files_list'] = array_values(array_unique(array_filter($srcFiles)));

                    // 解析课后巩固薄弱点考点
                    $errs = [];
                    if (!empty($r['error_questions'])) {
                        $errs = is_array($r['error_questions']) ? $r['error_questions'] : json_decode($r['error_questions'], true);
                    }
                    $details = [];
                    $weakList = [];
                    $sSub = $r['subject'] ?? ($r['_batch']['subject'] ?? '');
                    $sGrd = $r['grade'] ?? ($r['_batch']['grade'] ?? '');
                    $sTier = $r['tier'] ?? ($r['_batch']['tier'] ?? '');
                    $sWk = (int)($r['week_num'] ?? 0);
                    if (!empty($errs) && !empty($sSub) && !empty($sGrd)) {
                        $subKey = $sSub . '___' . $sGrd . '___' . $sTier . '___' . $sWk;
                        foreach ($errs as $num) {
                            $qNum = (int)$num;
                            $tName = $topicMap[$subKey . '___' . $qNum] ?? '';
                            $cleanT = preg_replace('/[\s,，.。;；:：、\-_—]+$/u', '', $tName);
                            $details[] = [
                                'num'   => $qNum,
                                'topic' => $cleanT ?: '未标注考点'
                            ];
                            if ($cleanT) {
                                $weakList[] = $cleanT;
                            }
                        }
                    }
                    $r['error_details'] = $details;
                    $r['weak_points'] = array_values(array_unique($weakList));
                    $r['weak_points_text'] = implode('、', array_unique($weakList));

                    // 解析课前预习薄弱点考点
                    $pErrs = [];
                    if (!empty($r['preview_error_questions'])) {
                        $pErrs = is_array($r['preview_error_questions']) ? $r['preview_error_questions'] : json_decode($r['preview_error_questions'], true);
                    }
                    $pDetails = [];
                    $pWeakList = [];
                    $pWk = (int)($r['preview_week_num'] ?? $sWk);
                    if (!empty($pErrs) && !empty($sSub) && !empty($sGrd) && $pWk > 0) {
                        $pSubKey = $sSub . '___' . $sGrd . '___' . $sTier . '___' . $pWk;
                        foreach ($pErrs as $num) {
                            $qNum = (int)$num;
                            $tName = $previewTopicMap[$pSubKey . '___' . $qNum] ?? '';
                            $cleanT = preg_replace('/[\s,，.。;；:：、\-_—]+$/u', '', $tName);
                            $pDetails[] = [
                                'num'   => $qNum,
                                'topic' => $cleanT ?: '未标注考点'
                            ];
                            if ($cleanT) {
                                $pWeakList[] = $cleanT;
                            }
                        }
                    }
                    $r['preview_error_details'] = $pDetails;
                    $r['preview_weak_points'] = array_values(array_unique($pWeakList));
                    $r['preview_weak_points_text'] = implode('、', array_unique($pWeakList));
                }
                unset($r);
            }

            // 附带教师名下助教统计与助教列表 (users)
            if ($table === 'users' && !empty($rows)) {
                try {
                    $allAssistants = DB::fetchAll("SELECT `id`, `username`, `real_name`, `role`, `status`, '' AS `initial_password`, `last_login_at`, `last_login_ip`, `created_at`, `teacher_id`, `created_by` FROM `users` WHERE `role` = 'assistant' ORDER BY `id` ASC");
                    $assistantsByTeacherId = [];
                    $assistantsByTeacherUname = [];
                    foreach ($allAssistants as $ast) {
                        if (!empty($ast['teacher_id'])) {
                            $assistantsByTeacherId[(int)$ast['teacher_id']][] = $ast;
                        }
                        if (!empty($ast['created_by'])) {
                            $assistantsByTeacherUname[$ast['created_by']][] = $ast;
                        }
                    }
                    foreach ($rows as &$r) {
                        $tid = (int)$r['id'];
                        $tUname = $r['username'];
                        $myAsts = $assistantsByTeacherId[$tid] ?? ($assistantsByTeacherUname[$tUname] ?? []);
                        $r['assistants'] = $myAsts;
                        $r['assistant_count'] = count($myAsts);
                    }
                    unset($r);
                } catch (Throwable $e) {
                    error_log("load assistants for users table error: " . $e->getMessage());
                }
            }

            $totalPages = (int)ceil($total / $pageSize);
            sendResponse(true, [
                'table'       => $table,
                'primary_key' => $pk,
                'page'        => $page,
                'page_size'   => $pageSize,
                'perPage'     => $pageSize,
                'total'       => $total,
                'total_pages' => $totalPages,
                'totalPages'  => $totalPages,
                'columns'     => array_values($cols),
                'schema'      => array_values($cols),
                'rows'        => $rows,
                'records'     => $rows
            ]);
            break;

        case 'db_get':
            requireAdmin();
            $table = validateTable($_GET['table'] ?? '');
            $pk = getTablePrimaryKey($table);
            $id = $_GET['id'] ?? null;
            if ($id === null) sendResponse(false, null, '缺少主键 ID', 400);

            $row = DB::fetchOne("SELECT * FROM `{$table}` WHERE `{$pk}` = ? LIMIT 1", [$id]);
            if (!$row) sendResponse(false, null, '记录未找到', 404);
            if ($table === 'admin_users') {
                $row['password_hash'] = '';
                $row['password'] = '';
            } elseif ($table === 'users') {
                $row['password_hash'] = '';
                try {
                    $row['assistants'] = DB::fetchAll(
                        "SELECT `id`, `username`, `real_name`, `role`, `status`, '' AS `initial_password`, `last_login_at`, `last_login_ip`, `created_at`, `teacher_id`, `created_by` 
                         FROM `users` 
                         WHERE `role` = 'assistant' AND (`teacher_id` = ? OR `created_by` = ?) 
                         ORDER BY `id` ASC",
                        [$row['id'], $row['username']]
                    );
                    $row['assistant_count'] = count($row['assistants']);
                } catch (Throwable $e) {
                    $row['assistants'] = [];
                    $row['assistant_count'] = 0;
                }
            }
            sendResponse(true, array_merge(['record' => $row], $row));
            break;

        case 'db_create':
            if ($method !== 'POST') sendResponse(false, null, '只支持 POST 请求', 405);
            requireAdmin();
            $rawInput = json_decode(file_get_contents('php://input'), true);
            if (!is_array($rawInput)) sendResponse(false, null, '提交数据格式错误', 400);

            $table = validateTable($_GET['table'] ?? ($rawInput['table'] ?? ''));
            $cols = getTableColumns($table);
            $pk = getTablePrimaryKey($table);
            $input = (isset($rawInput['data']) && is_array($rawInput['data'])) ? $rawInput['data'] : $rawInput;
            unset($input['table']);

            // 管理员表与前台教师账号特殊处理
            if ($table === 'admin_users' || $table === 'users') {
                $usernameVal = trim((string)($input['username'] ?? ''));
                if ($usernameVal === '') {
                    sendResponse(false, null, '账号不能为空', 400);
                }
                $input['username'] = $usernameVal;

                $exists = DB::fetchOne("SELECT `id` FROM `{$table}` WHERE `username` = ? LIMIT 1", [$usernameVal]);
                if ($exists) {
                    sendResponse(false, null, "账号 [{$usernameVal}] 已存在，请更换其它账号", 400);
                }

                $rawPwd = trim((string)($input['password'] ?? ($input['password_hash'] ?? '')));
                if ($rawPwd === '') {
                    sendResponse(false, null, '新增账号必须设置登录密码', 400);
                }
                if (strlen($rawPwd) < 6) {
                    sendResponse(false, null, '登录密码长度不能少于 6 位', 400);
                }
                $input['password_hash'] = password_hash($rawPwd, PASSWORD_BCRYPT);
                if ($table === 'users') {
                    $input['initial_password'] = '';
                }
                unset($input['password']);
            }

            // 学生错题表特殊处理
            if ($table === 'student_records') {
                if (empty($input['batch_id'])) {
                    $latestBatch = (int)DB::fetchValue("SELECT id FROM class_batches ORDER BY id DESC LIMIT 1");
                    if ($latestBatch > 0) {
                        $input['batch_id'] = $latestBatch;
                    }
                }
                if (isset($input['student_id']) && isset($input['student_name']) && empty($input['student_key'])) {
                    $sId = trim((string)$input['student_id']);
                    $sName = trim((string)$input['student_name']);
                    $sBatch = !empty($input['batch_id'])
                        ? DB::fetchOne("SELECT grade, subject FROM class_batches WHERE id = ?", [(int)$input['batch_id']])
                        : null;
                    $input['student_key'] = build_student_key(
                        $sId,
                        $sName,
                        (string)($sBatch['grade'] ?? ''),
                        (string)($sBatch['subject'] ?? '')
                    );
                }
                if (isset($input['error_questions'])) {
                    $eq = $input['error_questions'];
                    if (is_string($eq)) {
                        $eqTrim = trim($eq);
                        if (str_starts_with($eqTrim, '[')) {
                            $eqArr = json_decode($eqTrim, true) ?: [];
                        } else {
                            $eqArr = array_values(array_filter(array_map('intval', preg_split('/[,、，\s]+/', $eqTrim))));
                        }
                    } elseif (is_array($eq)) {
                        $eqArr = array_values(array_filter(array_map('intval', $eq)));
                    } else {
                        $eqArr = [];
                    }
                    $input['error_questions'] = json_encode($eqArr, JSON_UNESCAPED_UNICODE);
                    if (!isset($input['error_count'])) {
                        $input['error_count'] = count($eqArr);
                    }
                }
                if (isset($input['preview_error_questions'])) {
                    $peq = $input['preview_error_questions'];
                    if ($peq === null || $peq === '') {
                        $input['preview_error_questions'] = null;
                    } else {
                        if (is_string($peq)) {
                            $peqTrim = trim($peq);
                            if ($peqTrim === '' || $peqTrim === '[]') {
                                $input['preview_error_questions'] = json_encode([], JSON_UNESCAPED_UNICODE);
                            } elseif (str_starts_with($peqTrim, '[')) {
                                $peqArr = json_decode($peqTrim, true) ?: [];
                                $input['preview_error_questions'] = json_encode($peqArr, JSON_UNESCAPED_UNICODE);
                            } else {
                                $peqArr = array_values(array_filter(array_map('intval', preg_split('/[,、，\s]+/', $peqTrim))));
                                $input['preview_error_questions'] = json_encode($peqArr, JSON_UNESCAPED_UNICODE);
                            }
                        } elseif (is_array($peq)) {
                            $peqArr = array_values(array_filter(array_map('intval', $peq)));
                            $input['preview_error_questions'] = json_encode($peqArr, JSON_UNESCAPED_UNICODE);
                        }
                    }
                }
                if (empty($input['retest_token']) || $input['retest_token'] === 'auto') {
                    $chars = 'abcdefghjkmnpqrstuvwxyz23456789ABCDEFGHJKMNPQRSTUVWXYZ';
                    $charLen = strlen($chars);
                    $randBytes = random_bytes(10);
                    $genToken = '';
                    for ($ci = 0; $ci < 10; $ci++) {
                        $genToken .= $chars[ord($randBytes[$ci]) % $charLen];
                    }
                    $input['retest_token'] = $genToken;
                }
            }

            // 题库题目表新增时若关联了期次，自动补全缺失的年份/学期/学科/年级/班层/周次
            if ($table === 'qbank_questions' && !empty($input['qbank_id'])) {
                $pWeek = DB::fetchOne("SELECT `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week` FROM `qbank_weeks` WHERE `id` = ?", [$input['qbank_id']]);
                if ($pWeek) {
                    foreach (['bank_type', 'year', 'season', 'subject', 'grade', 'tier', 'week'] as $k) {
                        if (!isset($input[$k]) || $input[$k] === '') {
                            $input[$k] = $pWeek[$k];
                        }
                    }
                }
            }

            $fields = [];
            $placeholders = [];
            $values = [];

            foreach ($cols as $colName => $colDef) {
                if ($colDef['key'] === 'PRI' && ($colDef['extra'] === 'auto_increment' || empty($input[$colName]))) {
                    continue;
                }
                if ($colName === 'created_at' || $colName === 'updated_at') {
                    if (isset($input[$colName])) {
                        $fields[] = "`{$colName}`";
                        $placeholders[] = '?';
                        $values[] = $input[$colName];
                    }
                    continue;
                }
                if (array_key_exists($colName, $input)) {
                    $fields[] = "`{$colName}`";
                    $placeholders[] = '?';
                    $val = $input[$colName];
                    if (is_array($val) || is_object($val)) {
                        $val = json_encode($val, JSON_UNESCAPED_UNICODE);
                    }
                    $values[] = $val;
                }
            }

            if (empty($fields)) sendResponse(false, null, '未提供有效的数据字段', 400);

            $sql = "INSERT INTO `{$table}` (" . implode(', ', $fields) . ") VALUES (" . implode(', ', $placeholders) . ")";
            $stmt = DB::query($sql, $values);
            if (!$stmt) sendResponse(false, null, '新增记录失败: ' . (DB::getLastError() ?: '未知错误'), 500);

            $newId = DB::lastInsertId();

            if ($table === 'qbank_questions' && !empty($input['qbank_id'])) {
                try {
                    DB::execute("UPDATE `qbank_weeks` SET `question_count` = (SELECT COUNT(*) FROM `qbank_questions` WHERE `qbank_id` = ?), `updated_at` = NOW() WHERE `id` = ?", [$input['qbank_id'], $input['qbank_id']]);
                    syncQbankJsonBackup((int)$input['qbank_id']);
                } catch (Throwable $e) {
                    error_log("Post-insert qbank_questions sync error: " . $e->getMessage());
                }
            } elseif ($table === 'qbank_weeks') {
                syncQbankJsonBackup((int)$newId);
            }

            recordServerLog('action', 'admin', 'db_record_created', [
                'table' => $table,
                'record_id' => $newId,
                'message' => "在表 {$table} 中新增了记录 #{$newId}"
            ]);
            sendResponse(true, ['id' => $newId, 'message' => '新增记录成功']);
            break;

        case 'db_update':
            if ($method !== 'POST') sendResponse(false, null, '只支持 POST 请求', 405);
            requireAdmin();
            $rawInput = json_decode(file_get_contents('php://input'), true);
            if (!is_array($rawInput)) sendResponse(false, null, '提交数据格式错误', 400);

            $table = validateTable($_GET['table'] ?? ($rawInput['table'] ?? ''));
            $cols = getTableColumns($table);
            $pk = getTablePrimaryKey($table);
            $id = $_GET['id'] ?? ($rawInput['id'] ?? null);
            if ($id === null) sendResponse(false, null, '缺少主键 ID', 400);

            $input = (isset($rawInput['data']) && is_array($rawInput['data'])) ? $rawInput['data'] : $rawInput;
            unset($input['table'], $input['id']);

            if ($table === 'users') {
                $targetUser = DB::fetchOne("SELECT username FROM `users` WHERE `{$pk}` = ? LIMIT 1", [$id]);
                if ($targetUser && $targetUser['username'] === '0') {
                    if (!empty($input['password']) || !empty($input['password_hash']) || !empty($input['initial_password'])) {
                        sendResponse(false, null, '测试账号(0)为系统保留账号，禁止修改或重置密码', 403);
                    }
                }
            }

            if ($table === 'admin_users' || $table === 'users') {
                $rawPwd = trim((string)($input['password'] ?? ($input['password_hash'] ?? '')));
                if ($rawPwd === '' || $rawPwd === '●●●●●●●●' || str_starts_with($rawPwd, '●')) {
                    unset($input['password_hash'], $input['password']);
                } else if (!str_starts_with($rawPwd, '$2y$') && !str_starts_with($rawPwd, '$2a$')) {
                    if (strlen($rawPwd) < 6) {
                        sendResponse(false, null, '登录密码长度不能少于 6 位', 400);
                    }
                    $input['password_hash'] = password_hash($rawPwd, PASSWORD_BCRYPT);
                    if ($table === 'users') {
                        $input['initial_password'] = '';
                    }
                    unset($input['password']);
                }
            }

            if ($table === 'student_records') {
                if (isset($input['student_id']) || isset($input['student_name'])) {
                    $curr = DB::fetchOne("SELECT student_id, student_name, batch_id FROM student_records WHERE id = ?", [$id]);
                    $sId = trim((string)($input['student_id'] ?? ($curr['student_id'] ?? '')));
                    $sName = trim((string)($input['student_name'] ?? ($curr['student_name'] ?? '')));
                    $sBatchId = (int)($input['batch_id'] ?? ($curr['batch_id'] ?? 0));
                    $sBatch = $sBatchId > 0
                        ? DB::fetchOne("SELECT grade, subject FROM class_batches WHERE id = ?", [$sBatchId])
                        : null;
                    $input['student_key'] = build_student_key(
                        $sId,
                        $sName,
                        (string)($sBatch['grade'] ?? ''),
                        (string)($sBatch['subject'] ?? '')
                    );
                }
                if (isset($input['error_questions'])) {
                    $eq = $input['error_questions'];
                    if (is_string($eq)) {
                        $eqTrim = trim($eq);
                        if (str_starts_with($eqTrim, '[')) {
                            $eqArr = json_decode($eqTrim, true) ?: [];
                        } else {
                            $eqArr = array_values(array_filter(array_map('intval', preg_split('/[,、，\s]+/', $eqTrim))));
                        }
                    } elseif (is_array($eq)) {
                        $eqArr = array_values(array_filter(array_map('intval', $eq)));
                    } else {
                        $eqArr = [];
                    }
                    $input['error_questions'] = json_encode($eqArr, JSON_UNESCAPED_UNICODE);
                    if (!isset($input['error_count'])) {
                        $input['error_count'] = count($eqArr);
                    }
                }
                if (isset($input['preview_error_questions'])) {
                    $peq = $input['preview_error_questions'];
                    if ($peq === null || $peq === '') {
                        $input['preview_error_questions'] = null;
                    } else {
                        if (is_string($peq)) {
                            $peqTrim = trim($peq);
                            if ($peqTrim === '' || $peqTrim === '[]') {
                                $input['preview_error_questions'] = json_encode([], JSON_UNESCAPED_UNICODE);
                            } elseif (str_starts_with($peqTrim, '[')) {
                                $peqArr = json_decode($peqTrim, true) ?: [];
                                $input['preview_error_questions'] = json_encode($peqArr, JSON_UNESCAPED_UNICODE);
                            } else {
                                $peqArr = array_values(array_filter(array_map('intval', preg_split('/[,、，\s]+/', $peqTrim))));
                                $input['preview_error_questions'] = json_encode($peqArr, JSON_UNESCAPED_UNICODE);
                            }
                        } elseif (is_array($peq)) {
                            $peqArr = array_values(array_filter(array_map('intval', $peq)));
                            $input['preview_error_questions'] = json_encode($peqArr, JSON_UNESCAPED_UNICODE);
                        }
                    }
                }
            }

            // 若更新的是 qbank_weeks 表，记录修改前的基础信息以便清理/重命名旧的 JSON 灾备文件
            $oldWeekRec = null;
            if ($table === 'qbank_weeks') {
                $oldWeekRec = DB::fetchOne("SELECT `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week` FROM `qbank_weeks` WHERE `id` = ?", [$id]);
            }

            // 若更新的是 qbank_questions 表且修改了所属专题 qbank_id，自动对齐期次维度字段
            if ($table === 'qbank_questions' && isset($input['qbank_id'])) {
                $parentWeek = DB::fetchOne("SELECT `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week` FROM `qbank_weeks` WHERE `id` = ?", [$input['qbank_id']]);
                if ($parentWeek) {
                    foreach (['bank_type', 'year', 'season', 'subject', 'grade', 'tier', 'week'] as $k) {
                        $input[$k] = $parentWeek[$k];
                    }
                }
            }

            $setParts = [];
            $values = [];

            foreach ($cols as $colName => $colDef) {
                if ($colDef['key'] === 'PRI' || $colName === 'created_at') {
                    continue;
                }
                if ($colName === 'updated_at' && !isset($input['updated_at'])) {
                    $setParts[] = "`updated_at` = NOW()";
                    continue;
                }
                if (array_key_exists($colName, $input)) {
                    $setParts[] = "`{$colName}` = ?";
                    $val = $input[$colName];
                    if (is_array($val) || is_object($val)) {
                        $val = json_encode($val, JSON_UNESCAPED_UNICODE);
                    }
                    $values[] = $val;
                }
            }

            if (empty($setParts)) sendResponse(false, null, '未提供任何修改字段', 400);

            // 若更新的是 student_records 表，在覆盖前先将原版本安全归档至 student_record_history
            if ($table === 'student_records') {
                try {
                    $oldRec = DB::fetchOne("SELECT * FROM `student_records` WHERE `id` = ?", [$id]);
                    if ($oldRec) {
                        $bInfo = DB::fetchOne("SELECT batch_code, created_by FROM `generation_batches` WHERE `class_id` = ? AND `week_num` = ? ORDER BY id DESC LIMIT 1", [$oldRec['batch_id'], $oldRec['week_num']]);
                        DB::execute("
                            INSERT INTO `student_record_history` (
                                record_id, batch_id, batch_code, student_id, student_name, student_key,
                                week_num, preview_week_num, homework_score, preview_score, total_score, error_count,
                                error_questions, preview_error_questions, teacher_comment, preview_comment, source_files, retest_token,
                                created_by, operator, operation_type, record_created_at, record_updated_at, archived_at
                            ) VALUES (
                                ?, ?, ?, ?, ?, ?,
                                ?, ?,
                                ?, ?, ?, ?,
                                ?, ?, ?, ?, ?, ?,
                                ?, ?, 'admin_edit', ?, ?, NOW()
                            )
                        ", [
                            $oldRec['id'],
                            $oldRec['batch_id'],
                            $bInfo['batch_code'] ?? '',
                            $oldRec['student_id'] ?? '',
                            $oldRec['student_name'],
                            $oldRec['student_key'] ?? '',
                            $oldRec['week_num'],
                            $oldRec['preview_week_num'] ?? null,
                            $oldRec['homework_score'],
                            $oldRec['preview_score'],
                            $oldRec['total_score'],
                            $oldRec['error_count'],
                            $oldRec['error_questions'],
                            $oldRec['preview_error_questions'] ?? null,
                            $oldRec['teacher_comment'],
                            $oldRec['preview_comment'] ?? null,
                            $oldRec['source_files'] ?? null,
                            $oldRec['retest_token'] ?? null,
                            $bInfo['created_by'] ?? '',
                            $_SESSION['admin_username'] ?? ($_SESSION['admin_user'] ?? 'admin'),
                            $oldRec['created_at'],
                            $oldRec['updated_at']
                        ]);
                    }
                } catch (Throwable $e) {
                    error_log("DB student_records admin_edit history archive error: " . $e->getMessage());
                }
            }

            $values[] = $id;
            $sql = "UPDATE `{$table}` SET " . implode(', ', $setParts) . " WHERE `{$pk}` = ?";
            $stmt = DB::query($sql, $values);
            if (!$stmt) sendResponse(false, null, '更新失败: ' . (DB::getLastError() ?: '请检查数据格式'), 500);

            // 若更新的是 qbank_weeks 表，级联同步更新 qbank_questions 明细表与 JSON 灾备文件
            if ($table === 'qbank_weeks') {
                try {
                    $newWeek = DB::fetchOne("SELECT `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week` FROM `qbank_weeks` WHERE `id` = ?", [$id]);
                    if ($newWeek) {
                        // 1. 级联同步 qbank_questions 冗余字段
                        DB::execute("
                            UPDATE `qbank_questions`
                            SET `bank_type` = ?, `year` = ?, `season` = ?, `subject` = ?, `grade` = ?, `tier` = ?, `week` = ?, `updated_at` = NOW()
                            WHERE `qbank_id` = ?
                        ", [
                            $newWeek['bank_type'] ?? 'homework',
                            $newWeek['year'],
                            $newWeek['season'],
                            $newWeek['subject'],
                            $newWeek['grade'],
                            $newWeek['tier'],
                            $newWeek['week'],
                            $id
                        ]);

                        // 2. 同步灾备 JSON 镜像文件
                        syncQbankJsonBackup((int)$id, $oldWeekRec);
                    }
                } catch (Throwable $e) {
                    error_log("Cascade update qbank_weeks error: " . $e->getMessage());
                }
            }

            // 若更新的是 qbank_questions 表，同步刷新所属期次的 JSON 灾备文件
            if ($table === 'qbank_questions') {
                try {
                    $curQ = DB::fetchOne("SELECT `qbank_id` FROM `qbank_questions` WHERE `id` = ?", [$id]);
                    if ($curQ && !empty($curQ['qbank_id'])) {
                        syncQbankJsonBackup((int)$curQ['qbank_id']);
                    }
                } catch (Throwable $e) {
                    error_log("Sync qbank_questions JSON error: " . $e->getMessage());
                }
            }

            recordServerLog('action', 'admin', 'db_record_updated', [
                'table' => $table,
                'record_id' => $id,
                'fields' => array_keys($input),
                'message' => "在表 {$table} 中更新了记录 #{$id}"
            ]);

            sendResponse(true, ['message' => '更新成功', 'affected' => $stmt->rowCount()]);
            break;

        case 'db_delete':
            if ($method !== 'POST') sendResponse(false, null, '只支持 POST 请求', 405);
            requireAdmin();
            $rawInput = json_decode(file_get_contents('php://input'), true) ?: [];
            $table = validateTable($_GET['table'] ?? ($rawInput['table'] ?? ''));
            $pk = getTablePrimaryKey($table);

            $ids = [];
            if (isset($_GET['id']) && $_GET['id'] !== '') $ids[] = $_GET['id'];
            if (!empty($rawInput['id'])) $ids[] = $rawInput['id'];
            if (!empty($rawInput['ids']) && is_array($rawInput['ids'])) {
                $ids = array_merge($ids, $rawInput['ids']);
            }
            $ids = array_unique(array_filter($ids));
            if (empty($ids)) sendResponse(false, null, '请指定要删除的记录 ID', 400);

            if ($table === 'admin_users') {
                $adminCount = (int)DB::fetchValue("SELECT COUNT(*) FROM `admin_users`");
                if ($adminCount <= count($ids)) {
                    sendResponse(false, null, '系统必须保留至少一个管理员账号，无法全部删除', 400);
                }
                $placeholders = implode(',', array_fill(0, count($ids), '?'));
                $targetUsers = DB::fetchAll("SELECT username FROM `admin_users` WHERE `id` IN ({$placeholders})", array_values($ids));
                foreach ($targetUsers as $tu) {
                    if ($tu['username'] === ($_SESSION['admin_username'] ?? '')) {
                        sendResponse(false, null, '无法删除当前正在登录的管理员账号', 400);
                    }
                }
            }

            if ($table === 'users') {
                $placeholders = implode(',', array_fill(0, count($ids), '?'));
                $hasTestAcc = (int)DB::fetchValue("SELECT COUNT(*) FROM `users` WHERE `id` IN ({$placeholders}) AND `username` = '0'", array_values($ids));
                if ($hasTestAcc > 0) {
                    sendResponse(false, null, '测试账号(0)为系统公共过渡账号，禁止删除', 403);
                }
            }

            $affectedQbankIds = [];
            if ($table === 'qbank_weeks') {
                try {
                    foreach ($ids as $delId) {
                        $wRec = DB::fetchOne("SELECT `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week` FROM `qbank_weeks` WHERE `id` = ?", [$delId]);
                        deleteQbankJsonBackup($wRec);
                    }
                    $inPlaceholders = implode(',', array_fill(0, count($ids), '?'));
                    DB::execute("DELETE FROM `qbank_questions` WHERE `qbank_id` IN ({$inPlaceholders})", array_values($ids));
                } catch (Throwable $e) {
                    error_log("Cascade delete qbank_weeks error: " . $e->getMessage());
                }
            } elseif ($table === 'qbank_questions') {
                try {
                    $inPlaceholders = implode(',', array_fill(0, count($ids), '?'));
                    $rows = DB::fetchAll("SELECT DISTINCT `qbank_id` FROM `qbank_questions` WHERE `id` IN ({$inPlaceholders})", array_values($ids));
                    foreach ($rows as $r) {
                        if (!empty($r['qbank_id'])) $affectedQbankIds[] = (int)$r['qbank_id'];
                    }
                } catch (Throwable $e) {
                    error_log("Pre-delete qbank_questions error: " . $e->getMessage());
                }
            }

            // 删除前抓取受影响学生，供删除后清理错题本 Token 与历史 JSON。
            $retestAffectedRows = [];
            if ($table === 'student_records' || $table === 'class_batches') {
                try {
                    $retestIn = implode(',', array_fill(0, count($ids), '?'));
                    $retestFields = "sr.student_id, sr.student_name, sr.student_key, sr.week_num, cb.subject, cb.grade";
                    if ($table === 'student_records') {
                        $retestAffectedRows = DB::fetchAll(
                            "SELECT {$retestFields}
                             FROM `student_records` sr
                             LEFT JOIN `class_batches` cb ON sr.batch_id = cb.id
                             WHERE sr.id IN ({$retestIn})",
                            array_values($ids)
                        );
                    } else {
                        $retestAffectedRows = DB::fetchAll(
                            "SELECT {$retestFields}
                             FROM `student_records` sr
                             INNER JOIN `class_batches` cb ON sr.batch_id = cb.id
                             WHERE sr.batch_id IN ({$retestIn})",
                            array_values($ids)
                        );
                    }
                } catch (Throwable $e) {
                    error_log("Pre-delete retest artifact lookup error: " . $e->getMessage());
                }
            }

            $inPlaceholders = implode(',', array_fill(0, count($ids), '?'));
            $sql = "DELETE FROM `{$table}` WHERE `{$pk}` IN ({$inPlaceholders})";
            $stmt = DB::query($sql, array_values($ids));
            if (!$stmt) sendResponse(false, null, '删除失败', 500);

            // 级联清理错题本档案：仅清数据库行会让旧链接继续从 token_map / 历史 JSON 读取题目。
            $retestCleanup = null;
            if (!empty($retestAffectedRows)) {
                try {
                    $cleanupGroups = retest_cleanup_after_deleted_records($retestAffectedRows);
                    // 整班/整科删除时明细可能非常大，日志与响应只保留汇总，避免撑爆日志表。
                    $retestCleanup = array_map(static function (array $group): array {
                        return [
                            'subject' => $group['subject'],
                            'grade' => $group['grade'],
                            'students' => $group['students'],
                            'deleted_weeks' => $group['deleted_weeks'],
                            'remaining_weeks' => $group['remaining_weeks'],
                            'db_query_failed' => $group['db_query_failed'],
                            'history_files' => $group['history']['files'],
                            'history_keys_removed' => $group['history']['keys_removed'],
                            'history_weeks_removed' => $group['history']['weeks_removed'],
                            'tokens_removed' => count($group['tokens']['removed']),
                            'tokens_updated' => count($group['tokens']['updated']),
                        ];
                    }, $cleanupGroups);
                    recordServerLog('warn', 'admin', 'retest_artifacts_cleaned', [
                        'table' => $table,
                        'ids' => array_values($ids),
                        'groups' => $retestCleanup,
                        'message' => "删除 {$table} 后已同步清理错题本历史档案与 Token"
                    ]);
                } catch (Throwable $e) {
                    error_log("Post-delete retest artifact cleanup error: " . $e->getMessage());
                }
            }

            if ($table === 'qbank_questions' && !empty($affectedQbankIds)) {
                try {
                    foreach ($affectedQbankIds as $wId) {
                        DB::execute("UPDATE `qbank_weeks` SET `question_count` = (SELECT COUNT(*) FROM `qbank_questions` WHERE `qbank_id` = ?), `updated_at` = NOW() WHERE `id` = ?", [$wId, $wId]);
                        syncQbankJsonBackup($wId);
                    }
                } catch (Throwable $e) {
                    error_log("Post-delete qbank_questions error: " . $e->getMessage());
                }
            }

            recordServerLog('warn', 'admin', 'db_record_deleted', [
                'table' => $table,
                'ids' => array_values($ids),
                'count' => $stmt->rowCount(),
                'message' => "从表 {$table} 删除了 {$stmt->rowCount()} 条记录"
            ]);

            sendResponse(true, [
                'deleted' => $stmt->rowCount(),
                'message' => "已成功删除 {$stmt->rowCount()} 条记录",
                'retest_cleanup' => $retestCleanup
            ]);
            break;

        case 'db_reset_teacher_password':
            if ($method !== 'POST') sendResponse(false, null, '只支持 POST 请求', 405);
            requireAdmin();
            $rawInput = json_decode(file_get_contents('php://input'), true) ?: [];
            $userId = (int)($rawInput['id'] ?? ($_GET['id'] ?? 0));
            $username = trim((string)($rawInput['username'] ?? ($_GET['username'] ?? '')));
            $newPassword = trim((string)($rawInput['password'] ?? ''));

            if ($userId <= 0 && $username === '') {
                sendResponse(false, null, '缺少教师账号参数', 400);
            }
            if ($newPassword === '' || strlen($newPassword) < 6) {
                sendResponse(false, null, '新密码不能为空且长度至少为 6 位', 400);
            }

            $user = null;
            if ($userId > 0) {
                $user = DB::fetchOne("SELECT * FROM `users` WHERE `id` = ? LIMIT 1", [$userId]);
            } else {
                $user = DB::fetchOne("SELECT * FROM `users` WHERE `username` = ? LIMIT 1", [$username]);
            }

            if (!$user) {
                sendResponse(false, null, '未找到指定教师账号', 404);
            }

            if ($user['username'] === '0') {
                sendResponse(false, null, '测试账号(0)为系统公共过渡账号，禁止重置密码', 403);
            }

            $newHash = password_hash($newPassword, PASSWORD_DEFAULT);
            try {
                DB::execute("UPDATE `users` SET `password_hash` = ?, `initial_password` = '', `updated_at` = NOW() WHERE `id` = ?", [$newHash, $user['id']]);
            } catch (Throwable $e) {
                error_log("db_reset_teacher_password error: " . $e->getMessage());
                sendResponse(false, null, '重置密码写入失败，请稍后重试', 500);
            }

            recordServerLog('action', 'admin', 'teacher_password_reset', [
                'target_username'  => $user['username'],
                'target_real_name' => $user['real_name'],
                'operator'         => $_SESSION['admin_username'] ?? ($_SESSION['admin_user'] ?? 'admin'),
                'message'          => "管理员重置了教师 {$user['username']} ({$user['real_name']}) 的密码"
            ]);

            sendResponse(true, ['message' => "已成功重置教师 {$user['username']} 的密码"]);
            break;

        case 'download_source_file':
            requireAdmin();
            $origFileName = trim((string)($_GET['file_name'] ?? ''));
            $recordId = (int)($_GET['record_id'] ?? 0);
            $historyId = (int)($_GET['history_id'] ?? 0);
            $batchCode = trim((string)($_GET['batch_code'] ?? ''));
            $checkOnly = !empty($_GET['check_only']);

            if ($origFileName === '') {
                sendResponse(false, null, '缺少文件名参数', 400);
            }

            $studentName = '';
            $refTimestamps = [];

            if ($historyId > 0) {
                $hRow = DB::fetchOne("SELECT `batch_code`, `student_name`, `record_created_at`, `record_updated_at`, `archived_at` FROM `student_record_history` WHERE `id` = ? LIMIT 1", [$historyId]);
                if ($hRow) {
                    if ($batchCode === '' && !empty($hRow['batch_code'])) $batchCode = (string)$hRow['batch_code'];
                    $studentName = trim((string)($hRow['student_name'] ?? ''));
                    foreach (['record_updated_at', 'record_created_at', 'archived_at'] as $tk) {
                        if (!empty($hRow[$tk])) {
                            $ts = strtotime((string)$hRow[$tk]);
                            if ($ts) $refTimestamps[] = $ts;
                        }
                    }
                }
            }

            if ($recordId > 0 && empty($refTimestamps)) {
                $rRow = DB::fetchOne("SELECT `batch_code`, `student_name`, `created_at`, `updated_at` FROM `student_records` WHERE `id` = ? LIMIT 1", [$recordId]);
                if ($rRow) {
                    if ($batchCode === '' && !empty($rRow['batch_code'])) $batchCode = (string)$rRow['batch_code'];
                    if ($studentName === '') $studentName = trim((string)($rRow['student_name'] ?? ''));
                    foreach (['updated_at', 'created_at'] as $tk) {
                        if (!empty($rRow[$tk])) {
                            $ts = strtotime((string)$rRow[$tk]);
                            if ($ts) $refTimestamps[] = $ts;
                        }
                    }
                }
            }

            if ($batchCode !== '' && preg_match('/^B(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/', $batchCode, $bm)) {
                $bTs = strtotime("{$bm[1]}-{$bm[2]}-{$bm[3]} {$bm[4]}:{$bm[5]}:{$bm[6]}");
                if ($bTs) array_unshift($refTimestamps, $bTs);
            }
            $refTimestamps = array_values(array_unique(array_filter($refTimestamps)));

            $baseOrig = basename(str_replace('\\', '/', $origFileName));
            $expectedSanitized = strtolower((string)preg_replace('/[^a-zA-Z0-9.\-_]/', '', $baseOrig));

            // 根据原文件名推断文件类型标签
            $expectedType = '';
            if (preg_match('/预习|preview/iu', $baseOrig)) {
                $expectedType = 'preview';
            } elseif (preg_match('/统计报告|报告|report/iu', $baseOrig)) {
                $expectedType = 'report';
            } elseif (preg_match('/笔记|note/iu', $baseOrig)) {
                $expectedType = 'note';
            } elseif (preg_match('/测试|测验|class_test/iu', $baseOrig)) {
                $expectedType = 'class_test';
            } elseif (preg_match('/名单|花名册|roster/iu', $baseOrig)) {
                $expectedType = 'roster';
            } elseif (preg_match('/巩固|课后|作业|homework/iu', $baseOrig)) {
                $expectedType = 'homework';
            }

            $uploadDirs = array_values(array_unique(array_filter([
                realpath(__DIR__ . '/../../data/uploads'),
                is_dir('/www/wwwroot/JF/feedback-git/feedback-v1/data/uploads') ? realpath('/www/wwwroot/JF/feedback-git/feedback-v1/data/uploads') : null,
                is_dir('/www/wwwroot/JF/feedback-v1/data/uploads') ? realpath('/www/wwwroot/JF/feedback-v1/data/uploads') : null,
            ])));

            $candidates = [];

            // 1. 优先检索 index.jsonl 精确原名映射
            foreach ($uploadDirs as $uDir) {
                $idxFile = $uDir . '/index.jsonl';
                if (is_file($idxFile)) {
                    $lines = @file($idxFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
                    if (is_array($lines)) {
                        foreach ($lines as $line) {
                            $item = @json_decode($line, true);
                            if (!is_array($item) || empty($item['rel'])) continue;
                            if (($item['orig'] ?? '') === $baseOrig) {
                                $fullPath = $uDir . '/' . ltrim((string)$item['rel'], '/');
                                if (is_file($fullPath)) {
                                    $candidates[$fullPath] = [
                                        'path' => $fullPath,
                                        'ts' => (int)($item['ts'] ?? filemtime($fullPath)),
                                        'type' => (string)($item['type'] ?? ''),
                                        'exact_index' => true
                                    ];
                                }
                            }
                        }
                    }
                }
            }

            // 2. 扫描 data/uploads/*/* 归档目录
            foreach ($uploadDirs as $uDir) {
                $files = glob($uDir . '/*/*');
                if (!$files) continue;
                foreach ($files as $fPath) {
                    if (!is_file($fPath)) continue;
                    $bName = basename($fPath);
                    if (!preg_match('/^(\d{8})_(\d{6})_([a-z_]+)_(.*)$/i', $bName, $m)) {
                        continue;
                    }
                    $dStr = $m[1];
                    $tStr = $m[2];
                    $fType = strtolower($m[3]);
                    $fRest = strtolower($m[4]);

                    if ($fRest !== $expectedSanitized && strtolower($bName) !== strtolower($baseOrig)) {
                        continue;
                    }
                    // 若原文件名明确指示了类型（如 preview vs homework），类型不符的同名编号文件直接排除
                    if ($expectedType !== '' && $fType !== $expectedType) {
                        continue;
                    }

                    $fTs = strtotime(
                        substr($dStr, 0, 4) . '-' . substr($dStr, 4, 2) . '-' . substr($dStr, 6, 2) . ' ' .
                        substr($tStr, 0, 2) . ':' . substr($tStr, 2, 2) . ':' . substr($tStr, 4, 2)
                    ) ?: (int)filemtime($fPath);

                    if (!isset($candidates[$fPath])) {
                        $candidates[$fPath] = [
                            'path' => $fPath,
                            'ts' => $fTs,
                            'type' => $fType,
                            'exact_index' => false
                        ];
                    }
                }
            }

            if (empty($candidates)) {
                sendResponse(false, null, "未找到文件【{$baseOrig}】的上传原件（可能已超过30天自动清理期限）", 404);
            }

            // 3. 对候选文件按时间接近度与学生姓名包含关系打分排序
            $scored = [];
            $needContentCheck = count($candidates) > 1 && $studentName !== '';
            $studentNameGbk = $needContentCheck ? @mb_convert_encoding($studentName, 'GBK', 'UTF-8') : '';

            foreach ($candidates as $cand) {
                $score = 0;
                if (!empty($cand['exact_index'])) $score += 2000000;
                if ($expectedType !== '' && $cand['type'] === $expectedType) $score += 1000000;

                if (!empty($refTimestamps)) {
                    $minDiff = PHP_INT_MAX;
                    $bestSignedDiff = PHP_INT_MAX;
                    foreach ($refTimestamps as $rTs) {
                        $signed = $rTs - $cand['ts']; // 正数表示文件在记录入库前上传
                        $absDiff = abs($signed);
                        if ($absDiff < $minDiff) {
                            $minDiff = $absDiff;
                            $bestSignedDiff = $signed;
                        }
                    }
                    // 正常流程：文件在入库前 0~2 小时内上传（或入库后 5 分钟内）
                    if ($bestSignedDiff >= -300 && $bestSignedDiff <= 7200) {
                        $score += 500000 - $minDiff;
                    } elseif ($minDiff <= 86400) {
                        $score += 200000 - $minDiff;
                    } else {
                        $score -= min($minDiff, 1000000);
                    }
                } else {
                    // 无参照时间时优先取最新上传的文件
                    $score += (int)($cand['ts'] / 1000);
                }

                if ($needContentCheck) {
                    $rawContent = @file_get_contents($cand['path'], false, null, 0, 524288);
                    if ($rawContent !== false) {
                        if (strpos($rawContent, $studentName) !== false || ($studentNameGbk && strpos($rawContent, $studentNameGbk) !== false)) {
                            $score += 300000;
                        }
                    }
                }

                $cand['score'] = $score;
                $scored[] = $cand;
            }

            usort($scored, function ($a, $b) {
                if ($a['score'] !== $b['score']) return $b['score'] <=> $a['score'];
                return $b['ts'] <=> $a['ts'];
            });

            $best = $scored[0];
            $targetPath = $best['path'];

            if ($checkOnly) {
                sendResponse(true, [
                    'found' => true,
                    'file_name' => $baseOrig,
                    'archived_name' => basename($targetPath),
                    'size' => filesize($targetPath),
                    'uploaded_at' => date('Y-m-d H:i:s', $best['ts'])
                ]);
            }

            $asciiFallback = preg_replace('/[^a-zA-Z0-9.\-_]/', '_', $baseOrig);
            if ($asciiFallback === '' || $asciiFallback === '_') $asciiFallback = 'source_file.csv';
            $encodedName = rawurlencode($baseOrig);

            if (ob_get_level()) {
                @ob_end_clean();
            }
            header('Content-Description: File Transfer');
            header('Content-Type: application/octet-stream');
            header("Content-Disposition: attachment; filename=\"{$asciiFallback}\"; filename*=UTF-8''{$encodedName}");
            header('Content-Length: ' . filesize($targetPath));
            header('Cache-Control: no-store, no-cache, must-revalidate');
            readfile($targetPath);
            exit;

}
