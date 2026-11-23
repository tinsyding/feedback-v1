package handler

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"feedback-api/internal/auditlog"
	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
	"feedback-api/internal/senderctrl"
	"feedback-api/internal/senderlogs"
	"feedback-api/internal/session"
	"feedback-api/internal/syslogs"
	"feedback-api/internal/textutil"
	"feedback-api/internal/tz"
	"feedback-api/internal/vision"
)

const (
	minValidUnixMillis = 946684800000  // 2000-01-01T00:00:00Z
	maxValidUnixMillis = 2147483000000 // 2038-01-19T03:03:20Z (within MySQL TIMESTAMP limit)
)

var senderLogsCleanupRunning atomic.Bool

// LogsDeps bundles dependencies for /api/logs.php.
type LogsDeps struct {
	Repo         syslogs.Repository
	Sessions     session.Store
	ConfigLoader *config.Loader
	Audit        auditlog.Logger
	SenderCtrl   *senderctrl.Store
	SenderLogs   *senderlogs.Manager
	Limiter      *syslogs.IngestLimiter
	NowFunc      func() time.Time
}

func (d LogsDeps) now() time.Time {
	if d.NowFunc != nil {
		return tz.In(d.NowFunc())
	}
	return tz.Now()
}

func parseBoundedUnixMillis(raw any, fallback float64) float64 {
	if raw == nil {
		return fallback
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(config.AsPHPString(raw)), 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return fallback
	}
	if f < minValidUnixMillis || f > maxValidUnixMillis {
		return fallback
	}
	return f
}

// Logs implements GET|POST|DELETE /api/logs.php matching feedback-v1/api/logs.php.
func Logs(deps LogsDeps) http.HandlerFunc {
	if deps.Limiter == nil {
		deps.Limiter = syslogs.NewIngestLimiter()
	}
	return func(w http.ResponseWriter, r *http.Request) {
		action := strings.TrimSpace(r.URL.Query().Get("action"))
		switch r.Method {
		case http.MethodPost:
			switch action {
			case "log":
				handleLogsPostIngest(w, r, deps)
			case "sender_sync":
				handleLogsSenderSync(w, r, deps)
			case "sender_snapshot":
				handleLogsSenderSnapshot(w, r, deps)
			case "sender_control_pull":
				handleLogsSenderControlPullPost(w, r, deps)
			case "sender_client_override":
				handleLogsSenderClientOverride(w, r, deps)
			case "sender_client_command":
				handleLogsSenderClientCommand(w, r, deps)
			default:
				httpx.SendResponse(w, false, nil, httpx.StrPtr("未知操作"), http.StatusBadRequest)
			}
		case http.MethodGet:
			switch action {
			case "list":
				handleLogsList(w, r, deps)
			case "filters":
				handleLogsFilters(w, r, deps)
			case "sender_clients":
				handleLogsSenderClients(w, r, deps)
			case "sender_client_control":
				handleLogsSenderClientControl(w, r, deps)
			case "sender_control_pull":
				handleLogsSenderControlPullGet(w, r, deps)
			case "sender_log_file":
				handleLogsSenderLogFile(w, r, deps)
			case "sender_snapshot_img":
				handleLogsSenderSnapshotImg(w, r, deps)
			case "export":
				handleLogsExport(w, r, deps)
			case "stats":
				handleLogsStats(w, r, deps)
			default:
				httpx.SendResponse(w, false, nil, httpx.StrPtr("未知操作"), http.StatusBadRequest)
			}
		case http.MethodDelete:
			handleLogsDelete(w, r, deps)
		default:
			httpx.SendResponse(w, false, nil, httpx.StrPtr("不支持的请求方法"), http.StatusMethodNotAllowed)
		}
	}
}

func newPrefixedLogID(prefix string) string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return prefix + "_" + hex.EncodeToString(b[:])
}

func extractSenderHeaderToken(r *http.Request) string {
	if tok := strings.TrimSpace(r.Header.Get("X-Sender-Token")); tok != "" {
		return tok
	}
	auth := r.Header.Get("Authorization")
	if len(auth) >= 7 && strings.EqualFold(auth[:7], "bearer ") {
		return strings.TrimSpace(auth[7:])
	}
	return ""
}

func verifySenderTokenFromRequest(r *http.Request, loader *config.Loader, explicitToken string) bool {
	tok := strings.TrimSpace(explicitToken)
	if tok == "" {
		tok = extractSenderHeaderToken(r)
	}
	if loader == nil {
		return false
	}
	return loader.Load().VerifySenderToken(tok)
}

