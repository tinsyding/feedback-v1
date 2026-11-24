package ratelimit

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

func TestNormalizeKeyMatchesPHP(t *testing.T) {
	if got := NormalizeKey("admin_login_ip", "  127.0.0.1  "); got != "admin_login_ip:127.0.0.1" {
		t.Fatalf("got %q", got)
	}
	if got := NormalizeKey("front_login_user", "TeacherA"); got != "front_login_user:teachera" {
		t.Fatalf("got %q", got)
	}
	longID := strings.Repeat("x", 220)
	longKey := NormalizeKey("scope", longID)
	if len(longKey) != 191 {
		t.Fatalf("expected truncated key length 191, got %d (%q)", len(longKey), longKey)
	}
}

func TestMemoryStoreLockoutWindowAndClear(t *testing.T) {
	store := NewMemoryStore()
	now := time.Unix(1700000000, 0)
	store.nowFunc = func() time.Time { return now }

	ctx := context.Background()

	st, err := store.Status(ctx, "admin_login_user", "alice", 600)
	if err != nil || st.Count != 0 || st.Locked {
		t.Fatalf("initial status unexpected: %+v, err=%v", st, err)
	}

	// 2 failures below threshold 3
	for i := 1; i <= 2; i++ {
		st, err = store.RecordFailure(ctx, "admin_login_user", "alice", 3, 600, 300)
		if err != nil || st.Count != i || st.Locked {
			t.Fatalf("attempt %d unexpected: %+v, err=%v", i, st, err)
		}
	}

	// 3rd failure triggers 300s lockout
	st, err = store.RecordFailure(ctx, "admin_login_user", "alice", 3, 600, 300)
	if err != nil || st.Count != 3 || !st.Locked || st.RemainingSeconds != 300 {
		t.Fatalf("lockout status unexpected: %+v, err=%v", st, err)
	}

	// 100s later still locked with 200s remaining
	now = now.Add(100 * time.Second)
	st, err = store.Status(ctx, "admin_login_user", "alice", 600)
	if err != nil || !st.Locked || st.RemainingSeconds != 200 {
		t.Fatalf("mid-lockout status unexpected: %+v, err=%v", st, err)
	}

	// After window & lockout expire, status resets to 0
	now = now.Add(600 * time.Second)
	st, err = store.Status(ctx, "admin_login_user", "alice", 600)
	if err != nil || st.Count != 0 || st.Locked {
		t.Fatalf("post-expiry status unexpected: %+v, err=%v", st, err)
	}

	// Next failure starts a fresh window at count=1
	st, err = store.RecordFailure(ctx, "admin_login_user", "alice", 3, 600, 300)
	if err != nil || st.Count != 1 || st.Locked {
		t.Fatalf("fresh window status unexpected: %+v, err=%v", st, err)
	}

	// Clear removes bucket
	if err := store.Clear(ctx, "admin_login_user", "alice"); err != nil {
		t.Fatalf("Clear failed: %v", err)
	}
	st, err = store.Status(ctx, "admin_login_user", "alice", 600)
	if err != nil || st.Count != 0 || st.Locked {
		t.Fatalf("post-clear status unexpected: %+v, err=%v", st, err)
	}
}

type mockRLRow struct {
	count     int64
	firstAt   int64
	updatedAt int64
	lockUntil int64
}

type mockRLState struct {
	mu      sync.Mutex
	buckets map[string]mockRLRow
	execErr error
	txOpen  int
	commits int
	rolls   int
}

var (
	mockRLMu       sync.Mutex
	mockRLRegistry = make(map[string]*mockRLState)
)

func init() {
	sql.Register("mock_ratelimit_mysql", &mockRLDriver{})
}

type mockRLDriver struct{}

func (d *mockRLDriver) Open(name string) (driver.Conn, error) {
	mockRLMu.Lock()
	st := mockRLRegistry[name]
	mockRLMu.Unlock()
	if st == nil {
		return nil, fmt.Errorf("unknown mock dsn %q", name)
	}
	return &mockRLConn{state: st}, nil
}

