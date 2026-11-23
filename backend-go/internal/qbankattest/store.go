package qbankattest

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"feedback-api/internal/qbank"
	"feedback-api/internal/tz"
)

// RecordRevisionInput holds the parameters for recording a new immutable revision into qbank_revisions.
type RecordRevisionInput struct {
	QBankID      int64
	Action       string
	Scope        Scope
	Operator     string
	OperatorName string
	ClientIP     string
	Questions    []SnapshotQuestion
	Now          time.Time
}

// AttemptInput holds the parameters for recording a process event into qbank_attempt_logs.
type AttemptInput struct {
	EventType    string
	Scope        Scope
	Operator     string
	OperatorName string
	ClientIP     string
	Reason       string
	FileURL      string
	FileName     string
	FileSHA256   string
	FileSize     int64
	Details      map[string]any
	Now          time.Time
}

// SupersededByInfo describes the succeeding revision when a receipt is in SUPERSEDED state.
type SupersededByInfo struct {
	ReceiptCode      string   `json:"receipt_code"`
	Action           string   `json:"action"`
	IssuedAtCST      string   `json:"issued_at_cst"`
	OperatorUsername string   `json:"operator_username"`
	OperatorName     string   `json:"operator_name"`
	QuestionCount    int      `json:"question_count"`
	DiffSummary      []string `json:"diff_summary"`
}

// DeletedInfo describes the deletion event when a receipt's scope is in DELETED state.
type DeletedInfo struct {
	ReceiptCode      string `json:"receipt_code"`
	IssuedAtCST      string `json:"issued_at_cst"`
	OperatorUsername string `json:"operator_username"`
	OperatorName     string `json:"operator_name"`
}

// VerifyResult is the public verification response for a receipt code.
// It intentionally contains no snapshot_json or internal PDF paths.
type VerifyResult struct {
	Status            string            `json:"status"`
	SignatureValid    bool              `json:"signature_valid"`
	ChainValid        bool              `json:"chain_valid"`
	Receipt           *Receipt          `json:"receipt,omitempty"`
	SupersededBy      *SupersededByInfo `json:"superseded_by"`
	DeletedInfo       *DeletedInfo      `json:"deleted_info"`
	LatestReceiptCode string            `json:"latest_receipt_code"`
	Anchor            *AnchorProof      `json:"anchor,omitempty"`
}

// ErrRevisionNotFound is returned when a requested receipt_code does not exist.
var ErrRevisionNotFound = errors.New("revision not found")

// RevisionSnapshot holds a revision's metadata and parsed snapshot for admin rollback.
type RevisionSnapshot struct {
	ID          int64    `json:"id"`
	ReceiptCode string   `json:"receipt_code"`
	RevisionNo  int      `json:"revision_no"`
	Action      string   `json:"action"`
	Scope       Scope    `json:"scope"`
	Snapshot    Snapshot `json:"snapshot"`
	CreatedAt   string   `json:"created_at"`
}

// RevisionFilter filters rows returned by ListRevisions.
type RevisionFilter struct {
	BankType string
	Year     *int
	Season   string
	Subject  string
	Grade    string
	Tier     string
	Week     *int
	Operator string
	Limit    int
}

// RevisionItem represents a historical revision entry for teacher/admin audit APIs.
type RevisionItem struct {
	ID                    int64          `json:"id"`
	ReceiptCode           string         `json:"receipt_code"`
	QBankID               int64          `json:"qbank_id"`
	Action                string         `json:"action"`
	BankType              string         `json:"bank_type"`
	Year                  int            `json:"year"`
	Season                string         `json:"season"`
	Subject               string         `json:"subject"`
	Grade                 string         `json:"grade"`
	Tier                  string         `json:"tier"`
	Week                  int            `json:"week"`
	RevisionNo            int            `json:"revision_no"`
	SupersedesReceiptCode string         `json:"supersedes_receipt_code"`
	QuestionCount         int            `json:"question_count"`
	ExercisePDFCount      int            `json:"exercise_pdf_count"`
	AnswerPDFCount        int            `json:"answer_pdf_count"`
	TopicFilledCount      int            `json:"topic_filled_count"`
	ContentSHA256         string         `json:"content_sha256"`
	Operator              string         `json:"operator"`
	OperatorName          string         `json:"operator_name"`
	ClientIP              string         `json:"client_ip,omitempty"`
	IssuedAtUTC           string         `json:"issued_at_utc"`
	IssuedAtCST           string         `json:"issued_at_cst"`
	CreatedAt             string         `json:"created_at"`
	Summary               PayloadSummary `json:"summary"`
	Receipt               *Receipt       `json:"receipt,omitempty"`
}

// TimelineFilter filters combined revision + attempt timeline queries.
type TimelineFilter struct {
	Operator  string
	BankType  string
	Subject   string
	Grade     string
	Tier      string
	Week      *int
	Year      *int
	Season    string
	EventType string
	DateFrom  string
	DateTo    string
	Page      int
	PageSize  int
}

// TimelineItem represents a single entry in the unified admin timeline (revision or attempt).
type TimelineItem struct {
	Source        string         `json:"source"`
	EventType     string         `json:"event_type"`
	ReceiptCode   string         `json:"receipt_code"`
	BankType      string         `json:"bank_type"`
	Year          int            `json:"year"`
	Season        string         `json:"season"`
	Subject       string         `json:"subject"`
	Grade         string         `json:"grade"`
	Tier          string         `json:"tier"`
	Week          int            `json:"week"`
	RevisionNo    int            `json:"revision_no"`
	QuestionCount int            `json:"question_count"`
	Operator      string         `json:"operator"`
	OperatorName  string         `json:"operator_name"`
	ClientIP      string         `json:"client_ip"`
	Reason        string         `json:"reason"`
	FileName      string         `json:"file_name"`
	FileSHA256    string         `json:"file_sha256"`
	Details       map[string]any `json:"details"`
	CreatedAt     string         `json:"created_at"`
}

// TimelineStats summarizes counts across revisions and attempt logs matching scope/operator/date filters.
type TimelineStats struct {
	Revisions       int `json:"revisions"`
	Uploads         int `json:"uploads"`
	BlockedOrFailed int `json:"blocked_or_failed"`
	Cancelled       int `json:"cancelled"`
}

// TimelineResult is the paginated response of ListTimeline.
type TimelineResult struct {
	Items    []TimelineItem `json:"items"`
	Total    int            `json:"total"`
	Page     int            `json:"page"`
	PageSize int            `json:"page_size"`
	Stats    TimelineStats  `json:"stats"`
}

// MatrixFilter filters ListMatrix queries.
type MatrixFilter struct {
	Year     *int
	Season   string
	BankType string
	Subject  string
	Grade    string
	Tier     string
	Search   string
}

// MatrixItem represents one configured topic row aggregated with latest revision and attempt counts.
type MatrixItem struct {
	ID                int64  `json:"id"`
	BankType          string `json:"bank_type"`
	Year              int    `json:"year"`
	Season            string `json:"season"`
	Subject           string `json:"subject"`
	Grade             string `json:"grade"`
	Tier              string `json:"tier"`
	Week              int    `json:"week"`
	QuestionCount     int    `json:"question_count"`
	LatestReceiptCode string `json:"latest_receipt_code"`
	LatestRevisionNo  int    `json:"latest_revision_no"`
	LastAction        string `json:"last_action"`
	UpdatedBy         string `json:"updated_by"`
	UpdatedByName     string `json:"updated_by_name"`
	UpdatedAt         string `json:"updated_at"`
	AttemptCount      int    `json:"attempt_count"`
	RevisionCount     int    `json:"revision_count"`
}

// Store defines the persistence and verification contract for question bank attestation.
type Store interface {
	EnsureKeyRegistered(ctx context.Context) error
	RecordRevisionTx(ctx context.Context, tx *sql.Tx, in RecordRevisionInput) (*Receipt, error)
	RecordAttempt(ctx context.Context, in AttemptInput) error
	VerifyReceipt(ctx context.Context, receiptCode string) (*VerifyResult, error)
	ListRevisions(ctx context.Context, filter RevisionFilter) ([]RevisionItem, error)
	ListTimeline(ctx context.Context, filter TimelineFilter) (*TimelineResult, error)
	ListMatrix(ctx context.Context, filter MatrixFilter) ([]MatrixItem, error)
	ListPublicKeys(ctx context.Context) ([]JWKKey, error)
	HasRecentPDFReference(ctx context.Context, relURL string, maxAge time.Duration) (bool, error)
	GetRevisionSnapshot(ctx context.Context, receiptCode string) (*RevisionSnapshot, error)
	AnchorUnanchoredRevisions(ctx context.Context, tsa TSAClient) (*AnchorRecord, error)
	ListAnchors(ctx context.Context, limit int) ([]AnchorRecord, error)
}

// StoreOption configures optional store behavior.
type StoreOption func(*storeConfig)

type storeConfig struct {
	issuer  string
	nowFunc func() time.Time
}

// WithIssuer overrides ATTESTATION_ISSUER for a Store instance.
func WithIssuer(issuer string) StoreOption {
	return func(c *storeConfig) {
		c.issuer = strings.TrimRight(strings.TrimSpace(issuer), "/")
	}
}

// WithNowFunc overrides the clock used by a Store instance (primarily for tests).
func WithNowFunc(fn func() time.Time) StoreOption {
	return func(c *storeConfig) {
		c.nowFunc = fn
	}
}

func (c storeConfig) resolveIssuer() string {
	if c.issuer != "" {
		return c.issuer
	}
	return ResolveIssuer()
}

func (c storeConfig) now() time.Time {
	if c.nowFunc != nil {
		return c.nowFunc()
	}
	return tz.Now()
}

// internal record shared by MySQLStore and MemoryStore.
type revisionRecord struct {
	id                    int64
	receiptCode           string
	qbankID               int64
	action                string
	scope                 Scope
	revisionNo            int
	supersedesReceiptCode string
	questionCount         int
	exercisePDFCount      int
	answerPDFCount        int
	topicFilledCount      int
	snapshotJSON          string
	contentSHA256         string
	canonicalPayload      string
	prevEntryHash         string
	entryHash             string
	kid                   string
	signature             string
	operator              string
	operatorName          string
	clientIP              string
	issuedAtUTC           string
	createdAt             time.Time
}

type attemptRecord struct {
	id           int64
	eventType    string
	scope        Scope
	operator     string
	operatorName string
	clientIP     string
	reason       string
	fileURL      string
	fileName     string
	fileSHA256   string
	fileSize     int64
	detailsJSON  string
	createdAt    time.Time
}

type keyRecord struct {
	kid       string
	alg       string
	publicKey string
	status    string
	createdAt time.Time
}

func isDeleteAction(action string) bool {
	return action == ActionDelete || action == ActionAdminDelete
}

func normalizeAction(raw string, prevScopeRev *revisionRecord) (string, error) {
	a := strings.TrimSpace(raw)
	switch a {
	case "", "auto":
		if prevScopeRev == nil || isDeleteAction(prevScopeRev.action) {
			return ActionCreate, nil
		}
		return ActionUpdate, nil
	case ActionCreate, ActionUpdate, ActionTierSync, ActionDelete, ActionAdminEdit, ActionAdminDelete, ActionAdminRollback:
		return a, nil
	default:
		return "", fmt.Errorf("unsupported attestation action %q", raw)
	}
}

