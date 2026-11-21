package handler

import (
	"crypto/md5"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"feedback-api/internal/auditlog"
	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
	"feedback-api/internal/retest"
	"feedback-api/internal/session"
)

// RetestDeps bundles all dependencies for /api/retest.php.
type RetestDeps struct {
	Repo         retest.Repository
	Sessions     session.Store
	ConfigLoader *config.Loader
	Audit        auditlog.Logger
	FeedbackRoot string
	NowFunc      func() time.Time
}

func (d RetestDeps) now() time.Time {
	if d.NowFunc != nil {
		return d.NowFunc()
	}
	return time.Now()
}

func (d RetestDeps) tempDir() string {
	return filepath.Join(d.FeedbackRoot, "data", "temp")
}

func (d RetestDeps) resolveSecretKey() string {
	if d.ConfigLoader == nil {
		return ""
	}
	rt := d.ConfigLoader.Load()
	key := strings.TrimSpace(rt.Secrets.RetestSecret)
	if key == "" {
		key = strings.TrimSpace(rt.RawString("retestSecret"))
	}
	if key == "" || key == "default_fallback_secret_please_change" || key == "your-secret-key-template-placeholder" {
		return ""
	}
	return key
}

// Retest handles all 10 actions of /api/retest.php.
func Retest(deps RetestDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Ensure data/temp exists and probabilistically clean files older than 30 min (25% chance)
		if deps.FeedbackRoot != "" {
			tempDir := deps.tempDir()
			_ = os.MkdirAll(tempDir, 0o755)
			if n, err := rand.Int(rand.Reader, big.NewInt(4)); err == nil && n.Int64() == 0 {
				cleanupExpiredTempFiles(tempDir, deps.now(), 30*time.Minute)
			}
		}

		secretKey := deps.resolveSecretKey()
		if secretKey == "" {
			writeRawJSON(w, http.StatusInternalServerError, map[string]any{
				"success": false,
				"error":   "服务端密钥未配置，请联系管理员",
			})
			return
		}

		action := r.URL.Query().Get("action")
		switch action {
		case "captcha":
			handleRetestCaptcha(w, r, deps)
		case "check_existing_batch":
			handleRetestCheckExistingBatch(w, r, deps)
		case "get_student_week_record":
			handleRetestGetStudentWeekRecord(w, r, deps, secretKey)
		case "encrypt_batch":
			handleRetestEncryptBatch(w, r, deps, secretKey)
		case "decrypt":
			handleRetestDecrypt(w, r, deps, secretKey)
		case "create_temp_download":
			handleRetestCreateTempDownload(w, r, deps)
		case "download_file":
			handleRetestDownloadFile(w, r, deps)
		case "log_download":
			handleRetestLogDownload(w, r, deps)
		case "revoke_token", "unrevoke_token":
			handleRetestRevokeToggle(w, r, deps, action)
		default:
			writeRawJSON(w, http.StatusBadRequest, map[string]any{
				"success": false,
				"error":   "Invalid action",
			})
		}
	}
}

func cleanupExpiredTempFiles(tempDir string, now time.Time, maxAge time.Duration) {
	entries, err := os.ReadDir(tempDir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if now.Sub(info.ModTime()) > maxAge {
			_ = os.Remove(filepath.Join(tempDir, entry.Name()))
		}
	}
}

func writeRawJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(payload)
}

func writeRetestRepoError(w http.ResponseWriter, err error, fallbackMsg string) {
	var httpErr *retest.HTTPError
	if errors.As(err, &httpErr) {
		writeRawJSON(w, httpErr.Status, map[string]any{
			"success": false,
			"error":   httpErr.Message,
		})
		return
	}
	writeRawJSON(w, http.StatusInternalServerError, map[string]any{
		"success": false,
		"error":   fallbackMsg,
	})
}

func verifiedTokenSessionKey(token string) string {
	sum := md5.Sum([]byte(token))
	return "verified_token_" + hex.EncodeToString(sum[:])
}

func logRetestAccess(r *http.Request, deps RetestDeps, token, studentName, action, details string) {
	if deps.Repo == nil {
		return
	}
	deps.Repo.LogAccess(r.Context(), token, studentName, action, details, httpx.GetClientIP(r), r.UserAgent())
}
