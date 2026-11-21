package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"feedback-api/internal/admin"
	"feedback-api/internal/auditlog"
	"feedback-api/internal/config"
	"feedback-api/internal/retest"
	"feedback-api/internal/session"
)

type fakeRetestRepo struct {
	revoked      map[string]bool
	tokenRecord  *retest.TokenRecord
	history      retest.StudentHistoryBundle
	qbankRows    []retest.QbankQuestionRow
	accessLogs   []string
	encryptRes   retest.EncryptBatchResult
	checkRes     retest.CheckBatchResult
	weekRecRes   retest.StudentWeekResult
	tokenExists  bool
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

func (f *fakeRetestRepo) CheckExistingBatch(_ context.Context, _ retest.CheckBatchInput) (retest.CheckBatchResult, error) {
	return f.checkRes, nil
}
func (f *fakeRetestRepo) GetStudentWeekRecord(_ context.Context, _ retest.StudentWeekQuery) (retest.StudentWeekResult, error) {
	return f.weekRecRes, nil
}
func (f *fakeRetestRepo) EncryptBatch(_ context.Context, _ retest.EncryptBatchInput) (retest.EncryptBatchResult, error) {
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
	return f.revoked[token], nil
}
func (f *fakeRetestRepo) TokenExists(_ context.Context, _ string, _ bool) (bool, error) {
	return f.tokenExists, nil
}
func (f *fakeRetestRepo) RevokeToken(_ context.Context, token, _, _ string) error {
	f.revoked[token] = true
	return nil
}
func (f *fakeRetestRepo) UnrevokeToken(_ context.Context, token string) error {
	delete(f.revoked, token)
	return nil
}
func (f *fakeRetestRepo) LogAccess(_ context.Context, _, _, action, _, _, _ string) {
	f.accessLogs = append(f.accessLogs, action)
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
	h := Retest(RetestDeps{
		Repo:         repo,
		Sessions:     sessions,
		ConfigLoader: config.NewLoader(dir, ""),
		Audit:        auditlog.NewDualLogger(nil, dir),
		FeedbackRoot: dir,
		NowFunc:      func() time.Time { return time.Unix(nowUnix, 0) },
	})
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
