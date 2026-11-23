package handler

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"

	"feedback-api/internal/admin"
	"feedback-api/internal/auditlog"
	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
	"feedback-api/internal/qbankattest"
	"feedback-api/internal/ratelimit"
	"feedback-api/internal/session"
)

type fakeAdminRepo struct {
	admins          map[string]*admin.AdminUser
	updatedHashes   map[int]string
	fallbackUpserts map[string]string
	lastLoginIPs    map[string]string
	tables          []admin.TableSummary
	deleteErr       error
	rollbackRes     admin.RollbackResult
	resetRes        admin.ResetTeacherResult
	tokenRes        admin.TokenSearchResult
	listRes         admin.ListResult
	getRow          map[string]any
	createdID       int64
	updatedAffected int64
	deletedCount    int64
	lastListQuery   admin.ListQuery
	lastCreateTable string
	lastCreateInput map[string]any
	lastUpdateTable string
	lastUpdateID    string
	lastUpdateInput map[string]any
	lastResetUserID int
	lastResetPwd    string
}

func newFakeAdminRepo() *fakeAdminRepo {
	hash, _ := bcrypt.GenerateFromPassword([]byte("AdminPass123"), bcrypt.MinCost)
	shaSum := sha256.Sum256([]byte("LegacyPass123"))
	return &fakeAdminRepo{
		admins: map[string]*admin.AdminUser{
			"admin": {
				ID:           1,
				Username:     "admin",
				PasswordHash: string(hash),
				RealName:     "超级管理员",
				Role:         "super_admin",
				Status:       1,
			},
			"legacy": {
				ID:           2,
				Username:     "legacy",
				PasswordHash: hex.EncodeToString(shaSum[:]),
				RealName:     "旧版管理员",
				Role:         "admin",
				Status:       1,
			},
			"disabled": {
				ID:           3,
				Username:     "disabled",
				PasswordHash: string(hash),
				RealName:     "禁用管理员",
				Role:         "admin",
				Status:       0,
			},
		},
		updatedHashes:   map[int]string{},
		fallbackUpserts: map[string]string{},
		lastLoginIPs:    map[string]string{},
		tables: []admin.TableSummary{
			{Name: "student_records", FriendlyName: "学生学情错题", Count: 10, Rows: 10},
		},
		rollbackRes: admin.RollbackResult{
			HistoryID:      77,
			TargetRecordID: 12,
			StudentName:    "张三",
			WeekNum:        3,
		},
		resetRes: admin.ResetTeacherResult{Username: "t1", RealName: "王老师"},
		tokenRes: admin.TokenSearchResult{
			Matches:    []map[string]any{{"record_id": 12, "token": "abc1234567", "student_name": "张三"}},
			AccessLogs: []map[string]any{{"id": 1, "action": "view"}},
		},
		listRes: admin.ListResult{
			Table:      "student_records",
			PrimaryKey: "id",
			Page:       1,
			PageSize:   20,
			PerPage:    20,
			Total:      1,
			TotalPages: 1,
			TotalPgs:   1,
			Rows:       []map[string]any{{"id": 12, "student_name": "张三"}},
			Records:    []map[string]any{{"id": 12, "student_name": "张三"}},
		},
		getRow:          map[string]any{"id": 12, "student_name": "张三"},
		createdID:       99,
		updatedAffected: 1,
		deletedCount:    1,
	}
}

