package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"

	"feedback-api/internal/admin"
	"feedback-api/internal/auditlog"
	"feedback-api/internal/auth"
	"feedback-api/internal/config"
	"feedback-api/internal/db"
	"feedback-api/internal/httpx"
	"feedback-api/internal/ratelimit"
	"feedback-api/internal/session"
)

type failingSessionStore struct {
	inner     session.Store
	loadErr   error
	updateErr error
	saveErr   error
	regenErr  error
}

func (f *failingSessionStore) Load(ctx context.Context, sid string) (*session.Session, error) {
	if f.loadErr != nil {
		return nil, f.loadErr
	}
	if f.inner == nil {
		return nil, nil
	}
	return f.inner.Load(ctx, sid)
}

func (f *failingSessionStore) Save(ctx context.Context, sess *session.Session) error {
	if f.saveErr != nil {
		return f.saveErr
	}
	if f.inner == nil {
		return nil
	}
	return f.inner.Save(ctx, sess)
}

func (f *failingSessionStore) Destroy(ctx context.Context, sid string) error {
	if f.inner == nil {
		return nil
	}
	return f.inner.Destroy(ctx, sid)
}

func (f *failingSessionStore) Update(ctx context.Context, sid string, fn func(data map[string]any) (bool, error)) (*session.Session, error) {
	if f.updateErr != nil {
		return nil, f.updateErr
	}
	if f.inner == nil {
		return nil, errors.New("nil inner")
	}
	return session.Update(ctx, f.inner, sid, fn)
}

func (f *failingSessionStore) Regenerate(ctx context.Context, oldID, newID string, fn func(data map[string]any) error) (*session.Session, error) {
	if f.regenErr != nil {
		return nil, f.regenErr
	}
	if reg, ok := f.inner.(session.AtomicRegenerator); ok {
		return reg.Regenerate(ctx, oldID, newID, fn)
	}
	return nil, errors.New("inner does not implement AtomicRegenerator")
}

type failingRateLimitStore struct {
	err error
}

func (f failingRateLimitStore) Status(context.Context, string, string, int) (ratelimit.Status, error) {
	return ratelimit.Status{}, f.err
}

func (f failingRateLimitStore) RecordFailure(context.Context, string, string, int, int, int) (ratelimit.Status, error) {
	return ratelimit.Status{}, f.err
}

func (f failingRateLimitStore) Clear(context.Context, string, string) error {
	return f.err
}

