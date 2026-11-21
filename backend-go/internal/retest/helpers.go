package retest

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"feedback-api/internal/config"
	"feedback-api/internal/normalize"
)

var (
	reUnsubmittedComment = regexp.MustCompile(`(?:未交|未提交|缺交|未查阅|缺勤)`)
	reErrSplit           = regexp.MustCompile(`[\s,，、]+`)
)

// Box represents a normalized bounding box in question_meta.
type Box struct {
	Num        int     `json:"num,omitempty"`
	PageOffset int     `json:"pageOffset"`
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
	W          float64 `json:"w"`
	H          float64 `json:"h"`
}

// ParsedQuestionMeta mirrors PHP parseRetestQuestionMeta().
type ParsedQuestionMeta struct {
	Mode          string
	GroupNums     []int
	Box           *Box
	AnswerBox     *Box
	StemBoxes     []Box
	Regions       []Box
	AnswerRegions []Box
}

// ParseRetestQuestionMeta parses raw question_meta JSON into normalized boxes and groupNums.
// Mirrors PHP retest.php parseRetestQuestionMeta().
func ParseRetestQuestionMeta(rawMeta string, qNum int) ParsedQuestionMeta {
	empty := ParsedQuestionMeta{
		GroupNums:     []int{},
		StemBoxes:     []Box{},
		Regions:       []Box{},
		AnswerRegions: []Box{},
	}
	rawMeta = strings.TrimSpace(rawMeta)
	if rawMeta == "" {
		return empty
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(rawMeta), &m); err != nil || m == nil {
		return empty
	}

	groupNums := []int{}
	if gnRaw, ok := m["groupNums"].([]any); ok {
		seen := map[int]struct{}{}
		for _, item := range gnRaw {
			n := config.AsPHPInt(item)
			if n > 0 {
				if _, dup := seen[n]; !dup {
					seen[n] = struct{}{}
					groupNums = append(groupNums, n)
				}
			}
		}
		sort.Ints(groupNums)
	}

	parseBox := func(raw any, withNum bool) *Box {
		bm, ok := raw.(map[string]any)
		if !ok || bm == nil {
			return nil
		}
		for _, k := range []string{"x", "y", "w", "h"} {
			val, ok := bm[k]
			if !ok || val == nil {
				return nil
			}
		}
		po := config.AsPHPInt(bm["pageOffset"])
		if po < 0 {
			po = 0
		}
		clamp := func(v, lo, hi float64) float64 {
			r := math.Round(v*10000) / 10000
			if r < lo {
				return lo
			}
			if r > hi {
				return hi
			}
			return r
		}
		b := &Box{
			PageOffset: po,
			X:          clamp(config.AsPHPFloat(bm["x"]), 0.0, 1.0),
			Y:          clamp(config.AsPHPFloat(bm["y"]), 0.0, 1.0),
			W:          clamp(config.AsPHPFloat(bm["w"]), 0.005, 1.0),
			H:          clamp(config.AsPHPFloat(bm["h"]), 0.005, 1.0),
		}
		if withNum {
			b.Num = qNum
		}
		return b
	}

	parseBoxArray := func(raw any) []Box {
		res := []Box{}
		arr, ok := raw.([]any)
		if !ok {
			return res
		}
		for _, item := range arr {
			if b := parseBox(item, false); b != nil {
				res = append(res, *b)
			}
		}
		return res
	}

	mode := ""
	if config.AsPHPString(m["mode"]) == "region_crop" {
		mode = "region_crop"
	}
	return ParsedQuestionMeta{
		Mode:          mode,
		GroupNums:     groupNums,
		Box:           parseBox(m["box"], true),
		AnswerBox:     parseBox(m["answerBox"], true),
		StemBoxes:     parseBoxArray(m["stemBoxes"]),
		Regions:       parseBoxArray(m["regions"]),
		AnswerRegions: parseBoxArray(m["answerRegions"]),
	}
}

// ResolveSubmissionStatus mirrors PHP retest.php resolveSubmissionStatus().
// Returns "submitted", "unsubmitted", or "exempt".
func ResolveSubmissionStatus(explicitStatus string, errors []int, score *float64, comment string) string {
	st := strings.ToLower(strings.TrimSpace(explicitStatus))
	if st == "unsubmitted" || st == "exempt" {
		return st
	}
	comment = strings.TrimSpace(comment)
	if comment != "" && reUnsubmittedComment.MatchString(comment) {
		return "unsubmitted"
	}
	if st == "submitted" {
		return "submitted"
	}
	if len(errors) == 0 && score == nil && comment == "" {
		return "unsubmitted"
	}
	return "submitted"
}

