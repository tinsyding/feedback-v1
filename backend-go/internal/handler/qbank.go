package handler

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"feedback-api/internal/auditlog"
	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
	"feedback-api/internal/normalize"
	"feedback-api/internal/qbank"
	"feedback-api/internal/qbankattest"
	"feedback-api/internal/session"
	"feedback-api/internal/tz"
)

const maxQBankJSONBodyBytes = 10 << 20 // 10MB matching Nginx client_max_body_size 10m

// QBankDeps bundles dependencies for /api/qbank.php.
type QBankDeps struct {
	Repo         qbank.Repository
	Sessions     session.Store
	ConfigLoader *config.Loader
	Audit        auditlog.Logger
	Attest       qbankattest.Store
	DB           *sql.DB
	FeedbackRoot string
	NowFunc      func() time.Time
}

func (d QBankDeps) nowMillis() int64 {
	if d.NowFunc != nil {
		return d.NowFunc().UnixMilli()
	}
	return tz.Now().UnixMilli()
}

func (d QBankDeps) semesterDefaults() (int, string) {
	year := 2026
	seasonCode := "autumn"
	if d.ConfigLoader != nil {
		cfg := d.ConfigLoader.Load()
		if v := cfg.Raw["semesterYear"]; v != nil {
			if y := config.AsPHPInt(v); y > 0 {
				year = y
			}
		}
		if s := strings.TrimSpace(cfg.RawString("defaultSeason")); s != "" {
			seasonCode = s
		}
	}
	return year, normalize.Season(seasonCode, "春")
}

// QBank implements GET|POST|DELETE /api/qbank.php matching feedback-v1/api/qbank.php.
func QBank(deps QBankDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			handleQBankGet(w, r, deps)
		case http.MethodPost:
			handleQBankPost(w, r, deps)
		case http.MethodDelete:
			handleQBankDelete(w, r, deps)
		default:
			httpx.SendJSON(w, http.StatusMethodNotAllowed, map[string]any{
				"success": false,
				"error":   "不支持的请求方法",
			})
		}
	}
}

