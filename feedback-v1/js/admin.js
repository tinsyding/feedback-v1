/**
 * ============================================================================
 * 极方管理后台 (Admin Console) 前端运行脚本 - 生产环境合并包
 * 自动生成时间: 2026-11-23 16:56:31
 * 源码模块目录: js/admin/
 * 请勿直接手动修改此文件，开发时请修改 js/admin/ 中的子模块并执行本打包脚本。
 * ============================================================================
 */



/* ============================================================================
 * [MODULE] ui.js - UI 核心组件与交互 (Toast, Modal, Dock, Theme, TableZoom)
 * ============================================================================ */


/**
 * Admin UI 组件模块 (Toast, ConfirmModal, Dock, Theme, TableZoom, ModalBackdrop)
 */

        const API_BASE = 'api/admin.php';

        /* ========================================================
           Floating Batch Action Dock Controller
           ======================================================== */
        function updateBatchDock() {
            const dock = document.getElementById('floating-batch-dock');
            const countEl = document.getElementById('dock-selected-count');
            if (!dock || !countEl) return;

            let count = 0;
            if (activeTab === 'records') {
                count = recSelectedIds.size;
            } else if (activeTab === 'database') {
                count = dbSelectedIds.size;
            }

            countEl.textContent = count;
            if (count > 0) {
                dock.classList.add('visible');
            } else {
                dock.classList.remove('visible');
            }
        }

        function triggerDockBatchDelete() {
            if (activeTab === 'records') {
                batchDeleteRecords();
            } else if (activeTab === 'database') {
                batchDeleteDbRecords();
            }
        }

        function clearAllSelections() {
            if (activeTab === 'records') {
                recSelectedIds.clear();
                const selAll = document.getElementById('rec-select-all');
                if (selAll) selAll.checked = false;
                document.querySelectorAll('.rec-row-cb').forEach(cb => cb.checked = false);
                const selCount = document.getElementById('rec-selected-count');
                if (selCount) selCount.textContent = '0';
                const delBtn = document.getElementById('rec-batch-delete-btn');
                if (delBtn) delBtn.style.display = 'none';
            } else if (activeTab === 'database') {
                dbSelectedIds.clear();
                const selAll = document.getElementById('db-select-all');
                if (selAll) selAll.checked = false;
                document.querySelectorAll('.db-row-cb').forEach(cb => cb.checked = false);
                const selCount = document.getElementById('db-selected-count');
                if (selCount) selCount.textContent = '0';
                const delBtn = document.getElementById('db-batch-delete-btn');
                if (delBtn) delBtn.style.display = 'none';
            }
            updateBatchDock();
        }

        const LOG_API = 'api/logs.php';
        const CHANGELOG_API = 'api/changelog.php';

        /* ========================================================
           Modern In-App Toast Notification System
           ======================================================== */
        function showToast(message, type = 'info', duration = 2800) {
            if (!message) return;
            let container = document.getElementById('toast-container');
            if (!container) {
                container = document.createElement('div');
                container.id = 'toast-container';
                container.className = 'toast-container';
                container.setAttribute('popover', 'manual');
                document.body.appendChild(container);
            }
            if (window.DialogHelper && typeof window.DialogHelper.promoteToast === 'function') {
                window.DialogHelper.promoteToast(container);
            }

            while (container.children.length >= 4) {
                container.firstElementChild.remove();
            }

            const normType = (type === 'warn' || type === 'warning') ? 'warning'
                : (type === 'error' ? 'error'
                : (type === 'success' ? 'success' : 'info'));

            const icons = {
                success: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>',
                error: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>',
                warning: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
                info: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>'
            };

            const toast = document.createElement('div');
            toast.className = `toast-item ${normType}`;
            const safeText = typeof escapeHtml === 'function' ? escapeHtml(String(message)) : String(message);
            toast.innerHTML = `${icons[normType] || icons.info}<div class="toast-content">${safeText}</div>`;

            container.appendChild(toast);

            requestAnimationFrame(() => {
                toast.classList.add('show');
            });

            let dismissTimer = null;
            const dismiss = () => {
                if (!toast.parentNode) return;
                if (dismissTimer) clearTimeout(dismissTimer);
                toast.classList.remove('show');
                setTimeout(() => {
                    if (toast.parentNode) toast.remove();
                }, 200);
            };

            toast.addEventListener('click', dismiss);
            dismissTimer = setTimeout(dismiss, duration);
        }

        /* ========================================================
           Custom Confirm Modal (Promise-based)
           ======================================================== */
        let confirmResolver = null;

        function showConfirm(title, message, isDanger = false) {
            return new Promise((resolve) => {
                confirmResolver = resolve;
                const modal = document.getElementById('confirm-modal');
                const titleEl = document.getElementById('confirm-modal-title');
                const bodyEl = document.getElementById('confirm-modal-body');
                const okBtn = document.getElementById('confirm-modal-ok-btn');

                if (titleEl) titleEl.textContent = title || '确认操作';
                if (bodyEl) bodyEl.textContent = message || '确认执行此操作吗？';
                if (okBtn) {
                    okBtn.className = isDanger ? 'btn danger-subtle' : 'btn primary';
                    okBtn.style.background = isDanger ? '#ef4444' : '';
                    okBtn.style.color = '#fff';
                }

                if (modal) {
                    if (window.DialogHelper) {
                        window.DialogHelper.open(modal, {
                            dismissible: true,
                            onCancel: () => {
                                if (confirmResolver) {
                                    confirmResolver(false);
                                    confirmResolver = null;
                                }
                            }
                        });
                    } else {
                        modal.style.display = 'flex';
                    }
                }
            });
        }

        function resolveConfirm(result) {
            const modal = document.getElementById('confirm-modal');
            if (modal) {
                if (window.DialogHelper) {
                    window.DialogHelper.close(modal);
                } else {
                    modal.style.display = 'none';
                }
            }
            if (confirmResolver) {
                confirmResolver(result);
                confirmResolver = null;
            }
        }


        /* ========================================================
           Utility Helpers
           ======================================================== */
        function formatScore(val) {
            if (val === null || val === undefined || val === '') return '-';
            const num = Number(val);
            if (isNaN(num)) return String(val);
            return parseFloat(num.toFixed(2)).toString();
        }

        function formatTimestamp(ts, omitYear = false) {
            if (!ts) return '-';
            if (typeof ts === 'string') {
                const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}:\d{2})(?::\d{2})?/);
                if (m) {
                    return omitYear ? `${m[2]}-${m[3]} ${m[4]}` : `${m[1]}-${m[2]}-${m[3]} ${m[4]}`;
                }
            }
            const d = new Date(ts);
            if (isNaN(d.getTime())) return String(ts);
            const pad = n => String(n).padStart(2, '0');
            const month = pad(d.getMonth() + 1);
            const day = pad(d.getDate());
            const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
            if (omitYear) return `${month}-${day} ${time}`;
            return `${d.getFullYear()}-${month}-${day} ${time}`;
        }

        function escapeHtml(str) {
            return String(str ?? '').replace(/[&<>'"]/g, tag => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                "'": '&#39;',
                '"': '&quot;'
            }[tag] || tag));
        }

        function escapeInlineJs(str) {
            return escapeHtml(
                String(str ?? '')
                    .replace(/\\/g, '\\\\')
                    .replace(/'/g, "\\'")
                    .replace(/"/g, '\\"')
                    .replace(/\r/g, '\\r')
                    .replace(/\n/g, '\\n')
                    .replace(/\u2028/g, '\\u2028')
                    .replace(/\u2029/g, '\\u2029')
            );
        }

        /* ========================================================
           责任教师单元格：助教创建时追加所属教师账号
           后端 db_list 已附带 creator_role / creator_owner_username / creator_owner_name
           ======================================================== */
        function getCreatorOwnerInfo(r) {
            if (!r) return null;
            const ownerU = r.creator_owner_username || '';
            if (!ownerU) return null;
            // 仅助教需要展示归属；若后端未给 role 但给了 owner，也展示以免漏标
            if (r.creator_role && r.creator_role !== 'assistant') return null;
            return {
                username: ownerU,
                name: r.creator_owner_name || ownerU
            };
        }

        function renderCreatorCell(r, compact) {
            if (!r || !r.created_by) return '<span style="color:var(--text-muted); font-size:0.75rem;">-</span>';
            const displayName = r.creator_name || r.created_by;
            const owner = getCreatorOwnerInfo(r);
            const badge = (r.creator_role === 'assistant')
                ? '<span style="font-size:0.68rem; padding:0 5px; margin-left:4px; border-radius:4px; background:rgba(245,158,11,0.14); color:#f59e0b; border:1px solid rgba(245,158,11,0.35); font-weight:700; vertical-align:1px;">助教</span>'
                : '';
            const ownerLine = owner
                ? `<div style="font-size:0.7rem; color:var(--text-muted); font-weight:400; margin-top:2px; white-space:nowrap;" title="所属教师账号：${escapeHtml(owner.username)}">所属：${escapeHtml(owner.name)} (${escapeHtml(owner.username)})</div>`
                : '';
            const title = owner
                ? `助教 ${r.created_by}（${displayName}），所属教师：${owner.name}（${owner.username}）`
                : `${displayName}（${r.created_by}）`;
            if (compact) {
                return `<span style="font-weight:600; color:var(--text-primary); font-size:0.85rem;" title="${escapeHtml(title)}">${escapeHtml(displayName)}${badge}</span>${ownerLine}`;
            }
            return `
                <span style="font-size:0.78rem; font-weight:600; color:var(--text-primary); background:rgba(59,130,246,0.12); border:1px solid rgba(59,130,246,0.25); border-radius:4px; padding:2px 6px; display:inline-flex; align-items:center; gap:4px; white-space:nowrap;" title="${escapeHtml(title)}">
                    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
                    ${escapeHtml(displayName)}${badge}
                </span>${ownerLine}`;
        }

        /* ========================================================
           Modal Backdrop & Keyboard Interaction Listeners
           ======================================================== */
        document.addEventListener('click', (e) => {
            if (e.target && e.target.classList && e.target.classList.contains('modal-overlay') && e.target.tagName !== 'DIALOG') {
                if (e.target.id === 'confirm-modal') {
                    resolveConfirm(false);
                } else if (e.target.id === 'db-record-modal') {
                    closeDbRecordModal();
                } else if (e.target.id === 'db-detail-modal') {
                    closeDbDetailModal();
                } else if (e.target.id === 'changelog-modal') {
                    closeChangelogModal();
                } else {
                    e.target.remove();
                }
            }
        });

        window.addEventListener('keydown', (e) => {
            // 全局快捷键 Ctrl+K / Cmd+K 快速唤出 Token 查学生
            if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
                e.preventDefault();
                openTokenSearchModal();
                return;
            }

            if (e.key === 'Escape' && !window.DialogHelper) {
                const openModals = Array.from(document.querySelectorAll('.modal-overlay')).filter(m => m.tagName !== 'DIALOG' && m.style.display !== 'none' && m.style.display !== '');
                if (openModals.length > 0) {
                    const topModal = openModals[openModals.length - 1];
                    if (topModal.id === 'confirm-modal') {
                        resolveConfirm(false);
                    } else if (topModal.id === 'db-record-modal') {
                        closeDbRecordModal();
                    } else if (topModal.id === 'db-detail-modal') {
                        closeDbDetailModal();
                    } else if (topModal.id === 'changelog-modal') {
                        closeChangelogModal();
                    } else if (topModal.id === 'token-search-modal') {
                        closeTokenSearchModal();
                    } else {
                        topModal.remove();
                    }
                }
            }
        });


                /* ========================================================
           3-State Theme Switcher Logic (Light / Dark / System)
           ======================================================== */
        function syncAdminColorSchemeMeta(mode, effective) {
            const metaColorScheme = document.querySelector('meta[name="color-scheme"]');
            if (metaColorScheme) {
                metaColorScheme.setAttribute('content', (mode === 'light' || mode === 'dark') ? mode : 'light dark');
            }
            const metaThemeColor = document.querySelector('meta[name="theme-color"]');
            if (metaThemeColor && effective) {
                metaThemeColor.setAttribute('content', effective === 'light' ? '#fafafa' : '#141415');
            }
        }

        function initTheme() {
            if (window.ThemeManager) {
                window.ThemeManager.syncUI();
                return;
            }
            const saved = localStorage.getItem('admin_theme');
            const effective = (saved === 'light' || saved === 'dark')
                ? saved
                : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
            document.documentElement.setAttribute('data-theme', effective);
            syncAdminColorSchemeMeta(saved || 'system', effective);
            updateThemeButtonText(saved || 'system');
        }

        function toggleTheme() {
            if (window.ThemeManager) {
                window.ThemeManager.cycleMode();
                return;
            }
            const current = document.documentElement.getAttribute('data-theme') || 'light';
            const next = current === 'light' ? 'dark' : 'light';
            document.documentElement.setAttribute('data-theme', next);
            localStorage.setItem('admin_theme', next);
            syncAdminColorSchemeMeta(next, next);
            updateThemeButtonText(next);
        }

        function updateThemeButtonText(mode) {
            const textEl = document.getElementById('theme-toggle-text');
            if (textEl) {
                const labels = { system: '跟随系统', light: '浅色模式', dark: '深色模式' };
                textEl.textContent = labels[mode] || labels.system;
            }
        }

        /* ========================================================
           Table Wheel Zoom & Scale Controller (滚轮缩放与按键调节)
           ======================================================== */
        let dbTableZoom = parseFloat(localStorage.getItem('jf_db_table_zoom')) || 1.0;
        let recTableZoom = parseFloat(localStorage.getItem('jf_rec_table_zoom')) || 1.0;
        let zoomHudTimeout = null;
        let lastActiveZoomTarget = 'db';

        function showTableZoomHud(text) {
            const hud = document.getElementById('table-zoom-hud');
            if (!hud) return;
            hud.textContent = text;
            hud.classList.add('visible');
            clearTimeout(zoomHudTimeout);
            zoomHudTimeout = setTimeout(() => {
                hud.classList.remove('visible');
            }, 1500);
        }

        function resetActiveTableZoom() {
            if (lastActiveZoomTarget === 'rec') {
                resetRecTableZoom();
            } else {
                resetDbTableZoom();
            }
        }

        function applyDbTableZoom(val, showHud = true) {
            lastActiveZoomTarget = 'db';
            dbTableZoom = Math.max(0.5, Math.min(1.8, Math.round(val * 100) / 100));
            localStorage.setItem('jf_db_table_zoom', dbTableZoom);

            const tableEl = document.getElementById('db-data-table');
            const cardsEl = document.getElementById('db-cards-wrapper');
            const pill = document.getElementById('db-zoom-value-pill');
            const pct = Math.round(dbTableZoom * 100);

            if (tableEl) tableEl.style.zoom = dbTableZoom;
            if (cardsEl) cardsEl.style.zoom = dbTableZoom;
            if (pill) pill.textContent = `${pct}%`;

            if (showHud) {
                showTableZoomHud(`数据库表格缩放: ${pct}% (点击恢复 100%)`);
            }
        }

        function changeDbTableZoom(delta) {
            applyDbTableZoom(dbTableZoom + delta, true);
        }

        function resetDbTableZoom() {
            applyDbTableZoom(1.0, true);
        }

        function applyRecTableZoom(val, showHud = true) {
            lastActiveZoomTarget = 'rec';
            recTableZoom = Math.max(0.5, Math.min(1.8, Math.round(val * 100) / 100));
            localStorage.setItem('jf_rec_table_zoom', recTableZoom);

            const tableEl = document.getElementById('rec-data-table');
            const cardsEl = document.getElementById('rec-cards-wrapper');
            const pill = document.getElementById('rec-zoom-value-pill');
            const pct = Math.round(recTableZoom * 100);

            if (tableEl) tableEl.style.zoom = recTableZoom;
            if (cardsEl) cardsEl.style.zoom = recTableZoom;
            if (pill) pill.textContent = `${pct}%`;

            if (showHud) {
                showTableZoomHud(`学情表格缩放: ${pct}% (点击恢复 100%)`);
            }
        }

        function changeRecTableZoom(delta) {
            applyRecTableZoom(recTableZoom + delta, true);
        }

        function resetRecTableZoom() {
            applyRecTableZoom(1.0, true);
        }

        function setupTableWheelZoom() {
            // 为数据库管理页面添加 Ctrl + 滚轮实时缩放支持
            const dbTab = document.getElementById('database-tab');
            if (dbTab) {
                dbTab.addEventListener('wheel', function (e) {
                    if (e.ctrlKey || e.metaKey) {
                        e.preventDefault();
                        const delta = e.deltaY < 0 ? 0.05 : -0.05;
                        changeDbTableZoom(delta);
                    }
                }, { passive: false });
            }

            // 为学情错题数据页面添加 Ctrl + 滚轮实时缩放支持
            const recTab = document.getElementById('records-tab');
            if (recTab) {
                recTab.addEventListener('wheel', function (e) {
                    if (e.ctrlKey || e.metaKey) {
                        e.preventDefault();
                        const delta = e.deltaY < 0 ? 0.05 : -0.05;
                        changeRecTableZoom(delta);
                    }
                }, { passive: false });
            }

            // 初始化加载持久化缩放比例
            applyDbTableZoom(dbTableZoom, false);
            applyRecTableZoom(recTableZoom, false);
        }


/* ============================================================================
 * [MODULE] auth.js - 管理员认证与授权 (checkAuth, logout, changePassword)
 * ============================================================================ */


/**
 * Admin 身份认证模块 (checkAuth, logout, changePassword)
 */

        /* ========================================================
           Authentication & Authorization
           ======================================================== */
        async function redirectNonAdminTarget() {
            try {
                const authRes = await fetch('api/auth.php?action=check');
                const authJson = await authRes.json();
                if (authJson.success && authJson.data?.loggedIn) {
                    window.location.replace('upload.html');
                    return;
                }
            } catch (_) {}
            window.location.replace('index.html');
        }

        async function checkAuth() {
            try {
                const response = await fetch(`${API_BASE}?action=check`);
                const result = await response.json();
                if (!result.success || !result.data?.loggedIn) {
                    await redirectNonAdminTarget();
                    return false;
                }
                const uname = result.data.username || '管理员';
                document.getElementById('admin-username').textContent = uname;
                document.getElementById('user-avatar-letter').textContent = (uname[0] || 'A').toUpperCase();
                return true;
            } catch (err) {
                await redirectNonAdminTarget();
                return false;
            }
        }

        async function logout() {
            const confirmed = await showConfirm('安全退出', '您确定要退出当前管理员账号并返回登录界面吗？', false);
            if (!confirmed) return;
            try {
                await fetch(`${API_BASE}?action=logout`, { method: 'POST' });
            } catch (err) {}
            window.location.href = 'index.html';
        }

        function openChangePwdModal() {
            const modal = document.getElementById('change-pwd-modal');
            if (!modal) return;
            const pOld = document.getElementById('pwd-old');
            const pNew = document.getElementById('pwd-new');
            const pConf = document.getElementById('pwd-confirm');
            if (pOld) pOld.value = '';
            if (pNew) pNew.value = '';
            if (pConf) pConf.value = '';
            if (window.DialogHelper) {
                window.DialogHelper.open(modal, { dismissible: true });
            } else {
                modal.style.display = 'flex';
            }
        }

        function closeChangePwdModal() {
            const modal = document.getElementById('change-pwd-modal');
            if (modal) {
                if (window.DialogHelper) {
                    window.DialogHelper.close(modal);
                } else {
                    modal.style.display = 'none';
                }
            }
        }

        async function submitChangePwd() {
            const oldPassword = document.getElementById('pwd-old')?.value;
            const newPassword = document.getElementById('pwd-new')?.value;
            const confirmPassword = document.getElementById('pwd-confirm')?.value;
            const saveBtn = document.getElementById('btn-save-pwd');

            if (!oldPassword) {
                showToast('请输入当前原密码', 'warn');
                return;
            }
            if (!newPassword || newPassword.length < 6) {
                showToast('新密码长度不能少于 6 位', 'warn');
                return;
            }
            if (newPassword !== confirmPassword) {
                showToast('两次输入的新密码不一致', 'warn');
                return;
            }

            try {
                if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '正在保存...'; }
                const res = await fetch(`${API_BASE}?action=change_password`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        old_password: oldPassword,
                        new_password: newPassword
                    })
                });
                const json = await res.json();
                if (json.success) {
                    closeChangePwdModal();
                    showToast('密码修改成功，请妥善保管', 'success');
                } else {
                    showToast(json.error || '修改密码失败', 'error');
                }
            } catch (e) {
                showToast('网络请求失败', 'error');
            } finally {
                if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存新密码'; }
            }
        }


/* ============================================================================
 * [MODULE] config.js - Tab 1: 系统与学期配置 (loadConfig, saveConfig)
 * ============================================================================ */


/**
 * Admin 系统全局配置模块 (Tab 1: loadConfig, saveConfig, setSeason)
 */

        /* ========================================================
           TAB 1: System Config Logic
           ======================================================== */
        let currentConfig = {};
        let currentSeason = 'autumn';

        const SEASON_CONFIG = {
            spring: { label: '春', shortLabel: '春', text: '春', unit: '周', defaultWeeks: 18, isVacation: false },
            summer: { label: '暑', shortLabel: '暑', text: '暑', unit: '讲', defaultWeeks: 12, isVacation: true },
            autumn: { label: '秋', shortLabel: '秋', text: '秋', unit: '周', defaultWeeks: 18, isVacation: false },
            winter: { label: '寒', shortLabel: '寒', text: '寒', unit: '讲', defaultWeeks: 8, isVacation: true }
        };

        function normalizeSeason(val) {
            if (val === 'spring' || val === '春' || val === 1) return 'spring';
            if (val === 'summer' || val === '暑') return 'summer';
            if (val === 'autumn' || val === '秋') return 'autumn';
            if (val === 'winter' || val === '寒' || val === 0) return 'winter';
            return 'autumn';
        }

        async function loadConfig() {
            try {
                const response = await fetch(`${API_BASE}?action=config`);
                const result = await response.json();
                if (result.success) {
                    currentConfig = result.data;
                    updateConfigUI();
                }
            } catch (err) {
                console.error('加载配置失败:', err);
            }
        }

        function updateRetestQrToggleLabel(enabled) {
            const badge = document.getElementById('retest-qrcode-status-badge');
            if (badge) {
                if (enabled) {
                    badge.textContent = '开启状态';
                    badge.style.background = 'rgba(16, 185, 129, 0.15)';
                    badge.style.color = '#10b981';
                    badge.style.borderColor = 'rgba(16, 185, 129, 0.3)';
                } else {
                    badge.textContent = '已关闭';
                    badge.style.background = 'rgba(239, 68, 68, 0.12)';
                    badge.style.color = '#ef4444';
                    badge.style.borderColor = 'rgba(239, 68, 68, 0.25)';
                }
            }
        }

        async function onRetestQrToggleChange() {
            const qrToggle = document.getElementById('retest-qrcode-toggle');
            const isChecked = qrToggle ? qrToggle.checked : true;
            updateRetestQrToggleLabel(isChecked);
            const msg = isChecked
                ? '已成功开启题目视频讲解二维码（下载 PDF 将附带二维码）'
                : '已成功关闭题目视频讲解二维码（下载 PDF 将无二维码）';
            await saveConfig(true, msg);
        }

        function updateSenderServiceBadge(enabled) {
            const badge = document.getElementById('sc-service-badge');
            if (!badge) return;
            if (enabled) {
                badge.textContent = '服务开放';
                badge.style.background = 'rgba(16, 185, 129, 0.15)';
                badge.style.color = '#10b981';
                badge.style.borderColor = 'rgba(16, 185, 129, 0.3)';
            } else {
                badge.textContent = '已锁定暂停';
                badge.style.background = 'rgba(239, 68, 68, 0.14)';
                badge.style.color = '#ef4444';
                badge.style.borderColor = 'rgba(239, 68, 68, 0.3)';
            }
        }

        function setStageBadgeState(badgeId, enabled, onText, offText, offAmber = true) {
            const badge = document.getElementById(badgeId);
            if (!badge) return;
            if (enabled) {
                badge.textContent = onText;
                badge.style.background = 'rgba(16, 185, 129, 0.15)';
                badge.style.color = '#10b981';
                badge.style.borderColor = 'rgba(16, 185, 129, 0.3)';
            } else {
                badge.textContent = offText;
                badge.style.background = offAmber ? 'rgba(245, 158, 11, 0.15)' : 'rgba(239, 68, 68, 0.14)';
                badge.style.color = offAmber ? '#f59e0b' : '#ef4444';
                badge.style.borderColor = offAmber ? 'rgba(245, 158, 11, 0.3)' : 'rgba(239, 68, 68, 0.3)';
            }
        }

        function updateAllStageBadges() {
            const calOn = document.getElementById('sc-enable-calibration')?.checked !== false;
            setStageBadgeState('stage1-cal-badge', calOn, 'AI 校准开启', '已禁用 · 仅手动框选');
            const calInput = document.getElementById('ai-calibration-model');
            if (calInput) calInput.style.opacity = calOn ? '1' : '0.5';

            const vm = document.getElementById('sc-verify-mode')?.value || 'auto';
            const titleText = vm === 'local'
                ? '已禁用 · 纯本地OCR'
                : (vm === 'api' ? '纯云端模型' : '本地优先 + 模型兜底');
            setStageBadgeState('stage2-title-badge', vm !== 'local', titleText, '已禁用 · 纯本地OCR');
            const fastInput = document.getElementById('ai-fast-model');
            if (fastInput) fastInput.style.opacity = vm !== 'local' ? '1' : '0.5';

            const replyOn = document.getElementById('sc-enable-reply')?.checked !== false;
            setStageBadgeState('stage3-reply-badge', replyOn, 'AI 分析开启', '已关闭 · 0 Token');
            const maxInput = document.getElementById('ai-model');
            if (maxInput) maxInput.style.opacity = replyOn ? '1' : '0.5';

            const bmOn = document.getElementById('sc-enable-benchmark')?.checked !== false;
            setStageBadgeState('stage4-bm-badge', bmOn, '评测大模型开启', '已禁用 · 仅测本地OCR');
            const bmInput = document.getElementById('ai-benchmark-model');
            if (bmInput) bmInput.style.opacity = bmOn ? '1' : '0.5';
        }

        function onSenderStageToggleChange() {
            updateAllStageBadges();
        }

        function onSenderServiceToggleChange() {
            const svcToggle = document.getElementById('sc-service-enabled');
            updateSenderServiceBadge(svcToggle ? svcToggle.checked : true);
        }

        function updateConfigUI() {
            currentSeason = normalizeSeason(currentConfig.defaultSeason ?? 'autumn');
            const year = parseInt(currentConfig.semesterYear) || 2026;
            const weeks = parseInt(currentConfig.semesterWeeks) || (SEASON_CONFIG[currentSeason]?.defaultWeeks || 14);

            const yearInput = document.getElementById('semester-year');
            if (yearInput) yearInput.value = year;

            const weeksInput = document.getElementById('semester-weeks');
            if (weeksInput) weeksInput.value = weeks;

            // 二维码讲解开关
            const qrEnabled = currentConfig.retestQrCodeEnabled !== false;
            const qrToggle = document.getElementById('retest-qrcode-toggle');
            if (qrToggle) {
                qrToggle.checked = qrEnabled;
                updateRetestQrToggleLabel(qrEnabled);
            }

            // 发送器全局云控 & 四环节模型开关回显
            const sc = currentConfig.senderControl || {};
            const verifyMode = sc.verifyMode || (currentConfig.disableQwenFlashTitle ? 'local' : 'auto');
            const scVerBadge = document.getElementById('sc-version-badge');
            if (scVerBadge) scVerBadge.textContent = `v${sc.policyVersion || 1}${sc.updatedAt ? ' · ' + sc.updatedAt.split(' ')[1] : ''}`;
            const svcEnabled = sc.senderServiceEnabled !== false;
            const svcEl = document.getElementById('sc-service-enabled');
            if (svcEl) svcEl.checked = svcEnabled;
            updateSenderServiceBadge(svcEnabled);

            const calEl = document.getElementById('sc-enable-calibration');
            if (calEl) calEl.checked = sc.enableAutoCalibration !== false;
            const vmEl = document.getElementById('sc-verify-mode');
            if (vmEl) vmEl.value = verifyMode;
            const replyEl = document.getElementById('sc-enable-reply');
            if (replyEl) replyEl.checked = sc.enableReplyAnalysis !== false;
            const bmEl = document.getElementById('sc-enable-benchmark');
            if (bmEl) bmEl.checked = sc.enableBenchmarkModel !== false;
            const spEl = document.getElementById('sc-snapshot-policy');
            if (spEl) spEl.value = sc.snapshotPolicy || 'errors_only';
            const minVerEl = document.getElementById('sc-min-version');
            if (minVerEl) minVerEl.value = sc.minSenderVersion || '';
            const minActEl = document.getElementById('sc-min-version-action');
            if (minActEl) minActEl.value = sc.minVersionAction || 'block';
            const upUrlEl = document.getElementById('sc-update-url');
            if (upUrlEl) upUrlEl.value = sc.updateUrl || '';
            const noticeEl = document.getElementById('sc-notice-message');
            if (noticeEl) noticeEl.value = sc.noticeMessage || '';

            const setNumVal = (id, val, fallback) => {
                const el = document.getElementById(id);
                if (el) el.value = (val !== undefined && val !== null && val !== '') ? val : fallback;
            };
            setNumVal('sc-search-wait', sc.searchWait, 1.5);
            setNumVal('sc-enter-wait', sc.enterWait, 1.2);
            setNumVal('sc-gap-min', sc.studentGapMin, 0.5);
            setNumVal('sc-gap-max', sc.studentGapMax, 1.0);
            setNumVal('sc-break-every', sc.batchBreakEvery, 15);
            setNumVal('sc-break-min', sc.batchBreakMin, 2.0);
            setNumVal('sc-break-max', sc.batchBreakMax, 3.0);

            // 大模型配置回显
            const apiKeyInput = document.getElementById('ai-api-key');
            if (apiKeyInput) apiKeyInput.value = currentConfig.dashscopeApiKey || '';

            const apiBaseInput = document.getElementById('ai-api-base');
            if (apiBaseInput) apiBaseInput.value = currentConfig.identifyApiBase || '';

            const calModelInput = document.getElementById('ai-calibration-model');
            if (calModelInput) calModelInput.value = currentConfig.calibrateModel || currentConfig.identifyModel || 'qwen3.8-max';

            const fastModelInput = document.getElementById('ai-fast-model');
            if (fastModelInput) fastModelInput.value = currentConfig.identifyFastModel || 'qwen3.8-flash';

            const modelInput = document.getElementById('ai-model');
            if (modelInput) modelInput.value = currentConfig.identifyModel || 'qwen3.8-max';

            const bmModelInput = document.getElementById('ai-benchmark-model');
            if (bmModelInput) bmModelInput.value = currentConfig.benchmarkModel || currentConfig.identifyFastModel || 'qwen3.8-flash';

            updateAllStageBadges();

            ['spring', 'summer', 'autumn', 'winter'].forEach(s => {
                const card = document.getElementById(`season-${s}`);
                if (card) card.classList.toggle('active', currentSeason === s);
            });

            updateOverviewText();
        }

        function setSeason(seasonKey) {
            currentSeason = normalizeSeason(seasonKey);
            const meta = SEASON_CONFIG[currentSeason] || SEASON_CONFIG.spring;
            ['spring', 'summer', 'autumn', 'winter'].forEach(s => {
                const card = document.getElementById(`season-${s}`);
                if (card) card.classList.toggle('active', currentSeason === s);
            });
            const weeksInput = document.getElementById('semester-weeks');
            if (weeksInput && meta.defaultWeeks) {
                weeksInput.value = meta.defaultWeeks;
            }
            updateOverviewText();
        }

        function updateOverviewText() {
            const meta = SEASON_CONFIG[currentSeason] || SEASON_CONFIG.spring;
            const year = document.getElementById('semester-year')?.value || 2026;
            const weeks = document.getElementById('semester-weeks')?.value || 14;

            // Update Hero Card
            const envText = document.getElementById('info-env-text');
            if (envText) envText.textContent = `${year} 年 · ${meta.label}`;

            const metricYear = document.getElementById('hero-metric-year');
            if (metricYear) metricYear.textContent = `${year} 年`;

            const metricSeason = document.getElementById('hero-metric-season');
            if (metricSeason) metricSeason.textContent = meta.label;

            const metricWeeks = document.getElementById('hero-metric-weeks');
            if (metricWeeks) metricWeeks.textContent = `${weeks} ${meta.unit}`;

            const suffix = document.getElementById('weeks-unit-suffix');
            if (suffix) suffix.textContent = meta.unit;
        }

        async function saveConfig(isSilent = false, customSilentMsg = '') {
            const year = parseInt(document.getElementById('semester-year').value) || 2026;
            const weeks = parseInt(document.getElementById('semester-weeks').value) || 14;
            const qrToggle = document.getElementById('retest-qrcode-toggle');
            const qrEnabled = qrToggle ? qrToggle.checked : true;
            const vmEl = document.getElementById('sc-verify-mode');
            const verifyMode = vmEl ? vmEl.value : 'auto';
            const statusEl = document.getElementById('save-status');

            const readNum = (id, fallback) => {
                const el = document.getElementById(id);
                if (!el) return fallback;
                const v = parseFloat(el.value);
                return Number.isFinite(v) ? v : fallback;
            };

            const config = {
                semesterYear: year,
                defaultSeason: currentSeason,
                semesterWeeks: weeks,
                forceIntegerScores: true,
                retestQrCodeEnabled: qrEnabled,
                disableQwenFlashTitle: verifyMode === 'local',
                senderControl: {
                    senderServiceEnabled: document.getElementById('sc-service-enabled') ? document.getElementById('sc-service-enabled').checked : true,
                    enableAutoCalibration: document.getElementById('sc-enable-calibration') ? document.getElementById('sc-enable-calibration').checked : true,
                    verifyMode: verifyMode,
                    enableReplyAnalysis: document.getElementById('sc-enable-reply') ? document.getElementById('sc-enable-reply').checked : true,
                    enableBenchmarkModel: document.getElementById('sc-enable-benchmark') ? document.getElementById('sc-enable-benchmark').checked : true,
                    snapshotPolicy: document.getElementById('sc-snapshot-policy')?.value || 'errors_only',
                    minSenderVersion: (document.getElementById('sc-min-version')?.value || '').trim(),
                    minVersionAction: document.getElementById('sc-min-version-action')?.value || 'block',
                    updateUrl: (document.getElementById('sc-update-url')?.value || '').trim(),
                    noticeMessage: (document.getElementById('sc-notice-message')?.value || '').trim(),
                    searchWait: readNum('sc-search-wait', 1.5),
                    enterWait: readNum('sc-enter-wait', 1.2),
                    studentGapMin: readNum('sc-gap-min', 0.5),
                    studentGapMax: readNum('sc-gap-max', 1.0),
                    batchBreakEvery: Math.round(readNum('sc-break-every', 15)),
                    batchBreakMin: readNum('sc-break-min', 2.0),
                    batchBreakMax: readNum('sc-break-max', 3.0)
                }
            };

            const apiKeyInput = document.getElementById('ai-api-key');
            const apiBaseInput = document.getElementById('ai-api-base');
            const calModelInput = document.getElementById('ai-calibration-model');
            const fastModelInput = document.getElementById('ai-fast-model');
            const modelInput = document.getElementById('ai-model');
            const bmModelInput = document.getElementById('ai-benchmark-model');

            if (apiKeyInput) config.dashscopeApiKey = apiKeyInput.value.trim();
            if (apiBaseInput) config.identifyApiBase = apiBaseInput.value.trim();
            if (calModelInput) config.calibrateModel = calModelInput.value.trim();
            if (fastModelInput) config.identifyFastModel = fastModelInput.value.trim();
            if (modelInput) config.identifyModel = modelInput.value.trim();
            if (bmModelInput) config.benchmarkModel = bmModelInput.value.trim();

            if (currentConfig && currentConfig.retestQuestionSpacing) {
                config.retestQuestionSpacing = currentConfig.retestQuestionSpacing;
            }

            if (statusEl) {
                statusEl.innerHTML = '<span class="spinner"></span> 保存中...';
                statusEl.className = 'save-status saving show';
            }

            try {
                const response = await fetch(`${API_BASE}?action=config`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(config)
                });

                const result = await response.json();
                if (result.success) {
                    currentConfig = result.data.config;
                    updateConfigUI();
                    const toastMsg = isSilent
                        ? (customSilentMsg || '系统配置已更新生效')
                        : '系统全局配置已成功保存并实时生效';
                    showToast(toastMsg, 'success');
                    if (statusEl) {
                        statusEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;"><polyline points="20 6 9 17 4 12"></polyline></svg> 保存成功';
                        statusEl.className = 'save-status success show';
                        setTimeout(() => {
                            statusEl.textContent = '';
                            statusEl.className = 'save-status';
                        }, 2000);
                    }
                } else {
                    showToast(result.error || '保存失败', 'error');
                    if (statusEl) {
                        statusEl.textContent = result.error || '保存失败';
                        statusEl.className = 'save-status error show';
                    }
                }
            } catch (err) {
                showToast('网络连接超时或服务器异常', 'error');
                if (statusEl) {
                    statusEl.textContent = '网络错误';
                    statusEl.className = 'save-status error show';
                }
            }
        }

        function toggleApiKeyVisibility() {
            const input = document.getElementById('ai-api-key');
            const eye = document.getElementById('ai-key-eye-icon');
            if (!input) return;
            if (input.type === 'password') {
                input.type = 'text';
                if (eye) {
                    eye.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>';
                }
            } else {
                input.type = 'password';
                if (eye) {
                    eye.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
                }
            }
        }

        async function testAiConnection() {
            const btn = document.getElementById('ai-test-btn');
            const resultBox = document.getElementById('ai-test-result');
            const apiKey = document.getElementById('ai-api-key')?.value.trim() || '';
            const baseUrl = document.getElementById('ai-api-base')?.value.trim() || '';
            const model = document.getElementById('ai-model')?.value.trim() || '';

            if (!apiKey && !(currentConfig && (currentConfig.hasApiKey || currentConfig.dashscopeApiKey))) {
                showToast('请先输入 API Key 再进行连通性测试', 'warning');
                return;
            }

            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<span class="spinner"></span> 正在测试连通性...';
            }
            if (resultBox) {
                resultBox.style.display = 'block';
                resultBox.innerHTML = '<div style="font-size: 0.82rem; color: var(--text-secondary); padding: 8px 12px; background: var(--bg-subtle); border-radius: var(--radius-sm); border: 1px solid var(--border-color);"><span class="spinner"></span> 正在连接 AI 端点测试...</div>';
            }

            try {
                const resp = await fetch(`${API_BASE}?action=test_ai_config`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        api_key: apiKey,
                        base_url: baseUrl,
                        model: model
                    })
                });
                const result = await resp.json();
                if (result.success) {
                    const data = result.data || {};
                    showToast(`API 连通成功，延迟: ${data.duration_ms}ms`, 'success');
                    if (resultBox) {
                        resultBox.innerHTML = `
                            <div style="background: rgba(76, 195, 138, 0.1); border: 1px solid rgba(76, 195, 138, 0.25); border-radius: var(--radius-sm); padding: 10px 14px; font-size: 0.84rem;">
                                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
                                    <span style="font-weight: 500; color: var(--positive, #16a34a);">连通成功 (HTTP ${data.http_code || 200})</span>
                                    <span style="color: var(--positive, #16a34a); font-family: var(--font-mono, monospace);">耗时: ${data.duration_ms} ms</span>
                                </div>
                                <div style="color: var(--text-secondary); font-size: 0.8rem;">
                                    <strong>测试模型:</strong> <code>${escapeHtml(data.model || model || 'qwen3.8-max')}</code>
                                    ${data.reply ? ` | <strong>回复:</strong> ${escapeHtml(data.reply)}` : ''}
                                </div>
                            </div>
                        `;
                    }
                } else {
                    const errDetail = result.data?.error || result.error || '连通失败';
                    const duration = result.data?.duration_ms ? ` (耗时 ${result.data.duration_ms}ms)` : '';
                    showToast('连通失败: ' + errDetail, 'error');
                    if (resultBox) {
                        resultBox.innerHTML = `
                            <div style="background: rgba(229, 72, 77, 0.1); border: 1px solid rgba(229, 72, 77, 0.25); border-radius: var(--radius-sm); padding: 10px 14px; font-size: 0.84rem;">
                                <div style="font-weight: 500; color: var(--negative, #dc2626); margin-bottom: 4px;">连通失败${duration}</div>
                                <div style="color: var(--negative, #dc2626); font-size: 0.8rem; word-break: break-all;">${escapeHtml(errDetail)}</div>
                            </div>
                        `;
                    }
                }
            } catch (err) {
                showToast('请求异常: ' + err.message, 'error');
                if (resultBox) {
                    resultBox.innerHTML = `
                        <div style="background: rgba(229, 72, 77, 0.1); border: 1px solid rgba(229, 72, 77, 0.25); border-radius: var(--radius-sm); padding: 10px 14px; font-size: 0.84rem;">
                            <div style="font-weight: 500; color: var(--negative, #dc2626); margin-bottom: 4px;">网络异常</div>
                            <div style="color: var(--negative, #dc2626); font-size: 0.8rem;">${escapeHtml(err.message)}</div>
                        </div>
                    `;
                }
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = `
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                        </svg>
                        <span>测试 API 连通性</span>
                    `;
                }
            }
        }

        window.onRetestQrToggleChange = onRetestQrToggleChange;
        window.onSenderStageToggleChange = onSenderStageToggleChange;
        window.onSenderServiceToggleChange = onSenderServiceToggleChange;
        window.toggleApiKeyVisibility = toggleApiKeyVisibility;
        window.testAiConnection = testAiConnection;


/* ============================================================================
 * [MODULE] logs.js - Tab 2: 审计日志管理 (loadLogs, filter)
 * ============================================================================ */


/**
 * Admin 审计日志模块 (Tab 2: loadLogs, renderLogs, filter)
 */

        /* ========================================================
           TAB 2: Operation Logs Logic
           ======================================================== */
        let currentLogPage = 1;
        let debounceTimer = null;
        let globalLogsCache = [];

        async function loadFilters() {
            try {
                const response = await fetch(`${LOG_API}?action=filters`);
                const result = await response.json();
                if (result.success) {
                    const moduleSelect = document.getElementById('log-module-filter');
                    if (moduleSelect) {
                        moduleSelect.innerHTML = '<option value="">全部模块</option>' + (result.data.modules || []).map(m => `<option value="${m}">${m}</option>`).join('');
                    }
                    const eventSelect = document.getElementById('log-event-filter');
                    if (eventSelect) {
                        eventSelect.innerHTML = '<option value="">全部事件</option>' + (result.data.events || []).map(e => `<option value="${e}">${e}</option>`).join('');
                    }
                    const dateSelect = document.getElementById('log-date-filter');
                    if (dateSelect) {
                        dateSelect.innerHTML = '<option value="">近7天</option>' + (result.data.dates || []).map(d => `<option value="${d}">${d}</option>`).join('');
                    }
                }
            } catch (err) {
                console.error('加载筛选选项失败:', err);
            }
        }

        function debounceLoadLogs() {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => loadLogs(1), 300);
        }

        async function loadLogs(page = 1) {
            currentLogPage = page;
            const level = document.getElementById('log-level-filter')?.value || '';
            const moduleStr = document.getElementById('log-module-filter')?.value || '';
            const eventStr = document.getElementById('log-event-filter')?.value || '';
            const dateStr = document.getElementById('log-date-filter')?.value || '';
            const searchStr = document.getElementById('log-search-filter')?.value || '';
            const ipStr = document.getElementById('log-ip-filter')?.value || '';
            const fingerprintStr = document.getElementById('log-fingerprint-filter')?.value || '';
            const tbody = document.getElementById('logs-tbody');

            if (!tbody) return;

            tbody.innerHTML = `
                <tr>
                    <td colspan="5" class="table-empty">
                        <div class="empty-state">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"></path>
                                <polyline points="14 2 14 8 20 8"></polyline>
                            </svg>
                            <span>日志数据检索中...</span>
                        </div>
                    </td>
                </tr>
            `;

            try {
                const params = new URLSearchParams({ action: 'list', page, perPage: 20 });
                if (level) params.append('level', level);
                if (moduleStr) params.append('module', moduleStr);
                if (eventStr) params.append('event', eventStr);
                if (dateStr) params.append('date', dateStr);
                if (searchStr) params.append('search', searchStr);
                if (ipStr) params.append('ip', ipStr);
                if (fingerprintStr) params.append('fingerprint', fingerprintStr);

                const response = await fetch(`${LOG_API}?${params}`);
                const result = await response.json();

                if (result.success) {
                    globalLogsCache = result.data.logs || [];
                    renderStats(result.data.stats);
                    renderLogs(globalLogsCache);
                    renderPagination(result.data.pagination);
                } else {
                    tbody.innerHTML = `<tr><td colspan="5" class="table-empty"><div class="empty-state"><span>${result.error || '加载失败'}</span></div></td></tr>`;
                }
            } catch (err) {
                tbody.innerHTML = '<tr><td colspan="5" class="table-empty"><div class="empty-state"><span>网络请求错误</span></div></td></tr>';
            }
        }

        async function exportLogs() {
            const level = document.getElementById('log-level-filter')?.value || '';
            const moduleStr = document.getElementById('log-module-filter')?.value || '';
            const eventStr = document.getElementById('log-event-filter')?.value || '';
            const dateStr = document.getElementById('log-date-filter')?.value || '';
            const searchStr = document.getElementById('log-search-filter')?.value || '';
            const ipStr = document.getElementById('log-ip-filter')?.value || '';
            const fingerprintStr = document.getElementById('log-fingerprint-filter')?.value || '';

            const params = new URLSearchParams({ action: 'export' });
            if (level) params.append('level', level);
            if (moduleStr) params.append('module', moduleStr);
            if (eventStr) params.append('event', eventStr);
            if (dateStr) params.append('date', dateStr);
            if (searchStr) params.append('search', searchStr);
            if (ipStr) params.append('ip', ipStr);
            if (fingerprintStr) params.append('fingerprint', fingerprintStr);

            window.location.href = `${LOG_API}?${params.toString()}`;
        }

        function strLimit(str, limit = 100) {
            str = String(str || '');
            return str.length > limit ? str.substring(0, limit) + '...' : str;
        }

        function formatLogDetailsHtml(details) {
            if (!details) return '-';
            if (typeof details !== 'object') return `<span style="opacity: 0.85">${escapeHtml(strLimit(String(details), 80))}</span>`;

            let parts = [];
            for (let k in details) {
                let v = details[k];
                if (typeof v === 'object') v = JSON.stringify(v);
                parts.push(`<span style="color:var(--primary); font-weight:600;">${escapeHtml(k)}</span>: <span style="opacity: 0.85">${escapeHtml(strLimit(v, 60))}</span>`);
            }
            return parts.join('&nbsp; <span style="opacity:0.3">|</span> &nbsp;');
        }

        function renderStats(stats) {
            if (!stats) return;
            document.getElementById('stat-total').textContent = stats.total || 0;
            document.getElementById('stat-error').textContent = stats.error || 0;
            document.getElementById('stat-warn').textContent = stats.warn || 0;
            document.getElementById('stat-action').textContent = stats.action || 0;
            document.getElementById('stat-info').textContent = stats.info || 0;
        }

        function renderLogs(logs) {
            const tbody = document.getElementById('logs-tbody');
            if (!tbody) return;

            if (!logs || logs.length === 0) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="5" class="table-empty">
                            <div class="empty-state">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"></path>
                                    <polyline points="14 2 14 8 20 8"></polyline>
                                </svg>
                                <span>未检索到匹配的日志记录</span>
                            </div>
                        </td>
                    </tr>
                `;
                return;
            }

            const levelHtml = {
                'error': '<span class="action-tag error"><span class="status-dot error"></span>Error</span>',
                'warn': '<span class="action-tag warn"><span class="status-dot warn"></span>Warn</span>',
                'action': '<span class="action-tag action"><span class="status-dot action"></span>Action</span>',
                'info': '<span class="action-tag info"><span class="status-dot info"></span>Info</span>'
            };

            tbody.innerHTML = logs.map((log, index) => {
                const time = formatTimestamp(log.timestamp || Date.now());
                const lvl = levelHtml[log.level || 'info'] || `<span class="action-tag info">${escapeHtml(log.level)}</span>`;
                const module = log.module || '全局';
                const operatorBadge = (log.operator && log.operator !== 'anonymous' && log.operator !== 'admin')
                    ? `<div style="margin-top:3px; font-size:0.75rem; color:var(--primary); opacity:0.9;">操作人: ${escapeHtml(strLimit(log.operator, 26))}</div>`
                    : '';
                const evt = escapeHtml(log.event || log.action || '-');
                const details = formatLogDetailsHtml(log.details);
                const hasDetailedData = log.details && Object.keys(log.details).length > 0;

                return `
                    <tr>
                        <td class="cell-mono" style="font-size:0.82rem; color:var(--text-secondary);">${time}</td>
                        <td>${lvl}</td>
                        <td>
                            <span style="background:rgba(255,255,255,0.06); padding:3px 8px; border-radius:4px; font-size:0.82rem; font-weight:600;">${escapeHtml(module)}</span>
                            ${operatorBadge}
                        </td>
                        <td style="font-weight:600; color: var(--text-primary);">${evt}</td>
                        <td style="font-size:0.85rem; line-height:1.4; ${hasDetailedData ? 'cursor:pointer;' : ''}" ${hasDetailedData ? `onclick="showLogDetailModal(${index})" title="点击查看完整数据"` : ''}>
                            ${details}
                            ${hasDetailedData ? '<span style="display:inline-block; margin-left:8px; opacity:0.6; font-size:0.75rem; border:1px solid var(--border-color); padding:1px 5px; border-radius:3px; vertical-align:middle;">展开</span>' : ''}
                        </td>
                    </tr>
                `;
            }).join('');
        }

        function showLogDetailModal(index) {
            const log = globalLogsCache[index];
            if (!log) return;

            const rawJson = JSON.stringify(log.details, null, 2);
            const title = log.event || log.action || '日志事件详情';

            const modal = document.createElement('dialog');
            modal.className = 'modal-overlay native-dialog';
            modal.setAttribute('closedby', 'any');
            modal.innerHTML = `
                <div class="modal-box" style="max-width:760px; max-height:85vh;">
                    <div class="modal-header">
                        <h4>事件详情：${escapeHtml(title)}</h4>
                        <button type="button" class="modal-close" data-close-log-modal>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        </button>
                    </div>
                    <div class="modal-body" style="background:rgba(0,0,0,0.3); padding:16px; font-family:var(--font-mono); white-space:pre-wrap; word-break:break-all; font-size:0.88rem; line-height:1.5;">${escapeHtml(rawJson)}</div>
                    <div class="modal-footer">
                        <button type="button" class="btn secondary" data-copy-log-json>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg>
                            复制完整 JSON
                        </button>
                        <button type="button" class="btn primary" data-close-log-modal>关闭</button>
                    </div>
                </div>
            `;
            modal.querySelectorAll('[data-close-log-modal]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    if (window.DialogHelper) window.DialogHelper.close(modal);
                    else modal.remove();
                });
            });
            const copyBtn = modal.querySelector('[data-copy-log-json]');
            if (copyBtn) {
                copyBtn.addEventListener('click', () => {
                    if (navigator.clipboard && window.isSecureContext) {
                        navigator.clipboard.writeText(rawJson).then(() => showToast('已复制内容到剪贴板', 'success'));
                    } else {
                        const ta = document.createElement('textarea');
                        ta.value = rawJson;
                        ta.style.cssText = 'position:fixed;left:-9999px;';
                        document.body.appendChild(ta);
                        ta.select();
                        document.execCommand('copy');
                        document.body.removeChild(ta);
                        showToast('已复制内容到剪贴板', 'success');
                    }
                });
            }
            document.body.appendChild(modal);
            if (window.DialogHelper) {
                window.DialogHelper.open(modal, { dismissible: true, removeOnClose: true });
            } else {
                modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
            }
        }

        function renderPagination(pagination) {
            const container = document.getElementById('logs-pagination');
            if (!container || !pagination) return;
            const { page, totalPages, total } = pagination;
            if (totalPages <= 1 && total <= 0) { container.innerHTML = ''; return; }

            let html = `
                <div style="font-size:0.88rem; color:var(--text-secondary);">
                    共 <b style="color: var(--text-primary);">${total || 0}</b> 条记录 · 第 <b style="color:var(--primary);">${page}</b> / ${totalPages || 1} 页
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    ${page > 1 ? `<button class="page-btn" onclick="loadLogs(${page - 1})">上一页</button>` : `<button class="page-btn" disabled>上一页</button>`}
                    <span style="font-size:0.88rem; font-weight:600; color: var(--text-primary); padding:0 6px;">${page}</span>
                    ${page < totalPages ? `<button class="page-btn" onclick="loadLogs(${page + 1})">下一页</button>` : `<button class="page-btn" disabled>下一页</button>`}
                </div>
            `;
            container.innerHTML = html;
        }

        /* ========================================================
           Sender_py 自动发送器归档与核验现场查看器
           ======================================================== */
        let senderClientsCache = [];
        let selectedSenderKey = null; // `${date}__${client_slug}`
        let activeSenderDetailTab = 'raw'; // 'raw' | 'batches' | 'snapshots'
        let activeSenderLogType = 'sender'; // 'sender' | 'error'
        let rawSenderLogContentCache = '';

        function switchLogsSubview(mode) {
            const auditView = document.getElementById('logs-audit-subview');
            const senderView = document.getElementById('logs-sender-subview');
            const btnAudit = document.getElementById('btn-log-subview-audit');
            const btnSender = document.getElementById('btn-log-subview-sender');

            if (!auditView || !senderView) return;

            if (mode === 'sender') {
                auditView.style.display = 'none';
                senderView.style.display = 'block';
                if (btnAudit) btnAudit.className = 'btn secondary';
                if (btnSender) btnSender.className = 'btn primary';
                loadSenderClients();
            } else {
                auditView.style.display = 'block';
                senderView.style.display = 'none';
                if (btnAudit) btnAudit.className = 'btn primary';
                if (btnSender) btnSender.className = 'btn secondary';
            }
        }

        function quickFilterSenderModule() {
            switchLogsSubview('audit');
            const moduleSelect = document.getElementById('log-module-filter');
            if (moduleSelect) {
                if (!Array.from(moduleSelect.options).some(o => o.value === 'sender_py')) {
                    const opt = document.createElement('option');
                    opt.value = 'sender_py';
                    opt.textContent = 'sender_py';
                    moduleSelect.appendChild(opt);
                }
                moduleSelect.value = 'sender_py';
            }
            loadLogs(1);
        }

        async function loadSenderClients() {
            const listEl = document.getElementById('sender-clients-list');
            const dateFilterEl = document.getElementById('sender-date-filter');
            const countBadgeEl = document.getElementById('sender-clients-count-badge');
            if (!listEl) return;

            const selectedDate = dateFilterEl ? dateFilterEl.value : '';
            listEl.innerHTML = '<div style="padding:24px; text-align:center; color:var(--text-secondary); font-size:0.86rem;">正在加载客户端同步记录...</div>';

            try {
                const params = new URLSearchParams({ action: 'sender_clients' });
                if (selectedDate) params.append('date', selectedDate);
                const res = await fetch(`${LOG_API}?${params.toString()}`);
                const json = await res.json();
                if (!json.success) {
                    listEl.innerHTML = `<div style="padding:24px; text-align:center; color:var(--danger); font-size:0.86rem;">${escapeHtml(json.error || '加载失败')}</div>`;
                    return;
                }

                if (dateFilterEl && Array.isArray(json.data.dates)) {
                    const prevVal = dateFilterEl.value;
                    dateFilterEl.innerHTML = '<option value="">最近 7 天归档</option>' +
                        json.data.dates.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
                    if (prevVal && json.data.dates.includes(prevVal)) {
                        dateFilterEl.value = prevVal;
                    }
                }

                senderClientsCache = json.data.clients || [];
                window.globalSenderControlCache = json.data.global_sender_control || {};
                if (countBadgeEl) {
                    countBadgeEl.textContent = senderClientsCache.length > 0 ? `${senderClientsCache.length} 台归档` : '自动同步';
                }
                renderSenderClientsList();

                if (senderClientsCache.length > 0) {
                    const currentStillExists = senderClientsCache.some(c => `${c.date}__${c.client_slug}` === selectedSenderKey);
                    if (!currentStillExists) {
                        const first = senderClientsCache[0];
                        selectSenderClient(first.date, first.client_slug);
                    } else if (selectedSenderKey) {
                        const [dStr, cSlug] = selectedSenderKey.split('__');
                        selectSenderClient(dStr, cSlug);
                    } else {
                        const [d, s] = selectedSenderKey.split('__');
                        selectSenderClient(d, s);
                    }
                }
            } catch (err) {
                listEl.innerHTML = '<div style="padding:24px; text-align:center; color:var(--danger); font-size:0.86rem;">网络错误，无法加载客户端日志列表</div>';
            }
        }

        function renderSenderClientsList() {
            const listEl = document.getElementById('sender-clients-list');
            const searchInput = document.getElementById('sender-client-search');
            if (!listEl) return;

            const kw = (searchInput ? searchInput.value : '').trim().toLowerCase();
            const filteredClients = (senderClientsCache || []).filter(item => {
                if (!kw) return true;
                const hay = [
                    item.teacher_note || '',
                    item.display_label || '',
                    item.hostname || '',
                    item.os_user || '',
                    item.client_slug || '',
                    ...(Array.isArray(item.active_files) ? item.active_files : [])
                ].join(' ').toLowerCase();
                return hay.includes(kw);
            });

            if (filteredClients.length === 0) {
                listEl.innerHTML = `
                    <div style="padding:36px 16px; text-align:center; color:var(--text-secondary); font-size:0.85rem; line-height:1.6;">
                        ${kw ? '未找到匹配的客户端归档记录。' : '暂无自动发送器上传的归档日志。<br><span style="font-size:0.78rem; opacity:0.75;">当老师启动 sender_py 客户端后，日志与异常截图将自动同步至此。</span>'}
                    </div>
                `;
                return;
            }

            listEl.innerHTML = filteredClients.map(item => {
                const key = `${item.date}__${item.client_slug}`;
                const isSelected = key === selectedSenderKey;
                const displayName = item.display_name
                    || (item.teacher_note ? `${item.teacher_note} (${item.hostname || item.client_slug})` : (item.hostname || item.client_slug));
                const hasErrors = Boolean(item.has_error_log);
                const batchCount = Array.isArray(item.batches) ? item.batches.length : 0;
                const snapCount = Array.isArray(item.snapshots) ? item.snapshots.length : 0;
                const rt = item.runtime_state || {};
                const cs = item.control_summary || {};
                const isRunning = Boolean(rt.running);
                const hasOverride = Boolean(cs.has_override);
                const pendingCmds = Number(cs.pending_commands_count || 0);
                const activeFilesText = Array.isArray(item.active_files) && item.active_files.length > 0
                    ? item.active_files.join(', ')
                    : '未挂载课表';
                const lastSync = item.last_sync_at || item.last_seen || '-';

                return `
                    <div onclick="selectSenderClient('${escapeInlineJs(item.date)}', '${escapeInlineJs(item.client_slug)}')"
                         style="padding:12px; border-radius:8px; margin-bottom:8px; cursor:pointer; transition:border-color 0.15s ease, background-color 0.15s ease; border:1px solid ${isSelected ? 'var(--primary)' : 'var(--border-color)'}; background:${isSelected ? 'rgba(99, 102, 241, 0.12)' : 'rgba(255,255,255,0.02)'};">
                        <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; margin-bottom:4px;">
                            <span style="font-weight:600; font-size:0.88rem; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(displayName)}">
                                ${escapeHtml(displayName)}
                            </span>
                            <span style="font-size:0.74rem; color:var(--text-secondary); font-family:var(--font-mono); flex-shrink:0;">${escapeHtml(item.app_version ? 'v' + item.app_version : item.date)}</span>
                        </div>
                        <div style="font-size:0.77rem; color:var(--text-secondary); margin-bottom:6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(activeFilesText)}">
                            课表: ${escapeHtml(activeFilesText)}
                        </div>
                        <div style="display:flex; align-items:center; justify-content:space-between; font-size:0.74rem; color:var(--text-secondary); flex-wrap:wrap; gap:4px;">
                            <span>最后活跃: ${escapeHtml(lastSync.split(' ')[1] || lastSync)}</span>
                            <div style="display:flex; gap:4px; flex-wrap:wrap;">
                                ${isRunning ? `<span style="background:rgba(59,130,246,0.22); color:#60a5fa; padding:1px 6px; border-radius:4px; font-weight:600;">发送中 ${Number(rt.processed || 0)}/${Number(rt.total || 0)}</span>` : ''}
                                ${hasOverride ? '<span style="background:rgba(168,85,247,0.2); color:#c084fc; padding:1px 6px; border-radius:4px; font-weight:600;">单机策略</span>' : ''}
                                ${pendingCmds > 0 ? `<span style="background:rgba(245,158,11,0.22); color:#fbbf24; padding:1px 6px; border-radius:4px; font-weight:600;">${pendingCmds} 待执行</span>` : ''}
                                ${hasErrors ? '<span style="background:rgba(239,68,68,0.18); color:#f87171; padding:1px 6px; border-radius:4px; font-weight:600;">含报错</span>' : ''}
                                ${batchCount > 0 ? `<span style="background:rgba(16,185,129,0.15); color:#34d399; padding:1px 6px; border-radius:4px;">${batchCount} 批次</span>` : ''}
                                ${snapCount > 0 ? `<span style="background:rgba(245,158,11,0.18); color:#fbbf24; padding:1px 6px; border-radius:4px;">${snapCount} 截图</span>` : ''}
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        }

        function selectSenderClient(dateStr, clientSlug) {
            selectedSenderKey = `${dateStr}__${clientSlug}`;
            renderSenderClientsList();

            const panel = document.getElementById('sender-client-detail-panel');
            if (!panel) return;

            const client = senderClientsCache.find(c => c.date === dateStr && c.client_slug === clientSlug);
            if (!client) return;

            const displayName = client.display_name
                || (client.teacher_note ? `${client.teacher_note} (${client.hostname || client.client_slug})` : (client.hostname || client.client_slug));
            const activeFilesText = Array.isArray(client.active_files) && client.active_files.length > 0
                ? client.active_files.join(' 、 ')
                : '暂无课表记录';
            const batchesCount = Array.isArray(client.batches) ? client.batches.length : 0;
            const snapshotsCount = Array.isArray(client.snapshots) ? client.snapshots.length : 0;
            const lastSync = client.last_sync_at || client.last_seen || '-';
            const rt = client.runtime_state || {};
            const cs = client.control_summary || {};
            const overrides = cs.overrides || {};
            const overrideKeys = Object.keys(overrides);
            const recentCmds = Array.isArray(cs.recent_commands) ? cs.recent_commands : [];
            const cmdNameMap = {
                stop_batch: '远程急停',
                refresh_policy: '刷新策略',
                clear_roi: '清空ROI',
                sync_logs: '补传日志'
            };

            const overrideSummaryText = overrideKeys.length > 0
                ? overrideKeys.map(k => `${k}=${overrides[k]}`).join(', ') + (cs.override_note ? `（${cs.override_note}）` : '')
                : '继承全局默认策略';

            panel.innerHTML = `
                <div style="padding:14px 18px; border-bottom:1px solid var(--border-color); display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
                    <div>
                        <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                            <h3 style="margin:0; font-size:1rem; font-weight:700; color:var(--text-primary);">${escapeHtml(displayName)}</h3>
                            <span style="font-size:0.78rem; padding:2px 8px; border-radius:4px; background:rgba(255,255,255,0.06); color:var(--text-secondary); font-family:var(--font-mono);">日期: ${escapeHtml(client.date)}</span>
                            <span style="font-size:0.78rem; padding:2px 8px; border-radius:4px; background:rgba(255,255,255,0.06); color:var(--text-secondary); font-family:var(--font-mono);">系统账号: ${escapeHtml(client.os_user || '-')} | IP: ${escapeHtml(client.ip || '-')}${client.app_version ? ' | v' + escapeHtml(client.app_version) : ''}</span>
                            ${rt.running ? `<span style="font-size:0.78rem; padding:2px 8px; border-radius:4px; background:rgba(59,130,246,0.2); color:#60a5fa; font-weight:600;">运行中 ${Number(rt.processed || 0)}/${Number(rt.total || 0)} ${rt.current_name ? '(' + escapeHtml(rt.current_name) + ')' : ''}</span>` : ''}
                        </div>
                        <div style="font-size:0.8rem; color:var(--text-secondary); margin-top:6px;">
                            当前/最近课表：<b style="color:var(--text-primary);">${escapeHtml(activeFilesText)}</b>
                            <span style="margin-left:12px; opacity:0.75;">最后同步时间：${escapeHtml(lastSync)}</span>
                        </div>
                    </div>
                    <div style="display:flex; gap:6px; flex-wrap:wrap;">
                        <button id="sender-dtab-raw" class="btn ${activeSenderDetailTab === 'raw' ? 'primary' : 'secondary'}" onclick="switchSenderDetailTab('raw')" style="padding:6px 12px; font-size:0.82rem;">
                            原始 .log 日志
                        </button>
                        <button id="sender-dtab-batches" class="btn ${activeSenderDetailTab === 'batches' ? 'primary' : 'secondary'}" onclick="switchSenderDetailTab('batches')" style="padding:6px 12px; font-size:0.82rem;">
                            批次发送汇总 (${batchesCount})
                        </button>
                        <button id="sender-dtab-snapshots" class="btn ${activeSenderDetailTab === 'snapshots' ? 'primary' : 'secondary'}" onclick="switchSenderDetailTab('snapshots')" style="padding:6px 12px; font-size:0.82rem;">
                            核验现场截图 (${snapshotsCount})
                        </button>
                    </div>
                </div>
                <!-- 重档 · 单机云控与远程指令工具栏 -->
                <div style="padding:10px 18px; border-bottom:1px solid var(--border-color); background:rgba(99,102,241,0.05); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
                    <div style="font-size:0.79rem; color:var(--text-secondary); display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                        <span style="font-weight:600; color:#818cf8;">☁ 单机云控:</span>
                        <span style="font-family:var(--font-mono); color:var(--text-primary);">${escapeHtml(overrideSummaryText)}</span>
                        ${recentCmds.slice(0, 2).map(cmd => {
                            const done = Boolean(cmd.acked_at);
                            const label = cmdNameMap[cmd.type] || cmd.type;
                            const badgeStyle = done
                                ? 'background:rgba(16,185,129,0.15); color:#34d399;'
                                : 'background:rgba(245,158,11,0.2); color:#fbbf24;';
                            return `<span style="font-size:0.73rem; padding:1px 7px; border-radius:4px; ${badgeStyle}" title="${escapeHtml((cmd.created_at || '') + ' ' + (cmd.ack_message || ''))}">${escapeHtml(label)}: ${done ? '已执行' : '待送达'}</span>`;
                        }).join('')}
                    </div>
                    <div style="display:flex; gap:6px; flex-wrap:wrap;">
                        <button class="btn danger-subtle" onclick="sendSenderRemoteCommand('${escapeInlineJs(client.client_slug)}', 'stop_batch')" style="padding:5px 10px; font-size:0.79rem;" title="向该电脑下发远程急停指令（最多2~12秒内送达，安全停下并保留断点）">
                            ⏹ 远程急停
                        </button>
                        <button class="btn secondary" onclick="openSenderClientOverrideModal('${escapeInlineJs(client.client_slug)}', '${escapeInlineJs(displayName)}')" style="padding:5px 10px; font-size:0.79rem;">
                            ⚙ 单机策略覆盖
                        </button>
                        <button class="btn secondary" onclick="sendSenderRemoteCommand('${escapeInlineJs(client.client_slug)}', 'refresh_policy')" style="padding:5px 10px; font-size:0.79rem;" title="通知客户端立即刷新云控策略">
                            ↻ 同步策略
                        </button>
                        <button class="btn secondary" onclick="sendSenderRemoteCommand('${escapeInlineJs(client.client_slug)}', 'clear_roi')" style="padding:5px 10px; font-size:0.79rem;" title="重置该电脑保存的企微窗口 ROI 校准坐标">
                            清空视野ROI
                        </button>
                        <button class="btn secondary" onclick="sendSenderRemoteCommand('${escapeInlineJs(client.client_slug)}', 'sync_logs')" style="padding:5px 10px; font-size:0.79rem;" title="要求客户端立即补传本地未同步的 .log 文件">
                            补传日志
                        </button>
                    </div>
                </div>
                <div id="sender-detail-body" style="flex:1; display:flex; flex-direction:column; overflow:hidden;"></div>
            `;

            switchSenderDetailTab(activeSenderDetailTab);
        }

        function switchSenderDetailTab(tab) {
            activeSenderDetailTab = tab;
            ['raw', 'batches', 'snapshots'].forEach(t => {
                const btn = document.getElementById(`sender-dtab-${t}`);
                if (btn) btn.className = `btn ${t === tab ? 'primary' : 'secondary'}`;
            });

            if (!selectedSenderKey) return;
            const [dateStr, clientSlug] = selectedSenderKey.split('__');
            const client = senderClientsCache.find(c => c.date === dateStr && c.client_slug === clientSlug);
            if (!client) return;

            if (tab === 'raw') {
                renderSenderRawTab(client);
            } else if (tab === 'batches') {
                renderSenderBatches(client);
            } else if (tab === 'snapshots') {
                renderSenderSnapshots(client);
            }
        }

        function renderSenderRawTab(client) {
            const body = document.getElementById('sender-detail-body');
            if (!body) return;

            const hasSender = Boolean(client.has_sender_log);
            const hasError = Boolean(client.has_error_log);
            if (activeSenderLogType === 'error' && !hasError && hasSender) {
                activeSenderLogType = 'sender';
            }

            const downloadUrl = `${LOG_API}?action=sender_log_file&date=${encodeURIComponent(client.date)}&client=${encodeURIComponent(client.client_slug)}&type=${encodeURIComponent(activeSenderLogType)}&download=1`;

            body.innerHTML = `
                <div style="padding:10px 18px; border-bottom:1px solid var(--border-color); display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; background:rgba(0,0,0,0.15);">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <button class="btn ${activeSenderLogType === 'sender' ? 'primary' : 'secondary'}" onclick="activeSenderLogType='sender'; renderSenderRawTab(senderClientsCache.find(c=>c.date==='${escapeInlineJs(client.date)}' && c.client_slug==='${escapeInlineJs(client.client_slug)}'))" style="padding:4px 10px; font-size:0.8rem;">
                            全量运行日志 (sender_${escapeHtml(client.date)}.log ${client.sender_log_size_kb ? `· ${client.sender_log_size_kb} KB` : ''})
                        </button>
                        <button class="btn ${activeSenderLogType === 'error' ? 'primary' : 'secondary'}" onclick="activeSenderLogType='error'; renderSenderRawTab(senderClientsCache.find(c=>c.date==='${escapeInlineJs(client.date)}' && c.client_slug==='${escapeInlineJs(client.client_slug)}'))" style="padding:4px 10px; font-size:0.8rem;">
                            错误与警告专档 (error_${escapeHtml(client.date)}.log ${client.error_log_size_kb ? `· ${client.error_log_size_kb} KB` : ''})
                        </button>
                    </div>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <input type="text" id="sender-raw-keyword" class="filter-input" placeholder="过滤日志行关键词 (如学生姓名/ERROR)..." oninput="filterSenderRawLog()" style="padding:4px 10px; font-size:0.8rem; width:220px;">
                        <a href="${downloadUrl}" class="btn secondary" style="padding:4px 10px; font-size:0.8rem; text-decoration:none;">
                            下载原 .log 文件
                        </a>
                    </div>
                </div>
                <pre id="sender-raw-log-pre" style="flex:1; margin:0; padding:16px; background:#0d1117; color:#e6edf3; font-family:var(--font-mono); font-size:0.8rem; line-height:1.55; overflow:auto; max-height:540px; white-space:pre-wrap; word-break:break-all;">正在读取日志文件...</pre>
            `;

            loadSenderRawLog(client.date, client.client_slug, activeSenderLogType);
        }

        async function loadSenderRawLog(dateStr, clientSlug, type) {
            const pre = document.getElementById('sender-raw-log-pre');
            if (!pre) return;

            try {
                const params = new URLSearchParams({
                    action: 'sender_log_file',
                    date: dateStr,
                    client: clientSlug,
                    type: type,
                    lines: 2000
                });
                const res = await fetch(`${LOG_API}?${params.toString()}`);
                const json = await res.json();
                if (json.success) {
                    rawSenderLogContentCache = json.data.content || '（该日志文件暂无内容）';
                    filterSenderRawLog();
                    pre.scrollTop = pre.scrollHeight;
                } else {
                    rawSenderLogContentCache = '';
                    pre.textContent = `暂未生成此日志文件 (${json.error || '无内容'})`;
                }
            } catch (err) {
                pre.textContent = '读取日志文件失败，请检查网络连接。';
            }
        }

        function filterSenderRawLog() {
            const pre = document.getElementById('sender-raw-log-pre');
            const kwInput = document.getElementById('sender-raw-keyword');
            if (!pre) return;
            const kw = (kwInput ? kwInput.value : '').trim().toLowerCase();
            if (!kw) {
                pre.textContent = rawSenderLogContentCache || '（空）';
                return;
            }
            const lines = (rawSenderLogContentCache || '').split('\n');
            const matched = lines.filter(l => l.toLowerCase().includes(kw));
            pre.textContent = matched.length > 0
                ? matched.join('\n')
                : `未找到包含 "${kwInput.value}" 的日志行（共检索 ${lines.length} 行）`;
        }

        function renderSenderBatches(client) {
            const body = document.getElementById('sender-detail-body');
            if (!body) return;

            const batches = Array.isArray(client.batches) ? client.batches : [];
            if (batches.length === 0) {
                body.innerHTML = `<div style="padding:48px; text-align:center; color:var(--text-secondary);">该客户端当日暂无已完成的批次发送汇总</div>`;
                return;
            }

            body.innerHTML = `
                <div style="padding:16px 18px; overflow-y:auto; max-height:560px; display:flex; flex-direction:column; gap:12px;">
                    ${batches.map((b, idx) => {
                        const c = b.counts || {};
                        const items = Array.isArray(b.students) ? b.students : (Array.isArray(b.items) ? b.items : []);
                        const fileArr = Array.isArray(b.files) ? b.files : (Array.isArray(b.active_files) ? b.active_files : []);
                        const filesStr = fileArr.length > 0 ? fileArr.join(' 、 ') : '-';
                        const timeLabel = b.sent_time || b.finished_at || '-';
                        return `
                            <div style="border:1px solid var(--border-color); border-radius:8px; background:rgba(255,255,255,0.02); padding:14px;">
                                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:10px;">
                                    <div>
                                        <span style="font-weight:700; color:var(--text-primary); font-size:0.9rem;">完成时间：${escapeHtml(timeLabel)}</span>
                                        ${b.stopped ? '<span style="margin-left:6px; font-size:0.75rem; color:#fbbf24;">(手动暂停)</span>' : ''}
                                        <span style="margin-left:10px; font-size:0.8rem; color:var(--text-secondary);">课表：${escapeHtml(filesStr)}</span>
                                    </div>
                                    <div style="display:flex; gap:6px; font-size:0.78rem; flex-wrap:wrap;">
                                        <span style="padding:2px 8px; border-radius:4px; background:rgba(255,255,255,0.06);">总计 <b>${c.total || 0}</b></span>
                                        <span style="padding:2px 8px; border-radius:4px; background:rgba(16,185,129,0.16); color:#34d399;">已发送 <b>${c.sent || 0}</b></span>
                                        <span style="padding:2px 8px; border-radius:4px; background:rgba(239,68,68,0.16); color:#f87171;">失败 <b>${c.failed || 0}</b></span>
                                        <span style="padding:2px 8px; border-radius:4px; background:rgba(245,158,11,0.16); color:#fbbf24;">群聊拦截 <b>${c.blocked || 0}</b></span>
                                        <span style="padding:2px 8px; border-radius:4px; background:rgba(156,163,175,0.16); color:#9ca3af;">未匹配 <b>${c.unmatched || 0}</b></span>
                                    </div>
                                </div>
                                ${items.length > 0 ? `
                                    <details ${idx === 0 ? 'open' : ''} style="font-size:0.82rem;">
                                        <summary style="cursor:pointer; color:var(--primary); font-weight:600; margin-bottom:8px;">查看该批次学生发送明细 (${items.length} 人)</summary>
                                        <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:6px; max-height:240px; overflow-y:auto; padding:4px;">
                                            ${items.map(st => {
                                                const stName = st.studentName || st.sname || st.name || '-';
                                                const stId = st.sid || st.id || '';
                                                const stStatus = st.status || '-';
                                                const isOk = stStatus === '已发送' || stStatus === 'sent';
                                                const isSkip = stStatus === '已跳过' || stStatus === 'skipped';
                                                const color = isOk ? '#34d399' : (isSkip ? '#9ca3af' : '#f87171');
                                                return `
                                                    <div style="padding:6px 8px; border-radius:6px; background:rgba(0,0,0,0.25); border-left:3px solid ${color}; display:flex; justify-content:space-between; align-items:center; gap:6px;">
                                                        <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                                                            <b>${escapeHtml(stName)}</b>
                                                            <span style="opacity:0.65; font-size:0.74rem; font-family:var(--font-mono);">${escapeHtml(stId)}</span>
                                                            ${st.reason ? `<div style="font-size:0.72rem; color:var(--text-secondary); overflow:hidden; text-overflow:ellipsis;" title="${escapeHtml(st.reason)}">${escapeHtml(st.reason)}</div>` : ''}
                                                        </div>
                                                        <span style="color:${color}; font-size:0.75rem; font-weight:600; flex-shrink:0;">${escapeHtml(stStatus)}</span>
                                                    </div>
                                                `;
                                            }).join('')}
                                        </div>
                                    </details>
                                ` : ''}
                            </div>
                        `;
                    }).join('')}
                </div>
            `;
        }

        function renderSenderSnapshots(client) {
            const body = document.getElementById('sender-detail-body');
            if (!body) return;

            const snaps = Array.isArray(client.snapshots) ? client.snapshots : [];
            if (snaps.length === 0) {
                body.innerHTML = `<div style="padding:48px; text-align:center; color:var(--text-secondary);">该客户端当日没有触发核验失败或群聊拦截的现场截图</div>`;
                return;
            }

            body.innerHTML = `
                <div style="padding:16px 18px; overflow-y:auto; max-height:560px; display:grid; grid-template-columns:repeat(auto-fill, minmax(300px, 1fr)); gap:14px;">
                    ${snaps.map(s => {
                        const hasTitle = Boolean(s.has_title || s.has_title_img);
                        const hasAnnotated = Boolean(s.has_annotated || s.has_annotated_img);
                        const titleUrl = hasTitle
                            ? `${LOG_API}?action=sender_snapshot_img&date=${encodeURIComponent(client.date)}&client=${encodeURIComponent(client.client_slug)}&prefix=${encodeURIComponent(s.prefix)}&img=title`
                            : '';
                        const annotatedUrl = hasAnnotated
                            ? `${LOG_API}?action=sender_snapshot_img&date=${encodeURIComponent(client.date)}&client=${encodeURIComponent(client.client_slug)}&prefix=${encodeURIComponent(s.prefix)}&img=annotated`
                            : '';
                        const badgeColor = s.is_group ? '#fbbf24' : '#f87171';
                        const badgeText = s.is_group ? '群聊熔断拦截' : '标题核验不匹配';

                        return `
                            <div style="border:1px solid var(--border-color); border-radius:8px; background:rgba(255,255,255,0.02); padding:12px; display:flex; flex-direction:column; gap:8px;">
                                <div style="display:flex; justify-content:space-between; align-items:center;">
                                    <span style="font-weight:700; color:var(--text-primary); font-size:0.88rem;">
                                        目标: ${escapeHtml(s.target_name || '-')} <span style="font-family:var(--font-mono); font-size:0.78rem; opacity:0.75;">(${escapeHtml(s.target_id || '-')})</span>
                                    </span>
                                    <span style="font-size:0.74rem; font-weight:600; color:${badgeColor};">${badgeText}</span>
                                </div>
                                <div style="font-size:0.78rem; color:var(--text-secondary); line-height:1.45;">
                                    <div>第 <b>${escapeHtml(String(s.candidate ?? '-'))}</b> 顺位候选 | 时间: ${escapeHtml(s.timestamp || '-')}</div>
                                    <div>OCR 识别标题: <code style="color:var(--text-primary);">${escapeHtml(s.detected_title || '未识别')}</code></div>
                                    <div>判定原因: <span style="color:${badgeColor};">${escapeHtml(s.reason || '-')}</span></div>
                                </div>
                                ${titleUrl ? `
                                    <div>
                                        <div style="font-size:0.73rem; color:var(--text-secondary); margin-bottom:3px;">聊天标题栏截图 (点击放大):</div>
                                        <img src="${titleUrl}" onclick="openSnapshotPreviewModal('${titleUrl}', '标题栏裁剪图 - ${escapeInlineJs(s.target_name || '')}')" style="width:100%; max-height:70px; object-fit:contain; background:#000; border-radius:4px; cursor:zoom-in; border:1px solid rgba(255,255,255,0.1);">
                                    </div>
                                ` : ''}
                                ${annotatedUrl ? `
                                    <div>
                                        <div style="font-size:0.73rem; color:var(--text-secondary); margin-bottom:3px;">企微窗口红框标注全图 (点击放大):</div>
                                        <img src="${annotatedUrl}" onclick="openSnapshotPreviewModal('${annotatedUrl}', '企微窗口现场全图 - ${escapeInlineJs(s.target_name || '')}')" style="width:100%; max-height:150px; object-fit:contain; background:#000; border-radius:4px; cursor:zoom-in; border:1px solid rgba(255,255,255,0.1);">
                                    </div>
                                ` : ''}
                            </div>
                        `;
                    }).join('')}
                </div>
            `;
        }

        function openSnapshotPreviewModal(imgUrl, title) {
            const modal = document.createElement('dialog');
            modal.className = 'modal-overlay native-dialog';
            modal.setAttribute('closedby', 'any');
            modal.innerHTML = `
                <div class="modal-box" style="max-width:90vw; max-height:90vh; width:auto;">
                    <div class="modal-header">
                        <h4>${escapeHtml(title || '现场核验截图')}</h4>
                        <button type="button" class="modal-close" data-close-snap-modal>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        </button>
                    </div>
                    <div class="modal-body" style="padding:12px; background:#000; text-align:center; overflow:auto; max-height:78vh;">
                        <img src="${imgUrl}" alt="${escapeHtml(title || '现场核验截图')}" style="max-width:100%; max-height:74vh; object-fit:contain;">
                    </div>
                </div>
            `;
            const closeBtn = modal.querySelector('[data-close-snap-modal]');
            if (closeBtn) {
                closeBtn.addEventListener('click', () => {
                    if (window.DialogHelper) window.DialogHelper.close(modal);
                    else modal.remove();
                });
            }
            document.body.appendChild(modal);
            if (window.DialogHelper) {
                window.DialogHelper.open(modal, { dismissible: true, removeOnClose: true });
            } else {
                modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
            }
        }

        async function sendSenderRemoteCommand(clientSlug, cmdType) {
            const labels = {
                stop_batch: '远程急停（立即安全暂停该电脑当前的发送批次并保留断点）',
                refresh_policy: '通知该电脑立即刷新云控策略',
                clear_roi: '清除该电脑本地的企微视野 ROI 校准缓存（下次发送前将重新标定）',
                sync_logs: '触发该电脑立即补传本地未上传的 .log 日志'
            };
            const desc = labels[cmdType] || cmdType;
            if (cmdType === 'stop_batch' || cmdType === 'clear_roi') {
                const ok = await showConfirm('确认下发远程指令', `确认下发指令：${desc}？`, cmdType === 'stop_batch');
                if (!ok) return;
            }
            try {
                const res = await fetch(`${LOG_API}?action=sender_client_command`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        client_slug: clientSlug,
                        type: cmdType,
                        params: cmdType === 'stop_batch' ? { reason: '管理员在后台日志页下发远程急停' } : {}
                    })
                });
                const json = await res.json();
                if (!json.success) {
                    showToast(json.error || '下发远程指令失败', 'error');
                    return;
                }
                showToast(`远程指令 [${desc}] 已入队，将在下次心跳/同步时送达客户端`, 'success');
                loadSenderClients();
            } catch (err) {
                showToast('下发远程指令失败: ' + err.message, 'error');
            }
        }

        async function openSenderClientOverrideModal(clientSlug, displayName) {
            try {
                const res = await fetch(`${LOG_API}?action=sender_client_control&client=${encodeURIComponent(clientSlug)}`);
                const json = await res.json();
                if (!json.success) {
                    showToast(json.error || '读取单机策略失败', 'error');
                    return;
                }
                const globalPol = json.data.global || {};
                const cc = json.data.client_control || {};
                const ov = cc.overrides || {};

                const modal = document.createElement('dialog');
                modal.className = 'modal-overlay native-dialog';
                modal.setAttribute('closedby', 'any');
                modal.innerHTML = `
                    <div class="modal-box" style="max-width:620px; width:94vw;">
                        <div class="modal-header">
                            <h4>单机云控策略覆盖 · ${escapeHtml(displayName || clientSlug)}</h4>
                            <button type="button" class="modal-close" data-close-ov-modal>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                            </button>
                        </div>
                        <div class="modal-body" style="padding:16px 20px; display:flex; flex-direction:column; gap:12px; max-height:74vh; overflow-y:auto;">
                            <div style="font-size:0.8rem; color:var(--text-secondary); background:rgba(255,255,255,0.03); padding:8px 12px; border-radius:6px;">
                                当前全局默认: <code>verifyMode=${escapeHtml(globalPol.verifyMode || 'auto')}</code>, <code>searchWait=${escapeHtml(String(globalPol.searchWait ?? 1.5))}s</code>, <code>enterWait=${escapeHtml(String(globalPol.enterWait ?? 1.2))}s</code>。留空/选“继承全局”表示跟随全局设置。
                            </div>
                            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px;">
                                <div>
                                    <label style="display:block; font-size:0.8rem; color:var(--text-secondary); margin-bottom:4px;">服务访问锁</label>
                                    <select id="ov-service-enabled" class="custom-select" style="width:100%;">
                                        <option value="" ${ov.senderServiceEnabled === undefined ? 'selected' : ''}>继承全局</option>
                                        <option value="1" ${ov.senderServiceEnabled === true ? 'selected' : ''}>允许本机发送</option>
                                        <option value="0" ${ov.senderServiceEnabled === false ? 'selected' : ''}>锁定禁止本机发送</option>
                                    </select>
                                </div>
                                <div>
                                    <label style="display:block; font-size:0.8rem; color:var(--text-secondary); margin-bottom:4px;">标题核验模式</label>
                                    <select id="ov-verify-mode" class="custom-select" style="width:100%;">
                                        <option value="" ${!ov.verifyMode ? 'selected' : ''}>继承全局</option>
                                        <option value="auto" ${ov.verifyMode === 'auto' ? 'selected' : ''}>auto · 智能阶梯</option>
                                        <option value="local" ${ov.verifyMode === 'local' ? 'selected' : ''}>local · 纯本地OCR</option>
                                        <option value="api" ${ov.verifyMode === 'api' ? 'selected' : ''}>api · 纯云端API</option>
                                    </select>
                                </div>
                                <div>
                                    <label style="display:block; font-size:0.8rem; color:var(--text-secondary); margin-bottom:4px;">后台家长留言分析</label>
                                    <select id="ov-enable-reply" class="custom-select" style="width:100%;">
                                        <option value="" ${ov.enableReplyAnalysis === undefined ? 'selected' : ''}>继承全局</option>
                                        <option value="1" ${ov.enableReplyAnalysis === true ? 'selected' : ''}>开启云端分析</option>
                                        <option value="0" ${ov.enableReplyAnalysis === false ? 'selected' : ''}>关闭（省Token）</option>
                                    </select>
                                </div>
                                <div>
                                    <label style="display:block; font-size:0.8rem; color:var(--text-secondary); margin-bottom:4px;">AI 自动窗口校准</label>
                                    <select id="ov-enable-cal" class="custom-select" style="width:100%;">
                                        <option value="" ${ov.enableAutoCalibration === undefined ? 'selected' : ''}>继承全局</option>
                                        <option value="1" ${ov.enableAutoCalibration === true ? 'selected' : ''}>允许 AI 校准</option>
                                        <option value="0" ${ov.enableAutoCalibration === false ? 'selected' : ''}>关闭（仅手动框选）</option>
                                    </select>
                                </div>
                                <div>
                                    <label style="display:block; font-size:0.8rem; color:var(--text-secondary); margin-bottom:4px;">基准评测大模型</label>
                                    <select id="ov-enable-bm" class="custom-select" style="width:100%;">
                                        <option value="" ${ov.enableBenchmarkModel === undefined ? 'selected' : ''}>继承全局</option>
                                        <option value="1" ${ov.enableBenchmarkModel === true ? 'selected' : ''}>允许对比大模型</option>
                                        <option value="0" ${ov.enableBenchmarkModel === false ? 'selected' : ''}>关闭（仅本地OCR）</option>
                                    </select>
                                </div>
                                <div>
                                    <label style="display:block; font-size:0.8rem; color:var(--text-secondary); margin-bottom:4px;">核验截图上传</label>
                                    <select id="ov-snapshot-policy" class="custom-select" style="width:100%;">
                                        <option value="" ${!ov.snapshotPolicy ? 'selected' : ''}>继承全局</option>
                                        <option value="errors_only" ${ov.snapshotPolicy === 'errors_only' ? 'selected' : ''}>仅失败/拦截上传</option>
                                        <option value="always" ${ov.snapshotPolicy === 'always' ? 'selected' : ''}>每次均上传（排查）</option>
                                        <option value="off" ${ov.snapshotPolicy === 'off' ? 'selected' : ''}>关闭上传</option>
                                    </select>
                                </div>
                            </div>
                            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(120px, 1fr)); gap:10px;">
                                <div>
                                    <label style="display:block; font-size:0.76rem; color:var(--text-muted); margin-bottom:4px;">searchWait (s)</label>
                                    <input type="number" step="0.1" min="0.4" max="8" id="ov-search-wait" value="${ov.searchWait ?? ''}" placeholder="继承(${globalPol.searchWait ?? 1.5})">
                                </div>
                                <div>
                                    <label style="display:block; font-size:0.76rem; color:var(--text-muted); margin-bottom:4px;">enterWait (s)</label>
                                    <input type="number" step="0.1" min="0.4" max="8" id="ov-enter-wait" value="${ov.enterWait ?? ''}" placeholder="继承(${globalPol.enterWait ?? 1.2})">
                                </div>
                                <div>
                                    <label style="display:block; font-size:0.76rem; color:var(--text-muted); margin-bottom:4px;">间隔最小 (s)</label>
                                    <input type="number" step="0.1" min="0" max="30" id="ov-gap-min" value="${ov.studentGapMin ?? ''}" placeholder="继承">
                                </div>
                                <div>
                                    <label style="display:block; font-size:0.76rem; color:var(--text-muted); margin-bottom:4px;">间隔最大 (s)</label>
                                    <input type="number" step="0.1" min="0" max="30" id="ov-gap-max" value="${ov.studentGapMax ?? ''}" placeholder="继承">
                                </div>
                            </div>
                            <div>
                                <label style="display:block; font-size:0.8rem; color:var(--text-secondary); margin-bottom:4px;">定向发送端提醒公告 (仅该电脑可见，留空继承全局)</label>
                                <input type="text" id="ov-notice-msg" maxlength="400" value="${escapeHtml(ov.noticeMessage || '')}" placeholder="例如：您的企微较卡，已为您自动放慢搜索等待至 2.2 秒">
                            </div>
                            <div>
                                <label style="display:block; font-size:0.8rem; color:var(--text-secondary); margin-bottom:4px;">管理员调参备注 (仅后台留痕)</label>
                                <input type="text" id="ov-note" maxlength="200" value="${escapeHtml(cc.note || '')}" placeholder="例如：临时为该老师打开全量截图排查企微切窗问题">
                            </div>
                        </div>
                        <div class="modal-footer" style="display:flex; justify-content:space-between; gap:10px; padding:12px 20px; border-top:1px solid var(--border-color);">
                            <button type="button" class="btn danger-subtle" id="ov-clear-btn">清空覆盖（恢复继承全局）</button>
                            <div style="display:flex; gap:8px;">
                                <button type="button" class="btn secondary" data-close-ov-modal>取消</button>
                                <button type="button" class="btn primary" id="ov-save-btn">保存单机策略</button>
                            </div>
                        </div>
                    </div>
                `;

                const closeFn = () => {
                    if (window.DialogHelper) window.DialogHelper.close(modal);
                    else modal.remove();
                };
                modal.querySelectorAll('[data-close-ov-modal]').forEach(btn => btn.addEventListener('click', closeFn));

                modal.querySelector('#ov-clear-btn')?.addEventListener('click', async () => {
                    const r = await fetch(`${LOG_API}?action=sender_client_override`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ client_slug: clientSlug, clear: true })
                    });
                    const j = await r.json();
                    if (j.success) {
                        showToast('已清空单机策略覆盖，恢复继承全局', 'success');
                        closeFn();
                        loadSenderClients();
                    } else {
                        showToast(j.error || '操作失败', 'error');
                    }
                });

                modal.querySelector('#ov-save-btn')?.addEventListener('click', async () => {
                    const overrides = {};
                    const svcVal = modal.querySelector('#ov-service-enabled')?.value;
                    if (svcVal === '1') overrides.senderServiceEnabled = true;
                    else if (svcVal === '0') overrides.senderServiceEnabled = false;

                    const vmVal = modal.querySelector('#ov-verify-mode')?.value;
                    if (vmVal) overrides.verifyMode = vmVal;

                    const repVal = modal.querySelector('#ov-enable-reply')?.value;
                    if (repVal === '1') overrides.enableReplyAnalysis = true;
                    else if (repVal === '0') overrides.enableReplyAnalysis = false;

                    const calVal = modal.querySelector('#ov-enable-cal')?.value;
                    if (calVal === '1') overrides.enableAutoCalibration = true;
                    else if (calVal === '0') overrides.enableAutoCalibration = false;

                    const bmVal = modal.querySelector('#ov-enable-bm')?.value;
                    if (bmVal === '1') overrides.enableBenchmarkModel = true;
                    else if (bmVal === '0') overrides.enableBenchmarkModel = false;

                    const spVal = modal.querySelector('#ov-snapshot-policy')?.value;
                    if (spVal) overrides.snapshotPolicy = spVal;

                    const bindNum = (sel, key) => {
                        const raw = modal.querySelector(sel)?.value?.trim();
                        if (raw !== '' && !Number.isNaN(parseFloat(raw))) overrides[key] = parseFloat(raw);
                    };
                    bindNum('#ov-search-wait', 'searchWait');
                    bindNum('#ov-enter-wait', 'enterWait');
                    bindNum('#ov-gap-min', 'studentGapMin');
                    bindNum('#ov-gap-max', 'studentGapMax');

                    const nmVal = modal.querySelector('#ov-notice-msg')?.value?.trim();
                    if (nmVal) overrides.noticeMessage = nmVal;

                    const noteVal = modal.querySelector('#ov-note')?.value?.trim() || '';

                    const r = await fetch(`${LOG_API}?action=sender_client_override`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ client_slug: clientSlug, overrides, note: noteVal })
                    });
                    const j = await r.json();
                    if (j.success) {
                        showToast('单机云控策略已保存，将在下次心跳/同步生效', 'success');
                        closeFn();
                        loadSenderClients();
                    } else {
                        showToast(j.error || '保存失败', 'error');
                    }
                });

                document.body.appendChild(modal);
                if (window.DialogHelper) {
                    window.DialogHelper.open(modal, { dismissible: true, removeOnClose: true });
                } else {
                    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
                }
            } catch (err) {
                showToast('打开单机云控弹窗失败: ' + err.message, 'error');
            }
        }


/* ============================================================================
 * [MODULE] teachers.js - 教师账号管理 (loadTeachers, render, resetPassword)
 * ============================================================================ */


/**
 * Admin 教师账号管理模块 (loadTeachers, renderTeachers, openTeacherModal, resetTeacherPassword)
 */

        /* ========================================================
           TAB: Teacher Accounts Logic (独立教师账号管理)
           ======================================================== */
        let teacherCurrentPage = 1;
        let teacherPerPage = 20;
        let teacherSortField = 'id';
        let teacherSortOrder = 'ASC';
        let teacherSelectedIds = new Set();
        let teacherSearchQuery = '';
        let teacherDebounceTimer = null;
        let teacherCacheRecords = [];

        function initTeachersTab() {
            renderTeacherThead();
            loadTeachersData(1);
        }

        function renderTeacherThead() {
            const thead = document.getElementById('teacher-thead');
            if (!thead) return;
            const sortIcon = (f) => teacherSortField === f ? (teacherSortOrder === 'ASC' ? ' ▲' : ' ▼') : '';
            const teacherSortTh = (field, label, titleText, styleAttr) => `
                    <th class="th-sortable" style="${styleAttr}" title="${titleText}">
                        <button type="button" class="th-sort-btn" data-action="teacher-sort" data-arg="${field}">${label}<span style="font-size: 0.72rem; color: var(--primary); margin-left: 2px;">${sortIcon(field)}</span></button>
                    </th>`;
            thead.innerHTML = `
                <tr>
                    <th style="width: 44px; text-align: center;">
                        <input type="checkbox" id="teacher-select-all" data-change="select-all-teachers" aria-label="全选教师" style="accent-color: var(--primary); cursor: pointer;">
                    </th>
                    ${teacherSortTh('id', 'ID', '点击切换按ID正序/倒序', 'width: 80px;')}
                    ${teacherSortTh('username', '登录账号', '点击切换按账号正序/倒序', 'width: 140px;')}
                    ${teacherSortTh('real_name', '教师姓名', '点击切换按姓名正序/倒序', 'width: 170px;')}
                    ${teacherSortTh('status', '账号状态', '点击切换按状态正序/倒序', 'width: 110px;')}
                    ${teacherSortTh('assistant_count', '助教数量', '点击切换按助教数量正序/倒序', 'width: 110px; text-align: center;')}
                    <th style="width: 80px; text-align: right;">快捷操作</th>
                </tr>
            `;
            updateTeacherSelectAllState();
        }

        function setTeacherSort(field) {
            if (teacherSortField === field) {
                teacherSortOrder = teacherSortOrder === 'ASC' ? 'DESC' : 'ASC';
            } else {
                teacherSortField = field;
                teacherSortOrder = 'ASC';
            }
            renderTeacherThead();
            loadTeachersData(1);
        }

        function debounceLoadTeachersData() {
            clearTimeout(teacherDebounceTimer);
            teacherDebounceTimer = setTimeout(() => {
                const input = document.getElementById('teacher-search-input');
                teacherSearchQuery = input ? input.value.trim() : '';
                loadTeachersData(1);
            }, 300);
        }

        function changeTeachersPerPage(val) {
            teacherPerPage = parseInt(val, 10) || 20;
            const sel = document.getElementById('teacher-per-page');
            if (sel && sel.value !== String(teacherPerPage)) sel.value = String(teacherPerPage);
            loadTeachersData(1);
        }

        async function loadTeachersData(page = teacherCurrentPage) {
            teacherCurrentPage = page;
            renderTeacherThead();
            const tbody = document.getElementById('teacher-tbody');
            if (!tbody) return;

            tbody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align: center; padding: 48px; color: var(--text-muted);">
                        <div class="db-empty-state">
                            <div class="spinner" style="margin: 0 auto 12px auto; width: 28px; height: 28px;"></div>
                            <span>正在载入教师账号数据...</span>
                        </div>
                    </td>
                </tr>
            `;

            try {
                const statusVal = document.getElementById('teacher-status-filter')?.value || '';
                let url = `${API_BASE}?action=db_list&table=users&page=${page}&page_size=${teacherPerPage}&per_page=${teacherPerPage}&sort=${teacherSortField}&order=${teacherSortOrder}&sort_field=${teacherSortField}&sort_order=${teacherSortOrder}`;
                if (teacherSearchQuery) url += `&search=${encodeURIComponent(teacherSearchQuery)}`;

                const res = await fetch(url);
                const json = await res.json();

                if (!json.success) {
                    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--error); padding: 30px;">载入失败: ${escapeHtml(json.error || '未知错误')}</td></tr>`;
                    return;
                }

                let records = json.data.records || [];
                teacherCacheRecords = records;

                if (statusVal !== '') {
                    const stInt = parseInt(statusVal, 10);
                    records = records.filter(r => (parseInt(r.status, 10) === stInt) || (stInt === 1 && r.status === undefined));
                }

                const total = json.data.total || records.length;
                const totalPages = json.data.pages || Math.max(1, Math.ceil(total / teacherPerPage));

                const badge = document.getElementById('nav-teachers-badge');
                if (badge) badge.textContent = `${json.data.total || records.length} 人`;

                renderTeacherPagination(teacherCurrentPage, totalPages, total);

                if (records.length === 0) {
                    tbody.innerHTML = `
                        <tr>
                            <td colspan="7" style="text-align: center; padding: 48px; color: var(--text-muted);">
                                <div class="db-empty-state">
                                    <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity: 0.4; margin-bottom: 8px;"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
                                    <div>未找到符合条件的教师账号</div>
                                </div>
                            </td>
                        </tr>
                    `;
                    return;
                }

                tbody.innerHTML = records.map((r, idx) => {
                    const isSelected = teacherSelectedIds.has(r.id);
                    const isEnabled = r.status === undefined || parseInt(r.status, 10) === 1;
                    const displayName = r.real_name || r.username || '未命名教师';
                    const isTest = r.username === '0';
                    const astCount = (r.assistant_count !== undefined) ? parseInt(r.assistant_count, 10) : (Array.isArray(r.assistants) ? r.assistants.length : 0);

                    return `
                        <tr class="${isSelected ? 'selected' : ''}">
                            <td style="text-align: center;">
                                <input type="checkbox" class="teacher-row-cb" data-id="${r.id}" ${isSelected ? 'checked' : ''} onchange="toggleSelectTeacher(${r.id}, this)" style="accent-color: var(--primary); cursor: pointer;">
                            </td>
                            <td class="cell-mono">${r.id}</td>
                            <td>
                                <span style="font-family: var(--font-mono); font-weight: 700; color: #38bdf8;">${escapeHtml(r.username || '-')}</span>
                                ${isTest ? '<span style="margin-left: 6px; font-size: 0.72rem; padding: 1px 6px; background: rgba(239,68,68,0.15); color: #f87171; border-radius: 4px; border: 1px solid rgba(239,68,68,0.3);">系统</span>' : ''}
                            </td>
                            <td>
                                <span style="font-weight: 600; color: var(--text-primary);">${escapeHtml(r.real_name || '-')}</span>
                            </td>
                            <td>
                                ${isEnabled ? `
                                    <span class="badge-status status-badge active" style="font-size: 0.75rem; padding: 2px 8px;">
                                        <span class="dot-indicator green"></span>
                                        正常
                                    </span>
                                ` : `
                                    <span class="badge-status status-badge inactive" style="font-size: 0.75rem; padding: 2px 8px; color: #f87171; border-color: rgba(239,68,68,0.3); background: rgba(239,68,68,0.1);">
                                        <span class="dot-indicator red"></span>
                                        已停用
                                    </span>
                                `}
                            </td>
                            <td style="text-align: center;">
                                ${astCount > 0 ? `
                                    <span style="background: rgba(59,130,246,0.12); color: #3b82f6; border: 1px solid rgba(59,130,246,0.25); font-weight: 700; font-size: 0.78rem; padding: 2px 9px; border-radius: 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" onclick="openTeacherDetailByIndex(${idx})" title="点击查看该教师名下 ${astCount} 位助教">
                                        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle></svg>
                                        <span>${astCount} 人</span>
                                    </span>
                                ` : '<span style="color: var(--text-muted); font-size: 0.8rem;">0 人</span>'}
                            </td>
                            <td style="text-align: right; white-space: nowrap;">
                                <button type="button" class="btn-action detail" onclick="openTeacherDetailByIndex(${idx})" title="查看完整详情">详情</button>
                            </td>
                        </tr>
                    `;
                }).join('');

                updateTeacherBatchDeleteBtn();
                updateTeacherSelectAllState();

            } catch (e) {
                console.error('Failed to load teachers', e);
                tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--error); padding: 30px;">网络请求异常: ${escapeHtml(e.message)}</td></tr>`;
            }
        }

        function toggleSelectAllTeachers(masterCb) {
            const cbs = document.querySelectorAll('.teacher-row-cb');
            cbs.forEach(cb => {
                cb.checked = masterCb.checked;
                const id = parseInt(cb.dataset.id, 10);
                if (masterCb.checked) teacherSelectedIds.add(id);
                else teacherSelectedIds.delete(id);
                cb.closest('tr')?.classList.toggle('selected', masterCb.checked);
            });
            updateTeacherBatchDeleteBtn();
            updateTeacherSelectAllState();
        }

        function toggleSelectTeacher(id, cb) {
            if (cb.checked) teacherSelectedIds.add(id);
            else teacherSelectedIds.delete(id);
            cb.closest('tr')?.classList.toggle('selected', cb.checked);
            updateTeacherBatchDeleteBtn();
            updateTeacherSelectAllState();
        }

        function updateTeacherSelectAllState() {
            const masterCb = document.getElementById('teacher-select-all');
            const rowCbs = document.querySelectorAll('.teacher-row-cb');
            if (!masterCb) return;
            if (rowCbs.length === 0) {
                masterCb.checked = false;
                masterCb.indeterminate = false;
                return;
            }
            const checkedCount = Array.from(rowCbs).filter(cb => cb.checked).length;
            masterCb.checked = checkedCount === rowCbs.length && rowCbs.length > 0;
            masterCb.indeterminate = checkedCount > 0 && checkedCount < rowCbs.length;
        }

        function updateTeacherBatchDeleteBtn() {
            const btn = document.getElementById('teacher-batch-delete-btn');
            const text = document.getElementById('teacher-batch-delete-text');
            if (!btn || !text) return;
            if (teacherSelectedIds.size > 0) {
                btn.style.display = 'inline-flex';
                text.textContent = `批量删除 (${teacherSelectedIds.size})`;
            } else {
                btn.style.display = 'none';
            }
        }

        function openTeacherDetailByIndex(idx) {
            const record = teacherCacheRecords[idx];
            if (record) {
                openDbDetailModal(record, null, 'users');
            } else {
                showToast('未找到该教师记录', 'error');
            }
        }

        async function openTeacherDetailModal(id) {
            try {
                const res = await fetch(`${API_BASE}?action=db_get&table=users&id=${id}`);
                const json = await res.json();
                if (json.success && json.data && json.data.record) {
                    openDbDetailModal(json.data.record, null, 'users');
                } else {
                    showToast(json.error || '获取教师详情失败', 'error');
                }
            } catch (e) {
                showToast('请求异常', 'error');
            }
        }

        async function deleteTeacherRecord(id, name) {
            const confirmed = await showConfirm('删除教师账号', `确定要彻底删除教师「${name}」(#${id}) 吗？此操作不可逆。`, true);
            if (!confirmed) return;
            try {
                const res = await fetch(`${API_BASE}?action=db_delete&table=users&id=${id}`, { method: 'POST' });
                const json = await res.json();
                if (json.success) {
                    showToast(`教师账号「${name}」已删除`, 'success');
                    teacherSelectedIds.delete(id);
                    loadTeachersData();
                    if (typeof loadDbTables === 'function') loadDbTables();
                } else {
                    showToast(json.error || '删除失败', 'error');
                }
            } catch (e) {
                showToast('请求异常', 'error');
            }
        }

        async function batchDeleteTeachers() {
            const count = teacherSelectedIds.size;
            if (count === 0) return;
            const confirmed = await showConfirm('批量删除教师', `确定要彻底删除选中的 ${count} 位教师账号吗？此操作不可逆。`, true);
            if (!confirmed) return;
            const ids = Array.from(teacherSelectedIds);
            try {
                const res = await fetch(`${API_BASE}?action=db_delete&table=users`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids })
                });
                const json = await res.json();
                if (json.success) {
                    showToast(`已删除 ${json.data?.deleted || count} 位教师账号`, 'success');
                    teacherSelectedIds.clear();
                    loadTeachersData();
                    if (typeof loadDbTables === 'function') loadDbTables();
                } else {
                    showToast(json.error || '批量删除失败', 'error');
                }
            } catch (e) {
                showToast('请求异常', 'error');
            }
        }

        function renderTeacherPagination(cur, totalPages, total) {
            const container = document.getElementById('teacher-pagination');
            if (!container) return;
            if (totalPages <= 1 && total <= 0) {
                container.innerHTML = '';
                return;
            }
            container.innerHTML = `
                <div style="font-size:0.88rem; color:var(--text-secondary);">
                    共 <b style="color: var(--text-primary);">${total}</b> 位教师 · 第 <b style="color:var(--primary);">${cur}</b> / ${totalPages || 1} 页
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    ${cur > 1 ? `<button type="button" class="page-btn" onclick="loadTeachersData(${cur - 1})">上一页</button>` : `<button type="button" class="page-btn" disabled>上一页</button>`}
                    ${cur < totalPages ? `<button type="button" class="page-btn" onclick="loadTeachersData(${cur + 1})">下一页</button>` : `<button type="button" class="page-btn" disabled>下一页</button>`}
                </div>
            `;
        }


/* ============================================================================
 * [MODULE] records.js - 学生学情记录 (loadRecords, filter, aggregate)
 * ============================================================================ */


/**
 * Admin 学生学情作业记录模块 (loadRecords, renderRecords, stats, filter)
 */

        /* ========================================================
           TAB: Student Records Logic (学生学情错题独立模块)
           ======================================================== */
        let recCurrentPage = 1;
        let recPerPage = 20;
        let recSortField = 'id';
        let recSortOrder = 'DESC';
        let recSelectedIds = new Set();
        let recViewMode = localStorage.getItem('rec_view_mode') || (window.innerWidth <= 768 ? 'card' : 'table');
        let recDebounceTimer = null;
        let recCurrentRecords = [];

        // 多维多行筛选状态
        let recFilters = {
            teacher: '',
            grade: '',
            tier: '',
            subject: '',
            week: '',
            err: '',
            batch_code: ''
        };
        let recTeacherExpanded = false;

        async function initRecordsTab() {
            applyRecordsViewMode();
            await loadDbBatchOptions();
            loadRecordsStats();
            renderRecordsFilters();
            loadRecordsData(1);
        }

        async function loadRecordsStats() {
            try {
                const res = await fetch(`${API_BASE}?action=student_records_stats`);
                const json = await res.json();
                if (json.success && json.data) {
                    const d = json.data;
                    const elTotal = document.getElementById('rec-stat-total');
                    const elHasErr = document.getElementById('rec-stat-has-err');
                    const elNoErr = document.getElementById('rec-stat-no-err');
                    const elBatches = document.getElementById('rec-stat-batches');
                    const navBadge = document.getElementById('nav-records-badge');
                    if (elTotal) elTotal.textContent = d.total || 0;
                    if (elHasErr) elHasErr.textContent = d.has_err || 0;
                    if (elNoErr) elNoErr.textContent = d.no_err || 0;
                    if (elBatches) elBatches.textContent = d.batches || 0;
                    if (navBadge) navBadge.textContent = `${d.total || 0} 条`;
                    // 异步更新教师账号总数
                    fetch(`${API_BASE}?action=db_list&table=users&page=1&per_page=1`).then(r => r.json()).then(j => {
                        if (j.success && j.data) {
                            const tb = document.getElementById('nav-teachers-badge');
                            if (tb) tb.textContent = `${j.data.total || 0} 人`;
                        }
                    }).catch(() => {});
                }
            } catch (e) {
                console.error('Failed to load records stats', e);
            }
        }

        function setRecFilter(key, val) {
            if (recFilters[key] === val) {
                recFilters[key] = ''; // 再次点击取消选中
            } else {
                recFilters[key] = val;
            }
            renderRecordsFilters();
            loadRecordsData(1);
        }

        function filterByBatchCode(code) {
            if (!code) return;
            if (typeof activeTab !== 'undefined' && activeTab === 'database' && dbCurrentTable === 'student_records') {
                const searchInput = document.getElementById('db-search-input');
                if (searchInput) {
                    searchInput.value = code;
                    loadDbData(1);
                    showToast(`已在数据库中筛选批次：${code}`, 'info', 2000);
                }
            } else {
                if (typeof switchTab === 'function') switchTab('records');
                recFilters.batch_code = (recFilters.batch_code === code) ? '' : code;
                renderRecordsFilters();
                loadRecordsData(1);
                showToast(`已在学情列表中筛选批次：${code}`, 'info', 2000);
            }
        }

        function resetRecordsFilters() {
            recFilters = {
                teacher: '',
                grade: '',
                tier: '',
                subject: '',
                week: '',
                err: '',
                batch_code: ''
            };
            const searchInput = document.getElementById('rec-search-input');
            if (searchInput) searchInput.value = '';
            renderRecordsFilters();
            loadRecordsData(1);
        }

        function toggleTeacherExpand() {
            recTeacherExpanded = !recTeacherExpanded;
            renderRecordsFilters();
        }

        function renderRecordsFilters() {
            const panel = document.getElementById('rec-filter-panel');
            if (!panel) return;

            const hasActiveFilter = Boolean(
                recFilters.teacher || recFilters.grade || recFilters.tier ||
                recFilters.subject || recFilters.week || recFilters.err ||
                recFilters.batch_code ||
                (document.getElementById('rec-search-input')?.value.trim())
            );
            const resetBtn = document.getElementById('rec-reset-filter-btn');
            if (resetBtn) resetBtn.style.display = hasActiveFilter ? 'inline-flex' : 'none';

            // 1. 教师列表
            const teachersList = dbFilterOptions.teachers || [];
            const activeTeacherSet = new Set(dbFilterOptions.active_teachers || []);

            const sortedTeachers = [...teachersList].sort((a, b) => {
                if (a.username === '0') return -1;
                if (b.username === '0') return 1;
                const aHas = activeTeacherSet.has(a.username);
                const bHas = activeTeacherSet.has(b.username);
                if (aHas && !bHas) return -1;
                if (!aHas && bHas) return 1;
                return a.username.localeCompare(b.username, 'en', { numeric: true });
            });

            const visibleTeachers = recTeacherExpanded ? sortedTeachers : sortedTeachers.slice(0, 10);
            const teacherPills = visibleTeachers.map(t => {
                const isActive = recFilters.teacher === t.username;
                const hasRec = activeTeacherSet.has(t.username);
                const label = t.real_name ? `${t.real_name} (${t.username})` : t.username;
                return `
                    <button type="button" class="filter-pill ${isActive ? 'active' : ''}" onclick="setRecFilter('teacher', '${escapeInlineJs(t.username)}')" title="${hasRec ? '该教师有已录入的学情错题' : '暂无学情记录'}">
                        ${escapeHtml(label)}${hasRec ? '<span style="width:6px;height:6px;background:#10b981;border-radius:50%;display:inline-block;margin-left:4px;"></span>' : ''}
                    </button>
                `;
            }).join('');

            const teacherExpandBtn = sortedTeachers.length > 10 ? `
                <button type="button" class="filter-expand-btn" onclick="toggleTeacherExpand()">
                    ${recTeacherExpanded ? '收起 ▴' : `更多教师 (${sortedTeachers.length}位) ▾`}
                </button>
            ` : '';

            const emptyTeacherActive = recFilters.teacher === '__empty__';
            const legacyTeacherPill = `
                <button type="button" class="filter-pill ${emptyTeacherActive ? 'active' : ''}" onclick="setRecFilter('teacher', '__empty__')" title="历史未记录教师工号的数据">
                    历史未归属数据
                </button>
            `;

            // 2. 年级列表
            const rawGrades = dbFilterOptions.grades?.length ? dbFilterOptions.grades : ['七年级', '八年级', '九年级', '高一', '高二', '高三'];
            const gradeOrder = ['七年级', '八年级', '九年级', '高一', '高二', '高三'];
            const gradeList = [...new Set(rawGrades)].sort((a, b) => {
                const ia = gradeOrder.indexOf(a);
                const ib = gradeOrder.indexOf(b);
                if (ia !== -1 && ib !== -1) return ia - ib;
                if (ia !== -1) return -1;
                if (ib !== -1) return 1;
                return a.localeCompare(b, 'zh');
            });
            const gradePills = gradeList.map(g => `
                <button type="button" class="filter-pill ${recFilters.grade === g ? 'active' : ''}" onclick="setRecFilter('grade', '${escapeInlineJs(g)}')">
                    ${escapeHtml(g)}
                </button>
            `).join('');

            // 3. 学科列表
            const rawSubjects = dbFilterOptions.subjects?.length ? dbFilterOptions.subjects : ['物理', '数学', '英语', '化学', '生物'];
            const subjectList = [...new Set(rawSubjects)].sort((a, b) => a.localeCompare(b, 'zh'));
            const subjectPills = subjectList.map(s => `
                <button type="button" class="filter-pill ${recFilters.subject === s ? 'active' : ''}" onclick="setRecFilter('subject', '${escapeInlineJs(s)}')">
                    ${escapeHtml(s)}
                </button>
            `).join('');

            // 4. 班层列表
            const rawTiers = dbFilterOptions.tiers?.length ? dbFilterOptions.tiers : ['S+', 'S', 'A+', 'A', 'U'];
            const tierOrder = ['U', 'S+', 'S', 'A+', 'A', 'B'];
            const tierList = [...new Set(rawTiers)].sort((a, b) => {
                const ia = tierOrder.indexOf(a);
                const ib = tierOrder.indexOf(b);
                if (ia !== -1 && ib !== -1) return ia - ib;
                return a.localeCompare(b, 'zh');
            });
            const tierPills = tierList.map(t => `
                <button type="button" class="filter-pill ${recFilters.tier === t ? 'active' : ''}" onclick="setRecFilter('tier', '${escapeInlineJs(t)}')">
                    ${escapeHtml(t)}层
                </button>
            `).join('');

            // 5. 周次列表
            let weekPills = '';
            for (let w = 1; w <= 16; w++) {
                weekPills += `
                    <button type="button" class="filter-pill ${String(recFilters.week) === String(w) ? 'active' : ''}" onclick="setRecFilter('week', '${w}')">
                        第 ${w} 周
                    </button>
                `;
            }

            panel.innerHTML = `
                <div class="filter-row">
                    <span class="filter-row-label">责任教师：</span>
                    <div class="filter-pills">
                        <button type="button" class="filter-pill ${!recFilters.teacher ? 'active' : ''}" onclick="setRecFilter('teacher', '')">全部教师</button>
                        ${teacherPills}
                        ${teacherExpandBtn}
                        ${legacyTeacherPill}
                    </div>
                </div>

                <div class="filter-row">
                    <span class="filter-row-label">教学年级：</span>
                    <div class="filter-pills">
                        <button type="button" class="filter-pill ${!recFilters.grade ? 'active' : ''}" onclick="setRecFilter('grade', '')">全部年级</button>
                        ${gradePills}
                    </div>
                </div>

                <div class="filter-row">
                    <span class="filter-row-label">教学学科：</span>
                    <div class="filter-pills">
                        <button type="button" class="filter-pill ${!recFilters.subject ? 'active' : ''}" onclick="setRecFilter('subject', '')">全部学科</button>
                        ${subjectPills}
                    </div>
                </div>

                <div class="filter-row">
                    <span class="filter-row-label">班级层级：</span>
                    <div class="filter-pills">
                        <button type="button" class="filter-pill ${!recFilters.tier ? 'active' : ''}" onclick="setRecFilter('tier', '')">全部班层</button>
                        ${tierPills}
                    </div>
                </div>

                <div class="filter-row">
                    <span class="filter-row-label">专题周次：</span>
                    <div class="filter-pills">
                        <button type="button" class="filter-pill ${!recFilters.week ? 'active' : ''}" onclick="setRecFilter('week', '')">全部周次</button>
                        ${weekPills}
                    </div>
                </div>

                ${recFilters.batch_code ? `
                <div class="filter-row" style="background: rgba(99,102,241,0.06); padding: 6px 10px; border-radius: var(--radius-sm); border: 1px dashed rgba(99,102,241,0.3);">
                    <span class="filter-row-label" style="color: #818cf8; font-weight: 600;">生成批次：</span>
                    <div class="filter-pills">
                        <button type="button" class="filter-pill active" onclick="setRecFilter('batch_code', '')" title="点击取消当前批次筛选" style="background: #6366f1; color: #fff; border-color: #6366f1; font-family: var(--font-mono); font-size: 0.8rem; display: inline-flex; align-items: center; gap: 6px;">
                            <span>批次: ${escapeHtml(recFilters.batch_code)}</span>
                            <span style="background: rgba(255,255,255,0.25); border-radius: 50%; width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; line-height: 1;">×</span>
                        </button>
                    </div>
                </div>
                ` : ''}
            `;
        }

        function debounceLoadRecordsData() {
            clearTimeout(recDebounceTimer);
            recDebounceTimer = setTimeout(() => {
                loadRecordsData(1);
            }, 300);
        }

        function changeRecordsPerPage(val) {
            recPerPage = parseInt(val, 10) || 20;
            loadRecordsData(1);
        }

        function setRecordsSort(field) {
            if (recSortField === field) {
                recSortOrder = recSortOrder === 'ASC' ? 'DESC' : 'ASC';
            } else {
                recSortField = field;
                recSortOrder = 'DESC';
            }
            loadRecordsData(recCurrentPage);
        }

        const SVG_VIEW_TABLE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18"/></svg>';
        const SVG_VIEW_CARDS = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>';

        function toggleRecordsViewMode() {
            recViewMode = recViewMode === 'card' ? 'table' : 'card';
            localStorage.setItem('rec_view_mode', recViewMode);
            applyRecordsViewMode();
        }

        function applyRecordsViewMode() {
            const iconEl = document.getElementById('rec-view-mode-icon');
            const textEl = document.getElementById('rec-view-mode-text');
            const tableWrap = document.getElementById('rec-table-wrapper');
            const cardsWrap = document.getElementById('rec-cards-wrapper');
            const btn = document.getElementById('rec-view-mode-btn');

            if (!tableWrap || !cardsWrap) return;

            if (recViewMode === 'card') {
                if (iconEl) iconEl.innerHTML = SVG_VIEW_TABLE;
                if (textEl) textEl.textContent = '表格视图';
                if (btn) btn.title = '切换为表格视图';
                tableWrap.style.display = 'none';
                cardsWrap.style.display = 'grid';
                renderRecordsCards(recCurrentRecords, (recStats && recStats.total) ? recStats.total : recCurrentRecords.length);
            } else {
                if (iconEl) iconEl.innerHTML = SVG_VIEW_CARDS;
                if (textEl) textEl.textContent = '卡片视图';
                if (btn) btn.title = '切换为卡片视图';
                tableWrap.style.display = 'block';
                cardsWrap.style.display = 'none';
                renderRecordsTable(recCurrentRecords);
            }
        }

        function toggleRecordsSelectRow(id, cb) {
            if (cb.checked) {
                recSelectedIds.add(id);
            } else {
                recSelectedIds.delete(id);
            }
            updateRecordsBatchDeleteBtn();
            updateRecordsSelectAllState();
        }

        function toggleSelectAllRecords(checked) {
            recCurrentRecords.forEach(r => {
                if (checked) {
                    recSelectedIds.add(r.id);
                } else {
                    recSelectedIds.delete(r.id);
                }
            });
            document.querySelectorAll('.rec-row-cb').forEach(cb => {
                cb.checked = checked;
            });
            updateRecordsBatchDeleteBtn();
        }

        function updateRecordsSelectAllState() {
            const allCb = document.getElementById('rec-select-all');
            if (!allCb || recCurrentRecords.length === 0) return;
            const allSelected = recCurrentRecords.every(r => recSelectedIds.has(r.id));
            const someSelected = recCurrentRecords.some(r => recSelectedIds.has(r.id));
            allCb.checked = allSelected;
            allCb.indeterminate = someSelected && !allSelected;
        }

        function updateRecordsBatchDeleteBtn() {
            const btn = document.getElementById('rec-batch-delete-btn');
            const countSpan = document.getElementById('rec-selected-count');
            if (!btn) return;
            if (recSelectedIds.size > 0) {
                btn.style.display = 'inline-flex';
                if (countSpan) countSpan.textContent = recSelectedIds.size;
            } else {
                btn.style.display = 'none';
            }
        }

        async function loadRecordsData(page = 1) {
            recCurrentPage = page;
            let searchVal = document.getElementById('rec-search-input')?.value.trim() || '';
            if (searchVal.includes('token=')) {
                const m = searchVal.match(/[?&]token=([a-zA-Z0-9_-]+)/);
                if (m) searchVal = m[1];
            }

            const params = new URLSearchParams({
                action: 'db_list',
                table: 'student_records',
                page: recCurrentPage,
                page_size: recPerPage,
                sort: recSortField,
                order: recSortOrder
            });
            if (searchVal) params.append('search', searchVal);
            if (recFilters.teacher) params.append('created_by', recFilters.teacher);
            if (recFilters.grade) params.append('grade', recFilters.grade);
            if (recFilters.tier) params.append('tier', recFilters.tier);
            if (recFilters.subject) params.append('subject', recFilters.subject);
            if (recFilters.week) params.append('week_num', recFilters.week);
            if (recFilters.err) params.append('has_errors', recFilters.err);
            if (recFilters.batch_code) params.append('batch_code', recFilters.batch_code);

            try {
                const res = await fetch(`${API_BASE}?${params.toString()}`);
                const json = await res.json();
                if (json.success && json.data) {
                    recCurrentRecords = json.data.rows || [];
                    renderRecordsThead();
                    renderRecordsTable(recCurrentRecords);
                    renderRecordsCards(recCurrentRecords, json.data.total);
                    applyRecordsViewMode();
                    renderRecordsPagination(json.data.page, json.data.totalPages, json.data.total);
                    updateRecordsBatchDeleteBtn();
                    updateRecordsSelectAllState();
                } else {
                    showToast(json.error || '加载学情数据失败', 'error');
                }
            } catch (e) {
                console.error('Failed to load student records', e);
                showToast('网络请求失败', 'error');
            }
        }

        function formatRecordErrorBadges(r) {
            let hwErrList = [];
            try {
                if (Array.isArray(r.error_questions)) hwErrList = r.error_questions;
                else if (r.error_questions) hwErrList = JSON.parse(r.error_questions);
            } catch (e) { hwErrList = []; }

            let pvErrList = [];
            try {
                if (Array.isArray(r.preview_error_questions)) pvErrList = r.preview_error_questions;
                else if (r.preview_error_questions) pvErrList = JSON.parse(r.preview_error_questions);
            } catch (e) { pvErrList = []; }

            const hw = (r.homework_score !== null && r.homework_score !== undefined && r.homework_score !== '') ? parseFloat(r.homework_score) : null;
            const tot = (r.total_score !== null && r.total_score !== undefined && r.total_score !== '') ? parseFloat(r.total_score) : null;
            const hwComment = (r.teacher_comment || '').trim();
            const isHwFullScore = (hw !== null && ((tot && hw >= tot && hw > 0) || hw >= 100))
                || /全对|全部正确|满分|零失误|无错题|免除加练/i.test(hwComment);

            const pvScoreVal = (r.preview_score !== null && r.preview_score !== undefined && r.preview_score !== '') ? parseFloat(r.preview_score) : null;
            const isPvFullScore = (pvScoreVal !== null && pvScoreVal >= 100) || /全对|满分|零失误|无错题/i.test(r.preview_comment || '');

            const hasPreview = (r.preview_score !== null && r.preview_score !== undefined && r.preview_score !== '')
                || (r.preview_week_num !== null && r.preview_week_num !== undefined)
                || pvErrList.length > 0
                || (r.preview_comment && r.preview_comment.trim() !== '');

            let hwContent = '';
            if (hwErrList.length > 0) {
                hwContent = `${hwErrList.map(q => `<span class="q-badge">${escapeHtml(String(q))}</span>`).join('')}<span style="font-size:0.75rem; color:var(--text-muted);">(${hwErrList.length}题)</span>`;
            } else if (isHwFullScore) {
                hwContent = `<span class="q-badge-none"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:3px;vertical-align:-1px;"><polyline points="20 6 9 17 4 12"></polyline></svg>全对</span>`;
            } else if (hw !== null) {
                hwContent = `<span class="q-badge-unlisted" title="非满分且未记录具体错题号">未列出</span>`;
            } else {
                hwContent = `<span style="color:var(--text-muted); font-size:0.78rem;">-</span>`;
            }

            let pvContent = '';
            if (pvErrList.length > 0) {
                pvContent = `${pvErrList.map(q => `<span class="q-badge" style="border-color:rgba(245,158,11,0.4); color:#fbbf24;">${escapeHtml(String(q))}</span>`).join('')}<span style="font-size:0.75rem; color:var(--text-muted);">(${pvErrList.length}题)</span>`;
            } else if (isPvFullScore || (hasPreview && pvErrList.length === 0 && pvScoreVal !== null)) {
                pvContent = `<span class="q-badge-none" style="color:#fbbf24; border-color:rgba(245,158,11,0.3); background:rgba(245,158,11,0.1);"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:3px;vertical-align:-1px;"><polyline points="20 6 9 17 4 12"></polyline></svg>全对</span>`;
            } else {
                pvContent = `<span style="color:var(--text-muted); font-size:0.78rem;">-</span>`;
            }

            const hwTag = `<span style="display:inline-block; font-size:0.68rem; font-weight:600; padding:1px 5px; border-radius:4px; background:rgba(56,189,248,0.15); color:#38bdf8; border:1px solid rgba(56,189,248,0.3); flex-shrink:0; line-height:1.3;">巩固</span>`;
            const pvTag = `<span style="display:inline-block; font-size:0.68rem; font-weight:600; padding:1px 5px; border-radius:4px; background:rgba(245,158,11,0.15); color:#f59e0b; border:1px solid rgba(245,158,11,0.3); flex-shrink:0; line-height:1.3;">预习</span>`;

            return `
                <div style="display:flex; flex-direction:column; gap:4px; justify-content:center;">
                    <div style="display:flex; align-items:center; flex-wrap:wrap; gap:3px;">
                        ${hwTag}
                        ${hwContent}
                    </div>
                    <div style="display:flex; align-items:center; flex-wrap:wrap; gap:3px;">
                        ${pvTag}
                        ${pvContent}
                    </div>
                </div>
            `;
        }
        window.formatRecordErrorBadges = formatRecordErrorBadges;

        function formatRecordCommentPreview(r, idx, clickFn = 'openRecordDetailModal') {
            const hwComment = (r.teacher_comment || '').trim();
            const pvComment = (r.preview_comment || '').trim();

            const hwTag = `<span style="display:inline-block; font-size:0.68rem; font-weight:600; padding:1px 5px; border-radius:4px; background:rgba(56,189,248,0.15); color:#38bdf8; border:1px solid rgba(56,189,248,0.3); flex-shrink:0; line-height:1.3;">巩固</span>`;
            const pvTag = `<span style="display:inline-block; font-size:0.68rem; font-weight:600; padding:1px 5px; border-radius:4px; background:rgba(245,158,11,0.15); color:#f59e0b; border:1px solid rgba(245,158,11,0.3); flex-shrink:0; line-height:1.3;">预习</span>`;

            const hwText = hwComment ? escapeHtml(hwComment) : '<span style="color:var(--text-muted);">-</span>';
            const pvText = pvComment ? escapeHtml(pvComment) : '<span style="color:var(--text-muted);">-</span>';

            return `
                <div style="display:flex; flex-direction:column; gap:4px; justify-content:center; max-width:180px;">
                    <div style="display:flex; align-items:center; gap:5px; cursor:pointer;" onclick="${clickFn}(${idx})" title="点击查看完整巩固评语: ${escapeHtml(hwComment || '无')}">
                        ${hwTag}
                        <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-secondary); font-size:0.78rem; flex:1;">
                            ${hwText}
                        </div>
                    </div>
                    <div style="display:flex; align-items:center; gap:5px; cursor:pointer;" onclick="${clickFn}(${idx})" title="点击查看完整预习评语: ${escapeHtml(pvComment || '无')}">
                        ${pvTag}
                        <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#fbbf24; font-size:0.78rem; flex:1;">
                            ${pvText}
                        </div>
                    </div>
                </div>
            `;
        }
        window.formatRecordCommentPreview = formatRecordCommentPreview;

        function renderRecordsThead() {
            const thead = document.getElementById('rec-thead');
            if (!thead) return;
            const sortIcon = (f) => recSortField === f ? (recSortOrder === 'ASC' ? '▲' : '▼') : '';

            const recSortTh = (field, label, styleAttr = '', extraClass = '') => `
                    <th class="th-sortable${extraClass ? ' ' + extraClass : ''} ${recSortField === field ? 'active' : ''}"${styleAttr ? ` style="${styleAttr}"` : ''}><button type="button" class="th-sort-btn" data-action="records-sort" data-arg="${field}">${label} ${sortIcon(field)}</button></th>`;
            thead.innerHTML = `
                <tr>
                    <th style="width: 42px; text-align: center;">
                        <input type="checkbox" id="rec-select-all" data-change="select-all-records" aria-label="全选记录" style="accent-color: var(--primary); cursor: pointer;">
                    </th>
                    ${recSortTh('student_name', '学生姓名', 'width: 125px;')}
                    <th style="width: 165px;">年级 / 班层 / 学科</th>
                    ${recSortTh('week_num', '周次 (巩固/预习)', 'width: 110px;')}
                    ${recSortTh('homework_score', '成绩 (巩固/预习)', 'width: 120px;')}
                    ${recSortTh('error_count', '错题题号 (巩固/预习)', 'width: 185px;')}
                    <th style="width: 180px; max-width: 190px;">评语 (巩固/预习)</th>
                    ${recSortTh('created_by', '责任教师', 'width: 115px;')}
                    ${recSortTh('updated_at', '更改时间', 'width: 100px;', 'cell-mono')}
                    <th style="width: 80px; text-align: right;">快捷操作</th>
                </tr>
            `;
        }

        function renderRecordsTable(records) {
            const tbody = document.getElementById('rec-tbody');
            if (!tbody) return;

            if (!records || records.length === 0) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="10" class="table-empty">
                            <div class="empty-state">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                                    <circle cx="9" cy="7" r="4"></circle>
                                </svg>
                                <span>未检索到匹配的学生学情错题记录</span>
                            </div>
                        </td>
                    </tr>
                `;
                return;
            }

            tbody.innerHTML = records.map((r, idx) => {
                const isSelected = recSelectedIds.has(r.id);
                const errBadges = formatRecordErrorBadges(r);

                const sId = (r.student_id || '').trim();
                const sName = (r.student_name || '').trim();
                const copyIdName = `${sId}${sName}`;
                const gradeVal = r.grade || r._batch?.grade || '-';
                const subjectVal = r.subject || r._batch?.subject || '-';
                const tierVal = r.tier || r._batch?.tier || '-';

                const commentPreview = formatRecordCommentPreview(r, idx, 'openRecordDetailModal');

                const hwScoreDisplay = (r.homework_score !== null && r.homework_score !== undefined && r.homework_score !== '') ? formatScore(r.homework_score) : '-';
                const pvScoreDisplay = (r.preview_score !== null && r.preview_score !== undefined && r.preview_score !== '') ? formatScore(r.preview_score) : null;

                const hwTag = `<span style="display:inline-block; font-size:0.68rem; font-weight:600; padding:1px 5px; border-radius:4px; background:rgba(56,189,248,0.15); color:#38bdf8; border:1px solid rgba(56,189,248,0.3); flex-shrink:0; line-height:1.3;">巩固</span>`;
                const pvTag = `<span style="display:inline-block; font-size:0.68rem; font-weight:600; padding:1px 5px; border-radius:4px; background:rgba(245,158,11,0.15); color:#f59e0b; border:1px solid rgba(245,158,11,0.3); flex-shrink:0; line-height:1.3;">预习</span>`;

                return `
                    <tr>
                        <td style="text-align: center;">
                            <input type="checkbox" class="rec-row-cb" data-id="${r.id}" ${isSelected ? 'checked' : ''} onchange="toggleRecordsSelectRow(${r.id}, this)" style="accent-color: var(--primary); cursor: pointer;">
                        </td>
                        <td>
                            <div class="student-profile-chip" onclick="copyStudentIdName('${escapeInlineJs(copyIdName)}')" title="点击复制：${escapeHtml(copyIdName)}">
                                <div>
                                    <div class="student-name-text">
                                        ${escapeHtml(r.student_name || '-')}
                                        <svg class="copy-icon-subtle" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="width: 12px; height: 12px; flex-shrink: 0;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg>
                                    </div>
                                    <div class="student-id-sub">${escapeHtml(r.student_id || '-')}</div>
                                </div>
                            </div>
                        </td>
                        <td style="white-space: nowrap;">
                            <span style="font-weight:600; color: var(--text-secondary);">${escapeHtml(gradeVal)}</span> · 
                            <b style="color:#a78bfa;">${escapeHtml(subjectVal)}</b> · 
                            <span style="background:rgba(255,255,255,0.08); padding:2px 7px; border-radius:4px; font-size:0.8rem; font-weight:600; color: var(--text-secondary);">${escapeHtml(tierVal)}</span>
                        </td>
                        <td style="white-space: nowrap;">
                            <div style="display:flex; flex-direction:column; gap:4px; justify-content:center;">
                                <div style="display:flex; align-items:center; gap:5px;">
                                    ${hwTag}
                                    <span style="font-weight:700; color:#93c5fd; font-family:var(--font-mono); font-size:0.92rem;">第${r.week_num ?? '-'}周</span>
                                </div>
                                <div style="display:flex; align-items:center; gap:5px;">
                                    ${pvTag}
                                    <span style="font-weight:600; color:#fbbf24; font-family:var(--font-mono); font-size:0.88rem;">${(r.preview_week_num !== null && r.preview_week_num !== undefined && r.preview_week_num !== '') ? `第${r.preview_week_num}周` : '-'}</span>
                                </div>
                            </div>
                        </td>
                        <td style="white-space: nowrap;">
                            <div style="display:flex; flex-direction:column; gap:4px; justify-content:center;">
                                <div style="display:flex; align-items:center; gap:5px;">
                                    ${hwTag}
                                    <span style="font-weight:700; color:#38bdf8; font-family:var(--font-mono); font-size:0.95rem;">${hwScoreDisplay}${hwScoreDisplay !== '-' ? '分' : ''}</span>
                                </div>
                                <div style="display:flex; align-items:center; gap:5px;">
                                    ${pvTag}
                                    <span style="font-weight:600; color:#f59e0b; font-family:var(--font-mono); font-size:0.92rem;">${pvScoreDisplay !== null ? `${pvScoreDisplay}分` : '-'}</span>
                                </div>
                            </div>
                        </td>
                        <td>${errBadges}</td>
                        <td>${commentPreview}</td>
                        <td>
                            ${r.created_by ? renderCreatorCell(r, false) : '<span style="color:var(--text-muted); font-size:0.75rem;">-</span>'}
                        </td>
                        <td class="cell-mono" style="font-size:0.8rem; color:var(--text-secondary);" title="最后更改: ${formatTimestamp(r.updated_at || r.created_at)}\n首次录入: ${formatTimestamp(r.created_at)}">${formatTimestamp(r.updated_at || r.created_at, true)}</td>
                        <td style="text-align: right; white-space: nowrap;">
                            <button type="button" class="btn-action detail" onclick="openRecordDetailModal(${idx})" title="查看完整详情">详情</button>
                        </td>
                    </tr>
                `;
            }).join('');
        }

        function renderRecordsCards(records, total) {
            const wrapper = document.getElementById('rec-cards-wrapper');
            if (!wrapper) return;

            if (!records || records.length === 0) {
                wrapper.innerHTML = `
                    <div class="empty-state" style="padding: 40px; text-align: center;">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:48px;height:48px;margin:0 auto 12px;opacity:0.4;">
                            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                            <circle cx="9" cy="7" r="4"></circle>
                        </svg>
                        <div style="color:var(--text-secondary);">暂无学情记录</div>
                    </div>
                `;
                return;
            }

            wrapper.innerHTML = records.map((r, idx) => {
                const isSelected = recSelectedIds.has(r.id);
                const errBadges = formatRecordErrorBadges(r);

                const sId = (r.student_id || '').trim();
                const sName = (r.student_name || '').trim();
                const copyIdName = `${sId}${sName}`;
                const gradeVal = r.grade || r._batch?.grade || '-';
                const subjectVal = r.subject || r._batch?.subject || '-';
                const tierVal = r.tier || r._batch?.tier || '-';

                const hwScoreDisplay = (r.homework_score !== null && r.homework_score !== undefined && r.homework_score !== '') ? formatScore(r.homework_score) : '-';
                const pvScoreDisplay = (r.preview_score !== null && r.preview_score !== undefined && r.preview_score !== '') ? formatScore(r.preview_score) : null;
                const hasPreviewWeek = r.preview_week_num && r.preview_week_num != r.week_num;

                return `
                    <div class="db-card-item ${isSelected ? 'selected' : ''}" data-id="${r.id}">
                        <div class="db-card-head">
                            <div class="db-card-head-left">
                                <input type="checkbox" class="rec-row-cb" data-id="${r.id}" ${isSelected ? 'checked' : ''} onchange="toggleRecordsSelectRow(${r.id}, this)" style="accent-color: var(--primary); cursor: pointer; width: 17px; height: 17px;">
                                <div class="student-profile-chip" onclick="copyStudentIdName('${escapeInlineJs(copyIdName)}')" title="点击复制：${escapeHtml(copyIdName)}">
                                    <div>
                                        <div class="student-name-text">
                                            ${escapeHtml(r.student_name || '-')}
                                            <svg class="copy-icon-subtle" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="width: 12px; height: 12px; flex-shrink: 0;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg>
                                        </div>
                                        <div class="student-id-sub">${escapeHtml(r.student_id || '-')}</div>
                                    </div>
                                </div>
                            </div>
                            <div class="db-card-head-right">
                                <div style="display:flex; flex-direction:column; gap:3px; align-items:flex-end;">
                                    <span class="db-card-week-badge" title="课后巩固周次: 第${r.week_num ?? '-'}周" style="font-size:0.75rem; background:rgba(56,189,248,0.15); color:#38bdf8; border-color:rgba(56,189,248,0.3);">巩固: 第${r.week_num ?? '-'}周</span>
                                    <span class="db-card-week-badge" title="课前预习周次: 第${r.preview_week_num ?? '-'}周" style="font-size:0.75rem; background:rgba(245,158,11,0.15); color:#f59e0b; border-color:rgba(245,158,11,0.3);">预习: 第${r.preview_week_num ?? '-'}周</span>
                                </div>
                            </div>
                        </div>

                        <div class="db-card-meta-grid">
                            <div class="db-card-meta-cell">
                                <span class="db-card-meta-label">年级 / 学科 / 班层</span>
                                <span style="font-size:0.88rem;">
                                    ${escapeHtml(gradeVal)} · <b style="color:#a78bfa;">${escapeHtml(subjectVal)}</b> · 
                                    <span style="background:rgba(255,255,255,0.08); padding:1px 6px; border-radius:4px; font-size:0.78rem; font-weight:600;">${escapeHtml(tierVal)}</span>
                                </span>
                            </div>
                            <div class="db-card-meta-cell">
                                <span class="db-card-meta-label">成绩 (巩固 / 预习)</span>
                                <div style="display:flex; align-items:center; gap:6px;">
                                    <span style="font-size:0.68rem; font-weight:600; padding:1px 4px; border-radius:3px; background:rgba(56,189,248,0.15); color:#38bdf8; border:1px solid rgba(56,189,248,0.3);">巩固</span>
                                    <b style="color:#38bdf8; font-family:var(--font-mono); font-size:1.02rem;">${hwScoreDisplay}${hwScoreDisplay !== '-' ? '分' : ''}</b>
                                    <span style="color:var(--text-muted); font-size:0.78rem; margin:0 2px;">/</span>
                                    <span style="font-size:0.68rem; font-weight:600; padding:1px 4px; border-radius:3px; background:rgba(245,158,11,0.15); color:#f59e0b; border:1px solid rgba(245,158,11,0.3);">预习</span>
                                    <b style="color:#f59e0b; font-family:var(--font-mono); font-size:0.95rem;">${pvScoreDisplay !== null ? `${pvScoreDisplay}分` : '-'}</b>
                                </div>
                            </div>
                            <div class="db-card-meta-cell">
                                <span class="db-card-meta-label">责任教师</span>
                                <span style="font-weight:600; color:var(--text-primary); font-size:0.85rem;">${r.created_by ? renderCreatorCell(r, true) : '-'}</span>
                            </div>
                            <div class="db-card-meta-cell">
                                <span class="db-card-meta-label">首次录入时间</span>
                                <span style="font-size:0.8rem; color:var(--text-secondary); font-family:var(--font-mono);" title="首次录入时间: ${formatTimestamp(r.created_at)}">${formatTimestamp(r.created_at, true)}</span>
                            </div>
                            <div class="db-card-meta-cell full-width">
                                <span class="db-card-meta-label">错题情况 (巩固 / 预习)</span>
                                <div style="display:flex; align-items:center; flex-wrap:wrap; gap:4px;">${errBadges}</div>
                            </div>
                        </div>

                        ${r.teacher_comment ? `
                        <div class="db-card-comment" onclick="openRecordDetailModal(${idx})" title="点击查看完整巩固评语">
                            <span class="db-card-comment-icon"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></span>
                            <span class="db-card-comment-body"><b style="color:#38bdf8; font-weight:600;">[巩固评语]</b> ${escapeHtml(r.teacher_comment)}</span>
                        </div>` : ''}

                        ${r.preview_comment ? `
                        <div class="db-card-comment" onclick="openRecordDetailModal(${idx})" title="点击查看完整预习评语" style="border-left: 3px solid #f59e0b; margin-top: 4px;">
                            <span class="db-card-comment-icon" style="color:#f59e0b;"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg></span>
                            <span class="db-card-comment-body"><b style="color:#f59e0b; font-weight:600;">[预习评语]</b> ${escapeHtml(r.preview_comment)}</span>
                        </div>` : ''}

                        <div class="db-card-footer">
                            <span class="db-card-time" title="最后更改: ${formatTimestamp(r.updated_at || r.created_at)}\n首次录入: ${formatTimestamp(r.created_at)}">${formatTimestamp(r.updated_at || r.created_at, true)}</span>
                            <div class="db-card-btns">
                                <button type="button" class="btn-action detail" onclick="openRecordDetailModal(${idx})" title="查看完整详情">详情</button>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        }

        function renderRecordsPagination(page, totalPages, total) {
            const container = document.getElementById('rec-pagination');
            if (!container) return;
            if (totalPages <= 1 && total <= 0) { container.innerHTML = ''; return; }

            container.innerHTML = `
                <div style="font-size:0.88rem; color:var(--text-secondary);">
                    共 <b style="color: var(--text-primary);">${total}</b> 条学情记录 · 第 <b style="color:var(--primary);">${page}</b> / ${totalPages || 1} 页
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    ${page > 1 ? `<button class="page-btn" onclick="loadRecordsData(${page - 1})">上一页</button>` : `<button class="page-btn" disabled>上一页</button>`}
                    <span style="font-size:0.88rem; font-weight:600; color: var(--text-primary); padding:0 6px;">${page}</span>
                    ${page < totalPages ? `<button class="page-btn" onclick="loadRecordsData(${page + 1})">下一页</button>` : `<button class="page-btn" disabled>下一页</button>`}
                </div>
            `;
        }

        function openRecordCreateModal() {
            openDbRecordModal(null, 'student_records');
        }

        function openRecordEditModal(id) {
            openDbRecordModal(id, 'student_records');
        }

        function openRecordDetailModal(idx) {
            openDbDetailModal(idx, recCurrentRecords, 'student_records');
        }

        async function deleteRecordDirect(id) {
            const ok = await showConfirm('删除学情记录', '确定删除该学生的学情记录吗？此操作不可恢复。', true);
            if (!ok) return;
            try {
                const res = await fetch(`${API_BASE}?action=db_delete&table=student_records&id=${id}`, { method: 'POST' });
                const json = await res.json();
                if (json.success) {
                    showToast('学情记录已删除', 'success');
                    recSelectedIds.delete(id);
                    loadRecordsStats();
                    loadRecordsData(recCurrentPage);
                } else {
                    showToast(json.error || '删除失败', 'error');
                }
            } catch (e) {
                showToast('网络请求失败', 'error');
            }
        }

        async function batchDeleteRecords() {
            if (recSelectedIds.size === 0) return;
            const ok = await showConfirm('批量删除学情记录', `确定删除选中的 ${recSelectedIds.size} 条学生学情记录吗？此操作不可撤销。`, true);
            if (!ok) return;
            try {
                const ids = Array.from(recSelectedIds);
                const res = await fetch(`${API_BASE}?action=db_delete&table=student_records`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids })
                });
                const json = await res.json();
                if (json.success) {
                    showToast(`已成功删除 ${json.data?.deleted || ids.length} 条记录`, 'success');
                    recSelectedIds.clear();
                    loadRecordsStats();
                    loadRecordsData(recCurrentPage);
                } else {
                    showToast(json.error || '批量删除失败', 'error');
                }
            } catch (e) {
                showToast('网络请求失败', 'error');
            }
        }


/* ============================================================================
 * [MODULE] batches.js - 生成批次记录独立视图 (generation_batches 列表/筛选/删除/跳转学情)
 * ============================================================================ */


/**
 * Admin 生成批次记录模块 (generation_batches 独立视图)
 * 后端复用通用 db_list / db_delete，无需新增接口。
 */

        /* ========================================================
           TAB: Generation Batches Logic (生成批次独立模块)
           ======================================================== */
        let batCurrentPage = 1;
        let batPerPage = 20;
        let batSortField = 'id';
        let batSortOrder = 'DESC';
        let batSelectedIds = new Set();
        let batDebounceTimer = null;
        let batCurrentRows = [];

        // 筛选状态（维度含义与学情页一致，经 class_id 关联过滤）
        let batFilters = {
            teacher: '',
            grade: '',
            tier: '',
            subject: '',
            week: ''
        };

        async function initBatchesTab() {
            if (typeof loadDbBatchOptions === 'function') {
                await loadDbBatchOptions();
            }
            renderBatchesFilters();
            loadBatchesData(1);
        }

        function setBatFilter(key, val) {
            if (batFilters[key] === val) {
                batFilters[key] = ''; // 再次点击取消选中
            } else {
                batFilters[key] = val;
            }
            renderBatchesFilters();
            loadBatchesData(1);
        }

        function resetBatchesFilters() {
            batFilters = {
                teacher: '',
                grade: '',
                tier: '',
                subject: '',
                week: ''
            };
            const searchInput = document.getElementById('bat-search-input');
            if (searchInput) searchInput.value = '';
            renderBatchesFilters();
            loadBatchesData(1);
        }

        function renderBatchesFilters() {
            const panel = document.getElementById('bat-filter-panel');
            if (!panel) return;

            const hasActiveFilter = Boolean(
                batFilters.teacher || batFilters.grade || batFilters.tier ||
                batFilters.subject || batFilters.week ||
                (document.getElementById('bat-search-input')?.value.trim())
            );
            const resetBtn = document.getElementById('bat-reset-filter-btn');
            if (resetBtn) resetBtn.style.display = hasActiveFilter ? 'inline-flex' : 'none';

            const teachersList = (typeof dbFilterOptions !== 'undefined' && dbFilterOptions.teachers) || [];
            const teacherPills = teachersList.map(t => {
                const isActive = batFilters.teacher === t.username;
                const label = t.real_name ? `${t.real_name} (${t.username})` : t.username;
                return `
                    <button type="button" class="filter-pill ${isActive ? 'active' : ''}" onclick="setBatFilter('teacher', '${escapeHtml(t.username)}')">
                        ${escapeHtml(label)}
                    </button>
                `;
            }).join('');

            const gradeList = ((typeof dbFilterOptions !== 'undefined' && dbFilterOptions.grades) || []).filter(Boolean);
            const gradePills = gradeList.map(g => `
                <button type="button" class="filter-pill ${batFilters.grade === g ? 'active' : ''}" onclick="setBatFilter('grade', '${escapeHtml(g)}')">
                    ${escapeHtml(g)}
                </button>
            `).join('');

            const subjectList = ((typeof dbFilterOptions !== 'undefined' && dbFilterOptions.subjects) || []).filter(Boolean);
            const subjectPills = subjectList.map(s => `
                <button type="button" class="filter-pill ${batFilters.subject === s ? 'active' : ''}" onclick="setBatFilter('subject', '${escapeHtml(s)}')">
                    ${escapeHtml(s)}
                </button>
            `).join('');

            const tierList = ((typeof dbFilterOptions !== 'undefined' && dbFilterOptions.tiers) || []).filter(Boolean);
            const tierPills = tierList.map(t => `
                <button type="button" class="filter-pill ${batFilters.tier === t ? 'active' : ''}" onclick="setBatFilter('tier', '${escapeHtml(t)}')">
                    ${escapeHtml(t)}层
                </button>
            `).join('');

            let weekPills = '';
            for (let w = 1; w <= 16; w++) {
                weekPills += `
                    <button type="button" class="filter-pill ${String(batFilters.week) === String(w) ? 'active' : ''}" onclick="setBatFilter('week', '${w}')">
                        第 ${w} 周
                    </button>
                `;
            }

            panel.innerHTML = `
                <div class="filter-row">
                    <span class="filter-row-label">责任教师：</span>
                    <div class="filter-pills">
                        <button type="button" class="filter-pill ${!batFilters.teacher ? 'active' : ''}" onclick="setBatFilter('teacher', '')">全部教师</button>
                        ${teacherPills}
                    </div>
                </div>

                <div class="filter-row">
                    <span class="filter-row-label">教学年级：</span>
                    <div class="filter-pills">
                        <button type="button" class="filter-pill ${!batFilters.grade ? 'active' : ''}" onclick="setBatFilter('grade', '')">全部年级</button>
                        ${gradePills}
                    </div>
                </div>

                <div class="filter-row">
                    <span class="filter-row-label">教学学科：</span>
                    <div class="filter-pills">
                        <button type="button" class="filter-pill ${!batFilters.subject ? 'active' : ''}" onclick="setBatFilter('subject', '')">全部学科</button>
                        ${subjectPills}
                    </div>
                </div>

                <div class="filter-row">
                    <span class="filter-row-label">班级层级：</span>
                    <div class="filter-pills">
                        <button type="button" class="filter-pill ${!batFilters.tier ? 'active' : ''}" onclick="setBatFilter('tier', '')">全部班层</button>
                        ${tierPills}
                    </div>
                </div>

                <div class="filter-row">
                    <span class="filter-row-label">专题周次：</span>
                    <div class="filter-pills">
                        <button type="button" class="filter-pill ${!batFilters.week ? 'active' : ''}" onclick="setBatFilter('week', '')">全部周次</button>
                        ${weekPills}
                    </div>
                </div>
            `;
        }

        function debounceLoadBatchesData() {
            clearTimeout(batDebounceTimer);
            batDebounceTimer = setTimeout(() => {
                loadBatchesData(1);
            }, 300);
        }

        function changeBatchesPerPage(val) {
            batPerPage = parseInt(val, 10) || 20;
            loadBatchesData(1);
        }

        function setBatchesSort(field) {
            if (batSortField === field) {
                batSortOrder = batSortOrder === 'ASC' ? 'DESC' : 'ASC';
            } else {
                batSortField = field;
                batSortOrder = 'DESC';
            }
            loadBatchesData(batCurrentPage);
        }

        function toggleBatchesSelectRow(id, cb) {
            if (cb.checked) {
                batSelectedIds.add(id);
            } else {
                batSelectedIds.delete(id);
            }
            updateBatchesBatchDeleteBtn();
            updateBatchesSelectAllState();
        }

        function toggleSelectAllBatches(checked) {
            batCurrentRows.forEach(r => {
                if (checked) {
                    batSelectedIds.add(r.id);
                } else {
                    batSelectedIds.delete(r.id);
                }
            });
            document.querySelectorAll('.bat-row-cb').forEach(cb => {
                cb.checked = checked;
            });
            updateBatchesBatchDeleteBtn();
        }

        function updateBatchesSelectAllState() {
            const allCb = document.getElementById('bat-select-all');
            if (!allCb || batCurrentRows.length === 0) return;
            const allSelected = batCurrentRows.every(r => batSelectedIds.has(r.id));
            const someSelected = batCurrentRows.some(r => batSelectedIds.has(r.id));
            allCb.checked = allSelected;
            allCb.indeterminate = someSelected && !allSelected;
        }

        function updateBatchesBatchDeleteBtn() {
            const btn = document.getElementById('bat-batch-delete-btn');
            const countSpan = document.getElementById('bat-selected-count');
            if (!btn) return;
            if (batSelectedIds.size > 0) {
                btn.style.display = 'inline-flex';
                if (countSpan) countSpan.textContent = batSelectedIds.size;
            } else {
                btn.style.display = 'none';
            }
        }

        async function loadBatchesData(page = 1) {
            batCurrentPage = page;
            const searchVal = document.getElementById('bat-search-input')?.value.trim() || '';

            const params = new URLSearchParams({
                action: 'db_list',
                table: 'generation_batches',
                page: batCurrentPage,
                page_size: batPerPage,
                sort: batSortField,
                order: batSortOrder
            });
            if (searchVal) params.append('search', searchVal);
            if (batFilters.teacher) params.append('created_by', batFilters.teacher);
            if (batFilters.grade) params.append('grade', batFilters.grade);
            if (batFilters.tier) params.append('tier', batFilters.tier);
            if (batFilters.subject) params.append('subject', batFilters.subject);
            if (batFilters.week) params.append('week_num', batFilters.week);

            try {
                const res = await fetch(`${API_BASE}?${params.toString()}`);
                const json = await res.json();
                if (json.success && json.data) {
                    batCurrentRows = json.data.rows || [];
                    renderBatchesThead();
                    renderBatchesTable(batCurrentRows);
                    renderBatchesPagination(json.data.page, json.data.totalPages, json.data.total);
                    updateBatchesBatchDeleteBtn();
                    updateBatchesSelectAllState();
                    const navBadge = document.getElementById('nav-batches-badge');
                    if (navBadge) navBadge.textContent = `${json.data.total || 0} 批`;
                } else {
                    showToast(json.error || '加载生成批次失败', 'error');
                }
            } catch (e) {
                console.error('Failed to load generation batches', e);
                showToast('网络请求失败', 'error');
            }
        }

        function renderBatchesThead() {
            const thead = document.getElementById('bat-thead');
            if (!thead) return;
            const sortIcon = (f) => batSortField === f ? (batSortOrder === 'ASC' ? '▲' : '▼') : '';

            const batSortTh = (field, label, styleAttr = '', extraClass = '') => `
                    <th class="th-sortable${extraClass ? ' ' + extraClass : ''}"${styleAttr ? ` style="${styleAttr}"` : ''}><button type="button" class="th-sort-btn" data-action="batches-sort" data-arg="${field}">${label} ${sortIcon(field)}</button></th>`;
            thead.innerHTML = `
                <tr>
                    <th style="width: 42px; text-align: center;">
                        <input type="checkbox" id="bat-select-all" data-change="select-all-batches" aria-label="全选批次" style="accent-color: var(--primary); cursor: pointer;">
                    </th>
                    ${batSortTh('batch_code', '批次编号', 'width: 200px;', 'cell-mono')}
                    <th style="width: 200px;">班级 / 学科</th>
                    ${batSortTh('week_num', '周次', 'width: 75px; text-align: center;')}
                    ${batSortTh('student_count', '学生数', 'width: 90px; text-align: center;')}
                    ${batSortTh('error_student_count', '有错题', 'width: 90px; text-align: center;')}
                    ${batSortTh('created_by', '责任教师', 'width: 115px;')}
                    ${batSortTh('created_at', '生成时间', 'width: 150px;', 'cell-mono')}
                    <th style="width: 150px; text-align: right;">快捷操作</th>
                </tr>
            `;
        }

        function renderBatchesTable(rows) {
            const tbody = document.getElementById('bat-tbody');
            if (!tbody) return;

            if (!rows || rows.length === 0) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="9" class="table-empty">
                            <div class="empty-state">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
                                    <polyline points="17 21 17 13 7 13 7 21"></polyline>
                                    <polyline points="7 3 7 8 15 8"></polyline>
                                </svg>
                                <span>未检索到匹配的生成批次记录</span>
                            </div>
                        </td>
                    </tr>
                `;
                return;
            }

            tbody.innerHTML = rows.map((r) => {
                const isSelected = batSelectedIds.has(r.id);
                const batchCode = r.batch_code || '-';
                const className = r.class_name || r._batch?.class_name || '-';
                const gradeVal = r._batch?.grade || '-';
                const subjectVal = r._batch?.subject || '-';
                const tierVal = r._batch?.tier || '-';

                return `
                    <tr>
                        <td style="text-align: center;">
                            <input type="checkbox" class="bat-row-cb" data-id="${r.id}" ${isSelected ? 'checked' : ''} onchange="toggleBatchesSelectRow(${r.id}, this)" style="accent-color: var(--primary); cursor: pointer;">
                        </td>
                        <td class="cell-mono" style="font-size: 0.8rem;" title="${escapeHtml(batchCode)}">
                            <span style="cursor: pointer; color: var(--text-primary);" onclick="jumpToBatchRecords('${escapeHtml(batchCode)}')" title="点击查看该批次的学情记录">${escapeHtml(batchCode)}</span>
                        </td>
                        <td style="white-space: nowrap;">
                            <div style="font-weight: 600; color: var(--text-primary); font-size: 0.85rem;">${escapeHtml(className)}</div>
                            <div style="font-size: 0.75rem; color: var(--text-secondary);">${escapeHtml(gradeVal)} · <b style="color:#a78bfa;">${escapeHtml(subjectVal)}</b> · ${escapeHtml(tierVal)}</div>
                        </td>
                        <td style="text-align: center;"><span style="font-weight:700; color:#93c5fd; font-family:var(--font-mono); font-size:0.95rem;">${r.week_num ?? '-'}</span></td>
                        <td style="text-align: center;"><span style="font-weight: 700; font-family: var(--font-mono);">${r.student_count ?? '-'}</span></td>
                        <td style="text-align: center;"><span style="font-weight: 700; color: #f87171; font-family: var(--font-mono);">${r.error_student_count ?? '-'}</span></td>
                        <td>
                            ${r.created_by ? renderCreatorCell(r, false) : '<span style="color:var(--text-muted); font-size:0.75rem;">-</span>'}
                        </td>
                        <td class="cell-mono" style="font-size:0.8rem; color:var(--text-secondary);">${formatTimestamp(r.created_at)}</td>
                        <td style="text-align: right; white-space: nowrap;">
                            <button type="button" class="btn-action detail" onclick="jumpToBatchRecords('${escapeHtml(batchCode)}')" title="查看该批次的学情记录">学情</button>
                            <button type="button" class="btn-action danger" onclick="deleteBatchDirect(${r.id}, '${escapeHtml(batchCode)}')" title="删除该批次记录（不影响学情数据）">删除</button>
                        </td>
                    </tr>
                `;
            }).join('');
        }

        function renderBatchesPagination(page, totalPages, total) {
            const container = document.getElementById('bat-pagination');
            if (!container) return;
            if (totalPages <= 1 && total <= 0) { container.innerHTML = ''; return; }

            container.innerHTML = `
                <div style="font-size:0.88rem; color:var(--text-secondary);">
                    共 <b style="color: var(--text-primary);">${total}</b> 个生成批次 · 第 <b style="color:var(--primary);">${page}</b> / ${totalPages || 1} 页
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    ${page > 1 ? `<button class="page-btn" onclick="loadBatchesData(${page - 1})">上一页</button>` : `<button class="page-btn" disabled>上一页</button>`}
                    <span style="font-size:0.88rem; font-weight:600; color: var(--text-primary); padding:0 6px;">${page}</span>
                    ${page < totalPages ? `<button class="page-btn" onclick="loadBatchesData(${page + 1})">下一页</button>` : `<button class="page-btn" disabled>下一页</button>`}
                </div>
            `;
        }

        // 跳转到学情页并按批次编号筛选（复用学情模块的筛选器）
        function jumpToBatchRecords(batchCode) {
            if (!batchCode || batchCode === '-') return;
            if (typeof switchTab === 'function') switchTab('records');
            if (typeof recFilters !== 'undefined') {
                recFilters.batch_code = (typeof recFilters.batch_code !== 'undefined' && recFilters.batch_code === batchCode) ? '' : batchCode;
            }
            if (typeof renderRecordsFilters === 'function') renderRecordsFilters();
            if (typeof loadRecordsData === 'function') loadRecordsData(1);
            if (typeof showToast === 'function') showToast(`已在学情列表中筛选批次：${batchCode}`, 'info', 2000);
        }

        async function deleteBatchDirect(id, batchCode) {
            const ok = await showConfirm('删除生成批次', `确定删除批次 ${batchCode || ('#' + id)} 吗？\n仅删除批次汇总记录，不影响学生学情数据，此操作不可恢复。`, true);
            if (!ok) return;
            try {
                const res = await fetch(`${API_BASE}?action=db_delete&table=generation_batches&id=${id}`, { method: 'POST' });
                const json = await res.json();
                if (json.success) {
                    showToast('生成批次已删除', 'success');
                    batSelectedIds.delete(id);
                    loadBatchesData(batCurrentPage);
                } else {
                    showToast(json.error || '删除失败', 'error');
                }
            } catch (e) {
                showToast('网络请求失败', 'error');
            }
        }

        async function batchDeleteBatches() {
            if (batSelectedIds.size === 0) return;
            const ok = await showConfirm('批量删除生成批次', `确定删除选中的 ${batSelectedIds.size} 个生成批次吗？\n仅删除批次汇总记录，不影响学生学情数据，此操作不可撤销。`, true);
            if (!ok) return;
            try {
                const ids = Array.from(batSelectedIds);
                const res = await fetch(`${API_BASE}?action=db_delete&table=generation_batches`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids })
                });
                const json = await res.json();
                if (json.success) {
                    showToast(`已成功删除 ${json.data?.deleted || ids.length} 个批次`, 'success');
                    batSelectedIds.clear();
                    loadBatchesData(batCurrentPage);
                } else {
                    showToast(json.error || '批量删除失败', 'error');
                }
            } catch (e) {
                showToast('网络请求失败', 'error');
            }
        }


/* ============================================================================
 * [MODULE] database.js - Tab 3: 底层数据库通用 CRUD 与版本回滚
 * ============================================================================ */


/**
 * Admin 底层数据库管理模块 (Tab 3: Schema, CRUD Modal, Batch, History, Rollback)
 */

        /* ========================================================
           TAB 3: Database Management Logic
           ======================================================== */
        let dbCurrentTable = 'student_records';
        let dbTables = [];
        let dbCurrentPage = 1;
        let dbPerPage = 20;
        let dbSortField = 'id';
        let dbSortOrder = 'DESC';
        let dbBatchOptions = [];
        let dbFilterOptions = { grades: [], tiers: [], subjects: [] };
        let dbSchemaMap = {};
        let dbSelectedIds = new Set();
        let dbDebounceTimer = null;
        let dbCurrentRecords = [];

        async function initDatabaseTab() {
            applyDbViewMode();
            await loadDbBatchOptions();
            await loadDbTables();
        }

        async function loadDbBatchOptions() {
            try {
                const [batchRes, filterRes] = await Promise.all([
                    fetch(`${API_BASE}?action=db_batches_options`),
                    fetch(`${API_BASE}?action=dimensions`)
                ]);
                const batchJson = await batchRes.json();
                if (batchJson.success) {
                    dbBatchOptions = batchJson.data || [];
                }
                const filterJson = await filterRes.json();
                if (filterJson.success && filterJson.data) {
                    dbFilterOptions = filterJson.data;
                }
            } catch (e) {
                console.error('Failed to load batch/filter options', e);
            }
        }

        async function loadDbTables() {
            const tabsBar = document.getElementById('db-tabs-bar');
            if (!tabsBar) return;
            try {
                const res = await fetch(`${API_BASE}?action=db_tables`);
                const json = await res.json();
                if (json.success && Array.isArray(json.data?.tables)) {
                    dbTables = json.data.tables.filter(t => t && t.name && t.name !== 'student_records');
                    const navBadge = document.getElementById('nav-db-badge');
                    if (navBadge) navBadge.textContent = `${dbTables.length} 张系统表`;

                    if (dbCurrentTable === 'student_records' || !dbTables.some(t => t.name === dbCurrentTable)) {
                        dbCurrentTable = dbTables[0]?.name || 'class_batches';
                    }

                    tabsBar.innerHTML = dbTables.map(t => {
                        let iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>';
                        const tName = String(t.name || '');
                        if (tName === 'student_records') {
                            iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>';
                        } else if (tName === 'class_batches') {
                            iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>';
                        } else if (tName === 'qbank_questions' || tName === 'qbank_weeks') {
                            iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>';
                        } else if (tName.includes('log')) {
                            iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>';
                        } else if (tName === 'admin_users') {
                            iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg>';
                        } else if (tName === 'users') {
                            iconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>';
                        }

                        return `
                            <button type="button" class="db-tab-pill ${tName === dbCurrentTable ? 'active' : ''}" onclick="switchDbTable('${escapeInlineJs(tName)}')">
                                ${iconSvg}
                                <span>${escapeHtml(t.friendly_name || tName)}</span>
                                <span class="db-pill-count">${t.count ?? 0}</span>
                            </button>
                        `;
                    }).join('');

                    renderDbFilters();
                    loadDbData(1);
                } else {
                    tabsBar.innerHTML = `<div style="color:var(--danger); padding:8px 12px; font-size:0.88rem;">载入系统表失败：${escapeHtml(json?.error || '未知错误')}</div>`;
                    const tbody = document.getElementById('db-tbody');
                    if (tbody) {
                        tbody.innerHTML = `<tr><td colspan="12" class="table-empty"><div class="empty-state"><span>载入系统表配置失败</span></div></td></tr>`;
                    }
                }
            } catch (e) {
                console.error('Failed to load db tables', e);
                const tabsBar = document.getElementById('db-tabs-bar');
                if (tabsBar) tabsBar.innerHTML = `<div style="color:var(--danger); padding:8px 12px; font-size:0.88rem;">载入系统表异常，请刷新重试</div>`;
                const tbody = document.getElementById('db-tbody');
                if (tbody) {
                    tbody.innerHTML = `<tr><td colspan="12" class="table-empty"><div class="empty-state"><span>载入数据表异常：${escapeHtml(e.message || String(e))}</span></div></td></tr>`;
                }
            }
        }

        function switchDbTable(tableName) {
            if (dbCurrentTable === tableName) return;
            dbCurrentTable = tableName;
            dbCurrentPage = 1;
            dbSortField = 'id';
            dbSortOrder = 'DESC';
            dbSelectedIds.clear();
            updateDbBatchDeleteBtn();
            const searchInput = document.getElementById('db-search-input');
            if (searchInput) searchInput.value = '';

            document.querySelectorAll('.db-tab-pill').forEach(btn => {
                const isMatch = btn.textContent.includes(tableName) || 
                                (dbTables.find(t => t.name === tableName)?.friendly_name && btn.textContent.includes(dbTables.find(t => t.name === tableName).friendly_name));
                btn.classList.toggle('active', isMatch);
            });

            renderDbFilters();
            loadDbData(1);
        }

        function renderDbFilters() {
            const container = document.getElementById('db-extra-filters');
            if (!container) return;

            // Extract unique grades, tiers, subjects
            const rawGrades = dbFilterOptions.grades?.length ? dbFilterOptions.grades : [...new Set(dbBatchOptions.map(b => b.raw?.grade).filter(Boolean))];
            const rawTiers = dbFilterOptions.tiers?.length ? dbFilterOptions.tiers : [...new Set(dbBatchOptions.map(b => b.raw?.tier).filter(Boolean))];
            const rawSubjects = dbFilterOptions.subjects?.length ? dbFilterOptions.subjects : [...new Set(dbBatchOptions.map(b => b.raw?.subject).filter(Boolean))];

            const gradeOrder = ['七年级', '八年级', '九年级', '高一', '高二', '高三'];
            const gradeList = [...rawGrades].sort((a, b) => {
                const ia = gradeOrder.indexOf(a);
                const ib = gradeOrder.indexOf(b);
                if (ia !== -1 && ib !== -1) return ia - ib;
                if (ia !== -1) return -1;
                if (ib !== -1) return 1;
                return a.localeCompare(b, 'zh-CN');
            });

            const tierOrder = ['S+', 'S', 'A+', 'A', 'U', '自定义'];
            const tierList = [...rawTiers].sort((a, b) => {
                const ia = tierOrder.indexOf(a);
                const ib = tierOrder.indexOf(b);
                if (ia !== -1 && ib !== -1) return ia - ib;
                if (ia !== -1) return -1;
                if (ib !== -1) return 1;
                return a.localeCompare(b, 'zh-CN');
            });

            const subjectList = [...rawSubjects].sort((a, b) => a.localeCompare(b, 'zh-CN'));

            // Remember current selections
            const curGrade = document.getElementById('db-filter-grade')?.value || '';
            const curTier = document.getElementById('db-filter-tier')?.value || '';
            const curSubject = document.getElementById('db-filter-subject')?.value || '';
            const curBatch = document.getElementById('db-filter-batch')?.value || '';
            const curWeek = document.getElementById('db-filter-week')?.value || '';
            const curErr = document.getElementById('db-filter-err')?.value || '';
            const curYear = document.getElementById('db-filter-year')?.value || '';
            const curSeason = document.getElementById('db-filter-season')?.value || '';
            const curLevel = document.getElementById('db-filter-level')?.value || '';
            const curModule = document.getElementById('db-filter-module')?.value || '';
            const curAction = document.getElementById('db-filter-action')?.value || '';
            const curStatus = document.getElementById('db-filter-status')?.value || '';
            const curRole = document.getElementById('db-filter-role')?.value || '';

            const gradeOpts = gradeList.map(g => `<option value="${escapeHtml(g)}" ${g === curGrade ? 'selected' : ''}>${escapeHtml(g)}</option>`).join('');
            const tierOpts = tierList.map(t => `<option value="${escapeHtml(t)}" ${t === curTier ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('');
            const subjectOpts = subjectList.map(s => `<option value="${escapeHtml(s)}" ${s === curSubject ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('');

            if (dbCurrentTable === 'student_records') {
                // Cascaded batches
                const filteredBatches = dbBatchOptions.filter(b => {
                    if (curGrade && b.raw?.grade !== curGrade) return false;
                    if (curTier && b.raw?.tier !== curTier) return false;
                    if (curSubject && b.raw?.subject !== curSubject) return false;
                    return true;
                });

                const batchOpts = filteredBatches.map(b => `<option value="${b.id}" ${String(b.id) === curBatch ? 'selected' : ''}>${escapeHtml(b.label)}</option>`).join('');

                let weekOpts = '<option value="">全部周次</option>';
                for (let i = 1; i <= 20; i++) {
                    weekOpts += `<option value="${i}" ${String(i) === curWeek ? 'selected' : ''}>第 ${i} 周</option>`;
                }

                container.innerHTML = `
                    <select id="db-filter-grade" class="custom-select" onchange="onDbDimensionsChange()" style="min-width: 96px;">
                        <option value="">全部年级</option>
                        ${gradeOpts}
                    </select>
                    <select id="db-filter-tier" class="custom-select" onchange="onDbDimensionsChange()" style="min-width: 96px;">
                        <option value="">全部班型</option>
                        ${tierOpts}
                    </select>
                    <select id="db-filter-subject" class="custom-select" onchange="onDbDimensionsChange()" style="min-width: 96px;">
                        <option value="">全部学科</option>
                        ${subjectOpts}
                    </select>
                    <select id="db-filter-batch" class="custom-select" onchange="loadDbData(1)" style="max-width: 220px;">
                        <option value="">全部教学班级 (${filteredBatches.length})</option>
                        ${batchOpts}
                    </select>
                    <select id="db-filter-week" class="custom-select" onchange="loadDbData(1)" style="min-width: 96px;">
                        ${weekOpts}
                    </select>
                    <select id="db-filter-err" class="custom-select" onchange="loadDbData(1)" style="min-width: 120px;">
                        <option value="" ${curErr === '' ? 'selected' : ''}>全部错题状态</option>
                        <option value="has_err" ${curErr === 'has_err' ? 'selected' : ''}>有错题 (>0)</option>
                        <option value="no_err" ${curErr === 'no_err' ? 'selected' : ''}>全对 (0错题)</option>
                    </select>
                    ${(curGrade || curTier || curSubject || curBatch || curWeek || curErr) ? `
                        <button type="button" class="btn secondary" onclick="resetDbFilters()" title="重置所有筛选" style="padding: 6px 12px; font-size: 0.82rem;">重置</button>
                    ` : ''}
                `;
            } else if (dbCurrentTable === 'class_batches') {
                container.innerHTML = `
                    <select id="db-filter-grade" class="custom-select" onchange="loadDbData(1)" style="min-width: 96px;">
                        <option value="">全部年级</option>
                        ${gradeOpts}
                    </select>
                    <select id="db-filter-tier" class="custom-select" onchange="loadDbData(1)" style="min-width: 96px;">
                        <option value="">全部班型</option>
                        ${tierOpts}
                    </select>
                    <select id="db-filter-subject" class="custom-select" onchange="loadDbData(1)" style="min-width: 96px;">
                        <option value="">全部学科</option>
                        ${subjectOpts}
                    </select>
                    <select id="db-filter-year" class="custom-select" onchange="loadDbData(1)" style="min-width: 96px;">
                        <option value="" ${curYear === '' ? 'selected' : ''}>全部年份</option>
                        <option value="2026" ${curYear === '2026' ? 'selected' : ''}>2026</option>
                        <option value="2025" ${curYear === '2025' ? 'selected' : ''}>2025</option>
                        <option value="2024" ${curYear === '2024' ? 'selected' : ''}>2024</option>
                    </select>
                    <select id="db-filter-season" class="custom-select" onchange="loadDbData(1)" style="min-width: 96px;">
                        <option value="" ${curSeason === '' ? 'selected' : ''}>全部季节</option>
                        <option value="寒假" ${curSeason === '寒假' ? 'selected' : ''}>寒假</option>
                        <option value="春季" ${curSeason === '春季' ? 'selected' : ''}>春季</option>
                        <option value="暑假" ${curSeason === '暑假' ? 'selected' : ''}>暑假</option>
                        <option value="秋季" ${curSeason === '秋季' ? 'selected' : ''}>秋季</option>
                    </select>
                    ${(curGrade || curTier || curSubject || curYear || curSeason) ? `
                        <button type="button" class="btn secondary" onclick="resetDbFilters()" title="重置所有筛选" style="padding: 6px 12px; font-size: 0.82rem;">重置</button>
                    ` : ''}
                `;
            } else if (dbCurrentTable === 'qbank_weeks' || dbCurrentTable === 'qbank_questions') {
                let weekOpts = '<option value="">全部周次</option>';
                for (let i = 1; i <= 20; i++) {
                    weekOpts += `<option value="${i}" ${String(i) === curWeek ? 'selected' : ''}>第 ${i} 周</option>`;
                }
                container.innerHTML = `
                    <select id="db-filter-grade" class="custom-select" onchange="loadDbData(1)" style="min-width: 96px;">
                        <option value="">全部年级</option>
                        ${gradeOpts}
                    </select>
                    <select id="db-filter-tier" class="custom-select" onchange="loadDbData(1)" style="min-width: 96px;">
                        <option value="">全部班型</option>
                        ${tierOpts}
                    </select>
                    <select id="db-filter-subject" class="custom-select" onchange="loadDbData(1)" style="min-width: 96px;">
                        <option value="">全部学科</option>
                        ${subjectOpts}
                    </select>
                    <select id="db-filter-week" class="custom-select" onchange="loadDbData(1)" style="min-width: 96px;">
                        ${weekOpts}
                    </select>
                    <select id="db-filter-year" class="custom-select" onchange="loadDbData(1)" style="min-width: 96px;">
                        <option value="" ${curYear === '' ? 'selected' : ''}>全部年份</option>
                        <option value="2026" ${curYear === '2026' ? 'selected' : ''}>2026</option>
                        <option value="2025" ${curYear === '2025' ? 'selected' : ''}>2025</option>
                    </select>
                    <select id="db-filter-season" class="custom-select" onchange="loadDbData(1)" style="min-width: 96px;">
                        <option value="" ${curSeason === '' ? 'selected' : ''}>全部季度</option>
                        <option value="春" ${curSeason === '春' ? 'selected' : ''}>春季 (春)</option>
                        <option value="寒" ${curSeason === '寒' ? 'selected' : ''}>寒假 (寒)</option>
                        <option value="暑" ${curSeason === '暑' ? 'selected' : ''}>暑假 (暑)</option>
                        <option value="秋" ${curSeason === '秋' ? 'selected' : ''}>秋季 (秋)</option>
                    </select>
                    ${(curGrade || curTier || curSubject || curWeek || curYear || curSeason) ? `
                        <button type="button" class="btn secondary" onclick="resetDbFilters()" title="重置所有筛选" style="padding: 6px 12px; font-size: 0.82rem;">重置</button>
                    ` : ''}
                `;
            } else if (dbCurrentTable === 'system_logs') {
                const levels = dbFilterOptions.log_levels?.length ? dbFilterOptions.log_levels : ['action', 'info', 'warn', 'error'];
                const modules = dbFilterOptions.log_modules?.length ? dbFilterOptions.log_modules : ['viewer', 'admin', 'retest'];
                container.innerHTML = `
                    <select id="db-filter-level" class="custom-select" onchange="loadDbData(1)" style="min-width: 110px;">
                        <option value="" ${curLevel === '' ? 'selected' : ''}>全部日志级别</option>
                        ${levels.map(l => `<option value="${escapeHtml(l)}" ${l === curLevel ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}
                    </select>
                    <select id="db-filter-module" class="custom-select" onchange="loadDbData(1)" style="min-width: 110px;">
                        <option value="" ${curModule === '' ? 'selected' : ''}>全部业务模块</option>
                        ${modules.map(m => `<option value="${escapeHtml(m)}" ${m === curModule ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('')}
                    </select>
                    ${(curLevel || curModule) ? `
                        <button type="button" class="btn secondary" onclick="resetDbFilters()" title="重置所有筛选" style="padding: 6px 12px; font-size: 0.82rem;">重置</button>
                    ` : ''}
                `;
            } else if (dbCurrentTable === 'retest_access_logs') {
                const actions = ['view_page', 'download_pdf', 'enter_code'];
                container.innerHTML = `
                    <select id="db-filter-action" class="custom-select" onchange="loadDbData(1)" style="min-width: 120px;">
                        <option value="" ${curAction === '' ? 'selected' : ''}>全部查阅动作</option>
                        ${actions.map(a => `<option value="${escapeHtml(a)}" ${a === curAction ? 'selected' : ''}>${escapeHtml(a)}</option>`).join('')}
                    </select>
                    ${curAction ? `
                        <button type="button" class="btn secondary" onclick="resetDbFilters()" title="重置所有筛选" style="padding: 6px 12px; font-size: 0.82rem;">重置</button>
                    ` : ''}
                `;
            } else if (dbCurrentTable === 'admin_users') {
                container.innerHTML = `
                    <select id="db-filter-status" class="custom-select" onchange="loadDbData(1)" style="min-width: 110px;">
                        <option value="" ${curStatus === '' ? 'selected' : ''}>全部状态</option>
                        <option value="1" ${curStatus === '1' ? 'selected' : ''}>启用</option>
                        <option value="0" ${curStatus === '0' ? 'selected' : ''}>禁用</option>
                    </select>
                    <select id="db-filter-role" class="custom-select" onchange="loadDbData(1)" style="min-width: 120px;">
                        <option value="" ${curRole === '' ? 'selected' : ''}>全部权限</option>
                        <option value="super_admin" ${curRole === 'super_admin' ? 'selected' : ''}>超级管理员</option>
                        <option value="admin" ${curRole === 'admin' ? 'selected' : ''}>普通管理员</option>
                    </select>
                    ${(curStatus || curRole) ? `
                        <button type="button" class="btn secondary" onclick="resetDbFilters()" title="重置所有筛选" style="padding: 6px 12px; font-size: 0.82rem;">重置</button>
                    ` : ''}
                `;
            } else if (dbCurrentTable === 'users') {
                container.innerHTML = `
                    <select id="db-filter-status" class="custom-select" onchange="loadDbData(1)" style="min-width: 110px;">
                        <option value="" ${curStatus === '' ? 'selected' : ''}>全部状态</option>
                        <option value="1" ${curStatus === '1' ? 'selected' : ''}>启用</option>
                        <option value="0" ${curStatus === '0' ? 'selected' : ''}>禁用</option>
                    </select>
                    ${curStatus ? `
                        <button type="button" class="btn secondary" onclick="resetDbFilters()" title="重置所有筛选" style="padding: 6px 12px; font-size: 0.82rem;">重置</button>
                    ` : ''}
                `;
            } else {
                container.innerHTML = '';
            }
        }

        function onDbDimensionsChange() {
            renderDbFilters();
            loadDbData(1);
        }

        function resetDbFilters() {
            const searchInput = document.getElementById('db-search-input');
            if (searchInput) searchInput.value = '';
            ['grade', 'tier', 'subject', 'batch', 'week', 'err', 'year', 'season', 'level', 'module', 'action', 'status', 'role'].forEach(k => {
                const el = document.getElementById(`db-filter-${k}`);
                if (el) el.value = '';
            });
            renderDbFilters();
            loadDbData(1);
        }

        function debounceLoadDbData() {
            clearTimeout(dbDebounceTimer);
            dbDebounceTimer = setTimeout(() => {
                loadDbData(1);
            }, 300);
        }

        function changeDbPerPage(val) {
            dbPerPage = parseInt(val, 10) || 20;
            loadDbData(1);
        }

        async function loadDbData(page = 1) {
            dbCurrentPage = page;
            const masterCb = document.getElementById('db-select-all');
            if (masterCb) masterCb.checked = false;
            const tbody = document.getElementById('db-tbody');
            if (!tbody) return;

            tbody.innerHTML = `
                <tr>
                    <td colspan="12" class="table-empty">
                        <div class="empty-state">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                <ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>
                                <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path>
                                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>
                            </svg>
                            <span>数据检索载入中...</span>
                        </div>
                    </td>
                </tr>
            `;

            const searchVal = document.getElementById('db-search-input')?.value.trim() || '';
            const params = new URLSearchParams({
                action: 'db_list',
                table: dbCurrentTable,
                page: page,
                perPage: dbPerPage,
                sort: dbSortField,
                order: dbSortOrder
            });

            if (searchVal) params.append('search', searchVal);

            const gradeVal = document.getElementById('db-filter-grade')?.value || '';
            const tierVal = document.getElementById('db-filter-tier')?.value || '';
            const subjectVal = document.getElementById('db-filter-subject')?.value || '';
            if (gradeVal) params.append('grade', gradeVal);
            if (tierVal) params.append('tier', tierVal);
            if (subjectVal) params.append('subject', subjectVal);

            if (dbCurrentTable === 'student_records') {
                const batchVal = document.getElementById('db-filter-batch')?.value;
                const weekVal = document.getElementById('db-filter-week')?.value;
                const errVal = document.getElementById('db-filter-err')?.value;
                if (batchVal) params.append('batch_id', batchVal);
                if (weekVal) params.append('week_num', weekVal);
                if (errVal) params.append('has_errors', errVal);
            } else if (dbCurrentTable === 'class_batches') {
                const yearVal = document.getElementById('db-filter-year')?.value;
                const seasonVal = document.getElementById('db-filter-season')?.value;
                if (yearVal) params.append('year', yearVal);
                if (seasonVal) params.append('season', seasonVal);
            } else if (dbCurrentTable === 'qbank_weeks' || dbCurrentTable === 'qbank_questions') {
                const yearVal = document.getElementById('db-filter-year')?.value;
                const seasonVal = document.getElementById('db-filter-season')?.value;
                const weekVal = document.getElementById('db-filter-week')?.value;
                if (yearVal) params.append('year', yearVal);
                if (seasonVal) params.append('season', seasonVal);
                if (weekVal) params.append('week', weekVal);
            } else if (dbCurrentTable === 'system_logs') {
                const levelVal = document.getElementById('db-filter-level')?.value;
                const moduleVal = document.getElementById('db-filter-module')?.value;
                if (levelVal) params.append('level', levelVal);
                if (moduleVal) params.append('module', moduleVal);
            } else if (dbCurrentTable === 'retest_access_logs') {
                const actionVal = document.getElementById('db-filter-action')?.value;
                if (actionVal) params.append('log_action', actionVal);
            } else if (dbCurrentTable === 'admin_users') {
                const statusVal = document.getElementById('db-filter-status')?.value;
                const roleVal = document.getElementById('db-filter-role')?.value;
                if (statusVal !== undefined && statusVal !== '') params.append('status', statusVal);
                if (roleVal) params.append('role', roleVal);
            } else if (dbCurrentTable === 'users') {
                const statusVal = document.getElementById('db-filter-status')?.value;
                if (statusVal !== undefined && statusVal !== '') params.append('status', statusVal);
            }

            try {
                const res = await fetch(`${API_BASE}?${params.toString()}`);
                const json = await res.json();
                if (json.success && json.data) {
                    dbCurrentRecords = json.data.records || [];
                    dbSchemaMap[dbCurrentTable] = json.data.schema || [];

                    renderDbThead(json.data.schema || []);
                    renderDbTbody(dbCurrentRecords, json.data.schema || []);
                    renderDbCards(dbCurrentRecords, json.data.schema || []);
                    applyDbViewMode();
                    renderDbPagination(json.data.page, json.data.totalPages, json.data.total);

                    // Update count pill for current table
                    const currentTableInfo = dbTables.find(t => t.name === dbCurrentTable);
                    if (currentTableInfo) {
                        currentTableInfo.count = json.data.total;
                        const pillBtns = document.querySelectorAll('.db-tab-pill');
                        pillBtns.forEach(btn => {
                            if (btn.classList.contains('active')) {
                                const countSpan = btn.querySelector('.db-pill-count');
                                if (countSpan) countSpan.textContent = json.data.total;
                            }
                        });
                    }
                } else {
                    tbody.innerHTML = `<tr><td colspan="12" class="table-empty"><div class="empty-state"><span>${escapeHtml(json.error || '加载失败')}</span></div></td></tr>`;
                    const cardsWrap = document.getElementById('db-cards-wrapper');
                    if (cardsWrap) cardsWrap.innerHTML = `<div class="empty-state" style="padding: 40px 16px;"><span>${escapeHtml(json.error || '加载失败')}</span></div>`;
                }
            } catch (e) {
                console.error('loadDbData failed:', e);
                tbody.innerHTML = `<tr><td colspan="12" class="table-empty"><div class="empty-state"><span>数据加载失败：${escapeHtml(e.message || '网络请求错误')}</span></div></td></tr>`;
                const cardsWrap = document.getElementById('db-cards-wrapper');
                if (cardsWrap) cardsWrap.innerHTML = `<div class="empty-state" style="padding: 40px 16px;"><span>数据加载失败：${escapeHtml(e.message || '网络请求错误')}</span></div>`;
            }
        }

        function setDbSort(field) {
            if (dbSortField === field) {
                dbSortOrder = dbSortOrder === 'ASC' ? 'DESC' : 'ASC';
            } else {
                dbSortField = field;
                dbSortOrder = 'DESC';
            }
            loadDbData(dbCurrentPage);
        }

        function renderDbThead(schema) {
            const thead = document.getElementById('db-thead');
            if (!thead) return;

            const sortIcon = (field) => {
                if (dbSortField !== field) return '<span class="th-sort-icon">↕</span>';
                return `<span class="th-sort-icon">${dbSortOrder === 'ASC' ? '▲' : '▼'}</span>`;
            };

            const dbCheckTh = `
                        <th style="width: 38px; text-align: center;">
                            <input type="checkbox" id="db-select-all" data-change="select-all-db" aria-label="全选当前表" style="accent-color: var(--primary); cursor: pointer;">
                        </th>`;
            const dbSortTh = (field, label, styleAttr = '') => `
                        <th class="th-sortable ${dbSortField === field ? 'active' : ''}"${styleAttr ? ` style="${styleAttr}"` : ''}><button type="button" class="th-sort-btn" data-action="db-sort" data-arg="${field}">${label} ${sortIcon(field)}</button></th>`;
            if (dbCurrentTable === 'student_records') {
                thead.innerHTML = `
                    <tr>
                        ${dbCheckTh}
                        ${dbSortTh('student_id', '学员')}
                        <th style="width: 115px; min-width: 110px;">年级</th>
                        <th style="width: 65px;">学科</th>
                        <th style="width: 65px;">班型</th>
                        ${dbSortTh('week_num', '周次 (巩固/预习)', 'width: 105px;')}
                        ${dbSortTh('homework_score', '成绩 (巩固/预习)', 'width: 115px;')}
                        ${dbSortTh('error_count', '错题题号 (巩固/预习)', 'width: 185px;')}
                        <th style="width: 175px; max-width: 185px;">评语 (巩固/预习)</th>
                        ${dbSortTh('created_by', '生成教师', 'width: 105px;')}
                        ${dbSortTh('created_at', '录入时间', 'width: 120px;')}
                        <th style="width: 205px; text-align: right;">操作</th>
                    </tr>
                `;
            } else if (dbCurrentTable === 'class_batches') {
                thead.innerHTML = `
                    <tr>
                        ${dbCheckTh}
                        ${dbSortTh('id', 'ID', 'width: 60px;')}
                        ${dbSortTh('year', '年份 / 季度')}
                        <th style="width: 115px; min-width: 110px;">年级</th>
                        <th>班型</th>
                        <th>学科</th>
                        <th>班级全称</th>
                        ${dbSortTh('created_by', '生成教师', 'width: 105px;')}
                        ${dbSortTh('created_at', '创建时间')}
                        <th style="width: 120px; text-align: right;">操作</th>
                    </tr>
                `;
            } else if (dbCurrentTable === 'retest_access_logs') {
                thead.innerHTML = `
                    <tr>
                        ${dbCheckTh}
                        ${dbSortTh('id', 'ID', 'width: 60px;')}
                        <th>Token</th>
                        <th>学生姓名</th>
                        <th>动作</th>
                        <th>详情</th>
                        <th>访问 IP</th>
                        ${dbSortTh('created_at', '查阅时间')}
                        <th style="width: 100px; text-align: right;">操作</th>
                    </tr>
                `;
            } else if (dbCurrentTable === 'qbank_weeks') {
                thead.innerHTML = `
                    <tr>
                        ${dbCheckTh}
                        ${dbSortTh('id', 'ID', 'width: 60px;')}
                        ${dbSortTh('year', '年份 / 季度', 'width: 110px;')}
                        <th style="width: 100px;">年级</th>
                        <th style="width: 75px;">班型</th>
                        <th style="width: 75px;">学科</th>
                        ${dbSortTh('week', '周次', 'width: 85px; text-align: center;')}
                        ${dbSortTh('question_count', '题目总数', 'width: 95px; text-align: center;')}
                        ${dbSortTh('created_by', '录入教师', 'width: 105px;')}
                        ${dbSortTh('updated_at', '更新时间', 'width: 130px;')}
                        <th style="width: 140px; text-align: right;">操作</th>
                    </tr>
                `;
            } else if (dbCurrentTable === 'qbank_questions') {
                thead.innerHTML = `
                    <tr>
                        ${dbCheckTh}
                        ${dbSortTh('id', 'ID', 'width: 60px;')}
                        ${dbSortTh('question_num', '题号', 'width: 75px; text-align: center;')}
                        ${dbSortTh('topic', '考点 / 考查知识点')}
                        <th style="width: 160px;">年级 / 学科 / 班型</th>
                        ${dbSortTh('week', '周次', 'width: 75px; text-align: center;')}
                        ${dbSortTh('year', '年份/学期', 'width: 105px;')}
                        <th style="width: 80px; text-align: center;">题 / 解</th>
                        ${dbSortTh('created_by', '录入教师', 'width: 105px;')}
                        ${dbSortTh('updated_at', '更新时间', 'width: 125px;')}
                        <th style="width: 140px; text-align: right;">操作</th>
                    </tr>
                `;
            } else if (dbCurrentTable === 'system_logs') {
                thead.innerHTML = `
                    <tr>
                        ${dbCheckTh}
                        ${dbSortTh('id', 'ID', 'width: 65px;')}
                        ${dbSortTh('level', '级别', 'width: 85px;')}
                        ${dbSortTh('module', '模块', 'width: 90px;')}
                        ${dbSortTh('event', '事件', 'width: 130px;')}
                        ${dbSortTh('operator', '操作人', 'width: 100px;')}
                        <th>详细日志内容摘要</th>
                        <th style="width: 120px;">客户端 IP</th>
                        ${dbSortTh('created_at', '记录时间', 'width: 130px;')}
                        <th style="width: 100px; text-align: right;">操作</th>
                    </tr>
                `;
            } else if (dbCurrentTable === 'admin_users') {
                thead.innerHTML = `
                    <tr>
                        ${dbCheckTh}
                        ${dbSortTh('id', 'ID', 'width: 60px;')}
                        ${dbSortTh('username', '登录账号', 'width: 130px;')}
                        ${dbSortTh('real_name', '姓名 / 备注')}
                        ${dbSortTh('role', '角色权限', 'width: 110px;')}
                        ${dbSortTh('status', '状态', 'width: 90px; text-align: center;')}
                        <th style="width: 110px;">登录密码</th>
                        ${dbSortTh('last_login_at', '最后登录时间', 'width: 140px;')}
                        <th style="width: 120px;">最后登录 IP</th>
                        ${dbSortTh('created_at', '创建时间', 'width: 140px;')}
                        <th style="width: 120px; text-align: right;">操作</th>
                    </tr>
                `;
            } else if (dbCurrentTable === 'users') {
                thead.innerHTML = `
                    <tr>
                        ${dbCheckTh}
                        ${dbSortTh('id', 'ID', 'width: 60px;')}
                        ${dbSortTh('username', '教师账号', 'width: 120px;')}
                        ${dbSortTh('real_name', '教师姓名')}
                        <th style="width: 110px; text-align: center;">名下助教</th>
                        ${dbSortTh('status', '状态', 'width: 85px; text-align: center;')}
                        <th style="width: 120px;">密码状态</th>
                        ${dbSortTh('last_login_at', '最后登录时间', 'width: 140px;')}
                        <th style="width: 110px;">最后登录 IP</th>
                        ${dbSortTh('created_at', '创建时间', 'width: 140px;')}
                        <th style="width: 200px; text-align: right;">操作</th>
                    </tr>
                `;
            } else {
                let colsHtml = `
                    <tr>
                        ${dbCheckTh}
                `;
                schema.slice(0, 7).forEach(col => {
                    const colField = col.field || col.name;
                    colsHtml += dbSortTh(colField, escapeHtml(col.comment || colField));
                });
                colsHtml += `<th style="width: 120px; text-align: right;">操作</th></tr>`;
                thead.innerHTML = colsHtml;
            }
        }

        function renderDbTbody(records, schema) {
            const tbody = document.getElementById('db-tbody');
            if (!tbody) return;

            if (!records.length) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="12" class="table-empty">
                            <div class="empty-state">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                    <circle cx="12" cy="12" r="10"></circle>
                                    <line x1="8" y1="12" x2="16" y2="12"></line>
                                </svg>
                                <span>未查询到任何匹配的数据记录</span>
                            </div>
                        </td>
                    </tr>
                `;
                return;
            }

            if (dbCurrentTable === 'student_records') {
                tbody.innerHTML = records.map((r, idx) => {
                    const batchDesc = r.class_name ? escapeHtml(r.class_name) : (r.batch_id ? `批次 #${r.batch_id}` : '-');
                    const isSelected = dbSelectedIds.has(r.id);

                    const errBadges = formatRecordErrorBadges(r);

                    const tokenHtml = r.retest_token ? `
                        <span class="token-pill" onclick="copyDbToken('${escapeInlineJs(r.retest_token)}')" title="点击复制Token">
                            ${escapeHtml(r.retest_token)}
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg>
                        </span>
                    ` : '<span style="color:var(--text-muted);">-</span>';

                    const commentPreview = formatRecordCommentPreview(r, idx, 'openDbDetailModal');

                    const sId = (r.student_id || '').trim();
                    const sName = (r.student_name || '').trim();
                    const copyIdName = `${sId}${sName}`;
                    const gradeVal = r.grade || r._batch?.grade || '-';
                    const subjectVal = r.subject || r._batch?.subject || '-';
                    const tierVal = r.tier || r._batch?.tier || '-';

                    const hwScoreDisplay = (r.homework_score !== null && r.homework_score !== undefined && r.homework_score !== '') ? formatScore(r.homework_score) : '-';
                    const pvScoreDisplay = (r.preview_score !== null && r.preview_score !== undefined && r.preview_score !== '') ? formatScore(r.preview_score) : null;
                    const hasPreviewWeek = r.preview_week_num && r.preview_week_num != r.week_num;

                    const hwTag = `<span style="display:inline-block; font-size:0.68rem; font-weight:600; padding:1px 5px; border-radius:4px; background:rgba(56,189,248,0.15); color:#38bdf8; border:1px solid rgba(56,189,248,0.3); flex-shrink:0; line-height:1.3;">巩固</span>`;
                    const pvTag = `<span style="display:inline-block; font-size:0.68rem; font-weight:600; padding:1px 5px; border-radius:4px; background:rgba(245,158,11,0.15); color:#f59e0b; border:1px solid rgba(245,158,11,0.3); flex-shrink:0; line-height:1.3;">预习</span>`;

                    return `
                        <tr>
                            <td style="text-align: center;">
                                <input type="checkbox" class="db-row-cb" data-id="${r.id}" ${isSelected ? 'checked' : ''} onchange="toggleDbSelectRow(${r.id}, this)" style="accent-color: var(--primary); cursor: pointer;">
                            </td>
                            <td>
                                <div class="student-profile-chip" onclick="copyStudentIdName('${escapeInlineJs(copyIdName)}')" title="点击复制：${escapeHtml(copyIdName)}">
                                    <div>
                                        <div class="student-name-text">
                                            ${escapeHtml(r.student_name || '-')}
                                            <svg class="copy-icon-subtle" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="width: 12px; height: 12px; flex-shrink: 0;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg>
                                        </div>
                                        <div class="student-id-sub">${escapeHtml(r.student_id || '-')}</div>
                                    </div>
                                </div>
                            </td>
                            <td style="white-space: nowrap;"><span style="font-weight:600; color: var(--text-secondary);">${escapeHtml(gradeVal)}</span></td>
                            <td><b style="color:#a78bfa;">${escapeHtml(subjectVal)}</b></td>
                            <td><span style="background:rgba(255,255,255,0.08); padding:2px 7px; border-radius:4px; font-size:0.8rem; font-weight:600; color: var(--text-secondary);">${escapeHtml(tierVal)}</span></td>
                            <td style="white-space: nowrap;">
                                <div style="display:flex; flex-direction:column; gap:4px; justify-content:center;">
                                    <div style="display:flex; align-items:center; gap:5px;">
                                        ${hwTag}
                                        <span style="font-weight:700; color:#93c5fd; font-family:var(--font-mono); font-size:0.92rem;">第${r.week_num ?? '-'}周</span>
                                    </div>
                                    <div style="display:flex; align-items:center; gap:5px;">
                                        ${pvTag}
                                        <span style="font-weight:600; color:#fbbf24; font-family:var(--font-mono); font-size:0.88rem;">${(r.preview_week_num !== null && r.preview_week_num !== undefined && r.preview_week_num !== '') ? `第${r.preview_week_num}周` : '-'}</span>
                                    </div>
                                </div>
                            </td>
                            <td style="white-space: nowrap;">
                                <div style="display:flex; flex-direction:column; gap:4px; justify-content:center;">
                                    <div style="display:flex; align-items:center; gap:5px;">
                                        ${hwTag}
                                        <span style="font-weight:700; color:#38bdf8; font-family:var(--font-mono); font-size:0.95rem;">${hwScoreDisplay}${hwScoreDisplay !== '-' ? '分' : ''}</span>
                                    </div>
                                    <div style="display:flex; align-items:center; gap:5px;">
                                        ${pvTag}
                                        <span style="font-weight:600; color:#f59e0b; font-family:var(--font-mono); font-size:0.92rem;">${pvScoreDisplay !== null ? `${pvScoreDisplay}分` : '-'}</span>
                                    </div>
                                </div>
                            </td>
                            <td>${errBadges}</td>
                            <td>${commentPreview}</td>
                            <td>${r.created_by ? renderCreatorCell(r, false) : '<span style="color:var(--text-muted); font-size:0.75rem;">-</span>'}</td>
                            <td class="cell-mono" style="font-size:0.8rem; color:var(--text-secondary);">${formatTimestamp(r.created_at)}</td>
                            <td style="text-align: right; white-space: nowrap;">
                                ${r.retest_token ? `<button type="button" class="btn-action retest" onclick="openRetestStudent('${escapeInlineJs(r.retest_token)}')" title="打开学员/家长端错题本（需输入姓名验证）">错题本</button>` : ''}
                                ${r.retest_token ? `<button type="button" class="btn-action admin-retest" onclick="openRetestDirect('${escapeInlineJs(r.retest_token)}')" title="管理员免密直达错题本">管理员错题本</button>` : ''}
                                <button type="button" class="btn-action edit" onclick="openDbRecordModal(${r.id})" title="编辑此记录">编辑</button>
                                <button type="button" class="btn-action detail" onclick="openDbDetailModal(${idx})" title="查看完整详情">详情</button>
                                <button type="button" class="btn-action delete" onclick="deleteDbRecord(${r.id})" title="删除此记录">删除</button>
                            </td>
                        </tr>
                    `;
                }).join('');
            } else if (dbCurrentTable === 'class_batches') {
                tbody.innerHTML = records.map((r, idx) => {
                    const isSelected = dbSelectedIds.has(r.id);
                    return `
                        <tr>
                            <td style="text-align: center;">
                                <input type="checkbox" class="db-row-cb" data-id="${r.id}" ${isSelected ? 'checked' : ''} onchange="toggleDbSelectRow(${r.id}, this)" style="accent-color: var(--primary); cursor: pointer;">
                            </td>
                            <td class="cell-mono">${r.id}</td>
                            <td><span style="font-weight:700; color: var(--text-primary);">${r.year || '-'}</span> <span style="color:#93c5fd; font-weight:600;">${escapeHtml(r.season || '')}</span></td>
                            <td style="white-space: nowrap;"><span style="font-weight:600; color: var(--text-secondary);">${escapeHtml(r.grade || '-')}</span></td>
                            <td><span style="background:rgba(255,255,255,0.06); padding:2px 8px; border-radius:4px; font-size:0.82rem; font-weight:600;">${escapeHtml(r.tier || '-')}</span></td>
                            <td><b style="color:#a78bfa;">${escapeHtml(r.subject || '-')}</b></td>
                            <td style="font-weight:700; color: var(--text-primary);">${escapeHtml(r.class_name || '-')}</td>
                            <td>${r.created_by ? renderCreatorCell(r, false) : '<span style="color:var(--text-muted); font-size:0.75rem;">-</span>'}</td>
                            <td class="cell-mono" style="font-size:0.8rem; color:var(--text-secondary);">${formatTimestamp(r.created_at)}</td>
                            <td style="text-align: right; white-space: nowrap;">
                                <button type="button" class="btn-action edit" onclick="openDbRecordModal(${r.id})">编辑</button>
                                <button type="button" class="btn-action delete" onclick="deleteDbRecord(${r.id})">删除</button>
                            </td>
                        </tr>
                    `;
                }).join('');
            } else if (dbCurrentTable === 'retest_access_logs') {
                tbody.innerHTML = records.map((r, idx) => {
                    const isSelected = dbSelectedIds.has(r.id);
                    const detailsJson = r.details ? (typeof r.details === 'object' ? JSON.stringify(r.details) : String(r.details)) : '-';
                    return `
                        <tr>
                            <td style="text-align: center;">
                                <input type="checkbox" class="db-row-cb" data-id="${r.id}" ${isSelected ? 'checked' : ''} onchange="toggleDbSelectRow(${r.id}, this)" style="accent-color: var(--primary); cursor: pointer;">
                            </td>
                            <td class="cell-mono">${r.id}</td>
                            <td><span class="token-pill" onclick="copyDbToken('${escapeInlineJs(r.token)}')">${escapeHtml(r.token || '-')}</span></td>
                            <td style="font-weight:700; color: var(--text-primary);">${escapeHtml(r.student_name || '-')}</td>
                            <td><span class="action-tag action">${escapeHtml(r.action || '-')}</span></td>
                            <td style="max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:0.82rem; color: var(--text-secondary); cursor:pointer;" onclick="openDbDetailModal(${idx})" title="点击查看详情">
                                ${escapeHtml(detailsJson)}
                            </td>
                            <td class="cell-mono" style="font-size:0.8rem;">${escapeHtml(r.ip || '-')}</td>
                            <td class="cell-mono" style="font-size:0.8rem; color:var(--text-secondary);">${formatTimestamp(r.created_at)}</td>
                            <td style="text-align: right; white-space: nowrap;">
                                <button type="button" class="btn-action detail" onclick="openDbDetailModal(${idx})">详情</button>
                                <button type="button" class="btn-action delete" onclick="deleteDbRecord(${r.id})">删除</button>
                            </td>
                        </tr>
                    `;
                }).join('');
            } else if (dbCurrentTable === 'qbank_weeks') {
                tbody.innerHTML = records.map((r, idx) => {
                    const isSelected = dbSelectedIds.has(r.id);
                    return `
                        <tr>
                            <td style="text-align: center;">
                                <input type="checkbox" class="db-row-cb" data-id="${r.id}" ${isSelected ? 'checked' : ''} onchange="toggleDbSelectRow(${r.id}, this)" style="accent-color: var(--primary); cursor: pointer;">
                            </td>
                            <td class="cell-mono">${r.id}</td>
                            <td><span style="font-weight:700; color: var(--text-primary);">${r.year || '-'}</span> <span style="color:#93c5fd; font-weight:600;">${escapeHtml(r.season || '')}</span></td>
                            <td style="white-space: nowrap;"><span style="font-weight:600; color: var(--text-secondary);">${escapeHtml(r.grade || '-')}</span></td>
                            <td><span style="background:rgba(255,255,255,0.06); padding:2px 8px; border-radius:4px; font-size:0.82rem; font-weight:600;">${escapeHtml(r.tier || '-')}</span></td>
                            <td><b style="color:#a78bfa;">${escapeHtml(r.subject || '-')}</b></td>
                            <td style="text-align: center;"><span style="font-weight:700; color:#93c5fd; font-family:var(--font-mono); font-size:0.95rem;">第 ${r.week ?? '-'} 周</span></td>
                            <td style="text-align: center;"><span style="background:rgba(56,189,248,0.12); color:#38bdf8; border:1px solid rgba(56,189,248,0.3); padding:2px 8px; border-radius:12px; font-size:0.82rem; font-weight:700; font-family:var(--font-mono);">${r.question_count ?? 0} 题</span></td>
                            <td>${r.created_by ? renderCreatorCell(r, false) : '<span style="color:var(--text-muted); font-size:0.75rem;">-</span>'}</td>
                            <td class="cell-mono" style="font-size:0.8rem; color:var(--text-secondary);">${formatTimestamp(r.updated_at || r.created_at)}</td>
                            <td style="text-align: right; white-space: nowrap;">
                                <button type="button" class="btn-action edit" onclick="openDbRecordModal(${r.id})">编辑</button>
                                <button type="button" class="btn-action detail" onclick="openDbDetailModal(${idx})">详情</button>
                                <button type="button" class="btn-action delete" onclick="deleteDbRecord(${r.id})">删除</button>
                            </td>
                        </tr>
                    `;
                }).join('');
            } else if (dbCurrentTable === 'qbank_questions') {
                tbody.innerHTML = records.map((r, idx) => {
                    const isSelected = dbSelectedIds.has(r.id);
                    const exLink = r.exercise_pdf ? `<a href="${escapeHtml(r.exercise_pdf)}" target="_blank" class="file-tag" title="${escapeHtml(r.exercise_name || '题目PDF')}">题</a>` : '<span style="color:var(--text-muted); font-size:0.75rem;">-</span>';
                    const ansLink = r.answer_pdf ? `<a href="${escapeHtml(r.answer_pdf)}" target="_blank" class="file-tag answer" title="${escapeHtml(r.answer_name || '解析PDF')}">解</a>` : '<span style="color:var(--text-muted); font-size:0.75rem;">-</span>';
                    return `
                        <tr>
                            <td style="text-align: center;">
                                <input type="checkbox" class="db-row-cb" data-id="${r.id}" ${isSelected ? 'checked' : ''} onchange="toggleDbSelectRow(${r.id}, this)" style="accent-color: var(--primary); cursor: pointer;">
                            </td>
                            <td class="cell-mono">${r.id}</td>
                            <td style="text-align: center;"><span style="font-weight:800; color:#38bdf8; font-family:var(--font-mono); font-size:0.95rem;">第 ${r.question_num ?? '-'} 题</span></td>
                            <td>
                                <div style="font-weight:600; color: var(--text-primary); font-size:0.88rem; max-width:320px; line-height:1.4; word-break:break-word; cursor:pointer;" onclick="openDbDetailModal(${idx})" title="点击查看详情">
                                    ${escapeHtml(r.topic || '-')}
                                </div>
                            </td>
                            <td style="white-space: nowrap; font-size:0.85rem;">
                                <span style="color: var(--text-secondary);">${escapeHtml(r.grade || '')}</span> · <b style="color:#a78bfa;">${escapeHtml(r.subject || '')}</b> · <span style="background:rgba(255,255,255,0.06); padding:1px 6px; border-radius:4px; font-size:0.78rem;">${escapeHtml(r.tier || '')}</span>
                            </td>
                            <td style="text-align: center;"><span style="font-weight:700; color:#93c5fd; font-family:var(--font-mono); font-size:0.9rem;">第 ${r.week ?? '-'} 周</span></td>
                            <td style="font-size:0.85rem;">${r.year || '-'} <span style="color:#93c5fd; font-weight:600;">${escapeHtml(r.season || '')}</span></td>
                            <td style="text-align: center;">
                                <div style="display:inline-flex; gap:4px; align-items:center;">
                                    ${exLink}
                                    ${ansLink}
                                </div>
                            </td>
                            <td>${r.created_by ? renderCreatorCell(r, false) : '<span style="color:var(--text-muted); font-size:0.75rem;">-</span>'}</td>
                            <td class="cell-mono" style="font-size:0.8rem; color:var(--text-secondary);">${formatTimestamp(r.updated_at || r.created_at)}</td>
                            <td style="text-align: right; white-space: nowrap;">
                                <button type="button" class="btn-action edit" onclick="openDbRecordModal(${r.id})">编辑</button>
                                <button type="button" class="btn-action detail" onclick="openDbDetailModal(${idx})">详情</button>
                                <button type="button" class="btn-action delete" onclick="deleteDbRecord(${r.id})">删除</button>
                            </td>
                        </tr>
                    `;
                }).join('');
            } else if (dbCurrentTable === 'system_logs') {
                tbody.innerHTML = records.map((r, idx) => {
                    const isSelected = dbSelectedIds.has(r.id);
                    const detailsStr = r.details ? (typeof r.details === 'object' ? JSON.stringify(r.details) : String(r.details)) : '-';
                    const levelClass = (r.level || 'info').toLowerCase();
                    return `
                        <tr>
                            <td style="text-align: center;">
                                <input type="checkbox" class="db-row-cb" data-id="${r.id}" ${isSelected ? 'checked' : ''} onchange="toggleDbSelectRow(${r.id}, this)" style="accent-color: var(--primary); cursor: pointer;">
                            </td>
                            <td class="cell-mono">${r.id}</td>
                            <td><span class="log-level-badge level-${escapeHtml(levelClass)}">${escapeHtml(r.level || 'info')}</span></td>
                            <td><span class="module-badge">${escapeHtml(r.module || '-')}</span></td>
                            <td style="font-weight:600; color: var(--text-primary); font-family:var(--font-mono); font-size:0.82rem;">${escapeHtml(r.event || '-')}</td>
                            <td>${r.operator ? `<span style="font-size:0.78rem; font-weight:600; color:var(--text-primary); background:rgba(16,185,129,0.12); border:1px solid rgba(16,185,129,0.25); border-radius:4px; padding:2px 6px; display:inline-flex; align-items:center; gap:4px; white-space:nowrap;"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>${escapeHtml(r.operator_name ? r.operator_name : r.operator)}</span>` : '<span style="color:var(--text-muted); font-size:0.75rem;">系统</span>'}</td>
                            <td style="max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:0.82rem; color: var(--text-secondary); cursor:pointer;" onclick="openDbDetailModal(${idx})" title="点击查看详情">
                                ${escapeHtml(detailsStr)}
                            </td>
                            <td class="cell-mono" style="font-size:0.8rem;">${escapeHtml(r.client_ip || '-')}</td>
                            <td class="cell-mono" style="font-size:0.8rem; color:var(--text-secondary);">${formatTimestamp(r.created_at)}</td>
                            <td style="text-align: right; white-space: nowrap;">
                                <button type="button" class="btn-action detail" onclick="openDbDetailModal(${idx})">详情</button>
                                <button type="button" class="btn-action delete" onclick="deleteDbRecord(${r.id})">删除</button>
                            </td>
                        </tr>
                    `;
                }).join('');
            } else if (dbCurrentTable === 'admin_users') {
                tbody.innerHTML = records.map((r, idx) => {
                    const isSelected = dbSelectedIds.has(r.id);
                    const isSuper = r.role === 'super_admin';
                    const roleBadge = isSuper 
                        ? '<span class="role-badge super">超级管理员</span>' 
                        : '<span class="role-badge normal">管理员</span>';
                    const isActive = parseInt(r.status, 10) === 1;
                    const statusBadge = isActive 
                        ? '<span class="status-badge active"><span class="status-dot"></span>启用</span>' 
                        : '<span class="status-badge disabled"><span class="status-dot"></span>禁用</span>';
                    return `
                        <tr>
                            <td style="text-align: center;">
                                <input type="checkbox" class="db-row-cb" data-id="${r.id}" ${isSelected ? 'checked' : ''} onchange="toggleDbSelectRow(${r.id}, this)" style="accent-color: var(--primary); cursor: pointer;">
                            </td>
                            <td class="cell-mono">${r.id}</td>
                            <td><b style="color: var(--text-primary); font-size: 0.95rem;">${escapeHtml(r.username || '-')}</b></td>
                            <td><span style="color: var(--text-secondary);">${escapeHtml(r.real_name || '-')}</span></td>
                            <td>${roleBadge}</td>
                            <td style="text-align: center;">${statusBadge}</td>
                            <td><span class="cell-mono" style="color: var(--text-muted); font-size: 0.82rem; letter-spacing: 2px;">••••••••</span></td>
                            <td class="cell-mono" style="font-size: 0.8rem; color: var(--text-secondary);">${formatTimestamp(r.last_login_at)}</td>
                            <td class="cell-mono" style="font-size: 0.8rem; color: var(--text-secondary);">${escapeHtml(r.last_login_ip || '-')}</td>
                            <td class="cell-mono" style="font-size: 0.8rem; color: var(--text-secondary);">${formatTimestamp(r.created_at)}</td>
                            <td style="text-align: right; white-space: nowrap;">
                                <button type="button" class="btn-action edit" onclick="openDbRecordModal(${r.id})" title="编辑此管理员">编辑</button>
                                <button type="button" class="btn-action delete" onclick="deleteDbRecord(${r.id})" title="删除此账号">删除</button>
                            </td>
                        </tr>
                    `;
                }).join('');
            } else if (dbCurrentTable === 'users') {
                tbody.innerHTML = records.map((r, idx) => {
                    const isSelected = dbSelectedIds.has(r.id);
                    const isTest = r.username === '0';
                    const isActive = parseInt(r.status, 10) === 1;
                    const statusBadge = isActive 
                        ? '<span class="status-badge active"><span class="status-dot"></span>启用</span>' 
                        : '<span class="status-badge disabled"><span class="status-dot"></span>禁用</span>';

                    const astCount = (r.assistant_count !== undefined) ? r.assistant_count : (Array.isArray(r.assistants) ? r.assistants.length : 0);
                    const astBadge = astCount > 0
                        ? `<button type="button" class="btn-action" onclick="openDbDetailModal(${idx})" style="background:rgba(59,130,246,0.12); color:#60a5fa; border:1px solid rgba(59,130,246,0.3); font-size:0.76rem; padding:2px 8px; border-radius:12px; cursor:pointer; display:inline-flex; align-items:center; gap:4px;" title="查看此教师名下 ${astCount} 个助教详情"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>${astCount} 个助教</button>`
                        : `<span style="color:var(--text-muted); font-size:0.78rem;">无助教</span>`;

                    const pwdDisplay = isTest
                        ? '<span style="color:var(--text-muted); font-size:0.8rem;">公共体验免密/0</span>'
                        : (r.initial_password 
                            ? `<span class="cell-mono" style="color:var(--accent); font-size:0.82rem;" title="初始密码: ${escapeHtml(r.initial_password)}">初始: ${escapeHtml(r.initial_password)}</span>`
                            : '<span class="cell-mono" style="color:var(--text-muted); font-size:0.82rem; letter-spacing:2px;">••••••••</span>');

                    const actionBtns = isTest ? `
                        <button type="button" class="btn-action detail" onclick="openDbDetailModal(${idx})" title="查看教师详情与名下助教">详情</button>
                        <button type="button" class="btn-action edit" onclick="openDbRecordModal(${r.id})" title="编辑此账号">编辑</button>
                        <button type="button" class="btn-action" disabled title="测试账号不支持重置密码" style="opacity:0.4; cursor:not-allowed;">重置密码</button>
                        <button type="button" class="btn-action delete" disabled title="测试账号禁止删除" style="opacity:0.4; cursor:not-allowed;">删除</button>
                    ` : `
                        <button type="button" class="btn-action detail" onclick="openDbDetailModal(${idx})" title="查看教师详情与名下助教">详情</button>
                        <button type="button" class="btn-action edit" onclick="openDbRecordModal(${r.id})" title="编辑教师信息">编辑</button>
                        <button type="button" class="btn-action" style="color:var(--accent); border-color:rgba(10,132,255,0.3);" onclick="promptResetTeacherPwd(${r.id}, '${escapeInlineJs(r.username)}', '${escapeInlineJs(r.real_name || '')}')" title="重置教师密码">重置密码</button>
                        <button type="button" class="btn-action delete" onclick="deleteDbRecord(${r.id})" title="删除此教师账号">删除</button>
                    `;

                    return `
                        <tr>
                            <td style="text-align: center;">
                                <input type="checkbox" class="db-row-cb" data-id="${r.id}" ${isSelected ? 'checked' : ''} onchange="toggleDbSelectRow(${r.id}, this)" style="accent-color: var(--primary); cursor: pointer;">
                            </td>
                            <td class="cell-mono">${r.id}</td>
                            <td style="cursor: pointer;" onclick="openDbDetailModal(${idx})" title="点击查看教师详情"><b style="color: var(--text-primary); font-size: 0.95rem;">${escapeHtml(r.username || '-')}</b> ${isTest ? '<span style="font-size:0.75rem; background:rgba(245,158,11,0.15); color:#f59e0b; padding:1px 6px; border-radius:4px; margin-left:4px;">测试账号</span>' : ''}</td>
                            <td style="cursor: pointer;" onclick="openDbDetailModal(${idx})" title="点击查看教师详情"><span style="color: var(--text-secondary); font-weight: 500;">${escapeHtml(r.real_name || '-')}</span></td>
                            <td style="text-align: center;">${astBadge}</td>
                            <td style="text-align: center;">${statusBadge}</td>
                            <td>${pwdDisplay}</td>
                            <td class="cell-mono" style="font-size: 0.8rem; color: var(--text-secondary);">${formatTimestamp(r.last_login_at)}</td>
                            <td class="cell-mono" style="font-size: 0.8rem; color: var(--text-secondary);">${escapeHtml(r.last_login_ip || '-')}</td>
                            <td class="cell-mono" style="font-size: 0.8rem; color: var(--text-secondary);">${formatTimestamp(r.created_at)}</td>
                            <td style="text-align: right; white-space: nowrap;">
                                ${actionBtns}
                            </td>
                        </tr>
                    `;
                }).join('');
            } else {
                tbody.innerHTML = records.map((r, idx) => {
                    const isSelected = dbSelectedIds.has(r.id);
                    let rowTds = `
                        <td style="text-align: center;">
                            <input type="checkbox" class="db-row-cb" data-id="${r.id}" ${isSelected ? 'checked' : ''} onchange="toggleDbSelectRow(${r.id}, this)" style="accent-color: var(--primary); cursor: pointer;">
                        </td>
                    `;
                    schema.slice(0, 7).forEach(col => {
                        const colField = col.field || col.name;
                        let val = r[colField];
                        if (typeof val === 'object') val = JSON.stringify(val);
                        rowTds += `<td style="max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:0.85rem;">${escapeHtml(String(val ?? '-'))}</td>`;
                    });
                    rowTds += `
                        <td style="text-align: right; white-space: nowrap;">
                            <button type="button" class="btn-action edit" onclick="openDbRecordModal(${r.id})">编辑</button>
                            <button type="button" class="btn-action delete" onclick="deleteDbRecord(${r.id})">删除</button>
                        </td>
                    `;
                    return `<tr>${rowTds}</tr>`;
                }).join('');
            }
        }

        let dbViewMode = localStorage.getItem('db_view_mode') || (window.innerWidth <= 768 ? 'card' : 'table');

        function toggleDbViewMode() {
            dbViewMode = dbViewMode === 'card' ? 'table' : 'card';
            localStorage.setItem('db_view_mode', dbViewMode);
            applyDbViewMode();
        }

        function applyDbViewMode() {
            const tableWrap = document.getElementById('db-table-wrapper');
            const cardsWrap = document.getElementById('db-cards-wrapper');
            const btnText = document.getElementById('db-view-mode-text');
            const btnIcon = document.getElementById('db-view-mode-icon');
            const btn = document.getElementById('db-view-mode-btn');

            if (!tableWrap || !cardsWrap) return;

            if (dbViewMode === 'card') {
                tableWrap.style.display = 'none';
                cardsWrap.style.display = 'grid';
                if (btnText) btnText.textContent = '表格视图';
                if (btnIcon) btnIcon.innerHTML = SVG_VIEW_TABLE;
                if (btn) btn.title = '切换为表格视图';
            } else {
                tableWrap.style.display = 'block';
                cardsWrap.style.display = 'none';
                if (btnText) btnText.textContent = '卡片视图';
                if (btnIcon) btnIcon.innerHTML = SVG_VIEW_CARDS;
                if (btn) btn.title = '切换为卡片视图';
            }
        }

        function renderDbCards(records, schema) {
            const cardsWrap = document.getElementById('db-cards-wrapper');
            if (!cardsWrap) return;

            if (!records.length) {
                cardsWrap.innerHTML = `
                    <div class="empty-state" style="padding: 40px 16px;">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <circle cx="12" cy="12" r="10"></circle>
                            <line x1="8" y1="12" x2="16" y2="12"></line>
                        </svg>
                        <span>未查询到任何匹配的数据记录</span>
                    </div>
                `;
                return;
            }

            const allChecked = records.length > 0 && records.every(r => dbSelectedIds.has(r.id));
            let html = `
                <div class="db-cards-header-bar">
                    <label class="db-cards-select-all-label">
                        <input type="checkbox" id="db-cards-select-all" ${allChecked ? 'checked' : ''} onchange="toggleDbSelectAll(this)" style="accent-color: var(--primary); width: 16px; height: 16px; cursor: pointer;">
                        <span>全选本页 (${records.length} 条)</span>
                    </label>
                </div>
            `;

            if (dbCurrentTable === 'student_records') {
                html += records.map((r, idx) => {
                    const isSelected = dbSelectedIds.has(r.id);
                    const batchDesc = r.class_name ? escapeHtml(r.class_name) : (r.batch_id ? `批次 #${r.batch_id}` : '-');

                    const errBadges = formatRecordErrorBadges(r);

                    const tokenHtml = r.retest_token ? `
                        <span class="token-pill" onclick="copyDbToken('${escapeInlineJs(r.retest_token)}')" title="点击复制Token">
                            ${escapeHtml(r.retest_token)}
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg>
                        </span>
                    ` : '<span style="color:var(--text-muted); font-size:0.8rem;">-</span>';

                    const sId = (r.student_id || '').trim();
                    const sName = (r.student_name || '').trim();
                    const copyIdName = `${sId}${sName}`;
                    const gradeVal = r.grade || r._batch?.grade || '-';
                    const subjectVal = r.subject || r._batch?.subject || '-';
                    const tierVal = r.tier || r._batch?.tier || '-';

                    const hwScoreDisplay = (r.homework_score !== null && r.homework_score !== undefined && r.homework_score !== '') ? formatScore(r.homework_score) : '-';
                    const pvScoreDisplay = (r.preview_score !== null && r.preview_score !== undefined && r.preview_score !== '') ? formatScore(r.preview_score) : null;
                    const hasPreviewWeek = r.preview_week_num && r.preview_week_num != r.week_num;

                    return `
                        <div class="db-card-item ${isSelected ? 'selected' : ''}" data-id="${r.id}">
                            <div class="db-card-head">
                                <div class="db-card-head-left">
                                    <input type="checkbox" class="db-row-cb" data-id="${r.id}" ${isSelected ? 'checked' : ''} onchange="toggleDbSelectRow(${r.id}, this)" style="accent-color: var(--primary); cursor: pointer; width: 17px; height: 17px;">
                                    <div class="student-profile-chip" onclick="copyStudentIdName('${escapeInlineJs(copyIdName)}')" title="点击复制：${escapeHtml(copyIdName)}">
                                        <div>
                                            <div class="student-name-text">
                                                ${escapeHtml(r.student_name || '-')}
                                                <svg class="copy-icon-subtle" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="width: 12px; height: 12px; flex-shrink: 0;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg>
                                            </div>
                                            <div class="student-id-sub">${escapeHtml(r.student_id || '-')}</div>
                                        </div>
                                    </div>
                                </div>
                                <div class="db-card-head-right">
                                    <div style="display:flex; flex-direction:column; gap:3px; align-items:flex-end;">
                                        <span class="db-card-week-badge" title="课后巩固周次: 第${r.week_num ?? '-'}周" style="font-size:0.75rem; background:rgba(56,189,248,0.15); color:#38bdf8; border-color:rgba(56,189,248,0.3);">巩固: 第${r.week_num ?? '-'}周</span>
                                        <span class="db-card-week-badge" title="课前预习周次: 第${r.preview_week_num ?? '-'}周" style="font-size:0.75rem; background:rgba(245,158,11,0.15); color:#f59e0b; border-color:rgba(245,158,11,0.3);">预习: 第${r.preview_week_num ?? '-'}周</span>
                                    </div>
                                </div>
                            </div>

                            <div class="db-card-meta-grid">
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">年级 / 学科 / 班型</span>
                                    <span style="font-size:0.88rem;">
                                        ${escapeHtml(gradeVal)} · <b style="color:#a78bfa;">${escapeHtml(subjectVal)}</b> · <span style="background:rgba(255,255,255,0.08); padding:1px 6px; border-radius:4px; font-size:0.78rem; font-weight:600;">${escapeHtml(tierVal)}</span>
                                    </span>
                                </div>
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">成绩 (巩固 / 预习)</span>
                                    <div style="display:flex; align-items:center; gap:6px;">
                                        <span style="font-size:0.68rem; font-weight:600; padding:1px 4px; border-radius:3px; background:rgba(56,189,248,0.15); color:#38bdf8; border:1px solid rgba(56,189,248,0.3);">巩固</span>
                                        <b style="color:#38bdf8; font-family:var(--font-mono); font-size:1.02rem;">${hwScoreDisplay}${hwScoreDisplay !== '-' ? '分' : ''}</b>
                                        <span style="color:var(--text-muted); font-size:0.78rem; margin:0 2px;">/</span>
                                        <span style="font-size:0.68rem; font-weight:600; padding:1px 4px; border-radius:3px; background:rgba(245,158,11,0.15); color:#f59e0b; border:1px solid rgba(245,158,11,0.3);">预习</span>
                                        <b style="color:#f59e0b; font-family:var(--font-mono); font-size:0.95rem;">${pvScoreDisplay !== null ? `${pvScoreDisplay}分` : '-'}</b>
                                    </div>
                                </div>
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">生成教师</span>
                                    ${renderCreatorCell(r, true)}
                                </div>
                                <div class="db-card-meta-cell full-width">
                                    <span class="db-card-meta-label">错题情况 (巩固 / 预习)</span>
                                    <div style="display:flex; align-items:center; flex-wrap:wrap; gap:4px;">${errBadges}</div>
                                </div>
                            </div>

                            ${r.teacher_comment ? `
                            <div class="db-card-comment" onclick="openDbDetailModal(${idx})" title="点击查看完整巩固评语">
                                <span class="db-card-comment-icon"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></span>
                                <span class="db-card-comment-body"><b style="color:#38bdf8; font-weight:600;">[巩固评语]</b> ${escapeHtml(r.teacher_comment)}</span>
                            </div>` : ''}

                            ${r.preview_comment ? `
                            <div class="db-card-comment" onclick="openDbDetailModal(${idx})" title="点击查看完整预习评语" style="border-left: 3px solid #f59e0b; margin-top: 4px;">
                                <span class="db-card-comment-icon" style="color:#f59e0b;"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg></span>
                                <span class="db-card-comment-body"><b style="color:#f59e0b; font-weight:600;">[预习评语]</b> ${escapeHtml(r.preview_comment)}</span>
                            </div>` : ''}

                            <div class="db-card-footer">
                                <span class="db-card-time">${formatTimestamp(r.created_at)}</span>
                                <div class="db-card-btns">
                                    ${r.retest_token ? `<button type="button" class="btn-action retest" onclick="openRetestStudent('${escapeInlineJs(r.retest_token)}')" title="打开学员/家长端错题本（需输入姓名验证）">错题本</button>` : ''}
                                    ${r.retest_token ? `<button type="button" class="btn-action admin-retest" onclick="openRetestDirect('${escapeInlineJs(r.retest_token)}')" title="管理员免密直达错题本">管理员错题本</button>` : ''}
                                    <button type="button" class="btn-action edit" onclick="openDbRecordModal(${r.id})" title="编辑此记录">编辑</button>
                                    <button type="button" class="btn-action detail" onclick="openDbDetailModal(${idx})" title="查看完整详情">详情</button>
                                    <button type="button" class="btn-action delete" onclick="deleteDbRecord(${r.id})" title="删除此记录">删除</button>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('');
            } else if (dbCurrentTable === 'class_batches') {
                html += records.map((r, idx) => {
                    const isSelected = dbSelectedIds.has(r.id);
                    return `
                        <div class="db-card-item ${isSelected ? 'selected' : ''}" data-id="${r.id}">
                            <div class="db-card-head">
                                <div class="db-card-head-left">
                                    <input type="checkbox" class="db-row-cb" data-id="${r.id}" ${isSelected ? 'checked' : ''} onchange="toggleDbSelectRow(${r.id}, this)" style="accent-color: var(--primary); cursor: pointer; width: 17px; height: 17px;">
                                    <span style="font-weight:700; color: var(--text-primary); font-size:1rem;">${escapeHtml(r.class_name || '未命名班级')}</span>
                                </div>
                                <span class="db-card-id-tag">#${r.id}</span>
                            </div>
                            <div class="db-card-meta-grid">
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">年份 / 季度</span>
                                    <span>${r.year || '-'} <b style="color:#93c5fd;">${escapeHtml(r.season || '')}</b></span>
                                </div>
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">录入教师</span>
                                    ${renderCreatorCell(r, true)}
                                </div>
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">学科 / 班型</span>
                                    <span><b style="color:#a78bfa;">${escapeHtml(r.subject || '-')}</b> · ${escapeHtml(r.grade || '')} ${escapeHtml(r.tier || '')}</span>
                                </div>
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">生成教师</span>
                                    ${renderCreatorCell(r, true)}
                                </div>
                            </div>
                            <div class="db-card-footer">
                                <span class="db-card-time">${formatTimestamp(r.created_at)}</span>
                                <div class="db-card-btns">
                                    <button type="button" class="btn-action edit" onclick="openDbRecordModal(${r.id})">编辑</button>
                                    <button type="button" class="btn-action delete" onclick="deleteDbRecord(${r.id})">删除</button>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('');
            } else if (dbCurrentTable === 'retest_access_logs') {
                html += records.map((r, idx) => {
                    const isSelected = dbSelectedIds.has(r.id);
                    const detailsJson = r.details ? (typeof r.details === 'object' ? JSON.stringify(r.details) : String(r.details)) : '-';
                    return `
                        <div class="db-card-item ${isSelected ? 'selected' : ''}" data-id="${r.id}">
                            <div class="db-card-head">
                                <div class="db-card-head-left">
                                    <input type="checkbox" class="db-row-cb" data-id="${r.id}" ${isSelected ? 'checked' : ''} onchange="toggleDbSelectRow(${r.id}, this)" style="accent-color: var(--primary); cursor: pointer; width: 17px; height: 17px;">
                                    <span style="font-weight:700; color: var(--text-primary);">${escapeHtml(r.student_name || '访客')}</span>
                                    <span class="action-tag action" style="margin-left:6px;">${escapeHtml(r.action || '-')}</span>
                                </div>
                                <span class="db-card-id-tag">#${r.id}</span>
                            </div>
                            <div class="db-card-meta-grid">
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">Token</span>
                                    <span class="token-pill" onclick="copyDbToken('${escapeInlineJs(r.token)}')">${escapeHtml(r.token || '-')}</span>
                                </div>
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">IP 地址</span>
                                    <span class="cell-mono" style="font-size:0.8rem;">${escapeHtml(r.ip || '-')}</span>
                                </div>
                                <div class="db-card-meta-cell full-width" onclick="openDbDetailModal(${idx})" style="cursor:pointer;" title="点击查看详情">
                                    <span class="db-card-meta-label">详情内容</span>
                                    <span style="font-size:0.82rem; color: var(--text-secondary); word-break:break-all;">${escapeHtml(detailsJson)}</span>
                                </div>
                            </div>
                            <div class="db-card-footer">
                                <span class="db-card-time">${formatTimestamp(r.created_at)}</span>
                                <div class="db-card-btns">
                                    <button type="button" class="btn-action detail" onclick="openDbDetailModal(${idx})">详情</button>
                                    <button type="button" class="btn-action delete" onclick="deleteDbRecord(${r.id})">删除</button>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('');
            } else if (dbCurrentTable === 'qbank_weeks') {
                html += records.map((r, idx) => {
                    const isSelected = dbSelectedIds.has(r.id);
                    return `
                        <div class="db-card-item ${isSelected ? 'selected' : ''}" data-id="${r.id}">
                            <div class="db-card-head">
                                <div class="db-card-head-left">
                                    <input type="checkbox" class="db-row-cb" data-id="${r.id}" ${isSelected ? 'checked' : ''} onchange="toggleDbSelectRow(${r.id}, this)" style="accent-color: var(--primary); cursor: pointer; width: 17px; height: 17px;">
                                    <span style="font-weight:700; color: var(--text-primary); font-size:1rem;">第 ${r.week ?? '-'} 周</span>
                                    <span style="margin-left:6px;"><b style="color:#a78bfa;">${escapeHtml(r.subject || '')}</b> · ${escapeHtml(r.grade || '')} ${escapeHtml(r.tier || '')}</span>
                                </div>
                                <span class="db-card-id-tag">#${r.id}</span>
                            </div>
                            <div class="db-card-meta-grid">
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">年份 / 季度</span>
                                    <span>${r.year || '-'} <b style="color:#93c5fd;">${escapeHtml(r.season || '')}</b></span>
                                </div>
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">题目数量</span>
                                    <b style="color:#38bdf8; font-family:var(--font-mono); font-size:1rem;">${r.question_count ?? 0} 题</b>
                                </div>
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">录入教师</span>
                                    ${renderCreatorCell(r, true)}
                                </div>
                            </div>
                            <div class="db-card-footer">
                                <span class="db-card-time">${formatTimestamp(r.updated_at || r.created_at)}</span>
                                <div class="db-card-btns">
                                    <button type="button" class="btn-action edit" onclick="openDbRecordModal(${r.id})">编辑</button>
                                    <button type="button" class="btn-action detail" onclick="openDbDetailModal(${idx})">详情</button>
                                    <button type="button" class="btn-action delete" onclick="deleteDbRecord(${r.id})">删除</button>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('');
            } else if (dbCurrentTable === 'qbank_questions') {
                html += records.map((r, idx) => {
                    const isSelected = dbSelectedIds.has(r.id);
                    const exLink = r.exercise_pdf ? `<a href="${escapeHtml(r.exercise_pdf)}" target="_blank" class="file-tag" title="${escapeHtml(r.exercise_name || '题目PDF')}">题</a>` : '<span style="color:var(--text-muted); font-size:0.75rem;">无</span>';
                    const ansLink = r.answer_pdf ? `<a href="${escapeHtml(r.answer_pdf)}" target="_blank" class="file-tag answer" title="${escapeHtml(r.answer_name || '解析PDF')}">解</a>` : '<span style="color:var(--text-muted); font-size:0.75rem;">无</span>';
                    return `
                        <div class="db-card-item ${isSelected ? 'selected' : ''}" data-id="${r.id}">
                            <div class="db-card-head">
                                <div class="db-card-head-left">
                                    <input type="checkbox" class="db-row-cb" data-id="${r.id}" ${isSelected ? 'checked' : ''} onchange="toggleDbSelectRow(${r.id}, this)" style="accent-color: var(--primary); cursor: pointer; width: 17px; height: 17px;">
                                    <span style="font-weight:800; color:#38bdf8; font-size:1.05rem; font-family:var(--font-mono);">第 ${r.question_num ?? '-'} 题</span>
                                    <span style="margin-left:8px; font-size:0.85rem; color: var(--text-secondary);">
                                        ${escapeHtml(r.grade || '')} · <b style="color:#a78bfa;">${escapeHtml(r.subject || '')}</b> · <span style="background:rgba(255,255,255,0.06); padding:1px 6px; border-radius:4px; font-size:0.78rem;">${escapeHtml(r.tier || '')}</span>
                                    </span>
                                </div>
                                <span class="db-card-id-tag">#${r.id}</span>
                            </div>

                            <div style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:8px 12px; margin:8px 0; cursor:pointer;" onclick="openDbDetailModal(${idx})" title="点击查看考点与题目详情">
                                <div style="font-size:0.72rem; color:var(--primary); font-weight:700; margin-bottom:3px; text-transform:uppercase; letter-spacing:0.5px;">考点 / 考查知识点</div>
                                <div style="font-size:0.92rem; font-weight:600; color: var(--text-primary); line-height:1.4; word-break:break-word;">${escapeHtml(r.topic || '-')}</div>
                            </div>

                            <div class="db-card-meta-grid">
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">专题周次</span>
                                    <span style="font-weight:700; color:#93c5fd; font-family:var(--font-mono);">第 ${r.week ?? '-'} 周</span>
                                </div>
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">年份 / 季度</span>
                                    <span>${r.year || '-'} <b style="color:#93c5fd;">${escapeHtml(r.season || '')}</b></span>
                                </div>
                                <div class="db-card-meta-cell full-width">
                                    <span class="db-card-meta-label">文件资源</span>
                                    <div style="display:flex; gap:8px; align-items:center;">
                                        <span>原题: ${exLink}</span>
                                        <span style="margin-left:8px;">解析: ${ansLink}</span>
                                    </div>
                                </div>
                            </div>

                            <div class="db-card-footer">
                                <span class="db-card-time">${formatTimestamp(r.updated_at || r.created_at)}</span>
                                <div class="db-card-btns">
                                    <button type="button" class="btn-action edit" onclick="openDbRecordModal(${r.id})">编辑</button>
                                    <button type="button" class="btn-action detail" onclick="openDbDetailModal(${idx})">详情</button>
                                    <button type="button" class="btn-action delete" onclick="deleteDbRecord(${r.id})">删除</button>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('');
            } else if (dbCurrentTable === 'system_logs') {
                html += records.map((r, idx) => {
                    const isSelected = dbSelectedIds.has(r.id);
                    const detailsStr = r.details ? (typeof r.details === 'object' ? JSON.stringify(r.details) : String(r.details)) : '-';
                    const levelClass = (r.level || 'info').toLowerCase();
                    return `
                        <div class="db-card-item ${isSelected ? 'selected' : ''}" data-id="${r.id}">
                            <div class="db-card-head">
                                <div class="db-card-head-left" style="gap:6px; flex-wrap:wrap;">
                                    <input type="checkbox" class="db-row-cb" data-id="${r.id}" ${isSelected ? 'checked' : ''} onchange="toggleDbSelectRow(${r.id}, this)" style="accent-color: var(--primary); cursor: pointer; width: 17px; height: 17px;">
                                    <span class="log-level-badge level-${escapeHtml(levelClass)}">${escapeHtml(r.level || 'info')}</span>
                                    <span class="module-badge">${escapeHtml(r.module || '-')}</span>
                                    <span style="font-weight:600; color: var(--text-primary); font-family:var(--font-mono); font-size:0.85rem;">${escapeHtml(r.event || '-')}</span>
                                </div>
                                <span class="db-card-id-tag">#${r.id}</span>
                            </div>

                            <div class="db-card-meta-grid">
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">客户端 IP</span>
                                    <span class="cell-mono" style="font-size:0.8rem;">${escapeHtml(r.client_ip || '-')}</span>
                                </div>
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">操作人</span>
                                    <span style="font-weight:600; color:var(--text-primary);">${r.operator ? escapeHtml(r.operator_name || r.operator) : '系统'}</span>
                                </div>
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">日志 ID</span>
                                    <span class="cell-mono" style="font-size:0.75rem; color:var(--text-muted);">${escapeHtml(r.log_id || '-')}</span>
                                </div>
                                <div class="db-card-meta-cell full-width" onclick="openDbDetailModal(${idx})" style="cursor:pointer;" title="点击查看完整日志 JSON">
                                    <span class="db-card-meta-label">日志详情</span>
                                    <span style="font-size:0.82rem; color: var(--text-secondary); word-break:break-all;">${escapeHtml(detailsStr)}</span>
                                </div>
                            </div>

                            <div class="db-card-footer">
                                <span class="db-card-time">${formatTimestamp(r.created_at)}</span>
                                <div class="db-card-btns">
                                    <button type="button" class="btn-action detail" onclick="openDbDetailModal(${idx})">详情</button>
                                    <button type="button" class="btn-action delete" onclick="deleteDbRecord(${r.id})">删除</button>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('');
            } else if (dbCurrentTable === 'admin_users') {
                html += records.map((r, idx) => {
                    const isSelected = dbSelectedIds.has(r.id);
                    const isSuper = r.role === 'super_admin';
                    const roleBadge = isSuper 
                        ? '<span class="role-badge super">超级管理员</span>' 
                        : '<span class="role-badge normal">管理员</span>';
                    const isActive = parseInt(r.status, 10) === 1;
                    const statusBadge = isActive 
                        ? '<span class="status-badge active"><span class="status-dot"></span>启用</span>' 
                        : '<span class="status-badge disabled"><span class="status-dot"></span>禁用</span>';
                    return `
                        <div class="db-card-item ${isSelected ? 'selected' : ''}" data-id="${r.id}">
                            <div class="db-card-head">
                                <div class="db-card-head-left" style="gap:8px; align-items:center;">
                                    <input type="checkbox" class="db-row-cb" data-id="${r.id}" ${isSelected ? 'checked' : ''} onchange="toggleDbSelectRow(${r.id}, this)" style="accent-color: var(--primary); cursor: pointer; width: 17px; height: 17px;">
                                    <span style="font-weight:700; color: var(--text-primary); font-size:1.05rem;">${escapeHtml(r.username || '-')}</span>
                                    <span style="color:#94a3b8; font-size:0.88rem;">(${escapeHtml(r.real_name || '无备注')})</span>
                                </div>
                                <span class="db-card-id-tag">#${r.id}</span>
                            </div>
                            <div class="db-card-meta-grid">
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">权限角色</span>
                                    <div>${roleBadge}</div>
                                </div>
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">账号状态</span>
                                    <div>${statusBadge}</div>
                                </div>
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">最后登录时间</span>
                                    <span class="cell-mono" style="font-size:0.82rem;">${formatTimestamp(r.last_login_at)}</span>
                                </div>
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">最后登录 IP</span>
                                    <span class="cell-mono" style="font-size:0.82rem;">${escapeHtml(r.last_login_ip || '-')}</span>
                                </div>
                            </div>
                            <div class="db-card-footer">
                                <span class="db-card-time">创建于: ${formatTimestamp(r.created_at)}</span>
                                <div class="db-card-btns">
                                    <button type="button" class="btn-action edit" onclick="openDbRecordModal(${r.id})">编辑</button>
                                    <button type="button" class="btn-action delete" onclick="deleteDbRecord(${r.id})">删除</button>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('');
            } else if (dbCurrentTable === 'users') {
                html += records.map((r, idx) => {
                    const isSelected = dbSelectedIds.has(r.id);
                    const isTest = r.username === '0';
                    const isActive = parseInt(r.status, 10) === 1;
                    const statusBadge = isActive 
                        ? '<span class="status-badge active"><span class="status-dot"></span>启用</span>' 
                        : '<span class="status-badge disabled"><span class="status-dot"></span>禁用</span>';

                    const astCount = (r.assistant_count !== undefined) ? r.assistant_count : (Array.isArray(r.assistants) ? r.assistants.length : 0);
                    const astBadge = astCount > 0
                        ? `<button type="button" class="btn-action" onclick="openDbDetailModal(${idx})" style="background:rgba(59,130,246,0.12); color:#60a5fa; border:1px solid rgba(59,130,246,0.3); font-size:0.75rem; padding:2px 8px; border-radius:12px; cursor:pointer; display:inline-flex; align-items:center; gap:4px;" title="查看名下 ${astCount} 个助教"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>${astCount} 个助教</button>`
                        : `<span style="color:var(--text-muted); font-size:0.78rem;">无助教</span>`;

                    const actionBtns = isTest ? `
                        <button type="button" class="btn-action detail" onclick="openDbDetailModal(${idx})" title="查看教师档案与名下助教">详情</button>
                        <button type="button" class="btn-action edit" onclick="openDbRecordModal(${r.id})">编辑</button>
                        <button type="button" class="btn-action" disabled title="测试账号不支持重置密码" style="opacity:0.4; cursor:not-allowed;">重置密码</button>
                        <button type="button" class="btn-action delete" disabled title="测试账号禁止删除" style="opacity:0.4; cursor:not-allowed;">删除</button>
                    ` : `
                        <button type="button" class="btn-action detail" onclick="openDbDetailModal(${idx})" title="查看教师档案与名下助教">详情</button>
                        <button type="button" class="btn-action edit" onclick="openDbRecordModal(${r.id})">编辑</button>
                        <button type="button" class="btn-action" style="color:var(--accent); border-color:rgba(10,132,255,0.3);" onclick="promptResetTeacherPwd(${r.id}, '${escapeInlineJs(r.username)}', '${escapeInlineJs(r.real_name || '')}')">重置密码</button>
                        <button type="button" class="btn-action delete" onclick="deleteDbRecord(${r.id})">删除</button>
                    `;

                    return `
                        <div class="db-card-item ${isSelected ? 'selected' : ''}" data-id="${r.id}">
                            <div class="db-card-head">
                                <div class="db-card-head-left" style="gap:8px; align-items:center;">
                                    <input type="checkbox" class="db-row-cb" data-id="${r.id}" ${isSelected ? 'checked' : ''} onchange="toggleDbSelectRow(${r.id}, this)" style="accent-color: var(--primary); cursor: pointer; width: 17px; height: 17px;">
                                    <span style="font-weight:700; color: var(--text-primary); font-size:1.05rem; cursor:pointer;" onclick="openDbDetailModal(${idx})">${escapeHtml(r.username || '-')}</span>
                                    <span style="color:#94a3b8; font-size:0.88rem; cursor:pointer;" onclick="openDbDetailModal(${idx})">(${escapeHtml(r.real_name || '教师')})</span>
                                    ${isTest ? '<span style="font-size:0.75rem; background:rgba(245,158,11,0.15); color:#f59e0b; padding:1px 6px; border-radius:4px;">测试账号</span>' : ''}
                                </div>
                                <span class="db-card-id-tag">#${r.id}</span>
                            </div>
                            <div class="db-card-meta-grid">
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">名下助教</span>
                                    <div>${astBadge}</div>
                                </div>
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">账号状态</span>
                                    <div>${statusBadge}</div>
                                </div>
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">密码状态</span>
                                    <span style="font-size:0.82rem;">${isTest ? '公共体验/0' : (r.initial_password ? '初始: ' + escapeHtml(r.initial_password) : '已自定义')}</span>
                                </div>
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">最后登录时间</span>
                                    <span class="cell-mono" style="font-size:0.82rem;">${formatTimestamp(r.last_login_at)}</span>
                                </div>
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">最后登录 IP</span>
                                    <span class="cell-mono" style="font-size:0.82rem;">${escapeHtml(r.last_login_ip || '-')}</span>
                                </div>
                            </div>
                            <div class="db-card-footer">
                                <span class="db-card-time">创建于: ${formatTimestamp(r.created_at)}</span>
                                <div class="db-card-btns">
                                    ${actionBtns}
                                </div>
                            </div>
                        </div>
                    `;
                }).join('');
            } else {
                html += records.map((r, idx) => {
                    const isSelected = dbSelectedIds.has(r.id);
                    const entries = Object.entries(r).filter(([k]) => !k.includes('thumb')).slice(0, 6);
                    return `
                        <div class="db-card-item ${isSelected ? 'selected' : ''}" data-id="${r.id}">
                            <div class="db-card-head">
                                <div class="db-card-head-left">
                                    <input type="checkbox" class="db-row-cb" data-id="${r.id}" ${isSelected ? 'checked' : ''} onchange="toggleDbSelectRow(${r.id}, this)" style="accent-color: var(--primary); cursor: pointer; width: 17px; height: 17px;">
                                    <span style="font-weight:700; color: var(--text-primary);">记录 #${r.id}</span>
                                </div>
                            </div>
                            <div class="db-card-meta-grid">
                                ${entries.map(([k, v]) => `
                                    <div class="db-card-meta-cell">
                                        <span class="db-card-meta-label">${escapeHtml(k)}</span>
                                        <span style="font-size:0.82rem; word-break:break-all;">${escapeHtml(typeof v === 'object' ? JSON.stringify(v) : String(v ?? 'NULL'))}</span>
                                    </div>
                                `).join('')}
                            </div>
                            <div class="db-card-footer">
                                <div class="db-card-btns" style="width:100%; justify-content:flex-end;">
                                    <button type="button" class="btn-action edit" onclick="openDbRecordModal(${r.id})">编辑</button>
                                    <button type="button" class="btn-action detail" onclick="openDbDetailModal(${idx})">详情</button>
                                    <button type="button" class="btn-action delete" onclick="deleteDbRecord(${r.id})">删除</button>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('');
            }

            cardsWrap.innerHTML = html;
        }

        function renderDbPagination(page, totalPages, total) {
            const container = document.getElementById('db-pagination');
            if (!container) return;

            if (totalPages <= 1 && total <= 0) {
                container.innerHTML = '';
                return;
            }

            let html = `
                <div style="font-size:0.88rem; color:var(--text-secondary);">
                    共 <b style="color: var(--text-primary);">${total}</b> 条数据 · 第 <b style="color:var(--primary);">${page}</b> / ${totalPages || 1} 页
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    ${page > 1 ? `<button type="button" class="page-btn" onclick="loadDbData(${page - 1})">上一页</button>` : `<button type="button" class="page-btn" disabled>上一页</button>`}
                    <span style="font-size:0.88rem; font-weight:600; color: var(--text-primary); padding:0 6px;">${page}</span>
                    ${page < totalPages ? `<button type="button" class="page-btn" onclick="loadDbData(${page + 1})">下一页</button>` : `<button type="button" class="page-btn" disabled>下一页</button>`}
                </div>
            `;
            container.innerHTML = html;
        }

        function toggleDbSelectAll(masterCb) {
            const cbs = document.querySelectorAll('.db-row-cb');
            cbs.forEach(cb => {
                cb.checked = masterCb.checked;
                const id = parseInt(cb.getAttribute('data-id'), 10);
                if (masterCb.checked) {
                    dbSelectedIds.add(id);
                } else {
                    dbSelectedIds.delete(id);
                }
            });
            document.querySelectorAll('.db-card-item').forEach(card => {
                if (masterCb.checked) card.classList.add('selected');
                else card.classList.remove('selected');
            });
            const m1 = document.getElementById('db-select-all');
            const m2 = document.getElementById('db-cards-select-all');
            if (m1) m1.checked = masterCb.checked;
            if (m2) m2.checked = masterCb.checked;
            updateDbBatchDeleteBtn();
        }

        function toggleDbSelectRow(id, cb) {
            if (cb.checked) {
                dbSelectedIds.add(id);
            } else {
                dbSelectedIds.delete(id);
            }
            document.querySelectorAll(`.db-card-item[data-id="${id}"]`).forEach(card => {
                if (cb.checked) card.classList.add('selected');
                else card.classList.remove('selected');
            });
            document.querySelectorAll(`.db-row-cb[data-id="${id}"]`).forEach(c => {
                c.checked = cb.checked;
            });
            const allCbs = document.querySelectorAll('.db-row-cb');
            const masterCb = document.getElementById('db-select-all');
            const cardsMasterCb = document.getElementById('db-cards-select-all');
            const isAll = allCbs.length > 0 && Array.from(allCbs).every(c => c.checked);
            if (masterCb) masterCb.checked = isAll;
            if (cardsMasterCb) cardsMasterCb.checked = isAll;
            updateDbBatchDeleteBtn();
        }

        function updateDbBatchDeleteBtn() {
            const btn = document.getElementById('db-batch-delete-btn');
            const countSpan = document.getElementById('db-selected-count');
            if (!btn || !countSpan) return;

            const count = dbSelectedIds.size;
            countSpan.textContent = count;
            btn.style.display = count > 0 ? 'inline-flex' : 'none';
        }

        let dbModalActiveTable = null;

        async function openDbRecordModal(id = null, explicitTable = null) {
            const isEdit = id !== null && id !== undefined;
            dbModalActiveTable = explicitTable || dbCurrentTable;
            const modal = document.getElementById('db-record-modal');
            const title = document.getElementById('db-modal-title');
            const container = document.getElementById('db-form-fields-container');
            const pkInput = document.getElementById('db-record-pk');
            if (!modal || !container || !pkInput) return;

            pkInput.value = isEdit ? id : '';
            const tableNameZh = dbModalActiveTable === 'student_records' ? '学生学情错题' : (dbTables.find(t => t.name === dbModalActiveTable)?.friendly_name || dbModalActiveTable);
            title.textContent = (isEdit ? `编辑记录 #${id}` : '新增数据记录') + ` · ${tableNameZh}`;

            let recordData = {};
            if (isEdit) {
                try {
                    const res = await fetch(`${API_BASE}?action=db_get&table=${dbModalActiveTable}&id=${id}`);
                    const json = await res.json();
                    if (json.success && json.data?.record) {
                        recordData = json.data.record;
                    } else {
                        showToast(json.error || '获取记录失败', 'error');
                        return;
                    }
                } catch (e) {
                    showToast('网络请求失败', 'error');
                    return;
                }
            }

            if (dbModalActiveTable === 'student_records') {
                const batchOpts = dbBatchOptions.map(b => `
                    <option value="${b.id}" ${recordData.batch_id == b.id ? 'selected' : ''}>${escapeHtml(b.label)}</option>
                `).join('');

                let errQuestionsVal = '';
                if (recordData.error_questions) {
                    if (Array.isArray(recordData.error_questions)) {
                        errQuestionsVal = recordData.error_questions.join(', ');
                    } else {
                        try {
                            const parsed = JSON.parse(recordData.error_questions);
                            errQuestionsVal = Array.isArray(parsed) ? parsed.join(', ') : recordData.error_questions;
                        } catch (e) {
                            errQuestionsVal = recordData.error_questions;
                        }
                    }
                }

                let previewErrQuestionsVal = '';
                if (recordData.preview_error_questions) {
                    if (Array.isArray(recordData.preview_error_questions)) {
                        previewErrQuestionsVal = recordData.preview_error_questions.join(', ');
                    } else {
                        try {
                            const parsed = JSON.parse(recordData.preview_error_questions);
                            previewErrQuestionsVal = Array.isArray(parsed) ? parsed.join(', ') : recordData.preview_error_questions;
                        } catch (e) {
                            previewErrQuestionsVal = recordData.preview_error_questions;
                        }
                    }
                }

                container.innerHTML = `
                    <div class="form-grid">
                        <div class="form-field full-span">
                            <label>所属教学班级批次 *</label>
                            <select id="field-batch_id" class="custom-select" required>
                                <option value="">请选择所属班级期次</option>
                                ${batchOpts}
                            </select>
                            <span class="field-hint">关联 class_batches 班级实体，影响前台班级分组与排名基数</span>
                        </div>

                        <div class="form-field">
                            <label>学号 (Student ID) *</label>
                            <input type="text" id="field-student_id" value="${escapeHtml(recordData.student_id || '')}" placeholder="例如: 901001" required>
                        </div>

                        <div class="form-field">
                            <label>学员姓名 *</label>
                            <input type="text" id="field-student_name" value="${escapeHtml(recordData.student_name || '')}" placeholder="例如: 刘洋" required>
                        </div>

                        <div class="form-field">
                            <label>课后巩固专题周次 (1-25) *</label>
                            <input type="number" id="field-week_num" min="1" max="25" value="${recordData.week_num || 1}" required>
                        </div>

                        <div class="form-field">
                            <label>课前预习专题周次 (1-25)</label>
                            <input type="number" id="field-preview_week_num" min="1" max="25" value="${recordData.preview_week_num || recordData.week_num || 1}" placeholder="留空默认同巩固周次">
                        </div>

                        <div class="form-field">
                            <label>课后巩固得分</label>
                            <input type="number" id="field-homework_score" step="0.5" min="0" max="150" value="${recordData.homework_score ?? ''}" placeholder="0-100">
                        </div>

                        <div class="form-field">
                            <label>课前预习得分</label>
                            <input type="number" id="field-preview_score" step="0.5" min="0" max="150" value="${recordData.preview_score ?? ''}" placeholder="0-100">
                        </div>

                        <div class="form-field">
                            <label>总分 / 满分</label>
                            <input type="number" id="field-total_score" step="0.5" min="0" max="150" value="${recordData.total_score ?? ''}" placeholder="0-100">
                        </div>

                        <div class="form-field full-span">
                            <label>课后巩固错题题号 (自动转 JSON 并同步 error_count)</label>
                            <input type="text" id="field-error_questions" value="${escapeHtml(errQuestionsVal)}" placeholder="例如: 1, 3, 5 或留空代表满分全对">
                            <span class="field-hint">支持中英文逗号如“1, 3, 5”；保存时将自动转换为标准 JSON 数组并自动重计错题总数。</span>
                        </div>

                        <div class="form-field full-span">
                            <label>课前预习错题题号 (自动转 JSON)</label>
                            <input type="text" id="field-preview_error_questions" value="${escapeHtml(previewErrQuestionsVal)}" placeholder="例如: 2, 4 或留空代表满分全对">
                            <span class="field-hint">支持中英文逗号如“2, 4”；保存时将自动转换为标准 JSON 数组。</span>
                        </div>

                        <div class="form-field full-span">
                            <label>课后巩固教师针对性评语</label>
                            <textarea id="field-teacher_comment" rows="3" placeholder="例如: 思路整体清晰，第3题注意受力分析图与矢量方向...">${escapeHtml(recordData.teacher_comment || '')}</textarea>
                        </div>

                        <div class="form-field full-span">
                            <label>课前预习针对性评语</label>
                            <textarea id="field-preview_comment" rows="3" placeholder="例如: 预习概念理解深入，第2题公式定义稍有遗漏...">${escapeHtml(recordData.preview_comment || '')}</textarea>
                        </div>

                        <div class="form-field full-span">
                            <label>重测专属防伪 Token</label>
                            <div style="display:flex; gap:8px;">
                                <input type="text" id="field-retest_token" value="${escapeHtml(recordData.retest_token || '')}" placeholder="留空时系统将自动生成 8 位专属防伪 Token">
                                <button type="button" class="btn secondary" style="white-space:nowrap;" onclick="generateRandomToken()">随机生成</button>
                            </div>
                            <span class="field-hint">8~16 位防伪字符串，用于家长手机端查阅或学生扫码重测试题时验证身份。</span>
                        </div>
                    </div>
                `;
            } else if (dbModalActiveTable === 'class_batches') {
                container.innerHTML = `
                    <div class="form-grid">
                        <div class="form-field">
                            <label>教学年份 (Year) *</label>
                            <input type="number" id="field-year" min="2020" max="2035" value="${recordData.year || 2026}" required>
                        </div>

                        <div class="form-field">
                            <label>教学季度 (Season) *</label>
                            <select id="field-season" class="custom-select" required>
                                <option value="寒假" ${recordData.season === '寒假' ? 'selected' : ''}>寒假</option>
                                <option value="春季" ${recordData.season === '春季' || !recordData.season ? 'selected' : ''}>春季</option>
                                <option value="暑假" ${recordData.season === '暑假' ? 'selected' : ''}>暑假</option>
                                <option value="秋季" ${recordData.season === '秋季' ? 'selected' : ''}>秋季</option>
                            </select>
                        </div>

                        <div class="form-field">
                            <label>年级 (Grade) *</label>
                            <input type="text" id="field-grade" value="${escapeHtml(recordData.grade || '高二')}" placeholder="例如: 高一, 高二" required>
                        </div>

                        <div class="form-field">
                            <label>班型 (Tier) *</label>
                            <input type="text" id="field-tier" value="${escapeHtml(recordData.tier || '培优班')}" placeholder="例如: 培优班, 尖子班" required>
                        </div>

                        <div class="form-field">
                            <label>学科 (Subject) *</label>
                            <input type="text" id="field-subject" value="${escapeHtml(recordData.subject || '物理')}" placeholder="例如: 物理, 数学" required>
                        </div>

                        <div class="form-field">
                            <label>班级全称 (Class Name) *</label>
                            <input type="text" id="field-class_name" value="${escapeHtml(recordData.class_name || '')}" placeholder="例如: 高二物理培优1班" required>
                        </div>
                    </div>
                `;
            } else if (dbModalActiveTable === 'qbank_weeks') {
                container.innerHTML = `
                    <div class="form-grid">
                        <div class="form-field">
                            <label>教学年份 (Year) *</label>
                            <input type="number" id="field-year" min="2020" max="2035" value="${recordData.year || 2026}" required>
                        </div>
                        <div class="form-field">
                            <label>季度 (Season) *</label>
                            <input type="text" id="field-season" value="${escapeHtml(recordData.season || '春')}" placeholder="例如: 春, 寒, 暑, 秋" required>
                        </div>
                        <div class="form-field">
                            <label>年级 (Grade) *</label>
                            <input type="text" id="field-grade" value="${escapeHtml(recordData.grade || '高一')}" placeholder="例如: 高一, 高二" required>
                        </div>
                        <div class="form-field">
                            <label>班型 (Tier) *</label>
                            <input type="text" id="field-tier" value="${escapeHtml(recordData.tier || 'S')}" placeholder="例如: S, A, A+" required>
                        </div>
                        <div class="form-field">
                            <label>学科 (Subject) *</label>
                            <input type="text" id="field-subject" value="${escapeHtml(recordData.subject || '英语')}" placeholder="例如: 英语, 物理" required>
                        </div>
                        <div class="form-field">
                            <label>专题周次 (Week) *</label>
                            <input type="number" id="field-week" min="1" max="25" value="${recordData.week || 1}" required>
                        </div>
                        <div class="form-field full-span">
                            <label>题目总数 (Question Count)</label>
                            <input type="number" id="field-question_count" min="0" value="${recordData.question_count || 0}">
                        </div>
                    </div>
                `;
            } else if (dbModalActiveTable === 'qbank_questions') {
                container.innerHTML = `
                    <div class="form-grid">
                        <div class="form-field">
                            <label>题号 (Question Num) *</label>
                            <input type="number" id="field-question_num" min="1" max="100" value="${recordData.question_num || 1}" required>
                        </div>
                        <div class="form-field">
                            <label>所属题库期次 ID (qbank_id)</label>
                            <input type="number" id="field-qbank_id" value="${recordData.qbank_id || ''}" placeholder="对应 qbank_weeks 的 ID">
                        </div>
                        <div class="form-field full-span">
                            <label>考点 / 考查知识点 (Topic) *</label>
                            <input type="text" id="field-topic" value="${escapeHtml(recordData.topic || '')}" placeholder="例如: 16. lie过去式lay / 动词时态与语态" required>
                            <span class="field-hint">对应题库中的重要考点或知识点说明，展示在错题本及后台管理中</span>
                        </div>
                        <div class="form-field full-span">
                            <label>微课讲解链接 (Video URL)</label>
                            <input type="url" id="field-video_url" value="${escapeHtml(recordData.video_url || '')}" placeholder="例如: https://... 或微课视频地址">
                            <span class="field-hint">填写本题对应的微课视频或网页讲解链接（选填）</span>
                        </div>
                        <div class="form-field">
                            <label>年份 (Year) *</label>
                            <input type="number" id="field-year" min="2020" max="2035" value="${recordData.year || 2026}" required>
                        </div>
                        <div class="form-field">
                            <label>季度 (Season) *</label>
                            <input type="text" id="field-season" value="${escapeHtml(recordData.season || '春')}" placeholder="例如: 春, 寒, 暑, 秋" required>
                        </div>
                        <div class="form-field">
                            <label>年级 (Grade) *</label>
                            <input type="text" id="field-grade" value="${escapeHtml(recordData.grade || '高一')}" placeholder="例如: 高一, 高二" required>
                        </div>
                        <div class="form-field">
                            <label>班型 (Tier) *</label>
                            <input type="text" id="field-tier" value="${escapeHtml(recordData.tier || 'S')}" placeholder="例如: S, A, A+" required>
                        </div>
                        <div class="form-field">
                            <label>学科 (Subject) *</label>
                            <input type="text" id="field-subject" value="${escapeHtml(recordData.subject || '英语')}" placeholder="例如: 英语, 物理" required>
                        </div>
                        <div class="form-field">
                            <label>专题周次 (Week) *</label>
                            <input type="number" id="field-week" min="1" max="25" value="${recordData.week || 1}" required>
                        </div>
                        <div class="form-field">
                            <label>题目 / 错题 PDF 路径 *</label>
                            <input type="text" id="field-exercise_pdf" value="${escapeHtml(recordData.exercise_pdf || '')}" placeholder="data/pdfs/..." required>
                        </div>
                        <div class="form-field">
                            <label>题目原文件名</label>
                            <input type="text" id="field-exercise_name" value="${escapeHtml(recordData.exercise_name || '')}" placeholder="题目_第16题.pdf">
                        </div>
                        <div class="form-field">
                            <label>解析 PDF 路径</label>
                            <input type="text" id="field-answer_pdf" value="${escapeHtml(recordData.answer_pdf || '')}" placeholder="data/pdfs/...">
                        </div>
                        <div class="form-field">
                            <label>解析原文件名</label>
                            <input type="text" id="field-answer_name" value="${escapeHtml(recordData.answer_name || '')}" placeholder="解析_第16题.pdf">
                        </div>
                    </div>
                `;
            } else if (dbModalActiveTable === 'admin_users') {
                container.innerHTML = `
                    <div class="form-grid">
                        <div class="form-field">
                            <label>登录账号 (Username) *</label>
                            <input type="text" id="field-username" value="${escapeHtml(recordData.username || '')}" placeholder="例如: tinsy" required autocomplete="off">
                            <span class="field-hint">用于登录管理后台的唯一英文字符账号</span>
                        </div>
                        <div class="form-field">
                            <label>姓名 / 备注 (Real Name)</label>
                            <input type="text" id="field-real_name" value="${escapeHtml(recordData.real_name || '')}" placeholder="例如: 超级管理员 / 李老师">
                            <span class="field-hint">管理员真实姓名或备注信息</span>
                        </div>
                        <div class="form-field full-span">
                            <label>登录密码 (Password) ${isEdit ? '<span style="color:var(--text-muted); font-weight:normal;">(留空表示保持原密码不变)</span>' : '*'}</label>
                            <input type="password" id="field-password" placeholder="${isEdit ? '留空表示不修改密码' : '请输入初始登录密码（至少6位）'}" ${isEdit ? '' : 'required'} autocomplete="new-password">
                            <span class="field-hint">${isEdit ? '如无需修改密码直接留空；若输入新密码，后台将自动进行 BCrypt 高强度哈希存储' : '新密码将自动采用安全 BCrypt 哈希加密存储入库'}</span>
                        </div>
                        <div class="form-field">
                            <label>角色权限 (Role) *</label>
                            <select id="field-role" class="custom-select" required>
                                <option value="super_admin" ${recordData.role === 'super_admin' || !recordData.role ? 'selected' : ''}>超级管理员 (super_admin)</option>
                                <option value="admin" ${recordData.role === 'admin' ? 'selected' : ''}>普通管理员 (admin)</option>
                            </select>
                        </div>
                        <div class="form-field">
                            <label>账号状态 (Status) *</label>
                            <select id="field-status" class="custom-select" required>
                                <option value="1" ${recordData.status === undefined || parseInt(recordData.status, 10) === 1 ? 'selected' : ''}>启用 (正常登录)</option>
                                <option value="0" ${parseInt(recordData.status, 10) === 0 ? 'selected' : ''}>禁用 (禁止登录)</option>
                            </select>
                        </div>
                    </div>
                `;
            } else if (dbModalActiveTable === 'users') {
                const isTest = isEdit && recordData.username === '0';
                container.innerHTML = `
                    <div class="form-grid">
                        <div class="form-field">
                            <label>教师账号 (Username) *</label>
                            <input type="text" id="field-username" value="${escapeHtml(recordData.username || '')}" placeholder="例如: JF001" ${isTest ? 'readonly style="opacity:0.75;"' : ''} required autocomplete="off">
                            <span class="field-hint">${isTest ? '测试账号为公共系统账号，工号不可更改' : '前台教师唯一登录工号或账号（如 JF001）'}</span>
                        </div>
                        <div class="form-field">
                            <label>教师姓名 (Real Name) *</label>
                            <input type="text" id="field-real_name" value="${escapeHtml(recordData.real_name || '')}" placeholder="例如: 张老师" required>
                            <span class="field-hint">教师展示名称，将显示在错题记录与反馈生成卡片中</span>
                        </div>
                        <div class="form-field">
                            <label>登录密码 (Password) ${isEdit ? (isTest ? '' : '<span style="color:var(--text-muted); font-weight:normal;">(留空表示保持原密码不变)</span>') : '*'}</label>
                            <input type="password" id="field-password" placeholder="${isTest ? '系统保留账号禁止修改密码' : (isEdit ? '留空表示不修改密码（新密码至少6位）' : '请输入登录密码（至少6位）')}" ${isTest ? 'disabled style="opacity:0.65; cursor:not-allowed;"' : (isEdit ? 'minlength="6"' : 'required minlength="6"')} autocomplete="new-password">
                            <span class="field-hint">${isTest ? '测试账号 (0) 为系统保留账号，不支持修改或重置密码' : (isEdit ? '如无需修改密码直接留空；若输入新密码，后台将自动进行 BCrypt 哈希存储' : '必填，长度至少 6 位；后台将自动采用安全 BCrypt 哈希加密存储')}</span>
                        </div>
                        <div class="form-field">
                            <label>账号状态 (Status) *</label>
                            <select id="field-status" class="custom-select" required>
                                <option value="1" ${recordData.status === undefined || parseInt(recordData.status, 10) === 1 ? 'selected' : ''}>启用 (允许登录)</option>
                                <option value="0" ${parseInt(recordData.status, 10) === 0 ? 'selected' : ''}>禁用 (禁止登录)</option>
                            </select>
                            <span class="field-hint">停用后该教师及名下助教状态需分别控制，本账号将无法登录</span>
                        </div>
                    </div>
                `;
            } else {
                const schema = dbSchemaMap[dbCurrentTable] || [];
                let fieldsHtml = '<div class="form-grid">';
                schema.forEach(col => {
                    const colName = col.field || col.name;
                    if (col.primary_key || colName === 'id' || colName === 'created_at' || colName === 'updated_at') return;
                    const val = recordData[colName] !== undefined ? recordData[colName] : (col.default || '');
                    const isLongText = (col.type || '').includes('text') || (col.type || '').includes('json');
                    fieldsHtml += `
                        <div class="form-field ${isLongText ? 'full-span' : ''}">
                            <label>${escapeHtml(col.comment || colName)} (${colName})</label>
                            ${isLongText ? `
                                <textarea id="field-${colName}" rows="3">${escapeHtml(typeof val === 'object' ? JSON.stringify(val) : String(val ?? ''))}</textarea>
                            ` : `
                                <input type="text" id="field-${colName}" value="${escapeHtml(String(val ?? ''))}">
                            `}
                        </div>
                    `;
                });
                fieldsHtml += '</div>';
                container.innerHTML = fieldsHtml;
            }

            if (window.DialogHelper) {
                window.DialogHelper.open(modal, { dismissible: true });
            } else {
                modal.style.display = 'flex';
            }
        }

        function generateRandomToken() {
            const chars = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
            let res = '';
            for (let i = 0; i < 8; i++) {
                res += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            const input = document.getElementById('field-retest_token');
            if (input) input.value = res;
        }

        function closeDbRecordModal() {
            const modal = document.getElementById('db-record-modal');
            if (modal) {
                if (window.DialogHelper) {
                    window.DialogHelper.close(modal);
                } else {
                    modal.style.display = 'none';
                }
            }
        }

        async function saveDbRecord() {
            const pk = document.getElementById('db-record-pk')?.value;
            const isEdit = !!pk;
            const saveBtn = document.getElementById('db-modal-save-btn');
            if (saveBtn) {
                saveBtn.disabled = true;
                saveBtn.textContent = '正在保存...';
            }

            const data = {};
            const schema = dbSchemaMap[dbCurrentTable] || [];

            const activeTable = dbModalActiveTable || dbCurrentTable;
            if (activeTable === 'student_records') {
                const batchId = document.getElementById('field-batch_id')?.value;
                const studentId = document.getElementById('field-student_id')?.value.trim();
                const studentName = document.getElementById('field-student_name')?.value.trim();
                const weekNum = document.getElementById('field-week_num')?.value;
                const previewWeekNum = document.getElementById('field-preview_week_num')?.value;
                const previewScore = document.getElementById('field-preview_score')?.value;
                const homeworkScore = document.getElementById('field-homework_score')?.value;
                const totalScore = document.getElementById('field-total_score')?.value;
                const errorQuestions = document.getElementById('field-error_questions')?.value.trim();
                const previewErrorQuestions = document.getElementById('field-preview_error_questions')?.value.trim();
                const teacherComment = document.getElementById('field-teacher_comment')?.value;
                const previewComment = document.getElementById('field-preview_comment')?.value;
                const retestToken = document.getElementById('field-retest_token')?.value.trim();

                if (!studentId || !studentName) {
                    showToast('学号与学员姓名为必填项', 'warn');
                    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存数据记录'; }
                    return;
                }

                data.batch_id = batchId ? parseInt(batchId, 10) : null;
                data.student_id = studentId;
                data.student_name = studentName;
                data.week_num = weekNum ? parseInt(weekNum, 10) : 1;
                data.preview_week_num = previewWeekNum ? parseInt(previewWeekNum, 10) : data.week_num;
                data.preview_score = previewScore !== '' ? parseFloat(previewScore) : null;
                data.homework_score = homeworkScore !== '' ? parseFloat(homeworkScore) : null;
                data.total_score = totalScore !== '' ? parseFloat(totalScore) : null;
                data.error_questions = errorQuestions;
                data.preview_error_questions = previewErrorQuestions;
                data.teacher_comment = teacherComment;
                data.preview_comment = previewComment;
                data.retest_token = retestToken;
            } else if (activeTable === 'class_batches') {
                data.year = parseInt(document.getElementById('field-year')?.value, 10) || 2026;
                data.season = document.getElementById('field-season')?.value || '春季';
                data.grade = document.getElementById('field-grade')?.value.trim();
                data.tier = document.getElementById('field-tier')?.value.trim();
                data.subject = document.getElementById('field-subject')?.value.trim();
                data.class_name = document.getElementById('field-class_name')?.value.trim();

                if (!data.class_name) {
                    showToast('班级全称为必填项', 'warn');
                    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存数据记录'; }
                    return;
                }
            } else if (activeTable === 'qbank_weeks') {
                data.year = parseInt(document.getElementById('field-year')?.value, 10) || 2026;
                data.season = document.getElementById('field-season')?.value.trim() || '春';
                data.grade = document.getElementById('field-grade')?.value.trim();
                data.tier = document.getElementById('field-tier')?.value.trim();
                data.subject = document.getElementById('field-subject')?.value.trim();
                data.week = parseInt(document.getElementById('field-week')?.value, 10) || 1;
                const countVal = document.getElementById('field-question_count')?.value;
                if (countVal !== '') data.question_count = parseInt(countVal, 10);
            } else if (activeTable === 'qbank_questions') {
                const qbId = document.getElementById('field-qbank_id')?.value;
                if (qbId) data.qbank_id = parseInt(qbId, 10);
                data.question_num = parseInt(document.getElementById('field-question_num')?.value, 10) || 1;
                data.topic = document.getElementById('field-topic')?.value.trim();
                data.video_url = document.getElementById('field-video_url')?.value.trim() || '';
                data.year = parseInt(document.getElementById('field-year')?.value, 10) || 2026;
                data.season = document.getElementById('field-season')?.value.trim() || '春';
                data.grade = document.getElementById('field-grade')?.value.trim();
                data.tier = document.getElementById('field-tier')?.value.trim();
                data.subject = document.getElementById('field-subject')?.value.trim();
                data.week = parseInt(document.getElementById('field-week')?.value, 10) || 1;
                data.exercise_pdf = document.getElementById('field-exercise_pdf')?.value.trim();
                data.exercise_name = document.getElementById('field-exercise_name')?.value.trim();
                data.answer_pdf = document.getElementById('field-answer_pdf')?.value.trim();
                data.answer_name = document.getElementById('field-answer_name')?.value.trim();

                if (!data.topic) {
                    showToast('考查知识点 (Topic) 为必填项', 'warn');
                    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存数据记录'; }
                    return;
                }
                if (!data.exercise_pdf) {
                    showToast('题目 PDF 文件路径为必填项', 'warn');
                    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存数据记录'; }
                    return;
                }
            } else if (activeTable === 'admin_users') {
                const username = document.getElementById('field-username')?.value.trim();
                const realName = document.getElementById('field-real_name')?.value.trim();
                const password = document.getElementById('field-password')?.value;
                const role = document.getElementById('field-role')?.value;
                const status = document.getElementById('field-status')?.value;

                if (!username) {
                    showToast('登录用户名不能为空', 'warn');
                    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存数据记录'; }
                    return;
                }
                if (!isEdit && !password) {
                    showToast('新增管理员必须设置初始登录密码', 'warn');
                    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存数据记录'; }
                    return;
                }

                data.username = username;
                data.real_name = realName;
                if (password) {
                    data.password = password;
                }
                data.role = role || 'admin';
                data.status = parseInt(status, 10) === 0 ? 0 : 1;
            } else if (activeTable === 'users') {
                const username = document.getElementById('field-username')?.value.trim();
                const realName = document.getElementById('field-real_name')?.value.trim();
                const status = document.getElementById('field-status')?.value;
                const password = document.getElementById('field-password')?.value.trim() || '';

                if (!username) {
                    showToast('教师账号不能为空', 'warn');
                    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存数据记录'; }
                    return;
                }
                if (!isEdit && !password) {
                    showToast('新增教师账号必须设置登录密码', 'warn');
                    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存数据记录'; }
                    return;
                }
                if (password && password.length < 6) {
                    showToast('登录密码长度不能少于 6 位', 'warn');
                    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存数据记录'; }
                    return;
                }
                data.username = username;
                data.real_name = realName || username;
                data.status = parseInt(status, 10) === 0 ? 0 : 1;
                if (password && username !== '0') {
                    data.password = password;
                }
            } else {
                schema.forEach(col => {
                    const colName = col.field || col.name;
                    if (col.primary_key || colName === 'id' || colName === 'created_at' || colName === 'updated_at') return;
                    const el = document.getElementById(`field-${colName}`);
                    if (el) data[colName] = el.value;
                });
            }

            try {
                const action = isEdit ? 'db_update' : 'db_create';
                const payload = {
                    table: activeTable,
                    data: data
                };
                if (isEdit) payload.id = pk;

                const res = await fetch(`${API_BASE}?action=${action}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const json = await res.json();
                if (json.success) {
                    closeDbRecordModal();
                    showToast(isEdit ? '记录更新成功' : '新记录已入库', 'success');
                    if (activeTable === 'student_records') {
                        loadRecordsStats();
                        loadRecordsData(recCurrentPage);
                    }
                    if (activeTable === 'class_batches') {
                        await loadDbBatchOptions();
                    }
                    if (activeTable === 'users' && typeof loadTeachersData === 'function') {
                        loadTeachersData(isEdit ? teacherCurrentPage : 1);
                    }
                    loadDbData(dbCurrentPage);
                    if (typeof loadDbTables === 'function') {
                        loadDbTables();
                    }
                } else {
                    showToast(json.error || '保存数据失败', 'error');
                }
            } catch (e) {
                showToast('网络请求失败', 'error');
            } finally {
                if (saveBtn) {
                    saveBtn.disabled = false;
                    saveBtn.textContent = '保存数据记录';
                }
            }
        }

        async function promptResetTeacherPwd(id, username, realName) {
            if (username === '0') {
                showToast('测试账号（0）为系统公共体验账号，不支持重置密码', 'warn');
                return;
            }
            const displayName = realName ? `${realName} (${username})` : username;
            const newPwd = prompt(`请输入教师【${displayName}】的新密码（至少6位）：`, '123456');
            if (newPwd === null) return;
            const trimmed = newPwd.trim();
            if (!trimmed || trimmed.length < 6) {
                showToast('新密码长度不能少于 6 位', 'warn');
                return;
            }

            try {
                const res = await fetch(`${API_BASE}?action=db_reset_teacher_password`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id, username, password: trimmed })
                });
                const json = await res.json();
                if (json.success) {
                    showToast(`教师【${displayName}】密码已重置`, 'success');
                    loadDbData(dbCurrentPage);
                } else {
                    showToast(json.error || '重置失败', 'error');
                }
            } catch (e) {
                showToast('网络请求失败，请稍后重试', 'error');
            }
        }
        window.promptResetTeacherPwd = promptResetTeacherPwd;

        async function deleteDbRecord(id) {
            const confirmed = await showConfirm(
                '永久删除确认',
                `您确定要永久删除第 ${id} 号数据记录吗？此操作将无法撤销。`,
                true
            );
            if (!confirmed) return;

            try {
                const res = await fetch(`${API_BASE}?action=db_delete`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        table: dbCurrentTable,
                        ids: [id]
                    })
                });
                const json = await res.json();
                if (json.success) {
                    dbSelectedIds.delete(id);
                    updateDbBatchDeleteBtn();
                    showToast(`第 ${id} 号数据记录已成功删除`, 'success');
                    loadDbData(dbCurrentPage);
                } else {
                    showToast(json.error || '删除失败', 'error');
                }
            } catch (e) {
                showToast('网络请求失败', 'error');
            }
        }

        async function batchDeleteDbRecords() {
            const count = dbSelectedIds.size;
            if (count === 0) return;

            const confirmed = await showConfirm(
                '高危操作：批量删除',
                `注意：您当前选中了 ${count} 条记录。确定要一并永久删除吗？此操作无法撤销。`,
                true
            );
            if (!confirmed) return;

            try {
                const res = await fetch(`${API_BASE}?action=db_delete`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        table: dbCurrentTable,
                        ids: Array.from(dbSelectedIds)
                    })
                });
                const json = await res.json();
                if (json.success) {
                    dbSelectedIds.clear();
                    updateDbBatchDeleteBtn();
                    showToast(`已批量清理 ${count} 条记录`, 'success');
                    loadDbData(dbCurrentPage);
                } else {
                    showToast(json.error || '批量删除失败', 'error');
                }
            } catch (e) {
                showToast('网络请求失败', 'error');
            }
        }

        let currentDetailModalRecord = null;
        window.currentDetailModalRecord = null;

        function openDbDetailModal(recordIdx, explicitRecords = null, explicitTable = null) {
            const recordsList = explicitRecords || dbCurrentRecords;
            const record = (typeof recordIdx === 'object' && recordIdx !== null) ? recordIdx : (recordsList ? recordsList[recordIdx] : null);
            if (!record) return;

            currentDetailModalRecord = record;
            window.currentDetailModalRecord = record;

            const modal = document.getElementById('db-detail-modal');
            const title = document.getElementById('db-detail-title');
            const body = document.getElementById('db-detail-body');
            if (!modal || !body) return;

            const currentTable = explicitTable || dbCurrentTable;
            const tableNameZh = currentTable === 'student_records' ? '学生学情错题' : (dbTables.find(t => t.name === currentTable)?.friendly_name || currentTable);

            if (currentTable === 'student_records') {
                const sName = record.student_name || '未命名学员';
                const sId = record.student_id ? String(record.student_id).trim() : '';
                title.textContent = `学生学情档案 · ${sName} (#${record.id || ''})`;

                const gradeVal = record.grade || record._batch?.grade || '-';
                const subjectVal = record.subject || record._batch?.subject || '-';
                const tierVal = record.tier || record._batch?.tier || '-';
                const batchDesc = record.class_name ? escapeHtml(record.class_name) : (record.batch_id ? `班级 #${record.batch_id}` : '-');

                // 成绩与指标解析 (消除多余的 .00)
                const hwScore = formatScore(record.homework_score);
                const totScore = (record.total_score !== null && record.total_score !== undefined && record.total_score !== '') ? formatScore(record.total_score) : null;
                const prevScore = (record.preview_score !== null && record.preview_score !== undefined && record.preview_score !== '') ? formatScore(record.preview_score) : '-';
                const commentText = (record.teacher_comment || '').trim();
                const previewCommentText = (record.preview_comment || '').trim();

                // 错题解析 (课后巩固与课前预习)
                let errList = [];
                try {
                    if (Array.isArray(record.error_questions)) errList = record.error_questions;
                    else if (record.error_questions) errList = JSON.parse(record.error_questions);
                } catch (e) { errList = []; }

                let previewErrList = [];
                try {
                    if (Array.isArray(record.preview_error_questions)) previewErrList = record.preview_error_questions;
                    else if (record.preview_error_questions) previewErrList = JSON.parse(record.preview_error_questions);
                } catch (e) { previewErrList = []; }

                // 来源文件名列表
                let srcList = [];
                if (Array.isArray(record.source_files_list) && record.source_files_list.length > 0) {
                    srcList = record.source_files_list;
                } else if (record.source_files) {
                    try {
                        const parsed = typeof record.source_files === 'string' ? JSON.parse(record.source_files) : record.source_files;
                        if (Array.isArray(parsed)) srcList = parsed;
                        else if (typeof parsed === 'string') srcList = [parsed];
                    } catch (e) {
                        srcList = String(record.source_files).split(/\r?\n+/).map(s => s.trim()).filter(Boolean);
                    }
                }

                // 考点与薄弱知识点数据
                const weakPointsText = record.weak_points_text || (record.weak_points ? record.weak_points.join('、') : '');
                const previewWeakPointsText = record.preview_weak_points_text || (record.preview_weak_points ? record.preview_weak_points.join('、') : '');

                // 满分/全对判定
                const isHwFullScore = (record.homework_score !== null && record.homework_score !== undefined && record.homework_score !== '' && ((totScore && parseFloat(record.homework_score) >= parseFloat(totScore)) || parseFloat(record.homework_score) >= 100)) || /全对|全部正确|满分|零失误|无错题/i.test(commentText);
                const pvScoreVal = (record.preview_score !== null && record.preview_score !== undefined && record.preview_score !== '') ? parseFloat(record.preview_score) : null;
                const isPvFullScore = (pvScoreVal !== null && pvScoreVal >= 100) || /全对|满分|零失误|无错题/i.test(previewCommentText);

                body.innerHTML = `
                    <div style="display: flex; flex-direction: column; gap: 14px;">
                        <!-- 1. 顶部学员名片横幅 (Hero Card) -->
                        <div style="background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 16px 20px;">
                            <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px;">
                                <!-- 左侧学生信息 -->
                                <div style="display: flex; align-items: center; gap: 12px;">
                                    <div style="width: 44px; height: 44px; border-radius: 10px; background: var(--bg-subtle); border: 1px solid var(--border-color); display: flex; align-items: center; justify-content: center; font-size: 1.15rem; font-weight: 700; color: var(--text-primary); flex-shrink: 0;">
                                        ${escapeHtml(sName.charAt(0) || '学')}
                                    </div>
                                    <div style="display: flex; flex-direction: column; gap: 4px;">
                                        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                                            <span style="font-size: 1.18rem; font-weight: 700; color: var(--text-primary);">${escapeHtml(sName)}</span>
                                            ${sId ? `<span style="font-family: var(--font-mono); font-size: 0.76rem; background: var(--bg-subtle); border: 1px solid var(--border-color); color: var(--text-secondary); padding: 1px 6px; border-radius: 4px;" title="学号">${escapeHtml(sId)}</span>` : ''}
                                            <span style="font-size: 0.75rem; color: var(--text-muted); font-family: var(--font-mono);">#${record.id}</span>
                                            ${record.batch_code ? `
                                                <span style="font-size: 0.74rem; background: var(--bg-subtle); border: 1px solid var(--border-color); color: var(--text-secondary); padding: 1px 7px; border-radius: 4px; display:inline-flex; align-items:center; gap:5px; font-family:var(--font-mono);" title="生成批次号: ${escapeHtml(record.batch_code)}">
                                                    <span>批次: ${escapeHtml(record.batch_code)}</span>
                                                    <span style="color:var(--primary); cursor:pointer;" onclick="copyTextToClipboard('${escapeInlineJs(record.batch_code)}', '批次号已复制')">复制</span>
                                                    <span style="color:var(--primary); cursor:pointer; font-weight:600;" onclick="closeDbDetailModal(); filterByBatchCode('${escapeInlineJs(record.batch_code)}')">筛选</span>
                                                </span>
                                            ` : ''}
                                        </div>
                                        <div style="display: flex; align-items: center; gap: 6px; font-size: 0.82rem; color: var(--text-secondary); flex-wrap: wrap;">
                                            <span style="font-weight: 500;">${escapeHtml(gradeVal)}</span>
                                            <span style="color: var(--text-muted);">•</span>
                                            <span style="font-weight: 500;">${escapeHtml(subjectVal)}</span>
                                            <span style="color: var(--text-muted);">•</span>
                                            <span style="font-weight: 500;">${escapeHtml(tierVal)}</span>
                                            ${batchDesc !== '-' ? `
                                                <span style="color: var(--text-muted);">•</span>
                                                <span style="color: var(--text-secondary);">${batchDesc}</span>
                                            ` : ''}
                                            ${record.creator_name || record.created_by ? `
                                                <span style="color: var(--text-muted);">•</span>
                                                <span style="color: var(--text-secondary); font-size: 0.8rem; display: inline-flex; align-items: center; gap: 4px;"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>${(record.creator_owner_username && (!record.creator_role || record.creator_role==='assistant') ? escapeHtml(record.creator_name||record.created_by) + ' [助教｜所属：' + escapeHtml(record.creator_owner_name||record.creator_owner_username) + ' (' + escapeHtml(record.creator_owner_username) + ')]' : escapeHtml(record.creator_name || record.created_by))}</span>
                                            ` : ''}
                                        </div>
                                    </div>
                                </div>

                                <!-- 右侧主力快捷操作 -->
                                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                                    ${record.retest_token ? `
                                        <button type="button" class="btn secondary" style="padding: 6px 12px; font-size: 0.82rem; display: inline-flex; align-items: center; gap: 5px;" onclick="openRetestStudent('${escapeInlineJs(record.retest_token)}')" title="打开学员/家长端错题本（需输入姓名验证）">
                                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>
                                            <span>错题本</span>
                                        </button>
                                    ` : ''}
                                    <button type="button" class="btn secondary" style="padding: 6px 11px; font-size: 0.82rem; display: inline-flex; align-items: center; gap: 4px;" onclick="copyParentFullFeedback(currentDetailModalRecord, 'student_records')" title="复制家校完整学情反馈语">
                                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg>
                                        <span>复制反馈</span>
                                    </button>
                                    <button type="button" class="btn secondary" style="padding: 6px 10px; font-size: 0.82rem; display: inline-flex; align-items: center; gap: 4px;" onclick="closeDbDetailModal(); openRecordEditModal(${record.id})" title="编辑此记录">
                                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                                        <span>编辑</span>
                                    </button>
                                    <button type="button" class="btn secondary" style="padding: 6px 10px; font-size: 0.82rem; color: var(--error); border-color: var(--border-color); display: inline-flex; align-items: center; gap: 4px;" onclick="closeDbDetailModal(); deleteRecordDirect(${record.id})" title="删除此记录">
                                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                                        <span>删除</span>
                                    </button>
                                </div>
                            </div>
                        </div>

                        <!-- 2. 中间两列：左列为预习（分数、薄弱点、评语）；第二列为巩固 -->
                        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; align-items: start;">
                            <!-- 左列：课前预习 -->
                            <div style="display: flex; flex-direction: column; gap: 12px; background: rgba(245,158,11,0.03); border: 1px solid rgba(245,158,11,0.22); border-radius: var(--radius-md); padding: 14px;">
                                <div style="display: flex; align-items: center; justify-content: space-between; padding-bottom: 8px; border-bottom: 1px solid rgba(245,158,11,0.2);">
                                    <div style="font-size: 0.95rem; font-weight: 700; color: #f59e0b; display: flex; align-items: center; gap: 6px;">
                                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>
                                        <span>【课前预习档案】</span>
                                    </div>
                                    <span style="font-size: 0.76rem; background: rgba(245,158,11,0.15); color: #f59e0b; border: 1px solid rgba(245,158,11,0.3); padding: 2px 8px; border-radius: 4px; font-weight: 600; font-family: var(--font-mono);">
                                        第 ${record.preview_week_num ?? (record.week_num ?? '-')} 周
                                    </span>
                                </div>

                                <!-- 预习分数 -->
                                <div style="background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 12px 14px;">
                                    <div style="font-size: 0.76rem; font-weight: 600; color: var(--text-secondary); margin-bottom: 4px; display:flex; align-items:center; justify-content:space-between;">
                                        <span style="display:flex; align-items:center; gap:5px;">
                                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>
                                            预习得分
                                        </span>
                                        <span style="font-size:0.72rem; color:var(--text-muted); font-family:var(--font-mono);">预习周次: 第${record.preview_week_num ?? (record.week_num ?? '-')}周</span>
                                    </div>
                                    <div style="display: flex; align-items: baseline; gap: 4px;">
                                        <span style="font-size: 1.55rem; font-weight: 700; color: #f59e0b; font-family: var(--font-mono);">${prevScore}</span>
                                        ${prevScore !== '-' ? '<span style="font-size: 0.8rem; color: var(--text-muted); font-weight: 500;">分</span>' : ''}
                                    </div>
                                </div>

                                <!-- 预习薄弱点 -->
                                <div style="background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 12px 14px; display:flex; flex-direction:column; gap:8px;">
                                    <div style="display: flex; align-items: center; justify-content: space-between;">
                                        <div style="font-size: 0.82rem; font-weight: 700; color: #f59e0b; display: flex; align-items: center; gap: 5px;">
                                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                                            预习薄弱点与错题
                                        </div>
                                        ${previewWeakPointsText ? `
                                            <button type="button" class="btn secondary" style="padding: 2px 7px; font-size: 0.72rem; display: inline-flex; align-items: center; gap: 4px;" onclick="copyPreviewWeakPointsFromModal()">
                                                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg>
                                                <span>复制预习薄弱点</span>
                                            </button>
                                        ` : ''}
                                    </div>
                                    ${previewWeakPointsText ? `
                                        <div>
                                            <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:2px;">薄弱考点归纳：</div>
                                            <span id="modal-preview-weak-points-text" style="color: var(--text-primary); font-size: 0.85rem; font-weight: 500; line-height: 1.5;">${escapeHtml(previewWeakPointsText)}</span>
                                        </div>
                                    ` : ''}
                                    ${previewErrList.length > 0 ? `
                                        <div style="display:flex; align-items:center; flex-wrap:wrap; gap:4px;">
                                            <span style="font-size:0.75rem; color:var(--text-muted);">错题题号：</span>
                                            ${previewErrList.map(q => `<span class="q-badge" style="border-color:rgba(245,158,11,0.4); color:#fbbf24;">${escapeHtml(String(q))}</span>`).join('')}
                                            <span style="font-size:0.75rem; color:var(--text-muted);">(共${previewErrList.length}题)</span>
                                        </div>
                                    ` : (isPvFullScore ? `
                                        <div style="color: #10b981; font-size: 0.82rem; font-weight: 500; display:flex; align-items:center; gap:4px;">
                                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
                                            <span>预习全部正确，无薄弱错题</span>
                                        </div>
                                    ` : (!previewWeakPointsText ? `<span style="color:var(--text-muted); font-size:0.82rem;">（暂无预习错题记录）</span>` : ''))}
                                </div>

                                <!-- 预习评语 -->
                                <div style="background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 12px 14px; display: flex; flex-direction: column; gap: 6px;">
                                    <div style="display: flex; align-items: center; justify-content: space-between;">
                                        <div style="font-size: 0.82rem; font-weight: 700; color: #f59e0b; display: flex; align-items: center; gap: 5px;">
                                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                                            预习针对性评语
                                        </div>
                                        ${previewCommentText ? `
                                            <button type="button" class="btn secondary" style="font-size: 0.72rem; padding: 2px 7px; display: inline-flex; align-items: center; gap: 4px;" onclick="copyPreviewCommentFromModal()">
                                                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg>
                                                <span>复制预习评语</span>
                                            </button>
                                        ` : ''}
                                    </div>
                                    <div id="modal-preview-comment-text" style="font-size: 0.84rem; color: var(--text-primary); line-height: 1.5; white-space: pre-wrap; background: var(--bg-subtle); border-radius: var(--radius-sm); padding: 8px 12px; border: 1px solid var(--border-color); flex: 1; min-height: 50px;">${escapeHtml((previewCommentText || '').trim() || '（暂无课前预习评语）')}</div>
                                </div>
                            </div>

                            <!-- 右列：课后巩固 -->
                            <div style="display: flex; flex-direction: column; gap: 12px; background: rgba(56,189,248,0.03); border: 1px solid rgba(56,189,248,0.22); border-radius: var(--radius-md); padding: 14px;">
                                <div style="display: flex; align-items: center; justify-content: space-between; padding-bottom: 8px; border-bottom: 1px solid rgba(56,189,248,0.2);">
                                    <div style="font-size: 0.95rem; font-weight: 700; color: #38bdf8; display: flex; align-items: center; gap: 6px;">
                                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
                                        <span>【课后巩固档案】</span>
                                    </div>
                                    <span style="font-size: 0.76rem; background: rgba(56,189,248,0.15); color: #38bdf8; border: 1px solid rgba(56,189,248,0.3); padding: 2px 8px; border-radius: 4px; font-weight: 600; font-family: var(--font-mono);">
                                        第 ${record.week_num ?? '-'} 周
                                    </span>
                                </div>

                                <!-- 巩固分数 -->
                                <div style="background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 12px 14px;">
                                    <div style="font-size: 0.76rem; font-weight: 600; color: var(--text-secondary); margin-bottom: 4px; display:flex; align-items:center; justify-content:space-between;">
                                        <span style="display:flex; align-items:center; gap:5px;">
                                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
                                            巩固得分
                                        </span>
                                        <span style="font-size:0.72rem; color:var(--text-muted); font-family:var(--font-mono);">巩固周次: 第${record.week_num ?? '-'}周 ${totScore ? `· 满分${totScore}分` : ''}</span>
                                    </div>
                                    <div style="display: flex; align-items: baseline; gap: 4px;">
                                        <span style="font-size: 1.55rem; font-weight: 700; color: #38bdf8; font-family: var(--font-mono);">${hwScore}</span>
                                        ${hwScore !== '-' ? '<span style="font-size: 0.8rem; color: var(--text-muted); font-weight: 500;">分</span>' : ''}
                                    </div>
                                </div>

                                <!-- 巩固薄弱点 -->
                                <div style="background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 12px 14px; display:flex; flex-direction:column; gap:8px;">
                                    <div style="display: flex; align-items: center; justify-content: space-between;">
                                        <div style="font-size: 0.82rem; font-weight: 700; color: #38bdf8; display: flex; align-items: center; gap: 5px;">
                                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                                            巩固薄弱点与错题
                                        </div>
                                        ${weakPointsText ? `
                                            <button type="button" class="btn secondary" style="padding: 2px 7px; font-size: 0.72rem; display: inline-flex; align-items: center; gap: 4px;" onclick="copyWeakPointsFromModal()">
                                                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg>
                                                <span>复制巩固薄弱点</span>
                                            </button>
                                        ` : ''}
                                    </div>
                                    ${weakPointsText ? `
                                        <div>
                                            <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:2px;">薄弱考点归纳：</div>
                                            <span id="modal-weak-points-text" style="color: var(--text-primary); font-size: 0.85rem; font-weight: 500; line-height: 1.5;">${escapeHtml(weakPointsText)}</span>
                                        </div>
                                    ` : ''}
                                    ${errList.length > 0 ? `
                                        <div style="display:flex; align-items:center; flex-wrap:wrap; gap:4px;">
                                            <span style="font-size:0.75rem; color:var(--text-muted);">错题题号：</span>
                                            ${errList.map(q => `<span class="q-badge">${escapeHtml(String(q))}</span>`).join('')}
                                            <span style="font-size:0.75rem; color:var(--text-muted);">(共${errList.length}题)</span>
                                        </div>
                                    ` : (isHwFullScore ? `
                                        <div style="color: #10b981; font-size: 0.82rem; font-weight: 500; display:flex; align-items:center; gap:4px;">
                                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
                                            <span>巩固全部正确，无薄弱错题</span>
                                        </div>
                                    ` : (!weakPointsText ? `<span style="color:var(--text-muted); font-size:0.82rem;">（暂无巩固错题记录）</span>` : ''))}
                                </div>

                                <!-- 巩固评语 -->
                                <div style="background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 12px 14px; display: flex; flex-direction: column; gap: 6px;">
                                    <div style="display: flex; align-items: center; justify-content: space-between;">
                                        <div style="font-size: 0.82rem; font-weight: 700; color: #38bdf8; display: flex; align-items: center; gap: 5px;">
                                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                                            巩固针对性评语
                                        </div>
                                        ${commentText ? `
                                            <button type="button" class="btn secondary" style="font-size: 0.72rem; padding: 2px 7px; display: inline-flex; align-items: center; gap: 4px;" onclick="copyCommentFromModal()">
                                                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg>
                                                <span>复制巩固评语</span>
                                            </button>
                                        ` : ''}
                                    </div>
                                    <div id="modal-comment-text" style="font-size: 0.84rem; color: var(--text-primary); line-height: 1.5; white-space: pre-wrap; background: var(--bg-subtle); border-radius: var(--radius-sm); padding: 8px 12px; border: 1px solid var(--border-color); flex: 1; min-height: 50px;">${escapeHtml((commentText || '').trim() || '（暂无课后巩固评语）')}</div>
                                </div>
                            </div>
                        </div>

                        <!-- 3. 原本录入文件方框正常放那里 -->
                        <div style="background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px 16px;">
                            <div style="font-size: 0.82rem; font-weight: 700; color: var(--text-secondary); margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; gap: 6px;">
                                <span style="display: inline-flex; align-items: center; gap: 6px;">
                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
                                    <span>录入来源文件名 ${srcList.length > 0 ? `(共 ${srcList.length} 个文件)` : ''}</span>
                                </span>
                                ${srcList.length > 0 ? `<span style="font-size: 0.72rem; font-weight: 400; color: var(--text-muted);">点击文件名可直接下载上传原件（保留30天）</span>` : ''}
                            </div>
                            ${srcList.length > 0 ? `
                                <div style="display: flex; flex-wrap: wrap; gap: 6px;">
                                    ${srcList.map(fn => renderSourceFileChip(fn, { recordId: record.id, batchCode: record.batch_code || '', variant: 'default' })).join('')}
                                </div>
                            ` : '<span style="color: var(--text-muted); font-size: 0.78rem;">（暂无记录来源文件名，历史数据或手动录入）</span>'}
                        </div>

                        <!-- 4. 历史版本快照与变更记录 -->
                        <div style="background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px 16px;">
                            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                                <div style="font-size: 0.84rem; font-weight: 700; color: var(--text-secondary); display: flex; align-items: center; gap: 6px;">
                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                                    <span>历史版本变更快照</span>
                                </div>
                                <button type="button" class="btn secondary" style="font-size: 0.74rem; padding: 2px 8px; display: inline-flex; align-items: center; gap: 4px;" onclick="loadRecordHistory(${record.id}, '${escapeInlineJs(record.student_name)}', ${record.batch_id || 0}, ${record.week_num || 0})">
                                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
                                    <span>刷新快照</span>
                                </button>
                            </div>
                            <div id="record-history-list-${record.id}" style="display: flex; flex-direction: column; gap: 8px;">
                                <div style="font-size: 0.8rem; color: var(--text-muted); padding: 8px; text-align: center;">正在检索历史版本...</div>
                            </div>
                        </div>
                    </div>
                `;

                // 异步拉取历史版本快照
                setTimeout(() => {
                    loadRecordHistory(record.id, record.student_name, record.batch_id || 0, record.week_num || 0);
                }, 50);
            } else if (currentTable === 'qbank_questions') {
                title.textContent = `题库题目详情 · 第 ${record.question_num ?? ''} 题 (#${record.id || ''})`;
                const exLink = record.exercise_pdf ? `<a href="${escapeHtml(record.exercise_pdf)}" target="_blank" class="btn secondary" style="font-size:0.8rem; padding:4px 10px;">查看原题 PDF (${escapeHtml(record.exercise_name || '题目.pdf')})</a>` : '<span style="color:var(--text-muted);">暂无题目 PDF</span>';
                const ansLink = record.answer_pdf ? `<a href="${escapeHtml(record.answer_pdf)}" target="_blank" class="btn secondary" style="font-size:0.8rem; padding:4px 10px;">查看解析 PDF (${escapeHtml(record.answer_name || '解析.pdf')})</a>` : '<span style="color:var(--text-muted);">暂无解析 PDF</span>';

                body.innerHTML = `
                    <div style="display:flex; flex-direction:column; gap:14px;">
                        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:10px;">
                            <div style="background:rgba(255,255,255,0.03); padding:10px 14px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                                <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:3px;">题目 ID</div>
                                <div style="font-size:0.95rem; font-weight:700; color: var(--text-primary); font-family:var(--font-mono);">#${record.id}</div>
                            </div>
                            <div style="background:rgba(56,189,248,0.08); padding:10px 14px; border-radius:var(--radius-sm); border:1px solid rgba(56,189,248,0.25);">
                                <div style="font-size:0.75rem; color:#7dd3fc; margin-bottom:3px;">题目序号</div>
                                <div style="font-size:1.1rem; font-weight:800; color:#38bdf8; font-family:var(--font-mono);">第 ${record.question_num ?? '-'} 题</div>
                            </div>
                            <div style="background:rgba(255,255,255,0.03); padding:10px 14px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                                <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:3px;">专题周次</div>
                                <div style="font-size:0.95rem; font-weight:700; color:#93c5fd; font-family:var(--font-mono);">第 ${record.week ?? '-'} 周</div>
                            </div>
                            <div style="background:rgba(255,255,255,0.03); padding:10px 14px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                                <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:3px;">年级 / 学科 / 班型</div>
                                <div style="font-size:0.95rem; font-weight:600; color: var(--text-primary);">${escapeHtml(record.grade || '')} · <b style="color:#a78bfa;">${escapeHtml(record.subject || '')}</b> · ${escapeHtml(record.tier || '')}</div>
                            </div>
                            <div style="background:rgba(255,255,255,0.03); padding:10px 14px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                                <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:3px;">教学年份 / 季度</div>
                                <div style="font-size:0.95rem; font-weight:700; color: var(--text-primary);">${record.year || '-'} <span style="color:#93c5fd;">${escapeHtml(record.season || '')}</span></div>
                            </div>
                            <div style="background:rgba(255,255,255,0.03); padding:10px 14px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                                <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:3px;">关联题库期次</div>
                                <div style="font-size:0.95rem; font-weight:700; color: var(--text-primary); font-family:var(--font-mono);">${record.qbank_id ? `#${record.qbank_id}` : '-'}</div>
                            </div>
                        </div>

                        <!-- 考查知识点 -->
                        <div style="background:rgba(59,130,246,0.08); padding:14px 16px; border-radius:var(--radius-sm); border:1px solid rgba(59,130,246,0.3);">
                            <div style="font-size:0.75rem; font-weight:700; color:#93c5fd; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px;">考点 / 考查知识点 (Topic)</div>
                            <div style="font-size:1.05rem; font-weight:700; color: var(--text-primary); line-height:1.5;">${escapeHtml(record.topic || '（未设定考点）')}</div>
                        </div>

                        <!-- 微课讲解链接 -->
                        <div style="background:rgba(139,92,246,0.08); padding:12px 14px; border-radius:var(--radius-sm); border:1px solid rgba(139,92,246,0.3); display:flex; align-items:center; justify-content:space-between; gap:10px;">
                            <div style="min-width:0; flex:1;">
                                <div style="font-size:0.75rem; font-weight:700; color:#c4b5fd; margin-bottom:4px;">微课讲解链接 (Video URL)</div>
                                <div style="font-size:0.88rem; color:var(--text-primary); font-family:var(--font-mono); word-break:break-all;">
                                    ${record.video_url ? escapeHtml(record.video_url) : '<span style="color:var(--text-muted);">（未配置微课链接）</span>'}
                                </div>
                            </div>
                            ${record.video_url ? `<a href="${escapeHtml(record.video_url)}" target="_blank" class="btn secondary" style="flex-shrink:0; font-size:0.8rem; padding:4px 12px; color:#c4b5fd; border-color:rgba(139,92,246,0.4);">▶ 打开微课</a>` : ''}
                        </div>

                        <!-- PDF 资源 -->
                        <div style="background:rgba(255,255,255,0.03); padding:12px 14px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                            <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:8px;">原题与解析 PDF 资源</div>
                            <div style="display:flex; flex-wrap:wrap; gap:10px; align-items:center;">
                                ${exLink}
                                ${ansLink}
                            </div>
                        </div>

                        <!-- 时间与元数据 -->
                        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px;">
                            <div style="background:rgba(255,255,255,0.02); padding:8px 12px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                                <span style="font-size:0.72rem; color:var(--text-muted);">录入教师：</span>
                                <span style="font-size:0.85rem; font-weight:600; color:var(--text-primary);">${renderCreatorCell(record, true)}</span>
                            </div>
                            <div style="background:rgba(255,255,255,0.02); padding:8px 12px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                                <span style="font-size:0.72rem; color:var(--text-muted);">录入时间：</span>
                                <span style="font-size:0.82rem; color:var(--text-secondary); font-family:var(--font-mono);">${formatTimestamp(record.created_at)}</span>
                            </div>
                            <div style="background:rgba(255,255,255,0.02); padding:8px 12px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                                <span style="font-size:0.72rem; color:var(--text-muted);">更新时间：</span>
                                <span style="font-size:0.82rem; color:var(--text-secondary); font-family:var(--font-mono);">${formatTimestamp(record.updated_at)}</span>
                            </div>
                        </div>
                    </div>
                `;
            } else if (currentTable === 'qbank_weeks') {
                title.textContent = `题库期次详情 · 第 ${record.week ?? ''} 周 (#${record.id || ''})`;
                body.innerHTML = `
                    <div style="display:flex; flex-direction:column; gap:14px;">
                        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:10px;">
                            <div style="background:rgba(255,255,255,0.03); padding:10px 14px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                                <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:3px;">期次 ID</div>
                                <div style="font-size:0.95rem; font-weight:700; color: var(--text-primary); font-family:var(--font-mono);">#${record.id}</div>
                            </div>
                            <div style="background:rgba(255,255,255,0.03); padding:10px 14px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                                <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:3px;">年份 / 季度</div>
                                <div style="font-size:0.95rem; font-weight:700; color: var(--text-primary);">${record.year || '-'} <span style="color:#93c5fd;">${escapeHtml(record.season || '')}</span></div>
                            </div>
                            <div style="background:rgba(255,255,255,0.03); padding:10px 14px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                                <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:3px;">年级 / 学科 / 班型</div>
                                <div style="font-size:0.95rem; font-weight:600; color: var(--text-primary);">${escapeHtml(record.grade || '')} · <b style="color:#a78bfa;">${escapeHtml(record.subject || '')}</b> · ${escapeHtml(record.tier || '')}</div>
                            </div>
                            <div style="background:rgba(255,255,255,0.03); padding:10px 14px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                                <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:3px;">周次序号</div>
                                <div style="font-size:1.1rem; font-weight:800; color:#93c5fd; font-family:var(--font-mono);">第 ${record.week ?? '-'} 周</div>
                            </div>
                            <div style="background:rgba(56,189,248,0.08); padding:10px 14px; border-radius:var(--radius-sm); border:1px solid rgba(56,189,248,0.25);">
                                <div style="font-size:0.75rem; color:#7dd3fc; margin-bottom:3px;">题目总数</div>
                                <div style="font-size:1.2rem; font-weight:800; color:#38bdf8; font-family:var(--font-mono);">${record.question_count ?? 0} 题</div>
                            </div>
                            <div style="background:rgba(255,255,255,0.03); padding:10px 14px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                                <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:3px;">录入教师</div>
                                <div style="font-size:0.95rem; font-weight:600; color:var(--text-primary);">${renderCreatorCell(record, true)}</div>
                            </div>
                            <div style="background:rgba(255,255,255,0.03); padding:10px 14px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                                <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:3px;">更新时间</div>
                                <div style="font-size:0.85rem; color:var(--text-secondary); font-family:var(--font-mono);">${formatTimestamp(record.updated_at || record.created_at)}</div>
                            </div>
                        </div>
                    </div>
                `;
            } else if (currentTable === 'system_logs') {
                title.textContent = `系统运行日志详情 #${record.id || ''}`;
                const levelClass = (record.level || 'info').toLowerCase();
                const formatJson = (val) => {
                    if (!val) return '<span style="color:var(--text-muted);">无</span>';
                    try {
                        const obj = typeof val === 'string' ? JSON.parse(val) : val;
                        return `<pre style="margin:0; font-family:var(--font-mono); font-size:0.8rem; color: var(--text-secondary); white-space:pre-wrap; word-break:break-all; max-height:260px; overflow-y:auto; line-height:1.5;">${escapeHtml(JSON.stringify(obj, null, 2))}</pre>`;
                    } catch (e) {
                        return `<div style="font-family:var(--font-mono); font-size:0.82rem; color: var(--text-secondary); word-break:break-all;">${escapeHtml(String(val))}</div>`;
                    }
                };

                body.innerHTML = `
                    <div style="display:flex; flex-direction:column; gap:14px;">
                        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:10px;">
                            <div style="background:rgba(255,255,255,0.03); padding:10px 14px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                                <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:3px;">日志 ID</div>
                                <div style="font-size:0.85rem; font-weight:700; color: var(--text-primary); font-family:var(--font-mono); word-break:break-all;">${escapeHtml(record.log_id || `#${record.id}`)}</div>
                            </div>
                            <div style="background:rgba(255,255,255,0.03); padding:10px 14px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                                <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:3px;">级别 / 模块</div>
                                <div style="display:flex; align-items:center; gap:6px; margin-top:2px;">
                                    <span class="log-level-badge level-${escapeHtml(levelClass)}">${escapeHtml(record.level || 'info')}</span>
                                    <span class="module-badge">${escapeHtml(record.module || '-')}</span>
                                </div>
                            </div>
                            <div style="background:rgba(255,255,255,0.03); padding:10px 14px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                                <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:3px;">事件名称</div>
                                <div style="font-size:0.95rem; font-weight:700; color:#38bdf8; font-family:var(--font-mono);">${escapeHtml(record.event || '-')}</div>
                            </div>
                            <div style="background:rgba(255,255,255,0.03); padding:10px 14px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                                <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:3px;">操作人</div>
                                <div style="font-size:0.9rem; font-weight:600; color:var(--text-primary);">${escapeHtml(record.operator_name || record.operator || '系统')}</div>
                            </div>
                            <div style="background:rgba(255,255,255,0.03); padding:10px 14px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                                <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:3px;">客户端 IP</div>
                                <div style="font-size:0.9rem; font-weight:600; color: var(--text-primary); font-family:var(--font-mono);">${escapeHtml(record.client_ip || '-')}</div>
                            </div>
                        </div>

                        <div style="background:rgba(0,0,0,0.3); padding:12px 14px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                            <div style="font-size:0.75rem; font-weight:700; color:var(--primary); margin-bottom:6px; text-transform:uppercase;">详细数据 (Details)</div>
                            ${formatJson(record.details)}
                        </div>

                        ${record.context ? `
                            <div style="background:rgba(0,0,0,0.3); padding:12px 14px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                                <div style="font-size:0.75rem; font-weight:700; color:#a78bfa; margin-bottom:6px; text-transform:uppercase;">运行上下文 (Context)</div>
                                ${formatJson(record.context)}
                            </div>
                        ` : ''}

                        ${record.client_info ? `
                            <div style="background:rgba(0,0,0,0.3); padding:12px 14px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                                <div style="font-size:0.75rem; font-weight:700; color:#60a5fa; margin-bottom:6px; text-transform:uppercase;">客户端环境 (Client Info)</div>
                                ${formatJson(record.client_info)}
                            </div>
                        ` : ''}

                        <div style="background:rgba(255,255,255,0.02); padding:8px 12px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                            <span style="font-size:0.72rem; color:var(--text-muted);">发生时间：</span>
                            <span style="font-size:0.82rem; color:var(--text-secondary); font-family:var(--font-mono);">${formatTimestamp(record.created_at)}</span>
                        </div>
                    </div>
                `;
            } else if (currentTable === 'users') {
                const isTest = record.username === '0';
                const displayName = record.real_name ? `${record.real_name} (${record.username})` : record.username;
                title.textContent = `教师账号详情 · ${displayName} (#${record.id || ''})`;

                const isActive = parseInt(record.status, 10) === 1;
                const statusBadge = isActive 
                    ? '<span class="status-badge active"><span class="status-dot"></span>启用 (允许登录)</span>' 
                    : '<span class="status-badge disabled"><span class="status-dot"></span>禁用 (禁止登录)</span>';

                let assistants = Array.isArray(record.assistants) ? record.assistants : [];

                const renderTeacherDetailContent = () => {
                    const assistantsListHtml = assistants.length === 0 ? `
                        <div style="background: rgba(255,255,255,0.02); border: 1px dashed var(--border-color); border-radius: 10px; padding: 28px 16px; text-align: center; color: var(--text-muted); font-size: 0.85rem;">
                            <div class="empty-state-icon primary">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
                            </div>
                            <div style="font-weight: 600; color: var(--text-secondary);">该教师名下暂无助教账号</div>
                        </div>
                    ` : `
                        <div class="assistant-cards-container" style="display: flex; flex-direction: column; gap: 12px; margin-top: 6px;">
                            ${assistants.map((ast, aIdx) => {
                                const astActive = parseInt(ast.status, 10) === 1;
                                const astStatusBadge = astActive 
                                    ? '<span class="status-badge active"><span class="status-dot"></span>启用</span>' 
                                    : '<span class="status-badge disabled"><span class="status-dot"></span>禁用</span>';
                                const pwdDisp = ast.initial_password 
                                    ? `<span class="cell-mono" style="color:var(--accent); font-weight:600; font-size:0.86rem;">${escapeHtml(ast.initial_password)}</span>`
                                    : '<span style="color:var(--text-muted); letter-spacing:2px; font-size:0.82rem;">••••••••</span>';
                                const lastLogin = ast.last_login_at 
                                    ? formatTimestamp(ast.last_login_at) 
                                    : '从未登录';
                                const ipTooltip = ast.last_login_ip ? ` title="登录IP: ${escapeHtml(ast.last_login_ip)}"` : '';

                                return `
                                    <div class="assistant-item-card" style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; transition: var(--transition-fast);">
                                        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
                                            <div style="display: flex; align-items: center; gap: 10px;">
                                                <span style="display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 50%; background: var(--bg-subtle); color: var(--text-muted); font-size: 0.78rem; font-weight: 700; font-family: var(--font-mono);">${aIdx + 1}</span>
                                                <div style="display: flex; align-items: center; gap: 8px;">
                                                    <span style="font-weight: 700; font-size: 0.95rem; color: var(--text-primary);">${escapeHtml(ast.real_name || '助教')}</span>
                                                    <span class="cell-mono" style="font-size: 0.82rem; color: var(--text-secondary); background: var(--bg-subtle); padding: 2px 7px; border-radius: 4px; border: 1px solid var(--border-subtle); cursor: pointer;" onclick="copyTextToClipboard('${escapeInlineJs(ast.username)}', '助教账号已复制')" title="点击复制账号">
                                                        @${escapeHtml(ast.username || '-')}
                                                        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" style="margin-left: 2px; vertical-align: -1px;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg>
                                                    </span>
                                                </div>
                                                ${astStatusBadge}
                                            </div>
                                            <div style="display: flex; align-items: center; gap: 8px;">
                                                <button type="button" class="btn-action" onclick="copyAssistantShareInfo('${escapeInlineJs(ast.real_name || '')}', '${escapeInlineJs(ast.username)}', '${escapeInlineJs(ast.initial_password || '')}', '${escapeInlineJs(record.real_name || '')}', '${escapeInlineJs(record.username)}')" title="一键复制助教账号密码及登录说明">复制凭证</button>
                                                <button type="button" class="btn-action" style="color:var(--accent); border-color:rgba(99,102,241,0.3);" onclick="promptResetTeacherPwd(${Number(ast.id)}, '${escapeInlineJs(ast.username)}', '${escapeInlineJs(ast.real_name || '')}')" title="重置助教登录密码">重置密码</button>
                                                <button type="button" class="btn-action delete" onclick="deleteAssistantFromDetail(${Number(ast.id)}, '${escapeInlineJs(ast.username)}', ${Number(record.id)})" title="删除此助教">删除</button>
                                            </div>
                                        </div>
                                        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding-top: 8px; border-top: 1px solid var(--border-subtle); font-size: 0.82rem; color: var(--text-secondary);">
                                            <div style="display: flex; align-items: center; gap: 6px;">
                                                <span style="color: var(--text-muted);">初始密码:</span>
                                                ${pwdDisp}
                                                ${ast.initial_password ? `<button type="button" class="btn-action" style="font-size:0.72rem; padding:1px 6px; height:20px; line-height:18px;" onclick="copyTextToClipboard('${escapeInlineJs(ast.initial_password)}', '初始密码已复制')" title="复制初始密码">复制</button>` : ''}
                                            </div>
                                            <div style="display: flex; align-items: center; gap: 16px;">
                                                <span${ipTooltip}><span style="color: var(--text-muted);">最近登录:</span> <span class="cell-mono" style="color: var(--text-secondary);">${lastLogin}</span></span>
                                                <span><span style="color: var(--text-muted);">创建时间:</span> <span class="cell-mono" style="color: var(--text-secondary);">${formatTimestamp(ast.created_at)}</span></span>
                                            </div>
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    `;

                    body.innerHTML = `
                        <div style="display: flex; flex-direction: column; gap: 14px;">
                            <!-- 教师基本信息看板 -->
                            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px;">
                                <div style="background: var(--bg-subtle); padding: 10px 14px; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
                                    <div style="font-size: 0.74rem; color: var(--text-muted); margin-bottom: 3px;">教师账号 (工号)</div>
                                    <div style="font-size: 1.1rem; font-weight: 600; color: var(--text-primary); font-family: var(--font-mono); display: flex; align-items: center; justify-content: space-between;">
                                        <span>${escapeHtml(record.username || '-')}</span>
                                        <button type="button" class="btn-action" style="font-size:0.72rem; padding:1px 6px;" onclick="copyTextToClipboard('${escapeInlineJs(record.username)}', '教师账号已复制')">复制</button>
                                    </div>
                                </div>
                                <div style="background: var(--bg-subtle); padding: 10px 14px; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
                                    <div style="font-size: 0.74rem; color: var(--text-muted); margin-bottom: 3px;">教师姓名 / 备注</div>
                                    <div style="font-size: 1.05rem; font-weight: 600; color: var(--text-primary);">${escapeHtml(record.real_name || '-')}</div>
                                </div>
                                <div style="background: var(--bg-subtle); padding: 10px 14px; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
                                    <div style="font-size: 0.74rem; color: var(--text-muted); margin-bottom: 3px;">账号状态</div>
                                    <div style="margin-top: 2px;">${statusBadge}</div>
                                </div>
                                <div style="background: var(--bg-subtle); padding: 10px 14px; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
                                    <div style="font-size: 0.74rem; color: var(--text-muted); margin-bottom: 3px;">初始密码</div>
                                    <div style="font-size: 0.95rem; font-weight: 600; color: #f59e0b; font-family: var(--font-mono); display: flex; align-items: center; justify-content: space-between;">
                                        <span>${isTest ? '公共体验免密/0' : (record.initial_password ? escapeHtml(record.initial_password) : '<span style="color:var(--text-muted); font-size:0.82rem; font-weight:normal;">已自定义密码</span>')}</span>
                                        ${record.initial_password ? `<button type="button" class="btn-action" style="font-size:0.72rem; padding:1px 6px;" onclick="copyTextToClipboard('${escapeInlineJs(record.initial_password)}', '初始密码已复制')">复制</button>` : ''}
                                    </div>
                                </div>
                                <div style="background: rgba(59,130,246,0.08); padding: 10px 14px; border-radius: var(--radius-sm); border: 1px solid rgba(59,130,246,0.25);">
                                    <div style="font-size: 0.74rem; color: #93c5fd; margin-bottom: 3px;">名下助教数量</div>
                                    <div style="font-size: 1.25rem; font-weight: 600; color: #60a5fa; font-family: var(--font-mono);">${assistants.length} <span style="font-size:0.8rem; font-weight:normal;">人</span></div>
                                </div>
                                <div style="background: var(--bg-subtle); padding: 10px 14px; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
                                    <div style="font-size: 0.74rem; color: var(--text-muted); margin-bottom: 3px;">最后登录时间</div>
                                    <div style="font-size: 0.84rem; color: var(--text-secondary); font-family: var(--font-mono);">${formatTimestamp(record.last_login_at)}</div>
                                    <div style="font-size: 0.74rem; color: var(--text-muted); font-family: var(--font-mono); margin-top: 2px;">IP: ${escapeHtml(record.last_login_ip || '-')}</div>
                                </div>
                            </div>

                            <!-- 名下助教账号区域 -->
                            <div style="background: rgba(255,255,255,0.02); border: 1px solid var(--border-color); border-radius: 12px; padding: 16px 18px; margin-top: 4px;">
                                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
                                    <div style="display: flex; align-items: center; gap: 8px;">
                                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
                                        <span style="font-size: 0.95rem; font-weight: 700; color: #60a5fa;">名下助教账号列表</span>
                                        <span style="font-size: 0.76rem; background: rgba(59,130,246,0.15); color: #93c5fd; padding: 2px 8px; border-radius: 10px; font-weight: 700;">共 ${assistants.length} 人</span>
                                    </div>

                                </div>

                                ${assistantsListHtml}
                            </div>

                            <!-- 底部快捷操作栏 -->
                            <div style="display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 10px; padding-top: 14px; border-top: 1px solid var(--border-color);">
                                ${isTest ? '' : `
                                    <button type="button" class="btn secondary" style="color:var(--accent); border-color:rgba(10,132,255,0.35); font-size:0.84rem; padding:6px 14px; display: inline-flex; align-items: center; gap: 4px;" onclick="promptResetTeacherPwd(${record.id}, '${escapeInlineJs(record.username)}', '${escapeInlineJs(record.real_name || '')}')">
                                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-1.5 1.5L14 9l-3-3 2-2 2.5 2.5z"></path><circle cx="7.5" cy="16.5" r="4.5"></circle><path d="m10.7 13.3 5.3-5.3"></path></svg>
                                        <span>重置教师密码</span>
                                    </button>
                                `}
                                <button type="button" class="btn secondary" style="font-size:0.84rem; padding:6px 14px; display: inline-flex; align-items: center; gap: 4px;" onclick="closeDbDetailModal(); openDbRecordModal(${record.id}, 'users')">
                                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                                    <span>编辑教师信息</span>
                                </button>
                                <button type="button" class="btn secondary" style="font-size:0.84rem; padding:6px 14px;" onclick="closeDbDetailModal()">
                                    关闭
                                </button>
                            </div>
                        </div>
                    `;
                };

                renderTeacherDetailContent();

                // 若当前 record 未携带完整的 assistants 列表，发起异步拉取更新
                if (!Array.isArray(record.assistants)) {
                    fetch(`${API_BASE}?action=db_get&table=users&id=${record.id}`)
                        .then(res => res.json())
                        .then(json => {
                            if (json.success && json.data?.record?.assistants) {
                                assistants = json.data.record.assistants;
                                record.assistants = assistants;
                                record.assistant_count = assistants.length;
                                renderTeacherDetailContent();
                            }
                        })
                        .catch(() => {});
                }
            } else {
                title.textContent = `记录详情 #${record.id || ''} (${tableNameZh})`;
                let rowsHtml = '<div style="display:flex; flex-direction:column; gap:12px;">';
                for (let k in record) {
                    let v = record[k];
                    if (k.includes('thumb') && typeof v === 'string' && v.startsWith('data:image')) {
                        v = `[缩略图图像数据，已省略 ${v.length} 字符]`;
                    } else if (typeof v === 'object') {
                        v = JSON.stringify(v, null, 2);
                    }
                    rowsHtml += `
                        <div style="background:rgba(0,0,0,0.3); padding:10px 14px; border-radius:var(--radius-sm); border:1px solid var(--border-color);">
                            <div style="font-size:0.78rem; font-weight:700; color:var(--primary); margin-bottom:4px; text-transform:uppercase; letter-spacing:0.5px;">${escapeHtml(k)}</div>
                            <div style="font-size:0.92rem; color: var(--text-primary); word-break:break-all; font-family:${k.includes('token') || k.includes('key') || k.includes('questions') ? 'var(--font-mono)' : 'inherit'}; line-height:1.5;">${escapeHtml(String(v ?? 'NULL'))}</div>
                        </div>
                    `;
                }
                rowsHtml += '</div>';
                body.innerHTML = rowsHtml;
            }

            if (window.DialogHelper) {
                window.DialogHelper.open(modal, { dismissible: true });
            } else {
                modal.style.display = 'flex';
            }
        }

        function closeDbDetailModal() {
            const modal = document.getElementById('db-detail-modal');
            if (modal) {
                if (window.DialogHelper) {
                    window.DialogHelper.close(modal);
                } else {
                    modal.style.display = 'none';
                }
            }
        }

        window.copyAssistantShareInfo = function(astName, astUname, astPwd, teacherName, teacherUname) {
            const pwdDisp = astPwd || '（已设置独立密码）';
            const loginUrl = (window.location.origin.includes('vip.wxjifang.cn') || window.location.origin.includes('wxjifang.cn'))
                ? 'https://vip.wxjifang.cn'
                : window.location.origin;
            const text = `【极方助教账号】\n所属教师：${teacherName || teacherUname} (${teacherUname})\n助教姓名：${astName}\n登录账号：${astUname}\n初始密码：${pwdDisp}\n登录入口：${loginUrl}\n权限说明：具备学情反馈制作与错题本查阅打印权限（不可修改题库已配置题目）`;
            copyTextToClipboard(text, `助教【${astName}】账号密码已复制到剪贴板`);
        };

        window.deleteAssistantFromDetail = async function(astId, astUsername, teacherId) {
            const confirmed = await showConfirm(
                '永久删除助教确认',
                `您确定要永久删除助教账号【${astUsername}】吗？此操作无法撤销。`,
                true
            );
            if (!confirmed) return;

            try {
                const res = await fetch(`${API_BASE}?action=db_delete`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        table: 'users',
                        ids: [astId]
                    })
                });
                const json = await res.json();
                if (json.success) {
                    showToast(`助教账号【${astUsername}】已删除`, 'success');
                    loadDbData(dbCurrentPage);
                    try {
                        const getRes = await fetch(`${API_BASE}?action=db_get&table=users&id=${teacherId}`);
                        const getJson = await getRes.json();
                        if (getJson.success && getJson.data?.record) {
                            openDbDetailModal(getJson.data.record, null, 'users');
                        } else {
                            closeDbDetailModal();
                        }
                    } catch(err) {
                        closeDbDetailModal();
                    }
                } else {
                    showToast(json.error || '删除助教失败', 'error');
                }
            } catch (e) {
                showToast('网络请求失败', 'error');
            }
        };

        function copyDbToken(token) {
            if (!token) return;
            copyTextToClipboard(token, `Token 已复制: ${token}`);
        }

        function copyStudentIdName(text) {
            if (!text) return;
            copyTextToClipboard(text, `已复制：${text}`);
        }

        
        function copyWeakPointsFromModal() {
            const el = document.getElementById('modal-weak-points-text');
            if (el && el.innerText.trim()) {
                copyTextToClipboard(el.innerText.trim(), '巩固薄弱点归纳已复制');
            }
        }
        window.copyWeakPointsFromModal = copyWeakPointsFromModal;

        function copyPreviewWeakPointsFromModal() {
            const el = document.getElementById('modal-preview-weak-points-text');
            if (el && el.innerText.trim()) {
                copyTextToClipboard(el.innerText.trim(), '预习薄弱点归纳已复制');
            }
        }
        window.copyPreviewWeakPointsFromModal = copyPreviewWeakPointsFromModal;

        function copyCommentFromModal() {
            const el = document.getElementById('modal-comment-text');
            if (el) {
                const txt = el.innerText.trim();
                if (txt && !txt.startsWith('（暂无')) {
                    copyTextToClipboard(txt, '巩固评语已复制');
                    return;
                }
            }
            showToast('暂无课后巩固评语可复制', 'info');
        }
        window.copyCommentFromModal = copyCommentFromModal;

        function copyPreviewCommentFromModal() {
            const el = document.getElementById('modal-preview-comment-text');
            if (el) {
                const txt = el.innerText.trim();
                if (txt && !txt.startsWith('（暂无')) {
                    copyTextToClipboard(txt, '预习评语已复制');
                    return;
                }
            }
            showToast('暂无课前预习评语可复制', 'info');
        }
        window.copyPreviewCommentFromModal = copyPreviewCommentFromModal;

        function openRetestStudent(token) {
            if (!token) {
                showToast('该学生暂无重测Token', 'error');
                return;
            }
            window.open(`retest.html?token=${encodeURIComponent(token)}`, '_blank');
        }

        async function openRetestDirect(token) {
            if (!token) {
                showToast('该学生暂无重测Token', 'error');
                return;
            }
            try {
                const res = await fetch(`${API_BASE}?action=get_retest_admin_url&token=${encodeURIComponent(token)}`);
                const json = await res.json();
                if (json.success && json.data && json.data.url) {
                    window.open(json.data.url, '_blank');
                } else {
                    window.open(`retest.html?token=${encodeURIComponent(token)}`, '_blank');
                }
            } catch (e) {
                window.open(`retest.html?token=${encodeURIComponent(token)}`, '_blank');
            }
        }

        window.openRetestStudent = openRetestStudent;
        window.openRetestDirect = openRetestDirect;

        function copyWeakPointsOnly(recordIdx, currentTable) {
            let r = window.currentDetailModalRecord;
            if (!r) {
                const isRecordsTab = (typeof activeTab !== 'undefined' && activeTab === 'records') || (currentTable === 'student_records');
                const recordsList = isRecordsTab ? (recCurrentRecords || []) : (dbCurrentRecords || []);
                if (recordsList && recordIdx !== undefined && recordIdx !== null) {
                    r = recordsList[recordIdx];
                }
            }
            if (!r) {
                showToast('未能获取当前学生学情数据，请重新打开详情', 'error');
                return;
            }

            const sName = r.student_name || '学员';
            const wNum = r.week_num ? `第${r.week_num}周` : '本周';
            let sections = [];

            // 1. 巩固错题/薄弱点
            let errs = [];
            try {
                errs = Array.isArray(r.error_questions) ? r.error_questions : JSON.parse(r.error_questions || '[]');
            } catch(e) { errs = []; }

            const validDetails = Array.isArray(r.error_details) ? r.error_details.filter(d => d && d.topic && d.topic !== '未标注考点') : [];
            if (validDetails.length > 0) {
                const lines = validDetails.map(d => `• 第${d.num}题：${d.topic}`);
                const summary = r.weak_points_text || validDetails.map(d => d.topic).filter((v, i, a) => a.indexOf(v) === i).join('、');
                sections.push(`【课后巩固薄弱考点】\n${lines.join('\n')}\n• 薄弱考点归纳：${summary}`);
            } else if (r.weak_points_text && String(r.weak_points_text).trim()) {
                sections.push(`【课后巩固薄弱考点】：${String(r.weak_points_text).trim()}`);
            } else if (errs.length > 0) {
                sections.push(`【课后巩固错题题号】：第 ${errs.join('、')} 题\n（题库暂未录入考点解析，可结合错题本查看题目微课）`);
            } else {
                sections.push(`【课后巩固】：本次作业全部正确，无薄弱错题！`);
            }

            // 2. 预习错题/薄弱点
            let prevErrs = [];
            try {
                prevErrs = Array.isArray(r.preview_error_questions) ? r.preview_error_questions : JSON.parse(r.preview_error_questions || '[]');
            } catch(e) { prevErrs = []; }

            const prevDetails = Array.isArray(r.preview_error_details) ? r.preview_error_details.filter(d => d && d.topic && d.topic !== '未标注考点') : [];
            if (prevDetails.length > 0) {
                const lines = prevDetails.map(d => `• 第${d.num}题：${d.topic}`);
                const summary = r.preview_weak_points_text || prevDetails.map(d => d.topic).filter((v, i, a) => a.indexOf(v) === i).join('、');
                sections.push(`【课前预习薄弱考点】\n${lines.join('\n')}\n• 薄弱考点归纳：${summary}`);
            } else if (r.preview_weak_points_text && String(r.preview_weak_points_text).trim()) {
                sections.push(`【课前预习薄弱考点】：${String(r.preview_weak_points_text).trim()}`);
            } else if (prevErrs.length > 0) {
                sections.push(`【课前预习错题题号】：第 ${prevErrs.join('、')} 题`);
            }

            const text = `【${sName} - ${wNum}薄弱考点汇总】\n` + sections.join('\n\n');
            copyTextToClipboard(text, '已复制学员薄弱考点内容，可直接发送给家长');
        }

        const COMPOUND_SURNAMES_FOR_HONORIFIC = [
            '欧阳', '司马', '上官', '诸葛', '慕容', '令狐', '公孙', '西门', '南宫', '夏侯',
            '尉迟', '轩辕', '端木', '东方', '闾丘', '亓官', '司寇', '子车', '颛孙', '巫马',
            '公西', '漆雕', '乐正', '壤驷', '公良', '拓跋', '夹谷', '宰父', '谷利', '句容',
            '鲜于', '伯夷', '申屠', '公羊', '南荣', '赫连', '皇甫', '宗政', '濮阳', '公冶',
            '太叔', '钟离', '长孙', '宇文', '司徒', '司空', '百里', '呼延', '梁丘', '左丘',
            '东郭'
        ];

        function getStudentHonorific(studentName) {
            const s = (studentName || '').trim();
            if (!s) return '同学';
            for (const surname of COMPOUND_SURNAMES_FOR_HONORIFIC) {
                if (s.startsWith(surname)) {
                    return `${surname}同学`;
                }
            }
            const firstChar = s.charAt(0);
            if (/[\u4e00-\u9fa5]/.test(firstChar)) {
                return `小${firstChar}同学`;
            }
            return `${s}同学`;
        }

        const VARIATION_NOTICE_TEMPLATES = [
            (name) => `课后巩固的“举一反三”题目也已加入错题本，方便${name}后续复习。\n`,
            (name) => `针对课后错题配套的“举一反三”同类练习已同步到错题本，${name}课后可以趁热打铁练一练。\n`,
            (name) => `这次课后错题对应的变式练习已经整理进错题本，方便${name}针对薄弱点查漏补缺。\n`,
            (name) => `错题本里已配好针对薄弱考点的“举一反三”题目，建议${name}复习时顺手过一遍。\n`,
            (name) => `课后巩固的同类变式题已放进错题本，方便${name}把同类题型彻底吃透。\n`,
            (name) => `针对今天这几道错题，错题本已补充了对应的“举一反三”，${name}有空可以练练巩固一下。\n`,
            (name) => `相关的“举一反三”题目已经录入错题本，方便${name}后续巩固思路、加深印象。\n`,
            (name) => `错题本中已加入针对性的“举一反三”巩固题，${name}复习时别忘了重点看看。\n`
        ];

        function hashStudentName(str) {
            let hash = 0;
            const s = String(str || '');
            for (let i = 0; i < s.length; i++) {
                hash = ((hash << 5) - hash) + s.charCodeAt(i);
                hash |= 0;
            }
            return Math.abs(hash);
        }

        function getVariationNotice(studentName, weekNum) {
            const name = getStudentHonorific(studentName);
            const pool = VARIATION_NOTICE_TEMPLATES;
            const week = parseInt(weekNum, 10) || 1;
            const weekShift = week * 3;
            const studentSeed = hashStudentName(studentName);
            const index = (studentSeed + weekShift) % pool.length;
            return pool[index](name);
        }

        function copyParentFullFeedback(recordIdx, currentTable) {
            let r = window.currentDetailModalRecord;
            if (!r) {
                const isRecordsTab = (typeof activeTab !== 'undefined' && activeTab === 'records') || (currentTable === 'student_records');
                const recordsList = isRecordsTab ? (recCurrentRecords || []) : (dbCurrentRecords || []);
                if (recordsList && recordIdx !== undefined && recordIdx !== null) {
                    r = recordsList[recordIdx];
                }
            }
            if (!r) {
                showToast('未能获取当前学生学情数据，请重新打开详情', 'error');
                return;
            }

            const host = window.location.hostname;
            const baseDomain = (host === 'feedbackbackup.wxjifang.cn' || host === 'vipbackup.wxjifang.cn')
                ? 'https://vipbackup.wxjifang.cn'
                : ((host === 'vip.wxjifang.cn' || host === 'wxjifang.cn') ? window.location.origin : 'https://vip.wxjifang.cn');
            const link = r.retest_token ? `${baseDomain}/retest.html?token=${encodeURIComponent(r.retest_token)}` : '';

            let errs = [];
            try { errs = Array.isArray(r.error_questions) ? r.error_questions : JSON.parse(r.error_questions || '[]'); } catch(e){}

            const validDetails = Array.isArray(r.error_details) ? r.error_details.filter(d => d && d.topic && d.topic !== '未标注考点') : [];

            let weakPointsDesc = '';
            if (validDetails.length > 0) {
                weakPointsDesc = validDetails.map(d => `• 第${d.num}题：${d.topic}`).join('\n');
                if (r.weak_points_text && String(r.weak_points_text).trim()) {
                    weakPointsDesc += `\n• 薄弱考点归纳：${String(r.weak_points_text).trim()}`;
                }
            } else if (r.weak_points_text && String(r.weak_points_text).trim()) {
                weakPointsDesc = `• 薄弱考点：${String(r.weak_points_text).trim()}`;
            } else if (errs.length > 0) {
                weakPointsDesc = `• 错题题号：第 ${errs.join('、')} 题 (专属错题本内可查验题目)`;
            } else {
                weakPointsDesc = '• 本周巩固作业全部正确，继续保持！';
            }

            let prevErrs = [];
            try { prevErrs = Array.isArray(r.preview_error_questions) ? r.preview_error_questions : JSON.parse(r.preview_error_questions || '[]'); } catch(e){}
            const prevDetails = Array.isArray(r.preview_error_details) ? r.preview_error_details.filter(d => d && d.topic && d.topic !== '未标注考点') : [];
            let prevWeakPointsDesc = '';
            if (prevDetails.length > 0) {
                prevWeakPointsDesc = prevDetails.map(d => `• 第${d.num}题：${d.topic}`).join('\n');
                if (r.preview_weak_points_text && String(r.preview_weak_points_text).trim()) {
                    prevWeakPointsDesc += `\n• 预习薄弱考点归纳：${String(r.preview_weak_points_text).trim()}`;
                }
            } else if (r.preview_weak_points_text && String(r.preview_weak_points_text).trim()) {
                prevWeakPointsDesc = `• 预习薄弱考点：${String(r.preview_weak_points_text).trim()}`;
            } else if (prevErrs.length > 0) {
                prevWeakPointsDesc = `• 预习错题题号：第 ${prevErrs.join('、')} 题`;
            }

            const hasPrevErrors = prevErrs.length > 0;
            const previewSuffix = '';

            const sName = r.student_name || '同学';
            const hwScore = (r.homework_score !== null && r.homework_score !== undefined && r.homework_score !== '') ? `${r.homework_score}分` : '已按时提交';
            const totalScore = (r.total_score !== null && r.total_score !== undefined && r.total_score !== '') ? ` (满分${r.total_score}分)` : '';
            const prevScore = (r.preview_score !== null && r.preview_score !== undefined && r.preview_score !== '') ? `${r.preview_score}分` : '';
            const wDesc = r.week_num ? `第${r.week_num}周` : '本周';

            const recSubject = r.subject || r._batch?.subject || '';
            const isEnglish = String(recSubject).includes('英语');
            const previewNotice = isEnglish 
                ? '预习题错题已加入错题本。' 
                : '预习题错题已加入错题本，建议结合讲义中的同类题进行巩固。';

            const consolidationNotice = (validDetails.length > 0 || errs.length > 0) 
                ? getVariationNotice(r.student_name, r.week_num || 1)
                : '';

            let previewFeedbackBlock = '';
            if (prevScore || hasPrevErrors || (r.preview_comment && String(r.preview_comment).trim())) {
                previewFeedbackBlock = `\n【课前预习情况】：` +
                    (prevScore ? `\n预习得分：${prevScore}` : '') +
                    (hasPrevErrors ? `\n${previewNotice}` : '') +
                    ((r.preview_comment && String(r.preview_comment).trim()) ? `\n预习评语：${String(r.preview_comment).trim()}` : '');
            }

            const text = 
`【极方学员本周学情反馈】
家长您好！以下是 ${sName} 同学${wDesc}的学习情况反馈：
【课后巩固情况】：
作业巩固成绩：${hwScore}${totalScore}
错题考点与薄弱知识点：
${weakPointsDesc}
${consolidationNotice}教师巩固评语：
${(r.teacher_comment && String(r.teacher_comment).trim()) ? String(r.teacher_comment).trim() : '学习态度认真，继续加油！'}${previewFeedbackBlock}${link ? `\n专属个性化错题本与微课巩固：\n${link}` : ''}`.replace(/\n{2,}/g, '\n');

            copyTextToClipboard(text, '家校学情完整反馈语已复制到剪贴板');
        }

        function copyTextToClipboard(text, successMsg) {
            if (!text) {
                showToast('复制内容为空', 'warning');
                return;
            }
            const msg = successMsg || '已复制到剪贴板';

            const fallback = () => {
                let success = false;
                try {
                    const ta = document.createElement('textarea');
                    ta.value = text;
                    ta.setAttribute('readonly', '');
                    ta.style.position = 'fixed';
                    ta.style.top = '0';
                    ta.style.left = '0';
                    ta.style.width = '2em';
                    ta.style.height = '2em';
                    ta.style.padding = '0';
                    ta.style.border = 'none';
                    ta.style.outline = 'none';
                    ta.style.boxShadow = 'none';
                    ta.style.background = 'transparent';
                    document.body.appendChild(ta);
                    ta.focus();
                    ta.select();
                    ta.setSelectionRange(0, text.length);
                    success = document.execCommand('copy');
                    document.body.removeChild(ta);
                } catch (e) {
                    success = false;
                }
                if (success) {
                    showToast(msg, 'success', 2500);
                } else {
                    showCopyFallbackModal(text, msg);
                }
            };

            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(() => {
                    showToast(msg, 'success', 2500);
                }).catch(err => {
                    console.warn('navigator.clipboard failed, fallback to execCommand', err);
                    fallback();
                });
            } else {
                fallback();
            }
        }

        function showCopyFallbackModal(text, hint) {
            let modal = document.getElementById('copy-fallback-modal');
            if (!modal) {
                modal = document.createElement('dialog');
                modal.id = 'copy-fallback-modal';
                modal.className = 'modal-overlay native-dialog';
                modal.setAttribute('closedby', 'any');
                modal.innerHTML = `
                    <div style="background:#1e293b;border:1px solid #334155;border-radius:10px;padding:20px;max-width:520px;width:100%;box-shadow:0 10px 25px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:12px;">
                        <div style="display:flex;align-items:center;justify-content:space-between;">
                            <h4 style="margin:0;color:#f8fafc;font-size:1rem;font-weight:600;">请手动复制文本</h4>
                            <button type="button" style="background:none;border:none;color:#94a3b8;font-size:1.2rem;cursor:pointer;" onclick="if(window.DialogHelper)window.DialogHelper.close('copy-fallback-modal');else document.getElementById('copy-fallback-modal').style.display='none';">&times;</button>
                        </div>
                        <p style="margin:0;color:#94a3b8;font-size:0.85rem;" id="copy-fallback-hint">浏览器已自动全选文本，请按下 Ctrl+C 复制：</p>
                        <textarea id="copy-fallback-textarea" rows="8" style="width:100%;background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:6px;padding:10px;font-size:0.85rem;font-family:monospace;resize:vertical;outline:none;" readonly></textarea>
                        <div style="display:flex;justify-content:flex-end;gap:8px;">
                            <button type="button" class="btn primary" onclick="const ta=document.getElementById('copy-fallback-textarea');ta.focus();ta.select();document.execCommand('copy');showToast('已复制', 'success');if(window.DialogHelper)window.DialogHelper.close('copy-fallback-modal');else document.getElementById('copy-fallback-modal').style.display='none';">选中并关闭</button>
                        </div>
                    </div>
                `;
                document.body.appendChild(modal);
            }
            if (window.DialogHelper) {
                window.DialogHelper.open(modal, { dismissible: true });
            } else {
                modal.style.display = 'flex';
            }
            const ta = document.getElementById('copy-fallback-textarea');
            const hintEl = document.getElementById('copy-fallback-hint');
            if (hintEl && hint) hintEl.textContent = hint + '（已自动全选，请按 Ctrl+C 复制）：';
            if (ta) {
                ta.value = text;
                setTimeout(() => {
                    ta.focus();
                    ta.select();
                }, 50);
            }
        }

        async function loadRecordHistory(recordId, studentName, batchId, weekNum) {
            const container = document.getElementById(`record-history-list-${recordId}`);
            if (!container) return;
            
            try {
                const res = await fetch(`${API_BASE}?action=record_history&record_id=${encodeURIComponent(recordId)}&student_name=${encodeURIComponent(studentName || '')}&batch_id=${encodeURIComponent(batchId || 0)}&week_num=${encodeURIComponent(weekNum || 0)}`);
                const json = await res.json();
                if (!json.success || !json.data || !Array.isArray(json.data.history) || json.data.history.length === 0) {
                    container.innerHTML = `
                        <div style="font-size: 0.82rem; color: var(--text-muted); padding: 12px; text-align: center; background: var(--bg-subtle); border: 1px dashed var(--border-color); border-radius: 6px;">
                            暂无被覆盖或修改的历史版本（当前数据为初次生成状态）
                        </div>
                    `;
                    return;
                }

                const list = json.data.history;
                container.innerHTML = list.map((h, i) => {
                    const opTypeMap = {
                        'batch_overwrite': '<span style="background: rgba(239,68,68,0.12); color: var(--error); border: 1px solid rgba(239,68,68,0.25); padding: 1px 7px; border-radius: 4px; font-size: 0.72rem; font-weight: 600;">批量覆盖</span>',
                        'admin_edit': '<span style="background: rgba(245,158,11,0.12); color: #d97706; border: 1px solid rgba(245,158,11,0.25); padding: 1px 7px; border-radius: 4px; font-size: 0.72rem; font-weight: 600;">手动修改</span>',
                        'before_rollback': '<span style="background: rgba(139,92,246,0.12); color: #7c3aed; border: 1px solid rgba(139,92,246,0.25); padding: 1px 7px; border-radius: 4px; font-size: 0.72rem; font-weight: 600;">回溯快照</span>'
                    };
                    const opBadge = opTypeMap[h.operation_type] || `<span style="background: var(--bg-hover); color: var(--text-secondary); border: 1px solid var(--border-color); padding: 1px 6px; border-radius: 4px; font-size: 0.72rem;">${escapeHtml(h.operation_type)}</span>`;
                    
                    let errsStr = '无错题';
                    if (h.error_questions_list && h.error_questions_list.length > 0) {
                        errsStr = h.error_questions_list.join('、');
                    }

                    let prevErrsStr = '';
                    if (h.preview_error_questions_list && h.preview_error_questions_list.length > 0) {
                        prevErrsStr = h.preview_error_questions_list.join('、');
                    }

                    let srcStr = '-';
                    if (h.source_files_list && h.source_files_list.length > 0) {
                        srcStr = h.source_files_list.join(', ');
                    }

                    return `
                        <div style="background: var(--bg-subtle); border: 1px solid var(--border-color); border-radius: 6px; padding: 10px 14px; display: flex; flex-direction: column; gap: 8px;">
                            <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px; border-bottom: 1px solid var(--border-color); padding-bottom: 6px;">
                                <div style="display: flex; align-items: center; gap: 8px;">
                                    <span style="font-weight: 700; color: var(--text-primary); font-family: var(--font-mono); font-size: 0.85rem;">版本 #${h.id}</span>
                                    ${opBadge}
                                    <span style="font-size: 0.75rem; color: var(--text-muted);">${formatTimestamp(h.archived_at)}</span>
                                </div>
                                <button type="button" class="btn danger" style="padding: 3px 10px; font-size: 0.75rem; display: inline-flex; align-items: center; gap: 4px;" onclick="rollbackRecordVersion(${h.id}, '${escapeInlineJs(studentName)}', ${h.week_num})">
                                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><polyline points="3 3 3 8 8 8"></polyline></svg>
                                    <span>回溯至此版本</span>
                                </button>
                            </div>
                            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; font-size: 0.8rem;">
                                <div><span style="color: var(--text-muted);">操作人：</span><span style="color: var(--text-primary); font-weight: 600;">${escapeHtml(h.operator || h.created_by || '-')}</span></div>
                                <div><span style="color: var(--text-muted);">当时批次：</span><span style="color: var(--primary); font-family: var(--font-mono); font-weight: 600;">${escapeHtml(h.batch_code || '-')}</span></div>
                                <div><span style="color: var(--text-muted);">得分：</span>巩固 <b style="color: var(--text-primary); font-family: var(--font-mono);">${formatScore(h.homework_score)}</b> / 预习 <b style="color: var(--text-secondary); font-family: var(--font-mono);">${formatScore(h.preview_score)}</b></div>
                                <div><span style="color: var(--text-muted);">巩固错题：</span><span style="color: var(--error); font-weight: 600;">${escapeHtml(errsStr)}</span></div>
                                ${prevErrsStr ? `<div><span style="color: var(--text-muted);">预习错题：</span><span style="color: #6366f1; font-weight: 600;">${escapeHtml(prevErrsStr)}</span></div>` : ''}
                            </div>
                            ${h.teacher_comment ? `
                                <div style="font-size: 0.78rem; color: var(--text-primary); background: var(--bg-surface); border: 1px solid var(--border-color); padding: 6px 10px; border-radius: 4px; line-height: 1.45;">
                                    <span style="color: var(--text-muted);">当时巩固评语：</span>${escapeHtml(h.teacher_comment)}
                                </div>
                            ` : ''}
                            ${h.preview_comment ? `
                                <div style="font-size: 0.78rem; color: var(--text-primary); background: var(--bg-surface); border: 1px solid var(--border-color); padding: 6px 10px; border-radius: 4px; line-height: 1.45;">
                                    <span style="color: var(--text-muted);">当时预习评语：</span>${escapeHtml(h.preview_comment)}
                                </div>
                            ` : ''}
                            ${h.source_files_list && h.source_files_list.length > 0 ? `
                                <div style="font-size: 0.75rem; color: var(--text-secondary); display: flex; align-items: center; flex-wrap: wrap; gap: 6px;">
                                    <span style="color: var(--text-muted);">当时上传文件：</span>
                                    ${h.source_files_list.map(fn => renderSourceFileChip(fn, { recordId: h.record_id || recordId || 0, historyId: h.id || 0, batchCode: h.batch_code || '', variant: 'default' })).join('')}
                                </div>
                            ` : ''}
                        </div>
                    `;
                }).join('');
            } catch (e) {
                container.innerHTML = `<div style="font-size: 0.8rem; color: #f87171; padding: 8px;">加载历史版本失败: ${escapeHtml(e.message)}</div>`;
            }
        }

        function renderSourceFileChip(fileName, options = {}) {
            const fn = String(fileName || '').trim();
            if (!fn) return '';
            const recId = Number(options.recordId || 0) || 0;
            const histId = Number(options.historyId || 0) || 0;
            const batchCode = String(options.batchCode || '').trim();
            const variant = options.variant || 'default';

            let style = 'font-size: 0.78rem; background: var(--bg-subtle); border: 1px solid var(--border-color); color: var(--text-secondary); padding: 3px 8px;';
            if (variant === 'preview') {
                style = 'font-size: 0.76rem; background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.3); color: #fbbf24; padding: 2px 7px;';
            } else if (variant === 'homework') {
                style = 'font-size: 0.76rem; background: rgba(56,189,248,0.08); border: 1px solid rgba(56,189,248,0.3); color: #38bdf8; padding: 2px 7px;';
            }

            const safeFnArg = escapeHtml(JSON.stringify(fn));
            const safeBatchArg = escapeHtml(JSON.stringify(batchCode));

            return `
                <button type="button"
                        onclick="downloadAdminSourceFile(${safeFnArg}, ${recId}, ${histId}, ${safeBatchArg})"
                        title="点击下载上传原件：${escapeHtml(fn)}"
                        style="${style} border-radius: 4px; display: inline-flex; align-items: center; gap: 5px; word-break: break-all; cursor: pointer; font-family: inherit; transition: opacity 0.15s;"
                        onmouseover="this.style.opacity='0.82'"
                        onmouseout="this.style.opacity='1'">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                    <span>${escapeHtml(fn)}</span>
                </button>
            `;
        }

        async function downloadAdminSourceFile(fileName, recordId = 0, historyId = 0, batchCode = '') {
            if (!fileName) return;
            const params = new URLSearchParams({
                action: 'download_source_file',
                file_name: fileName
            });
            if (recordId) params.set('record_id', String(recordId));
            if (historyId) params.set('history_id', String(historyId));
            if (batchCode) params.set('batch_code', String(batchCode));

            try {
                const checkParams = new URLSearchParams(params);
                checkParams.set('check_only', '1');
                const res = await fetch(`${API_BASE}?${checkParams.toString()}`);
                const json = await res.json();
                if (!json || !json.success) {
                    showToast((json && json.error) || '未找到对应上传原件（可能已超过30天保留期）', 'warning', 3500);
                    return;
                }
                const dlUrl = `${API_BASE}?${params.toString()}`;
                const a = document.createElement('a');
                a.href = dlUrl;
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                showToast(`正在下载原件：${fileName}`, 'success', 2500);
            } catch (e) {
                showToast('下载请求失败: ' + e.message, 'error', 3500);
            }
        }

        async function rollbackRecordVersion(historyId, studentName, weekNum) {
            const confirmed = await showConfirm(
                '确认回溯学情数据',
                `您确定要将学生【${studentName}】(第${weekNum}周) 的学情记录回溯至版本 #${historyId} 吗？\n\n系统会在回溯前自动将当前状态另存为快照，以保证绝对安全。`,
                true
            );
            if (!confirmed) return;

            try {
                const res = await fetch(`${API_BASE}?action=record_rollback`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ history_id: historyId })
                });
                const json = await res.json();
                if (json.success) {
                    showToast(json.data?.message || '已成功回溯', 'success', 3000);
                    // 刷新数据源
                    if (typeof activeTab !== 'undefined' && activeTab === 'records') {
                        await loadRecordsData(recCurrentPage);
                    } else if (typeof activeTab !== 'undefined' && activeTab === 'database') {
                        await loadDbData(dbCurrentPage);
                    }
                    closeDbDetailModal();
                } else {
                    showToast('回溯失败: ' + (json.error || '未知错误'), 'error', 4000);
                }
            } catch (e) {
                showToast('请求出错: ' + e.message, 'error', 4000);
            }
        }


/* ============================================================================
 * [MODULE] changelog.js - Tab 4: 更新日志管理
 * ============================================================================ */


/**
 * Admin 更新日志模块 (Tab 4: loadChangelog, saveChangelog)
 */

        /* ========================================================
           TAB 4: Changelog Logic
           ======================================================== */
        let changelogs = [];

        async function loadChangelogs() {
            try {
                const res = await fetch(`${CHANGELOG_API}?action=getAll`);
                const json = await res.json();
                if (json.success) {
                    changelogs = json.data || [];
                    renderChangelogs();
                }
            } catch (e) {
                console.error('Failed to load changelogs', e);
            }
        }

        function renderChangelogs() {
            const tbody = document.getElementById('changelog-tbody');
            if (!tbody) return;
            if (!changelogs.length) {
                tbody.innerHTML = '<tr><td colspan="4" class="table-empty"><div class="empty-state"><span>暂无更新日志记录</span></div></td></tr>';
                return;
            }
            tbody.innerHTML = changelogs.map(cl => `
                <tr>
                    <td>
                        <div style="font-weight:700; color: var(--text-primary); font-size:0.95rem;">${escapeHtml(cl.version || '未标注版本')}</div>
                        <div class="cell-mono" style="font-size:0.8rem; color:var(--text-muted); margin-top:2px;">${cl.date || '-'}</div>
                    </td>
                    <td>
                        <div style="font-weight:600; color: var(--text-primary);">${escapeHtml(cl.title || '无标题')}</div>
                        <div style="font-size:0.8rem; color:var(--text-muted); margin-top:2px;">包含 ${cl.items?.length || 0} 个更新明细项</div>
                    </td>
                    <td>
                        <button class="action-tag ${cl.active ? 'action' : 'warn'}" onclick="toggleChangelogActive('${cl.id}')" style="cursor:pointer; border:none; outline:none;" title="点击切换是否向访客自动弹出">
                            ${cl.active ? '<span class="status-dot green"></span>活跃推送中 (自动弹出)' : '<span class="status-dot gray"></span>存档未推送'}
                        </button>
                    </td>
                    <td style="text-align:right; white-space: nowrap;">
                        <button class="btn-action edit" onclick="openChangelogModal('${cl.id}')">编辑</button>
                        <button class="btn-action delete" onclick="deleteChangelog('${cl.id}')">删除</button>
                    </td>
                </tr>
            `).join('');
        }

        function addChangelogItemRow(title = '', desc = '') {
            const container = document.getElementById('cl-items-container');
            const row = document.createElement('div');
            row.className = 'cl-item-row';
            row.style.display = 'flex';
            row.style.gap = '10px';
            row.style.alignItems = 'flex-start';
            row.style.background = 'rgba(0,0,0,0.3)';
            row.style.padding = '12px';
            row.style.borderRadius = 'var(--radius-sm)';
            row.style.border = '1px solid var(--border-color)';

            row.innerHTML = `
                <div style="flex:1; display:flex; flex-direction:column; gap:8px;">
                    <input type="text" class="custom-input cl-item-title" style="width:100%; box-sizing:border-box; padding:8px 12px;" placeholder="条目小标题，例如：新特性 / 性能优化" value="${title.replace(/"/g, '&quot;')}">
                    <textarea class="custom-input cl-item-desc" style="width:100%; box-sizing:border-box; padding:8px 12px; resize:vertical; min-height:60px;" placeholder="详细描述内容...">${desc.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
                </div>
                <button class="btn danger-subtle" style="padding:6px; height:fit-content;" onclick="this.closest('.cl-item-row').remove()" title="删除该项">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                </button>
            `;
            container.appendChild(row);
        }

        function openChangelogModal(id = null) {
            const modal = document.getElementById('changelog-modal');
            const isEdit = !!id;
            document.getElementById('cl-modal-title').textContent = isEdit ? '编辑更新公告' : '新增版本更新公告';
            const container = document.getElementById('cl-items-container');
            container.innerHTML = '';

            if (isEdit) {
                const cl = changelogs.find(c => c.id === id);
                if (!cl) return;
                document.getElementById('cl-id').value = cl.id;
                document.getElementById('cl-version').value = cl.version || '';
                document.getElementById('cl-date').value = cl.date || '';
                document.getElementById('cl-title').value = cl.title || '';
                document.getElementById('cl-active').checked = !!cl.active;

                if (cl.items && cl.items.length > 0) {
                    cl.items.forEach(item => addChangelogItemRow(item.title, item.desc));
                } else {
                    addChangelogItemRow();
                }
            } else {
                document.getElementById('cl-id').value = '';
                document.getElementById('cl-version').value = '';
                document.getElementById('cl-date').value = new Date().toISOString().split('T')[0];
                document.getElementById('cl-title').value = '';
                document.getElementById('cl-active').checked = false;
                addChangelogItemRow();
            }
            if (window.DialogHelper) {
                window.DialogHelper.open(modal, { dismissible: true });
            } else {
                modal.style.display = 'flex';
            }
        }

        function closeChangelogModal() {
            const modal = document.getElementById('changelog-modal');
            if (modal) {
                if (window.DialogHelper) {
                    window.DialogHelper.close(modal);
                } else {
                    modal.style.display = 'none';
                }
            }
        }

        async function saveChangelog() {
            try {
                const id = document.getElementById('cl-id').value;
                const version = document.getElementById('cl-version').value.trim();
                const date = document.getElementById('cl-date').value;
                const title = document.getElementById('cl-title').value.trim();
                const active = document.getElementById('cl-active').checked;

                if (!version || !title) {
                    showToast('版本号与主标题为必填项', 'warn');
                    return;
                }

                let items = [];
                const itemNodes = document.querySelectorAll('.cl-item-row');
                itemNodes.forEach(node => {
                    const t = node.querySelector('.cl-item-title').value.trim();
                    const d = node.querySelector('.cl-item-desc').value.trim();
                    if (t || d) items.push({ title: t, desc: d });
                });

                const payload = { log: { id, version, date, title, active, items } };
                const res = await fetch(`${CHANGELOG_API}?action=save`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const json = await res.json();
                if (json.success) {
                    closeChangelogModal();
                    showToast('更新日志已保存', 'success');
                    loadChangelogs();
                } else {
                    showToast(json.error || '保存失败', 'error');
                }
            } catch (e) {
                showToast('网络请求异常', 'error');
            }
        }

        async function deleteChangelog(id) {
            const confirmed = await showConfirm(
                '删除更新日志',
                '确认永久删除该条更新日志记录吗？',
                true
            );
            if (!confirmed) return;

            const res = await fetch(`${CHANGELOG_API}?action=delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            });
            const json = await res.json();
            if (json.success) {
                showToast('更新日志已删除', 'success');
                loadChangelogs();
            } else {
                showToast(json.error || '删除失败', 'error');
            }
        }

        async function toggleChangelogActive(id) {
            const res = await fetch(`${CHANGELOG_API}?action=setActive`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            });
            const json = await res.json();
            if (json.success) {
                showToast('日志推送状态已更新', 'success');
                loadChangelogs();
            } else {
                showToast(json.error || '状态切换失败', 'error');
            }
        }


/* ============================================================================
 * [MODULE] token-search.js - 错题本 Token 快捷反查学情
 * ============================================================================ */


/**
 * Admin 错题本 Token 反查模块 (searchStudentByToken, openTokenSearchModal)
 */

        /* ========================================================
           Token 智能反查学生 (Token Search Student Feature)
           ======================================================== */
        let tokenSearchAbortController = null;

        function openTokenSearchModal(prefillToken = '') {
            const modal = document.getElementById('token-search-modal');
            const input = document.getElementById('token-modal-input');
            if (!modal || !input) return;

            if (window.DialogHelper) {
                window.DialogHelper.open(modal, { dismissible: true });
            } else {
                modal.style.display = 'flex';
            }
            if (prefillToken) {
                input.value = prefillToken.trim();
                toggleTokenModalClearBtn();
                doSearchStudentByToken();
            } else {
                toggleTokenModalClearBtn();
                setTimeout(() => input.focus(), 80);
            }
        }

        function closeTokenSearchModal() {
            const modal = document.getElementById('token-search-modal');
            if (modal) {
                if (window.DialogHelper) {
                    window.DialogHelper.close(modal);
                } else {
                    modal.style.display = 'none';
                }
            }
        }

        function toggleTokenModalClearBtn() {
            const input = document.getElementById('token-modal-input');
            const clearBtn = document.getElementById('token-modal-clear-btn');
            if (!input || !clearBtn) return;
            clearBtn.style.display = input.value.trim() ? 'block' : 'none';
        }

        function clearTokenModalInput() {
            const input = document.getElementById('token-modal-input');
            const resultBox = document.getElementById('token-search-result-box');
            if (input) {
                input.value = '';
                input.focus();
            }
            toggleTokenModalClearBtn();
            if (resultBox) {
                resultBox.innerHTML = `
                    <div style="text-align: center; padding: 36px 16px; border: 1px dashed var(--border-color); border-radius: var(--radius-md); background: rgba(255,255,255,0.02);">
                        <div class="empty-state-icon primary">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle></svg>
                        </div>
                        <div style="font-size: 0.95rem; font-weight: 600; color: var(--text-primary); margin-bottom: 6px;">支持多种输入格式精准反查学生</div>
                        <div style="font-size: 0.8rem; color: var(--text-muted); line-height: 1.7; max-width: 460px; margin: 0 auto;">
                            • <b>10位短 Token</b>：例如 <code>elWy8pZZdB</code><br>
                            • <b>完整链接</b>：例如 <code>https://vip.wxjifang.cn/retest.html?token=...</code><br>
                            • <b>历史加密串</b>：系统将自动在数据库、索引档案库及加密还原库中协同检索
                        </div>
                    </div>
                `;
            }
        }

        async function pasteFromClipboardToTokenSearch() {
            const input = document.getElementById('token-modal-input');
            if (!input) return;
            try {
                if (navigator.clipboard && navigator.clipboard.readText) {
                    const text = await navigator.clipboard.readText();
                    if (text && text.trim()) {
                        input.value = text.trim();
                        toggleTokenModalClearBtn();
                        showToast('已从剪贴板粘贴', 'info', 1500);
                        doSearchStudentByToken();
                        return;
                    }
                }
            } catch (e) {
                console.warn('Clipboard read failed', e);
            }
            input.focus();
            showToast('请直接在输入框按 Ctrl+V 粘贴', 'info');
        }

        async function doSearchStudentByToken() {
            const input = document.getElementById('token-modal-input');
            const resultBox = document.getElementById('token-search-result-box');
            const searchBtn = document.getElementById('token-modal-search-btn');
            if (!input || !resultBox) return;

            const val = input.value.trim();
            if (!val) {
                showToast('请输入要查询的 Token 或错题本链接', 'warn');
                input.focus();
                return;
            }

            if (tokenSearchAbortController) {
                tokenSearchAbortController.abort();
            }
            tokenSearchAbortController = new AbortController();

            if (searchBtn) searchBtn.disabled = true;
            resultBox.innerHTML = `
                <div style="text-align: center; padding: 40px 16px;">
                    <div style="display: inline-block; width: 32px; height: 32px; border: 3px solid rgba(59,130,246,0.2); border-top-color: var(--primary); border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
                    <div style="font-size: 0.92rem; color: var(--text-secondary); margin-top: 14px; font-weight: 500;">正在多源检索 Token 关联的学生档案...</div>
                </div>
            `;

            try {
                const res = await fetch(`${API_BASE}?action=search_by_token&token=${encodeURIComponent(val)}`, {
                    signal: tokenSearchAbortController.signal
                });
                const json = await res.json();
                if (json.success && json.data) {
                    renderTokenSearchResults(json.data);
                } else {
                    resultBox.innerHTML = `
                        <div style="text-align: center; padding: 32px 16px; border: 1px solid rgba(239,68,68,0.3); border-radius: var(--radius-md); background: rgba(239,68,68,0.05);">
                            <div class="empty-state-icon danger">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                            </div>
                            <div style="font-size: 0.95rem; font-weight: 600; color: #ef4444; margin-bottom: 4px;">查询失败</div>
                            <div style="font-size: 0.84rem; color: var(--text-secondary);">${escapeHtml(json.error || '未找到有效数据')}</div>
                        </div>
                    `;
                }
            } catch (err) {
                if (err.name === 'AbortError') return;
                console.error('Token search error', err);
                resultBox.innerHTML = `
                    <div style="text-align: center; padding: 32px 16px; border: 1px solid rgba(239,68,68,0.3); border-radius: var(--radius-md); background: rgba(239,68,68,0.05);">
                        <div class="empty-state-icon danger">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                        </div>
                        <div style="font-size: 0.95rem; font-weight: 600; color: #ef4444; margin-bottom: 4px;">请求异常</div>
                        <div style="font-size: 0.84rem; color: var(--text-secondary);">网络通信失败，请检查服务器连接</div>
                    </div>
                `;
            } finally {
                if (searchBtn) searchBtn.disabled = false;
            }
        }

        function renderTokenSearchResults(data) {
            const resultBox = document.getElementById('token-search-result-box');
            if (!resultBox) return;

            const matches = data.matches || [];
            if (!data.found || matches.length === 0) {
                resultBox.innerHTML = `
                    <div style="text-align: center; padding: 36px 16px; border: 1px dashed var(--border-color); border-radius: var(--radius-md); background: rgba(255,255,255,0.02);">
                        <div class="empty-state-icon warn">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                        </div>
                        <div style="font-size: 0.96rem; font-weight: 600; color: var(--text-primary); margin-bottom: 6px;">
                            未检索到与该 Token 匹配的学生记录
                        </div>
                        <div style="font-size: 0.82rem; color: var(--text-muted); line-height: 1.6; max-width: 480px; margin: 0 auto;">
                            查询关键词: <code>${escapeHtml(data.search_token || '')}</code><br>
                            可能原因：该 Token 尚未生成归档、由离线生成但班级快照未载入、或输入的字符串不完整。
                        </div>
                    </div>
                `;
                return;
            }

            let html = `
                <div style="margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
                    <span style="font-size: 0.85rem; font-weight: 600; color: var(--text-secondary);">
                        共检索到 <b style="color: var(--primary);">${matches.length}</b> 条关联学情记录：
                    </span>
                    <span style="font-size: 0.78rem; color: var(--text-muted);">
                        Token: <code style="background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 4px; color: var(--text-primary); font-family: monospace;">${escapeHtml(data.search_token)}</code>
                    </span>
                </div>
            `;

            matches.forEach((item, idx) => {
                const sName = item.student_name || '未知学生';
                const initial = sName.charAt(0);
                const sId = item.student_id ? `学号: ${escapeHtml(item.student_id)}` : '';
                const sKey = item.student_key || sName;

                // 错题 Badges (巩固与预习)
                let errBadgesHtml = '';
                const hasHwErrors = item.error_questions && Array.isArray(item.error_questions) && item.error_questions.length > 0;
                const hasPrevErrors = item.preview_error_questions && Array.isArray(item.preview_error_questions) && item.preview_error_questions.length > 0;

                if (hasHwErrors || hasPrevErrors) {
                    let badgeRows = [];
                    if (hasHwErrors) {
                        const badges = item.error_questions.map(q => 
                            `<span style="display:inline-block; padding: 2px 8px; border-radius: 4px; background: rgba(239,68,68,0.12); color: #ef4444; font-weight: 700; font-size: 0.8rem; border: 1px solid rgba(239,68,68,0.25); margin-right: 4px; margin-bottom: 4px;">第${escapeHtml(String(q))}题</span>`
                        ).join('');
                        badgeRows.push(`
                            <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 4px;">
                                <span style="font-size: 0.78rem; font-weight: 600; color: var(--primary); margin-right: 4px;">巩固错题:</span>
                                ${badges}
                            </div>
                        `);
                    }
                    if (hasPrevErrors) {
                        const prevBadges = item.preview_error_questions.map(q => 
                            `<span style="display:inline-block; padding: 2px 8px; border-radius: 4px; background: rgba(99,102,241,0.12); color: #6366f1; font-weight: 700; font-size: 0.8rem; border: 1px solid rgba(99,102,241,0.25); margin-right: 4px; margin-bottom: 4px;">第${escapeHtml(String(q))}题</span>`
                        ).join('');
                        badgeRows.push(`
                            <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 4px;">
                                <span style="font-size: 0.78rem; font-weight: 600; color: #6366f1; margin-right: 4px;">预习错题:</span>
                                ${prevBadges}
                            </div>
                        `);
                    }
                    errBadgesHtml = `
                        <div style="padding: 10px 18px; background: rgba(255,255,255,0.015); border-top: 1px solid var(--border-color); display: flex; flex-direction: column; gap: 6px;">
                            ${badgeRows.join('')}
                        </div>
                    `;
                }

                // 评语 Block (巩固评语与预习评语)
                let commentHtml = '';
                if (item.teacher_comment || item.preview_comment) {
                    let commentRows = [];
                    if (item.teacher_comment) {
                        commentRows.push(`
                            <div style="display: flex; align-items: flex-start; gap: 6px;">
                                <span style="display:inline-flex; align-items:center; gap:4px; font-weight: 600; color: var(--primary); flex-shrink: 0;"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>巩固评语:</span>
                                <span style="color: var(--text-secondary); line-height: 1.5;">${escapeHtml(item.teacher_comment)}</span>
                            </div>
                        `);
                    }
                    if (item.preview_comment) {
                        commentRows.push(`
                            <div style="display: flex; align-items: flex-start; gap: 6px;">
                                <span style="display:inline-flex; align-items:center; gap:4px; font-weight: 600; color: #6366f1; flex-shrink: 0;"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>预习评语:</span>
                                <span style="color: var(--text-secondary); line-height: 1.5;">${escapeHtml(item.preview_comment)}</span>
                            </div>
                        `);
                    }
                    commentHtml = `
                        <div style="padding: 10px 18px; border-top: 1px solid var(--border-color); font-size: 0.82rem; display: flex; flex-direction: column; gap: 6px; background: rgba(255,255,255,0.015);">
                            ${commentRows.join('')}
                        </div>
                    `;
                }

                // 班级显示
                const classTitle = item.class_name || `${item.grade || ''} ${item.tier || ''} ${item.subject || ''}`.trim() || '未分班';
                const weekText = item.week_num ? `第 ${item.week_num} 周${(item.preview_week_num && String(item.preview_week_num) !== String(item.week_num)) ? ` (预习第${item.preview_week_num}周)` : ''}` : '综合周次';
                const hwScore = item.homework_score !== null ? `${formatScore(item.homework_score)} 分` : '<span style="color:var(--text-muted); font-weight:normal;">未录入</span>';
                const prevScore = (item.preview_score !== null && item.preview_score !== undefined && item.preview_score !== '') ? `${formatScore(item.preview_score)} 分` : null;

                // 生成错题本链接 (优先使用服务器回传的免密地址)
                const baseUrl = window.location.href.substring(0, window.location.href.lastIndexOf('/') + 1);
                const fullRetestLink = baseUrl + (item.retest_url || ('retest.html?token=' + encodeURIComponent(item.token)));

                html += `
                    <div style="border: 1px solid var(--border-color); border-radius: var(--radius-md); background: rgba(255,255,255,0.025); margin-bottom: 14px; overflow: hidden; box-shadow: 0 4px 14px rgba(0,0,0,0.08);">
                        <!-- Header -->
                        <div style="padding: 14px 18px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border-color); background: rgba(59, 130, 246, 0.06);">
                            <div style="display: flex; align-items: center; gap: 12px;">
                                <div style="width: 42px; height: 42px; border-radius: 50%; background: linear-gradient(135deg, #3b82f6, #8b5cf6); color: #fff; font-weight: 700; font-size: 1.15rem; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 8px rgba(59,130,246,0.3); flex-shrink: 0;">
                                    ${escapeHtml(initial)}
                                </div>
                                <div>
                                    <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                                        <span style="font-size: 1.18rem; font-weight: 700; color: var(--text-primary);">${escapeHtml(sName)}</span>
                                        ${sId ? `<span style="font-size: 0.76rem; background: rgba(59, 130, 246, 0.15); color: #3b82f6; padding: 2px 8px; border-radius: 12px; font-weight: 600; font-family: monospace;">${sId}</span>` : ''}
                                    </div>
                                    <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 2px;">
                                        唯一标识: <code style="color: var(--text-secondary);">${escapeHtml(sKey)}</code>
                                    </div>
                                </div>
                            </div>
                            <span style="font-size: 0.75rem; padding: 4px 10px; border-radius: 12px; background: rgba(16, 185, 129, 0.15); color: #10b981; font-weight: 600; flex-shrink: 0;">
                                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:3px;vertical-align:-1px;"><polyline points="20 6 9 17 4 12"></polyline></svg> ${escapeHtml(item.source || '匹配成功')}
                            </span>
                        </div>

                        <!-- Info Grid -->
                        <div style="padding: 14px 18px; display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; font-size: 0.86rem;">
                            <div>
                                <span style="color: var(--text-muted); display: block; font-size: 0.75rem; margin-bottom: 2px;">教学班级 / 学科</span>
                                <strong style="color: var(--text-primary); font-size: 0.92rem;">${escapeHtml(classTitle)}</strong>
                            </div>
                            <div>
                                <span style="color: var(--text-muted); display: block; font-size: 0.75rem; margin-bottom: 2px;">课后作业周次</span>
                                <strong style="color: var(--text-primary); font-size: 0.92rem;">${escapeHtml(weekText)}</strong>
                            </div>
                            <div>
                                <span style="color: var(--text-muted); display: block; font-size: 0.75rem; margin-bottom: 2px;">课后巩固成绩</span>
                                <span style="font-weight: 700; font-size: 0.95rem; color: #10b981;">${hwScore}</span>
                            </div>
                            <div>
                                <span style="color: var(--text-muted); display: block; font-size: 0.75rem; margin-bottom: 2px;">课前预习成绩</span>
                                <span style="font-weight: 700; font-size: 0.95rem; color: #6366f1;">${prevScore || '-'}</span>
                            </div>
                            <div>
                                <span style="color: var(--text-muted); display: block; font-size: 0.75rem; margin-bottom: 2px;">错题总数 (巩固/预习)</span>
                                <span style="font-weight: 700; font-size: 0.92rem; color: ${(item.error_count > 0 || (item.preview_error_questions && item.preview_error_questions.length > 0)) ? '#ef4444' : '#10b981'};">
                                    巩固 ${item.error_count > 0 ? `${item.error_count}题` : '全对'} / 预习 ${(item.preview_error_questions && item.preview_error_questions.length > 0) ? `${item.preview_error_questions.length}题` : '全对'}
                                </span>
                            </div>
                        </div>

                        ${errBadgesHtml}
                        ${commentHtml}

                        <!-- Action Bar -->
                        <div style="padding: 12px 18px; border-top: 1px solid var(--border-color); background: rgba(0,0,0,0.06); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;">
                            <div style="display: flex; align-items: center; gap: 6px; font-size: 0.8rem; color: var(--text-muted);">
                                <span>Token:</span>
                                <code style="background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 4px; color: var(--text-primary); font-family: monospace;">${escapeHtml(item.token)}</code>
                            </div>
                            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                                <button type="button" class="btn secondary" style="padding: 5px 11px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 4px;" onclick="copyDbToken('${escapeInlineJs(item.token)}')">
                                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg>
                                    <span>复制Token</span>
                                </button>
                                <button type="button" class="btn secondary" style="padding: 5px 11px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 4px;" onclick="copyFullRetestLink('${escapeInlineJs(fullRetestLink)}')">
                                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
                                    <span>复制链接</span>
                                </button>
                                <button type="button" class="btn secondary" style="padding: 5px 11px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 4px;" onclick="locateStudentInRecords('${escapeInlineJs(sName)}')">
                                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle></svg>
                                    <span>在列表中定位</span>
                                </button>
                                <button type="button" class="btn secondary" style="padding: 5px 11px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 4px;" onclick="openRetestStudent('${escapeInlineJs(item.token)}')" title="打开学员/家长端错题本（需输入姓名验证）">
                                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>
                                    <span>错题本</span>
                                </button>
                                <button type="button" class="btn secondary" style="padding: 5px 11px; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 4px;" onclick="openRetestDirect('${escapeInlineJs(item.token)}')" title="管理员免密直达错题本">
                                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polygon points="12 8 8 12 12 16 12 8"></polygon></svg>
                                    <span>管理员错题本</span>
                                </button>
                            </div>
                        </div>
                    </div>
                `;
            });

            // Access logs
            if (data.access_logs && data.access_logs.length > 0) {
                const logsRows = data.access_logs.map(log => `
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 5px 8px; border-radius: 4px; background: rgba(255,255,255,0.02); font-size: 0.78rem;">
                        <span style="color: var(--text-secondary);">
                            <span style="color: var(--primary); font-weight: 600;">[${escapeHtml(log.action || '访问')}]</span>
                            ${escapeHtml(log.details || '')}
                        </span>
                        <span style="color: var(--text-muted); font-family: monospace; font-size: 0.74rem;">
                            ${escapeHtml(log.ip || '')} · ${escapeHtml(log.created_at || '')}
                        </span>
                    </div>
                `).join('');

                html += `
                    <div style="margin-top: 14px; padding: 12px 14px; border-radius: var(--radius-md); background: rgba(255,255,255,0.015); border: 1px dashed var(--border-color);">
                        <div style="font-size: 0.82rem; font-weight: 600; color: var(--text-secondary); margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                            <span>家长端访问审计记录 (最近 ${data.access_logs.length} 条)</span>
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 4px;">
                            ${logsRows}
                        </div>
                    </div>
                `;
            }

            resultBox.innerHTML = html;
        }

        function copyFullRetestLink(url) {
            if (!url) return;
            copyTextToClipboard(url, '错题本链接已复制到剪贴板');
        }

        function locateStudentInRecords(studentName) {
            closeTokenSearchModal();
            switchTab('records');
            const searchInput = document.getElementById('rec-search-input');
            if (searchInput) {
                searchInput.value = studentName;
                loadRecordsData(1);
                showToast(`已在学情列表中筛选学生：${studentName}`, 'info', 2500);
            }
        }


/* ============================================================================
 * [MODULE] qbank-audit.js - 题库存证回执总览与操作复盘时间线
 * ============================================================================ */


/**
 * Admin 题库存证与复盘时间线模块 (qbank_matrix, qbank_timeline, qbank_revisions)
 */

        /* ========================================================
           TAB: Qbank Audit & Attestation Timeline (题库存证)
           ======================================================== */
        let qbaViewMode = 'both'; // 'both' | 'matrix' | 'timeline'
        let qbaMatrixItems = [];
        let qbaMatrixSearchTimer = null;

        let qbaTlPage = 1;
        let qbaTlPageSize = 20;
        let qbaTlItems = [];
        let qbaTlTotal = 0;
        let qbaTlSearchTimer = null;
        let qbaTlLinkedScope = null; // { bank_type, year, season, subject, grade, tier, week }
        let qbaInitialized = false;
        let qbaEventsBound = false;

        const QBA_BANK_LABELS = {
            homework: '课后巩固',
            preview: '预习',
            variation: '课后举一反三'
        };

        const QBA_EVENT_META = {
            create: { label: '初次创建', cls: 'action', color: 'var(--success)' },
            update: { label: '更新保存', cls: 'action', color: 'var(--primary)' },
            tier_sync: { label: '班层同步', cls: 'action', color: 'var(--info)' },
            delete: { label: '教师删除', cls: 'error', color: 'var(--error)' },
            admin_edit: { label: '后台编辑', cls: 'warn', color: 'var(--warning)' },
            admin_delete: { label: '后台删除', cls: 'error', color: 'var(--error)' },
            admin_rollback: { label: '后台回滚', cls: 'warn', color: 'var(--warning)' },
            upload_pdf: { label: '上传切片', cls: 'info', color: 'var(--info)' },
            client_blocked: { label: '前端拦截', cls: 'warn', color: 'var(--warning)' },
            save_rejected: { label: '服务端驳回', cls: 'error', color: 'var(--error)' },
            save_cancelled: { label: '取消保存', cls: 'warn', color: 'var(--warning)' },
            save_error: { label: '保存异常', cls: 'error', color: 'var(--error)' }
        };

        function qbaBankLabel(bt) {
            return QBA_BANK_LABELS[bt] || bt || '-';
        }

        function qbaSeasonUnit(season) {
            return (season === '暑' || season === '寒' || season === 'summer' || season === 'winter') ? '讲' : '周';
        }

        function qbaCopyText(text, okMsg = '已复制到剪贴板') {
            const val = String(text ?? '');
            if (!val) return;
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(val).then(() => showToast(okMsg, 'success')).catch(() => qbaCopyFallback(val, okMsg));
            } else {
                qbaCopyFallback(val, okMsg);
            }
        }

        function qbaCopyFallback(val, okMsg) {
            try {
                const ta = document.createElement('textarea');
                ta.value = val;
                ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                showToast(okMsg, 'success');
            } catch (_) {
                showToast('复制失败，请手动复制', 'error');
            }
        }

        function bindQbankAuditEvents() {
            if (qbaEventsBound) return;
            qbaEventsBound = true;

            const tab = document.getElementById('qbank-audit-tab');
            if (tab) {
                tab.addEventListener('click', (e) => {
                    const copyBtn = e.target.closest('[data-qba-copy]');
                    if (copyBtn) {
                        e.stopPropagation();
                        qbaCopyText(copyBtn.getAttribute('data-qba-copy'), copyBtn.getAttribute('data-qba-copy-msg') || '已复制回执编号');
                        return;
                    }

                    const revBtn = e.target.closest('[data-qba-rev-idx]');
                    if (revBtn) {
                        e.stopPropagation();
                        const idx = parseInt(revBtn.getAttribute('data-qba-rev-idx'), 10);
                        const item = qbaMatrixItems[idx];
                        if (item) openQbankRevisionsModal(item);
                        return;
                    }

                    const tlRevBtn = e.target.closest('[data-qba-tl-rev-idx]');
                    if (tlRevBtn) {
                        e.stopPropagation();
                        const idx = parseInt(tlRevBtn.getAttribute('data-qba-tl-rev-idx'), 10);
                        const item = qbaTlItems[idx];
                        if (item) openQbankRevisionsModal(item);
                        return;
                    }

                    const jumpBtn = e.target.closest('[data-qba-jump-idx]');
                    if (jumpBtn) {
                        e.stopPropagation();
                        const idx = parseInt(jumpBtn.getAttribute('data-qba-jump-idx'), 10);
                        const item = qbaMatrixItems[idx];
                        if (item) jumpToTimelineFromMatrixItem(item);
                        return;
                    }

                    const pageBtn = e.target.closest('[data-qba-page]');
                    if (pageBtn && !pageBtn.disabled) {
                        const page = parseInt(pageBtn.getAttribute('data-qba-page'), 10);
                        if (page > 0) loadQbankTimeline(page);
                        return;
                    }

                    const toggleDetailBtn = e.target.closest('[data-qba-detail-toggle]');
                    if (toggleDetailBtn) {
                        e.stopPropagation();
                        const targetId = toggleDetailBtn.getAttribute('data-qba-detail-toggle');
                        const detailEl = targetId ? document.getElementById(targetId) : null;
                        if (detailEl) {
                            const willShow = detailEl.style.display === 'none';
                            detailEl.style.display = willShow ? 'block' : 'none';
                            toggleDetailBtn.textContent = willShow ? '收起详情' : '展开详情 / SHA-256';
                        }
                        return;
                    }

                    // Clicking anywhere on a matrix row (excluding links/buttons) links to timeline below
                    if (e.target.closest('a, button, input, select')) return;
                    const row = e.target.closest('tr[data-qba-matrix-row]');
                    if (row) {
                        const idx = parseInt(row.getAttribute('data-qba-matrix-row'), 10);
                        const item = qbaMatrixItems[idx];
                        if (item) jumpToTimelineFromMatrixItem(item);
                    }
                });
            }

            const revModal = document.getElementById('qba-revisions-modal');
            if (revModal) {
                revModal.addEventListener('click', (e) => {
                    const copyBtn = e.target.closest('[data-qba-copy]');
                    if (copyBtn) {
                        qbaCopyText(copyBtn.getAttribute('data-qba-copy'), '已复制回执编号');
                        return;
                    }
                    const rbBtn = e.target.closest('[data-qba-rollback-code]');
                    if (rbBtn) {
                        const code = rbBtn.getAttribute('data-qba-rollback-code');
                        const revNo = rbBtn.getAttribute('data-qba-rollback-rev') || '-';
                        confirmQbankRollback(code, revNo);
                    }
                });
            }
        }

        async function initQbankAuditTab() {
            bindQbankAuditEvents();
            applyQbankAuditViewMode();
            if (!qbaInitialized && typeof loadDbBatchOptions === 'function') {
                await loadDbBatchOptions();
            }
            populateQbankAuditSelects();
            qbaInitialized = true;
            await Promise.all([
                loadQbankMatrix(),
                loadQbankTimeline(1),
                loadQbankAnchors()
            ]);
        }

        async function loadQbankAnchors() {
            const summaryEl = document.getElementById('qba-anchor-summary');
            if (!summaryEl) return;
            try {
                const res = await fetch('api/admin.php?action=qbank_anchors&limit=5');
                const json = await res.json();
                if (!res.ok || !json.success) {
                    summaryEl.textContent = '锚定状态查询失败';
                    return;
                }
                const items = json.data?.items || [];
                if (items.length === 0) {
                    summaryEl.textContent = '尚未生成外部锚定批次（可点击右侧按钮立即封装 Merkle 并向 TSA 锚定）';
                    return;
                }
                const latest = items[0];
                const tsaBadge = latest.tsa_status === 'anchored' ? 'TSA 已锚定' : '仅本地 Merkle';
                summaryEl.innerHTML = `最新批次 <span class="cell-mono" style="font-weight:600;">${escapeHtml(latest.anchor_code)}</span> · 覆盖序号 <span class="cell-mono">#${escapeHtml(latest.seq_from)}~#${escapeHtml(latest.seq_to)}</span>（${escapeHtml(latest.revision_count)} 条） · <b>${escapeHtml(tsaBadge)}</b> · ${escapeHtml(latest.tsa_gen_time || latest.anchored_at || '-')}`;
            } catch (_e) {
                summaryEl.textContent = '锚定状态暂不可用';
            }
        }

        async function triggerQbankAnchorNow() {
            const btn = document.getElementById('qba-anchor-now-btn');
            if (btn) btn.disabled = true;
            try {
                const res = await fetch('api/admin.php?action=qbank_anchor_now', { method: 'POST' });
                const json = await res.json();
                if (!res.ok || !json.success) {
                    if (typeof showToast === 'function') showToast(json.message || '执行锚定失败', 'error');
                    return;
                }
                if (json.data?.anchored) {
                    const anc = json.data.anchor;
                    if (typeof showToast === 'function') showToast(`已完成锚定 ${anc.anchor_code}（${anc.tsa_status === 'anchored' ? 'TSA 已签发' : '本地 Merkle'}）`, 'success');
                } else {
                    if (typeof showToast === 'function') showToast(json.data?.message || '暂无新增未锚定记录', 'info');
                }
                await loadQbankAnchors();
            } catch (err) {
                if (typeof showToast === 'function') showToast(err?.message || '锚定请求异常', 'error');
            } finally {
                if (btn) btn.disabled = false;
            }
        }

        let qbaRevModalScope = null;

        async function confirmQbankRollback(receiptCode, revNo) {
            if (!receiptCode) return;
            const msg = `确定要将该题库专题一键回滚到历史版本 v${revNo}（回执 ${receiptCode}）吗？\n\n系统将在单个事务内恢复题目与 PDF 配置，并自动签发一条新的“后台回滚”存证回执，不会篡改任何历史存证记录。`;
            let confirmed = false;
            if (window.DialogHelper && typeof window.DialogHelper.confirm === 'function') {
                confirmed = await window.DialogHelper.confirm({ title: '确认回滚历史题库快照', message: msg, danger: true });
            } else {
                confirmed = window.confirm(msg);
            }
            if (!confirmed) return;

            try {
                const res = await fetch('api/admin.php?action=qbank_rollback', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ receipt_code: receiptCode })
                });
                const json = await res.json();
                if (!res.ok || !json.success) {
                    if (typeof showToast === 'function') showToast(json.message || '回滚失败', 'error');
                    return;
                }
                const d = json.data || {};
                if (typeof showToast === 'function') {
                    showToast(`已回滚至 v${d.target_revision_no}（恢复 ${d.restored_count ?? 0} 题），新存证回执：${d.new_receipt_code || '-'}`, 'success');
                }
                await Promise.all([
                    loadQbankMatrix(),
                    loadQbankTimeline(1),
                    qbaRevModalScope ? openQbankRevisionsModal(qbaRevModalScope) : Promise.resolve()
                ]);
            } catch (err) {
                if (typeof showToast === 'function') showToast(err?.message || '回滚请求失败', 'error');
            }
        }

        function populateQbankAuditSelects() {
            const curYear = String((typeof currentConfig !== 'undefined' && currentConfig?.semesterYear) || new Date().getFullYear());
            const yearSet = new Set(['2027', '2026', '2025', '2024', curYear]);
            const years = [...yearSet].filter(Boolean).sort((a, b) => Number(b) - Number(a));

            const defaultSubjects = ['数学', '英语', '物理', '化学', '语文', '生物'];
            const dimSubjects = (typeof dbFilterOptions !== 'undefined' && Array.isArray(dbFilterOptions.subjects)) ? dbFilterOptions.subjects : [];
            const subjects = [...new Set([...defaultSubjects, ...dimSubjects])].filter(Boolean);

            const defaultGrades = ['七年级先学', '七年级', '八年级', '九年级', '高一先学', '高一', '高二', '高三'];
            const dimGrades = (typeof dbFilterOptions !== 'undefined' && Array.isArray(dbFilterOptions.grades)) ? dbFilterOptions.grades : [];
            const grades = [...new Set([...defaultGrades, ...dimGrades])].filter(Boolean);

            const defaultTiers = ['U', 'S+', 'S', 'A+', 'A'];
            const dimTiers = (typeof dbFilterOptions !== 'undefined' && Array.isArray(dbFilterOptions.tiers)) ? dbFilterOptions.tiers : [];
            const tiers = [...new Set([...defaultTiers, ...dimTiers])].filter(Boolean);

            const teachers = (typeof dbFilterOptions !== 'undefined' && Array.isArray(dbFilterOptions.teachers)) ? dbFilterOptions.teachers : [];

            const fillSelect = (id, allLabel, items, formatLabel) => {
                const el = document.getElementById(id);
                if (!el) return;
                const prev = el.value;
                el.innerHTML = `<option value="">${escapeHtml(allLabel)}</option>` + items.map((v) => {
                    const val = typeof v === 'object' ? v.value : v;
                    const label = typeof v === 'object' ? v.label : (formatLabel ? formatLabel(v) : v);
                    return `<option value="${escapeHtml(val)}">${escapeHtml(label)}</option>`;
                }).join('');
                if (prev && items.some((v) => (typeof v === 'object' ? v.value : v) === prev)) {
                    el.value = prev;
                }
            };

            fillSelect('qba-mat-year', '全部学年', years, (y) => `${y} 年`);
            fillSelect('qba-tl-year', '全部学年', years, (y) => `${y} 年`);
            fillSelect('qba-mat-subject', '全部学科', subjects);
            fillSelect('qba-tl-subject', '全部学科', subjects);
            fillSelect('qba-mat-grade', '全部年级', grades);
            fillSelect('qba-tl-grade', '全部年级', grades);
            fillSelect('qba-tl-tier', '全部班层', tiers, (t) => `${t}层`);

            const weekOpts = [];
            for (let w = 1; w <= 20; w++) {
                weekOpts.push({ value: String(w), label: `第 ${w} 周/讲` });
            }
            fillSelect('qba-tl-week', '全部周次', weekOpts);

            const teacherOpts = teachers.map((t) => ({
                value: t.username,
                label: t.real_name ? `${t.real_name} (${t.username})` : t.username
            }));
            fillSelect('qba-tl-teacher-select', '全部教师', teacherOpts);
        }

        function syncQbaSelectOptionsFromMatrix(items) {
            if (!Array.isArray(items) || items.length === 0) return;
            const appendUnique = (selectId, values, formatLabel) => {
                const el = document.getElementById(selectId);
                if (!el) return;
                const existing = new Set(Array.from(el.options).map((o) => o.value));
                values.forEach((raw) => {
                    const v = raw !== undefined && raw !== null ? String(raw).trim() : '';
                    if (!v || existing.has(v)) return;
                    existing.add(v);
                    const opt = document.createElement('option');
                    opt.value = v;
                    opt.textContent = formatLabel ? formatLabel(v) : v;
                    el.appendChild(opt);
                });
            };
            const years = [...new Set(items.map((i) => i.year).filter(Boolean))];
            const subjects = [...new Set(items.map((i) => i.subject).filter(Boolean))];
            const grades = [...new Set(items.map((i) => i.grade).filter(Boolean))];
            const tiers = [...new Set(items.map((i) => i.tier).filter(Boolean))];

            appendUnique('qba-mat-year', years, (y) => `${y} 年`);
            appendUnique('qba-tl-year', years, (y) => `${y} 年`);
            appendUnique('qba-mat-subject', subjects);
            appendUnique('qba-tl-subject', subjects);
            appendUnique('qba-mat-grade', grades);
            appendUnique('qba-tl-grade', grades);
            appendUnique('qba-tl-tier', tiers, (t) => `${t}层`);
        }

        function switchQbankAuditView(mode) {
            qbaViewMode = ['both', 'matrix', 'timeline'].includes(mode) ? mode : 'both';
            applyQbankAuditViewMode();
        }

        function applyQbankAuditViewMode() {
            const matSec = document.getElementById('qba-matrix-section');
            const tlSec = document.getElementById('qba-timeline-section');
            const matWrap = document.getElementById('qba-matrix-table-wrapper');
            const btnBoth = document.getElementById('qba-view-btn-both');
            const btnMat = document.getElementById('qba-view-btn-matrix');
            const btnTl = document.getElementById('qba-view-btn-timeline');

            if (matSec) matSec.style.display = (qbaViewMode === 'timeline') ? 'none' : 'block';
            if (tlSec) tlSec.style.display = (qbaViewMode === 'matrix') ? 'none' : 'block';
            if (matWrap) {
                matWrap.style.maxHeight = (qbaViewMode === 'both') ? '420px' : 'none';
            }

            if (btnBoth) btnBoth.className = qbaViewMode === 'both' ? 'btn primary' : 'btn secondary';
            if (btnMat) btnMat.className = qbaViewMode === 'matrix' ? 'btn primary' : 'btn secondary';
            if (btnTl) btnTl.className = qbaViewMode === 'timeline' ? 'btn primary' : 'btn secondary';
        }

        /* ========================================================
           1. Matrix Overview (qbank_matrix)
           ======================================================== */
        function debounceQbaMatrixSearch() {
            clearTimeout(qbaMatrixSearchTimer);
            qbaMatrixSearchTimer = setTimeout(() => {
                renderQbankMatrixTable();
            }, 220);
        }

        function resetQbankMatrixFilters() {
            ['qba-mat-year', 'qba-mat-season', 'qba-mat-bank-type', 'qba-mat-subject', 'qba-mat-grade', 'qba-mat-search'].forEach((id) => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
            loadQbankMatrix();
        }

        function updateQbankMatrixResetBtn() {
            const hasFilter = Boolean(
                document.getElementById('qba-mat-year')?.value ||
                document.getElementById('qba-mat-season')?.value ||
                document.getElementById('qba-mat-bank-type')?.value ||
                document.getElementById('qba-mat-subject')?.value ||
                document.getElementById('qba-mat-grade')?.value ||
                document.getElementById('qba-mat-search')?.value.trim()
            );
            const btn = document.getElementById('qba-mat-reset-btn');
            if (btn) btn.style.display = hasFilter ? 'inline-flex' : 'none';
        }

        async function loadQbankMatrix() {
            const tbody = document.getElementById('qba-matrix-tbody');
            updateQbankMatrixResetBtn();
            if (tbody) {
                tbody.innerHTML = '<tr><td colspan="9" class="table-empty"><div class="empty-state"><span>正在加载配置回执总览...</span></div></td></tr>';
            }

            const params = new URLSearchParams({ action: 'qbank_matrix' });
            const year = document.getElementById('qba-mat-year')?.value || '';
            const season = document.getElementById('qba-mat-season')?.value || '';
            const bankType = document.getElementById('qba-mat-bank-type')?.value || '';
            const subject = document.getElementById('qba-mat-subject')?.value || '';
            const grade = document.getElementById('qba-mat-grade')?.value || '';

            params.append('year', year);
            params.append('season', season);
            params.append('bank_type', bankType);
            params.append('subject', subject);
            params.append('grade', grade);

            try {
                const res = await fetch(`${API_BASE}?${params.toString()}`);
                const json = await res.json();
                if (!json.success) {
                    throw new Error(json.error || '加载配置回执总览失败');
                }
                const items = Array.isArray(json.data?.items)
                    ? json.data.items
                    : (Array.isArray(json.data) ? json.data : []);
                qbaMatrixItems = items;
                syncQbaSelectOptionsFromMatrix(items);

                const navBadge = document.getElementById('nav-qbank-audit-badge');
                const matBadge = document.getElementById('qba-matrix-count-badge');
                if (navBadge) navBadge.textContent = `${items.length} 项`;
                if (matBadge) matBadge.textContent = String(items.length);

                renderQbankMatrixTable();
            } catch (err) {
                if (tbody) {
                    tbody.innerHTML = `<tr><td colspan="9" class="table-empty"><div class="empty-state"><span style="color:var(--error);">${escapeHtml(err?.message || '网络请求失败')}</span></div></td></tr>`;
                }
            }
        }

        function renderQbankMatrixTable() {
            const tbody = document.getElementById('qba-matrix-tbody');
            const summaryEl = document.getElementById('qba-matrix-summary');
            if (!tbody) return;
            updateQbankMatrixResetBtn();

            const kw = (document.getElementById('qba-mat-search')?.value || '').trim().toLowerCase();
            const indexed = qbaMatrixItems.map((item, idx) => ({ item, idx })).filter(({ item }) => {
                if (!kw) return true;
                const hay = [
                    item.latest_receipt_code,
                    item.bank_type,
                    qbaBankLabel(item.bank_type),
                    item.year,
                    item.season,
                    item.subject,
                    item.grade,
                    item.tier,
                    item.week ? `第${item.week}` : '',
                    item.updated_by,
                    item.updated_by_name,
                    item.last_action
                ].join(' ').toLowerCase();
                return hay.includes(kw);
            });

            if (summaryEl) {
                summaryEl.textContent = kw
                    ? `筛选命中 ${indexed.length} / ${qbaMatrixItems.length} 个已配置专题`
                    : `共 ${qbaMatrixItems.length} 个已配置专题（点击行可联动查看下方时间线）`;
            }

            if (indexed.length === 0) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="9" class="table-empty">
                            <div class="empty-state">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                                </svg>
                                <span>暂无匹配的题库配置存证记录</span>
                            </div>
                        </td>
                    </tr>
                `;
                return;
            }

            tbody.innerHTML = indexed.map(({ item, idx }) => {
                const unit = qbaSeasonUnit(item.season);
                const code = item.latest_receipt_code || '';
                const evMeta = QBA_EVENT_META[item.last_action] || { label: item.last_action || '-', cls: 'info' };
                const revNo = item.latest_revision_no ? `v${item.latest_revision_no}` : '-';
                const updater = item.updated_by_name
                    ? `${item.updated_by_name} (${item.updated_by || '-'})`
                    : (item.updated_by || '-');

                return `
                    <tr data-qba-matrix-row="${idx}" style="cursor:pointer;" title="点击联动筛选下方操作复盘时间线">
                        <td style="white-space:nowrap;">
                            <div style="font-weight:600; color:var(--text-primary);">${escapeHtml(item.year || '-')} 年 · ${escapeHtml(item.season || '-')}</div>
                            <div style="font-size:0.75rem; color:var(--text-muted);">${escapeHtml(qbaBankLabel(item.bank_type))}</div>
                        </td>
                        <td style="white-space:nowrap;">
                            <div style="font-weight:600; color:var(--text-primary);">${escapeHtml(item.subject || '-')} · ${escapeHtml(item.grade || '-')}</div>
                            <div style="font-size:0.75rem; color:var(--text-secondary);">${escapeHtml(item.tier || '-')}层 · 第 ${escapeHtml(item.week ?? '-')} ${unit}</div>
                        </td>
                        <td style="white-space:nowrap;">
                            ${code ? `
                                <div style="display:inline-flex; align-items:center; gap:6px;">
                                    <button type="button" class="token-pill" data-qba-copy="${escapeHtml(code)}" title="点击复制回执编号">${escapeHtml(code)}</button>
                                    <a href="verify-qbank.html?code=${encodeURIComponent(code)}" target="_blank" rel="noopener noreferrer" class="btn-action detail" title="在新窗口打开公开核验页">核验 ↗</a>
                                </div>
                            ` : '<span style="color:var(--text-muted); font-size:0.78rem;">历史未存证</span>'}
                        </td>
                        <td style="white-space:nowrap;">
                            <span class="action-tag ${evMeta.cls}">${escapeHtml(revNo)} · ${escapeHtml(evMeta.label)}</span>
                        </td>
                        <td class="cell-mono" style="text-align:center; font-weight:600; color:var(--text-primary);">${escapeHtml(item.question_count ?? 0)}</td>
                        <td class="cell-mono" style="text-align:center; white-space:nowrap;">
                            <span style="color:var(--primary); font-weight:600;">${escapeHtml(item.revision_count ?? 0)}</span> 版 /
                            <span style="color:var(--text-secondary);">${escapeHtml(item.attempt_count ?? 0)}</span> 次
                        </td>
                        <td style="white-space:nowrap; font-size:0.82rem; color:var(--text-primary);">${escapeHtml(updater)}</td>
                        <td class="cell-mono" style="white-space:nowrap; font-size:0.8rem; color:var(--text-secondary);">${formatTimestamp(item.updated_at)}</td>
                        <td style="text-align:right; white-space:nowrap;">
                            <button type="button" class="btn-action edit" data-qba-rev-idx="${idx}" title="查看该专题历史版本链">历史</button>
                            <button type="button" class="btn-action detail" data-qba-jump-idx="${idx}" title="在下方时间线中筛选此专题">时间线</button>
                        </td>
                    </tr>
                `;
            }).join('');
        }

        /* ========================================================
           2. Matrix -> Timeline Link
           ======================================================== */
        function jumpToTimelineFromMatrixItem(item) {
            if (!item) return;
            qbaTlLinkedScope = {
                bank_type: item.bank_type || '',
                year: item.year || '',
                season: item.season || '',
                subject: item.subject || '',
                grade: item.grade || '',
                tier: item.tier || '',
                week: item.week || ''
            };

            const setVal = (id, val) => {
                const el = document.getElementById(id);
                if (!el) return;
                const s = val !== undefined && val !== null ? String(val) : '';
                if (s && el.tagName === 'SELECT' && !Array.from(el.options).some((o) => o.value === s)) {
                    const opt = document.createElement('option');
                    opt.value = s;
                    opt.textContent = s;
                    el.appendChild(opt);
                }
                el.value = s;
            };

            setVal('qba-tl-year', item.year);
            setVal('qba-tl-season', item.season);
            setVal('qba-tl-bank-type', item.bank_type);
            setVal('qba-tl-subject', item.subject);
            setVal('qba-tl-grade', item.grade);
            setVal('qba-tl-tier', item.tier);
            setVal('qba-tl-week', item.week);

            renderQbankLinkedScopeBanner();

            if (qbaViewMode === 'matrix') {
                switchQbankAuditView('both');
            }
            loadQbankTimeline(1);

            const tlSection = document.getElementById('qba-timeline-section');
            if (tlSection && typeof tlSection.scrollIntoView === 'function') {
                tlSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
            const unit = qbaSeasonUnit(item.season);
            showToast(`已联动筛选时间线：${item.subject} · ${item.grade} · ${item.tier}层 · 第${item.week}${unit}`, 'info', 2200);
        }

        function clearQbankLinkedScope() {
            qbaTlLinkedScope = null;
            ['qba-tl-year', 'qba-tl-season', 'qba-tl-bank-type', 'qba-tl-subject', 'qba-tl-grade', 'qba-tl-tier', 'qba-tl-week'].forEach((id) => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
            renderQbankLinkedScopeBanner();
            loadQbankTimeline(1);
        }

        function renderQbankLinkedScopeBanner() {
            const bar = document.getElementById('qba-linked-scope-bar');
            const textEl = document.getElementById('qba-linked-scope-text');
            if (!bar || !textEl) return;
            if (!qbaTlLinkedScope) {
                bar.style.display = 'none';
                return;
            }
            const s = qbaTlLinkedScope;
            const unit = qbaSeasonUnit(s.season);
            textEl.textContent = `${s.year || '-'}年${s.season || '-'} · ${qbaBankLabel(s.bank_type)} · ${s.subject || '-'} · ${s.grade || '-'} · ${s.tier || '-'}层 · 第${s.week ?? '-'}${unit}`;
            bar.style.display = 'flex';
        }

        /* ========================================================
           3. Revisions History Modal (qbank_revisions)
           ======================================================== */
        async function openQbankRevisionsModal(scope) {
            qbaRevModalScope = scope;
            const modal = document.getElementById('qba-revisions-modal');
            const titleEl = document.getElementById('qba-rev-modal-title');
            const bodyEl = document.getElementById('qba-rev-modal-body');
            if (!modal || !bodyEl) return;

            const unit = qbaSeasonUnit(scope.season);
            if (titleEl) {
                titleEl.textContent = `历史存证版本链：${scope.year || '-'}年${scope.season || '-'} · ${qbaBankLabel(scope.bank_type)} · ${scope.subject || '-'} · ${scope.grade || '-'} · ${scope.tier || '-'}层 · 第${scope.week ?? '-'}${unit}`;
            }
            bodyEl.innerHTML = '<div style="padding:28px; text-align:center; color:var(--text-muted);">正在加载历史存证版本...</div>';

            if (window.DialogHelper) {
                window.DialogHelper.open(modal, { dismissible: true });
            } else {
                modal.style.display = 'flex';
            }

            const params = new URLSearchParams({ action: 'qbank_revisions' });
            if (scope.year) params.append('year', scope.year);
            if (scope.season) params.append('season', scope.season);
            if (scope.bank_type) params.append('bank_type', scope.bank_type);
            if (scope.subject) params.append('subject', scope.subject);
            if (scope.grade) params.append('grade', scope.grade);
            if (scope.tier) params.append('tier', scope.tier);
            if (scope.week) params.append('week', scope.week);

            try {
                const res = await fetch(`${API_BASE}?${params.toString()}`);
                const json = await res.json();
                if (!json.success) {
                    throw new Error(json.error || '加载历史版本失败');
                }
                const list = Array.isArray(json.data)
                    ? json.data
                    : (Array.isArray(json.data?.items) ? json.data.items : (Array.isArray(json.data?.revisions) ? json.data.revisions : []));

                if (list.length === 0) {
                    bodyEl.innerHTML = '<div class="empty-state" style="padding:36px 16px;"><span>该专题暂无存证版本记录</span></div>';
                    return;
                }

                bodyEl.innerHTML = `
                    <div class="table-wrapper" style="border:1px solid var(--border-color); border-radius:var(--radius-md);">
                        <table class="data-table">
                            <thead>
                                <tr>
                                    <th>版本</th>
                                    <th>动作</th>
                                    <th>回执编号</th>
                                    <th style="text-align:center;">题数</th>
                                    <th>操作教师</th>
                                    <th>签发时间</th>
                                    <th>内容指纹</th>
                                    <th style="text-align:right;">核验</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${list.map((rev) => {
                                    const code = rev.receipt_code || '';
                                    const actMeta = QBA_EVENT_META[rev.action] || { label: rev.action || '-', cls: 'info' };
                                    const op = rev.operator_name ? `${rev.operator_name} (${rev.operator || '-'})` : (rev.operator || '-');
                                    const shaShort = rev.content_sha256 ? `${String(rev.content_sha256).slice(0, 12)}...` : '-';
                                    return `
                                        <tr>
                                            <td class="cell-mono" style="font-weight:600;">v${escapeHtml(rev.revision_no ?? '-')}</td>
                                            <td><span class="action-tag ${actMeta.cls}">${escapeHtml(actMeta.label)}</span></td>
                                            <td>
                                                ${code ? `<button type="button" class="token-pill" data-qba-copy="${escapeHtml(code)}" title="复制回执号">${escapeHtml(code)}</button>` : '-'}
                                            </td>
                                            <td class="cell-mono" style="text-align:center;">${escapeHtml(rev.question_count ?? '-')}</td>
                                            <td style="white-space:nowrap;">${escapeHtml(op)}</td>
                                            <td class="cell-mono" style="white-space:nowrap; font-size:0.78rem;">${escapeHtml(rev.issued_at_cst || formatTimestamp(rev.created_at))}</td>
                                            <td class="cell-mono" style="font-size:0.76rem;" title="${escapeHtml(rev.content_sha256 || '')}">${escapeHtml(shaShort)}</td>
                                            <td style="text-align:right; white-space:nowrap;">
                                                ${code ? `
                                                    <div style="display:inline-flex; gap:6px; align-items:center;">
                                                        <button type="button" class="btn-action edit" data-qba-rollback-code="${escapeHtml(code)}" data-qba-rollback-rev="${escapeHtml(rev.revision_no ?? '-')}">回滚到此版本</button>
                                                        <a href="verify-qbank.html?code=${encodeURIComponent(code)}" target="_blank" rel="noopener noreferrer" class="btn-action detail">核验 ↗</a>
                                                    </div>
                                                ` : '-'}
                                            </td>
                                        </tr>
                                    `;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                `;
            } catch (err) {
                bodyEl.innerHTML = `<div style="padding:24px; text-align:center; color:var(--error);">${escapeHtml(err?.message || '网络请求失败')}</div>`;
            }
        }

        function closeQbankRevisionsModal() {
            const modal = document.getElementById('qba-revisions-modal');
            if (!modal) return;
            if (window.DialogHelper) {
                window.DialogHelper.close(modal);
            } else {
                modal.style.display = 'none';
            }
        }

        /* ========================================================
           4. Teacher Operation Timeline (qbank_timeline)
           ======================================================== */
        function onQbaTeacherSelectChange(val) {
            const input = document.getElementById('qba-tl-operator');
            if (input) input.value = val || '';
            loadQbankTimeline(1);
        }

        function debounceQbaTimelineSearch() {
            clearTimeout(qbaTlSearchTimer);
            qbaTlSearchTimer = setTimeout(() => {
                const selectEl = document.getElementById('qba-tl-teacher-select');
                const inputVal = (document.getElementById('qba-tl-operator')?.value || '').trim();
                if (selectEl) {
                    const matched = Array.from(selectEl.options).some((o) => o.value === inputVal);
                    selectEl.value = matched ? inputVal : '';
                }
                loadQbankTimeline(1);
            }, 280);
        }

        function changeQbaTimelinePageSize(val) {
            qbaTlPageSize = parseInt(val, 10) || 20;
            loadQbankTimeline(1);
        }

        function resetQbankTimelineFilters() {
            qbaTlLinkedScope = null;
            [
                'qba-tl-teacher-select', 'qba-tl-operator', 'qba-tl-event-type',
                'qba-tl-year', 'qba-tl-season', 'qba-tl-bank-type',
                'qba-tl-subject', 'qba-tl-grade', 'qba-tl-tier', 'qba-tl-week',
                'qba-tl-date-from', 'qba-tl-date-to'
            ].forEach((id) => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
            renderQbankLinkedScopeBanner();
            loadQbankTimeline(1);
        }

        async function loadQbankTimeline(page = 1) {
            qbaTlPage = page;
            const listEl = document.getElementById('qba-timeline-list');
            if (listEl) {
                listEl.innerHTML = '<div style="padding:36px; text-align:center; color:var(--text-muted);">正在加载教师操作复盘时间线...</div>';
            }

            const params = new URLSearchParams({
                action: 'qbank_timeline',
                page: String(qbaTlPage),
                page_size: String(qbaTlPageSize)
            });

            const operator = (document.getElementById('qba-tl-operator')?.value || '').trim()
                || (document.getElementById('qba-tl-teacher-select')?.value || '').trim();
            const eventType = document.getElementById('qba-tl-event-type')?.value || '';
            const year = document.getElementById('qba-tl-year')?.value || '';
            const season = document.getElementById('qba-tl-season')?.value || '';
            const bankType = document.getElementById('qba-tl-bank-type')?.value || '';
            const subject = document.getElementById('qba-tl-subject')?.value || '';
            const grade = document.getElementById('qba-tl-grade')?.value || '';
            const tier = document.getElementById('qba-tl-tier')?.value || '';
            const week = document.getElementById('qba-tl-week')?.value || '';
            const dateFrom = document.getElementById('qba-tl-date-from')?.value || '';
            const dateTo = document.getElementById('qba-tl-date-to')?.value || '';

            params.append('operator', operator);
            params.append('event_type', eventType);
            params.append('year', year);
            params.append('season', season);
            if (bankType) params.append('bank_type', bankType);
            params.append('subject', subject);
            params.append('grade', grade);
            params.append('tier', tier);
            params.append('week', week);
            params.append('date_from', dateFrom);
            params.append('date_to', dateTo);

            try {
                const res = await fetch(`${API_BASE}?${params.toString()}`);
                const json = await res.json();
                if (!json.success || !json.data) {
                    throw new Error(json.error || '加载操作复盘时间线失败');
                }
                const d = json.data;
                qbaTlItems = Array.isArray(d.items) ? d.items : [];
                qbaTlTotal = Number(d.total ?? qbaTlItems.length);
                const actualPage = Number(d.page || qbaTlPage);
                const actualSize = Number(d.page_size || qbaTlPageSize);

                renderQbankTimelineStats(d.stats || {});
                renderQbankTimelineItems(qbaTlItems);
                renderQbankTimelinePagination(actualPage, actualSize, qbaTlTotal);

                const tlBadge = document.getElementById('qba-timeline-count-badge');
                if (tlBadge) tlBadge.textContent = String(qbaTlTotal);
            } catch (err) {
                if (listEl) {
                    listEl.innerHTML = `<div style="padding:36px; text-align:center; color:var(--error);">${escapeHtml(err?.message || '网络请求失败')}</div>`;
                }
                const pag = document.getElementById('qba-timeline-pagination');
                if (pag) pag.innerHTML = '';
            }
        }

        function renderQbankTimelineStats(stats) {
            const setNum = (id, val) => {
                const el = document.getElementById(id);
                if (el) el.textContent = String(val ?? 0);
            };
            setNum('qba-stat-revisions', stats.revisions ?? 0);
            setNum('qba-stat-uploads', stats.uploads ?? 0);
            setNum('qba-stat-blocked', stats.blocked_or_failed ?? 0);
            setNum('qba-stat-cancelled', stats.cancelled ?? 0);
        }

        function renderQbankTimelineItems(items) {
            const listEl = document.getElementById('qba-timeline-list');
            if (!listEl) return;

            if (!items || items.length === 0) {
                listEl.innerHTML = `
                    <div class="empty-state" style="padding:48px 16px;">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <circle cx="12" cy="12" r="10"></circle>
                            <polyline points="12 6 12 12 16 14"></polyline>
                        </svg>
                        <span>未检索到匹配的教师操作复盘记录</span>
                    </div>
                `;
                return;
            }

            listEl.innerHTML = items.map((item, idx) => {
                const isRevision = item.source === 'revision';
                const evKey = item.event_type || (isRevision ? 'update' : 'upload_pdf');
                const evMeta = QBA_EVENT_META[evKey] || { label: evKey, cls: 'info', color: 'var(--primary)' };
                const unit = qbaSeasonUnit(item.season);
                const scopeParts = [
                    item.year ? `${item.year}年${item.season || ''}` : '',
                    item.bank_type ? qbaBankLabel(item.bank_type) : '',
                    item.subject || '',
                    item.grade || '',
                    item.tier ? `${item.tier}层` : '',
                    item.week ? `第${item.week}${unit}` : ''
                ].filter(Boolean);

                const opText = item.operator_name
                    ? `${item.operator_name} (${item.operator || '-'})`
                    : (item.operator || '未知账号');

                const detailObj = {};
                if (item.file_name) detailObj.file_name = item.file_name;
                if (item.file_sha256) detailObj.file_sha256 = item.file_sha256;
                if (item.reason) detailObj.reason = item.reason;
                if (item.client_ip) detailObj.client_ip = item.client_ip;
                if (item.details !== undefined && item.details !== null && item.details !== '') {
                    detailObj.details = item.details;
                }
                const hasDetails = Object.keys(detailObj).length > 0;
                const detailBoxId = `qba-tl-detail-${idx}`;
                const formattedDetails = hasDetails ? JSON.stringify(detailObj, null, 2) : '';

                return `
                    <div style="padding:14px 16px; border-bottom:1px solid var(--border-color); display:flex; gap:14px; align-items:flex-start;">
                        <div style="width:10px; height:10px; border-radius:50%; margin-top:6px; flex-shrink:0; background:${evMeta.color};"></div>
                        <div style="flex:1; min-width:0; display:flex; flex-direction:column; gap:6px;">
                            <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px;">
                                <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                                    <span class="action-tag ${evMeta.cls}" style="font-weight:600;">${escapeHtml(evMeta.label)}</span>
                                    <span style="font-size:0.74rem; padding:2px 7px; border-radius:4px; background:var(--bg-subtle); border:1px solid var(--border-color); color:var(--text-secondary); font-family:var(--font-mono);">
                                        ${isRevision ? `存证台账 · v${escapeHtml(item.revision_no ?? '-')}` : `过程日志 · ${escapeHtml(item.event_type || '-')}`}
                                    </span>
                                    ${item.receipt_code ? `
                                        <button type="button" class="token-pill" data-qba-copy="${escapeHtml(item.receipt_code)}" title="点击复制回执编号">${escapeHtml(item.receipt_code)}</button>
                                        <a href="verify-qbank.html?code=${encodeURIComponent(item.receipt_code)}" target="_blank" rel="noopener noreferrer" class="btn-action detail">核验 ↗</a>
                                    ` : ''}
                                    ${isRevision ? `<button type="button" class="btn-action edit" data-qba-tl-rev-idx="${idx}">历史版本</button>` : ''}
                                </div>
                                <span class="cell-mono" style="font-size:0.78rem; color:var(--text-muted);">${escapeHtml(formatTimestamp(item.created_at))}</span>
                            </div>

                            <div style="display:flex; align-items:center; flex-wrap:wrap; gap:10px; font-size:0.84rem; color:var(--text-primary);">
                                <span style="font-weight:600;">${escapeHtml(scopeParts.join(' · ') || '未指定教学专题')}</span>
                                ${isRevision && item.question_count !== undefined && item.question_count !== null ? `<span style="color:var(--text-secondary);">· ${escapeHtml(item.question_count)} 题</span>` : ''}
                                <span style="color:var(--text-muted);">|</span>
                                <span>操作人：<b style="color:var(--text-primary);">${escapeHtml(opText)}</b></span>
                                ${item.client_ip ? `<span class="cell-mono" style="font-size:0.76rem; color:var(--text-muted);">IP: ${escapeHtml(item.client_ip)}</span>` : ''}
                            </div>

                            ${item.reason ? `
                                <div style="font-size:0.82rem; color:var(--text-secondary); background:var(--bg-subtle); padding:6px 10px; border-radius:var(--radius-sm); border-left:3px solid ${evMeta.color};">
                                    原因 / 说明：${escapeHtml(item.reason)}
                                </div>
                            ` : ''}

                            ${(item.file_name || item.file_sha256) ? `
                                <div style="display:flex; align-items:center; flex-wrap:wrap; gap:8px; font-size:0.78rem; color:var(--text-secondary);">
                                    ${item.file_name ? `<span>文件：<b>${escapeHtml(item.file_name)}</b></span>` : ''}
                                    ${item.file_sha256 ? `<span class="cell-mono" style="background:var(--bg-subtle); padding:2px 6px; border-radius:4px; border:1px solid var(--border-color);" title="${escapeHtml(item.file_sha256)}">SHA-256: ${escapeHtml(String(item.file_sha256).slice(0, 16))}...</span>` : ''}
                                </div>
                            ` : ''}

                            ${hasDetails ? `
                                <div>
                                    <button type="button" class="btn-action" data-qba-detail-toggle="${detailBoxId}">展开详情 / SHA-256</button>
                                    <div id="${detailBoxId}" style="display:none; margin-top:8px;">
                                        <div style="display:flex; justify-content:flex-end; margin-bottom:4px;">
                                            <button type="button" class="btn-action" data-qba-copy="${escapeHtml(formattedDetails)}" data-qba-copy-msg="已复制详情 JSON">复制详情 JSON</button>
                                        </div>
                                        <pre class="cell-mono" style="margin:0; padding:10px 12px; border-radius:var(--radius-sm); background:var(--bg-subtle); border:1px solid var(--border-color); font-size:0.76rem; line-height:1.45; white-space:pre-wrap; word-break:break-all; max-height:240px; overflow:auto; color:var(--text-primary);">${escapeHtml(formattedDetails)}</pre>
                                    </div>
                                </div>
                            ` : ''}
                        </div>
                    </div>
                `;
            }).join('');
        }

        function renderQbankTimelinePagination(page, pageSize, total) {
            const container = document.getElementById('qba-timeline-pagination');
            if (!container) return;
            const totalPages = Math.max(1, Math.ceil((total || 0) / Math.max(1, pageSize)));
            if (total <= 0) {
                container.innerHTML = '';
                return;
            }
            container.innerHTML = `
                <div style="font-size:0.86rem; color:var(--text-secondary);">
                    共 <b style="color: var(--text-primary);">${total}</b> 条操作事件 · 第 <b style="color:var(--primary);">${page}</b> / ${totalPages} 页
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    <button type="button" class="page-btn" ${page > 1 ? `data-qba-page="${page - 1}"` : 'disabled'}>上一页</button>
                    <span style="font-size:0.86rem; font-weight:600; color: var(--text-primary); padding:0 6px;">${page}</span>
                    <button type="button" class="page-btn" ${page < totalPages ? `data-qba-page="${page + 1}"` : 'disabled'}>下一页</button>
                </div>
            `;
        }


/* ============================================================================
 * [MODULE] main.js - 路由调度、事件监听与系统启动 (Bootstrap)
 * ============================================================================ */


/**
 * Admin 主入口与路由控制器 (Tab Switching, Metas, Bootstrap)
 */

        /* ========================================================
           Navigation & Tab Switching
           ======================================================== */
        const TAB_METAS = {
            config: {
                title: '系统配置',
                breadcrumb: '系统配置'
            },
            records: {
                title: '学生学情错题',
                breadcrumb: '学生学情错题'
            },
            teachers: {
                title: '教师账号管理',
                breadcrumb: '教师账号管理'
            },
            batches: {
                title: '生成批次记录',
                breadcrumb: '生成批次记录'
            },
            'qbank-audit': {
                title: '题库存证',
                breadcrumb: '题库存证'
            },
            logs: {
                title: '操作日志',
                breadcrumb: '操作日志'
            },
            database: {
                title: '数据库管理',
                breadcrumb: '数据库管理'
            },
            changelog: {
                title: '更新日志',
                breadcrumb: '更新日志'
            }
        };

        let activeTab = 'records';
        window.activeTab = 'records';

        function switchTab(tab) {
            activeTab = tab;
            window.activeTab = tab;
            document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

            const targetNav = document.querySelector(`.nav-item[data-tab="${tab}"]`);
            if (targetNav) targetNav.classList.add('active');

            const targetTabContent = document.getElementById(`${tab}-tab`);
            if (targetTabContent) targetTabContent.classList.add('active');

            const meta = TAB_METAS[tab] || { title: tab, breadcrumb: tab };
            const pageTitle = document.getElementById('page-title');
            if (pageTitle) pageTitle.textContent = meta.title;
            const pageDesc = document.getElementById('page-desc');
            if (pageDesc) pageDesc.textContent = meta.desc || '';
            const headerBreadcrumb = document.getElementById('header-breadcrumb');
            if (headerBreadcrumb) headerBreadcrumb.textContent = meta.breadcrumb;

            if (tab === 'records') {
                initRecordsTab();
            } else if (tab === 'teachers') {
                initTeachersTab();
            } else if (tab === 'batches') {
                initBatchesTab();
            } else if (tab === 'qbank-audit') {
                initQbankAuditTab();
            } else if (tab === 'logs') {
                loadFilters();
                loadLogs(1);
            } else if (tab === 'database') {
                initDatabaseTab();
            } else if (tab === 'changelog') {
                loadChangelogs();
            }

            closeMobileMenu();
        }

        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                switchTab(item.dataset.tab);
            });
        });

        function openMobileMenu() {
            const sidebar = document.querySelector('.admin-sidebar');
            const overlay = document.getElementById('mobile-overlay');
            if (sidebar) {
                sidebar.classList.add('open');
                sidebar.classList.add('mobile-open');
            }
            if (overlay) {
                overlay.classList.add('show');
                overlay.classList.add('active');
            }
            document.body.classList.add('mobile-nav-active');
            document.body.style.overflow = 'hidden';
        }

        function closeMobileMenu() {
            const sidebar = document.querySelector('.admin-sidebar');
            const overlay = document.getElementById('mobile-overlay');
            if (sidebar) {
                sidebar.classList.remove('open');
                sidebar.classList.remove('mobile-open');
            }
            if (overlay) {
                overlay.classList.remove('show');
                overlay.classList.remove('active');
            }
            document.body.classList.remove('mobile-nav-active');
            document.body.style.overflow = '';
        }

        window.openMobileMenu = openMobileMenu;
        window.closeMobileMenu = closeMobileMenu;

        document.getElementById('mobile-menu-btn')?.addEventListener('click', openMobileMenu);
        document.getElementById('mobile-overlay')?.addEventListener('click', closeMobileMenu);
        document.getElementById('sidebar-close-btn')?.addEventListener('click', closeMobileMenu);

        // 按 ESC 键快速退出移动端侧边栏
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeMobileMenu();
            }
        });

        // 窗口尺寸扩大至桌面端时自动复位
        window.addEventListener('resize', () => {
            if (window.innerWidth > 1024) {
                closeMobileMenu();
            }
        });


        const ADMIN_CLICK_ACTIONS = {
            'reset-active-zoom': () => resetActiveTableZoom(),
            'resolve-confirm': (_el, arg) => resolveConfirm(arg === '1'),
            'close-pwd-modal': () => closeChangePwdModal(),
            'submit-pwd': () => submitChangePwd(),
            'open-pwd-modal': () => openChangePwdModal(),
            'logout': () => logout(),
            'open-mobile-menu': () => openMobileMenu(),
            'close-mobile-menu': () => closeMobileMenu(),
            'set-season': (_el, arg) => setSeason(arg),
            'toggle-api-key': () => toggleApiKeyVisibility(),
            'test-ai-conn': () => testAiConnection(),
            'save-config': () => saveConfig(),
            'reset-records-filters': () => resetRecordsFilters(),
            'rec-zoom': (_el, arg) => changeRecTableZoom(parseFloat(arg)),
            'rec-zoom-reset': () => resetRecTableZoom(),
            'toggle-records-view': () => toggleRecordsViewMode(),
            'batch-delete-records': () => batchDeleteRecords(),
            'reload-records': () => loadRecordsData(recCurrentPage),
            'open-record-create': () => openRecordCreateModal(),
            'records-sort': (_el, arg) => setRecordsSort(arg),
            'reset-batches-filters': () => resetBatchesFilters(),
            'batch-delete-batches': () => batchDeleteBatches(),
            'reload-batches': () => loadBatchesData(batCurrentPage),
            'batches-sort': (_el, arg) => setBatchesSort(arg),
            'batch-delete-teachers': () => batchDeleteTeachers(),
            'open-new-teacher': () => openDbRecordModal(null, 'users'),
            'reload-teachers': () => loadTeachersData(),
            'teacher-sort': (_el, arg) => setTeacherSort(arg),
            'switch-logs-subview': (_el, arg) => switchLogsSubview(arg),
            'quick-filter-sender': () => quickFilterSenderModule(),
            'export-logs': () => exportLogs(),
            'load-logs': () => loadLogs(),
            'load-sender-clients': () => loadSenderClients(),
            'db-zoom': (_el, arg) => changeDbTableZoom(parseFloat(arg)),
            'db-zoom-reset': () => resetDbTableZoom(),
            'toggle-db-view': () => toggleDbViewMode(),
            'batch-delete-db': () => batchDeleteDbRecords(),
            'reload-db': () => loadDbData(dbCurrentPage),
            'open-db-create': () => openDbRecordModal(),
            'db-sort': (_el, arg) => setDbSort(arg),
            'open-changelog': () => openChangelogModal(),
            'close-db-record': () => closeDbRecordModal(),
            'save-db-record': () => saveDbRecord(),
            'close-db-detail': () => closeDbDetailModal(),
            'close-token-search': () => closeTokenSearchModal(),
            'clear-token-input': () => clearTokenModalInput(),
            'paste-token-search': () => pasteFromClipboardToTokenSearch(),
            'do-token-search': () => doSearchStudentByToken(),
            'close-changelog': () => closeChangelogModal(),
            'add-changelog-row': () => addChangelogItemRow(),
            'save-changelog': () => saveChangelog(),
            'dock-batch-delete': () => triggerDockBatchDelete(),
            'clear-all-selections': () => clearAllSelections(),
            'qba-switch-view': (_el, arg) => switchQbankAuditView(arg),
            'qba-matrix-reload': () => loadQbankMatrix(),
            'qba-matrix-reset': () => resetQbankMatrixFilters(),
            'qba-tl-clear-scope': () => clearQbankLinkedScope(),
            'qba-tl-reset': () => resetQbankTimelineFilters(),
            'qba-tl-reload': () => loadQbankTimeline(1),
            'qba-close-revisions': () => closeQbankRevisionsModal(),
            'qba-anchor-now': () => triggerQbankAnchorNow()
        };

        const ADMIN_CHANGE_ACTIONS = {
            'retest-qr-toggle': () => onRetestQrToggleChange(),
            'sc-stage-toggle': () => onSenderStageToggleChange(),
            'sc-service-toggle': () => onSenderServiceToggleChange(),
            'records-per-page': (el) => changeRecordsPerPage(el.value),
            'select-all-records': (el) => toggleSelectAllRecords(el.checked),
            'batches-per-page': (el) => changeBatchesPerPage(el.value),
            'select-all-batches': (el) => toggleSelectAllBatches(el.checked),
            'reload-teachers-p1': () => loadTeachersData(1),
            'teachers-per-page': (el) => changeTeachersPerPage(el.value),
            'select-all-teachers': (el) => toggleSelectAllTeachers(el),
            'load-logs': () => loadLogs(),
            'load-sender-clients': () => loadSenderClients(),
            'db-per-page': (el) => changeDbPerPage(el.value),
            'select-all-db': (el) => toggleDbSelectAll(el),
            'qba-matrix-reload': () => loadQbankMatrix(),
            'qba-tl-teacher-select': (el) => onQbaTeacherSelectChange(el.value),
            'qba-tl-reload': () => loadQbankTimeline(1),
            'qba-tl-pagesize': (el) => changeQbaTimelinePageSize(el.value)
        };

        const ADMIN_INPUT_ACTIONS = {
            'overview-text': () => updateOverviewText(),
            'debounce-records': () => debounceLoadRecordsData(),
            'debounce-batches': () => debounceLoadBatchesData(),
            'debounce-teachers': () => debounceLoadTeachersData(),
            'debounce-logs': () => debounceLoadLogs(),
            'render-sender-clients': () => renderSenderClientsList(),
            'debounce-db': () => debounceLoadDbData(),
            'token-modal-clear': () => toggleTokenModalClearBtn(),
            'qba-matrix-search': () => debounceQbaMatrixSearch(),
            'qba-tl-search': () => debounceQbaTimelineSearch()
        };

        document.addEventListener('click', (e) => {
            const target = e.target.closest('[data-action]');
            if (!target) return;
            const handler = ADMIN_CLICK_ACTIONS[target.dataset.action];
            if (handler) handler(target, target.dataset.arg);
        });

        document.addEventListener('change', (e) => {
            const target = e.target.closest('[data-change]');
            if (!target) return;
            const handler = ADMIN_CHANGE_ACTIONS[target.dataset.change];
            if (handler) handler(target, target.dataset.arg);
        });

        document.addEventListener('input', (e) => {
            const target = e.target.closest('[data-input]');
            if (!target) return;
            const handler = ADMIN_INPUT_ACTIONS[target.dataset.input];
            if (handler) handler(target, target.dataset.arg);
        });

        const dbRecordForm = document.getElementById('db-record-form');
        if (dbRecordForm) {
            dbRecordForm.addEventListener('submit', (e) => {
                e.preventDefault();
                saveDbRecord();
            });
        }

        const tokenModalInput = document.getElementById('token-modal-input');
        if (tokenModalInput) {
            tokenModalInput.addEventListener('keydown', (e) => {
                if (!e.isComposing && e.keyCode !== 229 && e.key === 'Enter') {
                    doSearchStudentByToken();
                }
            });
        }

        /* ========================================================
           System Bootstrap
           ======================================================== */
        (async () => {
            initTheme();
            setupTableWheelZoom();
            const authed = await checkAuth();
            if (authed) {
                await loadConfig();
                loadRecordsStats();
            }
            document.body.classList.add('page-ready', 'ready');
        })();
