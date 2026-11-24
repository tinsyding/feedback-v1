package qbankattest

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"strings"
	"time"

	"feedback-api/internal/httpx"
)

const (
	// DefaultTSAURL is the default RFC 3161 Time-Stamp Authority endpoint.
	DefaultTSAURL = "https://freetsa.org/tsr"

	// TSA status constants stored in qbank_attestation_anchors.tsa_status.
	TSAStatusAnchored  = "anchored"
	TSAStatusLocalOnly = "local_only"
	TSAStatusFailed    = "failed"
)

var (
	oidSHA256 = asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 2, 1}
	oidSHA384 = asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 2, 2}
	oidSHA512 = asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 2, 3}

	oidTSTInfo       = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 9, 16, 1, 4}
	oidSignedData    = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 7, 2}
	oidContentType   = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 9, 3}
	oidMessageDigest = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 9, 4}

	oidRSAEncryption     = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 1}
	oidRSASSAPSS         = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 10}
	oidSHA256WithRSA     = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 11}
	oidSHA384WithRSA     = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 12}
	oidSHA512WithRSA     = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 13}
	oidECDSAWithSHA256   = asn1.ObjectIdentifier{1, 2, 840, 10045, 4, 3, 2}
	oidECDSAWithSHA384   = asn1.ObjectIdentifier{1, 2, 840, 10045, 4, 3, 3}
	oidECDSAWithSHA512   = asn1.ObjectIdentifier{1, 2, 840, 10045, 4, 3, 4}
	oidEd25519           = asn1.ObjectIdentifier{1, 3, 101, 112}
)

// AnchorRecord represents a persisted batch anchor row in qbank_attestation_anchors.
type AnchorRecord struct {
	ID            int64  `json:"id"`
	AnchorCode    string `json:"anchor_code"`
	SeqFrom       int64  `json:"seq_from"`
	SeqTo         int64  `json:"seq_to"`
	RevisionCount int    `json:"revision_count"`
	MerkleRoot    string `json:"merkle_root"`
	TSAURL        string `json:"tsa_url"`
	TSAStatus     string `json:"tsa_status"`
	TSATokenB64   string `json:"tsa_token_b64,omitempty"`
	TSAGenTime    string `json:"tsa_gen_time,omitempty"`
	ErrorMessage  string `json:"error_message,omitempty"`
	AnchoredAt    string `json:"anchored_at"`
}

// AnchorProof is embedded in VerifyResult when a revision has been included in
// a Merkle anchor batch.
type AnchorProof struct {
	AnchorCode    string            `json:"anchor_code"`
	SeqFrom       int64             `json:"seq_from"`
	SeqTo         int64             `json:"seq_to"`
	RevisionCount int               `json:"revision_count"`
	MerkleRoot    string            `json:"merkle_root"`
	Proof         []MerkleProofStep `json:"proof"`
	TSAURL        string            `json:"tsa_url"`
	TSAStatus     string            `json:"tsa_status"`
	TSATokenB64   string            `json:"tsa_token_b64,omitempty"`
	TSAGenTime    string            `json:"tsa_gen_time,omitempty"`
	ErrorMessage  string            `json:"error_message,omitempty"`
	AnchoredAt    string            `json:"anchored_at"`
}

// TSAResponse holds the parsed result of an RFC 3161 timestamp request.
type TSAResponse struct {
	TokenB64 string
	GenTime  string
}

// TSAClient requests an RFC 3161 timestamp token for a 32-byte SHA-256 digest.
type TSAClient interface {
	Endpoint() string
	Timestamp(ctx context.Context, digest []byte) (*TSAResponse, error)
}

// HTTPTSAClient sends DER-encoded RFC 3161 TimeStampReq payloads over HTTP(S).
type HTTPTSAClient struct {
	URL        string
	HTTPClient *http.Client
	RootCAs    *x509.CertPool
}

