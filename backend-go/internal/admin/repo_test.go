package admin

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"feedback-api/internal/qbankattest"
	"feedback-api/internal/retestkeys"
)

type mockAdminSQLRecord struct {
	query string
	args  []any
}

type mockAdminDBState struct {
	mu                   sync.Mutex
	queries              []mockAdminSQLRecord
	execs                []mockAdminSQLRecord
	txBegun              int
	txCommitted          int
	txRolledBack         int
	relatedStudentCount  int64
	adminCount           int64
	failQBankWeeksDelete bool
	failRollbackUpdate   bool
	resetUserUsername    string
	missingRecord        bool
}

var (
	mockAdminDBMu       sync.Mutex
	mockAdminDBRegistry = make(map[string]*mockAdminDBState)
)

func init() {
	sql.Register("mock_admin_mysql", &mockAdminDriver{})
}

type mockAdminDriver struct{}

func (d *mockAdminDriver) Open(name string) (driver.Conn, error) {
	mockAdminDBMu.Lock()
	st := mockAdminDBRegistry[name]
	mockAdminDBMu.Unlock()
	if st == nil {
		return nil, fmt.Errorf("unknown mock admin dsn %q", name)
	}
	return &mockAdminConn{state: st}, nil
}

type mockAdminConn struct {
	state *mockAdminDBState
}

func (c *mockAdminConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (c *mockAdminConn) Close() error                        { return nil }
func (c *mockAdminConn) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}
func (c *mockAdminConn) BeginTx(_ context.Context, _ driver.TxOptions) (driver.Tx, error) {
	c.state.mu.Lock()
	c.state.txBegun++
	c.state.mu.Unlock()
	return &mockAdminTx{state: c.state}, nil
}

func (c *mockAdminConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	copied := make([]any, len(args))
	for i, a := range args {
		copied[i] = a.Value
	}
	c.state.mu.Lock()
	c.state.execs = append(c.state.execs, mockAdminSQLRecord{query: query, args: copied})
	failWeeks := c.state.failQBankWeeksDelete
	failRB := c.state.failRollbackUpdate
	c.state.mu.Unlock()

	if failWeeks && strings.Contains(query, "DELETE FROM `qbank_weeks`") {
		return nil, errors.New("simulated delete qbank_weeks failure")
	}
	if failRB && strings.Contains(query, "UPDATE student_records SET") {
		return nil, errors.New("simulated rollback update failure")
	}
	return mockAdminResult{lastID: 505, affected: 1}, nil
}

func fullColRows(cols [][7]string) *mockAdminRows {
	rows := make([][]driver.Value, 0, len(cols))
	for _, c := range cols {
		var defVal driver.Value
		if c[4] != "<nil>" {
			defVal = c[4]
		}
		rows = append(rows, []driver.Value{c[0], c[1], c[2], c[3], defVal, c[5], c[6]})
	}
	return &mockAdminRows{
		cols:    []string{"Field", "Type", "Null", "Key", "Default", "Extra", "Comment"},
		dbTypes: []string{"VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR"},
		rows:    rows,
	}
}

