package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"feedback-api/internal/httpx"
	"feedback-api/internal/qbankattest"
	"feedback-api/internal/syslogs"
)

func TestQBankJWKSAndPublicVerifyLifecycleAndRateLimit(t *testing.T) {
	signer, err := qbankattest.NewEphemeralSigner("jf-qb-test-jwks")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 23, 6, 0, 0, 0, time.UTC)
	store := qbankattest.NewMemoryStore(signer, "", qbankattest.WithNowFunc(func() time.Time { return now }))

	scope := qbankattest.Scope{
		BankType: "homework",
		Year:     2026,
		Season:   "秋",
		Subject:  "数学",
		Grade:    "七年级",
		Tier:     "S+",
		Week:     3,
	}

	r1, err := store.RecordRevisionTx(context.Background(), nil, qbankattest.RecordRevisionInput{
		QBankID:      101,
		Action:       qbankattest.ActionCreate,
		Scope:        scope,
		Operator:     "t101",
		OperatorName: "张老师",
		Questions: []qbankattest.SnapshotQuestion{
			{
				QuestionNum:    1,
				Topic:          "一元一次方程",
				ExercisePDF:    "data/pdfs/pdf_secret_ex_1.pdf",
				ExerciseSHA256: strings.Repeat("a", 64),
				AnswerPDF:      "data/pdfs/pdf_secret_ans_1.pdf",
				AnswerSHA256:   strings.Repeat("b", 64),
			},
		},
		Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}

	r2, err := store.RecordRevisionTx(context.Background(), nil, qbankattest.RecordRevisionInput{
		QBankID:      101,
		Action:       qbankattest.ActionUpdate,
		Scope:        scope,
		Operator:     "t102",
		OperatorName: "李老师",
		Questions: []qbankattest.SnapshotQuestion{
			{
				QuestionNum:    1,
				Topic:          "一元一次方程进阶",
				ExercisePDF:    "data/pdfs/pdf_secret_ex_2.pdf",
				ExerciseSHA256: strings.Repeat("c", 64),
			},
		},
		Now: now.Add(5 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/jwks.json", QBankJWKS(store, signer))
	mux.HandleFunc("/api/v1/qbank/verify", QBankVerify(QBankVerifyDeps{
		Attest:  store,
		Limiter: syslogs.NewIngestLimiter(),
	}))
	h := httpx.Middleware(mux)

	// 1. /.well-known/jwks.json method guard & RFC 8037 OKP JWK output
	recMethod := httptest.NewRecorder()
	h.ServeHTTP(recMethod, httptest.NewRequest(http.MethodPost, "/.well-known/jwks.json", nil))
	if recMethod.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST jwks status = %d, want 405", recMethod.Code)
	}

	recJWKS := httptest.NewRecorder()
	h.ServeHTTP(recJWKS, httptest.NewRequest(http.MethodGet, "/.well-known/jwks.json", nil))
	if recJWKS.Code != http.StatusOK {
		t.Fatalf("GET jwks status = %d, body=%s", recJWKS.Code, recJWKS.Body.String())
	}
	if cc := recJWKS.Header().Get("Cache-Control"); cc != "public, max-age=300" {
		t.Fatalf("jwks Cache-Control = %q, want public, max-age=300", cc)
	}
	var jwks qbankattest.JWKS
	if err := json.Unmarshal(recJWKS.Body.Bytes(), &jwks); err != nil {
		t.Fatal(err)
	}
	if len(jwks.Keys) != 1 || jwks.Keys[0].Kty != "OKP" || jwks.Keys[0].Crv != "Ed25519" || jwks.Keys[0].Alg != "EdDSA" || jwks.Keys[0].Kid != signer.Kid() {
		t.Fatalf("unexpected JWKS: %+v", jwks)
	}

	// 1b. JWKS falls back to active signer when DB-backed MySQLStore has nil DB
	recFallbackJWKS := httptest.NewRecorder()
	httpx.Middleware(QBankJWKS(qbankattest.NewMySQLStore(nil, signer, ""), signer)).ServeHTTP(recFallbackJWKS, httptest.NewRequest(http.MethodGet, "/.well-known/jwks.json", nil))
	if recFallbackJWKS.Code != http.StatusOK || !strings.Contains(recFallbackJWKS.Body.String(), signer.Kid()) {
		t.Fatalf("fallback JWKS failed: code=%d body=%s", recFallbackJWKS.Code, recFallbackJWKS.Body.String())
	}

	// 2. Verify r2 (VALID) and verify Ed25519 signature using public key from JWKS
	recV2 := httptest.NewRecorder()
	reqV2 := httptest.NewRequest(http.MethodGet, "/api/v1/qbank/verify?code="+r2.ReceiptCode, nil)
	reqV2.RemoteAddr = "203.0.113.10:12345"
	h.ServeHTTP(recV2, reqV2)
	if recV2.Code != http.StatusOK {
		t.Fatalf("verify r2 status = %d, body=%s", recV2.Code, recV2.Body.String())
	}
	if cc := recV2.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("verify Cache-Control = %q, want no-store", cc)
	}
	var envV2 struct {
		Success bool                    `json:"success"`
		Data    *qbankattest.VerifyResult `json:"data"`
		Error   *string                 `json:"error"`
	}
	if err := json.Unmarshal(recV2.Body.Bytes(), &envV2); err != nil {
		t.Fatal(err)
	}
	if !envV2.Success || envV2.Error != nil || envV2.Data == nil || envV2.Data.Status != qbankattest.StatusValid || !envV2.Data.SignatureValid || !envV2.Data.ChainValid {
		t.Fatalf("unexpected verify r2 envelope: %+v (body=%s)", envV2, recV2.Body.String())
	}
	if !qbankattest.Verify(jwks.Keys[0].X, []byte(envV2.Data.Receipt.CanonicalPayload), envV2.Data.Receipt.Signature) {
		t.Fatal("Ed25519 verification via JWKS public key failed")
	}

	// 3. Verify r1 (SUPERSEDED) and assert ZERO PDF path leakage
	recV1 := httptest.NewRecorder()
	reqV1 := httptest.NewRequest(http.MethodGet, "/api/v1/qbank/verify?code="+r1.ReceiptCode, nil)
	reqV1.RemoteAddr = "203.0.113.10:12345"
	h.ServeHTTP(recV1, reqV1)
	if recV1.Code != http.StatusOK {
		t.Fatalf("verify r1 status = %d", recV1.Code)
	}
	v1Body := recV1.Body.String()
	for _, forbidden := range []string{"data/pdfs/", "pdf_secret_ex_1.pdf", "pdf_secret_ans_1.pdf", "pdf_secret_ex_2.pdf"} {
		if strings.Contains(v1Body, forbidden) {
			t.Fatalf("security violation: /api/v1/qbank/verify exposed %q in %s", forbidden, v1Body)
		}
	}
	if !strings.Contains(v1Body, `"status":"SUPERSEDED"`) || !strings.Contains(v1Body, r2.ReceiptCode) {
		t.Fatalf("expected SUPERSEDED pointing to %s, got %s", r2.ReceiptCode, v1Body)
	}

	// 4. Verify NOT_FOUND (empty or missing code)
	recNF := httptest.NewRecorder()
	reqNF := httptest.NewRequest(http.MethodGet, "/api/v1/qbank/verify?code=QB-20261123-AAAAAA-BBBB", nil)
	reqNF.RemoteAddr = "203.0.113.11:12345"
	h.ServeHTTP(recNF, reqNF)
	if recNF.Code != http.StatusOK || !strings.Contains(recNF.Body.String(), `"status":"NOT_FOUND"`) {
		t.Fatalf("expected NOT_FOUND, got code=%d body=%s", recNF.Code, recNF.Body.String())
	}

	// 5. Verify DELETED lifecycle after deletion revision
	_, err = store.RecordRevisionTx(context.Background(), nil, qbankattest.RecordRevisionInput{
		QBankID:      101,
		Action:       qbankattest.ActionDelete,
		Scope:        scope,
		Operator:     "t103",
		OperatorName: "王老师",
		Questions:    nil,
		Now:          now.Add(10 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	recDel := httptest.NewRecorder()
	reqDel := httptest.NewRequest(http.MethodGet, "/api/v1/qbank/verify?code="+r2.ReceiptCode, nil)
	reqDel.RemoteAddr = "203.0.113.11:12345"
	h.ServeHTTP(recDel, reqDel)
	if recDel.Code != http.StatusOK || !strings.Contains(recDel.Body.String(), `"status":"DELETED"`) {
		t.Fatalf("expected DELETED, got code=%d body=%s", recDel.Code, recDel.Body.String())
	}

	// 6. Per-IP rate limit (60/min) -> 61st returns 429
	rateIP := "198.51.100.77:5555"
	for i := 0; i < 60; i++ {
		recRL := httptest.NewRecorder()
		reqRL := httptest.NewRequest(http.MethodGet, "/api/v1/qbank/verify?code="+r2.ReceiptCode, nil)
		reqRL.RemoteAddr = rateIP
		h.ServeHTTP(recRL, reqRL)
		if recRL.Code != http.StatusOK {
			t.Fatalf("request %d within limit returned %d", i+1, recRL.Code)
		}
	}
	recRLOver := httptest.NewRecorder()
	reqRLOver := httptest.NewRequest(http.MethodGet, "/api/v1/qbank/verify?code="+r2.ReceiptCode, nil)
	reqRLOver.RemoteAddr = rateIP
	h.ServeHTTP(recRLOver, reqRLOver)
	if recRLOver.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 after 60 requests/min, got %d (%s)", recRLOver.Code, recRLOver.Body.String())
	}
}