func buildRevisionAndReceipt(
	signer *Signer,
	feedbackRoot string,
	issuer string,
	in RecordRevisionInput,
	prevScopeRev *revisionRecord,
	prevChainEntryHash string,
	now time.Time,
) (*revisionRecord, *Receipt, error) {
	if signer == nil {
		return nil, nil, errors.New("attestation signer is nil")
	}
	scope := NormalizeScope(in.Scope)
	if scope.Subject == "" || scope.Grade == "" || scope.Tier == "" || scope.Week == 0 {
		return nil, nil, errors.New("incomplete question bank scope for attestation")
	}
	action, err := normalizeAction(in.Action, prevScopeRev)
	if err != nil {
		return nil, nil, err
	}

	if now.IsZero() {
		now = tz.Now()
	}
	issuedAtUTC := now.UTC().Format(time.RFC3339)

	receiptCode, err := GenerateReceiptCode(now)
	if err != nil {
		return nil, nil, fmt.Errorf("generate receipt code: %w", err)
	}

	snapRes, err := BuildSnapshot(feedbackRoot, scope, in.Questions)
	if err != nil {
		return nil, nil, err
	}

	revNo := 1
	supersedes := ""
	if prevScopeRev != nil {
		revNo = prevScopeRev.revisionNo + 1
		supersedes = prevScopeRev.receiptCode
	}

	operator := truncateRunes(strings.TrimSpace(in.Operator), 50)
	operatorName := truncateRunes(strings.TrimSpace(in.OperatorName), 50)
	clientIP := truncateRunes(strings.TrimSpace(in.ClientIP), 45)

	cp := CanonicalPayload{
		Schema:      SchemaV1,
		ReceiptCode: receiptCode,
		Action:      action,
		IssuedAt:    issuedAtUTC,
		Issuer:      issuer,
		Scope:       scope,
		RevisionNo:  revNo,
		Supersedes:  supersedes,
		Operator: OperatorInfo{
			Username: operator,
			RealName: operatorName,
		},
		Summary:       snapRes.Summary,
		ContentSHA256: snapRes.ContentSHA256,
		PrevEntryHash: prevChainEntryHash,
	}
	canonicalStr, err := MarshalCanonicalPayload(cp)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal canonical payload: %w", err)
	}

	sig := signer.Sign([]byte(canonicalStr))
	entryHash := ComputeEntryHash(prevChainEntryHash, receiptCode, snapRes.ContentSHA256, issuedAtUTC)

	rec := &revisionRecord{
		receiptCode:           receiptCode,
		qbankID:               in.QBankID,
		action:                action,
		scope:                 scope,
		revisionNo:            revNo,
		supersedesReceiptCode: supersedes,
		questionCount:         snapRes.Summary.QuestionCount,
		exercisePDFCount:      snapRes.Summary.ExercisePDFCount,
		answerPDFCount:        snapRes.Summary.AnswerPDFCount,
		topicFilledCount:      snapRes.Summary.TopicFilledCount,
		snapshotJSON:          snapRes.SnapshotJSON,
		contentSHA256:         snapRes.ContentSHA256,
		canonicalPayload:      canonicalStr,
		prevEntryHash:         prevChainEntryHash,
		entryHash:             entryHash,
		kid:                   signer.Kid(),
		signature:             sig,
		operator:              operator,
		operatorName:          operatorName,
		clientIP:              clientIP,
		issuedAtUTC:           issuedAtUTC,
		createdAt:             now,
	}

	receipt := recordToReceipt(rec, issuer, &snapRes.Summary)
	return rec, receipt, nil
}

func recordToReceipt(rec *revisionRecord, issuer string, summaryOverride *PayloadSummary) *Receipt {
	if rec == nil {
		return nil
	}
	resolvedIssuer := issuer
	var summary PayloadSummary
	if summaryOverride != nil {
		summary = *summaryOverride
	}
	if cp, err := ParseCanonicalPayload(rec.canonicalPayload); err == nil {
		if cp.Issuer != "" {
			resolvedIssuer = cp.Issuer
		}
		if summaryOverride == nil {
			summary = cp.Summary
		}
	}
	if summary.Topics == nil {
		summary.Topics = []TopicSummary{}
	}
	if resolvedIssuer == "" {
		resolvedIssuer = DefaultIssuer
	}

	return &Receipt{
		Schema:           SchemaV1,
		ReceiptCode:      rec.receiptCode,
		Action:           rec.action,
		IssuedAt:         rec.issuedAtUTC,
		IssuedAtCST:      FormatIssuedAtCST(rec.issuedAtUTC),
		Issuer:           resolvedIssuer,
		Scope:            rec.scope,
		RevisionNo:       rec.revisionNo,
		Supersedes:       rec.supersedesReceiptCode,
		Operator:         OperatorInfo{Username: rec.operator, RealName: rec.operatorName},
		Summary:          summary,
		ContentSHA256:    rec.contentSHA256,
		PrevEntryHash:    rec.prevEntryHash,
		EntryHash:        rec.entryHash,
		Kid:              rec.kid,
		Signature:        rec.signature,
		CanonicalPayload: rec.canonicalPayload,
		VerifyURL:        BuildVerifyURL(resolvedIssuer, rec.receiptCode),
	}
}

func recordToRevisionItem(rec *revisionRecord, issuer string) RevisionItem {
	receipt := recordToReceipt(rec, issuer, nil)
	createdStr := ""
	if !rec.createdAt.IsZero() {
		createdStr = tz.In(rec.createdAt).Format("2006-01-02 15:04:05")
	}
	return RevisionItem{
		ID:                    rec.id,
		ReceiptCode:           rec.receiptCode,
		QBankID:               rec.qbankID,
		Action:                rec.action,
		BankType:              rec.scope.BankType,
		Year:                  rec.scope.Year,
		Season:                rec.scope.Season,
		Subject:               rec.scope.Subject,
		Grade:                 rec.scope.Grade,
		Tier:                  rec.scope.Tier,
		Week:                  rec.scope.Week,
		RevisionNo:            rec.revisionNo,
		SupersedesReceiptCode: rec.supersedesReceiptCode,
		QuestionCount:         rec.questionCount,
		ExercisePDFCount:      rec.exercisePDFCount,
		AnswerPDFCount:        rec.answerPDFCount,
		TopicFilledCount:      rec.topicFilledCount,
		ContentSHA256:         rec.contentSHA256,
		Operator:              rec.operator,
		OperatorName:          rec.operatorName,
		ClientIP:              rec.clientIP,
		IssuedAtUTC:           rec.issuedAtUTC,
		IssuedAtCST:           FormatIssuedAtCST(rec.issuedAtUTC),
		CreatedAt:             createdStr,
		Summary:               receipt.Summary,
		Receipt:               receipt,
	}
}

func evaluateVerification(
	rec *revisionRecord,
	nextRev *revisionRecord,
	latestRev *revisionRecord,
	dbKey *keyRecord,
	prevRowEntryHash string,
	hasPrevRow bool,
	signer *Signer,
	issuer string,
) *VerifyResult {
	if rec == nil {
		return &VerifyResult{Status: StatusNotFound}
	}

	// 1. Cryptographic signature + canonical consistency + snapshot integrity check.
	sigValid := false
	cp, cpErr := ParseCanonicalPayload(rec.canonicalPayload)
	if cpErr == nil && canonicalMatchesRecord(cp, rec) && snapshotMatchesContentHash(rec.snapshotJSON, rec.contentSHA256) {
		if dbKey != nil && dbKey.status != KeyStatusRevoked && dbKey.publicKey != "" {
			keyConsistent := true
			if signer != nil && rec.kid == signer.Kid() && dbKey.publicKey != signer.PublicKeyBase64URL() {
				keyConsistent = false
			}
			if keyConsistent && Verify(dbKey.publicKey, []byte(rec.canonicalPayload), rec.signature) {
				sigValid = true
			}
		}
	}

	// 2. Hash chain check (self hash + predecessor link).
	expectedHash := ComputeEntryHash(rec.prevEntryHash, rec.receiptCode, rec.contentSHA256, rec.issuedAtUTC)
	chainValid := expectedHash == rec.entryHash
	if chainValid {
		if !hasPrevRow {
			chainValid = rec.prevEntryHash == ""
		} else {
			chainValid = prevRowEntryHash != "" && prevRowEntryHash == rec.prevEntryHash
		}
	}

	if latestRev == nil {
		latestRev = rec
	}

	res := &VerifyResult{
		Status:            StatusValid,
		SignatureValid:    sigValid,
		ChainValid:        chainValid,
		Receipt:           recordToReceipt(rec, issuer, nil),
		LatestReceiptCode: latestRev.receiptCode,
	}

	switch {
	case isDeleteAction(latestRev.action):
		res.Status = StatusDeleted
		res.DeletedInfo = &DeletedInfo{
			ReceiptCode:      latestRev.receiptCode,
			IssuedAtCST:      FormatIssuedAtCST(latestRev.issuedAtUTC),
			OperatorUsername: latestRev.operator,
			OperatorName:     latestRev.operatorName,
		}
	case nextRev != nil:
		res.Status = StatusSuperseded
		res.SupersededBy = &SupersededByInfo{
			ReceiptCode:      nextRev.receiptCode,
			Action:           nextRev.action,
			IssuedAtCST:      FormatIssuedAtCST(nextRev.issuedAtUTC),
			OperatorUsername: nextRev.operator,
			OperatorName:     nextRev.operatorName,
			QuestionCount:    nextRev.questionCount,
			DiffSummary:      DiffSnapshots(rec.snapshotJSON, nextRev.snapshotJSON),
		}
	default:
		res.Status = StatusValid
	}

	return res
}

func canonicalMatchesRecord(cp *CanonicalPayload, rec *revisionRecord) bool {
	if cp == nil || rec == nil {
		return false
	}
	return cp.Schema == SchemaV1 &&
		cp.ReceiptCode == rec.receiptCode &&
		cp.Action == rec.action &&
		cp.IssuedAt == rec.issuedAtUTC &&
		cp.RevisionNo == rec.revisionNo &&
		cp.Supersedes == rec.supersedesReceiptCode &&
		cp.ContentSHA256 == rec.contentSHA256 &&
		cp.PrevEntryHash == rec.prevEntryHash &&
		cp.Scope == rec.scope &&
		cp.Operator.Username == rec.operator
}

func snapshotMatchesContentHash(snapshotJSON, contentSHA256 string) bool {
	if strings.TrimSpace(snapshotJSON) == "" {
		return false
	}
	return SHA256Hex([]byte(snapshotJSON)) == contentSHA256
}

func truncateRunes(s string, max int) string {
	if max <= 0 || utf8.RuneCountInString(s) <= max {
		return s
	}
	runes := []rune(s)
	return string(runes[:max])
}

func isValidAttemptEventType(et string) bool {
	switch et {
	case EventUploadPDF, EventSaveRejected, EventSaveError, EventSaveCancelled, EventClientBlocked:
		return true
	default:
		return false
	}
}

type timelineEventFilterSpec struct {
	wantRevisions   bool
	wantAttempts    bool
	revisionActions []string
	attemptEvents   []string
}

func parseTimelineEventFilter(raw string) timelineEventFilterSpec {
	s := strings.TrimSpace(raw)
	if s == "" || s == "all" {
		return timelineEventFilterSpec{wantRevisions: true, wantAttempts: true}
	}
	if s == "blocked_or_failed" {
		return timelineEventFilterSpec{
			wantAttempts:  true,
			attemptEvents: []string{EventClientBlocked, EventSaveRejected, EventSaveError},
		}
	}
	if s == "blocked" {
		return timelineEventFilterSpec{
			wantAttempts:  true,
			attemptEvents: []string{EventClientBlocked, EventSaveRejected},
		}
	}

	var spec timelineEventFilterSpec
	allRevisions := false
	for _, p := range strings.Split(s, ",") {
		token := strings.TrimSpace(p)
		switch token {
		case "":
		case "revision", "revisions":
			allRevisions = true
			spec.wantRevisions = true
		case "blocked_or_failed":
			spec.wantAttempts = true
			spec.attemptEvents = append(spec.attemptEvents, EventClientBlocked, EventSaveRejected, EventSaveError)
		case "blocked":
			spec.wantAttempts = true
			spec.attemptEvents = append(spec.attemptEvents, EventClientBlocked, EventSaveRejected)
		case ActionCreate, ActionUpdate, ActionTierSync, ActionDelete, ActionAdminEdit, ActionAdminDelete, ActionAdminRollback:
			spec.wantRevisions = true
			spec.revisionActions = append(spec.revisionActions, token)
		case EventUploadPDF, EventSaveRejected, EventSaveError, EventSaveCancelled, EventClientBlocked:
			spec.wantAttempts = true
			spec.attemptEvents = append(spec.attemptEvents, token)
		default:
			spec.wantAttempts = true
			spec.attemptEvents = append(spec.attemptEvents, token)
		}
	}
	if allRevisions {
		spec.revisionActions = nil
	}
	return spec
}