func handleLogsPostIngest(w http.ResponseWriter, r *http.Request, deps LogsDeps) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 65537))
	if err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("无效的请求数据"), http.StatusBadRequest)
		return
	}
	if len(raw) > 65536 {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("请求载荷超出限制"), http.StatusRequestEntityTooLarge)
		return
	}

	var input map[string]any
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	if err := dec.Decode(&input); err != nil || len(input) == 0 {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("无效的请求数据"), http.StatusBadRequest)
		return
	}

	serverIP := httpx.GetClientIP(r)
	if !deps.Limiter.Allow("ip:"+serverIP, 60) {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("日志上报频次超限，请稍后再试"), http.StatusTooManyRequests)
		return
	}

	var sess *session.Session
	if c, err := r.Cookie("PHPSESSID"); err == nil && deps.Sessions != nil {
		sess, _ = deps.Sessions.Load(r.Context(), c.Value)
	}
	sessionUser := ""
	if sess != nil {
		sessionUser = strings.TrimSpace(sess.Username())
		if sessionUser == "" {
			sessionUser = strings.TrimSpace(sess.AdminUsername())
		}
	}
	if sessionUser == "" {
		guestKey := "guest_ip:" + serverIP
		if sess != nil && sess.ID != "" {
			guestKey = "guest_sid:" + sess.ID
		}
		if !deps.Limiter.Allow(guestKey, 30) {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("日志上报频次超限，请稍后再试"), http.StatusTooManyRequests)
			return
		}
	}

	var rawEntries []map[string]any
	if arr, ok := input["entries"].([]any); ok {
		for i, item := range arr {
			if i >= 20 {
				break
			}
			if m, ok := item.(map[string]any); ok {
				rawEntries = append(rawEntries, m)
			}
		}
	} else {
		rawEntries = append(rawEntries, input)
	}

	serverUA := strings.TrimSpace(r.Header.Get("User-Agent"))
	if serverUA == "" {
		serverUA = "unknown"
	}
	now := deps.now()
	today := now.Format("2006-01-02")

	records := make([]syslogs.LogRecord, 0, len(rawEntries))
	for _, entry := range rawEntries {
		ts := parseBoundedUnixMillis(entry["timestamp"], float64(now.UnixMilli()))
		level := textutil.TruncateRunes(strings.TrimSpace(config.AsPHPString(entry["level"])), 20)
		if level == "" {
			level = "action"
		}
		module := textutil.TruncateRunes(strings.TrimSpace(config.AsPHPString(entry["module"])), 50)
		if module == "" {
			module = "global"
		}
		event := strings.TrimSpace(config.AsPHPString(entry["event"]))
		if event == "" {
			event = strings.TrimSpace(config.AsPHPString(entry["action"]))
		}
		if event == "" {
			event = "unknown"
		}
		event = textutil.TruncateRunes(event, 80)
		details, _ := entry["details"].(map[string]any)
		if details == nil {
			details = map[string]any{}
		}
		ctxMap, _ := entry["context"].(map[string]any)
		if ctxMap == nil {
			ctxMap = map[string]any{}
		}

		reqOp := strings.TrimSpace(config.AsPHPString(entry["operator"]))
		if reqOp == "" {
			reqOp = strings.TrimSpace(config.AsPHPString(ctxMap["operator"]))
		}
		operator := "guest"
		if sessionUser != "" {
			operator = textutil.TruncateRunes(sessionUser, 50)
		} else if reqOp != "" {
			operator = "guest:" + textutil.TruncateRunes(reqOp, 30)
		}

		clientMap := map[string]any{}
		if rawCli, ok := entry["client"].(map[string]any); ok {
			for k, v := range rawCli {
				clientMap[k] = v
			}
		}
		clientMap["ip"] = serverIP
		if strings.TrimSpace(config.AsPHPString(clientMap["userAgent"])) == "" {
			clientMap["userAgent"] = serverUA
		}

		createdAt := tz.Unix(int64(math.Ceil(ts/1000.0)), 0).Format("2006-01-02 15:04:05")
		records = append(records, syslogs.LogRecord{
			ID:        newPrefixedLogID("log"),
			Timestamp: ts,
			Level:     level,
			Module:    module,
			Event:     event,
			Operator:  operator,
			Details:   details,
			Context:   ctxMap,
			Client:    clientMap,
			ClientIP:  serverIP,
			CreatedAt: createdAt,
			DateStr:   today,
		})
	}

	if deps.Repo != nil {
		_ = deps.Repo.InsertBatch(r.Context(), records)
	}
	httpx.SendResponse(w, true, map[string]any{
		"count":   len(records),
		"message": "日志记录成功",
	}, nil, http.StatusOK)
}

