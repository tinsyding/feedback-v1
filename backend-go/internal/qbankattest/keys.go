package qbankattest

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

const (
	// KeyAlgEd25519 is the canonical database algorithm identifier stored in qbank_attestation_keys.
	KeyAlgEd25519 = "Ed25519"
	// JWKAlgEdDSA is the RFC 8037 JWK algorithm value for Ed25519.
	JWKAlgEdDSA = "EdDSA"

	// KeyStatusActive indicates the key is currently active for signing and verification.
	KeyStatusActive = "active"
	// KeyStatusRetired indicates the key is no longer used for new signatures but remains valid for verification.
	KeyStatusRetired = "retired"
	// KeyStatusRevoked indicates the key has been compromised/revoked and must fail verification.
	KeyStatusRevoked = "revoked"

	retestSecretKDFPrefix = "jifang-qbank-attestation-ed25519-v1\x00"
	maxKeyIDLength        = 64
)

// JWKKey represents an RFC 8037 OKP Ed25519 public key suitable for WebCrypto crypto.subtle.importKey("jwk", ...).
type JWKKey struct {
	Kty       string `json:"kty"`
	Crv       string `json:"crv"`
	Alg       string `json:"alg"`
	Use       string `json:"use"`
	Kid       string `json:"kid"`
	X         string `json:"x"`
	Status    string `json:"status,omitempty"`
	CreatedAt string `json:"created_at,omitempty"`
}

// JWKS represents a JSON Web Key Set document served at /.well-known/jwks.json.
type JWKS struct {
	Keys []JWKKey `json:"keys"`
}

// Signer signs canonical attestation payloads with an Ed25519 private key.
type Signer struct {
	kid       string
	priv      ed25519.PrivateKey
	pub       ed25519.PublicKey
	pubB64    string
	ephemeral bool
	createdAt time.Time
}

// LoadSigner resolves an Ed25519 Signer according to precedence:
//  1. QBANK_ATTESTATION_PRIVATE_KEY env or QBANK_ATTESTATION_KEY_FILE env
//  2. Deterministic KDF from retestSecret if non-empty
//  3. Ephemeral random Ed25519 key (marked Ephemeral=true for tests/local dev)
func LoadSigner(retestSecret string) (*Signer, error) {
	kidOverride := strings.TrimSpace(os.Getenv("QBANK_ATTESTATION_KEY_ID"))

	if rawKey := strings.TrimSpace(os.Getenv("QBANK_ATTESTATION_PRIVATE_KEY")); rawKey != "" {
		priv, err := ParseEd25519PrivateKey(rawKey)
		if err != nil {
			return nil, fmt.Errorf("invalid QBANK_ATTESTATION_PRIVATE_KEY: %w", err)
		}
		return newSigner(priv, kidOverride, false)
	}

	if keyFile := strings.TrimSpace(os.Getenv("QBANK_ATTESTATION_KEY_FILE")); keyFile != "" {
		rawBytes, err := os.ReadFile(keyFile)
		if err != nil {
			return nil, fmt.Errorf("read QBANK_ATTESTATION_KEY_FILE %q: %w", keyFile, err)
		}
		priv, err := ParseEd25519PrivateKey(string(rawBytes))
		if err != nil {
			return nil, fmt.Errorf("invalid QBANK_ATTESTATION_KEY_FILE %q: %w", keyFile, err)
		}
		return newSigner(priv, kidOverride, false)
	}

	if retestSecret != "" {
		sum := sha256.Sum256([]byte(retestSecretKDFPrefix + retestSecret))
		priv := ed25519.NewKeyFromSeed(sum[:])
		return newSigner(priv, kidOverride, false)
	}

	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate ephemeral ed25519 key: %w", err)
	}
	return newSigner(priv, kidOverride, true)
}

// NewSignerFromSeed builds a non-ephemeral Signer from a 32-byte Ed25519 seed.
func NewSignerFromSeed(seed []byte, kid string) (*Signer, error) {
	if len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("ed25519 seed must be %d bytes, got %d", ed25519.SeedSize, len(seed))
	}
	priv := ed25519.NewKeyFromSeed(seed)
	return newSigner(priv, kid, false)
}