func (c *mockAdminConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	copied := make([]any, len(args))
	for i, a := range args {
		copied[i] = a.Value
	}
	c.state.mu.Lock()
	c.state.queries = append(c.state.queries, mockAdminSQLRecord{query: query, args: copied})
	st := c.state
	relatedCnt := st.relatedStudentCount
	adminCnt := st.adminCount
	if adminCnt == 0 {
		adminCnt = 2
	}
	resetUname := st.resetUserUsername
	if resetUname == "" {
		resetUname = "t101"
	}
	missingRec := st.missingRecord
	c.state.mu.Unlock()

	utcTS := time.Date(2026, 11, 21, 16, 5, 30, 0, time.UTC) // 2026-11-22 00:05:30 Asia/Shanghai

	switch {
	case query == "SHOW TABLES":
		return &mockAdminRows{
			cols: []string{"Tables_in_feedback"},
			rows: [][]driver.Value{
				{"student_records"}, {"class_batches"}, {"users"}, {"admin_users"},
				{"qbank_weeks"}, {"qbank_questions"}, {"generation_batches"}, {"student_record_history"},
				{"system_logs"}, {"retest_access_logs"}, {"app_sessions"}, {"auth_rate_limits"}, {"schema_migrations"},
			},
		}, nil

	case query == "SHOW TABLE STATUS":
		return &mockAdminRows{
			cols:    []string{"Name", "Comment", "Avg_row_length", "Data_length", "Auto_increment", "Update_time"},
			dbTypes: []string{"VARCHAR", "VARCHAR", "BIGINT", "BIGINT", "BIGINT", "DATETIME"},
			rows: [][]driver.Value{
				{"student_records", "学生学情记录", int64(256), int64(4096), int64(100), utcTS},
				{"users", "教师账号", int64(128), int64(1024), int64(20), nil},
				{"app_sessions", "hidden session", int64(64), int64(512), nil, nil},
			},
		}, nil

	case strings.HasPrefix(query, "SHOW FULL COLUMNS FROM `student_records`"):
		return fullColRows([][7]string{
			{"id", "int", "NO", "PRI", "<nil>", "auto_increment", "ID"},
			{"batch_id", "int", "NO", "", "0", "", ""},
			{"student_id", "varchar(64)", "NO", "", "", "", ""},
			{"student_name", "varchar(64)", "NO", "", "", "", ""},
			{"student_key", "varchar(128)", "NO", "", "", "", ""},
			{"week_num", "int", "NO", "", "1", "", ""},
			{"error_count", "int", "NO", "", "0", "", ""},
			{"error_questions", "text", "YES", "", "<nil>", "", ""},
			{"preview_error_questions", "text", "YES", "", "<nil>", "", ""},
			{"retest_token", "varchar(64)", "YES", "", "<nil>", "", ""},
			{"created_by", "varchar(64)", "YES", "", "<nil>", "", ""},
			{"created_at", "datetime", "YES", "", "<nil>", "", ""},
			{"updated_at", "datetime", "YES", "", "<nil>", "", ""},
		}), nil

	case strings.HasPrefix(query, "SHOW FULL COLUMNS FROM `users`"):
		return fullColRows([][7]string{
			{"id", "int", "NO", "PRI", "<nil>", "auto_increment", ""},
			{"username", "varchar(64)", "NO", "", "", "", ""},
			{"password_hash", "varchar(255)", "NO", "", "", "", ""},
			{"initial_password", "varchar(64)", "YES", "", "<nil>", "", ""},
			{"real_name", "varchar(64)", "YES", "", "<nil>", "", ""},
			{"role", "varchar(32)", "YES", "", "<nil>", "", ""},
			{"status", "tinyint", "NO", "", "1", "", ""},
			{"updated_at", "datetime", "YES", "", "<nil>", "", ""},
		}), nil

	case strings.HasPrefix(query, "SHOW FULL COLUMNS FROM `admin_users`"):
		return fullColRows([][7]string{
			{"id", "int", "NO", "PRI", "<nil>", "auto_increment", ""},
			{"username", "varchar(64)", "NO", "", "", "", ""},
			{"password_hash", "varchar(255)", "NO", "", "", "", ""},
			{"real_name", "varchar(64)", "YES", "", "<nil>", "", ""},
			{"role", "varchar(32)", "YES", "", "<nil>", "", ""},
			{"status", "tinyint", "NO", "", "1", "", ""},
		}), nil

	case strings.HasPrefix(query, "SHOW FULL COLUMNS FROM `class_batches`"):
		return fullColRows([][7]string{
			{"id", "int", "NO", "PRI", "<nil>", "auto_increment", ""},
			{"year", "int", "NO", "", "2026", "", ""},
			{"season", "varchar(16)", "NO", "", "秋", "", ""},
			{"grade", "varchar(32)", "NO", "", "", "", ""},
			{"tier", "varchar(16)", "NO", "", "", "", ""},
			{"subject", "varchar(32)", "NO", "", "", "", ""},
			{"class_name", "varchar(64)", "YES", "", "<nil>", "", ""},
		}), nil

	case strings.HasPrefix(query, "SHOW FULL COLUMNS FROM `qbank_weeks`"):
		return fullColRows([][7]string{
			{"id", "int", "NO", "PRI", "<nil>", "auto_increment", ""},
			{"bank_type", "varchar(16)", "NO", "", "homework", "", ""},
			{"year", "int", "NO", "", "2026", "", ""},
			{"season", "varchar(16)", "NO", "", "秋", "", ""},
			{"subject", "varchar(32)", "NO", "", "", "", ""},
			{"grade", "varchar(32)", "NO", "", "", "", ""},
			{"tier", "varchar(16)", "NO", "", "", "", ""},
			{"week", "int", "NO", "", "1", "", ""},
			{"updated_by", "varchar(50)", "YES", "", "<nil>", "", ""},
		}), nil

	case strings.HasPrefix(query, "SHOW FULL COLUMNS FROM `qbank_questions`"):
		return fullColRows([][7]string{
			{"id", "int", "NO", "PRI", "<nil>", "auto_increment", ""},
			{"qbank_id", "int", "NO", "", "0", "", ""},
			{"bank_type", "varchar(16)", "NO", "", "homework", "", ""},
			{"year", "int", "NO", "", "2026", "", ""},
			{"season", "varchar(16)", "NO", "", "秋", "", ""},
			{"subject", "varchar(32)", "NO", "", "", "", ""},
			{"grade", "varchar(32)", "NO", "", "", "", ""},
			{"tier", "varchar(16)", "NO", "", "", "", ""},
			{"week", "int", "NO", "", "1", "", ""},
			{"question_num", "int", "NO", "", "1", "", ""},
			{"topic", "varchar(255)", "YES", "", "<nil>", "", ""},
		}), nil

	case strings.Contains(query, "FROM `admin_users` WHERE `username` = ?"):
		return &mockAdminRows{
			cols: []string{"id", "username", "password_hash", "real_name", "role", "status"},
			rows: [][]driver.Value{{int64(1), "boss", "$2a$hash", "超级管理员", "super_admin", int64(1)}},
		}, nil

	case query == "SELECT COUNT(*) FROM `admin_users`":
		return &mockAdminRows{cols: []string{"cnt"}, rows: [][]driver.Value{{adminCnt}}}, nil

	case strings.Contains(query, "SELECT `id` FROM `users` WHERE `username` = ?"):
		return &mockAdminRows{cols: []string{"id"}}, nil

	case strings.Contains(query, "SELECT `id`, `username`, `real_name` FROM `users`"):
		return &mockAdminRows{
			cols: []string{"id", "username", "real_name"},
			rows: [][]driver.Value{{int64(7), resetUname, "李老师"}},
		}, nil

	case strings.Contains(query, "SELECT username FROM `users` WHERE `id` = ?"):
		return &mockAdminRows{cols: []string{"username"}, rows: [][]driver.Value{{resetUname}}}, nil

	case strings.Contains(query, "SELECT id, `year`, `season`, `grade`, `tier`, `subject`, `class_name` FROM `class_batches`"):
		return &mockAdminRows{
			cols: []string{"id", "year", "season", "grade", "tier", "subject", "class_name"},
			rows: [][]driver.Value{{int64(5), int64(2026), "秋", "七年级", "S+", "数学", ""}},
		}, nil

	case strings.HasPrefix(query, "SELECT DISTINCT"):
		return &mockAdminRows{cols: []string{"v"}, rows: [][]driver.Value{{"数学"}}}, nil

	case strings.Contains(query, "SELECT `username`, `real_name` FROM `users` WHERE `status` = 1"):
		return &mockAdminRows{cols: []string{"username", "real_name"}, rows: [][]driver.Value{{"t101", "张老师"}}}, nil

	case strings.Contains(query, "FROM `student_records` WHERE `batch_id` IN"):
		return &mockAdminRows{cols: []string{"cnt"}, rows: [][]driver.Value{{relatedCnt}}}, nil

	case strings.HasPrefix(query, "SELECT COUNT"):
		return &mockAdminRows{cols: []string{"cnt"}, rows: [][]driver.Value{{int64(1)}}}, nil

	case strings.HasPrefix(query, "SELECT `id`, `username`, '' AS `initial_password`"):
		return &mockAdminRows{
			cols: []string{"id", "username", "initial_password", "real_name", "role", "status", "last_login_at", "last_login_ip", "created_at", "updated_at"},
			rows: [][]driver.Value{{int64(7), "t101", "", "张老师", "teacher", int64(1), nil, nil, utcTS, utcTS}},
		}, nil

	case strings.Contains(query, "FROM `users` WHERE `role` = 'assistant'"):
		return &mockAdminRows{
			cols: []string{"id", "username", "real_name", "role", "status", "initial_password", "last_login_at", "last_login_ip", "created_at", "teacher_id", "created_by"},
			rows: [][]driver.Value{{int64(21), "t101_01", "小王", "assistant", int64(1), "", nil, nil, utcTS, int64(7), "t101"}},
		}, nil

	case query == "SELECT `id`, `username`, `real_name`, `role`, `teacher_id`, `created_by` FROM `users`":
		return &mockAdminRows{
			cols: []string{"id", "username", "real_name", "role", "teacher_id", "created_by"},
			rows: [][]driver.Value{{int64(7), "t101", "张老师", "teacher", int64(0), ""}},
		}, nil

	case strings.Contains(query, "SELECT `question_num`, `topic` FROM `qbank_questions`"):
		return &mockAdminRows{
			cols: []string{"question_num", "topic"},
			rows: [][]driver.Value{{int64(1), "一元一次方程，。"}},
		}, nil

	case strings.HasPrefix(query, "SELECT * FROM `student_records`") && !strings.Contains(query, "LIMIT 1"):
		return &mockAdminRows{
			cols:    []string{"id", "batch_id", "student_id", "student_name", "student_key", "week_num", "error_count", "error_questions", "preview_error_questions", "source_files", "retest_token", "created_by", "created_at", "updated_at"},
			dbTypes: []string{"INT", "INT", "VARCHAR", "VARCHAR", "VARCHAR", "INT", "INT", "TEXT", "TEXT", "TEXT", "VARCHAR", "VARCHAR", "DATETIME", "DATETIME"},
			rows: [][]driver.Value{
				{int64(12), int64(5), "20260001", "张三", "k1", int64(3), int64(1), "[1]", nil, "hw.csv", "tok123", "t101", utcTS, utcTS},
			},
		}, nil

	case strings.HasPrefix(query, "SELECT * FROM `student_records` WHERE"):
		if missingRec {
			return &mockAdminRows{cols: []string{"id"}}, nil
		}
		return &mockAdminRows{
			cols: []string{"id", "batch_id", "student_id", "student_name", "student_key", "week_num", "preview_week_num", "homework_score", "preview_score", "total_score", "error_count", "error_questions", "preview_error_questions", "teacher_comment", "preview_comment", "source_files", "retest_token", "created_at", "updated_at"},
			rows: [][]driver.Value{
				{int64(12), int64(5), "20260001", "张三", "k1", int64(3), nil, float64(90), nil, float64(90), int64(1), "[1]", nil, "不错", nil, "hw.csv", "tok123", "2026-11-21 10:00:00", "2026-11-21 11:00:00"},
			},
		}, nil

	case strings.HasPrefix(query, "SELECT * FROM `admin_users` WHERE"):
		return &mockAdminRows{
			cols: []string{"id", "username", "password_hash", "real_name", "role", "status"},
			rows: [][]driver.Value{{int64(1), "boss", "$2a$secret", "超级管理员", "super_admin", int64(1)}},
		}, nil

	case strings.HasPrefix(query, "SELECT * FROM `users` WHERE"):
		return &mockAdminRows{
			cols: []string{"id", "username", "password_hash", "real_name", "role", "status"},
			rows: [][]driver.Value{{int64(7), "t101", "$2a$secret", "张老师", "teacher", int64(1)}},
		}, nil

	case strings.HasPrefix(query, "SELECT grade, subject FROM class_batches WHERE id = ?"):
		return &mockAdminRows{cols: []string{"grade", "subject"}, rows: [][]driver.Value{{"七年级", "数学"}}}, nil

	case strings.HasPrefix(query, "SELECT student_id, student_name, batch_id FROM student_records"):
		return &mockAdminRows{cols: []string{"student_id", "student_name", "batch_id"}, rows: [][]driver.Value{{"20260001", "张三", int64(5)}}}, nil

	case strings.HasPrefix(query, "SELECT batch_code, created_by FROM `generation_batches`"):
		return &mockAdminRows{cols: []string{"batch_code", "created_by"}, rows: [][]driver.Value{{"B20261121_100000_ab12", "t101"}}}, nil

	case strings.Contains(query, "FROM `student_record_history` h"):
		return &mockAdminRows{
			cols: []string{"id", "record_id", "batch_id", "student_name", "error_questions", "preview_error_questions", "source_files", "class_name", "year", "season", "grade", "tier", "subject"},
			rows: [][]driver.Value{{int64(77), int64(12), int64(5), "张三", "[1,2]", nil, "hw.csv", "七年级S+数学", int64(2026), "秋", "七年级", "S+", "数学"}},
		}, nil

	case strings.HasPrefix(query, "SELECT * FROM `student_record_history` WHERE id = ?"):
		return &mockAdminRows{
			cols: []string{"id", "record_id", "batch_id", "student_id", "student_name", "student_key", "week_num", "preview_week_num", "homework_score", "preview_score", "total_score", "error_count", "error_questions", "preview_error_questions", "teacher_comment", "preview_comment", "source_files", "retest_token", "record_created_at", "record_updated_at"},
			rows: [][]driver.Value{{int64(77), int64(12), int64(5), "20260001", "张三", "", int64(3), nil, float64(85), nil, float64(85), int64(2), "[1,2]", nil, "加油", nil, "hw.csv", "tok123", "2026-11-20 09:00:00", "2026-11-20 10:00:00"}},
		}, nil

	case strings.HasPrefix(query, "SELECT `batch_code`, `student_name`, `record_created_at`"):
		return &mockAdminRows{
			cols: []string{"batch_code", "student_name", "record_created_at", "record_updated_at", "archived_at"},
			rows: [][]driver.Value{{"B20261121_100000_ab12", "张三", "2026-11-21 10:00:00", "2026-11-21 12:00:00", "2026-11-21 12:05:00"}},
		}, nil

	case strings.Contains(query, "FROM student_records sr"):
		return &mockAdminRows{
			cols: []string{"id", "student_name", "student_id", "student_key", "year", "season", "grade", "tier", "subject", "class_name", "week_num", "preview_week_num", "homework_score", "preview_score", "total_score", "error_count", "error_questions", "preview_error_questions", "teacher_comment", "preview_comment", "created_by", "batch_creator", "created_at", "updated_at", "retest_token"},
			rows: [][]driver.Value{{int64(12), "张三", "20260001", "k1", int64(2026), "秋", "七年级", "S+", "数学", "S+班", int64(3), nil, float64(90), nil, float64(90), int64(1), "[1]", nil, "不错", nil, "", "t101", "2026-11-21 10:00:00", "2026-11-21 11:00:00", "tok123"}},
		}, nil

	case strings.Contains(query, "FROM `retest_access_logs`"):
		return &mockAdminRows{
			cols: []string{"id", "student_name", "action", "details", "ip", "user_agent", "created_at"},
			rows: [][]driver.Value{{int64(1), "张三", "view", "", "127.0.0.1", "UA", utcTS}},
		}, nil

	case strings.Contains(query, "SELECT `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week` FROM `qbank_weeks`"):
		return &mockAdminRows{
			cols: []string{"bank_type", "year", "season", "subject", "grade", "tier", "week"},
			rows: [][]driver.Value{{"homework", int64(2026), "秋", "数学", "七年级", "S+", int64(3)}},
		}, nil

	case strings.Contains(query, "SELECT `id`, `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week` FROM `qbank_weeks`"):
		return &mockAdminRows{
			cols: []string{"id", "bank_type", "year", "season", "subject", "grade", "tier", "week"},
			rows: [][]driver.Value{{int64(9), "homework", int64(2026), "秋", "数学", "七年级", "S+", int64(3)}},
		}, nil

	case strings.Contains(query, "SELECT `qbank_id`, `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week` FROM `qbank_questions`"):
		return &mockAdminRows{
			cols: []string{"qbank_id", "bank_type", "year", "season", "subject", "grade", "tier", "week"},
			rows: [][]driver.Value{{int64(9), "homework", int64(2026), "秋", "数学", "七年级", "S+", int64(3)}},
		}, nil

	case strings.Contains(query, "SELECT `question_num`, `parent_question_num`, `parent_question_nums`, `sub_num`, `topic`"):
		return &mockAdminRows{
			cols: []string{"question_num", "parent_question_num", "parent_question_nums", "sub_num", "topic", "video_url", "question_meta", "exercise_pdf", "exercise_name", "answer_pdf", "answer_name"},
			rows: [][]driver.Value{{int64(1), nil, nil, int64(1), "一元一次方程", "", "", "data/pdfs/pdf_1.pdf", "1.pdf", "", ""}},
		}, nil

	default:
		return nil, fmt.Errorf("unexpected admin query: %s", query)
	}
}

