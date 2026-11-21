package retest

import (
	"crypto/rand"
	"fmt"
	"html"
	"math/big"
	"strings"
)

const svgCaptchaCharset = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"

var (
	svgNoisePalette = []string{"#94a3b8", "#64748b", "#3b82f6", "#8b5cf6", "#0ea5e9"}
	svgTextPalette  = []string{"#1e293b", "#1d4ed8", "#6d28d9", "#047857", "#b45309"}
)

func cryptoRandInt(minVal, maxVal int) int {
	if maxVal <= minVal {
		return minVal
	}
	n, err := rand.Int(rand.Reader, big.NewInt(int64(maxVal-minVal+1)))
	if err != nil {
		return minVal
	}
	return minVal + int(n.Int64())
}

// GenerateSVGCaptcha produces a 4-character code and its 120x42 SVG markup.
// Mirrors PHP retest.php generateSvgCaptcha() & action=captcha.
func GenerateSVGCaptcha() (code string, svg string) {
	var codeBuf strings.Builder
	for i := 0; i < 4; i++ {
		idx := cryptoRandInt(0, len(svgCaptchaCharset)-1)
		codeBuf.WriteByte(svgCaptchaCharset[idx])
	}
	code = codeBuf.String()
	svg = RenderSVGCaptcha(code)
	return code, svg
}

// RenderSVGCaptcha renders the 120x42 SVG captcha for a given code.
func RenderSVGCaptcha(code string) string {
	const width = 120
	const height = 42

	var b strings.Builder
	fmt.Fprintf(&b, `<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">`, width, height, width, height)
	b.WriteString(`<rect width="100%" height="100%" fill="#f8fafc" rx="8"/>`)

	for i := 0; i < 4; i++ {
		x1 := cryptoRandInt(0, width)
		y1 := cryptoRandInt(0, height)
		x2 := cryptoRandInt(0, width)
		y2 := cryptoRandInt(0, height)
		col := svgNoisePalette[cryptoRandInt(0, len(svgNoisePalette)-1)]
		stroke := cryptoRandInt(1, 2)
		fmt.Fprintf(&b, `<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="%s" stroke-width="%d" stroke-opacity="0.45"/>`, x1, y1, x2, y2, col, stroke)
	}

	for i := 0; i < 18; i++ {
		cx := cryptoRandInt(2, width-2)
		cy := cryptoRandInt(2, height-2)
		r := cryptoRandInt(1, 2)
		col := svgNoisePalette[cryptoRandInt(0, len(svgNoisePalette)-1)]
		fmt.Fprintf(&b, `<circle cx="%d" cy="%d" r="%d" fill="%s" fill-opacity="0.5"/>`, cx, cy, r, col)
	}

	const xOffset = 12
	for idx, ch := range []rune(code) {
		col := svgTextPalette[cryptoRandInt(0, len(svgTextPalette)-1)]
		rot := cryptoRandInt(-15, 15)
		x := xOffset + idx*26
		y := cryptoRandInt(28, 32)
		fmt.Fprintf(&b, `<text x="%d" y="%d" fill="%s" font-size="24" font-weight="bold" font-family="Arial, Helvetica, sans-serif" transform="rotate(%d, %d, %d)">%s</text>`,
			x, y, col, rot, x, y, html.EscapeString(string(ch)))
	}

	b.WriteString(`</svg>`)
	return b.String()
}
