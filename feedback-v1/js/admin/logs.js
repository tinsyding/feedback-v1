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
                const evt = escapeHtml(log.event || log.action || '-');
                const details = formatLogDetailsHtml(log.details);
                const hasDetailedData = log.details && Object.keys(log.details).length > 0;

                return `
                    <tr>
                        <td class="cell-mono" style="font-size:0.82rem; color:var(--text-secondary);">${time}</td>
                        <td>${lvl}</td>
                        <td><span style="background:rgba(255,255,255,0.06); padding:3px 8px; border-radius:4px; font-size:0.82rem; font-weight:600;">${escapeHtml(module)}</span></td>
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

            const modal = document.createElement('div');
            modal.className = 'modal-overlay';
            modal.style.zIndex = '9999';
            modal.innerHTML = `
                <div class="modal-box" style="max-width:760px; max-height:85vh;">
                    <div class="modal-header">
                        <h4>事件详情：${escapeHtml(title)}</h4>
                        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        </button>
                    </div>
                    <div class="modal-body" style="background:rgba(0,0,0,0.3); padding:16px; font-family:var(--font-mono); white-space:pre-wrap; word-break:break-all; font-size:0.88rem; line-height:1.5;">${escapeHtml(rawJson)}</div>
                    <div class="modal-footer">
                        <button class="btn secondary" onclick="const text=this.parentElement.previousElementSibling.textContent; if(navigator.clipboard && window.isSecureContext){navigator.clipboard.writeText(text).then(()=>showToast('已复制内容到剪贴板','success'));}else{var ta=document.createElement('textarea');ta.value=text;ta.style.cssText='position:fixed;left:-9999px;';document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);showToast('已复制内容到剪贴板','success');}">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg>
                            复制完整 JSON
                        </button>
                        <button class="btn primary" onclick="this.closest('.modal-overlay').remove()">关闭</button>
                    </div>
                </div>
            `;
            modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
            document.body.appendChild(modal);
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

