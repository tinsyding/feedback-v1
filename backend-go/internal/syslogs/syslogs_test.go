package syslogs

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestIngestLimiterWindow(t *testing.T) {
	lim := NewIngestLimiter()
	now := time.Unix(1700000000, 0)
	lim.nowFunc = func() time.Time { return now }

	for i := 0; i < 3; i++ {
		if !lim.Allow("ip:1.2.3.4", 3) {
			t.Fatalf("attempt %d should be allowed", i+1)
		}
	}
	if lim.Allow("ip:1.2.3.4", 3) {
		t.Fatal("4th attempt within 60s should be blocked")
	}
	now = now.Add(61 * time.Second)
	if !lim.Allow("ip:1.2.3.4", 3) {
		t.Fatal("attempt after 60s window should be allowed")
	}
}

func TestCSVExportBOMAndFormulaSanitization(t *testing.T) {
	var buf bytes.Buffer
	err := WriteExportCSV(&buf, []ExportRow{
		{
			CreatedAt:  "2026-11-21 10:00:00",
			Level:      "error",
			Module:     "viewer",
			Event:      "render_fail",
			Operator:   "=CMD|'/C calc'!A0",
			Details:    map[string]any{"message": "+123 danger"},
			Context:    map[string]any{"page": "viewer.html", "subject": "数学"},
			ClientIP:   "203.0.113.1",
			ClientInfo: map[string]any{"userAgent": "Mozilla/5.0"},
		},
	})
	if err != nil {
		t.Fatalf("WriteExportCSV failed: %v", err)
	}
	raw := buf.Bytes()
	if len(raw) < 3 || raw[0] != 0xEF || raw[1] != 0xBB || raw[2] != 0xBF {
		t.Fatal("expected UTF-8 BOM prefix")
	}
	text := string(raw[3:])
	if !strings.Contains(text, "'=CMD|'/C calc'!A0") {
		t.Fatalf("expected formula cell to be prefixed with single quote: %s", text)
	}
	if !strings.Contains(text, "'+123 danger") {
		t.Fatalf("expected + cell to be prefixed with single quote: %s", text)
	}
	if !strings.Contains(text, "错误") {
		t.Fatalf("expected Chinese level label 错误: %s", text)
	}
}
