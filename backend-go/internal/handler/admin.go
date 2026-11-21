package handler

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"html"
	"io"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	"feedback-api/internal/admin"
	"feedback-api/internal/auditlog"
	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
	"feedback-api/internal/ratelimit"
	"feedback-api/internal/session"
)

// AdminDeps bundles all dependencies for /api/admin.php.
type AdminDeps struct {
	Repo         admin.Repository
	Sessions     session.Store
	RateLimit    ratelimit.Store
	ConfigLoader *config.Loader
	Audit        auditlog.Logger
	FeedbackRoot string
	HTTPClient   *http.Client
	NowFunc      func() time.Time
}

func (d AdminDeps) now() time.Time {
	if d.NowFunc != nil {
		return d.NowFunc()
	}
	return time.Now()
}

func (d AdminDeps) httpClient() *http.Client {
	if d.HTTPClient != nil {
		return d.HTTPClient
	}
	return &http.Client{Timeout: 15 * time.Second}
}

// Admin handles all 21 actions of /api/admin.php.
func Admin(deps AdminDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// CSRF mitigation: all write operations require strict same-host Origin/Referer
		if !httpx.RequireStrictSameOrigin(w, r) {
			return
		}

		action := r.URL.Query().Get("action")
		switch action {
		// 1. Auth
		case "login":
			handleAdminLogin(w, r, deps)
		case "logout":
			handleAdminLogout(w, r, deps)
		case "check":
			handleAdminCheck(w, r, deps)
		case "change_password":
			handleAdminChangePassword(w, r, deps)

		// 2. Config & AI probe
		case "config":
			handleAdminConfig(w, r, deps)
		case "test_ai_config":
			handleAdminTestAIConfig(w, r, deps)

		// 3. Tables & Metadata
		case "db_tables":
			handleAdminDBTables(w, r, deps)
		case "db_schema":
			handleAdminDBSchema(w, r, deps)
		case "db_batches_options":
			handleAdminDBBatchesOptions(w, r, deps)
		case "dimensions", "db_filter_options":
			handleAdminDimensions(w, r, deps)
		case "student_records_stats":
			handleAdminStudentRecordsStats(w, r, deps)

		// 4. Generic CRUD & Source file
		case "db_list":
			handleAdminDBList(w, r, deps)
		case "db_get":
			handleAdminDBGet(w, r, deps)
		case "db_create":
			handleAdminDBCreate(w, r, deps)
		case "db_update":
			handleAdminDBUpdate(w, r, deps)
		case "db_delete":
			handleAdminDBDelete(w, r, deps)
		case "db_reset_teacher_password":
			handleAdminResetTeacherPassword(w, r, deps)
		case "download_source_file":
			handleAdminDownloadSourceFile(w, r, deps)

		// 5. Retest Token
		case "get_retest_admin_url":
			handleAdminGetRetestURL(w, r, deps)
		case "search_by_token":
			handleAdminSearchByToken(w, r, deps)

		// 6. Student Record History & Rollback
		case "record_history":
			handleAdminRecordHistory(w, r, deps)
		case "record_rollback":
			handleAdminRecordRollback(w, r, deps)

		default:
			httpx.SendResponse(w, false, nil, httpx.StrPtr("未知操作: "+html.EscapeString(action)), http.StatusBadRequest)
		}
	}
}

func decodeAdminJSONBody(r *http.Request) (map[string]any, error) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil, io.EOF
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func writeAdminRepoError(w http.ResponseWriter, err error) {
	if err == nil {
		return
	}
	var httpErr *admin.HTTPError
	if errors.As(err, &httpErr) {
		httpx.SendResponse(w, false, httpErr.Data, httpx.StrPtr(httpErr.Message), httpErr.Status)
		return
	}
	httpx.SendResponse(w, false, nil, httpx.StrPtr("服务器内部错误，请稍后重试"), http.StatusInternalServerError)
}

func verifyAdminPassword(plain, storedHash string) (ok bool, needsUpgrade bool) {
	if storedHash == "" {
		return false, false
	}
	if strings.HasPrefix(storedHash, "$2y$") || strings.HasPrefix(storedHash, "$2a$") || strings.HasPrefix(storedHash, "$2b$") {
		if bcrypt.CompareHashAndPassword([]byte(storedHash), []byte(plain)) == nil {
			return true, false
		}
		return false, false
	}
	sum := sha256.Sum256([]byte(plain))
	hexSum := hex.EncodeToString(sum[:])
	if subtle.ConstantTimeCompare([]byte(storedHash), []byte(hexSum)) == 1 {
		return true, true
	}
	return false, false
}

func adminAuditLog(r *http.Request, deps AdminDeps, sess *session.Session, level, action string, details map[string]any) {
	actor := "admin"
	if sess != nil {
		if u := sess.AdminUsername(); u != "" {
			actor = u
		}
	}
	auditlog.RecordFromRequest(r.Context(), deps.Audit, r, level, "admin", action, actor, details)
}