func handleLogsSenderSync(w http.ResponseWriter, r *http.Request, deps LogsDeps) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 524289))
	if err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("无效的请求数据"), http.StatusBadRequest)
		return
	}
	if len(raw) > 524288 {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("请求载荷超出限制"), http.StatusRequestEntityTooLarge)
		return
	}
	var input map[string]any
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	if err := dec.Decode(&input); err != nil || len(input) == 0 {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("无效的请求数据"), http.StatusBadRequest)
		return
	}

	if !verifySenderTokenFromRequest(r, deps.ConfigLoader, config.AsPHPString(input["token"])) {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("发送器鉴权失败"), http.StatusOK)
		return
	}

	serverIP := httpx.GetClientIP(r)
	clientInfo, _ := input["client"].(map[string]any)
	rawSlug := config.AsPHPString(clientInfo["client_slug"])
	if rawSlug == "" {
		rawSlug = config.AsPHPString(clientInfo["hostname"])
	}
	clientSlug := senderlogs.SanitizeSlug(rawSlug)
	activeFiles, _ := input["active_files"].([]any)
	runtimeState, _ := input["runtime_state"].(map[string]any)
	ackCommands, _ := input["ack_commands"].([]any)
	syncMode := strings.TrimSpace(config.AsPHPString(input["sync_mode"]))
	if syncMode == "" {
		syncMode = "realtime"
	}

	if len(ackCommands) > 0 && deps.SenderCtrl != nil {
		_, _ = deps.SenderCtrl.AcknowledgeCommands(clientSlug, ackCommands)
	}

	// Opportunistic async 30-day retention cleanup
	if deps.SenderLogs != nil && deps.now().UnixNano()%30 == 0 {
		runAsyncCleanup(&senderLogsCleanupRunning, func() {
			deps.SenderLogs.CleanupOld(syslogs.RetentionDays)
		})
	}

	now := deps.now()
	var cloudCtrl map[string]any
	if deps.SenderCtrl != nil {
		cloudCtrl = deps.SenderCtrl.BuildEffectiveControl(clientSlug, true)
	}

	switch syncMode {
	case "heartbeat":
		dateStr := senderlogs.SanitizeDate(config.AsPHPString(input["date_str"]), now)
		if deps.SenderLogs != nil {
			cDir := deps.SenderLogs.ClientDir(dateStr, clientSlug)
			deps.SenderLogs.UpdateClientMeta(cDir, clientInfo, activeFiles, serverIP, runtimeState)
		}
		httpx.SendResponse(w, true, map[string]any{
			"mode":          "heartbeat",
			"client_slug":   clientSlug,
			"cloud_control": cloudCtrl,
		}, nil, http.StatusOK)

	case "chunk":
		dateStr := senderlogs.SanitizeDate(config.AsPHPString(input["date_str"]), now)
		logType := "sender"
		if config.AsPHPString(input["log_type"]) == "error" {
			logType = "error"
		}
		offset := int64(config.AsPHPInt(input["offset"]))
		if offset < 0 {
			offset = 0
		}
		content := config.AsPHPString(input["content"])
		var size int64
		if deps.SenderLogs != nil {
			cDir := deps.SenderLogs.ClientDir(dateStr, clientSlug)
			deps.SenderLogs.UpdateClientMeta(cDir, clientInfo, activeFiles, serverIP, runtimeState)
			size = deps.SenderLogs.WriteChunk(cDir, dateStr, logType, offset, content)
		}
		httpx.SendResponse(w, true, map[string]any{
			"mode":          "chunk",
			"date":          dateStr,
			"client_slug":   clientSlug,
			"size":          size,
			"cloud_control": cloudCtrl,
		}, nil, http.StatusOK)

	case "batch_summary":
		summary, _ := input["batch_summary"].(map[string]any)
		if summary == nil {
			summary = map[string]any{}
		}
		dateStr := senderlogs.SanitizeDate(config.AsPHPString(summary["date_str"]), now)
		filesForMeta, _ := summary["files"].([]any)
		if len(filesForMeta) == 0 {
			filesForMeta = activeFiles
		}
		if filesForMeta == nil {
			filesForMeta = []any{}
		}
		var meta map[string]any
		if deps.SenderLogs != nil {
			cDir := deps.SenderLogs.ClientDir(dateStr, clientSlug)
			meta = deps.SenderLogs.UpdateClientMeta(cDir, clientInfo, filesForMeta, serverIP, runtimeState)
			deps.SenderLogs.AppendBatchSummary(cDir, summary)
		}
		counts, _ := summary["counts"].(map[string]any)
		if counts == nil {
			counts = map[string]any{}
		}
		failed := config.AsPHPInt(counts["failed"])
		blocked := config.AsPHPInt(counts["blocked"])
		unmatched := config.AsPHPInt(counts["unmatched"])
		sysLevel := "action"
		if failed > 0 || blocked > 0 || unmatched > 0 {
			sysLevel = "warn"
		}
		students, _ := summary["students"].([]any)
		if students == nil {
			students = []any{}
		}
		if len(students) > 150 {
			students = students[:150]
		}
		dispName := config.AsPHPString(meta["display_name"])
		if dispName == "" {
			dispName = clientSlug
		}
		op := config.AsPHPString(meta["operator"])
		auditlog.RecordFromRequest(r.Context(), deps.Audit, r, sysLevel, "sender_py", "batch_summary", op, map[string]any{
			"message": fmt.Sprintf(
				"[%s] 批次发送完成：共 %d 人（成功 %d / 失败 %d / 拦截 %d / 未匹配 %d / 跳过 %d）",
				dispName,
				config.AsPHPInt(counts["total"]),
				config.AsPHPInt(counts["sent"]),
				failed, blocked, unmatched,
				config.AsPHPInt(counts["skipped"]),
			),
			"counts":         counts,
			"files":          filesForMeta,
			"stopped":        config.AsPHPBool(summary["stopped"]),
			"client_slug":    clientSlug,
			"client_display": dispName,
			"students":       students,
		})
		httpx.SendResponse(w, true, map[string]any{
			"mode":          "batch_summary",
			"client_slug":   clientSlug,
			"cloud_control": cloudCtrl,
		}, nil, http.StatusOK)

	default:
		rawEntries, _ := input["entries"].([]any)
		if len(rawEntries) > 100 {
			rawEntries = rawEntries[:100]
		}
		if len(rawEntries) == 0 && deps.SenderLogs != nil {
			dateStr := senderlogs.SanitizeDate(config.AsPHPString(input["date_str"]), now)
			cDir := deps.SenderLogs.ClientDir(dateStr, clientSlug)
			deps.SenderLogs.UpdateClientMeta(cDir, clientInfo, activeFiles, serverIP, runtimeState)
		}

		metaCache := make(map[string]map[string]any)
		dirCache := make(map[string]string)
		byDateRaw := make(map[string]*strings.Builder)
		byDateErr := make(map[string]*strings.Builder)
		records := make([]syslogs.LogRecord, 0, len(rawEntries))

		for _, item := range rawEntries {
			entry, ok := item.(map[string]any)
			if !ok {
				continue
			}
			dateStr := senderlogs.SanitizeDate(config.AsPHPString(entry["date_str"]), now)
			curMeta, cached := metaCache[dateStr]
			if !cached {
				if deps.SenderLogs != nil {
					cDir := deps.SenderLogs.ClientDir(dateStr, clientSlug)
					dirCache[dateStr] = cDir
					curMeta = deps.SenderLogs.UpdateClientMeta(cDir, clientInfo, activeFiles, serverIP, runtimeState)
				} else {
					curMeta = map[string]any{"display_name": clientSlug, "operator": clientSlug, "hostname": clientSlug}
				}
				metaCache[dateStr] = curMeta
			}

			rawLine := config.AsPHPString(entry["raw_line"])
			if rawLine != "" {
				if !strings.HasSuffix(rawLine, "\n") {
					rawLine += "\n"
				}
				b := byDateRaw[dateStr]
				if b == nil {
					b = &strings.Builder{}
					byDateRaw[dateStr] = b
				}
				b.WriteString(rawLine)
				if config.AsPHPBool(entry["is_error"]) {
					eb := byDateErr[dateStr]
					if eb == nil {
						eb = &strings.Builder{}
						byDateErr[dateStr] = eb
					}
					eb.WriteString(rawLine)
				}
			}

			ts := parseBoundedUnixMillis(entry["timestamp"], float64(now.UnixMilli()))
			sysLevel := config.AsPHPString(entry["sys_level"])
			switch sysLevel {
			case "error", "warn", "action", "info":
			default:
				sysLevel = "info"
			}
			event := strings.TrimSpace(config.AsPHPString(entry["event"]))
			if event == "" {
				event = "sender_log"
			}
			event = textutil.TruncateRunes(event, 60)
			rawLvl := config.AsPHPString(entry["level"])
			if rawLvl == "" {
				rawLvl = "INFO"
			}
			details := map[string]any{
				"message":   config.AsPHPString(entry["message"]),
				"client":    config.AsPHPString(curMeta["display_name"]),
				"raw_level": rawLvl,
			}
			if len(activeFiles) > 0 {
				details["files"] = activeFiles
			}
			if tb := config.AsPHPString(entry["traceback"]); tb != "" {
				details["traceback"] = tb
			}
			op := config.AsPHPString(curMeta["operator"])
			ctxMap := map[string]any{
				"operator":     op,
				"source":       "sender_py",
				"client_slug":  clientSlug,
				"hostname":     config.AsPHPString(curMeta["hostname"]),
				"os_user":      config.AsPHPString(curMeta["os_user"]),
				"teacher_note": config.AsPHPString(curMeta["teacher_note"]),
				"files":        activeFiles,
			}
			cliRec := map[string]any{"ip": serverIP, "source": "sender_py"}
			for k, v := range curMeta {
				cliRec[k] = v
			}
			createdAt := tz.Unix(int64(math.Ceil(ts/1000.0)), 0).Format("2006-01-02 15:04:05")

			records = append(records, syslogs.LogRecord{
				ID:        newPrefixedLogID("snd"),
				Timestamp: ts,
				Level:     sysLevel,
				Module:    "sender_py",
				Event:     event,
				Operator:  op,
				Details:   details,
				Context:   ctxMap,
				Client:    cliRec,
				ClientIP:  serverIP,
				CreatedAt: createdAt,
				DateStr:   dateStr,
			})
		}

		if deps.Repo != nil && len(records) > 0 {
			_ = deps.Repo.InsertBatch(r.Context(), records)
		}
		if deps.SenderLogs != nil {
			for dStr, b := range byDateRaw {
				deps.SenderLogs.AppendLogText(dirCache[dStr], dStr, "sender", b.String())
			}
			for dStr, b := range byDateErr {
				deps.SenderLogs.AppendLogText(dirCache[dStr], dStr, "error", b.String())
			}
		}

		httpx.SendResponse(w, true, map[string]any{
			"count":         len(records),
			"client_slug":   clientSlug,
			"cloud_control": cloudCtrl,
		}, nil, http.StatusOK)
	}
}