func handleQBankGet(w http.ResponseWriter, r *http.Request, deps QBankDeps) {
	if _, ok := session.RequireAuth(w, r, deps.Sessions); !ok {
		return
	}
	q := r.URL.Query()
	action := q.Get("action")
	if action == "" {
		action = "list"
	}

	switch action {
	case "list":
		var filter qbank.ListFilter
		if rawYear := strings.TrimSpace(q.Get("year")); rawYear != "" && rawYear != "all" && rawYear != "0" {
			y := config.AsPHPInt(rawYear)
			filter.Year = &y
		}
		if rawSeason := strings.TrimSpace(q.Get("season")); rawSeason != "" && rawSeason != "all" && rawSeason != "0" {
			filter.Season = normalize.Season(rawSeason, "秋")
		}
		if rawSubject := strings.TrimSpace(q.Get("subject")); rawSubject != "" && rawSubject != "all" {
			filter.Subject = rawSubject
		}
		if rawGrade := strings.TrimSpace(q.Get("grade")); rawGrade != "" && rawGrade != "all" {
			filter.Grade = rawGrade
		}
		if rawBT := strings.TrimSpace(q.Get("bankType")); rawBT != "" && rawBT != "all" {
			filter.BankType = qbank.NormalizeBankType(rawBT)
		}
		if rawSearch := strings.TrimSpace(q.Get("search")); rawSearch != "" {
			filter.Search = rawSearch
		}

		if deps.Repo == nil {
			httpx.SendJSON(w, http.StatusInternalServerError, map[string]any{
				"success": false,
				"error":   "题库数据库查询失败，请稍后重试",
			})
			return
		}
		items, err := deps.Repo.ListWeeks(r.Context(), filter)
		if err != nil {
			httpx.SendJSON(w, http.StatusInternalServerError, map[string]any{
				"success": false,
				"error":   "题库数据库查询失败，请稍后重试",
			})
			return
		}
		if items == nil {
			items = []qbank.WeekListItem{}
		}
		httpx.SendJSON(w, http.StatusOK, map[string]any{
			"success": true,
			"data":    items,
		})

	case "get":
		defaultYear, defaultSeasonZh := deps.semesterDefaults()
		subject := strings.TrimSpace(q.Get("subject"))
		grade := strings.TrimSpace(q.Get("grade"))
		tier := strings.TrimSpace(q.Get("tier"))
		week := config.AsPHPInt(q.Get("week"))
		year := defaultYear
		if rawYear := strings.TrimSpace(q.Get("year")); rawYear != "" && rawYear != "0" {
			year = config.AsPHPInt(rawYear)
		}
		season := normalize.Season(q.Get("season"), defaultSeasonZh)
		bankType := qbank.NormalizeBankType(q.Get("bankType"))
		strictRaw := strings.TrimSpace(q.Get("strict"))
		strict := strictRaw == "1" || strings.EqualFold(strictRaw, "true")

		if subject == "" || grade == "" || tier == "" || week == 0 {
			httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
				"success": false,
				"error":   "缺少必要参数: subject, grade, tier, week",
			})
			return
		}
		if deps.Repo == nil {
			httpx.SendJSON(w, http.StatusInternalServerError, map[string]any{
				"success": false,
				"error":   "题库数据库查询失败，请稍后重试",
			})
			return
		}

		detail, err := deps.Repo.GetWeek(r.Context(), qbank.WeekKey{
			Year:     &year,
			Season:   season,
			Subject:  subject,
			Grade:    grade,
			Tier:     tier,
			Week:     week,
			BankType: bankType,
			Strict:   strict,
		})
		if err != nil {
			httpx.SendJSON(w, http.StatusInternalServerError, map[string]any{
				"success": false,
				"error":   "题库数据库查询失败，请稍后重试",
			})
			return
		}
		httpx.SendJSON(w, http.StatusOK, map[string]any{
			"success": true,
			"data":    detail,
		})

	case "revisions":
		if deps.Attest == nil {
			httpx.SendJSON(w, http.StatusInternalServerError, map[string]any{
				"success": false,
				"error":   "题库存证服务未配置",
			})
			return
		}
		var filter qbankattest.RevisionFilter
		if rawBT := strings.TrimSpace(q.Get("bankType")); rawBT != "" && rawBT != "all" {
			filter.BankType = qbank.NormalizeBankType(rawBT)
		} else if rawBT := strings.TrimSpace(q.Get("bank_type")); rawBT != "" && rawBT != "all" {
			filter.BankType = qbank.NormalizeBankType(rawBT)
		}
		if rawYear := strings.TrimSpace(q.Get("year")); rawYear != "" && rawYear != "all" && rawYear != "0" {
			if y := config.AsPHPInt(rawYear); y > 0 {
				filter.Year = &y
			}
		}
		if rawSeason := strings.TrimSpace(q.Get("season")); rawSeason != "" && rawSeason != "all" && rawSeason != "0" {
			filter.Season = normalize.Season(rawSeason, rawSeason)
		}
		if subj := strings.TrimSpace(q.Get("subject")); subj != "" && subj != "all" {
			filter.Subject = subj
		}
		if grade := strings.TrimSpace(q.Get("grade")); grade != "" && grade != "all" {
			filter.Grade = grade
		}
		if tier := strings.TrimSpace(q.Get("tier")); tier != "" && tier != "all" {
			filter.Tier = tier
		}
		if rawWeek := strings.TrimSpace(q.Get("week")); rawWeek != "" && rawWeek != "0" {
			if wVal := config.AsPHPInt(rawWeek); wVal > 0 {
				filter.Week = &wVal
			}
		}
		filter.Operator = strings.TrimSpace(q.Get("operator"))
		filter.Limit = config.AsPHPInt(q.Get("limit"))

		items, err := deps.Attest.ListRevisions(r.Context(), filter)
		if err != nil {
			httpx.SendJSON(w, http.StatusInternalServerError, map[string]any{
				"success": false,
				"error":   "题库存证版本查询失败，请稍后重试",
			})
			return
		}
		if items == nil {
			items = []qbankattest.RevisionItem{}
		}
		httpx.SendJSON(w, http.StatusOK, map[string]any{
			"success": true,
			"data":    items,
		})

	default:
		httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
			"success": false,
			"error":   "未知操作: " + action,
		})
	}
}

