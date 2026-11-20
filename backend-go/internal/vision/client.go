package vision

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var (
	reThinkTag   = regexp.MustCompile(`(?is)<think>.*?</think>`)
	reFenceStart = regexp.MustCompile("(?i)^```(?:json)?\\s*")
	reFenceEnd   = regexp.MustCompile("\\s*```$")
	reBraces     = regexp.MustCompile(`(?s)\{.*\}`)
)

// ContentPart represents a text or image_url part inside an OpenAI-compatible user message.
type ContentPart struct {
	Type     string    `json:"type"`
	Text     string    `json:"text,omitempty"`
	ImageURL *ImageURL `json:"image_url,omitempty"`
}

// ImageURL wraps a base64 data URI for multimodal chat completions.
type ImageURL struct {
	URL string `json:"url"`
}

// ChatMessage represents a single message in the Chat Completions request.
type ChatMessage struct {
	Role    string        `json:"role"`
	Content []ContentPart `json:"content"`
}

// ChatCompletionRequest is the OpenAI-compatible request payload.
type ChatCompletionRequest struct {
	Model       string        `json:"model"`
	Messages    []ChatMessage `json:"messages"`
	Temperature float64       `json:"temperature"`
}

// Client calls OpenAI-compatible Chat Completions endpoints.
type Client struct {
	HTTPClient *http.Client
}

// NewClient creates a Vision client with default HTTP transport.
func NewClient() *Client {
	return &Client{
		HTTPClient: &http.Client{},
	}
}

// InspectImage verifies image bytes are PNG or JPEG via image.DecodeConfig and returns dimensions and MIME type.
func InspectImage(data []byte) (width int, height int, mime string, ok bool) {
	if len(data) == 0 {
		return 0, 0, "", false
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return 0, 0, "", false
	}
	switch format {
	case "png":
		return cfg.Width, cfg.Height, "image/png", true
	case "jpeg":
		return cfg.Width, cfg.Height, "image/jpeg", true
	default:
		return 0, 0, "", false
	}
}

// EncodeDataURL encodes image bytes into a data:<mime>;base64,... URI.
func EncodeDataURL(mime string, data []byte) string {
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data)
}

// Complete sends a multimodal Chat Completions request and returns the raw assistant message content.
func (c *Client) Complete(ctx context.Context, apiBase, apiKey, model string, timeout time.Duration, parts []ContentPart) (string, error) {
	payload := ChatCompletionRequest{
		Model: model,
		Messages: []ChatMessage{
			{
				Role:    "user",
				Content: parts,
			},
		},
		Temperature: 0,
	}

	var body bytes.Buffer
	enc := json.NewEncoder(&body)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(payload); err != nil {
		return "", fmt.Errorf("视觉模型调用失败：%w", err)
	}

	reqCtx := ctx
	var cancel context.CancelFunc
	if timeout > 0 {
		reqCtx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, apiBase, &body)
	if err != nil {
		return "", fmt.Errorf("视觉模型调用失败：%w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	httpClient := c.HTTPClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("视觉模型调用失败：%v", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return "", fmt.Errorf("视觉模型调用失败：%v", err)
	}
	if len(raw) == 0 {
		return "", fmt.Errorf("视觉模型调用失败：empty response (HTTP %d)", resp.StatusCode)
	}

	var decoded struct {
		Choices []struct {
			Message struct {
				Content any `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &decoded)

	var content string
	if len(decoded.Choices) > 0 {
		if s, ok := decoded.Choices[0].Message.Content.(string); ok {
			content = s
		}
	}
	if strings.TrimSpace(content) == "" {
		upErr := decoded.Error.Message
		if upErr == "" {
			upErr = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		return "", fmt.Errorf("视觉模型返回为空：%s", upErr)
	}

	return content, nil
}

// ParseModelJSON strips <think> blocks and markdown code fences, extracts the JSON object, and decodes it with UseNumber.
func ParseModelJSON(content string) (map[string]any, error) {
	text := strings.TrimSpace(content)
	text = reThinkTag.ReplaceAllString(text, "")
	text = strings.TrimSpace(text)
	text = reFenceStart.ReplaceAllString(text, "")
	text = reFenceEnd.ReplaceAllString(text, "")

	trimmed := strings.TrimSpace(text)
	if !strings.HasPrefix(trimmed, "{") || !strings.HasSuffix(trimmed, "}") {
		if match := reBraces.FindString(text); match != "" {
			text = match
		}
	}

	dec := json.NewDecoder(strings.NewReader(strings.TrimSpace(text)))
	dec.UseNumber()
	var parsed map[string]any
	if err := dec.Decode(&parsed); err != nil || parsed == nil {
		return nil, fmt.Errorf("视觉模型返回非 JSON")
	}
	return parsed, nil
}
