package handler

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"feedback-api/internal/auditlog"
	"feedback-api/internal/auth"
	"feedback-api/internal/httpx"
	"feedback-api/internal/ratelimit"
	"feedback-api/internal/session"
)

type mockAuthRepo struct {
	mu       sync.Mutex
	users    map[string]*auth.User
	admins   map[string]*auth.AdminUser
	nextID   int64
	upgraded map[int64]string
}

func newMockAuthRepo() *mockAuthRepo {
	return &mockAuthRepo{
		users:    make(map[string]*auth.User),
		admins:   make(map[string]*auth.AdminUser),
		nextID:   100,
		upgraded: make(map[int64]string),
	}
}

func (m *mockAuthRepo) addUser(u auth.User) {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := u
	m.users[u.Username] = &cp
}

func (m *mockAuthRepo) addAdmin(a auth.AdminUser) {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := a
	m.admins[a.Username] = &cp
}

func (m *mockAuthRepo) FindUserByUsername(_ context.Context, username string) (*auth.User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	u, ok := m.users[username]
	if !ok {
		return nil, nil
	}
	cp := *u
	return &cp, nil
}

func (m *mockAuthRepo) FindAdminByUsername(_ context.Context, username string) (*auth.AdminUser, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.admins[username]
	if !ok {
		return nil, nil
	}
	cp := *a
	return &cp, nil
}

func (m *mockAuthRepo) UpdateUserLogin(_ context.Context, _ int64, _ string) error  { return nil }
func (m *mockAuthRepo) UpdateAdminLogin(_ context.Context, _ int64, _ string) error { return nil }

func (m *mockAuthRepo) UpgradeAdminPasswordHash(_ context.Context, adminID int64, bcryptHash string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.upgraded[adminID] = bcryptHash
	for _, a := range m.admins {
		if a.ID == adminID {
			a.PasswordHash = bcryptHash
		}
	}
	return nil
}

func (m *mockAuthRepo) UpdateUserPassword(_ context.Context, userID int64, bcryptHash string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, u := range m.users {
		if u.ID == userID {
			u.PasswordHash = bcryptHash
		}
	}
	return nil
}

func (m *mockAuthRepo) isOwned(u *auth.User, ownerID int64, ownerUsername string) bool {
	if u.Role != "assistant" {
		return false
	}
	if ownerID > 0 {
		return u.TeacherID == ownerID || u.CreatedBy == ownerUsername
	}
	return u.CreatedBy == ownerUsername
}

func (m *mockAuthRepo) ListAssistants(_ context.Context, ownerID int64, ownerUsername string) ([]auth.AssistantRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]auth.AssistantRecord, 0)
	for _, u := range m.users {
		if m.isOwned(u, ownerID, ownerUsername) {
			out = append(out, auth.AssistantRecord{
				ID:        u.ID,
				Username:  u.Username,
				RealName:  u.RealName,
				Role:      u.Role,
				TeacherID: u.TeacherID,
				CreatedBy: u.CreatedBy,
				Status:    u.Status,
			})
		}
	}
	return out, nil
}

func (m *mockAuthRepo) CreateAssistant(_ context.Context, username, passwordHash, realName string, teacherID int64, createdBy string) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextID++
	id := m.nextID
	m.users[username] = &auth.User{
		ID:           id,
		Username:     username,
		PasswordHash: passwordHash,
		RealName:     realName,
		Role:         "assistant",
		TeacherID:    teacherID,
		CreatedBy:    createdBy,
		Status:       1,
	}
	return id, nil
}

func (m *mockAuthRepo) FindAssistantOwned(_ context.Context, targetID, ownerID int64, ownerUsername string) (*auth.User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, u := range m.users {
		if u.ID == targetID && m.isOwned(u, ownerID, ownerUsername) {
			cp := *u
			return &cp, nil
		}
	}
	return nil, nil
}

