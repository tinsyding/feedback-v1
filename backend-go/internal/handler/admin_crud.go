package handler

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"feedback-api/internal/admin"
	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
	"feedback-api/internal/session"
	"feedback-api/internal/tz"
)

var reASCIIFallback = regexp.MustCompile(`[^a-zA-Z0-9.\-_]`)

func handleAdminDBList(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	if _, ok := session.RequireAdmin(w, r, deps.Sessions); !ok {
		return
	}
	if deps.Repo == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("数据库连接失败"), http.StatusInternalServerError)
		return
	}
	q := r.URL.Query()
	firstNonEmpty := func(keys ...string) string {
		for _, k := range keys {
			if v := strings.TrimSpace(q.Get(k)); v != "" {
				return v
			}
		}
		return ""
	}
	page, _ := strconv.Atoi(q.Get("page"))
	pageSize, _ := strconv.Atoi(firstNonEmpty("page_size", "per_page", "perPage"))
	batchID, _ := strconv.Atoi(q.Get("batch_id"))
	classID, _ := strconv.Atoi(q.Get("class_id"))
	weekNum, _ := strconv.Atoi(q.Get("week_num"))
	year, _ := strconv.Atoi(q.Get("year"))
	week, _ := strconv.Atoi(q.Get("week"))

	res, err := deps.Repo.ListRecords(r.Context(), admin.ListQuery{
		Table:     q.Get("table"),
		Page:      page,
		PageSize:  pageSize,
		Search:    q.Get("search"),
		Sort:      firstNonEmpty("sort", "sort_field"),
		Order:     firstNonEmpty("order", "sort_order"),
		Grade:     strings.TrimSpace(q.Get("grade")),
		Tier:      strings.TrimSpace(q.Get("tier")),
		Subject:   strings.TrimSpace(q.Get("subject")),
		BatchID:   batchID,
		BatchCode: strings.TrimSpace(q.Get("batch_code")),
		ClassID:   classID,
		WeekNum:   weekNum,
		HasErrors: q.Get("has_errors"),
		CreatedBy: strings.TrimSpace(q.Get("created_by")),
		Year:      year,
		Season:    strings.TrimSpace(q.Get("season")),
		Week:      week,
		Level:     strings.TrimSpace(q.Get("level")),
		Module:    strings.TrimSpace(q.Get("module")),
		LogAction: strings.TrimSpace(q.Get("log_action")),
		Status:    q.Get("status"),
		Role:      strings.TrimSpace(q.Get("role")),
	})
	if err != nil {
		writeAdminRepoError(w, err)
		return
	}
	httpx.SendResponse(w, true, res, nil, http.StatusOK)
}

func handleAdminDBGet(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	if _, ok := session.RequireAdmin(w, r, deps.Sessions); !ok {
		return
	}
	if deps.Repo == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("数据库连接失败"), http.StatusInternalServerError)
		return
	}
	q := r.URL.Query()
	if !q.Has("id") {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("缺少主键 ID"), http.StatusBadRequest)
		return
	}
	row, err := deps.Repo.GetRecord(r.Context(), q.Get("table"), q.Get("id"))
	if err != nil {
		writeAdminRepoError(w, err)
		return
	}
	resp := make(map[string]any, len(row)+1)
	for k, v := range row {
		resp[k] = v
	}
	resp["record"] = row
	httpx.SendResponse(w, true, resp, nil, http.StatusOK)
}

func handleAdminDBCreate(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	if r.Method != http.MethodPost {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("只支持 POST 请求"), http.StatusMethodNotAllowed)
		return
	}
	sess, ok := session.RequireAdmin(w, r, deps.Sessions)
	if !ok {
		return
	}
	if deps.Repo == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("数据库连接失败"), http.StatusInternalServerError)
		return
	}
	rawInput, err := decodeAdminJSONBodyWithLimit(w, r, maxAdminJSONBodyBytes)
	if isMaxBytesError(err) {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("请求体大小超过限制"), http.StatusRequestEntityTooLarge)
		return
	}
	if err != nil || rawInput == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("提交数据格式错误"), http.StatusBadRequest)
		return
	}
	table := r.URL.Query().Get("table")
	if table == "" {
		table = config.AsPHPString(rawInput["table"])
	}
	input := rawInput
	if sub, ok := rawInput["data"].(map[string]any); ok && sub != nil {
		input = sub
	}
	newID, err := deps.Repo.CreateRecord(r.Context(), table, input, resolveRetestSecret(deps))
	if err != nil {
		writeAdminRepoError(w, err)
		return
	}
	adminAuditLog(r, deps, sess, "action", "db_record_created", map[string]any{
		"table":     table,
		"record_id": newID,
		"message":   fmt.Sprintf("在表 %s 中新增了记录 #%d", table, newID),
	})
	httpx.SendResponse(w, true, map[string]any{
		"id":      newID,
		"message": "新增记录成功",
	}, nil, http.StatusOK)
}

