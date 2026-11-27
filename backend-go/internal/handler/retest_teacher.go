package handler

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"

	"feedback-api/internal/auditlog"
	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
	"feedback-api/internal/retest"
	"feedback-api/internal/session"
	"feedback-api/internal/textutil"
)

func decodeRetestJSONBody(w http.ResponseWriter, r *http.Request, maxBytes int64) (map[string]any, error) {
	if r == nil || r.Body == nil {
		return nil, io.EOF
	}
	if maxBytes > 0 {
		r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	}
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil, io.EOF
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var out map[string]any
	if err := dec.Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

func decodeRetestInputOrForm(w http.ResponseWriter, r *http.Request, maxBytes int64) (map[string]any, func()) {
	ct := strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Type")))
	if strings.HasPrefix(ct, "application/x-www-form-urlencoded") || strings.HasPrefix(ct, "multipart/form-data") {
		if maxBytes > 0 {
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
		}
		httpx.ParseRequestForm(r)
		cleanup := func() {
			if r.MultipartForm != nil {
				_ = r.MultipartForm.RemoveAll()
			}
		}
		return nil, cleanup
	}
	input, _ := decodeRetestJSONBody(w, r, maxBytes)
	return input, func() {}
}

func firstParam(input map[string]any, r *http.Request, keys ...string) string {
	for _, k := range keys {
		if input != nil {
			if v, ok := input[k]; ok && v != nil {
				if s := phpTrim(config.AsPHPString(v)); s != "" {
					return s
				}
			}
		}
		if v := phpTrim(r.URL.Query().Get(k)); v != "" {
			return v
		}
		if v := phpTrim(r.PostFormValue(k)); v != "" {
			return v
		}
	}
	return ""
}

func handleRetestCheckExistingBatch(w http.ResponseWriter, r *http.Request, deps RetestDeps) {
	sess, ok := session.RequireAuth(w, r, deps.Sessions)
	if !ok {
		return
	}
	input, cleanup := decodeRetestInputOrForm(w, r, 4<<20)
	defer cleanup()

	subject := firstParam(input, r, "subject")
	if subject != "" {
		if _, allowed := session.RequireSubjectAccess(r.Context(), w, sess, deps.DB, subject, "查询该学科历史批次"); !allowed {
			return
		}
	}
	grade := firstParam(input, r, "grade")
	tier := firstParam(input, r, "tier")
	week := config.AsPHPInt(firstParam(input, r, "week"))
	year := config.AsPHPInt(firstParam(input, r, "year"))
	if year <= 0 {
		year = 2026
	}
	season := firstParam(input, r, "season")
	if season == "" {
		season = "秋"
	}

	in := retest.CheckBatchInput{
		Subject: subject,
		Grade:   grade,
		Tier:    tier,
		Week:    week,
		Year:    year,
		Season:  season,
	}
	if rawList, ok := input["students"].([]any); ok {
		in.HasIncomingList = true
		for _, item := range rawList {
			stMap, ok := item.(map[string]any)
			if !ok {
				continue
			}
			in.IncomingStudents = append(in.IncomingStudents, retest.CheckBatchStudent{
				Name:   phpTrim(config.AsPHPString(stMap["name"])),
				ID:     phpTrim(config.AsPHPString(stMap["id"])),
				Score:  config.AsPHPFloat(stMap["score"]),
				Errors: retest.NormalizeErrorNums(stMap["errors"]),
			})
		}
	}

	if deps.Repo == nil {
		writeRawJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "error": "检查班级历史批次失败，数据库服务异常"})
		return
	}
	res, err := deps.Repo.CheckExistingBatch(r.Context(), in)
	if err != nil {
		writeRetestRepoError(w, err, "检查班级历史批次失败，数据库服务异常")
		return
	}
	writeRawJSON(w, http.StatusOK, res)
}

