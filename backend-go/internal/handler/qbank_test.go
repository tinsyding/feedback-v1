package handler

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"feedback-api/internal/auditlog"
	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
	"feedback-api/internal/qbank"
	"feedback-api/internal/qbankattest"
	"feedback-api/internal/session"
)

type mockQBankRepo struct {
	listItems     []qbank.WeekListItem
	weekDetail    *qbank.WeekDetail
	savedReq      *qbank.SaveWeekRequest
	saveErr       error
	existingWeeks map[string]bool
	removedPDFs   []string
	deletedPDFs   []string
	pdfRefCount   map[string]int
	lastFilter    qbank.ListFilter
	lastGetKey    qbank.WeekKey
	lastDeleteKey qbank.WeekKey
}

func (m *mockQBankRepo) ListWeeks(_ context.Context, f qbank.ListFilter) ([]qbank.WeekListItem, error) {
	m.lastFilter = f
	return m.listItems, nil
}

func (m *mockQBankRepo) GetWeek(_ context.Context, k qbank.WeekKey) (*qbank.WeekDetail, error) {
	m.lastGetKey = k
	return m.weekDetail, nil
}

func (m *mockQBankRepo) SaveWeek(ctx context.Context, req qbank.SaveWeekRequest) ([]string, error) {
	cp := req
	m.savedReq = &cp
	if m.saveErr != nil {
		return nil, m.saveErr
	}
	scopeKey := fmt.Sprintf("%s|%d|%s|%s|%s|%s|%d", req.BankType, req.Year, req.Season, req.Subject, req.Grade, req.Tier, req.Week)
	if m.existingWeeks == nil {
		m.existingWeeks = make(map[string]bool)
	}
	existed := m.existingWeeks[scopeKey]
	if req.OnRecordTx != nil {
		action := qbankattest.ActionCreate
		if req.SaveMode == "tier_sync" {
			action = qbankattest.ActionTierSync
		} else if existed {
			action = qbankattest.ActionUpdate
		}
		if err := req.OnRecordTx(ctx, nil, 42, action); err != nil {
			return nil, err
		}
	}
	m.existingWeeks[scopeKey] = true
	return m.removedPDFs, nil
}

func (m *mockQBankRepo) DeleteWeek(ctx context.Context, k qbank.WeekKey) ([]string, error) {
	m.lastDeleteKey = k
	if k.OnDeleteTx != nil {
		yr := 2026
		if k.Year != nil {
			yr = *k.Year
		}
		season := k.Season
		if season == "" {
			season = "秋"
		}
		if err := k.OnDeleteTx(ctx, nil, qbank.WeekScope{
			QBankID:  42,
			BankType: k.BankType,
			Year:     yr,
			Season:   season,
			Subject:  k.Subject,
			Grade:    k.Grade,
			Tier:     k.Tier,
			Week:     k.Week,
		}); err != nil {
			return nil, err
		}
	}
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
	oldModTime := time.Now().Add(-2 * time.Minute)
	_ = os.Chtimes(orphanFile, oldModTime, oldModTime)
	_ = os.Chtimes(keptFile, oldModTime, oldModTime)

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

func TestQBankListGetZeroParamsAndBodyLimit(t *testing.T) {
	root := t.TempDir()
	sessStore := session.NewMemoryStore()
	teacherSID := "2222bbbb3333cccc4444dddd5555eeee"
	sessStore.Set(teacherSID, map[string]any{
		"user_logged_in": true,
		"username":       "t101",
		"user_role":      "teacher",
	})
	repo := &mockQBankRepo{
		listItems: []qbank.WeekListItem{},
	}
	h := httpx.Middleware(QBank(QBankDeps{
		Repo:         repo,
		Sessions:     sessStore,
		ConfigLoader: config.NewLoader(root, ""),
		Audit:        auditlog.NoopLogger{},
		FeedbackRoot: root,
	}))

	// 1. GET list with year=0&season=0 leaves Year nil and Season empty
	reqList := httptest.NewRequest(http.MethodGet, "/api/qbank.php?action=list&year=0&season=0", nil)
	reqList.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	recList := httptest.NewRecorder()
	h.ServeHTTP(recList, reqList)
	if recList.Code != http.StatusOK || repo.lastFilter.Year != nil || repo.lastFilter.Season != "" {
		t.Fatalf("unexpected GET list year=0&season=0: code=%d filter=%+v", recList.Code, repo.lastFilter)
	}

	// 2. GET get returns data:null when not found, and weekDetail when found
	reqGetNil := httptest.NewRequest(http.MethodGet, "/api/qbank.php?action=get&subject=数学&grade=七年级&tier=S%2B&week=3", nil)
	reqGetNil.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	recGetNil := httptest.NewRecorder()
	h.ServeHTTP(recGetNil, reqGetNil)
	if recGetNil.Code != http.StatusOK || !strings.Contains(recGetNil.Body.String(), `"data":null`) {
		t.Fatalf("GET get not-found: code=%d body=%s", recGetNil.Code, recGetNil.Body.String())
	}

	repo.weekDetail = &qbank.WeekDetail{
		BankType:           "homework",
		Year:               2026,
		Season:             "秋",
		Subject:            "数学",
		Grade:              "七年级",
		Tier:               "S+",
		Week:               3,
		UpdatedAtFormatted: "2026-11-22 00:15",
		Questions:          []qbank.QuestionItem{},
	}
	reqGetOK := httptest.NewRequest(http.MethodGet, "/api/qbank.php?action=get&subject=数学&grade=七年级&tier=S%2B&week=3", nil)
	reqGetOK.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	recGetOK := httptest.NewRecorder()
	h.ServeHTTP(recGetOK, reqGetOK)
	if recGetOK.Code != http.StatusOK || !strings.Contains(recGetOK.Body.String(), `"2026-11-22 00:15"`) {
		t.Fatalf("GET get found: code=%d body=%s", recGetOK.Code, recGetOK.Body.String())
	}

	// 3. POST missing exercisePdf -> 400
	noPDFBody := `{"subject":"数学","grade":"七年级","tier":"S+","week":3,"questions":[{"id":1,"topic":"函数"}]}`
	reqNoPDF := httptest.NewRequest(http.MethodPost, "/api/qbank.php", strings.NewReader(noPDFBody))
	reqNoPDF.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	recNoPDF := httptest.NewRecorder()
	h.ServeHTTP(recNoPDF, reqNoPDF)
	if recNoPDF.Code != http.StatusBadRequest {
		t.Fatalf("missing exercisePdf status = %d, want 400 (%s)", recNoPDF.Code, recNoPDF.Body.String())
	}

	// 4. POST >10MB -> 413
	hugeBody := `{"pad":"` + strings.Repeat("a", (10<<20)+128) + `"}`
	reqBig := httptest.NewRequest(http.MethodPost, "/api/qbank.php", strings.NewReader(hugeBody))
	reqBig.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	recBig := httptest.NewRecorder()
	h.ServeHTTP(recBig, reqBig)
	if recBig.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("POST >10MB status = %d, want 413 (%s)", recBig.Code, recBig.Body.String())
	}

	// 5. DELETE with year=0&season=0 leaves Year nil and Season empty
	reqDelZero := httptest.NewRequest(http.MethodDelete, "/api/qbank.php?subject=数学&grade=七年级&tier=S%2B&week=3&year=0&season=0", nil)
	reqDelZero.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	recDelZero := httptest.NewRecorder()
	h.ServeHTTP(recDelZero, reqDelZero)
	if recDelZero.Code != http.StatusOK || repo.lastDeleteKey.Year != nil || repo.lastDeleteKey.Season != "" {
		t.Fatalf("unexpected DELETE year=0&season=0: code=%d key=%+v", recDelZero.Code, repo.lastDeleteKey)
	}
}

