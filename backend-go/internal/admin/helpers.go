package admin

import (
	"encoding/json"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"feedback-api/internal/config"
)

// HiddenTables lists system infrastructure tables forbidden from generic admin CRUD / metadata endpoints.
// Mirrors PHP ADMIN_HIDDEN_TABLES in feedback-v1/api/admin/helpers.php.
var HiddenTables = map[string]struct{}{
	"app_sessions":      {},
	"auth_rate_limits":  {},
	"schema_migrations": {},
}

// FriendlyTableNames mirrors $friendlyNames in feedback-v1/api/admin/actions_tables.php.
var FriendlyTableNames = map[string]string{
	"users":                  "前台教师账号",
	"student_records":        "学生学情错题",
	"student_record_history": "学情历史版本",
	"generation_batches":     "学情生成批次",
	"class_batches":          "班级教学期次",
	"retest_access_logs":     "重测查阅日志",
	"retest_revoked_tokens":  "错题本吊销黑名单",
	"qbank_weeks":            "题库专题期次",
	"qbank_questions":        "题库题目与考点",
	"admin_users":            "系统管理员表",
	"system_logs":            "系统运行日志",
}

var (
	reValidIdent        = regexp.MustCompile(`^[a-zA-Z0-9_]+$`)
	reErrNumSplit       = regexp.MustCompile(`[,、，\s]+`)
	reTokenQueryParam   = regexp.MustCompile(`(?i)[?&]token=([^&#\s]+)`)
	reGradeSubjectTail  = regexp.MustCompile(`(化学|物理|数学|英语|语文)$`)
	reGradeClassTail    = regexp.MustCompile(`(班|层)$`)
	reTrailingTopicPunc = regexp.MustCompile(`[\s,，.。;；:：、\-_—]+$`)
	reTypePreview       = regexp.MustCompile(`(?i)预习|preview`)
	reTypeReport        = regexp.MustCompile(`(?i)统计报告|报告|report`)
	reTypeNote          = regexp.MustCompile(`(?i)笔记|note`)
	reTypeClassTest     = regexp.MustCompile(`(?i)测试|测验|class_test`)
	reTypeRoster        = regexp.MustCompile(`(?i)名单|花名册|roster`)
	reTypeHomework      = regexp.MustCompile(`(?i)巩固|课后|作业|homework`)
)

var gradeAliasMap = map[string][]string{
	"初一":  {"七年级", "初一年级", "七年级先学"},
	"初二":  {"八年级", "初二年级"},
	"初三":  {"九年级", "初三年级"},
	"七年级": {"初一", "初一年级", "七年级先学"},
	"八年级": {"初二", "初二年级"},
	"九年级": {"初三", "初三年级"},
	"高一":  {"高一年级"},
	"高二":  {"高二年级"},
	"高三":  {"高三年级"},
}

// IsHiddenTable reports whether table is in ADMIN_HIDDEN_TABLES.
func IsHiddenTable(table string) bool {
	_, ok := HiddenTables[strings.ToLower(strings.TrimSpace(table))]
	return ok
}

// IsValidIdentifier checks whether s matches ^[a-zA-Z0-9_]+$.
func IsValidIdentifier(s string) bool {
	return s != "" && reValidIdent.MatchString(s)
}

// ParseErrorQuestions normalizes error_questions input (JSON array, delimited string, or slice) into a JSON array string and count.
// Mirrors PHP actions_crud.php lines 646-664 & 821-839.
func ParseErrorQuestions(raw any) (string, int) {
	arr := parseIntSlice(raw)
	b, _ := json.Marshal(arr)
	return string(b), len(arr)
}

// ParsePreviewErrorQuestions normalizes preview_error_questions input; returns (nil, true) when empty/null.
// Mirrors PHP actions_crud.php lines 665-686 & 840-861.
func ParsePreviewErrorQuestions(raw any) (*string, bool) {
	if raw == nil {
		return nil, true
	}
	if s, ok := raw.(string); ok {
		if s == "" {
			return nil, true
		}
		trimmed := strings.TrimSpace(s)
		if trimmed == "" || trimmed == "[]" {
			empty := "[]"
			return &empty, false
		}
	}
	arr := parseIntSlice(raw)
	b, _ := json.Marshal(arr)
	out := string(b)
	return &out, false
}

func parseIntSlice(raw any) []int {
	out := []int{}
	switch v := raw.(type) {
	case string:
		trimmed := strings.TrimSpace(v)
		if trimmed == "" {
			return out
		}
		if strings.HasPrefix(trimmed, "[") {
			var decoded []any
			if err := json.Unmarshal([]byte(trimmed), &decoded); err == nil {
				for _, item := range decoded {
					if n := config.AsPHPInt(item); n != 0 {
						out = append(out, n)
					}
				}
			}
			return out
		}
		for _, part := range reErrNumSplit.Split(trimmed, -1) {
			if n := config.AsPHPInt(part); n != 0 {
				out = append(out, n)
			}
		}
	case []any:
		for _, item := range v {
			if n := config.AsPHPInt(item); n != 0 {
				out = append(out, n)
			}
		}
	case []int:
		for _, n := range v {
			if n != 0 {
				out = append(out, n)
			}
		}
	}
	return out
}

