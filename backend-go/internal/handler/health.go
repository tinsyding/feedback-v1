package handler

import (
	"net/http"

	"feedback-api/internal/httpx"
)

// Health handles GET /healthz.
func Health(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("仅支持 GET"), http.StatusMethodNotAllowed)
		return
	}
	httpx.SendResponse(w, true, map[string]string{
		"service": "feedback-api",
		"engine":  "go",
		"status":  "ok",
	}, nil, http.StatusOK)
}
