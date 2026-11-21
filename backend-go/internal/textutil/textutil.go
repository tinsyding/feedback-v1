package textutil

import (
	"golang.org/x/text/encoding/simplifiedchinese"
)

// TruncateRunes truncates s to at most maxRunes Unicode code points without splitting multi-byte UTF-8 runes.
func TruncateRunes(s string, maxRunes int) string {
	if maxRunes <= 0 {
		return ""
	}
	count := 0
	for i := range s {
		if count == maxRunes {
			return s[:i]
		}
		count++
	}
	return s
}

// TruncateUTF8Bytes truncates s so its byte length is at most maxBytes without splitting a multi-byte UTF-8 rune.
func TruncateUTF8Bytes(s string, maxBytes int) string {
	if maxBytes <= 0 {
		return ""
	}
	if len(s) <= maxBytes {
		return s
	}
	end := 0
	for i := range s {
		if i > maxBytes {
			break
		}
		end = i
	}
	return s[:end]
}

// EncodeGBK encodes a UTF-8 string into GBK bytes, returning (nil, false) if any character cannot be represented.
func EncodeGBK(s string) ([]byte, bool) {
	if s == "" {
		return []byte{}, true
	}
	b, err := simplifiedchinese.GBK.NewEncoder().Bytes([]byte(s))
	if err != nil {
		return nil, false
	}
	return b, true
}
