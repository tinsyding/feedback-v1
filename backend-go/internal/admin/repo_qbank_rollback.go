package admin

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"feedback-api/internal/qbank"
	"feedback-api/internal/qbankattest"
)

func verifyRollbackPDFsExist(feedbackRoot string, questions []qbankattest.SnapshotQuestion) error {
	root := strings.TrimSpace(feedbackRoot)
	if root == "" || len(questions) == 0 {
		return nil
	}
	pdfDir := filepath.Join(root, "data", "pdfs")
	checked := make(map[string]struct{})
	for _, q := range questions {
		for _, raw := range []string{q.ExercisePDF, q.AnswerPDF} {
			relURL := strings.TrimSpace(raw)
			if relURL == "" {
				continue
			}
			if _, seen := checked[relURL]; seen {
				continue
			}
			checked[relURL] = struct{}{}

			fileName, ok := qbank.IsValidManagedPDFPath(relURL)
			if !ok {
				continue
			}
			fullPath := filepath.Join(pdfDir, fileName)
			info, err := os.Stat(fullPath)
			if err != nil || info.IsDir() {
				return NewHTTPError(409, fmt.Sprintf("回滚失败：历史快照引用的 PDF 文件已被清理或不存在 (%s)", fileName), err)
			}
		}
	}
	return nil
}

