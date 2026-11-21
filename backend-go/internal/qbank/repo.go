package qbank

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// ListFilter holds optional filter criteria for GET ?action=list.
type ListFilter struct {
	Year     *int
	Season   string
	Subject  string
	Grade    string
	BankType string
	Search   string
}

// WeekListItem matches a row returned by GET ?action=list.
type WeekListItem struct {
	ID            int64   `json:"id"`
	BankType      string  `json:"bankType"`
	Year          int     `json:"year"`
	Season        string  `json:"season"`
	Subject       string  `json:"subject"`
	Grade         string  `json:"grade"`
	Tier          string  `json:"tier"`
	Week          int     `json:"week"`
	QuestionCount int     `json:"questionCount"`
	UpdatedAt     float64 `json:"updatedAt"`
}

// WeekKey identifies a question bank topic week.
type WeekKey struct {
	Year     *int
	Season   string
	Subject  string
	Grade    string
	Tier     string
	Week     int
	BankType string
}

// PDFInfo matches exercisePdf / answerPdf JSON structure.
type PDFInfo struct {
	URL    string `json:"url"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

// QuestionItem matches a question object returned by GET ?action=get.
type QuestionItem struct {
	ID                 int            `json:"id"`
	ParentQuestionNum  *int           `json:"parentQuestionNum"`
	ParentQuestionNums []int          `json:"parentQuestionNums"`
	SubNum             int            `json:"subNum"`
	Topic              string         `json:"topic"`
	VideoURL           string         `json:"videoUrl"`
	ExercisePDF        PDFInfo        `json:"exercisePdf"`
	AnswerPDF          PDFInfo        `json:"answerPdf"`
	QuestionMeta       map[string]any `json:"questionMeta,omitempty"`
}

// WeekDetail matches the data object returned by GET ?action=get.
type WeekDetail struct {
	BankType           string         `json:"bankType"`
	Year               int            `json:"year"`
	Season             string         `json:"season"`
	Subject            string         `json:"subject"`
	Grade              string         `json:"grade"`
	Tier               string         `json:"tier"`
	Week               int            `json:"week"`
	QuestionCount      int            `json:"questionCount"`
	CreatedBy          string         `json:"createdBy"`
	UpdatedBy          string         `json:"updatedBy"`
	Operator           string         `json:"operator"`
	OperatorName       string         `json:"operatorName"`
	UpdatedAt          float64        `json:"updatedAt"`
	UpdatedAtFormatted string         `json:"updatedAtFormatted"`
	Questions          []QuestionItem `json:"questions"`
}

// SaveQuestionInput is a sanitized question ready for DB persistence.
type SaveQuestionInput struct {
	QuestionNum       int
	ParentQuestionNum *int
	ParentNumsStr     *string
	SubNum            int
	Topic             string
	VideoURL          string
	MetaJSON          *string
	ExerciseURL       string
	ExerciseName      string
	AnswerURL         string
	AnswerName        string
}

// SaveWeekRequest holds all inputs for transactional POST save.
type SaveWeekRequest struct {
	BankType  string
	Year      int
	Season    string
	Subject   string
	Grade     string
	Tier      string
	Week      int
	Operator  string
	Questions []SaveQuestionInput
	RawMaps   []map[string]any
}

// Repository abstracts persistence for /api/qbank.php.
type Repository interface {
	ListWeeks(ctx context.Context, filter ListFilter) ([]WeekListItem, error)
	GetWeek(ctx context.Context, key WeekKey) (*WeekDetail, error)
	SaveWeek(ctx context.Context, req SaveWeekRequest) (removedPDFCandidates []string, err error)
	DeleteWeek(ctx context.Context, key WeekKey) (deletedPDFCandidates []string, err error)
	CountPDFReferences(ctx context.Context, relURL string) (int, error)
}

// CleanupUnreferencedPDFs deletes orphan files under <feedbackRoot>/data/pdfs/ when DB reference count == 0.
func CleanupUnreferencedPDFs(ctx context.Context, repo Repository, feedbackRoot string, candidates []string) int {
	if repo == nil || strings.TrimSpace(feedbackRoot) == "" || len(candidates) == 0 {
		return 0
	}
	seen := make(map[string]struct{}, len(candidates))
	pdfDir := filepath.Join(feedbackRoot, "data", "pdfs")
	deleted := 0
	for _, raw := range candidates {
		relURL := strings.TrimSpace(raw)
		if relURL == "" {
			continue
		}
		if _, dup := seen[relURL]; dup {
			continue
		}
		seen[relURL] = struct{}{}

		fileName, ok := IsValidManagedPDFPath(relURL)
		if !ok {
			continue
		}
		fullPath := filepath.Join(pdfDir, fileName)
		info, err := os.Stat(fullPath)
		if err != nil || info.IsDir() {
			continue
		}
		refCount, err := repo.CountPDFReferences(ctx, relURL)
		if err == nil && refCount == 0 {
			if os.Remove(fullPath) == nil {
				deleted++
			}
		}
	}
	return deleted
}

// MySQLRepository implements Repository backed by *sql.DB.
type MySQLRepository struct {
	db *sql.DB
}

// NewMySQLRepository creates a MySQLRepository.
func NewMySQLRepository(db *sql.DB) *MySQLRepository {
	return &MySQLRepository{db: db}
}

func (r *MySQLRepository) requireDB() (*sql.DB, error) {
	if r == nil || r.db == nil {
		return nil, errors.New("database is not configured")
	}
	return r.db, nil
}

func (r *MySQLRepository) ListWeeks(ctx context.Context, filter ListFilter) ([]WeekListItem, error) {
	db, err := r.requireDB()
	if err != nil {
		return nil, err
	}
	var where []string
	var params []any
	if filter.Year != nil {
		where = append(where, "`year` = ?")
		params = append(params, *filter.Year)
	}
	if filter.Season != "" {
		where = append(where, "`season` = ?")
		params = append(params, filter.Season)
	}
	if filter.Subject != "" {
		where = append(where, "`subject` = ?")
		params = append(params, filter.Subject)
	}
	if filter.Grade != "" {
		where = append(where, "`grade` = ?")
		params = append(params, filter.Grade)
	}
	if filter.BankType != "" {
		where = append(where, "`bank_type` = ?")
		params = append(params, filter.BankType)
	}
	if filter.Search != "" {
		where = append(where, "(`subject` LIKE ? OR `grade` LIKE ? OR `tier` LIKE ?)")
		kw := "%" + filter.Search + "%"
		params = append(params, kw, kw, kw)
	}

	whereClause := ""
	if len(where) > 0 {
		whereClause = "WHERE " + strings.Join(where, " AND ")
	}
	query := "SELECT `id`, `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week`, `question_count`, ROUND(UNIX_TIMESTAMP(`updated_at`)*1000) " +
		"FROM `qbank_weeks` " + whereClause + " ORDER BY `year` DESC, `season` ASC, `updated_at` DESC"

	rows, err := db.QueryContext(ctx, query, params...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	items := make([]WeekListItem, 0)
	for rows.Next() {
		var item WeekListItem
		var updatedAt sql.NullFloat64
		if err := rows.Scan(
			&item.ID, &item.BankType, &item.Year, &item.Season, &item.Subject, &item.Grade, &item.Tier, &item.Week,
			&item.QuestionCount, &updatedAt,
		); err != nil {
			return nil, err
		}
		if updatedAt.Valid {
			item.UpdatedAt = updatedAt.Float64
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

type weekMetaRow struct {
	id            int64
	bankType      string
	year          int
	season        string
	subject       string
	grade         string
	tier          string
	week          int
	questionCount int
	createdBy     string
	updatedBy     string
	updatedAtStr  string
	updatedAtMs   float64
}

func scanWeekMetaRow(row *sql.Row) (*weekMetaRow, error) {
	var w weekMetaRow
	var createdBy, updatedBy, updatedAtStr sql.NullString
	var updatedAtMs sql.NullFloat64
	err := row.Scan(
		&w.id, &w.bankType, &w.year, &w.season, &w.subject, &w.grade, &w.tier, &w.week,
		&w.questionCount, &createdBy, &updatedBy, &updatedAtStr, &updatedAtMs,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	w.createdBy = createdBy.String
	w.updatedBy = updatedBy.String
	w.updatedAtStr = updatedAtStr.String
	if updatedAtMs.Valid {
		w.updatedAtMs = updatedAtMs.Float64
	}
	return &w, nil
}

func formatUpdatedAtMinute(raw string) string {
	s := strings.TrimSpace(raw)
	if len(s) >= 16 {
		return s[:16]
	}
	return s
}

func (r *MySQLRepository) GetWeek(ctx context.Context, key WeekKey) (*WeekDetail, error) {
	db, err := r.requireDB()
	if err != nil {
		return nil, err
	}
	var w *weekMetaRow
	if key.Year != nil && key.Season != "" {
		w, err = scanWeekMetaRow(db.QueryRowContext(
			ctx,
			"SELECT `id`, `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week`, `question_count`, `created_by`, `updated_by`, `updated_at`, ROUND(UNIX_TIMESTAMP(`updated_at`)*1000) "+
				"FROM `qbank_weeks` WHERE `year` = ? AND `season` = ? AND `subject` = ? AND `grade` = ? AND `tier` = ? AND `week` = ? AND `bank_type` = ? LIMIT 1",
			*key.Year, key.Season, key.Subject, key.Grade, key.Tier, key.Week, key.BankType,
		))
		if err != nil {
			return nil, err
		}
	}
	if w == nil {
		w, err = scanWeekMetaRow(db.QueryRowContext(
			ctx,
			"SELECT `id`, `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week`, `question_count`, `created_by`, `updated_by`, `updated_at`, ROUND(UNIX_TIMESTAMP(`updated_at`)*1000) "+
				"FROM `qbank_weeks` WHERE `subject` = ? AND `grade` = ? AND `tier` = ? AND `week` = ? AND `bank_type` = ? ORDER BY `year` DESC, `updated_at` DESC LIMIT 1",
			key.Subject, key.Grade, key.Tier, key.Week, key.BankType,
		))
		if err != nil {
			return nil, err
		}
	}
	if w == nil {
		return nil, nil
	}

	qRows, err := db.QueryContext(
		ctx,
		"SELECT `question_num`, `parent_question_num`, `parent_question_nums`, `sub_num`, `topic`, `video_url`, `question_meta`, `exercise_pdf`, `exercise_name`, `answer_pdf`, `answer_name` "+
			"FROM `qbank_questions` WHERE `qbank_id` = ? ORDER BY `question_num` ASC",
		w.id,
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = qRows.Close() }()

	questions := make([]QuestionItem, 0)
	for qRows.Next() {
		var qNum, subNum int
		var parentNum sql.NullInt64
		var parentNumsStr, topic, videoURL, qMetaStr, exURL, exName, ansURL, ansName sql.NullString
		if err := qRows.Scan(
			&qNum, &parentNum, &parentNumsStr, &subNum,
			&topic, &videoURL, &qMetaStr, &exURL, &exName, &ansURL, &ansName,
		); err != nil {
			return nil, err
		}

		var primaryAny any
		if parentNum.Valid {
			primaryAny = int(parentNum.Int64)
		}
		primaryPtr, parsedNums := ParseParentNums(primaryAny, parentNumsStr.String)

		exStatus := "empty"
		if exURL.String != "" {
			exStatus = "uploaded"
		}
		ansStatus := "empty"
		if ansURL.String != "" {
			ansStatus = "uploaded"
		}
		if subNum <= 0 {
			subNum = 1
		}

		qItem := QuestionItem{
			ID:                 qNum,
			ParentQuestionNum:  primaryPtr,
			ParentQuestionNums: parsedNums,
			SubNum:             subNum,
			Topic:              topic.String,
			VideoURL:           videoURL.String,
			ExercisePDF: PDFInfo{
				URL:    exURL.String,
				Name:   exName.String,
				Status: exStatus,
			},
			AnswerPDF: PDFInfo{
				URL:    ansURL.String,
				Name:   ansName.String,
				Status: ansStatus,
			},
		}
		if qMetaStr.Valid && strings.TrimSpace(qMetaStr.String) != "" {
			if cleanMeta := SanitizeQuestionMeta(qMetaStr.String); len(cleanMeta) > 0 {
				qItem.QuestionMeta = cleanMeta
			}
		}
		questions = append(questions, qItem)
	}
	if err := qRows.Err(); err != nil {
		return nil, err
	}

	resolvedBankType := NormalizeBankType(w.bankType)
	if resolvedBankType == "variation" && len(questions) > 0 {
		hwTopics := r.loadHomeworkTopicMap(ctx, db, w.year, w.season, w.subject, w.grade, w.tier, w.week)
		if len(hwTopics) > 0 {
			for i := range questions {
				for _, pNum := range VariationParentNums(questions[i].ParentQuestionNum, questions[i].ParentQuestionNums) {
					if t := hwTopics[pNum]; t != "" {
						questions[i].Topic = t
						break
					}
				}
			}
		}
	}

	operator := w.updatedBy
	if operator == "" {
		operator = w.createdBy
	}
	operatorName := ""
	if operator != "" {
		var realName sql.NullString
		if err := db.QueryRowContext(ctx, "SELECT `real_name` FROM `users` WHERE `username` = ? LIMIT 1", operator).Scan(&realName); err == nil {
			operatorName = realName.String
		}
	}

	qCount := w.questionCount
	if qCount == 0 && len(questions) > 0 {
		qCount = len(questions)
	}

	return &WeekDetail{
		BankType:           resolvedBankType,
		Year:               w.year,
		Season:             w.season,
		Subject:            w.subject,
		Grade:              w.grade,
		Tier:               w.tier,
		Week:               w.week,
		QuestionCount:      qCount,
		CreatedBy:          w.createdBy,
		UpdatedBy:          w.updatedBy,
		Operator:           operator,
		OperatorName:       operatorName,
		UpdatedAt:          w.updatedAtMs,
		UpdatedAtFormatted: formatUpdatedAtMinute(w.updatedAtStr),
		Questions:          questions,
	}, nil
}

func (r *MySQLRepository) loadHomeworkTopicMap(ctx context.Context, db *sql.DB, year int, season, subject, grade, tier string, week int) map[int]string {
	out := make(map[int]string)
	rows, err := db.QueryContext(
		ctx,
		"SELECT `question_num`, `topic` FROM `qbank_questions` WHERE `bank_type` = 'homework' AND `year` = ? AND `season` = ? AND `subject` = ? AND `grade` = ? AND `tier` = ? AND `week` = ? ORDER BY `question_num` ASC",
		year, season, subject, grade, tier, week,
	)
	if err != nil {
		return out
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var qNum int
		var topic sql.NullString
		if err := rows.Scan(&qNum, &topic); err == nil && qNum > 0 && strings.TrimSpace(topic.String) != "" {
			out[qNum] = strings.TrimSpace(topic.String)
		}
	}
	return out
}

func (r *MySQLRepository) SaveWeek(ctx context.Context, req SaveWeekRequest) ([]string, error) {
	db, err := r.requireDB()
	if err != nil {
		return nil, err
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	_, err = tx.ExecContext(
		ctx,
		`INSERT INTO `+"`qbank_weeks`"+` (`+"`bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week`, `question_count`, `created_by`, `updated_by`, `updated_at`"+`)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		 ON DUPLICATE KEY UPDATE
		   `+"`question_count`"+` = VALUES(`+"`question_count`"+`),
		   `+"`created_by`"+` = IF(`+"`created_by`"+` = '' OR `+"`created_by`"+` IS NULL, VALUES(`+"`created_by`"+`), `+"`created_by`"+`),
		   `+"`updated_by`"+` = IF(VALUES(`+"`updated_by`"+`) != '', VALUES(`+"`updated_by`"+`), `+"`updated_by`"+`),
		   `+"`updated_at`"+` = CURRENT_TIMESTAMP`,
		req.BankType, req.Year, req.Season, req.Subject, req.Grade, req.Tier, req.Week,
		len(req.Questions), req.Operator, req.Operator,
	)
	if err != nil {
		return nil, err
	}

	var qbankID int64
	err = tx.QueryRowContext(
		ctx,
		"SELECT `id` FROM `qbank_weeks` WHERE `year` = ? AND `season` = ? AND `subject` = ? AND `grade` = ? AND `tier` = ? AND `week` = ? AND `bank_type` = ? LIMIT 1",
		req.Year, req.Season, req.Subject, req.Grade, req.Tier, req.Week, req.BankType,
	).Scan(&qbankID)
	if err != nil || qbankID <= 0 {
		return nil, errors.New("failed to resolve qbank_weeks id after upsert")
	}

	// Collect old PDF URLs before overwriting
	oldPDFs := make(map[string]struct{})
	oldRows, err := tx.QueryContext(ctx, "SELECT `exercise_pdf`, `answer_pdf` FROM `qbank_questions` WHERE `qbank_id` = ?", qbankID)
	if err != nil {
		return nil, err
	}
	for oldRows.Next() {
		var ex, ans sql.NullString
		if err := oldRows.Scan(&ex, &ans); err == nil {
			if ex.String != "" {
				oldPDFs[ex.String] = struct{}{}
			}
			if ans.String != "" {
				oldPDFs[ans.String] = struct{}{}
			}
		}
	}
	_ = oldRows.Close()

	stmtQ, err := tx.PrepareContext(
		ctx,
		`INSERT INTO `+"`qbank_questions`"+`
		  (`+"`qbank_id`, `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week`, `question_num`, `parent_question_num`, `parent_question_nums`, `sub_num`, `topic`, `video_url`, `question_meta`, `exercise_pdf`, `exercise_name`, `answer_pdf`, `answer_name`, `created_by`, `updated_by`, `updated_at`"+`)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		 ON DUPLICATE KEY UPDATE
		   `+"`parent_question_num`"+` = VALUES(`+"`parent_question_num`"+`),
		   `+"`parent_question_nums`"+` = VALUES(`+"`parent_question_nums`"+`),
		   `+"`sub_num`"+` = VALUES(`+"`sub_num`"+`),
		   `+"`topic`"+` = VALUES(`+"`topic`"+`),
		   `+"`video_url`"+` = VALUES(`+"`video_url`"+`),
		   `+"`question_meta`"+` = VALUES(`+"`question_meta`"+`),
		   `+"`exercise_pdf`"+` = VALUES(`+"`exercise_pdf`"+`),
		   `+"`exercise_name`"+` = VALUES(`+"`exercise_name`"+`),
		   `+"`answer_pdf`"+` = VALUES(`+"`answer_pdf`"+`),
		   `+"`answer_name`"+` = VALUES(`+"`answer_name`"+`),
		   `+"`created_by`"+` = IF(`+"`created_by`"+` = '' OR `+"`created_by`"+` IS NULL, VALUES(`+"`created_by`"+`), `+"`created_by`"+`),
		   `+"`updated_by`"+` = IF(VALUES(`+"`updated_by`"+`) != '', VALUES(`+"`updated_by`"+`), `+"`updated_by`"+`),
		   `+"`updated_at`"+` = CURRENT_TIMESTAMP`,
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = stmtQ.Close() }()

	newPDFs := make(map[string]struct{})
	keepNums := make([]int, 0, len(req.Questions))
	for _, q := range req.Questions {
		if q.QuestionNum <= 0 {
			continue
		}
		keepNums = append(keepNums, q.QuestionNum)
		if q.ExerciseURL != "" {
			newPDFs[q.ExerciseURL] = struct{}{}
		}
		if q.AnswerURL != "" {
			newPDFs[q.AnswerURL] = struct{}{}
		}
		var parentNumArg any
		if q.ParentQuestionNum != nil {
			parentNumArg = *q.ParentQuestionNum
		}
		var parentNumsArg any
		if q.ParentNumsStr != nil {
			parentNumsArg = *q.ParentNumsStr
		}
		var metaArg any
		if q.MetaJSON != nil {
			metaArg = *q.MetaJSON
		}
		if _, err := stmtQ.ExecContext(
			ctx,
			qbankID, req.BankType, req.Year, req.Season, req.Subject, req.Grade, req.Tier, req.Week,
			q.QuestionNum, parentNumArg, parentNumsArg, q.SubNum, q.Topic, q.VideoURL, metaArg,
			q.ExerciseURL, q.ExerciseName, q.AnswerURL, q.AnswerName, req.Operator, req.Operator,
		); err != nil {
			return nil, err
		}
	}

	if len(keepNums) > 0 {
		placeholders := make([]string, len(keepNums))
		args := make([]any, 0, len(keepNums)+1)
		args = append(args, qbankID)
		for i, n := range keepNums {
			placeholders[i] = "?"
			args = append(args, n)
		}
		if _, err := tx.ExecContext(
			ctx,
			"DELETE FROM `qbank_questions` WHERE `qbank_id` = ? AND `question_num` NOT IN ("+strings.Join(placeholders, ",")+")",
			args...,
		); err != nil {
			return nil, err
		}
	} else {
		if _, err := tx.ExecContext(ctx, "DELETE FROM `qbank_questions` WHERE `qbank_id` = ?", qbankID); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}

	removed := make([]string, 0)
	for oldURL := range oldPDFs {
		if _, stillUsed := newPDFs[oldURL]; !stillUsed {
			removed = append(removed, oldURL)
		}
	}

	// Best-effort cascade homework topics to variation questions
	if req.BankType == "homework" {
		r.cascadeHomeworkTopicsToVariations(ctx, db, req)
	}

	return removed, nil
}

func (r *MySQLRepository) cascadeHomeworkTopicsToVariations(ctx context.Context, db *sql.DB, req SaveWeekRequest) {
	topicMap := BuildHomeworkTopicMapFromMaps(req.RawMaps)
	if len(topicMap) == 0 {
		return
	}
	rows, err := db.QueryContext(
		ctx,
		"SELECT `id`, `parent_question_num`, `parent_question_nums`, `topic` FROM `qbank_questions` WHERE `bank_type` = 'variation' AND `year` = ? AND `season` = ? AND `subject` = ? AND `grade` = ? AND `tier` = ? AND `week` = ?",
		req.Year, req.Season, req.Subject, req.Grade, req.Tier, req.Week,
	)
	if err != nil {
		return
	}
	type varRow struct {
		id         int64
		parentNum  *int
		parentNums []int
		topic      string
	}
	var targets []varRow
	for rows.Next() {
		var id int64
		var pNum sql.NullInt64
		var pNumsStr, topic sql.NullString
		if err := rows.Scan(&id, &pNum, &pNumsStr, &topic); err == nil {
			var pAny any
			if pNum.Valid {
				pAny = int(pNum.Int64)
			}
			primaryPtr, list := ParseParentNums(pAny, pNumsStr.String)
			targets = append(targets, varRow{id: id, parentNum: primaryPtr, parentNums: list, topic: topic.String})
		}
	}
	_ = rows.Close()

	if len(targets) == 0 {
		return
	}
	stmt, err := db.PrepareContext(ctx, "UPDATE `qbank_questions` SET `topic` = ?, `updated_at` = `updated_at` WHERE `id` = ?")
	if err != nil {
		return
	}
	defer func() { _ = stmt.Close() }()

	for _, vr := range targets {
		newTopic := ""
		for _, pNum := range VariationParentNums(vr.parentNum, vr.parentNums) {
			if t := topicMap[pNum]; t != "" {
				newTopic = t
				break
			}
		}
		if newTopic != "" && newTopic != vr.topic {
			_, _ = stmt.ExecContext(ctx, newTopic, vr.id)
		}
	}
}

func (r *MySQLRepository) DeleteWeek(ctx context.Context, key WeekKey) ([]string, error) {
	db, err := r.requireDB()
	if err != nil {
		return nil, err
	}
	var qbankID int64
	if key.Year != nil && key.Season != "" {
		err = db.QueryRowContext(
			ctx,
			"SELECT `id` FROM `qbank_weeks` WHERE `year` = ? AND `season` = ? AND `subject` = ? AND `grade` = ? AND `tier` = ? AND `week` = ? AND `bank_type` = ? LIMIT 1",
			*key.Year, key.Season, key.Subject, key.Grade, key.Tier, key.Week, key.BankType,
		).Scan(&qbankID)
	} else {
		err = db.QueryRowContext(
			ctx,
			"SELECT `id` FROM `qbank_weeks` WHERE `subject` = ? AND `grade` = ? AND `tier` = ? AND `week` = ? AND `bank_type` = ? LIMIT 1",
			key.Subject, key.Grade, key.Tier, key.Week, key.BankType,
		).Scan(&qbankID)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	candidates := make([]string, 0)
	pdfRows, err := db.QueryContext(ctx, "SELECT `exercise_pdf`, `answer_pdf` FROM `qbank_questions` WHERE `qbank_id` = ?", qbankID)
	if err == nil {
		for pdfRows.Next() {
			var ex, ans sql.NullString
			if scanErr := pdfRows.Scan(&ex, &ans); scanErr == nil {
				if ex.String != "" {
					candidates = append(candidates, ex.String)
				}
				if ans.String != "" {
					candidates = append(candidates, ans.String)
				}
			}
		}
		_ = pdfRows.Close()
	}

	if _, err := db.ExecContext(ctx, "DELETE FROM `qbank_questions` WHERE `qbank_id` = ?", qbankID); err != nil {
		return nil, err
	}
	if _, err := db.ExecContext(ctx, "DELETE FROM `qbank_weeks` WHERE `id` = ?", qbankID); err != nil {
		return nil, err
	}
	return candidates, nil
}

func (r *MySQLRepository) CountPDFReferences(ctx context.Context, relURL string) (int, error) {
	db, err := r.requireDB()
	if err != nil {
		return 0, err
	}
	var cnt int
	err = db.QueryRowContext(
		ctx,
		"SELECT COUNT(*) FROM `qbank_questions` WHERE `exercise_pdf` = ? OR `answer_pdf` = ?",
		relURL, relURL,
	).Scan(&cnt)
	return cnt, err
}

// JoinParentNums formats a sorted unique slice of ints as comma-separated string, or nil if empty.
func JoinParentNums(nums []int) *string {
	if len(nums) == 0 {
		return nil
	}
	cp := make([]int, len(nums))
	copy(cp, nums)
	sort.Ints(cp)
	parts := make([]string, len(cp))
	for i, n := range cp {
		parts[i] = strconv.Itoa(n)
	}
	s := strings.Join(parts, ",")
	return &s
}

// MarshalMetaJSON encodes sanitized questionMeta to JSON string pointer (nil if empty).
func MarshalMetaJSON(meta map[string]any) *string {
	if len(meta) == 0 {
		return nil
	}
	b, err := json.Marshal(meta)
	if err != nil {
		return nil
	}
	s := string(b)
	return &s
}
