package qbankattest

import (
	"context"
	"crypto/sha256"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/hex"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func testSHA256Hex(label string) string {
	sum := sha256.Sum256([]byte(label))
	return hex.EncodeToString(sum[:])
}

func TestComputeAndVerifyMerkleTree(t *testing.T) {
	if _, _, err := ComputeMerkleTree(nil); err == nil {
		t.Fatal("expected error for empty leaf slice")
	}

	for _, count := range []int{1, 2, 3, 4, 5, 7} {
		leaves := make([]string, count)
		for i := 0; i < count; i++ {
			leaves[i] = testSHA256Hex("leaf-" + string(rune('a'+i)))
		}
		root, proofs, err := ComputeMerkleTree(leaves)
		if err != nil {
			t.Fatalf("count=%d ComputeMerkleTree failed: %v", count, err)
		}
		if len(proofs) != count {
			t.Fatalf("count=%d expected %d proofs, got %d", count, count, len(proofs))
		}
		for i, leaf := range leaves {
			if !VerifyMerkleProof(leaf, root, proofs[i]) {
				t.Fatalf("count=%d leaf %d proof failed verification", count, i)
			}
			tampered := testSHA256Hex("tampered")
			if VerifyMerkleProof(tampered, root, proofs[i]) {
				t.Fatalf("count=%d leaf %d accepted tampered leaf", count, i)
			}
		}
	}
}

func buildMockTSARespDER(t *testing.T, reqBytes []byte, genTime time.Time) []byte {
	t.Helper()
	var req timeStampReq
	if _, err := asn1.Unmarshal(reqBytes, &req); err != nil {
		t.Fatalf("unmarshal req: %v", err)
	}
	info := tstInfo{
		Version:        1,
		Policy:         asn1.ObjectIdentifier{1, 2, 3, 4},
		MessageImprint: req.MessageImprint,
		SerialNumber:   big.NewInt(42),
		GenTime:        genTime.UTC(),
		Nonce:          req.Nonce,
	}
	infoBytes, err := asn1.Marshal(info)
	if err != nil {
		t.Fatalf("marshal tstInfo: %v", err)
	}
	sd := signedData{
		Version:          3,
		DigestAlgorithms: asn1.RawValue{Class: asn1.ClassUniversal, Tag: asn1.TagSet, IsCompound: true},
		EncapContentInfo: encapsulatedContentInfo{
			EContentType: oidTSTInfo,
			EContent:     infoBytes,
		},
	}
	sdBytes, err := asn1.Marshal(sd)
	if err != nil {
		t.Fatalf("marshal signedData: %v", err)
	}
	ci := contentInfo{
		ContentType: asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 7, 2},
		Content:     asn1.RawValue{Class: asn1.ClassContextSpecific, Tag: 0, IsCompound: true, Bytes: sdBytes},
	}
	ciBytes, err := asn1.Marshal(ci)
	if err != nil {
		t.Fatalf("marshal contentInfo: %v", err)
	}
	resp := timeStampResp{
		Status:         pkiStatusInfo{Status: 0},
		TimeStampToken: asn1.RawValue{FullBytes: ciBytes},
	}
	der, err := asn1.Marshal(resp)
	if err != nil {
		t.Fatalf("marshal timeStampResp: %v", err)
	}
	return der
}

func TestBuildAndParseTimeStampResp(t *testing.T) {
	digest := sha256.Sum256([]byte("merkle-root-test"))
	reqBytes, nonce, err := BuildTimeStampReq(digest[:])
	if err != nil {
		t.Fatalf("BuildTimeStampReq: %v", err)
	}

	now := time.Date(2026, 11, 23, 8, 30, 0, 0, time.UTC)
	respDER := buildMockTSARespDER(t, reqBytes, now)

	parsed, err := ParseTimeStampResp(respDER, digest[:], nonce)
	if err != nil {
		t.Fatalf("ParseTimeStampResp: %v", err)
	}
	if parsed.GenTime != "2026-11-23T08:30:00Z" {
		t.Fatalf("unexpected GenTime: %q", parsed.GenTime)
	}
	if parsed.TokenB64 == "" {
		t.Fatal("expected non-empty TokenB64")
	}

	wrongDigest := sha256.Sum256([]byte("other"))
	if _, err := ParseTimeStampResp(respDER, wrongDigest[:], nonce); err == nil {
		t.Fatal("expected mismatch error for wrong digest")
	}
	if _, err := ParseTimeStampResp(respDER, digest[:], big.NewInt(999)); err == nil {
		t.Fatal("expected mismatch error for wrong nonce")
	}
	// Response omitting Nonce must be rejected when expectedNonce != nil (RFC 3161 §2.4.2).
	noNonceReq, err := asn1.Marshal(timeStampReq{
		Version: 1,
		MessageImprint: messageImprint{
			HashAlgorithm: pkix.AlgorithmIdentifier{Algorithm: oidSHA256, Parameters: asn1.NullRawValue},
			HashedMessage: digest[:],
		},
		CertReq: true,
	})
	if err != nil {
		t.Fatalf("marshal no-nonce req: %v", err)
	}
	noNonceResp := buildMockTSARespDER(t, noNonceReq, now)
	if _, err := ParseTimeStampResp(noNonceResp, digest[:], nonce); err == nil {
		t.Fatal("expected error when TSA response omits requested nonce")
	}
}

