package handler

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"

	"golang.org/x/crypto/bcrypt"

	"feedback-api/internal/admin"
	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
	"feedback-api/internal/session"
)

func handleAdminLogin(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	if r.Method != http.MethodPost {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("只支持 POST 请求"), http.StatusMethodNotAllowed)
		return
	}
	input, _ := decodeAdminJSONBody(r)
	username := strings.TrimSpace(config.AsPHPString(input["username"]))
	password := config.AsPHPString(input["password"])
	if username == "" || password == "" {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("请输入用户名和密码"), http.StatusBadRequest)
		return
	}

	clientIP := httpx.GetClientIP(r)
	userKey := clientIP + "_" + username
	userStatus := getRateStatus(r.Context(), deps.RateLimit, "admin_login_user", userKey, 600)
	ipStatus := getRateStatus(r.Context(), deps.RateLimit, "admin_login_ip", clientIP, 600)
	if userStatus.Locked || ipStatus.Locked {
		remain := userStatus.RemainingSeconds
		if ipStatus.RemainingSeconds > remain {
			remain = ipStatus.RemainingSeconds
		}
		if remain < 1 {
			remain = 1
		}
		httpx.SendResponse(w, false, nil, httpx.StrPtr(fmt.Sprintf("登录失败次数过多，该账号已被临时锁定，请 %d 秒后再试", remain)), http.StatusTooManyRequests)
		return
	}

	var adminUser *admin.AdminUser
	authenticated := false

	// 1. Primary DB lookup
	if deps.Repo != nil {
		u, err := deps.Repo.FindAdminByUsername(r.Context(), username)
		if err == nil && u != nil {
			adminUser = u
			if u.Status != 1 {
				httpx.SendResponse(w, false, nil, httpx.StrPtr("该管理员账号已被禁用，请联系系统管理"), http.StatusForbidden)
				return
			}
			ok, needsUpgrade := verifyAdminPassword(password, u.PasswordHash)
			if ok {
				authenticated = true
				if needsUpgrade {
					if newHash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost); err == nil {
						_ = deps.Repo.UpdateAdminPasswordHash(r.Context(), u.ID, string(newHash))
					}
				}
			}
		}
	}

	// 2. Emergency fallback when DB has no row or is unavailable
	if !authenticated && adminUser == nil && deps.ConfigLoader != nil {
		fb := deps.ConfigLoader.LoadAdminFallback()
		if username == fb.Username && len(fb.PasswordHashes) > 0 {
			sum := sha256.Sum256([]byte(password))
			pwdHex := hex.EncodeToString(sum[:])
			for _, h := range fb.PasswordHashes {
				if subtle.ConstantTimeCompare([]byte(h), []byte(pwdHex)) == 1 {
					authenticated = true
					break
				}
			}
			if authenticated && deps.Repo != nil {
				if newHash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost); err == nil {
					_ = deps.Repo.UpsertFallbackAdmin(r.Context(), username, string(newHash))
				}
			}
		}
	}

	if !authenticated {
		recordRateFailure(r.Context(), deps.RateLimit, "admin_login_user", userKey, 5, 600, 600)
		recordRateFailure(r.Context(), deps.RateLimit, "admin_login_ip", clientIP, 10, 600, 600)
		adminAuditLog(r, deps, nil, "warn", "admin_login_failed", map[string]any{
			"username": username,
			"ip":       clientIP,
			"message":  "管理员登录失败：用户名或密码错误",
		})
		httpx.SendResponse(w, false, nil, httpx.StrPtr("用户名或密码错误"), http.StatusUnauthorized)
		return
	}

	clearRateFailure(r.Context(), deps.RateLimit, "admin_login_user", userKey)
	clearRateFailure(r.Context(), deps.RateLimit, "admin_login_ip", clientIP)

	realName := "超级管理员"
	role := "super_admin"
	if adminUser != nil {
		if adminUser.RealName != "" {
			realName = adminUser.RealName
		}
		if adminUser.Role != "" {
			role = adminUser.Role
		}
	}

	// Preserve any concurrent foreground user session while regenerating PHPSESSID
	sess, _ := loadAuthSession(r, deps.Sessions)
	sess.Data["admin_logged_in"] = true
	sess.Data["admin_username"] = username
	sess.Data["admin_realname"] = realName
	sess.Data["admin_role"] = role
	sess.Data["login_time"] = deps.now().Unix()

	if err := session.Regenerate(r.Context(), w, r, deps.Sessions, sess); err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("会话创建失败，请稍后重试"), http.StatusInternalServerError)
		return
	}

	if deps.Repo != nil {
		_ = deps.Repo.UpdateAdminLastLogin(r.Context(), username, clientIP)
	}

	adminAuditLog(r, deps, sess, "action", "admin_login_success", map[string]any{
		"username": username,
		"ip":       clientIP,
		"message":  "管理员登录成功",
	})

	httpx.SendResponse(w, true, map[string]any{
		"username":  username,
		"real_name": realName,
		"role":      role,
		"message":   "登录成功",
	}, nil, http.StatusOK)
}

