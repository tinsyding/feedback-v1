package session

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRequireAuthAndRoleHelpers(t *testing.T) {
	store := NewMemoryStore()
	teacherSID := "sess_teacher_1234567890"
	assistantSID := "sess_assist_1234567890"
	adminSID := "sess_admin_12345678901"

	store.Set(teacherSID, map[string]any{
		"user_logged_in": true,
		"username":       "teacher1",
		"user_role":      "teacher",
	})
	store.Set(assistantSID, map[string]any{
		"user_logged_in": true,
		"username":       "teacher1_a1",
		"user_role":      "assistant",
	})
	store.Set(adminSID, map[string]any{
		"admin_logged_in": true,
		"admin_username":  "superadmin",
		"user_role":       "assistant", // admin_logged_in always overrides assistant restriction
	})

	// Missing cookie -> 401
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/upload_pdf.php", nil)
	if _, ok := RequireAuth(rec, req, store); ok {
		t.Fatal("expected missing cookie to fail")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}

	// Teacher cookie -> passes RequireAuth and RequireNonAssistant, fails RequireAdmin
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/upload_pdf.php", nil)
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	sess, ok := RequireAuth(rec, req, store)
	if !ok || sess.Username() != "teacher1" {
		t.Fatalf("expected teacher auth pass, got %v %+v", ok, sess)
	}
	if !RequireNonAssistant(rec, sess, "上传或修改题库 PDF") {
		t.Fatal("teacher should pass RequireNonAssistant")
	}
	recAdmin := httptest.NewRecorder()
	if _, ok := RequireAdmin(recAdmin, req, store); ok || recAdmin.Code != http.StatusUnauthorized {
		t.Fatalf("teacher should fail RequireAdmin with 401, got ok=%v code=%d", ok, recAdmin.Code)
	}

	// Assistant cookie -> passes RequireAuth, fails RequireNonAssistant with 403
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/upload_pdf.php", nil)
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: assistantSID})
	sess, ok = RequireAuth(rec, req, store)
	if !ok {
		t.Fatal("assistant should pass RequireAuth")
	}
	if RequireNonAssistant(rec, sess, "上传或修改题库 PDF") {
		t.Fatal("assistant should fail RequireNonAssistant")
	}
	if rec.Code != http.StatusForbidden {
		t.Fatalf("assistant status = %d, want 403", rec.Code)
	}

	// Admin cookie -> passes RequireAuth, RequireNonAssistant, and RequireAdmin
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/changelog.php", nil)
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: adminSID})
	sess, ok = RequireAdmin(rec, req, store)
	if !ok || sess.AdminUsername() != "superadmin" {
		t.Fatalf("admin should pass RequireAdmin, got ok=%v", ok)
	}
	if !RequireNonAssistant(rec, sess, "上传或修改题库 PDF") {
		t.Fatal("admin should bypass assistant restriction")
	}

	// Nil DB fail-closed
	nilStore := NewMySQLStore(nil)
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/upload_pdf.php", nil)
	req.AddCookie(&http.Cookie{Name: "PHPSESSID", Value: teacherSID})
	if _, ok := RequireAuth(rec, req, nilStore); ok || rec.Code != http.StatusUnauthorized {
		t.Fatalf("nil MySQLStore must fail closed with 401, got ok=%v code=%d", ok, rec.Code)
	}
}

type mockExecRecord struct {
	query string
	args  []any
}

type mockSessionDBState struct {
	mu             sync.Mutex
	payloadJSON    string
	expiresAt      int64
	rowFound       bool
	deleteAffected int64
	execs          []mockExecRecord
}

var (
	mockRegistryMu sync.Mutex
	mockRegistry   = make(map[string]*mockSessionDBState)
)

func init() {
	sql.Register("mock_session_mysql", &mockSessionDriver{})
}

type mockSessionDriver struct{}

func (d *mockSessionDriver) Open(name string) (driver.Conn, error) {
	mockRegistryMu.Lock()
	state := mockRegistry[name]
	mockRegistryMu.Unlock()
	if state == nil {
		return nil, fmt.Errorf("unknown mock dsn %q", name)
	}
	return &mockSessionConn{state: state}, nil
}

type mockSessionConn struct {
	state *mockSessionDBState
}