func handleQBankPost(w http.ResponseWriter, r *http.Request, deps QBankDeps) {
	sess, ok := session.RequireAuth(w, r, deps.Sessions)
	if !ok {
		return
	}
	if strings.TrimSpace(r.URL.Query().Get("action")) == "log_attempt" {
		handleQBankLogAttempt(w, r, deps, sess)
		return
	}
	if sess.IsAssistantOnly() {
		op, opName := resolveQBankOperator(r.Context(), deps, sess, "")
		recordQBankAttemptBestEffort(r.Context(), deps, r, qbankattest.EventSaveRejected, qbankattest.Scope{}, op, opName, "助教账号禁止修改或保存题目", map[string]any{"role": "assistant"})
		httpx.SendJSON(w, http.StatusForbidden, map[string]any{
			"success": false,
			"error":   "助教账号仅具备查看题库权限，禁止修改或保存题目",
		})
		return
	}

	input, err := decodeQBankJSONBody(w, r)
	if err != nil {
		if isMaxBytesError(err) {
			httpx.SendJSON(w, http.StatusRequestEntityTooLarge, map[string]any{
				"success": false,
				"error":   "请求体大小不能超过 10MB",
			})
			return
		}
		httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
			"success": false,
			"error":   "无效的 JSON 数据",
		})
		return
	}
	if len(input) == 0 {
		httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
			"success": false,
			"error":   "无效的 JSON 数据",
		})
		return
	}

	defaultYear, defaultSeasonZh := deps.semesterDefaults()
	subject := strings.TrimSpace(config.AsPHPString(input["subject"]))
	grade := strings.TrimSpace(config.AsPHPString(input["grade"]))
	tier := strings.TrimSpace(config.AsPHPString(input["tier"]))
	week := config.AsPHPInt(input["week"])
	year := defaultYear
	if y := config.AsPHPInt(input["year"]); y > 0 {
		year = y
	}
	season := normalize.Season(config.AsPHPString(input["season"]), defaultSeasonZh)
	bankType := qbank.NormalizeBankType(config.AsPHPString(input["bankType"]))
	saveMode := strings.TrimSpace(config.AsPHPString(input["saveMode"]))
	if saveMode == "" {
		saveMode = strings.TrimSpace(config.AsPHPString(input["save_mode"]))
	}

	currentTeacher, operatorName := resolveQBankOperator(r.Context(), deps, sess, config.AsPHPString(input["teacher_username"]))
	clientIP := httpx.GetClientIP(r)
	scope := qbankattest.Scope{
		BankType: bankType,
		Year:     year,
		Season:   season,
		Subject:  subject,
		Grade:    grade,
		Tier:     tier,
		Week:     week,
	}

	if subject == "" || grade == "" || tier == "" || week == 0 {
		recordQBankAttemptBestEffort(r.Context(), deps, r, qbankattest.EventSaveRejected, scope, currentTeacher, operatorName, "缺少必要字段: subject, grade, tier, week", nil)
		httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
			"success": false,
			"error":   "缺少必要字段: subject, grade, tier, week",
		})
		return
	}

	rawQuestionsSlice, ok := input["questions"].([]any)
	if !ok || len(rawQuestionsSlice) == 0 {
		recordQBankAttemptBestEffort(r.Context(), deps, r, qbankattest.EventSaveRejected, scope, currentTeacher, operatorName, "题目列表不能为空", nil)
		httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
			"success": false,
			"error":   "题目列表不能为空，请至少添加一道题目",
		})
		return
	}

	rawMaps := make([]map[string]any, 0, len(rawQuestionsSlice))
	saveQuestions := make([]qbank.SaveQuestionInput, 0, len(rawQuestionsSlice))

	for idx, rawItem := range rawQuestionsSlice {
		qm, isMap := rawItem.(map[string]any)
		if !isMap || qm == nil {
			qm = map[string]any{}
		}

		// Clean trailing punctuation on topic
		if rawTopic, hasTopic := qm["topic"].(string); hasTopic {
			qm["topic"] = qbank.CleanTopic(rawTopic)
		}
		topic := qbank.CleanTopic(config.AsPHPString(qm["topic"]))

		qNumDisplay := config.AsPHPString(qm["id"])
		if qNumDisplay == "" {
			qNumDisplay = config.AsPHPString(qm["question_num"])
		}
		if qNumDisplay == "" {
			qNumDisplay = fmt.Sprintf("%d", idx+1)
		}

		exURL := ""
		exName := ""
		if exObj, ok := qm["exercisePdf"].(map[string]any); ok {
			exURL = config.AsPHPString(exObj["url"])
			exName = config.AsPHPString(exObj["name"])
		}
		if exURL == "" {
			exURL = config.AsPHPString(qm["exercise_pdf"])
		}

		if topic == "" && bankType != "preview" {
			errMsg := fmt.Sprintf("第 %s 题【知识点】为必填项，请填写完整！", qNumDisplay)
			recordQBankAttemptBestEffort(r.Context(), deps, r, qbankattest.EventSaveRejected, scope, currentTeacher, operatorName, errMsg, map[string]any{"questionNum": qNumDisplay})
			httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
				"success": false,
				"error":   errMsg,
			})
			return
		}
		if exURL == "" {
			errMsg := fmt.Sprintf("第 %s 题【错题文件】（题目PDF）为必传项，请上传！", qNumDisplay)
			recordQBankAttemptBestEffort(r.Context(), deps, r, qbankattest.EventSaveRejected, scope, currentTeacher, operatorName, errMsg, map[string]any{"questionNum": qNumDisplay})
			httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
				"success": false,
				"error":   errMsg,
			})
			return
		}

		qNum := config.AsPHPInt(qm["id"])
		if qNum <= 0 {
			qNum = config.AsPHPInt(qm["question_num"])
		}
		if qNum <= 0 {
			qNum = config.AsPHPInt(qm["num"])
		}
		if qNum <= 0 {
			errMsg := fmt.Sprintf("第 %d 条题目缺少有效的正整数题号 (id)", idx+1)
			recordQBankAttemptBestEffort(r.Context(), deps, r, qbankattest.EventSaveRejected, scope, currentTeacher, operatorName, errMsg, map[string]any{"questionIndex": idx + 1})
			httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
				"success": false,
				"error":   errMsg,
			})
			return
		}
		if exName == "" {
			exName = config.AsPHPString(qm["exercise_name"])
		}

		rawParentList := qm["parentQuestionNums"]
		if rawParentList == nil {
			rawParentList = qm["parent_question_nums"]
		}
		rawParentPrimary := qm["parentQuestionNum"]
		if rawParentPrimary == nil {
			rawParentPrimary = qm["parent_question_num"]
		}
		primaryPtr, parentList := qbank.ParseParentNums(rawParentPrimary, rawParentList)

		subNum := config.AsPHPInt(qm["subNum"])
		if subNum <= 0 {
			subNum = config.AsPHPInt(qm["sub_num"])
		}
		if subNum <= 0 {
			subNum = 1
		}

		videoURL := strings.TrimSpace(config.AsPHPString(qm["videoUrl"]))
		if videoURL == "" {
			videoURL = strings.TrimSpace(config.AsPHPString(qm["video_url"]))
		}

		rawMeta := qm["questionMeta"]
		if rawMeta == nil {
			rawMeta = qm["question_meta"]
		}
		cleanMeta := qbank.SanitizeQuestionMeta(rawMeta)

		ansURL := ""
		ansName := ""
		if ansObj, ok := qm["answerPdf"].(map[string]any); ok {
			ansURL = config.AsPHPString(ansObj["url"])
			ansName = config.AsPHPString(ansObj["name"])
		}
		if ansURL == "" {
			ansURL = config.AsPHPString(qm["answer_pdf"])
		}
		if ansName == "" {
			ansName = config.AsPHPString(qm["answer_name"])
		}

		item := qbank.SaveQuestionInput{
			QuestionNum:       qNum,
			ParentQuestionNum: primaryPtr,
			ParentNumsStr:     qbank.JoinParentNums(parentList),
			SubNum:            subNum,
			Topic:             topic,
			VideoURL:          videoURL,
			MetaJSON:          qbank.MarshalMetaJSON(cleanMeta),
			ExerciseURL:       exURL,
			ExerciseName:      exName,
			AnswerURL:         ansURL,
			AnswerName:        ansName,
		}
		replaced := false
		for i, existing := range saveQuestions {
			if existing.QuestionNum == qNum {
				saveQuestions[i] = item
				rawMaps[i] = qm
				replaced = true
				break
			}
		}
		if !replaced {
			saveQuestions = append(saveQuestions, item)
			rawMaps = append(rawMaps, qm)
		}
	}

	if deps.Repo == nil {
		recordQBankAttemptBestEffort(r.Context(), deps, r, qbankattest.EventSaveError, scope, currentTeacher, operatorName, "题库数据库未配置", map[string]any{"question_count": len(rawMaps), "save_mode": saveMode})
		httpx.SendJSON(w, http.StatusInternalServerError, map[string]any{
			"success": false,
			"error":   "题库保存到数据库失败，请稍后重试",
		})
		return
	}

	ctx := r.Context()
	var issuedReceipt *qbankattest.Receipt
	removedPDFs, err := deps.Repo.SaveWeek(ctx, qbank.SaveWeekRequest{
		BankType:     bankType,
		Year:         year,
		Season:       season,
		Subject:      subject,
		Grade:        grade,
		Tier:         tier,
		Week:         week,
		Operator:     currentTeacher,
		OperatorName: operatorName,
		ClientIP:     clientIP,
		SaveMode:     saveMode,
		Questions:    saveQuestions,
		RawMaps:      rawMaps,
		OnRecordTx: func(txCtx context.Context, tx *sql.Tx, qbankID int64, action string) error {
			if deps.Attest == nil {
				return nil
			}
			rec, recErr := deps.Attest.RecordRevisionTx(txCtx, tx, qbankattest.RecordRevisionInput{
				QBankID:      qbankID,
				Action:       action,
				Scope:        scope,
				Operator:     currentTeacher,
				OperatorName: operatorName,
				ClientIP:     clientIP,
				Questions:    qbankattest.SnapshotQuestionsFromSaveInputs(saveQuestions),
			})
			if recErr != nil {
				return recErr
			}
			issuedReceipt = rec
			return nil
		},
		OnVariationRecordTx: func(txCtx context.Context, tx *sql.Tx, vScope qbank.WeekScope, action string, vQuestions []qbank.QuestionItem) error {
			if deps.Attest == nil {
				return nil
			}
			_, recErr := deps.Attest.RecordRevisionTx(txCtx, tx, qbankattest.RecordRevisionInput{
				QBankID: vScope.QBankID,
				Action:  action,
				Scope: qbankattest.Scope{
					BankType: vScope.BankType,
					Year:     vScope.Year,
					Season:   vScope.Season,
					Subject:  vScope.Subject,
					Grade:    vScope.Grade,
					Tier:     vScope.Tier,
					Week:     vScope.Week,
				},
				Operator:     currentTeacher,
				OperatorName: operatorName,
				ClientIP:     clientIP,
				Questions:    qbankattest.SnapshotQuestionsFromWeekDetail(vQuestions),
			})
			return recErr
		},
	})
	if err != nil {
		recordQBankAttemptBestEffort(ctx, deps, r, qbankattest.EventSaveError, scope, currentTeacher, operatorName, "题库保存到数据库失败", map[string]any{"error": err.Error(), "question_count": len(rawMaps), "save_mode": saveMode})
		httpx.SendJSON(w, http.StatusInternalServerError, map[string]any{
			"success": false,
			"error":   "题库保存到数据库失败，请稍后重试",
		})
		return
	}

	if len(removedPDFs) > 0 {
		qbank.CleanupUnreferencedPDFsWithAttest(ctx, deps.Repo, deps.Attest, deps.FeedbackRoot, removedPDFs)
	}

	auditPayload := map[string]any{
		"bankType":       bankType,
		"year":           year,
		"season":         season,
		"subject":        subject,
		"grade":          grade,
		"tier":           tier,
		"week":           week,
		"question_count": len(rawMaps),
	}
	if saveMode != "" {
		auditPayload["saveMode"] = saveMode
	}
	if issuedReceipt != nil {
		auditPayload["receipt_code"] = issuedReceipt.ReceiptCode
		auditPayload["revision_no"] = issuedReceipt.RevisionNo
	}
	auditlog.RecordFromRequest(ctx, deps.Audit, r, "action", "qbank", "save_questions", currentTeacher, auditPayload)

	resp := map[string]any{
		"success": true,
		"message": "保存成功",
		"data": map[string]any{
			"bankType":  bankType,
			"year":      year,
			"season":    season,
			"subject":   subject,
			"grade":     grade,
			"tier":      tier,
			"week":      week,
			"questions": rawMaps,
			"updatedAt": deps.nowMillis(),
		},
		"dbSaved": true,
	}
	if issuedReceipt != nil {
		resp["receipt"] = issuedReceipt
	}
	httpx.SendJSON(w, http.StatusOK, resp)
}

