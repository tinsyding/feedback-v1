package qbank

import (
	"encoding/json"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"feedback-api/internal/config"
)

var (
	reTrailingTopicPunct = regexp.MustCompile(`[\s,，.。;；:：、\-_—]+$`)
	reSplitQuestionIDs   = regexp.MustCompile(`[,，、]`)
	reValidOrphanPDF     = regexp.MustCompile(`^data/pdfs/(pdf_[a-zA-Z0-9_.\-]+\.pdf)$`)
)

// NormalizeBankType mirrors PHP qbank.php normalizeBankType().
func NormalizeBankType(raw string) string {
	switch strings.TrimSpace(raw) {
	case "preview":
		return "preview"
	case "variation":
		return "variation"
	default:
		return "homework"
	}
}

// CleanTopic strips trailing Chinese/English punctuation and enforces the 60,000-rune cap.
func CleanTopic(raw string) string {
	s := strings.TrimSpace(raw)
	s = strings.TrimSpace(reTrailingTopicPunct.ReplaceAllString(s, ""))
	if utf8.RuneCountInString(s) > 60000 {
		runes := []rune(s)
		s = string(runes[:60000])
	}
	return s
}

func round4(v float64) float64 {
	return math.Round(v*10000) / 10000
}

func clampFloat(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func asOptionalFloat(v any) (float64, bool) {
	if v == nil {
		return 0, false
	}
	switch x := v.(type) {
	case float64:
		return x, true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case json.Number:
		if f, err := x.Float64(); err == nil {
			return f, true
		}
		return 0, false
	case string:
		s := strings.TrimSpace(x)
		if s == "" {
			return 0, true
		}
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return f, true
		}
		return 0, true
	default:
		return 0, false
	}
}

func sanitizeBox(raw any) map[string]any {
	b, ok := raw.(map[string]any)
	if !ok || len(b) == 0 {
		return nil
	}
	x, okX := asOptionalFloat(b["x"])
	y, okY := asOptionalFloat(b["y"])
	w, okW := asOptionalFloat(b["w"])
	h, okH := asOptionalFloat(b["h"])
	if !okX || !okY || !okW || !okH {
		return nil
	}
	pageOffset := 0
	if po, exists := b["pageOffset"]; exists && po != nil {
		if v := config.AsPHPInt(po); v > 0 {
			pageOffset = v
		}
	}
	return map[string]any{
		"pageOffset": pageOffset,
		"x":          clampFloat(round4(x), 0.0, 1.0),
		"y":          clampFloat(round4(y), 0.0, 1.0),
		"w":          clampFloat(round4(w), 0.005, 1.0),
		"h":          clampFloat(round4(h), 0.005, 1.0),
	}
}

// SanitizeQuestionMeta mirrors PHP qbank.php sanitizeQuestionMeta($rawMeta).
func SanitizeQuestionMeta(raw any) map[string]any {
	if raw == nil {
		return nil
	}
	var m map[string]any
	switch x := raw.(type) {
	case string:
		s := strings.TrimSpace(x)
		if s == "" {
			return nil
		}
		dec := json.NewDecoder(strings.NewReader(s))
		dec.UseNumber()
		if err := dec.Decode(&m); err != nil || m == nil {
			return nil
		}
	case map[string]any:
		m = x
	default:
		return nil
	}
	if len(m) == 0 {
		return nil
	}

	clean := make(map[string]any)

	if rawGNums, ok := m["groupNums"].([]any); ok && len(rawGNums) > 0 {
		seen := make(map[int]struct{})
		gNums := make([]int, 0, len(rawGNums))
		for _, item := range rawGNums {
			n := config.AsPHPInt(item)
			if n > 0 && n <= 500 {
				if _, exists := seen[n]; !exists {
					seen[n] = struct{}{}
					gNums = append(gNums, n)
				}
			}
		}
		sort.Ints(gNums)
		if len(gNums) >= 1 {
			clean["groupNums"] = gNums
		}
	}

	for _, boxKey := range []string{"box", "answerBox"} {
		if b := sanitizeBox(m[boxKey]); b != nil {
			clean[boxKey] = b
		}
	}

	if mode, ok := m["mode"].(string); ok && mode == "region_crop" {
		clean["mode"] = "region_crop"
	}

	for _, arrKey := range []string{"stemBoxes", "regions", "answerRegions"} {
		if rawList, ok := m[arrKey].([]any); ok && len(rawList) > 0 {
			cleanList := make([]map[string]any, 0, len(rawList))
			for _, item := range rawList {
				if sb := sanitizeBox(item); sb != nil {
					cleanList = append(cleanList, sb)
				}
			}
			if len(cleanList) > 0 {
				clean[arrKey] = cleanList
			}
		}
	}

	if len(clean) == 0 {
		return nil
	}
	return clean
}

