package senderctrl

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"feedback-api/internal/config"
	"feedback-api/internal/textutil"
	"feedback-api/internal/tz"
)

var (
	reNonSlugChar = regexp.MustCompile(`[^a-zA-Z0-9_-]`)
	validVerify   = map[string]struct{}{"auto": {}, "local": {}, "api": {}}
	validSnapshot = map[string]struct{}{"errors_only": {}, "always": {}, "off": {}}
	validCmdTypes = map[string]struct{}{
		"stop_batch":     {},
		"refresh_policy": {},
		"clear_roi":      {},
		"sync_logs":      {},
	}
)

// RemoteCommand represents an admin-issued command queued for a sender client.
type RemoteCommand struct {
	CmdID       string         `json:"cmd_id"`
	Type        string         `json:"type"`
	Params      map[string]any `json:"params"`
	CreatedAt   string         `json:"created_at"`
	CreatedTS   int64          `json:"created_ts"`
	CreatedBy   string         `json:"created_by"`
	DeliveredAt string         `json:"delivered_at"`
	AckedAt     string         `json:"acked_at"`
	AckStatus   string         `json:"ack_status"`
	AckMessage  string         `json:"ack_message"`
}

// ClientState represents data/sender_control/clients/<slug>.json.
type ClientState struct {
	ClientSlug string          `json:"client_slug"`
	Overrides  map[string]any  `json:"overrides"`
	Note       string          `json:"note"`
	UpdatedAt  string          `json:"updated_at"`
	Commands   []RemoteCommand `json:"commands"`
}

// Store manages per-client sender control overrides and remote command queues on disk.
type Store struct {
	feedbackRoot string
	cfgLoader    *config.Loader
	mu           sync.Mutex
	nowFunc      func() time.Time
}

// NewStore creates a senderctrl.Store rooted at feedbackRoot.
func NewStore(feedbackRoot string, cfgLoader *config.Loader) *Store {
	return &Store{
		feedbackRoot: strings.TrimSpace(feedbackRoot),
		cfgLoader:    cfgLoader,
		nowFunc:      tz.Now,
	}
}

func (s *Store) now() time.Time {
	if s != nil && s.nowFunc != nil {
		return tz.In(s.nowFunc())
	}
	return tz.Now()
}

// SanitizeSlug mirrors PHP sanitizeControlSlug().
func SanitizeSlug(slug string) string {
	clean := reNonSlugChar.ReplaceAllString(strings.TrimSpace(slug), "_")
	clean = strings.Trim(clean, "_")
	if clean == "" {
		return "unknown_pc"
	}
	if len(clean) > 64 {
		return clean[:64]
	}
	return clean
}

func (s *Store) storageDir() string {
	return filepath.Join(s.feedbackRoot, "data", "sender_control", "clients")
}

func (s *Store) clientFilePath(slug string) string {
	return filepath.Join(s.storageDir(), SanitizeSlug(slug)+".json")
}

func clampFloat(raw any, minVal, maxVal, def float64) (float64, bool) {
	if raw == nil {
		return def, false
	}
	var f float64
	switch x := raw.(type) {
	case float64:
		f = x
	case int:
		f = float64(x)
	case int64:
		f = float64(x)
	case json.Number:
		v, err := x.Float64()
		if err != nil {
			return def, false
		}
		f = v
	case string:
		str := strings.TrimSpace(x)
		if str == "" {
			return def, false
		}
		v, err := strconv.ParseFloat(str, 64)
		if err != nil {
			return def, false
		}
		f = v
	default:
		return def, false
	}
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return def, false
	}
	if f < minVal {
		f = minVal
	}
	if f > maxVal {
		f = maxVal
	}
	return math.Round(f*100) / 100, true
}

func clampInt(raw any, minVal, maxVal, def int) (int, bool) {
	f, ok := clampFloat(raw, float64(minVal), float64(maxVal), float64(def))
	if !ok {
		return def, false
	}
	v := int(f)
	if v < minVal {
		v = minVal
	}
	if v > maxVal {
		v = maxVal
	}
	return v, true
}

func nonEmptyScalar(v any) bool {
	if v == nil {
		return false
	}
	if s, ok := v.(string); ok && s == "" {
		return false
	}
	return true
}

