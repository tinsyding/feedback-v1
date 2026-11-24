package senderlogs

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

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
	meta1 := mgr.UpdateClientMeta(cDir, map[string]any{
		"client_id":    "cid-001",
		"platform":     "Windows-11",
		"hostname":     "Lab-PC",
		"os_user":      "teacher",
		"teacher_note": "张老师机",
	}, []any{"class1.json"}, "198.51.100.2", map[string]any{
		"running":        true,
		"processed":      -3, // clamped to 0
		"total":          15,
		"current_name":   strings.Repeat("学生姓名", 20), // >60 runes -> truncated safely
		"verify_mode":    "api",
		"policy_version": 2,
	})
	if meta1["client_id"] != "cid-001" || meta1["client_slug"] != "Lab-PC_1" || meta1["platform"] != "Windows-11" {
		t.Fatalf("unexpected meta identity fields: %+v", meta1)
	}
	if meta1["operator"] != "张老师机@Lab-PC" {
		t.Fatalf("operator = %q, want 张老师机@Lab-PC", meta1["operator"])
	}
	rt := meta1["runtime_state"].(map[string]any)
	if rt["processed"] != 0 || rt["total"] != 15 || rt["updated_at"] != "2026-11-21 20:00:00" {
		t.Fatalf("unexpected sanitized runtime_state: %+v", rt)
	}
	if cn := rt["current_name"].(string); len([]rune(cn)) != 60 || !utf8.ValidString(cn) {
		t.Fatalf("current_name rune len=%d valid=%v", len([]rune(cn)), utf8.ValidString(cn))
	}

	// Second UpdateClientMeta merges active_files and retains tail 20 without losing class1.json
	batch2 := make([]any, 0, 22)
	for i := 1; i <= 22; i++ {
		batch2 = append(batch2, fmt.Sprintf("f%02d.json", i))
	}
	meta2 := mgr.UpdateClientMeta(cDir, map[string]any{}, batch2, "198.51.100.2", nil)
	files := meta2["active_files"].([]string)
	if len(files) != 20 || files[0] != "f03.json" || files[19] != "f22.json" {
		t.Fatalf("expected tail 20 active_files, got %v", files)
	}

	sz1 := mgr.WriteChunk(cDir, "2026-11-21", "sender", 0, "line1\n")
	if sz1 != 6 {
		t.Fatalf("sz1 = %d, want 6", sz1)
	}
	sz2 := mgr.WriteChunk(cDir, "2026-11-21", "sender", 3, "e1\nline2\n")
	if sz2 != 12 {
		t.Fatalf("sz2 = %d, want 12", sz2)
	}
	raw, _ := os.ReadFile(filepath.Join(cDir, "sender_2026-11-21.log"))
	if string(raw) != "line1\nline2\n" {
		t.Fatalf("unexpected log content: %q", string(raw))
	}

	// AppendBatchSummary, AppendLogText, SaveSnapshot, LogFilePath, SnapshotImagePath
	mgr.AppendBatchSummary(cDir, map[string]any{"stopped": false, "counts": map[string]any{"sent": 5}})
	mgr.AppendLogText(cDir, "2026-11-21", "error", "err line 1\n")
	safePrefix := SanitizePrefix("../../20261121_120000_张老师", now)
	if strings.Contains(safePrefix, "..") || strings.Contains(safePrefix, "/") {
		t.Fatalf("unsafe prefix: %q", safePrefix)
	}
	if err := mgr.SaveSnapshot(cDir, safePrefix, []byte("PNG"), []byte("ANN"), map[string]any{"target_name": "张三"}); err != nil {
		t.Fatalf("SaveSnapshot: %v", err)
	}

	logP, _, _, fname := mgr.LogFilePath("2026-11-21", "Lab-PC#1", "error")
	if fname != "error_2026-11-21.log" || !strings.HasSuffix(logP, filepath.Join("2026-11-21", "Lab-PC_1", "error_2026-11-21.log")) {
		t.Fatalf("LogFilePath = (%q, %q)", logP, fname)
	}
	snapP := mgr.SnapshotImagePath("2026-11-21", "Lab-PC#1", safePrefix, "annotated")
	if !strings.HasSuffix(snapP, filepath.Join("snapshots", safePrefix, "annotated.png")) {
		t.Fatalf("SnapshotImagePath = %q", snapP)
	}

	dates, clients := mgr.ListClients("")
	if len(dates) != 1 || dates[0] != "2026-11-21" {
		t.Fatalf("unexpected dates: %v", dates)
	}
	if len(clients) != 1 || clients[0]["display_name"] != "张老师机 (Lab-PC/teacher)" {
		t.Fatalf("unexpected clients: %+v", clients)
	}
	batches := clients[0]["batches"].([]map[string]any)
	snaps := clients[0]["snapshots"].([]map[string]any)
	if len(batches) != 1 || len(snaps) != 1 || snaps[0]["has_annotated"] != true {
		t.Fatalf("unexpected batches/snapshots: batches=%+v snaps=%+v", batches, snaps)
	}

	// CleanupOld removes folders older than retentionDays and keeps today
	oldDir := mgr.ClientDir("2026-10-01", "Lab-PC#1")
	if err := os.MkdirAll(oldDir, 0o755); err != nil {
		t.Fatal(err)
	}
	mgr.CleanupOld(30)
	if _, err := os.Stat(filepath.Join(mgr.baseDir(), "2026-10-01")); !os.IsNotExist(err) {
		t.Fatalf("expected old date directory 2026-10-01 to be deleted")
	}
	if _, err := os.Stat(cDir); err != nil {
		t.Fatalf("expected current date directory to remain: %v", err)
	}

	// WriteChunk advances curSize/skip cleanly past mid-UTF-8 rune boundaries
	utf8Dir := mgr.ClientDir("2026-11-22", "utf8-pc")
	if err := os.MkdirAll(utf8Dir, 0o755); err != nil {
		t.Fatal(err)
	}
	logFile := filepath.Join(utf8Dir, "sender_2026-11-22.log")
	// Write "ab" + first byte of "中" (3 bytes total on disk) so curSize=3 lands inside "中"
	fullContent := "ab中cd\n"
	if err := os.WriteFile(logFile, []byte(fullContent[:3]), 0o644); err != nil {
		t.Fatal(err)
	}
	sz := mgr.WriteChunk(utf8Dir, "2026-11-22", "sender", 0, fullContent)
	if sz <= 3 {
		t.Fatalf("expected WriteChunk(offset=0) to append suffix, got size=%d", sz)
	}
	gotBytes, _ := os.ReadFile(logFile)
	// Appended slice must start at "cd\n" (index 5), never mid-UTF-8 rune at index 3
	if !strings.HasSuffix(string(gotBytes), "cd\n") || !utf8.Valid(gotBytes[3:]) {
		t.Fatalf("expected appended suffix to be valid UTF-8 \"cd\\n\", got %q", string(gotBytes[3:]))
	}

	// Test offset > 0 where skip = curSize - offset lands mid-UTF-8 rune
	logFile2 := filepath.Join(utf8Dir, "error_2026-11-22.log")
	chunk := "xy张zw\n" // "xy" (2) + "张" (3) + "zw\n" (3) = 8 bytes
	// File on disk has 13 bytes; offset is 10 -> skip = 3 (inside "张" bytes [2..5))
	if err := os.WriteFile(logFile2, []byte(strings.Repeat("a", 13)), 0o644); err != nil {
		t.Fatal(err)
	}
	mgr.WriteChunk(utf8Dir, "2026-11-22", "error", 10, chunk)
	gotBytes2, _ := os.ReadFile(logFile2)
	appended2 := gotBytes2[13:]
	if string(appended2) != "zw\n" || !utf8.Valid(appended2) {
		t.Fatalf("expected appended suffix \"zw\\n\" without mid-rune slice, got %q", string(appended2))
	}
}
