package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"feedback-api/internal/auditlog"
	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
	"feedback-api/internal/senderctrl"
	"feedback-api/internal/senderlogs"
	"feedback-api/internal/session"
	"feedback-api/internal/syslogs"
)

type mockSysLogsRepo struct {
	inserted []syslogs.LogRecord
	export   []syslogs.ExportRow
	deleted  int64
}

func (m *mockSysLogsRepo) InsertBatch(_ context.Context, entries []syslogs.LogRecord) error {
	m.inserted = append(m.inserted, entries...)
	return nil
}

func (m *mockSysLogsRepo) List(_ context.Context, _ syslogs.ListFilter) (*syslogs.ListResult, error) {
	return &syslogs.ListResult{
		Logs:       m.inserted,
		Pagination: map[string]any{"page": 1, "perPage": 20, "total": len(m.inserted), "totalPages": 1},
		Stats:      map[string]any{"total": len(m.inserted)},
		Dates:      []string{"2026-11-21"},
	}, nil
}

func (m *mockSysLogsRepo) Filters(_ context.Context) (*syslogs.FiltersResult, error) {
	return &syslogs.FiltersResult{
		Modules: []string{"viewer", "sender_py"},
		Events:  []string{"open"},
		IPs:     []string{"127.0.0.1"},
		Levels:  []string{"error", "warn", "action", "info"},
		Dates:   []string{"2026-11-21"},
	}, nil
}

func (m *mockSysLogsRepo) ExportRows(_ context.Context, _ syslogs.ListFilter, _ int) ([]syslogs.ExportRow, error) {
	return m.export, nil
}

func (m *mockSysLogsRepo) Stats(_ context.Context) (*syslogs.StatsResult, error) {
	return &syslogs.StatsResult{
		Dates:         []string{"2026-11-21"},
		DailyStats:    []syslogs.DailyStat{{Date: "2026-11-21", Total: 3, Action: 3}},
		RetentionDays: 30,
	}, nil
}

func (m *mockSysLogsRepo) DeleteByDate(_ context.Context, _ string) (int64, error) {
	return m.deleted, nil
}

func (m *mockSysLogsRepo) DeleteByID(_ context.Context, _ string) (int64, error) {
	return 1, nil
}

func TestLogsIngestAdminListExportAndDelete(t *testing.T) {
	root := t.TempDir()
	loader := config.NewLoader(root, "")
	ctrl := senderctrl.NewStore(root, loader)
	mgr := senderlogs.NewManager(root, ctrl)
	sessStore := session.NewMemoryStore()
	repo := &mockSysLogsRepo{
		export: []syslogs.ExportRow{
			{CreatedAt: "2026-11-21 10:00:00", Level: "action", Module: "viewer", Event: "open", Operator: "t101", Details: map[string]any{"message": "ok"}},
		},
		deleted: 5,
	}

	h := httpx.Middleware(Logs(LogsDeps{
		Repo:         repo,
		Sessions:     sessStore,
		ConfigLoader: loader,
		Audit:        auditlog.NoopLogger{},
		SenderCtrl:   ctrl,
		SenderLogs:   mgr,
		Limiter:      syslogs.NewIngestLimiter(),
	}))

	// 1. Oversized POST log -> 413
	bigBody := `{"a":"` + strings.Repeat("x", 66000) + `"}`
	reqBig := httptest.NewRequest(http.MethodPost, "/api/logs.php?action=log", strings.NewReader(bigBody))
	recBig := httptest.NewRecorder()
	h.ServeHTTP(recBig, reqBig)
	if recBig.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized log status = %d, want 413", recBig.Code)
	}

	// 2. Valid POST log -> 200
	reqLog := httptest.NewRequest(http.MethodPost, "/api/logs.php?action=log",
		strings.NewReader(`{"entries":[{"level":"action","module":"viewer","event":"open","details":{"message":"hi"}}]}`))
	reqLog.RemoteAddr = "203.0.113.50:1234"
	recLog := httptest.NewRecorder()
	h.ServeHTTP(recLog, reqLog)
	if recLog.Code != http.StatusOK || len(repo.inserted) != 1 {
		t.Fatalf("valid POST log failed: code=%d inserted=%d body=%s", recLog.Code, len(repo.inserted), recLog.Body.String())
	}

	// 3. Unauth GET list -> 401
	reqUnauth := httptest.NewRequest(http.MethodGet, "/api/logs.php?action=list", nil)
	recUnauth := httptest.NewRecorder()
	h.ServeHTTP(recUnauth, reqUnauth)
	if recUnauth.Code != http.StatusUnauthorized {
		t.Fatalf("unauth list status = %d, want 401", recUnauth.Code)
	}

	// 4. Admin export CSV returns UTF-8 BOM + CSV content-type
	adminSID := "aaaa1111bbbb2222cccc3333dddd4444"
	sessStore.Set(adminSID, map[string]any{"admin_logged_in": true, "admin_username": "admin"})

	reqExp := httptest.NewRequest(http.MethodGet, "/api/logs.php?action=export", nil)
	reqExp.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: adminSID})
	recExp := httptest.NewRecorder()
	h.ServeHTTP(recExp, reqExp)
	if recExp.Code != http.StatusOK || !strings.HasPrefix(recExp.Header().Get("Content-Type"), "text/csv") {
		t.Fatalf("export invalid: code=%d ct=%q", recExp.Code, recExp.Header().Get("Content-Type"))
	}
	if !strings.Contains(recExp.Body.String(), "操作") {
		t.Fatalf("expected CSV to contain Chinese level label, got: %s", recExp.Body.String())
	}

	// 5. Admin DELETE clear by date
	reqDel := httptest.NewRequest(http.MethodDelete, "/api/logs.php?action=clear&date=2026-11-21", nil)
	reqDel.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: adminSID})
	recDel := httptest.NewRecorder()
	h.ServeHTTP(recDel, reqDel)
	if recDel.Code != http.StatusOK {
		t.Fatalf("DELETE clear status = %d", recDel.Code)
	}
}

