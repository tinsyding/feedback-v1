package syslogs

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

const RetentionDays = 30

var reISODate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// LogRecord represents a single system_logs entry for insertion and listing.
type LogRecord struct {
	ID        string         `json:"id"`
	Timestamp float64        `json:"timestamp"`
	Level     string         `json:"level"`
	Module    string         `json:"module"`
	Event     string         `json:"event"`
	Operator  string         `json:"operator"`
	Details   map[string]any `json:"details"`
	Context   map[string]any `json:"context"`
	Client    map[string]any `json:"client"`
	ClientIP  string         `json:"-"`
	CreatedAt string         `json:"-"`
	DateStr   string         `json:"-"`
}

// ExportRow holds fields needed for CSV export.
type ExportRow struct {
	CreatedAt  string
	Level      string
	Module     string
	Event      string
	Operator   string
	Details    map[string]any
	Context    map[string]any
	ClientIP   string
	ClientInfo map[string]any
}

// ListFilter holds query filters for GET ?action=list and GET ?action=export.
type ListFilter struct {
	Page        int
	PerPage     int
	Level       string
	Module      string
	Event       string
	Date        string
	Search      string
	IP          string
	Fingerprint string
}

// ListResult matches GET ?action=list response data.
type ListResult struct {
	Logs       []LogRecord    `json:"logs"`
	Pagination map[string]any `json:"pagination"`
	Stats      map[string]any `json:"stats"`
	Dates      []string       `json:"dates"`
}

// FiltersResult matches GET ?action=filters response data.
type FiltersResult struct {
	Modules      []string `json:"modules"`
	Events       []string `json:"events"`
	IPs          []string `json:"ips"`
	Levels       []string `json:"levels"`
	Dates        []string `json:"dates"`
	Subjects     []string `json:"subjects"`
	Fingerprints []string `json:"fingerprints"`
}

// DailyStat matches an entry in GET ?action=stats.
type DailyStat struct {
	Date   string `json:"date"`
	Total  int    `json:"total"`
	Error  int    `json:"error"`
	Warn   int    `json:"warn"`
	Action int    `json:"action"`
	Info   int    `json:"info"`
}

// StatsResult matches GET ?action=stats response data.
type StatsResult struct {
	Dates         []string    `json:"dates"`
	DailyStats    []DailyStat `json:"dailyStats"`
	RetentionDays int         `json:"retentionDays"`
}

// Repository abstracts system_logs persistence.
type Repository interface {
	InsertBatch(ctx context.Context, entries []LogRecord) error
	List(ctx context.Context, filter ListFilter) (*ListResult, error)
	Filters(ctx context.Context) (*FiltersResult, error)
	ExportRows(ctx context.Context, filter ListFilter, limit int) ([]ExportRow, error)
	Stats(ctx context.Context) (*StatsResult, error)
	DeleteByDate(ctx context.Context, date string) (int64, error)
	DeleteByID(ctx context.Context, id string) (int64, error)
}

// MySQLRepository implements Repository backed by *sql.DB + daily .jsonl mirror under data/logs/.
type MySQLRepository struct {
	db           *sql.DB
	feedbackRoot string
	fileMu       sync.Mutex
}

// NewMySQLRepository creates a MySQLRepository.
func NewMySQLRepository(db *sql.DB, feedbackRoot string) *MySQLRepository {
	return &MySQLRepository{
		db:           db,
		feedbackRoot: strings.TrimSpace(feedbackRoot),
	}
}

func (r *MySQLRepository) logDir() string {
	if r.feedbackRoot == "" {
		return ""
	}
	return filepath.Join(r.feedbackRoot, "data", "logs")
}

// AvailableDatesFromDisk scans data/logs/YYYY-MM-DD.jsonl filenames descending.
func AvailableDatesFromDisk(logDir string) []string {
	if logDir == "" {
		return []string{}
	}
	entries, err := os.ReadDir(logDir)
	if err != nil {
		return []string{}
	}
	dates := make([]string, 0)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if strings.HasSuffix(name, ".jsonl") {
			base := strings.TrimSuffix(name, ".jsonl")
			if reISODate.MatchString(base) {
				dates = append(dates, base)
			}
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(dates)))
	return dates
}

