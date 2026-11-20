package session

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
)

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

// Store loads session state by PHPSESSID.
type Store interface {
	Load(ctx context.Context, sessionID string) (*Session, error)
}

// MySQLStore reads shared PHP/Go sessions from the `app_sessions` MySQL table.
type MySQLStore struct {
	db *sql.DB
}

// NewMySQLStore creates a Store backed by *sql.DB. If db is nil, Load fails closed.
func NewMySQLStore(db *sql.DB) *MySQLStore {
	return &MySQLStore{db: db}
}

// Load fetches an unexpired session by ID from `app_sessions`.
func (s *MySQLStore) Load(ctx context.Context, sessionID string) (*Session, error) {
	sessionID = strings.TrimSpace(sessionID)
	if !reValidSessionID.MatchString(sessionID) {
		return nil, nil
	}
	if s == nil || s.db == nil {
		return nil, errors.New("session store database is not configured")
	}

	var rawJSON sql.NullString
	err := s.db.QueryRowContext(
		ctx,
		"SELECT `payload_json` FROM `app_sessions` WHERE `session_id` = ? AND `expires_at` >= ? LIMIT 1",
		sessionID,
		time.Now().Unix(),
	).Scan(&rawJSON)
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
	return &Session{
		ID:   sessionID,
		Data: data,
	}, nil
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
	return &Session{ID: sessionID, Data: data}, nil
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
