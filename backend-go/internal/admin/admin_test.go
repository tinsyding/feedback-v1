package admin

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"feedback-api/internal/textutil"
)

func TestHiddenTablesAndIdentifiers(t *testing.T) {
	for _, tbl := range []string{"app_sessions", "AUTH_RATE_LIMITS", " schema_migrations "} {
		if !IsHiddenTable(tbl) {
			t.Fatalf("expected %q to be hidden", tbl)
		}
	}
	if IsHiddenTable("student_records") {
		t.Fatal("student_records should not be hidden")
	}
	if !IsValidIdentifier("student_records_2026") {
		t.Fatal("expected valid identifier")
	}
	if IsValidIdentifier("users; DROP TABLE users") || IsValidIdentifier("") {
		t.Fatal("expected invalid identifier")
	}
	if !IsNumericString("12345") || !IsNumericString("-42.5") {
		t.Fatalf("expected standard numbers to pass IsNumericString")
	}
	for _, bad := range []string{"", "NaN", "nan", "Inf", "+Inf", "-inf", "1_000", "12abc"} {
		if IsNumericString(bad) {
			t.Fatalf("IsNumericString(%q) = true, want false", bad)
		}
	}
}

func TestParseErrorQuestions(t *testing.T) {
	js, cnt := ParseErrorQuestions("1, 3、5，7 9")
	if js != "[1,3,5,7,9]" || cnt != 5 {
		t.Fatalf("got (%q, %d)", js, cnt)
	}
	js2, cnt2 := ParseErrorQuestions("[2, 4, 0]")
	if js2 != "[2,4]" || cnt2 != 2 {
		t.Fatalf("got (%q, %d)", js2, cnt2)
	}
	if ptr, isNull := ParsePreviewErrorQuestions(""); !isNull || ptr != nil {
		t.Fatalf("expected null preview_error_questions for empty string")
	}
	if ptr, isNull := ParsePreviewErrorQuestions("[]"); isNull || ptr == nil || *ptr != "[]" {
		t.Fatalf("expected [] for preview_error_questions")
	}
}

func TestCleanTokenInput(t *testing.T) {
	cases := map[string]string{
		"https://feedback.wxjifang.cn/retest.html?token=abc1234567&foo=1": "abc1234567",
		"  \"abc1234567\"  ": "abc1234567",
		"retest.html?TOKEN=xyz%5F999#top": "xyz_999",
	}
	for in, want := range cases {
		if got := CleanTokenInput(in); got != want {
			t.Fatalf("CleanTokenInput(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestGradeAliasCandidates(t *testing.T) {
	got := GradeAliasCandidates("初一数学")
	wantContains := []string{"初一数学", "初一", "七年级", "七年级先学"}
	for _, w := range wantContains {
		found := false
		for _, g := range got {
			if g == w {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("expected %q in %v", w, got)
		}
	}
}

func TestDecodeSourceFiles(t *testing.T) {
	got := DecodeSourceFiles("a.csv\nb.csv\na.csv\n")
	want := []string{"a.csv", "b.csv"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestFindSourceFile(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "20261121")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	f1 := filepath.Join(sub, "20261121_100000_homework_1.csv")
	f2 := filepath.Join(sub, "20261121_110000_homework_1.csv")
	_ = os.WriteFile(f1, []byte("姓名,分数\n李四,90\n"), 0o644)
	_ = os.WriteFile(f2, []byte("姓名,分数\n张三,95\n"), 0o644)

	idx := `{"orig":"课后巩固1.csv","rel":"20261121/20261121_110000_homework_1.csv","ts":1795143600,"type":"homework"}` + "\n"
	_ = os.WriteFile(filepath.Join(dir, "index.jsonl"), []byte(idx), 0o644)

	match, ok := FindSourceFile([]string{dir}, "课后巩固1.csv", "张三", []int64{1795144000})
	if !ok {
		t.Fatal("expected match")
	}
	if match.ArchivedName != "20261121_110000_homework_1.csv" {
		t.Fatalf("unexpected match: %+v", match)
	}

	// Verify GBK-encoded CSV student matching and traversal rejection ("..").
	if _, ok := FindSourceFile([]string{dir}, "..", "张三", nil); ok {
		t.Fatal("expected FindSourceFile(\"..\") to be rejected")
	}
	gbkDir := t.TempDir()
	gbkSub := filepath.Join(gbkDir, "20261121")
	if err := os.MkdirAll(gbkSub, 0o755); err != nil {
		t.Fatal(err)
	}
	gbkName, gbkOK := textutil.EncodeGBK("王五")
	if !gbkOK {
		t.Fatal("expected EncodeGBK(王五) to succeed")
	}
	otherGBK, _ := textutil.EncodeGBK("赵六")
	gf1 := filepath.Join(gbkSub, "20261121_110500_homework_2.csv")
	gf2 := filepath.Join(gbkSub, "20261121_100500_homework_2.csv")
	// gf1 is newer (higher fallback score) without matching student; gf2 contains GBK-encoded 王五.
	_ = os.WriteFile(gf1, append([]byte("name,score\n"), otherGBK...), 0o644)
	_ = os.WriteFile(gf2, append([]byte("name,score\n"), gbkName...), 0o644)
	gbkIdx := `{"orig":"作业2.csv","rel":"20261121/20261121_110500_homework_2.csv","ts":1795143900,"type":"homework"}` + "\n" +
		`{"orig":"作业2.csv","rel":"20261121/20261121_100500_homework_2.csv","ts":1795140300,"type":"homework"}` + "\n"
	_ = os.WriteFile(filepath.Join(gbkDir, "index.jsonl"), []byte(gbkIdx), 0o644)

	gbkMatch, ok := FindSourceFile([]string{gbkDir}, "作业2.csv", "王五", []int64{1795144000})
	if !ok {
		t.Fatal("expected GBK match")
	}
	if gbkMatch.ArchivedName != "20261121_100500_homework_2.csv" {
		t.Fatalf("expected GBK content bonus to pick gf2, got %+v", gbkMatch)
	}
}
