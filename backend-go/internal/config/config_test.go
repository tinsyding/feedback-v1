package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadEnvFileDoesNotOverwriteOSVars(t *testing.T) {
	t.Setenv("EXISTING_KEY", "from-os")
	t.Setenv("EMPTY_OS_KEY", "")

	envPath := filepath.Join(t.TempDir(), ".env")
	content := `
# comment line
EXISTING_KEY=from-file
EMPTY_OS_KEY=from-file
export NEW_KEY="hello\nworld"
SINGLE_QUOTED='val # keep'
UNQUOTED_COMMENT=abc123 # inline comment
`
	if err := os.WriteFile(envPath, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.Unsetenv("NEW_KEY")
		_ = os.Unsetenv("SINGLE_QUOTED")
		_ = os.Unsetenv("UNQUOTED_COMMENT")
	})

	if err := LoadEnvFile(envPath); err != nil {
		t.Fatalf("LoadEnvFile failed: %v", err)
	}
	if got := os.Getenv("EXISTING_KEY"); got != "from-os" {
		t.Fatalf("EXISTING_KEY overwritten: got %q", got)
	}
	if got, ok := os.LookupEnv("EMPTY_OS_KEY"); !ok || got != "" {
		t.Fatalf("EMPTY_OS_KEY overwritten: got (%q, %v)", got, ok)
	}
	if got := os.Getenv("NEW_KEY"); got != "hello\nworld" {
		t.Fatalf("NEW_KEY mismatch: got %q", got)
	}
	if got := os.Getenv("SINGLE_QUOTED"); got != "val # keep" {
		t.Fatalf("SINGLE_QUOTED mismatch: got %q", got)
	}
	if got := os.Getenv("UNQUOTED_COMMENT"); got != "abc123" {
		t.Fatalf("UNQUOTED_COMMENT mismatch: got %q", got)
	}
}

func TestSecretsPrecedenceAndPHPFallback(t *testing.T) {
	root := t.TempDir()
	apiDir := filepath.Join(root, "api")
	if err := os.MkdirAll(apiDir, 0755); err != nil {
		t.Fatal(err)
	}

	phpSecrets := `<?php
// 'dashscopeApiKey' => 'commented-out',
/* 'senderApiToken' => 'block-commented', */
return [
    'retestSecret' => 'php-retest',
    'senderApiToken' => 'php-sender-token',
    'dashscopeApiKey' => 'php-dash-key',
    'identifyApiBase' => 'https://php.example/v1',
    'identifyModel' => 'php-model',
    'identifyFastModel' => 'php-fast',
];
`
	if err := os.WriteFile(filepath.Join(apiDir, "secret_key.local.php"), []byte(phpSecrets), 0600); err != nil {
		t.Fatal(err)
	}

	secretsJSON := filepath.Join(t.TempDir(), "secrets.json")
	if err := os.WriteFile(secretsJSON, []byte(`{
		"senderApiToken": "json-sender-token",
		"dashscopeApiKey": "json-dash-key",
		"identifyModel": "json-model"
	}`), 0600); err != nil {
		t.Fatal(err)
	}

	t.Setenv("SENDER_API_TOKEN", "")
	t.Setenv("DASHSCOPE_API_KEY", "env-dash-key")
	t.Setenv("IDENTIFY_API_BASE", "")
	t.Setenv("IDENTIFY_MODEL", "")
	t.Setenv("IDENTIFY_FAST_MODEL", "")

	loader := NewLoader(root, secretsJSON)
	cfg := loader.Load()

	// SENDER_API_TOKEN env is empty -> falls back to secrets JSON -> beats PHP file.
	if got := cfg.ServerSenderToken(); got != "json-sender-token" {
		t.Fatalf("ServerSenderToken = %q, want json-sender-token", got)
	}
	if !cfg.VerifySenderToken("json-sender-token") {
		t.Fatal("expected json-sender-token to verify")
	}
	if cfg.VerifySenderToken(DefaultSenderToken) {
		t.Fatal("default token must NOT bypass custom sender token")
	}
	if cfg.VerifySenderToken("") {
		t.Fatal("empty token must fail closed")
	}

	// VisionAPIKey: config.json empty -> OS env beats JSON/PHP secrets.
	if got := cfg.VisionAPIKey(); got != "env-dash-key" {
		t.Fatalf("VisionAPIKey = %q, want env-dash-key", got)
	}

	// IdentifyAPIBase: from PHP fallback + /chat/completions normalization.
	if got := cfg.IdentifyAPIBase(); got != "https://php.example/v1/chat/completions" {
		t.Fatalf("IdentifyAPIBase = %q", got)
	}

	// IdentifyModel: JSON secrets beat PHP file.
	if got := cfg.CalibrateModel(); got != "json-model" {
		t.Fatalf("CalibrateModel = %q, want json-model", got)
	}
	if got := cfg.IdentifyModel("title", ""); got != "php-fast" {
		t.Fatalf("IdentifyModel(title) = %q, want php-fast", got)
	}
}

