package handler

import (
	"net/http"

	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
)

type publicConfigPayload struct {
	Success               bool   `json:"success"`
	SemesterYear          int    `json:"semesterYear"`
	DefaultSeason         string `json:"defaultSeason"`
	SemesterWeeks         int    `json:"semesterWeeks"`
	ForceIntegerScores    bool   `json:"forceIntegerScores"`
	RetestQuestionSpacing int    `json:"retestQuestionSpacing"`
	RetestQrCodeEnabled   bool   `json:"retestQrCodeEnabled"`
	DisableQwenFlashTitle bool   `json:"disableQwenFlashTitle"`
}

// PublicConfig ports feedback-v1/api/public_config.php with dynamic per-request config.json reading and flat output.
func PublicConfig(loader *config.Loader) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cfg := loader.Load()
		raw := cfg.Raw

		out := publicConfigPayload{
			Success:               true,
			SemesterYear:          2026,
			DefaultSeason:         "autumn",
			SemesterWeeks:         18,
			ForceIntegerScores:    true,
			RetestQuestionSpacing: 26,
			RetestQrCodeEnabled:   false,
			DisableQwenFlashTitle: false,
		}

		if v, ok := raw["semesterYear"]; ok {
			out.SemesterYear = config.AsPHPInt(v)
		}
		if v, ok := raw["defaultSeason"]; ok {
			out.DefaultSeason = config.AsPHPString(v)
		}
		if v, ok := raw["semesterWeeks"]; ok {
			out.SemesterWeeks = config.AsPHPInt(v)
		}
		if v, ok := raw["forceIntegerScores"]; ok {
			out.ForceIntegerScores = config.AsPHPBool(v)
		}
		if v, ok := raw["retestQuestionSpacing"]; ok {
			out.RetestQuestionSpacing = config.AsPHPInt(v)
		}
		if v, ok := raw["retestQrCodeEnabled"]; ok {
			out.RetestQrCodeEnabled = config.AsPHPBool(v)
		}
		if v, ok := raw["disableQwenFlashTitle"]; ok {
			out.DisableQwenFlashTitle = config.AsPHPBool(v)
		}

		out.SemesterWeeks = max(1, min(30, out.SemesterWeeks))
		out.RetestQuestionSpacing = max(10, min(260, out.RetestQuestionSpacing))

		w.Header().Set("Cache-Control", "public, max-age=300")
		httpx.SendJSON(w, http.StatusOK, out)
	}
}
