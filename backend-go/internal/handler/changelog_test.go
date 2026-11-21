package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"feedback-api/internal/httpx"
	"feedback-api/internal/session"
)

func TestChangelog(t *testing.T) {
	root := t.TempDir()
	store := session.NewMemoryStore()
	teacherSID := "sess_teacher_changelog1"
	adminSID := "sess_admin_changelog_12"
	store.Set(teacherSID, map[string]any{"user_logged_in": true, "user_role": "teacher"})
	store.Set(adminSID, map[string]any{"admin_logged_in": true, "admin_username": "admin"})

	h := httpx.Middleware(Changelog(root, store))

	// 1. Unknown action -> 400
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/changelog.php?action=bogus", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "未知的操作") {
		t.Fatalf("unknown action got %d %s", rec.Code, rec.Body.String())
	}

	// 2. Public getActive auto-initializes changelog.json -> 200
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/changelog.php?action=getActive", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "update_2026_11_12") {
		t.Fatalf("getActive got %d %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "data", "changelog.json")); err != nil {
		t.Fatalf("changelog.json not initialized: %v", err)
	}

	// 3. Teacher cannot save -> 401
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/changelog.php?action=save", strings.NewReader(`{"log":{"title":"x"}}`))
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("teacher save got %d, want 401", rec.Code)
	}

	// 4. Admin save new active item -> deactivates old item and prepends new
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/changelog.php?action=save", strings.NewReader(`{"log":{"id":"v1_3","version":"v1.3.0","title":"新功能","active":true,"items":[]}}`))
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: adminSID})
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin save got %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/changelog.php?action=getAll", nil)
	h.ServeHTTP(rec, req)
	var allResp struct {
		Success bool             `json:"success"`
		Data    []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &allResp); err != nil {
		t.Fatal(err)
	}
	if !allResp.Success || len(allResp.Data) != 2 {
		t.Fatalf("expected 2 entries, got %+v", allResp)
	}
	if allResp.Data[0]["id"] != "v1_3" || allResp.Data[0]["active"] != true || allResp.Data[1]["active"] != false {
		t.Fatalf("unexpected active ordering: %+v", allResp.Data)
	}

	// 5. setActive back to old entry, then delete new entry
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/changelog.php?action=setActive", strings.NewReader(`{"id":"update_2026_11_12"}`))
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: adminSID})
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("setActive got %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/changelog.php?action=delete", strings.NewReader(`{"id":"v1_3"}`))
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: adminSID})
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete got %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/changelog.php?action=getActive", nil)
	h.ServeHTTP(rec, req)
	if !strings.Contains(rec.Body.String(), "update_2026_11_12") {
		t.Fatalf("expected update_2026_11_12 active again, got %s", rec.Body.String())
	}
}
