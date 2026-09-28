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
                            <button type="button" class="db-tab-pill ${tName === dbCurrentTable ? 'active' : ''}" onclick="switchDbTable('${escapeHtml(tName)}')">
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

            if (dbCurrentTable === 'student_records') {
                thead.innerHTML = `
                    <tr>
                        <th style="width: 38px; text-align: center;">
                            <input type="checkbox" id="db-select-all" onchange="toggleDbSelectAll(this)" style="accent-color: var(--primary); cursor: pointer;">
                        </th>
                        <th class="th-sortable ${dbSortField === 'student_id' ? 'active' : ''}" onclick="setDbSort('student_id')">学员 ${sortIcon('student_id')}</th>
                        <th style="width: 115px; min-width: 110px;">年级</th>
                        <th style="width: 65px;">学科</th>
                        <th style="width: 65px;">班型</th>
                        <th class="th-sortable ${dbSortField === 'week_num' ? 'active' : ''}" onclick="setDbSort('week_num')" style="width: 55px; text-align: center;">周次 ${sortIcon('week_num')}</th>
                        <th class="th-sortable ${dbSortField === 'homework_score' ? 'active' : ''}" onclick="setDbSort('homework_score')" style="width: 90px;">课后巩固成绩 ${sortIcon('homework_score')}</th>
                        <th class="th-sortable ${dbSortField === 'error_count' ? 'active' : ''}" onclick="setDbSort('error_count')">错题题号 ${sortIcon('error_count')}</th>
                        <th>评语</th>
                        <th class="th-sortable ${dbSortField === 'created_by' ? 'active' : ''}" onclick="setDbSort('created_by')" style="width: 105px;">生成教师 ${sortIcon('created_by')}</th>
                        <th class="th-sortable ${dbSortField === 'created_at' ? 'active' : ''}" onclick="setDbSort('created_at')" style="width: 120px;">录入时间 ${sortIcon('created_at')}</th>
                        <th style="width: 205px; text-align: right;">操作</th>
                    </tr>
                `;
            } else if (dbCurrentTable === 'class_batches') {
                thead.innerHTML = `
                    <tr>
                        <th style="width: 38px; text-align: center;">
                            <input type="checkbox" id="db-select-all" onchange="toggleDbSelectAll(this)" style="accent-color: var(--primary); cursor: pointer;">
                        </th>
                        <th class="th-sortable ${dbSortField === 'id' ? 'active' : ''}" onclick="setDbSort('id')" style="width: 60px;">ID ${sortIcon('id')}</th>
                        <th class="th-sortable ${dbSortField === 'year' ? 'active' : ''}" onclick="setDbSort('year')">年份 / 季度 ${sortIcon('year')}</th>
                        <th style="width: 115px; min-width: 110px;">年级</th>
                        <th>班型</th>
                        <th>学科</th>
                        <th>班级全称</th>
                        <th class="th-sortable ${dbSortField === 'created_by' ? 'active' : ''}" onclick="setDbSort('created_by')" style="width: 105px;">生成教师 ${sortIcon('created_by')}</th>
                        <th class="th-sortable ${dbSortField === 'created_at' ? 'active' : ''}" onclick="setDbSort('created_at')">创建时间 ${sortIcon('created_at')}</th>
                        <th style="width: 120px; text-align: right;">操作</th>
                    </tr>
                `;
            } else if (dbCurrentTable === 'retest_access_logs') {
                thead.innerHTML = `
                    <tr>
                        <th style="width: 38px; text-align: center;">
                            <input type="checkbox" id="db-select-all" onchange="toggleDbSelectAll(this)" style="accent-color: var(--primary); cursor: pointer;">
                        </th>
                        <th class="th-sortable ${dbSortField === 'id' ? 'active' : ''}" onclick="setDbSort('id')" style="width: 60px;">ID ${sortIcon('id')}</th>
                        <th>Token</th>
                        <th>学生姓名</th>
                        <th>动作</th>
                        <th>详情</th>
                        <th>访问 IP</th>
                        <th class="th-sortable ${dbSortField === 'created_at' ? 'active' : ''}" onclick="setDbSort('created_at')">查阅时间 ${sortIcon('created_at')}</th>
                        <th style="width: 100px; text-align: right;">操作</th>
                    </tr>
                `;
            } else if (dbCurrentTable === 'qbank_weeks') {
                thead.innerHTML = `
                    <tr>
                        <th style="width: 38px; text-align: center;">
                            <input type="checkbox" id="db-select-all" onchange="toggleDbSelectAll(this)" style="accent-color: var(--primary); cursor: pointer;">
                        </th>
                        <th class="th-sortable ${dbSortField === 'id' ? 'active' : ''}" onclick="setDbSort('id')" style="width: 60px;">ID ${sortIcon('id')}</th>
                        <th class="th-sortable ${dbSortField === 'year' ? 'active' : ''}" onclick="setDbSort('year')" style="width: 110px;">年份 / 季度 ${sortIcon('year')}</th>
                        <th style="width: 100px;">年级</th>
                        <th style="width: 75px;">班型</th>
                        <th style="width: 75px;">学科</th>
                        <th class="th-sortable ${dbSortField === 'week' ? 'active' : ''}" onclick="setDbSort('week')" style="width: 85px; text-align: center;">周次 ${sortIcon('week')}</th>
                        <th class="th-sortable ${dbSortField === 'question_count' ? 'active' : ''}" onclick="setDbSort('question_count')" style="width: 95px; text-align: center;">题目总数 ${sortIcon('question_count')}</th>
                        <th class="th-sortable ${dbSortField === 'created_by' ? 'active' : ''}" onclick="setDbSort('created_by')" style="width: 105px;">录入教师 ${sortIcon('created_by')}</th>
                        <th class="th-sortable ${dbSortField === 'updated_at' ? 'active' : ''}" onclick="setDbSort('updated_at')" style="width: 130px;">更新时间 ${sortIcon('updated_at')}</th>
                        <th style="width: 140px; text-align: right;">操作</th>
                    </tr>
                `;
            } else if (dbCurrentTable === 'qbank_questions') {
                thead.innerHTML = `
                    <tr>
                        <th style="width: 38px; text-align: center;">
                            <input type="checkbox" id="db-select-all" onchange="toggleDbSelectAll(this)" style="accent-color: var(--primary); cursor: pointer;">
                        </th>
                        <th class="th-sortable ${dbSortField === 'id' ? 'active' : ''}" onclick="setDbSort('id')" style="width: 60px;">ID ${sortIcon('id')}</th>
                        <th class="th-sortable ${dbSortField === 'question_num' ? 'active' : ''}" onclick="setDbSort('question_num')" style="width: 75px; text-align: center;">题号 ${sortIcon('question_num')}</th>
                        <th class="th-sortable ${dbSortField === 'topic' ? 'active' : ''}" onclick="setDbSort('topic')">考点 / 考查知识点 ${sortIcon('topic')}</th>
                        <th style="width: 160px;">年级 / 学科 / 班型</th>
                        <th class="th-sortable ${dbSortField === 'week' ? 'active' : ''}" onclick="setDbSort('week')" style="width: 75px; text-align: center;">周次 ${sortIcon('week')}</th>
                        <th class="th-sortable ${dbSortField === 'year' ? 'active' : ''}" onclick="setDbSort('year')" style="width: 105px;">年份/学期 ${sortIcon('year')}</th>
                        <th style="width: 80px; text-align: center;">题 / 解</th>
                        <th class="th-sortable ${dbSortField === 'created_by' ? 'active' : ''}" onclick="setDbSort('created_by')" style="width: 105px;">录入教师 ${sortIcon('created_by')}</th>
                        <th class="th-sortable ${dbSortField === 'updated_at' ? 'active' : ''}" onclick="setDbSort('updated_at')" style="width: 125px;">更新时间 ${sortIcon('updated_at')}</th>
                        <th style="width: 140px; text-align: right;">操作</th>
                    </tr>
                `;
            } else if (dbCurrentTable === 'system_logs') {
                thead.innerHTML = `
                    <tr>
                        <th style="width: 38px; text-align: center;">
                            <input type="checkbox" id="db-select-all" onchange="toggleDbSelectAll(this)" style="accent-color: var(--primary); cursor: pointer;">
                        </th>
                        <th class="th-sortable ${dbSortField === 'id' ? 'active' : ''}" onclick="setDbSort('id')" style="width: 65px;">ID ${sortIcon('id')}</th>
                        <th class="th-sortable ${dbSortField === 'level' ? 'active' : ''}" onclick="setDbSort('level')" style="width: 85px;">级别 ${sortIcon('level')}</th>
                        <th class="th-sortable ${dbSortField === 'module' ? 'active' : ''}" onclick="setDbSort('module')" style="width: 90px;">模块 ${sortIcon('module')}</th>
                        <th class="th-sortable ${dbSortField === 'event' ? 'active' : ''}" onclick="setDbSort('event')" style="width: 130px;">事件 ${sortIcon('event')}</th>
                        <th class="th-sortable ${dbSortField === 'operator' ? 'active' : ''}" onclick="setDbSort('operator')" style="width: 100px;">操作人 ${sortIcon('operator')}</th>
                        <th>详细日志内容摘要</th>
                        <th style="width: 120px;">客户端 IP</th>
                        <th class="th-sortable ${dbSortField === 'created_at' ? 'active' : ''}" onclick="setDbSort('created_at')" style="width: 130px;">记录时间 ${sortIcon('created_at')}</th>
                        <th style="width: 100px; text-align: right;">操作</th>
                    </tr>
                `;
            } else if (dbCurrentTable === 'admin_users') {
                thead.innerHTML = `
                    <tr>
                        <th style="width: 38px; text-align: center;">
                            <input type="checkbox" id="db-select-all" onchange="toggleDbSelectAll(this)" style="accent-color: var(--primary); cursor: pointer;">
                        </th>
                        <th class="th-sortable ${dbSortField === 'id' ? 'active' : ''}" onclick="setDbSort('id')" style="width: 60px;">ID ${sortIcon('id')}</th>
                        <th class="th-sortable ${dbSortField === 'username' ? 'active' : ''}" onclick="setDbSort('username')" style="width: 130px;">登录账号 ${sortIcon('username')}</th>
                        <th class="th-sortable ${dbSortField === 'real_name' ? 'active' : ''}" onclick="setDbSort('real_name')">姓名 / 备注 ${sortIcon('real_name')}</th>
                        <th class="th-sortable ${dbSortField === 'role' ? 'active' : ''}" onclick="setDbSort('role')" style="width: 110px;">角色权限 ${sortIcon('role')}</th>
                        <th class="th-sortable ${dbSortField === 'status' ? 'active' : ''}" onclick="setDbSort('status')" style="width: 90px; text-align: center;">状态 ${sortIcon('status')}</th>
                        <th style="width: 110px;">登录密码</th>
                        <th class="th-sortable ${dbSortField === 'last_login_at' ? 'active' : ''}" onclick="setDbSort('last_login_at')" style="width: 140px;">最后登录时间 ${sortIcon('last_login_at')}</th>
                        <th style="width: 120px;">最后登录 IP</th>
                        <th class="th-sortable ${dbSortField === 'created_at' ? 'active' : ''}" onclick="setDbSort('created_at')" style="width: 140px;">创建时间 ${sortIcon('created_at')}</th>
                        <th style="width: 120px; text-align: right;">操作</th>
                    </tr>
                `;
            } else if (dbCurrentTable === 'users') {
                thead.innerHTML = `
                    <tr>
                        <th style="width: 38px; text-align: center;">
                            <input type="checkbox" id="db-select-all" onchange="toggleDbSelectAll(this)" style="accent-color: var(--primary); cursor: pointer;">
                        </th>
                        <th class="th-sortable ${dbSortField === 'id' ? 'active' : ''}" onclick="setDbSort('id')" style="width: 60px;">ID ${sortIcon('id')}</th>
                        <th class="th-sortable ${dbSortField === 'username' ? 'active' : ''}" onclick="setDbSort('username')" style="width: 120px;">教师账号 ${sortIcon('username')}</th>
                        <th class="th-sortable ${dbSortField === 'real_name' ? 'active' : ''}" onclick="setDbSort('real_name')">教师姓名 ${sortIcon('real_name')}</th>
                        <th style="width: 110px; text-align: center;">名下助教</th>
                        <th class="th-sortable ${dbSortField === 'status' ? 'active' : ''}" onclick="setDbSort('status')" style="width: 85px; text-align: center;">状态 ${sortIcon('status')}</th>
                        <th style="width: 120px;">密码状态</th>
                        <th class="th-sortable ${dbSortField === 'last_login_at' ? 'active' : ''}" onclick="setDbSort('last_login_at')" style="width: 140px;">最后登录时间 ${sortIcon('last_login_at')}</th>
                        <th style="width: 110px;">最后登录 IP</th>
                        <th class="th-sortable ${dbSortField === 'created_at' ? 'active' : ''}" onclick="setDbSort('created_at')" style="width: 140px;">创建时间 ${sortIcon('created_at')}</th>
                        <th style="width: 200px; text-align: right;">操作</th>
                    </tr>
                `;
            } else {
                let colsHtml = `
                    <tr>
                        <th style="width: 38px; text-align: center;">
                            <input type="checkbox" id="db-select-all" onchange="toggleDbSelectAll(this)" style="accent-color: var(--primary); cursor: pointer;">
                        </th>
                `;
                schema.slice(0, 7).forEach(col => {
                    const colField = col.field || col.name;
                    colsHtml += `<th class="th-sortable ${dbSortField === colField ? 'active' : ''}" onclick="setDbSort('${colField}')">${escapeHtml(col.comment || colField)} ${sortIcon(colField)}</th>`;
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

                    let errBadges = '';
                    let errList = [];
                    try {
                        if (Array.isArray(r.error_questions)) {
                            errList = r.error_questions;
                        } else if (r.error_questions) {
                            errList = JSON.parse(r.error_questions);
                        }
                    } catch (e) {
                        errList = [];
                    }

                    if (errList && errList.length > 0) {
                        errBadges = errList.map(q => `<span class="q-badge">${escapeHtml(String(q))}</span>`).join('') + ` <span style="font-size:0.75rem; color:var(--text-muted);">(${errList.length}题)</span>`;
                    } else {
                        const hw = r.homework_score !== null && r.homework_score !== undefined && r.homework_score !== '' ? parseFloat(r.homework_score) : null;
                        const tot = r.total_score !== null && r.total_score !== undefined && r.total_score !== '' ? parseFloat(r.total_score) : null;
                        const comment = (r.teacher_comment || '').trim();
                        const isFullScore = (hw !== null && ((tot && hw >= tot && hw > 0) || hw >= 100)) 
                            || /全对|全部正确|满分|零失误|无错题|免除加练/i.test(comment);

                        if (isFullScore) {
                            errBadges = `<span class="q-badge-none"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:3px;vertical-align:-1px;"><polyline points="20 6 9 17 4 12"></polyline></svg>全对</span>`;
                        } else {
                            errBadges = `<span class="q-badge-unlisted" title="非满分且未记录具体错题号">未列出错题</span>`;
                        }
                    }

                    const tokenHtml = r.retest_token ? `
                        <span class="token-pill" onclick="copyDbToken('${escapeHtml(r.retest_token)}')" title="点击复制Token">
                            ${escapeHtml(r.retest_token)}
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg>
                        </span>
                    ` : '<span style="color:var(--text-muted);">-</span>';

                    const commentPreview = r.teacher_comment ? `
                        <div style="max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; color: var(--text-secondary); font-size: 0.8rem;" onclick="openDbDetailModal(${idx})" title="点击查看完整评语">
                            ${escapeHtml(r.teacher_comment)}
                        </div>
                    ` : '<span style="color:var(--text-muted);">-</span>';

                    const sId = (r.student_id || '').trim();
                    const sName = (r.student_name || '').trim();
                    const copyIdName = `${sId}${sName}`;
                    const gradeVal = r.grade || r._batch?.grade || '-';
                    const subjectVal = r.subject || r._batch?.subject || '-';
                    const tierVal = r.tier || r._batch?.tier || '-';

                    return `
                        <tr>
                            <td style="text-align: center;">
                                <input type="checkbox" class="db-row-cb" data-id="${r.id}" ${isSelected ? 'checked' : ''} onchange="toggleDbSelectRow(${r.id}, this)" style="accent-color: var(--primary); cursor: pointer;">
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
                            <td style="white-space: nowrap;"><span style="font-weight:600; color: var(--text-secondary);">${escapeHtml(gradeVal)}</span></td>
                            <td><b style="color:#a78bfa;">${escapeHtml(subjectVal)}</b></td>
                            <td><span style="background:rgba(255,255,255,0.08); padding:2px 7px; border-radius:4px; font-size:0.8rem; font-weight:600; color: var(--text-secondary);">${escapeHtml(tierVal)}</span></td>
                            <td style="text-align: center;"><span style="font-weight:700; color:#93c5fd; font-family:var(--font-mono); font-size:0.95rem;">${r.week_num ?? '-'}</span></td>
                            <td><span style="font-weight:700; color:#38bdf8; font-family:var(--font-mono); font-size:0.95rem;">${r.homework_score ?? '-'}</span></td>
                            <td>${errBadges}</td>
                            <td>${commentPreview}</td>
                            <td>${r.created_by ? renderCreatorCell(r, false) : '<span style="color:var(--text-muted); font-size:0.75rem;">-</span>'}</td>
                            <td class="cell-mono" style="font-size:0.8rem; color:var(--text-secondary);">${formatTimestamp(r.created_at)}</td>
                            <td style="text-align: right; white-space: nowrap;">
                                ${r.retest_token ? `<button type="button" class="btn-action retest" onclick="openRetestStudent('${escapeHtml(r.retest_token)}')" title="打开学员/家长端错题本（需输入姓名验证）">错题本</button>` : ''}
                                ${r.retest_token ? `<button type="button" class="btn-action admin-retest" onclick="openRetestDirect('${escapeHtml(r.retest_token)}')" title="管理员免密直达错题本">管理员错题本</button>` : ''}
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
                            <td><span class="token-pill" onclick="copyDbToken('${escapeHtml(r.token)}')">${escapeHtml(r.token || '-')}</span></td>
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
                        <button type="button" class="btn-action" style="color:var(--accent); border-color:rgba(10,132,255,0.3);" onclick="promptResetTeacherPwd(${r.id}, '${escapeHtml(r.username)}', '${escapeHtml(r.real_name || '')}')" title="重置教师密码">重置密码</button>
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

                    let errBadges = '';
                    let errList = [];
                    try {
                        if (Array.isArray(r.error_questions)) errList = r.error_questions;
                        else if (r.error_questions) errList = JSON.parse(r.error_questions);
                    } catch (e) { errList = []; }

                    if (errList && errList.length > 0) {
                        errBadges = errList.map(q => `<span class="q-badge">${escapeHtml(String(q))}</span>`).join('') + ` <span style="font-size:0.75rem; color:var(--text-muted);">(${errList.length}题)</span>`;
                    } else {
                        const hw = r.homework_score !== null && r.homework_score !== undefined && r.homework_score !== '' ? parseFloat(r.homework_score) : null;
                        const tot = r.total_score !== null && r.total_score !== undefined && r.total_score !== '' ? parseFloat(r.total_score) : null;
                        const comment = (r.teacher_comment || '').trim();
                        const isFullScore = (hw !== null && ((tot && hw >= tot && hw > 0) || hw >= 100)) 
                            || /全对|全部正确|满分|零失误|无错题|免除加练/i.test(comment);

                        if (isFullScore) {
                            errBadges = `<span class="q-badge-none"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right:3px;vertical-align:-1px;"><polyline points="20 6 9 17 4 12"></polyline></svg>全对</span>`;
                        } else {
                            errBadges = `<span class="q-badge-unlisted" title="非满分且未记录具体错题号">未列出错题</span>`;
                        }
                    }

                    const tokenHtml = r.retest_token ? `
                        <span class="token-pill" onclick="copyDbToken('${escapeHtml(r.retest_token)}')" title="点击复制Token">
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

                    return `
                        <div class="db-card-item ${isSelected ? 'selected' : ''}" data-id="${r.id}">
                            <div class="db-card-head">
                                <div class="db-card-head-left">
                                    <input type="checkbox" class="db-row-cb" data-id="${r.id}" ${isSelected ? 'checked' : ''} onchange="toggleDbSelectRow(${r.id}, this)" style="accent-color: var(--primary); cursor: pointer; width: 17px; height: 17px;">
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
                                    <span class="db-card-week-badge" title="第 ${r.week_num || '-'} 周">${r.week_num ?? '-'}</span>
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
                                    <span class="db-card-meta-label">课后巩固成绩</span>
                                    <b style="color:#38bdf8; font-family:var(--font-mono); font-size:1.05rem;">${formatScore(r.homework_score)}</b>
                                </div>
                                <div class="db-card-meta-cell">
                                    <span class="db-card-meta-label">生成教师</span>
                                    ${renderCreatorCell(r, true)}
                                </div>
                                <div class="db-card-meta-cell full-width">
                                    <span class="db-card-meta-label">错题情况</span>
                                    <div style="display:flex; align-items:center; flex-wrap:wrap; gap:4px;">${errBadges}</div>
                                </div>
                            </div>

                            ${r.teacher_comment ? `
                            <div class="db-card-comment" onclick="openDbDetailModal(${idx})" title="点击查看完整评语">
                                <span class="db-card-comment-icon"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></span>
                                <span class="db-card-comment-body">${escapeHtml(r.teacher_comment)}</span>
                            </div>` : ''}

                            <div class="db-card-footer">
                                <span class="db-card-time">${formatTimestamp(r.created_at)}</span>
                                <div class="db-card-btns">
                                    ${r.retest_token ? `<button type="button" class="btn-action retest" onclick="openRetestStudent('${escapeHtml(r.retest_token)}')" title="打开学员/家长端错题本（需输入姓名验证）">错题本</button>` : ''}
                                    ${r.retest_token ? `<button type="button" class="btn-action admin-retest" onclick="openRetestDirect('${escapeHtml(r.retest_token)}')" title="管理员免密直达错题本">管理员错题本</button>` : ''}
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
                                    <span class="token-pill" onclick="copyDbToken('${escapeHtml(r.token)}')">${escapeHtml(r.token || '-')}</span>
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
                        <button type="button" class="btn-action" style="color:var(--accent); border-color:rgba(10,132,255,0.3);" onclick="promptResetTeacherPwd(${r.id}, '${escapeHtml(r.username)}', '${escapeHtml(r.real_name || '')}')">重置密码</button>
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
                            <label>周次 / 专题序号 (1-20) *</label>
                            <input type="number" id="field-week_num" min="1" max="25" value="${recordData.week_num || 1}" required>
                        </div>

                        <div class="form-field">
                            <label>预习作业得分</label>
                            <input type="number" id="field-preview_score" step="0.5" min="0" max="150" value="${recordData.preview_score ?? ''}" placeholder="0-100">
                        </div>

                        <div class="form-field">
                            <label>课后巩固得分</label>
                            <input type="number" id="field-homework_score" step="0.5" min="0" max="150" value="${recordData.homework_score ?? ''}" placeholder="0-100">
                        </div>

                        <div class="form-field">
                            <label>总分 / 综合得分</label>
                            <input type="number" id="field-total_score" step="0.5" min="0" max="150" value="${recordData.total_score ?? ''}" placeholder="0-100">
                        </div>

                        <div class="form-field full-span">
                            <label>错题题号 (自动转 JSON 并同步 error_count)</label>
                            <input type="text" id="field-error_questions" value="${escapeHtml(errQuestionsVal)}" placeholder="例如: 1, 3, 5 或留空代表满分全对">
                            <span class="field-hint">支持中英文逗号如“1, 3, 5”；保存时将自动转换为标准 JSON 数组并自动重计错题总数。</span>
                        </div>

                        <div class="form-field full-span">
                            <label>教师专属个性化评语</label>
                            <textarea id="field-teacher_comment" rows="3" placeholder="例如: 思路整体清晰，第3题注意受力分析图与矢量方向...">${escapeHtml(recordData.teacher_comment || '')}</textarea>
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
                const isTest = recordData.username === '0';
                container.innerHTML = `
                    <div class="form-grid">
                        <div class="form-field">
                            <label>教师账号 (Username) *</label>
                            <input type="text" id="field-username" value="${escapeHtml(recordData.username || '')}" placeholder="例如: JF001" ${isEdit && isTest ? 'readonly style="opacity:0.75;"' : ''} required autocomplete="off">
                            <span class="field-hint">${isTest ? '测试账号为公共系统账号，工号不可更改' : '前台教师唯一登录工号或账号（如 JF001）'}</span>
                        </div>
                        <div class="form-field">
                            <label>教师姓名 (Real Name) *</label>
                            <input type="text" id="field-real_name" value="${escapeHtml(recordData.real_name || '')}" placeholder="例如: 张老师" required>
                            <span class="field-hint">教师展示名称，将显示在错题记录与反馈生成卡片中</span>
                        </div>
                        <div class="form-field">
                            <label>账号状态 (Status) *</label>
                            <select id="field-status" class="custom-select" required>
                                <option value="1" ${recordData.status === undefined || parseInt(recordData.status, 10) === 1 ? 'selected' : ''}>启用 (允许登录)</option>
                                <option value="0" ${parseInt(recordData.status, 10) === 0 ? 'selected' : ''}>禁用 (禁止登录)</option>
                            </select>
                        </div>
                        <div class="form-field">
                            <label>初始密码备注 (Initial Password)</label>
                            <input type="text" id="field-initial_password" value="${escapeHtml(recordData.initial_password || '')}" placeholder="教师初始分配密码">
                            <span class="field-hint">仅供初始参考；重置密码请直接点击列表中的“重置密码”</span>
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

            modal.style.display = 'flex';
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
            if (modal) modal.style.display = 'none';
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
                const previewScore = document.getElementById('field-preview_score')?.value;
                const homeworkScore = document.getElementById('field-homework_score')?.value;
                const totalScore = document.getElementById('field-total_score')?.value;
                const errorQuestions = document.getElementById('field-error_questions')?.value.trim();
                const teacherComment = document.getElementById('field-teacher_comment')?.value;
                const retestToken = document.getElementById('field-retest_token')?.value.trim();

                if (!studentId || !studentName) {
                    showToast('学号与学员姓名为必填项目！', 'warn');
                    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存数据记录'; }
                    return;
                }

                data.batch_id = batchId ? parseInt(batchId, 10) : null;
                data.student_id = studentId;
                data.student_name = studentName;
                data.week_num = weekNum ? parseInt(weekNum, 10) : 1;
                data.preview_score = previewScore !== '' ? parseFloat(previewScore) : null;
                data.homework_score = homeworkScore !== '' ? parseFloat(homeworkScore) : null;
                data.total_score = totalScore !== '' ? parseFloat(totalScore) : null;
                data.error_questions = errorQuestions;
                data.teacher_comment = teacherComment;
                data.retest_token = retestToken;
            } else if (activeTable === 'class_batches') {
                data.year = parseInt(document.getElementById('field-year')?.value, 10) || 2026;
                data.season = document.getElementById('field-season')?.value || '春季';
                data.grade = document.getElementById('field-grade')?.value.trim();
                data.tier = document.getElementById('field-tier')?.value.trim();
                data.subject = document.getElementById('field-subject')?.value.trim();
                data.class_name = document.getElementById('field-class_name')?.value.trim();

                if (!data.class_name) {
                    showToast('班级全称为必填项！', 'warn');
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
                    showToast('考查知识点 (Topic) 为必填项！', 'warn');
                    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存数据记录'; }
                    return;
                }
                if (!data.exercise_pdf) {
                    showToast('错题 / 题目 PDF 文件路径为必填项！', 'warn');
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
                    showToast('登录用户名不能为空！', 'warn');
                    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存数据记录'; }
                    return;
                }
                if (!isEdit && !password) {
                    showToast('新增管理员必须设置初始登录密码！', 'warn');
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
                const initialPassword = document.getElementById('field-initial_password')?.value.trim();

                if (!username) {
                    showToast('教师账号不能为空！', 'warn');
                    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存数据记录'; }
                    return;
                }
                data.username = username;
                data.real_name = realName || username;
                data.status = parseInt(status, 10) === 0 ? 0 : 1;
                data.initial_password = initialPassword || '';
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
                    showToast(isEdit ? '记录更新成功！' : '新记录已成功入库！', 'success');
                    if (activeTable === 'student_records') {
                        loadRecordsStats();
                        loadRecordsData(recCurrentPage);
                    }
                    if (activeTable === 'class_batches') {
                        await loadDbBatchOptions();
                    }
                    loadDbData(dbCurrentPage);
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
                showToast('测试账号（0）为系统公共体验账号，不支持重置密码！', 'warn');
                return;
            }
            const displayName = realName ? `${realName} (${username})` : username;
            const newPwd = prompt(`请输入教师【${displayName}】的新密码（至少6位）：`, '123456');
            if (newPwd === null) return;
            const trimmed = newPwd.trim();
            if (!trimmed || trimmed.length < 6) {
                showToast('新密码长度不能少于 6 位！', 'warn');
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
                    showToast(`教师【${displayName}】密码已成功重置！`, 'success');
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
                `您确定要永久删除第 ${id} 号数据记录吗？此操作将无法撤销！`,
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
                `注意：您当前选中了 ${count} 条记录。确定要一并永久删除吗？此操作无法撤销！`,
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
                    showToast(`已成功批量清理 ${count} 条记录！`, 'success');
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

                // 错题解析
                let errList = [];
                try {
                    if (Array.isArray(record.error_questions)) errList = record.error_questions;
                    else if (record.error_questions) errList = JSON.parse(record.error_questions);
                } catch (e) { errList = []; }

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

                // 构建错题考点区块 HTML（优雅中性设计，无花花绿绿荧光色）
                let weakSectionHtml = '';
                if (weakPointsText) {
                    weakSectionHtml = `
                        <div style="background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px 18px; display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;">
                            <div style="display: flex; align-items: flex-start; gap: 8px; flex: 1; min-width: 0;">
                                <span style="color: var(--text-secondary); font-size: 0.88rem; flex-shrink: 0; font-weight: 700;">【薄弱点归纳】：</span>
                                <span id="modal-weak-points-text" style="color: var(--text-primary); font-size: 0.88rem; font-weight: 500; line-height: 1.6;">${escapeHtml(weakPointsText)}</span>
                            </div>
                            <button type="button" class="btn secondary" style="padding: 4px 10px; font-size: 0.78rem; display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0;" onclick="copyWeakPointsFromModal()">
                                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg>
                                <span>复制薄弱点</span>
                            </button>
                        </div>
                    `;
                } else if (errList.length > 0) {
                    weakSectionHtml = `
                        <div style="background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 12px 18px; display: flex; align-items: flex-start; gap: 8px;">
                            <span style="color: var(--text-secondary); font-size: 0.88rem; flex-shrink: 0; font-weight: 700;">【错题题号】：</span>
                            <span style="color: var(--text-primary); font-size: 0.88rem; font-weight: 500; line-height: 1.5;">第 ${errList.join('、')} 题</span>
                        </div>
                    `;
                }

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
                                            <span style="background: var(--bg-subtle); color: var(--text-secondary); border: 1px solid var(--border-color); font-size: 0.76rem; font-weight: 600; padding: 1px 7px; border-radius: 4px; font-family: var(--font-mono);">
                                                第 ${record.week_num ?? '-'} 周
                                            </span>
                                            <span style="font-size: 0.75rem; color: var(--text-muted); font-family: var(--font-mono);">#${record.id}</span>
                                        </div>
                                        <div style="display: flex; align-items: center; gap: 6px; font-size: 0.82rem; color: var(--text-secondary); flex-wrap: wrap;">
                                            <span style="font-weight: 500;">${escapeHtml(gradeVal)}</span>
                                            <span style="color: var(--text-muted);">•</span>
                                            <span style="font-weight: 500;">${escapeHtml(subjectVal)}</span>
                                            <span style="color: var(--text-muted);">•</span>
                                            <span style="font-weight: 500;">${escapeHtml(tierVal)}</span>
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
                                        <button type="button" class="btn secondary" style="padding: 6px 12px; font-size: 0.82rem; display: inline-flex; align-items: center; gap: 5px;" onclick="openRetestStudent('${escapeHtml(record.retest_token)}')" title="打开学员/家长端错题本（需输入姓名验证）">
                                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>
                                            <span>错题本</span>
                                        </button>
                                        <button type="button" class="btn secondary" style="padding: 6px 12px; font-size: 0.82rem; display: inline-flex; align-items: center; gap: 5px;" onclick="openRetestDirect('${escapeHtml(record.retest_token)}')" title="管理员免密直达错题本">
                                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polygon points="12 8 8 12 12 16 12 8"></polygon></svg>
                                            <span>管理员错题本</span>
                                        </button>
                                    ` : ''}
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

                        <!-- 2. 成绩与批次指标看板 (统一中性风格) -->
                        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px;">
                            <!-- 课后巩固成绩 -->
                            <div style="background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 12px 16px;">
                                <div style="font-size: 0.76rem; font-weight: 600; color: var(--text-secondary); margin-bottom: 4px; display: flex; align-items: center; justify-content: space-between;">
                                    <span style="display: flex; align-items: center; gap: 5px;">
                                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
                                        课后巩固成绩
                                    </span>
                                    ${totScore ? `<span style="font-size: 0.72rem; color: var(--text-muted); font-family: var(--font-mono);">满分 ${totScore}分</span>` : ''}
                                </div>
                                <div style="display: flex; align-items: baseline; gap: 4px;">
                                    <span style="font-size: 1.55rem; font-weight: 700; color: var(--text-primary); font-family: var(--font-mono);">${hwScore}</span>
                                    ${hwScore !== '-' ? '<span style="font-size: 0.8rem; color: var(--text-muted); font-weight: 500;">分</span>' : ''}
                                </div>
                            </div>

                            <!-- 课前预习表现 -->
                            <div style="background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 12px 16px;">
                                <div style="font-size: 0.76rem; font-weight: 600; color: var(--text-secondary); margin-bottom: 4px;">
                                    <span style="display: flex; align-items: center; gap: 5px;">
                                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>
                                        课前预习表现
                                    </span>
                                </div>
                                <div style="display: flex; align-items: baseline; gap: 4px;">
                                    <span style="font-size: 1.55rem; font-weight: 700; color: var(--text-primary); font-family: var(--font-mono);">${prevScore}</span>
                                </div>
                            </div>

                            <!-- 生成批次 -->
                            <div style="background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 12px 16px;">
                                <div style="font-size: 0.76rem; font-weight: 600; color: var(--text-secondary); margin-bottom: 4px; display: flex; align-items: center; justify-content: space-between;">
                                    <span style="display: flex; align-items: center; gap: 5px;">
                                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>
                                        学情生成批次
                                    </span>
                                    ${record.batch_code ? `
                                        <div style="display:flex; align-items:center; gap:8px;">
                                            <span style="font-size: 0.72rem; color: var(--primary); cursor: pointer;" onclick="copyTextToClipboard('${escapeHtml(record.batch_code)}', '批次号已复制！')">复制</span>
                                            <span style="font-size: 0.72rem; color: var(--primary); cursor: pointer; font-weight: 600;" onclick="closeDbDetailModal(); filterByBatchCode('${escapeHtml(record.batch_code)}')">筛选</span>
                                        </div>
                                    ` : ''}
                                </div>
                                <div style="font-size: 0.88rem; font-weight: 600; color: var(--text-primary); font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; user-select: all; cursor: pointer;" title="点击复制批次号: ${escapeHtml(record.batch_code || '-')}" onclick="copyTextToClipboard('${escapeHtml(record.batch_code)}', '批次号已复制！')">
                                    ${escapeHtml(record.batch_code || '（暂无批次）')}
                                </div>
                            </div>
                        </div>

                        <!-- 3. 核心板块：薄弱知识点归纳 -->
                        ${weakSectionHtml}

                        <!-- 4. 评语 (紧凑优雅) -->
                        <div style="background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 10px 14px; display: flex; flex-direction: column; gap: 6px;">
                            <div style="display: flex; align-items: center; justify-content: space-between;">
                                <div style="font-size: 0.82rem; font-weight: 700; color: var(--text-secondary); display: flex; align-items: center; gap: 5px;">
                                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                                    评语
                                </div>
                                ${commentText ? `
                                    <button type="button" class="btn secondary" style="font-size: 0.72rem; padding: 2px 7px; display: inline-flex; align-items: center; gap: 4px;" onclick="copyCommentFromModal()">
                                        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg>
                                        <span>复制评语</span>
                                    </button>
                                ` : ''}
                            </div>
                            <div id="modal-comment-text" style="font-size: 0.84rem; color: var(--text-primary); line-height: 1.5; white-space: pre-wrap; background: var(--bg-subtle); border-radius: var(--radius-sm); padding: 8px 12px; border: 1px solid var(--border-color);">
                                ${escapeHtml(commentText || '（暂无评语）')}
                            </div>
                        </div>

                        <!-- 5. 录入来源文件名 -->
                        <div style="background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px 16px;">
                            <div style="font-size: 0.82rem; font-weight: 700; color: var(--text-secondary); margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
                                <span>录入来源文件名 ${srcList.length > 0 ? `(共 ${srcList.length} 个文件)` : ''}</span>
                            </div>
                            ${srcList.length > 0 ? `
                                <div style="display: flex; flex-wrap: wrap; gap: 6px;">
                                    ${srcList.map(fn => `
                                        <span style="font-size: 0.78rem; background: var(--bg-subtle); border: 1px solid var(--border-color); color: var(--text-secondary); padding: 3px 8px; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px; word-break: break-all;">
                                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
                                            <span>${escapeHtml(fn)}</span>
                                        </span>
                                    `).join('')}
                                </div>
                            ` : '<span style="color: var(--text-muted); font-size: 0.78rem;">（暂无记录来源文件名，历史数据或手动录入）</span>'}
                        </div>

                        <!-- 6. 历史版本快照与变更记录 -->
                        <div style="background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px 16px;">
                            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                                <div style="font-size: 0.84rem; font-weight: 700; color: var(--text-secondary); display: flex; align-items: center; gap: 6px;">
                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                                    <span>历史版本变更快照</span>
                                </div>
                                <button type="button" class="btn secondary" style="font-size: 0.74rem; padding: 2px 8px; display: inline-flex; align-items: center; gap: 4px;" onclick="loadRecordHistory(${record.id}, '${escapeHtml(record.student_name)}', ${record.batch_id || 0}, ${record.week_num || 0})">
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
                                                    <span class="cell-mono" style="font-size: 0.82rem; color: var(--text-secondary); background: var(--bg-subtle); padding: 2px 7px; border-radius: 4px; border: 1px solid var(--border-subtle); cursor: pointer;" onclick="copyTextToClipboard('${escapeHtml(ast.username)}', '助教账号已复制！')" title="点击复制账号">
                                                        @${escapeHtml(ast.username || '-')}
                                                        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" style="margin-left: 2px; vertical-align: -1px;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg>
                                                    </span>
                                                </div>
                                                ${astStatusBadge}
                                            </div>
                                            <div style="display: flex; align-items: center; gap: 8px;">
                                                <button type="button" class="btn-action" onclick="copyAssistantShareInfo('${escapeHtml(ast.real_name || '')}', '${escapeHtml(ast.username)}', '${escapeHtml(ast.initial_password || '')}', '${escapeHtml(record.real_name || '')}', '${escapeHtml(record.username)}')" title="一键复制助教账号密码及登录说明">复制凭证</button>
                                                <button type="button" class="btn-action" style="color:var(--accent); border-color:rgba(99,102,241,0.3);" onclick="promptResetTeacherPwd(${ast.id}, '${escapeHtml(ast.username)}', '${escapeHtml(ast.real_name || '')}')" title="重置助教登录密码">重置密码</button>
                                                <button type="button" class="btn-action delete" onclick="deleteAssistantInModal(${ast.id}, '${escapeHtml(ast.username)}', ${record.id})" title="删除此助教">删除</button>
                                            </div>
                                        </div>
                                        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding-top: 8px; border-top: 1px solid var(--border-subtle); font-size: 0.82rem; color: var(--text-secondary);">
                                            <div style="display: flex; align-items: center; gap: 6px;">
                                                <span style="color: var(--text-muted);">初始密码:</span>
                                                ${pwdDisp}
                                                ${ast.initial_password ? `<button type="button" class="btn-action" style="font-size:0.72rem; padding:1px 6px; height:20px; line-height:18px;" onclick="copyTextToClipboard('${escapeHtml(ast.initial_password)}', '初始密码已复制！')" title="复制初始密码">复制</button>` : ''}
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
                                    <div style="font-size: 1.1rem; font-weight: 800; color: var(--text-primary); font-family: var(--font-mono); display: flex; align-items: center; justify-content: space-between;">
                                        <span>${escapeHtml(record.username || '-')}</span>
                                        <button type="button" class="btn-action" style="font-size:0.72rem; padding:1px 6px;" onclick="copyTextToClipboard('${escapeHtml(record.username)}', '教师账号已复制！')">复制</button>
                                    </div>
                                </div>
                                <div style="background: var(--bg-subtle); padding: 10px 14px; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
                                    <div style="font-size: 0.74rem; color: var(--text-muted); margin-bottom: 3px;">教师姓名 / 备注</div>
                                    <div style="font-size: 1.05rem; font-weight: 700; color: var(--text-primary);">${escapeHtml(record.real_name || '-')}</div>
                                </div>
                                <div style="background: var(--bg-subtle); padding: 10px 14px; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
                                    <div style="font-size: 0.74rem; color: var(--text-muted); margin-bottom: 3px;">账号状态</div>
                                    <div style="margin-top: 2px;">${statusBadge}</div>
                                </div>
                                <div style="background: var(--bg-subtle); padding: 10px 14px; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
                                    <div style="font-size: 0.74rem; color: var(--text-muted); margin-bottom: 3px;">初始密码</div>
                                    <div style="font-size: 0.95rem; font-weight: 700; color: #f59e0b; font-family: var(--font-mono); display: flex; align-items: center; justify-content: space-between;">
                                        <span>${isTest ? '公共体验免密/0' : (record.initial_password ? escapeHtml(record.initial_password) : '<span style="color:var(--text-muted); font-size:0.82rem; font-weight:normal;">已自定义密码</span>')}</span>
                                        ${record.initial_password ? `<button type="button" class="btn-action" style="font-size:0.72rem; padding:1px 6px;" onclick="copyTextToClipboard('${escapeHtml(record.initial_password)}', '初始密码已复制！')">复制</button>` : ''}
                                    </div>
                                </div>
                                <div style="background: rgba(59,130,246,0.08); padding: 10px 14px; border-radius: var(--radius-sm); border: 1px solid rgba(59,130,246,0.25);">
                                    <div style="font-size: 0.74rem; color: #93c5fd; margin-bottom: 3px;">名下助教数量</div>
                                    <div style="font-size: 1.25rem; font-weight: 800; color: #60a5fa; font-family: var(--font-mono);">${assistants.length} <span style="font-size:0.8rem; font-weight:normal;">人</span></div>
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
                                    <button type="button" class="btn secondary" style="color:var(--accent); border-color:rgba(10,132,255,0.35); font-size:0.84rem; padding:6px 14px; display: inline-flex; align-items: center; gap: 4px;" onclick="promptResetTeacherPwd(${record.id}, '${escapeHtml(record.username)}', '${escapeHtml(record.real_name || '')}')">
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

            modal.style.display = 'flex';
        }

        function closeDbDetailModal() {
            const modal = document.getElementById('db-detail-modal');
            if (modal) modal.style.display = 'none';
        }

        window.copyAssistantShareInfo = function(astName, astUname, astPwd, teacherName, teacherUname) {
            const pwdDisp = astPwd || '（已设置独立密码）';
            const loginUrl = (window.location.origin.includes('vip.wxjifang.cn') || window.location.origin.includes('wxjifang.cn'))
                ? 'https://vip.wxjifang.cn'
                : window.location.origin;
            const text = `【极方助教账号】\n所属教师：${teacherName || teacherUname} (${teacherUname})\n助教姓名：${astName}\n登录账号：${astUname}\n初始密码：${pwdDisp}\n登录入口：${loginUrl}\n权限说明：具备学情反馈制作与错题本查阅打印权限（不可修改题库已配置题目）`;
            copyTextToClipboard(text, `助教【${astName}】账号密码已复制到剪贴板！`);
        };

        window.deleteAssistantFromDetail = async function(astId, astUsername, teacherId) {
            const confirmed = await showConfirm(
                '永久删除助教确认',
                `您确定要永久删除助教账号【${astUsername}】吗？此操作无法撤销！`,
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
                    showToast(`助教账号【${astUsername}】已成功删除！`, 'success');
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
                copyTextToClipboard(el.innerText.trim(), '薄弱点归纳已复制！');
            }
        }

        function copyCommentFromModal() {
            const el = document.getElementById('modal-comment-text');
            if (el) {
                const txt = el.innerText.trim();
                if (txt && !txt.startsWith('（暂无评语')) {
                    copyTextToClipboard(txt, '评语已复制！');
                    return;
                }
            }
            showToast('暂无评语可复制', 'info');
        }

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

        async function openRetestBetaDirect(token) {
            return openRetestDirect(token);
        }

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
            let text = '';

            let errs = [];
            try {
                errs = Array.isArray(r.error_questions) ? r.error_questions : JSON.parse(r.error_questions || '[]');
            } catch(e) { errs = []; }

            const validDetails = Array.isArray(r.error_details) ? r.error_details.filter(d => d && d.topic && d.topic !== '未标注考点') : [];

            if (validDetails.length > 0) {
                const lines = validDetails.map(d => `• 第${d.num}题：${d.topic}`);
                const summary = r.weak_points_text || validDetails.map(d => d.topic).filter((v, i, a) => a.indexOf(v) === i).join('、');
                text = `【${sName} - ${wNum}薄弱考点】\n${lines.join('\n')}\n• 薄弱考点归纳：${summary}`;
            } else if (r.weak_points_text && String(r.weak_points_text).trim()) {
                text = `【${sName} - ${wNum}薄弱考点】：${String(r.weak_points_text).trim()}`;
            } else if (errs.length > 0) {
                text = `【${sName} - ${wNum}错题题号】：第 ${errs.join('、')} 题\n（题库暂未录入考点解析，可结合错题本查看题目微课）`;
            } else {
                text = `【${sName} - ${wNum}学情】：本次巩固全部正确，无薄弱错题！`;
            }

            copyTextToClipboard(text, '已复制学员薄弱考点内容，可直接发送给家长！');
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

            const baseDomain = (window.location.hostname === 'vip.wxjifang.cn' || window.location.hostname === 'wxjifang.cn') ? window.location.origin : 'https://vip.wxjifang.cn';
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
                weakPointsDesc = '• 本周作业全部正确，继续保持！';
            }

            const sName = r.student_name || '同学';
            const hwScore = (r.homework_score !== null && r.homework_score !== undefined && r.homework_score !== '') ? `${r.homework_score}分` : '已按时提交';
            const totalScore = (r.total_score !== null && r.total_score !== undefined && r.total_score !== '') ? ` (满分${r.total_score}分)` : '';
            const wDesc = r.week_num ? `第${r.week_num}周` : '本周';

            const text = 
