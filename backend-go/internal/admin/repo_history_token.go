package admin

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"net/url"
	"strings"

	"feedback-api/internal/config"
	"feedback-api/internal/retest"
	"feedback-api/internal/retestkeys"
	"feedback-api/internal/tz"
)

// ListRecordHistory mirrors PHP actions_history.php action=record_history.
func (r *MySQLRepository) ListRecordHistory(ctx context.Context, recordID int, studentName string, batchID int, weekNum *int) ([]map[string]any, error) {
	if err := r.requireDB(); err != nil {
		return nil, err
	}
	var where []string
	var params []any

	switch {
	case recordID > 0:
		where = append(where, "(`record_id` = ? OR (`batch_id` = (SELECT batch_id FROM `student_records` WHERE id = ?) AND `student_name` = (SELECT student_name FROM `student_records` WHERE id = ?) AND `week_num` = (SELECT week_num FROM `student_records` WHERE id = ?)))")
		params = append(params, recordID, recordID, recordID, recordID)
	case batchID > 0 && studentName != "":
		where = append(where, "`batch_id` = ? AND `student_name` = ?")
		params = append(params, batchID, studentName)
		if weekNum != nil && *weekNum > 0 {
			where = append(where, "`week_num` = ?")
			params = append(params, *weekNum)
		}
	case studentName != "":
		where = append(where, "`student_name` = ?")
		params = append(params, studentName)
	default:
		return nil, NewHTTPError(400, "缺少查询参数", nil)
	}

	sqlStr := "SELECT h.*, cb.class_name, cb.year, cb.season, cb.grade, cb.tier, cb.subject " +
		"FROM `student_record_history` h " +
		"LEFT JOIN `class_batches` cb ON h.batch_id = cb.id " +
		"WHERE " + strings.Join(where, " AND ") + " ORDER BY h.id DESC LIMIT 50"

	rows, err := r.db.QueryContext(ctx, sqlStr, params...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out, err := scanDynamicRows(rows)
	if err != nil {
		return nil, err
	}
	for _, h := range out {
		h["error_questions_list"] = DecodeJSONAnyList(h["error_questions"])
		h["preview_error_questions_list"] = DecodeJSONAnyList(h["preview_error_questions"])
		h["source_files_list"] = DecodeJSONAnyList(h["source_files"])
	}
	return out, nil
}

// RollbackRecord mirrors PHP actions_history.php action=record_rollback in a single transaction.
func (r *MySQLRepository) RollbackRecord(ctx context.Context, historyID int, adminOp string) (RollbackResult, error) {
	if err := r.requireDB(); err != nil {
		return RollbackResult{}, err
	}
	if adminOp == "" {
		adminOp = "admin"
	}

	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return RollbackResult{}, NewHTTPError(500, "学情记录回溯失败，数据库操作已回滚", nil)
	}
	defer func() { _ = tx.Rollback() }()

	hRows, err := tx.QueryContext(ctx, "SELECT * FROM `student_record_history` WHERE id = ? LIMIT 1", historyID)
	if err != nil {
		return RollbackResult{}, err
	}
	list, err := scanDynamicRows(hRows)
	_ = hRows.Close()
	if err != nil {
		return RollbackResult{}, err
	}
	if len(list) == 0 {
		return RollbackResult{}, NewHTTPError(404, "未找到指定的历史版本记录", nil)
	}
	h := list[0]

	hStudentID := strings.TrimSpace(config.AsPHPString(h["student_id"]))
	hStudentName := config.AsPHPString(h["student_name"])
	hStudentKey := strings.TrimSpace(config.AsPHPString(h["student_key"]))
	hBatchID := config.AsPHPInt(h["batch_id"])
	hWeekNum := config.AsPHPInt(h["week_num"])

	if hStudentKey == "" || (hStudentID != "" && hStudentKey == retestkeys.LegacyStudentKey(hStudentID, hStudentName)) {
		var grade, subject sql.NullString
		if hBatchID > 0 {
			_ = tx.QueryRowContext(ctx, "SELECT grade, subject FROM class_batches WHERE id = ? LIMIT 1", hBatchID).Scan(&grade, &subject)
		}
		hStudentKey = retestkeys.BuildStudentKey(hStudentID, hStudentName, grade.String, subject.String)
	}

	var currentRec map[string]any
	if recID := config.AsPHPInt(h["record_id"]); recID > 0 {
		if qRows, err := tx.QueryContext(ctx, "SELECT * FROM `student_records` WHERE id = ? LIMIT 1 FOR UPDATE", recID); err == nil {
			if recs, err := scanDynamicRows(qRows); err == nil && len(recs) > 0 {
				currentRec = recs[0]
			}
			_ = qRows.Close()
		}
	}
	if currentRec == nil && hBatchID > 0 && (hStudentKey != "" || hStudentName != "") {
		var qRows *sql.Rows
		var qErr error
		if hStudentKey != "" {
			qRows, qErr = tx.QueryContext(ctx,
				"SELECT * FROM `student_records` WHERE batch_id = ? AND student_key = ? AND week_num = ? LIMIT 1 FOR UPDATE",
				hBatchID, hStudentKey, hWeekNum,
			)
		} else {
			qRows, qErr = tx.QueryContext(ctx,
				"SELECT * FROM `student_records` WHERE batch_id = ? AND student_name = ? AND week_num = ? LIMIT 1 FOR UPDATE",
				hBatchID, hStudentName, hWeekNum,
			)
		}
		if qErr == nil {
			if recs, err := scanDynamicRows(qRows); err == nil && len(recs) > 0 {
				currentRec = recs[0]
			}
			_ = qRows.Close()
		}
	}

	eqVal := h["error_questions"]
	if eqVal == nil || strings.TrimSpace(config.AsPHPString(eqVal)) == "" {
		eqVal = "[]"
	}
	eqStr := config.AsPHPString(eqVal)
	hwErrs := retest.ParseJSONErrorInts(&eqStr)
	var hwScorePtr *float64
	if h["homework_score"] != nil && strings.TrimSpace(config.AsPHPString(h["homework_score"])) != "" {
		f := config.AsPHPFloat(h["homework_score"])
		hwScorePtr = &f
	}
	hwSubStatus := retest.ResolveSubmissionStatus("", hwErrs, hwScorePtr, config.AsPHPString(h["teacher_comment"]))

	var pvErrs []int
	if h["preview_error_questions"] != nil {
		peqStr := config.AsPHPString(h["preview_error_questions"])
		pvErrs = retest.ParseJSONErrorInts(&peqStr)
	}
	var pvScorePtr *float64
	if h["preview_score"] != nil && strings.TrimSpace(config.AsPHPString(h["preview_score"])) != "" {
		f := config.AsPHPFloat(h["preview_score"])
		pvScorePtr = &f
	}
	pvSubStatus := retest.ResolveSubmissionStatus("", pvErrs, pvScorePtr, config.AsPHPString(h["preview_comment"]))

	var targetID int
	if currentRec != nil {
		curBatchCode := strings.TrimSpace(config.AsPHPString(currentRec["batch_code"]))
		curCreatedBy := strings.TrimSpace(config.AsPHPString(currentRec["created_by"]))
		if curBatchCode == "" || curCreatedBy == "" {
			var gbCode, gbBy sql.NullString
			_ = tx.QueryRowContext(ctx,
				"SELECT batch_code, created_by FROM `generation_batches` WHERE class_id = ? AND week_num = ? ORDER BY id DESC LIMIT 1",
				currentRec["batch_id"], currentRec["week_num"],
			).Scan(&gbCode, &gbBy)
			if curBatchCode == "" {
				curBatchCode = gbCode.String
			}
			if curCreatedBy == "" {
				curCreatedBy = gbBy.String
			}
		}

		if _, err := tx.ExecContext(ctx, `
			INSERT INTO student_record_history (
				record_id, batch_id, batch_code, student_id, student_name, student_key,
				week_num, preview_week_num, homework_score, preview_score, total_score, error_count,
				error_questions, preview_error_questions, teacher_comment, preview_comment, source_files, retest_token,
				created_by, operator, operation_type, record_created_at, record_updated_at, archived_at
			) VALUES (
				?, ?, ?, ?, ?, ?,
				?, ?, ?, ?, ?, ?,
				?, ?, ?, ?, ?, ?,
				?, ?, 'before_rollback', ?, ?, NOW()
			)`,
			currentRec["id"],
			currentRec["batch_id"],
			curBatchCode,
			config.AsPHPString(currentRec["student_id"]),
			currentRec["student_name"],
			config.AsPHPString(currentRec["student_key"]),
			currentRec["week_num"],
			currentRec["preview_week_num"],
			currentRec["homework_score"],
			currentRec["preview_score"],
			currentRec["total_score"],
			currentRec["error_count"],
			currentRec["error_questions"],
			currentRec["preview_error_questions"],
			currentRec["teacher_comment"],
			currentRec["preview_comment"],
			currentRec["source_files"],
			currentRec["retest_token"],
			curCreatedBy,
			adminOp,
			currentRec["created_at"],
			currentRec["updated_at"],
		); err != nil {
			return RollbackResult{}, NewHTTPError(500, "学情记录回溯失败，数据库操作已回滚", nil)
		}

		if _, err := tx.ExecContext(ctx, `
			UPDATE student_records SET
				student_id = ?, student_name = ?, student_key = ?, preview_week_num = ?,
				homework_score = ?, preview_score = ?, total_score = ?, error_count = ?,
				error_questions = ?, preview_error_questions = ?, teacher_comment = ?, preview_comment = ?,
				submission_status = ?, preview_submission_status = ?,
				source_files = ?, retest_token = ?, updated_at = NOW()
			WHERE id = ?`,
			hStudentID,
			hStudentName,
			hStudentKey,
			h["preview_week_num"],
			h["homework_score"],
			h["preview_score"],
			h["total_score"],
			h["error_count"],
			eqVal,
			h["preview_error_questions"],
			h["teacher_comment"],
			h["preview_comment"],
			hwSubStatus,
			pvSubStatus,
			h["source_files"],
			h["retest_token"],
			currentRec["id"],
		); err != nil {
			return RollbackResult{}, NewHTTPError(500, "学情记录回溯失败，数据库操作已回滚", nil)
		}
		targetID = config.AsPHPInt(currentRec["id"])
	} else {
		recCreatedAt := config.AsPHPString(h["record_created_at"])
		if recCreatedAt == "" {
			recCreatedAt = tz.Now().Format("2006-01-02 15:04:05")
		}
		hBatchCode := strings.TrimSpace(config.AsPHPString(h["batch_code"]))
		hCreatedBy := strings.TrimSpace(config.AsPHPString(h["created_by"]))
		res, err := tx.ExecContext(ctx, `
			INSERT INTO student_records (
				batch_id, batch_code, student_id, student_name, student_key, week_num, preview_week_num,
				homework_score, preview_score, total_score, error_count,
				error_questions, preview_error_questions, teacher_comment, preview_comment,
				submission_status, preview_submission_status, source_files, retest_token,
				created_by, created_at, updated_at
			) VALUES (
				?, ?, ?, ?, ?, ?, ?,
				?, ?, ?, ?,
				?, ?, ?, ?,
				?, ?, ?, ?,
				?, ?, NOW()
			)`,
			h["batch_id"],
			hBatchCode,
			hStudentID,
			hStudentName,
			hStudentKey,
			h["week_num"],
			h["preview_week_num"],
			h["homework_score"],
			h["preview_score"],
			h["total_score"],
			h["error_count"],
			eqVal,
			h["preview_error_questions"],
			h["teacher_comment"],
			h["preview_comment"],
			hwSubStatus,
			pvSubStatus,
			h["source_files"],
			h["retest_token"],
			hCreatedBy,
			recCreatedAt,
		)
		if err != nil {
			return RollbackResult{}, NewHTTPError(500, "学情记录回溯失败，数据库操作已回滚", nil)
		}
		lastID, _ := res.LastInsertId()
		targetID = int(lastID)
	}

	if err := tx.Commit(); err != nil {
		return RollbackResult{}, NewHTTPError(500, "学情记录回溯失败，数据库操作已回滚", nil)
	}
	return RollbackResult{
		HistoryID:      historyID,
		TargetRecordID: targetID,
		StudentName:    hStudentName,
		WeekNum:        hWeekNum,
	}, nil
}