func TestLogoutFailClosedOnCookieAndCookieless200(t *testing.T) {
	mem := session.NewMemoryStore()
	sid := "active_logout_sess_1234567890"
	mem.Set(sid, map[string]any{
		"user_logged_in":  true,
		"username":        "t101",
		"admin_logged_in": true,
		"admin_username":  "boss",
	})
	failingStore := &failingSessionStore{
		inner:     mem,
		loadErr:   errors.New("mysql read timeout"),
		updateErr: errors.New("mysql update failed"),
	}

	hAuth := httpx.Middleware(Auth(AuthDeps{
		Sessions: failingStore,
		Audit:    auditlog.NoopLogger{},
	}))
	hAdmin := httpx.Middleware(Admin(AdminDeps{
		Sessions: failingStore,
		Audit:    auditlog.NoopLogger{},
	}))

	// 1. Cookieless auth logout succeeds 200 without touching DB
	recNoCookie := httptest.NewRecorder()
	hAuth.ServeHTTP(recNoCookie, httptest.NewRequest(http.MethodPost, "/api/auth.php?action=logout", nil))
	if recNoCookie.Code != http.StatusOK {
		t.Fatalf("cookieless auth logout = %d, want 200 (%s)", recNoCookie.Code, recNoCookie.Body.String())
	}

	// 2. Cookieless admin logout succeeds 200 without touching DB
	recAdminNoCookie := httptest.NewRecorder()
	hAdmin.ServeHTTP(recAdminNoCookie, httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=logout", nil))
	if recAdminNoCookie.Code != http.StatusOK {
		t.Fatalf("cookieless admin logout = %d, want 200 (%s)", recAdminNoCookie.Code, recAdminNoCookie.Body.String())
	}

	// 3. Auth logout with PHPSESSID cookie and DB Update error fails closed with 500
	reqAuthFail := httptest.NewRequest(http.MethodPost, "/api/auth.php?action=logout", nil)
	reqAuthFail.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: sid})
	recAuthFail := httptest.NewRecorder()
	hAuth.ServeHTTP(recAuthFail, reqAuthFail)
	if recAuthFail.Code != http.StatusInternalServerError {
		t.Fatalf("auth logout on DB error = %d, want 500 (%s)", recAuthFail.Code, recAuthFail.Body.String())
	}

	// 4. Admin logout with PHPSESSID cookie and DB Update error fails closed with 500
	reqAdminFail := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=logout", nil)
	reqAdminFail.Host = "feedback.wxjifang.cn"
	reqAdminFail.Header.Set("Origin", "http://feedback.wxjifang.cn")
	reqAdminFail.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: sid})
	recAdminFail := httptest.NewRecorder()
	hAdmin.ServeHTTP(recAdminFail, reqAdminFail)
	if recAdminFail.Code != http.StatusInternalServerError {
		t.Fatalf("admin logout on DB error = %d, want 500 (%s)", recAdminFail.Code, recAdminFail.Body.String())
	}

	// 5. If only Load fails while Update succeeds, logout still removes the session cleanly
	failingStore.updateErr = nil
	reqAuthRecover := httptest.NewRequest(http.MethodPost, "/api/auth.php?action=logout", nil)
	reqAuthRecover.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: sid})
	recAuthRecover := httptest.NewRecorder()
	hAuth.ServeHTTP(recAuthRecover, reqAuthRecover)
	if recAuthRecover.Code != http.StatusOK {
		t.Fatalf("auth logout when Update succeeds = %d, want 200 (%s)", recAuthRecover.Code, recAuthRecover.Body.String())
	}
	after, _ := mem.Load(context.Background(), sid)
	if after == nil || after.IsUserLoggedIn() || !after.IsAdminLoggedIn() {
		t.Fatalf("expected user cleared and admin preserved, got %+v", after)
	}
}

