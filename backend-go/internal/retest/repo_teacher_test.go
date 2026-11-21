package retest

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

type mockExecCall struct {
	query string
	args  []any
}

type mockRetestDBState struct {
	mu               sync.Mutex
	batchID          int64
	batchClassName   string
	batchCreator     string
	genBatchCode     string
	genCreatedBy     string
	genCreatedAt     time.Time
	teacherRealName  string
	studentRows      [][]driver.Value
	archiveRows      [][]driver.Value
	fallbackCount    int64
	fallbackRows     [][]driver.Value
	queries          []string
	execs            []mockExecCall
	committed        bool
	rolledBack       bool
}

var (
	mockRetestMu       sync.Mutex
	mockRetestRegistry = map[string]*mockRetestDBState{}
)

func init() {
	sql.Register("mock_retest_mysql", &mockRetestDriver{})
}

type mockRetestDriver struct{}

func (d *mockRetestDriver) Open(name string) (driver.Conn, error) {
	mockRetestMu.Lock()
	st := mockRetestRegistry[name]
	mockRetestMu.Unlock()
	if st == nil {
		return nil, fmt.Errorf("unknown mock retest dsn %q", name)
	}
	return &mockRetestConn{state: st}, nil
}

type mockRetestConn struct {
	state *mockRetestDBState
}

