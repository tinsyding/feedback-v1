package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"feedback-api/internal/admin"
	"feedback-api/internal/auditlog"
	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
	"feedback-api/internal/retest"
	"feedback-api/internal/session"
)

type fakeRetestRepo struct {
	mu               sync.Mutex
	revoked          map[string]bool
	lastRevokeReason string
	tokenRecord      *retest.TokenRecord
	history          retest.StudentHistoryBundle
	qbankRows        []retest.QbankQuestionRow
	accessLogs       []string
	encryptRes       retest.EncryptBatchResult
	lastEncryptIn    retest.EncryptBatchInput
	checkRes         retest.CheckBatchResult
	lastCheckIn      retest.CheckBatchInput
	weekRecRes       retest.StudentWeekResult
	lastWeekQ        retest.StudentWeekQuery
	tokenExists      bool
	revokedErr       error
	tokenExistsErr   error
}

func newFakeRetestRepo() *fakeRetestRepo {
	errStr := `[1,2]`
	score := 90.0
	return &fakeRetestRepo{
		revoked: map[string]bool{},
		tokenRecord: &retest.TokenRecord{
			Subject:        "数学",
			Grade:          "七年级",
			Tier:           "U",
			WeekNum:        1,
			PreviewWeekNum: 1,
			PreviewErrors:  []int{},
			StudentName:    "张三",
			StudentKey:     "1001_张三_七年级_数学",
			StudentID:      "1001",
			Year:           2026,
			Season:         "春",
			UpdatedUnix:    1795143600,
		},
		history: retest.StudentHistoryBundle{
			Records: []retest.StudentRecordRow{
				{
					BatchID:           1,
					BatchTier:         "U",
					WeekNum:           1,
					HomeworkScore:     &score,
					ErrorCount:        2,
					ErrorQuestionsRaw: &errStr,
					TeacherComment:    "继续加油",
					SubmissionStatus:  "submitted",
				},
			},
			WeekAverages:       map[string]float64{"1": 85.5},
			WeekAvgByBatchWeek: map[string]float64{"1:1": 85.5},
		},
		qbankRows: []retest.QbankQuestionRow{
			{ID: 1, BankType: "homework", Tier: "U", Week: 1, QuestionNum: 1, Topic: "方程", ExercisePDF: "data/pdfs/pdf_1.pdf"},
			{ID: 2, BankType: "homework", Tier: "U", Week: 1, QuestionNum: 2, Topic: "不等式", ExercisePDF: "data/pdfs/pdf_2.pdf"},
		},
		encryptRes: retest.EncryptBatchResult{
			BatchCode:    "B20261121_100000_abcd",
			ClassName:    "26春_七年级_U_数学",
			StudentCount: 1,
			Tokens:       map[string]string{"1001_张三_七年级_数学": "tok1234567"},
		},
		checkRes: retest.CheckBatchResult{
			Success:          true,
			Exists:           true,
			HasDiff:          false,
			ModifiedStudents: []map[string]any{},
		},
		weekRecRes: retest.StudentWeekResult{
			Success:  true,
			Students: []map[string]any{{"id": "1001", "name": "张三"}},
			Record:   map[string]any{"studentName": "张三", "retestToken": "tok1234567"},
		},
		tokenExists: true,
	}
}

func (f *fakeRetestRepo) CheckExistingBatch(_ context.Context, in retest.CheckBatchInput) (retest.CheckBatchResult, error) {
	f.mu.Lock()
	f.lastCheckIn = in
	f.mu.Unlock()
	return f.checkRes, nil
}
func (f *fakeRetestRepo) GetStudentWeekRecord(_ context.Context, q retest.StudentWeekQuery) (retest.StudentWeekResult, error) {
	f.mu.Lock()
	f.lastWeekQ = q
	f.mu.Unlock()
	return f.weekRecRes, nil
}
func (f *fakeRetestRepo) EncryptBatch(_ context.Context, in retest.EncryptBatchInput) (retest.EncryptBatchResult, error) {
	f.mu.Lock()
	f.lastEncryptIn = in
	f.mu.Unlock()
	return f.encryptRes, nil
}
func (f *fakeRetestRepo) FindTokenRecord(_ context.Context, token string) (*retest.TokenRecord, error) {
	if token == "missing" {
		return nil, nil
	}
	cp := *f.tokenRecord
	return &cp, nil
}
func (f *fakeRetestRepo) LoadStudentHistoryAndAverages(_ context.Context, _, _, _, _, _ string, _ []string) (retest.StudentHistoryBundle, error) {
	return f.history, nil
}
func (f *fakeRetestRepo) PreloadMultiWeekQbankRows(_ context.Context, _, _ string, _ []int, _ int, _ string) ([]retest.QbankQuestionRow, error) {
	return f.qbankRows, nil
}
func (f *fakeRetestRepo) IsTokenRevoked(_ context.Context, token string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.revokedErr != nil {
		return false, f.revokedErr
	}
	return f.revoked[token], nil
}
func (f *fakeRetestRepo) TokenExists(_ context.Context, _ string, _ bool) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.tokenExistsErr != nil {
		return false, f.tokenExistsErr
	}
	return f.tokenExists, nil
}
func (f *fakeRetestRepo) RevokeToken(_ context.Context, token, _, reason string) error {
	f.mu.Lock()
	f.revoked[token] = true
	f.lastRevokeReason = reason
	f.mu.Unlock()
	return nil
}
func (f *fakeRetestRepo) UnrevokeToken(_ context.Context, token string) error {
	f.mu.Lock()
	delete(f.revoked, token)
	f.mu.Unlock()
	return nil
}
func (f *fakeRetestRepo) LogAccess(_ context.Context, _, _, action, _, _, _ string) {
	f.mu.Lock()
	f.accessLogs = append(f.accessLogs, action)
	f.mu.Unlock()
}

