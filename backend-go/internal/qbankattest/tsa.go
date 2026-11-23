package qbankattest

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
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
)

const (
	// DefaultTSAURL is the default RFC 3161 Time-Stamp Authority endpoint.
	DefaultTSAURL = "https://freetsa.org/tsr"

	// TSA status constants stored in qbank_attestation_anchors.tsa_status.
	TSAStatusAnchored  = "anchored"
	TSAStatusLocalOnly = "local_only"
)

var (
	oidSHA256 = asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 2, 1}
	oidTSTInfo = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 9, 16, 1, 4}
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
		URL: raw,
		HTTPClient: &http.Client{
			Timeout: 12 * time.Second,
		},
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
		httpClient = &http.Client{Timeout: 12 * time.Second}
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
	return ParseTimeStampResp(body, digest, nonce)
}

// ASN.1 structures for RFC 3161 TimeStampReq / TimeStampResp.
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
	DigestAlgorithms asn1.RawValue
	EncapContentInfo encapsulatedContentInfo
}

type encapsulatedContentInfo struct {
	EContentType asn1.ObjectIdentifier
	EContent     []byte `asn1:"explicit,optional,tag:0"`
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
	GenTime        time.Time    `asn1:"generalized"`
	Accuracy       tstAccuracy  `asn1:"optional"`
	Ordering       bool         `asn1:"optional"`
	Nonce          *big.Int     `asn1:"optional"`
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

// ParseTimeStampResp validates an RFC 3161 TimeStampResp DER payload, checking
// PKIStatus (0=granted, 1=grantedWithMods), messageImprint digest match, and
// nonce match (when expectedNonce != nil). It returns the base64-encoded full
// TimeStampResp DER and the TSTInfo genTime formatted in RFC3339 UTC.
func ParseTimeStampResp(respBytes []byte, expectedDigest []byte, expectedNonce *big.Int) (*TSAResponse, error) {
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
	if _, err := asn1.Unmarshal(resp.TimeStampToken.FullBytes, &ci); err != nil {
		return nil, fmt.Errorf("unmarshal TimeStampToken ContentInfo: %w", err)
	}
	var sd signedData
	if _, err := asn1.Unmarshal(ci.Content.Bytes, &sd); err != nil {
		return nil, fmt.Errorf("unmarshal SignedData: %w", err)
	}
	if !sd.EncapContentInfo.EContentType.Equal(oidTSTInfo) {
		return nil, fmt.Errorf("unexpected EncapContentInfo OID: %v", sd.EncapContentInfo.EContentType)
	}
	var info tstInfo
	if _, err := asn1.Unmarshal(sd.EncapContentInfo.EContent, &info); err != nil {
		return nil, fmt.Errorf("unmarshal TSTInfo: %w", err)
	}
	if len(expectedDigest) > 0 && !bytes.Equal(info.MessageImprint.HashedMessage, expectedDigest) {
		return nil, fmt.Errorf("tsa messageImprint mismatch: got %s", hex.EncodeToString(info.MessageImprint.HashedMessage))
	}
	if expectedNonce != nil {
		if info.Nonce == nil || info.Nonce.Cmp(expectedNonce) != 0 {
			return nil, errors.New("tsa nonce mismatch")
		}
	}

	genTime := ""
	if !info.GenTime.IsZero() {
		genTime = info.GenTime.UTC().Format(time.RFC3339)
	}
	return &TSAResponse{
		TokenB64: base64.StdEncoding.EncodeToString(respBytes),
		GenTime:  genTime,
	}, nil
}