`【极方学员本周学情反馈】
家长您好！以下是 ${sName} 同学${wDesc}的学习情况反馈：
作业巩固成绩：${hwScore}${totalScore}
本周错题考点与薄弱知识点：
${weakPointsDesc}
教师评语：
${(r.teacher_comment && String(r.teacher_comment).trim()) ? String(r.teacher_comment).trim() : '学习态度认真，继续加油！'}${link ? `\n\n专属个性化错题本与微课巩固：\n${link}` : ''}`;

            copyTextToClipboard(text, '家校学情完整反馈语已复制到剪贴板！');
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
                modal = document.createElement('div');
                modal.id = 'copy-fallback-modal';
                modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';
                modal.innerHTML = `
                    <div style="background:#1e293b;border:1px solid #334155;border-radius:10px;padding:20px;max-width:520px;width:100%;box-shadow:0 10px 25px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:12px;">
                        <div style="display:flex;align-items:center;justify-content:space-between;">
                            <h4 style="margin:0;color:#f8fafc;font-size:1rem;font-weight:700;">请手动复制文本</h4>
                            <button type="button" style="background:none;border:none;color:#94a3b8;font-size:1.2rem;cursor:pointer;" onclick="document.getElementById('copy-fallback-modal').style.display='none'">✕</button>
                        </div>
                        <p style="margin:0;color:#94a3b8;font-size:0.85rem;" id="copy-fallback-hint">浏览器已自动全选文本，请按下 Ctrl+C 复制：</p>
                        <textarea id="copy-fallback-textarea" rows="8" style="width:100%;background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:6px;padding:10px;font-size:0.85rem;font-family:monospace;resize:vertical;outline:none;" readonly></textarea>
                        <div style="display:flex;justify-content:flex-end;gap:8px;">
                            <button type="button" class="btn primary" onclick="const ta=document.getElementById('copy-fallback-textarea');ta.focus();ta.select();document.execCommand('copy');showToast('已复制', 'success');document.getElementById('copy-fallback-modal').style.display='none';">选中并关闭</button>
                        </div>
                    </div>
                `;
                document.body.appendChild(modal);
            }
            modal.style.display = 'flex';
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
                                <button type="button" class="btn danger" style="padding: 3px 10px; font-size: 0.75rem; display: inline-flex; align-items: center; gap: 4px;" onclick="rollbackRecordVersion(${h.id}, '${escapeHtml(studentName)}', ${h.week_num})">
                                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><polyline points="3 3 3 8 8 8"></polyline></svg>
                                    <span>回溯至此版本</span>
                                </button>
                            </div>
                            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; font-size: 0.8rem;">
                                <div><span style="color: var(--text-muted);">操作人：</span><span style="color: var(--text-primary); font-weight: 600;">${escapeHtml(h.operator || h.created_by || '-')}</span></div>
                                <div><span style="color: var(--text-muted);">当时批次：</span><span style="color: var(--primary); font-family: var(--font-mono); font-weight: 600;">${escapeHtml(h.batch_code || '-')}</span></div>
                                <div><span style="color: var(--text-muted);">得分：</span>巩固 <b style="color: var(--text-primary); font-family: var(--font-mono);">${formatScore(h.homework_score)}</b> / 预习 <b style="color: var(--text-secondary); font-family: var(--font-mono);">${formatScore(h.preview_score)}</b></div>
                                <div><span style="color: var(--text-muted);">错题：</span><span style="color: var(--error); font-weight: 600;">${escapeHtml(errsStr)}</span></div>
                            </div>
                            ${h.teacher_comment ? `
                                <div style="font-size: 0.78rem; color: var(--text-primary); background: var(--bg-surface); border: 1px solid var(--border-color); padding: 6px 10px; border-radius: 4px; line-height: 1.45;">
                                    <span style="color: var(--text-muted);">当时评语：</span>${escapeHtml(h.teacher_comment)}
                                </div>
                            ` : ''}
                            ${h.source_files_list && h.source_files_list.length > 0 ? `
                                <div style="font-size: 0.75rem; color: var(--text-secondary);">
                                    <span style="color: var(--text-muted);">当时上传文件：</span>${escapeHtml(srcStr)}
                                </div>
                            ` : ''}
                        </div>
                    `;
                }).join('');
            } catch (e) {
                container.innerHTML = `<div style="font-size: 0.8rem; color: #f87171; padding: 8px;">加载历史版本失败: ${escapeHtml(e.message)}</div>`;
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
                    showToast(json.data?.message || '已成功回溯！', 'success', 3000);
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