// NewTSAClientFromEnv builds an HTTPTSAClient from ATTESTATION_TSA_URL.
// Returning nil when ATTESTATION_TSA_URL is explicitly "off" or "disabled"
// forces local_only Merkle anchoring without network calls.
func NewTSAClientFromEnv() TSAClient {
	raw := strings.TrimSpace(os.Getenv("ATTESTATION_TSA_URL"))
	if strings.EqualFold(raw, "off") || strings.EqualFold(raw, "disabled") || strings.EqualFold(raw, "none") {
		return nil
	}
	if raw == "" {
		raw = DefaultTSAURL
	}
	return &HTTPTSAClient{
		URL:        raw,
		HTTPClient: httpx.NewSafeHTTPClient(12 * time.Second),
	}
}

func (c *HTTPTSAClient) Endpoint() string {
	if c == nil {
		return ""
	}
	return c.URL
}

func (c *HTTPTSAClient) Timestamp(ctx context.Context, digest []byte) (*TSAResponse, error) {
	if c == nil || strings.TrimSpace(c.URL) == "" {
		return nil, errors.New("tsa client not configured")
	}
	reqBytes, nonce, err := BuildTimeStampReq(digest)
	if err != nil {
		return nil, err
	}
	httpClient := c.HTTPClient
	if httpClient == nil {
		httpClient = httpx.NewSafeHTTPClient(12 * time.Second)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL, bytes.NewReader(reqBytes))
	if err != nil {
		return nil, fmt.Errorf("create tsa request: %w", err)
	}
	req.Header.Set("Content-Type", "application/timestamp-query")
	req.Header.Set("Accept", "application/timestamp-reply")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("tsa http post: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
	if err != nil {
		return nil, fmt.Errorf("read tsa response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("tsa http %d", resp.StatusCode)
	}
	return ParseTimeStampRespWithRoots(body, digest, nonce, c.RootCAs)
}

// ASN.1 structures for RFC 3161 TimeStampReq / TimeStampResp & CMS SignedData.
type messageImprint struct {
	HashAlgorithm pkix.AlgorithmIdentifier
	HashedMessage []byte
}

type timeStampReq struct {
	Version        int
	MessageImprint messageImprint
	Nonce          *big.Int `asn1:"optional"`
	CertReq        bool     `asn1:"optional"`
}

type pkiStatusInfo struct {
	Status       int
	StatusString []string       `asn1:"optional,utf8"`
	FailInfo     asn1.BitString `asn1:"optional"`
}

type timeStampResp struct {
	Status         pkiStatusInfo
	TimeStampToken asn1.RawValue `asn1:"optional"`
}

type contentInfo struct {
	ContentType asn1.ObjectIdentifier
	Content     asn1.RawValue `asn1:"explicit,tag:0"`
}

type signedData struct {
	Version          int
	DigestAlgorithms asn1.RawValue `asn1:"set"`
	EncapContentInfo encapsulatedContentInfo
	Certificates     asn1.RawValue `asn1:"optional,tag:0"`
	CRLs             asn1.RawValue `asn1:"optional,tag:1"`
	SignerInfos      []signerInfo  `asn1:"set"`
}

type encapsulatedContentInfo struct {
	EContentType asn1.ObjectIdentifier
	EContent     []byte `asn1:"explicit,optional,tag:0"`
}

type signerInfo struct {
	Version            int
	SID                asn1.RawValue
	DigestAlgorithm    pkix.AlgorithmIdentifier
	SignedAttrs        asn1.RawValue `asn1:"optional,tag:0"`
	SignatureAlgorithm pkix.AlgorithmIdentifier
	Signature          []byte
	UnsignedAttrs      asn1.RawValue `asn1:"optional,tag:1"`
}

type issuerAndSerialNumber struct {
	Issuer       asn1.RawValue
	SerialNumber *big.Int
}

type cmsAttribute struct {
	Type   asn1.ObjectIdentifier
	Values asn1.RawValue
}

type tstAccuracy struct {
	Seconds int `asn1:"optional"`
	Millis  int `asn1:"optional,tag:0"`
	Micros  int `asn1:"optional,tag:1"`
}

type tstInfo struct {
	Version        int
	Policy         asn1.ObjectIdentifier
	MessageImprint messageImprint
	SerialNumber   *big.Int
	GenTime        time.Time   `asn1:"generalized"`
	Accuracy       tstAccuracy `asn1:"optional"`
	Ordering       bool        `asn1:"optional"`
	Nonce          *big.Int    `asn1:"optional"`
}

// BuildTimeStampReq builds a DER-encoded RFC 3161 TimeStampReq for a 32-byte
// SHA-256 digest and returns the request bytes plus the random 64-bit nonce.
func BuildTimeStampReq(digest []byte) ([]byte, *big.Int, error) {
	if len(digest) != sha256.Size {
		return nil, nil, fmt.Errorf("digest must be %d bytes, got %d", sha256.Size, len(digest))
	}
	var nonceBuf [8]byte
	if _, err := rand.Read(nonceBuf[:]); err != nil {
		return nil, nil, fmt.Errorf("generate tsa nonce: %w", err)
	}
	nonce := new(big.Int).SetBytes(nonceBuf[:])
	// Ensure non-negative positive nonce.
	if nonce.Sign() == 0 {
		nonce.SetInt64(1)
	}
	req := timeStampReq{
		Version: 1,
		MessageImprint: messageImprint{
			HashAlgorithm: pkix.AlgorithmIdentifier{
				Algorithm:  oidSHA256,
				Parameters: asn1.NullRawValue,
			},
			HashedMessage: digest,
		},
		Nonce:   nonce,
		CertReq: true,
	}
	der, err := asn1.Marshal(req)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal TimeStampReq: %w", err)
	}
	return der, nonce, nil
}

func defaultTSARootCAs() (*x509.CertPool, error) {
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	if caFile := strings.TrimSpace(os.Getenv("TSA_CA_CERT_FILE")); caFile != "" {
		pemBytes, readErr := os.ReadFile(caFile)
		if readErr != nil {
			return nil, fmt.Errorf("read TSA_CA_CERT_FILE %q: %w", caFile, readErr)
		}
		if !pool.AppendCertsFromPEM(pemBytes) {
			return nil, fmt.Errorf("parse TSA_CA_CERT_FILE %q: no valid PEM certificates", caFile)
		}
	}
	return pool, nil
}

// ParseTimeStampResp validates an RFC 3161 TimeStampResp DER payload including
// PKIStatus, SHA-256 MessageImprint, Nonce, CMS SignedData signature/SignedAttrs,
// and TSA certificate chain (with ExtKeyUsageTimeStamping) against system roots
// plus optional TSA_CA_CERT_FILE.
func ParseTimeStampResp(respBytes []byte, expectedDigest []byte, expectedNonce *big.Int) (*TSAResponse, error) {
	return ParseTimeStampRespWithRoots(respBytes, expectedDigest, expectedNonce, nil)
}

// ParseTimeStampRespWithRoots validates an RFC 3161 TimeStampResp DER payload
// against explicit roots (or default system + TSA_CA_CERT_FILE roots if nil).
func ParseTimeStampRespWithRoots(respBytes []byte, expectedDigest []byte, expectedNonce *big.Int, roots *x509.CertPool) (*TSAResponse, error) {
	var resp timeStampResp
	rest, err := asn1.Unmarshal(respBytes, &resp)
	if err != nil {
		return nil, fmt.Errorf("unmarshal TimeStampResp: %w", err)
	}
	if len(rest) > 0 {
		return nil, errors.New("trailing bytes in TimeStampResp")
	}
	if resp.Status.Status != 0 && resp.Status.Status != 1 {
		return nil, fmt.Errorf("tsa rejected request with PKIStatus=%d (%s)", resp.Status.Status, strings.Join(resp.Status.StatusString, "; "))
	}
	if len(resp.TimeStampToken.FullBytes) == 0 {
		return nil, errors.New("tsa response missing TimeStampToken")
	}

	var ci contentInfo
	ciRest, err := asn1.Unmarshal(resp.TimeStampToken.FullBytes, &ci)
	if err != nil {
		return nil, fmt.Errorf("unmarshal TimeStampToken ContentInfo: %w", err)
	}
	if len(ciRest) > 0 {
		return nil, errors.New("trailing bytes in TimeStampToken ContentInfo")
	}
	if !ci.ContentType.Equal(oidSignedData) {
		return nil, fmt.Errorf("unexpected TimeStampToken ContentType OID: %v", ci.ContentType)
	}

	var sd signedData
	sdRest, err := asn1.Unmarshal(ci.Content.Bytes, &sd)
	if err != nil {
		return nil, fmt.Errorf("unmarshal SignedData: %w", err)
	}
	if len(sdRest) > 0 {
		return nil, errors.New("trailing bytes in SignedData")
	}
	if !sd.EncapContentInfo.EContentType.Equal(oidTSTInfo) {
		return nil, fmt.Errorf("unexpected EncapContentInfo OID: %v", sd.EncapContentInfo.EContentType)
	}
	if len(sd.EncapContentInfo.EContent) == 0 {
		return nil, errors.New("tsa response missing encapsulated TSTInfo")
	}

	var info tstInfo
	infoRest, err := asn1.Unmarshal(sd.EncapContentInfo.EContent, &info)
	if err != nil {
		return nil, fmt.Errorf("unmarshal TSTInfo: %w", err)
	}
	if len(infoRest) > 0 {
		return nil, errors.New("trailing bytes in TSTInfo")
	}
	if !info.MessageImprint.HashAlgorithm.Algorithm.Equal(oidSHA256) {
		return nil, fmt.Errorf("unsupported tsa messageImprint hash algorithm OID: %v", info.MessageImprint.HashAlgorithm.Algorithm)
	}
	if len(expectedDigest) > 0 && !bytes.Equal(info.MessageImprint.HashedMessage, expectedDigest) {
		return nil, fmt.Errorf("tsa messageImprint mismatch: got %s", hex.EncodeToString(info.MessageImprint.HashedMessage))
	}
	if expectedNonce != nil {
		if info.Nonce == nil || info.Nonce.Cmp(expectedNonce) != 0 {
			return nil, errors.New("tsa nonce mismatch")
		}
	}
	if info.GenTime.IsZero() {
		return nil, errors.New("tsa response missing TSTInfo genTime")
	}

	if len(sd.SignerInfos) == 0 {
		return nil, errors.New("tsa SignedData missing SignerInfos")
	}
	if len(sd.Certificates.Bytes) == 0 {
		return nil, errors.New("tsa SignedData missing embedded certificates")
	}
	certs, err := x509.ParseCertificates(sd.Certificates.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse tsa embedded certificates: %w", err)
	}
	if len(certs) == 0 {
		return nil, errors.New("tsa SignedData contains no certificates")
	}

	if roots == nil {
		roots, err = defaultTSARootCAs()
		if err != nil {
			return nil, err
		}
	}

	var lastVerifyErr error
	verified := false
	for i := range sd.SignerInfos {
		if vErr := verifyCMSSignerInfo(&sd.SignerInfos[i], sd.EncapContentInfo.EContent, certs, roots, info.GenTime); vErr != nil {
			lastVerifyErr = vErr
			continue
		}
		verified = true
		break
	}
	if !verified {
		return nil, lastVerifyErr
	}

	return &TSAResponse{
		TokenB64: base64.StdEncoding.EncodeToString(respBytes),
		GenTime:  info.GenTime.UTC().Format(time.RFC3339),
	}, nil
}

func verifyCMSSignerInfo(si *signerInfo, encapContent []byte, certs []*x509.Certificate, roots *x509.CertPool, genTime time.Time) error {
	signerCert, err := matchSignerCert(si.SID, certs)
	if err != nil {
		return err
	}

	hashAlg, encapDigest, err := hashEncapContent(si.DigestAlgorithm.Algorithm, encapContent)
	if err != nil {
		return err
	}

	if len(si.SignedAttrs.Bytes) == 0 {
		return errors.New("tsa SignerInfo missing SignedAttrs")
	}
	if err := verifyCMSSignedAttrs(si.SignedAttrs.Bytes, encapDigest); err != nil {
		return err
	}

	signedAttrsSET, err := asn1.Marshal(asn1.RawValue{
		Class:      asn1.ClassUniversal,
		Tag:        asn1.TagSet,
		IsCompound: true,
		Bytes:      si.SignedAttrs.Bytes,
	})
	if err != nil {
		return fmt.Errorf("re-marshal SignedAttrs as SET: %w", err)
	}

	sigAlg, err := resolveCMSSignatureAlgorithm(hashAlg, si.SignatureAlgorithm.Algorithm, signerCert.PublicKeyAlgorithm)
	if err != nil {
		return err
	}
	if err := signerCert.CheckSignature(sigAlg, signedAttrsSET, si.Signature); err != nil {
		return fmt.Errorf("verify tsa CMS signature: %w", err)
	}

	intermediates := x509.NewCertPool()
	for _, c := range certs {
		if c != signerCert {
			intermediates.AddCert(c)
		}
	}
	if _, err := signerCert.Verify(x509.VerifyOptions{
		Roots:         roots,
		Intermediates: intermediates,
		CurrentTime:   genTime,
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageTimeStamping},
	}); err != nil {
		return fmt.Errorf("verify tsa certificate chain: %w", err)
	}
	return nil
}