func TestQBankAttestationSaveDeleteRevisionsStrictAndAttempts(t *testing.T) {
	root := t.TempDir()
	pdfDir := filepath.Join(root, "data", "pdfs")
	if err := os.MkdirAll(pdfDir, 0o755); err != nil {
		t.Fatal(err)
	}
	retainedPDF := "data/pdfs/pdf_retained_180d.pdf"
	unreferencedPDF := "data/pdfs/pdf_never_attested.pdf"
	oldExpiredPDF := "data/pdfs/pdf_old_200d.pdf"
	_ = os.WriteFile(filepath.Join(pdfDir, "pdf_retained_180d.pdf"), []byte("%PDF-1.4\nretained"), 0o644)
	_ = os.WriteFile(filepath.Join(pdfDir, "pdf_never_attested.pdf"), []byte("%PDF-1.4\nunref"), 0o644)
	_ = os.WriteFile(filepath.Join(pdfDir, "pdf_old_200d.pdf"), []byte("%PDF-1.4\nexpired"), 0o644)

	now := time.Date(2026, 11, 23, 6, 0, 0, 0, time.UTC)
	signer, err := qbankattest.NewEphemeralSigner("jf-qb-handler-test")
	if err != nil {
		t.Fatal(err)
	}
	attestStore := qbankattest.NewMemoryStore(signer, root, qbankattest.WithNowFunc(func() time.Time { return now }))

	// Seed an expired (>200 days) snapshot referencing pdf_old_200d.pdf
	_, err = attestStore.RecordRevisionTx(context.Background(), nil, qbankattest.RecordRevisionInput{
		QBankID: 99, Action: qbankattest.ActionCreate,
		Scope:     qbankattest.Scope{BankType: "homework", Year: 2025, Season: "春", Subject: "数学", Grade: "七年级", Tier: "A", Week: 9},
		Operator:  "t101",
		Questions: []qbankattest.SnapshotQuestion{{QuestionNum: 1, Topic: "旧期", ExercisePDF: oldExpiredPDF}},
		Now:       now.Add(-200 * 24 * time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}

	sessStore := session.NewMemoryStore()
	teacherSID := "3333cccc4444dddd5555eeee6666ffff"
	sessStore.Set(teacherSID, map[string]any{
		"user_logged_in": true,
		"username":       "t101",
		"real_name":      "张老师",
		"user_role":      "teacher",
	})

	repo := &mockQBankRepo{
		removedPDFs: []string{retainedPDF, unreferencedPDF, oldExpiredPDF},
		pdfRefCount: map[string]int{retainedPDF: 0, unreferencedPDF: 0, oldExpiredPDF: 0},
	}
	h := httpx.Middleware(QBank(QBankDeps{
		Repo:         repo,
		Sessions:     sessStore,
		ConfigLoader: config.NewLoader(root, ""),
		Audit:        auditlog.NoopLogger{},
		Attest:       attestStore,
		FeedbackRoot: root,
	}))

	// 1. First POST -> create receipt (referencing retainedPDF)
	body1 := `{"bankType":"homework","year":2026,"season":"autumn","subject":"数学","grade":"七年级","tier":"S+","week":3,"questions":[{"id":1,"topic":"有理数","exercisePdf":{"url":"` + retainedPDF + `","name":"ex1.pdf"}}]}`
	req1 := httptest.NewRequest(http.MethodPost, "/api/qbank.php", strings.NewReader(body1))
	req1.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	req1.RemoteAddr = "198.51.100.20:1001"
	rec1 := httptest.NewRecorder()
	h.ServeHTTP(rec1, req1)
	if rec1.Code != http.StatusOK {
		t.Fatalf("first POST status = %d, body=%s", rec1.Code, rec1.Body.String())
	}
	var resp1 struct {
		Success bool                 `json:"success"`
		DBSaved bool                 `json:"dbSaved"`
		Receipt *qbankattest.Receipt `json:"receipt"`
	}
	if err := json.Unmarshal(rec1.Body.Bytes(), &resp1); err != nil {
		t.Fatal(err)
	}
	if !resp1.Success || !resp1.DBSaved || resp1.Receipt == nil || resp1.Receipt.Action != qbankattest.ActionCreate || resp1.Receipt.RevisionNo != 1 || resp1.Receipt.Operator.RealName != "张老师" {
		t.Fatalf("unexpected v1 receipt response: %+v", resp1)
	}
	// Retained PDF referenced within 180d must NOT be deleted; unreferenced & >180d expired PDFs must be deleted.
	if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(retainedPDF))); err != nil {
		t.Fatalf("expected 180d attested PDF %s to be retained, stat err=%v", retainedPDF, err)
	}
	if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(unreferencedPDF))); !os.IsNotExist(err) {
		t.Fatalf("expected unreferenced PDF %s to be deleted", unreferencedPDF)
	}
	if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(oldExpiredPDF))); !os.IsNotExist(err) {
		t.Fatalf("expected >180d expired PDF %s to be deleted", oldExpiredPDF)
	}

	// 2. Second POST (update) + Third POST (saveMode=tier_sync)
	req2 := httptest.NewRequest(http.MethodPost, "/api/qbank.php", strings.NewReader(body1))
	req2.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, req2)
	var resp2 struct {
		Receipt *qbankattest.Receipt `json:"receipt"`
	}
	_ = json.Unmarshal(rec2.Body.Bytes(), &resp2)
	if resp2.Receipt == nil || resp2.Receipt.Action != qbankattest.ActionUpdate || resp2.Receipt.RevisionNo != 2 || resp2.Receipt.Supersedes != resp1.Receipt.ReceiptCode {
		t.Fatalf("unexpected v2 receipt: %+v", resp2.Receipt)
	}

	bodySync := `{"bankType":"homework","year":2026,"season":"autumn","subject":"数学","grade":"七年级","tier":"S+","week":3,"saveMode":"tier_sync","questions":[{"id":1,"topic":"有理数","exercisePdf":{"url":"` + retainedPDF + `","name":"ex1.pdf"}}]}`
	req3 := httptest.NewRequest(http.MethodPost, "/api/qbank.php", strings.NewReader(bodySync))
	req3.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	rec3 := httptest.NewRecorder()
	h.ServeHTTP(rec3, req3)
	var resp3 struct {
		Receipt *qbankattest.Receipt `json:"receipt"`
	}
	_ = json.Unmarshal(rec3.Body.Bytes(), &resp3)
	if resp3.Receipt == nil || resp3.Receipt.Action != qbankattest.ActionTierSync || resp3.Receipt.RevisionNo != 3 {
		t.Fatalf("unexpected v3 tier_sync receipt: %+v", resp3.Receipt)
	}

	// 3. GET action=revisions returns newest-first [v3, v2, v1]
	reqRevs := httptest.NewRequest(http.MethodGet, "/api/qbank.php?action=revisions&year=2026&season=autumn&bankType=homework&subject=%E6%95%B0%E5%AD%A6&grade=%E4%B8%83%E5%B9%B4%E7%BA%A7&tier=S%2B&week=3", nil)
	reqRevs.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	recRevs := httptest.NewRecorder()
	h.ServeHTTP(recRevs, reqRevs)
	if recRevs.Code != http.StatusOK {
		t.Fatalf("GET revisions status = %d, body=%s", recRevs.Code, recRevs.Body.String())
	}
	var revsResp struct {
		Success bool                       `json:"success"`
		Data    []qbankattest.RevisionItem `json:"data"`
	}
	if err := json.Unmarshal(recRevs.Body.Bytes(), &revsResp); err != nil {
		t.Fatal(err)
	}
	if !revsResp.Success || len(revsResp.Data) != 3 || revsResp.Data[0].RevisionNo != 3 || revsResp.Data[2].RevisionNo != 1 {
		t.Fatalf("unexpected revisions response: %+v", revsResp)
	}

	// 4. GET action=get&strict=1 propagates Strict: true
	reqStrict := httptest.NewRequest(http.MethodGet, "/api/qbank.php?action=get&year=2026&season=autumn&subject=%E6%95%B0%E5%AD%A6&grade=%E4%B8%83%E5%B9%B4%E7%BA%A7&tier=S%2B&week=3&strict=1", nil)
	reqStrict.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	recStrict := httptest.NewRecorder()
	h.ServeHTTP(recStrict, reqStrict)
	if recStrict.Code != http.StatusOK || !repo.lastGetKey.Strict {
		t.Fatalf("expected Strict=true in repo.lastGetKey, got code=%d key=%+v", recStrict.Code, repo.lastGetKey)
	}

	// 5. Validation error -> 400 + save_rejected attempt; Repo error -> 500 + save_error attempt
	badBody := `{"bankType":"homework","year":2026,"season":"autumn","subject":"数学","grade":"七年级","tier":"S+","week":3,"questions":[{"id":1,"topic":"","exercisePdf":{"url":"` + retainedPDF + `"}}]}`
	reqRej := httptest.NewRequest(http.MethodPost, "/api/qbank.php", strings.NewReader(badBody))
	reqRej.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	recRej := httptest.NewRecorder()
	h.ServeHTTP(recRej, reqRej)
	if recRej.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on missing topic, got %d", recRej.Code)
	}

	repo.saveErr = errors.New("simulated mysql timeout")
	reqErr := httptest.NewRequest(http.MethodPost, "/api/qbank.php", strings.NewReader(body1))
	reqErr.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	recErr := httptest.NewRecorder()
	h.ServeHTTP(recErr, reqErr)
	if recErr.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 on repo error, got %d", recErr.Code)
	}
	repo.saveErr = nil

	// 6. POST action=log_attempt (client_blocked + save_cancelled + invalid event_type)
	for _, ev := range []string{"client_blocked", "save_cancelled"} {
		reqLog := httptest.NewRequest(http.MethodPost, "/api/qbank.php?action=log_attempt", strings.NewReader(`{"event_type":"`+ev+`","bankType":"homework","year":2026,"season":"autumn","subject":"数学","grade":"七年级","tier":"S+","week":3,"reason":"test reason","details":{"step":2}}`))
		reqLog.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
		recLog := httptest.NewRecorder()
		h.ServeHTTP(recLog, reqLog)
		if recLog.Code != http.StatusOK {
			t.Fatalf("log_attempt(%s) status = %d, body=%s", ev, recLog.Code, recLog.Body.String())
		}
	}
	reqLogBad := httptest.NewRequest(http.MethodPost, "/api/qbank.php?action=log_attempt", strings.NewReader(`{"event_type":"bogus_event"}`))
	reqLogBad.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	recLogBad := httptest.NewRecorder()
	h.ServeHTTP(recLogBad, reqLogBad)
	if recLogBad.Code != http.StatusBadRequest {
		t.Fatalf("invalid log_attempt event_type status = %d, want 400", recLogBad.Code)
	}

	tl, err := attestStore.ListTimeline(context.Background(), qbankattest.TimelineFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if tl.Stats.BlockedOrFailed != 3 || tl.Stats.Cancelled != 1 {
		t.Fatalf("expected 3 blocked_or_failed (save_rejected+save_error+client_blocked) and 1 cancelled, got %+v", tl.Stats)
	}

	// 7. DELETE /api/qbank.php emits delete receipt & marks earlier receipts DELETED
	reqDel := httptest.NewRequest(http.MethodDelete, "/api/qbank.php?year=2026&season=autumn&bankType=homework&subject=%E6%95%B0%E5%AD%A6&grade=%E4%B8%83%E5%B9%B4%E7%BA%A7&tier=S%2B&week=3", nil)
	reqDel.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	recDel := httptest.NewRecorder()
	h.ServeHTTP(recDel, reqDel)
	if recDel.Code != http.StatusOK {
		t.Fatalf("DELETE status = %d, body=%s", recDel.Code, recDel.Body.String())
	}
	var delResp struct {
		Success     bool                 `json:"success"`
		ReceiptCode string               `json:"receipt_code"`
		Receipt     *qbankattest.Receipt `json:"receipt"`
	}
	if err := json.Unmarshal(recDel.Body.Bytes(), &delResp); err != nil {
		t.Fatal(err)
	}
	if !delResp.Success || delResp.Receipt == nil || delResp.ReceiptCode == "" || delResp.Receipt.Action != qbankattest.ActionDelete {
		t.Fatalf("unexpected DELETE receipt response: %+v", delResp)
	}
	vr, err := attestStore.VerifyReceipt(context.Background(), resp3.Receipt.ReceiptCode)
	if err != nil || vr.Status != qbankattest.StatusDeleted || vr.DeletedInfo == nil || vr.DeletedInfo.ReceiptCode != delResp.ReceiptCode {
		t.Fatalf("expected v3 status DELETED pointing to %s, got %+v err=%v", delResp.ReceiptCode, vr, err)
	}
}