func setupRetestTestEnv(t *testing.T, secret string) (http.Handler, *fakeRetestRepo, *session.MemoryStore, string, *int64) {
	t.Helper()
	dir := t.TempDir()
	cfgJSON := fmt.Sprintf(`{"retestSecret":%q,"retestQuestionSpacing":32,"retestQrCodeEnabled":false}`, secret)
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(cfgJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	nowUnix := int64(1795143600)
	repo := newFakeRetestRepo()
	sessions := session.NewMemoryStore()
	h := httpx.Middleware(Retest(RetestDeps{
		Repo:         repo,
		Sessions:     sessions,
		ConfigLoader: config.NewLoader(dir, ""),
		Audit:        auditlog.NewDualLogger(nil, dir),
		FeedbackRoot: dir,
		NowFunc:      func() time.Time { return time.Unix(nowUnix, 0) },
	}))
	return h, repo, sessions, dir, &nowUnix
}

func TestRetestMissingSecretFailsClosed(t *testing.T) {
	h, _, _, _, _ := setupRetestTestEnv(t, "")
	req := httptest.NewRequest(http.MethodGet, "http://feedback.wxjifang.cn/api/retest.php?action=captcha", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 when secret missing, got %d", rec.Code)
	}
}

func TestRetestCaptchaAndParentDecryptFlow(t *testing.T) {
	h, _, sessions, _, _ := setupRetestTestEnv(t, "prod_retest_secret_2026")

	// 1. Fetch SVG captcha
	reqCap := httptest.NewRequest(http.MethodGet, "http://feedback.wxjifang.cn/api/retest.php?action=captcha", nil)
	recCap := httptest.NewRecorder()
	h.ServeHTTP(recCap, reqCap)
	if recCap.Code != http.StatusOK || !strings.Contains(recCap.Header().Get("Content-Type"), "image/svg+xml") {
		t.Fatalf("captcha failed: %d %s", recCap.Code, recCap.Header().Get("Content-Type"))
	}
	cookies := recCap.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("expected PHPSESSID cookie from captcha")
	}
	ck := cookies[0]
	sess, _ := sessions.Load(context.Background(), ck.Value)
	savedCode := sess.StringVal("retest_captcha")
	if len(savedCode) != 4 {
		t.Fatalf("expected 4-char retest_captcha in session, got %q", savedCode)
	}

	// 2. Decrypt without credentials => needVerify
	reqGate := httptest.NewRequest(http.MethodGet, "http://feedback.wxjifang.cn/api/retest.php?action=decrypt&token=tok1234567", nil)
	reqGate.AddCookie(ck)
	recGate := httptest.NewRecorder()
	h.ServeHTTP(recGate, reqGate)
	if !strings.Contains(recGate.Body.String(), `"needVerify":true`) {
		t.Fatalf("expected needVerify gate, got %s", recGate.Body.String())
	}

	// 3. Decrypt with valid captcha + student name (with fullwidth space)
	body := fmt.Sprintf(`{"token":"tok1234567","studentName":"张　三","captcha":%q}`, strings.ToUpper(savedCode))
	reqOK := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/retest.php?action=decrypt", strings.NewReader(body))
	reqOK.AddCookie(ck)
	recOK := httptest.NewRecorder()
	h.ServeHTTP(recOK, reqOK)
	if recOK.Code != http.StatusOK || !strings.Contains(recOK.Body.String(), `"success":true`) {
		t.Fatalf("decrypt verify failed: %d %s", recOK.Code, recOK.Body.String())
	}
	if !strings.Contains(recOK.Body.String(), `"retestQuestionSpacing":32`) || !strings.Contains(recOK.Body.String(), `"retestQrCodeEnabled":false`) {
		t.Fatalf("expected spacing/qr config echoed: %s", recOK.Body.String())
	}
	if !strings.Contains(recOK.Body.String(), `data/pdfs/pdf_1.pdf`) {
		t.Fatalf("expected preloaded pdfs in response: %s", recOK.Body.String())
	}
}

