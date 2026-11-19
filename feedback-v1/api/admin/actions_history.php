<?php
/**
 * Admin History 学情版本历史与回滚动作处理: record_history, record_rollback
 */

require_once __DIR__ . '/../lib_retest_keys.php';

switch ($action) {
        case 'record_history':
            requireAdmin();
            $recordId = (int)($_GET['record_id'] ?? 0);
            $studentName = trim($_GET['student_name'] ?? '');
            $batchId = (int)($_GET['batch_id'] ?? 0);
            $weekNum = isset($_GET['week_num']) ? (int)$_GET['week_num'] : null;

            $where = [];
            $params = [];

            if ($recordId > 0) {
                $where[] = "(`record_id` = ? OR (`batch_id` = (SELECT batch_id FROM `student_records` WHERE id = ?) AND `student_name` = (SELECT student_name FROM `student_records` WHERE id = ?) AND `week_num` = (SELECT week_num FROM `student_records` WHERE id = ?)))";
                $params[] = $recordId;
                $params[] = $recordId;
                $params[] = $recordId;
                $params[] = $recordId;
            } elseif ($batchId > 0 && $studentName !== '') {
                $where[] = "`batch_id` = ? AND `student_name` = ?";
                $params[] = $batchId;
                $params[] = $studentName;
                if ($weekNum !== null && $weekNum > 0) {
                    $where[] = "`week_num` = ?";
                    $params[] = $weekNum;
                }
            } elseif ($studentName !== '') {
                $where[] = "`student_name` = ?";
                $params[] = $studentName;
            } else {
                sendResponse(false, null, '缺少查询参数', 400);
            }

            $sql = "SELECT h.*, cb.class_name, cb.year, cb.season, cb.grade, cb.tier, cb.subject
                    FROM `student_record_history` h
                    LEFT JOIN `class_batches` cb ON h.batch_id = cb.id
                    WHERE " . implode(' AND ', $where) . "
                    ORDER BY h.id DESC LIMIT 50";
            $historyRows = DB::fetchAll($sql, $params);

            foreach ($historyRows as &$h) {
                if (!empty($h['error_questions'])) {
                    if (is_string($h['error_questions'])) {
                        $decoded = json_decode($h['error_questions'], true);
                        $h['error_questions_list'] = is_array($decoded) ? $decoded : [];
                    } else {
                        $h['error_questions_list'] = $h['error_questions'];
                    }
                } else {
                    $h['error_questions_list'] = [];
                }
                if (!empty($h['preview_error_questions'])) {
                    if (is_string($h['preview_error_questions'])) {
                        $decoded = json_decode($h['preview_error_questions'], true);
                        $h['preview_error_questions_list'] = is_array($decoded) ? $decoded : [];
                    } else {
                        $h['preview_error_questions_list'] = $h['preview_error_questions'];
                    }
                } else {
                    $h['preview_error_questions_list'] = [];
                }
                if (!empty($h['source_files'])) {
                    if (is_string($h['source_files'])) {
                        $decoded = json_decode($h['source_files'], true);
                        $h['source_files_list'] = is_array($decoded) ? $decoded : [];
                    } else {
                        $h['source_files_list'] = $h['source_files'];
                    }
                } else {
                    $h['source_files_list'] = [];
                }
            }
            unset($h);

            sendResponse(true, ['history' => $historyRows]);
            break;

        case 'record_rollback':
            if ($method !== 'POST') sendResponse(false, null, '只支持 POST 请求', 405);
            requireAdmin();
            $rawInput = json_decode(file_get_contents('php://input'), true) ?: [];
            $historyId = (int)($rawInput['history_id'] ?? ($_GET['history_id'] ?? 0));
            if ($historyId <= 0) {
                sendResponse(false, null, '缺少历史版本ID', 400);
            }

            $h = DB::fetchOne("SELECT * FROM `student_record_history` WHERE id = ?", [$historyId]);
            if (!$h) {
                sendResponse(false, null, '未找到指定的历史版本记录', 404);
            }

            // 历史快照里的身份 Key 归一化为当前标准格式（兼容迁移前的旧快照）
            $hStudentId = trim((string)($h['student_id'] ?? ''));
            $hStudentName = (string)($h['student_name'] ?? '');
            $hStudentKey = trim((string)($h['student_key'] ?? ''));
            if ($hStudentKey === '' || ($hStudentId !== '' && $hStudentKey === legacy_student_key($hStudentId, $hStudentName))) {
                $hBatch = !empty($h['batch_id'])
                    ? DB::fetchOne("SELECT grade, subject FROM class_batches WHERE id = ?", [$h['batch_id']])
                    : null;
                $hStudentKey = build_student_key(
                    $hStudentId,
                    $hStudentName,
                    (string)($hBatch['grade'] ?? ''),
                    (string)($hBatch['subject'] ?? '')
                );
            }

            // 查找当前对应的主表记录
            $currentRec = null;
            if (!empty($h['record_id'])) {
                $currentRec = DB::fetchOne("SELECT * FROM `student_records` WHERE id = ?", [$h['record_id']]);
            }
            if (!$currentRec && !empty($h['batch_id']) && !empty($h['student_name'])) {
                $currentRec = DB::fetchOne(
                    "SELECT * FROM `student_records` WHERE batch_id = ? AND (student_key = ? OR student_name = ?) AND week_num = ? LIMIT 1",
                    [$h['batch_id'], $hStudentKey, $h['student_name'], $h['week_num']]
                );
            }

            $adminOp = $_SESSION['admin_username'] ?? ($_SESSION['admin_user'] ?? 'admin');

            $pdo = DB::getConnection();
            if ($pdo && !$pdo->inTransaction()) {
                $pdo->beginTransaction();
            }

            try {
                // 若当前记录存在，先安全归档当前状态为 before_rollback
                if ($currentRec) {
                    $curGen = DB::fetchOne("SELECT batch_code, created_by FROM `generation_batches` WHERE class_id = ? AND week_num = ? ORDER BY id DESC LIMIT 1", [$currentRec['batch_id'], $currentRec['week_num']]);
                    DB::execute("
                        INSERT INTO `student_record_history` (
                            record_id, batch_id, batch_code, student_id, student_name, student_key,
                            week_num, preview_week_num, homework_score, preview_score, total_score, error_count,
                            error_questions, preview_error_questions, teacher_comment, preview_comment, source_files, retest_token,
                            created_by, operator, operation_type, record_created_at, record_updated_at, archived_at
                        ) VALUES (
                            ?, ?, ?, ?, ?, ?,
                            ?, ?, ?, ?, ?, ?,
                            ?, ?, ?, ?, ?, ?,
                            ?, ?, 'before_rollback', ?, ?, NOW()
                        )
                    ", [
                        $currentRec['id'],
                        $currentRec['batch_id'],
                        $curGen['batch_code'] ?? '',
                        $currentRec['student_id'] ?? '',
                        $currentRec['student_name'],
                        $currentRec['student_key'] ?? '',
                        $currentRec['week_num'],
                        $currentRec['preview_week_num'] ?? null,
                        $currentRec['homework_score'],
                        $currentRec['preview_score'],
                        $currentRec['total_score'],
                        $currentRec['error_count'],
                        $currentRec['error_questions'],
                        $currentRec['preview_error_questions'] ?? null,
                        $currentRec['teacher_comment'],
                        $currentRec['preview_comment'] ?? null,
                        $currentRec['source_files'] ?? null,
                        $currentRec['retest_token'] ?? null,
                        $curGen['created_by'] ?? '',
                        $adminOp,
                        $currentRec['created_at'],
                        $currentRec['updated_at']
                    ]);

                    // 回溯覆盖更新当前记录
                    DB::execute("
                        UPDATE `student_records` SET
                            student_id = ?,
                            student_name = ?,
                            student_key = ?,
                            preview_week_num = ?,
                            homework_score = ?,
                            preview_score = ?,
                            total_score = ?,
                            error_count = ?,
                            error_questions = ?,
                            preview_error_questions = ?,
                            teacher_comment = ?,
                            preview_comment = ?,
                            source_files = ?,
                            retest_token = ?,
                            updated_at = NOW()
                        WHERE id = ?
                    ", [
                        $h['student_id'] ?? '',
                        $h['student_name'],
                        $hStudentKey,
                        $h['preview_week_num'] ?? null,
                        $h['homework_score'],
                        $h['preview_score'],
                        $h['total_score'],
                        $h['error_count'],
                        $h['error_questions'],
                        $h['preview_error_questions'] ?? null,
                        $h['teacher_comment'],
                        $h['preview_comment'] ?? null,
                        $h['source_files'],
                        $h['retest_token'],
                        $currentRec['id']
                    ]);
                    $rollbackTargetId = (int)$currentRec['id'];
                } else {
                    // 如果当前记录已被删除，则恢复插入
                    DB::execute("
                        INSERT INTO `student_records` (
                            batch_id, student_id, student_name, student_key, week_num, preview_week_num,
                            homework_score, preview_score, total_score, error_count,
                            error_questions, preview_error_questions, teacher_comment, preview_comment, source_files, retest_token,
                            created_at, updated_at
                        ) VALUES (
                            ?, ?, ?, ?, ?, ?,
                            ?, ?, ?, ?,
                            ?, ?, ?, ?, ?, ?,
                            ?, NOW()
                        )
                    ", [
                        $h['batch_id'],
                        $h['student_id'] ?? '',
                        $h['student_name'],
                        $hStudentKey,
                        $h['week_num'],
                        $h['preview_week_num'] ?? null,
                        $h['homework_score'],
                        $h['preview_score'],
                        $h['total_score'],
                        $h['error_count'],
                        $h['error_questions'],
                        $h['preview_error_questions'] ?? null,
                        $h['teacher_comment'],
                        $h['preview_comment'] ?? null,
                        $h['source_files'],
                        $h['retest_token'],
                        $h['record_created_at'] ?: date('Y-m-d H:i:s')
                    ]);
                    $rollbackTargetId = (int)DB::lastInsertId();
                }

                if ($pdo && $pdo->inTransaction()) {
                    $pdo->commit();
                }

                // 同步更新 data/history/*.json 与 token_map.json，防止回滚后旧错题残留在 JSON 灾备中
                if (!empty($rollbackTargetId)) {
                    try {
                        retest_sync_student_record_to_json((int)$rollbackTargetId);
                    } catch (Throwable $syncErr) {
                        error_log("record_rollback JSON sync error: " . $syncErr->getMessage());
                    }
                }
            } catch (Throwable $e) {
                if ($pdo && $pdo->inTransaction()) {
                    $pdo->rollBack();
                }
                error_log("record_rollback error: " . $e->getMessage());
                sendResponse(false, null, '学情记录回溯失败，数据库操作已回滚', 500);
            }

            recordServerLog('action', 'admin', 'record_rollback_executed', [
                'history_id' => $historyId,
                'target_student' => $h['student_name'],
                'week_num' => $h['week_num'],
                'operator' => $adminOp,
                'message' => "管理员将学生 {$h['student_name']} (第{$h['week_num']}周) 的学情记录回溯至版本 #{$historyId}"
            ]);

            sendResponse(true, ['message' => "已成功将学生 {$h['student_name']} 的记录回溯至历史版本 #{$historyId}"]);
            break;
}
