package handler

import (
	"net/http"
	"strings"

	"feedback-api/internal/httpx"
	"feedback-api/internal/qbankattest"
	"feedback-api/internal/syslogs"
)

const qbankVerifyPerIPPerMin = 60

// QBankVerifyDeps bundles dependencies for the public /api/v1/qbank/verify endpoint.
type QBankVerifyDeps struct {
	Attest  qbankattest.Store
	Limiter *syslogs.IngestLimiter
}

// QBankJWKS serves GET /.well-known/jwks.json with RFC 8037 OKP Ed25519 public keys.
func QBankJWKS(store qbankattest.Store, signer *qbankattest.Signer) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("不支持的请求方法"), http.StatusMethodNotAllowed)
			return
		}

		var keys []qbankattest.JWKKey
		if store != nil {
			if listed, err := store.ListPublicKeys(r.Context()); err == nil {
				keys = listed
			} else if signer == nil {
				httpx.SendResponse(w, false, nil, httpx.StrPtr("查询验签公钥失败，请稍后重试"), http.StatusInternalServerError)
				return
			}
		}
		if len(keys) == 0 && signer != nil {
			keys = []qbankattest.JWKKey{signer.JWK()}
		}
		if keys == nil {
			keys = []qbankattest.JWKKey{}
		}

		w.Header().Set("Cache-Control", "public, max-age=300")
		httpx.SendJSON(w, http.StatusOK, qbankattest.JWKS{Keys: keys})
	}
}

// QBankVerify handles public unauthenticated GET /api/v1/qbank/verify?code=QB-... requests.
func QBankVerify(deps QBankVerifyDeps) http.HandlerFunc {
	limiter := deps.Limiter
	if limiter == nil {
		limiter = syslogs.NewIngestLimiter()
	}

	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodGet {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("不支持的请求方法"), http.StatusMethodNotAllowed)
			return
		}

		ip := httpx.GetClientIP(r)
		if !limiter.Allow("qbank_verify:"+ip, qbankVerifyPerIPPerMin) {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("核验请求过于频繁，请稍后再试"), http.StatusTooManyRequests)
			return
		}

		if deps.Attest == nil {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("存证核验服务未配置"), http.StatusInternalServerError)
			return
		}

		code := strings.TrimSpace(r.URL.Query().Get("code"))
		res, err := deps.Attest.VerifyReceipt(r.Context(), code)
		if err != nil {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("存证核验查询失败，请稍后重试"), http.StatusInternalServerError)
			return
		}
		if res == nil {
			res = &qbankattest.VerifyResult{Status: qbankattest.StatusNotFound}
		}

		httpx.SendResponse(w, true, res, nil, http.StatusOK)
	}
}

// QBankAnchors handles public unauthenticated GET /api/v1/qbank/anchors requests.
func QBankAnchors(deps QBankVerifyDeps) http.HandlerFunc {
	limiter := deps.Limiter
	if limiter == nil {
		limiter = syslogs.NewIngestLimiter()
	}

	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=60")
		if r.Method != http.MethodGet {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("不支持的请求方法"), http.StatusMethodNotAllowed)
			return
		}

		ip := httpx.GetClientIP(r)
		if !limiter.Allow("qbank_anchors:"+ip, qbankVerifyPerIPPerMin) {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("请求过于频繁，请稍后再试"), http.StatusTooManyRequests)
			return
		}

		if deps.Attest == nil {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("存证核验服务未配置"), http.StatusInternalServerError)
			return
		}

		items, err := deps.Attest.ListAnchors(r.Context(), 50)
		if err != nil {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("查询外部时间锚定清单失败"), http.StatusInternalServerError)
			return
		}
		if items == nil {
			items = []qbankattest.AnchorRecord{}
		}
		httpx.SendResponse(w, true, map[string]any{
			"items": items,
			"total": len(items),
		}, nil, http.StatusOK)
	}
}