func TestRetestAdminBypassAndRevocation(t *testing.T) {
	h, repo, sessions, _, nowUnix := setupRetestTestEnv(t, "prod_retest_secret_2026")

	// Valid 24h admin_sig bypasses captcha gate
	sig := admin.SignRetestAdminSig("tok1234567", *nowUnix, "prod_retest_secret_2026")
	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("http://feedback.wxjifang.cn/api/retest.php?action=decrypt&token=tok1234567&admin_sig=%s&admin_ts=%d", sig, *nowUnix), nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"success":true`) {
		t.Fatalf("admin bypass failed: %d %s", rec.Code, rec.Body.String())
	}

	// Assistant cannot revoke token => 403
	astSess := &session.Session{ID: "ast_sess_1234567890abcdef", Data: map[string]any{"user_logged_in": true, "username": "ast1", "user_role": "assistant"}}
	_ = sessions.Save(context.Background(), astSess)
	reqAst := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/retest.php?action=revoke_token", strings.NewReader(`{"token":"tok1234567"}`))
	reqAst.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: astSess.ID})
	recAst := httptest.NewRecorder()
	h.ServeHTTP(recAst, reqAst)
	if recAst.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for assistant revoke, got %d", recAst.Code)
	}

	// Teacher revokes token => 200, subsequent decrypt => 403
	tSess := &session.Session{ID: "tch_sess_1234567890abcdef", Data: map[string]any{"user_logged_in": true, "username": "t1", "user_role": "teacher"}}
	_ = sessions.Save(context.Background(), tSess)
	reqRev := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/retest.php?action=revoke_token", strings.NewReader(`{"token":"tok1234567","reason":"误发"}`))
	reqRev.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: tSess.ID})
	recRev := httptest.NewRecorder()
	h.ServeHTTP(recRev, reqRev)
	if recRev.Code != http.StatusOK || !repo.revoked["tok1234567"] {
		t.Fatalf("teacher revoke failed: %d %s", recRev.Code, recRev.Body.String())
	}

	reqRevoked := httptest.NewRequest(http.MethodGet, "http://feedback.wxjifang.cn/api/retest.php?action=decrypt&token=tok1234567", nil)
	recRevoked := httptest.NewRecorder()
	h.ServeHTTP(recRevoked, reqRevoked)
	if recRevoked.Code != http.StatusForbidden {
		t.Fatalf("expected 403 on revoked token, got %d", recRevoked.Code)
	}
}

func TestRetestTempDownloadAndTTL(t *testing.T) {
	h, _, sessions, _, nowUnix := setupRetestTestEnv(t, "prod_retest_secret_2026")

	// Unauthenticated => 401
	reqUnauth := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/retest.php?action=create_temp_download", bytes.NewReader([]byte("%PDF-1.4\nhello world")))
	recUnauth := httptest.NewRecorder()
	h.ServeHTTP(recUnauth, reqUnauth)
	if recUnauth.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", recUnauth.Code)
	}

	// Authenticated teacher uploads non-PDF => 400
	tSess := &session.Session{ID: "dl_sess_1234567890abcdefg", Data: map[string]any{"user_logged_in": true, "username": "t1"}}
	_ = sessions.Save(context.Background(), tSess)
	ck := &http.Cookie{Name: "PHPSESSID", Value: tSess.ID}

	reqBad := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/retest.php?action=create_temp_download", bytes.NewReader([]byte("NOT_A_PDF_PAYLOAD")))
	reqBad.AddCookie(ck)
	recBad := httptest.NewRecorder()
	h.ServeHTTP(recBad, reqBad)
	if recBad.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for non-PDF, got %d", recBad.Code)
	}

	// Valid PDF => 200 + download_file => 200 application/pdf
	reqOK := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/retest.php?action=create_temp_download&filename=test.pdf", bytes.NewReader([]byte("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n")))
	reqOK.AddCookie(ck)
	recOK := httptest.NewRecorder()
	h.ServeHTTP(recOK, reqOK)
	if recOK.Code != http.StatusOK {
		t.Fatalf("create_temp_download failed: %d %s", recOK.Code, recOK.Body.String())
	}
	var resp struct {
		Key string `json:"key"`
	}
	_ = json.Unmarshal(recOK.Body.Bytes(), &resp)
	if len(resp.Key) != 32 {
		t.Fatalf("expected 32-hex key, got %q", resp.Key)
	}

	reqDL := httptest.NewRequest(http.MethodGet, "http://feedback.wxjifang.cn/api/retest.php?action=download_file&key="+resp.Key, nil)
	recDL := httptest.NewRecorder()
	h.ServeHTTP(recDL, reqDL)
	if recDL.Code != http.StatusOK || recDL.Header().Get("Content-Type") != "application/pdf" {
		t.Fatalf("download_file failed: %d %s", recDL.Code, recDL.Header().Get("Content-Type"))
	}

	// Advance clock past 2 hours => 410 Gone
	*nowUnix += 7201
	reqExp := httptest.NewRequest(http.MethodGet, "http://feedback.wxjifang.cn/api/retest.php?action=download_file&key="+resp.Key, nil)
	recExp := httptest.NewRecorder()
	h.ServeHTTP(recExp, reqExp)
	if recExp.Code != http.StatusGone {
		t.Fatalf("expected 410 Gone after 2h TTL, got %d", recExp.Code)
	}
}

func TestRetestTeacherBatchActions(t *testing.T) {
	h, _, sessions, _, _ := setupRetestTestEnv(t, "prod_retest_secret_2026")
	tSess := &session.Session{ID: "tb_sess_1234567890abcdefg", Data: map[string]any{"user_logged_in": true, "username": "t1"}}
	_ = sessions.Save(context.Background(), tSess)
	ck := &http.Cookie{Name: "PHPSESSID", Value: tSess.ID}

	reqCheck := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/retest.php?action=check_existing_batch", strings.NewReader(`{"subject":"数学","grade":"七年级","tier":"U","week":1,"students":[{"name":"张三","id":"1001","score":90,"errors":[1,2]}]}`))
	reqCheck.AddCookie(ck)
	recCheck := httptest.NewRecorder()
	h.ServeHTTP(recCheck, reqCheck)
	if recCheck.Code != http.StatusOK || !strings.Contains(recCheck.Body.String(), `"exists":true`) {
		t.Fatalf("check_existing_batch failed: %d %s", recCheck.Code, recCheck.Body.String())
	}

	reqRec := httptest.NewRequest(http.MethodGet, "http://feedback.wxjifang.cn/api/retest.php?action=get_student_week_record&subject=%E6%95%B0%E5%AD%A6&grade=%E4%B8%83%E5%B9%B4%E7%BA%A7&week=1&student_name=%E5%BC%A0%E4%B8%89", nil)
	reqRec.AddCookie(ck)
	recRec := httptest.NewRecorder()
	h.ServeHTTP(recRec, reqRec)
	if recRec.Code != http.StatusOK || !strings.Contains(recRec.Body.String(), `"retestToken":"tok1234567"`) {
		t.Fatalf("get_student_week_record failed: %d %s", recRec.Code, recRec.Body.String())
	}

	reqEnc := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/retest.php?action=encrypt_batch", strings.NewReader(`{"subject":"数学","grade":"七年级","tier":"U","week":1,"students":[{"name":"张三","id":"1001","errors":[1,2]}]}`))
	reqEnc.AddCookie(ck)
	recEnc := httptest.NewRecorder()
	h.ServeHTTP(recEnc, reqEnc)
	if recEnc.Code != http.StatusOK || !strings.Contains(recEnc.Body.String(), `"batch_code":"B20261121_100000_abcd"`) {
		t.Fatalf("encrypt_batch failed: %d %s", recEnc.Code, recEnc.Body.String())
	}
}

func TestRetestDecryptDeterministicPreviewOrder(t *testing.T) {
	h, repo, _, _, nowUnix := setupRetestTestEnv(t, "prod_retest_secret_2026")

	p2 := 2
	p4 := 4
	s90 := 90.0
	e1 := "[1]"
	e2 := "[2]"
	eEmpty := "[]"
	repo.tokenRecord.WeekNum = 3
	repo.tokenRecord.PreviewWeekNum = 0
	repo.tokenRecord.PreviewErrors = nil
	repo.history.Records = []retest.StudentRecordRow{
		{
			BatchID:           1,
			BatchTier:         "U",
			WeekNum:           1,
			HomeworkScore:     &s90,
			ErrorQuestionsRaw: &e1,
			PreviewWeekNum:    &p2,
			PreviewErrorsRaw:  &e1,
		},
		{
			BatchID:          2,
			BatchTier:        "U",
			WeekNum:          3,
			PreviewWeekNum:   &p2,
			PreviewErrorsRaw: &e2,
		},
		{
			BatchID:          3,
			BatchTier:        "U",
			WeekNum:          4,
			PreviewWeekNum:   &p4,
			PreviewErrorsRaw: &eEmpty,
		},
	}
	repo.qbankRows = []retest.QbankQuestionRow{
		{ID: 1, BankType: "homework", Tier: "U", Week: 1, QuestionNum: 1, Topic: "方程", ExercisePDF: "data/pdfs/hw1_1.pdf"},
		{ID: 2, BankType: "preview", Tier: "U", Week: 2, QuestionNum: 1, Topic: "预习1", ExercisePDF: "data/pdfs/pv2_1.pdf"},
		{ID: 3, BankType: "preview", Tier: "U", Week: 2, QuestionNum: 2, Topic: "预习2", ExercisePDF: "data/pdfs/pv2_2.pdf"},
	}

	sig := admin.SignRetestAdminSig("tok1234567", *nowUnix, "prod_retest_secret_2026")
	target := fmt.Sprintf("http://feedback.wxjifang.cn/api/retest.php?action=decrypt&token=tok1234567&admin_sig=%s&admin_ts=%d", sig, *nowUnix)

	type decryptResp struct {
		Success       bool             `json:"success"`
		CurrentWeek   int              `json:"currentWeek"`
		PreviewErrors []int            `json:"previewErrors"`
		PreviewPDFs   []map[string]any `json:"previewPdfs"`
	}
	var baseline decryptResp
	for i := 0; i < 20; i++ {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("run %d: unexpected status %d: %s", i, rec.Code, rec.Body.String())
		}
		var got decryptResp
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("run %d: invalid json: %v", i, err)
		}
		if !got.Success || got.CurrentWeek != 2 || !reflect.DeepEqual(got.PreviewErrors, []int{2}) {
			t.Fatalf("run %d: unexpected decrypt output: %+v (body=%s)", i, got, rec.Body.String())
		}
		pvRaw, _ := json.Marshal(got.PreviewPDFs)
		if !strings.Contains(string(pvRaw), "data/pdfs/pv2_2.pdf") || strings.Contains(string(pvRaw), "data/pdfs/pv2_1.pdf") {
			t.Fatalf("run %d: unexpected previewPdfs: %s", i, string(pvRaw))
		}
		if i == 0 {
			baseline = got
		} else if !reflect.DeepEqual(got, baseline) {
			t.Fatalf("run %d diverged from baseline: got=%+v want=%+v", i, got, baseline)
		}
	}
}

func TestRetestConcurrentCaptchaReplayPrevented(t *testing.T) {
	h, _, sessions, _, _ := setupRetestTestEnv(t, "prod_retest_secret_2026")

	reqCap := httptest.NewRequest(http.MethodGet, "http://feedback.wxjifang.cn/api/retest.php?action=captcha", nil)
	recCap := httptest.NewRecorder()
	h.ServeHTTP(recCap, reqCap)
	if recCap.Code != http.StatusOK {
		t.Fatalf("captcha status: %d", recCap.Code)
	}
	cookies := recCap.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("expected PHPSESSID cookie")
	}
	ck := cookies[0]
	sess, _ := sessions.Load(context.Background(), ck.Value)
	savedCode := sess.StringVal("retest_captcha")
	if len(savedCode) != 4 {
		t.Fatalf("expected 4-char captcha, got %q", savedCode)
	}

	const workers = 12
	start := make(chan struct{})
	var wg sync.WaitGroup
	var okCount atomic.Int32
	var captchaErrCount atomic.Int32

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-start
			payload := fmt.Sprintf(`{"token":"tok%07d","studentName":"张三","captcha":%q}`, idx, savedCode)
			req := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/retest.php?action=decrypt", strings.NewReader(payload))
			req.Header.Set("Content-Type", "application/json")
			req.AddCookie(ck)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)

			var out struct {
				Success      bool `json:"success"`
				CaptchaError bool `json:"captchaError"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
				t.Errorf("worker %d bad json (%d): %v %s", idx, rec.Code, err, rec.Body.String())
				return
			}
			if out.Success {
				okCount.Add(1)
			} else if out.CaptchaError {
				captchaErrCount.Add(1)
			} else {
				t.Errorf("worker %d unexpected response: %s", idx, rec.Body.String())
			}
		}(i)
	}
	close(start)
	wg.Wait()

	if okCount.Load() != 1 || captchaErrCount.Load() != workers-1 {
		t.Fatalf("expected exactly 1 success and %d captchaError, got ok=%d captchaErr=%d", workers-1, okCount.Load(), captchaErrCount.Load())
	}
}

