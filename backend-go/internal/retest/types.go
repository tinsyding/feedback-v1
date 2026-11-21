package retest

import (
	"context"
	"fmt"
)

// HTTPError carries an HTTP status code and user-facing error message.
type HTTPError struct {
	Status  int
	Message string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("http %d: %s", e.Status, e.Message)
}

// NewHTTPError constructs an HTTPError.
func NewHTTPError(status int, msg string) *HTTPError {
	return &HTTPError{Status: status, Message: msg}
}

// CheckBatchStudent represents an incoming student for action=check_existing_batch.
type CheckBatchStudent struct {
	Name   string
	ID     string
	Score  float64
	Errors []int
}

// CheckBatchInput holds parameters for action=check_existing_batch.
type CheckBatchInput struct {
	Subject          string
	Grade            string
	Tier             string
	Week             int
	Year             int
	Season           string
	HasIncomingList  bool
	IncomingStudents []CheckBatchStudent
}

// CheckBatchResult mirrors the top-level JSON response of action=check_existing_batch.
type CheckBatchResult struct {
	Success          bool             `json:"success"`
	Exists           bool             `json:"exists"`
	HasDiff          bool             `json:"hasDiff"`
	ModifiedStudents []map[string]any `json:"modifiedStudents"`
	Data             map[string]any   `json:"data,omitempty"`
}

// StudentWeekQuery holds parameters for action=get_student_week_record.
type StudentWeekQuery struct {
	Subject     string
	Grade       string
	Tier        string
	Week        int
	PreviewWeek int
	Year        int
	Season      string
	StudentID   string
	StudentName string
	WithRoster  bool
	SecretKey   string
}

// StudentWeekResult mirrors the top-level JSON response of action=get_student_week_record.
type StudentWeekResult struct {
	Success  bool             `json:"success"`
	Students []map[string]any `json:"students"`
	Record   map[string]any   `json:"record"`
}

// EncryptStudentInput represents one student payload in action=encrypt_batch.
type EncryptStudentInput struct {
	Name                    string
	FullName                string
	ID                      string
	Errors                  []int
	PreviewErrors           []int
	HomeworkScore           *float64
	PreviewScore            *float64
	TotalScore              *float64
	Comment                 string
	PreviewComment          string
	PreviewWeek             int
	PreviewProvided         bool
	SubmissionStatus        string
	PreviewSubmissionStatus string
}

// EncryptBatchInput holds parameters for action=encrypt_batch.
type EncryptBatchInput struct {
	Subject         string
	Grade           string
	Tier            string
	Week            int
	PreviewWeek     int
	HasPreviewData  bool
	HasHomeworkData bool
	IsErrorsOnly    bool
	Year            int
	Season          string
	CurrentTeacher  string
	SourceFiles     []string
	Students        []EncryptStudentInput
	SecretKey       string
}

// EncryptBatchResult holds the outcome of action=encrypt_batch.
type EncryptBatchResult struct {
	BatchCode    string
	ClassName    string
	IsDebounced  bool
	StudentCount int
	Tokens       map[string]string
}

// TokenRecord represents the primary student_records + class_batches row resolved by retest_token.
type TokenRecord struct {
	Subject        string
	Grade          string
	Tier           string
	WeekNum        int
	PreviewWeekNum int
	PreviewErrors  []int
	StudentName    string
	StudentKey     string
	StudentID      string
	Year           int
	Season         string
	UpdatedUnix    int64
}

// StudentRecordRow represents one historical row loaded for decrypt.
type StudentRecordRow struct {
	BatchID                 int
	BatchTier               string
	WeekNum                 int
	PreviewWeekNum          *int
	HomeworkScore           *float64
	PreviewScore            *float64
	TotalScore              *float64
	ErrorCount              int
	ErrorQuestionsRaw       *string
	PreviewErrorsRaw        *string
	TeacherComment          string
	PreviewComment          string
	SubmissionStatus        string
	PreviewSubmissionStatus string
}

// StudentHistoryBundle bundles all DB rows and class averages for a student during decrypt.
type StudentHistoryBundle struct {
	Records            []StudentRecordRow
	WeekAverages       map[string]float64
	WeekAvgByBatchWeek map[string]float64
}

// QbankQuestionRow represents a preloaded row from qbank_questions.
type QbankQuestionRow struct {
	ID                 int
	BankType           string
	Tier               string
	Week               int
	QuestionNum        int
	ParentQuestionNum  int
	ParentQuestionNums string
	SubNum             int
	Topic              string
	VideoURL           string
	QuestionMeta       string
	ExercisePDF        string
	AnswerPDF          string
}

// Repository defines all DB operations required by /api/retest.php.
type Repository interface {
	CheckExistingBatch(ctx context.Context, in CheckBatchInput) (CheckBatchResult, error)
	GetStudentWeekRecord(ctx context.Context, q StudentWeekQuery) (StudentWeekResult, error)
	EncryptBatch(ctx context.Context, in EncryptBatchInput) (EncryptBatchResult, error)

	FindTokenRecord(ctx context.Context, token string) (*TokenRecord, error)
	LoadStudentHistoryAndAverages(ctx context.Context, subject, grade, tier, studentID, studentName string, candidateKeys []string) (StudentHistoryBundle, error)
	PreloadMultiWeekQbankRows(ctx context.Context, subject, grade string, weeks []int, year int, season string) ([]QbankQuestionRow, error)

	IsTokenRevoked(ctx context.Context, token string) (bool, error)
	TokenExists(ctx context.Context, token string, includeRevoked bool) (bool, error)
	RevokeToken(ctx context.Context, token, operator, reason string) error
	UnrevokeToken(ctx context.Context, token string) error
	LogAccess(ctx context.Context, token, studentName, action, details, ip, userAgent string)
}