func handleRetestGetStudentWeekRecord(w http.ResponseWriter, r *http.Request, deps RetestDeps, secretKey string) {
	sess, ok := session.RequireAuth(w, r, deps.Sessions)
	if !ok {
		return
	}
	input, cleanup := decodeRetestInputOrForm(w, r, 4<<20)
	defer cleanup()

	year := config.AsPHPInt(firstParam(input, r, "year"))
	if year <= 0 {
		year = 2026
	}
	season := firstParam(input, r, "season")
	if season == "" {
		season = "秋"
	}
	withRoster := config.AsPHPBool(input["with_roster"]) ||
		(r.URL.Query().Get("with_roster") != "" && r.URL.Query().Get("with_roster") != "0") ||
		(r.PostFormValue("with_roster") != "" && r.PostFormValue("with_roster") != "0")

	q := retest.StudentWeekQuery{
		Subject:     firstParam(input, r, "subject"),
		Grade:       firstParam(input, r, "grade"),
		Tier:        firstParam(input, r, "tier"),
		Week:        config.AsPHPInt(firstParam(input, r, "week")),
		PreviewWeek: config.AsPHPInt(firstParam(input, r, "preview_week", "previewWeek")),
		Year:        year,
		Season:      season,
		StudentID:   firstParam(input, r, "student_id", "studentId"),
		StudentName: firstParam(input, r, "student_name", "studentName"),
		WithRoster:  withRoster,
		SecretKey:   secretKey,
	}
	if q.Subject != "" {
		if _, allowed := session.RequireSubjectAccess(r.Context(), w, sess, deps.DB, q.Subject, "查询该学科学员错题记录"); !allowed {
			return
		}
	}

	if deps.Repo == nil {
		writeRawJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "error": "查询学员错题记录失败"})
		return
	}
	res, err := deps.Repo.GetStudentWeekRecord(r.Context(), q)
	if err != nil {
		writeRetestRepoError(w, err, "查询学员错题记录失败")
		return
	}
	writeRawJSON(w, http.StatusOK, res)
}