func TestRetestFormEncodedTeacherActionsAndJSONNumber(t *testing.T) {
	h, repo, sessions, _, _ := setupRetestTestEnv(t, "prod_retest_secret_2026")
	tSess := &session.Session{ID: "fm_sess_1234567890abcdefg", Data: map[string]any{"user_logged_in": true, "username": "t1", "user_role": "teacher"}}
	_ = sessions.Save(context.Background(), tSess)
	ck := &http.Cookie{Name: "PHPSESSID", Value: tSess.ID}

	// 1. Form-encoded check_existing_batch
	formCheck := url.Values{
		"subject":  {"数学"},
		"grade":    {"七年级"},
		"tier":     {"U"},
		"week":     {"3"},
		"year":     {"2026"},
		"season":   {"秋"},
		"students": {"[]"},
	}
	reqCheck := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/retest.php?action=check_existing_batch", strings.NewReader(formCheck.Encode()))
	reqCheck.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	reqCheck.AddCookie(ck)
	recCheck := httptest.NewRecorder()
	h.ServeHTTP(recCheck, reqCheck)
	if recCheck.Code != http.StatusOK {
		t.Fatalf("form check_existing_batch failed: %d %s", recCheck.Code, recCheck.Body.String())
	}
	if repo.lastCheckIn.Subject != "数学" || repo.lastCheckIn.Grade != "七年级" || repo.lastCheckIn.Tier != "U" || repo.lastCheckIn.Week != 3 {
		t.Fatalf("unexpected lastCheckIn: %+v", repo.lastCheckIn)
	}

	// 2. Form-encoded get_student_week_record with with_roster=1
	formWeek := url.Values{
		"subject":      {"数学"},
		"grade":        {"七年级"},
		"week":         {"2"},
		"student_name": {"张三"},
		"with_roster":  {"1"},
	}
	reqWeek := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/retest.php?action=get_student_week_record", strings.NewReader(formWeek.Encode()))
	reqWeek.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	reqWeek.AddCookie(ck)
	recWeek := httptest.NewRecorder()
	h.ServeHTTP(recWeek, reqWeek)
	if recWeek.Code != http.StatusOK {
		t.Fatalf("form get_student_week_record failed: %d %s", recWeek.Code, recWeek.Body.String())
	}
	if !repo.lastWeekQ.WithRoster || repo.lastWeekQ.Week != 2 || repo.lastWeekQ.StudentName != "张三" {
		t.Fatalf("unexpected lastWeekQ: %+v", repo.lastWeekQ)
	}

	// 3. Form-encoded revoke_token with 210-rune CJK reason -> rune-safe truncation to 200
	longReason := strings.Repeat("错", 210)
	formRev := url.Values{
		"token":  {"tok1234567"},
		"reason": {longReason},
	}
	reqRev := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/retest.php?action=revoke_token", strings.NewReader(formRev.Encode()))
	reqRev.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	reqRev.AddCookie(ck)
	recRev := httptest.NewRecorder()
	h.ServeHTTP(recRev, reqRev)
	if recRev.Code != http.StatusOK {
		t.Fatalf("form revoke_token failed: %d %s", recRev.Code, recRev.Body.String())
	}
	if !utf8.ValidString(repo.lastRevokeReason) || utf8.RuneCountInString(repo.lastRevokeReason) != 200 {
		t.Fatalf("expected 200 valid UTF-8 runes, got len=%d valid=%v", utf8.RuneCountInString(repo.lastRevokeReason), utf8.ValidString(repo.lastRevokeReason))
	}

	// 4. encrypt_batch with JSON numeric id & homeworkScore preserves exact decimal string via json.Number
	encPayload := `{"subject":"数学","grade":"七年级","tier":"U","week":1,"students":[{"name":"张三","id":20260001,"homeworkScore":95.5,"errors":[1,2]}]}`
	reqEnc := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/retest.php?action=encrypt_batch", strings.NewReader(encPayload))
	reqEnc.Header.Set("Content-Type", "application/json")
	reqEnc.AddCookie(ck)
	recEnc := httptest.NewRecorder()
	h.ServeHTTP(recEnc, reqEnc)
	if recEnc.Code != http.StatusOK {
		t.Fatalf("encrypt_batch failed: %d %s", recEnc.Code, recEnc.Body.String())
	}
	if len(repo.lastEncryptIn.Students) != 1 {
		t.Fatalf("expected 1 student, got %d", len(repo.lastEncryptIn.Students))
	}
	st := repo.lastEncryptIn.Students[0]
	if st.ID != "20260001" {
		t.Fatalf("expected exact numeric string ID 20260001, got %q", st.ID)
	}
	if st.HomeworkScore == nil || *st.HomeworkScore != 95.5 {
		t.Fatalf("expected HomeworkScore 95.5, got %v", st.HomeworkScore)
	}
}