func handleAdminDBUpdate(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	if r.Method != http.MethodPost {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("只支持 POST 请求"), http.StatusMethodNotAllowed)
		return
	}
	sess, ok := session.RequireAdmin(w, r, deps.Sessions)
	if !ok {
		return
	}
	if deps.Repo == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("数据库连接失败"), http.StatusInternalServerError)
		return
	}
	rawInput, err := decodeAdminJSONBodyWithLimit(w, r, maxAdminJSONBodyBytes)
	if isMaxBytesError(err) {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("请求体大小超过限制"), http.StatusRequestEntityTooLarge)
		return
	}
	if err != nil || rawInput == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("提交数据格式错误"), http.StatusBadRequest)
		return
	}
	table := r.URL.Query().Get("table")
	if table == "" {
		table = config.AsPHPString(rawInput["table"])
	}
	var id string
	if r.URL.Query().Has("id") {
		id = r.URL.Query().Get("id")
	} else if v, exists := rawInput["id"]; exists && v != nil {
		id = config.AsPHPString(v)
	}
	if id == "" {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("缺少主键 ID"), http.StatusBadRequest)
		return
	}
	input := rawInput
	if sub, ok := rawInput["data"].(map[string]any); ok && sub != nil {
		input = sub
	}
	adminOp := sess.AdminUsername()
	if adminOp == "" {
		adminOp = "admin"
	}
	affected, fields, err := deps.Repo.UpdateRecord(r.Context(), table, id, input, adminOp)
	if err != nil {
		writeAdminRepoError(w, err)
		return
	}
	adminAuditLog(r, deps, sess, "action", "db_record_updated", map[string]any{
		"table":     table,
		"record_id": id,
		"fields":    fields,
		"message":   fmt.Sprintf("在表 %s 中更新了记录 #%s", table, id),
	})
	httpx.SendResponse(w, true, map[string]any{
		"message":  "更新成功",
		"affected": affected,
	}, nil, http.StatusOK)
}

func handleAdminDBDelete(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	if r.Method != http.MethodPost {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("只支持 POST 请求"), http.StatusMethodNotAllowed)
		return
	}
	sess, ok := session.RequireAdmin(w, r, deps.Sessions)
	if !ok {
		return
	}
	if deps.Repo == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("数据库连接失败"), http.StatusInternalServerError)
		return
	}
	rawInput, err := decodeAdminJSONBodyWithLimit(w, r, maxAdminJSONBodyBytes)
	if isMaxBytesError(err) {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("请求体大小超过限制"), http.StatusRequestEntityTooLarge)
		return
	}
	if rawInput == nil {
		rawInput = map[string]any{}
	}
	table := r.URL.Query().Get("table")
	if table == "" {
		table = config.AsPHPString(rawInput["table"])
	}

	var ids []string
	seen := map[string]struct{}{}
	addID := func(s string) {
		s = strings.TrimSpace(s)
		if s == "" || s == "0" {
			return
		}
		if _, ok := seen[s]; ok {
			return
		}
		seen[s] = struct{}{}
		ids = append(ids, s)
	}
	if v := r.URL.Query().Get("id"); v != "" {
		addID(v)
	}
	if v, exists := rawInput["id"]; exists && v != nil {
		addID(config.AsPHPString(v))
	}
	if list, ok := rawInput["ids"].([]any); ok {
		for _, item := range list {
			addID(config.AsPHPString(item))
		}
	}
	if len(ids) == 0 {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("请指定要删除的记录 ID"), http.StatusBadRequest)
		return
	}

	forceCascade := false
	if qv := strings.TrimSpace(r.URL.Query().Get("force_cascade")); qv != "" {
		forceCascade = parseFilterBool(qv)
	} else if bv, exists := rawInput["force_cascade"]; exists {
		forceCascade = parseFilterBool(bv)
	}

	deleted, err := deps.Repo.DeleteRecords(r.Context(), table, ids, sess.AdminUsername(), forceCascade)
	if err != nil {
		writeAdminRepoError(w, err)
		return
	}
	adminAuditLog(r, deps, sess, "warn", "db_record_deleted", map[string]any{
		"table":   table,
		"ids":     ids,
		"count":   deleted,
		"message": fmt.Sprintf("从表 %s 删除了 %d 条记录", table, deleted),
	})
	httpx.SendResponse(w, true, map[string]any{
		"deleted": deleted,
		"message": fmt.Sprintf("已成功删除 %d 条记录", deleted),
	}, nil, http.StatusOK)
}

func parseFilterBool(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case string:
		switch strings.ToLower(strings.TrimSpace(x)) {
		case "1", "true", "on", "yes":
			return true
		default:
			return false
		}
	default:
		return config.AsPHPBool(v)
	}
}