func TestLogsSenderControlAndStrictCSRF(t *testing.T) {
	root := t.TempDir()
	t.Setenv("SENDER_API_TOKEN", "custom-sender-tok")
	loader := config.NewLoader(root, "")
	ctrl := senderctrl.NewStore(root, loader)
	mgr := senderlogs.NewManager(root, ctrl)
	sessStore := session.NewMemoryStore()
	adminSID := "bbbb1111cccc2222dddd3333eeee4444"
	sessStore.Set(adminSID, map[string]any{"admin_logged_in": true, "admin_username": "admin"})

	h := httpx.Middleware(Logs(LogsDeps{
		Repo:         &mockSysLogsRepo{},
		Sessions:     sessStore,
		ConfigLoader: loader,
		Audit:        auditlog.NoopLogger{},
		SenderCtrl:   ctrl,
		SenderLogs:   mgr,
	}))

	// 1. Strict CSRF rejects cross-subdomain on sender_client_command
	reqBadCSRF := httptest.NewRequest(http.MethodPost, "/api/logs.php?action=sender_client_command",
		strings.NewReader(`{"client_slug":"pc1","type":"sync_logs"}`))
	reqBadCSRF.Host = "feedback.wxjifang.cn"
	reqBadCSRF.Header.Set("Origin", "https://vip.wxjifang.cn")
	reqBadCSRF.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: adminSID})
	recBadCSRF := httptest.NewRecorder()
	h.ServeHTTP(recBadCSRF, reqBadCSRF)
	if recBadCSRF.Code != http.StatusForbidden {
		t.Fatalf("cross-subdomain strict CSRF status = %d, want 403", recBadCSRF.Code)
	}

	// 2. Same-host admin enqueues command
	reqCmd := httptest.NewRequest(http.MethodPost, "/api/logs.php?action=sender_client_command",
		strings.NewReader(`{"client_slug":"pc1","type":"sync_logs"}`))
	reqCmd.Host = "feedback.wxjifang.cn"
	reqCmd.Header.Set("Origin", "https://feedback.wxjifang.cn")
	reqCmd.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: adminSID})
	recCmd := httptest.NewRecorder()
	h.ServeHTTP(recCmd, reqCmd)
	if recCmd.Code != http.StatusOK {
		t.Fatalf("enqueue command status = %d, want 200 (body=%s)", recCmd.Code, recCmd.Body.String())
	}

	// 3. Sender pulls control with valid token and receives pending command
	reqPull := httptest.NewRequest(http.MethodGet, "/api/logs.php?action=sender_control_pull&client_slug=pc1&token=custom-sender-tok", nil)
	recPull := httptest.NewRecorder()
	h.ServeHTTP(recPull, reqPull)
	if recPull.Code != http.StatusOK {
		t.Fatalf("pull status = %d", recPull.Code)
	}
	var env struct {
		Success bool `json:"success"`
		Data    struct {
			CloudControl struct {
				PendingCommands []map[string]any `json:"pending_commands"`
			} `json:"cloud_control"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recPull.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	if !env.Success || len(env.Data.CloudControl.PendingCommands) != 1 {
		t.Fatalf("expected 1 pending command, got %+v", env)
	}
}
