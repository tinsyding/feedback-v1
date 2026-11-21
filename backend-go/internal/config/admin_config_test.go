package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMaskAndIsMaskedAPIKey(t *testing.T) {
	if got := MaskAPIKey(""); got != "" {
		t.Fatalf("empty key => %q", got)
	}
	if got := MaskAPIKey("12345678"); got != "****" {
		t.Fatalf("short key => %q", got)
	}
	if got := MaskAPIKey("sk-abcdef123456"); got != "sk-a****3456" {
		t.Fatalf("long key => %q", got)
	}
	if !IsMaskedAPIKey("sk-a****3456") || !IsMaskedAPIKey("****") {
		t.Fatal("expected masked keys to be detected")
	}
	if IsMaskedAPIKey("sk-real-secret-key") {
		t.Fatal("expected real key not to be detected as masked")
	}
}

func TestSaveAISecretsAndConfigJSON(t *testing.T) {
	dir := t.TempDir()
	loader := NewLoader(dir, "")

	if err := loader.SaveAISecrets(map[string]any{"dashscopeApiKey": "sk-test-123456789"}); err != nil {
		t.Fatalf("SaveAISecrets: %v", err)
	}
	info, err := os.Stat(loader.AISecretsPath())
	if err != nil {
		t.Fatalf("stat .ai_secrets.json: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("expected 0600 perm, got %o", perm)
	}

	if err := loader.SaveConfigJSON(map[string]any{"semesterYear": 2026}); err != nil {
		t.Fatalf("SaveConfigJSON: %v", err)
	}
	loaded := loader.Load()
	if loaded.VisionAPIKey() != "sk-test-123456789" {
		t.Fatalf("expected VisionAPIKey from .ai_secrets.json, got %q", loaded.VisionAPIKey())
	}
	if AsPHPInt(loaded.Raw["semesterYear"]) != 2026 {
		t.Fatalf("expected semesterYear=2026, got %v", loaded.Raw["semesterYear"])
	}
}

func TestLoadAdminFallback(t *testing.T) {
	dir := t.TempDir()
	localDir := filepath.Join(dir, "api", "admin")
	if err := os.MkdirAll(localDir, 0o755); err != nil {
		t.Fatal(err)
	}
	php := "<?php return ['admin_username' => 'rootadmin', 'admin_password_hash' => 'hash1', 'admin_password_hashes' => ['hash2', 'hash3']];"
	if err := os.WriteFile(filepath.Join(localDir, "helpers.local.php"), []byte(php), 0o600); err != nil {
		t.Fatal(err)
	}
	loader := NewLoader(dir, "")
	creds := loader.LoadAdminFallback()
	if creds.Username != "rootadmin" || creds.PasswordHash != "hash1" {
		t.Fatalf("unexpected creds: %+v", creds)
	}
	if len(creds.PasswordHashes) != 3 {
		t.Fatalf("expected 3 password hashes, got %v", creds.PasswordHashes)
	}

	// Verify legacy PHP array(...) syntax is also supported
	phpLegacy := "<?php return array('admin_username' => 'legacy', 'admin_password_hashes' => array('h1', 'h2'));"
	if err := os.WriteFile(filepath.Join(localDir, "helpers.local.php"), []byte(phpLegacy), 0o600); err != nil {
		t.Fatal(err)
	}
	creds2 := loader.LoadAdminFallback()
	if creds2.Username != "legacy" || len(creds2.PasswordHashes) != 2 || creds2.PasswordHashes[0] != "h1" || creds2.PasswordHashes[1] != "h2" {
		t.Fatalf("unexpected array() creds: %+v", creds2)
	}
}
