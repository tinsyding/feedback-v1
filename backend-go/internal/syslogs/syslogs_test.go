package syslogs

import (
	"bytes"
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

func TestIngestLimiterWindowAndBoundedEviction(t *testing.T) {
	lim := NewIngestLimiter()
	now := time.Unix(1700000000, 0)
	lim.nowFunc = func() time.Time { return now }

	for i := 0; i < 3; i++ {
		if !lim.Allow("ip:1.2.3.4", 3) {
			t.Fatalf("attempt %d should be allowed", i+1)
		}
	}
	if lim.Allow("ip:1.2.3.4", 3) {
		t.Fatal("4th attempt within 60s should be blocked")
	}
	now = now.Add(61 * time.Second)
	if !lim.Allow("ip:1.2.3.4", 3) {
		t.Fatal("attempt after 60s window should be allowed")
	}

	// Hard-cap eviction bounds map size
	bounded := NewIngestLimiter()
	bounded.maxBuckets = 5
	bounded.nowFunc = func() time.Time { return now }
	for i := 0; i < 20; i++ {
		now = now.Add(time.Second)
		if !bounded.Allow(fmt.Sprintf("k-%d", i), 5) {
			t.Fatalf("fresh key k-%d should be allowed", i)
		}
	}
	if len(bounded.buckets) > 5 {
		t.Fatalf("expected buckets <= 5, got %d", len(bounded.buckets))
	}
}

func TestCSVExportBOMAndFormulaSanitization(t *testing.T) {
	var buf bytes.Buffer
	err := WriteExportCSV(&buf, []ExportRow{
		{
			CreatedAt:  "2026-11-21 10:00:00",
			Level:      "error",
			Module:     "viewer",
			Event:      "render_fail",
			Operator:   "=CMD|'/C calc'!A0",
			Details:    map[string]any{"message": "+123 danger"},
			Context:    map[string]any{"page": "viewer.html", "subject": "数学"},
			ClientIP:   "203.0.113.1",
			ClientInfo: map[string]any{"userAgent": "Mozilla/5.0"},
		},
	})
	if err != nil {
		t.Fatalf("WriteExportCSV failed: %v", err)
	}
	raw := buf.Bytes()
	if len(raw) < 3 || raw[0] != 0xEF || raw[1] != 0xBB || raw[2] != 0xBF {
		t.Fatal("expected UTF-8 BOM prefix")
	}
	text := string(raw[3:])
	if !strings.Contains(text, "'=CMD|'/C calc'!A0") {
		t.Fatalf("expected formula cell to be prefixed with single quote: %s", text)
	}
	if !strings.Contains(text, "'+123 danger") {
		t.Fatalf("expected + cell to be prefixed with single quote: %s", text)
	}
	if !strings.Contains(text, "错误") {
		t.Fatalf("expected Chinese level label 错误: %s", text)
	}

	// FormatDetailsForExport truncates long CJK JSON without splitting UTF-8
	longCJK := FormatDetailsForExport(map[string]any{"info": strings.Repeat("中文日志详情", 60)})
	if !utf8.ValidString(longCJK) || !strings.HasSuffix(longCJK, "...") {
		t.Fatalf("expected valid UTF-8 truncated details, got %q", longCJK)
	}
}

type mockSysLogsQuery struct {
	query string
	args  []any
}

type mockSysLogsState struct {
	mu      sync.Mutex
	queries []mockSysLogsQuery
	execs   []mockSysLogsQuery
}

var (
	mockSysLogsMu       sync.Mutex
	mockSysLogsRegistry = make(map[string]*mockSysLogsState)
)

func init() {
	sql.Register("mock_syslogs_mysql", &mockSysLogsDriver{})
}

type mockSysLogsDriver struct{}

func (d *mockSysLogsDriver) Open(name string) (driver.Conn, error) {
	mockSysLogsMu.Lock()
	st := mockSysLogsRegistry[name]
	mockSysLogsMu.Unlock()
	if st == nil {
		return nil, fmt.Errorf("unknown mock dsn %q", name)
	}
	return &mockSysLogsConn{state: st}, nil
}

type mockSysLogsConn struct{ state *mockSysLogsState }
type mockSysLogsTx struct{}
type mockSysLogsStmt struct {
	state *mockSysLogsState
	query string
}

func (c *mockSysLogsConn) Prepare(q string) (driver.Stmt, error) {
	return &mockSysLogsStmt{state: c.state, query: q}, nil
}
func (c *mockSysLogsConn) PrepareContext(_ context.Context, q string) (driver.Stmt, error) {
	return &mockSysLogsStmt{state: c.state, query: q}, nil
}
func (c *mockSysLogsConn) Close() error              { return nil }
func (c *mockSysLogsConn) Begin() (driver.Tx, error) { return &mockSysLogsTx{}, nil }
func (c *mockSysLogsConn) BeginTx(_ context.Context, _ driver.TxOptions) (driver.Tx, error) {
	return &mockSysLogsTx{}, nil
}

func (tx *mockSysLogsTx) Commit() error   { return nil }
func (tx *mockSysLogsTx) Rollback() error { return nil }

func (s *mockSysLogsStmt) Close() error  { return nil }
func (s *mockSysLogsStmt) NumInput() int { return -1 }
func (s *mockSysLogsStmt) Exec(args []driver.Value) (driver.Result, error) {
	copied := make([]any, len(args))
	for i, v := range args {
		copied[i] = v
	}
	s.state.mu.Lock()
	s.state.execs = append(s.state.execs, mockSysLogsQuery{query: s.query, args: copied})
	s.state.mu.Unlock()
	return driver.RowsAffected(1), nil
}
func (s *mockSysLogsStmt) ExecContext(_ context.Context, args []driver.NamedValue) (driver.Result, error) {
	copied := make([]any, len(args))
	for i, v := range args {
		copied[i] = v.Value
	}
	s.state.mu.Lock()
	s.state.execs = append(s.state.execs, mockSysLogsQuery{query: s.query, args: copied})
	s.state.mu.Unlock()
	return driver.RowsAffected(1), nil
}
func (s *mockSysLogsStmt) Query([]driver.Value) (driver.Rows, error) { return nil, driver.ErrSkip }

func (c *mockSysLogsConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	copied := make([]any, len(args))
	for i, a := range args {
		copied[i] = a.Value
	}
	c.state.mu.Lock()
	c.state.execs = append(c.state.execs, mockSysLogsQuery{query: query, args: copied})
	c.state.mu.Unlock()
	return driver.RowsAffected(3), nil
}

func (c *mockSysLogsConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	copied := make([]any, len(args))
	for i, a := range args {
		copied[i] = a.Value
	}
	c.state.mu.Lock()
	c.state.queries = append(c.state.queries, mockSysLogsQuery{query: query, args: copied})
	c.state.mu.Unlock()

	shanghai := time.FixedZone("CST", 8*3600)
	sampleDate := time.Date(2026, 11, 21, 0, 0, 0, 0, shanghai)
	sampleCreatedAt := time.Date(2026, 11, 21, 14, 22, 33, 0, shanghai)

	switch {
	case strings.Contains(query, "COALESCE(SUM(event = 'save'), 0)"):
		return &mockSysLogsRows{
			cols: []string{"total", "err", "warn", "action", "info", "save", "del"},
			rows: [][]driver.Value{{int64(1), int64(0), int64(0), int64(1), int64(0), int64(0), int64(0)}},
		}, nil
	case strings.Contains(query, "SELECT `log_id`, `timestamp`"):
		return &mockSysLogsRows{
			cols: []string{"log_id", "timestamp", "level", "module", "event", "operator", "details", "context", "client_ip", "client_info"},
			rows: [][]driver.Value{{"log_1", float64(1700000000000), "action", "viewer", "open", "t101", `{"message":"ok"}`, `{"page":"v"}`, "203.0.113.1", `{"ip":"203.0.113.1"}`}},
		}, nil
	case strings.Contains(query, "SELECT DISTINCT DATE(created_at)"):
		// Simulate go-sql-driver/mysql ParseTime=true returning time.Time for DATE(...)
		return &mockSysLogsRows{
			cols: []string{"log_date"},
			rows: [][]driver.Value{{sampleDate}},
		}, nil
	case strings.Contains(query, "SELECT DISTINCT module"):
		return &mockSysLogsRows{cols: []string{"module"}, rows: [][]driver.Value{{"viewer"}}}, nil
	case strings.Contains(query, "SELECT DISTINCT event"):
		return &mockSysLogsRows{cols: []string{"event"}, rows: [][]driver.Value{{"open"}}}, nil
	case strings.Contains(query, "SELECT DISTINCT client_ip"):
		return &mockSysLogsRows{cols: []string{"client_ip"}, rows: [][]driver.Value{{"203.0.113.1"}}}, nil
	case strings.Contains(query, "SELECT `created_at`, `level`"):
		return &mockSysLogsRows{
			cols: []string{"created_at", "level", "module", "event", "operator", "details", "context", "client_ip", "client_info"},
			rows: [][]driver.Value{{sampleCreatedAt, "action", "viewer", "open", "t101", `{"message":"ok"}`, `{}`, "203.0.113.1", `{"userAgent":"UA"}`}},
		}, nil
	case strings.Contains(query, "DATE(created_at) AS log_date"):
		return &mockSysLogsRows{
			cols: []string{"log_date", "total", "err_cnt", "warn_cnt", "action_cnt", "info_cnt"},
			rows: [][]driver.Value{{sampleDate, int64(5), int64(1), int64(1), int64(2), int64(1)}},
		}, nil
	default:
		return nil, fmt.Errorf("unexpected query: %s", query)
	}
}

type mockSysLogsRows struct {
	cols []string
	rows [][]driver.Value
	idx  int
}

func (r *mockSysLogsRows) Columns() []string { return r.cols }
func (r *mockSysLogsRows) Close() error      { return nil }
func (r *mockSysLogsRows) Next(dest []driver.Value) error {
	if r.idx >= len(r.rows) {
		return io.EOF
	}
	copy(dest, r.rows[r.idx])
	r.idx++
	return nil
}

func openMockSysLogsDB(t *testing.T) (*sql.DB, *mockSysLogsState) {
	t.Helper()
	st := &mockSysLogsState{}
	dsn := t.Name()
	mockSysLogsMu.Lock()
	mockSysLogsRegistry[dsn] = st
	mockSysLogsMu.Unlock()
	t.Cleanup(func() {
		mockSysLogsMu.Lock()
		delete(mockSysLogsRegistry, dsn)
		mockSysLogsMu.Unlock()
	})
	db, err := sql.Open("mock_syslogs_mysql", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db, st
}

func TestMySQLRepositorySQLAndDateFormattingParity(t *testing.T) {
	db, st := openMockSysLogsDB(t)
	root := t.TempDir()
	repo := NewMySQLRepository(db, root)
	ctx := context.Background()

	// 1. InsertBatch writes DB + daily jsonl
	err := repo.InsertBatch(ctx, []LogRecord{{
		ID:        "log_test1",
		Timestamp: 1700000000000,
		Level:     "action",
		Module:    "viewer",
		Event:     "open",
		Operator:  "t101",
		Details:   map[string]any{"message": "ok"},
		Context:   map[string]any{},
		Client:    map[string]any{"ip": "203.0.113.1"},
		ClientIP:  "203.0.113.1",
		CreatedAt: "2026-11-21 14:22:33",
		DateStr:   "2026-11-21",
	}})
	if err != nil {
		t.Fatalf("InsertBatch: %v", err)
	}
	if len(st.execs) != 1 || !strings.Contains(st.execs[0].query, "INSERT INTO `system_logs`") {
		t.Fatalf("unexpected InsertBatch execs: %+v", st.execs)
	}
	if _, err := os.Stat(filepath.Join(root, "data", "logs", "2026-11-21.jsonl")); err != nil {
		t.Fatalf("expected jsonl file created: %v", err)
	}

	// 2. List & Filters return YYYY-MM-DD (not RFC3339) when driver returns time.Time for DATE(created_at)
	listRes, err := repo.List(ctx, ListFilter{Date: "2026-11-21", Page: 1, PerPage: 20})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(listRes.Dates) != 1 || listRes.Dates[0] != "2026-11-21" {
		t.Fatalf("List.Dates = %v, want [2026-11-21]", listRes.Dates)
	}

	filtersRes, err := repo.Filters(ctx)
	if err != nil {
		t.Fatalf("Filters: %v", err)
	}
	if len(filtersRes.Dates) != 1 || filtersRes.Dates[0] != "2026-11-21" {
		t.Fatalf("Filters.Dates = %v, want [2026-11-21]", filtersRes.Dates)
	}
	if len(filtersRes.Modules) != 2 || filtersRes.Modules[1] != "sender_py" {
		t.Fatalf("expected sender_py appended to modules, got %v", filtersRes.Modules)
	}

	// 3. ExportRows formats created_at as "YYYY-MM-DD HH:MM:SS" in Asia/Shanghai
	expRows, err := repo.ExportRows(ctx, ListFilter{}, 100)
	if err != nil || len(expRows) != 1 {
		t.Fatalf("ExportRows: len=%d err=%v", len(expRows), err)
	}
	if expRows[0].CreatedAt != "2026-11-21 14:22:33" {
		t.Fatalf("ExportRows[0].CreatedAt = %q, want 2026-11-21 14:22:33", expRows[0].CreatedAt)
	}

	// 4. Stats formats log_date as "YYYY-MM-DD"
	statsRes, err := repo.Stats(ctx)
	if err != nil || len(statsRes.DailyStats) != 1 {
		t.Fatalf("Stats: res=%+v err=%v", statsRes, err)
	}
	if statsRes.Dates[0] != "2026-11-21" || statsRes.DailyStats[0].Date != "2026-11-21" {
		t.Fatalf("Stats dates = %v / %+v, want 2026-11-21", statsRes.Dates, statsRes.DailyStats)
	}

	// 5. DeleteByDate & CleanupOld
	deleted, err := repo.DeleteByDate(ctx, "2026-11-21")
	if err != nil || deleted != 3 {
		t.Fatalf("DeleteByDate: deleted=%d err=%v", deleted, err)
	}

	oldLog := filepath.Join(root, "data", "logs", "2026-10-01.jsonl")
	if err := os.WriteFile(oldLog, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 21, 15, 0, 0, 0, time.FixedZone("CST", 8*3600))
	cleaned, err := repo.CleanupOld(ctx, now, 30)
	if err != nil || cleaned != 3 {
		t.Fatalf("CleanupOld: cleaned=%d err=%v", cleaned, err)
	}
	if _, err := os.Stat(oldLog); !os.IsNotExist(err) {
		t.Fatalf("expected old jsonl %s to be deleted", oldLog)
	}
	if _, err := os.Stat(filepath.Join(root, "data", "logs", "2026-11-21.jsonl")); err != nil {
		t.Fatalf("expected today's jsonl to remain: %v", err)
	}
}
