package handler

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"feedback-api/internal/admin"
	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
	"feedback-api/internal/session"
)

func handleAdminDBTables(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	if _, ok := session.RequireAdmin(w, r, deps.Sessions); !ok {
		return
	}
	if deps.Repo == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("数据库连接失败"), http.StatusInternalServerError)
		return
	}
	tables, err := deps.Repo.ListTables(r.Context())
	if err != nil {
		writeAdminRepoError(w, err)
		return
	}
	httpx.SendResponse(w, true, map[string]any{"tables": tables}, nil, http.StatusOK)
}

func handleAdminDBSchema(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	if _, ok := session.RequireAdmin(w, r, deps.Sessions); !ok {
		return
	}
	if deps.Repo == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("数据库连接失败"), http.StatusInternalServerError)
		return
	}
	table := r.URL.Query().Get("table")
	pk, cols, err := deps.Repo.GetTableSchema(r.Context(), table)
	if err != nil {
		writeAdminRepoError(w, err)
		return
	}
	httpx.SendResponse(w, true, map[string]any{
		"table":       table,
		"primary_key": pk,
		"columns":     cols,
	}, nil, http.StatusOK)
}

func handleAdminDBBatchesOptions(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	if _, ok := session.RequireAdmin(w, r, deps.Sessions); !ok {
		return
	}
	if deps.Repo == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("数据库连接失败"), http.StatusInternalServerError)
		return
	}
	opts, err := deps.Repo.ListBatchOptions(r.Context())
	if err != nil {
		writeAdminRepoError(w, err)
		return
	}
	httpx.SendResponse(w, true, opts, nil, http.StatusOK)
}

func handleAdminDimensions(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	if _, ok := session.RequireAdmin(w, r, deps.Sessions); !ok {
		return
	}
	if deps.Repo == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("数据库连接失败"), http.StatusInternalServerError)
		return
	}
	opts, err := deps.Repo.GetFilterOptions(r.Context())
	if err != nil {
		writeAdminRepoError(w, err)
		return
	}
	httpx.SendResponse(w, true, opts, nil, http.StatusOK)
}

func handleAdminStudentRecordsStats(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	if _, ok := session.RequireAdmin(w, r, deps.Sessions); !ok {
		return
	}
	if deps.Repo == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("数据库连接失败"), http.StatusInternalServerError)
		return
	}
	st, err := deps.Repo.GetStudentRecordsStats(r.Context())
	if err != nil {
		writeAdminRepoError(w, err)
		return
	}
	httpx.SendResponse(w, true, st, nil, http.StatusOK)
}

func resolveRetestSecret(deps AdminDeps) string {
	if deps.ConfigLoader == nil {
		return ""
	}
	rt := deps.ConfigLoader.Load()
	s := strings.TrimSpace(rt.Secrets.RetestSecret)
	if s == "" {
		s = strings.TrimSpace(rt.RawString("retestSecret"))
	}
	if s == "" || s == "default_fallback_secret_please_change" || s == "your-secret-key-template-placeholder" {
		return ""
	}
	return s
}

func handleAdminGetRetestURL(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	if _, ok := session.RequireAdmin(w, r, deps.Sessions); !ok {
		return
	}
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if token == "" {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("缺少Token参数"), http.StatusBadRequest)
		return
	}
	secret := resolveRetestSecret(deps)
	if secret == "" {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("服务端密钥未配置，无法签发免密链接"), http.StatusInternalServerError)
		return
	}
	nowTs := deps.now().Unix()
	u, sig := admin.BuildRetestAdminURL(token, nowTs, secret)
	httpx.SendResponse(w, true, map[string]any{
		"url":       u,
		"admin_sig": sig,
		"admin_ts":  nowTs,
	}, nil, http.StatusOK)
}