func readValidSnapshotImage(r *http.Request, field string) []byte {
	f, fh, err := r.FormFile(field)
	if err != nil {
		return nil
	}
	defer func() { _ = f.Close() }()
	if fh.Size > 5<<20 {
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(f, (5<<20)+1))
	if err != nil || len(data) > 5<<20 {
		return nil
	}
	if _, _, _, ok := vision.InspectImage(data); !ok {
		return nil
	}
	return data
}

func handleLogsSenderSnapshot(w http.ResponseWriter, r *http.Request, deps LogsDeps) {
	if hdrTok := extractSenderHeaderToken(r); hdrTok != "" {
		if deps.ConfigLoader == nil || !deps.ConfigLoader.Load().VerifySenderToken(hdrTok) {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("发送器鉴权失败"), http.StatusOK)
			return
		}
	}

	if r.ContentLength > 12<<20 {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("请求载荷超出限制"), http.StatusRequestEntityTooLarge)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 12<<20)
	ct := strings.ToLower(r.Header.Get("Content-Type"))
	if strings.HasPrefix(ct, "multipart/form-data") {
		if err := r.ParseMultipartForm(4 << 20); err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				httpx.SendResponse(w, false, nil, httpx.StrPtr("请求载荷超出限制"), http.StatusRequestEntityTooLarge)
				return
			}
			httpx.SendResponse(w, false, nil, httpx.StrPtr("无效的请求数据"), http.StatusBadRequest)
			return
		}
		if r.MultipartForm != nil {
			defer func() { _ = r.MultipartForm.RemoveAll() }()
		}
	} else if err := r.ParseForm(); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("请求载荷超出限制"), http.StatusRequestEntityTooLarge)
			return
		}
	}

	if !verifySenderTokenFromRequest(r, deps.ConfigLoader, r.PostFormValue("token")) {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("发送器鉴权失败"), http.StatusOK)
		return
	}

	serverIP := httpx.GetClientIP(r)
	clientInfo := map[string]any{}
	_ = json.Unmarshal([]byte(r.PostFormValue("client_json")), &clientInfo)
	if clientInfo == nil {
		clientInfo = map[string]any{}
	}
	metaIn := map[string]any{}
	_ = json.Unmarshal([]byte(r.PostFormValue("meta_json")), &metaIn)
	if metaIn == nil {
		metaIn = map[string]any{}
	}

	now := deps.now()
	rawPrefix := r.PostFormValue("prefix")
	if rawPrefix == "" {
		rawPrefix = config.AsPHPString(metaIn["timestamp"])
	}
	safePrefix := senderlogs.SanitizePrefix(rawPrefix, now)
	tsStr := config.AsPHPString(metaIn["timestamp"])
	if tsStr == "" {
		tsStr = safePrefix
	}
	dateStr := senderlogs.SanitizeDate(tsStr, now)
	rawSlug := config.AsPHPString(clientInfo["client_slug"])
	if rawSlug == "" {
		rawSlug = config.AsPHPString(clientInfo["hostname"])
	}
	clientSlug := senderlogs.SanitizeSlug(rawSlug)

	titleImg := readValidSnapshotImage(r, "image_title")
	annotatedImg := readValidSnapshotImage(r, "image_annotated")

	var clientMeta map[string]any
	if deps.SenderLogs != nil {
		cDir := deps.SenderLogs.ClientDir(dateStr, clientSlug)
		clientMeta = deps.SenderLogs.UpdateClientMeta(cDir, clientInfo, nil, serverIP, nil)
		metaIn["saved_at"] = now.Format("2006-01-02 15:04:05")
		metaIn["client_slug"] = clientSlug
		metaIn["client_display"] = config.AsPHPString(clientMeta["display_name"])
		_ = deps.SenderLogs.SaveSnapshot(cDir, safePrefix, titleImg, annotatedImg, metaIn)
	}

	diagInfo, _ := metaIn["diag_info"].(map[string]any)
	judgment, _ := diagInfo["judgment"].(map[string]any)
	reason := config.AsPHPString(judgment["reason"])
	if reason == "" {
		reason = config.AsPHPString(diagInfo["reason"])
	}
	if reason == "" {
		reason = "核验未通过"
	}
	targetID := config.AsPHPString(metaIn["target_id"])
	targetName := config.AsPHPString(metaIn["target_name"])
	cand := config.AsPHPInt(metaIn["candidate"])
	if cand == 0 {
		cand = 1
	}
	dispName := config.AsPHPString(clientMeta["display_name"])
	if dispName == "" {
		dispName = clientSlug
	}
	auditlog.RecordFromRequest(r.Context(), deps.Audit, r, "warn", "sender_py", "verify_snapshot", config.AsPHPString(clientMeta["operator"]), map[string]any{
		"message":     fmt.Sprintf("[%s] 核验现场快照：%s%s (候选%d) - %s", dispName, targetID, targetName, cand, reason),
		"target_id":   targetID,
		"target_name": targetName,
		"candidate":   cand,
		"reason":      reason,
		"date":        dateStr,
		"client_slug": clientSlug,
		"prefix":      safePrefix,
	})

	httpx.SendResponse(w, true, map[string]any{
		"prefix":      safePrefix,
		"date":        dateStr,
		"client_slug": clientSlug,
	}, nil, http.StatusOK)
}