// SignRetestAdminSig computes hash_hmac('sha256', "{token}_{ts}", retestSecret).
func SignRetestAdminSig(token string, ts int64, retestSecret string) string {
	mac := hmac.New(sha256.New, []byte(retestSecret))
	_, _ = fmt.Fprintf(mac, "%s_%d", token, ts)
	return hex.EncodeToString(mac.Sum(nil))
}

// BuildRetestAdminURL builds the signed retest.html admin URL.
func BuildRetestAdminURL(token string, ts int64, retestSecret string) (string, string) {
	sig := SignRetestAdminSig(token, ts, retestSecret)
	u := fmt.Sprintf("retest.html?token=%s&admin_sig=%s&admin_ts=%d", url.QueryEscape(token), url.QueryEscape(sig), ts)
	return u, sig
}

// SearchByToken mirrors PHP actions_token.php action=search_by_token.
func (r *MySQLRepository) SearchByToken(ctx context.Context, token, retestSecret string) (TokenSearchResult, error) {
	out := TokenSearchResult{
		Matches:    []map[string]any{},
		AccessLogs: []map[string]any{},
	}
	if r == nil || r.db == nil {
		return out, nil
	}

	likePattern := "%" + token + "%"
	if rows, err := r.db.QueryContext(ctx, `
		SELECT sr.*, cb.year, cb.season, cb.grade, cb.tier, cb.subject, cb.class_name, cb.created_by AS batch_creator
		FROM student_records sr
		LEFT JOIN class_batches cb ON sr.batch_id = cb.id
		WHERE sr.retest_token = ? OR sr.retest_token LIKE ?
		ORDER BY (sr.retest_token = ?) DESC, sr.updated_at DESC
		LIMIT 6`,
		token, likePattern, token,
	); err == nil {
		rawRows, scanErr := scanDynamicRows(rows)
		_ = rows.Close()
		if scanErr == nil {
			nowTs := tz.Now().Unix()
			for _, row := range rawRows {
				errList := DecodeJSONAnyList(row["error_questions"])
				previewErrList := DecodeJSONAnyList(row["preview_error_questions"])
				rToken := config.AsPHPString(row["retest_token"])
				if rToken == "" {
					rToken = token
				}
				retestURL, _ := BuildRetestAdminURL(rToken, nowTs, retestSecret)

				errCount := len(errList)
				if row["error_count"] != nil {
					errCount = config.AsPHPInt(row["error_count"])
				}
				createdBy := config.AsPHPString(row["created_by"])
				if createdBy == "" {
					createdBy = config.AsPHPString(row["batch_creator"])
				}
				optInt := func(v any) any {
					if v == nil {
						return nil
					}
					return config.AsPHPInt(v)
				}
				optFloat := func(v any) any {
					if v == nil {
						return nil
					}
					return config.AsPHPFloat(v)
				}
				out.Matches = append(out.Matches, map[string]any{
					"record_id":               config.AsPHPInt(row["id"]),
					"token":                   rToken,
					"student_name":            config.AsPHPString(row["student_name"]),
					"student_id":              config.AsPHPString(row["student_id"]),
					"student_key":             config.AsPHPString(row["student_key"]),
					"year":                    row["year"],
					"season":                  config.AsPHPString(row["season"]),
					"grade":                   config.AsPHPString(row["grade"]),
					"tier":                    config.AsPHPString(row["tier"]),
					"subject":                 config.AsPHPString(row["subject"]),
					"class_name":              config.AsPHPString(row["class_name"]),
					"week_num":                optInt(row["week_num"]),
					"preview_week_num":        optInt(row["preview_week_num"]),
					"homework_score":          optFloat(row["homework_score"]),
					"preview_score":           optFloat(row["preview_score"]),
					"total_score":             optFloat(row["total_score"]),
					"error_count":             errCount,
					"error_questions":         errList,
					"preview_error_questions": previewErrList,
					"teacher_comment":         config.AsPHPString(row["teacher_comment"]),
					"preview_comment":         config.AsPHPString(row["preview_comment"]),
					"created_by":              createdBy,
					"created_at":              config.AsPHPString(row["created_at"]),
					"updated_at":              config.AsPHPString(row["updated_at"]),
					"retest_beta_url":         retestURL,
					"retest_url":              retestURL,
					"source":                  "数据库 (student_records)",
				})
			}
		}
	}

	if rows, err := r.db.QueryContext(ctx,
		"SELECT `id`, `student_name`, `action`, `details`, `ip`, `user_agent`, `created_at` FROM `retest_access_logs` WHERE `token` = ? ORDER BY `id` DESC LIMIT 6",
		token,
	); err == nil {
		if logs, scanErr := scanDynamicRows(rows); scanErr == nil {
			out.AccessLogs = logs
		}
		_ = rows.Close()
	}
	return out, nil
}