func matchSignerCert(sid asn1.RawValue, certs []*x509.Certificate) (*x509.Certificate, error) {
	switch {
	case sid.Class == asn1.ClassUniversal && sid.Tag == asn1.TagSequence:
		var iasn issuerAndSerialNumber
		rest, err := asn1.Unmarshal(sid.FullBytes, &iasn)
		if err != nil || len(rest) > 0 || iasn.SerialNumber == nil {
			return nil, errors.New("invalid SignerIdentifier IssuerAndSerialNumber")
		}
		for _, c := range certs {
			if bytes.Equal(c.RawIssuer, iasn.Issuer.FullBytes) && c.SerialNumber.Cmp(iasn.SerialNumber) == 0 {
				return c, nil
			}
		}
		return nil, errors.New("tsa signer certificate matching IssuerAndSerialNumber not found")
	case sid.Class == asn1.ClassContextSpecific && sid.Tag == 0:
		if len(sid.Bytes) == 0 {
			return nil, errors.New("empty SignerIdentifier SubjectKeyIdentifier")
		}
		for _, c := range certs {
			if len(c.SubjectKeyId) > 0 && bytes.Equal(c.SubjectKeyId, sid.Bytes) {
				return c, nil
			}
		}
		return nil, errors.New("tsa signer certificate matching SubjectKeyIdentifier not found")
	default:
		return nil, errors.New("unsupported SignerIdentifier CHOICE")
	}
}

