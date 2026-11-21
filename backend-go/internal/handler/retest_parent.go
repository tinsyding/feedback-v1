package handler

import (
	"crypto/subtle"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"feedback-api/internal/admin"
	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
	"feedback-api/internal/retest"
	"feedback-api/internal/retestkeys"
	"feedback-api/internal/session"
)

var (
	reLegacyIDPrefix = regexp.MustCompile(`^(\d+)_`)
	nameSpaceCleaner = strings.NewReplacer("\u3000", "", " ", "", "\t", "", "\r", "", "\n", "")
)

func handleRetestCaptcha(w http.ResponseWriter, r *http.Request, deps RetestDeps) {
	sess, isNew := loadAuthSession(r, deps.Sessions)
	code, svg := retest.GenerateSVGCaptcha()
	lowerCode := strings.ToLower(code)
	if deps.Sessions != nil {
		if _, err := session.Update(r.Context(), deps.Sessions, sess.ID, func(data map[string]any) (bool, error) {
			data["retest_captcha"] = lowerCode
			return true, nil
		}); err == nil && isNew {
			session.SetCookie(w, r, sess.ID)
		}
	} else {
		sess.Data["retest_captcha"] = lowerCode
		if isNew {
			session.SetCookie(w, r, sess.ID)
		}
	}

	w.Header().Set("Content-Type", "image/svg+xml; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(svg))
}

func handleRetestDecrypt(w http.ResponseWriter, r *http.Request, deps RetestDeps, secretKey string) {
	var rawToken, inputName, inputCaptcha string
	q := r.URL.Query()
	if r.Method == http.MethodPost {
		postInput, _ := decodeRetestJSONBody(w, r, 1<<20)
		rawToken = strings.TrimSpace(config.AsPHPString(postInput["token"]))
		if rawToken == "" {
			rawToken = strings.TrimSpace(q.Get("token"))
		}
		inputName = strings.TrimSpace(config.AsPHPString(postInput["studentName"]))
		if inputName == "" {
			inputName = strings.TrimSpace(q.Get("name"))
		}
		inputCaptcha = strings.TrimSpace(config.AsPHPString(postInput["captcha"]))
		if inputCaptcha == "" {
			inputCaptcha = strings.TrimSpace(q.Get("captcha"))
		}
	} else {
		rawToken = strings.TrimSpace(q.Get("token"))
		inputName = strings.TrimSpace(q.Get("name"))
		inputCaptcha = strings.TrimSpace(q.Get("captcha"))
	}

	if rawToken == "" {
		writeRawJSON(w, http.StatusBadRequest, map[string]any{"success": false, "error": "缺少访问凭证（Token）"})
		return
	}
	if deps.Repo == nil {
		writeRawJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "error": "数据库查询服务异常，请稍后重试"})
		return
	}

	rec, err := deps.Repo.FindTokenRecord(r.Context(), rawToken)
	if err != nil {
		writeRetestRepoError(w, err, "数据库查询服务异常，请稍后重试")
		return
	}
	if rec == nil {
		writeRawJSON(w, http.StatusBadRequest, map[string]any{"success": false, "error": "链接无效或已过期"})
		return
	}

	dataObj := map[string]any{
		"s":      rec.Subject,
		"g":      rec.Grade,
		"t":      rec.Tier,
		"w":      rec.WeekNum,
		"pw":     rec.PreviewWeekNum,
		"pq":     rec.PreviewErrors,
		"n":      rec.StudentName,
		"k":      rec.StudentKey,
		"id":     rec.StudentID,
		"year":   rec.Year,
		"season": rec.Season,
		"u":      rec.UpdatedUnix,
	}

	// Revocation blacklist check (fail fast before verification gate)
	if revoked, _ := deps.Repo.IsTokenRevoked(r.Context(), rawToken); revoked {
		logRetestAccess(r, deps, rawToken, rec.StudentName, "access_revoked", "链接已被作废")
		writeRawJSON(w, http.StatusForbidden, map[string]any{
			"success": false,
			"error":   "该错题本链接已被老师作废，请联系老师重新获取",
		})
		return
	}

	subject := rec.Subject
	grade := rec.Grade
	tier := rec.Tier
	tokenWeek := rec.WeekNum
	currWeek := tokenWeek
	hasExplicitWeek := false
	if q.Has("w") {
		if wv, err := strconv.Atoi(q.Get("w")); err == nil && wv > 0 {
			currWeek = wv
			hasExplicitWeek = true
		} else {
			currWeek = wv
		}
	}
	studentName := strings.TrimSpace(rec.StudentName)
	studentKey := strings.TrimSpace(rec.StudentKey)
	if studentKey == "" {
		studentKey = studentName
	}
	studentID := strings.TrimSpace(rec.StudentID)
	if studentID == "" {
		if m := reLegacyIDPrefix.FindStringSubmatch(studentKey); len(m) == 2 {
			studentID = m[1]
		}
	}
	keyCandidates := retestkeys.StudentKeyCandidates(studentID, studentName, grade, subject)
	if len(keyCandidates) == 0 {
		keyCandidates = []string{studentKey}
	}

	// Session verification gate
	sess, isNewSess := loadAuthSession(r, deps.Sessions)
	sessKey := verifiedTokenSessionKey(rawToken)
	verifiedIdentity := sess.StringVal(sessKey)
	isSessionVerified := false
	if verifiedIdentity != "" {
		if verifiedIdentity == studentName {
			isSessionVerified = true
		} else {
			for _, c := range keyCandidates {
				if verifiedIdentity == c {
					isSessionVerified = true
					break
				}
			}
		}
	}

	// Admin bypass via 24h HMAC signature or logged-in admin session
	if !isSessionVerified {
		adminSig := strings.TrimSpace(q.Get("admin_sig"))
		adminTs, _ := strconv.ParseInt(q.Get("admin_ts"), 10, 64)
		isAdminAuthorized := false
		if adminSig != "" && adminTs > 0 {
			diff := deps.now().Unix() - adminTs
			if diff < 0 {
				diff = -diff
			}
			if diff <= 86400 {
				expected := admin.SignRetestAdminSig(rawToken, adminTs, secretKey)
				if subtle.ConstantTimeCompare([]byte(expected), []byte(adminSig)) == 1 {
					isAdminAuthorized = true
				}
			}
		}
		if !isAdminAuthorized && sess.IsAdminLoggedIn() {
			isAdminAuthorized = true
		}
		if isAdminAuthorized {
			isSessionVerified = true
			if deps.Sessions != nil {
				if _, err := session.Update(r.Context(), deps.Sessions, sess.ID, func(data map[string]any) (bool, error) {
					data[sessKey] = keyCandidates[0]
					return true, nil
				}); err == nil && isNewSess {
					session.SetCookie(w, r, sess.ID)
				}
			} else {
				sess.Data[sessKey] = keyCandidates[0]
				if isNewSess {
					session.SetCookie(w, r, sess.ID)
				}
			}
			logRetestAccess(r, deps, rawToken, studentName+" (管理员直通)", "admin_bypass", "管理员免密查看")
		}
	}

	if !isSessionVerified {
		if inputName == "" && inputCaptcha == "" {
			writeRawJSON(w, http.StatusOK, map[string]any{
				"success":    false,
				"needVerify": true,
				"error":      "请先输入学生姓名和图形验证码以验证身份",
			})
			return
		}

		clientIP := httpx.GetClientIP(r)
		rlKey := clientIP + "|" + rawToken
		rlStatus := getRateStatus(r.Context(), deps.RateLimit, "retest_decrypt", rlKey, 600)
		if rlStatus.Locked {
			writeRawJSON(w, http.StatusTooManyRequests, map[string]any{
				"success":    false,
				"needVerify": true,
				"error":      fmt.Sprintf("验证失败次数过多，请 %d 秒后再试", rlStatus.RemainingSeconds),
			})
			return
		}

		// One-time SVG captcha check (atomic read-and-delete; fail closed on DB error)
		var savedCaptcha string
		if deps.Sessions != nil {
			var capErr error
			_, capErr = session.Update(r.Context(), deps.Sessions, sess.ID, func(data map[string]any) (bool, error) {
				savedCaptcha = strings.ToLower(config.AsPHPString(data["retest_captcha"]))
				if _, exists := data["retest_captcha"]; exists {
					delete(data, "retest_captcha")
					return true, nil
				}
				return false, nil
			})
			if capErr != nil {
				savedCaptcha = ""
			} else if isNewSess && savedCaptcha != "" {
				session.SetCookie(w, r, sess.ID)
			}
		} else {
			savedCaptcha = strings.ToLower(sess.StringVal("retest_captcha"))
			delete(sess.Data, "retest_captcha")
		}

		if savedCaptcha == "" || strings.ToLower(inputCaptcha) != savedCaptcha {
			recordRateFailure(r.Context(), deps.RateLimit, "retest_decrypt", rlKey, 15, 600, 600)
			logRetestAccess(r, deps, rawToken, inputName, "verify_fail", "图形验证码错误")
			writeRawJSON(w, http.StatusOK, map[string]any{
				"success":      false,
				"needVerify":   true,
				"error":        "图形验证码错误或已失效，请点击图片刷新重试",
				"captchaError": true,
			})
			return
		}

		cleanInput := strings.ToLower(nameSpaceCleaner.Replace(strings.TrimSpace(inputName)))
		cleanTarget := strings.ToLower(nameSpaceCleaner.Replace(studentName))
		cleanKey := strings.ToLower(nameSpaceCleaner.Replace(studentKey))
		nameMatched := cleanInput == cleanTarget || cleanInput == cleanKey || (studentID != "" && cleanInput == strings.ToLower(studentID)+cleanTarget)
		if !nameMatched {
			recordRateFailure(r.Context(), deps.RateLimit, "retest_decrypt", rlKey, 15, 600, 600)
			logRetestAccess(r, deps, rawToken, inputName, "verify_fail", "姓名不匹配: "+inputName)
			writeRawJSON(w, http.StatusOK, map[string]any{
				"success":    false,
				"needVerify": true,
				"error":      "学生姓名不匹配，请输入该作业对应的学生姓名",
				"nameError":  true,
			})
			return
		}

		clearRateFailure(r.Context(), deps.RateLimit, "retest_decrypt", rlKey)
		if deps.Sessions != nil {
			if _, err := session.Update(r.Context(), deps.Sessions, sess.ID, func(data map[string]any) (bool, error) {
				data[sessKey] = keyCandidates[0]
				return true, nil
			}); err != nil {
				writeRawJSON(w, http.StatusInternalServerError, map[string]any{
					"success": false,
					"error":   "验证状态保存失败，请稍后重试",
				})
				return
			} else if isNewSess {
				session.SetCookie(w, r, sess.ID)
			}
		} else {
			sess.Data[sessKey] = keyCandidates[0]
			if isNewSess {
				session.SetCookie(w, r, sess.ID)
			}
		}
		logRetestAccess(r, deps, rawToken, studentName, "verify_success", fmt.Sprintf("第 %d 周", currWeek))
	} else {
		if q.Has("w") {
			logRetestAccess(r, deps, rawToken, studentName, "switch_week", fmt.Sprintf("切换至第 %d 周", currWeek))
		} else {
			logRetestAccess(r, deps, rawToken, studentName, "view_page", fmt.Sprintf("第 %d 周", currWeek))
		}
	}

	// Load full student history & class averages
	bundle, _ := deps.Repo.LoadStudentHistoryAndAverages(r.Context(), subject, grade, tier, studentID, studentName, keyCandidates)

	type scoreEntry struct {
		homeworkScore    *float64
		previewScore     *float64
		totalScore       *float64
		comment          string
		previewComment   string
		submissionStatus string
	}
	type previewEntry struct {
		errors                  []int
		previewWeek             int
		previewScore            *float64
		previewComment          string
		previewSubmissionStatus string
		sourceWeek              int
		tier                    string
	}

	studentHistory := map[int][]int{}
	dbStudentScores := map[int]scoreEntry{}
	dbPreviewData := map[int]previewEntry{}
	dbPreviewOrder := []int{}
	dbWeekTiers := map[int]string{}
	dbWeekBatchIDs := map[int]int{}

	for _, row := range bundle.Records {
		wn := row.WeekNum
		errs := retest.ParseJSONErrorInts(row.ErrorQuestionsRaw)
		comment := strings.TrimSpace(row.TeacherComment)
		isPreviewOnly := (row.PreviewWeekNum != nil || row.PreviewErrorsRaw != nil) &&
			len(errs) == 0 && row.HomeworkScore == nil && comment == "" && row.ErrorCount == 0
		hasHomework := !isPreviewOnly && (len(errs) > 0 || row.HomeworkScore != nil || comment != "" || row.SubmissionStatus != "" || row.ErrorCount > 0 || row.ErrorQuestionsRaw != nil)
		if hasHomework {
			studentHistory[wn] = errs
			dbStudentScores[wn] = scoreEntry{
				homeworkScore:    row.HomeworkScore,
				previewScore:     row.PreviewScore,
				totalScore:       row.TotalScore,
				comment:          row.TeacherComment,
				previewComment:   row.PreviewComment,
				submissionStatus: row.SubmissionStatus,
			}
			dbWeekTiers[wn] = row.BatchTier
			dbWeekBatchIDs[wn] = row.BatchID
		}
		if row.PreviewWeekNum != nil || row.PreviewErrorsRaw != nil {
			pvWk := wn
			if row.PreviewWeekNum != nil && *row.PreviewWeekNum > 0 {
				pvWk = *row.PreviewWeekNum
			}
			if _, exists := dbPreviewData[wn]; !exists {
				dbPreviewOrder = append(dbPreviewOrder, wn)
			}
			dbPreviewData[wn] = previewEntry{
				errors:                  retest.ParseJSONErrorInts(row.PreviewErrorsRaw),
				previewWeek:             pvWk,
				previewScore:            row.PreviewScore,
				previewComment:          row.PreviewComment,
				previewSubmissionStatus: row.PreviewSubmissionStatus,
				sourceWeek:              wn,
				tier:                    row.BatchTier,
			}
		}
	}

	if currWeek <= 0 && len(studentHistory) > 0 {
		for wn := range studentHistory {
			if wn > currWeek {
				currWeek = wn
			}
		}
	}

	// Re-group preview errors by previewWeek topic deterministically
	previewByTopic := map[int]previewEntry{}
	for _, wn := range dbPreviewOrder {
		entry := dbPreviewData[wn]
		topic := entry.previewWeek
		if topic <= 0 {
			topic = entry.sourceWeek
		}
		if entry.tier == "" {
			entry.tier = dbWeekTiers[entry.sourceWeek]
		}
		previewByTopic[topic] = entry
	}

	useTokenWeek := tokenWeek <= 0 || currWeek == tokenWeek
	var tokenPreviewErrors []int
	tokenPreviewWeek := currWeek
	if useTokenWeek {
		tokenPreviewErrors = rec.PreviewErrors
		if rec.PreviewWeekNum > 0 {
			tokenPreviewWeek = rec.PreviewWeekNum
		}
	}

	sortedPreviewTopics := make([]int, 0, len(previewByTopic))
	for topic := range previewByTopic {
		sortedPreviewTopics = append(sortedPreviewTopics, topic)
	}
	sort.Ints(sortedPreviewTopics)
	for _, topic := range sortedPreviewTopics {
		entry := previewByTopic[topic]
		if len(entry.errors) > 0 {
			if _, ok := studentHistory[topic]; !ok {
				studentHistory[topic] = []int{}
			}
		}
	}
	if len(tokenPreviewErrors) > 0 {
		if _, ok := previewByTopic[tokenPreviewWeek]; !ok {
			previewByTopic[tokenPreviewWeek] = previewEntry{
				errors:      tokenPreviewErrors,
				previewWeek: tokenPreviewWeek,
				tier:        tier,
			}
			if _, ok := studentHistory[tokenPreviewWeek]; !ok {
				studentHistory[tokenPreviewWeek] = []int{}
			}
			sortedPreviewTopics = append(sortedPreviewTopics, tokenPreviewWeek)
			sort.Ints(sortedPreviewTopics)
		}
	}

	defaultPreviewTopic := 0
	for _, topic := range sortedPreviewTopics {
		entry := previewByTopic[topic]
		if entry.sourceWeek == currWeek && len(entry.errors) > 0 {
			defaultPreviewTopic = topic
		}
	}
	if defaultPreviewTopic <= 0 && len(previewByTopic[tokenPreviewWeek].errors) > 0 {
		defaultPreviewTopic = tokenPreviewWeek
	}

	if !hasExplicitWeek && useTokenWeek &&
		len(studentHistory[currWeek]) == 0 &&
		len(previewByTopic[currWeek].errors) == 0 &&
		defaultPreviewTopic > 0 && defaultPreviewTopic != currWeek {
		currWeek = defaultPreviewTopic
	}

	currErrors := studentHistory[currWeek]
	if currErrors == nil {
		currErrors = []int{}
	}

	// Collect all target weeks and preload qbank_questions in 1 query
	weekSet := map[int]struct{}{}
	for wn := range studentHistory {
		if wn > 0 {
			weekSet[wn] = struct{}{}
		}
	}
	for wn := range previewByTopic {
		if wn > 0 {
			weekSet[wn] = struct{}{}
		}
	}
	if currWeek > 0 {
		weekSet[currWeek] = struct{}{}
	}
	targetWeeks := make([]int, 0, len(weekSet))
	for wn := range weekSet {
		targetWeeks = append(targetWeeks, wn)
	}
	sort.Ints(targetWeeks)

	preloadedQbank, _ := deps.Repo.PreloadMultiWeekQbankRows(r.Context(), subject, grade, targetWeeks, rec.Year, rec.Season)

	buildWeekEntry := func(wNum int, errs []int) map[string]any {
		weekTier := dbWeekTiers[wNum]
		if weekTier == "" {
			weekTier = tier
		}
		pdfList := retest.BuildWeekPDFs(preloadedQbank, "homework", weekTier, wNum, errs)

		pvEntry, hasPv := previewByTopic[wNum]
		pvErrs := []int{}
		pvTier := weekTier
		var pvScore any
		pvComment := ""
		if hasPv {
			if pvEntry.errors != nil {
				pvErrs = pvEntry.errors
			}
			if pvEntry.tier != "" {
				pvTier = pvEntry.tier
			}
			if pvEntry.previewScore != nil {
				pvScore = *pvEntry.previewScore
			}
			pvComment = pvEntry.previewComment
		}
		pvPDFs := []map[string]any{}
		if len(pvErrs) > 0 {
			pvPDFs = retest.BuildWeekPDFs(preloadedQbank, "preview", pvTier, wNum, pvErrs)
		}

		entry := map[string]any{
			"week":           wNum,
			"errors":         errs,
			"pdfs":           pdfList,
			"previewErrors":  pvErrs,
			"previewPdfs":    pvPDFs,
			"previewWeek":    wNum,
			"previewScore":   pvScore,
			"previewComment": pvComment,
			"homeworkScore":  nil,
			"avgScore":       nil,
		}
		explicitSubStatus := ""
		var hwScorePtr *float64
		comment := ""
		if sc, ok := dbStudentScores[wNum]; ok {
			if sc.homeworkScore != nil {
				entry["homeworkScore"] = *sc.homeworkScore
				hwScorePtr = sc.homeworkScore
			}
			if sc.totalScore != nil {
				entry["totalScore"] = *sc.totalScore
			} else {
				entry["totalScore"] = nil
			}
			entry["comment"] = sc.comment
			comment = sc.comment
			explicitSubStatus = sc.submissionStatus
		}
		resolved := retest.ResolveSubmissionStatus(explicitSubStatus, errs, hwScorePtr, comment)
		entry["submissionStatus"] = resolved
		entry["isUnsubmitted"] = resolved == "unsubmitted" && len(pvErrs) == 0

		wBid := dbWeekBatchIDs[wNum]
		if wBid > 0 {
			if avg, ok := bundle.WeekAvgByBatchWeek[fmt.Sprintf("%d:%d", wBid, wNum)]; ok {
				entry["avgScore"] = avg
			} else if avg, ok := bundle.WeekAverages[strconv.Itoa(wNum)]; ok {
				entry["avgScore"] = avg
			}
		} else if avg, ok := bundle.WeekAverages[strconv.Itoa(wNum)]; ok {
			entry["avgScore"] = avg
		}
		return entry
	}

	weeksData := map[string]any{}
	sortedWeeks := make([]int, 0, len(studentHistory))
	for wn := range studentHistory {
		sortedWeeks = append(sortedWeeks, wn)
	}
	sort.Ints(sortedWeeks)
	for _, wn := range sortedWeeks {
		weeksData[strconv.Itoa(wn)] = buildWeekEntry(wn, studentHistory[wn])
	}
	if len(weeksData) == 0 && currWeek > 0 {
		weeksData[strconv.Itoa(currWeek)] = buildWeekEntry(currWeek, currErrors)
		sortedWeeks = []int{currWeek}
	}

	retestSpacing := 26
	retestQR := true
	if deps.ConfigLoader != nil {
		rt := deps.ConfigLoader.Load()
		if v, ok := rt.Raw["retestQuestionSpacing"]; ok {
			sp := config.AsPHPInt(v)
			if sp < 10 {
				sp = 10
			}
			if sp > 260 {
				sp = 260
			}
			retestSpacing = sp
		}
		if v, ok := rt.Raw["retestQrCodeEnabled"]; ok {
			retestQR = config.AsPHPBool(v)
		}
	}

	currEntry, _ := weeksData[strconv.Itoa(currWeek)].(map[string]any)
	topPDFs := []map[string]any{}
	topPvPDFs := []map[string]any{}
	topPvErrs := []int{}
	if currEntry != nil {
		if v, ok := currEntry["pdfs"].([]map[string]any); ok {
			topPDFs = v
		}
		if v, ok := currEntry["previewPdfs"].([]map[string]any); ok {
			topPvPDFs = v
		}
		if v, ok := currEntry["previewErrors"].([]int); ok {
			topPvErrs = v
		}
	}

	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")

	writeRawJSON(w, http.StatusOK, map[string]any{
		"success":               true,
		"data":                  dataObj,
		"currentWeek":           currWeek,
		"availableWeeks":        sortedWeeks,
		"weeksData":             weeksData,
		"retestQuestionSpacing": retestSpacing,
		"retestQrCodeEnabled":   retestQR,
		"pdfs":                  topPDFs,
		"previewPdfs":           topPvPDFs,
		"previewErrors":         topPvErrs,
	})
}
