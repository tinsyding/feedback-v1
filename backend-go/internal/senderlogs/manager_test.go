package senderlogs

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"feedback-api/internal/config"
	"feedback-api/internal/senderctrl"
)

func TestChunkDeduplicationAndClientList(t *testing.T) {
	root := t.TempDir()
	ctrl := senderctrl.NewStore(root, config.NewLoader(root, ""))
	mgr := NewManager(root, ctrl)
	now := time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)
	mgr.nowFunc = func() time.Time { return now }

	cDir := mgr.ClientDir("2026-11-21", "Lab-PC#1")
	mgr.UpdateClientMeta(cDir, map[string]any{
		"hostname":     "Lab-PC",
		"os_user":      "teacher",
		"teacher_note": "张老师机",
	}, []any{"class1.json"}, "198.51.100.2", map[string]any{"running": true})

	sz1 := mgr.WriteChunk(cDir, "2026-11-21", "sender", 0, "line1\n")
	if sz1 != 6 {
		t.Fatalf("sz1 = %d, want 6", sz1)
	}
	// Overlapping chunk with offset=3 ("e1\nline2\n") should only append "line2\n"
	sz2 := mgr.WriteChunk(cDir, "2026-11-21", "sender", 3, "e1\nline2\n")
	if sz2 != 12 {
		t.Fatalf("sz2 = %d, want 12", sz2)
	}
	raw, _ := os.ReadFile(filepath.Join(cDir, "sender_2026-11-21.log"))
	if string(raw) != "line1\nline2\n" {
		t.Fatalf("unexpected log content: %q", string(raw))
	}

	dates, clients := mgr.ListClients("")
	if len(dates) != 1 || dates[0] != "2026-11-21" {
		t.Fatalf("unexpected dates: %v", dates)
	}
	if len(clients) != 1 || clients[0]["display_name"] != "张老师机 (Lab-PC/teacher)" {
		t.Fatalf("unexpected clients: %+v", clients)
	}
}
