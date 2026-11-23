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