func (f *fakeAdminRepo) FindAdminByUsername(_ context.Context, username string) (*admin.AdminUser, error) {
	u, ok := f.admins[username]
	if !ok {
		return nil, nil
	}
	cp := *u
	return &cp, nil
}
func (f *fakeAdminRepo) UpdateAdminPasswordHash(_ context.Context, id int, newHash string) error {
	f.updatedHashes[id] = newHash
	for _, u := range f.admins {
		if u.ID == id {
			u.PasswordHash = newHash
		}
	}
	return nil
}
func (f *fakeAdminRepo) UpsertFallbackAdmin(_ context.Context, username, newHash string) error {
	f.fallbackUpserts[username] = newHash
	return nil
}
func (f *fakeAdminRepo) UpdateAdminLastLogin(_ context.Context, username, ip string) error {
	f.lastLoginIPs[username] = ip
	return nil
}
func (f *fakeAdminRepo) ListTables(_ context.Context) ([]admin.TableSummary, error) {
	return f.tables, nil
}
func (f *fakeAdminRepo) GetTableSchema(_ context.Context, table string) (string, []admin.ColumnMeta, error) {
	if admin.IsHiddenTable(table) {
		return "", nil, admin.NewHTTPError(403, "系统表禁止访问", nil)
	}
	return "id", []admin.ColumnMeta{{Field: "id", Name: "id", Type: "int", Key: "PRI"}}, nil
}
func (f *fakeAdminRepo) ListBatchOptions(_ context.Context) ([]admin.BatchOption, error) {
	return []admin.BatchOption{{ID: 1, Label: "#1 2026春 七年级U 数学"}}, nil
}
func (f *fakeAdminRepo) GetFilterOptions(_ context.Context) (admin.FilterOptions, error) {
	return admin.FilterOptions{Grades: []string{"七年级"}, Tiers: []string{"U"}, Subjects: []string{"数学"}}, nil
}
func (f *fakeAdminRepo) GetStudentRecordsStats(_ context.Context) (admin.StudentRecordsStats, error) {
	return admin.StudentRecordsStats{Total: 10, HasErr: 8, NoErr: 2, Batches: 2, Students: 9}, nil
}
func (f *fakeAdminRepo) ListRecords(_ context.Context, q admin.ListQuery) (admin.ListResult, error) {
	f.lastListQuery = q
	return f.listRes, nil
}
func (f *fakeAdminRepo) GetRecord(_ context.Context, _, _ string) (map[string]any, error) {
	return f.getRow, nil
}
func (f *fakeAdminRepo) CreateRecord(_ context.Context, table string, input map[string]any, _, _ string) (int64, error) {
	f.lastCreateTable = table
	f.lastCreateInput = input
	return f.createdID, nil
}
func (f *fakeAdminRepo) UpdateRecord(_ context.Context, table, id string, input map[string]any, _ string) (int64, []string, error) {
	f.lastUpdateTable = table
	f.lastUpdateID = id
	f.lastUpdateInput = input
	var fields []string
	for k := range input {
		fields = append(fields, k)
	}
	return f.updatedAffected, fields, nil
}
func (f *fakeAdminRepo) DeleteRecords(_ context.Context, table string, _ []string, _ string, forceCascade bool) (int64, error) {
	if f.deleteErr != nil {
		return 0, f.deleteErr
	}
	if table == "class_batches" && !forceCascade {
		return 0, admin.NewHTTPError(409, "关联学情记录", map[string]any{"related_student_records": 5})
	}
	return f.deletedCount, nil
}
func (f *fakeAdminRepo) ResetTeacherPassword(_ context.Context, uid int, _, pwd string) (admin.ResetTeacherResult, error) {
	f.lastResetUserID = uid
	f.lastResetPwd = pwd
	return f.resetRes, nil
}
func (f *fakeAdminRepo) ListRecordHistory(_ context.Context, _ int, _ string, _ int, _ *int) ([]map[string]any, error) {
	return []map[string]any{{"id": 77, "student_name": "张三"}}, nil
}
func (f *fakeAdminRepo) RollbackRecord(_ context.Context, _ int, _ string) (admin.RollbackResult, error) {
	return f.rollbackRes, nil
}
func (f *fakeAdminRepo) RollbackQBankRevision(_ context.Context, code, _, _, _ string) (admin.QBankRollbackResult, error) {
	return admin.QBankRollbackResult{
		TargetReceiptCode: code,
		TargetRevisionNo:  1,
		NewReceiptCode:    "QB-2026-MOCK-ROLLBACK",
		NewRevisionNo:     2,
		RestoredCount:     3,
		Year:              2026,
		Season:            "spring",
		BankType:          "weekly",
		Subject:           "物理",
		Grade:             "高一",
		Tier:              "实验班",
		Week:              1,
	}, nil
}
func (f *fakeAdminRepo) SearchByToken(_ context.Context, _, _ string) (admin.TokenSearchResult, error) {
	return f.tokenRes, nil
}
func (f *fakeAdminRepo) LookupSourceFileMeta(_ context.Context, _, _ int, batchCode string) (admin.SourceFileMeta, error) {
	return admin.SourceFileMeta{BatchCode: batchCode, StudentName: "张三"}, nil
}

func setupAdminTestEnv(t *testing.T) (http.Handler, *fakeAdminRepo, *session.MemoryStore, auditlog.Logger, string) {
	t.Helper()
	dir := t.TempDir()
	cfgData := `{"semesterYear":2026,"defaultSeason":"spring","retestSecret":"test_retest_secret_2026","dashscopeApiKey":"sk-legacy-plaintext-123456"}`
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(cfgData), 0o644); err != nil {
		t.Fatal(err)
	}
	repo := newFakeAdminRepo()
	sessions := session.NewMemoryStore()
	audit := auditlog.NewDualLogger(nil, dir)
	deps := AdminDeps{
		Repo:         repo,
		Sessions:     sessions,
		RateLimit:    ratelimit.NewMemoryStore(),
		ConfigLoader: config.NewLoader(dir, ""),
		Audit:        audit,
		FeedbackRoot: dir,
		NowFunc:      func() time.Time { return time.Unix(1795143600, 0) },
	}
	return httpx.Middleware(Admin(deps)), repo, sessions, audit, dir
}

func addAdminCookie(t *testing.T, sessions *session.MemoryStore, extra map[string]any) *http.Cookie {
	t.Helper()
	data := map[string]any{
		"admin_logged_in": true,
		"admin_username":  "admin",
		"admin_realname":  "超级管理员",
		"admin_role":      "super_admin",
		"login_time":      1795143600,
	}
	for k, v := range extra {
		data[k] = v
	}
	sess := &session.Session{ID: "admin_sess_1234567890abcdef", Data: data}
	if err := sessions.Save(context.Background(), sess); err != nil {
		t.Fatal(err)
	}
	return &http.Cookie{Name: "PHPSESSID", Value: sess.ID}
}

