// ========== Whole-Paper Region-Crop Studio (Debug) ==========
// 免切题分页：直接上传整卷原卷 PDF（单栏），逐题拉框标注，支持大题（先原文后小问）、
// 跨页续框、预习跳题手动输题号、举一反三归属原题选择、以及答案独立拉框。

(function () {
    const FULL_WIDTH_X = 0.03;
    const FULL_WIDTH_W = 0.94;

    const isCoarsePointer = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

    const rgState = {
        initialized: false,
        contextKey: '',
        stage: 'upload', // 'upload' | 'exercise' | 'answer'
        activeTab: 'exercise',
        fullWidth: true,
        interactMode: 'draw', // 'draw' | 'pan'
        twoTapMode: isCoarsePointer,
        twoTapStart: null, // { pageOffset, x, y }
        scale: 1.0,
        continueTargetId: null,
        selectedId: null,
        subMode: null, // { tab, itemId, target: 'stem' | 'subq' }
        drag: null,
        nextSeq: 1,
        exercise: {
            file: null,
            pdfDoc: null,
            pageNum: 1,
            totalPages: 0,
            items: []
        },
        answer: {
            file: null,
            pdfDoc: null,
            pageNum: 1,
            totalPages: 0,
            items: []
        }
    };

    function getTabState(tab = rgState.activeTab) {
        return tab === 'answer' ? rgState.answer : rgState.exercise;
    }

    function escapeHtmlRg(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function getCurrentBankTypeSafe() {
        return typeof getBankType === 'function' ? getBankType() : 'homework';
    }

    function getNextAutoNumber(tab) {
        const items = getTabState(tab).items;
        let maxNum = 0;
        items.forEach(it => {
            const n = parseInt(it.label, 10);
            if (!isNaN(n) && n > maxNum) maxNum = n;
            if (it.isBig && Array.isArray(it.subqBoxes)) {
                it.subqBoxes.forEach(sb => {
                    const sn = parseInt(sb.num, 10);
                    if (!isNaN(sn) && sn > maxNum) maxNum = sn;
                });
            }
        });
        return String(maxNum + 1);
    }

    function getVariationParentOptions() {
        const buckets = typeof getConsolidationBuckets === 'function'
            ? getConsolidationBuckets()
            : [];
        if (Array.isArray(buckets) && buckets.length > 0) {
            return buckets.map(b => {
                const pNum = parseInt(b.parentNum ?? b.id, 10);
                const nums = Array.isArray(b.nums) && b.nums.length > 0
                    ? b.nums
                    : (pNum > 0 ? [pNum] : []);
                const label = b.label || (nums.length > 0 ? ('第' + nums.join('、') + '题') : '');
                return nums.length > 0 ? { nums, label } : null;
            }).filter(Boolean);
        }
        const list = Array.isArray(homeworkQuestionsForVariation) ? homeworkQuestionsForVariation : [];
        return list.map(q => {
            const n = parseInt(q.question_num || q.id, 10);
            return n > 0 ? { nums: [n], label: '第' + n + '题' } : null;
        }).filter(Boolean);
    }

    function formatItemTitle(it, tab) {
        const bankType = getCurrentBankTypeSafe();
        if (bankType === 'variation') {
            if (tab === 'answer') {
                const exItem = rgState.exercise.items.find(x => x.id === it.targetExId);
                if (exItem) {
                    const compact = typeof formatCompactNumList === 'function'
                        ? formatCompactNumList(exItem.parentNums)
                        : (exItem.parentNums || []).join('、');
                    return `答案 · 原题${compact || '?'}`;
                }
                return '答案（未绑定题目）';
            }
            if (Array.isArray(it.parentNums) && it.parentNums.length > 0) {
                const compact = typeof formatCompactNumList === 'function'
                    ? formatCompactNumList(it.parentNums)
                    : it.parentNums.join('、');
                return '原题' + compact + ' · 举一反三';
            }
            return '举一反三（未选原题）';
        }
        if (it.isBig && Array.isArray(it.subqBoxes) && it.subqBoxes.length > 0) {
            const nums = it.subqBoxes.map(b => parseInt(b.num, 10)).filter(n => !isNaN(n)).sort((a, b) => a - b);
            if (nums.length > 1) return `第 ${nums[0]}~${nums[nums.length - 1]} 题（大题）`;
            if (nums.length === 1) return `第 ${nums[0]} 题（大题）`;
        }
        if (it.label) return `第 ${it.label} 题`;
        return '待输入题号';
    }

    function syncInteractModeUi() {
        const stage = document.getElementById('rg-stage');
        const modeBtn = document.getElementById('rg-interact-mode-btn');
        const twoTapBtn = document.getElementById('rg-twotap-btn');
        const isDraw = rgState.interactMode === 'draw';
        if (stage) {
            stage.classList.toggle('draw-mode', isDraw);
            stage.classList.toggle('pan-mode', !isDraw);
        }
        if (modeBtn) {
            modeBtn.classList.toggle('active', isDraw);
            modeBtn.textContent = isDraw ? '模式: 拉框' : '模式: 浏览滚动';
        }
        if (twoTapBtn) {
            twoTapBtn.classList.toggle('active', Boolean(rgState.twoTapMode));
            twoTapBtn.textContent = rgState.twoTapMode ? '两点定框: 开' : '两点定框: 关';
        }
    }

    function bindCanvasEventsOnce() {
        if (rgState.initialized) return;
        rgState.initialized = true;
        syncInteractModeUi();

        const stage = document.getElementById('rg-stage');
        const layer = document.getElementById('rg-box-layer');
        if (!stage || !layer) return;

        const getNormPoint = (e) => {
            const rect = stage.getBoundingClientRect();
            const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
            const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
            return { x, y };
        };

        const cleanupDraft = () => {
            if (!rgState.drag) return null;
            const d = rgState.drag;
            rgState.drag = null;
            if (d.draftEl && d.draftEl.parentNode) {
                d.draftEl.parentNode.removeChild(d.draftEl);
            }
            return d;
        };

        stage.addEventListener('pointerdown', (e) => {
            if (rgState.interactMode !== 'draw') return;
            if (e.isPrimary === false) return;
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            const tabState = getTabState();
            if (!tabState.pdfDoc) return;
            if (document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('rg-num-input')) {
                document.activeElement.blur();
            }
            e.preventDefault();
            try { stage.setPointerCapture(e.pointerId); } catch (_) {}
            const pt = getNormPoint(e);
            const draftEl = document.createElement('div');
            draftEl.className = 'rg-box draft';
            layer.appendChild(draftEl);
            rgState.drag = { pointerId: e.pointerId, startX: pt.x, startY: pt.y, curX: pt.x, curY: pt.y, draftEl };
        });

        stage.addEventListener('pointermove', (e) => {
            if (!rgState.drag || rgState.drag.pointerId !== e.pointerId) return;
            const pt = getNormPoint(e);
            rgState.drag.curX = pt.x;
            rgState.drag.curY = pt.y;
            let x = Math.min(rgState.drag.startX, pt.x);
            let w = Math.abs(pt.x - rgState.drag.startX);
            if (rgState.fullWidth) {
                x = FULL_WIDTH_X;
                w = FULL_WIDTH_W;
            }
            const y = Math.min(rgState.drag.startY, pt.y);
            const h = Math.abs(pt.y - rgState.drag.startY);
            const el = rgState.drag.draftEl;
            el.style.left = (x * 100) + '%';
            el.style.top = (y * 100) + '%';
            el.style.width = (w * 100) + '%';
            el.style.height = (h * 100) + '%';
        });

        const finishPointer = (e) => {
            if (!rgState.drag || rgState.drag.pointerId !== e.pointerId) return;
            const d = cleanupDraft();
            if (!d) return;

            const tab = rgState.activeTab;
            const tabState = getTabState(tab);
            const pageOffset = tabState.pageNum - 1;
            const dx = Math.abs(d.curX - d.startX);
            const dy = Math.abs(d.curY - d.startY);

            // 手机端两点定框：点一次上边界，再点一次下边界成框
            if (rgState.twoTapMode && dy < 0.015 && (rgState.fullWidth || dx < 0.015)) {
                if (!rgState.twoTapStart || rgState.twoTapStart.pageOffset !== pageOffset) {
                    rgState.twoTapStart = { pageOffset, x: d.curX, y: d.curY };
                    renderBoxOverlay();
                    return;
                }
                const start = rgState.twoTapStart;
                rgState.twoTapStart = null;
                const y = Math.min(start.y, d.curY);
                const h = Math.abs(d.curY - start.y);
                if (h < 0.01) {
                    renderBoxOverlay();
                    return;
                }
                const x = rgState.fullWidth ? FULL_WIDTH_X : Math.min(start.x, d.curX);
                const w = rgState.fullWidth ? FULL_WIDTH_W : Math.max(0.05, Math.abs(d.curX - start.x));
                onBoxDrawn(tab, {
                    pageOffset,
                    x: Number(x.toFixed(4)),
                    y: Number(y.toFixed(4)),
                    w: Number(w.toFixed(4)),
                    h: Number(h.toFixed(4))
                });
                return;
            }

            let x = Math.min(d.startX, d.curX);
            let w = dx;
            const y = Math.min(d.startY, d.curY);
            const h = dy;

            if (h < 0.015 || (!rgState.fullWidth && w < 0.015)) {
                return;
            }
            if (rgState.fullWidth) {
                x = FULL_WIDTH_X;
                w = FULL_WIDTH_W;
            }

            rgState.twoTapStart = null;
            onBoxDrawn(tab, {
                pageOffset,
                x: Number(x.toFixed(4)),
                y: Number(y.toFixed(4)),
                w: Number(w.toFixed(4)),
                h: Number(h.toFixed(4))
            });
        };

        stage.addEventListener('pointerup', finishPointer);
        stage.addEventListener('pointercancel', () => cleanupDraft());
    }

    function onBoxDrawn(tab, rectObj) {
        const tabState = getTabState(tab);

        // 1. 大题内部细分模式（先原文后小问）
        if (rgState.subMode && rgState.subMode.tab === tab) {
            const parentItem = tabState.items.find(it => it.id === rgState.subMode.itemId);
            if (!parentItem) {
                rgState.subMode = null;
                renderAllRg();
                return;
            }
            if (rgState.subMode.target === 'stem') {
                parentItem.stemBoxes = parentItem.stemBoxes || [];
                parentItem.stemBoxes.push(rectObj);
            } else {
                parentItem.subqBoxes = parentItem.subqBoxes || [];
                const baseNum = parseInt(parentItem.label, 10) || 1;
                const nextSubNum = parentItem.subqBoxes.length === 0
                    ? baseNum
                    : (Math.max(...parentItem.subqBoxes.map(b => parseInt(b.num, 10) || baseNum)) + 1);
                parentItem.subqBoxes.push({ ...rectObj, num: nextSubNum });
            }
            renderAllRg();
            return;
        }

        // 2. 跨页续框模式
        if (rgState.continueTargetId) {
            const targetItem = tabState.items.find(it => it.id === rgState.continueTargetId);
            rgState.continueTargetId = null;
            if (targetItem) {
                targetItem.regions.push(rectObj);
                rgState.selectedId = targetItem.id;
                renderAllRg();
                return;
            }
        }

        // 3. 新建一题 / 一条答案框
        const bankType = getCurrentBankTypeSafe();
        let label = '';
        let targetExId = null;
        if (bankType === 'homework') {
            label = getNextAutoNumber(tab);
        } else if (bankType === 'variation') {
            if (tab === 'answer') {
                const boundIds = new Set(tabState.items.map(x => x.targetExId).filter(Boolean));
                const nextUnboundEx = rgState.exercise.items.find(ex => !boundIds.has(ex.id))
                    || rgState.exercise.items[tabState.items.length]
                    || null;
                targetExId = nextUnboundEx ? nextUnboundEx.id : null;
            }
        } else {
            // preview：不自动标号，手动输入跳题题号
            label = '';
        }

        const newItem = {
            id: `${tab}_${rgState.nextSeq++}`,
            label,
            targetExId,
            parentNums: [],
            isBig: false,
            regions: [rectObj],
            stemBoxes: [],
            subqBoxes: []
        };
        tabState.items.push(newItem);
        rgState.selectedId = newItem.id;
        renderAllRg();

        if (bankType === 'preview' || (bankType === 'variation' && tab === 'answer')) {
            requestAnimationFrame(() => {
                const input = document.querySelector(`.rg-card[data-id="${newItem.id}"] .rg-num-input`);
                if (input) {
                    input.focus();
                    input.select();
                }
            });
        }
    }

    async function renderPdfPage() {
        const tabState = getTabState();
        const emptyEl = document.getElementById('rg-empty-state');
        const stageEl = document.getElementById('rg-stage');
        const canvas = document.getElementById('rg-pdf-canvas');
        const pageInfo = document.getElementById('rg-page-info');
        const prevBtn = document.getElementById('rg-prev-page');
        const nextBtn = document.getElementById('rg-next-page');
        const zoomVal = document.getElementById('rg-zoom-val');

        if (zoomVal) zoomVal.textContent = Math.round(rgState.scale * 100) + '%';

        if (!tabState.pdfDoc) {
            if (emptyEl) emptyEl.style.display = 'block';
            if (stageEl) stageEl.style.display = 'none';
            if (pageInfo) pageInfo.textContent = '0 / 0 页';
            if (prevBtn) prevBtn.disabled = true;
            if (nextBtn) nextBtn.disabled = true;
            return;
        }

        if (emptyEl) emptyEl.style.display = 'none';
        if (stageEl) stageEl.style.display = 'inline-block';

        const page = await tabState.pdfDoc.getPage(tabState.pageNum);
        const viewport = page.getViewport({ scale: 1.35 * rgState.scale });
        const ctx = canvas.getContext('2d');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        await page.render({ canvasContext: ctx, viewport }).promise;

        if (pageInfo) pageInfo.textContent = `${tabState.pageNum} / ${tabState.totalPages} 页`;
        if (prevBtn) prevBtn.disabled = tabState.pageNum <= 1;
        if (nextBtn) nextBtn.disabled = tabState.pageNum >= tabState.totalPages;

        renderBoxOverlay();
    }

    function renderBoxOverlay() {
        const layer = document.getElementById('rg-box-layer');
        if (!layer) return;
        const tab = rgState.activeTab;
        const tabState = getTabState(tab);
        const pageOffset = tabState.pageNum - 1;
        layer.innerHTML = '';

        if (rgState.twoTapStart && rgState.twoTapStart.pageOffset === pageOffset) {
            const line = document.createElement('div');
            line.className = 'rg-anchor-line';
            line.style.top = (rgState.twoTapStart.y * 100) + '%';
            const lbl = document.createElement('span');
            lbl.className = 'rg-anchor-label';
            lbl.textContent = '上边界已定，请点下边界';
            line.appendChild(lbl);
            layer.appendChild(line);
        }

        tabState.items.forEach(it => {
            it.regions.forEach((rg, rIdx) => {
                if (rg.pageOffset !== pageOffset) return;
                const div = document.createElement('div');
                const nearTopCls = rg.y < 0.03 ? ' near-top' : '';
                div.className = `rg-box ${tab === 'answer' ? 'answer' : ''} ${rgState.selectedId === it.id ? 'active' : ''}${nearTopCls}`;
                div.style.left = (rg.x * 100) + '%';
                div.style.top = (rg.y * 100) + '%';
                div.style.width = (rg.w * 100) + '%';
                div.style.height = (rg.h * 100) + '%';

                const tag = document.createElement('span');
                tag.className = 'rg-box-tag';
                const suffix = it.regions.length > 1 ? ` (${rIdx + 1}/${it.regions.length})` : '';
                tag.textContent = formatItemTitle(it, tab) + suffix;
                div.appendChild(tag);

                div.addEventListener('mousedown', (e) => e.stopPropagation());
                div.addEventListener('click', (e) => {
                    e.stopPropagation();
                    rgState.selectedId = it.id;
                    renderAllRg();
                });
                layer.appendChild(div);
            });

            if (it.isBig) {
                (it.stemBoxes || []).forEach((sb, sIdx) => {
                    if (sb.pageOffset !== pageOffset) return;
                    const div = document.createElement('div');
                    div.className = 'rg-box stem';
                    div.style.left = (sb.x * 100) + '%';
                    div.style.top = (sb.y * 100) + '%';
                    div.style.width = (sb.w * 100) + '%';
                    div.style.height = (sb.h * 100) + '%';
                    const tag = document.createElement('span');
                    tag.className = 'rg-box-tag';
                    tag.textContent = `原文${sIdx + 1}`;
                    div.appendChild(tag);
                    layer.appendChild(div);
                });
                (it.subqBoxes || []).forEach((qb) => {
                    if (qb.pageOffset !== pageOffset) return;
                    const div = document.createElement('div');
                    div.className = 'rg-box subq';
                    div.style.left = (qb.x * 100) + '%';
                    div.style.top = (qb.y * 100) + '%';
                    div.style.width = (qb.w * 100) + '%';
                    div.style.height = (qb.h * 100) + '%';
                    const tag = document.createElement('span');
                    tag.className = 'rg-box-tag';
                    tag.textContent = `${qb.num}`;
                    div.appendChild(tag);
                    layer.appendChild(div);
                });
            }
        });
    }

    function renderSidebar() {
        const tab = rgState.activeTab;
        const tabState = getTabState(tab);
        const bankType = getCurrentBankTypeSafe();
        const listEl = document.getElementById('rg-list');
        const titleEl = document.getElementById('rg-sidebar-title');
        const tipEl = document.getElementById('rg-sidebar-tip');
        const contBanner = document.getElementById('rg-continue-banner');
        const contText = document.getElementById('rg-continue-text');
        const finishBtn = document.getElementById('rg-finish-btn');

        if (titleEl) {
            titleEl.textContent = tab === 'answer'
                ? `已框答案（${tabState.items.length}）`
                : `已框题目（${tabState.items.length}）`;
        }
        if (tipEl) {
            if (tab === 'answer') {
                tipEl.textContent = '答案独立拉框，仅按题号匹配题目';
            } else if (bankType === 'preview') {
                tipEl.textContent = '预习模式：框完后请手动输入跳题题号';
            } else if (bankType === 'variation') {
                tipEl.textContent = '举一反三模式：框完后请勾选对应原题';
            } else {
                tipEl.textContent = '课后巩固：自动递增题号，支持设为大题';
            }
        }
        if (finishBtn) {
            finishBtn.disabled = rgState.exercise.items.length === 0;
        }

        if (contBanner && contText) {
            if (rgState.continueTargetId) {
                const target = tabState.items.find(it => it.id === rgState.continueTargetId);
                contBanner.style.display = 'flex';
                contText.textContent = `正在为「${target ? formatItemTitle(target, tab) : '当前题'}」追加跨页区域：请翻页后拉框`;
            } else {
                contBanner.style.display = 'none';
            }
        }

        if (!listEl) return;
        if (tabState.items.length === 0) {
            listEl.innerHTML = '<div class="rg-list-empty">暂无框选区域，请在左侧画布按住左键拖拽拉框</div>';
            return;
        }

        const varOptions = (bankType === 'variation' && tab === 'exercise') ? getVariationParentOptions() : [];

        listEl.innerHTML = tabState.items.map((it) => {
            const pages = Array.from(new Set(it.regions.map(r => 'P' + (r.pageOffset + 1)))).join(', ');
            const isActive = rgState.selectedId === it.id;
            const bigSubmetaHtml = it.isBig
                ? `<div class="rg-card-submeta">大题 · 原文 ${(it.stemBoxes || []).length} / 小问 ${(it.subqBoxes || []).length}</div>`
                : '';

            let headerEditorHtml = '';
            if (bankType === 'variation' && tab === 'exercise') {
                const chipsHtml = varOptions.length > 0
                    ? varOptions.map(opt => {
                        const selected = opt.nums.every(n => (it.parentNums || []).includes(n));
                        const primaryP = opt.nums[0];
                        return `<span class="rg-var-chip-group"><button type="button" class="rg-var-chip ${selected ? 'selected' : ''}" onclick="rgToggleVarParent('${it.id}', '${opt.nums.join(',')}')">${escapeHtmlRg(opt.label)}</button><button type="button" class="rg-var-preview-btn" onclick="event.stopPropagation(); if (typeof previewHomeworkQuestion === 'function') previewHomeworkQuestion(${primaryP}, event)" title="预览课后第 ${primaryP} 题原题">预览</button></span>`;
                    }).join('')
                    : '<span class="rg-card-meta">暂无课后巩固原题，可直接输入归属题号</span>';
                headerEditorHtml = `
                    <div class="rg-card-top">
                        <span class="rg-card-num-wrap">${escapeHtmlRg(formatItemTitle(it, tab))}</span>
                        <span class="rg-card-meta">${escapeHtmlRg(pages)}</span>
                    </div>
                    <div class="rg-var-parents">${chipsHtml}</div>
                `;
            } else if (bankType === 'variation' && tab === 'answer') {
                const exChips = rgState.exercise.items.map((ex, idx) => {
                    const compact = typeof formatCompactNumList === 'function'
                        ? formatCompactNumList(ex.parentNums)
                        : (ex.parentNums || []).join('、');
                    const selected = it.targetExId === ex.id;
                    return `<button type="button" class="rg-var-chip ${selected ? 'selected' : ''}" onclick="rgBindAnswerToExercise('${it.id}', '${ex.id}')">第${idx + 1}框·原题${escapeHtmlRg(compact)}</button>`;
                }).join('');
                headerEditorHtml = `
                    <div class="rg-card-top">
                        <span class="rg-card-num-wrap">${escapeHtmlRg(formatItemTitle(it, tab))}</span>
                        <span class="rg-card-meta">${escapeHtmlRg(pages)}</span>
                    </div>
                    <div class="rg-var-parents">${exChips}</div>
                `;
            } else {
                const placeholder = bankType === 'preview' ? '输题号' : '题号';
                headerEditorHtml = `
                    <div class="rg-card-top">
                        <div class="rg-card-num-wrap">
                            <span>${it.isBig ? '起始题号' : '题号'}</span>
                            <input type="text" class="rg-num-input" value="${escapeHtmlRg(it.label)}" placeholder="${placeholder}"
                                oninput="rgUpdateItemLabel('${it.id}', this.value)" onchange="rgUpdateItemLabel('${it.id}', this.value)" onclick="event.stopPropagation()">
                        </div>
                        <span class="rg-card-meta">${escapeHtmlRg(pages)}</span>
                    </div>
                    ${bigSubmetaHtml}
                `;
            }

            return `
                <div class="rg-card ${isActive ? 'active' : ''}" data-id="${it.id}" onclick="rgSelectItem('${it.id}')">
                    ${headerEditorHtml}
                    <div class="rg-card-actions" onclick="event.stopPropagation()">
                        <button type="button" class="btn sm secondary" onclick="rgStartContinue('${it.id}')">+ 跨页续框</button>
                        ${bankType === 'variation' ? '' : `<button type="button" class="btn sm secondary" onclick="rgEnterSubMode('${it.id}')">${it.isBig ? '继续细分大题' : '设为大题'}</button>`}
                        <button type="button" class="btn sm secondary" onclick="rgDeleteItem('${it.id}')">删除</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    function renderSubModeBar() {
        const bar = document.getElementById('rg-submode-bar');
        const badge = document.getElementById('rg-submode-badge');
        const stemBtn = document.getElementById('rg-subtarget-stem');
        const subqBtn = document.getElementById('rg-subtarget-subq');
        const hint = document.getElementById('rg-submode-hint');
        if (!bar) return;

        if (!rgState.subMode || rgState.subMode.tab !== rgState.activeTab) {
            bar.style.display = 'none';
            return;
        }
        const tabState = getTabState(rgState.subMode.tab);
        const it = tabState.items.find(x => x.id === rgState.subMode.itemId);
        if (!it) {
            rgState.subMode = null;
            bar.style.display = 'none';
            return;
        }
        bar.style.display = 'flex';
        if (badge) badge.textContent = `大题细分：${formatItemTitle(it, rgState.subMode.tab)}`;
        if (stemBtn) stemBtn.classList.toggle('active', rgState.subMode.target === 'stem');
        if (subqBtn) {
            subqBtn.classList.toggle('active', rgState.subMode.target === 'subq');
            subqBtn.classList.toggle('subq', rgState.subMode.target === 'subq');
        }
        if (hint) {
            hint.textContent = rgState.subMode.target === 'stem'
                ? '当前：绿虚线框选公共原文/题干，完成后切换“2. 框选小问”'
                : '当前：红框依次框出各小问（自动递增小问题号）';
        }
    }

    function syncStageUi() {
        const st = rgState.stage;
        const gate = document.getElementById('rg-upload-gate');
        const ws = document.getElementById('rg-workspace');
        const pillUp = document.getElementById('rg-step-pill-upload');
        const pillEx = document.getElementById('rg-step-pill-exercise');
        const pillAn = document.getElementById('rg-step-pill-answer');
        const prevBtn = document.getElementById('rg-prev-stage-btn');
        const nextBtn = document.getElementById('rg-next-stage-btn');
        const finishBtn = document.getElementById('rg-finish-btn');
        const exBox = document.getElementById('rg-exercise-upload-box');
        const ansBox = document.getElementById('rg-answer-upload-box');

        if (exBox) exBox.classList.toggle('uploaded', Boolean(rgState.exercise.pdfDoc));
        if (ansBox) ansBox.classList.toggle('uploaded', Boolean(rgState.answer.pdfDoc));

        if (gate) gate.style.display = st === 'upload' ? 'block' : 'none';
        if (ws) ws.style.display = st === 'upload' ? 'none' : 'grid';

        if (pillUp) {
            pillUp.classList.toggle('active', st === 'upload');
            pillUp.classList.toggle('done', st !== 'upload');
        }
        if (pillEx) {
            pillEx.classList.toggle('active', st === 'exercise');
            pillEx.classList.toggle('done', st === 'answer');
        }
        if (pillAn) {
            pillAn.classList.toggle('active', st === 'answer');
        }

        if (prevBtn) {
            if (st === 'upload') {
                prevBtn.style.display = 'none';
            } else if (st === 'exercise') {
                prevBtn.style.display = 'inline-flex';
                prevBtn.textContent = '← 重新上传 PDF';
            } else {
                prevBtn.style.display = 'inline-flex';
                prevBtn.textContent = '← 返回修改题目框选';
            }
        }

        if (nextBtn) {
            if (st === 'upload') {
                nextBtn.style.display = 'inline-flex';
                nextBtn.textContent = '开始框选题目 PDF →';
                nextBtn.disabled = !(rgState.exercise.pdfDoc && rgState.answer.pdfDoc);
            } else if (st === 'exercise') {
                nextBtn.style.display = 'inline-flex';
                nextBtn.textContent = '题目已框完，下一步：框选答案 PDF →';
                nextBtn.disabled = rgState.exercise.items.length === 0;
            } else {
                nextBtn.style.display = 'none';
            }
        }

        if (finishBtn) {
            finishBtn.style.display = st === 'answer' ? 'inline-flex' : 'none';
            finishBtn.disabled = rgState.answer.items.length === 0;
        }
    }

    function renderAllRg() {
        syncStageUi();
        renderSubModeBar();
        renderSidebar();
        renderBoxOverlay();
    }

    window.openRegionDebugStudio = async function () {
        if (window.currentUser && window.currentUser.role === 'assistant') {
            showToast('助教账号仅具备查看权限，无法录入或上传题目', 'warn');
            return;
        }
        if (!subjectSelect || !subjectSelect.value || !gradeSelect || !gradeSelect.value || !tierSelect || !tierSelect.value || !weekSelect || !weekSelect.value) {
            showToast('请先选齐学科、年级、班层与专题', 'warn');
            return;
        }
        await loadCurrentData();
        if (getCurrentBankTypeSafe() === 'variation' && typeof loadHomeworkQuestionsForVariation === 'function') {
            await loadHomeworkQuestionsForVariation();
        }

        const newContextKey = [
            getCurrentBankTypeSafe(),
            typeof getSelectedYear === 'function' ? getSelectedYear() : '',
            typeof getSelectedSeason === 'function' ? getSelectedSeason() : '',
            subjectSelect.value,
            gradeSelect.value,
            tierSelect.value,
            weekSelect.value
        ].join('|');

        if (rgState.contextKey && rgState.contextKey !== newContextKey) {
            rgState.exercise = { file: null, pdfDoc: null, pageNum: 1, totalPages: 0, items: [] };
            rgState.answer = { file: null, pdfDoc: null, pageNum: 1, totalPages: 0, items: [] };
            rgState.selectedId = null;
            rgState.continueTargetId = null;
            rgState.subMode = null;
            rgState.twoTapStart = null;
            rgState.stage = 'upload';
            rgState.activeTab = 'exercise';
            const exLbl = document.getElementById('rg-exercise-file-label');
            const ansLbl = document.getElementById('rg-answer-file-label');
            if (exLbl) exLbl.textContent = '点击选择单栏题目原卷 PDF';
            if (ansLbl) ansLbl.textContent = '点击选择答案原卷 PDF';
        }
        rgState.contextKey = newContextKey;

        const ctxEl = document.getElementById('rg-context-line');
        if (ctxEl) {
            const typeLabel = typeof getBankTypeLabel === 'function' ? getBankTypeLabel(getCurrentBankTypeSafe()) : getCurrentBankTypeSafe();
            const topicLabel = typeof getTopicLabel === 'function' ? getTopicLabel(weekSelect.value) : weekSelect.value;
            ctxEl.textContent = `${typeLabel} · ${subjectSelect.value} · ${gradeSelect.value} · ${tierSelect.value} · ${topicLabel}`;
        }

        bindCanvasEventsOnce();
        goToStep('debug');
        renderAllRg();
        await renderPdfPage();
    };

    window.exitRegionDebugStudio = function () {
        rgState.subMode = null;
        rgState.continueTargetId = null;
        goToStep(1);
    };

    window.rgGoNextStage = async function () {
        if (rgState.stage === 'upload') {
            if (!rgState.exercise.pdfDoc || !rgState.answer.pdfDoc) {
                showToast('请先上传题目 PDF 和答案 PDF', 'warn');
                return;
            }
            rgState.stage = 'exercise';
            rgState.activeTab = 'exercise';
            rgState.continueTargetId = null;
            rgState.subMode = null;
            rgState.twoTapStart = null;
            renderAllRg();
            await renderPdfPage();
            return;
        }
        if (rgState.stage === 'exercise') {
            const exItems = rgState.exercise.items;
            if (exItems.length === 0) {
                showToast('请先框选至少一道题目', 'warn');
                return;
            }
            const bankType = getCurrentBankTypeSafe();
            if (bankType === 'preview') {
                const missing = exItems.find(it => !String(it.label || '').trim());
                if (missing) {
                    showToast('预习模式请先为每道框选题目输入题号', 'warn');
                    rgSelectItem(missing.id);
                    return;
                }
            }
            if (bankType === 'variation') {
                const missing = exItems.find(it => !Array.isArray(it.parentNums) || it.parentNums.length === 0);
                if (missing) {
                    showToast('举一反三模式请先为每道题勾选对应的原题', 'warn');
                    rgSelectItem(missing.id);
                    return;
                }
            }
            rgState.stage = 'answer';
            rgState.activeTab = 'answer';
            rgState.continueTargetId = null;
            rgState.subMode = null;
            rgState.twoTapStart = null;
            renderAllRg();
            await renderPdfPage();
        }
    };

    window.rgGoPrevStage = async function () {
        rgState.continueTargetId = null;
        rgState.subMode = null;
        rgState.twoTapStart = null;
        if (rgState.stage === 'answer') {
            rgState.stage = 'exercise';
            rgState.activeTab = 'exercise';
            renderAllRg();
            await renderPdfPage();
            return;
        }
        if (rgState.stage === 'exercise') {
            rgState.stage = 'upload';
            renderAllRg();
        }
    };

    window.rgHandlePdfUpload = async function (tab, inputEl) {
        const file = inputEl && inputEl.files && inputEl.files[0];
        if (!file) return;
        try {
            const buf = await file.arrayBuffer();
            const pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
            const tabState = getTabState(tab);
            tabState.file = file;
            tabState.pdfDoc = pdfDoc;
            tabState.pageNum = 1;
            tabState.totalPages = pdfDoc.numPages;
            tabState.items = [];
            rgState.continueTargetId = null;
            rgState.subMode = null;
            rgState.twoTapStart = null;

            const lbl = document.getElementById(tab === 'answer' ? 'rg-answer-file-label' : 'rg-exercise-file-label');
            if (lbl) lbl.textContent = `${file.name} (${pdfDoc.numPages} 页)`;

            syncStageUi();
            if (rgState.stage !== 'upload' && rgState.activeTab === tab) {
                renderAllRg();
                await renderPdfPage();
            }
            showToast(`已加载${tab === 'answer' ? '答案' : '题目'} PDF（${pdfDoc.numPages} 页）`);
        } catch (err) {
            console.error('Debug PDF load error:', err);
            showToast('PDF 解析失败：' + (err.message || '未知错误'), 'error');
        } finally {
            inputEl.value = '';
        }
    };

    window.rgToggleFullWidth = function (checked) {
        rgState.fullWidth = Boolean(checked);
    };

    window.rgToggleInteractMode = function () {
        rgState.interactMode = rgState.interactMode === 'draw' ? 'pan' : 'draw';
        rgState.twoTapStart = null;
        syncInteractModeUi();
        renderBoxOverlay();
    };

    window.rgToggleTwoTapMode = function () {
        rgState.twoTapMode = !rgState.twoTapMode;
        rgState.twoTapStart = null;
        if (rgState.twoTapMode && rgState.interactMode !== 'draw') {
            rgState.interactMode = 'draw';
        }
        syncInteractModeUi();
        renderBoxOverlay();
    };

    window.rgChangePage = async function (delta) {
        const tabState = getTabState();
        if (!tabState.pdfDoc) return;
        const next = Math.max(1, Math.min(tabState.totalPages, tabState.pageNum + delta));
        if (next === tabState.pageNum) return;
        tabState.pageNum = next;
        rgState.twoTapStart = null;
        await renderPdfPage();
    };

    window.rgZoom = async function (delta) {
        rgState.scale = Math.max(0.5, Math.min(2.2, Number((rgState.scale + delta).toFixed(2))));
        await renderPdfPage();
    };

    window.rgUndoLastRegion = function () {
        const tab = rgState.activeTab;
        const tabState = getTabState(tab);
        if (rgState.subMode && rgState.subMode.tab === tab) {
            rgUndoSubBox();
            return;
        }
        if (tabState.items.length === 0) return;
        const last = tabState.items[tabState.items.length - 1];
        if (last.regions.length > 1) {
            last.regions.pop();
        } else {
            tabState.items.pop();
        }
        renderAllRg();
    };

    window.rgSelectItem = async function (itemId) {
        const tabState = getTabState();
        const it = tabState.items.find(x => x.id === itemId);
        if (!it) return;
        rgState.selectedId = itemId;
        if (it.regions.length > 0) {
            const targetPage = it.regions[0].pageOffset + 1;
            if (tabState.pageNum !== targetPage) {
                tabState.pageNum = targetPage;
                await renderPdfPage();
                renderSidebar();
                return;
            }
        }
        renderAllRg();
    };

    window.rgUpdateItemLabel = function (itemId, val) {
        const tabState = getTabState();
        const it = tabState.items.find(x => x.id === itemId);
        if (!it) return;
        it.label = String(val || '').trim();
        if (it.isBig && Array.isArray(it.subqBoxes) && it.subqBoxes.length > 0) {
            const base = parseInt(it.label, 10);
            if (!isNaN(base) && base > 0) {
                it.subqBoxes.forEach((sb, idx) => {
                    sb.num = base + idx;
                });
            }
        }
        renderBoxOverlay();
        syncStageUi();
    };

    window.rgBindAnswerToExercise = function (ansItemId, exItemId) {
        const it = rgState.answer.items.find(x => x.id === ansItemId);
        if (!it) return;
        it.targetExId = exItemId;
        renderAllRg();
    };

    window.rgToggleVarParent = function (itemId, numsCsv) {
        const tabState = getTabState();
        const it = tabState.items.find(x => x.id === itemId);
        if (!it) return;
        const nums = numsCsv.split(',').map(n => parseInt(n, 10)).filter(n => !isNaN(n) && n > 0);
        it.parentNums = it.parentNums || [];
        const allSelected = nums.every(n => it.parentNums.includes(n));
        if (allSelected) {
            it.parentNums = it.parentNums.filter(n => !nums.includes(n));
        } else {
            nums.forEach(n => {
                if (!it.parentNums.includes(n)) it.parentNums.push(n);
            });
            it.parentNums.sort((a, b) => a - b);
        }
        renderAllRg();
    };

    window.rgStartContinue = function (itemId) {
        rgState.continueTargetId = itemId;
        rgState.selectedId = itemId;
        renderSidebar();
    };

    window.rgCancelContinue = function () {
        rgState.continueTargetId = null;
        renderSidebar();
    };

    window.rgEnterSubMode = async function (itemId) {
        const tab = rgState.activeTab;
        const tabState = getTabState(tab);
        const it = tabState.items.find(x => x.id === itemId);
        if (!it) return;
        it.isBig = true;
        it.stemBoxes = it.stemBoxes || [];
        it.subqBoxes = it.subqBoxes || [];
        rgState.subMode = {
            tab,
            itemId,
            target: it.stemBoxes.length === 0 ? 'stem' : 'subq'
        };
        rgState.selectedId = itemId;
        if (it.regions.length > 0) {
            tabState.pageNum = it.regions[0].pageOffset + 1;
            await renderPdfPage();
        }
        renderAllRg();
    };

    window.rgSetSubDrawTarget = function (target) {
        if (!rgState.subMode) return;
        rgState.subMode.target = target === 'subq' ? 'subq' : 'stem';
        renderSubModeBar();
    };

    window.rgUndoSubBox = function () {
        if (!rgState.subMode) return;
        const tabState = getTabState(rgState.subMode.tab);
        const it = tabState.items.find(x => x.id === rgState.subMode.itemId);
        if (!it) return;
        if (rgState.subMode.target === 'stem' && it.stemBoxes.length > 0) {
            it.stemBoxes.pop();
        } else if (rgState.subMode.target === 'subq' && it.subqBoxes.length > 0) {
            it.subqBoxes.pop();
        }
        renderAllRg();
    };

    window.rgExitSubMode = function () {
        rgState.subMode = null;
        renderAllRg();
    };

    window.rgDeleteItem = function (itemId) {
        const tabState = getTabState();
        tabState.items = tabState.items.filter(x => x.id !== itemId);
        if (rgState.selectedId === itemId) rgState.selectedId = null;
        if (rgState.continueTargetId === itemId) rgState.continueTargetId = null;
        if (rgState.subMode && rgState.subMode.itemId === itemId) rgState.subMode = null;
        renderAllRg();
    };

    async function generateRegionCropThumb(pdfDoc, region, pageCanvasCache) {
        if (!pdfDoc || !region) return null;
        try {
            const pageNum = Math.min(pdfDoc.numPages, Math.max(1, (parseInt(region.pageOffset, 10) || 0) + 1));
            let srcCanvas = pageCanvasCache.get(pageNum);
            if (!srcCanvas) {
                const page = await pdfDoc.getPage(pageNum);
                const viewport = page.getViewport({ scale: 1.0 });
                srcCanvas = document.createElement('canvas');
                srcCanvas.width = Math.round(viewport.width);
                srcCanvas.height = Math.round(viewport.height);
                const ctx = srcCanvas.getContext('2d');
                await page.render({ canvasContext: ctx, viewport }).promise;
                pageCanvasCache.set(pageNum, srcCanvas);
            }
            const sx = Math.max(0, Math.floor((region.x ?? 0) * srcCanvas.width));
            const sy = Math.max(0, Math.floor((region.y ?? 0) * srcCanvas.height));
            const sw = Math.max(12, Math.min(srcCanvas.width - sx, Math.ceil((region.w ?? 1) * srcCanvas.width)));
            const sh = Math.max(12, Math.min(srcCanvas.height - sy, Math.ceil((region.h ?? 1) * srcCanvas.height)));
            const out = document.createElement('canvas');
            const targetW = Math.min(480, sw);
            const scale = targetW / sw;
            out.width = targetW;
            out.height = Math.max(12, Math.round(sh * scale));
            const octx = out.getContext('2d');
            octx.fillStyle = '#ffffff';
            octx.fillRect(0, 0, out.width, out.height);
            octx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
            return out.toDataURL('image/jpeg', 0.82);
        } catch (err) {
            return null;
        }
    }

    window.rgFinishAndImport = async function () {
        const exItems = rgState.exercise.items;
        if (!rgState.exercise.file || exItems.length === 0) {
            showToast('请先上传题目原卷并框选至少一道题', 'warn');
            return;
        }
        if (!rgState.answer.file || rgState.answer.items.length === 0) {
            showToast('答案原卷为必传项，请上传答案原卷并框选各题答案', 'warn');
            return;
        }
        const bankType = getCurrentBankTypeSafe();

        if (bankType === 'preview') {
            const missing = exItems.find(it =>
                !(it.isBig && Array.isArray(it.subqBoxes) && it.subqBoxes.length > 0)
                && !String(it.label || '').trim()
            );
            if (missing) {
                showToast('预习模式请为每道框选题目手动输入题号', 'warn');
                rgSelectItem(missing.id);
                return;
            }
        }
        if (bankType === 'variation') {
            const missing = exItems.find(it => !Array.isArray(it.parentNums) || it.parentNums.length === 0);
            if (missing) {
                showToast('举一反三模式请为每道题勾选对应的原题', 'warn');
                rgSelectItem(missing.id);
                return;
            }
        }

        // 按题号建立独立答案查找表（不与题目排版强绑定），上传 PDF 前先校验匹配
        const ansByNum = new Map();
        const ansSubByNum = new Map();
        rgState.answer.items.forEach(aIt => {
            const lbl = String(aIt.label || '').trim();
            if (lbl) ansByNum.set(lbl, aIt);
            if (aIt.isBig && Array.isArray(aIt.subqBoxes)) {
                aIt.subqBoxes.forEach(sb => {
                    const sn = String(sb.num || '').trim();
                    if (sn) {
                        ansByNum.set(sn, aIt);
                        ansSubByNum.set(sn, sb);
                    }
                });
            }
        });

        const findMatchedAns = (it, qKey, primaryP) => {
            if (bankType === 'variation') {
                return rgState.answer.items.find(a => a.targetExId === it.id)
                    || ansByNum.get(String(primaryP))
                    || ansByNum.get(String(it.label || '').trim())
                    || null;
            }
            if (qKey && ansByNum.has(qKey)) return ansByNum.get(qKey);
            const fallbackLbl = String(it.label || '').trim();
            return (fallbackLbl && ansByNum.get(fallbackLbl)) || null;
        };

        for (const it of exItems) {
            if (bankType === 'variation') {
                const pNums = [...it.parentNums].sort((a, b) => a - b);
                if (!findMatchedAns(it, '', pNums[0])) {
                    showToast(`对应原题第 ${pNums.join(',')} 题的变式尚未匹配到答案框，请在“答案原卷”补充或绑定答案框后再导入`, 'warn');
                    return;
                }
            } else if (it.isBig && Array.isArray(it.subqBoxes) && it.subqBoxes.length > 0) {
                for (const sb of it.subqBoxes) {
                    const qKey = String(sb.num || '').trim();
                    if (!qKey || !findMatchedAns(it, qKey, null)) {
                        showToast(`第 ${qKey || '?'} 题尚未匹配到答案框，请在“答案原卷”补充对应题号答案框后再导入`, 'warn');
                        return;
                    }
                }
            } else {
                const qKey = String(it.label || '').trim();
                if (!findMatchedAns(it, qKey, null)) {
                    showToast(`第 ${qKey || '?'} 题尚未匹配到答案框，请在“答案原卷”补充对应题号答案框后再导入`, 'warn');
                    return;
                }
            }
        }

        const finishBtn = document.getElementById('rg-finish-btn');
        if (finishBtn) {
            finishBtn.disabled = true;
            finishBtn.textContent = '正在上传原卷并导入...';
        }

        try {
            const exUpload = await uploadPdfBlob(rgState.exercise.file);
            const exThumb = typeof generatePdfThumbnailFromFile === 'function'
                ? await generatePdfThumbnailFromFile(rgState.exercise.file)
                : null;
            const exPdfObj = {
                url: exUpload.url,
                name: exUpload.originalName || rgState.exercise.file.name,
                status: 'uploaded',
                thumb: exThumb || null
            };

            let ansPdfObj = null;
            if (rgState.answer.file && rgState.answer.items.length > 0) {
                const ansUpload = await uploadPdfBlob(rgState.answer.file);
                const ansThumb = typeof generatePdfThumbnailFromFile === 'function'
                    ? await generatePdfThumbnailFromFile(rgState.answer.file)
                    : null;
                ansPdfObj = {
                    url: ansUpload.url,
                    name: ansUpload.originalName || rgState.answer.file.name,
                    status: 'uploaded',
                    thumb: ansThumb || null
                };
            }

            const exPageCache = new Map();
            const ansPageCache = new Map();

            const imported = [];
            const varSubCounter = new Map();

            for (const it of exItems) {
                const itemExThumb = (await generateRegionCropThumb(rgState.exercise.pdfDoc, it.regions[0], exPageCache)) || exPdfObj.thumb;

                if (bankType === 'variation') {
                    const pNums = [...it.parentNums].sort((a, b) => a - b);
                    const primaryP = pNums[0];
                    const nextSub = (varSubCounter.get(primaryP) || 0) + 1;
                    varSubCounter.set(primaryP, nextSub);
                    const matchedAns = findMatchedAns(it, '', primaryP);
                    const hwQ = (Array.isArray(homeworkQuestionsForVariation) ? homeworkQuestionsForVariation : [])
                        .find(item => Number(item.id) === Number(primaryP));
                    const inheritedTopic = (hwQ && hwQ.topic) ? String(hwQ.topic).trim() : '';
                    const itemAnsThumb = matchedAns && ansPdfObj
                        ? ((await generateRegionCropThumb(rgState.answer.pdfDoc, matchedAns.regions[0], ansPageCache)) || ansPdfObj.thumb)
                        : null;
                    imported.push({
                        id: String(imported.length + 1),
                        parentQuestionNum: primaryP,
                        parentQuestionNums: pNums,
                        subNum: nextSub,
                        isVariation: true,
                        topic: inheritedTopic,
                        videoUrl: '',
                        exercisePdf: { ...exPdfObj, thumb: itemExThumb },
                        answerPdf: matchedAns && ansPdfObj ? { ...ansPdfObj, thumb: itemAnsThumb } : null,
                        questionMeta: {
                            mode: 'region_crop',
                            regions: it.regions,
                            answerRegions: matchedAns ? matchedAns.regions : [],
                            stemBoxes: it.isBig ? (it.stemBoxes || []) : []
                        }
                    });
                    continue;
                }

                if (it.isBig && Array.isArray(it.subqBoxes) && it.subqBoxes.length > 0) {
                    const groupNums = it.subqBoxes.map(sb => parseInt(sb.num, 10)).filter(n => !isNaN(n)).sort((a, b) => a - b);
                    for (const sb of it.subqBoxes) {
                        const qKey = String(sb.num).trim();
                        const matchedAns = findMatchedAns(it, qKey, null);
                        const matchedAnsSub = ansSubByNum.get(qKey) || null;
                        const subExThumb = (await generateRegionCropThumb(rgState.exercise.pdfDoc, sb, exPageCache)) || itemExThumb;
                        const subAnsRegion = matchedAnsSub || (matchedAns && matchedAns.regions ? matchedAns.regions[0] : null);
                        const itemAnsThumb = matchedAns && ansPdfObj
                            ? ((await generateRegionCropThumb(rgState.answer.pdfDoc, subAnsRegion, ansPageCache)) || ansPdfObj.thumb)
                            : null;
                        imported.push({
                            id: qKey,
                            topic: '',
                            videoUrl: '',
                            exercisePdf: { ...exPdfObj, thumb: subExThumb },
                            answerPdf: matchedAns && ansPdfObj ? { ...ansPdfObj, thumb: itemAnsThumb } : null,
                            questionMeta: {
                                mode: 'region_crop',
                                groupNums,
                                stemBoxes: it.stemBoxes || [],
                                box: sb,
                                answerBox: matchedAnsSub || null,
                                regions: it.regions,
                                answerRegions: matchedAns ? matchedAns.regions : []
                            }
                        });
                    }
                    continue;
                }

                const qKey = String(it.label || '').trim();
                const matchedAns = findMatchedAns(it, qKey, null);
                const itemAnsThumb = matchedAns && ansPdfObj
                    ? ((await generateRegionCropThumb(rgState.answer.pdfDoc, matchedAns.regions[0], ansPageCache)) || ansPdfObj.thumb)
                    : null;
                imported.push({
                    id: qKey,
                    topic: '',
                    videoUrl: '',
                    exercisePdf: { ...exPdfObj, thumb: itemExThumb },
                    answerPdf: matchedAns && ansPdfObj ? { ...ansPdfObj, thumb: itemAnsThumb } : null,
                    questionMeta: {
                        mode: 'region_crop',
                        regions: it.regions,
                        answerRegions: matchedAns ? matchedAns.regions : []
                    }
                });
            }

            if (bankType === 'variation' && typeof recalcVariationSubNums === 'function') {
                recalcVariationSubNums(imported);
            }

            currentQuestions = imported;
            batchImported = true;
            window.rgImportedActive = true;
            isDirty = true;
            rgState.subMode = null;
            rgState.continueTargetId = null;

            if (typeof renderQuestionList === 'function') renderQuestionList();
            if (typeof updateStatus === 'function') updateStatus();
            goToStep(4);
            showToast(`已导入 ${imported.length} 道整卷框选题到第 4 步`);
        } catch (err) {
            if (err && err.unauthorized && typeof handleUnauthorized === 'function') {
                handleUnauthorized();
                return;
            }
            console.error('Region debug import error:', err);
            showToast('导入失败：' + (err.message || '网络异常'), 'error');
        } finally {
            if (finishBtn) {
                finishBtn.disabled = false;
                finishBtn.textContent = '完成框选并导入第 4 步 →';
            }
        }
    };
})();
