package httpx

import (
	"bytes"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

var (
	allowedOrigins = map[string]struct{}{
		"http://localhost":             {},
		"http://127.0.0.1":             {},
		"https://feedback.wxjifang.cn": {},
		"https://vip.wxjifang.cn":      {},
		"https://vip.jokerx.top":       {},
	}
	reAllowedOrigin = regexp.MustCompile(`^https?://([a-zA-Z0-9-]+\.)*wxjifang\.cn(:\d+)?$`)

	allowedCSRFHosts = map[string]struct{}{
		"localhost":            {},
		"127.0.0.1":            {},
		"feedback.wxjifang.cn": {},
		"vip.wxjifang.cn":      {},
		"vip.jokerx.top":       {},
	}
	reAllowedCSRFHost = regexp.MustCompile(`(^|\.)wxjifang\.cn$`)
)

// Envelope mirrors the PHP sendResponse JSON envelope, always keeping "error" even when null.
type Envelope struct {
	Success bool    `json:"success"`
	Data    any     `json:"data"`
	Error   *string `json:"error"`
}

type headerTrackingWriter struct {
	http.ResponseWriter
	wroteHeader bool
}

func (w *headerTrackingWriter) WriteHeader(code int) {
	w.wroteHeader = true
	w.ResponseWriter.WriteHeader(code)
}

func (w *headerTrackingWriter) Write(p []byte) (int, error) {
	w.wroteHeader = true
	return w.ResponseWriter.Write(p)
}

func (w *headerTrackingWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

// Middleware applies PHP bootstrap.php CORS headers, OPTIONS preflight, X-Backend-Engine,
// default JSON Content-Type, write-method CSRF Origin/Referer verification, and panic recovery.
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tw := &headerTrackingWriter{ResponseWriter: w}
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("[PANIC] %s %s: %v", r.Method, r.URL.Path, rec)
				if !tw.wroteHeader {
					tw.Header().Set("Content-Type", "application/json; charset=utf-8")
					SendResponse(tw, false, nil, StrPtr("服务器内部错误，请稍后重试"), http.StatusInternalServerError)
				}
			}
		}()

		origin := r.Header.Get("Origin")
		if isOriginAllowed(origin) {
			tw.Header().Add("Vary", "Origin")
			tw.Header().Set("Access-Control-Allow-Origin", origin)
			tw.Header().Set("Access-Control-Allow-Credentials", "true")
		}
		tw.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		tw.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")
		tw.Header().Set("X-Backend-Engine", "go")

		if r.Method == http.MethodOptions {
			tw.WriteHeader(http.StatusNoContent)
			return
		}

		tw.Header().Set("Content-Type", "application/json; charset=utf-8")

		if !verifySameOriginRequest(r) {
			SendResponse(tw, false, nil, StrPtr("非法跨站请求 (CSRF Origin Mismatch)"), http.StatusForbidden)
			return
		}

		next.ServeHTTP(tw, r)
	})
}

func isOriginAllowed(origin string) bool {
	if origin == "" {
		return false
	}
	if _, ok := allowedOrigins[origin]; ok {
		return true
	}
	return reAllowedOrigin.MatchString(origin)
}

func verifySameOriginRequest(r *http.Request) bool {
	return verifySameOrigin(r, false)
}

// RequireStrictSameOrigin enforces strict same-host Origin/Referer matching on write requests
// (disallowing cross-subdomain requests), mirroring PHP verifySameOriginRequest(true).
// Returns true if allowed; otherwise writes HTTP 403 and returns false.
func RequireStrictSameOrigin(w http.ResponseWriter, r *http.Request) bool {
	if verifySameOrigin(r, true) {
		return true
	}
	SendResponse(w, false, nil, StrPtr("跨站请求已拦截（Origin 校验失败）"), http.StatusForbidden)
	return false
}

func verifySameOrigin(r *http.Request, strictSameHost bool) bool {
	switch strings.ToUpper(r.Method) {
	case http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch:
	default:
		return true
	}

	reqOrigin := r.Header.Get("Origin")
	reqReferer := r.Header.Get("Referer")
	if reqOrigin == "" && reqReferer == "" {
		return true
	}

	host := extractHostNoPort(r.Host)
	if host == "" {
		return true
	}

	rawCheck := reqOrigin
	if rawCheck == "" {
		rawCheck = reqReferer
	}
	checkHost := extractURLHost(rawCheck)
	if checkHost != "" && checkHost == host {
		return true
	}
	if !strictSameHost && checkHost != "" {
		if _, ok := allowedCSRFHosts[checkHost]; ok {
			return true
		}
		if reAllowedCSRFHost.MatchString(checkHost) {
			return true
		}
	}
	return false
}

