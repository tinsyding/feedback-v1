package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

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

func makeTinyPNGBytes(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestLogsSenderSyncSnapshotPullFiltersStatsAndSecurityHardening(t *testing.T) {
	root := t.TempDir()
	t.Setenv("SENDER_API_TOKEN", "sender-tok-1")
	loader := config.NewLoader(root, "")
	ctrl := senderctrl.NewStore(root, loader)
	mgr := senderlogs.NewManager(root, ctrl)
	sessStore := session.NewMemoryStore()
	repo := &mockSysLogsRepo{}
	fixedNow := time.Date(2026, 11, 21, 16, 0, 0, 0, time.UTC) // 2026-11-22 00:00:00 Asia/Shanghai

	h := httpx.Middleware(Logs(LogsDeps{
		Repo:         repo,
		Sessions:     sessStore,
		ConfigLoader: loader,
		Audit:        auditlog.NoopLogger{},
		SenderCtrl:   ctrl,
		SenderLogs:   mgr,
		Limiter:      syslogs.NewIngestLimiter(),
		NowFunc:      func() time.Time { return fixedNow },
	}))

	// 1. Bogus PHPSESSID rotation must NOT bypass 30/min guest rate limit on action=log
	for i := 0; i < 30; i++ {
		req := httptest.NewRequest(http.MethodPost, "/api/logs.php?action=log",
			strings.NewReader(`{"level":"action","module":"viewer","event":"open","timestamp":"Inf"}`))
		req.RemoteAddr = "198.51.100.77:5555"
		req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: fmt.Sprintf("bogus_cookie_%04d_1234567890", i)})
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("guest log #%d status = %d, want 200", i+1, rec.Code)
		}
	}
	req31 := httptest.NewRequest(http.MethodPost, "/api/logs.php?action=log",
		strings.NewReader(`{"level":"action","module":"viewer","event":"open"}`))
	req31.RemoteAddr = "198.51.100.77:5555"
	req31.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: "bogus_cookie_0031_1234567890"})
	rec31 := httptest.NewRecorder()
	h.ServeHTTP(rec31, req31)
	if rec31.Code != http.StatusTooManyRequests {
		t.Fatalf("31st guest request with rotating bogus PHPSESSID got %d, want 429", rec31.Code)
	}
	// Verify "Inf" timestamp fell back cleanly to Asia/Shanghai now
	if len(repo.inserted) != 30 || repo.inserted[0].CreatedAt != "2026-11-22 00:00:00" {
		t.Fatalf("expected Inf timestamp fallback to 2026-11-22 00:00:00, got %+v", repo.inserted[0].CreatedAt)
	}

	// 2. sender_sync: heartbeat, chunk, batch_summary, realtime (with NaN timestamp)
	for _, body := range []string{
		`{"token":"sender-tok-1","sync_mode":"heartbeat","client":{"client_slug":"pc-alpha","hostname":"Alpha","os_user":"t1"}}`,
		`{"token":"sender-tok-1","sync_mode":"chunk","date_str":"2026-11-22","offset":0,"content":"hello\n","client":{"client_slug":"pc-alpha"}}`,
		`{"token":"sender-tok-1","sync_mode":"batch_summary","batch_summary":{"date_str":"2026-11-22","counts":{"total":2,"sent":2}},"client":{"client_slug":"pc-alpha"}}`,
		`{"token":"sender-tok-1","sync_mode":"realtime","client":{"client_slug":"pc-alpha"},"entries":[{"date_str":"2026-11-22","event":"sent","timestamp":"NaN","raw_line":"row1","is_error":true},{"date_str":"2026-11-22","event":"sent2","timestamp":"1795200000000","raw_line":"row2","is_error":true}]}`,
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/logs.php?action=sender_sync", strings.NewReader(body))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"success":true`) {
			t.Fatalf("sender_sync failed: body=%s resp=%s", body, rec.Body.String())
		}
	}

	// 3. sender_snapshot: invalid non-empty header token rejected before body parsing, >12MB returns 413, valid PNG succeeds
	reqBadHdr := httptest.NewRequest(http.MethodPost, "/api/logs.php?action=sender_snapshot", strings.NewReader("not-even-multipart"))
	reqBadHdr.Header.Set("X-Sender-Token", "wrong-header-tok")
	recBadHdr := httptest.NewRecorder()
	h.ServeHTTP(recBadHdr, reqBadHdr)
	if recBadHdr.Code != http.StatusOK || !strings.Contains(recBadHdr.Body.String(), "发送器鉴权失败") {
		t.Fatalf("expected early auth failure on bad header token, got code=%d body=%s", recBadHdr.Code, recBadHdr.Body.String())
	}

	oversized := "--abc\r\nContent-Disposition: form-data; name=\"image_title\"; filename=\"big.png\"\r\nContent-Type: image/png\r\n\r\n" +
		strings.Repeat("x", (12<<20)+100) + "\r\n--abc--\r\n"
	reqOver := httptest.NewRequest(http.MethodPost, "/api/logs.php?action=sender_snapshot", strings.NewReader(oversized))
	reqOver.ContentLength = -1 // exercise streaming MaxBytesReader path too
	reqOver.Header.Set("Content-Type", "multipart/form-data; boundary=abc")
	recOver := httptest.NewRecorder()
	h.ServeHTTP(recOver, reqOver)
	if recOver.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized snapshot got %d, want 413 (body=%s)", recOver.Code, recOver.Body.String())
	}

	var snapBuf bytes.Buffer
	mw := multipart.NewWriter(&snapBuf)
	_ = mw.WriteField("token", "sender-tok-1")
	_ = mw.WriteField("client_json", `{"client_slug":"pc-alpha","hostname":"Alpha"}`)
	_ = mw.WriteField("meta_json", `{"timestamp":"20261122_000000","target_id":"101","target_name":"张三"}`)
	fw, _ := mw.CreateFormFile("image_title", "title.png")
	_, _ = fw.Write(makeTinyPNGBytes(t))
	_ = mw.Close()

	reqSnap := httptest.NewRequest(http.MethodPost, "/api/logs.php?action=sender_snapshot", &snapBuf)
	reqSnap.Header.Set("Content-Type", mw.FormDataContentType())
	recSnap := httptest.NewRecorder()
	h.ServeHTTP(recSnap, reqSnap)
	if recSnap.Code != http.StatusOK || !strings.Contains(recSnap.Body.String(), `"success":true`) {
		t.Fatalf("valid snapshot failed: code=%d body=%s", recSnap.Code, recSnap.Body.String())
	}

	// 4. sender_control_pull POST supports application/x-www-form-urlencoded token
	form := url.Values{}
	form.Set("token", "sender-tok-1")
	form.Set("client_slug", "pc-alpha")
	reqPullForm := httptest.NewRequest(http.MethodPost, "/api/logs.php?action=sender_control_pull", strings.NewReader(form.Encode()))
	reqPullForm.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	recPullForm := httptest.NewRecorder()
	h.ServeHTTP(recPullForm, reqPullForm)
	if recPullForm.Code != http.StatusOK || !strings.Contains(recPullForm.Body.String(), `"success":true`) {
		t.Fatalf("form sender_control_pull failed: code=%d body=%s", recPullForm.Code, recPullForm.Body.String())
	}

	// 5. Admin endpoints: sender_client_override ("api"/"always"), filters, stats
	adminSID := "dddd1111eeee2222ffff3333aaaa4444"
	sessStore.Set(adminSID, map[string]any{"admin_logged_in": true, "admin_username": "admin"})

	reqOv := httptest.NewRequest(http.MethodPost, "/api/logs.php?action=sender_client_override",
		strings.NewReader(`{"client_slug":"pc-alpha","overrides":{"verifyMode":"api","snapshotPolicy":"always"},"note":"云控测试"}`))
	reqOv.Host = "feedback.wxjifang.cn"
	reqOv.Header.Set("Origin", "https://feedback.wxjifang.cn")
	reqOv.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: adminSID})
	recOv := httptest.NewRecorder()
	h.ServeHTTP(recOv, reqOv)
	if recOv.Code != http.StatusOK || !strings.Contains(recOv.Body.String(), `"verifyMode":"api"`) || !strings.Contains(recOv.Body.String(), `"snapshotPolicy":"always"`) {
		t.Fatalf("sender_client_override failed: code=%d body=%s", recOv.Code, recOv.Body.String())
	}

	for _, action := range []string{"filters", "stats"} {
		reqGet := httptest.NewRequest(http.MethodGet, "/api/logs.php?action="+action, nil)
		reqGet.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: adminSID})
		recGet := httptest.NewRecorder()
		h.ServeHTTP(recGet, reqGet)
		if recGet.Code != http.StatusOK || !strings.Contains(recGet.Body.String(), `"success":true`) {
			t.Fatalf("GET %s failed: code=%d body=%s", action, recGet.Code, recGet.Body.String())
		}
	}
}
