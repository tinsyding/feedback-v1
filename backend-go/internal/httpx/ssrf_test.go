package httpx

import (
	"context"
	"errors"
	"net"
	"testing"
)

func TestIsBlockedSSRFIPRanges(t *testing.T) {
	blocked := []string{
		"127.0.0.1",
		"10.0.0.1",
		"172.16.0.1",
		"192.168.1.1",
		"169.254.169.254",
		"100.64.0.1",
		"100.127.255.254",
		"0.0.0.0",
		"0.1.2.3",
		"192.0.0.1",
		"192.0.2.1",
		"198.18.0.1",
		"198.19.255.254",
		"198.51.100.42",
		"203.0.113.7",
		"240.0.0.1",
		"255.255.255.255",
		"::",
		"::1",
		"::ffff:127.0.0.1",
		"::ffff:192.0.2.1",
		"::ffff:198.18.0.5",
		"::127.0.0.1",
		"::8.8.8.8",
		"64:ff9b::127.0.0.1",
		"64:ff9b::8.8.8.8",
		"64:ff9b:1::1",
		"100::1",
		"2001:db8::1",
		"2002:7f00:0001::1",
		"fe80::1",
		"fc00::1",
		"ff02::1",
	}
	for _, raw := range blocked {
		ip := net.ParseIP(raw)
		if ip == nil {
			t.Fatalf("failed to parse test IP %q", raw)
		}
		if !IsBlockedSSRFIP(ip) {
			t.Fatalf("expected IsBlockedSSRFIP(%q) == true", raw)
		}
	}
	if !IsBlockedSSRFIP(nil) {
		t.Fatal("expected IsBlockedSSRFIP(nil) == true")
	}

	allowed := []string{
		"8.8.8.8",
		"1.1.1.1",
		"223.5.5.5",
		"2606:4700:4700::1111",
		"2400:3200::1",
		"2001:4860:4860::8888",
	}
	for _, raw := range allowed {
		ip := net.ParseIP(raw)
		if ip == nil {
			t.Fatalf("failed to parse allowed IP %q", raw)
		}
		if IsBlockedSSRFIP(ip) {
			t.Fatalf("expected IsBlockedSSRFIP(%q) == false", raw)
		}
	}
}

func TestIsBlockedSSRFHostBracketsAndZones(t *testing.T) {
	blockedHosts := []string{
		"",
		"   ",
		"[]",
		"localhost",
		"localhost.",
		"sub.localhost",
		"printer.local",
		"metadata.google.internal.",
		"[::1]",
		"[::1].",
		"[fe80::1%eth0]",
		"[fe80::1%25eth0]",
		"fe80::1%eth0",
		"[::ffff:127.0.0.1]",
		"[::127.0.0.1]",
		"[64:ff9b::127.0.0.1]",
		"[64:ff9b:1::10.0.0.1]",
		"192.0.2.1",
		"198.18.0.1",
		"255.255.255.255",
	}
	for _, h := range blockedHosts {
		if !IsBlockedSSRFHost(h) {
			t.Fatalf("expected IsBlockedSSRFHost(%q) == true", h)
		}
	}

	allowedHosts := []string{
		"dashscope.aliyuncs.com",
		"[2606:4700:4700::1111]",
		"2606:4700:4700::1111",
		"8.8.8.8",
	}
	for _, h := range allowedHosts {
		if IsBlockedSSRFHost(h) {
			t.Fatalf("expected IsBlockedSSRFHost(%q) == false", h)
		}
	}
}

type fakeIPResolver struct {
	ips []net.IPAddr
	err error
}

func (f fakeIPResolver) LookupIPAddr(_ context.Context, _ string) ([]net.IPAddr, error) {
	return f.ips, f.err
}

func TestSafeDialContextMixedIPsAndSequentialFallback(t *testing.T) {
	// 1. Mixed public + blocked IP must fail with ErrSSRFBlocked and dial zero times
	var dialed []string
	dcBlocked := newSafeDialContext(fakeIPResolver{
		ips: []net.IPAddr{
			{IP: net.ParseIP("8.8.8.8")},
			{IP: net.ParseIP("192.0.2.1")},
		},
	}, func(_ context.Context, _, addr string) (net.Conn, error) {
		dialed = append(dialed, addr)
		c1, c2 := net.Pipe()
		_ = c2.Close()
		return c1, nil
	})
	if _, err := dcBlocked(context.Background(), "tcp", "example.com:443"); !errors.Is(err, ErrSSRFBlocked) {
		t.Fatalf("expected ErrSSRFBlocked for mixed public+blocked IPs, got %v", err)
	}
	if len(dialed) != 0 {
		t.Fatalf("expected 0 dial attempts when any resolved IP is blocked, got %v", dialed)
	}

	// 2. All public IPs: first fails, second succeeds
	dialed = nil
	dcFallback := newSafeDialContext(fakeIPResolver{
		ips: []net.IPAddr{
			{IP: net.ParseIP("2606:4700:4700::1111")},
			{IP: net.ParseIP("1.1.1.1")},
		},
	}, func(_ context.Context, _, addr string) (net.Conn, error) {
		dialed = append(dialed, addr)
		if len(dialed) == 1 {
			return nil, errors.New("ipv6 unreachable")
		}
		c1, c2 := net.Pipe()
		_ = c2.Close()
		return c1, nil
	})
	conn, err := dcFallback(context.Background(), "tcp", "api.example.com:443")
	if err != nil {
		t.Fatalf("expected sequential fallback dial to succeed, got %v", err)
	}
	_ = conn.Close()
	if len(dialed) != 2 || dialed[0] != "[2606:4700:4700::1111]:443" || dialed[1] != "1.1.1.1:443" {
		t.Fatalf("unexpected dial sequence: %v", dialed)
	}
}