func handleQBankLogAttempt(w http.ResponseWriter, r *http.Request, deps QBankDeps, sess *session.Session) {
	input, err := decodeQBankJSONBody(w, r)
	if err != nil {
		if isMaxBytesError(err) {
			httpx.SendJSON(w, http.StatusRequestEntityTooLarge, map[string]any{
				"success": false,
				"error":   "请求体大小不能超过 10MB",
			})
			return
		}
		httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
			"success": false,
			"error":   "无效的 JSON 数据",
		})
		return
	}

	eventType := strings.TrimSpace(config.AsPHPString(input["event_type"]))
	switch eventType {
	case qbankattest.EventClientBlocked, qbankattest.EventSaveCancelled, qbankattest.EventSaveError:
	default:
		httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
			"success": false,
			"error":   "不支持的过程日志事件类型",
		})
		return
	}

	rawBT := strings.TrimSpace(config.AsPHPString(input["bankType"]))
	if rawBT == "" {
		rawBT = strings.TrimSpace(config.AsPHPString(input["bank_type"]))
	}
	bankType := ""
	if rawBT != "" {
		bankType = qbank.NormalizeBankType(rawBT)
	}
	rawSeason := strings.TrimSpace(config.AsPHPString(input["season"]))
	season := ""
	if rawSeason != "" {
		season = normalize.Season(rawSeason, rawSeason)
	}
	scope := qbankattest.Scope{
		BankType: bankType,
		Year:     config.AsPHPInt(input["year"]),
		Season:   season,
		Subject:  strings.TrimSpace(config.AsPHPString(input["subject"])),
		Grade:    strings.TrimSpace(config.AsPHPString(input["grade"])),
		Tier:     strings.TrimSpace(config.AsPHPString(input["tier"])),
		Week:     config.AsPHPInt(input["week"]),
	}
	op, opName := resolveQBankOperator(r.Context(), deps, sess, config.AsPHPString(input["teacher_username"]))
	reason := strings.TrimSpace(config.AsPHPString(input["reason"]))
	details, _ := input["details"].(map[string]any)

	if deps.Attest != nil {
		if err := deps.Attest.RecordAttempt(r.Context(), qbankattest.AttemptInput{
			EventType:    eventType,
			Scope:        scope,
			Operator:     op,
			OperatorName: opName,
			ClientIP:     httpx.GetClientIP(r),
			Reason:       reason,
			Details:      details,
		}); err != nil {
			httpx.SendJSON(w, http.StatusInternalServerError, map[string]any{
				"success": false,
				"error":   "记录过程取证日志失败",
			})
			return
		}
	}

	httpx.SendJSON(w, http.StatusOK, map[string]any{
		"success": true,
	})
}

