package senderctrl

import (
	"testing"
	"time"

	"feedback-api/internal/config"
)

func TestOverridesCommandsAndAckLifecycle(t *testing.T) {
	root := t.TempDir()
	st := NewStore(root, config.NewLoader(root, ""))
	now := time.Date(2026, 11, 21, 10, 0, 0, 0, time.UTC)
	st.nowFunc = func() time.Time { return now }

	// Set override
	saved := st.SetOverrides("PC-01/win", map[string]any{
		"verifyMode":    "local",
		"studentGapMin": 3.0,
		"studentGapMax": 1.0, // clamped to >= min
		"noticeMessage": "本机测试通知",
	}, "备注1")
	if saved.ClientSlug != "PC-01_win" {
		t.Fatalf("unexpected slug: %q", saved.ClientSlug)
	}
	if saved.Overrides["verifyMode"] != "local" || saved.Overrides["studentGapMax"] != 3.0 {
		t.Fatalf("unexpected overrides: %+v", saved.Overrides)
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

	// Ack command
	acked := st.AcknowledgeCommands("PC-01_win", []any{
		map[string]any{"cmd_id": cmd2.CmdID, "status": "ok", "message": "done"},
	})
	if acked != 1 {
		t.Fatalf("acked = %d, want 1", acked)
	}
	eff2 := st.BuildEffectiveControl("PC-01_win", true)
	if len(eff2["pending_commands"].([]map[string]any)) != 0 {
		t.Fatalf("expected 0 pending after ack")
	}
}
