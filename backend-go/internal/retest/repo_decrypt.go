package retest

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"feedback-api/internal/normalize"
)

// FindTokenRecord resolves the latest student_records + class_batches row for retest_token.
func (r *MySQLRepository) FindTokenRecord(ctx context.Context, token string) (*TokenRecord, error) {
	if err := r.requireDB(); err != nil {
		return nil, NewHTTPError(500, "数据库查询服务异常，请稍后重试")
	}
	var rec TokenRecord
	var previewWeek sql.NullInt64
	var peqRaw, studentID, updatedAt, createdAt sql.NullString
	err := r.db.QueryRowContext(ctx, `
		SELECT cb.subject, cb.grade, cb.tier, sr.week_num, sr.preview_week_num,
		       sr.preview_error_questions, sr.student_name, sr.student_key, sr.student_id,
		       cb.year, cb.season, sr.updated_at, sr.created_at
		FROM student_records sr
		JOIN class_batches cb ON sr.batch_id = cb.id
		WHERE sr.retest_token = ?
		ORDER BY sr.updated_at DESC, sr.id DESC
		LIMIT 1`,
		token,
	).Scan(
		&rec.Subject, &rec.Grade, &rec.Tier, &rec.WeekNum, &previewWeek,
		&peqRaw, &rec.StudentName, &rec.StudentKey, &studentID,
		&rec.Year, &rec.Season, &updatedAt, &createdAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, NewHTTPError(500, "数据库查询服务异常，请稍后重试")
	}
	rec.StudentID = strings.TrimSpace(studentID.String)
	if previewWeek.Valid && previewWeek.Int64 > 0 {
		rec.PreviewWeekNum = int(previewWeek.Int64)
	} else {
		rec.PreviewWeekNum = rec.WeekNum
	}
	if peqRaw.Valid {
		s := peqRaw.String
		rec.PreviewErrors = ParseJSONErrorInts(&s)
	} else {
		rec.PreviewErrors = []int{}
	}
	tsStr := updatedAt.String
	if tsStr == "" {
		tsStr = createdAt.String
	}
	if t, ok := parseDBTime(tsStr); ok {
		rec.UpdatedUnix = t.Unix()
	}
	return &rec, nil
}

// LoadStudentHistoryAndAverages loads all student_records rows for the student and computes class weekly averages.
func (r *MySQLRepository) LoadStudentHistoryAndAverages(ctx context.Context, subject, grade, tier, studentID, studentName string, candidateKeys []string) (StudentHistoryBundle, error) {
	bundle := StudentHistoryBundle{
		Records:            []StudentRecordRow{},
		WeekAverages:       map[string]float64{},
		WeekAvgByBatchWeek: map[string]float64{},
	}
	if r == nil || r.db == nil || len(candidateKeys) == 0 {
		return bundle, nil
	}

	where := fmt.Sprintf("cb.subject = ? AND cb.grade = ? AND (sr.student_key IN (%s)", phs(len(candidateKeys)))
	params := make([]any, 0, 3+len(candidateKeys))
	params = append(params, subject, grade)
	for _, k := range candidateKeys {
		params = append(params, k)
	}
	if studentID == "" {
		where += " OR ((sr.student_key IS NULL OR sr.student_key = '' OR sr.student_key = sr.student_name) AND sr.student_name = ?)"
		params = append(params, studentName)
	}
	where += ")"

	rows, err := r.db.QueryContext(ctx,
		"SELECT sr.batch_id, cb.tier AS batch_tier, sr.week_num, sr.preview_week_num, sr.homework_score, sr.preview_score, sr.total_score, sr.error_count, sr.error_questions, sr.preview_error_questions, sr.teacher_comment, sr.preview_comment, sr.submission_status, sr.preview_submission_status FROM student_records sr JOIN class_batches cb ON sr.batch_id = cb.id WHERE "+where+" ORDER BY sr.updated_at ASC, sr.id ASC",
		params...,
	)
	if err != nil {
		return bundle, err
	}

	batchIDSet := map[int]struct{}{}
	for rows.Next() {
		var row StudentRecordRow
		var pvWeek sql.NullInt64
		var hwScore, pvScore, totScore sql.NullFloat64
		var errQ, pvErrQ, comment, pvComment, subSt, pvSubSt, batchTier sql.NullString
		var errCnt sql.NullInt64
		if err := rows.Scan(
			&row.BatchID, &batchTier, &row.WeekNum, &pvWeek,
			&hwScore, &pvScore, &totScore, &errCnt,
			&errQ, &pvErrQ, &comment, &pvComment, &subSt, &pvSubSt,
		); err != nil {
			continue
		}
		row.BatchTier = strings.TrimSpace(batchTier.String)
		if pvWeek.Valid {
			v := int(pvWeek.Int64)
			row.PreviewWeekNum = &v
		}
		if hwScore.Valid {
			v := hwScore.Float64
			row.HomeworkScore = &v
		}
		if pvScore.Valid {
			v := pvScore.Float64
			row.PreviewScore = &v
		}
		if totScore.Valid {
			v := totScore.Float64
			row.TotalScore = &v
		}
		row.ErrorCount = int(errCnt.Int64)
		if errQ.Valid {
			s := errQ.String
			row.ErrorQuestionsRaw = &s
		}
		if pvErrQ.Valid {
			s := pvErrQ.String
			row.PreviewErrorsRaw = &s
		}
		row.TeacherComment = comment.String
		row.PreviewComment = pvComment.String
		row.SubmissionStatus = strings.TrimSpace(subSt.String)
		row.PreviewSubmissionStatus = strings.TrimSpace(pvSubSt.String)

		bundle.Records = append(bundle.Records, row)
		if row.BatchID > 0 {
			batchIDSet[row.BatchID] = struct{}{}
		}
	}
	_ = rows.Close()

	// Compute class weekly averages (excluding 0s, rounding each score before AVG)
	if len(batchIDSet) > 0 {
		bParams := make([]any, 0, len(batchIDSet))
		for bid := range batchIDSet {
			bParams = append(bParams, bid)
		}
		if avgRows, err := r.db.QueryContext(ctx,
			fmt.Sprintf("SELECT batch_id, week_num, ROUND(AVG(ROUND(homework_score)), 1) AS avg_score FROM student_records WHERE batch_id IN (%s) AND homework_score IS NOT NULL AND homework_score > 0 GROUP BY batch_id, week_num", phs(len(bParams))),
			bParams...,
		); err == nil {
			for avgRows.Next() {
				var bid, wn int
				var avg float64
				if err := avgRows.Scan(&bid, &wn, &avg); err == nil {
					bundle.WeekAvgByBatchWeek[fmt.Sprintf("%d:%d", bid, wn)] = avg
					bundle.WeekAverages[fmt.Sprintf("%d", wn)] = avg
				}
			}
			_ = avgRows.Close()
		}
	}

	if len(bundle.WeekAverages) == 0 {
		if avgRows, err := r.db.QueryContext(ctx, `
			SELECT sr.week_num, ROUND(AVG(ROUND(sr.homework_score)), 1) AS avg_score
			FROM student_records sr
			JOIN class_batches cb ON sr.batch_id = cb.id
			WHERE cb.subject = ? AND cb.grade = ? AND cb.tier = ? AND sr.homework_score IS NOT NULL AND sr.homework_score > 0
			GROUP BY sr.week_num`,
			subject, grade, tier,
		); err == nil {
			for avgRows.Next() {
				var wn int
				var avg float64
				if err := avgRows.Scan(&wn, &avg); err == nil {
					bundle.WeekAverages[fmt.Sprintf("%d", wn)] = avg
				}
			}
			_ = avgRows.Close()
		}
	}

	return bundle, nil
}

