package admin

import (
	"context"
	"fmt"
)

// HTTPError carries an HTTP status code, user-facing message, and optional payload data.
type HTTPError struct {
	Status  int
	Message string
	Data    any
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("http %d: %s", e.Status, e.Message)
}

// NewHTTPError constructs an HTTPError.
func NewHTTPError(status int, msg string, data any) *HTTPError {
	return &HTTPError{Status: status, Message: msg, Data: data}
}

// AdminUser mirrors a row in `admin_users`.
type AdminUser struct {
	ID           int
	Username     string
	PasswordHash string
	RealName     string
	Role         string
	Status       int
}

// TableSummary mirrors a single entry returned by action=db_tables.
type TableSummary struct {
	Name          string  `json:"name"`
	FriendlyName  string  `json:"friendly_name"`
	Count         int     `json:"count"`
	Rows          int     `json:"rows"`
	Comment       string  `json:"comment"`
	AvgRowLength  int64   `json:"avg_row_length"`
	DataLength    int64   `json:"data_length"`
	AutoIncrement *int64  `json:"auto_increment"`
	UpdateTime    *string `json:"update_time"`
}

// ColumnMeta mirrors a single column entry returned by getTableColumns().
type ColumnMeta struct {
	Field   string  `json:"field"`
	Name    string  `json:"name"`
	Type    string  `json:"type"`
	Null    bool    `json:"null"`
	Key     string  `json:"key"`
	Default *string `json:"default"`
	Extra   string  `json:"extra"`
	Comment string  `json:"comment"`
}

// BatchOption mirrors an entry returned by action=db_batches_options.
type BatchOption struct {
	ID    int            `json:"id"`
	Label string         `json:"label"`
	Raw   map[string]any `json:"raw"`
}

// TeacherOption mirrors a teacher row returned by action=dimensions / db_filter_options.
type TeacherOption struct {
	Username string `json:"username"`
	RealName string `json:"real_name"`
}

// FilterOptions mirrors the response data of action=dimensions / db_filter_options.
type FilterOptions struct {
	Grades         []string        `json:"grades"`
	Tiers          []string        `json:"tiers"`
	Subjects       []string        `json:"subjects"`
	LogLevels      []string        `json:"log_levels"`
	LogModules     []string        `json:"log_modules"`
	Teachers       []TeacherOption `json:"teachers"`
	ActiveTeachers []string        `json:"active_teachers"`
}

// StudentRecordsStats mirrors the response data of action=student_records_stats.
type StudentRecordsStats struct {
	Total    int `json:"total"`
	HasErr   int `json:"has_err"`
	NoErr    int `json:"no_err"`
	Batches  int `json:"batches"`
	Students int `json:"students"`
}

// ListQuery holds all query parameters for action=db_list.
type ListQuery struct {
	Table     string
	Page      int
	PageSize  int
	Search    string
	Sort      string
	Order     string
	Grade     string
	Tier      string
	Subject   string
	BatchID   int
	BatchCode string
	ClassID   int
	WeekNum   int
	HasErrors string
	CreatedBy string
	Year      int
	Season    string
	Week      int
	Level     string
	Module    string
	LogAction string
	Status    string
	Role      string
}

// ListResult mirrors the response payload of action=db_list.
type ListResult struct {
	Table      string           `json:"table"`
	PrimaryKey string           `json:"primary_key"`
	Page       int              `json:"page"`
	PageSize   int              `json:"page_size"`
	PerPage    int              `json:"perPage"`
	Total      int              `json:"total"`
	TotalPages int              `json:"total_pages"`
	TotalPgs   int              `json:"totalPages"`
	Columns    []ColumnMeta     `json:"columns"`
	Schema     []ColumnMeta     `json:"schema"`
	Rows       []map[string]any `json:"rows"`
	Records    []map[string]any `json:"records"`
}

// RollbackResult holds the summary returned after rolling back a student record.
type RollbackResult struct {
	HistoryID      int
	TargetRecordID int
	StudentName    string
	WeekNum        int
}

// QBankRollbackResult holds the summary returned after rolling back a qbank scope to a historical revision.
type QBankRollbackResult struct {
	TargetReceiptCode string `json:"target_receipt_code"`
	TargetRevisionNo  int    `json:"target_revision_no"`
	NewReceiptCode    string `json:"new_receipt_code"`
	NewRevisionNo     int    `json:"new_revision_no"`
	RestoredCount     int    `json:"restored_count"`
	Year              int    `json:"year"`
	Season            string `json:"season"`
	BankType          string `json:"bank_type"`
	Subject           string `json:"subject"`
	Grade             string `json:"grade"`
	Tier              string `json:"tier"`
	Week              int    `json:"week"`
}

// ResetTeacherResult holds the summary returned after resetting a teacher password.
type ResetTeacherResult struct {
	Username string
	RealName string
}

// TokenSearchResult holds the DB search results for action=search_by_token.
type TokenSearchResult struct {
	Matches    []map[string]any `json:"matches"`
	AccessLogs []map[string]any `json:"access_logs"`
}

// SourceFileMeta holds metadata resolved from student_record_history / student_records for source file lookup.
type SourceFileMeta struct {
	BatchCode     string
	StudentName   string
	RefTimestamps []int64
}

// Repository defines all database operations needed by /api/admin.php.
type Repository interface {
	// Auth
	FindAdminByUsername(ctx context.Context, username string) (*AdminUser, error)
	UpdateAdminPasswordHash(ctx context.Context, id int, newHash string) error
	UpsertFallbackAdmin(ctx context.Context, username, newHash string) error
	UpdateAdminLastLogin(ctx context.Context, username, ip string) error

	// Tables & Metadata
	ListTables(ctx context.Context) ([]TableSummary, error)
	GetTableSchema(ctx context.Context, table string) (string, []ColumnMeta, error)
	ListBatchOptions(ctx context.Context) ([]BatchOption, error)
	GetFilterOptions(ctx context.Context) (FilterOptions, error)
	GetStudentRecordsStats(ctx context.Context) (StudentRecordsStats, error)

	// Generic CRUD
	ListRecords(ctx context.Context, q ListQuery) (ListResult, error)
	GetRecord(ctx context.Context, table, id string) (map[string]any, error)
	CreateRecord(ctx context.Context, table string, input map[string]any, retestSecret string) (int64, error)
	UpdateRecord(ctx context.Context, table, id string, input map[string]any, adminOp string) (int64, []string, error)
	DeleteRecords(ctx context.Context, table string, ids []string, currentAdmin string, forceCascade bool) (int64, error)
	ResetTeacherPassword(ctx context.Context, userID int, username, newPassword string) (ResetTeacherResult, error)

	// History & Token & Source File
	ListRecordHistory(ctx context.Context, recordID int, studentName string, batchID int, weekNum *int) ([]map[string]any, error)
	RollbackRecord(ctx context.Context, historyID int, adminOp string) (RollbackResult, error)
	RollbackQBankRevision(ctx context.Context, receiptCode, adminOp, adminName, clientIP string) (QBankRollbackResult, error)
	SearchByToken(ctx context.Context, token, retestSecret string) (TokenSearchResult, error)
	LookupSourceFileMeta(ctx context.Context, recordID, historyID int, batchCode string) (SourceFileMeta, error)
}
