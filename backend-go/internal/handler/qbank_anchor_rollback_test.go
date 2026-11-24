package handler

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"feedback-api/internal/qbankattest"
)

func TestQBankAnchorsAndAdminRollbackEndpoints(t *testing.T) {
	t.Setenv("QBANK_ATTESTATION_PRIVATE_KEY", "")
	t.Setenv("QBANK_ATTESTATION_KEY_FILE", "")
	t.Setenv("ATTESTATION_TSA_URL", "off")

	mux, _, sessStore, _, _ := setupAdminTestEnv(t)
	signer, err := qbankattest.LoadSigner("handler-phase2-secret")
	if err != nil {
		t.Fatalf("LoadOrDeriveSigner: %v", err)
	}
	attest := qbankattest.NewMemoryStore(signer, t.TempDir())
	ctx := context.Background()

	_, err = attest.RecordRevisionTx(ctx, nil, qbankattest.RecordRevisionInput{
		QBankID:   1,
		Action:    qbankattest.ActionCreate,
		Scope:     qbankattest.Scope{Year: 2026, Season: "spring", BankType: "weekly", Subject: "数学", Grade: "高一", Tier: "实验班", Week: 1},
		Operator:  "t1",
		Questions: []qbankattest.SnapshotQuestion{{QuestionNum: 1, Topic: "函数单调性"}},
	})
	if err != nil {
		t.Fatalf("RecordRevisionTx: %v", err)
	}

	// Build a dedicated admin handler with Attest wired
	_, repo, _, audit, dir := setupAdminTestEnv(t)
	_ = mux
	_ = dir
	adminHandler := Admin(AdminDeps{
		Repo:     repo,
		Sessions: sessStore,
		Audit:    audit,
		Attest:   attest,
	})
	anchorsHandler := QBankAnchors(QBankVerifyDeps{Attest: attest})

	// 1. Unauthenticated admin qbank_anchor_now -> 401
	reqUnauth := httptest.NewRequest(http.MethodPost, "/api/admin.php?action=qbank_anchor_now", nil)
	recUnauth := httptest.NewRecorder()
	adminHandler.ServeHTTP(recUnauth, reqUnauth)
	if recUnauth.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", recUnauth.Code)
	}

	// Create admin session cookie
	sid := "test-admin-sid-phase2"
	sessStore.Set(sid, map[string]any{
		"admin_logged_in": true,
		"admin_username":  "boss",
	})
	cookie := &http.Cookie{Name: "PHPSESSID", Value: sid}

	// 2. Admin triggers qbank_anchor_now (TSA=off -> local_only)
	reqAnc := httptest.NewRequest(http.MethodPost, "/api/admin.php?action=qbank_anchor_now", nil)
	reqAnc.AddCookie(cookie)
	recAnc := httptest.NewRecorder()
	adminHandler.ServeHTTP(recAnc, reqAnc)
	if recAnc.Code != http.StatusOK {
		t.Fatalf("qbank_anchor_now status=%d body=%s", recAnc.Code, recAnc.Body.String())
	}
	var ancResp struct {
		Success bool `json:"success"`
		Data    struct {
			Anchored bool                    `json:"anchored"`
			Anchor   qbankattest.AnchorRecord `json:"anchor"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recAnc.Body.Bytes(), &ancResp); err != nil {
		t.Fatalf("decode qbank_anchor_now: %v", err)
	}
	if !ancResp.Success || !ancResp.Data.Anchored || ancResp.Data.Anchor.TSAStatus != qbankattest.TSAStatusLocalOnly {
		t.Fatalf("unexpected qbank_anchor_now response: %+v", ancResp)
	}

	// 3. Public GET /api/v1/qbank/anchors returns the anchor
	reqPub := httptest.NewRequest(http.MethodGet, "/api/v1/qbank/anchors", nil)
	recPub := httptest.NewRecorder()
	anchorsHandler.ServeHTTP(recPub, reqPub)
	if recPub.Code != http.StatusOK {
		t.Fatalf("public anchors status=%d", recPub.Code)
	}
	var pubResp struct {
		Success bool `json:"success"`
		Data    struct {
			Total int `json:"total"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recPub.Body.Bytes(), &pubResp); err != nil || !pubResp.Success || pubResp.Data.Total != 1 {
		t.Fatalf("unexpected public anchors response: %s (err=%v)", recPub.Body.String(), err)
	}

	// 4. Admin POST ?action=qbank_rollback delegates to Repo.RollbackQBankRevision
	reqRB := httptest.NewRequest(http.MethodPost, "/api/admin.php?action=qbank_rollback", strings.NewReader(`{"receipt_code":"QB-2026-TEST"}`))
	reqRB.AddCookie(cookie)
	reqRB.Header.Set("Content-Type", "application/json")
	recRB := httptest.NewRecorder()
	adminHandler.ServeHTTP(recRB, reqRB)
	if recRB.Code != http.StatusOK {
		t.Fatalf("qbank_rollback status=%d body=%s", recRB.Code, recRB.Body.String())
	}
	if !strings.Contains(recRB.Body.String(), "QB-2026-MOCK-ROLLBACK") {
		t.Fatalf("expected mock rollback receipt in body, got %s", recRB.Body.String())
	}

	// 5. Failed TSA in AnchorUnanchoredRevisions surfaces tsa_status="failed" and error_message in /api/v1/qbank/anchors.
	_, err = attest.RecordRevisionTx(ctx, nil, qbankattest.RecordRevisionInput{
		QBankID:   2,
		Action:    qbankattest.ActionCreate,
		Scope:     qbankattest.Scope{Year: 2026, Season: "spring", BankType: "weekly", Subject: "数学", Grade: "高一", Tier: "实验班", Week: 2},
		Operator:  "t1",
		Questions: []qbankattest.SnapshotQuestion{{QuestionNum: 1, Topic: "函数周期性"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	failTSA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer failTSA.Close()
	ancFail, err := attest.AnchorUnanchoredRevisions(ctx, &qbankattest.HTTPTSAClient{URL: failTSA.URL, HTTPClient: &http.Client{Timeout: 2 * time.Second}})
	if err != nil || ancFail == nil || ancFail.TSAStatus != qbankattest.TSAStatusFailed || ancFail.ErrorMessage == "" {
		t.Fatalf("expected failed anchor with error_message, got anc=%+v err=%v", ancFail, err)
	}
	reqPub2 := httptest.NewRequest(http.MethodGet, "/api/v1/qbank/anchors", nil)
	recPub2 := httptest.NewRecorder()
	anchorsHandler.ServeHTTP(recPub2, reqPub2)
	if recPub2.Code != http.StatusOK || !strings.Contains(recPub2.Body.String(), `"tsa_status":"failed"`) || !strings.Contains(recPub2.Body.String(), `"error_message":`) {
		t.Fatalf("expected tsa_status=failed and error_message in public anchors, got code=%d body=%s", recPub2.Code, recPub2.Body.String())
	}
}
