package tz

import (
	"testing"
	"time"
)

func TestShanghaiAndHelpers(t *testing.T) {
	loc := Shanghai()
	if loc == nil {
		t.Fatal("Shanghai() returned nil")
	}
	_, offset := time.Date(2026, 11, 21, 12, 0, 0, 0, loc).Zone()
	if offset != 8*3600 {
		t.Fatalf("unexpected Asia/Shanghai offset: %d, want %d", offset, 8*3600)
	}

	utcTime := time.Date(2026, 11, 21, 16, 30, 5, 0, time.UTC)
	converted := In(utcTime)
	if got := converted.Format("2006-01-02 15:04:05"); got != "2026-11-22 00:30:05" {
		t.Fatalf("In(utcTime) = %q, want 2026-11-22 00:30:05", got)
	}

	u := Unix(utcTime.Unix(), 0)
	if got := u.Format("2006-01-02 15:04:05"); got != "2026-11-22 00:30:05" {
		t.Fatalf("Unix(utcTime.Unix(), 0) = %q, want 2026-11-22 00:30:05", got)
	}

	now := Now()
	_, nowOffset := now.Zone()
	if nowOffset != 8*3600 {
		t.Fatalf("Now() offset = %d, want %d", nowOffset, 8*3600)
	}
}