func TestMemoryStoreAnchorAndVerifyReceipt(t *testing.T) {
	t.Setenv("QBANK_ATTESTATION_PRIVATE_KEY", "")
	t.Setenv("QBANK_ATTESTATION_KEY_FILE", "")
	signer, err := LoadSigner("test-secret-phase2")
	if err != nil {
		t.Fatalf("LoadOrDeriveSigner: %v", err)
	}
	ms := NewMemoryStore(signer, t.TempDir())
	ctx := context.Background()

	var receipts []*Receipt
	for w := 1; w <= 3; w++ {
		rec, err := ms.RecordRevisionTx(ctx, nil, RecordRevisionInput{
			QBankID:  int64(w),
			Action:   ActionCreate,
			Scope:    Scope{Year: 2026, Season: "spring", BankType: "weekly", Subject: "物理", Grade: "高一", Tier: "实验班", Week: w},
			Operator: "teacher1",
			Questions: []SnapshotQuestion{
				{QuestionNum: 1, Topic: "牛顿定律"},
			},
		})
		if err != nil {
			t.Fatalf("RecordRevisionTx %d: %v", w, err)
		}
		receipts = append(receipts, rec)
	}

	tsaSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		respDER := buildMockTSARespDER(t, body, time.Date(2026, 11, 23, 9, 0, 0, 0, time.UTC))
		w.Header().Set("Content-Type", "application/timestamp-reply")
		_, _ = w.Write(respDER)
	}))
	defer tsaSrv.Close()

	anc, err := ms.AnchorUnanchoredRevisions(ctx, &HTTPTSAClient{URL: tsaSrv.URL, HTTPClient: tsaSrv.Client()})
	if err != nil {
		t.Fatalf("AnchorUnanchoredRevisions: %v", err)
	}
	if anc == nil || anc.RevisionCount != 3 || anc.TSAStatus != TSAStatusAnchored {
		t.Fatalf("unexpected anchor: %+v", anc)
	}

	// Second call with no new revisions should return nil, nil
	anc2, err := ms.AnchorUnanchoredRevisions(ctx, nil)
	if err != nil || anc2 != nil {
		t.Fatalf("expected nil, nil on second anchor call, got (%+v, %v)", anc2, err)
	}

	// Verify middle receipt includes valid Merkle proof & TSA token
	vr, err := ms.VerifyReceipt(ctx, receipts[1].ReceiptCode)
	if err != nil {
		t.Fatalf("VerifyReceipt: %v", err)
	}
	if vr.Anchor == nil {
		t.Fatal("expected Anchor proof in VerifyResult")
	}
	if !VerifyMerkleProof(vr.Receipt.EntryHash, vr.Anchor.MerkleRoot, vr.Anchor.Proof) {
		t.Fatal("Merkle proof in VerifyResult failed verification")
	}
	if vr.Anchor.TSAStatus != TSAStatusAnchored || vr.Anchor.TSAGenTime != "2026-11-23T09:00:00Z" {
		t.Fatalf("unexpected Anchor TSA metadata: %+v", vr.Anchor)
	}

	// Test graceful local_only fallback when TSA fails
	rec4, err := ms.RecordRevisionTx(ctx, nil, RecordRevisionInput{
		QBankID:   4,
		Action:    ActionCreate,
		Scope:     Scope{Year: 2026, Season: "spring", BankType: "weekly", Subject: "物理", Grade: "高一", Tier: "实验班", Week: 4},
		Operator:  "teacher1",
		Questions: []SnapshotQuestion{{QuestionNum: 1, Topic: "动量守恒"}},
	})
	if err != nil {
		t.Fatalf("RecordRevisionTx 4: %v", err)
	}
	failTSA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer failTSA.Close()

	ancLocal, err := ms.AnchorUnanchoredRevisions(ctx, &HTTPTSAClient{URL: failTSA.URL, HTTPClient: failTSA.Client()})
	if err != nil {
		t.Fatalf("AnchorUnanchoredRevisions fallback: %v", err)
	}
	if ancLocal.TSAStatus != TSAStatusLocalOnly || ancLocal.RevisionCount != 1 {
		t.Fatalf("expected local_only fallback with 1 revision, got %+v", ancLocal)
	}

	// Test GetRevisionSnapshot
	snap, err := ms.GetRevisionSnapshot(ctx, rec4.ReceiptCode)
	if err != nil {
		t.Fatalf("GetRevisionSnapshot: %v", err)
	}
	if len(snap.Snapshot.Questions) != 1 || snap.Snapshot.Questions[0].Topic != "动量守恒" {
		t.Fatalf("unexpected snapshot: %+v", snap)
	}
	if _, err := ms.GetRevisionSnapshot(ctx, "QB-MISSING"); err != ErrRevisionNotFound {
		t.Fatalf("expected ErrRevisionNotFound, got %v", err)
	}
}