func handleLogsSenderControlPullPost(w http.ResponseWriter, r *http.Request, deps LogsDeps) {
	ct := strings.ToLower(r.Header.Get("Content-Type"))
	var input map[string]any
	var tok string
	if strings.HasPrefix(ct, "application/x-www-form-urlencoded") || strings.HasPrefix(ct, "multipart/form-data") {
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		httpx.ParseRequestForm(r)
		if r.MultipartForm != nil {
			defer func() { _ = r.MultipartForm.RemoveAll() }()
		}
		tok = r.PostFormValue("token")
		input = map[string]any{
			"client_slug": r.PostFormValue("client_slug"),
		}
		if rawClient := strings.TrimSpace(r.PostFormValue("client")); rawClient != "" {
			var cm map[string]any
			if json.Unmarshal([]byte(rawClient), &cm) == nil && cm != nil {
				input["client"] = cm
			}
		}
	} else {
		input = readJSONBodyMap(r)
		tok = config.AsPHPString(input["token"])
	}
	if !verifySenderTokenFromRequest(r, deps.ConfigLoader, tok) {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("发送器鉴权失败"), http.StatusOK)
		return
	}

	clientInfo, _ := input["client"].(map[string]any)
	rawSlug := config.AsPHPString(clientInfo["client_slug"])
	if rawSlug == "" {
		rawSlug = config.AsPHPString(input["client_slug"])
	}
	if rawSlug == "" {
		rawSlug = config.AsPHPString(clientInfo["hostname"])
	}
	clientSlug := senderlogs.SanitizeSlug(rawSlug)
	activeFiles, _ := input["active_files"].([]any)
	runtimeState, _ := input["runtime_state"].(map[string]any)
	ackCommands, _ := input["ack_commands"].([]any)

	if len(ackCommands) > 0 && deps.SenderCtrl != nil {
		_, _ = deps.SenderCtrl.AcknowledgeCommands(clientSlug, ackCommands)
	}
	if len(clientInfo) > 0 && deps.SenderLogs != nil {
		dateStr := deps.now().Format("2006-01-02")
		cDir := deps.SenderLogs.ClientDir(dateStr, clientSlug)
		deps.SenderLogs.UpdateClientMeta(cDir, clientInfo, activeFiles, httpx.GetClientIP(r), runtimeState)
	}

	var cloudCtrl map[string]any
	if deps.SenderCtrl != nil {
		cloudCtrl = deps.SenderCtrl.BuildEffectiveControl(clientSlug, true)
	}
	httpx.SendResponse(w, true, map[string]any{
		"client_slug":   clientSlug,
		"cloud_control": cloudCtrl,
	}, nil, http.StatusOK)
}

