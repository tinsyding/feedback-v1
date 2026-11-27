package session

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseSubjectScope(t *testing.T) {
	tests := []struct {
		raw      string
		wantAll  bool
		wantList []string
		allow    string
		deny     string
	}{
		{"*", true, []string{"*"}, "物理", ""},
		{"all", true, []string{"*"}, "化学", ""},
		{"所有学科", true, []string{"*"}, "数学", ""},
		{"数学", false, []string{"数学"}, "数学", "物理"},
		{"数学,物理", false, []string{"数学", "物理"}, "物理", "英语"},
		{"化学、物理", false, []string{"化学", "物理"}, "化学", "数学"},
		{"", false, []string{}, "", "数学"},
	}
	for _, tc := range tests {
		sc := ParseSubjectScope(tc.raw)
		if sc.All != tc.wantAll {
			t.Errorf("ParseSubjectScope(%q).All = %v, want %v", tc.raw, sc.All, tc.wantAll)
		}
		if len(sc.Subjects) != len(tc.wantList) {
			t.Errorf("ParseSubjectScope(%q).Subjects = %v, want %v", tc.raw, sc.Subjects, tc.wantList)
		}
		if tc.allow != "" && !sc.Allows(tc.allow) {
			t.Errorf("ParseSubjectScope(%q).Allows(%q) = false, want true", tc.raw, tc.allow)
		}
		if tc.deny != "" && sc.Allows(tc.deny) {
			t.Errorf("ParseSubjectScope(%q).Allows(%q) = true, want false", tc.raw, tc.deny)
		}
	}
}

func TestRequireSubjectAccess(t *testing.T) {
	ctx := context.Background()

	// 1. Admin always allowed
	adminSess := &Session{ID: "s1", Data: map[string]any{"admin_logged_in": true}}
	rec := httptest.NewRecorder()
	if _, ok := RequireSubjectAccess(ctx, rec, adminSess, nil, "化学", "查看题库"); !ok {
		t.Fatalf("expected admin to be allowed, got status %d", rec.Code)
	}

	// 2. Single-subject teacher allowed for own subject, denied for other
	mathSess := &Session{ID: "s2", Data: map[string]any{
		"user_logged_in": true,
		"username":       "JF006",
		"user_role":      "teacher",
		"user_subject":   "数学",
	}}
	rec = httptest.NewRecorder()
	if _, ok := RequireSubjectAccess(ctx, rec, mathSess, nil, "数学", "查看题库"); !ok {
		t.Fatalf("expected math teacher allowed for 数学, got status %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	if _, ok := RequireSubjectAccess(ctx, rec, mathSess, nil, "物理", "查看题库"); ok {
		t.Fatalf("expected math teacher denied for 物理")
	}
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "当前账号仅限学科：数学") {
		t.Fatalf("unexpected error body: %s", rec.Body.String())
	}

	// 3. All-subject teacher (*) allowed for any subject
	allSess := &Session{ID: "s3", Data: map[string]any{
		"user_logged_in": true,
		"username":       "JF060",
		"user_role":      "teacher",
		"user_subject":   "*",
	}}
	rec = httptest.NewRecorder()
	if _, ok := RequireSubjectAccess(ctx, rec, allSess, nil, "英语", "保存题库"); !ok {
		t.Fatalf("expected * teacher allowed for 英语, got status %d", rec.Code)
	}

	// 4. Teacher with explicitly empty subject denied
	emptySess := &Session{ID: "s4", Data: map[string]any{
		"user_logged_in": true,
		"username":       "JF999",
		"user_role":      "teacher",
		"user_subject":   "",
	}}
	rec = httptest.NewRecorder()
	if _, ok := RequireSubjectAccess(ctx, rec, emptySess, nil, "数学", "查看题库"); ok {
		t.Fatalf("expected empty-subject teacher to be denied")
	}
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rec.Code)
	}

	// 5. Teacher logged in alongside a DIFFERENT admin session in the same browser must follow teacher's subject
	mixedSess := &Session{ID: "s5", Data: map[string]any{
		"user_logged_in":  true,
		"username":        "9999",
		"user_role":       "teacher",
		"user_subject":    "物理",
		"admin_logged_in": true,
		"admin_username":  "JF060",
	}}
	rec = httptest.NewRecorder()
	if _, ok := RequireSubjectAccess(ctx, rec, mixedSess, nil, "物理", "查看题库"); !ok {
		t.Fatalf("expected 9999 allowed for 物理, got status %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	if _, ok := RequireSubjectAccess(ctx, rec, mixedSess, nil, "数学", "查看题库"); ok {
		t.Fatalf("expected 9999 denied for 数学 even when JF060 admin session coexists")
	}
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", rec.Code)
	}
}
