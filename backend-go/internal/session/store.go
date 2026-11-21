package session

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
)

// DefaultSessionTTL matches PHP session.gc_maxlifetime minimum (1440s) for sliding expiration.
const DefaultSessionTTL = 1440 * time.Second

var reValidSessionID = regexp.MustCompile(`^[A-Za-z0-9,_-]{16,128}$`)

// Session holds the authenticated user/admin session payload loaded from app_sessions.
type Session struct {
	ID   string
	Data map[string]any
}

// IsUserLoggedIn mirrors PHP bootstrap.php isUserLoggedIn().
func (s *Session) IsUserLoggedIn() bool {
	if s == nil || s.Data == nil {
		return false
	}
	return config.AsPHPBool(s.Data["user_logged_in"])
}

// IsAdminLoggedIn mirrors PHP bootstrap.php isAdminLoggedIn().
func (s *Session) IsAdminLoggedIn() bool {
	if s == nil || s.Data == nil {
		return false
	}
	return config.AsPHPBool(s.Data["admin_logged_in"])
}

// IsLoggedIn mirrors PHP bootstrap.php isLoggedIn().
func (s *Session) IsLoggedIn() bool {
	return s.IsUserLoggedIn() || s.IsAdminLoggedIn()
}

// UserRole returns the foreground user's role (user_role fallback role).
func (s *Session) UserRole() string {
	if s == nil || s.Data == nil {
		return ""
	}
	if v, ok := s.Data["user_role"]; ok {
		return config.AsPHPString(v)
	}
	if v, ok := s.Data["role"]; ok {
		return config.AsPHPString(v)
	}
	return ""
}

// IsAssistantOnly mirrors PHP bootstrap.php requireNonAssistant() check.
func (s *Session) IsAssistantOnly() bool {
	return !s.IsAdminLoggedIn() && s.UserRole() == "assistant"
}

// Username returns the foreground username if set.
func (s *Session) Username() string {
	if s == nil || s.Data == nil {
		return ""
	}
	return config.AsPHPString(s.Data["username"])
}

// AdminUsername returns the admin username if set.
func (s *Session) AdminUsername() string {
	if s == nil || s.Data == nil {
		return ""
	}
	return config.AsPHPString(s.Data["admin_username"])
}

// StringVal returns a string value from session Data using PHP string coercion.
func (s *Session) StringVal(key string) string {
	if s == nil || s.Data == nil {
		return ""
	}
	return config.AsPHPString(s.Data[key])
}

// IntVal returns an int value from session Data using PHP int coercion.
func (s *Session) IntVal(key string) int {
	if s == nil || s.Data == nil {
		return 0
	}
	return config.AsPHPInt(s.Data[key])
}

// Store loads, saves, and destroys session state by PHPSESSID.
type Store interface {
	Load(ctx context.Context, sessionID string) (*Session, error)
	Save(ctx context.Context, sess *Session) error
	Destroy(ctx context.Context, sessionID string) error
}

// AtomicUpdater is an optional interface for Stores that support transactional read-modify-write updates.
type AtomicUpdater interface {
	Update(ctx context.Context, sessionID string, fn func(data map[string]any) (changed bool, err error)) (*Session, error)
}

// Update atomically reads, mutates via fn, and persists a session when supported by Store,
// falling back to Load + fn + Save for simpler Store implementations.
func Update(ctx context.Context, store Store, sessionID string, fn func(data map[string]any) (changed bool, err error)) (*Session, error) {
	if store == nil {
		return nil, errors.New("session store is not configured")
	}
	if fn == nil {
		return nil, errors.New("nil session update callback")
	}
	if updater, ok := store.(AtomicUpdater); ok {
		return updater.Update(ctx, sessionID, fn)
	}
	sid := strings.TrimSpace(sessionID)
	if !reValidSessionID.MatchString(sid) {
		return nil, errors.New("invalid session id")
	}
	sess, err := store.Load(ctx, sid)
	if err != nil {
		return nil, err
	}
	if sess == nil {
		sess = &Session{ID: sid, Data: make(map[string]any)}
	}
	if sess.Data == nil {
		sess.Data = make(map[string]any)
	}
	changed, err := fn(sess.Data)
	if err != nil {
		return nil, err
	}
	if changed {
		if err := store.Save(ctx, sess); err != nil {
			return nil, err
		}
	}
	return sess, nil
}