func handleLogsSenderControlPullGet(w http.ResponseWriter, r *http.Request, deps LogsDeps) {
	tok := strings.TrimSpace(r.URL.Query().Get("token"))
	if !verifySenderTokenFromRequest(r, deps.ConfigLoader, tok) {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("发送器鉴权失败"), http.StatusOK)
		return
	}
	clientSlug := senderlogs.SanitizeSlug(r.URL.Query().Get("client_slug"))
	var cloudCtrl map[string]any
	if deps.SenderCtrl != nil {
		cloudCtrl = deps.SenderCtrl.BuildEffectiveControl(clientSlug, true)
	}
	httpx.SendResponse(w, true, map[string]any{
		"client_slug":   clientSlug,
		"cloud_control": cloudCtrl,
	}, nil, http.StatusOK)
}

func handleLogsSenderClientOverride(w http.ResponseWriter, r *http.Request, deps LogsDeps) {
	if !httpx.RequireStrictSameOrigin(w, r) {
		return
	}
	sess, ok := session.RequireAdmin(w, r, deps.Sessions)
	if !ok {
		return
	}
	input := readJSONBodyMap(r)
	if len(input) == 0 {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("无效的请求载荷"), http.StatusBadRequest)
		return
	}
	clientSlug := strings.TrimSpace(config.AsPHPString(input["client_slug"]))
	if clientSlug == "" {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("缺少 client_slug"), http.StatusBadRequest)
		return
	}
	clearAll := config.AsPHPBool(input["clear"])
	var overrides map[string]any
	note := ""
	if !clearAll {
		overrides, _ = input["overrides"].(map[string]any)
		note = config.AsPHPString(input["note"])
	}
	st, err := deps.SenderCtrl.SetOverrides(clientSlug, overrides, note)
	if err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("保存单机云控覆盖策略失败，请检查目录权限"), http.StatusInternalServerError)
		return
	}
	msg := fmt.Sprintf("已更新发送器 [%s] 的单机云控覆盖策略", st.ClientSlug)
	if clearAll {
		msg = fmt.Sprintf("已清空发送器 [%s] 的单机云控覆盖（恢复继承全局）", st.ClientSlug)
	}
	auditlog.RecordFromRequest(r.Context(), deps.Audit, r, "action", "admin", "sender_client_override", sess.AdminUsername(), map[string]any{
		"client_slug": st.ClientSlug,
		"clear":       clearAll,
		"overrides":   st.Overrides,
		"note":        st.Note,
		"message":     msg,
	})
	httpx.SendResponse(w, true, map[string]any{
		"client_slug": st.ClientSlug,
		"control":     st,
		"summary":     deps.SenderCtrl.SummarizeForAdmin(st.ClientSlug),
	}, nil, http.StatusOK)
}

