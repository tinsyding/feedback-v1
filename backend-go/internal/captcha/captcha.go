package captcha

import (
	"bytes"
	"crypto/rand"
	"image"
	"image/color"
	"image/png"
	"math/big"
)

const (
	// Charset matches PHP auth.php anti-confusion alphabet (no 0/O/1/I).
	Charset = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
	Width   = 130
	Height  = 42
	CodeLen = 4
)

// 5x7 crisp uppercase bitmap glyphs for Charset, scaled 3x (15x21) during rendering.
var glyphs5x7 = map[byte][7]uint8{
	'2': {0x0E, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1F},
	'3': {0x1E, 0x01, 0x01, 0x0E, 0x01, 0x01, 0x1E},
	'4': {0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02},
	'5': {0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E},
	'6': {0x0E, 0x10, 0x10, 0x1E, 0x11, 0x11, 0x0E},
	'7': {0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08},
	'8': {0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E},
	'9': {0x0E, 0x11, 0x11, 0x0F, 0x01, 0x01, 0x0E},
	'A': {0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11},
	'B': {0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E},
	'C': {0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E},
	'D': {0x1C, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1C},
	'E': {0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F},
	'F': {0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10},
	'G': {0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F},
	'H': {0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11},
	'J': {0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C},
	'K': {0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11},
	'L': {0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F},
	'M': {0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11},
	'N': {0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11},
	'P': {0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10},
	'Q': {0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D},
	'R': {0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11},
	'S': {0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E},
	'T': {0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04},
	'U': {0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E},
	'V': {0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04},
	'W': {0x11, 0x11, 0x11, 0x15, 0x15, 0x1B, 0x11},
	'X': {0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11},
	'Y': {0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04},
	'Z': {0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F},
}

var letterPalette = []color.RGBA{
	{R: 56, G: 189, B: 248, A: 255},  // Sky
	{R: 129, G: 140, B: 248, A: 255}, // Indigo
	{R: 168, G: 85, B: 247, A: 255},  // Purple
	{R: 52, G: 211, B: 153, A: 255},  // Emerald
	{R: 251, G: 191, B: 36, A: 255},  // Amber
}

func randInt(min, max int) int {
	if max <= min {
		return min
	}
	n, err := rand.Int(rand.Reader, big.NewInt(int64(max-min+1)))
	if err != nil {
		return min
	}
	return min + int(n.Int64())
}

// Generate creates a 4-character anti-confusion code and renders a 130x42 dark-theme PNG.
func Generate() (string, []byte, error) {
	codeBuf := make([]byte, CodeLen)
	for i := 0; i < CodeLen; i++ {
		codeBuf[i] = Charset[randInt(0, len(Charset)-1)]
	}
	code := string(codeBuf)
	pngBytes, err := RenderPNG(code)
	if err != nil {
		return "", nil, err
	}
	return code, pngBytes, nil
}

// RenderPNG renders the given code into a 130x42 dark PNG image matching PHP auth.php styling.
func RenderPNG(code string) ([]byte, error) {
	img := image.NewRGBA(image.Rect(0, 0, Width, Height))
	bg := color.RGBA{R: 24, G: 24, B: 27, A: 255}
	for y := 0; y < Height; y++ {
		for x := 0; x < Width; x++ {
			img.SetRGBA(x, y, bg)
		}
	}

	// 60 random noise dots
	for i := 0; i < 60; i++ {
		dot := color.RGBA{
			R: uint8(randInt(45, 95)),
			G: uint8(randInt(45, 95)),
			B: uint8(randInt(70, 130)),
			A: 255,
		}
		img.SetRGBA(randInt(0, Width-1), randInt(0, Height-1), dot)
	}

	// 3 interference lines
	for i := 0; i < 3; i++ {
		lineCol := color.RGBA{
			R: uint8(randInt(70, 140)),
			G: uint8(randInt(90, 170)),
			B: uint8(randInt(130, 230)),
			A: 255,
		}
		drawLine(img, randInt(0, 20), randInt(5, Height-5), randInt(Width-20, Width-1), randInt(5, Height-5), lineCol)
	}

	// Render 4 characters at 3x scale (15x21 pixels each)
	const scale = 3
	spacing := (Width - 24) / CodeLen
	for i := 0; i < len(code); i++ {
		ch := code[i]
		glyph, ok := glyphs5x7[ch]
		if !ok {
			continue
		}
		col := letterPalette[i%len(letterPalette)]
		x0 := 14 + i*spacing + randInt(-2, 3)
		y0 := (Height-7*scale)/2 + randInt(-3, 3)
		for row := 0; row < 7; row++ {
			bits := glyph[row]
			for bit := 0; bit < 5; bit++ {
				if (bits>>(4-bit))&1 == 0 {
					continue
				}
				for dy := 0; dy < scale; dy++ {
					for dx := 0; dx < scale; dx++ {
						px := x0 + bit*scale + dx
						py := y0 + row*scale + dy
						if px >= 0 && px < Width && py >= 0 && py < Height {
							img.SetRGBA(px, py, col)
						}
					}
				}
			}
		}
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func drawLine(img *image.RGBA, x0, y0, x1, y1 int, c color.RGBA) {
	dx := x1 - x0
	if dx < 0 {
		dx = -dx
	}
	dy := y1 - y0
	if dy < 0 {
		dy = -dy
	}
	sx := -1
	if x0 < x1 {
		sx = 1
	}
	sy := -1
	if y0 < y1 {
		sy = 1
	}
	err := dx - dy
	for {
		if x0 >= 0 && x0 < Width && y0 >= 0 && y0 < Height {
			img.SetRGBA(x0, y0, c)
		}
		if x0 == x1 && y0 == y1 {
			break
		}
		e2 := 2 * err
		if e2 > -dy {
			err -= dy
			x0 += sx
		}
		if e2 < dx {
			err += dx
			y0 += sy
		}
	}
}
