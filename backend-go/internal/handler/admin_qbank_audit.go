package handler

import (
	"net/http"
	"strconv"
	"strings"

	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
	"feedback-api/internal/normalize"
	"feedback-api/internal/qbank"
	"feedback-api/internal/qbankattest"
	"feedback-api/internal/session"
)

func parseOptionalPositiveInt(raw string) *int {
	s := strings.TrimSpace(raw)
	if s == "" || s == "0" || strings.EqualFold(s, "all") {
		return nil
	}
	v, err := strconv.Atoi(s)
	if err != nil || v <= 0 {
		return nil
	}
	return &v
}

func normalizeAuditFilterStr(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" || strings.EqualFold(s, "all") {
		return ""
	}
	return s
}

func normalizeAuditSeason(raw string) string {
	s := normalizeAuditFilterStr(raw)
	if s == "" || s == "0" {
		return ""
	}
	return normalize.Season(s, s)
}

func normalizeAuditBankType(q interface{ Get(string) string }) string {
	bt := normalizeAuditFilterStr(q.Get("bank_type"))
	if bt == "" {
		bt = normalizeAuditFilterStr(q.Get("bankType"))
	}
	if bt == "" {
		return ""
	}
	return qbank.NormalizeBankType(bt)
}

func handleAdminQBankTimeline(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	if r.Method != http.MethodGet {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("只支持 GET 请求"), http.StatusMethodNotAllowed)
		return
	}
	if _, ok := session.RequireAdmin(w, r, deps.Sessions); !ok {
		return
	}
	if deps.Attest == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("题库存证服务未配置"), http.StatusInternalServerError)
		return
	}

	q := r.URL.Query()
	page := config.AsPHPInt(q.Get("page"))
	pageSize := config.AsPHPInt(q.Get("page_size"))
	if pageSize <= 0 {
		pageSize = config.AsPHPInt(q.Get("per_page"))
	}

	res, err := deps.Attest.ListTimeline(r.Context(), qbankattest.TimelineFilter{
		Operator:  strings.TrimSpace(q.Get("operator")),
		BankType:  normalizeAuditBankType(q),
		Subject:   normalizeAuditFilterStr(q.Get("subject")),
		Grade:     normalizeAuditFilterStr(q.Get("grade")),
		Tier:      normalizeAuditFilterStr(q.Get("tier")),
		Week:      parseOptionalPositiveInt(q.Get("week")),
		Year:      parseOptionalPositiveInt(q.Get("year")),
		Season:    normalizeAuditSeason(q.Get("season")),
		EventType: strings.TrimSpace(q.Get("event_type")),
		DateFrom:  strings.TrimSpace(q.Get("date_from")),
		DateTo:    strings.TrimSpace(q.Get("date_to")),
		Page:      page,
		PageSize:  pageSize,
	})
	if err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("查询教师操作复盘时间线失败"), http.StatusInternalServerError)
		return
	}
	if res == nil {
		res = &qbankattest.TimelineResult{Items: []qbankattest.TimelineItem{}, Page: 1, PageSize: 20}
	}
	if res.Items == nil {
		res.Items = []qbankattest.TimelineItem{}
	}
	httpx.SendResponse(w, true, res, nil, http.StatusOK)
}

func handleAdminQBankMatrix(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	if r.Method != http.MethodGet {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("只支持 GET 请求"), http.StatusMethodNotAllowed)
		return
	}
	if _, ok := session.RequireAdmin(w, r, deps.Sessions); !ok {
		return
	}
	if deps.Attest == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("题库存证服务未配置"), http.StatusInternalServerError)
		return
	}

	q := r.URL.Query()
	items, err := deps.Attest.ListMatrix(r.Context(), qbankattest.MatrixFilter{
		Year:     parseOptionalPositiveInt(q.Get("year")),
		Season:   normalizeAuditSeason(q.Get("season")),
		BankType: normalizeAuditBankType(q),
		Subject:  normalizeAuditFilterStr(q.Get("subject")),
		Grade:    normalizeAuditFilterStr(q.Get("grade")),
		Tier:     normalizeAuditFilterStr(q.Get("tier")),
		Search:   strings.TrimSpace(q.Get("search")),
	})
	if err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("查询配置回执总览失败"), http.StatusInternalServerError)
		return
	}
	if items == nil {
		items = []qbankattest.MatrixItem{}
	}
	httpx.SendResponse(w, true, map[string]any{
		"items": items,
		"total": len(items),
	}, nil, http.StatusOK)
}

