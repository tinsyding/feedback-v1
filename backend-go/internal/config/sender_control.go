package config

import (
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// SenderControlPolicy mirrors the global Tier 1 policy returned by normalizeGlobalSenderControl in sender_control_helper.php.
type SenderControlPolicy struct {
	PolicyVersion         int     `json:"policyVersion"`
	SenderServiceEnabled  bool    `json:"senderServiceEnabled"`
	EnableAutoCalibration bool    `json:"enableAutoCalibration"`
	VerifyMode            string  `json:"verifyMode"`
	EnableReplyAnalysis   bool    `json:"enableReplyAnalysis"`
	EnableBenchmarkModel  bool    `json:"enableBenchmarkModel"`
	SnapshotPolicy        string  `json:"snapshotPolicy"`
	MinSenderVersion      string  `json:"minSenderVersion"`
	MinVersionAction      string  `json:"minVersionAction"`
	UpdateURL             string  `json:"updateUrl"`
	NoticeMessage         string  `json:"noticeMessage"`
	SearchWait            float64 `json:"searchWait"`
	EnterWait             float64 `json:"enterWait"`
	StudentGapMin         float64 `json:"studentGapMin"`
	StudentGapMax         float64 `json:"studentGapMax"`
	BatchBreakEvery       int     `json:"batchBreakEvery"`
	BatchBreakMin         float64 `json:"batchBreakMin"`
	BatchBreakMax         float64 `json:"batchBreakMax"`
	UpdatedAt             string  `json:"updatedAt"`
}

var (
	reControlVersion = regexp.MustCompile(`^\d+(?:\.\d+){0,3}(?:[-+][A-Za-z0-9._-]+)?$`)
	reHTTPURL        = regexp.MustCompile(`(?i)^https?://`)
)

// DefaultSenderControlPolicy mirrors getDefaultSenderControlPolicy() in sender_control_helper.php.
func DefaultSenderControlPolicy() SenderControlPolicy {
	return SenderControlPolicy{
		PolicyVersion:         1,
		SenderServiceEnabled:  true,
		EnableAutoCalibration: true,
		VerifyMode:            "auto",
		EnableReplyAnalysis:   true,
		EnableBenchmarkModel:  true,
		SnapshotPolicy:        "errors_only",
		MinSenderVersion:      "",
		MinVersionAction:      "block",
		UpdateURL:             "",
		NoticeMessage:         "",
		SearchWait:            1.5,
		EnterWait:             1.2,
		StudentGapMin:         0.5,
		StudentGapMax:         1.0,
		BatchBreakEvery:       15,
		BatchBreakMin:         2.0,
		BatchBreakMax:         3.0,
		UpdatedAt:             "",
	}
}

// NormalizeGlobalSenderControl ports normalizeGlobalSenderControl() from sender_control_helper.php lines 24-144 verbatim.
func NormalizeGlobalSenderControl(raw map[string]any, rootConfig map[string]any) SenderControlPolicy {
	defaults := DefaultSenderControlPolicy()
	out := defaults

	if raw == nil {
		raw = map[string]any{}
	}
	if rootConfig == nil {
		rootConfig = map[string]any{}
	}

	if pv, ok := raw["policyVersion"]; ok && pv != nil {
		v := AsPHPInt(pv)
		if v < 1 {
			v = 1
		}
		out.PolicyVersion = v
	} else {
		out.PolicyVersion = 1
	}

	if v, ok := raw["senderServiceEnabled"]; ok {
		out.SenderServiceEnabled = AsPHPBool(v)
	}
	if v, ok := raw["enableAutoCalibration"]; ok {
		out.EnableAutoCalibration = AsPHPBool(v)
	}

	verifyMode := strings.ToLower(strings.TrimSpace(AsPHPString(raw["verifyMode"])))
	switch verifyMode {
	case "auto", "local", "api":
		out.VerifyMode = verifyMode
	default:
		if AsPHPBool(rootConfig["disableQwenFlashTitle"]) {
			out.VerifyMode = "local"
		} else {
			out.VerifyMode = "auto"
		}
	}

	if v, ok := raw["enableReplyAnalysis"]; ok {
		out.EnableReplyAnalysis = AsPHPBool(v)
	}
	if v, ok := raw["enableBenchmarkModel"]; ok {
		out.EnableBenchmarkModel = AsPHPBool(v)
	}

	snap := strings.ToLower(strings.TrimSpace(stringOrDefault(raw["snapshotPolicy"], defaults.SnapshotPolicy)))
	switch snap {
	case "errors_only", "always", "off":
		out.SnapshotPolicy = snap
	default:
		out.SnapshotPolicy = defaults.SnapshotPolicy
	}

	out.MinSenderVersion = sanitizeControlVersion(AsPHPString(raw["minSenderVersion"]))
	verAct := strings.ToLower(strings.TrimSpace(stringOrDefault(raw["minVersionAction"], defaults.MinVersionAction)))
	switch verAct {
	case "block", "warn":
		out.MinVersionAction = verAct
	default:
		out.MinVersionAction = defaults.MinVersionAction
	}

	out.UpdateURL = sanitizeControlURL(AsPHPString(raw["updateUrl"]))
	out.NoticeMessage = clipBytes(strings.TrimSpace(AsPHPString(raw["noticeMessage"])), 500)

	out.SearchWait = clampFloat(raw["searchWait"], 0.4, 8.0, defaults.SearchWait)
	out.EnterWait = clampFloat(raw["enterWait"], 0.4, 8.0, defaults.EnterWait)

	gapMin := clampFloat(raw["studentGapMin"], 0.0, 30.0, defaults.StudentGapMin)
	gapMax := clampFloat(raw["studentGapMax"], 0.0, 30.0, defaults.StudentGapMax)
	if gapMax < gapMin {
		gapMax = gapMin
	}
	out.StudentGapMin = gapMin
	out.StudentGapMax = gapMax

	out.BatchBreakEvery = clampInt(raw["batchBreakEvery"], 1, 200, defaults.BatchBreakEvery)
	brkMin := clampFloat(raw["batchBreakMin"], 0.0, 60.0, defaults.BatchBreakMin)
	brkMax := clampFloat(raw["batchBreakMax"], 0.0, 60.0, defaults.BatchBreakMax)
	if brkMax < brkMin {
		brkMax = brkMin
	}
	out.BatchBreakMin = brkMin
	out.BatchBreakMax = brkMax

	out.UpdatedAt = strings.TrimSpace(AsPHPString(raw["updatedAt"]))
	return out
}

func stringOrDefault(v any, def string) string {
	if v == nil {
		return def
	}
	return AsPHPString(v)
}

func isPHPNumeric(v any) (float64, bool) {
	if v == nil {
		return 0, false
	}
	switch x := v.(type) {
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return 0, false
		}
		return x, true
	case json.Number:
		f, err := x.Float64()
		if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
			return 0, false
		}
		return f, true
	case string:
		s := strings.TrimSpace(x)
		if s == "" {
			return 0, false
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
			return 0, false
		}
		return f, true
	default:
		return 0, false
	}
}