func handleRetestEncryptBatch(w http.ResponseWriter, r *http.Request, deps RetestDeps, secretKey string) {
	if r.Method != http.MethodPost {
		writeRawJSON(w, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "Method not allowed"})
		return
	}
	sess, ok := session.RequireAuth(w, r, deps.Sessions)
	if !ok {
		return
	}
	input, err := decodeRetestJSONBody(w, r, 16<<20)
	if err != nil || input == nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeRawJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"success": false, "error": "Payload too large"})
			return
		}
		writeRawJSON(w, http.StatusBadRequest, map[string]any{"success": false, "error": "Invalid payload"})
		return
	}
	rawStudents, hasStudents := input["students"].([]any)
	if !hasStudents {
		writeRawJSON(w, http.StatusBadRequest, map[string]any{"success": false, "error": "Invalid payload"})
		return
	}
	reqSubject := strings.TrimSpace(config.AsPHPString(input["subject"]))
	if _, allowed := session.RequireSubjectAccess(r.Context(), w, sess, deps.DB, reqSubject, "上传或生成该学科学情数据"); !allowed {
		return
	}

	week := config.AsPHPInt(input["week"])
	previewWeek := config.AsPHPInt(input["preview_week"])
	if previewWeek <= 0 {
		previewWeek = config.AsPHPInt(input["previewWeek"])
	}
	if previewWeek <= 0 {
		previewWeek = week
	}

	hasPreviewData := config.AsPHPBool(input["has_preview_data"]) || config.AsPHPBool(input["hasPreviewData"])
	hasHomeworkData := true
	if v, exists := input["has_homework_data"]; exists {
		hasHomeworkData = config.AsPHPBool(v)
	}
	isErrorsOnly := config.AsPHPBool(input["errors_only"]) || config.AsPHPBool(input["errorsOnly"])

	year := config.AsPHPInt(input["year"])
	if year <= 0 {
		year = 2026
	}
	season := strings.TrimSpace(config.AsPHPString(input["season"]))
	if season == "" {
		season = "秋"
	}

	currentTeacher := strings.TrimSpace(sess.Username())
	if currentTeacher == "" {
		currentTeacher = strings.TrimSpace(config.AsPHPString(input["teacher_username"]))
	}

	var sourceFiles []string
	seenSF := map[string]struct{}{}
	addSF := func(s string) {
		s = strings.TrimSpace(s)
		if s == "" {
			return
		}
		if _, ok := seenSF[s]; ok {
			return
		}
		seenSF[s] = struct{}{}
		sourceFiles = append(sourceFiles, s)
	}
	switch sf := input["source_files"].(type) {
	case string:
		for _, line := range strings.Split(sf, "\n") {
			addSF(line)
		}
	case []any:
		for _, item := range sf {
			addSF(config.AsPHPString(item))
		}
	}

	parseOptFloat := func(m map[string]any, key string) *float64 {
		v, ok := m[key]
		if !ok || v == nil {
			return nil
		}
		switch x := v.(type) {
		case float64:
			if math.IsNaN(x) || math.IsInf(x, 0) {
				return nil
			}
			return &x
		case json.Number:
			f, err := x.Float64()
			if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
				return nil
			}
			return &f
		case int:
			f := float64(x)
			return &f
		case string:
			s := strings.TrimSpace(x)
			if s == "" {
				return nil
			}
			f, err := strconv.ParseFloat(s, 64)
			if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
				return nil
			}
			return &f
		default:
			return nil
		}
	}

	students := make([]retest.EncryptStudentInput, 0, len(rawStudents))
	for _, item := range rawStudents {
		sm, ok := item.(map[string]any)
		if !ok {
			continue
		}
		rawHwStatus := strings.TrimSpace(config.AsPHPString(sm["submissionStatus"]))
		if rawHwStatus == "" {
			rawHwStatus = strings.TrimSpace(config.AsPHPString(sm["submission_status"]))
		}
		if rawHwStatus == "" {
			if v, exists := sm["isUnsubmitted"]; exists {
				if config.AsPHPBool(v) {
					rawHwStatus = "unsubmitted"
				} else {
					rawHwStatus = "submitted"
				}
			}
		}

		rawPvStatus := strings.TrimSpace(config.AsPHPString(sm["previewSubmissionStatus"]))
		if rawPvStatus == "" {
			rawPvStatus = strings.TrimSpace(config.AsPHPString(sm["preview_submission_status"]))
		}
		if rawPvStatus == "" {
			if v, exists := sm["isPreviewUnsubmitted"]; exists {
				if config.AsPHPBool(v) {
					rawPvStatus = "unsubmitted"
				} else {
					rawPvStatus = "submitted"
				}
			}
		}

		pvComment := strings.TrimSpace(config.AsPHPString(sm["previewComment"]))
		if pvComment == "" {
			pvComment = strings.TrimSpace(config.AsPHPString(sm["preview_comment"]))
		}
		pvWk := config.AsPHPInt(sm["previewWeek"])
		if pvWk <= 0 {
			pvWk = config.AsPHPInt(sm["preview_week"])
		}

		students = append(students, retest.EncryptStudentInput{
			Name:                    phpTrim(config.AsPHPString(sm["name"])),
			FullName:                phpTrim(config.AsPHPString(sm["fullName"])),
			ID:                      phpTrim(config.AsPHPString(sm["id"])),
			Errors:                  retest.NormalizeErrorNums(sm["errors"]),
			PreviewErrors:           retest.NormalizeErrorNums(sm["previewErrors"]),
			HomeworkScore:           parseOptFloat(sm, "homeworkScore"),
			PreviewScore:            parseOptFloat(sm, "previewScore"),
			TotalScore:              parseOptFloat(sm, "totalScore"),
			Comment:                 strings.TrimSpace(config.AsPHPString(sm["comment"])),
			PreviewComment:          pvComment,
			PreviewWeek:             pvWk,
			PreviewProvided:         config.AsPHPBool(sm["previewProvided"]) || config.AsPHPBool(sm["preview_provided"]),
			SubmissionStatus:        rawHwStatus,
			PreviewSubmissionStatus: rawPvStatus,
		})
	}

	if deps.Repo == nil {
		writeRawJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "error": "无法创建或获取班级批次信息，数据库操作异常"})
		return
	}

	res, err := deps.Repo.EncryptBatch(r.Context(), retest.EncryptBatchInput{
		Subject:         config.AsPHPString(input["subject"]),
		Grade:           config.AsPHPString(input["grade"]),
		Tier:            config.AsPHPString(input["tier"]),
		Week:            week,
		PreviewWeek:     previewWeek,
		HasPreviewData:  hasPreviewData,
		HasHomeworkData: hasHomeworkData,
		IsErrorsOnly:    isErrorsOnly,
		Year:            year,
		Season:          season,
		CurrentTeacher:  currentTeacher,
		SourceFiles:     sourceFiles,
		Students:        students,
		SecretKey:       secretKey,
	})
	if err != nil {
		writeRetestRepoError(w, err, "学生学情记录写入失败，操作已回滚")
		return
	}

	if !res.IsDebounced {
		auditlog.RecordFromRequest(r.Context(), deps.Audit, r, "action", "retest", "generate_feedback", currentTeacher, map[string]any{
			"batch_code":    res.BatchCode,
			"class_name":    res.ClassName,
			"subject":       config.AsPHPString(input["subject"]),
			"grade":         config.AsPHPString(input["grade"]),
			"tier":          config.AsPHPString(input["tier"]),
			"week":          week,
			"student_count": res.StudentCount,
			"operator":      currentTeacher,
		})
	}

	writeRawJSON(w, http.StatusOK, map[string]any{
		"success":    true,
		"batch_code": res.BatchCode,
		"tokens":     res.Tokens,
	})
}

