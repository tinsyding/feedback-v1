package textutil

import (
	"bytes"
	"testing"
	"unicode/utf8"
)

func TestTruncateRunes(t *testing.T) {
	if got := TruncateRunes("你好世界abc", 0); got != "" {
		t.Fatalf("maxRunes=0 => %q", got)
	}
	if got := TruncateRunes("你好世界abc", 4); got != "你好世界" {
		t.Fatalf("maxRunes=4 => %q", got)
	}
	if got := TruncateRunes("你好", 10); got != "你好" {
		t.Fatalf("maxRunes=10 => %q", got)
	}
}

func TestTruncateUTF8Bytes(t *testing.T) {
	if got := TruncateUTF8Bytes("你好世界", 0); got != "" {
		t.Fatalf("maxBytes=0 => %q", got)
	}
	// Each CJK char is 3 bytes: maxBytes=5 must keep only "你" (3 bytes), never splitting "好".
	got := TruncateUTF8Bytes("你好世界", 5)
	if got != "你" || !utf8.ValidString(got) || len(got) > 5 {
		t.Fatalf("maxBytes=5 => %q (len=%d, valid=%v)", got, len(got), utf8.ValidString(got))
	}
	got2 := TruncateUTF8Bytes("ab你好", 5)
	if got2 != "ab你" || !utf8.ValidString(got2) || len(got2) != 5 {
		t.Fatalf("ab你好 maxBytes=5 => %q", got2)
	}
	if got3 := TruncateUTF8Bytes("abc", 10); got3 != "abc" {
		t.Fatalf("short string => %q", got3)
	}
}

func TestEncodeGBK(t *testing.T) {
	if b, ok := EncodeGBK(""); !ok || len(b) != 0 {
		t.Fatalf("empty => (%v, %v)", b, ok)
	}
	b, ok := EncodeGBK("张三")
	if !ok || !bytes.Equal(b, []byte{0xD5, 0xC5, 0xC8, 0xFD}) {
		t.Fatalf("EncodeGBK(张三) => (%x, %v)", b, ok)
	}
	if _, ok := EncodeGBK("张三😀"); ok {
		t.Fatal("expected emoji outside GBK to return ok=false")
	}
}
