package handler

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"feedback-api/internal/httpx"
	"feedback-api/internal/session"
)

func buildSingleFileMultipart(t *testing.T, field, filename string, data []byte, fields map[string]string) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range fields {
		if err := mw.WriteField(k, v); err != nil {
			t.Fatal(err)
		}
	}
	if field != "" {
		fw, err := mw.CreateFormFile(field, filename)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fw.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	return &buf, mw.FormDataContentType()
}

func TestUploadPDF(t *testing.T) {
	root := t.TempDir()
	store := session.NewMemoryStore()
	teacherSID := "sess_teacher_upload_pdf_1"
	assistSID := "sess_assist_upload_pdf_1"
	store.Set(teacherSID, map[string]any{"user_logged_in": true, "user_role": "teacher"})
	store.Set(assistSID, map[string]any{"user_logged_in": true, "user_role": "assistant"})

	h := httpx.Middleware(UploadPDF(root, store))

	// 1. Unauthenticated -> 401
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/upload_pdf.php", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauth status = %d, want 401", rec.Code)
	}

	// 2. Assistant -> 403
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/upload_pdf.php", nil)
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: assistSID})
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("assistant status = %d, want 403", rec.Code)
	}

	// 3. GET -> 405
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/upload_pdf.php", nil)
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status = %d, want 405", rec.Code)
	}

	// 4. Non-PDF extension -> 400
	body, ct := buildSingleFileMultipart(t, "file", "bad.txt", []byte("%PDF-1.4"), nil)
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/upload_pdf.php", body)
	req.Header.Set("Content-Type", ct)
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad ext status = %d, want 400", rec.Code)
	}

	// 5. PDF extension but bad magic -> 400
	body, ct = buildSingleFileMultipart(t, "file", "fake.pdf", []byte("NOTPDF"), nil)
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/upload_pdf.php", body)
	req.Header.Set("Content-Type", ct)
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad magic status = %d, want 400", rec.Code)
	}

	// 6. Valid PDF -> 200 and saved on disk
	pdfPayload := []byte("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n")
	body, ct = buildSingleFileMultipart(t, "file", "topic1.pdf", pdfPayload, nil)
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/upload_pdf.php", body)
	req.Header.Set("Content-Type", ct)
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("valid PDF status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		Success      bool   `json:"success"`
		URL          string `json:"url"`
		OriginalName string `json:"originalName"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if !out.Success || !strings.HasPrefix(out.URL, "data/pdfs/pdf_") || !strings.HasSuffix(out.URL, ".pdf") || out.OriginalName != "topic1.pdf" {
		t.Fatalf("unexpected response: %+v", out)
	}
	savedPath := filepath.Join(root, filepath.FromSlash(out.URL))
	saved, err := os.ReadFile(savedPath)
	if err != nil || !bytes.Equal(saved, pdfPayload) {
		t.Fatalf("saved file mismatch: err=%v", err)
	}
	info, err := os.Stat(savedPath)
	if err != nil {
		t.Fatalf("stat saved PDF failed: %v", err)
	}
	if info.Mode().Perm() != 0644 {
		t.Fatalf("saved PDF perm = %04o, want 0644", info.Mode().Perm())
	}
	if tmps, err := filepath.Glob(filepath.Join(root, "data", "pdfs", ".tmp-*")); err != nil || len(tmps) != 0 {
		t.Fatalf("unexpected leftover temp files: %v (err=%v)", tmps, err)
	}
}