func normalizeTimelinePagination(page, pageSize int) (int, int, int) {
	if page <= 0 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = 20
	}
	if pageSize > 200 {
		pageSize = 200
	}
	offset := (page - 1) * pageSize
	return page, pageSize, offset
}

func parseDateBound(raw string, endOfDay bool) (time.Time, bool, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return time.Time{}, false, false
	}
	loc := tz.Shanghai()
	if len(s) == 10 {
		if t, err := time.ParseInLocation("2006-01-02", s, loc); err == nil {
			if endOfDay {
				return t.AddDate(0, 0, 1), true, true
			}
			return t, false, true
		}
	}
	for _, layout := range []string{"2006-01-02 15:04:05", time.RFC3339} {
		if t, err := time.ParseInLocation(layout, s, loc); err == nil {
			return t, false, true
		}
	}
	return time.Time{}, false, false
}

func decodeDetailsJSON(raw string) map[string]any {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		return nil
	}
	return m
}

func buildRevisionDetails(rec *revisionRecord) map[string]any {
	if rec == nil {
		return nil
	}
	return map[string]any{
		"content_sha256":          rec.contentSHA256,
		"supersedes_receipt_code": rec.supersedesReceiptCode,
		"exercise_pdf_count":      rec.exercisePDFCount,
		"answer_pdf_count":        rec.answerPDFCount,
		"topic_filled_count":      rec.topicFilledCount,
	}
}

// ---------- MySQLStore ----------

// MySQLStore implements Store backed by MySQL 8.0 (*sql.DB).
type MySQLStore struct {
	db           *sql.DB
	signer       *Signer
	feedbackRoot string
	cfg          storeConfig
}

// NewMySQLStore creates a MySQLStore.
func NewMySQLStore(db *sql.DB, signer *Signer, feedbackRoot string, opts ...StoreOption) *MySQLStore {
	var cfg storeConfig
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}
	return &MySQLStore{
		db:           db,
		signer:       signer,
		feedbackRoot: feedbackRoot,
		cfg:          cfg,
	}
}

func (s *MySQLStore) requireDB() (*sql.DB, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("attestation database is not configured")
	}
	return s.db, nil
}

// EnsureKeyRegistered ensures the active signer public key is registered in qbank_attestation_keys
// without issuing UPDATE statements (compatible with append-only BEFORE UPDATE triggers).
func (s *MySQLStore) EnsureKeyRegistered(ctx context.Context) error {
	db, err := s.requireDB()
	if err != nil {
		return err
	}
	if s.signer == nil {
		return errors.New("attestation signer is not configured")
	}

	var existingPub, existingStatus string
	err = db.QueryRowContext(
		ctx,
		"SELECT `public_key`, `status` FROM `qbank_attestation_keys` WHERE `kid` = ? LIMIT 1",
		s.signer.Kid(),
	).Scan(&existingPub, &existingStatus)
	if err == nil {
		if existingPub != s.signer.PublicKeyBase64URL() {
			return fmt.Errorf("attestation key id %q already registered with a different public key", s.signer.Kid())
		}
		if existingStatus == KeyStatusRevoked {
			return fmt.Errorf("attestation key id %q is revoked", s.signer.Kid())
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}

	_, err = db.ExecContext(
		ctx,
		"INSERT IGNORE INTO `qbank_attestation_keys` (`kid`, `alg`, `public_key`, `status`) VALUES (?, ?, ?, ?)",
		s.signer.Kid(), s.signer.Alg(), s.signer.PublicKeyBase64URL(), KeyStatusActive,
	)
	return err
}

type sqlQueryRower interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// RecordRevisionTx locks the hash chain tail and scope head inside tx (or opens a transaction if tx == nil),
// signs a CanonicalPayload, and inserts the new immutable revision into qbank_revisions.
func (s *MySQLStore) RecordRevisionTx(ctx context.Context, tx *sql.Tx, in RecordRevisionInput) (*Receipt, error) {
	if s == nil || s.signer == nil {
		return nil, errors.New("attestation signer is not configured")
	}

	var runner sqlQueryRower
	var ownedTx *sql.Tx
	if tx != nil {
		runner = tx
	} else {
		db, err := s.requireDB()
		if err != nil {
			return nil, err
		}
		ownedTx, err = db.BeginTx(ctx, nil)
		if err != nil {
			return nil, err
		}
		defer func() { _ = ownedTx.Rollback() }()
		runner = ownedTx
	}

	// Lock the signer's key row first (concrete primary key record lock) to serialize chain appends
	// without empty-table gap-lock deadlocks, then lock the chain tail and scope head in fixed order.
	var lockedKid string
	if err := runner.QueryRowContext(
		ctx,
		"SELECT `kid` FROM `qbank_attestation_keys` WHERE `kid` = ? LIMIT 1 FOR UPDATE",
		s.signer.Kid(),
	).Scan(&lockedKid); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}

	var prevChainHash sql.NullString
	err := runner.QueryRowContext(
		ctx,
		"SELECT `entry_hash` FROM `qbank_revisions` ORDER BY `id` DESC LIMIT 1 FOR UPDATE",
	).Scan(&prevChainHash)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}

	normScope := NormalizeScope(in.Scope)
	var prevScopeRev *revisionRecord
	var prevRevNo int
	var prevCode, prevAction sql.NullString
	err = runner.QueryRowContext(
		ctx,
		"SELECT `revision_no`, `receipt_code`, `action` FROM `qbank_revisions` "+
			"WHERE `year` = ? AND `season` = ? AND `bank_type` = ? AND `subject` = ? AND `grade` = ? AND `tier` = ? AND `week` = ? "+
			"ORDER BY `revision_no` DESC, `id` DESC LIMIT 1 FOR UPDATE",
		normScope.Year, normScope.Season, normScope.BankType, normScope.Subject, normScope.Grade, normScope.Tier, normScope.Week,
	).Scan(&prevRevNo, &prevCode, &prevAction)
	if err == nil {
		prevScopeRev = &revisionRecord{
			revisionNo:  prevRevNo,
			receiptCode: prevCode.String,
			action:      prevAction.String,
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}

	// Best-effort resolve operator real_name if not supplied.
	if strings.TrimSpace(in.OperatorName) == "" && strings.TrimSpace(in.Operator) != "" {
		in.OperatorName = s.lookupOperatorName(ctx, runner, strings.TrimSpace(in.Operator), in.Action)
	}

	now := in.Now
	if now.IsZero() {
		now = s.cfg.now()
	}
	rec, receipt, err := buildRevisionAndReceipt(
		s.signer,
		s.feedbackRoot,
		s.cfg.resolveIssuer(),
		in,
		prevScopeRev,
		prevChainEntryHash(prevChainHash),
		now,
	)
	if err != nil {
		return nil, err
	}

	var supersedesArg any
	if rec.supersedesReceiptCode != "" {
		supersedesArg = rec.supersedesReceiptCode
	}
	_, err = runner.ExecContext(
		ctx,
		"INSERT INTO `qbank_revisions` ("+
			"`receipt_code`, `qbank_id`, `action`, `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week`, "+
			"`revision_no`, `supersedes_receipt_code`, `question_count`, `exercise_pdf_count`, `answer_pdf_count`, `topic_filled_count`, "+
			"`snapshot_json`, `content_sha256`, `canonical_payload`, `prev_entry_hash`, `entry_hash`, `kid`, `signature`, "+
			"`operator`, `operator_name`, `client_ip`, `issued_at_utc`"+
			") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		rec.receiptCode, rec.qbankID, rec.action,
		rec.scope.BankType, rec.scope.Year, rec.scope.Season, rec.scope.Subject, rec.scope.Grade, rec.scope.Tier, rec.scope.Week,
		rec.revisionNo, supersedesArg, rec.questionCount, rec.exercisePDFCount, rec.answerPDFCount, rec.topicFilledCount,
		rec.snapshotJSON, rec.contentSHA256, rec.canonicalPayload, rec.prevEntryHash, rec.entryHash, rec.kid, rec.signature,
		rec.operator, rec.operatorName, rec.clientIP, rec.issuedAtUTC,
	)
	if err != nil {
		return nil, err
	}

	if ownedTx != nil {
		if err := ownedTx.Commit(); err != nil {
			return nil, err
		}
	}
	return receipt, nil
}

func prevChainEntryHash(ns sql.NullString) string {
	if !ns.Valid {
		return ""
	}
	return strings.TrimSpace(ns.String)
}

func (s *MySQLStore) lookupOperatorName(ctx context.Context, runner sqlQueryRower, username, action string) string {
	var name sql.NullString
	if action == ActionAdminEdit || action == ActionAdminDelete || action == ActionAdminRollback {
		if err := runner.QueryRowContext(ctx, "SELECT `real_name` FROM `admin_users` WHERE `username` = ? LIMIT 1", username).Scan(&name); err == nil && name.String != "" {
			return name.String
		}
	}
	if err := runner.QueryRowContext(ctx, "SELECT `real_name` FROM `users` WHERE `username` = ? LIMIT 1", username).Scan(&name); err == nil {
		return name.String
	}
	return ""
}

// RecordAttempt inserts a process event into qbank_attempt_logs.
func (s *MySQLStore) RecordAttempt(ctx context.Context, in AttemptInput) error {
	db, err := s.requireDB()
	if err != nil {
		return err
	}
	eventType := strings.TrimSpace(in.EventType)
	if !isValidAttemptEventType(eventType) {
		return fmt.Errorf("invalid attempt event_type %q", in.EventType)
	}

	op := truncateRunes(strings.TrimSpace(in.Operator), 50)
	opName := truncateRunes(strings.TrimSpace(in.OperatorName), 50)
	if opName == "" && op != "" {
		opName = truncateRunes(s.lookupOperatorName(ctx, db, op, ""), 50)
	}

	bankType := strings.TrimSpace(in.Scope.BankType)
	if bankType != "" {
		bankType = qbank.NormalizeBankType(bankType)
	}

	var detailsArg any
	if len(in.Details) > 0 {
		if b, err := MarshalCanonicalJSON(in.Details); err == nil {
			detailsArg = string(b)
		}
	}

	_, err = db.ExecContext(
		ctx,
		"INSERT INTO `qbank_attempt_logs` ("+
			"`event_type`, `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week`, "+
			"`operator`, `operator_name`, `client_ip`, `reason`, `file_url`, `file_name`, `file_sha256`, `file_size`, `details_json`"+
			") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		eventType,
		bankType,
		in.Scope.Year,
		truncateRunes(strings.TrimSpace(in.Scope.Season), 20),
		truncateRunes(strings.TrimSpace(in.Scope.Subject), 30),
		truncateRunes(strings.TrimSpace(in.Scope.Grade), 30),
		truncateRunes(strings.TrimSpace(in.Scope.Tier), 20),
		in.Scope.Week,
		op,
		opName,
		truncateRunes(strings.TrimSpace(in.ClientIP), 45),
		truncateRunes(strings.TrimSpace(in.Reason), 255),
		truncateRunes(strings.TrimSpace(in.FileURL), 255),
		truncateRunes(strings.TrimSpace(in.FileName), 255),
		truncateRunes(strings.ToLower(strings.TrimSpace(in.FileSHA256)), 64),
		in.FileSize,
		detailsArg,
	)
	return err
}

