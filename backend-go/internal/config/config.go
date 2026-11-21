package config

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

const (
	// DefaultSenderToken matches PHP DEFAULT_SENDER_TOKEN in calibrate_roi.php and identify.php.
	DefaultSenderToken = "jf_feedback_sender_internal_token_2026"

	// DefaultIdentifyAPIBase is the default DashScope OpenAI-compatible chat completions endpoint.
	DefaultIdentifyAPIBase = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"

	// DefaultIdentifyModel is the default vision model for full/reply/calibrate modes.
	DefaultIdentifyModel = "qwen3.8-max"

	// DefaultIdentifyFastModel is the default fast vision model for title mode.
	DefaultIdentifyFastModel = "qwen3.8-flash"
)

// DBConfig holds MySQL connection parameters matching feedback-v1/api/db.php.
type DBConfig struct {
	Host     string
	Port     int
	DBName   string
	Username string
	Password string
	Charset  string
}

// Secrets holds sensitive credentials loaded from env, optional JSON file, or secret_key.local.php.
type Secrets struct {
	SenderApiToken    string   `json:"senderApiToken"`
	SenderApiTokens   []string `json:"senderApiTokens"`
	DashscopeApiKey   string   `json:"dashscopeApiKey"`
	IdentifyApiBase   string   `json:"identifyApiBase"`
	IdentifyModel     string   `json:"identifyModel"`
	IdentifyFastModel string   `json:"identifyFastModel"`
	RetestSecret      string   `json:"retestSecret"`
}

// Loader dynamically reads feedback-v1/config.json, data/.ai_secrets.json, and secret sources per request.
type Loader struct {
	FeedbackRoot string
	SecretsFile  string
	writeMu      sync.Mutex
}

// LockWrite serializes read-modify-write updates to config.json and data/.ai_secrets.json.
func (l *Loader) LockWrite() {
	if l != nil {
		l.writeMu.Lock()
	}
}

// UnlockWrite releases the config write lock acquired by LockWrite.
func (l *Loader) UnlockWrite() {
	if l != nil {
		l.writeMu.Unlock()
	}
}

// NewLoader builds a Loader, falling back to FEEDBACK_SECRETS_FILE from environment when secretsFile is empty.
func NewLoader(feedbackRoot, secretsFile string) *Loader {
	if secretsFile == "" {
		secretsFile = os.Getenv("FEEDBACK_SECRETS_FILE")
	}
	return &Loader{
		FeedbackRoot: feedbackRoot,
		SecretsFile:  secretsFile,
	}
}

// ResolveFeedbackRoot determines the feedback-v1 root directory from explicit flag, env, or relative paths.
func ResolveFeedbackRoot(explicit string) string {
	if explicit != "" {
		return explicit
	}
	if envRoot := strings.TrimSpace(os.Getenv("FEEDBACK_ROOT")); envRoot != "" {
		return envRoot
	}
	for _, candidate := range []string{"./feedback-v1", "../feedback-v1"} {
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
	}
	return "."
}

// LoadEnvFileFromEnv loads the file specified by FEEDBACK_ENV_FILE if set, without overwriting existing OS env vars.
func LoadEnvFileFromEnv() error {
	path := strings.TrimSpace(os.Getenv("FEEDBACK_ENV_FILE"))
	if path == "" {
		return nil
	}
	return LoadEnvFile(path)
}

// LoadEnvFile parses a KEY=VALUE env file and sets variables not already present in the process environment.
func LoadEnvFile(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read env file %q: %w", path, err)
	}
	content := strings.TrimPrefix(string(raw), "\xef\xbb\xbf")
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "export ") {
			line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		}
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		if key == "" {
			continue
		}
		val := parseEnvValue(strings.TrimSpace(line[eq+1:]))
		if _, exists := os.LookupEnv(key); !exists {
			_ = os.Setenv(key, val)
		}
	}
	return nil
}

