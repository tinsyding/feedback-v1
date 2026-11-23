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
                        moduleSelect.innerHTML = '<option value="">全部模块</option>' + (result.data.modules || []).map(m => {
                            const safe = escapeHtml(m);
                            return `<option value="${safe}">${safe}</option>`;
                        }).join('');
                    }
                    const eventSelect = document.getElementById('log-event-filter');
                    if (eventSelect) {
                        eventSelect.innerHTML = '<option value="">全部事件</option>' + (result.data.events || []).map(e => {
                            const safe = escapeHtml(e);
                            return `<option value="${safe}">${safe}</option>`;
                        }).join('');
                    }
                    const dateSelect = document.getElementById('log-date-filter');
                    if (dateSelect) {
                        dateSelect.innerHTML = '<option value="">近7天</option>' + (result.data.dates || []).map(d => {
                            const safe = escapeHtml(d);
                            return `<option value="${safe}">${safe}</option>`;
                        }).join('');
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
                    tbody.innerHTML = `<tr><td colspan="5" class="table-empty"><div class="empty-state"><span>${escapeHtml(result.error || '加载失败')}</span></div></td></tr>`;
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

