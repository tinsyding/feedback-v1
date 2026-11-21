package senderlogs

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
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
	"feedback-api/internal/textutil"
	"feedback-api/internal/tz"
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
	mu           sync.RWMutex
	nowFunc      func() time.Time
}

// NewManager creates a senderlogs.Manager.
func NewManager(feedbackRoot string, ctrl *senderctrl.Store) *Manager {
	return &Manager{
		feedbackRoot: strings.TrimSpace(feedbackRoot),
		ctrl:         ctrl,
		nowFunc:      tz.Now,
	}
}

func (m *Manager) now() time.Time {
	if m != nil && m.nowFunc != nil {
		return tz.In(m.nowFunc())
	}
	return tz.Now()
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
	return tz.In(now).Format("2006-01-02")
}

// SanitizePrefix safely cleans snapshot directory prefixes (prevents path traversal).
func SanitizePrefix(raw string, now time.Time) string {
	base := filepath.Base(strings.TrimSpace(raw))
	clean := reSafePrefix.ReplaceAllString(base, "_")
	clean = strings.Trim(clean, "_")
	if clean == "" || clean == "." || clean == ".." {
		return tz.In(now).Format("20060102_150405")
	}
	return textutil.TruncateRunes(clean, 120)
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
	operator := hostname + "(" + osUser + ")"
	if teacherNote != "" {
		operator = teacherNote + "@" + hostname
	}
	operator = textutil.TruncateRunes(operator, 50)

	mergedFiles := make([]string, 0)
	seenFiles := make(map[string]struct{})
	appendFile := func(raw any) {
		if raw == nil {
			return
		}
		s := config.AsPHPString(raw)
		if _, exists := seenFiles[s]; exists {
			return
		}
		seenFiles[s] = struct{}{}
		mergedFiles = append(mergedFiles, s)
	}
	if prevFiles, ok := existing["active_files"].([]any); ok {
		for _, f := range prevFiles {
			appendFile(f)
		}
	}
	if len(activeFiles) > 0 {
		for _, f := range activeFiles {
			appendFile(f)
		}
	}
	if len(mergedFiles) > 20 {
		mergedFiles = mergedFiles[len(mergedFiles)-20:]
	}

	now := m.now()
	rtOut := map[string]any{}
	if prevRT, ok := existing["runtime_state"].(map[string]any); ok && prevRT != nil {
		for k, v := range prevRT {
			rtOut[k] = v
		}
	}
	if runtimeState != nil {
		processed := config.AsPHPInt(runtimeState["processed"])
		if processed < 0 {
			processed = 0
		}
		total := config.AsPHPInt(runtimeState["total"])
		if total < 0 {
			total = 0
		}
		polVer := config.AsPHPInt(runtimeState["policy_version"])
		if polVer < 0 {
			polVer = 0
		}
		rtOut = map[string]any{
			"running":        config.AsPHPBool(runtimeState["running"]),
			"processed":      processed,
			"total":          total,
			"current_name":   textutil.TruncateRunes(strings.TrimSpace(config.AsPHPString(runtimeState["current_name"])), 60),
			"verify_mode":    textutil.TruncateRunes(strings.TrimSpace(config.AsPHPString(runtimeState["verify_mode"])), 20),
			"policy_version": polVer,
			"updated_at":     now.Format("2006-01-02 15:04:05"),
		}
	}

	meta := make(map[string]any, len(existing)+14)
	for k, v := range existing {
		meta[k] = v
	}
	meta["client_id"] = pickStr("client_id", "")
	meta["client_slug"] = filepath.Base(clientDir)
	meta["hostname"] = hostname
	meta["os_user"] = osUser
	meta["teacher_note"] = teacherNote
	meta["display_name"] = displayName
	meta["operator"] = operator
	meta["platform"] = pickStr("platform", "")
	meta["app_version"] = pickStr("app_version", "")
	meta["ip"] = ip
	meta["active_files"] = mergedFiles
	meta["runtime_state"] = rtOut
	meta["last_sync_at"] = now.Format("2006-01-02 15:04:05")
	meta["last_sync_ts"] = now.Unix()

	if b, err := json.MarshalIndent(meta, "", "    "); err == nil {
		_ = writeFileAtomic(metaPath, b, 0o644)
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
	m.mu.RLock()
	defer m.mu.RUnlock()

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

// ReadSnapshotImage reads a snapshot image under m.mu.RLock().
func (m *Manager) ReadSnapshotImage(dateStr, clientSlug, rawPrefix, imgParam string) ([]byte, error) {
	imgPath := m.SnapshotImagePath(dateStr, clientSlug, rawPrefix, imgParam)
	m.mu.RLock()
	defer m.mu.RUnlock()
	return os.ReadFile(imgPath)
}

// StreamLogFile opens a log file under m.mu.RLock() and invokes fn with the open file and its size.
func (m *Manager) StreamLogFile(dateStr, clientSlug, logType string, fn func(f *os.File, size int64) error) (string, string, string, error) {
	filePath, d, slug, filename := m.LogFilePath(dateStr, clientSlug, logType)
	m.mu.RLock()
	defer m.mu.RUnlock()
	f, err := os.Open(filePath)
	if err != nil {
		return d, slug, filename, err
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil {
		return d, slug, filename, err
	}
	if err := fn(f, info.Size()); err != nil {
		return d, slug, filename, err
	}
	return d, slug, filename, nil
}

// ReadLogFileTail streams a log file under m.mu.RLock() using an O(maxLines) ring buffer,
// returning exact total line count, file size, and the trailing maxLines lines without full-file buffering.
func (m *Manager) ReadLogFileTail(dateStr, clientSlug, logType string, maxLines int) (string, string, string, string, int, int64, error) {
	if maxLines <= 0 {
		maxLines = 2000
	}
	filePath, d, slug, filename := m.LogFilePath(dateStr, clientSlug, logType)
	m.mu.RLock()
	defer m.mu.RUnlock()

	f, err := os.Open(filePath)
	if err != nil {
		return d, slug, filename, "", 0, 0, err
	}
	defer func() { _ = f.Close() }()

	info, err := f.Stat()
	if err != nil {
		return d, slug, filename, "", 0, 0, err
	}
	sizeBytes := info.Size()
	if sizeBytes == 0 {
		return d, slug, filename, "", 0, 0, nil
	}

	ring := make([]string, maxLines)
	totalLines := 0
	br := bufio.NewReaderSize(f, 64*1024)
	for {
		line, readErr := br.ReadString('\n')
		if len(line) > 0 {
			line = strings.TrimSuffix(line, "\n")
			line = strings.TrimSuffix(line, "\r")
			ring[totalLines%maxLines] = line
			totalLines++
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			return d, slug, filename, "", 0, sizeBytes, readErr
		}
	}

	var out []string
	if totalLines <= maxLines {
		out = ring[:totalLines]
	} else {
		start := totalLines % maxLines
		out = make([]string, 0, maxLines)
		out = append(out, ring[start:]...)
		out = append(out, ring[:start]...)
	}
	return d, slug, filename, strings.Join(out, "\n"), totalLines, sizeBytes, nil
}

// CleanupOld removes date folders older than retentionDays under m.mu.Lock().
func (m *Manager) CleanupOld(retentionDays int) {
	if retentionDays <= 0 {
		retentionDays = 30
	}
	cutoff := m.now().AddDate(0, 0, -retentionDays).Format("2006-01-02")
	m.mu.Lock()
	defer m.mu.Unlock()
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

func writeFileAtomic(targetPath string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(targetPath)
	f, err := os.CreateTemp(dir, ".meta-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := f.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	_ = os.Chmod(tmpPath, perm)
	if err := os.Rename(tmpPath, targetPath); err != nil {
		return err
	}
	cleanup = false
	return nil
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
