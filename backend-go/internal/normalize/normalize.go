package normalize

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strings"
)

var seasonToZh = map[string]string{
	"spring": "春", "春": "春", "春季": "春", "春学期": "春",
	"summer": "暑", "暑": "暑", "暑假": "暑", "暑期": "暑", "夏": "暑",
	"autumn": "秋", "fall": "秋", "秋": "秋", "秋季": "秋", "秋学期": "秋",
	"winter": "寒", "寒": "寒", "寒假": "寒", "寒期": "寒", "冬": "寒",
}

var seasonZhToEn = map[string]string{
	"春": "spring",
	"暑": "summer",
	"秋": "autumn",
	"寒": "winter",
}

var gradeAliasMap = map[string]string{
	"初一": "七年级", "初中一年级": "七年级", "7年级": "七年级",
	"初二": "八年级", "初中二年级": "八年级", "8年级": "八年级",
	"初三": "九年级", "初中三年级": "九年级", "9年级": "九年级",
	"小一": "一年级", "1年级": "一年级",
	"小二": "二年级", "2年级": "二年级",
	"小三": "三年级", "3年级": "三年级",
	"小四": "四年级", "4年级": "四年级",
	"小五": "五年级", "5年级": "五年级",
	"小六": "六年级", "6年级": "六年级",
}

// Season mirrors PHP lib_normalize.php normalizeSeason($season, $fallbackOrTarget).
// When fallbackOrTarget == "en", returns English ("spring"|"summer"|"autumn"|"winter").
// Otherwise returns single-char Chinese ("春"|"暑"|"秋"|"寒"), using fallbackOrTarget as default when empty ("" if "zh").
func Season(season, fallbackOrTarget string) string {
	trimmed := strings.TrimSpace(season)
	raw := strings.ToLower(trimmed)
	targetLang := "zh"
	if fallbackOrTarget == "en" {
		targetLang = "en"
	}
	fallback := fallbackOrTarget
	if fallbackOrTarget == "zh" || fallbackOrTarget == "en" {
		fallback = ""
	}
	if raw == "" {
		return fallback
	}

	zh, ok := seasonToZh[raw]
	if !ok {
		for _, ch := range []string{"春", "暑", "秋", "寒"} {
			if strings.Contains(raw, ch) {
				zh = ch
				ok = true
				break
			}
		}
	}
	if !ok {
		if fallback != "" {
			return fallback
		}
		return trimmed
	}
	if targetLang == "en" {
		if en, exists := seasonZhToEn[zh]; exists {
			return en
		}
	}
	return zh
}

// SeasonVariants mirrors PHP getSeasonVariants($season), returning deduplicated raw/zh/en candidates.
func SeasonVariants(season string) []string {
	raw := strings.TrimSpace(season)
	if raw == "" {
		return []string{}
	}
	zh := Season(raw, "zh")
	en := Season(raw, "en")
	candidates := []string{raw, zh, en}
	out := make([]string, 0, len(candidates))
	seen := make(map[string]struct{}, len(candidates))
	for _, c := range candidates {
		if c == "" {
			continue
		}
		if _, exists := seen[c]; exists {
			continue
		}
		seen[c] = struct{}{}
		out = append(out, c)
	}
	return out
}

// Grade mirrors PHP normalizeGrade($grade).
func Grade(grade string) string {
	g := strings.TrimSpace(grade)
	if g == "" {
		return ""
	}
	if mapped, ok := gradeAliasMap[g]; ok {
		return mapped
	}
	return g
}

// Subject mirrors PHP normalizeSubject($subject).
func Subject(subject string) string {
	return strings.TrimSpace(subject)
}

// DeriveRetestToken mirrors PHP deriveRetestToken($subject, $grade, $studentKey, $secretKey).
// Returns the first 10 chars of URL-safe Base64(HMAC-SHA256("{subject}_{grade}_{studentKey}", secret)).
func DeriveRetestToken(subject, grade, studentKey, secret string) string {
	if secret == "" {
		buf := make([]byte, 6)
		_, _ = rand.Read(buf)
		return strings.ToUpper(hex.EncodeToString(buf))[:10]
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(subject + "_" + grade + "_" + studentKey))
	rawHash := mac.Sum(nil)
	encoded := base64.RawURLEncoding.EncodeToString(rawHash)
	if len(encoded) > 10 {
		return encoded[:10]
	}
	return encoded
}
