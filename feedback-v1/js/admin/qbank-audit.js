/**
 * Admin 题库存证与复盘时间线模块 (qbank_matrix, qbank_timeline, qbank_revisions)
 */

        /* ========================================================
           TAB: Qbank Audit & Attestation Timeline (题库存证)
           ======================================================== */
        let qbaViewMode = 'both'; // 'both' | 'matrix' | 'timeline'
        let qbaMatrixItems = [];
        let qbaMatrixSearchTimer = null;

        let qbaTlPage = 1;
        let qbaTlPageSize = 20;
        let qbaTlItems = [];
        let qbaTlTotal = 0;
        let qbaTlSearchTimer = null;
        let qbaTlLinkedScope = null; // { bank_type, year, season, subject, grade, tier, week }
        let qbaInitialized = false;
        let qbaEventsBound = false;

        const QBA_BANK_LABELS = {
            homework: '课后巩固',
            preview: '预习',
            variation: '课后举一反三'
        };

        const QBA_EVENT_META = {
            create: { label: '初次创建', cls: 'action', color: 'var(--success)' },
            update: { label: '更新保存', cls: 'action', color: 'var(--primary)' },
            tier_sync: { label: '班层同步', cls: 'action', color: 'var(--info)' },
            delete: { label: '教师删除', cls: 'error', color: 'var(--error)' },
            admin_edit: { label: '后台编辑', cls: 'warn', color: 'var(--warning)' },
            admin_delete: { label: '后台删除', cls: 'error', color: 'var(--error)' },
            admin_rollback: { label: '后台回滚', cls: 'warn', color: 'var(--warning)' },
            upload_pdf: { label: '上传切片', cls: 'info', color: 'var(--info)' },
            client_blocked: { label: '前端拦截', cls: 'warn', color: 'var(--warning)' },
            save_rejected: { label: '服务端驳回', cls: 'error', color: 'var(--error)' },
            save_cancelled: { label: '取消保存', cls: 'warn', color: 'var(--warning)' },
            save_error: { label: '保存异常', cls: 'error', color: 'var(--error)' }
        };

        function qbaBankLabel(bt) {
            return QBA_BANK_LABELS[bt] || bt || '-';
        }

        function qbaSeasonUnit(season) {
            return (season === '暑' || season === '寒' || season === 'summer' || season === 'winter') ? '讲' : '周';
        }

        function qbaCopyText(text, okMsg = '已复制到剪贴板') {
            const val = String(text ?? '');
            if (!val) return;
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(val).then(() => showToast(okMsg, 'success')).catch(() => qbaCopyFallback(val, okMsg));
            } else {
                qbaCopyFallback(val, okMsg);
            }
        }

        function qbaCopyFallback(val, okMsg) {
            try {
                const ta = document.createElement('textarea');
                ta.value = val;
                ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                showToast(okMsg, 'success');
            } catch (_) {
                showToast('复制失败，请手动复制', 'error');
            }
        }

        function bindQbankAuditEvents() {
            if (qbaEventsBound) return;
            qbaEventsBound = true;

            const tab = document.getElementById('qbank-audit-tab');
            if (tab) {
                tab.addEventListener('click', (e) => {
                    const copyBtn = e.target.closest('[data-qba-copy]');
                    if (copyBtn) {
                        e.stopPropagation();
                        qbaCopyText(copyBtn.getAttribute('data-qba-copy'), copyBtn.getAttribute('data-qba-copy-msg') || '已复制回执编号');
                        return;
                    }

                    const revBtn = e.target.closest('[data-qba-rev-idx]');
                    if (revBtn) {
                        e.stopPropagation();
                        const idx = parseInt(revBtn.getAttribute('data-qba-rev-idx'), 10);
                        const item = qbaMatrixItems[idx];
                        if (item) openQbankRevisionsModal(item);
                        return;
                    }

                    const tlRevBtn = e.target.closest('[data-qba-tl-rev-idx]');
                    if (tlRevBtn) {
                        e.stopPropagation();
                        const idx = parseInt(tlRevBtn.getAttribute('data-qba-tl-rev-idx'), 10);
                        const item = qbaTlItems[idx];
                        if (item) openQbankRevisionsModal(item);
                        return;
                    }

                    const jumpBtn = e.target.closest('[data-qba-jump-idx]');
                    if (jumpBtn) {
                        e.stopPropagation();
                        const idx = parseInt(jumpBtn.getAttribute('data-qba-jump-idx'), 10);
                        const item = qbaMatrixItems[idx];
                        if (item) jumpToTimelineFromMatrixItem(item);
                        return;
                    }

                    const pageBtn = e.target.closest('[data-qba-page]');
                    if (pageBtn && !pageBtn.disabled) {
                        const page = parseInt(pageBtn.getAttribute('data-qba-page'), 10);
                        if (page > 0) loadQbankTimeline(page);
                        return;
                    }

                    const toggleDetailBtn = e.target.closest('[data-qba-detail-toggle]');
                    if (toggleDetailBtn) {
                        e.stopPropagation();
                        const targetId = toggleDetailBtn.getAttribute('data-qba-detail-toggle');
                        const detailEl = targetId ? document.getElementById(targetId) : null;
                        if (detailEl) {
                            const willShow = detailEl.style.display === 'none';
                            detailEl.style.display = willShow ? 'block' : 'none';
                            toggleDetailBtn.textContent = willShow ? '收起详情' : '展开详情 / SHA-256';
                        }
                        return;
                    }

                    // Clicking anywhere on a matrix row (excluding links/buttons) links to timeline below
                    if (e.target.closest('a, button, input, select')) return;
                    const row = e.target.closest('tr[data-qba-matrix-row]');
                    if (row) {
                        const idx = parseInt(row.getAttribute('data-qba-matrix-row'), 10);
                        const item = qbaMatrixItems[idx];
                        if (item) jumpToTimelineFromMatrixItem(item);
                    }
                });
            }

            const revModal = document.getElementById('qba-revisions-modal');
            if (revModal) {
                revModal.addEventListener('click', (e) => {
                    const copyBtn = e.target.closest('[data-qba-copy]');
                    if (copyBtn) {
                        qbaCopyText(copyBtn.getAttribute('data-qba-copy'), '已复制回执编号');
                        return;
                    }
                    const rbBtn = e.target.closest('[data-qba-rollback-code]');
                    if (rbBtn) {
                        const code = rbBtn.getAttribute('data-qba-rollback-code');
                        const revNo = rbBtn.getAttribute('data-qba-rollback-rev') || '-';
                        confirmQbankRollback(code, revNo);
                    }
                });
            }
        }

        async function initQbankAuditTab() {
            bindQbankAuditEvents();
            applyQbankAuditViewMode();
            if ((!currentConfig || !currentConfig.semesterYear) && typeof loadConfig === 'function') {
                await loadConfig();
            }
            if (!qbaInitialized && typeof loadDbBatchOptions === 'function') {
                await loadDbBatchOptions();
            }
            populateQbankAuditSelects();
            qbaInitialized = true;
            await Promise.all([
                loadQbankMatrix(),
                loadQbankTimeline(1),
                loadQbankAnchors()
            ]);
        }

        async function loadQbankAnchors() {
            const summaryEl = document.getElementById('qba-anchor-summary');
            if (!summaryEl) return;
            try {
                const res = await fetch('api/admin.php?action=qbank_anchors&limit=5');
                const json = await res.json();
                if (!res.ok || !json.success) {
                    summaryEl.textContent = '锚定状态查询失败';
                    return;
                }
                const items = json.data?.items || [];
                if (items.length === 0) {
                    summaryEl.textContent = '尚未生成外部锚定批次（可点击右侧按钮立即封装 Merkle 并向 TSA 锚定）';
                    return;
                }
                const latest = items[0];
                const tsaBadge = latest.tsa_status === 'anchored' ? 'TSA 已锚定' : '仅本地 Merkle';
                summaryEl.innerHTML = `最新批次 <span class="cell-mono" style="font-weight:600;">${escapeHtml(latest.anchor_code)}</span> · 覆盖序号 <span class="cell-mono">#${escapeHtml(latest.seq_from)}~#${escapeHtml(latest.seq_to)}</span>（${escapeHtml(latest.revision_count)} 条） · <b>${escapeHtml(tsaBadge)}</b> · ${escapeHtml(latest.tsa_gen_time || latest.anchored_at || '-')}`;
            } catch (_e) {
                summaryEl.textContent = '锚定状态暂不可用';
            }
        }

        async function triggerQbankAnchorNow() {
            const btn = document.getElementById('qba-anchor-now-btn');
            if (btn) btn.disabled = true;
            try {
                const res = await fetch('api/admin.php?action=qbank_anchor_now', { method: 'POST' });
                const json = await res.json();
                if (!res.ok || !json.success) {
                    if (typeof showToast === 'function') showToast(json.error || json.message || '执行锚定失败', 'error');
                    return;
                }
                if (json.data?.anchored) {
                    const anc = json.data.anchor;
                    if (typeof showToast === 'function') showToast(`已完成锚定 ${anc.anchor_code}（${anc.tsa_status === 'anchored' ? 'TSA 已签发' : '本地 Merkle'}）`, 'success');
                } else {
                    if (typeof showToast === 'function') showToast(json.data?.message || '暂无新增未锚定记录', 'info');
                }
                await loadQbankAnchors();
            } catch (err) {
                if (typeof showToast === 'function') showToast(err?.message || '锚定请求异常', 'error');
            } finally {
                if (btn) btn.disabled = false;
            }
        }

        let qbaRevModalScope = null;

        async function confirmQbankRollback(receiptCode, revNo) {
            if (!receiptCode) return;
            const msg = `确定要将该题库专题一键回滚到历史版本 v${revNo}（回执 ${receiptCode}）吗？\n\n系统将在单个事务内恢复题目与 PDF 配置，并自动签发一条新的“后台回滚”存证回执，不会篡改任何历史存证记录。`;
            let confirmed = false;
            if (window.DialogHelper && typeof window.DialogHelper.confirm === 'function') {
                confirmed = await window.DialogHelper.confirm({ title: '确认回滚历史题库快照', message: msg, danger: true });
            } else {
                confirmed = window.confirm(msg);
            }
            if (!confirmed) return;

            try {
                const res = await fetch('api/admin.php?action=qbank_rollback', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ receipt_code: receiptCode })
                });
                const json = await res.json();
                if (!res.ok || !json.success) {
                    if (typeof showToast === 'function') showToast(json.error || json.message || '回滚失败', 'error');
                    return;
                }
                const d = json.data || {};
                if (typeof showToast === 'function') {
                    showToast(`已回滚至 v${d.target_revision_no}（恢复 ${d.restored_count ?? 0} 题），新存证回执：${d.new_receipt_code || '-'}`, 'success');
                }
                await Promise.all([
                    loadQbankMatrix(),
                    loadQbankTimeline(1),
                    qbaRevModalScope ? openQbankRevisionsModal(qbaRevModalScope) : Promise.resolve()
                ]);
            } catch (err) {
                if (typeof showToast === 'function') showToast(err?.message || '回滚请求失败', 'error');
            }
        }

        function getQbaCurrentSemester() {
            const curYear = String((typeof currentConfig !== 'undefined' && currentConfig?.semesterYear) || new Date().getFullYear());
            const rawSeason = (typeof normalizeSeason === 'function' && typeof currentConfig !== 'undefined')
                ? normalizeSeason(currentConfig?.defaultSeason ?? 'autumn')
                : String((typeof currentConfig !== 'undefined' && currentConfig?.defaultSeason) || 'autumn');
            const seasonZhMap = { spring: '春', summer: '暑', autumn: '秋', winter: '寒', '春': '春', '暑': '暑', '秋': '秋', '寒': '寒' };
            const seasonLabelMap = { '春': '春季', '暑': '暑假', '秋': '秋季', '寒': '寒假' };
            const season = seasonZhMap[rawSeason] || '秋';
            return { year: curYear, season, seasonLabel: seasonLabelMap[season] || season };
        }

        function populateQbankAuditSelects() {
            const curSem = getQbaCurrentSemester();

            const defaultSubjects = ['数学', '英语', '物理', '化学', '语文', '生物'];
            const dimSubjects = (typeof dbFilterOptions !== 'undefined' && Array.isArray(dbFilterOptions.subjects)) ? dbFilterOptions.subjects : [];
            const subjects = [...new Set([...defaultSubjects, ...dimSubjects])].filter(Boolean);

            const defaultGrades = ['七年级先学', '七年级', '八年级', '九年级', '高一先学', '高一', '高二', '高三'];
            const dimGrades = (typeof dbFilterOptions !== 'undefined' && Array.isArray(dbFilterOptions.grades)) ? dbFilterOptions.grades : [];
            const grades = [...new Set([...defaultGrades, ...dimGrades])].filter(Boolean);

            const defaultTiers = ['U', 'S+', 'S', 'A+', 'A'];
            const dimTiers = (typeof dbFilterOptions !== 'undefined' && Array.isArray(dbFilterOptions.tiers)) ? dbFilterOptions.tiers : [];
            const tiers = [...new Set([...defaultTiers, ...dimTiers])].filter(Boolean);

            const teachers = (typeof dbFilterOptions !== 'undefined' && Array.isArray(dbFilterOptions.teachers)) ? dbFilterOptions.teachers : [];

            const fillSelect = (id, allLabel, items, formatLabel) => {
                const el = document.getElementById(id);
                if (!el) return;
                const prev = el.value;
                el.innerHTML = `<option value="">${escapeHtml(allLabel)}</option>` + items.map((v) => {
                    const val = typeof v === 'object' ? v.value : v;
                    const label = typeof v === 'object' ? v.label : (formatLabel ? formatLabel(v) : v);
                    return `<option value="${escapeHtml(val)}">${escapeHtml(label)}</option>`;
                }).join('');
                if (prev && items.some((v) => (typeof v === 'object' ? v.value : v) === prev)) {
                    el.value = prev;
                }
            };

            const setLockedSelect = (id, val, label) => {
                const el = document.getElementById(id);
                if (!el) return;
                el.innerHTML = `<option value="${escapeHtml(val)}">${escapeHtml(label)}</option>`;
                el.value = val;
            };

            setLockedSelect('qba-mat-year', curSem.year, `${curSem.year} 年`);
            setLockedSelect('qba-tl-year', curSem.year, `${curSem.year} 年`);
            setLockedSelect('qba-mat-season', curSem.season, curSem.seasonLabel);
            setLockedSelect('qba-tl-season', curSem.season, curSem.seasonLabel);
            fillSelect('qba-mat-subject', '全部学科', subjects);
            fillSelect('qba-tl-subject', '全部学科', subjects);
            fillSelect('qba-mat-grade', '全部年级', grades);
            fillSelect('qba-tl-grade', '全部年级', grades);
            fillSelect('qba-tl-tier', '全部班层', tiers, (t) => `${t}层`);

            const weekOpts = [];
            for (let w = 1; w <= 20; w++) {
                weekOpts.push({ value: String(w), label: `第 ${w} 周/讲` });
            }
            fillSelect('qba-tl-week', '全部周次', weekOpts);

            const teacherOpts = teachers.map((t) => ({
                value: t.username,
                label: t.real_name ? `${t.real_name} (${t.username})` : t.username
            }));
            fillSelect('qba-tl-teacher-select', '全部教师', teacherOpts);
        }

        function syncQbaSelectOptionsFromMatrix(items) {
            if (!Array.isArray(items) || items.length === 0) return;
            const appendUnique = (selectId, values, formatLabel) => {
                const el = document.getElementById(selectId);
                if (!el) return;
                const existing = new Set(Array.from(el.options).map((o) => o.value));
                values.forEach((raw) => {
                    const v = raw !== undefined && raw !== null ? String(raw).trim() : '';
                    if (!v || existing.has(v)) return;
                    existing.add(v);
                    const opt = document.createElement('option');
                    opt.value = v;
                    opt.textContent = formatLabel ? formatLabel(v) : v;
                    el.appendChild(opt);
                });
            };
            const subjects = [...new Set(items.map((i) => i.subject).filter(Boolean))];
            const grades = [...new Set(items.map((i) => i.grade).filter(Boolean))];
            const tiers = [...new Set(items.map((i) => i.tier).filter(Boolean))];

            appendUnique('qba-mat-subject', subjects);
            appendUnique('qba-tl-subject', subjects);
            appendUnique('qba-mat-grade', grades);
            appendUnique('qba-tl-grade', grades);
            appendUnique('qba-tl-tier', tiers, (t) => `${t}层`);
        }

        function switchQbankAuditView(mode) {
            qbaViewMode = ['both', 'matrix', 'timeline'].includes(mode) ? mode : 'both';
            applyQbankAuditViewMode();
        }

        function applyQbankAuditViewMode() {
            const matSec = document.getElementById('qba-matrix-section');
            const tlSec = document.getElementById('qba-timeline-section');
            const matWrap = document.getElementById('qba-matrix-table-wrapper');
            const btnBoth = document.getElementById('qba-view-btn-both');
            const btnMat = document.getElementById('qba-view-btn-matrix');
            const btnTl = document.getElementById('qba-view-btn-timeline');

            if (matSec) matSec.style.display = (qbaViewMode === 'timeline') ? 'none' : 'block';
            if (tlSec) tlSec.style.display = (qbaViewMode === 'matrix') ? 'none' : 'block';
            if (matWrap) {
                matWrap.style.maxHeight = (qbaViewMode === 'both') ? '420px' : 'none';
            }

            if (btnBoth) btnBoth.className = qbaViewMode === 'both' ? 'btn primary' : 'btn secondary';
            if (btnMat) btnMat.className = qbaViewMode === 'matrix' ? 'btn primary' : 'btn secondary';
            if (btnTl) btnTl.className = qbaViewMode === 'timeline' ? 'btn primary' : 'btn secondary';
        }

        /* ========================================================
           1. Matrix Overview (qbank_matrix)
           ======================================================== */
        function debounceQbaMatrixSearch() {
            clearTimeout(qbaMatrixSearchTimer);
            qbaMatrixSearchTimer = setTimeout(() => {
                renderQbankMatrixTable();
            }, 220);
        }

        function resetQbankMatrixFilters() {
            const curSem = getQbaCurrentSemester();
            const yearEl = document.getElementById('qba-mat-year');
            const seasonEl = document.getElementById('qba-mat-season');
            if (yearEl) yearEl.value = curSem.year;
            if (seasonEl) seasonEl.value = curSem.season;
            ['qba-mat-bank-type', 'qba-mat-subject', 'qba-mat-grade', 'qba-mat-search'].forEach((id) => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
            loadQbankMatrix();
        }

        function updateQbankMatrixResetBtn() {
            const hasFilter = Boolean(
                document.getElementById('qba-mat-bank-type')?.value ||
                document.getElementById('qba-mat-subject')?.value ||
                document.getElementById('qba-mat-grade')?.value ||
                document.getElementById('qba-mat-search')?.value.trim()
            );
            const btn = document.getElementById('qba-mat-reset-btn');
            if (btn) btn.style.display = hasFilter ? 'inline-flex' : 'none';
        }

        async function loadQbankMatrix() {
            const tbody = document.getElementById('qba-matrix-tbody');
            updateQbankMatrixResetBtn();
            if (tbody) {
                tbody.innerHTML = '<tr><td colspan="9" class="table-empty"><div class="empty-state"><span>正在加载配置回执总览...</span></div></td></tr>';
            }

            const params = new URLSearchParams({ action: 'qbank_matrix' });
            const year = document.getElementById('qba-mat-year')?.value || '';
            const season = document.getElementById('qba-mat-season')?.value || '';
            const bankType = document.getElementById('qba-mat-bank-type')?.value || '';
            const subject = document.getElementById('qba-mat-subject')?.value || '';
            const grade = document.getElementById('qba-mat-grade')?.value || '';

            params.append('year', year);
            params.append('season', season);
            params.append('bank_type', bankType);
            params.append('subject', subject);
            params.append('grade', grade);

            try {
                const res = await fetch(`${API_BASE}?${params.toString()}`);
                const json = await res.json();
                if (!json.success) {
                    throw new Error(json.error || '加载配置回执总览失败');
                }
                const items = Array.isArray(json.data?.items)
                    ? json.data.items
                    : (Array.isArray(json.data) ? json.data : []);
                qbaMatrixItems = items;
                syncQbaSelectOptionsFromMatrix(items);

                const navBadge = document.getElementById('nav-qbank-audit-badge');
                const matBadge = document.getElementById('qba-matrix-count-badge');
                if (navBadge) navBadge.textContent = `${items.length} 项`;
                if (matBadge) matBadge.textContent = String(items.length);

                renderQbankMatrixTable();
            } catch (err) {
                if (tbody) {
                    tbody.innerHTML = `<tr><td colspan="9" class="table-empty"><div class="empty-state"><span style="color:var(--error);">${escapeHtml(err?.message || '网络请求失败')}</span></div></td></tr>`;
                }
            }
        }

        function renderQbankMatrixTable() {
            const tbody = document.getElementById('qba-matrix-tbody');
            const summaryEl = document.getElementById('qba-matrix-summary');
            if (!tbody) return;
            updateQbankMatrixResetBtn();

            const kw = (document.getElementById('qba-mat-search')?.value || '').trim().toLowerCase();
            const indexed = qbaMatrixItems.map((item, idx) => ({ item, idx })).filter(({ item }) => {
                if (!kw) return true;
                const hay = [
                    item.latest_receipt_code,
                    item.bank_type,
                    qbaBankLabel(item.bank_type),
                    item.year,
                    item.season,
                    item.subject,
                    item.grade,
                    item.tier,
                    item.week ? `第${item.week}` : '',
                    item.updated_by,
                    item.updated_by_name,
                    item.last_action
                ].join(' ').toLowerCase();
                return hay.includes(kw);
            });

            if (summaryEl) {
                summaryEl.textContent = kw
                    ? `筛选命中 ${indexed.length} / ${qbaMatrixItems.length} 个已配置专题`
                    : `共 ${qbaMatrixItems.length} 个已配置专题（点击行可联动查看下方时间线）`;
            }

            if (indexed.length === 0) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="9" class="table-empty">
                            <div class="empty-state">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                                </svg>
                                <span>暂无匹配的题库配置存证记录</span>
                            </div>
                        </td>
                    </tr>
                `;
                return;
            }

            tbody.innerHTML = indexed.map(({ item, idx }) => {
                const unit = qbaSeasonUnit(item.season);
                const code = item.latest_receipt_code || '';
                const evMeta = QBA_EVENT_META[item.last_action] || { label: item.last_action || '-', cls: 'info' };
                const revNo = item.latest_revision_no ? `v${item.latest_revision_no}` : '-';
                const updater = item.updated_by_name
                    ? `${item.updated_by_name} (${item.updated_by || '-'})`
                    : (item.updated_by || '-');

                return `
                    <tr data-qba-matrix-row="${idx}" style="cursor:pointer;" title="点击联动筛选下方操作复盘时间线">
                        <td style="white-space:nowrap;">
                            <div style="font-weight:600; color:var(--text-primary);">${escapeHtml(item.year || '-')} 年 · ${escapeHtml(item.season || '-')}</div>
                            <div style="font-size:0.75rem; color:var(--text-muted);">${escapeHtml(qbaBankLabel(item.bank_type))}</div>
                        </td>
                        <td style="white-space:nowrap;">
                            <div style="font-weight:600; color:var(--text-primary);">${escapeHtml(item.subject || '-')} · ${escapeHtml(item.grade || '-')}</div>
                            <div style="font-size:0.75rem; color:var(--text-secondary);">${escapeHtml(item.tier || '-')}层 · 第 ${escapeHtml(item.week ?? '-')} ${unit}</div>
                        </td>
                        <td style="white-space:nowrap;">
                            ${code ? `
                                <div style="display:inline-flex; align-items:center; gap:6px;">
                                    <button type="button" class="token-pill" data-qba-copy="${escapeHtml(code)}" title="点击复制回执编号">${escapeHtml(code)}</button>
                                    <a href="verify-qbank.html?code=${encodeURIComponent(code)}" target="_blank" rel="noopener noreferrer" class="btn-action detail" title="在新窗口打开公开核验页">核验 ↗</a>
                                </div>
                            ` : '<span style="color:var(--text-muted); font-size:0.78rem;">历史未存证</span>'}
                        </td>
                        <td style="white-space:nowrap;">
                            <span class="action-tag ${evMeta.cls}">${escapeHtml(revNo)} · ${escapeHtml(evMeta.label)}</span>
                        </td>
                        <td class="cell-mono" style="text-align:center; font-weight:600; color:var(--text-primary);">${escapeHtml(item.question_count ?? 0)}</td>
                        <td class="cell-mono" style="text-align:center; white-space:nowrap;">
                            <span style="color:var(--primary); font-weight:600;">${escapeHtml(item.revision_count ?? 0)}</span> 版 /
                            <span style="color:var(--text-secondary);">${escapeHtml(item.attempt_count ?? 0)}</span> 次
                        </td>
                        <td style="white-space:nowrap; font-size:0.82rem; color:var(--text-primary);">${escapeHtml(updater)}</td>
                        <td class="cell-mono" style="white-space:nowrap; font-size:0.8rem; color:var(--text-secondary);">${formatTimestamp(item.updated_at)}</td>
                        <td style="text-align:right; white-space:nowrap;">
                            <button type="button" class="btn-action edit" data-qba-rev-idx="${idx}" title="查看该专题历史版本链">历史</button>
                            <button type="button" class="btn-action detail" data-qba-jump-idx="${idx}" title="在下方时间线中筛选此专题">时间线</button>
                        </td>
                    </tr>
                `;
            }).join('');
        }

        /* ========================================================
           2. Matrix -> Timeline Link
           ======================================================== */
        function jumpToTimelineFromMatrixItem(item) {
            if (!item) return;
            qbaTlLinkedScope = {
                bank_type: item.bank_type || '',
                year: item.year || '',
                season: item.season || '',
                subject: item.subject || '',
                grade: item.grade || '',
                tier: item.tier || '',
                week: item.week || ''
            };

            const setVal = (id, val) => {
                const el = document.getElementById(id);
                if (!el) return;
                const s = val !== undefined && val !== null ? String(val) : '';
                if (s && el.tagName === 'SELECT' && !Array.from(el.options).some((o) => o.value === s)) {
                    const opt = document.createElement('option');
                    opt.value = s;
                    opt.textContent = s;
                    el.appendChild(opt);
                }
                el.value = s;
            };

            setVal('qba-tl-year', item.year);
            setVal('qba-tl-season', item.season);
            setVal('qba-tl-bank-type', item.bank_type);
            setVal('qba-tl-subject', item.subject);
            setVal('qba-tl-grade', item.grade);
            setVal('qba-tl-tier', item.tier);
            setVal('qba-tl-week', item.week);

            renderQbankLinkedScopeBanner();

            if (qbaViewMode === 'matrix') {
                switchQbankAuditView('both');
            }
            loadQbankTimeline(1);

            const tlSection = document.getElementById('qba-timeline-section');
            if (tlSection && typeof tlSection.scrollIntoView === 'function') {
                tlSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
            const unit = qbaSeasonUnit(item.season);
            showToast(`已联动筛选时间线：${item.subject} · ${item.grade} · ${item.tier}层 · 第${item.week}${unit}`, 'info', 2200);
        }

        function clearQbankLinkedScope() {
            qbaTlLinkedScope = null;
            const curSem = getQbaCurrentSemester();
            const yearEl = document.getElementById('qba-tl-year');
            const seasonEl = document.getElementById('qba-tl-season');
            if (yearEl) yearEl.value = curSem.year;
            if (seasonEl) seasonEl.value = curSem.season;
            ['qba-tl-bank-type', 'qba-tl-subject', 'qba-tl-grade', 'qba-tl-tier', 'qba-tl-week'].forEach((id) => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
            renderQbankLinkedScopeBanner();
            loadQbankTimeline(1);
        }

        function renderQbankLinkedScopeBanner() {
            const bar = document.getElementById('qba-linked-scope-bar');
            const textEl = document.getElementById('qba-linked-scope-text');
            if (!bar || !textEl) return;
            if (!qbaTlLinkedScope) {
                bar.style.display = 'none';
                return;
            }
            const s = qbaTlLinkedScope;
            const unit = qbaSeasonUnit(s.season);
            textEl.textContent = `${s.year || '-'}年${s.season || '-'} · ${qbaBankLabel(s.bank_type)} · ${s.subject || '-'} · ${s.grade || '-'} · ${s.tier || '-'}层 · 第${s.week ?? '-'}${unit}`;
            bar.style.display = 'flex';
        }

        /* ========================================================
           3. Revisions History Modal (qbank_revisions)
           ======================================================== */
        async function openQbankRevisionsModal(scope) {
            qbaRevModalScope = scope;
            const modal = document.getElementById('qba-revisions-modal');
            const titleEl = document.getElementById('qba-rev-modal-title');
            const bodyEl = document.getElementById('qba-rev-modal-body');
            if (!modal || !bodyEl) return;

            const unit = qbaSeasonUnit(scope.season);
            if (titleEl) {
                titleEl.textContent = `历史存证版本链：${scope.year || '-'}年${scope.season || '-'} · ${qbaBankLabel(scope.bank_type)} · ${scope.subject || '-'} · ${scope.grade || '-'} · ${scope.tier || '-'}层 · 第${scope.week ?? '-'}${unit}`;
            }
            bodyEl.innerHTML = '<div style="padding:28px; text-align:center; color:var(--text-muted);">正在加载历史存证版本...</div>';

            if (window.DialogHelper) {
                window.DialogHelper.open(modal, { dismissible: true });
            } else {
                modal.style.display = 'flex';
            }

            const params = new URLSearchParams({ action: 'qbank_revisions' });
            if (scope.year) params.append('year', scope.year);
            if (scope.season) params.append('season', scope.season);
            if (scope.bank_type) params.append('bank_type', scope.bank_type);
            if (scope.subject) params.append('subject', scope.subject);
            if (scope.grade) params.append('grade', scope.grade);
            if (scope.tier) params.append('tier', scope.tier);
            if (scope.week) params.append('week', scope.week);

            try {
                const res = await fetch(`${API_BASE}?${params.toString()}`);
                const json = await res.json();
                if (!json.success) {
                    throw new Error(json.error || '加载历史版本失败');
                }
                const list = Array.isArray(json.data)
                    ? json.data
                    : (Array.isArray(json.data?.items) ? json.data.items : (Array.isArray(json.data?.revisions) ? json.data.revisions : []));

                if (list.length === 0) {
                    bodyEl.innerHTML = '<div class="empty-state" style="padding:36px 16px;"><span>该专题暂无存证版本记录</span></div>';
                    return;
                }

                bodyEl.innerHTML = `
                    <div class="table-wrapper" style="border:1px solid var(--border-color); border-radius:var(--radius-md);">
                        <table class="data-table">
                            <thead>
                                <tr>
                                    <th>版本</th>
                                    <th>动作</th>
                                    <th>回执编号</th>
                                    <th style="text-align:center;">题数</th>
                                    <th>操作教师</th>
                                    <th>签发时间</th>
                                    <th>内容指纹</th>
                                    <th style="text-align:right;">核验</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${list.map((rev) => {
                                    const code = rev.receipt_code || '';
                                    const actMeta = QBA_EVENT_META[rev.action] || { label: rev.action || '-', cls: 'info' };
                                    const op = rev.operator_name ? `${rev.operator_name} (${rev.operator || '-'})` : (rev.operator || '-');
                                    const shaShort = rev.content_sha256 ? `${String(rev.content_sha256).slice(0, 12)}...` : '-';
                                    return `
                                        <tr>
                                            <td class="cell-mono" style="font-weight:600;">v${escapeHtml(rev.revision_no ?? '-')}</td>
                                            <td><span class="action-tag ${actMeta.cls}">${escapeHtml(actMeta.label)}</span></td>
                                            <td>
                                                ${code ? `<button type="button" class="token-pill" data-qba-copy="${escapeHtml(code)}" title="复制回执号">${escapeHtml(code)}</button>` : '-'}
                                            </td>
                                            <td class="cell-mono" style="text-align:center;">${escapeHtml(rev.question_count ?? '-')}</td>
                                            <td style="white-space:nowrap;">${escapeHtml(op)}</td>
                                            <td class="cell-mono" style="white-space:nowrap; font-size:0.78rem;">${escapeHtml(rev.issued_at_cst || formatTimestamp(rev.created_at))}</td>
                                            <td class="cell-mono" style="font-size:0.76rem;" title="${escapeHtml(rev.content_sha256 || '')}">${escapeHtml(shaShort)}</td>
                                            <td style="text-align:right; white-space:nowrap;">
                                                ${code ? `
                                                    <div style="display:inline-flex; gap:6px; align-items:center;">
                                                        <button type="button" class="btn-action edit" data-qba-rollback-code="${escapeHtml(code)}" data-qba-rollback-rev="${escapeHtml(rev.revision_no ?? '-')}">回滚到此版本</button>
                                                        <a href="verify-qbank.html?code=${encodeURIComponent(code)}" target="_blank" rel="noopener noreferrer" class="btn-action detail">核验 ↗</a>
                                                    </div>
                                                ` : '-'}
                                            </td>
                                        </tr>
                                    `;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                `;
            } catch (err) {
                bodyEl.innerHTML = `<div style="padding:24px; text-align:center; color:var(--error);">${escapeHtml(err?.message || '网络请求失败')}</div>`;
            }
        }

        function closeQbankRevisionsModal() {
            const modal = document.getElementById('qba-revisions-modal');
            if (!modal) return;
            if (window.DialogHelper) {
                window.DialogHelper.close(modal);
            } else {
                modal.style.display = 'none';
            }
        }

        /* ========================================================
           4. Teacher Operation Timeline (qbank_timeline)
           ======================================================== */
        function onQbaTeacherSelectChange(val) {
            const input = document.getElementById('qba-tl-operator');
            if (input) input.value = val || '';
            loadQbankTimeline(1);
        }

        function debounceQbaTimelineSearch() {
            clearTimeout(qbaTlSearchTimer);
            qbaTlSearchTimer = setTimeout(() => {
                const selectEl = document.getElementById('qba-tl-teacher-select');
                const inputVal = (document.getElementById('qba-tl-operator')?.value || '').trim();
                if (selectEl) {
                    const matched = Array.from(selectEl.options).some((o) => o.value === inputVal);
                    selectEl.value = matched ? inputVal : '';
                }
                loadQbankTimeline(1);
            }, 280);
        }

        function changeQbaTimelinePageSize(val) {
            qbaTlPageSize = parseInt(val, 10) || 20;
            loadQbankTimeline(1);
        }

        function resetQbankTimelineFilters() {
            qbaTlLinkedScope = null;
            const curSem = getQbaCurrentSemester();
            const yearEl = document.getElementById('qba-tl-year');
            const seasonEl = document.getElementById('qba-tl-season');
            if (yearEl) yearEl.value = curSem.year;
            if (seasonEl) seasonEl.value = curSem.season;
            [
                'qba-tl-teacher-select', 'qba-tl-operator', 'qba-tl-event-type',
                'qba-tl-bank-type',
                'qba-tl-subject', 'qba-tl-grade', 'qba-tl-tier', 'qba-tl-week',
                'qba-tl-date-from', 'qba-tl-date-to'
            ].forEach((id) => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
            renderQbankLinkedScopeBanner();
            loadQbankTimeline(1);
        }

        async function loadQbankTimeline(page = 1) {
            qbaTlPage = page;
            const listEl = document.getElementById('qba-timeline-list');
            if (listEl) {
                listEl.innerHTML = '<div style="padding:36px; text-align:center; color:var(--text-muted);">正在加载教师操作复盘时间线...</div>';
            }

            const params = new URLSearchParams({
                action: 'qbank_timeline',
                page: String(qbaTlPage),
                page_size: String(qbaTlPageSize)
            });

            const operator = (document.getElementById('qba-tl-operator')?.value || '').trim()
                || (document.getElementById('qba-tl-teacher-select')?.value || '').trim();
            const eventType = document.getElementById('qba-tl-event-type')?.value || '';
            const year = document.getElementById('qba-tl-year')?.value || '';
            const season = document.getElementById('qba-tl-season')?.value || '';
            const bankType = document.getElementById('qba-tl-bank-type')?.value || '';
            const subject = document.getElementById('qba-tl-subject')?.value || '';
            const grade = document.getElementById('qba-tl-grade')?.value || '';
            const tier = document.getElementById('qba-tl-tier')?.value || '';
            const week = document.getElementById('qba-tl-week')?.value || '';
            const dateFrom = document.getElementById('qba-tl-date-from')?.value || '';
            const dateTo = document.getElementById('qba-tl-date-to')?.value || '';

            params.append('operator', operator);
            params.append('event_type', eventType);
            params.append('year', year);
            params.append('season', season);
            if (bankType) params.append('bank_type', bankType);
            params.append('subject', subject);
            params.append('grade', grade);
            params.append('tier', tier);
            params.append('week', week);
            params.append('date_from', dateFrom);
            params.append('date_to', dateTo);

            try {
                const res = await fetch(`${API_BASE}?${params.toString()}`);
                const json = await res.json();
                if (!json.success || !json.data) {
                    throw new Error(json.error || '加载操作复盘时间线失败');
                }
                const d = json.data;
                qbaTlItems = Array.isArray(d.items) ? d.items : [];
                qbaTlTotal = Number(d.total ?? qbaTlItems.length);
                const actualPage = Number(d.page || qbaTlPage);
                const actualSize = Number(d.page_size || qbaTlPageSize);

                renderQbankTimelineStats(d.stats || {});
                renderQbankTimelineItems(qbaTlItems);
                renderQbankTimelinePagination(actualPage, actualSize, qbaTlTotal);

                const tlBadge = document.getElementById('qba-timeline-count-badge');
                if (tlBadge) tlBadge.textContent = String(qbaTlTotal);
            } catch (err) {
                if (listEl) {
                    listEl.innerHTML = `<div style="padding:36px; text-align:center; color:var(--error);">${escapeHtml(err?.message || '网络请求失败')}</div>`;
                }
                const pag = document.getElementById('qba-timeline-pagination');
                if (pag) pag.innerHTML = '';
            }
        }

        function renderQbankTimelineStats(stats) {
            const setNum = (id, val) => {
                const el = document.getElementById(id);
                if (el) el.textContent = String(val ?? 0);
            };
            setNum('qba-stat-revisions', stats.revisions ?? 0);
            setNum('qba-stat-uploads', stats.uploads ?? 0);
            setNum('qba-stat-blocked', stats.blocked_or_failed ?? 0);
            setNum('qba-stat-cancelled', stats.cancelled ?? 0);
        }

        function renderQbankTimelineItems(items) {
            const listEl = document.getElementById('qba-timeline-list');
            if (!listEl) return;

            if (!items || items.length === 0) {
                listEl.innerHTML = `
                    <div class="empty-state" style="padding:48px 16px;">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <circle cx="12" cy="12" r="10"></circle>
                            <polyline points="12 6 12 12 16 14"></polyline>
                        </svg>
                        <span>未检索到匹配的教师操作复盘记录</span>
                    </div>
                `;
                return;
            }

            listEl.innerHTML = items.map((item, idx) => {
                const isRevision = item.source === 'revision';
                const evKey = item.event_type || (isRevision ? 'update' : 'upload_pdf');
                const evMeta = QBA_EVENT_META[evKey] || { label: evKey, cls: 'info', color: 'var(--primary)' };
                const unit = qbaSeasonUnit(item.season);
                const scopeParts = [
                    item.year ? `${item.year}年${item.season || ''}` : '',
                    item.bank_type ? qbaBankLabel(item.bank_type) : '',
                    item.subject || '',
                    item.grade || '',
                    item.tier ? `${item.tier}层` : '',
                    item.week ? `第${item.week}${unit}` : ''
                ].filter(Boolean);

                const opText = item.operator_name
                    ? `${item.operator_name} (${item.operator || '-'})`
                    : (item.operator || '未知账号');

                const detailObj = {};
                if (item.file_name) detailObj.file_name = item.file_name;
                if (item.file_sha256) detailObj.file_sha256 = item.file_sha256;
                if (item.reason) detailObj.reason = item.reason;
                if (item.client_ip) detailObj.client_ip = item.client_ip;
                if (item.details !== undefined && item.details !== null && item.details !== '') {
                    detailObj.details = item.details;
                }
                const hasDetails = Object.keys(detailObj).length > 0;
                const detailBoxId = `qba-tl-detail-${idx}`;
                const formattedDetails = hasDetails ? JSON.stringify(detailObj, null, 2) : '';

                return `
                    <div style="padding:14px 16px; border-bottom:1px solid var(--border-color); display:flex; gap:14px; align-items:flex-start;">
                        <div style="width:10px; height:10px; border-radius:50%; margin-top:6px; flex-shrink:0; background:${evMeta.color};"></div>
                        <div style="flex:1; min-width:0; display:flex; flex-direction:column; gap:6px;">
                            <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px;">
                                <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                                    <span class="action-tag ${evMeta.cls}" style="font-weight:600;">${escapeHtml(evMeta.label)}</span>
                                    <span style="font-size:0.74rem; padding:2px 7px; border-radius:4px; background:var(--bg-subtle); border:1px solid var(--border-color); color:var(--text-secondary); font-family:var(--font-mono);">
                                        ${isRevision ? `存证台账 · v${escapeHtml(item.revision_no ?? '-')}` : `过程日志 · ${escapeHtml(item.event_type || '-')}`}
                                    </span>
                                    ${item.receipt_code ? `
                                        <button type="button" class="token-pill" data-qba-copy="${escapeHtml(item.receipt_code)}" title="点击复制回执编号">${escapeHtml(item.receipt_code)}</button>
                                        <a href="verify-qbank.html?code=${encodeURIComponent(item.receipt_code)}" target="_blank" rel="noopener noreferrer" class="btn-action detail">核验 ↗</a>
                                    ` : ''}
                                    ${isRevision ? `<button type="button" class="btn-action edit" data-qba-tl-rev-idx="${idx}">历史版本</button>` : ''}
                                </div>
                                <span class="cell-mono" style="font-size:0.78rem; color:var(--text-muted);">${escapeHtml(formatTimestamp(item.created_at))}</span>
                            </div>

                            <div style="display:flex; align-items:center; flex-wrap:wrap; gap:10px; font-size:0.84rem; color:var(--text-primary);">
                                <span style="font-weight:600;">${escapeHtml(scopeParts.join(' · ') || '未指定教学专题')}</span>
                                ${isRevision && item.question_count !== undefined && item.question_count !== null ? `<span style="color:var(--text-secondary);">· ${escapeHtml(item.question_count)} 题</span>` : ''}
                                <span style="color:var(--text-muted);">|</span>
                                <span>操作人：<b style="color:var(--text-primary);">${escapeHtml(opText)}</b></span>
                                ${item.client_ip ? `<span class="cell-mono" style="font-size:0.76rem; color:var(--text-muted);">IP: ${escapeHtml(item.client_ip)}</span>` : ''}
                            </div>

                            ${item.reason ? `
                                <div style="font-size:0.82rem; color:var(--text-secondary); background:var(--bg-subtle); padding:6px 10px; border-radius:var(--radius-sm); border-left:3px solid ${evMeta.color};">
                                    原因 / 说明：${escapeHtml(item.reason)}
                                </div>
                            ` : ''}

                            ${(item.file_name || item.file_sha256) ? `
                                <div style="display:flex; align-items:center; flex-wrap:wrap; gap:8px; font-size:0.78rem; color:var(--text-secondary);">
                                    ${item.file_name ? `<span>文件：<b>${escapeHtml(item.file_name)}</b></span>` : ''}
                                    ${item.file_sha256 ? `<span class="cell-mono" style="background:var(--bg-subtle); padding:2px 6px; border-radius:4px; border:1px solid var(--border-color);" title="${escapeHtml(item.file_sha256)}">SHA-256: ${escapeHtml(String(item.file_sha256).slice(0, 16))}...</span>` : ''}
                                </div>
                            ` : ''}

                            ${hasDetails ? `
                                <div>
                                    <button type="button" class="btn-action" data-qba-detail-toggle="${detailBoxId}">展开详情 / SHA-256</button>
                                    <div id="${detailBoxId}" style="display:none; margin-top:8px;">
                                        <div style="display:flex; justify-content:flex-end; margin-bottom:4px;">
                                            <button type="button" class="btn-action" data-qba-copy="${escapeHtml(formattedDetails)}" data-qba-copy-msg="已复制详情 JSON">复制详情 JSON</button>
                                        </div>
                                        <pre class="cell-mono" style="margin:0; padding:10px 12px; border-radius:var(--radius-sm); background:var(--bg-subtle); border:1px solid var(--border-color); font-size:0.76rem; line-height:1.45; white-space:pre-wrap; word-break:break-all; max-height:240px; overflow:auto; color:var(--text-primary);">${escapeHtml(formattedDetails)}</pre>
                                    </div>
                                </div>
                            ` : ''}
                        </div>
                    </div>
                `;
            }).join('');
        }

        function renderQbankTimelinePagination(page, pageSize, total) {
            const container = document.getElementById('qba-timeline-pagination');
            if (!container) return;
            const totalPages = Math.max(1, Math.ceil((total || 0) / Math.max(1, pageSize)));
            if (total <= 0) {
                container.innerHTML = '';
                return;
            }
            container.innerHTML = `
                <div style="font-size:0.86rem; color:var(--text-secondary);">
                    共 <b style="color: var(--text-primary);">${total}</b> 条操作事件 · 第 <b style="color:var(--primary);">${page}</b> / ${totalPages} 页
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    <button type="button" class="page-btn" ${page > 1 ? `data-qba-page="${page - 1}"` : 'disabled'}>上一页</button>
                    <span style="font-size:0.86rem; font-weight:600; color: var(--text-primary); padding:0 6px;">${page}</span>
                    <button type="button" class="page-btn" ${page < totalPages ? `data-qba-page="${page + 1}"` : 'disabled'}>下一页</button>
                </div>
            `;
        }