// NormalizeErrorNums converts a JSON array, delimited string, or scalar into deduplicated positive ints (preserving order).
func NormalizeErrorNums(raw any) []int {
	out := []int{}
	seen := map[int]struct{}{}
	add := func(v any) {
		var n int
		if s, ok := v.(string); ok {
			s = normalize.NormalizeFullwidthDigits(strings.TrimSpace(s))
			n = config.AsPHPInt(s)
		} else {
			n = config.AsPHPInt(v)
		}
		if n <= 0 {
			return
		}
		if _, ok := seen[n]; ok {
			return
		}
		seen[n] = struct{}{}
		out = append(out, n)
	}

	switch x := raw.(type) {
	case nil:
	case string:
		s := strings.TrimSpace(x)
		if s == "" {
			return out
		}
		if strings.HasPrefix(s, "[") {
			var decoded []any
			if err := json.Unmarshal([]byte(s), &decoded); err == nil {
				for _, item := range decoded {
					add(item)
				}
				return out
			}
		}
		for _, part := range reErrSplit.Split(s, -1) {
			add(part)
		}
	case []any:
		for _, item := range x {
			add(item)
		}
	case []int:
		for _, n := range x {
			add(n)
		}
	default:
		add(x)
	}
	return out
}

// ParseJSONErrorInts decodes a nullable JSON int array string into unique positive ints.
func ParseJSONErrorInts(raw *string) []int {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return []int{}
	}
	var decoded []any
	if err := json.Unmarshal([]byte(*raw), &decoded); err != nil {
		return []int{}
	}
	return NormalizeErrorNums(decoded)
}

