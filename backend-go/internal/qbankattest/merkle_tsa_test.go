package qbankattest

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/hex"
	"encoding/pem"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
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

type mockTSAPKI struct {
	caCert  *x509.Certificate
	tsaCert *x509.Certificate
	tsaKey  *ecdsa.PrivateKey
	roots   *x509.CertPool
}

func newMockTSAPKI(t *testing.T, notBefore, notAfter time.Time, ekus []x509.ExtKeyUsage) *mockTSAPKI {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate CA key: %v", err)
	}
	caTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Mock TSA Root CA"},
		NotBefore:             notBefore.Add(-24 * time.Hour),
		NotAfter:              notAfter.Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatalf("create CA cert: %v", err)
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatalf("parse CA cert: %v", err)
	}

	tsaKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate TSA key: %v", err)
	}
	tsaTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(100),
		Subject:      pkix.Name{CommonName: "Mock TSA Signer"},
		SubjectKeyId: []byte{1, 2, 3, 4, 5, 6, 7, 8},
		NotBefore:    notBefore,
		NotAfter:     notAfter,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  ekus,
	}
	tsaDER, err := x509.CreateCertificate(rand.Reader, tsaTmpl, caCert, &tsaKey.PublicKey, caKey)
	if err != nil {
		t.Fatalf("create TSA cert: %v", err)
	}
	tsaCert, err := x509.ParseCertificate(tsaDER)
	if err != nil {
		t.Fatalf("parse TSA cert: %v", err)
	}

	roots := x509.NewCertPool()
	roots.AddCert(caCert)
	return &mockTSAPKI{
		caCert:  caCert,
		tsaCert: tsaCert,
		tsaKey:  tsaKey,
		roots:   roots,
	}
}

func mustRawAttrSet(t *testing.T, val any) asn1.RawValue {
	t.Helper()
	b, err := asn1.Marshal(val)
	if err != nil {
		t.Fatalf("marshal attr val: %v", err)
	}
	return asn1.RawValue{Class: asn1.ClassUniversal, Tag: asn1.TagSet, IsCompound: true, Bytes: b}
}

type mockTSATokenOptions struct {
	overrideHashAlg  asn1.ObjectIdentifier
	overrideDigest   []byte
	omitSignerInfos  bool
	omitCertificates bool
	tamperTSTInfo    bool
	tamperSignedAttr bool
	cmsDigestOID     asn1.ObjectIdentifier
	useSKID          bool
}

