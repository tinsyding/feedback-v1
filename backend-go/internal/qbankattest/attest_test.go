package qbankattest

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"database/sql"
	"database/sql/driver"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"feedback-api/internal/qbank"
)

func TestSignerLoadingPrecedenceAndFormats(t *testing.T) {
	// Clear env vars before testing.
	for _, k := range []string{"QBANK_ATTESTATION_PRIVATE_KEY", "QBANK_ATTESTATION_KEY_FILE", "QBANK_ATTESTATION_KEY_ID"} {
		t.Setenv(k, "")
	}

	// 1. Ephemeral fallback when no env and empty retestSecret.
	eph, err := LoadSigner("")
	if err != nil {
		t.Fatalf("LoadSigner empty: %v", err)
	}
	if !eph.IsEphemeral() {
		t.Fatal("expected ephemeral=true when nothing configured")
	}
	if !strings.HasPrefix(eph.Kid(), "jf-qb-") {
		t.Fatalf("unexpected default kid: %q", eph.Kid())
	}

	// 2. Deterministic KDF from retestSecret.
	s1, err := LoadSigner("secret_2026")
	if err != nil {
		t.Fatalf("LoadSigner(retestSecret): %v", err)
	}
	s2, err := LoadSigner("secret_2026")
	if err != nil {
		t.Fatalf("LoadSigner(retestSecret) second call: %v", err)
	}
	if s1.IsEphemeral() {
		t.Fatal("expected ephemeral=false when derived from retestSecret")
	}
	if s1.PublicKeyBase64URL() != s2.PublicKeyBase64URL() || s1.Kid() != s2.Kid() {
		t.Fatal("retestSecret KDF must be deterministic")
	}

	// Expected KDF formula check.
	expectedSeed := sha256.Sum256([]byte("jifang-qbank-attestation-ed25519-v1\x00secret_2026"))
	expectedPriv := ed25519.NewKeyFromSeed(expectedSeed[:])
	expectedPub := expectedPriv.Public().(ed25519.PublicKey)
	if s1.PublicKeyBase64URL() != base64.RawURLEncoding.EncodeToString(expectedPub) {
		t.Fatalf("derived public key mismatch")
	}

	// 3. Generate deterministic test keypair for format tests.
	_, testPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	testSeed := testPriv.Seed()
	testPubB64 := base64.RawURLEncoding.EncodeToString(testPriv.Public().(ed25519.PublicKey))
	pkcs8Bytes, err := x509.MarshalPKCS8PrivateKey(testPriv)
	if err != nil {
		t.Fatal(err)
	}
	pemStr := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8Bytes}))

	formats := []struct {
		name string
		val  string
	}{
		{"64-hex-seed", hex.EncodeToString(testSeed)},
		{"128-hex-privkey", hex.EncodeToString(testPriv)},
		{"base64url-raw-seed", base64.RawURLEncoding.EncodeToString(testSeed)},
		{"base64url-padded-priv", base64.URLEncoding.EncodeToString(testPriv)},
		{"base64-std-seed", base64.StdEncoding.EncodeToString(testSeed)},
		{"pkcs8-pem", pemStr},
		{"pkcs8-pem-escaped-newlines", strings.ReplaceAll(strings.TrimSpace(pemStr), "\n", `\n`)},
	}

	for _, tc := range formats {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("QBANK_ATTESTATION_PRIVATE_KEY", tc.val)
			t.Setenv("QBANK_ATTESTATION_KEY_FILE", "")
			t.Setenv("QBANK_ATTESTATION_KEY_ID", "")
			sg, err := LoadSigner("ignored_secret")
			if err != nil {
				t.Fatalf("LoadSigner(%s): %v", tc.name, err)
			}
			if sg.IsEphemeral() {
				t.Fatalf("expected non-ephemeral for %s", tc.name)
			}
			if sg.PublicKeyBase64URL() != testPubB64 {
				t.Fatalf("pub mismatch for %s: got %q want %q", tc.name, sg.PublicKeyBase64URL(), testPubB64)
			}
			msg := []byte("hello attestation")
			sig := sg.Sign(msg)
			if !Verify(testPubB64, msg, sig) {
				t.Fatalf("signature verify failed for %s", tc.name)
			}
		})
	}

	// 4. Key file + custom KID override.
	keyFile := filepath.Join(t.TempDir(), "ed25519.pem")
	if err := os.WriteFile(keyFile, []byte(pemStr), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("QBANK_ATTESTATION_PRIVATE_KEY", "")
	t.Setenv("QBANK_ATTESTATION_KEY_FILE", keyFile)
	t.Setenv("QBANK_ATTESTATION_KEY_ID", "jf-qb-prod-2026")
	sgFile, err := LoadSigner("ignored")
	if err != nil {
		t.Fatalf("LoadSigner key file: %v", err)
	}
	if sgFile.Kid() != "jf-qb-prod-2026" {
		t.Fatalf("kid override = %q, want jf-qb-prod-2026", sgFile.Kid())
	}
	if sgFile.PublicKeyBase64URL() != testPubB64 {
		t.Fatalf("file pub mismatch")
	}

	// 5. Invalid key fails loudly.
	t.Setenv("QBANK_ATTESTATION_PRIVATE_KEY", "not-a-valid-key")
	if _, err := LoadSigner("secret"); err == nil {
		t.Fatal("expected error for invalid QBANK_ATTESTATION_PRIVATE_KEY")
	}
}

func TestSignerJWKFormatAndVerifyEdgeCases(t *testing.T) {
	sg, err := NewEphemeralSigner("jf-qb-test01")
	if err != nil {
		t.Fatal(err)
	}

	jwk := sg.JWK()
	if jwk.Kty != "OKP" || jwk.Crv != "Ed25519" || jwk.Alg != "EdDSA" || jwk.Use != "sig" {
		t.Fatalf("unexpected RFC 8037 JWK metadata: %+v", jwk)
	}
	if jwk.Kid != "jf-qb-test01" || jwk.Status != KeyStatusActive || jwk.CreatedAt == "" {
		t.Fatalf("unexpected JWK fields: %+v", jwk)
	}
	rawPub, err := base64.RawURLEncoding.DecodeString(jwk.X)
	if err != nil || len(rawPub) != ed25519.PublicKeySize {
		t.Fatalf("JWK.X must be unpadded Base64URL 32-byte key: %q err=%v", jwk.X, err)
	}
	if strings.Contains(jwk.X, "=") {
		t.Fatalf("JWK.X must not contain padding: %q", jwk.X)
	}

	msg := []byte(`{"schema":"jifang.qbank.attestation.v1"}`)
	sig := sg.Sign(msg)
	if strings.Contains(sig, "=") || len(sig) != 86 {
		t.Fatalf("unexpected Base64URL signature format: len=%d val=%q", len(sig), sig)
	}
	if !sg.Verify(msg, sig) {
		t.Fatal("Signer.Verify failed on valid signature")
	}
	if Verify(jwk.X, []byte(`{"schema":"tampered"}`), sig) {
		t.Fatal("Verify must fail when message is tampered")
	}
	if Verify(jwk.X+"=", msg, sig) {
		t.Fatal("Verify must reject padded public key")
	}
	if Verify(jwk.X, msg, sig+"==") {
		t.Fatal("Verify must reject padded signature")
	}
}