func (m *mockAuthRepo) UpdateAssistant(_ context.Context, targetID int64, patch auth.AssistantUpdatePatch) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, u := range m.users {
		if u.ID == targetID {
			if patch.RealName != nil {
				u.RealName = *patch.RealName
			}
			if patch.Status != nil {
				u.Status = *patch.Status
			}
			if patch.PasswordHash != nil {
				u.PasswordHash = *patch.PasswordHash
			}
		}
	}
	return nil
}

func (m *mockAuthRepo) DeleteAssistant(_ context.Context, targetID int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for k, u := range m.users {
		if u.ID == targetID {
			delete(m.users, k)
		}
	}
	return nil
}

func extractPHPSESSIDFromRecorder(rec *httptest.ResponseRecorder) string {
	for _, c := range rec.Result().Cookies() {
		if c.Name == "PHPSESSID" {
			return c.Value
		}
	}
	return ""
}

func TestAuthCaptchaAndLoginFlowWithPHP2yHash(t *testing.T) {
	repo := newMockAuthRepo()
	// Generate bcrypt hash and rewrite $2a$ -> $2y$ to simulate PHP password_hash()
	rawHash, err := auth.HashPassword("secret123")
	if err != nil {
		t.Fatal(err)
	}
	php2yHash := "$2y$" + strings.TrimPrefix(rawHash, "$2a$")
	repo.addUser(auth.User{
		ID:           7,
		Username:     "t101",
		PasswordHash: php2yHash,
		RealName:     "张老师",
		Role:         "teacher",
		Status:       1,
	})

	sessStore := session.NewMemoryStore()
	rlStore := ratelimit.NewMemoryStore()
	h := httpx.Middleware(Auth(AuthDeps{
		Repo:      repo,
		Sessions:  sessStore,
		RateLimit: rlStore,
		Audit:     auditlog.NoopLogger{},
	}))

	// 1. Test account '0' rejected with 403
	req0 := httptest.NewRequest(http.MethodPost, "/api/auth.php?action=login", strings.NewReader(`{"username":"0","password":"123"}`))
	req0.RemoteAddr = "198.51.100.10:1234"
	rec0 := httptest.NewRecorder()
	h.ServeHTTP(rec0, req0)
	if rec0.Code != http.StatusForbidden {
		t.Fatalf("account 0 status = %d, want 403", rec0.Code)
	}

	// 2. Wrong password triggers captcha requirement on next attempt
	reqBad := httptest.NewRequest(http.MethodPost, "/api/auth.php?action=login", strings.NewReader(`{"username":"t101","password":"wrong"}`))
	reqBad.RemoteAddr = "203.0.113.20:1234"
	recBad := httptest.NewRecorder()
	h.ServeHTTP(recBad, reqBad)
	if recBad.Code != http.StatusUnauthorized {
		t.Fatalf("wrong pwd status = %d, want 401 (body=%s)", recBad.Code, recBad.Body.String())
	}
	sid1 := extractPHPSESSIDFromRecorder(recBad)
	if sid1 == "" {
		t.Fatal("expected PHPSESSID cookie after failed login")
	}

	// 3. Fetch captcha PNG using same session
	reqCap := httptest.NewRequest(http.MethodGet, "/api/auth.php?action=captcha", nil)
	reqCap.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: sid1})
	recCap := httptest.NewRecorder()
	h.ServeHTTP(recCap, reqCap)
	if recCap.Code != http.StatusOK || recCap.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("captcha response invalid: code=%d ct=%q", recCap.Code, recCap.Header().Get("Content-Type"))
	}
	if _, err := png.Decode(bytes.NewReader(recCap.Body.Bytes())); err != nil {
		t.Fatalf("captcha body is not valid PNG: %v", err)
	}
	loadedSess, _ := sessStore.Load(context.Background(), sid1)
	capCode := loadedSess.StringVal("front_captcha_code")
	if len(capCode) != 4 {
		t.Fatalf("expected 4-char captcha in session, got %q", capCode)
	}

	// 4. Login with valid PHP $2y$ password + captcha succeeds and rotates session ID
	bodyOK := `{"username":"t101","password":"secret123","captcha":"` + strings.ToUpper(capCode) + `"}`
	reqOK := httptest.NewRequest(http.MethodPost, "/api/auth.php?action=login", strings.NewReader(bodyOK))
	reqOK.RemoteAddr = "203.0.113.20:1234"
	reqOK.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: sid1})
	recOK := httptest.NewRecorder()
	h.ServeHTTP(recOK, reqOK)
	if recOK.Code != http.StatusOK {
		t.Fatalf("valid login status = %d, want 200 (body=%s)", recOK.Code, recOK.Body.String())
	}
	sid2 := extractPHPSESSIDFromRecorder(recOK)
	if sid2 == "" || sid2 == sid1 {
		t.Fatalf("expected rotated PHPSESSID, old=%q new=%q", sid1, sid2)
	}
	if oldSess, _ := sessStore.Load(context.Background(), sid1); oldSess != nil {
		t.Fatal("old session ID must be destroyed after login regeneration")
	}

	// 5. Check endpoint reflects loggedIn=true
	reqChk := httptest.NewRequest(http.MethodGet, "/api/auth.php?action=check", nil)
	reqChk.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: sid2})
	recChk := httptest.NewRecorder()
	h.ServeHTTP(recChk, reqChk)
	var chkEnv struct {
		Success bool `json:"success"`
		Data    struct {
			LoggedIn bool `json:"loggedIn"`
			User     struct {
				Username string `json:"username"`
				Role     string `json:"role"`
			} `json:"user"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recChk.Body.Bytes(), &chkEnv); err != nil {
		t.Fatal(err)
	}
	if !chkEnv.Success || !chkEnv.Data.LoggedIn || chkEnv.Data.User.Username != "t101" {
		t.Fatalf("unexpected check response: %+v", chkEnv)
	}
}

func TestAuthAdminLegacySHA256UpgradeAndLogoutPreservation(t *testing.T) {
	repo := newMockAuthRepo()
	sum := sha256.Sum256([]byte("adminpass"))
	repo.addAdmin(auth.AdminUser{
		ID:           1,
		Username:     "boss",
		PasswordHash: hex.EncodeToString(sum[:]),
		RealName:     "总管",
		Role:         "super_admin",
		Status:       1,
	})

	sessStore := session.NewMemoryStore()
	rlStore := ratelimit.NewMemoryStore()
	h := httpx.Middleware(Auth(AuthDeps{
		Repo:      repo,
		Sessions:  sessStore,
		RateLimit: rlStore,
		Audit:     auditlog.NoopLogger{},
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/auth.php?action=login", strings.NewReader(`{"username":"boss","password":"adminpass"}`))
	req.RemoteAddr = "203.0.113.30:1234"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin login status = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}
	if repo.upgraded[1] == "" || !strings.HasPrefix(repo.upgraded[1], "$2") {
		t.Fatalf("expected legacy SHA256 admin hash to auto-upgrade to bcrypt, got %q", repo.upgraded[1])
	}
	sid := extractPHPSESSIDFromRecorder(rec)

	// Admin-only logout clears admin session and deletes empty session row
	reqOut := httptest.NewRequest(http.MethodPost, "/api/auth.php?action=logout", nil)
	reqOut.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: sid})
	recOut := httptest.NewRecorder()
	h.ServeHTTP(recOut, reqOut)
	if recOut.Code != http.StatusOK {
		t.Fatalf("logout status = %d", recOut.Code)
	}
	if s, _ := sessStore.Load(context.Background(), sid); s != nil {
		t.Fatalf("expected admin-only session to be deleted on logout, got %+v", s)
	}

	// Combined teacher+admin session: foreground logout must preserve admin_logged_in
	combinedSID := "abcdef1234567890abcdef1234567890"
	sessStore.Set(combinedSID, map[string]any{
		"user_logged_in":  true,
		"username":        "t101",
		"admin_logged_in": true,
		"admin_username":  "boss",
	})
	reqOut2 := httptest.NewRequest(http.MethodPost, "/api/auth.php?action=logout", nil)
	reqOut2.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: combinedSID})
	recOut2 := httptest.NewRecorder()
	h.ServeHTTP(recOut2, reqOut2)
	after, _ := sessStore.Load(context.Background(), combinedSID)
	if after == nil || after.IsUserLoggedIn() || !after.IsAdminLoggedIn() {
		t.Fatalf("expected teacher logout to preserve admin session, got %+v", after)
	}
}

func TestAuthResetPasswordAndAssistantCRUD(t *testing.T) {
	repo := newMockAuthRepo()
	oldHash, _ := auth.HashPassword("oldpass123")
	repo.addUser(auth.User{
		ID:           10,
		Username:     "t202",
		PasswordHash: oldHash,
		RealName:     "李老师",
		Role:         "teacher",
		Status:       1,
	})

	sessStore := session.NewMemoryStore()
	rlStore := ratelimit.NewMemoryStore()
	h := httpx.Middleware(Auth(AuthDeps{
		Repo:      repo,
		Sessions:  sessStore,
		RateLimit: rlStore,
		Audit:     auditlog.NoopLogger{},
	}))

	// 1. Reset password succeeds
	reqReset := httptest.NewRequest(http.MethodPost, "/api/auth.php?action=reset_password",
		strings.NewReader(`{"username":"t202","old_password":"oldpass123","new_password":"newpass456","confirm_password":"newpass456"}`))
	reqReset.RemoteAddr = "203.0.113.40:1234"
	recReset := httptest.NewRecorder()
	h.ServeHTTP(recReset, reqReset)
	if recReset.Code != http.StatusOK {
		t.Fatalf("reset_password status = %d, want 200 (body=%s)", recReset.Code, recReset.Body.String())
	}
	u, _ := repo.FindUserByUsername(context.Background(), "t202")
	if !auth.VerifyBcrypt("newpass456", u.PasswordHash) {
		t.Fatal("expected password to be updated to newpass456")
	}

	// 2. Assistant CRUD lifecycle as logged-in teacher
	teacherSID := "11112222333344445555666677778888"
	sessStore.Set(teacherSID, map[string]any{
		"user_logged_in": true,
		"user_id":        10,
		"username":       "t202",
		"user_role":      "teacher",
	})

	// Create assistant with raw suffix "01" -> "t202_01"
	reqCreate := httptest.NewRequest(http.MethodPost, "/api/auth.php?action=assistant_create",
		strings.NewReader(`{"username":"t202_01","real_name":"助教小王","password":"tapass123"}`))
	reqCreate.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	recCreate := httptest.NewRecorder()
	h.ServeHTTP(recCreate, reqCreate)
	if recCreate.Code != http.StatusOK {
		t.Fatalf("assistant_create status = %d, want 200 (body=%s)", recCreate.Code, recCreate.Body.String())
	}
	var createResp struct {
		Success bool `json:"success"`
		Data    struct {
			ID       int64  `json:"id"`
			Username string `json:"username"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recCreate.Body.Bytes(), &createResp); err != nil {
		t.Fatal(err)
	}
	if createResp.Data.Username != "t202_01" || createResp.Data.ID <= 0 {
		t.Fatalf("unexpected assistant_create resp: %+v", createResp)
	}

	// Assistant role cannot manage assistants (403)
	taSID := "aaaa2222333344445555666677778888"
	sessStore.Set(taSID, map[string]any{
		"user_logged_in": true,
		"user_id":        createResp.Data.ID,
		"username":       "t202_01",
		"user_role":      "assistant",
	})
	reqForbid := httptest.NewRequest(http.MethodGet, "/api/auth.php?action=assistant_list", nil)
	reqForbid.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: taSID})
	recForbid := httptest.NewRecorder()
	h.ServeHTTP(recForbid, reqForbid)
	if recForbid.Code != http.StatusForbidden {
		t.Fatalf("assistant_list by assistant status = %d, want 403", recForbid.Code)
	}

	// Update assistant
	updBody := `{"id":` + jsonNumber(createResp.Data.ID) + `,"real_name":"助教王二","status":0}`
	reqUpd := httptest.NewRequest(http.MethodPost, "/api/auth.php?action=assistant_update", strings.NewReader(updBody))
	reqUpd.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	recUpd := httptest.NewRecorder()
	h.ServeHTTP(recUpd, reqUpd)
	if recUpd.Code != http.StatusOK {
		t.Fatalf("assistant_update status = %d, want 200 (body=%s)", recUpd.Code, recUpd.Body.String())
	}

	// Delete assistant
	delBody := `{"id":` + jsonNumber(createResp.Data.ID) + `}`
	reqDel := httptest.NewRequest(http.MethodPost, "/api/auth.php?action=assistant_delete", strings.NewReader(delBody))
	reqDel.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	recDel := httptest.NewRecorder()
	h.ServeHTTP(recDel, reqDel)
	if recDel.Code != http.StatusOK {
		t.Fatalf("assistant_delete status = %d, want 200 (body=%s)", recDel.Code, recDel.Body.String())
	}
}