// PreloadMultiWeekQbankRows loads all homework/preview/variation qbank_questions rows for the requested weeks in 1 query.
func (r *MySQLRepository) PreloadMultiWeekQbankRows(ctx context.Context, subject, grade string, weeks []int, year int, season string) ([]QbankQuestionRow, error) {
	if r == nil || r.db == nil || len(weeks) == 0 {
		return nil, nil
	}
	where := []string{"`subject` = ?", "`grade` = ?", fmt.Sprintf("`week` IN (%s)", phs(len(weeks)))}
	params := make([]any, 0, 4+len(weeks))
	params = append(params, subject, grade)
	for _, w := range weeks {
		params = append(params, w)
	}
	if year > 0 {
		where = append(where, "`year` = ?")
		params = append(params, year)
	}
	if strings.TrimSpace(season) != "" {
		variants := normalize.SeasonVariants(season)
		s1 := season
		s2 := season
		if len(variants) > 0 {
			s1 = variants[0]
		}
		if len(variants) > 1 {
			s2 = variants[1]
		}
		where = append(where, "(`season` = ? OR `season` = ?)")
		params = append(params, s1, s2)
	}

	sqlStr := "SELECT `id`, `bank_type`, `tier`, `week`, `question_num`, `parent_question_num`, `parent_question_nums`, `sub_num`, `topic`, `video_url`, `question_meta`, `exercise_pdf`, `answer_pdf` " +
		"FROM `qbank_questions` WHERE " + strings.Join(where, " AND ") +
		" ORDER BY `week` ASC, `question_num` ASC, `parent_question_num` ASC, `sub_num` ASC, `id` ASC"

	rows, err := r.db.QueryContext(ctx, sqlStr, params...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	out := []QbankQuestionRow{}
	for rows.Next() {
		var qr QbankQuestionRow
		var bankType, tier, parentNums, topic, videoURL, meta, exPDF, ansPDF sql.NullString
		var qNum, pNum, subNum sql.NullInt64
		if err := rows.Scan(&qr.ID, &bankType, &tier, &qr.Week, &qNum, &pNum, &parentNums, &subNum, &topic, &videoURL, &meta, &exPDF, &ansPDF); err != nil {
			continue
		}
		qr.BankType = bankType.String
		if qr.BankType == "" {
			qr.BankType = "homework"
		}
		qr.Tier = tier.String
		qr.QuestionNum = int(qNum.Int64)
		qr.ParentQuestionNum = int(pNum.Int64)
		qr.ParentQuestionNums = parentNums.String
		qr.SubNum = int(subNum.Int64)
		qr.Topic = topic.String
		qr.VideoURL = videoURL.String
		qr.QuestionMeta = meta.String
		qr.ExercisePDF = exPDF.String
		qr.AnswerPDF = ansPDF.String
		out = append(out, qr)
	}
	return out, rows.Err()
}