// NewSignerFromPrivateKey builds a non-ephemeral Signer from a 64-byte Ed25519 private key.
func NewSignerFromPrivateKey(priv ed25519.PrivateKey, kid string) (*Signer, error) {
	if len(priv) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("ed25519 private key must be %d bytes, got %d", ed25519.PrivateKeySize, len(priv))
	}
	if err := validateEd25519KeyPair(priv); err != nil {
		return nil, err
	}
	cp := make(ed25519.PrivateKey, ed25519.PrivateKeySize)
	copy(cp, priv)
	return newSigner(cp, kid, false)
}

// NewEphemeralSigner creates a fresh random ephemeral Signer (primarily for unit tests).
func NewEphemeralSigner(kid string) (*Signer, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate ephemeral ed25519 key: %w", err)
	}
	return newSigner(priv, kid, true)
}

func newSigner(priv ed25519.PrivateKey, kidOverride string, ephemeral bool) (*Signer, error) {
	if len(priv) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("invalid ed25519 private key length %d", len(priv))
	}
	pub := make(ed25519.PublicKey, ed25519.PublicKeySize)
	copy(pub, priv[ed25519.SeedSize:])

	kid := strings.TrimSpace(kidOverride)
	if kid == "" {
		kid = DefaultKid(pub)
	}
	if len(kid) > maxKeyIDLength {
		return nil, fmt.Errorf("attestation key id length %d exceeds max %d", len(kid), maxKeyIDLength)
	}

	return &Signer{
		kid:       kid,
		priv:      priv,
		pub:       pub,
		pubB64:    base64.RawURLEncoding.EncodeToString(pub),
		ephemeral: ephemeral,
		createdAt: time.Now().UTC(),
	}, nil
}

// DefaultKid computes the deterministic key ID `"jf-qb-" + hex(sha256(pub)[:4])`.
func DefaultKid(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return "jf-qb-" + hex.EncodeToString(sum[:4])
}

// ParseEd25519PrivateKey parses a private key from PEM PKCS#8, 64-hex seed, 128-hex privkey,
// Base64URL (raw or padded), or standard Base64 (raw or padded).
func ParseEd25519PrivateKey(raw string) (ed25519.PrivateKey, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil, errors.New("empty private key")
	}

	if strings.Contains(s, "-----BEGIN") {
		if !strings.Contains(s, "\n") && strings.Contains(s, `\n`) {
			s = strings.ReplaceAll(s, `\n`, "\n")
		}
		block, _ := pem.Decode([]byte(s))
		if block == nil {
			return nil, errors.New("failed to decode PEM block")
		}
		parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("parse PKCS8 private key: %w", err)
		}
		edPriv, ok := parsed.(ed25519.PrivateKey)
		if !ok {
			return nil, fmt.Errorf("expected Ed25519 PKCS8 key, got %T", parsed)
		}
		return edPriv, nil
	}

	compact := strings.Join(strings.Fields(s), "")

	// Hex-encoded 32-byte seed (64 hex chars) or 64-byte private key (128 hex chars).
	if len(compact) == 64 || len(compact) == 128 {
		if decoded, err := hex.DecodeString(compact); err == nil {
			return privateKeyFromRawBytes(decoded)
		}
	}

	// Base64URL / standard Base64 (raw and padded).
	encodings := []*base64.Encoding{
		base64.RawURLEncoding,
		base64.URLEncoding,
		base64.RawStdEncoding,
		base64.StdEncoding,
	}
	for _, enc := range encodings {
		decoded, err := enc.DecodeString(compact)
		if err != nil {
			continue
		}
		if len(decoded) == ed25519.SeedSize || len(decoded) == ed25519.PrivateKeySize {
			return privateKeyFromRawBytes(decoded)
		}
	}

	return nil, errors.New("unsupported Ed25519 private key format (expected PKCS8 PEM, 64/128 hex, or base64/base64url)")
}

