package auth

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

type mockAuthSQLRecord struct {
	query string
	args  []any
}

type mockAuthDBState struct {
	mu             sync.Mutex
	queries        []mockAuthSQLRecord
	execs          []mockAuthSQLRecord
	userFound      bool
	adminFound     bool
	assistantRows  [][]driver.Value
	lastInsertID   int64
	deleteAffected int64
}

var (
	mockAuthDBMu       sync.Mutex
	mockAuthDBRegistry = make(map[string]*mockAuthDBState)
)

func init() {
	sql.Register("mock_auth_mysql", &mockAuthDriver{})
}

type mockAuthDriver struct{}

func (d *mockAuthDriver) Open(name string) (driver.Conn, error) {
	mockAuthDBMu.Lock()
	st := mockAuthDBRegistry[name]
	mockAuthDBMu.Unlock()
	if st == nil {
		return nil, fmt.Errorf("unknown mock dsn %q", name)
	}
	return &mockAuthConn{state: st}, nil
}

type mockAuthConn struct{ state *mockAuthDBState }

func (c *mockAuthConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (c *mockAuthConn) Close() error                        { return nil }
func (c *mockAuthConn) Begin() (driver.Tx, error)           { return nil, driver.ErrSkip }

func (c *mockAuthConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	copied := make([]any, len(args))
	for i, a := range args {
		copied[i] = a.Value
	}
	c.state.mu.Lock()
	c.state.execs = append(c.state.execs, mockAuthSQLRecord{query: query, args: copied})
	id := c.state.lastInsertID
	c.state.mu.Unlock()
	if strings.Contains(query, "INSERT INTO") {
		return mockAuthResult{lastID: id, affected: 1}, nil
	}
	return mockAuthResult{affected: 1}, nil
}

func (c *mockAuthConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	copied := make([]any, len(args))
	for i, a := range args {
		copied[i] = a.Value
	}
	c.state.mu.Lock()
	c.state.queries = append(c.state.queries, mockAuthSQLRecord{query: query, args: copied})
	st := c.state
	c.state.mu.Unlock()

	switch {
	case strings.Contains(query, "FROM `users` WHERE `username` = ?"):
		if !st.userFound {
			return &mockAuthRows{cols: []string{"id", "username", "password_hash", "real_name", "role", "teacher_id", "created_by", "status"}}, nil
		}
		return &mockAuthRows{
			cols: []string{"id", "username", "password_hash", "real_name", "role", "teacher_id", "created_by", "status"},
			rows: [][]driver.Value{{int64(7), "t101", "$2y$hash", "张老师", nil, int64(0), nil, int64(1)}},
		}, nil
	case strings.Contains(query, "FROM `admin_users` WHERE `username` = ?"):
		if !st.adminFound {
			return &mockAuthRows{cols: []string{"id", "username", "password_hash", "real_name", "role", "status"}}, nil
		}
		return &mockAuthRows{
			cols: []string{"id", "username", "password_hash", "real_name", "role", "status"},
			rows: [][]driver.Value{{int64(1), "boss", "$2a$hash", "管理员", "super_admin", int64(1)}},
		}, nil
	case strings.Contains(query, "FROM `users` WHERE `role` = 'assistant'"):
		return &mockAuthRows{
			cols: []string{"id", "username", "real_name", "role", "teacher_id", "created_by", "status", "last_login_at", "created_at", "updated_at"},
			rows: st.assistantRows,
		}, nil
	case strings.Contains(query, "FROM `users` WHERE `id` = ? AND `role` = 'assistant'"):
		if len(st.assistantRows) == 0 {
			return &mockAuthRows{cols: []string{"id", "username", "password_hash", "real_name", "role", "teacher_id", "created_by", "status"}}, nil
		}
		return &mockAuthRows{
			cols: []string{"id", "username", "password_hash", "real_name", "role", "teacher_id", "created_by", "status"},
			rows: [][]driver.Value{{int64(21), "t101_01", "$2a$hash", "助教", "assistant", int64(7), "t101", int64(1)}},
		}, nil
	default:
		return nil, fmt.Errorf("unexpected query: %s", query)
	}
}

type mockAuthResult struct {
	lastID   int64
	affected int64
}

func (r mockAuthResult) LastInsertId() (int64, error) { return r.lastID, nil }
func (r mockAuthResult) RowsAffected() (int64, error) { return r.affected, nil }

type mockAuthRows struct {
	cols []string
	rows [][]driver.Value
	idx  int
}

func (r *mockAuthRows) Columns() []string { return r.cols }
func (r *mockAuthRows) Close() error      { return nil }
func (r *mockAuthRows) Next(dest []driver.Value) error {
	if r.idx >= len(r.rows) {
		return io.EOF
	}
	copy(dest, r.rows[r.idx])
	r.idx++
	return nil
}

func openMockAuthDB(t *testing.T, st *mockAuthDBState) *sql.DB {
	t.Helper()
	dsn := t.Name()
	mockAuthDBMu.Lock()
	mockAuthDBRegistry[dsn] = st
	mockAuthDBMu.Unlock()
	t.Cleanup(func() {
		mockAuthDBMu.Lock()
		delete(mockAuthDBRegistry, dsn)
		mockAuthDBMu.Unlock()
	})
	db, err := sql.Open("mock_auth_mysql", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestMySQLRepositoryQueriesAndNullTimeFormatting(t *testing.T) {
	utcTS := time.Date(2026, 11, 21, 16, 15, 30, 0, time.UTC) // 2026-11-22 00:15:30 Asia/Shanghai
	st := &mockAuthDBState{
		userFound:    true,
		adminFound:   true,
		lastInsertID: 88,
		assistantRows: [][]driver.Value{
			{int64(21), "t101_01", "助教小王", "assistant", int64(7), "t101", int64(1), nil, utcTS, utcTS},
		},
	}
	repo := NewMySQLRepository(openMockAuthDB(t, st))
	ctx := context.Background()

	u, err := repo.FindUserByUsername(ctx, "t101")
	if err != nil || u == nil || u.ID != 7 || u.RealName != "张老师" {
		t.Fatalf("FindUserByUsername: u=%+v err=%v", u, err)
	}

	a, err := repo.FindAdminByUsername(ctx, "boss")
	if err != nil || a == nil || a.Username != "boss" {
		t.Fatalf("FindAdminByUsername: a=%+v err=%v", a, err)
	}

	// ListAssistants with ownerID=0 must only filter by created_by (not teacher_id=0)
	list0, err := repo.ListAssistants(ctx, 0, "admin1")
	if err != nil {
		t.Fatalf("ListAssistants(ownerID=0): %v", err)
	}
	if len(list0) != 1 || list0[0].LastLoginAt != nil || list0[0].CreatedAt == nil || *list0[0].CreatedAt != "2026-11-22 00:15:30" {
		t.Fatalf("unexpected ListAssistants row: %+v (createdAt=%v)", list0, list0[0].CreatedAt)
	}
	if strings.Contains(st.queries[len(st.queries)-1].query, "`teacher_id` =") {
		t.Fatalf("ownerID=0 query must not match teacher_id=0: %s", st.queries[len(st.queries)-1].query)
	}

	newID, err := repo.CreateAssistant(ctx, "t101_02", "$2a$x", "小李", 7, "t101")
	if err != nil || newID != 88 {
		t.Fatalf("CreateAssistant: id=%d err=%v", newID, err)
	}

	owned, err := repo.FindAssistantOwned(ctx, 21, 7, "t101")
	if err != nil || owned == nil || owned.Username != "t101_01" {
		t.Fatalf("FindAssistantOwned: owned=%+v err=%v", owned, err)
	}

	newName := "新姓名"
	newStatus := 0
	newHash := "$2a$newhash"
	if err := repo.UpdateAssistant(ctx, 21, AssistantUpdatePatch{RealName: &newName, Status: &newStatus, PasswordHash: &newHash}); err != nil {
		t.Fatalf("UpdateAssistant: %v", err)
	}
	if err := repo.UpdateUserPassword(ctx, 7, "$2a$u"); err != nil {
		t.Fatalf("UpdateUserPassword: %v", err)
	}
	if err := repo.UpgradeAdminPasswordHash(ctx, 1, "$2a$adm"); err != nil {
		t.Fatalf("UpgradeAdminPasswordHash: %v", err)
	}
	if err := repo.DeleteAssistant(ctx, 21); err != nil {
		t.Fatalf("DeleteAssistant: %v", err)
	}
}