func handleAdminResetTeacherPassword(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	if r.Method != http.MethodPost {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("只支持 POST 请求"), http.StatusMethodNotAllowed)
		return
	}
	sess, ok := session.RequireAdmin(w, r, deps.Sessions)
	if !ok {
		return
	}
	if deps.Repo == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("数据库连接失败"), http.StatusInternalServerError)
		return
	}
	rawInput, err := decodeAdminJSONBodyWithLimit(w, r, maxAdminJSONBodyBytes)
	if isMaxBytesError(err) {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("请求体大小超过限制"), http.StatusRequestEntityTooLarge)
		return
	}
	if rawInput == nil {
		rawInput = map[string]any{}
	}
	userID := config.AsPHPInt(rawInput["id"])
	if userID <= 0 {
		userID, _ = strconv.Atoi(r.URL.Query().Get("id"))
	}
	username := strings.TrimSpace(config.AsPHPString(rawInput["username"]))
	if username == "" {
		username = strings.TrimSpace(r.URL.Query().Get("username"))
	}
	newPwd := strings.TrimSpace(config.AsPHPString(rawInput["password"]))

	if userID <= 0 && username == "" {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("缺少教师账号参数"), http.StatusBadRequest)
		return
	}
	if len(newPwd) < 6 {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("新密码不能为空且长度至少为 6 位"), http.StatusBadRequest)
		return
	}

	res, err := deps.Repo.ResetTeacherPassword(r.Context(), userID, username, newPwd)
	if err != nil {
		writeAdminRepoError(w, err)
		return
	}
	adminOp := sess.AdminUsername()
	if adminOp == "" {
		adminOp = "admin"
	}
	adminAuditLog(r, deps, sess, "action", "teacher_password_reset", map[string]any{
		"target_username":  res.Username,
		"target_real_name": res.RealName,
		"operator":         adminOp,
		"message":          fmt.Sprintf("管理员重置了教师 %s (%s) 的密码", res.Username, res.RealName),
	})
	httpx.SendResponse(w, true, map[string]any{
		"message": fmt.Sprintf("已成功重置教师 %s 的密码", res.Username),
	}, nil, http.StatusOK)
}

func handleAdminDownloadSourceFile(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	if _, ok := session.RequireAdmin(w, r, deps.Sessions); !ok {
		return
	}
	q := r.URL.Query()
	origFileName := strings.TrimSpace(q.Get("file_name"))
	if origFileName == "" {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("缺少文件名参数"), http.StatusBadRequest)
		return
	}
	recordID, _ := strconv.Atoi(q.Get("record_id"))
	historyID, _ := strconv.Atoi(q.Get("history_id"))
	batchCode := strings.TrimSpace(q.Get("batch_code"))
	checkOnly := q.Get("check_only") != "" && q.Get("check_only") != "0"

	meta := admin.SourceFileMeta{BatchCode: batchCode}
	if deps.Repo != nil {
		if m, err := deps.Repo.LookupSourceFileMeta(r.Context(), recordID, historyID, batchCode); err == nil {
			meta = m
		}
	} else if ts, ok := admin.ParseBatchCodeTimestamp(batchCode); ok {
		meta.RefTimestamps = []int64{ts}
	}

	uploadDirs := []string{
		filepath.Join(deps.FeedbackRoot, "data", "uploads"),
		"/www/wwwroot/JF/feedback-git/feedback-v1/data/uploads",
		"/www/wwwroot/JF/feedback-v1/data/uploads",
	}

	match, found := admin.FindSourceFile(uploadDirs, origFileName, meta.StudentName, meta.RefTimestamps)
	if !found {
		baseOrig := filepath.Base(strings.ReplaceAll(origFileName, "\\", "/"))
		httpx.SendResponse(w, false, nil, httpx.StrPtr(fmt.Sprintf("未找到文件【%s】的上传原件（可能已超过30天自动清理期限）", baseOrig)), http.StatusNotFound)
		return
	}

	if checkOnly {
		httpx.SendResponse(w, true, map[string]any{
			"found":         true,
			"file_name":     match.BaseOrig,
			"archived_name": match.ArchivedName,
			"size":          match.Size,
			"uploaded_at":   tz.Unix(match.Timestamp, 0).Format("2006-01-02 15:04:05"),
		}, nil, http.StatusOK)
		return
	}

	data, err := os.ReadFile(match.Path)
	if err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("读取文件失败"), http.StatusInternalServerError)
		return
	}
	asciiFallback := reASCIIFallback.ReplaceAllString(match.BaseOrig, "_")
	if asciiFallback == "" || asciiFallback == "_" {
		asciiFallback = "source_file.csv"
	}
	encodedName := url.PathEscape(match.BaseOrig)

	w.Header().Set("Content-Description", "File Transfer")
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, asciiFallback, encodedName))
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
