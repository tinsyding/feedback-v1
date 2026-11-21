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
	"unicode/utf8"
)

type mockDecryptExec struct {
	query string
	args  []any
}

type mockDecryptState struct {
	mu          sync.Mutex
	queries     []string
	queryArgs   [][]any
	execs       []mockDecryptExec
	tokenRow    [][]driver.Value
	historyRows [][]driver.Value
	batchAvg    [][]driver.Value
	tierAvg     [][]driver.Value
	qbankRows   [][]driver.Value
}

var (
	mockDecryptMu       sync.Mutex
	mockDecryptRegistry = map[string]*mockDecryptState{}
)

func init() {
	sql.Register("mock_retest_decrypt_mysql", &mockDecryptDriver{})
}

type mockDecryptDriver struct{}

func (d *mockDecryptDriver) Open(name string) (driver.Conn, error) {
	mockDecryptMu.Lock()
	st := mockDecryptRegistry[name]
	mockDecryptMu.Unlock()
	if st == nil {
		return nil, fmt.Errorf("unknown mock decrypt dsn %q", name)
	}
	return &mockDecryptConn{state: st}, nil
}

type mockDecryptConn struct {
	state *mockDecryptState
}

func (c *mockDecryptConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (c *mockDecryptConn) Close() error                        { return nil }
func (c *mockDecryptConn) Begin() (driver.Tx, error)           { return nil, driver.ErrSkip }

func (c *mockDecryptConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	c.state.mu.Lock()
	defer c.state.mu.Unlock()
	copied := make([]any, len(args))
	for i, a := range args {
		copied[i] = a.Value
	}
	c.state.queries = append(c.state.queries, query)
	c.state.queryArgs = append(c.state.queryArgs, copied)

	switch {
	case strings.Contains(query, "WHERE sr.retest_token = ?"):
		return &mockDecryptRows{
			cols: []string{
				"subject", "grade", "tier", "week_num", "preview_week_num",
				"preview_error_questions", "student_name", "student_key", "student_id",
				"year", "season", "updated_at", "created_at",
			},
			data: c.state.tokenRow,
		}, nil

	case strings.Contains(query, "FROM student_records sr JOIN class_batches cb"):
		return &mockDecryptRows{
			cols: []string{
				"batch_id", "batch_tier", "week_num", "preview_week_num", "homework_score",
				"preview_score", "total_score", "error_count", "error_questions",
				"preview_error_questions", "teacher_comment", "preview_comment",
				"submission_status", "preview_submission_status",
			},
			data: c.state.historyRows,
		}, nil

	case strings.Contains(query, "GROUP BY batch_id, week_num"):
		return &mockDecryptRows{
			cols: []string{"batch_id", "week_num", "avg_score"},
			data: c.state.batchAvg,
		}, nil

	case strings.Contains(query, "GROUP BY sr.week_num"):
		return &mockDecryptRows{
			cols: []string{"week_num", "avg_score"},
			data: c.state.tierAvg,
		}, nil

	case strings.Contains(query, "FROM `qbank_questions`"):
		return &mockDecryptRows{
			cols: []string{
				"id", "bank_type", "tier", "week", "question_num", "parent_question_num",
				"parent_question_nums", "sub_num", "topic", "video_url", "question_meta",
				"exercise_pdf", "answer_pdf",
			},
			data: c.state.qbankRows,
		}, nil
	}

	return nil, fmt.Errorf("unexpected query in mock_retest_decrypt_mysql: %s", query)
}

func (c *mockDecryptConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	c.state.mu.Lock()
	defer c.state.mu.Unlock()
	copied := make([]any, len(args))
	for i, a := range args {
		copied[i] = a.Value
	}
	c.state.execs = append(c.state.execs, mockDecryptExec{query: query, args: copied})
	return driver.RowsAffected(1), nil
}

type mockDecryptRows struct {
	cols []string
	data [][]driver.Value
	idx  int
}

func (r *mockDecryptRows) Columns() []string { return r.cols }
func (r *mockDecryptRows) Close() error      { return nil }
func (r *mockDecryptRows) Next(dest []driver.Value) error {
	if r.idx >= len(r.data) {
		return io.EOF
	}
	copy(dest, r.data[r.idx])
	r.idx++
	return nil
}

func openMockDecryptDB(t *testing.T, st *mockDecryptState) *sql.DB {
	t.Helper()
	dsn := t.Name()
	mockDecryptMu.Lock()
	mockDecryptRegistry[dsn] = st
	mockDecryptMu.Unlock()
	t.Cleanup(func() {
		mockDecryptMu.Lock()
		delete(mockDecryptRegistry, dsn)
		mockDecryptMu.Unlock()
	})
	db, err := sql.Open("mock_retest_decrypt_mysql", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestFindTokenRecordAndHistoryAndSeasonVariants(t *testing.T) {
	shanghai := time.FixedZone("CST", 8*3600)
	updTime := time.Date(2026, 11, 20, 18, 30, 0, 0, shanghai)

	state := &mockDecryptState{
		tokenRow: [][]driver.Value{
			{"数学", "七年级", "U", int64(2), int64(3), "[4,5]", "张三", "1001_张三_七年级_数学", "1001", int64(2026), "秋", updTime, updTime},
		},
		historyRows: [][]driver.Value{
			{int64(11), "U", int64(2), int64(3), 92.5, 88.0, 100.0, int64(1), "[2]", "[4,5]", "认真", "不错", "submitted", "submitted"},
		},
		batchAvg: [][]driver.Value{
			{int64(11), int64(2), 86.4},
		},
		qbankRows: [][]driver.Value{
			{int64(7), "homework", "U", int64(2), int64(2), int64(0), "", int64(1), "一元一次方程", "https://v/2", `{"mode":"region_crop"}`, "data/pdfs/pdf_2.pdf", "data/pdfs/ans_2.pdf"},
		},
	}

	repo := NewMySQLRepository(openMockDecryptDB(t, state))

	rec, err := repo.FindTokenRecord(context.Background(), "tok1234567")
	if err != nil || rec == nil {
		t.Fatalf("FindTokenRecord failed: rec=%+v err=%v", rec, err)
	}
	if rec.UpdatedUnix != updTime.Unix() || rec.PreviewWeekNum != 3 || len(rec.PreviewErrors) != 2 {
		t.Fatalf("unexpected token record: %+v", rec)
	}

	bundle, err := repo.LoadStudentHistoryAndAverages(context.Background(), "数学", "七年级", "U", "1001", "张三", []string{"1001_张三_七年级_数学", "1001_张三"})
	if err != nil {
		t.Fatalf("LoadStudentHistoryAndAverages failed: %v", err)
	}
	if len(bundle.Records) != 1 || bundle.WeekAvgByBatchWeek["11:2"] != 86.4 || bundle.WeekAverages["2"] != 86.4 {
		t.Fatalf("unexpected bundle: %+v", bundle)
	}

	// SeasonVariants("秋季") returns 3 variants: ["秋季", "秋", "autumn"] — all 3 must be bound.
	qRows, err := repo.PreloadMultiWeekQbankRows(context.Background(), "数学", "七年级", []int{2, 3}, 2026, "秋季")
	if err != nil {
		t.Fatalf("PreloadMultiWeekQbankRows failed: %v", err)
	}
	if len(qRows) != 1 || qRows[0].Topic != "一元一次方程" {
		t.Fatalf("unexpected qbank rows: %+v", qRows)
	}

	state.mu.Lock()
	defer state.mu.Unlock()
	lastQuery := state.queries[len(state.queries)-1]
	lastArgs := state.queryArgs[len(state.queryArgs)-1]
	if !strings.Contains(lastQuery, "`season` IN (?,?,?)") {
		t.Fatalf("expected 3-placeholder IN clause for season variants, got: %s", lastQuery)
	}
	if len(lastArgs) < 3 || lastArgs[len(lastArgs)-3] != "秋季" || lastArgs[len(lastArgs)-2] != "秋" || lastArgs[len(lastArgs)-1] != "autumn" {
		t.Fatalf("expected [秋季 秋 autumn] tail args, got: %+v", lastArgs)
	}
}

func TestRevokeTokenAndLogAccessRuneSafeTruncation(t *testing.T) {
	state := &mockDecryptState{}
	repo := NewMySQLRepository(openMockDecryptDB(t, state))

	longCJKReason := strings.Repeat("错", 300) // 900 bytes, 300 runes
	longCJKName := strings.Repeat("张", 80)    // 240 bytes, 80 runes
	longToken := strings.Repeat("a", 80)

	if err := repo.RevokeToken(context.Background(), longToken, strings.Repeat("师", 60), longCJKReason); err != nil {
		t.Fatalf("RevokeToken failed: %v", err)
	}
	repo.LogAccess(context.Background(), longToken, longCJKName, strings.Repeat("动", 60), "details", "127.0.0.1", strings.Repeat("器", 550))

	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.execs) != 2 {
		t.Fatalf("expected 2 execs, got %d", len(state.execs))
	}

	revArgs := state.execs[0].args
	revTok, _ := revArgs[0].(string)
	revOp, _ := revArgs[1].(string)
	revReason, _ := revArgs[2].(string)
	if len(revTok) != 64 || utf8.RuneCountInString(revOp) != 50 || utf8.RuneCountInString(revReason) != 255 {
		t.Fatalf("unexpected RevokeToken truncation: tok=%d op=%d reason=%d", len(revTok), utf8.RuneCountInString(revOp), utf8.RuneCountInString(revReason))
	}
	if !utf8.ValidString(revOp) || !utf8.ValidString(revReason) {
		t.Fatal("RevokeToken produced invalid UTF-8")
	}

	logArgs := state.execs[1].args
	logTok, _ := logArgs[0].(string)
	logName, _ := logArgs[1].(string)
	logAct, _ := logArgs[2].(string)
	logUA, _ := logArgs[5].(string)
	if len(logTok) != 32 || utf8.RuneCountInString(logName) != 50 || utf8.RuneCountInString(logAct) != 50 || utf8.RuneCountInString(logUA) != 500 {
		t.Fatalf("unexpected LogAccess truncation: tok=%d name=%d act=%d ua=%d", len(logTok), utf8.RuneCountInString(logName), utf8.RuneCountInString(logAct), utf8.RuneCountInString(logUA))
	}
	if !utf8.ValidString(logName) || !utf8.ValidString(logAct) || !utf8.ValidString(logUA) {
		t.Fatal("LogAccess produced invalid UTF-8")
	}
}
