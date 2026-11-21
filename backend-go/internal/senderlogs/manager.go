package senderlogs

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"feedback-api/internal/config"
	"feedback-api/internal/senderctrl"
)

var (
	reNonSlug    = regexp.MustCompile(`[^a-zA-Z0-9_-]`)
	reISODate    = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	reCompactDay = regexp.MustCompile(`^(\d{4})(\d{2})(\d{2})`)
	reSafePrefix = regexp.MustCompile(`[^\p{Han}a-zA-Z0-9_\-]`)
)

// Manager manages data/sender_logs/<YYYY-MM-DD>/<client_slug>/ files, metadata, snapshots, and cleanup.
type Manager struct {
	feedbackRoot string
	ctrl         *senderctrl.Store
	mu           sync.Mutex
	nowFunc      func() time.Time
}

// NewManager creates a senderlogs.Manager.
func NewManager(feedbackRoot string, ctrl *senderctrl.Store) *Manager {
	return &Manager{
		feedbackRoot: strings.TrimSpace(feedbackRoot),
		ctrl:         ctrl,
		nowFunc:      time.Now,
	}
}

func (m *Manager) now() time.Time {
	if m != nil && m.nowFunc != nil {
		return m.nowFunc()
	}
	return time.Now()
}

func (m *Manager) baseDir() string {
	return filepath.Join(m.feedbackRoot, "data", "sender_logs")
}

// SanitizeSlug mirrors PHP sanitizeSenderSlug().
func SanitizeSlug(slug string) string {
	clean := reNonSlug.ReplaceAllString(strings.TrimSpace(slug), "_")
	clean = strings.Trim(clean, "_")
	if clean == "" {
		return "unknown_pc"
	}
	if len(clean) > 64 {
		return clean[:64]
	}
	return clean
}

// SanitizeDate mirrors PHP sanitizeSenderDate().
func SanitizeDate(raw string, now time.Time) string {
	d := strings.TrimSpace(raw)
	if reISODate.MatchString(d) {
		return d
	}
	if sub := reCompactDay.FindStringSubmatch(d); len(sub) == 4 {
		return sub[1] + "-" + sub[2] + "-" + sub[3]
	}
	return now.Format("2006-01-02")
}

// SanitizePrefix safely cleans snapshot directory prefixes (prevents path traversal).
func SanitizePrefix(raw string, now time.Time) string {
	base := filepath.Base(strings.TrimSpace(raw))
	clean := reSafePrefix.ReplaceAllString(base, "_")
	clean = strings.Trim(clean, "_")
	if clean == "" || clean == "." || clean == ".." {
		return now.Format("20060102_150405")
	}
	if len(clean) > 120 {
		clean = clean[:120]
	}
	return clean
}

// ClientDir returns <FeedbackRoot>/data/sender_logs/<date>/<slug>.
func (m *Manager) ClientDir(dateStr, clientSlug string) string {
	return filepath.Join(m.baseDir(), SanitizeDate(dateStr, m.now()), SanitizeSlug(clientSlug))
}