func TestRetestCreateTempDownloadMaxBytesAndStream(t *testing.T) {
	h, _, sessions, _, _ := setupRetestTestEnv(t, "prod_retest_secret_2026")
	tSess := &session.Session{ID: "mp_sess_1234567890abcdefg", Data: map[string]any{"user_logged_in": true, "username": "t1"}}
	_ = sessions.Save(context.Background(), tSess)
	ck := &http.Cookie{Name: "PHPSESSID", Value: tSess.ID}

	// 1. Multipart > 52 MiB => 413
	var bigBuf bytes.Buffer
	mwBig := multipart.NewWriter(&bigBuf)
	fwBig, err := mwBig.CreateFormFile("file", "oversize.pdf")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = fwBig.Write([]byte("%PDF-1.4\n"))
	_, _ = fwBig.Write(bytes.Repeat([]byte("A"), (52<<20)+4096))
	_ = mwBig.Close()

	reqBig := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/retest.php?action=create_temp_download", &bigBuf)
	reqBig.Header.Set("Content-Type", mwBig.FormDataContentType())
	reqBig.AddCookie(ck)
	recBig := httptest.NewRecorder()
	h.ServeHTTP(recBig, reqBig)
	if recBig.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 for >52MiB multipart PDF, got %d (%s)", recBig.Code, recBig.Body.String())
	}

	// 2. Valid multipart PDF upload + download_file streams exact bytes & Content-Length
	pdfPayload := []byte("%PDF-1.4\n1 0 obj\n<< /Length 5 >>\nstream\nhello\nendstream\nendobj\n%%EOF\n")
	var okBuf bytes.Buffer
	mwOK := multipart.NewWriter(&okBuf)
	fwOK, err := mwOK.CreateFormFile("file", "错题本_S+班.pdf")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = fwOK.Write(pdfPayload)
	_ = mwOK.Close()

	reqOK := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/retest.php?action=create_temp_download", &okBuf)
	reqOK.Header.Set("Content-Type", mwOK.FormDataContentType())
	reqOK.AddCookie(ck)
	recOK := httptest.NewRecorder()
	h.ServeHTTP(recOK, reqOK)
	if recOK.Code != http.StatusOK {
		t.Fatalf("multipart create_temp_download failed: %d %s", recOK.Code, recOK.Body.String())
	}
	var upResp struct {
		Success     bool   `json:"success"`
		Key         string `json:"key"`
		DownloadURL string `json:"downloadUrl"`
	}
	if err := json.Unmarshal(recOK.Body.Bytes(), &upResp); err != nil || !upResp.Success || len(upResp.Key) != 32 {
		t.Fatalf("unexpected upload response: %s (%v)", recOK.Body.String(), err)
	}
	if !strings.Contains(upResp.DownloadURL, "S%2B") {
		t.Fatalf("expected + to be query-escaped as %%2B in downloadUrl, got %q", upResp.DownloadURL)
	}

	reqDL := httptest.NewRequest(http.MethodGet, "http://feedback.wxjifang.cn/"+upResp.DownloadURL, nil)
	recDL := httptest.NewRecorder()
	h.ServeHTTP(recDL, reqDL)
	if recDL.Code != http.StatusOK {
		t.Fatalf("download_file status=%d body=%s", recDL.Code, recDL.Body.String())
	}
	if recDL.Header().Get("Content-Type") != "application/pdf" {
		t.Fatalf("unexpected Content-Type: %q", recDL.Header().Get("Content-Type"))
	}
	if !strings.Contains(recDL.Header().Get("Content-Disposition"), "S%2B") {
		t.Fatalf("expected Content-Disposition to preserve S+ as S%%2B, got %q", recDL.Header().Get("Content-Disposition"))
	}
	if recDL.Header().Get("Content-Length") != strconv.Itoa(len(pdfPayload)) {
		t.Fatalf("unexpected Content-Length: %q want %d", recDL.Header().Get("Content-Length"), len(pdfPayload))
	}
	bodyBytes, err := io.ReadAll(recDL.Result().Body)
	if err != nil || !bytes.Equal(bodyBytes, pdfPayload) {
		t.Fatalf("streamed bytes mismatch: err=%v len=%d want=%d", err, len(bodyBytes), len(pdfPayload))
	}
}