func TestAdminCSRFBlocksCrossOriginPost(t *testing.T) {
	h, _, sessions, _, _ := setupAdminTestEnv(t)
	req := httptest.NewRequest(http.MethodPost, "https://feedback.wxjifang.cn/api/admin.php?action=logout", nil)
	req.Host = "feedback.wxjifang.cn"
	req.Header.Set("Origin", "https://evil.example.com")
	req.AddCookie(addAdminCookie(t, sessions, nil))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 CSRF, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestAdminAuthLifecycleAndConcurrentTeacherSession(t *testing.T) {
	h, repo, sessions, _, _ := setupAdminTestEnv(t)

	// 1. Login with legacy SHA256 password upgrades to bcrypt
	body := `{"username":"legacy","password":"LegacyPass123"}`
	req := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=login", strings.NewReader(body))
	req.Host = "feedback.wxjifang.cn"
	req.Header.Set("Origin", "http://feedback.wxjifang.cn")
	// Attach existing foreground teacher session to ensure it survives admin login + logout
	teacherSess := &session.Session{
		ID:   "teacher_sess_1234567890abcd",
		Data: map[string]any{"user_logged_in": true, "username": "t1"},
	}
	_ = sessions.Save(context.Background(), teacherSess)
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSess.ID})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("login failed: %d %s", rec.Code, rec.Body.String())
	}
	if repo.updatedHashes[2] == "" || !strings.HasPrefix(repo.updatedHashes[2], "$2") {
		t.Fatalf("expected SHA256 password upgrade to bcrypt, got %q", repo.updatedHashes[2])
	}
	cookies := rec.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("expected regenerated PHPSESSID cookie")
	}
	newCookie := cookies[0]

	// 2. Check logged in
	req2 := httptest.NewRequest(http.MethodGet, "http://feedback.wxjifang.cn/api/admin.php?action=check", nil)
	req2.AddCookie(newCookie)
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, req2)
	if !strings.Contains(rec2.Body.String(), `"loggedIn":true`) {
		t.Fatalf("expected loggedIn:true, got %s", rec2.Body.String())
	}

	// 3. Logout keeps foreground teacher session intact
	req3 := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=logout", nil)
	req3.Host = "feedback.wxjifang.cn"
	req3.Header.Set("Origin", "http://feedback.wxjifang.cn")
	req3.AddCookie(newCookie)
	rec3 := httptest.NewRecorder()
	h.ServeHTTP(rec3, req3)
	if rec3.Code != http.StatusOK {
		t.Fatalf("logout failed: %d", rec3.Code)
	}
	loaded, _ := sessions.Load(context.Background(), newCookie.Value)
	if loaded == nil || !loaded.IsUserLoggedIn() || loaded.IsAdminLoggedIn() {
		t.Fatalf("expected teacher session preserved and admin cleared, got %+v", loaded)
	}
}

func TestAdminLoginRateLimitLockout(t *testing.T) {
	h, _, _, _, _ := setupAdminTestEnv(t)
	for i := 0; i < 5; i++ {
		req := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=login", strings.NewReader(`{"username":"admin","password":"wrong"}`))
		req.Host = "feedback.wxjifang.cn"
		req.Header.Set("Origin", "http://feedback.wxjifang.cn")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: expected 401, got %d", i+1, rec.Code)
		}
	}
	req6 := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=login", strings.NewReader(`{"username":"admin","password":"AdminPass123"}`))
	req6.Host = "feedback.wxjifang.cn"
	req6.Header.Set("Origin", "http://feedback.wxjifang.cn")
	rec6 := httptest.NewRecorder()
	h.ServeHTTP(rec6, req6)
	if rec6.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 lockout, got %d: %s", rec6.Code, rec6.Body.String())
	}
}

