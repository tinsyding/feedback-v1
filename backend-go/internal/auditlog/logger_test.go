package auditlog

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestDualLoggerAppendsJSONL(t *testing.T) {
	root := t.TempDir()
	logger := NewDualLogger(nil, root)
	fixed := time.Date(2026, 11, 21, 16, 30, 0, 0, time.UTC) // 2026-11-22 00:30:00 CST
	logger.nowFunc = func() time.Time { return fixed }

	logger.Record(context.Background(), Entry{
		Level:     "action",
		Module:    "user_auth",
		Event:     "login_success",
		Operator:  "t101",
		Details:   map[string]any{"username": "t101", "message": "登录成功"},
		ClientIP:  "203.0.113.5",
		UserAgent: "TestAgent/1.0",
	})

	jsonlPath := filepath.Join(root, "data", "logs", "2026-11-22.jsonl")
	raw, err := os.ReadFile(jsonlPath)
	if err != nil {
		t.Fatalf("read jsonl failed: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 1 {
		t.Fatalf("expected 1 line, got %d", len(lines))
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &parsed); err != nil {
		t.Fatalf("invalid jsonl: %v", err)
	}
	if parsed["module"] != "user_auth" || parsed["event"] != "login_success" || parsed["operator"] != "t101" {
		t.Fatalf("unexpected log entry: %+v", parsed)
	}
}

type mockAuditExec struct {
	query string
	args  []any
}

type mockAuditState struct {
	mu    sync.Mutex
	execs []mockAuditExec
}

var (
	mockAuditMu       sync.Mutex
	mockAuditRegistry = make(map[string]*mockAuditState)
)

func init() {
	sql.Register("mock_auditlog_mysql", &mockAuditDriver{})
}

type mockAuditDriver struct{}

func (d *mockAuditDriver) Open(name string) (driver.Conn, error) {
	mockAuditMu.Lock()
	st := mockAuditRegistry[name]
	mockAuditMu.Unlock()
	if st == nil {
		return nil, fmt.Errorf("unknown mock dsn %q", name)
	}
	return &mockAuditConn{state: st}, nil
}

type mockAuditConn struct{ state *mockAuditState }

func (c *mockAuditConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (c *mockAuditConn) Close() error                        { return nil }
func (c *mockAuditConn) Begin() (driver.Tx, error)           { return nil, driver.ErrSkip }
func (c *mockAuditConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	copied := make([]any, len(args))
	for i, a := range args {
		copied[i] = a.Value
	}
	c.state.mu.Lock()
	c.state.execs = append(c.state.execs, mockAuditExec{query: query, args: copied})
	c.state.mu.Unlock()
	return driver.RowsAffected(1), nil
}

func TestDualLoggerDBWriteSurvivesCanceledRequestCtx(t *testing.T) {
	st := &mockAuditState{}
	dsn := t.Name()
	mockAuditMu.Lock()
	mockAuditRegistry[dsn] = st
	mockAuditMu.Unlock()
	t.Cleanup(func() {
		mockAuditMu.Lock()
		delete(mockAuditRegistry, dsn)
		mockAuditMu.Unlock()
	})
	db, err := sql.Open("mock_auditlog_mysql", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()

	root := t.TempDir()
	logger := NewDualLogger(db, root)
	logger.nowFunc = func() time.Time { return time.Date(2026, 11, 21, 16, 0, 0, 0, time.UTC) }

	canceledCtx, cancel := context.WithCancel(context.Background())
	cancel()

	req := httptest.NewRequest(http.MethodPost, "/api/auth.php?action=login", nil)
	req.RemoteAddr = "198.51.100.7:1234"
	req.Header.Set("User-Agent", "AuditTest/1.0")

	RecordFromRequest(canceledCtx, logger, req, "warn", "user_auth", "login_failed", strings.Repeat("老师", 30), map[string]any{"ok": false})

	st.mu.Lock()
	defer st.mu.Unlock()
	if len(st.execs) != 1 || !strings.Contains(st.execs[0].query, "INSERT INTO `system_logs`") {
		t.Fatalf("expected 1 INSERT even with canceled request ctx, got %+v", st.execs)
	}
	// Verify created_at formatted in Asia/Shanghai (16:00 UTC -> next day 00:00:00 CST)
	if st.execs[0].args[10] != "2026-11-22 00:00:00" {
		t.Fatalf("created_at = %v, want 2026-11-22 00:00:00", st.execs[0].args[10])
	}
}