func clampFloat(val any, minVal, maxVal, def float64) float64 {
	f, ok := isPHPNumeric(val)
	if !ok {
		return def
	}
	f = math.Round(f*100) / 100
	if f == 0 {
		f = 0
	}
	if f < minVal {
		return minVal
	}
	if f > maxVal {
		return maxVal
	}
	return f
}

func clampInt(val any, minVal, maxVal, def int) int {
	f, ok := isPHPNumeric(val)
	if !ok {
		return def
	}
	var i int
	if s, isStr := val.(string); isStr {
		i = parsePHPLeadingInt(s)
	} else {
		i = int(f)
	}
	if i < minVal {
		return minVal
	}
	if i > maxVal {
		return maxVal
	}
	return i
}

func sanitizeControlVersion(ver string) string {
	ver = strings.TrimSpace(ver)
	ver = strings.TrimPrefix(ver, "v")
	ver = strings.TrimPrefix(ver, "V")
	if ver == "" || !reControlVersion.MatchString(ver) {
		return ""
	}
	return clipBytes(ver, 32)
}

func sanitizeControlURL(urlStr string) string {
	urlStr = strings.TrimSpace(urlStr)
	if urlStr == "" || !reHTTPURL.MatchString(urlStr) {
		return ""
	}
	return clipBytes(urlStr, 500)
}

func clipBytes(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}