func handleAdminQBankRevisions(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	if r.Method != http.MethodGet {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("只支持 GET 请求"), http.StatusMethodNotAllowed)
		return
	}
	if _, ok := session.RequireAdmin(w, r, deps.Sessions); !ok {
		return
	}
	if deps.Attest == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("题库存证服务未配置"), http.StatusInternalServerError)
		return
	}

	q := r.URL.Query()
	items, err := deps.Attest.ListRevisions(r.Context(), qbankattest.RevisionFilter{
		BankType: normalizeAuditBankType(q),
		Year:     parseOptionalPositiveInt(q.Get("year")),
		Season:   normalizeAuditSeason(q.Get("season")),
		Subject:  normalizeAuditFilterStr(q.Get("subject")),
		Grade:    normalizeAuditFilterStr(q.Get("grade")),
		Tier:     normalizeAuditFilterStr(q.Get("tier")),
		Week:     parseOptionalPositiveInt(q.Get("week")),
		Operator: strings.TrimSpace(q.Get("operator")),
		Limit:    config.AsPHPInt(q.Get("limit")),
	})
	if err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("查询历史存证版本链失败"), http.StatusInternalServerError)
		return
	}
	if items == nil {
		items = []qbankattest.RevisionItem{}
	}
	httpx.SendResponse(w, true, map[string]any{
		"items": items,
		"total": len(items),
	}, nil, http.StatusOK)
}

func handleAdminQBankRollback(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	if r.Method != http.MethodPost {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("只支持 POST 请求"), http.StatusMethodNotAllowed)
		return
	}
	adminSess, ok := session.RequireAdmin(w, r, deps.Sessions)
	if !ok {
		return
	}
	if deps.Repo == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("后台服务未初始化"), http.StatusInternalServerError)
		return
	}

	receiptCode := strings.TrimSpace(r.URL.Query().Get("receipt_code"))
	if receiptCode == "" {
		if body, err := decodeAdminJSONBody(r); err == nil {
			if raw, exists := body["receipt_code"]; exists && raw != nil {
				if s, isStr := raw.(string); isStr {
					receiptCode = strings.TrimSpace(s)
				}
			}
		}
	}
	if receiptCode == "" {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("请提供目标存证回执编号 (receipt_code)"), http.StatusBadRequest)
		return
	}

	adminUser := adminSess.AdminUsername()
	if adminUser == "" {
		adminUser = "admin"
	}
	res, err := deps.Repo.RollbackQBankRevision(r.Context(), receiptCode, adminUser, adminUser, httpx.GetClientIP(r))
	if err != nil {
		writeAdminRepoError(w, err)
		return
	}

	adminAuditLog(r, deps, adminSess, "action", "qbank_rollback", map[string]any{
		"target_receipt_code": res.TargetReceiptCode,
		"target_revision_no":  res.TargetRevisionNo,
		"new_receipt_code":    res.NewReceiptCode,
		"new_revision_no":     res.NewRevisionNo,
		"restored_count":      res.RestoredCount,
	})
	httpx.SendResponse(w, true, res, nil, http.StatusOK)
}

func handleAdminQBankAnchors(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	if r.Method != http.MethodGet {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("只支持 GET 请求"), http.StatusMethodNotAllowed)
		return
	}
	if _, ok := session.RequireAdmin(w, r, deps.Sessions); !ok {
		return
	}
	if deps.Attest == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("题库存证服务未配置"), http.StatusInternalServerError)
		return
	}

	limit := config.AsPHPInt(r.URL.Query().Get("limit"))
	items, err := deps.Attest.ListAnchors(r.Context(), limit)
	if err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("查询外部时间锚定记录失败"), http.StatusInternalServerError)
		return
	}
	if items == nil {
		items = []qbankattest.AnchorRecord{}
	}
	httpx.SendResponse(w, true, map[string]any{
		"items": items,
		"total": len(items),
	}, nil, http.StatusOK)
}

func handleAdminQBankAnchorNow(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	if r.Method != http.MethodPost {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("只支持 POST 请求"), http.StatusMethodNotAllowed)
		return
	}
	adminSess, ok := session.RequireAdmin(w, r, deps.Sessions)
	if !ok {
		return
	}
	if deps.Attest == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("题库存证服务未配置"), http.StatusInternalServerError)
		return
	}

	anc, err := deps.Attest.AnchorUnanchoredRevisions(r.Context(), qbankattest.NewTSAClientFromEnv())
	if err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("执行外部可信时间锚定失败"), http.StatusInternalServerError)
		return
	}
	if anc == nil {
		httpx.SendResponse(w, true, map[string]any{
			"anchored": false,
			"message":  "当前没有新增未锚定的存证版本",
		}, nil, http.StatusOK)
		return
	}

	adminAuditLog(r, deps, adminSess, "action", "qbank_anchor_now", map[string]any{
		"anchor_code":    anc.AnchorCode,
		"seq_from":       anc.SeqFrom,
		"seq_to":         anc.SeqTo,
		"revision_count": anc.RevisionCount,
		"merkle_root":    anc.MerkleRoot,
		"tsa_status":     anc.TSAStatus,
	})
	httpx.SendResponse(w, true, map[string]any{
		"anchored": true,
		"anchor":   anc,
	}, nil, http.StatusOK)
}