const revisionSelectCols = "`id`, `receipt_code`, `qbank_id`, `action`, `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week`, " +
	"`revision_no`, `supersedes_receipt_code`, `question_count`, `exercise_pdf_count`, `answer_pdf_count`, `topic_filled_count`, " +
	"`snapshot_json`, `content_sha256`, `canonical_payload`, `prev_entry_hash`, `entry_hash`, `kid`, `signature`, " +
	"`operator`, `operator_name`, `client_ip`, `issued_at_utc`, `created_at`"

type rowScanner interface {
	Scan(dest ...any) error
}

func scanRevisionRecord(sc rowScanner) (*revisionRecord, error) {
	var rec revisionRecord
	var supersedes, snapshot, canonical, prevHash, entryHash, op, opName, ip sql.NullString
	var createdAt sql.NullTime
	err := sc.Scan(
		&rec.id, &rec.receiptCode, &rec.qbankID, &rec.action,
		&rec.scope.BankType, &rec.scope.Year, &rec.scope.Season, &rec.scope.Subject, &rec.scope.Grade, &rec.scope.Tier, &rec.scope.Week,
		&rec.revisionNo, &supersedes, &rec.questionCount, &rec.exercisePDFCount, &rec.answerPDFCount, &rec.topicFilledCount,
		&snapshot, &rec.contentSHA256, &canonical, &prevHash, &entryHash, &rec.kid, &rec.signature,
		&op, &opName, &ip, &rec.issuedAtUTC, &createdAt,
	)
	if err != nil {
		return nil, err
	}
	rec.supersedesReceiptCode = supersedes.String
	rec.snapshotJSON = snapshot.String
	rec.canonicalPayload = canonical.String
	rec.prevEntryHash = prevHash.String
	rec.entryHash = entryHash.String
	rec.operator = op.String
	rec.operatorName = opName.String
	rec.clientIP = ip.String
	if createdAt.Valid {
		rec.createdAt = createdAt.Time
	}
	return &rec, nil
}

// VerifyReceipt retrieves a receipt by code, independently validates DB public key, signer consistency,
// signature, hash chain integrity, and scope lifecycle status (VALID / SUPERSEDED / DELETED / NOT_FOUND).
func (s *MySQLStore) VerifyReceipt(ctx context.Context, receiptCode string) (*VerifyResult, error) {
	db, err := s.requireDB()
	if err != nil {
		return nil, err
	}
	code := strings.TrimSpace(receiptCode)
	if code == "" {
		return &VerifyResult{Status: StatusNotFound}, nil
	}

	rec, err := scanRevisionRecord(db.QueryRowContext(
		ctx,
		"SELECT "+revisionSelectCols+" FROM `qbank_revisions` WHERE `receipt_code` = ? LIMIT 1",
		code,
	))
	if errors.Is(err, sql.ErrNoRows) {
		return &VerifyResult{Status: StatusNotFound}, nil
	}
	if err != nil {
		return nil, err
	}

	var dbKey *keyRecord
	var kPub, kStatus sql.NullString
	err = db.QueryRowContext(
		ctx,
		"SELECT `public_key`, `status` FROM `qbank_attestation_keys` WHERE `kid` = ? LIMIT 1",
		rec.kid,
	).Scan(&kPub, &kStatus)
	if err == nil {
		dbKey = &keyRecord{kid: rec.kid, publicKey: kPub.String, status: kStatus.String}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}

	var prevRowEntryHash string
	var hasPrevRow bool
	var prevHash sql.NullString
	err = db.QueryRowContext(
		ctx,
		"SELECT `entry_hash` FROM `qbank_revisions` WHERE `id` < ? ORDER BY `id` DESC LIMIT 1",
		rec.id,
	).Scan(&prevHash)
	if err == nil {
		hasPrevRow = true
		prevRowEntryHash = prevHash.String
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}

	var nextRev *revisionRecord
	nextCandidate, err := scanRevisionRecord(db.QueryRowContext(
		ctx,
		"SELECT "+revisionSelectCols+" FROM `qbank_revisions` "+
			"WHERE `year` = ? AND `season` = ? AND `bank_type` = ? AND `subject` = ? AND `grade` = ? AND `tier` = ? AND `week` = ? AND `revision_no` > ? "+
			"ORDER BY `revision_no` ASC, `id` ASC LIMIT 1",
		rec.scope.Year, rec.scope.Season, rec.scope.BankType, rec.scope.Subject, rec.scope.Grade, rec.scope.Tier, rec.scope.Week, rec.revisionNo,
	))
	if err == nil {
		nextRev = nextCandidate
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}

	var latestRev *revisionRecord
	latestCandidate, err := scanRevisionRecord(db.QueryRowContext(
		ctx,
		"SELECT "+revisionSelectCols+" FROM `qbank_revisions` "+
			"WHERE `year` = ? AND `season` = ? AND `bank_type` = ? AND `subject` = ? AND `grade` = ? AND `tier` = ? AND `week` = ? "+
			"ORDER BY `revision_no` DESC, `id` DESC LIMIT 1",
		rec.scope.Year, rec.scope.Season, rec.scope.BankType, rec.scope.Subject, rec.scope.Grade, rec.scope.Tier, rec.scope.Week,
	))
	if err == nil {
		latestRev = latestCandidate
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}

	res := evaluateVerification(rec, nextRev, latestRev, dbKey, prevRowEntryHash, hasPrevRow, s.signer, s.cfg.resolveIssuer())
	if anchor, err := s.findAnchorProofForRevision(ctx, db, rec.id); err == nil && anchor != nil {
		res.Anchor = anchor
	}
	return res, nil
}

func (s *MySQLStore) findAnchorProofForRevision(ctx context.Context, db *sql.DB, revID int64) (*AnchorProof, error) {
	var anc AnchorRecord
	var tsaToken, tsaGenTime sql.NullString
	var anchoredAt time.Time
	err := db.QueryRowContext(
		ctx,
		"SELECT `id`, `anchor_code`, `seq_from`, `seq_to`, `revision_count`, `merkle_root`, `tsa_url`, `tsa_status`, `tsa_token_b64`, `tsa_gen_time`, `anchored_at` "+
			"FROM `qbank_attestation_anchors` WHERE `seq_from` <= ? AND `seq_to` >= ? ORDER BY `id` DESC LIMIT 1",
		revID, revID,
	).Scan(&anc.ID, &anc.AnchorCode, &anc.SeqFrom, &anc.SeqTo, &anc.RevisionCount, &anc.MerkleRoot, &anc.TSAURL, &anc.TSAStatus, &tsaToken, &tsaGenTime, &anchoredAt)
	if err != nil {
		return nil, err
	}
	anc.TSATokenB64 = tsaToken.String
	anc.TSAGenTime = tsaGenTime.String
	anc.AnchoredAt = formatReceiptTimestamp(anchoredAt)

	rows, err := db.QueryContext(
		ctx,
		"SELECT `id`, `entry_hash` FROM `qbank_revisions` WHERE `id` BETWEEN ? AND ? ORDER BY `id` ASC",
		anc.SeqFrom, anc.SeqTo,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []int64
	var hashes []string
	for rows.Next() {
		var id int64
		var eh string
		if err := rows.Scan(&id, &eh); err != nil {
			return nil, err
		}
		ids = append(ids, id)
		hashes = append(hashes, eh)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return buildAnchorProofFromHashes(anc, ids, hashes, revID), nil
}

// GetRevisionSnapshot retrieves a historical revision and decodes its snapshot_json for admin rollback.
func (s *MySQLStore) GetRevisionSnapshot(ctx context.Context, receiptCode string) (*RevisionSnapshot, error) {
	db, err := s.requireDB()
	if err != nil {
		return nil, err
	}
	code := strings.TrimSpace(receiptCode)
	if code == "" {
		return nil, ErrRevisionNotFound
	}
	rec, err := scanRevisionRecord(db.QueryRowContext(
		ctx,
		"SELECT "+revisionSelectCols+" FROM `qbank_revisions` WHERE `receipt_code` = ? LIMIT 1",
		code,
	))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrRevisionNotFound
	}
	if err != nil {
		return nil, err
	}
	var snap Snapshot
	if err := json.Unmarshal([]byte(rec.snapshotJSON), &snap); err != nil {
		return nil, fmt.Errorf("decode snapshot_json: %w", err)
	}
	return &RevisionSnapshot{
		ID:          rec.id,
		ReceiptCode: rec.receiptCode,
		RevisionNo:  rec.revisionNo,
		Action:      rec.action,
		Scope:       rec.scope,
		Snapshot:    snap,
		CreatedAt:   formatReceiptTimestamp(rec.createdAt),
	}, nil
}

// AnchorUnanchoredRevisions batches all qbank_revisions after the latest anchored seq_to
// into an RFC 6962 SHA-256 Merkle tree, optionally requests an RFC 3161 TSA timestamp,
// and appends an immutable record to qbank_attestation_anchors.
func (s *MySQLStore) AnchorUnanchoredRevisions(ctx context.Context, tsa TSAClient) (*AnchorRecord, error) {
	db, err := s.requireDB()
	if err != nil {
		return nil, err
	}

	var lastSeq int64
	if err := db.QueryRowContext(ctx, "SELECT COALESCE(MAX(`seq_to`), 0) FROM `qbank_attestation_anchors`").Scan(&lastSeq); err != nil {
		return nil, err
	}

	rows, err := db.QueryContext(
		ctx,
		"SELECT `id`, `entry_hash` FROM `qbank_revisions` WHERE `id` > ? ORDER BY `id` ASC LIMIT 10000",
		lastSeq,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []int64
	var hashes []string
	for rows.Next() {
		var id int64
		var eh string
		if err := rows.Scan(&id, &eh); err != nil {
			return nil, err
		}
		ids = append(ids, id)
		hashes = append(hashes, eh)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return nil, nil
	}

	merkleRoot, _, err := ComputeMerkleTree(hashes)
	if err != nil {
		return nil, err
	}
	rootBytes, err := hex.DecodeString(merkleRoot)
	if err != nil {
		return nil, err
	}

	now := s.cfg.now().UTC()
	anc := AnchorRecord{
		AnchorCode:    generateAnchorCode(now),
		SeqFrom:       ids[0],
		SeqTo:         ids[len(ids)-1],
		RevisionCount: len(ids),
		MerkleRoot:    merkleRoot,
		TSAStatus:     TSAStatusLocalOnly,
		AnchoredAt:    formatReceiptTimestamp(now),
	}
	if tsa != nil && strings.TrimSpace(tsa.Endpoint()) != "" {
		anc.TSAURL = strings.TrimSpace(tsa.Endpoint())
		if resp, tsaErr := tsa.Timestamp(ctx, rootBytes); tsaErr == nil && resp != nil {
			anc.TSAStatus = TSAStatusAnchored
			anc.TSATokenB64 = resp.TokenB64
			anc.TSAGenTime = resp.GenTime
		}
	}

	var tokenNull, genTimeNull sql.NullString
	if anc.TSATokenB64 != "" {
		tokenNull = sql.NullString{String: anc.TSATokenB64, Valid: true}
	}
	if anc.TSAGenTime != "" {
		genTimeNull = sql.NullString{String: anc.TSAGenTime, Valid: true}
	}
	res, err := db.ExecContext(
		ctx,
		"INSERT INTO `qbank_attestation_anchors` (`anchor_code`, `seq_from`, `seq_to`, `revision_count`, `merkle_root`, `tsa_url`, `tsa_status`, `tsa_token_b64`, `tsa_gen_time`, `anchored_at`) "+
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		anc.AnchorCode, anc.SeqFrom, anc.SeqTo, anc.RevisionCount, anc.MerkleRoot, anc.TSAURL, anc.TSAStatus, tokenNull, genTimeNull, tz.In(now),
	)
	if err != nil {
		return nil, err
	}
	if id, err := res.LastInsertId(); err == nil {
		anc.ID = id
	}
	return &anc, nil
}

// ListAnchors returns recent Merkle anchor batches ordered newest-first.
func (s *MySQLStore) ListAnchors(ctx context.Context, limit int) ([]AnchorRecord, error) {
	db, err := s.requireDB()
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 20
	}
	if limit > 200 {
		limit = 200
	}
	rows, err := db.QueryContext(
		ctx,
		"SELECT `id`, `anchor_code`, `seq_from`, `seq_to`, `revision_count`, `merkle_root`, `tsa_url`, `tsa_status`, `tsa_token_b64`, `tsa_gen_time`, `anchored_at` "+
			"FROM `qbank_attestation_anchors` ORDER BY `id` DESC LIMIT ?",
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]AnchorRecord, 0)
	for rows.Next() {
		var anc AnchorRecord
		var tsaToken, tsaGenTime sql.NullString
		var anchoredAt time.Time
		if err := rows.Scan(&anc.ID, &anc.AnchorCode, &anc.SeqFrom, &anc.SeqTo, &anc.RevisionCount, &anc.MerkleRoot, &anc.TSAURL, &anc.TSAStatus, &tsaToken, &tsaGenTime, &anchoredAt); err != nil {
			return nil, err
		}
		anc.TSATokenB64 = tsaToken.String
		anc.TSAGenTime = tsaGenTime.String
		anc.AnchoredAt = formatReceiptTimestamp(anchoredAt)
		out = append(out, anc)
	}
	return out, rows.Err()
}