func TestAdminConfigIsolationAndTestAI(t *testing.T) {
	h, _, sessions, _, dir := setupAdminTestEnv(t)
	ck := addAdminCookie(t, sessions, nil)

	// GET config returns masked key, never plaintext
	req := httptest.NewRequest(http.MethodGet, "http://feedback.wxjifang.cn/api/admin.php?action=config", nil)
	req.AddCookie(ck)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET config: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "sk-legacy-plaintext-123456") {
		t.Fatalf("plaintext key leaked in GET config: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"hasApiKey":true`) {
		t.Fatalf("expected hasApiKey:true, got %s", rec.Body.String())
	}

	// POST config updates key into data/.ai_secrets.json and strips from config.json
	postBody := `{"semesterYear":2027,"dashscopeApiKey":"sk-new-secret-987654","disableQwenFlashTitle":true}`
	req2 := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=config", strings.NewReader(postBody))
	req2.Host = "feedback.wxjifang.cn"
	req2.Header.Set("Origin", "http://feedback.wxjifang.cn")
	req2.AddCookie(ck)
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("POST config: %d %s", rec2.Code, rec2.Body.String())
	}
	cfgBytes, _ := os.ReadFile(filepath.Join(dir, "config.json"))
	if strings.Contains(string(cfgBytes), "dashscopeApiKey") {
		t.Fatalf("config.json should not contain dashscopeApiKey: %s", string(cfgBytes))
	}
	secBytes, err := os.ReadFile(filepath.Join(dir, "data", ".ai_secrets.json"))
	if err != nil || !strings.Contains(string(secBytes), "sk-new-secret-987654") {
		t.Fatalf("expected new key in .ai_secrets.json, got err=%v body=%s", err, string(secBytes))
	}

	// test_ai_config against mock server
	aiMockHits := 0
	aiMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		aiMockHits++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"OK"}}]}`))
	}))
	defer aiMock.Close()

	// Custom base_url without explicit api_key must reject with 400 and never send stored secret.
	for _, badProbe := range []map[string]any{
		{"base_url": aiMock.URL, "model": "qwen3.8-max"},
		{"base_url": aiMock.URL, "api_key": "sk-****1234", "model": "qwen3.8-max"},
		{"base_url": "file:///etc/passwd", "api_key": "sk-explicit", "model": "qwen3.8-max"},
	} {
		badBytes, _ := json.Marshal(badProbe)
		reqBad := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=test_ai_config", bytes.NewReader(badBytes))
		reqBad.Host = "feedback.wxjifang.cn"
		reqBad.Header.Set("Origin", "http://feedback.wxjifang.cn")
		reqBad.AddCookie(ck)
		recBad := httptest.NewRecorder()
		h.ServeHTTP(recBad, reqBad)
		if recBad.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for invalid/custom base_url probe %+v, got %d: %s", badProbe, recBad.Code, recBad.Body.String())
		}
	}
	if aiMockHits != 0 {
		t.Fatalf("stored api key leaked to unverified custom base_url (%d hits)", aiMockHits)
	}

	// Changing identifyApiBase via POST ?action=config without a new api_key must be rejected (prevents stored key exfiltration).
	swapBaseBody, _ := json.Marshal(map[string]any{
		"identifyApiBase": "https://evil.example.com/v1",
	})
	reqSwap := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=config", bytes.NewReader(swapBaseBody))
	reqSwap.Host = "feedback.wxjifang.cn"
	reqSwap.Header.Set("Origin", "http://feedback.wxjifang.cn")
	reqSwap.AddCookie(ck)
	recSwap := httptest.NewRecorder()
	h.ServeHTTP(recSwap, reqSwap)
	if recSwap.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 when changing identifyApiBase without new api_key, got %d: %s", recSwap.Code, recSwap.Body.String())
	}

	// Default HTTPClient blocks loopback/private IPs (SSRF guard).
	probeBody, _ := json.Marshal(map[string]any{
		"base_url": aiMock.URL,
		"api_key":  "sk-explicit-test-key",
		"model":    "qwen3.8-max",
	})
	reqSSRF := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=test_ai_config", bytes.NewReader(probeBody))
	reqSSRF.Host = "feedback.wxjifang.cn"
	reqSSRF.Header.Set("Origin", "http://feedback.wxjifang.cn")
	reqSSRF.AddCookie(ck)
	recSSRF := httptest.NewRecorder()
	h.ServeHTTP(recSSRF, reqSSRF)
	if !strings.Contains(recSSRF.Body.String(), "禁止访问内网或本地地址") || aiMockHits != 0 {
		t.Fatalf("expected SSRF block on loopback address, got hits=%d body=%s", aiMockHits, recSSRF.Body.String())
	}

	// With an injected test HTTPClient, test_ai_config succeeds against mock server.
	hWithMockClient := httpx.Middleware(Admin(AdminDeps{
		Sessions:     sessions,
		ConfigLoader: config.NewLoader(dir, ""),
		FeedbackRoot: dir,
		HTTPClient:   aiMock.Client(),
	}))
	req3 := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=test_ai_config", bytes.NewReader(probeBody))
	req3.Host = "feedback.wxjifang.cn"
	req3.Header.Set("Origin", "http://feedback.wxjifang.cn")
	req3.AddCookie(ck)
	rec3 := httptest.NewRecorder()
	hWithMockClient.ServeHTTP(rec3, req3)
	if rec3.Code != http.StatusOK || !strings.Contains(rec3.Body.String(), `"reply":"OK"`) {
		t.Fatalf("test_ai_config failed: %d %s", rec3.Code, rec3.Body.String())
	}
}

func TestAdminTablesCRUDTokenHistoryAndSourceFile(t *testing.T) {
	h, _, sessions, _, dir := setupAdminTestEnv(t)
	ck := addAdminCookie(t, sessions, nil)

	// Hidden table schema => 403
	req := httptest.NewRequest(http.MethodGet, "http://feedback.wxjifang.cn/api/admin.php?action=db_schema&table=app_sessions", nil)
	req.AddCookie(ck)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for hidden table, got %d", rec.Code)
	}

	// class_batches delete without force_cascade => 409
	reqDel := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=db_delete&table=class_batches", strings.NewReader(`{"ids":[1]}`))
	reqDel.Host = "feedback.wxjifang.cn"
	reqDel.Header.Set("Origin", "http://feedback.wxjifang.cn")
	reqDel.AddCookie(ck)
	recDel := httptest.NewRecorder()
	h.ServeHTTP(recDel, reqDel)
	if recDel.Code != http.StatusConflict {
		t.Fatalf("expected 409 cascade guard, got %d: %s", recDel.Code, recDel.Body.String())
	}

	// class_batches delete with force_cascade=true => 200
	reqDel2 := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=db_delete&table=class_batches", strings.NewReader(`{"ids":[1],"force_cascade":true}`))
	reqDel2.Host = "feedback.wxjifang.cn"
	reqDel2.Header.Set("Origin", "http://feedback.wxjifang.cn")
	reqDel2.AddCookie(ck)
	recDel2 := httptest.NewRecorder()
	h.ServeHTTP(recDel2, reqDel2)
	if recDel2.Code != http.StatusOK {
		t.Fatalf("expected 200 with force_cascade, got %d: %s", recDel2.Code, recDel2.Body.String())
	}

	// get_retest_admin_url & search_by_token
	reqTok := httptest.NewRequest(http.MethodGet, "http://feedback.wxjifang.cn/api/admin.php?action=get_retest_admin_url&token=abc1234567", nil)
	reqTok.AddCookie(ck)
	recTok := httptest.NewRecorder()
	h.ServeHTTP(recTok, reqTok)
	if recTok.Code != http.StatusOK || !strings.Contains(recTok.Body.String(), "admin_sig=") {
		t.Fatalf("get_retest_admin_url failed: %d %s", recTok.Code, recTok.Body.String())
	}

	reqSearch := httptest.NewRequest(http.MethodGet, "http://feedback.wxjifang.cn/api/admin.php?action=search_by_token&token=abc1234567", nil)
	reqSearch.AddCookie(ck)
	recSearch := httptest.NewRecorder()
	h.ServeHTTP(recSearch, reqSearch)
	if recSearch.Code != http.StatusOK || !strings.Contains(recSearch.Body.String(), `"found":true`) {
		t.Fatalf("search_by_token failed: %d %s", recSearch.Code, recSearch.Body.String())
	}

	// record_rollback
	reqRB := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=record_rollback", strings.NewReader(`{"history_id":77}`))
	reqRB.Host = "feedback.wxjifang.cn"
	reqRB.Header.Set("Origin", "http://feedback.wxjifang.cn")
	reqRB.AddCookie(ck)
	recRB := httptest.NewRecorder()
	h.ServeHTTP(recRB, reqRB)
	if recRB.Code != http.StatusOK || !strings.Contains(recRB.Body.String(), "#77") {
		t.Fatalf("record_rollback failed: %d %s", recRB.Code, recRB.Body.String())
	}

	// download_source_file (check_only & binary)
	uDir := filepath.Join(dir, "data", "uploads", "20261121")
	_ = os.MkdirAll(uDir, 0o755)
	_ = os.WriteFile(filepath.Join(uDir, "20261121_100000_homework_test.csv"), []byte("姓名\n张三\n"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "data", "uploads", "index.jsonl"),
		[]byte(`{"orig":"课后巩固.csv","rel":"20261121/20261121_100000_homework_test.csv","ts":1795143600,"type":"homework"}`+"\n"), 0o644)

	reqDL := httptest.NewRequest(http.MethodGet, "http://feedback.wxjifang.cn/api/admin.php?action=download_source_file&file_name=%E8%AF%BE%E5%90%8E%E5%B7%A9%E5%9B%BA.csv&check_only=1", nil)
	reqDL.AddCookie(ck)
	recDL := httptest.NewRecorder()
	h.ServeHTTP(recDL, reqDL)
	if recDL.Code != http.StatusOK || !strings.Contains(recDL.Body.String(), `"found":true`) {
		t.Fatalf("download_source_file check_only failed: %d %s", recDL.Code, recDL.Body.String())
	}

	reqDLBin := httptest.NewRequest(http.MethodGet, "http://feedback.wxjifang.cn/api/admin.php?action=download_source_file&file_name=%E8%AF%BE%E5%90%8E%E5%B7%A9%E5%9B%BA.csv", nil)
	reqDLBin.AddCookie(ck)
	recDLBin := httptest.NewRecorder()
	h.ServeHTTP(recDLBin, reqDLBin)
	if recDLBin.Code != http.StatusOK || recDLBin.Header().Get("Content-Type") != "application/octet-stream" {
		t.Fatalf("download_source_file binary failed: %d %v", recDLBin.Code, recDLBin.Header())
	}
}

func TestAdminRemainingEndpointsAndLimits(t *testing.T) {
	h, repo, sessions, _, _ := setupAdminTestEnv(t)
	ck := addAdminCookie(t, sessions, nil)

	// GET metadata actions
	for _, action := range []string{"db_tables", "db_batches_options", "dimensions", "student_records_stats", "record_history"} {
		target := "http://feedback.wxjifang.cn/api/admin.php?action=" + action
		if action == "record_history" {
			target += "&record_id=12"
		}
		req := httptest.NewRequest(http.MethodGet, target, nil)
		req.AddCookie(ck)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"success":true`) {
			t.Fatalf("%s failed: %d %s", action, rec.Code, rec.Body.String())
		}
	}

	// db_list captures query params
	reqList := httptest.NewRequest(http.MethodGet, "http://feedback.wxjifang.cn/api/admin.php?action=db_list&table=student_records&page=2&per_page=15&sort_field=student_name&sort_order=asc&search=张三", nil)
	reqList.AddCookie(ck)
	recList := httptest.NewRecorder()
	h.ServeHTTP(recList, reqList)
	if recList.Code != http.StatusOK || repo.lastListQuery.Page != 2 || repo.lastListQuery.PageSize != 15 || repo.lastListQuery.Sort != "student_name" {
		t.Fatalf("db_list unexpected: code=%d q=%+v body=%s", recList.Code, repo.lastListQuery, recList.Body.String())
	}

	// db_get missing id -> 400; valid id -> 200
	reqGetMissing := httptest.NewRequest(http.MethodGet, "http://feedback.wxjifang.cn/api/admin.php?action=db_get&table=student_records", nil)
	reqGetMissing.AddCookie(ck)
	recGetMissing := httptest.NewRecorder()
	h.ServeHTTP(recGetMissing, reqGetMissing)
	if recGetMissing.Code != http.StatusBadRequest {
		t.Fatalf("db_get missing id: %d", recGetMissing.Code)
	}
	reqGet := httptest.NewRequest(http.MethodGet, "http://feedback.wxjifang.cn/api/admin.php?action=db_get&table=student_records&id=12", nil)
	reqGet.AddCookie(ck)
	recGet := httptest.NewRecorder()
	h.ServeHTTP(recGet, reqGet)
	if recGet.Code != http.StatusOK || !strings.Contains(recGet.Body.String(), `"record":`) {
		t.Fatalf("db_get failed: %d %s", recGet.Code, recGet.Body.String())
	}

	// db_create preserves json.Number on large integers
	reqCreate := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=db_create&table=student_records", strings.NewReader(`{"data":{"student_id":20260001,"student_name":"张三"}}`))
	reqCreate.Host = "feedback.wxjifang.cn"
	reqCreate.Header.Set("Origin", "http://feedback.wxjifang.cn")
	reqCreate.AddCookie(ck)
	recCreate := httptest.NewRecorder()
	h.ServeHTTP(recCreate, reqCreate)
	if recCreate.Code != http.StatusOK {
		t.Fatalf("db_create failed: %d %s", recCreate.Code, recCreate.Body.String())
	}
	if num, ok := repo.lastCreateInput["student_id"].(json.Number); !ok || num.String() != "20260001" {
		t.Fatalf("expected student_id json.Number(\"20260001\"), got %#v", repo.lastCreateInput["student_id"])
	}

	// Oversized >5MB JSON body on db_create returns 413
	oversized := `{"pad":"` + strings.Repeat("x", (5<<20)+128) + `"}`
	reqBig := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=db_create&table=student_records", strings.NewReader(oversized))
	reqBig.Host = "feedback.wxjifang.cn"
	reqBig.Header.Set("Origin", "http://feedback.wxjifang.cn")
	reqBig.AddCookie(ck)
	recBig := httptest.NewRecorder()
	h.ServeHTTP(recBig, reqBig)
	if recBig.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 for >5MB db_create body, got %d: %s", recBig.Code, recBig.Body.String())
	}

	// db_update & db_reset_teacher_password
	reqUpd := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=db_update&table=student_records&id=12", strings.NewReader(`{"data":{"teacher_comment":"有进步"}}`))
	reqUpd.Host = "feedback.wxjifang.cn"
	reqUpd.Header.Set("Origin", "http://feedback.wxjifang.cn")
	reqUpd.AddCookie(ck)
	recUpd := httptest.NewRecorder()
	h.ServeHTTP(recUpd, reqUpd)
	if recUpd.Code != http.StatusOK || repo.lastUpdateID != "12" {
		t.Fatalf("db_update failed: %d %s", recUpd.Code, recUpd.Body.String())
	}

	reqResetBad := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=db_reset_teacher_password", strings.NewReader(`{"id":7,"password":"123"}`))
	reqResetBad.Host = "feedback.wxjifang.cn"
	reqResetBad.Header.Set("Origin", "http://feedback.wxjifang.cn")
	reqResetBad.AddCookie(ck)
	recResetBad := httptest.NewRecorder()
	h.ServeHTTP(recResetBad, reqResetBad)
	if recResetBad.Code != http.StatusBadRequest {
		t.Fatalf("db_reset_teacher_password short password: got %d, want 400", recResetBad.Code)
	}

	reqReset := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=db_reset_teacher_password", strings.NewReader(`{"id":7,"password":"NewTeacherPass123"}`))
	reqReset.Host = "feedback.wxjifang.cn"
	reqReset.Header.Set("Origin", "http://feedback.wxjifang.cn")
	reqReset.AddCookie(ck)
	recReset := httptest.NewRecorder()
	h.ServeHTTP(recReset, reqReset)
	if recReset.Code != http.StatusOK || repo.lastResetUserID != 7 || repo.lastResetPwd != "NewTeacherPass123" {
		t.Fatalf("db_reset_teacher_password failed: %d %s", recReset.Code, recReset.Body.String())
	}

	// change_password >72 bytes -> 400, valid -> 200
	longPwd := strings.Repeat("A", 73)
	reqCPBad := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=change_password", strings.NewReader(`{"old_password":"AdminPass123","new_password":"`+longPwd+`"}`))
	reqCPBad.Host = "feedback.wxjifang.cn"
	reqCPBad.Header.Set("Origin", "http://feedback.wxjifang.cn")
	reqCPBad.AddCookie(ck)
	recCPBad := httptest.NewRecorder()
	h.ServeHTTP(recCPBad, reqCPBad)
	if recCPBad.Code != http.StatusBadRequest {
		t.Fatalf("change_password >72 bytes: got %d, want 400 (%s)", recCPBad.Code, recCPBad.Body.String())
	}

	reqCPOK := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=change_password", strings.NewReader(`{"old_password":"AdminPass123","new_password":"AdminPass456"}`))
	reqCPOK.Host = "feedback.wxjifang.cn"
	reqCPOK.Header.Set("Origin", "http://feedback.wxjifang.cn")
	reqCPOK.AddCookie(ck)
	recCPOK := httptest.NewRecorder()
	h.ServeHTTP(recCPOK, reqCPOK)
	if recCPOK.Code != http.StatusOK || !strings.HasPrefix(repo.updatedHashes[1], "$2") {
		t.Fatalf("change_password failed: %d %s (hash=%q)", recCPOK.Code, recCPOK.Body.String(), repo.updatedHashes[1])
	}
}

