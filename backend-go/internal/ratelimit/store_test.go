package ratelimit

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestNormalizeKeyMatchesPHP(t *testing.T) {
	if got := NormalizeKey("admin_login_ip", "  127.0.0.1  "); got != "admin_login_ip:127.0.0.1" {
		t.Fatalf("got %q", got)
	}
	if got := NormalizeKey("front_login_user", "TeacherA"); got != "front_login_user:teachera" {
		t.Fatalf("got %q", got)
	}
	longID := strings.Repeat("x", 220)
	longKey := NormalizeKey("scope", longID)
	if len(longKey) != 191 {
		t.Fatalf("expected truncated key length 191, got %d (%q)", len(longKey), longKey)
	}
}

func TestMemoryStoreLockoutWindowAndClear(t *testing.T) {
	store := NewMemoryStore()
	now := time.Unix(1700000000, 0)
	store.nowFunc = func() time.Time { return now }

	ctx := context.Background()

	st, err := store.Status(ctx, "admin_login_user", "alice", 600)
	if err != nil || st.Count != 0 || st.Locked {
		t.Fatalf("initial status unexpected: %+v, err=%v", st, err)
	}

	// 2 failures below threshold 3
	for i := 1; i <= 2; i++ {
		st, err = store.RecordFailure(ctx, "admin_login_user", "alice", 3, 600, 300)
		if err != nil || st.Count != i || st.Locked {
			t.Fatalf("attempt %d unexpected: %+v, err=%v", i, st, err)
		}
	}

	// 3rd failure triggers 300s lockout
	st, err = store.RecordFailure(ctx, "admin_login_user", "alice", 3, 600, 300)
	if err != nil || st.Count != 3 || !st.Locked || st.RemainingSeconds != 300 {
		t.Fatalf("lockout status unexpected: %+v, err=%v", st, err)
	}

	// 100s later still locked with 200s remaining
	now = now.Add(100 * time.Second)
	st, err = store.Status(ctx, "admin_login_user", "alice", 600)
	if err != nil || !st.Locked || st.RemainingSeconds != 200 {
		t.Fatalf("mid-lockout status unexpected: %+v, err=%v", st, err)
	}

	// After window & lockout expire, status resets to 0
	now = now.Add(600 * time.Second)
	st, err = store.Status(ctx, "admin_login_user", "alice", 600)
	if err != nil || st.Count != 0 || st.Locked {
		t.Fatalf("post-expiry status unexpected: %+v, err=%v", st, err)
	}

	// Next failure starts a fresh window at count=1
	st, err = store.RecordFailure(ctx, "admin_login_user", "alice", 3, 600, 300)
	if err != nil || st.Count != 1 || st.Locked {
		t.Fatalf("fresh window status unexpected: %+v, err=%v", st, err)
	}

	// Clear removes bucket
	if err := store.Clear(ctx, "admin_login_user", "alice"); err != nil {
		t.Fatalf("Clear failed: %v", err)
	}
	st, err = store.Status(ctx, "admin_login_user", "alice", 600)
	if err != nil || st.Count != 0 || st.Locked {
		t.Fatalf("post-clear status unexpected: %+v, err=%v", st, err)
	}
}
