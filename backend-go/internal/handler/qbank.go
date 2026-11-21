package handler

import (
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
	if sess.IsAssistantOnly() {
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

	currentTeacher := strings.TrimSpace(sess.Username())
	if currentTeacher == "" && sess.IsAdminLoggedIn() {
		currentTeacher = strings.TrimSpace(sess.AdminUsername())
	}
	if currentTeacher == "" {
		currentTeacher = strings.TrimSpace(config.AsPHPString(input["teacher_username"]))
	}

	if subject == "" || grade == "" || tier == "" || week == 0 {
		httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
			"success": false,
			"error":   "缺少必要字段: subject, grade, tier, week",
		})
		return
	}

	rawQuestionsSlice, ok := input["questions"].([]any)
	if !ok || len(rawQuestionsSlice) == 0 {
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
			httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
				"success": false,
				"error":   fmt.Sprintf("第 %s 题【知识点】为必填项，请填写完整！", qNumDisplay),
			})
			return
		}
		if exURL == "" {
			httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
				"success": false,
				"error":   fmt.Sprintf("第 %s 题【错题文件】（题目PDF）为必传项，请上传！", qNumDisplay),
			})
			return
		}

		rawMaps = append(rawMaps, qm)

		qNum := config.AsPHPInt(qm["id"])
		if qNum <= 0 {
			qNum = config.AsPHPInt(qm["question_num"])
		}
		if qNum <= 0 {
			qNum = config.AsPHPInt(qm["num"])
		}
		if qNum <= 0 {
			continue
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

		saveQuestions = append(saveQuestions, qbank.SaveQuestionInput{
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
		})
	}

	if deps.Repo == nil {
		httpx.SendJSON(w, http.StatusInternalServerError, map[string]any{
			"success": false,
			"error":   "题库保存到数据库失败，请稍后重试",
		})
		return
	}

	ctx := r.Context()
	removedPDFs, err := deps.Repo.SaveWeek(ctx, qbank.SaveWeekRequest{
		BankType:  bankType,
		Year:      year,
		Season:    season,
		Subject:   subject,
		Grade:     grade,
		Tier:      tier,
		Week:      week,
		Operator:  currentTeacher,
		Questions: saveQuestions,
		RawMaps:   rawMaps,
	})
	if err != nil {
		httpx.SendJSON(w, http.StatusInternalServerError, map[string]any{
			"success": false,
			"error":   "题库保存到数据库失败，请稍后重试",
		})
		return
	}

	if len(removedPDFs) > 0 {
		qbank.CleanupUnreferencedPDFs(ctx, deps.Repo, deps.FeedbackRoot, removedPDFs)
	}

	auditlog.RecordFromRequest(ctx, deps.Audit, r, "action", "qbank", "save_questions", currentTeacher, map[string]any{
		"bankType":       bankType,
		"year":           year,
		"season":         season,
		"subject":        subject,
		"grade":          grade,
		"tier":           tier,
		"week":           week,
		"question_count": len(rawMaps),
	})

	httpx.SendJSON(w, http.StatusOK, map[string]any{
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
	delTeacher := strings.TrimSpace(sess.Username())
	if delTeacher == "" && sess.IsAdminLoggedIn() {
		delTeacher = strings.TrimSpace(sess.AdminUsername())
	}
	if delTeacher == "" {
		delTeacher = strings.TrimSpace(q.Get("teacher_username"))
	}

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
	deletedPDFs, err := deps.Repo.DeleteWeek(ctx, qbank.WeekKey{
		Year:     yearPtr,
		Season:   season,
		Subject:  subject,
		Grade:    grade,
		Tier:     tier,
		Week:     week,
		BankType: bankType,
	})
	if err != nil {
		httpx.SendJSON(w, http.StatusInternalServerError, map[string]any{
			"success": false,
			"error":   "删除失败，请稍后重试",
		})
		return
	}
	if len(deletedPDFs) > 0 {
		qbank.CleanupUnreferencedPDFs(ctx, deps.Repo, deps.FeedbackRoot, deletedPDFs)
	}

	auditlog.RecordFromRequest(ctx, deps.Audit, r, "warn", "qbank", "delete_questions", delTeacher, map[string]any{
		"bankType": bankType,
		"year":     yearPtr,
		"season":   season,
		"subject":  subject,
		"grade":    grade,
		"tier":     tier,
		"week":     week,
	})

	httpx.SendJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"message": "删除成功",
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