// RollbackQBankRevision restores qbank_weeks and qbank_questions for the scope
// of receiptCode to the exact question set recorded in snapshot_json, within a
// single database transaction, and appends an admin_rollback receipt.
func (r *MySQLRepository) RollbackQBankRevision(ctx context.Context, receiptCode, adminOp, adminName, clientIP string) (QBankRollbackResult, error) {
	if err := r.requireDB(); err != nil {
		return QBankRollbackResult{}, err
	}
	attest := r.getAttestStore()
	if attest == nil {
		return QBankRollbackResult{}, NewHTTPError(503, "存证服务未初始化，无法执行历史快照回滚", nil)
	}
	code := strings.TrimSpace(receiptCode)
	if code == "" {
		return QBankRollbackResult{}, NewHTTPError(400, "请提供目标存证回执编号 (receipt_code)", nil)
	}

	revSnap, err := attest.GetRevisionSnapshot(ctx, code)
	if errors.Is(err, qbankattest.ErrRevisionNotFound) {
		return QBankRollbackResult{}, NewHTTPError(404, "未找到指定的存证回执版本", err)
	}
	if err != nil {
		return QBankRollbackResult{}, NewHTTPError(500, "读取历史快照失败", err)
	}

	scope := qbankattest.NormalizeScope(revSnap.Scope)
	if !isValidQBankScope(scope) {
		return QBankRollbackResult{}, NewHTTPError(400, "历史快照作用域不完整，无法回滚", nil)
	}

	op := strings.TrimSpace(adminOp)
	if op == "" {
		op = "admin"
	}
	questions := revSnap.Snapshot.Questions
	feedbackRoot := ""
	if p, ok := attest.(interface{ FeedbackRoot() string }); ok {
		feedbackRoot = strings.TrimSpace(p.FeedbackRoot())
	}

	var receipt *qbankattest.Receipt
	err = qbank.WithPDFCleanupLock(func() error {
		if err := verifyRollbackPDFsExist(feedbackRoot, questions); err != nil {
			return err
		}

		tx, err := r.db.BeginTx(ctx, nil)
		if err != nil {
			return NewHTTPError(500, "开启回滚事务失败", err)
		}
		defer func() { _ = tx.Rollback() }()

		var qbankID int64
		if len(questions) == 0 {
			var existingQBankID int64
			lockErr := tx.QueryRowContext(
				ctx,
				"SELECT `id` FROM `qbank_weeks` WHERE `bank_type` = ? AND `year` = ? AND `season` = ? AND `subject` = ? AND `grade` = ? AND `tier` = ? AND `week` = ? LIMIT 1 FOR UPDATE",
				scope.BankType, scope.Year, scope.Season, scope.Subject, scope.Grade, scope.Tier, scope.Week,
			).Scan(&existingQBankID)
			if lockErr != nil && !errors.Is(lockErr, sql.ErrNoRows) {
				return NewHTTPError(500, "锁定当前题库期次失败，操作已回滚", lockErr)
			}
			if existingQBankID > 0 {
				if _, err := tx.ExecContext(
					ctx,
					"DELETE FROM `qbank_questions` WHERE `qbank_id` = ? OR (`bank_type` = ? AND `year` = ? AND `season` = ? AND `subject` = ? AND `grade` = ? AND `tier` = ? AND `week` = ?)",
					existingQBankID, scope.BankType, scope.Year, scope.Season, scope.Subject, scope.Grade, scope.Tier, scope.Week,
				); err != nil {
					return NewHTTPError(500, "清空当前题库题目失败，操作已回滚", err)
				}
			} else {
				if _, err := tx.ExecContext(
					ctx,
					"DELETE FROM `qbank_questions` WHERE `bank_type` = ? AND `year` = ? AND `season` = ? AND `subject` = ? AND `grade` = ? AND `tier` = ? AND `week` = ?",
					scope.BankType, scope.Year, scope.Season, scope.Subject, scope.Grade, scope.Tier, scope.Week,
				); err != nil {
					return NewHTTPError(500, "清空当前题库题目失败，操作已回滚", err)
				}
			}
			if _, err := tx.ExecContext(
				ctx,
				"DELETE FROM `qbank_weeks` WHERE `bank_type` = ? AND `year` = ? AND `season` = ? AND `subject` = ? AND `grade` = ? AND `tier` = ? AND `week` = ?",
				scope.BankType, scope.Year, scope.Season, scope.Subject, scope.Grade, scope.Tier, scope.Week,
			); err != nil {
				return NewHTTPError(500, "删除当前题库期次失败，操作已回滚", err)
			}
		} else {
			if _, err := tx.ExecContext(
				ctx,
				"INSERT INTO `qbank_weeks` (`bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week`, `question_count`, `created_by`, `updated_by`, `updated_at`) "+
					"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) "+
					"ON DUPLICATE KEY UPDATE "+
					"`id` = LAST_INSERT_ID(`id`), "+
					"`question_count` = VALUES(`question_count`), "+
					"`created_by` = IF(`created_by` = '' OR `created_by` IS NULL, VALUES(`created_by`), `created_by`), "+
					"`updated_by` = VALUES(`updated_by`), "+
					"`updated_at` = CURRENT_TIMESTAMP",
				scope.BankType, scope.Year, scope.Season, scope.Subject, scope.Grade, scope.Tier, scope.Week,
				len(questions), op, op,
			); err != nil {
				return NewHTTPError(500, "恢复题库期次记录失败，操作已回滚", err)
			}

			if err := tx.QueryRowContext(
				ctx,
				"SELECT `id` FROM `qbank_weeks` WHERE `bank_type` = ? AND `year` = ? AND `season` = ? AND `subject` = ? AND `grade` = ? AND `tier` = ? AND `week` = ? LIMIT 1",
				scope.BankType, scope.Year, scope.Season, scope.Subject, scope.Grade, scope.Tier, scope.Week,
			).Scan(&qbankID); err != nil {
				return NewHTTPError(500, "定位恢复后的题库期次 ID 失败，操作已回滚", err)
			}

			if _, err := tx.ExecContext(
				ctx,
				"DELETE FROM `qbank_questions` WHERE `qbank_id` = ? OR (`bank_type` = ? AND `year` = ? AND `season` = ? AND `subject` = ? AND `grade` = ? AND `tier` = ? AND `week` = ?)",
				qbankID, scope.BankType, scope.Year, scope.Season, scope.Subject, scope.Grade, scope.Tier, scope.Week,
			); err != nil {
				return NewHTTPError(500, "清理现有题目失败，操作已回滚", err)
			}

			for _, q := range questions {
				var parentNum sql.NullInt64
				if q.ParentQuestionNum != nil {
					parentNum = sql.NullInt64{Int64: int64(*q.ParentQuestionNum), Valid: true}
				}
				var parentNums sql.NullString
				if joined := qbank.JoinParentNums(q.ParentQuestionNums); joined != nil && *joined != "" {
					parentNums = sql.NullString{String: *joined, Valid: true}
				}
				var qMeta sql.NullString
				if metaPtr := qbank.MarshalMetaJSON(q.QuestionMeta); metaPtr != nil {
					qMeta = sql.NullString{String: *metaPtr, Valid: true}
				}
				if _, err := tx.ExecContext(
					ctx,
					"INSERT INTO `qbank_questions` (`qbank_id`, `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week`, "+
						"`question_num`, `parent_question_num`, `parent_question_nums`, `sub_num`, `topic`, `video_url`, `question_meta`, "+
						"`exercise_pdf`, `exercise_name`, `answer_pdf`, `answer_name`, `created_by`, `updated_by`, `updated_at`) "+
						"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
					qbankID, scope.BankType, scope.Year, scope.Season, scope.Subject, scope.Grade, scope.Tier, scope.Week,
					q.QuestionNum, parentNum, parentNums, q.SubNum, q.Topic, q.VideoURL, qMeta,
					q.ExercisePDF, q.ExerciseName, q.AnswerPDF, q.AnswerName, op, op,
				); err != nil {
					return NewHTTPError(500, "恢复历史题目明细失败，操作已回滚", err)
				}
			}
		}

		rec, recErr := attest.RecordRevisionTx(ctx, tx, qbankattest.RecordRevisionInput{
			QBankID:      qbankID,
			Action:       qbankattest.ActionAdminRollback,
			Scope:        scope,
			Operator:     op,
			OperatorName: strings.TrimSpace(adminName),
			ClientIP:     strings.TrimSpace(clientIP),
			Questions:    questions,
		})
		if recErr != nil {
			return NewHTTPError(500, "生成回滚存证回执失败，操作已回滚", recErr)
		}
		receipt = rec

		if scope.BankType == "homework" && len(questions) > 0 {
			topicMap := make(map[int]string, len(questions))
			for _, q := range questions {
				if q.QuestionNum > 0 {
					if t := qbank.CleanTopic(q.Topic); t != "" {
						topicMap[q.QuestionNum] = t
					}
				}
			}
			var vrRecorder qbank.VariationRevisionRecorder
			if vr, ok := attest.(qbank.VariationRevisionRecorder); ok {
				vrRecorder = vr
			}
			fallbackVarRecord := func(fCtx context.Context, fTx *sql.Tx, vScope qbank.WeekScope, vAction string, vQuestions []qbank.QuestionItem) error {
				_, fErr := attest.RecordRevisionTx(fCtx, fTx, qbankattest.RecordRevisionInput{
					QBankID:      vScope.QBankID,
					Action:       vAction,
					Scope:        qbankattest.Scope{BankType: vScope.BankType, Year: vScope.Year, Season: vScope.Season, Subject: vScope.Subject, Grade: vScope.Grade, Tier: vScope.Tier, Week: vScope.Week},
					Operator:     op,
					OperatorName: strings.TrimSpace(adminName),
					ClientIP:     strings.TrimSpace(clientIP),
					Questions:    qbankattest.SnapshotQuestionsFromWeekDetail(vQuestions),
				})
				return fErr
			}
			if err := qbank.CascadeHomeworkTopicsToVariationsTx(ctx, tx, qbank.WeekScope{
				QBankID:  qbankID,
				BankType: scope.BankType,
				Year:     scope.Year,
				Season:   scope.Season,
				Subject:  scope.Subject,
				Grade:    scope.Grade,
				Tier:     scope.Tier,
				Week:     scope.Week,
			}, topicMap, op, strings.TrimSpace(adminName), strings.TrimSpace(clientIP), vrRecorder, fallbackVarRecord); err != nil {
				return NewHTTPError(500, "级联更新举一反三变式题存证失败，操作已回滚", err)
			}
		}

		if err := tx.Commit(); err != nil {
			return NewHTTPError(500, "提交回滚事务失败", err)
		}
		return nil
	})
	if err != nil {
		return QBankRollbackResult{}, err
	}

	out := QBankRollbackResult{
		TargetReceiptCode: revSnap.ReceiptCode,
		TargetRevisionNo:  revSnap.RevisionNo,
		RestoredCount:     len(questions),
		Year:              scope.Year,
		Season:            scope.Season,
		BankType:          scope.BankType,
		Subject:           scope.Subject,
		Grade:             scope.Grade,
		Tier:              scope.Tier,
		Week:              scope.Week,
	}
	if receipt != nil {
		out.NewReceiptCode = receipt.ReceiptCode
		out.NewRevisionNo = receipt.RevisionNo
	}
	return out, nil
}