func TestFileSHA256CanonicalPayloadAndSecurityRedLine(t *testing.T) {
	root := t.TempDir()
	pdfDir := filepath.Join(root, "data", "pdfs")
	if err := os.MkdirAll(pdfDir, 0755); err != nil {
		t.Fatal(err)
	}
	exBytes := []byte("%PDF-1.4\nexercise content 1")
	ansBytes := []byte("%PDF-1.4\nanswer content 1")
	if err := os.WriteFile(filepath.Join(pdfDir, "pdf_ex_1.pdf"), exBytes, 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pdfDir, "pdf_ans_1.pdf"), ansBytes, 0644); err != nil {
		t.Fatal(err)
	}

	// Valid path hashing.
	gotSHA, gotSize := ComputeFileSHA256(root, "data/pdfs/pdf_ex_1.pdf")
	wantSum := sha256.Sum256(exBytes)
	if gotSHA != hex.EncodeToString(wantSum[:]) || gotSize != int64(len(exBytes)) {
		t.Fatalf("ComputeFileSHA256 = (%q, %d), want (%q, %d)", gotSHA, gotSize, hex.EncodeToString(wantSum[:]), len(exBytes))
	}

	// Missing file and path traversal degrade gracefully to empty/0.
	if s, n := ComputeFileSHA256(root, "data/pdfs/pdf_missing.pdf"); s != "" || n != 0 {
		t.Fatalf("expected missing file to return empty/0, got (%q, %d)", s, n)
	}
	if s, n := ComputeFileSHA256(root, "../secret.pdf"); s != "" || n != 0 {
		t.Fatalf("expected path traversal to return empty/0, got (%q, %d)", s, n)
	}

	scope := Scope{
		BankType: "homework",
		Year:     2026,
		Season:   "秋",
		Subject:  "数学",
		Grade:    "七年级",
		Tier:     "S+",
		Week:     3,
	}

	// Input intentionally unsorted and containing HTML characters (<, >, &) in topic.
	snapRes, err := BuildSnapshot(root, scope, []SnapshotQuestion{
		{
			QuestionNum:  2,
			Topic:        "不等式 x < 5 & y > 0 ",
			ExercisePDF:  "data/pdfs/pdf_ex_1.pdf",
			ExerciseName: "q2.pdf",
		},
		{
			QuestionNum:  1,
			Topic:        "有理数运算。",
			ExercisePDF:  "data/pdfs/pdf_ex_1.pdf",
			ExerciseName: "q1.pdf",
			AnswerPDF:    "data/pdfs/pdf_ans_1.pdf",
			AnswerName:   "a1.pdf",
		},
	})
	if err != nil {
		t.Fatalf("BuildSnapshot: %v", err)
	}
	if snapRes.Summary.QuestionCount != 2 || snapRes.Summary.ExercisePDFCount != 2 || snapRes.Summary.AnswerPDFCount != 1 || snapRes.Summary.TopicFilledCount != 2 {
		t.Fatalf("unexpected summary counts: %+v", snapRes.Summary)
	}
	if snapRes.Summary.Topics[0].QNum != 1 || snapRes.Summary.Topics[1].QNum != 2 {
		t.Fatalf("expected topics sorted by QNum ASC, got %+v", snapRes.Summary.Topics)
	}
	if snapRes.Summary.Topics[1].Topic != "不等式 x < 5 & y > 0" {
		t.Fatalf("expected cleaned topic with literal < & >, got %q", snapRes.Summary.Topics[1].Topic)
	}

	signer, _ := NewEphemeralSigner("")
	store := NewMemoryStore(signer, root)
	receipt, err := store.RecordRevisionTx(context.Background(), nil, RecordRevisionInput{
		QBankID:      42,
		Action:       ActionCreate,
		Scope:        scope,
		Operator:     "t101",
		OperatorName: "张老师",
		ClientIP:     "10.0.0.1",
		Questions: []SnapshotQuestion{
			{
				QuestionNum:  1,
				Topic:        "x < 5 & y > 0",
				ExercisePDF:  "data/pdfs/pdf_ex_1.pdf",
				ExerciseName: "q1.pdf",
				AnswerPDF:    "data/pdfs/pdf_ans_1.pdf",
				AnswerName:   "a1.pdf",
			},
		},
	})
	if err != nil {
		t.Fatalf("RecordRevisionTx: %v", err)
	}

	reCode := regexp.MustCompile(`^QB-\d{8}-[A-Z0-9]{6}-[A-Z0-9]{4}$`)
	if !reCode.MatchString(receipt.ReceiptCode) {
		t.Fatalf("invalid receipt_code format: %q", receipt.ReceiptCode)
	}
	if strings.Contains(receipt.CanonicalPayload, `\u003c`) || strings.Contains(receipt.CanonicalPayload, `\u0026`) {
		t.Fatalf("canonical_payload must use SetEscapeHTML(false), got %s", receipt.CanonicalPayload)
	}
	if strings.HasSuffix(receipt.CanonicalPayload, "\n") {
		t.Fatal("canonical_payload must not have trailing newline")
	}

	// Verify security red line: NEVER expose data/pdfs/ or pdf_*.pdf in CanonicalPayload, Receipt, or VerifyResult!
	vr, err := store.VerifyReceipt(context.Background(), receipt.ReceiptCode)
	if err != nil {
		t.Fatalf("VerifyReceipt: %v", err)
	}
	vrJSON, err := json.Marshal(vr)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"data/pdfs/", "pdf_ex_1.pdf", "pdf_ans_1.pdf"} {
		if strings.Contains(receipt.CanonicalPayload, forbidden) {
			t.Fatalf("security violation: canonical_payload contains %q", forbidden)
		}
		if strings.Contains(string(vrJSON), forbidden) {
			t.Fatalf("security violation: VerifyResult JSON contains %q: %s", forbidden, string(vrJSON))
		}
	}
}