func hashEncapContent(digestOID asn1.ObjectIdentifier, content []byte) (crypto.Hash, []byte, error) {
	switch {
	case digestOID.Equal(oidSHA256):
		sum := sha256.Sum256(content)
		return crypto.SHA256, sum[:], nil
	case digestOID.Equal(oidSHA384):
		sum := sha512.Sum384(content)
		return crypto.SHA384, sum[:], nil
	case digestOID.Equal(oidSHA512):
		sum := sha512.Sum512(content)
		return crypto.SHA512, sum[:], nil
	default:
		return 0, nil, fmt.Errorf("unsupported tsa CMS digest algorithm OID: %v", digestOID)
	}
}

func verifyCMSSignedAttrs(rawAttrs []byte, expectedDigest []byte) error {
	rest := rawAttrs
	foundContentType := false
	foundMessageDigest := false

	for len(rest) > 0 {
		var attr cmsAttribute
		var err error
		rest, err = asn1.Unmarshal(rest, &attr)
		if err != nil {
			return fmt.Errorf("unmarshal CMS SignedAttr: %w", err)
		}
		if attr.Values.Class != asn1.ClassUniversal || attr.Values.Tag != asn1.TagSet || len(attr.Values.Bytes) == 0 {
			return fmt.Errorf("invalid SignedAttr value set for OID %v", attr.Type)
		}
		switch {
		case attr.Type.Equal(oidContentType):
			if foundContentType {
				return errors.New("duplicate contentType SignedAttr")
			}
			var ct asn1.ObjectIdentifier
			valRest, err := asn1.Unmarshal(attr.Values.Bytes, &ct)
			if err != nil || len(valRest) > 0 {
				return errors.New("invalid contentType SignedAttr value")
			}
			if !ct.Equal(oidTSTInfo) {
				return fmt.Errorf("SignedAttr contentType mismatch: got %v", ct)
			}
			foundContentType = true

		case attr.Type.Equal(oidMessageDigest):
			if foundMessageDigest {
				return errors.New("duplicate messageDigest SignedAttr")
			}
			var md []byte
			valRest, err := asn1.Unmarshal(attr.Values.Bytes, &md)
			if err != nil || len(valRest) > 0 {
				return errors.New("invalid messageDigest SignedAttr value")
			}
			if !bytes.Equal(md, expectedDigest) {
				return errors.New("SignedAttr messageDigest mismatch")
			}
			foundMessageDigest = true
		}
	}

	if !foundContentType {
		return errors.New("tsa SignedAttrs missing contentType")
	}
	if !foundMessageDigest {
		return errors.New("tsa SignedAttrs missing messageDigest")
	}
	return nil
}

