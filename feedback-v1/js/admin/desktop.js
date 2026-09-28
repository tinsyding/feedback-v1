/**
 * Admin 桌面端云端日志模块 (独立 Tab: 反馈工具上报的诊断日志, module='desktop')
 * 后端复用 api/logs.php?action=list/export，无需新增接口。
 */

        /* ========================================================
           TAB: Desktop Cloud Logs Logic (每周反馈程序云端诊断日志)
           ======================================================== */
        let deskCurrentPage = 1;
        let deskPerPage = 20;
        let deskDebounceTimer = null;
        let deskLogsCache = [];

        function initDesktopTab() {
            loadDesktopLogs(1);
        }

        function debounceLoadDesktopLogs() {
            clearTimeout(deskDebounceTimer);
            deskDebounceTimer = setTimeout(() => {
                loadDesktopLogs(1);
            }, 300);
        }

        function changeDesktopPerPage(val) {
            deskPerPage = parseInt(val, 10) || 20;
            loadDesktopLogs(1);
        }

        async function loadDesktopLogs(page = 1) {
            deskCurrentPage = page;
            const level = document.getElementById('desk-level-filter')?.value || '';
            const eventStr = document.getElementById('desk-event-filter')?.value || '';
            const searchStr = document.getElementById('desk-search-filter')?.value || '';
            const tbody = document.getElementById('desk-tbody');

            if (!tbody) return;

            tbody.innerHTML = `
                <tr>
                    <td colspan="5" class="table-empty">
                        <div class="empty-state">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"></path>
                                <polyline points="14 2 14 8 20 8"></polyline>
                            </svg>
                            <span>桌面云端日志检索中...</span>
                        </div>
                    </td>
                </tr>
            `;

            try {
                const params = new URLSearchParams({ action: 'list', page, perPage: deskPerPage, module: 'desktop' });
                if (level) params.append('level', level);
                if (eventStr) params.append('event', eventStr);
                if (searchStr) params.append('search', searchStr);

                const response = await fetch(`${LOG_API}?${params}`);
                const result = await response.json();

                if (result.success) {
                    deskLogsCache = result.data.logs || [];
                    renderDesktopStats(result.data.stats);
                    renderDesktopLogs(deskLogsCache);
                    renderDesktopPagination(result.data.pagination);
                    const navBadge = document.getElementById('nav-desktop-badge');
                    if (navBadge) navBadge.textContent = `${result.data.pagination?.total ?? result.data.stats?.total ?? 0} 条`;
                } else {
                    tbody.innerHTML = `<tr><td colspan="5" class="table-empty"><div class="empty-state"><span>${result.error || '加载失败'}</span></div></td></tr>`;
                }
            } catch (err) {
                tbody.innerHTML = '<tr><td colspan="5" class="table-empty"><div class="empty-state"><span>网络请求错误</span></div></td></tr>';
            }
        }

        async function exportDesktopLogs() {
            const level = document.getElementById('desk-level-filter')?.value || '';
            const eventStr = document.getElementById('desk-event-filter')?.value || '';
            const searchStr = document.getElementById('desk-search-filter')?.value || '';

            const params = new URLSearchParams({ action: 'export', module: 'desktop' });
            if (level) params.append('level', level);
            if (eventStr) params.append('event', eventStr);
            if (searchStr) params.append('search', searchStr);

            window.location.href = `${LOG_API}?${params.toString()}`;
        }

        function renderDesktopStats(stats) {
            if (!stats) return;
            const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v || 0; };
            set('dstat-total', stats.total);
            set('dstat-error', stats.error);
            set('dstat-warn', stats.warn);
            set('dstat-action', stats.action);
            set('dstat-info', stats.info);
        }

        function renderDesktopLogs(logs) {
            const tbody = document.getElementById('desk-tbody');
            if (!tbody) return;

            if (!logs || logs.length === 0) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="5" class="table-empty">
                            <div class="empty-state">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002-2V8z"></path>
                                    <polyline points="14 2 14 8 20 8"></polyline>
                                </svg>
                                <span>暂无桌面端上报的云端日志</span>
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
                const evt = escapeHtml(log.event || log.action || '-');
                const details = formatLogDetailsHtml(log.details);
                const hasDetailedData = log.details && Object.keys(log.details).length > 0;

                return `
                    <tr>
                        <td class="cell-mono" style="font-size:0.82rem; color:var(--text-secondary);">${time}</td>
                        <td>${lvl}</td>
                        <td style="font-weight:600; color: var(--text-primary);">${evt}</td>
                        <td style="font-size:0.85rem; line-height:1.4; ${hasDetailedData ? 'cursor:pointer;' : ''}" ${hasDetailedData ? `onclick="showDesktopLogDetail(${index})" title="点击查看完整数据"` : ''}>
                            ${details}
                            ${hasDetailedData ? '<span style="display:inline-block; margin-left:8px; opacity:0.6; font-size:0.75rem; border:1px solid var(--border-color); padding:1px 5px; border-radius:3px; vertical-align:middle;">展开</span>' : ''}
                        </td>
                        <td class="cell-mono" style="font-size:0.8rem; color:var(--text-secondary);">${escapeHtml(log.client?.ip || '')}</td>
                    </tr>
                `;
            }).join('');
        }

        function showDesktopLogDetail(index) {
            const log = deskLogsCache[index];
            if (!log) return;

            const rawJson = JSON.stringify(log.details, null, 2);
            const title = log.event || log.action || '桌面云端日志详情';

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

        function renderDesktopPagination(pagination) {
            const container = document.getElementById('desk-pagination');
            if (!container || !pagination) return;
            const { page, totalPages, total } = pagination;
            if (totalPages <= 1 && total <= 0) { container.innerHTML = ''; return; }

            container.innerHTML = `
                <div style="font-size:0.88rem; color:var(--text-secondary);">
                    共 <b style="color: var(--text-primary);">${total || 0}</b> 条记录 · 第 <b style="color:var(--primary);">${page}</b> / ${totalPages || 1} 页
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    ${page > 1 ? `<button class="page-btn" onclick="loadDesktopLogs(${page - 1})">上一页</button>` : `<button class="page-btn" disabled>上一页</button>`}
                    <span style="font-size:0.88rem; font-weight:600; color: var(--text-primary); padding:0 6px;">${page}</span>
                    ${page < totalPages ? `<button class="page-btn" onclick="loadDesktopLogs(${page + 1})">下一页</button>` : `<button class="page-btn" disabled>下一页</button>`}
                </div>
            `;
        }