func handleAdminLogout(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	sess, isNew := loadAuthSession(r, deps.Sessions)
	adminUser := "admin"
	if sess != nil && sess.AdminUsername() != "" {
		adminUser = sess.AdminUsername()
	}
	adminAuditLog(r, deps, sess, "info", "admin_logout", map[string]any{
		"username": adminUser,
		"message":  "管理员安全退出登录",
	})

	if !isNew && sess != nil && sess.Data != nil {
		delete(sess.Data, "admin_logged_in")
		delete(sess.Data, "admin_username")
		delete(sess.Data, "admin_realname")
		delete(sess.Data, "admin_role")
		delete(sess.Data, "login_time")
		if sess.IsUserLoggedIn() {
			if deps.Sessions != nil {
				_ = deps.Sessions.Save(r.Context(), sess)
			}
		} else {
			if deps.Sessions != nil && sess.ID != "" {
				_ = deps.Sessions.Destroy(r.Context(), sess.ID)
			}
		}
	}
	httpx.SendResponse(w, true, map[string]any{"message": "已登出"}, nil, http.StatusOK)
}

func handleAdminCheck(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	sess, _ := loadAuthSession(r, deps.Sessions)
	if sess != nil && sess.IsAdminLoggedIn() {
		realName := sess.StringVal("admin_realname")
		if realName == "" {
			realName = "超级管理员"
		}
		role := sess.StringVal("admin_role")
		if role == "" {
			role = "super_admin"
		}
		httpx.SendResponse(w, true, map[string]any{
			"loggedIn":  true,
			"username":  sess.AdminUsername(),
			"real_name": realName,
			"role":      role,
			"loginTime": sess.IntVal("login_time"),
		}, nil, http.StatusOK)
		return
	}
	httpx.SendResponse(w, true, map[string]any{"loggedIn": false}, nil, http.StatusOK)
}

func handleAdminChangePassword(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	sess, ok := session.RequireAdmin(w, r, deps.Sessions)
	if !ok {
		return
	}
	if r.Method != http.MethodPost {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("只支持 POST 请求"), http.StatusMethodNotAllowed)
		return
	}
	input, _ := decodeAdminJSONBody(r)
	oldPwd := config.AsPHPString(input["old_password"])
	newPwd := config.AsPHPString(input["new_password"])
	if oldPwd == "" || newPwd == "" {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("原密码和新密码不能为空"), http.StatusBadRequest)
		return
	}
	if len(newPwd) < 6 {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("新密码长度至少为 6 位"), http.StatusBadRequest)
		return
	}
	if deps.Repo == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("数据库连接失败"), http.StatusInternalServerError)
		return
	}
	curUser := sess.AdminUsername()
	u, err := deps.Repo.FindAdminByUsername(r.Context(), curUser)
	if err != nil {
		writeAdminRepoError(w, err)
		return
	}
	if u == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("未找到当前管理员账号信息"), http.StatusNotFound)
		return
	}
	valid, _ := verifyAdminPassword(oldPwd, u.PasswordHash)
	if !valid {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("原密码不正确"), http.StatusBadRequest)
		return
	}
	newHash, err := bcrypt.GenerateFromPassword([]byte(newPwd), bcrypt.DefaultCost)
	if err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("服务器内部错误，请稍后重试"), http.StatusInternalServerError)
		return
	}
	if err := deps.Repo.UpdateAdminPasswordHash(r.Context(), u.ID, string(newHash)); err != nil {
		writeAdminRepoError(w, err)
		return
	}
	adminAuditLog(r, deps, sess, "action", "admin_password_changed", map[string]any{
		"username": curUser,
		"message":  "管理员修改了密码",
	})
	httpx.SendResponse(w, true, map[string]any{"message": "密码已成功修改"}, nil, http.StatusOK)
}