type mockAdminTx struct {
	state *mockAdminDBState
}

func (t *mockAdminTx) Commit() error {
	t.state.mu.Lock()
	t.state.txCommitted++
	t.state.mu.Unlock()
	return nil
}

func (t *mockAdminTx) Rollback() error {
	t.state.mu.Lock()
	t.state.txRolledBack++
	t.state.mu.Unlock()
	return nil
}

type mockAdminResult struct {
	lastID   int64
	affected int64
}

func (r mockAdminResult) LastInsertId() (int64, error) { return r.lastID, nil }
func (r mockAdminResult) RowsAffected() (int64, error) { return r.affected, nil }

type mockAdminRows struct {
	cols    []string
	dbTypes []string
	rows    [][]driver.Value
	idx     int
}

func (r *mockAdminRows) Columns() []string { return r.cols }
func (r *mockAdminRows) Close() error      { return nil }
func (r *mockAdminRows) Next(dest []driver.Value) error {
	if r.idx >= len(r.rows) {
		return io.EOF
	}
	copy(dest, r.rows[r.idx])
	r.idx++
	return nil
}
func (r *mockAdminRows) ColumnTypeDatabaseTypeName(index int) string {
	if index < len(r.dbTypes) {
		return r.dbTypes[index]
	}
	return ""
}