func TestAdminConfigClearKeyAndSSRFGuards(t *testing.T) {
	h, _, sessions, _, root := setupAdminTestEnv(t)
	ck := addAdminCookie(t, sessions, nil)
	loader := config.NewLoader(root, "")

	postCfg := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=config", strings.NewReader(body))
		req.Host = "feedback.wxjifang.cn"
		req.Header.Set("Origin", "http://feedback.wxjifang.cn")
		req.AddCookie(ck)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	// 1. Seed a real API key and local verifyMode
	if rec := postCfg(`{"dashscopeApiKey":"sk-real-secret-9999","senderControl":{"verifyMode":"local"}}`); rec.Code != http.StatusOK {
		t.Fatalf("seed config failed: %d %s", rec.Code, rec.Body.String())
	}
	vBefore := loader.Load().SenderControl().PolicyVersion

	// 2. disableQwenFlashTitle: null must NOT reset verifyMode or bump policyVersion
	if rec := postCfg(`{"disableQwenFlashTitle":null}`); rec.Code != http.StatusOK {
		t.Fatalf("null disableQwenFlashTitle failed: %d %s", rec.Code, rec.Body.String())
	}
	scAfter := loader.Load().SenderControl()
	if scAfter.VerifyMode != "local" || scAfter.PolicyVersion != vBefore {
		t.Fatalf("null disableQwenFlashTitle mutated senderControl: %+v (prev version=%d)", scAfter, vBefore)
	}

	// 3. SSRF hosts on identifyApiBase must be rejected with 400
	for _, badURL := range []string{
		"http://127.0.0.1:8090/v1",
		"http://169.254.169.254/latest/meta-data",
		"http://localhost:8080/v1",
	} {
		rec := postCfg(`{"identifyApiBase":"` + badURL + `","clearApiKey":true}`)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for SSRF identifyApiBase %s, got %d %s", badURL, rec.Code, rec.Body.String())
		}
	}

	// 4. Changing identifyApiBase with clearApiKey: true (even omitting dashscopeApiKey) must actually clear stored key
	recClear := postCfg(`{"identifyApiBase":"https://api.example.com/v1/chat/completions","clearApiKey":true}`)
	if recClear.Code != http.StatusOK {
		t.Fatalf("clearApiKey with host change failed: %d %s", recClear.Code, recClear.Body.String())
	}
	if gotKey := loader.Load().VisionAPIKey(); gotKey != "" {
		t.Fatalf("expected stored API key to be cleared, still got %q", gotKey)
	}
}