func (c *mockRetestConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (c *mockRetestConn) Close() error                        { return nil }
func (c *mockRetestConn) Begin() (driver.Tx, error)           { return &mockRetestTx{state: c.state}, nil }
func (c *mockRetestConn) BeginTx(_ context.Context, _ driver.TxOptions) (driver.Tx, error) {
	return &mockRetestTx{state: c.state}, nil
}

type mockRetestTx struct {
	state *mockRetestDBState
}

func (tx *mockRetestTx) Commit() error {
	tx.state.mu.Lock()
	tx.state.committed = true
	tx.state.mu.Unlock()
	return nil
}

func (tx *mockRetestTx) Rollback() error {
	tx.state.mu.Lock()
	tx.state.rolledBack = true
	tx.state.mu.Unlock()
	return nil
}

func (c *mockRetestConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	c.state.mu.Lock()
	defer c.state.mu.Unlock()
	c.state.queries = append(c.state.queries, query)

	switch {
	case strings.Contains(query, "FROM class_batches"):
		if c.state.batchID == 0 {
			return &mockRetestRows{cols: []string{"id", "class_name", "created_by"}}, nil
		}
		if strings.Contains(query, "class_name") {
			return &mockRetestRows{
				cols: []string{"id", "class_name", "created_by"},
				data: [][]driver.Value{{c.state.batchID, c.state.batchClassName, c.state.batchCreator}},
			}, nil
		}
		return &mockRetestRows{
			cols: []string{"id", "created_by"},
			data: [][]driver.Value{{c.state.batchID, c.state.batchCreator}},
		}, nil

	case strings.Contains(query, "FROM `generation_batches`"):
		if c.state.genBatchCode == "" {
			return &mockRetestRows{cols: []string{"created_by", "created_at"}}, nil
		}
		if strings.Contains(query, "student_count") {
			return &mockRetestRows{
				cols: []string{"id", "batch_code", "created_by", "student_count", "created_at"},
				data: [][]driver.Value{{int64(100), c.state.genBatchCode, c.state.genCreatedBy, int64(20), c.state.genCreatedAt}},
			}, nil
		}
		return &mockRetestRows{
			cols: []string{"created_by", "created_at"},
			data: [][]driver.Value{{c.state.genCreatedBy, c.state.genCreatedAt}},
		}, nil

	case strings.Contains(query, "FROM users"):
		if c.state.teacherRealName == "" {
			return &mockRetestRows{cols: []string{"real_name"}}, nil
		}
		return &mockRetestRows{
			cols: []string{"real_name"},
			data: [][]driver.Value{{c.state.teacherRealName}},
		}, nil

	case strings.Contains(query, "SELECT COUNT(*) FROM `student_records`"):
		return &mockRetestRows{
			cols: []string{"cnt"},
			data: [][]driver.Value{{c.state.fallbackCount}},
		}, nil

	case strings.Contains(query, "SELECT id, batch_id, student_id"):
		return &mockRetestRows{
			cols: []string{
				"id", "batch_id", "student_id", "student_name", "student_key", "week_num",
				"preview_week_num", "homework_score", "preview_score", "total_score", "error_count",
				"error_questions", "preview_error_questions", "teacher_comment", "preview_comment",
				"source_files", "retest_token", "created_at", "updated_at",
			},
			data: c.state.archiveRows,
		}, nil

	case strings.Contains(query, "teacher_comment") && strings.Contains(query, "FROM `student_records`"):
		return &mockRetestRows{
			cols: []string{
				"student_name", "student_id", "student_key", "homework_score",
				"error_count", "error_questions", "teacher_comment", "updated_at", "created_by",
			},
			data: c.state.studentRows,
		}, nil

	case strings.Contains(query, "FROM `student_records`"):
		return &mockRetestRows{
			cols: []string{"student_name", "student_id", "student_key", "homework_score", "error_count", "error_questions"},
			data: c.state.fallbackRows,
		}, nil
	}

	return nil, fmt.Errorf("unexpected query in mock_retest_mysql: %s", query)
}

func (c *mockRetestConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	c.state.mu.Lock()
	defer c.state.mu.Unlock()
	copied := make([]any, len(args))
	for i, a := range args {
		copied[i] = a.Value
	}
	c.state.execs = append(c.state.execs, mockExecCall{query: query, args: copied})
	return driver.RowsAffected(1), nil
}

type mockRetestRows struct {
	cols []string
	data [][]driver.Value
	idx  int
}

func (r *mockRetestRows) Columns() []string { return r.cols }
func (r *mockRetestRows) Close() error      { return nil }
func (r *mockRetestRows) Next(dest []driver.Value) error {
	if r.idx >= len(r.data) {
		return io.EOF
	}
	copy(dest, r.data[r.idx])
	r.idx++
	return nil
}

func openMockRetestDB(t *testing.T, st *mockRetestDBState) *sql.DB {
	t.Helper()
	dsn := t.Name()
	mockRetestMu.Lock()
	mockRetestRegistry[dsn] = st
	mockRetestMu.Unlock()
	t.Cleanup(func() {
		mockRetestMu.Lock()
		delete(mockRetestRegistry, dsn)
		mockRetestMu.Unlock()
	})
	db, err := sql.Open("mock_retest_mysql", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestEncryptBatchArchivesTimeValuesAsTimeNotRFC3339String(t *testing.T) {
	shanghai := time.FixedZone("CST", 8*3600)
	prevGenAt := time.Date(2026, 11, 14, 20, 10, 8, 0, shanghai)
	recCreated := time.Date(2026, 11, 14, 20, 10, 8, 0, shanghai)
	recUpdated := time.Date(2026, 11, 14, 20, 15, 30, 0, shanghai)

	state := &mockRetestDBState{
		batchID:      31,
		batchCreator: "JF036",
		genBatchCode: "B20261114_201008_abcd",
		genCreatedBy: "JF036",
		genCreatedAt: prevGenAt,
		archiveRows: [][]driver.Value{
			{
				int64(373509), int64(31), "24356", "孙明泽", "24356_孙明泽_九年级_数学", int64(10),
				int64(10), nil, 90.0, 100.0, int64(0),
				"[]", "[2]", "", "pre comment",
				`["A1课前预习专题十.csv"]`, "tok1234567", recCreated, recUpdated,
			},
		},
	}

	repo := NewMySQLRepository(openMockRetestDB(t, state))
	hwScore := 92.0
	totScore := 100.0
	res, err := repo.EncryptBatch(context.Background(), EncryptBatchInput{
		Subject:        "数学",
		Grade:          "九年级",
		Tier:           "A",
		Week:           10,
		PreviewWeek:    11,
		HasPreviewData: true,
		HasHomeworkData: true,
		Year:           2026,
		Season:         "秋",
		CurrentTeacher: "JF036",
		Students: []EncryptStudentInput{
			{
				ID:            "24356",
				Name:          "孙明泽",
				Errors:        []int{3},
				HomeworkScore: &hwScore,
				TotalScore:    &totScore,
				Comment:       "错题: 3",
			},
		},
		SecretKey: "test_secret_key",
	})
	if err != nil {
		t.Fatalf("EncryptBatch returned error: %v", err)
	}
	if res.IsDebounced {
		t.Fatal("expected IsDebounced=false for 7-day-old generation batch")
	}

	state.mu.Lock()
	defer state.mu.Unlock()
	if !state.committed || state.rolledBack {
		t.Fatalf("expected commit without rollback; committed=%v rolledBack=%v", state.committed, state.rolledBack)
	}

	var histExec *mockExecCall
	for i := range state.execs {
		if strings.Contains(state.execs[i].query, "INSERT INTO student_record_history") {
			histExec = &state.execs[i]
			break
		}
	}
	if histExec == nil {
		t.Fatalf("expected INSERT INTO student_record_history exec, got: %+v", state.execs)
	}
	if len(histExec.args) != 23 {
		t.Fatalf("expected 23 bound args for history insert, got %d", len(histExec.args))
	}

	gotCreated, ok1 := histExec.args[21].(time.Time)
	gotUpdated, ok2 := histExec.args[22].(time.Time)
	if !ok1 || !ok2 {
		t.Fatalf("expected time.Time args for record_created_at & record_updated_at (not RFC3339 strings), got %T (%v) and %T (%v)",
			histExec.args[21], histExec.args[21], histExec.args[22], histExec.args[22])
	}
	if !gotCreated.Equal(recCreated) {
		t.Fatalf("record_created_at = %v, want %v", gotCreated, recCreated)
	}
	if !gotUpdated.Equal(recUpdated) {
		t.Fatalf("record_updated_at = %v, want %v", gotUpdated, recUpdated)
	}
}

func TestCheckExistingBatchSkipsPreviewOnlyAndNullScore(t *testing.T) {
	shanghai := time.FixedZone("CST", 8*3600)
	ts := time.Date(2026, 11, 14, 20, 10, 8, 0, shanghai)

	t.Run("skips preview-only row with NULL homework_score", func(t *testing.T) {
		state := &mockRetestDBState{
			batchID:         31,
			batchClassName:  "26秋_九年级_A_数学",
			batchCreator:    "JF036",
			genBatchCode:    "B20261114_201008_abcd",
			genCreatedBy:    "JF036",
			genCreatedAt:    ts,
			teacherRealName: "刘老师",
			studentRows: [][]driver.Value{
				{"孙明泽", "24356", "24356_孙明泽_九年级_数学", nil, int64(0), "[]", "", ts, "JF036"},
			},
		}
		repo := NewMySQLRepository(openMockRetestDB(t, state))
		res, err := repo.CheckExistingBatch(context.Background(), CheckBatchInput{
			Subject:         "数学",
			Grade:           "九年级",
			Tier:            "A",
			Week:            10,
			Year:            2026,
			Season:          "autumn",
			HasIncomingList: true,
			IncomingStudents: []CheckBatchStudent{
				{ID: "24356", Name: "孙明泽", Score: 95, Errors: []int{3}},
			},
		})
		if err != nil {
			t.Fatalf("CheckExistingBatch error: %v", err)
		}
		if res.Exists || res.HasDiff || len(res.ModifiedStudents) != 0 {
			t.Fatalf("preview-only row should be ignored, got Exists=%v HasDiff=%v Modified=%+v", res.Exists, res.HasDiff, res.ModifiedStudents)
		}
	})

	t.Run("detects real 0-score homework diff", func(t *testing.T) {
		state := &mockRetestDBState{
			batchID:         31,
			batchClassName:  "26秋_九年级_A_数学",
			batchCreator:    "JF036",
			genBatchCode:    "B20261114_201008_abcd",
			genCreatedBy:    "JF036",
			genCreatedAt:    ts,
			teacherRealName: "刘老师",
			studentRows: [][]driver.Value{
				{"孙明泽", "24356", "24356_孙明泽_九年级_数学", 0.0, int64(0), "[]", "", ts, "JF036"},
			},
		}
		repo := NewMySQLRepository(openMockRetestDB(t, state))
		res, err := repo.CheckExistingBatch(context.Background(), CheckBatchInput{
			Subject:         "数学",
			Grade:           "九年级",
			Tier:            "A",
			Week:            10,
			Year:            2026,
			Season:          "autumn",
			HasIncomingList: true,
			IncomingStudents: []CheckBatchStudent{
				{ID: "24356", Name: "孙明泽", Score: 95, Errors: []int{}},
			},
		})
		if err != nil {
			t.Fatalf("CheckExistingBatch error: %v", err)
		}
		if !res.Exists || !res.HasDiff || len(res.ModifiedStudents) != 1 {
			t.Fatalf("expected 1 modified student for real 0 score, got Exists=%v HasDiff=%v Modified=%+v", res.Exists, res.HasDiff, res.ModifiedStudents)
		}
		mod := res.ModifiedStudents[0]
		if mod["scoreChanged"] != true || mod["oldScore"] != 0 || mod["newScore"] != 95 {
			t.Fatalf("unexpected diff payload: %+v", mod)
		}
	})

	t.Run("single-error-entry row with NULL score compares errors only", func(t *testing.T) {
		stateSame := &mockRetestDBState{
			batchID:         31,
			batchClassName:  "26秋_九年级_A_数学",
			batchCreator:    "JF036",
			genBatchCode:    "B20261114_201008_abcd",
			genCreatedBy:    "JF036",
			genCreatedAt:    ts,
			teacherRealName: "刘老师",
			studentRows: [][]driver.Value{
				{"孙明泽", "24356", "24356_孙明泽_九年级_数学", nil, int64(2), "[1,3]", "", ts, "JF036"},
			},
		}
		repoSame := NewMySQLRepository(openMockRetestDB(t, stateSame))
		resSame, err := repoSame.CheckExistingBatch(context.Background(), CheckBatchInput{
			Subject:         "数学",
			Grade:           "九年级",
			Tier:            "A",
			Week:            10,
			Year:            2026,
			Season:          "autumn",
			HasIncomingList: true,
			IncomingStudents: []CheckBatchStudent{
				{ID: "24356", Name: "孙明泽", Score: 85, Errors: []int{1, 3}},
			},
		})
		if err != nil {
			t.Fatalf("CheckExistingBatch error: %v", err)
		}
		if !resSame.Exists || resSame.HasDiff {
			t.Fatalf("expected Exists=true HasDiff=false when errors match and old score is NULL, got %+v", resSame)
		}

		resDiff, err := repoSame.CheckExistingBatch(context.Background(), CheckBatchInput{
			Subject:         "数学",
			Grade:           "九年级",
			Tier:            "A",
			Week:            10,
			Year:            2026,
			Season:          "autumn",
			HasIncomingList: true,
			IncomingStudents: []CheckBatchStudent{
				{ID: "24356", Name: "孙明泽", Score: 85, Errors: []int{1, 4}},
			},
		})
		if err != nil {
			t.Fatalf("CheckExistingBatch error: %v", err)
		}
		if !resDiff.HasDiff || len(resDiff.ModifiedStudents) != 1 {
			t.Fatalf("expected errors diff when errors differ, got %+v", resDiff)
		}
		mod := resDiff.ModifiedStudents[0]
		if mod["scoreChanged"] != false || mod["errorsChanged"] != true || mod["oldScore"] != nil {
			t.Fatalf("expected scoreChanged=false, errorsChanged=true, oldScore=nil, got %+v", mod)
		}
	})

	t.Run("fallback query without incomingStudents filters preview-only rows", func(t *testing.T) {
		state := &mockRetestDBState{
			batchID:         31,
			batchClassName:  "26秋_九年级_A_数学",
			batchCreator:    "JF036",
			genBatchCode:    "B20261114_201008_abcd",
			genCreatedBy:    "JF036",
			genCreatedAt:    ts,
			teacherRealName: "刘老师",
			fallbackCount:   0,
		}
		repo := NewMySQLRepository(openMockRetestDB(t, state))
		res, err := repo.CheckExistingBatch(context.Background(), CheckBatchInput{
			Subject:         "数学",
			Grade:           "九年级",
			Tier:            "A",
			Week:            10,
			Year:            2026,
			Season:          "autumn",
			HasIncomingList: false,
		})
		if err != nil {
			t.Fatalf("CheckExistingBatch fallback error: %v", err)
		}
		if res.Exists {
			t.Fatalf("expected Exists=false when fallback count=0, got %+v", res)
		}
		state.mu.Lock()
		defer state.mu.Unlock()
		foundFilter := false
		for _, q := range state.queries {
			if strings.Contains(q, "SELECT COUNT(*) FROM `student_records`") && strings.Contains(q, "`homework_score` IS NOT NULL") {
				foundFilter = true
			}
		}
		if !foundFilter {
			t.Fatalf("expected fallback query to filter preview-only rows, queries=%+v", state.queries)
		}
	})
}