// LookupSourceFileMeta resolves reference timestamps and student name from student_record_history / student_records.
func (r *MySQLRepository) LookupSourceFileMeta(ctx context.Context, recordID, historyID int, batchCode string) (SourceFileMeta, error) {
	meta := SourceFileMeta{
		BatchCode: strings.TrimSpace(batchCode),
	}
	if r == nil || r.db == nil {
		return meta, nil
	}
	addTS := func(s string) {
		if ts, ok := parseDBTimestamp(s); ok {
			meta.RefTimestamps = append(meta.RefTimestamps, ts)
		}
	}
	if historyID > 0 {
		if rows, err := r.db.QueryContext(ctx,
			"SELECT `batch_code`, `student_name`, `record_created_at`, `record_updated_at`, `archived_at` FROM `student_record_history` WHERE `id` = ? LIMIT 1",
			historyID,
		); err == nil {
			if list, err := scanDynamicRows(rows); err == nil && len(list) > 0 {
				row := list[0]
				if meta.BatchCode == "" {
					meta.BatchCode = config.AsPHPString(row["batch_code"])
				}
				meta.StudentName = strings.TrimSpace(config.AsPHPString(row["student_name"]))
				addTS(config.AsPHPString(row["record_updated_at"]))
				addTS(config.AsPHPString(row["record_created_at"]))
				addTS(config.AsPHPString(row["archived_at"]))
			}
			_ = rows.Close()
		}
	}
	if recordID > 0 && len(meta.RefTimestamps) == 0 {
		if rows, err := r.db.QueryContext(ctx,
			"SELECT `batch_code`, `student_name`, `created_at`, `updated_at` FROM `student_records` WHERE `id` = ? LIMIT 1",
			recordID,
		); err == nil {
			if list, err := scanDynamicRows(rows); err == nil && len(list) > 0 {
				row := list[0]
				if meta.BatchCode == "" {
					meta.BatchCode = config.AsPHPString(row["batch_code"])
				}
				if meta.StudentName == "" {
					meta.StudentName = strings.TrimSpace(config.AsPHPString(row["student_name"]))
				}
				addTS(config.AsPHPString(row["updated_at"]))
				addTS(config.AsPHPString(row["created_at"]))
			}
			_ = rows.Close()
		}
	}
	if ts, ok := ParseBatchCodeTimestamp(meta.BatchCode); ok {
		meta.RefTimestamps = append([]int64{ts}, meta.RefTimestamps...)
	}
	return meta, nil
}