func TestAdminQBankAuditEndpoints(t *testing.T) {
	dir := t.TempDir()
	signer, err := qbankattest.NewEphemeralSigner("jf-qb-adm")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 23, 8, 0, 0, 0, time.UTC)
	attestStore := qbankattest.NewMemoryStore(signer, dir, qbankattest.WithNowFunc(func() time.Time { return now }))

	scope := qbankattest.Scope{
		BankType: "homework",
		Year:     2026,
		Season:   "秋",
		Subject:  "数学",
		Grade:    "七年级",
		Tier:     "S+",
		Week:     3,
	}
	_, err = attestStore.RecordRevisionTx(context.Background(), nil, qbankattest.RecordRevisionInput{
		QBankID:      12,
		Action:       qbankattest.ActionCreate,
		Scope:        scope,
		Operator:     "t101",
		OperatorName: "张老师",
		Questions:    []qbankattest.SnapshotQuestion{{QuestionNum: 1, Topic: "有理数"}},
		Now:          now,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = attestStore.RecordAttempt(context.Background(), qbankattest.AttemptInput{
		EventType: qbankattest.EventUploadPDF, Scope: scope, Operator: "t101", OperatorName: "张老师",
		FileName: "q1.pdf", FileSHA256: strings.Repeat("a", 64), Now: now.Add(time.Minute),
	})
	_ = attestStore.RecordAttempt(context.Background(), qbankattest.AttemptInput{
		EventType: qbankattest.EventClientBlocked, Scope: scope, Operator: "t101", OperatorName: "张老师",
		Reason: "缺少知识点", Now: now.Add(2 * time.Minute),
	})
	_ = attestStore.RecordAttempt(context.Background(), qbankattest.AttemptInput{
		EventType: qbankattest.EventSaveRejected, Scope: scope, Operator: "t101", OperatorName: "张老师",
		Reason: "服务端校验失败", Now: now.Add(3 * time.Minute),
	})
	_ = attestStore.RecordAttempt(context.Background(), qbankattest.AttemptInput{
		EventType: qbankattest.EventSaveCancelled, Scope: scope, Operator: "t101", OperatorName: "张老师",
		Reason: "取消覆盖", Now: now.Add(4 * time.Minute),
	})

	sessions := session.NewMemoryStore()
	ck := addAdminCookie(t, sessions, nil)
	h := httpx.Middleware(Admin(AdminDeps{
		Repo:         newFakeAdminRepo(),
		Sessions:     sessions,
		RateLimit:    ratelimit.NewMemoryStore(),
		ConfigLoader: config.NewLoader(dir, ""),
		Audit:        auditlog.NoopLogger{},
		Attest:       attestStore,
		FeedbackRoot: dir,
	}))

	// 1. Unauthenticated -> 401; POST -> 405
	for _, act := range []string{"qbank_matrix", "qbank_timeline", "qbank_revisions"} {
		recUnauth := httptest.NewRecorder()
		h.ServeHTTP(recUnauth, httptest.NewRequest(http.MethodGet, "http://feedback.wxjifang.cn/api/admin.php?action="+act, nil))
		if recUnauth.Code != http.StatusUnauthorized {
			t.Fatalf("%s unauth status = %d, want 401", act, recUnauth.Code)
		}
		reqPost := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action="+act, nil)
		reqPost.Host = "feedback.wxjifang.cn"
		reqPost.Header.Set("Origin", "http://feedback.wxjifang.cn")
		reqPost.AddCookie(ck)
		recPost := httptest.NewRecorder()
		h.ServeHTTP(recPost, reqPost)
		if recPost.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s POST status = %d, want 405", act, recPost.Code)
		}
	}

	// 2. qbank_matrix
	reqMat := httptest.NewRequest(http.MethodGet, "http://feedback.wxjifang.cn/api/admin.php?action=qbank_matrix&year=2026&season=%E7%A7%8B&bank_type=homework&subject=%E6%95%B0%E5%AD%A6", nil)
	reqMat.AddCookie(ck)
	recMat := httptest.NewRecorder()
	h.ServeHTTP(recMat, reqMat)
	if recMat.Code != http.StatusOK {
		t.Fatalf("qbank_matrix status = %d, body=%s", recMat.Code, recMat.Body.String())
	}
	var matResp struct {
		Success bool `json:"success"`
		Data    struct {
			Items []qbankattest.MatrixItem `json:"items"`
			Total int                      `json:"total"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recMat.Body.Bytes(), &matResp); err != nil {
		t.Fatal(err)
	}
	if !matResp.Success || matResp.Data.Total != 1 || len(matResp.Data.Items) != 1 || matResp.Data.Items[0].AttemptCount != 4 {
		t.Fatalf("unexpected qbank_matrix response: %+v", matResp)
	}

	// 3. qbank_revisions
	reqRev := httptest.NewRequest(http.MethodGet, "http://feedback.wxjifang.cn/api/admin.php?action=qbank_revisions&year=2026&season=autumn&bank_type=homework&subject=%E6%95%B0%E5%AD%A6&grade=%E4%B8%83%E5%B9%B4%E7%BA%A7&tier=S%2B&week=3", nil)
	reqRev.AddCookie(ck)
	recRev := httptest.NewRecorder()
	h.ServeHTTP(recRev, reqRev)
	if recRev.Code != http.StatusOK {
		t.Fatalf("qbank_revisions status = %d, body=%s", recRev.Code, recRev.Body.String())
	}
	var revResp struct {
		Success bool                       `json:"success"`
		Data    struct {
			Items []qbankattest.RevisionItem `json:"items"`
			Total int                        `json:"total"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recRev.Body.Bytes(), &revResp); err != nil {
		t.Fatal(err)
	}
	if !revResp.Success || len(revResp.Data.Items) != 1 || revResp.Data.Items[0].RevisionNo != 1 {
		t.Fatalf("unexpected qbank_revisions response: %+v", revResp)
	}

	// 4. qbank_timeline with comma-separated event_type=client_blocked,save_rejected
	reqTL := httptest.NewRequest(http.MethodGet, "http://feedback.wxjifang.cn/api/admin.php?action=qbank_timeline&page=1&page_size=20&operator=%E5%BC%A0&event_type=client_blocked,save_rejected", nil)
	reqTL.AddCookie(ck)
	recTL := httptest.NewRecorder()
	h.ServeHTTP(recTL, reqTL)
	if recTL.Code != http.StatusOK {
		t.Fatalf("qbank_timeline status = %d, body=%s", recTL.Code, recTL.Body.String())
	}
	var tlResp struct {
		Success bool                       `json:"success"`
		Data    *qbankattest.TimelineResult `json:"data"`
	}
	if err := json.Unmarshal(recTL.Body.Bytes(), &tlResp); err != nil {
		t.Fatal(err)
	}
	if !tlResp.Success || tlResp.Data == nil || tlResp.Data.Total != 2 || tlResp.Data.Stats.Revisions != 1 || tlResp.Data.Stats.Uploads != 1 || tlResp.Data.Stats.BlockedOrFailed != 2 || tlResp.Data.Stats.Cancelled != 1 {
		t.Fatalf("unexpected qbank_timeline response: %+v", tlResp.Data)
	}
}