func openMockAdminDB(t *testing.T, st *mockAdminDBState) *sql.DB {
	t.Helper()
	dsn := t.Name()
	mockAdminDBMu.Lock()
	mockAdminDBRegistry[dsn] = st
	mockAdminDBMu.Unlock()
	t.Cleanup(func() {
		mockAdminDBMu.Lock()
		delete(mockAdminDBRegistry, dsn)
		mockAdminDBMu.Unlock()
	})
	db, err := sql.Open("mock_admin_mysql", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestMySQLRepositoryAuthTablesAndStats(t *testing.T) {
	st := &mockAdminDBState{}
	repo := NewMySQLRepository(openMockAdminDB(t, st))
	ctx := context.Background()

	u, err := repo.FindAdminByUsername(ctx, "boss")
	if err != nil || u == nil || u.Role != "super_admin" {
		t.Fatalf("FindAdminByUsername: u=%+v err=%v", u, err)
	}
	if err := repo.UpdateAdminPasswordHash(ctx, 1, "$2a$new"); err != nil {
		t.Fatalf("UpdateAdminPasswordHash: %v", err)
	}
	if err := repo.UpsertFallbackAdmin(ctx, "admin", "$2a$fb"); err != nil {
		t.Fatalf("UpsertFallbackAdmin: %v", err)
	}
	if err := repo.UpdateAdminLastLogin(ctx, "boss", "127.0.0.1"); err != nil {
		t.Fatalf("UpdateAdminLastLogin: %v", err)
	}

	tables, err := repo.ListTables(ctx)
	if err != nil {
		t.Fatalf("ListTables: %v", err)
	}
	for _, tb := range tables {
		if tb.Name == "app_sessions" {
			t.Fatalf("hidden table app_sessions leaked in ListTables: %+v", tables)
		}
	}
	if len(tables) != 2 || tables[0].UpdateTime == nil || *tables[0].UpdateTime != "2026-11-22 00:05:30" {
		t.Fatalf("unexpected ListTables rows (expected Shanghai timestamp): %+v", tables)
	}

	if _, _, err := repo.GetTableSchema(ctx, "app_sessions"); err == nil {
		t.Fatal("expected 403 for hidden table schema")
	} else if he, ok := err.(*HTTPError); !ok || he.Status != 403 {
		t.Fatalf("expected HTTPError 403, got %v", err)
	}

	opts, err := repo.ListBatchOptions(ctx)
	if err != nil || len(opts) != 1 || opts[0].Label != "#5 2026秋 七年级S+ 数学" {
		t.Fatalf("ListBatchOptions: %+v err=%v", opts, err)
	}
	fo, err := repo.GetFilterOptions(ctx)
	if err != nil || len(fo.Grades) != 1 || len(fo.Teachers) != 1 {
		t.Fatalf("GetFilterOptions: %+v err=%v", fo, err)
	}
	stats, err := repo.GetStudentRecordsStats(ctx)
	if err != nil || stats.Total != 1 {
		t.Fatalf("GetStudentRecordsStats: %+v err=%v", stats, err)
	}
}

func TestMySQLRepositoryListGetCreateUpdateDeleteAndReset(t *testing.T) {
	st := &mockAdminDBState{relatedStudentCount: 3}
	repo := NewMySQLRepository(openMockAdminDB(t, st))
	ctx := context.Background()

	// ListRecords with "inf" search must not add numeric equality (`= ?`) conditions.
	res, err := repo.ListRecords(ctx, ListQuery{Table: "student_records", Search: "inf"})
	if err != nil {
		t.Fatalf("ListRecords(student_records): %v", err)
	}
	if len(res.Rows) != 1 || res.Rows[0]["weak_points_text"] != "一元一次方程" {
		t.Fatalf("unexpected ListRecords rows: %+v", res.Rows)
	}
	for _, q := range st.queries {
		if strings.Contains(q.query, "FROM `student_records` WHERE") && strings.Contains(q.query, "`id` = ?") {
			t.Fatalf("search=\"inf\" must not emit numeric equality query: %s", q.query)
		}
	}

	// ListRecords on users enriches assistants.
	uRes, err := repo.ListRecords(ctx, ListQuery{Table: "users", Sort: "assistant_count", Order: "desc"})
	if err != nil || len(uRes.Rows) != 1 || uRes.Rows[0]["assistant_count"] != 1 {
		t.Fatalf("ListRecords(users): %+v err=%v", uRes, err)
	}

	// GetRecord redacts admin_users/users password_hash and attaches assistants.
	admRow, err := repo.GetRecord(ctx, "admin_users", "1")
	if err != nil || admRow["password_hash"] != "" || admRow["password"] != "" {
		t.Fatalf("GetRecord(admin_users) did not redact password: %+v err=%v", admRow, err)
	}
	usrRow, err := repo.GetRecord(ctx, "users", "7")
	if err != nil || usrRow["password_hash"] != "" || usrRow["assistant_count"] != 1 {
		t.Fatalf("GetRecord(users): %+v err=%v", usrRow, err)
	}

	// CreateRecord requires non-empty retestSecret when retest_token == "auto".
	_, err = repo.CreateRecord(ctx, "student_records", map[string]any{
		"batch_id":     json.Number("5"),
		"student_id":   json.Number("20260001"),
		"student_name": "张三",
		"week_num":     json.Number("3"),
		"retest_token": "auto",
	}, "")
	if he, ok := err.(*HTTPError); !ok || he.Status != 500 {
		t.Fatalf("expected HTTP 500 when retestSecret is empty, got %v", err)
	}

	// CreateRecord converts json.Number cleanly and preserves nil error_questions.
	prevExecs := len(st.execs)
	newID, err := repo.CreateRecord(ctx, "student_records", map[string]any{
		"batch_id":        json.Number("5"),
		"student_id":      json.Number("20260001"),
		"student_name":    "张三",
		"week_num":        json.Number("3"),
		"error_questions": nil,
		"retest_token":    "auto",
	}, "secret_2026")
	if err != nil || newID != 505 {
		t.Fatalf("CreateRecord(student_records): id=%d err=%v", newID, err)
	}
	if len(st.execs) <= prevExecs {
		t.Fatal("expected INSERT exec")
	}
	lastInsert := st.execs[len(st.execs)-1]
	wantKey := retestkeys.BuildStudentKey("20260001", "张三", "七年级", "数学")
	foundStudentKey := false
	for _, a := range lastInsert.args {
		if _, isNum := a.(json.Number); isNum {
			t.Fatalf("json.Number must be converted before SQL exec: %#v", lastInsert.args)
		}
		if a == wantKey {
			foundStudentKey = true
		}
	}
	if !foundStudentKey {
		t.Fatalf("expected derived student_key %q in INSERT args: %+v", wantKey, lastInsert.args)
	}

	// CreateRecord >72-byte password returns HTTP 400.
	_, err = repo.CreateRecord(ctx, "users", map[string]any{
		"username": "t202",
		"password": strings.Repeat("a", 73),
	}, "")
	if he, ok := err.(*HTTPError); !ok || he.Status != 400 {
		t.Fatalf("expected HTTP 400 for >72 byte password on CreateRecord, got %v", err)
	}

	// UpdateRecord archives history, ignores nil updated_at -> NOW(), and >72 byte password -> 400.
	_, errFields, err := repo.UpdateRecord(ctx, "student_records", "12", map[string]any{
		"student_name":    "张三丰",
		"error_questions": nil,
		"updated_at":      nil,
	}, "boss")
	if err != nil || len(errFields) != 4 {
		t.Fatalf("UpdateRecord(student_records): fields=%v err=%v", errFields, err)
	}
	updExec := st.execs[len(st.execs)-1]
	if !strings.Contains(updExec.query, "`updated_at` = NOW()") {
		t.Fatalf("expected updated_at: nil to map to NOW(), got SQL: %s", updExec.query)
	}

	_, _, err = repo.UpdateRecord(ctx, "users", "7", map[string]any{
		"password": strings.Repeat("b", 73),
	}, "boss")
	if he, ok := err.(*HTTPError); !ok || he.Status != 400 {
		t.Fatalf("expected HTTP 400 for >72 byte password on UpdateRecord, got %v", err)
	}

	// ResetTeacherPassword >72-byte returns 400, normal succeeds.
	if _, err := repo.ResetTeacherPassword(ctx, 7, "", strings.Repeat("c", 73)); err == nil {
		t.Fatal("expected HTTP 400 for >72 byte password on ResetTeacherPassword")
	} else if he, ok := err.(*HTTPError); !ok || he.Status != 400 {
		t.Fatalf("expected HTTP 400, got %v", err)
	}
	rRes, err := repo.ResetTeacherPassword(ctx, 7, "", "ValidPass123")
	if err != nil || rRes.Username != "t101" {
		t.Fatalf("ResetTeacherPassword: %+v err=%v", rRes, err)
	}

	// DeleteRecords class_batches requires forceCascade when related records exist.
	_, err = repo.DeleteRecords(ctx, "class_batches", []string{"5"}, "boss", false)
	if he, ok := err.(*HTTPError); !ok || he.Status != 409 {
		t.Fatalf("expected HTTP 409 cascade guard, got %v", err)
	}
	if n, err := repo.DeleteRecords(ctx, "class_batches", []string{"5"}, "boss", true); err != nil || n != 1 {
		t.Fatalf("DeleteRecords(class_batches, force): n=%d err=%v", n, err)
	}

	// DeleteRecords qbank_weeks runs inside tx and rolls back on error.
	if n, err := repo.DeleteRecords(ctx, "qbank_weeks", []string{"9"}, "boss", false); err != nil || n != 1 {
		t.Fatalf("DeleteRecords(qbank_weeks): n=%d err=%v", n, err)
	}
	if st.txCommitted != 2 {
		t.Fatalf("expected txCommitted=2, got %d", st.txCommitted)
	}
	st.failQBankWeeksDelete = true
	prevRB := st.txRolledBack
	if _, err := repo.DeleteRecords(ctx, "qbank_weeks", []string{"9"}, "boss", false); err == nil {
		t.Fatal("expected DeleteRecords(qbank_weeks) failure")
	}
	if st.txRolledBack <= prevRB {
		t.Fatalf("expected tx rollback on qbank_weeks delete failure")
	}
}

func TestMySQLRepositoryHistoryRollbackTokenAndSourceMeta(t *testing.T) {
	st := &mockAdminDBState{}
	repo := NewMySQLRepository(openMockAdminDB(t, st))
	ctx := context.Background()

	hist, err := repo.ListRecordHistory(ctx, 12, "", 0, nil)
	if err != nil || len(hist) != 1 {
		t.Fatalf("ListRecordHistory: %+v err=%v", hist, err)
	}

	rb, err := repo.RollbackRecord(ctx, 77, "boss")
	if err != nil || rb.TargetRecordID != 12 || rb.HistoryID != 77 {
		t.Fatalf("RollbackRecord: %+v err=%v", rb, err)
	}
	if st.txCommitted != 1 {
		t.Fatalf("expected txCommitted=1, got %d", st.txCommitted)
	}

	st.failRollbackUpdate = true
	prevRB := st.txRolledBack
	if _, err := repo.RollbackRecord(ctx, 77, "boss"); err == nil {
		t.Fatal("expected RollbackRecord failure")
	}
	if st.txRolledBack <= prevRB {
		t.Fatal("expected tx rollback on RollbackRecord failure")
	}

	tokRes, err := repo.SearchByToken(ctx, "tok123", "secret_2026")
	if err != nil || len(tokRes.Matches) != 1 || len(tokRes.AccessLogs) != 1 {
		t.Fatalf("SearchByToken: %+v err=%v", tokRes, err)
	}
	if logTS, _ := tokRes.AccessLogs[0]["created_at"].(string); logTS != "2026-11-22 00:05:30" {
		t.Fatalf("expected Shanghai formatted log timestamp, got %#v", tokRes.AccessLogs[0]["created_at"])
	}

	meta, err := repo.LookupSourceFileMeta(ctx, 12, 77, "")
	if err != nil || meta.BatchCode != "B20261121_100000_ab12" || len(meta.RefTimestamps) != 4 {
		t.Fatalf("LookupSourceFileMeta: %+v err=%v", meta, err)
	}
}

func TestMySQLRepositoryAttestationGuardsAndAdminAudit(t *testing.T) {
	if !IsHiddenTable("qbank_attestation_keys") {
		t.Fatal("expected qbank_attestation_keys to be in HiddenTables")
	}
	if FriendlyTableNames["qbank_revisions"] != "题库存证版本台账" || FriendlyTableNames["qbank_attempt_logs"] != "题库过程取证日志" {
		t.Fatalf("unexpected FriendlyTableNames for attestation tables: %+v", FriendlyTableNames)
	}

	st := &mockAdminDBState{}
	signer, err := qbankattest.NewEphemeralSigner("jf-qb-adm-crud")
	if err != nil {
		t.Fatal(err)
	}
	attestStore := qbankattest.NewMemoryStore(signer, "")
	repo := NewMySQLRepositoryWithAttest(openMockAdminDB(t, st), attestStore)
	ctx := context.Background()

	// 1. qbank_attestation_keys is blocked from schema & list
	if _, _, err := repo.GetTableSchema(ctx, "qbank_attestation_keys"); err == nil {
		t.Fatal("expected 403 for qbank_attestation_keys schema")
	} else if he, ok := err.(*HTTPError); !ok || he.Status != 403 {
		t.Fatalf("expected 403, got %v", err)
	}

	// 2. qbank_revisions & qbank_attempt_logs forbid Create/Update/Delete with HTTP 403
	for _, tbl := range []string{"qbank_revisions", "qbank_attempt_logs"} {
		if _, err := repo.CreateRecord(ctx, tbl, map[string]any{"action": "fake"}, ""); err == nil {
			t.Fatalf("expected 403 CreateRecord on %s", tbl)
		} else if he, ok := err.(*HTTPError); !ok || he.Status != 403 || he.Message != immutableAttestationErrMsg {
			t.Fatalf("CreateRecord(%s) unexpected error: %v", tbl, err)
		}
		if _, _, err := repo.UpdateRecord(ctx, tbl, "1", map[string]any{"action": "fake"}, "boss"); err == nil {
			t.Fatalf("expected 403 UpdateRecord on %s", tbl)
		} else if he, ok := err.(*HTTPError); !ok || he.Status != 403 || he.Message != immutableAttestationErrMsg {
			t.Fatalf("UpdateRecord(%s) unexpected error: %v", tbl, err)
		}
		if _, err := repo.DeleteRecords(ctx, tbl, []string{"1"}, "boss", false); err == nil {
			t.Fatalf("expected 403 DeleteRecords on %s", tbl)
		} else if he, ok := err.(*HTTPError); !ok || he.Status != 403 || he.Message != immutableAttestationErrMsg {
			t.Fatalf("DeleteRecords(%s) unexpected error: %v", tbl, err)
		}
	}

	// 3. Updating qbank_weeks, updating qbank_questions, deleting qbank_questions, deleting qbank_weeks all append immutable revisions
	if _, _, err := repo.UpdateRecord(ctx, "qbank_weeks", "9", map[string]any{"updated_by": "t102"}, "boss"); err != nil {
		t.Fatalf("UpdateRecord(qbank_weeks): %v", err)
	}
	if _, _, err := repo.UpdateRecord(ctx, "qbank_questions", "55", map[string]any{"topic": "二次根式"}, "boss"); err != nil {
		t.Fatalf("UpdateRecord(qbank_questions): %v", err)
	}
	if _, err := repo.DeleteRecords(ctx, "qbank_questions", []string{"55"}, "boss", false); err != nil {
		t.Fatalf("DeleteRecords(qbank_questions): %v", err)
	}
	if _, err := repo.DeleteRecords(ctx, "qbank_weeks", []string{"9"}, "boss", false); err != nil {
		t.Fatalf("DeleteRecords(qbank_weeks): %v", err)
	}

	revs, err := attestStore.ListRevisions(ctx, qbankattest.RevisionFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(revs) != 4 {
		t.Fatalf("expected 4 admin audit revisions (3 admin_edit + 1 admin_delete), got %d: %+v", len(revs), revs)
	}
	// ListRevisions returns newest-first: [0]=admin_delete, [1..3]=admin_edit
	if revs[0].Action != qbankattest.ActionAdminDelete || revs[0].Operator != "boss" {
		t.Fatalf("expected newest revision to be admin_delete by boss, got %+v", revs[0])
	}
	for i := 1; i < 4; i++ {
		if revs[i].Action != qbankattest.ActionAdminEdit || revs[i].Operator != "boss" {
			t.Fatalf("expected revision %d to be admin_edit by boss, got %+v", i, revs[i])
		}
	}
}