func TestMemoryStoreLifecycleTamperingAndDiffSecurity(t *testing.T) {
	ctx := context.Background()
	signer, err := NewSignerFromSeed(make([]byte, 32), "jf-qb-fixed")
	if err != nil {
		t.Fatal(err)
	}
	baseTime := time.Date(2026, 11, 23, 5, 0, 0, 0, time.UTC)
	curTime := baseTime
	store := NewMemoryStore(signer, "", WithNowFunc(func() time.Time { return curTime }))

	scope := Scope{
		BankType: "homework",
		Year:     2026,
		Season:   "秋",
		Subject:  "数学",
		Grade:    "七年级",
		Tier:     "S+",
		Week:     1,
	}

	// NOT_FOUND when empty or unknown.
	if res, err := store.VerifyReceipt(ctx, "QB-20261123-AAAAAA-BBBB"); err != nil || res.Status != StatusNotFound {
		t.Fatalf("expected NOT_FOUND, got %+v err=%v", res, err)
	}

	// Rev 1: create.
	r1, err := store.RecordRevisionTx(ctx, nil, RecordRevisionInput{
		QBankID:      10,
		Action:       ActionCreate,
		Scope:        scope,
		Operator:     "t101",
		OperatorName: "张老师",
		Questions: []SnapshotQuestion{
			{
				QuestionNum:    1,
				Topic:          "有理数",
				ExercisePDF:    "data/pdfs/pdf_v1_ex.pdf",
				ExerciseSHA256: strings.Repeat("a", 64),
			},
		},
	})
	if err != nil {
		t.Fatalf("rev1: %v", err)
	}
	if r1.RevisionNo != 1 || r1.PrevEntryHash != "" || r1.Supersedes != "" {
		t.Fatalf("unexpected rev1 metadata: %+v", r1)
	}

	vr1, err := store.VerifyReceipt(ctx, r1.ReceiptCode)
	if err != nil {
		t.Fatal(err)
	}
	if vr1.Status != StatusValid || !vr1.SignatureValid || !vr1.ChainValid || vr1.LatestReceiptCode != r1.ReceiptCode {
		t.Fatalf("expected VALID with sig+chain valid, got %+v", vr1)
	}

	// Rev 2: update (supersedes rev 1).
	curTime = baseTime.Add(10 * time.Minute)
	r2, err := store.RecordRevisionTx(ctx, nil, RecordRevisionInput{
		QBankID:      10,
		Action:       ActionUpdate,
		Scope:        scope,
		Operator:     "t102",
		OperatorName: "李老师",
		Questions: []SnapshotQuestion{
			{
				QuestionNum:    1,
				Topic:          "有理数进阶",
				ExercisePDF:    "data/pdfs/pdf_v2_ex.pdf",
				ExerciseSHA256: strings.Repeat("b", 64),
				AnswerPDF:      "data/pdfs/pdf_v2_ans.pdf",
				AnswerSHA256:   strings.Repeat("c", 64),
			},
			{
				QuestionNum:    2,
				Topic:          "数轴",
				ExercisePDF:    "data/pdfs/pdf_v2_q2.pdf",
				ExerciseSHA256: strings.Repeat("d", 64),
			},
		},
	})
	if err != nil {
		t.Fatalf("rev2: %v", err)
	}
	if r2.RevisionNo != 2 || r2.Supersedes != r1.ReceiptCode || r2.PrevEntryHash != r1.EntryHash {
		t.Fatalf("unexpected rev2 linkage: %+v", r2)
	}

	vr1After, err := store.VerifyReceipt(ctx, r1.ReceiptCode)
	if err != nil {
		t.Fatal(err)
	}
	if vr1After.Status != StatusSuperseded || vr1After.SupersededBy == nil || vr1After.SupersededBy.ReceiptCode != r2.ReceiptCode {
		t.Fatalf("expected rev1 SUPERSEDED by rev2, got %+v", vr1After)
	}
	if vr1After.LatestReceiptCode != r2.ReceiptCode || len(vr1After.SupersededBy.DiffSummary) == 0 {
		t.Fatalf("expected diff_summary and latest_receipt_code, got %+v", vr1After)
	}
	diffJoined := strings.Join(vr1After.SupersededBy.DiffSummary, "\n")
	if strings.Contains(diffJoined, "data/pdfs/") || strings.Contains(diffJoined, "pdf_v1_ex") || strings.Contains(diffJoined, "pdf_v2_") {
		t.Fatalf("diff_summary must never expose PDF file paths: %s", diffJoined)
	}

	// Rev 3: delete (transitions scope to DELETED).
	curTime = baseTime.Add(20 * time.Minute)
	r3, err := store.RecordRevisionTx(ctx, nil, RecordRevisionInput{
		QBankID:      10,
		Action:       ActionDelete,
		Scope:        scope,
		Operator:     "t103",
		OperatorName: "王老师",
		Questions:    nil,
	})
	if err != nil {
		t.Fatalf("rev3 delete: %v", err)
	}
	for _, code := range []string{r1.ReceiptCode, r2.ReceiptCode, r3.ReceiptCode} {
		vrDel, err := store.VerifyReceipt(ctx, code)
		if err != nil {
			t.Fatal(err)
		}
		if vrDel.Status != StatusDeleted || vrDel.DeletedInfo == nil || vrDel.DeletedInfo.ReceiptCode != r3.ReceiptCode {
			t.Fatalf("expected DELETED for %s, got %+v", code, vrDel)
		}
		if !vrDel.SignatureValid || !vrDel.ChainValid {
			t.Fatalf("expected deleted revision %s to still pass crypto verification, got sig=%v chain=%v", code, vrDel.SignatureValid, vrDel.ChainValid)
		}
	}

	// Tamper detection: mutate canonical_payload on r2 -> signature_valid=false.
	if !store.MutateRevisionForTest(r2.ReceiptCode, func(canonical, _, _, _, _ *string) {
		*canonical = strings.Replace(*canonical, "有理数进阶", "被篡改知识点", 1)
	}) {
		t.Fatal("failed to locate r2 for tamper test")
	}
	vrTamperedPayload, _ := store.VerifyReceipt(ctx, r2.ReceiptCode)
	if vrTamperedPayload.SignatureValid {
		t.Fatal("expected signature_valid=false when canonical_payload is tampered")
	}

	// Tamper detection: mutate entry_hash on r1 -> chain_valid=false on r1 AND r2!
	store.MutateRevisionForTest(r1.ReceiptCode, func(_, _, entryHash, _, _ *string) {
		*entryHash = strings.Repeat("0", 64)
	})
	vrTamperedHash1, _ := store.VerifyReceipt(ctx, r1.ReceiptCode)
	vrTamperedHash2, _ := store.VerifyReceipt(ctx, r2.ReceiptCode)
	if vrTamperedHash1.ChainValid || vrTamperedHash2.ChainValid {
		t.Fatalf("expected chain_valid=false after entry_hash tamper: r1=%v r2=%v", vrTamperedHash1.ChainValid, vrTamperedHash2.ChainValid)
	}

	// Revoked key -> signature_valid=false on r3.
	store.SetKeyStatusForTest(signer.Kid(), KeyStatusRevoked, "")
	vrRevoked, _ := store.VerifyReceipt(ctx, r3.ReceiptCode)
	if vrRevoked.SignatureValid {
		t.Fatal("expected signature_valid=false when key is revoked")
	}

	// Re-create after delete -> rev 4 becomes VALID and rev 3 becomes SUPERSEDED.
	store.SetKeyStatusForTest(signer.Kid(), KeyStatusActive, "")
	curTime = baseTime.Add(30 * time.Minute)
	r4, err := store.RecordRevisionTx(ctx, nil, RecordRevisionInput{
		QBankID:   11,
		Scope:     scope, // Action auto-resolves to create after delete
		Operator:  "t104",
		Questions: SnapshotQuestionsFromWeekDetail([]qbank.QuestionItem{{ID: 1, SubNum: 1, Topic: "重建专题", ExercisePDF: qbank.PDFInfo{URL: "data/pdfs/pdf_v4.pdf"}}}),
	})
	if err != nil {
		t.Fatalf("rev4 recreate: %v", err)
	}
	if r4.Action != ActionCreate || r4.RevisionNo != 4 || r4.Supersedes != r3.ReceiptCode {
		t.Fatalf("unexpected rev4 after delete: %+v", r4)
	}
	vr3After, _ := store.VerifyReceipt(ctx, r3.ReceiptCode)
	if vr3After.Status != StatusSuperseded || vr3After.LatestReceiptCode != r4.ReceiptCode {
		t.Fatalf("expected rev3 SUPERSEDED after recreate, got %+v", vr3After)
	}
	vr4, _ := store.VerifyReceipt(ctx, r4.ReceiptCode)
	if vr4.Status != StatusValid || !vr4.SignatureValid {
		t.Fatalf("expected rev4 VALID, got %+v", vr4)
	}
}

