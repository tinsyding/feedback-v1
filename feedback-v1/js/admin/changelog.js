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
            modal.style.display = 'flex';
        }

        function closeChangelogModal() {
            const modal = document.getElementById('changelog-modal');
            if (modal) modal.style.display = 'none';
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

