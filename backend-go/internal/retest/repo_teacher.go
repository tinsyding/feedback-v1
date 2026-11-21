package retest

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"feedback-api/internal/normalize"
	"feedback-api/internal/retestkeys"
	"feedback-api/internal/textutil"
	"feedback-api/internal/tz"
)

// MySQLRepository implements Repository backed by MySQL *sql.DB.
type MySQLRepository struct {
	db *sql.DB
}

// NewMySQLRepository creates a MySQLRepository. If db is nil, calls fail closed.
func NewMySQLRepository(db *sql.DB) *MySQLRepository {
	return &MySQLRepository{db: db}
}

func (r *MySQLRepository) requireDB() error {
	if r == nil || r.db == nil {
		return NewHTTPError(500, "数据库连接失败")
	}
	return nil
}

func phs(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.Repeat("?,", n-1) + "?"
}

func formatDisplayScore(v float64) any {
	if math.Abs(v-math.Round(v)) < 0.001 {
		return int(math.Round(v))
	}
	return math.Round(v*10) / 10
}

func normalizeSeasonZh(s string) string {
	n := normalize.Season(s, "zh")
	if n == "" {
		return strings.TrimSpace(s)
	}
	return n
}

func intSlicesEqual(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// CheckExistingBatch mirrors PHP retest.php action=check_existing_batch.
func (r *MySQLRepository) CheckExistingBatch(ctx context.Context, in CheckBatchInput) (CheckBatchResult, error) {
	empty := CheckBatchResult{
		Success:          true,
		Exists:           false,
		HasDiff:          false,
		ModifiedStudents: []map[string]any{},
	}
	if in.Subject == "" || in.Grade == "" || in.Tier == "" || in.Week <= 0 {
		return empty, nil
	}
	if err := r.requireDB(); err != nil {
		return CheckBatchResult{}, err
	}

	normSeason := normalizeSeasonZh(in.Season)
	var batchID int
	var batchClassName, batchCreator sql.NullString
	err := r.db.QueryRowContext(ctx,
		"SELECT id, class_name, created_by FROM class_batches WHERE `year` = ? AND (`season` = ? OR `season` = ?) AND `grade` = ? AND `tier` = ? AND `subject` = ? LIMIT 1",
		in.Year, normSeason, in.Season, in.Grade, in.Tier, in.Subject,
	).Scan(&batchID, &batchClassName, &batchCreator)
	if errors.Is(err, sql.ErrNoRows) {
		return empty, nil
	}
	if err != nil {
		log.Printf("retest: CheckExistingBatch class_batches query error: %v", err)
		return CheckBatchResult{}, NewHTTPError(500, "检查班级历史批次失败，数据库服务异常")
	}

	var genCreator sql.NullString
	var genCreatedAt sql.NullTime
	_ = r.db.QueryRowContext(ctx,
		"SELECT created_by, created_at FROM `generation_batches` WHERE `class_id` = ? AND `week_num` = ? ORDER BY `id` DESC LIMIT 1",
		batchID, in.Week,
	).Scan(&genCreator, &genCreatedAt)

	operator := strings.TrimSpace(genCreator.String)
	if operator == "" {
		operator = strings.TrimSpace(batchCreator.String)
	}
	operatorName := r.lookupRealName(ctx, operator)
	createdAtFmt := ""
	if genCreatedAt.Valid {
		createdAtFmt = tz.In(genCreatedAt.Time).Format("2006-01-02 15:04")
	}

	if in.HasIncomingList {
		type incData struct {
			name   string
			id     string
			key    string
			score  float64
			errors []int
		}
		incomingMap := map[string]incData{}
		keySet := map[string]struct{}{}
		nameOnlySet := map[string]struct{}{}

		for _, st := range in.IncomingStudents {
			sName := strings.TrimSpace(st.Name)
			if sName == "" {
				continue
			}
			sID := strings.TrimSpace(st.ID)
			sKey := retestkeys.BuildStudentKey(sID, sName, in.Grade, in.Subject)
			legacyKey := retestkeys.LegacyStudentKey(sID, sName)
			errs := make([]int, len(st.Errors))
			copy(errs, st.Errors)
			sort.Ints(errs)
			item := incData{name: sName, id: sID, key: sKey, score: st.Score, errors: errs}
			incomingMap[sKey] = item
			if legacyKey != sKey {
				incomingMap[legacyKey] = item
			}
			if sKey != "" {
				keySet[sKey] = struct{}{}
			}
			if legacyKey != "" && legacyKey != sKey {
				keySet[legacyKey] = struct{}{}
			}
			if sID == "" {
				nameOnlySet[sName] = struct{}{}
			}
		}

		if len(keySet) == 0 && len(nameOnlySet) == 0 {
			return empty, nil
		}

		var whereOr []string
		params := []any{batchID, in.Week}
		if len(keySet) > 0 {
			whereOr = append(whereOr, fmt.Sprintf("`student_key` IN (%s)", phs(len(keySet))))
			for k := range keySet {
				params = append(params, k)
			}
		}
		if len(nameOnlySet) > 0 {
			whereOr = append(whereOr, fmt.Sprintf("((`student_key` IS NULL OR `student_key` = '' OR `student_key` = `student_name`) AND `student_name` IN (%s))", phs(len(nameOnlySet))))
			for n := range nameOnlySet {
				params = append(params, n)
			}
		}

		rows, err := r.db.QueryContext(ctx,
			"SELECT student_name, student_id, student_key, homework_score, error_count, error_questions, teacher_comment, updated_at, created_by FROM `student_records` WHERE `batch_id` = ? AND `week_num` = ? AND ("+strings.Join(whereOr, " OR ")+") ORDER BY updated_at ASC, id ASC",
			params...,
		)
		if err != nil {
			log.Printf("retest: CheckExistingBatch student_records query error: %v", err)
			return CheckBatchResult{}, NewHTTPError(500, "检查班级历史批次失败，数据库服务异常")
		}
		defer func() { _ = rows.Close() }()

		matchedCount := 0
		modifiedStudents := []map[string]any{}
		var lastUpdated time.Time
		latestRowOperator := ""

		for rows.Next() {
			var rName, rID, rKey, rErrRaw, rComment, rCreatedBy sql.NullString
			var rUpdAt sql.NullTime
			var rScore sql.NullFloat64
			var rErrCnt sql.NullInt64
			if err := rows.Scan(&rName, &rID, &rKey, &rScore, &rErrCnt, &rErrRaw, &rComment, &rUpdAt, &rCreatedBy); err != nil {
				log.Printf("retest: CheckExistingBatch scan error: %v", err)
				continue
			}
			var rawPtr *string
			if rErrRaw.Valid {
				s := rErrRaw.String
				rawPtr = &s
			}
			oldErrs := ParseJSONErrorInts(rawPtr)
			sort.Ints(oldErrs)

			hasHomeworkData := rScore.Valid || rErrCnt.Int64 > 0 || len(oldErrs) > 0 || strings.TrimSpace(rComment.String) != ""
			if !hasHomeworkData {
				continue
			}

			rk := strings.TrimSpace(rKey.String)
			rn := strings.TrimSpace(rName.String)
			matched, ok := incomingMap[rk]
			if !ok {
				leg := retestkeys.LegacyStudentKey(rID.String, rn)
				if leg != rk {
					matched, ok = incomingMap[leg]
				}
			}
			if !ok && retestkeys.IsLegacyNameOnlyKey(rk, rn) {
				matched, ok = incomingMap[rn]
			}
			if !ok {
				continue
			}
			matchedCount++
			if rUpdAt.Valid && (lastUpdated.IsZero() || rUpdAt.Time.After(lastUpdated)) {
				lastUpdated = rUpdAt.Time
			}
			latestRowOperator = strings.TrimSpace(rCreatedBy.String)

			scoreChanged := false
			var oldScoreDisplay any
			if rScore.Valid {
				oldScore := rScore.Float64
				scoreChanged = math.Abs(oldScore-matched.score) > 0.01
				oldScoreDisplay = formatDisplayScore(oldScore)
			}
			errorsChanged := !intSlicesEqual(oldErrs, matched.errors)

			if scoreChanged || errorsChanged {
				displayName := rn
				if strings.TrimSpace(rID.String) != "" {
					displayName = strings.TrimSpace(rID.String) + " " + rn
				}
				modifiedStudents = append(modifiedStudents, map[string]any{
					"name":          displayName,
					"rawName":       rn,
					"studentId":     rID.String,
					"operator":      strings.TrimSpace(rCreatedBy.String),
					"scoreChanged":  scoreChanged,
					"errorsChanged": errorsChanged,
					"oldScore":      oldScoreDisplay,
					"newScore":      formatDisplayScore(matched.score),
					"oldErrors":     oldErrs,
					"newErrors":     matched.errors,
				})
			}
		}

		if !lastUpdated.IsZero() {
			createdAtFmt = tz.In(lastUpdated).Format("2006-01-02 15:04")
		}
		if latestRowOperator != "" {
			operator = latestRowOperator
			operatorName = r.lookupRealName(ctx, operator)
		}

		return CheckBatchResult{
			Success:          true,
			Exists:           matchedCount > 0,
			HasDiff:          len(modifiedStudents) > 0,
			ModifiedStudents: modifiedStudents,
			Data: map[string]any{
				"createdAt":     createdAtFmt,
				"createdBy":     operator,
				"createdByName": operatorName,
				"matchedCount":  matchedCount,
				"modifiedCount": len(modifiedStudents),
			},
		}, nil
	}

	// Fallback when incomingStudents not provided
	const hwNonEmptyCond = "(`homework_score` IS NOT NULL OR `error_count` > 0 OR COALESCE(`teacher_comment`, '') != '')"
	var recordCount int
	_ = r.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM `student_records` WHERE `batch_id` = ? AND `week_num` = ? AND "+hwNonEmptyCond, batchID, in.Week).Scan(&recordCount)
	if recordCount == 0 {
		return empty, nil
	}

	rows, err := r.db.QueryContext(ctx,
		"SELECT student_name, student_id, student_key, homework_score, error_count, error_questions FROM `student_records` WHERE `batch_id` = ? AND `week_num` = ? AND "+hwNonEmptyCond+" ORDER BY id ASC",
		batchID, in.Week,
	)
	if err != nil {
		log.Printf("retest: CheckExistingBatch fallback query error: %v", err)
		return CheckBatchResult{}, NewHTTPError(500, "检查班级历史批次失败，数据库服务异常")
	}
	defer func() { _ = rows.Close() }()

	studentsList := []map[string]any{}
	for rows.Next() {
		var rName, rID, rKey, rErrRaw sql.NullString
		var rScore sql.NullFloat64
		var rErrCnt sql.NullInt64
		if err := rows.Scan(&rName, &rID, &rKey, &rScore, &rErrCnt, &rErrRaw); err != nil {
			continue
		}
		var rawPtr *string
		if rErrRaw.Valid {
			s := rErrRaw.String
			rawPtr = &s
		}
		studentsList = append(studentsList, map[string]any{
			"name":   strings.TrimSpace(rName.String),
			"id":     strings.TrimSpace(rID.String),
			"key":    strings.TrimSpace(rKey.String),
			"score":  rScore.Float64,
			"errors": ParseJSONErrorInts(rawPtr),
		})
	}

	return CheckBatchResult{
		Success:          true,
		Exists:           true,
		HasDiff:          false,
		ModifiedStudents: []map[string]any{},
		Data: map[string]any{
			"createdAt":     createdAtFmt,
			"createdBy":     operator,
			"createdByName": operatorName,
			"students":      studentsList,
		},
	}, nil
}

func (r *MySQLRepository) lookupRealName(ctx context.Context, username string) string {
	if username == "" {
		return ""
	}
	var rn sql.NullString
	_ = r.db.QueryRowContext(ctx, "SELECT real_name FROM users WHERE username = ? LIMIT 1", username).Scan(&rn)
	return strings.TrimSpace(rn.String)
}

// GetStudentWeekRecord mirrors PHP retest.php action=get_student_week_record.
func (r *MySQLRepository) GetStudentWeekRecord(ctx context.Context, q StudentWeekQuery) (StudentWeekResult, error) {
	out := StudentWeekResult{
		Success:  true,
		Students: []map[string]any{},
		Record:   nil,
	}
	if q.Subject == "" || q.Grade == "" {
		return out, nil
	}
	if err := r.requireDB(); err != nil {
		return StudentWeekResult{}, err
	}
	normSeason := normalizeSeasonZh(q.Season)

	if q.StudentName == "" || q.WithRoster {
		rows, err := r.db.QueryContext(ctx, `
			SELECT sr.student_id, sr.student_name, sr.student_key, cb.tier,
			       MAX(sr.updated_at) AS last_seen,
			       MAX(CASE WHEN cb.year = ? AND (cb.season = ? OR cb.season = ?) THEN 1 ELSE 0 END) AS is_current_term,
			       MAX(CASE WHEN cb.tier = ? THEN 1 ELSE 0 END) AS is_current_tier
			FROM student_records sr
			INNER JOIN class_batches cb ON sr.batch_id = cb.id
			WHERE cb.subject = ? AND cb.grade = ?
			GROUP BY sr.student_id, sr.student_name, sr.student_key, cb.tier
			ORDER BY is_current_term DESC, is_current_tier DESC, last_seen DESC
			LIMIT 600`,
			q.Year, normSeason, q.Season, q.Tier, q.Subject, q.Grade,
		)
		if err != nil {
			log.Printf("retest: GetStudentWeekRecord roster query error: %v", err)
			return StudentWeekResult{}, NewHTTPError(500, "查询学员错题记录失败")
		}
		type rosterEntry struct {
			id    string
			name  string
			key   string
			tier  string
			tiers []string
		}
		order := []string{}
		seen := map[string]*rosterEntry{}
		for rows.Next() {
			var sID, sName, sKey, rTier sql.NullString
			var lastSeen sql.NullTime
			var isCurTerm, isCurTier int
			if err := rows.Scan(&sID, &sName, &sKey, &rTier, &lastSeen, &isCurTerm, &isCurTier); err != nil {
				continue
			}
			sn := strings.TrimSpace(sName.String)
			if sn == "" {
				continue
			}
			sid := strings.TrimSpace(sID.String)
			dedup := sn
			if sid != "" {
				dedup = sid + "_" + sn
			}
			rt := strings.TrimSpace(rTier.String)
			if entry, ok := seen[dedup]; !ok {
				tiers := []string{}
				if rt != "" {
					tiers = append(tiers, rt)
				}
				seen[dedup] = &rosterEntry{
					id:    sid,
					name:  sn,
					key:   retestkeys.BuildStudentKey(sid, sn, q.Grade, q.Subject),
					tier:  rt,
					tiers: tiers,
				}
				order = append(order, dedup)
			} else {
				if rt != "" {
					found := false
					for _, t := range entry.tiers {
						if t == rt {
							found = true
							break
						}
					}
					if !found {
						entry.tiers = append(entry.tiers, rt)
					}
				}
				if rt == q.Tier && entry.tier != q.Tier {
					entry.tier = rt
				}
			}
		}
		_ = rows.Close()
		for _, k := range order {
			e := seen[k]
			out.Students = append(out.Students, map[string]any{
				"id":    e.id,
				"name":  e.name,
				"key":   e.key,
				"tier":  e.tier,
				"tiers": e.tiers,
			})
		}
	}

	if q.StudentName != "" {
		studentID := q.StudentID
		if studentID == "" {
			idRows, err := r.db.QueryContext(ctx, `
				SELECT sr.student_id
				FROM student_records sr
				INNER JOIN class_batches cb ON sr.batch_id = cb.id
				WHERE cb.subject = ? AND cb.grade = ? AND sr.student_name = ? AND sr.student_id != ''
				GROUP BY sr.student_id
				ORDER BY MAX(cb.tier = ?) DESC, MAX(sr.updated_at) DESC
				LIMIT 2`,
				q.Subject, q.Grade, q.StudentName, q.Tier,
			)
			if err == nil {
				var ids []string
				for idRows.Next() {
					var sid sql.NullString
					if err := idRows.Scan(&sid); err == nil && strings.TrimSpace(sid.String) != "" {
						ids = append(ids, strings.TrimSpace(sid.String))
					}
				}
				_ = idRows.Close()
				if len(ids) == 1 {
					studentID = ids[0]
				}
			}
		}

		cands := retestkeys.StudentKeyCandidates(studentID, q.StudentName, q.Grade, q.Subject)
		whereStudent := fmt.Sprintf("sr.student_key IN (%s)", phs(len(cands)))
		studentParams := make([]any, 0, len(cands)+1)
		for _, c := range cands {
			studentParams = append(studentParams, c)
		}
		if studentID == "" {
			whereStudent = "(" + whereStudent + " OR ((sr.student_key IS NULL OR sr.student_key = '' OR sr.student_key = sr.student_name) AND sr.student_name = ?))"
			studentParams = append(studentParams, q.StudentName)
		}

		hwErrors := []int{}
		hasHwRecord := false
		hwUpdatedAt := ""
		var hwScore *float64
		hwComment := ""
		isHwUnsubmitted := false
		isHwFullScore := false
		retestToken := ""

		if q.Week > 0 {
			hwParams := append([]any{q.Subject, q.Grade, q.Week}, studentParams...)
			hwParams = append(hwParams, q.Tier)
			if rows, err := r.db.QueryContext(ctx,
				"SELECT sr.retest_token, sr.error_questions, sr.error_count, sr.homework_score, sr.teacher_comment, sr.submission_status, sr.updated_at FROM `student_records` sr INNER JOIN `class_batches` cb ON sr.batch_id = cb.id WHERE cb.subject = ? AND cb.grade = ? AND sr.week_num = ? AND "+whereStudent+" ORDER BY (cb.tier = ?) DESC, sr.updated_at DESC, sr.id DESC",
				hwParams...,
			); err != nil {
				log.Printf("retest: GetStudentWeekRecord hw query error: %v", err)
			} else {
				for rows.Next() {
					var tok, eqRaw, comment, subSt sql.NullString
					var updAt sql.NullTime
					var errCnt sql.NullInt64
					var score sql.NullFloat64
					if err := rows.Scan(&tok, &eqRaw, &errCnt, &score, &comment, &subSt, &updAt); err != nil {
						log.Printf("retest: GetStudentWeekRecord hw scan error: %v", err)
						continue
					}
					if retestToken == "" && strings.TrimSpace(tok.String) != "" {
						retestToken = strings.TrimSpace(tok.String)
					}
					var eqPtr *string
					if eqRaw.Valid {
						s := eqRaw.String
						eqPtr = &s
					}
					errs := ParseJSONErrorInts(eqPtr)
					sort.Ints(errs)
					var scPtr *float64
					if score.Valid {
						v := score.Float64
						scPtr = &v
					}
					cComment := strings.TrimSpace(comment.String)
					expSt := strings.TrimSpace(subSt.String)
					hasHw := len(errs) > 0 || scPtr != nil || cComment != "" || expSt != "" || errCnt.Int64 > 0
					if hasHw || !hasHwRecord {
						hwErrors = errs
						hasHwRecord = hasHw
						hwScore = scPtr
						hwComment = cComment
						if updAt.Valid {
							hwUpdatedAt = tz.In(updAt.Time).Format("01-02 15:04")
						}
						resolved := ResolveSubmissionStatus(expSt, errs, scPtr, cComment)
						isHwUnsubmitted = resolved == "unsubmitted"
						isHwFullScore = !isHwUnsubmitted && len(errs) == 0
						if hasHw {
							break
						}
					}
				}
				_ = rows.Close()
			}
		}

		pvErrors := []int{}
		hasPvRecord := false
		pvUpdatedAt := ""
		var pvScore *float64
		pvComment := ""
		isPvUnsubmitted := false
		isPvFullScore := false
		targetPvWeek := q.PreviewWeek
		if targetPvWeek <= 0 {
			targetPvWeek = q.Week
		}

		if targetPvWeek > 0 {
			pvParams := append([]any{q.Subject, q.Grade, targetPvWeek, targetPvWeek}, studentParams...)
			pvParams = append(pvParams, q.Tier)
			if rows, err := r.db.QueryContext(ctx,
				"SELECT sr.retest_token, sr.preview_error_questions, sr.preview_score, sr.preview_comment, sr.preview_submission_status, sr.updated_at FROM `student_records` sr INNER JOIN `class_batches` cb ON sr.batch_id = cb.id WHERE cb.subject = ? AND cb.grade = ? AND (sr.preview_week_num = ? OR (sr.preview_week_num IS NULL AND sr.week_num = ?)) AND "+whereStudent+" ORDER BY (sr.preview_error_questions IS NOT NULL) DESC, (cb.tier = ?) DESC, sr.updated_at DESC, sr.id DESC",
				pvParams...,
			); err != nil {
				log.Printf("retest: GetStudentWeekRecord pv query error: %v", err)
			} else {
				for rows.Next() {
					var tok, peqRaw, pComment, pSubSt sql.NullString
					var updAt sql.NullTime
					var pScore sql.NullFloat64
					if err := rows.Scan(&tok, &peqRaw, &pScore, &pComment, &pSubSt, &updAt); err != nil {
						log.Printf("retest: GetStudentWeekRecord pv scan error: %v", err)
						continue
					}
					if retestToken == "" && strings.TrimSpace(tok.String) != "" {
						retestToken = strings.TrimSpace(tok.String)
					}
					var scPtr *float64
					if pScore.Valid {
						v := pScore.Float64
						scPtr = &v
					}
					cComment := strings.TrimSpace(pComment.String)
					expSt := strings.TrimSpace(pSubSt.String)
					if peqRaw.Valid || scPtr != nil || cComment != "" || expSt != "" {
						var peqPtr *string
						if peqRaw.Valid {
							s := peqRaw.String
							peqPtr = &s
						}
						pvErrors = ParseJSONErrorInts(peqPtr)
						sort.Ints(pvErrors)
						hasPvRecord = true
						pvScore = scPtr
						pvComment = cComment
						if updAt.Valid {
							pvUpdatedAt = tz.In(updAt.Time).Format("01-02 15:04")
						}
						resolved := ResolveSubmissionStatus(expSt, pvErrors, scPtr, cComment)
						isPvUnsubmitted = resolved == "unsubmitted"
						isPvFullScore = !isPvUnsubmitted && len(pvErrors) == 0
						break
					}
				}
				_ = rows.Close()
			}
		}

		stdKey := retestkeys.BuildStudentKey(studentID, q.StudentName, q.Grade, q.Subject)
		if retestToken == "" {
			retestToken = normalize.DeriveRetestToken(q.Subject, q.Grade, stdKey, q.SecretKey)
		}

		out.Record = map[string]any{
			"studentId":             studentID,
			"studentName":           q.StudentName,
			"studentKey":            stdKey,
			"week":                  q.Week,
			"previewWeek":           targetPvWeek,
			"hasHomeworkRecord":     hasHwRecord,
			"homeworkErrors":        hwErrors,
			"homeworkScore":         hwScore,
			"homeworkComment":       hwComment,
			"isHomeworkUnsubmitted": isHwUnsubmitted,
			"isHomeworkFullScore":   isHwFullScore,
			"homeworkUpdatedAt":     hwUpdatedAt,
			"hasPreviewRecord":      hasPvRecord,
			"previewErrors":         pvErrors,
			"previewScore":          pvScore,
			"previewComment":        pvComment,
			"isPreviewUnsubmitted":  isPvUnsubmitted,
			"isPreviewFullScore":    isPvFullScore,
			"previewUpdatedAt":      pvUpdatedAt,
			"retestToken":           retestToken,
		}
	}

	return out, nil
}

// EncryptBatch mirrors PHP retest.php action=encrypt_batch inside a single transaction.
func (r *MySQLRepository) EncryptBatch(ctx context.Context, in EncryptBatchInput) (EncryptBatchResult, error) {
	if err := r.requireDB(); err != nil {
		return EncryptBatchResult{}, NewHTTPError(500, "无法创建或获取班级批次信息，数据库操作异常")
	}

	normSeason := normalize.Season(in.Season, "zh")
	if normSeason == "" {
		normSeason = "秋"
	}
	yearStr := strconv.Itoa(in.Year)
	shortYear := yearStr
	if len(yearStr) >= 2 {
		shortYear = yearStr[len(yearStr)-2:]
	}
	className := fmt.Sprintf("%s%s_%s_%s_%s", shortYear, normSeason, in.Grade, in.Tier, in.Subject)

	var batchID int
	var batchCreator sql.NullString
	err := r.db.QueryRowContext(ctx,
		"SELECT id, created_by FROM class_batches WHERE `year` = ? AND (`season` = ? OR `season` = ?) AND `grade` = ? AND `tier` = ? AND `subject` = ? LIMIT 1",
		in.Year, normSeason, in.Season, in.Grade, in.Tier, in.Subject,
	).Scan(&batchID, &batchCreator)
	if errors.Is(err, sql.ErrNoRows) {
		res, insErr := r.db.ExecContext(ctx,
			"INSERT INTO class_batches (`year`, `season`, `grade`, `tier`, `subject`, `class_name`, `created_by`) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE `id` = LAST_INSERT_ID(`id`)",
			in.Year, normSeason, in.Grade, in.Tier, in.Subject, className, in.CurrentTeacher,
		)
		if insErr != nil {
			log.Printf("retest: EncryptBatch class_batches insert error: %v", insErr)
			return EncryptBatchResult{}, NewHTTPError(500, "无法创建或获取班级批次信息，数据库操作异常")
		}
		lastID, _ := res.LastInsertId()
		batchID = int(lastID)
	} else if err != nil {
		log.Printf("retest: EncryptBatch class_batches query error: %v", err)
		return EncryptBatchResult{}, NewHTTPError(500, "无法创建或获取班级批次信息，数据库操作异常")
	} else if in.CurrentTeacher != "" && strings.TrimSpace(batchCreator.String) == "" {
		_, _ = r.db.ExecContext(ctx, "UPDATE class_batches SET `created_by` = ? WHERE `id` = ?", in.CurrentTeacher, batchID)
	}

	// 60-second debounce check
	isDebounced := false
	var prevBatchCode, prevCreator sql.NullString
	var prevCreatedAt sql.NullTime
	var prevStudentCount int
	var prevGenID int
	if err := r.db.QueryRowContext(ctx,
		"SELECT id, batch_code, created_by, student_count, created_at FROM `generation_batches` WHERE `class_id` = ? AND `week_num` = ? ORDER BY id DESC LIMIT 1",
		batchID, in.Week,
	).Scan(&prevGenID, &prevBatchCode, &prevCreator, &prevStudentCount, &prevCreatedAt); err == nil {
		if prevCreatedAt.Valid {
			diff := time.Since(prevCreatedAt.Time).Seconds()
			sameTeacher := in.CurrentTeacher == "" || strings.TrimSpace(prevCreator.String) == "" || strings.TrimSpace(prevCreator.String) == in.CurrentTeacher
			if diff >= 0 && diff <= 60 && sameTeacher && prevStudentCount == len(in.Students) {
				isDebounced = true
			}
		}
	}

	batchCode := prevBatchCode.String
	if !isDebounced {
		var rnd [2]byte
		_, _ = rand.Read(rnd[:])
		batchCode = "B" + tz.Now().Format("20060102_150405") + "_" + hex.EncodeToString(rnd[:])
	}

	var sourceFilesJSON any
	if len(in.SourceFiles) > 0 {
		b, _ := json.Marshal(in.SourceFiles)
		sourceFilesJSON = string(b)
	}

	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		log.Printf("retest: EncryptBatch begin tx error: %v", err)
		return EncryptBatchResult{}, NewHTTPError(500, "数据库事务启动失败")
	}
	defer func() { _ = tx.Rollback() }()

	// Archive existing records before overwriting (skip when debounced)
	if !isDebounced && len(in.Students) > 0 {
		keySet := map[string]struct{}{}
		nameSet := map[string]struct{}{}
		for _, st := range in.Students {
			sn := strings.TrimSpace(st.Name)
			if sn == "" {
				continue
			}
			sid := strings.TrimSpace(st.ID)
			if sid != "" {
				keySet[retestkeys.BuildStudentKey(sid, sn, in.Grade, in.Subject)] = struct{}{}
				keySet[retestkeys.LegacyStudentKey(sid, sn)] = struct{}{}
			} else {
				nameSet[sn] = struct{}{}
			}
		}
		var whereOr []string
		qParams := []any{batchID, in.Week}
		if len(keySet) > 0 {
			whereOr = append(whereOr, fmt.Sprintf("`student_key` IN (%s)", phs(len(keySet))))
			for k := range keySet {
				qParams = append(qParams, k)
			}
		}
		if len(nameSet) > 0 {
			whereOr = append(whereOr, fmt.Sprintf("(`student_name` IN (%s) AND (`student_key` IS NULL OR `student_key` = '' OR `student_key` = `student_name`))", phs(len(nameSet))))
			for n := range nameSet {
				qParams = append(qParams, n)
			}
		}
		if len(whereOr) > 0 {
			exRows, err := tx.QueryContext(ctx,
				"SELECT id, batch_id, student_id, student_name, student_key, week_num, preview_week_num, homework_score, preview_score, total_score, error_count, error_questions, preview_error_questions, teacher_comment, preview_comment, source_files, retest_token, created_at, updated_at FROM `student_records` WHERE `batch_id` = ? AND `week_num` = ? AND ("+strings.Join(whereOr, " OR ")+")",
				qParams...,
			)
			if err != nil {
				log.Printf("retest: EncryptBatch archive select error: %v", err)
				return EncryptBatchResult{}, NewHTTPError(500, "历史学情归档失败，为防止数据丢失已终止覆盖操作")
			}
			type exRec struct {
				id, batchID, weekNum, errCount                 int
				studentID, studentName, studentKey, errQ, comment sql.NullString
				createdAt, updatedAt                           sql.NullTime
				previewWeekNum                                 sql.NullInt64
				hwScore, pvScore, totScore                     sql.NullFloat64
				pvErrQ, pvComment, srcFiles, token             sql.NullString
			}
			var existing []exRec
			for exRows.Next() {
				var e exRec
				if err := exRows.Scan(&e.id, &e.batchID, &e.studentID, &e.studentName, &e.studentKey, &e.weekNum, &e.previewWeekNum, &e.hwScore, &e.pvScore, &e.totScore, &e.errCount, &e.errQ, &e.pvErrQ, &e.comment, &e.pvComment, &e.srcFiles, &e.token, &e.createdAt, &e.updatedAt); err != nil {
					_ = exRows.Close()
					log.Printf("retest: EncryptBatch archive scan error: %v", err)
					return EncryptBatchResult{}, NewHTTPError(500, "历史学情归档失败，为防止数据丢失已终止覆盖操作")
				}
				existing = append(existing, e)
			}
			if rowsErr := exRows.Err(); rowsErr != nil {
				_ = exRows.Close()
				log.Printf("retest: EncryptBatch archive rows error: %v", rowsErr)
				return EncryptBatchResult{}, NewHTTPError(500, "历史学情归档失败，为防止数据丢失已终止覆盖操作")
			}
			_ = exRows.Close()

			opType := "batch_overwrite"
			if in.IsErrorsOnly {
				opType = "manual_edit"
			}
			for _, ex := range existing {
				if _, err := tx.ExecContext(ctx, `
					INSERT INTO student_record_history (
						record_id, batch_id, batch_code, student_id, student_name, student_key, week_num,
						preview_week_num, homework_score, preview_score, total_score, error_count, error_questions,
						preview_error_questions, teacher_comment, preview_comment,
						source_files, retest_token, created_by, operator, operation_type, record_created_at, record_updated_at, archived_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
					ex.id, ex.batchID, prevBatchCode.String, ex.studentID.String, ex.studentName.String, ex.studentKey.String, ex.weekNum,
					ex.previewWeekNum, ex.hwScore, ex.pvScore, ex.totScore, ex.errCount, ex.errQ,
					ex.pvErrQ, ex.comment, ex.pvComment,
					ex.srcFiles, ex.token, prevCreator.String, in.CurrentTeacher, opType, ex.createdAt, ex.updatedAt,
				); err != nil {
					log.Printf("retest: EncryptBatch archive insert error (record_id=%d): %v", ex.id, err)
					return EncryptBatchResult{}, NewHTTPError(500, "历史学情归档失败，为防止数据丢失已终止覆盖操作")
				}
			}
		}
	}

	tokens := map[string]string{}
	validStudentCount := 0
	errorStudentCount := 0

	for _, st := range in.Students {
		name := strings.TrimSpace(st.Name)
		if name == "" {
			continue
		}
		studentID := strings.TrimSpace(st.ID)
		studentKey := retestkeys.BuildStudentKey(studentID, name, in.Grade, in.Subject)
		legacyKey := retestkeys.LegacyStudentKey(studentID, name)

		errs := st.Errors
		if len(errs) == 0 && st.Comment != "" {
			errs = normalize.ParseErrorQuestionsFromComment(st.Comment)
		}
		pvErrs := st.PreviewErrors
		if len(pvErrs) == 0 && st.PreviewComment != "" {
			pvErrs = normalize.ParseErrorQuestionsFromComment(st.PreviewComment)
		}

		pvWeekVal := st.PreviewWeek
		if pvWeekVal <= 0 {
			pvWeekVal = in.PreviewWeek
		}
		if pvWeekVal <= 0 {
			pvWeekVal = in.Week
		}
		studentHasPreview := in.HasPreviewData || st.PreviewProvided || st.PreviewComment != "" || len(pvErrs) > 0

		hwStatus := "submitted"
		if in.HasHomeworkData {
			hwStatus = ResolveSubmissionStatus(st.SubmissionStatus, errs, st.HomeworkScore, st.Comment)
		}
		pvStatus := "submitted"
		if studentHasPreview {
			pvStatus = ResolveSubmissionStatus(st.PreviewSubmissionStatus, pvErrs, st.PreviewScore, st.PreviewComment)
		}

		shortToken := normalize.DeriveRetestToken(in.Subject, in.Grade, studentKey, in.SecretKey)

		errJSONBytes, _ := json.Marshal(errs)
		errJSON := string(errJSONBytes)

		var pvErrJSON any
		var pvWeekForDB any
		var pvCommentForDB any
		if studentHasPreview {
			b, _ := json.Marshal(pvErrs)
			pvErrJSON = string(b)
			pvWeekForDB = pvWeekVal
			if !in.IsErrorsOnly || st.PreviewComment != "" {
				pvCommentForDB = st.PreviewComment
			}
		}

		if legacyKey != studentKey {
			_, _ = tx.ExecContext(ctx,
				"UPDATE `student_records` SET `student_key` = ? WHERE `batch_id` = ? AND `week_num` = ? AND `student_key` = ?",
				studentKey, batchID, in.Week, legacyKey,
			)
		}

		var updateParts []string
		if in.HasHomeworkData {
			if in.IsErrorsOnly {
				updateParts = append(updateParts,
					"`batch_code` = VALUES(`batch_code`)",
					"`source_files` = COALESCE(VALUES(`source_files`), `source_files`)",
					"`homework_score` = COALESCE(VALUES(`homework_score`), `homework_score`)",
					"`total_score` = COALESCE(VALUES(`total_score`), `total_score`)",
					"`error_count` = VALUES(`error_count`)",
					"`error_questions` = VALUES(`error_questions`)",
					"`teacher_comment` = IF(VALUES(`teacher_comment`) != '', VALUES(`teacher_comment`), `teacher_comment`)",
					"`submission_status` = VALUES(`submission_status`)",
				)
			} else {
				updateParts = append(updateParts,
					"`batch_code` = VALUES(`batch_code`)",
					"`source_files` = VALUES(`source_files`)",
					"`homework_score` = VALUES(`homework_score`)",
					"`total_score` = VALUES(`total_score`)",
					"`error_count` = VALUES(`error_count`)",
					"`error_questions` = VALUES(`error_questions`)",
					"`teacher_comment` = VALUES(`teacher_comment`)",
					"`submission_status` = VALUES(`submission_status`)",
				)
			}
		}
		updateParts = append(updateParts,
			"`student_id` = IF(VALUES(`student_id`) != '', VALUES(`student_id`), `student_id`)",
			"`student_name` = VALUES(`student_name`)",
			"`preview_week_num` = COALESCE(VALUES(`preview_week_num`), `preview_week_num`)",
			"`preview_score` = COALESCE(VALUES(`preview_score`), `preview_score`)",
			"`preview_error_questions` = COALESCE(VALUES(`preview_error_questions`), `preview_error_questions`)",
			"`preview_comment` = COALESCE(VALUES(`preview_comment`), `preview_comment`)",
			"`retest_token` = VALUES(`retest_token`)",
			"`created_by` = IF(VALUES(`created_by`) != '', VALUES(`created_by`), `created_by`)",
			"`updated_at` = CURRENT_TIMESTAMP",
		)
		if studentHasPreview {
			updateParts = append(updateParts, "`preview_submission_status` = VALUES(`preview_submission_status`)")
		}

		upsertSQL := "INSERT INTO student_records " +
			"(`batch_id`, `batch_code`, `source_files`, `student_id`, `student_name`, `student_key`, `week_num`, `preview_week_num`, `homework_score`, `preview_score`, `total_score`, `error_count`, `error_questions`, `preview_error_questions`, `teacher_comment`, `preview_comment`, `submission_status`, `preview_submission_status`, `retest_token`, `created_by`) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
			"ON DUPLICATE KEY UPDATE " + strings.Join(updateParts, ", ")

		if _, err := tx.ExecContext(ctx, upsertSQL,
			batchID, batchCode, sourceFilesJSON, studentID, name, studentKey, in.Week, pvWeekForDB,
			st.HomeworkScore, st.PreviewScore, st.TotalScore, len(errs), errJSON, pvErrJSON,
			st.Comment, pvCommentForDB, hwStatus, pvStatus, shortToken, in.CurrentTeacher,
		); err != nil {
			log.Printf("retest: EncryptBatch upsert student_records error (student_key=%s): %v", studentKey, err)
			return EncryptBatchResult{}, NewHTTPError(500, "学生学情记录写入失败，操作已回滚")
		}

		if studentHasPreview && pvWeekVal > 0 {
			_, _ = tx.ExecContext(ctx,
				"UPDATE `student_records` SET `preview_error_questions` = ?, `preview_submission_status` = COALESCE(?, `preview_submission_status`), `updated_at` = CURRENT_TIMESTAMP WHERE `batch_id` = ? AND `student_key` = ? AND `preview_week_num` = ? AND `week_num` != ?",
				pvErrJSON, pvStatus, batchID, studentKey, pvWeekVal, in.Week,
			)
		}

		validStudentCount++
		if len(errs) > 0 || len(pvErrs) > 0 {
			errorStudentCount++
		}

		tokens[studentKey] = shortToken
		if legacyKey != studentKey {
			tokens[legacyKey] = shortToken
		}
		if st.FullName != "" {
			tokens[st.FullName] = shortToken
		}
		if studentID != "" {
			tokens[studentID+name] = shortToken
		} else {
			tokens[name] = shortToken
		}
	}

	if !isDebounced && validStudentCount > 0 {
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO generation_batches (`batch_code`, `class_id`, `week_num`, `student_count`, `error_student_count`, `source_files`, `created_by`, `created_at`) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())",
			batchCode, batchID, in.Week, validStudentCount, errorStudentCount, sourceFilesJSON, in.CurrentTeacher,
		); err != nil {
			log.Printf("retest: EncryptBatch generation_batches insert error: %v", err)
			return EncryptBatchResult{}, NewHTTPError(500, "生成批次记录失败，操作已回滚")
		}
	}

	if err := tx.Commit(); err != nil {
		log.Printf("retest: EncryptBatch tx commit error: %v", err)
		return EncryptBatchResult{}, NewHTTPError(500, "数据库事务提交失败")
	}

	return EncryptBatchResult{
		BatchCode:    batchCode,
		ClassName:    className,
		IsDebounced:  isDebounced,
		StudentCount: len(in.Students),
		Tokens:       tokens,
	}, nil
}

// IsTokenRevoked reports whether token exists in retest_revoked_tokens.
func (r *MySQLRepository) IsTokenRevoked(ctx context.Context, token string) (bool, error) {
	token = strings.TrimSpace(token)
	if token == "" || r == nil || r.db == nil {
		return false, nil
	}
	var found string
	err := r.db.QueryRowContext(ctx, "SELECT `token` FROM `retest_revoked_tokens` WHERE `token` = ? LIMIT 1", token).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return found != "", nil
}

// TokenExists checks whether token exists in student_records (or optionally retest_revoked_tokens).
func (r *MySQLRepository) TokenExists(ctx context.Context, token string, includeRevoked bool) (bool, error) {
	if err := r.requireDB(); err != nil {
		return false, err
	}
	var id int
	err := r.db.QueryRowContext(ctx, "SELECT id FROM student_records WHERE retest_token = ? LIMIT 1", token).Scan(&id)
	if err == nil {
		return true, nil
	}
	if includeRevoked {
		return r.IsTokenRevoked(ctx, token)
	}
	return false, nil
}

// RevokeToken adds/updates token in retest_revoked_tokens.
func (r *MySQLRepository) RevokeToken(ctx context.Context, token, operator, reason string) error {
	if err := r.requireDB(); err != nil {
		return err
	}
	token = textutil.TruncateRunes(strings.TrimSpace(token), 64)
	operator = textutil.TruncateRunes(strings.TrimSpace(operator), 50)
	reason = textutil.TruncateRunes(strings.TrimSpace(reason), 255)
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO retest_revoked_tokens (token, revoked_by, reason, revoked_at)
		VALUES (?, ?, ?, NOW())
		ON DUPLICATE KEY UPDATE revoked_by = VALUES(revoked_by), reason = VALUES(reason), revoked_at = NOW()`,
		token, operator, reason,
	)
	return err
}

// UnrevokeToken removes token from retest_revoked_tokens.
func (r *MySQLRepository) UnrevokeToken(ctx context.Context, token string) error {
	if err := r.requireDB(); err != nil {
		return err
	}
	token = textutil.TruncateRunes(strings.TrimSpace(token), 64)
	_, err := r.db.ExecContext(ctx, "DELETE FROM `retest_revoked_tokens` WHERE `token` = ?", token)
	return err
}

// LogAccess inserts a parent/admin access event into retest_access_logs.
func (r *MySQLRepository) LogAccess(ctx context.Context, token, studentName, action, details, ip, userAgent string) {
	if r == nil || r.db == nil {
		return
	}
	if strings.TrimSpace(token) == "" && strings.TrimSpace(studentName) == "" {
		return
	}
	_, _ = r.db.ExecContext(ctx,
		"INSERT INTO retest_access_logs (`token`, `student_name`, `action`, `details`, `ip`, `user_agent`) VALUES (?, ?, ?, ?, ?, ?)",
		textutil.TruncateRunes(token, 32),
		textutil.TruncateRunes(studentName, 50),
		textutil.TruncateRunes(action, 50),
		textutil.TruncateRunes(details, 255),
		textutil.TruncateRunes(ip, 45),
		textutil.TruncateRunes(userAgent, 500),
	)
}
