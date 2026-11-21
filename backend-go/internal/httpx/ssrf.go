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

// IsBlockedSSRFIP reports whether ip is loopback, private, link-local, CGNAT, multicast, or unspecified.
func IsBlockedSSRFIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return true
	}
	// Block IPv4-mapped IPv6, 0.0.0.0/8, and CGNAT 100.64.0.0/10
	if ip4 := ip.To4(); ip4 != nil {
		if ip4[0] == 100 && ip4[1] >= 64 && ip4[1] <= 127 {
			return true
		}
		if ip4[0] == 0 {
			return true
		}
	}
	return false
}

// IsBlockedSSRFHost reports whether a hostname or IP literal (without port) targets localhost
// or a blocked internal/link-local IP address.
func IsBlockedSSRFHost(host string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "" {
		return true
	}
	if h == "localhost" || strings.HasSuffix(h, ".localhost") || strings.HasSuffix(h, ".local") || strings.HasSuffix(h, ".internal") {
		return true
	}
	if ip := net.ParseIP(h); ip != nil {
		return IsBlockedSSRFIP(ip)
	}
	return false
}

// NewSafeHTTPClient returns an *http.Client that disables HTTP redirects and resolves/pins DNS
// inside DialContext while blocking loopback, private, link-local, and metadata IPs.
func NewSafeHTTPClient(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			if IsBlockedSSRFHost(host) {
				return nil, ErrSSRFBlocked
			}
			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
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
			return dialer.DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
		},
	}
	return &http.Client{
		Timeout:   timeout,
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}