func formatReceiptTimestamp(t time.Time) string {
	return tz.In(t).Format("2006-01-02 15:04:05")
}

func generateAnchorCode(now time.Time) string {
	var b [2]byte
	_, _ = rand.Read(b[:])
	return fmt.Sprintf("ANC-%s-%04X", tz.In(now).Format("20060102-150405"), b)
}

func buildAnchorProofFromHashes(anc AnchorRecord, ids []int64, hashes []string, targetID int64) *AnchorProof {
	if len(ids) == 0 || len(ids) != len(hashes) {
		return nil
	}
	targetIdx := -1
	for i, id := range ids {
		if id == targetID {
			targetIdx = i
			break
		}
	}
	if targetIdx < 0 {
		return nil
	}
	root, proofs, err := ComputeMerkleTree(hashes)
	if err != nil || root != anc.MerkleRoot {
		return nil
	}
	return &AnchorProof{
		AnchorCode:    anc.AnchorCode,
		SeqFrom:       anc.SeqFrom,
		SeqTo:         anc.SeqTo,
		RevisionCount: anc.RevisionCount,
		MerkleRoot:    anc.MerkleRoot,
		Proof:         proofs[targetIdx],
		TSAURL:        anc.TSAURL,
		TSAStatus:     anc.TSAStatus,
		TSATokenB64:   anc.TSATokenB64,
		TSAGenTime:    anc.TSAGenTime,
		AnchoredAt:    anc.AnchoredAt,
	}
}