func TestConcurrentAuthAndAdminSessionMutationsNoLostUpdates(t *testing.T) {
	repo := newMockAuthRepo()
	// Cost 12 gives a wide enough bcrypt window to overlap with concurrent admin login.
	pwdHashBytes, err := bcrypt.GenerateFromPassword([]byte("secret123"), 12)
	if err != nil {
		t.Fatal(err)
	}
	repo.addUser(auth.User{
		ID:           7,
		Username:     "t101",
		PasswordHash: string(pwdHashBytes),
		RealName:     "张老师",
		Role:         "teacher",
		Status:       1,
	})

	admRepo := newFakeAdminRepo()
	shaSum := sha256.Sum256([]byte("AdminPass123"))
	admRepo.admins["admin"] = &admin.AdminUser{
		ID:           1,
		Username:     "admin",
		PasswordHash: hex.EncodeToString(shaSum[:]),
		RealName:     "超级管理员",
		Role:         "super_admin",
		Status:       1,
	}

	t.Run("wrong password after slow bcrypt preserves concurrent admin login", func(t *testing.T) {
		sessions := session.NewMemoryStore()
		sid := "concurrent_race_sess_1234567"
		sessions.Set(sid, map[string]any{"pref": "keep"})

		hAuth := httpx.Middleware(Auth(AuthDeps{
			Repo:      repo,
			Sessions:  sessions,
			RateLimit: ratelimit.NewMemoryStore(),
			Audit:     auditlog.NoopLogger{},
		}))

		var wg sync.WaitGroup
		wg.Add(2)

		// Goroutine 1: slow bcrypt failure on auth.php?action=login
		go func() {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodPost, "/api/auth.php?action=login", strings.NewReader(`{"username":"t101","password":"wrong"}`))
			req.RemoteAddr = "198.51.100.77:1234"
			req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: sid})
			rec := httptest.NewRecorder()
			hAuth.ServeHTTP(rec, req)
			if rec.Code != http.StatusUnauthorized {
				t.Errorf("expected 401 on wrong password, got %d", rec.Code)
			}
		}()

		// Goroutine 2: concurrent session update setting admin_logged_in while bcrypt is running
		go func() {
			defer wg.Done()
			time.Sleep(15 * time.Millisecond)
			if _, uErr := session.Update(context.Background(), sessions, sid, func(data map[string]any) (bool, error) {
				data["admin_logged_in"] = true
				data["admin_username"] = "admin"
				return true, nil
			}); uErr != nil {
				t.Errorf("concurrent admin update failed: %v", uErr)
			}
		}()

		wg.Wait()

		finalSess, _ := sessions.Load(context.Background(), sid)
		if finalSess == nil || !finalSess.IsAdminLoggedIn() || finalSess.IntVal("front_login_fail_count") != 1 || finalSess.StringVal("pref") != "keep" {
			t.Fatalf("lost update detected after wrong password bcrypt: %+v", finalSess)
		}
	})

	t.Run("successful auth login preserves concurrent admin session during atomic regenerate", func(t *testing.T) {
		sessions := session.NewMemoryStore()
		sid := "concurrent_login_ok_1234567"
		sessions.Set(sid, map[string]any{"pref": "keep"})

		hAuth := httpx.Middleware(Auth(AuthDeps{
			Repo:      repo,
			Sessions:  sessions,
			RateLimit: ratelimit.NewMemoryStore(),
			Audit:     auditlog.NoopLogger{},
		}))

		var wg sync.WaitGroup
		wg.Add(2)

		var newSID string
		go func() {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodPost, "/api/auth.php?action=login", strings.NewReader(`{"username":"t101","password":"secret123"}`))
			req.RemoteAddr = "198.51.100.78:1234"
			req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: sid})
			rec := httptest.NewRecorder()
			hAuth.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Errorf("expected 200 on login, got %d (%s)", rec.Code, rec.Body.String())
				return
			}
			newSID = extractPHPSESSIDFromRecorder(rec)
		}()

		go func() {
			defer wg.Done()
			time.Sleep(15 * time.Millisecond)
			if _, uErr := session.Update(context.Background(), sessions, sid, func(data map[string]any) (bool, error) {
				data["admin_logged_in"] = true
				data["admin_username"] = "admin"
				return true, nil
			}); uErr != nil {
				t.Errorf("concurrent admin update failed: %v", uErr)
			}
		}()

		wg.Wait()

		if newSID == "" || newSID == sid {
			t.Fatalf("expected rotated PHPSESSID, got %q", newSID)
		}
		finalSess, _ := sessions.Load(context.Background(), newSID)
		if finalSess == nil || !finalSess.IsUserLoggedIn() || !finalSess.IsAdminLoggedIn() || finalSess.StringVal("pref") != "keep" {
			t.Fatalf("concurrent admin session lost during auth Regenerate: %+v", finalSess)
		}
	})

	t.Run("admin login preserves foreground user session added concurrently before regenerate", func(t *testing.T) {
		sessions := session.NewMemoryStore()
		sid := "concurrent_admin_login_12345"
		sessions.Set(sid, map[string]any{"user_logged_in": true, "username": "t101"})

		hAdmin := httpx.Middleware(Admin(AdminDeps{
			Repo:      admRepo,
			Sessions:  sessions,
			RateLimit: ratelimit.NewMemoryStore(),
			Audit:     auditlog.NoopLogger{},
		}))

		req := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=login", strings.NewReader(`{"username":"admin","password":"AdminPass123"}`))
		req.Host = "feedback.wxjifang.cn"
		req.Header.Set("Origin", "http://feedback.wxjifang.cn")
		req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: sid})
		rec := httptest.NewRecorder()
		hAdmin.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("admin login failed: %d %s", rec.Code, rec.Body.String())
		}
		newSID := extractPHPSESSIDFromRecorder(rec)
		if newSID == "" || newSID == sid {
			t.Fatalf("expected rotated sid, got %q", newSID)
		}
		finalSess, _ := sessions.Load(context.Background(), newSID)
		if finalSess == nil || !finalSess.IsAdminLoggedIn() || !finalSess.IsUserLoggedIn() {
			t.Fatalf("expected both admin and user sessions preserved, got %+v", finalSess)
		}
	})

	t.Run("reset_password preserves concurrent admin session", func(t *testing.T) {
		sessions := session.NewMemoryStore()
		sid := "concurrent_reset_pwd_123456"
		sessions.Set(sid, map[string]any{"pref": "keep"})

		hAuth := httpx.Middleware(Auth(AuthDeps{
			Repo:      repo,
			Sessions:  sessions,
			RateLimit: ratelimit.NewMemoryStore(),
			Audit:     auditlog.NoopLogger{},
		}))

		var wg sync.WaitGroup
		wg.Add(2)

		go func() {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodPost, "/api/auth.php?action=reset_password", strings.NewReader(`{"username":"t101","old_password":"wrong","new_password":"newpass456","confirm_password":"newpass456"}`))
			req.RemoteAddr = "198.51.100.79:1234"
			req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: sid})
			rec := httptest.NewRecorder()
			hAuth.ServeHTTP(rec, req)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("expected 400 on wrong old password, got %d", rec.Code)
			}
		}()

		go func() {
			defer wg.Done()
			time.Sleep(15 * time.Millisecond)
			if _, uErr := session.Update(context.Background(), sessions, sid, func(data map[string]any) (bool, error) {
				data["admin_logged_in"] = true
				data["admin_username"] = "admin"
				return true, nil
			}); uErr != nil {
				t.Errorf("concurrent admin update failed: %v", uErr)
			}
		}()

		wg.Wait()

		finalSess, _ := sessions.Load(context.Background(), sid)
		if finalSess == nil || !finalSess.IsAdminLoggedIn() || finalSess.IntVal("reset_pwd_fail_count") != 1 || finalSess.StringVal("pref") != "keep" {
			t.Fatalf("lost update detected after reset_password bcrypt: %+v", finalSess)
		}
	})
}