func handleRetestRevokeToggle(w http.ResponseWriter, r *http.Request, deps RetestDeps, action string) {
	if r.Method != http.MethodPost {
		writeRawJSON(w, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "Method Not Allowed"})
		return
	}
	sess, ok := session.RequireAuth(w, r, deps.Sessions)
	if !ok {
		return
	}
	if !session.RequireNonAssistant(w, sess, "作废或恢复学生错题本链接") {
		return
	}

	body, cleanup := decodeRetestInputOrForm(w, r, 1<<20)
	defer cleanup()
	token := strings.TrimSpace(config.AsPHPString(body["token"]))
	if token == "" {
		token = strings.TrimSpace(r.PostFormValue("token"))
	}
	if token == "" {
		writeRawJSON(w, http.StatusBadRequest, map[string]any{"success": false, "error": "缺少 Token 参数"})
		return
	}

	if deps.Repo == nil {
		writeRawJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "error": "黑名单数据库写入失败"})
		return
	}

	exists, err := deps.Repo.TokenExists(r.Context(), token, action == "unrevoke_token")
	if err != nil {
		writeRawJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "error": "数据库查询服务异常，请稍后重试"})
		return
	}
	if !exists {
		writeRawJSON(w, http.StatusNotFound, map[string]any{"success": false, "error": "未找到该 Token 对应的错题本记录"})
		return
	}
	if deps.DB != nil {
		var tokenSubj sql.NullString
		err := deps.DB.QueryRowContext(
			r.Context(),
			"SELECT cb.subject FROM student_records sr LEFT JOIN class_batches cb ON sr.batch_id = cb.id WHERE sr.retest_token = ? LIMIT 1",
			token,
		).Scan(&tokenSubj)
		if err == nil && strings.TrimSpace(tokenSubj.String) != "" {
			if _, allowed := session.RequireSubjectAccess(r.Context(), w, sess, deps.DB, strings.TrimSpace(tokenSubj.String), "作废或恢复该学科错题本链接"); !allowed {
				return
			}
		}
	}

	operator := strings.TrimSpace(sess.Username())
	if operator == "" {
		operator = strings.TrimSpace(sess.AdminUsername())
	}
	if operator == "" {
		operator = "unknown"
	}

	var event, msg string
	if action == "revoke_token" {
		reason := strings.TrimSpace(config.AsPHPString(body["reason"]))
		if reason == "" {
			reason = strings.TrimSpace(r.PostFormValue("reason"))
		}
		reason = textutil.TruncateRunes(reason, 200)
		err = deps.Repo.RevokeToken(r.Context(), token, operator, reason)
		event = "revoke_token"
		msg = "已作废该错题本链接（重生成同一 Token 仍不可用，直至恢复）"
	} else {
		err = deps.Repo.UnrevokeToken(r.Context(), token)
		event = "unrevoke_token"
		msg = "已恢复该错题本链接"
	}
	if err != nil {
		writeRawJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "error": "黑名单数据库写入失败"})
		return
	}

	logRetestAccess(r, deps, token, operator, event, msg)
	auditlog.RecordFromRequest(r.Context(), deps.Audit, r, "warn", "retest", event, operator, map[string]any{
		"token":    token,
		"message":  msg,
		"operator": operator,
	})

	writeRawJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"message": msg,
	})
}
