// ========== Whole-Paper Region-Crop Studio ==========
// 免切题分页：直接上传整卷原卷 PDF（单栏/双栏），逐题拉框标注，支持大题（先原文后小问）、
// 跨页续框、预习跳题手动输题号、举一反三归属原题选择、答案独立拉框、边框拖拽微调、
// 快捷键、高分屏渲染以及已保存题库反加载调整。

(function () {
    const FULL_WIDTH_X = 0.03;
    const FULL_WIDTH_W = 0.94;
    const DRAFT_DB_NAME = 'qbank_region_drafts';

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
        focusZoom: 1.0,
        focusTwoTapStart: null, // { yPx }
        focusDrag: null,
        focusResize: null,
        focusStitch: null, // { stageEl, layerEl, width, totalH, slices }
        focusPageCache: new Map(),
        focusRenderSeq: 0,
        presetNextLabel: null,
        presetNextTargetExId: null,
        drag: null,
        resize: null,
        nextSeq: 1,
        renderTask: null,
        renderSeq: 0,
        draftTimer: null,
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

    function clamp01(val) {
        return Math.max(0, Math.min(1, Number(val) || 0));
    }

    function round4(val) {
        return Number(clamp01(val).toFixed(4));
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

    // 草稿持久化已关闭：保留空实现以兼容现有调用
    function scheduleDraftSave() {}

    window.rgClearSavedDraft = async function () {};

    function buildContextKeyFromSelectors() {
        return [
            getCurrentBankTypeSafe(),
            typeof getSelectedYear === 'function' ? getSelectedYear() : '',
            typeof getSelectedSeason === 'function' ? getSelectedSeason() : '',
            subjectSelect ? subjectSelect.value : '',
            gradeSelect ? gradeSelect.value : '',
            tierSelect ? tierSelect.value : '',
            weekSelect ? weekSelect.value : ''
        ].join('|');
    }

    function closeFocusDialogSafe() {
        const dlg = document.getElementById('rg-focus-dialog');
        if (dlg && (dlg.open || dlg.classList.contains('active'))) {
            if (typeof closeNativeDialog === 'function') {
                closeNativeDialog(dlg);
            } else if (window.DialogHelper) {
                window.DialogHelper.close(dlg);
            } else {
                dlg.classList.remove('active');
            }
        }
    }

    function resetStudioMemoryState() {
        rgState.exercise = { file: null, pdfDoc: null, pageNum: 1, totalPages: 0, items: [] };
        rgState.answer = { file: null, pdfDoc: null, pageNum: 1, totalPages: 0, items: [] };
        rgState.selectedId = null;
        rgState.continueTargetId = null;
        rgState.subMode = null;
        rgState.focusTwoTapStart = null;
        rgState.focusDrag = null;
        rgState.focusResize = null;
        rgState.focusStitch = null;
        rgState.focusPageCache.clear();
        closeFocusDialogSafe();
        rgState.twoTapStart = null;
        rgState.presetNextLabel = null;
        rgState.presetNextTargetExId = null;
        rgState.stage = 'upload';
        rgState.activeTab = 'exercise';
        rgState.nextSeq = 1;
        const exLbl = document.getElementById('rg-exercise-file-label');
        const ansLbl = document.getElementById('rg-answer-file-label');
        if (exLbl) exLbl.textContent = '必传 · 点击选择单栏题目原卷 PDF';
        if (ansLbl) ansLbl.textContent = '必传 · 点击选择答案原卷 PDF';
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

    function startBoxResize(e, kind, itemId, boxRef, edge, boxEl) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const stage = document.getElementById('rg-stage');
        if (!stage) return;
        const rect = stage.getBoundingClientRect();
        rgState.selectedId = itemId;
        rgState.resize = {
            pointerId: e.pointerId,
            kind,
            itemId,
            boxRef,
            edge,
            boxEl,
            stageRect: rect,
            startClientX: e.clientX,
            startClientY: e.clientY,
            origX: Number(boxRef.x) || 0,
            origY: Number(boxRef.y) || 0,
            origW: Number(boxRef.w) || 0.1,
            origH: Number(boxRef.h) || 0.05
        };
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    }

    function bindCanvasEventsOnce() {
        if (rgState.initialized) return;
        rgState.initialized = true;
        syncInteractModeUi();

        const stage = document.getElementById('rg-stage');
        const layer = document.getElementById('rg-box-layer');
        const viewportEl = document.getElementById('rg-viewport');
        if (!stage || !layer) return;

        const getNormPoint = (e) => {
            const rect = stage.getBoundingClientRect();
            const x = clamp01((e.clientX - rect.left) / Math.max(1, rect.width));
            const y = clamp01((e.clientY - rect.top) / Math.max(1, rect.height));
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
            if (rgState.resize) return;
            if (rgState.interactMode !== 'draw') return;
            if (e.isPrimary === false) return;
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            if (e.target && e.target.closest && (e.target.closest('.rg-handle') || e.target.closest('.rg-box-del'))) {
                return;
            }
            const tabState = getTabState();
            if (!tabState.pdfDoc) return;
            if (document.activeElement && document.activeElement.classList && (
                document.activeElement.classList.contains('rg-num-input') ||
                document.activeElement.classList.contains('rg-subq-num-input')
            )) {
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

        window.addEventListener('pointermove', (e) => {
            if (rgState.resize && rgState.resize.pointerId === e.pointerId) {
                const rz = rgState.resize;
                const dx = (e.clientX - rz.startClientX) / Math.max(1, rz.stageRect.width);
                const dy = (e.clientY - rz.startClientY) / Math.max(1, rz.stageRect.height);
                const minSize = 0.012;
                let nx = rz.origX;
                let ny = rz.origY;
                let nw = rz.origW;
                let nh = rz.origH;

                if (rz.edge === 'n') {
                    const maxTop = rz.origY + rz.origH - minSize;
                    ny = Math.max(0, Math.min(maxTop, rz.origY + dy));
                    nh = rz.origY + rz.origH - ny;
                } else if (rz.edge === 's') {
                    nh = Math.max(minSize, Math.min(1 - rz.origY, rz.origH + dy));
                } else if (rz.edge === 'w') {
                    const maxLeft = rz.origX + rz.origW - minSize;
                    nx = Math.max(0, Math.min(maxLeft, rz.origX + dx));
                    nw = rz.origX + rz.origW - nx;
                } else if (rz.edge === 'e') {
                    nw = Math.max(minSize, Math.min(1 - rz.origX, rz.origW + dx));
                }

                rz.boxRef.x = round4(nx);
                rz.boxRef.y = round4(ny);
                rz.boxRef.w = round4(nw);
                rz.boxRef.h = round4(nh);
                if (rz.boxEl) {
                    rz.boxEl.style.left = (rz.boxRef.x * 100) + '%';
                    rz.boxEl.style.top = (rz.boxRef.y * 100) + '%';
                    rz.boxEl.style.width = (rz.boxRef.w * 100) + '%';
                    rz.boxEl.style.height = (rz.boxRef.h * 100) + '%';
                }
                return;
            }

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
            if (rgState.resize && rgState.resize.pointerId === e.pointerId) {
                rgState.resize = null;
                renderAllRg();
                scheduleDraftSave();
                return;
            }

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
                    x: round4(x),
                    y: round4(y),
                    w: round4(w),
                    h: round4(h)
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
                x: round4(x),
                y: round4(y),
                w: round4(w),
                h: round4(h)
            });
        };

        window.addEventListener('pointerup', finishPointer);
        window.addEventListener('pointercancel', (e) => {
            if (rgState.resize && rgState.resize.pointerId === e.pointerId) {
                rgState.resize = null;
                renderAllRg();
            }
            cleanupDraft();
        });

        // 快捷键与 Ctrl+滚轮缩放
        document.addEventListener('keydown', (e) => {
            const startDlg = document.getElementById('rg-bigq-startnum-dialog');
            const customDlg = document.getElementById('custom-dialog');
            if ((startDlg && (startDlg.open || startDlg.classList.contains('active')))
                || (customDlg && (customDlg.open || customDlg.classList.contains('active')))) {
                return;
            }

            const focusDlg = document.getElementById('rg-focus-dialog');
            const inFocus = Boolean(rgState.subMode && focusDlg && (focusDlg.open || focusDlg.classList.contains('active')));
            const tag = document.activeElement ? document.activeElement.tagName : '';

            if (inFocus) {
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        document.activeElement.blur();
                    }
                    return;
                }
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                    e.preventDefault();
                    rgUndoSubBox();
                    return;
                }
                if (e.key === '1' || e.key === '2') {
                    e.preventDefault();
                    rgSetSubDrawTarget(e.key === '1' ? 'stem' : 'subq');
                    return;
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    if (rgState.focusTwoTapStart) {
                        rgState.focusTwoTapStart = null;
                        renderFocusSliceOverlays();
                    } else {
                        rgRequestExitSubMode();
                    }
                }
                return;
            }

            const panel = document.getElementById('step-debug');
            if (!panel || !panel.classList.contains('active') || rgState.stage === 'upload') return;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
                if (e.key === 'Escape') document.activeElement.blur();
                return;
            }

            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                rgUndoLastRegion();
                return;
            }
            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (rgState.selectedId) {
                    e.preventDefault();
                    rgDeleteItem(rgState.selectedId);
                }
                return;
            }
            if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
                e.preventDefault();
                rgChangePage(-1);
                return;
            }
            if (e.key === 'ArrowRight' || e.key === 'PageDown') {
                e.preventDefault();
                rgChangePage(1);
                return;
            }
            if (e.key === 'Escape') {
                if (rgState.twoTapStart) {
                    rgState.twoTapStart = null;
                    renderBoxOverlay();
                } else if (rgState.continueTargetId) {
                    rgCancelContinue();
                }
            }
        });

        bindFocusDialogEventsOnce();

        if (viewportEl) {
            let wheelZoomAt = 0;
            viewportEl.addEventListener('wheel', (e) => {
                if (!e.ctrlKey && !e.metaKey) return;
                e.preventDefault();
                const now = Date.now();
                if (now - wheelZoomAt < 80) return;
                wheelZoomAt = now;
                rgZoom(e.deltaY < 0 ? 0.15 : -0.15);
            }, { passive: false });
        }
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
                parentItem.subqBoxes.push({ ...rectObj, num: nextSubNum, customNum: false });
            }
            renderAllRg();
            scheduleDraftSave();
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
                scheduleDraftSave();
                return;
            }
        }

        // 3. 新建一题 / 一条答案框
        const bankType = getCurrentBankTypeSafe();
        let label = '';
        let targetExId = null;
        if (tab === 'answer' && rgState.presetNextLabel) {
            label = rgState.presetNextLabel;
            rgState.presetNextLabel = null;
        } else if (bankType === 'homework') {
            label = getNextAutoNumber(tab);
        } else if (bankType === 'variation') {
            if (tab === 'answer') {
                if (rgState.presetNextTargetExId) {
                    targetExId = rgState.presetNextTargetExId;
                    rgState.presetNextTargetExId = null;
                } else {
                    const boundIds = new Set(tabState.items.map(x => x.targetExId).filter(Boolean));
                    const nextUnboundEx = rgState.exercise.items.find(ex => !boundIds.has(ex.id))
                        || rgState.exercise.items[tabState.items.length]
                        || null;
                    targetExId = nextUnboundEx ? nextUnboundEx.id : null;
                }
            }
        } else {
            // preview：不自动标号，手动输入跳题题号（除非点了缺失答案胶囊预设）
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
        scheduleDraftSave();

        if ((bankType === 'preview' && !label) || (bankType === 'variation' && tab === 'answer')) {
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

        const mySeq = ++rgState.renderSeq;
        if (rgState.renderTask && typeof rgState.renderTask.cancel === 'function') {
            try { rgState.renderTask.cancel(); } catch (_) {}
            rgState.renderTask = null;
        }

        const page = await tabState.pdfDoc.getPage(tabState.pageNum);
        if (mySeq !== rgState.renderSeq) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const logicalViewport = page.getViewport({ scale: 1.35 * rgState.scale });
        const renderViewport = page.getViewport({ scale: 1.35 * rgState.scale * dpr });

        canvas.width = Math.round(renderViewport.width);
        canvas.height = Math.round(renderViewport.height);
        canvas.style.width = Math.round(logicalViewport.width) + 'px';
        canvas.style.height = Math.round(logicalViewport.height) + 'px';

        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const task = page.render({ canvasContext: ctx, viewport: renderViewport });
        rgState.renderTask = task;
        try {
            await task.promise;
        } catch (err) {
            if (err && err.name === 'RenderingCancelledException') return;
            throw err;
        } finally {
            if (rgState.renderTask === task) rgState.renderTask = null;
        }
        if (mySeq !== rgState.renderSeq) return;

        if (pageInfo) pageInfo.textContent = `${tabState.pageNum} / ${tabState.totalPages} 页`;
        if (prevBtn) prevBtn.disabled = tabState.pageNum <= 1;
        if (nextBtn) nextBtn.disabled = tabState.pageNum >= tabState.totalPages;

        renderBoxOverlay();
    }

    function appendResizeHandles(div, kind, itemId, boxRef) {
        const edges = rgState.fullWidth ? ['n', 's'] : ['n', 's', 'w', 'e'];
        edges.forEach(edge => {
            const h = document.createElement('div');
            h.className = `rg-handle rg-handle-${edge}`;
            h.addEventListener('pointerdown', (e) => startBoxResize(e, kind, itemId, boxRef, edge, div));
            div.appendChild(h);
        });
    }

    function renderBoxOverlay() {
        const layer = document.getElementById('rg-box-layer');
        if (!layer) return;
        const tab = rgState.activeTab;
        const tabState = getTabState(tab);
        const pageOffset = tabState.pageNum - 1;
        layer.innerHTML = '';

        // 连续框题参考引导线：提示当前页上一框下边界位置
        if (rgState.interactMode === 'draw' && rgState.fullWidth && !rgState.subMode) {
            let maxBottom = 0;
            tabState.items.forEach(it => {
                (it.regions || []).forEach(rg => {
                    if (rg.pageOffset === pageOffset) {
                        maxBottom = Math.max(maxBottom, (rg.y || 0) + (rg.h || 0));
                    }
                });
            });
            if (maxBottom > 0.02 && maxBottom < 0.98) {
                const guide = document.createElement('div');
                guide.className = 'rg-guide-line';
                guide.style.top = (maxBottom * 100) + '%';
                layer.appendChild(guide);
            }
        }

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

                appendResizeHandles(div, 'region', it.id, rg);

                const delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.className = 'rg-box-del';
                delBtn.title = it.regions.length > 1 ? '删除此跨页片段' : '删除此框';
                delBtn.textContent = '×';
                delBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
                delBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    rgDeleteRegionSlice(it.id, rIdx);
                });
                div.appendChild(delBtn);

                div.addEventListener('pointerdown', (e) => {
                    if (e.target.closest('.rg-handle') || e.target.closest('.rg-box-del')) return;
                    // 大题细分拉框模式下，允许 pointerdown 冒泡到画布以在内部框选公共题干/小问
                    if (rgState.subMode && rgState.subMode.tab === tab && rgState.interactMode === 'draw') return;
                    e.stopPropagation();
                });
                div.addEventListener('click', (e) => {
                    if (rgState.subMode && rgState.subMode.tab === tab && rgState.interactMode === 'draw') return;
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
                    div.className = `rg-box stem ${rgState.selectedId === it.id ? 'active' : ''}`;
                    div.style.left = (sb.x * 100) + '%';
                    div.style.top = (sb.y * 100) + '%';
                    div.style.width = (sb.w * 100) + '%';
                    div.style.height = (sb.h * 100) + '%';

                    const tag = document.createElement('span');
                    tag.className = 'rg-box-tag';
                    tag.textContent = `原文${sIdx + 1}`;
                    div.appendChild(tag);

                    appendResizeHandles(div, 'stem', it.id, sb);

                    const delBtn = document.createElement('button');
                    delBtn.type = 'button';
                    delBtn.className = 'rg-box-del';
                    delBtn.title = '删除此原文框';
                    delBtn.textContent = '×';
                    delBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
                    delBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        rgDeleteSubBox(it.id, 'stem', sIdx);
                    });
                    div.appendChild(delBtn);

                    div.addEventListener('pointerdown', (e) => e.stopPropagation());
                    div.addEventListener('click', (e) => {
                        e.stopPropagation();
                        rgState.selectedId = it.id;
                        renderAllRg();
                    });
                    layer.appendChild(div);
                });
                (it.subqBoxes || []).forEach((qb, qIdx) => {
                    if (qb.pageOffset !== pageOffset) return;
                    const div = document.createElement('div');
                    div.className = `rg-box subq ${rgState.selectedId === it.id ? 'active' : ''}`;
                    div.style.left = (qb.x * 100) + '%';
                    div.style.top = (qb.y * 100) + '%';
                    div.style.width = (qb.w * 100) + '%';
                    div.style.height = (qb.h * 100) + '%';

                    const tag = document.createElement('span');
                    tag.className = 'rg-box-tag';
                    tag.textContent = `${qb.num}`;
                    div.appendChild(tag);

                    appendResizeHandles(div, 'subq', it.id, qb);

                    const delBtn = document.createElement('button');
                    delBtn.type = 'button';
                    delBtn.className = 'rg-box-del';
                    delBtn.title = '删除此小问框';
                    delBtn.textContent = '×';
                    delBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
                    delBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        rgDeleteSubBox(it.id, 'subq', qIdx);
                    });
                    div.appendChild(delBtn);

                    div.addEventListener('pointerdown', (e) => e.stopPropagation());
                    div.addEventListener('click', (e) => {
                        e.stopPropagation();
                        rgState.selectedId = it.id;
                        renderAllRg();
                    });
                    layer.appendChild(div);
                });
            }
        });
    }

    function collectAnswerNumSets() {
        const ansNums = new Set();
        rgState.answer.items.forEach(aIt => {
            const lbl = String(aIt.label || '').trim();
            if (lbl) ansNums.add(lbl);
            if (aIt.isBig && Array.isArray(aIt.subqBoxes)) {
                aIt.subqBoxes.forEach(sb => {
                    const sn = String(sb.num || '').trim();
                    if (sn) ansNums.add(sn);
                });
            }
        });
        return ansNums;
    }

    function renderMissingAnswerBar() {
        const bar = document.getElementById('rg-missing-bar');
        if (!bar) return;
        if (rgState.stage !== 'answer' || rgState.activeTab !== 'answer') {
            bar.style.display = 'none';
            return;
        }
        const bankType = getCurrentBankTypeSafe();
        bar.style.display = 'flex';

        if (bankType === 'variation') {
            const boundIds = new Set(rgState.answer.items.map(a => a.targetExId).filter(Boolean));
            const missingEx = rgState.exercise.items.filter(ex => !boundIds.has(ex.id));
            if (missingEx.length === 0) {
                bar.innerHTML = `<span class="rg-missing-done">所有变式题（共 ${rgState.exercise.items.length} 道）均已绑定答案框</span>`;
                return;
            }
            const pills = missingEx.map((ex, idx) => {
                const compact = typeof formatCompactNumList === 'function'
                    ? formatCompactNumList(ex.parentNums)
                    : (ex.parentNums || []).join('、');
                const isActive = rgState.presetNextTargetExId === ex.id;
                return `<button type="button" class="rg-missing-pill ${isActive ? 'active' : ''}" onclick="rgPresetNextAnswerTarget('${ex.id}')" title="点击后，下一框自动绑定到原题${escapeHtmlRg(compact)}">原题${escapeHtmlRg(compact || (idx + 1))}</button>`;
            }).join('');
            bar.innerHTML = `<div class="rg-missing-label">待配对答案（${missingEx.length}）· 点击可指定下一框归属：</div><div class="rg-missing-pills">${pills}</div>`;
            return;
        }

        const expectedNums = [];
        rgState.exercise.items.forEach(it => {
            if (it.isBig && Array.isArray(it.subqBoxes) && it.subqBoxes.length > 0) {
                it.subqBoxes.forEach(sb => {
                    const sn = String(sb.num || '').trim();
                    if (sn && !expectedNums.includes(sn)) expectedNums.push(sn);
                });
            } else {
                const lbl = String(it.label || '').trim();
                if (lbl && !expectedNums.includes(lbl)) expectedNums.push(lbl);
            }
        });
        const ansNums = collectAnswerNumSets();
        const missingNums = expectedNums.filter(n => !ansNums.has(n));

        if (expectedNums.length === 0) {
            bar.style.display = 'none';
            return;
        }
        if (missingNums.length === 0) {
            bar.innerHTML = `<span class="rg-missing-done">全部 ${expectedNums.length} 题均已匹配到答案框</span>`;
            return;
        }
        const pills = missingNums.map(num => {
            const isActive = rgState.presetNextLabel === num;
            return `<button type="button" class="rg-missing-pill ${isActive ? 'active' : ''}" onclick="rgPresetNextAnswerNum('${escapeHtmlRg(num)}')" title="点击后，下一个画出的答案框自动标为第 ${escapeHtmlRg(num)} 题">第 ${escapeHtmlRg(num)} 题</button>`;
        }).join('');
        bar.innerHTML = `<div class="rg-missing-label">待框答案（${missingNums.length}/${expectedNums.length}）· 点击指定下一框题号：</div><div class="rg-missing-pills">${pills}</div>`;
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
                tipEl.textContent = '答案独立拉框，仅按题号匹配题目；选中框可拖边缘微调';
            } else if (bankType === 'preview') {
                tipEl.textContent = '预习模式：框完后手动输入跳题题号；选中框可拖边缘微调';
            } else if (bankType === 'variation') {
                tipEl.textContent = '举一反三模式：框完后勾选对应原题；选中框可拖边缘微调';
            } else {
                tipEl.textContent = '课后巩固：自动递增题号，支持大题与选中框边缘拖拽微调';
            }
        }
        if (finishBtn) {
            finishBtn.disabled = rgState.exercise.items.length === 0;
        }

        renderMissingAnswerBar();

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

            let bigDetailHtml = '';
            if (it.isBig) {
                const stemGroups = groupStemBoxes(it.stemBoxes);
                const stemChips = stemGroups.map((sg, gIdx) => {
                    const pLabels = Array.from(new Set(sg.boxes.map(b => 'P' + ((b.pageOffset || 0) + 1)))).join('~');
                    const firstIdx = sg.indices[0];
                    return `
                        <span class="rg-subq-chip stem-chip" title="${escapeHtmlRg(pLabels)}">
                            <span>原文${gIdx + 1}${sg.boxes.length > 1 ? `(${escapeHtmlRg(pLabels)})` : ''}</span>
                            <button type="button" class="rg-subq-del-btn" onclick="event.stopPropagation(); rgDeleteSubBox('${it.id}', 'stem', ${firstIdx})" title="删除原文框">×</button>
                        </span>
                    `;
                }).join('');
                const subqChips = (it.subqBoxes || []).map((qb, qIdx) => `
                    <span class="rg-subq-chip" title="P${qb.pageOffset + 1}">
                        <span>#</span>
                        <input type="text" class="rg-subq-num-input" value="${escapeHtmlRg(qb.num)}"
                            onclick="event.stopPropagation()"
                            oninput="rgUpdateSubqNum('${it.id}', ${qIdx}, this.value)"
                            onchange="rgUpdateSubqNum('${it.id}', ${qIdx}, this.value)">
                        <button type="button" class="rg-subq-del-btn" onclick="event.stopPropagation(); rgDeleteSubBox('${it.id}', 'subq', ${qIdx})" title="删除小问框">×</button>
                    </span>
                `).join('');
                bigDetailHtml = `
                    <div class="rg-card-submeta">大题 · 原文 ${stemGroups.length} / 小问 ${(it.subqBoxes || []).length}</div>
                    ${(stemChips || subqChips) ? `<div class="rg-subq-list">${stemChips}${subqChips}</div>` : ''}
                `;
            }

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
                    ${bigDetailHtml}
                `;
            }

            return `
                <div class="rg-card ${isActive ? 'active' : ''}" data-id="${it.id}" onclick="rgSelectItem('${it.id}')">
                    ${headerEditorHtml}
                    <div class="rg-card-actions" onclick="event.stopPropagation()">
                        <button type="button" class="btn sm secondary" onclick="rgStartContinue('${it.id}')">+ 跨页续框</button>
                        ${bankType === 'variation' ? '' : `<button type="button" class="btn sm secondary" onclick="rgEnterSubMode('${it.id}')">${it.isBig ? '继续细分' : '设为大题'}</button>`}
                        <button type="button" class="btn sm secondary" onclick="rgDeleteItem('${it.id}')">删除</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    function renderSubModeBar() {
        const stemBtn = document.getElementById('rg-subtarget-stem');
        const subqBtn = document.getElementById('rg-subtarget-subq');
        const hint = document.getElementById('rg-submode-hint');
        const titleEl = document.getElementById('rg-focus-title');
        const startInp = document.getElementById('rg-focus-start-input');
        const zoomVal = document.getElementById('rg-focus-zoom-val');
        const twoTapBtn = document.getElementById('rg-focus-twotap-btn');

        if (!rgState.subMode || rgState.subMode.tab !== rgState.activeTab) {
            closeFocusDialogSafe();
            return;
        }
        const tabState = getTabState(rgState.subMode.tab);
        const it = tabState.items.find(x => x.id === rgState.subMode.itemId);
        if (!it) {
            rgState.subMode = null;
            closeFocusDialogSafe();
            return;
        }
        if (titleEl) titleEl.textContent = `大题专注切分 · ${formatItemTitle(it, rgState.subMode.tab)}`;
        if (startInp && document.activeElement !== startInp) {
            startInp.value = it.label || '';
        }
        if (zoomVal) zoomVal.textContent = Math.round(rgState.focusZoom * 100) + '%';
        if (twoTapBtn) {
            twoTapBtn.classList.toggle('active', Boolean(rgState.twoTapMode));
            twoTapBtn.textContent = rgState.twoTapMode ? '两点定框: 开' : '两点定框: 关';
        }
        if (stemBtn) stemBtn.classList.toggle('active', rgState.subMode.target === 'stem');
        if (subqBtn) {
            subqBtn.classList.toggle('active', rgState.subMode.target === 'subq');
            subqBtn.classList.toggle('subq', rgState.subMode.target === 'subq');
        }
        if (hint) {
            hint.textContent = rgState.subMode.target === 'stem'
                ? '当前：绿虚线框选公共原文/题干（跨页可一笔框完，框好后自动切至小问）'
                : '当前：红框依次框出各小问（自动递增，按 1 可切回补框原文）';
        }
        renderFocusSidebar();
        renderFocusSliceOverlays();
    }

    function setBtnLabel(btn, text) {
        if (!btn) return;
        const lbl = btn.querySelector('.rg-btn-label');
        if (lbl) lbl.textContent = text;
        else btn.textContent = text;
    }

    function hasRegionDebugPermission() {
        if (typeof window.isRegionDebugAdminUser === 'function') {
            return window.isRegionDebugAdminUser();
        }
        const u = window.currentUser;
        return Boolean(u && (u.is_admin || u.role === 'admin' || u.role === 'super_admin'));
    }

    function hasSavedRegionCropInCurrentQuestions() {
        return Array.isArray(currentQuestions) && currentQuestions.some(q =>
            q && q.questionMeta && q.questionMeta.mode === 'region_crop' && q.exercisePdf && q.exercisePdf.url
        );
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
        const loadExistBtn = document.getElementById('rg-load-existing-btn');
        const uploadFooter = document.getElementById('rg-upload-gate-footer');
        const exBox = document.getElementById('rg-exercise-upload-box');
        const ansBox = document.getElementById('rg-answer-upload-box');

        if (exBox) exBox.classList.toggle('uploaded', Boolean(rgState.exercise.pdfDoc));
        if (ansBox) ansBox.classList.toggle('uploaded', Boolean(rgState.answer.pdfDoc));

        if (gate) gate.style.display = st === 'upload' ? 'block' : 'none';
        if (ws) ws.style.display = st === 'upload' ? 'none' : 'grid';

        const showLoadExist = hasRegionDebugPermission() && st === 'upload' && hasSavedRegionCropInCurrentQuestions();
        if (loadExistBtn) {
            loadExistBtn.style.display = showLoadExist ? 'inline-flex' : 'none';
        }
        if (uploadFooter) {
            uploadFooter.style.display = showLoadExist ? 'flex' : 'none';
        }

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
                setBtnLabel(prevBtn, '重新上传 PDF');
            } else {
                prevBtn.style.display = 'inline-flex';
                setBtnLabel(prevBtn, '返回修改题目框选');
            }
        }

        if (nextBtn) {
            if (st === 'upload') {
                nextBtn.style.display = 'inline-flex';
                setBtnLabel(nextBtn, '开始框选题目 PDF');
                nextBtn.disabled = !(rgState.exercise.pdfDoc && rgState.answer.pdfDoc);
            } else if (st === 'exercise') {
                nextBtn.style.display = 'inline-flex';
                setBtnLabel(nextBtn, '下一步：框选答案 PDF');
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

    function reconstructRgItemsFromQuestions(questions) {
        const exItems = [];
        const ansItems = [];
        const ansDedup = new Map();
        const bigGroups = new Map();
        let seq = 1;
        const bankType = getCurrentBankTypeSafe();

        const regSig = (arr) => (arr || []).map(r => `${r.pageOffset}:${r.x}:${r.y}:${r.w}:${r.h}`).join(';');

        questions.forEach(q => {
            const meta = q && q.questionMeta;
            if (!meta || meta.mode !== 'region_crop') return;

            const isGroup = bankType !== 'variation' && Array.isArray(meta.groupNums) && meta.groupNums.length > 1;
            let exItem = null;
            if (isGroup) {
                const gKey = meta.groupNums.join(',');
                exItem = bigGroups.get(gKey);
                if (!exItem) {
                    exItem = {
                        id: `exercise_${seq++}`,
                        label: String(meta.groupNums[0]),
                        targetExId: null,
                        parentNums: [],
                        isBig: true,
                        regions: (meta.regions || []).map(r => ({ ...r })),
                        stemBoxes: (meta.stemBoxes || []).map(sb => ({ ...sb })),
                        subqBoxes: []
                    };
                    bigGroups.set(gKey, exItem);
                    exItems.push(exItem);
                }
                if (meta.box) {
                    exItem.subqBoxes.push({ ...meta.box, num: parseInt(q.id, 10) || q.id, customNum: false });
                }
            } else {
                const pNums = Array.isArray(q.parentQuestionNums) && q.parentQuestionNums.length > 0
                    ? q.parentQuestionNums
                    : (q.parentQuestionNum ? [Number(q.parentQuestionNum)] : []);
                exItem = {
                    id: `exercise_${seq++}`,
                    label: bankType === 'variation' ? '' : String(q.id || ''),
                    targetExId: null,
                    parentNums: pNums,
                    isBig: false,
                    regions: (meta.regions || []).map(r => ({ ...r })),
                    stemBoxes: [],
                    subqBoxes: []
                };
                exItems.push(exItem);
            }

            if (Array.isArray(meta.answerRegions) && meta.answerRegions.length > 0) {
                const aSig = bankType === 'variation' ? `var_${exItem.id}` : regSig(meta.answerRegions);
                let ansItem = ansDedup.get(aSig);
                if (!ansItem) {
                    ansItem = {
                        id: `answer_${seq++}`,
                        label: (bankType === 'variation' || isGroup) ? '' : String(q.id || ''),
                        targetExId: bankType === 'variation' ? exItem.id : null,
                        parentNums: [],
                        isBig: Boolean(isGroup && meta.answerBox),
                        regions: meta.answerRegions.map(r => ({ ...r })),
                        stemBoxes: [],
                        subqBoxes: []
                    };
                    ansDedup.set(aSig, ansItem);
                    ansItems.push(ansItem);
                }
                if (isGroup && meta.answerBox) {
                    ansItem.isBig = true;
                    if (!ansItem.label) ansItem.label = String(meta.groupNums[0]);
                    ansItem.subqBoxes.push({ ...meta.answerBox, num: parseInt(q.id, 10) || q.id, customNum: false });
                } else if (!isGroup && !ansItem.label && bankType !== 'variation') {
                    ansItem.label = String(q.id || '');
                }
            }
        });

        return { exItems, ansItems, nextSeq: seq };
    }

    async function loadPdfFromUrlToFile(url, fallbackName) {
        const resp = await fetch(url, { cache: 'no-cache' });
        if (!resp.ok) throw new Error('原卷 PDF 下载失败');
        const blob = await resp.blob();
        const file = new File([blob], fallbackName || 'origin.pdf', { type: 'application/pdf' });
        const buf = await file.arrayBuffer();
        const pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
        return { file, pdfDoc };
    }

    window.rgLoadFromCurrentQuestions = async function (focusQuestion = null) {
        if (!hasRegionDebugPermission()) {
            showToast('整卷框题仅限管理员使用', 'warn');
            return false;
        }
        if (!hasSavedRegionCropInCurrentQuestions()) {
            showToast('当前题库中暂无整卷框题数据', 'warn');
            return false;
        }
        const firstRegionQ = currentQuestions.find(q =>
            q && q.questionMeta && q.questionMeta.mode === 'region_crop' && q.exercisePdf && q.exercisePdf.url
        );
        const firstAnsQ = currentQuestions.find(q =>
            q && q.questionMeta && q.questionMeta.mode === 'region_crop' && q.answerPdf && q.answerPdf.url
        );
        if (!firstRegionQ) return false;

        showToast('正在载入原卷 PDF 与已有框选区域...', 'info');
        try {
            const exLoaded = await loadPdfFromUrlToFile(firstRegionQ.exercisePdf.url, firstRegionQ.exercisePdf.name || '题目原卷.pdf');
            let ansLoaded = null;
            if (firstAnsQ && firstAnsQ.answerPdf && firstAnsQ.answerPdf.url) {
                ansLoaded = await loadPdfFromUrlToFile(firstAnsQ.answerPdf.url, firstAnsQ.answerPdf.name || '答案原卷.pdf');
            }

            const rebuilt = reconstructRgItemsFromQuestions(currentQuestions);
            rgState.exercise = {
                file: exLoaded.file,
                pdfDoc: exLoaded.pdfDoc,
                pageNum: 1,
                totalPages: exLoaded.pdfDoc.numPages,
                items: rebuilt.exItems
            };
            const exLbl = document.getElementById('rg-exercise-file-label');
            if (exLbl) exLbl.textContent = `${exLoaded.file.name} (${exLoaded.pdfDoc.numPages} 页)`;

            if (ansLoaded) {
                rgState.answer = {
                    file: ansLoaded.file,
                    pdfDoc: ansLoaded.pdfDoc,
                    pageNum: 1,
                    totalPages: ansLoaded.pdfDoc.numPages,
                    items: rebuilt.ansItems
                };
                const ansLbl = document.getElementById('rg-answer-file-label');
                if (ansLbl) ansLbl.textContent = `${ansLoaded.file.name} (${ansLoaded.pdfDoc.numPages} 页)`;
            } else {
                rgState.answer = { file: null, pdfDoc: null, pageNum: 1, totalPages: 0, items: [] };
            }

            rgState.nextSeq = rebuilt.nextSeq;
            rgState.stage = 'exercise';
            rgState.activeTab = 'exercise';
            rgState.continueTargetId = null;
            rgState.subMode = null;

            if (focusQuestion) {
                const target = findRgItemForQuestion(focusQuestion);
                if (target) {
                    rgState.selectedId = target.id;
                    if (target.regions && target.regions.length > 0) {
                        rgState.exercise.pageNum = Math.min(rgState.exercise.totalPages, Math.max(1, (target.regions[0].pageOffset || 0) + 1));
                    }
                }
            }
            renderAllRg();
            await renderPdfPage();
            scheduleDraftSave();
            showToast(`已载入 ${rebuilt.exItems.length} 组框选区域，可直接微调`, 'success');
            return true;
        } catch (err) {
            console.error('Load saved region_crop failed:', err);
            showToast('载入原卷失败：' + (err.message || '网络异常'), 'error');
            return false;
        }
    };

    function findRgItemForQuestion(q) {
        if (!q) return null;
        const qIdStr = String(q.id || '').trim();
        const bankType = getCurrentBankTypeSafe();
        if (bankType === 'variation') {
            const qRegions = (q.questionMeta && Array.isArray(q.questionMeta.regions)) ? q.questionMeta.regions : [];
            const sig = qRegions.map(r => `${r.pageOffset}:${r.x}:${r.y}:${r.w}:${r.h}`).join(';');
            return rgState.exercise.items.find(it =>
                (it.regions || []).map(r => `${r.pageOffset}:${r.x}:${r.y}:${r.w}:${r.h}`).join(';') === sig
            ) || null;
        }
        return rgState.exercise.items.find(it => {
            if (String(it.label || '').trim() === qIdStr) return true;
            if (it.isBig && Array.isArray(it.subqBoxes)) {
                return it.subqBoxes.some(sb => String(sb.num || '').trim() === qIdStr);
            }
            return false;
        }) || null;
    }

    window.openRegionDebugStudio = async function (opts = {}) {
        if (!hasRegionDebugPermission()) {
            showToast('整卷框题仅限管理员使用', 'warn');
            return;
        }
        if (window.currentUser && window.currentUser.role === 'assistant') {
            showToast('助教账号仅具备查看权限，无法录入或上传题目', 'warn');
            return;
        }
        if (!subjectSelect || !subjectSelect.value || !gradeSelect || !gradeSelect.value || !tierSelect || !tierSelect.value || !weekSelect || !weekSelect.value) {
            showToast('请先选齐学科、年级、班层与专题', 'warn');
            return;
        }
        if (!opts.skipReload) {
            await loadCurrentData();
        }
        if (getCurrentBankTypeSafe() === 'variation' && typeof loadHomeworkQuestionsForVariation === 'function') {
            await loadHomeworkQuestionsForVariation();
        }

        const newContextKey = buildContextKeyFromSelectors();
        if (rgState.contextKey && rgState.contextKey !== newContextKey) {
            resetStudioMemoryState();
        }
        rgState.contextKey = newContextKey;

        const ctxEl = document.getElementById('rg-context-line');
        if (ctxEl) {
            const typeLabel = typeof getBankTypeLabel === 'function' ? getBankTypeLabel(getCurrentBankTypeSafe()) : getCurrentBankTypeSafe();
            const topicLabel = typeof getTopicLabel === 'function' ? getTopicLabel(weekSelect.value) : weekSelect.value;
            ctxEl.textContent = `${typeLabel} · ${subjectSelect.value} · ${gradeSelect.value} · ${tierSelect.value} · ${topicLabel}`;
        }

        bindCanvasEventsOnce();

        // 草稿功能已关闭：若浏览器曾留存旧 IndexedDB 草稿库，直接清理
        try {
            if (typeof indexedDB !== 'undefined') indexedDB.deleteDatabase(DRAFT_DB_NAME);
        } catch (_) {}

        goToStep('debug');

        if (opts.focusQuestion) {
            if (rgState.exercise.pdfDoc) {
                rgState.stage = 'exercise';
                rgState.activeTab = 'exercise';
                const target = findRgItemForQuestion(opts.focusQuestion);
                if (target) {
                    rgState.selectedId = target.id;
                    if (target.regions && target.regions.length > 0) {
                        rgState.exercise.pageNum = Math.min(rgState.exercise.totalPages, Math.max(1, (target.regions[0].pageOffset || 0) + 1));
                    }
                }
            } else if (hasSavedRegionCropInCurrentQuestions()) {
                await window.rgLoadFromCurrentQuestions(opts.focusQuestion);
                return;
            }
        }

        renderAllRg();
        await renderPdfPage();
    };

    window.rgEditQuestionRegionFromStep4 = async function (index) {
        if (!hasRegionDebugPermission()) {
            showToast('整卷框题仅限管理员使用', 'warn');
            return;
        }
        const q = Array.isArray(currentQuestions) ? currentQuestions[index] : null;
        if (!q) return;
        await window.openRegionDebugStudio({ skipReload: true, focusQuestion: q });
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
            rgState.focusPageCache.clear();
            closeFocusDialogSafe();
            rgState.twoTapStart = null;
            renderAllRg();
            await renderPdfPage();
            scheduleDraftSave();
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
                const missing = exItems.find(it =>
                    !(it.isBig && Array.isArray(it.subqBoxes) && it.subqBoxes.length > 0)
                    && !String(it.label || '').trim()
                );
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
            rgState.focusPageCache.clear();
            closeFocusDialogSafe();
            rgState.twoTapStart = null;
            rgState.presetNextLabel = null;
            rgState.presetNextTargetExId = null;
            renderAllRg();
            await renderPdfPage();
            scheduleDraftSave();
        }
    };

    window.rgGoPrevStage = async function () {
        rgState.continueTargetId = null;
        rgState.subMode = null;
        rgState.twoTapStart = null;
        rgState.presetNextLabel = null;
        rgState.presetNextTargetExId = null;
        if (rgState.stage === 'answer') {
            rgState.stage = 'exercise';
            rgState.activeTab = 'exercise';
            renderAllRg();
            await renderPdfPage();
            scheduleDraftSave();
            return;
        }
        if (rgState.stage === 'exercise') {
            rgState.stage = 'upload';
            renderAllRg();
            scheduleDraftSave();
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
            rgState.focusPageCache.clear();
            closeFocusDialogSafe();
            rgState.twoTapStart = null;

            const lbl = document.getElementById(tab === 'answer' ? 'rg-answer-file-label' : 'rg-exercise-file-label');
            if (lbl) lbl.textContent = `${file.name} (${pdfDoc.numPages} 页)`;

            syncStageUi();
            if (rgState.stage !== 'upload' && rgState.activeTab === tab) {
                renderAllRg();
                await renderPdfPage();
            }
            scheduleDraftSave();
            showToast(`已加载${tab === 'answer' ? '答案' : '题目'} PDF（${pdfDoc.numPages} 页）`);
        } catch (err) {
            console.error('Region PDF load error:', err);
            showToast('PDF 解析失败：' + (err.message || '未知错误'), 'error');
        } finally {
            inputEl.value = '';
        }
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
        scheduleDraftSave();
    };

    window.rgPresetNextAnswerNum = function (numStr) {
        rgState.presetNextLabel = (rgState.presetNextLabel === numStr) ? null : numStr;
        renderMissingAnswerBar();
    };

    window.rgPresetNextAnswerTarget = function (exId) {
        rgState.presetNextTargetExId = (rgState.presetNextTargetExId === exId) ? null : exId;
        renderMissingAnswerBar();
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
        scheduleDraftSave();
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
                let cursor = base;
                it.subqBoxes.forEach((sb) => {
                    if (!sb.customNum) {
                        sb.num = cursor;
                    }
                    const parsed = parseInt(sb.num, 10);
                    cursor = (!isNaN(parsed) && parsed >= cursor) ? (parsed + 1) : (cursor + 1);
                });
                const subInputs = document.querySelectorAll(`.rg-card[data-id="${itemId}"] .rg-subq-num-input, #rg-focus-list .rg-subq-num-input`);
                subInputs.forEach((inp, idx) => {
                    if (it.subqBoxes[idx]) inp.value = it.subqBoxes[idx].num;
                });
            }
        }
        const focusTitle = document.getElementById('rg-focus-title');
        if (focusTitle && rgState.subMode && rgState.subMode.itemId === itemId) {
            focusTitle.textContent = `大题专注切分 · ${formatItemTitle(it, rgState.subMode.tab)}`;
        }
        renderBoxOverlay();
        renderFocusSliceOverlays();
        renderMissingAnswerBar();
        syncStageUi();
        scheduleDraftSave();
    };

    window.rgUpdateSubqNum = function (itemId, subIdx, val) {
        const tabState = getTabState();
        const it = tabState.items.find(x => x.id === itemId);
        if (!it || !Array.isArray(it.subqBoxes) || !it.subqBoxes[subIdx]) return;
        const clean = String(val || '').trim();
        it.subqBoxes[subIdx].num = clean || '';
        it.subqBoxes[subIdx].customNum = Boolean(clean);
        renderBoxOverlay();
        renderFocusSliceOverlays();
        renderMissingAnswerBar();
        scheduleDraftSave();
    };

    window.rgDeleteSubBox = function (itemId, kind, idx) {
        const tabState = getTabState();
        const it = tabState.items.find(x => x.id === itemId);
        if (!it) return;
        if (kind === 'stem' && Array.isArray(it.stemBoxes)) {
            const target = it.stemBoxes[idx];
            if (target && target.linkId) {
                it.stemBoxes = it.stemBoxes.filter(sb => sb.linkId !== target.linkId);
            } else {
                it.stemBoxes.splice(idx, 1);
            }
        } else if (kind === 'subq' && Array.isArray(it.subqBoxes)) {
            it.subqBoxes.splice(idx, 1);
        }
        renderAllRg();
        scheduleDraftSave();
    };

    window.rgDeleteRegionSlice = function (itemId, regionIdx) {
        const tabState = getTabState();
        const it = tabState.items.find(x => x.id === itemId);
        if (!it) return;
        if (Array.isArray(it.regions) && it.regions.length > 1) {
            it.regions.splice(regionIdx, 1);
            renderAllRg();
            scheduleDraftSave();
            return;
        }
        window.rgDeleteItem(itemId);
    };

    window.rgBindAnswerToExercise = function (ansItemId, exItemId) {
        const it = rgState.answer.items.find(x => x.id === ansItemId);
        if (!it) return;
        it.targetExId = exItemId;
        renderAllRg();
        scheduleDraftSave();
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
        scheduleDraftSave();
    };

    window.rgStartContinue = async function (itemId) {
        const tabState = getTabState();
        const it = tabState.items.find(x => x.id === itemId);
        rgState.continueTargetId = itemId;
        rgState.selectedId = itemId;
        if (tabState.pdfDoc && tabState.totalPages > 1) {
            const lastPageNum = (it && Array.isArray(it.regions) && it.regions.length > 0)
                ? (Math.max(...it.regions.map(r => parseInt(r.pageOffset, 10) || 0)) + 1)
                : tabState.pageNum;
            if (lastPageNum < tabState.totalPages) {
                const targetPage = lastPageNum + 1;
                if (targetPage !== tabState.pageNum) {
                    tabState.pageNum = targetPage;
                    rgState.twoTapStart = null;
                    await renderPdfPage();
                }
            } else {
                showToast('当前已是最后一页，可直接在本页续框', 'info');
            }
        }
        renderSidebar();
    };

    window.rgCancelContinue = function () {
        rgState.continueTargetId = null;
        renderSidebar();
    };

    let focusDialogEventsBound = false;

    function getFocusActiveItem() {
        if (!rgState.subMode) return null;
        const tabState = getTabState(rgState.subMode.tab);
        return tabState.items.find(x => x.id === rgState.subMode.itemId) || null;
    }

    function promptBigQuestionStartNum(it) {
        const dlg = document.getElementById('rg-bigq-startnum-dialog');
        const input = document.getElementById('rg-startnum-input');
        const errEl = document.getElementById('rg-startnum-err');
        const confirmBtn = document.getElementById('rg-startnum-confirm');
        const cancelBtn = document.getElementById('rg-startnum-cancel');
        if (!dlg || !input || !confirmBtn || !cancelBtn) {
            return Promise.resolve(parseInt(it.label, 10) || 1);
        }

        const existingRaw = String(it.label || '').trim();
        input.value = /^\d+$/.test(existingRaw) && parseInt(existingRaw, 10) > 0 ? existingRaw : '';
        if (errEl) {
            errEl.style.display = 'none';
            errEl.textContent = '';
        }

        return new Promise((resolve) => {
            let settled = false;
            const finish = (val) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (typeof closeNativeDialog === 'function') {
                    closeNativeDialog(dlg);
                } else if (dlg.open) {
                    dlg.close();
                } else {
                    dlg.classList.remove('active');
                }
                resolve(val);
            };

            const tryConfirm = () => {
                const raw = String(input.value || '').trim();
                const parsed = parseInt(raw, 10);
                if (!/^\d+$/.test(raw) || isNaN(parsed) || parsed <= 0) {
                    if (errEl) {
                        errEl.textContent = '请先输入有效的首题题号（正整数，例如 10）';
                        errEl.style.display = 'block';
                    }
                    input.focus();
                    input.select();
                    return;
                }
                finish(parsed);
            };

            const onKeyDown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    tryConfirm();
                }
            };
            const onCancel = () => finish(null);
            const onClose = () => {
                if (!settled) finish(null);
            };
            const onInput = () => {
                if (errEl && errEl.style.display !== 'none') {
                    errEl.style.display = 'none';
                }
            };

            function cleanup() {
                confirmBtn.removeEventListener('click', tryConfirm);
                cancelBtn.removeEventListener('click', onCancel);
                input.removeEventListener('keydown', onKeyDown);
                input.removeEventListener('input', onInput);
                dlg.removeEventListener('close', onClose);
            }

            confirmBtn.addEventListener('click', tryConfirm);
            cancelBtn.addEventListener('click', onCancel);
            input.addEventListener('keydown', onKeyDown);
            input.addEventListener('input', onInput);
            dlg.addEventListener('close', onClose);

            if (typeof openNativeDialog === 'function') {
                openNativeDialog(dlg, {
                    dismissible: true,
                    onCancel: () => { if (!settled) { settled = true; cleanup(); resolve(null); } }
                });
            } else {
                dlg.classList.add('active');
                if (typeof dlg.showModal === 'function' && !dlg.open) dlg.showModal();
            }

            setTimeout(() => {
                input.focus();
                input.select();
            }, 60);
        });
    }

    function groupStemBoxes(stemBoxes) {
        const groups = [];
        const linkMap = new Map();
        (stemBoxes || []).forEach((sb, idx) => {
            const lk = sb && sb.linkId ? String(sb.linkId) : '';
            if (lk && linkMap.has(lk)) {
                const g = linkMap.get(lk);
                g.boxes.push(sb);
                g.indices.push(idx);
            } else {
                const g = { linkId: lk, boxes: [sb], indices: [idx] };
                if (lk) linkMap.set(lk, g);
                groups.push(g);
            }
        });
        return groups;
    }

    function computeRegionDisplayCrop(rg) {
        const padY = 0.006;
        const rx = clamp01(Number(rg.x) || 0);
        const rw = Math.max(0.05, Math.min(1 - rx, Number(rg.w) || 0.94));
        const ry = clamp01(Number(rg.y) || 0);
        const rh = Math.max(0.015, Number(rg.h) || 0.1);
        const cy0 = clamp01(ry - padY);
        const cy1 = clamp01(ry + rh + padY);
        return {
            pageOffset: parseInt(rg.pageOffset, 10) || 0,
            x: rx,
            y: cy0,
            w: rw,
            h: Math.max(0.02, cy1 - cy0)
        };
    }

    function findBestSliceForBox(box, slices) {
        let bestIdx = -1;
        let bestOverlap = 0;
        const by0 = Number(box.y) || 0;
        const by1 = by0 + (Number(box.h) || 0);
        const midY = (by0 + by1) / 2;
        slices.forEach((s, idx) => {
            const c = s.crop || s;
            if (c.pageOffset !== (parseInt(box.pageOffset, 10) || 0)) return;
            const cy0 = c.y;
            const cy1 = c.y + c.h;
            const overlap = Math.min(by1, cy1) - Math.max(by0, cy0);
            if (overlap > bestOverlap || (overlap > 0 && midY >= cy0 && midY <= cy1 && bestOverlap <= 0)) {
                bestOverlap = Math.max(overlap, 0.0001);
                bestIdx = idx;
            }
        });
        return bestIdx;
    }

    function splitStitchRangeToRects(y0Px, y1Px, stitch) {
        if (!stitch || !Array.isArray(stitch.slices) || stitch.slices.length === 0) return [];
        const topPx = Math.max(0, Math.min(y0Px, y1Px));
        const botPx = Math.min(stitch.totalH, Math.max(y0Px, y1Px));
        const hits = [];
        let maxOverlap = 0;
        let bestSingle = null;

        stitch.slices.forEach((s) => {
            const interTop = Math.max(topPx, s.topPx);
            const interBot = Math.min(botPx, s.bottomPx);
            const overlap = interBot - interTop;
            if (overlap > maxOverlap) {
                maxOverlap = overlap;
                bestSingle = { slice: s, interTop, interBot, overlap };
            }
            if (overlap >= 4) {
                hits.push({ slice: s, interTop, interBot, overlap });
            }
        });

        const chosen = hits.length > 0 ? hits : (bestSingle && bestSingle.overlap > 0 ? [bestSingle] : []);
        return chosen.map(({ slice, interTop, interBot }) => {
            const relY = clamp01((interTop - slice.topPx) / Math.max(1, slice.logicalH));
            const relH = Math.max(0.008, (interBot - interTop) / Math.max(1, slice.logicalH));
            const pageY = clamp01(slice.crop.y + relY * slice.crop.h);
            const pageH = Math.max(0.006, Math.min(1 - pageY, relH * slice.crop.h));
            return {
                pageOffset: slice.crop.pageOffset,
                x: round4(slice.crop.x),
                y: round4(pageY),
                w: round4(slice.crop.w),
                h: round4(pageH)
            };
        });
    }

    function commitStitchedDrawRange(y0Px, y1Px) {
        if (!rgState.subMode || !rgState.focusStitch) return;
        const it = getFocusActiveItem();
        if (!it) return;
        const rects = splitStitchRangeToRects(y0Px, y1Px, rgState.focusStitch);
        if (rects.length === 0) return;

        if (rgState.subMode.target === 'stem') {
            it.stemBoxes = it.stemBoxes || [];
            const wasEmpty = it.stemBoxes.length === 0;
            if (rects.length > 1) {
                const linkId = `stem_${Date.now()}_${rgState.nextSeq++}`;
                rects.forEach(r => it.stemBoxes.push({ ...r, linkId }));
            } else {
                it.stemBoxes.push(rects[0]);
            }
            if (wasEmpty) {
                rgState.subMode.target = 'subq';
                showToast('原文已框选，已自动切换为「2. 框选小问」', 'info');
            }
        } else {
            // 小问模式：若不慎拖跨页缝，归属垂直交集最大的一页，避免产生重复题号
            let bestRect = rects[0];
            if (rects.length > 1) {
                let bestScore = -1;
                rects.forEach((r) => {
                    const sIdx = findBestSliceForBox(r, rgState.focusStitch.slices);
                    const s = sIdx >= 0 ? rgState.focusStitch.slices[sIdx] : null;
                    const pxH = s ? (r.h / Math.max(0.001, s.crop.h)) * s.logicalH : r.h;
                    if (pxH > bestScore) {
                        bestScore = pxH;
                        bestRect = r;
                    }
                });
                showToast('小问已归属占比更大的一页', 'info');
            }
            it.subqBoxes = it.subqBoxes || [];
            const baseNum = parseInt(it.label, 10) || 1;
            const nextSubNum = it.subqBoxes.length === 0
                ? baseNum
                : (Math.max(...it.subqBoxes.map(b => parseInt(b.num, 10) || baseNum)) + 1);
            it.subqBoxes.push({ ...bestRect, num: nextSubNum, customNum: false });
        }
        renderAllRg();
        scheduleDraftSave();
    }

    function startFocusBoxResize(e, kind, itemId, groupBoxes, edge, boxEl, origTopPx, origBotPx, stitch) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        rgState.focusResize = {
            pointerId: e.pointerId,
            kind,
            itemId,
            groupBoxes,
            edge,
            boxEl,
            stitch,
            startClientY: e.clientY,
            origTopPx,
            origBotPx,
            curTopPx: origTopPx,
            curBotPx: origBotPx
        };
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    }

    function renderFocusSidebar() {
        const listEl = document.getElementById('rg-focus-list');
        const summaryEl = document.getElementById('rg-focus-summary');
        const it = getFocusActiveItem();
        if (!listEl || !it) return;

        const stemGroups = groupStemBoxes(it.stemBoxes);
        const subqs = it.subqBoxes || [];
        if (summaryEl) {
            summaryEl.textContent = `原文 ${stemGroups.length} 块 · 小问 ${subqs.length} 题`;
        }
        if (stemGroups.length === 0 && subqs.length === 0) {
            listEl.innerHTML = '<div class="rg-list-empty">请在左侧框选区拖拽划出公共题干或各小问</div>';
            return;
        }

        const stemHtml = stemGroups.map((sg, gIdx) => {
            const pLabels = Array.from(new Set(sg.boxes.map(b => 'P' + ((b.pageOffset || 0) + 1)))).join('~');
            const firstIdx = sg.indices[0];
            return `
                <div class="rg-focus-list-row stem">
                    <span class="rg-focus-badge stem">原文${gIdx + 1}</span>
                    <span class="rg-card-meta">${escapeHtmlRg(pLabels)}</span>
                    <button type="button" class="rg-subq-del-btn" onclick="rgDeleteSubBox('${it.id}', 'stem', ${firstIdx})" title="删除此原文框">×</button>
                </div>
            `;
        }).join('');

        const subqHtml = subqs.map((qb, qIdx) => `
            <div class="rg-focus-list-row subq">
                <span class="rg-focus-badge subq">小问</span>
                <div class="rg-focus-subq-edit">
                    <span>#</span>
                    <input type="text" class="rg-subq-num-input" value="${escapeHtmlRg(qb.num)}"
                        oninput="rgUpdateSubqNum('${it.id}', ${qIdx}, this.value)"
                        onchange="rgUpdateSubqNum('${it.id}', ${qIdx}, this.value)">
                </div>
                <span class="rg-card-meta">P${(qb.pageOffset || 0) + 1}</span>
                <button type="button" class="rg-subq-del-btn" onclick="rgDeleteSubBox('${it.id}', 'subq', ${qIdx})" title="删除此小问框">×</button>
            </div>
        `).join('');

        listEl.innerHTML = `
            ${stemGroups.length > 0 ? `<div class="rg-focus-list-group"><div class="rg-focus-list-title">公共题干 / 原文</div>${stemHtml}</div>` : ''}
            ${subqs.length > 0 ? `<div class="rg-focus-list-group"><div class="rg-focus-list-title">小问列表</div>${subqHtml}</div>` : ''}
        `;
    }

    function renderFocusSliceOverlays() {
        const it = getFocusActiveItem();
        const stitch = rgState.focusStitch;
        if (!it || !stitch || !stitch.layerEl || !Array.isArray(stitch.slices) || stitch.slices.length === 0) return;

        const { layerEl, totalH, slices } = stitch;
        layerEl.innerHTML = '';

        if (rgState.focusTwoTapStart) {
            const line = document.createElement('div');
            line.className = 'rg-anchor-line';
            line.style.top = ((rgState.focusTwoTapStart.yPx / Math.max(1, totalH)) * 100) + '%';
            const lbl = document.createElement('span');
            lbl.className = 'rg-anchor-label';
            lbl.textContent = '上边界已定，请点下边界';
            line.appendChild(lbl);
            layerEl.appendChild(line);
        }

        const boxToStitchSpan = (box) => {
            const sIdx = findBestSliceForBox(box, slices);
            if (sIdx < 0) return null;
            const s = slices[sIdx];
            const relY = clamp01((box.y - s.crop.y) / s.crop.h);
            const relBot = clamp01((box.y + box.h - s.crop.y) / s.crop.h);
            return {
                topPx: s.topPx + relY * s.logicalH,
                botPx: Math.max(s.topPx + relY * s.logicalH + 8, s.topPx + relBot * s.logicalH)
            };
        };

        const renderStitchedBox = (topPx, botPx, kind, groupBoxes, firstIdx, labelText) => {
            const topPct = (topPx / Math.max(1, totalH)) * 100;
            const heightPct = Math.max(0.8, ((botPx - topPx) / Math.max(1, totalH)) * 100);
            const div = document.createElement('div');
            const nearTopCls = topPx < 22 ? ' near-top' : '';
            div.className = `rg-box ${kind} active${nearTopCls}`;
            div.style.left = '0%';
            div.style.top = topPct + '%';
            div.style.width = '100%';
            div.style.height = heightPct + '%';

            const tag = document.createElement('span');
            tag.className = 'rg-box-tag';
            tag.textContent = labelText;
            div.appendChild(tag);

            ['n', 's'].forEach(edge => {
                const h = document.createElement('div');
                h.className = `rg-handle rg-handle-${edge}`;
                h.addEventListener('pointerdown', (e) => startFocusBoxResize(e, kind, it.id, groupBoxes, edge, div, topPx, botPx, stitch));
                div.appendChild(h);
            });

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'rg-box-del';
            delBtn.title = kind === 'stem' ? '删除此原文框' : '删除此小问框';
            delBtn.textContent = '×';
            delBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                rgDeleteSubBox(it.id, kind, firstIdx);
            });
            div.appendChild(delBtn);

            layerEl.appendChild(div);
        };

        const stemGroups = groupStemBoxes(it.stemBoxes);
        stemGroups.forEach((sg, gIdx) => {
            const spans = sg.boxes.map(boxToStitchSpan).filter(Boolean);
            if (spans.length === 0) return;
            const topPx = Math.min(...spans.map(sp => sp.topPx));
            const botPx = Math.max(...spans.map(sp => sp.botPx));
            const pLabels = Array.from(new Set(sg.boxes.map(b => 'P' + ((b.pageOffset || 0) + 1)))).join('~');
            const suffix = sg.boxes.length > 1 ? ` (跨${pLabels})` : '';
            renderStitchedBox(topPx, botPx, 'stem', sg.boxes, sg.indices[0], `原文${gIdx + 1}${suffix}`);
        });

        (it.subqBoxes || []).forEach((qb, qIdx) => {
            const sp = boxToStitchSpan(qb);
            if (!sp) return;
            renderStitchedBox(sp.topPx, sp.botPx, 'subq', [qb], qIdx, `${qb.num}`);
        });
    }

    async function renderFocusSlices() {
        const container = document.getElementById('rg-focus-slices');
        const viewportEl = document.getElementById('rg-focus-viewport');
        const it = getFocusActiveItem();
        if (!container || !it || !rgState.subMode) return;

        const tab = rgState.subMode.tab;
        const tabState = getTabState(tab);
        if (!tabState.pdfDoc) return;

        const mySeq = ++rgState.focusRenderSeq;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const availW = Math.max(360, Math.min(860, ((viewportEl && viewportEl.clientWidth) ? viewportEl.clientWidth : 780) - 48));
        const stitchW = Math.max(240, Math.round(availW * rgState.focusZoom));

        container.innerHTML = '';
        rgState.focusStitch = null;
        const rawRegions = (Array.isArray(it.regions) && it.regions.length > 0)
            ? it.regions
            : [{ pageOffset: 0, x: FULL_WIDTH_X, y: 0, w: FULL_WIDTH_W, h: 1 }];
        const regions = [...rawRegions].sort((a, b) => ((a.pageOffset || 0) - (b.pageOffset || 0)) || ((a.y || 0) - (b.y || 0)));

        const prepared = [];
        let totalH = 0;

        for (let sliceIdx = 0; sliceIdx < regions.length; sliceIdx++) {
            if (mySeq !== rgState.focusRenderSeq) return;
            const crop = computeRegionDisplayCrop(regions[sliceIdx]);
            const pageNum = Math.min(tabState.pdfDoc.numPages, Math.max(1, crop.pageOffset + 1));
            const page = await tabState.pdfDoc.getPage(pageNum);
            if (mySeq !== rgState.focusRenderSeq) return;

            const baseVp = page.getViewport({ scale: 1.0 });
            const fitScale = stitchW / Math.max(1, baseVp.width * crop.w);
            const renderScale = Number((fitScale * dpr).toFixed(3));
            const cacheKey = `${tab}_${crop.pageOffset}_${Math.round(renderScale * 100)}`;

            let fullCanvas = rgState.focusPageCache.get(cacheKey);
            if (!fullCanvas) {
                const renderVp = page.getViewport({ scale: renderScale });
                fullCanvas = document.createElement('canvas');
                fullCanvas.width = Math.max(1, Math.round(renderVp.width));
                fullCanvas.height = Math.max(1, Math.round(renderVp.height));
                const fctx = fullCanvas.getContext('2d', { alpha: false });
                fctx.fillStyle = '#ffffff';
                fctx.fillRect(0, 0, fullCanvas.width, fullCanvas.height);
                await page.render({ canvasContext: fctx, viewport: renderVp }).promise;
                if (mySeq !== rgState.focusRenderSeq) return;
                rgState.focusPageCache.set(cacheKey, fullCanvas);
            }

            const sx = Math.max(0, Math.floor(crop.x * fullCanvas.width));
            const sy = Math.max(0, Math.floor(crop.y * fullCanvas.height));
            const sw = Math.max(1, Math.min(fullCanvas.width - sx, Math.round(crop.w * fullCanvas.width)));
            const sh = Math.max(1, Math.min(fullCanvas.height - sy, Math.round(crop.h * fullCanvas.height)));

            const logicalW = stitchW;
            const logicalH = Math.max(32, Math.round(sh / dpr));

            const canvas = document.createElement('canvas');
            canvas.width = sw;
            canvas.height = sh;
            canvas.style.width = logicalW + 'px';
            canvas.style.height = logicalH + 'px';
            const ctx = canvas.getContext('2d', { alpha: false });
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, sw, sh);
            ctx.drawImage(fullCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

            prepared.push({
                sliceIdx,
                pageNum,
                crop,
                canvas,
                topPx: totalH,
                bottomPx: totalH + logicalH,
                logicalH
            });
            totalH += logicalH;
        }

        if (mySeq !== rgState.focusRenderSeq) return;

        const stageEl = document.createElement('div');
        stageEl.className = 'rg-stage draw-mode rg-focus-stitch-stage';
        stageEl.style.width = stitchW + 'px';
        stageEl.style.height = totalH + 'px';

        prepared.forEach((p, idx) => {
            stageEl.appendChild(p.canvas);
            if (idx > 0) {
                const seam = document.createElement('div');
                seam.className = 'rg-focus-seam-line';
                seam.style.top = p.topPx + 'px';
                const badge = document.createElement('span');
                badge.className = 'rg-focus-seam-badge';
                badge.textContent = `P${prepared[idx - 1].pageNum} / P${p.pageNum}`;
                seam.appendChild(badge);
                stageEl.appendChild(seam);
            }
        });

        const layerEl = document.createElement('div');
        layerEl.className = 'rg-box-layer';
        stageEl.appendChild(layerEl);
        container.appendChild(stageEl);

        rgState.focusStitch = {
            stageEl,
            layerEl,
            width: stitchW,
            totalH,
            slices: prepared.map(({ sliceIdx, pageNum, crop, topPx, bottomPx, logicalH }) => ({
                sliceIdx, pageNum, crop, topPx, bottomPx, logicalH
            }))
        };

        stageEl.addEventListener('pointerdown', (e) => {
            if (rgState.focusResize) return;
            if (e.isPrimary === false) return;
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            if (e.target && e.target.closest && (e.target.closest('.rg-handle') || e.target.closest('.rg-box-del'))) {
                return;
            }
            if (document.activeElement && document.activeElement.tagName === 'INPUT') {
                document.activeElement.blur();
            }
            e.preventDefault();
            try { stageEl.setPointerCapture(e.pointerId); } catch (_) {}
            const rect = stageEl.getBoundingClientRect();
            const ptY = clamp01((e.clientY - rect.top) / Math.max(1, rect.height));
            const yPx = ptY * totalH;
            const draftEl = document.createElement('div');
            draftEl.className = 'rg-box draft';
            layerEl.appendChild(draftEl);
            rgState.focusDrag = {
                pointerId: e.pointerId,
                stageEl,
                totalH,
                startYPx: yPx,
                curYPx: yPx,
                draftEl
            };
        });

        renderFocusSliceOverlays();
    }

    function bindFocusDialogEventsOnce() {
        if (focusDialogEventsBound) return;
        focusDialogEventsBound = true;

        const startInp = document.getElementById('rg-focus-start-input');
        const stemBtn = document.getElementById('rg-subtarget-stem');
        const subqBtn = document.getElementById('rg-subtarget-subq');
        const twoTapBtn = document.getElementById('rg-focus-twotap-btn');
        const zoomOutBtn = document.getElementById('rg-focus-zoom-out');
        const zoomInBtn = document.getElementById('rg-focus-zoom-in');
        const undoBtn = document.getElementById('rg-focus-undo-btn');
        const doneBtn = document.getElementById('rg-focus-done-btn');
        const viewportEl = document.getElementById('rg-focus-viewport');

        if (startInp) {
            startInp.addEventListener('input', () => {
                const it = getFocusActiveItem();
                if (!it) return;
                const raw = String(startInp.value || '').trim();
                if (/^\d+$/.test(raw) && parseInt(raw, 10) > 0) {
                    rgUpdateItemLabel(it.id, raw);
                }
            });
            startInp.addEventListener('blur', () => {
                const it = getFocusActiveItem();
                if (!it) return;
                const raw = String(startInp.value || '').trim();
                if (!/^\d+$/.test(raw) || parseInt(raw, 10) <= 0) {
                    startInp.value = it.label || '1';
                    showToast('首题题号须为正整数', 'warn');
                } else {
                    renderSidebar();
                }
            });
        }

        if (stemBtn) stemBtn.addEventListener('click', () => rgSetSubDrawTarget('stem'));
        if (subqBtn) subqBtn.addEventListener('click', () => rgSetSubDrawTarget('subq'));
        if (twoTapBtn) {
            twoTapBtn.addEventListener('click', () => {
                rgState.twoTapMode = !rgState.twoTapMode;
                rgState.focusTwoTapStart = null;
                syncInteractModeUi();
                renderSubModeBar();
            });
        }
        if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => rgFocusZoomBy(-0.15));
        if (zoomInBtn) zoomInBtn.addEventListener('click', () => rgFocusZoomBy(0.15));
        if (undoBtn) undoBtn.addEventListener('click', () => rgUndoSubBox());
        if (doneBtn) doneBtn.addEventListener('click', () => rgRequestExitSubMode());

        if (viewportEl) {
            let wheelAt = 0;
            viewportEl.addEventListener('wheel', (e) => {
                if (!e.ctrlKey && !e.metaKey) return;
                e.preventDefault();
                const now = Date.now();
                if (now - wheelAt < 80) return;
                wheelAt = now;
                rgFocusZoomBy(e.deltaY < 0 ? 0.15 : -0.15);
            }, { passive: false });
        }

        const cleanupFocusDraft = () => {
            if (!rgState.focusDrag) return null;
            const d = rgState.focusDrag;
            rgState.focusDrag = null;
            if (d.draftEl && d.draftEl.parentNode) {
                d.draftEl.parentNode.removeChild(d.draftEl);
            }
            return d;
        };

        window.addEventListener('pointermove', (e) => {
            if (rgState.focusResize && rgState.focusResize.pointerId === e.pointerId) {
                const rz = rgState.focusResize;
                const dyPx = e.clientY - rz.startClientY;
                const minPx = 8;
                let newTop = rz.origTopPx;
                let newBot = rz.origBotPx;
                if (rz.edge === 'n') {
                    newTop = Math.max(0, Math.min(rz.origBotPx - minPx, rz.origTopPx + dyPx));
                } else if (rz.edge === 's') {
                    newBot = Math.max(rz.origTopPx + minPx, Math.min(rz.stitch.totalH, rz.origBotPx + dyPx));
                }
                rz.curTopPx = newTop;
                rz.curBotPx = newBot;
                if (rz.boxEl) {
                    rz.boxEl.style.top = ((newTop / Math.max(1, rz.stitch.totalH)) * 100) + '%';
                    rz.boxEl.style.height = (((newBot - newTop) / Math.max(1, rz.stitch.totalH)) * 100) + '%';
                }
                return;
            }

            if (!rgState.focusDrag || rgState.focusDrag.pointerId !== e.pointerId) return;
            const d = rgState.focusDrag;
            const rect = d.stageEl.getBoundingClientRect();
            const ptY = clamp01((e.clientY - rect.top) / Math.max(1, rect.height));
            d.curYPx = ptY * d.totalH;
            const topPx = Math.min(d.startYPx, d.curYPx);
            const hPx = Math.abs(d.curYPx - d.startYPx);
            d.draftEl.style.left = '0%';
            d.draftEl.style.width = '100%';
            d.draftEl.style.top = ((topPx / Math.max(1, d.totalH)) * 100) + '%';
            d.draftEl.style.height = ((hPx / Math.max(1, d.totalH)) * 100) + '%';
        });

        const finishFocusPointer = (e) => {
            if (rgState.focusResize && rgState.focusResize.pointerId === e.pointerId) {
                const rz = rgState.focusResize;
                rgState.focusResize = null;
                const it = getFocusActiveItem();
                if (it && rz.stitch) {
                    const rects = splitStitchRangeToRects(rz.curTopPx, rz.curBotPx, rz.stitch);
                    if (rects.length > 0) {
                        if (rz.kind === 'stem') {
                            const oldSet = new Set(rz.groupBoxes);
                            const firstIdx = Math.max(0, (it.stemBoxes || []).findIndex(b => oldSet.has(b)));
                            const linkId = rects.length > 1
                                ? ((rz.groupBoxes[0] && rz.groupBoxes[0].linkId) || `stem_${Date.now()}_${rgState.nextSeq++}`)
                                : '';
                            const newItems = rects.map(r => (linkId ? { ...r, linkId } : r));
                            const kept = (it.stemBoxes || []).filter(b => !oldSet.has(b));
                            kept.splice(Math.min(firstIdx, kept.length), 0, ...newItems);
                            it.stemBoxes = kept;
                        } else if (rz.groupBoxes[0]) {
                            let bestRect = rects[0];
                            if (rects.length > 1) {
                                let bestScore = -1;
                                rects.forEach((r) => {
                                    const sIdx = findBestSliceForBox(r, rz.stitch.slices);
                                    const s = sIdx >= 0 ? rz.stitch.slices[sIdx] : null;
                                    const pxH = s ? (r.h / Math.max(0.001, s.crop.h)) * s.logicalH : r.h;
                                    if (pxH > bestScore) {
                                        bestScore = pxH;
                                        bestRect = r;
                                    }
                                });
                            }
                            Object.assign(rz.groupBoxes[0], bestRect);
                        }
                    }
                }
                renderAllRg();
                scheduleDraftSave();
                return;
            }

            if (!rgState.focusDrag || rgState.focusDrag.pointerId !== e.pointerId) return;
            const d = cleanupFocusDraft();
            if (!d) return;

            const dyPx = Math.abs(d.curYPx - d.startYPx);

            if (rgState.twoTapMode && dyPx < 8) {
                if (!rgState.focusTwoTapStart) {
                    rgState.focusTwoTapStart = { yPx: d.curYPx };
                    renderFocusSliceOverlays();
                    return;
                }
                const startY = rgState.focusTwoTapStart.yPx;
                rgState.focusTwoTapStart = null;
                if (Math.abs(d.curYPx - startY) < 8) {
                    renderFocusSliceOverlays();
                    return;
                }
                commitStitchedDrawRange(startY, d.curYPx);
                return;
            }

            if (dyPx < 8) return;

            rgState.focusTwoTapStart = null;
            commitStitchedDrawRange(d.startYPx, d.curYPx);
        };

        window.addEventListener('pointerup', finishFocusPointer);
        window.addEventListener('pointercancel', (e) => {
            if (rgState.focusResize && rgState.focusResize.pointerId === e.pointerId) {
                rgState.focusResize = null;
                renderAllRg();
            }
            cleanupFocusDraft();
        });
    }

    async function rgFocusZoomBy(delta) {
        rgState.focusZoom = Math.max(0.6, Math.min(2.2, Number((rgState.focusZoom + delta).toFixed(2))));
        const zoomVal = document.getElementById('rg-focus-zoom-val');
        if (zoomVal) zoomVal.textContent = Math.round(rgState.focusZoom * 100) + '%';
        await renderFocusSlices();
    }

    async function openFocusSubMode(itemId) {
        const tab = rgState.activeTab;
        const tabState = getTabState(tab);
        const it = tabState.items.find(x => x.id === itemId);
        if (!it) return;

        bindFocusDialogEventsOnce();
        it.isBig = true;
        it.stemBoxes = it.stemBoxes || [];
        it.subqBoxes = it.subqBoxes || [];
        rgState.subMode = {
            tab,
            itemId,
            target: it.stemBoxes.length === 0 ? 'stem' : 'subq'
        };
        rgState.selectedId = itemId;
        rgState.focusTwoTapStart = null;
        rgState.focusDrag = null;
        rgState.focusResize = null;

        const dlg = document.getElementById('rg-focus-dialog');
        if (dlg) {
            if (typeof openNativeDialog === 'function') {
                openNativeDialog(dlg, { dismissible: false });
            } else {
                dlg.classList.add('active');
                if (typeof dlg.showModal === 'function' && !dlg.open) dlg.showModal();
            }
        }
        renderAllRg();
        await new Promise(r => requestAnimationFrame(r));
        await renderFocusSlices();
        scheduleDraftSave();
    }

    function rgRequestExitSubMode() {
        const it = getFocusActiveItem();
        if (!it) {
            window.rgExitSubMode();
            return;
        }
        if (!Array.isArray(it.subqBoxes) || it.subqBoxes.length === 0) {
            if (typeof showCustomDialog === 'function') {
                showCustomDialog({
                    title: '尚未框选小问',
                    body: '当前大题还没有框选任何小问。您可以继续留在专注模式框选小问，或取消大题设置（恢复为普通单题）。',
                    confirmText: '继续框选',
                    cancelText: '取消大题设置',
                    onConfirm: () => {
                        rgSetSubDrawTarget('subq');
                    },
                    onCancel: () => {
                        it.isBig = false;
                        it.stemBoxes = [];
                        it.subqBoxes = [];
                        window.rgExitSubMode();
                    }
                });
                return;
            }
        }
        window.rgExitSubMode();
    }

    window.rgEnterSubMode = async function (itemId) {
        const tab = rgState.activeTab;
        const tabState = getTabState(tab);
        const it = tabState.items.find(x => x.id === itemId);
        if (!it) return;

        const existingLabel = String(it.label || '').trim();
        const hasValidStartNum = /^\d+$/.test(existingLabel) && parseInt(existingLabel, 10) > 0;
        if (!it.isBig || !hasValidStartNum) {
            const startNum = await promptBigQuestionStartNum(it);
            if (!startNum) return;
            it.label = String(startNum);
            if (Array.isArray(it.subqBoxes) && it.subqBoxes.length > 0) {
                let cursor = startNum;
                it.subqBoxes.forEach((sb) => {
                    if (!sb.customNum) sb.num = cursor;
                    const parsed = parseInt(sb.num, 10);
                    cursor = (!isNaN(parsed) && parsed >= cursor) ? (parsed + 1) : (cursor + 1);
                });
            }
        }

        await openFocusSubMode(itemId);
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
        if (rgState.subMode.target === 'subq' && it.subqBoxes.length > 0) {
            it.subqBoxes.pop();
        } else if (it.stemBoxes.length > 0) {
            const last = it.stemBoxes[it.stemBoxes.length - 1];
            if (last && last.linkId) {
                it.stemBoxes = it.stemBoxes.filter(sb => sb.linkId !== last.linkId);
            } else {
                it.stemBoxes.pop();
            }
            if (it.stemBoxes.length === 0) {
                rgState.subMode.target = 'stem';
            }
        }
        renderAllRg();
        scheduleDraftSave();
    };

    window.rgExitSubMode = function () {
        rgState.subMode = null;
        rgState.focusTwoTapStart = null;
        rgState.focusDrag = null;
        rgState.focusResize = null;
        rgState.focusStitch = null;
        closeFocusDialogSafe();
        renderAllRg();
        scheduleDraftSave();
    };

    window.rgDeleteItem = function (itemId) {
        const tabState = getTabState();
        tabState.items = tabState.items.filter(x => x.id !== itemId);
        if (rgState.selectedId === itemId) rgState.selectedId = null;
        if (rgState.continueTargetId === itemId) rgState.continueTargetId = null;
        if (rgState.subMode && rgState.subMode.itemId === itemId) {
            rgState.subMode = null;
            closeFocusDialogSafe();
        }
        renderAllRg();
        scheduleDraftSave();
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
                const ctx = srcCanvas.getContext('2d', { alpha: false });
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, srcCanvas.width, srcCanvas.height);
                await page.render({ canvasContext: ctx, viewport }).promise;
                page.cleanup();
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
            const octx = out.getContext('2d', { alpha: false });
            octx.fillStyle = '#ffffff';
            octx.fillRect(0, 0, out.width, out.height);
            octx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
            const dataUrl = out.toDataURL('image/jpeg', 0.82);
            out.width = 0;
            out.height = 0;
            return dataUrl;
        } catch (err) {
            return null;
        }
    }

    function releaseCanvasCache(cacheMap) {
        if (!cacheMap) return;
        cacheMap.forEach(c => {
            if (c) {
                c.width = 0;
                c.height = 0;
            }
        });
        cacheMap.clear();
    }

    function collectExistingStep4FieldMap() {
        const byId = new Map();
        const byVarSig = new Map();
        if (!Array.isArray(currentQuestions)) return { byId, byVarSig };
        currentQuestions.forEach(q => {
            if (!q) return;
            const fields = {
                topic: q.topic || '',
                videoUrl: q.videoUrl || q.video_url || ''
            };
            if (q.id !== undefined && q.id !== null) {
                byId.set(String(q.id).trim(), fields);
            }
            const pNums = Array.isArray(q.parentQuestionNums) && q.parentQuestionNums.length > 0
                ? [...q.parentQuestionNums].sort((a, b) => a - b)
                : (q.parentQuestionNum ? [Number(q.parentQuestionNum)] : []);
            if (pNums.length > 0) {
                const key = `${pNums.join(',')}#${q.subNum || 1}`;
                byVarSig.set(key, fields);
            }
        });
        return { byId, byVarSig };
    }

    window.rgFinishAndImport = async function () {
        if (!hasRegionDebugPermission()) {
            showToast('整卷框题仅限管理员使用', 'warn');
            return;
        }
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
                showToast('预习模式请先为每道框选题目手动输入题号', 'warn');
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

        const prevFields = collectExistingStep4FieldMap();
        const finishBtn = document.getElementById('rg-finish-btn');
        if (finishBtn) {
            finishBtn.disabled = true;
            setBtnLabel(finishBtn, '正在上传原卷并导入');
        }

        const exPageCache = new Map();
        const ansPageCache = new Map();

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
                    const prevVar = prevFields.byVarSig.get(`${pNums.join(',')}#${nextSub}`);
                    const inheritedTopic = (hwQ && hwQ.topic) ? String(hwQ.topic).trim() : (prevVar ? prevVar.topic : '');
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
                        videoUrl: prevVar ? prevVar.videoUrl : '',
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
                        const prev = prevFields.byId.get(qKey);
                        imported.push({
                            id: qKey,
                            topic: prev ? prev.topic : '',
                            videoUrl: prev ? prev.videoUrl : '',
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
                const prev = prevFields.byId.get(qKey);
                imported.push({
                    id: qKey,
                    topic: prev ? prev.topic : '',
                    videoUrl: prev ? prev.videoUrl : '',
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
            console.error('Region import error:', err);
            showToast('导入失败：' + (err.message || '网络异常'), 'error');
        } finally {
            releaseCanvasCache(exPageCache);
            releaseCanvasCache(ansPageCache);
            if (finishBtn) {
                finishBtn.disabled = false;
                setBtnLabel(finishBtn, '完成框选并导入第 4 步');
            }
        }
    };
})();