func (c *mockSessionConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (c *mockSessionConn) Close() error                        { return nil }
func (c *mockSessionConn) Begin() (driver.Tx, error)           { return &mockSessionTx{state: c.state}, nil }
func (c *mockSessionConn) BeginTx(_ context.Context, _ driver.TxOptions) (driver.Tx, error) {
	return &mockSessionTx{state: c.state}, nil
}

type mockSessionTx struct {
	state *mockSessionDBState
}

func (tx *mockSessionTx) Commit() error   { return nil }
func (tx *mockSessionTx) Rollback() error { return nil }

func (c *mockSessionConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	c.state.mu.Lock()
	defer c.state.mu.Unlock()

	if !strings.Contains(query, "SELECT") {
		return nil, fmt.Errorf("unexpected query: %s", query)
	}
	var minExpires int64
	if len(args) >= 2 {
		if v, ok := args[1].Value.(int64); ok {
			minExpires = v
		}
	}
	if !c.state.rowFound || c.state.expiresAt < minExpires {
		return &mockSessionRows{done: true}, nil
	}
	return &mockSessionRows{
		payloadJSON: c.state.payloadJSON,
		expiresAt:   c.state.expiresAt,
	}, nil
}

func (c *mockSessionConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	c.state.mu.Lock()
	defer c.state.mu.Unlock()

	copied := make([]any, len(args))
	for i, a := range args {
		copied[i] = a.Value
	}
	c.state.execs = append(c.state.execs, mockExecRecord{query: query, args: copied})
	if strings.Contains(query, "DELETE FROM") {
		return driver.RowsAffected(c.state.deleteAffected), nil
	}
	return driver.RowsAffected(1), nil
}

type mockSessionRows struct {
	payloadJSON string
	expiresAt   int64
	done        bool
}

func (r *mockSessionRows) Columns() []string { return []string{"payload_json", "expires_at"} }
func (r *mockSessionRows) Close() error      { return nil }
func (r *mockSessionRows) Next(dest []driver.Value) error {
	if r.done {
		return io.EOF
	}
	r.done = true
	dest[0] = r.payloadJSON
	dest[1] = r.expiresAt
	return nil
}

func openMockSessionDB(t *testing.T, state *mockSessionDBState) *sql.DB {
	t.Helper()
	dsn := t.Name()
	mockRegistryMu.Lock()
	mockRegistry[dsn] = state
	mockRegistryMu.Unlock()
	t.Cleanup(func() {
		mockRegistryMu.Lock()
		delete(mockRegistry, dsn)
		mockRegistryMu.Unlock()
	})
	db, err := sql.Open("mock_session_mysql", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestMySQLStoreSlidingTTLAndCleanupExpired(t *testing.T) {
	fixedNow := time.Unix(1_700_000_000, 0)
	sid := "sess_sliding_ttl_1234567890"

	t.Run("slides TTL when remaining < half for logged-in session", func(t *testing.T) {
		state := &mockSessionDBState{
			rowFound:    true,
			payloadJSON: `{"user_logged_in":true,"username":"teacher1","user_role":"teacher"}`,
			expiresAt:   fixedNow.Unix() + 300, // 300s < 720s
		}
		store := NewMySQLStore(openMockSessionDB(t, state))
		store.nowFunc = func() time.Time { return fixedNow }

		sess, err := store.Load(context.Background(), sid)
		if err != nil || sess == nil || !sess.IsLoggedIn() {
			t.Fatalf("Load failed: sess=%+v err=%v", sess, err)
		}
		state.mu.Lock()
		defer state.mu.Unlock()
		if len(state.execs) != 1 {
			t.Fatalf("expected 1 UPDATE exec, got %d: %+v", len(state.execs), state.execs)
		}
		got := state.execs[0]
		wantExp := fixedNow.Unix() + int64(DefaultSessionTTL.Seconds())
		if !strings.Contains(got.query, "UPDATE `app_sessions` SET `expires_at` = ?") {
			t.Fatalf("unexpected query: %s", got.query)
		}
		if len(got.args) != 3 || got.args[0] != wantExp || got.args[1] != sid || got.args[2] != wantExp {
			t.Fatalf("unexpected args = %#v, want [%d %q %d]", got.args, wantExp, sid, wantExp)
		}
	})

	t.Run("does not slide TTL when remaining >= half", func(t *testing.T) {
		state := &mockSessionDBState{
			rowFound:    true,
			payloadJSON: `{"user_logged_in":true,"username":"teacher1"}`,
			expiresAt:   fixedNow.Unix() + 720,
		}
		store := NewMySQLStore(openMockSessionDB(t, state))
		store.nowFunc = func() time.Time { return fixedNow }

		sess, err := store.Load(context.Background(), sid)
		if err != nil || sess == nil {
			t.Fatalf("Load failed: sess=%+v err=%v", sess, err)
		}
		state.mu.Lock()
		defer state.mu.Unlock()
		if len(state.execs) != 0 {
			t.Fatalf("expected 0 UPDATE execs, got %d", len(state.execs))
		}
	})

	t.Run("does not slide TTL for non-logged-in session", func(t *testing.T) {
		state := &mockSessionDBState{
			rowFound:    true,
			payloadJSON: `{"user_logged_in":false}`,
			expiresAt:   fixedNow.Unix() + 100,
		}
		store := NewMySQLStore(openMockSessionDB(t, state))
		store.nowFunc = func() time.Time { return fixedNow }

		sess, err := store.Load(context.Background(), sid)
		if err != nil || sess == nil || sess.IsLoggedIn() {
			t.Fatalf("Load unexpected: sess=%+v err=%v", sess, err)
		}
		state.mu.Lock()
		defer state.mu.Unlock()
		if len(state.execs) != 0 {
			t.Fatalf("expected 0 UPDATE execs, got %d", len(state.execs))
		}
	})

	t.Run("CleanupExpired deletes expired rows", func(t *testing.T) {
		state := &mockSessionDBState{deleteAffected: 7}
		store := NewMySQLStore(openMockSessionDB(t, state))
		store.nowFunc = func() time.Time { return fixedNow }

		deleted, err := store.CleanupExpired(context.Background())
		if err != nil {
			t.Fatalf("CleanupExpired err = %v", err)
		}
		if deleted != 7 {
			t.Fatalf("deleted = %d, want 7", deleted)
		}
		state.mu.Lock()
		defer state.mu.Unlock()
		if len(state.execs) != 1 || !strings.Contains(state.execs[0].query, "DELETE FROM `app_sessions` WHERE `expires_at` < ?") {
			t.Fatalf("unexpected cleanup execs: %+v", state.execs)
		}
		if len(state.execs[0].args) != 1 || state.execs[0].args[0] != fixedNow.Unix() {
			t.Fatalf("unexpected cleanup args: %#v", state.execs[0].args)
		}
	})
}

func TestMySQLStoreSaveDestroyUpdateAndCleanupLoop(t *testing.T) {
	fixedNow := time.Unix(1_700_000_000, 0)
	sid := "sess_mysql_ops_123456789012"

	t.Run("Save inserts payload_json and deletes when empty", func(t *testing.T) {
		state := &mockSessionDBState{}
		store := NewMySQLStore(openMockSessionDB(t, state))
		store.nowFunc = func() time.Time { return fixedNow }

		err := store.Save(context.Background(), &Session{
			ID:   sid,
			Data: map[string]any{"user_logged_in": true, "username": "t101"},
		})
		if err != nil {
			t.Fatalf("Save non-empty err = %v", err)
		}
		err = store.Save(context.Background(), &Session{ID: sid, Data: map[string]any{}})
		if err != nil {
			t.Fatalf("Save empty err = %v", err)
		}

		state.mu.Lock()
		defer state.mu.Unlock()
		if len(state.execs) != 2 {
			t.Fatalf("expected 2 execs, got %d", len(state.execs))
		}
		if !strings.Contains(state.execs[0].query, "INSERT INTO `app_sessions`") {
			t.Fatalf("expected INSERT, got %s", state.execs[0].query)
		}
		wantExp := fixedNow.Unix() + int64(DefaultSessionTTL.Seconds())
		if state.execs[0].args[2] != wantExp {
			t.Fatalf("expires_at = %v, want %d", state.execs[0].args[2], wantExp)
		}
		if !strings.Contains(state.execs[1].query, "DELETE FROM `app_sessions`") {
			t.Fatalf("expected DELETE for empty Save, got %s", state.execs[1].query)
		}
	})

	t.Run("Destroy deletes session row", func(t *testing.T) {
		state := &mockSessionDBState{deleteAffected: 1}
		store := NewMySQLStore(openMockSessionDB(t, state))
		if err := store.Destroy(context.Background(), sid); err != nil {
			t.Fatalf("Destroy err = %v", err)
		}
		state.mu.Lock()
		defer state.mu.Unlock()
		if len(state.execs) != 1 || !strings.Contains(state.execs[0].query, "DELETE FROM `app_sessions`") {
			t.Fatalf("unexpected Destroy execs: %+v", state.execs)
		}
	})

	t.Run("MySQLStore.Update handles changed=true, changed=false, empty-delete, and callback error", func(t *testing.T) {
		// changed=true updates JSON
		state := &mockSessionDBState{
			rowFound:    true,
			payloadJSON: `{"count":1}`,
			expiresAt:   fixedNow.Unix() + 500,
		}
		store := NewMySQLStore(openMockSessionDB(t, state))
		store.nowFunc = func() time.Time { return fixedNow }

		sess, err := Update(context.Background(), store, sid, func(data map[string]any) (bool, error) {
			data["added"] = "ok"
			return true, nil
		})
		if err != nil || sess.Data["added"] != "ok" {
			t.Fatalf("Update changed=true failed: sess=%+v err=%v", sess, err)
		}
		state.mu.Lock()
		if len(state.execs) != 1 || !strings.Contains(state.execs[0].query, "INSERT INTO `app_sessions`") {
			state.mu.Unlock()
			t.Fatalf("expected 1 INSERT exec, got %+v", state.execs)
		}
		state.mu.Unlock()

		// changed=false skips write
		state.mu.Lock()
		state.execs = nil
		state.mu.Unlock()
		if _, err := Update(context.Background(), store, sid, func(data map[string]any) (bool, error) {
			return false, nil
		}); err != nil {
			t.Fatalf("Update changed=false err = %v", err)
		}
		state.mu.Lock()
		if len(state.execs) != 0 {
			state.mu.Unlock()
			t.Fatalf("expected 0 execs when changed=false, got %+v", state.execs)
		}
		state.mu.Unlock()

		// emptying map deletes row
		if _, err := Update(context.Background(), store, sid, func(data map[string]any) (bool, error) {
			delete(data, "count")
			return true, nil
		}); err != nil {
			t.Fatalf("Update empty err = %v", err)
		}
		state.mu.Lock()
		if len(state.execs) != 1 || !strings.Contains(state.execs[0].query, "DELETE FROM `app_sessions`") {
			state.mu.Unlock()
			t.Fatalf("expected DELETE when emptied, got %+v", state.execs)
		}
		state.mu.Unlock()

		// callback error skips write
		state.mu.Lock()
		state.execs = nil
		state.mu.Unlock()
		wantErr := errors.New("boom")
		if _, err := Update(context.Background(), store, sid, func(data map[string]any) (bool, error) {
			data["bad"] = true
			return true, wantErr
		}); !errors.Is(err, wantErr) {
			t.Fatalf("expected %v, got %v", wantErr, err)
		}
		state.mu.Lock()
		if len(state.execs) != 0 {
			state.mu.Unlock()
			t.Fatalf("expected 0 execs on callback error, got %+v", state.execs)
		}
		state.mu.Unlock()
	})

	t.Run("StartCleanupLoop runs initial cleanup and stops on cancel", func(t *testing.T) {
		state := &mockSessionDBState{deleteAffected: 2}
		store := NewMySQLStore(openMockSessionDB(t, state))
		store.nowFunc = func() time.Time { return fixedNow }

		ctx, cancel := context.WithCancel(context.Background())
		store.StartCleanupLoop(ctx, 50*time.Millisecond)
		deadline := time.Now().Add(time.Second)
		for time.Now().Before(deadline) {
			state.mu.Lock()
			n := len(state.execs)
			state.mu.Unlock()
			if n >= 1 {
				break
			}
			time.Sleep(5 * time.Millisecond)
		}
		cancel()
		state.mu.Lock()
		if len(state.execs) < 1 {
			state.mu.Unlock()
			t.Fatal("expected StartCleanupLoop to execute at least 1 cleanup")
		}
		state.mu.Unlock()
	})
}

func TestMemoryStoreConcurrentUpdate(t *testing.T) {
	store := NewMemoryStore()
	sid := "sess_concurrent_update_1234"
	store.Set(sid, map[string]any{"counter": 0})

	const workers = 32
	var wg sync.WaitGroup
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer wg.Done()
			_, err := Update(context.Background(), store, sid, func(data map[string]any) (bool, error) {
				cur, _ := data["counter"].(int)
				data["counter"] = cur + 1
				return true, nil
			})
			if err != nil {
				t.Errorf("concurrent Update failed: %v", err)
			}
		}()
	}
	wg.Wait()

	finalSess, err := store.Load(context.Background(), sid)
	if err != nil || finalSess == nil {
		t.Fatalf("Load failed: sess=%+v err=%v", finalSess, err)
	}
	if finalSess.Data["counter"] != workers {
		t.Fatalf("counter = %v, want %d (lost update!)", finalSess.Data["counter"], workers)
	}
}
