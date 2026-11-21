package admin

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
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
}
