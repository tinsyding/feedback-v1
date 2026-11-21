package httpx

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestMiddlewareCORSAndOptions(t *testing.T) {
	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		SendResponse(w, true, map[string]string{"hello": "世界"}, nil, http.StatusOK)
	}))

	// Allowed wildcard subdomain origin on OPTIONS
	req := httptest.NewRequest(http.MethodOptions, "/api/public_config.php", nil)
	req.Header.Set("Origin", "https://preview.wxjifang.cn:8443")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("OPTIONS status = %d, want 204", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://preview.wxjifang.cn:8443" {
		t.Fatalf("ACAO = %q", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("ACAC = %q", got)
	}
	if got := rec.Header().Values("Vary"); len(got) == 0 || got[0] != "Origin" {
		t.Fatalf("Vary = %v, want [Origin]", got)
	}
	if got := rec.Header().Get("X-Backend-Engine"); got != "go" {
		t.Fatalf("X-Backend-Engine = %q", got)
	}

	// Disallowed origin on GET
	req2 := httptest.NewRequest(http.MethodGet, "/api/public_config.php", nil)
	req2.Header.Set("Origin", "https://evil.example")
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, req2)

	if rec2.Code != http.StatusOK {
		t.Fatalf("GET status = %d", rec2.Code)
	}
	if got := rec2.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("unexpected ACAO for evil origin: %q", got)
	}
	if !strings.Contains(rec2.Body.String(), `"error":null`) {
		t.Fatalf("expected explicit error:null in envelope, got %s", rec2.Body.String())
	}
	if !strings.Contains(rec2.Body.String(), "世界") {
		t.Fatalf("expected unescaped UTF-8, got %s", rec2.Body.String())
	}
}

func TestMiddlewareSameOriginCSRF(t *testing.T) {
	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		SendResponse(w, true, "ok", nil, http.StatusOK)
	}))

	cases := []struct {
		name       string
		method     string
		host       string
		origin     string
		referer    string
		wantStatus int
	}{
		{"no origin/referer", http.MethodPost, "127.0.0.1:8090", "", "", http.StatusOK},
		{"same host different port", http.MethodPost, "example.com:8090", "https://example.com:3000", "", http.StatusOK},
		{"whitelisted origin", http.MethodPost, "api.internal:8090", "https://feedback.wxjifang.cn", "", http.StatusOK},
		{"wildcard wxjifang subdomain", http.MethodDelete, "api.internal:8090", "", "https://staging.wxjifang.cn/admin.html", http.StatusOK},
		{"evil origin rejected", http.MethodPost, "127.0.0.1:8090", "https://evil.example", "", http.StatusForbidden},
		{"evil referer rejected", http.MethodPost, "127.0.0.1:8090", "", "https://evil.example/form", http.StatusForbidden},
		{"null origin rejected", http.MethodPost, "127.0.0.1:8090", "null", "", http.StatusForbidden},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, "/api/calibrate_roi.php", nil)
			req.Host = tc.host
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			if tc.referer != "" {
				req.Header.Set("Referer", tc.referer)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body=%s)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if tc.wantStatus == http.StatusForbidden {
				var env Envelope
				if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
					t.Fatal(err)
				}
				if env.Error == nil || *env.Error != "非法跨站请求 (CSRF Origin Mismatch)" {
					t.Fatalf("unexpected CSRF error: %+v", env)
				}
			}
		})
	}
}

func TestRequireStrictSameOrigin(t *testing.T) {
	cases := []struct {
		name       string
		method     string
		host       string
		origin     string
		referer    string
		wantOK     bool
		wantStatus int
	}{
		{"get bypasses", http.MethodGet, "feedback.wxjifang.cn", "https://evil.example", "", true, http.StatusOK},
		{"no origin/referer allowed", http.MethodPost, "feedback.wxjifang.cn", "", "", true, http.StatusOK},
		{"exact same host allowed", http.MethodPost, "feedback.wxjifang.cn:443", "https://feedback.wxjifang.cn", "", true, http.StatusOK},
		{"cross subdomain rejected in strict mode", http.MethodPost, "feedback.wxjifang.cn", "https://vip.wxjifang.cn", "", false, http.StatusForbidden},
		{"cross subdomain referer rejected in strict mode", http.MethodDelete, "feedback.wxjifang.cn", "", "https://staging.wxjifang.cn/page", false, http.StatusForbidden},
		{"evil origin rejected", http.MethodPost, "feedback.wxjifang.cn", "https://evil.example", "", false, http.StatusForbidden},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, "/api/admin.php", nil)
			req.Host = tc.host
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			if tc.referer != "" {
				req.Header.Set("Referer", tc.referer)
			}
			rec := httptest.NewRecorder()
			ok := RequireStrictSameOrigin(rec, req)
			if ok != tc.wantOK {
				t.Fatalf("RequireStrictSameOrigin = %v, want %v (body=%s)", ok, tc.wantOK, rec.Body.String())
			}
			if !tc.wantOK {
				if rec.Code != tc.wantStatus {
					t.Fatalf("status = %d, want %d", rec.Code, tc.wantStatus)
				}
				var env Envelope
				if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
					t.Fatal(err)
				}
				if env.Error == nil || *env.Error != "跨站请求已拦截（Origin 校验失败）" {
					t.Fatalf("unexpected strict CSRF error: %+v", env)
				}
			}
		})
	}
}

func TestGetClientIP(t *testing.T) {
	cases := []struct {
		name       string
		remoteAddr string
		realIP     string
		xff        string
		want       string
	}{
		{"untrusted remote ignores headers", "8.8.8.8:1234", "1.2.3.4", "5.6.7.8", "8.8.8.8"},
		{"trusted proxy uses X-Real-IP", "127.0.0.1:1234", "203.0.113.10", "198.51.100.1", "203.0.113.10"},
		{"trusted proxy right-to-left public XFF", "192.168.1.10:443", "", "1.1.1.1, 8.8.4.4, 10.0.0.5", "8.8.4.4"},
		{"trusted proxy falls back to first valid IP if all private", "::1", "", "10.1.2.3, 192.168.0.1", "10.1.2.3"},
		{"invalid headers fallback to remote", "172.16.5.2:9000", "not-an-ip", "also-bad", "172.16.5.2"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.RemoteAddr = tc.remoteAddr
			if tc.realIP != "" {
				req.Header.Set("X-Real-IP", tc.realIP)
			}
			if tc.xff != "" {
				req.Header.Set("X-Forwarded-For", tc.xff)
			}
			if got := GetClientIP(req); got != tc.want {
				t.Fatalf("GetClientIP = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestExtractBearerOrFormToken(t *testing.T) {
	// Multipart form token takes precedence over Bearer header; URL query token is ignored.
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	_ = mw.WriteField("token", "form-tok")
	_ = mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/identify.php?token=query-tok", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer bearer-tok")
	ParseRequestForm(req)
	if got := ExtractBearerOrFormToken(req); got != "form-tok" {
		t.Fatalf("got %q, want form-tok", got)
	}

	// Fallback to case-insensitive Bearer header when form token absent, ignoring URL query token.
	form := url.Values{}
	req2 := httptest.NewRequest(http.MethodPost, "/api/identify.php?token=query-tok", strings.NewReader(form.Encode()))
	req2.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req2.Header.Set("Authorization", "bEaReR  secret-bearer ")
	ParseRequestForm(req2)
	if got := ExtractBearerOrFormToken(req2); got != "secret-bearer" {
		t.Fatalf("got %q, want secret-bearer", got)
	}
}