// ParseParentNums parses parentQuestionNums / parent_question_nums + primary parentQuestionNum into a sorted unique slice
// and resolves the primary parent question number.
func ParseParentNums(primaryRaw, listRaw any) (*int, []int) {
	seen := make(map[int]struct{})
	nums := make([]int, 0)
	addNum := func(n int) {
		if n <= 0 {
			return
		}
		if _, ok := seen[n]; !ok {
			seen[n] = struct{}{}
			nums = append(nums, n)
		}
	}

	switch x := listRaw.(type) {
	case []any:
		for _, item := range x {
			addNum(config.AsPHPInt(item))
		}
	case []int:
		for _, n := range x {
			addNum(n)
		}
	case string:
		if strings.TrimSpace(x) != "" {
			for _, part := range strings.Split(x, ",") {
				addNum(config.AsPHPInt(strings.TrimSpace(part)))
			}
		}
	}
	sort.Ints(nums)

	var primary *int
	if primaryRaw != nil {
		if s, ok := primaryRaw.(string); !ok || strings.TrimSpace(s) != "" {
			v := config.AsPHPInt(primaryRaw)
			primary = &v
		}
	}
	if len(nums) == 0 && primary != nil && *primary > 0 {
		nums = []int{*primary}
	}
	if primary == nil && len(nums) > 0 {
		v := nums[0]
		primary = &v
	}
	return primary, nums
}

// BuildHomeworkTopicMapFromMaps builds question_num -> topic map from raw question JSON objects.
func BuildHomeworkTopicMapFromMaps(questions []map[string]any) map[int]string {
	out := make(map[int]string)
	for _, q := range questions {
		topic := strings.TrimSpace(config.AsPHPString(q["topic"]))
		if topic == "" {
			continue
		}
		rawID := q["question_num"]
		if rawID == nil {
			rawID = q["id"]
		}
		switch x := rawID.(type) {
		case []any:
			for _, item := range x {
				if n := config.AsPHPInt(item); n > 0 {
					out[n] = topic
				}
			}
		case string:
			for _, part := range reSplitQuestionIDs.Split(x, -1) {
				if n := config.AsPHPInt(strings.TrimSpace(part)); n > 0 {
					out[n] = topic
				}
			}
		default:
			if n := config.AsPHPInt(rawID); n > 0 {
				out[n] = topic
			}
		}
	}
	return out
}

// VariationParentNums returns the ordered parent question numbers (primary first) for a variation question.
func VariationParentNums(primary *int, list []int) []int {
	seen := make(map[int]struct{})
	out := make([]int, 0, len(list)+1)
	if primary != nil && *primary > 0 {
		seen[*primary] = struct{}{}
		out = append(out, *primary)
	}
	for _, n := range list {
		if n > 0 {
			if _, ok := seen[n]; !ok {
				seen[n] = struct{}{}
				out = append(out, n)
			}
		}
	}
	return out
}

// IsValidManagedPDFPath checks that relURL is strictly inside data/pdfs/pdf_*.pdf (no path traversal).
func IsValidManagedPDFPath(relURL string) (string, bool) {
	m := reValidOrphanPDF.FindStringSubmatch(strings.TrimSpace(relURL))
	if len(m) != 2 {
		return "", false
	}
	return m[1], true
}
