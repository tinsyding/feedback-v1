package senderctrl

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"feedback-api/internal/config"
)

func TestOverridesCommandsAndAckLifecycle(t *testing.T) {
	root := t.TempDir()
	st := NewStore(root, config.NewLoader(root, ""))
	now := time.Date(2026, 11, 21, 10, 0, 0, 0, time.UTC)
	st.nowFunc = func() time.Time { return now }

	// Set override with PHP enum values "api" and "always" + CJK truncation
	longNotice := strings.Repeat("重要通知", 150) // 600 runes
	longNote := strings.Repeat("备注信息", 60)    // 240 runes
	saved := st.SetOverrides("PC-01/win", map[string]any{
		"verifyMode":     "api",
		"snapshotPolicy": "always",
		"studentGapMin":  3.0,
		"studentGapMax":  1.0, // clamped to >= min
		"noticeMessage":  longNotice,
	}, longNote)
	if saved.ClientSlug != "PC-01_win" {
		t.Fatalf("unexpected slug: %q", saved.ClientSlug)
	}
	if saved.Overrides["verifyMode"] != "api" || saved.Overrides["snapshotPolicy"] != "always" || saved.Overrides["studentGapMax"] != 3.0 {
		t.Fatalf("unexpected overrides: %+v", saved.Overrides)
	}
	noticeStr, _ := saved.Overrides["noticeMessage"].(string)
	if len([]rune(noticeStr)) != 500 || !utf8.ValidString(noticeStr) {
		t.Fatalf("noticeMessage rune len=%d valid=%v", len([]rune(noticeStr)), utf8.ValidString(noticeStr))
	}
	if len([]rune(saved.Note)) != 200 || !utf8.ValidString(saved.Note) {
		t.Fatalf("Note rune len=%d valid=%v", len([]rune(saved.Note)), utf8.ValidString(saved.Note))
	}

	// Verify file path matches PHP data/sender_control/clients/<slug>.json
	expectedPath := filepath.Join(root, "data", "sender_control", "clients", "PC-01_win.json")
	if _, err := os.Stat(expectedPath); err != nil {
		t.Fatalf("expected control file at %s: %v", expectedPath, err)
	}

	// Legacy invalid Go enums ("cloud"/"all") must be rejected
	rejected := NormalizeOverrides(map[string]any{
		"verifyMode":     "cloud",
		"snapshotPolicy": "all",
	})
	if len(rejected) != 0 {
		t.Fatalf("expected invalid enums cloud/all to be rejected, got %+v", rejected)
	}

	// Unsupported command returns nil
	if cmd := st.EnqueueCommand("PC-01_win", "invalid_cmd", nil, "admin"); cmd != nil {
		t.Fatalf("expected nil for invalid cmd, got %+v", cmd)
	}

	// Enqueue & deduplicate same command type
	cmd1 := st.EnqueueCommand("PC-01_win", "sync_logs", nil, "admin")
	cmd2 := st.EnqueueCommand("PC-01_win", "sync_logs", map[string]any{"days": 3}, "admin")
	if cmd1 == nil || cmd2 == nil || cmd1.CmdID == cmd2.CmdID {
		t.Fatalf("expected second sync_logs to replace first")
	}

	eff := st.BuildEffectiveControl("PC-01_win", true)
	pending := eff["pending_commands"].([]map[string]any)
	if len(pending) != 1 || pending[0]["cmd_id"] != cmd2.CmdID {
		t.Fatalf("expected only cmd2 pending, got %+v", pending)
	}
	if eff["server_time"] != "2026-11-21 18:00:00" {
		t.Fatalf("expected server_time in Asia/Shanghai, got %v", eff["server_time"])
	}

	// Ack command with long CJK message
	acked := st.AcknowledgeCommands("PC-01_win", []any{
		map[string]any{"cmd_id": cmd2.CmdID, "status": "ok", "message": strings.Repeat("完成", 200)},
	})
	if acked != 1 {
		t.Fatalf("acked = %d, want 1", acked)
	}
	eff2 := st.BuildEffectiveControl("PC-01_win", true)
	if len(eff2["pending_commands"].([]map[string]any)) != 0 {
		t.Fatalf("expected 0 pending after ack")
	}
}