// UpdateClientMeta merges and persists meta.json inside clientDir.
func (m *Manager) UpdateClientMeta(clientDir string, clientInfo map[string]any, activeFiles []any, ip string, runtimeState map[string]any) map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()

	_ = os.MkdirAll(clientDir, 0755)
	metaPath := filepath.Join(clientDir, "meta.json")
	existing := make(map[string]any)
	if raw, err := os.ReadFile(metaPath); err == nil {
		_ = json.Unmarshal(raw, &existing)
	}

	pickStr := func(key, def string) string {
		if clientInfo != nil {
			if v, ok := clientInfo[key]; ok && v != nil {
				if s := strings.TrimSpace(config.AsPHPString(v)); s != "" {
					return s
				}
			}
		}
		if v, ok := existing[key]; ok && v != nil {
			if s := strings.TrimSpace(config.AsPHPString(v)); s != "" {
				return s
			}
		}
		return def
	}

	hostname := pickStr("hostname", "UnknownPC")
	osUser := pickStr("os_user", "user")
	teacherNote := ""
	if clientInfo != nil {
		if _, exists := clientInfo["teacher_note"]; exists {
			teacherNote = strings.TrimSpace(config.AsPHPString(clientInfo["teacher_note"]))
		} else {
			teacherNote = strings.TrimSpace(config.AsPHPString(existing["teacher_note"]))
		}
	} else {
		teacherNote = strings.TrimSpace(config.AsPHPString(existing["teacher_note"]))
	}

	displayName := hostname + " (" + osUser + ")"
	if teacherNote != "" {
		displayName = teacherNote + " (" + hostname + "/" + osUser + ")"
	}
	operator := hostname
	if teacherNote != "" {
		operator = teacherNote + "(" + hostname + ")"
	}
	if len(operator) > 50 {
		operator = operator[:50]
	}

	filesOut := existing["active_files"]
	if len(activeFiles) > 0 {
		filesOut = activeFiles
	}
	if filesOut == nil {
		filesOut = []any{}
	}

	rtOut := existing["runtime_state"]
	if runtimeState != nil {
		rtOut = runtimeState
	}
	if rtOut == nil {
		rtOut = map[string]any{}
	}

	now := m.now()
	meta := map[string]any{
		"hostname":      hostname,
		"os_user":       osUser,
		"teacher_note":  teacherNote,
		"display_name":  displayName,
		"operator":      operator,
		"ip":            ip,
		"app_version":   pickStr("app_version", ""),
		"active_files":  filesOut,
		"runtime_state": rtOut,
		"last_sync_at":  now.Format("2006-01-02 15:04:05"),
		"last_sync_ts":  now.Unix(),
	}
	if b, err := json.MarshalIndent(meta, "", "    "); err == nil {
		_ = os.WriteFile(metaPath, b, 0644)
	}
	return meta
}

// WriteChunk mirrors PHP sender_sync sync_mode=chunk tail-deduplicated file append.
func (m *Manager) WriteChunk(clientDir, dateStr, logType string, offset int64, content string) int64 {
	m.mu.Lock()
	defer m.mu.Unlock()

	if logType != "error" {
		logType = "sender"
	}
	_ = os.MkdirAll(clientDir, 0755)
	targetPath := filepath.Join(clientDir, logType+"_"+dateStr+".log")

	if content != "" {
		var curSize int64
		if info, err := os.Stat(targetPath); err == nil {
			curSize = info.Size()
		}
		if curSize == 0 {
			_ = os.WriteFile(targetPath, []byte(content), 0644)
		} else if offset == 0 {
			if curSize < int64(len(content)) {
				appendBytes(targetPath, []byte(content[curSize:]))
			}
		} else if curSize == offset {
			appendBytes(targetPath, []byte(content))
		} else if curSize >= offset && curSize < offset+int64(len(content)) {
			skip := curSize - offset
			appendBytes(targetPath, []byte(content[skip:]))
		} else if curSize < offset {
			appendBytes(targetPath, []byte(content))
		}
	}

	if info, err := os.Stat(targetPath); err == nil {
		return info.Size()
	}
	return 0
}

// AppendBatchSummary appends one JSON summary line to batches.jsonl.
func (m *Manager) AppendBatchSummary(clientDir string, summary map[string]any) {
	m.mu.Lock()
	defer m.mu.Unlock()
	_ = os.MkdirAll(clientDir, 0755)
	if b, err := json.Marshal(summary); err == nil {
		appendBytes(filepath.Join(clientDir, "batches.jsonl"), append(b, '\n'))
	}
}

// AppendLogText appends raw log lines to sender_<date>.log or error_<date>.log.
func (m *Manager) AppendLogText(clientDir, dateStr, logType, content string) {
	if content == "" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if logType != "error" {
		logType = "sender"
	}
	_ = os.MkdirAll(clientDir, 0755)
	appendBytes(filepath.Join(clientDir, logType+"_"+dateStr+".log"), []byte(content))
}

// SaveSnapshot stores title.png / annotated.png and meta.json under snapshots/<prefix>/.
func (m *Manager) SaveSnapshot(clientDir, safePrefix string, titleImg, annotatedImg []byte, meta map[string]any) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	snapDir := filepath.Join(clientDir, "snapshots", safePrefix)
	if err := os.MkdirAll(snapDir, 0755); err != nil {
		return err
	}
	if len(titleImg) > 0 {
		_ = os.WriteFile(filepath.Join(snapDir, "title.png"), titleImg, 0644)
	}
	if len(annotatedImg) > 0 {
		_ = os.WriteFile(filepath.Join(snapDir, "annotated.png"), annotatedImg, 0644)
	}
	if b, err := json.MarshalIndent(meta, "", "    "); err == nil {
		return os.WriteFile(filepath.Join(snapDir, "meta.json"), b, 0644)
	}
	return nil
}