func privateKeyFromRawBytes(b []byte) (ed25519.PrivateKey, error) {
	switch len(b) {
	case ed25519.SeedSize:
		return ed25519.NewKeyFromSeed(b), nil
	case ed25519.PrivateKeySize:
		priv := make(ed25519.PrivateKey, ed25519.PrivateKeySize)
		copy(priv, b)
		if err := validateEd25519KeyPair(priv); err != nil {
			return nil, err
		}
		return priv, nil
	default:
		return nil, fmt.Errorf("unexpected decoded key length %d", len(b))
	}
}

func validateEd25519KeyPair(priv ed25519.PrivateKey) error {
	derived := ed25519.NewKeyFromSeed(priv[:ed25519.SeedSize])
	if subtle.ConstantTimeCompare(derived[ed25519.SeedSize:], priv[ed25519.SeedSize:]) != 1 {
		return errors.New("ed25519 private key public suffix does not match seed")
	}
	return nil
}

// Kid returns the active key identifier.
func (s *Signer) Kid() string {
	if s == nil {
		return ""
	}
	return s.kid
}

// Alg returns the key algorithm name ("Ed25519").
func (s *Signer) Alg() string {
	return KeyAlgEd25519
}

// IsEphemeral reports whether the signer fell back to an ephemeral in-memory random key.
func (s *Signer) IsEphemeral() bool {
	if s == nil {
		return true
	}
	return s.ephemeral
}

// PublicKey returns a copy of the 32-byte Ed25519 public key.
func (s *Signer) PublicKey() ed25519.PublicKey {
	if s == nil {
		return nil
	}
	cp := make(ed25519.PublicKey, len(s.pub))
	copy(cp, s.pub)
	return cp
}

// PublicKeyBase64URL returns the Base64URL (RawURLEncoding, no padding) 32-byte public key.
func (s *Signer) PublicKeyBase64URL() string {
	if s == nil {
		return ""
	}
	return s.pubB64
}

// CreatedAt returns the signer initialization UTC timestamp.
func (s *Signer) CreatedAt() time.Time {
	if s == nil {
		return time.Time{}
	}
	return s.createdAt
}

// Sign signs msg with Ed25519 and returns Base64URL (RawURLEncoding, no padding) 64-byte signature.
func (s *Signer) Sign(msg []byte) string {
	if s == nil || len(s.priv) != ed25519.PrivateKeySize {
		return ""
	}
	sig := ed25519.Sign(s.priv, msg)
	return base64.RawURLEncoding.EncodeToString(sig)
}

// Verify checks sigBase64URL against msg using the Signer's public key.
func (s *Signer) Verify(msg []byte, sigBase64URL string) bool {
	if s == nil {
		return false
	}
	return Verify(s.pubB64, msg, sigBase64URL)
}

// JWK exports the Signer's public key as an RFC 8037 OKP Ed25519 JWK.
func (s *Signer) JWK() JWKKey {
	if s == nil {
		return JWKKey{}
	}
	return BuildJWK(s.kid, s.pubB64, KeyStatusActive, s.createdAt)
}

// BuildJWK constructs an RFC 8037 OKP Ed25519 JWK from persisted key metadata.
func BuildJWK(kid, pubBase64URL, status string, createdAt time.Time) JWKKey {
	if status == "" {
		status = KeyStatusActive
	}
	createdStr := ""
	if !createdAt.IsZero() {
		createdStr = createdAt.UTC().Format(time.RFC3339)
	}
	return JWKKey{
		Kty:       "OKP",
		Crv:       KeyAlgEd25519,
		Alg:       JWKAlgEdDSA,
		Use:       "sig",
		Kid:       kid,
		X:         pubBase64URL,
		Status:    status,
		CreatedAt: createdStr,
	}
}

// Verify verifies an unpadded Base64URL Ed25519 signature over msg using an unpadded Base64URL 32-byte public key.
func Verify(pubBase64URL string, msg []byte, sigBase64URL string) bool {
	pubRaw, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(pubBase64URL))
	if err != nil || len(pubRaw) != ed25519.PublicKeySize {
		return false
	}
	sigRaw, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(sigBase64URL))
	if err != nil || len(sigRaw) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(ed25519.PublicKey(pubRaw), msg, sigRaw)
}