func handleLogsSenderClientCommand(w http.ResponseWriter, r *http.Request, deps LogsDeps) {
	if !httpx.RequireStrictSameOrigin(w, r) {
		return
	}
	sess, ok := session.RequireAdmin(w, r, deps.Sessions)
	if !ok {
		return
	}
	input := readJSONBodyMap(r)
	if len(input) == 0 {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("无效的请求载荷"), http.StatusBadRequest)
		return
	}
	clientSlug := strings.TrimSpace(config.AsPHPString(input["client_slug"]))
	cmdType := strings.TrimSpace(config.AsPHPString(input["type"]))
	params, _ := input["params"].(map[string]any)
	if clientSlug == "" || cmdType == "" {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("缺少 client_slug 或指令类型"), http.StatusBadRequest)
		return
	}
	op := strings.TrimSpace(sess.Username())
	if op == "" {
		op = strings.TrimSpace(sess.AdminUsername())
	}
	if op == "" {
		op = "admin"
	}
	cmd, err := deps.SenderCtrl.EnqueueCommand(clientSlug, cmdType, params, op)
	if err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("保存远程指令失败，请检查目录权限"), http.StatusInternalServerError)
		return
	}
	if cmd == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("不支持的远程指令类型: "+html.EscapeString(cmdType)), http.StatusBadRequest)
		return
	}
	cmdLabels := map[string]string{
		"stop_batch":     "远程急停（暂停发送并保持断点）",
		"refresh_policy": "立即拉取最新云控策略",
		"clear_roi":      "清除本机视野校准缓存",
		"sync_logs":      "立即补传本地日志",
	}
	lbl := cmdLabels[cmd.Type]
	if lbl == "" {
		lbl = cmd.Type
	}
	auditlog.RecordFromRequest(r.Context(), deps.Audit, r, "action", "admin", "sender_client_command", op, map[string]any{
		"client_slug": clientSlug,
		"cmd_id":      cmd.CmdID,
		"type":        cmd.Type,
		"params":      cmd.Params,
		"message":     fmt.Sprintf("管理员向 [%s] 下发远程指令：%s", clientSlug, lbl),
	})
	httpx.SendResponse(w, true, map[string]any{
		"command": cmd,
		"summary": deps.SenderCtrl.SummarizeForAdmin(clientSlug),
	}, nil, http.StatusOK)
}

func handleLogsList(w http.ResponseWriter, r *http.Request, deps LogsDeps) {
	if _, ok := session.RequireAdmin(w, r, deps.Sessions); !ok {
		return
	}
	if deps.Repo == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("数据库暂时不可用"), http.StatusInternalServerError)
		return
	}
	q := r.URL.Query()
	res, err := deps.Repo.List(r.Context(), syslogs.ListFilter{
		Page:        config.AsPHPInt(q.Get("page")),
		PerPage:     config.AsPHPInt(q.Get("perPage")),
		Level:       strings.TrimSpace(q.Get("level")),
		Module:      strings.TrimSpace(q.Get("module")),
		Event:       strings.TrimSpace(q.Get("event")),
		Date:        strings.TrimSpace(q.Get("date")),
		Search:      strings.TrimSpace(q.Get("search")),
		IP:          strings.TrimSpace(q.Get("ip")),
		Fingerprint: strings.TrimSpace(q.Get("fingerprint")),
	})
	if err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("数据库暂时不可用"), http.StatusInternalServerError)
		return
	}
	httpx.SendResponse(w, true, res, nil, http.StatusOK)
}

func handleLogsFilters(w http.ResponseWriter, r *http.Request, deps LogsDeps) {
	if _, ok := session.RequireAdmin(w, r, deps.Sessions); !ok {
		return
	}
	if deps.Repo == nil {
		httpx.SendResponse(w, true, map[string]any{
			"modules": []string{"viewer", "upload", "qbank", "admin", "sender_py"},
			"events":  []string{},
			"ips":     []string{},
			"levels":  []string{"error", "warn", "action", "info"},
			"dates":   []string{},
		}, nil, http.StatusOK)
		return
	}
	res, err := deps.Repo.Filters(r.Context())
	if err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("数据库暂时不可用"), http.StatusInternalServerError)
		return
	}
	httpx.SendResponse(w, true, res, nil, http.StatusOK)
}

func handleLogsSenderClients(w http.ResponseWriter, r *http.Request, deps LogsDeps) {
	if _, ok := session.RequireAdmin(w, r, deps.Sessions); !ok {
		return
	}
	reqDate := strings.TrimSpace(r.URL.Query().Get("date"))
	dates, clients := deps.SenderLogs.ListClients(reqDate)
	httpx.SendResponse(w, true, map[string]any{
		"dates":                 dates,
		"clients":               clients,
		"global_sender_control": deps.SenderCtrl.GlobalPolicy(),
	}, nil, http.StatusOK)
}

func handleLogsSenderClientControl(w http.ResponseWriter, r *http.Request, deps LogsDeps) {
	if _, ok := session.RequireAdmin(w, r, deps.Sessions); !ok {
		return
	}
	clientSlug := strings.TrimSpace(r.URL.Query().Get("client"))
	if clientSlug == "" {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("缺少 client 参数"), http.StatusBadRequest)
		return
	}
	httpx.SendResponse(w, true, map[string]any{
		"client_slug":    senderctrl.SanitizeSlug(clientSlug),
		"global":         deps.SenderCtrl.GlobalPolicy(),
		"client_control": deps.SenderCtrl.LoadClientState(clientSlug),
		"summary":        deps.SenderCtrl.SummarizeForAdmin(clientSlug),
	}, nil, http.StatusOK)
}