func handleQBankDelete(w http.ResponseWriter, r *http.Request, deps QBankDeps) {
	sess, ok := session.RequireAuth(w, r, deps.Sessions)
	if !ok {
		return
	}
	if sess.IsAssistantOnly() {
		httpx.SendJSON(w, http.StatusForbidden, map[string]any{
			"success": false,
			"error":   "助教账号仅具备查看题库权限，禁止删除题目",
		})
		return
	}

	q := r.URL.Query()
	subject := strings.TrimSpace(q.Get("subject"))
	grade := strings.TrimSpace(q.Get("grade"))
	tier := strings.TrimSpace(q.Get("tier"))
	week := config.AsPHPInt(q.Get("week"))
	var yearPtr *int
	if rawYear := strings.TrimSpace(q.Get("year")); rawYear != "" && rawYear != "0" {
		y := config.AsPHPInt(rawYear)
		yearPtr = &y
	}
	season := ""
	if rawSeason := strings.TrimSpace(q.Get("season")); rawSeason != "" && rawSeason != "0" {
		season = normalize.Season(rawSeason, "秋")
	}
	bankType := qbank.NormalizeBankType(q.Get("bankType"))
	delTeacher, delTeacherName := resolveQBankOperator(r.Context(), deps, sess, q.Get("teacher_username"))
	clientIP := httpx.GetClientIP(r)

	if subject == "" || grade == "" || tier == "" || week == 0 {
		httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
			"success": false,
			"error":   "缺少必要参数: subject, grade, tier, week",
		})
		return
	}

	ctx := r.Context()
	if deps.Repo == nil {
		httpx.SendJSON(w, http.StatusInternalServerError, map[string]any{
			"success": false,
			"error":   "数据库不可用，删除失败",
		})
		return
	}
	var deleteReceipt *qbankattest.Receipt
	deletedPDFs, err := deps.Repo.DeleteWeek(ctx, qbank.WeekKey{
		Year:         yearPtr,
		Season:       season,
		Subject:      subject,
		Grade:        grade,
		Tier:         tier,
		Week:         week,
		BankType:     bankType,
		Operator:     delTeacher,
		OperatorName: delTeacherName,
		ClientIP:     clientIP,
		OnDeleteTx: func(txCtx context.Context, tx *sql.Tx, scope qbank.WeekScope) error {
			if deps.Attest == nil {
				return nil
			}
			rec, recErr := deps.Attest.RecordRevisionTx(txCtx, tx, qbankattest.RecordRevisionInput{
				QBankID: scope.QBankID,
				Action:  qbankattest.ActionDelete,
				Scope: qbankattest.Scope{
					BankType: scope.BankType,
					Year:     scope.Year,
					Season:   scope.Season,
					Subject:  scope.Subject,
					Grade:    scope.Grade,
					Tier:     scope.Tier,
					Week:     scope.Week,
				},
				Operator:     delTeacher,
				OperatorName: delTeacherName,
				ClientIP:     clientIP,
				Questions:    nil,
			})
			if recErr != nil {
				return recErr
			}
			deleteReceipt = rec
			return nil
		},
	})
	if err != nil {
		httpx.SendJSON(w, http.StatusInternalServerError, map[string]any{
			"success": false,
			"error":   "删除失败，请稍后重试",
		})
		return
	}
	if len(deletedPDFs) > 0 {
		qbank.CleanupUnreferencedPDFsWithAttest(ctx, deps.Repo, deps.Attest, deps.FeedbackRoot, deletedPDFs)
	}

	auditPayload := map[string]any{
		"bankType": bankType,
		"year":     yearPtr,
		"season":   season,
		"subject":  subject,
		"grade":    grade,
		"tier":     tier,
		"week":     week,
	}
	if deleteReceipt != nil {
		auditPayload["receipt_code"] = deleteReceipt.ReceiptCode
	}
	auditlog.RecordFromRequest(ctx, deps.Audit, r, "warn", "qbank", "delete_questions", delTeacher, auditPayload)

	resp := map[string]any{
		"success": true,
		"message": "删除成功",
	}
	if deleteReceipt != nil {
		resp["receipt_code"] = deleteReceipt.ReceiptCode
		resp["receipt"] = deleteReceipt
	}
	httpx.SendJSON(w, http.StatusOK, resp)
}