// ListClients aggregates client cards across recent dates matching GET ?action=sender_clients.
func (m *Manager) ListClients(reqDate string) ([]string, []map[string]any) {
	base := m.baseDir()
	entries, err := os.ReadDir(base)
	availableDates := make([]string, 0)
	if err == nil {
		for _, e := range entries {
			if e.IsDir() && reISODate.MatchString(e.Name()) {
				availableDates = append(availableDates, e.Name())
			}
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(availableDates)))

	var targetDates []string
	if reqDate != "" && reISODate.MatchString(reqDate) {
		targetDates = []string{reqDate}
	} else {
		if len(availableDates) > 7 {
			targetDates = availableDates[:7]
		} else {
			targetDates = availableDates
		}
	}

	clients := make([]map[string]any, 0)
	for _, dStr := range targetDates {
		dPath := filepath.Join(base, dStr)
		cEntries, err := os.ReadDir(dPath)
		if err != nil {
			continue
		}
		for _, ce := range cEntries {
			if !ce.IsDir() {
				continue
			}
			cSlug := ce.Name()
			cDir := filepath.Join(dPath, cSlug)
			meta := map[string]any{}
			if raw, err := os.ReadFile(filepath.Join(cDir, "meta.json")); err == nil {
				_ = json.Unmarshal(raw, &meta)
			}

			var senderSize, errorSize int64
			if info, err := os.Stat(filepath.Join(cDir, "sender_"+dStr+".log")); err == nil {
				senderSize = info.Size()
			}
			if info, err := os.Stat(filepath.Join(cDir, "error_"+dStr+".log")); err == nil {
				errorSize = info.Size()
			}

			batches := readReversedJSONL(filepath.Join(cDir, "batches.jsonl"))
			snapshots := readSnapshots(filepath.Join(cDir, "snapshots"))

			lastSyncTS := int64(config.AsPHPInt(meta["last_sync_ts"]))
			if lastSyncTS == 0 {
				if info, err := os.Stat(cDir); err == nil {
					lastSyncTS = info.ModTime().Unix()
				}
			}

			displayName := config.AsPHPString(meta["display_name"])
			if displayName == "" {
				displayName = cSlug
			}
			hostname := config.AsPHPString(meta["hostname"])
			if hostname == "" {
				hostname = cSlug
			}
			activeFiles := meta["active_files"]
			if activeFiles == nil {
				activeFiles = []any{}
			}
			runtimeState, ok := meta["runtime_state"].(map[string]any)
			if !ok || runtimeState == nil {
				runtimeState = map[string]any{}
			}
			var ctrlSummary map[string]any
			if m.ctrl != nil {
				ctrlSummary = m.ctrl.SummarizeForAdmin(cSlug)
			}

			clients = append(clients, map[string]any{
				"date":               dStr,
				"client_slug":        cSlug,
				"display_name":       displayName,
				"teacher_note":       config.AsPHPString(meta["teacher_note"]),
				"hostname":           hostname,
				"os_user":            config.AsPHPString(meta["os_user"]),
				"ip":                 config.AsPHPString(meta["ip"]),
				"app_version":        config.AsPHPString(meta["app_version"]),
				"active_files":       activeFiles,
				"runtime_state":      runtimeState,
				"control_summary":    ctrlSummary,
				"last_sync_at":       config.AsPHPString(meta["last_sync_at"]),
				"last_sync_ts":       lastSyncTS,
				"has_sender_log":     senderSize > 0,
				"sender_log_size_kb": math.Round(float64(senderSize)/1024*100) / 100,
				"has_error_log":      errorSize > 0,
				"error_log_size_kb":  math.Round(float64(errorSize)/1024*100) / 100,
				"batches":            batches,
				"snapshots":          snapshots,
			})
		}
	}

	sort.Slice(clients, func(i, j int) bool {
		return clients[i]["last_sync_ts"].(int64) > clients[j]["last_sync_ts"].(int64)
	})
	return availableDates, clients
}

