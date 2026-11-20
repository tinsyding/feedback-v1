package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
)

func TestPublicConfigDefaultsClampingAndDynamicReload(t *testing.T) {
	root := t.TempDir()
	loader := config.NewLoader(root, "")
	h := httpx.Middleware(PublicConfig(loader))

	// 1. Missing config.json -> defaults
	req := httptest.NewRequest(http.MethodGet, "/api/public_config.php", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=300" {
		t.Fatalf("Cache-Control = %q", got)
	}

	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["success"] != true || got["semesterYear"] != float64(2026) || got["defaultSeason"] != "autumn" ||
		got["semesterWeeks"] != float64(18) || got["forceIntegerScores"] != true ||
		got["retestQuestionSpacing"] != float64(26) || got["retestQrCodeEnabled"] != false ||
		got["disableQwenFlashTitle"] != false {
		t.Fatalf("unexpected defaults: %+v", got)
	}
	if _, hasData := got["data"]; hasData {
		t.Fatalf("public_config must be flat, not wrapped in data: %+v", got)
	}

	// 2. Live config.json update with clamping, PHP-style bool/int strings, and secrets present
	cfgPath := filepath.Join(root, "config.json")
	if err := os.WriteFile(cfgPath, []byte(`{
		"semesterYear": "2027",
		"defaultSeason": "spring",
		"semesterWeeks": 99,
		"forceIntegerScores": 0,
		"retestQuestionSpacing": 5,
		"retestQrCodeEnabled": "1",
		"disableQwenFlashTitle": 1,
		"dashscopeApiKey": "sk-secret",
		"retestSecret": "top-secret",
		"senderApiToken": "secret-tok"
	}`), 0644); err != nil {
		t.Fatal(err)
	}

	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/api/public_config.php", nil))
	var got2 map[string]any
	if err := json.Unmarshal(rec2.Body.Bytes(), &got2); err != nil {
		t.Fatal(err)
	}
	if got2["semesterYear"] != float64(2027) || got2["defaultSeason"] != "spring" ||
		got2["semesterWeeks"] != float64(30) || got2["forceIntegerScores"] != false ||
		got2["retestQuestionSpacing"] != float64(10) || got2["retestQrCodeEnabled"] != true ||
		got2["disableQwenFlashTitle"] != true {
		t.Fatalf("unexpected clamped/reloaded payload: %+v", got2)
	}
	for _, secretKey := range []string{"dashscopeApiKey", "retestSecret", "senderApiToken"} {
		if _, leaked := got2[secretKey]; leaked {
			t.Fatalf("secret key %q leaked in public_config", secretKey)
		}
	}
}

func TestHealthEndpoint(t *testing.T) {
	h := httpx.Middleware(http.HandlerFunc(Health))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /healthz status = %d", rec.Code)
	}
	ok, data, errStr := decodeEnvelope(t, rec)
	if !ok || errStr != nil || data["service"] != "feedback-api" || data["engine"] != "go" || data["status"] != "ok" {
		t.Fatalf("unexpected /healthz response: ok=%v data=%+v err=%v", ok, data, errStr)
	}

	recPost := httptest.NewRecorder()
	h.ServeHTTP(recPost, httptest.NewRequest(http.MethodPost, "/healthz", nil))
	if recPost.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /healthz status = %d, want 405", recPost.Code)
	}
}