// BuildWeekPDFs constructs the per-week PDF list from preloaded qbank_questions rows.
// Mirrors PHP retest.php getWeekPdfs() lines 310-571.
func BuildWeekPDFs(allRows []QbankQuestionRow, bankType, tier string, weekNum int, errorNums []int) []map[string]any {
	if bankType != "preview" {
		bankType = "homework"
	}
	pdfList := []map[string]any{}
	if len(errorNums) == 0 {
		return pdfList
	}

	var allWeekRows []QbankQuestionRow
	var varRows []QbankQuestionRow
	for _, r := range allRows {
		if r.Tier != tier || r.Week != weekNum {
			continue
		}
		if r.BankType == bankType {
			allWeekRows = append(allWeekRows, r)
		} else if bankType == "homework" && r.BankType == "variation" {
			varRows = append(varRows, r)
		}
	}

	pdfSharedNumsMap := map[string][]int{}
	errNumSet := make(map[int]struct{}, len(errorNums))
	for _, n := range errorNums {
		errNumSet[n] = struct{}{}
	}
	rowMap := map[int]QbankQuestionRow{}
	for _, wr := range allWeekRows {
		qn := wr.QuestionNum
		exU := strings.TrimSpace(wr.ExercisePDF)
		wrMeta := ParseRetestQuestionMeta(wr.QuestionMeta, qn)
		if exU != "" && qn > 0 && wrMeta.Mode != "region_crop" {
			pdfSharedNumsMap[exU] = append(pdfSharedNumsMap[exU], qn)
		}
		if _, ok := errNumSet[qn]; ok {
			rowMap[qn] = wr
		}
	}

	// Build variation map keyed by matched parent question num
	type varItem struct {
		row               QbankQuestionRow
		parentNums        []int
		matchedParentNums []int
	}
	varMap := map[int][]varItem{}
	if bankType == "homework" && len(varRows) > 0 {
		for _, vr := range varRows {
			allParents := parseCSVPositiveInts(vr.ParentQuestionNums)
			if len(allParents) == 0 && vr.ParentQuestionNum > 0 {
				allParents = []int{vr.ParentQuestionNum}
			}
			var matched []int
			for _, p := range allParents {
				if _, ok := errNumSet[p]; ok {
					matched = append(matched, p)
				}
			}
			sort.Ints(matched)
			if len(matched) == 0 && vr.ParentQuestionNum > 0 {
				if _, ok := errNumSet[vr.ParentQuestionNum]; ok {
					matched = []int{vr.ParentQuestionNum}
				}
			}
			if len(matched) == 0 {
				continue
			}
			item := varItem{row: vr, parentNums: allParents, matchedParentNums: matched}
			for _, mp := range matched {
				varMap[mp] = append(varMap[mp], item)
			}
		}
	}

	uniqueIdx := map[string]int{}
	seenVarKey := map[string]bool{}
	subTopicsByIdx := map[int]map[int]string{}
	subTopicsOrder := map[int][]int{}

	for _, qNum := range errorNums {
		if r, ok := rowMap[qNum]; ok {
			exURL := strings.TrimSpace(r.ExercisePDF)
			meta := ParseRetestQuestionMeta(r.QuestionMeta, qNum)
			inferredGroup := meta.GroupNums
			if len(inferredGroup) == 0 {
				if meta.Mode != "region_crop" && exURL != "" && len(pdfSharedNumsMap[exURL]) > 0 {
					inferredGroup = append([]int(nil), pdfSharedNumsMap[exURL]...)
				} else {
					inferredGroup = []int{qNum}
				}
			}
			sort.Ints(inferredGroup)
			curTopic := strings.TrimSpace(r.Topic)

			uniqueKey := exURL
			if exURL != "" && meta.Mode == "region_crop" {
				if len(inferredGroup) > 1 {
					uniqueKey = exURL + "::group::" + joinInts(inferredGroup, ",")
				} else {
					uniqueKey = fmt.Sprintf("%s::q::%d", exURL, qNum)
				}
			}

			if exURL != "" {
				if existIdx, exists := uniqueIdx[uniqueKey]; !exists {
					newIdx := len(pdfList)
					errBoxes := []Box{}
					if meta.Box != nil {
						errBoxes = append(errBoxes, *meta.Box)
					}
					ansErrBoxes := []Box{}
					if meta.AnswerBox != nil {
						ansErrBoxes = append(ansErrBoxes, *meta.AnswerBox)
					}
					subTopics := map[string]string{}
					if curTopic != "" {
						subTopics[strconv.Itoa(qNum)] = curTopic
						subTopicsByIdx[newIdx] = map[int]string{qNum: curTopic}
						subTopicsOrder[newIdx] = []int{qNum}
					} else {
						subTopicsByIdx[newIdx] = map[int]string{}
					}
					var videoPtr, ansPtr any
					if strings.TrimSpace(r.VideoURL) != "" {
						videoPtr = strings.TrimSpace(r.VideoURL)
					}
					if strings.TrimSpace(r.AnswerPDF) != "" {
						ansPtr = strings.TrimSpace(r.AnswerPDF)
					}
					var modeVal any = meta.Mode
					pdfList = append(pdfList, map[string]any{
						"errorNum":         qNum,
						"errorNums":        []int{qNum},
						"groupNums":        inferredGroup,
						"mode":             modeVal,
						"regions":          meta.Regions,
						"answerRegions":    meta.AnswerRegions,
						"errorBoxes":       errBoxes,
						"answerErrorBoxes": ansErrBoxes,
						"stemBoxes":        meta.StemBoxes,
						"subTopics":        subTopics,
						"topic":            curTopic,
						"videoUrl":         videoPtr,
						"exercisePdf":      exURL,
						"answerPdf":        ansPtr,
						"sourceType":       bankType,
					})
					uniqueIdx[uniqueKey] = newIdx
				} else if !config.AsPHPBool(pdfList[existIdx]["isVariation"]) {
					entry := pdfList[existIdx]
					eNums := entry["errorNums"].([]int)
					if !containsInt(eNums, qNum) {
						eNums = append(eNums, qNum)
						sort.Ints(eNums)
						entry["errorNums"] = eNums
					}
					entry["groupNums"] = mergeSortedUniqueInts(entry["groupNums"].([]int), inferredGroup)
					if meta.Mode != "" && config.AsPHPString(entry["mode"]) == "" {
						entry["mode"] = meta.Mode
					}
					if len(meta.Regions) > 0 {
						entry["regions"] = appendUniqueBoxes(entry["regions"].([]Box), meta.Regions)
					}
					if len(meta.AnswerRegions) > 0 {
						entry["answerRegions"] = appendUniqueBoxes(entry["answerRegions"].([]Box), meta.AnswerRegions)
					}
					if meta.Box != nil {
						entry["errorBoxes"] = append(entry["errorBoxes"].([]Box), *meta.Box)
					}
					if meta.AnswerBox != nil {
						entry["answerErrorBoxes"] = append(entry["answerErrorBoxes"].([]Box), *meta.AnswerBox)
					}
					if len(entry["stemBoxes"].([]Box)) == 0 && len(meta.StemBoxes) > 0 {
						entry["stemBoxes"] = meta.StemBoxes
					}
					if curTopic != "" {
						stMap := subTopicsByIdx[existIdx]
						if _, existed := stMap[qNum]; !existed {
							subTopicsOrder[existIdx] = append(subTopicsOrder[existIdx], qNum)
						}
						stMap[qNum] = curTopic
						entry["subTopics"].(map[string]string)[strconv.Itoa(qNum)] = curTopic

						uniqTopics := map[string]struct{}{}
						var singleTopic string
						for _, t := range stMap {
							uniqTopics[t] = struct{}{}
							singleTopic = t
						}
						if len(uniqTopics) == 1 {
							entry["topic"] = singleTopic
						} else {
							parts := make([]string, 0, len(subTopicsOrder[existIdx]))
							for _, sn := range subTopicsOrder[existIdx] {
								parts = append(parts, fmt.Sprintf("[%d] %s", sn, stMap[sn]))
							}
							entry["topic"] = strings.Join(parts, " · ")
						}
					}
					if entry["videoUrl"] == nil && strings.TrimSpace(r.VideoURL) != "" {
						entry["videoUrl"] = strings.TrimSpace(r.VideoURL)
					}
					if entry["answerPdf"] == nil && strings.TrimSpace(r.AnswerPDF) != "" {
						entry["answerPdf"] = strings.TrimSpace(r.AnswerPDF)
					}
				}
			}
		}

		// Interleave variation questions right after their parent error question
		for _, vItem := range varMap[qNum] {
			vr := vItem.row
			vExURL := strings.TrimSpace(vr.ExercisePDF)
			if vExURL == "" {
				continue
			}
			vMeta := ParseRetestQuestionMeta(vr.QuestionMeta, vr.QuestionNum)
			vUniqueKey := vExURL
			if vMeta.Mode == "region_crop" {
				if vr.ID > 0 {
					vUniqueKey = fmt.Sprintf("%s::var::%d", vExURL, vr.ID)
				} else {
					sub := vr.SubNum
					if sub <= 0 {
						sub = 1
					}
					vUniqueKey = fmt.Sprintf("%s::var::%d_%d", vExURL, qNum, sub)
				}
			}
			if _, used := uniqueIdx[vUniqueKey]; used || seenVarKey[vUniqueKey] {
				continue
			}
			seenVarKey[vUniqueKey] = true
			subNum := vr.SubNum
			if subNum <= 0 {
				subNum = 1
			}
			errBoxes := []Box{}
			if vMeta.Box != nil {
				errBoxes = append(errBoxes, *vMeta.Box)
			}
			ansErrBoxes := []Box{}
			if vMeta.AnswerBox != nil {
				ansErrBoxes = append(ansErrBoxes, *vMeta.AnswerBox)
			}
			var vAnsPtr any
			if strings.TrimSpace(vr.AnswerPDF) != "" {
				vAnsPtr = strings.TrimSpace(vr.AnswerPDF)
			}
			pdfList = append(pdfList, map[string]any{
				"errorNum":          qNum,
				"parentNum":         qNum,
				"parentNums":        vItem.parentNums,
				"matchedParentNums": vItem.matchedParentNums,
				"subNum":            subNum,
				"mode":              vMeta.Mode,
				"regions":           vMeta.Regions,
				"answerRegions":     vMeta.AnswerRegions,
				"errorBoxes":        errBoxes,
				"answerErrorBoxes":  ansErrBoxes,
				"stemBoxes":         vMeta.StemBoxes,
				"topic":             vr.Topic,
				"videoUrl":          nil,
				"exercisePdf":       vExURL,
				"answerPdf":         vAnsPtr,
				"sourceType":        "variation",
				"isVariation":       true,
			})
		}
	}

	return pdfList
}

