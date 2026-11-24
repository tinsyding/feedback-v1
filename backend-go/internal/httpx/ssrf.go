package httpx

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
)

// ErrSSRFBlocked is returned when an outbound HTTP request attempts to connect to a loopback,
// private, link-local, or otherwise non-public address.
var ErrSSRFBlocked = errors.New("禁止访问内网或本地地址")

var blockedSSRFIPv6Nets = mustParseCIDRs(
	"::/96",          // Deprecated IPv4-compatible IPv6 (includes :: and ::1)
	"64:ff9b::/96",   // NAT64 well-known prefix (RFC 6052)
	"64:ff9b:1::/48", // NAT64 local-use prefix (RFC 8215)
	"100::/64",       // Discard-Only (RFC 6666)
	"2001:db8::/32",  // Documentation (RFC 3849)
)

func mustParseCIDRs(cidrs ...string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, raw := range cidrs {
		_, ipNet, err := net.ParseCIDR(raw)
		if err != nil {
			panic(fmt.Sprintf("invalid SSRF CIDR %q: %v", raw, err))
		}
		out = append(out, ipNet)
	}
	return out
}

// IsBlockedSSRFIP reports whether ip is loopback, private, link-local, CGNAT, special-use,
// multicast, unspecified, IPv4-compatible IPv6, or NAT64.
func IsBlockedSSRFIP(ip net.IP) bool {
	if !isPublicIP(ip) {
		return true
	}
	if ip.To4() == nil {
		ip16 := ip.To16()
		if ip16 == nil {
			return true
		}
		for _, ipNet := range blockedSSRFIPv6Nets {
			if ipNet.Contains(ip16) {
				return true
			}
		}
		// 6to4 (2002::/16): block when embedded IPv4 address is non-public.
		if ip16[0] == 0x20 && ip16[1] == 0x02 {
			embedded := net.IPv4(ip16[2], ip16[3], ip16[4], ip16[5])
			if IsBlockedSSRFIP(embedded) {
				return true
			}
		}
	}
	return false
}

// IsBlockedSSRFHost reports whether a hostname or IP literal (without port) targets localhost
// or a blocked internal/link-local IP address.
func IsBlockedSSRFHost(host string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	h = strings.TrimRight(h, ".")
	if h == "" {
		return true
	}
	if strings.HasPrefix(h, "[") && strings.HasSuffix(h, "]") {
		h = strings.TrimSpace(h[1 : len(h)-1])
		h = strings.TrimRight(h, ".")
		if h == "" {
			return true
		}
	}
	if h == "localhost" || strings.HasSuffix(h, ".localhost") || strings.HasSuffix(h, ".local") || strings.HasSuffix(h, ".internal") {
		return true
	}
	ipCandidate := h
	if idx := strings.IndexByte(ipCandidate, '%'); idx >= 0 {
		ipCandidate = ipCandidate[:idx]
	}
	if ip := net.ParseIP(ipCandidate); ip != nil {
		return IsBlockedSSRFIP(ip)
	}
	return false
}

type ipAddrResolver interface {
	LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error)
}

func newSafeDialContext(resolver ipAddrResolver, dialFn func(ctx context.Context, network, addr string) (net.Conn, error)) func(ctx context.Context, network, addr string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		if IsBlockedSSRFHost(host) {
			return nil, ErrSSRFBlocked
		}
		ips, err := resolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		if len(ips) == 0 {
			return nil, fmt.Errorf("无法解析目标主机: %s", host)
		}
		for _, ipAddr := range ips {
			if IsBlockedSSRFIP(ipAddr.IP) {
				return nil, ErrSSRFBlocked
			}
		}
		var lastErr error
		for _, ipAddr := range ips {
			conn, dialErr := dialFn(ctx, network, net.JoinHostPort(ipAddr.IP.String(), port))
			if dialErr == nil {
				return conn, nil
			}
			lastErr = dialErr
			if ctx.Err() != nil {
				return nil, lastErr
			}
		}
		return nil, lastErr
	}
}

// NewSafeHTTPClient returns an *http.Client that disables HTTP redirects and resolves/pins DNS
// inside DialContext while blocking loopback, private, link-local, and metadata IPs.
func NewSafeHTTPClient(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		DialContext: newSafeDialContext(net.DefaultResolver, dialer.DialContext),
	}
	return &http.Client{
		Timeout:   timeout,
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}