func extractHostNoPort(hostPort string) string {
	hostPort = strings.TrimSpace(hostPort)
	if hostPort == "" {
		return ""
	}
	if h, _, err := net.SplitHostPort(hostPort); err == nil {
		return strings.ToLower(h)
	}
	// Handle bracketed IPv6 without port or plain host:port without standard SplitHostPort match.
	if strings.HasPrefix(hostPort, "[") && strings.HasSuffix(hostPort, "]") {
		return strings.ToLower(hostPort[1 : len(hostPort)-1])
	}
	if idx := strings.IndexByte(hostPort, ':'); idx >= 0 {
		return strings.ToLower(hostPort[:idx])
	}
	return strings.ToLower(hostPort)
}

func extractURLHost(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Hostname())
}

// SendResponse writes the standard UTF-8 JSON envelope without HTML escaping.
func SendResponse(w http.ResponseWriter, success bool, data any, errMsg *string, statusCode int) {
	SendJSON(w, statusCode, Envelope{
		Success: success,
		Data:    data,
		Error:   errMsg,
	})
}

// SendJSON encodes any payload as UTF-8 JSON with SetEscapeHTML(false) and writes statusCode.
func SendJSON(w http.ResponseWriter, statusCode int, payload any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(payload); err != nil {
		http.Error(w, `{"success":false,"data":null,"error":"internal json encode error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(statusCode)
	_, _ = w.Write(bytes.TrimSuffix(buf.Bytes(), []byte("\n")))
}

// StrPtr returns a pointer to s for non-null Envelope error fields.
func StrPtr(s string) *string {
	return &s
}

// ExtractBearerOrFormToken reads POST form field "token" first, falling back to Authorization: Bearer <token>.
func ExtractBearerOrFormToken(r *http.Request) string {
	if tok := r.PostFormValue("token"); tok != "" {
		return tok
	}
	auth := r.Header.Get("Authorization")
	if len(auth) >= 7 && strings.EqualFold(auth[:7], "bearer ") {
		return strings.TrimSpace(auth[7:])
	}
	return ""
}

// ParseRequestForm parses multipart/form-data (up to 16MB in memory) or urlencoded POST bodies.
// Callers must clean up r.MultipartForm if non-nil (e.g. defer r.MultipartForm.RemoveAll()).
func ParseRequestForm(r *http.Request) {
	ct := strings.ToLower(r.Header.Get("Content-Type"))
	if strings.HasPrefix(ct, "multipart/form-data") {
		_ = r.ParseMultipartForm(16 << 20)
		return
	}
	_ = r.ParseForm()
}

// GetClientIP mirrors bootstrap.php getClientIp() with trusted proxy checks and 50-char cap.
func GetClientIP(r *http.Request) string {
	remoteAddr := extractRemoteIP(r.RemoteAddr)
	if remoteAddr == "" {
		remoteAddr = "127.0.0.1"
	}

	remoteIP := net.ParseIP(remoteAddr)
	isTrustedProxy := remoteIP != nil && (remoteIP.IsLoopback() || remoteIP.IsPrivate())
	if isTrustedProxy {
		if realIP := strings.TrimSpace(r.Header.Get("X-Real-IP")); realIP != "" {
			if net.ParseIP(realIP) != nil {
				return clip50(realIP)
			}
		}
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			var lastValid string
			for i := len(parts) - 1; i >= 0; i-- {
				candidate := strings.TrimSpace(parts[i])
				if ip := net.ParseIP(candidate); ip != nil {
					if isPublicIP(ip) {
						return clip50(candidate)
					}
					if lastValid == "" {
						lastValid = candidate
					}
				}
			}
			if lastValid != "" {
				return clip50(lastValid)
			}
		}
	}

	return clip50(remoteAddr)
}

func extractRemoteIP(remoteAddr string) string {
	remoteAddr = strings.TrimSpace(remoteAddr)
	if remoteAddr == "" {
		return ""
	}
	if h, _, err := net.SplitHostPort(remoteAddr); err == nil {
		return h
	}
	return remoteAddr
}

func isPublicIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	if ip4 := ip.To4(); ip4 != nil {
		// 0.0.0.0/8, 100.64.0.0/10 (CGNAT), 192.0.0.0/24, 192.0.2.0/24, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 240.0.0.0/4
		switch {
		case ip4[0] == 0:
			return false
		case ip4[0] == 100 && ip4[1] >= 64 && ip4[1] <= 127:
			return false
		case ip4[0] == 192 && ip4[1] == 0 && (ip4[2] == 0 || ip4[2] == 2):
			return false
		case ip4[0] == 198 && (ip4[1] == 18 || ip4[1] == 19):
			return false
		case ip4[0] == 198 && ip4[1] == 51 && ip4[2] == 100:
			return false
		case ip4[0] == 203 && ip4[1] == 0 && ip4[2] == 113:
			return false
		case ip4[0] >= 240:
			return false
		}
	}
	return true
}

func clip50(s string) string {
	if len(s) <= 50 {
		return s
	}
	return s[:50]
}