func resolveCMSSignatureAlgorithm(hashAlg crypto.Hash, sigOID asn1.ObjectIdentifier, pubAlg x509.PublicKeyAlgorithm) (x509.SignatureAlgorithm, error) {
	switch {
	case sigOID.Equal(oidSHA256WithRSA):
		if hashAlg != crypto.SHA256 {
			return x509.UnknownSignatureAlgorithm, errors.New("digest/signature algorithm mismatch (expected SHA256)")
		}
		return x509.SHA256WithRSA, nil
	case sigOID.Equal(oidSHA384WithRSA):
		if hashAlg != crypto.SHA384 {
			return x509.UnknownSignatureAlgorithm, errors.New("digest/signature algorithm mismatch (expected SHA384)")
		}
		return x509.SHA384WithRSA, nil
	case sigOID.Equal(oidSHA512WithRSA):
		if hashAlg != crypto.SHA512 {
			return x509.UnknownSignatureAlgorithm, errors.New("digest/signature algorithm mismatch (expected SHA512)")
		}
		return x509.SHA512WithRSA, nil
	case sigOID.Equal(oidRSAEncryption):
		switch hashAlg {
		case crypto.SHA256:
			return x509.SHA256WithRSA, nil
		case crypto.SHA384:
			return x509.SHA384WithRSA, nil
		case crypto.SHA512:
			return x509.SHA512WithRSA, nil
		}
	case sigOID.Equal(oidRSASSAPSS):
		switch hashAlg {
		case crypto.SHA256:
			return x509.SHA256WithRSAPSS, nil
		case crypto.SHA384:
			return x509.SHA384WithRSAPSS, nil
		case crypto.SHA512:
			return x509.SHA512WithRSAPSS, nil
		}
	case sigOID.Equal(oidECDSAWithSHA256):
		if hashAlg != crypto.SHA256 {
			return x509.UnknownSignatureAlgorithm, errors.New("digest/signature algorithm mismatch (expected SHA256)")
		}
		return x509.ECDSAWithSHA256, nil
	case sigOID.Equal(oidECDSAWithSHA384):
		if hashAlg != crypto.SHA384 {
			return x509.UnknownSignatureAlgorithm, errors.New("digest/signature algorithm mismatch (expected SHA384)")
		}
		return x509.ECDSAWithSHA384, nil
	case sigOID.Equal(oidECDSAWithSHA512):
		if hashAlg != crypto.SHA512 {
			return x509.UnknownSignatureAlgorithm, errors.New("digest/signature algorithm mismatch (expected SHA512)")
		}
		return x509.ECDSAWithSHA512, nil
	case sigOID.Equal(oidEd25519):
		if pubAlg != x509.Ed25519 {
			return x509.UnknownSignatureAlgorithm, errors.New("Ed25519 signature algorithm requires Ed25519 certificate")
		}
		return x509.PureEd25519, nil
	}
	return x509.UnknownSignatureAlgorithm, fmt.Errorf("unsupported tsa CMS signature algorithm OID: %v", sigOID)
}