func handleAdminSearchByToken(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	sess, ok := session.RequireAdmin(w, r, deps.Sessions)
	if !ok {
		return
	}
	rawInput := strings.TrimSpace(r.URL.Query().Get("token"))
	if rawInput == "" {
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, maxAdminJSONBodyBytes)
		}
		httpx.ParseRequestForm(r)
		if r.MultipartForm != nil {
			defer func() { _ = r.MultipartForm.RemoveAll() }()
		}
		rawInput = strings.TrimSpace(r.PostFormValue("token"))
	}
	if rawInput == "" {
		body, err := decodeAdminJSONBodyWithLimit(w, r, maxAdminJSONBodyBytes)
		if isMaxBytesError(err) {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("请求体大小超过限制"), http.StatusRequestEntityTooLarge)
			return
		}
		if err == nil {
			rawInput = strings.TrimSpace(config.AsPHPString(body["token"]))
		}
	}
	if rawInput == "" {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("请输入要查询的 Token 或错题本链接"), http.StatusBadRequest)
		return
	}

	token := admin.CleanTokenInput(rawInput)
	if token == "" {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("未能从输入中识别到有效的 Token 字符串"), http.StatusBadRequest)
		return
	}

	secret := resolveRetestSecret(deps)
	if secret == "" {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("服务端密钥未配置，无法签发免密链接"), http.StatusInternalServerError)
		return
	}

	res := admin.TokenSearchResult{
		Matches:    []map[string]any{},
		AccessLogs: []map[string]any{},
	}
	if deps.Repo != nil {
		if found, err := deps.Repo.SearchByToken(r.Context(), token, secret); err == nil {
			res = found
		}
	}

	adminAuditLog(r, deps, sess, "action", "token_search", map[string]any{
		"token":       token,
		"found":       len(res.Matches) > 0,
		"match_count": len(res.Matches),
	})

	httpx.SendResponse(w, true, map[string]any{
		"found":        len(res.Matches) > 0,
		"search_token": token,
		"raw_input":    rawInput,
		"matches":      res.Matches,
		"access_logs":  res.AccessLogs,
	}, nil, http.StatusOK)
}

func handleAdminRecordHistory(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	if _, ok := session.RequireAdmin(w, r, deps.Sessions); !ok {
		return
	}
	if deps.Repo == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("数据库连接失败"), http.StatusInternalServerError)
		return
	}
	q := r.URL.Query()
	recordID, _ := strconv.Atoi(q.Get("record_id"))
	studentName := strings.TrimSpace(q.Get("student_name"))
	batchID, _ := strconv.Atoi(q.Get("batch_id"))
	var weekNum *int
	if q.Has("week_num") {
		wVal, _ := strconv.Atoi(q.Get("week_num"))
		weekNum = &wVal
	}

	rows, err := deps.Repo.ListRecordHistory(r.Context(), recordID, studentName, batchID, weekNum)
	if err != nil {
		writeAdminRepoError(w, err)
		return
	}
	httpx.SendResponse(w, true, map[string]any{"history": rows}, nil, http.StatusOK)
}

func handleAdminRecordRollback(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
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
	historyID := config.AsPHPInt(rawInput["history_id"])
	if historyID <= 0 {
		historyID, _ = strconv.Atoi(r.URL.Query().Get("history_id"))
	}
	if historyID <= 0 {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("缺少历史版本ID"), http.StatusBadRequest)
		return
	}

	adminOp := sess.AdminUsername()
	if adminOp == "" {
		adminOp = sess.StringVal("admin_user")
	}
	if adminOp == "" {
		adminOp = "admin"
	}

	res, err := deps.Repo.RollbackRecord(r.Context(), historyID, adminOp)
	if err != nil {
		writeAdminRepoError(w, err)
		return
	}

	adminAuditLog(r, deps, sess, "action", "record_rollback_executed", map[string]any{
		"history_id":     res.HistoryID,
		"target_student": res.StudentName,
		"week_num":       res.WeekNum,
		"operator":       adminOp,
		"message":        fmt.Sprintf("管理员将学生 %s (第%d周) 的学情记录回溯至版本 #%d", res.StudentName, res.WeekNum, res.HistoryID),
	})

	httpx.SendResponse(w, true, map[string]any{
		"message": fmt.Sprintf("已成功将学生 %s 的记录回溯至历史版本 #%d", res.StudentName, res.HistoryID),
	}, nil, http.StatusOK)
}
