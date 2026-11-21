package retestkeys

import (
	"reflect"
	"testing"
)

func TestBuildStudentKey(t *testing.T) {
	if got := BuildStudentKey(" 1001 ", " 张三 ", " 七年级 ", " 数学 "); got != "1001_张三_七年级_数学" {
		t.Fatalf("got %q", got)
	}
	if got := BuildStudentKey("", " 张三 ", "七年级", "数学"); got != "张三" {
		t.Fatalf("expected name-only fallback, got %q", got)
	}
	if got := BuildStudentKey("1001", "张三", "", "数学"); got != "1001_张三" {
		t.Fatalf("expected legacy fallback when grade empty, got %q", got)
	}
	if got := BuildStudentKey("1001", "张三", "七年级", ""); got != "1001_张三" {
		t.Fatalf("expected legacy fallback when subject empty, got %q", got)
	}
}

func TestLegacyStudentKey(t *testing.T) {
	if got := LegacyStudentKey("1001", "张三"); got != "1001_张三" {
		t.Fatalf("got %q", got)
	}
	if got := LegacyStudentKey("", "张三"); got != "张三" {
		t.Fatalf("got %q", got)
	}
}

func TestStudentKeyCandidates(t *testing.T) {
	got := StudentKeyCandidates("1001", "张三", "七年级", "数学")
	want := []string{"1001_张三_七年级_数学", "1001_张三"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	got2 := StudentKeyCandidates("", "张三", "七年级", "数学")
	want2 := []string{"张三"}
	if !reflect.DeepEqual(got2, want2) {
		t.Fatalf("got %v, want %v", got2, want2)
	}
}

func TestIsLegacyNameOnlyKey(t *testing.T) {
	if !IsLegacyNameOnlyKey("", "张三") {
		t.Fatal("empty key with non-empty name should be legacy name-only")
	}
	if !IsLegacyNameOnlyKey("张三", "张三") {
		t.Fatal("key==name should be legacy name-only")
	}
	if IsLegacyNameOnlyKey("1001_张三", "张三") {
		t.Fatal("id_name key should not be legacy name-only")
	}
	if IsLegacyNameOnlyKey("", "") {
		t.Fatal("empty name should return false")
	}
}
