/**
 * 前台教师账号登录与认证管理模块 (js/auth.js)
 * 支持账号登录、密码重置（测试账号 0 严格禁止重置）
 */

(function () {
    const AUTH_API = 'api/auth.php';
    let currentUser = null;

    // 动态注入登录 / 重置密码弹窗 HTML
    function ensureModalDOMElements() {
        if (document.getElementById('front-auth-modal')) return;

        const modalDiv = document.createElement('dialog');
        modalDiv.id = 'front-auth-modal';
        modalDiv.className = 'dialog-overlay native-dialog';
        modalDiv.innerHTML = `
            <div class="dialog-box dialog-pad">
                <button type="button" id="front-auth-close-btn" class="front-auth-close-btn" onclick="window.hideAuthModal()" style="display:none;" title="关闭">&times;</button>
                
                <!-- 登录视图 -->
                <div id="front-login-view">
                    <form id="front-auth-form" class="front-auth-form" onsubmit="window.handleFrontLogin(event)">
                        <div class="front-auth-field">
                            <div class="front-auth-input-wrapper">
                                <svg class="front-auth-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                                    <circle cx="12" cy="7" r="4"></circle>
                                </svg>
                                <input type="text" id="front-auth-username" class="front-auth-input" placeholder="请输入账号" autocomplete="username" required>
                            </div>
                        </div>

                        <div class="front-auth-field">
                            <div class="front-auth-input-wrapper">
                                <svg class="front-auth-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                                    <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                                </svg>
                                <input type="password" id="front-auth-password" class="front-auth-input" placeholder="请输入密码" autocomplete="current-password" required>
                            </div>
                        </div>

                        <div id="front-auth-error" class="front-auth-error"></div>

                        <button type="submit" id="front-auth-submit-btn" class="front-auth-submit">
                            <span>立即登录</span>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><polyline points="9 18 15 12 9 6"></polyline></svg>
                        </button>
                    </form>

                    <div class="front-auth-footer-links">
                        <button type="button" class="front-auth-link" onclick="window.switchAuthMode('reset')">忘记密码 / 修改密码</button>
                    </div>
                </div>

                <!-- 重置密码视图 -->
                <div id="front-reset-view" style="display:none; padding-top: 10px;">

                    <form id="front-reset-form" class="front-auth-form" onsubmit="window.handleFrontResetPassword(event)">
                        <div class="front-auth-field">
                            <label class="front-auth-label" for="front-reset-username">教师账号</label>
                            <div class="front-auth-input-wrapper">
                                <svg class="front-auth-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                                    <circle cx="12" cy="7" r="4"></circle>
                                </svg>
                                <input type="text" id="front-reset-username" class="front-auth-input" placeholder="请输入教师账号（如 JF001）" autocomplete="username" oninput="window.onResetUsernameChange(this.value)" required>
                            </div>
                            <div id="front-reset-warn-tip" class="front-auth-warn-tip">测试账号为公共体验账号，不支持重置密码</div>
                        </div>

                        <div class="front-auth-field">
                            <label class="front-auth-label" for="front-reset-old-password">原密码 / 初始密码</label>
                            <div class="front-auth-input-wrapper">
                                <svg class="front-auth-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                                    <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                                </svg>
                                <input type="password" id="front-reset-old-password" class="front-auth-input" placeholder="请输入原密码或初始密码" autocomplete="current-password" required>
                            </div>
                        </div>

                        <div class="front-auth-field">
                            <label class="front-auth-label" for="front-reset-new-password">新密码</label>
                            <div class="front-auth-input-wrapper">
                                <svg class="front-auth-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path>
                                </svg>
                                <input type="password" id="front-reset-new-password" class="front-auth-input" placeholder="请输入新密码（至少6位）" autocomplete="new-password" required>
                            </div>
                        </div>

                        <div class="front-auth-field">
                            <label class="front-auth-label" for="front-reset-confirm-password">确认新密码</label>
                            <div class="front-auth-input-wrapper">
                                <svg class="front-auth-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path>
                                </svg>
                                <input type="password" id="front-reset-confirm-password" class="front-auth-input" placeholder="请再次输入新密码" autocomplete="new-password" required>
                            </div>
                        </div>

                        <div id="front-reset-error" class="front-auth-error"></div>

                        <button type="submit" id="front-reset-submit-btn" class="front-auth-submit">
                            <span>确认修改密码</span>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><polyline points="9 18 15 12 9 6"></polyline></svg>
                        </button>
                    </form>

                    <div class="front-auth-footer-links">
                        <button type="button" id="front-reset-back-btn" class="front-auth-link" onclick="window.switchAuthMode('login')">返回登录</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modalDiv);
    }

    // 快捷填入测试账号 0 / 0
    window.fillTestAccount = function () {
        const uInput = document.getElementById('front-auth-username');
        const pInput = document.getElementById('front-auth-password');
        if (uInput) uInput.value = '0';
        if (pInput) pInput.value = '0';
        const submitBtn = document.getElementById('front-auth-submit-btn');
        if (submitBtn) submitBtn.focus();
    };

    // 显示认证弹窗
    function showAuthModal() {
        ensureModalDOMElements();
        const modal = document.getElementById('front-auth-modal');
        if (modal) {
            const closeBtn = document.getElementById('front-auth-close-btn');
            const isDismissible = Boolean(closeBtn && closeBtn.style.display !== 'none');
            if (isDismissible) modal.setAttribute('closedby', 'any');
            else modal.removeAttribute('closedby');
            if (window.DialogHelper) {
                window.DialogHelper.open(modal, { dismissible: isDismissible });
            } else {
                modal.style.display = 'flex';
                modal.classList.add('active');
            }
            setTimeout(() => {
                const uInput = document.getElementById('front-auth-username');
                if (uInput && !uInput.value) uInput.focus();
            }, 100);
        }
    }
    window.showAuthModal = showAuthModal;

    // 隐藏认证弹窗
    function hideAuthModal() {
        const modal = document.getElementById('front-auth-modal');
        if (modal) {
            if (window.DialogHelper) {
                window.DialogHelper.close(modal);
            } else {
                modal.classList.remove('active');
                modal.style.display = 'none';
            }
        }
    }
    window.hideAuthModal = hideAuthModal;

    // 切换登录模式 / 修改密码模式
    window.switchAuthMode = function (mode, isLoggedInModal) {
        ensureModalDOMElements();
        const loginView = document.getElementById('front-login-view');
        const resetView = document.getElementById('front-reset-view');
        const closeBtn = document.getElementById('front-auth-close-btn');
        const backBtn = document.getElementById('front-reset-back-btn');
        const loginErr = document.getElementById('front-auth-error');
        const resetErr = document.getElementById('front-reset-error');
        if (loginErr) loginErr.style.display = 'none';
        if (resetErr) resetErr.style.display = 'none';

        if (mode === 'reset') {
            if (loginView) loginView.style.display = 'none';
            if (resetView) resetView.style.display = 'block';
            const isUserLoggedIn = isLoggedInModal || !!currentUser;
            if (closeBtn) closeBtn.style.display = isUserLoggedIn ? 'flex' : 'none';
            if (backBtn) {
                if (isUserLoggedIn) {
                    backBtn.textContent = '取消并关闭';
                    backBtn.onclick = hideAuthModal;
                } else {
                    backBtn.textContent = '返回登录';
                    backBtn.onclick = () => window.switchAuthMode('login');
                }
            }
            const uInput = document.getElementById('front-reset-username');
            if (uInput) {
                if (currentUser && currentUser.username) {
                    uInput.value = currentUser.username;
                    uInput.readOnly = true;
                } else {
                    uInput.readOnly = false;
                    const loginU = document.getElementById('front-auth-username');
                    if (loginU && loginU.value) uInput.value = loginU.value;
                }
                window.onResetUsernameChange(uInput.value);
            }
        } else {
            if (loginView) loginView.style.display = 'block';
            if (resetView) resetView.style.display = 'none';
            if (closeBtn) closeBtn.style.display = 'none';
        }
    };

    // 监听修改密码账号输入
    window.onResetUsernameChange = function (val) {
        val = (val || '').trim();
        const warnTip = document.getElementById('front-reset-warn-tip');
        const submitBtn = document.getElementById('front-reset-submit-btn');
        if (val === '0') {
            if (warnTip) warnTip.style.display = 'block';
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.title = '测试账号不支持重置密码';
            }
        } else {
            if (warnTip) warnTip.style.display = 'none';
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.title = '';
            }
        }
    };

    // 打开修改密码弹窗（教师在登录后点击使用）
    window.openResetPasswordModal = function () {
        if (currentUser && currentUser.username === '0') {
            if (typeof showToast === 'function') {
                showToast('测试账号为公共体验账号，不支持修改密码');
            } else if (typeof window.showToast === 'function') {
                window.showToast('测试账号为公共体验账号，不支持修改密码');
            }
            return;
        }
        ensureModalDOMElements();
        window.switchAuthMode('reset', true);
        showAuthModal();
    };

    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // 更新导航栏用户信息
    function renderNavUser(user) {
        if (!user) return;
        const navActions = document.querySelector('.nav-actions');
        const isAssistant = user.role === 'assistant';
        const isAdmin = Boolean(user.is_admin || user.role === 'admin' || user.role === 'super_admin');
        const isPureAdmin = Boolean(user.is_admin && (user.role === 'admin' || user.role === 'super_admin'));
        const isTestAccount = user.username === '0';
        const displayName = isTestAccount ? (user.real_name || '测试账号') : (user.real_name || user.username);

        // 权限徽章
        let roleBadgeHtml = '';
        if (isAssistant) {
            roleBadgeHtml = `<span class="badge-role-assistant" title="助教账号">助教</span>`;
        } else if (isAdmin) {
            roleBadgeHtml = `<span class="badge-role-teacher" title="管理员账号">管理员</span>`;
        } else if (!isTestAccount) {
            roleBadgeHtml = `<span class="badge-role-teacher">教师</span>`;
        }

        // 操作按钮集合
        let actionBtnsHtml = '';
        if (isAssistant || isTestAccount) {
            actionBtnsHtml = `<button type="button" class="btn-nav-logout" onclick="window.handleFrontLogout()" title="退出当前账号">退出</button>`;
        } else {
            const adminLinkHtml = isAdmin
                ? `<a class="btn-nav-reset-pwd" href="admin.html" title="返回管理后台" style="text-decoration:none;">管理后台</a>`
                : '';
            const resetPwdHtml = !isPureAdmin
                ? `<button type="button" class="btn-nav-reset-pwd" onclick="window.openResetPasswordModal()" title="修改当前教师登录密码">修改密码</button>`
                : '';
            actionBtnsHtml = `
                ${adminLinkHtml}
                <button type="button" class="btn-nav-assistant-mgr" onclick="window.openAssistantModal()" title="管理当前账号名下的助教账号">助教管理</button>
                ${resetPwdHtml}
                <button type="button" class="btn-nav-logout" onclick="window.handleFrontLogout()" title="退出当前账号">退出</button>
            `;
        }

        const badgeInnerHtml = `
            <span class="nav-user-identity">
                <svg class="user-avatar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                    <circle cx="12" cy="7" r="4"></circle>
                </svg>
                ${roleBadgeHtml}
                <span class="nav-user-name">${escapeHtml(displayName)}</span>
            </span>
            <span class="nav-user-ops">${actionBtnsHtml}</span>
        `;

        if (navActions) {
            let badge = document.getElementById('nav-user-badge');
            if (!badge) {
                badge = document.createElement('div');
                badge.id = 'nav-user-badge';
                badge.className = 'nav-user-badge';
                navActions.insertBefore(badge, navActions.firstChild);
            }
            badge.innerHTML = badgeInnerHtml;
        }

        // Fallback for index.html or pages without .nav-actions
        const homeShell = document.querySelector('.home-shell');
        if (homeShell) {
            let topBar = document.getElementById('home-top-user-bar');
            if (!topBar) {
                topBar = document.createElement('div');
                topBar.id = 'home-top-user-bar';
                topBar.style.cssText = 'display: flex; justify-content: flex-end; width: 100%; max-width: 900px; margin: 0 auto 16px; padding: 0 10px;';
                homeShell.insertBefore(topBar, homeShell.firstChild);
            }
            topBar.innerHTML = `<div class="nav-user-badge" id="nav-user-badge">${badgeInnerHtml}</div>`;
        }
    }

    // 确保助教管理弹窗 DOM 结构已注入
    function ensureAssistantModalDOMElements() {
        if (document.getElementById('front-assistant-modal')) return;

        const modalDiv = document.createElement('dialog');
        modalDiv.id = 'front-assistant-modal';
        modalDiv.className = 'dialog-overlay native-dialog';
        modalDiv.setAttribute('closedby', 'any');
        modalDiv.innerHTML = `
            <div class="dialog-box dialog-pad xwide" style="overflow-y: auto;">
                <div class="front-assistant-header">
                    <div class="front-assistant-title-row">
                        <h3 class="front-assistant-title">助教账号管理</h3>
                    </div>
                    <button type="button" class="front-auth-close-btn" onclick="window.closeAssistantModal()" title="关闭">&times;</button>
                </div>

                <div class="front-assistant-toolbar">
                    <div class="front-assistant-count" id="assistant-count-text">助教列表</div>
                    <div class="front-assistant-actions">
                        <button type="button" class="btn-assistant-refresh" onclick="window.loadAssistantList()" title="刷新助教列表">
                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"></path><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
                            刷新
                        </button>
                        <button type="button" class="btn-assistant-add" onclick="window.toggleAddAssistantForm(true)">
                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                            新增助教
                        </button>
                    </div>
                </div>

                <!-- 新增助教表单 -->
                <div id="assistant-add-box" class="assistant-sub-form-box" style="display:none;">
                    <div class="assistant-sub-title">添加新助教</div>
                    <form id="assistant-add-form" onsubmit="window.handleAssistantCreate(event)">
                        <div class="assistant-form-grid">
                            <div class="assistant-form-field">
                                <label>助教账号 <span class="req">*</span></label>
                                <div class="assistant-input-prefix-group">
                                    <span class="assistant-input-prefix" id="ta-add-prefix">..._</span>
                                    <input type="text" id="ta-add-username" placeholder="如 01 或 ta1" autocomplete="off" required>
                                </div>
                                <div style="font-size: 0.73rem; color: var(--text-muted, #888); margin-top: 4px;">
                                    登录账号：<span id="ta-add-preview" style="font-family: var(--font-mono, monospace); font-weight: 500; color: var(--accent, #2563eb);">-</span>
                                </div>
                            </div>
                            <div class="assistant-form-field">
                                <label>助教姓名 <span class="req">*</span></label>
                                <input type="text" id="ta-add-realname" placeholder="如 张助教" autocomplete="off" required>
                            </div>
                            <div class="assistant-form-field">
                                <label>初始密码 <span class="req">*</span></label>
                                <input type="password" id="ta-add-password" placeholder="至少6位" autocomplete="new-password" required minlength="6">
                            </div>
                        </div>
                        <div id="ta-add-error" class="front-auth-error" style="display:none; margin-top:8px;"></div>
                        <div class="assistant-sub-actions">
                            <button type="button" class="btn-sub-cancel" onclick="window.toggleAddAssistantForm(false)">取消</button>
                            <button type="submit" id="ta-add-submit-btn" class="btn-sub-confirm">确认添加</button>
                        </div>
                    </form>
                </div>

                <!-- 创建助教成功凭证卡片 (含一键复制) -->
                <div id="assistant-created-box" class="assistant-sub-form-box" style="display:none; background:rgba(34, 197, 94, 0.08); border-color:rgba(34, 197, 94, 0.35);">
                    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
                        <div style="font-size:0.92rem; font-weight:600; color:var(--positive, #16a34a); display:flex; align-items:center; gap:6px;">
                            <span>助教账号创建成功</span>
                        </div>
                        <button type="button" class="front-auth-close-btn" onclick="document.getElementById('assistant-created-box').style.display='none'" style="font-size:1.1rem; line-height:1;" title="关闭">&times;</button>
                    </div>
                    <div class="assistant-credentials-panel" style="background:rgba(0,0,0,0.25); border-radius:8px; padding:12px 14px; font-size:0.85rem; line-height:1.75; color:var(--text-primary,#fff); font-family:var(--font-mono, monospace);">
                        <div>助教姓名：<strong id="created-ta-name" style="color:var(--text-primary,#fff);">-</strong></div>
                        <div>登录账号：<strong id="created-ta-username" style="color:var(--accent,#2563eb);">-</strong></div>
                        <div>初始密码：<strong id="created-ta-password" style="color:#f59e0b;">-</strong></div>
                        <div style="font-size:0.78rem; color:var(--text-secondary,#ababae); margin-top:3px;">登录入口：<span id="created-ta-url">https://vip.wxjifang.cn</span></div>
                    </div>
                    <div class="assistant-sub-actions" style="margin-top:12px;">
                        <button type="button" class="btn-sub-cancel" onclick="document.getElementById('assistant-created-box').style.display='none'">关闭</button>
                        <button type="button" class="btn-sub-confirm" id="btn-copy-created-ta" onclick="window.copyCreatedAssistantInfo()" style="background:#16a34a; border-color:#16a34a; display:inline-flex; align-items:center; gap:6px;">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                            <span>复制账号密码</span>
                        </button>
                    </div>
                </div>

                <!-- 编辑助教表单 -->
                <div id="assistant-edit-box" class="assistant-sub-form-box" style="display:none;">
                    <div class="assistant-sub-title">编辑助教: <span id="ta-edit-uname-disp" style="color:var(--accent,#2563eb);font-family:monospace;font-weight:600;"></span></div>
                    <form id="assistant-edit-form" onsubmit="window.handleAssistantUpdate(event)">
                        <input type="hidden" id="ta-edit-id">
                        <div class="assistant-form-grid">
                            <div class="assistant-form-field">
                                <label>助教姓名 <span class="req">*</span></label>
                                <input type="text" id="ta-edit-realname" required autocomplete="off">
                            </div>
                            <div class="assistant-form-field">
                                <label>重置密码（留空则不修改）</label>
                                <input type="password" id="ta-edit-password" placeholder="若无需重置请留空" autocomplete="new-password" minlength="6">
                            </div>
                            <div class="assistant-form-field">
                                <label>账号状态</label>
                                <select id="ta-edit-status" class="assistant-select">
                                    <option value="1">正常使用</option>
                                    <option value="0">停用账号</option>
                                </select>
                            </div>
                        </div>
                        <div id="ta-edit-error" class="front-auth-error" style="display:none; margin-top:8px;"></div>
                        <div class="assistant-sub-actions">
                            <button type="button" class="btn-sub-cancel" onclick="window.toggleEditAssistantForm(false)">取消</button>
                            <button type="submit" id="ta-edit-submit-btn" class="btn-sub-confirm">保存更改</button>
                        </div>
                    </form>
                </div>

                <!-- 助教列表内容 -->
                <div class="assistant-list-wrapper" id="assistant-list-wrapper">
                    <div id="assistant-loading" style="text-align:center;padding:36px;color:var(--text-secondary,#ababae);">
                        加载中...
                    </div>
                    <div id="assistant-empty" style="display:none;text-align:center;padding:48px 20px;color:var(--text-secondary,#ababae);">
                        暂无助教账号，点击右上角「+ 新增助教」为当前教师分配助教
                    </div>
                    <div id="assistant-cards-grid" class="assistant-cards-grid" style="display:none;"></div>
                </div>
            </div>
        `;
        document.body.appendChild(modalDiv);
    }

    // 打开助教管理弹窗
    window.openAssistantModal = function () {
        if (currentUser && currentUser.username === '0') {
            if (typeof showToast === 'function') showToast('测试账号为公共体验账号，不支持助教管理');
            else if (typeof window.showToast === 'function') window.showToast('测试账号为公共体验账号，不支持助教管理');
            return;
        }
        ensureAssistantModalDOMElements();
        window.toggleAddAssistantForm(false);
        window.toggleEditAssistantForm(false);
        const createdBox = document.getElementById('assistant-created-box');
        if (createdBox) createdBox.style.display = 'none';
        const modal = document.getElementById('front-assistant-modal');
        if (modal) {
            if (window.DialogHelper) {
                window.DialogHelper.open(modal, { dismissible: true });
            } else {
                modal.classList.add('active');
            }
            window.loadAssistantList();
        }
    };

    // 关闭助教管理弹窗
    window.closeAssistantModal = function () {
        const modal = document.getElementById('front-assistant-modal');
        if (modal) {
            if (window.DialogHelper) {
                window.DialogHelper.close(modal);
            } else {
                modal.classList.remove('active');
            }
        }
    };

    // 展开/收起新增助教表单
    window.toggleAddAssistantForm = function (show) {
        const box = document.getElementById('assistant-add-box');
        const errEl = document.getElementById('ta-add-error');
        if (errEl) errEl.style.display = 'none';
        if (box) {
            box.style.display = show ? 'block' : 'none';
            if (show) {
                window.toggleEditAssistantForm(false);
                const createdBox = document.getElementById('assistant-created-box');
                if (createdBox) createdBox.style.display = 'none';
                const teacherPrefix = (currentUser && currentUser.username) ? currentUser.username : '';
                const prefixEl = document.getElementById('ta-add-prefix');
                const previewEl = document.getElementById('ta-add-preview');
                const uInput = document.getElementById('ta-add-username');
                const rInput = document.getElementById('ta-add-realname');
                const pInput = document.getElementById('ta-add-password');
                if (prefixEl) prefixEl.textContent = `${teacherPrefix}_`;
                if (previewEl) previewEl.textContent = `${teacherPrefix}_...`;
                if (uInput) {
                    uInput.value = '';
                    uInput.oninput = function () {
                        let val = uInput.value.trim();
                        if (val.startsWith(teacherPrefix + '_')) {
                            val = val.substring((teacherPrefix + '_').length);
                        } else if (val.startsWith(teacherPrefix)) {
                            val = val.substring(teacherPrefix.length).replace(/^_/, '');
                        }
                        if (previewEl) previewEl.textContent = `${teacherPrefix}_${val || '...'}`;
                    };
                }
                if (rInput) rInput.value = '';
                if (pInput) pInput.value = '';
                setTimeout(() => { if (uInput) uInput.focus(); }, 50);
            }
        }
    };

    // 展开/收起编辑助教表单
    window.toggleEditAssistantForm = function (show) {
        const box = document.getElementById('assistant-edit-box');
        const errEl = document.getElementById('ta-edit-error');
        if (errEl) errEl.style.display = 'none';
        if (box) {
            box.style.display = show ? 'block' : 'none';
            if (show) {
                const createdBox = document.getElementById('assistant-created-box');
                if (createdBox) createdBox.style.display = 'none';
            }
        }
    };

    // 打开编辑助教弹窗/表单
    window.openEditAssistantModal = function (assistant) {
        if (!assistant) return;
        window.toggleAddAssistantForm(false);
        window.toggleEditAssistantForm(true);

        const idInput = document.getElementById('ta-edit-id');
        const unameDisp = document.getElementById('ta-edit-uname-disp');
        const rInput = document.getElementById('ta-edit-realname');
        const pInput = document.getElementById('ta-edit-password');
        const sSelect = document.getElementById('ta-edit-status');

        if (idInput) idInput.value = assistant.id;
        if (unameDisp) unameDisp.textContent = assistant.username;
        if (rInput) rInput.value = assistant.real_name || assistant.username;
        if (pInput) pInput.value = '';
        if (sSelect) sSelect.value = String(assistant.status ?? 1);
        setTimeout(() => { if (rInput) rInput.focus(); }, 50);
    };

    // 获取助教列表
    window.loadAssistantList = async function () {
        ensureAssistantModalDOMElements();
        const loadingEl = document.getElementById('assistant-loading');
        const emptyEl = document.getElementById('assistant-empty');
        const gridEl = document.getElementById('assistant-cards-grid');
        const countText = document.getElementById('assistant-count-text');

        if (loadingEl) loadingEl.style.display = 'block';
        if (emptyEl) emptyEl.style.display = 'none';
        if (gridEl) gridEl.style.display = 'none';

        try {
            const res = await fetch(`${AUTH_API}?action=assistant_list`);
            const json = await res.json();
            if (loadingEl) loadingEl.style.display = 'none';

            if (json.success && json.data && Array.isArray(json.data.assistants)) {
                const list = json.data.assistants;
                if (countText) countText.textContent = `助教列表 (${list.length})`;

                if (list.length === 0) {
                    if (emptyEl) emptyEl.style.display = 'block';
                    if (gridEl) gridEl.style.display = 'none';
                } else {
                    if (emptyEl) emptyEl.style.display = 'none';
                    if (gridEl) {
                        gridEl.style.display = 'grid';
                        gridEl.innerHTML = '';
                        list.forEach(item => {
                            const card = document.createElement('div');
                            card.className = `assistant-card ${Number(item.status) === 1 ? '' : 'disabled'}`;
                            const isStatusActive = Number(item.status) === 1;
                            const statusPillHtml = isStatusActive 
                                ? `<span class="assistant-status-pill status-active">正常</span>`
                                : `<span class="assistant-status-pill status-disabled">已停用</span>`;

                            const initialPwdHtml = item.initial_password 
                                ? `<span class="assistant-meta-item">初始密码: <code>${escapeHtml(item.initial_password)}</code></span>` 
                                : '';
                            const loginTimeHtml = item.last_login_at 
                                ? `<span class="assistant-meta-item">最近登录: ${escapeHtml(item.last_login_at.substring(0, 16))}</span>`
                                : `<span class="assistant-meta-item" style="color:var(--text-muted,#888);">尚未登录</span>`;

                            card.innerHTML = `
                                <div class="assistant-card-main">
                                    <div class="assistant-card-header">
                                        <span class="assistant-name">${escapeHtml(item.real_name || item.username)}</span>
                                        <span class="assistant-uname">@${escapeHtml(item.username)}</span>
                                        ${statusPillHtml}
                                    </div>
                                    <div class="assistant-card-meta">
                                        ${initialPwdHtml}
                                        <span class="assistant-meta-item">创建时间: ${escapeHtml((item.created_at || '').substring(0, 16))}</span>
                                        ${loginTimeHtml}
                                    </div>
                                </div>
                                <div class="assistant-card-ops">
                                    <button type="button" class="assistant-btn-copy" onclick='window.copyAssistantItemInfo(${JSON.stringify(item)}, event)' title="一键复制助教账号与密码信息">复制</button>
                                    <button type="button" class="assistant-btn-edit" onclick='window.openEditAssistantModal(${JSON.stringify(item)})' title="修改助教姓名、密码或状态">编辑</button>
                                    <button type="button" class="assistant-btn-del" onclick="window.handleAssistantDelete(${item.id}, '${escapeHtml(item.username)}')" title="删除此助教账号">删除</button>
                                </div>
                            `;
                            gridEl.appendChild(card);
                        });
                    }
                }
            } else {
                if (emptyEl) {
                    emptyEl.style.display = 'block';
                    emptyEl.textContent = json.error || '获取助教列表失败';
                }
            }
        } catch (e) {
            if (loadingEl) loadingEl.style.display = 'none';
            if (emptyEl) {
                emptyEl.style.display = 'block';
                emptyEl.textContent = '网络异常，获取助教列表失败';
            }
        }
    };

    let lastCreatedAssistantData = null;

    function formatAssistantShareText(data) {
        const name = data.real_name || data.username || '-';
        const uname = data.username || '-';
        const pwd = data.password || data.initial_password || '（已设置独立密码）';
        const isPreviewOrTest = /feedback(backup|test)\.wxjifang\.cn$/.test(window.location.hostname);
        const loginUrl = isPreviewOrTest
            ? `${window.location.origin}/index.html`
            : (window.location.origin.includes('wxjifang.cn')
                ? 'https://feedback.wxjifang.cn/index.html'
                : `${window.location.origin}/index.html`);
        return `【极方助教账号】\n助教姓名：${name}\n登录账号：${uname}\n初始密码：${pwd}\n登录入口：${loginUrl}\n权限说明：具备学情反馈制作与错题本查阅打印权限（不可修改已配置题目）`;
    }

    async function copyTextToClipboard(text) {
        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard.writeText(text);
        }
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        return new Promise((resolve, reject) => {
            const successful = document.execCommand('copy');
            textArea.remove();
            if (successful) resolve();
            else reject(new Error('copy command failed'));
        });
    }

    window.copyCreatedAssistantInfo = async function () {
        if (!lastCreatedAssistantData) return;
        const text = formatAssistantShareText(lastCreatedAssistantData);
        try {
            await copyTextToClipboard(text);
            if (typeof showToast === 'function') {
                showToast('助教账号密码已复制到剪贴板');
            } else if (typeof window.showToast === 'function') {
                window.showToast('助教账号密码已复制到剪贴板');
            }
            const btn = document.getElementById('btn-copy-created-ta');
            if (btn) {
                const oldHtml = btn.innerHTML;
                btn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> <span>已复制</span>`;
                setTimeout(() => { btn.innerHTML = oldHtml; }, 2500);
            }
        } catch (e) {
            prompt('请手动复制助教账号密码：', text);
        }
    };

    window.copyAssistantItemInfo = async function (item, e) {
        if (e && e.stopPropagation) e.stopPropagation();
        const text = formatAssistantShareText(item);
        try {
            await copyTextToClipboard(text);
            if (typeof showToast === 'function') {
                showToast(`已复制助教「${item.real_name || item.username}」账号密码`);
            } else if (typeof window.showToast === 'function') {
                window.showToast(`已复制助教「${item.real_name || item.username}」账号密码`);
            }
        } catch (err) {
            prompt('请手动复制助教账号密码：', text);
        }
    };

    // 提交创建助教
    window.handleAssistantCreate = async function (e) {
        if (e) e.preventDefault();
        const uInput = document.getElementById('ta-add-username');
        const rInput = document.getElementById('ta-add-realname');
        const pInput = document.getElementById('ta-add-password');
        const errEl = document.getElementById('ta-add-error');
        const btn = document.getElementById('ta-add-submit-btn');

        const teacherPrefix = (currentUser && currentUser.username) ? currentUser.username : '';
        let suffix = uInput ? uInput.value.trim() : '';
        if (suffix.startsWith(teacherPrefix + '_')) {
            suffix = suffix.substring((teacherPrefix + '_').length);
        } else if (suffix.startsWith(teacherPrefix)) {
            suffix = suffix.substring(teacherPrefix.length).replace(/^_/, '');
        }

        const real_name = rInput ? rInput.value.trim() : '';
        const password = pInput ? pInput.value.trim() : '';

        if (!suffix || !real_name || !password) {
            if (errEl) { errEl.textContent = '请完整填写助教账号后缀、姓名和初始密码'; errEl.style.display = 'flex'; }
            return;
        }

        const username = `${teacherPrefix}_${suffix}`;

        if (errEl) errEl.style.display = 'none';
        if (btn) { btn.disabled = true; btn.textContent = '添加中...'; }

        try {
            const res = await fetch(`${AUTH_API}?action=assistant_create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, real_name, password })
            });
            const json = await res.json();
            if (json.success) {
                const createdPwd = json.data?.password || password;
                lastCreatedAssistantData = {
                    username,
                    real_name,
                    password: createdPwd,
                    initial_password: createdPwd
                };

                window.toggleAddAssistantForm(false);

                // 展示刚创建助教的专属信息卡片
                const successBox = document.getElementById('assistant-created-box');
                const nameEl = document.getElementById('created-ta-name');
                const uEl = document.getElementById('created-ta-username');
                const pEl = document.getElementById('created-ta-password');
                const urlEl = document.getElementById('created-ta-url');
                if (successBox && nameEl && uEl && pEl) {
                    nameEl.textContent = real_name;
                    uEl.textContent = username;
                    pEl.textContent = createdPwd;
                    if (urlEl) {
                        const isPreviewOrTest = /feedback(backup|test)\.wxjifang\.cn$/.test(window.location.hostname);
                        urlEl.textContent = isPreviewOrTest
                            ? `${window.location.origin}/index.html`
                            : (window.location.origin.includes('wxjifang.cn')
                                ? 'https://feedback.wxjifang.cn/index.html'
                                : `${window.location.origin}/index.html`);
                    }
                    successBox.style.display = 'block';
                }

                // 自动一键写入剪贴板，极大方便老师直接粘贴给助教
                try {
                    await copyTextToClipboard(formatAssistantShareText(lastCreatedAssistantData));
                    if (typeof showToast === 'function') {
                        showToast('助教账号创建成功，账号密码已复制', 'success');
                    }
                } catch (_) {
                    if (typeof showToast === 'function') {
                        showToast(json.data?.message || '助教账号创建成功', 'success');
                    }
                }

                window.loadAssistantList();
            } else {
                if (errEl) { errEl.textContent = json.error || '创建失败'; errEl.style.display = 'flex'; }
            }
        } catch (err) {
            if (errEl) { errEl.textContent = '网络异常，创建助教失败'; errEl.style.display = 'flex'; }
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '确认添加'; }
        }
    };

    // 提交更新助教
    window.handleAssistantUpdate = async function (e) {
        if (e) e.preventDefault();
        const idInput = document.getElementById('ta-edit-id');
        const rInput = document.getElementById('ta-edit-realname');
        const pInput = document.getElementById('ta-edit-password');
        const sSelect = document.getElementById('ta-edit-status');
        const errEl = document.getElementById('ta-edit-error');
        const btn = document.getElementById('ta-edit-submit-btn');

        const id = idInput ? parseInt(idInput.value) : 0;
        const real_name = rInput ? rInput.value.trim() : '';
        const password = pInput ? pInput.value.trim() : '';
        const status = sSelect ? parseInt(sSelect.value) : 1;

        if (!id) return;
        if (!real_name) {
            if (errEl) { errEl.textContent = '助教姓名不能为空'; errEl.style.display = 'flex'; }
            return;
        }

        const payload = { id, real_name, status };
        if (password) payload.password = password;

        if (errEl) errEl.style.display = 'none';
        if (btn) { btn.disabled = true; btn.textContent = '保存中...'; }

        try {
            const res = await fetch(`${AUTH_API}?action=assistant_update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const json = await res.json();
            if (json.success) {
                if (typeof showToast === 'function') showToast(json.data?.message || '助教信息更新成功', 'success');
                window.toggleEditAssistantForm(false);
                window.loadAssistantList();
            } else {
                if (errEl) { errEl.textContent = json.error || '更新失败'; errEl.style.display = 'flex'; }
            }
        } catch (err) {
            if (errEl) { errEl.textContent = '网络异常，更新失败'; errEl.style.display = 'flex'; }
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '保存更改'; }
        }
    };

    // 删除助教账号
    window.handleAssistantDelete = async function (id, username) {
        if (!confirm(`确定要彻底删除助教账号 [${username}] 吗？\n删除后该助教将无法再登录。`)) return;
        try {
            const res = await fetch(`${AUTH_API}?action=assistant_delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            });
            const json = await res.json();
            if (json.success) {
                if (typeof showToast === 'function') showToast(json.data?.message || '助教账号已删除', 'success');
                window.loadAssistantList();
            } else {
                if (typeof showToast === 'function') showToast(json.error || '删除助教失败', 'error');
                else alert(json.error || '删除助教失败');
            }
        } catch (e) {
            if (typeof showToast === 'function') showToast('网络异常，删除助教失败', 'error');
            else alert('网络异常，删除助教失败');
        }
    };

    // 校验登录状态
    async function checkAuth() {
        try {
            const res = await fetch(`${AUTH_API}?action=check`);
            const json = await res.json();
            if (json.success && json.data && json.data.loggedIn) {
                currentUser = json.data.user;
                window.currentUser = currentUser;
                hideAuthModal();
                renderNavUser(currentUser);
                window.dispatchEvent(new CustomEvent('authChecked', { detail: currentUser }));
                return true;
            } else {
                currentUser = null;
                window.currentUser = null;
                // 未登录用户如果在受保护页面 (upload.html / question-bank.html / viewer.html) 则直接重定向至首页登录
                const isProtectedPage = /upload(\.html)?$|question-bank(\.html)?$|viewer(\.html)?$/.test(window.location.pathname);
                if (isProtectedPage) {
                    window.location.replace('index.html');
                    return false;
                }
                window.switchAuthMode('login');
                showAuthModal();
                window.dispatchEvent(new CustomEvent('authChecked', { detail: null }));
                return false;
            }
        } catch (e) {
            console.warn('Auth check failed', e);
            const isProtectedPage = /upload(\.html)?$|question-bank(\.html)?$|viewer(\.html)?$/.test(window.location.pathname);
            if (isProtectedPage) {
                window.location.replace('index.html');
                return false;
            }
            showAuthModal();
            return false;
        }
    }

    // 处理登录表单提交
    window.handleFrontLogin = async function (e) {
        if (e) e.preventDefault();
        const usernameInput = document.getElementById('front-auth-username');
        const passwordInput = document.getElementById('front-auth-password');
        const errorEl = document.getElementById('front-auth-error');
        const submitBtn = document.getElementById('front-auth-submit-btn');

        const username = usernameInput ? usernameInput.value.trim() : '';
        const password = passwordInput ? passwordInput.value.trim() : '';

        if (!username || !password) {
            if (errorEl) {
                errorEl.textContent = '请输入账号和密码';
                errorEl.style.display = 'flex';
            }
            return;
        }

        if (errorEl) errorEl.style.display = 'none';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<span>登录中...</span>';
        }

        try {
            const reqFn = typeof requestWithTimeout === 'function' ? requestWithTimeout : fetch;
            const res = await reqFn(`${AUTH_API}?action=login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            }, 8000);
            const json = await res.json();

            if (json.success && json.data) {
                currentUser = json.data;
                window.currentUser = currentUser;
                hideAuthModal();
                renderNavUser(currentUser);
                window.dispatchEvent(new CustomEvent('authChecked', { detail: currentUser }));
                if (typeof showToast === 'function') {
                    showToast(`已登录，${currentUser.real_name || currentUser.username}`, 'success');
                }
            } else {
                if (errorEl) {
                    errorEl.textContent = json.error || '账号或密码错误，请重试';
                    errorEl.style.display = 'flex';
                }
            }
        } catch (err) {
            if (errorEl) {
                if (err.code === 'NETWORK_OFFLINE') {
                    errorEl.textContent = '当前设备处于离线状态，请检查本地网络连接';
                } else if (err.code === 'TIMEOUT') {
                    errorEl.textContent = '登录请求超时，当前网络信号较弱，请重试';
                } else if (err.code === 'NETWORK_ERROR' || (typeof navigator !== 'undefined' && !navigator.onLine)) {
                    errorEl.textContent = '网络连接失败，请检查您的 Wi-Fi 或本地网络';
                } else {
                    errorEl.textContent = err.message || '网络通信异常，请检查网络设置';
                }
                errorEl.style.display = 'flex';
            }
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = `<span>立即登录</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
            }
        }
    };

    // 处理重置/修改密码表单提交
    window.handleFrontResetPassword = async function (e) {
        if (e) e.preventDefault();
        const usernameInput = document.getElementById('front-reset-username');
        const oldPasswordInput = document.getElementById('front-reset-old-password');
        const newPasswordInput = document.getElementById('front-reset-new-password');
        const confirmPasswordInput = document.getElementById('front-reset-confirm-password');
        const errorEl = document.getElementById('front-reset-error');
        const submitBtn = document.getElementById('front-reset-submit-btn');

        const username = usernameInput ? usernameInput.value.trim() : '';
        const old_password = oldPasswordInput ? oldPasswordInput.value.trim() : '';
        const new_password = newPasswordInput ? newPasswordInput.value.trim() : '';
        const confirm_password = confirmPasswordInput ? confirmPasswordInput.value.trim() : '';

        // 再次严格校验测试账号
        if (username === '0') {
            if (errorEl) {
                errorEl.textContent = '测试账号为公共体验账号，不支持重置密码';
                errorEl.style.display = 'flex';
            }
            return;
        }

        if (!username || !old_password || !new_password || !confirm_password) {
            if (errorEl) {
                errorEl.textContent = '请完整填写所有密码项';
                errorEl.style.display = 'flex';
            }
            return;
        }

        if (new_password.length < 6) {
            if (errorEl) {
                errorEl.textContent = '新密码长度至少为 6 位';
                errorEl.style.display = 'flex';
            }
            return;
        }

        if (new_password !== confirm_password) {
            if (errorEl) {
                errorEl.textContent = '两次输入的新密码不一致，请重新核对';
                errorEl.style.display = 'flex';
            }
            return;
        }

        if (errorEl) errorEl.style.display = 'none';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<span>重置中...</span>';
        }

        try {
            const reqFn = typeof requestWithTimeout === 'function' ? requestWithTimeout : fetch;
            const res = await reqFn(`${AUTH_API}?action=reset_password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, old_password, new_password, confirm_password })
            }, 8000);
            const json = await res.json();

            if (json.success) {
                if (oldPasswordInput) oldPasswordInput.value = '';
                if (newPasswordInput) newPasswordInput.value = '';
                if (confirmPasswordInput) confirmPasswordInput.value = '';

                const tipMsg = json.data?.message || '密码修改成功';
                if (typeof showToast === 'function') {
                    showToast(tipMsg, 'success');
                } else if (typeof window.showToast === 'function') {
                    window.showToast(tipMsg, 'success');
                }

                if (currentUser) {
                    hideAuthModal();
                } else {
                    window.switchAuthMode('login');
                    const uInput = document.getElementById('front-auth-username');
                    const pInput = document.getElementById('front-auth-password');
                    if (uInput) uInput.value = username;
                    if (pInput) {
                        pInput.value = '';
                        pInput.focus();
                    }
                }
            } else {
                if (errorEl) {
                    errorEl.textContent = json.error || '重置失败，请检查原密码是否正确';
                    errorEl.style.display = 'flex';
                }
            }
        } catch (err) {
            if (errorEl) {
                if (err.code === 'NETWORK_OFFLINE') {
                    errorEl.textContent = '当前设备处于离线状态，请检查本地网络连接';
                } else if (err.code === 'TIMEOUT') {
                    errorEl.textContent = '密码修改请求超时，网络较弱，请重试';
                } else if (err.code === 'NETWORK_ERROR' || (typeof navigator !== 'undefined' && !navigator.onLine)) {
                    errorEl.textContent = '网络连接失败，请检查您的 Wi-Fi 或本地网络';
                } else {
                    errorEl.textContent = err.message || '网络通信异常，请检查网络设置';
                }
                errorEl.style.display = 'flex';
            }
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = `<span>确认修改密码</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
            }
        }
    };

    // 处理退出登录
    window.handleFrontLogout = async function () {
        if (!confirm('确定要退出当前账号吗？')) return;
        try {
            await fetch(`${AUTH_API}?action=logout`, { method: 'POST' });
        } catch (e) {}

        currentUser = null;
        window.currentUser = null;
        window.location.replace('index.html');
    };

    // 暴露全局
    window.checkFrontAuth = checkAuth;

    // 页面加载自动执行
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            ensureModalDOMElements();
            checkAuth();
        });
    } else {
        ensureModalDOMElements();
        checkAuth();
    }
})();