// NormalizeOverrides mirrors PHP normalizeClientOverrides().
func NormalizeOverrides(raw map[string]any) map[string]any {
	out := make(map[string]any)
	if len(raw) == 0 {
		return out
	}
	for _, boolKey := range []string{
		"senderServiceEnabled",
		"enableAutoCalibration",
		"enableReplyAnalysis",
		"enableBenchmarkModel",
	} {
		if v, exists := raw[boolKey]; exists && nonEmptyScalar(v) {
			out[boolKey] = config.AsPHPBool(v)
		}
	}
	if v, exists := raw["verifyMode"]; exists && v != nil {
		vm := strings.ToLower(strings.TrimSpace(config.AsPHPString(v)))
		if _, ok := validVerify[vm]; ok {
			out["verifyMode"] = vm
		}
	}
	if v, exists := raw["snapshotPolicy"]; exists && v != nil {
		sp := strings.ToLower(strings.TrimSpace(config.AsPHPString(v)))
		if _, ok := validSnapshot[sp]; ok {
			out["snapshotPolicy"] = sp
		}
	}
	if v, exists := raw["searchWait"]; exists {
		if f, ok := clampFloat(v, 0.4, 8.0, 1.5); ok {
			out["searchWait"] = f
		}
	}
	if v, exists := raw["enterWait"]; exists {
		if f, ok := clampFloat(v, 0.4, 8.0, 1.2); ok {
			out["enterWait"] = f
		}
	}
	if v, exists := raw["studentGapMin"]; exists {
		if f, ok := clampFloat(v, 0.0, 30.0, 0.5); ok {
			out["studentGapMin"] = f
		}
	}
	if v, exists := raw["studentGapMax"]; exists {
		if f, ok := clampFloat(v, 0.0, 30.0, 1.0); ok {
			out["studentGapMax"] = f
		}
	}
	if gMin, ok1 := out["studentGapMin"].(float64); ok1 {
		if gMax, ok2 := out["studentGapMax"].(float64); ok2 && gMax < gMin {
			out["studentGapMax"] = gMin
		}
	}
	if v, exists := raw["batchBreakEvery"]; exists {
		if n, ok := clampInt(v, 1, 200, 15); ok {
			out["batchBreakEvery"] = n
		}
	}
	if v, exists := raw["batchBreakMin"]; exists {
		if f, ok := clampFloat(v, 0.0, 60.0, 2.0); ok {
			out["batchBreakMin"] = f
		}
	}
	if v, exists := raw["batchBreakMax"]; exists {
		if f, ok := clampFloat(v, 0.0, 60.0, 3.0); ok {
			out["batchBreakMax"] = f
		}
	}
	if bMin, ok1 := out["batchBreakMin"].(float64); ok1 {
		if bMax, ok2 := out["batchBreakMax"].(float64); ok2 && bMax < bMin {
			out["batchBreakMax"] = bMin
		}
	}
	if v, exists := raw["noticeMessage"]; exists && v != nil {
		nm := textutil.TruncateRunes(strings.TrimSpace(config.AsPHPString(v)), 500)
		if nm != "" {
			out["noticeMessage"] = nm
		}
	}
	return out
}

func (s *Store) loadLocked(slug string) ClientState {
	cleanSlug := SanitizeSlug(slug)
	empty := ClientState{
		ClientSlug: cleanSlug,
		Overrides:  map[string]any{},
		Commands:   []RemoteCommand{},
	}
	raw, err := os.ReadFile(s.clientFilePath(cleanSlug))
	if err != nil {
		return empty
	}
	var st ClientState
	if err := json.Unmarshal(raw, &st); err != nil {
		return empty
	}
	st.ClientSlug = cleanSlug
	st.Overrides = NormalizeOverrides(st.Overrides)
	st.Note = textutil.TruncateRunes(strings.TrimSpace(st.Note), 200)
	if st.Commands == nil {
		st.Commands = []RemoteCommand{}
	}
	for i := range st.Commands {
		if st.Commands[i].Params == nil {
			st.Commands[i].Params = map[string]any{}
		}
	}
	return st
}

func (s *Store) saveLocked(st ClientState) error {
	dir := s.storageDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	st.ClientSlug = SanitizeSlug(st.ClientSlug)
	st.Overrides = NormalizeOverrides(st.Overrides)
	st.Note = textutil.TruncateRunes(st.Note, 200)
	if len(st.Commands) > 30 {
		st.Commands = st.Commands[len(st.Commands)-30:]
	}
	if st.Commands == nil {
		st.Commands = []RemoteCommand{}
	}
	data, err := json.MarshalIndent(st, "", "    ")
	if err != nil {
		return err
	}
	target := s.clientFilePath(st.ClientSlug)
	tmp, err := os.CreateTemp(dir, ".ctrl-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	_ = os.Chmod(tmpPath, 0644)
	if err := os.Rename(tmpPath, target); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}

// LoadClientState returns the normalized per-client control state.
func (s *Store) LoadClientState(slug string) ClientState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked(slug)
}

