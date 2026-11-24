package qbank

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"github.com/go-sql-driver/mysql"
)

type mockQBankSQLRecord struct {
	query string
	args  []any
}

type mockQBankDBState struct {
	mu               sync.Mutex
	queries          []mockQBankSQLRecord
	execs            []mockQBankSQLRecord
	txBegun          int
	txCommitted      int
	txRolledBack     int
	failDeleteWeeks  bool
	deadlockCount    int
	yearFallbackOnly bool
	weekDetailNil    bool
	bankType         string
	updatedAtUTC     time.Time
	variationRows    [][]driver.Value
	oldWeekPDFRows   [][]driver.Value
	refCounts        map[string]int64
}

var (
	mockQBankDBMu       sync.Mutex
	mockQBankDBRegistry = make(map[string]*mockQBankDBState)
)

func init() {
	sql.Register("mock_qbank_mysql", &mockQBankDriver{})
}

type mockQBankDriver struct{}

func (d *mockQBankDriver) Open(name string) (driver.Conn, error) {
	mockQBankDBMu.Lock()
	st := mockQBankDBRegistry[name]
	mockQBankDBMu.Unlock()
	if st == nil {
		return nil, fmt.Errorf("unknown mock dsn %q", name)
	}
	return &mockQBankConn{state: st}, nil
}

type mockQBankConn struct {
	state *mockQBankDBState
}

func (c *mockQBankConn) Prepare(query string) (driver.Stmt, error) {
	return &mockQBankStmt{state: c.state, query: query}, nil
}

func (c *mockQBankConn) PrepareContext(_ context.Context, query string) (driver.Stmt, error) {
	return &mockQBankStmt{state: c.state, query: query}, nil
}

func (c *mockQBankConn) Close() error { return nil }

func (c *mockQBankConn) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}

func (c *mockQBankConn) BeginTx(_ context.Context, _ driver.TxOptions) (driver.Tx, error) {
	c.state.mu.Lock()
	c.state.txBegun++
	c.state.mu.Unlock()
	return &mockQBankTx{state: c.state}, nil
}

func (c *mockQBankConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	copied := make([]any, len(args))
	for i, a := range args {
		copied[i] = a.Value
	}
	c.state.mu.Lock()
	c.state.execs = append(c.state.execs, mockQBankSQLRecord{query: query, args: copied})
	failDel := c.state.failDeleteWeeks
	dlRemaining := c.state.deadlockCount
	if dlRemaining > 0 && strings.Contains(query, "INSERT INTO `qbank_weeks`") {
		c.state.deadlockCount--
	}
	c.state.mu.Unlock()

	if dlRemaining > 0 && strings.Contains(query, "INSERT INTO `qbank_weeks`") {
		return nil, &mysql.MySQLError{Number: 1213, Message: "Deadlock found when trying to get lock; try restarting transaction"}
	}
	if failDel && strings.Contains(query, "DELETE FROM `qbank_weeks`") {
		return nil, errors.New("simulated delete qbank_weeks failure")
	}
	return mockQBankResult{lastID: 101, affected: 1}, nil
}

