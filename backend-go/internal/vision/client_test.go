package vision

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func makePNGBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func makeJPEGBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestInspectImage(t *testing.T) {
	w, h, mime, ok := InspectImage(makePNGBytes(t, 400, 300))
	if !ok || w != 400 || h != 300 || mime != "image/png" {
		t.Fatalf("PNG inspect got (%d,%d,%q,%v)", w, h, mime, ok)
	}

	w, h, mime, ok = InspectImage(makeJPEGBytes(t, 320, 240))
	if !ok || w != 320 || h != 240 || mime != "image/jpeg" {
		t.Fatalf("JPEG inspect got (%d,%d,%q,%v)", w, h, mime, ok)
	}

	if _, _, _, ok := InspectImage([]byte("GIF89a\x01\x00\x01\x00")); ok {
		t.Fatal("GIF must be rejected")
	}
	if _, _, _, ok := InspectImage([]byte("not an image")); ok {
		t.Fatal("plain text must be rejected")
	}
}

func TestParseModelJSON(t *testing.T) {
	raw := `<THINK>
thinking... {"fake": 1}
</think>
Here is the JSON:
` + "```json\n" + `{"matched": true, "count": 1, "needs_reply": null}` + "\n```"

	parsed, err := ParseModelJSON(raw)
	if err != nil {
		t.Fatalf("ParseModelJSON failed: %v", err)
	}
	if parsed["matched"] != true {
		t.Fatalf("matched = %#v", parsed["matched"])
	}
	if n, ok := parsed["count"].(json.Number); !ok || n.String() != "1" {
		t.Fatalf("count = %#v", parsed["count"])
	}

	// Fallback brace extraction with prefix/suffix chatter
	parsed2, err := ParseModelJSON(`Result: {"success": false, "reason": "none"} Done.`)
	if err != nil || parsed2["success"] != false {
		t.Fatalf("fallback brace extraction failed: %+v, err=%v", parsed2, err)
	}

	if _, err := ParseModelJSON("plain non-json text"); err == nil {
		t.Fatal("expected error for non-json output")
	}
}

func TestClientComplete(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sk-test" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"message":"invalid api key"}}`))
			return
		}
		var req ChatCompletionRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatal(err)
		}
		if req.Model != "qwen3.8-max" || req.Temperature != 0 {
			t.Fatalf("unexpected request: %+v", req)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"ok\":true}"}}]}`))
	}))
	defer srv.Close()

	c := &Client{HTTPClient: srv.Client()}
	got, err := c.Complete(context.Background(), srv.URL, "sk-test", "qwen3.8-max", 5*time.Second, []ContentPart{{Type: "text", Text: "hi"}})
	if err != nil || got != `{"ok":true}` {
		t.Fatalf("got (%q, %v)", got, err)
	}

	_, err = c.Complete(context.Background(), srv.URL, "bad", "qwen3.8-max", 5*time.Second, []ContentPart{{Type: "text", Text: "hi"}})
	if err == nil || !strings.Contains(err.Error(), "视觉模型返回为空：invalid api key") {
		t.Fatalf("expected upstream error message, got %v", err)
	}
}

func TestClientBlocksLoopbackAndRedirects(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://example.com/", http.StatusTemporaryRedirect)
	}))
	defer srv.Close()

	// Default NewClient() must block loopback SSRF
	defaultClient := NewClient()
	_, err := defaultClient.Complete(context.Background(), srv.URL, "sk-test", "qwen3.8-max", 5*time.Second, []ContentPart{{Type: "text", Text: "hi"}})
	if err == nil || !strings.Contains(err.Error(), "禁止访问内网或本地地址") {
		t.Fatalf("expected SSRF block error for loopback, got %v", err)
	}

	// Redirect responses must be rejected without following
	noRedirectClient := srv.Client()
	noRedirectClient.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	c := &Client{HTTPClient: noRedirectClient}
	_, err = c.Complete(context.Background(), srv.URL, "sk-test", "qwen3.8-max", 5*time.Second, []ContentPart{{Type: "text", Text: "hi"}})
	if err == nil || !strings.Contains(err.Error(), "禁止重定向") {
		t.Fatalf("expected redirect rejection, got %v", err)
	}
}
