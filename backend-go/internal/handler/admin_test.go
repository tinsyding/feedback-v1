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
func (f *fakeAdminRepo) ListRecords(_ context.Context, _ admin.ListQuery) (admin.ListResult, error) {
	return f.listRes, nil
}
func (f *fakeAdminRepo) GetRecord(_ context.Context, _, _ string) (map[string]any, error) {
	return f.getRow, nil
}
func (f *fakeAdminRepo) CreateRecord(_ context.Context, _ string, _ map[string]any, _ string) (int64, error) {
	return f.createdID, nil
}
func (f *fakeAdminRepo) UpdateRecord(_ context.Context, _, _ string, input map[string]any, _ string) (int64, []string, error) {
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
func (f *fakeAdminRepo) ResetTeacherPassword(_ context.Context, _ int, _, _ string) (admin.ResetTeacherResult, error) {
	return f.resetRes, nil
}
func (f *fakeAdminRepo) ListRecordHistory(_ context.Context, _ int, _ string, _ int, _ *int) ([]map[string]any, error) {
	return []map[string]any{{"id": 77, "student_name": "张三"}}, nil
}
func (f *fakeAdminRepo) RollbackRecord(_ context.Context, _ int, _ string) (admin.RollbackResult, error) {
	return f.rollbackRes, nil
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
	return Admin(deps), repo, sessions, audit, dir
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
	aiMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"OK"}}]}`))
	}))
	defer aiMock.Close()

	probeBody, _ := json.Marshal(map[string]any{
		"base_url": aiMock.URL,
		"model":    "qwen3.8-max",
	})
	req3 := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=test_ai_config", bytes.NewReader(probeBody))
	req3.Host = "feedback.wxjifang.cn"
	req3.Header.Set("Origin", "http://feedback.wxjifang.cn")
	req3.AddCookie(ck)
	rec3 := httptest.NewRecorder()
	h.ServeHTTP(rec3, req3)
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