func (c *mockQBankConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	copied := make([]any, len(args))
	for i, a := range args {
		copied[i] = a.Value
	}
	c.state.mu.Lock()
	c.state.queries = append(c.state.queries, mockQBankSQLRecord{query: query, args: copied})
	st := c.state
	bankType := st.bankType
	if bankType == "" {
		bankType = "homework"
	}
	updatedTS := st.updatedAtUTC
	if updatedTS.IsZero() {
		updatedTS = time.Date(2026, 11, 21, 16, 5, 0, 0, time.UTC) // 2026-11-22 00:05 in Asia/Shanghai
	}
	st.mu.Unlock()

	switch {
	case strings.Contains(query, "FROM `qbank_weeks`") && strings.Contains(query, "ROUND(UNIX_TIMESTAMP(`updated_at`)*1000)") && !strings.Contains(query, "`created_by`"):
		return &mockQBankRows{
			cols: []string{"id", "bank_type", "year", "season", "subject", "grade", "tier", "week", "question_count", "updated_at_ms"},
			rows: [][]driver.Value{
				{int64(11), "homework", int64(2026), "秋", "数学", "七年级", "S+", int64(3), int64(2), float64(1795190700000)},
			},
		}, nil

	case strings.Contains(query, "FROM `qbank_weeks`") && strings.Contains(query, "`created_by`"):
		cols := []string{"id", "bank_type", "year", "season", "subject", "grade", "tier", "week", "question_count", "created_by", "updated_by", "updated_at", "updated_at_ms"}
		if st.weekDetailNil {
			return &mockQBankRows{cols: cols}, nil
		}
		if st.yearFallbackOnly && strings.Contains(query, "`year` = ? AND `season` = ?") {
			return &mockQBankRows{cols: cols}, nil
		}
		return &mockQBankRows{
			cols: cols,
			rows: [][]driver.Value{
				{int64(42), bankType, int64(2026), "秋", "数学", "七年级", "S+", int64(3), int64(1), "t101", "t102", updatedTS, float64(updatedTS.UnixMilli())},
			},
		}, nil

	case strings.Contains(query, "SELECT `question_num`, `parent_question_num`"):
		cols := []string{"question_num", "parent_question_num", "parent_question_nums", "sub_num", "topic", "video_url", "question_meta", "exercise_pdf", "exercise_name", "answer_pdf", "answer_name"}
		if bankType == "variation" {
			return &mockQBankRows{
				cols: cols,
				rows: [][]driver.Value{
					{int64(1), int64(2), "2,3", int64(1), "旧标题", "https://v.example/1.mp4", `{"mode":"region_crop","groupNums":[2,1]}`, "data/pdfs/pdf_var_1.pdf", "var1.pdf", "", ""},
				},
			}, nil
		}
		return &mockQBankRows{
			cols: cols,
			rows: [][]driver.Value{
				{int64(1), nil, nil, int64(1), "一元一次方程", "", "", "data/pdfs/pdf_hw_1.pdf", "hw1.pdf", "data/pdfs/pdf_ans_1.pdf", "ans1.pdf"},
			},
		}, nil

	case strings.Contains(query, "SELECT `question_num`, `topic` FROM `qbank_questions` WHERE `bank_type` = 'homework'"):
		return &mockQBankRows{
			cols: []string{"question_num", "topic"},
			rows: [][]driver.Value{
				{int64(2), "整式加减精讲"},
			},
		}, nil

	case strings.Contains(query, "SELECT `real_name` FROM `users`"):
		return &mockQBankRows{
			cols: []string{"real_name"},
			rows: [][]driver.Value{{"李老师"}},
		}, nil

	case strings.Contains(query, "SELECT `id` FROM `qbank_weeks`"):
		return &mockQBankRows{
			cols: []string{"id"},
			rows: [][]driver.Value{{int64(42)}},
		}, nil

	case strings.Contains(query, "SELECT `exercise_pdf`, `answer_pdf` FROM `qbank_questions`"):
		return &mockQBankRows{
			cols: []string{"exercise_pdf", "answer_pdf"},
			rows: st.oldWeekPDFRows,
		}, nil

	case strings.Contains(query, "SELECT `id`, `parent_question_num`, `parent_question_nums`, `topic` FROM `qbank_questions` WHERE `bank_type` = 'variation'"):
		return &mockQBankRows{
			cols: []string{"id", "parent_question_num", "parent_question_nums", "topic"},
			rows: st.variationRows,
		}, nil

	case strings.Contains(query, "SELECT COUNT(*) FROM `qbank_questions`"):
		var cnt int64
		if len(copied) > 0 {
			if rel, ok := copied[0].(string); ok {
				cnt = st.refCounts[rel]
			}
		}
		return &mockQBankRows{
			cols: []string{"cnt"},
			rows: [][]driver.Value{{cnt}},
		}, nil

	default:
		return nil, fmt.Errorf("unexpected qbank query: %s", query)
	}
}

type mockQBankTx struct {
	state *mockQBankDBState
}

func (t *mockQBankTx) Commit() error {
	t.state.mu.Lock()
	t.state.txCommitted++
	t.state.mu.Unlock()
	return nil
}

func (t *mockQBankTx) Rollback() error {
	t.state.mu.Lock()
	t.state.txRolledBack++
	t.state.mu.Unlock()
	return nil
}

type mockQBankStmt struct {
	state *mockQBankDBState
	query string
}

func (s *mockQBankStmt) Close() error  { return nil }
func (s *mockQBankStmt) NumInput() int { return -1 }