// SetOverrides updates per-client overrides and note.
func (s *Store) SetOverrides(slug string, overrides map[string]any, note string) ClientState {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.loadLocked(slug)
	st.Overrides = NormalizeOverrides(overrides)
	st.Note = textutil.TruncateRunes(strings.TrimSpace(note), 200)
	st.UpdatedAt = s.now().Format("2006-01-02 15:04:05")
	_ = s.saveLocked(st)
	return st
}

// EnqueueCommand queues a remote command for a sender client (deduplicating unacked commands of the same type).
// Returns nil if cmdType is unsupported.
func (s *Store) EnqueueCommand(slug, cmdType string, params map[string]any, operator string) *RemoteCommand {
	t := strings.ToLower(strings.TrimSpace(cmdType))
	if _, ok := validCmdTypes[t]; !ok {
		return nil
	}
	if params == nil {
		params = map[string]any{}
	}
	op := strings.TrimSpace(operator)
	if op == "" {
		op = "admin"
	}
	op = textutil.TruncateRunes(op, 60)
	var rb [4]byte
	_, _ = rand.Read(rb[:])
	now := s.now()
	cmd := RemoteCommand{
		CmdID:     "cmd_" + now.Format("20060102150405") + "_" + hex.EncodeToString(rb[:]),
		Type:      t,
		Params:    params,
		CreatedAt: now.Format("2006-01-02 15:04:05"),
		CreatedTS: now.Unix(),
		CreatedBy: op,
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.loadLocked(slug)
	filtered := make([]RemoteCommand, 0, len(st.Commands)+1)
	for _, existing := range st.Commands {
		if existing.Type == t && existing.AckedAt == "" {
			continue
		}
		filtered = append(filtered, existing)
	}
	filtered = append(filtered, cmd)
	if len(filtered) > 30 {
		filtered = filtered[len(filtered)-30:]
	}
	st.Commands = filtered
	st.UpdatedAt = now.Format("2006-01-02 15:04:05")
	_ = s.saveLocked(st)
	return &cmd
}

// AcknowledgeCommands marks commands acknowledged by the sender client.
func (s *Store) AcknowledgeCommands(slug string, acks []any) int {
	if len(acks) == 0 {
		return 0
	}
	type ackInfo struct {
		status  string
		message string
	}
	ackMap := make(map[string]ackInfo)
	for _, item := range acks {
		switch x := item.(type) {
		case string:
			cid := strings.TrimSpace(x)
			if cid != "" {
				ackMap[cid] = ackInfo{status: "ok"}
			}
		case map[string]any:
			cid := strings.TrimSpace(config.AsPHPString(x["cmd_id"]))
			if cid != "" {
				st := strings.TrimSpace(config.AsPHPString(x["status"]))
				if st == "" {
					st = "ok"
				}
				st = textutil.TruncateRunes(st, 30)
				msg := textutil.TruncateRunes(strings.TrimSpace(config.AsPHPString(x["message"])), 300)
				ackMap[cid] = ackInfo{status: st, message: msg}
			}
		}
	}
	if len(ackMap) == 0 {
		return 0
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.loadLocked(slug)
	nowStr := s.now().Format("2006-01-02 15:04:05")
	changed := 0
	for i := range st.Commands {
		cid := st.Commands[i].CmdID
		if info, ok := ackMap[cid]; ok && st.Commands[i].AckedAt == "" {
			st.Commands[i].AckedAt = nowStr
			if st.Commands[i].DeliveredAt == "" {
				st.Commands[i].DeliveredAt = nowStr
			}
			st.Commands[i].AckStatus = info.status
			st.Commands[i].AckMessage = info.message
			changed++
		}
	}
	if changed > 0 {
		_ = s.saveLocked(st)
	}
	return changed
}

// GlobalPolicy returns the normalized global senderControl policy from config.json.
func (s *Store) GlobalPolicy() config.SenderControlPolicy {
	if s != nil && s.cfgLoader != nil {
		return s.cfgLoader.Load().SenderControl()
	}
	return config.DefaultSenderControlPolicy()
}

// BuildEffectiveControl merges global policy + per-client overrides + pending commands.
func (s *Store) BuildEffectiveControl(slug string, markDelivered bool) map[string]any {
	global := s.GlobalPolicy()
	effective := global

	s.mu.Lock()
	st := s.loadLocked(slug)
	overrides := st.Overrides

	if v, ok := overrides["senderServiceEnabled"].(bool); ok {
		effective.SenderServiceEnabled = v
	}
	if v, ok := overrides["enableAutoCalibration"].(bool); ok {
		effective.EnableAutoCalibration = v
	}
	if v, ok := overrides["verifyMode"].(string); ok {
		effective.VerifyMode = v
	}
	if v, ok := overrides["enableReplyAnalysis"].(bool); ok {
		effective.EnableReplyAnalysis = v
	}
	if v, ok := overrides["enableBenchmarkModel"].(bool); ok {
		effective.EnableBenchmarkModel = v
	}
	if v, ok := overrides["snapshotPolicy"].(string); ok {
		effective.SnapshotPolicy = v
	}
	if v, ok := overrides["searchWait"].(float64); ok {
		effective.SearchWait = v
	}
	if v, ok := overrides["enterWait"].(float64); ok {
		effective.EnterWait = v
	}
	if v, ok := overrides["studentGapMin"].(float64); ok {
		effective.StudentGapMin = v
	}
	if v, ok := overrides["studentGapMax"].(float64); ok {
		effective.StudentGapMax = v
	}
	if effective.StudentGapMax < effective.StudentGapMin {
		effective.StudentGapMax = effective.StudentGapMin
	}
	if v, ok := overrides["batchBreakEvery"].(int); ok {
		effective.BatchBreakEvery = v
	}
	if v, ok := overrides["batchBreakMin"].(float64); ok {
		effective.BatchBreakMin = v
	}
	if v, ok := overrides["batchBreakMax"].(float64); ok {
		effective.BatchBreakMax = v
	}
	if effective.BatchBreakMax < effective.BatchBreakMin {
		effective.BatchBreakMax = effective.BatchBreakMin
	}
	if v, ok := overrides["noticeMessage"].(string); ok {
		globalNotice := strings.TrimSpace(global.NoticeMessage)
		clientNotice := strings.TrimSpace(v)
		if clientNotice != "" && globalNotice != "" && clientNotice != globalNotice {
			effective.NoticeMessage = "[定向通知] " + clientNotice + "\n[全员公告] " + globalNotice
		} else if clientNotice != "" {
			effective.NoticeMessage = clientNotice
		}
	}

	now := s.now()
	nowTs := now.Unix()
	nowStr := now.Format("2006-01-02 15:04:05")
	pending := make([]map[string]any, 0)
	dirty := false
	for i := range st.Commands {
		cmd := &st.Commands[i]
		if cmd.AckedAt != "" {
			continue
		}
		if cmd.CreatedTS > 0 && (nowTs-cmd.CreatedTS) > 86400 {
			cmd.AckedAt = nowStr
			cmd.AckStatus = "expired"
			cmd.AckMessage = "指令超过24小时未上线，已自动失效"
			dirty = true
			continue
		}
		if markDelivered && cmd.DeliveredAt == "" {
			cmd.DeliveredAt = nowStr
			dirty = true
		}
		params := cmd.Params
		if params == nil {
			params = map[string]any{}
		}
		pending = append(pending, map[string]any{
			"cmd_id":     cmd.CmdID,
			"type":       cmd.Type,
			"params":     params,
			"created_at": cmd.CreatedAt,
			"created_by": cmd.CreatedBy,
		})
	}
	if dirty {
		_ = s.saveLocked(st)
	}
	s.mu.Unlock()

	return map[string]any{
		"client_slug":          st.ClientSlug,
		"global_version":       global.PolicyVersion,
		"has_client_override":  len(overrides) > 0,
		"client_overrides":     overrides,
		"client_override_note": st.Note,
		"effective_policy":     effective,
		"pending_commands":     pending,
		"server_time":          nowStr,
	}
}

// SummarizeForAdmin mirrors PHP summarizeClientControlForAdmin().
func (s *Store) SummarizeForAdmin(slug string) map[string]any {
	st := s.LoadClientState(slug)
	pendingCount := 0
	for _, c := range st.Commands {
		if c.AckedAt == "" {
			pendingCount++
		}
	}
	recent := make([]RemoteCommand, 0, 8)
	for i := len(st.Commands) - 1; i >= 0 && len(recent) < 8; i-- {
		recent = append(recent, st.Commands[i])
	}
	return map[string]any{
		"has_override":           len(st.Overrides) > 0,
		"overrides":              st.Overrides,
		"override_note":          st.Note,
		"updated_at":             st.UpdatedAt,
		"pending_commands_count": pendingCount,
		"recent_commands":        recent,
	}
}
