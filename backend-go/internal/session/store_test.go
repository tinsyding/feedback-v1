package session

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRequireAuthAndRoleHelpers(t *testing.T) {
	store := NewMemoryStore()
	teacherSID := "sess_teacher_1234567890"
	assistantSID := "sess_assist_1234567890"
	adminSID := "sess_admin_12345678901"

	store.Set(teacherSID, map[string]any{
		"user_logged_in": true,
		"username":       "teacher1",
		"user_role":      "teacher",
	})
	store.Set(assistantSID, map[string]any{
		"user_logged_in": true,
		"username":       "teacher1_a1",
		"user_role":      "assistant",
	})
	store.Set(adminSID, map[string]any{
		"admin_logged_in": true,
		"admin_username":  "superadmin",
		"user_role":       "assistant", // admin_logged_in always overrides assistant restriction
	})

	// Missing cookie -> 401
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/upload_pdf.php", nil)
	if _, ok := RequireAuth(rec, req, store); ok {
		t.Fatal("expected missing cookie to fail")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}

	// Teacher cookie -> passes RequireAuth and RequireNonAssistant, fails RequireAdmin
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/upload_pdf.php", nil)
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	sess, ok := RequireAuth(rec, req, store)
	if !ok || sess.Username() != "teacher1" {
		t.Fatalf("expected teacher auth pass, got %v %+v", ok, sess)
	}
	if !RequireNonAssistant(rec, sess, "上传或修改题库 PDF") {
		t.Fatal("teacher should pass RequireNonAssistant")
	}
	recAdmin := httptest.NewRecorder()
	if _, ok := RequireAdmin(recAdmin, req, store); ok || recAdmin.Code != http.StatusUnauthorized {
		t.Fatalf("teacher should fail RequireAdmin with 401, got ok=%v code=%d", ok, recAdmin.Code)
	}

	// Assistant cookie -> passes RequireAuth, fails RequireNonAssistant with 403
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/upload_pdf.php", nil)
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: assistantSID})
	sess, ok = RequireAuth(rec, req, store)
	if !ok {
		t.Fatal("assistant should pass RequireAuth")
	}
	if RequireNonAssistant(rec, sess, "上传或修改题库 PDF") {
		t.Fatal("assistant should fail RequireNonAssistant")
	}
	if rec.Code != http.StatusForbidden {
		t.Fatalf("assistant status = %d, want 403", rec.Code)
	}

	// Admin cookie -> passes RequireAuth, RequireNonAssistant, and RequireAdmin
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/changelog.php", nil)
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: adminSID})
	sess, ok = RequireAdmin(rec, req, store)
	if !ok || sess.AdminUsername() != "superadmin" {
		t.Fatalf("admin should pass RequireAdmin, got ok=%v", ok)
	}
	if !RequireNonAssistant(rec, sess, "上传或修改题库 PDF") {
		t.Fatal("admin should bypass assistant restriction")
	}

	// Nil DB fail-closed
	nilStore := NewMySQLStore(nil)
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/upload_pdf.php", nil)
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	if _, ok := RequireAuth(rec, req, nilStore); ok || rec.Code != http.StatusUnauthorized {
		t.Fatalf("nil MySQLStore must fail closed with 401, got ok=%v code=%d", ok, rec.Code)
	}
}