// ---------- SQL-level tests for qbank.MySQLRepository Strict, ListWeeks enrichment & Tx hooks ----------

type sqlQBankWireState struct {
	mu               sync.Mutex
	txCommitted      int
	txRolledBack     int
	exactMissing     bool
	failRevisionsTbl bool
	emptyRollbackRev bool
	existingWeekID   int64
}

var (
	wireSQLMu       sync.Mutex
	wireSQLRegistry = make(map[string]*sqlQBankWireState)
)

func init() {
	sql.Register("mock_qbank_wire_mysql", &wireQBankDriver{})
}

type wireQBankDriver struct{}

func (d *wireQBankDriver) Open(name string) (driver.Conn, error) {
	wireSQLMu.Lock()
	st := wireSQLRegistry[name]
	wireSQLMu.Unlock()
	if st == nil {
		return nil, fmt.Errorf("unknown dsn %q", name)
	}
	return &wireQBankConn{state: st}, nil
}

type wireQBankConn struct{ state *sqlQBankWireState }

func (c *wireQBankConn) Prepare(query string) (driver.Stmt, error) {
	return &wireQBankStmt{state: c.state, query: query}, nil
}
func (c *wireQBankConn) PrepareContext(_ context.Context, query string) (driver.Stmt, error) {
	return &wireQBankStmt{state: c.state, query: query}, nil
}
func (c *wireQBankConn) Close() error              { return nil }
func (c *wireQBankConn) Begin() (driver.Tx, error) { return c.BeginTx(context.Background(), driver.TxOptions{}) }
func (c *wireQBankConn) BeginTx(_ context.Context, _ driver.TxOptions) (driver.Tx, error) {
	return &wireQBankTx{state: c.state}, nil
}
func (c *wireQBankConn) ExecContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	c.state.mu.Lock()
	existingID := c.state.existingWeekID
	c.state.mu.Unlock()
	aff := int64(1)
	if strings.Contains(query, "INSERT INTO `qbank_weeks`") && existingID > 0 {
		aff = 2
	}
	return wireQBankRes{lastID: 42, affected: aff}, nil
}
func (c *wireQBankConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	c.state.mu.Lock()
	st := c.state
	exactMissing := st.exactMissing
	failRev := st.failRevisionsTbl
	existingID := st.existingWeekID
	c.state.mu.Unlock()

	ts := time.Date(2026, 11, 22, 4, 0, 0, 0, time.UTC)
	c.state.mu.Lock()
	emptyRollback := st.emptyRollbackRev
	c.state.mu.Unlock()
	switch {
	case strings.Contains(query, "FROM `qbank_weeks`") && strings.Contains(query, "ROUND(UNIX_TIMESTAMP(`updated_at`)*1000)") && !strings.Contains(query, "`created_by`"):
		return &wireQBankRows{
			cols: []string{"id", "bank_type", "year", "season", "subject", "grade", "tier", "week", "question_count", "updated_at_ms"},
			rows: [][]driver.Value{{int64(42), "homework", int64(2026), "秋", "数学", "七年级", "S+", int64(3), int64(1), float64(ts.UnixMilli())}},
		}, nil
	case strings.Contains(query, "FROM `qbank_weeks` qw"):
		return &wireQBankRows{
			cols: []string{"id", "ub", "real_name"},
			rows: [][]driver.Value{{int64(42), "t101", "张老师"}},
		}, nil
	case strings.Contains(query, "FROM `qbank_revisions` r1"):
		if failRev {
			return nil, errors.New("Table 'feedback.qbank_revisions' doesn't exist")
		}
		if emptyRollback {
			return &wireQBankRows{
				cols: []string{"qbank_id", "bank_type", "year", "season", "subject", "grade", "tier", "week", "receipt_code", "action", "question_count", "operator", "operator_name"},
				rows: [][]driver.Value{{int64(42), "homework", int64(2026), "秋", "数学", "七年级", "S+", int64(3), "QB-20261123-RB0000-ZERO", "admin_rollback", int64(0), "boss", "管理员"}},
			}, nil
		}
		return &wireQBankRows{
			cols: []string{"qbank_id", "bank_type", "year", "season", "subject", "grade", "tier", "week", "receipt_code", "action", "question_count", "operator", "operator_name"},
			rows: [][]driver.Value{{int64(42), "homework", int64(2026), "秋", "数学", "七年级", "S+", int64(3), "QB-20261123-AAAAAA-BBBB", "create", int64(1), "t101", "张老师"}},
		}, nil
	case strings.Contains(query, "FROM `qbank_weeks`") && strings.Contains(query, "`created_by`"):
		cols := []string{"id", "bank_type", "year", "season", "subject", "grade", "tier", "week", "question_count", "created_by", "updated_by", "updated_at", "updated_at_ms"}
		if exactMissing && strings.Contains(query, "`year` = ? AND `season` = ?") {
			return &wireQBankRows{cols: cols}, nil
		}
		return &wireQBankRows{
			cols: cols,
			rows: [][]driver.Value{{int64(42), "homework", int64(2025), "秋", "数学", "七年级", "S+", int64(3), int64(1), "t101", "t101", ts, float64(ts.UnixMilli())}},
		}, nil
	case strings.Contains(query, "SELECT `question_num`, `parent_question_num`"):
		return &wireQBankRows{
			cols: []string{"question_num", "parent_question_num", "parent_question_nums", "sub_num", "topic", "video_url", "question_meta", "exercise_pdf", "exercise_name", "answer_pdf", "answer_name"},
			rows: [][]driver.Value{{int64(1), nil, nil, int64(1), "代数", "", "", "data/pdfs/pdf_1.pdf", "1.pdf", "", ""}},
		}, nil
	case strings.Contains(query, "SELECT `id`, `parent_question_num`, `parent_question_nums`, `topic` FROM `qbank_questions` WHERE `bank_type` = 'variation'"):
		return &wireQBankRows{cols: []string{"id", "parent_question_num", "parent_question_nums", "topic"}}, nil
	case strings.Contains(query, "SELECT `real_name` FROM `users`"):
		return &wireQBankRows{cols: []string{"real_name"}, rows: [][]driver.Value{{"张老师"}}}, nil
	case strings.Contains(query, "SELECT `receipt_code`, `revision_no`, `action`, `question_count` FROM `qbank_revisions`"):
		if failRev {
			return nil, errors.New("Table 'feedback.qbank_revisions' doesn't exist")
		}
		if emptyRollback {
			return &wireQBankRows{
				cols: []string{"receipt_code", "revision_no", "action", "question_count"},
				rows: [][]driver.Value{{"QB-20261123-RB0000-ZERO", int64(5), "admin_rollback", int64(0)}},
			}, nil
		}
		return &wireQBankRows{
			cols: []string{"receipt_code", "revision_no", "action", "question_count"},
			rows: [][]driver.Value{{"QB-20261123-CCCCCC-DDDD", int64(4), "update", int64(1)}},
		}, nil
	case strings.Contains(query, "LIMIT 1 FOR UPDATE") && strings.Contains(query, "FROM `qbank_weeks`"):
		cols := []string{"id"}
		if existingID <= 0 {
			return &wireQBankRows{cols: cols}, nil
		}
		return &wireQBankRows{cols: cols, rows: [][]driver.Value{{existingID}}}, nil
	case strings.Contains(query, "SELECT `id` FROM `qbank_weeks`"):
		return &wireQBankRows{cols: []string{"id"}, rows: [][]driver.Value{{int64(42)}}}, nil
	case strings.Contains(query, "SELECT `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week` FROM `qbank_weeks`"):
		return &wireQBankRows{
			cols: []string{"bank_type", "year", "season", "subject", "grade", "tier", "week"},
			rows: [][]driver.Value{{"homework", int64(2025), "秋", "数学", "七年级", "S+", int64(3)}},
		}, nil
	case strings.Contains(query, "SELECT `exercise_pdf`, `answer_pdf` FROM `qbank_questions`"):
		return &wireQBankRows{cols: []string{"exercise_pdf", "answer_pdf"}}, nil
	default:
		return nil, fmt.Errorf("unexpected wire query: %s", query)
	}
}

