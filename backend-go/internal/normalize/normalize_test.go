package normalize

import (
	"reflect"
	"testing"
)

func TestSeasonNormalization(t *testing.T) {
	cases := []struct {
		in       string
		fallback string
		want     string
	}{
		{"autumn", "秋", "秋"},
		{"fall", "秋", "秋"},
		{"秋季", "秋", "秋"},
		{"spring", "en", "spring"},
		{"春季", "en", "spring"},
		{"暑假", "zh", "暑"},
		{"冬", "zh", "寒"},
		{"", "春", "春"},
		{"", "zh", ""},
		{"", "en", ""},
		{"2026寒期班", "秋", "寒"},
	}
	for _, tc := range cases {
		if got := Season(tc.in, tc.fallback); got != tc.want {
			t.Fatalf("Season(%q, %q) = %q, want %q", tc.in, tc.fallback, got, tc.want)
		}
	}

	variants := SeasonVariants("秋季")
	wantVariants := []string{"秋季", "秋", "autumn"}
	if !reflect.DeepEqual(variants, wantVariants) {
		t.Fatalf("SeasonVariants(秋季) = %#v, want %#v", variants, wantVariants)
	}
}

func TestGradeAndDeriveRetestToken(t *testing.T) {
	if got := Grade(" 初一 "); got != "七年级" {
		t.Fatalf("Grade(初一) = %q", got)
	}
	if got := Grade("高一先学"); got != "高一先学" {
		t.Fatalf("Grade(高一先学) = %q", got)
	}

	tok1 := DeriveRetestToken("数学", "七年级", "202601_张三_七年级_数学", "test-secret")
	tok2 := DeriveRetestToken("数学", "七年级", "202601_张三_七年级_数学", "test-secret")
	if len(tok1) != 10 || tok1 != tok2 {
		t.Fatalf("unexpected deterministic token: %q vs %q", tok1, tok2)
	}
}