// MySQLStore reads and writes shared PHP/Go sessions in the `app_sessions` MySQL table.
type MySQLStore struct {
	db      *sql.DB
	ttl     time.Duration
	nowFunc func() time.Time
}

// NewMySQLStore creates a Store backed by *sql.DB. If db is nil, operations fail closed.
func NewMySQLStore(db *sql.DB) *MySQLStore {
	return &MySQLStore{
		db:      db,
		ttl:     DefaultSessionTTL,
		nowFunc: time.Now,
	}
}

func (s *MySQLStore) now() time.Time {
	if s != nil && s.nowFunc != nil {
		return s.nowFunc()
	}
	return time.Now()
}

func (s *MySQLStore) effectiveTTL() time.Duration {
	if s != nil && s.ttl > 0 {
		return s.ttl
	}
	return DefaultSessionTTL
}

// Load fetches an unexpired session by ID from `app_sessions` and slides its TTL when less than half remains.
func (s *MySQLStore) Load(ctx context.Context, sessionID string) (*Session, error) {
	sessionID = strings.TrimSpace(sessionID)
	if !reValidSessionID.MatchString(sessionID) {
		return nil, nil
	}
	if s == nil || s.db == nil {
		return nil, errors.New("session store database is not configured")
	}

	now := s.now().Unix()
	var rawJSON sql.NullString
	var expiresAt int64
	err := s.db.QueryRowContext(
		ctx,
		"SELECT `payload_json`, `expires_at` FROM `app_sessions` WHERE `session_id` = ? AND `expires_at` >= ? LIMIT 1",
		sessionID,
		now,
	).Scan(&rawJSON, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	data := make(map[string]any)
	if rawJSON.Valid && strings.TrimSpace(rawJSON.String) != "" {
		dec := json.NewDecoder(strings.NewReader(rawJSON.String))
		dec.UseNumber()
		if err := dec.Decode(&data); err != nil {
			// Empty/malformed payload falls back to empty map (unauthenticated).
			data = make(map[string]any)
		}
	}

	sess := &Session{
		ID:   sessionID,
		Data: data,
	}

	ttlSec := int64(s.effectiveTTL().Seconds())
	if ttlSec > 0 && sess.IsLoggedIn() && expiresAt-now < ttlSec/2 {
		newExpires := now + ttlSec
		updCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		_, _ = s.db.ExecContext(
			updCtx,
			"UPDATE `app_sessions` SET `expires_at` = ? WHERE `session_id` = ? AND `expires_at` < ?",
			newExpires,
			sessionID,
			newExpires,
		)
		cancel()
	}

	return sess, nil
}

// Save persists session data as JSON into `app_sessions` with empty `payload_php` so PHP MySqlSessionHandler
// automatically re-encodes `payload_json` into $_SESSION on cross-engine reads.
// Empty sessions are deleted to avoid app_sessions bloat.
func (s *MySQLStore) Save(ctx context.Context, sess *Session) error {
	if sess == nil {
		return nil
	}
	sid := strings.TrimSpace(sess.ID)
	if !reValidSessionID.MatchString(sid) {
		return errors.New("invalid session id")
	}
	if s == nil || s.db == nil {
		return errors.New("session store database is not configured")
	}
	if len(sess.Data) == 0 {
		return s.Destroy(ctx, sid)
	}
	rawJSON, err := json.Marshal(sess.Data)
	if err != nil {
		return err
	}
	expiresAt := s.now().Unix() + int64(s.effectiveTTL().Seconds())
	_, err = s.db.ExecContext(
		ctx,
		`INSERT INTO `+"`app_sessions`"+` (`+"`session_id`, `payload_php`, `payload_json`, `expires_at`"+`)
		 VALUES (?, '', ?, ?)
		 ON DUPLICATE KEY UPDATE
		   `+"`payload_php`"+` = '',
		   `+"`payload_json`"+` = VALUES(`+"`payload_json`"+`),
		   `+"`expires_at`"+` = VALUES(`+"`expires_at`"+`),
		   `+"`updated_at`"+` = CURRENT_TIMESTAMP`,
		sid,
		string(rawJSON),
		expiresAt,
	)
	return err
}

// Update executes a transactional read-modify-write against `app_sessions` using SELECT ... FOR UPDATE.
func (s *MySQLStore) Update(ctx context.Context, sessionID string, fn func(data map[string]any) (changed bool, err error)) (*Session, error) {
	sid := strings.TrimSpace(sessionID)
	if !reValidSessionID.MatchString(sid) {
		return nil, errors.New("invalid session id")
	}
	if s == nil || s.db == nil {
		return nil, errors.New("session store database is not configured")
	}
	if fn == nil {
		return nil, errors.New("nil session update callback")
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	now := s.now().Unix()
	var rawJSON sql.NullString
	var expiresAt int64
	err = tx.QueryRowContext(
		ctx,
		"SELECT `payload_json`, `expires_at` FROM `app_sessions` WHERE `session_id` = ? AND `expires_at` >= ? FOR UPDATE",
		sid,
		now,
	).Scan(&rawJSON, &expiresAt)

	data := make(map[string]any)
	if err == nil {
		if rawJSON.Valid && strings.TrimSpace(rawJSON.String) != "" {
			dec := json.NewDecoder(strings.NewReader(rawJSON.String))
			dec.UseNumber()
			if decErr := dec.Decode(&data); decErr != nil {
				data = make(map[string]any)
			}
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}

	changed, err := fn(data)
	if err != nil {
		return nil, err
	}
	if changed {
		if len(data) == 0 {
			if _, err := tx.ExecContext(ctx, "DELETE FROM `app_sessions` WHERE `session_id` = ?", sid); err != nil {
				return nil, err
			}
		} else {
			rawBytes, mErr := json.Marshal(data)
			if mErr != nil {
				return nil, mErr
			}
			newExpires := now + int64(s.effectiveTTL().Seconds())
			if _, err := tx.ExecContext(
				ctx,
				`INSERT INTO `+"`app_sessions`"+` (`+"`session_id`, `payload_php`, `payload_json`, `expires_at`"+`)
				 VALUES (?, '', ?, ?)
				 ON DUPLICATE KEY UPDATE
				   `+"`payload_php`"+` = '',
				   `+"`payload_json`"+` = VALUES(`+"`payload_json`"+`),
				   `+"`expires_at`"+` = VALUES(`+"`expires_at`"+`),
				   `+"`updated_at`"+` = CURRENT_TIMESTAMP`,
				sid,
				string(rawBytes),
				newExpires,
			); err != nil {
				return nil, err
			}
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &Session{ID: sid, Data: data}, nil
}

// Destroy deletes a session row from `app_sessions`.
func (s *MySQLStore) Destroy(ctx context.Context, sessionID string) error {
	sessionID = strings.TrimSpace(sessionID)
	if !reValidSessionID.MatchString(sessionID) {
		return nil
	}
	if s == nil || s.db == nil {
		return errors.New("session store database is not configured")
	}
	_, err := s.db.ExecContext(ctx, "DELETE FROM `app_sessions` WHERE `session_id` = ?", sessionID)
	return err
}

// CleanupExpired deletes expired rows from `app_sessions` and returns the deleted row count.
func (s *MySQLStore) CleanupExpired(ctx context.Context) (int64, error) {
	if s == nil || s.db == nil {
		return 0, nil
	}
	res, err := s.db.ExecContext(ctx, "DELETE FROM `app_sessions` WHERE `expires_at` < ?", s.now().Unix())
	if err != nil {
		return 0, err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return 0, nil
	}
	return affected, nil
}

// StartCleanupLoop runs an initial expired-session cleanup and repeats at interval until ctx is canceled.
func (s *MySQLStore) StartCleanupLoop(ctx context.Context, interval time.Duration) {
	if s == nil || s.db == nil {
		return
	}
	if interval <= 0 {
		interval = 10 * time.Minute
	}
	runOnce := func() {
		cleanCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if _, err := s.CleanupExpired(cleanCtx); err != nil && !errors.Is(err, context.Canceled) {
			log.Printf("warning: app_sessions cleanup failed: %v", err)
		}
	}
	go func() {
		runOnce()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				runOnce()
			}
		}
	}()
}

// MemoryStore is an in-memory Store for unit tests.
type MemoryStore struct {
	mu       sync.RWMutex
	sessions map[string]map[string]any
}

// NewMemoryStore initializes an empty MemoryStore.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		sessions: make(map[string]map[string]any),
	}
}

// Set stores a session payload by PHPSESSID for tests.
func (m *MemoryStore) Set(sessionID string, data map[string]any) {
	m.mu.Lock()
	defer m.mu.Unlock()
	copied := make(map[string]any, len(data))
	for k, v := range data {
		copied[k] = v
	}
	m.sessions[sessionID] = copied
}

// Load retrieves a session by ID from MemoryStore.
func (m *MemoryStore) Load(_ context.Context, sessionID string) (*Session, error) {
	sessionID = strings.TrimSpace(sessionID)
	if !reValidSessionID.MatchString(sessionID) {
		return nil, nil
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	data, ok := m.sessions[sessionID]
	if !ok {
		return nil, nil
	}
	copied := make(map[string]any, len(data))
	for k, v := range data {
		copied[k] = v
	}
	return &Session{ID: sessionID, Data: copied}, nil
}

// Save persists a session payload in MemoryStore (deletes if empty).
func (m *MemoryStore) Save(_ context.Context, sess *Session) error {
	if sess == nil {
		return nil
	}
	sid := strings.TrimSpace(sess.ID)
	if !reValidSessionID.MatchString(sid) {
		return errors.New("invalid session id")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(sess.Data) == 0 {
		delete(m.sessions, sid)
		return nil
	}
	copied := make(map[string]any, len(sess.Data))
	for k, v := range sess.Data {
		copied[k] = v
	}
	m.sessions[sid] = copied
	return nil
}

// Destroy deletes a session from MemoryStore.
func (m *MemoryStore) Destroy(_ context.Context, sessionID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.sessions, strings.TrimSpace(sessionID))
	return nil
}

func copySessionMap(src map[string]any) map[string]any {
	out := make(map[string]any, len(src))
	for k, v := range src {
		out[k] = v
	}
	return out
}

// Update executes an atomic read-modify-write on MemoryStore under m.mu.Lock().
func (m *MemoryStore) Update(_ context.Context, sessionID string, fn func(data map[string]any) (changed bool, err error)) (*Session, error) {
	sid := strings.TrimSpace(sessionID)
	if !reValidSessionID.MatchString(sid) {
		return nil, errors.New("invalid session id")
	}
	if fn == nil {
		return nil, errors.New("nil session update callback")
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	data := copySessionMap(m.sessions[sid])
	changed, err := fn(data)
	if err != nil {
		return nil, err
	}
	if changed {
		if len(data) == 0 {
			delete(m.sessions, sid)
		} else {
			m.sessions[sid] = copySessionMap(data)
		}
	}
	return &Session{ID: sid, Data: copySessionMap(data)}, nil
}

// NewSessionID generates a cryptographically random 32-char hex PHPSESSID.
func NewSessionID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// SetCookie writes the PHPSESSID cookie matching PHP bootstrap.php attributes (HttpOnly, SameSite=Lax, Secure on HTTPS).
func SetCookie(w http.ResponseWriter, r *http.Request, sessionID string) {
	isSecure := r.TLS != nil || strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https")
	http.SetCookie(w, &http.Cookie{
		Name:     "PHPSESSID",
		Value:    sessionID,
		Path:     "/",
		HttpOnly: true,
		Secure:   isSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

// LoadOrInit loads an existing session by PHPSESSID cookie or initializes a new in-memory Session with a fresh ID.
// The second return value (isNew) is true when no valid PHPSESSID cookie was present on the request.
func LoadOrInit(ctx context.Context, r *http.Request, store Store) (*Session, bool, error) {
	sid := extractSessionID(r)
	if sid != "" && reValidSessionID.MatchString(sid) {
		if store != nil {
			sess, err := store.Load(ctx, sid)
			if err != nil {
				return nil, false, err
			}
			if sess != nil {
				if sess.Data == nil {
					sess.Data = make(map[string]any)
				}
				return sess, false, nil
			}
		}
		return &Session{ID: sid, Data: make(map[string]any)}, false, nil
	}
	newID, err := NewSessionID()
	if err != nil {
		return nil, true, err
	}
	return &Session{ID: newID, Data: make(map[string]any)}, true, nil
}

// Regenerate rotates the session ID to defend against session fixation, deleting the old row and writing Set-Cookie.
func Regenerate(ctx context.Context, w http.ResponseWriter, r *http.Request, store Store, sess *Session) error {
	if sess == nil {
		return errors.New("nil session")
	}
	oldID := strings.TrimSpace(sess.ID)
	newID, err := NewSessionID()
	if err != nil {
		return err
	}
	if oldID != "" && store != nil {
		_ = store.Destroy(ctx, oldID)
	}
	sess.ID = newID
	if store != nil {
		if err := store.Save(ctx, sess); err != nil {
			return err
		}
	}
	SetCookie(w, r, newID)
	return nil
}

func extractSessionID(r *http.Request) string {
	cookie, err := r.Cookie("PHPSESSID")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(cookie.Value)
}

// RequireAuth mirrors PHP bootstrap.php requireAuth().
// On unauthenticated or failed session lookup, writes HTTP 401 and returns (nil, false).
func RequireAuth(w http.ResponseWriter, r *http.Request, store Store) (*Session, bool) {
	sid := extractSessionID(r)
	if sid == "" || store == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("未登录或登录会话已过期，请重新登录"), http.StatusUnauthorized)
		return nil, false
	}
	sess, err := store.Load(r.Context(), sid)
	if err != nil || sess == nil || !sess.IsLoggedIn() {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("未登录或登录会话已过期，请重新登录"), http.StatusUnauthorized)
		return nil, false
	}
	return sess, true
}

// RequireNonAssistant mirrors PHP bootstrap.php requireNonAssistant().
func RequireNonAssistant(w http.ResponseWriter, sess *Session, actionDesc string) bool {
	if sess != nil && sess.IsAssistantOnly() {
		msg := "助教账号无权" + actionDesc + "，仅主讲教师或管理员可操作"
		httpx.SendResponse(w, false, nil, httpx.StrPtr(msg), http.StatusForbidden)
		return false
	}
	return true
}

// RequireAdmin mirrors PHP bootstrap.php requireAdmin().
func RequireAdmin(w http.ResponseWriter, r *http.Request, store Store) (*Session, bool) {
	sid := extractSessionID(r)
	if sid == "" || store == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("未登录或会话已过期，需管理员权限"), http.StatusUnauthorized)
		return nil, false
	}
	sess, err := store.Load(r.Context(), sid)
	if err != nil || sess == nil || !sess.IsAdminLoggedIn() {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("未登录或会话已过期，需管理员权限"), http.StatusUnauthorized)
		return nil, false
	}
	return sess, true
}
