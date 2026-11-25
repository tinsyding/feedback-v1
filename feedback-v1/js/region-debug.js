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
        continueFocus: null, // { tab, itemId, candidatePages: number[], addedStack: object[] }
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
            items: [],
            pageTextCache: new Map(),
            pageTextPromises: new Map()
        },
        answer: {
            file: null,
            pdfDoc: null,
            pageNum: 1,
            totalPages: 0,
            items: [],
            pageTextCache: new Map(),
            pageTextPromises: new Map()
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

    function getSubqRegions(qb) {
        if (!qb) return [];
        if (!Array.isArray(qb.regions) || qb.regions.length === 0) {
            if (typeof qb.x === 'number' && typeof qb.y === 'number') {
                qb.regions = [{
                    pageOffset: parseInt(qb.pageOffset, 10) || 0,
                    x: round4(qb.x),
                    y: round4(qb.y),
                    w: round4(qb.w),
                    h: round4(qb.h)
                }];
            } else {
                qb.regions = [];
            }
        }
        return qb.regions;
    }

    function syncSubqPrimaryFields(qb) {
        const regs = getSubqRegions(qb);
        regs.sort((a, b) =>
            ((parseInt(a.pageOffset, 10) || 0) - (parseInt(b.pageOffset, 10) || 0))
            || ((Number(a.y) || 0) - (Number(b.y) || 0))
        );
        if (regs.length > 0) {
            qb.pageOffset = regs[0].pageOffset;
            qb.x = regs[0].x;
            qb.y = regs[0].y;
            qb.w = regs[0].w;
            qb.h = regs[0].h;
        }
    }

    function formatSubqPagesLabel(qb) {
        const regs = getSubqRegions(qb);
        const pages = Array.from(new Set(regs.map(r => 'P' + ((parseInt(r.pageOffset, 10) || 0) + 1))));
        return pages.join('~') || 'P1';
    }

    function filterSignificantStitchRects(rawRects, stitch) {
        if (!Array.isArray(rawRects) || rawRects.length <= 1 || !stitch) return rawRects || [];
        const scored = rawRects.map((r) => {
            const sIdx = findBestSliceForBox(r, stitch.slices);
            const s = sIdx >= 0 ? stitch.slices[sIdx] : null;
            const pxH = s ? (r.h / Math.max(0.001, s.crop.h)) * s.logicalH : 0;
            return { rect: r, pxH };
        });
        const significant = scored.filter(x => x.pxH >= 10).map(x => x.rect);
        if (significant.length > 0) return significant;
        scored.sort((a, b) => b.pxH - a.pxH);
        return [scored[0].rect];
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
        rgState.exercise = { file: null, pdfDoc: null, pageNum: 1, totalPages: 0, items: [], pageTextCache: new Map(), pageTextPromises: new Map() };
        rgState.answer = { file: null, pdfDoc: null, pageNum: 1, totalPages: 0, items: [], pageTextCache: new Map(), pageTextPromises: new Map() };
        rgState.selectedId = null;
        rgState.continueTargetId = null;
        rgState.subMode = null;
        rgState.continueFocus = null;
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
                const resizedItemId = rgState.resize.itemId;
                const resizedKind = rgState.resize.kind;
                const resizedBoxRef = rgState.resize.boxRef;
                rgState.resize = null;
                const resizedItem = getTabState().items.find(x => x.id === resizedItemId);
                if (resizedItem && resizedItem.isBig) {
                    if (resizedKind === 'subq' && resizedBoxRef) {
                        const parentSubq = (resizedItem.subqBoxes || []).find(qb => getSubqRegions(qb).includes(resizedBoxRef));
                        if (parentSubq) syncSubqPrimaryFields(parentSubq);
                    }
                    syncAutoStemBoxes(resizedItem);
                } else if (
                    resizedItem
                    && !resizedItem.isBig
                    && resizedKind === 'region'
                    && getCurrentBankTypeSafe() === 'preview'
                    && !String(resizedItem.label || '').trim()
                    && Array.isArray(resizedItem.regions)
                    && resizedItem.regions[0] === resizedBoxRef
                ) {
                    applyPreviewAutoDetectIfEmpty(rgState.activeTab, resizedItem, resizedBoxRef);
                }
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
            const focusMode = getActiveFocusMode();
            const inFocus = Boolean(focusMode && focusDlg && (focusDlg.open || focusDlg.classList.contains('active')));
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
                    if (focusMode === 'continue') {
                        rgUndoContinueSlice();
                    } else {
                        rgUndoSubBox();
                    }
                    return;
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    if (rgState.focusTwoTapStart) {
                        rgState.focusTwoTapStart = null;
                        renderFocusSliceOverlays();
                    } else if (focusMode === 'continue') {
                        rgExitContinueFocus();
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

    function fallbackParseQuestionCandidate(raw, allowBareNumber = true) {
        if (typeof window.parseQuestionNumberCandidate === 'function') {
            return window.parseQuestionNumberCandidate(raw, allowBareNumber);
        }
        let s = String(raw || '')
            .replace(/\u00a0/g, ' ')
            .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
            .trim();
        if (!s) return null;
        for (let i = 0; i < 6; i++) {
            const prev = s;
            s = s
                .replace(/^[★☆◆◇●○■□▲△▶▷•·▪▫➢➤]+\s*/, '')
                .replace(/^[【\[][^】\]]{1,12}[】\]]\s*/, '')
                .replace(/^[（(]\s*(?:[A-Ga-g]{1,4}|[√×]|预习|课前|课堂|课后|多选|单选|双选|不定项|选做|必做|选填|填空|解答|计算|实验|探究|难点|易错|拔高|巩固|提升|拓展|变式|典例|例题|例|真题|模拟|原创|改编)?\s*[）)]\s*/, '')
                .replace(/^(?:典例|例题|例|变式|拓展|预习|课前)[\s:：·\-]*/, '')
                .trim();
            if (s === prev) break;
        }
        s = s.replace(/\s+/g, '');
        if (!s || /第\d+页|共\d+页|page\d+/i.test(s) || /^\d{1,3}\/\d{1,3}/.test(s)) return null;
        const norm = (v) => {
            const n = parseInt(v, 10);
            return Number.isInteger(n) && n >= 1 && n <= 300 ? n : null;
        };
        let m = s.match(/^第(\d{1,3})题/);
        if (m) { const n = norm(m[1]); if (n !== null) return { num: n, kind: 'explicit' }; }
        m = s.match(/^(\d{1,3})(?:[.．、,，:：]|题)(?![0-9])/);
        if (m) { const n = norm(m[1]); if (n !== null) return { num: n, kind: 'dotted' }; }
        m = s.match(/^(\d{1,3})[)）](?![0-9])/);
        if (m) { const n = norm(m[1]); if (n !== null) return { num: n, kind: 'rparen' }; }
        m = s.match(/^[（(](\d{1,3})[）)](?:[.．、,，:：]|题)?/);
        if (m) { const n = norm(m[1]); if (n !== null) return { num: n, kind: 'parens' }; }
        if (allowBareNumber && /^\d{1,3}$/.test(s)) {
            const n = norm(s);
            if (n !== null) return { num: n, kind: 'bare' };
        }
        return null;
    }

    function ensurePageTextData(tab, pageNum) {
        const tabState = getTabState(tab);
        if (!tabState || !tabState.pdfDoc || !pageNum) return Promise.resolve(null);
        if (!tabState.pageTextCache) tabState.pageTextCache = new Map();
        if (!tabState.pageTextPromises) tabState.pageTextPromises = new Map();

        if (tabState.pageTextCache.has(pageNum)) {
            return Promise.resolve(tabState.pageTextCache.get(pageNum));
        }
        if (tabState.pageTextPromises.has(pageNum)) {
            return tabState.pageTextPromises.get(pageNum);
        }

        const pdfDocRef = tabState.pdfDoc;
        const promise = (async () => {
            try {
                const page = await pdfDocRef.getPage(pageNum);
                const viewport = page.getViewport({ scale: 1 });
                const textContent = await page.getTextContent();
                const w = Number(viewport.width) || 1;
                const h = Number(viewport.height) || 1;
                const utilTransform = (typeof pdfjsLib !== 'undefined' && pdfjsLib && pdfjsLib.Util && typeof pdfjsLib.Util.transform === 'function')
                    ? pdfjsLib.Util.transform
                    : null;

                const items = [];
                const rawItems = (textContent && Array.isArray(textContent.items)) ? textContent.items : [];
                for (let i = 0; i < rawItems.length; i++) {
                    const it = rawItems[i];
                    if (!it || typeof it.str !== 'string' || !it.str.trim() || !Array.isArray(it.transform)) continue;
                    let vx, vy, fontSize;
                    if (utilTransform) {
                        const tr = utilTransform(viewport.transform, it.transform);
                        vx = Number(tr[4]) || 0;
                        vy = Number(tr[5]) || 0;
                        fontSize = Math.hypot(Number(tr[2]) || 0, Number(tr[3]) || 0) || Math.hypot(Number(tr[0]) || 0, Number(tr[1]) || 0) || 0;
                    } else {
                        vx = Number(it.transform[4]) || 0;
                        vy = h - (Number(it.transform[5]) || 0);
                        fontSize = Math.hypot(Number(it.transform[2]) || 0, Number(it.transform[3]) || 0) || 0;
                    }
                    items.push({
                        text: it.str.trim(),
                        vx,
                        vy,
                        nx: vx / w,
                        ny: (vy - fontSize * 0.35) / h,
                        fontSize
                    });
                }
                const data = { width: w, height: h, items };
                if (tabState.pdfDoc === pdfDocRef) {
                    tabState.pageTextCache.set(pageNum, data);
                }
                return data;
            } catch (_) {
                return null;
            } finally {
                tabState.pageTextPromises.delete(pageNum);
            }
        })();

        tabState.pageTextPromises.set(pageNum, promise);
        return promise;
    }

    function detectQuestionNumberInRegion(pageData, rectObj) {
        if (!pageData || !Array.isArray(pageData.items) || pageData.items.length === 0 || !rectObj) return null;
        const rx = Number(rectObj.x) || 0;
        const ry = Number(rectObj.y) || 0;
        const rw = Math.max(0.01, Number(rectObj.w) || 0);
        const rh = Math.max(0.01, Number(rectObj.h) || 0);

        const padX = 0.015;
        const padY = 0.008;
        const inBox = [];
        for (let i = 0; i < pageData.items.length; i++) {
            const it = pageData.items[i];
            if (it.fontSize > 0 && it.fontSize < 6.5) continue;
            if (it.nx < rx - padX || it.nx > rx + rw + 0.01) continue;
            if (it.ny < ry - padY || it.ny > ry + rh + padY) continue;
            inBox.push(it);
        }
        if (inBox.length === 0) return null;

        inBox.sort((a, b) => a.vy - b.vy || a.vx - b.vx);

        const lines = [];
        for (let i = 0; i < inBox.length; i++) {
            const it = inBox[i];
            let line = null;
            for (let j = lines.length - 1; j >= 0; j--) {
                const l = lines[j];
                const tol = Math.max(4, Math.min(it.fontSize || 10, l.fontSize || 10) * 0.45);
                if (Math.abs(l.vy - it.vy) <= tol) {
                    line = l;
                    break;
                }
                if (it.vy - l.vy > 20) break;
            }
            if (!line) {
                line = { vy: it.vy, ny: it.ny, fontSize: it.fontSize || 10, items: [] };
                lines.push(line);
            }
            line.items.push(it);
        }

        let boxMinX = Infinity;
        for (let i = 0; i < inBox.length; i++) {
            if (inBox[i].nx < boxMinX) boxMinX = inBox[i].nx;
        }

        const kindScore = {
            explicit: 130,
            dotted: 120,
            rparen: 105,
            parens: 85,
            bare: 70
        };

        const candidates = [];
        const maxLines = Math.min(3, lines.length);
        for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
            const line = lines[lineIdx];
            line.items.sort((a, b) => a.vx - b.vx);
            const first = line.items[0];
            if (!first) continue;

            const lineDeltaY = line.ny - ry;
            const lineRelY = lineDeltaY / rh;
            if (lineIdx > 0 && lineRelY > 0.55 && lineDeltaY > 0.08) break;

            const relX = (first.nx - rx) / rw;
            const nearLeft = relX <= 0.25 || (first.nx - boxMinX) <= 0.06;

            const compact = line.items.map(item => item.text.replace(/\s+/g, '')).join('');
            const isExplicit = /第\d{1,3}题/.test(compact);
            if (!nearLeft && !(isExplicit && relX <= 0.45)) continue;

            const allowBare = lineIdx === 0 && nearLeft && relX <= 0.18;
            let parsed = fallbackParseQuestionCandidate(compact, allowBare);

            // 若整行合并后未命中（例如题号单独数字后紧跟空格和中文题干），尝试行首独立数字
            if (!parsed && allowBare) {
                const firstClean = first.text
                    .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
                    .trim();
                if (/^\d{1,3}$/.test(firstClean)) {
                    const nextItem = line.items[1];
                    const nextText = nextItem ? nextItem.text.trim() : '';
                    // 排除紧跟物理/数学单位或运算符号的情况（如 "20 W" / "10 cm" / "3 ="）
                    const looksLikeUnitOrMath = /^(?:[a-zA-Z]{1,3}\b|[%℃°=+\-×÷/·<>≤≥])/.test(nextText);
                    if (!looksLikeUnitOrMath) {
                        parsed = fallbackParseQuestionCandidate(firstClean, true);
                    }
                }
            }

            // 行内文字被拆分且前导标签占多段时，再尝试前几个 item 单独匹配（不允许裸数字）
            if (!parsed) {
                for (let k = 0; k < Math.min(6, line.items.length); k++) {
                    const sub = line.items[k];
                    if (!isExplicit && (sub.nx - rx) / rw > 0.30 && (sub.nx - boxMinX) > 0.10) break;
                    const p = fallbackParseQuestionCandidate(sub.text, false);
                    if (p) {
                        parsed = p;
                        break;
                    }
                }
            }

            if (!parsed) continue;
            // 非首行不采纳括号小问（如“（1）”）和裸数字，避免把正文小问当成大题号
            if (lineIdx > 0 && (parsed.kind === 'parens' || parsed.kind === 'bare')) continue;

            let score = kindScore[parsed.kind] || 60;
            if (lineIdx === 0) score += 25;
            else if (lineIdx === 1) score += 10;
            if (first.nx - boxMinX <= 0.02) score += 15;
            if (relX <= 0.15) score += 10;
            if (first.fontSize >= 9) score += 5;

            candidates.push({ num: parsed.num, score, lineIdx, nx: first.nx });
        }

        if (candidates.length === 0) return null;
        candidates.sort((a, b) => b.score - a.score || a.lineIdx - b.lineIdx || a.nx - b.nx);
        return candidates[0].num;
    }

    window.rgDetectQuestionNumberInRegion = detectQuestionNumberInRegion;

    function applyPreviewAutoDetectIfEmpty(tab, item, rectObj, opts = {}) {
        if (!item || !rectObj) return false;
        const tabState = getTabState(tab);
        if (!tabState || !tabState.pdfDoc) return false;
        const pageNum = (parseInt(rectObj.pageOffset, 10) || 0) + 1;
        const cached = tabState.pageTextCache && tabState.pageTextCache.get(pageNum);
        if (cached) {
            const detected = detectQuestionNumberInRegion(cached, rectObj);
            if (detected !== null && !String(item.label || '').trim()) {
                item.label = String(detected);
                item.autoDetected = true;
                return true;
            }
            return false;
        }

        ensurePageTextData(tab, pageNum).then((pageData) => {
            if (!pageData) return;
            const curTabState = getTabState(tab);
            if (!curTabState || !curTabState.items.includes(item)) return;
            if (String(item.label || '').trim()) return;
            const detected = detectQuestionNumberInRegion(pageData, rectObj);
            if (detected !== null) {
                item.label = String(detected);
                item.autoDetected = true;
                renderAllRg();
                scheduleDraftSave();
            } else if (opts.focusOnMiss) {
                requestAnimationFrame(() => {
                    const input = document.querySelector(`.rg-card[data-id="${item.id}"] .rg-num-input`);
                    if (input && !input.value) {
                        input.focus();
                        input.select();
                    }
                });
            }
        });
        return null; // async pending
    }

    function onBoxDrawn(tab, rectObj) {
        const tabState = getTabState(tab);

        // 1. 大题内部细分模式（直接框选小问，公共原文自动由大题上界至首小问上界判定）
        if (rgState.subMode && rgState.subMode.tab === tab) {
            const parentItem = tabState.items.find(it => it.id === rgState.subMode.itemId);
            if (!parentItem) {
                rgState.subMode = null;
                renderAllRg();
                return;
            }
            parentItem.subqBoxes = parentItem.subqBoxes || [];
            const baseNum = parseInt(parentItem.label, 10) || 1;
            const nextSubNum = parentItem.subqBoxes.length === 0
                ? baseNum
                : (Math.max(...parentItem.subqBoxes.map(b => parseInt(b.num, 10) || baseNum)) + 1);
            parentItem.subqBoxes.push({ ...rectObj, num: nextSubNum, customNum: false, regions: [{ ...rectObj }] });
            syncAutoStemBoxes(parentItem);
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
                if (targetItem.isBig) syncAutoStemBoxes(targetItem);
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
            autoDetected: false,
            targetExId,
            parentNums: [],
            isBig: false,
            regions: [rectObj],
            stemBoxes: [],
            subqBoxes: []
        };
        tabState.items.push(newItem);
        rgState.selectedId = newItem.id;

        let previewDetectStatus = false;
        if (bankType === 'preview' && !newItem.label) {
            previewDetectStatus = applyPreviewAutoDetectIfEmpty(tab, newItem, rectObj, { focusOnMiss: true });
        }

        renderAllRg();
        scheduleDraftSave();

        if ((bankType === 'preview' && !newItem.label && previewDetectStatus === false) || (bankType === 'variation' && tab === 'answer')) {
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

        // 预习模式预热当前页文字层缓存，拉框释放时可即时同步识别左上角题号
        if (getCurrentBankTypeSafe() === 'preview') {
            ensurePageTextData(rgState.activeTab, tabState.pageNum);
        }
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
                    div.className = `rg-box stem auto-stem ${rgState.selectedId === it.id ? 'active' : ''}`;
                    div.style.left = (sb.x * 100) + '%';
                    div.style.top = (sb.y * 100) + '%';
                    div.style.width = (sb.w * 100) + '%';
                    div.style.height = (sb.h * 100) + '%';

                    const tag = document.createElement('span');
                    tag.className = 'rg-box-tag';
                    tag.textContent = (it.stemBoxes || []).length > 1 ? `自动原文${sIdx + 1}` : '自动原文';
                    div.appendChild(tag);
                    layer.appendChild(div);
                });
                (it.subqBoxes || []).forEach((qb, qIdx) => {
                    const regs = getSubqRegions(qb);
                    regs.forEach((rg, sIdx) => {
                        if (rg.pageOffset !== pageOffset) return;
                        const div = document.createElement('div');
                        div.className = `rg-box subq ${rgState.selectedId === it.id ? 'active' : ''}`;
                        div.style.left = (rg.x * 100) + '%';
                        div.style.top = (rg.y * 100) + '%';
                        div.style.width = (rg.w * 100) + '%';
                        div.style.height = (rg.h * 100) + '%';

                        const tag = document.createElement('span');
                        tag.className = 'rg-box-tag';
                        tag.textContent = regs.length > 1 ? `${qb.num} (${sIdx + 1}/${regs.length})` : `${qb.num}`;
                        div.appendChild(tag);

                        appendResizeHandles(div, 'subq', it.id, rg);

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
                tipEl.textContent = '预习模式：拉框后自动识别左上角题号（可随时修改）；选中框可拖边缘微调';
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

        const viewportEl = document.getElementById('rg-viewport');
        if (contBanner && contText) {
            if (rgState.continueTargetId) {
                const target = tabState.items.find(it => it.id === rgState.continueTargetId);
                contBanner.style.display = 'flex';
                contText.textContent = `正在为「${target ? formatItemTitle(target, tab) : '当前题'}」追加跨页区域：请翻页后拉框`;
                if (viewportEl) viewportEl.classList.add('continue-active');
            } else {
                contBanner.style.display = 'none';
                if (viewportEl) viewportEl.classList.remove('continue-active');
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
                const stemChips = stemGroups.map((sg) => {
                    const pLabels = Array.from(new Set(sg.boxes.map(b => 'P' + ((b.pageOffset || 0) + 1)))).join('~');
                    return `
                        <span class="rg-subq-chip stem-chip" title="大题上界至第 1 小问上界自动判定 (${escapeHtmlRg(pLabels)})">
                            <span>自动原文${sg.boxes.length > 1 ? `(${escapeHtmlRg(pLabels)})` : ''}</span>
                        </span>
                    `;
                }).join('');
                const subqChips = (it.subqBoxes || []).map((qb, qIdx) => `
                    <span class="rg-subq-chip" title="${escapeHtmlRg(formatSubqPagesLabel(qb))}">
                        <span>#</span>
                        <input type="text" class="rg-subq-num-input" value="${escapeHtmlRg(qb.num)}"
                            onclick="event.stopPropagation()"
                            oninput="rgUpdateSubqNum('${it.id}', ${qIdx}, this.value)"
                            onchange="rgUpdateSubqNum('${it.id}', ${qIdx}, this.value)">
                        <button type="button" class="rg-subq-del-btn" onclick="event.stopPropagation(); rgDeleteSubBox('${it.id}', 'subq', ${qIdx})" title="删除小问框" aria-label="删除小问框"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
                    </span>
                `).join('');
                bigDetailHtml = `
                    <div class="rg-card-submeta">大题 · ${stemGroups.length > 0 ? '自动原文 · ' : ''}小问 ${(it.subqBoxes || []).length}</div>
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
                const autoCls = it.autoDetected ? ' auto-detected' : '';
                const autoTitle = it.autoDetected ? '已自动识别左上角题号，可直接修改' : '';
                headerEditorHtml = `
                    <div class="rg-card-top">
                        <div class="rg-card-num-wrap">
                            <span>${it.isBig ? '起始题号' : '题号'}</span>
                            <input type="text" class="rg-num-input${autoCls}" value="${escapeHtmlRg(it.label)}" placeholder="${placeholder}" title="${autoTitle}"
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
                        ${bankType === 'variation' ? '' : `<button type="button" class="btn sm secondary" onclick="rgEnterSubMode('${it.id}')">${it.isBig ? '继续切分' : '设为大题'}</button>`}
                        <button type="button" class="btn sm secondary" onclick="rgDeleteItem('${it.id}')">删除</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    function getActiveFocusMode() {
        if (rgState.subMode) return 'bigq';
        if (rgState.continueFocus) return 'continue';
        return null;
    }

    function sortRegionsInPlace(it) {
        if (!it || !Array.isArray(it.regions)) return;
        it.regions.sort((a, b) =>
            ((parseInt(a.pageOffset, 10) || 0) - (parseInt(b.pageOffset, 10) || 0))
            || ((Number(a.y) || 0) - (Number(b.y) || 0))
        );
    }

    function renderSubModeBar() {
        const hint = document.getElementById('rg-submode-hint');
        const shortcutNote = document.getElementById('rg-focus-shortcut-note');
        const titleEl = document.getElementById('rg-focus-title');
        const startEditor = document.getElementById('rg-focus-start-editor');
        const startLabel = document.getElementById('rg-focus-start-label');
        const startInp = document.getElementById('rg-focus-start-input');
        const zoomVal = document.getElementById('rg-focus-zoom-val');
        const twoTapBtn = document.getElementById('rg-focus-twotap-btn');
        const freeformBtn = document.getElementById('rg-focus-freeform-btn');
        const toBigqBtn = document.getElementById('rg-focus-to-bigq-btn');
        const undoBtn = document.getElementById('rg-focus-undo-btn');
        const doneBtn = document.getElementById('rg-focus-done-btn');
        const sidebarTitle = document.getElementById('rg-focus-sidebar-title');
        const previewPanel = document.getElementById('rg-continue-preview-panel');

        const focusMode = getActiveFocusMode();
        const activeCtx = rgState.subMode || rgState.continueFocus;
        if (!focusMode || !activeCtx || activeCtx.tab !== rgState.activeTab) {
            closeFocusDialogSafe();
            return;
        }
        const tabState = getTabState(activeCtx.tab);
        const it = tabState.items.find(x => x.id === activeCtx.itemId);
        if (!it) {
            rgState.subMode = null;
            rgState.continueFocus = null;
            closeFocusDialogSafe();
            return;
        }

        const bankType = getCurrentBankTypeSafe();
        if (zoomVal) zoomVal.textContent = Math.round(rgState.focusZoom * 100) + '%';
        if (twoTapBtn) {
            twoTapBtn.classList.toggle('active', Boolean(rgState.twoTapMode));
            twoTapBtn.textContent = rgState.twoTapMode ? '两点定框: 开' : '两点定框: 关';
        }

        if (focusMode === 'continue') {
            if (titleEl) titleEl.textContent = `跨页续框 · ${formatItemTitle(it, activeCtx.tab)}`;
            if (startEditor) startEditor.style.display = bankType === 'variation' ? 'none' : 'inline-flex';
            if (startLabel) startLabel.textContent = it.isBig ? '起始题号' : '题号';
            if (startInp && document.activeElement !== startInp) {
                startInp.value = it.label || '';
            }
            if (freeformBtn) freeformBtn.style.display = 'inline-flex';
            if (toBigqBtn) {
                toBigqBtn.style.display = (activeCtx.tab === 'exercise' && bankType !== 'variation') ? 'inline-flex' : 'none';
            }
            if (undoBtn) {
                undoBtn.textContent = '撤销上一段';
                undoBtn.disabled = !(Array.isArray(activeCtx.addedStack) && activeCtx.addedStack.length > 0);
            }
            if (doneBtn) doneBtn.textContent = '完成续框';
            if (sidebarTitle) sidebarTitle.textContent = '跨页分段清单';
            if (shortcutNote) shortcutNote.textContent = '仅展示当前题衔接页面 · Ctrl+Z 撤销 · Esc 完成退出';
            if (previewPanel) previewPanel.style.display = 'flex';
            if (hint) {
                const regCount = Array.isArray(it.regions) ? it.regions.length : 0;
                const candPages = (activeCtx.candidatePages || []).map(p => 'P' + (p + 1)).join('、');
                if (regCount <= 1) {
                    const firstP = regCount > 0 ? ((parseInt(it.regions[0].pageOffset, 10) || 0) + 1) : 1;
                    hint.textContent = `上方为 P${firstP} 已有末尾（可拖上下边微调），请在下方 ${candPages || '待续页面'} 拉框续接`;
                } else {
                    hint.textContent = `已串联 ${regCount} 段区域 · 右侧可实时核对拼接效果，可继续微调或追加后续页`;
                }
            }
        } else {
            if (titleEl) titleEl.textContent = `大题专注切分 · ${formatItemTitle(it, activeCtx.tab)}`;
            if (startEditor) startEditor.style.display = 'inline-flex';
            if (startLabel) startLabel.textContent = '首题题号';
            if (startInp && document.activeElement !== startInp) {
                startInp.value = it.label || '';
            }
            if (freeformBtn) freeformBtn.style.display = 'none';
            if (toBigqBtn) toBigqBtn.style.display = 'none';
            if (undoBtn) {
                undoBtn.textContent = '撤销上一小问';
                undoBtn.disabled = false;
            }
            if (doneBtn) doneBtn.textContent = '完成大题切分';
            if (sidebarTitle) sidebarTitle.textContent = '本题切分清单';
            if (shortcutNote) shortcutNote.textContent = '仅展示当前大题区域 · 快捷键：Ctrl+Z 撤销 · Esc 完成退出';
            if (previewPanel) previewPanel.style.display = 'none';
            if (hint) {
                const subqCount = Array.isArray(it.subqBoxes) ? it.subqBoxes.length : 0;
                const hasStem = Array.isArray(it.stemBoxes) && it.stemBoxes.length > 0;
                if (subqCount === 0) {
                    hint.textContent = '直接红框框选各小问（大题上界至第 1 小问上界将自动判定为公共原文）';
                } else if (hasStem) {
                    hint.textContent = '继续红框框选后续小问 · 绿虚线为自动识别的公共原文（随第 1 小问上界自动联动）';
                } else {
                    hint.textContent = '继续红框框选后续小问（当前第 1 小问紧贴大题顶部，未切分公共原文）';
                }
            }
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
        if (typeof window.canUseRegionDebug === 'function') {
            return window.canUseRegionDebug();
        }
        const u = window.currentUser;
        return !(u && u.role === 'assistant');
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
                const rawExBoxes = (Array.isArray(meta.boxes) && meta.boxes.length > 0)
                    ? meta.boxes
                    : (meta.box ? [meta.box] : []);
                if (rawExBoxes.length > 0) {
                    const clonedRegs = rawExBoxes.map(b => ({ ...b }));
                    exItem.subqBoxes.push({ ...clonedRegs[0], num: parseInt(q.id, 10) || q.id, customNum: false, regions: clonedRegs });
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
                const rawAnsBoxes = (Array.isArray(meta.answerBoxes) && meta.answerBoxes.length > 0)
                    ? meta.answerBoxes
                    : (meta.answerBox ? [meta.answerBox] : []);
                if (isGroup && rawAnsBoxes.length > 0) {
                    ansItem.isBig = true;
                    if (!ansItem.label) ansItem.label = String(meta.groupNums[0]);
                    const clonedAnsRegs = rawAnsBoxes.map(b => ({ ...b }));
                    ansItem.subqBoxes.push({ ...clonedAnsRegs[0], num: parseInt(q.id, 10) || q.id, customNum: false, regions: clonedAnsRegs });
                } else if (!isGroup && !ansItem.label && bankType !== 'variation') {
                    ansItem.label = String(q.id || '');
                }
            }
        });

        return { exItems, ansItems, nextSeq: seq };
    }

    async function loadPdfFromUrlToFile(url, fallbackName) {
        if (typeof window.ensurePdfJs === 'function') await window.ensurePdfJs();
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
            showToast('助教账号仅具备查看权限，无法录入或上传题目', 'warn');
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
                items: rebuilt.exItems,
                pageTextCache: new Map(),
                pageTextPromises: new Map()
            };
            const exLbl = document.getElementById('rg-exercise-file-label');
            if (exLbl) exLbl.textContent = `${exLoaded.file.name} (${exLoaded.pdfDoc.numPages} 页)`;

            if (ansLoaded) {
                rgState.answer = {
                    file: ansLoaded.file,
                    pdfDoc: ansLoaded.pdfDoc,
                    pageNum: 1,
                    totalPages: ansLoaded.pdfDoc.numPages,
                    items: rebuilt.ansItems,
                    pageTextCache: new Map(),
                    pageTextPromises: new Map()
                };
                const ansLbl = document.getElementById('rg-answer-file-label');
                if (ansLbl) ansLbl.textContent = `${ansLoaded.file.name} (${ansLoaded.pdfDoc.numPages} 页)`;
            } else {
                rgState.answer = { file: null, pdfDoc: null, pageNum: 1, totalPages: 0, items: [], pageTextCache: new Map(), pageTextPromises: new Map() };
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
            showToast('助教账号仅具备查看权限，无法录入或上传题目', 'warn');
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
            if (typeof window.ensurePdfJs === 'function') await window.ensurePdfJs();
            const buf = await file.arrayBuffer();
            const pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
            const tabState = getTabState(tab);
            tabState.file = file;
            tabState.pdfDoc = pdfDoc;
            tabState.pageNum = 1;
            tabState.totalPages = pdfDoc.numPages;
            tabState.items = [];
            tabState.pageTextCache = new Map();
            tabState.pageTextPromises = new Map();
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
        if (it.autoDetected) {
            it.autoDetected = false;
            const inp = document.querySelector(`.rg-card[data-id="${itemId}"] .rg-num-input`);
            if (inp) {
                inp.classList.remove('auto-detected');
                inp.removeAttribute('title');
            }
        }
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
        const activeCtx = rgState.subMode || rgState.continueFocus;
        if (focusTitle && activeCtx && activeCtx.itemId === itemId) {
            const prefix = rgState.continueFocus ? '跨页续框' : '大题专注切分';
            focusTitle.textContent = `${prefix} · ${formatItemTitle(it, activeCtx.tab)}`;
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
        if (kind === 'subq' && Array.isArray(it.subqBoxes)) {
            it.subqBoxes.splice(idx, 1);
            syncAutoStemBoxes(it);
        }
        renderAllRg();
        scheduleDraftSave();
    };

    window.rgDeleteRegionSlice = function (itemId, regionIdx) {
        const tabState = getTabState();
        const it = tabState.items.find(x => x.id === itemId);
        if (!it) return;
        if (Array.isArray(it.regions) && it.regions.length > 1) {
            const [removed] = it.regions.splice(regionIdx, 1);
            if (rgState.continueFocus && rgState.continueFocus.itemId === itemId && removed) {
                rgState.continueFocus.addedStack = (rgState.continueFocus.addedStack || []).filter(ref => ref !== removed);
            }
            if (it.isBig) syncAutoStemBoxes(it);
            renderAllRg();
            if (rgState.continueFocus && rgState.continueFocus.itemId === itemId) {
                renderFocusSlices();
            }
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

    async function startFreeformContinue(itemId) {
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
    }

    window.rgStartContinue = async function (itemId) {
        await openContinueFocusMode(itemId);
    };

    window.rgCancelContinue = function () {
        rgState.continueTargetId = null;
        renderSidebar();
    };

    let focusDialogEventsBound = false;

    function getFocusActiveItem() {
        const activeCtx = rgState.subMode || rgState.continueFocus;
        if (!activeCtx) return null;
        const tabState = getTabState(activeCtx.tab);
        return tabState.items.find(x => x.id === activeCtx.itemId) || null;
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

    function syncAutoStemBoxes(it) {
        if (!it || !it.isBig) return [];
        const regions = Array.isArray(it.regions) ? it.regions : [];
        const subqs = Array.isArray(it.subqBoxes) ? it.subqBoxes : [];
        if (regions.length === 0 || subqs.length === 0) {
            it.stemBoxes = [];
            return it.stemBoxes;
        }
        const sortedRegions = [...regions].sort((a, b) =>
            ((parseInt(a.pageOffset, 10) || 0) - (parseInt(b.pageOffset, 10) || 0))
            || ((Number(a.y) || 0) - (Number(b.y) || 0))
        );
        const flatSubqs = [];
        subqs.forEach(sb => {
            getSubqRegions(sb).forEach(r => flatSubqs.push(r));
        });
        if (flatSubqs.length === 0) {
            it.stemBoxes = [];
            return it.stemBoxes;
        }
        const sortedSubqs = flatSubqs.sort((a, b) =>
            ((parseInt(a.pageOffset, 10) || 0) - (parseInt(b.pageOffset, 10) || 0))
            || ((Number(a.y) || 0) - (Number(b.y) || 0))
        );
        const firstSub = sortedSubqs[0];
        const subPage = parseInt(firstSub.pageOffset, 10) || 0;
        const subTop = Number(firstSub.y) || 0;

        const stems = [];
        for (const rg of sortedRegions) {
            const rgPage = parseInt(rg.pageOffset, 10) || 0;
            const rgTop = Number(rg.y) || 0;
            const rgBot = rgTop + (Number(rg.h) || 0);
            if (rgPage < subPage) {
                if ((Number(rg.h) || 0) >= 0.008) {
                    stems.push({
                        pageOffset: rgPage,
                        x: round4(rg.x),
                        y: round4(rgTop),
                        w: round4(rg.w),
                        h: round4(rg.h)
                    });
                }
            } else if (rgPage === subPage) {
                const cutBot = Math.min(rgBot, subTop);
                const h = cutBot - rgTop;
                if (h >= 0.008) {
                    stems.push({
                        pageOffset: rgPage,
                        x: round4(rg.x),
                        y: round4(rgTop),
                        w: round4(rg.w),
                        h: round4(h)
                    });
                }
            }
        }
        if (stems.length > 1) {
            const linkId = `stem_auto_${it.id}`;
            stems.forEach(s => { s.linkId = linkId; });
        }
        it.stemBoxes = stems;
        return it.stemBoxes;
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

    function commitContinueDrawRange(y0Px, y1Px, x0Px, x1Px) {
        if (!rgState.continueFocus || !rgState.focusStitch) return;
        const it = getFocusActiveItem();
        const stitch = rgState.focusStitch;
        if (!it || !stitch || !Array.isArray(stitch.slices)) return;

        const topPx = Math.max(0, Math.min(y0Px, y1Px));
        const botPx = Math.min(stitch.totalH, Math.max(y0Px, y1Px));
        const leftPx = Math.max(0, Math.min(x0Px ?? 0, x1Px ?? stitch.width));
        const rightPx = Math.min(stitch.width, Math.max(x0Px ?? 0, x1Px ?? stitch.width));

        const candidateSlices = stitch.slices.filter(s => s.role === 'candidate');
        const created = [];

        candidateSlices.forEach((s) => {
            const interTop = Math.max(topPx, s.topPx);
            const interBot = Math.min(botPx, s.bottomPx);
            const overlap = interBot - interTop;
            if (overlap < 8) return;

            const relY = clamp01((interTop - s.topPx) / Math.max(1, s.logicalH));
            const relH = Math.max(0.01, (interBot - interTop) / Math.max(1, s.logicalH));
            const pageY = clamp01(s.crop.y + relY * s.crop.h);
            const pageH = Math.max(0.012, Math.min(1 - pageY, relH * s.crop.h));

            let pageX = FULL_WIDTH_X;
            let pageW = FULL_WIDTH_W;
            if (!rgState.fullWidth) {
                const relX = clamp01(leftPx / Math.max(1, stitch.width));
                const relW = Math.max(0.05, (rightPx - leftPx) / Math.max(1, stitch.width));
                pageX = clamp01(s.crop.x + relX * s.crop.w);
                pageW = Math.max(0.04, Math.min(1 - pageX, relW * s.crop.w));
            }

            created.push({
                pageOffset: s.crop.pageOffset,
                x: round4(pageX),
                y: round4(pageY),
                w: round4(pageW),
                h: round4(pageH)
            });
        });

        if (created.length === 0) {
            const hitExisting = stitch.slices.some(s => s.role === 'existing' && Math.min(botPx, s.bottomPx) - Math.max(topPx, s.topPx) >= 8);
            if (hitExisting) {
                showToast('已有片段请拖动上下边缘微调；续框请在下方待续页面拉框', 'info');
            }
            return;
        }

        it.regions = it.regions || [];
        rgState.continueFocus.addedStack = rgState.continueFocus.addedStack || [];
        created.forEach((rectObj) => {
            it.regions.push(rectObj);
            rgState.continueFocus.addedStack.push(rectObj);
        });
        sortRegionsInPlace(it);
        if (it.isBig) syncAutoStemBoxes(it);
        renderAllRg();
        scheduleDraftSave();
    }

    function commitStitchedDrawRange(y0Px, y1Px, x0Px, x1Px) {
        if (rgState.continueFocus) {
            commitContinueDrawRange(y0Px, y1Px, x0Px, x1Px);
            return;
        }
        if (!rgState.subMode || !rgState.focusStitch) return;
        const it = getFocusActiveItem();
        if (!it) return;
        const rects = splitStitchRangeToRects(y0Px, y1Px, rgState.focusStitch);
        if (rects.length === 0) return;

        // 支持直接跨页缝拉框：保留所有有效页切片，过滤微小误触残片
        const chosenRects = filterSignificantStitchRects(rects, rgState.focusStitch).map(r => ({ ...r }));
        it.subqBoxes = it.subqBoxes || [];
        const baseNum = parseInt(it.label, 10) || 1;
        const nextSubNum = it.subqBoxes.length === 0
            ? baseNum
            : (Math.max(...it.subqBoxes.map(b => parseInt(b.num, 10) || baseNum)) + 1);
        const newSubq = { ...chosenRects[0], num: nextSubNum, customNum: false, regions: chosenRects };
        syncSubqPrimaryFields(newSubq);
        it.subqBoxes.push(newSubq);
        syncAutoStemBoxes(it);
        renderAllRg();
        scheduleDraftSave();
    }

    function startFocusBoxResize(e, kind, itemId, groupBoxes, edge, boxEl, origTopPx, origBotPx, stitch, sliceBounds = null, origLeftPx = 0, origRightPx = stitch.width) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const minTopPx = sliceBounds ? sliceBounds.topPx : 0;
        const maxBotPx = sliceBounds ? sliceBounds.bottomPx : stitch.totalH;
        rgState.focusResize = {
            pointerId: e.pointerId,
            kind,
            itemId,
            groupBoxes,
            edge,
            boxEl,
            stitch,
            slice: sliceBounds || null,
            minTopPx,
            maxBotPx,
            startClientX: e.clientX,
            startClientY: e.clientY,
            origTopPx,
            origBotPx,
            curTopPx: origTopPx,
            curBotPx: origBotPx,
            origLeftPx,
            origRightPx,
            curLeftPx: origLeftPx,
            curRightPx: origRightPx
        };
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    }

    function renderContinuePreview(it) {
        const canvas = document.getElementById('rg-continue-preview-canvas');
        const metaEl = document.getElementById('rg-continue-preview-meta');
        if (!canvas || !it) return;

        const regions = [...(it.regions || [])];
        const pagePages = Array.from(new Set(regions.map(r => 'P' + ((parseInt(r.pageOffset, 10) || 0) + 1)))).join(' → ');
        if (metaEl) {
            metaEl.textContent = `${regions.length} 段${pagePages ? ` · ${pagePages}` : ''}`;
        }

        const stitch = rgState.focusStitch;
        const cacheMap = stitch && stitch.pageCanvasByOffset;
        if (!cacheMap || regions.length === 0) {
            canvas.width = 0;
            canvas.height = 0;
            return;
        }

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const displayW = 248;
        const targetPxW = Math.round(displayW * dpr);
        const seamGapPx = Math.round(10 * dpr);
        const drawSpecs = [];
        let totalPxH = 0;

        regions.forEach((rg, idx) => {
            const pOff = parseInt(rg.pageOffset, 10) || 0;
            const src = cacheMap.get(pOff);
            if (!src || !src.width || !src.height) return;
            const sx = Math.max(0, Math.floor((Number(rg.x) || 0) * src.width));
            const sy = Math.max(0, Math.floor((Number(rg.y) || 0) * src.height));
            const sw = Math.max(8, Math.min(src.width - sx, Math.round((Number(rg.w) || 1) * src.width)));
            const sh = Math.max(8, Math.min(src.height - sy, Math.round((Number(rg.h) || 0.1) * src.height)));
            const dstH = Math.max(12, Math.round(sh * (targetPxW / sw)));
            if (drawSpecs.length > 0) totalPxH += seamGapPx;
            drawSpecs.push({
                idx,
                pageNum: pOff + 1,
                src,
                sx,
                sy,
                sw,
                sh,
                dstY: totalPxH,
                dstH
            });
            totalPxH += dstH;
        });

        if (drawSpecs.length === 0 || totalPxH <= 0) {
            canvas.width = 0;
            canvas.height = 0;
            return;
        }

        canvas.width = targetPxW;
        canvas.height = totalPxH;
        canvas.style.width = displayW + 'px';
        canvas.style.height = Math.round(totalPxH / dpr) + 'px';

        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        drawSpecs.forEach((sp, i) => {
            ctx.drawImage(sp.src, sp.sx, sp.sy, sp.sw, sp.sh, 0, sp.dstY, targetPxW, sp.dstH);
            if (i > 0) {
                const lineY = sp.dstY - Math.round(seamGapPx / 2);
                ctx.save();
                ctx.strokeStyle = '#94a3b8';
                ctx.lineWidth = Math.max(1, Math.round(dpr));
                ctx.setLineDash([4 * dpr, 3 * dpr]);
                ctx.beginPath();
                ctx.moveTo(0, lineY);
                ctx.lineTo(targetPxW, lineY);
                ctx.stroke();
                ctx.restore();
            }
        });
    }

    function scrollToContinueRegion(regionIdx) {
        const it = getFocusActiveItem();
        const stitch = rgState.focusStitch;
        const viewportEl = document.getElementById('rg-focus-viewport');
        if (!it || !stitch || !viewportEl) return;
        const rg = (it.regions || [])[regionIdx];
        if (!rg) return;
        const sIdx = findBestSliceForBox(rg, stitch.slices);
        if (sIdx < 0) return;
        const s = stitch.slices[sIdx];
        const relY = clamp01((rg.y - s.crop.y) / Math.max(0.001, s.crop.h));
        const topPx = s.topPx + relY * s.logicalH;
        viewportEl.scrollTo({ top: Math.max(0, topPx - 24), behavior: 'smooth' });
    }

    function renderFocusSidebar() {
        const listEl = document.getElementById('rg-focus-list');
        const summaryEl = document.getElementById('rg-focus-summary');
        const it = getFocusActiveItem();
        if (!listEl || !it) return;

        if (rgState.continueFocus) {
            const regions = it.regions || [];
            if (summaryEl) {
                summaryEl.textContent = `共 ${regions.length} 段`;
            }
            if (regions.length === 0) {
                listEl.innerHTML = '<div class="rg-list-empty">暂无框选分段，请在左侧画布拉框</div>';
            } else {
                const segHtml = regions.map((rg, rIdx) => {
                    const pNum = (parseInt(rg.pageOffset, 10) || 0) + 1;
                    const badgeCls = rIdx === 0 ? 'seg-head' : 'seg-cont';
                    const badgeText = rIdx === 0 ? '首段' : `续 ${rIdx}`;
                    const canDel = regions.length > 1;
                    const delBtn = canDel
                        ? `<button type="button" class="rg-subq-del-btn" onclick="event.stopPropagation(); rgDeleteRegionSlice('${it.id}', ${rIdx})" title="删除此跨页片段" aria-label="删除此跨页片段"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>`
                        : '';
                    return `
                        <div class="rg-focus-list-row continue-seg" onclick="rgScrollContinueRegion(${rIdx})" title="点击定位到此片段">
                            <span class="rg-focus-badge ${badgeCls}">${badgeText}</span>
                            <span class="rg-focus-seg-info">P${pNum} · 第 ${rIdx + 1} 段</span>
                            ${delBtn}
                        </div>
                    `;
                }).join('');
                listEl.innerHTML = `<div class="rg-focus-list-group"><div class="rg-focus-list-title">已选片段（点击定位）</div>${segHtml}</div>`;
            }
            renderContinuePreview(it);
            return;
        }

        const stemGroups = groupStemBoxes(it.stemBoxes);
        const subqs = it.subqBoxes || [];
        if (summaryEl) {
            summaryEl.textContent = `${stemGroups.length > 0 ? '已识别原文 · ' : ''}小问 ${subqs.length} 题`;
        }
        if (stemGroups.length === 0 && subqs.length === 0) {
            listEl.innerHTML = '<div class="rg-list-empty">请在左侧框选区直接拖拽划出各小问（第 1 小问上界以上区域将自动识别为公共原文）</div>';
            return;
        }

        const stemHtml = stemGroups.map((sg) => {
            const pLabels = Array.from(new Set(sg.boxes.map(b => 'P' + ((b.pageOffset || 0) + 1)))).join('~');
            return `
                <div class="rg-focus-list-row stem">
                    <span class="rg-focus-badge stem">自动原文</span>
                    <span class="rg-card-meta">${escapeHtmlRg(pLabels)}</span>
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
                <span class="rg-card-meta">${escapeHtmlRg(formatSubqPagesLabel(qb))}</span>
                <button type="button" class="rg-subq-del-btn" onclick="rgDeleteSubBox('${it.id}', 'subq', ${qIdx})" title="删除此小问框" aria-label="删除此小问框"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
            </div>
        `).join('');

        listEl.innerHTML = `
            ${stemGroups.length > 0 ? `<div class="rg-focus-list-group"><div class="rg-focus-list-title">公共题干 / 原文（自动判定）</div>${stemHtml}</div>` : ''}
            ${subqs.length > 0 ? `<div class="rg-focus-list-group"><div class="rg-focus-list-title">小问列表</div>${subqHtml}</div>` : ''}
        `;
    }

    function renderFocusSliceOverlays() {
        const it = getFocusActiveItem();
        const stitch = rgState.focusStitch;
        const focusMode = getActiveFocusMode();
        if (!it || !focusMode || !stitch || !stitch.layerEl || !Array.isArray(stitch.slices) || stitch.slices.length === 0) return;

        const { layerEl, totalH, slices, width } = stitch;
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
            const relY = clamp01((box.y - s.crop.y) / Math.max(0.001, s.crop.h));
            const relBot = clamp01((box.y + box.h - s.crop.y) / Math.max(0.001, s.crop.h));
            const relX = clamp01((box.x - s.crop.x) / Math.max(0.001, s.crop.w));
            const relW = Math.max(0.02, Math.min(1 - relX, (box.w || 1) / Math.max(0.001, s.crop.w)));
            return {
                slice: s,
                topPx: s.topPx + relY * s.logicalH,
                botPx: Math.max(s.topPx + relY * s.logicalH + 8, s.topPx + relBot * s.logicalH),
                leftPx: relX * width,
                rightPx: (relX + relW) * width,
                leftPct: relX * 100,
                widthPct: relW * 100
            };
        };

        if (focusMode === 'continue') {
            const activeCtx = rgState.continueFocus;
            const tab = activeCtx.tab;
            const tabState = getTabState(tab);

            // 在待续页面上淡显其他题目的已有框选区域，防止续框重叠
            const candidateSlicePages = new Set(slices.filter(s => s.role === 'candidate').map(s => s.crop.pageOffset));
            tabState.items.forEach((other) => {
                if (!other || other.id === it.id) return;
                (other.regions || []).forEach((org) => {
                    if (!candidateSlicePages.has(parseInt(org.pageOffset, 10) || 0)) return;
                    const sp = boxToStitchSpan(org);
                    if (!sp) return;
                    const div = document.createElement('div');
                    div.className = 'rg-box context-other';
                    div.style.left = sp.leftPct + '%';
                    div.style.top = ((sp.topPx / Math.max(1, totalH)) * 100) + '%';
                    div.style.width = sp.widthPct + '%';
                    div.style.height = Math.max(0.8, ((sp.botPx - sp.topPx) / Math.max(1, totalH)) * 100) + '%';
                    const tag = document.createElement('span');
                    tag.className = 'rg-box-tag';
                    tag.textContent = formatItemTitle(other, tab);
                    div.appendChild(tag);
                    layerEl.appendChild(div);
                });
            });

            (it.regions || []).forEach((rg, rIdx) => {
                const sp = boxToStitchSpan(rg);
                if (!sp) return;
                const div = document.createElement('div');
                const nearTopCls = sp.topPx < 22 ? ' near-top' : '';
                const ansCls = tab === 'answer' ? ' answer' : '';
                const roleCls = sp.slice.role === 'existing' ? ' continue-existing' : '';
                div.className = `rg-box${ansCls}${roleCls} active${nearTopCls}`;
                div.style.left = sp.leftPct + '%';
                div.style.top = ((sp.topPx / Math.max(1, totalH)) * 100) + '%';
                div.style.width = sp.widthPct + '%';
                div.style.height = Math.max(0.8, ((sp.botPx - sp.topPx) / Math.max(1, totalH)) * 100) + '%';

                const tag = document.createElement('span');
                tag.className = 'rg-box-tag';
                const suffix = it.regions.length > 1 ? ` (${rIdx + 1}/${it.regions.length})` : '';
                tag.textContent = formatItemTitle(it, tab) + suffix;
                div.appendChild(tag);

                const edges = rgState.fullWidth ? ['n', 's'] : ['n', 's', 'w', 'e'];
                edges.forEach((edge) => {
                    const h = document.createElement('div');
                    h.className = `rg-handle rg-handle-${edge}`;
                    h.addEventListener('pointerdown', (e) => startFocusBoxResize(
                        e, 'region', it.id, [rg], edge, div, sp.topPx, sp.botPx, stitch, sp.slice, sp.leftPx, sp.rightPx
                    ));
                    div.appendChild(h);
                });

                if (it.regions.length > 1) {
                    const delBtn = document.createElement('button');
                    delBtn.type = 'button';
                    delBtn.className = 'rg-box-del';
                    delBtn.title = '删除此跨页片段';
                    delBtn.textContent = '×';
                    delBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
                    delBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        rgDeleteRegionSlice(it.id, rIdx);
                    });
                    div.appendChild(delBtn);
                }
                layerEl.appendChild(div);
            });
            return;
        }

        const renderStitchedBox = (topPx, botPx, kind, groupBoxes, firstIdx, labelText, isReadOnlyAuto = false) => {
            const topPct = (topPx / Math.max(1, totalH)) * 100;
            const heightPct = Math.max(0.8, ((botPx - topPx) / Math.max(1, totalH)) * 100);
            const div = document.createElement('div');
            const nearTopCls = topPx < 22 ? ' near-top' : '';
            const autoCls = isReadOnlyAuto ? ' auto-stem' : '';
            div.className = `rg-box ${kind}${autoCls} active${nearTopCls}`;
            div.style.left = '0%';
            div.style.top = topPct + '%';
            div.style.width = '100%';
            div.style.height = heightPct + '%';

            const tag = document.createElement('span');
            tag.className = 'rg-box-tag';
            tag.textContent = labelText;
            div.appendChild(tag);

            if (!isReadOnlyAuto) {
                ['n', 's'].forEach(edge => {
                    const h = document.createElement('div');
                    h.className = `rg-handle rg-handle-${edge}`;
                    h.addEventListener('pointerdown', (e) => startFocusBoxResize(e, kind, it.id, groupBoxes, edge, div, topPx, botPx, stitch));
                    div.appendChild(h);
                });

                const delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.className = 'rg-box-del';
                delBtn.title = '删除此小问框';
                delBtn.textContent = '×';
                delBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
                delBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    rgDeleteSubBox(it.id, kind, firstIdx);
                });
                div.appendChild(delBtn);
            }

            layerEl.appendChild(div);
        };

        const stemGroups = groupStemBoxes(it.stemBoxes);
        stemGroups.forEach((sg) => {
            const spans = sg.boxes.map(boxToStitchSpan).filter(Boolean);
            if (spans.length === 0) return;
            const topPx = Math.min(...spans.map(sp => sp.topPx));
            const botPx = Math.max(...spans.map(sp => sp.botPx));
            const pLabels = Array.from(new Set(sg.boxes.map(b => 'P' + ((b.pageOffset || 0) + 1)))).join('~');
            const suffix = sg.boxes.length > 1 ? ` (跨${pLabels})` : '';
            renderStitchedBox(topPx, botPx, 'stem', sg.boxes, sg.indices[0], `自动原文${suffix}`, true);
        });

        (it.subqBoxes || []).forEach((qb, qIdx) => {
            const regs = getSubqRegions(qb);
            const spans = regs.map(boxToStitchSpan).filter(Boolean);
            if (spans.length === 0) return;
            const topPx = Math.min(...spans.map(sp => sp.topPx));
            const botPx = Math.max(...spans.map(sp => sp.botPx));
            const pLabels = formatSubqPagesLabel(qb);
            const suffix = regs.length > 1 ? ` (跨${pLabels})` : '';
            renderStitchedBox(topPx, botPx, 'subq', [qb], qIdx, `${qb.num}${suffix}`);
        });
    }

    function buildContinueSlicePlans(it, candidatePages) {
        const cropX = rgState.fullWidth ? FULL_WIDTH_X : 0;
        const cropW = rgState.fullWidth ? FULL_WIDTH_W : 1;
        const sortedCand = Array.from(new Set((candidatePages || []).map(p => parseInt(p, 10) || 0))).sort((a, b) => a - b);
        const candSet = new Set(sortedCand);

        const byExistingPage = new Map();
        (it.regions || []).forEach((rg) => {
            const pOff = parseInt(rg.pageOffset, 10) || 0;
            if (candSet.has(pOff)) return;
            if (!byExistingPage.has(pOff)) byExistingPage.set(pOff, []);
            byExistingPage.get(pOff).push(rg);
        });

        const existingPages = Array.from(byExistingPage.keys()).sort((a, b) => a - b);
        const plans = [];

        existingPages.forEach((pOff, idx) => {
            const regs = byExistingPage.get(pOff);
            const minY = Math.min(...regs.map(r => Number(r.y) || 0));
            const maxBot = Math.max(...regs.map(r => (Number(r.y) || 0) + (Number(r.h) || 0.08)));
            const isLastExisting = idx === existingPages.length - 1;
            const y0 = clamp01(minY - 0.015);
            const y1 = clamp01(maxBot + (isLastExisting ? 0.08 : 0.015));
            plans.push({
                role: 'existing',
                crop: {
                    pageOffset: pOff,
                    x: cropX,
                    y: y0,
                    w: cropW,
                    h: Math.max(0.03, y1 - y0)
                }
            });
        });

        sortedCand.forEach((pOff) => {
            plans.push({
                role: 'candidate',
                crop: {
                    pageOffset: pOff,
                    x: cropX,
                    y: 0,
                    w: cropW,
                    h: 1
                }
            });
        });

        return plans;
    }

    async function renderFocusSlices() {
        const container = document.getElementById('rg-focus-slices');
        const viewportEl = document.getElementById('rg-focus-viewport');
        const it = getFocusActiveItem();
        const focusMode = getActiveFocusMode();
        const activeCtx = rgState.subMode || rgState.continueFocus;
        if (!container || !it || !focusMode || !activeCtx) return;

        const tab = activeCtx.tab;
        const tabState = getTabState(tab);
        if (!tabState.pdfDoc) return;

        const mySeq = ++rgState.focusRenderSeq;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const availW = Math.max(360, Math.min(860, ((viewportEl && viewportEl.clientWidth) ? viewportEl.clientWidth : 780) - 48));
        const stitchW = Math.max(240, Math.round(availW * rgState.focusZoom));

        container.innerHTML = '';
        rgState.focusStitch = null;

        let slicePlans = [];
        if (focusMode === 'continue') {
            slicePlans = buildContinueSlicePlans(it, activeCtx.candidatePages);
        } else {
            const rawRegions = (Array.isArray(it.regions) && it.regions.length > 0)
                ? it.regions
                : [{ pageOffset: 0, x: FULL_WIDTH_X, y: 0, w: FULL_WIDTH_W, h: 1 }];
            const regions = [...rawRegions].sort((a, b) => ((a.pageOffset || 0) - (b.pageOffset || 0)) || ((a.y || 0) - (b.y || 0)));
            slicePlans = regions.map(rg => ({ role: 'bigq', crop: computeRegionDisplayCrop(rg) }));
        }

        const prepared = [];
        const pageCanvasByOffset = new Map();
        let totalH = 0;

        for (let sliceIdx = 0; sliceIdx < slicePlans.length; sliceIdx++) {
            if (mySeq !== rgState.focusRenderSeq) return;
            const plan = slicePlans[sliceIdx];
            const crop = plan.crop;
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
            pageCanvasByOffset.set(crop.pageOffset, fullCanvas);

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
                role: plan.role,
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
                const prev = prepared[idx - 1];
                const seam = document.createElement('div');
                seam.className = 'rg-focus-seam-line';
                seam.style.top = p.topPx + 'px';
                const badge = document.createElement('span');
                badge.className = 'rg-focus-seam-badge';
                if (prev.role === 'existing' && p.role === 'candidate') {
                    badge.textContent = `P${prev.pageNum} 已有末尾 / P${p.pageNum} 待续画布`;
                } else {
                    badge.textContent = `P${prev.pageNum} / P${p.pageNum}`;
                }
                seam.appendChild(badge);
                stageEl.appendChild(seam);
            }
        });

        const layerEl = document.createElement('div');
        layerEl.className = 'rg-box-layer';
        stageEl.appendChild(layerEl);
        container.appendChild(stageEl);

        if (focusMode === 'continue' && tabState.totalPages > 1) {
            const maxCand = Math.max(...(activeCtx.candidatePages || [0]));
            if (maxCand + 1 < tabState.totalPages) {
                const pager = document.createElement('div');
                pager.className = 'rg-focus-continue-pager';
                const nextBtn = document.createElement('button');
                nextBtn.type = 'button';
                nextBtn.className = 'btn sm secondary';
                nextBtn.textContent = `载入下一页 (P${maxCand + 2})`;
                nextBtn.addEventListener('click', () => rgContinueLoadNextPage());
                pager.appendChild(nextBtn);
                container.appendChild(pager);
            }
        }

        rgState.focusStitch = {
            stageEl,
            layerEl,
            width: stitchW,
            totalH,
            pageCanvasByOffset,
            slices: prepared.map(({ sliceIdx, pageNum, role, crop, topPx, bottomPx, logicalH }) => ({
                sliceIdx, pageNum, role, crop, topPx, bottomPx, logicalH
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
            const ptX = clamp01((e.clientX - rect.left) / Math.max(1, rect.width));
            const ptY = clamp01((e.clientY - rect.top) / Math.max(1, rect.height));
            const xPx = ptX * stitchW;
            const yPx = ptY * totalH;
            const draftEl = document.createElement('div');
            draftEl.className = 'rg-box draft';
            layerEl.appendChild(draftEl);
            rgState.focusDrag = {
                pointerId: e.pointerId,
                stageEl,
                totalW: stitchW,
                totalH,
                startXPx: xPx,
                curXPx: xPx,
                startYPx: yPx,
                curYPx: yPx,
                draftEl
            };
        });

        renderFocusSidebar();
        renderFocusSliceOverlays();
    }

    function bindFocusDialogEventsOnce() {
        if (focusDialogEventsBound) return;
        focusDialogEventsBound = true;

        const startInp = document.getElementById('rg-focus-start-input');
        const twoTapBtn = document.getElementById('rg-focus-twotap-btn');
        const zoomOutBtn = document.getElementById('rg-focus-zoom-out');
        const zoomInBtn = document.getElementById('rg-focus-zoom-in');
        const freeformBtn = document.getElementById('rg-focus-freeform-btn');
        const toBigqBtn = document.getElementById('rg-focus-to-bigq-btn');
        const undoBtn = document.getElementById('rg-focus-undo-btn');
        const doneBtn = document.getElementById('rg-focus-done-btn');
        const viewportEl = document.getElementById('rg-focus-viewport');

        if (startInp) {
            startInp.addEventListener('input', () => {
                const it = getFocusActiveItem();
                if (!it) return;
                const raw = String(startInp.value || '').trim();
                if (rgState.continueFocus) {
                    rgUpdateItemLabel(it.id, raw);
                } else if (/^\d+$/.test(raw) && parseInt(raw, 10) > 0) {
                    rgUpdateItemLabel(it.id, raw);
                }
            });
            startInp.addEventListener('blur', () => {
                const it = getFocusActiveItem();
                if (!it || rgState.continueFocus) return;
                const raw = String(startInp.value || '').trim();
                if (!/^\d+$/.test(raw) || parseInt(raw, 10) <= 0) {
                    startInp.value = it.label || '1';
                    showToast('首题题号须为正整数', 'warn');
                } else {
                    renderSidebar();
                }
            });
        }

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
        if (freeformBtn) freeformBtn.addEventListener('click', () => rgSwitchContinueToFreeform());
        if (toBigqBtn) toBigqBtn.addEventListener('click', () => rgContinueToBigQ());
        if (undoBtn) {
            undoBtn.addEventListener('click', () => {
                if (rgState.continueFocus) {
                    rgUndoContinueSlice();
                } else {
                    rgUndoSubBox();
                }
            });
        }
        if (doneBtn) {
            doneBtn.addEventListener('click', () => {
                if (rgState.continueFocus) {
                    rgExitContinueFocus();
                } else {
                    rgRequestExitSubMode();
                }
            });
        }

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
                const dxPx = e.clientX - rz.startClientX;
                const minPx = 8;
                let newTop = rz.origTopPx;
                let newBot = rz.origBotPx;
                let newLeft = rz.origLeftPx;
                let newRight = rz.origRightPx;
                if (rz.edge === 'n') {
                    newTop = Math.max(rz.minTopPx, Math.min(rz.origBotPx - minPx, rz.origTopPx + dyPx));
                } else if (rz.edge === 's') {
                    newBot = Math.max(rz.origTopPx + minPx, Math.min(rz.maxBotPx, rz.origBotPx + dyPx));
                } else if (rz.edge === 'w') {
                    newLeft = Math.max(0, Math.min(rz.origRightPx - minPx, rz.origLeftPx + dxPx));
                } else if (rz.edge === 'e') {
                    newRight = Math.max(rz.origLeftPx + minPx, Math.min(rz.stitch.width, rz.origRightPx + dxPx));
                }
                rz.curTopPx = newTop;
                rz.curBotPx = newBot;
                rz.curLeftPx = newLeft;
                rz.curRightPx = newRight;
                if (rz.boxEl) {
                    rz.boxEl.style.top = ((newTop / Math.max(1, rz.stitch.totalH)) * 100) + '%';
                    rz.boxEl.style.height = (((newBot - newTop) / Math.max(1, rz.stitch.totalH)) * 100) + '%';
                    if (!rgState.fullWidth) {
                        rz.boxEl.style.left = ((newLeft / Math.max(1, rz.stitch.width)) * 100) + '%';
                        rz.boxEl.style.width = (((newRight - newLeft) / Math.max(1, rz.stitch.width)) * 100) + '%';
                    }
                }
                return;
            }

            if (!rgState.focusDrag || rgState.focusDrag.pointerId !== e.pointerId) return;
            const d = rgState.focusDrag;
            const rect = d.stageEl.getBoundingClientRect();
            const ptX = clamp01((e.clientX - rect.left) / Math.max(1, rect.width));
            const ptY = clamp01((e.clientY - rect.top) / Math.max(1, rect.height));
            d.curXPx = ptX * d.totalW;
            d.curYPx = ptY * d.totalH;
            const topPx = Math.min(d.startYPx, d.curYPx);
            const hPx = Math.abs(d.curYPx - d.startYPx);
            if (rgState.fullWidth) {
                d.draftEl.style.left = '0%';
                d.draftEl.style.width = '100%';
            } else {
                const leftPx = Math.min(d.startXPx, d.curXPx);
                const wPx = Math.abs(d.curXPx - d.startXPx);
                d.draftEl.style.left = ((leftPx / Math.max(1, d.totalW)) * 100) + '%';
                d.draftEl.style.width = ((wPx / Math.max(1, d.totalW)) * 100) + '%';
            }
            d.draftEl.style.top = ((topPx / Math.max(1, d.totalH)) * 100) + '%';
            d.draftEl.style.height = ((hPx / Math.max(1, d.totalH)) * 100) + '%';
        });

        const finishFocusPointer = (e) => {
            if (rgState.focusResize && rgState.focusResize.pointerId === e.pointerId) {
                const rz = rgState.focusResize;
                rgState.focusResize = null;
                const it = getFocusActiveItem();
                if (it && rz.stitch) {
                    if (rz.kind === 'region' && rz.slice && rz.groupBoxes[0]) {
                        const s = rz.slice;
                        const relY = clamp01((rz.curTopPx - s.topPx) / Math.max(1, s.logicalH));
                        const relH = Math.max(0.008, (rz.curBotPx - rz.curTopPx) / Math.max(1, s.logicalH));
                        const pageY = clamp01(s.crop.y + relY * s.crop.h);
                        const pageH = Math.max(0.01, Math.min(1 - pageY, relH * s.crop.h));
                        const nextRect = { y: round4(pageY), h: round4(pageH) };
                        if (!rgState.fullWidth) {
                            const relX = clamp01(rz.curLeftPx / Math.max(1, rz.stitch.width));
                            const relW = Math.max(0.04, (rz.curRightPx - rz.curLeftPx) / Math.max(1, rz.stitch.width));
                            nextRect.x = round4(clamp01(s.crop.x + relX * s.crop.w));
                            nextRect.w = round4(Math.max(0.04, Math.min(1 - nextRect.x, relW * s.crop.w)));
                        }
                        Object.assign(rz.groupBoxes[0], nextRect);
                        sortRegionsInPlace(it);
                        if (it.isBig) syncAutoStemBoxes(it);
                    } else {
                        const rects = splitStitchRangeToRects(rz.curTopPx, rz.curBotPx, rz.stitch);
                        if (rects.length > 0 && rz.groupBoxes[0]) {
                            const chosenRects = filterSignificantStitchRects(rects, rz.stitch).map(r => ({ ...r }));
                            rz.groupBoxes[0].regions = chosenRects;
                            syncSubqPrimaryFields(rz.groupBoxes[0]);
                            syncAutoStemBoxes(it);
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
            const dxPx = Math.abs(d.curXPx - d.startXPx);

            if (rgState.twoTapMode && dyPx < 8 && (rgState.fullWidth || dxPx < 8)) {
                if (!rgState.focusTwoTapStart) {
                    rgState.focusTwoTapStart = { xPx: d.curXPx, yPx: d.curYPx };
                    renderFocusSliceOverlays();
                    return;
                }
                const startX = rgState.focusTwoTapStart.xPx ?? 0;
                const startY = rgState.focusTwoTapStart.yPx;
                rgState.focusTwoTapStart = null;
                if (Math.abs(d.curYPx - startY) < 8) {
                    renderFocusSliceOverlays();
                    return;
                }
                commitStitchedDrawRange(startY, d.curYPx, startX, d.curXPx);
                return;
            }

            if (dyPx < 8 || (!rgState.fullWidth && dxPx < 8)) return;

            rgState.focusTwoTapStart = null;
            commitStitchedDrawRange(d.startYPx, d.curYPx, d.startXPx, d.curXPx);
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

    async function openContinueFocusMode(itemId) {
        const tab = rgState.activeTab;
        const tabState = getTabState(tab);
        const it = tabState.items.find(x => x.id === itemId);
        if (!it || !tabState.pdfDoc) return;

        bindFocusDialogEventsOnce();
        sortRegionsInPlace(it);
        const lastPageOffset = (Array.isArray(it.regions) && it.regions.length > 0)
            ? Math.max(...it.regions.map(r => parseInt(r.pageOffset, 10) || 0))
            : Math.max(0, (tabState.pageNum || 1) - 1);
        const totalPages = Math.max(1, tabState.totalPages || tabState.pdfDoc.numPages || 1);
        const candidatePages = (lastPageOffset + 1 < totalPages)
            ? [lastPageOffset + 1]
            : [lastPageOffset];

        rgState.continueTargetId = null;
        rgState.subMode = null;
        rgState.continueFocus = {
            tab,
            itemId,
            candidatePages,
            addedStack: []
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

        const viewportEl = document.getElementById('rg-focus-viewport');
        const stitch = rgState.focusStitch;
        if (viewportEl && stitch && Array.isArray(stitch.slices)) {
            const firstCand = stitch.slices.find(s => s.role === 'candidate');
            if (firstCand && firstCand.topPx > 0) {
                const targetTop = Math.max(0, firstCand.topPx - Math.round(viewportEl.clientHeight * 0.28));
                viewportEl.scrollTop = targetTop;
            } else if (firstCand && it.regions && it.regions.length > 0) {
                const lastRg = it.regions[it.regions.length - 1];
                const botPx = firstCand.topPx + clamp01((Number(lastRg.y) || 0) + (Number(lastRg.h) || 0)) * firstCand.logicalH;
                viewportEl.scrollTop = Math.max(0, botPx - Math.round(viewportEl.clientHeight * 0.45));
            } else {
                viewportEl.scrollTop = 0;
            }
        }
        if (lastPageOffset + 1 >= totalPages) {
            showToast('当前已是最后一页，可直接微调或在本页补充区域', 'info');
        }
    }

    async function rgContinueLoadNextPage() {
        if (!rgState.continueFocus) return;
        const tabState = getTabState(rgState.continueFocus.tab);
        const totalPages = Math.max(1, tabState.totalPages || (tabState.pdfDoc ? tabState.pdfDoc.numPages : 1));
        const currPages = rgState.continueFocus.candidatePages || [];
        const maxCand = currPages.length > 0 ? Math.max(...currPages) : 0;
        if (maxCand + 1 >= totalPages) {
            showToast('已是最后一页', 'info');
            return;
        }
        const nextPage = maxCand + 1;
        if (!currPages.includes(nextPage)) {
            currPages.push(nextPage);
        }
        renderSubModeBar();
        await renderFocusSlices();
        const viewportEl = document.getElementById('rg-focus-viewport');
        const stitch = rgState.focusStitch;
        if (viewportEl && stitch && Array.isArray(stitch.slices)) {
            const addedSlice = stitch.slices.find(s => s.crop.pageOffset === nextPage);
            if (addedSlice) {
                viewportEl.scrollTo({ top: Math.max(0, addedSlice.topPx - 24), behavior: 'smooth' });
            }
        }
    }

    window.rgScrollContinueRegion = function (regionIdx) {
        scrollToContinueRegion(regionIdx);
    };

    window.rgUndoContinueSlice = function () {
        if (!rgState.continueFocus) return;
        const it = getFocusActiveItem();
        if (!it || !Array.isArray(it.regions)) return;
        const stack = rgState.continueFocus.addedStack || [];
        if (stack.length === 0 || it.regions.length <= 1) return;
        const targetRef = stack.pop();
        const idx = it.regions.indexOf(targetRef);
        if (idx >= 0 && it.regions.length > 1) {
            it.regions.splice(idx, 1);
            if (it.isBig) syncAutoStemBoxes(it);
        }
        renderAllRg();
        scheduleDraftSave();
    };

    window.rgExitContinueFocus = async function () {
        const ctx = rgState.continueFocus;
        const it = getFocusActiveItem();
        rgState.continueFocus = null;
        rgState.focusTwoTapStart = null;
        rgState.focusDrag = null;
        rgState.focusResize = null;
        rgState.focusStitch = null;
        closeFocusDialogSafe();

        if (ctx && it && Array.isArray(it.regions) && it.regions.length > 0) {
            const tabState = getTabState(ctx.tab);
            const lastPage = (parseInt(it.regions[it.regions.length - 1].pageOffset, 10) || 0) + 1;
            if (tabState.pdfDoc && lastPage !== tabState.pageNum) {
                tabState.pageNum = Math.min(tabState.totalPages || lastPage, Math.max(1, lastPage));
                await renderPdfPage();
            }
        }
        renderAllRg();
        scheduleDraftSave();
    };

    window.rgSwitchContinueToFreeform = async function () {
        const ctx = rgState.continueFocus;
        if (!ctx) return;
        rgState.continueFocus = null;
        rgState.focusTwoTapStart = null;
        rgState.focusDrag = null;
        rgState.focusResize = null;
        rgState.focusStitch = null;
        closeFocusDialogSafe();
        await startFreeformContinue(ctx.itemId);
    };

    window.rgContinueToBigQ = async function () {
        const ctx = rgState.continueFocus;
        if (!ctx) return;
        const itemId = ctx.itemId;
        rgState.continueFocus = null;
        rgState.focusTwoTapStart = null;
        rgState.focusDrag = null;
        rgState.focusResize = null;
        rgState.focusStitch = null;
        closeFocusDialogSafe();
        await window.rgEnterSubMode(itemId);
    };

    async function openFocusSubMode(itemId) {
        const tab = rgState.activeTab;
        const tabState = getTabState(tab);
        const it = tabState.items.find(x => x.id === itemId);
        if (!it) return;

        bindFocusDialogEventsOnce();
        it.isBig = true;
        it.subqBoxes = it.subqBoxes || [];
        syncAutoStemBoxes(it);
        rgState.continueFocus = null;
        rgState.subMode = {
            tab,
            itemId,
            target: 'subq'
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
                    body: '当前大题还没有框选任何小问。您可以继续留在此窗口框选小问，或取消大题设置（恢复为普通单题）。',
                    confirmText: '继续框选',
                    cancelText: '取消大题设置',
                    onConfirm: () => {},
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

    window.rgSetSubDrawTarget = function () {
        if (!rgState.subMode) return;
        rgState.subMode.target = 'subq';
        renderSubModeBar();
    };

    window.rgUndoSubBox = function () {
        if (!rgState.subMode) return;
        const tabState = getTabState(rgState.subMode.tab);
        const it = tabState.items.find(x => x.id === rgState.subMode.itemId);
        if (!it) return;
        if (Array.isArray(it.subqBoxes) && it.subqBoxes.length > 0) {
            it.subqBoxes.pop();
            syncAutoStemBoxes(it);
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
        if ((rgState.subMode && rgState.subMode.itemId === itemId) || (rgState.continueFocus && rgState.continueFocus.itemId === itemId)) {
            rgState.subMode = null;
            rgState.continueFocus = null;
            closeFocusDialogSafe();
        }
        renderAllRg();
        scheduleDraftSave();
    };

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
            showToast('助教账号仅具备查看权限，无法录入或上传题目', 'warn');
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
                        syncSubqPrimaryFields(sb);
                        ansByNum.set(sn, aIt);
                        ansSubByNum.set(sn, getSubqRegions(sb).map(r => ({
                            pageOffset: r.pageOffset,
                            x: r.x,
                            y: r.y,
                            w: r.w,
                            h: r.h
                        })));
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

        try {
            const exUpload = await uploadPdfBlob(rgState.exercise.file);
            const exPdfObj = {
                url: exUpload.url,
                name: exUpload.originalName || rgState.exercise.file.name,
                status: 'uploaded'
            };

            let ansPdfObj = null;
            if (rgState.answer.file && rgState.answer.items.length > 0) {
                const ansUpload = await uploadPdfBlob(rgState.answer.file);
                ansPdfObj = {
                    url: ansUpload.url,
                    name: ansUpload.originalName || rgState.answer.file.name,
                    status: 'uploaded'
                };
            }

            const imported = [];
            const varSubCounter = new Map();

            for (const it of exItems) {
                if (it.isBig) syncAutoStemBoxes(it);

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
                    imported.push({
                        id: String(imported.length + 1),
                        parentQuestionNum: primaryP,
                        parentQuestionNums: pNums,
                        subNum: nextSub,
                        isVariation: true,
                        topic: inheritedTopic,
                        videoUrl: prevVar ? prevVar.videoUrl : '',
                        exercisePdf: { ...exPdfObj },
                        answerPdf: matchedAns && ansPdfObj ? { ...ansPdfObj } : null,
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
                        syncSubqPrimaryFields(sb);
                        const qKey = String(sb.num).trim();
                        const matchedAns = findMatchedAns(it, qKey, null);
                        const matchedAnsSubRegs = ansSubByNum.get(qKey) || [];
                        const exBoxes = getSubqRegions(sb).map(r => ({
                            pageOffset: r.pageOffset,
                            x: r.x,
                            y: r.y,
                            w: r.w,
                            h: r.h
                        }));
                        const prev = prevFields.byId.get(qKey);
                        const qMeta = {
                            mode: 'region_crop',
                            groupNums,
                            stemBoxes: it.stemBoxes || [],
                            box: exBoxes[0] || null,
                            answerBox: matchedAnsSubRegs[0] || null,
                            regions: it.regions,
                            answerRegions: matchedAns ? matchedAns.regions : []
                        };
                        if (exBoxes.length > 1) {
                            qMeta.boxes = exBoxes;
                        }
                        if (matchedAnsSubRegs.length > 1) {
                            qMeta.answerBoxes = matchedAnsSubRegs;
                        }
                        imported.push({
                            id: qKey,
                            topic: prev ? prev.topic : '',
                            videoUrl: prev ? prev.videoUrl : '',
                            exercisePdf: { ...exPdfObj },
                            answerPdf: matchedAns && ansPdfObj ? { ...ansPdfObj } : null,
                            questionMeta: qMeta
                        });
                    }
                    continue;
                }

                const qKey = String(it.label || '').trim();
                const matchedAns = findMatchedAns(it, qKey, null);
                const prev = prevFields.byId.get(qKey);
                imported.push({
                    id: qKey,
                    topic: prev ? prev.topic : '',
                    videoUrl: prev ? prev.videoUrl : '',
                    exercisePdf: { ...exPdfObj },
                    answerPdf: matchedAns && ansPdfObj ? { ...ansPdfObj } : null,
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
            if (finishBtn) {
                finishBtn.disabled = false;
                setBtnLabel(finishBtn, '完成框选并导入第 4 步');
            }
        }
    };
})();
