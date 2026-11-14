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
                    <button type="button" class="filter-pill ${isActive ? 'active' : ''}" onclick="setRecFilter('teacher', '${escapeHtml(t.username)}')" title="${hasRec ? '该教师有已录入的学情错题' : '暂无学情记录'}">
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
                <button type="button" class="filter-pill ${recFilters.grade === g ? 'active' : ''}" onclick="setRecFilter('grade', '${escapeHtml(g)}')">
                    ${escapeHtml(g)}
                </button>
            `).join('');

            // 3. 学科列表
            const rawSubjects = dbFilterOptions.subjects?.length ? dbFilterOptions.subjects : ['物理', '数学', '英语', '化学', '生物'];
            const subjectList = [...new Set(rawSubjects)].sort((a, b) => a.localeCompare(b, 'zh'));
            const subjectPills = subjectList.map(s => `
                <button type="button" class="filter-pill ${recFilters.subject === s ? 'active' : ''}" onclick="setRecFilter('subject', '${escapeHtml(s)}')">
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
                <button type="button" class="filter-pill ${recFilters.tier === t ? 'active' : ''}" onclick="setRecFilter('tier', '${escapeHtml(t)}')">
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
                            <div class="student-profile-chip" onclick="copyStudentIdName('${escapeHtml(copyIdName)}')" title="点击复制：${escapeHtml(copyIdName)}">
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
                                <div class="student-profile-chip" onclick="copyStudentIdName('${escapeHtml(copyIdName)}')" title="点击复制：${escapeHtml(copyIdName)}">
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