type mockRLConn struct{ state *mockRLState }
type mockRLTx struct{ state *mockRLState }

func (c *mockRLConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (c *mockRLConn) Close() error                        { return nil }
func (c *mockRLConn) Begin() (driver.Tx, error)           { return c.BeginTx(context.Background(), driver.TxOptions{}) }
func (c *mockRLConn) BeginTx(_ context.Context, _ driver.TxOptions) (driver.Tx, error) {
	c.state.mu.Lock()
	c.state.txOpen++
	c.state.mu.Unlock()
	return &mockRLTx{state: c.state}, nil
}

func (tx *mockRLTx) Commit() error {
	tx.state.mu.Lock()
	tx.state.commits++
	tx.state.mu.Unlock()
	return nil
}
func (tx *mockRLTx) Rollback() error {
	tx.state.mu.Lock()
	tx.state.rolls++
	tx.state.mu.Unlock()
	return nil
}

func (c *mockRLConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	c.state.mu.Lock()
	defer c.state.mu.Unlock()
	if !strings.Contains(query, "FROM `auth_rate_limits`") || len(args) < 1 {
		return nil, fmt.Errorf("unexpected query: %s", query)
	}
	key, _ := args[0].Value.(string)
	row, ok := c.state.buckets[key]
	if !ok {
		return &mockRLRows{done: true}, nil
	}
	return &mockRLRows{row: row}, nil
}

func (c *mockRLConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	c.state.mu.Lock()
	defer c.state.mu.Unlock()
	if c.state.execErr != nil {
		return nil, c.state.execErr
	}
	switch {
	case strings.Contains(query, "INSERT INTO `auth_rate_limits`"):
		key, _ := args[0].Value.(string)
		cnt, _ := args[1].Value.(int64)
		first, _ := args[2].Value.(int64)
		upd, _ := args[3].Value.(int64)
		lock, _ := args[4].Value.(int64)
		c.state.buckets[key] = mockRLRow{count: cnt, firstAt: first, updatedAt: upd, lockUntil: lock}
		return driver.RowsAffected(1), nil
	case strings.Contains(query, "DELETE FROM `auth_rate_limits` WHERE `bucket_key` = ?"):
		key, _ := args[0].Value.(string)
		delete(c.state.buckets, key)
		return driver.RowsAffected(1), nil
	case strings.Contains(query, "DELETE FROM `auth_rate_limits` WHERE `lock_until` < ?"):
		now, _ := args[0].Value.(int64)
		cutoff, _ := args[1].Value.(int64)
		var del int64
		for k, v := range c.state.buckets {
			if v.lockUntil < now && v.updatedAt < cutoff {
				delete(c.state.buckets, k)
				del++
			}
		}
		return driver.RowsAffected(del), nil
	default:
		return nil, fmt.Errorf("unexpected exec: %s", query)
	}
}

type mockRLRows struct {
	row  mockRLRow
	done bool
}

func (r *mockRLRows) Columns() []string {
	return []string{"fail_count", "first_at", "updated_at", "lock_until"}
}
func (r *mockRLRows) Close() error { return nil }
func (r *mockRLRows) Next(dest []driver.Value) error {
	if r.done {
		return io.EOF
	}
	r.done = true
	dest[0] = r.row.count
	dest[1] = r.row.firstAt
	dest[2] = r.row.updatedAt
	dest[3] = r.row.lockUntil
	return nil
}

func openMockRLDB(t *testing.T, st *mockRLState) *sql.DB {
	t.Helper()
	dsn := t.Name()
	mockRLMu.Lock()
	mockRLRegistry[dsn] = st
	mockRLMu.Unlock()
	t.Cleanup(func() {
		mockRLMu.Lock()
		delete(mockRLRegistry, dsn)
		mockRLMu.Unlock()
	})
	db, err := sql.Open("mock_ratelimit_mysql", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestMySQLStoreLifecycle(t *testing.T) {
	st := &mockRLState{buckets: make(map[string]mockRLRow)}
	store := NewMySQLStore(openMockRLDB(t, st))
	now := time.Unix(1700000000, 0)
	store.nowFunc = func() time.Time { return now }
	ctx := context.Background()

	// 1. Status missing -> 0
	s, err := store.Status(ctx, "front_login_ip", "203.0.113.1", 600)
	if err != nil || s.Count != 0 || s.Locked {
		t.Fatalf("initial status: %+v err=%v", s, err)
	}

	// 2. RecordFailure up to lockout (3 attempts)
	for i := 1; i <= 2; i++ {
		s, err = store.RecordFailure(ctx, "front_login_ip", "203.0.113.1", 3, 600, 300)
		if err != nil || s.Count != i || s.Locked {
			t.Fatalf("attempt %d: %+v err=%v", i, s, err)
		}
	}
	s, err = store.RecordFailure(ctx, "front_login_ip", "203.0.113.1", 3, 600, 300)
	if err != nil || s.Count != 3 || !s.Locked || s.RemainingSeconds != 300 {
		t.Fatalf("lockout status: %+v err=%v", s, err)
	}

	// 3. Status reflects lock mid-window
	now = now.Add(100 * time.Second)
	s, err = store.Status(ctx, "front_login_ip", "203.0.113.1", 600)
	if err != nil || !s.Locked || s.RemainingSeconds != 200 {
		t.Fatalf("mid-lock status: %+v err=%v", s, err)
	}

	// 4. After window expiry, Status resets to 0 and RecordFailure starts new window
	now = now.Add(600 * time.Second)
	s, err = store.Status(ctx, "front_login_ip", "203.0.113.1", 600)
	if err != nil || s.Count != 0 || s.Locked {
		t.Fatalf("expired status: %+v err=%v", s, err)
	}
	s, err = store.RecordFailure(ctx, "front_login_ip", "203.0.113.1", 3, 600, 300)
	if err != nil || s.Count != 1 || s.Locked {
		t.Fatalf("fresh window RecordFailure: %+v err=%v", s, err)
	}

	// 5. Clear removes bucket
	if err := store.Clear(ctx, "front_login_ip", "203.0.113.1"); err != nil {
		t.Fatalf("Clear: %v", err)
	}
	if _, ok := st.buckets[NormalizeKey("front_login_ip", "203.0.113.1")]; ok {
		t.Fatal("expected bucket deleted after Clear")
	}

	// 6. CleanupExpired deletes stale buckets only
	st.buckets["stale"] = mockRLRow{count: 2, firstAt: now.Unix() - 90000, updatedAt: now.Unix() - 90000, lockUntil: 0}
	st.buckets["fresh"] = mockRLRow{count: 1, firstAt: now.Unix() - 10, updatedAt: now.Unix() - 10, lockUntil: 0}
	deleted, err := store.CleanupExpired(ctx)
	if err != nil || deleted != 1 {
		t.Fatalf("CleanupExpired: deleted=%d err=%v", deleted, err)
	}
	if _, ok := st.buckets["fresh"]; !ok {
		t.Fatal("expected fresh bucket preserved")
	}

	// 7. DB exec failure triggers rollback and returns error
	st.execErr = errors.New("write error")
	if _, err := store.RecordFailure(ctx, "front_login_ip", "203.0.113.9", 3, 600, 300); err == nil {
		t.Fatal("expected error on exec failure")
	}
	if st.rolls == 0 {
		t.Fatal("expected tx rollback on exec failure")
	}
}

func TestNormalizeKeyUTF8SafeTruncation(t *testing.T) {
	// 3-byte CJK runes: 15-byte prefix + 65*3 = 210 bytes (>191)
	cjkKey := NormalizeKey("reset_pwd_user", strings.Repeat("教", 65))
	if len(cjkKey) > 191 {
		t.Fatalf("CJK key len = %d, want <= 191", len(cjkKey))
	}
	if !utf8.ValidString(cjkKey) {
		t.Fatalf("CJK key is invalid UTF-8: %q", cjkKey)
	}
	if parts := strings.Split(cjkKey, ":"); len(parts) != 3 || len(parts[2]) != 32 {
		t.Fatalf("expected <scope>:<prefix>:<md5>, got %q", cjkKey)
	}

	// 4-byte emoji runes
	emojiKey := NormalizeKey("front_login_user", strings.Repeat("🔒", 50))
	if len(emojiKey) > 191 || !utf8.ValidString(emojiKey) {
		t.Fatalf("emoji key invalid: len=%d valid=%v key=%q", len(emojiKey), utf8.ValidString(emojiKey), emojiKey)
	}
}

func TestFallbackStoreAndResilientStore(t *testing.T) {
	ctx := context.Background()

	// 1. Nil DB resilient store falls back directly to MemoryStore
	nilResilient := NewResilientStore(nil)
	for i := 1; i <= 4; i++ {
		st, err := nilResilient.RecordFailure(ctx, "front_login_user", "alice", 5, 600, 300)
		if err != nil || st.Count != i || st.Locked {
			t.Fatalf("nil resilient attempt %d unexpected: %+v err=%v", i, st, err)
		}
	}
	stLock, err := nilResilient.RecordFailure(ctx, "front_login_user", "alice", 5, 600, 300)
	if err != nil || !stLock.Locked || stLock.RemainingSeconds != 300 {
		t.Fatalf("expected lockout at 5th attempt, got %+v err=%v", stLock, err)
	}
	if err := nilResilient.Clear(ctx, "front_login_user", "alice"); err != nil {
		t.Fatalf("Clear failed: %v", err)
	}
	stAfter, err := nilResilient.Status(ctx, "front_login_user", "alice", 600)
	if err != nil || stAfter.Count != 0 || stAfter.Locked {
		t.Fatalf("expected cleared status, got %+v err=%v", stAfter, err)
	}

	// 2. Primary MySQLStore returning runtime error (e.g. unmigrated table / DB outage) falls back seamlessly
	mockState := &mockRLState{
		buckets: make(map[string]mockRLRow),
		execErr: errors.New("Error 1146: Table 'feedback.auth_rate_limits' doesn't exist"),
	}
	mysqlPrimary := NewMySQLStore(openMockRLDB(t, mockState))
	now := time.Unix(1700000000, 0)
	mysqlPrimary.nowFunc = func() time.Time { return now }
	memFallback := NewMemoryStore()
	memFallback.nowFunc = func() time.Time { return now }
	fb := NewFallbackStore(mysqlPrimary, memFallback)

	for i := 1; i <= 5; i++ {
		st, recErr := fb.RecordFailure(ctx, "admin_login_user", "127.0.0.1_admin", 5, 600, 600)
		if recErr != nil {
			t.Fatalf("fallback RecordFailure(%d) returned error: %v", i, recErr)
		}
		if i == 5 && (!st.Locked || st.RemainingSeconds != 600) {
			t.Fatalf("expected fallback lockout at 5th failure, got %+v", st)
		}
	}

	// Even if primary recovers with empty table, Status still honors active fallback lockout until Clear
	mockState.execErr = nil
	stRecovered, err := fb.Status(ctx, "admin_login_user", "127.0.0.1_admin", 600)
	if err != nil || !stRecovered.Locked {
		t.Fatalf("expected fallback lockout preserved when primary recovers empty, got %+v err=%v", stRecovered, err)
	}
	if err := fb.Clear(ctx, "admin_login_user", "127.0.0.1_admin"); err != nil {
		t.Fatalf("Clear failed: %v", err)
	}
	stPostClear, err := fb.Status(ctx, "admin_login_user", "127.0.0.1_admin", 600)
	if err != nil || stPostClear.Locked || stPostClear.Count != 0 {
		t.Fatalf("expected cleared after fb.Clear, got %+v err=%v", stPostClear, err)
	}
}
