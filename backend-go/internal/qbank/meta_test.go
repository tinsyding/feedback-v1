package qbank

import (
	"reflect"
	"testing"
)

func TestCleanTopicAndSanitizeMeta(t *testing.T) {
	if got := CleanTopic("  一元一次方程，。；：—  "); got != "一元一次方程" {
		t.Fatalf("CleanTopic = %q", got)
	}

	meta := SanitizeQuestionMeta(`{
		"groupNums": [3, 1, 3, 0, 999, 2],
		"box": {"x": -0.2, "y": 1.5, "w": 0.001, "h": 0.123456, "pageOffset": -2},
		"boxes": [
			{"x": 0.03, "y": 0.8, "w": 0.94, "h": 0.15, "pageOffset": 0},
			{"x": 0.03, "y": 0.05, "w": 0.94, "h": 0.12, "pageOffset": 1}
		],
		"answerBoxes": [
			{"x": 0.03, "y": 0.7, "w": 0.94, "h": 0.2, "pageOffset": 0},
			{"x": 0.03, "y": 0.04, "w": 0.94, "h": 0.18, "pageOffset": 1}
		],
		"mode": "region_crop",
		"regions": [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4, "pageOffset": 1}]
	}`)
	if meta == nil {
		t.Fatal("expected non-nil sanitized meta")
	}
	if !reflect.DeepEqual(meta["groupNums"], []int{1, 2, 3}) {
		t.Fatalf("groupNums = %#v", meta["groupNums"])
	}
	box := meta["box"].(map[string]any)
	if box["x"] != 0.0 || box["y"] != 1.0 || box["w"] != 0.005 || box["h"] != 0.1235 || box["pageOffset"] != 0 {
		t.Fatalf("unexpected clamped box: %#v", box)
	}
	if boxes, ok := meta["boxes"].([]map[string]any); !ok || len(boxes) != 2 || boxes[1]["pageOffset"] != 1 {
		t.Fatalf("unexpected boxes: %#v", meta["boxes"])
	}
	if ansBoxes, ok := meta["answerBoxes"].([]map[string]any); !ok || len(ansBoxes) != 2 || ansBoxes[1]["pageOffset"] != 1 {
		t.Fatalf("unexpected answerBoxes: %#v", meta["answerBoxes"])
	}
	if meta["mode"] != "region_crop" {
		t.Fatalf("mode = %v", meta["mode"])
	}
}

func TestIsValidManagedPDFPath(t *testing.T) {
	if fn, ok := IsValidManagedPDFPath("data/pdfs/pdf_2026_abc-1.pdf"); !ok || fn != "pdf_2026_abc-1.pdf" {
		t.Fatalf("expected valid pdf path, got (%q, %v)", fn, ok)
	}
	for _, bad := range []string{
		"data/pdfs/../config.json",
		"data/pdfs/other.pdf",
		"data/uploads/pdf_1.pdf",
		"/etc/passwd",
	} {
		if _, ok := IsValidManagedPDFPath(bad); ok {
			t.Fatalf("expected %q to be rejected", bad)
		}
	}
}