type wireQBankTx struct{ state *sqlQBankWireState }

func (t *wireQBankTx) Commit() error {
	t.state.mu.Lock()
	t.state.txCommitted++
	t.state.mu.Unlock()
	return nil
}
func (t *wireQBankTx) Rollback() error {
	t.state.mu.Lock()
	t.state.txRolledBack++
	t.state.mu.Unlock()
	return nil
}

type wireQBankStmt struct {
	state *sqlQBankWireState
	query string
}

func (s *wireQBankStmt) Close() error  { return nil }
func (s *wireQBankStmt) NumInput() int { return -1 }
func (s *wireQBankStmt) Exec([]driver.Value) (driver.Result, error) {
	return wireQBankRes{lastID: 1, affected: 1}, nil
}
func (s *wireQBankStmt) ExecContext(_ context.Context, _ []driver.NamedValue) (driver.Result, error) {
	return wireQBankRes{lastID: 1, affected: 1}, nil
}
func (s *wireQBankStmt) Query([]driver.Value) (driver.Rows, error) { return nil, driver.ErrSkip }

type wireQBankRes struct {
	lastID   int64
	affected int64
}

func (r wireQBankRes) LastInsertId() (int64, error) { return r.lastID, nil }
func (r wireQBankRes) RowsAffected() (int64, error) { return r.affected, nil }