func TestConfigDynamicReloadAndPrecedence(t *testing.T) {
	root := t.TempDir()
	cfgPath := filepath.Join(root, "config.json")

	t.Setenv("SENDER_API_TOKEN", "")
	t.Setenv("DASHSCOPE_API_KEY", "env-key")
	t.Setenv("IDENTIFY_API_BASE", "https://env.example/v1/")
	t.Setenv("IDENTIFY_MODEL", "env-max")
	t.Setenv("IDENTIFY_FAST_MODEL", "env-flash")

	loader := NewLoader(root, "")

	// Missing config.json -> default sender token, env fallbacks.
	cfg := loader.Load()
	if !cfg.VerifySenderToken(DefaultSenderToken) {
		t.Fatal("expected DefaultSenderToken when no custom token configured")
	}
	if cfg.VerifySenderToken("wrong") || cfg.VerifySenderToken("") {
		t.Fatal("unexpected token verification pass")
	}
	if got := cfg.VisionAPIKey(); got != "env-key" {
		t.Fatalf("VisionAPIKey = %q, want env-key", got)
	}
	if got := cfg.IdentifyAPIBase(); got != "https://env.example/v1/chat/completions" {
		t.Fatalf("IdentifyAPIBase = %q", got)
	}
	if got := cfg.CalibrateModel(); got != "env-max" {
		t.Fatalf("CalibrateModel = %q", got)
	}
	if got := cfg.IdentifyModel("title", "benchmark"); got != "env-flash" {
		t.Fatalf("IdentifyModel(title, benchmark) = %q", got)
	}

	// Live update config.json without creating new Loader.
	if err := os.WriteFile(cfgPath, []byte(`{
		"dashscopeApiKey": "  cfg-key  ",
		"identifyApiBase": "https://cfg.example/v1/chat/completions",
		"calibrateModel": "cfg-cal",
		"identifyModel": "cfg-max",
		"identifyFastModel": "cfg-flash",
		"benchmarkModel": "cfg-bench"
	}`), 0644); err != nil {
		t.Fatal(err)
	}

	cfg2 := loader.Load()
	if got := cfg2.VisionAPIKey(); got != "cfg-key" {
		t.Fatalf("VisionAPIKey = %q, want cfg-key", got)
	}
	if got := cfg2.IdentifyAPIBase(); got != "https://cfg.example/v1/chat/completions" {
		t.Fatalf("IdentifyAPIBase = %q", got)
	}
	if got := cfg2.CalibrateModel(); got != "cfg-cal" {
		t.Fatalf("CalibrateModel = %q, want cfg-cal", got)
	}
	if got := cfg2.IdentifyModel("sidebar", ""); got != "cfg-cal" {
		t.Fatalf("IdentifyModel(sidebar) = %q, want cfg-cal", got)
	}
	if got := cfg2.IdentifyModel("title", ""); got != "cfg-flash" {
		t.Fatalf("IdentifyModel(title) = %q, want cfg-flash", got)
	}
	if got := cfg2.IdentifyModel("title", "benchmark"); got != "cfg-bench" {
		t.Fatalf("IdentifyModel(title, benchmark) = %q, want cfg-bench", got)
	}
	if got := cfg2.IdentifyModel("full", ""); got != "cfg-max" {
		t.Fatalf("IdentifyModel(full) = %q, want cfg-max", got)
	}
}