// ListRevisions returns historical revisions matching filter ordered newest-first.
func (s *MySQLStore) ListRevisions(ctx context.Context, filter RevisionFilter) ([]RevisionItem, error) {
	db, err := s.requireDB()
	if err != nil {
		return nil, err
	}

	var where []string
	var params []any
	if bt := strings.TrimSpace(filter.BankType); bt != "" && bt != "all" {
		where = append(where, "`bank_type` = ?")
		params = append(params, qbank.NormalizeBankType(bt))
	}
	if filter.Year != nil && *filter.Year > 0 {
		where = append(where, "`year` = ?")
		params = append(params, *filter.Year)
	}
	if season := strings.TrimSpace(filter.Season); season != "" && season != "all" {
		where = append(where, "`season` = ?")
		params = append(params, season)
	}
	if subj := strings.TrimSpace(filter.Subject); subj != "" && subj != "all" {
		where = append(where, "`subject` = ?")
		params = append(params, subj)
	}
	if grade := strings.TrimSpace(filter.Grade); grade != "" && grade != "all" {
		where = append(where, "`grade` = ?")
		params = append(params, grade)
	}
	if tier := strings.TrimSpace(filter.Tier); tier != "" && tier != "all" {
		where = append(where, "`tier` = ?")
		params = append(params, tier)
	}
	if filter.Week != nil && *filter.Week > 0 {
		where = append(where, "`week` = ?")
		params = append(params, *filter.Week)
	}
	if op := strings.TrimSpace(filter.Operator); op != "" {
		where = append(where, "`operator` = ?")
		params = append(params, op)
	}

	whereClause := ""
	if len(where) > 0 {
		whereClause = "WHERE " + strings.Join(where, " AND ")
	}
	limit := filter.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	params = append(params, limit)

	query := "SELECT " + revisionSelectCols + " FROM `qbank_revisions` " + whereClause + " ORDER BY `revision_no` DESC, `id` DESC LIMIT ?"
	rows, err := db.QueryContext(ctx, query, params...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	items := make([]RevisionItem, 0)
	issuer := s.cfg.resolveIssuer()
	for rows.Next() {
		rec, err := scanRevisionRecord(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, recordToRevisionItem(rec, issuer))
	}
	return items, rows.Err()
}

// ListTimeline merges qbank_revisions and qbank_attempt_logs ordered reverse-chronologically with pagination and stats.
func (s *MySQLStore) ListTimeline(ctx context.Context, filter TimelineFilter) (*TimelineResult, error) {
	db, err := s.requireDB()
	if err != nil {
		return nil, err
	}

	page, pageSize, offset := normalizeTimelinePagination(filter.Page, filter.PageSize)

	buildCommonWhere := func(tableAlias string, allowEmptyBankType bool) (string, []any) {
		var w []string
		var p []any
		col := func(name string) string {
			if tableAlias == "" {
				return "`" + name + "`"
			}
			return tableAlias + ".`" + name + "`"
		}
		if op := strings.TrimSpace(filter.Operator); op != "" {
			kw := "%" + op + "%"
			w = append(w, "("+col("operator")+" LIKE ? OR "+col("operator_name")+" LIKE ?)")
			p = append(p, kw, kw)
		}
		if bt := strings.TrimSpace(filter.BankType); bt != "" && bt != "all" {
			nbt := qbank.NormalizeBankType(bt)
			if allowEmptyBankType {
				w = append(w, "("+col("bank_type")+" = ? OR "+col("bank_type")+" = '')")
				p = append(p, nbt)
			} else {
				w = append(w, col("bank_type")+" = ?")
				p = append(p, nbt)
			}
		}
		if filter.Year != nil && *filter.Year > 0 {
			w = append(w, col("year")+" = ?")
			p = append(p, *filter.Year)
		}
		if season := strings.TrimSpace(filter.Season); season != "" && season != "all" {
			w = append(w, col("season")+" = ?")
			p = append(p, season)
		}
		if subj := strings.TrimSpace(filter.Subject); subj != "" && subj != "all" {
			w = append(w, col("subject")+" = ?")
			p = append(p, subj)
		}
		if grade := strings.TrimSpace(filter.Grade); grade != "" && grade != "all" {
			w = append(w, col("grade")+" = ?")
			p = append(p, grade)
		}
		if tier := strings.TrimSpace(filter.Tier); tier != "" && tier != "all" {
			w = append(w, col("tier")+" = ?")
			p = append(p, tier)
		}
		if filter.Week != nil && *filter.Week > 0 {
			w = append(w, col("week")+" = ?")
			p = append(p, *filter.Week)
		}
		if tFrom, _, ok := parseDateBound(filter.DateFrom, false); ok {
			w = append(w, col("created_at")+" >= ?")
			p = append(p, tFrom)
		}
		if tTo, exclusive, ok := parseDateBound(filter.DateTo, true); ok {
			if exclusive {
				w = append(w, col("created_at")+" < ?")
			} else {
				w = append(w, col("created_at")+" <= ?")
			}
			p = append(p, tTo)
		}
		if len(w) == 0 {
			return "", p
		}
		return "WHERE " + strings.Join(w, " AND "), p
	}

	// 1. Stats across non-event_type filters.
	var stats TimelineStats
	revBaseWhere, revBaseParams := buildCommonWhere("", false)
	if err := db.QueryRowContext(
		ctx,
		"SELECT COUNT(*) FROM `qbank_revisions` "+revBaseWhere,
		revBaseParams...,
	).Scan(&stats.Revisions); err != nil {
		return nil, err
	}

	attBaseWhere, attBaseParams := buildCommonWhere("", true)
	attStatRows, err := db.QueryContext(
		ctx,
		"SELECT `event_type`, COUNT(*) FROM `qbank_attempt_logs` "+attBaseWhere+" GROUP BY `event_type`",
		attBaseParams...,
	)
	if err != nil {
		return nil, err
	}
	for attStatRows.Next() {
		var et string
		var cnt int
		if scanErr := attStatRows.Scan(&et, &cnt); scanErr == nil {
			switch et {
			case EventUploadPDF:
				stats.Uploads += cnt
			case EventClientBlocked, EventSaveRejected, EventSaveError:
				stats.BlockedOrFailed += cnt
			case EventSaveCancelled:
				stats.Cancelled += cnt
			}
		}
	}
	_ = attStatRows.Close()

	// 2. Build filtered UNION ALL query according to event_type.
	spec := parseTimelineEventFilter(filter.EventType)
	var subQueries []string
	var unionParams []any

	if spec.wantRevisions {
		revWhere := revBaseWhere
		revParams := append([]any(nil), revBaseParams...)
		if len(spec.revisionActions) > 0 {
			ph := strings.Repeat("?,", len(spec.revisionActions))
			ph = ph[:len(ph)-1]
			cond := "`action` IN (" + ph + ")"
			if revWhere == "" {
				revWhere = "WHERE " + cond
			} else {
				revWhere += " AND " + cond
			}
			for _, a := range spec.revisionActions {
				revParams = append(revParams, a)
			}
		}
		subQueries = append(subQueries,
			"(SELECT "+
				"'revision' AS `source`, `action` AS `event_type`, `receipt_code`, `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week`, "+
				"`revision_no`, `question_count`, `operator`, `operator_name`, `client_ip`, "+
				"'' AS `reason`, '' AS `file_name`, '' AS `file_sha256`, "+
				"`content_sha256`, COALESCE(`supersedes_receipt_code`, '') AS `supersedes_receipt_code`, `exercise_pdf_count`, `answer_pdf_count`, `topic_filled_count`, "+
				"'' AS `details_json`, `created_at`, `id` AS `sort_id` "+
				"FROM `qbank_revisions` "+revWhere+")",
		)
		unionParams = append(unionParams, revParams...)
	}

	if spec.wantAttempts {
		attWhere := attBaseWhere
		attParams := append([]any(nil), attBaseParams...)
		if len(spec.attemptEvents) > 0 {
			ph := strings.Repeat("?,", len(spec.attemptEvents))
			ph = ph[:len(ph)-1]
			cond := "`event_type` IN (" + ph + ")"
			if attWhere == "" {
				attWhere = "WHERE " + cond
			} else {
				attWhere += " AND " + cond
			}
			for _, e := range spec.attemptEvents {
				attParams = append(attParams, e)
			}
		}
		subQueries = append(subQueries,
			"(SELECT "+
				"'attempt' AS `source`, `event_type`, '' AS `receipt_code`, `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week`, "+
				"0 AS `revision_no`, 0 AS `question_count`, `operator`, `operator_name`, `client_ip`, "+
				"`reason`, `file_name`, `file_sha256`, "+
				"'' AS `content_sha256`, '' AS `supersedes_receipt_code`, 0 AS `exercise_pdf_count`, 0 AS `answer_pdf_count`, 0 AS `topic_filled_count`, "+
				"COALESCE(CAST(`details_json` AS CHAR), '') AS `details_json`, `created_at`, `id` AS `sort_id` "+
				"FROM `qbank_attempt_logs` "+attWhere+")",
		)
		unionParams = append(unionParams, attParams...)
	}

	if len(subQueries) == 0 {
		return &TimelineResult{
			Items:    []TimelineItem{},
			Total:    0,
			Page:     page,
			PageSize: pageSize,
			Stats:    stats,
		}, nil
	}

	unionSQL := strings.Join(subQueries, " UNION ALL ")
	var total int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM ("+unionSQL+") AS tl", unionParams...).Scan(&total); err != nil {
		return nil, err
	}

	listParams := append(append([]any(nil), unionParams...), pageSize, offset)
	rows, err := db.QueryContext(
		ctx,
		"SELECT `source`, `event_type`, `receipt_code`, `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week`, "+
			"`revision_no`, `question_count`, `operator`, `operator_name`, `client_ip`, `reason`, `file_name`, `file_sha256`, "+
			"`content_sha256`, `supersedes_receipt_code`, `exercise_pdf_count`, `answer_pdf_count`, `topic_filled_count`, "+
			"`details_json`, `created_at` "+
			"FROM ("+unionSQL+") AS tl ORDER BY tl.`created_at` DESC, tl.`sort_id` DESC LIMIT ? OFFSET ?",
		listParams...,
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	items := make([]TimelineItem, 0)
	for rows.Next() {
		var item TimelineItem
		var receiptCode, bankType, season, subject, grade, tier, op, opName, ip, reason, fileName, fileSHA sql.NullString
		var contentSHA, supersedesCode, detailsStr sql.NullString
		var exCnt, ansCnt, topicCnt int
		var createdAt sql.NullTime

		if err := rows.Scan(
			&item.Source, &item.EventType, &receiptCode, &bankType, &item.Year, &season, &subject, &grade, &tier, &item.Week,
			&item.RevisionNo, &item.QuestionCount, &op, &opName, &ip, &reason, &fileName, &fileSHA,
			&contentSHA, &supersedesCode, &exCnt, &ansCnt, &topicCnt, &detailsStr, &createdAt,
		); err != nil {
			return nil, err
		}
		item.ReceiptCode = receiptCode.String
		item.BankType = bankType.String
		item.Season = season.String
		item.Subject = subject.String
		item.Grade = grade.String
		item.Tier = tier.String
		item.Operator = op.String
		item.OperatorName = opName.String
		item.ClientIP = ip.String
		item.Reason = reason.String
		item.FileName = fileName.String
		item.FileSHA256 = fileSHA.String
		if createdAt.Valid {
			item.CreatedAt = tz.In(createdAt.Time).Format("2006-01-02 15:04:05")
		}
		if item.Source == "revision" {
			item.Details = map[string]any{
				"content_sha256":          contentSHA.String,
				"supersedes_receipt_code": supersedesCode.String,
				"exercise_pdf_count":      exCnt,
				"answer_pdf_count":        ansCnt,
				"topic_filled_count":      topicCnt,
			}
		} else {
			item.Details = decodeDetailsJSON(detailsStr.String)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return &TimelineResult{
		Items:    items,
		Total:    total,
		Page:     page,
		PageSize: pageSize,
		Stats:    stats,
	}, nil
}

// ListMatrix aggregates qbank_weeks with latest qbank_revisions and qbank_attempt_logs counts.
func (s *MySQLStore) ListMatrix(ctx context.Context, filter MatrixFilter) ([]MatrixItem, error) {
	db, err := s.requireDB()
	if err != nil {
		return nil, err
	}

	var where []string
	var params []any
	if filter.Year != nil && *filter.Year > 0 {
		where = append(where, "qw.`year` = ?")
		params = append(params, *filter.Year)
	}
	if season := strings.TrimSpace(filter.Season); season != "" && season != "all" {
		where = append(where, "qw.`season` = ?")
		params = append(params, season)
	}
	if bt := strings.TrimSpace(filter.BankType); bt != "" && bt != "all" {
		where = append(where, "qw.`bank_type` = ?")
		params = append(params, qbank.NormalizeBankType(bt))
	}
	if subj := strings.TrimSpace(filter.Subject); subj != "" && subj != "all" {
		where = append(where, "qw.`subject` = ?")
		params = append(params, subj)
	}
	if grade := strings.TrimSpace(filter.Grade); grade != "" && grade != "all" {
		where = append(where, "qw.`grade` = ?")
		params = append(params, grade)
	}
	if tier := strings.TrimSpace(filter.Tier); tier != "" && tier != "all" {
		where = append(where, "qw.`tier` = ?")
		params = append(params, tier)
	}
	if search := strings.TrimSpace(filter.Search); search != "" {
		kw := "%" + search + "%"
		where = append(where, "(qw.`subject` LIKE ? OR qw.`grade` LIKE ? OR qw.`tier` LIKE ? OR COALESCE(lr.`receipt_code`, '') LIKE ? OR COALESCE(NULLIF(lr.`operator`, ''), NULLIF(qw.`updated_by`, ''), qw.`created_by`, '') LIKE ?)")
		params = append(params, kw, kw, kw, kw, kw)
	}

	whereClause := ""
	if len(where) > 0 {
		whereClause = "WHERE " + strings.Join(where, " AND ")
	}

	query := "SELECT " +
		"qw.`id`, qw.`bank_type`, qw.`year`, qw.`season`, qw.`subject`, qw.`grade`, qw.`tier`, qw.`week`, qw.`question_count`, " +
		"COALESCE(lr.`receipt_code`, '') AS `latest_receipt_code`, " +
		"COALESCE(lr.`revision_no`, 0) AS `latest_revision_no`, " +
		"COALESCE(lr.`action`, '') AS `last_action`, " +
		"COALESCE(NULLIF(lr.`operator`, ''), NULLIF(qw.`updated_by`, ''), qw.`created_by`, '') AS `updated_by`, " +
		"COALESCE(NULLIF(lr.`operator_name`, ''), u.`real_name`, '') AS `updated_by_name`, " +
		"qw.`updated_at`, " +
		"COALESCE(ac.`attempt_count`, 0) AS `attempt_count`, " +
		"COALESCE(rc.`revision_count`, 0) AS `revision_count` " +
		"FROM `qbank_weeks` qw " +
		"LEFT JOIN (" +
		"  SELECT r1.`year`, r1.`season`, r1.`bank_type`, r1.`subject`, r1.`grade`, r1.`tier`, r1.`week`, " +
		"         r1.`receipt_code`, r1.`revision_no`, r1.`action`, r1.`operator`, r1.`operator_name` " +
		"  FROM `qbank_revisions` r1 " +
		"  INNER JOIN (" +
		"    SELECT `year`, `season`, `bank_type`, `subject`, `grade`, `tier`, `week`, MAX(`id`) AS `max_id` " +
		"    FROM `qbank_revisions` GROUP BY `year`, `season`, `bank_type`, `subject`, `grade`, `tier`, `week`" +
		"  ) r2 ON r1.`id` = r2.`max_id`" +
		") lr ON lr.`year` = qw.`year` AND lr.`season` = qw.`season` AND lr.`bank_type` = qw.`bank_type` " +
		"   AND lr.`subject` = qw.`subject` AND lr.`grade` = qw.`grade` AND lr.`tier` = qw.`tier` AND lr.`week` = qw.`week` " +
		"LEFT JOIN (" +
		"  SELECT `year`, `season`, `bank_type`, `subject`, `grade`, `tier`, `week`, COUNT(*) AS `revision_count` " +
		"  FROM `qbank_revisions` GROUP BY `year`, `season`, `bank_type`, `subject`, `grade`, `tier`, `week`" +
		") rc ON rc.`year` = qw.`year` AND rc.`season` = qw.`season` AND rc.`bank_type` = qw.`bank_type` " +
		"   AND rc.`subject` = qw.`subject` AND rc.`grade` = qw.`grade` AND rc.`tier` = qw.`tier` AND rc.`week` = qw.`week` " +
		"LEFT JOIN (" +
		"  SELECT `year`, `season`, `bank_type`, `subject`, `grade`, `tier`, `week`, COUNT(*) AS `attempt_count` " +
		"  FROM `qbank_attempt_logs` GROUP BY `year`, `season`, `bank_type`, `subject`, `grade`, `tier`, `week`" +
		") ac ON ac.`year` = qw.`year` AND ac.`season` = qw.`season` AND ac.`bank_type` = qw.`bank_type` " +
		"   AND ac.`subject` = qw.`subject` AND ac.`grade` = qw.`grade` AND ac.`tier` = qw.`tier` AND ac.`week` = qw.`week` " +
		"LEFT JOIN `users` u ON u.`username` = COALESCE(NULLIF(qw.`updated_by`, ''), qw.`created_by`) " +
		whereClause +
		" ORDER BY qw.`year` DESC, qw.`updated_at` DESC, qw.`id` DESC"

	rows, err := db.QueryContext(ctx, query, params...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	items := make([]MatrixItem, 0)
	for rows.Next() {
		var item MatrixItem
		var latestCode, lastAction, updatedBy, updatedByName sql.NullString
		var updatedAt sql.NullTime
		if err := rows.Scan(
			&item.ID, &item.BankType, &item.Year, &item.Season, &item.Subject, &item.Grade, &item.Tier, &item.Week, &item.QuestionCount,
			&latestCode, &item.LatestRevisionNo, &lastAction, &updatedBy, &updatedByName, &updatedAt,
			&item.AttemptCount, &item.RevisionCount,
		); err != nil {
			return nil, err
		}
		item.LatestReceiptCode = latestCode.String
		item.LastAction = lastAction.String
		item.UpdatedBy = updatedBy.String
		item.UpdatedByName = updatedByName.String
		if updatedAt.Valid {
			item.UpdatedAt = tz.In(updatedAt.Time).Format("2006-01-02 15:04:05")
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// ListPublicKeys returns registered Ed25519 public keys as RFC 8037 OKP JWKs.
func (s *MySQLStore) ListPublicKeys(ctx context.Context) ([]JWKKey, error) {
	db, err := s.requireDB()
	if err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(
		ctx,
		"SELECT `kid`, `public_key`, `status`, `created_at` FROM `qbank_attestation_keys` ORDER BY `created_at` DESC, `kid` ASC",
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	keys := make([]JWKKey, 0)
	hasSignerKid := false
	for rows.Next() {
		var kid, pub, status string
		var createdAt sql.NullTime
		if err := rows.Scan(&kid, &pub, &status, &createdAt); err != nil {
			return nil, err
		}
		var ts time.Time
		if createdAt.Valid {
			ts = createdAt.Time
		}
		keys = append(keys, BuildJWK(kid, pub, status, ts))
		if s.signer != nil && kid == s.signer.Kid() {
			hasSignerKid = true
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if s.signer != nil && !hasSignerKid {
		keys = append([]JWKKey{s.signer.JWK()}, keys...)
	}
	return keys, nil
}

// HasRecentPDFReference reports whether relURL (data/pdfs/pdf_*.pdf) appears in qbank_revisions.snapshot_json
// within maxAge (or any time when maxAge <= 0). Used to enforce delayed orphan PDF cleanup.
func (s *MySQLStore) HasRecentPDFReference(ctx context.Context, relURL string, maxAge time.Duration) (bool, error) {
	db, err := s.requireDB()
	if err != nil {
		return false, err
	}
	fileName, ok := qbank.IsValidManagedPDFPath(relURL)
	if !ok || fileName == "" {
		return false, nil
	}
	needle := `"` + strings.TrimSpace(relURL) + `"`

	var dummy int
	if maxAge > 0 {
		cutoff := tz.In(s.cfg.now().Add(-maxAge))
		err = db.QueryRowContext(
			ctx,
			"SELECT 1 FROM `qbank_revisions` WHERE `created_at` >= ? AND LOCATE(?, `snapshot_json`) > 0 LIMIT 1",
			cutoff, needle,
		).Scan(&dummy)
	} else {
		err = db.QueryRowContext(
			ctx,
			"SELECT 1 FROM `qbank_revisions` WHERE LOCATE(?, `snapshot_json`) > 0 LIMIT 1",
			needle,
		).Scan(&dummy)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// ---------- MemoryStore ----------

// MemoryStore is a concurrency-safe in-memory Store implementation for unit and handler testing.
type MemoryStore struct {
	mu           sync.RWMutex
	signer       *Signer
	feedbackRoot string
	cfg          storeConfig
	keys         map[string]*keyRecord
	revisions    []*revisionRecord
	attempts     []*attemptRecord
	anchors      []*AnchorRecord
	nextRevID    int64
	nextAttID    int64
	nextAncID    int64
}

// NewMemoryStore creates a concurrency-safe MemoryStore and pre-registers signer's public key if non-nil.
func NewMemoryStore(signer *Signer, feedbackRoot string, opts ...StoreOption) *MemoryStore {
	var cfg storeConfig
	for _, opt := range opts {
		if opt != nil {
			opt(&cfg)
		}
	}
	ms := &MemoryStore{
		signer:       signer,
		feedbackRoot: feedbackRoot,
		cfg:          cfg,
		keys:         make(map[string]*keyRecord),
		nextRevID:    1,
		nextAttID:    1,
		nextAncID:    1,
	}
	if signer != nil {
		ms.keys[signer.Kid()] = &keyRecord{
			kid:       signer.Kid(),
			alg:       signer.Alg(),
			publicKey: signer.PublicKeyBase64URL(),
			status:    KeyStatusActive,
			createdAt: signer.CreatedAt(),
		}
	}
	return ms
}

// EnsureKeyRegistered registers the signer's key in memory.
func (m *MemoryStore) EnsureKeyRegistered(_ context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.signer == nil {
		return errors.New("attestation signer is not configured")
	}
	if existing, ok := m.keys[m.signer.Kid()]; ok {
		if existing.publicKey != m.signer.PublicKeyBase64URL() {
			return fmt.Errorf("attestation key id %q already registered with a different public key", m.signer.Kid())
		}
		if existing.status == KeyStatusRevoked {
			return fmt.Errorf("attestation key id %q is revoked", m.signer.Kid())
		}
		return nil
	}
	m.keys[m.signer.Kid()] = &keyRecord{
		kid:       m.signer.Kid(),
		alg:       m.signer.Alg(),
		publicKey: m.signer.PublicKeyBase64URL(),
		status:    KeyStatusActive,
		createdAt: m.signer.CreatedAt(),
	}
	return nil
}

// RecordRevisionTx appends a new immutable revision to the in-memory ledger.
func (m *MemoryStore) RecordRevisionTx(_ context.Context, _ *sql.Tx, in RecordRevisionInput) (*Receipt, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.signer == nil {
		return nil, errors.New("attestation signer is not configured")
	}

	normScope := NormalizeScope(in.Scope)
	var prevChainHash string
	if len(m.revisions) > 0 {
		prevChainHash = m.revisions[len(m.revisions)-1].entryHash
	}

	var prevScopeRev *revisionRecord
	for i := len(m.revisions) - 1; i >= 0; i-- {
		r := m.revisions[i]
		if r.scope == normScope {
			prevScopeRev = r
			break
		}
	}

	now := in.Now
	if now.IsZero() {
		now = m.cfg.now()
	}

	rec, receipt, err := buildRevisionAndReceipt(
		m.signer,
		m.feedbackRoot,
		m.cfg.resolveIssuer(),
		in,
		prevScopeRev,
		prevChainHash,
		now,
	)
	if err != nil {
		return nil, err
	}
	rec.id = m.nextRevID
	m.nextRevID++
	m.revisions = append(m.revisions, rec)
	return receipt, nil
}

// RecordAttempt appends an attempt log entry in memory.
func (m *MemoryStore) RecordAttempt(_ context.Context, in AttemptInput) error {
	eventType := strings.TrimSpace(in.EventType)
	if !isValidAttemptEventType(eventType) {
		return fmt.Errorf("invalid attempt event_type %q", in.EventType)
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	now := in.Now
	if now.IsZero() {
		now = m.cfg.now()
	}
	bankType := strings.TrimSpace(in.Scope.BankType)
	if bankType != "" {
		bankType = qbank.NormalizeBankType(bankType)
	}
	var detailsJSON string
	if len(in.Details) > 0 {
		if b, err := MarshalCanonicalJSON(in.Details); err == nil {
			detailsJSON = string(b)
		}
	}

	att := &attemptRecord{
		id:        m.nextAttID,
		eventType: eventType,
		scope: Scope{
			BankType: bankType,
			Year:     in.Scope.Year,
			Season:   strings.TrimSpace(in.Scope.Season),
			Subject:  strings.TrimSpace(in.Scope.Subject),
			Grade:    strings.TrimSpace(in.Scope.Grade),
			Tier:     strings.TrimSpace(in.Scope.Tier),
			Week:     in.Scope.Week,
		},
		operator:     truncateRunes(strings.TrimSpace(in.Operator), 50),
		operatorName: truncateRunes(strings.TrimSpace(in.OperatorName), 50),
		clientIP:     truncateRunes(strings.TrimSpace(in.ClientIP), 45),
		reason:       truncateRunes(strings.TrimSpace(in.Reason), 255),
		fileURL:      truncateRunes(strings.TrimSpace(in.FileURL), 255),
		fileName:     truncateRunes(strings.TrimSpace(in.FileName), 255),
		fileSHA256:   truncateRunes(strings.ToLower(strings.TrimSpace(in.FileSHA256)), 64),
		fileSize:     in.FileSize,
		detailsJSON:  detailsJSON,
		createdAt:    now,
	}
	m.nextAttID++
	m.attempts = append(m.attempts, att)
	return nil
}

// VerifyReceipt validates cryptographic signature, hash chain, and lifecycle state in memory.
func (m *MemoryStore) VerifyReceipt(_ context.Context, receiptCode string) (*VerifyResult, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	code := strings.TrimSpace(receiptCode)
	if code == "" {
		return &VerifyResult{Status: StatusNotFound}, nil
	}

	idx := -1
	for i, r := range m.revisions {
		if r.receiptCode == code {
			idx = i
			break
		}
	}
	if idx < 0 {
		return &VerifyResult{Status: StatusNotFound}, nil
	}

	rec := m.revisions[idx]
	var prevRowEntryHash string
	hasPrevRow := idx > 0
	if hasPrevRow {
		prevRowEntryHash = m.revisions[idx-1].entryHash
	}

	var nextRev, latestRev *revisionRecord
	for _, r := range m.revisions {
		if r.scope != rec.scope {
			continue
		}
		if r.revisionNo > rec.revisionNo && nextRev == nil {
			nextRev = r
		}
		latestRev = r
	}

	dbKey := m.keys[rec.kid]
	res := evaluateVerification(rec, nextRev, latestRev, dbKey, prevRowEntryHash, hasPrevRow, m.signer, m.cfg.resolveIssuer())
	for i := len(m.anchors) - 1; i >= 0; i-- {
		anc := m.anchors[i]
		if rec.id >= anc.SeqFrom && rec.id <= anc.SeqTo {
			var ids []int64
			var hashes []string
			for _, r := range m.revisions {
				if r.id >= anc.SeqFrom && r.id <= anc.SeqTo {
					ids = append(ids, r.id)
					hashes = append(hashes, r.entryHash)
				}
			}
			res.Anchor = buildAnchorProofFromHashes(*anc, ids, hashes, rec.id)
			break
		}
	}
	return res, nil
}

// ListRevisions returns matching in-memory revisions ordered newest-first.
func (m *MemoryStore) ListRevisions(_ context.Context, filter RevisionFilter) ([]RevisionItem, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	limit := filter.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}

	issuer := m.cfg.resolveIssuer()
	items := make([]RevisionItem, 0)
	for i := len(m.revisions) - 1; i >= 0; i-- {
		r := m.revisions[i]
		if bt := strings.TrimSpace(filter.BankType); bt != "" && bt != "all" && r.scope.BankType != qbank.NormalizeBankType(bt) {
			continue
		}
		if filter.Year != nil && *filter.Year > 0 && r.scope.Year != *filter.Year {
			continue
		}
		if season := strings.TrimSpace(filter.Season); season != "" && season != "all" && r.scope.Season != season {
			continue
		}
		if subj := strings.TrimSpace(filter.Subject); subj != "" && subj != "all" && r.scope.Subject != subj {
			continue
		}
		if grade := strings.TrimSpace(filter.Grade); grade != "" && grade != "all" && r.scope.Grade != grade {
			continue
		}
		if tier := strings.TrimSpace(filter.Tier); tier != "" && tier != "all" && r.scope.Tier != tier {
			continue
		}
		if filter.Week != nil && *filter.Week > 0 && r.scope.Week != *filter.Week {
			continue
		}
		if op := strings.TrimSpace(filter.Operator); op != "" && r.operator != op {
			continue
		}
		items = append(items, recordToRevisionItem(r, issuer))
		if len(items) >= limit {
			break
		}
	}
	return items, nil
}

// ListTimeline returns merged, filtered, reverse-chronological timeline entries in memory.
func (m *MemoryStore) ListTimeline(_ context.Context, filter TimelineFilter) (*TimelineResult, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	page, pageSize, offset := normalizeTimelinePagination(filter.Page, filter.PageSize)
	tFrom, _, hasFrom := parseDateBound(filter.DateFrom, false)
	tTo, tToExclusive, hasTo := parseDateBound(filter.DateTo, true)

	matchCommon := func(sc Scope, op, opName string, ts time.Time, allowEmptyBT bool) bool {
		if kw := strings.ToLower(strings.TrimSpace(filter.Operator)); kw != "" {
			if !strings.Contains(strings.ToLower(op), kw) && !strings.Contains(strings.ToLower(opName), kw) {
				return false
			}
		}
		if bt := strings.TrimSpace(filter.BankType); bt != "" && bt != "all" {
			nbt := qbank.NormalizeBankType(bt)
			if sc.BankType != nbt && !(allowEmptyBT && sc.BankType == "") {
				return false
			}
		}
		if filter.Year != nil && *filter.Year > 0 && sc.Year != *filter.Year {
			return false
		}
		if season := strings.TrimSpace(filter.Season); season != "" && season != "all" && sc.Season != season {
			return false
		}
		if subj := strings.TrimSpace(filter.Subject); subj != "" && subj != "all" && sc.Subject != subj {
			return false
		}
		if grade := strings.TrimSpace(filter.Grade); grade != "" && grade != "all" && sc.Grade != grade {
			return false
		}
		if tier := strings.TrimSpace(filter.Tier); tier != "" && tier != "all" && sc.Tier != tier {
			return false
		}
		if filter.Week != nil && *filter.Week > 0 && sc.Week != *filter.Week {
			return false
		}
		if hasFrom && ts.Before(tFrom) {
			return false
		}
		if hasTo {
			if tToExclusive && !ts.Before(tTo) {
				return false
			}
			if !tToExclusive && ts.After(tTo) {
				return false
			}
		}
		return true
	}

	var stats TimelineStats
	spec := parseTimelineEventFilter(filter.EventType)

	type sortableTimelineItem struct {
		item   TimelineItem
		ts     time.Time
		sortID int64
	}
	var all []sortableTimelineItem

	revActionSet := make(map[string]struct{}, len(spec.revisionActions))
	for _, a := range spec.revisionActions {
		revActionSet[a] = struct{}{}
	}
	attEventSet := make(map[string]struct{}, len(spec.attemptEvents))
	for _, e := range spec.attemptEvents {
		attEventSet[e] = struct{}{}
	}

	for _, r := range m.revisions {
		if !matchCommon(r.scope, r.operator, r.operatorName, r.createdAt, false) {
			continue
		}
		stats.Revisions++
		if !spec.wantRevisions {
			continue
		}
		if len(revActionSet) > 0 {
			if _, ok := revActionSet[r.action]; !ok {
				continue
			}
		}
		all = append(all, sortableTimelineItem{
			ts:     r.createdAt,
			sortID: r.id,
			item: TimelineItem{
				Source:        "revision",
				EventType:     r.action,
				ReceiptCode:   r.receiptCode,
				BankType:      r.scope.BankType,
				Year:          r.scope.Year,
				Season:        r.scope.Season,
				Subject:       r.scope.Subject,
				Grade:         r.scope.Grade,
				Tier:          r.scope.Tier,
				Week:          r.scope.Week,
				RevisionNo:    r.revisionNo,
				QuestionCount: r.questionCount,
				Operator:      r.operator,
				OperatorName:  r.operatorName,
				ClientIP:      r.clientIP,
				Details:       buildRevisionDetails(r),
				CreatedAt:     tz.In(r.createdAt).Format("2006-01-02 15:04:05"),
			},
		})
	}

	for _, a := range m.attempts {
		if !matchCommon(a.scope, a.operator, a.operatorName, a.createdAt, true) {
			continue
		}
		switch a.eventType {
		case EventUploadPDF:
			stats.Uploads++
		case EventClientBlocked, EventSaveRejected, EventSaveError:
			stats.BlockedOrFailed++
		case EventSaveCancelled:
			stats.Cancelled++
		}
		if !spec.wantAttempts {
			continue
		}
		if len(attEventSet) > 0 {
			if _, ok := attEventSet[a.eventType]; !ok {
				continue
			}
		}
		all = append(all, sortableTimelineItem{
			ts:     a.createdAt,
			sortID: a.id,
			item: TimelineItem{
				Source:       "attempt",
				EventType:    a.eventType,
				BankType:     a.scope.BankType,
				Year:         a.scope.Year,
				Season:       a.scope.Season,
				Subject:      a.scope.Subject,
				Grade:        a.scope.Grade,
				Tier:         a.scope.Tier,
				Week:         a.scope.Week,
				Operator:     a.operator,
				OperatorName: a.operatorName,
				ClientIP:     a.clientIP,
				Reason:       a.reason,
				FileName:     a.fileName,
				FileSHA256:   a.fileSHA256,
				Details:      decodeDetailsJSON(a.detailsJSON),
				CreatedAt:    tz.In(a.createdAt).Format("2006-01-02 15:04:05"),
			},
		})
	}

	sort.Slice(all, func(i, j int) bool {
		if !all[i].ts.Equal(all[j].ts) {
			return all[i].ts.After(all[j].ts)
		}
		return all[i].sortID > all[j].sortID
	})

	total := len(all)
	end := offset + pageSize
	if offset > total {
		offset = total
	}
	if end > total {
		end = total
	}
	paged := make([]TimelineItem, 0, end-offset)
	for _, entry := range all[offset:end] {
		paged = append(paged, entry.item)
	}

	return &TimelineResult{
		Items:    paged,
		Total:    total,
		Page:     page,
		PageSize: pageSize,
		Stats:    stats,
	}, nil
}

// ListMatrix aggregates active scopes seen in MemoryStore revisions with revision and attempt counts.
func (m *MemoryStore) ListMatrix(_ context.Context, filter MatrixFilter) ([]MatrixItem, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	type scopeAgg struct {
		latest  *revisionRecord
		revCnt  int
		attCnt  int
	}
	aggs := make(map[Scope]*scopeAgg)
	for _, r := range m.revisions {
		agg, ok := aggs[r.scope]
		if !ok {
			agg = &scopeAgg{}
			aggs[r.scope] = agg
		}
		agg.latest = r
		agg.revCnt++
	}
	for _, a := range m.attempts {
		if agg, ok := aggs[a.scope]; ok {
			agg.attCnt++
		}
	}

	search := strings.ToLower(strings.TrimSpace(filter.Search))
	items := make([]MatrixItem, 0, len(aggs))
	for sc, agg := range aggs {
		if agg.latest == nil || isDeleteAction(agg.latest.action) {
			continue
		}
		if filter.Year != nil && *filter.Year > 0 && sc.Year != *filter.Year {
			continue
		}
		if season := strings.TrimSpace(filter.Season); season != "" && season != "all" && sc.Season != season {
			continue
		}
		if bt := strings.TrimSpace(filter.BankType); bt != "" && bt != "all" && sc.BankType != qbank.NormalizeBankType(bt) {
			continue
		}
		if subj := strings.TrimSpace(filter.Subject); subj != "" && subj != "all" && sc.Subject != subj {
			continue
		}
		if grade := strings.TrimSpace(filter.Grade); grade != "" && grade != "all" && sc.Grade != grade {
			continue
		}
		if tier := strings.TrimSpace(filter.Tier); tier != "" && tier != "all" && sc.Tier != tier {
			continue
		}
		if search != "" {
			hay := strings.ToLower(strings.Join([]string{sc.Subject, sc.Grade, sc.Tier, agg.latest.receiptCode, agg.latest.operator}, " "))
			if !strings.Contains(hay, search) {
				continue
			}
		}

		items = append(items, MatrixItem{
			ID:                agg.latest.qbankID,
			BankType:          sc.BankType,
			Year:              sc.Year,
			Season:            sc.Season,
			Subject:           sc.Subject,
			Grade:             sc.Grade,
			Tier:              sc.Tier,
			Week:              sc.Week,
			QuestionCount:     agg.latest.questionCount,
			LatestReceiptCode: agg.latest.receiptCode,
			LatestRevisionNo:  agg.latest.revisionNo,
			LastAction:        agg.latest.action,
			UpdatedBy:         agg.latest.operator,
			UpdatedByName:     agg.latest.operatorName,
			UpdatedAt:         tz.In(agg.latest.createdAt).Format("2006-01-02 15:04:05"),
			AttemptCount:      agg.attCnt,
			RevisionCount:     agg.revCnt,
		})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Year != items[j].Year {
			return items[i].Year > items[j].Year
		}
		return items[i].UpdatedAt > items[j].UpdatedAt
	})
	return items, nil
}

// ListPublicKeys returns registered public keys as RFC 8037 OKP JWKs.
func (m *MemoryStore) ListPublicKeys(_ context.Context) ([]JWKKey, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	keys := make([]JWKKey, 0, len(m.keys))
	for _, k := range m.keys {
		keys = append(keys, BuildJWK(k.kid, k.publicKey, k.status, k.createdAt))
	}
	sort.Slice(keys, func(i, j int) bool {
		return keys[i].Kid < keys[j].Kid
	})
	return keys, nil
}

// HasRecentPDFReference checks whether relURL appears in in-memory revision snapshots within maxAge.
func (m *MemoryStore) HasRecentPDFReference(_ context.Context, relURL string, maxAge time.Duration) (bool, error) {
	fileName, ok := qbank.IsValidManagedPDFPath(relURL)
	if !ok || fileName == "" {
		return false, nil
	}
	needle := `"` + strings.TrimSpace(relURL) + `"`

	m.mu.RLock()
	defer m.mu.RUnlock()

	var cutoff time.Time
	if maxAge > 0 {
		cutoff = m.cfg.now().Add(-maxAge)
	}
	for _, r := range m.revisions {
		if maxAge > 0 && r.createdAt.Before(cutoff) {
			continue
		}
		if strings.Contains(r.snapshotJSON, needle) {
			return true, nil
		}
	}
	return false, nil
}

// GetRevisionSnapshot retrieves a historical revision's decoded snapshot from memory.
func (m *MemoryStore) GetRevisionSnapshot(_ context.Context, receiptCode string) (*RevisionSnapshot, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	code := strings.TrimSpace(receiptCode)
	for _, r := range m.revisions {
		if r.receiptCode == code {
			var snap Snapshot
			if err := json.Unmarshal([]byte(r.snapshotJSON), &snap); err != nil {
				return nil, fmt.Errorf("decode snapshot_json: %w", err)
			}
			return &RevisionSnapshot{
				ID:          r.id,
				ReceiptCode: r.receiptCode,
				RevisionNo:  r.revisionNo,
				Action:      r.action,
				Scope:       r.scope,
				Snapshot:    snap,
				CreatedAt:   formatReceiptTimestamp(r.createdAt),
			}, nil
		}
	}
	return nil, ErrRevisionNotFound
}

// AnchorUnanchoredRevisions batches unanchored in-memory revisions into a Merkle anchor.
func (m *MemoryStore) AnchorUnanchoredRevisions(ctx context.Context, tsa TSAClient) (*AnchorRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	var lastSeq int64
	if len(m.anchors) > 0 {
		lastSeq = m.anchors[len(m.anchors)-1].SeqTo
	}

	var ids []int64
	var hashes []string
	for _, r := range m.revisions {
		if r.id > lastSeq {
			ids = append(ids, r.id)
			hashes = append(hashes, r.entryHash)
		}
	}
	if len(ids) == 0 {
		return nil, nil
	}

	merkleRoot, _, err := ComputeMerkleTree(hashes)
	if err != nil {
		return nil, err
	}
	rootBytes, err := hex.DecodeString(merkleRoot)
	if err != nil {
		return nil, err
	}

	now := m.cfg.now().UTC()
	anc := &AnchorRecord{
		ID:            m.nextAncID,
		AnchorCode:    generateAnchorCode(now),
		SeqFrom:       ids[0],
		SeqTo:         ids[len(ids)-1],
		RevisionCount: len(ids),
		MerkleRoot:    merkleRoot,
		TSAStatus:     TSAStatusLocalOnly,
		AnchoredAt:    formatReceiptTimestamp(now),
	}
	m.nextAncID++
	if tsa != nil && strings.TrimSpace(tsa.Endpoint()) != "" {
		anc.TSAURL = strings.TrimSpace(tsa.Endpoint())
		if resp, tsaErr := tsa.Timestamp(ctx, rootBytes); tsaErr == nil && resp != nil {
			anc.TSAStatus = TSAStatusAnchored
			anc.TSATokenB64 = resp.TokenB64
			anc.TSAGenTime = resp.GenTime
		}
	}
	m.anchors = append(m.anchors, anc)
	copyAnc := *anc
	return &copyAnc, nil
}

// ListAnchors returns recent in-memory anchors ordered newest-first.
func (m *MemoryStore) ListAnchors(_ context.Context, limit int) ([]AnchorRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if limit <= 0 {
		limit = 20
	}
	if limit > 200 {
		limit = 200
	}
	out := make([]AnchorRecord, 0, len(m.anchors))
	for i := len(m.anchors) - 1; i >= 0 && len(out) < limit; i-- {
		out = append(out, *m.anchors[i])
	}
	return out, nil
}

// TamperRevisionForTest allows tests using MemoryStore to mutate a stored revision or key record.
// Keeping test-tampering helpers explicit avoids exposing mutable slices directly.
func (m *MemoryStore) SetKeyStatusForTest(kid, status, publicKeyOverride string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if k, ok := m.keys[kid]; ok {
		if status != "" {
			k.status = status
		}
		if publicKeyOverride != "" {
			k.publicKey = publicKeyOverride
		}
	}
}

// MutateRevisionForTest applies fn to the stored revision matching receiptCode for tamper-detection tests.
func (m *MemoryStore) MutateRevisionForTest(receiptCode string, mutate func(canonicalPayload, snapshotJSON, entryHash, prevEntryHash, signature *string)) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range m.revisions {
		if r.receiptCode == receiptCode {
			mutate(&r.canonicalPayload, &r.snapshotJSON, &r.entryHash, &r.prevEntryHash, &r.signature)
			return true
		}
	}
	return false
}
