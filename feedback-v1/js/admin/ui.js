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
                document.body.appendChild(container);
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

                if (modal) modal.style.display = 'flex';
            });
        }

        function resolveConfirm(result) {
            const modal = document.getElementById('confirm-modal');
            if (modal) modal.style.display = 'none';
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
            if (e.target && e.target.classList && e.target.classList.contains('modal-overlay')) {
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

            if (e.key === 'Escape') {
                const openModals = Array.from(document.querySelectorAll('.modal-overlay')).filter(m => m.style.display !== 'none' && m.style.display !== '');
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
           Daytime / Light Mode Switcher Logic
           ======================================================== */
        function initTheme() {
            const current = localStorage.getItem('admin_theme') || 'light';
            document.documentElement.setAttribute('data-theme', current);
            updateThemeButtonText(current);
        }

        function toggleTheme() {
            const current = document.documentElement.getAttribute('data-theme') || 'light';
            const next = current === 'light' ? 'dark' : 'light';
            document.documentElement.setAttribute('data-theme', next);
            localStorage.setItem('admin_theme', next);
            updateThemeButtonText(next);
        }

        function updateThemeButtonText(theme) {
            const textEl = document.getElementById('theme-toggle-text');
            if (textEl) {
                textEl.textContent = theme === 'light' ? '暗夜模式' : '日间模式';
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