type wireQBankRows struct {
	cols []string
	rows [][]driver.Value
	idx  int
}

func (r *wireQBankRows) Columns() []string { return r.cols }
func (r *wireQBankRows) Close() error      { return nil }
func (r *wireQBankRows) Next(dest []driver.Value) error {
	if r.idx >= len(r.rows) {
		return io.EOF
	}
	copy(dest, r.rows[r.idx])
	r.idx++
	return nil
}

func TestQBankMySQLRepositoryStrictTermAttestAndEnrichment(t *testing.T) {
	st := &sqlQBankWireState{exactMissing: true}
	dsn := t.Name()
	wireSQLMu.Lock()
	wireSQLRegistry[dsn] = st
	wireSQLMu.Unlock()
	defer func() {
		wireSQLMu.Lock()
		delete(wireSQLRegistry, dsn)
		wireSQLMu.Unlock()
	}()
	db, err := sql.Open("mock_qbank_wire_mysql", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()

	repo := qbank.NewMySQLRepository(db)
	ctx := context.Background()
	yr2026 := 2026

	// 1. Strict=true returns nil, nil when exact term is missing
	strictRes, err := repo.GetWeek(ctx, qbank.WeekKey{
		Year: &yr2026, Season: "春", Subject: "数学", Grade: "七年级", Tier: "S+", Week: 3, BankType: "homework", Strict: true,
	})
	if err != nil || strictRes != nil {
		t.Fatalf("expected nil,nil for Strict miss, got res=%+v err=%v", strictRes, err)
	}

	// 2. Strict=false falls back to old term with MatchedExactTerm=false and LatestReceiptCode
	fbRes, err := repo.GetWeek(ctx, qbank.WeekKey{
		Year: &yr2026, Season: "春", Subject: "数学", Grade: "七年级", Tier: "S+", Week: 3, BankType: "homework", Strict: false,
	})
	if err != nil || fbRes == nil || fbRes.MatchedExactTerm || fbRes.LatestReceiptCode != "QB-20261123-CCCCCC-DDDD" || fbRes.LatestRevisionNo != 4 {
		t.Fatalf("unexpected fallback GetWeek result: %+v err=%v", fbRes, err)
	}

	// 3. Exact match sets MatchedExactTerm=true
	st.exactMissing = false
	exactRes, err := repo.GetWeek(ctx, qbank.WeekKey{
		Year: &yr2026, Season: "秋", Subject: "数学", Grade: "七年级", Tier: "S+", Week: 3, BankType: "homework", Strict: true,
	})
	if err != nil || exactRes == nil || !exactRes.MatchedExactTerm || exactRes.LatestReceiptCode != "QB-20261123-CCCCCC-DDDD" {
		t.Fatalf("unexpected exact GetWeek result: %+v err=%v", exactRes, err)
	}

	// 4. ListWeeks enriches UpdatedBy, UpdatedByName, LatestReceiptCode, and degrades gracefully if qbank_revisions errors
	items, err := repo.ListWeeks(ctx, qbank.ListFilter{})
	if err != nil || len(items) != 1 || items[0].UpdatedBy != "t101" || items[0].UpdatedByName != "张老师" || items[0].LatestReceiptCode != "QB-20261123-AAAAAA-BBBB" {
		t.Fatalf("unexpected enriched ListWeeks items: %+v err=%v", items, err)
	}
	st.failRevisionsTbl = true
	degradedItems, err := repo.ListWeeks(ctx, qbank.ListFilter{})
	if err != nil || len(degradedItems) != 1 || degradedItems[0].UpdatedBy != "t101" || degradedItems[0].LatestReceiptCode != "" {
		t.Fatalf("unexpected degraded ListWeeks items: %+v err=%v", degradedItems, err)
	}

	// 5. SaveWeek resolves create vs update vs tier_sync and rolls back when OnRecordTx fails
	var gotAction string
	_, err = repo.SaveWeek(ctx, qbank.SaveWeekRequest{
		BankType: "homework", Year: 2026, Season: "秋", Subject: "数学", Grade: "七年级", Tier: "S+", Week: 3, Operator: "t101",
		Questions: []qbank.SaveQuestionInput{{QuestionNum: 1, SubNum: 1, Topic: "T", ExerciseURL: "data/pdfs/pdf_1.pdf"}},
		OnRecordTx: func(_ context.Context, tx *sql.Tx, qbankID int64, action string) error {
			if tx == nil || qbankID != 42 {
				return fmt.Errorf("expected non-nil tx and qbankID=42")
			}
			gotAction = action
			return nil
		},
	})
	if err != nil || gotAction != "create" {
		t.Fatalf("SaveWeek create hook: action=%q err=%v", gotAction, err)
	}
	st.existingWeekID = 42
	_, err = repo.SaveWeek(ctx, qbank.SaveWeekRequest{
		BankType: "homework", Year: 2026, Season: "秋", Subject: "数学", Grade: "七年级", Tier: "S+", Week: 3, Operator: "t101",
		Questions: []qbank.SaveQuestionInput{{QuestionNum: 1, SubNum: 1, Topic: "T", ExerciseURL: "data/pdfs/pdf_1.pdf"}},
		OnRecordTx: func(_ context.Context, _ *sql.Tx, _ int64, action string) error {
			gotAction = action
			return nil
		},
	})
	if err != nil || gotAction != "update" {
		t.Fatalf("SaveWeek update hook: action=%q err=%v", gotAction, err)
	}
	prevRB := st.txRolledBack
	_, err = repo.SaveWeek(ctx, qbank.SaveWeekRequest{
		BankType: "homework", Year: 2026, Season: "秋", Subject: "数学", Grade: "七年级", Tier: "S+", Week: 3, Operator: "t101",
		SaveMode:  "tier_sync",
		Questions: []qbank.SaveQuestionInput{{QuestionNum: 1, SubNum: 1, Topic: "T", ExerciseURL: "data/pdfs/pdf_1.pdf"}},
		OnRecordTx: func(_ context.Context, _ *sql.Tx, _ int64, action string) error {
			gotAction = action
			return errors.New("attest failed")
		},
	})
	if err == nil || gotAction != "tier_sync" || st.txRolledBack <= prevRB {
		t.Fatalf("expected rollback on SaveWeek OnRecordTx failure: action=%q err=%v rb=%d/%d", gotAction, err, st.txRolledBack, prevRB)
	}

	// 6. DeleteWeek resolves DB year/season inside tx and calls OnDeleteTx
	var deletedScope qbank.WeekScope
	_, err = repo.DeleteWeek(ctx, qbank.WeekKey{
		Subject: "数学", Grade: "七年级", Tier: "S+", Week: 3, BankType: "homework",
		OnDeleteTx: func(_ context.Context, tx *sql.Tx, sc qbank.WeekScope) error {
			if tx == nil {
				return errors.New("expected non-nil tx")
			}
			deletedScope = sc
			return nil
		},
	})
	if err != nil || deletedScope.Year != 2025 || deletedScope.Season != "秋" || deletedScope.QBankID != 42 {
		t.Fatalf("unexpected DeleteWeek scope: %+v err=%v", deletedScope, err)
	}

	// 7. Zero-question admin_rollback hides LatestReceiptCode in ListWeeks and GetWeek.
	st.mu.Lock()
	st.failRevisionsTbl = false
	st.emptyRollbackRev = true
	st.mu.Unlock()
	rbList, err := repo.ListWeeks(ctx, qbank.ListFilter{})
	if err != nil || len(rbList) != 1 || rbList[0].LatestReceiptCode != "" {
		t.Fatalf("expected empty LatestReceiptCode after zero-question admin_rollback in ListWeeks, got %+v err=%v", rbList, err)
	}
	rbDetail, err := repo.GetWeek(ctx, qbank.WeekKey{
		Year: &yr2026, Season: "秋", Subject: "数学", Grade: "七年级", Tier: "S+", Week: 3, BankType: "homework", Strict: true,
	})
	if err != nil || rbDetail == nil || rbDetail.LatestReceiptCode != "" {
		t.Fatalf("expected empty LatestReceiptCode after zero-question admin_rollback in GetWeek, got %+v err=%v", rbDetail, err)
	}
}

func TestQBankDuplicateQNumZeroQNumAttemptLogAndOperatorPrecedence(t *testing.T) {
	root := t.TempDir()
	signer, _ := qbankattest.NewEphemeralSigner("jf-qb-h19")
	attestStore := qbankattest.NewMemoryStore(signer, root)
	sessStore := session.NewMemoryStore()

	// Admin session without teacher username: teacher_username param must beat admin_username (PHP parity).
	adminSID := "4444dddd5555eeee6666ffff7777aaaa"
	sessStore.Set(adminSID, map[string]any{
		"admin_logged_in": true,
		"admin_username":  "boss",
		"admin_realname":  "超级管理员",
	})

	repo := &mockQBankRepo{}
	h := httpx.Middleware(QBank(QBankDeps{
		Repo:         repo,
		Sessions:     sessStore,
		ConfigLoader: config.NewLoader(root, ""),
		Audit:        auditlog.NoopLogger{},
		Attest:       attestStore,
		FeedbackRoot: root,
	}))

	// 1. Duplicate question_num=1 deduplicates both saveQuestions and rawMaps / receipt.
	dupBody := `{"bankType":"homework","year":2026,"season":"autumn","subject":"数学","grade":"七年级","tier":"S+","week":5,"teacher_username":"t_fallback","questions":[{"id":1,"topic":"旧知识点","exercisePdf":{"url":"data/pdfs/pdf_a.pdf","name":"a.pdf"}},{"id":1,"topic":"新知识点","exercisePdf":{"url":"data/pdfs/pdf_b.pdf","name":"b.pdf"}}]}`
	reqDup := httptest.NewRequest(http.MethodPost, "/api/qbank.php", strings.NewReader(dupBody))
	reqDup.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: adminSID})
	recDup := httptest.NewRecorder()
	h.ServeHTTP(recDup, reqDup)
	if recDup.Code != http.StatusOK {
		t.Fatalf("duplicate qNum POST status=%d body=%s", recDup.Code, recDup.Body.String())
	}
	var dupResp struct {
		Success bool `json:"success"`
		Data    struct {
			Questions []map[string]any `json:"questions"`
		} `json:"data"`
		Receipt *qbankattest.Receipt `json:"receipt"`
	}
	if err := json.Unmarshal(recDup.Body.Bytes(), &dupResp); err != nil {
		t.Fatal(err)
	}
	if len(dupResp.Data.Questions) != 1 || dupResp.Receipt == nil || dupResp.Receipt.Summary.QuestionCount != 1 {
		t.Fatalf("expected deduplicated questions len=1 matching receipt QuestionCount=1, got dataLen=%d receipt=%+v", len(dupResp.Data.Questions), dupResp.Receipt)
	}
	if repo.savedReq == nil || repo.savedReq.Operator != "t_fallback" || len(repo.savedReq.RawMaps) != 1 {
		t.Fatalf("expected operator=t_fallback and len(RawMaps)=1, got %+v", repo.savedReq)
	}
	if dupResp.Receipt.Operator.Username != "t_fallback" {
		t.Fatalf("expected receipt operator t_fallback ahead of admin_username, got %+v", dupResp.Receipt.Operator)
	}

	// 2. When teacher_username is also omitted, falls back to admin_username.
	noTeacherBody := `{"bankType":"homework","year":2026,"season":"autumn","subject":"数学","grade":"七年级","tier":"S+","week":6,"questions":[{"id":1,"topic":"几何","exercisePdf":{"url":"data/pdfs/pdf_c.pdf","name":"c.pdf"}}]}`
	reqAdm := httptest.NewRequest(http.MethodPost, "/api/qbank.php", strings.NewReader(noTeacherBody))
	reqAdm.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: adminSID})
	recAdm := httptest.NewRecorder()
	h.ServeHTTP(recAdm, reqAdm)
	if recAdm.Code != http.StatusOK || repo.savedReq.Operator != "boss" || repo.savedReq.OperatorName != "超级管理员" {
		t.Fatalf("expected admin fallback operator=boss/超级管理员, got code=%d req=%+v", recAdm.Code, repo.savedReq)
	}

	// 3. qNum <= 0 returns 400 AND records EventSaveRejected attempt log.
	zeroBody := `{"bankType":"homework","year":2026,"season":"autumn","subject":"数学","grade":"七年级","tier":"S+","week":7,"questions":[{"id":0,"topic":"几何","exercisePdf":{"url":"data/pdfs/pdf_c.pdf","name":"c.pdf"}}]}`
	reqZero := httptest.NewRequest(http.MethodPost, "/api/qbank.php", strings.NewReader(zeroBody))
	reqZero.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: adminSID})
	recZero := httptest.NewRecorder()
	h.ServeHTTP(recZero, reqZero)
	if recZero.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for qNum=0, got %d", recZero.Code)
	}
	tl, err := attestStore.ListTimeline(context.Background(), qbankattest.TimelineFilter{EventType: qbankattest.EventSaveRejected})
	if err != nil || tl.Total != 1 {
		t.Fatalf("expected 1 save_rejected attempt log for qNum<=0, got tl=%+v err=%v", tl, err)
	}
}