func TestRetestCreateTempDownloadParentVerifiedToken(t *testing.T) {
	h, _, sessions, _, _ := setupRetestTestEnv(t, "test-retest-secret")
	tok := "parent_tok_123"
	parentSID := "parent11223344556677889900aabbcc"
	sessions.Set(parentSID, map[string]any{
		verifiedTokenSessionKey(tok): "1",
	})

	pdfPayload := []byte("%PDF-1.4\n%%EOF\n")
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	_ = mw.WriteField("token", tok)
	fw, err := mw.CreateFormFile("file", "家长错题本.pdf")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = fw.Write(pdfPayload)
	_ = mw.Close()

	req := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/retest.php?action=create_temp_download", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: parentSID})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"success":true`) {
		t.Fatalf("parent verified_token create_temp_download failed: %d %s", rec.Code, rec.Body.String())
	}
}

type failingUpdateSessionStore struct {
	*session.MemoryStore
	updateErr error
}

func (f *failingUpdateSessionStore) Update(_ context.Context, _ string, _ func(map[string]any) (bool, error)) (*session.Session, error) {
	return nil, f.updateErr
}

func TestRetestAuditFixes(t *testing.T) {
	t.Run("IsTokenRevoked DB error fails closed with 500 on decrypt and create_temp_download", func(t *testing.T) {
		h, repo, sessions, _, _ := setupRetestTestEnv(t, "prod_retest_secret_2026")
		repo.revokedErr = errors.New("mysql connection lost")

		reqDec := httptest.NewRequest(http.MethodGet, "http://feedback.wxjifang.cn/api/retest.php?action=decrypt&token=tok1234567", nil)
		recDec := httptest.NewRecorder()
		h.ServeHTTP(recDec, reqDec)
		if recDec.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500 on IsTokenRevoked DB error in decrypt, got %d (%s)", recDec.Code, recDec.Body.String())
		}

		tSess := &session.Session{ID: "rev_err_sess_1234567890ab", Data: map[string]any{"user_logged_in": true, "username": "t1"}}
		_ = sessions.Save(context.Background(), tSess)
		reqDL := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/retest.php?action=create_temp_download&token=tok1234567", bytes.NewReader([]byte("%PDF-1.4\nhello world\n")))
		reqDL.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: tSess.ID})
		recDL := httptest.NewRecorder()
		h.ServeHTTP(recDL, reqDL)
		if recDL.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500 on IsTokenRevoked DB error in create_temp_download, got %d (%s)", recDL.Code, recDL.Body.String())
		}
	})

	t.Run("create_temp_download validates before rate-limit and fails closed on session.Update error", func(t *testing.T) {
		h, _, sessions, _, _ := setupRetestTestEnv(t, "prod_retest_secret_2026")
		tSess := &session.Session{ID: "rl_sess_1234567890abcdefg", Data: map[string]any{"user_logged_in": true, "username": "t1"}}
		_ = sessions.Save(context.Background(), tSess)
		ck := &http.Cookie{Name: "PHPSESSID", Value: tSess.ID}

		// 35 invalid payloads must not consume the 30/hr quota
		for i := 0; i < 35; i++ {
			reqBad := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/retest.php?action=create_temp_download", bytes.NewReader([]byte("NOT_A_PDF_AT_ALL")))
			reqBad.AddCookie(ck)
			recBad := httptest.NewRecorder()
			h.ServeHTTP(recBad, reqBad)
			if recBad.Code != http.StatusBadRequest {
				t.Fatalf("invalid req %d expected 400, got %d", i, recBad.Code)
			}
		}

		// Next 30 valid PDFs succeed, 31st hits 429
		validPDF := []byte("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n")
		for i := 0; i < 30; i++ {
			reqOK := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/retest.php?action=create_temp_download", bytes.NewReader(validPDF))
			reqOK.AddCookie(ck)
			recOK := httptest.NewRecorder()
			h.ServeHTTP(recOK, reqOK)
			if recOK.Code != http.StatusOK {
				t.Fatalf("valid req %d expected 200, got %d (%s)", i, recOK.Code, recOK.Body.String())
			}
		}
		reqCap := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/retest.php?action=create_temp_download", bytes.NewReader(validPDF))
		reqCap.AddCookie(ck)
		recCap := httptest.NewRecorder()
		h.ServeHTTP(recCap, reqCap)
		if recCap.Code != http.StatusTooManyRequests {
			t.Fatalf("31st valid req expected 429, got %d", recCap.Code)
		}

		// Session Update error fails closed with 500
		dir := t.TempDir()
		_ = os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{"retestSecret":"prod_retest_secret_2026"}`), 0o644)
		mem := session.NewMemoryStore()
		_ = mem.Save(context.Background(), tSess)
		failStore := &failingUpdateSessionStore{MemoryStore: mem, updateErr: errors.New("session store write failed")}
		hFail := httpx.Middleware(Retest(RetestDeps{
			Repo:         newFakeRetestRepo(),
			Sessions:     failStore,
			ConfigLoader: config.NewLoader(dir, ""),
			FeedbackRoot: dir,
		}))
		reqFail := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/retest.php?action=create_temp_download", bytes.NewReader(validPDF))
		reqFail.AddCookie(ck)
		recFail := httptest.NewRecorder()
		hFail.ServeHTTP(recFail, reqFail)
		if recFail.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500 on session.Update error, got %d (%s)", recFail.Code, recFail.Body.String())
		}
	})

	t.Run("decrypt config null defaults, body size/JSON errors, and revoke 500", func(t *testing.T) {
		h, repo, sessions, dir, nowUnix := setupRetestTestEnv(t, "prod_retest_secret_2026")
		_ = os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{"retestSecret":"prod_retest_secret_2026","retestQuestionSpacing":null,"retestQrCodeEnabled":null}`), 0o644)

		sig := admin.SignRetestAdminSig("tok1234567", *nowUnix, "prod_retest_secret_2026")
		reqNull := httptest.NewRequest(http.MethodGet, fmt.Sprintf("http://feedback.wxjifang.cn/api/retest.php?action=decrypt&token=tok1234567&admin_sig=%s&admin_ts=%d", sig, *nowUnix), nil)
		recNull := httptest.NewRecorder()
		h.ServeHTTP(recNull, reqNull)
		if recNull.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", recNull.Code)
		}
		var nullResp struct {
			Spacing int  `json:"retestQuestionSpacing"`
			QR      bool `json:"retestQrCodeEnabled"`
		}
		_ = json.Unmarshal(recNull.Body.Bytes(), &nullResp)
		if nullResp.Spacing != 26 || !nullResp.QR {
			t.Fatalf("expected spacing=26 and qr=true for JSON null config, got spacing=%d qr=%v", nullResp.Spacing, nullResp.QR)
		}

		// POST decrypt invalid JSON without query token => 400
		reqBadJSON := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/retest.php?action=decrypt", strings.NewReader("{bad"))
		recBadJSON := httptest.NewRecorder()
		h.ServeHTTP(recBadJSON, reqBadJSON)
		if recBadJSON.Code != http.StatusBadRequest || !strings.Contains(recBadJSON.Body.String(), "JSON") {
			t.Fatalf("expected 400 invalid JSON error, got %d %s", recBadJSON.Code, recBadJSON.Body.String())
		}

		// POST decrypt >1MiB => 413
		reqTooBig := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/retest.php?action=decrypt", bytes.NewReader(bytes.Repeat([]byte("a"), (1<<20)+100)))
		recTooBig := httptest.NewRecorder()
		h.ServeHTTP(recTooBig, reqTooBig)
		if recTooBig.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("expected 413 for >1MiB decrypt body, got %d", recTooBig.Code)
		}

		// TokenExists DB error in revoke_token => 500
		tSess := &session.Session{ID: "tk_err_sess_1234567890abc", Data: map[string]any{"user_logged_in": true, "username": "t1", "user_role": "teacher"}}
		_ = sessions.Save(context.Background(), tSess)
		repo.tokenExistsErr = errors.New("mysql read error")
		reqRev := httptest.NewRequest(http.MethodPost, "http://feedback.wxjifang.cn/api/retest.php?action=revoke_token", strings.NewReader(`{"token":"tok1234567"}`))
		reqRev.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: tSess.ID})
		recRev := httptest.NewRecorder()
		h.ServeHTTP(recRev, reqRev)
		if recRev.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500 when TokenExists returns DB error, got %d (%s)", recRev.Code, recRev.Body.String())
		}
	})

	t.Run("download_file falls back to ModTime TTL when meta missing and opens before logging", func(t *testing.T) {
		h, repo, _, dir, nowUnix := setupRetestTestEnv(t, "prod_retest_secret_2026")
		tempDir := filepath.Join(dir, "data", "temp")
		_ = os.MkdirAll(tempDir, 0o755)
		fileKey := "0123456789abcdef0123456789abcdef"
		pdfPath := filepath.Join(tempDir, fileKey+".pdf")
		if err := os.WriteFile(pdfPath, []byte("%PDF-1.4\n%%EOF\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		modTime := time.Unix(*nowUnix-7201, 0)
		if err := os.Chtimes(pdfPath, modTime, modTime); err != nil {
			t.Fatal(err)
		}

		reqExp := httptest.NewRequest(http.MethodGet, "http://feedback.wxjifang.cn/api/retest.php?action=download_file&key="+fileKey, nil)
		recExp := httptest.NewRecorder()
		h.ServeHTTP(recExp, reqExp)
		if recExp.Code != http.StatusGone {
			t.Fatalf("expected 410 Gone via ModTime fallback when meta json missing, got %d", recExp.Code)
		}
		repo.mu.Lock()
		logsCount := len(repo.accessLogs)
		repo.mu.Unlock()
		if logsCount != 0 {
			t.Fatalf("expected 0 access logs for expired file, got %d", logsCount)
		}
	})
}