func resolveQBankOperator(ctx context.Context, deps QBankDeps, sess *session.Session, fallbackTeacher string) (string, string) {
	op := strings.TrimSpace(sess.Username())
	opName := ""
	fromAdmin := false
	if op != "" {
		opName = strings.TrimSpace(sess.StringVal("real_name"))
	} else if fb := strings.TrimSpace(fallbackTeacher); fb != "" {
		op = fb
	} else if sess.IsAdminLoggedIn() {
		op = strings.TrimSpace(sess.AdminUsername())
		opName = strings.TrimSpace(sess.StringVal("admin_realname"))
		fromAdmin = true
	}
	if opName == "" && op != "" && deps.DB != nil {
		var realName sql.NullString
		if err := deps.DB.QueryRowContext(ctx, "SELECT `real_name` FROM `users` WHERE `username` = ? LIMIT 1", op).Scan(&realName); err == nil && realName.String != "" {
			opName = realName.String
		} else if fromAdmin || sess.IsAdminLoggedIn() {
			if err := deps.DB.QueryRowContext(ctx, "SELECT `real_name` FROM `admin_users` WHERE `username` = ? LIMIT 1", op).Scan(&realName); err == nil {
				opName = realName.String
			}
		}
	}
	return op, opName
}

func recordQBankAttemptBestEffort(
	ctx context.Context,
	deps QBankDeps,
	r *http.Request,
	eventType string,
	scope qbankattest.Scope,
	operator string,
	operatorName string,
	reason string,
	details map[string]any,
) {
	if deps.Attest == nil {
		return
	}
	_ = deps.Attest.RecordAttempt(ctx, qbankattest.AttemptInput{
		EventType:    eventType,
		Scope:        scope,
		Operator:     operator,
		OperatorName: operatorName,
		ClientIP:     httpx.GetClientIP(r),
		Reason:       reason,
		Details:      details,
	})
}

func decodeQBankJSONBody(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
	if r == nil || r.Body == nil {
		return nil, io.EOF
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxQBankJSONBodyBytes)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil, io.EOF
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		return nil, err
	}
	if m == nil {
		return nil, io.EOF
	}
	return m, nil
}
