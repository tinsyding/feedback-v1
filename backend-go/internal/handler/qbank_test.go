package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"feedback-api/internal/auditlog"
	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
	"feedback-api/internal/qbank"
	"feedback-api/internal/session"
)

type mockQBankRepo struct {
	listItems   []qbank.WeekListItem
	weekDetail  *qbank.WeekDetail
	savedReq    *qbank.SaveWeekRequest
	removedPDFs []string
	deletedPDFs []string
	pdfRefCount map[string]int
}

func (m *mockQBankRepo) ListWeeks(_ context.Context, _ qbank.ListFilter) ([]qbank.WeekListItem, error) {
	return m.listItems, nil
}

func (m *mockQBankRepo) GetWeek(_ context.Context, _ qbank.WeekKey) (*qbank.WeekDetail, error) {
	return m.weekDetail, nil
}

func (m *mockQBankRepo) SaveWeek(_ context.Context, req qbank.SaveWeekRequest) ([]string, error) {
	cp := req
	m.savedReq = &cp
	return m.removedPDFs, nil
}

func (m *mockQBankRepo) DeleteWeek(_ context.Context, _ qbank.WeekKey) ([]string, error) {
	return m.deletedPDFs, nil
}

func (m *mockQBankRepo) CountPDFReferences(_ context.Context, relURL string) (int, error) {
	return m.pdfRefCount[relURL], nil
}

func TestQBankAuthAndAssistantGuards(t *testing.T) {
	root := t.TempDir()
	sessStore := session.NewMemoryStore()
	repo := &mockQBankRepo{}
	h := httpx.Middleware(QBank(QBankDeps{
		Repo:         repo,
		Sessions:     sessStore,
		ConfigLoader: config.NewLoader(root, ""),
		Audit:        auditlog.NoopLogger{},
		FeedbackRoot: root,
	}))

	// 1. Unauthenticated GET -> 401
	reqUnauth := httptest.NewRequest(http.MethodGet, "/api/qbank.php?action=list", nil)
	recUnauth := httptest.NewRecorder()
	h.ServeHTTP(recUnauth, reqUnauth)
	if recUnauth.Code != http.StatusUnauthorized {
		t.Fatalf("unauth GET status = %d, want 401", recUnauth.Code)
	}

	// 2. Assistant can GET list (200), but POST & DELETE -> 403
	taSID := "aaaa1111bbbb2222cccc3333dddd4444"
	sessStore.Set(taSID, map[string]any{
		"user_logged_in": true,
		"username":       "t101_01",
		"user_role":      "assistant",
	})

	reqList := httptest.NewRequest(http.MethodGet, "/api/qbank.php?action=list", nil)
	reqList.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: taSID})
	recList := httptest.NewRecorder()
	h.ServeHTTP(recList, reqList)
	if recList.Code != http.StatusOK {
		t.Fatalf("assistant GET list status = %d, want 200", recList.Code)
	}

	reqPost := httptest.NewRequest(http.MethodPost, "/api/qbank.php", strings.NewReader(`{}`))
	reqPost.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: taSID})
	recPost := httptest.NewRecorder()
	h.ServeHTTP(recPost, reqPost)
	if recPost.Code != http.StatusForbidden {
		t.Fatalf("assistant POST status = %d, want 403", recPost.Code)
	}

	reqDel := httptest.NewRequest(http.MethodDelete, "/api/qbank.php?subject=数学&grade=七年级&tier=S&week=1", nil)
	reqDel.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: taSID})
	recDel := httptest.NewRecorder()
	h.ServeHTTP(recDel, reqDel)
	if recDel.Code != http.StatusForbidden {
		t.Fatalf("assistant DELETE status = %d, want 403", recDel.Code)
	}
}