func TestMemoryStoreTimelineMatrixRetentionAndConcurrency(t *testing.T) {
	ctx := context.Background()
	signer, _ := NewEphemeralSigner("")
	now := time.Date(2026, 11, 23, 4, 0, 0, 0, time.UTC)
	store := NewMemoryStore(signer, "", WithNowFunc(func() time.Time { return now }))

	scope1 := Scope{BankType: "homework", Year: 2026, Season: "秋", Subject: "数学", Grade: "七年级", Tier: "S+", Week: 1}
	scope2 := Scope{BankType: "homework", Year: 2026, Season: "秋", Subject: "数学", Grade: "七年级", Tier: "A+", Week: 2}

	_, err := store.RecordRevisionTx(ctx, nil, RecordRevisionInput{
		QBankID: 1, Action: ActionCreate, Scope: scope1, Operator: "t1", OperatorName: "张老师",
		Questions: []SnapshotQuestion{{QuestionNum: 1, Topic: "T1", ExercisePDF: "data/pdfs/pdf_recent.pdf", ExerciseSHA256: strings.Repeat("1", 64)}},
		Now:       now,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.RecordRevisionTx(ctx, nil, RecordRevisionInput{
		QBankID: 2, Action: ActionCreate, Scope: scope2, Operator: "t2", OperatorName: "李老师",
		Questions: []SnapshotQuestion{{QuestionNum: 1, Topic: "T2", ExercisePDF: "data/pdfs/pdf_old.pdf", ExerciseSHA256: strings.Repeat("2", 64)}},
		Now:       now.Add(-200 * 24 * time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}

	// Record attempts.
	_ = store.RecordAttempt(ctx, AttemptInput{
		EventType: EventUploadPDF, Scope: scope1, Operator: "t1", OperatorName: "张老师",
		FileURL: "data/pdfs/pdf_recent.pdf", FileName: "test.pdf", FileSHA256: strings.Repeat("1", 64), FileSize: 1024, Now: now.Add(time.Minute),
	})
	_ = store.RecordAttempt(ctx, AttemptInput{
		EventType: EventClientBlocked, Scope: scope1, Operator: "t1", OperatorName: "张老师", Reason: "缺少知识点", Now: now.Add(2 * time.Minute),
	})
	_ = store.RecordAttempt(ctx, AttemptInput{
		EventType: EventSaveRejected, Scope: scope1, Operator: "t1", OperatorName: "张老师", Reason: "助教禁止保存", Now: now.Add(3 * time.Minute),
	})
	_ = store.RecordAttempt(ctx, AttemptInput{
		EventType: EventSaveCancelled, Scope: scope1, Operator: "t1", OperatorName: "张老师", Reason: "取消覆盖", Now: now.Add(4 * time.Minute),
	})

	// Timeline filters: comma-separated client_blocked,save_rejected.
	tlBlocked, err := store.ListTimeline(ctx, TimelineFilter{Operator: "张", EventType: "client_blocked,save_rejected"})
	if err != nil {
		t.Fatal(err)
	}
	if tlBlocked.Total != 2 || tlBlocked.Stats.Revisions != 1 || tlBlocked.Stats.Uploads != 1 || tlBlocked.Stats.BlockedOrFailed != 2 || tlBlocked.Stats.Cancelled != 1 {
		t.Fatalf("unexpected timeline blocked result: %+v", tlBlocked)
	}

	// Timeline filter: revision.
	tlRev, err := store.ListTimeline(ctx, TimelineFilter{EventType: "revision"})
	if err != nil {
		t.Fatal(err)
	}
	if tlRev.Total != 2 || len(tlRev.Items) != 2 || tlRev.Items[0].Source != "revision" {
		t.Fatalf("unexpected timeline revision result: %+v", tlRev)
	}

	// Matrix aggregation.
	matrix, err := store.ListMatrix(ctx, MatrixFilter{Search: "t1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(matrix) != 1 || matrix[0].RevisionCount != 1 || matrix[0].AttemptCount != 4 {
		t.Fatalf("unexpected matrix result: %+v", matrix)
	}

	// 180-day PDF retention check.
	if has, err := store.HasRecentPDFReference(ctx, "data/pdfs/pdf_recent.pdf", 180*24*time.Hour); err != nil || !has {
		t.Fatalf("expected pdf_recent.pdf to be referenced within 180d, got has=%v err=%v", has, err)
	}
	if has, err := store.HasRecentPDFReference(ctx, "data/pdfs/pdf_old.pdf", 180*24*time.Hour); err != nil || has {
		t.Fatalf("expected pdf_old.pdf (>200d) to NOT be recent within 180d, got has=%v err=%v", has, err)
	}
	if has, err := store.HasRecentPDFReference(ctx, "data/pdfs/pdf_old.pdf", 0); err != nil || !has {
		t.Fatalf("expected pdf_old.pdf to be found when maxAge=0, got has=%v err=%v", has, err)
	}

	// Concurrency test under -race.
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			sc := Scope{BankType: "homework", Year: 2026, Season: "秋", Subject: "数学", Grade: "七年级", Tier: "S+", Week: 10 + idx}
			rec, recErr := store.RecordRevisionTx(ctx, nil, RecordRevisionInput{
				QBankID: int64(100 + idx), Scope: sc, Operator: fmt.Sprintf("t%d", idx),
				Questions: []SnapshotQuestion{{QuestionNum: 1, Topic: "并发测试"}},
			})
			if recErr != nil {
				t.Errorf("concurrent RecordRevisionTx: %v", recErr)
				return
			}
			if _, vErr := store.VerifyReceipt(ctx, rec.ReceiptCode); vErr != nil {
				t.Errorf("concurrent VerifyReceipt: %v", vErr)
			}
			_, _ = store.ListTimeline(ctx, TimelineFilter{Page: 1, PageSize: 10})
			_, _ = store.ListMatrix(ctx, MatrixFilter{})
			_, _ = store.ListPublicKeys(ctx)
		}(g)
	}
	wg.Wait()
}

// ---------- Mock SQL Driver Tests for MySQLStore ----------

type mockAttestSQLRecord struct {
	query string
	args  []any
}

type mockAttestDBState struct {
	mu                sync.Mutex
	queries           []mockAttestSQLRecord
	execs             []mockAttestSQLRecord
	txBegun           int
	txCommitted       int
	txRolledBack      int
	registeredKeys    map[string]keyRecord
	revisions         []*revisionRecord
	attempts          []*attemptRecord
	matrixRows        [][]driver.Value
	hasRecentPDFMatch bool
}

var (
	mockAttestDBMu       sync.Mutex
	mockAttestDBRegistry = make(map[string]*mockAttestDBState)
)

func init() {
	sql.Register("mock_attest_mysql", &mockAttestDriver{})
}

type mockAttestDriver struct{}

func (d *mockAttestDriver) Open(name string) (driver.Conn, error) {
	mockAttestDBMu.Lock()
	st := mockAttestDBRegistry[name]
	mockAttestDBMu.Unlock()
	if st == nil {
		return nil, fmt.Errorf("unknown mock dsn %q", name)
	}
	return &mockAttestConn{state: st}, nil
}

type mockAttestConn struct{ state *mockAttestDBState }

func (c *mockAttestConn) Prepare(query string) (driver.Stmt, error) {
	return &mockAttestStmt{state: c.state, query: query}, nil
}
func (c *mockAttestConn) Close() error { return nil }
func (c *mockAttestConn) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}
func (c *mockAttestConn) BeginTx(_ context.Context, _ driver.TxOptions) (driver.Tx, error) {
	c.state.mu.Lock()
	c.state.txBegun++
	c.state.mu.Unlock()
	return &mockAttestTx{state: c.state}, nil
}

func (c *mockAttestConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	copied := make([]any, len(args))
	for i, a := range args {
		copied[i] = a.Value
	}
	c.state.mu.Lock()
	defer c.state.mu.Unlock()
	c.state.execs = append(c.state.execs, mockAttestSQLRecord{query: query, args: copied})

	switch {
	case strings.Contains(query, "INSERT IGNORE INTO `qbank_attestation_keys`"):
		kid := copied[0].(string)
		if _, exists := c.state.registeredKeys[kid]; !exists {
			c.state.registeredKeys[kid] = keyRecord{
				kid:       kid,
				alg:       copied[1].(string),
				publicKey: copied[2].(string),
				status:    copied[3].(string),
				createdAt: time.Now().UTC(),
			}
		}
		return mockAttestResult{lastID: 1, affected: 1}, nil

	case strings.Contains(query, "INSERT INTO `qbank_revisions`"):
		sup, _ := copied[11].(string)
		rec := &revisionRecord{
			id:                    int64(len(c.state.revisions) + 1),
			receiptCode:           copied[0].(string),
			qbankID:               copied[1].(int64),
			action:                copied[2].(string),
			scope:                 Scope{BankType: copied[3].(string), Year: int(copied[4].(int64)), Season: copied[5].(string), Subject: copied[6].(string), Grade: copied[7].(string), Tier: copied[8].(string), Week: int(copied[9].(int64))},
			revisionNo:            int(copied[10].(int64)),
			supersedesReceiptCode: sup,
			questionCount:         int(copied[12].(int64)),
			exercisePDFCount:      int(copied[13].(int64)),
			answerPDFCount:        int(copied[14].(int64)),
			topicFilledCount:      int(copied[15].(int64)),
			snapshotJSON:          copied[16].(string),
			contentSHA256:         copied[17].(string),
			canonicalPayload:      copied[18].(string),
			prevEntryHash:         copied[19].(string),
			entryHash:             copied[20].(string),
			kid:                   copied[21].(string),
			signature:             copied[22].(string),
			operator:              copied[23].(string),
			operatorName:          copied[24].(string),
			clientIP:              copied[25].(string),
			issuedAtUTC:           copied[26].(string),
			createdAt:             time.Now().UTC(),
		}
		c.state.revisions = append(c.state.revisions, rec)
		return mockAttestResult{lastID: rec.id, affected: 1}, nil

	case strings.Contains(query, "INSERT INTO `qbank_attempt_logs`"):
		return mockAttestResult{lastID: 1, affected: 1}, nil
	}
	return mockAttestResult{lastID: 1, affected: 1}, nil
}

func (c *mockAttestConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	copied := make([]any, len(args))
	for i, a := range args {
		copied[i] = a.Value
	}
	c.state.mu.Lock()
	defer c.state.mu.Unlock()
	c.state.queries = append(c.state.queries, mockAttestSQLRecord{query: query, args: copied})

	switch {
	case strings.Contains(query, "SELECT `public_key`, `status` FROM `qbank_attestation_keys`"):
		kid := copied[0].(string)
		if k, ok := c.state.registeredKeys[kid]; ok {
			return &mockAttestRows{
				cols: []string{"public_key", "status"},
				rows: [][]driver.Value{{k.publicKey, k.status}},
			}, nil
		}
		return &mockAttestRows{cols: []string{"public_key", "status"}}, nil

	case strings.Contains(query, "SELECT `kid`, `public_key`, `status`, `created_at` FROM `qbank_attestation_keys`"):
		rows := make([][]driver.Value, 0, len(c.state.registeredKeys))
		for _, k := range c.state.registeredKeys {
			rows = append(rows, []driver.Value{k.kid, k.publicKey, k.status, k.createdAt})
		}
		return &mockAttestRows{cols: []string{"kid", "public_key", "status", "created_at"}, rows: rows}, nil

	case strings.Contains(query, "SELECT `kid` FROM `qbank_attestation_keys`"):
		kid := copied[0].(string)
		if k, ok := c.state.registeredKeys[kid]; ok {
			return &mockAttestRows{cols: []string{"kid"}, rows: [][]driver.Value{{k.kid}}}, nil
		}
		return &mockAttestRows{cols: []string{"kid"}}, nil

	case strings.Contains(query, "SELECT `entry_hash` FROM `qbank_revisions` ORDER BY `id` DESC LIMIT 1 FOR UPDATE"):
		if len(c.state.revisions) == 0 {
			return &mockAttestRows{cols: []string{"entry_hash"}}, nil
		}
		last := c.state.revisions[len(c.state.revisions)-1]
		return &mockAttestRows{cols: []string{"entry_hash"}, rows: [][]driver.Value{{last.entryHash}}}, nil

	case strings.Contains(query, "SELECT `revision_no`, `receipt_code`, `action` FROM `qbank_revisions`"):
		if len(c.state.revisions) == 0 {
			return &mockAttestRows{cols: []string{"revision_no", "receipt_code", "action"}}, nil
		}
		for i := len(c.state.revisions) - 1; i >= 0; i-- {
			r := c.state.revisions[i]
			if r.scope.Year == int(copied[0].(int64)) && r.scope.Season == copied[1].(string) &&
				r.scope.BankType == copied[2].(string) && r.scope.Subject == copied[3].(string) &&
				r.scope.Grade == copied[4].(string) && r.scope.Tier == copied[5].(string) && r.scope.Week == int(copied[6].(int64)) {
				return &mockAttestRows{
					cols: []string{"revision_no", "receipt_code", "action"},
					rows: [][]driver.Value{{int64(r.revisionNo), r.receiptCode, r.action}},
				}, nil
			}
		}
		return &mockAttestRows{cols: []string{"revision_no", "receipt_code", "action"}}, nil

	case strings.Contains(query, "SELECT `real_name` FROM `users`"):
		return &mockAttestRows{cols: []string{"real_name"}, rows: [][]driver.Value{{"王老师"}}}, nil

	case strings.Contains(query, "FROM `qbank_revisions` WHERE `receipt_code` = ?"):
		code := copied[0].(string)
		for _, r := range c.state.revisions {
			if r.receiptCode == code {
				return revisionRows([]*revisionRecord{r}), nil
			}
		}
		return revisionRows(nil), nil

	case strings.Contains(query, "SELECT `entry_hash` FROM `qbank_revisions` WHERE `id` < ?"):
		id := copied[0].(int64)
		for i := len(c.state.revisions) - 1; i >= 0; i-- {
			if c.state.revisions[i].id < id {
				return &mockAttestRows{cols: []string{"entry_hash"}, rows: [][]driver.Value{{c.state.revisions[i].entryHash}}}, nil
			}
		}
		return &mockAttestRows{cols: []string{"entry_hash"}}, nil

	case strings.Contains(query, "AND `revision_no` > ?"):
		revNo := int(copied[7].(int64))
		for _, r := range c.state.revisions {
			if r.revisionNo > revNo && r.scope.Week == int(copied[6].(int64)) {
				return revisionRows([]*revisionRecord{r}), nil
			}
		}
		return revisionRows(nil), nil

	case strings.Contains(query, "ORDER BY `revision_no` DESC, `id` DESC LIMIT 1") && strings.Contains(query, "WHERE `year` = ?"):
		for i := len(c.state.revisions) - 1; i >= 0; i-- {
			r := c.state.revisions[i]
			if r.scope.Week == int(copied[6].(int64)) {
				return revisionRows([]*revisionRecord{r}), nil
			}
		}
		return revisionRows(nil), nil

	case strings.Contains(query, "FROM `qbank_revisions`") && strings.Contains(query, "ORDER BY `revision_no` DESC, `id` DESC LIMIT ?"):
		revCopy := make([]*revisionRecord, 0, len(c.state.revisions))
		for i := len(c.state.revisions) - 1; i >= 0; i-- {
			revCopy = append(revCopy, c.state.revisions[i])
		}
		return revisionRows(revCopy), nil

	case strings.Contains(query, "SELECT 1 FROM `qbank_revisions` WHERE") && strings.Contains(query, "LOCATE"):
		if c.state.hasRecentPDFMatch {
			return &mockAttestRows{cols: []string{"one"}, rows: [][]driver.Value{{int64(1)}}}, nil
		}
		return &mockAttestRows{cols: []string{"one"}}, nil

	case strings.Contains(query, "FROM `qbank_weeks` qw"):
		return &mockAttestRows{
			cols: []string{"id", "bank_type", "year", "season", "subject", "grade", "tier", "week", "question_count", "latest_receipt_code", "latest_revision_no", "last_action", "updated_by", "updated_by_name", "updated_at", "attempt_count", "revision_count"},
			rows: c.state.matrixRows,
		}, nil

	case strings.Contains(query, "SELECT COUNT(*) FROM `qbank_revisions`"):
		return &mockAttestRows{cols: []string{"cnt"}, rows: [][]driver.Value{{int64(len(c.state.revisions))}}}, nil

	case strings.Contains(query, "SELECT `event_type`, COUNT(*) FROM `qbank_attempt_logs`"):
		return &mockAttestRows{
			cols: []string{"event_type", "cnt"},
			rows: [][]driver.Value{
				{EventUploadPDF, int64(3)},
				{EventClientBlocked, int64(2)},
				{EventSaveCancelled, int64(1)},
			},
		}, nil

	case strings.Contains(query, "SELECT COUNT(*) FROM ("):
		return &mockAttestRows{cols: []string{"cnt"}, rows: [][]driver.Value{{int64(len(c.state.revisions))}}}, nil

	case strings.Contains(query, "FROM (") && strings.Contains(query, ") AS tl ORDER BY"):
		rows := make([][]driver.Value, 0, len(c.state.revisions))
		for i := len(c.state.revisions) - 1; i >= 0; i-- {
			r := c.state.revisions[i]
			rows = append(rows, []driver.Value{
				"revision", r.action, r.receiptCode, r.scope.BankType, int64(r.scope.Year), r.scope.Season, r.scope.Subject, r.scope.Grade, r.scope.Tier, int64(r.scope.Week),
				int64(r.revisionNo), int64(r.questionCount), r.operator, r.operatorName, r.clientIP,
				"", "", "", r.contentSHA256, r.supersedesReceiptCode, int64(r.exercisePDFCount), int64(r.answerPDFCount), int64(r.topicFilledCount), "", r.createdAt,
			})
		}
		return &mockAttestRows{
			cols: []string{"source", "event_type", "receipt_code", "bank_type", "year", "season", "subject", "grade", "tier", "week", "revision_no", "question_count", "operator", "operator_name", "client_ip", "reason", "file_name", "file_sha256", "content_sha256", "supersedes_receipt_code", "exercise_pdf_count", "answer_pdf_count", "topic_filled_count", "details_json", "created_at"},
			rows: rows,
		}, nil
	}
	return nil, fmt.Errorf("unexpected mock query: %s", query)
}

func revisionRows(list []*revisionRecord) *mockAttestRows {
	cols := []string{
		"id", "receipt_code", "qbank_id", "action", "bank_type", "year", "season", "subject", "grade", "tier", "week",
		"revision_no", "supersedes_receipt_code", "question_count", "exercise_pdf_count", "answer_pdf_count", "topic_filled_count",
		"snapshot_json", "content_sha256", "canonical_payload", "prev_entry_hash", "entry_hash", "kid", "signature",
		"operator", "operator_name", "client_ip", "issued_at_utc", "created_at",
	}
	rows := make([][]driver.Value, 0, len(list))
	for _, r := range list {
		var sup any
		if r.supersedesReceiptCode != "" {
			sup = r.supersedesReceiptCode
		}
		rows = append(rows, []driver.Value{
			r.id, r.receiptCode, r.qbankID, r.action, r.scope.BankType, int64(r.scope.Year), r.scope.Season, r.scope.Subject, r.scope.Grade, r.scope.Tier, int64(r.scope.Week),
			int64(r.revisionNo), sup, int64(r.questionCount), int64(r.exercisePDFCount), int64(r.answerPDFCount), int64(r.topicFilledCount),
			r.snapshotJSON, r.contentSHA256, r.canonicalPayload, r.prevEntryHash, r.entryHash, r.kid, r.signature,
			r.operator, r.operatorName, r.clientIP, r.issuedAtUTC, r.createdAt,
		})
	}
	return &mockAttestRows{cols: cols, rows: rows}
}

type mockAttestTx struct{ state *mockAttestDBState }

func (t *mockAttestTx) Commit() error {
	t.state.mu.Lock()
	t.state.txCommitted++
	t.state.mu.Unlock()
	return nil
}
func (t *mockAttestTx) Rollback() error {
	t.state.mu.Lock()
	t.state.txRolledBack++
	t.state.mu.Unlock()
	return nil
}

type mockAttestStmt struct {
	state *mockAttestDBState
	query string
}

func (s *mockAttestStmt) Close() error  { return nil }
func (s *mockAttestStmt) NumInput() int { return -1 }
func (s *mockAttestStmt) Exec(args []driver.Value) (driver.Result, error) {
	return mockAttestResult{lastID: 1, affected: 1}, nil
}
func (s *mockAttestStmt) Query(args []driver.Value) (driver.Rows, error) { return nil, driver.ErrSkip }

type mockAttestResult struct{ lastID, affected int64 }

func (r mockAttestResult) LastInsertId() (int64, error) { return r.lastID, nil }
func (r mockAttestResult) RowsAffected() (int64, error) { return r.affected, nil }

type mockAttestRows struct {
	cols []string
	rows [][]driver.Value
	idx  int
}

func (r *mockAttestRows) Columns() []string { return r.cols }
func (r *mockAttestRows) Close() error      { return nil }
func (r *mockAttestRows) Next(dest []driver.Value) error {
	if r.idx >= len(r.rows) {
		return io.EOF
	}
	copy(dest, r.rows[r.idx])
	r.idx++
	return nil
}

func openMockAttestDB(t *testing.T, st *mockAttestDBState) *sql.DB {
	t.Helper()
	dsn := t.Name()
	mockAttestDBMu.Lock()
	mockAttestDBRegistry[dsn] = st
	mockAttestDBMu.Unlock()
	t.Cleanup(func() {
		mockAttestDBMu.Lock()
		delete(mockAttestDBRegistry, dsn)
		mockAttestDBMu.Unlock()
	})
	db, err := sql.Open("mock_attest_mysql", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestMySQLStoreEndToEnd(t *testing.T) {
	ctx := context.Background()
	st := &mockAttestDBState{
		registeredKeys:    make(map[string]keyRecord),
		hasRecentPDFMatch: true,
		matrixRows: [][]driver.Value{
			{int64(42), "homework", int64(2026), "秋", "数学", "七年级", "S+", int64(3), int64(5), "QB-20261123-AAAAAA-BBBB", int64(2), "update", "t101", "王老师", time.Date(2026, 11, 23, 5, 0, 0, 0, time.UTC), int64(4), int64(2)},
		},
	}
	db := openMockAttestDB(t, st)
	signer, _ := NewEphemeralSigner("jf-qb-mysql1")
	store := NewMySQLStore(db, signer, "")

	// EnsureKeyRegistered inserts once without UPDATE statements (safe with append-only triggers).
	if err := store.EnsureKeyRegistered(ctx); err != nil {
		t.Fatalf("EnsureKeyRegistered: %v", err)
	}
	if err := store.EnsureKeyRegistered(ctx); err != nil {
		t.Fatalf("EnsureKeyRegistered idempotent: %v", err)
	}
	for _, ex := range st.execs {
		if strings.Contains(strings.ToUpper(ex.query), "UPDATE `qbank_attestation_keys`") {
			t.Fatalf("EnsureKeyRegistered must never execute UPDATE on qbank_attestation_keys: %s", ex.query)
		}
	}

	// Test key collision detection when DB has a different public key for same kid.
	otherSigner, _ := NewEphemeralSigner("jf-qb-mysql1")
	mismatchStore := NewMySQLStore(db, otherSigner, "")
	if err := mismatchStore.EnsureKeyRegistered(ctx); err == nil {
		t.Fatal("expected error when registered kid has different public key")
	}

	// RecordRevisionTx inside caller-managed tx.
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	scope := Scope{BankType: "homework", Year: 2026, Season: "秋", Subject: "数学", Grade: "七年级", Tier: "S+", Week: 3}
	saveInputs := SnapshotQuestionsFromSaveInputs([]qbank.SaveQuestionInput{
		{
			QuestionNum: 1,
			SubNum:      1,
			Topic:       "二元一次方程",
			ExerciseURL: "data/pdfs/pdf_m1.pdf",
		},
	})
	rec1, err := store.RecordRevisionTx(ctx, tx, RecordRevisionInput{
		QBankID:   42,
		Scope:     scope,
		Operator:  "t101",
		ClientIP:  "127.0.0.1",
		Questions: saveInputs,
	})
	if err != nil {
		t.Fatalf("RecordRevisionTx(with tx): %v", err)
	}
	if st.txCommitted != 0 {
		t.Fatal("RecordRevisionTx must not commit caller-owned tx")
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if rec1.Action != ActionCreate || rec1.Operator.RealName != "王老师" {
		t.Fatalf("unexpected auto-action or operator lookup: %+v", rec1)
	}

	// Verify tail lock query was issued.
	foundTailLock := false
	for _, q := range st.queries {
		if strings.Contains(q.query, "ORDER BY `id` DESC LIMIT 1 FOR UPDATE") {
			foundTailLock = true
			break
		}
	}
	if !foundTailLock {
		t.Fatal("expected SELECT ... ORDER BY id DESC LIMIT 1 FOR UPDATE inside RecordRevisionTx")
	}

	// RecordRevisionTx with tx == nil creates and commits its own tx.
	rec2, err := store.RecordRevisionTx(ctx, nil, RecordRevisionInput{
		QBankID:  42,
		Scope:    scope,
		Operator: "t101",
		Questions: []SnapshotQuestion{
			{QuestionNum: 1, Topic: "二元一次方程组", ExercisePDF: "data/pdfs/pdf_m2.pdf", ExerciseSHA256: strings.Repeat("e", 64)},
		},
	})
	if err != nil {
		t.Fatalf("RecordRevisionTx(nil tx): %v", err)
	}
	if rec2.Action != ActionUpdate || rec2.RevisionNo != 2 || rec2.Supersedes != rec1.ReceiptCode {
		t.Fatalf("unexpected rev2: %+v", rec2)
	}
	if st.txCommitted != 2 {
		t.Fatalf("expected txCommitted=2, got %d", st.txCommitted)
	}

	// VerifyReceipt across MySQLStore.
	vr1, err := store.VerifyReceipt(ctx, rec1.ReceiptCode)
	if err != nil {
		t.Fatalf("VerifyReceipt(rec1): %v", err)
	}
	if vr1.Status != StatusSuperseded || !vr1.SignatureValid || !vr1.ChainValid {
		t.Fatalf("unexpected vr1: %+v", vr1)
	}
	vr2, err := store.VerifyReceipt(ctx, rec2.ReceiptCode)
	if err != nil {
		t.Fatalf("VerifyReceipt(rec2): %v", err)
	}
	if vr2.Status != StatusValid || !vr2.SignatureValid || !vr2.ChainValid {
		t.Fatalf("unexpected vr2: %+v", vr2)
	}

	// RecordAttempt, ListRevisions, ListTimeline, ListMatrix, ListPublicKeys, HasRecentPDFReference.
	if err := store.RecordAttempt(ctx, AttemptInput{
		EventType: EventUploadPDF, Scope: scope, Operator: "t101", FileURL: "data/pdfs/pdf_m2.pdf", FileName: "m2.pdf", FileSHA256: strings.Repeat("e", 64), FileSize: 512,
		Details: map[string]any{"role": "exercise"},
	}); err != nil {
		t.Fatalf("RecordAttempt: %v", err)
	}
	if err := store.RecordAttempt(ctx, AttemptInput{EventType: "unknown_event"}); err == nil {
		t.Fatal("expected error for invalid attempt event_type")
	}

	revs, err := store.ListRevisions(ctx, RevisionFilter{Subject: "数学"})
	if err != nil || len(revs) != 2 {
		t.Fatalf("ListRevisions: len=%d err=%v", len(revs), err)
	}
	tl, err := store.ListTimeline(ctx, TimelineFilter{EventType: "client_blocked,save_rejected"})
	if err != nil || tl.Stats.Revisions != 2 || tl.Stats.Uploads != 3 {
		t.Fatalf("ListTimeline: %+v err=%v", tl, err)
	}
	mx, err := store.ListMatrix(ctx, MatrixFilter{Subject: "数学", Search: "t101"})
	if err != nil || len(mx) != 1 || mx[0].QuestionCount != 5 {
		t.Fatalf("ListMatrix: %+v err=%v", mx, err)
	}
	jwks, err := store.ListPublicKeys(ctx)
	if err != nil || len(jwks) != 1 || jwks[0].Kid != "jf-qb-mysql1" {
		t.Fatalf("ListPublicKeys: %+v err=%v", jwks, err)
	}
	hasRef, err := store.HasRecentPDFReference(ctx, "data/pdfs/pdf_m2.pdf", 180*24*time.Hour)
	if err != nil || !hasRef {
		t.Fatalf("HasRecentPDFReference: has=%v err=%v", hasRef, err)
	}
	if _, err := store.HasRecentPDFReference(ctx, "../evil.pdf", 180*24*time.Hour); err != nil {
		t.Fatalf("HasRecentPDFReference invalid path unexpected err: %v", err)
	}
}
