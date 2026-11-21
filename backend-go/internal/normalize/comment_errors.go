package normalize

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

var (
	fullwidthDigitReplacer = strings.NewReplacer(
		"０", "0", "１", "1", "２", "2", "３", "3", "４", "4",
		"５", "5", "６", "6", "７", "7", "８", "8", "９", "9",
	)
	spaceReplacer = strings.NewReplacer("\r\n", "\n", "\u00a0", " ", "\u3000", " ")
	rePureNoErrHeader = regexp.MustCompile(`(?i)^(?:本次|本周|这周|今天)?(?:的)?(?:家庭)?(?:作业|测验|测试|练习)?(?:的)?(?:错题|做错|错误)?(?:题号|序号|编号)?(?:为|是)?\s*[:：]\s*(?:无|没有|0|零|全对|无错题|全部正确|都对|暂无|none)\s*[。!！.]?\s*$`)
	reNoErrGeneral    = regexp.MustCompile(`(?:本次|本周|今天)?(?:的)?(?:作业|测验|测试)?(?:全部做对|全部正确|全做对|完全正确|零失误|无错题|没有错题|免除加练|全对)`)
	reErrPrefixColon  = regexp.MustCompile(`(?i)^(?:本次|本周|这周|今天)?(?:的)?(?:家庭)?(?:作业|测验|测试|练习)?(?:的)?(?:错题|做错的题|做错|错误)(?:题号|序号|编号|列表)?(?:为|是)?\s*[:：]\s*(.*)$`)
	reErrPrefixSpace  = regexp.MustCompile(`(?i)^(?:本次|本周|这周|今天)?(?:的)?(?:家庭)?(?:作业|测验|测试|练习)?(?:的)?(?:错题|做错的题|做错|错误)(?:题号|序号|编号|列表)?(?:为|是)?\s*((?:\d|第|无|0|零|全对|全部).*)$`)
	reAfterNoErr      = regexp.MustCompile(`(?i)^(?:无|没有|0|零|全对|全部正确|无错题|都对|暂无|none)\s*[。!！.]?$`)
	rePureNumbersLine = regexp.MustCompile(`^(?:第?\s*\d+\s*题?[,，、\s/；;和与及\-]+)*第?\s*\d+\s*题?\s*[。.]?$`)
	reDigits          = regexp.MustCompile(`\d+`)
)

// NormalizeFullwidthDigits replaces full-width Chinese digits (０-９) with ASCII 0-9.
func NormalizeFullwidthDigits(s string) string {
	return fullwidthDigitReplacer.Replace(s)
}

// ParseErrorQuestionsFromComment extracts deduplicated error question numbers (1..100) from a teacher comment.
// Mirrors PHP feedback-v1/api/lib_normalize.php parseErrorQuestionsFromCommentPhp().
func ParseErrorQuestionsFromComment(rawComment string) []int {
	rawComment = strings.TrimSpace(rawComment)
	if rawComment == "" {
		return []int{}
	}
	normalized := NormalizeFullwidthDigits(spaceReplacer.Replace(rawComment))
	rawLines := strings.Split(normalized, "\n")
	nonEmpty := make([]string, 0, len(rawLines))
	for _, l := range rawLines {
		if t := strings.TrimSpace(l); t != "" {
			nonEmpty = append(nonEmpty, t)
		}
	}
	if len(nonEmpty) == 0 {
		return []int{}
	}
	firstLine := nonEmpty[0]

	filterValidNums := func(matches []string) []int {
		res := []int{}
		seen := map[int]struct{}{}
		for _, m := range matches {
			n, err := strconv.Atoi(m)
			if err != nil || n < 1 || n > 100 {
				continue
			}
			if _, ok := seen[n]; ok {
				continue
			}
			seen[n] = struct{}{}
			res = append(res, n)
		}
		return res
	}

	// 1. Explicit no-error / full-score headers
	if rePureNoErrHeader.MatchString(firstLine) || reNoErrGeneral.MatchString(firstLine) {
		return []int{}
	}

	// 2. Prefix match across non-empty lines
	for idx, line := range nonEmpty {
		var after string
		matched := false
		if m := reErrPrefixColon.FindStringSubmatch(line); len(m) == 2 {
			after = strings.TrimSpace(m[1])
			matched = true
		} else if m := reErrPrefixSpace.FindStringSubmatch(line); len(m) == 2 {
			after = strings.TrimSpace(m[1])
			matched = true
		}
		if !matched {
			continue
		}
		if after == "" && idx+1 < len(nonEmpty) {
			after = nonEmpty[idx+1]
		}
		if reAfterNoErr.MatchString(after) {
			return []int{}
		}
		numsPart := cutBeforeSentenceOrTwoHan(after)
		valid := filterValidNums(reDigits.FindAllString(numsPart, -1))
		if len(valid) > 0 {
			return valid
		}
		return []int{}
	}

	// 3. First line pure numbers list
	if rePureNumbersLine.MatchString(firstLine) {
		return filterValidNums(reDigits.FindAllString(firstLine, -1))
	}

	return []int{}
}

// cutBeforeSentenceOrTwoHan mirrors PHP preg_split('/[。!！;；\n]|(?=[\x{4e00}-\x{9fa5}]{2,})/u', $after)[0].
func cutBeforeSentenceOrTwoHan(s string) string {
	runes := []rune(s)
	for i, r := range runes {
		switch r {
		case '。', '!', '！', ';', '；', '\n':
			return string(runes[:i])
		}
		if isHan(r) && i+1 < len(runes) && isHan(runes[i+1]) {
			return string(runes[:i])
		}
	}
	return s
}

func isHan(r rune) bool {
	return r >= 0x4e00 && r <= 0x9fa5 && unicode.Is(unicode.Han, r)
}