func TestAuthCheckResetPasswordValidationAndStatusNullPreservation(t *testing.T) {
	repo := newMockAuthRepo()
	oldHash, _ := auth.HashPassword("oldpass123")
	repo.addUser(auth.User{
		ID:           20,
		Username:     "教师20",
		PasswordHash: oldHash,
		RealName:     "王老师",
		Role:         "teacher",
		Status:       1,
	})
	sessStore := session.NewMemoryStore()
	rlStore := ratelimit.NewMemoryStore()
	h := httpx.Middleware(Auth(AuthDeps{
		Repo:      repo,
		Sessions:  sessStore,
		RateLimit: rlStore,
		Audit:     auditlog.NoopLogger{},
	}))

	// 1. Unauthenticated check -> loggedIn=false
	recChk0 := httptest.NewRecorder()
	h.ServeHTTP(recChk0, httptest.NewRequest(http.MethodGet, "/api/auth.php?action=check", nil))
	if recChk0.Code != http.StatusOK || !strings.Contains(recChk0.Body.String(), `"loggedIn":false`) {
		t.Fatalf("unauth check unexpected: code=%d body=%s", recChk0.Code, recChk0.Body.String())
	}

	// 2. Admin-only check -> loggedIn=true with is_admin=true
	admSID := "cccc1111dddd2222eeee3333ffff4444"
	sessStore.Set(admSID, map[string]any{
		"admin_logged_in": true,
		"admin_username":  "super",
		"admin_role":      "super_admin",
	})
	reqChkAdm := httptest.NewRequest(http.MethodGet, "/api/auth.php?action=check", nil)
	reqChkAdm.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: admSID})
	recChkAdm := httptest.NewRecorder()
	h.ServeHTTP(recChkAdm, reqChkAdm)
	if recChkAdm.Code != http.StatusOK || !strings.Contains(recChkAdm.Body.String(), `"is_admin":true`) {
		t.Fatalf("admin check unexpected: code=%d body=%s", recChkAdm.Code, recChkAdm.Body.String())
	}

	// 3. reset_password: wrong old_password triggers captcha on next attempt, >72-byte password returns 400
	reqFail := httptest.NewRequest(http.MethodPost, "/api/auth.php?action=reset_password",
		strings.NewReader(`{"username":"教师20","old_password":"wrong","new_password":"newpass456","confirm_password":"newpass456"}`))
	reqFail.RemoteAddr = "203.0.113.88:1234"
	recFail := httptest.NewRecorder()
	h.ServeHTTP(recFail, reqFail)
	if recFail.Code != http.StatusBadRequest {
		t.Fatalf("wrong old_password status = %d, want 400", recFail.Code)
	}
	failSID := extractPHPSESSIDFromRecorder(recFail)

	// Missing/wrong captcha after failure -> 400
	reqNoCap := httptest.NewRequest(http.MethodPost, "/api/auth.php?action=reset_password",
		strings.NewReader(`{"username":"教师20","old_password":"oldpass123","new_password":"newpass456"}`))
	reqNoCap.RemoteAddr = "203.0.113.88:1234"
	reqNoCap.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: failSID})
	recNoCap := httptest.NewRecorder()
	h.ServeHTTP(recNoCap, reqNoCap)
	if recNoCap.Code != http.StatusBadRequest || !strings.Contains(recNoCap.Body.String(), "验证码") {
		t.Fatalf("expected captcha error, got code=%d body=%s", recNoCap.Code, recNoCap.Body.String())
	}

	// Password > 72 bytes returns HTTP 400 (not 500) on reset_password (fresh IP/session)
	tooLongPwd := strings.Repeat("a", 80)
	reqLong := httptest.NewRequest(http.MethodPost, "/api/auth.php?action=reset_password",
		strings.NewReader(`{"username":"教师20","old_password":"oldpass123","new_password":"`+tooLongPwd+`","confirm_password":"`+tooLongPwd+`"}`))
	reqLong.RemoteAddr = "203.0.113.89:1234"
	recLong := httptest.NewRecorder()
	h.ServeHTTP(recLong, reqLong)
	if recLong.Code != http.StatusBadRequest {
		t.Fatalf("reset_password >72B status = %d, want 400 (body=%s)", recLong.Code, recLong.Body.String())
	}

	// 4. Assistant create (>72B -> 400), list, and update with status:null preserves status=1
	teacherSID := "dddd1111eeee2222ffff333300001111"
	sessStore.Set(teacherSID, map[string]any{
		"user_logged_in": true,
		"user_id":        20,
		"username":       "t20",
		"user_role":      "teacher",
	})

	reqTooLongCreate := httptest.NewRequest(http.MethodPost, "/api/auth.php?action=assistant_create",
		strings.NewReader(`{"username":"t20_01","real_name":"助教","password":"`+tooLongPwd+`"}`))
	reqTooLongCreate.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	recTooLongCreate := httptest.NewRecorder()
	h.ServeHTTP(recTooLongCreate, reqTooLongCreate)
	if recTooLongCreate.Code != http.StatusBadRequest {
		t.Fatalf("assistant_create >72B status = %d, want 400", recTooLongCreate.Code)
	}

	reqCreate := httptest.NewRequest(http.MethodPost, "/api/auth.php?action=assistant_create",
		strings.NewReader(`{"username":"T20_01","real_name":"助教一","password":"tapass123"}`))
	reqCreate.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	recCreate := httptest.NewRecorder()
	h.ServeHTTP(recCreate, reqCreate)
	if recCreate.Code != http.StatusOK {
		t.Fatalf("assistant_create status = %d (body=%s)", recCreate.Code, recCreate.Body.String())
	}

	reqList := httptest.NewRequest(http.MethodGet, "/api/auth.php?action=assistant_list", nil)
	reqList.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	recList := httptest.NewRecorder()
	h.ServeHTTP(recList, reqList)
	if recList.Code != http.StatusOK || !strings.Contains(recList.Body.String(), `"t20_01"`) {
		t.Fatalf("assistant_list unexpected: code=%d body=%s", recList.Code, recList.Body.String())
	}

	created, _ := repo.FindUserByUsername(context.Background(), "t20_01")
	if created == nil || created.Status != 1 {
		t.Fatalf("expected t20_01 status=1, got %+v", created)
	}

	// Send status: null -> must NOT disable assistant
	updNull := fmt.Sprintf(`{"id":%d,"real_name":"助教改名","status":null}`, created.ID)
	reqUpdNull := httptest.NewRequest(http.MethodPost, "/api/auth.php?action=assistant_update", strings.NewReader(updNull))
	reqUpdNull.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	recUpdNull := httptest.NewRecorder()
	h.ServeHTTP(recUpdNull, reqUpdNull)
	if recUpdNull.Code != http.StatusOK {
		t.Fatalf("assistant_update status=null HTTP %d: %s", recUpdNull.Code, recUpdNull.Body.String())
	}
	afterUpd, _ := repo.FindUserByUsername(context.Background(), "t20_01")
	if afterUpd == nil || afterUpd.Status != 1 || afterUpd.RealName != "助教改名" {
		t.Fatalf("status:null disabled assistant or failed update: %+v", afterUpd)
	}
}

func jsonNumber(v int64) string {
	b, _ := json.Marshal(v)
	return string(b)
}