func parseCSVPositiveInts(s string) []int {
	var out []int
	seen := map[int]struct{}{}
	for _, p := range strings.Split(s, ",") {
		n, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil || n <= 0 {
			continue
		}
		if _, ok := seen[n]; ok {
			continue
		}
		seen[n] = struct{}{}
		out = append(out, n)
	}
	return out
}

func joinInts(nums []int, sep string) string {
	parts := make([]string, len(nums))
	for i, n := range nums {
		parts[i] = strconv.Itoa(n)
	}
	return strings.Join(parts, sep)
}

func containsInt(slice []int, target int) bool {
	for _, v := range slice {
		if v == target {
			return true
		}
	}
	return false
}

func mergeSortedUniqueInts(a, b []int) []int {
	seen := make(map[int]struct{}, len(a)+len(b))
	out := make([]int, 0, len(a)+len(b))
	for _, v := range a {
		if _, ok := seen[v]; !ok {
			seen[v] = struct{}{}
			out = append(out, v)
		}
	}
	for _, v := range b {
		if _, ok := seen[v]; !ok {
			seen[v] = struct{}{}
			out = append(out, v)
		}
	}
	sort.Ints(out)
	return out
}

func appendUniqueBoxes(dst, src []Box) []Box {
	for _, rg := range src {
		dup := false
		for _, erg := range dst {
			if erg.PageOffset == rg.PageOffset &&
				math.Abs(erg.X-rg.X) < 0.002 &&
				math.Abs(erg.Y-rg.Y) < 0.002 &&
				math.Abs(erg.W-rg.W) < 0.002 &&
				math.Abs(erg.H-rg.H) < 0.002 {
				dup = true
				break
			}
		}
		if !dup {
			dst = append(dst, rg)
		}
	}
	return dst
}