func buildMockTSARespDERWithPKI(t *testing.T, pki *mockTSAPKI, reqBytes []byte, genTime time.Time, opts mockTSATokenOptions) []byte {
	t.Helper()
	var req timeStampReq
	if _, err := asn1.Unmarshal(reqBytes, &req); err != nil {
		t.Fatalf("unmarshal req: %v", err)
	}
	imprint := req.MessageImprint
	if len(opts.overrideHashAlg) > 0 {
		imprint.HashAlgorithm = pkix.AlgorithmIdentifier{Algorithm: opts.overrideHashAlg, Parameters: asn1.NullRawValue}
	}
	if len(opts.overrideDigest) > 0 {
		imprint.HashedMessage = opts.overrideDigest
	}

	info := tstInfo{
		Version:        1,
		Policy:         asn1.ObjectIdentifier{1, 2, 3, 4},
		MessageImprint: imprint,
		SerialNumber:   big.NewInt(42),
		GenTime:        genTime.UTC(),
		Nonce:          req.Nonce,
	}
	infoBytes, err := asn1.Marshal(info)
	if err != nil {
		t.Fatalf("marshal tstInfo: %v", err)
	}

	cmsDigestOID := oidSHA256
	if len(opts.cmsDigestOID) > 0 {
		cmsDigestOID = opts.cmsDigestOID
	}

	var encapDigest []byte
	if cmsDigestOID.Equal(asn1.ObjectIdentifier{1, 2, 840, 113549, 2, 5}) {
		s := md5.Sum(infoBytes)
		encapDigest = s[:]
	} else {
		s := sha256.Sum256(infoBytes)
		encapDigest = s[:]
	}

	attrs := []cmsAttribute{
		{Type: oidContentType, Values: mustRawAttrSet(t, oidTSTInfo)},
		{Type: oidMessageDigest, Values: mustRawAttrSet(t, encapDigest)},
	}
	signedAttrsSET, err := asn1.MarshalWithParams(attrs, "set")
	if err != nil {
		t.Fatalf("marshal SignedAttrs SET: %v", err)
	}
	var setRV asn1.RawValue
	if _, err := asn1.Unmarshal(signedAttrsSET, &setRV); err != nil {
		t.Fatalf("unmarshal SignedAttrs SET: %v", err)
	}

	attrsDigest := sha256.Sum256(signedAttrsSET)
	sigBytes, err := ecdsa.SignASN1(rand.Reader, pki.tsaKey, attrsDigest[:])
	if err != nil {
		t.Fatalf("sign SignedAttrs: %v", err)
	}

	if opts.tamperSignedAttr {
		attrs[1] = cmsAttribute{Type: oidMessageDigest, Values: mustRawAttrSet(t, make([]byte, sha256.Size))}
		tamperedSET, _ := asn1.MarshalWithParams(attrs, "set")
		_, _ = asn1.Unmarshal(tamperedSET, &setRV)
	}
	if opts.tamperTSTInfo {
		info.SerialNumber = big.NewInt(99)
		infoBytes, _ = asn1.Marshal(info)
	}

	var sidRV asn1.RawValue
	if opts.useSKID {
		sidRV = asn1.RawValue{Class: asn1.ClassContextSpecific, Tag: 0, Bytes: pki.tsaCert.SubjectKeyId}
	} else {
		iasnDER, err := asn1.Marshal(issuerAndSerialNumber{
			Issuer:       asn1.RawValue{FullBytes: pki.tsaCert.RawIssuer},
			SerialNumber: pki.tsaCert.SerialNumber,
		})
		if err != nil {
			t.Fatalf("marshal SID: %v", err)
		}
		sidRV = asn1.RawValue{FullBytes: iasnDER}
	}

	var signerInfos []signerInfo
	if !opts.omitSignerInfos {
		signerInfos = []signerInfo{
			{
				Version:         1,
				SID:             sidRV,
				DigestAlgorithm: pkix.AlgorithmIdentifier{Algorithm: cmsDigestOID, Parameters: asn1.NullRawValue},
				SignedAttrs: asn1.RawValue{
					Class:      asn1.ClassContextSpecific,
					Tag:        0,
					IsCompound: true,
					Bytes:      setRV.Bytes,
				},
				SignatureAlgorithm: pkix.AlgorithmIdentifier{Algorithm: oidECDSAWithSHA256},
				Signature:          sigBytes,
			},
		}
	}

	var certsRV asn1.RawValue
	if !opts.omitCertificates {
		certsRV = asn1.RawValue{
			Class:      asn1.ClassContextSpecific,
			Tag:        0,
			IsCompound: true,
			Bytes:      pki.tsaCert.Raw,
		}
	}

	digestAlgSet, _ := asn1.MarshalWithParams([]pkix.AlgorithmIdentifier{{Algorithm: cmsDigestOID, Parameters: asn1.NullRawValue}}, "set")
	sd := signedData{
		Version:          3,
		DigestAlgorithms: asn1.RawValue{FullBytes: digestAlgSet},
		EncapContentInfo: encapsulatedContentInfo{
			EContentType: oidTSTInfo,
			EContent:     infoBytes,
		},
		Certificates: certsRV,
		SignerInfos:  signerInfos,
	}
	sdBytes, err := asn1.Marshal(sd)
	if err != nil {
		t.Fatalf("marshal signedData: %v", err)
	}
	ci := contentInfo{
		ContentType: oidSignedData,
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
	now := time.Date(2026, 11, 23, 8, 30, 0, 0, time.UTC)
	pki := newMockTSAPKI(t, now.Add(-time.Hour), now.Add(time.Hour), []x509.ExtKeyUsage{x509.ExtKeyUsageTimeStamping})

	digest := sha256.Sum256([]byte("merkle-root-test"))
	reqBytes, nonce, err := BuildTimeStampReq(digest[:])
	if err != nil {
		t.Fatalf("BuildTimeStampReq: %v", err)
	}

	respDER := buildMockTSARespDERWithPKI(t, pki, reqBytes, now, mockTSATokenOptions{})

	parsed, err := ParseTimeStampRespWithRoots(respDER, digest[:], nonce, pki.roots)
	if err != nil {
		t.Fatalf("ParseTimeStampRespWithRoots: %v", err)
	}
	if parsed.GenTime != "2026-11-23T08:30:00Z" {
		t.Fatalf("unexpected GenTime: %q", parsed.GenTime)
	}
	if parsed.TokenB64 == "" {
		t.Fatal("expected non-empty TokenB64")
	}

	// Verify SubjectKeyIdentifier SID variant also passes.
	skidResp := buildMockTSARespDERWithPKI(t, pki, reqBytes, now, mockTSATokenOptions{useSKID: true})
	if _, err := ParseTimeStampRespWithRoots(skidResp, digest[:], nonce, pki.roots); err != nil {
		t.Fatalf("ParseTimeStampRespWithRoots(SKID): %v", err)
	}

	// Verify ParseTimeStampResp honors TSA_CA_CERT_FILE env var and rejects untrusted CA without it.
	if _, err := ParseTimeStampResp(respDER, digest[:], nonce); err == nil {
		t.Fatal("expected ParseTimeStampResp to reject untrusted self-signed TSA CA")
	}
	caFile := filepath.Join(t.TempDir(), "tsa-ca.pem")
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: pki.caCert.Raw})
	if err := os.WriteFile(caFile, caPEM, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TSA_CA_CERT_FILE", caFile)
	if _, err := ParseTimeStampResp(respDER, digest[:], nonce); err != nil {
		t.Fatalf("ParseTimeStampResp with TSA_CA_CERT_FILE: %v", err)
	}

	wrongDigest := sha256.Sum256([]byte("other"))
	if _, err := ParseTimeStampRespWithRoots(respDER, wrongDigest[:], nonce, pki.roots); err == nil {
		t.Fatal("expected mismatch error for wrong digest")
	}
	if _, err := ParseTimeStampRespWithRoots(respDER, digest[:], big.NewInt(999), pki.roots); err == nil {
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
	noNonceResp := buildMockTSARespDERWithPKI(t, pki, noNonceReq, now, mockTSATokenOptions{})
	if _, err := ParseTimeStampRespWithRoots(noNonceResp, digest[:], nonce, pki.roots); err == nil {
		t.Fatal("expected error when TSA response omits requested nonce")
	}

	// Negative cryptographic / CMS / EKU checks:
	// 1. Unsigned token (no SignerInfos).
	unsignedResp := buildMockTSARespDERWithPKI(t, pki, reqBytes, now, mockTSATokenOptions{omitSignerInfos: true})
	if _, err := ParseTimeStampRespWithRoots(unsignedResp, digest[:], nonce, pki.roots); err == nil {
		t.Fatal("expected rejection for unsigned TSA response without SignerInfos")
	}

	// 2. Missing embedded certificates.
	noCertResp := buildMockTSARespDERWithPKI(t, pki, reqBytes, now, mockTSATokenOptions{omitCertificates: true})
	if _, err := ParseTimeStampRespWithRoots(noCertResp, digest[:], nonce, pki.roots); err == nil {
		t.Fatal("expected rejection for TSA response without embedded certs")
	}

	// 3. MD5 MessageImprint hash algorithm rejected.
	md5Sum := md5.Sum([]byte("merkle-root-test"))
	md5ImprintResp := buildMockTSARespDERWithPKI(t, pki, reqBytes, now, mockTSATokenOptions{
		overrideHashAlg: asn1.ObjectIdentifier{1, 2, 840, 113549, 2, 5},
		overrideDigest:  md5Sum[:],
	})
	if _, err := ParseTimeStampRespWithRoots(md5ImprintResp, md5Sum[:], nonce, pki.roots); err == nil {
		t.Fatal("expected rejection for MD5 MessageImprint algorithm")
	}

	// 4. MD5 CMS DigestAlgorithm rejected.
	md5CMSResp := buildMockTSARespDERWithPKI(t, pki, reqBytes, now, mockTSATokenOptions{
		cmsDigestOID: asn1.ObjectIdentifier{1, 2, 840, 113549, 2, 5},
	})
	if _, err := ParseTimeStampRespWithRoots(md5CMSResp, digest[:], nonce, pki.roots); err == nil {
		t.Fatal("expected rejection for MD5 CMS DigestAlgorithm")
	}

	// 5. Wrong EKU (missing ExtKeyUsageTimeStamping).
	wrongEKUPKI := newMockTSAPKI(t, now.Add(-time.Hour), now.Add(time.Hour), []x509.ExtKeyUsage{x509.ExtKeyUsageCodeSigning})
	wrongEKUResp := buildMockTSARespDERWithPKI(t, wrongEKUPKI, reqBytes, now, mockTSATokenOptions{})
	if _, err := ParseTimeStampRespWithRoots(wrongEKUResp, digest[:], nonce, wrongEKUPKI.roots); err == nil {
		t.Fatal("expected rejection for cert lacking ExtKeyUsageTimeStamping")
	}

	// 6. Tampered TSTInfo (messageDigest mismatch) and tampered SignedAttrs (signature mismatch).
	tamperedTST := buildMockTSARespDERWithPKI(t, pki, reqBytes, now, mockTSATokenOptions{tamperTSTInfo: true})
	if _, err := ParseTimeStampRespWithRoots(tamperedTST, digest[:], nonce, pki.roots); err == nil {
		t.Fatal("expected rejection for tampered TSTInfo")
	}
	tamperedAttrs := buildMockTSARespDERWithPKI(t, pki, reqBytes, now, mockTSATokenOptions{tamperSignedAttr: true})
	if _, err := ParseTimeStampRespWithRoots(tamperedAttrs, digest[:], nonce, pki.roots); err == nil {
		t.Fatal("expected rejection for tampered SignedAttrs")
	}

	// 7. GenTime outside cert validity window.
	expiredResp := buildMockTSARespDERWithPKI(t, pki, reqBytes, now.Add(48*time.Hour), mockTSATokenOptions{})
	if _, err := ParseTimeStampRespWithRoots(expiredResp, digest[:], nonce, pki.roots); err == nil {
		t.Fatal("expected rejection when GenTime is outside cert validity window")
	}

	// 8. NewTSAClientFromEnv uses SSRF-safe HTTP client (blocks loopback).
	t.Setenv("ATTESTATION_TSA_URL", "http://127.0.0.1:18080/tsr")
	envClient := NewTSAClientFromEnv()
	if envClient == nil {
		t.Fatal("expected non-nil TSAClient")
	}
	if _, err := envClient.Timestamp(context.Background(), digest[:]); err == nil || !strings.Contains(err.Error(), "内网") {
		t.Fatalf("expected SSRF block from NewTSAClientFromEnv safe HTTP client, got %v", err)
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

	genTime := time.Date(2026, 11, 23, 9, 0, 0, 0, time.UTC)
	pki := newMockTSAPKI(t, genTime.Add(-time.Hour), genTime.Add(time.Hour), []x509.ExtKeyUsage{x509.ExtKeyUsageTimeStamping})

	tsaSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		respDER := buildMockTSARespDERWithPKI(t, pki, body, genTime, mockTSATokenOptions{})
		w.Header().Set("Content-Type", "application/timestamp-reply")
		_, _ = w.Write(respDER)
	}))
	defer tsaSrv.Close()

	anc, err := ms.AnchorUnanchoredRevisions(ctx, &HTTPTSAClient{URL: tsaSrv.URL, HTTPClient: tsaSrv.Client(), RootCAs: pki.roots})
	if err != nil {
		t.Fatalf("AnchorUnanchoredRevisions: %v", err)
	}
	if anc == nil || anc.RevisionCount != 3 || anc.TSAStatus != TSAStatusAnchored || anc.ErrorMessage != "" {
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

	// Test failed TSA records tsa_status="failed" + non-empty error_message
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

	ancFailed, err := ms.AnchorUnanchoredRevisions(ctx, &HTTPTSAClient{URL: failTSA.URL, HTTPClient: failTSA.Client()})
	if err != nil {
		t.Fatalf("AnchorUnanchoredRevisions failed-tsa fallback: %v", err)
	}
	if ancFailed.TSAStatus != TSAStatusFailed || ancFailed.RevisionCount != 1 || !strings.Contains(ancFailed.ErrorMessage, "503") {
		t.Fatalf("expected tsa_status=failed with 503 error_message, got %+v", ancFailed)
	}
	vr4, err := ms.VerifyReceipt(ctx, rec4.ReceiptCode)
	if err != nil || vr4.Anchor == nil || vr4.Anchor.TSAStatus != TSAStatusFailed || vr4.Anchor.ErrorMessage == "" {
		t.Fatalf("expected failed anchor proof in VerifyReceipt, got %+v err=%v", vr4, err)
	}

	// Test local_only when tsa == nil
	_, err = ms.RecordRevisionTx(ctx, nil, RecordRevisionInput{
		QBankID:   5,
		Action:    ActionCreate,
		Scope:     Scope{Year: 2026, Season: "spring", BankType: "weekly", Subject: "物理", Grade: "高一", Tier: "实验班", Week: 5},
		Operator:  "teacher1",
		Questions: []SnapshotQuestion{{QuestionNum: 1, Topic: "机械能"}},
	})
	if err != nil {
		t.Fatalf("RecordRevisionTx 5: %v", err)
	}
	ancLocal, err := ms.AnchorUnanchoredRevisions(ctx, nil)
	if err != nil || ancLocal == nil || ancLocal.TSAStatus != TSAStatusLocalOnly || ancLocal.ErrorMessage != "" {
		t.Fatalf("expected local_only when tsa==nil, got (%+v, %v)", ancLocal, err)
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