func TestRateLimitFallbackLocksOutWhenDBUnreachableOrErroring(t *testing.T) {
	// 1. Unreachable DB handle (DB_PORT=1 equivalent) wrapped in NewResilientStore
	sqlDB, _ := db.Open(config.DBConfig{
		Host:     "127.0.0.1",
		Port:     1,
		DBName:   "offline",
		Username: "nobody",
	})
	if sqlDB != nil {
		t.Cleanup(func() { _ = sqlDB.Close() })
	}
	resilientRL := ratelimit.NewResilientStore(sqlDB)

	repo := newMockAuthRepo()
	pwdHash, _ := auth.HashPassword("secret123")
	repo.addUser(auth.User{ID: 1, Username: "teacher_rl", PasswordHash: pwdHash, Status: 1})

	h := httpx.Middleware(Auth(AuthDeps{
		Repo:      repo,
		Sessions:  session.NewMemoryStore(),
		RateLimit: resilientRL,
		Audit:     auditlog.NoopLogger{},
	}))

	// Check returns 200 even with DB_PORT=1
	recChk := httptest.NewRecorder()
	h.ServeHTTP(recChk, httptest.NewRequest(http.MethodGet, "/api/auth.php?action=check", nil))
	if recChk.Code != http.StatusOK {
		t.Fatalf("check status = %d, want 200", recChk.Code)
	}

	// 5 cookieless wrong-password failures on unique IP -> 6th attempt returns 429 via fallback!
	// Note: IP rate limit triggers captcha requirement after 1st failure, so supply captcha or trigger on username='0' / missing captcha?
	//Wait: username='teacher_rl' requires captcha after 1st failure, so use a cookie+captcha or check failingRateLimitStore on admin_login (no captcha).
	// Actually, wrong captcha still records front_login_ip failure (10 attempts), while admin_login locks out at 5 attempts without captcha.
	// Let's verify BOTH: admin_login locks out at 6th attempt (429), and auth login with valid captcha locks out at 6th attempt (429)!
	sessStore := session.NewMemoryStore()
	hAuthWithCap := httpx.Middleware(Auth(AuthDeps{
		Repo:      repo,
		Sessions:  sessStore,
		RateLimit: resilientRL,
		Audit:     auditlog.NoopLogger{},
	}))
	for i := 0; i < 5; i++ {
		sid := "rl_fallback_sess_1234567890"
		sessStore.Set(sid, map[string]any{"front_captcha_code": "abcd", "front_captcha_time": time.Now().Unix()})
		req := httptest.NewRequest(http.MethodPost, "/api/auth.php?action=login", strings.NewReader(`{"username":"teacher_rl","password":"wrong","captcha":"abcd"}`))
		req.RemoteAddr = "198.51.100.201:1234"
		req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: sid})
		rec := httptest.NewRecorder()
		hAuthWithCap.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d status = %d, want 401 (%s)", i+1, rec.Code, rec.Body.String())
		}
	}
	reqLocked := httptest.NewRequest(http.MethodPost, "/api/auth.php?action=login", strings.NewReader(`{"username":"teacher_rl","password":"secret123"}`))
	reqLocked.RemoteAddr = "198.51.100.201:1234"
	recLocked := httptest.NewRecorder()
	hAuthWithCap.ServeHTTP(recLocked, reqLocked)
	if recLocked.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 lockout via ResilientStore fallback, got %d (%s)", recLocked.Code, recLocked.Body.String())
	}

	// 2. Direct failing RateLimit store in AdminDeps still locks out via handler fallback (no fail-open)
	hAdminBrokenRL := httpx.Middleware(Admin(AdminDeps{
		Repo:      newFakeAdminRepo(),
		Sessions:  session.NewMemoryStore(),
		RateLimit: failingRateLimitStore{err: errors.New("Error 1146: Table auth_rate_limits doesn't exist")},
		Audit:     auditlog.NoopLogger{},
	}))
	for i := 0; i < 5; i++ {
		req := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=login", strings.NewReader(`{"username":"admin","password":"wrong"}`))
		req.Host = "feedback.wxjifang.cn"
		req.Header.Set("Origin", "http://feedback.wxjifang.cn")
		req.RemoteAddr = "198.51.100.202:1234"
		rec := httptest.NewRecorder()
		hAdminBrokenRL.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("admin attempt %d status = %d, want 401", i+1, rec.Code)
		}
	}
	reqAdminLocked := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/admin.php?action=login", strings.NewReader(`{"username":"admin","password":"AdminPass123"}`))
	reqAdminLocked.Host = "feedback.wxjifang.cn"
	reqAdminLocked.Header.Set("Origin", "http://feedback.wxjifang.cn")
	reqAdminLocked.RemoteAddr = "198.51.100.202:1234"
	recAdminLocked := httptest.NewRecorder()
	hAdminBrokenRL.ServeHTTP(recAdminLocked, reqAdminLocked)
	if recAdminLocked.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 lockout via handler fallback on erroring RateLimit store, got %d (%s)", recAdminLocked.Code, recAdminLocked.Body.String())
	}
}
