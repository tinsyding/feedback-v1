package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"feedback-api/internal/httpx"
	"feedback-api/internal/session"
)

func TestUploadCapture(t *testing.T) {
	t.Cleanup(bgCleanupWG.Wait)
	root := t.TempDir()
	store := session.NewMemoryStore()
	assistSID := "sess_assist_capture_1234"
	store.Set(assistSID, map[string]any{"user_logged_in": true, "user_role": "assistant"})

	h := httpx.Middleware(UploadCapture(root, store))

	// 1. Unauthenticated -> 401
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/upload_capture.php", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauth status = %d, want 401", rec.Code)
	}

	// 2. Missing file -> 400 {"error":"No file"}
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/upload_capture.php", nil)
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: assistSID})
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"No file"`) {
		t.Fatalf("missing file got %d %s", rec.Code, rec.Body.String())
	}

	// 3. Disallowed extension -> 403
	body, ct := buildSingleFileMultipart(t, "file", "shell.php", []byte("<?php"), map[string]string{
		"fingerprint": "fp_01",
		"type":        "csv",
	})
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/upload_capture.php", body)
	req.Header.Set("Content-Type", ct)
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: assistSID})
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("bad ext got %d %s, want 403", rec.Code, rec.Body.String())
	}

	// 4. Valid CSV upload (allowed for assistant too) -> 200 & index.jsonl written
	body, ct = buildSingleFileMultipart(t, "file", "score(1).csv", []byte("name,score\n张三,95\n"), map[string]string{
		"fingerprint": "fp-abc/..",
		"type":        "homework",
	})
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/upload_capture.php", body)
	req.Header.Set("Content-Type", ct)
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: assistSID})
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"success":true`) {
		t.Fatalf("valid csv got %d %s", rec.Code, rec.Body.String())
	}

	idxBytes, err := os.ReadFile(filepath.Join(root, "data", "uploads", "index.jsonl"))
	if err != nil {
		t.Fatalf("missing index.jsonl: %v", err)
	}
	var entry struct {
		TS   int64  `json:"ts"`
		Rel  string `json:"rel"`
		Orig string `json:"orig"`
		Type string `json:"type"`
	}
	if err := json.Unmarshal(bytesTrimSpace(idxBytes), &entry); err != nil {
		t.Fatalf("parse index.jsonl failed: %v", err)
	}
	if entry.TS <= 0 || !strings.HasPrefix(entry.Rel, "fp-abc/") || entry.Orig != "score(1).csv" || entry.Type != "homework" {
		t.Fatalf("unexpected index entry: %+v", entry)
	}
	savedCapture := filepath.Join(root, "data", "uploads", filepath.FromSlash(entry.Rel))
	info, err := os.Stat(savedCapture)
	if err != nil {
		t.Fatalf("archived upload missing: %v", err)
	}
	if info.Mode().Perm() != 0644 {
		t.Fatalf("archived upload perm = %04o, want 0644", info.Mode().Perm())
	}
	if tmps, err := filepath.Glob(filepath.Join(filepath.Dir(savedCapture), ".tmp-*")); err != nil || len(tmps) != 0 {
		t.Fatalf("unexpected leftover temp files: %v (err=%v)", tmps, err)
	}

	// 5. Concurrent cleanup removing old empty fingerprint dir does not break concurrent upload.
	uploadDir := filepath.Join(root, "data", "uploads")
	oldFP := filepath.Join(uploadDir, "fp_old_race")
	if err := os.MkdirAll(oldFP, 0755); err != nil {
		t.Fatal(err)
	}
	oldTime := time.Now().Add(-40 * 24 * time.Hour)
	_ = os.Chtimes(oldFP, oldTime, oldTime)
	cleanupUploadCaptures(uploadDir, time.Now().Add(-30*24*time.Hour))
	if _, err := os.Stat(oldFP); !os.IsNotExist(err) {
		t.Fatalf("expected old empty fingerprint dir to be cleaned up")
	}
	body, ct = buildSingleFileMultipart(t, "file", "after_clean.csv", []byte("a,b\n1,2\n"), map[string]string{
		"fingerprint": "fp_old_race",
		"type":        "homework",
	})
	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodPost, "/api/upload_capture.php", body)
	req2.Header.Set("Content-Type", ct)
	req2.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: assistSID})
	h.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusOK || !strings.Contains(rec2.Body.String(), `"success":true`) {
		t.Fatalf("expected upload after cleanup to succeed, got %d %s", rec2.Code, rec2.Body.String())
	}
}

func bytesTrimSpace(b []byte) []byte {
	return []byte(strings.TrimSpace(string(b)))
}