func (r *MySQLRepository) InsertBatch(ctx context.Context, entries []LogRecord) error {
	if len(entries) == 0 {
		return nil
	}

	// 1. Best-effort batch insert into MySQL
	if r.db != nil {
		tx, err := r.db.BeginTx(ctx, nil)
		if err == nil {
			stmt, prepErr := tx.PrepareContext(
				ctx,
				`INSERT INTO `+"`system_logs`"+`
				 (`+"`log_id`, `timestamp`, `level`, `module`, `event`, `operator`, `details`, `context`, `client_ip`, `client_info`, `created_at`"+`)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			if prepErr == nil {
				for _, e := range entries {
					detB, _ := json.Marshal(nonNilMap(e.Details))
					ctxB, _ := json.Marshal(nonNilMap(e.Context))
					cliB, _ := json.Marshal(nonNilMap(e.Client))
					_, _ = stmt.ExecContext(
						ctx,
						e.ID, e.Timestamp, e.Level, e.Module, e.Event, e.Operator,
						string(detB), string(ctxB), e.ClientIP, string(cliB), e.CreatedAt,
					)
				}
				_ = stmt.Close()
				_ = tx.Commit()
			} else {
				_ = tx.Rollback()
			}
		}
	}

	// 2. Append to daily .jsonl files grouped by DateStr
	logDir := r.logDir()
	if logDir != "" {
		byDate := make(map[string][]byte)
		for _, e := range entries {
			d := e.DateStr
			if !reISODate.MatchString(d) {
				if len(e.CreatedAt) >= 10 && reISODate.MatchString(e.CreatedAt[:10]) {
					d = e.CreatedAt[:10]
				} else {
					continue
				}
			}
			lineBytes, err := json.Marshal(LogRecord{
				ID:        e.ID,
				Timestamp: e.Timestamp,
				Level:     e.Level,
				Module:    e.Module,
				Event:     e.Event,
				Operator:  e.Operator,
				Details:   nonNilMap(e.Details),
				Context:   nonNilMap(e.Context),
				Client:    nonNilMap(e.Client),
			})
			if err != nil {
				continue
			}
			byDate[d] = append(byDate[d], append(lineBytes, '\n')...)
		}
		if len(byDate) > 0 {
			r.fileMu.Lock()
			if os.MkdirAll(logDir, 0755) == nil {
				for d, buf := range byDate {
					p := filepath.Join(logDir, d+".jsonl")
					if f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644); err == nil {
						_, _ = f.Write(buf)
						_ = f.Close()
					}
				}
			}
			r.fileMu.Unlock()
		}
	}

	return nil
}

func buildWhereClause(filter ListFilter) (string, []any) {
	var where []string
	var params []any
	if filter.Level != "" {
		where = append(where, "level = ?")
		params = append(params, filter.Level)
	}
	if filter.Module != "" {
		where = append(where, "module = ?")
		params = append(params, filter.Module)
	}
	if filter.Event != "" {
		where = append(where, "event LIKE ?")
		params = append(params, "%"+filter.Event+"%")
	}
	if filter.Date != "" && reISODate.MatchString(filter.Date) {
		where = append(where, "DATE(created_at) = ?")
		params = append(params, filter.Date)
	}
	if filter.IP != "" {
		where = append(where, "client_ip LIKE ?")
		params = append(params, "%"+filter.IP+"%")
	}
	if filter.Search != "" {
		where = append(where, "(event LIKE ? OR module LIKE ? OR details LIKE ? OR client_ip LIKE ? OR operator LIKE ?)")
		kw := "%" + filter.Search + "%"
		params = append(params, kw, kw, kw, kw, kw)
	}
	if filter.Fingerprint != "" {
		where = append(where, "client_info LIKE ?")
		params = append(params, "%"+filter.Fingerprint+"%")
	}
	if len(where) == 0 {
		return "", params
	}
	return "WHERE " + strings.Join(where, " AND "), params
}

func decodeJSONMap(raw sql.NullString) map[string]any {
	if !raw.Valid || strings.TrimSpace(raw.String) == "" {
		return map[string]any{}
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(raw.String), &m); err != nil || m == nil {
		return map[string]any{}
	}
	return m
}

func nonNilMap(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

func (r *MySQLRepository) List(ctx context.Context, filter ListFilter) (*ListResult, error) {
	if r == nil || r.db == nil {
		return nil, errors.New("database is not configured")
	}
	page := filter.Page
	if page < 1 {
		page = 1
	}
	perPage := filter.PerPage
	if perPage < 1 {
		perPage = 20
	}
	if perPage > 100 {
		perPage = 100
	}

	whereSQL, params := buildWhereClause(filter)

	var total, errCnt, warnCnt, actionCnt, infoCnt, saveCnt, delCnt int
	statQuery := `SELECT
		COUNT(*),
		COALESCE(SUM(level = 'error'), 0),
		COALESCE(SUM(level = 'warn'), 0),
		COALESCE(SUM(level = 'action'), 0),
		COALESCE(SUM(level = 'info'), 0),
		COALESCE(SUM(event = 'save'), 0),
		COALESCE(SUM(event = 'delete'), 0)
		FROM system_logs ` + whereSQL
	if err := r.db.QueryRowContext(ctx, statQuery, params...).Scan(
		&total, &errCnt, &warnCnt, &actionCnt, &infoCnt, &saveCnt, &delCnt,
	); err != nil {
		return nil, err
	}

	totalPages := int(math.Ceil(float64(total) / float64(perPage)))
	offset := (page - 1) * perPage

	listParams := append(append([]any{}, params...), perPage, offset)
	rows, err := r.db.QueryContext(
		ctx,
		"SELECT `log_id`, `timestamp`, `level`, `module`, `event`, `operator`, `details`, `context`, `client_ip`, `client_info` "+
			"FROM `system_logs` "+whereSQL+" ORDER BY `timestamp` DESC LIMIT ? OFFSET ?",
		listParams...,
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	logs := make([]LogRecord, 0)
	for rows.Next() {
		var rec LogRecord
		var operator, details, ctxRaw, clientIP, clientInfo sql.NullString
		if err := rows.Scan(
			&rec.ID, &rec.Timestamp, &rec.Level, &rec.Module, &rec.Event,
			&operator, &details, &ctxRaw, &clientIP, &clientInfo,
		); err != nil {
			return nil, err
		}
		rec.Operator = operator.String
		rec.Details = decodeJSONMap(details)
		rec.Context = decodeJSONMap(ctxRaw)
		cli := decodeJSONMap(clientInfo)
		if len(cli) == 0 && clientIP.String != "" {
			cli = map[string]any{"ip": clientIP.String}
		}
		rec.Client = cli
		logs = append(logs, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	dates := r.queryDistinctDates(ctx)
	if len(dates) == 0 {
		dates = AvailableDatesFromDisk(r.logDir())
	}

	return &ListResult{
		Logs: logs,
		Pagination: map[string]any{
			"page":       page,
			"perPage":    perPage,
			"total":      total,
			"totalPages": totalPages,
		},
		Stats: map[string]any{
			"total":  total,
			"error":  errCnt,
			"warn":   warnCnt,
			"action": actionCnt,
			"info":   infoCnt,
			"save":   saveCnt,
			"delete": delCnt,
		},
		Dates: dates,
	}, nil
}

func (r *MySQLRepository) queryDistinctStrings(ctx context.Context, query string) []string {
	rows, err := r.db.QueryContext(ctx, query)
	if err != nil {
		return []string{}
	}
	defer func() { _ = rows.Close() }()
	out := make([]string, 0)
	for rows.Next() {
		var s sql.NullString
		if err := rows.Scan(&s); err == nil && s.Valid && s.String != "" {
			out = append(out, s.String)
		}
	}
	return out
}

func (r *MySQLRepository) queryDistinctDates(ctx context.Context) []string {
	return r.queryDistinctStrings(ctx, "SELECT DISTINCT DATE(created_at) AS log_date FROM system_logs ORDER BY log_date DESC LIMIT 30")
}

func (r *MySQLRepository) Filters(ctx context.Context) (*FiltersResult, error) {
	if r == nil || r.db == nil {
		return &FiltersResult{
			Modules:      []string{"viewer", "upload", "qbank", "admin", "sender_py"},
			Events:       []string{},
			IPs:          []string{},
			Levels:       []string{"error", "warn", "action", "info"},
			Dates:        AvailableDatesFromDisk(r.logDir()),
			Subjects:     []string{},
			Fingerprints: []string{},
		}, nil
	}
	modules := r.queryDistinctStrings(ctx, "SELECT DISTINCT module FROM system_logs WHERE module IS NOT NULL AND module != '' ORDER BY module")
	hasSenderPy := false
	for _, m := range modules {
		if m == "sender_py" {
			hasSenderPy = true
			break
		}
	}
	if !hasSenderPy {
		modules = append(modules, "sender_py")
	}
	events := r.queryDistinctStrings(ctx, "SELECT DISTINCT event FROM system_logs WHERE event IS NOT NULL AND event != '' ORDER BY event LIMIT 50")
	ips := r.queryDistinctStrings(ctx, "SELECT DISTINCT client_ip FROM system_logs WHERE client_ip IS NOT NULL AND client_ip != '' ORDER BY client_ip LIMIT 50")
	dates := r.queryDistinctDates(ctx)
	if len(dates) == 0 {
		dates = AvailableDatesFromDisk(r.logDir())
	}
	return &FiltersResult{
		Modules:      modules,
		Events:       events,
		IPs:          ips,
		Levels:       []string{"error", "warn", "action", "info"},
		Dates:        dates,
		Subjects:     []string{},
		Fingerprints: []string{},
	}, nil
}

func (r *MySQLRepository) ExportRows(ctx context.Context, filter ListFilter, limit int) ([]ExportRow, error) {
	if r == nil || r.db == nil {
		return nil, errors.New("database is not configured")
	}
	if limit <= 0 || limit > 5000 {
		limit = 5000
	}
	whereSQL, params := buildWhereClause(filter)
	params = append(params, limit)
	rows, err := r.db.QueryContext(
		ctx,
		"SELECT `created_at`, `level`, `module`, `event`, `operator`, `details`, `context`, `client_ip`, `client_info` "+
			"FROM `system_logs` "+whereSQL+" ORDER BY `timestamp` DESC LIMIT ?",
		params...,
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	out := make([]ExportRow, 0)
	for rows.Next() {
		var er ExportRow
		var createdAt, operator, details, ctxRaw, clientIP, clientInfo sql.NullString
		if err := rows.Scan(
			&createdAt, &er.Level, &er.Module, &er.Event,
			&operator, &details, &ctxRaw, &clientIP, &clientInfo,
		); err != nil {
			return nil, err
		}
		er.CreatedAt = createdAt.String
		er.Operator = operator.String
		er.Details = decodeJSONMap(details)
		er.Context = decodeJSONMap(ctxRaw)
		er.ClientIP = clientIP.String
		er.ClientInfo = decodeJSONMap(clientInfo)
		out = append(out, er)
	}
	return out, rows.Err()
}

func (r *MySQLRepository) Stats(ctx context.Context) (*StatsResult, error) {
	res := &StatsResult{
		Dates:         []string{},
		DailyStats:    []DailyStat{},
		RetentionDays: RetentionDays,
	}
	if r == nil || r.db == nil {
		return res, nil
	}
	rows, err := r.db.QueryContext(ctx, `SELECT
		DATE(created_at) AS log_date,
		COUNT(*) AS total,
		COALESCE(SUM(level = 'error'), 0) AS err_cnt,
		COALESCE(SUM(level = 'warn'), 0) AS warn_cnt,
		COALESCE(SUM(level = 'action'), 0) AS action_cnt,
		COALESCE(SUM(level = 'info'), 0) AS info_cnt
		FROM system_logs
		GROUP BY log_date
		ORDER BY log_date DESC
		LIMIT 7`)
	if err != nil {
		return res, err
	}
	defer func() { _ = rows.Close() }()

	for rows.Next() {
		var ds DailyStat
		var d sql.NullString
		if err := rows.Scan(&d, &ds.Total, &ds.Error, &ds.Warn, &ds.Action, &ds.Info); err == nil {
			ds.Date = d.String
			res.Dates = append(res.Dates, ds.Date)
			res.DailyStats = append(res.DailyStats, ds)
		}
	}
	return res, rows.Err()
}

func (r *MySQLRepository) DeleteByDate(ctx context.Context, date string) (int64, error) {
	if r == nil || r.db == nil {
		return 0, nil
	}
	res, err := r.db.ExecContext(ctx, "DELETE FROM `system_logs` WHERE DATE(`created_at`) = ?", date)
	if err != nil {
		return 0, err
	}
	cnt, _ := res.RowsAffected()
	return cnt, nil
}

func (r *MySQLRepository) DeleteByID(ctx context.Context, id string) (int64, error) {
	if r == nil || r.db == nil {
		return 0, nil
	}
	res, err := r.db.ExecContext(ctx, "DELETE FROM `system_logs` WHERE `log_id` = ? OR `id` = ?", id, id)
	if err != nil {
		return 0, err
	}
	cnt, _ := res.RowsAffected()
	return cnt, nil
}
