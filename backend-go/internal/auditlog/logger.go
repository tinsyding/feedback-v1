package auditlog

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"feedback-api/internal/httpx"
)

// Entry represents a single backend audit log event matching PHP recordServerLog().
type Entry struct {
	Level    string
	Module   string
	Event    string
	Operator string
	Details  map[string]any
	Context  map[string]any
	ClientIP string
	UserAgent string
}

// Logger writes structured backend audit logs.
type Logger interface {
	Record(ctx context.Context, entry Entry)
}

// RecordFromRequest is a convenience helper that fills ClientIP and UserAgent from r.
func RecordFromRequest(ctx context.Context, l Logger, r *http.Request, level, module, event, operator string, details map[string]any) {
	if l == nil {
		return
	}
	ip := "127.0.0.1"
	ua := "ServerInternal"
	if r != nil {
		ip = httpx.GetClientIP(r)
		if gotUA := strings.TrimSpace(r.Header.Get("User-Agent")); gotUA != "" {
			ua = gotUA
		}
	}
	l.Record(ctx, Entry{
		Level:     level,
		Module:    module,
		Event:     event,
		Operator:  operator,
		Details:   details,
		Context:   map[string]any{},
		ClientIP:  ip,
		UserAgent: ua,
	})
}

// DualLogger dual-writes backend audit logs to MySQL `system_logs` and `<FeedbackRoot>/data/logs/YYYY-MM-DD.jsonl`.
type DualLogger struct {
	db           *sql.DB
	feedbackRoot string
	fileMu       sync.Mutex
	nowFunc      func() time.Time
}

// NewDualLogger creates a DualLogger. Either db or feedbackRoot may be nil/empty (graceful degradation).
func NewDualLogger(db *sql.DB, feedbackRoot string) *DualLogger {
	return &DualLogger{
		db:           db,
		feedbackRoot: strings.TrimSpace(feedbackRoot),
		nowFunc:      time.Now,
	}
}

func (l *DualLogger) now() time.Time {
	if l != nil && l.nowFunc != nil {
		return l.nowFunc()
	}
	return time.Now()
}

func newLogID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "srv_" + hex.EncodeToString(b)
}

// Record writes the entry to MySQL system_logs and appends NDJSON to data/logs/YYYY-MM-DD.jsonl.
// Errors are swallowed so audit logging never breaks primary business requests.
func (l *DualLogger) Record(ctx context.Context, entry Entry) {
	if l == nil {
		return
	}
	now := l.now()
	tsMs := now.UnixMilli()
	logID := newLogID()
	createdAt := now.Format("2006-01-02 15:04:05")

	ip := strings.TrimSpace(entry.ClientIP)
	if ip == "" {
		ip = "127.0.0.1"
	}
	if len(ip) > 45 {
		ip = ip[:45]
	}
	ua := strings.TrimSpace(entry.UserAgent)
	if ua == "" {
		ua = "ServerInternal"
	}

	details := entry.Details
	if details == nil {
		details = map[string]any{}
	}
	ctxMap := entry.Context
	if ctxMap == nil {
		ctxMap = map[string]any{}
	}

	operator := strings.TrimSpace(entry.Operator)
	if operator == "" {
		if v, ok := details["operator"].(string); ok && strings.TrimSpace(v) != "" {
			operator = strings.TrimSpace(v)
		}
	}
	if len(operator) > 50 {
		operator = operator[:50]
	}

	clientInfo := map[string]any{
		"ip":        ip,
		"userAgent": ua,
		"platform":  runtime.GOOS,
		"source":    "backend",
		"engine":    "go",
	}

	detailsJSON, _ := json.Marshal(details)
	ctxJSON, _ := json.Marshal(ctxMap)
	clientInfoJSON, _ := json.Marshal(clientInfo)

	// 1. Best-effort write to MySQL system_logs
	if l.db != nil {
		dbCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		_, _ = l.db.ExecContext(
			dbCtx,
			`INSERT INTO `+"`system_logs`"+`
			 (`+"`log_id`, `timestamp`, `level`, `module`, `event`, `operator`, `details`, `context`, `client_ip`, `client_info`, `created_at`"+`)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			logID,
			tsMs,
			entry.Level,
			entry.Module,
			entry.Event,
			operator,
			string(detailsJSON),
			string(ctxJSON),
			ip,
			string(clientInfoJSON),
			createdAt,
		)
		cancel()
	}

	// 2. Best-effort append to data/logs/YYYY-MM-DD.jsonl
	if l.feedbackRoot != "" {
		logDir := filepath.Join(l.feedbackRoot, "data", "logs")
		lineObj := map[string]any{
			"id":        logID,
			"timestamp": tsMs,
			"level":     entry.Level,
			"module":    entry.Module,
			"event":     entry.Event,
			"operator":  operator,
			"details":   details,
			"context":   ctxMap,
			"client":    clientInfo,
		}
		lineBytes, err := json.Marshal(lineObj)
		if err == nil {
			l.fileMu.Lock()
			if mkErr := os.MkdirAll(logDir, 0755); mkErr == nil {
				jsonlPath := filepath.Join(logDir, now.Format("2006-01-02")+".jsonl")
				if f, openErr := os.OpenFile(jsonlPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644); openErr == nil {
					_, _ = f.Write(append(lineBytes, '\n'))
					_ = f.Close()
				}
			}
			l.fileMu.Unlock()
		}
	}
}

// NoopLogger discards all log entries (useful for unit tests).
type NoopLogger struct{}

// Record implements Logger.
func (NoopLogger) Record(context.Context, Entry) {}
