package captcha

import (
	"bytes"
	"image/png"
	"strings"
	"testing"
)

func TestGenerateValidPNGAndCharset(t *testing.T) {
	code, data, err := Generate()
	if err != nil {
		t.Fatalf("Generate failed: %v", err)
	}
	if len(code) != CodeLen {
		t.Fatalf("code length = %d, want %d", len(code), CodeLen)
	}
	for i := 0; i < len(code); i++ {
		if !strings.ContainsRune(Charset, rune(code[i])) {
			t.Fatalf("code %q contains char outside Charset", code)
		}
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("invalid PNG output: %v", err)
	}
	b := img.Bounds()
	if b.Dx() != Width || b.Dy() != Height {
		t.Fatalf("dimensions = %dx%d, want %dx%d", b.Dx(), b.Dy(), Width, Height)
	}
}