// LogFilePath resolves a safe log file path for GET ?action=sender_log_file.
func (m *Manager) LogFilePath(dateStr, clientSlug, logType string) (string, string, string, string) {
	d := SanitizeDate(dateStr, m.now())
	slug := SanitizeSlug(clientSlug)
	if logType != "error" {
		logType = "sender"
	}
	filename := logType + "_" + d + ".log"
	return filepath.Join(m.baseDir(), d, slug, filename), d, slug, filename
}

// SnapshotImagePath resolves a safe snapshot image path for GET ?action=sender_snapshot_img.
func (m *Manager) SnapshotImagePath(dateStr, clientSlug, rawPrefix, imgParam string) string {
	d := SanitizeDate(dateStr, m.now())
	slug := SanitizeSlug(clientSlug)
	prefix := SanitizePrefix(rawPrefix, m.now())
	imgName := "title.png"
	if imgParam == "annotated" {
		imgName = "annotated.png"
	}
	return filepath.Join(m.baseDir(), d, slug, "snapshots", prefix, imgName)
}

// CleanupOld removes date folders older than retentionDays.
func (m *Manager) CleanupOld(retentionDays int) {
	if retentionDays <= 0 {
		retentionDays = 30
	}
	cutoff := m.now().AddDate(0, 0, -retentionDays).Format("2006-01-02")
	entries, err := os.ReadDir(m.baseDir())
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() && reISODate.MatchString(e.Name()) && e.Name() < cutoff {
			_ = os.RemoveAll(filepath.Join(m.baseDir(), e.Name()))
		}
	}
}

func appendBytes(path string, data []byte) {
	if f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644); err == nil {
		_, _ = f.Write(data)
		_ = f.Close()
	}
}

func readReversedJSONL(path string) []map[string]any {
	raw, err := os.ReadFile(path)
	if err != nil {
		return []map[string]any{}
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	out := make([]map[string]any, 0, len(lines))
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		var obj map[string]any
		if json.Unmarshal([]byte(line), &obj) == nil && obj != nil {
			out = append(out, obj)
		}
	}
	return out
}

func readSnapshots(snapsRoot string) []map[string]any {
	entries, err := os.ReadDir(snapsRoot)
	if err != nil {
		return []map[string]any{}
	}
	type snapDirInfo struct {
		name    string
		path    string
		modTime int64
	}
	dirs := make([]snapDirInfo, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		p := filepath.Join(snapsRoot, e.Name())
		var mt int64
		if info, err := e.Info(); err == nil {
			mt = info.ModTime().UnixNano()
		}
		dirs = append(dirs, snapDirInfo{name: e.Name(), path: p, modTime: mt})
	}
	sort.Slice(dirs, func(i, j int) bool { return dirs[i].modTime > dirs[j].modTime })
	if len(dirs) > 50 {
		dirs = dirs[:50]
	}

	out := make([]map[string]any, 0, len(dirs))
	for _, d := range dirs {
		sMeta := map[string]any{}
		if raw, err := os.ReadFile(filepath.Join(d.path, "meta.json")); err == nil {
			_ = json.Unmarshal(raw, &sMeta)
		}
		diagInfo, _ := sMeta["diag_info"].(map[string]any)
		judgment, _ := diagInfo["judgment"].(map[string]any)
		reason := config.AsPHPString(judgment["reason"])
		if reason == "" {
			reason = config.AsPHPString(diagInfo["reason"])
		}
		ts := config.AsPHPString(sMeta["timestamp"])
		if ts == "" {
			ts = d.name
		}
		cand := config.AsPHPInt(sMeta["candidate"])
		if cand == 0 {
			cand = 1
		}
		_, errTitle := os.Stat(filepath.Join(d.path, "title.png"))
		_, errAnn := os.Stat(filepath.Join(d.path, "annotated.png"))
		out = append(out, map[string]any{
			"prefix":         d.name,
			"timestamp":      ts,
			"saved_at":       config.AsPHPString(sMeta["saved_at"]),
			"target_id":      config.AsPHPString(sMeta["target_id"]),
			"target_name":    config.AsPHPString(sMeta["target_name"]),
			"candidate":      cand,
			"matched":        config.AsPHPBool(judgment["matched"]),
			"is_group":       config.AsPHPBool(judgment["is_group"]),
			"detected_title": config.AsPHPString(judgment["detected_title"]),
			"reason":         reason,
			"has_title":      errTitle == nil,
			"has_annotated":  errAnn == nil,
		})
	}
	return out
}
