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

