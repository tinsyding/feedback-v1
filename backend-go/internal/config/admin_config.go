package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"feedback-api/internal/tz"
)

// AdminFallbackCreds holds emergency fallback admin credentials when DB admin_users is empty or unavailable.
type AdminFallbackCreds struct {
	Username       string
	PasswordHash   string
	PasswordHashes []string
}

// MaskAPIKey masks an API key keeping the first 4 and last 4 characters.
// Mirrors PHP sender_auth_helper.php maskApiKey().
func MaskAPIKey(key string) string {
	k := strings.TrimSpace(key)
	if k == "" {
		return ""
	}
	if len(k) <= 8 {
		return "****"
	}
	return k[:4] + "****" + k[len(k)-4:]
}

// IsMaskedAPIKey reports whether val contains the mask placeholder "****".
// Mirrors PHP sender_auth_helper.php isMaskedApiKey().
func IsMaskedAPIKey(val string) bool {
	return strings.Contains(strings.TrimSpace(val), "****")
}

// ConfigJSONPath returns the path to <FeedbackRoot>/config.json.
func (l *Loader) ConfigJSONPath() string {
	return filepath.Join(l.FeedbackRoot, "config.json")
}

// AISecretsPath returns the path to <FeedbackRoot>/data/.ai_secrets.json.
func (l *Loader) AISecretsPath() string {
	return filepath.Join(l.FeedbackRoot, "data", ".ai_secrets.json")
}

// SaveAISecrets atomically writes <FeedbackRoot>/data/.ai_secrets.json with 0600 permissions.
// Mirrors PHP sender_auth_helper.php saveAiSecrets().
func (l *Loader) SaveAISecrets(secrets map[string]any) error {
	if l == nil || strings.TrimSpace(l.FeedbackRoot) == "" {
		return fmt.Errorf("feedback root is empty")
	}
	out := make(map[string]any, len(secrets)+1)
	for k, v := range secrets {
		out[k] = v
	}
	out["updatedAt"] = tz.Now().Format("2006-01-02 15:04:05")
	return atomicWriteJSON(l.AISecretsPath(), out, 0o600)
}

// SaveConfigJSON atomically writes <FeedbackRoot>/config.json.
func (l *Loader) SaveConfigJSON(cfg map[string]any) error {
	if l == nil || strings.TrimSpace(l.FeedbackRoot) == "" {
		return fmt.Errorf("feedback root is empty")
	}
	return atomicWriteJSON(l.ConfigJSONPath(), cfg, 0o644)
}

func atomicWriteJSON(path string, payload any, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(payload, "", "    ")
	if err != nil {
		return err
	}
	var suffix [4]byte
	_, _ = rand.Read(suffix[:])
	tmp := fmt.Sprintf("%s.tmp.%d.%s", path, os.Getpid(), hex.EncodeToString(suffix[:]))
	if err := os.WriteFile(tmp, raw, perm); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	_ = os.Chmod(tmp, perm)
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	_ = os.Chmod(path, perm)
	return nil
}

// LoadAdminFallback reads fallback admin credentials from env and optional api/admin/helpers.local.php.
// Mirrors PHP feedback-v1/api/admin/helpers.php.
func (l *Loader) LoadAdminFallback() AdminFallbackCreds {
	out := AdminFallbackCreds{
		Username: "admin",
	}

	// Read optional <FeedbackRoot>/api/admin/helpers.local.php
	if l != nil && strings.TrimSpace(l.FeedbackRoot) != "" {
		localPath := filepath.Join(l.FeedbackRoot, "api", "admin", "helpers.local.php")
		if raw, err := os.ReadFile(localPath); err == nil {
			pairs := extractPHPStringPairs(string(raw))
			if v := strings.TrimSpace(pairs["admin_username"]); v != "" {
				out.Username = v
			} else if v := strings.TrimSpace(pairs["username"]); v != "" {
				out.Username = v
			}
			if v := strings.TrimSpace(pairs["admin_password_hash"]); v != "" {
				out.PasswordHash = v
			} else if v := strings.TrimSpace(pairs["password_hash"]); v != "" {
				out.PasswordHash = v
			}
			if list := extractPHPStringArrayField(string(raw), "admin_password_hashes"); len(list) > 0 {
				out.PasswordHashes = appendUniqueTokens(out.PasswordHashes, list...)
			}
			if list := extractPHPStringArrayField(string(raw), "password_hashes"); len(list) > 0 {
				out.PasswordHashes = appendUniqueTokens(out.PasswordHashes, list...)
			}
		}
	}

	if envUser := strings.TrimSpace(os.Getenv("ADMIN_FALLBACK_USER")); envUser != "" {
		out.Username = envUser
	}
	if envHash := strings.TrimSpace(os.Getenv("ADMIN_FALLBACK_HASH")); envHash != "" {
		out.PasswordHash = envHash
	}
	if out.PasswordHash != "" {
		out.PasswordHashes = appendUniqueTokens(out.PasswordHashes, out.PasswordHash)
	}
	return out
}

func matchPHPArrayOpen(tokens []phpToken, idx int) (closeVal string, bodyStart int, ok bool) {
	if idx >= len(tokens) {
		return "", 0, false
	}
	if tokens[idx].kind == "other" && tokens[idx].val == "[" {
		return "]", idx + 1, true
	}
	const kw = "array"
	if idx+len(kw) < len(tokens) {
		for k := 0; k < len(kw); k++ {
			if tokens[idx+k].kind != "other" || !strings.EqualFold(tokens[idx+k].val, kw[k:k+1]) {
				return "", 0, false
			}
		}
		if tokens[idx+len(kw)].kind == "other" && tokens[idx+len(kw)].val == "(" {
			return ")", idx + len(kw) + 1, true
		}
	}
	return "", 0, false
}

func extractPHPStringArrayField(src, key string) []string {
	tokens := scanPHPTokens(src)
	var out []string
	for i := 0; i+2 < len(tokens); i++ {
		if tokens[i].kind != "str" || tokens[i].val != key {
			continue
		}
		if tokens[i+1].kind != "arrow" {
			continue
		}
		if closeVal, start, ok := matchPHPArrayOpen(tokens, i+2); ok {
			for j := start; j < len(tokens); j++ {
				if tokens[j].kind == "other" && tokens[j].val == closeVal {
					break
				}
				if tokens[j].kind == "str" && strings.TrimSpace(tokens[j].val) != "" {
					out = append(out, strings.TrimSpace(tokens[j].val))
				}
			}
		}
	}
	return out
}
