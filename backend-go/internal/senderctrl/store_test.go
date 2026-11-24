package senderctrl

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
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
	saved, err := st.SetOverrides("PC-01/win", map[string]any{
		"verifyMode":     "api",
		"snapshotPolicy": "always",
		"studentGapMin":  3.0,
		"studentGapMax":  1.0, // clamped to >= min
		"noticeMessage":  longNotice,
	}, longNote)
	if err != nil {
		t.Fatalf("SetOverrides failed: %v", err)
	}
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
	if cmd, err := st.EnqueueCommand("PC-01_win", "invalid_cmd", nil, "admin"); err != nil || cmd != nil {
		t.Fatalf("expected (nil, nil) for invalid cmd, got (%+v, %v)", cmd, err)
	}

	// Enqueue & deduplicate same command type
	cmd1, err1 := st.EnqueueCommand("PC-01_win", "sync_logs", nil, "admin")
	cmd2, err2 := st.EnqueueCommand("PC-01_win", "sync_logs", map[string]any{"days": 3}, "admin")
	if err1 != nil || err2 != nil || cmd1 == nil || cmd2 == nil || cmd1.CmdID == cmd2.CmdID {
		t.Fatalf("expected second sync_logs to replace first (err1=%v err2=%v)", err1, err2)
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
	acked, err := st.AcknowledgeCommands("PC-01_win", []any{
		map[string]any{"cmd_id": cmd2.CmdID, "status": "ok", "message": strings.Repeat("完成", 200)},
	})
	if err != nil || acked != 1 {
		t.Fatalf("acked = %d (err=%v), want 1", acked, err)
	}
	eff2 := st.BuildEffectiveControl("PC-01_win", true)
	if len(eff2["pending_commands"].([]map[string]any)) != 0 {
		t.Fatalf("expected 0 pending after ack")
	}
}

func TestLoadPHPLegacyEmptyArrayJSON(t *testing.T) {
	root := t.TempDir()
	ctrlDir := filepath.Join(root, "data", "sender_control", "clients")
	if err := os.MkdirAll(ctrlDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// PHP json_encode encodes empty overrides/params arrays as [] rather than {}
	phpJSON := `{
		"client_slug": "legacy_pc",
		"overrides": [],
		"note": "keep this note",
		"updated_at": "2026-11-21 09:00:00",
		"commands": [
			{
				"cmd_id": "cmd_php_1",
				"type": "stop_batch",
				"params": [],
				"created_at": "2026-11-21 09:00:00",
				"created_ts": 1763715600,
				"created_by": "admin",
				"delivered_at": "",
				"acked_at": "",
				"ack_status": "",
				"ack_message": ""
			}
		]
	}`
	if err := os.WriteFile(filepath.Join(ctrlDir, "legacy_pc.json"), []byte(phpJSON), 0o644); err != nil {
		t.Fatal(err)
	}

	st := NewStore(root, config.NewLoader(root, ""))
	loaded := st.LoadClientState("legacy_pc")
	if loaded.Note != "keep this note" {
		t.Fatalf("expected note preserved from PHP JSON, got %q", loaded.Note)
	}
	if len(loaded.Commands) != 1 || loaded.Commands[0].CmdID != "cmd_php_1" {
		t.Fatalf("expected pending PHP command preserved, got %+v", loaded.Commands)
	}
	if loaded.Commands[0].Params == nil {
		t.Fatal("expected Params initialized to empty map, got nil")
	}
}

func TestSenderCtrlFlockSerializesConcurrentStores(t *testing.T) {
	root := t.TempDir()
	loader := config.NewLoader(root, "")

	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			st := NewStore(root, loader)
			if _, err := st.SetOverrides("pc-concurrent", map[string]any{
				"verifyMode": "api",
			}, fmt.Sprintf("note-%d", idx)); err != nil {
				t.Errorf("SetOverrides(%d): %v", idx, err)
			}
			if _, err := st.EnqueueCommand("pc-concurrent", "sync_logs", map[string]any{"idx": idx}, "admin"); err != nil {
				t.Errorf("EnqueueCommand(%d): %v", idx, err)
			}
			eff := st.BuildEffectiveControl("pc-concurrent", true)
			if eff["client_slug"] != "pc-concurrent" {
				t.Errorf("unexpected client_slug: %v", eff["client_slug"])
			}
		}(i)
	}
	wg.Wait()

	lockFile := filepath.Join(root, "data", "sender_control", ".sender_ctrl.lock")
	if _, err := os.Stat(lockFile); err != nil {
		t.Fatalf("expected .sender_ctrl.lock to exist: %v", err)
	}
	final := NewStore(root, loader).LoadClientState("pc-concurrent")
	if final.Overrides["verifyMode"] != "api" || len(final.Commands) != 1 {
		t.Fatalf("unexpected final state after concurrent writes: %+v", final)
	}
}