func TestNormalizeGlobalSenderControl(t *testing.T) {
	// Defaults + disableQwenFlashTitle fallback
	sc := NormalizeGlobalSenderControl(nil, map[string]any{"disableQwenFlashTitle": true})
	if !sc.EnableAutoCalibration || !sc.EnableReplyAnalysis || !sc.EnableBenchmarkModel {
		t.Fatalf("unexpected boolean defaults: %+v", sc)
	}
	if sc.VerifyMode != "local" {
		t.Fatalf("VerifyMode = %q, want local when disableQwenFlashTitle is true", sc.VerifyMode)
	}

	// Explicit overrides, PHP truthiness (0/"0"/1/"1"), clamping & min<=max
	raw := map[string]any{
		"policyVersion":         0,
		"senderServiceEnabled":  "0",
		"enableAutoCalibration": 0,
		"verifyMode":            "API",
		"enableReplyAnalysis":   "1",
		"enableBenchmarkModel":  false,
		"snapshotPolicy":        "bad",
		"minSenderVersion":      "V2.1.0-beta.1",
		"minVersionAction":      "WARN",
		"updateUrl":             "javascript:alert(1)",
		"searchWait":            0.1,
		"enterWait":             99,
		"studentGapMin":         5.0,
		"studentGapMax":         2.0,
		"batchBreakEvery":       999,
		"batchBreakMin":         10.555,
		"batchBreakMax":         5.0,
	}
	sc2 := NormalizeGlobalSenderControl(raw, nil)
	if sc2.PolicyVersion != 1 {
		t.Fatalf("PolicyVersion = %d, want 1", sc2.PolicyVersion)
	}
	if sc2.SenderServiceEnabled {
		t.Fatal("senderServiceEnabled '0' should be false")
	}
	if sc2.EnableAutoCalibration {
		t.Fatal("enableAutoCalibration 0 should be false")
	}
	if sc2.VerifyMode != "api" {
		t.Fatalf("VerifyMode = %q, want api", sc2.VerifyMode)
	}
	if !sc2.EnableReplyAnalysis || sc2.EnableBenchmarkModel {
		t.Fatalf("unexpected reply/benchmark flags: %+v", sc2)
	}
	if sc2.SnapshotPolicy != "errors_only" {
		t.Fatalf("SnapshotPolicy = %q, want errors_only", sc2.SnapshotPolicy)
	}
	if sc2.MinSenderVersion != "2.1.0-beta.1" {
		t.Fatalf("MinSenderVersion = %q", sc2.MinSenderVersion)
	}
	if sc2.MinVersionAction != "warn" {
		t.Fatalf("MinVersionAction = %q", sc2.MinVersionAction)
	}
	if sc2.UpdateURL != "" {
		t.Fatalf("UpdateURL = %q, expected non-http url stripped", sc2.UpdateURL)
	}
	if sc2.SearchWait != 0.4 || sc2.EnterWait != 8.0 {
		t.Fatalf("clamped waits = (%v, %v)", sc2.SearchWait, sc2.EnterWait)
	}
	if sc2.StudentGapMin != 5.0 || sc2.StudentGapMax != 5.0 {
		t.Fatalf("student gap = (%v, %v)", sc2.StudentGapMin, sc2.StudentGapMax)
	}
	if sc2.BatchBreakEvery != 200 || sc2.BatchBreakMin != 10.56 || sc2.BatchBreakMax != 10.56 {
		t.Fatalf("batch break = (%d, %v, %v)", sc2.BatchBreakEvery, sc2.BatchBreakMin, sc2.BatchBreakMax)
	}
}
