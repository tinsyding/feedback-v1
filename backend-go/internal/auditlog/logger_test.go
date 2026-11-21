package auditlog

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDualLoggerAppendsJSONL(t *testing.T) {
	root := t.TempDir()
	logger := NewDualLogger(nil, root)
	fixed := time.Date(2026, 11, 21, 10, 30, 0, 0, time.UTC)
	logger.nowFunc = func() time.Time { return fixed }

	logger.Record(context.Background(), Entry{
		Level:     "action",
		Module:    "user_auth",
		Event:     "login_success",
		Operator:  "t101",
		Details:   map[string]any{"username": "t101", "message": "登录成功"},
		ClientIP:  "203.0.113.5",
		UserAgent: "TestAgent/1.0",
	})

	jsonlPath := filepath.Join(root, "data", "logs", "2026-11-21.jsonl")
	raw, err := os.ReadFile(jsonlPath)
	if err != nil {
		t.Fatalf("read jsonl failed: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 1 {
		t.Fatalf("expected 1 line, got %d", len(lines))
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &parsed); err != nil {
		t.Fatalf("invalid jsonl: %v", err)
	}
	if parsed["module"] != "user_auth" || parsed["event"] != "login_success" || parsed["operator"] != "t101" {
		t.Fatalf("unexpected log entry: %+v", parsed)
	}
}