func (s *mockQBankStmt) Exec(args []driver.Value) (driver.Result, error) {
	named := make([]driver.NamedValue, len(args))
	for i, v := range args {
		named[i] = driver.NamedValue{Ordinal: i + 1, Value: v}
	}
	return s.ExecContext(context.Background(), named)
}

func (s *mockQBankStmt) ExecContext(_ context.Context, args []driver.NamedValue) (driver.Result, error) {
	copied := make([]any, len(args))
	for i, a := range args {
		copied[i] = a.Value
	}
	s.state.mu.Lock()
	s.state.execs = append(s.state.execs, mockQBankSQLRecord{query: s.query, args: copied})
	s.state.mu.Unlock()
	return mockQBankResult{lastID: 1, affected: 1}, nil
}

func (s *mockQBankStmt) Query([]driver.Value) (driver.Rows, error) {
	return nil, driver.ErrSkip
}

type mockQBankResult struct {
	lastID   int64
	affected int64
}

func (r mockQBankResult) LastInsertId() (int64, error) { return r.lastID, nil }
func (r mockQBankResult) RowsAffected() (int64, error) { return r.affected, nil }

type mockQBankRows struct {
	cols []string
	rows [][]driver.Value
	idx  int
}

func (r *mockQBankRows) Columns() []string { return r.cols }
func (r *mockQBankRows) Close() error      { return nil }
func (r *mockQBankRows) Next(dest []driver.Value) error {
	if r.idx >= len(r.rows) {
		return io.EOF
	}
	copy(dest, r.rows[r.idx])
	r.idx++
	return nil
}