func TestQBankSaveValidationOrphanCleanupAndDelete(t *testing.T) {
	root := t.TempDir()
	pdfDir := filepath.Join(root, "data", "pdfs")
	if err := os.MkdirAll(pdfDir, 0755); err != nil {
		t.Fatal(err)
	}
	orphanFile := filepath.Join(pdfDir, "pdf_old_orphan.pdf")
	keptFile := filepath.Join(pdfDir, "pdf_still_used.pdf")
	_ = os.WriteFile(orphanFile, []byte("%PDF-1.4"), 0644)
	_ = os.WriteFile(keptFile, []byte("%PDF-1.4"), 0644)

	sessStore := session.NewMemoryStore()
	teacherSID := "1111aaaa2222bbbb3333cccc4444dddd"
	sessStore.Set(teacherSID, map[string]any{
		"user_logged_in": true,
		"username":       "t101",
		"user_role":      "teacher",
	})

	repo := &mockQBankRepo{
		removedPDFs: []string{"data/pdfs/pdf_old_orphan.pdf", "data/pdfs/pdf_still_used.pdf"},
		deletedPDFs: []string{"data/pdfs/pdf_still_used.pdf"},
		pdfRefCount: map[string]int{
			"data/pdfs/pdf_old_orphan.pdf": 0,
			"data/pdfs/pdf_still_used.pdf": 1,
		},
	}

	h := httpx.Middleware(QBank(QBankDeps{
		Repo:         repo,
		Sessions:     sessStore,
		ConfigLoader: config.NewLoader(root, ""),
		Audit:        auditlog.NoopLogger{},
		FeedbackRoot: root,
	}))

	// 1. Homework with missing topic -> 400
	badBody := `{"subject":"数学","grade":"七年级","tier":"S+","week":3,"questions":[{"id":1,"topic":"   ","exercisePdf":{"url":"data/pdfs/pdf_1.pdf"}}]}`
	reqBad := httptest.NewRequest(http.MethodPost, "/api/qbank.php", strings.NewReader(badBody))
	reqBad.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	recBad := httptest.NewRecorder()
	h.ServeHTTP(recBad, reqBad)
	if recBad.Code != http.StatusBadRequest {
		t.Fatalf("missing topic status = %d, want 400 (body=%s)", recBad.Code, recBad.Body.String())
	}

	// 2. Preview allows empty topic + valid save cleans trailing punctuation & orphan PDF
	okBody := `{"bankType":"homework","year":2026,"season":"autumn","subject":"数学","grade":"七年级","tier":"S+","week":3,"questions":[{"id":1,"topic":"有理数运算，。；","exercisePdf":{"url":"data/pdfs/pdf_new.pdf","name":"q1.pdf"}}]}`
	reqOK := httptest.NewRequest(http.MethodPost, "/api/qbank.php", strings.NewReader(okBody))
	reqOK.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	recOK := httptest.NewRecorder()
	h.ServeHTTP(recOK, reqOK)
	if recOK.Code != http.StatusOK {
		t.Fatalf("valid POST status = %d, want 200 (body=%s)", recOK.Code, recOK.Body.String())
	}
	var saveResp map[string]any
	if err := json.Unmarshal(recOK.Body.Bytes(), &saveResp); err != nil {
		t.Fatal(err)
	}
	if saveResp["success"] != true || saveResp["dbSaved"] != true {
		t.Fatalf("unexpected saveResp: %+v", saveResp)
	}
	if repo.savedReq == nil || repo.savedReq.Season != "秋" || repo.savedReq.Questions[0].Topic != "有理数运算" {
		t.Fatalf("unexpected savedReq: %+v", repo.savedReq)
	}
	if _, err := os.Stat(orphanFile); !os.IsNotExist(err) {
		t.Fatal("expected unreferenced orphan PDF to be deleted")
	}
	if _, err := os.Stat(keptFile); err != nil {
		t.Fatal("expected still-referenced PDF to be kept")
	}

	// 3. DELETE cleans up when ref count becomes 0
	repo.pdfRefCount["data/pdfs/pdf_still_used.pdf"] = 0
	reqDel := httptest.NewRequest(http.MethodDelete, "/api/qbank.php?subject=数学&grade=七年级&tier=S%2B&week=3&year=2026&season=秋", nil)
	reqDel.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	recDel := httptest.NewRecorder()
	h.ServeHTTP(recDel, reqDel)
	if recDel.Code != http.StatusOK {
		t.Fatalf("DELETE status = %d, want 200 (body=%s)", recDel.Code, recDel.Body.String())
	}
	if _, err := os.Stat(keptFile); !os.IsNotExist(err) {
		t.Fatal("expected deleted week PDF with 0 refs to be removed")
	}
}
