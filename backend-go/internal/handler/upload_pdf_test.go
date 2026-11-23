package handler

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"feedback-api/internal/httpx"
	"feedback-api/internal/qbankattest"
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

func TestUploadPDFWithAttestSHA256AndAttemptLog(t *testing.T) {
	root := t.TempDir()
	store := session.NewMemoryStore()
	teacherSID := "sess_teacher_upload_pdf_attest"
	store.Set(teacherSID, map[string]any{
		"user_logged_in": true,
		"username":       "t101",
		"real_name":      "张老师",
		"user_role":      "teacher",
	})

	signer, err := qbankattest.NewEphemeralSigner("")
	if err != nil {
		t.Fatal(err)
	}
	attestStore := qbankattest.NewMemoryStore(signer, root)
	h := httpx.Middleware(UploadPDFWithAttest(root, store, attestStore))

	// 1. Upload with scope metadata -> returns sha256 & size AND logs upload_pdf attempt
	pdfPayload := []byte("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n")
	wantSum := sha256.Sum256(pdfPayload)
	wantSHA := hex.EncodeToString(wantSum[:])

	body, ct := buildSingleFileMultipart(t, "file", "slice_q1.pdf", pdfPayload, map[string]string{
		"bankType": "homework",
		"year":     "2026",
		"season":   "autumn",
		"subject":  "数学",
		"grade":    "七年级",
		"tier":     "S+",
		"week":     "3",
		"role":     "exercise",
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/upload_pdf.php", body)
	req.Header.Set("Content-Type", ct)
	req.RemoteAddr = "198.51.100.88:4321"
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("upload with attest status = %d, body=%s", rec.Code, rec.Body.String())
	}

	var out struct {
		Success      bool   `json:"success"`
		URL          string `json:"url"`
		OriginalName string `json:"originalName"`
		SHA256       string `json:"sha256"`
		Size         int64  `json:"size"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if !out.Success || out.SHA256 != wantSHA || out.Size != int64(len(pdfPayload)) {
		t.Fatalf("unexpected upload response: %+v (want sha256=%s size=%d)", out, wantSHA, len(pdfPayload))
	}

	tl, err := attestStore.ListTimeline(context.Background(), qbankattest.TimelineFilter{EventType: qbankattest.EventUploadPDF})
	if err != nil || tl.Total != 1 {
		t.Fatalf("expected 1 upload_pdf attempt log, got tl=%+v err=%v", tl, err)
	}
	item := tl.Items[0]
	if item.Operator != "t101" || item.OperatorName != "张老师" || item.Season != "秋" || item.Subject != "数学" || item.Week != 3 || item.FileName != "slice_q1.pdf" || item.FileSHA256 != wantSHA {
		t.Fatalf("unexpected upload_pdf timeline item: %+v", item)
	}
	if item.Details["role"] != "exercise" || item.Details["url"] != out.URL {
		t.Fatalf("unexpected upload_pdf details: %+v", item.Details)
	}

	// 2. Upload without scope metadata -> still returns sha256 & size, no extra attempt log
	bodyNoMeta, ctNoMeta := buildSingleFileMultipart(t, "file", "plain.pdf", pdfPayload, nil)
	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodPost, "/api/upload_pdf.php", bodyNoMeta)
	req2.Header.Set("Content-Type", ctNoMeta)
	req2.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	h.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusOK || !strings.Contains(rec2.Body.String(), wantSHA) {
		t.Fatalf("upload without metadata failed: code=%d body=%s", rec2.Code, rec2.Body.String())
	}
	tl2, _ := attestStore.ListTimeline(context.Background(), qbankattest.TimelineFilter{EventType: qbankattest.EventUploadPDF})
	if tl2.Total != 1 {
		t.Fatalf("expected upload without scope metadata to skip attempt log, got total=%d", tl2.Total)
	}
}
