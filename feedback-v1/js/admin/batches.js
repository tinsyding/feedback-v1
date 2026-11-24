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
                    <button type="button" class="filter-pill ${isActive ? 'active' : ''}" onclick="setBatFilter('teacher', '${escapeInlineJs(t.username)}')">
                        ${escapeHtml(label)}
                    </button>
                `;
            }).join('');

            const gradeList = ((typeof dbFilterOptions !== 'undefined' && dbFilterOptions.grades) || []).filter(Boolean);
            const gradePills = gradeList.map(g => `
                <button type="button" class="filter-pill ${batFilters.grade === g ? 'active' : ''}" onclick="setBatFilter('grade', '${escapeInlineJs(g)}')">
                    ${escapeHtml(g)}
                </button>
            `).join('');

            const subjectList = ((typeof dbFilterOptions !== 'undefined' && dbFilterOptions.subjects) || []).filter(Boolean);
            const subjectPills = subjectList.map(s => `
                <button type="button" class="filter-pill ${batFilters.subject === s ? 'active' : ''}" onclick="setBatFilter('subject', '${escapeInlineJs(s)}')">
                    ${escapeHtml(s)}
                </button>
            `).join('');

            const tierList = ((typeof dbFilterOptions !== 'undefined' && dbFilterOptions.tiers) || []).filter(Boolean);
            const tierPills = tierList.map(t => `
                <button type="button" class="filter-pill ${batFilters.tier === t ? 'active' : ''}" onclick="setBatFilter('tier', '${escapeInlineJs(t)}')">
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
                            <span style="cursor: pointer; color: var(--text-primary);" onclick="jumpToBatchRecords('${escapeInlineJs(batchCode)}')" title="点击查看该批次的学情记录">${escapeHtml(batchCode)}</span>
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
                            <button type="button" class="btn-action detail" onclick="jumpToBatchRecords('${escapeInlineJs(batchCode)}')" title="查看该批次的学情记录">学情</button>
                            <button type="button" class="btn-action danger" onclick="deleteBatchDirect(${Number(r.id) || 0}, '${escapeInlineJs(batchCode)}')" title="删除该批次记录（不影响学情数据）">删除</button>
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