func openMockQBankDB(t *testing.T, st *mockQBankDBState) *sql.DB {
	t.Helper()
	dsn := t.Name()
	mockQBankDBMu.Lock()
	mockQBankDBRegistry[dsn] = st
	mockQBankDBMu.Unlock()
	t.Cleanup(func() {
		mockQBankDBMu.Lock()
		delete(mockQBankDBRegistry, dsn)
		mockQBankDBMu.Unlock()
	})
	db, err := sql.Open("mock_qbank_mysql", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestMySQLRepositoryListAndGetWeek(t *testing.T) {
	utcTS := time.Date(2026, 11, 21, 16, 15, 30, 0, time.UTC) // 2026-11-22 00:15:30 Asia/Shanghai
	st := &mockQBankDBState{
		yearFallbackOnly: true,
		bankType:         "variation",
		updatedAtUTC:     utcTS,
	}
	repo := NewMySQLRepository(openMockQBankDB(t, st))
	ctx := context.Background()

	yr := 2025
	items, err := repo.ListWeeks(ctx, ListFilter{Year: &yr, Season: "秋", Subject: "数学", Grade: "七年级", BankType: "homework", Search: "S+"})
	if err != nil {
		t.Fatalf("ListWeeks: %v", err)
	}
	if len(items) != 1 || items[0].ID != 11 || items[0].Tier != "S+" {
		t.Fatalf("unexpected ListWeeks items: %+v", items)
	}

	// Fallback query when exact year/season has no row + UTC -> Asia/Shanghai formatting + variation topic sync.
	detail, err := repo.GetWeek(ctx, WeekKey{
		Year:     &yr,
		Season:   "春",
		Subject:  "数学",
		Grade:    "七年级",
		Tier:     "S+",
		Week:     3,
		BankType: "variation",
	})
	if err != nil {
		t.Fatalf("GetWeek: %v", err)
	}
	if detail == nil {
		t.Fatal("expected non-nil WeekDetail")
	}
	if detail.UpdatedAtFormatted != "2026-11-22 00:15" {
		t.Fatalf("UpdatedAtFormatted = %q, want 2026-11-22 00:15 (Shanghai)", detail.UpdatedAtFormatted)
	}
	if detail.OperatorName != "李老师" || detail.Operator != "t102" {
		t.Fatalf("unexpected operator info: %+v", detail)
	}
	if len(detail.Questions) != 1 || detail.Questions[0].Topic != "整式加减精讲" {
		t.Fatalf("expected variation topic synced from homework, got %+v", detail.Questions)
	}
}

func TestMySQLRepositorySaveDeleteAndCleanup(t *testing.T) {
	st := &mockQBankDBState{
		oldWeekPDFRows: [][]driver.Value{
			{"data/pdfs/pdf_old_removed.pdf", "data/pdfs/pdf_still_used.pdf"},
		},
		variationRows: [][]driver.Value{
			{int64(701), int64(1), "1", "旧错题"},
		},
		refCounts: map[string]int64{
			"data/pdfs/pdf_old_removed.pdf": 0,
			"data/pdfs/pdf_kept_orphan.pdf": 0,
		},
	}
	repo := NewMySQLRepository(openMockQBankDB(t, st))
	ctx := context.Background()

	p1 := 1
	pStr := "1"
	removed, err := repo.SaveWeek(ctx, SaveWeekRequest{
		BankType: "homework",
		Year:     2026,
		Season:   "秋",
		Subject:  "数学",
		Grade:    "七年级",
		Tier:     "S+",
		Week:     3,
		Operator: "t101",
		Questions: []SaveQuestionInput{
			{
				QuestionNum:       1,
				ParentQuestionNum: &p1,
				ParentNumsStr:     &pStr,
				SubNum:            1,
				Topic:             "一元一次方程",
				ExerciseURL:       "data/pdfs/pdf_still_used.pdf",
				ExerciseName:      "ex.pdf",
			},
		},
		RawMaps: []map[string]any{{"id": 1, "topic": "一元一次方程"}},
	})
	if err != nil {
		t.Fatalf("SaveWeek: %v", err)
	}
	if len(removed) != 1 || removed[0] != "data/pdfs/pdf_old_removed.pdf" {
		t.Fatalf("unexpected removed PDFs: %v", removed)
	}
	if st.txCommitted != 1 {
		t.Fatalf("expected txCommitted=1 after SaveWeek, got %d", st.txCommitted)
	}

	// Verify variation topic cascade UPDATE was executed.
	cascaded := false
	for _, ex := range st.execs {
		if strings.Contains(ex.query, "UPDATE `qbank_questions` SET `topic` = ?") && len(ex.args) == 2 && ex.args[0] == "一元一次方程" {
			cascaded = true
		}
	}
	if !cascaded {
		t.Fatalf("expected homework topic cascade update to variation question; execs=%+v", st.execs)
	}

	// DeleteWeek commits when all statements succeed.
	st.oldWeekPDFRows = [][]driver.Value{{"data/pdfs/pdf_kept_orphan.pdf", ""}}
	yr := 2026
	delCands, err := repo.DeleteWeek(ctx, WeekKey{Year: &yr, Season: "秋", Subject: "数学", Grade: "七年级", Tier: "S+", Week: 3, BankType: "homework"})
	if err != nil {
		t.Fatalf("DeleteWeek commit path: %v", err)
	}
	if len(delCands) != 1 || delCands[0] != "data/pdfs/pdf_kept_orphan.pdf" {
		t.Fatalf("unexpected DeleteWeek candidates: %v", delCands)
	}
	if st.txCommitted != 2 {
		t.Fatalf("expected txCommitted=2, got %d", st.txCommitted)
	}

	// DeleteWeek rolls back when DELETE qbank_weeks fails.
	st.failDeleteWeeks = true
	prevRollback := st.txRolledBack
	if _, err := repo.DeleteWeek(ctx, WeekKey{Subject: "数学", Grade: "七年级", Tier: "S+", Week: 3, BankType: "homework"}); err == nil {
		t.Fatal("expected DeleteWeek error on qbank_weeks failure")
	}
	if st.txRolledBack <= prevRollback {
		t.Fatalf("expected tx.Rollback() on DeleteWeek error, txRolledBack=%d prev=%d", st.txRolledBack, prevRollback)
	}

	// CleanupUnreferencedPDFs skips <60s files when no revision checker is wired, and deletes older ones.
	root := t.TempDir()
	pdfDir := filepath.Join(root, "data", "pdfs")
	if err := os.MkdirAll(pdfDir, 0o755); err != nil {
		t.Fatal(err)
	}
	orphan := filepath.Join(pdfDir, "pdf_kept_orphan.pdf")
	_ = os.WriteFile(orphan, []byte("%PDF-1.4"), 0o644)
	if n := CleanupUnreferencedPDFs(ctx, repo, root, []string{"data/pdfs/pdf_kept_orphan.pdf"}); n != 0 {
		t.Fatalf("expected fresh (<60s) file without revision checker to be skipped, got deleted=%d", n)
	}
	oldTS := time.Now().Add(-2 * time.Minute)
	if err := os.Chtimes(orphan, oldTS, oldTS); err != nil {
		t.Fatal(err)
	}
	if n := CleanupUnreferencedPDFs(ctx, repo, root, []string{"data/pdfs/pdf_kept_orphan.pdf", "../etc/passwd"}); n != 1 {
		t.Fatalf("CleanupUnreferencedPDFs deleted %d, want 1", n)
	}
	if _, err := os.Stat(orphan); !os.IsNotExist(err) {
		t.Fatal("expected orphan pdf file to be deleted")
	}
}

type failingPDFChecker struct{}

func (failingPDFChecker) HasRecentPDFReference(_ context.Context, _ string, _ time.Duration) (bool, error) {
	return false, errors.New("simulated mysql query timeout")
}

type mockVariationRecorder struct {
	calls []WeekScope
	Qs    [][]QuestionItem
}

func (m *mockVariationRecorder) RecordWeekRevisionTx(_ context.Context, _ *sql.Tx, scope WeekScope, _, _, _, _ string, questions []QuestionItem) error {
	m.calls = append(m.calls, scope)
	m.Qs = append(m.Qs, questions)
	return nil
}

func TestCleanupFailClosedSaveDeadlockRetryAndVariationAttest(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	pdfDir := filepath.Join(root, "data", "pdfs")
	if err := os.MkdirAll(pdfDir, 0o755); err != nil {
		t.Fatal(err)
	}
	failClosedFile := filepath.Join(pdfDir, "pdf_keep_on_err.pdf")
	_ = os.WriteFile(failClosedFile, []byte("%PDF-1.4"), 0o644)

	st := &mockQBankDBState{
		deadlockCount: 2, // Succeeds on 3rd attempt
		variationRows: [][]driver.Value{
			{int64(701), int64(2), "2,3", "旧错题"},
		},
		refCounts: map[string]int64{
			"data/pdfs/pdf_keep_on_err.pdf": 0,
		},
	}
	rec := &mockVariationRecorder{}
	repo := NewMySQLRepository(openMockQBankDB(t, st))

	// Fail closed when HasRecentPDFReference errors.
	if n := CleanupUnreferencedPDFsWithAttest(ctx, repo, failingPDFChecker{}, root, []string{"data/pdfs/pdf_keep_on_err.pdf"}); n != 0 {
		t.Fatalf("expected 0 deleted on HasRecentPDFReference error (fail-closed), got %d", n)
	}
	if _, err := os.Stat(failClosedFile); err != nil {
		t.Fatalf("expected file to remain after fail-closed check: %v", err)
	}

	// SaveWeek retries on 1213 deadlock and records variation attestation inside tx.
	_, err := repo.SaveWeek(ctx, SaveWeekRequest{
		BankType: "homework",
		Year:     2026,
		Season:   "秋",
		Subject:  "数学",
		Grade:    "七年级",
		Tier:     "S+",
		Week:     3,
		Operator: "t101",
		Questions: []SaveQuestionInput{
			{QuestionNum: 2, SubNum: 1, Topic: "整式加减精讲", ExerciseURL: "data/pdfs/pdf_hw.pdf"},
		},
		RawMaps: []map[string]any{{"id": 2, "topic": "整式加减精讲"}},
		OnVariationRecordTx: func(c context.Context, tx *sql.Tx, scope WeekScope, action string, qs []QuestionItem) error {
			return rec.RecordWeekRevisionTx(c, tx, scope, action, "", "", "", qs)
		},
	})
	if err != nil {
		t.Fatalf("SaveWeek after 2 deadlocks failed: %v", err)
	}
	if st.txBegun != 3 || st.txCommitted != 1 || st.txRolledBack != 2 {
		t.Fatalf("unexpected retry tx counts: begun=%d committed=%d rolledBack=%d", st.txBegun, st.txCommitted, st.txRolledBack)
	}
	if len(rec.calls) != 1 || rec.calls[0].BankType != "variation" {
		t.Fatalf("expected variation attestation callback inside tx, got %+v", rec.calls)
	}

	// MarshalMetaJSON preserves literal <, >, & (SetEscapeHTML(false)).
	metaPtr := MarshalMetaJSON(map[string]any{"note": "x < 5 & y > 0"})
	if metaPtr == nil || strings.Contains(*metaPtr, `\u003c`) || !strings.Contains(*metaPtr, "x < 5 & y > 0") {
		t.Fatalf("expected unescaped HTML chars in MarshalMetaJSON, got %v", metaPtr)
	}
}
