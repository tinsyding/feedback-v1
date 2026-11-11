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
                if (countBadgeEl) {
                    countBadgeEl.textContent = senderClientsCache.length > 0 ? `${senderClientsCache.length} 台归档` : '自动同步';
                }
                renderSenderClientsList();

                if (senderClientsCache.length > 0) {
                    const currentStillExists = senderClientsCache.some(c => `${c.date}__${c.client_slug}` === selectedSenderKey);
                    if (!currentStillExists) {
                        const first = senderClientsCache[0];
                        selectSenderClient(first.date, first.client_slug);
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
                const activeFilesText = Array.isArray(item.active_files) && item.active_files.length > 0
                    ? item.active_files.join(', ')
                    : '未挂载课表';
                const lastSync = item.last_sync_at || item.last_seen || '-';

                return `
                    <div onclick="selectSenderClient('${escapeHtml(item.date)}', '${escapeHtml(item.client_slug)}')"
                         style="padding:12px; border-radius:8px; margin-bottom:8px; cursor:pointer; transition:all 0.15s ease; border:1px solid ${isSelected ? 'var(--primary)' : 'var(--border-color)'}; background:${isSelected ? 'rgba(99, 102, 241, 0.12)' : 'rgba(255,255,255,0.02)'};">
                        <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; margin-bottom:4px;">
                            <span style="font-weight:700; font-size:0.88rem; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(displayName)}">
                                ${escapeHtml(displayName)}
                            </span>
                            <span style="font-size:0.74rem; color:var(--text-secondary); font-family:var(--font-mono); flex-shrink:0;">${escapeHtml(item.date)}</span>
                        </div>
                        <div style="font-size:0.77rem; color:var(--text-secondary); margin-bottom:6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(activeFilesText)}">
                            课表: ${escapeHtml(activeFilesText)}
                        </div>
                        <div style="display:flex; align-items:center; justify-content:space-between; font-size:0.74rem; color:var(--text-secondary); flex-wrap:wrap; gap:4px;">
                            <span>最后活跃: ${escapeHtml(lastSync.split(' ')[1] || lastSync)}</span>
                            <div style="display:flex; gap:4px;">
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

            panel.innerHTML = `
                <div style="padding:14px 18px; border-bottom:1px solid var(--border-color); display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
                    <div>
                        <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                            <h3 style="margin:0; font-size:1rem; font-weight:700; color:var(--text-primary);">${escapeHtml(displayName)}</h3>
                            <span style="font-size:0.78rem; padding:2px 8px; border-radius:4px; background:rgba(255,255,255,0.06); color:var(--text-secondary); font-family:var(--font-mono);">日期: ${escapeHtml(client.date)}</span>
                            <span style="font-size:0.78rem; padding:2px 8px; border-radius:4px; background:rgba(255,255,255,0.06); color:var(--text-secondary); font-family:var(--font-mono);">系统账号: ${escapeHtml(client.os_user || '-')} | IP: ${escapeHtml(client.ip || '-')}</span>
                        </div>
                        <div style="font-size:0.8rem; color:var(--text-secondary); margin-top:6px;">
                            当前/最近课表：<b style="color:var(--text-primary);">${escapeHtml(activeFilesText)}</b>
                            <span style="margin-left:12px; opacity:0.75;">最后同步时间：${escapeHtml(lastSync)}</span>
                        </div>
                    </div>
                    <div style="display:flex; gap:6px;">
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
                        <button class="btn ${activeSenderLogType === 'sender' ? 'primary' : 'secondary'}" onclick="activeSenderLogType='sender'; renderSenderRawTab(senderClientsCache.find(c=>c.date==='${escapeHtml(client.date)}' && c.client_slug==='${escapeHtml(client.client_slug)}'))" style="padding:4px 10px; font-size:0.8rem;">
                            全量运行日志 (sender_${escapeHtml(client.date)}.log ${client.sender_log_size_kb ? `· ${client.sender_log_size_kb} KB` : ''})
                        </button>
                        <button class="btn ${activeSenderLogType === 'error' ? 'primary' : 'secondary'}" onclick="activeSenderLogType='error'; renderSenderRawTab(senderClientsCache.find(c=>c.date==='${escapeHtml(client.date)}' && c.client_slug==='${escapeHtml(client.client_slug)}'))" style="padding:4px 10px; font-size:0.8rem;">
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
                                        <img src="${titleUrl}" onclick="openSnapshotPreviewModal('${titleUrl}', '标题栏裁剪图 - ${escapeHtml(s.target_name || '')}')" style="width:100%; max-height:70px; object-fit:contain; background:#000; border-radius:4px; cursor:zoom-in; border:1px solid rgba(255,255,255,0.1);">
                                    </div>
                                ` : ''}
                                ${annotatedUrl ? `
                                    <div>
                                        <div style="font-size:0.73rem; color:var(--text-secondary); margin-bottom:3px;">企微窗口红框标注全图 (点击放大):</div>
                                        <img src="${annotatedUrl}" onclick="openSnapshotPreviewModal('${annotatedUrl}', '企微窗口现场全图 - ${escapeHtml(s.target_name || '')}')" style="width:100%; max-height:150px; object-fit:contain; background:#000; border-radius:4px; cursor:zoom-in; border:1px solid rgba(255,255,255,0.1);">
                                    </div>
                                ` : ''}
                            </div>
                        `;
                    }).join('')}
                </div>
            `;
        }

        function openSnapshotPreviewModal(imgUrl, title) {
            const modal = document.createElement('div');
            modal.className = 'modal-overlay';
            modal.style.zIndex = '9999';
            modal.innerHTML = `
                <div class="modal-box" style="max-width:90vw; max-height:90vh; width:auto;">
                    <div class="modal-header">
                        <h4>${escapeHtml(title || '现场核验截图')}</h4>
                        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                        </button>
                    </div>
                    <div class="modal-body" style="padding:12px; background:#000; text-align:center; overflow:auto; max-height:78vh;">
                        <img src="${imgUrl}" style="max-width:100%; max-height:74vh; object-fit:contain;">
                    </div>
                </div>
            `;
            modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
            document.body.appendChild(modal);
        }