func handleLogsSenderLogFile(w http.ResponseWriter, r *http.Request, deps LogsDeps) {
	if _, ok := session.RequireAdmin(w, r, deps.Sessions); !ok {
		return
	}
	q := r.URL.Query()
	logType := "sender"
	if q.Get("type") == "error" {
		logType = "error"
	}
	maxLines := config.AsPHPInt(q.Get("lines"))
	if maxLines == 0 {
		maxLines = 2000
	}
	if maxLines < 50 {
		maxLines = 50
	}
	if maxLines > 10000 {
		maxLines = 10000
	}
	isDownload := config.AsPHPBool(q.Get("download"))

	if isDownload {
		var dlErr error
		_, _, _, err := deps.SenderLogs.StreamLogFile(q.Get("date"), q.Get("client"), logType, func(f *os.File, size int64) error {
			_, dateStr, clientSlug, _ := deps.SenderLogs.LogFilePath(q.Get("date"), q.Get("client"), logType)
			dlName := clientSlug + "_" + logType + "_" + dateStr + ".log"
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, dlName))
			w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
			w.WriteHeader(http.StatusOK)
			_, dlErr = io.CopyN(w, f, size)
			return nil
		})
		if err != nil {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte("日志文件不存在"))
			return
		}
		_ = dlErr
		return
	}

	dateStr, clientSlug, filename, content, totalLines, sizeBytes, err := deps.SenderLogs.ReadLogFileTail(q.Get("date"), q.Get("client"), logType, maxLines)
	if err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("指定的日志文件不存在"), http.StatusNotFound)
		return
	}
	httpx.SendResponse(w, true, map[string]any{
		"date":        dateStr,
		"client_slug": clientSlug,
		"type":        logType,
		"filename":    filename,
		"total_lines": totalLines,
		"size_kb":     math.Round(float64(sizeBytes)/1024*100) / 100,
		"content":     content,
	}, nil, http.StatusOK)
}

func handleLogsSenderSnapshotImg(w http.ResponseWriter, r *http.Request, deps LogsDeps) {
	if _, ok := session.RequireAdmin(w, r, deps.Sessions); !ok {
		return
	}
	q := r.URL.Query()
	data, err := deps.SenderLogs.ReadSnapshotImage(q.Get("date"), q.Get("client"), q.Get("prefix"), q.Get("img"))
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	mime := "image/png"
	if _, _, detected, ok := vision.InspectImage(data); ok && detected != "" {
		mime = detected
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func handleLogsExport(w http.ResponseWriter, r *http.Request, deps LogsDeps) {
	if _, ok := session.RequireAdmin(w, r, deps.Sessions); !ok {
		return
	}
	if deps.Repo == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("数据库连接失败"), http.StatusInternalServerError)
		return
	}
	q := r.URL.Query()
	rows, err := deps.Repo.ExportRows(r.Context(), syslogs.ListFilter{
		Level:       strings.TrimSpace(q.Get("level")),
		Module:      strings.TrimSpace(q.Get("module")),
		Event:       strings.TrimSpace(q.Get("event")),
		Date:        strings.TrimSpace(q.Get("date")),
		Search:      strings.TrimSpace(q.Get("search")),
		IP:          strings.TrimSpace(q.Get("ip")),
		Fingerprint: strings.TrimSpace(q.Get("fingerprint")),
	}, 5000)
	if err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("数据库连接失败"), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", "attachment; filename=logs_"+deps.now().Format("20060102_150405")+".csv")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")
	w.WriteHeader(http.StatusOK)
	_ = syslogs.WriteExportCSV(w, rows)
}

func handleLogsStats(w http.ResponseWriter, r *http.Request, deps LogsDeps) {
	if _, ok := session.RequireAdmin(w, r, deps.Sessions); !ok {
		return
	}
	if deps.Repo == nil {
		httpx.SendResponse(w, true, &syslogs.StatsResult{
			Dates:         []string{},
			DailyStats:    []syslogs.DailyStat{},
			RetentionDays: syslogs.RetentionDays,
		}, nil, http.StatusOK)
		return
	}
	res, err := deps.Repo.Stats(r.Context())
	if err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("数据库暂时不可用"), http.StatusInternalServerError)
		return
	}
	httpx.SendResponse(w, true, res, nil, http.StatusOK)
}

func handleLogsDelete(w http.ResponseWriter, r *http.Request, deps LogsDeps) {
	if _, ok := session.RequireAdmin(w, r, deps.Sessions); !ok {
		return
	}
	q := r.URL.Query()
	deleteAction := strings.TrimSpace(q.Get("action"))
	if deleteAction == "clear" {
		date := strings.TrimSpace(q.Get("date"))
		if date == "" {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("缺少日期参数"), http.StatusBadRequest)
			return
		}
		var cnt int64
		if deps.Repo != nil {
			cnt, _ = deps.Repo.DeleteByDate(r.Context(), date)
		}
		httpx.SendResponse(w, true, map[string]any{
			"deleted": cnt,
			"message": fmt.Sprintf("已删除 %d 条日志", cnt),
		}, nil, http.StatusOK)
		return
	}

	id := strings.TrimSpace(q.Get("id"))
	if id == "" {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("缺少日志 ID"), http.StatusBadRequest)
		return
	}
	if deps.Repo != nil {
		_, _ = deps.Repo.DeleteByID(r.Context(), id)
	}
	httpx.SendResponse(w, true, map[string]any{"message": "日志已删除"}, nil, http.StatusOK)
}