func parseEnvValue(raw string) string {
	if len(raw) >= 2 && raw[0] == '"' {
		for i := 1; i < len(raw); i++ {
			if raw[i] == '\\' && i+1 < len(raw) {
				i++
				continue
			}
			if raw[i] == '"' {
				rest := strings.TrimSpace(raw[i+1:])
				if rest == "" || strings.HasPrefix(rest, "#") {
					replacer := strings.NewReplacer(
						`\n`, "\n",
						`\r`, "\r",
						`\t`, "\t",
						`\"`, `"`,
						`\\`, `\`,
					)
					return replacer.Replace(raw[1:i])
				}
				break
			}
		}
	}
	if len(raw) >= 2 && raw[0] == '\'' {
		if end := strings.IndexByte(raw[1:], '\''); end >= 0 {
			closeIdx := 1 + end
			rest := strings.TrimSpace(raw[closeIdx+1:])
			if rest == "" || strings.HasPrefix(rest, "#") {
				return raw[1:closeIdx]
			}
		}
	}
	// Strip unquoted inline comments preceded by whitespace.
	for i := 0; i < len(raw); i++ {
		if raw[i] == '#' && (i == 0 || raw[i-1] == ' ' || raw[i-1] == '\t') {
			return strings.TrimSpace(raw[:i])
		}
	}
	return raw
}

// RuntimeConfig represents a per-request snapshot of config.json + data/.ai_secrets.json + resolved secrets.
type RuntimeConfig struct {
	Raw       map[string]any
	AISecrets map[string]any
	Secrets   Secrets
}

// Load reads <FeedbackRoot>/config.json, data/.ai_secrets.json, and resolves secrets on every call (no permanent caching).
func (l *Loader) Load() RuntimeConfig {
	raw := l.loadConfigJSON()
	aiSecrets := l.loadAISecretsJSON()
	secrets := l.loadSecrets()
	return RuntimeConfig{
		Raw:       raw,
		AISecrets: aiSecrets,
		Secrets:   secrets,
	}
}

func (l *Loader) loadConfigJSON() map[string]any {
	return readJSONMapFile(filepath.Join(l.FeedbackRoot, "config.json"), l.FeedbackRoot == "")
}

func (l *Loader) loadAISecretsJSON() map[string]any {
	return readJSONMapFile(filepath.Join(l.FeedbackRoot, "data", ".ai_secrets.json"), l.FeedbackRoot == "")
}

func readJSONMapFile(path string, skip bool) map[string]any {
	if skip {
		return map[string]any{}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return map[string]any{}
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var parsed map[string]any
	if err := dec.Decode(&parsed); err != nil || parsed == nil {
		return map[string]any{}
	}
	return parsed
}

func splitSenderTokens(raw string) []string {
	parts := strings.Split(raw, ",")
	var out []string
	seen := make(map[string]struct{}, len(parts))
	for _, p := range parts {
		t := strings.TrimSpace(p)
		if t == "" {
			continue
		}
		if _, exists := seen[t]; exists {
			continue
		}
		seen[t] = struct{}{}
		out = append(out, t)
	}
	return out
}

func appendUniqueTokens(dst []string, items ...string) []string {
	seen := make(map[string]struct{}, len(dst)+len(items))
	for _, t := range dst {
		seen[t] = struct{}{}
	}
	for _, raw := range items {
		t := strings.TrimSpace(raw)
		if t == "" {
			continue
		}
		if _, exists := seen[t]; exists {
			continue
		}
		seen[t] = struct{}{}
		dst = append(dst, t)
	}
	return dst
}

func (l *Loader) loadSecrets() Secrets {
	var out Secrets

	// Priority 3: <FeedbackRoot>/api/secret_key.local.php
	if l.FeedbackRoot != "" {
		if phpData, err := os.ReadFile(filepath.Join(l.FeedbackRoot, "api", "secret_key.local.php")); err == nil {
			phpSecrets := parsePHPSecretArray(string(phpData))
			applySecrets(&out, phpSecrets)
		}
	}

	// Priority 2: optional JSON file at FEEDBACK_SECRETS_FILE
	secretsPath := l.SecretsFile
	if secretsPath == "" {
		secretsPath = strings.TrimSpace(os.Getenv("FEEDBACK_SECRETS_FILE"))
	}
	if secretsPath != "" {
		if jsonData, err := os.ReadFile(secretsPath); err == nil {
			var fileSecrets Secrets
			if err := json.Unmarshal(jsonData, &fileSecrets); err == nil {
				applySecrets(&out, fileSecrets)
			}
		}
	}

	// Priority 1: OS environment variables
	var envSenderTokens []string
	if v := strings.TrimSpace(os.Getenv("SENDER_API_TOKENS")); v != "" {
		envSenderTokens = appendUniqueTokens(envSenderTokens, splitSenderTokens(v)...)
	}
	if v := strings.TrimSpace(os.Getenv("SENDER_API_TOKEN")); v != "" {
		envSenderTokens = appendUniqueTokens(envSenderTokens, v)
	}
	if len(envSenderTokens) > 0 {
		out.SenderApiTokens = envSenderTokens
		out.SenderApiToken = envSenderTokens[0]
	}

	if v := strings.TrimSpace(os.Getenv("DASHSCOPE_API_KEY")); v != "" {
		out.DashscopeApiKey = v
	}
	if v := os.Getenv("IDENTIFY_API_BASE"); v != "" {
		out.IdentifyApiBase = v
	}
	if v := os.Getenv("IDENTIFY_MODEL"); v != "" {
		out.IdentifyModel = v
	}
	if v := os.Getenv("IDENTIFY_FAST_MODEL"); v != "" {
		out.IdentifyFastModel = v
	}
	if v := os.Getenv("RETEST_SECRET"); v != "" {
		out.RetestSecret = v
	}

	return out
}

func applySecrets(dst *Secrets, src Secrets) {
	var srcTokens []string
	if len(src.SenderApiTokens) > 0 {
		srcTokens = appendUniqueTokens(srcTokens, src.SenderApiTokens...)
	}
	if strings.TrimSpace(src.SenderApiToken) != "" {
		srcTokens = appendUniqueTokens(srcTokens, src.SenderApiToken)
	}
	if len(srcTokens) > 0 {
		dst.SenderApiTokens = srcTokens
		dst.SenderApiToken = srcTokens[0]
	}
	if src.DashscopeApiKey != "" {
		dst.DashscopeApiKey = src.DashscopeApiKey
	}
	if src.IdentifyApiBase != "" {
		dst.IdentifyApiBase = src.IdentifyApiBase
	}
	if src.IdentifyModel != "" {
		dst.IdentifyModel = src.IdentifyModel
	}
	if src.IdentifyFastModel != "" {
		dst.IdentifyFastModel = src.IdentifyFastModel
	}
	if src.RetestSecret != "" {
		dst.RetestSecret = src.RetestSecret
	}
}

// parsePHPSecretArray safely extracts simple `'key' => 'value'` (or string array) entries from secret_key.local.php.
func parsePHPSecretArray(src string) Secrets {
	entries := extractPHPStringPairs(src)
	tokens := splitSenderTokens(entries["senderApiTokens"])
	if len(tokens) == 0 {
		tokens = appendUniqueTokens(nil, extractPHPStringArrayField(src, "senderApiTokens")...)
	}
	return Secrets{
		SenderApiToken:    entries["senderApiToken"],
		SenderApiTokens:   tokens,
		DashscopeApiKey:   entries["dashscopeApiKey"],
		IdentifyApiBase:   entries["identifyApiBase"],
		IdentifyModel:     entries["identifyModel"],
		IdentifyFastModel: entries["identifyFastModel"],
		RetestSecret:      entries["retestSecret"],
	}
}

type phpToken struct {
	kind string // "str", "num", "arrow", "other"
	val  string
}

func extractPHPStringPairs(src string) map[string]string {
	out := make(map[string]string)
	tokens := scanPHPTokens(src)
	for i := 0; i+2 < len(tokens); i++ {
		if tokens[i].kind == "str" && tokens[i+1].kind == "arrow" && tokens[i+2].kind == "str" {
			out[tokens[i].val] = tokens[i+2].val
			i += 2
		}
	}
	return out
}

func extractPHPScalarPairs(src string) map[string]string {
	out := make(map[string]string)
	tokens := scanPHPTokens(src)
	for i := 0; i+2 < len(tokens); i++ {
		if tokens[i].kind == "str" && tokens[i+1].kind == "arrow" && (tokens[i+2].kind == "str" || tokens[i+2].kind == "num") {
			out[tokens[i].val] = tokens[i+2].val
			i += 2
		}
	}
	return out
}

// LoadDBConfig resolves MySQL configuration following db.php precedence:
// defaults -> <FeedbackRoot>/api/db.local.php -> OS env overrides (DB_HOST, DB_PORT, DB_DATABASE, DB_USERNAME, DB_PASSWORD, DB_CHARSET).
func (l *Loader) LoadDBConfig() DBConfig {
	cfg := DBConfig{
		Host:     "127.0.0.1",
		Port:     3306,
		DBName:   "feedback",
		Username: "root",
		Password: "",
		Charset:  "utf8mb4",
	}

	if l.FeedbackRoot != "" {
		if raw, err := os.ReadFile(filepath.Join(l.FeedbackRoot, "api", "db.local.php")); err == nil {
			pairs := extractPHPScalarPairs(string(raw))
			if v, ok := pairs["host"]; ok && v != "" {
				cfg.Host = v
			}
			if v, ok := pairs["port"]; ok {
				if p, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && p > 0 {
					cfg.Port = p
				}
			}
			if v, ok := pairs["dbname"]; ok && v != "" {
				cfg.DBName = v
			}
			if v, ok := pairs["username"]; ok && v != "" {
				cfg.Username = v
			}
			if v, ok := pairs["password"]; ok {
				cfg.Password = v
			}
			if v, ok := pairs["charset"]; ok && v != "" {
				cfg.Charset = v
			}
		}
	}

	if v := os.Getenv("DB_HOST"); v != "" {
		cfg.Host = v
	}
	if v := os.Getenv("DB_PORT"); v != "" {
		if p, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && p > 0 {
			cfg.Port = p
		}
	}
	if v := os.Getenv("DB_DATABASE"); v != "" {
		cfg.DBName = v
	}
	if v := os.Getenv("DB_USERNAME"); v != "" {
		cfg.Username = v
	}
	if v, ok := os.LookupEnv("DB_PASSWORD"); ok {
		cfg.Password = v
	}
	if v := os.Getenv("DB_CHARSET"); v != "" {
		cfg.Charset = v
	}

	return cfg
}

func scanPHPTokens(src string) []phpToken {
	var tokens []phpToken
	n := len(src)
	for i := 0; i < n; {
		ch := src[i]
		// Skip whitespace
		if ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n' {
			i++
			continue
		}
		// Line comments // or #
		if ch == '#' || (ch == '/' && i+1 < n && src[i+1] == '/') {
			for i < n && src[i] != '\n' {
				i++
			}
			continue
		}
		// Block comments /* ... */
		if ch == '/' && i+1 < n && src[i+1] == '*' {
			i += 2
			for i+1 < n && !(src[i] == '*' && src[i+1] == '/') {
				i++
			}
			i += 2
			continue
		}
		// Quoted strings '...' or "..."
		if ch == '\'' || ch == '"' {
			quote := ch
			i++
			var b strings.Builder
			for i < n {
				c := src[i]
				if c == '\\' && i+1 < n {
					next := src[i+1]
					if quote == '\'' {
						if next == '\'' || next == '\\' {
							b.WriteByte(next)
							i += 2
							continue
						}
					} else {
						switch next {
						case 'n':
							b.WriteByte('\n')
							i += 2
							continue
						case 'r':
							b.WriteByte('\r')
							i += 2
							continue
						case 't':
							b.WriteByte('\t')
							i += 2
							continue
						case '\\', '"', '$':
							b.WriteByte(next)
							i += 2
							continue
						}
					}
					b.WriteByte(c)
					i++
					continue
				}
				if c == quote {
					i++
					break
				}
				b.WriteByte(c)
				i++
			}
			tokens = append(tokens, phpToken{kind: "str", val: b.String()})
			continue
		}
		// PHP array operator =>
		if ch == '=' && i+1 < n && src[i+1] == '>' {
			tokens = append(tokens, phpToken{kind: "arrow", val: "=>"})
			i += 2
			continue
		}
		// Unquoted integer literals (e.g. 'port' => 3306)
		if ch >= '0' && ch <= '9' {
			start := i
			for i < n && src[i] >= '0' && src[i] <= '9' {
				i++
			}
			tokens = append(tokens, phpToken{kind: "num", val: src[start:i]})
			continue
		}
		tokens = append(tokens, phpToken{kind: "other", val: string(ch)})
		i++
	}
	return tokens
}

// ServerSenderTokens returns all configured custom sender tokens (env -> secrets) or nil if none configured.
func (c RuntimeConfig) ServerSenderTokens() []string {
	var out []string
	if len(c.Secrets.SenderApiTokens) > 0 {
		out = appendUniqueTokens(out, c.Secrets.SenderApiTokens...)
	}
	if strings.TrimSpace(c.Secrets.SenderApiToken) != "" {
		out = appendUniqueTokens(out, c.Secrets.SenderApiToken)
	}
	return out
}

// ServerSenderToken returns the primary configured sender token (env -> secrets) or empty string if using default.
func (c RuntimeConfig) ServerSenderToken() string {
	tokens := c.ServerSenderTokens()
	if len(tokens) == 0 {
		return ""
	}
	return tokens[0]
}

// AllowDefaultSenderToken returns whether fallback to DefaultSenderToken is permitted when no custom token is set.
// Defaults to true for backward compatibility; set ALLOW_DEFAULT_SENDER_TOKEN=false/0/no/off to enforce strict mode.
func (c RuntimeConfig) AllowDefaultSenderToken() bool {
	raw, ok := os.LookupEnv("ALLOW_DEFAULT_SENDER_TOKEN")
	if !ok || strings.TrimSpace(raw) == "" {
		return true
	}
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "0", "false", "no", "off":
		return false
	default:
		return true
	}
}

// VerifySenderToken validates a sender request token using constant-time comparison.
// If custom tokens are configured, only those tokens are accepted (DefaultSenderToken is blocked);
// otherwise DefaultSenderToken is accepted only when AllowDefaultSenderToken() is true.
func (c RuntimeConfig) VerifySenderToken(given string) bool {
	if given == "" {
		return false
	}
	customTokens := c.ServerSenderTokens()
	if len(customTokens) > 0 {
		for _, expected := range customTokens {
			if subtle.ConstantTimeCompare([]byte(expected), []byte(given)) == 1 {
				return true
			}
		}
		return false
	}
	if !c.AllowDefaultSenderToken() {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(DefaultSenderToken), []byte(given)) == 1
}

// VisionAPIKey resolves dashscopeApiKey: data/.ai_secrets.json -> legacy config.json -> DASHSCOPE_API_KEY env -> secrets.
func (c RuntimeConfig) VisionAPIKey() string {
	if v := strings.TrimSpace(c.aiSecretString("dashscopeApiKey")); v != "" {
		return v
	}
	if v := strings.TrimSpace(c.RawString("dashscopeApiKey")); v != "" {
		return v
	}
	return strings.TrimSpace(c.Secrets.DashscopeApiKey)
}

func (c RuntimeConfig) aiSecretString(key string) string {
	if c.AISecrets == nil {
		return ""
	}
	v, ok := c.AISecrets[key]
	if !ok || v == nil {
		return ""
	}
	return AsPHPString(v)
}

// IdentifyAPIBase resolves the chat completions endpoint and ensures it ends with /chat/completions.
func (c RuntimeConfig) IdentifyAPIBase() string {
	base := strings.TrimSpace(c.RawString("identifyApiBase"))
	if base == "" {
		base = c.Secrets.IdentifyApiBase
	}
	if base == "" {
		return DefaultIdentifyAPIBase
	}
	if !strings.HasSuffix(base, "/chat/completions") {
		base = strings.TrimRight(base, "/") + "/chat/completions"
	}
	return base
}

// CalibrateModel resolves the model used by calibrate_roi.
func (c RuntimeConfig) CalibrateModel() string {
	if v := strings.TrimSpace(c.RawString("calibrateModel")); v != "" {
		return v
	}
	return c.baseIdentifyModel()
}

// IdentifyModel resolves the model for identify based on mode and purpose.
func (c RuntimeConfig) IdentifyModel(mode, purpose string) string {
	base := c.baseIdentifyModel()
	switch mode {
	case "sidebar":
		if v := strings.TrimSpace(c.RawString("calibrateModel")); v != "" {
			return v
		}
		return base
	case "title":
		fast := strings.TrimSpace(c.RawString("identifyFastModel"))
		if fast == "" {
			fast = c.Secrets.IdentifyFastModel
		}
		if fast == "" {
			fast = DefaultIdentifyFastModel
		}
		if purpose == "benchmark" {
			if bm := strings.TrimSpace(c.RawString("benchmarkModel")); bm != "" {
				return bm
			}
		}
		return fast
	default:
		return base
	}
}

func (c RuntimeConfig) baseIdentifyModel() string {
	if v := strings.TrimSpace(c.RawString("identifyModel")); v != "" {
		return v
	}
	if c.Secrets.IdentifyModel != "" {
		return c.Secrets.IdentifyModel
	}
	return DefaultIdentifyModel
}

// SenderControl normalizes senderControl policy from config.json.
func (c RuntimeConfig) SenderControl() SenderControlPolicy {
	var rawSC map[string]any
	if sc, ok := c.Raw["senderControl"].(map[string]any); ok {
		rawSC = sc
	}
	return NormalizeGlobalSenderControl(rawSC, c.Raw)
}

// RawString converts an optional field in config.json using PHP string coercion rules.
func (c RuntimeConfig) RawString(key string) string {
	v, ok := c.Raw[key]
	if !ok || v == nil {
		return ""
	}
	return AsPHPString(v)
}

// IsTruthy checks PHP truthiness (!empty) of a key in config.json.
func (c RuntimeConfig) IsTruthy(key string) bool {
	v, ok := c.Raw[key]
	if !ok {
		return false
	}
	return AsPHPBool(v)
}

// AsPHPBool mirrors PHP (bool) / !empty() truthiness across JSON types.
func AsPHPBool(v any) bool {
	if v == nil {
		return false
	}
	switch x := v.(type) {
	case bool:
		return x
	case int:
		return x != 0
	case int64:
		return x != 0
	case float64:
		return x != 0
	case json.Number:
		if i, err := x.Int64(); err == nil {
			return i != 0
		}
		if f, err := x.Float64(); err == nil {
			return f != 0
		}
		return x.String() != "" && x.String() != "0"
	case string:
		return x != "" && x != "0"
	case []any:
		return len(x) > 0
	case map[string]any:
		return len(x) > 0
	default:
		return true
	}
}

// AsPHPString mirrors PHP (string) conversion for scalar JSON values.
func AsPHPString(v any) string {
	if v == nil {
		return ""
	}
	switch x := v.(type) {
	case string:
		return x
	case bool:
		if x {
			return "1"
		}
		return ""
	case json.Number:
		return x.String()
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case float64:
		return strconv.FormatFloat(x, 'g', -1, 64)
	default:
		return ""
	}
}

// AsPHPInt mirrors PHP (int) conversion for scalar JSON values.
func AsPHPInt(v any) int {
	if v == nil {
		return 0
	}
	switch x := v.(type) {
	case int:
		return x
	case int64:
		return int(x)
	case float64:
		return int(x)
	case bool:
		if x {
			return 1
		}
		return 0
	case json.Number:
		if i, err := x.Int64(); err == nil {
			return int(i)
		}
		if f, err := x.Float64(); err == nil {
			return int(f)
		}
		return 0
	case string:
		return parsePHPLeadingInt(x)
	default:
		return 0
	}
}

func parsePHPLeadingInt(s string) int {
	s = strings.TrimLeft(s, " \t\r\n")
	if s == "" {
		return 0
	}
	sign := 1
	idx := 0
	if s[0] == '-' {
		sign = -1
		idx++
	} else if s[0] == '+' {
		idx++
	}
	val := 0
	hasDigit := false
	for idx < len(s) && s[idx] >= '0' && s[idx] <= '9' {
		hasDigit = true
		val = val*10 + int(s[idx]-'0')
		idx++
	}
	if !hasDigit {
		return 0
	}
	return sign * val
}

// AsPHPFloat mirrors PHP (float) conversion for scalar JSON values.
func AsPHPFloat(v any) float64 {
	if v == nil {
		return 0
	}
	switch x := v.(type) {
	case float64:
		return x
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case bool:
		if x {
			return 1
		}
		return 0
	case json.Number:
		f, err := x.Float64()
		if err != nil {
			return 0
		}
		return f
	case string:
		s := strings.TrimSpace(x)
		if s == "" {
			return 0
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return float64(parsePHPLeadingInt(s))
		}
		return f
	default:
		return 0
	}
}