// DecodeJSONAnyList decodes a JSON array string or slice into []any.
func DecodeJSONAnyList(raw any) []any {
	if raw == nil {
		return []any{}
	}
	switch v := raw.(type) {
	case []any:
		if v == nil {
			return []any{}
		}
		return v
	case string:
		s := strings.TrimSpace(v)
		if s == "" {
			return []any{}
		}
		var out []any
		if err := json.Unmarshal([]byte(s), &out); err == nil && out != nil {
			return out
		}
		return []any{}
	case []byte:
		return DecodeJSONAnyList(string(v))
	default:
		return []any{}
	}
}

// DecodeSourceFiles parses source_files (JSON array or newline-separated string) into unique non-empty strings.
func DecodeSourceFiles(raw any) []string {
	out := []string{}
	seen := map[string]struct{}{}
	add := func(s string) {
		s = strings.TrimSpace(s)
		if s == "" {
			return
		}
		if _, ok := seen[s]; ok {
			return
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	switch v := raw.(type) {
	case []any:
		for _, item := range v {
			add(config.AsPHPString(item))
		}
	case string:
		s := strings.TrimSpace(v)
		if s == "" {
			return out
		}
		var decoded []any
		if err := json.Unmarshal([]byte(s), &decoded); err == nil {
			for _, item := range decoded {
				add(config.AsPHPString(item))
			}
			return out
		}
		for _, line := range strings.Split(s, "\n") {
			add(line)
		}
	case []byte:
		return DecodeSourceFiles(string(v))
	}
	return out
}

// CleanTopicText trims trailing punctuation from topic text.
func CleanTopicText(topic string) string {
	return reTrailingTopicPunc.ReplaceAllString(strings.TrimSpace(topic), "")
}

// GradeAliasCandidates returns unique grade candidates matching actions_crud.php weak-points lookup.
func GradeAliasCandidates(grade string) []string {
	cleanGrade := reGradeSubjectTail.ReplaceAllString(grade, "")
	cleanGrade = reGradeClassTail.ReplaceAllString(cleanGrade, "")

	base := []string{
		grade,
		cleanGrade,
		cleanGrade + "年级",
		strings.TrimSuffix(cleanGrade, "年级"),
	}
	all := make([]string, 0, len(base)+4)
	all = append(all, base...)
	for _, gc := range base {
		if aliases, ok := gradeAliasMap[gc]; ok {
			all = append(all, aliases...)
		}
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(all))
	for _, s := range all {
		if s == "" {
			continue
		}
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}

// TierAliasCandidates returns unique tier candidates (e.g. "S+班" -> ["S+班", "S+"]).
func TierAliasCandidates(tier string) []string {
	t := strings.TrimSpace(tier)
	stripped := strings.ReplaceAll(t, "班", "")
	out := make([]string, 0, 2)
	if t != "" {
		out = append(out, t)
	}
	if stripped != "" && stripped != t {
		out = append(out, stripped)
	}
	return out
}

// CleanTokenInput extracts a bare token from a raw token, URL, or query string.
// Mirrors PHP actions_token.php lines 40-48.
func CleanTokenInput(raw string) string {
	token := strings.TrimSpace(raw)
	if m := reTokenQueryParam.FindStringSubmatch(token); len(m) == 2 {
		if unescaped, err := url.QueryUnescape(m[1]); err == nil {
			token = unescaped
		} else {
			token = m[1]
		}
	} else {
		if unescaped, err := url.QueryUnescape(token); err == nil {
			token = strings.TrimSpace(unescaped)
		}
	}
	return strings.Trim(token, " \t\n\r\x00\x0b\"'<>")
}

// InferSourceFileType guesses the archive file type from an original file basename.
// Mirrors PHP actions_crud.php lines 1200-1213.
func InferSourceFileType(baseOrig string) string {
	switch {
	case reTypePreview.MatchString(baseOrig):
		return "preview"
	case reTypeReport.MatchString(baseOrig):
		return "report"
	case reTypeNote.MatchString(baseOrig):
		return "note"
	case reTypeClassTest.MatchString(baseOrig):
		return "class_test"
	case reTypeRoster.MatchString(baseOrig):
		return "roster"
	case reTypeHomework.MatchString(baseOrig):
		return "homework"
	default:
		return ""
	}
}

// IsNumericString reports whether s parses as a finite standard float without underscores (mirrors PHP is_numeric for search).
func IsNumericString(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" || strings.ContainsRune(s, '_') {
		return false
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return false
	}
	return true
}
